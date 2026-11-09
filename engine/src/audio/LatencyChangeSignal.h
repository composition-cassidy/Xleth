#pragma once

#include <atomic>
#include <cstdint>

namespace xleth::audio {

// [PDCNotify] Latency-changed notification from a stock effect to the graph
// that owns it.
//
// Why this exists: a chain's PDC (AudioGraph::outputLatencySamples_, read by the
// audio thread every block) is only recomputed by computePDC(). The generic
// owner paths (AudioGraph::setEffectParameter / setBypass / setEffectProgram /
// setEffectStateInformation) compare latency before and after and recompute
// inline. Any path that mutates an effect WITHOUT going through the graph -
// e.g. XlethParametricEQ::setBandParam called straight from an RPC - moved the
// effect's own latency but left the chain stale until some unrelated graph edit.
//
// Shape:
//   - XlethEffectBase::setLatencySamples (which hides the non-virtual
//     juce::AudioProcessor one) calls raise() whenever the published latency
//     actually changes.
//   - The owning AudioGraph holds the signal (shared, so an effect that outlives
//     its graph in a retired realtime view can still raise() safely) and clears
//     it at the start of every computePDC(): a raise that an inline owner-path
//     recompute already absorbed therefore never causes a second recompute.
//   - MixEngine's non-realtime applier thread polls generation() (one relaxed
//     load per pass) and, only when it moved, services every chain whose signal
//     is still pending. A burst of changes inside one pass = one recompute.
//
// raise() is two atomic RMWs and a store: no allocation, no lock, no logging.
// The audit found no path that reaches setLatencySamples on the realtime audio
// thread, but raise() would stay realtime-safe even if one appeared.
struct LatencyChangeSignal
{
    void raise() noexcept
    {
        pending_.store(true, std::memory_order_release);
        raisedCount_.fetch_add(1, std::memory_order_relaxed);
        generation().fetch_add(1, std::memory_order_acq_rel);
    }

    // Called by the owner immediately before it reads every node's latency.
    void clear() noexcept { pending_.store(false, std::memory_order_release); }

    bool isPending() const noexcept { return pending_.load(std::memory_order_acquire); }

    std::uint64_t getRaisedCount() const noexcept
    {
        return raisedCount_.load(std::memory_order_relaxed);
    }

    // Process-wide change counter: bumped by every raise() on every graph. Lets
    // the poller skip taking any lock when nothing changed anywhere.
    static std::atomic<std::uint64_t>& generation() noexcept
    {
        static std::atomic<std::uint64_t> g{0};
        return g;
    }

private:
    std::atomic<bool>          pending_{false};
    std::atomic<std::uint64_t> raisedCount_{0};
};

} // namespace xleth::audio
