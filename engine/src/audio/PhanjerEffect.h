#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>

// ─── PhanjerEffect ───────────────────────────────────────────────────────────
// Parallel flanger + phaser hybrid whose signature behaviour is COLLISION
// LEVELING: when the flanger's comb peaks cross the phaser's feedback peaks (or
// notch crosses notch) the combined response is ducked instead of doubling /
// over-cancelling.
//
// Signal flow (see PHANJER_HANDOFF.md §1):
//
//            ┌── FLANGER (modulated delay, tanh regen) ──► flPath ──► × mF ──┐
//   in x ────┤                                                               ├─► Σ
//            └── PHASER  (N biquad allpass, tanh regen) ──► apPath ──► × mP ──┘
//
//   LINKED / SMART :  Σ′ = L(t) · Σ        (L ≤ 1, the leveling guard)
//   WILD           :  Σ′ = tanh(1.5·Σ) / tanh(1.5)
//   out            =  x + globalMix · Σ′
//
// The dry signal enters ONCE, in the global sum — never inside flPath/apPath.
// Both submixes at 0 therefore give pure dry, always, and each MIX is that
// effect's comb depth rather than a dry/wet crossfade.
//
// Parameters (23 APVTS ids — the UI contract, PHANJER_HANDOFF.md §2):
//   mode          0–2       LINKED / SMART / WILD                    (raw)
//   f_mix         0–100 %   flanger submix / comb depth              (Linear 20 ms)
//   f_rate        0.05–10 Hz                                         (one-pole 50 ms)
//   f_depth       0–100 %                                            (Linear 20 ms)
//   f_feedback    −95–95 %  bipolar, capped ±0.95                    (Linear 20 ms)
//   f_delay_min   0.1–20 ms sweep low bound                          (one-pole 50 ms)
//   f_delay_max   0.1–20 ms sweep high bound (swapped if min > max)  (one-pole 50 ms)
//   f_sync        bool      tempo-sync toggle                        (raw)
//   f_sync_div    0–5       1/1 1/2 1/4 1/8 1/16 1/32                (raw)
//   f_sync_feel   0–2       Straight / Triplet / Dotted              (raw)
//   p_mix         0–100 %                                            (Linear 20 ms)
//   p_rate        0.05–10 Hz                                         (one-pole 50 ms)
//   p_depth       0–100 %                                            (Linear 20 ms)
//   p_feedback    −95–95 %                                           (Linear 20 ms)
//   p_stages      1–6       second-order allpass stages = notch count(raw)
//   p_freq_min    20–2000 Hz                                         (Mult. 30 ms)
//   p_freq_max    200–16000 Hz                                       (Mult. 30 ms)
//   p_sync / p_sync_div / p_sync_feel  — as flanger                  (raw)
//   global_mix    0–100 %                                            (Linear 20 ms)
//   lfo_shape     0–4       Sine / Triangle / Saw / Square / Random  (raw)
//   chaos         0–100 %   active only when shape = Random          (Linear 20 ms)
//
// Metering slots: 0 = output peak L, 1 = output peak R, 2 = leveling gain L
// (0–1; always 1 in WILD, where the guard is off).
//
// pluginId: "phanjer"  (factory entry already lives in AudioGraph.cpp)
//
// ── Deviations from the handoff, and why ────────────────────────────────────
//  • §2 says "24 APVTS parameters total" but the id table enumerates 23. The
//    table is the contract (it is what the UI writes), so 23 it is.
//  • §4's sync formula `rateHz = (bpm/60)·(4/div)·feelMult, Triplet 2/3,
//    Dotted 3/2` is a PERIOD formula wearing a rate label: taken literally a
//    1/1 sweep would run 4× FASTER than a 1/4 sweep and a dotted note would
//    shorten rather than lengthen. resolveRateHz() implements the reciprocal —
//    one LFO cycle per note value — which is what every other synced modulator
//    in the project does. The two agree exactly at 1/4 Straight.
//  • §3 specifies a tanh soft limiter only on the FLANGER regen path. The
//    phaser's allpass cascade is unity-magnitude, so a bare +0.95 feedback loop
//    has a closed-loop gain of 1/(1−0.95) = 20 at every frequency where the
//    cascade phase wraps to 0 (DC included). The same tanh the flanger uses is
//    therefore applied to the phaser regen: transparent at normal levels, and
//    it bounds the resonance instead of letting it run to 20×.

class PhanjerEffect : public XlethEffectBase
{
public:
    // ── Discrete parameter encodings ─────────────────────────────────────────
    enum Mode  { kLinked = 0, kSmart, kWild, kNumModes };
    enum Shape { kSine = 0, kTriangle, kSaw, kSquare, kRandom, kNumShapes };
    enum Feel  { kStraight = 0, kTriplet, kDotted, kNumFeels };

    static constexpr int   kNumDivs          = 6;    // 1/1 1/2 1/4 1/8 1/16 1/32
    static constexpr int   kMaxStages        = 6;
    static constexpr int   kMaxCombFeatures  = 8;    // §5 cost bound
    static constexpr float kGuardBandOctaves = 0.333333f;  // ⅓ octave
    static constexpr float kFeatureCeilingHz = 8000.0f;
    static constexpr float kLookaheadSec     = 0.030f;
    static constexpr float kMaxDelayMs       = 20.0f;
    static constexpr float kMinDelayMs       = 0.1f;

