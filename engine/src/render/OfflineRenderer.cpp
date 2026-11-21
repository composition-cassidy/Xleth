#include "render/OfflineRenderer.h"

#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "model/ClipSourceAnchor.h"
#include "Transport.h"
#include "audio/MixEngine.h"
#include "render/GpuDeviceManager.h"
#include "render/RenderClock.h"
#include "render/RenderScope.h"
#include "render/FrameCache.h"
#include "render/FrameCollector.h"
#include "render/MixEngineDelayResolver.h"
#include "render/RenderVideoDecoder.h"
#include "render/GridCompositor.h"
#include "render/SnapshotTransitionRenderer.h"  // snapshot transition export seam (Slice 3b)
#include "render/LandingRenderer.h"             // landing carry, shared with the preview seam
#include "render/VisualFrameDiagnostics.h"  // opt-in pixel-content instrumentation
#include "XlethDebug.h"
#include "render/CanvasFit.h"
#include "render/AnimationManager.h"
#include "export/FFmpegMuxer.h"
#include "SyncManager.h"          // VideoEvent
#include "render/ArpVideoExpander.h"
#include "render/VideoEventBuilder.h"  // the one timeline -> VideoEvent builder
#include "ProxyTranscoder.h"          // resolution-aware render proxies

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
}

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <limits>
#include <unordered_map>
#include <unordered_set>
#include <vector>

// Buffer size: 512 samples = ~10.67ms at 48kHz. Fixed for consistent
// automation resolution and predictable video frame boundaries.
static constexpr int kBufferSize = 512;

