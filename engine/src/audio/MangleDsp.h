#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

// ─── MANGLE ───────────────────────────────────────────────────────────────────
// XLETH's per-note, per-slot warp-FX engine.
//
// MANGLE runs per STREAM — one instance per note per slot — so a chord through
// distortion has each note shaped by its OWN shaper before the voices sum. That
// is the whole point of the feature and the reason it does not live in the
// mixer: an insert distortion sees the already-summed chord and intermodulates
// it (the "smearing" a per-note engine exists to avoid).
//
// ── Where it hooks ───────────────────────────────────────────────────────────
// A sampler stream is a read head at `playPosition` walking a baked buffer at
// `stride` source-samples per output sample. MANGLE splits into two domains:
//
//   POSITION domain (ALT group, FM, PD)
//       Returns a read-head OFFSET in source samples. It NEVER writes
//       playPosition. The loop state machine, the trim-end test, the declick /
//       fade envelopes and the loop crossfade all keep driving the canonical
//       head exactly as they did before MANGLE existed; MANGLE only bends
//       *where the head is sampled from*. That orthogonality is what lets the
//       ALT modes coexist with all three loop modes without touching one line
//       of the loop code.
//
//   SAMPLE domain (FILTER, DISTORTION, AM, RM, QUANTIZE)
//       A pure (or small-state) function of the sample the head just read.
//
// ── The note cycle ───────────────────────────────────────────────────────────
// Every ALT / MODULATION mode is phrased against the note period. The cycle is
// tracked as a phase in [0,1) advancing by `stride / cycleLen`, where cycleLen
// (L) is the number of SOURCE samples in one cycle of the sounding note:
//
//   f    = 440 * 2^((sounding MIDI note - 69) / 12)
//   L    = sourceSampleRate / K,   K = 440 * 2^((rootNote - tuning - 69) / 12)
//
// L is a per-block CONSTANT — it depends only on the slot's source rate, root
// note and tuning, never on the live stride. That falls out of the algebra and
// it matters twice over: no per-sample pow, and `phase * L` advances by exactly
// `stride` per sample, so every mode's A = 0 case is EXACTLY the unmodified
// read position rather than approximately it.
//
// ── Free bypass ──────────────────────────────────────────────────────────────
// `MangleRuntime::active` is false when the mode is Off or the mix is 0. The
// render loop then never calls into here at all: no second read, no shaper, no
// branch per channel. A project that has never touched MANGLE is bit-identical
// to one built before it existed, which is also why the model defaults are
// mode = Off (mix defaults to 1.0 so that PICKING a mode is immediately
// audible).
//
// ── Aliasing (v1 trade-off, deliberate) ──────────────────────────────────────
// The waveshapers run at the engine rate with NO per-voice oversampling. A
// hard-clip or fold at high drive on bright material will alias — the harmonics
// the shaper generates above Nyquist fold back down. This is accepted for v1:
// oversampling 32 concurrent streams by 4x is a 4x cost on the single most
// expensive part of the sampler, and MANGLE is a character effect where the
// grit is largely the point. The gentler curves (SOFT SAT., TAPE SAT., TUBE)
// alias least; LINEAR FOLD, SINE FOLD, ZERO-SQUARE and STOMP BOX alias most.
// If v2 wants clean high-drive, the place to add it is a 2x half-band around
// mangleShape() only — the position domain needs no oversampling at all.
//
// ── Audio-thread contract ────────────────────────────────────────────────────
// Everything here is POD arithmetic on caller-owned state. No allocation, no
// locks, no logging, no virtual dispatch. MangleState is a member of the
// sampler's preallocated Stream, so a mode change is a plain integer write with
// no reallocation; only the filter integrators and DC blockers are reset, and
// only at voice start.

namespace xleth::mangle {

// ─── Modes ───────────────────────────────────────────────────────────────────
// Ids are PERSISTED in project files — append only, never renumber.
enum class Mode : int {
    Off = 0,

