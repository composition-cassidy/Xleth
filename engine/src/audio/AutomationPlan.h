#pragma once

// ===========================================================================
// AutomationPlan — flattened, fixed-capacity, allocation-free automation plan.
// ===========================================================================
//
// The automation-clip analogue of RoutePlan / SidechainPlan (audio/TrackRouting.h)
// and it follows that idiom exactly:
//
//   • built on the MAIN thread from the Timeline, once per automation mutation;
//   • FIXED capacity, so building never allocates inside the plan and the audio
//     thread never touches a std::vector, a map, or a std::string;
//   • FAIL-CLOSED: anything that cannot be represented (unknown lane, missing
//     envelope, capacity exhausted) is dropped from the plan and reported in a
//     diagnostic flag rather than silently half-applied;
//   • the audio thread only ever READS it, through evaluateTarget().
//
// ─── What the build collapses ────────────────────────────────────────────────
//
// The model is (lane, clip, envelope) with cross-lane priority; the runtime
// wants "for this parameter, at this tick, what value?". The builder collapses
// the first into the second ONCE, on the main thread:
//
//   1. clips are grouped by their envelope's BINDING, not by lane — two lanes
//      automating the same parameter feed one target;
//   2. cross-lane overlap is resolved at build time by lane index (lowest ==
//      topmost wins), producing a NON-OVERLAPPING, tick-ordered window list;
//   3. each window carries a precomputed holdValue — the value to hold from the
//      moment the window ends until the next one starts.
//
// So the audio thread's job per parameter per block is one binary search plus a
// lerp. Nothing about priority, lanes, or clip identity survives into it.
//
// ─── Determinism ─────────────────────────────────────────────────────────────
//
// evaluateTarget() is a pure function of (plan, targetIndex, tick). It reads no
// clock, holds no state, and allocates nothing, so live playback and
// OfflineRenderer export evaluating the same tick against the same project
// state cannot disagree — the export-parity requirement is structural here, not
// a property that has to be re-tested per call site.

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "model/TimelineTypes.h"

class Timeline;

namespace xleth::automation {

// ─── Capacities ──────────────────────────────────────────────────────────────
// Sized to be generous for a real project while keeping the plan a single fixed
// allocation (~300 KB) that is published by pointer swap. Overflow is reported,
// never silently truncated mid-target: see AutomationPlan::overflowed.
inline constexpr int kMaxAutomationTargets = 128;    // distinct bound parameters
inline constexpr int kMaxAutomationWindows = 1024;   // resolved clip windows, all targets
inline constexpr int kMaxAutomationPoints  = 8192;   // flattened points, all windows

// One resolved, non-overlapping stretch of timeline during which exactly one
// clip's envelope drives the target.
struct AutomationWindow {
    int64_t startTick  = 0;   // inclusive
    int64_t endTick    = 0;   // exclusive
    int64_t originTick = 0;   // timeline tick of the envelope's intra-clip tick 0
    int     pointOffset = 0;  // into AutomationPlan::points
    int     pointCount  = 0;
    double  holdValue   = 0.0; // value held from endTick until the next window

    // Diagnostics only — never read on the audio thread.
    int clipId = -1;
    int laneId = -1;
};

// One automated parameter.
struct AutomationTarget {
    // Identity. Strings are read on the MAIN thread only (plan build, parameter
    // resolution, diagnostics); the audio thread addresses a target by index.
    int         ownerTrackId = -1;   // -1 = Master chain
    std::string effectInstanceId;
    std::string parameterId;

    // The parameter's manual value — what it reads before any clip has played.
    double baseValue = 0.0;

    int windowOffset = 0;   // into AutomationPlan::windows
    int windowCount  = 0;
};

// ~400 KB by construction (see the capacities above). ALWAYS heap-allocate it:
// MixEngine holds it behind a shared_ptr and publishes it by pointer swap, and
// two of these as stack locals overflow Windows' 1 MB default thread stack.
struct AutomationPlan {
    int targetCount = 0;
    int windowCount = 0;
    int pointCount  = 0;

    AutomationTarget targets[kMaxAutomationTargets];
    AutomationWindow windows[kMaxAutomationWindows];
    AutomationPoint  points [kMaxAutomationPoints];

    // ── Fail-closed diagnostics ──────────────────────────────────────────────
    // A project that fits the capacities above leaves all of these clear.
    bool overflowed = false;          // ≥1 target/window/point did not fit
    int  droppedTargetCount = 0;      // targets left out entirely
    int  droppedWindowCount = 0;      // windows left out (their target is partial)
    // Clips whose envelope binding did not resolve to a live effect instance.
    // These are DEAD CLIPS, not errors: they stay in the project file and in the
    // Timeline, and simply contribute nothing to the runtime plan.
    int  unresolvedClipCount = 0;

    bool empty() const { return targetCount == 0; }
};

// ─── Binding resolution ──────────────────────────────────────────────────────
// Answers "does this binding address a live stock-effect parameter right now?".
// The only piece of engine state the pure model cannot see. MixEngine builds it
// from its chain lookup; a pure-model test passes an empty std::function, which
// means "resolve everything" (model-only build, no dead clips).
using AutomationBindingResolver = std::function<bool(const AutomationBinding&)>;

// Supplies the parameter's CURRENT value for a binding that has no persisted
// base value yet — i.e. the knob position at the moment the plan is built.
// Returns false when it cannot answer, in which case the base falls back to 0.
// Empty std::function behaves like "cannot answer".
using AutomationBaseValueResolver =
    std::function<bool(const AutomationBinding&, double& outValue)>;

// Build the plan from the timeline's automation model. MAIN THREAD ONLY (it
// reads std::map collections and constructs std::strings). `out` is fully
// overwritten, including its diagnostics.
void buildAutomationPlan(const Timeline& timeline,
                         const AutomationBindingResolver& resolver,
                         const AutomationBaseValueResolver& baseResolver,
                         AutomationPlan& out);

// ─── Evaluation (AUDIO THREAD) ───────────────────────────────────────────────
//
// The value of target `targetIndex` at timeline tick `tick`:
//   • a window covers tick        -> its envelope's value there;
//   • tick is past a window's end -> that window's precomputed holdValue
//                                    (the last point's value for an untrimmed
//                                    clip), held across any gap;
//   • tick precedes every window  -> the target's baseValue.
//
// A window starting exactly at `tick` takes over instantly at its first point —
// that is the same branch as "a window covers tick", not a special case.
//
// No allocation, no locks, no logging. Out-of-range targetIndex returns 0.0.
double evaluateTarget(const AutomationPlan& plan, int targetIndex, int64_t tick) noexcept;

// Timeline tick at an absolute transport sample position. Pure integer-stable
// math shared by live playback and offline export so both land on the same tick
// for the same position — the export-parity requirement in one place.
// Returns 0 for a non-positive bpm or sampleRate.
int64_t tickAtSamplePosition(int64_t positionSamples, double bpm, double sampleRate) noexcept;

} // namespace xleth::automation
