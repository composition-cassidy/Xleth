#pragma once

#include <array>
#include <cmath>
#include <cstdint>

// ─── Sampler modulation configuration ────────────────────────────────────────
// The PURE, serializable description of one sampler's modulation system:
// 6 envelopes, 6 LFOs, a velocity response curve, a note response curve, and a
// route list. No DSP and no state live here — evaluation is
// engine/src/audio/SamplerModulation.h, which includes this file.
//
// This header sits in the model layer on purpose: SampleRegion owns a ModConfig
// (so it saves, loads and undoes with the rest of the sampler settings) and the
// model layer must not depend on the audio layer.
//
// ── Unit conventions ─────────────────────────────────────────────────────────
// Every free-running time in this file is MILLISECONDS, envelope stages and LFO
// RISE/DELAY alike. The spec quotes envelope stages in ms and LFO RISE/DELAY in
// seconds; that is a UI presentation difference (seconds = ms / 1000) and is
// deliberately NOT mirrored in the data model — one internal unit removes a
// whole class of conversion bugs.
//
// ── Bypass ───────────────────────────────────────────────────────────────────
// There is no master enable flag. `numRoutes == 0` IS the bypass: the compiled
// graph is null, the audio thread never enters the modulation path, and a
// project made before this system existed renders bit-identically.
//
// ── Why fixed-size arrays ────────────────────────────────────────────────────
// Every list here (shape points, curve points, routes) is a std::array plus a
// count rather than a vector. That makes ModConfig trivially copyable and, more
// to the point, makes the compiled graph the audio thread reads contain no
// owning pointers at all — publication is one atomic swap and evaluation never
// touches the allocator.
//
// It costs about 6 KB per ModConfig, so a SampleRegion grows by roughly that
// much and SetSamplerSettingsCommand (which holds an old and a new copy) by
// twice it. That is the deliberate trade: a few megabytes across a large
// project and a deep undo stack, in exchange for an audio path that cannot
// allocate.

