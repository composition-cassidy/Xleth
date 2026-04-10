#pragma once

#include "audio/XlethEffectBase.h"

#include <atomic>

// Stub phanjer effect (pass-through POC)
// pluginId: "phanjer"

class PhanjerEffect : public XlethEffectBase
{
public:
    PhanjerEffect() : XlethEffectBase("phanjer") {}

    void processEffect(juce::AudioBuffer<float>& /*buffer*/, juce::MidiBuffer& /*midi*/) override {}

private:
    std::atomic<float> rate_{0.5f};
    std::atomic<float> depth_{0.5f};
    std::atomic<float> mix_{0.5f};
};
