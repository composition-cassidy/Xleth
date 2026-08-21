// test_effect_chain_commands.cpp — LoadEffectChainCommand (FX Chain Library).
// Build: see engine/CMakeLists.txt target "test_effect_chain_commands"
// Run:   test_effect_chain_commands.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1
//
// Model-only: the command takes its chain-swap as an injected std::function, so
// the whole undo contract is exercised against a fake engine with no MixEngine,
// no JUCE and no audio device.

#include "commands/EffectChainCommands.h"
#include "commands/UndoManager.h"
#include "model/Timeline.h"

#include <iostream>
#include <string>
#include <vector>
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

// ─── Fake chain engine ────────────────────────────────────────────────────────
// Stands in for MixEngine's loadEffectChainFromJSON: records every snapshot it
// is handed and remembers the last one as "the live chain".

struct FakeChainEngine {
    nlohmann::json              live = nlohmann::json::object();
    std::vector<nlohmann::json> applications;
    bool                        rejectNext = false;

    LoadEffectChainCommand::ApplyFn applyFn() {
        return [this](const nlohmann::json& chain) {
            if (rejectNext) { rejectNext = false; return false; }
            live = chain;
            applications.push_back(chain);
            return true;
        };
    }
};

// Build a chain snapshot in the shape AudioGraph::toJSON emits.
static nlohmann::json makeChain(std::vector<std::tuple<std::string, bool, std::string>> nodes,
                                int firstNodeId = 100)
{
    nlohmann::json arr = nlohmann::json::array();
    int uid = firstNodeId;
    for (auto& [pluginId, bypassed, state] : nodes) {
        arr.push_back({
            { "nodeId",   uid++ },
            { "pluginId", pluginId },
            { "bypassed", bypassed },
            { "state",    state },
            { "x", 0.0 }, { "y", 0.0 },
        });
    }
    return nlohmann::json{ { "nodes", arr }, { "connections", nlohmann::json::array() } };
}

static std::vector<std::string> pluginIdsOf(const nlohmann::json& chain) {
    std::vector<std::string> out;
    if (!chain.contains("nodes")) return out;
    for (const auto& n : chain["nodes"]) out.push_back(n.value("pluginId", std::string{}));
    return out;
}

static bool bypassOf(const nlohmann::json& chain, size_t index) {
    if (!chain.contains("nodes") || index >= chain["nodes"].size()) return false;
    return chain["nodes"][index].value("bypassed", false);
}

