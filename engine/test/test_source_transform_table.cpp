// test_source_transform_table.cpp — Pitch Shifter Clip mode: SourceTransform
// capability plumbing.
//
// Build: see engine/CMakeLists.txt target "test_source_transform_table"
// Run:   ctest --test-dir build -C Release -R "^test_source_transform_table$" -V
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1
//
// WHAT THIS GUARDS
//
//   1  Clip mode, semis=7 on track 5 -> table[5] = {active, 7, ...}; a Clip
//      transform that does nothing (0 st, 0 ct, no formant) has NO entry.
//   2  Formant-only Clip is ACTIVE with semis=0.
//   3  Two Clip shifters on one chain -> the LAST in chain order wins, and
//      chain order (not node creation order) is what decides it.
//   4  Clip -> Smart clears the entry on the next rebuild; so do removing the
//      effect and bypassing it.
//   5  Non-track chains never enter the table: the -1 master key in the pure
//      builder, and a real master-chain shifter through MixEngine.
//   6  Epoch-driven publish: an unchanged poll keeps the generation constant
//      and allocates nothing; one identity-parameter change republishes
//      exactly once; a non-identity parameter (mix) republishes nothing.
//   7  A whole-state restore (setStateInformation) advances the epoch, so a
//      restored Clip transform reaches the table.
//
// 1-5 drive the pure builder over a hand-built chain map — no MixEngine.
// 6 and 7 go through a live MixEngine, because the publisher is the subject.

#include "audio/EffectChainManager.h"
#include "audio/MixEngine.h"
#include "audio/SourceTransformTable.h"
#include "audio/XlethPitchShifterEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <atomic>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <new>
#include <string>

// ─── Counting allocator ──────────────────────────────────────────────────────
// Armed only around the no-change poll under test.

namespace {
std::atomic<bool>      g_allocArmed { false };
std::atomic<long long> g_allocCount { 0 };

inline void countAlloc() noexcept
{
    if (g_allocArmed.load(std::memory_order_relaxed))
        g_allocCount.fetch_add(1, std::memory_order_relaxed);
}
} // namespace

void* operator new(std::size_t n)                 { countAlloc(); void* p = std::malloc(n ? n : 1); if (!p) std::abort(); return p; }
void* operator new[](std::size_t n)               { countAlloc(); void* p = std::malloc(n ? n : 1); if (!p) std::abort(); return p; }
void* operator new(std::size_t n, const std::nothrow_t&) noexcept   { countAlloc(); return std::malloc(n ? n : 1); }
void* operator new[](std::size_t n, const std::nothrow_t&) noexcept { countAlloc(); return std::malloc(n ? n : 1); }
void  operator delete(void* p) noexcept                    { std::free(p); }
void  operator delete[](void* p) noexcept                  { std::free(p); }
void  operator delete(void* p, std::size_t) noexcept       { std::free(p); }
void  operator delete[](void* p, std::size_t) noexcept     { std::free(p); }
void  operator delete(void* p, const std::nothrow_t&) noexcept   { std::free(p); }
void  operator delete[](void* p, const std::nothrow_t&) noexcept { std::free(p); }

