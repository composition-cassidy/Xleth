#pragma once
#include "SamplerModulationConfig.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <nlohmann/json.hpp>
#include <random>
#include <string>
#include <unordered_map>
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

    // ── Exact frame rate ─────────────────────────────────────────────────────
    // fps above is a lossy view of this. 23.976 fps is really 24000/1001, and a
    // double cannot survive the time → frame → PTS round trip without drifting:
    // deriving a frame duration from the double is what produced the
    // depth-proportional video desync (see engine/src/render/FrameRateMath.h).
    // Populated from the stream's r_frame_rate at import. Zero for projects
    // written before this field existed and for audio-only sources — callers
    // must go through xleth::frametiming::rateFromSource(), which reconstructs
    // the rational from the legacy double in that case.
    int         fpsNum      = 0;
    int         fpsDen      = 0;

    double      duration    = 0.0;
    int         totalFrames = 0;
    bool        hasVideo    = false;
    bool        proxyReady  = false;

    // ── Poster fast-preview sidecar (preview-only) ───────────────────────────
    // posterPath points at a single representative JPEG frame extracted at
    // import (see ProxyTranscoder::extractPoster). When poster preview mode is
    // on, grid cells bind this frame instead of live-decoding — flip + opacity
    // are still applied by the compositor exactly as for live frames. NEVER
    // consulted by the render/export path.
    std::string posterPath;
    bool        posterReady = false;

    // ── Whole-source preview proxy (preview-only) ────────────────────────────
    // ONE small all-intra proxy of the ENTIRE source, downscaled to
    // previewProxyHeight (aspect-preserved). When ready, ALL preview decode —
    // grid cells AND fullscreen/backdrop layers — reads frames from this proxy
    // instead of the 4K original (FrameCollector substitutes the path; frame
    // indices map 1:1 because every source frame is kept at the source fps).
    // Random access into the small intra proxy is cheap, so LIVE preview stays
    // smooth even when scrubbing into previously-unvisited regions. Generated
    // once in the background on the ProxyManager pool; persisted + reused across
    // sessions (re-validated against disk on load, like posterPath). NEVER
    // consulted by the render/export path (collectRequests is called with
    // allowProxy=false there).
    std::string previewProxyPath;
    bool        previewProxyReady  = false;
    int         previewProxyHeight = 0;   // resolved height of the proxy on disk

    // ── Per-offset preview thumbnails (preview-only, runtime cache) ───────────
    // Poster mode used to bind ONE poster (frame 0) per source, so every grid
    // cell of the same source showed the SAME frame — useless when one source is
    // placed at many time-offsets. Instead we cache a representative thumbnail
    // per coarse source-time bucket (1-second buckets): key = floor(sourceStart),
    // value = JPEG path on disk (<stem>.t<bucket>.xlposter.jpg). FrameCollector
    // binds the cell's own bucket thumbnail, falling back to posterPath until it
    // is generated, so cells are never blank. Generated lazily on the ProxyManager
    // pool; NOT serialized (rebuilt from disk / regenerated). Touched only by the
    // video thread (drain installs, FrameCollector reads).
    std::unordered_map<int, std::string> thumbnailPaths;
};

// ─── SampleSlot ───────────────────────────────────────────────────────────────
// One layer of a sampler. A SampleRegion owns 1..MAX_SAMPLE_SLOTS of these;
// every sounding slot spawns its own resampling stream on each note-on, so a
// single note plays all slots stacked (see Sampler::noteOn).
//
// Slot 0 is special ONLY in where its audio comes from: it always plays the
// region's own audio (source range, or swappedAudioPath when hasSwappedAudio).
// Slots 1..7 carry their own `audioFilePath`, an independent file copied into
// the project's slots/ directory. Everything else — tuning, level, trim, loop,
// destructive flags — is symmetric across all slots.
//
// Swapping the region's audio therefore rebinds slot 0's PCM and touches no
// slot's settings and no other slot at all.

// ─── SampleLoopMode ───────────────────────────────────────────────────────────
// How a slot's read head traverses [loopStart, loopEnd) once it arrives there.
//   Forward  — wrap loopEnd → loopStart (the historical behaviour, crossfaded).
//   PingPong — reflect at both ends. The seam is value-continuous by
//              construction, so it takes no crossfade.
//   Reverse  — descend loopEnd → loopStart, then wrap back up to loopEnd. The
//              wrap is a genuine discontinuity, so the forward crossfade is
//              applied mirrored around the loop.
enum class SampleLoopMode : int {
    Forward  = 0,
    PingPong = 1,
    Reverse  = 2
};

// One MANGLE unit in a slot's ordered chain. The model mirrors the engine's
// xleth::mangle::InstanceConfig; MixEngine converts one to the other when it
// syncs a slot into its Sampler.
struct MangleInstance {
    int   mode   = 0;      // xleth::mangle::Mode id (0 = Off). Persisted; enum is append-only.
    float amount = 0.0f;   // 0..1
    float mix    = 1.0f;   // 0..1 (fully wet by default, so picking a mode is audible)
    bool  bypass = false;  // true ⇒ the instance is skipped, at no cost
};

struct SampleSlot {
    // ── Audio identity ───────────────────────────────────────────────────────
    // Empty for slot 0 (its PCM comes from the region). Absolute path into the
    // project's slots/ dir for slots 1..7.
    std::string audioFilePath;
    std::string name;                    // display label; falls back to filename

    // ── Tuning ───────────────────────────────────────────────────────────────
    // The four controls are independent and SUM into one pitch offset:
    //   semitoneOffset = octave*12 + semitone + coarse + fine/100
    // applied on top of (midiNote - rootNote). See SampleSlot::tuningSemitones().
    int   rootNote = 60;                 // MIDI note the sample is recorded at
    int   octave   = 0;                  // ±4 octaves
    int   semitone = 0;                  // ±12 semitones
    float fine     = 0.0f;               // ±100 cents
    int   coarse   = 0;                  // ±48 semitones

    // ── Level ────────────────────────────────────────────────────────────────
    float volume = 1.0f;                 // 0..2 linear gain
    float pan    = 0.0f;                 // -1 = hard L, 0 = centre, +1 = hard R
    bool  mute   = false;
    bool  solo   = false;                // any slot solo'd ⇒ only solo'd slots sound

    // ── Trim + declick (source samples / ms) ─────────────────────────────────
    int64_t smpStart  = 0;               // playback start offset
    int64_t smpLength = 0;               // 0 = full from smpStart to end
    float   declickMs = 1.5f;            // Hann fade width at trim edges
    float   fadeInMs  = 0.0f;            // linear fade-in
    float   fadeOutMs = 0.0f;            // linear fade-out

