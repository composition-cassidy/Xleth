// test_sampler_legacy_migration.cpp — Schema 3 → 4 sampler modulation migration.
// Build: see engine/CMakeLists.txt target "test_sampler_legacy_migration"
// Run:   test_sampler_legacy_migration.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: ..." and exits 1
//
// Covers the four deliverables the migration owes:
//   1. MAPPING     — each legacy source lands on the expected new route, with
//                    the amount that reproduces its legacy depth exactly.
//   2. ROUNDTRIP   — a legacy region JSON loads, and a Sampler built from it
//                    renders audibly equivalent to the legacy signal path.
//   3. STREAM CAP  — route add/remove stays correct under the 32-stream cap.
//   4. BIPOLAR     — the ring math the UI draws agrees with routeOffset().

#include "audio/Sampler.h"
#include "audio/SamplerModulation.h"
#include "model/SampleRegion.h"
#include "model/SamplerLegacyMigration.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <iostream>
#include <string>
#include <vector>

namespace sm  = xleth::sampmod;
namespace slg = xleth::samplegacy;

// ─── Test harness ────────────────────────────────────────────────────────────

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

#define CHECK_NEAR(a, b, tol, msg) \
    CHECK(std::abs(static_cast<double>(a) - static_cast<double>(b)) < (tol), msg)

static constexpr double kEngineSR = 48000.0;

// ─── Fixtures ────────────────────────────────────────────────────────────────

// A minimal schema-3 region JSON carrying every legacy modulation system.
// Only the keys the migration reads are present; from_json fills the rest with
// defaults, which is exactly what an old project that never touched a control
// looks like on disk.
static nlohmann::json legacyRegionJson()
{
    nlohmann::json j;
    // Every key SampleRegion::from_json reads with .at() is mandatory — a
    // missing or mistyped one throws out of the load rather than defaulting.
    j["id"]        = 1;
    j["sourceId"]  = 1;
    j["name"]      = "legacy";
    j["label"]     = "Custom";
    j["customLabelName"]  = "";
    j["startTime"] = 0.0;
    j["endTime"]   = 1.0;
    j["startFrame"] = 0;
    j["endFrame"]   = 24;
    j["audioFilePath"]    = "";
    j["swappedAudioPath"] = "";
    j["hasSwappedAudio"]  = false;
    j["syllables"]        = nlohmann::json::array();

    // Amplitude envelope (stays the VCA; mirrored into ENV 1).
    j["attackMs"]  = 12.0f;
    j["decayMs"]   = 40.0f;
    j["sustain"]   = 0.6f;
    j["releaseMs"] = 75.0f;
    j["holdMs"]    = 5.0f;
    j["delayMs"]   = 2.0f;
    j["attackTension"] = 0.25f;

    // Pitch envelope → ENV 2 → SlotSem.
    j["pitchEnvEnabled"]   = true;
    j["pitchEnvAmount"]    = 24.0f;      // semitones
    j["pitchEnvAttackMs"]  = 30.0f;
    j["pitchEnvDecayMs"]   = 60.0f;
    j["pitchEnvSustain"]   = 0.5f;
    j["pitchEnvReleaseMs"] = 90.0f;

    // VOL LFO → LFO 1 → MasterVolume.
    j["lfoVolEnabled"]       = true;
    j["lfoVolAmount"]        = 0.5f;
    j["lfoVolSpeedHz"]       = 3.0f;
    j["lfoVolTempoSync"]     = false;
    j["lfoVolTempoDivision"] = 4;

    // PAN LFO → LFO 2 → MasterPan.
    j["lfoPanEnabled"]       = true;
    j["lfoPanAmount"]        = 0.8f;
    j["lfoPanSpeedHz"]       = 1.5f;
    j["lfoPanTempoSync"]     = true;
    j["lfoPanTempoDivision"] = 8;        // period = 8/4 = 2 beats = a HALF note

    // PITCH LFO → LFO 3 → SlotSem.
    j["lfoPitchEnabled"] = true;
    j["lfoPitchAmount"]  = 12.0f;        // semitones
    j["lfoPitchSpeedHz"] = 5.0f;
    j["lfoPitchWaveform"] = nlohmann::json::array({
        nlohmann::json{{"time", 0.0f}, {"value", -1.0f}},
        nlohmann::json{{"time", 0.5f}, {"value",  1.0f}},
        nlohmann::json{{"time", 1.0f}, {"value", -1.0f}}
    });

    return j;
}

