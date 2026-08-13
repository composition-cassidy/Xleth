#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include "Arpeggiator.h"
#include "MangleDsp.h"
#include "SamplerModulation.h"
#include "../model/TimelineTypes.h"

#include <array>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <vector>

// ─── Sampler ─────────────────────────────────────────────────────────────────
// Polyphonic pitched sample player with ADSR envelope and optional loop.
// NOT a JUCE AudioProcessor — plain C++ class, similar to MixEngine.
// One instance per {trackId, regionId}: MixEngine owns the samplers_ map.
//
// ── Layered slots ────────────────────────────────────────────────────────────
// A sampler holds up to MAX_SAMPLE_SLOTS (8) sample slots. Every note-on
// spawns ONE resampling stream per *sounding* slot, so a single note plays all
// its layers stacked. A slot sounds when it has audio and is not muted; if any
// slot is solo'd, only solo'd slots sound (solo beats mute, as in the mixer).
//
// Modulation stays where it was: ADSR, pitch envelope, the three drawable LFOs,
// portamento, group slide, mono/poly and the arpeggiator are all NOTE-level and
// shared by every stream of that note. Per-slot state is limited to audio,
// tuning, level/pan/mute/solo, trim, fades and loop.
//
// ── Stream budget and stealing ───────────────────────────────────────────────
// MAX_STREAMS (32) caps the number of concurrently sounding streams across the
// whole sampler — the real cost centre, since each stream is an independent
// interpolating read. Note-on computes how many streams the new note needs and,
// while the budget would be exceeded, releases the OLDEST note outright: all of
// that note's layers are released together, never a lone layer. Stealing at
// note granularity is what keeps a chord from losing individual layers and
// turning into a timbre change mid-sustain. Stolen notes are handed to their
// release envelope (not hard-killed), so stealing is click-free; their streams
// free up once the release finishes.
//
// A single-slot sampler therefore behaves exactly as before: 32 notes, 32
// streams. An 8-slot sampler sounds at most 4 simultaneous notes.
//
// Audio-thread rules:
//   - processBlock / noteOn / noteOff: NO alloc, NO locks, NO logging
//   - setters (setADSR, setLoopPoints, setRootNote, setCrossfadeMode,
//     loadSample, and every setSlot* / loadSlotSample) are MAIN THREAD ONLY;
//     call allNotesOff() first to avoid glitches.

class Sampler
{
public:
    Sampler() = default;

    // ── Slot configuration (main thread) ─────────────────────────────────────
    // Slot count is clamped to [1, MAX_SAMPLE_SLOTS]. Shrinking clears the
    // dropped slots' audio so a later grow starts from a clean slot.
    void setSlotCount(int count);
    int  slotCount() const { return slotCount_; }

    // Load PCM into one slot. rootNote is the MIDI note the sample is recorded
    // at; the note's pitch ratio is 2^((midiNote - rootNote + tuning)/12).
    void loadSlotSample(int slotIndex,
                        const juce::AudioBuffer<float>& audioData,
                        double sourceSampleRate, int rootNote);
    void clearSlotSample(int slotIndex);

    // Combined tuning. Stored pre-summed as semitones (fine is in cents) —
    // mirrors SampleSlot::tuningSemitones() so engine and model agree.
    void setSlotTuning(int slotIndex, int octave, int semitone,
                       float fineCents, int coarse);
    void setSlotLevel(int slotIndex, float volume, float pan);
    void setSlotMuteSolo(int slotIndex, bool mute, bool solo);
    void setSlotTrim(int slotIndex, int64_t smpStart, int64_t smpLength,
                     float declickMs, float fadeInMs, float fadeOutMs);
    // loopMode is a SampleLoopMode (0 = Forward, 1 = PingPong, 2 = Reverse).
    // exitLoopOnRelease makes a note-off finish the current loop pass and then
    // run on to the trim end instead of looping forever.
    void setSlotLoop(int slotIndex, bool loopEnabled, int64_t loopStart,
                     int64_t loopEnd, int64_t crossfadeSamples,
                     int loopMode = 0, bool exitLoopOnRelease = false);
    void setSlotRootNote(int slotIndex, int rootNote);