    // ALT — read-head / phase tricks
    Sync        = 1,
    BendPlus    = 2,
    BendMinus   = 3,
    BendBoth    = 4,
    Pwm         = 5,
    AsymPlus    = 6,
    AsymMinus   = 7,
    AsymBoth    = 8,
    Flip        = 9,
    Mirror      = 10,
    Quantize    = 11,
    Even        = 12,
    Odd         = 13,

    // FILTER — per-stream TPT state-variable filter
    Lpf         = 14,
    Hpf         = 15,
    Bpf         = 16,
    Notch       = 17,

    // DISTORTION — waveshapers on the stream's output
    Tube        = 18,
    SoftClip    = 19,
    HardClip    = 20,
    Diode1      = 21,
    Diode2      = 22,
    LinearFold  = 23,
    SineFold    = 24,
    ZeroSquare  = 25,
    Asym        = 26,
    Rectify     = 27,
    SineShaper  = 28,
    StompBox    = 29,
    TapeSat     = 30,
    SoftSat     = 31,

    // MODULATION — per-stream sine oscillator at the note frequency
    Fm          = 32,
    Pd          = 33,
    Am          = 34,
    Rm          = 35,

    Count       = 36
};

inline bool isValidMode(int m) noexcept {
    return m >= 0 && m < static_cast<int>(Mode::Count);
}

// True when the mode bends the read head rather than shaping the sample. Used
// by the render loop to skip the second interpolated read for sample-domain
// modes, which is the difference between one and two cubic reads per channel.
inline bool isPositionMode(Mode m) noexcept {
    switch (m) {
        case Mode::Sync: case Mode::BendPlus: case Mode::BendMinus:
        case Mode::BendBoth: case Mode::Pwm: case Mode::AsymPlus:
        case Mode::AsymMinus: case Mode::AsymBoth: case Mode::Flip:
        case Mode::Mirror: case Mode::Fm: case Mode::Pd:
            return true;
        default:
            return false;
    }
}

// True when the mode needs the note-cycle phase (and therefore a valid cycle
// length). Everything in ALT except BEND* and QUANTIZE is cycle-locked, as is
// the whole MODULATION group and the ODD/EVEN comb.
inline bool needsCycle(Mode m) noexcept {
    switch (m) {
        case Mode::Sync: case Mode::Pwm: case Mode::AsymPlus:
        case Mode::AsymMinus: case Mode::AsymBoth: case Mode::Flip:
        case Mode::Mirror: case Mode::Even: case Mode::Odd:
        case Mode::Fm: case Mode::Pd: case Mode::Am: case Mode::Rm:
            return true;
        default:
            return false;
    }
}

// ─── Small helpers ───────────────────────────────────────────────────────────

inline float flushDenormal(float x) noexcept {
    return (std::abs(x) < 1.0e-20f) ? 0.0f : x;
}

inline float clamp01(float x) noexcept { return x < 0.0f ? 0.0f : (x > 1.0f ? 1.0f : x); }

// Triangle wavefold, period 4 in u, output in [-1, 1]. fold(0)=0, fold(1)=1,
// fold(2)=0, fold(-1)=-1 — the classic linear wavefolder transfer curve.
inline float triangleFold(float u) noexcept {
    float t = u * 0.25f + 0.75f;
    t -= std::floor(t);
    return 4.0f * std::abs(t - 0.5f) - 1.0f;
}

// ─── Waveshapers (pure, stateless) ───────────────────────────────────────────
// Standard published curves (musicdsp / DAFX family), written from the math.
// Every one takes the raw sample and A (amount, 0..1) and is safe for any
// finite input: no division by a value that can reach zero, no unbounded
// growth, no denormal-generating recursion. The stateful parts of the
// DISTORTION group (DC blocking, tape pre-emphasis) live in shapeSample()
// so that these stay directly unit-testable.

// Drive laws, kept as named helpers so the tests can state the expected knee.
inline float driveSoft(float a) noexcept { return 1.0f + a * 24.0f; }
inline float driveGentle(float a) noexcept { return 1.0f + a * 4.0f; }

// TUBE — asymmetric soft saturation. The bias offsets the operating point so
// the two halves hit the knee at different places (the even-harmonic
// "warmth"), and tanh(bias) is subtracted back out so the curve passes through
// the origin exactly — which is what makes silence in give silence out before
// the DC blocker has settled.
//
// The bias is added AFTER the drive, not before it. Biasing the input
// (tanh(d*(x+b))) scales the offset by the drive too, so at high drive the
// operating point walks onto the rail and the positive half collapses to
// nothing while the negative swings to -2. Post-drive bias keeps the
// asymmetry at a constant ~0.71 / -1.29 whatever the drive.
inline float shapeTube(float x, float a) noexcept {
    const float d = driveSoft(a);
    constexpr float kBias = 0.3f;
    return std::tanh(d * x + kBias) - std::tanh(kBias);
}

// SOFT CLIP — the cubic (3/2)(x - x^3/3), the textbook soft clipper.
inline float shapeSoftClip(float x, float a) noexcept {
    const float u = x * driveSoft(a);
    if (u >=  1.0f) return  1.0f;
    if (u <= -1.0f) return -1.0f;
    return 1.5f * (u - u * u * u * (1.0f / 3.0f));
}

// HARD CLIP — A lowers the threshold. Deliberately NOT normalised back to
// unity: the bound IS the effect, and the test asserts |y| <= threshold.
inline float hardClipThreshold(float a) noexcept { return 1.0f - 0.95f * clamp01(a); }
inline float shapeHardClip(float x, float a) noexcept {
    const float t = hardClipThreshold(a);
    return std::clamp(x, -t, t);
}

// DIODE 1 — symmetric diode knee, y = sgn(x)(1 - e^-|x|d).
inline float shapeDiode1(float x, float a) noexcept {
    const float d = driveSoft(a);
    const float m = 1.0f - std::exp(-std::abs(x) * d);
    return (x < 0.0f) ? -m : m;
}

// DIODE 2 — asymmetric diode PAIR: the two halves see different forward
// voltages, so they clip at different knees. Origin-crossing, DC blocked
// downstream.
inline float shapeDiode2(float x, float a) noexcept {
    const float d = driveSoft(a);
    if (x >= 0.0f) return 1.0f - std::exp(-x * d);
    return -0.7f * (1.0f - std::exp(x * d * 0.45f));
}

// LINEAR FOLD — triangle wavefold. Drive pushes the signal through more folds.
inline float shapeLinearFold(float x, float a) noexcept {
    return triangleFold(x * (1.0f + a * 12.0f));
}

// SINE FOLD — sine foldback, y = sin((pi/2) d x). Smoother than the triangle
// because the fold corners are rounded.
inline float shapeSineFold(float x, float a) noexcept {
    constexpr float kHalfPi = 1.57079632679f;
    return std::sin(kHalfPi * x * (1.0f + a * 8.0f));
}

// ZERO-SQUARE — sgn(x)|x|^k with k sweeping 1 -> 0.05, so A morphs the signal
// continuously toward a square of the same zero crossings.
inline float zeroSquareExponent(float a) noexcept { return 1.0f - 0.95f * clamp01(a); }
inline float shapeZeroSquare(float x, float a) noexcept {
    const float m = std::abs(x);
    if (m < 1.0e-12f) return 0.0f;
    const float y = std::pow(m, zeroSquareExponent(a));
    return (x < 0.0f) ? -y : y;
}

// ASYM — genuinely different curves per half: cubic soft clip above zero, a
// harder tanh below it. DC blocked downstream.
inline float shapeAsym(float x, float a) noexcept {
    const float d = driveSoft(a);
    if (x >= 0.0f) return shapeSoftClip(x, a);
    return std::tanh(x * d * 1.6f);
}

// RECTIFY — A blends half-wave (A=0, negatives removed) to full-wave (A=1,
// |x|). The polarity assertion the tests make is on THIS function, before the
// DC blocker re-centres it.
inline float shapeRectify(float x, float a) noexcept {
    const float A = clamp01(a);
    const float pos = (x > 0.0f) ? x : 0.0f;
    const float neg = (x < 0.0f) ? -x : 0.0f;
    return pos + A * neg;
}

// SINE SHAPER — y = sin(x * drive). Wraps rather than folds once drive is high.
inline float shapeSineShaper(float x, float a) noexcept {
    return std::sin(x * (1.0f + a * 8.0f));
}

// STOMP BOX — cascaded high-gain clipping, the classic two-stage pedal
// topology. DC blocked downstream.
inline float shapeStompBox(float x, float a) noexcept {
    const float d1 = 1.0f + a * 40.0f;
    const float s1 = std::tanh(x * d1);
    return shapeSoftClip(s1 * (1.0f + a * 6.0f), 0.0f) * 0.85f;
}

// SOFT SAT. — gentle tanh, normalised so the curve stays near unity gain for
// small signals instead of quietly attenuating the slot.
inline float shapeSoftSat(float x, float a) noexcept {
    const float d = driveGentle(a);
    return std::tanh(x * d) / std::tanh(d);
}

// ─── Chain configuration ─────────────────────────────────────────────────────
// A slot no longer holds one MANGLE — it holds an ORDERED CHAIN of up to
// kMaxInstances of them. The chain is a signal-processing stack: the output of
// instance N feeds instance N+1, so the ORDER is audible (HARD CLIP → LPF is
// not LPF → HARD CLIP). A single-instance chain reduces to exactly the
// pre-chain single-MANGLE render, which is what makes the legacy migration
// bit-identical.
//
// A position-domain instance (Sync, Bend, FM, …) bends the READ HEAD, so its
// input is always the source buffer, not the previous instance's sample — it
// re-reads the source at its bent position and blends that in by its own mix.
// Each instance ticks its cycle phase against the CANONICAL read head (they do
// not compose read positions), so every instance's math is identical to the
// single-instance case regardless of where it sits in the chain.
//
// The config is immutable once built and published to the audio thread by a
// single atomic pointer swap (the same model Slot::data and the modulation
// graph use), so add / remove / reorder is a lock-free, allocation-free swap on
// the audio side and a bypassed or Off instance costs the render loop nothing.
inline constexpr int kMaxInstances = 4;

struct InstanceConfig
{
    int   mode   = 0;      // xleth::mangle::Mode id (Off = 0)
    float amount = 0.0f;   // 0..1
    float mix    = 1.0f;   // 0..1 (defaults fully wet: picking a mode is audible)
    bool  bypass = false;  // true ⇒ the instance is skipped entirely, at no cost
};

struct ChainConfig
{
    std::array<InstanceConfig, kMaxInstances> inst{};
    int count = 0;         // live instances, 0..kMaxInstances (order = chain order)
};

// ─── Per-stream state ────────────────────────────────────────────────────────
// Lives inside the sampler's preallocated Stream. ~80 bytes; with 32 voices x 8
// slots that is ~20 KB for the whole sampler, which is why the ODD/EVEN comb is
// a SECOND READ HEAD rather than a delay line — a per-stream ring long enough
// for a half period at the bottom of the keyboard would have been ~8 MB.
//
// A CHAIN needs one State per instance (kMaxInstances of them per stream), since
// each instance carries its own note-cycle phase, filter integrators and DC
// blockers — all reset together at voice start.

struct State
{
    // Note-cycle tracking.
    double phase         = 0.0;    // [0, 1)
    double cycleStartPos = 0.0;    // read position captured at the last wrap
    bool   primed        = false;  // false until the first tick seeds the anchor
    int    cycleIndex    = 0;      // parity, for the alternating ASYM+/- mode

