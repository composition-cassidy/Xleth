#include "Sampler.h"
#include "dsp/DeclickEnvelope.h"
#include "../util/BezierEase.h"

#include <algorithm>
#include <cmath>
#include <limits>

// ─── Configuration (main thread) ─────────────────────────────────────────────

void Sampler::loadSample(const juce::AudioBuffer<float>& audioData,
                         double sourceSampleRate, int rootNote)
{
    sampleData_.makeCopyOf(audioData, true);
    sourceSampleRate_ = (sourceSampleRate > 0.0) ? sourceSampleRate : 48000.0;
    rootNote_         = rootNote;
}

void Sampler::setADSR(float attackMs, float decayMs, float sustain, float releaseMs)
{
    setEnvelope(0.0f, attackMs, 0.0f, decayMs, sustain, releaseMs, 0.0f, 0.0f, 0.0f);
}

void Sampler::setEnvelope(float delayMs, float attackMs, float holdMs,
                          float decayMs, float sustain, float releaseMs,
                          float attackTension, float decayTension, float releaseTension)
{
    delayMs_        = std::max(0.0f, delayMs);
    attackMs_       = std::max(0.0f, attackMs);
    holdMs_         = std::max(0.0f, holdMs);
    decayMs_        = std::max(0.0f, decayMs);
    sustain_        = std::clamp(sustain, 0.0f, 1.0f);
    releaseMs_      = std::max(0.0f, releaseMs);
    attackTension_  = std::clamp(attackTension,  -1.0f, 1.0f);
    decayTension_   = std::clamp(decayTension,   -1.0f, 1.0f);
    releaseTension_ = std::clamp(releaseTension, -1.0f, 1.0f);
}

void Sampler::setPitchEnvelope(float delayMs, float attackMs, float holdMs,
                               float decayMs, float sustain, float releaseMs,
                               float attackTension, float decayTension, float releaseTension)
{
    pitchEnvDelayMs_        = std::max(0.0f, delayMs);
    pitchEnvAttackMs_       = std::max(0.0f, attackMs);
    pitchEnvHoldMs_         = std::max(0.0f, holdMs);
    pitchEnvDecayMs_        = std::max(0.0f, decayMs);
    pitchEnvSustain_        = std::clamp(sustain, 0.0f, 1.0f);
    pitchEnvReleaseMs_      = std::max(0.0f, releaseMs);
    pitchEnvAttackTension_  = std::clamp(attackTension,  -1.0f, 1.0f);
    pitchEnvDecayTension_   = std::clamp(decayTension,   -1.0f, 1.0f);
    pitchEnvReleaseTension_ = std::clamp(releaseTension, -1.0f, 1.0f);
}

void Sampler::setPitchEnvEnabled(bool enabled)
{
    pitchEnvEnabled_ = enabled;
}

void Sampler::setPitchEnvAmount(float semitones)
{
    pitchEnvAmount_ = std::clamp(semitones, -48.0f, 48.0f);
}

void Sampler::setLoopPoints(bool enabled, int64_t loopStart, int64_t loopEnd)
{
    loopEnabled_ = enabled;
    loopStart_   = std::max<int64_t>(0, loopStart);
    loopEnd_     = std::max<int64_t>(0, loopEnd);
}

void Sampler::setCrossfadeMode(bool enabled)
{
    crossfadeEnabled_ = enabled;
}

void Sampler::setRootNote(int note)
{
    rootNote_ = note;
}

void Sampler::setSmpStart(int64_t start)
{
    smpStart_ = std::max<int64_t>(0, start);
}

void Sampler::setSmpLength(int64_t length)
{
    smpLength_ = std::max<int64_t>(0, length);
}

void Sampler::setDeclickMs(float ms)
{
    declickMs_ = std::max(0.0f, ms);
}

void Sampler::setFadeIn(float ms)  { fadeInMs_  = std::max(0.0f, ms); }
void Sampler::setFadeOut(float ms) { fadeOutMs_ = std::max(0.0f, ms); }

void Sampler::setCrossfadeSamples(int64_t samples)
{
    crossfadeSamples_ = std::max<int64_t>(0, samples);
}

void Sampler::setMonoMode(bool enabled)
{
    monoEnabled_ = enabled;
}

void Sampler::setPortamento(bool enabled, float timeMs)
{
    portamentoEnabled_ = enabled;
    portamentoTimeMs_  = std::max(0.0f, timeMs);
}

void Sampler::setArpeggiator(bool enabled, bool tempoSync, int division,
                             float freeTimeMs, float gate, int range, int direction)
{
    arp_.enabled    = enabled;
    arp_.tempoSync  = tempoSync;
    arp_.division   = std::max(1, division);
    arp_.freeTimeMs = std::max(1.0f, freeTimeMs);
    arp_.gate       = std::clamp(gate, 0.01f, 1.0f);
    arp_.range      = std::clamp(range, 1, 4);
    arp_.direction  = static_cast<Arpeggiator::Direction>(std::clamp(direction, 0, 3));
}

void Sampler::setBPM(double bpm)
{
    bpm_ = bpm > 0.0 ? bpm : 140.0;
}

// ── LFO configuration ──────────────────────────────────────────────────────

void Sampler::setLfoVol(bool enabled, float amount, float speedHz, bool tempoSync,
                        int tempoDivision, float attackMs, float delayMs,
                        const std::vector<SampleRegion::LfoBreakpoint>& waveform)
{
    auto& c = lfoVolConfig_;
    c.enabled = enabled; c.amount = amount; c.speedHz = std::max(0.01f, speedHz);
    c.tempoSync = tempoSync; c.tempoDivision = std::max(1, tempoDivision);
    c.attackMs = std::max(0.0f, attackMs); c.delayMs = std::max(0.0f, delayMs);
    c.waveform = waveform;
}

void Sampler::setLfoPan(bool enabled, float amount, float speedHz, bool tempoSync,
                        int tempoDivision, float attackMs, float delayMs,
                        const std::vector<SampleRegion::LfoBreakpoint>& waveform)
{
    auto& c = lfoPanConfig_;
    c.enabled = enabled; c.amount = amount; c.speedHz = std::max(0.01f, speedHz);
    c.tempoSync = tempoSync; c.tempoDivision = std::max(1, tempoDivision);
    c.attackMs = std::max(0.0f, attackMs); c.delayMs = std::max(0.0f, delayMs);
    c.waveform = waveform;
}

