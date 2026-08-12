// test_lfo_modulation_engine.cpp
// MixEngine-level tests for the FX Graph LFO Modulator → parameter modulation
// path.
//
// The pure evaluator is covered by test_lfo_parameter_modulation. THIS file
// covers the parts that only exist once a real Timeline and a real MixEngine
// are involved:
//
//   §1  snapshot construction: graph mode vs chain mode
//   §2  published values oscillate over time and stay within the mapped range
//   §3  "go inert" — stop transition settles to exactly mapping.base
//   §4  "go inert" — an inaudible track (mute / solo-elsewhere) is pinned to
//       exactly mapping.base while playing, NOT merely "some LFO value". This
//       is the one behavior that does NOT fall out of reusing
//       evaluateModulationMapping (see LfoParameterModulation.h's header-top
//       note and evaluateLfoModulation's comment in MixEngine.cpp) so it needs
//       direct coverage.
//   §5  RCU concurrent snapshot-swap stress test, mirroring
//       test_envelope_modulation_engine.cpp's §11 stress section.
//
// Unlike the Envelope engine test, no pattern/note/clip gate machinery is
// needed anywhere in this file: an LFO free-runs continuously from the
// transport position, with no trigger concept at all — see
// LfoParameterModulation.h's header-top note. Every fixture here is just a
// plain track in Graph fxMode with an LFO node wired to one exposed parameter.
//
// Values are read from the snapshot's mailboxes, which is exactly what the
// audio thread publishes — so these assertions are on the real audio-path
// output, not on a re-implementation of it.
//
// Build target: test_lfo_modulation_engine  (engine/CMakeLists.txt)
// Pass: prints "ALL TESTS PASSED" and exits 0.

#include "audio/MixEngine.h"
#include "model/Timeline.h"
#include "model/LfoParameterModulation.h"
#include "Transport.h"

#include <cmath>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

using namespace xleth::lfomod;

