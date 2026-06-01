// test_graph_effect_parameters.cpp — FXG.4-a graph-owned parameter descriptors
// Build: see engine/CMakeLists.txt target "test_graph_effect_parameters"
// Run:   test_graph_effect_parameters.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1
//
// Covers the unified, graph-owned parameter descriptor + normalized read/write
// foundation for STOCK effects (host-owned APVTS). Third-party plugin
// enumeration shares the exact same descriptor path (host-discovered
// AudioProcessorParameter objects) but is not exercised here because the unit
// test harness has no scanned VST3 fixtures.

#include "audio/EffectChainManager.h"
#include "audio/MixEngine.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

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

// ── Stock descriptor enumeration ─────────────────────────────────────────────
static void testStockDescriptorList()
{
    std::cout << "testStockDescriptorList\n";
    EffectChainManager chain;
    chain.init(44100.0, 256);

    const int nodeId = chain.addGraphNode("inst-delay", "delay");
    CHECK(nodeId >= 0, "delay graph node should be added");
    const int countBefore = chain.getEffectCount();

    const json out = chain.getGraphEffectParameters("inst-delay");
    CHECK(out.value("ok", false), "getGraphEffectParameters should succeed");
    CHECK(out.value("effectKind", std::string()) == "stock", "effectKind should be stock");
    CHECK(out.value("pluginFormat", std::string()) == "stock", "pluginFormat should be stock");
    CHECK(out.value("pluginId", std::string()) == "delay", "pluginId should round-trip");
    CHECK(out.value("effectInstanceId", std::string()) == "inst-delay",
          "effectInstanceId should be echoed");

    CHECK(out.contains("parameters") && out["parameters"].is_array(), "parameters array present");
    const auto& params = out["parameters"];
    CHECK(!params.empty(), "stock effect should expose a non-empty parameter list");

    bool sawStableId = false;
    bool valuesNormalized = true;
    for (const auto& p : params)
    {
        const std::string id = p.value("parameterId", std::string());
        if (!id.empty() && id.front() != '#' && p.value("parameterIdIsFallback", true) == false)
            sawStableId = true;
        const double nv = p.value("normalizedValue", -1.0);
        if (!(nv >= 0.0 && nv <= 1.0)) valuesNormalized = false;
        CHECK(p.contains("parameterIndex"), "descriptor carries parameterIndex fallback");
        CHECK(p.contains("automatable"), "descriptor carries automatable flag");
    }
    CHECK(sawStableId, "stock parameters expose a stable, non-fallback parameterId");
    CHECK(valuesNormalized, "every normalizedValue is within [0, 1]");

    // Parameter queries must not mutate the chain/graph topology.
    CHECK(chain.getEffectCount() == countBefore, "parameter read must not change node count");
}

// ── Normalized read/write + clamping ─────────────────────────────────────────
static void testNormalizedReadWriteAndClamp()
{
    std::cout << "testNormalizedReadWriteAndClamp\n";
    EffectChainManager chain;
    chain.init(44100.0, 256);
    chain.addGraphNode("inst-delay", "delay");

    const json list = chain.getGraphEffectParameters("inst-delay");
    const std::string firstId = list["parameters"].at(0).value("parameterId", std::string());
    CHECK(!firstId.empty(), "first parameterId should be readable");

    const json before = chain.getGraphEffectParameterValue("inst-delay", firstId);
    CHECK(before.value("ok", false), "value read should succeed");

    // Over-range set clamps to 1.0.
    const json high = chain.setGraphEffectParameterNormalized("inst-delay", firstId, 2.0f);
    CHECK(high.value("ok", false), "set should succeed");
    CHECK(high.value("normalizedValue", -1.0) <= 1.0 && high.value("normalizedValue", -1.0) >= 0.0,
          "set value is clamped into [0, 1]");

    // Under-range set clamps to 0.0.
    const json low = chain.setGraphEffectParameterNormalized("inst-delay", firstId, -5.0f);
    CHECK(low.value("ok", false), "set should succeed for under-range");
    CHECK(low.value("normalizedValue", -1.0) >= 0.0, "under-range set clamps to >= 0");

    // Round-trip a mid value.
    const json mid = chain.setGraphEffectParameterNormalized("inst-delay", firstId, 0.5f);
    CHECK(mid.value("ok", false), "mid set should succeed");
    const json readBack = chain.getGraphEffectParameterValue("inst-delay", firstId);
    CHECK(std::abs(readBack.value("normalizedValue", -1.0) - 0.5) < 0.05,
          "read-back reflects the applied normalized value");
}

