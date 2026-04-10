#pragma once
#include <cstdint>
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
    int     declickSamples = 64;         // Hann fade width at trim edges
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
    PhaseVocoder = 4    // Phase Vocoder (stub — W2)
};

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

    bool isSyllableClip() const { return syllableIndex >= 0; }
};

// ─── VideoFlipMode ────────────────────────────────────────────────────────────
// Controls per-note/clip video flipping for all track types.

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

// ─── PatternNote ──────────────────────────────────────────────────────────────
// A single MIDI-like note within a Pattern.

struct PatternNote {
    int      id       = 0;
    TickTime position;              // within the pattern (0 = pattern start)
    TickTime duration;
    int      pitch    = 60;         // MIDI note (0-127, 60 = C4)
    float    velocity = 1.0f;       // 0..1 ; also maps to video opacity
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
    Type          type          = Type::Clip;
    VideoFlipMode videoFlipMode = VideoFlipMode::None;

    // When true: if a note sustains past the sample's trimmed video length,
    // hold the last frame of the trim region until note-off. When false
    // (default): cell goes transparent (gap). Auto-enabled when a track is
    // assigned as the chorus track.
    bool videoHoldLastFrame = false;
};

inline std::string trackTypeToString(TrackInfo::Type t) {
    return t == TrackInfo::Type::Pattern ? "Pattern" : "Clip";
}

inline TrackInfo::Type stringToTrackType(const std::string& s) {
    return s == "Pattern" ? TrackInfo::Type::Pattern : TrackInfo::Type::Clip;
}

// ─── GridSlot ─────────────────────────────────────────────────────────────────
// One track's placement in the video grid. Coordinates are in half-grid units:
// for an N×M grid, coords run 0..2N-1 and 0..2M-1. A main cell spans 2×2, a
// half-cell spans 1×1 — allowing tucked-in boxes between main cells.

struct GridSlot {
    int   trackId = -1;
    int   gridX   = 0;     // 0 .. 2*columns-1 (half-grid coords)
    int   gridY   = 0;     // 0 .. 2*rows-1
    int   spanX   = 2;     // 2 = main cell, 1 = half cell
    int   spanY   = 2;
    float opacity = 1.0f;
    int   zOrder  = 0;
};

// ─── GridLayout ───────────────────────────────────────────────────────────────
// Project-level video grid configuration. Each track can be assigned to one
// slot in the N×M grid. Optional chorus layer renders behind grid; optional
// crash overlay renders on top when triggered.

struct GridLayout {
    int   columns       = 3;       // N (1-8)
    int   rows          = 3;       // M (1-8)
    std::vector<GridSlot> slots;
    int   chorusTrackId = -1;      // -1 = disabled
    bool  crashEnabled  = false;
    int   crashTrackId  = -1;
    float crashOpacity  = 0.7f;
    int   previewFps    = 30;      // 1-120
};
