// test_automation_runtime_lifetime.cpp -- an automation plan resolved against
// one effect chain must never write into a different chain.
//
// The plan's per-target handles (parameter pointer, raw atomic) are resolved on
// the message thread and travel to the audio thread inside every ChainSnapshot,
// including snapshots published AFTER the chains it was resolved against were
// destroyed (project load, destroyAllEffectChains) and before the envelope
// applier rebuilds it. The audio thread's only guard was "this nodeId in this
// chain's view still maps to the same XlethEffectBase*". A fresh chain is a
// fresh juce::AudioProcessorGraph whose node uids start over, and the new effect
// is often allocated at the freed one's address, so the guard passed and the
// block wrote through the dead effect's parameter: 0xC0000005 in
// RangedAudioParameter::convertFrom0to1 under applyAutomationForBlock, about 1
// run in 10 of bridge/test_automation_clips_bridge.js.
//
// The check: automate the master Delay's mix, destroy every chain, add a new
// Delay to a new master chain and render a block with the stale plan still
// installed. No parameter of the new Delay may change.
//
// Address reuse is what turns the stale plan into a write, and the Windows heap
// only sometimes reuses a freed block for the next same-size allocation. This
// binary replaces global operator new/delete with an allocator that ALWAYS does
// (same-size LIFO), so the bad case happens on every iteration instead of by
// lottery. Before the fix the test crashes or reports stray writes every run.
//
// Build: cmake --build build --target test_automation_runtime_lifetime --config Release
// Run:   ctest --test-dir build -C Release -R "^test_automation_runtime_lifetime$" -V

#include "audio/MixEngine.h"
#include "audio/XlethEffectBase.h"
#include "model/Timeline.h"
#include "Transport.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <atomic>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <new>
#include <string>
#include <vector>

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

constexpr double kRate       = 48000.0;
constexpr int    kBlock      = 512;
constexpr double kAutomated  = 0.9;   // normalized value the plan holds the mix at
constexpr int    kIterations = 50;

// What the effect actually reads: every parameter's APVTS raw (denormalised)
// atomic, which is where automation stores. param->getValue() is a different
// atomic and never sees an automation write.
std::vector<float> rawValues(MixEngine& engine, int nodeId)
{
    std::vector<float> out;
    XlethEffectBase* fx = engine.getMasterEffectPtr(nodeId);
    if (fx == nullptr) return out;
    for (auto* p : fx->getParameters())
    {
        auto* withId = dynamic_cast<juce::AudioProcessorParameterWithID*>(p);
        std::atomic<float>* raw = nullptr;
        juce::RangedAudioParameter* param = nullptr;
        if (withId != nullptr
            && fx->resolveAutomationParameter(withId->paramID.toStdString(), raw, param))
            out.push_back(raw->load());
    }
    return out;
}

double mixOf(MixEngine& engine, int nodeId)
{
    XlethEffectBase* fx = engine.getMasterEffectPtr(nodeId);
    std::atomic<float>* raw = nullptr;
    juce::RangedAudioParameter* param = nullptr;
    if (fx == nullptr || !fx->resolveAutomationParameter("mix", raw, param)) return -1.0;
    return param->convertTo0to1(raw->load());
}

void renderBlock(MixEngine& engine, Transport& transport)
{
    juce::AudioBuffer<float> buf(2, kBlock);
    buf.clear();
    engine.refreshTimelineSnapshot();               // the bridge publishes after every edit
    engine.processBlock(buf, kBlock, transport);   // stopped: automation still applies at tick 0
}

} // namespace

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << std::unitbuf;
    std::cout << "test_automation_runtime_lifetime\n";

    Timeline timeline;
    Transport transport;
    transport.setSampleRate(kRate);
    transport.setBPM(120.0);

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.prepare(kRate, kBlock);

    const int nodeId = engine.addMasterEffect("delay", 0);
    CHECK(nodeId >= 0, "master Delay added");
    const std::string instanceId = engine.getEffectInstanceIdForNode(-1, nodeId);
    CHECK(!instanceId.empty(), "master Delay has an instance id");

    AutomationLane lane;
    lane.ownerTrackId = -1;
    const int laneId = timeline.addAutomationLane(lane);

    AutomationEnvelope env;
    env.binding.ownerTrackId     = -1;
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
    CHECK(timeline.addAutomationClip(clip) > 0, "automation clip added");

    engine.refreshTimelineSnapshot();   // the plan builds from the published timeline, as in the bridge hook
    engine.refreshAutomationPlan();
    renderBlock(engine, transport);
    CHECK(std::fabs(mixOf(engine, nodeId) - kAutomated) < 1e-3,
          "the plan drives the Delay it was resolved against (mix=" << mixOf(engine, nodeId) << ")");

    // The plan above stays installed: nothing below refreshes it. The envelope
    // applier would (it rebuilds whenever the chains differ from the plan's), and
    // winning that race makes an iteration prove nothing, so it is stopped.
    engine.stopEnvelopeApplierForTesting();
    int strayWrites = 0;
    for (int i = 0; i < kIterations; ++i)
    {
        engine.destroyAllEffectChains();
        const int fresh = engine.addMasterEffect("delay", 0);
        const std::vector<float> before = rawValues(engine, fresh);
        renderBlock(engine, transport);
        const std::vector<float> after = rawValues(engine, fresh);
        if (before.empty() || before != after)
        {
            if (strayWrites == 0)
                std::cerr << "  iteration " << i << ": a parameter of the new Delay (node "
                          << fresh << ") changed under the stale plan\n";
            ++strayWrites;
        }
    }
    CHECK(strayWrites == 0,
          "a plan resolved against a destroyed chain never writes the new chain's effect ("
              << strayWrites << " of " << kIterations << " blocks did)");

    // A plan rebuilt against the new chain drives it again. Rebinding by
    // instance id is what project load does; here the new Delay simply gets
    // the envelope's binding.
    {
        engine.destroyAllEffectChains();
        const int fresh = engine.addMasterEffect("delay", 0);
        const std::string freshId = engine.getEffectInstanceIdForNode(-1, fresh);
        AutomationEnvelope* e = timeline.getAutomationEnvelopeMutable(envId);
        CHECK(e != nullptr, "envelope still present");
        if (e != nullptr)
            e->binding.effectInstanceId = freshId;
        engine.refreshTimelineSnapshot();
        engine.refreshAutomationPlan();
        renderBlock(engine, transport);
        CHECK(std::fabs(mixOf(engine, fresh) - kAutomated) < 1e-3,
              "a refreshed plan drives the new chain (mix=" << mixOf(engine, fresh) << ")");
    }

    std::cout << (g_failed == 0 ? "PASS" : "FAIL")
              << " (" << g_passed << " passed, " << g_failed << " failed)\n";
    return g_failed == 0 ? 0 : 1;
}
