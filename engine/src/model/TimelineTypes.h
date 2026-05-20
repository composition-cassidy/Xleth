#pragma once
#include <cstdint>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

// ─── TickTime ─────────────────────────────────────────────────────────────────
// Musical time in MIDI ticks at 960 PPQ (pulses per quarter note).
// All timeline positions and durations are stored as TickTime.

struct TickTime {
    int64_t ticks = 0;

    static TickTime fromBeats(double beats) {
        return {static_cast<int64_t>(beats * 960.0)};
    }
    static TickTime fromBars(int bars, int beatsPerBar = 4) {
        return fromBeats(bars * beatsPerBar);
    }
    static TickTime from16th(int sixteenths) {
        return {static_cast<int64_t>(sixteenths * 240)};
    }

    double toBeats() const { return ticks / 960.0; }

    double toSeconds(double bpm) const {
        return (ticks / 960.0) * (60.0 / bpm);
    }

    int64_t toSamples(double bpm, double sampleRate) const {
        return static_cast<int64_t>(toSeconds(bpm) * sampleRate);
    }

    bool operator<(const TickTime& o)  const { return ticks <  o.ticks; }
    bool operator==(const TickTime& o) const { return ticks == o.ticks; }
    bool operator<=(const TickTime& o) const { return ticks <= o.ticks; }
    bool operator>(const TickTime& o)  const { return ticks >  o.ticks; }
    bool operator>=(const TickTime& o) const { return ticks >= o.ticks; }

    TickTime operator+(const TickTime& o) const { return {ticks + o.ticks}; }
    TickTime operator-(const TickTime& o) const { return {ticks - o.ticks}; }
};

// ─── SampleLabel ──────────────────────────────────────────────────────────────

enum class SampleLabel {
    Kick,
    Snare,
    HiHat,
    Crash,
    Pitch,
    Quote,
    Custom
};

inline std::string sampleLabelToString(SampleLabel label) {
    switch (label) {
        case SampleLabel::Kick:   return "Kick";
        case SampleLabel::Snare:  return "Snare";
        case SampleLabel::HiHat:  return "HiHat";
        case SampleLabel::Crash:  return "Crash";
        case SampleLabel::Pitch:  return "Pitch";
        case SampleLabel::Quote:  return "Quote";
        case SampleLabel::Custom: return "Custom";
        default:                  return "Custom";
    }
}

inline SampleLabel stringToSampleLabel(const std::string& str) {
    if (str == "Kick")   return SampleLabel::Kick;
    if (str == "Snare")  return SampleLabel::Snare;
    if (str == "HiHat")  return SampleLabel::HiHat;
    if (str == "Crash")  return SampleLabel::Crash;
    if (str == "Pitch")  return SampleLabel::Pitch;
    if (str == "Quote")  return SampleLabel::Quote;
    return SampleLabel::Custom;
}

// ─── SourceMedia ──────────────────────────────────────────────────────────────
// Represents an imported video/audio file (source asset).

struct SourceMedia {
    int         id          = 0;
    std::string filePath;
    std::string proxyPath;
    std::string fileName;
    int         width       = 0;
    int         height      = 0;
    double      fps         = 0.0;
    double      duration    = 0.0;
    int         totalFrames = 0;
    bool        hasVideo    = false;
    bool        proxyReady  = false;
};

// ─── SampleRegion ─────────────────────────────────────────────────────────────
// A marked region from a SourceMedia file — the fundamental sample unit.
// Carries both audio (audioFilePath) and video frame range (startFrame/endFrame).
// Quote regions can be subdivided into syllables.

struct SampleRegion {
    int         id              = 0;
    int         sourceId        = 0;
    std::string name;
    SampleLabel label           = SampleLabel::Custom;
    std::string customLabelName;

    double startTime  = 0.0;   // seconds into the source video
    double endTime    = 0.0;
    int    startFrame = 0;
    int    endFrame   = 0;

    std::string audioFilePath;
    std::string swappedAudioPath;

    int  rootNote        = 60;   // MIDI note (from WAV smpl chunk, default C4)
    bool hasSwappedAudio = false;

    // Probed duration (seconds) of the swapped audio file. 0 when no swap or when probe failed.
    // Used by UI to allow clip resize past the original video range when audio is longer.
    double swappedAudioDurationSec = 0.0;

    // ── Sampler settings (per-instrument; shared across all patterns that bind
    //    to this region). These describe how the sample is played back.
    float attackMs        = 0.0f;
    float decayMs         = 0.0f;
    float sustain         = 1.0f;
    float releaseMs       = 50.0f;
    float delayMs         = 0.0f;
    float holdMs          = 0.0f;
    float attackTension   = 0.0f;   // -1..+1 (0 = linear)
    float decayTension    = 0.0f;
    float releaseTension  = 0.0f;

    // Pitch envelope (modulates playback rate)
    bool  pitchEnvEnabled        = false;
    float pitchEnvAmount         = 0.0f;   // semitones, -48..+48
    float pitchEnvDelayMs        = 0.0f;
    float pitchEnvAttackMs       = 0.0f;
    float pitchEnvHoldMs         = 0.0f;
    float pitchEnvDecayMs        = 0.0f;
    float pitchEnvSustain        = 0.0f;   // 0 = no pitch mod at sustain
    float pitchEnvReleaseMs      = 0.0f;
    float pitchEnvAttackTension  = 0.0f;
    float pitchEnvDecayTension   = 0.0f;
    float pitchEnvReleaseTension = 0.0f;

    // Loop points (in samples, relative to region audio start)
    bool    loopEnabled = false;         // false = one-shot mode
    int64_t loopStart   = 0;
    int64_t loopEnd     = 0;             // 0 = end of sample

    // Crossfade / sustained mode
    bool    crossfadeEnabled = false;    // false = one-shot (plays to completion)
                                         // true  = sustained (follows note duration)

    // Trim points (in source samples, 0-indexed)
    int64_t smpStart       = 0;          // playback start offset
    int64_t smpLength      = 0;          // 0 = full from smpStart to end
    float   declickMs      = 1.5f;       // Hann fade width at trim edges (ms; sample-rate independent)
    float   fadeInMs       = 0.0f;       // linear fade-in duration (ms)
    float   fadeOutMs      = 0.0f;       // linear fade-out duration (ms)
    int64_t crossfadeSamples = 0;        // FL-style loop crossfade width (source samples)

