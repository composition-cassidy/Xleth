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
        // Rate the STORED samples are actually at — i.e. the engineSampleRate
        // passed at load time (the "bake rate"). Both load paths resample the
        // source to this rate before storing, so the clip-render path must read
        // the buffer at bufferSampleRate / preparedSampleRate to preserve pitch
        // when the export rate differs from the bake rate. Distinct from
        // originalSampleRate (the source file rate), which must NOT be reused
        // for this — see getSampleBufferRate().
        double       bufferSampleRate  = 0.0;
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
    // Returns nullptr if sampleId is out of range OR the slot has been
    // tombstoned by a prior unloadSample() call.
    const juce::AudioBuffer<float>* getSample(int sampleId) const;

    // Returns the total number of slots in the bank, INCLUDING tombstoned
    // slots from prior unloadSample calls. Code that needs a count of LIVE
    // samples must iterate and skip nullptr returns from getSample.
    int        getNumSamples()            const;

    // Returns an empty SampleInfo if sampleId is out of range OR the slot
    // has been tombstoned.
    SampleInfo getSampleInfo(int sampleId) const;

    // Audio-thread-safe bake-rate lookup. Returns the rate the stored samples
    // are at (SampleInfo::bufferSampleRate), or 0.0 if sampleId is out of range
    // OR tombstoned. Unlike getSampleInfo(), this copies no juce::String, so it
    // is safe to call from the render loop (no alloc, no atomic refcount bump).
    double getSampleBufferRate(int sampleId) const noexcept;

    // Returns the index of the first sample (across both channels) whose
    // absolute value reaches `thresholdDb`. Returns 0 if audio breaches the
    // threshold at sample 0, and the buffer length if the sample is entirely
    // below threshold. Returns -1 if sampleId is invalid OR tombstoned.
    // Call from main thread only (reads immutable buffer, no locks needed).
    int64_t getLeadingSilenceSamples(int sampleId, float thresholdDb) const;

    // Tombstones the slot at `id`: frees the audio buffer, leaves the slot
    // index intact so all other IDs remain valid. After this call,
    // getSample(id), getSampleInfo(id), and getLeadingSilenceSamples(id)
    // return their failure values (nullptr / empty / -1) for the
    // tombstoned id.
    //
    // Slots are NOT reused — tombstoned ids stay tombstoned for the process
    // lifetime. Subsequent loadSample / loadSampleFromSource calls allocate
    // fresh slots at the end of the vector.
    //
    // AUDIO-THREAD CONTRACT (load-bearing, do not violate):
    //   The caller MUST ensure no live consumer can produce this id between
    //   the moment unloadSample() returns and the next loadSample-style
    //   call. In practice this means:
    //     1. Remove the corresponding entry from MixEngine::regionToSampleMap_
    //        BEFORE calling unloadSample, so no future findActiveClips()
    //        pass can re-introduce the id into activeClips_.
    //     2. The audio thread's render loop guard at MixEngine.cpp
    //        (`if (srcBuf == nullptr) continue;`) handles the in-flight
    //        block race: an activeClip already enqueued with this id will
    //        get nullptr from getSample on its next read and skip.
    //   Concurrent reads of OTHER slots remain safe.
    //
    // Idempotent: unload of an already-tombstoned id is a no-op. Out-of-range
    // ids are also a no-op. Neither logs an error at runtime.
    // Call ONLY from the main thread.
    void unloadSample(int id);

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
