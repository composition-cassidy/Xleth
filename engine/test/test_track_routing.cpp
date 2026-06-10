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

// ─── RoutePlan helpers (Prompt 2B) ───────────────────────────────────────────

static xleth::RoutePlanSlotInput slot(int trackId, int target = -1,
                                      bool muted = false, bool solo = false,
                                      bool visualOnly = false) {
    xleth::RoutePlanSlotInput s;
    s.trackId = trackId;
    s.outputTargetTrackId = target;
    s.muted = muted;
    s.solo = solo;
    s.visualOnly = visualOnly;
    return s;
}

// Index of slot trackId within topoOrder (position in processing order).
static int orderPos(const xleth::RoutePlan& p, int slotIndex) {
    for (int i = 0; i < p.slotCount; ++i)
        if (p.topoOrder[i] == slotIndex) return i;
    return -1;
}

// ─── R1: Unrouted plan is identity + audible == !muted ───────────────────────

static void test_planUnrouted() {
    std::cout << "\n[R1] RoutePlan: unrouted → identity order, all to Master\n";
    xleth::RoutePlanSlotInput in[3] = { slot(10), slot(20), slot(30) };
    xleth::RoutePlan p;
    xleth::buildRoutePlan(in, 3, p);

    CHECK(p.slotCount == 3, "slotCount == 3");
    CHECK(!p.cycleDetected && !p.targetCorrected, "no defensive corrections");
    for (int i = 0; i < 3; ++i) {
        CHECK(p.outputTargetSlot[i] == -1, "slot routes to Master");
        CHECK(p.topoOrder[i] == i, "identity processing order");
        CHECK(p.audible[i], "unmuted slot audible");
    }
}

// ─── R2: Source → bus resolves to target slot, source before bus ─────────────

static void test_planSourceToBus() {
    std::cout << "\n[R2] RoutePlan: Kick(10)→DrumBus(20)→Master\n";
    // Kick routes to DrumBus; DrumBus routes to Master.
    xleth::RoutePlanSlotInput in[2] = { slot(10, 20), slot(20, -1) };
    xleth::RoutePlan p;
    xleth::buildRoutePlan(in, 2, p);

    CHECK(p.outputTargetSlot[0] == 1, "Kick target slot == DrumBus slot (1)");
    CHECK(p.outputTargetSlot[1] == -1, "DrumBus → Master");
    CHECK(orderPos(p, 0) < orderPos(p, 1), "Kick processed before DrumBus");
    CHECK(p.audible[0] && p.audible[1], "both audible (no mute/solo)");
}

// ─── R3: Bus declared before source → still ordered correctly ────────────────

static void test_planOrderIndependence() {
    std::cout << "\n[R3] RoutePlan: bus listed before its source still topo-orders\n";
    // Slot 0 = DrumBus(20)→Master, slot 1 = Kick(10)→DrumBus(20).
    xleth::RoutePlanSlotInput in[2] = { slot(20, -1), slot(10, 20) };
    xleth::RoutePlan p;
    xleth::buildRoutePlan(in, 2, p);

    CHECK(p.outputTargetSlot[1] == 0, "Kick (slot 1) target == DrumBus (slot 0)");
    CHECK(orderPos(p, 1) < orderPos(p, 0), "Kick processed before DrumBus despite list order");
}

// ─── R4: Nested A→B1→B2→Master orders all three ──────────────────────────────

static void test_planNested() {
    std::cout << "\n[R4] RoutePlan: A(10)→B1(20)→B2(30)→Master\n";
    xleth::RoutePlanSlotInput in[3] = { slot(10, 20), slot(20, 30), slot(30, -1) };
    xleth::RoutePlan p;
    xleth::buildRoutePlan(in, 3, p);

    CHECK(p.outputTargetSlot[0] == 1, "A→B1");
    CHECK(p.outputTargetSlot[1] == 2, "B1→B2");
    CHECK(p.outputTargetSlot[2] == -1, "B2→Master");
    CHECK(orderPos(p, 0) < orderPos(p, 1), "A before B1");
    CHECK(orderPos(p, 1) < orderPos(p, 2), "B1 before B2");
}

// ─── R5: Muted source not audible; muted bus subtree silenced ────────────────