    // Precomputed (destructive) effects — applied once to the buffer copy at
    // sampler-load time. Toggling off re-copies from SampleBank.
    bool    dcOffsetRemoved  = false;
    bool    normalized       = false;
    bool    polarityReversed = false;
    bool    reversed         = false;

    // Playback modes
    bool    monoEnabled       = false;
    bool    portamentoEnabled = false;
    float   portamentoTimeMs  = 100.0f;
    bool    arpEnabled        = false;
    bool    arpTempoSync      = true;
    int     arpDivision       = 8;       // musical division (4=quarter, 8=eighth, 16=16th)
    float   arpFreeTimeMs     = 125.0f;  // step time when tempoSync=false
    float   arpGate           = 0.8f;    // 0.0-1.0, note duration portion of step
    int     arpRange          = 1;       // octave range (1=stay, 2=+1 oct, etc.)
    int     arpDirection      = 0;       // 0=Up, 1=Down, 2=UpDown, 3=UpDownSticky

    // ── LFO (per-target: Volume, Panning, Pitch) ────────────────────────────
    struct LfoBreakpoint {
        float time  = 0.0f;   // 0..1 (position within one cycle)
        float value = 0.0f;   // -1..+1
    };

    // Volume LFO
    bool  lfoVolEnabled       = false;
    float lfoVolAmount        = 0.0f;   // 0..1 multiplier depth
    float lfoVolSpeedHz       = 1.0f;
    bool  lfoVolTempoSync     = false;
    int   lfoVolTempoDivision = 4;      // 1=whole, 2=half, 4=quarter, 8=eighth, 16=16th
    float lfoVolAttackMs      = 0.0f;
    float lfoVolDelayMs       = 0.0f;
    std::vector<LfoBreakpoint> lfoVolWaveform;

    // Panning LFO
    bool  lfoPanEnabled       = false;
    float lfoPanAmount        = 0.0f;   // 0..1 pan range
    float lfoPanSpeedHz       = 1.0f;
    bool  lfoPanTempoSync     = false;
    int   lfoPanTempoDivision = 4;
    float lfoPanAttackMs      = 0.0f;
    float lfoPanDelayMs       = 0.0f;
    std::vector<LfoBreakpoint> lfoPanWaveform;

    // Pitch LFO
    bool  lfoPitchEnabled       = false;
    float lfoPitchAmount        = 0.0f; // semitones, -48..+48
    float lfoPitchSpeedHz       = 1.0f;
    bool  lfoPitchTempoSync     = false;
    int   lfoPitchTempoDivision = 4;
    float lfoPitchAttackMs      = 0.0f;
    float lfoPitchDelayMs       = 0.0f;
    std::vector<LfoBreakpoint> lfoPitchWaveform;

    struct Syllable {
        double      startTime = 0.0;
        double      endTime   = 0.0;
        int         number    = 0;
        std::string text;
    };
    std::vector<Syllable> syllables;

    // ── On-demand proxy state (per-region, quote-scoped) ─────────────────────
    // Generated when this region is placed on a non-Chorus/non-Crash grid cell.
    // The proxy is a half-resolution DNxHR LB transcode covering only the
    // [proxyStartTime, proxyEndTime] range in the source file (seconds).
    // When a VideoDecoder reads this proxy, time 0 in the proxy corresponds to
    // proxyStartTime in the source, so callers subtract proxyStartTime from
    // source-time before seeking.
    std::string proxyPath;
    bool        proxyReady     = false;
    double      proxyStartTime = 0.0;
    double      proxyEndTime   = 0.0;

    double getDuration()  const { return endTime - startTime; }
    int    getFrameCount() const { return endFrame - startFrame + 1; }
    bool   isQuote()       const { return label == SampleLabel::Quote; }
    bool   hasSyllables()  const { return !syllables.empty(); }
};

// ─── StretchMethod ────────────────────────────────────────────────────────────

enum class StretchMethod : int {
    Global       = 0,   // Use global setting from preferences
    PSOLA        = 1,   // TD-PSOLA (monophonic speech)
    Rubber       = 2,   // Rubber Band (polyphonic-safe)
    WSOLA        = 3,   // WSOLA (stub — W1)
    PhaseVocoder = 4,   // Phase Vocoder (stub — W2)
    WORLD        = 5    // WORLD vocoder (Harvest+CheapTrick+D4C+Synthesis)
};

// ─── ClipModulation ───────────────────────────────────────────────────────────
// Per-clip modulation FX descriptor (Phase A: data model only — no DSP).
// Houses Vibrato (pitch LFO), Scratch (time/pitch warp), and a linked
// video companion (Vibrato Swirl / Scratch Wave). Defaults are all-off so
// existing projects behave identically once this field is added.

struct ClipModulation {
    // ── Vibrato ─────────────────────────────────────────────────────────────
    struct Vibrato {
        enum class RateMode { FreeHz, TempoSync };
        enum class SyncDivision {
            Whole, Half, Quarter, Eighth, Sixteenth, ThirtySecond,
            QuarterTriplet, EighthTriplet, SixteenthTriplet,
            QuarterDotted, EighthDotted, SixteenthDotted
        };
        enum class Shape { Sine, Triangle, SawUp, SawDown, Square, Custom };

        bool         enabled                = false;
        float        depthCents             = 0.0f;
        RateMode     rateMode               = RateMode::FreeHz;
        float        rateHz                 = 5.0f;
        SyncDivision syncDivision           = SyncDivision::Eighth;
        Shape        shape                  = Shape::Sine;
        bool         phaseResetOnClipStart  = true;
        float        phaseOffset            = 0.0f;
        std::vector<SampleRegion::LfoBreakpoint> customShape;
    };

    // ── Scratch ─────────────────────────────────────────────────────────────
    struct ScratchPoint {
        float time           = 0.0f;
        float rateMultiplier = 1.0f;
        float curve          = 0.0f;
    };
    struct Scratch {
        enum class CurveTimeMode { ClipSeconds, ClipPercent, Beats };
        enum class EdgeMode      { Clamp, Silence, Wrap, PingPong };