namespace {

// ═══════════════════════════════════════════════════════════════════════════
//  Resolution-aware render proxies
//
//  A 4K source composited into a 1080p render (or into a small grid cell) only
//  ever needs as many pixels as its PEAK on-screen footprint. Decoding the full
//  4K every frame wastes huge CPU/GPU; a footprint-sized all-intra proxy decodes
//  far faster and — because we round the footprint UP to a bucket and never below
//  it — shows no quality loss at the output resolution. Reuses the height-keyed
//  whole-source proxy machinery from the preview-proxy work (ProxyTranscoder).
// ═══════════════════════════════════════════════════════════════════════════

// Output-height buckets the per-source footprint is rounded UP into. Coarse so a
// handful of proxy sizes cover every project; absorbs small footprint estimation
// error. Anything above the top bucket falls back to the original source.
constexpr int kResolutionBuckets[] = {360, 540, 720, 1080, 1440, 2160};

// Smallest bucket >= h. Returns the top bucket if h exceeds all of them (caller
// treats "needs more than the top bucket" as "use original").
int roundUpToBucket(double h) {
    for (int b : kResolutionBuckets)
        if (h <= static_cast<double>(b)) return b;
    return kResolutionBuckets[(sizeof(kResolutionBuckets) / sizeof(int)) - 1];
}

// Peak value an overshoot-capable easing can reach over t∈[0,1] (>=1.0). Used to
// bound the maximum zoom/scale so the chosen bucket is NEVER below the true peak.
float easingPeakFactor(int easingType, float overshoot) {
    switch (easingType) {
        case 3: { // easeOutBack: closed-form argmax of 1 + c3·u³ + c1·u² (u=t-1)
            const float c1 = overshoot, c3 = c1 + 1.0f;
            const float u  = -2.0f * c1 / (3.0f * c3);
            const float pk = 1.0f + c3 * u * u * u + c1 * u * u;
            return std::max(1.0f, pk);
        }
        case 4: return 1.10f;  // easeOutElastic — modest first overshoot (margin)
        case 5: return 1.50f;  // easeOutSpring — overshoots to ~1.5× the delta
        default: return 1.0f;  // linear / easeOut / easeInOut — monotone, no overshoot
    }
}

// Conservative upper bound on the scale a track's animations can apply to its
// cell across the timeline. Includes zoom (note + slide ZPR, with easing
// overshoot) and bounce vertical stretch (1 + squashAmount, see AnimationManager
// where bounceScaleY peaks at 1+squashAmount). Zoom and bounce can be active on
// the same note, so they multiply. Over-estimating is safe (more resolution, the
// task's "NEVER size below the peak footprint" rule); under-estimating is not.
float maxAnimationScale(const TrackInfo& trk) {
    auto zoomPeak = [](const ZoomPanRotSettings& z) -> float {
        if (!z.enabled) return 1.0f;
        // easingPeakFactor is a peak in PROGRESS space, so it still applies —
        // but zoom is now interpolated in log2, and the peak must be computed
        // there too. Doing it linearly UNDER-estimates: for 1x -> 4x with
        // pk = 1.1, linear says 4.30 while the real peak is 2^(2*1.1) = 4.59,
        // which would size the render target below the true footprint.
        const float  pk   = easingPeakFactor(z.zoomEasing, z.overshoot);
        const double ls   = zprZoomToLog2(z.startZoom);
        const double lt   = zprZoomToLog2(z.targetZoom);
        const double lmax = ls + std::max(0.0, lt - ls) * static_cast<double>(pk);
        return std::max({1.0f, z.startZoom, zprLog2ToZoom(lmax)});
    };

    // Note ZPR and slide ZPR are alternatives (slide overwrites the ZPR fields,
    // it does not stack), so take the max of the two, not the product.
    float zoom = zoomPeak(trk.zoomPanRot);
    if (trk.slideNoteEffect.type == SlideNoteEffectSettings::EffectType::ZoomPanRot)
        zoom = std::max(zoom, zoomPeak(trk.slideNoteEffect.zoomPanRot));

    float bounce = 1.0f;
    if (trk.bounce.enabled)
        bounce = std::max(bounce, 1.0f + std::max(0.0f, trk.bounce.squashAmount));
    if (trk.slideNoteEffect.type == SlideNoteEffectSettings::EffectType::Bounce)
        bounce = std::max(bounce, 1.0f + std::max(0.0f, trk.slideNoteEffect.bounce.squashAmount));

    return zoom * bounce;
}

// Number of placements at/above which a source is considered "reused enough" to
// justify the one-time whole-source proxy transcode. A single linear placement
// would cost more to proxy (decode the whole source once + encode) than it saves
// (decode the original once), so it stays on the original.
constexpr int kReuseThreshold = 2;

// Depth of the export encode queue (RENDER_PERF_AUDIT Finding 6a). The render
// thread produces [decode + composite + readback]; the muxer's worker consumes
// [convert + encode + mux]. 0 disables the split entirely and restores the
// strictly serial path — the A/B lever for timing comparisons, and the escape
// hatch if an encoder ever misbehaves under the split.
//
// 3 is enough to hide the encoder behind the producer without letting the
// producer run far enough ahead to matter for memory: (depth+1) frames of BGRA
// is ~33 MB at 1080p, ~133 MB at 4K.
constexpr int kDefaultExportEncodeQueueDepth = 3;

inline int exportEncodeQueueDepth() {
    if (const char* env = std::getenv("XLETH_EXPORT_ENCODE_QUEUE")) {
        char* end = nullptr;
        const long v = std::strtol(env, &end, 10);
        if (end != env && v >= 0 && v <= 8)
            return static_cast<int>(v);
    }
    return kDefaultExportEncodeQueueDepth;
}

using SteadyClock = std::chrono::steady_clock;
inline int64_t usSince(SteadyClock::time_point t0) {
    return std::chrono::duration_cast<std::chrono::microseconds>(
               SteadyClock::now() - t0).count();
}

// Opt-in (XLETH_VISUAL_DIAG_PIXELS=1) content fingerprint of a composed export
// frame, taken immediately before it is handed to the encoder. `pixels` is BGRA
// with row stride `stride`. No-op when the flag is off.
inline void recordExportPreEncode(const uint8_t* pixels, int width, int height,
                                  int stride, long long frameIndex) {
    if (!xleth::visualdiag::pixelsEnabled()) return;
    auto stats = xleth::visualdiag::computeFrameStats(
        pixels, width, height, stride,
        xleth::visualdiag::PixelFormat::BGRA, frameIndex);
    xleth::visualdiag::record("export-pre-encode", stats);
    xleth::visualdiag::maybeDumpFrame(
        "export-pre-encode", pixels, width, height, stride,
        xleth::visualdiag::PixelFormat::BGRA, stats);
}

// Resolve the project canvas (GridLayout) + requested export size + fit mode into
// the compositor's canvas viewport, then apply it. Identity when the export
// aspect matches the project aspect or fit mode is Stretch, so aspect-matched
// exports keep the exact legacy fill path. Logs the resolved placement.
inline void applyCanvasFitToCompositor(GridCompositor& compositor,
                                       const GridLayout& grid,
                                       const ExportSettings& settings) {
    using FM = ExportSettings::FitMode;
    const xleth::CanvasFitMode mode =
          (settings.fitMode == FM::Crop) ? xleth::CanvasFitMode::Crop
        : (settings.fitMode == FM::Bars) ? xleth::CanvasFitMode::Bars
                                         : xleth::CanvasFitMode::Stretch;
    const xleth::CanvasFitViewport vp = xleth::computeCanvasFitViewport(
        grid.canvasWidth, grid.canvasHeight, settings.width, settings.height, mode);
    compositor.setCanvasFit(vp.x, vp.y, vp.w, vp.h);
    const char* modeName = (settings.fitMode == FM::Crop) ? "crop"
                         : (settings.fitMode == FM::Bars) ? "bars" : "stretch";
    std::fprintf(stderr,
        "[CanvasFit] canvas=%dx%d output=%dx%d mode=%s viewport=(%.4f,%.4f,%.4f,%.4f)\n",
        grid.canvasWidth, grid.canvasHeight, settings.width, settings.height,
        modeName, vp.x, vp.y, vp.w, vp.h);
}

// Decoded-frame cache budget for an export.
//
// The cache is what turns a RETRIGGER into a lookup. Without it, every time a
// clip restarts the decoder must seek back to the previous keyframe and decode
// forward to the clip's first frame again — on a long-GOP source that is dozens
// of codec frames thrown away to produce one. This genre retriggers the same
// few syllables hundreds of times, so how many of their frames stay resident
// decides most of the decode cost.
//
// The preview's 512 MB default holds ~61 frames of 1080p BGRA. An export has
// the GPU to itself (the preview is paused for its duration), so on a discrete
// card it takes a quarter of the dedicated memory, between 512 MB and 2 GB.
// Integrated adapters share system RAM and keep the conservative default.
// XLETH_EXPORT_FRAME_CACHE_MB overrides (A/B lever).
inline size_t exportFrameCacheBytes(const GpuDeviceManager& gpu)
{
    constexpr size_t kMB = 1024u * 1024u;
    if (const char* env = std::getenv("XLETH_EXPORT_FRAME_CACHE_MB")) {
        char* end = nullptr;
        const long v = std::strtol(env, &end, 10);
        if (end != env && v >= 64 && v <= 16384)
            return static_cast<size_t>(v) * kMB;
    }
    size_t budgetMB = 512;
    const auto& adapters = gpu.getAdapters();
    const int   active   = gpu.getActiveAdapterIndex();
    for (const auto& a : adapters) {
        if (a.adapterIndex != active || !a.isDiscrete) continue;
        budgetMB = std::clamp<size_t>(a.dedicatedVideoMemoryMB / 4, 512, 2048);
        break;
    }
    return budgetMB * kMB;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ExportVideoStage — one output frame, from "the audio clock crossed a frame
//  boundary" to "the frame is queued for encoding".
//
//  [advance animation → collect → decode misses → composite → readback → submit]
//
//  The tail-clamp render and the wrap render used to each carry their own copy
//  of this (~150 lines apiece). They differed only by accident — one logged an
//  invalid readback and the other did not, one cleaned up the temp file on a
//  compositor failure and the other left it behind — which is exactly how two
//  copies of a pipeline drift. Both now drive this one stage, so a fix or an
//  optimisation lands in every export mode at once.
// ═══════════════════════════════════════════════════════════════════════════
class ExportVideoStage
{
public:
    ExportVideoStage(const Timeline& timeline, MixEngine& mixer, GpuDeviceManager& gpu,
                     FFmpegMuxer& muxer, const ExportSettings& settings,
                     int sampleRate, int64_t startSample,
                     const std::vector<VideoEvent>& events,
                     const std::vector<SlideAnimationEvent>& slideEvents,
                     const std::unordered_map<int, std::string>* proxyPlan)
        : timeline_(timeline), muxer_(muxer), settings_(settings)
        , sampleRate_(sampleRate)
        , fps_{ settings.fpsNum, settings.fpsDen }
        , bpm_(timeline.getBPM())
        , startSample_(startSample)
        , events_(events), slideEvents_(slideEvents), proxyPlan_(proxyPlan)
        , device_(gpu.getDevice()), devCtx_(gpu.getContext())
        , echoResolver_(mixer)
    {
        collector_.setAnimationManager(&animMgr_);
        collector_.setCompanionFxEnabled(true);
        // Lens/Roam, resolved ONCE from the timeline at export start (not per
        // frame): every request copies its values from this snapshot, the same
        // lookup the preview uses. See LensRoamSnapshot (model/LensRoam.h).
        collector_.setLensRoamSnapshot(buildLensRoamSnapshot(timeline_));
        // Color Grades, baked ONCE from the export's frozen timeline: the same
        // snapshot type, the same collector lookup and the same shader the
        // preview uses, which is the whole of preview/export grade parity.
        // The export owns its LUT library, so it never touches the live one.
        collector_.setColorGradeSnapshot(
            xleth::grade::buildColorGradeSnapshot(timeline_, nullptr, &gradeLuts_));

        // Visual Echo: the export renders its audio through THIS MixEngine, so
        // the Delay instances the echo binds to are the same objects, running
        // the same blocks, at the same positions the preview does. Installing a
        // resolver over it is the whole of export/preview echo parity — not a
        // second code path that has to be kept in agreement, but literally the
        // same numbers out of the same effect. Without it the export would
        // still composite every cell correctly and simply draw no taps.
        collector_.setEchoDelayResolver(&echoResolver_);

        cache_.setMemoryLimit(exportFrameCacheBytes(gpu));
    }

    /** Open the decoder (per the requested VideoMode) and the compositor.
     *  Returns false with `error` set to a user-facing message on failure. */
    bool init(std::string& error)
    {
        using VM = ExportSettings::VideoMode;
        const char* modeStr = settings_.videoMode == VM::Hardware ? "hardware"
                            : settings_.videoMode == VM::Software ? "software" : "auto";

        if (settings_.videoMode == VM::Software) {
            // Intentionally skip initHwDevice — software decode unconditionally.
        } else if (settings_.videoMode == VM::Hardware) {
            if (!device_ || !devCtx_ || !decoder_.initHwDevice(device_, devCtx_)) {
                std::fprintf(stderr,
                    "[VideoMode] requested=hardware decode=unavailable encode=%s "
                    "reason=hardware_decode_init_failed\n", muxer_.videoEncoderName());
                error = "Hardware video mode selected, but D3D11VA hardware decode could not be "
                        "initialized. Switch Video mode to Auto or Software in Settings.";
                return false;
            }
        } else if (device_ && devCtx_) {   // Auto
            decoder_.initHwDevice(device_, devCtx_);
        }

        // [VideoMode] diagnostic log — resolved decode/encode path for this export
        {
            const char* reason = (settings_.videoMode == VM::Hardware) ? "forced_hardware"
                               : (settings_.videoMode == VM::Software) ? "user_setting"
                               : muxer_.isVideoEncoderFallback()       ? "auto_fallback_no_hw_encoder"
                                                                       : "auto_detected";
            std::fprintf(stderr, "[VideoMode] requested=%s decode=%s encode=%s reason=%s\n",
                         modeStr, decoder_.hasHwAccel() ? "d3d11va" : "software",
                         muxer_.videoEncoderName(), reason);
        }

        if (device_ && devCtx_) {
            if (!compositor_.init(device_, devCtx_, settings_.width, settings_.height)) {
                error = "Failed to initialize GPU compositor";
                return false;
            }
            applyCanvasFitToCompositor(compositor_, timeline_.getGridLayout(), settings_);
        }
        return true;
    }

    /** Produce output frame `f` and hand it to the encoder. Returns false only
     *  on a fatal error (`error` set); an unusable GPU readback is counted and
     *  skipped unless every frame so far has failed. */
    bool renderFrame(int64_t f, std::string& error)
    {
        const auto t0 = SteadyClock::now();

        const int64_t localFrameSample   = RenderClock::videoFrameToSample(f, sampleRate_, fps_);
        const int64_t projectFrameSample = startSample_ + localFrameSample;
        const double  projectSeconds     = static_cast<double>(projectFrameSample)
                                         / static_cast<double>(sampleRate_);

        // Advance animation state before collecting, and before the slide
        // dispatch below — advanceTo also sets the stamp any trigger fired for
        // this frame will use. Absolute project time, derived from the frame's
        // own sample position, so this matches the live preview frame-for-frame.
        animMgr_.advanceTo(1000.0 * projectSeconds);

        const int64_t projectFrameTick = RenderClock::sampleToPPQ(
            projectFrameSample, sampleRate_, bpm_);
        const GridLayout frameGrid = timeline_.gridLayoutAt(TickTime{ projectFrameTick });

        dispatchSlideEvents(projectFrameTick);

        // The decoder's stream pool reasons about recency; give it the output
        // timeline's clock, not the wall clock (see setPresentationClock).
        decoder_.setPresentationClock(projectSeconds);

        // ── Transition + landing resolve ────────────────────────────────────
        // Both for this frame's tick. The transition is resolved here (same
        // call, same result as before) because a landing frame has to know
        // whether a transition is active before it collects. The landing count
        // stays 0 for a project without landings, and every landing branch
        // below is gated on it.
        Timeline::ResolvedTransition tx =
            timeline_.transitionAt(TickTime{ projectFrameTick });
        Timeline::ResolvedLandings landings;
        if (projectHasLandings_)
            landings = timeline_.landingsAt(TickTime{ projectFrameTick });
        xleth::LandingRenderer::beginFrame(landings, collector_);

        xleth::SnapshotTransitionFrameCtx frameCtx;
        frameCtx.sampleRate          = sampleRate_;
        frameCtx.bpm                 = bpm_;
        frameCtx.fps                 = fps_;
        frameCtx.outputFrameIndex    = f;
        frameCtx.projectStartSample  = startSample_;
        frameCtx.allowProxy          = !settings_.useSourceMedia;
        frameCtx.posterMode          = false;
        frameCtx.renderProxyBySource = proxyPlan_;

        // Collect what each grid cell needs for this output frame. Export
        // honors settings.useSourceMedia: full quality → originals (proxyPlan_
        // null, allowProxy false); fast export → resolution-aware render proxies.
        //
        // On a landing frame without a transition the list comes from the
        // shared LandingRenderer (the preview calls the same function): this
        // frame's layout minus the landing tracks, plus those tracks carried on
        // top at their in-flight rect.
        std::vector<CellFrameRequest>* collectedRequests = nullptr;
        if (landings.count > 0 && !tx.active) {
            collectedRequests = &landingRenderer_.collectFrame(
                landings, frameGrid, timeline_, events_, collector_, frameCtx);
        } else {
            collectedRequests = &collector_.collectRequests(
                f, timeline_, sampleRate_, fps_, events_,
                /*allowProxy=*/ !settings_.useSourceMedia,
                /*projectStartSample=*/ startSample_,
                /*posterMode=*/ false,
                /*renderProxyBySource=*/ proxyPlan_);
        }
        auto& requests = *collectedRequests;
        // Master Color Grade: applied by readback() to the finished frame.
        compositor_.setMasterGrade(collector_.masterGrade());

        // Deduplicate: multiple cells may reference the same source frame
        auto deduplicated = FrameCollector::deduplicateRequests(requests);

        // Size the decoder's open-context budget from this frame's distinct
        // source paths (deduplicated is keyed by (sourcePath, frameIndex), so
        // several keys can share a path; it is unordered, so distinct ids are
        // counted via a set rather than assuming adjacent equal keys).
        {
            distinctPathIds_.clear();
            for (const auto& [key, reqs] : deduplicated)
                distinctPathIds_.insert(key.sourcePath.id());
            decoder_.setActiveContextBudget(static_cast<int>(distinctPathIds_.size()));
        }

        // Check cache and find what needs decoding
        auto misses = FrameCollector::resolveFrames(deduplicated, cache_);
        const auto tCollected = SteadyClock::now();

        // Decode cache misses. Sorted by (sourcePath, frameIndex) ascending so a
        // source with several outstanding misses decodes forward through them,
        // letting the sequential fast path engage instead of ping-ponging
        // between cells reading the same file at different offsets. Reorders
        // decode order only — output pixels unchanged.
        std::sort(misses.begin(), misses.end());
        decodeInto(misses);
        const auto tDecoded = SteadyClock::now();

        if (!compositor_.isInitialized()) {
            timers_.collectUs += usBetween(t0, tCollected);
            timers_.decodeUs  += usBetween(tCollected, tDecoded);
            return true;    // no GPU: nothing to composite (audio-only output)
        }

        // ── Composite ───────────────────────────────────────────────────────
        // Inside an enabled snapshot-cue window, blend outgoing and incoming
        // snapshots through the ONE shared path preview also uses, so
        // export == preview frame for frame. Outside a window this returns
        // false and the single-composite path runs unchanged.
        bool didTransition = false;
        {
            // The transition was resolved before the collect (above).
            if (tx.active) {
                const xleth::SnapshotTransitionFrameCtx& txCtx = frameCtx;
                auto decodeMisses = [this](const std::vector<FrameCacheKey>& m) { decodeInto(m); };
                // Landings: out of both snapshots, then drawn once over the
                // blend (the preview runs this same sequence).
                if (landings.count > 0) {
                    xleth::LandingRenderer::stripLandingTracks(landings, tx.layoutA);
                    xleth::LandingRenderer::stripLandingTracks(landings, tx.layoutB);
                }
                didTransition = xleth::renderSnapshotTransition(
                    tx, timeline_, events_, compositor_, collector_,
                    cache_, txCtx, decodeMisses);
                if (didTransition && landings.count > 0) {
                    landingRenderer_.renderCarryOverlay(
                        landings, timeline_, events_, compositor_,
                        collector_, cache_, txCtx, decodeMisses);
                }
            }
        }
        if (!didTransition) {
            // Global shader time drives visual-state evaluation, so subrange
            // exports must sample it in absolute project time even while
            // encoded frame numbers stay local from zero.
            compositor_.compositeFrame(requests, cache_,
                                       frameGrid.columns, frameGrid.rows,
                                       static_cast<float>(projectSeconds), frameGrid.gapScale);
        }
        const auto tComposited = SteadyClock::now();

        // ── Readback straight into the encoder's own buffer ─────────────────
        // The muxer hands out the pooled frame it will encode from, and the
        // compositor's staging map is copied into it directly. There used to be
        // a hop in between (GPU → compositor's vector → memcpy → pooled
        // buffer): a second full-frame copy, 8 MB at 1080p, per frame.
        // acquireVideoBuffer() blocks when the producer is a full queue ahead
        // of the encoder, so its wait is back-pressure and is booked to submit.
        uint8_t* dst = muxer_.acquireVideoBuffer();
        if (!dst) {
            error = "Video encoding failed at frame " + std::to_string(f);
            return false;
        }
        const auto tAcquired = SteadyClock::now();

        const auto& readback = compositor_.readback(
            ReadbackMode::Immediate, dst, muxer_.videoBufferBytes());
        const auto tRead = SteadyClock::now();

        ++framesAttempted_;
        ++timers_.frames;
        timers_.collectUs   += usBetween(t0, tCollected);
        timers_.decodeUs    += usBetween(tCollected, tDecoded);
        timers_.compositeUs += usBetween(tDecoded, tComposited);
        timers_.readbackUs  += usBetween(tAcquired, tRead);
        timers_.submitUs    += usBetween(tComposited, tAcquired);

        if (!readback.valid) {
            muxer_.releaseVideoBuffer();
            return onInvalidReadback(f, error);
        }

        havePicture_ = true;
        bool videoOk = false;
        if (readback.intoDestination) {
            recordExportPreEncode(dst, readback.width, readback.height, readback.stride, f);
            const auto tSubmit = SteadyClock::now();
            videoOk = muxer_.submitVideoBuffer(f);
            timers_.submitUs += usSince(tSubmit);
        } else {
            // The compositor could not use our buffer (its target is not a
            // tightly packed BGRA frame of the export size) and filled its own.
            // Take the copying path for this frame rather than lose it.
            muxer_.releaseVideoBuffer();
            recordExportPreEncode(readback.pixels.data(), readback.width, readback.height,
                                  readback.stride, f);
            const auto tSubmit = SteadyClock::now();
            videoOk = muxer_.writeVideo(readback.pixels.data(), readback.stride, f);
            timers_.submitUs += usSince(tSubmit);
        }
        if (!videoOk) {
            error = "Video encoding failed at frame " + std::to_string(f);
            return false;
        }
        return true;
    }

    /** True once at least one frame has been composited and read back. */
    bool hasPicture() const { return havePicture_; }

    /** tailClamp: submit the last composited picture again as frame `f`. The
     *  compositor's render target still holds it, so it is read back ONCE on
     *  the first call instead of being copied aside after every frame of the
     *  whole render on the chance a tail would need it. */
    bool repeatLastFrame(int64_t f, std::string& error)
    {
        if (!havePicture_) return true;
        if (frozen_.empty()) {
            const auto& rb = compositor_.readback();
            if (!rb.valid || rb.pixels.empty()) {
                havePicture_ = false;       // nothing to freeze; tail is audio-only
                return true;
            }
            frozen_       = rb.pixels;
            frozenStride_ = rb.stride;
        }
        if (!muxer_.writeVideo(frozen_.data(), frozenStride_, f)) {
            error = "Video encoding failed (tail) at frame " + std::to_string(f);
            return false;
        }
        return true;
    }

    void logSummary(int queueDepth) const
    {
        timers_.log(queueDepth);

        const auto& ds = decoder_.decodeStats();
        const auto& es = decoder_.extractStats();
        std::fprintf(stderr,
            "[Renderer] Decoder: calls=%llu opens=%llu (%.2fs) seeks=%llu "
            "codecFrames=%llu decode=%.2fs extract=%.2fs | hwGpu=%llu hwTransfer=%llu sw=%llu\n",
            (unsigned long long)ds.calls, (unsigned long long)ds.opens, ds.openUs / 1e6,
            (unsigned long long)ds.seeks, (unsigned long long)ds.framesDecoded,
            ds.decodeUs / 1e6, ds.extractUs / 1e6,
            (unsigned long long)es.hwGpuFrames, (unsigned long long)es.hwTransferFrames,
            (unsigned long long)es.swFrames);

        const RenderCacheStats cs = cache_.getStats();
        const uint64_t lookups = cs.hitCount + cs.missCount;
        std::fprintf(stderr,
            "[Renderer] Frame cache: %llu hits / %llu misses (%.1f%% hit), %llu evictions, "
            "%.0f / %.0f MB\n",
            (unsigned long long)cs.hitCount, (unsigned long long)cs.missCount,
            lookups ? 100.0 * static_cast<double>(cs.hitCount) / static_cast<double>(lookups) : 0.0,
            (unsigned long long)cs.evictionCount,
            cs.currentBytes / (1024.0 * 1024.0), cs.limitBytes / (1024.0 * 1024.0));

        if (framesAttempted_ > 0) {
            std::fprintf(stderr,
                "[Renderer] Video frames: attempted=%lld, invalid_readback=%lld (%.1f%%)\n",
                (long long)framesAttempted_, (long long)invalidReadbacks_,
                100.0 * static_cast<double>(invalidReadbacks_)
                      / static_cast<double>(framesAttempted_));
            if (invalidReadbacks_ > 0) {
                std::fprintf(stderr,
                    "[Renderer] WARN: export degraded — %lld of %lld frames had invalid GPU "
                    "readback (compositor produced no pixels). Check earlier log for "
                    "[GridCompositor] errors.\n",
                    (long long)invalidReadbacks_, (long long)framesAttempted_);
            }
        }
    }

    void shutdown()
    {
        compositor_.shutdown();
        decoder_.closeAll();
        cache_.clear();
    }

private:
    // Wall-clock split of the per-frame video work, so an A/B run shows WHERE
    // the time went and not merely that the total moved.
    struct Timers {
        int64_t collectUs = 0, decodeUs = 0, compositeUs = 0, readbackUs = 0, submitUs = 0;
        int64_t frames = 0;

        void log(int queueDepth) const {
            if (frames <= 0) return;
            const double n = static_cast<double>(frames);
            const int64_t produceUs = collectUs + decodeUs + compositeUs + readbackUs;
            std::fprintf(stderr,
                "[Renderer] Video stages over %lld frames: produce=%.2fs (%.2f ms/f) "
                "[collect=%.2f decode=%.2f composite=%.2f readback=%.2f ms/f], "
                "submit=%.2fs (%.2f ms/f), encodeQueue=%d (%s)\n",
                (long long)frames,
                produceUs / 1e6, produceUs / 1000.0 / n,
                collectUs / 1000.0 / n, decodeUs / 1000.0 / n,
                compositeUs / 1000.0 / n, readbackUs / 1000.0 / n,
                submitUs / 1e6, submitUs / 1000.0 / n,
                queueDepth, queueDepth > 0 ? "pipelined" : "serial");
        }
    };

    static int64_t usBetween(SteadyClock::time_point a, SteadyClock::time_point b) {
        return std::chrono::duration_cast<std::chrono::microseconds>(b - a).count();
    }

    void decodeInto(const std::vector<FrameCacheKey>& misses)
    {
        if (!device_ || !devCtx_) return;
        for (const auto& key : misses) {
            auto entry = decoder_.decode(key.sourcePath.str(), key.frameIndex, device_, devCtx_);
            if (entry.texture) cache_.put(key, std::move(entry));
        }
    }

    // Fire any SlideAnimationEvents whose startBeat falls in the
    // (prevBeat, currentBeat] window ending at this frame.
    void dispatchSlideEvents(int64_t projectFrameTick)
    {
        const double ticksPerBeat = static_cast<double>(TickTime::fromBeats(1).ticks);
        const double currentBeat  = static_cast<double>(projectFrameTick) / ticksPerBeat;
        if (prevBeat_ < 0.0 || currentBeat + 1e-6 < prevBeat_)
            prevBeat_ = currentBeat - 1e-6;
        for (const auto& se : slideEvents_) {
            if (se.startBeat > prevBeat_ && se.startBeat <= currentBeat) {
                const TrackInfo* tr = timeline_.getTrack(se.trackId);
                if (!tr) continue;
                const auto& cfg = tr->slideNoteEffect;
                if (cfg.type == SlideNoteEffectSettings::EffectType::None) continue;
                const double durationMs =
                    (cfg.durationMode == SlideNoteEffectSettings::DurationMode::FollowSlide)
                        ? se.durationBeats * (60000.0 / bpm_)
                        : cfg.fixedDurationMs;
                animMgr_.onSlideEvent(se.trackId, static_cast<float>(durationMs),
                                      cfg, se.slideCurveCx, se.slideCurveCy);
            }
        }
        prevBeat_ = currentBeat;
    }

    // readback.valid == false means the D3D11 staging Map() failed (a GPU/driver
    // error), NOT empty/transparent content — an empty composite still reads
    // back as valid black pixels. One bad frame is skipped and counted; if
    // EVERY frame so far has failed, fail fast rather than write a video file
    // with no frames in it.
    bool onInvalidReadback(int64_t f, std::string& error)
    {
        ++invalidReadbacks_;
        if (invalidReadbacks_ <= 5 || (invalidReadbacks_ % 100) == 0) {
            std::fprintf(stderr,
                         "[Renderer] Compositor readback invalid at frame %lld (total invalid=%lld)\n",
                         (long long)f, (long long)invalidReadbacks_);
        }
        constexpr int64_t kEarlyAbortThreshold = 10;
        if (framesAttempted_ >= kEarlyAbortThreshold && invalidReadbacks_ == framesAttempted_) {
            error = "Compositor readback failed for the first "
                  + std::to_string(kEarlyAbortThreshold)
                  + " video frames (D3D11 staging Map failed). "
                    "Check engine log for GPU/driver errors.";
            return false;
        }
        return true;
    }

    const Timeline&        timeline_;
    FFmpegMuxer&           muxer_;
    const ExportSettings&  settings_;
    const int              sampleRate_;      // rate of the timeline math (the mix rate)
    const AVRational       fps_;
    const double           bpm_;
    const int64_t          startSample_;
    const std::vector<VideoEvent>&          events_;
    const std::vector<SlideAnimationEvent>& slideEvents_;
    const std::unordered_map<int, std::string>* proxyPlan_;
    ID3D11Device*          device_;
    ID3D11DeviceContext*   devCtx_;

    RenderFrameCache       cache_;
    FrameCollector         collector_;
    xleth::grade::Lut3DLibrary gradeLuts_;   // imported LUTs, loaded once at export start
    AnimationManager       animMgr_;
    // Landing carry (docs/XLETH_LANDING_SPEC.md): the same helper the live
    // preview calls. timeline_ is the export's frozen copy, so whether any cue
    // has landings is decided once; without any, no landing code runs.
    xleth::LandingRenderer landingRenderer_;
    const bool             projectHasLandings_ = timeline_.hasCueLandings();
    const xleth::echo::MixEngineDelayResolver echoResolver_;
    RenderVideoDecoder     decoder_;
    GridCompositor         compositor_;

    std::unordered_set<uint32_t> distinctPathIds_;   // reused per frame
    double   prevBeat_ = -1.0;                       // slide-event beat-crossing dispatch
    Timers   timers_;
    int64_t  framesAttempted_  = 0;
    int64_t  invalidReadbacks_ = 0;
    bool     havePicture_      = false;
    std::vector<uint8_t> frozen_;                    // tailClamp freeze frame (lazy)
    int      frozenStride_     = 0;
};

} // namespace

// ===========================================================================
// Constructor / Destructor
// ===========================================================================

OfflineRenderer::OfflineRenderer(const Timeline& timeline,
                                 MixEngine& mixer,
                                 GpuDeviceManager& gpu)
    : timeline_(timeline)
    , mixer_(mixer)
    , gpu_(gpu)
{
}

OfflineRenderer::~OfflineRenderer()
{
    // Request cancel and wait for thread to finish
    progress_.cancelRequested.store(true);
    if (renderThread_ && renderThread_->joinable())
        renderThread_->join();
}

// ===========================================================================
// startRender — spawn the background render thread
// ===========================================================================

bool OfflineRenderer::startRender(int64_t startSample, int64_t endSample,
                                  const ExportSettings& settings)
{
    // Legacy overload: warm-up begins at the capture start (latency-only pre-roll).
    return startRender(startSample, endSample, startSample, settings);
}

bool OfflineRenderer::startRender(int64_t startSample, int64_t endSample,
                                  int64_t warmUpStartSample,
                                  const ExportSettings& settings)
{
    if (running_.load()) {
        std::fprintf(stderr, "[Renderer] ERROR: render already in progress\n");
        return false;
    }

    // Join any prior thread
    if (renderThread_ && renderThread_->joinable())
        renderThread_->join();

    // Reset progress
    progress_.percentage.store(0.0f);
    progress_.currentFrame.store(0);
    progress_.totalFrames.store(0);
    progress_.speedMultiplier.store(0.0f);
    progress_.etaSeconds.store(0.0f);
    progress_.phase.store(0);
    progress_.cancelRequested.store(false);
    progress_.complete.store(false);
    progress_.failed.store(false);
    progress_.setError("");

    running_.store(true);

    // Capture settings by value for the thread
    renderThread_ = std::make_unique<std::thread>(
        [this, startSample, endSample, warmUpStartSample, settings]() {
            render(startSample, endSample, warmUpStartSample, settings);
            running_.store(false);
        });

    return true;
}

// ===========================================================================
// requestCancel
// ===========================================================================

void OfflineRenderer::requestCancel()
{
    progress_.cancelRequested.store(true);
}

// ===========================================================================
// buildVideoEvents — convert timeline clips+patterns into VideoEvent list
// ===========================================================================

std::vector<VideoEvent> OfflineRenderer::buildVideoEvents(
    const Timeline& timeline,
    std::vector<SlideAnimationEvent>* outSlideEvents,
    double eventSampleRate)
{
    // The event list comes from the ONE shared builder the live preview also
    // uses (render/VideoEventBuilder.h). This function used to carry its own
    // copy of the clip and pattern loops, and the two copies had drifted: see
    // that header for the ways export and preview disagreed.
    const double sampleRate = eventSampleRate > 0.0
        ? eventSampleRate
        : timeline.getSampleRate();

    auto built = xleth::videoevents::build(timeline, timeline.getBPM(), sampleRate);
    if (outSlideEvents) *outSlideEvents = std::move(built.slideEvents);

    std::fprintf(stderr, "[Renderer] Built %d video events from timeline\n",
                 static_cast<int>(built.events.size()));
    return std::move(built.events);
}

// ===========================================================================
// buildRenderProxyPlan — resolution-aware per-source proxy selection + gen
// ===========================================================================

std::unordered_map<int, std::string> OfflineRenderer::buildRenderProxyPlan(
    const std::vector<VideoEvent>& events,
    const ExportSettings&          settings)
{
    std::unordered_map<int, std::string> plan;
    if (proxiesDir_.empty()) {
        std::fprintf(stderr, "[RenderProxy] no proxies dir set — using original sources\n");
        return plan;
    }

    const GridLayout& grid = timeline_.getGridLayout();
    const int H_out = settings.height;
    const int fullH = std::max(1, grid.rows * kGridSubUnitsPerRow);

    // ── Per-track base footprint height (pixels) at the OUTPUT resolution ──────
    // Fullscreen layer → full output height; grid slot → output height × the
    // slot's vertical span fraction. A track present in several placements takes
    // the largest. (Gaps/gapScale only shrink cells, so ignoring them is safe —
    // it can only over-size, never under-size.)
    std::unordered_map<int, double> baseHeightByTrack;
    for (const auto& fl : grid.fullscreenLayers) {
        if (fl.trackId < 0) continue;
        double& b = baseHeightByTrack[fl.trackId];
        b = std::max(b, static_cast<double>(H_out));
    }
    for (const auto& slot : grid.slots) {
        if (slot.trackId < 0) continue;
        const double cellH = static_cast<double>(H_out) * slot.spanY / fullH;
        double& b = baseHeightByTrack[slot.trackId];
        b = std::max(b, cellH);
    }

    // ── Per-source peak footprint + reference count across the whole timeline ──
    std::unordered_map<int, double> peakBySource;   // max footprint height (px)
    std::unordered_map<int, int>    refsBySource;    // placements (reuse signal)
    for (const auto& ev : events) {
        if (ev.sourceId <= 0) continue;
        auto bit = baseHeightByTrack.find(ev.trackId);
        if (bit == baseHeightByTrack.end()) continue;   // track not on screen
        const TrackInfo* trk = timeline_.getTrack(ev.trackId);
        const float scale = trk ? maxAnimationScale(*trk) : 1.0f;
        const double footprint = bit->second * scale;
        double& pk = peakBySource[ev.sourceId];
        pk = std::max(pk, footprint);
        ++refsBySource[ev.sourceId];
    }

    // ── Decide + generate per source ──────────────────────────────────────────
    const int topBucket = kResolutionBuckets[(sizeof(kResolutionBuckets) / sizeof(int)) - 1];
    for (const auto& [sourceId, peakH] : peakBySource) {
        const SourceMedia* src = timeline_.getSource(sourceId);
        if (!src || !src->hasVideo || src->filePath.empty() || src->height <= 0)
            continue;

        const int    bucket = roundUpToBucket(peakH);
        const int    refs   = refsBySource[sourceId];

        // Use the ORIGINAL when a proxy would not help:
        //   • footprint at/above source resolution (bucket >= srcHeight) — a proxy
        //     could only equal or upscale the source, so decode the original;
        //   • footprint exceeds our largest bucket — don't undersize;
        //   • single-use linear source — proxy gen costs more than it saves.
        if (bucket >= src->height || peakH > static_cast<double>(topBucket)
            || refs < kReuseThreshold) {
            std::fprintf(stderr,
                "[RenderProxy] source=%d peak=%.0fpx bucket=%dp refs=%d srcH=%d "
                "-> ORIGINAL\n",
                sourceId, peakH, bucket, refs, src->height);
            continue;
        }

        // Preserve 10-bit through the proxy for 10-bit sources (avoids banding).
        const bool highBitDepth = ProxyTranscoder::probeSourceBitDepth(src->filePath) > 8;

        // Idempotent: reuse a valid proxy already on disk (this or a prior render/
        // preview session, H.264 or legacy intra) instead of regenerating. Both
        // decode frame-exactly through RenderVideoDecoder (BACKWARD seek, then
        // decode forward to the target PTS), and the render reads mostly
        // sequentially, where a GOP costs nothing.
        if (const auto found = ProxyTranscoder::findSourcePreviewProxy(
                src->filePath, proxiesDir_, bucket, highBitDepth);
                found.found) {
            std::fprintf(stderr,
                "[RenderProxy] source=%d peak=%.0fpx bucket=%dp refs=%d -> reuse %s\n",
                sourceId, peakH, bucket, refs, found.path.c_str());
            plan[sourceId] = found.path;
            continue;
        }

        // New proxies follow the proxy-codec setting (10-bit stays intra).
        const ProxyCodec codec = ProxyTranscoder::codecForTargetSize(
            static_cast<int>(std::lround(static_cast<double>(src->width) * bucket / src->height)),
            bucket);
        const std::string proxyPath = ProxyTranscoder::getSourcePreviewProxyPath(
            src->filePath, proxiesDir_, bucket, highBitDepth, codec);

        std::fprintf(stderr,
            "[RenderProxy] source=%d peak=%.0fpx bucket=%dp refs=%d %s -> GENERATE %s\n",
            sourceId, peakH, bucket, refs, highBitDepth ? "10-bit" : "8-bit",
            proxyPath.c_str());

        const bool ok = ProxyTranscoder::transcodeSourcePreview(
            src->filePath, proxyPath, bucket, highBitDepth, /*progressCb=*/nullptr, codec);
        if (ok) {
            plan[sourceId] = proxyPath;
        } else {
            // Non-fatal: leave this source out of the plan → render uses original.
            std::fprintf(stderr,
                "[RenderProxy] source=%d proxy generation FAILED — using original\n",
                sourceId);
        }
    }

    std::fprintf(stderr, "[RenderProxy] plan ready: %d/%d sources proxied\n",
                 static_cast<int>(plan.size()), static_cast<int>(peakBySource.size()));
    return plan;
}

// ===========================================================================
// render — the main offline render loop (runs on dedicated thread)
// ===========================================================================

void OfflineRenderer::render(int64_t startSample, int64_t endSample,
                              int64_t warmUpStartSample,
                              const ExportSettings& settings)
{
    try {
        renderImpl(startSample, endSample, warmUpStartSample, settings);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "[Renderer] ERROR: %s\n", e.what());
        progress_.setError(e.what());
        progress_.failed.store(true);
        mixer_.setNonRealtime(false);
        progress_.phase.store(0);
    } catch (...) {
        std::fprintf(stderr, "[Renderer] ERROR: unknown exception\n");
        progress_.setError("Unknown exception during render");
        progress_.failed.store(true);
        mixer_.setNonRealtime(false);
        progress_.phase.store(0);
    }
}

