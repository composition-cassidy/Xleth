#include "Sampler.h"
#include "dsp/DeclickEnvelope.h"
#include "../util/BezierEase.h"

#include <algorithm>
#include <cmath>
#include <limits>

// The modulation config declares its own slot ceiling so the model layer does
// not have to include TimelineTypes.h. They must never drift apart.
static_assert(xleth::sampmod::kMaxModSlots == MAX_SAMPLE_SLOTS,
              "kMaxModSlots must mirror MAX_SAMPLE_SLOTS");
static_assert(xleth::sampmod::kMaxMangleInstances == xleth::mangle::kMaxInstances,
              "kMaxMangleInstances must mirror xleth::mangle::kMaxInstances");

// ─── Slot configuration (main thread) ────────────────────────────────────────

void Sampler::setSlotCount(int count)
{
    const int clamped = std::clamp(count, 1, MAX_SAMPLE_SLOTS);
    // Dropped slots release their PCM so a later grow can't resurrect stale
    // audio under fresh settings.
    for (int i = clamped; i < MAX_SAMPLE_SLOTS; ++i)
        slots_[static_cast<size_t>(i)].reset();
    slotCount_ = clamped;
    refreshSoloCache();
}

void Sampler::loadSlotSample(int slotIndex,
                             const juce::AudioBuffer<float>& audioData,
                             double sourceSampleRate, int rootNote)
{
    if (slotIndex < 0 || slotIndex >= MAX_SAMPLE_SLOTS) return;
    auto& s = slots_[static_cast<size_t>(slotIndex)];
    // Own a private copy: the caller's buffer is a working copy that dies when
    // buildSamplerForRegion returns. Loading a raw sample also drops any PREP
    // buffer left from the previous audio — the bake that produced it was keyed
    // to PCM this slot no longer holds.
    auto owned = std::make_shared<juce::AudioBuffer<float>>();
    owned->makeCopyOf(audioData, true);
    s.raw = owned;
    s.publish(owned);
    s.sourceSampleRate = (sourceSampleRate > 0.0) ? sourceSampleRate : 48000.0;
    s.rootNote         = rootNote;
    if (slotIndex >= slotCount_) slotCount_ = slotIndex + 1;
}

void Sampler::setSlotPreparedBuffer(int slotIndex,
                                    std::shared_ptr<const juce::AudioBuffer<float>> prepared)
{
    if (slotIndex < 0 || slotIndex >= MAX_SAMPLE_SLOTS) return;
    auto& s = slots_[static_cast<size_t>(slotIndex)];
    // nullptr = PREP cleared / bypassed → fall back to the raw sample.
    s.publish(prepared ? prepared : s.raw);
}

void Sampler::clearSlotSample(int slotIndex)
{
    if (slotIndex < 0 || slotIndex >= MAX_SAMPLE_SLOTS) return;
    auto& s = slots_[static_cast<size_t>(slotIndex)];
    s.publish(nullptr);
    s.raw.reset();
}

void Sampler::setSlotTuning(int slotIndex, int octave, int semitone,
                            float fineCents, int coarse)
{
    if (slotIndex < 0 || slotIndex >= MAX_SAMPLE_SLOTS) return;
    // Same summation as SampleSlot::tuningSemitones() — keep the two in step.
    slots_[static_cast<size_t>(slotIndex)].tuningSemitones =
          static_cast<double>(std::clamp(octave,   -4,  4)) * 12.0
        + static_cast<double>(std::clamp(semitone, -12, 12))
        + static_cast<double>(std::clamp(coarse,   -48, 48))
        + static_cast<double>(std::clamp(fineCents, -100.0f, 100.0f)) / 100.0;
}

void Sampler::setSlotLevel(int slotIndex, float volume, float pan)
{
    if (slotIndex < 0 || slotIndex >= MAX_SAMPLE_SLOTS) return;
    auto& s = slots_[static_cast<size_t>(slotIndex)];
    s.volume = std::clamp(volume, 0.0f, 2.0f);
    s.pan    = std::clamp(pan,   -1.0f, 1.0f);
}

void Sampler::setSlotMuteSolo(int slotIndex, bool mute, bool solo)
{
    if (slotIndex < 0 || slotIndex >= MAX_SAMPLE_SLOTS) return;
    auto& s = slots_[static_cast<size_t>(slotIndex)];
    s.mute = mute;
    s.solo = solo;
    refreshSoloCache();
}

void Sampler::setSlotTrim(int slotIndex, int64_t smpStart, int64_t smpLength,
                          float declickMs, float fadeInMs, float fadeOutMs)
{
    if (slotIndex < 0 || slotIndex >= MAX_SAMPLE_SLOTS) return;
    auto& s = slots_[static_cast<size_t>(slotIndex)];
    s.smpStart  = std::max<int64_t>(0, smpStart);
    s.smpLength = std::max<int64_t>(0, smpLength);
    s.declickMs = std::max(0.0f, declickMs);
    s.fadeInMs  = std::max(0.0f, fadeInMs);
    s.fadeOutMs = std::max(0.0f, fadeOutMs);
}

void Sampler::setSlotLoop(int slotIndex, bool loopEnabled, int64_t loopStart,
                          int64_t loopEnd, int64_t crossfadeSamples,
                          int loopMode, bool exitLoopOnRelease)
{
    if (slotIndex < 0 || slotIndex >= MAX_SAMPLE_SLOTS) return;
    auto& s = slots_[static_cast<size_t>(slotIndex)];
    s.loopEnabled      = loopEnabled;
    s.loopStart        = std::max<int64_t>(0, loopStart);
    s.loopEnd          = std::max<int64_t>(0, loopEnd);
    s.crossfadeSamples = std::max<int64_t>(0, crossfadeSamples);
    // An out-of-range mode falls back to Forward rather than indexing off the
    // end of the enum — a malformed project must not change how audio reads.
    s.loopMode = (loopMode >= static_cast<int>(SampleLoopMode::Forward)
               && loopMode <= static_cast<int>(SampleLoopMode::Reverse))
               ? loopMode : static_cast<int>(SampleLoopMode::Forward);
    s.exitLoopOnRelease = exitLoopOnRelease;
}

void Sampler::setSlotRootNote(int slotIndex, int rootNote)
{
    if (slotIndex < 0 || slotIndex >= MAX_SAMPLE_SLOTS) return;
    slots_[static_cast<size_t>(slotIndex)].rootNote = rootNote;
}

void Sampler::setSlotMangleChain(int slotIndex,
                                 const std::vector<xleth::mangle::InstanceConfig>& chain)
{
    if (slotIndex < 0 || slotIndex >= MAX_SAMPLE_SLOTS) return;
    auto& s = slots_[static_cast<size_t>(slotIndex)];

    // Build the immutable config on the main thread. Instances are copied in
    // chain order and clamped; ids are validated the same way setSlotLoop
    // guards its mode — an unknown id is a malformed project, and the safe
    // answer is "no effect", not "some other effect".
    auto cfg = std::make_shared<xleth::mangle::ChainConfig>();
    int n = 0;
    for (const auto& in : chain) {
        if (n >= xleth::mangle::kMaxInstances) break;
        auto& d = cfg->inst[static_cast<size_t>(n)];
        d.mode   = xleth::mangle::isValidMode(in.mode) ? in.mode : 0;
        d.amount = std::clamp(in.amount, 0.0f, 1.0f);
        d.mix    = std::clamp(in.mix,    0.0f, 1.0f);
        d.bypass = in.bypass;
        ++n;
    }
    cfg->count = n;

    // An empty chain publishes null — the audio thread's fast bypass path.
    if (n == 0) { s.publishMangle(nullptr); return; }
    s.publishMangle(std::move(cfg));
}

void Sampler::setSlotMangle(int slotIndex, int mode, float amount, float mix)
{
    // A single MANGLE is a one-instance chain — exactly the legacy shape, so
    // single-sample callers and the test suite are unchanged.
    setSlotMangleChain(slotIndex,
                       { xleth::mangle::InstanceConfig{ mode, amount, mix, false } });
}

bool Sampler::slotHasAudio(int slotIndex) const
{
    if (slotIndex < 0 || slotIndex >= slotCount_) return false;
    return slots_[static_cast<size_t>(slotIndex)].hasAudio();
}

bool Sampler::slotSounds(int slotIndex) const
{
    if (slotIndex < 0 || slotIndex >= slotCount_) return false;
    const auto& s = slots_[static_cast<size_t>(slotIndex)];
    if (!s.hasAudio()) return false;
    // Solo wins over mute: once anything is solo'd, only solo'd slots sound
    // regardless of their own mute flag (mixer semantics).
    if (anySolo_) return s.solo;
    return !s.mute;
}

void Sampler::refreshSoloCache()
{
    anySolo_ = false;
    for (int i = 0; i < slotCount_; ++i)
        if (slots_[static_cast<size_t>(i)].solo) { anySolo_ = true; return; }
}

bool Sampler::hasSample() const
{
    for (int i = 0; i < slotCount_; ++i)
        if (slots_[static_cast<size_t>(i)].hasAudio()) return true;
    return false;
}

int Sampler::activeStreamCount() const
{
    int n = 0;
    for (const auto& v : voices_) {
        if (!v.active) continue;
        for (int i = 0; i < v.numStreams; ++i)
            if (v.streams[static_cast<size_t>(i)].active) ++n;
    }
    return n;
}

// ─── Configuration (main thread) ─────────────────────────────────────────────

