#pragma once

#include "../model/SamplerModulationConfig.h"

#include <algorithm>
#include <cmath>
#include <cstdint>

// ─── Sampler modulation — compilation and evaluation ─────────────────────────
// The DSP half of the modulation system. Everything here is header-only, POD,
// fixed-size and free of allocation, locks and logging: the audio thread calls
// straight into it.
//
// ── Control rate ─────────────────────────────────────────────────────────────
// Sources are evaluated once every kControlBlockSamples (32) samples and their
// values held for the block. Per-voice sources use a VOICE-relative counter, so
// an envelope's timing is independent of the host buffer size; global (FREE and
// MONO) sources use the sampler's own render clock so every voice in a block
// reads the same instance.
//
// ── Dependency order and cycles ──────────────────────────────────────────────
// A route whose target is a cross-modulation target (SrcRate, SrcPhase,
// SrcRise, SrcDelay, SrcSmooth, SrcAmount, EnvStageTime) is a dependency edge:
// the TARGET source needs the SOURCE source's value before it can be evaluated.
// compileModGraph() orders the sources so that, wherever possible, a source is
// evaluated after everything it depends on.
//
// CYCLES ARE LEGAL. When the ordering cannot satisfy an edge — LFO1 modulates
// LFO2's rate and LFO2 modulates LFO1's rate, or a source modulates itself —
// the edge is marked `deferred` and reads the source's value from the PREVIOUS
// control block instead of this one. That is the documented contract:
//
//     A cyclic route resolves with EXACTLY ONE control block (32 samples,
//     0.67 ms at 48 kHz) of latency. It never deadlocks, never iterates to a
//     fixed point, and never diverges: the feedback path is a plain unit delay.
//
// The same rule covers the per-voice → global direction. A global source is one
// shared instance but a per-voice source has one value per voice, so a route
// from a per-voice source into a global source's parameter reads the snapshot
// published by the most recently started voice, one block late.