    // ── Loop ─────────────────────────────────────────────────────────────────
    // Only takes effect when the region is in sustained mode
    // (SampleRegion::crossfadeEnabled) — one-shot layers play to completion.
    bool    loopEnabled      = false;
    int64_t loopStart        = 0;
    int64_t loopEnd          = 0;        // 0 = end of sample
    int64_t crossfadeSamples = 0;        // FL-style loop crossfade width
    int     loopMode         = static_cast<int>(SampleLoopMode::Forward);

    // Release inside a loop finishes the CURRENT pass, then plays on to the end
    // of the trim region instead of looping forever. While that tail runs the
    // note holds its sustain level — the amplitude release only begins once
    // every layer has run out, which is the existing end-of-sample path.
    bool    exitLoopOnRelease = false;

    // ── MANGLE chain (per-note, per-slot warp FX) ─────────────────────────────
    // An ORDERED CHAIN of up to xleth::mangle::kMaxInstances warp units, each
    // instantiated PER STREAM — one per note per slot — so it runs before the
    // voices of a chord sum. That is what separates it from a mixer insert,
    // which only ever sees the already-summed chord. The output of instance N
    // feeds instance N+1, so order is audible.
    //
    // Empty by default, so every project made before MANGLE existed loads
    // bit-identical. A project saved before the chain existed carries the single
    // mangleMode / mangleAmount / mangleMix keys; SampleRegion's from_json
    // migrates them to a one-instance chain with identical sound (see there).
    std::vector<MangleInstance> mangleChain;

    // ── PREP (offline time-stretch / pitch-shift bake) ───────────────────────
    // Runs ONCE, off the audio thread, producing a new buffer that everything
    // downstream — trim, loop, fades, declick, and the waveform the editor
    // draws — then treats as the slot's sample. Live tuning (OCT/SEM/FINE/
    // COARSE) still happens at play time on top of the baked buffer.
    //
    // prepAlgorithm holds a StretchMethod value (1=PSOLA, 2=Rubber, 3=WSOLA,
    // 4=PhaseVocoder, 5=WORLD); it is stored as int for the same reason
    // CacheKey::stretchMethod is — the enum is declared further down this file.
    //
    // At stretch == 1.0 and shift == 0 cents the bake is BYPASSED outright:
    // no DSP, no copy, no cache entry. That is what keeps every project made
    // before PREP existed bit-identical, whatever prepAlgorithm happens to say.
    int   prepAlgorithm  = 2;            // StretchMethod::Rubber
    float prepStretch    = 1.0f;         // output length multiplier (1.0 = 100%)
    float prepShiftCents = 0.0f;         // pitch shift, cents

    // ── Precomputed (destructive) effects ────────────────────────────────────
    // Applied once to this slot's buffer copy at sampler-load time, BEFORE the
    // PREP bake — so they are part of the bake's input and therefore part of
    // its cache key (which digests the post-flag PCM).
    bool dcOffsetRemoved  = false;
    bool normalized       = false;
    bool polarityReversed = false;
    bool reversed         = false;

    // True when PREP would be a no-op. The single definition of the bypass
    // test — engine, cache and tests all ask this, so "unity is passthrough"
    // can never drift between them.
    bool prepIsBypassed() const {
        return std::abs(prepStretch - 1.0f) < 1e-6f
            && std::abs(prepShiftCents)     < 1e-6f;
    }

    // Total tuning offset in semitones (fine is cents). Pure function of the
    // four tuning controls — the single definition used by engine, tests and
    // the UI's mirrored math.
    double tuningSemitones() const {
        return static_cast<double>(octave) * 12.0
             + static_cast<double>(semitone)
             + static_cast<double>(coarse)
             + static_cast<double>(fine) / 100.0;
    }
};