// ─── Minimal harness (mirrors test_envelope_modulation_engine.cpp) ────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                  \
    do {                                                                  \
        if (cond) {                                                       \
            ++g_passed;                                                   \
        } else {                                                          \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";   \
            ++g_failed;                                                   \
        }                                                                 \
    } while (0)

static bool nearly(double a, double b, double eps = 1e-6)
{
    return std::fabs(a - b) <= eps;
}

#define CHECK_SIZE(container, expected, msg)                                    \
    do {                                                                       \
        const std::size_t got_ = (container).size();                           \
        const std::size_t exp_ = static_cast<std::size_t>(expected);           \
        if (got_ == exp_) {                                                    \
            ++g_passed;                                                        \
        } else {                                                               \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg                 \
                      << " (size " << got_ << ", want " << exp_ << ")\n";      \
            ++g_failed;                                                        \
            return;                                                            \
        }                                                                      \
    } while (0)

#define CHECK_NEAR(actual, expected, msg)                                      \
    do {                                                                       \
        const double a_ = (actual);                                            \
        const double e_ = (expected);                                          \
        if (nearly(a_, e_, 1e-5)) {                                            \
            ++g_passed;                                                        \
        } else {                                                               \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg                 \
                      << " (got " << a_ << ", want " << e_ << ")\n";           \
            ++g_failed;                                                        \
        }                                                                      \
    } while (0)

// 120 bpm / 48 kHz, same round numbers as the envelope engine test.
static constexpr double kSR  = 48000.0;
static constexpr double kBPM = 120.0;

// ─── graphState builder ─────────────────────────────────────────────────────

// A graph-mode track carrying one LFO node wired to one exposed parameter of
// one graph-owned effect. Mirrors makeEnvelopeGraphState in
// test_envelope_modulation_engine.cpp, with an "lfo" node instead of "envelope".
static nlohmann::json makeLfoGraphState(int trackId,
                                       const nlohmann::json& lfoData,
                                       double base, double depth)
{
    return nlohmann::json{
        {"version", 1},
        {"trackId", trackId},
        {"nodes", nlohmann::json::array({
            nlohmann::json{{"id", "lfo-1"}, {"type", "lfo"}, {"data", lfoData}},
            nlohmann::json{{"id", "node-fx"}, {"type", "effect"}, {"data", {
                {"effectInstanceId", "fx-1"},
                {"exposedParameterPorts", nlohmann::json::array({
                    nlohmann::json{{"parameterId", "gain"}, {"automatable", true}},
                })},
            }}},
        })},
        {"edges", nlohmann::json::array({
            nlohmann::json{
                {"id", "edge-1"},
                {"type", "parameter"},
                {"sourceNodeId", "lfo-1"},
                {"sourcePort", "controlOut"},
                {"targetNodeId", "node-fx"},
                {"targetParameter", {
                    {"kind", "graph-parameter"},
                    {"graphNodeId", "node-fx"},
                    {"effectInstanceId", "fx-1"},
                    {"parameterId", "gain"},
                }},
                {"mapping", {
                    {"kind", "modulation"},
                    {"enabled", true},
                    {"base", base},
                    {"depth", depth},
                    {"sourceMin", 0.0},
                    {"sourceMax", 1.0},
                    {"curve", {{"type", "linear"}}},
                }},
            },
        })},
    };
}

// Free-mode LFO data (default empty waveform -> sine fallback in the model).
static nlohmann::json freeLfoData(double rateMs)
{
    return nlohmann::json{{"rateMode", "free"}, {"rateMs", rateMs}};
}

// ─── §1 snapshot construction ───────────────────────────────────────────────

static void testSnapshotConstruction()
{
    std::cout << "§1 snapshot construction (graph mode vs chain mode)\n";

    // Chain mode: the LFO must be completely inert — buildLfoModulationSnapshot
    // only considers graph-mode tracks (see its doc comment).
    {
        Timeline timeline(kBPM, kSR);
        TrackInfo track;
        track.name = "chain track";
        const int trackId = timeline.addTrack(track);
        timeline.setTrackGraphState(trackId, makeLfoGraphState(trackId, freeLfoData(250.0), 0.0, 1.0));
        // fxMode left at the default (Chain).

        const auto snapshot = buildLfoModulationSnapshot(timeline);
        CHECK(snapshot->lfos.empty(), "a chain-mode track contributes no LFOs");
        CHECK(snapshot->empty(), "and the snapshot is empty");
    }

    // Graph mode: the LFO is picked up, with one mailbox per resolved edge.
    {
        Timeline timeline(kBPM, kSR);
        TrackInfo track;
        track.name = "graph track";
        const int trackId = timeline.addTrack(track);
        timeline.setTrackFxMode(trackId, TrackFxMode::Graph);
        timeline.setTrackGraphState(trackId,
            makeLfoGraphState(trackId, freeLfoData(250.0), 0.25, 0.5));

        const auto snapshot = buildLfoModulationSnapshot(timeline);
        CHECK_SIZE(snapshot->lfos, 1, "graph mode contributes one LFO");
        CHECK_SIZE(snapshot->edges, 1, "with one resolved edge");
        CHECK(snapshot->mailboxCount == 1, "and one mailbox");
        CHECK(snapshot->mailboxes != nullptr, "mailboxes are allocated with the snapshot");
        CHECK_SIZE(snapshot->mailboxTargets, 1, "one applier target");
        CHECK(snapshot->mailboxTargets[0].trackId == trackId, "target carries the trackId");
        CHECK(snapshot->mailboxTargets[0].effectInstanceId == "fx-1",
              "target is addressed by the stable effectInstanceId");
        CHECK(snapshot->mailboxTargets[0].parameterId == "gain", "target carries the parameterId");

        // Unlike Envelope, mute/solo does NOT change the snapshot's structure at
        // all — buildLfoModulationSnapshot deliberately does not consult
        // audibility (that is a per-block runtime concern in
        // evaluateLfoModulation instead). A muted track still gets a full,
        // normal snapshot entry here.
        auto muted = timeline;
        {
            TrackInfo* t = const_cast<TrackInfo*>(muted.getTrack(trackId));
            CHECK(t != nullptr, "track is reachable for the mute test");
            if (t) t->muted = true;
        }
        const auto mutedSnapshot = buildLfoModulationSnapshot(muted);
        CHECK_SIZE(mutedSnapshot->lfos, 1, "a muted track still contributes its LFO structurally");
        CHECK(mutedSnapshot->mailboxCount == 1,
              "muting does not remove the mailbox at snapshot-build time");
    }

    // A graph-mode track whose LFO has no resolvable edge contributes nothing
    // (no mailbox is wasted on a disconnected LFO).
    {
        Timeline timeline(kBPM, kSR);
        TrackInfo track;
        const int trackId = timeline.addTrack(track);
        timeline.setTrackFxMode(trackId, TrackFxMode::Graph);
        auto graphState = makeLfoGraphState(trackId, freeLfoData(250.0), 0.0, 1.0);
        graphState["edges"][0]["mapping"]["enabled"] = false;
        timeline.setTrackGraphState(trackId, graphState);

        const auto snapshot = buildLfoModulationSnapshot(timeline);
        CHECK(snapshot->lfos.empty(), "an LFO with only disabled edges is dropped");
        CHECK(snapshot->mailboxCount == 0, "and claims no mailbox");
    }

    // NOTE: there is no separate "master track" case here. The master chain is
    // not a Timeline track at all (it is addressed by the MixEngine's own
    // trackId == -1 convention and stored separately from
    // Timeline::getAllTracks()), so it is structurally unreachable by
    // buildLfoModulationSnapshot's `for (const auto* track : allTracks)` loop
    // — there is nothing master-specific for this function to special-case.
}

// ─── MixEngine fixture ──────────────────────────────────────────────────────

// A prepared-but-deviceless MixEngine over a single graph-mode track carrying
// one free-running LFO wired to one exposed parameter, ready for processBlock.
struct LfoEngineFixture {
    Timeline  timeline{kBPM, kSR};
    MixEngine engine;
    Transport transport;
    int       trackId = 0;

    // Always construct through makeLfoFixture(): see the note there.
    LfoEngineFixture(const nlohmann::json& lfoData, double base, double depth)
    {
        TrackInfo track;
        track.name = "lfo track";
        trackId = timeline.addTrack(track);
        timeline.setTrackFxMode(trackId, TrackFxMode::Graph);
        timeline.setTrackGraphState(trackId, makeLfoGraphState(trackId, lfoData, base, depth));

        transport.setSampleRate(kSR);
        transport.setBPM(kBPM);
        // setTimeline resyncs slots, which is where the LFO snapshot is built.
        engine.setTimeline(&timeline);
        engine.refreshLfoDefinitions();
    }
};

// MixEngine is a very large object. MSVC reserves a function's whole frame on
// entry, so two stack-allocated fixtures in one test function can overflow
// even an 8 MB stack before the body runs — same reasoning as
// test_envelope_modulation_engine.cpp's FixturePtr. Fixtures therefore always
// live on the heap.
using LfoFixturePtr = std::unique_ptr<LfoEngineFixture>;

static LfoFixturePtr makeLfoFixture(const nlohmann::json& lfoData, double base, double depth)
{
    return std::make_unique<LfoEngineFixture>(lfoData, base, depth);
}

// The value the audio thread published for the first (and, in these tests,
// only) modulated parameter.
static double publishedValue(const MixEngine& engine)
{
    auto snapshot = engine.getLfoModulationSnapshotForTesting();
    if (!snapshot || snapshot->mailboxCount <= 0 || snapshot->mailboxes == nullptr)
        return -1.0;
    return static_cast<double>(snapshot->mailboxes[0].value.load(std::memory_order_relaxed));
}

// Renders one block at an explicit transport position and returns the value
// the audio thread published for it.
static double renderAt(MixEngine& engine, Transport& transport,
                      int64_t positionSamples, int blockSize = 512)
{
    transport.seekToSample(positionSamples);
    juce::AudioBuffer<float> buffer(2, blockSize);
    buffer.clear();
    engine.processBlock(buffer, blockSize, transport);
    return publishedValue(engine);
}

// ─── §2 published values oscillate and stay in range ───────────────────────

static void testPublishedValuesOscillate()
{
    std::cout << "§2 published values oscillate over time, stay within [base, base+depth]\n";

    // Free mode, rateMs=1000 -> 1 Hz -> a 48000-sample period at 48 kHz. Default
    // empty waveform -> sin(phase*2*PI) fallback, so the four quarter-cycle
    // points below are exact: phase 0 / .25 / .5 / .75 -> bipolar 0 / 1 / ~0 / -1
    // -> unipolar 0.5 / 1 / ~0.5 / 0 -> base + depth*unipolar.
    const double base  = 0.5;
    const double depth = 0.4;
    auto fx_ = makeLfoFixture(freeLfoData(1000.0), base, depth);
    auto& fx = *fx_;
    fx.transport.play();

    const double atZero    = renderAt(fx.engine, fx.transport, 0);
    const double atQuarter = renderAt(fx.engine, fx.transport, 12000);
    const double atHalf    = renderAt(fx.engine, fx.transport, 24000);
    const double atThree   = renderAt(fx.engine, fx.transport, 36000);

    CHECK_NEAR(atZero, base + depth * 0.5, "phase 0: unipolar 0.5 -> base + depth*0.5");
    CHECK_NEAR(atQuarter, base + depth * 1.0, "phase .25 (peak): unipolar 1 -> base + depth");
    CHECK_NEAR(atHalf, base + depth * 0.5, "phase .5: unipolar ~0.5 -> base + depth*0.5 again");
    CHECK_NEAR(atThree, base + depth * 0.0, "phase .75 (trough): unipolar 0 -> base");

    // Genuinely oscillates — not frozen at one value.
    CHECK(!nearly(atZero, atQuarter, 1e-4), "quarter-cycle differs from phase 0 (not frozen)");
    CHECK(!nearly(atQuarter, atThree, 1e-4), "peak differs from trough (not frozen)");

    // Stays within [base, base+depth] (depth is positive here) at every sampled
    // position, including a denser sweep across the whole cycle.
    const double lo = base;
    const double hi = base + depth;
    bool inRange = true;
    double minSeen = 1e9, maxSeen = -1e9;
    for (int64_t p = 0; p < 48000; p += 1777) {
        const double v = renderAt(fx.engine, fx.transport, p);
        if (v < lo - 1e-4 || v > hi + 1e-4) inRange = false;
        minSeen = std::min(minSeen, v);
        maxSeen = std::max(maxSeen, v);
    }
    CHECK(inRange, "every sampled position stays within [base, base+depth]");
    CHECK(maxSeen - minSeen > 0.1, "the sweep covers a real range, not a near-constant value");
}

// ─── §3 go inert: stop transition ───────────────────────────────────────────

static void testStopSettlesToBase()
{
    std::cout << "§3 go inert: stop transition settles to exactly mapping.base\n";

    const double base  = 0.42;
    const double depth = 0.3;
    auto fx_ = makeLfoFixture(freeLfoData(500.0), base, depth); // 2 Hz, period 24000
    auto& fx = *fx_;
    fx.transport.play();

    // Position 6000 = quarter of the 24000-sample period -> phase .25 -> peak ->
    // unipolar 1 -> base + depth = 0.72, confirming this position is NOT base
    // before we stop (otherwise the stop assertion below would pass trivially).
    const double whilePlaying = renderAt(fx.engine, fx.transport, 6000);
    CHECK_NEAR(whilePlaying, base + depth, "mid-cycle peak is base + depth, not base");
    CHECK(!nearly(whilePlaying, base, 1e-3), "sanity: the pre-stop value is genuinely not base");

    // Stop. The stop transition (wasPlaying_ && !isPlaying in processBlock)
    // calls evaluateLfoModulation with atRest=true, which bypasses
    // evaluateModulationMapping entirely and writes mapping.base straight to
    // the mailbox — the only correct "settle" value, per LfoParameterModulation.h's
    // header-top note (an LFO's neutral sample does NOT generally equal base the
    // way Envelope's env==0 does).
    fx.transport.stop();
    {
        juce::AudioBuffer<float> buffer(2, 512);
        buffer.clear();
        fx.engine.processBlock(buffer, 512, fx.transport);
    }
    CHECK_NEAR(publishedValue(fx.engine), base,
               "on stop the parameter settles to EXACTLY the authored base");

    // Repeated stopped blocks do not drift it away from base.
    for (int i = 0; i < 4; ++i) {
        juce::AudioBuffer<float> buffer(2, 512);
        buffer.clear();
        fx.engine.processBlock(buffer, 512, fx.transport);
    }
    CHECK_NEAR(publishedValue(fx.engine), base, "further stopped blocks leave it at base");

    CHECK(!nearly(base, 0.0), "sanity: the authored base is deliberately non-zero");
}

// ─── §4 go inert: mute / solo-elsewhere while playing ───────────────────────

static void testInaudibleTrackPinnedToBase()
{
    std::cout << "§4 go inert: mute / solo-elsewhere pins the mailbox to exactly mapping.base\n";

    // MUTE.
    {
        const double base  = 0.6;
        const double depth = -0.5;
        auto fx_ = makeLfoFixture(freeLfoData(500.0), base, depth); // period 24000
        auto& fx = *fx_;
        fx.transport.play();

        // Position 6000 -> phase .25 -> peak -> unipolar 1 -> base + depth*1 = 0.1.
        const double audible = renderAt(fx.engine, fx.transport, 6000);
        CHECK_NEAR(audible, base + depth, "audible: peak reads base + depth (not base)");

        // Mute the track directly on the SAME Timeline object the engine points
        // at. Audibility is a per-block runtime check inside evaluateLfoModulation
        // (via xleth::buildRoutePlan) — no refreshLfoDefinitions() call is needed
        // for a mute/solo change to take effect, unlike a graphState edit.
        TrackInfo* t = const_cast<TrackInfo*>(fx.timeline.getTrack(fx.trackId));
        CHECK(t != nullptr, "track is reachable to mute");
        if (t) t->muted = true;

        const double mutedValue = renderAt(fx.engine, fx.transport, 6000);
        CHECK_NEAR(mutedValue, base,
                   "a muted track's mailbox is pinned to EXACTLY base, not some other LFO value");

        // Sample a few more positions across the cycle while muted: all of them
        // must read exactly base, not just the one position checked above.
        for (int64_t p : {int64_t(0), int64_t(3000), int64_t(12000), int64_t(18000)}) {
            CHECK_NEAR(renderAt(fx.engine, fx.transport, p), base,
                       "every position reads exactly base while muted, not merely in-range");
        }
    }

    // SOLO ELSEWHERE.
    {
        const double base  = 0.3;
        const double depth = 0.6;
        auto fx_ = makeLfoFixture(freeLfoData(500.0), base, depth);
        auto& fx = *fx_;
        fx.transport.play();

        const double audible = renderAt(fx.engine, fx.transport, 6000);
        CHECK_NEAR(audible, base + depth, "audible before another track is soloed");

        TrackInfo other;
        other.name = "soloed other";
        fx.timeline.addTrack(other);
        {
            // The other track needs solo=true; find it via getAllTracks (it was
            // just added, so it is the last one).
            const auto tracks = fx.timeline.getAllTracks();
            TrackInfo* soloTrack = nullptr;
            for (auto* tr : tracks)
                if (tr != nullptr && tr->id != fx.trackId) soloTrack = const_cast<TrackInfo*>(tr);
            CHECK(soloTrack != nullptr, "the newly added track is reachable");
            if (soloTrack) soloTrack->solo = true;
        }

        const double soloedElsewhereValue = renderAt(fx.engine, fx.transport, 6000);
        CHECK_NEAR(soloedElsewhereValue, base,
                   "solo on another track pins THIS track's mailbox to exactly base");

        // The soloed track itself would remain audible (not asserted directly
        // here since it carries no LFO of its own) — this case only needs to
        // prove the NON-soloed track goes inert, which is the destructive
        // failure mode ("some LFO value" instead of base) this test guards.
    }
}

// ─── §5 RCU concurrent snapshot-swap stress test ────────────────────────────

static void testConcurrentSnapshotSwap()
{
    std::cout << "§5 concurrent snapshot swap (RCU stress), mirrors the envelope test\n";

    auto fx_ = makeLfoFixture(freeLfoData(83.0), 0.1, 0.8); // an odd, fast rate
    auto& fx = *fx_;
    fx.transport.play();

    std::atomic<bool> stop{false};
    std::atomic<bool> sawBadValue{false};

    std::thread renderThread([&] {
        juce::AudioBuffer<float> buffer(2, 256);
        int64_t pos = 0;
        while (!stop.load(std::memory_order_acquire)) {
            buffer.clear();
            fx.transport.seekToSample(pos % 96000);
            fx.engine.processBlock(buffer, 256, fx.transport);
            const double v = publishedValue(fx.engine);
            // evaluateModulationMapping always clamps to [0,1], and the inert
            // bypass writes mapping.base (itself clamped to [0,1] at parse
            // time) — so ANY published value outside [0,1] proves a torn or
            // use-after-free read of the snapshot, exactly like the envelope
            // stress test's check.
            if (v < -0.001 || v > 1.001) sawBadValue.store(true);
            pos += 256;
        }
    });

    // Hammer refreshLfoDefinitions() by toggling the graphState's LFO node data
    // back and forth (alternating the free-mode rate), forcing a fresh snapshot
    // publish + retirement on every iteration while the render thread is loading
    // the live pointer once per block.
    for (int i = 0; i < 400; ++i) {
        fx.timeline.setTrackGraphState(fx.trackId,
            makeLfoGraphState(fx.trackId, freeLfoData((i % 2) ? 83.0 : 137.0), 0.1, 0.8));
        fx.engine.refreshLfoDefinitions();
    }

    stop.store(true, std::memory_order_release);
    renderThread.join();

    CHECK(!sawBadValue.load(), "400 concurrent snapshot swaps never published a bad value");
}

// ─── main ─────────────────────────────────────────────────────────────────────

int main()
{
    std::cout << "=== test_lfo_modulation_engine ===\n";

    testSnapshotConstruction();
    testPublishedValuesOscillate();
    testStopSettlesToBase();
    testInaudibleTrackPinnedToBase();
    testConcurrentSnapshotSwap();

    std::cout << "\npassed: " << g_passed << "  failed: " << g_failed << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    return 1;
}
