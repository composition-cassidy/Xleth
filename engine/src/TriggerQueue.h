#pragma once

#include <atomic>
#include <vector>

struct TriggerEvent
{
    int   sampleId = -1;
    float velocity = 1.0f;
};

// Single-producer / single-consumer lock-free ring buffer.
// Producer (GUI/input thread) calls push().
// Consumer (audio thread) calls pop().
class TriggerQueue
{
public:
    explicit TriggerQueue(int capacity = 256)
    {
        // Round up to next power of 2
        int cap = 1;
        while (cap < capacity) cap <<= 1;
        capacity_ = cap;
        mask_     = cap - 1;
        buffer_.resize(static_cast<std::size_t>(cap));
    }

    // Producer thread — wait-free, returns false if full.
    bool push(const TriggerEvent& event) noexcept
    {
        const int wp   = writePos_.load(std::memory_order_relaxed);
        const int next = (wp + 1) & mask_;
        if (next == readPos_.load(std::memory_order_acquire))
            return false; // full
        buffer_[static_cast<std::size_t>(wp)] = event;
        writePos_.store(next, std::memory_order_release);
        return true;
    }

    // Audio thread — wait-free, returns false if empty.
    bool pop(TriggerEvent& event) noexcept
    {
        const int rp = readPos_.load(std::memory_order_relaxed);
        if (rp == writePos_.load(std::memory_order_acquire))
            return false; // empty
        event = buffer_[static_cast<std::size_t>(rp)];
        readPos_.store((rp + 1) & mask_, std::memory_order_release);
        return true;
    }

private:
    std::vector<TriggerEvent> buffer_;
    std::atomic<int>          writePos_{ 0 };
    std::atomic<int>          readPos_ { 0 };
    int                       capacity_;
    int                       mask_;
};
