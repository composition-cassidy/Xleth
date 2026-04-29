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
    float fadeInTicks   = 0.0f;    // fade-in duration in ticks (0 = no fade)
    float fadeOutTicks  = 0.0f;    // fade-out duration in ticks (0 = no fade)
    float fadeInX1      = 0.0f;    // bezier P1.x for fade-in
    float fadeInY1      = 0.0f;    // bezier P1.y for fade-in
    float fadeInX2      = 1.0f;    // bezier P2.x for fade-in
    float fadeInY2      = 1.0f;    // bezier P2.y for fade-in
    float fadeOutX1     = 0.0f;    // bezier P1.x for fade-out
    float fadeOutY1     = 0.0f;    // bezier P1.y for fade-out
    float fadeOutX2     = 1.0f;    // bezier P2.x for fade-out
    float fadeOutY2     = 1.0f;    // bezier P2.y for fade-out

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

struct SlideNoteEffectSettings {
    enum class EffectType { None = 0, ZoomPanRot = 1, Bounce = 2, TVSimulator = 3 };
    EffectType type         = EffectType::None;
    enum class DurationMode { FollowSlide = 0, Fixed = 1 };
    DurationMode durationMode = DurationMode::FollowSlide;
    float fixedDurationMs   = 300.0f;

    // Delta fields (Prompt 11) — additive deltas applied at slide fire time.
    // Consumed by AnimationManager::triggerSlide in a later prompt; currently
    // present for project serialization forward-compatibility.
    float slideZoomDelta      = 1.0f;  // multiplicative (1 = no change)
    float slidePanXDelta      = 0.0f;
    float slidePanYDelta      = 0.0f;
    float slideRotationDelta  = 0.0f;  // degrees
    float slideBounceDistance = 0.0f;
    float slideBounceDirDeg   = 0.0f;
    float slideTVIntensity    = 0.0f;
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
    Type          type          = Type::Clip;
    VideoFlipMode videoFlipMode = VideoFlipMode::None;

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
// gridLayoutVersion is missing or < 2. New projects write gridLayoutVersion=2.
constexpr int kGridSubUnitsPerColumn = 8;
constexpr int kGridSubUnitsPerRow    = 8;
constexpr int kGridLegacyHalfUnits   = 2;        // pre-v2 sub-unit count
constexpr int kGridLegacyToFineScale = kGridSubUnitsPerColumn / kGridLegacyHalfUnits; // = 4
constexpr int kGridLayoutVersionFineUnits = 2;
constexpr int kGridSubdivisionMax = 8;

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
    float gapScale      = 0.0f;   // 0.0–0.5
};
