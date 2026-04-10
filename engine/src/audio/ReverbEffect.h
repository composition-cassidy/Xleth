#pragma once

#include "audio/XlethEffectBase.h"

#include <atomic>

// Stub reverb effect (pass-through POC)
// pluginId: "reverb"

class ReverbEffect : public XlethEffectBase
{
public:
    ReverbEffect() : XlethEffectBase("reverb") {}

    void processEffect(juce::AudioBuffer<float>& /*buffer*/, juce::MidiBuffer& /*midi*/) override {}

private:
    std::atomic<float> size_{0.5f};
    std::atomic<float> damping_{0.5f};
    std::atomic<float> mix_{0.3f};
};
