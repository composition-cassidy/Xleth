// test_sampler_set_handoff.cpp -- the two handoff primitives the engine uses
// between the main thread and the audio thread.
//
//   T1  RtPublished: a superseded snapshot is parked while a reader holds it,
//       freed once it lets go, and drain() gives up at its deadline rather
//       than free it early.
//   T2  SpscRing: capacity, FIFO order, full/empty.
//
// Build: cmake --build build --target test_sampler_set_handoff --config Release
// Run:   ctest --test-dir build -C Release -R "^test_sampler_set_handoff$" -V

#include "util/RtPublished.h"
#include "util/SpscRing.h"

#include <iostream>
#include <memory>


static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                      \
    do {                                                                      \
        if (cond) {                                                           \
            ++g_passed;                                                       \
        } else {                                                              \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";       \
            ++g_failed;                                                       \
        }                                                                     \
    } while (0)

namespace {

// ── T1 ───────────────────────────────────────────────────────────────────────

struct Tracked
{
    static inline int alive = 0;
    int value;
    explicit Tracked(int v) : value(v) { ++alive; }
    ~Tracked() { --alive; }
};

void testRtPublished()
{
    std::cout << "[T1] RtPublished parks, frees and never force-frees\n";
    {
        xleth::util::RtPublished<Tracked> pub { std::make_shared<const Tracked>(1) };

        auto held = pub.load();                              // a block in flight
        pub.publish(std::make_shared<const Tracked>(2));
        CHECK(held->value == 1 && pub.load()->value == 2, "reader keeps its snapshot, new readers get the new one");
        CHECK(pub.retiredCount() == 1 && Tracked::alive == 2, "superseded snapshot is parked, not freed");

        CHECK(!pub.drain(20), "drain gives up at its deadline while a reader holds on");
        CHECK(pub.retiredCount() == 1 && Tracked::alive == 2, "and frees nothing when it gives up");

        held.reset();
        CHECK(Tracked::alive == 2, "the reader letting go frees nothing (the retire list still owns it)");
        CHECK(pub.drain(20), "drain succeeds once the reader is done");
        CHECK(pub.retiredCount() == 0 && Tracked::alive == 1, "then the writer frees it");

        // No reader: a publish reclaims the old snapshot on the spot.
        pub.publish(std::make_shared<const Tracked>(3));
        CHECK(pub.retiredCount() == 0 && Tracked::alive == 1, "unheld snapshot is freed by the publish itself");
    }
    CHECK(Tracked::alive == 0, "nothing leaks");
}

// ── T2 ───────────────────────────────────────────────────────────────────────

void testSpscRing()
{
    std::cout << "[T2] SpscRing capacity and order\n";
    xleth::util::SpscRing<int> ring(8);
    int pushed = 0;
    while (ring.push(pushed)) ++pushed;
    CHECK(pushed == 7, "a ring of 8 holds 7 (got " << pushed << ")");

    bool ordered = true;
    int v = -1, popped = 0;
    while (ring.pop(v)) { ordered = ordered && (v == popped); ++popped; }
    CHECK(popped == 7 && ordered, "pops everything in push order");
    CHECK(!ring.pop(v), "empty ring pops nothing");
    CHECK(ring.push(42) && ring.pop(v) && v == 42, "usable again after wrapping");
}

} // namespace

int main()
{
    std::cout << "test_sampler_set_handoff\n";

    testRtPublished();
    testSpscRing();

    std::cout << (g_failed == 0 ? "PASS" : "FAIL")
              << " (" << g_passed << " passed, " << g_failed << " failed)\n";
    return g_failed == 0 ? 0 : 1;
}
