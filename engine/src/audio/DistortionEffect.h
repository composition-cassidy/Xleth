#pragma once

#include "audio/XlethEffectBase.h"

#include <atomic>

// Stub distortion effect (pass-through POC)
// pluginId: "distortion"

class DistortionEffect : public XlethEffectBase
{
public:
    DistortionEffect() : XlethEffectBase("distortion") {}

    void processEffect(juce::AudioBuffer<float>& /*buffer*/, juce::MidiBuffer& /*midi*/) override {}

private:
    std::atomic<float> drive_{0.5f};
    std::atomic<float> tone_{0.5f};
    std::atomic<float> mix_{1.0f};
};