namespace xleth::sampmod {

// ── Sizes ────────────────────────────────────────────────────────────────────
inline constexpr int kNumEnvs   = 6;
inline constexpr int kNumLfos   = 6;

// Source indices are a single flat namespace, which is what makes
// cross-modulation ("any source may target any other source") expressible as a
// plain integer pair. ENV 1-6 → 0..5, LFO 1-6 → 6..11, VELO → 12, NOTE → 13.
inline constexpr int kEnvSource0  = 0;
inline constexpr int kLfoSource0  = kEnvSource0 + kNumEnvs;      // 6
inline constexpr int kVeloSource  = kLfoSource0 + kNumLfos;      // 12
inline constexpr int kNoteSource  = kVeloSource + 1;             // 13
inline constexpr int kNumSources  = kNoteSource + 1;             // 14

inline constexpr int kMaxLfoPoints   = 32;
inline constexpr int kMaxCurvePoints = 32;
inline constexpr int kMaxRoutes      = 64;

// Envelope stages, in the order the FSM walks them. Also the `stage` index of
// an EnvStageTime route. Sustain is a LEVEL, not a time — a route targeting
// stage 4 therefore modulates nothing and is rejected at compile time.
inline constexpr int kNumEnvStages = 6;
enum class EnvStage : int {
    Delay = 0, Attack = 1, Hold = 2, Decay = 3, Sustain = 4, Release = 5,
    Off = 6
};

// Control-rate block. Every source is evaluated once per this many samples;
// the value is then held for the block.
inline constexpr int kControlBlockSamples = 32;

// Mirror of MAX_SAMPLE_SLOTS. Declared independently so this header does not
// have to include TimelineTypes.h (which itself needs to include this one);
// Sampler.cpp static_asserts that the two agree.
inline constexpr int kMaxModSlots = 8;

// Mirror of xleth::mangle::kMaxInstances (the per-slot MANGLE chain cap).
// Declared here for the same reason as kMaxModSlots — this header must not pull
// in MangleDsp.h — and Sampler.cpp static_asserts the two agree. It is the range
// of ModRoute::stage when the target is SlotMangleAmount / SlotMangleMix: for
// those two targets `stage` selects WHICH chain instance the offset lands on.
inline constexpr int kMaxMangleInstances = 4;

// ── Note values ──────────────────────────────────────────────────────────────
// 32 bars → 1/256, expressed in BEATS (4/4: one bar = 4 beats). TRIPLET scales
// by 2/3, DOTTED by 3/2; both together is a dotted triplet, which is legal and
// simply multiplies both factors.
//
// Index 0 is OFF — a length of zero beats. It exists so that the BPM side of a
// time parameter has the same "not set" state the millisecond side gets for
// free at ms = 0. Without it, flipping an envelope to BPM mode would silently
// give every stage a quarter note, so a fresh synced envelope would arrive with
// a delay, a hold and a decay nobody asked for.
//
// The table is persisted BY INDEX, so it is append-only — never reorder it.
inline constexpr int kNumNoteValues = 15;
enum class NoteValue : int {
    Off = 0,
    Bars32, Bars16, Bars8, Bars4, Bars2, Bar1,
    Half, Quarter, Eighth, Sixteenth, ThirtySecond, SixtyFourth,
    OneTwentyEighth, TwoFiftySixth
};

inline double noteValueBeats(int noteValue, bool triplet, bool dotted) noexcept
{
    static constexpr double kBeats[kNumNoteValues] = {
        0.0,
        128.0, 64.0, 32.0, 16.0, 8.0, 4.0,
        2.0, 1.0, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625
    };
    if (noteValue < 0 || noteValue >= kNumNoteValues)
        noteValue = static_cast<int>(NoteValue::Off);
    double b = kBeats[noteValue];
    if (triplet) b *= 2.0 / 3.0;
    if (dotted)  b *= 3.0 / 2.0;
    return b;
}

// One time parameter, carrying BOTH representations at once. Which one is read
// is decided by the owner's sync toggle, never by this struct — so flipping an
// envelope between ms and BPM mode and back is lossless.
//
// Both sides default to ZERO (ms = 0, note value = Off), so a default-
// constructed envelope is an instant one in either mode.
struct ModTime {
    float ms        = 0.0f;
    int   noteValue = static_cast<int>(NoteValue::Off);
    bool  triplet   = false;
    bool  dotted    = false;
};

inline double modTimeSeconds(const ModTime& t, bool sync, double bpm) noexcept
{
    if (!sync) return static_cast<double>(t.ms) * 0.001;
    if (!(bpm > 0.0)) bpm = 120.0;
    return noteValueBeats(t.noteValue, t.triplet, t.dotted) * 60.0 / bpm;
}

// ── Envelope ─────────────────────────────────────────────────────────────────
// DAHDSR with per-segment tension. `tempoSync` is the PER-ENVELOPE toggle the
// spec calls for: it switches all five time stages between ms and note values
// together, rather than per stage.
struct ModEnvConfig {
    bool    tempoSync = false;
    ModTime delay, attack, hold, decay, release;
    float   sustainPct = 100.0f;      // 0..100

    // Same law as the legacy sampler envelope (shapeTension): 0 = linear,
    // positive bends the segment UP (it covers most of its range early),
    // negative bends it DOWN.
    float   attackTension  = 0.0f;
    float   decayTension   = 0.0f;
    float   releaseTension = 0.0f;

