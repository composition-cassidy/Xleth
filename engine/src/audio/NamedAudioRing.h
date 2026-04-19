#pragma once

// NamedAudioRing — Windows named shared-memory SPSC ring for deinterleaved
// audio frames.
//
// Producer = worker process (writes from the audio thread inside
// GuardedPluginWrapper::processBlock, post inner_->processBlock). Must be
// audio-thread-safe: zero allocation, zero locking, zero logging on the hot
// path.
//
// Consumer = editor-host process (reads from a dedicated pump thread, feeds
// the editor-process plugin instance's processBlock for analyzer side-effects).
//
// Layout in shared memory:
//   [Header : 64 bytes][channel 0 samples][channel 1 samples] ...
//
// numChannels is pinned at 2 for v1 (GuardedPluginWrapper forces stereo).
// ringSizeSamples is a power of two per channel; writePos = writeIndex & mask.
//
// Overrun policy  (producer): tryWrite returns false, visualisation drops a
// frame. No retry, no stall.
//
// Underrun policy (consumer): tryRead sleeps 1 ms and retries up to
// timeoutMs. Editor-host pump iterates again on false — loses a UI frame.
//
// Lifetime coordination: see GuardedPluginWrapper::enableAudioStream /
// disableAudioStream for the release/acquire dance that guarantees the audio
// thread never observes a half-constructed or destroyed ring.

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>

class NamedAudioRing
{
public:
    struct Header
    {
        std::atomic<uint64_t> writeIndex;   // samples written (monotonic, SPSC producer)
        std::atomic<uint64_t> readIndex;    // samples read    (monotonic, SPSC consumer)
        int32_t sampleRate;                 // set by producer at create time
        int32_t blockSize;                  // set by producer at create time
        int32_t numChannels;                // always 2 for v1
        int32_t ringSizeSamples;            // power of two, per channel
        char    reserved[32];               // pad header to 64 bytes (cache line)
    };
    static_assert(sizeof(std::atomic<uint64_t>) == 8, "atomic<uint64_t> not 8 bytes");

    // Producer side (worker). Creates the mapping and initialises the header.
    // Returns nullptr on failure. numChannels must be 2 for v1.
    static std::unique_ptr<NamedAudioRing> createAndOwn(const std::string& name,
                                                        int sampleRate,
                                                        int blockSize,
                                                        int numChannels,
                                                        int ringSizeSamples);

    // Consumer side (editor-host). Opens an existing mapping created by the
    // worker. Returns nullptr if the named mapping does not exist.
    static std::unique_ptr<NamedAudioRing> openExisting(const std::string& name);

    ~NamedAudioRing();

    // ── Audio-thread-safe (producer) ─────────────────────────────────────────
    // No alloc, no lock, no log. Writes numSamples of deinterleaved stereo.
    // Returns false if writing numSamples would exceed ringSizeSamples
    // headroom — the frame is silently dropped.
    bool tryWrite(const float* const* channelData, int numSamples);

    // ── Consumer thread (pump) ───────────────────────────────────────────────
    // Blocks up to timeoutMs waiting for numSamples to become available.
    // Returns false if still empty after the timeout.
    bool tryRead(float* const* outChannelData, int numSamples, int timeoutMs);

    int getSampleRate()     const { return header_ ? header_->sampleRate      : 0; }
    int getBlockSize()      const { return header_ ? header_->blockSize       : 0; }
    int getNumChannels()    const { return header_ ? header_->numChannels     : 0; }
    int getRingSizeSamples()const { return header_ ? header_->ringSizeSamples : 0; }

    // Next power of two >= v (for picking ringSizeSamples from blockSize*N).
    static int nextPow2(int v);

private:
    NamedAudioRing() = default;
    NamedAudioRing(const NamedAudioRing&) = delete;
    NamedAudioRing& operator=(const NamedAudioRing&) = delete;

    // Pointer to channel `ch` sample array inside the mapping.
    float* channelPtr(int ch) const
    {
        return reinterpret_cast<float*>(
                   reinterpret_cast<char*>(header_) + sizeof(Header))
             + static_cast<size_t>(ch) * static_cast<size_t>(ringSizeSamples_);
    }

    // Win32 handles stored as void* to avoid pulling <Windows.h> into the header.
    void*     mappingHandle_ = nullptr;   // HANDLE from CreateFileMapping / OpenFileMapping
    void*     viewBase_      = nullptr;   // MapViewOfFile base pointer
    Header*   header_        = nullptr;   // viewBase_ cast to Header*
    size_t    mappingSize_   = 0;
    bool      isOwner_       = false;     // true for producer (destructor unmaps + closes)
    int       ringSizeSamples_ = 0;       // cached locally (immutable after construction)
    int       numChannels_     = 0;
    uint64_t  mask_            = 0;       // ringSizeSamples_ - 1
    std::string name_;
};