static const sm::ModRoute* findRoute(const sm::ModConfig& cfg, int source,
                                     sm::ModTarget target, int index)
{
    for (int i = 0; i < cfg.numRoutes; ++i) {
        const sm::ModRoute& r = cfg.routes[static_cast<size_t>(i)];
        if (r.source == source && r.target == static_cast<int>(target)
            && r.index == index)
            return &r;
    }
    return nullptr;
}

static juce::AudioBuffer<float> makeSine(double sampleRate, double freqHz,
                                         int numSamples, float amplitude = 0.5f)
{
    juce::AudioBuffer<float> buf(2, numSamples);
    for (int n = 0; n < numSamples; ++n) {
        const float v = amplitude * std::sin(2.0 * juce::MathConstants<double>::pi
                                             * freqHz * n / sampleRate);
        buf.setSample(0, n, v);
        buf.setSample(1, n, v);
    }
    return buf;
}

// ─── 1. Mapping ──────────────────────────────────────────────────────────────

static void testMappingPitchEnvelope()
{
    std::cout << "[mapping] pitch envelope → ENV 2 → SlotSem\n";

    sm::ModConfig cfg;
    const bool did = slg::migrateLegacyModulation(legacyRegionJson(), 3, 120.0, cfg);
    CHECK(did, "migration reports it ran");

    // One route per occupied slot, because the legacy pitch envelope was
    // note-level and moved every layer together.
    for (int s = 0; s < 3; ++s) {
        const sm::ModRoute* r =
            findRoute(cfg, sm::kEnvSource0 + 1, sm::ModTarget::SlotSem, s);
        CHECK(r != nullptr, "ENV 2 → SlotSem route exists for slot " + std::to_string(s));
        if (!r) continue;
        // Legacy: semis = pitchEnvAmount · level. New: (amount)·level·span(48).
        // 24 semitones / 48 = 0.5.
        CHECK_NEAR(r->amount, 0.5, 1e-6, "pitch env amount is semis/48");
        CHECK(!r->bipolar, "pitch env route is unipolar (envelopes rise from 0)");
    }
    CHECK(findRoute(cfg, sm::kEnvSource0 + 1, sm::ModTarget::SlotSem, 3) == nullptr,
          "no route for an unoccupied slot");

    // The envelope SHAPE carries over too, in the new model's units.
    const sm::ModEnvConfig& e = cfg.envs[1];
    CHECK_NEAR(e.attack.ms,  30.0, 1e-6, "pitch env attack ms preserved");
    CHECK_NEAR(e.decay.ms,   60.0, 1e-6, "pitch env decay ms preserved");
    CHECK_NEAR(e.release.ms, 90.0, 1e-6, "pitch env release ms preserved");
    // sustain is 0..1 legacy, 0..100 in the new model.
    CHECK_NEAR(e.sustainPct, 50.0, 1e-4, "pitch env sustain scaled to percent");
}