namespace xleth::sampmod {

// ── Shared shaping primitives ────────────────────────────────────────────────

// The legacy sampler envelope's tension law, reproduced exactly so a ModEnv set
// to the same times and tensions as the built-in envelope traces the same curve.
// t^(2^(-2·tension)): 0 = linear, POSITIVE bends the curve UP (exponent < 1, so
// the segment covers most of its range early), NEGATIVE bends it DOWN.
inline float shapeTension(float t, float tension) noexcept
{
    if (std::abs(tension) < 0.001f) return t;
    const float exponent = std::pow(2.0f, -tension * 2.0f);
    return std::pow(t, exponent);
}

// Hermite smoothstep. Zero derivative at both ends — which is precisely what
// SMOOTH needs: it rounds a corner without moving the endpoints.
inline float smoothStep01(float f) noexcept
{
    if (f <= 0.0f) return 0.0f;
    if (f >= 1.0f) return 1.0f;
    return f * f * (3.0f - 2.0f * f);
}

inline double pow2d(float octaves) noexcept
{
    return std::pow(2.0, static_cast<double>(octaves));
}

// ── LFO shape evaluation ─────────────────────────────────────────────────────
//
// SMOOTH (0..1 here, 0..100 in the config) morphs SEGMENT CURVATURE. It is not
// a filter, and deliberately so:
//
//   * LINE / CURVE — the segment's interpolation fraction is blended toward
//     smoothStep01, so the segment leaves and arrives at its endpoints with
//     zero slope. The breakpoint VALUES never move.
//   * STEP — the jump is widened into a smoothstep ramp occupying the last
//     `smooth` fraction of the segment. At smooth = 0 the width is 0 and the
//     step is exact; at smooth = 1 it spans the whole segment and matches what
//     a fully smoothed LINE segment does.
//
// Both branches multiply (v1 - v0). A PLATEAU — two consecutive points at the
// same value — therefore stays EXACTLY flat at every smooth setting, which a
// low-pass over the rendered shape could never guarantee.
inline float lfoSegmentFraction(float f, int segment, float tension, float smooth) noexcept
{
    f = std::clamp(f, 0.0f, 1.0f);
    smooth = std::clamp(smooth, 0.0f, 1.0f);

    if (segment == static_cast<int>(LfoSegment::Step)) {
        if (smooth <= 1.0e-6f) return 0.0f;           // hold; the jump is at the next point
        const float knee = 1.0f - smooth;
        if (f <= knee) return 0.0f;
        return smoothStep01((f - knee) / smooth);
    }

    const float shaped = (segment == static_cast<int>(LfoSegment::Curve))
                       ? shapeTension(f, tension)
                       : f;
    if (smooth <= 1.0e-6f) return shaped;
    return shaped + (smoothStep01(f) - shaped) * smooth;
}

// Evaluate one cycle of the shape at `phase` (already wrapped into [0,1]).
// numPoints == 0 is the built-in sine; numPoints == 1 is a constant.
inline float evalLfoShape(const ModLfoConfig& c, float phase, float smooth) noexcept
{
    const int n = std::clamp(c.numPoints, 0, kMaxLfoPoints);
    if (n == 0) return std::sin(phase * 6.28318530717958647692f);
    if (n == 1) return c.points[0].value;

    phase = std::clamp(phase, 0.0f, 1.0f);

    // Locate the segment. The list is cyclic: the last point's segment wraps
    // round to the first, and a phase below the first point's time falls in
    // that same wrap segment (shifted back by one cycle).
    int i = -1;
    for (int k = 0; k < n; ++k) {
        if (c.points[static_cast<size_t>(k)].time <= phase) i = k; else break;
    }

    float t0, v0, t1, v1, tension;
    int   segment;
    if (i < 0) {
        const auto& last  = c.points[static_cast<size_t>(n - 1)];
        const auto& first = c.points[0];
        t0 = last.time - 1.0f; v0 = last.value;
        t1 = first.time;       v1 = first.value;
        segment = last.segment; tension = last.tension;
    } else if (i == n - 1) {
        const auto& last  = c.points[static_cast<size_t>(n - 1)];
        const auto& first = c.points[0];
        t0 = last.time;         v0 = last.value;
        t1 = first.time + 1.0f; v1 = first.value;
        segment = last.segment; tension = last.tension;
    } else {
        const auto& a = c.points[static_cast<size_t>(i)];
        const auto& b = c.points[static_cast<size_t>(i + 1)];
        t0 = a.time; v0 = a.value;
        t1 = b.time; v1 = b.value;
        segment = a.segment; tension = a.tension;
    }

    const float span = t1 - t0;
    const float f    = (span > 1.0e-9f) ? (phase - t0) / span : 0.0f;
    return v0 + (v1 - v0) * lfoSegmentFraction(f, segment, tension, smooth);
}

// ── Response curve evaluation (VELO / NOTE) ──────────────────────────────────
// Fewer than two points means IDENTITY, so an untouched VELO source is exactly
// raw velocity and an untouched NOTE source is exactly note / 127.
inline float evalModCurve(const ModCurveConfig& c, float x) noexcept
{
    const int n = std::clamp(c.numPoints, 0, kMaxCurvePoints);
    if (n == 0) return std::clamp(x, 0.0f, 1.0f);
    if (n == 1) return c.points[0].y;

    x = std::clamp(x, 0.0f, 1.0f);
    if (x <= c.points[0].x) return c.points[0].y;
    if (x >= c.points[static_cast<size_t>(n - 1)].x)
        return c.points[static_cast<size_t>(n - 1)].y;

    for (int k = 0; k + 1 < n; ++k) {
        const auto& a = c.points[static_cast<size_t>(k)];
        const auto& b = c.points[static_cast<size_t>(k + 1)];
        if (x > b.x) continue;
        const float span = b.x - a.x;
        if (span < 1.0e-9f) return a.y;
        const float f = (x - a.x) / span;
        return a.y + (b.y - a.y) * shapeTension(f, a.tension);
    }
    return c.points[static_cast<size_t>(n - 1)].y;
}

// ── Compiled graph ───────────────────────────────────────────────────────────

struct CompiledRoute {
    int   source  = -1;
    int   target  = 0;
    int   index   = 0;
    int   stage   = 0;
    float amount  = 0.0f;
    bool  bipolar = false;
    // True when this edge closes a cycle (or crosses the per-voice → global
    // boundary): read the source's PREVIOUS control-block value.
    bool  deferred = false;
};

struct CompiledModGraph {
    ModConfig cfg;

    std::array<int,  kNumSources> evalOrder{};   // permutation of source indices
    std::array<int,  kNumSources> evalPos{};     // inverse of evalOrder
    std::array<bool, kNumSources> isGlobal{};    // FREE, or MONO in any behavior

    int numRoutes = 0;
    std::array<CompiledRoute, kMaxRoutes> routes{};

