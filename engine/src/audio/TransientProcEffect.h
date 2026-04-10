#pragma once

#include "audio/XlethEffectBase.h"

#include <atomic>

// Stub transient processor effect (pass-through POC)
// pluginId: "transientproc"

class TransientProcEffect : public XlethEffectBase
{
public:
    TransientProcEffect() : XlethEffectBase("transientproc") {}

    void processEffect(juce::AudioBuffer<float>& /*buffer*/, juce::MidiBuffer& /*midi*/) override {}

private:
    std::atomic<float> attack_{0.0f};
    std::atomic<float> sustain_{0.0f};
};
