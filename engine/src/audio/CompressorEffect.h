#pragma once

#include "audio/XlethEffectBase.h"

#include <atomic>

// Stub compressor effect (pass-through POC)
// pluginId: "compressor"

class CompressorEffect : public XlethEffectBase
{
public:
    CompressorEffect() : XlethEffectBase("compressor") {}

    void processEffect(juce::AudioBuffer<float>& /*buffer*/, juce::MidiBuffer& /*midi*/) override {}

private:
    std::atomic<float> threshold_{-20.0f};
    std::atomic<float> ratio_{4.0f};
    std::atomic<float> makeup_{0.0f};
};