static void test_planMute() {
    std::cout << "\n[R5] RoutePlan: muted source / muted bus\n";
    {
        // Muted source feeding a bus.
        xleth::RoutePlanSlotInput in[2] = { slot(10, 20, /*muted=*/true), slot(20, -1) };
        xleth::RoutePlan p;
        xleth::buildRoutePlan(in, 2, p);
        CHECK(!p.audible[0], "muted source not audible");
        CHECK(p.audible[1], "bus still audible");
    }
    {
        // Muted bus: its audible flag is false → it never forwards its subtree.
        xleth::RoutePlanSlotInput in[2] = { slot(10, 20), slot(20, -1, /*muted=*/true) };
        xleth::RoutePlan p;
        xleth::buildRoutePlan(in, 2, p);
        CHECK(p.audible[0], "source itself audible (it still sums into the bus)");
        CHECK(!p.audible[1], "muted bus not audible → subtree silenced downstream");
    }
}

// ─── R6: Solo source keeps its downstream bus path audible ───────────────────

static void test_planSoloSource() {
    std::cout << "\n[R6] RoutePlan: solo source → source + downstream bus audible\n";
    // Kick(10)→Bus(20)→Master; Snare(30)→Bus(20). Solo Kick.
    xleth::RoutePlanSlotInput in[3] = {
        slot(10, 20, false, /*solo=*/true), slot(20, -1), slot(30, 20)
    };
    xleth::RoutePlan p;
    xleth::buildRoutePlan(in, 3, p);

    CHECK(p.audible[0], "soloed Kick audible");
    CHECK(p.audible[1], "downstream Bus audible so Kick is heard");
    CHECK(!p.audible[2], "sibling Snare not audible (not soloed)");
}

// ─── R7: Solo bus keeps upstream sources audible ─────────────────────────────

static void test_planSoloBus() {
    std::cout << "\n[R7] RoutePlan: solo bus → upstream sources audible through it\n";
    // Kick(10)→Bus(20)→Master; Snare(30)→Bus(20); Lead(40)→Master. Solo Bus.
    xleth::RoutePlanSlotInput in[4] = {
        slot(10, 20), slot(20, -1, false, /*solo=*/true), slot(30, 20), slot(40, -1)
    };
    xleth::RoutePlan p;
    xleth::buildRoutePlan(in, 4, p);

    CHECK(p.audible[1], "soloed Bus audible");
    CHECK(p.audible[0], "upstream Kick audible through soloed Bus");
    CHECK(p.audible[2], "upstream Snare audible through soloed Bus");
    CHECK(!p.audible[3], "unrelated Lead not audible");
}

// ─── R8: Missing / visual-only target fails closed to Master ─────────────────

static void test_planTargetCorrection() {
    std::cout << "\n[R8] RoutePlan: missing & visual-only targets → Master\n";
    {
        xleth::RoutePlanSlotInput in[1] = { slot(10, /*target=*/999) }; // no such track
        xleth::RoutePlan p;
        xleth::buildRoutePlan(in, 1, p);
        CHECK(p.outputTargetSlot[0] == -1, "missing target routed to Master");
        CHECK(p.targetCorrected, "targetCorrected flagged");
    }
    {
        // Target exists but is visual-only → invalid bus, fail closed.
        xleth::RoutePlanSlotInput in[2] = { slot(10, 20), slot(20, -1, false, false, /*visualOnly=*/true) };
        xleth::RoutePlan p;
        xleth::buildRoutePlan(in, 2, p);
        CHECK(p.outputTargetSlot[0] == -1, "visual-only target routed to Master");
        CHECK(p.targetCorrected, "targetCorrected flagged for visual-only");
    }
}

// ─── R9: Cycle fails closed to all-Master ────────────────────────────────────

static void test_planCycleFailClosed() {
    std::cout << "\n[R9] RoutePlan: cycle → fail closed to all-Master\n";
    // A(10)→B(20), B(20)→A(10): a 2-cycle the mutation layer would reject, but
    // the DSP builder must still defend against it.
    xleth::RoutePlanSlotInput in[2] = { slot(10, 20), slot(20, 10) };
    xleth::RoutePlan p;
    xleth::buildRoutePlan(in, 2, p);

    CHECK(p.cycleDetected, "cycle detected");
    CHECK(p.outputTargetSlot[0] == -1 && p.outputTargetSlot[1] == -1,
          "all slots forced to Master on cycle");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

int main() {
    std::cout << "=== test_track_routing (Prompt 2A + 2B) ===\n";

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

    // Prompt 2B — pure RoutePlan builder (topo order + mute/solo closure).
    test_planUnrouted();
    test_planSourceToBus();
    test_planOrderIndependence();
    test_planNested();
    test_planMute();
    test_planSoloSource();
    test_planSoloBus();
    test_planTargetCorrection();
    test_planCycleFailClosed();

    std::cout << "\n=== Results: " << g_passed << " passed, " << g_failed << " failed ===\n";
    if (g_failed > 0) {
        std::cerr << "FAILED: " << g_failed << " test(s) failed\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
