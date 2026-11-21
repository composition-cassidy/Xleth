#pragma once
// ─────────────────────────────────────────────────────────────────────────────
// RealtimeWorkerPool — helper threads that join the audio callback for the
// duration of ONE block.
//
// Contract (all calls except the constructor/destructor are audio-thread only,
// lock-free and allocation-free):
//   open(fn, ctx)   publish a job and wake every worker. Each worker that gets
//                   scheduled while the job is still open calls fn(ctx) once;
//                   fn must return when isOpen() turns false.
//   close()         stop accepting workers and wait only for the workers that
//                   actually JOINED this job to leave fn. A worker the OS wakes
//                   late (after close) never touches ctx — it sees the job closed
//                   and goes back to sleep — so a slow wake can delay nothing.
//
// Workers sleep on a semaphore between blocks (no CPU while idle) and run as
// MMCSS "Pro Audio" threads, the same class as the WASAPI callback.
// ─────────────────────────────────────────────────────────────────────────────

#include <atomic>
#include <cstdint>
#include <thread>
#include <vector>

namespace xleth::audio {

class RealtimeWorkerPool
{
public:
    using JobFn = void (*)(void* ctx);

    explicit RealtimeWorkerPool(int numWorkers);
    ~RealtimeWorkerPool();

    RealtimeWorkerPool(const RealtimeWorkerPool&)            = delete;
    RealtimeWorkerPool& operator=(const RealtimeWorkerPool&) = delete;

    int  numWorkers() const noexcept { return static_cast<int>(threads_.size()); }
    bool isOpen() const noexcept     { return open_.load(std::memory_order_seq_cst); }

    void open(JobFn fn, void* ctx) noexcept;
    void close() noexcept;

private:
    void workerMain(int index);

    std::vector<std::thread> threads_;
    void*                    wakeSemaphore_ = nullptr;   // Win32 HANDLE
    std::atomic<bool>        quit_{false};

    std::atomic<JobFn>       jobFn_{nullptr};
    std::atomic<void*>       jobCtx_{nullptr};
    std::atomic<bool>        open_{false};
    std::atomic<int>         active_{0};
};

} // namespace xleth::audio
