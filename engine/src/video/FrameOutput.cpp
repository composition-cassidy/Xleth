#include "video/FrameOutput.h"

#include <algorithm>
#include <cstring>
#include <iostream>
#include <new>       // placement new

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  define NOMINMAX
#  include <windows.h>
#endif

// ─────────────────────────────────────────────────────────────────────────────

FrameOutput::~FrameOutput()
{
    shutdown();
}

// ─────────────────────────────────────────────────────────────────────────────

void FrameOutput::initialize(int width, int height)
{
    if (width <= 0 || height <= 0) return;

    shutdown();

    width_  = width;
    height_ = height;

    const size_t frameBytes = static_cast<size_t>(bufferSize());
    // Layout: [BufferA: frameBytes] [BufferB: frameBytes] [int32: 4 bytes]
    const size_t totalSize = frameBytes * 2 + sizeof(int32_t);
    ownedData_.assign(totalSize, 0);
    dataPtr_  = ownedData_.data();
    dataSize_ = totalSize;

    // Placement-new the atomic at the index offset.
    // bufferSize = W*H*4, which is always 4-byte aligned, so indexPtr_ is aligned.
    indexPtr_ = new (dataPtr_ + frameBytes * 2) std::atomic<int32_t>(0);

    std::cout << "[FrameOutput] Initialized: " << width << "x" << height
              << " (" << (totalSize / 1024) << " KB double-buffered)\n" << std::flush;
}

// ─────────────────────────────────────────────────────────────────────────────

void FrameOutput::initializeExternal(uint8_t* ptr, size_t bytes, int width, int height)
{
    if (!ptr || width <= 0 || height <= 0) return;

    const size_t frameBytes = static_cast<size_t>(width) * static_cast<size_t>(height) * 4u;
    const size_t required = frameBytes * 2u + sizeof(int32_t);
    if (bytes < required) {
        std::cerr << "[FrameOutput] initializeExternal: buffer too small ("
                  << bytes << " < " << required << ")\n";
        return;
    }

    shutdown();

    width_  = width;
    height_ = height;
    ownedData_.clear();
    dataPtr_  = ptr;
    dataSize_ = bytes;

    // Zero the buffers + index (safe: no concurrent readers yet)
    std::memset(dataPtr_, 0, required);
    indexPtr_ = new (dataPtr_ + frameBytes * 2) std::atomic<int32_t>(0);

    std::cout << "[FrameOutput] Initialized (external): " << width << "x" << height
              << " (" << (required / 1024) << " KB, SAB-backed)\n" << std::flush;
}

// ─────────────────────────────────────────────────────────────────────────────

