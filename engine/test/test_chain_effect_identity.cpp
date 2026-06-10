// test_chain_effect_identity.cpp — Prompt 4A: stable chain-mode effectInstanceId
// Build: see engine/CMakeLists.txt target "test_chain_effect_identity"
// Run:   test_chain_effect_identity.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1
//
// Verifies that every normal Mixer Chain effect instance carries a stable,
// persistent effectInstanceId that survives creation, move/reorder, bypass,
// parameter edits, save/load, and APG uid remap — without colliding with the
// graph-owned identity machinery.

#include "audio/EffectChainManager.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <nlohmann/json.hpp>

#include <iostream>
#include <set>
#include <string>
#include <vector>

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

using nlohmann::json;

// Return the effectInstanceId of the chain node at the given 0-based position,
// or "" if absent. getChainState() is the bridge/UI-facing payload.
static std::string instanceIdAt(const EffectChainManager& chain, int position)
{
    const json state = chain.getChainState();
    for (const auto& node : state)
        if (node.value("position", -1) == position)
            return node.value("effectInstanceId", std::string{});
    return {};
}

static int nodeIdAt(const EffectChainManager& chain, int position)
{
    const json state = chain.getChainState();
    for (const auto& node : state)
        if (node.value("position", -1) == position)
            return node.value("nodeId", -1);
    return -1;
}

// ── Fresh effects get unique, non-empty ids exposed in chain state ───────────
static void testFreshIdsUniqueAndExposed()
{
    std::cout << "testFreshIdsUniqueAndExposed\n";
    EffectChainManager chain;
    chain.init(44100.0, 256);

    chain.addEffect("testgain", 0);
    chain.addEffect("delay", 1);
    chain.addEffect("reverb", 2);

    const json state = chain.getChainState();
    CHECK(state.size() == 3, "three effects in chain state");

    std::set<std::string> ids;
    for (const auto& node : state)
    {
        const std::string id = node.value("effectInstanceId", std::string{});
        CHECK(!id.empty(), "every chain node exposes a non-empty effectInstanceId");
        ids.insert(id);
    }
    CHECK(ids.size() == 3, "the three effectInstanceIds are distinct");
}

// ── Lookup round-trips both directions ───────────────────────────────────────
static void testLookupRoundTrip()
{
    std::cout << "testLookupRoundTrip\n";
    EffectChainManager chain;
    chain.init(44100.0, 256);

    const int nodeId = chain.addEffect("compressor", 0);
    CHECK(nodeId >= 0, "addEffect returns a node id");

    const std::string id = instanceIdAt(chain, 0);
    CHECK(!id.empty(), "node has an instance id");
    CHECK(chain.getNodeIdForEffectInstance(id) == nodeId,
          "getNodeIdForEffectInstance resolves to the live node id");
    CHECK(chain.getEffectInstanceIdForNode(nodeId) == id,
          "getEffectInstanceIdForNode is the inverse mapping");
    CHECK(chain.getNodeIdForEffectInstance("does-not-exist") == -1,
          "unknown instance id resolves to -1");
    CHECK(chain.getEffectInstanceIdForNode(999999).empty(),
          "unknown node id resolves to empty string");
}

// ── Move / reorder preserves ids ─────────────────────────────────────────────
static void testMovePreservesIds()
{
    std::cout << "testMovePreservesIds\n";
    EffectChainManager chain;
    chain.init(44100.0, 256);

    const int nA = chain.addEffect("testgain", 0);
    const int nB = chain.addEffect("delay", 1);
    const std::string idA = chain.getEffectInstanceIdForNode(nA);
    const std::string idB = chain.getEffectInstanceIdForNode(nB);

    // Move B to the front.
    CHECK(chain.moveEffect(nB, 0), "moveEffect succeeds");

    CHECK(instanceIdAt(chain, 0) == idB, "moved effect keeps its id at new position");
    CHECK(instanceIdAt(chain, 1) == idA, "displaced effect keeps its id");
    CHECK(chain.getNodeIdForEffectInstance(idA) == nA, "id->node stable across move (A)");
    CHECK(chain.getNodeIdForEffectInstance(idB) == nB, "id->node stable across move (B)");
}