    // TPT state-variable filter integrators, per channel.
    float ic1[2]{}, ic2[2]{};
    // DC blocker, per channel.
    float dcX1[2]{}, dcY1[2]{};
    // Tape pre-emphasis memory, per channel.
    float peX1[2]{};

    void reset() noexcept {
        phase = 0.0;
        cycleStartPos = 0.0;
        primed = false;
        cycleIndex = 0;
        ic1[0] = ic1[1] = 0.0f;
        ic2[0] = ic2[1] = 0.0f;
        dcX1[0] = dcX1[1] = 0.0f;
        dcY1[0] = dcY1[1] = 0.0f;
        peX1[0] = peX1[1] = 0.0f;
    }
};

// ─── Per-block runtime ───────────────────────────────────────────────────────
// Resolved ONCE per processVoice call per stream. Filter coefficients are
// block-rate (the same convention the effect base class uses): the cutoff
// tracks the note pitch captured at block entry, not the per-sample pitch
// modulation, which keeps the SVF one tan() per block instead of one per
// sample and is inaudible at a 256–1024 sample block.

struct Runtime
{
    Mode   mode   = Mode::Off;
    float  amount = 0.0f;
    float  mix    = 0.0f;
    bool   active = false;      // false ⇒ the render loop skips MANGLE entirely
    bool   posMode = false;     // cached isPositionMode(mode)