void Sampler::setLfoPitch(bool enabled, float amount, float speedHz, bool tempoSync,
                          int tempoDivision, float attackMs, float delayMs,
                          const std::vector<SampleRegion::LfoBreakpoint>& waveform)
{
    auto& c = lfoPitchConfig_;
    c.enabled = enabled; c.amount = amount; c.speedHz = std::max(0.01f, speedHz);
    c.tempoSync = tempoSync; c.tempoDivision = std::max(1, tempoDivision);
    c.attackMs = std::max(0.0f, attackMs); c.delayMs = std::max(0.0f, delayMs);
    c.waveform = waveform;
}

// ── Envelope Controller configuration (EVC.6) ───────────────────────────────

void Sampler::setEnvelopeControllers(const EnvelopeAhdsrSettings* settings, int count)
{
    if (settings == nullptr) count = 0;
    if (count < 0) count = 0;
    if (count > kMaxEnvelopeControllers) count = kMaxEnvelopeControllers;
    for (int i = 0; i < count; ++i)
        evcSettings_[i] = settings[i].normalized();
    evcCount_ = count;
}

// ── LFO evaluation ─────────────────────────────────────────────────────────

float Sampler::evaluateLfoWaveform(const std::vector<SampleRegion::LfoBreakpoint>& waveform,
                                   float phase)
{
    if (waveform.empty())
        return std::sin(phase * 6.2831853f);
    if (waveform.size() == 1)
        return waveform[0].value;

    phase = phase - std::floor(phase); // wrap to [0,1)

    // Linear scan for bracketing breakpoints (waveform is small, <64 points)
    for (size_t i = 0; i + 1 < waveform.size(); ++i) {
        if (phase <= waveform[i + 1].time) {
            const float span = waveform[i + 1].time - waveform[i].time;
            if (span < 1e-9f) return waveform[i].value;
            const float frac = (phase - waveform[i].time) / span;
            return waveform[i].value + (waveform[i + 1].value - waveform[i].value) * frac;
        }
    }
    return waveform.back().value;
}

float Sampler::advanceLfo(const LfoConfig& config, Voice::LfoState& state,
                          double engineSampleRate) const
{
    if (!config.enabled) return 0.0f;

    // Lazy delay initialisation (sentinel = -1)
    if (state.delayRemaining < 0.0)
        state.delayRemaining = config.delayMs * engineSampleRate * 0.001;

    // Delay phase
    if (state.delayRemaining > 0.0) {
        state.delayRemaining -= 1.0;
        return 0.0f;
    }

    // Compute cycle frequency
    double cycleHz = static_cast<double>(config.speedHz);
    if (config.tempoSync)
        cycleHz = (bpm_ / 60.0) * (4.0 / config.tempoDivision);

    // Advance phase
    state.phase += cycleHz / engineSampleRate;
    if (state.phase >= 1.0) state.phase -= std::floor(state.phase);

    // Evaluate waveform
    float mod = evaluateLfoWaveform(config.waveform, static_cast<float>(state.phase));

    // Attack fade-in
    if (config.attackMs > 0.0f && state.attackProgress < 1.0) {
        const double attackSamples = config.attackMs * engineSampleRate * 0.001;
        if (attackSamples > 0.0)
            state.attackProgress += 1.0 / attackSamples;
        if (state.attackProgress > 1.0) state.attackProgress = 1.0;
        mod *= static_cast<float>(state.attackProgress);
    }

    return mod;
}

void Sampler::allNotesOff()
{
    // Fix B: release-envelope semantics, not hard-kill. The prior
    // implementation cleared envLevel, playPosition, and active mid-buffer,
    // which could produce audible clicks if a voice was mid-amplitude when
    // the sampler-level safety net fired (e.g., a PatternBlock drops out
    // between buffers). Handing voices into their Release stage lets the
    // envelope decay naturally and does not require touching playPosition
    // (resetting it to 0 also caused a restart-from-zero click).
    //
    // Functionally equivalent to fireNoteOff(pitch, 0, force=true) on every
    // active voice, but inlined so the audio thread does no map lookups.
    for (auto& v : voices_)
    {
        if (!v.active) continue;
        if (v.envStage == Voice::EnvStage::Off) continue;  // already dead
        v.noteHeld          = false;
        v.releaseStartLevel = v.envLevel;    // envelope continuity
        v.envStage          = Voice::EnvStage::Release;
        v.envPosition       = 0.0;
        v.pitchEnvStage     = Voice::EnvStage::Release;
        v.pitchEnvPosition  = 0.0;
    }
    // Control-plane state reset (unchanged).
    arp_.reset();
    lastNotePitch_ = -1;
    monoHeldNotes_.clear();
}

void Sampler::releaseVoicesSpawnedInRange(int64_t startSample, int64_t endSample)
{
    // Fix C: additive safety net for the adjacent-block dropout case.
    // Only release voices whose spawnAbsSample falls inside [startSample,
    // endSample) — voices spawned in other live blocks using the same
    // sampler are untouched. spawnAbsSample == -1 means preview/pre-
    // transport and is skipped (those never belonged to a transport
    // block).
    for (auto& v : voices_)
    {
        if (!v.active) continue;
        if (!v.noteHeld) continue;
        if (v.spawnAbsSample < 0) continue;
        if (v.spawnAbsSample < startSample) continue;
        if (v.spawnAbsSample >= endSample)  continue;
        v.noteHeld          = false;
        v.releaseStartLevel = v.envLevel;
        v.envStage          = Voice::EnvStage::Release;
        v.envPosition       = 0.0;
        v.pitchEnvStage     = Voice::EnvStage::Release;
        v.pitchEnvPosition  = 0.0;
    }
}

int Sampler::activeVoiceCount() const
{
    int n = 0;
    for (const auto& v : voices_) if (v.active) ++n;
    return n;
}

int Sampler::countActiveVoices() const
{
    int n = 0;
    for (const auto& v : voices_) if (v.active) ++n;
    return n;
}

int Sampler::countHeldVoices() const
{
    int n = 0;
    for (const auto& v : voices_) if (v.active && v.noteHeld) ++n;
    return n;
}

int Sampler::countReleasingVoices() const
{
    int n = 0;
    for (const auto& v : voices_) if (v.active && !v.noteHeld) ++n;
    return n;
}

// ─── Test-only voice introspection ───────────────────────────────────────────
// Numeric accessors used by engine/test/test_sampler.cpp — see header.

