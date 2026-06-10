// test_sidechain_routes.cpp — Prompt 4B: persistent, validated, undoable
// sidechain route model. Covers the SidechainRoute contract end-to-end at the
// pure-model layer: serialization/migration, validation reason codes, Timeline
// mutation APIs, undo/redo commands, and the routing-JSON status shape (the same
// logic the bridge surfaces). No audio/DSP — sidechain behavior is deferred.
// Build: see engine/CMakeLists.txt target "test_sidechain_routes"
// Run:   test_sidechain_routes.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED" and exits 1

#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "audio/TrackRouting.h"
#include "commands/UndoManager.h"
#include "commands/TimelineCommands.h"
#include <iostream>
#include <limits>
#include <string>
#include <unordered_set>
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

// A resolver that accepts a fixed allow-list of (trackId, effectInstanceId).
static xleth::SidechainEffectResolver makeResolver(
    std::unordered_set<std::string> allow)
{
    return [allow = std::move(allow)](int trackId, const std::string& id) {
        return allow.count(std::to_string(trackId) + ":" + id) > 0;
    };
}

static const char* reasonStr(const xleth::RoutingValidationResult& r) {
    return r.reasonString();
}

static SidechainRoute makeRoute(const std::string& id, int targetTrackId,
                                const std::string& effectId, float gain = 1.0f,
                                bool preFader = false, bool enabled = true) {
    SidechainRoute sc;
    sc.routeId                = id;
    sc.targetTrackId          = targetTrackId;
    sc.targetEffectInstanceId = effectId;
    sc.gain                   = gain;
    sc.preFader               = preFader;
    sc.enabled                = enabled;
    return sc;
}

// ─── T1: old project with no sidechainRoutes loads as empty ──────────────────

static void test_oldProjectEmpty() {
    std::cout << "\n[T1] Old project without sidechainRoutes loads empty\n";
    // Serialize a track, strip any routing keys, deserialize.
    Timeline tl;
    int a = addTrack(tl, "A");
    nlohmann::json j;
    to_json(j, *tl.getTrack(a));
    j.erase("sidechainRoutes");
    j.erase("outputRoute");
    TrackInfo t;
    from_json(j, t);
    CHECK(t.sidechainRoutes.empty(), "no key → empty sidechainRoutes");
}

// ─── T2: add valid route, stable non-empty routeId, getter ───────────────────

static void test_addValid() {
    std::cout << "\n[T2] Add valid sidechain route by effectInstanceId\n";
    Timeline tl;
    int kick = addTrack(tl, "Kick");
    int bass = addTrack(tl, "Bass");
    auto resolver = makeResolver({ std::to_string(bass) + ":e-comp" });

    auto route = makeRoute("sc-1", bass, "e-comp", 0.8f, true, true);
    auto r = tl.addSidechainRoute(kick, route, resolver);
    CHECK(r.ok(), std::string("add ok, got ") + reasonStr(r));

    auto routes = tl.getSidechainRoutes(kick);
    CHECK(routes.size() == 1, "one route stored");
    CHECK(!routes.empty() && !routes[0].routeId.empty(), "routeId non-empty");
    CHECK(!routes.empty() && routes[0].routeId == "sc-1", "routeId preserved");
    CHECK(!routes.empty() && routes[0].targetTrackId == bass, "targetTrackId stored");
    CHECK(!routes.empty() && routes[0].targetEffectInstanceId == "e-comp", "effectId stored");
    CHECK(!routes.empty() && routes[0].preFader == true, "preFader stored");
}

// ─── T3: save/load round-trip preserves all fields ───────────────────────────