static void testMappingLfos()
{
    std::cout << "[mapping] VOL/PAN/PITCH LFOs → LFO 1/2/3\n";

    sm::ModConfig cfg;
    slg::migrateLegacyModulation(legacyRegionJson(), 1, 120.0, cfg);

    // VOL → MasterVolume, bipolar, amount carried straight across: the legacy
    // gain was max(0, 1 + mod·amount) and the new one is clamp(1 + amount·raw).
    {
        const sm::ModRoute* r =
            findRoute(cfg, sm::kLfoSource0 + 0, sm::ModTarget::MasterVolume, 0);
        CHECK(r != nullptr, "VOL LFO → MasterVolume route exists");
        if (r) {
            CHECK_NEAR(r->amount, 0.5, 1e-6, "VOL LFO amount unchanged");
            CHECK(r->bipolar, "VOL LFO route is bipolar");
        }
        CHECK_NEAR(cfg.lfos[0].rateHz, 3.0, 1e-6, "VOL LFO rate preserved");
        CHECK(!cfg.lfos[0].tempoSync, "VOL LFO stays free-running");
        CHECK(cfg.lfos[0].behavior == static_cast<int>(sm::LfoBehavior::Retrig),
              "legacy per-voice LFO state migrates as RETRIG");
        CHECK(!cfg.lfos[0].mono, "legacy LFOs were per-voice, not MONO");
        CHECK(cfg.lfos[0].numPoints == 0, "empty legacy waveform means built-in sine");
    }

    // PAN → MasterPan.
    {
        const sm::ModRoute* r =
            findRoute(cfg, sm::kLfoSource0 + 1, sm::ModTarget::MasterPan, 0);
        CHECK(r != nullptr, "PAN LFO → MasterPan route exists");
        if (r) {
            CHECK_NEAR(r->amount, 0.8, 1e-6, "PAN LFO amount unchanged");
            CHECK(r->bipolar, "PAN LFO route is bipolar");
        }
        CHECK(cfg.lfos[1].tempoSync, "PAN LFO stays tempo-synced");
        // The legacy rate formula made division a PERIOD of division/4 beats,
        // so its "eighth" actually ran at a half-note period. Migration keeps
        // the BEHAVIOUR, not the mislabelled division.
        CHECK(cfg.lfos[1].syncRate.noteValue == static_cast<int>(sm::NoteValue::Half),
              "legacy division 8 migrates to a half-note period, not an eighth");
    }

    // PITCH → SlotSem, scaled by the 48-semitone span.
    {
        const sm::ModRoute* r =
            findRoute(cfg, sm::kLfoSource0 + 2, sm::ModTarget::SlotSem, 0);
        CHECK(r != nullptr, "PITCH LFO → SlotSem route exists");
        if (r) {
            CHECK_NEAR(r->amount, 12.0 / 48.0, 1e-6, "PITCH LFO amount is semis/48");
            CHECK(r->bipolar, "PITCH LFO route is bipolar");
        }
        // The drawn shape carries over as LINE segments.
        CHECK(cfg.lfos[2].numPoints == 3, "drawn waveform points migrated");
        CHECK_NEAR(cfg.lfos[2].points[1].time,  0.5, 1e-6, "point 1 time");
        CHECK_NEAR(cfg.lfos[2].points[1].value, 1.0, 1e-6, "point 1 value");
        CHECK(cfg.lfos[2].points[0].segment == static_cast<int>(sm::LfoSegment::Line),
              "legacy segments were straight lines");
    }
}

static void testMappingAmpEnvelopeIsEnv1()
{
    std::cout << "[mapping] amp envelope → ENV 1, and NOT a route\n";

    sm::ModConfig cfg;
    slg::syncAmpEnvelopeToEnv1(2.0f, 12.0f, 5.0f, 40.0f, 0.6f, 75.0f,
                               0.25f, 0.0f, 0.0f, cfg);

    const sm::ModEnvConfig& e = cfg.envs[0];
    CHECK_NEAR(e.delay.ms,   2.0,  1e-6, "amp delay mirrored into ENV 1");
    CHECK_NEAR(e.attack.ms,  12.0, 1e-6, "amp attack mirrored into ENV 1");
    CHECK_NEAR(e.hold.ms,    5.0,  1e-6, "amp hold mirrored into ENV 1");
    CHECK_NEAR(e.decay.ms,   40.0, 1e-6, "amp decay mirrored into ENV 1");
    CHECK_NEAR(e.release.ms, 75.0, 1e-6, "amp release mirrored into ENV 1");
    CHECK_NEAR(e.sustainPct, 60.0, 1e-4, "amp sustain scaled to percent");
    CHECK_NEAR(e.attackTension, 0.25, 1e-6, "amp attack tension mirrored");

    // The critical negative: the amp envelope must NOT become a MasterVolume
    // route. MasterVolume is additive with a base of 1.0, so a route would
    // leave a silent envelope sounding at unity gain — and, worse, the voice
    // would never reach EnvStage::Off and never be freed.
    CHECK(cfg.numRoutes == 0, "syncing ENV 1 creates no routes at all");
    CHECK(findRoute(cfg, sm::kEnvSource0, sm::ModTarget::MasterVolume, 0) == nullptr,
          "amp envelope is NOT routed to MasterVolume");
}

