#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include "Arpeggiator.h"
#include "../model/TimelineTypes.h"

#include <array>
#include <cstdint>
#include <cstdio>
#include <vector>

// ─── Sampler ─────────────────────────────────────────────────────────────────
// Polyphonic pitched sample player with ADSR envelope and optional loop.
// NOT a JUCE AudioProcessor — plain C++ class, similar to MixEngine.
// One instance per Pattern: MixEngine owns samplers_[patternId] map.
//
// Audio-thread rules:
//   - processBlock / noteOn / noteOff: NO alloc, NO locks, NO logging
//   - setters (setADSR, setLoopPoints, setRootNote, setCrossfadeMode, loadSample)
//     are MAIN THREAD ONLY; call allNotesOff() first to avoid glitches.

class Sampler
{
public:
    Sampler() = default;

    // ── Main-thread configuration ────────────────────────────────────────────
    void loadSample(const juce::AudioBuffer<float>& audioData,
                    double sourceSampleRate, int rootNote);

    void setADSR(float attackMs, float decayMs, float sustain, float releaseMs);
    void setEnvelope(float delayMs, float attackMs, float holdMs,
                     float decayMs, float sustain, float releaseMs,
                     float attackTension, float decayTension, float releaseTension);
    void setPitchEnvelope(float delayMs, float attackMs, float holdMs,
                          float decayMs, float sustain, float releaseMs,
                          float attackTension, float decayTension, float releaseTension);
    void setPitchEnvEnabled(bool enabled);
    void setPitchEnvAmount(float semitones);
    void setLoopPoints(bool enabled, int64_t loopStart, int64_t loopEnd);
    void setCrossfadeMode(bool enabled);   // false = one-shot, true = sustained
    void setRootNote(int note);

    // ── Sample trim + declicking ─────────────────────────────────────────────
    void setSmpStart(int64_t start);          // playback start offset (source samples)
    void setSmpLength(int64_t length);        // 0 = full remaining from smpStart
    void setDeclickSamples(int samples);      // Hann fade width at trim edges (default 64)
    void setFadeIn(float ms);                 // linear fade-in duration (user-controlled)
    void setFadeOut(float ms);                // linear fade-out duration (user-controlled)
    void setCrossfadeSamples(int64_t samples);// FL-style loop crossfade width (0 = off)

    // ── Playback modes ──────────────────────────────────────────────────────
    void setMonoMode(bool enabled);
    void setPortamento(bool enabled, float timeMs);
    void setArpeggiator(bool enabled, bool tempoSync, int division,
                        float freeTimeMs, float gate, int range, int direction);
    void setBPM(double bpm);

    // ── LFO configuration ───────────────────────────────────────────────────
    void setLfoVol(bool enabled, float amount, float speedHz, bool tempoSync,
                   int tempoDivision, float attackMs, float delayMs,
                   const std::vector<SampleRegion::LfoBreakpoint>& waveform);
    void setLfoPan(bool enabled, float amount, float speedHz, bool tempoSync,
                   int tempoDivision, float attackMs, float delayMs,
                   const std::vector<SampleRegion::LfoBreakpoint>& waveform);
    void setLfoPitch(bool enabled, float amount, float speedHz, bool tempoSync,
                     int tempoDivision, float attackMs, float delayMs,
                     const std::vector<SampleRegion::LfoBreakpoint>& waveform);

    bool hasSample() const { return sampleData_.getNumSamples() > 0; }
    void allNotesOff();

    // ── Voice-identity plumbing (audio-thread-safe scalar stores) ────────────
    // MixEngine calls setCurrentSample(bufStart) once per buffer before
    // triggerPatternNotes so fireNoteOn can record absolute spawn positions.
    // INVARIANT: absSample MUST be the BUFFER-START absolute sample (bufStart),
    // not bufEnd or any per-sample running counter — spawnAbsSample is computed
    // as (currentAbsSample_ + sampleOffset) where sampleOffset is BUFFER-RELATIVE.
    void setCurrentSample(int64_t absSample) noexcept { currentAbsSample_ = absSample; }
#ifdef XLETH_DEBUG
    void     setTelemetryLog(FILE* f) noexcept { telemetryLog_ = f; }
    void     setDebugKey(int trackId, int regionId) noexcept { debugTrackId_ = trackId; debugRegionId_ = regionId; }
    uint64_t orphanCandidatesEver() const noexcept { return orphanCandidatesEver_; }
    int64_t  debugCurrentAbsSample() const noexcept { return currentAbsSample_; }
    void     debugSnapshotActiveVoices(FILE* out, const char* reason,
                                        int trackId, int regionId) const noexcept;
#endif

