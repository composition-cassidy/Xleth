#include "SampleProcessor.h"

#include <algorithm>
#include <cmath>

void SampleProcessor::removeDCOffset(juce::AudioBuffer<float>& buffer)
{
    const int numSamples  = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0) return;

    for (int ch = 0; ch < numChannels; ++ch) {
        float* data = buffer.getWritePointer(ch);
        double sum = 0.0;
        for (int i = 0; i < numSamples; ++i) sum += data[i];
        const float mean = static_cast<float>(sum / static_cast<double>(numSamples));
        if (mean == 0.0f) continue;
        for (int i = 0; i < numSamples; ++i) data[i] -= mean;
    }
}

void SampleProcessor::normalize(juce::AudioBuffer<float>& buffer, float targetPeak)
{
    const int numSamples = buffer.getNumSamples();
    if (numSamples <= 0 || buffer.getNumChannels() <= 0) return;

    const float peak = buffer.getMagnitude(0, numSamples);
    if (peak < 1.0e-9f) return;

    const float gain = targetPeak / peak;
    buffer.applyGain(gain);
}

void SampleProcessor::reversePolarity(juce::AudioBuffer<float>& buffer)
{
    buffer.applyGain(-1.0f);
}

void SampleProcessor::reverse(juce::AudioBuffer<float>& buffer)
{
    const int numSamples  = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    for (int ch = 0; ch < numChannels; ++ch) {
        float* data = buffer.getWritePointer(ch);
        std::reverse(data, data + numSamples);
    }
}

void SampleProcessor::applyFlags(juce::AudioBuffer<float>& buffer, const Flags& f)
{
    if (f.dcOffsetRemoved)  removeDCOffset(buffer);
    if (f.normalized)       normalize(buffer);
    if (f.polarityReversed) reversePolarity(buffer);
    if (f.reversed)         reverse(buffer);
}
