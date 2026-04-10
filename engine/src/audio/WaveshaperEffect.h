#pragma once

#include "audio/XlethEffectBase.h"

#include <atomic>

// Stub waveshaper effect (pass-through POC)
// pluginId: "waveshaper"

class WaveshaperEffect : public XlethEffectBase
{
public:
    WaveshaperEffect() : XlethEffectBase("waveshaper") {}

    void processEffect(juce::AudioBuffer<float>& /*buffer*/, juce::MidiBuffer& /*midi*/) override {}

private:
    std::atomic<float> amount_{0.5f};
    std::atomic<float> mix_{1.0f};
};