    // ── Audio-thread triggering ──────────────────────────────────────────────
    void noteOn(int midiNote, float velocity, int sampleOffset = 0);
    void noteOff(int midiNote, int sampleOffset = 0, bool force = false);

    // Additive render into outputBuffer (stereo assumed). Caller clears if needed.
    void processBlock(juce::AudioBuffer<float>& outputBuffer,
                      int numSamples, double engineSampleRate);

    // ── Introspection (main-thread) ──────────────────────────────────────────
    int  activeVoiceCount() const;
    int  countActiveVoices() const;      // audio-thread-safe read-only scan; same as activeVoiceCount
    int  countHeldVoices() const;        // voices where active && noteHeld
    int  countReleasingVoices() const;   // voices where active && !noteHeld

private:
    juce::AudioBuffer<float> sampleData_;
    double sourceSampleRate_ = 48000.0;
    int    rootNote_         = 60;

    float   delayMs_        = 0.0f;
    float   attackMs_       = 0.0f;
    float   holdMs_         = 0.0f;
    float   decayMs_        = 0.0f;
    float   sustain_        = 1.0f;
    float   releaseMs_      = 50.0f;
    float   attackTension_  = 0.0f;   // -1..+1 (0 = linear)
    float   decayTension_   = 0.0f;
    float   releaseTension_ = 0.0f;

    // Pitch envelope (modulates playback rate)
    float   pitchEnvDelayMs_        = 0.0f;
    float   pitchEnvAttackMs_       = 0.0f;
    float   pitchEnvHoldMs_         = 0.0f;
    float   pitchEnvDecayMs_        = 0.0f;
    float   pitchEnvSustain_        = 0.0f;  // 0.0 = no pitch mod at sustain
    float   pitchEnvReleaseMs_      = 0.0f;
    float   pitchEnvAttackTension_  = 0.0f;
    float   pitchEnvDecayTension_   = 0.0f;
    float   pitchEnvReleaseTension_ = 0.0f;
    float   pitchEnvAmount_         = 0.0f;  // semitones, -48..+48
    bool    pitchEnvEnabled_        = false;

    bool    loopEnabled_ = false;
    int64_t loopStart_   = 0;
    int64_t loopEnd_     = 0;

    bool    crossfadeEnabled_ = false;     // one-shot vs sustained

    int64_t smpStart_       = 0;           // trim start (source samples)
    int64_t smpLength_      = 0;           // trim length; 0 = full from smpStart_
    int     declickSamples_ = 64;          // Hann fade width at trim edges
    float   fadeInMs_       = 0.0f;        // linear fade-in duration (ms)
    float   fadeOutMs_      = 0.0f;        // linear fade-out duration (ms)
    int64_t crossfadeSamples_ = 0;         // FL-style loop crossfade width (source samples)

    // Playback modes
    bool    monoEnabled_        = false;
    bool    portamentoEnabled_  = false;
    float   portamentoTimeMs_   = 100.0f;
    int     lastNotePitch_      = -1;      // for poly+porta (start from last note)
    double  bpm_                = 140.0;
    Arpeggiator arp_;

    // Mono held-note stack (most recent at back, max 16)
    std::vector<int> monoHeldNotes_;

    // ── LFO configuration (one per target) ──────────────────────────────────
    struct LfoConfig {
        bool  enabled       = false;
        float amount        = 0.0f;
        float speedHz       = 1.0f;
        bool  tempoSync     = false;
        int   tempoDivision = 4;
        float attackMs      = 0.0f;
        float delayMs       = 0.0f;
        std::vector<SampleRegion::LfoBreakpoint> waveform;
    };
    LfoConfig lfoVolConfig_;
    LfoConfig lfoPanConfig_;
    LfoConfig lfoPitchConfig_;

    struct Voice
    {
        bool   active       = false;
        int    midiNote     = 60;
        float  velocity     = 1.0f;
        double playPosition = 0.0;         // fractional sample index (source samples)
        double pitchRatio   = 1.0;         // 2^((midiNote - rootNote) / 12)

