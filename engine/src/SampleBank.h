#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_basics/juce_audio_basics.h>

#include <memory>
#include <string>
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

    // Batch form of loadSampleFromSource, for project load: decodes every
    // request concurrently on a small thread pool, then stores the results in
    // REQUEST ORDER. Returns one id per request (-1 = that decode failed).
    //
    // Same samples, same ids: each request runs exactly the decode
    // loadSampleFromSource runs (own FFmpeg contexts, nothing shared), and ids
    // are handed out in request order with a failed request taking none, so
    // the result is what calling loadSampleFromSource once per request, in
    // order, would have produced. Only the wall-clock differs.
    //
    // logEachSuccess=false keeps the per-sample "Loaded region" lines out of
    // the log (the caller prints one summary); warnings are always printed.
    // maxThreads <= 0 picks from the machine (cores - 1, at most 12).
    // Call ONLY from the main thread (the decodes it starts touch no bank state).
    struct SourceRequest
    {
        std::string filePath;
        double      startTimeSec = 0.0;
        double      endTimeSec   = 0.0;
        // true: decode to the end the container reports (endTimeSec is ignored;
        // 3600 s when the container reports none). The "whole swapped-audio
        // file" form — the same end a caller would get by probing the file's
        // duration first, without opening it twice.
        bool        toContainerEnd = false;
        // Rate to decode to; 0 = the batch's engineSampleRate.
        double      sampleRate = 0.0;
    };
    std::vector<int> loadSamplesFromSources(const std::vector<SourceRequest>& requests,
                                            double engineSampleRate,
                                            bool logEachSuccess = true,
                                            int maxThreads = 0);

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

    // How many consecutive samples stay below `thresholdDb` at one end of the
    // window [startSample, startSample + length) of this sample's buffer:
    // counted forwards from the window's first sample, or, with fromEnd,
    // backwards from its last. The window is clamped to the buffer. Returns
    // the (clamped) window length when all of it is below threshold, 0 when
    // the first sample examined already reaches it, and -1 if sampleId is
    // invalid OR tombstoned.
    //
    // A window rather than "from sample 0" because that is what a clip plays:
    // it starts regionOffset into the sample and may be reversed, in which case
    // the silence it plays first is at the END of its window.
    // Call from main thread only (reads immutable buffer, no locks needed).
    int64_t countEdgeSilence(int sampleId, float thresholdDb,
                             int64_t startSample, int64_t length, bool fromEnd) const;

    // Tombstones the slot at `id`: frees the audio buffer, leaves the slot
    // index intact so all other IDs remain valid. After this call,
    // getSample(id), getSampleInfo(id), and countEdgeSilence(id)
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

    // ── Sandbox composite bake (SB-5) ─────────────────────────────────────────
    // Registers a NEW asset from an in-memory buffer instead of a file — the
    // Sample Sandbox's bake-to-new-asset path. Copies `buffer`; the caller's
    // own copy is untouched. `baseName` is used as-is unless a LIVE sample
    // already holds it, in which case a numeric " (2)", " (3)", … suffix is
    // appended until it doesn't collide — see uniqueSampleName(). That makes
    // naming deterministic given the same base name and the bank's current
    // contents (the same bake always tries the same first-choice name), but it
    // is NOT coordinated with any other process or a prior run — the bank
    // itself is not persisted, so "stable" here means "not random or
    // timestamp-based," not "globally unique forever."
    // Returns -1 if `buffer` or `sampleRate` is empty/invalid.
    // Call ONLY from the main thread.
    int addSampleFromBuffer(const juce::AudioBuffer<float>& buffer,
                            double sampleRate,
                            const juce::String& baseName);

    // Re-fills a TOMBSTONED slot with `buffer`/`info` verbatim, restoring the
    // same id. The undo path for addSampleFromBuffer: a bake's undo tombstones
    // the slot it created (via unloadSample), and this is what a REDO calls to
    // put the exact same content back without minting a second id. Returns
    // false if `id` is out of range or the slot is currently LIVE — this is
    // not a replace-in-place primitive for an in-use sample.
    // Call ONLY from the main thread.
    bool restoreSample(int id, const juce::AudioBuffer<float>& buffer, const SampleInfo& info);

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
    // The decode half of loadSampleFromSource: any thread, no bank state. Null on
    // failure. Messages the sequential path printed are appended to logOut.
    static std::unique_ptr<LoadedSample> decodeFromSource(const std::string& filePath,
                                                          double startTimeSec,
                                                          double endTimeSec,
                                                          double engineSampleRate,
                                                          std::string& logOut,
                                                          bool toContainerEnd = false);
    // The store half: appends to the bank and returns the new id. Main thread.
    int commitSample(std::unique_ptr<LoadedSample> entry);
    juce::String uniqueSampleName(const juce::String& baseName) const;
};