    // Scales this source's output. Exists so SrcAmount cross-modulation has a
    // base value to move.
    float   outputAmount = 1.0f;
};

// ── LFO ──────────────────────────────────────────────────────────────────────
// The shape is an ordered point list. `segment` describes the segment that
// STARTS at this point and runs to the next one (the last point's segment wraps
// round to the first).
enum class LfoSegment : int { Step = 0, Line = 1, Curve = 2 };

struct LfoPoint {
    float time    = 0.0f;   // 0..1, position within one cycle
    float value   = 0.0f;   // -1..+1
    int   segment = static_cast<int>(LfoSegment::Line);
    float tension = 0.0f;   // -1..+1, Curve segments only
};

// FREE     — one global instance per LFO slot, transport-anchored, running for
//            the whole timeline regardless of whether notes are sounding.
// RETRIG   — a per-voice instance, phase reset at note-on, looping for the life
//            of the voice.
// ENVELOPE — a per-voice instance that plays the shape ONCE and then holds its
//            final value.
enum class LfoBehavior : int { Free = 0, Retrig = 1, Envelope = 2 };

struct ModLfoConfig {
    int   numPoints = 0;                            // 0 = built-in sine
    std::array<LfoPoint, kMaxLfoPoints> points{};

    bool    tempoSync = false;
    float   rateHz    = 1.0f;                       // 0.01 .. 40 (free mode)
    // One CYCLE, when tempoSync. Unlike every other ModTime in this file this
    // one defaults to a real length — a rate of "off" is not a thing, and a
    // synced LFO with no note value chosen falls back to rateHz.
    ModTime syncRate{ 0.0f, static_cast<int>(NoteValue::Quarter), false, false };

    // Depth shaping. Both follow the LFO's own sync toggle, so a synced LFO
    // gets note-value RISE and DELAY for free.
    ModTime rise;      // linear 0 → 100% depth ramp
    ModTime delay;     // depth is 0 until this has elapsed, then 100%

    float smooth   = 0.0f;    // 0..100, corner-preserving segment smoothing
    float phase    = 0.0f;    // 0..100 (% of one cycle) start offset
    int   behavior = static_cast<int>(LfoBehavior::Free);
    bool  mono     = false;   // one shared instance even in RETRIG / ENVELOPE

