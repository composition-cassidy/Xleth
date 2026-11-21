#include "audio/RealtimeWorkerPool.h"

#include <cstdio>
#if defined(_M_X64) || defined(__x86_64__) || defined(_M_IX86)
#  include <immintrin.h>
#endif

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#  include <avrt.h>
#  pragma comment(lib, "avrt.lib")
#endif

namespace xleth::audio {

RealtimeWorkerPool::RealtimeWorkerPool(int numWorkers)
{
    if (numWorkers <= 0)
        return;
#ifdef _WIN32
    wakeSemaphore_ = CreateSemaphoreW(nullptr, 0, 0x7FFFFFFF, nullptr);
    if (wakeSemaphore_ == nullptr)
        return;
#endif
    threads_.reserve(static_cast<size_t>(numWorkers));
    for (int i = 0; i < numWorkers; ++i)
        threads_.emplace_back([this, i] { workerMain(i); });
    std::fprintf(stderr, "[RealtimeWorkerPool] %d audio worker thread(s)\n", numWorkers);
}

RealtimeWorkerPool::~RealtimeWorkerPool()
{
    quit_.store(true, std::memory_order_seq_cst);
#ifdef _WIN32
    if (wakeSemaphore_ != nullptr)
        ReleaseSemaphore(static_cast<HANDLE>(wakeSemaphore_),
                         static_cast<LONG>(threads_.size()), nullptr);
#endif
    for (std::thread& t : threads_)
        if (t.joinable()) t.join();
#ifdef _WIN32
    if (wakeSemaphore_ != nullptr)
        CloseHandle(static_cast<HANDLE>(wakeSemaphore_));
#endif
}

void RealtimeWorkerPool::open(JobFn fn, void* ctx) noexcept
{
    if (threads_.empty()) return;
    jobFn_.store(fn, std::memory_order_seq_cst);
    jobCtx_.store(ctx, std::memory_order_seq_cst);
    open_.store(true, std::memory_order_seq_cst);
#ifdef _WIN32
    ReleaseSemaphore(static_cast<HANDLE>(wakeSemaphore_),
                     static_cast<LONG>(threads_.size()), nullptr);
#endif
}

void RealtimeWorkerPool::close() noexcept
{
    if (threads_.empty()) return;
    // Dekker pairing with workerMain: open_=false then read active_, against the
    // worker's active_++ then re-read open_. With seq_cst on both sides, either
    // we see the worker's increment (and wait for it) or it sees the job closed
    // (and backs out without touching the job).
    open_.store(false, std::memory_order_seq_cst);
    while (active_.load(std::memory_order_seq_cst) != 0)
    {
#if defined(_M_X64) || defined(__x86_64__) || defined(_M_IX86)
        _mm_pause();
#endif
    }
}

void RealtimeWorkerPool::workerMain(int index)
{
#ifdef _WIN32
    DWORD taskIndex = 0;
    HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
    if (mmcss != nullptr)
        AvSetMmThreadPriority(mmcss, AVRT_PRIORITY_HIGH);
    else
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    wchar_t name[48];
    swprintf_s(name, L"Xleth audio worker %d", index);
    SetThreadDescription(GetCurrentThread(), name);
#endif

    while (!quit_.load(std::memory_order_seq_cst))
    {
#ifdef _WIN32
        WaitForSingleObject(static_cast<HANDLE>(wakeSemaphore_), INFINITE);
#endif
        if (quit_.load(std::memory_order_seq_cst))
            break;
        if (!open_.load(std::memory_order_seq_cst))
            continue;                                   // woke after the block ended
        active_.fetch_add(1, std::memory_order_seq_cst);
        if (!open_.load(std::memory_order_seq_cst))
        {
            active_.fetch_sub(1, std::memory_order_seq_cst);
            continue;                                   // lost the race with close()
        }
        const JobFn fn  = jobFn_.load(std::memory_order_seq_cst);
        void*       ctx = jobCtx_.load(std::memory_order_seq_cst);
        if (fn != nullptr)
            fn(ctx);
        active_.fetch_sub(1, std::memory_order_seq_cst);
    }

#ifdef _WIN32
    if (mmcss != nullptr)
        AvRevertMmThreadCharacteristics(mmcss);
#endif
}

} // namespace xleth::audio
