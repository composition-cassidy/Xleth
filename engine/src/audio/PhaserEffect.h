#pragma once

#include "audio/XlethEffectBase.h"

#include <atomic>

// Stub phaser effect (pass-through POC)
// pluginId: "phaser"

class PhaserEffect : public XlethEffectBase
{
public:
    PhaserEffect() : XlethEffectBase("phaser") {}

    void processEffect(juce::AudioBuffer<float>& /*buffer*/, juce::MidiBuffer& /*midi*/) override {}

private:
    std::atomic<float> rate_{0.5f};
    std::atomic<float> depth_{0.5f};
    std::atomic<float> feedback_{0.3f};
};
