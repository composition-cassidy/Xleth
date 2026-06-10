// test_track_routing.cpp — Prompt 2A: output-routing model, validation,
// serialization, undo command, and bridge result shape.
// Build: see engine/CMakeLists.txt target "test_track_routing"
// Run:   test_track_routing.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1

#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "audio/TrackRouting.h"
#include "commands/UndoManager.h"
#include "commands/TimelineCommands.h"
#include <iostream>
#include <nlohmann/json.hpp>

// ─── Minimal test harness ─────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (cond) {                                                             \
            ++g_passed;                                                         \
        } else {                                                                \
            std::cerr << "  FAIL [line " << __LINE__ << "] " << (msg) << "\n"; \
            ++g_failed;                                                         \
        }                                                                       \
    } while (0)

// ─── Helpers ─────────────────────────────────────────────────────────────────

static int addTrack(Timeline& tl, const std::string& name, bool visualOnly = false) {
    TrackInfo t;
    t.name       = name;
    t.visualOnly = visualOnly;
    return tl.addTrack(t);
}

// ─── T1: Default route is Master ─────────────────────────────────────────────

static void test_defaultRoute() {
    std::cout << "\n[T1] Default route is Master (-1)\n";
    Timeline tl;
    int a = addTrack(tl, "A");
    CHECK(tl.getTrackOutputRoute(a).targetTrackId == -1, "default targetTrackId == -1");
}

// ─── T2: Serialize non-default route ─────────────────────────────────────────

static void test_serializeNonDefault() {
    std::cout << "\n[T2] Serialize non-default outputRoute\n";
    Timeline tl;
    int a = addTrack(tl, "A");
    int b = addTrack(tl, "B");

    auto r = tl.setTrackOutputRoute(a, b);
    CHECK(r.ok(), "setTrackOutputRoute A->B ok");

    nlohmann::json j;
    to_json(j, *tl.getTrack(a));
    CHECK(j.contains("outputRoute"), "outputRoute key present when non-default");
    CHECK(j["outputRoute"].contains("targetTrackId"), "targetTrackId key present");
    CHECK(j["outputRoute"]["targetTrackId"].get<int>() == b, "targetTrackId == b");
}

// ─── T3: Serialize default route (omitted) ───────────────────────────────────

static void test_serializeDefault() {
    std::cout << "\n[T3] Serialize default outputRoute is omitted\n";
    Timeline tl;
    int a = addTrack(tl, "A");

    nlohmann::json j;
    to_json(j, *tl.getTrack(a));
    CHECK(!j.contains("outputRoute"), "outputRoute key absent when default (Master)");
}

// ─── T4: Deserialize old project JSON (no outputRoute key) ───────────────────

static void test_deserializeOldProject() {
    std::cout << "\n[T4] Deserialize old project — no outputRoute key → Master\n";
    nlohmann::json j = {
        {"id",           1},
        {"name",         "OldTrack"},
        {"volume",       1.0},
        {"pan",          0.0},
        {"muted",        false},
        {"solo",         false},
        {"order",        0},
        {"videoX",       0.0}, {"videoY", 0.0}, {"videoW", 1920.0}, {"videoH", 1080.0},
        {"videoOpacity", 1.0}, {"videoZOrder", 0},
    };
    TrackInfo t;
    from_json(j, t);
    CHECK(t.outputRoute.targetTrackId == -1, "old project loads with Master default");
    CHECK(t.sends.empty(),          "sends empty");
    CHECK(t.sidechainRoutes.empty(), "sidechainRoutes empty");
}

// ─── T5: Deserialize route to Master ─────────────────────────────────────────

static void test_deserializeToMaster() {
    std::cout << "\n[T5] Deserialize explicit outputRoute targetTrackId == -1\n";
    nlohmann::json j = {
        {"id",           2},
        {"name",         "Track"},
        {"volume",       1.0}, {"pan", 0.0}, {"muted", false}, {"solo", false},
        {"order",        0},
        {"videoX",       0.0}, {"videoY", 0.0}, {"videoW", 1920.0}, {"videoH", 1080.0},
        {"videoOpacity", 1.0}, {"videoZOrder", 0},
        {"outputRoute",  {{"targetTrackId", -1}}}
    };
    TrackInfo t;
    from_json(j, t);
    CHECK(t.outputRoute.targetTrackId == -1, "explicit Master round-trips correctly");
}

// ─── T6: Deserialize route to another track ──────────────────────────────────

