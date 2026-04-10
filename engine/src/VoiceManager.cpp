#include "VoiceManager.h"

#include <algorithm>

// ─────────────────────────────────────────────────────────────────────────────
VoiceManager::VoiceManager(int maxVoices)
    : maxVoices_(maxVoices)
{
    voices_.resize(static_cast<std::size_t>(maxVoices));
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio thread only — no allocation, no locking
void VoiceManager::triggerSample(int sampleId, float velocity)
{
    // First pass: find a free voice
    for (auto& v : voices_)
    {
        if (!v.active)
        {
            v.sampleId         = sampleId;
            v.playbackPosition = 0;
            v.velocity         = velocity;
            v.active           = true;
            return;
        }
    }

    // All voices busy: steal the one furthest through playback (most samples played)
    int  stealIdx = 0;
    int  maxPos   = -1;
    for (int i = 0; i < static_cast<int>(voices_.size()); ++i)
    {
        if (voices_[i].playbackPosition > maxPos)
        {
            maxPos   = voices_[i].playbackPosition;
            stealIdx = i;
        }
    }

    voices_[stealIdx].sampleId         = sampleId;
    voices_[stealIdx].playbackPosition = 0;
    voices_[stealIdx].velocity         = velocity;
    voices_[stealIdx].active           = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio thread only — no allocation, no locking
void VoiceManager::processBlock(juce::AudioBuffer<float>& outputBuffer,
                                const SampleBank&         sampleBank)
{
    const int numOutChannels = outputBuffer.getNumChannels();
    const int numSamples     = outputBuffer.getNumSamples();

    for (auto& voice : voices_)
    {
        if (!voice.active) continue;

        const auto* srcBuf = sampleBank.getSample(voice.sampleId);
        if (srcBuf == nullptr) { voice.active = false; continue; }

        const int srcChannels = srcBuf->getNumChannels();
        const int srcTotal    = srcBuf->getNumSamples();

        for (int s = 0; s < numSamples; ++s)
        {
            if (voice.playbackPosition >= srcTotal)
            {
                voice.active = false;
                break;
            }

            const int pos = voice.playbackPosition++;

            if (srcChannels == 1)
            {
                // Mono → broadcast to all output channels
                const float sample = srcBuf->getSample(0, pos) * voice.velocity;
                for (int ch = 0; ch < numOutChannels; ++ch)
                    outputBuffer.addSample(ch, s, sample);
            }
            else
            {
                // Stereo (or more) → L→L, R→R, clamp excess source channels
                for (int ch = 0; ch < numOutChannels; ++ch)
                {
                    const int srcCh = std::min(ch, srcChannels - 1);
                    outputBuffer.addSample(ch, s,
                        srcBuf->getSample(srcCh, pos) * voice.velocity);
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
int VoiceManager::getActiveVoiceCount() const
{
    int count = 0;
    for (const auto& v : voices_)
        if (v.active) ++count;
    return count;
}