    PhanjerEffect() : XlethEffectBase("phanjer", createLayout())
    {
        // Continuous params. f_rate / p_rate / f_delay_min / f_delay_max use a
        // manual 50 ms one-pole instead (see prepareEffect) — delay-time and
        // rate changes must glide, not zipper, and not ramp linearly.
        registerSmoothedParam("f_mix",      SmoothType::Linear,         20.0f);
        registerSmoothedParam("f_depth",    SmoothType::Linear,         20.0f);
        registerSmoothedParam("f_feedback", SmoothType::Linear,         20.0f);
        registerSmoothedParam("p_mix",      SmoothType::Linear,         20.0f);
        registerSmoothedParam("p_depth",    SmoothType::Linear,         20.0f);
        registerSmoothedParam("p_feedback", SmoothType::Linear,         20.0f);
        registerSmoothedParam("global_mix", SmoothType::Linear,         20.0f);
        registerSmoothedParam("chaos",      SmoothType::Linear,         20.0f);
        registerSmoothedParam("p_freq_min", SmoothType::Multiplicative, 30.0f);
        registerSmoothedParam("p_freq_max", SmoothType::Multiplicative, 30.0f);

        // Fixed-seed xorshift32, decorrelated across instances (§4).
        static std::atomic<std::uint32_t> sInstanceCounter{0};
        rngSeed_ = 0x9E3779B9u ^ (sInstanceCounter.fetch_add(1u, std::memory_order_relaxed) * 2654435761u);
        if (rngSeed_ == 0u) rngSeed_ = 0x9E3779B9u;   // xorshift32 must never be 0
        rng_ = rngSeed_;
    }

    // ═══ Pure helpers (static, allocation-free — the test harness calls these
    //     directly, and the audio path uses exactly the same code) ═══════════

    // ── resolveRateHz ────────────────────────────────────────────────────────
    // One LFO cycle per note value. divIndex: 0=1/1 … 5=1/32.
    // feelIndex: 0=Straight, 1=Triplet (note is 2/3 as long → 3/2 the rate),
    // 2=Dotted (3/2 as long → 2/3 the rate).
    //   beats per cycle = 4 / denominator × feelLength
    //   rateHz          = (bpm/60) / beatsPerCycle
    static float resolveRateHz(float rawRateHz, bool syncOn, int divIndex,
                               int feelIndex, double bpm) noexcept
    {
        if (!syncOn)
            return rawRateHz;

        static constexpr float kDenominator[kNumDivs] = { 1.0f, 2.0f, 4.0f, 8.0f, 16.0f, 32.0f };
        const int   d   = std::clamp(divIndex, 0, kNumDivs - 1);
        const int   f   = std::clamp(feelIndex, 0, kNumFeels - 1);
        const float len = (f == kTriplet) ? (2.0f / 3.0f)
                        : (f == kDotted)  ? (3.0f / 2.0f)
                                          : 1.0f;

        const float beatsPerCycle = (4.0f / kDenominator[d]) * len;
        const float beatHz        = static_cast<float>(bpm) / 60.0f;
        const float hz            = beatHz / std::max(beatsPerCycle, 1.0e-6f);
        return std::clamp(hz, 0.001f, 50.0f);
    }

    // ── computeDelayMs ───────────────────────────────────────────────────────
    // Log sweep across the [min,max] bound pair: d = lo · (hi/lo)^u.
    // Bounds are swapped if min > max and clamped to the param range.
    static float computeDelayMs(float u, float delayMinMs, float delayMaxMs) noexcept
    {
        float lo = std::clamp(std::min(delayMinMs, delayMaxMs), kMinDelayMs, kMaxDelayMs);
        float hi = std::clamp(std::max(delayMinMs, delayMaxMs), kMinDelayMs, kMaxDelayMs);
        if (hi <= lo * 1.000001f)
            return lo;
        return lo * std::exp(std::clamp(u, 0.0f, 1.0f) * std::log(hi / lo));
    }

    // ── computeStageFreqs ────────────────────────────────────────────────────
    // Per-stage allpass breakpoints for sweep position s ∈ [−0.5, +0.5]:
    //   c        = sqrt(fMin·fMax)                     (geometric centre)
    //   stageT_i = (N>1) ? i/(N−1) − 0.5 : 0           (±0.5, fixed stagger)
    //   f_i      = c · exp((s + 0.5·stageT_i) · ln(fMax/c))
    // The 0.5·stageT term equals XlethPhaserEffect's spread = 50 %.
    // `out` must have room for numStages entries (≤ kMaxStages).
    static void computeStageFreqs(float sweepS, float freqMin, float freqMax,
                                  int numStages, float sampleRate, float* out) noexcept
    {
        const float lo = std::max(20.0f, std::min(freqMin, freqMax));
        const float hi = std::max(lo * 1.01f, std::max(freqMin, freqMax));
        const float c  = std::sqrt(lo * hi);
        const float halfRangeLog = std::log(hi / c);
        const int   n  = std::clamp(numStages, 1, kMaxStages);

        for (int i = 0; i < n; ++i)
        {
            const float stageT = (n > 1)
                ? static_cast<float>(i) / static_cast<float>(n - 1) - 0.5f
                : 0.0f;
            const float f = c * std::exp((sweepS + 0.5f * stageT) * halfRangeLog);
            out[i] = std::clamp(f, 20.0f, sampleRate * 0.499f);
        }
    }

