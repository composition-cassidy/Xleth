// test_stock_compressor_sidechain.cpp — Prompt 5A: stock XlethCompressorEffect
// external sidechain consumption.
//
// Proves, end-to-end through MixEngine::processBlock with the REAL stock
// compressor (engine->addEffect("compressor")):
//   • With sc_external=1 and a sidechain route targeting the compressor instance,
//     the Bass (target) signal ducks when the Kick (key) is present — and the
//     Kick is never audible through the Bass output (the ducked window has LESS
//     energy than the un-ducked window, not more, so no key leaks in).
//   • With sc_external=0 the route has NO effect — output is bit-identical to no
//     route (legacy behavior preserved; default sc_external is 0).
//   • With sc_external=1 but the route disabled / removed / never added, the
//     compressor uses SILENCE as the key (no ducking) — external mode never
//     compresses from the main signal.
//   • Key gain scales the amount of ducking; muted source kills the key; a route
//     targeting a DIFFERENT effect instance on the same track does not duck this
//     compressor; multiple key sources sum into a stronger duck.
//   • A bypassed compressor leaves the Bass output bit-identical with vs without
//     the route (key dropped, never leaked).
//
// Isolation trick (reused from test_sidechain_runtime scenario H): the target is
// SOLOED, so the source is silenced audibly but still feeds its key
// (feedsSidechainOnly). Master therefore contains ONLY the Bass, so its energy
// envelope is a clean measure of compressor gain reduction with no Kick bleed.
//
// Build: see engine/CMakeLists.txt target "test_stock_compressor_sidechain"
// Pass:  prints "ALL TESTS PASSED" and exits 0
//
// NOTE: MixEngine is heavy — heap-allocated (unique_ptr), never two on a stack.

#include "audio/MixEngine.h"
#include "audio/XlethCompressorEffect.h"
#include "model/Timeline.h"
#include "SampleBank.h"
#include "Transport.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <cmath>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

// ─── Harness ──────────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                 \
    do {                                                                 \
        if (cond) { ++g_passed; }                                        \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; ++g_failed; } \
    } while (0)

// ─── Sample fixtures ──────────────────────────────────────────────────────────

static const double kBPM = 120.0;
static const double kSR  = 44100.0;
static constexpr int kBeat = 22050;                 // one beat @ 120 BPM / 44100
static constexpr int kRenderSamples = kBeat * 2;    // 1.0 s

static juce::File generateSineWav(const juce::File& dir, const juce::String& name,
                                  int numSamples, float freq, float amplitude)
{
    juce::AudioBuffer<float> buf(1, numSamples);
    float* data = buf.getWritePointer(0);
    for (int i = 0; i < numSamples; ++i)
    {
        const double t = static_cast<double>(i) / kSR;
        data[i] = amplitude * static_cast<float>(
            std::sin(2.0 * juce::MathConstants<double>::pi * freq * t));
    }
    juce::File file = dir.getChildFile(name + ".wav");
    file.deleteFile();
    auto outStream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
    if (outStream == nullptr) return {};
    juce::WavAudioFormat wavFmt;
    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFmt.createWriterFor(outStream.get(), kSR, 1, 16, {}, 0));
    if (writer == nullptr) return {};
    outStream.release();
    writer->writeFromAudioSampleBuffer(buf, 0, numSamples);
    writer.reset();
    return file;
}

struct SampleSet
{
    juce::File dir, kickWav, bassWav;
    int kickLen = 0;
    int bassLen = 0;
};

static SampleSet makeSamples()
{
    SampleSet ss;
    ss.dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                 .getChildFile("xleth_test_stock_comp_sc");
    ss.dir.createDirectory();
    // Kick: loud, short (200 ms) — clearly above the compressor threshold.
    // Bass: quiet, long (1 s) — clearly BELOW threshold so the internal detector
    // never self-compresses; only the external key can duck it.
    ss.kickLen = static_cast<int>(kSR * 0.20);
    ss.bassLen = static_cast<int>(kSR * 1.00);
    ss.kickWav = generateSineWav(ss.dir, "kick", ss.kickLen,  80.0f, 0.70f);
    ss.bassWav = generateSineWav(ss.dir, "bass", ss.bassLen, 300.0f, 0.10f);
    return ss;
}