double Sampler::debugVoicePitch(int voiceIdx) const
{
    if (voiceIdx < 0 || voiceIdx >= MAX_VOICES) return 0.0;
    return voices_[static_cast<size_t>(voiceIdx)].currentPitchF;
}

bool Sampler::debugVoiceSlideActive(int voiceIdx) const
{
    if (voiceIdx < 0 || voiceIdx >= MAX_VOICES) return false;
    return voices_[static_cast<size_t>(voiceIdx)].slideActive;
}

int Sampler::debugFirstActiveVoiceIndex() const
{
    for (int i = 0; i < MAX_VOICES; ++i)
        if (voices_[static_cast<size_t>(i)].active) return i;
    return -1;
}

// ─── Voice allocation ────────────────────────────────────────────────────────

Sampler::Voice* Sampler::findFreeVoice()
{
    for (auto& v : voices_)
        if (!v.active) return &v;

    // Voice stealing: pick the one with lowest envelope level.
    Voice* victim = &voices_[0];
    for (auto& v : voices_)
        if (v.envLevel < victim->envLevel) victim = &v;
    return victim;
}

Sampler::Voice* Sampler::findVoiceForNote(int midiNote)
{
    for (auto& v : voices_)
        if (v.active && v.noteHeld && v.midiNote == midiNote)
            return &v;
    return nullptr;
}

Sampler::Voice* Sampler::findActiveMonoVoice()
{
    for (auto& v : voices_)
        if (v.active) return &v;
    return nullptr;
}

// ─── noteOn / noteOff (public — routing layer) ─────────────────────────────

void Sampler::noteOn(int midiNote, float velocity, int sampleOffset)
{
    if (sampleData_.getNumSamples() <= 0) return;

    // Arpeggiator intercept: feed notes to arp, not voices
    if (arp_.enabled) {
        arp_.noteOn(midiNote, velocity);
        return;
    }

    const float vel = std::clamp(velocity, 0.0f, 1.0f);

    if (monoEnabled_) {
        // Track held note (remove duplicate, push to back as most recent)
        auto hIt = std::find(monoHeldNotes_.begin(), monoHeldNotes_.end(), midiNote);
        if (hIt != monoHeldNotes_.end()) monoHeldNotes_.erase(hIt);
        if (monoHeldNotes_.size() >= 16) monoHeldNotes_.erase(monoHeldNotes_.begin());
        monoHeldNotes_.push_back(midiNote);

        Voice* active = findActiveMonoVoice();
        if (active && portamentoEnabled_) {
            // Slide to new pitch instead of restarting
            active->targetPitch         = midiNote;
            active->midiNote            = midiNote;
            active->velocity            = vel;
            active->portamentoRemaining = static_cast<double>(portamentoTimeMs_)
                                          * 0.001 * sourceSampleRate_;
            active->noteHeld = true;
            // If the voice was releasing (key had been lifted), retrigger envelope
            if (active->envStage == Voice::EnvStage::Release
                || active->envStage == Voice::EnvStage::Off) {
                active->envStage     = Voice::EnvStage::Delay;
                active->envLevel     = 0.0f;
                active->envPosition  = 0.0;
                active->pitchEnvStage    = Voice::EnvStage::Delay;
                active->pitchEnvLevel    = 0.0f;
                active->pitchEnvPosition = 0.0;
            }
        } else if (active) {
            // Hard retrigger: restart the voice at new pitch
            active->midiNote     = midiNote;
            active->velocity     = vel;
            active->playPosition = static_cast<double>(smpStart_);
            active->currentPitchF = static_cast<double>(midiNote);
            active->targetPitch   = midiNote;
            active->portamentoRemaining = 0.0;
            active->pitchRatio   = std::pow(2.0, (midiNote - rootNote_) / 12.0);
            active->envStage     = Voice::EnvStage::Delay;
            active->envLevel     = 0.0f;
            active->envPosition  = 0.0;
            active->noteHeld     = true;
            active->pitchEnvStage    = Voice::EnvStage::Delay;
            active->pitchEnvLevel    = 0.0f;
            active->pitchEnvPosition = 0.0;
            active->onsetSample      = sampleOffset;
            // Hard retrigger cancels any in-flight slide on this voice.
            active->slideActive          = false;
            active->slideElapsedSamples  = 0.0;
            active->slideDurationSamples = 0.0;
            active->slideOnsetSample     = 0;
            // Semantic re-spawn: envelope restarts from Delay, playPosition reset
            // to smpStart_. Issue fresh identity so findVoiceForNote's
            // oldest-held-first ranking treats this as a new voice.
            active->spawnCounter   = nextSpawnCounter_++;
            active->spawnAbsSample = (currentAbsSample_ > 0)
                                     ? currentAbsSample_ + sampleOffset
                                     : -1;
        } else {
            // No active voice: start fresh
            fireNoteOn(midiNote, vel, sampleOffset);
        }
        lastNotePitch_ = midiNote;
        return;
    }

    // Polyphonic mode
    if (portamentoEnabled_ && lastNotePitch_ >= 0) {
        // Poly + porta: new voice slides from last note's pitch
        fireNoteOn(midiNote, vel, sampleOffset);
        // Find the voice we just allocated and set up glide
        Voice* v = findVoiceForNote(midiNote);
        if (v) {
            // A fresh noteOn cancels any slide that may have been targeting
            // this voice (fireNoteOn already reset slide state, but if
            // findVoiceForNote returned a different voice — e.g. duplicate
            // pitch retrigger — this is defense in depth).
            v->slideActive = false;
            v->currentPitchF       = static_cast<double>(lastNotePitch_);
            v->targetPitch         = midiNote;
            v->portamentoRemaining = static_cast<double>(portamentoTimeMs_)
                                     * 0.001 * sourceSampleRate_;
            v->pitchRatio = std::pow(2.0, (v->currentPitchF - rootNote_) / 12.0);
        }
    } else {
        fireNoteOn(midiNote, vel, sampleOffset);
    }
    lastNotePitch_ = midiNote;
}