static void test_deserializeToTrack() {
    std::cout << "\n[T6] Deserialize outputRoute targetTrackId == 7\n";
    nlohmann::json j = {
        {"id",           3},
        {"name",         "Track"},
        {"volume",       1.0}, {"pan", 0.0}, {"muted", false}, {"solo", false},
        {"order",        0},
        {"videoX",       0.0}, {"videoY", 0.0}, {"videoW", 1920.0}, {"videoH", 1080.0},
        {"videoOpacity", 1.0}, {"videoZOrder", 0},
        {"outputRoute",  {{"targetTrackId", 7}}}
    };
    TrackInfo t;
    from_json(j, t);
    CHECK(t.outputRoute.targetTrackId == 7, "targetTrackId == 7 round-trips correctly");
}

// ─── T7: Reject self-route ────────────────────────────────────────────────────

static void test_rejectSelfRoute() {
    std::cout << "\n[T7] Reject self-route\n";
    Timeline tl;
    int a = addTrack(tl, "A");
    auto r = xleth::validateTrackOutputRoute(tl, a, a);
    CHECK(!r.ok(), "self-route rejected");
    CHECK(r.reason == xleth::RoutingValidationReason::self_route, "reason == self_route");
    CHECK(std::string(r.reasonString()) == "self_route", "reasonString() == 'self_route'");

    // Model unchanged
    CHECK(tl.getTrackOutputRoute(a).targetTrackId == -1, "model unchanged after rejection");
}

// ─── T8: Reject unknown target ────────────────────────────────────────────────

static void test_rejectUnknownTarget() {
    std::cout << "\n[T8] Reject unknown target\n";
    Timeline tl;
    int a = addTrack(tl, "A");
    auto r = xleth::validateTrackOutputRoute(tl, a, 9999);
    CHECK(!r.ok(), "unknown target rejected");
    CHECK(r.reason == xleth::RoutingValidationReason::unknown_track, "reason == unknown_track");
}

// ─── T9: Reject simple cycle A→B, then B→A ───────────────────────────────────

static void test_rejectSimpleCycle() {
    std::cout << "\n[T9] Reject simple 2-cycle (A→B then B→A)\n";
    Timeline tl;
    int a = addTrack(tl, "A");
    int b = addTrack(tl, "B");

    auto r1 = tl.setTrackOutputRoute(a, b);
    CHECK(r1.ok(), "A→B ok");

    auto r2 = xleth::validateTrackOutputRoute(tl, b, a);
    CHECK(!r2.ok(), "B→A creates cycle, rejected");
    CHECK(r2.reason == xleth::RoutingValidationReason::cycle, "reason == cycle");
    CHECK(std::string(r2.reasonString()) == "cycle", "reasonString() == 'cycle'");
}

// ─── T10: Reject longer cycle A→B→C, then C→A ───────────────────────────────

static void test_rejectLongerCycle() {
    std::cout << "\n[T10] Reject 3-cycle (A→B→C then C→A)\n";
    Timeline tl;
    int a = addTrack(tl, "A");
    int b = addTrack(tl, "B");
    int c = addTrack(tl, "C");

    tl.setTrackOutputRoute(a, b); // A→B
    tl.setTrackOutputRoute(b, c); // B→C

    auto r = xleth::validateTrackOutputRoute(tl, c, a);
    CHECK(!r.ok(), "C→A creates 3-cycle, rejected");
    CHECK(r.reason == xleth::RoutingValidationReason::cycle, "reason == cycle");
}

// ─── T11: Allow reset to Master ──────────────────────────────────────────────

static void test_resetToMaster() {
    std::cout << "\n[T11] Allow reset to Master (-1)\n";
    Timeline tl;
    int a = addTrack(tl, "A");
    int b = addTrack(tl, "B");

    tl.setTrackOutputRoute(a, b);
    CHECK(tl.getTrackOutputRoute(a).targetTrackId == b, "routed to b");

    auto r = tl.setTrackOutputRoute(a, -1);
    CHECK(r.ok(), "reset to Master ok");
    CHECK(tl.getTrackOutputRoute(a).targetTrackId == -1, "reset persisted");
}

// ─── T12: Undo/redo route mutation ───────────────────────────────────────────

static void test_undoRedo() {
    std::cout << "\n[T12] Undo/redo SetTrackOutputRouteCommand\n";
    Timeline tl;
    UndoManager um;
    int a = addTrack(tl, "A");
    int b = addTrack(tl, "B");

    // Validate before creating the command (bridge pattern)
    auto vr = xleth::validateTrackOutputRoute(tl, a, b);
    CHECK(vr.ok(), "A→B validated");

    um.execute(std::make_unique<SetTrackOutputRouteCommand>(a, b, tl), tl);
    CHECK(tl.getTrackOutputRoute(a).targetTrackId == b, "execute: route set to b");

    um.undo(tl);
    CHECK(tl.getTrackOutputRoute(a).targetTrackId == -1, "undo: route restored to Master");

    um.redo(tl);
    CHECK(tl.getTrackOutputRoute(a).targetTrackId == b, "redo: route back to b");
}

// ─── T13: Invalid route mutation does not mutate model ───────────────────────

