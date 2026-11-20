// test_automation_plan_rebind.cpp -- after any chain or timeline mutation and
// its undo, the envelope applier's next pass must leave automation driving the
// parameter again. Nothing may stay silent until some unrelated chain edit.
//
// The plan resolves (effect, parameter) handles on the message/applier thread.
// It used to be rebuilt only when a mutator remembered to set
// automationBindingsDirty_ (or, for timeline edits, by the bridge's UndoManager
// hook). addGraphEffectNode / hydrateGraphEffectNodes / syncGraphTopology and the
// chain create/destroy entry points did not, so e.g. deleting an FX Graph node
// and undoing it left the plan resolved against the old chain state. Its target
// was dropped or failed the graph-serial check (db635f6), and the automation
// went silent.
//
// Each scenario: automate a Delay's mix on its own track, confirm it is driven,
// mutate, run ONE applier pass (refreshAutomationPlanIfDirty, exactly what the
// applier thread runs), render, and require the mix to be driven again.
// Timeline-only edits also get the refreshAutomationPlan() call the bridge's
// UndoManager post-mutation hook makes (XlethEngineService.cpp), since that is
// what happens in the app.
//
// Uses the same-size LIFO allocator, so a re-created chain or effect lands at
// the freed one's address every time (the ABA case db635f6 is about).
//
// Build: cmake --build build --target test_automation_plan_rebind --config Release
// Run:   ctest --test-dir build -C Release -R "^test_automation_plan_rebind$" -V

#include "audio/MixEngine.h"
#include "audio/XlethEffectBase.h"
#include "commands/TimelineCommands.h"
#include "commands/UndoManager.h"
#include "model/Timeline.h"
#include "Transport.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <cmath>
#include <iostream>
#include <string>

#include "lifo_same_size_allocator.h"   // replaces global new/delete for this binary

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

constexpr double kRate      = 48000.0;
constexpr int    kBlock     = 512;
constexpr double kAutomated = 0.9;   // far from the Delay's default mix

struct Rig
{
    Timeline    timeline;
    Transport   transport;
    MixEngine   engine;
    UndoManager undo;

    Rig()
    {
        transport.setSampleRate(kRate);
        transport.setBPM(120.0);
        engine.setTimeline(&timeline);
        engine.prepare(kRate, kBlock);
    }

    // Normalised mix of the effect `instanceId` on `trackId`, -1 if absent.
    double mix(int trackId, const std::string& instanceId)
    {
        int nodeId = engine.getGraphEffectEngineNodeId(trackId, instanceId);   // graph-owned
        if (nodeId < 0)                                                          // chain-mode
        {
            const nlohmann::json j = engine.getEffectChainJSON(trackId);
            if (j.contains("nodes"))
                for (const auto& n : j["nodes"])
                    if (n.value("effectInstanceId", std::string{}) == instanceId)
                        nodeId = n.value("nodeId", -1);
        }
        XlethEffectBase* fx = engine.getEffectPtr(trackId, nodeId);
        std::atomic<float>* raw = nullptr;
        juce::RangedAudioParameter* param = nullptr;
        if (fx == nullptr || !fx->resolveAutomationParameter("mix", raw, param)) return -1.0;
        return param->convertTo0to1(raw->load());
    }

    void render()
    {
        juce::AudioBuffer<float> buf(2, kBlock);
        buf.clear();
        engine.refreshTimelineSnapshot();               // the bridge publishes after every edit
        engine.processBlock(buf, kBlock, transport);   // stopped: automation still applies at tick 0
    }

    // What the bridge's UndoManager post-mutation hook does after every
    // timeline edit, undo and redo.
    void afterTimelineEdit()
    {
        engine.refreshTimelineSnapshot();
        engine.refreshAutomationPlan();
    }