    // ── computeCollisionMetric ───────────────────────────────────────────────
    // The analytic heart of the plugin (§5). Both combs are known in closed
    // form, so collisions are exact and cheap:
    //   FP = { k/dF          : k = 1..8, < 8 kHz }   flanger peaks
    //   FN = { (k+½)/dF      : k = 0..7, < 8 kHz }   flanger notches
    //   PN = { f_i }                                 phaser notches
    //   PP = { sqrt(f_i·f_i+1) }                     phaser feedback peaks
    // Negative feedback flips which frequencies reinforce, so it swaps
    // FP↔FN / PN↔PP BEFORE pairing. δ is the minimum |log2(fa/fb)| over the
    // peak-peak and notch-notch pair classes; C = max(0, 1 − δ/⅓octave).
    // Returns C ∈ [0,1]; 1 = exact coincidence.
    static float computeCollisionMetric(float flangerDelaySec,
                                        bool  flangerFeedbackNegative,
                                        const float* phaserStageFreqs,
                                        int   numStages,
                                        bool  phaserFeedbackNegative) noexcept
    {
        // ── Flanger feature sets (fixed-size stack arrays, no allocation) ────
        float peaks[kMaxCombFeatures]   = {};
        float notches[kMaxCombFeatures] = {};
        int   numPeaks = 0, numNotches = 0;

        if (flangerDelaySec > 1.0e-9f)
        {
            const float f0 = 1.0f / flangerDelaySec;   // comb spacing
            for (int k = 1; k <= kMaxCombFeatures; ++k)
            {
                const float f = static_cast<float>(k) * f0;
                if (f >= kFeatureCeilingHz) break;
                peaks[numPeaks++] = f;
            }
            for (int k = 0; k < kMaxCombFeatures; ++k)
            {
                const float f = (static_cast<float>(k) + 0.5f) * f0;
                if (f >= kFeatureCeilingHz) break;
                notches[numNotches++] = f;
            }
        }

        // ── Phaser feature sets ──────────────────────────────────────────────
        const int n = std::clamp(numStages, 0, kMaxStages);
        float pNotch[kMaxStages]     = {};
        float pPeak[kMaxStages - 1]  = {};
        int   numPNotch = 0, numPPeak = 0;

        for (int i = 0; i < n; ++i)
            if (phaserStageFreqs[i] > 0.0f)
                pNotch[numPNotch++] = phaserStageFreqs[i];

        for (int i = 0; i + 1 < numPNotch; ++i)
            pPeak[numPPeak++] = std::sqrt(pNotch[i] * pNotch[i + 1]);

        // ── Negative-feedback role swap (§5, DO NOT #4) ──────────────────────
        const float* FP = flangerFeedbackNegative ? notches : peaks;
        const int    nFP = flangerFeedbackNegative ? numNotches : numPeaks;
        const float* FN = flangerFeedbackNegative ? peaks : notches;
        const int    nFN = flangerFeedbackNegative ? numPeaks : numNotches;

        // pNotch/pPeak are separate arrays so the swap is a pointer swap too.
        const float* PP = phaserFeedbackNegative ? pNotch : pPeak;
        const int    nPP = phaserFeedbackNegative ? numPNotch : numPPeak;
        const float* PN = phaserFeedbackNegative ? pPeak : pNotch;
        const int    nPN = phaserFeedbackNegative ? numPPeak : numPNotch;

        // ── δ = min |log2(fa/fb)| over peak-peak ∪ notch-notch ───────────────
        float delta = 1.0e9f;
        delta = std::min(delta, minLogDistance(FP, nFP, PP, nPP));
        delta = std::min(delta, minLogDistance(FN, nFN, PN, nPN));

        if (delta >= 1.0e8f)
            return 0.0f;   // one of the sets was empty — nothing can collide

        return std::clamp(1.0f - delta / kGuardBandOctaves, 0.0f, 1.0f);
    }

    // ── prepareEffect ────────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;
        const float sr = static_cast<float>(sampleRate);

        // Worst-case read offset is exactly f_delay_max = 20 ms (depth scales
        // the sweep INSIDE [min,max]; nothing modulates on top of it). Round up
        // to a power of two, +8 samples for the Lagrange3rd cubic kernel.
        maxDelaySamples_ = juce::nextPowerOfTwo(
            static_cast<int>(kMaxDelayMs * 0.001f * sr) + 8);

        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
        spec.numChannels      = 1;   // one mono line per channel

        // setMaximumDelayInSamples MUST precede prepare() — it allocates.
        delayLineL_.setMaximumDelayInSamples(maxDelaySamples_);
        delayLineR_.setMaximumDelayInSamples(maxDelaySamples_);
        delayLineL_.prepare(spec);
        delayLineR_.prepare(spec);

        // ── Raw atomics: discrete params + the four manually-smoothed ones ───
        modePtr_       = apvts_.getRawParameterValue("mode");
        shapePtr_      = apvts_.getRawParameterValue("lfo_shape");
        stagesPtr_     = apvts_.getRawParameterValue("p_stages");
        fSyncPtr_      = apvts_.getRawParameterValue("f_sync");
        fSyncDivPtr_   = apvts_.getRawParameterValue("f_sync_div");
        fSyncFeelPtr_  = apvts_.getRawParameterValue("f_sync_feel");
        pSyncPtr_      = apvts_.getRawParameterValue("p_sync");
        pSyncDivPtr_   = apvts_.getRawParameterValue("p_sync_div");
        pSyncFeelPtr_  = apvts_.getRawParameterValue("p_sync_feel");
        fRatePtr_      = apvts_.getRawParameterValue("f_rate");
        pRatePtr_      = apvts_.getRawParameterValue("p_rate");
        fDelayMinPtr_  = apvts_.getRawParameterValue("f_delay_min");
        fDelayMaxPtr_  = apvts_.getRawParameterValue("f_delay_max");

        // ── Handles resolved once, never per sample ─────────────────────────
        hFMix_      = resolveSmoothed("f_mix");
        hFDepth_    = resolveSmoothed("f_depth");
        hFFeedback_ = resolveSmoothed("f_feedback");
        hPMix_      = resolveSmoothed("p_mix");
        hPDepth_    = resolveSmoothed("p_depth");
        hPFeedback_ = resolveSmoothed("p_feedback");
        hGlobalMix_ = resolveSmoothed("global_mix");
        hChaos_     = resolveSmoothed("chaos");
        hPFreqMin_  = resolveSmoothed("p_freq_min");
        hPFreqMax_  = resolveSmoothed("p_freq_max");

