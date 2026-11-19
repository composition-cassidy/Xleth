#pragma once

#include <atomic>
#include <cstddef>
#include <vector>

// ─── SpscRing ────────────────────────────────────────────────────────────────
// Single-producer / single-consumer lock-free ring buffer of trivially
// copyable events. One thread calls push(), one thread calls pop(); both are
// wait-free and neither allocates after construction.
//
// Capacity is rounded up to a power of two and one slot is kept empty to tell
// "full" from "empty", so a ring built with capacity N holds N-1 events.

namespace xleth::util {

template <class T>
class SpscRing
{
public:
    explicit SpscRing(int capacity = 256)
    {
        int cap = 1;
        while (cap < capacity) cap <<= 1;
        mask_ = cap - 1;
        buffer_.resize(static_cast<std::size_t>(cap));
    }

    // Producer thread. Returns false when full (the event is not stored).
    bool push(const T& event) noexcept
    {
        const int wp   = writePos_.load(std::memory_order_relaxed);
        const int next = (wp + 1) & mask_;
        if (next == readPos_.load(std::memory_order_acquire))
            return false;
        buffer_[static_cast<std::size_t>(wp)] = event;
        writePos_.store(next, std::memory_order_release);
        return true;
    }

    // Consumer thread. Returns false when empty.
    bool pop(T& event) noexcept
    {
        const int rp = readPos_.load(std::memory_order_relaxed);
        if (rp == writePos_.load(std::memory_order_acquire))
            return false;
        event = buffer_[static_cast<std::size_t>(rp)];
        readPos_.store((rp + 1) & mask_, std::memory_order_release);
        return true;
    }

private:
    std::vector<T>   buffer_;
    std::atomic<int> writePos_{ 0 };
    std::atomic<int> readPos_ { 0 };
    int              mask_ = 0;
};

} // namespace xleth::util
