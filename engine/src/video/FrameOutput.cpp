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

extern "C" {
#include <libswscale/swscale.h>
#include <libavutil/pixfmt.h>
}

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

bool FrameOutput::initSharedMemory(const char* name, int width, int height)
{
#ifdef _WIN32
    if (!name || width <= 0 || height <= 0) return false;

    const size_t frameBytes = static_cast<size_t>(width) * static_cast<size_t>(height) * 4u;
    const size_t totalSize  = frameBytes * 2u + 64u;  // 64-byte control region

    shutdown();

    HANDLE hMap = CreateFileMappingA(
        INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
        0, static_cast<DWORD>(totalSize), name);
    if (!hMap) {
        std::cerr << "[FrameOutput] CreateFileMappingA failed: " << GetLastError() << "\n";
        return false;
    }

    void* view = MapViewOfFile(hMap, FILE_MAP_ALL_ACCESS, 0, 0, totalSize);
    if (!view) {
        std::cerr << "[FrameOutput] MapViewOfFile failed: " << GetLastError() << "\n";
        CloseHandle(hMap);
        return false;
    }

    hMapFile_ = hMap;
    shmView_  = view;
    width_    = width;
    height_   = height;
    dataPtr_  = static_cast<uint8_t*>(view);
    dataSize_ = totalSize;

    std::memset(dataPtr_, 0, totalSize);
    indexPtr_ = new (dataPtr_ + frameBytes * 2) std::atomic<int32_t>(0);

    std::cout << "[FrameOutput] Shared memory '" << name << "' created: "
              << width << "x" << height << " (" << (totalSize / 1024) << " KB)\n" << std::flush;
    return true;
#else
    (void)name; (void)width; (void)height;
    std::cerr << "[FrameOutput] initSharedMemory only supported on Windows\n";
    return false;
#endif
}

// ─────────────────────────────────────────────────────────────────────────────

void FrameOutput::shutdown()
{
    if (swsCtx_) {
        sws_freeContext(swsCtx_);
        swsCtx_ = nullptr;
    }
    lastSrcW_ = lastSrcH_ = 0;

    // indexPtr_ points into data, no delete needed (placement new)
    indexPtr_ = nullptr;
    ownedData_.clear();

#ifdef _WIN32
    if (shmView_)  { UnmapViewOfFile(shmView_);         shmView_  = nullptr; }
    if (hMapFile_) { CloseHandle(static_cast<HANDLE>(hMapFile_)); hMapFile_ = nullptr; }
#endif

    dataPtr_ = nullptr;
    dataSize_ = 0;
    width_ = height_ = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writer API
// ─────────────────────────────────────────────────────────────────────────────

void FrameOutput::writeFrameYUV(const uint8_t* yPlane, const uint8_t* uPlane, const uint8_t* vPlane,
                                int yStride, int uStride, int vStride,
                                int srcWidth, int srcHeight)
{
    if (!isInitialized()) return;

    // Lazily create/recreate swscale context if source dimensions changed
    if (!swsCtx_ || srcWidth != lastSrcW_ || srcHeight != lastSrcH_) {
        if (swsCtx_) sws_freeContext(swsCtx_);
        swsCtx_ = sws_getContext(srcWidth, srcHeight, AV_PIX_FMT_YUV420P,
                                  width_, height_, AV_PIX_FMT_RGBA,
                                  SWS_BILINEAR, nullptr, nullptr, nullptr);
        lastSrcW_ = srcWidth;
        lastSrcH_ = srcHeight;

        if (!swsCtx_) {
            std::cerr << "[FrameOutput] Failed to create swscale context\n";
            return;
        }
    }

    uint8_t* dst = getBackBuffer();
    const uint8_t* srcSlice[3] = { yPlane, uPlane, vPlane };
    int srcStride[3] = { yStride, uStride, vStride };
    uint8_t* dstSlice[1] = { dst };
    int dstStride[1] = { width_ * 4 };

    sws_scale(swsCtx_, srcSlice, srcStride, 0, srcHeight, dstSlice, dstStride);

    swapBuffers();
}

// ─────────────────────────────────────────────────────────────────────────────

void FrameOutput::writeFrameRGBA(const uint8_t* rgba, size_t size)
{
    if (!isInitialized()) return;

    const size_t copySize = std::min(size, static_cast<size_t>(bufferSize()));
    uint8_t* dst = getBackBuffer();
    std::memcpy(dst, rgba, copySize);

    // Zero any remaining bytes if source is smaller
    if (copySize < static_cast<size_t>(bufferSize()))
        std::memset(dst + copySize, 0, static_cast<size_t>(bufferSize()) - copySize);

    swapBuffers();
}

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
