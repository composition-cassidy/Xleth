#include "FrameCollector.h"
#include "AnimationManager.h"
#include "XlethDebug.h"
#include "FrameRateMath.h"

#include "audio/ClipFade.h"
#include "model/Timeline.h"
#include "model/ClipVideoModulationTiming.h"
#include "model/ClipCompanionFxBuilder.h"
#include "model/ClipModulationCompatibility.h"
#include "model/NoteFade.h"
#include "model/SmartHold.h"
#include "SyncManager.h"     // VideoEvent
#include "render/VisualEchoTypes.h"
#include "render/LensRoamMath.h"   // roamDrawKey (draw order), shared with GridCompositor

#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <unordered_set>

namespace {

// A request at or below this resolved opacity is provably invisible — no
// blend of pixels at this alpha can be distinguished from fully transparent
// once quantized to an 8-bit output. Never compare opacity to exact 0.0f:
// fadeGain is floating point and a fade curve can land arbitrarily close to
// (but not exactly at) zero without ever reaching it.
constexpr float kOpacityCullEpsilon = 1e-4f;

// ── Motion blur: Lens / Sweep / Roam sub-frame samples ──────────────────────
// Both are pure functions of the tick (LensRoamSnapshot is stateless), so a
// sub-frame instant is just another tick. `lensAt(tick)` resolves the request's
// Lens (+ Sweep) at a tick exactly as the frame-time value was resolved.
// Cheap rejection first: when neither end of the shutter differs from the
// frame-time value the stage is treated as still and costs nothing more (a
// move that leaves AND returns inside one shutter is below what blur shows).
// Motion view: a still child of a MOVING parent is sampled too (its on-screen
// pose moves), so its Roam samples are taken whenever req.parent has motion
// samples (resolveParentChain runs first). With no parent motion the gate is
// exactly what it was.
template <typename LensAt>
void sampleLensRoamMotion(CellFrameRequest& req, const LensRoamSnapshot& lr, int trackId,
                          double frameTick, double shutterTicks, LensAt&& lensAt)
{
    using namespace motionblur;
    constexpr int n = kDenseSamples;
    auto tickAt = [&](int i) { return frameTick + sampleOffset(i, n) * shutterTicks; };

    const LensParams lensFirst = lensAt(tickAt(0));
    const LensParams lensLast  = lensAt(tickAt(n - 1));
    if (lensMoved(lensFirst, req.lens) || lensMoved(lensLast, req.lens)) {
        req.lensMotion[0]     = lensFirst;
        req.lensMotion[n - 1] = lensLast;
        for (int i = 1; i < n - 1; ++i) req.lensMotion[i] = lensAt(tickAt(i));
        req.lensMotionCount = n;
    }

    const RoamParams roamFirst = lr.roamAt(trackId, tickAt(0));
    const RoamParams roamLast  = lr.roamAt(trackId, tickAt(n - 1));
    if (req.parent.motionCount > 0
        || roamMoved(roamFirst, req.roam) || roamMoved(roamLast, req.roam)) {
        req.roamMotion[0]     = roamFirst;
        req.roamMotion[n - 1] = roamLast;
        for (int i = 1; i < n - 1; ++i) req.roamMotion[i] = lr.roamAt(trackId, tickAt(i));
        req.roamMotionCount = n;
    }
}

// ── Motion view: Parent chain (docs/XLETH_MOTION_VIEW_DESIGN.md R7, 3.4) ────
// The arrangement of the FULL layout at the frame tick, read in place: the
// collector's own layout when it was not handed an override, else the
// timeline's snapshot at the tick (Timeline::gridSnapshotAt), never a copy.
struct ArrangementView {
    int   columns  = 0;
    int   rows     = 0;
    float gapScale = 0.0f;
    const std::vector<GridSlot>*        slots            = nullptr;
    const std::vector<FullscreenLayer>* fullscreenLayers = nullptr;
};

// Fills req.parent for `trackId`: its ancestors nearest first (the snapshot's
// bounded, cycle-safe parentChain), each one's placement in the full layout
// (the FIRST grid slot in slot order, else its fullscreen layer, else not
// placed = identity) and its Roam at the frame tick; plus, when the shutter is
// open and any placed ancestor moves inside it, every ancestor's Roam at the
// dense sub-frame ticks the child's own Roam is sampled at. Binary searches
// and a scan of the layout's slots: no allocation, lock or log.
void resolveParentChain(CellFrameRequest& req, const LensRoamSnapshot& lr,
                        const Timeline& timeline, const ArrangementView& full,
                        int trackId, double frameTick, double shutterTicks)
{
    using namespace motionblur;
    constexpr int kDepth = motionschema::kMaxParentDepth;
    int ids[kDepth];
    const int depth = lr.parentChain(trackId, ids);
    ParentChain& pc = req.parent;
    pc.depth       = depth;
    pc.motionCount = 0;
    if (depth == 0) return;
    pc.gridCols = full.columns;
    pc.gridRows = full.rows;
    pc.gapScale = full.gapScale;

    for (int k = 0; k < depth; ++k) {
        ParentAncestor& a = pc.ancestors[k];
        a = ParentAncestor{};
        a.trackId = ids[k];
        if (full.slots) {
            for (const GridSlot& s : *full.slots) {
                if (s.trackId != a.trackId) continue;
                a.placed  = true;
                a.cellCol = s.gridX;  a.cellRow = s.gridY;
                a.spanX   = s.spanX;  a.spanY   = s.spanY;
                break;
            }
        }
        if (!a.placed && full.fullscreenLayers) {
            for (const FullscreenLayer& f : *full.fullscreenLayers) {
                if (f.trackId != a.trackId) continue;
                a.placed     = true;
                a.fullscreen = true;
                break;
            }
        }
        if (const TrackInfo* t = timeline.getTrack(a.trackId))
            a.gapScaleOverride = t->gapScaleOverride;
        a.roam = lr.roamAt(a.trackId, frameTick);
    }

    if (!(shutterTicks > 0.0)) return;
    constexpr int n = kDenseSamples;
    auto tickAt = [&](int i) { return frameTick + sampleOffset(i, n) * shutterTicks; };
    bool moving = false;
    for (int k = 0; k < depth && !moving; ++k) {
        const ParentAncestor& a = pc.ancestors[k];
        if (!a.placed) continue;                       // contributes identity either way
        moving = roamMoved(lr.roamAt(a.trackId, tickAt(0)), a.roam)
              || roamMoved(lr.roamAt(a.trackId, tickAt(n - 1)), a.roam);
    }
    if (!moving) return;
    for (int i = 0; i < n; ++i) {
        const double tick = tickAt(i);
        for (int k = 0; k < depth; ++k)
            pc.motion[i][k] = lr.roamAt(pc.ancestors[k].trackId, tick);
    }
    pc.motionCount = n;
}

bool isVideoModulationCompatible(const VideoEvent& event) noexcept
{
    return event.hasClipModulation
        && xleth::clipmod::isClipModulationCompatible(
               event.clipReversed,
               event.clipStretchRatio,
               event.clipFormantPreserve,
               event.modulation);
}

float videoEventFadeGain(const VideoEvent& event, double beatPos) noexcept
{
    if (!(event.durationBeats > 0.0) || !std::isfinite(event.durationBeats))
        return 1.0f;
    const float progress = static_cast<float>(
        (beatPos - event.startBeat) / event.durationBeats);
    return evaluateClipFadeGain(
        progress,
        event.fadeInPercent, event.fadeOutPercent,
        event.fadeInX1, event.fadeInY1, event.fadeInX2, event.fadeInY2,
        event.fadeOutX1, event.fadeOutY1, event.fadeOutX2, event.fadeOutY2);
}

// Pattern-track automatic per-note fade (TrackInfo::noteFade).
//
// This is the ONE place the feature is applied. Preview (XlethEngineService's
// video tick), export (OfflineRenderer) and the snapshot-transition renderer all
// reach the compositor through collectRequests, so hooking the opacity here
// gives all three identical output with no second implementation to keep in
// sync — the same reason the user-authored clip fade above lives here.
//
// Gated on Type::Pattern: a Clip track's events are clips, whose fade envelope
// is hand-authored per clip and already evaluated by videoEventFadeGain.
//
// Returns a MULTIPLIER, composed with (not substituted for) the event's own
// fade. On a Pattern track the event fade is always identity — only clip-track
// events populate VideoEvent::fadeInPercent / fadeOutPercent — so today the
// product is the note fade alone; composing rather than replacing means a path
// that ever sets both cannot silently drop one.
float trackNoteFadeGain(const VideoEvent& event, const TrackInfo* trk,
                        double beatPos, double bpm) noexcept
{
    if (!trk || trk->type != TrackInfo::Type::Pattern || !trk->noteFade.enabled)
        return 1.0f;
    if (!(event.durationBeats > 0.0) || !std::isfinite(event.durationBeats))
        return 1.0f;

    // A pattern note's VideoEvent spans exactly the note, so progress through
    // the event IS progress through the note.
    const float progress = static_cast<float>(
        (beatPos - event.startBeat) / event.durationBeats);
    return xleth::notefade::gain(trk->noteFade, progress, event.durationBeats, bpm);
}

// Whether this note actually ends on a fade-out, for the fullscreen-behind
// hold-through-gap suppression below. Without it, a Pattern track used as a
// fullscreen backdrop with hold-last-frame on would fade a note out and then
// snap straight back to full opacity the instant the note ended.
bool trackNoteFadeHasFadeOut(const VideoEvent& event, const TrackInfo* trk,
                             double bpm) noexcept
{
    return trk && trk->type == TrackInfo::Type::Pattern
        && xleth::notefade::hasFadeOut(trk->noteFade, event.durationBeats, bpm);
}

// ── Visual Echo ─────────────────────────────────────────────────────────────
//
// Resolve the track's VisualEcho entry (if any) against the bound Delay FX's
// PUBLISHED repeat interval. This is the single graft point where the audio
// side's timing becomes video-side geometry, and it is deliberately the only
// place in the render path that touches xleth::echo at all besides the
// compositor stage that consumes the result.
//
// Note what is NOT here: no BPM, no beat division, no sync-mode branch. The
// Delay resolved all of that before publishing `delaySamples`; this function
// only converts samples to output frames, which is a unit change. If that
// distinction ever blurs, preview and export stop agreeing the moment one of
// them is driven at a different tempo than the other.
//
// A chain may legally contain more than one VisualEcho (nothing forbids it, and
// addVisualEffect does not dedupe). The FIRST non-bypassed one wins; the rest
// are ignored rather than stacked, because two rings on one cell would each
// push the other's output back into itself and compound without bound.
xleth::echo::EchoSettings resolveEchoSettings(
    const std::vector<VisualEffect>&                chain,
    const xleth::echo::IDelaySnapshotResolver*      resolver,
    int                                             trackId,
    int                                             sampleRate,
    AVRational                                      fps,
    uint64_t                                        ringKey) noexcept
{
    xleth::echo::EchoSettings out;
    if (!resolver || chain.empty() || sampleRate <= 0 || fps.den <= 0 || fps.num <= 0)
        return out;

    const VisualEffect* fx = nullptr;
    for (const auto& e : chain) {
        if (!e.bypassed && e.type == VisualEffect::Type::VisualEcho) { fx = &e; break; }
    }
    if (!fx) return out;

    const int nodeId = static_cast<int>(std::lround(fx->params[2]));
    if (nodeId < 0) return out;                       // unbound — inert by design

    const xleth::echo::DelaySnapshot snap = resolver->resolve(trackId, nodeId);
    if (!snap.valid || !(snap.delaySamples > 0.0f)) return out;

    // samples -> output frames. fps is rational (30000/1001 is a real case), so
    // the multiply is done in double and only rounded at the very end by the
    // ring-depth ceil; the tap offsets themselves stay fractional and are lerped.
    const double framesPerSample = static_cast<double>(fps.num)
                                 / (static_cast<double>(fps.den) * static_cast<double>(sampleRate));
    const double frameDelay = static_cast<double>(snap.delaySamples) * framesPerSample;

    // A repeat interval shorter than one output frame cannot be resolved by the
    // ring at all — every tap would land inside the same buffered frame. Rather
    // than draw N identical copies on top of each other (which just brightens
    // the cell and looks like a bug), the echo stays inactive below that floor.
    if (!(frameDelay >= 1.0) || !std::isfinite(frameDelay)) return out;

    const int taps = std::clamp(static_cast<int>(std::lround(fx->params[0])),
                                1, xleth::echo::kMaxTaps);

    const bool followFeedback = fx->params[7] >= 0.5f;
    const float decay = followFeedback ? snap.feedback01
                                       : std::clamp(fx->params[1], 0.0f, 1.0f);

    out.active     = true;
    out.taps       = taps;
    out.tapGain    = decay;
    out.frameDelay = static_cast<float>(frameDelay);
    out.scaleTrail = std::clamp(fx->params[3], 0.0f, 1.0f);
    out.flipMode   = std::clamp(static_cast<int>(std::lround(fx->params[4])),
                                0, xleth::echo::kFlipModeCount - 1);
    out.pingPong   = snap.pingPong;
    // Edge drift is a ping-pong TELL, not a free parameter: it exists so the
    // trail visibly alternates sides the way the audio alternates ears. On a
    // Single or Dual delay there is nothing to alternate, so the param is
    // ignored outright rather than applied as a generic sideways smear.
    out.drift      = snap.pingPong ? std::clamp(fx->params[5], 0.0f, 1.0f) : 0.0f;
    out.additive   = fx->params[6] >= 0.5f;
    out.ringKey    = ringKey;

    // Clamp the requested depth against the ring cap. When the delay is long
    // enough that taps * D would overrun kMaxRingFrames, drop taps rather than
    // truncate the oldest one to a wrong position: a missing tap reads as a
    // shorter trail, a mis-positioned one reads as broken sync.
    while (out.taps > 1
           && (static_cast<double>(out.taps) * frameDelay) + 2.0
              > static_cast<double>(xleth::echo::kMaxRingFrames)) {
        --out.taps;
    }

    return out;
}

xleth::clipmod::VideoModulationTimingContext makeVideoTimingContext(
    const VideoEvent& event,
    double beatPos,
    double bpm,
    int sampleRate,
    double sourceFps) noexcept
{
    const double safeBpm = (bpm > 0.0 && std::isfinite(bpm)) ? bpm : 140.0;
    const double timelineSeconds = beatPos * (60.0 / safeBpm);
    const int64_t timelineSamples = sampleRate > 0
        ? static_cast<int64_t>(std::llround(timelineSeconds * sampleRate))
        : int64_t{0};
    const double beatsSinceStart = beatPos - event.startBeat;
    const double clipLocalSeconds = beatsSinceStart * (60.0 / safeBpm);
    const int64_t clipLocalSamples = clipLocalSeconds > 0.0 && sampleRate > 0
        ? static_cast<int64_t>(std::llround(clipLocalSeconds * sampleRate))
        : int64_t{0};

    xleth::clipmod::VideoModulationTimingContext ctx;
    ctx.bpm = safeBpm;
    ctx.sampleRate = sampleRate > 0 ? static_cast<double>(sampleRate) : 48000.0;
    ctx.timelineSeconds = timelineSeconds;
    ctx.timelineBeats = beatPos;
    ctx.timelineSamples = timelineSamples;
    ctx.clipLocalSeconds = clipLocalSeconds;
    ctx.clipLocalBeats = beatsSinceStart;
    ctx.clipLocalSamples = clipLocalSamples;
    ctx.clipDurationSeconds = event.durationBeats * (60.0 / safeBpm);
    ctx.clipDurationBeats = event.durationBeats;
    ctx.sourceStartTime = event.sourceStartTime;
    ctx.sourceClampStartTime = event.sourceClampStartTime;
    ctx.sourceEndTime = event.sourceEndTime;
    ctx.sourceFps = sourceFps;
    // F.1: mirror MixEngine + SyncManager post-cache routing so export-time video
    // source-time matches the audio readhead. Cache buffer bakes in static pitch
    // for time-stretched OR formant-preserved (with pitch/stretch) clips, so zero
    // the static pitch here. (Same global-formant caveat as SyncManager — the raw
    // clip flag is used; the project-global toggle is not yet in VideoEvent.)
    const bool clipCacheProcessed =
        event.clipPitchOffsetSemis != 0
        || event.clipPitchOffsetCents != 0
        || event.clipStretchRatio != 1.0
        || event.clipReversed;
    const bool postCacheStretchedModulation =
        !event.clipReversed
        && clipCacheProcessed
        && (event.clipStretchRatio != 1.0 || event.clipFormantPreserve);
    ctx.clipPitchOffsetSemis = postCacheStretchedModulation ? 0 : event.clipPitchOffsetSemis;
    ctx.clipPitchOffsetCents = postCacheStretchedModulation ? 0 : event.clipPitchOffsetCents;
    ctx.clipStartTimelineSamples = event.clipStartTimelineSamples;
    // Stretch and reverse move the picture with the audio — see
    // sourceTimeForCacheSeconds in model/ClipVideoModulationTiming.cpp.
    ctx.clipStretchRatio = event.clipStretchRatio;
    ctx.clipReversed     = event.clipReversed;
    return ctx;
}

// Companion-FX snapshot construction has moved to
// model/ClipCompanionFxBuilder.cpp so the realtime OpenGL preview path
// (SyncManager) and this export path produce the same snapshot from the
// same evaluator outputs.

} // namespace