// Hard ceiling on layers per sampler. Slot 0 always exists.
inline constexpr int MAX_SAMPLE_SLOTS = 8;

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

    bool hasSwappedAudio = false;

    // Probed duration (seconds) of the swapped audio file. 0 when no swap or when probe failed.
    // Used by UI to allow clip resize past the original video range when audio is longer.
    double swappedAudioDurationSec = 0.0;

    // ── Sampler settings (per-instrument; shared across all patterns that bind
    //    to this region). These describe how the sample is played back.
    //
    // The amplitude DAHDSR and the pitch envelope used to live here as flat
    // scalars; they now live in the modulation system — ENV 1 (envs[0]) is the
    // amp VCA and the pitch envelope is an ENV → SlotSem route. A project made
    // before this move carries the old keys in JSON; SampleRegion::from_json
    // migrates them into the modulation config at load (see SamplerLegacyMigration).

    // Crossfade / sustained mode. Sampler-level, NOT per-slot: it decides
    // whether a note releases on note-off at all, which is a property of the
    // note rather than of any one layer. Per-slot looping lives on SampleSlot.
    bool    crossfadeEnabled = false;    // false = one-shot (plays to completion)
                                         // true  = sustained (follows note duration)

    // ── Sample slots (layers) ────────────────────────────────────────────────
    // Invariant: always at least 1 entry, never more than MAX_SAMPLE_SLOTS.
    // slots[0] plays the region's own audio; slots[1..] carry their own files.
    // Root note, trim, loop, fades and the destructive flags all live here —
    // legacy projects load their single-sample state into slots[0], which is
    // why this phase's migration is lossless (see SampleRegion.cpp from_json).
    std::vector<SampleSlot> slots { SampleSlot{} };

    // Playback modes
    bool    monoEnabled       = false;
    bool    portamentoEnabled = false;
    float   portamentoTimeMs  = 100.0f;

    // ── Voicing ──────────────────────────────────────────────────────────────
    // voiceCount caps simultaneous NOTES. It is deliberately NOT the same limit
    // as the engine's 32-STREAM cap, and the two interact multiplicatively:
    // every note spawns one stream per SOUNDING slot, so
    //
    //     effective polyphony = min(voiceCount, MAX_STREAMS / soundingSlots)
    //
    // An 8-layer sampler therefore tops out at 4 simultaneous notes however
    // high voiceCount is set, while a single-layer sampler reaches the full 32.
    // Setting voiceCount above that ceiling is harmless rather than an error —
    // the stream budget simply releases the oldest NOTE first (never a lone
    // layer), which is the same click-free stealing rule that already governed
    // the 32-stream cap. Lowering voiceCount steals by the same path, so the
    // two limits never disagree about which note dies.
    int     voiceCount        = 32;     // 1..32 simultaneous notes (POLY)

    // MONO only. A legato note reuses the sounding voice WITHOUT restarting its
    // envelopes or its read heads — it only retunes. Without portamento that is
    // an instant retune; with it, the glide is the slide. Ignored in poly mode,
    // where every note is its own voice by definition.
    bool    legatoEnabled     = false;

    // ALWAYS (0) — the glide always takes portamentoTimeMs, whatever the
    //              interval. A semitone and two octaves take the same time.
    // SCALED (1) — portamentoTimeMs is the time PER OCTAVE, so the glide rate
    //              is constant and wide leaps take proportionally longer.
    int     portamentoMode    = 0;
    // Shapes the glide. 0 = linear (bit-identical to the pre-curve behaviour),
    // positive covers most of the interval early, negative late. Same tension
    // law as every envelope segment in the sampler.
    float   portamentoCurve   = 0.0f;   // -1..+1

    bool    arpEnabled        = false;
    bool    arpTempoSync      = true;
    int     arpDivision       = 8;       // musical division (4=quarter, 8=eighth, 16=16th)
    float   arpFreeTimeMs     = 125.0f;  // step time when tempoSync=false
    float   arpGate           = 0.8f;    // 0.0-1.0, note duration portion of step
    int     arpRange          = 1;       // octave range (1=stay, 2=+1 oct, etc.)
    int     arpDirection      = 0;       // 0=Up, 1=Down, 2=UpDown, 3=UpDownSticky

    // A 2-float breakpoint shape, shared with ClipModulation::Vibrato. The
    // sampler's three legacy drawable LFOs (Volume / Panning / Pitch) that used
    // it are gone — they are modulation routes now — but the type stays because
    // the clip Vibrato still draws its custom shape with it.
    struct LfoBreakpoint {
        float time  = 0.0f;   // 0..1 (position within one cycle)
        float value = 0.0f;   // -1..+1
    };

    // ── Modulation system (6 ENV + 6 LFO + VELO + NOTE + routes) ─────────────
    // The sampler's ONLY envelope/LFO system now. ENV 1 is the amplitude VCA;
    // the old pitch envelope and three drawable LFOs are ENV/LFO → route pairs.
    // A project written before this system existed loads with an empty route
    // list (an exact bypass) and its legacy scalars migrated in from raw JSON.
    xleth::sampmod::ModConfig modulation;

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

    // ── Swapped video (per-region, mirrors swappedAudioPath) ─────────────────
    // Set by video_swapRegionVideo: the region's VIDEO stream is rebound to this
    // file (copied into the project's swapped/ dir) while audioFilePath/
    // swappedAudioPath are left completely untouched. The replacement is run
    // through the normal proxy transcode path (see maybeEnqueueRegionProxy in
    // XlethEngineService.cpp) exactly like a freshly-imported source.
    // getDuration() (the clip's timeline duration) is NEVER changed by a swap —
    // if the replacement's own duration differs from getDuration() by more than
    // one frame, playback is clamped to the ORIGINAL duration and
    // swappedVideoDurationMismatch is set so the UI can warn the user.
    std::string swappedVideoPath;
    bool        hasSwappedVideo             = false;
    double      swappedVideoDurationSec     = 0.0;   // probed duration of the replacement file
    bool        swappedVideoDurationMismatch = false;
    int         swappedVideoWidth  = 0;   // probed dimensions of the replacement file
    int         swappedVideoHeight = 0;   // (proxy target size is derived from these, not src->width/height)

    double getDuration()  const { return endTime - startTime; }
    int    getFrameCount() const { return endFrame - startFrame + 1; }
    bool   isQuote()       const { return label == SampleLabel::Quote; }
    bool   hasSyllables()  const { return !syllables.empty(); }

    // ── Slot access ──────────────────────────────────────────────────────────
    // Repairs the "always at least one slot" invariant on read, so a region
    // deserialized from a malformed file can never hand out a dangling slot.
    int slotCount() const {
        return slots.empty() ? 1 : static_cast<int>(slots.size());
    }
    SampleSlot& slot(int index) {
        if (slots.empty()) slots.emplace_back();
        if (index < 0 || index >= static_cast<int>(slots.size())) index = 0;
        return slots[static_cast<size_t>(index)];
    }
    const SampleSlot& slot(int index) const {
        static const SampleSlot kFallback{};
        if (slots.empty()) return kFallback;
        if (index < 0 || index >= static_cast<int>(slots.size())) index = 0;
        return slots[static_cast<size_t>(index)];
    }
    // True when any slot is solo'd — the audio path then sounds ONLY solo'd
    // slots (and mute is ignored on them, matching mixer solo semantics).
    bool anySlotSolo() const {
        for (const auto& s : slots) if (s.solo) return true;
        return false;
    }
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
        ZoomPanRotation    = 4,
        ChromaKey          = 5,
        Outline            = 6,
        DropShadow         = 7
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
    // ChromaKey:          [0]=keyR [1]=keyG [2]=keyB   (key colour, linear 0..1)
    //                     [3]=tolerance      core threshold — CbCr distance fully keyed OUT below this
    //                     [4]=softness       edge threshold — fully keyed IN above this (must be > [3])
    //                     [5]=spill          spill suppression amount 0..1 (pulls surviving chroma off the key hue)
    //                     [6]=choke          matte erode radius, in OUTPUT pixels (see note)
    //                     [7]=edgeBlur       matte feather radius, in OUTPUT pixels (see note)
    //   ^ THIS IS THE CANONICAL ChromaKey PARAM LAYOUT. It is hand-duplicated in
    //     three other places that must be kept in sync — there is no registry:
    //       1. engine/src/render/shaders/FX_ChromaKey.hlsl  (cbuffer ChromaKeyConstants, b2)
    //       2. engine/src/render/GridCompositor.cpp         (processEffectChain switch + chromaKeyCB size)
    //       3. ui/src/components/grid/ChainableEffectParams.jsx (fx.type === 5 param panel)
    //     v1 NOTE on [6]/[7]: the radii are interpreted in OUTPUT pixels because
    //     GlobalConstants (b1) carries the output dimensions, not the cell
    //     dimensions, and plumbing cell dims through is out of scope for v1.
    //     A cell smaller than the full output therefore erodes/feathers by
    //     proportionally fewer of its own texels than the slider label implies.
    //
    // Outline:            [0]=colorR [1]=colorG [2]=colorB  (stroke colour, 0..1)
    //                     [3]=thickness      stroke width, in CELL pixels
    //                     [4]=softness       0..1 fraction of the thickness feathered
    //                                        (0 = hard edge, 1 = glow)
    //                     [5]=opacity        0..1
    //                     [6]=alphaThreshold 0..1 — alpha at or below this is background,
    //                                        so it is what the stroke traces around
    // DropShadow:         [0]=colorR [1]=colorG [2]=colorB  (shadow colour, 0..1)
    //                     [3]=distance       offset length, in CELL pixels
    //                     [4]=angle          degrees; 0 casts right and angles advance
    //                                        CLOCKWISE on screen (90 = straight down),
    //                                        so the classic down-right shadow is 45
    //                     [5]=size           0..1 inflate/spread — 0 keeps the silhouette's
    //                                        exact shape, 1 bulges it out by kMaxInflatePx
    //                     [6]=softness       0..1 feather — 0 is a hard-edged shape,
    //                                        1 feathers by kMaxBlurPx
    //                     [7]=opacity        0..1
    //                     [8]=blendMode      rounded to an int: 0=Normal 1=Multiply
    //                                        2=Darken 3=LinearBurn
    //                     [9]=alphaThreshold 0..1 — alpha at or below this casts no shadow
    //   ^ CANONICAL LAYOUTS for both. Hand-duplicated, no registry — keep in sync with:
    //       1. engine/src/render/shaders/FX_Outline.hlsl    (cbuffer OutlineConstants, b2)
    //          engine/src/render/shaders/FX_DropShadow.hlsl (cbuffer DropShadowConstants, b2)
    //       2. engine/src/render/GridCompositor.h   (Outline/DropShadowConstants structs)
    //          engine/src/render/GridCompositor.cpp (applyExpansionStage — NOT the
    //          processEffectChain switch; see below)
    //       3. ui/src/components/grid/ChainableEffectParams.jsx (fx.type 6 / 7 panels)
    //
    //   These two are LAYER STYLES, not pixel filters, and that makes them unlike
    //   every other entry above in three ways worth knowing before touching them:
    //     • They draw OUTSIDE the source's own bounds, so they run in a render
    //       target padded by the radius they need, and the cell's final composite
    //       rect is grown to match. Nothing else in the chain changes the rect.
    //     • They are TERMINAL: applied after the chain, the standalone ZPR pass,
    //       the ping-pong crossfade and companion FX, so the stroke traces — and
    //       the shadow is cast by — the finished cell. Moving them within the
    //       chain therefore does not change the result; when both are present the
    //       outline is applied first and the shadow is cast by the outlined shape.
    //     • Their spatial radii are in TRUE cell pixels, not the output pixels
    //       ChromaKey's choke/edgeBlur use, because the padded target's real
    //       dimensions are passed down in the constant buffer.
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