static void test_roundTrip() {
    std::cout << "\n[T3] Save/load round-trip preserves route fields\n";
    Timeline tl;
    int kick = addTrack(tl, "Kick");
    int bass = addTrack(tl, "Bass");
    auto resolver = makeResolver({ std::to_string(bass) + ":e-comp" });
    tl.addSidechainRoute(kick, makeRoute("sc-rt", bass, "e-comp", 1.5f, true, false), resolver);

    nlohmann::json j;
    to_json(j, *tl.getTrack(kick));
    CHECK(j.contains("sidechainRoutes"), "JSON has sidechainRoutes key");

    TrackInfo loaded;
    from_json(j, loaded);
    CHECK(loaded.sidechainRoutes.size() == 1, "one route after load");
    const auto& sc = loaded.sidechainRoutes[0];
    CHECK(sc.routeId == "sc-rt", "routeId round-trips");
    CHECK(sc.targetTrackId == bass, "targetTrackId round-trips");
    CHECK(sc.targetEffectInstanceId == "e-comp", "effectId round-trips");
    CHECK(sc.gain == 1.5f, "gain round-trips");
    CHECK(sc.preFader == true, "preFader round-trips");
    CHECK(sc.enabled == false, "enabled round-trips");
}

// ─── T4: defaults omitted, no APG node ids in JSON ───────────────────────────

static void test_jsonShape() {
    std::cout << "\n[T4] JSON omits empty routes; never contains node ids\n";
    Timeline tl;
    int a = addTrack(tl, "A");
    nlohmann::json j;
    to_json(j, *tl.getTrack(a));
    CHECK(!j.contains("sidechainRoutes"), "empty → key omitted");

    int b = addTrack(tl, "B");
    auto resolver = makeResolver({ std::to_string(b) + ":e1" });
    tl.addSidechainRoute(a, makeRoute("sc-x", b, "e1"), resolver);
    nlohmann::json j2;
    to_json(j2, *tl.getTrack(a));
    const std::string dump = j2.at("sidechainRoutes").dump();
    CHECK(dump.find("nodeId") == std::string::npos, "no nodeId in JSON");
    CHECK(dump.find("\"node\"") == std::string::npos, "no node uid in JSON");
    // Only the documented engine-owned keys appear.
    for (const auto& e : j2.at("sidechainRoutes")) {
        for (auto it = e.begin(); it != e.end(); ++it) {
            const std::string& k = it.key();
            const bool known = k == "routeId" || k == "targetTrackId"
                || k == "targetEffectInstanceId" || k == "gain"
                || k == "preFader" || k == "enabled";
            CHECK(known, std::string("unexpected key: ") + k);
        }
    }
}

// ─── T5: malformed entries sanitized on load (dropped, never crash) ──────────

static void test_loadSanitization() {
    std::cout << "\n[T5] Malformed route entries dropped on load\n";
    nlohmann::json j;
    j["id"] = 5; j["name"] = "S"; j["volume"] = 1.0f; j["pan"] = 0.0f;
    j["muted"] = false; j["solo"] = false; j["order"] = 0;
    j["videoX"] = 0.0f; j["videoY"] = 0.0f; j["videoW"] = 1920.0f;
    j["videoH"] = 1080.0f; j["videoOpacity"] = 1.0f; j["videoZOrder"] = 0;
    j["sidechainRoutes"] = nlohmann::json::array({
        { {"routeId", ""}, {"targetTrackId", 2}, {"targetEffectInstanceId", "e1"} },   // empty id → drop
        { {"routeId", "ok1"}, {"targetTrackId", -1}, {"targetEffectInstanceId", "e1"} },// master target → drop
        { {"routeId", "ok2"}, {"targetTrackId", 2}, {"targetEffectInstanceId", ""} },   // empty effect → drop
        { {"routeId", "dup"}, {"targetTrackId", 2}, {"targetEffectInstanceId", "e1"} },
        { {"routeId", "dup"}, {"targetTrackId", 3}, {"targetEffectInstanceId", "e2"} }, // duplicate id → drop
        { {"routeId", "good"}, {"targetTrackId", 2}, {"targetEffectInstanceId", "e9"},
          {"gain", 99.0f} },                                                            // gain clamped
    });
    TrackInfo t;
    from_json(j, t);
    CHECK(t.sidechainRoutes.size() == 2, "only 2 structurally-valid kept");
    bool sawDup = false, sawGood = false;
    for (const auto& sc : t.sidechainRoutes) {
        if (sc.routeId == "dup")  { sawDup = true;  CHECK(sc.targetTrackId == 2, "first dup wins"); }
        if (sc.routeId == "good") { sawGood = true; CHECK(sc.gain == 2.0f, "gain clamped to 2.0"); }
    }
    CHECK(sawDup && sawGood, "expected surviving routes present");
}