        // Portamento state
        double currentPitchF       = 60.0; // fractional MIDI note (smoothed)
        int    targetPitch         = -1;   // glide target (-1 = no glide)
        double portamentoRemaining = 0.0;  // samples left in glide

        enum class EnvStage { Delay, Attack, Hold, Decay, Sustain, Release, Off };
        EnvStage envStage         = EnvStage::Off;
        float    envLevel         = 0.0f;
        float    releaseStartLevel = 0.0f; // envLevel captured at moment Release began
        double   envPosition      = 0.0;   // samples elapsed in current stage
        bool     noteHeld         = false;

        // Pitch envelope (same stage machine)
        EnvStage pitchEnvStage             = EnvStage::Off;
        float    pitchEnvLevel             = 0.0f;
        float    pitchEnvReleaseStartLevel = 0.0f;
        double   pitchEnvPosition          = 0.0;

        // LFO per-voice state (one per target)
        struct LfoState {
            double phase          = 0.0;
            double delayRemaining = -1.0;  // -1 = uninitialized sentinel
            double attackProgress = 0.0;
        };
        LfoState lfoVolState;
        LfoState lfoPanState;
        LfoState lfoPitchState;

        int onsetSample   = 0;  // sub-buffer onset: processVoice skips output for [0, onsetSample), reset to 0 after first block
        int releaseSample = -1; // sub-buffer sample at which to enter Release; -1 = none queued

        // Voice identity (set at spawn time). spawnCounter drives oldest-held-first
        // tiebreaking in findVoiceForNote; spawnAbsSample drives orphan-candidate
        // detection. Both are reset on every true re-spawn (fireNoteOn, mono hard
        // retrigger). Legato/portamento paths intentionally preserve identity.
        uint64_t spawnCounter   = 0;   // monotonic per-sampler; 0 = never spawned
        int64_t  spawnAbsSample = -1;  // absolute transport sample at spawn; -1 = preview/unknown
#ifdef XLETH_DEBUG
        int64_t  lastLoggedAbsSample = -1;      // per-voice throttle for [OrphanCandidate]
        int64_t  lastZombieLogAbsSample = -1;   // per-voice throttle for [ZombieVoice]
#endif
    };

    static constexpr int MAX_VOICES = 32;
    std::array<Voice, MAX_VOICES> voices_{};

    // Voice identity / orphan-detection plumbing.
    // currentAbsSample_ is set by MixEngine once per buffer via setCurrentSample().
    // fireNoteOn captures (currentAbsSample_ + sampleOffset) into Voice::spawnAbsSample.
    uint64_t nextSpawnCounter_ = 1;   // 0 reserved as "never spawned" sentinel
    int64_t  currentAbsSample_ = 0;   // buffer-start absolute sample; 0 = preview/pre-transport
#ifdef XLETH_DEBUG
    uint64_t orphanCandidatesEver_ = 0;
    FILE*    telemetryLog_         = nullptr;  // injected by MixEngine; nullptr → stderr
    int      debugTrackId_         = -1;       // for [OrphanCandidate] samplerKey prefix
    int      debugRegionId_        = -1;
    int64_t  lastCensusAbsSample_  = -1;       // throttle for [VoiceCensus]
    static const char* envStageName(Voice::EnvStage s) noexcept;
#endif

    Voice* findFreeVoice();                // returns first inactive, else steals
    Voice* findVoiceForNote(int midiNote); // first active voice matching note
    Voice* findActiveMonoVoice();          // first active voice (for mono mode)
    void   fireNoteOn(int midiNote, float velocity, int sampleOffset = 0);  // actual voice allocation
    void   fireNoteOff(int midiNote, int sampleOffset = 0, bool force = false); // actual voice release
    void   processVoice(Voice& v,
                        juce::AudioBuffer<float>& out,
                        int numSamples,
                        double engineSampleRate);
    float  advanceEnvelope(Voice& v, double engineSampleRate);
    float  advancePitchEnvelope(Voice& v, double engineSampleRate);

    // LFO helpers
    static float evaluateLfoWaveform(const std::vector<SampleRegion::LfoBreakpoint>& waveform, float phase);
    float advanceLfo(const LfoConfig& config, Voice::LfoState& state, double engineSampleRate) const;
};