// ─── Mixer routing model ─────────────────────────────────────────────────────
// Source track owns its route. targetTrackId = -1 means Master (default).
// sends and sidechainRoutes are reserved for Prompt 4+ and are always empty
// in Prompt 2A. All three types are persisted additively (omitted when default).

struct TrackOutputRoute {
    int targetTrackId = -1;  // -1 = Master
};

// Reserved for Prompt 4+. Not wired to DSP in Prompt 2A.
struct TrackSend {
    std::string routeId;
    int   targetTrackId = -1;
    float gain          = 1.0f;
    float pan           = 0.0f;
    bool  preFader      = false;
    bool  enabled       = true;
};

// Silent key route. Reserved for Prompt 4+. Not wired to DSP in Prompt 2A.
struct SidechainRoute {
    std::string routeId;
    int         targetTrackId          = -1;
    std::string targetEffectInstanceId;
    float       gain                   = 1.0f;
    bool        preFader               = false;
    bool        enabled                = true;
};

// ─── TrackInfo ────────────────────────────────────────────────────────────────
// UI-only, one-level track-folder arrangement. Folders never participate in
// audio routing or rendering; flattening this layout yields the legacy visible
// TrackInfo::order consumed by the rest of the engine.

struct TrackFolder {
    int              id = 0;
    std::string      name;
    bool             collapsed = false;
    std::vector<int> trackIds;
};

struct TrackLayoutItem {
    enum class Kind { Track, Folder };
    Kind kind = Kind::Track;
    int  id = 0;
};

struct TrackLayout {
    std::vector<TrackLayoutItem> rootOrder;
    std::vector<TrackFolder>     folders;
};

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

    // Upper bound on how long videoHoldLastFrame may keep re-serving a held
    // frame, measured in BEATS after the end of the clip that produced it.
    // Tempo-relative by construction, so the hold scales with the project BPM.
    //
    // kHoldLastFrameThresholdUnlimited (-1) = hold indefinitely until the next
    // clip appears — the pre-threshold behavior, and the value old project
    // files load as, so existing projects are bit-identical.
    //
    // Any value >= 0 is finite: once (currentBeat - clipEndBeat) exceeds it the
    // cell is treated as a plain gap (fully invisible — no dim, no fade), i.e.
    // exactly what a hold-disabled track already does there. Only consulted
    // when videoHoldLastFrame is true.
    static constexpr double kHoldLastFrameThresholdUnlimited = -1.0;
    double videoHoldLastFrameThresholdBeats = kHoldLastFrameThresholdUnlimited;

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

    // ── Mixer output routing (Prompt 2A) ────────────────────────────────────
    // outputRoute.targetTrackId == -1 means Master (default, backward-compat).
    // sends and sidechainRoutes are reserved schema space; always empty in 2A.
    TrackOutputRoute            outputRoute;
    std::vector<TrackSend>      sends;
    std::vector<SidechainRoute> sidechainRoutes;
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

    // ── Reserved seam: snapshot-scoped procedural actions (future phase) ──────
    // Always empty in projects written today. A later snapshot/keyframe phase
    // will populate this with per-slot event actions (e.g. show/hide, opacity or
    // transform ramps) scoped to the owning snapshot's timeline. Stored as opaque
    // JSON so a future- or hand-authored file round-trips through this build
    // unchanged. NO engine code reads it yet, and it is NOT part of the
    // getGridLayout IPC DTO — it lives only in the persisted snapshot model.
    std::vector<nlohmann::json> eventActions;
};

// ─── FullscreenLayer ──────────────────────────────────────────────────────────
// One fullscreen video layer in the grid. Replaces the pre-v3 chorus + crash
// special cases.
//
// zOrder is the SINGLE, globally-comparable compositing key shared with
// GridSlot::zOrder. The render path (FrameCollector) sorts grid cells and
// fullscreen layers together by this one number, so a fullscreen layer whose
// zOrder sits between two grid cells' zOrders renders interleaved between them
// (its full-canvas quad occludes whatever was drawn before it and is occluded by
// whatever comes after). zOrder — NOT `placement` — is now the source of truth
// for draw order.
//
// `placement` is retained but demoted to a behavioral/semantic label only: it
// still drives (a) hold-through-gap behavior (BehindGrid layers persist their
// last frame through gaps when the track has videoHoldLastFrame; InFrontOfGrid
// layers are transient), and (b) the setFullscreenLayers auto-enable of
// videoHoldLastFrame for BehindGrid tracks. It no longer decides compositing
// order. Old project files (no per-layer zOrder) and the legacy bulk
// setFullscreenLayers bridge path derive zOrder from placement + array position
// via assignCanonicalFullscreenZOrders() so their rendering is unchanged.