        bool          enabled            = false;
        CurveTimeMode timeMode           = CurveTimeMode::ClipSeconds;
        float         smoothingMs        = 2.0f;
        float         gainCompensationDb = 0.0f;
        EdgeMode      edgeMode           = EdgeMode::Clamp;
        std::vector<ScratchPoint> curve;
    };

    // ── Linked video companion ──────────────────────────────────────────────
    struct VideoCompanion {
        bool  vibratoSwirlEnabled    = false;
        bool  scratchWaveEnabled     = false;
        float swirlAmount            = 0.25f;
        float swirlRadius            = 0.45f;
        float swirlCenterX           = 0.5f;
        float swirlCenterY           = 0.5f;
        float waveAmount             = 0.08f;
        float waveFrequency          = 8.0f;
        float smearAmount            = 0.0f;
        bool  reverseWaveWithScratch = true;
    };

    bool           enabled = false;
    Vibrato        vibrato;
    Scratch        scratch;
    VideoCompanion video;
};

// String conversions for modulation enums (forward-compat schema).
inline std::string vibratoRateModeToString(ClipModulation::Vibrato::RateMode m) {
    using R = ClipModulation::Vibrato::RateMode;
    return m == R::TempoSync ? "tempoSync" : "freeHz";
}
inline ClipModulation::Vibrato::RateMode stringToVibratoRateMode(const std::string& s) {
    using R = ClipModulation::Vibrato::RateMode;
    return s == "tempoSync" ? R::TempoSync : R::FreeHz;
}

inline std::string vibratoSyncDivisionToString(ClipModulation::Vibrato::SyncDivision d) {
    using D = ClipModulation::Vibrato::SyncDivision;
    switch (d) {
        case D::Whole:             return "whole";
        case D::Half:              return "half";
        case D::Quarter:           return "quarter";
        case D::Eighth:            return "eighth";
        case D::Sixteenth:         return "sixteenth";
        case D::ThirtySecond:      return "thirtySecond";
        case D::QuarterTriplet:    return "quarterTriplet";
        case D::EighthTriplet:     return "eighthTriplet";
        case D::SixteenthTriplet:  return "sixteenthTriplet";
        case D::QuarterDotted:     return "quarterDotted";
        case D::EighthDotted:      return "eighthDotted";
        case D::SixteenthDotted:   return "sixteenthDotted";
        default:                   return "eighth";
    }
}
inline ClipModulation::Vibrato::SyncDivision stringToVibratoSyncDivision(const std::string& s) {
    using D = ClipModulation::Vibrato::SyncDivision;
    if (s == "whole")             return D::Whole;
    if (s == "half")              return D::Half;
    if (s == "quarter")           return D::Quarter;
    if (s == "eighth")            return D::Eighth;
    if (s == "sixteenth")         return D::Sixteenth;
    if (s == "thirtySecond")      return D::ThirtySecond;
    if (s == "quarterTriplet")    return D::QuarterTriplet;
    if (s == "eighthTriplet")     return D::EighthTriplet;
    if (s == "sixteenthTriplet")  return D::SixteenthTriplet;
    if (s == "quarterDotted")     return D::QuarterDotted;
    if (s == "eighthDotted")      return D::EighthDotted;
    if (s == "sixteenthDotted")   return D::SixteenthDotted;
    return D::Eighth;
}

inline std::string vibratoShapeToString(ClipModulation::Vibrato::Shape s) {
    using S = ClipModulation::Vibrato::Shape;
    switch (s) {
        case S::Sine:     return "sine";
        case S::Triangle: return "triangle";
        case S::SawUp:    return "sawUp";
        case S::SawDown:  return "sawDown";
        case S::Square:   return "square";
        case S::Custom:   return "custom";
        default:          return "sine";
    }
}
inline ClipModulation::Vibrato::Shape stringToVibratoShape(const std::string& s) {
    using S = ClipModulation::Vibrato::Shape;
    if (s == "triangle") return S::Triangle;
    if (s == "sawUp")    return S::SawUp;
    if (s == "sawDown")  return S::SawDown;
    if (s == "square")   return S::Square;
    if (s == "custom")   return S::Custom;
    return S::Sine;
}

inline std::string scratchTimeModeToString(ClipModulation::Scratch::CurveTimeMode m) {
    using M = ClipModulation::Scratch::CurveTimeMode;
    switch (m) {
        case M::ClipSeconds: return "clipSeconds";
        case M::ClipPercent: return "clipPercent";
        case M::Beats:       return "beats";
        default:             return "clipSeconds";
    }
}
inline ClipModulation::Scratch::CurveTimeMode stringToScratchTimeMode(const std::string& s) {
    using M = ClipModulation::Scratch::CurveTimeMode;
    if (s == "clipPercent") return M::ClipPercent;
    if (s == "beats")       return M::Beats;
    return M::ClipSeconds;
}

inline std::string scratchEdgeModeToString(ClipModulation::Scratch::EdgeMode m) {
    using E = ClipModulation::Scratch::EdgeMode;
    switch (m) {
        case E::Clamp:    return "clamp";
        case E::Silence:  return "silence";
        case E::Wrap:     return "wrap";
        case E::PingPong: return "pingPong";
        default:          return "clamp";
    }
}
inline ClipModulation::Scratch::EdgeMode stringToScratchEdgeMode(const std::string& s) {
    using E = ClipModulation::Scratch::EdgeMode;
    if (s == "silence")  return E::Silence;
    if (s == "wrap")     return E::Wrap;
    if (s == "pingPong") return E::PingPong;
    return E::Clamp;
}

// ─── Clip ─────────────────────────────────────────────────────────────────────
// A placed instance of a SampleRegion on a Track at a given TickTime position.
// syllableIndex >= 0 means this clip plays a specific syllable of a Quote region.

struct Clip {
    int      id             = 0;
    int      trackId        = 0;
    int      regionId       = 0;
    TickTime position;
    TickTime duration;
    TickTime regionOffset;              // ticks into region where playback starts (0 = beginning)
    int      syllableIndex  = -1;  // -1 = whole region
    float    velocity       = 1.0f;
    int      pitchOffset    = 0;   // semitones (coarse)