        // ── One-pole coefficients ───────────────────────────────────────────
        param50msCoeff_ = onePoleCoeff(0.050f, sr);   // rates + delay bounds
        lfoSmoothCoeff_ = onePoleCoeff(0.001f, sr);   // 1 ms de-click on u (§4)
        levelAttackCoeff_  = onePoleCoeff(0.005f, sr);
        levelReleaseCoeff_ = onePoleCoeff(0.060f, sr);

        resetEffect();

#ifdef XLETH_DEBUG
        DBG("[Phanjer] prepareEffect sr=" + juce::String(sampleRate)
            + " blockSize=" + juce::String(maxBlockSize)
            + " maxDelay=" + juce::String(maxDelaySamples_) + " samples");
#endif
    }

    // ── resetEffect ──────────────────────────────────────────────────────────
    void resetEffect() override
    {
        delayLineL_.reset();
        delayLineR_.reset();

        for (auto& stage : stages_)
            stage.reset();
        lastCascade_[0] = lastCascade_[1] = 0.0f;

        rng_ = rngSeed_;
        lfoF_ = Lfo{};
        lfoP_ = Lfo{};
        seedLfo(lfoF_);
        seedLfo(lfoP_);

        // Seed the manual smoothers from the live param values so nothing
        // ramps from zero on the first block.
        smoothFRate_    = readRaw(fRatePtr_,     0.5f);
        smoothPRate_    = readRaw(pRatePtr_,     0.35f);
        smoothDelayMin_ = readRaw(fDelayMinPtr_, 1.0f);
        smoothDelayMax_ = readRaw(fDelayMaxPtr_, 5.0f);

        levelGain_   = 1.0f;
        levelTarget_ = 1.0f;
    }

    // ── processEffect ────────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int   numSamples = buffer.getNumSamples();
        const int   numCh      = buffer.getNumChannels();
        const float sr         = static_cast<float>(sampleRate_);

        if (numSamples <= 0 || numCh <= 0)
            return;

        // Lagrange3rd needs delayInSamples+1 available ahead of the write head.
        const float maxDelayF = static_cast<float>(maxDelaySamples_ - 2);

        // ── Discrete params: raw atomics, once per block ─────────────────────
        const int mode   = std::clamp(readRawInt(modePtr_,   kLinked), 0, kNumModes  - 1);
        const int shape  = std::clamp(readRawInt(shapePtr_,  kSine),   0, kNumShapes - 1);
        const int stages = std::clamp(readRawInt(stagesPtr_, 6),       1, kMaxStages);

        const bool fSync    = readRaw(fSyncPtr_, 0.0f) >= 0.5f;
        const bool pSync    = readRaw(pSyncPtr_, 0.0f) >= 0.5f;
        const int  fDiv     = readRawInt(fSyncDivPtr_,  2);
        const int  pDiv     = readRawInt(pSyncDivPtr_,  2);
        const int  fFeel    = readRawInt(fSyncFeelPtr_, kStraight);
        const int  pFeel    = readRawInt(pSyncFeelPtr_, kStraight);
        const double bpm    = getGlobalBPM();

        // Manual one-pole targets — read once, glided per sample below.
        const float targetFRate    = readRaw(fRatePtr_,     0.5f);
        const float targetPRate    = readRaw(pRatePtr_,     0.35f);
        const float targetDelayMin = readRaw(fDelayMinPtr_, 1.0f);
        const float targetDelayMax = readRaw(fDelayMaxPtr_, 5.0f);

        // ── Control-rate leveling update (§5) — once per block, before the
        //    sample loop, evaluated 30 ms into the future so the duck LANDS
        //    before the coincidence rather than after it. ────────────────────
        updateLevelingTarget(mode, shape, stages, fSync, fDiv, fFeel,
                             pSync, pDiv, pFeel, bpm, sr);

        float peakL = 0.0f, peakR = 0.0f;

        for (int s = 0; s < numSamples; ++s)
        {
            // ── 1. Advance smoothers ────────────────────────────────────────
            const float fMix      = hFMix_.next();
            const float fDepth    = hFDepth_.next();
            const float fFeedback = hFFeedback_.next();
            const float pMix      = hPMix_.next();
            const float pDepth    = hPDepth_.next();
            const float pFeedback = hPFeedback_.next();
            const float globalMix = hGlobalMix_.next();
            const float chaos     = hChaos_.next();
            const float pFreqMin  = hPFreqMin_.next();
            const float pFreqMax  = hPFreqMax_.next();

            smoothFRate_    += param50msCoeff_ * (targetFRate    - smoothFRate_);
            smoothPRate_    += param50msCoeff_ * (targetPRate    - smoothPRate_);
            smoothDelayMin_ += param50msCoeff_ * (targetDelayMin - smoothDelayMin_);
            smoothDelayMax_ += param50msCoeff_ * (targetDelayMax - smoothDelayMax_);

            const float chaosNorm = std::clamp(chaos / 100.0f, 0.0f, 1.0f);
            const float fRateHz = resolveRateHz(smoothFRate_, fSync, fDiv, fFeel, bpm);
            const float pRateHz = resolveRateHz(smoothPRate_, pSync, pDiv, pFeel, bpm);

            // ── 2. LFOs ─────────────────────────────────────────────────────
            // LINKED: one shared phase, phaser runs ANTI-PHASE so the two combs
            // cross at maximum relative velocity (minimum dwell). SMART/WILD:
            // independent phases and rates.
            const float uF = advanceLfo(lfoF_, fRateHz, sr, shape, chaosNorm);
            float uP;
            if (mode == kLinked)
                uP = 1.0f - uF;
            else
                uP = advanceLfo(lfoP_, pRateHz, sr, shape, chaosNorm);

            // Depth scales excursion around the sweep midpoint (§4): at depth 0
            // the sweep parks at the geometric centre of its range.
            const float uFeff = 0.5f + (uF - 0.5f) * std::clamp(fDepth / 100.0f, 0.0f, 1.0f);
            const float uPeff = 0.5f + (uP - 0.5f) * std::clamp(pDepth / 100.0f, 0.0f, 1.0f);

            // ── 3. Input ────────────────────────────────────────────────────
            const float inL = buffer.getSample(0, s);
            const float inR = numCh > 1 ? buffer.getSample(1, s) : inL;

            // ── 4. Flanger core — read BEFORE push ──────────────────────────
            // Modulation is mono (the original has no width control), so both
            // channels read at the same delay time; only the state is per-channel.
            const float delayMs = computeDelayMs(uFeff, smoothDelayMin_, smoothDelayMax_);
            const float delaySamples = std::clamp(delayMs * 0.001f * sr, 1.0f, maxDelayF);

            const float flL = delayLineL_.popSample(0, delaySamples, true);
            const float flR = delayLineR_.popSample(0, delaySamples, true);

            const float fFbGain = std::clamp(fFeedback / 100.0f, -0.95f, 0.95f);
            delayLineL_.pushSample(0, inL + std::tanh(flL * fFbGain));
            delayLineR_.pushSample(0, inR + std::tanh(flR * fFbGain));

            // ── 5. Phaser core — biquad allpass cascade with regen ──────────
            const float pFbGain = std::clamp(pFeedback / 100.0f, -0.95f, 0.95f);
            float apL = inL + std::tanh(lastCascade_[0] * pFbGain);
            float apR = inR + std::tanh(lastCascade_[1] * pFbGain);

            float stageFreq[kMaxStages];
            computeStageFreqs(uPeff - 0.5f, pFreqMin, pFreqMax, stages, sr, stageFreq);

            for (int i = 0; i < stages; ++i)
            {
                // Mono modulation ⇒ one coefficient set serves both channels.
                float coeffs[5];
                computeBiquadAllpass(stageFreq[i], sr, coeffs);
                apL = stages_[i].process(0, apL, coeffs);
                apR = stages_[i].process(1, apR, coeffs);
            }

            lastCascade_[0] = apL;
            lastCascade_[1] = apR;

            // ── 6. Sum the two comb paths (NO dry in here — §1 / DO NOT #3) ─
            const float mF = std::clamp(fMix / 100.0f, 0.0f, 1.0f);
            const float mP = std::clamp(pMix / 100.0f, 0.0f, 1.0f);
            float sumL = mF * flL + mP * apL;
            float sumR = mF * flR + mP * apR;

            // ── 7. Collision handling ───────────────────────────────────────
            if (mode == kWild)
            {
                // No guard — a soft saturator glues the crossings instead.
                sumL = std::tanh(kSatDrive * sumL) * kInvTanhSatDrive;
                sumR = std::tanh(kSatDrive * sumR) * kInvTanhSatDrive;
                levelGain_ = 1.0f;
            }
            else
            {
                // Asymmetric one-pole: ~5 ms to duck, ~60 ms to let go.
                const float coeff = (levelTarget_ < levelGain_)
                    ? levelAttackCoeff_ : levelReleaseCoeff_;
                levelGain_ += coeff * (levelTarget_ - levelGain_);
                sumL *= levelGain_;
                sumR *= levelGain_;
            }

            // ── 8. Dry enters ONCE, here ────────────────────────────────────
            const float g    = std::clamp(globalMix / 100.0f, 0.0f, 1.0f);
            const float outL = inL + g * sumL;
            const float outR = inR + g * sumR;

            buffer.setSample(0, s, outL);
            if (numCh > 1)
                buffer.setSample(1, s, outR);

            peakL = std::max(peakL, std::abs(outL));
            peakR = std::max(peakR, std::abs(outR));
        }

        writeMeterValue(0, peakL);
        writeMeterValue(1, numCh > 1 ? peakR : peakL);
        writeMeterValue(2, levelGain_);