static void test_invalidDoesNotMutate() {
    std::cout << "\n[T13] Invalid route does not mutate model\n";
    Timeline tl;
    int a = addTrack(tl, "A");
    int b = addTrack(tl, "B");
    tl.setTrackOutputRoute(a, b); // A→B established

    int before = tl.getTrackOutputRoute(b).targetTrackId;
    auto r = tl.setTrackOutputRoute(b, a); // would create cycle
    CHECK(!r.ok(), "B→A rejected");
    CHECK(tl.getTrackOutputRoute(b).targetTrackId == before, "model unchanged after rejection");
}

// ─── T14: Bridge result — {ok:false, reason} for invalid route ───────────────

static void test_bridgeResultInvalid() {
    std::cout << "\n[T14] Validation result produces correct reason strings\n";
    Timeline tl;
    int a = addTrack(tl, "A");

    auto r1 = xleth::validateTrackOutputRoute(tl, a, a);
    CHECK(std::string(r1.reasonString()) == "self_route", "self_route string");

    auto r2 = xleth::validateTrackOutputRoute(tl, a, 99999);
    CHECK(std::string(r2.reasonString()) == "unknown_track", "unknown_track string");

    auto r3 = xleth::validateTrackOutputRoute(tl, -1, -1);
    CHECK(std::string(r3.reasonString()) == "master_as_source", "master_as_source string");
}

// ─── T15: Bridge result — {ok:true} for valid route ─────────────────────────

static void test_bridgeResultValid() {
    std::cout << "\n[T15] Validation result ok for valid routes\n";
    Timeline tl;
    int a = addTrack(tl, "A");
    int b = addTrack(tl, "B");

    auto r1 = xleth::validateTrackOutputRoute(tl, a, -1);
    CHECK(r1.ok(), "route to Master is ok");
    CHECK(std::string(r1.reasonString()) == "ok", "reason string 'ok'");

    auto r2 = xleth::validateTrackOutputRoute(tl, a, b);
    CHECK(r2.ok(), "route to peer track is ok");
}

// ─── T16: Reject visual-only target ──────────────────────────────────────────

static void test_rejectVisualOnlyTarget() {
    std::cout << "\n[T16] Reject visual-only target\n";
    Timeline tl;
    int a = addTrack(tl, "A");
    int v = addTrack(tl, "VisOnly", /*visualOnly=*/true);

    auto r = xleth::validateTrackOutputRoute(tl, a, v);
    CHECK(!r.ok(), "visual-only target rejected");
    CHECK(r.reason == xleth::RoutingValidationReason::invalid_target, "reason == invalid_target");
}

// ─── T17: Source track unknown → unknown_track ───────────────────────────────

static void test_unknownSource() {
    std::cout << "\n[T17] Unknown source track returns unknown_track\n";
    Timeline tl;
    int b = addTrack(tl, "B");

    auto r = xleth::validateTrackOutputRoute(tl, 99999, b);
    CHECK(!r.ok(), "unknown source rejected");
    CHECK(r.reason == xleth::RoutingValidationReason::unknown_track, "reason == unknown_track");
}

// ─── T18: Regression — audio DSP not affected (model-only check) ─────────────

static void test_audioDspUnchanged() {
    std::cout << "\n[T18] Regression — routing fields are model-only, no audio effect\n";
    // This test verifies the model compiles and runs without touching MixEngine.
    // Full audio-inert assertion is in test_offline_render.cpp (Prompt 2B gate).
    Timeline tl;
    int a = addTrack(tl, "Kick");
    int b = addTrack(tl, "DrumBus");
    tl.setTrackOutputRoute(a, b);
    // If we get here without a crash, the model-level change is inert.
    CHECK(tl.getTrackOutputRoute(a).targetTrackId == b, "route stored correctly");
    CHECK(tl.getTrackOutputRoute(b).targetTrackId == -1, "bus still routes to Master");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

int main() {
    std::cout << "=== test_track_routing (Prompt 2A) ===\n";

    test_defaultRoute();
    test_serializeNonDefault();
    test_serializeDefault();
    test_deserializeOldProject();
    test_deserializeToMaster();
    test_deserializeToTrack();
    test_rejectSelfRoute();
    test_rejectUnknownTarget();
    test_rejectSimpleCycle();
    test_rejectLongerCycle();
    test_resetToMaster();
    test_undoRedo();
    test_invalidDoesNotMutate();
    test_bridgeResultInvalid();
    test_bridgeResultValid();
    test_rejectVisualOnlyTarget();
    test_unknownSource();
    test_audioDspUnchanged();

    std::cout << "\n=== Results: " << g_passed << " passed, " << g_failed << " failed ===\n";
    if (g_failed > 0) {
        std::cerr << "FAILED: " << g_failed << " test(s) failed\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