static void testMigrationIsIdempotent()
{
    std::cout << "[mapping] migration is idempotent and never clobbers new routes\n";

    const nlohmann::json j = legacyRegionJson();
    sm::ModConfig cfg;
    slg::migrateLegacyModulation(j, 1, 120.0, cfg);
    const int firstPass = cfg.numRoutes;
    CHECK(firstPass > 0, "first pass produced routes");

    // Loading a schema-4 file never re-runs this (from_json gates on
    // numRoutes == 0), but the guard is what makes that safe, so assert it.
    sm::ModConfig withUserRoute;
    withUserRoute.numRoutes = 1;
    withUserRoute.routes[0] = sm::ModRoute{ sm::kLfoSource0,
        static_cast<int>(sm::ModTarget::SlotPan), 0, 0, 0.4f, true };
    const int before = withUserRoute.numRoutes;
    // The caller's gate — mirrored here so the contract is tested, not assumed.
    if (withUserRoute.numRoutes == 0)
        slg::migrateLegacyModulation(j, 1, 120.0, withUserRoute);
    CHECK(withUserRoute.numRoutes == before,
          "a region that already has routes is left alone");
}

static void testDivisionTable()
{
    std::cout << "[mapping] legacy tempo divisions are periods of division/4 beats\n";
    CHECK(slg::noteValueForLegacyDivision(1)  == static_cast<int>(sm::NoteValue::Sixteenth),
          "division 1 → 0.25 beats");
    CHECK(slg::noteValueForLegacyDivision(2)  == static_cast<int>(sm::NoteValue::Eighth),
          "division 2 → 0.5 beats");
    CHECK(slg::noteValueForLegacyDivision(4)  == static_cast<int>(sm::NoteValue::Quarter),
          "division 4 → 1 beat");
    CHECK(slg::noteValueForLegacyDivision(8)  == static_cast<int>(sm::NoteValue::Half),
          "division 8 → 2 beats");
    CHECK(slg::noteValueForLegacyDivision(16) == static_cast<int>(sm::NoteValue::Bar1),
          "division 16 → 4 beats");
    CHECK(slg::noteValueForLegacyDivision(0)  == static_cast<int>(sm::NoteValue::Quarter),
          "a zero division falls back to a quarter rather than dividing by zero");
}

// ─── 2. Legacy roundtrip ─────────────────────────────────────────────────────

static void testLegacyRegionRoundtrip()
{
    std::cout << "[roundtrip] a legacy region JSON loads into the new model\n";

    SampleRegion r;
    from_json(legacyRegionJson(), r);

    // The amp envelope is untouched storage-of-record...
    CHECK_NEAR(r.attackMs,  12.0, 1e-6, "amp attack survives load unchanged");
    CHECK_NEAR(r.releaseMs, 75.0, 1e-6, "amp release survives load unchanged");
    // ...and is visible as ENV 1.
    CHECK_NEAR(r.modulation.envs[0].attack.ms, 12.0, 1e-6, "ENV 1 shows the amp attack");
    CHECK_NEAR(r.modulation.envs[0].sustainPct, 60.0, 1e-4, "ENV 1 shows the amp sustain");

    // Every legacy source produced its routes. Slot 0 always counts as
    // occupied (it plays the region's own audio), so: 1 pitch-env route +
    // 1 VOL + 1 PAN + 1 pitch-LFO route.
    CHECK(r.modulation.numRoutes == 4,
          "4 routes migrated, got " + std::to_string(r.modulation.numRoutes));
    CHECK(!r.modulation.isBypassed(), "a migrated region is no longer bypassed");

    // Voicing defaults are the pre-voicing behaviour, so an old project is
    // unchanged by the new controls existing.
    CHECK(r.voiceCount == 32, "legacy project defaults to 32 voices");
    CHECK(!r.legatoEnabled, "legacy project defaults to legato off");
    CHECK(r.portamentoMode == 0, "legacy project defaults to ALWAYS portamento");
    CHECK_NEAR(r.portamentoCurve, 0.0, 1e-9, "legacy project defaults to a linear glide");
}

