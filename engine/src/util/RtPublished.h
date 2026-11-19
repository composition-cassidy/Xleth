#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <memory>
#include <thread>
#include <vector>

// ─── RtPublished ─────────────────────────────────────────────────────────────
// Hands an immutable snapshot from ONE writer thread to the realtime audio
// thread. The shape MixEngine already uses for regionToSampleMap_ and
// chainSnapshot_, written once so new users stop hand-copying it.
//
//   Audio thread : load() once per block and keep the pointer in a local. One
//                  atomic load, no allocation; everything reachable from the
//                  snapshot stays alive until that local goes out of scope.
//   Writer thread: publish() a NEW snapshot. Never mutate a published one.
//
// RECLAMATION. A superseded snapshot is parked on a retire list and freed, on
// the writer thread, only once use_count() == 1 — that is, when the list is its
// sole owner. It is no longer reachable through load(), so the count can only
// fall, and the audio thread can never be the one to drop the last reference.
// Nothing here waits for the audio thread: an edit publishes and returns.
//
// MSVC implements std::atomic<std::shared_ptr> with an internal spin bit rather
// than a truly lock-free word; the engine already accepts that trade (see the
// note on ClipRenderCache::slots_).

namespace xleth::util {

template <class T>
class RtPublished
{
public:
    using Ptr = std::shared_ptr<const T>;

    RtPublished() = default;
    explicit RtPublished(Ptr initial) : current_(std::move(initial)) {}

    // Any thread. The audio thread's only entry point.
    Ptr load() const noexcept { return current_.load(std::memory_order_acquire); }

    // Writer thread only.
    void publish(Ptr next)
    {
        Ptr previous = current_.exchange(std::move(next), std::memory_order_acq_rel);
        if (previous) retired_.push_back(std::move(previous));
        prune();
    }

    // Writer thread only. Frees every retired snapshot no reader still holds.
    // Cheap enough for a poll, so memory comes back without a further publish.
    void prune()
    {
        retired_.erase(
            std::remove_if(retired_.begin(), retired_.end(),
                           [](const Ptr& p) { return p.use_count() == 1; }),
            retired_.end());
    }

    // Writer thread only, TEARDOWN paths only — never from an edit. Polls
    // prune() until the retire list is empty or the deadline passes. On expiry
    // the stragglers stay parked: they are never force-freed, so a callback
    // that died mid-block costs a bounded leak, not a hang or a use-after-free.
    bool drain(int timeoutMs)
    {
        const auto deadline = std::chrono::steady_clock::now()
                            + std::chrono::milliseconds(timeoutMs);
        for (;;)
        {
            prune();
            if (retired_.empty()) return true;
            if (std::chrono::steady_clock::now() >= deadline) return false;
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }

    // Writer thread only. Tests and diagnostics.
    std::size_t retiredCount() const noexcept { return retired_.size(); }

private:
    std::atomic<Ptr> current_;
    std::vector<Ptr> retired_;   // writer thread only
};

} // namespace xleth::util