    // Playback modifiers — render path reads these later
    int           pitchOffsetCents = 0;                    // fine pitch ±99 cents
    bool          reversed         = false;                // non-destructive reverse
    double        stretchRatio     = 1.0;                  // 1.0 = normal speed
    StretchMethod stretchMethod    = StretchMethod::Global;
    bool          formantPreserve  = false;

    // Per-clip fade envelope (CSS cubic-bezier convention: P0=(0,0), P3=(1,1))
    float fadeInPercent  = 0.0f;   // percent of visible clip length (0..100)
    float fadeOutPercent = 0.0f;   // percent of visible clip length (0..100)
    float fadeInX1      = 0.0f;    // bezier P1.x for fade-in
    float fadeInY1      = 0.0f;    // bezier P1.y for fade-in
    float fadeInX2      = 1.0f;    // bezier P2.x for fade-in
    float fadeInY2      = 1.0f;    // bezier P2.y for fade-in
    float fadeOutX1     = 0.0f;    // bezier P1.x for fade-out
    float fadeOutY1     = 0.0f;    // bezier P1.y for fade-out
    float fadeOutX2     = 1.0f;    // bezier P2.x for fade-out
    float fadeOutY2     = 1.0f;    // bezier P2.y for fade-out

    // Per-clip modulation FX (Vibrato / Scratch / video companion).
    // Phase A: data only — no DSP reads this yet. Defaults are all-disabled.
    ClipModulation modulation;

    bool isSyllableClip() const { return syllableIndex >= 0; }
};

inline float clampClipFadePercent(float value) {
    if (!(value >= 0.0f)) return 0.0f;
    if (value > 100.0f) return 100.0f;
    return value;
}

inline void normalizeClipFadePercents(float& fadeInPercent, float& fadeOutPercent) {
    fadeInPercent = clampClipFadePercent(fadeInPercent);
    fadeOutPercent = clampClipFadePercent(fadeOutPercent);

    const float total = fadeInPercent + fadeOutPercent;
    if (total > 100.0f) {
        const float scale = 100.0f / total;
        fadeInPercent *= scale;
        fadeOutPercent *= scale;
    }
}

inline float legacyFadeTicksToPercent(float fadeTicks, int64_t durationTicks) {
    if (!(fadeTicks > 0.0f) || durationTicks <= 0) return 0.0f;
    return clampClipFadePercent((fadeTicks * 100.0f) / static_cast<float>(durationTicks));
}

inline int64_t clipFadePercentToSamples(int64_t clipLengthSamples, float fadePercent) {
    if (clipLengthSamples <= 0) return 0;
    const float normalized = clampClipFadePercent(fadePercent);
    return static_cast<int64_t>((static_cast<double>(clipLengthSamples) * normalized) / 100.0);
}

inline void normalizeClipFadePercents(Clip& clip) {
    normalizeClipFadePercents(clip.fadeInPercent, clip.fadeOutPercent);
}

// ─── VideoFlipMode (legacy) ────────────────────────────────────────────────────
// Original 4-option flip enum. Kept only for JSON migration: when a project file
// written before v2 is loaded, `videoFlipMode` is read here and converted to a
// `VideoFlipConfig` via `migrateVideoFlipMode()`. All new code uses VideoFlipConfig.

enum class VideoFlipMode {
    None,              // No flipping
    HorizontalEven,    // Every even-numbered note flips horizontally
    Clockwise,         // Cycle: normal → flipY → flipXY → flipX → repeat
    CounterClockwise   // Cycle: normal → flipX → flipXY → flipY → repeat
};

inline std::string videoFlipModeToString(VideoFlipMode m) {
    switch (m) {
        case VideoFlipMode::None:             return "None";
        case VideoFlipMode::HorizontalEven:   return "HorizontalEven";
        case VideoFlipMode::Clockwise:        return "Clockwise";
        case VideoFlipMode::CounterClockwise: return "CounterClockwise";
        default:                              return "None";
    }
}

inline VideoFlipMode stringToVideoFlipMode(const std::string& s) {
    if (s == "HorizontalEven")   return VideoFlipMode::HorizontalEven;
    if (s == "Clockwise")        return VideoFlipMode::Clockwise;
    if (s == "CounterClockwise") return VideoFlipMode::CounterClockwise;
    return VideoFlipMode::None;
}

// ─── Video Flip v2 — Orientation ──────────────────────────────────────────────
// The six D₄-subset orientations the shader supports. Diagonal mirrors are
// deferred to v2 (the remaining two D₄ elements are rarely needed in practice).

enum class Orientation {
    None,        // identity
    Horizontal,  // mirror left-right  (UV: x = 1 − x)
    Vertical,    // mirror up-down     (UV: y = 1 − y)
    Rotate180,   // half turn          (UV: x = 1 − x; y = 1 − y)
    Rotate90CW,  // quarter turn CW    (UV: (u,v) → (v, 1−u))
    Rotate90CCW  // quarter turn CCW   (UV: (u,v) → (1−v, u))
};

inline std::string orientationToString(Orientation o) {
    switch (o) {
        case Orientation::None:       return "none";
        case Orientation::Horizontal: return "horizontal";
        case Orientation::Vertical:   return "vertical";
        case Orientation::Rotate180:  return "rotate-180";
        case Orientation::Rotate90CW: return "rotate-90-cw";
        case Orientation::Rotate90CCW:return "rotate-90-ccw";
        default:                      return "none";
    }
}

inline Orientation stringToOrientation(const std::string& s) {
    if (s == "horizontal")    return Orientation::Horizontal;
    if (s == "vertical")      return Orientation::Vertical;
    if (s == "rotate-180")    return Orientation::Rotate180;
    if (s == "rotate-90-cw")  return Orientation::Rotate90CW;
    if (s == "rotate-90-ccw") return Orientation::Rotate90CCW;
    return Orientation::None;
}

// ─── Video Flip v2 — VideoFlipState ───────────────────────────────────────────
// One entry in the ordered flip cycle for a track. `id` is a stable client-side
// identifier (used by the UI to track drag/reorder without index drift).

