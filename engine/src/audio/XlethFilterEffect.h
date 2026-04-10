#pragma once

#include "audio/XlethEffectBase.h"

#include <atomic>

// Stub filter effect (pass-through POC)
// pluginId: "xlethfilter"

class XlethFilterEffect : public XlethEffectBase
{
public:
    XlethFilterEffect() : XlethEffectBase("xlethfilter") {}

    void processEffect(juce::AudioBuffer<float>& /*buffer*/, juce::MidiBuffer& /*midi*/) override {}

private:
    std::atomic<float> cutoff_{1000.0f};
    std::atomic<float> resonance_{0.5f};
};