// ── parameterIndex fallback resolution ───────────────────────────────────────
static void testParameterIndexFallback()
{
    std::cout << "testParameterIndexFallback\n";
    EffectChainManager chain;
    chain.init(44100.0, 256);
    chain.addGraphNode("inst-delay", "delay");

    // "#<index>" resolves even though stock params have stable ids — this is the
    // resolution path third-party plugins without stable ids rely on.
    const json byIndex = chain.getGraphEffectParameterValue("inst-delay", "#0");
    CHECK(byIndex.value("ok", false), "parameterIndex fallback (#0) should resolve");
    CHECK(byIndex.value("parameterIndex", -1) == 0, "fallback resolves to index 0");

    const json setByIndex = chain.setGraphEffectParameterNormalized("inst-delay", "#0", 0.25f);
    CHECK(setByIndex.value("ok", false), "set via parameterIndex fallback should succeed");
}

// ── Failure paths fail safely (no crash, structured reason) ──────────────────
static void testFailurePaths()
{
    std::cout << "testFailurePaths\n";
    EffectChainManager chain;
    chain.init(44100.0, 256);
    chain.addGraphNode("inst-delay", "delay");

    const json unknownInstance = chain.getGraphEffectParameters("does-not-exist");
    CHECK(!unknownInstance.value("ok", true), "unknown effectInstanceId should fail");
    CHECK(unknownInstance.value("reason", std::string()) == "unknown_effect_instance",
          "unknown instance reports unknown_effect_instance");

    const json unknownParam = chain.getGraphEffectParameterValue("inst-delay", "no_such_param");
    CHECK(!unknownParam.value("ok", true), "unknown parameter read should fail");
    CHECK(unknownParam.value("reason", std::string()) == "unknown_parameter",
          "unknown parameter reports unknown_parameter");

    const json setUnknown =
        chain.setGraphEffectParameterNormalized("inst-delay", "no_such_param", 0.5f);
    CHECK(!setUnknown.value("ok", true), "unknown parameter set should fail safely");

    const json setUnknownInstance =
        chain.setGraphEffectParameterNormalized("missing", "feedback", 0.5f);
    CHECK(!setUnknownInstance.value("ok", true), "set on unknown instance should fail safely");
    CHECK(setUnknownInstance.value("reason", std::string()) == "unknown_effect_instance",
          "set on unknown instance reports unknown_effect_instance");
}

// ── MixEngine track routing + master rejection ───────────────────────────────
static void testMixEngineRouting()
{
    std::cout << "testMixEngineRouting\n";
    MixEngine engine;
    engine.prepare(44100.0, 256);

    const int nodeId = engine.addGraphEffectNode(3, "inst-rev", "reverb");
    CHECK(nodeId >= 0, "MixEngine should create a graph-owned reverb node");

    const json ok = json::parse(engine.getGraphEffectParameters(3, "inst-rev"));
    CHECK(ok.value("ok", false), "MixEngine getGraphEffectParameters should succeed");
    CHECK(ok.value("trackId", -1) == 3, "MixEngine stamps trackId");
    CHECK(ok.contains("parameters") && !ok["parameters"].empty(),
          "reverb exposes parameters via MixEngine");

    // Master track is chain-only — graph parameter APIs reject it.
    const json master = json::parse(engine.getGraphEffectParameters(-1, "inst-rev"));
    CHECK(!master.value("ok", true), "master track should be rejected");
    CHECK(master.value("reason", std::string()) == "master_track",
          "master rejection reports master_track");

    const json setMaster =
        json::parse(engine.setGraphEffectParameterNormalized(-1, "inst-rev", "mix", 0.5));
    CHECK(!setMaster.value("ok", true), "master set should be rejected");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout.setf(std::ios::unitbuf);
    std::cerr.setf(std::ios::unitbuf);

    std::cout << "=== test_graph_effect_parameters ===\n";

    testStockDescriptorList();
    testNormalizedReadWriteAndClamp();
    testParameterIndexFallback();
    testFailurePaths();
    testMixEngineRouting();

    std::cout << "\nResults: " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0)
    {
        std::cerr << "FAILED\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