struct VideoFlipState {
    std::string id;
    Orientation orientation = Orientation::None;
    std::string label;  // optional user-facing name; empty = use orientation name
};

// ─── Video Flip v2 — VideoFlipModifier ────────────────────────────────────────
// Rule that decides whether each trigger event advances the state machine.
// Only one `type` is active at a time; only the relevant config fields are used.

struct VideoFlipModifier {
    enum class Type {
        EveryNote,       // every-note:       advance on every mono trigger
        NewNote,         // new-note:         advance when pitch changes vs. previous mono
        SpecificPitches, // specific-pitches: advance only for whitelisted MIDI pitches
        EveryNBeats      // every-n-beats:    advance every N beats/bars regardless of notes
    };
    Type type = Type::EveryNote;

    // SpecificPitches config: MIDI note numbers that trigger an advance.
    std::vector<int> pitches;

    // EveryNBeats config.
    int n = 1;  // 1..32
    enum class Subdivision { Beat, Bar };
    Subdivision subdivision = Subdivision::Beat;
};

inline std::string videoFlipModifierTypeToString(VideoFlipModifier::Type t) {
    switch (t) {
        case VideoFlipModifier::Type::EveryNote:       return "every-note";
        case VideoFlipModifier::Type::NewNote:         return "new-note";
        case VideoFlipModifier::Type::SpecificPitches: return "specific-pitches";
        case VideoFlipModifier::Type::EveryNBeats:     return "every-n-beats";
        default:                                       return "every-note";
    }
}

inline VideoFlipModifier::Type stringToVideoFlipModifierType(const std::string& s) {
    if (s == "new-note")         return VideoFlipModifier::Type::NewNote;
    if (s == "specific-pitches") return VideoFlipModifier::Type::SpecificPitches;
    if (s == "every-n-beats")    return VideoFlipModifier::Type::EveryNBeats;
    return VideoFlipModifier::Type::EveryNote;
}

inline std::string videoFlipSubdivisionToString(VideoFlipModifier::Subdivision s) {
    return s == VideoFlipModifier::Subdivision::Bar ? "bar" : "beat";
}

inline VideoFlipModifier::Subdivision stringToVideoFlipSubdivision(const std::string& s) {
    return s == "bar" ? VideoFlipModifier::Subdivision::Bar
                      : VideoFlipModifier::Subdivision::Beat;
}

// ─── Video Flip v2 — VideoFlipConfig ──────────────────────────────────────────
// Per-track flip state machine configuration. Persisted to project JSON.
// `enabled = false` means the track renders the identity transform; the resolver
// is skipped entirely. `states` is always 1..12 elements.

struct VideoFlipConfig {
    bool                       enabled         = false;
    std::vector<VideoFlipState> states;       // 1..12 elements
    VideoFlipModifier           modifier;
    int                         startStateIndex = 0;  // 0..states.size()-1
};

// Default config assigned to every new track.
inline VideoFlipConfig defaultVideoFlipConfig() {
    VideoFlipConfig cfg;
    cfg.enabled         = false;
    cfg.states          = { VideoFlipState{"s0", Orientation::None, ""} };
    // modifier defaults: EveryNote, no extra config
    cfg.startStateIndex = 0;
    return cfg;
}

// Migrate a legacy VideoFlipMode value to the equivalent VideoFlipConfig (spec §3.5).
// This is called once at project load when a pre-v2 `videoFlipMode` string is found.
inline VideoFlipConfig migrateVideoFlipMode(VideoFlipMode legacy) {
    VideoFlipConfig cfg;
    cfg.modifier.type = VideoFlipModifier::Type::EveryNote;
    switch (legacy) {
        case VideoFlipMode::None:
            cfg.enabled         = false;
            cfg.states          = { {"s0", Orientation::None, ""} };
            cfg.startStateIndex = 0;
            break;
        case VideoFlipMode::HorizontalEven:
            // startStateIndex=1: ordinal 0 maps to state 1 (horizontal) — matches
            // legacy shader which flipped on globalNoteIndex % 2 == 0 (0-indexed).
            cfg.enabled         = true;
            cfg.states          = { {"s0", Orientation::None,       ""},
                                    {"s1", Orientation::Horizontal,  ""} };
            cfg.startStateIndex = 1;
            break;
        case VideoFlipMode::Clockwise:
            cfg.enabled         = true;
            cfg.states          = { {"s0", Orientation::None,      ""},
                                    {"s1", Orientation::Vertical,  ""},
                                    {"s2", Orientation::Rotate180, ""},
                                    {"s3", Orientation::Horizontal,""} };
            cfg.startStateIndex = 0;
            break;
        case VideoFlipMode::CounterClockwise:
            cfg.enabled         = true;
            cfg.states          = { {"s0", Orientation::None,      ""},
                                    {"s1", Orientation::Horizontal,""},
                                    {"s2", Orientation::Rotate180, ""},
                                    {"s3", Orientation::Vertical,  ""} };
            cfg.startStateIndex = 0;
            break;
    }
    return cfg;
}

// Best-effort reverse: returns the legacy mode string for a config that matches
// a canonical migration pattern, or "None" for configs with no legacy equivalent.
// Used by the bridge to keep `videoFlipMode` in the N-API track object for UI
// backward compatibility until Phase 5 replaces the context menu.
inline std::string videoFlipConfigToLegacyMode(const VideoFlipConfig& cfg) {
    if (!cfg.enabled) return "None";
    if (cfg.modifier.type != VideoFlipModifier::Type::EveryNote) return "None";
    const auto& st = cfg.states;
    if (st.size() == 2
        && st[0].orientation == Orientation::None
        && st[1].orientation == Orientation::Horizontal
        && cfg.startStateIndex == 1)
        return "HorizontalEven";
    if (st.size() == 4
        && st[0].orientation == Orientation::None
        && st[1].orientation == Orientation::Vertical
        && st[2].orientation == Orientation::Rotate180
        && st[3].orientation == Orientation::Horizontal
        && cfg.startStateIndex == 0)
        return "Clockwise";
    if (st.size() == 4
        && st[0].orientation == Orientation::None
        && st[1].orientation == Orientation::Horizontal
        && st[2].orientation == Orientation::Rotate180
        && st[3].orientation == Orientation::Vertical
        && cfg.startStateIndex == 0)
        return "CounterClockwise";
    return "None";
}