// Gates the two per-frame hot fprintf sites below (hold-last-frame clamp and
// fullscreen-cell composite logging). Evaluated once — this runs on the video
// thread inside a forked worker whose stderr is a pipe, so unconditional
// per-frame writes are a backpressure/stall hazard, not just noise.
static const bool kRenderLog = std::getenv("XLETH_RENDER_LOG") != nullptr;

// ===========================================================================
// Step 1: Collect requests for one output frame
// ===========================================================================

void FrameCollector::resolveGrades(CellFrameRequest& req, int sourceId, int clipId,
                                   int regionId, int trackId) const
{
    const xleth::grade::ColorGradeSnapshot* g = grades_.get();
    if (!g || gradeCompareBypass_ || g->empty()) return;
    req.gradeSource = g->source(sourceId);
    req.gradeClip   = clipId >= 0 ? g->clip(clipId) : g->region(regionId);
    req.gradeLayer  = g->track(trackId);
}

std::vector<CellFrameRequest>& FrameCollector::collectRequests(
    int64_t                        outputFrameIndex,
    const Timeline&                timeline,
    int                            sampleRate,
    AVRational                     fps,
    const std::vector<VideoEvent>& events,
    bool                           allowProxy,
    int64_t                        projectStartSample,
    bool                           posterMode,
    const std::unordered_map<int, std::string>* renderProxyBySource,
    const GridLayout*              layoutOverride,
    bool                           applyPreviewEffectMute)
{
    const double bpm = timeline.getBPM();

    // Output frame indices stay local to the export / preview starting at 0.
    // Project sampling must instead happen at the matching absolute timeline
    // sample so subrange exports look up the same visual state as audio.
    const int64_t localFrameSample = RenderClock::videoFrameToSample(
        outputFrameIndex, sampleRate, fps);
    const int64_t projectFrameSample = projectStartSample + localFrameSample;
    const int64_t projectFramePpq = RenderClock::sampleToPPQ(
        projectFrameSample, sampleRate, bpm);
    const double ticksPerBeat = static_cast<double>(TickTime::fromBeats(1).ticks);
    const double beatPos = static_cast<double>(projectFramePpq) / ticksPerBeat;
    // The frame's timeline tick, the clock every Lens/Roam key is evaluated on.
    const double frameTick = static_cast<double>(projectFramePpq);

    // Motion blur: the shutter, at this collect's frame rate. Lens / Sweep /
    // Roam follow the PROJECT setting, in ticks (constant tempo, like
    // sampleToPPQ above); Zoom/pan/rot follows each track's own setting.
    const double fpsValue = fps.den > 0
        ? static_cast<double>(fps.num) / static_cast<double>(fps.den) : 0.0;
    const MotionBlurSettings& projectMotionBlur = timeline.getMotionBlur();
    const double lensRoamShutterTicks = projectMotionBlur.active()
        ? motionblur::shutterSeconds(projectMotionBlur.shutterAngleDeg, fpsValue)
              * (bpm / 60.0) * ticksPerBeat
        : 0.0;

    // Time-based snapshot resolution — RENDER PATH ONLY. Editing reads stay on the
    // active snapshot (Timeline::getGridLayout); the render/export path instead
    // resolves the grid arrangement for THIS frame's absolute project tick, so a
    // cue timeline can switch snapshots over time. Returned BY VALUE: a self-
    // contained GridLayout this thread owns, never an alias into the editor's
    // active-snapshot cache. Global canvas/previewFps fields are identical to the
    // active layout regardless of tick.
    //
    // Snapshot-transition override: when layoutOverride is non-null the caller
    // forces a SPECIFIC snapshot's arrangement (outgoing A or incoming B) for this
    // frame while event timing above still follows the frame's absolute tick. Copy
    // by value so this thread owns the arrangement outright, exactly like the
    // gridLayoutAt result — never an alias into a live GridCue/GridSnapshot the
    // caller might mutate between the two transition composites.
    const GridLayout layout = layoutOverride
        ? *layoutOverride
        : timeline.gridLayoutAt(TickTime{ projectFramePpq });

    // Reused across calls rather than a fresh vector per frame — see
    // requestBuffer_'s doc comment in FrameCollector.h. clear() retains
    // capacity, so a session's steady-state cell count settles into zero
    // reallocation after the first few frames.
    requestBuffer_.clear();
    std::vector<CellFrameRequest>& requests = requestBuffer_;
    int gapsSkipped = 0;

    // One scan of the event list for every placement below (see
    // activeByTrack_ in FrameCollector.h).
    resolveActiveEvents(events, beatPos);

    // Motion view (docs/XLETH_MOTION_VIEW_DESIGN.md 3.4): the request's masks
    // at the frame tick and its Parent chain. A parent's home comes from the
    // FULL layout at this tick (R7), which is `layout` unless the caller forced
    // an arrangement (a transition's A/B, a Landing collect, or the live
    // preview handing over the layout it already resolved); then it is read
    // in place from the timeline. Resolved once, only when a parented request
    // asks for it. No allocation either way.
    ArrangementView fullArrangement;
    bool fullArrangementResolved = false;
    // `tick`: the frame tick, or a Trail clone's delayed tick (the source's
    // masks and parent chain at that instant; the arrangement stays this
    // frame's, as for every request of this collect).
    auto resolveMotionView = [&](CellFrameRequest& req, const LensRoamSnapshot& lr, int trackId,
                                 double tick) {
        lr.masksAt(trackId, tick, req.masks);
        if (lr.parentOf(trackId) < 0) return;
        if (!fullArrangementResolved) {
            fullArrangementResolved = true;
            if (!layoutOverride) {
                fullArrangement.columns          = layout.columns;
                fullArrangement.rows             = layout.rows;
                fullArrangement.gapScale         = layout.gapScale;
                fullArrangement.slots            = &layout.slots;
                fullArrangement.fullscreenLayers = &layout.fullscreenLayers;
            } else if (const GridSnapshot* s = timeline.gridSnapshotAt(TickTime{ projectFramePpq })) {
                fullArrangement.columns          = s->columns;
                fullArrangement.rows             = s->rows;
                fullArrangement.gapScale         = s->gapScale;
                fullArrangement.slots            = &s->slots;
                fullArrangement.fullscreenLayers = &s->fullscreenLayers;
            } else {
                const GridLayout& g = timeline.getGridLayout();
                fullArrangement.columns          = g.columns;
                fullArrangement.rows             = g.rows;
                fullArrangement.gapScale         = g.gapScale;
                fullArrangement.slots            = &g.slots;
                fullArrangement.fullscreenLayers = &g.fullscreenLayers;
            }
        }
        resolveParentChain(req, lr, timeline, fullArrangement, trackId, tick,
                           lensRoamShutterTicks);
    };

    // Clones: a Trail clone evaluates its SOURCE's whole cell at another time
    // (docs/XLETH_CLONE_SPEC.md "Trail clones"). `beat` drives the event (the
    // source frame, fades, ping-pong), `lensTick` the note's Lens clock and
    // `trackTick` everything timeline-absolute (Roam, Sweep, Masks, Parent).
    // All three are the delayed time, except for a held gap, whose picture
    // (and its Lens) stays where its event ended while Roam and Sweep run on.
    // A trail evaluation is side-effect free: no animation triggers, no hold
    // bookkeeping, no Echo (those are per-cell histories the trail does not
    // own), no ZPR / bounce / slide TV state (they are stateful and cannot be
    // asked for an earlier instant).
    struct TrailEval {
        double beat      = 0.0;
        double lensTick  = 0.0;
        double trackTick = 0.0;
        bool   frozenLens = false;
    };

    // Helper lambda to build a CellFrameRequest from an active event
    auto buildRequest = [&](const VideoEvent* ev, int trackId,
                            int cellCol, int cellRow, int spanX, int spanY,
                            float slotOpacity, int zOrder,
                            CellLayerKind kind,
                            bool continuing = false,
                            const TrailEval* trail = nullptr) -> bool
    {
        // continuing: `ev` has ENDED and this is Hold Last Frame's "Keep
        // playing" fill — the same event evaluated on past its end, so the
        // source runs on through the gap. No fades (the event is over), no
        // hold bookkeeping (the freeze state belongs to the live path).
        if (!ev) {
            if (kRenderLog && !trail) clampLoggedTracks_.erase(trackId);
            return false;
        }
        const double evBeat    = trail ? trail->beat      : beatPos;
        const double lensTick  = trail ? trail->lensTick  : frameTick;
        const double trackTick = trail ? trail->trackTick : frameTick;

        // Look up source to get file path and fps
        const SourceMedia* src = timeline.getSource(ev->sourceId);
        if (!src || !src->hasVideo || src->filePath.empty()) return false;

        // The source's EXACT frame rate — the single authority for every
        // time → frame conversion below. RenderVideoDecoder converts the frame
        // indices we produce back into stream timestamps with this same
        // rational, so the round trip is symmetric. Projects saved before
        // fpsNum/fpsDen existed fall back to reconstructing it from the legacy
        // double. See engine/src/render/FrameRateMath.h.
        const AVRational srcRate = xleth::frametiming::rateFromSource(
            src->fpsNum, src->fpsDen, src->fps);
        const double srcFps = av_q2d(srcRate);

        const auto timingCtx = makeVideoTimingContext(
            *ev, evBeat, bpm, sampleRate, srcFps);
        const auto timing = xleth::clipmod::evaluateVideoClipModulationTiming(
            ev->modulation, timingCtx, isVideoModulationCompatible(*ev));

        double sourceTime = timing.sourceTimeSeconds;
        // Keep playing runs the source on past the clip's out point; past
        // either end of the FILE there is nothing left to show, so it stops
        // on the first / last frame there.
        if (continuing) {
            const double lastFrameTime = (src->duration > 0.0 && srcFps > 0.0)
                ? std::max(0.0, src->duration - 1.0 / srcFps) : sourceTime;
            sourceTime = std::clamp(sourceTime, 0.0, std::max(0.0, lastFrameTime));
        }
        int64_t srcFrame = computeSourceFrameFromTime(sourceTime, srcRate);

        // Fetch TrackInfo early — needed to check pingPong.enabled before the clamp.
        const TrackInfo* trk = timeline.getTrack(trackId);
        const bool isFullscreen = (kind != CellLayerKind::Grid);

        CellFrameRequest req;
        if (companionFxEnabled_)
            req.companionFx = xleth::clipmod::buildClipCompanionFxSnapshot(ev->modulation, timing);

        // Ping-pong overrides the hold-last-frame clamp for enabled tracks.
        // Not gated on placement: compositeFrame runs the crossfade on every
        // layer kind, so a fullscreen backdrop ping-pongs like any other track.
        if (trk && trk->pingPong.enabled) {
            int64_t secondaryFrame = -1;
            float   blendFactor    = 0.0f;
            srcFrame = computePingPongFrame(*ev, evBeat, bpm, sampleRate, srcRate,
                                            trk->pingPong, secondaryFrame, blendFactor);
            req.pingPongSecondaryFrame = secondaryFrame;
            req.pingPongBlendFactor    = blendFactor;
            // Ping-pong owns boundary handling — skip the hold-last-frame clamp below.
        } else {
            // Hold-last-frame: if the computed source time exceeds the trim end,
            // always clamp to the last frame so active notes never go black.
            if (ev->sourceEndTime > 0.0) {
                if (sourceTime >= ev->sourceEndTime) {
                    srcFrame = computeSourceFrameFromTime(sourceTime, srcRate);
                    // Edge-triggered: log once when the note enters the held
                    // state, not every frame of its sustain (a normal
                    // authoring state, not an error).
                    if (kRenderLog && !trail && clampLoggedTracks_.insert(trackId).second) {
                        std::fprintf(stderr, "[FrameCollector] Track %d: frame clamped to last frame %lld "
                                     "(source time %.3fs >= trim end %.3fs)\n",
                                     trackId, (long long)srcFrame, sourceTime, ev->sourceEndTime);
                    }
                } else if (kRenderLog && !trail) {
                    clampLoggedTracks_.erase(trackId);
                }
            }
        }

        req.cellCol          = cellCol;
        req.cellRow          = cellRow;
        req.spanX            = spanX;
        req.spanY            = spanY;

        // Proxy selection priority:
        //   1. Per-region (quote) proxy when one is ready and the current
        //      source time lands inside [proxyStartTime, proxyEndTime).
        //      Frame index must be recomputed against the proxy's time 0.
        //   2. Legacy source-wide proxy (kept for projects that still have
        //      one on disk; new sessions stop generating them).
        //   3. Original source file.
        // Chorus/Crash paths skip the region-proxy lookup entirely — those
        // cells intentionally stream the original for longer reads.
        //
        // Proxy substitution is intentionally PREVIEW-ONLY (allowProxy=true).
        // Editor seeking depends on the half-res DNxHR LB proxy to hit
        // interactive frame rates (Phase 0 perf floor). For final export the
        // caller passes allowProxy=false so the encoder receives original-
        // source pixels — anything less makes CRF/bitrate settings operate on
        // already-degraded input and the user cannot recover quality.
        // ── Swapped-video regions ────────────────────────────────────────────
        // A region whose video stream was rebound by video_swapRegionVideo
        // renders its REPLACEMENT file — src->filePath is no longer the pixels
        // this cell should show. Every substitute below that is derived from the
        // source (whole-source preview proxy, legacy source-wide proxy, poster /
        // per-cell thumbnails, render-plan proxy) is a proxy OF THE ORIGINAL and
        // is therefore invalid for such a region: engaging one silently renders
        // the pre-swap video. Only the per-region proxy carries the replacement's
        // pixels, so for a swapped region it is the ONLY legal substitution.
        //
        // The replacement file itself is the base pick (not src->filePath) so a
        // region whose proxy has not landed yet — or whose proxy failed — still
        // shows the right video instead of silently falling back to the original.
        // Its time base matches the region proxy's: file time 0 == the region's
        // startTime (see the swapped-video re-anchor in drainProxyResults).
        const SampleRegion* pickRegion =
            ev->regionId > 0 ? timeline.getRegion(ev->regionId) : nullptr;
        const bool regionSwapped = pickRegion && pickRegion->hasSwappedVideo
                                   && !pickRegion->swappedVideoPath.empty();

        std::string pickedPath  = regionSwapped ? pickRegion->swappedVideoPath
                                                : src->filePath;
        int64_t     pickedFrame = regionSwapped
            ? computeSourceFrameFromTime(sourceTime - pickRegion->startTime, srcRate)
            : srcFrame;

        // ── RENDER PATH: resolution-aware proxy plan (authoritative) ──────────
        // When a render plan is supplied it fully owns the source-vs-proxy choice
        // for every element (grid + fullscreen). A non-empty mapped path is a
        // footprint-sized whole-source proxy (frame index 1:1); a missing/empty
        // entry means decode the ORIGINAL. This deliberately bypasses ALL the
        // preview substitution below (region/legacy/preview proxy, poster). Gated
        // by allowProxy so the full-quality override (allowProxy=false) still
        // delivers bit-exact original pixels to the encoder.
        if (renderProxyBySource) {
            // Authoritative render plan — no preview substitution. The plan is
            // keyed by sourceId, so its proxy is a proxy of the ORIGINAL file and
            // must not be engaged for a swapped-video region (see above).
            if (allowProxy && !regionSwapped) {
                auto it = renderProxyBySource->find(ev->sourceId);
                if (it != renderProxyBySource->end() && !it->second.empty()) {
                    pickedPath  = it->second;
                    pickedFrame = srcFrame;   // whole-source proxy: 1:1 frame map
                }
                // else: leave pickedPath = original source.
            }
        } else {
            // ── PREVIEW PATH substitution ladder ──────────────────────────────
            if (allowProxy && ev->regionId > 0) {
                const SampleRegion* r = pickRegion;
                if (r && r->proxyReady && !r->proxyPath.empty()) {
                    if (sourceTime >= r->proxyStartTime &&
                        sourceTime <  r->proxyEndTime) {
                        pickedPath  = r->proxyPath;
                        pickedFrame = computeSourceFrameFromTime(
                                          sourceTime - r->proxyStartTime, srcRate);
                    }
                }
            }

            // Legacy source-wide proxy fallback
            if (allowProxy && pickedPath == src->filePath &&
                src->proxyReady && !src->proxyPath.empty()) {
                pickedPath = src->proxyPath;
            }

            // ── Whole-source preview proxy (PREVIEW-ONLY) ─────────────────────
            // The primary preview path: ONE small all-intra proxy of the ENTIRE
            // source, used for ALL cells — grid AND fullscreen/backdrop. Every
            // source frame is kept at the source fps, so the frame index maps 1:1
            // (no time-base remap like the region proxy). Random access into the
            // small intra proxy is a cheap exact seek, so LIVE preview stays smooth
            // even when scrubbing into previously-unvisited regions. This
            // supersedes the region/legacy proxy pick above.
            // ── Poster fast-preview pick (PREVIEW-ONLY) ───────────────────────
            // When the user explicitly selects Poster mode, a cached static frame
            // is the AUTHORITATIVE pick and must WIN over the whole-source preview
            // proxy. Binding one resident single-frame texture per cell is what
            // makes poster mode faster than live: requests dedupe per distinct
            // (source,bucket) and the decode-miss loop stays empty after warm-up.
            //
            // PER-CELL semantics (Fix 2): each cell prefers its OWN thumbnail
            // decoded at this cell's source time-offset — keyed by the 1-second
            // bucket floor(sourceStartTime) — so a source reused across many cells
            // at different offsets shows a DIFFERENT frame per cell. The per-source
            // base poster (src->posterPath) is only a FALLBACK, shown until this
            // cell's own thumbnail is ready (or if its generation failed).
            //
            // ROOT CAUSE history: the poster used to be gated behind
            // `!previewProxyEngaged`, but the whole-source preview-proxy self-heal
            // runs even in poster mode, so as soon as a proxy existed it silently
            // superseded the poster and poster mode did NO poster work. Making
            // `previewProxyEngaged` yield to `posterEngaged` restores the intended
            // static-frame behaviour. The proxy remains the live fallback ONLY while
            // neither this cell's thumbnail nor the base poster is ready yet.
            // Posters and per-cell thumbnails are extracted from the ORIGINAL
            // source, so a swapped region must not bind one — it would show the
            // pre-swap frame. Such a cell stays on its region proxy / the
            // replacement file, which is live but always the correct video.
            std::string posterPick;
            if (posterMode && !regionSwapped) {
                const int bucket = static_cast<int>(
                    std::floor(std::max(0.0, ev->sourceStartTime)));
                auto it = src->thumbnailPaths.find(bucket);
                if (it != src->thumbnailPaths.end() && !it->second.empty())
                    posterPick = it->second;                 // this cell's own frame
                else if (src->posterReady && !src->posterPath.empty())
                    posterPick = src->posterPath;            // per-source fallback
            }
            const bool posterEngaged = !posterPick.empty();

            // The whole-source preview proxy is a proxy of src->filePath. It
            // supersedes the region proxy for ordinary regions (both hold the
            // same pixels, and the intra proxy scrubs faster) — but for a
            // swapped region it holds the PRE-SWAP video, so it must yield to
            // the region proxy exactly as it already yields to posterEngaged.
            //
            // Why the region proxy is NOT preferred, even though it would make a
            // note retrigger cheap (its first frame is a keyframe, where the same
            // moment in the GOP-48 whole-source file costs a ~31-frame walk —
            // measured ~27 ms per uncached note-on on a desktop GPU): the region
            // proxy is not frame-exact. ProxyTranscoder keeps the frames whose
            // PTS is >= the region start, so its frame 0 is the first frame
            // AFTER the one the region start falls in, and the encoder can leave
            // it a frame short at the end. The whole-source proxy maps 1:1 onto
            // source frame indices. Preferring the region proxy was tried and
            // measured (worst tick 31 ms -> 6 ms) and backed out for that reason;
            // making it exact means aligning the transcode start to a frame
            // boundary and versioning the files, not a pick-order change.
            const bool previewProxyEngaged =
                allowProxy && !posterEngaged && !regionSwapped
                && src->previewProxyReady && !src->previewProxyPath.empty();
            if (previewProxyEngaged) {
                pickedPath  = src->previewProxyPath;
                pickedFrame = srcFrame;
            }

            if (posterEngaged) {
                pickedPath  = posterPick;
                pickedFrame = 0;   // single-frame texture; index is irrelevant
            }
        }

        req.sourcePath       = pickedPath;
        req.sourceId         = ev->sourceId;
        req.sourceFrameIndex = pickedFrame;
        req.sourcePixelW     = src->width;
        req.sourcePixelH     = src->height;
        // Color Grade: Source -> Clip (or Region) -> Layer, resolved from the
        // published snapshot. Shared pointers out, no bake and no model read.
        resolveGrades(req, ev->sourceId, ev->clipId, ev->regionId, trackId);
        const float fadeGain = continuing ? 1.0f
                             : videoEventFadeGain(*ev, evBeat)
                               * trackNoteFadeGain(*ev, trk, evBeat, bpm);
        req.opacity          = std::clamp(slotOpacity * ev->opacity * fadeGain, 0.0f, 1.0f);
        // Flip v2: VideoFlipApplier already resolved stateIndex/orientation per
        // event during the build pass. The shader consumes `orientation` directly;
        // stateIndex is propagated for analytics/debug only.
        req.stateIndex  = ev->stateIndex;
        req.orientation = static_cast<int>(ev->orientation);
        {
            if (trk) {
                req.cornerRadius     = trk->cornerRadius;
                req.gapScaleOverride = trk->gapScaleOverride;
                // Preview-only eyedropper mute (see applyPreviewEffectMute doc):
                // export/transition callers never pass true, so this can never
                // suppress the chain during a render.
                const bool previewMuted = applyPreviewEffectMute
                    && timeline.isVisualEffectChainPreviewMuted(trk->id);
                if (!previewMuted && !trk->visualEffectChain.empty()) {
                    // Copy, not address-of — see the comment on
                    // CellFrameRequest::visualChain in FrameCollector.h
                    // (Bug 1 fix). Safe here specifically because this
                    // whole call runs under syncEventsMutex (eLock) in
                    // the caller's video-tick loop, which the visual-
                    // effect-chain mutation handlers now also acquire.
                    // Copied for fullscreen layers too: compositeFrame runs
                    // one per-cell path for every layer kind, so the chain
                    // (and the Outline / Drop Shadow stages it drives) is
                    // live for a fullscreen backdrop, not dead weight.
                    req.visualChain = trk->visualEffectChain;
                    // Motion view: keyed effect params, on this request's copy, at the
                    // track's timeline tick (before the echo is resolved from the chain).
                    if (const LensRoamSnapshot* fxLr = lensRoam_.get())
                        fxLr->applyFxKeys(trackId, trackTick, req.visualChain);

                    // Visual Echo: resolved from the chain we just copied, so a
                    // preview-muted or bypassed chain yields no echo for free.
                    //
                    // The ring identity is (track, cell, layer kind), NOT the
                    // track alone: one track can occupy several cells, and each
                    // needs its own history because each shows different pixels.
                    // Moving a track to a different cell therefore starts a
                    // fresh ring — correct, since the old cell's history is of
                    // a different rectangle; the abandoned ring is swept by
                    // pruneIdleEchoRings a few seconds later.
                    const uint64_t ringKey =
                          (static_cast<uint64_t>(static_cast<uint32_t>(trackId)) << 32)
                        | (static_cast<uint64_t>(static_cast<uint16_t>(cellCol)) << 16)
                        | (static_cast<uint64_t>(static_cast<uint8_t>(cellRow))  << 8)
                        |  static_cast<uint64_t>(static_cast<uint8_t>(kind));
                    if (!trail)
                        req.echo = resolveEchoSettings(req.visualChain, echoResolver_,
                                                       trackId, sampleRate, fps, ringKey);
                }
                // Note trigger detection: fire onNoteStart when globalNoteIndex
                // changes. Runs for fullscreen layers too — their ZPR is drawn
                // by the same per-cell path now, and an animation that is never
                // triggered simply sits at its defaults (zoom 1, pan/rot 0),
                // which is what made a fullscreen backdrop static before.
                // Bounce is still computed here but ignored at composite time
                // for non-grid layers; see the bounce block in compositeFrame.
                // VideoEvents are emitted only by
                // *normal* (non-slide) PatternNotes (slide notes flow through
                // SlideAnimationEvent and are skipped at note-build time), so
                // this is the right place to hook the NextNormalNote slide
                // visual return trigger — it covers both realtime preview and
                // offline render via the shared FrameCollector path.
                if (animationMgr_ && !trail) {
                    const CellAnimation* anim = animationMgr_->getAnimation(trackId);
                    if (!anim || ev->globalNoteIndex != anim->activeNoteId) {
                        animationMgr_->onSlideReturnTrigger(trackId);
                        // Gate length for LengthMode::Note: ev->durationBeats is
                        // this note's own duration, already in scope here (read
                        // above for fade-gain) — converted to ms via the same
                        // bpm used for every other time->beat conversion in this
                        // function.
                        const float noteDurationMs =
                            static_cast<float>(ev->durationBeats * (60000.0 / bpm));
                        animationMgr_->onNoteStart(trackId, ev->globalNoteIndex,
                                                   trk->zoomPanRot, trk->bounce,
                                                   bpm, noteDurationMs);
                    }
                }
            }
        }

        // Populate animation state from AnimationManager. Taken for fullscreen
        // layers too — compositeFrame's single per-cell path reads ZPR and the
        // slide TV ramp for every layer kind. Only the bounce fields go unused
        // on a fullscreen layer (grid-geometry; see compositeFrame).
        if (animationMgr_ && !trail) {
            const CellAnimation* anim = animationMgr_->getAnimation(trackId);
            if (anim) {
                req.currentZoom     = anim->currentZoom;
                req.currentPanX     = anim->currentPanX;
                req.currentPanY     = anim->currentPanY;
                req.currentRotDeg   = anim->currentRotDeg;
                req.bounceOffsetX   = anim->bounceOffsetX;
                req.bounceOffsetY   = anim->bounceOffsetY;
                req.bounceScaleX    = anim->bounceScaleX;
                req.bounceScaleY    = anim->bounceScaleY;
                req.tvRampIntensity = anim->tvRampIntensity;
                req.tvRampRollSpeed  = anim->tvRampRollSpeed;
                req.tvRampScanlines  = anim->tvRampScanlines;
                req.tvRampChroma     = anim->tvRampChroma;
                req.tvRampNoise      = anim->tvRampNoise;
                req.tvRampJitter     = anim->tvRampJitter;
                req.tvRampColorBleed = anim->tvRampColorBleed;
            }
        }

        req.trackId          = trackId;
        req.layerKind        = kind;
        req.zOrder           = zOrder;

        // Lens/Roam at THIS frame's tick: binary searches over the published
        // snapshot's precompiled keys plus one interpolation per keyed
        // channel, POD copies out. No allocation, no lock, no state (see
        // setLensRoamSnapshot). Stateless on purpose: clip keys run from the
        // clip start, the hit curve from the note's START TICK (Ruling 5, the
        // way Note Fade runs), Roam on the timeline tick, so a seek into a
        // note lands mid-animation and the export, sampling the same tick,
        // gets the same value.
        // P11: the Lens WITHOUT the track's Sweep is what a held gap keeps (the
        // frozen picture); the Sweep itself runs on the timeline tick, so it is
        // applied per frame, live or held.
        LensParams lensPreSweep = req.lens;
        if (const LensRoamSnapshot* lr = lensRoam_.get()) {
            LensRoamSnapshot::EventClock clock;
            clock.frameTick      = lensTick;
            clock.eventStartTick = videoEventStartTick(*ev);
            clock.eventLenTicks  = videoEventLengthTicks(*ev);
            // The note's override (P8): Follow / Nudge / Own.
            LensRoamSnapshot::NoteRef note;
            note.patternId = ev->lensPatternId;
            note.noteId    = ev->lensNoteId;
            // Clones: a Voice clone's note plays the Track Lens of
            // ev->lensTrackId (the source when Linked, the clone when Own);
            // everything else is this cell's own. For any other event the
            // two are the same track.
            const int lensTrack = ev->lensTrackId >= 0 ? ev->lensTrackId : trackId;
            // Order (spec): Lens base -> note animation -> Sweep -> chain / flip.
            lensPreSweep = lr->lensBeforeSweep(lensTrack, ev->clipId, ev->regionId, clock, note);
            req.lens = lr->applySweep(trackId, lensPreSweep, trackTick);
            req.roam = lr->roamAt(trackId, trackTick);
            // Motion view: masks + Parent. Before the motion samples, which
            // also run for a still child of a moving parent.
            resolveMotionView(req, *lr, trackId, trackTick);

            // Motion blur: the same evaluation at sub-frame ticks. The event
            // clock keeps its start/length, so a sample before the note-on
            // reads the note's first pose, as the frame itself would. (A held
            // trail's picture is frozen: only its Sweep moves.)
            if (lensRoamShutterTicks > 0.0) {
                const bool frozen = trail && trail->frozenLens;
                sampleLensRoamMotion(req, *lr, trackId, trackTick, lensRoamShutterTicks,
                    [&](double tick) {
                        if (frozen) return lr->applySweep(trackId, lensPreSweep, tick);
                        LensRoamSnapshot::EventClock c = clock;
                        c.frameTick = lensTick + (tick - trackTick);
                        return lr->applySweep(trackId,
                            lr->lensBeforeSweep(lensTrack, ev->clipId, ev->regionId, c, note), tick);
                    });
            }
        }
        if (animationMgr_ && trk && !trail) {
            if (const CellAnimation* anim = animationMgr_->getAnimation(trackId))
                sampleZprMotion(req, *anim, *trk, fpsValue);
        }

        if (isFullscreen && kRenderLog) {
            std::fprintf(stderr, "[FrameCollector] FS-%s cell: '%s' frame=%lld opacity=%.2f\n",
                         kind == CellLayerKind::FullscreenBehind ? "behind" : "front",
                         req.sourcePath.c_str(), (long long)req.sourceFrameIndex, req.opacity);
        }

        // Hold-through-gap bookkeeping runs regardless of the opacity cull
        // below: it must keep recording the last ACTIVE frame (even one that
        // resolves invisible, e.g. mid fade-out) so a genuine gap afterward
        // still holds the same frame it always did. This used to happen in
        // the BehindGrid caller reading requests.back(); moved here because
        // the opacity-culled path never pushes to `requests`.
        //
        // Grid cells hold exactly like a BehindGrid layer (same state, same
        // fade-out suppression, same threshold). Only FullscreenInFront is
        // transient. A track placed in several cells writes the same values
        // once per cell — they all show the same event — so the shared
        // per-track entry stays consistent.
        if (!continuing && !trail
            && (kind == CellLayerKind::FullscreenBehind || kind == CellLayerKind::Grid)) {
            auto& s = holdByTrack_[trackId];
            s.lastFrame            = req.sourceFrameIndex;
            s.lastPath             = req.sourcePath;
            s.lastOrientation      = req.orientation;
            s.lastLens             = lensPreSweep;
            s.lastSourcePixelW     = req.sourcePixelW;
            s.lastSourcePixelH     = req.sourcePixelH;
            s.lastSourceId         = ev->sourceId;
            s.lastClipId           = ev->clipId;
            s.lastRegionId         = ev->regionId;
            s.suppressAfterFadeOut = ev->fadeOutPercent > 0.0f
                                  || trackNoteFadeHasFadeOut(*ev, trk, bpm);
            s.lastClipEndBeat      = ev->startBeat + ev->durationBeats;
        }

        // Opacity cull: a request that provably cannot appear is dropped
        // before it ever reaches dedup/decode/upload/draw. The caller still
        // sees `true` — an event WAS active here, this is not a timeline gap
        // — so BehindGrid hold-fill and the gap-skipped counters are not
        // triggered by an invisible-but-active frame.
        if (req.opacity <= kOpacityCullEpsilon)
            return true;

        requests.push_back(std::move(req));
        return true;
    };

    // Hold-through-gap fill, shared by BehindGrid layers and grid cells. Called
    // where a placement has NO request this frame (a real gap, not an opacity
    // cull — buildRequest reports those as handled). Pushes the track's last
    // served frame and returns true, or returns false to leave it a gap.
    auto buildHeldRequest = [&](int trackId, int cellCol, int cellRow,
                                int spanX, int spanY,
                                float slotOpacity, int zOrder,
                                CellLayerKind kind) -> bool
    {
        const TrackInfo* trk = timeline.getTrack(trackId);
        if (!trk || !trk->videoHoldLastFrame) return false;
        // A Voice clone with no note draws nothing at all (spec "Idle"): it
        // appears only while it plays. Whatever is behind it shows through.
        if (trk->isClone()) return false;

        // A muted track has no active event by construction (findActiveEvent),
        // which is indistinguishable from a gap here — without this a muted
        // track would keep showing its last frame and mute would look broken.
        if (trk->muted) return false;

        // Smart hold / Keep playing need to know the gap itself: which event
        // ended it began with and when the next one starts. Stateless (a pure
        // function of the event list and beatPos), so preview, export and a
        // seek straight into the gap all agree.
        GapInfo gap;
        if (trk->videoHoldSmart || trk->videoHoldKeepPlaying)
            gap = gapFor(events, trackId, beatPos);

        if (trk->videoHoldSmart) {
            // No next event = the space after the track's last clip: nothing
            // to hold over to, so it is blank. Otherwise hold only gaps on the
            // phrase side of the track's natural break (model/SmartHold.h).
            if (!gap.prev || !std::isfinite(gap.nextStart)) return false;
            if (gap.nextStart - gap.prevEnd > gap.smartThreshold + 1e-9) return false;
        }

        if (trk->videoHoldKeepPlaying) {
            if (!gap.prev) return false;
            const VideoEvent& prev = *gap.prev;
            // Same rule as the freeze: an event that fades itself out meant
            // to end on nothing.
            if (prev.fadeOutPercent > 0.0f || trackNoteFadeHasFadeOut(prev, trk, bpm))
                return false;
            if (!trk->videoHoldSmart
                && trk->videoHoldLastFrameThresholdBeats >= 0.0
                && (beatPos - gap.prevEnd) > trk->videoHoldLastFrameThresholdBeats)
                return false;
            return buildRequest(&prev, trackId, cellCol, cellRow, spanX, spanY,
                                slotOpacity, zOrder, kind, /*continuing*/ true);
        }

        auto it = holdByTrack_.find(trackId);
        if (it == holdByTrack_.end()) return false;
        const HoldState& hold = it->second;
        if (hold.lastFrame < 0 || hold.suppressAfterFadeOut) return false;

        // Hold-expiry threshold. The stored value is already in BEATS and
        // beatPos is in beats, so this is a direct comparison — no PPQ
        // round-trip and no tempo lookup. Negative threshold = unlimited,
        // which short-circuits to the pre-threshold behavior untouched.
        // Smart hold replaces the threshold (it decided above).
        //
        // Only reached once the clip has actually ended, so the hold always
        // fills a gap shorter than the threshold exactly as it did before.
        if (!trk->videoHoldSmart
            && trk->videoHoldLastFrameThresholdBeats >= 0.0
            && (beatPos - hold.lastClipEndBeat) > trk->videoHoldLastFrameThresholdBeats)
            return false;

        if (kRenderLog) {
            std::fprintf(stderr, "[FrameCollector] %s gap (track %d): hold=ON frame=%lld\n",
                         kind == CellLayerKind::Grid ? "grid" : "FS-behind",
                         trackId, (long long)hold.lastFrame);
        }

        CellFrameRequest req;
        req.cellCol          = cellCol;
        req.cellRow          = cellRow;
        req.spanX            = spanX;
        req.spanY            = spanY;
        req.sourcePath       = hold.lastPath;
        req.sourceFrameIndex = hold.lastFrame;
        req.opacity          = std::min(1.0f, std::max(0.0f, slotOpacity));
        req.layerKind        = kind;
        req.zOrder           = zOrder;
        req.orientation      = hold.lastOrientation;
        req.trackId          = trackId;
        req.lens             = hold.lastLens;   // the picture as last drawn (no Sweep: see below)
        req.sourcePixelW     = hold.lastSourcePixelW;
        req.sourcePixelH     = hold.lastSourcePixelH;
        // The held picture keeps its grades (resolved now, so an edit made
        // while it is held shows at once).
        resolveGrades(req, hold.lastSourceId, hold.lastClipId, hold.lastRegionId, trackId);
        // Roam belongs to the track, not the event: its keys keep running on
        // the timeline tick through a held gap.
        // Sweep too (P11): it is timeline-absolute, so a move that spans a gap
        // between notes carries on through the held picture.
        if (const LensRoamSnapshot* lr = lensRoam_.get()) {
            req.roam = lr->roamAt(trackId, frameTick);
            req.lens = lr->applySweep(trackId, hold.lastLens, frameTick);
            // Motion view: masks and the Parent chain belong to the track, not
            // the event, so a held picture keeps them (timeline-absolute).
            resolveMotionView(req, *lr, trackId, frameTick);
            // Motion blur: a held picture still moves under its Roam and Sweep.
            if (lensRoamShutterTicks > 0.0) {
                sampleLensRoamMotion(req, *lr, trackId, frameTick, lensRoamShutterTicks,
                    [&](double tick) { return lr->applySweep(trackId, hold.lastLens, tick); });
            }
        }

        // A held frame is the SAME picture the live path was drawing an
        // instant ago, so it has to carry the same look. The compositor runs
        // the full per-cell path on every layer kind, so leaving these at
        // their defaults would strip the chain, the corner radius and ZPR the
        // moment the clip ended — a visible pop at every gap boundary. Mirrors
        // buildRequest's population; ping-pong is deliberately absent (a hold
        // has no motion).
        req.cornerRadius     = trk->cornerRadius;
        req.gapScaleOverride = trk->gapScaleOverride;
        if (!(applyPreviewEffectMute
              && timeline.isVisualEffectChainPreviewMuted(trk->id)))
            req.visualChain = trk->visualEffectChain;
        if (const LensRoamSnapshot* fxLr = lensRoam_.get())
            fxLr->applyFxKeys(trackId, frameTick, req.visualChain);
        if (animationMgr_) {
            if (const CellAnimation* anim = animationMgr_->getAnimation(trackId)) {
                req.currentZoom      = anim->currentZoom;
                req.currentPanX      = anim->currentPanX;
                req.currentPanY      = anim->currentPanY;
                req.currentRotDeg    = anim->currentRotDeg;
                req.tvRampIntensity  = anim->tvRampIntensity;
                req.tvRampRollSpeed  = anim->tvRampRollSpeed;
                req.tvRampScanlines  = anim->tvRampScanlines;
                req.tvRampChroma     = anim->tvRampChroma;
                req.tvRampNoise      = anim->tvRampNoise;
                req.tvRampJitter     = anim->tvRampJitter;
                req.tvRampColorBleed = anim->tvRampColorBleed;
                // Bounce is grid geometry: the compositor ignores it on a
                // fullscreen layer, so only a grid cell needs it carried.
                if (kind == CellLayerKind::Grid) {
                    req.bounceOffsetX = anim->bounceOffsetX;
                    req.bounceOffsetY = anim->bounceOffsetY;
                    req.bounceScaleX  = anim->bounceScaleX;
                    req.bounceScaleY  = anim->bounceScaleY;
                }
                sampleZprMotion(req, *anim, *trk, fpsValue);
            }
        }

        requests.push_back(std::move(req));
        return true;
    };

    // ── Clones: Trail clones (docs/XLETH_CLONE_SPEC.md "Trail clones") ──────
    // A Trail replays its source's ENTIRE cell result delayTicks later: the
    // source's event, frame, hit curve and Lens, Roam path, Masks and Parent
    // chain, all evaluated at (frame - delay) by the same buildRequest the
    // source goes through (one extra evaluation per Trail, no state of its
    // own). Then it is faded by its own opacity, tinted (a multiply Tint at
    // the end of its copy of the chain) and pushed by its added Roam offset,
    // which is timeline-absolute and does NOT lag. It draws at the source's
    // placement, assembled right before the source's own request with the
    // source's sort key, so the one stable sort below keeps the stack
    // directly under the source, farthest delay first.
    // Before the delayed time reaches the timeline start a Trail shows
    // nothing. A held gap of the source is reproduced statelessly from the
    // event list (gapFor), with the live hold's rules.
    auto emitTrails = [&](int sourceTrackId, int cellCol, int cellRow, int spanX, int spanY,
                          float slotOpacity, int zOrder, CellLayerKind kind)
    {
        const LensRoamSnapshot* lr = lensRoam_.get();
        if (!lr || lr->trails.empty()) return;
        std::size_t first = 0, count = 0;
        lr->trailsOf(sourceTrackId, first, count);
        if (count == 0) return;
        const TrackInfo* src = timeline.getTrack(sourceTrackId);
        if (!src) return;

        for (std::size_t i = first; i < first + count; ++i) {
            const LensRoamSnapshot::TrailEntry& te = lr->trails[i];
            const TrackInfo* trailTrk = timeline.getTrack(te.trackId);
            if (!trailTrk || trailTrk->muted) continue;          // its own visibility
            const double trailOpacity = lr->trailOpacityAt(te, frameTick);
            if (trailOpacity <= kOpacityCullEpsilon) continue;
            const double dTick = frameTick - te.delayTicks;
            if (dTick < 0.0) continue;                            // before the timeline start

            TrailEval at;
            at.beat      = dTick / ticksPerBeat;
            at.lensTick  = dTick;
            at.trackTick = dTick;
            const VideoEvent* ev = activeEventAt(events, sourceTrackId, at.beat);
            bool continuing = false;
            if (!ev && src->videoHoldLastFrame && !src->isClone()) {
                const GapInfo gap = gapFor(events, sourceTrackId, at.beat);
                bool hold = gap.prev != nullptr;
                if (hold && src->videoHoldSmart)
                    hold = std::isfinite(gap.nextStart)
                        && gap.nextStart - gap.prevEnd <= gap.smartThreshold + 1e-9;
                if (hold && !src->videoHoldSmart
                    && src->videoHoldLastFrameThresholdBeats >= 0.0
                    && (at.beat - gap.prevEnd) > src->videoHoldLastFrameThresholdBeats)
                    hold = false;
                if (hold && (gap.prev->fadeOutPercent > 0.0f
                             || trackNoteFadeHasFadeOut(*gap.prev, src, bpm)))
                    hold = false;
                if (hold) {
                    ev = gap.prev;
                    if (src->videoHoldKeepPlaying) {
                        continuing = true;                        // the source runs on
                    } else {
                        // Freeze: the picture as its event ended (its last
                        // frame and Lens); Roam and Sweep keep running.
                        const double endBeat = ev->startBeat + ev->durationBeats;
                        at.beat       = std::nextafter(endBeat, -std::numeric_limits<double>::infinity());
                        at.lensTick   = videoEventStartTick(*ev)
                                      + std::max(0.0, videoEventLengthTicks(*ev) - 1e-6);
                        at.frozenLens = true;
                    }
                }
            }
            if (!ev) continue;

            const std::size_t before = requests.size();
            buildRequest(ev, sourceTrackId, cellCol, cellRow, spanX, spanY,
                         slotOpacity, zOrder, kind, continuing, &at);
            if (requests.size() == before) continue;              // culled / unresolvable
            CellFrameRequest& req = requests.back();
            req.trackId = te.trackId;
            if (at.frozenLens)                                    // a held frame: slot opacity, like the live hold
                req.opacity = std::clamp(slotOpacity, 0.0f, 1.0f);
            req.opacity = std::clamp(static_cast<float>(req.opacity * trailOpacity), 0.0f, 1.0f);
            if (req.opacity <= kOpacityCullEpsilon) { requests.pop_back(); continue; }

            // Added Roam: offset only, on top of the delayed source position,
            // at THIS frame's tick (and at each motion-blur sub-frame).
            const RoamParams added = lr->roamAt(te.trackId, frameTick);
            req.roam.offsetX += added.offsetX;
            req.roam.offsetY += added.offsetY;
            if (lensRoamShutterTicks > 0.0) {
                constexpr int n = motionblur::kDenseSamples;
                auto addedAt = [&](int k) {
                    return lr->roamAt(te.trackId,
                        frameTick + motionblur::sampleOffset(k, n) * lensRoamShutterTicks);
                };
                if (req.roamMotionCount > 0) {
                    for (int k = 0; k < req.roamMotionCount; ++k) {
                        const RoamParams a = addedAt(k);
                        req.roamMotion[k].offsetX += a.offsetX;
                        req.roamMotion[k].offsetY += a.offsetY;
                    }
                } else {
                    const RoamParams a0 = addedAt(0), a1 = addedAt(n - 1);
                    if (a0.offsetX != added.offsetX || a0.offsetY != added.offsetY
                        || a1.offsetX != added.offsetX || a1.offsetY != added.offsetY) {
                        for (int k = 0; k < n; ++k) {
                            const RoamParams a = addedAt(k);
                            req.roamMotion[k] = req.roam;
                            req.roamMotion[k].offsetX += a.offsetX - added.offsetX;
                            req.roamMotion[k].offsetY += a.offsetY - added.offsetY;
                        }
                        req.roamMotionCount = n;
                    }
                }
            }

            // Tint: a multiply over the whole picture (white = none). Last in
            // the chain, so it colours what the chain made.
            if ((te.tintRgb & 0xFFFFFFu) != 0xFFFFFFu) {
                VisualEffect tint;
                tint.type      = VisualEffect::Type::Tint;
                tint.bypassed  = false;
                tint.params[0] = static_cast<float>((te.tintRgb >> 16) & 0xFF) / 255.0f;
                tint.params[1] = static_cast<float>((te.tintRgb >> 8) & 0xFF) / 255.0f;
                tint.params[2] = static_cast<float>(te.tintRgb & 0xFF) / 255.0f;
                tint.params[3] = 1.0f;     // strength
                tint.params[4] = -1.0f;    // lightness band: everything
                tint.params[5] = 2.0f;
                req.visualChain.push_back(tint);
            }
        }
    };

    // GC the hold-state map: keep entries only for tracks still placed as a
    // BehindGrid layer or a grid slot. Bounds the map size to the live layout
    // rather than every track ever assigned.
    //
    // A landing frame collects more than one layout, so LandingRenderer
    // suspends the GC for its carry collect and names the landing tracks as
    // kept for the others (see setHoldKeepTracks). On every other frame both
    // guards are inert and this block is what it always was.
    if (holdGcEnabled_) {
        std::unordered_set<int> holdableTrackIds;
        for (int i = 0; i < holdKeepCount_; ++i)
            holdableTrackIds.insert(holdKeepTracks_[i]);
        for (const auto& fl : layout.fullscreenLayers) {
            if (fl.placement == FullscreenLayerPlacement::BehindGrid && fl.trackId >= 0)
                holdableTrackIds.insert(fl.trackId);
        }
        for (const GridSlot& slot : layout.slots) {
            if (slot.trackId >= 0) holdableTrackIds.insert(slot.trackId);
        }
        for (auto it = holdByTrack_.begin(); it != holdByTrack_.end(); ) {
            if (!holdableTrackIds.count(it->first)) it = holdByTrack_.erase(it);
            else ++it;
        }
    }

    const int fullW = layout.columns * kGridSubUnitsPerColumn;
    const int fullH = layout.rows    * kGridSubUnitsPerRow;

    // ── Unified assembly ─────────────────────────────────────────────────────
    // Every video placement (grid cell AND fullscreen layer) is appended below
    // tagged with its own real, globally-comparable zOrder. The three sub-loops
    // exist only to gather the placements and preserve deterministic tie-break
    // order; the ACTUAL draw order is decided by the SINGLE stable_sort by zOrder
    // performed once at the end. There are no hardcoded sentinel zOrders anymore,
    // so a fullscreen layer whose zOrder sits between two grid cells' zOrders
    // sorts — and therefore renders — interleaved between them.

    // a) FULLSCREEN BEHIND LAYERS. Holds last frame during gaps when the track
    // has videoHoldLastFrame. zOrder is the layer's own global key.
    for (const auto& fl : layout.fullscreenLayers) {
        if (fl.placement != FullscreenLayerPlacement::BehindGrid) continue;
        if (fl.trackId < 0) continue;

        emitTrails(fl.trackId, 0, 0, fullW, fullH, fl.opacity, fl.zOrder,
                   CellLayerKind::FullscreenBehind);
        const VideoEvent* ev = activeEventFor(timeline, fl.trackId);
        if (buildRequest(ev, fl.trackId, 0, 0, fullW, fullH,
                         fl.opacity, fl.zOrder,
                         CellLayerKind::FullscreenBehind)) {
            // Active layer — hold-through-gap state already recorded inside
            // buildRequest (it runs regardless of the opacity cull, so a
            // frame invisible only because of a fade still updates the hold).
        } else if (!buildHeldRequest(fl.trackId, 0, 0, fullW, fullH,
                                     fl.opacity, fl.zOrder,
                                     CellLayerKind::FullscreenBehind)) {
            ++gapsSkipped;
        }
    }

    // b) GRID CELLS. Appended in layout.slots array order; the final stable_sort
    // orders them by zOrder while preserving array order for equal keys (exactly
    // the behavior of the old per-slot pre-sort, now folded into the one global
    // sort below).
    for (const GridSlot& slot : layout.slots) {
        if (slot.trackId < 0) { ++gapsSkipped; continue; }

        // A gap (no active event, or buildRequest could not resolve one) is
        // filled with the track's held frame when it has Hold Last Frame on,
        // exactly like a BehindGrid layer; otherwise the cell stays empty.
        emitTrails(slot.trackId, slot.gridX, slot.gridY, slot.spanX, slot.spanY,
                   slot.opacity, slot.zOrder, CellLayerKind::Grid);
        const VideoEvent* ev = activeEventFor(timeline, slot.trackId);
        if (!ev || !buildRequest(ev, slot.trackId,
                                 slot.gridX, slot.gridY, slot.spanX, slot.spanY,
                                 slot.opacity, slot.zOrder, CellLayerKind::Grid)) {
            if (!buildHeldRequest(slot.trackId,
                                  slot.gridX, slot.gridY, slot.spanX, slot.spanY,
                                  slot.opacity, slot.zOrder, CellLayerKind::Grid))
                ++gapsSkipped;
        }
    }

    // c) FULLSCREEN IN-FRONT LAYERS. Transient; no hold-through-gap. zOrder is
    // the layer's own global key.
    for (const auto& fl : layout.fullscreenLayers) {
        if (fl.placement != FullscreenLayerPlacement::InFrontOfGrid) continue;
        if (fl.trackId < 0) continue;

        emitTrails(fl.trackId, 0, 0, fullW, fullH, fl.opacity, fl.zOrder,
                   CellLayerKind::FullscreenInFront);
        const VideoEvent* ev = activeEventFor(timeline, fl.trackId);
        if (!buildRequest(ev, fl.trackId, 0, 0, fullW, fullH,
                          fl.opacity, fl.zOrder,
                          CellLayerKind::FullscreenInFront)) {
            ++gapsSkipped;
        }
    }

    // ── THE single global compositing sort ───────────────────────────────────
    // One stable_sort over the complete request list (grid cells AND fullscreen
    // layers together) by their shared zOrder. stable_sort keeps assembly order
    // for equal keys, so: behind-vs-behind and front-vs-front keep array order,
    // grid-vs-grid keep slot array order, and on an exact tie between a fullscreen
    // layer and a grid cell the assembly order (behind < grid < front) breaks it
    // deterministically. The compositor then draws requests in this exact order.
    //
    // Roam layers (spec: Bounds Float draws per layer) are a secondary key in
    // this same sort, so draw order is still decided in exactly one place. The
    // key is lensroam::roamDrawKey; when no request floats on a non-grid layer
    // (every project before Roam, and most after), the original zOrder-only
    // comparator runs untouched, so today's order cannot move.
    // Motion view R10: a Parent never changes a sort key, but a PARENTED cell
    // honours its Roam layer under Clip too (a carried cell can cover its
    // neighbours), so its layer counts as under Float. Unparented: unchanged.
    bool anyRoamLayer = false;
    int  maxGridZOrder = INT_MIN;
    for (const CellFrameRequest& r : requests) {
        if (r.layerKind == CellLayerKind::Grid) maxGridZOrder = std::max(maxGridZOrder, r.zOrder);
        if (lensroam::drawLayer(r.roam, r.parent.depth > 0) != RoamLayer::GridOrder) anyRoamLayer = true;
    }
    if (!anyRoamLayer) {
        std::stable_sort(requests.begin(), requests.end(),
            [](const CellFrameRequest& a, const CellFrameRequest& b) {
                return a.zOrder < b.zOrder;
            });
    } else {
        std::stable_sort(requests.begin(), requests.end(),
            [maxGridZOrder](const CellFrameRequest& a, const CellFrameRequest& b) {
                return lensroam::drawKeyFor(lensroam::drawLayer(a.roam, a.parent.depth > 0),
                                            a.zOrder, maxGridZOrder)
                     < lensroam::drawKeyFor(lensroam::drawLayer(b.roam, b.parent.depth > 0),
                                            b.zOrder, maxGridZOrder);
            });
    }

    XLETH_RENDER_LOG(std::fprintf(stderr,
                 "[FrameCollector] Collecting for output frame %lld: %d active cells, %d gaps skipped\n",
                 (long long)outputFrameIndex,
                 static_cast<int>(requests.size()),
                 gapsSkipped));

    return requests;
}