    // Cross-modulation routes, grouped by the source they TARGET (CSR layout),
    // so evaluating source k scans only the routes that actually move it.
    std::array<uint16_t, kNumSources + 1> paramStart{};
    std::array<uint8_t,  kMaxRoutes>      paramIdx{};
    int numParam = 0;

    // Audio-parameter routes, flat.
    std::array<uint8_t, kMaxRoutes> valueIdx{};
    int numValue = 0;

    // Per-slot fast-outs, so an unrouted parameter costs nothing in the render
    // loop: pan is only re-panned and MANGLE only re-designed where a route
    // actually exists.
    std::array<bool, kMaxModSlots> slotPanRouted{};
    std::array<bool, kMaxModSlots> slotMangleRouted{};
    bool masterPanRouted = false;
    bool anyMangleRouted = false;
    bool anyCycle        = false;
};

// LFO sources swing about zero; envelopes and the two response curves rise from
// zero. This is what decides how a route's `bipolar` flag maps the value.
inline bool sourceIsBipolarNatural(int src) noexcept
{
    return src >= kLfoSource0 && src < kLfoSource0 + kNumLfos;
}

inline float sourceBaseAmount(const ModConfig& cfg, int src) noexcept
{
    if (src >= kEnvSource0 && src < kEnvSource0 + kNumEnvs)
        return cfg.envs[static_cast<size_t>(src - kEnvSource0)].outputAmount;
    if (src >= kLfoSource0 && src < kLfoSource0 + kNumLfos)
        return cfg.lfos[static_cast<size_t>(src - kLfoSource0)].outputAmount;
    if (src == kVeloSource) return cfg.velo.outputAmount;
    if (src == kNoteSource) return cfg.note.outputAmount;
    return 1.0f;
}

// ── Bipolar vs unipolar ──────────────────────────────────────────────────────
// Let `u` be the source mapped to 0..1 and `b` the same source mapped to -1..+1
// (an LFO is already ±1; an envelope's 0..1 becomes 2·raw − 1).
//
//   unipolar route → offset = amount · outAmt · u · span
//                    the target sweeps base → base + amount·span
//   bipolar  route → offset = amount · outAmt · b · span
//                    the target spreads ± amount·span AROUND base
//
// `outAmt` — the source's own resolved output amount — multiplies AFTER the
// polarity mapping, so turning a source down shrinks a bipolar route toward its
// base rather than sliding it to one extreme.
inline float routeOffset(const CompiledRoute& r, float raw, float outAmt) noexcept
{
    const float m = sourceIsBipolarNatural(r.source)
        ? (r.bipolar ? raw : (raw + 1.0f) * 0.5f)
        : (r.bipolar ? (raw * 2.0f - 1.0f) : raw);
    return r.amount * outAmt * m * targetSpec(r.target).span;
}

// Apply one accumulated offset to a base value under the target's law.
inline float applyTargetLaw(int target, float base, float offset) noexcept
{
    const TargetSpec& spec = targetSpec(target);
    if (spec.law == TargetLaw::Exponential)
        return base * static_cast<float>(pow2d(offset));
    return std::clamp(base + offset, spec.lo, spec.hi);
}

// ── Compilation (main thread) ────────────────────────────────────────────────
// Produces the immutable graph the audio thread reads. Never called from the
// audio thread — the result is published by pointer swap.
inline void compileModGraph(const ModConfig& cfg, CompiledModGraph& g)
{
    g = CompiledModGraph{};
    g.cfg = cfg;

    for (int l = 0; l < kNumLfos; ++l) {
        const auto& lc = cfg.lfos[static_cast<size_t>(l)];
        g.isGlobal[static_cast<size_t>(kLfoSource0 + l)] =
            (lc.behavior == static_cast<int>(LfoBehavior::Free)) || lc.mono;
    }

    // ── Collect the valid routes ─────────────────────────────────────────────
    const int n = std::clamp(cfg.numRoutes, 0, kMaxRoutes);
    for (int i = 0; i < n; ++i) {
        const ModRoute& r = cfg.routes[static_cast<size_t>(i)];
        if (!isRouteValid(r)) continue;
        CompiledRoute cr;
        cr.source  = r.source;
        cr.target  = r.target;
        cr.index   = r.index;
        cr.stage   = r.stage;
        cr.amount  = std::clamp(r.amount, -1.0f, 1.0f);
        cr.bipolar = r.bipolar;
        g.routes[static_cast<size_t>(g.numRoutes++)] = cr;
    }

    // ── Dependency order ─────────────────────────────────────────────────────
    // Depth-first post-order over the edges source → targetSource, ignoring
    // back edges. 14 nodes, so an explicit stack is cheaper than recursion and
    // has no depth concerns at all.
    std::array<uint8_t, kNumSources> colour{};        // 0 white, 1 grey, 2 black
    std::array<int, kNumSources> post{};
    int postCount = 0;

    // Adjacency, built as a CSR over "edges leaving source s".
    std::array<uint16_t, kNumSources + 1> outStart{};
    std::array<uint8_t,  kMaxRoutes>      outIdx{};
    {
        std::array<uint16_t, kNumSources> count{};
        for (int i = 0; i < g.numRoutes; ++i) {
            const CompiledRoute& r = g.routes[static_cast<size_t>(i)];
            if (isCrossModTarget(r.target)) ++count[static_cast<size_t>(r.source)];
        }
        uint16_t acc = 0;
        for (int s = 0; s < kNumSources; ++s) {
            outStart[static_cast<size_t>(s)] = acc;
            acc = static_cast<uint16_t>(acc + count[static_cast<size_t>(s)]);
        }
        outStart[kNumSources] = acc;
        std::array<uint16_t, kNumSources + 1> cursor = outStart;
        for (int i = 0; i < g.numRoutes; ++i) {
            const CompiledRoute& r = g.routes[static_cast<size_t>(i)];
            if (isCrossModTarget(r.target))
                outIdx[cursor[static_cast<size_t>(r.source)]++] = static_cast<uint8_t>(i);
        }
    }

    struct Frame { int node; uint16_t edge; };
    std::array<Frame, kNumSources + 1> stack{};

    for (int root = 0; root < kNumSources; ++root) {
        if (colour[static_cast<size_t>(root)] != 0) continue;
        int sp = 0;
        stack[0] = Frame{ root, outStart[static_cast<size_t>(root)] };
        colour[static_cast<size_t>(root)] = 1;
        while (sp >= 0) {
            Frame& f = stack[static_cast<size_t>(sp)];
            if (f.edge < outStart[static_cast<size_t>(f.node) + 1]) {
                const CompiledRoute& r = g.routes[outIdx[f.edge++]];
                const int next = r.index;
                if (colour[static_cast<size_t>(next)] == 0) {
                    colour[static_cast<size_t>(next)] = 1;
                    stack[static_cast<size_t>(++sp)] =
                        Frame{ next, outStart[static_cast<size_t>(next)] };
                }
                // grey  → back edge: a cycle. Left for the deferred pass below.
                // black → already ordered.
            } else {
                colour[static_cast<size_t>(f.node)] = 2;
                post[postCount++] = f.node;
                --sp;
            }
        }
    }

    // An edge s → t means "s feeds t's parameter", so s must be evaluated
    // FIRST. DFS finishes t before s, so post-order lists t first — REVERSE
    // post-order is the topological order we want.
    for (int i = 0; i < kNumSources; ++i) {
        const int node = post[static_cast<size_t>(kNumSources - 1 - i)];
        g.evalOrder[static_cast<size_t>(i)] = node;
        g.evalPos[static_cast<size_t>(node)] = i;
    }

    // ── Deferral ─────────────────────────────────────────────────────────────
    // Any cross-mod edge whose source is not strictly earlier in the order than
    // the source it feeds cannot be satisfied this block; it reads the previous
    // one. Routes crossing per-voice → global are deferred for the same reason:
    // the global instance runs before any voice does.
    for (int i = 0; i < g.numRoutes; ++i) {
        CompiledRoute& r = g.routes[static_cast<size_t>(i)];
        if (!isCrossModTarget(r.target)) continue;
        const bool late = g.evalPos[static_cast<size_t>(r.source)]
                        >= g.evalPos[static_cast<size_t>(r.index)];
        const bool crossesIntoGlobal = g.isGlobal[static_cast<size_t>(r.index)]
                                    && !g.isGlobal[static_cast<size_t>(r.source)];
        r.deferred = late || crossesIntoGlobal;
        if (late) g.anyCycle = true;
    }

    // ── Route partitioning ───────────────────────────────────────────────────
    {
        std::array<uint16_t, kNumSources> count{};
        for (int i = 0; i < g.numRoutes; ++i) {
            const CompiledRoute& r = g.routes[static_cast<size_t>(i)];
            if (isCrossModTarget(r.target)) ++count[static_cast<size_t>(r.index)];
        }
        uint16_t acc = 0;
        for (int s = 0; s < kNumSources; ++s) {
            g.paramStart[static_cast<size_t>(s)] = acc;
            acc = static_cast<uint16_t>(acc + count[static_cast<size_t>(s)]);
        }
        g.paramStart[kNumSources] = acc;
        g.numParam = acc;

        std::array<uint16_t, kNumSources + 1> cursor = g.paramStart;
        for (int i = 0; i < g.numRoutes; ++i) {
            const CompiledRoute& r = g.routes[static_cast<size_t>(i)];
            if (isCrossModTarget(r.target)) {
                g.paramIdx[cursor[static_cast<size_t>(r.index)]++] = static_cast<uint8_t>(i);
            } else {
                g.valueIdx[static_cast<size_t>(g.numValue++)] = static_cast<uint8_t>(i);
                switch (static_cast<ModTarget>(r.target)) {
                    case ModTarget::SlotPan:
                        g.slotPanRouted[static_cast<size_t>(r.index)] = true; break;
                    case ModTarget::SlotMangleAmount:
                    case ModTarget::SlotMangleMix:
                        g.slotMangleRouted[static_cast<size_t>(r.index)] = true;
                        g.anyMangleRouted = true; break;
                    case ModTarget::MasterPan:
                        g.masterPanRouted = true; break;
                    default: break;
                }
            }
        }
    }
}

// ── Runtime state ────────────────────────────────────────────────────────────

struct ModEnvState {
    int    stage        = static_cast<int>(EnvStage::Off);
    float  level        = 0.0f;
    float  releaseStart = 0.0f;
    double posSec       = 0.0;
};

struct ModLfoState {
    double phase      = 0.0;   // raw accumulator, in cycles
    double elapsedSec = 0.0;   // since trigger (or transport anchor, for FREE)
    bool   done       = false; // ENVELOPE behaviour: the single pass finished
};

struct ModSourceBank {
    std::array<ModEnvState, kNumEnvs> envs{};
    std::array<ModLfoState, kNumLfos> lfos{};