// ── Bypass preserves ids ─────────────────────────────────────────────────────
static void testBypassPreservesIds()
{
    std::cout << "testBypassPreservesIds\n";
    EffectChainManager chain;
    chain.init(44100.0, 256);

    const int n = chain.addEffect("limiter", 0);
    const std::string before = chain.getEffectInstanceIdForNode(n);
    CHECK(chain.setBypass(n, true), "setBypass succeeds");
    CHECK(chain.getEffectInstanceIdForNode(n) == before, "bypass does not change the id");
}

// ── Parameter edit preserves ids ─────────────────────────────────────────────
static void testParamEditPreservesIds()
{
    std::cout << "testParamEditPreservesIds\n";
    EffectChainManager chain;
    chain.init(44100.0, 256);

    const int n = chain.addEffect("delay", 0);
    const std::string before = chain.getEffectInstanceIdForNode(n);

    // A param edit (any valid param) must not disturb identity. Use the first
    // exposed parameter, whatever it is.
    const json params = json::parse(chain.getEffectParameters(n));
    if (params.is_array() && !params.empty())
    {
        const std::string pid = params[0].value("id", params[0].value("parameterId", std::string{}));
        if (!pid.empty()) chain.setEffectParameter(n, pid, 0.25f);
    }
    CHECK(chain.getEffectInstanceIdForNode(n) == before, "parameter edit does not change the id");
}

// ── Save / load preserves ids even though APG uids may be remapped ───────────
static void testSaveLoadPreservesIdsAcrossRemap()
{
    std::cout << "testSaveLoadPreservesIdsAcrossRemap\n";
    EffectChainManager src;
    src.init(44100.0, 256);
    src.addEffect("testgain", 0);
    src.addEffect("delay", 1);
    src.addEffect("reverb", 2);

    std::vector<std::string> savedIds;
    std::vector<int> savedNodeIds;
    for (int i = 0; i < 3; ++i)
    {
        savedIds.push_back(instanceIdAt(src, i));
        savedNodeIds.push_back(nodeIdAt(src, i));
    }

    const json saved = src.graphToJSON();

    // Destination already holds unrelated nodes so its APG uid counter has
    // advanced; loading should therefore assign DIFFERENT uids than the source,
    // proving the stable id is what carries identity — not the uid.
    EffectChainManager dst;
    dst.init(44100.0, 256);
    dst.addEffect("compressor", 0);
    dst.addEffect("phaser", 1);
    CHECK(dst.graphFromJSON(saved), "graphFromJSON succeeds");

    bool anyUidChanged = false;
    for (int i = 0; i < 3; ++i)
    {
        const std::string loadedId = instanceIdAt(dst, i);
        const int loadedNodeId = nodeIdAt(dst, i);
        CHECK(loadedId == savedIds[i], "effectInstanceId survives save/load at each position");
        CHECK(dst.getNodeIdForEffectInstance(loadedId) == loadedNodeId,
              "loaded id resolves to the (possibly new) runtime node id");
        if (loadedNodeId != savedNodeIds[i]) anyUidChanged = true;
    }
    CHECK(anyUidChanged, "at least one APG uid was remapped, yet ids stayed stable");
}

// ── Old projects (no ids) get ids generated on load ──────────────────────────
static void testOldProjectGeneratesIds()
{
    std::cout << "testOldProjectGeneratesIds\n";
    EffectChainManager src;
    src.init(44100.0, 256);
    src.addEffect("testgain", 0);
    src.addEffect("delay", 1);

    // Simulate a pre-feature project: strip the additive id fields.
    json legacy = src.graphToJSON();
    for (auto& node : legacy["nodes"])
    {
        node.erase("effectInstanceId");
        node.erase("graphOwned");
    }

    EffectChainManager dst;
    dst.init(44100.0, 256);
    CHECK(dst.graphFromJSON(legacy), "legacy chain without ids still loads");

    const json state = dst.getChainState();
    CHECK(state.size() == 2, "both legacy effects loaded");
    std::set<std::string> ids;
    for (const auto& node : state)
    {
        const std::string id = node.value("effectInstanceId", std::string{});
        CHECK(!id.empty(), "loaded legacy node gains a generated id");
        ids.insert(id);
    }
    CHECK(ids.size() == 2, "generated ids are distinct");

    // The generated ids must now persist on the next save.
    const json resaved = dst.graphToJSON();
    for (const auto& node : resaved["nodes"])
        CHECK(!node.value("effectInstanceId", std::string{}).empty(),
              "re-saved chain persists the generated ids");
}

