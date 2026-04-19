#include "audio/NamedAudioRing.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <thread>

#define NOMINMAX
#include <Windows.h>

// ─── Helpers ─────────────────────────────────────────────────────────────────

int NamedAudioRing::nextPow2(int v)
{
    if (v <= 1) return 1;
    // bit twiddling: round up to next power of two
    unsigned int x = static_cast<unsigned int>(v - 1);
    x |= x >> 1;
    x |= x >> 2;
    x |= x >> 4;
    x |= x >> 8;
    x |= x >> 16;
    return static_cast<int>(x + 1);
}

// ─── createAndOwn (producer) ─────────────────────────────────────────────────

std::unique_ptr<NamedAudioRing> NamedAudioRing::createAndOwn(const std::string& name,
                                                             int sampleRate,
                                                             int blockSize,
                                                             int numChannels,
                                                             int ringSizeSamples)
{
    if (numChannels != 2)                             return nullptr;
    if (ringSizeSamples < 2)                          return nullptr;
    if ((ringSizeSamples & (ringSizeSamples - 1)) != 0) return nullptr; // must be pow2
    if (sampleRate <= 0 || blockSize <= 0)            return nullptr;

    const size_t payload = static_cast<size_t>(ringSizeSamples)
                         * static_cast<size_t>(numChannels)
                         * sizeof(float);
    const size_t totalSize = sizeof(Header) + payload;

    HANDLE h = ::CreateFileMappingA(INVALID_HANDLE_VALUE,
                                    nullptr,
                                    PAGE_READWRITE,
                                    0,
                                    static_cast<DWORD>(totalSize),
                                    name.c_str());
    if (h == nullptr) return nullptr;

    void* view = ::MapViewOfFile(h, FILE_MAP_ALL_ACCESS, 0, 0, totalSize);
    if (view == nullptr)
    {
        ::CloseHandle(h);
        return nullptr;
    }

    // Zero-init the payload region and initialise the header.
    std::memset(view, 0, totalSize);
    auto* hdr = reinterpret_cast<Header*>(view);
    // Atomics: in-place construct (placement new) to ensure well-defined init.
    new (&hdr->writeIndex) std::atomic<uint64_t>(0);
    new (&hdr->readIndex)  std::atomic<uint64_t>(0);
    hdr->sampleRate      = sampleRate;
    hdr->blockSize       = blockSize;
    hdr->numChannels     = numChannels;
    hdr->ringSizeSamples = ringSizeSamples;

    std::unique_ptr<NamedAudioRing> ring(new NamedAudioRing());
    ring->mappingHandle_   = h;
    ring->viewBase_        = view;
    ring->header_          = hdr;
    ring->mappingSize_     = totalSize;
    ring->isOwner_         = true;
    ring->ringSizeSamples_ = ringSizeSamples;
    ring->numChannels_     = numChannels;
    ring->mask_            = static_cast<uint64_t>(ringSizeSamples) - 1ULL;
    ring->name_            = name;
    return ring;
}

// ─── openExisting (consumer) ─────────────────────────────────────────────────

std::unique_ptr<NamedAudioRing> NamedAudioRing::openExisting(const std::string& name)
{
    HANDLE h = ::OpenFileMappingA(FILE_MAP_ALL_ACCESS, FALSE, name.c_str());
    if (h == nullptr) return nullptr;

    // First map just the header to read sizing.
    void* headerView = ::MapViewOfFile(h, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Header));
    if (headerView == nullptr)
    {
        ::CloseHandle(h);
        return nullptr;
    }

    auto* hdrPeek = reinterpret_cast<Header*>(headerView);
    const int ringSize = hdrPeek->ringSizeSamples;
    const int numCh    = hdrPeek->numChannels;
    ::UnmapViewOfFile(headerView);

    if (ringSize <= 0 || (ringSize & (ringSize - 1)) != 0 || numCh != 2)
    {
        ::CloseHandle(h);
        return nullptr;
    }

    const size_t totalSize = sizeof(Header)
                           + static_cast<size_t>(ringSize)
                           * static_cast<size_t>(numCh) * sizeof(float);

    void* view = ::MapViewOfFile(h, FILE_MAP_ALL_ACCESS, 0, 0, totalSize);
    if (view == nullptr)
    {
        ::CloseHandle(h);
        return nullptr;
    }

    std::unique_ptr<NamedAudioRing> ring(new NamedAudioRing());
    ring->mappingHandle_   = h;
    ring->viewBase_        = view;
    ring->header_          = reinterpret_cast<Header*>(view);
    ring->mappingSize_     = totalSize;
    ring->isOwner_         = false;
    ring->ringSizeSamples_ = ringSize;
    ring->numChannels_     = numCh;
    ring->mask_            = static_cast<uint64_t>(ringSize) - 1ULL;
    ring->name_            = name;
    return ring;
}