enum class FullscreenLayerPlacement { BehindGrid, InFrontOfGrid };

struct FullscreenLayer {
    int                      trackId   = -1;
    FullscreenLayerPlacement placement = FullscreenLayerPlacement::BehindGrid;
    float                    opacity   = 1.0f;
    int                      zOrder    = 0;   // global compositing key (see GridSlot::zOrder)

    // ── Reserved seam: snapshot-scoped procedural actions (future phase) ──────
    // Mirror of GridSlot::eventActions for fullscreen layers. Always empty today;
    // persisted verbatim as opaque JSON for forward compatibility; unread by the
    // engine and absent from the getGridLayout IPC DTO.
    std::vector<nlohmann::json> eventActions;
};

// ─── GridLayout ───────────────────────────────────────────────────────────────
// Project-level video grid configuration. Each track can be assigned to one
// slot in the N×M grid. Any number of fullscreen layers can be stacked behind
// or in front of the grid via fullscreenLayers.
//
// This flat struct is the composed *working view* the engine operates on at
// runtime and the exact shape exchanged over IPC (getGridLayout/setGridLayout).
// It is the union of two things the persisted model keeps separate:
//   • the GLOBAL project canvas + previewFps (canvasWidth/Height/aspectRatio,
//     previewFps) — project-wide, one per file; and
//   • the ACTIVE snapshot's arrangement (columns/rows/gapScale/slots/
//     fullscreenLayers) — see GridSnapshot below.
// On disk the arrangement is nested inside a snapshot container (Timeline::toJSON
// / fromJSON); at runtime it is flattened back into this struct so the render
// path, commands, and bridge are unaffected by the snapshot model. Keeping this
// shape stable is what makes the snapshot phase invisible to callers.

struct GridLayout {
    int   columns       = 3;       // N (1-8)
    int   rows          = 3;       // M (1-8)
    std::vector<GridSlot> slots;
    std::vector<FullscreenLayer> fullscreenLayers;
    int   previewFps    = 30;      // 1-120 — this IS the project frame rate (export + preview default)

    // ── Project video canvas ─────────────────────────────────────────────────
    // Base output resolution + aspect for the project. The export dialog defaults
    // to these (Custom may override); the offline renderer treats canvasWidth ×
    // canvasHeight as the authoring aspect when fitting into an export resolution
    // that differs (crop / stretch / letterbox). aspectRatio is a UI hint
    // ("16:9", "9:16", "4:3", "1:1", "21:9", or "custom") and is not used by the
    // renderer — width/height are authoritative. Added after kProjectFileVersion
    // 3; older projects without these fields default to 1920×1080 / "16:9".
    int         canvasWidth       = 1920;   // 16 .. 7680 (even)
    int         canvasHeight      = 1080;   // 16 .. 4320 (even)
    std::string canvasAspectRatio = "16:9";

    float gapScale      = 0.0f;   // 0.0–0.5
};

// ─── GridSnapshot ─────────────────────────────────────────────────────────────
// A named arrangement of the video grid: the geometry (columns/rows/gapScale)
// plus the placement of every track (slots + fullscreenLayers). This is the unit
// a future phase will let users switch between over time (via GridLayoutContainer
// cues) and keyframe (via each slot/layer's reserved eventActions).
//
// The GLOBAL project canvas (canvasWidth/Height/aspectRatio) and previewFps do
// NOT live here — those are project-wide and stay on the container (persisted
// alongside the snapshot list; at runtime they occupy the matching GridLayout
// fields). A snapshot owns ONLY the arrangement + grid geometry.
//
// Runtime status: Timeline owns N live snapshots and materializes the active one
// into the flat GridLayout cache. makeGridSnapshot() /
// applyGridSnapshot() convert between the two. Because the engine keeps operating
// on the flat GridLayout (the active snapshot) at runtime, no render/bridge/
// command code changed; only the model + serialization gained the wrapper.
struct GridSnapshot {
    std::string id;                 // stable within a project file; see generateSnapshotId
    std::string name = "Base";
    int   columns  = 3;
    int   rows     = 3;
    float gapScale = 0.0f;
    std::vector<GridSlot>        slots;
    std::vector<FullscreenLayer> fullscreenLayers;
};

// ─── SnapshotTransition ───────────────────────────────────────────────────────
// Optional animated transition that plays as the show crosses a snapshot
// boundary (a GridCue). By DESIGN the transition is owned by the GridCue, not by
// a GridSnapshot: a snapshot is reused across many cues, so the cue — the actual
// boundary/pin — is the only place a transition can unambiguously live. The UI
// still presents it as the incoming snapshot's "in" transition (PowerPoint-style).
//
// Geometry model (see snapshot-transition-system-spec.md §2):
//   • The cue's tick is the PIN — the fixed anchor on the beat, the 50% blend
//     point. Editing a transition never moves the pin.
//   • startOffsetTicks / endOffsetTicks are the only draggable handles: the Start
//     handle sits `startOffsetTicks` BEFORE the pin, the End handle sits
//     `endOffsetTicks` AFTER it. Both are >= 0 and may be ASYMMETRIC. The window
//     is [pin - startOffsetTicks, pin + endOffsetTicks].
//   • enabled == false — or a zero-length window (both offsets 0) — is a HARD CUT
//     and is the default. Transitions are strictly opt-in.
//
// Offsets are stored in TICKS (snap-native, tempo-stable), NOT samples; the
// render path converts tick->sample via RenderClock::ppqToSample only at
// resolve time (Slice 3). This struct carries no sample-domain state.
struct SnapshotTransitionEasingCurve {
    float x1 = 0.0f;
    float y1 = 0.0f;
    float x2 = 1.0f;
    float y2 = 1.0f;

    void normalize() noexcept {
        if (!std::isfinite(x1) || !std::isfinite(y1)
            || !std::isfinite(x2) || !std::isfinite(y2)) {
            *this = {};
            return;
        }
        x1 = std::clamp(x1, 0.0f, 1.0f);
        y1 = std::clamp(y1, 0.0f, 1.0f);
        x2 = std::clamp(x2, 0.0f, 1.0f);
        y2 = std::clamp(y2, 0.0f, 1.0f);
    }

    bool isLinear() const noexcept {
        return x1 == 0.0f && y1 == 0.0f && x2 == 1.0f && y2 == 1.0f;
    }
};