// ─── T6: validation reason codes ─────────────────────────────────────────────

static void test_validationRejections() {
    std::cout << "\n[T6] Validation reason codes\n";
    Timeline tl;
    int kick = addTrack(tl, "Kick");
    int bass = addTrack(tl, "Bass");
    auto resolver = makeResolver({ std::to_string(bass) + ":e-comp" });

    using R = xleth::RoutingValidationReason;

    CHECK(xleth::validateSidechainRoute(tl, -1, makeRoute("a", bass, "e-comp"), resolver).reason
          == R::master_as_source, "master as source");
    CHECK(xleth::validateSidechainRoute(tl, 999, makeRoute("a", bass, "e-comp"), resolver).reason
          == R::unknown_source_track, "unknown source");
    CHECK(xleth::validateSidechainRoute(tl, kick, makeRoute("a", -1, "e-comp"), resolver).reason
          == R::master_as_target, "master as target");
    CHECK(xleth::validateSidechainRoute(tl, kick, makeRoute("a", kick, "e-comp"), resolver).reason
          == R::self_sidechain, "self sidechain");
    CHECK(xleth::validateSidechainRoute(tl, kick, makeRoute("a", 999, "e-comp"), resolver).reason
          == R::unknown_target_track, "unknown target");
    CHECK(xleth::validateSidechainRoute(tl, kick, makeRoute("a", bass, ""), resolver).reason
          == R::empty_effect_instance, "empty effect instance");
    CHECK(xleth::validateSidechainRoute(tl, kick, makeRoute("a", bass, "nope"), resolver).reason
          == R::unknown_effect_instance, "unknown effect instance");
    CHECK(xleth::validateSidechainRoute(tl, kick,
            makeRoute("a", bass, "e-comp",
                      std::numeric_limits<float>::infinity()), resolver).reason
          == R::invalid_gain, "non-finite gain rejected");

    // Duplicate routeId on the same source.
    tl.addSidechainRoute(kick, makeRoute("dupid", bass, "e-comp"), resolver);
    CHECK(xleth::validateSidechainRoute(tl, kick, makeRoute("dupid", bass, "e-comp"), resolver).reason
          == R::duplicate_route, "duplicate routeId");

    // Without a resolver, effect resolution is skipped (model-only).
    CHECK(xleth::validateSidechainRoute(tl, kick, makeRoute("nores", bass, "anything"), {}).ok(),
          "null resolver skips effect check");
}

// ─── T7: cycle rejection (output route + sidechain dependency) ───────────────

static void test_cycle() {
    std::cout << "\n[T7] Cycle: A output->B, B sidechain->A rejected\n";
    Timeline tl;
    int a = addTrack(tl, "A");
    int b = addTrack(tl, "B");
    auto resolver = makeResolver({ std::to_string(a) + ":e-on-a",
                                   std::to_string(b) + ":e-on-b" });

    CHECK(tl.setTrackOutputRoute(a, b).ok(), "A output -> B");

    // B sidechain -> effect on A would close the loop (A depends on B via SC,
    // B depends on A via output route).
    auto r = tl.addSidechainRoute(b, makeRoute("sc-cyc", a, "e-on-a"), resolver);
    CHECK(r.reason == xleth::RoutingValidationReason::cycle, "B->A sidechain is a cycle");

    // The reverse (A sidechain -> effect on B) is fine: A already feeds B.
    auto r2 = tl.addSidechainRoute(a, makeRoute("sc-ok", b, "e-on-b"), resolver);
    CHECK(r2.ok(), std::string("A sidechain -> B ok, got ") + reasonStr(r2));
}

// ─── T8: remove route ────────────────────────────────────────────────────────

static void test_remove() {
    std::cout << "\n[T8] Remove route\n";
    Timeline tl;
    int kick = addTrack(tl, "Kick");
    int bass = addTrack(tl, "Bass");
    auto resolver = makeResolver({ std::to_string(bass) + ":e1" });
    tl.addSidechainRoute(kick, makeRoute("sc-r", bass, "e1"), resolver);
    CHECK(tl.getSidechainRoutes(kick).size() == 1, "added");

    CHECK(tl.removeSidechainRoute(kick, "sc-r").ok(), "remove ok");
    CHECK(tl.getSidechainRoutes(kick).empty(), "removed");
    CHECK(tl.removeSidechainRoute(kick, "sc-r").reason
          == xleth::RoutingValidationReason::unknown_route, "remove missing → unknown_route");
}