int main()
{
    Timeline   tl;    // required by the Command interface; this edit never reads it
    UndoManager um;

    // ── 1. execute / undo / redo round-trip ───────────────────────────────────
    {
        FakeChainEngine engine;
        const auto before = makeChain({ { "compressor", false, "AAAA" } });
        const auto after  = makeChain({ { "xletheq", false, "BBBB" },
                                        { "reverb",  true,  "CCCC" } }, 200);
        engine.live = before;

        um.execute(std::make_unique<LoadEffectChainCommand>(
            3, "for kick", before, after, engine.applyFn()), tl);

        CHECK(pluginIdsOf(engine.live) == std::vector<std::string>({ "xletheq", "reverb" }),
              "execute applies the new chain");
        CHECK(um.canUndo(), "a chain load is recorded on the undo stack");
        CHECK(um.getUndoCount() == 1,
              "a whole-chain load is ONE undo step, not one per effect");

        CHECK(um.undo(tl), "undo succeeds");
        CHECK(pluginIdsOf(engine.live) == std::vector<std::string>({ "compressor" }),
              "undo restores the previous chain exactly");

        CHECK(um.redo(tl), "redo succeeds");
        CHECK(pluginIdsOf(engine.live) == std::vector<std::string>({ "xletheq", "reverb" }),
              "redo re-applies the loaded chain");
    }

    // ── 2. bypass travels with the chain, in both directions ──────────────────
    // The user asked for bypassed effects to be saved bypassed and to load back
    // bypassed; graphToJSON carries the flag per node, so the command must not
    // normalize it away on either the apply or the restore leg.
    {
        UndoManager local;
        FakeChainEngine engine;
        const auto before = makeChain({ { "delay", true, "OLD" } });
        const auto after  = makeChain({ { "distortion", false, "X" },
                                        { "limiter",    true,  "Y" } }, 300);
        engine.live = before;

        local.execute(std::make_unique<LoadEffectChainCommand>(
            1, "guitar fx", before, after, engine.applyFn()), tl);

        CHECK(bypassOf(engine.live, 0) == false && bypassOf(engine.live, 1) == true,
              "loaded chain keeps each effect's saved bypass state");

        local.undo(tl);
        CHECK(bypassOf(engine.live, 0) == true,
              "undo restores the bypass state the track had before the load");
    }

    // ── 3. plugin state blobs survive the swap ────────────────────────────────
    {
        UndoManager local;
        FakeChainEngine engine;
        const auto before = makeChain({ { "apex", false, "PRIOR-STATE" } });
        const auto after  = makeChain({ { "apex", false, "SAVED-STATE" } }, 400);
        engine.live = before;

        local.execute(std::make_unique<LoadEffectChainCommand>(
            2, "cool bass", before, after, engine.applyFn()), tl);
        CHECK(engine.live["nodes"][0].value("state", std::string{}) == "SAVED-STATE",
              "the preset's parameter state is what lands on the track");

        local.undo(tl);
        CHECK(engine.live["nodes"][0].value("state", std::string{}) == "PRIOR-STATE",
              "undo restores the parameter state, not just the plugin list");
    }

    // ── 4. an identical chain is not an edit ──────────────────────────────────
    // Engine node uids are reassigned every load, so two snapshots of the same
    // chain differ textually. Loading a chain a track already has must still not
    // push a no-op step that eats the user's real Ctrl+Z.
    {
        UndoManager local;
        FakeChainEngine engine;
        const auto before = makeChain({ { "chorus", false, "S" } }, 10);
        const auto sameButRenumbered = makeChain({ { "chorus", false, "S" } }, 9999);
        engine.live = before;

        local.execute(std::make_unique<LoadEffectChainCommand>(
            4, "test", before, sameButRenumbered, engine.applyFn()), tl);

        CHECK(!local.canUndo(),
              "re-loading an identical chain records no undo step");
        CHECK(engine.applications.size() == 1,
              "the swap still runs even though it is not recorded");
    }

    // ── 5. a rejected snapshot is not recorded ────────────────────────────────
    {
        UndoManager local;
        FakeChainEngine engine;
        const auto before = makeChain({ { "phaser", false, "A" } });
        const auto after  = makeChain({ { "reverb", false, "B" } }, 500);
        engine.live = before;
        engine.rejectNext = true;

        local.execute(std::make_unique<LoadEffectChainCommand>(
            5, "broken", before, after, engine.applyFn()), tl);

        CHECK(!local.canUndo(),
              "a snapshot the engine refuses does not become an undo step");
        CHECK(pluginIdsOf(engine.live) == std::vector<std::string>({ "phaser" }),
              "a rejected load leaves the chain untouched");
    }

    // ── 6. a null apply function is inert ─────────────────────────────────────
    {
        UndoManager local;
        const auto before = makeChain({ { "gloss", false, "A" } });
        const auto after  = makeChain({ { "apex",  false, "B" } }, 600);

        local.execute(std::make_unique<LoadEffectChainCommand>(
            6, "no-engine", before, after, nullptr), tl);
        CHECK(!local.canUndo(), "no apply function means no undo step");
    }

    // ── 7. describe() names the target and the preset ─────────────────────────
    {
        FakeChainEngine engine;
        const auto a = makeChain({ { "delay", false, "A" } });
        const auto b = makeChain({ { "reverb", false, "B" } }, 700);

        LoadEffectChainCommand named(7, "for snare", a, b, engine.applyFn());
        CHECK(named.describe() == "Load FX Chain \"for snare\" (Track 7)",
              "describe() names the preset and the track");

        LoadEffectChainCommand master(-1, "mastering", a, b, engine.applyFn());
        CHECK(master.describe() == "Load FX Chain \"mastering\" (Master)",
              "a negative trackId describes the master chain");

        LoadEffectChainCommand unnamed(2, "", a, b, engine.applyFn());
        CHECK(unnamed.describe() == "Load FX Chain (Track 2)",
              "a drag-drop with no preset name still describes its target");
    }

    // ── 8. the undo stack interleaves chain loads with other edits ────────────
    // The whole point of doing this in the engine rather than a renderer-side
    // toast is that one global Ctrl+Z walks back through both kinds of edit in
    // the order they happened.
    {
        UndoManager local;
        FakeChainEngine engine;
        const auto empty = makeChain({});
        const auto one   = makeChain({ { "compressor", false, "1" } }, 10);
        const auto two   = makeChain({ { "compressor", false, "1" },
                                       { "limiter",    false, "2" } }, 20);
        engine.live = empty;

        local.execute(std::make_unique<LoadEffectChainCommand>(
            1, "first", empty, one, engine.applyFn()), tl);
        local.execute(std::make_unique<LoadEffectChainCommand>(
            1, "second", one, two, engine.applyFn()), tl);

        CHECK(local.getUndoCount() == 2, "two distinct loads are two steps");
        CHECK(local.getUndoDescription() == "Load FX Chain \"second\" (Track 1)",
              "the newest load is on top of the stack");

        local.undo(tl);
        CHECK(pluginIdsOf(engine.live) == std::vector<std::string>({ "compressor" }),
              "one undo walks back exactly one load");
        local.undo(tl);
        CHECK(pluginIdsOf(engine.live).empty(),
              "the second undo returns the track to an empty chain");
        CHECK(!local.canUndo(), "the stack is exhausted");
    }

    // ── 9. alreadyApplied: the library-load path ──────────────────────────────
    // The RPC builds the chain through the ordered-preset builder first and then
    // records the before/after pair. The first execute() must therefore NOT
    // re-apply (rebuilding every plugin a second time, audibly), while undo and
    // redo must still work normally.
    {
        UndoManager local;
        FakeChainEngine engine;
        const auto before = makeChain({ { "compressor", false, "OLD" } });
        const auto after  = makeChain({ { "apex", false, "NEW" } }, 800);
        engine.live = after;   // the builder already put the new chain in place

        local.execute(std::make_unique<LoadEffectChainCommand>(
            9, "cool bass", before, after, engine.applyFn(), /*alreadyApplied=*/true), tl);

        CHECK(engine.applications.empty(),
              "an already-applied load does not rebuild the chain on execute");
        CHECK(local.canUndo(),
              "an already-applied load is still recorded as an undo step");

        local.undo(tl);
        CHECK(pluginIdsOf(engine.live) == std::vector<std::string>({ "compressor" }),
              "undo restores the pre-load chain");
        CHECK(engine.applications.size() == 1, "undo performs exactly one swap");

        local.redo(tl);
        CHECK(pluginIdsOf(engine.live) == std::vector<std::string>({ "apex" }),
              "redo re-applies the loaded chain (the skip is first-execute only)");
        CHECK(engine.applications.size() == 2, "redo performs exactly one more swap");
    }

    // ── 10. alreadyApplied still refuses to record a no-op ────────────────────
    {
        UndoManager local;
        FakeChainEngine engine;
        const auto before = makeChain({ { "delay", false, "S" } }, 1);
        const auto after  = makeChain({ { "delay", false, "S" } }, 4242);
        engine.live = after;

        local.execute(std::make_unique<LoadEffectChainCommand>(
            10, "same", before, after, engine.applyFn(), /*alreadyApplied=*/true), tl);
        CHECK(!local.canUndo(),
              "loading a chain identical to the one already there is not an undo step");
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    std::cout << "\npassed: " << g_passed << "  failed: " << g_failed << "\n";
    if (g_failed > 0) {
        std::cout << "FAILED: " << g_failed << " check(s) did not hold\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