    // ── MANGLE (per-note, per-slot warp FX chain) ────────────────────────────
    // A slot holds an ORDERED CHAIN of up to xleth::mangle::kMaxInstances warp
    // units; the output of instance N feeds instance N+1, so order is audible.
    // Every instance instantiates PER STREAM — one per note per slot — so a
    // chord is shaped note by note before the voices sum. A bypassed or Off
    // instance costs the render loop nothing.
    //
    // setSlotMangleChain publishes the whole chain by one atomic swap (realtime
    // safe; never mutates config on the audio thread). Instances past the cap
    // are dropped; out-of-range mode ids fall back to Off. An empty chain (or
    // all-Off) publishes null and is a genuine bypass.
    void setSlotMangleChain(int slotIndex,
                            const std::vector<xleth::mangle::InstanceConfig>& chain);

    // Convenience: set a slot's chain to a SINGLE instance. Kept so existing
    // single-MANGLE call sites and the test suite read unchanged — and it is
    // exactly the legacy-migration shape (one instance == the old single MANGLE).
    void setSlotMangle(int slotIndex, int mode, float amount, float mix);

    // ── PREP bake publication (main thread) ──────────────────────────────────
    // Swap in the slot's PREP-baked buffer once an async bake lands, WITHOUT
    // rebuilding the sampler — sounding notes keep their envelopes and simply
    // read the new audio. The store is a single atomic publish; the audio
    // thread loads the pointer once per stream per block and holds it for that
    // block, so a buffer can never be freed under a live read head.
    //
    // Pass nullptr to fall back to the raw buffer last given to
    // loadSlotSample(). A read head past the end of a shorter new buffer is
    // caught by processVoice's existing bounds check and simply finishes.
    void setSlotPreparedBuffer(int slotIndex,
                               std::shared_ptr<const juce::AudioBuffer<float>> prepared);

    bool slotHasAudio(int slotIndex) const;
    // True when this slot would sound on a new note (has audio, and passes the
    // mute/solo test). Main-thread introspection + audio-thread stream setup.
    bool slotSounds(int slotIndex) const;

    // ── Main-thread configuration ────────────────────────────────────────────
    // Slot-0 convenience alias, kept so single-sample callers and the existing
    // test suite read unchanged.
    void loadSample(const juce::AudioBuffer<float>& audioData,
                    double sourceSampleRate, int rootNote);

    // The amplitude DAHDSR. Kept for the test suite and used internally by
    // applyAmpEnvFromMod_ — ENV 1 (the modulation system) is the amp envelope's
    // UI now, but the DSP is unchanged.
    void setADSR(float attackMs, float decayMs, float sustain, float releaseMs);
    void setEnvelope(float delayMs, float attackMs, float holdMs,
                     float decayMs, float sustain, float releaseMs,
                     float attackTension, float decayTension, float releaseTension);
    // Sampler-level: decides whether note-off releases at all.
    void setCrossfadeMode(bool enabled);   // false = one-shot, true = sustained

    // ── Slot-0 aliases ───────────────────────────────────────────────────────
    // Per-slot state now lives on the slots; these forward to slot 0 so
    // existing single-sample call sites keep compiling and behaving identically.
    void setLoopPoints(bool enabled, int64_t loopStart, int64_t loopEnd);
    void setRootNote(int note);
    void setSmpStart(int64_t start);          // playback start offset (source samples)
    void setSmpLength(int64_t length);        // 0 = full remaining from smpStart
    void setDeclickMs(float ms);              // Hann fade width at trim edges (ms, default 1.5)
    void setFadeIn(float ms);                 // linear fade-in duration (user-controlled)
    void setFadeOut(float ms);                // linear fade-out duration (user-controlled)
    void setCrossfadeSamples(int64_t samples);// FL-style loop crossfade width (0 = off)

    // ── Playback modes ──────────────────────────────────────────────────────
    void setMonoMode(bool enabled);

    // Cap on simultaneous NOTES, clamped to [1, MAX_VOICES]. Distinct from the
    // MAX_STREAMS budget: see the `voiceCount` comment on SampleRegion for how
    // the two limits compose. Lowering it below the current active-note count
    // steals by the same oldest-note-first, release-not-kill rule the stream
    // budget uses, so the two never disagree about which note dies.
    void setVoiceCount(int count);

    // MONO only. Reuse the sounding voice without restarting its envelopes or
    // read heads — a legato note only retunes. Poly mode ignores it.
    void setLegato(bool enabled);

