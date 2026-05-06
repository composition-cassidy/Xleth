#include "audio/ClipModulatedReader.h"

#include <algorithm>
#include <cmath>

#include "audio/HermiteInterp.h"
#include "dsp/DeclickEnvelope.h"
#include "model/ClipModulationEvaluator.h"

namespace xleth::audio {

void ClipModulatedReader::resetAllStates() noexcept
{
    for (auto& s : states_)
    {
        s.sourcePosD = 0.0;
        s.expectedNextPosInClip = -1;
        s.seenThisBlock = false;
    }
}

void ClipModulatedReader::resetClipState(int clipId) noexcept
{
    auto& s = states_[slotFor(clipId)];
    s.sourcePosD = 0.0;
    s.expectedNextPosInClip = -1;
    s.seenThisBlock = false;
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
            s.sourcePosD = 0.0;
            s.expectedNextPosInClip = -1;
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

    State& st = states_[slotFor(clipId)];

    const int64_t clipLen = p.clipEndSample - p.clipStartSample;
    const double  invSampleRate = (p.sampleRate > 0.0) ? 1.0 / p.sampleRate : 0.0;
    const double  beatsPerSecond = p.bpm / 60.0;
    const double  clipDurationSeconds = static_cast<double>(clipLen) * invSampleRate;
    const double  clipDurationBeats   = clipDurationSeconds * beatsPerSecond;

    for (int s = 0; s < p.numOutputSamples; ++s)
    {
        const int64_t absPos = p.bufStart + s;
        if (absPos < p.clipStartSample || absPos >= p.clipEndSample) continue;

        const int64_t posInClip = absPos - p.clipStartSample;
        const int64_t fromEnd   = clipLen - 1 - posInClip;

        // ── Seed / re-seed sourcePosD ────────────────────────────────────────
        // First activation (posInClip == 0): seed at clip-start offset.
        // Mid-clip seek or stale state: ignore vibrato displacement integral
        // and seed using the static ratio only. Re-integrating vibrato from
        // clip-start would cost up to hundreds of thousands of std::sin calls
        // on the audio thread per seed and would glitch. The existing seek
        // hook already calls allNotesOff, so a tiny one-time phase pop on
        // seeks is consistent with current behavior.
        if (st.expectedNextPosInClip != posInClip)
        {
            st.sourcePosD = static_cast<double>(p.regionOffsetSamples)
                          + staticRatio * static_cast<double>(posInClip);
        }

        // ── Velocity × per-side fade gain ─────────────────────────────────────
        // Identical math to the cache-path loop in MixEngine::processBlock.
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

        // ── Evaluate vibrato pitch for this sample ───────────────────────────
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

        const auto vEval = xleth::clipmod::evaluateVibrato(p.modulation->vibrato, ctx,
                                                           p.modulation->enabled);
        const double instantRatio = staticRatio * vEval.pitchRatio;

        // ── Read source via Hermite, with bounds guard ───────────────────────
        // Hermite needs a one-sample lookahead, so guard sourcePosD < srcTotal-1.
        // Outside the valid range we emit silence (no aliasing to negative or
        // wrapped indices). Bounds violation is expected near clip edges.
        const double pos = st.sourcePosD;
        float sampleL = 0.0f;
        float sampleR = 0.0f;
        if (pos >= 0.0 && pos < static_cast<double>(srcTotal - 1))
        {
            if (srcChannels == 1)
            {
                const float v = hermiteSample(*p.srcBuf, 0, pos);
                sampleL = sampleR = v;
            }
            else
            {
                sampleL = hermiteSample(*p.srcBuf, 0, pos);
                sampleR = hermiteSample(*p.srcBuf, std::min(1, srcChannels - 1), pos);
            }
        }

        trackBuf.addSample(0, s, sampleL * gain);
        trackBuf.addSample(1, s, sampleR * gain);

        // Advance readhead and update continuity marker.
        st.sourcePosD += instantRatio;
        st.expectedNextPosInClip = posInClip + 1;
    }
}

} // namespace xleth::audio