// ===========================================================================
// Step 2: Deduplicate
// ===========================================================================

std::unordered_map<FrameCacheKey, std::vector<CellFrameRequest*>, FrameCacheKeyHash>
FrameCollector::deduplicateRequests(std::vector<CellFrameRequest>& requests)
{
    std::unordered_map<FrameCacheKey, std::vector<CellFrameRequest*>, FrameCacheKeyHash> result;

    for (auto& req : requests) {
        FrameCacheKey key;
        key.sourcePath = req.sourcePath;
        key.frameIndex = req.sourceFrameIndex;
        result[key].push_back(&req);
    }

    // Also register secondary ping-pong frames so they are decoded alongside primary frames.
    // We insert with an empty pointer list — the compositor looks them up directly by key.
    for (auto& req : requests) {
        if (req.pingPongSecondaryFrame >= 0) {
            FrameCacheKey key2;
            key2.sourcePath = req.sourcePath;
            key2.frameIndex = req.pingPongSecondaryFrame;
            result[key2]; // default-construct empty vector if key is new
        }
    }

    XLETH_RENDER_LOG(std::fprintf(stderr,
                 "[FrameCollector] Dedup: %d cell requests -> %d unique frames to decode\n",
                 static_cast<int>(requests.size()),
                 static_cast<int>(result.size())));

    return result;
}

