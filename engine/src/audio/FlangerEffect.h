#pragma once

#include "audio/XlethEffectBase.h"

#include <atomic>

// Stub flanger effect (pass-through POC)
// pluginId: "flanger"

class FlangerEffect : public XlethEffectBase
{
public:
    FlangerEffect() : XlethEffectBase("flanger") {}

    void processEffect(juce::AudioBuffer<float>& /*buffer*/, juce::MidiBuffer& /*midi*/) override {}

private:
    std::atomic<float> rate_{0.5f};
    std::atomic<float> depth_{0.5f};
    std::atomic<float> feedback_{0.3f};
};