    // mode: 0 = ALWAYS (fixed time per glide), 1 = SCALED (timeMs is per
    // OCTAVE, so the glide rate is constant). curve is a -1..+1 tension on the
    // glide shape; 0 is linear and reproduces the pre-curve behaviour exactly.
    void setPortamento(bool enabled, float timeMs, int mode = 0, float curve = 0.0f);
    void setArpeggiator(bool enabled, bool tempoSync, int division,
                        float freeTimeMs, float gate, int range, int direction);
    void setBPM(double bpm);

    // ── Modulation system (6 ENV + 6 LFO + VELO + NOTE + route list) ─────────
    // MAIN THREAD ONLY. Compiles the config into an immutable graph and
    // publishes it by atomic pointer swap, so a live note keeps rendering
    // through the old topology until the block ends and never sees a
    // half-written route list. Sounding voices keep their source state — only
    // the graph changes, which is what makes editing a route while a pad is
    // held non-glitching.
    //
    // An empty route list is an EXACT bypass: the audio thread loads a null
    // graph and skips the modulation path entirely.
    void setModulation(const xleth::sampmod::ModConfig& cfg);
    const xleth::sampmod::ModConfig& modulationConfig() const { return modConfig_; }

    // True when ANY slot carries audio — the sampler can make sound.
    bool hasSample() const;
    void allNotesOff();

    // Live count of sounding streams across every active note. Used by the
    // stream-budget check and asserted by the tests.
    int activeStreamCount() const;

    // Fix C: release voices whose spawnAbsSample falls within
    // [startSample, endSample). Audio-thread safe (no alloc, no lock).
    // Uses release envelope, not hard-kill. Intended as an additive safety
    // net when a PatternBlock drops out but another block keeps its
    // sampler alive — in that case prevActiveKeys_ in MixEngine does NOT
    // fire allNotesOff (the key is still live), so this per-block API
    // releases just the dropped block's voices.
    void releaseVoicesSpawnedInRange(int64_t startSample, int64_t endSample);

    // ── Voice-identity plumbing (audio-thread-safe scalar stores) ────────────
    // MixEngine calls setCurrentSample(bufStart) once per buffer before
    // triggerPatternNotes so fireNoteOn can record absolute spawn positions.
    // INVARIANT: absSample MUST be the BUFFER-START absolute sample (bufStart),
    // not bufEnd or any per-sample running counter — spawnAbsSample is computed
    // as (currentAbsSample_ + sampleOffset) where sampleOffset is BUFFER-RELATIVE.
    void setCurrentSample(int64_t absSample) noexcept { currentAbsSample_ = absSample; }
    void setVisualOnly(bool v) noexcept { visualOnly_.store(v, std::memory_order_relaxed); }

    // ── Audio-thread triggering ──────────────────────────────────────────────
    void noteOn(int midiNote, float velocity, int sampleOffset = 0);
    void noteOff(int midiNote, int sampleOffset = 0, bool force = false);

    // FL Studio-style group slide: silently retunes the currently active held
    // voices on this sampler so the chord glides as a transposed group toward
    // targetPitch. The transposition delta is computed from the highest active
    // held voice's CURRENT effective pitch (so chained slides start from the
    // already-slid pitch, not from the original midiNote). Slide notes do NOT
    // spawn voices, do NOT call noteOn/noteOff, and silently no-op when no
    // active held voice exists. Arpeggiator-enabled samplers ignore slides.
    void beginGroupSlide(int targetPitch,
                         double durationSamples,
                         float cx, float cy,
                         int sampleOffset = 0);

    // Additive render into outputBuffer (stereo assumed). Caller clears if needed.
    void processBlock(juce::AudioBuffer<float>& outputBuffer,
                      int numSamples, double engineSampleRate);

    // ── Introspection (main-thread) ──────────────────────────────────────────
    int  activeVoiceCount() const;
    int  countActiveVoices() const;      // audio-thread-safe read-only scan; same as activeVoiceCount
    int  countHeldVoices() const;        // voices where active && noteHeld
    int  countReleasingVoices() const;   // voices where active && !noteHeld

