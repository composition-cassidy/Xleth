#pragma once

#include "audio/XlethEffectBase.h"

#include <atomic>

// Stub limiter effect (pass-through POC)
// pluginId: "limiter"

class LimiterEffect : public XlethEffectBase
{
public:
    LimiterEffect() : XlethEffectBase("limiter") {}

    void processEffect(juce::AudioBuffer<float>& /*buffer*/, juce::MidiBuffer& /*midi*/) override {}

private:
    std::atomic<float> ceiling_{0.0f};
    std::atomic<float> release_{100.0f};
};