// ─── Destructor ──────────────────────────────────────────────────────────────

NamedAudioRing::~NamedAudioRing()
{
    if (viewBase_)      ::UnmapViewOfFile(viewBase_);
    if (mappingHandle_) ::CloseHandle(mappingHandle_);
    // OS refcounts the mapping — last handle close frees the backing pages.
}

// ─── tryWrite (audio thread, producer) ───────────────────────────────────────

bool NamedAudioRing::tryWrite(const float* const* channelData, int numSamples)
{
    if (numSamples <= 0 || header_ == nullptr) return true;

    // Producer owns writeIndex → relaxed load is sufficient.
    const uint64_t w = header_->writeIndex.load(std::memory_order_relaxed);
    // Need an up-to-date view of the consumer's progress.
    const uint64_t r = header_->readIndex.load(std::memory_order_acquire);

    const uint64_t used      = w - r;                             // SPSC: w >= r
    const uint64_t headroom  = static_cast<uint64_t>(ringSizeSamples_) - used;
    if (static_cast<uint64_t>(numSamples) > headroom)
        return false;  // would overrun — silent drop

    const uint64_t writePos = w & mask_;
    const int firstPart  = static_cast<int>(std::min<uint64_t>(
                               static_cast<uint64_t>(numSamples),
                               static_cast<uint64_t>(ringSizeSamples_) - writePos));
    const int secondPart = numSamples - firstPart;

    for (int ch = 0; ch < numChannels_; ++ch)
    {
        float* dst = channelPtr(ch);
        std::memcpy(dst + writePos,
                    channelData[ch],
                    static_cast<size_t>(firstPart) * sizeof(float));
        if (secondPart > 0)
        {
            std::memcpy(dst,
                        channelData[ch] + firstPart,
                        static_cast<size_t>(secondPart) * sizeof(float));
        }
    }

    // Publish: release so the consumer's acquire sees the samples we just wrote.
    header_->writeIndex.store(w + static_cast<uint64_t>(numSamples),
                              std::memory_order_release);
    return true;
}

// ─── tryRead (pump thread, consumer) ─────────────────────────────────────────

bool NamedAudioRing::tryRead(float* const* outChannelData, int numSamples, int timeoutMs)
{
    if (numSamples <= 0 || header_ == nullptr) return false;

    const auto deadline = std::chrono::steady_clock::now()
                        + std::chrono::milliseconds(timeoutMs);

    uint64_t r = header_->readIndex.load(std::memory_order_relaxed);
    while (true)
    {
        const uint64_t w = header_->writeIndex.load(std::memory_order_acquire);
        if (w - r >= static_cast<uint64_t>(numSamples))
            break; // enough samples available

        if (std::chrono::steady_clock::now() >= deadline)
            return false;

        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    const uint64_t readPos = r & mask_;
    const int firstPart  = static_cast<int>(std::min<uint64_t>(
                               static_cast<uint64_t>(numSamples),
                               static_cast<uint64_t>(ringSizeSamples_) - readPos));
    const int secondPart = numSamples - firstPart;

    for (int ch = 0; ch < numChannels_; ++ch)
    {
        const float* src = channelPtr(ch);
        std::memcpy(outChannelData[ch],
                    src + readPos,
                    static_cast<size_t>(firstPart) * sizeof(float));
        if (secondPart > 0)
        {
            std::memcpy(outChannelData[ch] + firstPart,
                        src,
                        static_cast<size_t>(secondPart) * sizeof(float));
        }
    }

    header_->readIndex.store(r + static_cast<uint64_t>(numSamples),
                             std::memory_order_release);
    return true;
}