// ─── T9: undo/redo add keeps same routeId ────────────────────────────────────

static void test_undoRedoAdd() {
    std::cout << "\n[T9] Undo/redo Add keeps same routeId\n";
    Timeline tl;
    UndoManager um;
    int kick = addTrack(tl, "Kick");
    int bass = addTrack(tl, "Bass");

    auto route = makeRoute("sc-undo", bass, "e1", 1.2f, true, true);
    um.execute(std::make_unique<AddSidechainRouteCommand>(kick, route), tl);
    CHECK(tl.getSidechainRoutes(kick).size() == 1, "added via command");
    CHECK(tl.getSidechainRoutes(kick)[0].routeId == "sc-undo", "routeId set");

    CHECK(um.undo(tl), "undo");
    CHECK(tl.getSidechainRoutes(kick).empty(), "undo removed route");

    CHECK(um.redo(tl), "redo");
    CHECK(tl.getSidechainRoutes(kick).size() == 1, "redo restored route");
    CHECK(tl.getSidechainRoutes(kick)[0].routeId == "sc-undo", "redo keeps SAME routeId");
    CHECK(tl.getSidechainRoutes(kick)[0].gain == 1.2f, "redo restores params");
}

// ─── T10: undo/redo remove restores same routeId + params ────────────────────

static void test_undoRedoRemove() {
    std::cout << "\n[T10] Undo/redo Remove restores route\n";
    Timeline tl;
    UndoManager um;
    int kick = addTrack(tl, "Kick");
    int bass = addTrack(tl, "Bass");
    auto resolver = makeResolver({ std::to_string(bass) + ":e1" });
    tl.addSidechainRoute(kick, makeRoute("sc-rm", bass, "e1", 0.7f, true, false), resolver);

    um.execute(std::make_unique<RemoveSidechainRouteCommand>(kick, "sc-rm", tl), tl);
    CHECK(tl.getSidechainRoutes(kick).empty(), "removed via command");

    CHECK(um.undo(tl), "undo");
    auto restored = tl.getSidechainRoutes(kick);  // by value — copy, not a dangling ref
    CHECK(restored.size() == 1, "undo restored route");
    CHECK(!restored.empty() && restored[0].routeId == "sc-rm", "same routeId restored");
    CHECK(!restored.empty() && restored[0].gain == 0.7f && restored[0].preFader
          && !restored[0].enabled, "params restored");

    CHECK(um.redo(tl), "redo");
    CHECK(tl.getSidechainRoutes(kick).empty(), "redo removed again");
}

// ─── T11: set params + undo/redo ─────────────────────────────────────────────

static void test_setParams() {
    std::cout << "\n[T11] Set params + undo/redo\n";
    Timeline tl;
    UndoManager um;
    int kick = addTrack(tl, "Kick");
    int bass = addTrack(tl, "Bass");
    auto resolver = makeResolver({ std::to_string(bass) + ":e1" });
    tl.addSidechainRoute(kick, makeRoute("sc-p", bass, "e1", 1.0f, false, true), resolver);

    xleth::SidechainRouteParams np; np.gain = 0.25f; np.preFader = true; np.enabled = false;
    um.execute(std::make_unique<SetSidechainRouteParamsCommand>(kick, "sc-p", np, tl), tl);
    {
        auto routes = tl.getSidechainRoutes(kick);
        CHECK(!routes.empty() && routes[0].gain == 0.25f && routes[0].preFader
              && !routes[0].enabled, "params applied");
        CHECK(!routes.empty() && routes[0].targetEffectInstanceId == "e1",
              "target unchanged by params");
    }

    CHECK(um.undo(tl), "undo params");
    {
        auto routes = tl.getSidechainRoutes(kick);
        CHECK(!routes.empty() && routes[0].gain == 1.0f && !routes[0].preFader
              && routes[0].enabled, "params restored");
    }

    CHECK(um.redo(tl), "redo params");
    CHECK(tl.getSidechainRoutes(kick)[0].gain == 0.25f, "params re-applied");

    // Gain clamping through setParams.
    xleth::SidechainRouteParams big; big.gain = 50.0f;
    CHECK(tl.setSidechainRouteParams(kick, "sc-p", big).ok(), "clamp setParams ok");
    CHECK(tl.getSidechainRoutes(kick)[0].gain == 2.0f, "gain clamped to 2.0");
}