// ===========================================================================
// renderImpl — actual render logic (called from render() with try/catch)
// ===========================================================================

namespace {

// Engine state every render borrows and must hand back on EVERY exit path —
// error returns, cancel, exception unwind, or normal completion: the mixer's
// non-realtime lock mode, the note-trigger ceiling (which must never leak into
// realtime playback) and the progress phase.
struct RenderSession {
    MixEngine&      mixer;
    RenderProgress& progress;
    bool            ceilingArmed = false;

    ~RenderSession() {
        if (ceilingArmed) mixer.clearNoteTriggerCeiling();
        mixer.setNonRealtime(false);
        progress.phase.store(0);
    }
};

// Speed / ETA shown by the export dialog, from samples of MIX audio written.
void publishProgress(RenderProgress& progress, int64_t samplesWritten, int64_t totalSamples,
                     int sampleRate, SteadyClock::time_point renderStartTime)
{
    progress.percentage.store(static_cast<float>(samplesWritten)
                            / static_cast<float>(totalSamples) * 100.0f);

    const double elapsedSec =
        std::chrono::duration<double>(SteadyClock::now() - renderStartTime).count();
    if (elapsedSec <= 0.01) return;
    const double renderedSec = static_cast<double>(samplesWritten) / sampleRate;
    const float  speed       = static_cast<float>(renderedSec / elapsedSec);
    progress.speedMultiplier.store(speed);
    if (speed > 0.0f) {
        const double remainingSec =
            static_cast<double>(totalSamples - samplesWritten) / sampleRate;
        progress.etaSeconds.store(static_cast<float>(remainingSec / speed));
    }
}

} // namespace