// ===========================================================================
// Step 3: Resolve (cache check)
// ===========================================================================

// ===========================================================================
// Motion blur: Zoom/pan/rot sub-frame poses
// ===========================================================================
//
// ZPR is NOT a function of the tick: it is CellAnimation state, triggered by
// notes and slides and advanced on absolute transport time. Every leg derives
// its progress from (now - trigger), so a sub-frame instant is evaluated by
// advancing a scratch COPY of the live state to that instant; the live state is
// never touched, so preview and export (each with its own AnimationManager)
// still see exactly the poses they did. Instants are visited in ascending
// order, so a window that ends inside the shutter latches where it really does.
// An instant before a trigger in this same frame reads the start pose (elapsed
// clamps to 0), which is what the frame itself shows.
//
// Governed by the track's OWN Zoom/pan/rot motion blur only, never by the
// project-wide setting. Skipped while no ZPR leg is running: a held or
// identity pose cannot move inside the shutter.
void FrameCollector::sampleZprMotion(CellFrameRequest& req, const CellAnimation& anim,
                                     const TrackInfo& trk, double fps)
{
    using namespace motionblur;
    const MotionBlurSettings& mb = trk.zoomPanRot.motionBlur;
    if (!mb.active()) return;
    if (!(anim.zprActive || anim.zprReturnActive || anim.zprCrossfadeActive
          || anim.slideZprActive || anim.slideZprReturnActive))
        return;
    const double shutterMs = 1000.0 * shutterSeconds(mb.shutterAngleDeg, fps);
    if (!(shutterMs > 0.0)) return;

    if (!zprMotionScratch_) zprMotionScratch_ = std::make_shared<CellAnimation>();
    CellAnimation& scratch = *zprMotionScratch_;
    scratch = anim;   // reuses the scratch's vector capacity

    const ZprPose center{ req.currentZoom, req.currentPanX, req.currentPanY, req.currentRotDeg };
    const double nowMs = anim.curNowMs;
    bool moved = false;
    for (int i = 0; i < kDenseSamples; ++i) {
        scratch.advance(nowMs + sampleOffset(i, kDenseSamples) * shutterMs);
        ZprPose& p = req.zprMotion[i];
        p.zoom   = scratch.currentZoom;
        p.panX   = scratch.currentPanX;
        p.panY   = scratch.currentPanY;
        p.rotDeg = scratch.currentRotDeg;
        moved = moved || (p != center);
    }
    req.zprMotionCount = moved ? kDenseSamples : 0;
}