    // ── Test-only introspection ──────────────────────────────────────────────
    // Numeric voice-state accessors used by engine/test/test_sampler.cpp to
    // verify slide-note pitch behavior without resorting to FFT analysis on
    // multi-voice chord renders. Not for production use.
    double debugVoicePitch(int voiceIdx) const;
    bool   debugVoiceSlideActive(int voiceIdx) const;
    int    debugFirstActiveVoiceIndex() const;
    // Streams currently sounding on one voice (0 when the voice is inactive).
    int    debugVoiceStreamCount(int voiceIdx) const;
    // Slot index driving stream `streamIdx` of voice `voiceIdx`, or -1.
    int    debugVoiceStreamSlot(int voiceIdx, int streamIdx) const;
    // Instances in a slot's published MANGLE chain (0 when none/null). Used by
    // the chain tests to assert the 4-instance cap and add/remove counts.
    int    debugSlotMangleCount(int slotIndex) const;

    // ── Modulation introspection (test-only) ─────────────────────────────────
    // Raw source output (natural range: ±1 for LFOs, 0..1 otherwise) as of the
    // last control block. debugModVoiceSource reads the per-voice bank,
    // debugModGlobalSource the shared FREE/MONO bank.
    float  debugModVoiceSource(int voiceIdx, int sourceIdx) const;
    float  debugModGlobalSource(int sourceIdx) const;
    // Resolved modulated value the render loop is currently using.
    float  debugModVoiceSlotSemis(int voiceIdx, int slotIdx) const;
    float  debugModVoiceSlotVolume(int voiceIdx, int slotIdx) const;
    float  debugModVoiceSlotPan(int voiceIdx, int slotIdx) const;
    float  debugModVoiceMasterVolume(int voiceIdx) const;
    // Compiled-graph shape.
    int    debugModEvalPosition(int sourceIdx) const;
    bool   debugModRouteDeferred(int routeIdx) const;
    bool   debugModHasCycle() const;
    int    debugModEnvStage(int voiceIdx, int envIdx) const;

private:
    // ── Slot ─────────────────────────────────────────────────────────────────
    // One layer: its PCM plus everything that is per-layer. Mirrors SampleSlot
    // in the model; kept as a separate struct so the audio path never reaches
    // into Timeline data.
    struct Slot
    {
        // ── Published audio ──────────────────────────────────────────────────
        // `data` is what the audio thread plays: the PREP-baked buffer when one
        // has landed, otherwise `raw`. Both are shared_ptr so the swap is a
        // single atomic store with no reallocation and no lifetime hazard —
        // the same publication model ClipRenderCache uses for its render slots.
        //
        // `raw` is retained so clearing PREP restores the untouched sample
        // without a reload, and so a rebake always starts from the same input.
        using BufferPtr = std::shared_ptr<const juce::AudioBuffer<float>>;
        std::atomic<BufferPtr> data{};
        BufferPtr              raw;          // main thread only

        // Retirement ring. A voice that is mid-block when `data` is swapped
        // keeps a reference to the OLD buffer until the block ends; if that
        // were the last reference, the free would land on the audio thread.
        // Retaining the last kRetained published buffers on the main thread
        // makes that impossible for any swap rate below one per block — and
        // swaps are user- or bake-driven, orders of magnitude slower than that.
        static constexpr int kRetained = 4;
        std::array<BufferPtr, kRetained> retired{};   // main thread only
        int                              retiredNext = 0;

        // Publish `next` and retire whatever was there. Main thread only.
        void publish(BufferPtr next) {
            auto prev = data.exchange(std::move(next), std::memory_order_acq_rel);
            if (prev) {
                retired[static_cast<size_t>(retiredNext)] = std::move(prev);
                retiredNext = (retiredNext + 1) % kRetained;
            }
        }

        double sourceSampleRate = 48000.0;
        int    rootNote         = 60;

        // Pre-summed octave*12 + semitone + coarse + fine/100, in semitones.
        double tuningSemitones  = 0.0;

        float volume = 1.0f;
        float pan    = 0.0f;      // -1 = hard L, +1 = hard R
        bool  mute   = false;
        bool  solo   = false;

        int64_t smpStart  = 0;
        int64_t smpLength = 0;
        float   declickMs = 1.5f;
        float   fadeInMs  = 0.0f;
        float   fadeOutMs = 0.0f;

