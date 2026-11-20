// test_transport_race.cpp — a seek or stop is never lost to the audio thread.
//
// The audio callback reads the transport position, renders, then advance()s it.
// A seek/stop from the bridge thread that lands between that read and the
// write-back must win; otherwise the playhead resumes from the pre-seek place.
//
// One thread runs the callback's transport calls in a tight loop; the main
// thread hammers seek/stop and checks each one landed.
// Pass: prints "ALL TESTS PASSED" and exits 0.

#include "Transport.h"

#include <atomic>
#include <cstdint>
#include <iostream>
#include <thread>

static int g_passed = 0;
static int g_failed = 0;

// Counts every failure, prints only the first few.
#define CHECK(cond, msg)                                                      \
    do {                                                                      \
        if (cond) { ++g_passed; }                                             \
        else {                                                                \
            if (++g_failed <= 8)                                              \
                std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";   \
        }                                                                     \
    } while (0)

constexpr int     kBlock = 512;
// Far enough that no number of blocks between two checks can bridge the gap:
// a lost seek leaves the playhead ~1e12 samples away from where it was sent.
constexpr int64_t kFar   = 1'000'000'000'000LL;

// What AudioEngine's callback does to the transport each block.
struct AudioSim {
    Transport&            t;
    std::atomic<bool>     run{ true };
    std::atomic<uint64_t> blocks{ 0 };
    std::thread           th;

    explicit AudioSim(Transport& tr) : t(tr) {
        th = std::thread([this] {
            while (run.load(std::memory_order_relaxed)) {
                const int chunk = t.samplesUntilLoopWrap(kBlock);
                (void)t.getRenderPositionSamples();   // MixEngine::processBlock
                t.advance(chunk);
                blocks.fetch_add(1, std::memory_order_release);
            }
        });
    }
    ~AudioSim() { run.store(false); th.join(); }

    uint64_t count() const { return blocks.load(std::memory_order_acquire); }
    void waitBlocks(uint64_t from, uint64_t n) const {
        while (count() < from + n) std::this_thread::yield();
    }
};

// After seek(target): target <= pos <= target + one block per advance that can
// have run since (+1 for the one in flight when the seek landed).
static bool landed(int64_t pos, int64_t target, uint64_t c0, uint64_t c1) {
    return pos >= target
        && pos <= target + static_cast<int64_t>(c1 - c0 + 1) * kBlock;
}

// T1: loop off. Seeks alternate between two regions 1e12 apart; every 16th
// iteration is a stop that must leave the transport stopped at 0.
static void testSeekAndStopWhilePlaying() {
    std::cout << "[T1] seek/stop hammered while the audio thread advances\n";
    Transport t;
    t.setSampleRate(48000.0);
    t.play();
    AudioSim audio(t);

    constexpr int kIters = 200000;
    int lostSeeks = 0, lostStops = 0, stops = 0;
    for (int i = 0; i < kIters; ++i) {
        if (i % 16 == 15) {
            ++stops;
            t.stop();
            const bool    playing = t.isPlaying();
            const int64_t pos     = t.getPositionSamples();
            const uint64_t c = audio.count();
            audio.waitBlocks(c, 2);            // a late advance() would show by now
            const int64_t pos2 = t.getPositionSamples();
            const bool ok = !playing && pos == 0 && pos2 == 0 && !t.isPlaying();
            if (!ok) ++lostStops;
            CHECK(ok, "stop #" << stops << ": playing=" << playing
                  << " pos=" << pos << " pos after 2 blocks=" << pos2);
            t.play();
            continue;
        }

        const int64_t target = (i % 2 ? kFar : 0) + 1000 + i;
        const uint64_t c0 = audio.count();
        t.seekToSample(target);
        const int64_t pos = t.getPositionSamples();
        const uint64_t c1 = audio.count();
        const bool ok = landed(pos, target, c0, c1);
        if (!ok) ++lostSeeks;
        CHECK(ok, "seek #" << i << " to " << target << " observed " << pos
              << " (" << (c1 - c0) << " blocks ran)");
    }
    std::cout << "  lost seeks: " << lostSeeks << " of " << (kIters - stops)
              << ", lost stops: " << lostStops << " of " << stops << "\n";
}

// T2: loop on. Seek into the loop (arms the trap), let a block run, then seek
// past the loop end. The trap must be disarmed by that seek: an advance()
// writing back a stale "armed" would wrap the playhead into the loop.
static void testSeekOutOfArmedLoop() {
    std::cout << "[T2] seek out of an armed loop while the audio thread advances\n";
    constexpr int64_t kLoopEnd = 1'000'000;
    Transport t;
    t.setSampleRate(48000.0);
    t.setLoopBounds(0, kLoopEnd, true);
    t.play();
    AudioSim audio(t);

    constexpr int kIters = 50000;
    int lost = 0;
    for (int i = 0; i < kIters; ++i) {
        t.seekToSample(1000 + (i % 1000) * kBlock);   // inside: arms the trap
        audio.waitBlocks(audio.count(), 1);

        const int64_t target = kFar + i;
        const uint64_t c0 = audio.count();
        t.seekToSample(target);
        const int64_t pos = t.getPositionSamples();
        audio.waitBlocks(audio.count(), 2);
        const int64_t pos2 = t.getPositionSamples();
        const uint64_t c1 = audio.count();
        const bool ok = landed(pos, target, c0, c1) && landed(pos2, target, c0, c1);
        if (!ok) ++lost;
        CHECK(ok, "seek #" << i << " to " << target << " observed " << pos
              << ", then " << pos2 << " (loop end " << kLoopEnd << ")");
    }
    std::cout << "  lost seeks: " << lost << " of " << kIters << "\n";
}

int main() {
    testSeekAndStopWhilePlaying();
    testSeekOutOfArmedLoop();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed) { std::cout << "FAILED\n"; return 1; }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