std::vector<FrameCacheKey> FrameCollector::resolveFrames(
    const std::unordered_map<FrameCacheKey, std::vector<CellFrameRequest*>, FrameCacheKeyHash>& deduplicated,
    RenderFrameCache& cache)
{
    std::vector<FrameCacheKey> misses;
    int hits = 0;

    for (const auto& [key, cells] : deduplicated) {
        if (cache.get(key) != nullptr) {
            ++hits;
        } else {
            misses.push_back(key);
        }
    }

    XLETH_RENDER_LOG(std::fprintf(stderr, "[FrameCollector] Resolve: %d cache hits, %d decodes needed\n",
                 hits, static_cast<int>(misses.size())));

    // Detect sequential access patterns for the decoder hint.
    // If multiple misses are from the same source and their frame indices
    // form a contiguous run, flag it. Log-only (the decoder derives the
    // sequential case itself), so it only runs when render logging is on —
    // otherwise it built a string-keyed map per multi-miss frame for nothing.
    if (xlethRenderLogEnabled() && misses.size() > 1) {
        std::unordered_map<std::string, std::vector<int64_t>> missFramesBySource;
        for (const auto& k : misses) {
            missFramesBySource[k.sourcePath.str()].push_back(k.frameIndex);
        }
        for (auto& [path, frames] : missFramesBySource) {
            std::sort(frames.begin(), frames.end());
            bool sequential = true;
            for (size_t i = 1; i < frames.size(); ++i) {
                if (frames[i] - frames[i - 1] != 1) {
                    sequential = false;
                    break;
                }
            }
            if (sequential && frames.size() >= 2) {
                std::fprintf(stderr, "[FrameCollector] Sequential hint set for source '%s'\n",
                             path.c_str());
            }
        }
    }

    return misses;
}