        bool    loopEnabled       = false;
        int64_t loopStart         = 0;
        int64_t loopEnd           = 0;
        int64_t crossfadeSamples  = 0;
        int     loopMode          = static_cast<int>(SampleLoopMode::Forward);
        bool    exitLoopOnRelease = false;

        // MANGLE chain. A slot holds an ORDERED CHAIN of up to kMaxInstances
        // MANGLE units, published to the audio thread by the SAME atomic-pointer
        // swap Slot::data uses above: the main thread builds an immutable
        // ChainConfig and stores it, the audio thread loads it once per stream
        // per block. A null pointer (the default) is a genuine bypass — a slot
        // that has never been mangled costs exactly nothing. Add / remove /
        // reorder is one atomic store; nothing mutates the config on the audio
        // thread.
        using ChainPtr = std::shared_ptr<const xleth::mangle::ChainConfig>;
        std::atomic<ChainPtr> mangleChain{};

        // Retire the last kMangleRetained published chains on the MAIN thread so
        // a swap can never drop the last reference to a config an in-flight
        // render is reading — mirrors the `retired` ring for `data`. A tiny POD
        // free is not a real-time hazard, but this keeps the whole chain
        // lifecycle off the audio thread as the contract requires.
        static constexpr int kMangleRetained = 4;
        std::array<ChainPtr, kMangleRetained> mangleRetired{};   // main thread only
        int                                   mangleRetiredNext = 0;

        // Publish `next` and retire whatever was there. Main thread only.
        void publishMangle(ChainPtr next) {
            auto prev = mangleChain.exchange(std::move(next), std::memory_order_acq_rel);
            if (prev) {
                mangleRetired[static_cast<size_t>(mangleRetiredNext)] = std::move(prev);
                mangleRetiredNext = (mangleRetiredNext + 1) % kMangleRetained;
            }
        }

        bool hasAudio() const {
            const auto d = data.load(std::memory_order_acquire);
            return d != nullptr && d->getNumSamples() > 0;
        }

        // Slot holds an atomic member, so it is neither copyable nor
        // assignable. Shrinking the slot count resets in place instead of
        // assigning a fresh Slot{}.
        void reset() {
            publish(nullptr);
            raw.reset();
            for (auto& r : retired) r.reset();
            retiredNext       = 0;
            sourceSampleRate  = 48000.0;
            rootNote          = 60;
            tuningSemitones   = 0.0;
            volume            = 1.0f;
            pan               = 0.0f;
            mute              = false;
            solo              = false;
            smpStart          = 0;
            smpLength         = 0;
            declickMs         = 1.5f;
            fadeInMs          = 0.0f;
            fadeOutMs         = 0.0f;
            loopEnabled       = false;
            loopStart         = 0;
            loopEnd           = 0;
            crossfadeSamples  = 0;
            loopMode          = static_cast<int>(SampleLoopMode::Forward);
            exitLoopOnRelease = false;
            publishMangle(nullptr);
            for (auto& r : mangleRetired) r.reset();
            mangleRetiredNext = 0;
        }
    };

    std::array<Slot, MAX_SAMPLE_SLOTS> slots_{};
    int  slotCount_ = 1;
    // Cached "any slot is solo'd" so the audio thread doesn't rescan per note.
    bool anySolo_   = false;
    void refreshSoloCache();

    float   delayMs_        = 0.0f;
    float   attackMs_       = 0.0f;
    float   holdMs_         = 0.0f;
    float   decayMs_        = 0.0f;
    float   sustain_        = 1.0f;
    float   releaseMs_      = 50.0f;
    float   attackTension_  = 0.0f;   // -1..+1 (0 = linear)
    float   decayTension_   = 0.0f;
    float   releaseTension_ = 0.0f;

    // Fill the amplitude DAHDSR (the members above) from modulation ENV 1
    // (modConfig_.envs[0]), converting its ModTimes to milliseconds at bpm_.
    // ENV 1 is the amp envelope's home now that the legacy per-region scalars
    // are gone; called whenever the config or tempo changes.
    void applyAmpEnvFromMod_();

    bool    crossfadeEnabled_ = false;     // one-shot vs sustained (sampler-level)