void Sampler::noteOff(int midiNote, int sampleOffset, bool force)
{
    // Arpeggiator intercept — arp schedules releases per-sample in processSample;
    // sampleOffset is not forwarded here (arp uses its own timing).
    if (arp_.enabled) {
        const int activePitch = arp_.getActivePitch();
        arp_.noteOff(midiNote);
        // If all notes released and arp had an active note, release it
        if (!arp_.hasHeldNotes() && activePitch >= 0)
            fireNoteOff(activePitch, 0, force);
        return;
    }

    // Mono note-return: releasing one note returns to the next held note
    if (monoEnabled_) {
        auto hIt = std::find(monoHeldNotes_.begin(), monoHeldNotes_.end(), midiNote);
        if (hIt != monoHeldNotes_.end()) monoHeldNotes_.erase(hIt);

        if (!monoHeldNotes_.empty()) {
            // Return to the most recently pressed remaining note
            const int returnNote = monoHeldNotes_.back();
            Voice* active = findActiveMonoVoice();
            if (active) {
                active->targetPitch = returnNote;
                active->midiNote    = returnNote;
                if (portamentoEnabled_) {
                    active->portamentoRemaining = static_cast<double>(portamentoTimeMs_)
                                                  * 0.001 * sourceSampleRate_;
                } else {
                    // Instant pitch jump to return note
                    active->currentPitchF       = static_cast<double>(returnNote);
                    active->portamentoRemaining = 0.0;
                }
                lastNotePitch_ = returnNote;
                // Do NOT retrigger envelope — legato note-return
            }
        } else {
            // All notes released — find the voice by its current midiNote and release
            Voice* active = findActiveMonoVoice();
            if (active) fireNoteOff(active->midiNote, sampleOffset, force);
            lastNotePitch_ = -1;
        }
        return;
    }

    fireNoteOff(midiNote, sampleOffset, force);
}

// ─── fireNoteOn / fireNoteOff (private — actual voice allocation) ───────────

void Sampler::fireNoteOn(int midiNote, float velocity, int sampleOffset)
{
    if (sampleData_.getNumSamples() <= 0) return;

    Voice* v = findFreeVoice();
    if (v == nullptr) return;

    v->active       = true;
    v->midiNote     = midiNote;
    v->velocity     = velocity;
    v->playPosition = static_cast<double>(smpStart_);
    v->pitchRatio   = std::pow(2.0, (midiNote - rootNote_) / 12.0);
    v->currentPitchF       = static_cast<double>(midiNote);
    v->targetPitch         = midiNote;
    v->portamentoRemaining = 0.0;
    v->envStage     = Voice::EnvStage::Delay;
    v->envLevel     = 0.0f;
    v->envPosition  = 0.0;
    v->noteHeld     = true;
    v->pitchEnvStage    = Voice::EnvStage::Delay;
    v->pitchEnvLevel    = 0.0f;
    v->pitchEnvPosition = 0.0;
    v->lfoVolState   = Voice::LfoState{};
    v->lfoPanState   = Voice::LfoState{};
    v->lfoPitchState = Voice::LfoState{};
    v->onsetSample   = sampleOffset;
    v->releaseSample = -1;
    // Recycled voices must not inherit stale slide state.
    v->slideActive          = false;
    v->slideSourcePitchF    = 0.0;
    v->slideTargetPitchF    = 0.0;
    v->slideElapsedSamples  = 0.0;
    v->slideDurationSamples = 0.0;
    v->slideCurveCx         = 0.5f;
    v->slideCurveCy         = 0.5f;
    v->slideOnsetSample     = 0;
    v->spawnCounter   = nextSpawnCounter_++;
    v->spawnAbsSample = (currentAbsSample_ > 0)
                        ? currentAbsSample_ + sampleOffset
                        : -1;
    // Fresh per-voice Envelope Controller state (EVC.6): elapsed restarts at 0 and
    // the gate is "held" until this voice releases. A true re-spawn must never
    // inherit the previous note's envelope phase.
    v->evcElapsedSamples = 0.0;
    v->evcGateSamples    = -1.0;
}

void Sampler::fireNoteOff(int midiNote, int sampleOffset, bool force)
{
    // One-shot mode: noteOff is ignored — sample plays to completion.
    // force=true bypasses this guard for pattern-sequencer noteOffs, which
    // must always honour their drawn duration regardless of playback mode.
    if (!crossfadeEnabled_ && !force) return;

    Voice* v = findVoiceForNote(midiNote);
    if (v == nullptr) return;

    v->noteHeld      = false;
    // Defer the envStage → Release transition to processVoice at sample sampleOffset.
    // This makes the release boundary sample-accurate within the buffer.
    jassert(sampleOffset >= 0);
    v->releaseSample = sampleOffset;
}

// ─── FL-style group slide ────────────────────────────────────────────────────
//
// A slide note is a silent pitch-target marker dispatched by MixEngine for
// PatternNote.isSlide == true. It does NOT spawn a voice. Instead, it retunes
// every active held normal voice on this sampler so the chord glides as a
// transposed group: the highest active voice's CURRENT pitch is taken as the
// reference, the delta to the slide-note pitch is computed, and that same
// delta is applied to every affected voice. Chained slides automatically
// start from each voice's already-slid pitch because we capture
// slideSourcePitchF from currentPitchF (which the previous in-flight slide
// was updating per sample).
//
// Two slide notes that arrive at the same sample compose in PARALLEL (both
// see the same pre-slide currentPitchF), not chained — no sample has been
// rendered between them. This matches FL's same-tick semantics.

void Sampler::beginGroupSlide(int targetPitch,
                              double durationSamples,
                              float cx, float cy,
                              int sampleOffset)
{
    // Arpeggiator-driven samplers don't support group slides; voice spawning
    // is owned by the arp's own scheduler and slide semantics on arp'd voices
    // are undefined. Silent no-op.
    if (arp_.enabled) return;

    // First pass: find the highest current pitch among active held voices.
    // "Active held" excludes voices in Release / Off — the user has stopped
    // holding those notes and they should not be slid. Voices in Delay/Attack
    // are included (they're held and audible-imminent).
    double highestPitch = -1.0e9;
    bool   any          = false;
    for (const auto& v : voices_) {
        if (!v.active) continue;
        if (!v.noteHeld) continue;
        if (v.envStage == Voice::EnvStage::Release
            || v.envStage == Voice::EnvStage::Off) continue;
        if (v.currentPitchF > highestPitch) {
            highestPitch = v.currentPitchF;
            any          = true;
        }
    }
    if (!any) return;  // no active held voices; silent no-op

    const double delta = static_cast<double>(targetPitch) - highestPitch;

    // Second pass: arm slide on each affected voice.
    for (auto& v : voices_) {
        if (!v.active) continue;
        if (!v.noteHeld) continue;
        if (v.envStage == Voice::EnvStage::Release
            || v.envStage == Voice::EnvStage::Off) continue;

        v.slideSourcePitchF    = v.currentPitchF;
        v.slideTargetPitchF    = v.currentPitchF + delta;
        v.slideElapsedSamples  = 0.0;
        v.slideDurationSamples = durationSamples;
        v.slideCurveCx         = cx;
        v.slideCurveCy         = cy;
        v.slideOnsetSample     = sampleOffset;
        v.slideActive          = true;
        // Cancel any in-flight portamento so the slide is the sole writer to
        // currentPitchF this block. (Pattern Track is poly and porta is rare,
        // but defense in depth.)
        v.portamentoRemaining = 0.0;
        v.targetPitch         = v.midiNote;
    }
}