// ── Duplicate ids in loaded JSON are repaired deterministically ──────────────
static void testDuplicateIdsRepaired()
{
    std::cout << "testDuplicateIdsRepaired\n";
    EffectChainManager src;
    src.init(44100.0, 256);
    src.addEffect("testgain", 0);
    src.addEffect("delay", 1);

    json corrupt = src.graphToJSON();
    for (auto& node : corrupt["nodes"])
        node["effectInstanceId"] = "DUP";   // force a collision

    EffectChainManager dst;
    dst.init(44100.0, 256);
    CHECK(dst.graphFromJSON(corrupt), "chain with duplicate ids still loads");

    const json state = dst.getChainState();
    std::set<std::string> ids;
    int dupCount = 0;
    for (const auto& node : state)
    {
        const std::string id = node.value("effectInstanceId", std::string{});
        CHECK(!id.empty(), "repaired node has a non-empty id");
        ids.insert(id);
        if (id == "DUP") ++dupCount;
    }
    CHECK(ids.size() == 2, "duplicate ids are repaired to two distinct ids");
    CHECK(dupCount == 1, "first occurrence keeps the id; later duplicate is regenerated");
    CHECK(dst.getNodeIdForEffectInstance("DUP") >= 0,
          "the surviving DUP resolves to exactly one node (unambiguous)");
}

// ── Chain-mode ids must NOT be pulled into the graph-owned map ───────────────
static void testGraphOwnershipNotCollapsed()
{
    std::cout << "testGraphOwnershipNotCollapsed\n";

    // Chain-mode: persisted nodes are marked graphOwned:false and must not
    // register as graph-owned on load.
    EffectChainManager chainSrc;
    chainSrc.init(44100.0, 256);
    chainSrc.addEffect("testgain", 0);
    chainSrc.addEffect("delay", 1);
    const json chainJson = chainSrc.graphToJSON();
    for (const auto& node : chainJson["nodes"])
        CHECK(node.value("graphOwned", true) == false,
              "chain-mode node serializes graphOwned:false");

    std::vector<std::string> chainIds;
    for (const auto& node : chainJson["nodes"])
        chainIds.push_back(node.value("effectInstanceId", std::string{}));

    EffectChainManager chainDst;
    chainDst.init(44100.0, 256);
    CHECK(chainDst.graphFromJSON(chainJson), "chain JSON loads");
    for (const auto& id : chainIds)
        CHECK(!chainDst.hasGraphNode(id),
              "chain-mode id is NOT registered as graph-owned");

    // Graph-owned: a renderer-supplied id round-trips through graphOwned:true.
    EffectChainManager graphSrc;
    graphSrc.init(44100.0, 256);
    const int gNode = graphSrc.addGraphNode("g-renderer-1", "delay");
    CHECK(gNode >= 0, "graph node added");
    CHECK(graphSrc.getEffectInstanceIdForNode(gNode) == "g-renderer-1",
          "graph node carries the renderer id in its metadata");
    const json graphJson = graphSrc.graphToJSON();
    bool sawGraphOwned = false;
    for (const auto& node : graphJson["nodes"])
        if (node.value("effectInstanceId", std::string{}) == "g-renderer-1")
            sawGraphOwned = node.value("graphOwned", false);
    CHECK(sawGraphOwned, "graph-owned node serializes graphOwned:true");

    EffectChainManager graphDst;
    graphDst.init(44100.0, 256);
    CHECK(graphDst.graphFromJSON(graphJson), "graph JSON loads");
    CHECK(graphDst.hasGraphNode("g-renderer-1"),
          "graph-owned id is restored into the graph-owned map");
    CHECK(graphDst.getGraphNodeEngineId("g-renderer-1") >= 0,
          "graph-owned id resolves to a live engine node after load");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    testFreshIdsUniqueAndExposed();
    testLookupRoundTrip();
    testMovePreservesIds();
    testBypassPreservesIds();
    testParamEditPreservesIds();
    testSaveLoadPreservesIdsAcrossRemap();
    testOldProjectGeneratesIds();
    testDuplicateIdsRepaired();
    testGraphOwnershipNotCollapsed();

    std::cout << "\nPassed: " << g_passed << "  Failed: " << g_failed << "\n";
    if (g_failed == 0)
    {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    return 1;
}