    // Playback modes
    bool    monoEnabled_        = false;
    bool    portamentoEnabled_  = false;
    float   portamentoTimeMs_   = 100.0f;
    int     portamentoMode_     = 0;       // 0 = Always, 1 = Scaled (per octave)
    float   portamentoCurve_    = 0.0f;    // -1..+1 glide tension (0 = linear)
    bool    legatoEnabled_      = false;
    int     voiceCount_         = 32;      // simultaneous NOTES, 1..MAX_VOICES
    int     lastNotePitch_      = -1;      // for poly+porta (start from last note)
    double  bpm_                = 140.0;
    Arpeggiator arp_;

    std::atomic<bool> visualOnly_ { false };

    // Mono held-note stack (most recent at back, max 16)
    std::vector<int> monoHeldNotes_;

    // ── Voice = one NOTE ─────────────────────────────────────────────────────
    // A Voice carries all note-level modulation (envelopes, LFOs, portamento,
    // slide) and owns one Stream per sounding slot. Everything outside
    // `streams` behaves exactly as it did in the single-sample sampler, which
    // is why mono/portamento/arp/slide needed no changes for layering.
    struct Voice
    {
        // One layer of this note: an independent read head into one slot.
        struct Stream
        {
            bool   active       = false;
            int    slotIndex    = 0;
            double playPosition = 0.0;     // fractional sample index (source samples)
            // Set once the read head passes the slot's trim end. The note only
            // releases when EVERY stream has finished, so a short layer never
            // cuts a long one short.
            bool   finished     = false;

            // Read direction: +1 forward, -1 backward. Only ever -1 inside a
            // PingPong or Reverse loop; a Forward loop and the post-loop tail
            // are always +1, which is what keeps the Forward path identical to
            // what it was before loop modes existed.
            int    dir          = 1;
            // Note-off arrived on a slot with exitLoopOnRelease: finish the
            // current pass, then leave the loop.
            bool   exiting      = false;
            // The loop has been left; play forward to the trim end. Suppresses
            // both the wrap and the loop crossfade for the rest of the note.
            bool   loopLeft     = false;

            // MANGLE chain state — one State per instance, preallocated with the
            // stream, so switching modes or adding an instance mid-note is a
            // plain config swap with no allocation. All reset at every true
            // (re)spawn in armStreams().
            std::array<xleth::mangle::State, xleth::mangle::kMaxInstances> mangle{};
        };
        std::array<Stream, MAX_SAMPLE_SLOTS> streams{};
        int numStreams = 0;                // count of entries in use (active or finished)

        bool   active       = false;
        int    midiNote     = 60;
        float  velocity     = 1.0f;
        double pitchRatio   = 1.0;         // 2^((midiNote - rootNote) / 12)

        // Portamento state. `source` and `total` are captured at glide start so
        // the CURVE can be applied as a shaped interpolation across the whole
        // glide rather than as a per-sample step — a per-sample step can only
        // ever describe a linear ramp.
        double currentPitchF       = 60.0; // fractional MIDI note (smoothed)
        int    targetPitch         = -1;   // glide target (-1 = no glide)
        double portamentoRemaining = 0.0;  // samples left in glide
        double portamentoSourceF   = 60.0; // pitch the glide started from
        double portamentoTotal     = 0.0;  // glide length in samples (0 = none)

        // FL-style group slide state (independent of portamento — slide is its
        // own glide layer that mutates currentPitchF directly; pitch envelope
        // and LFO continue as additive modulation layers on top).
        bool   slideActive          = false;
        double slideSourcePitchF    = 0.0;  // captured at slide start (post any prior in-flight slide)
        double slideTargetPitchF    = 0.0;  // source + (slideNotePitch - highestActivePitch)
        double slideElapsedSamples  = 0.0;
        double slideDurationSamples = 0.0;
        float  slideCurveCx         = 0.5f;
        float  slideCurveCy         = 0.5f;
        int    slideOnsetSample     = 0;    // sub-buffer gate; reset to 0 each block (mirrors onsetSample)

        // The amplitude DAHDSR is the VCA and the voice-lifecycle gate. Its
        // parameters are sourced from modulation ENV 1 (see applyAmpEnvFromMod_);
        // this per-voice state is the running envelope for one note.
        enum class EnvStage { Delay, Attack, Hold, Decay, Sustain, Release, Off };
        EnvStage envStage         = EnvStage::Off;
        float    envLevel         = 0.0f;
        float    releaseStartLevel = 0.0f; // envLevel captured at moment Release began
        double   envPosition      = 0.0;   // samples elapsed in current stage
        bool     noteHeld         = false;