// ===========================================================================
// Helpers
// ===========================================================================

namespace {

// The one ordering both event lookups use: the latest-starting active event
// wins; on an exact start tie the lowest pitch, then the lowest emission
// order. Same-tick note-ons (a chord) all carry the same resolved flip state,
// so any member draws an identical orientation — the tie-break only has to be
// deterministic. Strict, so the first event seen keeps an exact tie.
bool activeEventBeats(const VideoEvent& ev, const VideoEvent& best) noexcept
{
    return ev.startBeat > best.startBeat
        || (ev.startBeat == best.startBeat
            && (ev.pitch < best.pitch
                || (ev.pitch == best.pitch
                    && ev.originalEmissionOrder < best.originalEmissionOrder)));
}

} // namespace

const VideoEvent* FrameCollector::findActiveEvent(
    const std::vector<VideoEvent>& events,
    const Timeline&                timeline,
    int                            trackId,
    double                         beatPos)
{
    if (trackId < 0) return nullptr;

    // Check muted
    const TrackInfo* track = timeline.getTrack(trackId);
    if (track && track->muted) return nullptr;

    const VideoEvent* best = nullptr;
    for (const auto& ev : events) {
        if (ev.trackId != trackId) continue;
        if (beatPos < ev.startBeat) continue;
        if (beatPos >= ev.startBeat + ev.durationBeats) continue;
        if (!best || activeEventBeats(ev, *best)) best = &ev;
    }
    return best;
}