    double cycleLen  = 0.0;     // L, source samples in one note cycle
    double spanStart = 0.0;     // trim start, the BEND remap origin
    double spanLen   = 1.0;     // trim length, the BEND remap span

    // TPT SVF (Cytomic linear-trapezoidal form).
    float a1 = 0.0f, a2 = 0.0f, a3 = 0.0f;
    float m0 = 0.0f, m1 = 0.0f, m2 = 1.0f;

    // DC blocker pole.
    float dcR = 0.9975f;
};

// Build the runtime for one stream.
//   modeId       persisted mode id (out-of-range falls back to Off)
//   amount, mix  0..1, clamped
//   noteHz       sounding note frequency at block entry
//   cycleLen     source samples per note cycle (see the header note)
//   spanStart /
//   spanLen      the stream's trim window, in source samples
//   engineSR     engine sample rate
inline Runtime makeRuntime(int modeId, float amount, float mix,
                           double noteHz, double cycleLen,
                           double spanStart, double spanLen,
                           double engineSR) noexcept
{
    Runtime rt;
    rt.mode   = isValidMode(modeId) ? static_cast<Mode>(modeId) : Mode::Off;
    rt.amount = clamp01(amount);
    rt.mix    = clamp01(mix);

    // THE bypass gate. Everything downstream is skipped when this is false —
    // no second read, no shaper, no per-channel branch.
    rt.active = (rt.mode != Mode::Off) && (rt.mix > 0.0f);
    if (!rt.active) return rt;

    rt.posMode   = isPositionMode(rt.mode);
    rt.spanStart = spanStart;
    rt.spanLen   = (spanLen > 1.0) ? spanLen : 1.0;

    // A cycle shorter than two source samples is meaningless (and would make
    // the phase increment explode); fall back to a one-second cycle, which
    // simply makes the cycle-locked modes very slow rather than unstable.
    rt.cycleLen = (cycleLen >= 2.0 && cycleLen < 1.0e7) ? cycleLen : 1.0e4;

    if (engineSR > 0.0)
        rt.dcR = static_cast<float>(1.0 - (2.0 * 3.14159265358979323846 * 15.0 / engineSR));

    // ── Filter design ────────────────────────────────────────────────────────
    // Key-tracked: the base sits two octaves above the sounding note, and A
    // sweeps +/- 3 octaves around it. A = 0.5 is therefore "no sweep", which is
    // why the FILTER group is the one group where A = 0 is not the neutral end.
    switch (rt.mode) {
        case Mode::Lpf: case Mode::Hpf: case Mode::Bpf: case Mode::Notch: {
            const double base = std::clamp((noteHz > 1.0 ? noteHz : 440.0) * 4.0, 30.0, 18000.0);
            double fc = base * std::pow(2.0, (static_cast<double>(rt.amount) - 0.5) * 6.0);
            const double nyq = (engineSR > 0.0 ? engineSR : 48000.0) * 0.45;
            fc = std::clamp(fc, 20.0, nyq);

            const double q = (rt.mode == Mode::Bpf || rt.mode == Mode::Notch) ? 1.5 : 0.70710678;
            const double g = std::tan(3.14159265358979323846 * fc / (engineSR > 0.0 ? engineSR : 48000.0));
            const double k = 1.0 / q;
            const double a1 = 1.0 / (1.0 + g * (g + k));
            rt.a1 = static_cast<float>(a1);
            rt.a2 = static_cast<float>(g * a1);
            rt.a3 = static_cast<float>(g * g * a1);
            const float kf = static_cast<float>(k);
            switch (rt.mode) {
                case Mode::Lpf:   rt.m0 = 0.0f; rt.m1 =  0.0f; rt.m2 =  1.0f; break;
                case Mode::Hpf:   rt.m0 = 1.0f; rt.m1 =   -kf; rt.m2 = -1.0f; break;
                case Mode::Bpf:   rt.m0 = 0.0f; rt.m1 =    kf; rt.m2 =  0.0f; break;
                default:          rt.m0 = 1.0f; rt.m1 =   -kf; rt.m2 =  0.0f; break;  // Notch
            }
            break;
        }
        default: break;
    }
    return rt;
}

// ─── Per-sample read-head plan ───────────────────────────────────────────────

struct Tick
{
    double posOffset  = 0.0;   // source samples to add to the read head
    double combOffset = 0.0;   // second read head, relative to the first
    float  combDepth  = 0.0f;  // 0 ⇒ no comb read at all
    float  combSign   = 1.0f;  // +1 adds (even harmonics), -1 subtracts (odd)
    float  ampGain    = 1.0f;  // AM / RM
};

// Advance the cycle phase and produce this sample's plan.
//   readPos  the stream's canonical (unmangled) read position
//   stride   source samples the head advances this output sample
inline Tick tick(const Runtime& rt, State& st, double readPos, double stride) noexcept
{
    Tick out;
    if (!rt.active) return out;

    const double L = rt.cycleLen;
    const float  A = rt.amount;

    const bool cycled = needsCycle(rt.mode);
    if (cycled) {
        if (!st.primed) { st.primed = true; st.cycleStartPos = readPos; st.phase = 0.0; }
        // Wrap BEFORE reading the phase, and re-anchor to the head's CURRENT
        // position. Two consequences, both load-bearing:
        //  - the plan below is computed from the phase belonging to THIS
        //    sample, so `cycleStartPos + phase*L` equals readPos exactly at
        //    A = 0 rather than leading it by one stride;
        //  - re-anchoring (instead of accumulating) means a stride that drifts
        //    under pitch modulation can never walk the anchor off the head.
        if (st.phase >= 1.0) {
            const int wraps = static_cast<int>(st.phase);
            st.phase -= static_cast<double>(wraps);
            st.cycleIndex += wraps;
            st.cycleStartPos = readPos;
        }
    }

    const double p = st.phase;
    constexpr double kTwoPi = 6.28318530717958647692;

    switch (rt.mode)
    {
        // ── ALT: cycle-locked read-head remaps ───────────────────────────────
        case Mode::Sync: {
            // The head sweeps (1 + 7A) times its natural distance and snaps
            // back to the anchor every cycle — oscillator hard sync.
            const double swept = st.cycleStartPos + p * L * (1.0 + 7.0 * A);
            out.posOffset = swept - readPos;
            break;
        }
        case Mode::Pwm: {
            // Advance for the first `duty` of the cycle, stall for the rest.
            const double duty = 1.0 - 0.95 * A;
            const double q = (p < duty) ? p : duty;
            out.posOffset = (st.cycleStartPos + q * L) - readPos;
            break;
        }
        case Mode::AsymPlus:
        case Mode::AsymMinus:
        case Mode::AsymBoth: {
            // Piecewise-linear skew: the first half of the cycle covers `b` of
            // the window, the second half covers the rest. b = 0.5 is identity.
            double skew = 0.45 * A;
            if (rt.mode == Mode::AsymMinus) skew = -skew;
            else if (rt.mode == Mode::AsymBoth && (st.cycleIndex & 1)) skew = -skew;
            const double b = 0.5 + skew;
            const double q = (p < 0.5) ? (p * 2.0 * b)
                                       : (b + (p - 0.5) * 2.0 * (1.0 - b));
            out.posOffset = (st.cycleStartPos + q * L) - readPos;
            break;
        }
        case Mode::Flip: {
            // Forward to `t`, then retrace backwards. A = 0 ⇒ t = 1 ⇒ never flips.
            const double t = 1.0 - A;
            const double q = (p < t) ? p : std::max(0.0, 2.0 * t - p);
            out.posOffset = (st.cycleStartPos + q * L) - readPos;
            break;
        }
        case Mode::Mirror: {
            // Ping-pong inside a window anchored at the cycle start.
            const double w = static_cast<double>(A) * L * 4.0;
            if (w < 1.0) break;                       // A ~ 0 ⇒ identity
            const double travelled = p * L;
            const double period = 2.0 * w;
            double m = std::fmod(travelled, period);
            if (m < 0.0) m += period;
            const double q = (m <= w) ? m : (period - m);
            out.posOffset = (st.cycleStartPos + q) - readPos;
            break;
        }

        // ── ALT: window remaps (not cycle-locked) ────────────────────────────
        case Mode::BendPlus:
        case Mode::BendMinus:
        case Mode::BendBoth: {
            double u = (readPos - rt.spanStart) / rt.spanLen;
            u = std::clamp(u, 0.0, 1.0);
            const double e = 1.0 + 3.0 * static_cast<double>(A);
            double q;
            if (rt.mode == Mode::BendPlus)       q = std::pow(u, e);
            else if (rt.mode == Mode::BendMinus) q = std::pow(u, 1.0 / e);
            else q = (u < 0.5) ? 0.5 * std::pow(u * 2.0, e)
                               : 1.0 - 0.5 * std::pow((1.0 - u) * 2.0, e);
            out.posOffset = (rt.spanStart + q * rt.spanLen) - readPos;
            break;
        }

        // ── ALT: comb (harmonic isolation) ───────────────────────────────────
        case Mode::Even:
        case Mode::Odd: {
            if (A <= 0.0f) break;
            out.combOffset = -0.5 * L;      // half a note period back
            out.combDepth  = A;
            out.combSign   = (rt.mode == Mode::Even) ? 1.0f : -1.0f;
            break;
        }

        // ── MODULATION ───────────────────────────────────────────────────────
        case Mode::Fm: {
            // Realised as phase modulation — the exact integral of a sine
            // speed modulation at the same rate, and immune to the drift a
            // per-sample speed integration would accumulate.
            out.posOffset = static_cast<double>(A) * 0.5 * L * std::sin(kTwoPi * p);
            break;
        }
        case Mode::Pd: {
            // Casio-style per-cycle phase kink: two linear segments meeting at
            // knee k. k = 0.5 is identity.
            const double k = 0.5 - 0.45 * static_cast<double>(A);
            const double q = (p < k) ? (p * 0.5 / k)
                                     : (0.5 + (p - k) * 0.5 / (1.0 - k));
            out.posOffset = (st.cycleStartPos + q * L) - readPos;
            break;
        }
        case Mode::Am: {
            // Unipolar tremolo at audio rate — never changes sign.
            const float u = 0.5f + 0.5f * static_cast<float>(std::sin(kTwoPi * p));
            out.ampGain = (1.0f - A) + A * u;
            break;
        }
        case Mode::Rm: {
            // Bipolar ring modulation.
            out.ampGain = (1.0f - A) + A * static_cast<float>(std::sin(kTwoPi * p));
            break;
        }

        default: break;   // sample-domain modes leave the read head alone
    }

    // phase * cycleLen advances by exactly `stride` per sample — the identity
    // every A = 0 case above relies on.
    if (cycled) st.phase += stride / L;
    return out;
}

// ─── Per-sample shaper ───────────────────────────────────────────────────────
// `x` is the (already position-mangled, already combed) stream sample.
// `ch` selects the per-channel filter / DC-blocker state.

inline float shapeSample(const Runtime& rt, State& st, float x, int ch) noexcept
{
    if (!rt.active) return x;
    const int c = (ch <= 0) ? 0 : 1;
    const float A = rt.amount;

    switch (rt.mode)
    {
        case Mode::Quantize: {
            // 16 bits at A = 0 down to 1 bit at A = 1.
            const float bits = 16.0f - 15.0f * A;
            const float levels = std::exp2(bits - 1.0f);
            return std::round(x * levels) / levels;
        }

        case Mode::Lpf: case Mode::Hpf: case Mode::Bpf: case Mode::Notch: {
            const float v0 = x;
            const float v3 = v0 - st.ic2[c];
            const float v1 = rt.a1 * st.ic1[c] + rt.a2 * v3;
            const float v2 = st.ic2[c] + rt.a2 * st.ic1[c] + rt.a3 * v3;
            st.ic1[c] = flushDenormal(2.0f * v1 - st.ic1[c]);
            st.ic2[c] = flushDenormal(2.0f * v2 - st.ic2[c]);
            return rt.m0 * v0 + rt.m1 * v1 + rt.m2 * v2;
        }

        // Symmetric / origin-crossing shapers need no DC blocking.
        case Mode::SoftClip:   return shapeSoftClip(x, A);
        case Mode::HardClip:   return shapeHardClip(x, A);
        case Mode::Diode1:     return shapeDiode1(x, A);
        case Mode::LinearFold: return shapeLinearFold(x, A);
        case Mode::SineFold:   return shapeSineFold(x, A);
        case Mode::ZeroSquare: return shapeZeroSquare(x, A);
        case Mode::SineShaper: return shapeSineShaper(x, A);
        case Mode::SoftSat:    return shapeSoftSat(x, A);

        // Asymmetric shapers: origin-crossing but not odd-symmetric, so they
        // put a signal-dependent DC term on the stream. A per-stream blocker
        // is what keeps 32 summed voices from stacking offsets into the mix.
        case Mode::Tube:
        case Mode::Diode2:
        case Mode::Asym:
        case Mode::Rectify:
        case Mode::StompBox: {
            float y;
            switch (rt.mode) {
                case Mode::Tube:    y = shapeTube(x, A);     break;
                case Mode::Diode2:  y = shapeDiode2(x, A);   break;
                case Mode::Asym:    y = shapeAsym(x, A);     break;
                case Mode::Rectify: y = shapeRectify(x, A);  break;
                default:            y = shapeStompBox(x, A); break;
            }
            const float out = y - st.dcX1[c] + rt.dcR * st.dcY1[c];
            st.dcX1[c] = y;
            st.dcY1[c] = flushDenormal(out);
            return out;
        }

        case Mode::TapeSat: {
            // Gentle first-difference HF lift before the tanh — the tape
            // pre-emphasis that makes highs saturate before the body does.
            const float pre = x + 0.35f * (x - st.peX1[c]);
            st.peX1[c] = flushDenormal(x);
            const float d = 1.0f + A * 6.0f;
            return std::tanh(pre * d) / std::tanh(d);
        }

        default: return x;   // Off + every position-domain mode
    }
}

} // namespace xleth::mangle