// Flush the encoders, then turn the crash-safe fragmented file into the
// standard faststart MP4 the user asked for. Returns false only when the muxer
// itself could not finalize; a failed remux falls back to the fragmented file.
bool OfflineRenderer::finishOutput(FFmpegMuxer& muxer, const std::string& fragPath,
                                   const std::string& outputPath)
{
    std::error_code ec;
    if (!muxer.finalize()) {
        progress_.setError("Muxer finalization failed");
        progress_.failed.store(true);
        std::filesystem::remove(fragPath, ec);
        return false;
    }

    if (progress_.cancelRequested.load()) {
        // Cancelled during finalize — clean up
        std::filesystem::remove(fragPath, ec);
        return true;
    }

    std::fprintf(stderr, "[Renderer] Remuxing frag MP4 → standard MP4 with faststart...\n");
    if (!remuxToFaststart(fragPath, outputPath)) {
        // Remux failed — fall back: just rename frag file as output
        std::fprintf(stderr, "[Renderer] Remux failed, using fragmented file directly\n");
        std::filesystem::remove(outputPath, ec);
        std::filesystem::rename(fragPath, outputPath, ec);
    } else {
        std::filesystem::remove(fragPath, ec);
    }

    const auto fileSize = std::filesystem::file_size(outputPath, ec);
    if (!ec) {
        std::fprintf(stderr, "[Renderer] Remux complete. File: '%s' size=%lld bytes\n",
                     outputPath.c_str(), (long long)fileSize);
    }
    return true;
}