// ─── Visual Compositor Effect Settings ────────────────────────────────────────

struct BounceSettings {
    bool   enabled        = false;
    float  directionDeg   = 270.0f;  // 0=right, 90=up, 180=left, 270=down
    float  distance       = 0.15f;   // fraction of cell size (0.0–1.0)
    float  durationMs     = 200.0f;
    float  squashAmount   = 0.0f;    // 0.0–1.0
    float  overshoot      = 1.70158f;// ease-out-back c1 constant
    int    repeatCount    = 1;       // 1 = single, 2+ = repeat with decay
    int    easingType     = 0;       // 0=EaseOutBack, 1=Elastic, 2=Spring
};

struct PingPongSettings {
    bool   enabled          = false;
    float  regionStartPct   = 0.8f;  // 0.0–1.0
    float  regionEndPct     = 1.0f;  // 0.0–1.0
    int    crossfadeFrames  = 3;
    float  reverseSpeed     = 1.0f;  // speed multiplier for reverse section
    int    maxLoops         = 0;     // 0 = infinite
};

struct ZoomPanRotSettings {
    bool   enabled          = false;
    float  startZoom        = 1.0f;
    float  targetZoom       = 1.0f;
    float  startPanX        = 0.0f;
    float  startPanY        = 0.0f;
    float  targetPanX       = 0.0f;
    float  targetPanY       = 0.0f;
    float  startRotation    = 0.0f;  // degrees
    float  targetRotation   = 0.0f;  // degrees
    float  durationMs       = 300.0f;
    int    zoomEasing       = 1;     // 0=Linear, 1=EaseOut, 2=EaseInOut, 3=EaseOutBack
    int    panEasing        = 1;
    int    rotEasing        = 1;
    float  overshoot        = 1.70158f;
};

// Slide-only TV Simulator parameter set.
// Mirrors the 7 user-facing TV Simulator params (VisualEffect TVSimulator
// params[0..6]) but as a named struct so slide configs don't have to index
// into the typeless float[16] used by the chain entry.
//
// NOTE on intensity behaviour: the slide TV ramp now ramps 0 -> peak over
// the slide duration, latches at peak, and returns according to the parent
// SlideNoteEffectSettings.returnStyle / returnTrigger. Earlier versions
// ramped peak -> 0 automatically; old projects pick up the new behaviour
// via the chosen defaults on returnStyle / returnTrigger.
struct SlideTVSettings {
    float intensity   = 0.5f;    // 0..1 — peak intensity at the end of the ramp-up
    float rollSpeed   = 1.0f;    // 0..5
    float scanlines   = 0.3f;    // 0..1
    float chroma      = 0.003f;  // 0..0.01
    float noise       = 0.0f;    // 0..1
    float jitter      = 2.0f;    // 0..10
    float colorBleed  = 0.0f;    // 0..0.02
};

struct SlideNoteEffectSettings {
    enum class EffectType    { None = 0, ZoomPanRot = 1, Bounce = 2, TVSimulator = 3 };
    enum class DurationMode  { FollowSlide = 0, Fixed = 1 };
    // Visual return policy (added with the configurable-return system):
    //   ReturnStyle   — how the visual returns to the captured pre-slide state.
    //   ReturnTrigger — when the return is fired:
    //                   * NextNormalNote: the next non-slide PatternNote on the
    //                     same Pattern Track triggers return.
    //                   * NextSlideNote:  normal notes do NOT return; the next
    //                     slide note on the same track is *consumed* as the
    //                     return trigger (it does NOT also trigger a new slide
    //                     in the same event). Produces a toggle pattern:
    //                     slide -> target, slide -> base, slide -> target, ...
    enum class ReturnStyle   { Instant = 0, SmoothReverse = 1 };
    enum class ReturnTrigger { NextNormalNote = 0, NextSlideNote = 1 };

    EffectType    type             = EffectType::None;
    DurationMode  durationMode     = DurationMode::FollowSlide;
    float         fixedDurationMs  = 300.0f;

    // Visual return policy — applies to ZoomPanRot and TVSimulator. Bounce
    // auto-returns through its own oscillation cycle and ignores these.
    ReturnStyle   returnStyle      = ReturnStyle::SmoothReverse;
    ReturnTrigger returnTrigger    = ReturnTrigger::NextNormalNote;
    float         returnDurationMs = 200.0f;   // only used when returnStyle == SmoothReverse

    // Reused from the Visual FX modules so slide controls match the existing
    // module UX (labels, ranges, defaults). When used as slide configs, the
    // .enabled and .durationMs fields are IGNORED — slide duration is owned
    // exclusively by durationMode + fixedDurationMs above. The slide UI hides
    // those fields via hideEnabled / hideDuration props.
    BounceSettings     bounce;
    ZoomPanRotSettings zoomPanRot;
    SlideTVSettings    tv;
};

struct SlideAnimationEvent {
    double   startBeat      = 0.0;
    double   durationBeats  = 0.0;
    int      trackId        = -1;
    float    slideVelocity  = 0.0f;
    float    slideCurveCx   = 0.5f;  // bezier control point from PatternNote
    float    slideCurveCy   = 0.5f;
};

struct VisualEffect {
    enum class Type {
        Desaturation       = 0,
        Tint               = 1,
        BrightnessContrast = 2,
        TVSimulator        = 3,
        ZoomPanRotation    = 4
    };
    Type type   = Type::Desaturation;
    bool bypassed = false;

    // Flat float array for GPU CB, interpreted per-type.
    // Desaturation:       [0]=amount
    // Tint:               [0]=r [1]=g [2]=b [3]=strength [4]=lightnessFloor [5]=lightnessCeiling
    // BrightnessContrast: [0]=brightness [1]=contrast
    // TVSimulator:        [0]=intensity [1]=rollSpeed [2]=scanlineAlpha [3]=chromaOffset
    //                     [4]=staticNoise [5]=jitterFreq [6]=colorBleed
    // ZoomPanRotation:    [0]=startZoom [1]=targetZoom [2]=startPanX [3]=startPanY
    //                     [4]=targetPanX [5]=targetPanY [6]=startRotation [7]=targetRotation
    //                     [8]=durationMs [9]=zoomEasing [10]=panEasing [11]=rotEasing [12]=overshoot
    float params[16] = {};
};