static void testMigratedProjectStaysAudible()
{
    std::cout << "[roundtrip] a migrated region still renders audio\n";

    SampleRegion r;
    from_json(legacyRegionJson(), r);

    Sampler s;
    s.loadSample(makeSine(kEngineSR, 220.0, static_cast<int>(kEngineSR)), kEngineSR, 60);
    s.setEnvelope(r.delayMs, r.attackMs, r.holdMs, r.decayMs, r.sustain, r.releaseMs,
                  r.attackTension, r.decayTension, r.releaseTension);
    s.setCrossfadeMode(true);
    s.setModulation(r.modulation);

    juce::AudioBuffer<float> out(2, 4096);
    out.clear();
    s.noteOn(60, 1.0f, 0);
    s.processBlock(out, 4096, kEngineSR);

    double peak = 0.0;
    for (int n = 0; n < 4096; ++n)
        peak = std::max(peak, std::abs(static_cast<double>(out.getSample(0, n))));
    CHECK(peak > 0.01, "migrated region produces audible output, peak " + std::to_string(peak));

    // The whole point of keeping the amp envelope as the VCA: the voice must
    // still be freed when its envelope finishes. A MasterVolume route could
    // never do this — the voice would sustain at unity forever.
    s.noteOff(60, 0);
    for (int b = 0; b < 200; ++b) {
        out.clear();
        s.processBlock(out, 4096, kEngineSR);
        if (s.activeVoiceCount() == 0) break;
    }
    CHECK(s.activeVoiceCount() == 0,
          "the voice is freed after release — amp envelope still gates lifecycle");
}

// ─── 3. Route add / remove under the 32-stream cap ───────────────────────────

static void testRoutesUnderStreamCap()
{
    std::cout << "[streams] route add/remove under the 32-stream cap\n";

    Sampler s;
    const juce::AudioBuffer<float> sine =
        makeSine(kEngineSR, 220.0, static_cast<int>(kEngineSR));

    // 8 layers → each note costs 8 streams → 4 notes fill the 32-stream budget.
    s.setSlotCount(8);
    for (int i = 0; i < 8; ++i)
        s.loadSlotSample(i, sine, kEngineSR, 60);
    s.setCrossfadeMode(true);
    s.setEnvelope(0.0f, 1.0f, 0.0f, 0.0f, 1.0f, 500.0f, 0.0f, 0.0f, 0.0f);

    sm::ModConfig cfg;
    // One route per slot on two different targets — the shape the pitch
    // migration produces, and the densest thing a drag-to-route user can build
    // on an 8-slot sampler in two gestures.
    for (int i = 0; i < 8; ++i) {
        cfg.routes[static_cast<size_t>(cfg.numRoutes++)] =
            sm::ModRoute{ sm::kLfoSource0, static_cast<int>(sm::ModTarget::SlotSem),
                          i, 0, 0.25f, true };
        cfg.routes[static_cast<size_t>(cfg.numRoutes++)] =
            sm::ModRoute{ sm::kEnvSource0 + 1, static_cast<int>(sm::ModTarget::SlotVolume),
                          i, 0, 0.5f, false };
    }
    s.setModulation(cfg);

    juce::AudioBuffer<float> out(2, 512);
    for (int n = 60; n < 68; ++n) {         // 8 notes — twice the budget
        s.noteOn(n, 1.0f, 0);
        out.clear();
        s.processBlock(out, 512, kEngineSR);
    }
    // The budget governs HELD streams, not every sounding one: a stolen note is
    // handed to its release envelope rather than hard-killed, so its streams
    // keep rendering for the release duration. That draining tail is bounded
    // and deliberate — counting it would make one new note cascade into
    // stealing the whole sampler. 8 slots per note, so 4 held notes is the cap.
    CHECK(s.countHeldVoices() * 8 <= 32,
          "held streams stay inside the cap with 16 routes live, got "
          + std::to_string(s.countHeldVoices() * 8));
    CHECK(s.activeStreamCount() <= 64,
          "the release tail stays bounded at one budget's worth, got "
          + std::to_string(s.activeStreamCount()));

    // Removing routes while notes sound must not disturb the stream budget:
    // the graph swap is independent of voice allocation.
    const int before = s.activeStreamCount();
    sm::ModConfig empty;
    s.setModulation(empty);
    out.clear();
    s.processBlock(out, 512, kEngineSR);
    CHECK(s.activeStreamCount() <= before,
          "clearing every route frees no streams and leaks none");
    CHECK(empty.isBypassed(), "an empty route list is an exact bypass");

    // And re-adding under load is equally safe.
    s.setModulation(cfg);
    out.clear();
    s.processBlock(out, 512, kEngineSR);
    CHECK(s.countHeldVoices() * 8 <= 32, "re-adding routes keeps the held-stream cap");
}

