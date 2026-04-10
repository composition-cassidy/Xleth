#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_basics/juce_audio_basics.h>

#include <memory>
#include <vector>

class SampleBank
{
public:
    struct SampleInfo
    {
        juce::String name;
        int          numChannels       = 0;
        int          numSamples        = 0;
        double       originalSampleRate = 0.0;
    };

    // Load a WAV/AIFF file into memory. Returns a unique sample ID (0, 1, 2…).
    // Resamples to engineSampleRate if the file's rate differs.
    // Call ONLY from the main thread.
    int loadSample(const juce::File& file, double engineSampleRate);

    // Load a time range from any media file (video/audio) via FFmpeg.
    // Decodes [startTimeSec, endTimeSec) to stereo float at engineSampleRate.
    // Returns sample ID on success, -1 on failure.
    // Call ONLY from the main thread.
    int loadSampleFromSource(const std::string& filePath,
                             double startTimeSec,
                             double endTimeSec,
                             double engineSampleRate);

    // Thread-safe after load: data is immutable once stored.
    // Returns nullptr if sampleId is out of range.
    const juce::AudioBuffer<float>* getSample(int sampleId) const;

    int        getNumSamples()            const;
    SampleInfo getSampleInfo(int sampleId) const;

    // Returns the index of the first sample (across both channels) whose
    // absolute value reaches `thresholdDb`. Returns 0 if audio breaches the
    // threshold at sample 0, and the buffer length if the sample is entirely
    // below threshold. Returns -1 if sampleId is invalid.
    // Call from main thread only (reads immutable buffer, no locks needed).
    int64_t getLeadingSilenceSamples(int sampleId, float thresholdDb) const;

private:
    struct LoadedSample
    {
        juce::AudioBuffer<float> buffer;
        SampleInfo               info;
    };

    juce::AudioFormatManager                    formatManager_;
    std::vector<std::unique_ptr<LoadedSample>>  samples_;
    bool                                        formatsRegistered_ = false;

    void ensureFormatsRegistered();
    static void applyFades(juce::AudioBuffer<float>& buf, double sampleRate);
};