void OfflineRenderer::renderImpl(int64_t startSample, int64_t endSample,
                                  int64_t warmUpStartSample,
                                  const ExportSettings& settings)
{
    // Phase 3B: wrap (seamless tail fold) is a distinct A/V pipeline (pre-rendered
    // folded audio + region-only video, no freeze). Branch before any Phase 3A
    // setup so that path stays separate.
    if (tailPlan_.mode == xleth::TailRenderMode::Wrap) {
        renderImplWrap(startSample, endSample, warmUpStartSample, settings);
        return;
    }

    // THE MIX RATE. The engine renders at settings.audioInputRate() — the
    // session rate — and every sample position in this function (startSample,
    // endSample, the tail plan, the frame clock) is counted at that rate. The
    // rate of the ENCODED audio is the muxer's business: it resamples the
    // finished master. The mix therefore sounds the same at every output rate,
    // which it did not while the whole engine was re-prepared at the export
    // rate — pitch/stretch engines place their onsets differently at 44.1 kHz
    // than at 48 kHz, so a 44.1 kHz export disagreed with playback by up to
    // ~17 ms per note.
    const int sampleRate = settings.audioInputRate();
    const AVRational fps = { settings.fpsNum, settings.fpsDen };
    const double bpm = timeline_.getBPM();

    // Phase 3A tail policy (set via setTailRenderPlan before startRender).
    const xleth::TailRenderPlan tailPlan = tailPlan_;

    RenderSession session{ mixer_, progress_ };

    // Clamp warm-up into [0, startSample]; warming up past the capture start is
    // meaningless and a negative warm-up is undefined.
    if (warmUpStartSample < 0)           warmUpStartSample = 0;
    if (warmUpStartSample > startSample)  warmUpStartSample = startSample;

    const bool isRegion = (startSample > 0);
    std::fprintf(stderr, "[Renderer] Region mode: %s\n",
                 isRegion ? "region" : "full timeline");
    if (isRegion) {
        std::fprintf(stderr, "[Renderer] Region: %lld → %lld\n",
                     (long long)startSample, (long long)endSample);
    }
#ifdef XLETH_DEBUG
    std::fprintf(stderr,
        "[RenderScope] capture=[%lld,%lld) warmUpStart=%lld outputStart=0 absoluteWindow=%s\n",
        (long long)startSample, (long long)endSample, (long long)warmUpStartSample,
        warmUpStartSample < startSample ? "yes" : "no");
#endif

    const int64_t totalSamples = endSample - startSample;
    const int64_t totalVideoFrames = RenderClock::frameCountForSamples(
        totalSamples, sampleRate, fps);
    progress_.totalFrames.store(totalVideoFrames);

    // ── PHASE 1: PRE-ROLL ────────────────────────────────────────────────
    progress_.phase.store(1);

    // Prepare MixEngine at the mix rate
    mixer_.setNonRealtime(true);
    mixer_.prepare(static_cast<double>(sampleRate), kBufferSize);
    std::fprintf(stderr, "[Renderer] prepareToPlay(sampleRate=%d, bufferSize=%d) done, "
                 "nonRealtime=1, encodeRate=%d\n",
                 sampleRate, kBufferSize, settings.sampleRate);

    // Pre-roll plan: warm up the engine from warmUpStartSample (tick 0 for a
    // scoped absolute window), discard that output, and flush plugin/insert
    // latency so the first KEPT sample == intended audio at startSample. Shared
    // math with AudioExporter via render/RenderScope.h. The track term is the
    // route-aware max path latency (Prompt 2C) so latent / nested bus chains are
    // fully flushed; for unrouted projects it equals the flat per-track max.
    const auto latencySnapshot = mixer_.getLatencyCompensationSnapshot();
    const auto prerollPlan = xleth::computeRenderPrerollPlan(
        warmUpStartSample, startSample,
        latencySnapshot.maxPathLatencySamples,
        latencySnapshot.masterInsertLatencySamples);
    const int64_t historyPreroll = prerollPlan.availablePrerollSamples;
    const int64_t renderStart = prerollPlan.renderStartSample;
    const int64_t totalDiscard = prerollPlan.discardSamples;
    const int64_t renderSamplesNeeded = totalSamples + totalDiscard;
    const int64_t renderEnd = renderStart + renderSamplesNeeded;
    std::fprintf(stderr,
                 "[Renderer] PRE-ROLL: trackPath=%d master=%d history=%lld discard=%lld start=%lld renderStart=%lld renderEnd=%lld\n",
                 latencySnapshot.maxPathLatencySamples,
                 latencySnapshot.masterInsertLatencySamples,
                 (long long)historyPreroll,
                 (long long)totalDiscard,
                 (long long)startSample,
                 (long long)renderStart,
                 (long long)renderEnd);

    // ── Build video events from timeline ─────────────────────────────────
    std::vector<SlideAnimationEvent> slideEvents;
    auto videoEvents = buildVideoEvents(timeline_, &slideEvents, sampleRate);

    // ── Resolution-aware render proxy plan ────────────────────────────────
    // Proxy-mode render (settings.useSourceMedia == false, i.e. "fast export"):
    // build a footprint-sized proxy per heavily-reused source and decode from it.
    // Full-quality render (useSourceMedia == true): planPtr stays null so every
    // element decodes the ORIGINAL — bit-exact pixels reach the encoder.
    // Generation is blocking here (offline thread); flag it as the preroll phase.
    std::unordered_map<int, std::string> renderProxyPlan;
    const bool useProxyMode = !settings.useSourceMedia;
    if (useProxyMode) {
        progress_.phase.store(1);   // preroll (proxy generation)
        renderProxyPlan = buildRenderProxyPlan(videoEvents, settings);
    }
    const std::unordered_map<int, std::string>* planPtr =
        useProxyMode ? &renderProxyPlan : nullptr;

    // ── Initialize pipeline components ───────────────────────────────────
    // Use fragmented MP4 for crash safety — remux to standard at the end
    ExportSettings muxSettings = settings;
    const std::string fragPath = settings.outputPath + ".frag.mp4";
    muxSettings.outputPath = fragPath;
    muxSettings.fragmentedMP4 = true;

    using VM = ExportSettings::VideoMode;

    FFmpegMuxer muxer;
    if (!muxer.init(muxSettings)) {
        // At this point the decoder has not been attempted yet; report what decode
        // would have been based on GPU availability.
        const char* modeStr = settings.videoMode == VM::Hardware ? "hardware"
                            : settings.videoMode == VM::Software ? "software" : "auto";
        const char* wouldBeDec = (settings.videoMode != VM::Software
                                  && gpu_.getDevice() && gpu_.getContext())
                                 ? "d3d11va" : "software";
        const char* reason = (settings.videoMode == VM::Hardware)
                             ? "hardware_encoder_unavailable" : "encoder_init_failed";
        std::fprintf(stderr,
            "[VideoMode] requested=%s decode=%s encode=none reason=%s\n",
            modeStr, wouldBeDec, reason);

        progress_.setError(
            settings.videoMode == VM::Hardware
            ? "Hardware video mode selected, but no compatible hardware encoder could be "
              "opened. Switch Video mode to Auto or Software in Settings."
            : "Failed to initialize video encoder");
        progress_.failed.store(true);
        return;
    }
    // Surface encoder name and fallback flag to the UI
    progress_.setVideoEncoderName(muxer.videoEncoderName());
    progress_.videoEncoderFallback.store(muxer.isVideoEncoderFallback());

    // Finding 6a — hand [convert + encode + mux] to the muxer's own thread so
    // this thread's [decode + composite + readback] overlaps it instead of
    // waiting for it. The worker consumes the bounded queue strictly FIFO and
    // the frame index is carried explicitly, so the encoder sees exactly the
    // frame sequence the serial path fed it.
    const int encodeQueueDepth = exportEncodeQueueDepth();
    muxer.enableAsyncVideo(encodeQueueDepth);

    // Every abandon path: stop the encoder and remove the partial temp file.
    auto abandon = [&]() {
        muxer.finalize();
        std::error_code ec;
        std::filesystem::remove(fragPath, ec);
    };
    auto fail = [&](const std::string& message) {
        progress_.setError(message);
        progress_.failed.store(true);
        abandon();
    };

    ExportVideoStage video(timeline_, mixer_, gpu_, muxer, settings, sampleRate,
                           startSample, videoEvents, slideEvents, planPtr);
    std::string stageError;
    if (!video.init(stageError)) { fail(stageError); return; }

    std::fprintf(stderr, "[Renderer] START: samples %lld → %lld (%.2fs), renderStart=%lld discard=%lld renderEnd=%lld\n",
                 (long long)startSample, (long long)endSample,
                 static_cast<double>(totalSamples) / sampleRate,
                 (long long)renderStart,
                 (long long)totalDiscard,
                 (long long)renderEnd);

    // ── PHASE 2: RENDER ──────────────────────────────────────────────────
    progress_.phase.store(2);

    // tailClamp: no NEW notes/clips trigger at/after capture end (absolute
    // sample). Sustaining voices + insert effect tails are unaffected. Cleared by
    // the session guard on every exit path.
    mixer_.setNoteTriggerCeilingSample(endSample);
    session.ceilingArmed = true;

    const bool tailEnabled = (tailPlan.mode == xleth::TailRenderMode::TailClamp)
                          && (tailPlan.maxTailSamples > 0);
#ifdef XLETH_DEBUG
    std::fprintf(stderr,
        "[RenderScope] tail mode=%s captureEnd=%lld threshLin=%.6f capSamples=%lld "
        "holdSamples=%lld freezeVideo=%s\n",
        tailEnabled ? "tailClamp" : "hardCut",
        (long long)endSample, tailPlan.thresholdLinear,
        (long long)tailPlan.maxTailSamples, (long long)tailPlan.holdSamples,
        tailPlan.freezeVideo ? "yes" : "no");
#endif

    // Local transport for offline rendering (independent of realtime AudioEngine)
    Transport transport;
    transport.setSampleRate(static_cast<double>(sampleRate));
    transport.setBPM(bpm);
    transport.seekToSample(renderStart);
    transport.play();

    // Allocate audio buffer ONCE — reuse across iterations
    juce::AudioBuffer<float> audioBuffer(2, kBufferSize);

    int64_t currentSample = renderStart;
    int64_t audioSamplesWritten = 0;
    int64_t samplesRemainingToDiscard = totalDiscard;
    int     iterationCount = 0;

    const auto renderStartTime = SteadyClock::now();

    while (currentSample < renderEnd && audioSamplesWritten < totalSamples) {
        // ── Check cancel every buffer ────────────────────────────────────
        if (progress_.cancelRequested.load()) {
            std::fprintf(stderr, "[Renderer] CANCELLED at %.1f%% (sample %lld). "
                         "Discarding partial file...\n",
                         progress_.percentage.load(), (long long)currentSample);
            abandon();
            return;
        }

        // Handle last partial buffer
        const int thisBufferSize = static_cast<int>(
            std::min(static_cast<int64_t>(kBufferSize), renderEnd - currentSample));

        // ── Process audio ────────────────────────────────────────────────
        if (audioBuffer.getNumSamples() != thisBufferSize)
            audioBuffer.setSize(2, thisBufferSize, false, false, true);
        audioBuffer.clear();

        mixer_.processBlock(audioBuffer, thisBufferSize, transport);

        // ── Write audio to muxer ─────────────────────────────────────────
        const int discardThisBlock = static_cast<int>(
            std::min<int64_t>(samplesRemainingToDiscard, thisBufferSize));
        samplesRemainingToDiscard -= discardThisBlock;

        const int keepOffset = discardThisBlock;
        int keepSamples = thisBufferSize - discardThisBlock;
        if (keepSamples > 0) {
            keepSamples = static_cast<int>(
                std::min<int64_t>(keepSamples, totalSamples - audioSamplesWritten));
        }

        if (keepSamples > 0) {
            const float* audioChannels[2] = {
                audioBuffer.getReadPointer(0) + keepOffset,
                audioBuffer.getReadPointer(1) + keepOffset
            };
            if (!muxer.writeAudio(audioChannels, keepSamples, audioSamplesWritten)) {
                fail("Audio encoding failed");
                return;
            }

            // ── Emit video frames at audio-derived boundaries ────────────
            // audioSamplesWritten is 0-based relative to export start, so
            // frame 0 aligns with sample 0 of the output.
            const auto frameBounds = RenderClock::frameBoundsForBuffer(
                audioSamplesWritten, keepSamples, sampleRate, fps);
            for (int64_t f = frameBounds.first; f <= frameBounds.second; ++f) {
                if (!video.renderFrame(f, stageError)) { fail(stageError); return; }
                progress_.currentFrame.store(f + 1);
            }
        }

        // ── Advance ──────────────────────────────────────────────────────
        transport.advance(thisBufferSize);
        audioSamplesWritten += keepSamples;
        currentSample += thisBufferSize;
        ++iterationCount;

        publishProgress(progress_, audioSamplesWritten, totalSamples, sampleRate, renderStartTime);

        // Log every 100 buffers
        if (iterationCount % 100 == 0) {
            XLETH_RENDER_LOG(std::fprintf(stderr,
                         "[Renderer] PROGRESS: %.1f%% | frame %lld/%lld | "
                         "%.1fx realtime | ETA %.0fs\n",
                         progress_.percentage.load(),
                         (long long)progress_.currentFrame.load(),
                         (long long)totalVideoFrames,
                         progress_.speedMultiplier.load(),
                         progress_.etaSeconds.load()));
        }
    }

    // ── PHASE 2b: EFFECT TAIL (tailClamp) ─────────────────────────────────
    // Continue past captureEnd with the trigger ceiling still engaged: no new
    // notes/clips start, but the wet effect tail rings out. Video freezes the
    // last captured frame for the tail duration so the container's A/V lengths
    // stay equal. The master-bus peak is read here on the render (control) thread
    // — never on the audio thread, so no audio-thread allocation/lock/log.
    if (tailEnabled && !progress_.cancelRequested.load()) {
        xleth::TailDetectorState tailState;
        int64_t tailRendered = 0;
        const int64_t maxTail = tailPlan.maxTailSamples;
        const bool freezeVideo = tailPlan.freezeVideo && video.hasPicture();

        while (!tailState.done && tailRendered < maxTail) {
            if (progress_.cancelRequested.load()) break;

            const int thisBufferSize = static_cast<int>(
                std::min<int64_t>(kBufferSize, maxTail - tailRendered));

            if (audioBuffer.getNumSamples() != thisBufferSize)
                audioBuffer.setSize(2, thisBufferSize, false, false, true);
            audioBuffer.clear();

            mixer_.processBlock(audioBuffer, thisBufferSize, transport);

            const double blockPeak = std::max(mixer_.getMasterPeakL(),
                                              mixer_.getMasterPeakR());

            const float* audioChannels[2] = {
                audioBuffer.getReadPointer(0),
                audioBuffer.getReadPointer(1)
            };
            if (!muxer.writeAudio(audioChannels, thisBufferSize, audioSamplesWritten)) {
                fail("Audio encoding failed (tail)");
                return;
            }

            // Frozen video frames at audio-derived boundaries. Reuses the last
            // composited picture — NEVER samples new timeline video past endTick.
            if (freezeVideo) {
                const auto frameBounds = RenderClock::frameBoundsForBuffer(
                    audioSamplesWritten, thisBufferSize, sampleRate, fps);
                for (int64_t f = frameBounds.first; f <= frameBounds.second; ++f) {
                    if (!video.repeatLastFrame(f, stageError)) { fail(stageError); return; }
                    progress_.currentFrame.store(f + 1);
                }
            }

            transport.advance(thisBufferSize);
            audioSamplesWritten += thisBufferSize;
            tailRendered        += thisBufferSize;
            xleth::tailDetectorFeed(tailState, tailPlan, blockPeak, thisBufferSize);
        }

        std::fprintf(stderr,
            "[Renderer] TAIL: %lld samples (%.3fs) ended by %s, videoFreeze=%s\n",
            (long long)tailState.tailSamples,
            static_cast<double>(tailState.tailSamples) / sampleRate,
            tailState.endedByCap ? "cap" : "threshold",
            freezeVideo ? "yes" : "no");
    }

    // ── PHASE 3: FINALIZE ────────────────────────────────────────────────
    progress_.phase.store(3);
    std::fprintf(stderr, "[Renderer] FINALIZING: flushing encoders...\n");

    video.logSummary(encodeQueueDepth);

    if (!finishOutput(muxer, fragPath, settings.outputPath))
        return;

    // ── Complete ─────────────────────────────────────────────────────────
    const double totalSec = std::chrono::duration<double>(
        SteadyClock::now() - renderStartTime).count();
    const double renderedSec = static_cast<double>(totalSamples) / sampleRate;

    std::fprintf(stderr, "[Renderer] COMPLETE: %lld frames, %.2fs rendered in %.2fs (%.1fx realtime)\n",
                 (long long)progress_.currentFrame.load(),
                 renderedSec, totalSec,
                 totalSec > 0.0 ? renderedSec / totalSec : 0.0);

    progress_.percentage.store(100.0f);
    progress_.complete.store(true);

    // Shutdown video pipeline resources (the session guard restores the mixer)
    video.shutdown();
}