void FrameCollector::resolveActiveEvents(const std::vector<VideoEvent>& events,
                                         double beatPos)
{
    activeByTrack_.clear();
    // Order-sensitive fingerprint of the event timing, so gapFor's lazily
    // built index can tell when the event list changed. A few integer ops per
    // event riding the scan that already happens.
    uint64_t fp = 1469598103934665603ull ^ static_cast<uint64_t>(events.size());
    auto mix = [&fp](uint64_t v) { fp = (fp ^ v) * 1099511628211ull; };
    for (const auto& ev : events) {
        uint64_t sb, db;
        std::memcpy(&sb, &ev.startBeat, sizeof sb);
        std::memcpy(&db, &ev.durationBeats, sizeof db);
        mix(sb); mix(db); mix(static_cast<uint64_t>(static_cast<uint32_t>(ev.trackId)));
        // Window test first: it rejects nearly every event with no lookup.
        if (beatPos < ev.startBeat) continue;
        if (beatPos >= ev.startBeat + ev.durationBeats) continue;
        if (ev.trackId < 0) continue;
        auto [it, inserted] = activeByTrack_.try_emplace(ev.trackId, &ev);
        if (!inserted && activeEventBeats(ev, *it->second)) it->second = &ev;
    }
    eventsFingerprint_ = fp;
}