        int onsetSample   = 0;  // sub-buffer onset: processVoice skips output for [0, onsetSample), reset to 0 after first block
        int releaseSample = -1; // sub-buffer sample at which to enter Release; -1 = none queued

        // ── Modulation (per-voice half of the system) ────────────────────────
        // `modBank` holds this voice's ENV / RETRIG-LFO / ENVELOPE-LFO / VELO /
        // NOTE state; `modOffsets` is the resolved audio-parameter offset set,
        // recomputed once per control block and held for its 32 samples.
        //
        // modCountdown counts VOICE samples, not buffer samples, so envelope
        // timing is identical whatever the host buffer size is. It is zeroed at
        // note-on, which forces an evaluation on the voice's very first sample.
        xleth::sampmod::ModSourceBank modBank{};
        xleth::sampmod::ModOffsets    modOffsets{};
        int modCountdown = 0;

        // Per-slot pan gains the render loop reads. Seeded from the slot's own
        // constant-power pan when geometry is resolved, and overwritten at
        // control rate only where a pan route exists — so an unmodulated slot
        // costs exactly one extra array read per sample and no trig at all.
        std::array<float, MAX_SAMPLE_SLOTS> modPanL{};
        std::array<float, MAX_SAMPLE_SLOTS> modPanR{};
        // Modulated sampler master gain (base 1.0).
        float modMasterGain = 1.0f;

        // Voice identity fields, reset on every true re-spawn (fireNoteOn, mono hard
        // retrigger). Legato/portamento paths intentionally preserve identity.
        uint64_t spawnCounter   = 0;   // monotonic per-sampler; 0 = never spawned
        int64_t  spawnAbsSample = -1;  // absolute transport sample at spawn; -1 = preview/unknown
    };

    // MAX_VOICES caps simultaneous NOTES; MAX_STREAMS caps simultaneous layers
    // across all of them. With one slot the two are equivalent (the historical
    // 32-voice behaviour); with 8 slots the stream budget binds first.
    static constexpr int MAX_VOICES  = 32;
    static constexpr int MAX_STREAMS = 32;
    std::array<Voice, MAX_VOICES> voices_{};

    uint64_t nextSpawnCounter_ = 1;   // 0 reserved as "never spawned" sentinel
    int64_t  currentAbsSample_ = 0;   // buffer-start absolute sample; 0 = preview/pre-transport

    // ── Modulation: published graph + global (FREE / MONO) half ──────────────
    // The graph is swapped in whole. shared_ptr publication mirrors Slot::data:
    // the audio thread loads it ONCE per processBlock and holds it for the
    // block, so a swap can never free a graph a render is reading through.
    using ModGraphPtr = std::shared_ptr<const xleth::sampmod::CompiledModGraph>;
    std::atomic<ModGraphPtr> modGraph_{};
    static constexpr int kModGraphRetained = 4;
    std::array<ModGraphPtr, kModGraphRetained> modGraphRetired_{};  // main thread only
    int modGraphRetiredNext_ = 0;
    xleth::sampmod::ModConfig modConfig_{};                         // main thread only

    // The graph this buffer is rendering through. Loaded ONCE per processBlock
    // (one refcount bump, no allocation) and held for the whole block so a
    // main-thread swap can never pull the topology out from under a voice.
    ModGraphPtr modHeld_{};
    const xleth::sampmod::CompiledModGraph* modActive_ = nullptr;

    // One shared instance per FREE / MONO source, advanced once per control
    // block regardless of how many voices are sounding.
    xleth::sampmod::ModSourceBank modGlobalBank_{};

    // Per-buffer cache of the global sources' values, one entry per control
    // block the buffer spans. processVoice indexes it by sample so every voice
    // in the buffer reads the SAME global instance at the same point in time —
    // which is the whole meaning of "one global instance".
    static constexpr int kMaxCtrlBlocksPerBuffer = 136;   // 4352-sample buffer
    std::array<std::array<float, xleth::sampmod::kNumSources>,
               kMaxCtrlBlocksPerBuffer> modGlobalCacheValue_{};
    std::array<std::array<float, xleth::sampmod::kNumSources>,
               kMaxCtrlBlocksPerBuffer> modGlobalCacheAmount_{};
    int     modCacheCount_ = 0;
    int64_t modCacheFirstBlock_ = 0;
    int64_t modBufferStartClock_ = 0;   // render clock at the START of this buffer