// ===========================================================================
// renderImplWrap — Phase 3B wrap (seamless loop tail-fold) A/V pipeline
// ===========================================================================
//
// Distinct from renderImpl because its AUDIO is produced differently; the video
// goes through the same ExportVideoStage. Two stages:
//   STAGE A (audio, no mux): strictly sequential via xleth::renderWrapCore — NO
//     looped-region pre-roll, NO backward seek. Warm up from tick 0 (RETAINED:
//     recreates in-flight timeline context, discarded), capture the region, render
//     the post-end tail, and FOLD the ENTIRE tail onto the region head
//     (output[i % regionLen] += tail[i]). The fold alone supplies the loop-seam
//     energy (a looped pre-roll would double-count it). Result: a folded region
//     buffer of EXACTLY the region length.
//   STAGE B (video + folded audio → mux): stream the folded region audio to the
//     muxer alongside the region's video frames. NO tail, NO freeze, NO video
//     fold — final A/V duration == region length.
//
void OfflineRenderer::renderImplWrap(int64_t startSample, int64_t endSample,
                                      int64_t warmUpStartSample,
                                      const ExportSettings& settings)
{
    // Mix rate — see renderImpl. All sample positions here are at this rate.
    const int sampleRate = settings.audioInputRate();
    const AVRational fps  = { settings.fpsNum, settings.fpsDen };
    const double bpm      = timeline_.getBPM();
    const xleth::TailRenderPlan tailPlan = tailPlan_;

    RenderSession session{ mixer_, progress_ };

    if (warmUpStartSample < 0)          warmUpStartSample = 0;
    if (warmUpStartSample > startSample) warmUpStartSample = startSample;

    const int regionLen = static_cast<int>(endSample - startSample);
    if (regionLen <= 0) {
        progress_.setError("Wrap render: empty region");
        progress_.failed.store(true);
        return;
    }
    const int64_t maxTail = std::max<int64_t>(0, tailPlan.maxTailSamples);

    std::fprintf(stderr,
        "[Renderer] WRAP mode: region=[%lld,%lld) regionLen=%d\n",
        (long long)startSample, (long long)endSample, regionLen);

    // ── PHASE 1: PRE-ROLL / audio capture+fold ───────────────────────────────
    progress_.phase.store(1);
    mixer_.setNonRealtime(true);
    mixer_.prepare(static_cast<double>(sampleRate), kBufferSize);
    mixer_.clearNoteTriggerCeiling();   // region pre-roll + capture trigger normally

    const auto lat = mixer_.getLatencyCompensationSnapshot();

    juce::AudioBuffer<float> regionAudio(2, regionLen);
    regionAudio.clear();

    {
        Transport transport;
        transport.setSampleRate(static_cast<double>(sampleRate));
        transport.setBPM(bpm);
        juce::AudioBuffer<float> block(2, kBufferSize);

        // STAGE A (3B-r1): single pre-roll plan = Phase-2 absolute warm-up
        // (warmUpStartSample → startSample, recreating in-flight content) + PDC
        // latency flush, all folded into discardSamples. NO looped-region pre-roll,
        // NO backward seek: the capture flows straight out of the warm-up and the
        // fold supplies the loop-seam energy. Track term = route-aware max path
        // latency (Prompt 2C; equals the flat per-track max when unrouted).
        const auto plan = xleth::computeRenderPrerollPlan(
            warmUpStartSample, startSample,
            lat.maxPathLatencySamples, lat.masterInsertLatencySamples);
        const int64_t renderStart    = plan.renderStartSample;
        const int64_t discardSamples = plan.discardSamples;

        transport.seekToSample(renderStart);
        transport.play();

#ifdef XLETH_DEBUG
        std::fprintf(stderr,
            "[RenderScope] wrap absWarmUp=[%lld,%lld) capture=[%lld,%lld) regionLen=%d "
            "tailThreshLin=%.6f tailCap=%lld loopedRegionPreRoll=no\n",
            (long long)renderStart, (long long)startSample,
            (long long)startSample, (long long)endSample, regionLen,
            tailPlan.thresholdLinear, (long long)maxTail);
#endif

        // Block-sized throwaway space for the warm-up discard + the post-end tail
        // working buffer. Allocated on the control/render thread, not audio thread.
        std::vector<float> scratchL(static_cast<size_t>(kBufferSize), 0.0f);
        std::vector<float> scratchR(static_cast<size_t>(kBufferSize), 0.0f);
        juce::AudioBuffer<float> tailBuf;
        float* tailL = nullptr;
        float* tailR = nullptr;
        if (maxTail > 0) {
            tailBuf.setSize(2, static_cast<int>(maxTail), false, true, false);
            tailBuf.clear();
            tailL = tailBuf.getWritePointer(0);
            tailR = tailBuf.getWritePointer(1);
        }

        auto renderBlock = [&](float* L, float* R, int n) {
            if (block.getNumSamples() != n) block.setSize(2, n, false, false, true);
            block.clear();
            mixer_.processBlock(block, n, transport);
            std::memcpy(L, block.getReadPointer(0), sizeof(float) * static_cast<size_t>(n));
            std::memcpy(R, block.getReadPointer(1), sizeof(float) * static_cast<size_t>(n));
            transport.advance(n);
        };
        auto masterPeak = [&]() {
            return std::max<double>(mixer_.getMasterPeakL(), mixer_.getMasterPeakR());
        };
        auto setCeiling = [&](int64_t s) {
            if (s == (std::numeric_limits<int64_t>::max)()) {
                mixer_.clearNoteTriggerCeiling();
                session.ceilingArmed = false;
            } else {
                mixer_.setNoteTriggerCeilingSample(s);
                session.ceilingArmed = true;
            }
        };
        auto shouldCancel = [&]() { return progress_.cancelRequested.load(); };
        auto onProgress = [&](float) {};

        const xleth::WrapRenderResult res = xleth::renderWrapCore(
            regionAudio.getWritePointer(0), regionAudio.getWritePointer(1), regionLen,
            discardSamples, endSample, tailPlan, kBufferSize,
            scratchL.data(), scratchR.data(),
            tailL, tailR, maxTail,
            renderBlock, masterPeak, setCeiling, shouldCancel, onProgress);

        transport.pause();

        if (res.cancelled) return;

        std::fprintf(stderr,
            "[TailFold] capture=[%lld,%lld) regionLen=%d detectedTail=%lld endedBy=%s "
            "foldedSamples=%d finalLen=%d videoExtended=no videoFrozen=no "
            "loopedRegionPreRoll=no\n",
            (long long)startSample, (long long)endSample, regionLen,
            (long long)res.tailSamples, res.endedByCap ? "cap" : "threshold",
            res.foldedSamples, regionLen);
    }

    // ── PHASE 2: video + folded audio → mux ──────────────────────────────────
    progress_.phase.store(2);

    const int64_t totalSamples = regionLen;
    const int64_t totalVideoFrames = RenderClock::frameCountForSamples(
        totalSamples, sampleRate, fps);
    progress_.totalFrames.store(totalVideoFrames);

    std::vector<SlideAnimationEvent> slideEvents;
    auto videoEvents = buildVideoEvents(timeline_, &slideEvents, sampleRate);

    // Resolution-aware render proxy plan (see renderImpl for the rationale).
    std::unordered_map<int, std::string> renderProxyPlan;
    const bool useProxyMode = !settings.useSourceMedia;
    if (useProxyMode) {
        progress_.phase.store(1);   // preroll (proxy generation)
        renderProxyPlan = buildRenderProxyPlan(videoEvents, settings);
        progress_.phase.store(2);
    }
    const std::unordered_map<int, std::string>* planPtr =
        useProxyMode ? &renderProxyPlan : nullptr;

    ExportSettings muxSettings = settings;
    const std::string fragPath = settings.outputPath + ".frag.mp4";
    muxSettings.outputPath = fragPath;
    muxSettings.fragmentedMP4 = true;

    FFmpegMuxer muxer;
    if (!muxer.init(muxSettings)) {
        progress_.setError("Failed to initialize video encoder");
        progress_.failed.store(true);
        return;
    }
    progress_.setVideoEncoderName(muxer.videoEncoderName());
    progress_.videoEncoderFallback.store(muxer.isVideoEncoderFallback());

    // Finding 6a — see renderImpl.
    const int encodeQueueDepth = exportEncodeQueueDepth();
    muxer.enableAsyncVideo(encodeQueueDepth);

    auto abandon = [&]() {
        muxer.finalize();
        std::error_code ec;
        std::filesystem::remove(fragPath, ec);
    };
    auto fail = [&](const std::string& message) {
        progress_.setError(message);
        progress_.failed.store(true);
        abandon();
    };

    ExportVideoStage video(timeline_, mixer_, gpu_, muxer, settings, sampleRate,
                           startSample, videoEvents, slideEvents, planPtr);
    std::string stageError;
    if (!video.init(stageError)) { fail(stageError); return; }

    const auto renderStartTime = SteadyClock::now();
    int64_t audioSamplesWritten = 0;

    while (audioSamplesWritten < totalSamples) {
        if (progress_.cancelRequested.load()) { abandon(); return; }

        const int thisBufferSize = static_cast<int>(
            std::min<int64_t>(kBufferSize, totalSamples - audioSamplesWritten));

        // Stream the pre-rendered folded region audio (NO live processBlock).
        const float* audioChannels[2] = {
            regionAudio.getReadPointer(0) + audioSamplesWritten,
            regionAudio.getReadPointer(1) + audioSamplesWritten
        };
        if (!muxer.writeAudio(audioChannels, thisBufferSize, audioSamplesWritten)) {
            fail("Audio encoding failed");
            return;
        }

        const auto frameBounds = RenderClock::frameBoundsForBuffer(
            audioSamplesWritten, thisBufferSize, sampleRate, fps);
        for (int64_t f = frameBounds.first; f <= frameBounds.second; ++f) {
            if (!video.renderFrame(f, stageError)) { fail(stageError); return; }
            progress_.currentFrame.store(f + 1);
        }

        audioSamplesWritten += thisBufferSize;
        publishProgress(progress_, audioSamplesWritten, totalSamples, sampleRate, renderStartTime);
    }

    // ── PHASE 3: FINALIZE ────────────────────────────────────────────────────
    progress_.phase.store(3);
    std::fprintf(stderr,
        "[Renderer] WRAP COMPLETE: regionLen=%d samples, video frames=%lld, "
        "no tail extension, no video freeze\n",
        regionLen, (long long)progress_.currentFrame.load());

    video.logSummary(encodeQueueDepth);

    if (!finishOutput(muxer, fragPath, settings.outputPath))
        return;

    progress_.percentage.store(100.0f);
    progress_.complete.store(true);

    video.shutdown();
}