FrameCollector::GapInfo FrameCollector::gapFor(const std::vector<VideoEvent>& events,
                                               int trackId, double beatPos)
{
    if (gapIndexFingerprint_ != eventsFingerprint_) {
        gapIndexByTrack_.clear();
        gapIndexFingerprint_ = eventsFingerprint_;
    }
    auto [it, inserted] = gapIndexByTrack_.try_emplace(trackId);
    TrackGapIndex& idx = it->second;
    if (inserted) {
        // Built once per (track, event list): sort this track's events by
        // start, merge overlaps (a chord is one busy span), remember which
        // event ends each span.
        std::vector<size_t> order;
        for (size_t i = 0; i < events.size(); ++i) {
            const VideoEvent& ev = events[i];
            if (ev.trackId == trackId && ev.durationBeats > 0.0
                && std::isfinite(ev.startBeat) && std::isfinite(ev.durationBeats))
                order.push_back(i);
        }
        std::sort(order.begin(), order.end(), [&](size_t a, size_t b) {
            return events[a].startBeat < events[b].startBeat;
        });
        std::vector<double> gaps;
        for (size_t i : order) {
            const VideoEvent& ev = events[i];
            const double s = ev.startBeat, e = ev.startBeat + ev.durationBeats;
            if (idx.end.empty() || s > idx.end.back() + xleth::smarthold::kGapEpsilonBeats) {
                if (!idx.end.empty()) gaps.push_back(s - idx.end.back());
                idx.start.push_back(s);
                idx.end.push_back(e);
                idx.lastEvent.push_back(i);
            } else if (e >= idx.end.back()) {
                idx.end.back() = e;
                idx.lastEvent.back() = i;
            }
        }
        idx.smartThreshold = xleth::smarthold::thresholdBeats(std::move(gaps));
    }

    GapInfo g;
    g.smartThreshold = idx.smartThreshold;
    g.nextStart = std::numeric_limits<double>::infinity();
    // The last busy span that has ended by beatPos.
    const auto ub = std::upper_bound(idx.end.begin(), idx.end.end(), beatPos);
    const size_t k = static_cast<size_t>(ub - idx.end.begin());   // spans [0, k) ended
    if (k > 0) {
        g.prev    = &events[idx.lastEvent[k - 1]];
        g.prevEnd = idx.end[k - 1];
    }
    if (k < idx.start.size()) g.nextStart = idx.start[k];
    return g;
}

const VideoEvent* FrameCollector::activeEventFor(const Timeline& timeline, int trackId) const
{
    if (trackId < 0) return nullptr;
    const TrackInfo* track = timeline.getTrack(trackId);
    if (track && track->muted) return nullptr;
    auto it = activeByTrack_.find(trackId);
    return it == activeByTrack_.end() ? nullptr : it->second;
}

const VideoEvent* FrameCollector::activeEventAt(const std::vector<VideoEvent>& events,
                                                int trackId, double beatPos)
{
    if (trackId < 0 || !std::isfinite(beatPos)) return nullptr;
    if (eventIndexFingerprint_ != eventsFingerprint_) {
        eventIndexByTrack_.clear();
        eventIndexFingerprint_ = eventsFingerprint_;
    }
    auto [it, inserted] = eventIndexByTrack_.try_emplace(trackId);
    TrackEventIndex& idx = it->second;
    if (inserted) {
        for (size_t i = 0; i < events.size(); ++i) {
            const VideoEvent& ev = events[i];
            if (ev.trackId != trackId || !(ev.durationBeats > 0.0)
                || !std::isfinite(ev.startBeat) || !std::isfinite(ev.durationBeats))
                continue;
            idx.byStart.push_back(i);
            idx.maxDuration = std::max(idx.maxDuration, ev.durationBeats);
        }
        std::stable_sort(idx.byStart.begin(), idx.byStart.end(), [&](size_t a, size_t b) {
            return events[a].startBeat < events[b].startBeat;
        });
    }
    // Candidates start in (beatPos - maxDuration, beatPos]: walk back from the
    // last one that has started. Same window test and tie-break as
    // resolveActiveEvents (the first event in list order keeps an exact tie).
    const auto ub = std::upper_bound(idx.byStart.begin(), idx.byStart.end(), beatPos,
        [&](double b, size_t i) { return b < events[i].startBeat; });
    const VideoEvent* best = nullptr;
    size_t bestIndex = 0;
    for (auto p = ub; p != idx.byStart.begin(); ) {
        --p;
        const VideoEvent& ev = events[*p];
        if (ev.startBeat < beatPos - idx.maxDuration) break;
        if (beatPos >= ev.startBeat + ev.durationBeats) continue;
        if (!best || activeEventBeats(ev, *best)
            || (!activeEventBeats(*best, ev) && *p < bestIndex)) {
            best = &ev;
            bestIndex = *p;
        }
    }
    return best;
}

int64_t FrameCollector::computeSourceFrame(
    const VideoEvent& ev,
    double            beatPos,
    double            bpm,
    int               sampleRate,
    AVRational        sourceRate)
{
    return computeSourceFrameFromTime(
        computeSourceTime(ev, beatPos, bpm, sampleRate, av_q2d(sourceRate)),
        sourceRate);
}

double FrameCollector::computeSourceTime(
    const VideoEvent& ev,
    double            beatPos,
    double            bpm,
    int               sampleRate,
    double            sourceFps)
{
    const auto timingCtx = makeVideoTimingContext(
        ev, beatPos, bpm, sampleRate, sourceFps);
    const auto timing = xleth::clipmod::evaluateVideoClipModulationTiming(
        ev.modulation, timingCtx, isVideoModulationCompatible(ev));
    return timing.sourceTimeSeconds;
}

int64_t FrameCollector::computeSourceFrameFromTime(double sourceTimeSec, AVRational sourceRate)
{
    // Source time (seconds) → source frame index, FLOOR semantics: frame N is the
    // frame whose interval [N/fps, (N+1)/fps) contains t.
    //
    // Two things were wrong here before:
    //
    //  1. The rate was reconstructed as round(fps*1000)/1000, so 24000/1001
    //     became 23976/1000 — close, but not the same rate RenderVideoDecoder
    //     converts back with, which is exactly what makes a round trip drift.
    //     It now takes the source's exact rational, the same one the decoder
    //     uses, so both directions are bit-identical.
    //
    //  2. av_rescale defaults to AV_ROUND_NEAR_INF, i.e. round-to-nearest, so
    //     any time past the midpoint of a frame returned the NEXT frame. The
    //     region picker in the UI is a Chromium <video> element and uses floor
    //     semantics, so the engine disagreed with the picker by one frame for
    //     roughly half of all pick positions. Concretely, at t = 916.7734480660205
    //     in a 24000/1001 source the picker shows frame 21980 and this function
    //     used to request 21981.
    //
    // See engine/src/render/FrameRateMath.h. Negative times clamp to 0.
    return xleth::frametiming::timeToFrameFloor(sourceTimeSec, sourceRate);
}

// ===========================================================================
// Ping-Pong frame computation
// ===========================================================================

int64_t FrameCollector::computePingPongFrame(
    const VideoEvent&       ev,
    double                  beatPos,
    double                  bpm,
    int                     sampleRate,
    AVRational              sourceRate,
    const PingPongSettings& pp,
    int64_t&                outSecondaryFrame,
    float&                  outBlendFactor)
{
    outSecondaryFrame = -1;
    outBlendFactor    = 0.0f;

    // Frame-index conversion below goes through sourceRate (exact); the plain
    // double is only used for the sub-frame crossfade/clamp arithmetic, where a
    // rational buys nothing.
    const double sourceFps = av_q2d(sourceRate);

    double sourceTime = computeSourceTime(ev, beatPos, bpm, sampleRate, sourceFps);

    const double clipLen = ev.sourceEndTime - ev.sourceStartTime;
    if (clipLen <= 0.0)
        return computeSourceFrameFromTime(sourceTime, sourceRate);

    const double regionStart = ev.sourceStartTime + clipLen * pp.regionStartPct;
    const double regionLen   = clipLen * (pp.regionEndPct - pp.regionStartPct);
    if (regionLen <= 0.0)
        return computeSourceFrameFromTime(sourceTime, sourceRate);

    // Before bounce region: play forward normally
    if (sourceTime < regionStart)
        return computeSourceFrameFromTime(sourceTime, sourceRate);

    double posInRegion = sourceTime - regionStart;

    const double fwdLen   = regionLen;
    const double revLen   = regionLen / std::max(static_cast<double>(pp.reverseSpeed), 0.001);
    const double cycleLen = fwdLen + revLen;

    int loopCount = (cycleLen > 0.0) ? static_cast<int>(posInRegion / cycleLen) : 0;

    // maxLoops > 0: hold at boundary after exhausting loops
    if (pp.maxLoops > 0 && loopCount >= pp.maxLoops) {
        bool   holdAtEnd = ((pp.maxLoops % 2) == 0);
        double holdTime  = holdAtEnd ? (regionStart + regionLen) : regionStart;
        return computeSourceFrameFromTime(holdTime, sourceRate);
    }

    double posInCycle = std::fmod(posInRegion, cycleLen);
    bool   reversing  = (posInCycle >= fwdLen);
    double primaryTime;
    const double clampLo = std::isfinite(ev.sourceClampStartTime)
        ? ev.sourceClampStartTime : ev.sourceStartTime;
    const double clampHi = (sourceFps > 0.0 && ev.sourceEndTime > clampLo)
        ? std::max(clampLo, ev.sourceEndTime - 0.5 / sourceFps)
        : ev.sourceEndTime;

    if (!reversing) {
        primaryTime = regionStart + posInCycle;
    } else {
        double revPos = (posInCycle - fwdLen) / std::max(revLen, 0.001);
        primaryTime = regionStart + regionLen * (1.0 - revPos);
    }
    primaryTime = std::clamp(primaryTime, clampLo, clampHi);

    // Crossfade near direction-change boundaries
    if (pp.crossfadeFrames > 0 && sourceFps > 0.0) {
        const double cfSec     = pp.crossfadeFrames / sourceFps;
        double distStart       = std::abs(posInCycle);
        double distEnd         = std::abs(posInCycle - fwdLen);
        double distNearest     = std::min(distStart, distEnd);

        if (distNearest < cfSec) {
            float blend = static_cast<float>(distNearest / cfSec); // 0=at boundary, 1=away
            double secondaryTime;
            if (distEnd < distStart) {
                // Near regionEnd: secondary mirrors back into the forward pass
                secondaryTime = primaryTime - (cfSec - distNearest) * 2.0;
            } else {
                // Near regionStart: secondary mirrors forward past the boundary
                secondaryTime = primaryTime + (cfSec - distNearest) * 2.0;
            }
            secondaryTime = std::clamp(secondaryTime, clampLo, clampHi);
            outSecondaryFrame = computeSourceFrameFromTime(secondaryTime, sourceRate);
            outBlendFactor    = 1.0f - blend; // 1=full secondary at boundary, 0=full primary away
        }
    }

    return computeSourceFrameFromTime(primaryTime, sourceRate);
}