// ─── PatternNote ──────────────────────────────────────────────────────────────
// A single MIDI-like note within a Pattern.

struct PatternNote {
    int      id       = 0;
    TickTime position;              // within the pattern (0 = pattern start)
    TickTime duration;
    int      pitch    = 60;         // MIDI note (0-127, 60 = C4)
    float    velocity = 1.0f;       // 0..1 ; also maps to video opacity

    // ── Slide note (visual animation trigger) ─────────────────────────────
    // When isSlide=true, this note does NOT spawn a video cell. Instead, on
    // the beat-crossing of its startBeat, the per-track SlideNoteEffectSettings
    // fires (ZPR/Bounce/TVSimulator) on the existing cell. Audio portamento is
    // independent of this flag.
    bool     isSlide      = false;
    float    slideCurveCx = 0.5f;   // bezier control point (cubic 0,0 → cx,cy → 1-cx,1-cy → 1,1)
    float    slideCurveCy = 0.5f;
};

// ─── Pattern ──────────────────────────────────────────────────────────────────
// A named MIDI-like sequence played through a sampler bound to one SampleRegion.

struct Pattern {
    int         id        = 0;
    std::string name;
    int         regionId  = -1;
    TickTime    length;                  // user-set
    std::vector<PatternNote> notes;
    int         nextNoteId = 1;          // per-pattern note-ID counter
};

// ─── PatternBlock ─────────────────────────────────────────────────────────────
// A pattern placed on the timeline — the pattern-track analogue of Clip.

struct PatternBlock {
    int      id        = 0;
    int      trackId   = 0;
    int      patternId = 0;
    TickTime position;           // timeline position
    TickTime duration;           // > pattern.length → loops (if loopEnabled) ; < pattern.length → trimmed right
    TickTime offset;             // trimmed left edge within the pattern
    bool     loopEnabled = false; // true: notes loop past pattern.length; false: empty space past pattern.length
};

// ─── TrackColor (Pass 6D + 6F) ────────────────────────────────────────────────
// Per-track color assignment metadata. UI-only — engine audio/video pipelines
// ignore these fields. `Auto` means the renderer derives the color from the
// visible track index modulo the 16-slot theme palette. `PaletteSlot` means
// the user picked an explicit slot (1..16) from the same theme palette.
// `Custom` (Pass 6F) carries a user-supplied #RRGGBB hex color.
//
// trackColorSlot is only meaningful when trackColorMode == PaletteSlot.
// trackColorCustom is only meaningful when trackColorMode == Custom.
// In any other mode the irrelevant field is cleared. Loader sanitizes
// invalid combinations to Auto.

enum class TrackColorMode { Auto, PaletteSlot, Custom };

enum class TrackFxMode { Chain, Graph };

inline std::string trackFxModeToString(TrackFxMode m) {
    return m == TrackFxMode::Graph ? "graph" : "chain";
}

inline TrackFxMode stringToTrackFxMode(const std::string& s) {
    return s == "graph" ? TrackFxMode::Graph : TrackFxMode::Chain;
}

inline std::string trackColorModeToString(TrackColorMode m) {
    switch (m) {
        case TrackColorMode::PaletteSlot: return "paletteSlot";
        case TrackColorMode::Custom:      return "custom";
        default:                          return "auto";
    }
}

inline TrackColorMode stringToTrackColorMode(const std::string& s) {
    if (s == "paletteSlot") return TrackColorMode::PaletteSlot;
    if (s == "custom")      return TrackColorMode::Custom;
    return TrackColorMode::Auto;
}

// Pass 6F custom hex validation. Strict #RRGGBB (7 chars, leading '#', six
// hex digits). Case-insensitive on input. Empty is "no custom assigned".
// Never throws.
inline bool isValidTrackCustomColor(const std::string& v) {
    if (v.size() != 7 || v[0] != '#') return false;
    for (size_t i = 1; i < 7; ++i) {
        const char c = v[i];
        const bool ok = (c >= '0' && c <= '9')
                     || (c >= 'a' && c <= 'f')
                     || (c >= 'A' && c <= 'F');
        if (!ok) return false;
    }
    return true;
}

// Returns uppercase #RRGGBB for valid input, empty string for invalid.
inline std::string normalizeTrackCustomColor(const std::string& v) {
    if (!isValidTrackCustomColor(v)) return "";
    std::string out = v;
    for (size_t i = 1; i < out.size(); ++i) {
        if (out[i] >= 'a' && out[i] <= 'f') out[i] = static_cast<char>(out[i] - 32);
    }
    return out;
}

// ─── TrackInfo ────────────────────────────────────────────────────────────────
// Metadata for a sequencer track, including both audio mix and video layout.

struct TrackInfo {
    int         id           = 0;
    std::string name;
    float       volume       = 1.0f;
    float       pan          = 0.0f;
    float       stereoSpread = 1.0f;  // 0.0=mono, 1.0=original, 2.0=exaggerated
    bool        muted        = false;
    bool        solo         = false;
    bool        visualOnly   = false;
    int         order        = 0;

    float videoX       = 0.0f;
    float videoY       = 0.0f;
    float videoW       = 1920.0f;
    float videoH       = 1080.0f;
    float videoOpacity = 1.0f;
    int   videoZOrder  = 0;

    // ── Track type extension (pattern/sampler system) ─────────────────────
    // Pattern tracks are sample-agnostic containers for PatternBlocks. Each
    // block references a Pattern, and each Pattern carries its own regionId.
    // Any pattern can be placed on any pattern track.
    enum class Type { Clip, Pattern };
    Type            type            = Type::Clip;
    VideoFlipConfig videoFlipConfig = defaultVideoFlipConfig();

    // When true: if a note sustains past the sample's trimmed video length,
    // hold the last frame of the trim region until note-off. When false
    // (default): cell goes transparent (gap). Auto-enabled when a track is
    // assigned as the chorus track.
    bool videoHoldLastFrame = false;

