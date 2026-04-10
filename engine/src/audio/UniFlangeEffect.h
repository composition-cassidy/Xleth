#pragma once

#include "audio/XlethEffectBase.h"

#include <atomic>

// Stub uniflange effect (pass-through POC)
// pluginId: "uniflange"

class UniFlangeEffect : public XlethEffectBase
{
public:
    UniFlangeEffect() : XlethEffectBase("uniflange") {}

    void processEffect(juce::AudioBuffer<float>& /*buffer*/, juce::MidiBuffer& /*midi*/) override {}

private:
    std::atomic<float> rate_{0.5f};
    std::atomic<float> depth_{0.5f};
    std::atomic<float> mix_{0.5f};
};