    float outputAmount = 1.0f;
};

// ── Response curve (VELO / NOTE) ─────────────────────────────────────────────
// An editable point curve mapping a 0..1 input to a 0..1 output.
// numPoints < 2 means IDENTITY — which is what makes an untouched VELO source
// behave exactly like raw velocity.
struct CurvePoint {
    float x = 0.0f;
    float y = 0.0f;
    float tension = 0.0f;   // shapes the segment starting at this point
};

struct ModCurveConfig {
    int numPoints = 0;
    std::array<CurvePoint, kMaxCurvePoints> points{};
    float outputAmount = 1.0f;
};

// ── Routes ───────────────────────────────────────────────────────────────────
// Targets fall into three families:
//   Slot*      — `index` is the slot (0..7)
//   Master*    — `index` unused
//   Src* / EnvStageTime — CROSS-MODULATION. `index` is the *target source*
//                index in the same flat namespace as ModRoute::source, and for
//                EnvStageTime `stage` selects which of the five times moves.
//
// Persisted by value, so this enum is append-only.
enum class ModTarget : int {
    None = 0,
    SlotVolume, SlotPan, SlotSem, SlotFine, SlotCoarse,
    SlotMangleAmount, SlotMangleMix,
    MasterVolume, MasterPan,
    SrcRate, SrcPhase, SrcRise, SrcDelay, SrcSmooth, SrcAmount,
    EnvStageTime,
    Count
};

// True for the targets that move another SOURCE's parameter rather than an
// audio parameter. These are the edges of the dependency graph.
inline bool isCrossModTarget(int target) noexcept
{
    return target >= static_cast<int>(ModTarget::SrcRate)
        && target <= static_cast<int>(ModTarget::EnvStageTime);
}

// How a route's offset meets the target's base value.
//   Additive    — base + offset, in the target's own units (span scales `amount`)
//   Exponential — base * 2^(offset), i.e. `span` is in OCTAVES. Used by every
//                 time/rate target so a modulated time can never reach zero or
//                 go negative.
enum class TargetLaw : int { Additive = 0, Exponential = 1 };

struct TargetSpec {
    TargetLaw law;
    float     span;    // amount == 1 moves the target by this much
    float     lo;      // clamp applied AFTER the offset (Additive only)
    float     hi;
};

// Indexed by ModTarget. `span` is what turns a normalised amount of 1.0 into a
// musically full-scale move of that particular parameter.
inline const TargetSpec& targetSpec(int target) noexcept
{
    static constexpr TargetSpec kSpecs[static_cast<int>(ModTarget::Count)] = {
        /* None             */ { TargetLaw::Additive,    0.0f,  0.0f, 0.0f },
        /* SlotVolume       */ { TargetLaw::Additive,    1.0f,  0.0f, 2.0f },
        /* SlotPan          */ { TargetLaw::Additive,    1.0f, -1.0f, 1.0f },
        /* SlotSem          */ { TargetLaw::Additive,   48.0f, -96.0f, 96.0f },
        /* SlotFine         */ { TargetLaw::Additive,  100.0f, -1200.0f, 1200.0f },
        /* SlotCoarse       */ { TargetLaw::Additive,   48.0f, -96.0f, 96.0f },
        /* SlotMangleAmount */ { TargetLaw::Additive,    1.0f,  0.0f, 1.0f },
        /* SlotMangleMix    */ { TargetLaw::Additive,    1.0f,  0.0f, 1.0f },
        /* MasterVolume     */ { TargetLaw::Additive,    1.0f,  0.0f, 2.0f },
        /* MasterPan        */ { TargetLaw::Additive,    1.0f, -1.0f, 1.0f },
        /* SrcRate          */ { TargetLaw::Exponential, 4.0f,  0.0f, 0.0f },
        /* SrcPhase         */ { TargetLaw::Additive,    1.0f, -8.0f, 8.0f },
        /* SrcRise          */ { TargetLaw::Exponential, 4.0f,  0.0f, 0.0f },
        /* SrcDelay         */ { TargetLaw::Exponential, 4.0f,  0.0f, 0.0f },
        /* SrcSmooth        */ { TargetLaw::Additive,    1.0f,  0.0f, 1.0f },
        /* SrcAmount        */ { TargetLaw::Additive,    1.0f, -1.0f, 1.0f },
        /* EnvStageTime     */ { TargetLaw::Exponential, 4.0f,  0.0f, 0.0f }
    };
    if (target < 0 || target >= static_cast<int>(ModTarget::Count)) target = 0;
    return kSpecs[target];
}

struct ModRoute {
    int   source  = -1;                                  // 0 .. kNumSources-1
    int   target  = static_cast<int>(ModTarget::None);
    int   index   = 0;                                   // slot, or target source
    int   stage   = 0;                                   // EnvStageTime only
    float amount  = 0.0f;                                // -1 .. +1, normalised
    bool  bipolar = false;
};

// ── The whole thing ──────────────────────────────────────────────────────────
struct ModConfig {
    std::array<ModEnvConfig, kNumEnvs> envs{};
    std::array<ModLfoConfig, kNumLfos> lfos{};
    ModCurveConfig velo;
    ModCurveConfig note;

    // ── Source presence ──────────────────────────────────────────────────────
    // Which ENV / LFO sources currently EXIST as far as the user is concerned.
    // The engine pools all six of each, but the UI adds and removes them one at
    // a time; presence is that add/remove state, saved so a project reopens with
    // exactly the sources the user built.
    //
    // Presence is a UI + persistence concern ONLY — the audio path keys off the
    // route list, never these flags. A source with no routes is silent whether
    // present or not, and removing a source is what strips its routes (done by
    // the caller before committing), so the two can never disagree audibly.
    //
    // ENV 0 is the amp envelope / voice-lifecycle gate — it always exists and
    // cannot be removed; enforceInvariants() re-asserts that after any patch.
    // VELO and NOTE are fixed sources with no presence flag. A default-
    // constructed config has only ENV 0 present, matching "a fresh sampler
    // starts with just ENV 1".
    std::array<bool, kNumEnvs> envPresent{ { true, false, false, false, false, false } };
    std::array<bool, kNumLfos> lfoPresent{ { false, false, false, false, false, false } };