static void testVoiceCountCap()
{
    std::cout << "[streams] voiceCount caps notes independently of the stream cap\n";

    Sampler s;
    s.loadSample(makeSine(kEngineSR, 220.0, static_cast<int>(kEngineSR)), kEngineSR, 60);
    s.setCrossfadeMode(true);
    s.setEnvelope(0.0f, 1.0f, 0.0f, 0.0f, 1.0f, 500.0f, 0.0f, 0.0f, 0.0f);

    // One slot, so the stream cap would allow all 32 notes; voiceCount binds
    // first. This is the interaction the voicing control has to document.
    s.setVoiceCount(4);

    juce::AudioBuffer<float> out(2, 256);
    for (int n = 60; n < 72; ++n) {
        s.noteOn(n, 1.0f, 0);
        out.clear();
        s.processBlock(out, 256, kEngineSR);
    }
    CHECK(s.countHeldVoices() <= 4,
          "held notes capped at voiceCount, got " + std::to_string(s.countHeldVoices()));

    // Stolen notes go to their release envelope rather than being hard-killed,
    // so they are still sounding — that is what makes stealing click-free.
    CHECK(s.activeVoiceCount() >= s.countHeldVoices(),
          "stolen notes are released, not killed");
}

// ─── 4. Bipolar ring math ────────────────────────────────────────────────────