// ─── Envelope ────────────────────────────────────────────────────────────────

// Tension curve shaping. t in [0,1], tension in [-1,1].
// tension=0 → linear.  tension>0 → fast start (concave rise).
// tension<0 → slow start (convex rise).
static inline float shapeTension(float t, float tension)
{
    if (std::abs(tension) < 0.001f) return t;
    const float exponent = std::pow(2.0f, -tension * 2.0f);
    return std::pow(t, exponent);
}

float Sampler::advanceEnvelope(Voice& v, double engineSampleRate)
{
    const double msToSamples    = engineSampleRate * 0.001;
    const double delaySamples   = delayMs_   * msToSamples;
    const double attackSamples  = attackMs_  * msToSamples;
    const double holdSamples    = holdMs_    * msToSamples;
    const double decaySamples   = decayMs_   * msToSamples;
    const double releaseSamples = releaseMs_ * msToSamples;

    switch (v.envStage)
    {
        case Voice::EnvStage::Delay:
        {
            v.envLevel = 0.0f;
            if (delaySamples <= 0.0 || v.envPosition >= delaySamples) {
                v.envStage    = Voice::EnvStage::Attack;
                v.envPosition = 0.0;
            }
            break;
        }
        case Voice::EnvStage::Attack:
        {
            if (attackSamples <= 0.0) {
                v.envLevel    = 1.0f;
                v.envStage    = Voice::EnvStage::Hold;
                v.envPosition = 0.0;
            } else {
                const float frac = static_cast<float>(
                    std::min(1.0, v.envPosition / attackSamples));
                v.envLevel = shapeTension(frac, attackTension_);
                if (v.envPosition >= attackSamples) {
                    v.envLevel    = 1.0f;
                    v.envStage    = Voice::EnvStage::Hold;
                    v.envPosition = 0.0;
                }
            }
            break;
        }
        case Voice::EnvStage::Hold:
        {
            v.envLevel = 1.0f;
            if (holdSamples <= 0.0 || v.envPosition >= holdSamples) {
                v.envStage    = Voice::EnvStage::Decay;
                v.envPosition = 0.0;
            }
            break;
        }
        case Voice::EnvStage::Decay:
        {
            if (decaySamples <= 0.0) {
                v.envLevel    = sustain_;
                v.envStage    = Voice::EnvStage::Sustain;
                v.envPosition = 0.0;
            } else {
                const float frac = static_cast<float>(
                    std::min(1.0, v.envPosition / decaySamples));
                const float shaped = shapeTension(frac, decayTension_);
                v.envLevel = 1.0f - (1.0f - sustain_) * shaped;
                if (v.envPosition >= decaySamples) {
                    v.envLevel    = sustain_;
                    v.envStage    = Voice::EnvStage::Sustain;
                    v.envPosition = 0.0;
                }
            }
            break;
        }
        case Voice::EnvStage::Sustain:
        {
            v.envLevel = sustain_;
            break;
        }
        case Voice::EnvStage::Release:
        {
            if (releaseSamples <= 0.0) {
                v.envLevel = 0.0f;
                v.envStage = Voice::EnvStage::Off;
            } else {
                if (v.envPosition == 0.0) v.releaseStartLevel = v.envLevel;
                const float frac = static_cast<float>(
                    std::min(1.0, v.envPosition / releaseSamples));
                const float shaped = shapeTension(frac, releaseTension_);
                v.envLevel = v.releaseStartLevel * (1.0f - shaped);
                if (v.envPosition >= releaseSamples) {
                    v.envLevel = 0.0f;
                    v.envStage = Voice::EnvStage::Off;
                }
            }
            break;
        }
        case Voice::EnvStage::Off:
        default:
            v.envLevel = 0.0f;
            break;
    }

    v.envPosition += 1.0;
    if (v.envLevel < 0.0f) v.envLevel = 0.0f;
    if (v.envLevel > 1.0f) v.envLevel = 1.0f;
    return v.envLevel;
}

// ─── Pitch envelope (same DAHDSR FSM, operating on pitchEnv* voice state) ────