struct SnapshotTransition {
    static constexpr float kDefaultEdgeSoftness = 0.0f;
    static constexpr float kMaxEdgeSoftness = 0.10f;
    static constexpr float kDefaultZoomAmount = 0.12f;
    static constexpr float kMaxZoomAmount = 0.30f;
    static constexpr int   kDefaultDissolveGrainPx = 1;
    static constexpr int   kMaxDissolveGrainPx = 8;
    static constexpr float kDefaultRadialOriginX = 0.5f;
    static constexpr float kDefaultRadialOriginY = 0.5f;
    static constexpr int   kDefaultPixelateMaxBlockPx = 32;
    static constexpr int   kMaxPixelateMaxBlockPx = 128;
    static constexpr float kDefaultGlitchIntensity = 0.65f;
    static constexpr int   kDefaultGlitchBlockPx = 24;
    static constexpr int   kMaxGlitchBlockPx = 128;
    static constexpr float kDefaultBlurRadiusPx = 16.0f;
    static constexpr float kMaxBlurRadiusPx = 48.0f;
    static constexpr float kDefaultDisplacementAmount = 0.06f;
    static constexpr float kMaxDisplacementAmount = 0.20f;
    static constexpr float kDefaultDisplacementScale = 6.0f;
    static constexpr float kMaxDisplacementScale = 24.0f;
    static constexpr int   kDefaultEffectSeed = 0;
    static constexpr int   kMaxEffectSeed = 65535;

    bool     enabled          = false;  // false = hard cut (also true when both offsets == 0)
    int64_t  startOffsetTicks = 0;      // Start handle distance BEFORE the pin (>= 0)
    int64_t  endOffsetTicks   = 0;      // End handle distance AFTER  the pin (>= 0)
    enum class Type {
        Crossfade, LineSweep, Push, Slide, Zoom, Dissolve, OutThenIn,
        RadialReveal, Pixelate, Glitch, BlurThrough, Displacement
    }
             type = Type::Crossfade;
    float    geomAngleDeg     = 0.0f;   // incoming direction: 0=left, 90=top, 180=right, 270=bottom
    float    edgeSoftness     = kDefaultEdgeSoftness;
    float    zoomAmount       = kDefaultZoomAmount;
    int      dissolveGrainPx  = kDefaultDissolveGrainPx;
    float    radialOriginX    = kDefaultRadialOriginX;
    float    radialOriginY    = kDefaultRadialOriginY;
    int      pixelateMaxBlockPx = kDefaultPixelateMaxBlockPx;
    float    glitchIntensity  = kDefaultGlitchIntensity;
    int      glitchBlockPx    = kDefaultGlitchBlockPx;
    float    blurRadiusPx     = kDefaultBlurRadiusPx;
    float    displacementAmount = kDefaultDisplacementAmount;
    float    displacementScale  = kDefaultDisplacementScale;
    int      effectSeed       = kDefaultEffectSeed;
    // Independent CSS-style cubic Bezier curves for each side of the fixed pin.
    // Both use P0=(0,0), P3=(1,1); these fields store editable P1/P2.
    SnapshotTransitionEasingCurve startToPinEasing{};
    SnapshotTransitionEasingCurve pinToEndEasing{};

    void normalize() noexcept {
        startOffsetTicks = std::max<int64_t>(0, startOffsetTicks);
        endOffsetTicks   = std::max<int64_t>(0, endOffsetTicks);

        if (!std::isfinite(geomAngleDeg)) {
            geomAngleDeg = 0.0f;
        } else {
            geomAngleDeg = std::fmod(geomAngleDeg, 360.0f);
            if (geomAngleDeg < 0.0f) geomAngleDeg += 360.0f;
        }
        if (!std::isfinite(edgeSoftness)) edgeSoftness = kDefaultEdgeSoftness;
        if (!std::isfinite(zoomAmount)) zoomAmount = kDefaultZoomAmount;
        if (!std::isfinite(radialOriginX)) radialOriginX = kDefaultRadialOriginX;
        if (!std::isfinite(radialOriginY)) radialOriginY = kDefaultRadialOriginY;
        if (!std::isfinite(glitchIntensity)) glitchIntensity = kDefaultGlitchIntensity;
        if (!std::isfinite(blurRadiusPx)) blurRadiusPx = kDefaultBlurRadiusPx;
        if (!std::isfinite(displacementAmount)) displacementAmount = kDefaultDisplacementAmount;
        if (!std::isfinite(displacementScale)) displacementScale = kDefaultDisplacementScale;
        edgeSoftness = std::clamp(edgeSoftness, 0.0f, kMaxEdgeSoftness);
        zoomAmount = std::clamp(zoomAmount, 0.0f, kMaxZoomAmount);
        dissolveGrainPx = std::clamp(dissolveGrainPx, 1, kMaxDissolveGrainPx);
        radialOriginX = std::clamp(radialOriginX, 0.0f, 1.0f);
        radialOriginY = std::clamp(radialOriginY, 0.0f, 1.0f);
        pixelateMaxBlockPx = std::clamp(pixelateMaxBlockPx, 1, kMaxPixelateMaxBlockPx);
        glitchIntensity = std::clamp(glitchIntensity, 0.0f, 1.0f);
        glitchBlockPx = std::clamp(glitchBlockPx, 4, kMaxGlitchBlockPx);
        blurRadiusPx = std::clamp(blurRadiusPx, 0.0f, kMaxBlurRadiusPx);
        displacementAmount = std::clamp(displacementAmount, 0.0f, kMaxDisplacementAmount);
        displacementScale = std::clamp(displacementScale, 1.0f, kMaxDisplacementScale);
        effectSeed = std::clamp(effectSeed, 0, kMaxEffectSeed);
        startToPinEasing.normalize();
        pinToEndEasing.normalize();
    }
};

inline std::string snapshotTransitionTypeToString(SnapshotTransition::Type t) {
    switch (t) {
        case SnapshotTransition::Type::Crossfade: return "crossfade";
        case SnapshotTransition::Type::LineSweep: return "lineSweep";
        case SnapshotTransition::Type::Push:      return "push";
        case SnapshotTransition::Type::Slide:     return "slide";
        case SnapshotTransition::Type::Zoom:      return "zoom";
        case SnapshotTransition::Type::Dissolve:  return "dissolve";
        case SnapshotTransition::Type::OutThenIn: return "outThenIn";
        case SnapshotTransition::Type::RadialReveal: return "radialReveal";
        case SnapshotTransition::Type::Pixelate:     return "pixelate";
        case SnapshotTransition::Type::Glitch:       return "glitch";
        case SnapshotTransition::Type::BlurThrough:  return "blurThrough";
        case SnapshotTransition::Type::Displacement: return "displacement";
        default:                                  return "crossfade";
    }
}