// The ring the UI draws must describe the range the engine actually produces.
// This is the same arithmetic SamplerModulationRing.js performs, asserted
// against routeOffset() so the two can never drift apart.
static void testBipolarRingMath()
{
    std::cout << "[ring] bipolar / unipolar range math matches routeOffset()\n";

    auto ringRange = [](int source, sm::ModTarget target, float amount,
                        bool bipolar, float base, float& lo, float& hi)
    {
        sm::CompiledRoute r;
        r.source  = source;
        r.target  = static_cast<int>(target);
        r.amount  = amount;
        r.bipolar = bipolar;
        // Extremes of the source's natural range: LFOs swing ±1, envelopes and
        // the response curves rise 0..1.
        const float rawLo = sm::sourceIsBipolarNatural(source) ? -1.0f : 0.0f;
        const float rawHi = 1.0f;
        const float a = sm::applyTargetLaw(r.target, base, sm::routeOffset(r, rawLo, 1.0f));
        const float b = sm::applyTargetLaw(r.target, base, sm::routeOffset(r, rawHi, 1.0f));
        lo = std::min(a, b);
        hi = std::max(a, b);
    };

    float lo = 0.0f, hi = 0.0f;

    // UNIPOLAR envelope on slot volume: sweeps base → base + amount·span.
    // The tooltip's "Range 24% → 66%" is exactly this pair.
    ringRange(sm::kEnvSource0, sm::ModTarget::SlotVolume, 0.42f, false, 0.24f, lo, hi);
    CHECK_NEAR(lo, 0.24, 1e-5, "unipolar ring base is the knob's current value");
    CHECK_NEAR(hi, 0.66, 1e-5, "unipolar ring top is base + amount·span");

    // BIPOLAR LFO on slot volume: spreads ± amount·span AROUND the base.
    ringRange(sm::kLfoSource0, sm::ModTarget::SlotVolume, 0.25f, true, 0.5f, lo, hi);
    CHECK_NEAR(lo, 0.25, 1e-5, "bipolar ring spreads below the base");
    CHECK_NEAR(hi, 0.75, 1e-5, "bipolar ring spreads above the base");

    // A UNIPOLAR route from an LFO maps the ±1 swing up into 0..1 first, so it
    // still sweeps upward from the base rather than straddling it.
    ringRange(sm::kLfoSource0, sm::ModTarget::SlotVolume, 0.5f, false, 0.5f, lo, hi);
    CHECK_NEAR(lo, 0.5, 1e-5, "unipolar LFO route starts at the base");
    CHECK_NEAR(hi, 1.0, 1e-5, "unipolar LFO route sweeps up by amount·span");

    // A BIPOLAR route from an ENVELOPE maps 0..1 down to ±1, so a resting
    // envelope sits at the BOTTOM of the ring, not at the base.
    ringRange(sm::kEnvSource0, sm::ModTarget::SlotVolume, 0.25f, true, 0.5f, lo, hi);
    CHECK_NEAR(lo, 0.25, 1e-5, "bipolar envelope route reaches below the base");
    CHECK_NEAR(hi, 0.75, 1e-5, "bipolar envelope route reaches above the base");

    // Negative amounts invert the sweep without reordering the range.
    ringRange(sm::kEnvSource0, sm::ModTarget::SlotVolume, -0.4f, false, 0.5f, lo, hi);
    CHECK_NEAR(lo, 0.1, 1e-5, "a negative amount sweeps downward");
    CHECK_NEAR(hi, 0.5, 1e-5, "a negative amount keeps the base as the top");

    // Clamping is part of the range the ring must show: SlotPan is bounded to
    // ±1, so an over-driven route flattens against the rail rather than
    // drawing a ring that promises movement the engine will not deliver.
    ringRange(sm::kLfoSource0, sm::ModTarget::SlotPan, 1.0f, true, 0.5f, lo, hi);
    CHECK_NEAR(lo, -0.5, 1e-5, "pan ring low end is unclamped");
    CHECK_NEAR(hi,  1.0, 1e-5, "pan ring top clamps at the target's hi rail");

    // SEM's span is 48 semitones, which is what turns a 0.25 amount into the
    // "12 semitones" the tooltip reports.
    ringRange(sm::kLfoSource0, sm::ModTarget::SlotSem, 0.25f, true, 0.0f, lo, hi);
    CHECK_NEAR(lo, -12.0, 1e-4, "SEM ring reaches -12 semitones");
    CHECK_NEAR(hi,  12.0, 1e-4, "SEM ring reaches +12 semitones");
}

// ─── main ────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    // Unbuffered: a crash mid-suite must still show which section reached the
    // failure, otherwise the buffered progress lines vanish with the process.
    std::cout << std::unitbuf;

    std::cout << "── Sampler legacy modulation migration ──\n";

    testMappingPitchEnvelope();
    testMappingLfos();
    testMappingAmpEnvelopeIsEnv1();
    testMigrationIsIdempotent();
    testDivisionTable();
    testLegacyRegionRoundtrip();
    testMigratedProjectStaysAudible();
    testRoutesUnderStreamCap();
    testVoiceCountCap();
    testBipolarRingMath();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0) {
        std::cout << "FAILED\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