float Sampler::advancePitchEnvelope(Voice& v, double engineSampleRate)
{
    const double msToSamples    = engineSampleRate * 0.001;
    const double delaySamples   = pitchEnvDelayMs_   * msToSamples;
    const double attackSamples  = pitchEnvAttackMs_  * msToSamples;
    const double holdSamples    = pitchEnvHoldMs_    * msToSamples;
    const double decaySamples   = pitchEnvDecayMs_   * msToSamples;
    const double releaseSamples = pitchEnvReleaseMs_ * msToSamples;

    switch (v.pitchEnvStage)
    {
        case Voice::EnvStage::Delay:
        {
            v.pitchEnvLevel = 0.0f;
            if (delaySamples <= 0.0 || v.pitchEnvPosition >= delaySamples) {
                v.pitchEnvStage    = Voice::EnvStage::Attack;
                v.pitchEnvPosition = 0.0;
            }
            break;
        }
        case Voice::EnvStage::Attack:
        {
            if (attackSamples <= 0.0) {
                v.pitchEnvLevel    = 1.0f;
                v.pitchEnvStage    = Voice::EnvStage::Hold;
                v.pitchEnvPosition = 0.0;
            } else {
                const float frac = static_cast<float>(
                    std::min(1.0, v.pitchEnvPosition / attackSamples));
                v.pitchEnvLevel = shapeTension(frac, pitchEnvAttackTension_);
                if (v.pitchEnvPosition >= attackSamples) {
                    v.pitchEnvLevel    = 1.0f;
                    v.pitchEnvStage    = Voice::EnvStage::Hold;
                    v.pitchEnvPosition = 0.0;
                }
            }
            break;
        }
        case Voice::EnvStage::Hold:
        {
            v.pitchEnvLevel = 1.0f;
            if (holdSamples <= 0.0 || v.pitchEnvPosition >= holdSamples) {
                v.pitchEnvStage    = Voice::EnvStage::Decay;
                v.pitchEnvPosition = 0.0;
            }
            break;
        }
        case Voice::EnvStage::Decay:
        {
            if (decaySamples <= 0.0) {
                v.pitchEnvLevel    = pitchEnvSustain_;
                v.pitchEnvStage    = Voice::EnvStage::Sustain;
                v.pitchEnvPosition = 0.0;
            } else {
                const float frac = static_cast<float>(
                    std::min(1.0, v.pitchEnvPosition / decaySamples));
                const float shaped = shapeTension(frac, pitchEnvDecayTension_);
                v.pitchEnvLevel = 1.0f - (1.0f - pitchEnvSustain_) * shaped;
                if (v.pitchEnvPosition >= decaySamples) {
                    v.pitchEnvLevel    = pitchEnvSustain_;
                    v.pitchEnvStage    = Voice::EnvStage::Sustain;
                    v.pitchEnvPosition = 0.0;
                }
            }
            break;
        }
        case Voice::EnvStage::Sustain:
        {
            v.pitchEnvLevel = pitchEnvSustain_;
            break;
        }
        case Voice::EnvStage::Release:
        {
            if (releaseSamples <= 0.0) {
                v.pitchEnvLevel    = 0.0f;
                v.pitchEnvStage    = Voice::EnvStage::Off;
            } else {
                if (v.pitchEnvPosition == 0.0) v.pitchEnvReleaseStartLevel = v.pitchEnvLevel;
                const float frac = static_cast<float>(
                    std::min(1.0, v.pitchEnvPosition / releaseSamples));
                const float shaped = shapeTension(frac, pitchEnvReleaseTension_);
                v.pitchEnvLevel = v.pitchEnvReleaseStartLevel * (1.0f - shaped);
                if (v.pitchEnvPosition >= releaseSamples) {
                    v.pitchEnvLevel    = 0.0f;
                    v.pitchEnvStage    = Voice::EnvStage::Off;
                }
            }
            break;
        }
        case Voice::EnvStage::Off:
        default:
            v.pitchEnvLevel = 0.0f;
            break;
    }

    v.pitchEnvPosition += 1.0;
    if (v.pitchEnvLevel < 0.0f) v.pitchEnvLevel = 0.0f;
    if (v.pitchEnvLevel > 1.0f) v.pitchEnvLevel = 1.0f;
    return v.pitchEnvLevel;
}

// ─── processVoice / processBlock ─────────────────────────────────────────────