inline SnapshotTransition::Type stringToSnapshotTransitionType(const std::string& s) {
    if (s == "lineSweep") return SnapshotTransition::Type::LineSweep;
    if (s == "push")      return SnapshotTransition::Type::Push;
    if (s == "slide")     return SnapshotTransition::Type::Slide;
    if (s == "zoom")      return SnapshotTransition::Type::Zoom;
    if (s == "dissolve")  return SnapshotTransition::Type::Dissolve;
    if (s == "outThenIn") return SnapshotTransition::Type::OutThenIn;
    if (s == "radialReveal") return SnapshotTransition::Type::RadialReveal;
    if (s == "pixelate")     return SnapshotTransition::Type::Pixelate;
    if (s == "glitch")       return SnapshotTransition::Type::Glitch;
    if (s == "blurThrough")  return SnapshotTransition::Type::BlurThrough;
    if (s == "displacement") return SnapshotTransition::Type::Displacement;
    return SnapshotTransition::Type::Crossfade;
}

// ─── GridCue ──────────────────────────────────────────────────────────────────
// One entry in the project's time-based snapshot automation. It binds an
// absolute project tick to a snapshot: at render time the grid arrangement in
// effect at tick `t` is the snapshot named by the LAST cue whose `tick` <= t
// (see Timeline::gridLayoutAt); before the first cue the project's default
// ("Base") snapshot applies.
//
// Cues are kept sorted ascending by tick and are consulted ONLY by the render /
// export path (FrameCollector), never by the editing path — so the arrangement
// being edited (the active snapshot) and the arrangement being rendered at a
// given tick can legitimately differ. A cue whose target snapshot has been
// deleted is skipped by the resolver (treated as absent) rather than crashing;
// Timeline::deleteGridSnapshot also prunes referencing cues eagerly.
//
// A cue optionally carries a `transition` describing how the boundary AT this
// cue animates (the cue tick is the transition pin). A default-constructed
// (disabled) transition means the boundary hard-cuts, exactly as before.
struct GridCue {
    TickTime           tick;         // absolute project tick where snapshotId takes effect
    std::string        snapshotId;   // -> GridSnapshot::id
    SnapshotTransition transition{}; // boundary animation; disabled default = hard cut
};

// ─── GridLayoutContainer (persisted shape, documented for reference) ──────────
// The on-disk `gridLayout` object is a snapshot container, NOT the flat
// GridLayout. Its schema (see Timeline::toJSON) is:
//
//   { canvasWidth, canvasHeight, canvasAspectRatio, previewFps,   // GLOBAL
//     activeSnapshotId,                                           // -> snapshots[].id
//     defaultSnapshotId,                                          // -> Base snapshot
//     snapshots: [ GridSnapshot, ... ],                           // >=1 ("Base")
//     cues: [ GridCue, ... ] }                                    // time automation
//
// Each cue is { tick, snapshotId } and MAY carry an additive `transition` object
// { enabled, startOffsetTicks, endOffsetTicks, type, geomAngleDeg,
//   edgeSoftness, zoomAmount, dissolveGrainPx, radialOriginX, radialOriginY,
//   pixelateMaxBlockPx, glitchIntensity, glitchBlockPx, blurRadiusPx,
//   displacementAmount, displacementScale, effectSeed,
//   easing: { startToPin: {x1,y1,x2,y2}, pinToEnd: {x1,y1,x2,y2} } }
// describing the boundary animation at that cue. The transition object is written
// ONLY when enabled (omitted entirely for a hard cut) and defaults to a hard cut
// when absent, so projects saved before transitions existed load unchanged.
//
// A dedicated container struct is intentionally unnecessary: Timeline owns the
// std::vector<GridSnapshot>, active + default identity, global flat cache, and
// the typed cue list.

// Generate a fresh snapshot id ("snap-XXXXXXXX", 8 hex). Ids only need to be
// unique within one project file (activeSnapshotId references one of them), so a
// random suffix mixed with a process-local counter is sufficient — no external
// UUID dependency. Never throws.
inline std::string generateSnapshotId() {
    static std::atomic<uint64_t> seq{1};
    std::random_device rd;
    const uint64_t mixed =
        (static_cast<uint64_t>(rd()) << 32)
        ^ (seq.fetch_add(1, std::memory_order_relaxed) * 0x9E3779B97F4A7C15ull);
    const uint32_t folded = static_cast<uint32_t>(mixed ^ (mixed >> 32));
    char buf[16];
    std::snprintf(buf, sizeof(buf), "snap-%08x", folded);
    return std::string(buf);
}

// Copy a flat GridLayout's arrangement + geometry into a named snapshot. The
// global canvas/previewFps fields are deliberately ignored (they live on the
// container). Used by serialization to nest the active layout.
inline GridSnapshot makeGridSnapshot(const GridLayout& flat,
                                     std::string id, std::string name) {
    GridSnapshot snap;
    snap.id               = std::move(id);
    snap.name             = std::move(name);
    snap.columns          = flat.columns;
    snap.rows             = flat.rows;
    snap.gapScale         = flat.gapScale;
    snap.slots            = flat.slots;
    snap.fullscreenLayers = flat.fullscreenLayers;
    return snap;
}

// Project a snapshot's arrangement back onto a flat GridLayout, leaving the
// container's global fields (canvas*, previewFps) untouched. Used on load to
// flatten the active snapshot into the runtime layout the engine operates on.
inline void applyGridSnapshot(GridLayout& flat, const GridSnapshot& snap) {
    flat.columns          = snap.columns;
    flat.rows             = snap.rows;
    flat.gapScale         = snap.gapScale;
    flat.slots            = snap.slots;
    flat.fullscreenLayers = snap.fullscreenLayers;
}

