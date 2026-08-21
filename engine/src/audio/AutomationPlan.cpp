#include "AutomationPlan.h"

#include "model/AutomationEnvelope.h"
#include "model/Timeline.h"

#include <algorithm>
#include <cmath>
#include <map>

namespace xleth::automation {

namespace {

// A clip resolved against its lane and envelope, before overlap resolution.
struct Candidate {
    int64_t startTick  = 0;
    int64_t endTick    = 0;
    int64_t originTick = 0;
    int     laneIndex  = 0;   // lower == topmost == wins
    int     laneId     = 0;
    int     clipId     = 0;
    const AutomationEnvelope* envelope = nullptr;
};

// Priority order for "topmost lane wins". Lane index is the spec's rule; laneId
// then clipId only break ties so that two lanes sharing an index (possible after
// a hand-edited file) still resolve deterministically instead of depending on
// map iteration order.
bool higherPriority(const Candidate& a, const Candidate& b)
{
    if (a.laneIndex != b.laneIndex) return a.laneIndex < b.laneIndex;
    if (a.laneId    != b.laneId)    return a.laneId    < b.laneId;
    return a.clipId < b.clipId;
}

} // namespace

// ===========================================================================
// Build (MAIN THREAD)
// ===========================================================================

void buildAutomationPlan(const Timeline& timeline,
                         const AutomationBindingResolver& resolver,
                         const AutomationBaseValueResolver& baseResolver,
                         AutomationPlan& out)
{
    out.targetCount = 0;
    out.windowCount = 0;
    out.pointCount  = 0;
    out.overflowed  = false;
    out.droppedTargetCount = 0;
    out.droppedWindowCount = 0;
    out.unresolvedClipCount = 0;

    // ── 1. Group clips by BINDING, not by lane ───────────────────────────────
    // std::map keeps target order stable across builds (AutomationBinding has a
    // strict weak ordering), which keeps a plan swap from renumbering targets
    // for no reason and makes the diagnostics reproducible.
    std::map<AutomationBinding, std::vector<Candidate>> byBinding;

    for (const AutomationClip* clip : timeline.getAllAutomationClips()) {
        if (clip == nullptr) continue;
        if (clip->duration.ticks <= 0) continue;   // no coverage, nothing to plan

        const AutomationLane* lane = timeline.getAutomationLane(clip->laneId);
        if (lane == nullptr) continue;             // orphan clip — fail closed

        const AutomationEnvelope* env = timeline.getAutomationEnvelope(clip->envelopeId);
        if (env == nullptr) continue;              // orphan clip — fail closed

        if (!env->binding.valid()) { ++out.unresolvedClipCount; continue; }

        // Dead clip: the effect instance this envelope names is not on any live
        // chain (deleted effect, project loaded on a machine without it). It is
        // deliberately PRESERVED in the model and simply absent from the plan.
        if (resolver && !resolver(env->binding)) { ++out.unresolvedClipCount; continue; }

        Candidate c;
        c.startTick  = clip->position.ticks;
        c.endTick    = clip->endTick().ticks;
        c.originTick = clip->originTick().ticks;
        c.laneIndex  = lane->index;
        c.laneId     = lane->id;
        c.clipId     = clip->id;
        c.envelope   = env;
        byBinding[env->binding].push_back(c);
    }

    // ── 2. One target per binding; resolve overlap into ordered windows ──────
    for (const auto& [binding, candidatesConst] : byBinding) {
        if (out.targetCount >= kMaxAutomationTargets) {
            out.overflowed = true;
            ++out.droppedTargetCount;
            continue;
        }

        std::vector<Candidate> candidates = candidatesConst;

        // Elementary intervals: every start and end is a boundary. Between two
        // adjacent boundaries the covering set cannot change, so one priority
        // comparison per elementary interval settles the whole overlap question.
        std::vector<int64_t> bounds;
        bounds.reserve(candidates.size() * 2);
        for (const auto& c : candidates) { bounds.push_back(c.startTick); bounds.push_back(c.endTick); }
        std::sort(bounds.begin(), bounds.end());
        bounds.erase(std::unique(bounds.begin(), bounds.end()), bounds.end());

        // Winner per elementary interval, then merged across adjacent intervals
        // that the same clip won contiguously.
        struct ResolvedWindow { int64_t start; int64_t end; const Candidate* c; };
        std::vector<ResolvedWindow> resolved;

        for (std::size_t i = 0; i + 1 < bounds.size(); ++i) {
            const int64_t s = bounds[i];
            const int64_t e = bounds[i + 1];
            const Candidate* winner = nullptr;
            for (const auto& c : candidates) {
                if (c.startTick > s || c.endTick <= s) continue;   // does not cover [s,e)
                if (winner == nullptr || higherPriority(c, *winner)) winner = &c;
            }
            if (winner == nullptr) continue;

            if (!resolved.empty() && resolved.back().c == winner && resolved.back().end == s)
                resolved.back().end = e;             // contiguous continuation
            else
                resolved.push_back({s, e, winner});
        }

        AutomationTarget target;
        target.ownerTrackId     = binding.ownerTrackId;
        target.effectInstanceId = binding.effectInstanceId;
        target.parameterId      = binding.parameterId;

        // Base value: the persisted manual value wins (it IS the knob position
        // the user last set outside every clip). Only when the project has never
        // recorded one do we ask the engine for the parameter's live value.
        bool haveBase = false;
        target.baseValue = timeline.getAutomationBaseValue(binding, &haveBase);
        if (!haveBase) {
            double live = 0.0;
            if (baseResolver && baseResolver(binding, live) && std::isfinite(live))
                target.baseValue = std::clamp(live, 0.0, 1.0);
            else
                target.baseValue = 0.0;
        }

        target.windowOffset = out.windowCount;
        target.windowCount  = 0;

        for (const auto& rw : resolved) {
            if (out.windowCount >= kMaxAutomationWindows) {
                out.overflowed = true;
                ++out.droppedWindowCount;
                continue;
            }
            const auto& pts = rw.c->envelope->points;
            const int n = static_cast<int>(pts.size());
            if (out.pointCount + n > kMaxAutomationPoints) {
                out.overflowed = true;
                ++out.droppedWindowCount;
                continue;
            }

            AutomationWindow& w = out.windows[out.windowCount];
            w.startTick   = rw.start;
            w.endTick     = rw.end;
            w.originTick  = rw.c->originTick;
            w.pointOffset = out.pointCount;
            w.pointCount  = n;
            w.clipId      = rw.c->clipId;
            w.laneId      = rw.c->laneId;

            for (int k = 0; k < n; ++k) out.points[out.pointCount + k] = pts[static_cast<std::size_t>(k)];
            out.pointCount += n;

            // The value held from endTick onwards. For a clip that runs past its
            // last point this is exactly that last point's value (evaluatePointRange
            // clamps); for a clip cut short by a topmost overlapping clip it is
            // the value the envelope actually reached at the cut.
            w.holdValue = evaluatePointRange(out.points + w.pointOffset, w.pointCount,
                                             w.endTick - w.originTick, target.baseValue);

            ++out.windowCount;
            ++target.windowCount;
        }

        out.targets[out.targetCount] = std::move(target);
        ++out.targetCount;
    }
}

// ===========================================================================
// Evaluation (AUDIO THREAD)
// ===========================================================================

double evaluateTarget(const AutomationPlan& plan, int targetIndex, int64_t tick) noexcept
{
    if (targetIndex < 0 || targetIndex >= plan.targetCount) return 0.0;
    const AutomationTarget& t = plan.targets[targetIndex];
    if (t.windowCount <= 0) return t.baseValue;

    const AutomationWindow* w0 = plan.windows + t.windowOffset;

    // Windows are non-overlapping and ascending by startTick (guaranteed by the
    // builder), so one binary search answers "covering window, else the last one
    // that already ended, else nothing".
    if (tick < w0[0].startTick) return t.baseValue;   // nothing has played yet

    int lo = 0, hi = t.windowCount - 1;
    while (lo < hi) {
        const int mid = lo + (hi - lo + 1) / 2;
        if (w0[mid].startTick <= tick) lo = mid;
        else                           hi = mid - 1;
    }

    const AutomationWindow& w = w0[lo];
    if (tick < w.endTick) {
        return evaluatePointRange(plan.points + w.pointOffset, w.pointCount,
                                  tick - w.originTick, t.baseValue);
    }
    // In the gap after this window: hold what it left behind.
    return w.holdValue;
}

int64_t tickAtSamplePosition(int64_t positionSamples, double bpm, double sampleRate) noexcept
{
    if (!(bpm > 0.0) || !(sampleRate > 0.0)) return 0;
    // beats = samples / sampleRate * bpm / 60 ; ticks = beats * 960.
    // floor() (not round) so a tick boundary is entered exactly when the
    // transport reaches it, and never one block early.
    const double beats = (static_cast<double>(positionSamples) / sampleRate) * (bpm / 60.0);
    return static_cast<int64_t>(std::floor(beats * 960.0));
}

} // namespace xleth::automation