    // ── Visual compositor effect settings ────────────────────────────────
    float                           gapScaleOverride = -1.0f; // -1 = use global, >=0 = override
    float                           cornerRadius     = 0.0f;  // 0.0–1.0
    BounceSettings                  bounce;
    PingPongSettings                pingPong;
    ZoomPanRotSettings              zoomPanRot;
    SlideNoteEffectSettings         slideNoteEffect;
    std::vector<VisualEffect>       visualEffectChain;

    // Sub-column subdivision used when placing this track in the grid. 1 =
    // full column (default), 2 = half, 4 = quarter, 8 = eighth. Drives the
    // renderer's snap step and default placement width; engine treats it as
    // opaque metadata.
    int subdivisionFactor = 1;

    // ── Track color (Pass 6D + 6F) ──────────────────────────────────────────
    // UI-only metadata controlling Timeline track color. Auto derives the
    // color by visible index; PaletteSlot pins to slot 1..16 of the theme
    // palette; Custom (Pass 6F) carries a #RRGGBB hex literal. Engine
    // audio/video pipelines ignore these fields.
    TrackColorMode trackColorMode   = TrackColorMode::Auto;
    int            trackColorSlot   = 0;   // 1..16 when PaletteSlot; 0 = unassigned
    std::string    trackColorCustom = "";  // "#RRGGBB" when Custom; empty otherwise

    // Per-track FX ownership. Chain is the default FL-style workflow; Graph is
    // optional ownership for the future separate FX Graph workspace.
    TrackFxMode    fxMode           = TrackFxMode::Chain;

    // Opaque renderer-owned FX graph document. The engine persists this JSON
    // without parsing, migrating, or executing it.
    bool           hasGraphState    = false;
    nlohmann::json graphState       = nlohmann::json();
};

inline std::string trackTypeToString(TrackInfo::Type t) {
    return t == TrackInfo::Type::Pattern ? "Pattern" : "Clip";
}

inline TrackInfo::Type stringToTrackType(const std::string& s) {
    return s == "Pattern" ? TrackInfo::Type::Pattern : TrackInfo::Type::Clip;
}

// ─── Grid sub-unit constants ──────────────────────────────────────────────────
// Grid coordinates run on a fine sub-unit grid: each column is divided into
// kGridSubUnitsPerColumn equal pieces, each row into kGridSubUnitsPerRow.
// Set to 8 (the LCM of supported per-track subdivision factors {1,2,4,8}) so
// every factor maps to an exact integer span.
//
// Legacy projects stored coordinates in HALF units (implicit 2 sub-units per
// axis). Timeline::fromJSON migrates them by multiplying by 4 when the saved
// gridLayoutVersion is missing or < 2. New projects write the current version.
//
// gridLayoutVersion history:
//   v1 (implicit) — half-grid coordinates (2 sub-units per column)
//   v2            — fine-grid coordinates (kGridSubUnitsPerColumn per column)
//   v3            — unified fullscreenLayers replaces chorusTrackId / crashEnabled
//                   / crashTrackId / crashOpacity. v≤2 projects are migrated on
//                   load by synthesizing layers from those legacy fields.
constexpr int kGridSubUnitsPerColumn = 8;
constexpr int kGridSubUnitsPerRow    = 8;
constexpr int kGridLegacyHalfUnits   = 2;        // pre-v2 sub-unit count
constexpr int kGridLegacyToFineScale = kGridSubUnitsPerColumn / kGridLegacyHalfUnits; // = 4
constexpr int kGridLayoutVersionFineUnits = 3;
constexpr int kGridSubdivisionMax = 8;

// ─── Project file format version ──────────────────────────────────────────────
// Increment whenever a breaking schema change is introduced that requires
// migration on load. Readers must handle any version ≤ current gracefully.
//   v1 (implicit, no field)  — original schema with videoFlipMode string
//   v2                       — videoFlipConfig replaces videoFlipMode (flip v2)
//   v3                       — unified fullscreenLayers replaces chorus/crash
constexpr int kProjectFileVersion = 3;

// ─── GridSlot ─────────────────────────────────────────────────────────────────
// One track's placement in the video grid. Coordinates are in fine-grid units:
// for an N×M grid, coords run 0..N*kGridSubUnitsPerColumn-1 and
// 0..M*kGridSubUnitsPerRow-1. A full-column placement spans kGridSubUnitsPerColumn
// horizontally; a track with subdivisionFactor=F places at width
// kGridSubUnitsPerColumn / F.

struct GridSlot {
    int   trackId = -1;
    int   gridX   = 0;     // 0 .. columns*kGridSubUnitsPerColumn - 1
    int   gridY   = 0;     // 0 .. rows   *kGridSubUnitsPerRow    - 1
    int   spanX   = kGridSubUnitsPerColumn;
    int   spanY   = kGridSubUnitsPerRow;
    float opacity = 1.0f;
    int   zOrder  = 0;
};

// ─── FullscreenLayer ──────────────────────────────────────────────────────────
// One fullscreen video layer in the grid. Layers are ordered: index 0 sits at
// the bottom of its placement stack; later entries draw on top within the same
// placement. BehindGrid layers render before grid cells; InFrontOfGrid layers
// render after. Replaces the pre-v3 chorus + crash special cases.

enum class FullscreenLayerPlacement { BehindGrid, InFrontOfGrid };

struct FullscreenLayer {
    int                      trackId   = -1;
    FullscreenLayerPlacement placement = FullscreenLayerPlacement::BehindGrid;
    float                    opacity   = 1.0f;
};

// ─── GridLayout ───────────────────────────────────────────────────────────────
// Project-level video grid configuration. Each track can be assigned to one
// slot in the N×M grid. Any number of fullscreen layers can be stacked behind
// or in front of the grid via fullscreenLayers.

struct GridLayout {
    int   columns       = 3;       // N (1-8)
    int   rows          = 3;       // M (1-8)
    std::vector<GridSlot> slots;
    std::vector<FullscreenLayer> fullscreenLayers;
    int   previewFps    = 30;      // 1-120
    float gapScale      = 0.0f;   // 0.0–0.5
};
