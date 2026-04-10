#pragma once

#include "audio/XlethEffectBase.h"

#include <atomic>

// Stub overdone effect (pass-through POC)
// pluginId: "overdone"

class OverdoneEffect : public XlethEffectBase
{
public:
    OverdoneEffect() : XlethEffectBase("overdone") {}

    void processEffect(juce::AudioBuffer<float>& /*buffer*/, juce::MidiBuffer& /*midi*/) override {}

private:
    std::atomic<float> drive_{0.5f};
    std::atomic<float> mix_{1.0f};
};