void Sampler::loadSample(const juce::AudioBuffer<float>& audioData,
                         double sourceSampleRate, int rootNote)
{
    loadSlotSample(0, audioData, sourceSampleRate, rootNote);
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


void Sampler::setCrossfadeMode(bool enabled)
{
    crossfadeEnabled_ = enabled;
}

// ── Slot-0 aliases ──────────────────────────────────────────────────────────
// Per-slot state lives on the slots; these forward to slot 0 so single-sample
// callers keep working verbatim.

void Sampler::setLoopPoints(bool enabled, int64_t loopStart, int64_t loopEnd)
{
    auto& s = slots_[0];
    s.loopEnabled = enabled;
    s.loopStart   = std::max<int64_t>(0, loopStart);
    s.loopEnd     = std::max<int64_t>(0, loopEnd);
}

void Sampler::setRootNote(int note)      { slots_[0].rootNote  = note; }
void Sampler::setSmpStart(int64_t start) { slots_[0].smpStart  = std::max<int64_t>(0, start); }
void Sampler::setSmpLength(int64_t len)  { slots_[0].smpLength = std::max<int64_t>(0, len); }
void Sampler::setDeclickMs(float ms)     { slots_[0].declickMs = std::max(0.0f, ms); }
void Sampler::setFadeIn(float ms)        { slots_[0].fadeInMs  = std::max(0.0f, ms); }
void Sampler::setFadeOut(float ms)       { slots_[0].fadeOutMs = std::max(0.0f, ms); }

void Sampler::setCrossfadeSamples(int64_t samples)
{
    slots_[0].crossfadeSamples = std::max<int64_t>(0, samples);
}

void Sampler::setMonoMode(bool enabled)
{
    monoEnabled_ = enabled;
}

void Sampler::setPortamento(bool enabled, float timeMs, int mode, float curve)
{
    portamentoEnabled_ = enabled;
    portamentoTimeMs_  = std::max(0.0f, timeMs);
    portamentoMode_    = (mode == 1) ? 1 : 0;
    portamentoCurve_   = std::clamp(curve, -1.0f, 1.0f);
}

void Sampler::setVoiceCount(int count)
{
    voiceCount_ = std::clamp(count, 1, MAX_VOICES);
}

void Sampler::setLegato(bool enabled)
{
    legatoEnabled_ = enabled;
}

// ─── Portamento geometry ────────────────────────────────────────────────────
// ALWAYS spends portamentoTimeMs on every glide; SCALED spends it per OCTAVE,
// so a semitone step takes a twelfth of the time a full octave does and the
// glide RATE is what stays constant.
//
// The rate is expressed against slot 0's source rate for the same reason the
// original implementation did: portamentoRemaining counts down once per
// rendered sample, so the two must agree on what a "sample" is.
double Sampler::portamentoSamplesFor(double semitones) const
{
    if (!portamentoEnabled_) return 0.0;
    const double interval = std::abs(semitones);
    if (interval < 1.0e-9) return 0.0;

    double ms = static_cast<double>(portamentoTimeMs_);
    if (portamentoMode_ == 1) ms *= interval / 12.0;
    if (ms <= 0.0) return 0.0;

    return ms * 0.001 * slots_[0].sourceSampleRate;
}

void Sampler::beginPortamento(Voice& v, int target)
{
    const double samples =
        portamentoSamplesFor(static_cast<double>(target) - v.currentPitchF);

    v.targetPitch = target;
    if (samples <= 0.0) {
        // No glide: land immediately. Clearing `total` as well keeps the
        // shaped-interpolation branch in processVoice inert.
        v.currentPitchF       = static_cast<double>(target);
        v.portamentoRemaining = 0.0;
        v.portamentoTotal     = 0.0;
        return;
    }

    v.portamentoSourceF   = v.currentPitchF;
    v.portamentoTotal     = samples;
    v.portamentoRemaining = samples;
}

// ─── Voice budget ───────────────────────────────────────────────────────────
// The NOTE-count twin of enforceStreamBudget, and deliberately the same rule:
// oldest held note first, released rather than hard-killed, releasing notes
// excluded from the count because they are a draining tail rather than a
// sustaining cost. Running both means whichever cap binds first does the
// stealing, and they can never disagree about the victim.
void Sampler::enforceVoiceBudget()
{
    auto heldNotes = [this]() {
        int n = 0;
        for (const auto& v : voices_) {
            if (!v.active || !v.noteHeld) continue;
            if (v.envStage == Voice::EnvStage::Release
                || v.envStage == Voice::EnvStage::Off) continue;
            ++n;
        }
        return n;
    };

    while (heldNotes() + 1 > voiceCount_)
    {
        Voice* oldest = nullptr;
        for (auto& v : voices_)
        {
            if (!v.active || !v.noteHeld) continue;
            if (v.envStage == Voice::EnvStage::Release
                || v.envStage == Voice::EnvStage::Off) continue;
            if (oldest == nullptr || v.spawnCounter < oldest->spawnCounter)
                oldest = &v;
        }
        // Everything left is already releasing: let the new note through
        // rather than dropping it, exactly as the stream budget does.
        if (oldest == nullptr) return;
        releaseVoice(*oldest);
    }
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
    // A tempo-synced amp envelope (ENV 1 in BPM mode) scales with the tempo, so
    // re-derive its milliseconds whenever the tempo moves.
    applyAmpEnvFromMod_();
}

// Amp DAHDSR ← modulation ENV 1. ENV 1 is the amplitude envelope's home now that
// the per-region amp scalars are gone; its ModTimes convert to ms at bpm_.
void Sampler::applyAmpEnvFromMod_()
{
    const xleth::sampmod::ModEnvConfig& e = modConfig_.envs[0];
    const bool sync = e.tempoSync;
    auto ms = [&](const xleth::sampmod::ModTime& t) {
        return static_cast<float>(xleth::sampmod::modTimeSeconds(t, sync, bpm_) * 1000.0);
    };
    setEnvelope(ms(e.delay), ms(e.attack), ms(e.hold), ms(e.decay),
                e.sustainPct * 0.01f, ms(e.release),
                e.attackTension, e.decayTension, e.releaseTension);
}

// ─── Modulation system — publication (main thread) ───────────────────────────

void Sampler::setModulation(const xleth::sampmod::ModConfig& cfg)
{
    modConfig_ = cfg;

    // ENV 1 (envs[0]) is the amplitude envelope — re-derive the VCA DAHDSR from
    // it on every config change so editing ENV 1 in the tray is audible.
    applyAmpEnvFromMod_();

    // An empty route list publishes a NULL graph rather than an inert one, so
    // the audio thread's bypass is a single null pointer test — no scan over
    // fourteen sources that would all resolve to nothing.
    if (cfg.isBypassed()) {
        auto prev = modGraph_.exchange(nullptr, std::memory_order_acq_rel);
        if (prev) {
            modGraphRetired_[static_cast<size_t>(modGraphRetiredNext_)] = std::move(prev);
            modGraphRetiredNext_ = (modGraphRetiredNext_ + 1) % kModGraphRetained;
        }
        return;
    }

    auto compiled = std::make_shared<xleth::sampmod::CompiledModGraph>();
    xleth::sampmod::compileModGraph(cfg, *compiled);

    // Publish, then retain what was there. A voice that is mid-block still
    // holds the old graph through its own shared_ptr; keeping the last few
    // published graphs alive on the MAIN thread guarantees the final release
    // never lands on the audio thread. Same reasoning as Slot::publish.
    auto prev = modGraph_.exchange(
        ModGraphPtr(std::const_pointer_cast<const xleth::sampmod::CompiledModGraph>(compiled)),
        std::memory_order_acq_rel);
    if (prev) {
        modGraphRetired_[static_cast<size_t>(modGraphRetiredNext_)] = std::move(prev);
        modGraphRetiredNext_ = (modGraphRetiredNext_ + 1) % kModGraphRetained;
    }
}

// ─── Modulation system — global (FREE / MONO) sources ────────────────────────
//
// Runs once per processBlock, before any voice. Advances the shared bank over
// every control block this buffer spans and caches each block's values, so all
// voices in the buffer read the same instance at the same point in time.

void Sampler::advanceGlobalModulation(const xleth::sampmod::CompiledModGraph& g,
                                      int numSamples, double engineSampleRate)
{
    namespace sm = xleth::sampmod;
    const double dt = static_cast<double>(sm::kControlBlockSamples) / engineSampleRate;

    // ── Transport anchoring for FREE sources ─────────────────────────────────
    // A FREE instance "runs for the timeline", so a SEEK must move it. A seek
    // shows up as an absolute position that matches neither the contiguous
    // continuation of the last buffer nor the last position we saw (which is
    // how a preview render — where the position never moves at all — is told
    // apart from a real jump, so previews do not re-anchor every buffer).
    if (modAbsSeen_
        && currentAbsSample_ != modExpectedAbs_
        && currentAbsSample_ != modLastAbs_)
    {
        const double posSec = static_cast<double>(currentAbsSample_) / engineSampleRate;
        for (int l = 0; l < sm::kNumLfos; ++l) {
            const int k = sm::kLfoSource0 + l;
            if (!g.isGlobal[static_cast<size_t>(k)]) continue;
            if (g.cfg.lfos[static_cast<size_t>(l)].behavior
                != static_cast<int>(sm::LfoBehavior::Free)) continue;

            const auto& c = g.cfg.lfos[static_cast<size_t>(l)];
            double rate;
            if (c.tempoSync) {
                const double period = sm::modTimeSeconds(c.syncRate, true, bpm_);
                rate = (period > 1.0e-9) ? (1.0 / period) : 1.0;
            } else {
                rate = static_cast<double>(c.rateHz);
            }
            rate = std::clamp(rate, 1.0e-4, 400.0);

            auto& st = modGlobalBank_.lfos[static_cast<size_t>(l)];
            st.phase      = posSec * rate;
            st.phase     -= std::floor(st.phase);
            st.elapsedSec = posSec;
            st.done       = false;
        }
    }
    modLastAbs_     = currentAbsSample_;
    modExpectedAbs_ = currentAbsSample_ + numSamples;
    modAbsSeen_     = true;

    // ── Advance one control block per block this buffer covers ───────────────
    const int64_t firstBlock = modSampleClock_ / sm::kControlBlockSamples;
    const int64_t lastBlock  = (modSampleClock_ + numSamples - 1) / sm::kControlBlockSamples;
    const int     nBlocks    = static_cast<int>(
        std::min<int64_t>(lastBlock - firstBlock + 1, kMaxCtrlBlocksPerBuffer));

    modCacheFirstBlock_    = firstBlock;
    modCacheCount_         = nBlocks;
    modBufferStartClock_   = modSampleClock_;

    for (int b = 0; b < nBlocks; ++b)
    {
        // A buffer that does not start on a control-block boundary re-enters
        // the block the previous buffer already advanced. Advancing it again
        // would run the global sources fast, so it is only re-cached.
        const int64_t blockIdx = firstBlock + b;
        if (blockIdx >= modBlocksDone_) {
            sm::modBankSnapshot(modGlobalBank_);
            // Per-voice sources a global source depends on: read the newest
            // voice's snapshot. Always one control block old, exactly as the
            // cycle rule documents.
            for (int k = 0; k < sm::kNumSources; ++k) {
                if (g.isGlobal[static_cast<size_t>(k)]) continue;
                modGlobalBank_.value[static_cast<size_t>(k)] =
                    modLatestVoiceValue_[static_cast<size_t>(k)];
                modGlobalBank_.amount[static_cast<size_t>(k)] =
                    modLatestVoiceAmount_[static_cast<size_t>(k)];
            }
            sm::advanceModBank(g, modGlobalBank_, /*evalGlobal=*/true, bpm_, dt);
            modBlocksDone_ = blockIdx + 1;
        }
        modGlobalCacheValue_[static_cast<size_t>(b)]  = modGlobalBank_.value;
        modGlobalCacheAmount_[static_cast<size_t>(b)] = modGlobalBank_.amount;
    }

    modSampleClock_ += numSamples;
}

// ─── Modulation system — one voice, one control block ────────────────────────

void Sampler::evaluateVoiceModulation(Voice& v,
                                      const xleth::sampmod::CompiledModGraph& g,
                                      int sampleInBuffer, double engineSampleRate)
{
    namespace sm = xleth::sampmod;
    const double dt = static_cast<double>(sm::kControlBlockSamples) / engineSampleRate;

    sm::modBankSnapshot(v.modBank);

    // Pull the global instances' values for this point in the buffer. Clamped
    // rather than wrapped: a buffer longer than the cache simply holds the last
    // cached block, which degrades the control rate but never reads garbage.
    if (modCacheCount_ > 0) {
        const int64_t clk = modBufferStartClock_ + sampleInBuffer;
        int ci = static_cast<int>(clk / sm::kControlBlockSamples - modCacheFirstBlock_);
        ci = std::clamp(ci, 0, modCacheCount_ - 1);
        const auto& gv = modGlobalCacheValue_[static_cast<size_t>(ci)];
        const auto& ga = modGlobalCacheAmount_[static_cast<size_t>(ci)];
        for (int k = 0; k < sm::kNumSources; ++k) {
            if (!g.isGlobal[static_cast<size_t>(k)]) continue;
            v.modBank.value[static_cast<size_t>(k)]  = gv[static_cast<size_t>(k)];
            v.modBank.amount[static_cast<size_t>(k)] = ga[static_cast<size_t>(k)];
        }
    }

    sm::advanceModBank(g, v.modBank, /*evalGlobal=*/false, bpm_, dt);
    sm::accumulateModOffsets(g, v.modBank, v.modOffsets);

    // Publish this voice's per-voice sources for any route feeding a global
    // source, newest voice wins.
    if (v.spawnCounter >= modLatestVoiceSpawn_) {
        modLatestVoiceSpawn_ = v.spawnCounter;
        for (int k = 0; k < sm::kNumSources; ++k) {
            if (g.isGlobal[static_cast<size_t>(k)]) continue;
            modLatestVoiceValue_[static_cast<size_t>(k)]  = v.modBank.value[static_cast<size_t>(k)];
            modLatestVoiceAmount_[static_cast<size_t>(k)] = v.modBank.amount[static_cast<size_t>(k)];
        }
    }

    // ── Resolve the parameters the render loop reads directly ────────────────
    static constexpr float kPiF = 3.14159265358979323846f;
    static constexpr float kSqrt2 = 1.41421356237f;

    v.modMasterGain = sm::applyTargetLaw(
        static_cast<int>(sm::ModTarget::MasterVolume), 1.0f, v.modOffsets.masterVolume);

    const float masterPan = g.masterPanRouted
        ? sm::applyTargetLaw(static_cast<int>(sm::ModTarget::MasterPan), 0.0f,
                             v.modOffsets.masterPan)
        : 0.0f;

    for (int i = 0; i < slotCount_; ++i)
    {
        if (!g.slotPanRouted[static_cast<size_t>(i)] && !g.masterPanRouted) continue;
        const float base = slots_[static_cast<size_t>(i)].pan;
        const float p = std::clamp(base + v.modOffsets.pan[static_cast<size_t>(i)] + masterPan,
                                   -1.0f, 1.0f);
        const float angle = (p + 1.0f) * 0.5f;
        v.modPanL[static_cast<size_t>(i)] = kSqrt2 * std::cos(angle * kPiF * 0.5f);
        v.modPanR[static_cast<size_t>(i)] = kSqrt2 * std::sin(angle * kPiF * 0.5f);
    }
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
    // Releasing at note level releases ALL of that note's layers together —
    // there is no path that leaves one layer of a note sounding on its own.
    for (auto& v : voices_)
    {
        if (!v.active) continue;
        if (v.envStage == Voice::EnvStage::Off) continue;  // already dead
        releaseVoice(v);
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
        releaseVoice(v);
    }
}

// Hand one note to its release envelope. Envelope continuity (capturing
// envLevel into releaseStartLevel) is what keeps this click-free, which is why
// stealing uses it rather than clearing `active`.
void Sampler::releaseVoice(Voice& v)
{
    v.noteHeld          = false;
    v.releaseStartLevel = v.envLevel;
    v.envStage          = Voice::EnvStage::Release;
    v.envPosition       = 0.0;
    // The modulation envelopes release with the amplitude envelope. Static, so
    // it takes no graph — the bank always exists on the voice.
    xleth::sampmod::modReleaseVoice(v.modBank);
}

bool Sampler::armExitLoopTail(Voice& v)
{
    // Only streams that are ACTUALLY looping right now matter: a layer that
    // already ran past its loop, or never had one, imposes no condition and
    // needs no tail.
    int looping = 0;
    int optedIn = 0;
    for (int i = 0; i < v.numStreams; ++i) {
        const auto& st = v.streams[static_cast<size_t>(i)];
        if (!st.active || st.finished || st.loopLeft) continue;
        const Slot& sl = slots_[static_cast<size_t>(st.slotIndex)];
        const int64_t effLoopEnd   = (sl.loopEnd > 0) ? sl.loopEnd : 0;
        const bool    hasLoopRange = (effLoopEnd == 0) || (effLoopEnd > sl.loopStart);
        if (!(crossfadeEnabled_ && sl.loopEnabled && hasLoopRange)) continue;
        ++looping;
        if (sl.exitLoopOnRelease) ++optedIn;
    }
    // No loop to exit, or a mixed note — fall back to the ordinary release.
    // Arming a mixed note would leave the non-opted layer looping forever with
    // no release queued to end it.
    if (looping == 0 || optedIn != looping) return false;

    for (int i = 0; i < v.numStreams; ++i) {
        auto& st = v.streams[static_cast<size_t>(i)];
        if (!st.active || st.finished || st.loopLeft) continue;
        st.exiting = true;
    }
    return true;
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

int Sampler::debugVoiceStreamCount(int voiceIdx) const
{
    if (voiceIdx < 0 || voiceIdx >= MAX_VOICES) return 0;
    const Voice& v = voices_[static_cast<size_t>(voiceIdx)];
    if (!v.active) return 0;
    int n = 0;
    for (int i = 0; i < v.numStreams; ++i)
        if (v.streams[static_cast<size_t>(i)].active) ++n;
    return n;
}

int Sampler::debugVoiceStreamSlot(int voiceIdx, int streamIdx) const
{
    if (voiceIdx < 0 || voiceIdx >= MAX_VOICES) return -1;
    const Voice& v = voices_[static_cast<size_t>(voiceIdx)];
    if (streamIdx < 0 || streamIdx >= v.numStreams) return -1;
    const auto& st = v.streams[static_cast<size_t>(streamIdx)];
    return st.active ? st.slotIndex : -1;
}

int Sampler::debugSlotMangleCount(int slotIndex) const
{
    if (slotIndex < 0 || slotIndex >= MAX_SAMPLE_SLOTS) return 0;
    const auto chain = slots_[static_cast<size_t>(slotIndex)]
                           .mangleChain.load(std::memory_order_acquire);
    return chain ? chain->count : 0;
}

// ─── Modulation introspection (test-only) ────────────────────────────────────

float Sampler::debugModVoiceSource(int voiceIdx, int sourceIdx) const
{
    if (voiceIdx < 0 || voiceIdx >= MAX_VOICES) return 0.0f;
    if (sourceIdx < 0 || sourceIdx >= xleth::sampmod::kNumSources) return 0.0f;
    return voices_[static_cast<size_t>(voiceIdx)]
               .modBank.value[static_cast<size_t>(sourceIdx)];
}

float Sampler::debugModGlobalSource(int sourceIdx) const
{
    if (sourceIdx < 0 || sourceIdx >= xleth::sampmod::kNumSources) return 0.0f;
    return modGlobalBank_.value[static_cast<size_t>(sourceIdx)];
}

float Sampler::debugModVoiceSlotSemis(int voiceIdx, int slotIdx) const
{
    if (voiceIdx < 0 || voiceIdx >= MAX_VOICES) return 0.0f;
    if (slotIdx < 0 || slotIdx >= MAX_SAMPLE_SLOTS) return 0.0f;
    return voices_[static_cast<size_t>(voiceIdx)]
               .modOffsets.semis[static_cast<size_t>(slotIdx)];
}

float Sampler::debugModVoiceSlotVolume(int voiceIdx, int slotIdx) const
{
    if (voiceIdx < 0 || voiceIdx >= MAX_VOICES) return 0.0f;
    if (slotIdx < 0 || slotIdx >= MAX_SAMPLE_SLOTS) return 0.0f;
    return std::clamp(slots_[static_cast<size_t>(slotIdx)].volume
                      + voices_[static_cast<size_t>(voiceIdx)]
                            .modOffsets.volume[static_cast<size_t>(slotIdx)],
                      0.0f, 2.0f);
}

float Sampler::debugModVoiceSlotPan(int voiceIdx, int slotIdx) const
{
    if (voiceIdx < 0 || voiceIdx >= MAX_VOICES) return 0.0f;
    if (slotIdx < 0 || slotIdx >= MAX_SAMPLE_SLOTS) return 0.0f;
    return std::clamp(slots_[static_cast<size_t>(slotIdx)].pan
                      + voices_[static_cast<size_t>(voiceIdx)]
                            .modOffsets.pan[static_cast<size_t>(slotIdx)],
                      -1.0f, 1.0f);
}

float Sampler::debugModVoiceMasterVolume(int voiceIdx) const
{
    if (voiceIdx < 0 || voiceIdx >= MAX_VOICES) return 1.0f;
    return voices_[static_cast<size_t>(voiceIdx)].modMasterGain;
}

int Sampler::debugModEvalPosition(int sourceIdx) const
{
    const ModGraphPtr g = modGraph_.load(std::memory_order_acquire);
    if (!g || sourceIdx < 0 || sourceIdx >= xleth::sampmod::kNumSources) return -1;
    return g->evalPos[static_cast<size_t>(sourceIdx)];
}

bool Sampler::debugModRouteDeferred(int routeIdx) const
{
    const ModGraphPtr g = modGraph_.load(std::memory_order_acquire);
    if (!g || routeIdx < 0 || routeIdx >= g->numRoutes) return false;
    return g->routes[static_cast<size_t>(routeIdx)].deferred;
}

bool Sampler::debugModHasCycle() const
{
    const ModGraphPtr g = modGraph_.load(std::memory_order_acquire);
    return g && g->anyCycle;
}

int Sampler::debugModEnvStage(int voiceIdx, int envIdx) const
{
    if (voiceIdx < 0 || voiceIdx >= MAX_VOICES) return -1;
    if (envIdx < 0 || envIdx >= xleth::sampmod::kNumEnvs) return -1;
    return voices_[static_cast<size_t>(voiceIdx)]
               .modBank.envs[static_cast<size_t>(envIdx)].stage;
}

// ─── Voice allocation ────────────────────────────────────────────────────────

// ─── Stream allocation ───────────────────────────────────────────────────────

int Sampler::soundingSlotCount() const
{
    int n = 0;
    for (int i = 0; i < slotCount_; ++i)
        if (slotSounds(i)) ++n;
    return n;
}

void Sampler::armStreams(Voice& v)
{
    // Bind one stream per sounding slot, each starting at its own trim start.
    // Slots that are silent right now (no audio, muted, or not solo'd while
    // something else is) simply get no stream — toggling mute/solo therefore
    // affects the NEXT note, not notes already sounding.
    v.numStreams = 0;
    for (int i = 0; i < slotCount_ && v.numStreams < MAX_SAMPLE_SLOTS; ++i)
    {
        if (!slotSounds(i)) continue;
        auto& st = v.streams[static_cast<size_t>(v.numStreams++)];
        st.active       = true;
        st.slotIndex    = i;
        st.playPosition = static_cast<double>(slots_[static_cast<size_t>(i)].smpStart);
        st.finished     = false;
        // Every stream enters forward, whatever the loop mode: Reverse and
        // PingPong only flip direction once the head first reaches loopEnd, so
        // the pre-loop region always plays in order.
        st.dir          = 1;
        st.exiting      = false;
        st.loopLeft     = false;
        // Filter integrators, DC blockers and the note-cycle anchor all start
        // from zero for every chain instance, so a recycled stream cannot leak
        // the previous note's MANGLE state into this one as a transient.
        for (auto& m : st.mangle) m.reset();
    }
    // Clear the tail so a recycled voice can't expose stale stream state.
    for (int i = v.numStreams; i < MAX_SAMPLE_SLOTS; ++i)
        v.streams[static_cast<size_t>(i)] = Voice::Stream{};
}

void Sampler::enforceStreamBudget(int needed)
{
    // Release whole notes, oldest first (lowest spawnCounter), until `needed`
    // more streams fit under MAX_STREAMS. Note granularity is deliberate: a
    // chord must never lose one layer and change timbre — it loses whole notes.
    //
    // The budget is accounted against HELD streams, not all sounding ones.
    // Stealing is click-free precisely because a stolen note is handed to its
    // release envelope rather than hard-killed, so its streams keep rendering
    // for the release duration. Counting those against the budget would make
    // one new note cascade into stealing every note on the sampler. Held
    // streams are the ones that would sustain indefinitely, so they are what
    // the cap has to govern; released streams are a bounded, draining tail.
    if (needed <= 0) return;

    // Held streams: notes the user is still holding, excluding anything already
    // heading for silence.
    auto heldStreams = [this]() {
        int n = 0;
        for (const auto& v : voices_) {
            if (!v.active || !v.noteHeld) continue;
            if (v.envStage == Voice::EnvStage::Release
                || v.envStage == Voice::EnvStage::Off) continue;
            for (int i = 0; i < v.numStreams; ++i)
                if (v.streams[static_cast<size_t>(i)].active) ++n;
        }
        return n;
    };

    int budget = heldStreams();
    while (budget + needed > MAX_STREAMS)
    {
        Voice* oldest = nullptr;
        for (auto& v : voices_)
        {
            if (!v.active || !v.noteHeld) continue;
            if (v.envStage == Voice::EnvStage::Release
                || v.envStage == Voice::EnvStage::Off) continue;
            if (oldest == nullptr || v.spawnCounter < oldest->spawnCounter)
                oldest = &v;
        }
        // Nothing left that stealing can free (every remaining note is already
        // releasing). Let the new note through rather than dropping it — the
        // releasing notes will free their streams shortly.
        if (oldest == nullptr) return;

        int freed = 0;
        for (int i = 0; i < oldest->numStreams; ++i)
            if (oldest->streams[static_cast<size_t>(i)].active) ++freed;

        releaseVoice(*oldest);
        budget -= freed;
        // Defensive: a note with zero active streams would not shrink the
        // budget and would spin here. Cannot happen (armStreams guarantees
        // at least one), but the audio thread must never loop unbounded.
        if (freed <= 0) return;
    }
}

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
    if (!hasSample()) return;

    // ── MONO modulation sources ──────────────────────────────────────────────
    // A MONO source is ONE shared instance, so it retriggers on the note that
    // STARTS a group — the first note-on while the sampler is silent — not on
    // every note of a chord. FREE instances are transport-anchored and are
    // never retriggered by a note. Checked before the arpeggiator intercept so
    // an arpeggiated sampler behaves the same way.
    if (activeVoiceCount() == 0) {
        const ModGraphPtr graph = modGraph_.load(std::memory_order_acquire);
        if (graph) xleth::sampmod::modTriggerMonoGlobals(*graph, modGlobalBank_);
    }

    // Arpeggiator intercept: feed notes to arp, not voices
    if (arp_.enabled) {
        arp_.noteOn(midiNote, velocity);
        return;
    }

    const float vel = std::clamp(velocity, 0.0f, 1.0f);

    if (monoEnabled_) {
        // Was another note still DOWN when this one arrived? Legato and
        // portamento are overlap behaviours, so this — not "is a voice still
        // making sound" — is what decides between a retune and a new attack.
        // Sequenced notes butted end to end arrive as noteOff-then-noteOn on
        // the same tick (MixEngine orders NoteOff before NoteOn), which leaves
        // nothing held: that second note is a fresh attack, not a legato slur.
        const bool overlapping = !monoHeldNotes_.empty();

        // Track held note (remove duplicate, push to back as most recent)
        auto hIt = std::find(monoHeldNotes_.begin(), monoHeldNotes_.end(), midiNote);
        if (hIt != monoHeldNotes_.end()) monoHeldNotes_.erase(hIt);
        if (monoHeldNotes_.size() >= 16) monoHeldNotes_.erase(monoHeldNotes_.begin());
        monoHeldNotes_.push_back(midiNote);

        Voice* active = findActiveMonoVoice();
        // A note arriving while the previous one is still HELD is a LEGATO or
        // PORTAMENTO event: the voice is retuned rather than respawned. Which
        // of the two is enabled decides only whether that retune glides —
        // legato alone retunes instantly, portamento alone already behaved this
        // way, and both together is a glide with no envelope restart.
        //
        // `active->noteHeld` is checked as well as `overlapping`: fireNoteOff
        // clears it immediately while the envelope release itself is deferred
        // to a sample offset inside the buffer, so a voice can still be in
        // Sustain at this instant and yet already be a released tail.
        const bool retune = (active != nullptr) && active->noteHeld && overlapping
                            && (portamentoEnabled_ || legatoEnabled_);
        if (retune) {
            active->midiNote = midiNote;
            active->velocity = vel;
            active->noteHeld = true;
            // No-op glide when portamento is off, which lands the pitch
            // immediately — exactly what a non-gliding legato retune is.
            beginPortamento(*active, midiNote);
            // A voice already heading for silence must still restart its
            // envelopes: retuning one that is on its way to zero would produce
            // nothing. A still-sounding voice keeps them, and THAT is legato.
            if (active->envStage == Voice::EnvStage::Release
                || active->envStage == Voice::EnvStage::Off) {
                // Re-arm the streams too. A held one-shot that has run out is
                // put into Release by the "every layer has run out" path in
                // processVoice, and its read heads sit past the end of the trim
                // region — restarting only the envelope would modulate silence.
                armStreams(*active);
                active->envStage     = Voice::EnvStage::Delay;
                active->envLevel     = 0.0f;
                active->envPosition  = 0.0;
            }
        } else if (active) {
            // Hard retrigger: restart the voice at new pitch
            active->midiNote     = midiNote;
            active->velocity     = vel;
            // Re-arm every layer from its own trim start.
            armStreams(*active);
            // Portamento survives a re-attack: the pitch starts where the last
            // note left off and glides, while the envelope and every stream
            // restart from the top. Only the PITCH is continuous — that is
            // exactly what separates portamento from legato, which keeps the
            // envelope running too.
            if (portamentoEnabled_ && lastNotePitch_ >= 0) {
                active->currentPitchF = static_cast<double>(lastNotePitch_);
                beginPortamento(*active, midiNote);
            } else {
                active->currentPitchF = static_cast<double>(midiNote);
                active->targetPitch   = midiNote;
                active->portamentoRemaining = 0.0;
                active->portamentoTotal     = 0.0;
            }
            active->pitchRatio   = std::pow(2.0, (active->currentPitchF - slots_[0].rootNote) / 12.0);
            active->envStage     = Voice::EnvStage::Delay;
            active->envLevel     = 0.0f;
            active->envPosition  = 0.0;
            active->noteHeld     = true;
            active->onsetSample      = sampleOffset;
            // The previous note's note-off is DEFERRED: fireNoteOff only stamps
            // a sample index and processVoice performs the transition later in
            // the buffer. Reusing that voice without clearing the stamp would
            // release this note on the very sample it starts — which is the
            // whole reason a note butted against its predecessor went silent.
            active->releaseSample    = -1;
            // Hard retrigger cancels any in-flight slide on this voice.
            active->slideActive          = false;
            active->slideElapsedSamples  = 0.0;
            active->slideDurationSamples = 0.0;
            active->slideOnsetSample     = 0;
            // Semantic re-spawn: envelope restarts from Delay, every stream's
            // read head reset to its slot's trim start. Issue fresh identity so
            // findVoiceForNote's
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
            v->currentPitchF = static_cast<double>(lastNotePitch_);
            beginPortamento(*v, midiNote);
            v->pitchRatio = std::pow(2.0, (v->currentPitchF - slots_[0].rootNote) / 12.0);
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
                active->midiNote = returnNote;
                // Glides when portamento is on, jumps instantly when it is
                // not — the same two cases the hand-rolled branch covered,
                // now sharing the ALWAYS/SCALED and CURVE handling.
                beginPortamento(*active, returnNote);
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
    if (!hasSample()) return;

    // Make room BEFORE picking a voice: enforceStreamBudget releases whole
    // notes, which can also free the voice slot findFreeVoice would otherwise
    // have had to steal.
    const int needed = soundingSlotCount();
    if (needed <= 0) return;            // every slot muted / not solo'd
    enforceStreamBudget(needed);
    // The NOTE cap is independent of the stream cap — an 8-layer sampler is
    // bound by streams long before voiceCount_, a 1-layer sampler the other way
    // round — so both run and whichever binds first steals.
    enforceVoiceBudget();

    Voice* v = findFreeVoice();
    if (v == nullptr) return;

    v->active       = true;
    v->midiNote     = midiNote;
    v->velocity     = velocity;
    armStreams(*v);
    v->pitchRatio   = std::pow(2.0, (midiNote - slots_[0].rootNote) / 12.0);
    v->currentPitchF       = static_cast<double>(midiNote);
    v->targetPitch         = midiNote;
    v->portamentoRemaining = 0.0;
    v->portamentoTotal     = 0.0;
    v->portamentoSourceF   = static_cast<double>(midiNote);
    v->envStage     = Voice::EnvStage::Delay;
    v->envLevel     = 0.0f;
    v->envPosition  = 0.0;
    v->noteHeld     = true;
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

    // ── Modulation: arm this voice's half of the system ──────────────────────
    // Every per-voice source restarts here. modCountdown = 0 forces the first
    // control-block evaluation on the voice's very first sample, so an
    // envelope's attack starts exactly at the onset rather than up to 32
    // samples late. All state is already allocated inside the Voice — a
    // note-on never touches the heap.
    v->modCountdown = 0;
    v->modOffsets.clear();
    v->modMasterGain = 1.0f;
    // Named local: the graph must outlive the trigger call, and a temporary
    // shared_ptr in the condition would be destroyed before the body ran.
    const ModGraphPtr graph = modGraph_.load(std::memory_order_acquire);
    if (graph) {
        xleth::sampmod::modTriggerVoice(*graph, v->modBank, velocity,
                                        static_cast<float>(midiNote) / 127.0f);
    }
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

    // EXIT-LOOP-ON-RELEASE: the note leaves its loop after the current pass and
    // runs on to the end of the trim region. No amplitude release is queued —
    // the note holds sustain through the tail and releases through the existing
    // "every layer has run out" path in processVoice. Queuing a release here
    // would fade out exactly the tail this option exists to expose.
    //
    // Deliberately honoured for forced (pattern-sequencer) note-offs too: a
    // drawn note ending IS a release. Stealing and allNotesOff go through
    // releaseVoice() instead, which never grants a tail.
    if (armExitLoopTail(*v)) {
        v->releaseSample = -1;
        return;
    }

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

// ─── processVoice / processBlock ─────────────────────────────────────────────

// Per-stream geometry, resolved once per processVoice call from the stream's
// slot. Plain POD on the stack — no allocation on the audio thread.
namespace {
struct StreamGeometry
{
    const juce::AudioBuffer<float>* data = nullptr;
    int      nCh        = 0;
    int      nFrames    = 0;
    double   srRatio    = 1.0;      // slot source rate / engine rate
    double   rootNote   = 60.0;
    double   tuning     = 0.0;      // semitones
    float    volume     = 1.0f;
    float    panL       = 1.0f;
    float    panR       = 1.0f;
    int64_t  smpStart   = 0;
    int64_t  clampedEnd = 0;
    int      effDeclick = 0;
    int64_t  fadeInN    = 0;
    int64_t  fadeOutN   = 0;
    bool     useLoop    = false;
    int64_t  loopStart  = 0;
    int64_t  loopEnd    = 0;
    int64_t  xfade      = 0;
    double   xfadeStart = 0.0;
    int      loopMode   = static_cast<int>(SampleLoopMode::Forward);

    // MANGLE chain, resolved once per block per stream. Each entry is one
    // instance's per-block runtime; `mangleAny` false means no instance is
    // active and the render loop takes the pre-MANGLE path verbatim.
    std::array<xleth::mangle::Runtime, xleth::mangle::kMaxInstances> mangle{};
    int  mangleCount = 0;
    bool mangleAny   = false;
    // The unmodulated per-instance configs, kept so the modulation control block
    // can re-design any modulated instance (SlotMangleAmount/Mix carry a `stage`
    // that names the instance) without reloading the published chain on the
    // audio thread.
    std::array<xleth::mangle::InstanceConfig, xleth::mangle::kMaxInstances> mangleBase{};
    // Legal read-head window for a MANGLE-bent head. Precomputed so the inner
    // loop clamps against a pair that is ordered BY CONSTRUCTION — a degenerate
    // trim (clampedEnd == smpStart) would otherwise hand std::clamp lo > hi,
    // which is undefined behaviour.
    double   readLo     = 0.0;
    double   readHi     = 0.0;
};
} // namespace

void Sampler::processVoice(Voice& v,
                           juce::AudioBuffer<float>& out,
                           int numSamples,
                           double engineSampleRate)
{
    if (v.numStreams <= 0) { v.active = false; return; }
#ifdef XLETH_DEBUG
    if (v.onsetSample != 0)
        fprintf(stderr, "[ProcVoice] entry onset=%d numSamples=%d streams=%d\n",
                v.onsetSample, numSamples, v.numStreams);
#endif

    const int outChannels = out.getNumChannels();
    if (outChannels <= 0) return;

    static constexpr float kPi = 3.14159265358979323846f;

    // Sounding note frequency at block entry. MANGLE's key-tracked filter
    // cutoff is designed from this once per block (block-rate coefficients,
    // the same convention the effect base class uses) rather than chasing the
    // per-sample pitch modulation — one tan() per block instead of per sample.
    const double noteHzAtBlockEntry = 440.0 * std::pow(2.0, (v.currentPitchF - 69.0) / 12.0);

    // Loaded before the geometry pass because MANGLE's design needs to know
    // whether this stream is modulated: a routed instance must be designed from
    // the value CURRENTLY in force (carried in its per-stream state) plus the
    // offsets still held from the last control block, not from the published
    // base. Rebuilding from the base here is what used to leave the first
    // 0..31 samples of every buffer unmodulated.
    const xleth::sampmod::CompiledModGraph* const mod = modActive_;

    // ── Resolve every stream's geometry up front ─────────────────────────────
    // heldBuffers keeps each stream's published buffer alive for the duration
    // of this call (see the load below); geo holds the raw pointers the render
    // loop reads through.
    std::array<StreamGeometry, MAX_SAMPLE_SLOTS> geo{};
    std::array<Slot::BufferPtr, MAX_SAMPLE_SLOTS> heldBuffers{};
    int liveStreams = 0;
    for (int i = 0; i < v.numStreams; ++i)
    {
        auto& st = v.streams[static_cast<size_t>(i)];
        if (!st.active) continue;
        const Slot& sl = slots_[static_cast<size_t>(st.slotIndex)];

        // Pin the slot's published buffer for the whole block. Holding the
        // shared_ptr here — not just the raw pointer in the geometry — is what
        // makes a PREP bake landing mid-note safe: the swap can retire the old
        // buffer, but it cannot free it while this read head still points into
        // it. One atomic refcount bump per stream per block.
        auto& held = heldBuffers[static_cast<size_t>(i)];
        held = sl.data.load(std::memory_order_acquire);
        const int nCh     = held ? held->getNumChannels() : 0;
        const int nFrames = held ? held->getNumSamples()  : 0;
        if (nCh <= 0 || nFrames <= 0) { st.active = false; st.finished = true; continue; }

        auto& g = geo[static_cast<size_t>(i)];
        g.data     = held.get();
        g.nCh      = nCh;
        g.nFrames  = nFrames;
        g.srRatio  = sl.sourceSampleRate / engineSampleRate;
        g.rootNote = static_cast<double>(sl.rootNote);
        g.tuning   = sl.tuningSemitones;
        g.volume   = sl.volume;
        // Constant-power slot pan, NORMALISED so centre is unity gain.
        // The raw cos/sin law gives 0.707 per side at centre (-3 dB), which
        // would quietly attenuate every pre-slot project by 3 dB the moment
        // slot pan was introduced. Scaling by sqrt(2) puts pan=0 at exactly
        // 1.0 — so a legacy single-sample region is bit-identical — while
        // keeping total power constant as the layer is swept.
        {
            static constexpr float kSqrt2 = 1.41421356237f;
            const float panAngle = (std::clamp(sl.pan, -1.0f, 1.0f) + 1.0f) * 0.5f;
            g.panL = kSqrt2 * cosf(panAngle * kPi * 0.5f);
            g.panR = kSqrt2 * sinf(panAngle * kPi * 0.5f);
        }

        // Trim end: smpStart + effective length, clamped to buffer bounds.
        g.smpStart = sl.smpStart;
        const int64_t effEnd = sl.smpStart +
            (sl.smpLength > 0 ? sl.smpLength
                              : static_cast<int64_t>(nFrames) - sl.smpStart);
        g.clampedEnd = std::min(effEnd, static_cast<int64_t>(nFrames));

        // Declick width (ms → samples at this slot's source rate), clamped so
        // the two edge fades can never overlap.
        const int declickN = xleth::dsp::DeclickEnvelope::msToSamples(
            sl.declickMs, sl.sourceSampleRate);
        g.effDeclick = std::min(declickN,
            static_cast<int>((g.clampedEnd - g.smpStart) / 2));

        g.fadeInN  = static_cast<int64_t>(sl.fadeInMs  * 0.001 * sl.sourceSampleRate);
        g.fadeOutN = static_cast<int64_t>(sl.fadeOutMs * 0.001 * sl.sourceSampleRate);

        // Effective loop end: 0 means "end of sample".
        const int64_t effLoopEnd = (sl.loopEnd > 0)
            ? std::min<int64_t>(sl.loopEnd, nFrames)
            : static_cast<int64_t>(nFrames);
        const int64_t effLoopStart = std::min<int64_t>(sl.loopStart, effLoopEnd);
        g.useLoop   = crossfadeEnabled_ && sl.loopEnabled && effLoopEnd > effLoopStart;
        g.loopStart = effLoopStart;
        g.loopEnd   = effLoopEnd;
        g.loopMode  = sl.loopMode;

        // Loop crossfade width. Clamp so:
        //  - the two ends can never overlap inside the loop
        //  - the fade-out read [loopEnd-N, loopEnd] stays inside the trim region
        //  - the fade-in source [loopStart, loopStart+N] stays inside the trim region
        //
        // PingPong takes no crossfade: it reflects rather than jumps, so the
        // seam is already value-continuous and blending would only smear it.
        const bool pingPong = (g.loopMode == static_cast<int>(SampleLoopMode::PingPong));
        if (g.useLoop && !pingPong && sl.crossfadeSamples > 0) {
            int64_t x = sl.crossfadeSamples;
            x = std::min<int64_t>(x, (effLoopEnd - effLoopStart) / 2);
            x = std::min<int64_t>(x, effLoopEnd    - g.smpStart);
            x = std::min<int64_t>(x, g.clampedEnd  - effLoopStart);
            g.xfade = std::max<int64_t>(0, x);
        }
        g.xfadeStart = static_cast<double>(effLoopEnd - g.xfade);

        // ── MANGLE runtime ───────────────────────────────────────────────────
        // cycleLen (source samples per note cycle) collapses to srcSR / K, with
        // K the frequency the slot's own root note and tuning define. It is
        // therefore a per-block constant independent of the live stride — which
        // is what makes `phase * cycleLen` advance by exactly `stride` per
        // sample and every mode's A = 0 case an exact identity. See MangleDsp.h.
        g.readLo = static_cast<double>(g.smpStart);
        g.readHi = std::max(g.readLo, static_cast<double>(g.clampedEnd) - 1.0);

        const double K = 440.0 * std::pow(2.0, (sl.rootNote - sl.tuningSemitones - 69.0) / 12.0);
        const double cycleLen = (K > 1.0e-6) ? (sl.sourceSampleRate / K) : 0.0;

        // Load the slot's published chain once and design a runtime per
        // instance. Bypassed instances get a default (inactive) runtime, so the
        // render loop skips them for free. The shared_ptr is held only for this
        // iteration — makeRuntime copies every value it needs into the Runtime,
        // so nothing points back into the config during the block, and the
        // main-thread retirement ring keeps the audio thread from ever dropping
        // the last reference.
        g.mangleCount = 0;
        g.mangleAny   = false;
        g.mangleBase.fill(xleth::mangle::InstanceConfig{});
        // A MODULATED slot must not be re-designed from the published base here:
        // its live amount / mix (and any dezipper ramp still in flight) are held
        // in the per-stream state and are simply resumed, because the control
        // block that owns them is voice-relative and does not line up with this
        // buffer boundary. Rebuilding from the base was the crackle — it reverted
        // the instance to its unmodulated amount for the first 0..31 samples of
        // every buffer, whether or not the modulated value was moving.
        //
        // An UNROUTED slot arms a zero-length ramp, which is a plain snap to the
        // published value and therefore bit-identical to the pre-dezipper build.
        const size_t modSlot = static_cast<size_t>(st.slotIndex);
        const bool mangleRouted = (mod != nullptr) && mod->anyMangleRouted
                               && modSlot < mod->slotMangleRouted.size()
                               && mod->slotMangleRouted[modSlot];
        if (auto chain = sl.mangleChain.load(std::memory_order_acquire)) {
            const int nInst = std::min(chain->count, xleth::mangle::kMaxInstances);
            for (int k = 0; k < nInst; ++k) {
                const auto& in = chain->inst[static_cast<size_t>(k)];
                g.mangleBase[static_cast<size_t>(k)] = in;
                if (in.bypass) {
                    g.mangle[static_cast<size_t>(k)] = xleth::mangle::Runtime{};
                } else {
                    g.mangle[static_cast<size_t>(k)] = xleth::mangle::designInstance(
                        st.mangle[static_cast<size_t>(k)],
                        in.mode, in.amount, in.mix,
                        noteHzAtBlockEntry, cycleLen,
                        static_cast<double>(g.smpStart),
                        static_cast<double>(g.clampedEnd - g.smpStart),
                        engineSampleRate,
                        /*armRamp=*/!mangleRouted, /*rampSamples=*/0);
                }
                if (g.mangle[static_cast<size_t>(k)].active) g.mangleAny = true;
            }
            g.mangleCount = nInst;
        }

        ++liveStreams;
    }
    if (liveStreams == 0) { v.active = false; return; }

    // ── Seed the modulated pan gains from the unmodulated geometry ───────────
    // Indexed by SLOT, not by stream: a muted slot gets no stream at all, so
    // the two indices diverge the moment one layer is silent. The render loop
    // reads v.modPanL/R unconditionally, so seeding them here makes an unrouted
    // slot cost one array read per sample instead of a branch, and
    // evaluateVoiceModulation only overwrites the slots a pan route touches.
    for (int i = 0; i < v.numStreams; ++i) {
        const auto& st = v.streams[static_cast<size_t>(i)];
        if (!st.active) continue;
        const auto& gi = geo[static_cast<size_t>(i)];
        v.modPanL[static_cast<size_t>(st.slotIndex)] = gi.panL;
        v.modPanR[static_cast<size_t>(st.slotIndex)] = gi.panR;
    }
    // 4-point cubic Hermite read. Dramatically reduces the aliasing that
    // becomes audible when the pitch LFO modulates stride.
    auto readInterp = [](const StreamGeometry& g, double pos, int srcCh) -> float {
        const int i0 = static_cast<int>(pos);
        if (i0 < 0 || i0 >= g.nFrames) return 0.0f;
        const float f = static_cast<float>(pos - i0);

        auto clampGet = [&](int idx) -> float {
            if (idx < 0) idx = 0;
            else if (idx >= g.nFrames) idx = g.nFrames - 1;
            return g.data->getSample(srcCh, idx);
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
        // Deferred release: transition to Release at the scheduled sub-buffer sample.
        // Must run before advanceEnvelope so the Release stage takes effect on sample s.
        if (v.releaseSample >= 0 && s >= v.releaseSample) {
            v.envStage       = Voice::EnvStage::Release;
            v.envPosition    = 0.0;
            v.releaseSample  = -1;
            xleth::sampmod::modReleaseVoice(v.modBank);
        }

        // ── MODULATION CONTROL BLOCK ─────────────────────────────────────────
        // Every source is re-evaluated once per kControlBlockSamples (32) and
        // its result held for the block. The counter is VOICE-relative, so an
        // envelope reaches its sustain after the same number of samples
        // whatever buffer size the host hands us.
        //
        // MANGLE amount/mix are the one target that has to reach back into the
        // per-block geometry, so the affected slots' runtimes are re-designed
        // here — only where a route exists, which is what keeps an unmodulated
        // MANGLE slot at its original one-design-per-block cost.
        //
        // MANGLE modulation is per-SLOT and per chain INSTANCE: a route's `stage`
        // names which instance its SlotMangleAmount/Mix offset lands on
        // (v.modOffsets.mangleAmount[slot][instance]). A migrated single MANGLE
        // (a one-instance chain) is instance 0, modulated exactly as before.
        if (mod != nullptr)
        {
            if (v.modCountdown <= 0)
            {
                evaluateVoiceModulation(v, *mod, s, engineSampleRate);
                v.modCountdown = xleth::sampmod::kControlBlockSamples;

                if (mod->anyMangleRouted)
                {
                    for (int i = 0; i < v.numStreams; ++i)
                    {
                        auto& st = v.streams[static_cast<size_t>(i)];
                        if (!st.active) continue;
                        const size_t si = static_cast<size_t>(st.slotIndex);
                        if (!mod->slotMangleRouted[si]) continue;
                        const Slot& sl = slots_[si];
                        auto& gm = geo[static_cast<size_t>(i)];
                        if (gm.mangleCount <= 0) continue;
                        const double K = 440.0 * std::pow(
                            2.0, (sl.rootNote - sl.tuningSemitones - 69.0) / 12.0);
                        const double cycleLen = (K > 1.0e-6) ? (sl.sourceSampleRate / K) : 0.0;
                        // Re-design every active instance from its own base plus
                        // that instance's accumulated offset. A bypassed / Off
                        // instance has nothing to modulate and is left alone.
                        //
                        // The new value is the ramp's TARGET, not an immediate
                        // write: makeRuntimeSmoothed glides amount, mix and the
                        // SVF coefficients to it over the block's 32 samples and
                        // leaves every piece of instance state — oscillator
                        // phase, cycle anchor, filter integrators, DC blockers —
                        // strictly alone.
                        for (int k = 0; k < gm.mangleCount && k < xleth::mangle::kMaxInstances; ++k)
                        {
                            const auto& base = gm.mangleBase[static_cast<size_t>(k)];
                            if (base.bypass || base.mode == 0) continue;
                            const float amt = std::clamp(
                                base.amount + v.modOffsets.mangleAmount[si][static_cast<size_t>(k)], 0.0f, 1.0f);
                            const float mix = std::clamp(
                                base.mix + v.modOffsets.mangleMix[si][static_cast<size_t>(k)], 0.0f, 1.0f);
                            gm.mangle[static_cast<size_t>(k)] = xleth::mangle::designInstance(
                                st.mangle[static_cast<size_t>(k)],
                                base.mode, amt, mix,
                                noteHzAtBlockEntry, cycleLen,
                                static_cast<double>(gm.smpStart),
                                static_cast<double>(gm.clampedEnd - gm.smpStart),
                                engineSampleRate,
                                /*armRamp=*/true,
                                /*rampSamples=*/xleth::sampmod::kControlBlockSamples);
                            gm.mangleAny = gm.mangleAny || gm.mangle[static_cast<size_t>(k)].active;
                        }
                    }
                }
            }
            --v.modCountdown;
        }

        // ── NOTE-LEVEL MODULATION (shared by every layer of this note) ───────
        const float envGain = advanceEnvelope(v, engineSampleRate);

        // ── FL-STYLE GROUP SLIDE (overrides portamento; updates currentPitchF) ─
        // Modulates the note's base pitch directly. Pitch envelope and pitch
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
        // Shaped interpolation from the captured source pitch rather than a
        // per-sample step toward the target. The two agree EXACTLY at curve 0:
        // the old step form moved (target - current)/remaining each sample,
        // which telescopes to source + delta·k/N — precisely what this computes
        // when shapeTension is the identity. A non-zero curve is expressible
        // only in this form, since a per-sample step can describe nothing but a
        // linear ramp.
        else if (v.portamentoRemaining > 0.0) {
            v.portamentoRemaining -= 1.0;
            if (v.portamentoRemaining <= 0.0) {
                v.currentPitchF       = static_cast<double>(v.targetPitch);
                v.portamentoRemaining = 0.0;
                v.portamentoTotal     = 0.0;
            } else if (v.portamentoTotal > 0.0) {
                const float frac = static_cast<float>(
                    1.0 - v.portamentoRemaining / v.portamentoTotal);
                const double shaped =
                    static_cast<double>(shapeTension(frac, portamentoCurve_));
                v.currentPitchF = v.portamentoSourceF
                    + (static_cast<double>(v.targetPitch) - v.portamentoSourceF) * shaped;
            }
        }

        // Note-level pitch / vol / pan modulation is now the modulation
        // system's job (modOffsets, applied per-slot below). The legacy per-note
        // pitch envelope and the three legacy LFOs are gone; these neutral
        // values keep the downstream mix arithmetic unchanged.
        const double pitchOffsetSemitones = 0.0;
        const float  volLfoGain = 1.0f;
        const float  lfoPanL = 1.0f, lfoPanR = 1.0f;

        // ── PER-STREAM RENDER ────────────────────────────────────────────────
        int stillRunning = 0;
        for (int i = 0; i < v.numStreams; ++i)
        {
            auto& st = v.streams[static_cast<size_t>(i)];
            if (!st.active) continue;
            // Non-const: the MANGLE dezipper advances this stream's per-instance
            // runtime (coefficients only) once per sample. Everything else here
            // still treats the geometry as read-only for the block.
            StreamGeometry& g = geo[static_cast<size_t>(i)];
            if (g.data == nullptr) continue;

            // Combined tuning: note pitch, this slot's root note, and the
            // slot's summed oct/sem/fine/coarse, plus the note-level pitch
            // modulation. One pow per stream per sample, as before.
            //
            // The modulation matrix folds SEM, COARSE and FINE into ONE
            // per-slot semitone offset (FINE already converted from cents), so
            // routing all three costs a single extra add here.
            const double semis = (v.currentPitchF - g.rootNote)
                               + g.tuning + pitchOffsetSemitones
                               + static_cast<double>(
                                     v.modOffsets.semis[static_cast<size_t>(st.slotIndex)]);
            const double stride = std::pow(2.0, semis / 12.0) * g.srRatio;

            // ── End-of-sample / loop handling ───────────────────────────────
            // `loopLeft` means an exit-on-release tail is running: the stream
            // has left its loop for good and behaves like a non-looping layer.
            const bool looping = g.useLoop && !st.loopLeft;
            if (looping)
            {
                if (st.dir > 0 && st.playPosition >= static_cast<double>(g.loopEnd))
                {
                    const double over = st.playPosition - static_cast<double>(g.loopEnd);
                    if (st.exiting) {
                        // The forward pass just completed. Leave the loop and
                        // keep going — playPosition already sits past loopEnd,
                        // so the tail continues into the rest of the sample.
                        st.loopLeft = true;
                    } else if (g.loopMode == static_cast<int>(SampleLoopMode::Forward)) {
                        // FL-style wrap: the first `xfade` samples of the loop
                        // region are only heard as the crossfade's fade-in
                        // source, so wrap past them to avoid content repetition.
                        st.playPosition = static_cast<double>(g.loopStart + g.xfade) + over;
                    } else {
                        // PingPong and Reverse both REFLECT at the top: the
                        // head turns around and starts descending from loopEnd.
                        st.dir = -1;
                        st.playPosition = static_cast<double>(g.loopEnd) - over;
                    }
                }
                else if (st.dir < 0 && st.playPosition <= static_cast<double>(g.loopStart))
                {
                    const double under = static_cast<double>(g.loopStart) - st.playPosition;
                    if (st.exiting) {
                        // The backward pass just completed. Turn around and run
                        // forward out of the loop to the end of the sample.
                        st.loopLeft     = true;
                        st.dir          = 1;
                        st.playPosition = static_cast<double>(g.loopStart) + under;
                    } else if (g.loopMode == static_cast<int>(SampleLoopMode::PingPong)) {
                        // Reflect at the bottom — back to forward.
                        st.dir          = 1;
                        st.playPosition = static_cast<double>(g.loopStart) + under;
                    } else {
                        // Reverse: jump back up to the top and descend again.
                        // Mirrors the forward wrap — stop `xfade` short of
                        // loopEnd, since those samples are only heard as the
                        // (mirrored) crossfade's fade-in source.
                        st.playPosition = static_cast<double>(g.loopEnd - g.xfade) - under;
                    }
                }
            }
            else if (st.dir > 0 && st.playPosition >= static_cast<double>(g.clampedEnd - 1))
            {
                // This layer has run out. Mark it finished; the NOTE only
                // releases once every layer has, so a short layer never cuts a
                // long one short.
                st.finished = true;
            }
            else if (st.dir < 0 && st.playPosition <= static_cast<double>(g.smpStart))
            {
                // A backward head that is no longer looping has nowhere left to
                // go. Only reachable if the loop was disabled mid-note.
                st.finished = true;
            }

            // Bounds check — emit silence if the read head left the buffer.
            const int idx0 = static_cast<int>(st.playPosition);
            if (idx0 < 0 || idx0 >= g.nFrames) { st.active = false; st.finished = true; continue; }

            // Hann-window declick at trim start and end (via shared LUT).
            float declickGain = 1.0f;
            if (g.effDeclick > 0)
            {
                const int posFromStart = static_cast<int>(st.playPosition - static_cast<double>(g.smpStart));
                const int posFromEnd   = static_cast<int>(static_cast<double>(g.clampedEnd) - st.playPosition);
                declickGain = xleth::dsp::DeclickEnvelope::fadeIn(posFromStart, g.effDeclick)
                            * xleth::dsp::DeclickEnvelope::fadeOut(posFromEnd, g.effDeclick);
            }

            // Linear fade in/out (user-controlled, applied after declick).
            float fadeGain = 1.0f;
            if (g.fadeInN > 0)
            {
                const int64_t relPos = static_cast<int64_t>(st.playPosition) - g.smpStart;
                if (relPos < g.fadeInN)
                    fadeGain *= std::max(0.0f, static_cast<float>(relPos)
                                               / static_cast<float>(g.fadeInN));
            }
            if (g.fadeOutN > 0)
            {
                const int64_t distFromEnd = g.clampedEnd - static_cast<int64_t>(st.playPosition);
                if (distFromEnd < g.fadeOutN)
                    fadeGain *= std::max(0.0f, static_cast<float>(distFromEnd)
                                               / static_cast<float>(g.fadeOutN));
            }

            // Loop crossfade: blend the approach to the wrap with the content
            // the head is about to jump to, so the seam is amplitude-matched.
            //
            // Forward runs up to loopEnd and blends toward loopStart — the
            // original expression, unchanged, which is what keeps a Forward
            // loop bit-identical to the pre-loop-mode sampler.
            //
            // Reverse is its exact mirror: descending toward loopStart, blend
            // toward the content just below loopEnd. PingPong reflects instead
            // of jumping, so it never gets here (its xfade is clamped to 0).
            const bool xfadeArmed = (g.xfade > 0 && !st.loopLeft);
            const bool inXfade    = xfadeArmed
                                  && (st.dir > 0
                                      ? st.playPosition >= g.xfadeStart
                                      : st.playPosition <= static_cast<double>(g.loopStart + g.xfade));
            float fadeOutX = 1.0f, fadeInX = 0.0f;
            double loopSrcPos = 0.0;
            if (inXfade)
            {
                if (st.dir > 0) {
                    float progress = static_cast<float>(
                        (st.playPosition - g.xfadeStart) / static_cast<double>(g.xfade));
                    if (progress > 1.0f) progress = 1.0f;
                    fadeOutX   = cosf(progress * kPi * 0.5f);
                    fadeInX    = sinf(progress * kPi * 0.5f);
                    loopSrcPos = static_cast<double>(g.loopStart)
                               + (st.playPosition - g.xfadeStart);
                } else {
                    const double travelled = static_cast<double>(g.loopStart + g.xfade)
                                           - st.playPosition;
                    float progress = static_cast<float>(
                        travelled / static_cast<double>(g.xfade));
                    if (progress > 1.0f) progress = 1.0f;
                    fadeOutX   = cosf(progress * kPi * 0.5f);
                    fadeInX    = sinf(progress * kPi * 0.5f);
                    loopSrcPos = static_cast<double>(g.loopEnd) - travelled;
                }
            }

            // Modulated slot volume replaces (rather than scales) the slot's
            // own gain, so an amount of 1.0 on a slot sitting at 1.0 reaches
            // 2.0 exactly — the target's documented span — instead of squaring.
            // modMasterGain is the sampler master, base 1.0.
            const float slotGain = std::clamp(
                g.volume + v.modOffsets.volume[static_cast<size_t>(st.slotIndex)],
                0.0f, 2.0f);
            const float common = envGain * v.velocity * declickGain * fadeGain
                               * volLfoGain * slotGain * v.modMasterGain;

            // ── MANGLE chain (per-note, per-slot warp FX) ───────────────────
            // Runs entirely INSIDE this stream, before the voice sums into
            // `out`: a chord through TUBE gets one shaper per note, not one on
            // the summed chord. The chain is a stack — the output of instance N
            // feeds instance N+1, so order is audible.
            //
            // `tick` bends only where the head is READ FROM; st.playPosition is
            // never written here, so the loop state machine, the trim-end test,
            // the declick/fade envelopes and the crossfade above all keep
            // driving the canonical head exactly as pre-MANGLE.
            //
            // POSITIONS COMPOSE. Each position-domain instance ticks against the
            // head the instances BEFORE it already bent, not against the
            // canonical head, and moves it further. Ticking every instance
            // against the canonical head was the original design and it is what
            // made a chain of two ALT modes behave as if only the last one
            // existed: instance N+1 re-read the SOURCE at a bend derived purely
            // from st.playPosition, so at its default mix of 1.0 it overwrote
            // instance N's output with a read that had never seen it. Composing
            // is also what makes two copies of the same mode stack instead of
            // landing on the identical position and cancelling out.
            //
            // The head advances by offset * mix, so a partly-wet instance bends
            // the head for its successors by exactly the fraction it contributes
            // to the sample. A ONE-instance chain still ticks against
            // st.playPosition, which is what keeps it bit-identical to the
            // pre-chain single-MANGLE render (and the legacy migration exact).
            const bool mangleAny = g.mangleAny;
            std::array<xleth::mangle::Tick,   xleth::mangle::kMaxInstances> mt{};
            std::array<double, xleth::mangle::kMaxInstances> wetPos{};
            std::array<bool,   xleth::mangle::kMaxInstances> wetPosMoved{};
            if (mangleAny)
            {
                double headPos = st.playPosition;
                for (int k = 0; k < g.mangleCount; ++k)
                {
                    const size_t ik = static_cast<size_t>(k);
                    if (!g.mangle[ik].active) continue;
                    mt[ik] = xleth::mangle::tick(g.mangle[ik], st.mangle[ik],
                                                 headPos, stride);
                    wetPos[ik] = headPos;
                    if (mt[ik].posOffset != 0.0)
                    {
                        // A bent head must stay inside the trim window: the ALT
                        // modes deliberately run backwards and stall, and nothing
                        // downstream re-checks the bound.
                        wetPos[ik] = std::clamp(headPos + mt[ik].posOffset,
                                                g.readLo, g.readHi);
                        wetPosMoved[ik] = true;
                        headPos = std::clamp(
                            headPos + mt[ik].posOffset * static_cast<double>(g.mangle[ik].mix),
                            g.readLo, g.readHi);
                    }
                }
            }

            // The channel loop below reads rt.amount / rt.mix / rt.a1..a3, so
            // the dezipper is advanced after it — see the mangleAny block that
            // follows the per-channel loop.

            for (int ch = 0; ch < std::min(2, outChannels); ++ch)
            {
                const int srcCh = std::min(ch, g.nCh - 1);
                float sample = readInterp(g, st.playPosition, srcCh);
                if (inXfade)
                {
                    const float loopStartSample = readInterp(g, loopSrcPos, srcCh);
                    sample = sample * fadeOutX + loopStartSample * fadeInX;
                }

                if (mangleAny)
                {
                    // Walk the chain in order: each active instance transforms
                    // the running `sample` and blends it back by its own mix, so
                    // the output of instance N feeds instance N+1. A one-instance
                    // chain is exactly the pre-chain single-MANGLE render.
                    //
                    // The walk is TWO passes over the same ordered chain: every
                    // head-bending instance first (in chain order), then every
                    // sample-shaping one (in chain order). The split is forced by
                    // physics, not taste: a bent head re-reads the SOURCE buffer,
                    // so a position instance has no way to receive a shaped
                    // sample as its input — running it after a shaper can only
                    // discard that shaper's work, which is precisely how a
                    // LPF -> SYNC chain used to end up sounding like SYNC alone.
                    // Resolving the warps first and shaping the composed read is
                    // the only ordering in which BOTH stages survive, and it is
                    // the warp-then-shape model every wavetable synth uses.
                    // Order stays audible where it can be: among the warps (the
                    // bends compose in order) and among the shapers.
                    const auto applyInstance = [&](size_t ik, float in) -> float
                    {
                        const auto& rt = g.mangle[ik];

                        // A sample-domain mode reuses the running value outright,
                        // so FILTER / DISTORTION cost one extra shaper call and
                        // no extra interpolation. A position-domain mode instead
                        // re-reads the SOURCE at its bent head — its input is the
                        // buffer, not the previous instance's sample.
                        float wet = in;
                        if (wetPosMoved[ik])
                        {
                            wet = readInterp(g, wetPos[ik], srcCh);
                            if (inXfade)
                            {
                                // Carry the same bend into the crossfade's source
                                // read, or the seam would fight the read head.
                                const double srcBent = std::clamp(
                                    loopSrcPos + mt[ik].posOffset, g.readLo, g.readHi);
                                wet = wet * fadeOutX + readInterp(g, srcBent, srcCh) * fadeInX;
                            }
                        }

                        // ODD / EVEN: comb against a second head half a note
                        // period back. A read, not a delay line — a per-stream
                        // ring long enough for a bass note would be prohibitive.
                        if (mt[ik].combDepth > 0.0f)
                        {
                            const double combPos = std::clamp(
                                wetPos[ik] + mt[ik].combOffset, g.readLo, g.readHi);
                            const float delayed = readInterp(g, combPos, srcCh);
                            wet = (wet + mt[ik].combSign * mt[ik].combDepth * delayed)
                                / (1.0f + mt[ik].combDepth);
                        }

                        wet = xleth::mangle::shapeSample(rt, st.mangle[ik], wet, ch)
                            * mt[ik].ampGain;

                        return in + (wet - in) * rt.mix;
                    };

                    for (int k = 0; k < g.mangleCount; ++k)
                    {
                        const size_t ik = static_cast<size_t>(k);
                        if (g.mangle[ik].active && wetPosMoved[ik])
                            sample = applyInstance(ik, sample);
                    }
                    for (int k = 0; k < g.mangleCount; ++k)
                    {
                        const size_t ik = static_cast<size_t>(k);
                        if (g.mangle[ik].active && !wetPosMoved[ik])
                            sample = applyInstance(ik, sample);
                    }
                }

                // Slot pan and pan-LFO compose multiplicatively per side.
                // v.modPanL/R IS the slot's constant-power pan — seeded from
                // the geometry and re-derived at control rate wherever a pan
                // route (slot or master) moves it.
                const size_t pi = static_cast<size_t>(st.slotIndex);
                const float panGain = (ch == 0) ? (v.modPanL[pi] * lfoPanL)
                                                : (v.modPanR[pi] * lfoPanR);
                out.addSample(ch, s, sample * common * panGain);
            }

            // ── Dezipper step ────────────────────────────────────────────────
            // Once per SAMPLE per instance (not per channel), after the sample
            // has been rendered: the block opens on the value the previous block
            // closed with and closes exactly on the target the control block
            // asked for. Five adds per ramping instance and nothing at all for
            // an unmodulated one, whose rampLeft is always 0.
            if (mangleAny)
            {
                for (int k = 0; k < g.mangleCount; ++k)
                {
                    const size_t ik = static_cast<size_t>(k);
                    if (g.mangle[ik].rampLeft > 0)
                        xleth::mangle::advanceParams(g.mangle[ik], st.mangle[ik]);
                }
            }

            // dir is +1 for every forward read — including every Forward loop
            // and every post-loop tail — so this is the original advance in
            // all pre-existing configurations.
            st.playPosition += stride * static_cast<double>(st.dir);
            if (!st.finished) ++stillRunning;
        }

        // A non-looping note releases only once EVERY layer has run out.
        if (stillRunning == 0 && v.envStage != Voice::EnvStage::Release
            && v.envStage != Voice::EnvStage::Off)
        {
            v.envStage    = Voice::EnvStage::Release;
            v.envPosition = 0.0;
            xleth::sampmod::modReleaseVoice(v.modBank);
        }

        if (v.envStage == Voice::EnvStage::Off) {
            v.active = false;
            for (auto& st : v.streams) st.active = false;
            return;
        }
    }
    // (Removed an XLETH_DEBUG-gated fprintf here: debug-gated or not, stderr I/O
    // on the audio render path is a real-time violation.)
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
    if (!hasSample()) return;
    if (numSamples <= 0) return;
    if (engineSampleRate <= 0.0) return;

    // ── Modulation graph: ONE atomic load for the whole block ────────────────
    // Held in a member for the duration so processVoice reads a stable
    // topology; a main-thread setModulation() during this call publishes a new
    // graph that the NEXT block picks up. Null graph = no routes = exact
    // bypass, and nothing below the null test ever runs.
    modHeld_   = modGraph_.load(std::memory_order_acquire);
    modActive_ = modHeld_.get();
    if (modActive_ != nullptr)
        advanceGlobalModulation(*modActive_, numSamples, engineSampleRate);

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
