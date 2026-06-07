#include "audio/ClipModulatedReader.h"

#include <algorithm>
#include <cmath>

#include "audio/ClipVibratoIntegrator.h"
#include "audio/HermiteInterp.h"
#include "dsp/DeclickEnvelope.h"
#include "model/ClipModulationEvaluator.h"

namespace xleth::audio {

// Reset every state field except `seenThisBlock`. Defined inline in every
// reset path so the three callers stay trivially in lock-step. Adding a new
// State field means updating these three blocks; the alternative (a free
// helper) is blocked by `State` being a private nested type.

void ClipModulatedReader::resetAllStates() noexcept
{
    for (auto& s : states_)
    {
        s.sourcePosD            = 0.0;
        s.vibTrimD              = 0.0;
        s.expectedNextPosInClip = -1;
        s.prevRate              = 1.0;
        s.smoothedRate          = 1.0;
        s.declickRemaining      = 0;
        s.declickWidth          = 0;
        s.declickInverting      = false;
        s.seenThisBlock         = false;
    }
}

void ClipModulatedReader::resetClipState(int clipId) noexcept
{
    auto& s = states_[slotFor(clipId)];
    s.sourcePosD            = 0.0;
    s.vibTrimD              = 0.0;
    s.expectedNextPosInClip = -1;
    s.prevRate              = 1.0;
    s.smoothedRate          = 1.0;
    s.declickRemaining      = 0;
    s.declickWidth          = 0;
    s.declickInverting      = false;
    s.seenThisBlock         = false;
}

void ClipModulatedReader::markClipSeen(int clipId) noexcept
{
    states_[slotFor(clipId)].seenThisBlock = true;
}

void ClipModulatedReader::resetUnseenStates() noexcept
{
    for (auto& s : states_)
    {
        if (!s.seenThisBlock)
        {
            s.sourcePosD            = 0.0;
            s.vibTrimD              = 0.0;
            s.expectedNextPosInClip = -1;
            s.prevRate              = 1.0;
            s.smoothedRate          = 1.0;
            s.declickRemaining      = 0;
            s.declickWidth          = 0;
            s.declickInverting      = false;
        }
        s.seenThisBlock = false;
    }
}

void ClipModulatedReader::renderBlock(const BlockParams& p,
                                      juce::AudioBuffer<float>& trackBuf,
                                      int clipId) noexcept
{
    if (p.srcBuf == nullptr || p.modulation == nullptr) return;
    if (p.numOutputSamples <= 0) return;

    const int srcChannels = p.srcBuf->getNumChannels();
    const int srcTotal    = p.srcBuf->getNumSamples();
    if (srcChannels <= 0 || srcTotal <= 0) return;

    // Hoist the static (non-vibrato) pitch term once per block. Inside the
    // sample loop we multiply by the vibrato term that varies per sample.
    const double staticCents = static_cast<double>(p.pitchOffsetSemis) * 100.0
                             + static_cast<double>(p.pitchOffsetCents);
    const double staticRatio = centsToRatio(staticCents);

    // Bake-rate → prepared-rate readhead correction. All source-sample terms
    // below (the static/vibrato advance, the seed, the scratch base + residual)
    // are in prepared-rate units and must scale by srFactor to address the
    // bake-rate buffer. Callers that don't supply the rates (legacy/tests) fall
    // back to p.sampleRate for both → srFactor 1.0 and the original behaviour.
    const double bakeSR     = (p.srcSampleRate      > 0.0) ? p.srcSampleRate      : p.sampleRate;
    const double preparedSR = (p.preparedSampleRate > 0.0) ? p.preparedSampleRate : p.sampleRate;
    const double srFactor   = (preparedSR > 0.0) ? bakeSR / preparedSR : 1.0;

    State& st = states_[slotFor(clipId)];

    const int64_t clipLen = p.clipEndSample - p.clipStartSample;
    const double  invSampleRate = (p.sampleRate > 0.0) ? 1.0 / p.sampleRate : 0.0;
    const double  beatsPerSecond = p.bpm / 60.0;
    const double  clipDurationSeconds = static_cast<double>(clipLen) * invSampleRate;
    const double  clipDurationBeats   = clipDurationSeconds * beatsPerSecond;

    // Phase D.1 — Scratch is active when its enable + curve are both present.
    // When OFF we run the verbatim Phase C loop below; when ON we run the
    // position-style Option A loop with declick + edge-mode handling.
    const bool scratchActive = p.modulation->scratch.enabled
                            && !p.modulation->scratch.curve.empty();

    for (int s = 0; s < p.numOutputSamples; ++s)
    {
        const int64_t absPos = p.bufStart + s;
        if (absPos < p.clipStartSample || absPos >= p.clipEndSample) continue;

        const int64_t posInClip = absPos - p.clipStartSample;
        const int64_t fromEnd   = clipLen - 1 - posInClip;

        // ── Build the per-sample modulation context (shared by both paths) ─
        xleth::clipmod::ClipModulationContext ctx;
        ctx.bpm                 = p.bpm;
        ctx.sampleRate          = p.sampleRate;
        ctx.timelineSamples     = absPos;
        ctx.timelineSeconds     = static_cast<double>(absPos) * invSampleRate;
        ctx.timelineBeats       = ctx.timelineSeconds * beatsPerSecond;
        ctx.clipLocalSamples    = posInClip;
        ctx.clipLocalSeconds    = static_cast<double>(posInClip) * invSampleRate;
        ctx.clipLocalBeats      = ctx.clipLocalSeconds * beatsPerSecond;
        ctx.clipDurationSeconds = clipDurationSeconds;
        ctx.clipDurationBeats   = clipDurationBeats;

        // ── Seed / re-seed on first sample of clip or after a discontinuity.
        if (st.expectedNextPosInClip != posInClip)
        {
            VibratoSourceOffsetParams sp;
            sp.vibrato                  = &p.modulation->vibrato;
            sp.topLevelEnabled          = p.modulation->enabled;
            sp.staticRatio              = staticRatio;
            sp.bpm                      = p.bpm;
            sp.sampleRate               = p.sampleRate;
            sp.clipLocalSamples         = posInClip;
            sp.clipDurationSeconds      = clipDurationSeconds;
            sp.clipDurationBeats        = clipDurationBeats;
            sp.clipStartTimelineSamples = p.clipStartSample;

            const double integratedOff =
                computeVibratoIntegratedSourceOffsetSamples(sp);

            if (scratchActive)
            {
                // Phase D.1 seed: vibTrim carries the full per-sample residual
                //   Σ (staticRatio * vibratoRatio − 1) = integratedOff − N
                // (− N strips the unity readhead motion already encoded in
                // sourceBase). Subtracting N * staticRatio would erase the
                // static-pitch contribution and is wrong (see D.0/D.1 plan).
                st.vibTrimD = (integratedOff - static_cast<double>(posInClip)) * srFactor;

                // Reset declick state so a seek does not fire a phantom flip
                // on the first sample after the discontinuity.
                const auto sEvalAtSeed = xleth::clipmod::evaluateScratch(
                    p.modulation->scratch, ctx, p.modulation->enabled);
                st.prevRate         = sEvalAtSeed.rateMultiplier;
                st.smoothedRate     = sEvalAtSeed.rateMultiplier;
                st.declickRemaining = 0;
                st.declickWidth     = 0;
                st.declickInverting = false;
                st.sourcePosD       = 0.0; // unused while scratch active
            }
            else
            {
                // Legacy Phase C seed. regionOffset (prepared-rate) and the
                // integrated vibrato readhead are both source-sample terms →
                // scale to the bake-rate buffer. srFactor == 1.0 preserves the
                // original seed bit-for-bit.
                st.sourcePosD = (static_cast<double>(p.regionOffsetSamples)
                              + integratedOff) * srFactor;
                st.vibTrimD = 0.0;
            }
        }

        // ── Velocity × per-side fade gain ─────────────────────────────────────
        float gain = p.velocity;

        if (p.fadeInSamples > 0 && posInClip < p.fadeInSamples && p.fadeInLUT != nullptr)
        {
            const float t = static_cast<float>(posInClip) / static_cast<float>(p.fadeInSamples);
            gain *= p.fadeInLUT->sample(t);
        }
        else if (p.fadeInSamples == 0 && p.clipBoundaryFadeN > 0)
        {
            gain *= xleth::dsp::DeclickEnvelope::fadeIn(static_cast<int>(posInClip), p.clipBoundaryFadeN);
        }

        if (p.fadeOutSamples > 0 && fromEnd < p.fadeOutSamples && p.fadeOutLUT != nullptr)
        {
            const float t = static_cast<float>(fromEnd) / static_cast<float>(p.fadeOutSamples);
            gain *= p.fadeOutLUT->sample(t);
        }
        else if (p.fadeOutSamples == 0 && p.clipBoundaryFadeN > 0)
        {
            gain *= xleth::dsp::DeclickEnvelope::fadeOut(static_cast<int>(fromEnd), p.clipBoundaryFadeN);
        }

        // ── Per-sample modulation evaluation ──────────────────────────────
        const auto vEval = xleth::clipmod::evaluateVibrato(p.modulation->vibrato, ctx,
                                                           p.modulation->enabled);

        double readPos       = 0.0;
        bool   silentByEdge  = false;

        if (scratchActive)
        {
            // ── Option A position-style scratch readhead ────────────────────
            const auto sEval = xleth::clipmod::evaluateScratch(
                p.modulation->scratch, ctx, p.modulation->enabled);

            // regionOffset is a prepared-rate sample count → scale to bake rate.
            // The scratch curve offset is in seconds → multiply by the buffer's
            // bake rate directly (this is inherently rate-correct). srFactor == 1
            // and srcSampleRate == sampleRate reproduce the original expression.
            const double sourceBase =
                static_cast<double>(p.regionOffsetSamples) * srFactor
              + sEval.sourceOffsetSeconds * bakeSR;

            readPos = sourceBase + st.vibTrimD;

            // ── One-pole rate slew + Hann microfade on direction flips ─────
            const double slewMs = std::max(0.5, static_cast<double>(
                                            p.modulation->scratch.smoothingMs));
            const double tauSamps = slewMs * 0.001 * p.sampleRate;
            const double alpha    = (tauSamps > 0.0)
                                  ? (1.0 - std::exp(-1.0 / tauSamps))
                                  : 1.0;
            const double targetRate = static_cast<double>(sEval.rateMultiplier);
            const double prevSmoothed = st.smoothedRate;
            st.smoothedRate += alpha * (targetRate - prevSmoothed);

            const double prevR = st.prevRate;
            const double newR  = st.smoothedRate;
            const bool flipped = ((prevR > 0.0 && newR < 0.0)
                               || (prevR < 0.0 && newR > 0.0))
                               && std::abs(prevR) > 0.01
                               && std::abs(newR)  > 0.01;
            if (flipped && st.declickRemaining == 0)
            {
                int width = static_cast<int>(slewMs * 0.001 * p.sampleRate + 0.5);
                if (width < 2) width = 2;
                st.declickWidth     = width;
                st.declickRemaining = width;
                st.declickInverting = true;
            }
            st.prevRate = newR;

            if (st.declickRemaining > 0)
            {
                const int width = std::max(2, st.declickWidth);
                const int half  = std::max(1, width / 2);
                const int phase = width - st.declickRemaining; // 0..width
                if (phase < half)
                {
                    // Fade out the readhead just before the flip.
                    gain *= xleth::dsp::DeclickEnvelope::fadeOut(half - phase, half);
                }
                else
                {
                    // Fade in the new readhead just after the flip.
                    gain *= xleth::dsp::DeclickEnvelope::fadeIn(phase - half, half);
                }
                --st.declickRemaining;
            }

            // ── Edge mode handling (Clamp default; Silence preserves Phase C
            // out-of-bounds-→-zero behaviour). Wrap/PingPong are deferred. ─
            const double maxValid = static_cast<double>(srcTotal - 1);
            using EM = ClipModulation::Scratch::EdgeMode;
            switch (p.modulation->scratch.edgeMode)
            {
                case EM::Clamp:
                {
                    if (readPos < 0.0)            readPos = 0.0;
                    else if (readPos >= maxValid) readPos = std::nextafter(maxValid, 0.0);
                    break;
                }
                case EM::Silence:
                default:
                {
                    if (readPos < 0.0 || readPos >= maxValid)
                        silentByEdge = true;
                    break;
                }
            }

            // Update vibTrim for next sample using the residual. The static +
            // vibrato deviation beyond the scratch-driven unity motion is a
            // source-sample term → scale to the bake rate.
            st.vibTrimD += (staticRatio * vEval.pitchRatio - 1.0) * srFactor;
        }
        else
        {
            // ── Legacy Phase C path (vibrato only, no scratch) ─────────────
            readPos = st.sourcePosD;
            const double instantRatio = staticRatio * vEval.pitchRatio * srFactor;
            st.sourcePosD += instantRatio;
        }

        // ── Hermite read with bounds guard ────────────────────────────────
        float sampleL = 0.0f;
        float sampleR = 0.0f;
        if (!silentByEdge && readPos >= 0.0 && readPos < static_cast<double>(srcTotal - 1))
        {
            if (srcChannels == 1)
            {
                const float v = hermiteSample(*p.srcBuf, 0, readPos);
                sampleL = sampleR = v;
            }
            else
            {
                sampleL = hermiteSample(*p.srcBuf, 0, readPos);
                sampleR = hermiteSample(*p.srcBuf, std::min(1, srcChannels - 1), readPos);
            }
        }

        trackBuf.addSample(0, s, sampleL * gain);
        trackBuf.addSample(1, s, sampleR * gain);

        st.expectedNextPosInClip = posInClip + 1;
    }
}

} // namespace xleth::audio
