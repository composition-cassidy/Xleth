#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_basics/juce_audio_basics.h>

#include "util/RtPublished.h"

#include <memory>
#include <string>
#include <vector>

// Ids are handed out once and never reused. The id -> buffer table is an
// immutable snapshot published through RtPublished: a load or unload copies it,
// edits the copy and publishes; the old table is retired and freed on the
// main thread once no reader still pins it. Storage holds live samples only,
// so it does not grow with every load, and a reader's table never reallocates.
class SampleBank
{
    struct LoadedSample;

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

    // One published id -> sample table. Never changes once published.
    class Table
    {
    public:
        // nullptr / 0.0 when `id` is not in this table. No allocation, no locks.
        const juce::AudioBuffer<float>* getSample(int id) const noexcept;
        double getSampleBufferRate(int id) const noexcept;

    private:
        friend class SampleBank;
        struct Slot { int id; std::shared_ptr<const LoadedSample> sample; };
        std::vector<Slot> slots;   // ascending id
        const Slot* find(int id) const noexcept;
    };
    using Pin = std::shared_ptr<const Table>;

    // Any thread; the audio thread once per block (MixEngine, VoiceManager).
    // Every buffer the pinned table lists stays alive while the pin is held,
    // whatever is unloaded meanwhile, and dropping the pin never frees one
    // (RtPublished: the retire list outlives every reader).
    Pin pin() const noexcept { return table_.load(); }

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

    // Main thread (the one that unloads). Returns nullptr if sampleId was never
    // handed out OR has been unloaded. The pointer stays valid until this
    // thread unloads that id; any other thread reads through pin() instead.
    const juce::AudioBuffer<float>* getSample(int sampleId) const;

    // Main thread. The same buffer with shared ownership: it outlives an
    // unload for as long as the result is held (a waveform mipmap generating
    // from it on another thread). nullptr when getSample would be.
    std::shared_ptr<const juce::AudioBuffer<float>> getSampleShared(int sampleId) const;

    // Slots in storage, which is exactly the live samples (unloaded ids are
    // removed, not tombstoned). Not an id bound: ids are never reused, so
    // live ids are sparse.
    int        getNumSamples()            const;

    // Every live id, ascending. Main thread.
    std::vector<int> liveIds() const;

    // Returns an empty SampleInfo if sampleId was never handed out OR unloaded.
    SampleInfo getSampleInfo(int sampleId) const;

    // Bake-rate lookup. Returns the rate the stored samples are at
    // (SampleInfo::bufferSampleRate), or 0.0 if sampleId was never handed out
    // OR unloaded. Copies no juce::String. The render loop uses
    // Table::getSampleBufferRate on its pinned table instead.
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

    // Drops `id` from the bank. Every other id stays valid, and `id` is never
    // handed out again: getSample(id), getSampleInfo(id) and
    // countEdgeSilence(id) return their failure values from now on, and
    // restoreSample(id, ...) can bring it back (undo of a bake).
    //
    // The buffer is NOT freed here if anything still holds it: a block that
    // pinned a table listing it reads it to the end of that block, and a
    // getSampleShared() holder keeps it. It is freed on this thread when the
    // last retired table naming it is reclaimed (the next publish, or
    // reclaim()), or by the last shared holder. Never on the audio thread.
    //
    // A block that pins a table published after this call gets nullptr for
    // `id` and skips it. A swap that loads the replacement, remaps to it and
    // only then unloads the old id never silences a block: MixEngine pins the
    // bank after it reads the region map.
    //
    // Idempotent: an id that was never handed out or is already unloaded is
    // a no-op. Call ONLY from the main thread.
    void unloadSample(int id);

    // unloadSample for each id, published once. Main thread.
    void unloadSamples(const std::vector<int>& ids);

    // Frees retired tables no block still pins (RtPublished::prune). Every
    // load / unload does this too; a poll calls it so memory comes back
    // without waiting for the next edit. Main thread.
    void reclaim() { table_.prune(); }

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

    // Puts `buffer`/`info` back under an UNLOADED id, verbatim. The undo path
    // for addSampleFromBuffer: a bake's undo unloads the id it created, and
    // this is what a REDO calls to put the exact same content back without
    // minting a second id. Returns false if `id` was never handed out or is
    // currently LIVE — this is not a replace-in-place primitive for an in-use
    // sample.
    // Call ONLY from the main thread.
    bool restoreSample(int id, const juce::AudioBuffer<float>& buffer, const SampleInfo& info);

private:
    struct LoadedSample
    {
        juce::AudioBuffer<float> buffer;
        SampleInfo               info;
    };

    juce::AudioFormatManager                    formatManager_;
    xleth::util::RtPublished<Table>             table_ { std::make_shared<const Table>() };
    int                                         nextId_ = 0;   // main thread
    bool                                        formatsRegistered_ = false;

    // The live table's entry for `id`, or nullptr. Main thread.
    const LoadedSample* current(int id) const;
    void publish(Table next) { table_.publish(std::make_shared<const Table>(std::move(next))); }

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
    // The store half: adds to the bank under a new id and returns it. Main thread.
    int commitSample(std::unique_ptr<LoadedSample> entry);
    juce::String uniqueSampleName(const juce::String& baseName) const;
};
