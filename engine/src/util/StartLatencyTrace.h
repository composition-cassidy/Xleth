#pragma once
// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY / DIAGNOSTIC — play→first-audio vs play→first-frame latency probe.
//
//   *** REMOVE THIS FILE AND ITS THREE CALL SITES AFTER MEASURING. ***
//
// Added for the audio-start-latency investigation. It measures, per Play press,
// how long until (b) the first audio block is produced and (c) the first video
// frame is composited — so play→first-audio can be read independently from
// play→first-frame.
//
// Markers (all lock-free; nothing here changes audio/video behaviour):
//   (a) markPlayPressed()  — main (message) thread, at the top of Play()
//   (b) markFirstAudio()   — AUDIO thread; single atomic store, NO alloc/lock/log
//   (c) markFirstFrame()   — video/preview thread, right after compositeFrame()
//
// flush() prints the two deltas (once each per Play) and is only ever called
// from the preview thread — so NOTHING is logged on the audio callback.
// ─────────────────────────────────────────────────────────────────────────────
#include <atomic>
#include <chrono>
#include <cstdint>
#include <iostream>

namespace xleth::diag {

class StartLatencyTrace {
public:
    static StartLatencyTrace& instance() {
        static StartLatencyTrace s;
        return s;
    }

    // Main thread. Resets the cycle and timestamps the Play press.
    void markPlayPressed() {
        const int64_t now = nowNs();
        playPressedNs_.store(now, std::memory_order_release);
        firstAudioNs_.store(0, std::memory_order_release);
        firstFrameNs_.store(0, std::memory_order_release);
        audioLogged_.store(false, std::memory_order_release);
        frameLogged_.store(false, std::memory_order_release);
        wantFrame_.store(true, std::memory_order_release);
        // Arm audio LAST: only blocks after this point should be eligible.
        wantAudio_.store(true, std::memory_order_release);
        std::cout << "[StartLatencyTrace] (a) Play pressed\n" << std::flush;
    }

    // AUDIO THREAD ONLY. No alloc / no lock / no log — single atomic store.
    // Call once per block ONLY WHEN transport is actually playing; records the
    // timestamp of the first such block after a Play press.
    void markFirstAudio() {
        bool expected = true;
        if (wantAudio_.compare_exchange_strong(expected, false,
                                               std::memory_order_acq_rel))
            firstAudioNs_.store(nowNs(), std::memory_order_release);
    }

    // Video/preview thread. Records the first composited frame after a Play.
    void markFirstFrame() {
        bool expected = true;
        if (wantFrame_.compare_exchange_strong(expected, false,
                                               std::memory_order_acq_rel))
            firstFrameNs_.store(nowNs(), std::memory_order_release);
    }

    // NON-audio thread (preview loop). Prints each delta once per Play.
    void flush() {
        const int64_t t0 = playPressedNs_.load(std::memory_order_acquire);
        if (t0 == 0) return;

        const int64_t ta = firstAudioNs_.load(std::memory_order_acquire);
        if (ta != 0 && !audioLogged_.exchange(true, std::memory_order_acq_rel))
            std::cout << "[StartLatencyTrace] (b) first AUDIO block = "
                      << ms(ta - t0) << " ms after Play\n" << std::flush;

        const int64_t tf = firstFrameNs_.load(std::memory_order_acquire);
        if (tf != 0 && !frameLogged_.exchange(true, std::memory_order_acq_rel))
            std::cout << "[StartLatencyTrace] (c) first VIDEO frame = "
                      << ms(tf - t0) << " ms after Play\n" << std::flush;
    }

private:
    static int64_t nowNs() {
        return std::chrono::duration_cast<std::chrono::nanoseconds>(
                   std::chrono::steady_clock::now().time_since_epoch()).count();
    }
    static double ms(int64_t ns) { return static_cast<double>(ns) / 1.0e6; }

    std::atomic<int64_t> playPressedNs_{0};
    std::atomic<int64_t> firstAudioNs_{0};
    std::atomic<int64_t> firstFrameNs_{0};
    std::atomic<bool>    wantAudio_{false};
    std::atomic<bool>    wantFrame_{false};
    std::atomic<bool>    audioLogged_{false};
    std::atomic<bool>    frameLogged_{false};
};

} // namespace xleth::diag