// ─── assignCanonicalFullscreenZOrders ─────────────────────────────────────────
// Assign globally-comparable compositing zOrders to fullscreen layers purely
// from their placement + array position, relative to the current grid slots.
// This reproduces the legacy fixed "behind < grid < front" banding EXACTLY:
//   • BehindGrid layers get values strictly below the minimum grid-slot zOrder,
//     with array index 0 = most-negative = furthest back.
//   • InFrontOfGrid layers get values strictly above the maximum grid-slot
//     zOrder, preserving array order (index 0 = bottom of the front stack).
// When there are no grid slots the grid min/max default to 0.
//
// Used in exactly two places, both of which have ONLY placement + array order as
// their ordering signal (no per-layer zOrder yet):
//   1. Project-load migration for old files whose fullscreenLayers carry no
//      zOrder — guarantees loading an old project renders pixel-identically.
//   2. The legacy bulk setFullscreenLayers bridge path (the current UI has no
//      per-layer zOrder concept). The future UI phase will pass explicit zOrders
//      and bypass this canonicalization to enable true interleaving.
// trackId / placement / opacity are untouched.
inline void assignCanonicalFullscreenZOrders(std::vector<FullscreenLayer>& layers,
                                             const std::vector<GridSlot>& slots) {
    int  gridMin = 0, gridMax = 0;
    bool hasSlot = false;
    for (const auto& s : slots) {
        if (!hasSlot) { gridMin = gridMax = s.zOrder; hasSlot = true; }
        else          { gridMin = std::min(gridMin, s.zOrder);
                        gridMax = std::max(gridMax, s.zOrder); }
    }
    int behindCount = 0;
    for (const auto& fl : layers)
        if (fl.placement == FullscreenLayerPlacement::BehindGrid) ++behindCount;

    int iBehind = 0, iFront = 0;
    for (auto& fl : layers) {
        if (fl.placement == FullscreenLayerPlacement::BehindGrid) {
            // [gridMin - behindCount, gridMin - 1], increasing with array index:
            // index 0 lands most-negative (furthest back).
            fl.zOrder = gridMin - behindCount + iBehind;
            ++iBehind;
        } else {
            // [gridMax + 1, gridMax + frontCount], increasing with array index.
            fl.zOrder = gridMax + 1 + iFront;
            ++iFront;
        }
    }
}

// Clamp a project canvas dimension to the supported encoder range and force it
// even (H.264/H.265 require even dimensions). Shared by the model loader and the
// bridge so JS and persisted values normalize identically.
inline int normalizeCanvasDim(int v, int lo, int hi) {
    if (v < lo) v = lo;
    if (v > hi) v = hi;
    if (v & 1)  v -= 1;           // force even
    return v;
}
constexpr int kCanvasMinWidth  = 16;
constexpr int kCanvasMaxWidth  = 7680;
constexpr int kCanvasMinHeight = 16;
constexpr int kCanvasMaxHeight = 4320;

// ─── LoopRegion ───────────────────────────────────────────────────────────────
// Single global project loop / render region (one per project). Phase 1 uses it
// ONLY for live in-app playback looping (the audio-clock playback trap). The
// renderOrigin / tailMode / tailThresholdDb / tailMaxSeconds fields are inert
// model fields reserved for later phases (render scoping / tail folding); they
// are persisted so projects round-trip, but no engine code reads them yet.
//
// renderScoped is intentionally NOT stored anywhere: it is derived as
// (renderScoped == loopEnabled) and computed at read time only — see
// Timeline::isRenderScoped(). Do not add a second persisted flag.
//
// Invariants (enforced in the mutation layer — Timeline::setLoopRegion, via
// normalizeLoopRegion): startTick >= 0 and endTick > startTick, with endTick at
// least minLengthTicks beyond startTick (1 snap unit when snap is on, 1 tick
// when snap is off — the caller supplies the snap unit).
struct LoopRegion {
    enum class RenderOrigin { Absolute, Normalized };
    enum class TailMode { HardCut, TailClamp, Wrap };

    int64_t      startTick       = 0;
    int64_t      endTick         = 4 * 4 * 960;  // 4 bars (16 beats) @ 960 PPQ — sane visible default
    bool         loopEnabled     = false;
    RenderOrigin renderOrigin    = RenderOrigin::Absolute;
    TailMode     tailMode        = TailMode::TailClamp;
    double       tailThresholdDb = -60.0;
    double       tailMaxSeconds  = 10.0;
};

inline std::string loopRenderOriginToString(LoopRegion::RenderOrigin o) {
    return o == LoopRegion::RenderOrigin::Normalized ? "normalized" : "absolute";
}
inline LoopRegion::RenderOrigin stringToLoopRenderOrigin(const std::string& s) {
    return s == "normalized" ? LoopRegion::RenderOrigin::Normalized
                             : LoopRegion::RenderOrigin::Absolute;
}

inline std::string loopTailModeToString(LoopRegion::TailMode m) {
    switch (m) {
        case LoopRegion::TailMode::HardCut:   return "hardCut";
        case LoopRegion::TailMode::Wrap:      return "wrap";
        case LoopRegion::TailMode::TailClamp: return "tailClamp";
        default:                              return "tailClamp";
    }
}
inline LoopRegion::TailMode stringToLoopTailMode(const std::string& s) {
    if (s == "hardCut") return LoopRegion::TailMode::HardCut;
    if (s == "wrap")    return LoopRegion::TailMode::Wrap;
    return LoopRegion::TailMode::TailClamp;
}

// ── Tail-field sanitizers (Phase 3A) ──────────────────────────────────────────
// Pure value clamps applied at the mutation/model boundary so bad UI/IPC input
// can never be stored. Kept free-standing so they are unit-testable and reusable
// by the render-scope tail-plan derivation.
//
//   tailThresholdDb : finite dBFS, clamped to [-160, 0]. Non-finite → -60 dB.
//   tailMaxSeconds  : finite, non-negative, capped to kLoopTailMaxSecondsCap.
constexpr double kLoopTailMaxSecondsCap = 120.0;   // sane upper bound for a tail

inline double sanitizeTailThresholdDb(double db) {
    if (!std::isfinite(db)) return -60.0;
    if (db > 0.0)    return 0.0;       // 0 dBFS ceiling
    if (db < -160.0) return -160.0;    // practical silence floor
    return db;
}

inline double sanitizeTailMaxSeconds(double s) {
    if (!std::isfinite(s)) return 10.0;
    if (s < 0.0) return 0.0;
    if (s > kLoopTailMaxSecondsCap) return kLoopTailMaxSecondsCap;
    return s;
}

// Mutation-layer invariant enforcement. Pure / no side effects so it is unit
// testable. Clamps startTick to >= 0 and forces endTick to be at least
// max(1, minLengthTicks) beyond startTick so zero/negative length can never be
// stored. renderOrigin / tailMode are enums (always valid; the string decoders
// fall back). The tail dB / seconds fields are clamped to sane finite ranges.
inline LoopRegion normalizeLoopRegion(LoopRegion r, int64_t minLengthTicks) {
    if (r.startTick < 0) r.startTick = 0;
    int64_t minLen = minLengthTicks < 1 ? 1 : minLengthTicks;
    if (r.endTick - r.startTick < minLen)
        r.endTick = r.startTick + minLen;
    r.tailThresholdDb = sanitizeTailThresholdDb(r.tailThresholdDb);
    r.tailMaxSeconds  = sanitizeTailMaxSeconds(r.tailMaxSeconds);
    return r;
}