#ifdef XLETH_DEBUG
        debugThrottle_ += numSamples;
        if (debugThrottle_ >= kDebugInterval)
        {
            debugThrottle_ = 0;
            DBG("[Phanjer] mode=" + juce::String(mode)
                + " shape=" + juce::String(shape)
                + " L=" + juce::String(levelGain_, 3)
                + " Ltarget=" + juce::String(levelTarget_, 3));
        }
#endif
    }

private:
    // ═══ LFO engine (§4) ════════════════════════════════════════════════════

    struct Lfo
    {
        float phase    = 0.0f;   // main cycle position ∈ [0,1)
        float randPrev = 0.5f;   // smooth-random endpoints for the Random shape
        float randNext = 0.5f;
        float phase3   = 0.0f;   // CHAOS source at 3× the LFO rate
        float r3Prev   = 0.0f, r3Next = 0.0f;
        float phase7   = 0.0f;   // CHAOS source at 7× the LFO rate
        float r7Prev   = 0.0f, r7Next = 0.0f;
        float smoothU  = 0.5f;   // 1 ms one-pole state
    };

    static float onePoleCoeff(float tauSec, float sr) noexcept
    {
        return 1.0f - std::exp(-1.0f / std::max(tauSec * sr, 1.0f));
    }

    // xorshift32 → [0,1]
    float nextRand01() noexcept
    {
        rng_ ^= rng_ << 13;
        rng_ ^= rng_ >> 17;
        rng_ ^= rng_ << 5;
        return static_cast<float>(rng_ & 0x00FFFFFFu) / 16777215.0f;
    }

    void seedLfo(Lfo& lfo) noexcept
    {
        lfo.randPrev = nextRand01();
        lfo.randNext = nextRand01();
        lfo.r3Prev   = nextRand01() * 2.0f - 1.0f;
        lfo.r3Next   = nextRand01() * 2.0f - 1.0f;
        lfo.r7Prev   = nextRand01() * 2.0f - 1.0f;
        lfo.r7Next   = nextRand01() * 2.0f - 1.0f;
    }

    // Cubic smoothstep — the "cubic-smoothed interpolation across the cycle"
    // the Random shape and both CHAOS sources use.
    static float smoothCubic(float t) noexcept { return t * t * (3.0f - 2.0f * t); }

    // Shape function φ → u ∈ [0,1]; t is the cycle position ∈ [0,1).
    static float shapeAt(int shape, float t, float randPrev, float randNext) noexcept
    {
        switch (shape)
        {
            case kSine:     return 0.5f + 0.5f * std::sin(t * juce::MathConstants<float>::twoPi);
            case kTriangle: return 1.0f - std::abs(2.0f * t - 1.0f);
            case kSaw:      return t;
            case kSquare:   return t < 0.5f ? 1.0f : 0.0f;
            case kRandom:   return randPrev + (randNext - randPrev) * smoothCubic(t);
            default:        return 0.5f;
        }
    }

    // Advance one sample and return u — CHAOS applied, then the single 1 ms
    // one-pole (DO NOT #2: no other smoothing is ever stacked on the LFO).
    float advanceLfo(Lfo& lfo, float rateHz, float sr, int shape, float chaosNorm) noexcept
    {
        const float inc = std::max(rateHz, 0.0f) / sr;

        lfo.phase += inc;
        while (lfo.phase >= 1.0f)
        {
            lfo.phase -= 1.0f;
            lfo.randPrev = lfo.randNext;
            lfo.randNext = nextRand01();
        }

        float u = shapeAt(shape, lfo.phase, lfo.randPrev, lfo.randNext);

        if (shape == kRandom)
        {
            // Sources keep running whatever CHAOS reads, so turning the knob up
            // never jumps the trajectory.
            lfo.phase3 += inc * 3.0f;
            while (lfo.phase3 >= 1.0f)
            {
                lfo.phase3 -= 1.0f;
                lfo.r3Prev = lfo.r3Next;
                lfo.r3Next = nextRand01() * 2.0f - 1.0f;
            }
            lfo.phase7 += inc * 7.0f;
            while (lfo.phase7 >= 1.0f)
            {
                lfo.phase7 -= 1.0f;
                lfo.r7Prev = lfo.r7Next;
                lfo.r7Next = nextRand01() * 2.0f - 1.0f;
            }

            if (chaosNorm > 0.0f)
            {
                const float r3 = lfo.r3Prev + (lfo.r3Next - lfo.r3Prev) * smoothCubic(lfo.phase3);
                const float r7 = lfo.r7Prev + (lfo.r7Next - lfo.r7Prev) * smoothCubic(lfo.phase7);
                u = std::clamp(u + chaosNorm * (0.5f * r3 + 0.25f * r7), 0.0f, 1.0f);
            }
        }

        lfo.smoothU += lfoSmoothCoeff_ * (u - lfo.smoothU);
        return lfo.smoothU;
    }

    // Non-mutating projection of u at `aheadSec` into the future. Phases are
    // known constants, so this is pure arithmetic on a scratch copy — no state
    // is touched and no RNG is consumed. For the Random shape a wrapped cycle
    // holds at the already-determined next target (there is no further target
    // yet, by construction).
    static float lookaheadU(const Lfo& lfo, float rateHz, int shape,
                            float chaosNorm, float aheadSec) noexcept
    {
        const float adv = std::max(rateHz, 0.0f) * aheadSec;   // in cycles

        float t = lfo.phase + adv;
        float prev = lfo.randPrev, next = lfo.randNext;
        if (t >= 1.0f) prev = next;
        t -= std::floor(t);

        float u = shapeAt(shape, t, prev, next);

        if (shape == kRandom && chaosNorm > 0.0f)
        {
            float t3 = lfo.phase3 + adv * 3.0f;
            float p3 = lfo.r3Prev, n3 = lfo.r3Next;
            if (t3 >= 1.0f) p3 = n3;
            t3 -= std::floor(t3);

            float t7 = lfo.phase7 + adv * 7.0f;
            float p7 = lfo.r7Prev, n7 = lfo.r7Next;
            if (t7 >= 1.0f) p7 = n7;
            t7 -= std::floor(t7);

            const float r3 = p3 + (n3 - p3) * smoothCubic(t3);
            const float r7 = p7 + (n7 - p7) * smoothCubic(t7);
            u = u + chaosNorm * (0.5f * r3 + 0.25f * r7);
        }

        return std::clamp(u, 0.0f, 1.0f);
    }

    // ═══ Collision engine plumbing ══════════════════════════════════════════

    static float minLogDistance(const float* a, int na, const float* b, int nb) noexcept
    {
        float best = 1.0e9f;
        for (int i = 0; i < na; ++i)
        {
            if (a[i] <= 0.0f) continue;
            for (int j = 0; j < nb; ++j)
            {
                if (b[j] <= 0.0f) continue;
                const float d = std::abs(std::log2(a[i] / b[j]));
                best = std::min(best, d);
            }
        }
        return best;
    }

    // Control-rate: compute L_target for this block from the 30 ms lookahead.
    void updateLevelingTarget(int mode, int shape, int stages,
                              bool fSync, int fDiv, int fFeel,
                              bool pSync, int pDiv, int pFeel,
                              double bpm, float sr) noexcept
    {
        if (mode == kWild)
        {
            levelTarget_ = 1.0f;   // guard off (§5 config table)
            return;
        }

        const float chaosNorm = std::clamp(hChaos_.current() / 100.0f, 0.0f, 1.0f);
        const float fRateHz = resolveRateHz(smoothFRate_, fSync, fDiv, fFeel, bpm);
        const float pRateHz = resolveRateHz(smoothPRate_, pSync, pDiv, pFeel, bpm);

        const float uF = lookaheadU(lfoF_, fRateHz, shape, chaosNorm, kLookaheadSec);
        const float uP = (mode == kLinked)
            ? 1.0f - uF
            : lookaheadU(lfoP_, pRateHz, shape, chaosNorm, kLookaheadSec);

        const float uFeff = 0.5f + (uF - 0.5f)
                          * std::clamp(hFDepth_.current() / 100.0f, 0.0f, 1.0f);
        const float uPeff = 0.5f + (uP - 0.5f)
                          * std::clamp(hPDepth_.current() / 100.0f, 0.0f, 1.0f);

        const float delaySec = computeDelayMs(uFeff, smoothDelayMin_, smoothDelayMax_) * 0.001f;

        float stageFreq[kMaxStages];
        computeStageFreqs(uPeff - 0.5f, hPFreqMin_.current(), hPFreqMax_.current(),
                          stages, sr, stageFreq);

        const float C = computeCollisionMetric(delaySec,
                                               hFFeedback_.current() < 0.0f,
                                               stageFreq, stages,
                                               hPFeedback_.current() < 0.0f);

        levelTarget_ = 1.0f - 0.5f * C;   // up to −6 dB at exact coincidence
    }

    // ═══ Phaser biquad allpass (Direct Form II Transposed) ══════════════════

    struct BiquadAllpassStage
    {
        float z1[2] = {0.0f, 0.0f};   // [0] = L, [1] = R
        float z2[2] = {0.0f, 0.0f};

        void reset()
        {
            z1[0] = z1[1] = 0.0f;
            z2[0] = z2[1] = 0.0f;
        }

        // coeffs: [b0/a0, b1/a0, b2/a0, a1/a0, a2/a0] (pre-normalised)
        float process(int ch, float input, const float* c)
        {
            const float output = c[0] * input + z1[ch];
            z1[ch] = c[1] * input - c[3] * output + z2[ch];
            z2[ch] = c[2] * input - c[4] * output;
            return output;
        }
    };

    // Audio EQ Cookbook allpass at fixed Q = 1.0 (no resonance knob — DO NOT #1).
    static void computeBiquadAllpass(float fc, float sr, float* out) noexcept
    {
        constexpr float Q = 1.0f;
        const float w0    = juce::MathConstants<float>::twoPi * fc / sr;
        const float cosw0 = std::cos(w0);
        const float sinw0 = std::sin(w0);
        const float alpha = sinw0 / (2.0f * Q);

        const float invA0 = 1.0f / (1.0f + alpha);

        out[0] = (1.0f - alpha) * invA0;    // b0/a0
        out[1] = (-2.0f * cosw0) * invA0;   // b1/a0
        out[2] = (1.0f + alpha) * invA0;    // b2/a0
        out[3] = (-2.0f * cosw0) * invA0;   // a1/a0
        out[4] = (1.0f - alpha) * invA0;    // a2/a0
    }

    // ═══ Parameter layout (the §2 id table, verbatim) ═══════════════════════

    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            // ── Header ──────────────────────────────────────────────────────
            std::make_unique<Apf>(Pid{"mode",        1}, "Mode",
                Nar{0.0f,   2.0f,     1.0f, 1.0f},   0.0f,    ""),

            // ── Flanger column ──────────────────────────────────────────────
            std::make_unique<Apf>(Pid{"f_mix",       1}, "Flanger Mix",
                Nar{0.0f,   100.0f,   0.0f, 1.0f},   75.0f,   "%"),
            std::make_unique<Apf>(Pid{"f_rate",      1}, "Flanger Rate",
                Nar{0.05f,  10.0f,    0.0f, 0.5f},   0.5f,    "Hz"),
            std::make_unique<Apf>(Pid{"f_depth",     1}, "Flanger Depth",
                Nar{0.0f,   100.0f,   0.0f, 1.0f},   70.0f,   "%"),
            std::make_unique<Apf>(Pid{"f_feedback",  1}, "Flanger Feedback",
                Nar{-95.0f, 95.0f,    0.0f, 1.0f},   40.0f,   "%"),
            std::make_unique<Apf>(Pid{"f_delay_min", 1}, "Flanger Delay Min",
                Nar{0.1f,   20.0f,    0.0f, 0.5f},   1.0f,    "ms"),
            std::make_unique<Apf>(Pid{"f_delay_max", 1}, "Flanger Delay Max",
                Nar{0.1f,   20.0f,    0.0f, 0.5f},   5.0f,    "ms"),
            std::make_unique<Apf>(Pid{"f_sync",      1}, "Flanger Sync",
                Nar{0.0f,   1.0f,     1.0f, 1.0f},   0.0f,    ""),
            std::make_unique<Apf>(Pid{"f_sync_div",  1}, "Flanger Division",
                Nar{0.0f,   5.0f,     1.0f, 1.0f},   2.0f,    ""),
            std::make_unique<Apf>(Pid{"f_sync_feel", 1}, "Flanger Feel",
                Nar{0.0f,   2.0f,     1.0f, 1.0f},   0.0f,    ""),

            // ── Phaser column ───────────────────────────────────────────────
            std::make_unique<Apf>(Pid{"p_mix",       1}, "Phaser Mix",
                Nar{0.0f,   100.0f,   0.0f, 1.0f},   75.0f,   "%"),
            std::make_unique<Apf>(Pid{"p_rate",      1}, "Phaser Rate",
                Nar{0.05f,  10.0f,    0.0f, 0.5f},   0.35f,   "Hz"),
            std::make_unique<Apf>(Pid{"p_depth",     1}, "Phaser Depth",
                Nar{0.0f,   100.0f,   0.0f, 1.0f},   80.0f,   "%"),
            std::make_unique<Apf>(Pid{"p_feedback",  1}, "Phaser Feedback",
                Nar{-95.0f, 95.0f,    0.0f, 1.0f},   40.0f,   "%"),
            std::make_unique<Apf>(Pid{"p_stages",    1}, "Phaser Stages",
                Nar{1.0f,   6.0f,     1.0f, 1.0f},   6.0f,    ""),
            std::make_unique<Apf>(Pid{"p_freq_min",  1}, "Phaser Freq Min",
                Nar{20.0f,  2000.0f,  0.0f, 0.3f},   100.0f,  "Hz"),
            std::make_unique<Apf>(Pid{"p_freq_max",  1}, "Phaser Freq Max",
                Nar{200.0f, 16000.0f, 0.0f, 0.23f},  4000.0f, "Hz"),
            std::make_unique<Apf>(Pid{"p_sync",      1}, "Phaser Sync",
                Nar{0.0f,   1.0f,     1.0f, 1.0f},   0.0f,    ""),
            std::make_unique<Apf>(Pid{"p_sync_div",  1}, "Phaser Division",
                Nar{0.0f,   5.0f,     1.0f, 1.0f},   2.0f,    ""),
            std::make_unique<Apf>(Pid{"p_sync_feel", 1}, "Phaser Feel",
                Nar{0.0f,   2.0f,     1.0f, 1.0f},   0.0f,    ""),

            // ── Centre column ───────────────────────────────────────────────
            std::make_unique<Apf>(Pid{"global_mix",  1}, "Global Mix",
                Nar{0.0f,   100.0f,   0.0f, 1.0f},   50.0f,   "%"),
            std::make_unique<Apf>(Pid{"lfo_shape",   1}, "LFO Shape",
                Nar{0.0f,   4.0f,     1.0f, 1.0f},   0.0f,    ""),
            std::make_unique<Apf>(Pid{"chaos",       1}, "Chaos",
                Nar{0.0f,   100.0f,   0.0f, 1.0f},   0.0f,    "%"),
        };
    }

    // ── Raw-atomic helpers ───────────────────────────────────────────────────
    static float readRaw(const std::atomic<float>* p, float fallback) noexcept
    {
        return p ? p->load(std::memory_order_relaxed) : fallback;
    }

    static int readRawInt(const std::atomic<float>* p, int fallback) noexcept
    {
        return p ? static_cast<int>(std::lround(p->load(std::memory_order_relaxed)))
                 : fallback;
    }

    // ── Constants ────────────────────────────────────────────────────────────
    static constexpr float kSatDrive        = 1.5f;
    static constexpr float kInvTanhSatDrive = 1.1047914f;   // 1 / tanh(1.5)
    static constexpr int   kDebugInterval   = 44100;

    // ── State ────────────────────────────────────────────────────────────────
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Lagrange3rd>
        delayLineL_, delayLineR_;
    int    maxDelaySamples_ = 0;
    double sampleRate_      = 44100.0;

    BiquadAllpassStage stages_[kMaxStages];
    float lastCascade_[2] = {0.0f, 0.0f};

    Lfo lfoF_, lfoP_;
    std::uint32_t rng_     = 0x9E3779B9u;
    std::uint32_t rngSeed_ = 0x9E3779B9u;

    // Manual 50 ms one-poles (rates + delay bounds).
    float smoothFRate_     = 0.5f;
    float smoothPRate_     = 0.35f;
    float smoothDelayMin_  = 1.0f;
    float smoothDelayMax_  = 5.0f;
    float param50msCoeff_  = 0.0f;
    float lfoSmoothCoeff_  = 0.0f;

    // Leveling guard.
    float levelGain_          = 1.0f;
    float levelTarget_        = 1.0f;
    float levelAttackCoeff_   = 0.0f;
    float levelReleaseCoeff_  = 0.0f;

    // Raw APVTS pointers (discrete + manually smoothed params).
    std::atomic<float>* modePtr_       = nullptr;
    std::atomic<float>* shapePtr_      = nullptr;
    std::atomic<float>* stagesPtr_     = nullptr;
    std::atomic<float>* fSyncPtr_      = nullptr;
    std::atomic<float>* fSyncDivPtr_   = nullptr;
    std::atomic<float>* fSyncFeelPtr_  = nullptr;
    std::atomic<float>* pSyncPtr_      = nullptr;
    std::atomic<float>* pSyncDivPtr_   = nullptr;
    std::atomic<float>* pSyncFeelPtr_  = nullptr;
    std::atomic<float>* fRatePtr_      = nullptr;
    std::atomic<float>* pRatePtr_      = nullptr;
    std::atomic<float>* fDelayMinPtr_  = nullptr;
    std::atomic<float>* fDelayMaxPtr_  = nullptr;

    // Smoother handles (resolved once in prepareEffect).
    SmoothedHandle hFMix_, hFDepth_, hFFeedback_,
                   hPMix_, hPDepth_, hPFeedback_,
                   hGlobalMix_, hChaos_, hPFreqMin_, hPFreqMax_;

#ifdef XLETH_DEBUG
    int debugThrottle_ = 0;
#endif
};