    // `value` is the source's RAW output in its natural range (±1 for LFOs,
    // 0..1 otherwise); `amount` is its resolved output amount. They are kept
    // apart so routeOffset can apply the amount after the polarity mapping.
    std::array<float, kNumSources> value{};
    std::array<float, kNumSources> amount{};
    std::array<float, kNumSources> prevValue{};
    std::array<float, kNumSources> prevAmount{};

    float velocity = 1.0f;
    float noteNorm = 0.5f;
};

// Cross-modulation offsets resolved for ONE source, this block.
struct ResolvedSrcParams {
    float rateOct   = 0.0f;
    float phaseCyc  = 0.0f;
    float riseOct   = 0.0f;
    float delayOct  = 0.0f;
    float smoothAdd = 0.0f;
    std::array<float, kNumEnvStages> stageOct{};
};

// Accumulated audio-parameter offsets for one voice, this block.
struct ModOffsets {
    std::array<float, kMaxModSlots> volume{};
    std::array<float, kMaxModSlots> pan{};
    std::array<float, kMaxModSlots> semis{};        // SEM + COARSE + FINE/100
    // MANGLE amount/mix are per SLOT and per chain INSTANCE — a route's `stage`
    // selects which of the (up to 4) instances in that slot's chain it moves.
    std::array<std::array<float, kMaxMangleInstances>, kMaxModSlots> mangleAmount{};
    std::array<std::array<float, kMaxMangleInstances>, kMaxModSlots> mangleMix{};
    float masterVolume = 0.0f;
    float masterPan    = 0.0f;