// ===========================================================================
// remuxToFaststart — remux fragmented MP4 to standard MP4 with moov at front
// ===========================================================================

bool OfflineRenderer::remuxToFaststart(const std::string& fragPath,
                                        const std::string& outputPath)
{
    // Use FFmpeg C API to remux: open input, copy streams, write with faststart
    AVFormatContext* inCtx = nullptr;
    AVFormatContext* outCtx = nullptr;
    AVPacket* pkt = nullptr;
    bool ok = false;

    auto cleanup = [&]() {
        if (pkt) av_packet_free(&pkt);
        if (inCtx) avformat_close_input(&inCtx);
        if (outCtx) {
            if (outCtx->pb) avio_closep(&outCtx->pb);
            avformat_free_context(outCtx);
        }
    };

    // Open input
    int ret = avformat_open_input(&inCtx, fragPath.c_str(), nullptr, nullptr);
    if (ret < 0) { cleanup(); return false; }

    ret = avformat_find_stream_info(inCtx, nullptr);
    if (ret < 0) { cleanup(); return false; }

    // Allocate output
    ret = avformat_alloc_output_context2(&outCtx, nullptr, "mp4", outputPath.c_str());
    if (ret < 0 || !outCtx) { cleanup(); return false; }

    // Copy stream configurations
    for (unsigned i = 0; i < inCtx->nb_streams; ++i) {
        AVStream* inStream = inCtx->streams[i];
        AVStream* outStream = avformat_new_stream(outCtx, nullptr);
        if (!outStream) { cleanup(); return false; }
        ret = avcodec_parameters_copy(outStream->codecpar, inStream->codecpar);
        if (ret < 0) { cleanup(); return false; }
        outStream->time_base = inStream->time_base;
        outStream->codecpar->codec_tag = 0;
    }

    // Open output with faststart (movflags=+faststart)
    AVDictionary* opts = nullptr;
    av_dict_set(&opts, "movflags", "+faststart", 0);

    ret = avio_open(&outCtx->pb, outputPath.c_str(), AVIO_FLAG_WRITE);
    if (ret < 0) { av_dict_free(&opts); cleanup(); return false; }

    ret = avformat_write_header(outCtx, &opts);
    av_dict_free(&opts);
    if (ret < 0) { cleanup(); return false; }

    // Copy packets
    pkt = av_packet_alloc();
    if (!pkt) { cleanup(); return false; }

    while (av_read_frame(inCtx, pkt) >= 0) {
        AVStream* inStream  = inCtx->streams[pkt->stream_index];
        AVStream* outStream = outCtx->streams[pkt->stream_index];

        av_packet_rescale_ts(pkt, inStream->time_base, outStream->time_base);
        pkt->pos = -1;

        ret = av_interleaved_write_frame(outCtx, pkt);
        av_packet_unref(pkt);
        if (ret < 0) { cleanup(); return false; }
    }

    ret = av_write_trailer(outCtx);
    ok = (ret >= 0);

    cleanup();
    return ok;
}
