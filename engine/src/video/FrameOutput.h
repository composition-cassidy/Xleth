#pragma once

#include <atomic>
#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>

// ─── FrameOutput ─────────────────────────────────────────────────────────────
// Double-buffered RGBA frame output for zero-copy delivery to JS/Electron.
//
// Memory layout (single contiguous allocation):
//   [Buffer A: W*H*4 bytes] [Buffer B: W*H*4 bytes] [currentIndex: 4 bytes]
//
// Protocol:
//   Writer (video thread):  writes to back buffer, then atomically swaps index.
//   Reader (any thread):    reads currentIndex, then reads from front buffer.
//   The front buffer is never written to — safe to read without locks.

class FrameOutput
{
public:
    FrameOutput() = default;
    ~FrameOutput();

    // Allocate double buffers for the given resolution. Can be called again
    // to resize (not thread-safe with concurrent writes — call while paused).
    void initialize(int width, int height);

    // Adopt an externally-owned memory region as the double-buffer backing
    // store (e.g. a SharedArrayBuffer from V8). Caller guarantees the pointer
    // remains valid for the lifetime of this FrameOutput. `bytes` must be at
    // least width*height*4*2 + sizeof(int32_t).
    void initializeExternal(uint8_t* ptr, size_t bytes, int width, int height);

    // Back the double buffers with a Windows named file mapping. Any process
    // that opens the same name (via OpenFileMappingA + MapViewOfFile) sees
    // the same physical pages. Control region is 64 bytes — layout:
    //   [BufferA: W*H*4] [BufferB: W*H*4] [int32 index | 60 bytes reserved].
    //
    // The SECTION is sized for capacityWidth x capacityHeight (defaulting to
    // width x height), while the live frame is width x height. They differ
    // because a named section's size is fixed when it is created: passing a
    // bigger size to CreateFileMapping for a name that already exists is
    // silently ignored (it returns the existing object with ERROR_ALREADY_
    // EXISTS), and the reader process keeps that object alive between our
    // teardown and re-create. Mapping a view larger than the section then
    // fails with ERROR_ACCESS_DENIED and the preview dies permanently.
    // So: create once at the maximum resolution the preview can ask for and
    // let previewResolutionScale move width_/height_ around INSIDE it.
    bool initSharedMemory(const char* name, int width, int height,
                          int capacityWidth = 0, int capacityHeight = 0);

    void shutdown();

    bool isInitialized() const { return width_ > 0 && height_ > 0; }

    // ── Writer API (video thread only) ───────────────────────────────────────

    // Get the back buffer pointer for manual compositing.
    // Call swapBuffers() after writing.
    uint8_t* getBackBuffer();

    // Clear the back buffer to black (zeroes), then swap.
    void writeBlackFrame();

    // Atomically swap front/back. Call after writing to back buffer.
    void swapBuffers();

    // ── Reader API (any thread) ──────────────────────────────────────────────

    // Get pointer to the current front buffer (stable, not being written to).
    const uint8_t* getCurrentFrame() const;

    // ── Buffer access (for SharedArrayBuffer / external ArrayBuffer) ─────────

    // The raw contiguous allocation: [BufA | BufB | int32 index]
    uint8_t*       getRawBuffer()       { return dataPtr_; }
    const uint8_t* getRawBuffer() const { return dataPtr_; }
    size_t         getRawBufferSize() const { return dataSize_; }

    uint8_t* getBufferA()       { return dataPtr_; }
    uint8_t* getBufferB()       { return dataPtr_ + bufferSize(); }

    int  getBufferSize() const { return bufferSize(); }
    int  getWidth()      const { return width_; }
    int  getHeight()     const { return height_; }

    // The atomic index (0 = A is front, 1 = B is front).
    // Stored at offset 2*bufferSize in the contiguous allocation.
    int  getCurrentBufferIndex() const;

    // Offset of the int32 index within the raw buffer.
    size_t getIndexOffset() const { return static_cast<size_t>(bufferSize()) * 2; }

private:
    int width_  = 0;
    int height_ = 0;

    // Contiguous allocation: [BufferA | BufferB | int32 currentIndex].
    // When we own the memory, ownedData_ holds it and dataPtr_ points into it.
    // When external (SAB), ownedData_ is empty and dataPtr_ references caller's buffer.
    std::vector<uint8_t> ownedData_;
    uint8_t* dataPtr_ = nullptr;
    size_t   dataSize_ = 0;

    // Windows named-shared-memory handle (only when initSharedMemory was used).
    // shmName_ lets a re-init recognise that the section we already hold is
    // the one being asked for, so it can resize the frame in place instead of
    // destroying and re-creating a section whose size is immutable.
    void*       hMapFile_ = nullptr;
    void*       shmView_  = nullptr;
    std::string shmName_;

    // Pointer to the atomic index within data_ (at offset 2*bufferSize).
    // Aligned to 4 bytes since bufferSize = W*H*4 is always 4-byte aligned.
    std::atomic<int32_t>* indexPtr_ = nullptr;

    int bufferSize() const { return width_ * height_ * 4; }
};