    void clear() noexcept
    {
        volume.fill(0.0f); pan.fill(0.0f); semis.fill(0.0f);
        for (auto& a : mangleAmount) a.fill(0.0f);
        for (auto& a : mangleMix)    a.fill(0.0f);
        masterVolume = 0.0f; masterPan = 0.0f;
    }
};

// ── Source evaluation ────────────────────────────────────────────────────────

inline float advanceModEnv(const ModEnvConfig& c, ModEnvState& st,
                           const std::array<float, kNumEnvStages>& stageOct,
                           double bpm, double dtSec) noexcept
{
    auto secs = [&](const ModTime& t, int stage) {
        double s = modTimeSeconds(t, c.tempoSync, bpm);
        const float oct = stageOct[static_cast<size_t>(stage)];
        if (oct != 0.0f) s *= pow2d(oct);
        return s;
    };
    const double dS = secs(c.delay,   static_cast<int>(EnvStage::Delay));
    const double aS = secs(c.attack,  static_cast<int>(EnvStage::Attack));
    const double hS = secs(c.hold,    static_cast<int>(EnvStage::Hold));
    const double cS = secs(c.decay,   static_cast<int>(EnvStage::Decay));
    const double rS = secs(c.release, static_cast<int>(EnvStage::Release));
    const float  sus = std::clamp(c.sustainPct * 0.01f, 0.0f, 1.0f);

    switch (static_cast<EnvStage>(st.stage))
    {
        case EnvStage::Delay:
            st.level = 0.0f;
            if (dS <= 0.0 || st.posSec >= dS) {
                st.stage = static_cast<int>(EnvStage::Attack); st.posSec = 0.0;
            }
            break;

        case EnvStage::Attack:
            if (aS <= 0.0) {
                st.level = 1.0f;
                st.stage = static_cast<int>(EnvStage::Hold); st.posSec = 0.0;
            } else {
                st.level = shapeTension(
                    static_cast<float>(std::min(1.0, st.posSec / aS)), c.attackTension);
                if (st.posSec >= aS) {
                    st.level = 1.0f;
                    st.stage = static_cast<int>(EnvStage::Hold); st.posSec = 0.0;
                }
            }
            break;

        case EnvStage::Hold:
            st.level = 1.0f;
            if (hS <= 0.0 || st.posSec >= hS) {
                st.stage = static_cast<int>(EnvStage::Decay); st.posSec = 0.0;
            }
            break;

        case EnvStage::Decay:
            if (cS <= 0.0) {
                st.level = sus;
                st.stage = static_cast<int>(EnvStage::Sustain); st.posSec = 0.0;
            } else {
                const float shaped = shapeTension(
                    static_cast<float>(std::min(1.0, st.posSec / cS)), c.decayTension);
                st.level = 1.0f - (1.0f - sus) * shaped;
                if (st.posSec >= cS) {
                    st.level = sus;
                    st.stage = static_cast<int>(EnvStage::Sustain); st.posSec = 0.0;
                }
            }
            break;

        case EnvStage::Sustain:
            st.level = sus;
            break;

        case EnvStage::Release:
            if (rS <= 0.0) {
                st.level = 0.0f;
                st.stage = static_cast<int>(EnvStage::Off);
            } else {
                if (st.posSec <= 0.0) st.releaseStart = st.level;
                const float shaped = shapeTension(
                    static_cast<float>(std::min(1.0, st.posSec / rS)), c.releaseTension);
                st.level = st.releaseStart * (1.0f - shaped);
                if (st.posSec >= rS) {
                    st.level = 0.0f;
                    st.stage = static_cast<int>(EnvStage::Off);
                }
            }
            break;

        case EnvStage::Off:
        default:
            st.level = 0.0f;
            break;
    }

    st.posSec += dtSec;
    st.level = std::clamp(st.level, 0.0f, 1.0f);
    return st.level;
}

inline float advanceModLfo(const ModLfoConfig& c, ModLfoState& st,
                           const ResolvedSrcParams& p,
                           double bpm, double dtSec) noexcept
{
    // ── Rate ─────────────────────────────────────────────────────────────────
    // In BPM mode the note value is a PERIOD (one full cycle of the shape), so
    // the rate is its reciprocal — not a frequency multiplier.
    double rate;
    if (c.tempoSync) {
        const double period = modTimeSeconds(c.syncRate, true, bpm);
        // A note value of Off is not a rate; fall back to the free-running Hz
        // the LFO already carries rather than inventing one.
        rate = (period > 1.0e-9) ? (1.0 / period) : static_cast<double>(c.rateHz);
    } else {
        rate = static_cast<double>(c.rateHz);
    }
    if (p.rateOct != 0.0f) rate *= pow2d(p.rateOct);
    rate = std::clamp(rate, 1.0e-4, 400.0);

    // ── Depth: DELAY then RISE ───────────────────────────────────────────────
    // DELAY holds depth at 0 and then jumps to 100%; RISE ramps 0 → 100%
    // linearly. They are independent functions of the time since trigger and
    // MULTIPLY, so setting both means "wait, then whatever the ramp has
    // reached by now".
    double riseSec  = modTimeSeconds(c.rise,  c.tempoSync, bpm);
    double delaySec = modTimeSeconds(c.delay, c.tempoSync, bpm);
    if (p.riseOct  != 0.0f) riseSec  *= pow2d(p.riseOct);
    if (p.delayOct != 0.0f) delaySec *= pow2d(p.delayOct);

    float depth = (st.elapsedSec >= delaySec) ? 1.0f : 0.0f;
    if (riseSec > 1.0e-9)
        depth *= static_cast<float>(std::min(1.0, st.elapsedSec / riseSec));

    const float smooth = std::clamp(c.smooth * 0.01f + p.smoothAdd, 0.0f, 1.0f);
    const double phOff = static_cast<double>(c.phase) * 0.01 + static_cast<double>(p.phaseCyc);

    const bool envelopeMode = (c.behavior == static_cast<int>(LfoBehavior::Envelope));

    double evalPhase = st.phase + phOff;
    if (envelopeMode) {
        // One pass, then hold. PHASE offsets where in the shape the pass
        // starts, so a modulated PHASE moves the read point rather than
        // restarting the pass.
        st.done   = (evalPhase >= 1.0);
        evalPhase = std::clamp(evalPhase, 0.0, 1.0);
    } else {
        evalPhase -= std::floor(evalPhase);
    }

    const float raw = evalLfoShape(c, static_cast<float>(evalPhase), smooth);

    st.phase += rate * dtSec;
    if (envelopeMode) st.phase = std::min(st.phase, 2.0);
    else              st.phase -= std::floor(st.phase);
    st.elapsedSec += dtSec;

    return raw * depth;
}

// Snapshot the current block's values as the previous block's. MUST be called
// BEFORE the caller copies foreign (cross-bank) values in, or a cyclic route
// would read this block's value instead of last block's.
inline void modBankSnapshot(ModSourceBank& bank) noexcept
{
    bank.prevValue  = bank.value;
    bank.prevAmount = bank.amount;
}

// Advance every source whose global/per-voice kind matches `evalGlobal`.
// Sources of the other kind must already have been copied into bank.value /
// bank.amount by the caller (after modBankSnapshot).
inline void advanceModBank(const CompiledModGraph& g, ModSourceBank& bank,
                           bool evalGlobal, double bpm, double dtSec) noexcept
{
    for (int pos = 0; pos < kNumSources; ++pos)
    {
        const int k = g.evalOrder[static_cast<size_t>(pos)];
        if (g.isGlobal[static_cast<size_t>(k)] != evalGlobal) continue;

        // Resolve this source's cross-modulated parameters.
        ResolvedSrcParams p{};
        float amountAdd = 0.0f;
        for (uint16_t e = g.paramStart[static_cast<size_t>(k)];
             e < g.paramStart[static_cast<size_t>(k) + 1]; ++e)
        {
            const CompiledRoute& r = g.routes[g.paramIdx[e]];
            const size_t s = static_cast<size_t>(r.source);
            const float raw = r.deferred ? bank.prevValue[s]  : bank.value[s];
            const float amt = r.deferred ? bank.prevAmount[s] : bank.amount[s];
            const float off = routeOffset(r, raw, amt);
            switch (static_cast<ModTarget>(r.target)) {
                case ModTarget::SrcRate:   p.rateOct   += off; break;
                case ModTarget::SrcPhase:  p.phaseCyc  += off; break;
                case ModTarget::SrcRise:   p.riseOct   += off; break;
                case ModTarget::SrcDelay:  p.delayOct  += off; break;
                case ModTarget::SrcSmooth: p.smoothAdd += off; break;
                case ModTarget::SrcAmount: amountAdd   += off; break;
                case ModTarget::EnvStageTime:
                    p.stageOct[static_cast<size_t>(r.stage)] += off; break;
                default: break;
            }
        }

        bank.amount[static_cast<size_t>(k)] =
            std::clamp(sourceBaseAmount(g.cfg, k) + amountAdd, -1.0f, 1.0f);

        if (k >= kEnvSource0 && k < kEnvSource0 + kNumEnvs) {
            const size_t e = static_cast<size_t>(k - kEnvSource0);
            bank.value[static_cast<size_t>(k)] =
                advanceModEnv(g.cfg.envs[e], bank.envs[e], p.stageOct, bpm, dtSec);
        } else if (k >= kLfoSource0 && k < kLfoSource0 + kNumLfos) {
            const size_t l = static_cast<size_t>(k - kLfoSource0);
            bank.value[static_cast<size_t>(k)] =
                advanceModLfo(g.cfg.lfos[l], bank.lfos[l], p, bpm, dtSec);
        } else if (k == kVeloSource) {
            bank.value[static_cast<size_t>(k)] = evalModCurve(g.cfg.velo, bank.velocity);
        } else {
            bank.value[static_cast<size_t>(k)] = evalModCurve(g.cfg.note, bank.noteNorm);
        }
    }
}

// Sum every audio-parameter route into `out`. FINE is folded into `semis` at
// cents → semitones so the render loop adds ONE pitch offset per slot.
inline void accumulateModOffsets(const CompiledModGraph& g,
                                 const ModSourceBank& bank,
                                 ModOffsets& out) noexcept
{
    out.clear();
    for (int i = 0; i < g.numValue; ++i)
    {
        const CompiledRoute& r = g.routes[g.valueIdx[static_cast<size_t>(i)]];
        const size_t s   = static_cast<size_t>(r.source);
        const float  off = routeOffset(r, bank.value[s], bank.amount[s]);
        const size_t si  = static_cast<size_t>(std::clamp(r.index, 0, kMaxModSlots - 1));
        const size_t mi  = static_cast<size_t>(std::clamp(r.stage, 0, kMaxMangleInstances - 1));
        switch (static_cast<ModTarget>(r.target)) {
            case ModTarget::SlotVolume:       out.volume[si]       += off; break;
            case ModTarget::SlotPan:          out.pan[si]          += off; break;
            case ModTarget::SlotSem:          out.semis[si]        += off; break;
            case ModTarget::SlotCoarse:       out.semis[si]        += off; break;
            case ModTarget::SlotFine:         out.semis[si]        += off * 0.01f; break;
            case ModTarget::SlotMangleAmount: out.mangleAmount[si][mi] += off; break;
            case ModTarget::SlotMangleMix:    out.mangleMix[si][mi]    += off; break;
            case ModTarget::MasterVolume:     out.masterVolume     += off; break;
            case ModTarget::MasterPan:        out.masterPan        += off; break;
            default: break;
        }
    }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

// Note-on for a per-voice bank: every envelope restarts at its DELAY stage and
// every per-voice LFO (RETRIG or ENVELOPE without MONO) restarts its phase.
inline void modTriggerVoice(const CompiledModGraph& g, ModSourceBank& bank,
                            float velocity, float noteNorm) noexcept
{
    bank.velocity = std::clamp(velocity, 0.0f, 1.0f);
    bank.noteNorm = std::clamp(noteNorm, 0.0f, 1.0f);
    for (auto& e : bank.envs) e = ModEnvState{ static_cast<int>(EnvStage::Delay), 0.0f, 0.0f, 0.0 };
    for (int l = 0; l < kNumLfos; ++l) {
        if (g.isGlobal[static_cast<size_t>(kLfoSource0 + l)]) continue;
        bank.lfos[static_cast<size_t>(l)] = ModLfoState{};
    }
    bank.value.fill(0.0f);
    bank.prevValue.fill(0.0f);
    bank.amount.fill(1.0f);
    bank.prevAmount.fill(1.0f);
}

// MONO retrigger. A MONO source is one shared instance, so it restarts on the
// note that STARTS a group — the first note-on while the sampler is silent —
// and not on every note of a chord. FREE instances are never retriggered:
// they are anchored to the transport, not to notes.
inline void modTriggerMonoGlobals(const CompiledModGraph& g, ModSourceBank& bank) noexcept
{
    for (int l = 0; l < kNumLfos; ++l) {
        const auto& c = g.cfg.lfos[static_cast<size_t>(l)];
        if (c.behavior == static_cast<int>(LfoBehavior::Free)) continue;
        if (!c.mono) continue;
        bank.lfos[static_cast<size_t>(l)] = ModLfoState{};
    }
}

// Note-off: hand every envelope to its release segment. An ENVELOPE-behaviour
// LFO simply keeps holding whatever it was holding.
inline void modReleaseVoice(ModSourceBank& bank) noexcept
{
    for (auto& e : bank.envs) {
        if (e.stage == static_cast<int>(EnvStage::Off)) continue;
        e.releaseStart = e.level;
        e.stage        = static_cast<int>(EnvStage::Release);
        e.posSec       = 0.0;
    }
}

} // namespace xleth::sampmod