void Sampler::processVoice(Voice& v,
                           juce::AudioBuffer<float>& out,
                           int numSamples,
                           double engineSampleRate)
{
    const int nCh     = sampleData_.getNumChannels();
    const int nFrames = sampleData_.getNumSamples();
    if (nCh <= 0 || nFrames <= 0) { v.active = false; return; }
#ifdef XLETH_DEBUG
    if (v.onsetSample != 0)
        fprintf(stderr, "[ProcVoice] entry onset=%d numSamples=%d\n",
                v.onsetSample, numSamples);
#endif

    const int outChannels = out.getNumChannels();
    if (outChannels <= 0) return;

    const double srRatio = sourceSampleRate_ / engineSampleRate;
    const bool   usePitchEnv = pitchEnvEnabled_ && std::abs(pitchEnvAmount_) > 0.001f;

    static constexpr float kPi = 3.14159265358979323846f;

    // Trim end: smpStart_ + effective length, clamped to buffer bounds.
    const int64_t effEnd = smpStart_ +
        (smpLength_ > 0 ? smpLength_ : static_cast<int64_t>(nFrames) - smpStart_);
    const int64_t clampedEnd = std::min(effEnd, static_cast<int64_t>(nFrames));
    // Declick width (ms → samples at source rate), clamped so fades never overlap.
    const int declickN   = xleth::dsp::DeclickEnvelope::msToSamples(declickMs_, sourceSampleRate_);
    const int effDeclick = std::min(declickN,
        static_cast<int>((clampedEnd - smpStart_) / 2));

    // Effective loop end: if loopEnd_ == 0, treat as end of sample.
    const int64_t effLoopEnd = (loopEnd_ > 0)
        ? std::min<int64_t>(loopEnd_, nFrames)
        : static_cast<int64_t>(nFrames);
    const int64_t effLoopStart = std::min<int64_t>(loopStart_, effLoopEnd);
    const bool    useLoop      = crossfadeEnabled_ && loopEnabled_
                                  && effLoopEnd > effLoopStart;

    // Loop crossfade width. Clamp so:
    //  - the two ends can never overlap inside the loop
    //  - the fade-out read [loopEnd-N, loopEnd] stays inside the trim region
    //  - the fade-in source [loopStart, loopStart+N] stays inside the trim region
    int64_t effXfade = 0;
    if (useLoop && crossfadeSamples_ > 0) {
        effXfade = crossfadeSamples_;
        effXfade = std::min<int64_t>(effXfade, (effLoopEnd - effLoopStart) / 2);
        effXfade = std::min<int64_t>(effXfade, effLoopEnd   - smpStart_);
        effXfade = std::min<int64_t>(effXfade, clampedEnd   - effLoopStart);
        if (effXfade < 0) effXfade = 0;
    }
    const double  xfadeStart = static_cast<double>(effLoopEnd - effXfade);

    // Inline interpolated read helper (no alloc, audio-thread safe).
    // 4-point cubic Hermite — dramatically reduces aliasing artifacts
    // that become audible when pitch LFO modulates stride.
    auto readInterp = [&](double pos, int srcCh) -> float {
        const int i0 = static_cast<int>(pos);
        if (i0 < 0 || i0 >= nFrames) return 0.0f;
        const float f = static_cast<float>(pos - i0);

        auto clampGet = [&](int idx) -> float {
            if (idx < 0) idx = 0;
            else if (idx >= nFrames) idx = nFrames - 1;
            return sampleData_.getSample(srcCh, idx);
        };

        const float ym1 = clampGet(i0 - 1);
        const float y0  = clampGet(i0);
        const float y1  = clampGet(i0 + 1);
        const float y2  = clampGet(i0 + 2);

        const float c0 = y0;
        const float c1 = 0.5f * (y1 - ym1);
        const float c2 = ym1 - 2.5f * y0 + 2.0f * y1 - 0.5f * y2;
        const float c3 = 0.5f * (y2 - ym1) + 1.5f * (y0 - y1);

        return ((c3 * f + c2) * f + c1) * f + c0;
    };

    for (int s = v.onsetSample; s < numSamples; ++s)
    {
#ifdef XLETH_DEBUG
        if (v.onsetSample != 0 && s == v.onsetSample) {
            fprintf(stderr, "[VoiceWrite] first_s=%d numSamples=%d playPos=%f\n",
                    s, numSamples, v.playPosition);
        }
#endif
        // Deferred release: transition to Release at the scheduled sub-buffer sample.
        // Must run before advanceEnvelope so the Release stage takes effect on sample s.
        if (v.releaseSample >= 0 && s >= v.releaseSample) {
            v.envStage       = Voice::EnvStage::Release;
            v.envPosition    = 0.0;
            v.pitchEnvStage    = Voice::EnvStage::Release;
            v.pitchEnvPosition = 0.0;
            v.releaseSample  = -1;
        }

        const float envGain = advanceEnvelope(v, engineSampleRate);

        // ── Envelope Controller per-voice gain (EVC.6) ───────────────────────
        // An additional per-voice gain multiplier on top of (never replacing) the
        // region AHDSR (envGain), velocity, fades, declick and LFO stages.
        // Advanced in lockstep with the region envelope (same per-sample cadence).
        // The gate is this voice's note duration: capture it the first sample the
        // voice is in Release (gate end — the deferred noteOff already set Release
        // above), then evaluate the EVC AHDSR closed-form (EVC.4b) from
        // elapsed/gate. Each EVC curve is independent and the levels are multiplied
        // — never combined across voices. evcCount_ == 0 (chain mode / no envelope)
        // leaves evcGain == 1.0, a transparent no-op.
        float evcGain = 1.0f;
        if (evcCount_ > 0)
        {
            if (v.evcGateSamples < 0.0 && v.envStage == Voice::EnvStage::Release)
                v.evcGateSamples = v.evcElapsedSamples;

            const double elapsedMs = v.evcElapsedSamples * 1000.0 / engineSampleRate;
            // While held the gate is open: a huge gate keeps evaluation in the
            // Attack→Hold→Decay→Sustain branch until the real release is captured.
            const double gateMs = (v.evcGateSamples < 0.0)
                ? 1.0e12
                : v.evcGateSamples * 1000.0 / engineSampleRate;
            for (int i = 0; i < evcCount_; ++i)
            {
                const EnvelopeAhdsrState es =
                    evaluateEnvelopeAhdsr(evcSettings_[i], elapsedMs, gateMs);
                evcGain *= static_cast<float>(es.normalizedLevel);
            }
            v.evcElapsedSamples += 1.0;
        }

        // ── FL-STYLE GROUP SLIDE (overrides portamento; updates currentPitchF) ─
        // Modulates the voice's base pitch directly. Pitch envelope and pitch
        // LFO continue to add semitones below as additive modulation layers,
        // so they are NOT baked into the slide curve. The sub-buffer gate
        // (slideOnsetSample) defers slide stepping until the slide-note's
        // sample-offset within this buffer; on subsequent buffers it is reset
        // to 0 and becomes vacuously true.
        if (v.slideActive && s >= v.slideOnsetSample) {
            if (v.slideDurationSamples <= 0.0) {
                v.currentPitchF = v.slideTargetPitchF;
                v.slideActive   = false;
            } else {
                const double t = v.slideElapsedSamples / v.slideDurationSamples;
                if (t >= 1.0) {
                    v.currentPitchF = v.slideTargetPitchF;
                    v.slideActive   = false;
                } else {
                    const float eased = bezierEase(static_cast<float>(t),
                                                   v.slideCurveCx, v.slideCurveCy);
                    v.currentPitchF = v.slideSourcePitchF
                                    + (v.slideTargetPitchF - v.slideSourcePitchF)
                                      * static_cast<double>(eased);
                    v.slideElapsedSamples += 1.0;
                }
            }
        }
        // ── PORTAMENTO (updates currentPitchF only; skipped while sliding) ──
        else if (v.portamentoRemaining > 0.0) {
            const double step = (static_cast<double>(v.targetPitch) - v.currentPitchF)
                                / v.portamentoRemaining;
            v.currentPitchF += step;
            v.portamentoRemaining -= 1.0;
            if (v.portamentoRemaining <= 0.0) {
                v.currentPitchF = static_cast<double>(v.targetPitch);
                v.portamentoRemaining = 0.0;
            }
        }

        // ── COLLECT PITCH OFFSETS (semitones, independent) ───────────
        double pitchOffsetSemitones = 0.0;

        if (usePitchEnv) {
            const float pitchEnvGain = advancePitchEnvelope(v, engineSampleRate);
            pitchOffsetSemitones += static_cast<double>(pitchEnvAmount_) * pitchEnvGain;
        }

        const float lfoPitchMod = advanceLfo(lfoPitchConfig_, v.lfoPitchState, engineSampleRate);
        if (lfoPitchConfig_.enabled && std::abs(lfoPitchConfig_.amount) > 0.001f) {
            pitchOffsetSemitones += static_cast<double>(lfoPitchConfig_.amount) * lfoPitchMod;
        }

        // ── COMPUTE STRIDE FRESH (const — no reuse from previous sample)
        const double currentPitchRatio = std::pow(2.0, (v.currentPitchF - rootNote_) / 12.0);
        const double modulatedRatio = currentPitchRatio * std::pow(2.0, pitchOffsetSemitones / 12.0);
        const double stride = modulatedRatio * srRatio;

        // ── ADVANCE VOL/PAN LFOs ─────────────────────────────────────
        const float lfoVolMod  = advanceLfo(lfoVolConfig_,  v.lfoVolState,  engineSampleRate);
        const float lfoPanMod  = advanceLfo(lfoPanConfig_,  v.lfoPanState,  engineSampleRate);

        // End-of-sample / loop handling.
        if (useLoop)
        {
            if (v.playPosition >= static_cast<double>(effLoopEnd))
            {
                // FL-style wrap: the first `effXfade` samples of the loop
                // region are only heard as the crossfade's fade-in source,
                // so wrap past them to avoid content repetition.
                const double over = v.playPosition - static_cast<double>(effLoopEnd);
                v.playPosition = static_cast<double>(effLoopStart + effXfade) + over;
            }
        }
        else
        {
            // No loop: on reaching trim end, enter Release (if not already).
            if (v.playPosition >= static_cast<double>(clampedEnd - 1))
            {
                if (v.envStage != Voice::EnvStage::Release
                    && v.envStage != Voice::EnvStage::Off)
                {
                    v.envStage    = Voice::EnvStage::Release;
                    v.envPosition = 0.0;
                }
            }
        }

        // Bounds check — emit silence if playPosition is outside the buffer.
        {
            const int idx0 = static_cast<int>(v.playPosition);
            if (idx0 < 0 || idx0 >= nFrames)
            {
                if (v.envStage == Voice::EnvStage::Off) { v.active = false; return; }
                continue;
            }
        }

        // Hann-window declick at trim start and end (via shared LUT).
        float declickGain = 1.0f;
        if (effDeclick > 0)
        {
            const int posFromStart = static_cast<int>(v.playPosition - static_cast<double>(smpStart_));
            const int posFromEnd   = static_cast<int>(static_cast<double>(clampedEnd) - v.playPosition);
            declickGain = xleth::dsp::DeclickEnvelope::fadeIn(posFromStart, effDeclick)
                        * xleth::dsp::DeclickEnvelope::fadeOut(posFromEnd, effDeclick);
        }

        // Linear fade in/out (user-controlled, applied after declick).
        float fadeGain = 1.0f;
        if (fadeInMs_ > 0.0f)
        {
            const int64_t fadeInSamples = static_cast<int64_t>(fadeInMs_ * 0.001 * sourceSampleRate_);
            if (fadeInSamples > 0)
            {
                const int64_t relPos = static_cast<int64_t>(v.playPosition) - smpStart_;
                if (relPos < fadeInSamples)
                    fadeGain *= std::max(0.0f, static_cast<float>(relPos)
                                               / static_cast<float>(fadeInSamples));
            }
        }
        if (fadeOutMs_ > 0.0f)
        {
            const int64_t fadeOutSamples = static_cast<int64_t>(fadeOutMs_ * 0.001 * sourceSampleRate_);
            if (fadeOutSamples > 0)
            {
                const int64_t distFromEnd = clampedEnd - static_cast<int64_t>(v.playPosition);
                if (distFromEnd < fadeOutSamples)
                    fadeGain *= std::max(0.0f, static_cast<float>(distFromEnd)
                                               / static_cast<float>(fadeOutSamples));
            }
        }

        // Loop crossfade: blend current position with loop-start offset so the
        // wrap from loopEnd → loopStart is amplitude-matched.
        const bool inXfade = (effXfade > 0 && v.playPosition >= xfadeStart);
        float fadeOutX = 1.0f, fadeInX = 0.0f;
        double loopSrcPos = 0.0;
        if (inXfade)
        {
            float progress = static_cast<float>(
                (v.playPosition - xfadeStart) / static_cast<double>(effXfade));
            if (progress > 1.0f) progress = 1.0f;
            fadeOutX    = cosf(progress * kPi * 0.5f);
            fadeInX     = sinf(progress * kPi * 0.5f);
            loopSrcPos  = static_cast<double>(effLoopStart)
                        + (v.playPosition - xfadeStart);
        }

        // Volume LFO gain
        const float volLfoGain = lfoVolConfig_.enabled
            ? std::max(0.0f, 1.0f + lfoVolMod * lfoVolConfig_.amount) : 1.0f;

        // Panning LFO (equal-power stereo pan)
        float panL = 1.0f, panR = 1.0f;
        if (lfoPanConfig_.enabled && std::abs(lfoPanConfig_.amount) > 0.001f) {
            const float panOffset = lfoPanMod * lfoPanConfig_.amount; // -1..+1
            const float panAngle  = (panOffset + 1.0f) * 0.5f;       //  0..1
            panL = cosf(panAngle * kPi * 0.5f);
            panR = sinf(panAngle * kPi * 0.5f);
        }

        for (int ch = 0; ch < std::min(2, outChannels); ++ch)
        {
            const int srcCh = std::min(ch, nCh - 1);
            float sample = readInterp(v.playPosition, srcCh);
            if (inXfade)
            {
                const float loopStartSample = readInterp(loopSrcPos, srcCh);
                sample = sample * fadeOutX + loopStartSample * fadeInX;
            }
            const float panGain = (ch == 0) ? panL : panR;
            out.addSample(ch, s, sample * envGain * evcGain * v.velocity * declickGain * fadeGain * volLfoGain * panGain);
        }

        v.playPosition += stride;

        if (v.envStage == Voice::EnvStage::Off) { v.active = false; return; }
    }
#ifdef XLETH_DEBUG
    fprintf(stderr, "[VoiceExit] wrote_from=%d to=%d playPos=%f\n",
            v.onsetSample, numSamples - 1, v.playPosition);
#endif
    v.onsetSample      = 0;
    // Slide gate is sub-buffer only: if the slide started in this block, the
    // gate has already been honoured; subsequent blocks should not re-gate.
    v.slideOnsetSample = 0;
}


void Sampler::processBlock(juce::AudioBuffer<float>& outputBuffer,
                           int numSamples, double engineSampleRate)
{
    if (visualOnly_.load(std::memory_order_relaxed)) {
        outputBuffer.clear();
        return;
    }
    if (sampleData_.getNumSamples() <= 0) return;
    if (numSamples <= 0) return;
    if (engineSampleRate <= 0.0) return;

    // Arpeggiator: generate note events for this block before rendering voices.
    // Block-granular (same accuracy as pattern note triggering).
    if (arp_.enabled) {
        for (int s = 0; s < numSamples; ++s) {
            auto ev = arp_.processSample(engineSampleRate, bpm_);
            if (ev.noteOff) fireNoteOff(ev.noteOffPitch, 0, /*force=*/true);
            if (ev.noteOn)  fireNoteOn(ev.pitch, ev.velocity, s);
        }
    }

    for (auto& v : voices_)
    {
        if (!v.active) continue;
        processVoice(v, outputBuffer, numSamples, engineSampleRate);
    }
}