bool FrameOutput::initSharedMemory(const char* name, int width, int height,
                                   int capacityWidth, int capacityHeight)
{
#ifdef _WIN32
    if (!name || width <= 0 || height <= 0) return false;

    const int capW = (capacityWidth  > 0) ? capacityWidth  : width;
    const int capH = (capacityHeight > 0) ? capacityHeight : height;

    const size_t frameBytes = static_cast<size_t>(width) * static_cast<size_t>(height) * 4u;
    const size_t liveBytes  = frameBytes * 2u + 64u;  // 64-byte control region
    const size_t capacity   = static_cast<size_t>(capW) * static_cast<size_t>(capH) * 4u * 2u + 64u;

    if (liveBytes > capacity) {
        std::cerr << "[FrameOutput] initSharedMemory: " << width << "x" << height
                  << " exceeds the " << capW << "x" << capH << " section capacity\n";
        return false;
    }

    // Resize in place when we already hold this section. A named section's
    // size is immutable, so tearing ours down and re-creating it is not a
    // resize at all — see the header note.
    if (shmView_ && hMapFile_ && shmName_ == name && capacity <= dataSize_) {
        width_    = width;
        height_   = height;
        std::memset(dataPtr_, 0, liveBytes);
        indexPtr_ = new (dataPtr_ + frameBytes * 2) std::atomic<int32_t>(0);

        std::cout << "[FrameOutput] Shared memory '" << name << "' reframed: "
                  << width << "x" << height << " in a " << (dataSize_ / 1024)
                  << " KB section\n" << std::flush;
        return true;
    }

    shutdown();

    SetLastError(0);
    HANDLE hMap = CreateFileMappingA(
        INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
        0, static_cast<DWORD>(capacity), name);
    const DWORD createErr = GetLastError();
    if (!hMap) {
        std::cerr << "[FrameOutput] CreateFileMappingA failed: " << createErr << "\n";
        return false;
    }

    void* view = MapViewOfFile(hMap, FILE_MAP_ALL_ACCESS, 0, 0, capacity);
    if (!view) {
        const DWORD mapErr = GetLastError();
        std::cerr << "[FrameOutput] MapViewOfFile failed: " << mapErr << "\n";
        // The one failure mode worth naming: CreateFileMapping handed back a
        // pre-existing section (our requested size ignored) that is smaller
        // than the view we just asked for.
        if (createErr == ERROR_ALREADY_EXISTS && mapErr == ERROR_ACCESS_DENIED) {
            std::cerr << "[FrameOutput] '" << name << "' already exists at a smaller size and a"
                         " reader still holds it open; cannot grow it to "
                      << (capacity / 1024) << " KB\n";
        }
        CloseHandle(hMap);
        return false;
    }

    hMapFile_ = hMap;
    shmView_  = view;
    shmName_  = name;
    width_    = width;
    height_   = height;
    dataPtr_  = static_cast<uint8_t*>(view);
    dataSize_ = capacity;

    std::memset(dataPtr_, 0, capacity);
    indexPtr_ = new (dataPtr_ + frameBytes * 2) std::atomic<int32_t>(0);

    std::cout << "[FrameOutput] Shared memory '" << name << "' created: "
              << width << "x" << height << " in a " << capW << "x" << capH
              << " section (" << (capacity / 1024) << " KB)\n" << std::flush;
    return true;
#else
    (void)name; (void)width; (void)height; (void)capacityWidth; (void)capacityHeight;
    std::cerr << "[FrameOutput] initSharedMemory only supported on Windows\n";
    return false;
#endif
}

// ─────────────────────────────────────────────────────────────────────────────

void FrameOutput::shutdown()
{
    // indexPtr_ points into data, no delete needed (placement new)
    indexPtr_ = nullptr;
    ownedData_.clear();

#ifdef _WIN32
    if (shmView_)  { UnmapViewOfFile(shmView_);         shmView_  = nullptr; }
    if (hMapFile_) { CloseHandle(static_cast<HANDLE>(hMapFile_)); hMapFile_ = nullptr; }
    shmName_.clear();
#endif

    dataPtr_ = nullptr;
    dataSize_ = 0;
    width_ = height_ = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writer API
// ─────────────────────────────────────────────────────────────────────────────

uint8_t* FrameOutput::getBackBuffer()
{
    if (!indexPtr_) return nullptr;

    // Back buffer is the one NOT currently being read (opposite of front)
    const int current = indexPtr_->load(std::memory_order_acquire);
    return (current == 0) ? getBufferB() : getBufferA();
}

// ─────────────────────────────────────────────────────────────────────────────

void FrameOutput::writeBlackFrame()
{
    if (!isInitialized()) return;

    uint8_t* dst = getBackBuffer();
    std::memset(dst, 0, static_cast<size_t>(bufferSize()));
    swapBuffers();
}

// ─────────────────────────────────────────────────────────────────────────────

void FrameOutput::swapBuffers()
{
    if (!indexPtr_) return;

    const int current = indexPtr_->load(std::memory_order_acquire);
    indexPtr_->store(current == 0 ? 1 : 0, std::memory_order_release);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reader API
// ─────────────────────────────────────────────────────────────────────────────

const uint8_t* FrameOutput::getCurrentFrame() const
{
    if (!indexPtr_) return nullptr;

    const int current = indexPtr_->load(std::memory_order_acquire);
    const size_t offset = static_cast<size_t>(current) * static_cast<size_t>(bufferSize());
    return dataPtr_ + offset;
}

// ─────────────────────────────────────────────────────────────────────────────

int FrameOutput::getCurrentBufferIndex() const
{
    if (!indexPtr_) return 0;
    return indexPtr_->load(std::memory_order_acquire);
}