    // The sampler's own render clock, in samples. Drives global control-block
    // boundaries so FREE sources keep running even in a preview render where
    // the transport never moves.
    int64_t modSampleClock_  = 0;
    int64_t modBlocksDone_   = 0;   // control blocks the global bank has advanced
    // Transport anchoring for FREE sources: a discontinuity in the absolute
    // sample position (a seek) re-anchors their phase; ordinary contiguous
    // playback and a static preview position both leave them alone.
    int64_t modExpectedAbs_  = 0;
    int64_t modLastAbs_      = 0;
    bool    modAbsSeen_      = false;

    // Snapshot of the newest voice's per-voice source values, published so a
    // route from a per-voice source into a GLOBAL source's parameter has
    // something to read. Always one control block behind (see the cycle rule).
    std::array<float, xleth::sampmod::kNumSources> modLatestVoiceValue_{};
    std::array<float, xleth::sampmod::kNumSources> modLatestVoiceAmount_{};
    uint64_t modLatestVoiceSpawn_ = 0;

    Voice* findFreeVoice();                // returns first inactive, else steals
    Voice* findVoiceForNote(int midiNote); // first active voice matching note
    Voice* findActiveMonoVoice();          // first active voice (for mono mode)
    void   fireNoteOn(int midiNote, float velocity, int sampleOffset = 0);  // actual voice allocation
    void   fireNoteOff(int midiNote, int sampleOffset = 0, bool force = false); // actual voice release

    // Number of streams a fresh note would spawn right now (sounding slots).
    int  soundingSlotCount() const;
    // Arm v's streams for the currently sounding slots, resetting read heads to
    // each slot's trim start. Used by every true (re)spawn.
    void armStreams(Voice& v);
    // Release whole notes, oldest first, until `needed` more streams fit inside
    // MAX_STREAMS. Release (not hard-kill) so stealing stays click-free.
    void enforceStreamBudget(int needed);
    // Same rule, applied to the NOTE cap: release oldest-first until one more
    // note fits inside voiceCount_. Runs alongside enforceStreamBudget, so
    // whichever limit binds first is the one that steals.
    void enforceVoiceBudget();

    // Glide length in samples for a move of `semitones`, honouring
    // ALWAYS vs SCALED. Returns 0 when portamento is off or the interval is
    // zero, which the caller reads as "no glide".
    double portamentoSamplesFor(double semitones) const;
    // Arm a glide on `v` from its current pitch to `target`.
    void   beginPortamento(Voice& v, int target);
    // Hand one note to its release envelope. Shared by stealing, allNotesOff
    // and releaseVoicesSpawnedInRange — all of which must free streams
    // promptly, so none of them honour exitLoopOnRelease.
    static void releaseVoice(Voice& v);

    // EXIT-LOOP-ON-RELEASE. Marks every looping stream of `v` as exiting and
    // returns true, meaning the caller must NOT start the amplitude release —
    // the note holds sustain through the tail and releases via the ordinary
    // "every layer has run out" path.
    //
    // Returns false (and touches nothing) unless EVERY currently-looping
    // stream of the note has the option set. A mixed note would otherwise be
    // left with one layer looping forever and no release to end it.
    bool armExitLoopTail(Voice& v);

    void   processVoice(Voice& v,
                        juce::AudioBuffer<float>& out,
                        int numSamples,
                        double engineSampleRate);
    float  advanceEnvelope(Voice& v, double engineSampleRate);

    // ── Modulation helpers ───────────────────────────────────────────────────
    // Advance the global bank over every control block this buffer spans and
    // fill the per-block cache. Once per processBlock, before any voice runs.
    void advanceGlobalModulation(const xleth::sampmod::CompiledModGraph& g,
                                 int numSamples, double engineSampleRate);
    // Evaluate one voice's control block: sources, then the audio-parameter
    // offsets the render loop reads for the next 32 samples.
    void evaluateVoiceModulation(Voice& v,
                                 const xleth::sampmod::CompiledModGraph& g,
                                 int sampleInBuffer, double engineSampleRate);
};
