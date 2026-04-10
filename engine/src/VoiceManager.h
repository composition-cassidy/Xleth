#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include "SampleBank.h"

#include <vector>

struct Voice
{
    int   sampleId        = -1;
    int   playbackPosition = 0;
    float velocity        = 1.0f;
    bool  active          = false;
};

class VoiceManager
{
public:
    explicit VoiceManager(int maxVoices = 32);

    // Start playing a sample. Called from audio thread only — no allocation.
    void triggerSample(int sampleId, float velocity);

    // Mix all active voices into outputBuffer (+=). Called from audio thread.
    void processBlock(juce::AudioBuffer<float>& outputBuffer,
                      const SampleBank&         sampleBank);

    int getActiveVoiceCount() const;

private:
    std::vector<Voice> voices_;
    int                maxVoices_;
};