// ─── Harness ─────────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                 \
    do {                                                                 \
        if (cond) {                                                      \
            ++g_passed;                                                  \
        } else {                                                         \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";  \
            ++g_failed;                                                  \
        }                                                                \
    } while (0)

using xleth::EffectChainMap;
using xleth::SourceTransform;
using xleth::buildTrackSourceTransformTable;
using xleth::sourceTransformSnapshotChanged;

static constexpr float kModeSmart = 1.0f;
static constexpr float kModeClip  = 3.0f;

static std::shared_ptr<EffectChainManager> makeChain()
{
    auto chain = std::make_shared<EffectChainManager>();
    chain->init(44100.0, 512);
    return chain;
}

static int addShifter(EffectChainManager& chain, int position)
{
    return chain.addEffect("pitchshifter", position);
}

static const SourceTransform* entryFor(const EffectChainMap& chains, int trackId)
{
    // Kept alive for the caller: the table is rebuilt per call in these tests.
    static xleth::SourceTransformBuildResult last;
    last = buildTrackSourceTransformTable(chains);
    return last.table.find(trackId);
}

static std::size_t entryCount(const EffectChainMap& chains)
{
    return buildTrackSourceTransformTable(chains).table.entries.size();
}

// ── 1. Clip semis=7 on track 5; do-nothing Clip has no entry ────────────────
static void testClipSemisOnTrack5()
{
    std::cout << "[1] Clip semis=7 on track 5\n";
    EffectChainMap chains;
    auto chain = makeChain();
    chains[5] = chain;

    const int node = addShifter(*chain, 0);
    CHECK(node >= 0, "pitchshifter instantiates in a chain");

    // Default Granular with semis set: not Clip, so nothing.
    chain->setEffectParameter(node, "clip_semitones", 7.0f);
    CHECK(entryFor(chains, 5) == nullptr, "clip_semitones outside Clip mode -> no entry");

    chain->setEffectParameter(node, "mode", kModeClip);
    const auto* t = entryFor(chains, 5);
    CHECK(t != nullptr, "Clip + semis 7 -> table has track 5");
    if (t != nullptr)
    {
        CHECK(t->active,        "entry is active");
        CHECK(t->semis == 7,    "semis == 7 (got " << t->semis << ")");
        CHECK(t->cents == 0,    "cents == 0");
        CHECK(t->method == 2,   "default clip_method (Rubber, index 1) -> StretchMethod 2 (got " << t->method << ")");
        CHECK(!t->formant,      "formant == false");
    }
    CHECK(entryCount(chains) == 1, "exactly one entry");

    // Method mapping: choice index i -> StretchMethod(i + 1).
    chain->setEffectParameter(node, "clip_method", 4.0f);   // WORLD
    t = entryFor(chains, 5);
    CHECK(t != nullptr && t->method == 5, "clip_method WORLD (index 4) -> StretchMethod 5");

    chain->setEffectParameter(node, "clip_cents", -35.0f);
    t = entryFor(chains, 5);
    CHECK(t != nullptr && t->cents == -35, "cents carried (-35)");

    chain->setEffectParameter(node, "clip_semitones", 0.0f);
    chain->setEffectParameter(node, "clip_cents", 0.0f);
    CHECK(entryFor(chains, 5) == nullptr,
          "semis=0 && cents=0 && formant=false -> entry absent");
    CHECK(entryCount(chains) == 0, "table empty");
}

// ── 2. Formant-only Clip is active ──────────────────────────────────────────
static void testFormantOnlyIsActive()
{
    std::cout << "[2] formant-only Clip\n";
    EffectChainMap chains;
    auto chain = makeChain();
    chains[3] = chain;
    const int node = addShifter(*chain, 0);

    chain->setEffectParameter(node, "mode", kModeClip);
    chain->setEffectParameter(node, "clip_formant", 1.0f);

    const auto* t = entryFor(chains, 3);
    CHECK(t != nullptr, "formant-only Clip has an entry");
    if (t != nullptr)
    {
        CHECK(t->active,      "formant-only entry is active");
        CHECK(t->semis == 0,  "semis == 0");
        CHECK(t->cents == 0,  "cents == 0");
        CHECK(t->formant,     "formant == true");
    }
}

// ── 3. Last in chain order wins ─────────────────────────────────────────────
static void testLastInChainOrderWins()
{
    std::cout << "[3] two Clip shifters, last in chain order wins\n";
    EffectChainMap chains;
    auto chain = makeChain();
    chains[2] = chain;

    const int first  = addShifter(*chain, 0);
    const int second = addShifter(*chain, 1);
    CHECK(first >= 0 && second >= 0 && first != second, "two shifters added");

    for (int n : { first, second })
        chain->setEffectParameter(n, "mode", kModeClip);
    chain->setEffectParameter(first,  "clip_semitones", 3.0f);
    chain->setEffectParameter(second, "clip_semitones", 7.0f);

    auto* t = entryFor(chains, 2);
    CHECK(t != nullptr && t->semis == 7, "slot 1 (last) wins: semis 7");
    CHECK(entryCount(chains) == 1, "one entry per track, not one per provider");

    // Reorder: the older node is now last. Chain order, not creation order,
    // must decide.
    CHECK(chain->moveEffect(second, 0), "move second node to slot 0");
    t = entryFor(chains, 2);
    CHECK(t != nullptr && t->semis == 3,
          "after reorder the older node is last and wins: semis 3 (got "
          << (t ? t->semis : -999) << ")");

    // An inactive last provider does not mask an active earlier one.
    chain->setEffectParameter(first, "clip_semitones", 0.0f);
    t = entryFor(chains, 2);
    CHECK(t != nullptr && t->semis == 7,
          "inactive last provider is skipped; active earlier one (semis 7) stands");
}

// ── 4. Mode change / removal / bypass clear the entry ───────────────────────
static void testEntryClears()
{
    std::cout << "[4] Clip -> Smart, removal, bypass\n";
    EffectChainMap chains;
    auto chain = makeChain();
    chains[5] = chain;
    const int node = addShifter(*chain, 0);
    chain->setEffectParameter(node, "mode", kModeClip);
    chain->setEffectParameter(node, "clip_semitones", 7.0f);

    auto built = buildTrackSourceTransformTable(chains);
    CHECK(built.table.find(5) != nullptr, "precondition: entry present");

    chain->setEffectParameter(node, "mode", kModeSmart);
    CHECK(sourceTransformSnapshotChanged(chains, built.snapshot),
          "mode change is visible to the change check");
    built = buildTrackSourceTransformTable(chains);
    CHECK(built.table.find(5) == nullptr, "Clip -> Smart clears the entry on rebuild");

    chain->setEffectParameter(node, "mode", kModeClip);
    built = buildTrackSourceTransformTable(chains);
    CHECK(built.table.find(5) != nullptr, "back to Clip restores it");

    chain->setBypass(node, true);
    CHECK(sourceTransformSnapshotChanged(chains, built.snapshot),
          "bypass toggle is visible to the change check (bypass moves no epoch)");
    built = buildTrackSourceTransformTable(chains);
    CHECK(built.table.find(5) == nullptr, "bypassed provider clears the entry");
    chain->setBypass(node, false);
    built = buildTrackSourceTransformTable(chains);
    CHECK(built.table.find(5) != nullptr, "un-bypass restores it");

    CHECK(chain->removeEffect(node), "remove the shifter");
    CHECK(sourceTransformSnapshotChanged(chains, built.snapshot),
          "removal is visible to the change check");
    built = buildTrackSourceTransformTable(chains);
    CHECK(built.table.find(5) == nullptr, "removed effect clears the entry");
    CHECK(built.snapshot.empty(), "no stamps left for an empty chain");
}

// ── 5. Non-track chains never enter the table ───────────────────────────────
static void testNonTrackChainsExcluded()
{
    std::cout << "[5] non-track chains excluded\n";

    // Pure builder: a -1 (master convention) key alongside a real track.
    EffectChainMap chains;
    auto master = makeChain();
    auto track  = makeChain();
    chains[-1] = master;
    chains[0]  = track;

    const int m = addShifter(*master, 0);
    master->setEffectParameter(m, "mode", kModeClip);
    master->setEffectParameter(m, "clip_semitones", 5.0f);

    auto built = buildTrackSourceTransformTable(chains);
    CHECK(built.table.find(-1) == nullptr, "-1 key never produces an entry");
    CHECK(built.table.entries.empty(), "table empty with only a master-keyed provider");
    CHECK(built.snapshot.empty(), "-1 chain contributes no stamps either");

    const int t = addShifter(*track, 0);
    track->setEffectParameter(t, "mode", kModeClip);
    track->setEffectParameter(t, "clip_semitones", 2.0f);
    built = buildTrackSourceTransformTable(chains);
    CHECK(built.table.entries.size() == 1 && built.table.find(0) != nullptr,
          "track 0 alongside it does enter");

    // Live engine: the real master chain is a separate member and is never walked.
    auto engine = std::make_unique<MixEngine>();
    const int mn = engine->addMasterEffect("pitchshifter", 0);
    CHECK(mn >= 0, "master pitchshifter added");
    engine->setMasterEffectParameter(mn, "mode", kModeClip);
    engine->setMasterEffectParameter(mn, "clip_semitones", 5.0f);
    engine->pollSourceTransformTable();
    CHECK(engine->currentSourceTransformTable()->entries.empty(),
          "a Clip shifter on the MixEngine master chain is inert");
}

// ── 6. Epoch-driven publish ─────────────────────────────────────────────────
static void testEpochPublish()
{
    std::cout << "[6] epoch-driven publish\n";
    auto engine = std::make_unique<MixEngine>();

    CHECK(engine->currentSourceTransformTable() != nullptr, "table never null");
    CHECK(engine->getSourceTransformTableGeneration() == 0, "constructor publishes generation 0");
    CHECK(!engine->pollSourceTransformTable(), "no chains: poll does not republish");
    CHECK(engine->getSourceTransformTableGeneration() == 0, "generation still 0");

    const int node = engine->addEffect(5, "pitchshifter", 0);
    CHECK(node >= 0, "track 5 pitchshifter added");
    CHECK(engine->pollSourceTransformTable(), "new node -> one republish");
    CHECK(engine->getSourceTransformTableGeneration() == 1, "generation 1");
    CHECK(engine->currentSourceTransformTable()->entries.empty(), "Granular -> still no entry");

    engine->setEffectParameter(5, node, "mode", kModeClip);
    engine->setEffectParameter(5, node, "clip_semitones", 7.0f);
    CHECK(engine->pollSourceTransformTable(), "Clip + semis -> republish");
    const auto gen = engine->getSourceTransformTableGeneration();
    CHECK(gen == 2, "two epoch bumps between polls still cost ONE republish (gen " << gen << ")");
    {
        const auto table = engine->currentSourceTransformTable();
        const auto* t = table->find(5);
        CHECK(t != nullptr && t->active && t->semis == 7, "published table[5] = {active, 7}");
    }

    // Unchanged polls: no republish, no allocation.
    // Warm-up first so any one-time lazy allocation is out of the way.
    engine->pollSourceTransformTable();
    g_allocCount.store(0);
    g_allocArmed.store(true);
    bool anyRepublish = false;
    for (int i = 0; i < 100; ++i)
        anyRepublish |= engine->pollSourceTransformTable();
    g_allocArmed.store(false);
    const long long allocs = g_allocCount.load();
    CHECK(!anyRepublish, "100 unchanged polls -> no republish");
    CHECK(engine->getSourceTransformTableGeneration() == gen, "generation constant across unchanged polls");
    CHECK(allocs == 0, "unchanged polls are allocation-free (counted " << allocs << ")");

    // Exactly one bump -> exactly one republish.
    engine->setEffectParameter(5, node, "clip_semitones", -4.0f);
    CHECK(engine->pollSourceTransformTable(), "one param bump -> republish");
    CHECK(!engine->pollSourceTransformTable(), "...and the following poll does not");
    CHECK(engine->getSourceTransformTableGeneration() == gen + 1, "exactly one generation step");
    {
        const auto table = engine->currentSourceTransformTable();
        const auto* t = table->find(5);
        CHECK(t != nullptr && t->semis == -4, "republished table carries semis -4");
    }

    // Mix is not render identity: no epoch bump, no republish.
    engine->setEffectParameter(5, node, "mix", 0.5f);
    CHECK(!engine->pollSourceTransformTable(), "mix change does not republish");
    CHECK(engine->getSourceTransformTableGeneration() == gen + 1, "generation unchanged by mix");

    // Mode away from Clip clears the entry through the publisher too.
    engine->setEffectParameter(5, node, "mode", kModeSmart);
    CHECK(engine->pollSourceTransformTable(), "Clip -> Smart republishes");
    CHECK(engine->currentSourceTransformTable()->find(5) == nullptr, "entry cleared in the published table");

    // Removal through the engine.
    engine->setEffectParameter(5, node, "mode", kModeClip);
    engine->pollSourceTransformTable();
    CHECK(engine->currentSourceTransformTable()->find(5) != nullptr, "back in Clip");
    CHECK(engine->removeEffect(5, node), "remove through MixEngine");
    CHECK(engine->pollSourceTransformTable(), "removal republishes");
    CHECK(engine->currentSourceTransformTable()->entries.empty(), "entry cleared after removal");

    // A reader holding an old table keeps it alive across republish.
    const auto held = engine->currentSourceTransformTable();
    const int again = engine->addEffect(5, "pitchshifter", 0);
    engine->setEffectParameter(5, again, "mode", kModeClip);
    engine->setEffectParameter(5, again, "clip_cents", 50.0f);
    engine->pollSourceTransformTable();
    CHECK(held->entries.empty() && held->generation < engine->getSourceTransformTableGeneration(),
          "held table is immutable and still valid after a republish");
}

// ── 7. setStateInformation advances the epoch ───────────────────────────────
static void testStateRestoreBumpsEpoch()
{
    std::cout << "[7] setStateInformation advances the epoch\n";

    // Capture a Clip-mode state from a donor.
    XlethPitchShifterEffect donor;
    donor.setParameterValue("mode", kModeClip);
    donor.setParameterValue("clip_semitones", 9.0f);
    juce::MemoryBlock state;
    donor.getStateInformation(state);

    auto engine = std::make_unique<MixEngine>();
    const int node = engine->addEffect(1, "pitchshifter", 0);
    engine->pollSourceTransformTable();
    CHECK(engine->currentSourceTransformTable()->entries.empty(), "fresh node: no entry");
    const auto gen = engine->getSourceTransformTableGeneration();

    CHECK(engine->setEffectStateInformation(1, node, state.getData(),
                                            static_cast<int>(state.getSize())),
          "state restored onto the live node");
    CHECK(engine->pollSourceTransformTable(), "restore republishes");
    CHECK(engine->getSourceTransformTableGeneration() == gen + 1, "exactly once");
    const auto table = engine->currentSourceTransformTable();
    const auto* t = table->find(1);
    CHECK(t != nullptr && t->active && t->semis == 9, "restored Clip transform is in the table");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    testClipSemisOnTrack5();
    testFormantOnlyIsActive();
    testLastInChainOrderWins();
    testEntryClears();
    testNonTrackChainsExcluded();
    testEpochPublish();
    testStateRestoreBumpsEpoch();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0)
    {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    return 1;
}