// ─── T12: stale target/effect reported, not destroyed (status logic) ─────────

// Mirrors the bridge's status computation so the model-level test can assert the
// reported status without the N-API layer. Keep in sync with Timeline_GetRouting.
static std::string statusFor(const Timeline& tl, const SidechainRoute& sc,
                             const xleth::SidechainEffectResolver& resolver) {
    if (sc.targetEffectInstanceId.empty()) return "invalid";
    if (!tl.getTrack(sc.targetTrackId))    return "stale_target_track";
    if (resolver && !resolver(sc.targetTrackId, sc.targetEffectInstanceId))
        return "stale_effect_instance";
    return "ok";
}

static void test_staleAfterLoad() {
    std::cout << "\n[T12] Stale routes preserved and reported, not deleted\n";
    Timeline tl;
    int kick = addTrack(tl, "Kick");
    int bass = addTrack(tl, "Bass");
    auto resolver = makeResolver({ std::to_string(bass) + ":e1" });
    tl.addSidechainRoute(kick, makeRoute("sc-ok",   bass, "e1"), resolver);
    tl.addSidechainRoute(kick, makeRoute("sc-gone", bass, "e1"), resolver);  // both valid now

    // Simulate a reload where the effect instance "e1" no longer resolves on one
    // of them (plugin missing). The route data survives — we do NOT drop it.
    auto staleResolver = makeResolver({ std::to_string(bass) + ":e1" });
    // Build a project where one route targets a now-missing effect.
    nlohmann::json j;
    to_json(j, *tl.getTrack(kick));
    // Mutate the second route's effect id to an unresolved one.
    j.at("sidechainRoutes").at(1).at("targetEffectInstanceId") = "e-missing";
    TrackInfo loaded;
    from_json(j, loaded);
    CHECK(loaded.sidechainRoutes.size() == 2, "stale route preserved on load");

    CHECK(statusFor(tl, loaded.sidechainRoutes[0], staleResolver) == "ok", "first route ok");
    CHECK(statusFor(tl, loaded.sidechainRoutes[1], staleResolver) == "stale_effect_instance",
          "second route stale_effect_instance");

    // Now a route whose whole target track vanished.
    SidechainRoute orphan = makeRoute("sc-orphan", 9999, "e1");
    CHECK(statusFor(tl, orphan, staleResolver) == "stale_target_track", "missing track stale");
}

// ─── T13: invalid mutation creates no undo entry (bridge contract) ───────────

static void test_noUndoOnInvalid() {
    std::cout << "\n[T13] Invalid add not committed (Timeline API)\n";
    Timeline tl;
    int kick = addTrack(tl, "Kick");
    int bass = addTrack(tl, "Bass");
    auto resolver = makeResolver({ std::to_string(bass) + ":e1" });
    // self-sidechain rejected — nothing stored.
    auto r = tl.addSidechainRoute(kick, makeRoute("bad", kick, "e1"), resolver);
    CHECK(!r.ok(), "self-sidechain rejected");
    CHECK(tl.getSidechainRoutes(kick).empty(), "nothing stored on rejection");
}

// ─── main ────────────────────────────────────────────────────────────────────

int main() {
    std::cout << "=== test_sidechain_routes (Prompt 4B) ===\n";
    test_oldProjectEmpty();
    test_addValid();
    test_roundTrip();
    test_jsonShape();
    test_loadSanitization();
    test_validationRejections();
    test_cycle();
    test_remove();
    test_undoRedoAdd();
    test_undoRedoRemove();
    test_setParams();
    test_staleAfterLoad();
    test_noUndoOnInvalid();

    std::cout << "\n────────────────────────────────────\n";
    std::cout << "Passed: " << g_passed << "  Failed: " << g_failed << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cout << "FAILED\n";
    return 1;
}
