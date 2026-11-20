// test_source_transform_stamp_aba.cpp -- the SourceTransform table must be
// republished when a chain is rebuilt, even if the new Pitch Shifter lands at
// the freed one's address with the same node id.
//
// The publisher's change check compares a stamp per effect node. Node ids restart
// at 1 in every new juce::AudioProcessorGraph, and the epoch counts parameter
// changes from 0, so a rebuilt chain (project load, destroyAllEffectChains) that
// reaches the same epoch can produce an identical stamp for a different effect.
// The table then keeps the OLD transform and the clip renders at the wrong pitch.
//
// The Windows heap only sometimes reuses a freed block, so this binary replaces
// global new/delete with a same-size LIFO allocator: the bad case happens on every
// iteration. The test first asserts the address and node id really did collide,
// so a pass can never come from the collision silently not happening.
//
// Build: cmake --build build --target test_source_transform_stamp_aba --config Release
// Run:   ctest --test-dir build -C Release -R "^test_source_transform_stamp_aba$" -V

#include "audio/EffectChainManager.h"
#include "audio/SourceTransformTable.h"
#include "audio/XlethEffectBase.h"
#include "audio/XlethPitchShifterEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <iostream>
#include <memory>

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

using namespace xleth;

namespace {

constexpr float kModeClip   = 3.0f;
constexpr int   kTrack      = 5;
constexpr int   kIterations = 10;

// A track chain holding one Clip-mode Pitch Shifter. The same parameter writes in
// the same order leave the shifter at the same epoch whatever `semis` is.
std::shared_ptr<EffectChainManager> makeChain(float semis, int& nodeId, const XlethEffectBase*& effect)
{
    auto chain = std::make_shared<EffectChainManager>();
    chain->init(44100.0, 512);
    nodeId = chain->addEffect("pitchshifter", 0);
    chain->setEffectParameter(nodeId, "mode", kModeClip);
    chain->setEffectParameter(nodeId, "clip_semitones", semis);

    effect = nullptr;
    chain->visitEffectsInChainOrder(&effect,
        [](void* c, int, XlethEffectBase* e) { *static_cast<const XlethEffectBase**>(c) = e; });
    return chain;
}

} // namespace

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << std::unitbuf;
    std::cout << "test_source_transform_stamp_aba\n";

    int collisions = 0, stale = 0;
    for (int i = 0; i < kIterations; ++i)
    {
        EffectChainMap chains;
        int oldNode = -1, newNode = -1;
        const XlethEffectBase* oldFx = nullptr;
        const XlethEffectBase* newFx = nullptr;

        chains[kTrack] = makeChain(7.0f, oldNode, oldFx);
        auto built = buildTrackSourceTransformTable(chains);
        const SourceTransform* t = built.table.find(kTrack);
        CHECK(t != nullptr && t->semis == 7, "the first chain publishes +7 st");

        // What the publisher holds between polls.
        TrackSourceTransformTable published = built.table;
        SourceTransformEpochSnapshot snapshot = built.snapshot;

        // Project load: every chain destroyed, then rebuilt before the next poll.
        chains.clear();
        chains[kTrack] = makeChain(3.0f, newNode, newFx);

        if (oldFx == newFx && oldNode == newNode) ++collisions;

        // The publisher's poll (MixEngine::pollSourceTransformTableAt).
        if (sourceTransformSnapshotChanged(chains, snapshot))
        {
            auto rebuilt = buildTrackSourceTransformTable(chains);
            published = std::move(rebuilt.table);
        }
        const SourceTransform* now = published.find(kTrack);
        if (now == nullptr || now->semis != 3)
        {
            if (stale == 0)
                std::cerr << "  iteration " << i << ": table still holds semis="
                          << (now ? now->semis : -999) << ", the new shifter has 3\n";
            ++stale;
        }
    }

    CHECK(collisions == kIterations,
          "the rebuilt shifter reused the old address and node id (" << collisions << " of "
              << kIterations << " iterations); otherwise this test proves nothing");
    CHECK(stale == 0,
          "the table reflects the NEW shifter after a chain rebuild (" << stale << " of "
              << kIterations << " iterations kept the old transform)");

    std::cout << (g_failed == 0 ? "PASS" : "FAIL")
              << " (" << g_passed << " passed, " << g_failed << " failed)\n";
    return g_failed == 0 ? 0 : 1;
}