    int numRoutes = 0;
    std::array<ModRoute, kMaxRoutes> routes{};

    // ENV 1 is the amplitude VCA, so its default must equal the sampler's old
    // amp-envelope default (instant attack, full sustain, a 50 ms release) —
    // otherwise a fresh region would click on note-off and a bypass config would
    // not render identically to no config at all. Every other field keeps its
    // in-class default. A user-declared default constructor leaves the type
    // trivially COPYABLE (only trivial default-construction is given up), so the
    // atomic-swap contract below is unaffected.
    ModConfig() noexcept { envs[0].release.ms = 50.0f; }

    // Fixed-size arrays make this trivially copyable, which is what lets the
    // undo command hold two of them and the audio thread read one through a
    // single atomic pointer load.
    bool isBypassed() const noexcept { return numRoutes <= 0; }

    bool isEnvPresent(int i) const noexcept
    { return i >= 0 && i < kNumEnvs && envPresent[static_cast<size_t>(i)]; }
    bool isLfoPresent(int i) const noexcept
    { return i >= 0 && i < kNumLfos && lfoPresent[static_cast<size_t>(i)]; }

    // Whether the flat source index (ENV 0..5, LFO 6..11, VELO 12, NOTE 13)
    // names a source that currently exists. VELO / NOTE are always present.
    bool isSourcePresent(int source) const noexcept
    {
        if (source >= kEnvSource0 && source < kLfoSource0)
            return isEnvPresent(source - kEnvSource0);
        if (source >= kLfoSource0 && source < kVeloSource)
            return isLfoPresent(source - kLfoSource0);
        return source == kVeloSource || source == kNoteSource;
    }

    // ENV 0 must always be present. Cheap to re-assert, so every patch path
    // calls it rather than trusting callers not to clear the one flag they must
    // never clear.
    void enforceInvariants() noexcept { envPresent[0] = true; }
};

// A route is only meaningful if it names a real source, a real target, and —
// for cross-modulation — a real target source that is not the source itself in
// the trivial "moves my own parameter" sense (self-modulation IS legal; it just
// resolves with one block of latency like any other cycle).
inline bool isRouteValid(const ModRoute& r) noexcept
{
    if (r.source < 0 || r.source >= kNumSources) return false;
    if (r.target <= 0 || r.target >= static_cast<int>(ModTarget::Count)) return false;
    if (isCrossModTarget(r.target)) {
        if (r.index < 0 || r.index >= kNumSources) return false;
        if (r.target == static_cast<int>(ModTarget::EnvStageTime)) {
            // Envelope stage times only exist on ENV sources, and Sustain is a
            // level rather than a time.
            if (r.index < kEnvSource0 || r.index >= kEnvSource0 + kNumEnvs) return false;
            if (r.stage < 0 || r.stage >= kNumEnvStages) return false;
            if (r.stage == static_cast<int>(EnvStage::Sustain)) return false;
        } else {
            // Rate / phase / rise / delay / smooth belong to LFOs. Output
            // amount is the one cross-mod target every source type carries.
            if (r.target != static_cast<int>(ModTarget::SrcAmount)
                && (r.index < kLfoSource0 || r.index >= kLfoSource0 + kNumLfos))
                return false;
        }
    } else if (r.target <= static_cast<int>(ModTarget::SlotMangleMix)) {
        if (r.index < 0 || r.index >= kMaxModSlots) return false;
        // For the two MANGLE targets `stage` selects the chain instance; every
        // other slot target ignores it (and leaves it 0). An out-of-range
        // instance is a UI bug, so reject rather than silently clamp.
        if ((r.target == static_cast<int>(ModTarget::SlotMangleAmount)
             || r.target == static_cast<int>(ModTarget::SlotMangleMix))
            && (r.stage < 0 || r.stage >= kMaxMangleInstances))
            return false;
    }
    return true;
}

} // namespace xleth::sampmod
