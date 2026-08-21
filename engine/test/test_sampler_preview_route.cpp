// test_sampler_preview_route.cpp
// Unit tests for sampler audition routing: which track's effect rack a preview
// note is heard through.
//
// Coverage:
//   • Dedicated mode — one track, several tracks on a shared bus, scattered
//     tracks (no answer), Master-as-target (deliberately NOT a shared bus).
//   • Selected mode — always the caller's selection, never the timeline's shape.
//   • Off mode      — always dry.
//
// Header-only under test; links nothing. Pass: prints "ALL TESTS PASSED", exit 0.

#include "audio/SamplerPreviewRoute.h"

#include <iostream>
#include <vector>

using xleth::PreviewRouteTrack;
using xleth::SamplerPreviewRouteMode;
using xleth::kPreviewRouteNone;
using xleth::resolveDedicatedPreviewTrack;
using xleth::resolvePreviewRoute;

static int g_passed = 0;
static int g_failed = 0;

#define CHECK_EQ(actual, expected, msg)                                       \
    do {                                                                      \
        const int _a = (actual);                                              \
        const int _e = (expected);                                            \
        if (_a == _e) {                                                       \
            ++g_passed;                                                       \
        } else {                                                              \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg                \
                      << " — got " << _a << ", expected " << _e << "\n";      \
            ++g_failed;                                                       \
        }                                                                     \
    } while (0)

// ─── Dedicated mode ───────────────────────────────────────────────────────────

static void test_no_hosts_is_dry()
{
    // A sample nothing plays yet has no rack to borrow.
    CHECK_EQ(resolveDedicatedPreviewTrack({}), kPreviewRouteNone,
             "unused region routes nowhere");
}

static void test_single_track()
{
    CHECK_EQ(resolveDedicatedPreviewTrack({ { 7, -1 } }), 7,
             "one host track is the dedicated track");

    // The same track hosting several blocks of the region is still one track.
    CHECK_EQ(resolveDedicatedPreviewTrack({ { 7, -1 }, { 7, -1 }, { 7, -1 } }), 7,
             "repeated host entries collapse to one track");

    // A dedicated track that feeds a bus still routes to ITSELF: its own rack
    // is the one the user built for this sample.
    CHECK_EQ(resolveDedicatedPreviewTrack({ { 7, 3 }, { 7, 3 } }), 7,
             "single host wins over its bus");
}

static void test_shared_bus()
{
    // Three tracks play it, all feeding bus 3 → the bus is the shared rack.
    CHECK_EQ(resolveDedicatedPreviewTrack({ { 1, 3 }, { 2, 3 }, { 5, 3 } }), 3,
             "tracks sharing one bus route through that bus");
}

static void test_scattered_tracks_are_dry()
{
    // Different buses — no single rack is correct, so play dry rather than
    // pick one arbitrarily.
    CHECK_EQ(resolveDedicatedPreviewTrack({ { 1, 3 }, { 2, 4 } }), kPreviewRouteNone,
             "tracks on different buses route nowhere");

    // One routed, one direct to Master.
    CHECK_EQ(resolveDedicatedPreviewTrack({ { 1, 3 }, { 2, -1 } }), kPreviewRouteNone,
             "mixed bus/Master routing routes nowhere");
}

static void test_master_is_not_a_shared_bus()
{
    // Everything reaches Master eventually. Treating it as "the shared bus"
    // would push every scattered sample through the master chain, which is not
    // a per-sample rack at all.
    CHECK_EQ(resolveDedicatedPreviewTrack({ { 1, -1 }, { 2, -1 } }), kPreviewRouteNone,
             "two tracks both going straight to Master route nowhere");
}

// ─── Mode dispatch ────────────────────────────────────────────────────────────

static void test_mode_off()
{
    CHECK_EQ(resolvePreviewRoute(SamplerPreviewRouteMode::Off, { { 7, -1 } }, 9),
             kPreviewRouteNone, "Off ignores a dedicated track");
    CHECK_EQ(resolvePreviewRoute(SamplerPreviewRouteMode::Off, {}, 9),
             kPreviewRouteNone, "Off ignores the selected track");
}

static void test_mode_selected()
{
    CHECK_EQ(resolvePreviewRoute(SamplerPreviewRouteMode::Selected, { { 7, -1 } }, 9), 9,
             "Selected overrides the dedicated track");
    CHECK_EQ(resolvePreviewRoute(SamplerPreviewRouteMode::Selected, {}, 9), 9,
             "Selected works with no host tracks");
    CHECK_EQ(resolvePreviewRoute(SamplerPreviewRouteMode::Selected, {}, -1),
             kPreviewRouteNone, "Selected with nothing selected is dry");
}

static void test_mode_dedicated()
{
    CHECK_EQ(resolvePreviewRoute(SamplerPreviewRouteMode::Dedicated, { { 7, -1 } }, 9), 7,
             "Dedicated ignores the selected track");
    CHECK_EQ(resolvePreviewRoute(SamplerPreviewRouteMode::Dedicated, {}, 9),
             kPreviewRouteNone, "Dedicated with no host is dry even when a track is selected");
}

int main()
{
    std::cout << "test_sampler_preview_route\n";
    test_no_hosts_is_dry();
    test_single_track();
    test_shared_bus();
    test_scattered_tracks_are_dry();
    test_master_is_not_a_shared_bus();
    test_mode_off();
    test_mode_selected();
    test_mode_dedicated();

    std::cout << "  passed: " << g_passed << ", failed: " << g_failed << "\n";
    if (g_failed != 0) {
        std::cerr << "TESTS FAILED\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
