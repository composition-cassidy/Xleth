#pragma once

#include "audio/XlethEffectBase.h"

// ─── TestGainEffect ─────────────────────────────────────────────────────────
// Minimal insert effect: applies a smoothed linear gain from an APVTS param.
// Used for integration testing of the effect chain engine.
//
// Parameter layout  : one AudioParameterFloat "gain" in [0, 4], default 1.
// Smoothing         : Linear 20 ms (eliminates zipper noise on fader moves).
// Metering          : peak L → slot 0, peak R → slot 1 after gain is applied.
// pluginId          : "testgain"

class TestGainEffect : public XlethEffectBase
{
public:
    TestGainEffect() : XlethEffectBase("testgain", createLayout())
    {
        registerSmoothedParam("gain", SmoothType::Linear, 20.0f);
    }

    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = buffer.getNumChannels();

        for (int s = 0; s < numSamples; ++s)
        {
            const float g = getNextSmoothedValue("gain");
            for (int ch = 0; ch < numCh; ++ch)
                buffer.setSample(ch, s, buffer.getSample(ch, s) * g);
        }

        // Write peak magnitude per channel to meter slots
        writeMeterValue(0, buffer.getMagnitude(0, 0, numSamples));
        if (numCh > 1)
            writeMeterValue(1, buffer.getMagnitude(1, 0, numSamples));
    }

private:
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        return { std::make_unique<juce::AudioParameterFloat>(
            juce::ParameterID{ "gain", 1 },
            "Gain",
            juce::NormalisableRange<float>(0.0f, 4.0f),
            1.0f) };
    }
};