static void addBeatClip(Timeline& tl, int trackId, int regionId, double beat, double durBeats)
{
    Clip c;
    c.trackId  = trackId;
    c.regionId = regionId;
    c.position = TickTime::fromBeats(beat);
    c.duration = TickTime::fromBeats(durBeats);
    tl.addClip(c);
}

static double maxAbsDiffWindow(const juce::AudioBuffer<float>& a,
                               const juce::AudioBuffer<float>& b, int start, int end)
{
    const int ch = std::min(a.getNumChannels(), b.getNumChannels());
    start = std::max(0, start);
    end   = std::min({end, a.getNumSamples(), b.getNumSamples()});
    double d = 0.0;
    for (int c = 0; c < ch; ++c)
        for (int i = start; i < end; ++i)
            d = std::max(d, static_cast<double>(std::abs(a.getSample(c, i) - b.getSample(c, i))));
    return d;
}

static double maxAbsDiff(const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
{
    return maxAbsDiffWindow(a, b, 0, std::min(a.getNumSamples(), b.getNumSamples()));
}

// RMS over a sample window [start, end) across both channels.
static double rmsWindow(const juce::AudioBuffer<float>& buf, int start, int end)
{
    start = std::max(0, start);
    end   = std::min(buf.getNumSamples(), end);
    if (end <= start) return 0.0;
    double e = 0.0;
    int n = 0;
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        for (int i = start; i < end; ++i)
        { const double s = buf.getSample(ch, i); e += s * s; ++n; }
    return n > 0 ? std::sqrt(e / n) : 0.0;
}

// Window where the Kick key is active (after attack settle, before kick ends).
static double rmsEarly(const juce::AudioBuffer<float>& m) { return rmsWindow(m, 3000, 8000); }
// Window long after the Kick ended and the release recovered — Bass at full level.
static double rmsLate (const juce::AudioBuffer<float>& m) { return rmsWindow(m, 26000, 42000); }

// ─── Scenario runner ──────────────────────────────────────────────────────────

struct Scenario
{
    bool  scExternal       = true;   // compressor sc_external param
    bool  addRoute         = true;
    bool  routeEnabled     = true;
    float gain             = 1.0f;
    bool  mutedSource      = false;
    bool  bypassCompressor = false;
    bool  routeToSecond    = false;  // route targets a 2nd effect, not the 1st
    int   numSources       = 1;      // 1 or 2 key sources
};

struct Result
{
    juce::AudioBuffer<float> master{2, kRenderSamples};
    bool routeAccepted = true;
};

static Result runScenario(const SampleSet& ss, const Scenario& sc)
{
    Result r;
    r.master.clear();

    Timeline tl(kBPM, kSR);

    // Two key sources max; target is always soloed for isolation.
    std::vector<int> sourceIds;
    for (int n = 0; n < sc.numSources; ++n)
    {
        TrackInfo source; source.name = "Kick" + std::to_string(n);
        source.muted = sc.mutedSource;
        sourceIds.push_back(tl.addTrack(source));
    }
    TrackInfo target; target.name = "Bass";
    target.solo = true;
    const int targetId = tl.addTrack(target);

    SampleRegion kr; kr.name = "Kick"; kr.label = SampleLabel::Custom;
    SampleRegion br; br.name = "Bass"; br.label = SampleLabel::Custom;
    const int kickReg = tl.addRegion(kr);
    const int bassReg = tl.addRegion(br);
    for (int id : sourceIds)
        addBeatClip(tl, id, kickReg, 0.0, 1.0);     // kick key at beat 0
    addBeatClip(tl, targetId, bassReg, 0.0, 2.0);    // bass spans the whole render

    SampleBank bank;
    const int kid = bank.loadSample(ss.kickWav, kSR);
    const int bid = bank.loadSample(ss.bassWav, kSR);

    auto engine = std::make_unique<MixEngine>();
    engine->prepare(kSR, 512);
    engine->setTimeline(&tl);
    engine->setSampleBank(&bank);
    engine->mapRegionToSample(kickReg, kid);
    engine->mapRegionToSample(bassReg, bid);

    // Add the stock compressor(s) to the Bass chain. The FIRST is the one we
    // measure; a SECOND (only created when routeToSecond) is the decoy target.
    const int comp1 = engine->addEffect(targetId, "compressor", 0);
    const std::string eid1 = engine->getEffectInstanceIdForNode(targetId, comp1);

    int comp2 = -1;
    std::string eid2;
    if (sc.routeToSecond)
    {
        comp2 = engine->addEffect(targetId, "compressor", 1);
        eid2  = engine->getEffectInstanceIdForNode(targetId, comp2);
        // Decoy stays internal (default sc_external=0) so it never ducks either.
    }

    // Configure the measured compressor for clean, deterministic ducking:
    // threshold above the Bass level (no self-compression) but well below the
    // Kick key level; high ratio; fast attack; quick release; no makeup.
    auto cfg = [&](int node)
    {
        engine->setEffectParameter(targetId, node, "threshold",  -16.0f);
        engine->setEffectParameter(targetId, node, "ratio",       10.0f);
        engine->setEffectParameter(targetId, node, "attack",       0.5f);
        engine->setEffectParameter(targetId, node, "release",    100.0f);
        engine->setEffectParameter(targetId, node, "knee",         0.0f);
        engine->setEffectParameter(targetId, node, "makeup",       0.0f);
        engine->setEffectParameter(targetId, node, "mix",        100.0f);
        engine->setEffectParameter(targetId, node, "sc_external",
                                   sc.scExternal ? 1.0f : 0.0f);
    };
    cfg(comp1);
    if (comp2 >= 0)
    {
        engine->setEffectParameter(targetId, comp2, "threshold", -16.0f);
        engine->setEffectParameter(targetId, comp2, "ratio",      10.0f);
        engine->setEffectParameter(targetId, comp2, "makeup",      0.0f);
        // decoy sc_external left at default 0
    }

    if (sc.bypassCompressor)
        engine->setEffectBypass(targetId, comp1, true);

    if (sc.addRoute)
    {
        SidechainRoute route;
        route.routeId = "sc-comp-route";
        route.targetTrackId = targetId;
        route.targetEffectInstanceId = sc.routeToSecond ? eid2 : eid1;
        route.gain = sc.gain;
        route.preFader = false;
        route.enabled = sc.routeEnabled;

        xleth::SidechainEffectResolver resolver =
            [&](int tid, const std::string& eid) -> bool
            { return engine->getEffectNodeIdForInstance(tid, eid) >= 0; };

        // Route from the first source; a second source (if any) routes too.
        const auto vr = tl.addSidechainRoute(sourceIds[0], route, resolver);
        r.routeAccepted = vr.ok();

        if (sc.numSources > 1)
        {
            SidechainRoute route2 = route;
            route2.routeId = "sc-comp-route-2";
            tl.addSidechainRoute(sourceIds[1], route2, resolver);
        }
    }

    engine->syncTrackSlotsFromTimeline(true);
    engine->syncSidechainTargetBuses();   // Prompt 5A: enable targeted compressor bus
    engine->setNonRealtime(true);

    Transport t;
    t.setSampleRate(kSR);
    t.setBPM(kBPM);
    t.seekToSample(0);
    t.play();

    int pos = 0;
    while (pos < kRenderSamples)
    {
        const int n = std::min(512, kRenderSamples - pos);
        juce::AudioBuffer<float> block(2, n);
        block.clear();
        engine->processBlock(block, n, t);
        for (int ch = 0; ch < 2; ++ch)
            r.master.copyFrom(ch, pos, block, ch, 0, n);
        t.advance(n);
        pos += n;
    }
    t.pause();
    return r;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << "=== test_stock_compressor_sidechain (Prompt 5A) ===\n";

    SampleSet ss = makeSamples();
    CHECK(ss.kickWav.existsAsFile(), "kick WAV generated");
    CHECK(ss.bassWav.existsAsFile(), "bass WAV generated");

    // ── Baseline: default compressor parameter list / default sc_external ──────
    {
        std::cout << "[0] sc_external default is 0; param appears in the layout\n";
        XlethCompressorEffect comp;
        comp.prepareToPlay(kSR, 512);
        CHECK(std::abs(comp.getParameterValue("sc_external") - 0.0f) < 1e-6f,
              "sc_external defaults to 0 (old projects unchanged)");
        const std::string pj = comp.getParametersAsJSON();
        CHECK(pj.find("sc_external") != std::string::npos,
              "sc_external present in getParametersAsJSON");
        CHECK(comp.supportsExternalSidechain(),
              "compressor reports supportsExternalSidechain()");
        CHECK(comp.hasSidechainInputBus(),
              "compressor declares a second input bus");
        CHECK(!comp.isSidechainInputEnabled(),
              "sidechain bus is DISABLED by default");
    }

    // ── A: external key ducks the Bass; Kick stays inaudible ──────────────────
    std::cout << "[A] sc_external=1 + route → Bass ducks under the Kick key\n";
    Scenario ext;  // sc_external=1, route, gain 1
    Result extR = runScenario(ss, ext);
    CHECK(extR.routeAccepted, "valid route accepted");
    const double extEarly = rmsEarly(extR.master);
    const double extLate  = rmsLate (extR.master);
    std::cout << "    early(kick)=" << extEarly << " late(no kick)=" << extLate << "\n";
    CHECK(extLate > 1e-4, "Bass audible in the un-ducked (late) window");
    // The early window (kick present) must be QUIETER than the late window. This
    // simultaneously proves ducking AND that the Kick does not leak in (a leak
    // would make the early window LOUDER, not quieter).
    CHECK(extEarly < 0.7 * extLate,
          "Bass is reduced while the Kick key is present (ducking + no key leak)");

    // ── B: sc_external=0 → route has no effect (legacy behavior) ───────────────
    std::cout << "[B] sc_external=0 → route ignored, output == no-route\n";
    Scenario intRoute = ext; intRoute.scExternal = false;       // route present
    Scenario intNoRoute = intRoute; intNoRoute.addRoute = false; // no route
    Result intRouteR   = runScenario(ss, intRoute);
    Result intNoRouteR = runScenario(ss, intNoRoute);
    const double dInt = maxAbsDiff(intRouteR.master, intNoRouteR.master);
    std::cout << "    masterDiff(sc_ext=0, route vs no-route)=" << dInt << "\n";
    CHECK(dInt < 1e-6, "sc_external=0: route present is bit-identical to no route");
    // And the Bass is NOT ducked by the Kick with sc_external=0.
    CHECK(rmsEarly(intRouteR.master) > 0.85 * rmsLate(intRouteR.master),
          "sc_external=0: Bass not ducked by Kick");
    // Internal-mode output is the un-ducked reference for later comparisons.
    const double refEarly = rmsEarly(intNoRouteR.master);

    // ── C: sc_external=1 but no route → silence key, no ducking ────────────────
    std::cout << "[C] sc_external=1 + no route → silence key (no ducking)\n";
    Scenario extNoRoute = ext; extNoRoute.addRoute = false;
    Result extNoRouteR = runScenario(ss, extNoRoute);
    CHECK(std::abs(rmsEarly(extNoRouteR.master) - refEarly) < 0.05 * refEarly,
          "sc_external=1 with no key bus does not compress from the main signal");
    CHECK(rmsEarly(extNoRouteR.master) > 1.4 * extEarly,
          "no-key external mode is much louder than the ducked external mode");

    // ── D: disabled route, sc_external=1 → no ducking ──────────────────────────
    std::cout << "[D] sc_external=1 + route disabled → no ducking\n";
    Scenario extDisabled = ext; extDisabled.routeEnabled = false;
    Result extDisabledR = runScenario(ss, extDisabled);
    CHECK(std::abs(rmsEarly(extDisabledR.master) - refEarly) < 0.05 * refEarly,
          "disabled route delivers no key → no ducking");

    // ── E: muted source → key dies → no ducking ────────────────────────────────
    std::cout << "[E] Muted source → no key → no ducking\n";
    Scenario extMuted = ext; extMuted.mutedSource = true;
    Result extMutedR = runScenario(ss, extMuted);
    CHECK(std::abs(rmsEarly(extMutedR.master) - refEarly) < 0.05 * refEarly,
          "muted source produces no key → no ducking");

    // ── F: key gain scales the amount of ducking ───────────────────────────────
    std::cout << "[F] Lower key gain → less ducking (higher early energy)\n";
    Scenario extLowGain = ext; extLowGain.gain = 0.5f;
    Result extLowGainR = runScenario(ss, extLowGain);
    const double lowGainEarly = rmsEarly(extLowGainR.master);
    std::cout << "    early(g=1.0)=" << extEarly << " early(g=0.5)=" << lowGainEarly
              << " ref=" << refEarly << "\n";
    CHECK(lowGainEarly > extEarly,
          "lower key gain reduces the amount of ducking");
    CHECK(lowGainEarly < refEarly,
          "a reduced-gain key still ducks somewhat");

    // ── G: route to a DIFFERENT effect instance does not duck this compressor ──
    std::cout << "[G] Route to another instance on the same track → no ducking here\n";
    Scenario extWrong = ext; extWrong.routeToSecond = true;
    Result extWrongR = runScenario(ss, extWrong);
    CHECK(std::abs(rmsEarly(extWrongR.master) - refEarly) < 0.06 * refEarly,
          "route targeting a different instance leaves this compressor un-keyed");

    // ── H: multiple sources sum into a stronger duck ───────────────────────────
    std::cout << "[H] Two key sources sum → stronger ducking than one\n";
    Scenario extTwo = ext; extTwo.numSources = 2;
    Result extTwoR = runScenario(ss, extTwo);
    std::cout << "    early(1 src)=" << extEarly << " early(2 src)=" << rmsEarly(extTwoR.master) << "\n";
    CHECK(rmsEarly(extTwoR.master) < extEarly,
          "two summed key sources duck harder than one");

    // ── I: bypassed compressor leaks no key (bit-identical to no route) ────────
    std::cout << "[I] Bypassed compressor → key dropped, output unchanged by route\n";
    Scenario byp = ext; byp.bypassCompressor = true;
    Scenario bypNoRoute = byp; bypNoRoute.addRoute = false;
    Result bypR        = runScenario(ss, byp);
    Result bypNoRouteR = runScenario(ss, bypNoRoute);
    // Compare AFTER the 5 ms bypass crossfade has fully settled (bypassMix=1, the
    // fast passthrough path that never calls the detector). From here the active
    // key route must leave the output bit-identical — the key never reaches the
    // output bus. The Kick is still playing through this window (samples < ~8800),
    // so any key leak would appear as a large (~0.4) diff; we require exact zero.
    const double dBypSettled = maxAbsDiffWindow(bypR.master, bypNoRouteR.master,
                                                400, kRenderSamples);
    // The whole-buffer diff (incl. the benign bypass-fade transient) must still be
    // far below the Kick level, proving the difference is main-signal fade, not key.
    const double dBypFull = maxAbsDiff(bypR.master, bypNoRouteR.master);
    std::cout << "    masterDiff(bypassed, settled)=" << dBypSettled
              << " full=" << dBypFull << "\n";
    CHECK(dBypSettled < 1e-6,
          "fully-bypassed compressor: active key route is bit-identical to no route (no key leak)");
    CHECK(dBypFull < 0.05,
          "bypass-fade transient is main-signal only, nowhere near the Kick key level");

    ss.dir.deleteRecursively();

    std::cout << "\n=== Results: " << g_passed << " passed, " << g_failed << " failed ===\n";
    if (g_failed > 0) { std::cerr << "FAILED: " << g_failed << " test(s) failed\n"; return 1; }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
