#include "render/OfflineRenderer.h"

#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "Transport.h"
#include "audio/MixEngine.h"
#include "render/GpuDeviceManager.h"
#include "render/RenderClock.h"
#include "render/RenderScope.h"
#include "render/FrameCache.h"
#include "render/FrameCollector.h"
#include "render/RenderVideoDecoder.h"
#include "render/GridCompositor.h"
#include "render/VisualFrameDiagnostics.h"  // opt-in pixel-content instrumentation
#include "render/CanvasFit.h"
#include "render/AnimationManager.h"
#include "export/FFmpegMuxer.h"
#include "SyncManager.h"          // VideoEvent
#include "render/ArpVideoExpander.h"
#include "render/VideoFlipApplier.h"  // single resolver call site

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
}

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <limits>
#include <vector>

// Buffer size: 512 samples = ~10.67ms at 48kHz. Fixed for consistent
// automation resolution and predictable video frame boundaries.
static constexpr int kBufferSize = 512;

namespace {

// Opt-in (XLETH_VISUAL_DIAG_PIXELS=1) content fingerprint of a composed export
// frame, taken immediately before it is handed to the encoder. `readback.pixels`
// is BGRA with row stride `readback.stride`. No-op when the flag is off.
// `encoderName`/dimensions are passed through only for the JSON sidecar context.
inline void recordExportPreEncode(const ReadbackBuffer& readback, long long frameIndex) {
    if (!xleth::visualdiag::pixelsEnabled()) return;
    auto stats = xleth::visualdiag::computeFrameStats(
        readback.pixels.data(), readback.width, readback.height, readback.stride,
        xleth::visualdiag::PixelFormat::BGRA, frameIndex);
    xleth::visualdiag::record("export-pre-encode", stats);
    xleth::visualdiag::maybeDumpFrame(
        "export-pre-encode", readback.pixels.data(), readback.width,
        readback.height, readback.stride, xleth::visualdiag::PixelFormat::BGRA, stats);
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

struct PatternNoteRef {
    const PatternNote* note = nullptr;
    int sourceOrder = 0;
};

bool patternNoteRefLess(const PatternNoteRef& a, const PatternNoteRef& b) {
    if (a.note->position.ticks != b.note->position.ticks)
        return a.note->position.ticks < b.note->position.ticks;

    const int orderA = a.note->id > 0 ? a.note->id : a.sourceOrder;
    const int orderB = b.note->id > 0 ? b.note->id : b.sourceOrder;
    if (orderA != orderB) return orderA < orderB;

    if (a.note->pitch != b.note->pitch) return a.note->pitch < b.note->pitch;
    return a.sourceOrder < b.sourceOrder;
}

std::vector<PatternNoteRef> sortedPatternNoteRefs(const Pattern& pattern) {
    std::vector<PatternNoteRef> refs;
    refs.reserve(pattern.notes.size());
    for (int i = 0; i < static_cast<int>(pattern.notes.size()); ++i)
        refs.push_back({&pattern.notes[static_cast<std::size_t>(i)], i});
    std::sort(refs.begin(), refs.end(), patternNoteRefLess);
    return refs;
}

int sourceOrderFor(const PatternNote& note, int fallbackOrder) {
    return note.id > 0 ? note.id : fallbackOrder;
}

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
    std::vector<VideoEvent> events;
    if (outSlideEvents) outSlideEvents->clear();
    const double bpm = timeline.getBPM();
    const double sampleRate = eventSampleRate > 0.0
        ? eventSampleRate
        : timeline.getSampleRate();

    // ── Clip tracks: each clip → one VideoEvent ──────────────────────────
    int noteCounterPerTrack_clip = 0;
    int lastTrackId_clip = -1;

    // Sort clips by track, then position, for stable globalNoteIndex
    auto allClips = timeline.getAllClips();
    std::sort(allClips.begin(), allClips.end(),
        [](const Clip* a, const Clip* b) {
            if (a->trackId != b->trackId) return a->trackId < b->trackId;
            return a->position < b->position;
        });

    for (const Clip* clip : allClips) {
        if (!clip) continue;

        const TrackInfo* track = timeline.getTrack(clip->trackId);
        if (!track) continue;

        // Find the region to get sourceId
        const SampleRegion* region = timeline.getRegion(clip->regionId);
        if (!region) continue;

        const SourceMedia* source = timeline.getSource(region->sourceId);
        if (!source || !source->hasVideo) continue;

        // Track-level note counter for flip mode cycling
        if (clip->trackId != lastTrackId_clip) {
            noteCounterPerTrack_clip = 0;
            lastTrackId_clip = clip->trackId;
        }

        VideoEvent ev;
        ev.startBeat      = clip->position.toBeats();
        ev.durationBeats   = clip->duration.toBeats();
        ev.sourceId        = region->sourceId;
        ev.trackId         = clip->trackId;
        ev.regionId        = clip->regionId;
        // regionOffset: how many beats into the source to start playback
        ev.sourceStartTime = clip->regionOffset.toBeats() * (60.0 / bpm) + region->startTime;
        ev.sourceEndTime   = region->endTime;
        ev.sourceClampStartTime = region->startTime;
        ev.clipId          = clip->id;
        ev.hasClipModulation = clip->modulation.enabled
            && (clip->modulation.vibrato.enabled || clip->modulation.scratch.enabled);
        ev.modulation = clip->modulation;
        ev.clipReversed = clip->reversed;
        ev.clipStretchRatio = clip->stretchRatio;
        ev.clipFormantPreserve = clip->formantPreserve;
        ev.clipPitchOffsetSemis = clip->pitchOffset;
        ev.clipPitchOffsetCents = clip->pitchOffsetCents;
        ev.clipStartTimelineSamples = static_cast<int64_t>(
            std::llround(ev.startBeat * 60.0 / bpm * sampleRate));
        ev.layerIndex      = 0;  // not used in grid compositor path
        ev.x               = track->videoX;
        ev.y               = track->videoY;
        ev.width           = track->videoW;
        ev.height          = track->videoH;
        ev.opacity         = track->videoOpacity * clip->velocity;
        const int clipEmissionOrder = noteCounterPerTrack_clip++;
        ev.globalNoteIndex = clipEmissionOrder;
        ev.hasSourceTriggerOrder = true;
        ev.sourceTriggerOrder = clip->id > 0 ? clip->id : clipEmissionOrder;
        ev.originalEmissionOrder = clipEmissionOrder;
        // Flip-v2: pitch identifier consumed by the resolver. Spec §1: clip
        // tracks use the clip's pitch-shift value (semitones from source).
        ev.pitch = clip->pitchOffset;

        events.push_back(ev);
    }

    // ── Pattern tracks: each note onset → one VideoEvent ─────────────────
    auto allBlocks = timeline.getAllPatternBlocks();
    std::sort(allBlocks.begin(), allBlocks.end(),
        [](const PatternBlock* a, const PatternBlock* b) {
            if (a->trackId != b->trackId) return a->trackId < b->trackId;
            return a->position < b->position;
        });

    int lastTrackId_pat = -1;
    int noteCounterPerTrack_pat = 0;

    for (const PatternBlock* block : allBlocks) {
        if (!block) continue;

        const Pattern* pattern = timeline.getPattern(block->patternId);
        if (!pattern) continue;

        const SampleRegion* region = timeline.getRegion(pattern->regionId);
        if (!region) continue;

        const SourceMedia* source = timeline.getSource(region->sourceId);
        if (!source || !source->hasVideo) continue;

        const TrackInfo* track = timeline.getTrack(block->trackId);
        if (!track) continue;

        if (block->trackId != lastTrackId_pat) {
            noteCounterPerTrack_pat = 0;
            lastTrackId_pat = block->trackId;
        }

        const double blockStartBeats = block->position.toBeats();
        const double blockDurBeats   = block->duration.toBeats();
        const double patLenBeats     = pattern->length.toBeats();
        if (patLenBeats <= 0.0) continue;

        if (region->arpEnabled) {
            // ── Arp expansion: simulate arpeggiator in beat-space ────────
            const int64_t bpTicks = block->position.ticks;
            const int64_t bdTicks = block->duration.ticks;
            const int64_t boTicks = block->offset.ticks;
            const int64_t wStart  = boTicks;
            const int64_t wEnd    = boTicks + bdTicks;
            const int64_t firstL  = wStart / pattern->length.ticks;
            int64_t       lastL   = (wEnd - 1) / pattern->length.ticks;
            if (!block->loopEnabled)
                lastL = std::min<int64_t>(lastL, 0);

            const auto noteRefs = sortedPatternNoteRefs(*pattern);
            std::vector<const PatternNote*> notesPtrs;
            notesPtrs.reserve(noteRefs.size());
            for (const auto& ref : noteRefs) notesPtrs.push_back(ref.note);

            auto arpEvts = ArpVideoExpander::expandArpVideoEvents(
                notesPtrs, bpTicks, bdTicks,
                pattern->length.ticks, block->loopEnabled,
                firstL, lastL, wStart, wEnd,
                region->arpTempoSync, region->arpDivision,
                region->arpFreeTimeMs, region->arpGate,
                region->arpRange, region->arpDirection,
                bpm, region->sourceId, block->trackId,
                pattern->regionId,
                region->startTime, region->endTime,
                noteCounterPerTrack_pat);

            for (auto& aev : arpEvts) {
                aev.x       = track->videoX;
                aev.y       = track->videoY;
                aev.width   = track->videoW;
                aev.height  = track->videoH;
                aev.opacity *= track->videoOpacity;
            }
            events.insert(events.end(), arpEvts.begin(), arpEvts.end());
        } else {
            // ── Standard per-note emission (unchanged) ───────────────────
            const auto noteRefs = sortedPatternNoteRefs(*pattern);
            for (const auto& noteRef : noteRefs) {
                const PatternNote& note = *noteRef.note;
                const double noteOffsetBeats = note.position.toBeats() - block->offset.toBeats();
                const double noteDurBeats    = note.duration.toBeats();

                // Handle looping: emit events for each loop iteration
                double loopOffset = 0.0;
                while (true) {
                    double evStartInBlock = noteOffsetBeats + loopOffset;
                    if (evStartInBlock >= blockDurBeats) break;
                    if (evStartInBlock < 0.0) {
                        loopOffset += patLenBeats;
                        continue;
                    }

                    double evDur = std::min(noteDurBeats, blockDurBeats - evStartInBlock);
                    if (evDur <= 0.0) { loopOffset += patLenBeats; continue; }

                    // Slide notes don't emit a VideoEvent — they fire a
                    // per-track visual effect on the existing cell.
                    if (note.isSlide) {
                        if (outSlideEvents) {
                            SlideAnimationEvent se;
                            se.startBeat     = blockStartBeats + evStartInBlock;
                            se.durationBeats = evDur;
                            se.trackId       = block->trackId;
                            se.slideVelocity = note.velocity;
                            se.slideCurveCx  = note.slideCurveCx;
                            se.slideCurveCy  = note.slideCurveCy;
                            outSlideEvents->push_back(se);
                        }
                        if (!block->loopEnabled) break;
                        loopOffset += patLenBeats;
                        continue;
                    }

                    VideoEvent ev;
                    ev.startBeat       = blockStartBeats + evStartInBlock;
                    ev.durationBeats   = evDur;
                    ev.sourceId        = region->sourceId;
                    ev.trackId         = block->trackId;
                    ev.regionId        = pattern->regionId;
                    ev.sourceStartTime = region->startTime;
                    ev.sourceEndTime   = region->endTime;
                    ev.sourceClampStartTime = region->startTime;
                    ev.layerIndex      = 0;
                    ev.x               = track->videoX;
                    ev.y               = track->videoY;
                    ev.width           = track->videoW;
                    ev.height          = track->videoH;
                    ev.opacity         = track->videoOpacity * note.velocity;
                    const int noteEmissionOrder = noteCounterPerTrack_pat++;
                    ev.globalNoteIndex = noteEmissionOrder;
                    ev.hasSourceTriggerOrder = true;
                    ev.sourceTriggerOrder = sourceOrderFor(note, noteRef.sourceOrder);
                    ev.originalEmissionOrder = noteEmissionOrder;
                    ev.pitch           = note.pitch;  // flip-v2 resolver input

                    events.push_back(ev);

                    if (!block->loopEnabled) break;
                    loopOffset += patLenBeats;
                }
            }
        }
    }

    // ── Flip-v2 resolution (single call site for all event-build paths) ──
    // Per-track chord detection + pure resolver + write-back of
    // monoOrdinal / stateIndex / orientation. No-op for tracks with
    // VideoFlipConfig.enabled = false.
    videoFlipApplier::applyAll(events, timeline);

    std::fprintf(stderr, "[Renderer] Built %d video events from timeline\n",
                 static_cast<int>(events.size()));
    return events;
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

void OfflineRenderer::renderImpl(int64_t startSample, int64_t endSample,
                                  int64_t warmUpStartSample,
                                  const ExportSettings& settings)
{
    // Phase 3B: wrap (seamless tail fold) is a distinct A/V pipeline (pre-rendered
    // folded audio + region-only video, no freeze). Branch before any Phase 3A
    // setup so that path stays byte-for-byte unchanged.
    if (tailPlan_.mode == xleth::TailRenderMode::Wrap) {
        renderImplWrap(startSample, endSample, warmUpStartSample, settings);
        return;
    }

    const int sampleRate = settings.sampleRate;
    const AVRational fps = { settings.fpsNum, settings.fpsDen };
    const double bpm = timeline_.getBPM();

    // Phase 3A tail policy (set via setTailRenderPlan before startRender).
    const xleth::TailRenderPlan tailPlan = tailPlan_;

    // RAII: the note-trigger ceiling (set just before the render loop) must be
    // cleared on EVERY exit path — error returns, cancel, exception unwind, or
    // normal completion — so it never leaks into realtime playback.
    struct CeilingGuard {
        MixEngine& m;
        bool armed = false;
        ~CeilingGuard() { if (armed) m.clearNoteTriggerCeiling(); }
    } ceilingGuard{ mixer_ };

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
    const int64_t totalVideoFrames = RenderClock::sampleToVideoFrame(
        totalSamples, sampleRate, fps);
    progress_.totalFrames.store(totalVideoFrames);

    // ── PHASE 1: PRE-ROLL ────────────────────────────────────────────────
    progress_.phase.store(1);

    // Prepare MixEngine with the export sample rate
    mixer_.setNonRealtime(true);
    mixer_.prepare(static_cast<double>(sampleRate), kBufferSize);
    std::fprintf(stderr, "[Renderer] prepareToPlay(sampleRate=%d, bufferSize=%d) done, nonRealtime=1\n",
                 sampleRate, kBufferSize);

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

    // ── Initialize pipeline components ───────────────────────────────────
    // Use fragmented MP4 for crash safety — remux to standard at the end
    ExportSettings muxSettings = settings;
    std::string fragPath = settings.outputPath + ".frag.mp4";
    muxSettings.outputPath = fragPath;
    muxSettings.fragmentedMP4 = true;

    // GPU device references are declared early so failure-path [VideoMode] logs can use them.
    auto* device = gpu_.getDevice();
    auto* devCtx = gpu_.getContext();

    using VM = ExportSettings::VideoMode;
    auto videoModeStr = [&]() -> const char* {
        switch (settings.videoMode) {
            case VM::Hardware: return "hardware";
            case VM::Software: return "software";
            default:           return "auto";
        }
    };

    FFmpegMuxer muxer;
    if (!muxer.init(muxSettings)) {
        // At this point the decoder has not been attempted yet; report what decode
        // would have been based on GPU availability.
        const char* wouldBeDec = (settings.videoMode != VM::Software && device && devCtx)
                                 ? "d3d11va" : "software";
        const char* reason = (settings.videoMode == VM::Hardware)
                             ? "hardware_encoder_unavailable" : "encoder_init_failed";
        std::fprintf(stderr,
            "[VideoMode] requested=%s decode=%s encode=none reason=%s\n",
            videoModeStr(), wouldBeDec, reason);

        progress_.setError(
            settings.videoMode == VM::Hardware
            ? "Hardware video mode selected, but no compatible hardware encoder could be "
              "opened. Switch Video mode to Auto or Software in Settings."
            : "Failed to initialize video encoder");
        progress_.failed.store(true);
        mixer_.setNonRealtime(false);
        progress_.phase.store(0);
        return;
    }
    // Surface encoder name and fallback flag to the UI
    progress_.setVideoEncoderName(muxer.videoEncoderName());
    progress_.videoEncoderFallback.store(muxer.isVideoEncoderFallback());

    // Frame cache + collector (no GPU thread binding needed for offline)
    RenderFrameCache cache;
    FrameCollector collector;
    AnimationManager animMgr;
    collector.setAnimationManager(&animMgr);
    collector.setCompanionFxEnabled(true);

    // Diagnostic counters for AMD/NVIDIA divergence: track frames where the GL
    // compositor produced no readback. A non-zero count means the export is
    // degraded — typically a sign of a GL upload/composite failure.
    int64_t videoFramesAttempted = 0;
    int64_t invalidReadbackCount = 0;

    // Video decoder — init path depends on VideoMode preference
    RenderVideoDecoder decoder;

    if (settings.videoMode == VM::Software) {
        // Intentionally skip initHwDevice — software decode/encode unconditionally.
        // Display compositing still uses OpenGL; this disables only HW video codecs.
    } else if (settings.videoMode == VM::Hardware) {
        if (!device || !devCtx || !decoder.initHwDevice(device, devCtx)) {
            // Encoder succeeded (muxer passed), but D3D11VA decode is unavailable.
            std::fprintf(stderr,
                "[VideoMode] requested=hardware decode=unavailable encode=%s reason=hardware_decode_init_failed\n",
                muxer.videoEncoderName());
            progress_.setError(
                "Hardware video mode selected, but D3D11VA hardware decode could not be "
                "initialized. Switch Video mode to Auto or Software in Settings.");
            progress_.failed.store(true);
            muxer.finalize();
            std::filesystem::remove(fragPath);
            mixer_.setNonRealtime(false);
            progress_.phase.store(0);
            return;
        }
    } else {  // Auto
        if (device && devCtx) {
            decoder.initHwDevice(device, devCtx);
        }
    }

    // [VideoMode] diagnostic log — resolved decode/encode path for this export
    {
        const char* decMode = decoder.hasHwAccel() ? "d3d11va" : "software";
        const char* encMode = muxer.videoEncoderName();
        const char* reason  = (settings.videoMode == VM::Hardware) ? "forced_hardware"
                            : (settings.videoMode == VM::Software) ? "user_setting"
                            : muxer.isVideoEncoderFallback()       ? "auto_fallback_no_hw_encoder"
                                                                    : "auto_detected";
        std::fprintf(stderr, "[VideoMode] requested=%s decode=%s encode=%s reason=%s\n",
                     videoModeStr(), decMode, encMode, reason);
    }

    // GPU compositor
    GridCompositor compositor;
    if (device && devCtx) {
        if (!compositor.init(device, devCtx, settings.width, settings.height)) {
            progress_.setError("Failed to initialize GPU compositor");
            progress_.failed.store(true);
            muxer.finalize();
            mixer_.setNonRealtime(false);
            progress_.phase.store(0);
            return;
        }
        applyCanvasFitToCompositor(compositor, timeline_.getGridLayout(), settings);
    }

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
    // ceilingGuard on every exit path.
    mixer_.setNoteTriggerCeilingSample(endSample);
    ceilingGuard.armed = true;

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

    // Last successfully-composited frame, retained so the tail can freeze it
    // (BGRA pixels + stride). Never samples new timeline video past endTick.
    std::vector<uint8_t> lastFramePixels;
    int  lastFrameStride = 0;
    bool haveLastFrame   = false;

    // Local transport for offline rendering (independent of realtime AudioEngine)
    Transport transport;
    transport.setSampleRate(static_cast<double>(sampleRate));
    transport.setBPM(bpm);
    transport.seekToSample(renderStart);
    transport.play();

    // Allocate audio buffer ONCE — reuse across iterations
    juce::AudioBuffer<float> audioBuffer(2, kBufferSize);
    juce::MidiBuffer emptyMidi;

    int64_t currentSample = renderStart;
    int64_t audioSamplesWritten = 0;
    int64_t samplesRemainingToDiscard = totalDiscard;
    int64_t lastVideoFrame = -1;
    int     iterationCount = 0;
    double  prevBeat = -1.0;  // for slide-event beat-crossing dispatch

    const auto renderStartTime = std::chrono::steady_clock::now();
    const GridLayout& grid = timeline_.getGridLayout();

    while (currentSample < renderEnd && audioSamplesWritten < totalSamples) {
        // ── Check cancel every buffer ────────────────────────────────────
        if (progress_.cancelRequested.load()) {
            std::fprintf(stderr, "[Renderer] CANCELLED at %.1f%% (sample %lld). "
                         "Finalizing partial file...\n",
                         progress_.percentage.load(), (long long)currentSample);
            muxer.finalize();
            // Clean up frag file
            std::filesystem::remove(fragPath);
            mixer_.setNonRealtime(false);
            progress_.phase.store(0);
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

        int keepOffset = discardThisBlock;
        int keepSamples = thisBufferSize - discardThisBlock;
        if (keepSamples > 0)
        {
            const int64_t samplesRemainingToWrite = totalSamples - audioSamplesWritten;
            keepSamples = static_cast<int>(
                std::min<int64_t>(keepSamples, samplesRemainingToWrite));
        }

        const float* audioChannels[2] = {
            audioBuffer.getReadPointer(0) + keepOffset,
            audioBuffer.getReadPointer(1) + keepOffset
        };
        if (keepSamples > 0
            && !muxer.writeAudio(audioChannels, keepSamples, audioSamplesWritten)) {
            progress_.setError("Audio encoding failed");
            progress_.failed.store(true);
            muxer.finalize();
            std::filesystem::remove(fragPath);
            mixer_.setNonRealtime(false);
            progress_.phase.store(0);
            return;
        }

        // ── Emit video frames at audio-derived boundaries ────────────────
        // Use audioSamplesWritten (0-based relative to export start) for
        // video frame calculation, so frame 0 aligns with sample 0 of output.
        int64_t firstFrame = 1;
        int64_t lastFrame = 0;
        if (keepSamples > 0)
        {
            const auto frameBounds = RenderClock::frameBoundsForBuffer(
                audioSamplesWritten, keepSamples, sampleRate, fps);
            firstFrame = frameBounds.first;
            lastFrame = frameBounds.second;
        }

        if (keepSamples > 0 && firstFrame <= lastFrame) {
            // Log every 30th frame
            if (iterationCount % 30 == 0) {
                std::fprintf(stderr, "[Renderer] Emit video frames %lld–%lld "
                             "for audio buffer at sample %lld\n",
                             (long long)firstFrame, (long long)lastFrame,
                             (long long)audioSamplesWritten);
            }

            for (int64_t f = firstFrame; f <= lastFrame; ++f) {
                // Advance animation state before collecting
                const float frameDurationMs = 1000.0f * static_cast<float>(fps.den)
                                            / static_cast<float>(fps.num);
                animMgr.advanceAll(frameDurationMs);
                const int64_t localFrameSample = RenderClock::videoFrameToSample(
                    f, sampleRate, fps);
                const int64_t projectFrameSample = startSample + localFrameSample;

                // ── Slide-note beat-crossing dispatch ───────────────────
                // Compute current beat from the absolute project frame sample and fire
                // any SlideAnimationEvents whose startBeat falls in the
                // (prevBeat, currentBeat] window. Reset on first iteration.
                {
                    const int64_t currentPpq = RenderClock::sampleToPPQ(
                        projectFrameSample, sampleRate, bpm);
                    const double ticksPerBeat = static_cast<double>(TickTime::fromBeats(1).ticks);
                    const double currentBeat = static_cast<double>(currentPpq) / ticksPerBeat;
                    if (prevBeat < 0.0 || currentBeat + 1e-6 < prevBeat)
                        prevBeat = currentBeat - 1e-6;
                    for (const auto& se : slideEvents) {
                        if (se.startBeat > prevBeat && se.startBeat <= currentBeat) {
                            const TrackInfo* tr = timeline_.getTrack(se.trackId);
                            if (!tr) continue;
                            const auto& cfg = tr->slideNoteEffect;
                            if (cfg.type == SlideNoteEffectSettings::EffectType::None)
                                continue;
                            double durationMs;
                            if (cfg.durationMode
                                == SlideNoteEffectSettings::DurationMode::FollowSlide) {
                                durationMs = se.durationBeats * (60000.0 / bpm);
                            } else {
                                durationMs = cfg.fixedDurationMs;
                            }
                            animMgr.onSlideEvent(
                                se.trackId,
                                static_cast<float>(durationMs),
                                cfg,
                                se.slideCurveCx, se.slideCurveCy);
                        }
                    }
                    prevBeat = currentBeat;
                }

                // Collect what each grid cell needs for this output frame.
                // Export honors settings.useSourceMedia so the encoder gets
                // original-source pixels by default; preview keeps proxy use.
                auto requests = collector.collectRequests(
                    f, timeline_, sampleRate, fps, videoEvents,
                    /*allowProxy=*/ !settings.useSourceMedia,
                    /*projectStartSample=*/ startSample);

                // Deduplicate: multiple cells may reference the same source frame
                auto deduplicated = FrameCollector::deduplicateRequests(requests);

                // Check cache and find what needs decoding
                auto misses = FrameCollector::resolveFrames(deduplicated, cache);

                // Decode cache misses
                if (device && devCtx) {
                    for (const auto& key : misses) {
                        auto entry = decoder.decode(key.sourcePath, key.frameIndex,
                                                    device, devCtx);
                        if (entry.texture) {
                            cache.put(key, std::move(entry));
                        }
                    }
                }

                // Composite
                if (compositor.isInitialized()) {
                    // Global shader time drives visual-state evaluation, so
                    // subrange exports must sample it in absolute project time
                    // even while encoded frame numbers stay local from zero.
                    const float currentTime = static_cast<float>(
                        RenderClock::sampleToSeconds(projectFrameSample, sampleRate));
                    compositor.compositeFrame(requests, cache,
                                              grid.columns, grid.rows,
                                              currentTime, grid.gapScale);

                    // Readback composited pixels from GPU
                    auto readback = compositor.readback();
                    ++videoFramesAttempted;
                    if (readback.valid) {
                        // Retain for tailClamp freeze-frame (true copy — readback
                        // is reused next iteration). Only when a tail is planned.
                        if (tailEnabled && tailPlan.freezeVideo) {
                            lastFramePixels = readback.pixels;
                            lastFrameStride = readback.stride;
                            haveLastFrame   = true;
                        }
                        recordExportPreEncode(readback, (long long)f);
                        if (!muxer.writeVideo(readback.pixels.data(),
                                              readback.stride, f)) {
                            progress_.setError("Video encoding failed at frame "
                                             + std::to_string(f));
                            progress_.failed.store(true);
                            muxer.finalize();
                            std::filesystem::remove(fragPath);
                            mixer_.setNonRealtime(false);
                            progress_.phase.store(0);
                            return;
                        }
                    } else {
                        ++invalidReadbackCount;
                        if (invalidReadbackCount <= 5 || (invalidReadbackCount % 100) == 0) {
                            std::fprintf(stderr,
                                         "[Renderer] Compositor readback invalid at frame %lld "
                                         "(total invalid=%lld)\n",
                                         (long long)f, (long long)invalidReadbackCount);
                        }
                        // Early abort: if every readback so far has been invalid, the D3D11
                        // compositor is failing at the GPU/staging-texture level — fail fast
                        // rather than silently write a video file with zero frames.
                        //
                        // readback.valid==false means D3D11 staging texture Map() failed
                        // (a GPU/driver error), NOT empty/transparent content. An empty or
                        // transparent composite still produces valid black BGRA pixels, so
                        // this check cannot false-fire on empty-timeline exports.
                        constexpr int64_t kEarlyAbortThreshold = 10;
                        if (videoFramesAttempted >= kEarlyAbortThreshold &&
                            invalidReadbackCount == videoFramesAttempted) {
                            progress_.setError(
                                "Compositor readback failed for the first "
                                + std::to_string(kEarlyAbortThreshold)
                                + " video frames (D3D11 staging Map failed). "
                                "Check engine log for GPU/driver errors.");
                            progress_.failed.store(true);
                            muxer.finalize();
                            std::filesystem::remove(fragPath);
                            mixer_.setNonRealtime(false);
                            progress_.phase.store(0);
                            return;
                        }
                    }
                }

                progress_.currentFrame.store(f);
            }

            lastVideoFrame = lastFrame;
        }

        // ── Advance ──────────────────────────────────────────────────────
        transport.advance(thisBufferSize);
        audioSamplesWritten += keepSamples;
        currentSample += thisBufferSize;
        ++iterationCount;

        // ── Update progress ──────────────────────────────────────────────
        const float pct = static_cast<float>(audioSamplesWritten)
                        / static_cast<float>(totalSamples) * 100.0f;
        progress_.percentage.store(pct);

        const auto elapsed = std::chrono::steady_clock::now() - renderStartTime;
        const double elapsedSec = std::chrono::duration<double>(elapsed).count();
        if (elapsedSec > 0.01) {
            const double renderedSec = static_cast<double>(audioSamplesWritten) / sampleRate;
            const float speed = static_cast<float>(renderedSec / elapsedSec);
            progress_.speedMultiplier.store(speed);
            if (speed > 0.0f) {
                const double remainingSec = static_cast<double>(totalSamples - audioSamplesWritten) / sampleRate;
                progress_.etaSeconds.store(static_cast<float>(remainingSec / speed));
            }
        }

        // Log every 100 buffers
        if (iterationCount % 100 == 0) {
            std::fprintf(stderr, "[Renderer] PROGRESS: %.1f%% | frame %lld/%lld | "
                         "%.1fx realtime | ETA %.0fs\n",
                         pct,
                         (long long)progress_.currentFrame.load(),
                         (long long)totalVideoFrames,
                         progress_.speedMultiplier.load(),
                         progress_.etaSeconds.load());
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
                progress_.setError("Audio encoding failed (tail)");
                progress_.failed.store(true);
                muxer.finalize();
                std::filesystem::remove(fragPath);
                mixer_.setNonRealtime(false);
                progress_.phase.store(0);
                return;
            }

            // Frozen video frames at audio-derived boundaries. Reuses the last
            // composited pixels — NEVER samples new timeline video past endTick.
            if (haveLastFrame) {
                const auto frameBounds = RenderClock::frameBoundsForBuffer(
                    audioSamplesWritten, thisBufferSize, sampleRate, fps);
                for (int64_t f = frameBounds.first; f <= frameBounds.second; ++f) {
                    if (!muxer.writeVideo(lastFramePixels.data(), lastFrameStride, f)) {
                        progress_.setError("Video encoding failed (tail) at frame "
                                         + std::to_string(f));
                        progress_.failed.store(true);
                        muxer.finalize();
                        std::filesystem::remove(fragPath);
                        mixer_.setNonRealtime(false);
                        progress_.phase.store(0);
                        return;
                    }
                    progress_.currentFrame.store(f);
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
            haveLastFrame ? "yes" : "no");
    }

    // ── PHASE 3: FINALIZE ────────────────────────────────────────────────
    progress_.phase.store(3);
    std::fprintf(stderr, "[Renderer] FINALIZING: flushing encoders...\n");

    if (videoFramesAttempted > 0) {
        const double invalidPct = 100.0 * static_cast<double>(invalidReadbackCount)
                                        / static_cast<double>(videoFramesAttempted);
        std::fprintf(stderr,
                     "[Renderer] Video frames: attempted=%lld, invalid_readback=%lld (%.1f%%)\n",
                     (long long)videoFramesAttempted,
                     (long long)invalidReadbackCount,
                     invalidPct);
        if (invalidReadbackCount > 0) {
            std::fprintf(stderr,
                         "[Renderer] WARN: export degraded — %lld of %lld frames had invalid GPU readback "
                         "(compositor produced no pixels). Check earlier log for [VideoCompositor] errors.\n",
                         (long long)invalidReadbackCount,
                         (long long)videoFramesAttempted);
        }
    }

    if (!muxer.finalize()) {
        progress_.setError("Muxer finalization failed");
        progress_.failed.store(true);
        std::filesystem::remove(fragPath);
        mixer_.setNonRealtime(false);
        progress_.phase.store(0);
        return;
    }

    // ── Remux fragmented MP4 → standard MP4 with faststart ───────────────
    if (!progress_.cancelRequested.load()) {
        std::fprintf(stderr, "[Renderer] Remuxing frag MP4 → standard MP4 with faststart...\n");

        if (!remuxToFaststart(fragPath, settings.outputPath)) {
            // Remux failed — fall back: just rename frag file as output
            std::fprintf(stderr, "[Renderer] Remux failed, using fragmented file directly\n");
            std::error_code ec;
            std::filesystem::rename(fragPath, settings.outputPath, ec);
        } else {
            // Remove the temporary fragmented file
            std::filesystem::remove(fragPath);
        }

        // Report final file info
        std::error_code ec;
        auto fileSize = std::filesystem::file_size(settings.outputPath, ec);
        if (!ec) {
            std::fprintf(stderr, "[Renderer] Remux complete. File: '%s' size=%lld bytes\n",
                         settings.outputPath.c_str(), (long long)fileSize);
        }
    } else {
        // Cancelled during finalize — clean up
        std::filesystem::remove(fragPath);
    }

    // ── Complete ─────────────────────────────────────────────────────────
    const auto totalElapsed = std::chrono::steady_clock::now() - renderStartTime;
    const double totalSec = std::chrono::duration<double>(totalElapsed).count();
    const double renderedSec = static_cast<double>(totalSamples) / sampleRate;

    std::fprintf(stderr, "[Renderer] COMPLETE: %lld frames, %.2fs rendered in %.2fs (%.1fx realtime)\n",
                 (long long)progress_.currentFrame.load(),
                 renderedSec, totalSec,
                 totalSec > 0.0 ? renderedSec / totalSec : 0.0);

    progress_.percentage.store(100.0f);
    progress_.complete.store(true);
    progress_.phase.store(0);

    // Restore realtime lock mode for the audio thread
    mixer_.setNonRealtime(false);

    // Shutdown video pipeline resources
    compositor.shutdown();
    decoder.closeAll();
    cache.clear();
}

// ===========================================================================
// renderImplWrap — Phase 3B wrap (seamless loop tail-fold) A/V pipeline
// ===========================================================================
//
// Distinct from renderImpl so the Phase 3A path is untouched. Two stages:
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
    const int sampleRate = settings.sampleRate;
    const AVRational fps  = { settings.fpsNum, settings.fpsDen };
    const double bpm      = timeline_.getBPM();
    const xleth::TailRenderPlan tailPlan = tailPlan_;

    if (warmUpStartSample < 0)          warmUpStartSample = 0;
    if (warmUpStartSample > startSample) warmUpStartSample = startSample;

    const int regionLen = static_cast<int>(endSample - startSample);
    if (regionLen <= 0) {
        progress_.setError("Wrap render: empty region");
        progress_.failed.store(true);
        progress_.phase.store(0);
        return;
    }
    const int64_t maxTail = std::max<int64_t>(0, tailPlan.maxTailSamples);

    // RAII: the note-trigger ceiling must be cleared on every exit path.
    struct CeilingGuard {
        MixEngine& m; bool armed = false;
        ~CeilingGuard() { if (armed) m.clearNoteTriggerCeiling(); }
    } ceilingGuard{ mixer_ };

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
                ceilingGuard.armed = false;
            } else {
                mixer_.setNoteTriggerCeilingSample(s);
                ceilingGuard.armed = true;
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

        if (res.cancelled) {
            mixer_.setNonRealtime(false); progress_.phase.store(0); return;
        }

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
    const int64_t totalVideoFrames = RenderClock::sampleToVideoFrame(totalSamples, sampleRate, fps);
    progress_.totalFrames.store(totalVideoFrames);

    std::vector<SlideAnimationEvent> slideEvents;
    auto videoEvents = buildVideoEvents(timeline_, &slideEvents, sampleRate);

    ExportSettings muxSettings = settings;
    std::string fragPath = settings.outputPath + ".frag.mp4";
    muxSettings.outputPath = fragPath;
    muxSettings.fragmentedMP4 = true;

    auto* device = gpu_.getDevice();
    auto* devCtx = gpu_.getContext();

    FFmpegMuxer muxer;
    if (!muxer.init(muxSettings)) {
        progress_.setError("Failed to initialize video encoder");
        progress_.failed.store(true);
        mixer_.setNonRealtime(false);
        progress_.phase.store(0);
        return;
    }
    progress_.setVideoEncoderName(muxer.videoEncoderName());
    progress_.videoEncoderFallback.store(muxer.isVideoEncoderFallback());

    RenderFrameCache cache;
    FrameCollector collector;
    AnimationManager animMgr;
    collector.setAnimationManager(&animMgr);
    collector.setCompanionFxEnabled(true);

    int64_t videoFramesAttempted = 0;
    int64_t invalidReadbackCount = 0;

    RenderVideoDecoder decoder;
    using VM = ExportSettings::VideoMode;
    if (settings.videoMode == VM::Software) {
        // software decode only
    } else if (settings.videoMode == VM::Hardware) {
        if (!device || !devCtx || !decoder.initHwDevice(device, devCtx)) {
            progress_.setError(
                "Hardware video mode selected, but D3D11VA hardware decode could not be "
                "initialized. Switch Video mode to Auto or Software in Settings.");
            progress_.failed.store(true);
            muxer.finalize();
            std::filesystem::remove(fragPath);
            mixer_.setNonRealtime(false);
            progress_.phase.store(0);
            return;
        }
    } else {
        if (device && devCtx) decoder.initHwDevice(device, devCtx);
    }

    GridCompositor compositor;
    if (device && devCtx) {
        if (!compositor.init(device, devCtx, settings.width, settings.height)) {
            progress_.setError("Failed to initialize GPU compositor");
            progress_.failed.store(true);
            muxer.finalize();
            std::filesystem::remove(fragPath);
            mixer_.setNonRealtime(false);
            progress_.phase.store(0);
            return;
        }
    }

    const GridLayout& grid = timeline_.getGridLayout();
    if (compositor.isInitialized())
        applyCanvasFitToCompositor(compositor, grid, settings);
    const auto renderStartTime = std::chrono::steady_clock::now();

    int64_t audioSamplesWritten = 0;
    int     iterationCount = 0;
    double  prevBeat = -1.0;

    while (audioSamplesWritten < totalSamples) {
        if (progress_.cancelRequested.load()) {
            muxer.finalize();
            std::filesystem::remove(fragPath);
            mixer_.setNonRealtime(false);
            progress_.phase.store(0);
            return;
        }

        const int thisBufferSize = static_cast<int>(
            std::min<int64_t>(kBufferSize, totalSamples - audioSamplesWritten));

        // Stream the pre-rendered folded region audio (NO live processBlock).
        const float* audioChannels[2] = {
            regionAudio.getReadPointer(0) + audioSamplesWritten,
            regionAudio.getReadPointer(1) + audioSamplesWritten
        };
        if (!muxer.writeAudio(audioChannels, thisBufferSize, audioSamplesWritten)) {
            progress_.setError("Audio encoding failed");
            progress_.failed.store(true);
            muxer.finalize();
            std::filesystem::remove(fragPath);
            mixer_.setNonRealtime(false);
            progress_.phase.store(0);
            return;
        }

        const auto frameBounds = RenderClock::frameBoundsForBuffer(
            audioSamplesWritten, thisBufferSize, sampleRate, fps);
        const int64_t firstFrame = frameBounds.first;
        const int64_t lastFrame  = frameBounds.second;

        if (firstFrame <= lastFrame) {
            for (int64_t f = firstFrame; f <= lastFrame; ++f) {
                const float frameDurationMs = 1000.0f * static_cast<float>(fps.den)
                                            / static_cast<float>(fps.num);
                animMgr.advanceAll(frameDurationMs);
                const int64_t localFrameSample = RenderClock::videoFrameToSample(f, sampleRate, fps);
                const int64_t projectFrameSample = startSample + localFrameSample;

                {
                    const int64_t currentPpq = RenderClock::sampleToPPQ(
                        projectFrameSample, sampleRate, bpm);
                    const double ticksPerBeat = static_cast<double>(TickTime::fromBeats(1).ticks);
                    const double currentBeat = static_cast<double>(currentPpq) / ticksPerBeat;
                    if (prevBeat < 0.0 || currentBeat + 1e-6 < prevBeat)
                        prevBeat = currentBeat - 1e-6;
                    for (const auto& se : slideEvents) {
                        if (se.startBeat > prevBeat && se.startBeat <= currentBeat) {
                            const TrackInfo* tr = timeline_.getTrack(se.trackId);
                            if (!tr) continue;
                            const auto& cfg = tr->slideNoteEffect;
                            if (cfg.type == SlideNoteEffectSettings::EffectType::None) continue;
                            double durationMs;
                            if (cfg.durationMode == SlideNoteEffectSettings::DurationMode::FollowSlide)
                                durationMs = se.durationBeats * (60000.0 / bpm);
                            else
                                durationMs = cfg.fixedDurationMs;
                            animMgr.onSlideEvent(se.trackId, static_cast<float>(durationMs),
                                                 cfg, se.slideCurveCx, se.slideCurveCy);
                        }
                    }
                    prevBeat = currentBeat;
                }

                auto requests = collector.collectRequests(
                    f, timeline_, sampleRate, fps, videoEvents,
                    /*allowProxy=*/ !settings.useSourceMedia,
                    /*projectStartSample=*/ startSample);
                auto deduplicated = FrameCollector::deduplicateRequests(requests);
                auto misses = FrameCollector::resolveFrames(deduplicated, cache);

                if (device && devCtx) {
                    for (const auto& key : misses) {
                        auto entry = decoder.decode(key.sourcePath, key.frameIndex, device, devCtx);
                        if (entry.texture) cache.put(key, std::move(entry));
                    }
                }

                if (compositor.isInitialized()) {
                    const float currentTime = static_cast<float>(
                        RenderClock::sampleToSeconds(projectFrameSample, sampleRate));
                    compositor.compositeFrame(requests, cache, grid.columns, grid.rows,
                                              currentTime, grid.gapScale);
                    auto readback = compositor.readback();
                    ++videoFramesAttempted;
                    if (readback.valid) {
                        recordExportPreEncode(readback, (long long)f);
                        if (!muxer.writeVideo(readback.pixels.data(), readback.stride, f)) {
                            progress_.setError("Video encoding failed at frame " + std::to_string(f));
                            progress_.failed.store(true);
                            muxer.finalize();
                            std::filesystem::remove(fragPath);
                            mixer_.setNonRealtime(false);
                            progress_.phase.store(0);
                            return;
                        }
                    } else {
                        ++invalidReadbackCount;
                        constexpr int64_t kEarlyAbortThreshold = 10;
                        if (videoFramesAttempted >= kEarlyAbortThreshold &&
                            invalidReadbackCount == videoFramesAttempted) {
                            progress_.setError(
                                "Compositor readback failed for the first "
                                + std::to_string(kEarlyAbortThreshold)
                                + " video frames (D3D11 staging Map failed).");
                            progress_.failed.store(true);
                            muxer.finalize();
                            std::filesystem::remove(fragPath);
                            mixer_.setNonRealtime(false);
                            progress_.phase.store(0);
                            return;
                        }
                    }
                }
                progress_.currentFrame.store(f);
            }
        }

        audioSamplesWritten += thisBufferSize;
        ++iterationCount;

        const float pct = static_cast<float>(audioSamplesWritten)
                        / static_cast<float>(totalSamples) * 100.0f;
        progress_.percentage.store(pct);
        const auto elapsed = std::chrono::steady_clock::now() - renderStartTime;
        const double elapsedSec = std::chrono::duration<double>(elapsed).count();
        if (elapsedSec > 0.01) {
            const double renderedSec = static_cast<double>(audioSamplesWritten) / sampleRate;
            const float speed = static_cast<float>(renderedSec / elapsedSec);
            progress_.speedMultiplier.store(speed);
        }
    }

    // ── PHASE 3: FINALIZE ────────────────────────────────────────────────────
    progress_.phase.store(3);
    std::fprintf(stderr,
        "[Renderer] WRAP COMPLETE: regionLen=%d samples, video frames=%lld, "
        "no tail extension, no video freeze\n",
        regionLen, (long long)progress_.currentFrame.load());

    if (!muxer.finalize()) {
        progress_.setError("Muxer finalization failed");
        progress_.failed.store(true);
        std::filesystem::remove(fragPath);
        mixer_.setNonRealtime(false);
        progress_.phase.store(0);
        return;
    }

    if (!progress_.cancelRequested.load()) {
        if (!remuxToFaststart(fragPath, settings.outputPath)) {
            std::error_code ec;
            std::filesystem::rename(fragPath, settings.outputPath, ec);
        } else {
            std::filesystem::remove(fragPath);
        }
    } else {
        std::filesystem::remove(fragPath);
    }

    progress_.percentage.store(100.0f);
    progress_.complete.store(true);
    progress_.phase.store(0);
    mixer_.setNonRealtime(false);

    compositor.shutdown();
    decoder.closeAll();
    cache.clear();
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