    // Automate `instanceId`'s mix on `trackId` at kAutomated.
    void automate(int trackId, const std::string& instanceId)
    {
        AutomationLane lane;
        lane.ownerTrackId = trackId;
        const int laneId = timeline.addAutomationLane(lane);
        AutomationEnvelope env;
        env.binding.ownerTrackId     = trackId;
        env.binding.effectInstanceId = instanceId;
        env.binding.parameterId      = "mix";
        AutomationPoint p0; p0.tick.ticks = 0;         p0.value = kAutomated;
        AutomationPoint p1; p1.tick.ticks = 1'000'000; p1.value = kAutomated;
        env.points = { p0, p1 };
        const int envId = timeline.addAutomationEnvelope(env);
        AutomationClip clip;
        clip.laneId = laneId;
        clip.envelopeId = envId;
        clip.position.ticks = 0;
        clip.duration.ticks = 1'000'000;
        timeline.addAutomationClip(clip);
        afterTimelineEdit();
    }

    bool driven(int trackId, const std::string& instanceId)
    {
        return std::fabs(mix(trackId, instanceId) - kAutomated) < 1e-3;
    }
};

// A new track with an FX Graph Delay `instanceId`, automated and checked.
int trackWithAutomatedDelay(Rig& r, const std::string& name, const std::string& instanceId)
{
    TrackInfo t; t.name = name;
    const int trackId = r.timeline.addTrack(t);
    const int nodeId = r.engine.addGraphEffectNode(trackId, instanceId, "delay");
    CHECK(nodeId >= 0, name << ": Delay added");
    r.automate(trackId, instanceId);
    r.render();
    CHECK(r.driven(trackId, instanceId),
          name << ": automation drives the Delay before the mutation (mix=" << r.mix(trackId, instanceId) << ")");
    return trackId;
}

// The effect exists again but nothing has written it yet: its mix must NOT
// already read kAutomated, or the final check proves nothing.
void requireFreshValue(Rig& r, int trackId, const std::string& instanceId, const std::string& name)
{
    const double m = r.mix(trackId, instanceId);
    CHECK(m >= 0.0 && std::fabs(m - kAutomated) > 1e-3,
          name << ": the re-created Delay starts at its default (mix=" << m << ")");
}

void applierPassThenExpectDriven(Rig& r, int trackId, const std::string& instanceId,
                                 const std::string& name)
{
    r.engine.refreshAutomationPlanIfDirty();   // one envelope applier pass
    r.render();
    CHECK(r.driven(trackId, instanceId),
          name << ": automation drives the parameter again after one applier pass (mix="
               << r.mix(trackId, instanceId) << ")");
}

} // namespace

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << std::unitbuf;
    std::cout << "test_automation_plan_rebind\n";

    Rig r;

    // 1. Track delete + undo, the way the bridge does it: RemoveTrackCommand
    //    through the UndoManager (cascading the track's automation lanes), and
    //    the effect chain is left alone (timeline_removeTrack never destroys it).
    {
        const std::string name = "track delete + undo", id = "fx-a";
        const int t = trackWithAutomatedDelay(r, name, id);
        r.undo.execute(std::make_unique<RemoveTrackCommand>(t, r.timeline), r.timeline);
        r.afterTimelineEdit();
        r.render();
        CHECK(r.undo.undo(r.timeline), name << ": undo");
        r.afterTimelineEdit();
        applierPassThenExpectDriven(r, t, id, name);
    }

    // 2. Track type conversion + undo (timeline only; chains untouched).
    {
        const std::string name = "track type conversion + undo", id = "fx-b";
        const int t = trackWithAutomatedDelay(r, name, id);
        r.undo.execute(std::make_unique<ConvertTrackTypeCommand>(t, TrackInfo::Type::Pattern, r.timeline),
                       r.timeline);
        r.afterTimelineEdit();
        r.render();
        CHECK(r.undo.undo(r.timeline), name << ": undo");
        r.afterTimelineEdit();
        applierPassThenExpectDriven(r, t, id, name);
    }

    // 3. FX Graph node delete + undo: the node comes back with the same
    //    instance id through addGraphEffectNode.
    {
        const std::string name = "FX Graph node delete + undo", id = "fx-c";
        const int t = trackWithAutomatedDelay(r, name, id);
        CHECK(r.engine.removeGraphEffectNode(t, id), name << ": node removed");
        r.engine.refreshAutomationPlanIfDirty();
        r.render();
        CHECK(r.engine.addGraphEffectNode(t, id, "delay") >= 0, name << ": node re-added");
        requireFreshValue(r, t, id, name);
        applierPassThenExpectDriven(r, t, id, name);
    }

    // 4. Whole chain destroyed and re-created by FX Graph hydration (a new
    //    juce graph: new serial, node uids from 1, same addresses).
    {
        const std::string name = "chain destroy + graph hydrate", id = "fx-d";
        const int t = trackWithAutomatedDelay(r, name, id);
        r.engine.destroyEffectChain(t);
        r.engine.refreshAutomationPlanIfDirty();
        r.render();
        const nlohmann::json nodes = nlohmann::json::array(
            { { { "effectInstanceId", id }, { "pluginId", "delay" } } });
        const nlohmann::json res = r.engine.hydrateGraphEffectNodes(t, nodes);
        CHECK(res.value("ok", false), name << ": hydrate ok (" << res.dump() << ")");
        requireFreshValue(r, t, id, name);
        applierPassThenExpectDriven(r, t, id, name);
    }

    // 5. Whole chain destroyed and re-created by addGraphEffectNode.
    {
        const std::string name = "chain destroy + graph re-add", id = "fx-e";
        const int t = trackWithAutomatedDelay(r, name, id);
        r.engine.destroyEffectChain(t);
        r.engine.refreshAutomationPlanIfDirty();
        r.render();
        CHECK(r.engine.addGraphEffectNode(t, id, "delay") >= 0, name << ": node re-added");
        requireFreshValue(r, t, id, name);
        applierPassThenExpectDriven(r, t, id, name);
    }

    // 6. Chain-mode effect remove + restore from the saved chain JSON (what an
    //    effect-chain undo does), and chain destroy + restore.
    {
        const std::string name = "chain-mode remove + restore";
        TrackInfo ti; ti.name = name;
        const int t = r.timeline.addTrack(ti);
        const int nodeId = r.engine.addEffect(t, "delay", 0);
        const std::string id = r.engine.getEffectInstanceIdForNode(t, nodeId);
        CHECK(nodeId >= 0 && !id.empty(), name << ": Delay added");
        r.automate(t, id);
        r.render();
        CHECK(r.driven(t, id), name << ": driven before the mutation (mix=" << r.mix(t, id) << ")");
        const nlohmann::json saved = r.engine.getEffectChainJSON(t);

        CHECK(r.engine.removeEffect(t, nodeId), name << ": removed");
        r.engine.refreshAutomationPlanIfDirty();
        r.render();
        CHECK(r.engine.loadEffectChainFromJSON(t, saved), name << ": restored");
        requireFreshValue(r, t, id, name);
        applierPassThenExpectDriven(r, t, id, name);

        r.engine.destroyEffectChain(t);
        r.engine.refreshAutomationPlanIfDirty();
        r.render();
        CHECK(r.engine.loadEffectChainFromJSON(t, saved), name << ": chain restored after destroy");
        requireFreshValue(r, t, id, name + " (destroyed chain)");
        applierPassThenExpectDriven(r, t, id, name + " (destroyed chain)");
    }

    // 7. A pass with nothing changed must not rebuild (no busy loop).
    CHECK(r.engine.refreshAutomationPlanIfDirty() == 0, "an applier pass with no change rebuilds nothing");
    CHECK(r.engine.refreshAutomationPlanIfDirty() == 0, "... and neither does the next one");

    std::cout << (g_failed == 0 ? "PASS" : "FAIL")
              << " (" << g_passed << " passed, " << g_failed << " failed)\n";
    return g_failed == 0 ? 0 : 1;
}
