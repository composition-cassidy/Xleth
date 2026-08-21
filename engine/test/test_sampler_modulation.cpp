// test_sampler_modulation.cpp — Self-verification for the sampler modulation
// system: 6 envelopes, 6 LFOs, VELO/NOTE response curves and the route graph.
//
// Build: see engine/CMakeLists.txt target "test_sampler_modulation"
// Run:   test_sampler_modulation.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: ..." and exits 1
//
// Two levels are exercised deliberately:
//   * the pure evaluators in SamplerModulation.h, driven directly — that is
//     where timing, shape and graph-ordering claims can be asserted exactly,
//     with no rendering in the way;
//   * a real Sampler rendering real audio, which is what proves the routes
//     actually reach the render loop.

#include "audio/Sampler.h"
#include "audio/SamplerModulation.h"
#include "model/SampleRegion.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <cmath>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

namespace sm = xleth::sampmod;

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
    CHECK(std::abs(static_cast<double>(a) - static_cast<double>(b)) < (tol), \
          msg << " (got " << (a) << ", want " << (b) << ")")

static constexpr double kEngineSR  = 48000.0;
static constexpr double kCtrlDt    = static_cast<double>(sm::kControlBlockSamples) / kEngineSR;

// ─── Config builders ─────────────────────────────────────────────────────────

// A shape that holds one constant value, so the ONLY thing moving the output
// is the depth envelope (RISE / DELAY) or the output amount. Indispensable for
// isolating those from the shape itself.
static sm::ModLfoConfig constantLfo(float value)
{
    sm::ModLfoConfig c;
    c.numPoints = 1;
    c.points[0].value = value;
    c.rateHz = 1.0f;
    return c;
}

// A square shape: -1 for the first half of the cycle, +1 for the second.
// Both segments are STEP, so at smooth = 0 the plateaus are exactly flat and
// the two levels are exactly ±1 — which makes phase and lifecycle assertions
// exact rather than approximate.
static sm::ModLfoConfig squareLfo(float rateHz)
{
    sm::ModLfoConfig c;
    c.numPoints = 2;
    c.points[0] = sm::LfoPoint{ 0.0f,  -1.0f, static_cast<int>(sm::LfoSegment::Step), 0.0f };
    c.points[1] = sm::LfoPoint{ 0.5f,   1.0f, static_cast<int>(sm::LfoSegment::Step), 0.0f };
    c.rateHz = rateHz;
    return c;
}

static sm::ModRoute route(int source, sm::ModTarget target, int index,
                          float amount, bool bipolar = false, int stage = 0)
{
    sm::ModRoute r;
    r.source  = source;
    r.target  = static_cast<int>(target);
    r.index   = index;
    r.stage   = stage;
    r.amount  = amount;
    r.bipolar = bipolar;
    return r;
}

static void addRoute(sm::ModConfig& c, const sm::ModRoute& r)
{
    if (c.numRoutes < sm::kMaxRoutes) c.routes[static_cast<size_t>(c.numRoutes++)] = r;
}

// ─── Audio helpers ───────────────────────────────────────────────────────────

static juce::AudioBuffer<float> makeSine(double sampleRate, double freqHz,
                                         int numSamples, float amplitude = 0.5f)
{
    juce::AudioBuffer<float> buf(2, numSamples);
    const double w = 2.0 * juce::MathConstants<double>::pi * freqHz / sampleRate;
    for (int i = 0; i < numSamples; ++i) {
        const float s = static_cast<float>(amplitude * std::sin(w * i));
        buf.setSample(0, i, s);
        buf.setSample(1, i, s);
    }
    return buf;
}

static int countZeroCrossings(const juce::AudioBuffer<float>& buf, int start, int len)
{
    int zc = 0;
    const float* d = buf.getReadPointer(0);
    const int end = std::min(start + len, buf.getNumSamples());
    for (int i = start + 1; i < end; ++i)
        if ((d[i - 1] >= 0.0f) != (d[i] >= 0.0f)) ++zc;
    return zc;
}

static double rmsRange(const juce::AudioBuffer<float>& buf, int ch, int start, int len)
{
    const int end = std::min(start + len, buf.getNumSamples());
    if (end <= start) return 0.0;
    const float* d = buf.getReadPointer(ch);
    double acc = 0.0;
    for (int i = start; i < end; ++i) acc += static_cast<double>(d[i]) * d[i];
    return std::sqrt(acc / (end - start));
}

// A sampler with one 2-second sine loaded into slot 0, sustained so notes hold.
static void prepareSampler(Sampler& s, double freqHz = 220.0)
{
    s.loadSample(makeSine(kEngineSR, freqHz, static_cast<int>(kEngineSR * 2.0)),
                 kEngineSR, 60);
    s.setCrossfadeMode(true);
    s.setEnvelope(0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 5.0f, 0.0f, 0.0f, 0.0f);
    s.setBPM(120.0);
}

static juce::AudioBuffer<float> render(Sampler& s, int numSamples, int blockSize = 512)
{
    juce::AudioBuffer<float> out(2, numSamples);
    out.clear();
    int done = 0;
    while (done < numSamples) {
        const int n = std::min(blockSize, numSamples - done);
        juce::AudioBuffer<float> sub(out.getArrayOfWritePointers(), 2, done, n);
        s.processBlock(sub, n, kEngineSR);
        done += n;
    }
    return out;
}

// ─── ENV timing: milliseconds ────────────────────────────────────────────────

// Drive one envelope at control rate and report the elapsed time at which it
// first reaches full level. Returns seconds.
static double timeToFullAttack(const sm::ModEnvConfig& c, double bpm, int maxBlocks = 400000)
{
    sm::ModEnvState st{ static_cast<int>(sm::EnvStage::Delay), 0.0f, 0.0f, 0.0 };
    std::array<float, sm::kNumEnvStages> noOffset{};
    for (int i = 0; i < maxBlocks; ++i) {
        const float lvl = sm::advanceModEnv(c, st, noOffset, bpm, kCtrlDt);
        if (lvl >= 0.9999f) return static_cast<double>(i) * kCtrlDt;
    }
    return -1.0;
}

static void testEnvTimingMilliseconds()
{
    std::cout << "ENV timing — milliseconds\n";

    sm::ModEnvConfig c;
    c.attack.ms  = 100.0f;
    c.sustainPct = 100.0f;

    const double t = timeToFullAttack(c, 120.0);
    // Two control blocks of slack: the DELAY stage consumes one evaluation even
    // at zero length, and the level is only clamped to 1 on the block that
    // crosses the boundary.
    CHECK_NEAR(t, 0.100, 2.0 * kCtrlDt + 1e-9, "100 ms attack completes at 100 ms");

    c.attack.ms = 500.0f;
    CHECK_NEAR(timeToFullAttack(c, 120.0), 0.500, 2.0 * kCtrlDt + 1e-9,
               "500 ms attack completes at 500 ms");

    // BPM is irrelevant while tempoSync is off — that is the whole point of
    // storing both representations side by side.
    CHECK_NEAR(timeToFullAttack(c, 240.0), 0.500, 2.0 * kCtrlDt + 1e-9,
               "ms-mode attack ignores BPM");

    // Delay pushes the whole envelope back by exactly its own length.
    c.attack.ms = 100.0f;
    c.delay.ms  = 200.0f;
    CHECK_NEAR(timeToFullAttack(c, 120.0), 0.300, 3.0 * kCtrlDt + 1e-9,
               "200 ms delay + 100 ms attack completes at 300 ms");
}

static void testEnvTimingBpmSync()
{
    std::cout << "ENV timing — BPM sync\n";

    sm::ModEnvConfig c;
    c.tempoSync = true;
    c.attack.noteValue = static_cast<int>(sm::NoteValue::Quarter);   // 1 beat
    c.sustainPct = 100.0f;

    // 120 BPM → one beat = 0.5 s. 240 BPM → 0.25 s. Halving the length by
    // doubling the tempo is the claim that separates a real sync from a
    // millisecond value with a musical label on it.
    CHECK_NEAR(timeToFullAttack(c, 120.0), 0.500, 2.0 * kCtrlDt + 1e-9,
               "1/4 attack at 120 BPM = 500 ms");
    CHECK_NEAR(timeToFullAttack(c, 240.0), 0.250, 2.0 * kCtrlDt + 1e-9,
               "1/4 attack at 240 BPM = 250 ms");

    c.attack.noteValue = static_cast<int>(sm::NoteValue::Eighth);    // 0.5 beat
    CHECK_NEAR(timeToFullAttack(c, 120.0), 0.250, 2.0 * kCtrlDt + 1e-9,
               "1/8 attack at 120 BPM = 250 ms");

    // TRIPLET is x2/3, DOTTED is x3/2.
    c.attack.noteValue = static_cast<int>(sm::NoteValue::Quarter);
    c.attack.triplet   = true;
    CHECK_NEAR(timeToFullAttack(c, 120.0), 0.500 * 2.0 / 3.0, 2.0 * kCtrlDt + 1e-9,
               "1/4 triplet at 120 BPM = 333 ms");

    c.attack.triplet = false;
    c.attack.dotted  = true;
    CHECK_NEAR(timeToFullAttack(c, 120.0), 0.750, 2.0 * kCtrlDt + 1e-9,
               "dotted 1/4 at 120 BPM = 750 ms");

    // The whole note-value table, end to end.
    CHECK_NEAR(sm::noteValueBeats(static_cast<int>(sm::NoteValue::Bars32), false, false),
               128.0, 1e-9, "32 bars = 128 beats");
    CHECK_NEAR(sm::noteValueBeats(static_cast<int>(sm::NoteValue::TwoFiftySixth), false, false),
               0.015625, 1e-9, "1/256 = 1/64 beat");
}

static void testEnvSustainAndRelease()
{
    std::cout << "ENV sustain + release\n";

    sm::ModEnvConfig c;
    c.attack.ms  = 0.0f;
    c.decay.ms   = 100.0f;
    c.sustainPct = 50.0f;
    c.release.ms = 100.0f;

    sm::ModEnvState st{ static_cast<int>(sm::EnvStage::Delay), 0.0f, 0.0f, 0.0 };
    std::array<float, sm::kNumEnvStages> noOffset{};

    // Run past the decay: the level must settle at exactly the sustain level.
    for (int i = 0; i < 400; ++i) sm::advanceModEnv(c, st, noOffset, 120.0, kCtrlDt);
    CHECK_NEAR(st.level, 0.5f, 1e-4, "sustain settles at sustainPct");
    CHECK(st.stage == static_cast<int>(sm::EnvStage::Sustain), "envelope reaches Sustain");

    // Release from the sustain level, reaching zero after the release time.
    st.releaseStart = st.level;
    st.stage        = static_cast<int>(sm::EnvStage::Release);
    st.posSec       = 0.0;
    int blocks = 0;
    while (st.stage != static_cast<int>(sm::EnvStage::Off) && blocks < 100000) {
        sm::advanceModEnv(c, st, noOffset, 120.0, kCtrlDt);
        ++blocks;
    }
    CHECK_NEAR(static_cast<double>(blocks) * kCtrlDt, 0.100, 2.0 * kCtrlDt + 1e-9,
               "100 ms release reaches Off at 100 ms");
    CHECK_NEAR(st.level, 0.0f, 1e-6, "release ends at zero");
}

// ─── LFO lifecycle: FREE / RETRIG / ENVELOPE ─────────────────────────────────

static void testLfoEnvelopeBehaviorHolds()
{
    std::cout << "LFO lifecycle — ENVELOPE plays once and holds\n";

    sm::ModLfoConfig c = squareLfo(4.0f);          // one cycle = 250 ms
    c.behavior = static_cast<int>(sm::LfoBehavior::Envelope);

    sm::ModLfoState st;
    sm::ResolvedSrcParams p{};

    // First half of the single pass sits on the -1 plateau...
    float v = 0.0f;
    for (int i = 0; i < 100; ++i) v = sm::advanceModLfo(c, st, p, 120.0, kCtrlDt);
    CHECK_NEAR(v, -1.0f, 1e-5, "ENVELOPE first half plateau = -1");

    // ...the second half on the +1 plateau...
    for (int i = 0; i < 150; ++i) v = sm::advanceModLfo(c, st, p, 120.0, kCtrlDt);
    CHECK_NEAR(v, 1.0f, 1e-5, "ENVELOPE second half plateau = +1");

    // ...and once the pass has finished the value never changes again, however
    // long the note is held.
    for (int i = 0; i < 5000; ++i) {
        const float held = sm::advanceModLfo(c, st, p, 120.0, kCtrlDt);
        if (std::abs(held - 1.0f) > 1e-5f) {
            CHECK(false, "ENVELOPE value moved after the single pass finished");
            break;
        }
    }
    CHECK(st.done, "ENVELOPE marks itself done after one pass");
    ++g_passed;   // the hold loop above completed without tripping
}

static void testLfoRetrigLoops()
{
    std::cout << "LFO lifecycle — RETRIG loops\n";

    sm::ModLfoConfig c = squareLfo(4.0f);
    c.behavior = static_cast<int>(sm::LfoBehavior::Retrig);

    sm::ModLfoState st;
    sm::ResolvedSrcParams p{};

    int lowSeen = 0, highSeen = 0;
    // 3 seconds = 12 cycles: a looping LFO must visit both plateaus many times,
    // which is precisely what the ENVELOPE behaviour above must NOT do.
    for (int i = 0; i < static_cast<int>(3.0 / kCtrlDt); ++i) {
        const float v = sm::advanceModLfo(c, st, p, 120.0, kCtrlDt);
        if (v < -0.99f) ++lowSeen;
        if (v >  0.99f) ++highSeen;
    }
    CHECK(lowSeen  > 1000, "RETRIG keeps returning to the low plateau");
    CHECK(highSeen > 1000, "RETRIG keeps returning to the high plateau");
}

static void testLfoFreeRunsWithoutNotes()
{
    std::cout << "LFO lifecycle — FREE runs with no notes sounding\n";

    Sampler s;
    prepareSampler(s);

    sm::ModConfig cfg;
    cfg.lfos[0] = squareLfo(4.0f);
    cfg.lfos[0].behavior = static_cast<int>(sm::LfoBehavior::Free);
    // A route is what makes the graph non-null; its target is irrelevant here.
    addRoute(cfg, route(sm::kLfoSource0, sm::ModTarget::SlotVolume, 0, 0.5f));
    s.setModulation(cfg);

    // No note is ever triggered. A FREE instance is transport-anchored, not
    // note-anchored, so it must still be moving.
    bool sawLow = false, sawHigh = false;
    juce::AudioBuffer<float> out(2, 512);
    for (int b = 0; b < 400; ++b) {
        out.clear();
        s.processBlock(out, 512, kEngineSR);
        const float v = s.debugModGlobalSource(sm::kLfoSource0);
        if (v < -0.99f) sawLow  = true;
        if (v >  0.99f) sawHigh = true;
    }
    CHECK(sawLow && sawHigh, "FREE LFO advances with zero active voices");
    CHECK(s.activeVoiceCount() == 0, "no voices were created by the FREE test");
}

static void testRetrigResetsPerVoice()
{
    std::cout << "LFO lifecycle — RETRIG resets phase at note-on\n";

    Sampler s;
    prepareSampler(s);

    sm::ModConfig cfg;
    cfg.lfos[0] = squareLfo(4.0f);
    cfg.lfos[0].behavior = static_cast<int>(sm::LfoBehavior::Retrig);
    addRoute(cfg, route(sm::kLfoSource0, sm::ModTarget::SlotVolume, 0, 0.5f));
    s.setModulation(cfg);

    // Note 1 starts now; a quarter of a cycle later it is still on the low
    // plateau. Note 2 starts THEN — and must also read the low plateau, because
    // a RETRIG instance is per-voice and starts from phase zero.
    s.noteOn(60, 1.0f);
    render(s, static_cast<int>(kEngineSR * 0.06));      // 60 ms into a 250 ms cycle
    const int v1 = s.debugFirstActiveVoiceIndex();
    CHECK(v1 >= 0, "first voice is active");

    s.noteOn(67, 1.0f);
    render(s, 64);
    // Find the second voice: the one that is not v1.
    int v2 = -1;
    for (int i = 0; i < 32; ++i)
        if (i != v1 && s.debugVoiceStreamCount(i) > 0) { v2 = i; break; }
    CHECK(v2 >= 0, "second voice is active");

    if (v2 >= 0) {
        const float a = s.debugModVoiceSource(v1, sm::kLfoSource0);
        const float b = s.debugModVoiceSource(v2, sm::kLfoSource0);
        CHECK_NEAR(a, -1.0f, 1e-4, "voice 1 still on the low plateau");
        CHECK_NEAR(b, -1.0f, 1e-4, "voice 2 restarted on the low plateau");
    }

    // Let voice 1 cross into the second half while voice 2 has not: the two
    // per-voice instances must then DISAGREE, which is what proves they are
    // genuinely separate instances rather than one shared one.
    render(s, static_cast<int>(kEngineSR * 0.10));
    if (v2 >= 0) {
        const float a = s.debugModVoiceSource(v1, sm::kLfoSource0);
        const float b = s.debugModVoiceSource(v2, sm::kLfoSource0);
        CHECK(std::abs(a - b) > 1.0f, "per-voice RETRIG instances diverge");
    }
}

static void testMonoSharesOneInstance()
{
    std::cout << "LFO lifecycle — MONO shares one instance\n";

    Sampler s;
    prepareSampler(s);

    sm::ModConfig cfg;
    cfg.lfos[0] = squareLfo(4.0f);
    cfg.lfos[0].behavior = static_cast<int>(sm::LfoBehavior::Retrig);
    cfg.lfos[0].mono     = true;
    addRoute(cfg, route(sm::kLfoSource0, sm::ModTarget::SlotVolume, 0, 0.5f));
    s.setModulation(cfg);

    // MONO makes even a RETRIG source global, so the two notes below read the
    // SAME instance no matter how far apart they start.
    s.noteOn(60, 1.0f);
    render(s, static_cast<int>(kEngineSR * 0.16));
    s.noteOn(67, 1.0f);
    render(s, 64);

    const int v1 = s.debugFirstActiveVoiceIndex();
    int v2 = -1;
    for (int i = 0; i < 32; ++i)
        if (i != v1 && s.debugVoiceStreamCount(i) > 0) { v2 = i; break; }

    CHECK(v2 >= 0, "second MONO-test voice is active");
    if (v1 >= 0 && v2 >= 0) {
        CHECK_NEAR(s.debugModVoiceSource(v1, sm::kLfoSource0),
                   s.debugModVoiceSource(v2, sm::kLfoSource0), 1e-5,
                   "MONO: both voices read the same instance");
    }
}

// ─── RISE / DELAY / PHASE ────────────────────────────────────────────────────

static void testLfoDelayAndRise()
{
    std::cout << "LFO — DELAY and RISE\n";

    // Constant +1 shape, so the output IS the depth envelope.
    {
        sm::ModLfoConfig c = constantLfo(1.0f);
        c.delay.ms = 100.0f;

        sm::ModLfoState st;
        sm::ResolvedSrcParams p{};
        double t = 0.0;
        double firstNonZero = -1.0;
        for (int i = 0; i < 1000; ++i) {
            const float v = sm::advanceModLfo(c, st, p, 120.0, kCtrlDt);
            if (v > 0.0f && firstNonZero < 0.0) firstNonZero = t;
            if (t < 0.099 && v != 0.0f) { CHECK(false, "DELAY leaked before its time"); break; }
            t += kCtrlDt;
        }
        CHECK_NEAR(firstNonZero, 0.100, 2.0 * kCtrlDt + 1e-9,
                   "DELAY holds depth at zero for exactly 100 ms");

        // And the jump is a JUMP: the first non-zero sample is already full
        // depth, not the start of a ramp.
        sm::ModLfoState st2;
        double t2 = 0.0;
        for (int i = 0; i < 1000; ++i) {
            const float v = sm::advanceModLfo(c, st2, p, 120.0, kCtrlDt);
            if (v > 0.0f) {
                CHECK_NEAR(v, 1.0f, 1e-5, "DELAY jumps straight to 100% depth");
                break;
            }
            t2 += kCtrlDt;
        }
    }

    // RISE is a LINEAR ramp: half the rise time must give half the depth.
    {
        sm::ModLfoConfig c = constantLfo(1.0f);
        c.rise.ms = 200.0f;

        sm::ModLfoState st;
        sm::ResolvedSrcParams p{};
        float at50ms = 0.0f, at100ms = 0.0f, at150ms = 0.0f, at400ms = 0.0f;
        for (int i = 0; i < 1000; ++i) {
            const float v = sm::advanceModLfo(c, st, p, 120.0, kCtrlDt);
            const double t = static_cast<double>(i) * kCtrlDt;
            if (at50ms  == 0.0f && t >= 0.050) at50ms  = v;
            if (at100ms == 0.0f && t >= 0.100) at100ms = v;
            if (at150ms == 0.0f && t >= 0.150) at150ms = v;
            if (at400ms == 0.0f && t >= 0.400) at400ms = v;
        }
        CHECK_NEAR(at50ms,  0.25f, 0.01f, "RISE at 25% of its length = 25% depth");
        CHECK_NEAR(at100ms, 0.50f, 0.01f, "RISE at 50% of its length = 50% depth");
        CHECK_NEAR(at150ms, 0.75f, 0.01f, "RISE at 75% of its length = 75% depth");
        CHECK_NEAR(at400ms, 1.00f, 1e-4f, "RISE saturates at 100% depth");
    }

    // DELAY and RISE compose by multiplication: nothing during the wait, then
    // whatever the ramp has already reached.
    {
        sm::ModLfoConfig c = constantLfo(1.0f);
        c.delay.ms = 100.0f;
        c.rise.ms  = 200.0f;

        sm::ModLfoState st;
        sm::ResolvedSrcParams p{};
        float at50 = -1.0f, at100 = -1.0f;
        for (int i = 0; i < 1000; ++i) {
            const float v = sm::advanceModLfo(c, st, p, 120.0, kCtrlDt);
            const double t = static_cast<double>(i) * kCtrlDt;
            if (at50  < 0.0f && t >= 0.050) at50  = v;
            if (at100 < 0.0f && t >= 0.105) at100 = v;
        }
        CHECK_NEAR(at50, 0.0f, 1e-6, "DELAY still gating at 50 ms");
        CHECK_NEAR(at100, 0.525f, 0.02f, "after DELAY, RISE is already half-way up");
    }
}

static void testLfoPhaseOffset()
{
    std::cout << "LFO — PHASE start offset\n";

    sm::ResolvedSrcParams p{};

    // The square shape sits at -1 for phase < 0.5 and +1 above it, so PHASE is
    // directly readable from the very first evaluated block.
    {
        sm::ModLfoConfig c = squareLfo(0.5f);       // slow: 2 s per cycle
        c.phase = 0.0f;
        sm::ModLfoState st;
        CHECK_NEAR(sm::advanceModLfo(c, st, p, 120.0, kCtrlDt), -1.0f, 1e-5,
                   "PHASE 0% starts on the low plateau");
    }
    {
        sm::ModLfoConfig c = squareLfo(0.5f);
        c.phase = 25.0f;
        sm::ModLfoState st;
        CHECK_NEAR(sm::advanceModLfo(c, st, p, 120.0, kCtrlDt), -1.0f, 1e-5,
                   "PHASE 25% is still inside the low half");
    }
    {
        sm::ModLfoConfig c = squareLfo(0.5f);
        c.phase = 75.0f;
        sm::ModLfoState st;
        CHECK_NEAR(sm::advanceModLfo(c, st, p, 120.0, kCtrlDt), 1.0f, 1e-5,
                   "PHASE 75% starts on the high plateau");
    }
    // 100% wraps back to 0%.
    {
        sm::ModLfoConfig c = squareLfo(0.5f);
        c.phase = 100.0f;
        sm::ModLfoState st;
        CHECK_NEAR(sm::advanceModLfo(c, st, p, 120.0, kCtrlDt), -1.0f, 1e-5,
                   "PHASE 100% wraps to the cycle start");
    }
}

static void testLfoBpmRateIsAPeriod()
{
    std::cout << "LFO — BPM-synced rate is a PERIOD\n";

    sm::ModLfoConfig c = squareLfo(1.0f);
    c.tempoSync = true;
    c.syncRate.noteValue = static_cast<int>(sm::NoteValue::Quarter);   // 1 beat

    // At 120 BPM one beat is 0.5 s, so a 1/4-synced LFO completes exactly two
    // cycles per second. Counting low→high transitions is a direct read of the
    // cycle count and would come out four times too high if the note value
    // were treated as a frequency multiplier instead of a period.
    sm::ModLfoState st;
    sm::ResolvedSrcParams p{};
    int rises = 0;
    float prev = -1.0f;
    for (int i = 0; i < static_cast<int>(2.0 / kCtrlDt); ++i) {
        const float v = sm::advanceModLfo(c, st, p, 120.0, kCtrlDt);
        if (prev < 0.0f && v > 0.0f) ++rises;
        prev = v;
    }
    CHECK(rises == 4, "1/4 at 120 BPM completes 4 cycles in 2 seconds (got "
                      << rises << ")");
}

// ─── SMOOTH ──────────────────────────────────────────────────────────────────

static void testSmoothPreservesPlateaus()
{
    std::cout << "LFO — SMOOTH preserves plateaus\n";

    // A shape with a genuine plateau (two points at the same value) followed by
    // a real move. A naive low-pass over the rendered shape would bleed the
    // move backwards into the plateau; morphing segment curvature cannot.
    sm::ModLfoConfig c;
    c.numPoints = 3;
    c.points[0] = sm::LfoPoint{ 0.00f,  0.5f, static_cast<int>(sm::LfoSegment::Line), 0.0f };
    c.points[1] = sm::LfoPoint{ 0.50f,  0.5f, static_cast<int>(sm::LfoSegment::Line), 0.0f };
    c.points[2] = sm::LfoPoint{ 0.75f, -1.0f, static_cast<int>(sm::LfoSegment::Line), 0.0f };

    for (float smooth : { 0.0f, 0.25f, 0.5f, 0.75f, 1.0f }) {
        bool flat = true;
        for (int i = 0; i <= 200; ++i) {
            const float phase = 0.5f * static_cast<float>(i) / 200.0f;   // [0, 0.5]
            const float v = sm::evalLfoShape(c, phase, smooth);
            if (std::abs(v - 0.5f) > 1e-6f) { flat = false; break; }
        }
        CHECK(flat, "plateau stays exactly flat at smooth=" << smooth);
    }

    // The same for a STEP plateau, which is the case a filter would smear worst.
    sm::ModLfoConfig sq = squareLfo(1.0f);
    for (float smooth : { 0.0f, 0.5f, 1.0f }) {
        bool flat = true;
        for (int i = 0; i <= 100; ++i) {
            // Stay clear of the transition zone the smoothing deliberately owns.
            const float phase = 0.5f * static_cast<float>(i) / 100.0f * (1.0f - smooth) * 0.9f;
            if (std::abs(sm::evalLfoShape(sq, phase, smooth) + 1.0f) > 1e-6f) {
                flat = false; break;
            }
        }
        CHECK(flat, "STEP plateau stays exactly flat at smooth=" << smooth);
    }
}

static void testSmoothActuallySmooths()
{
    std::cout << "LFO — SMOOTH morphs curvature (not a no-op)\n";

    // Guard against the plateau test above passing vacuously: smoothing MUST
    // change a sloping segment.
    sm::ModLfoConfig c;
    c.numPoints = 2;
    c.points[0] = sm::LfoPoint{ 0.0f, 0.0f, static_cast<int>(sm::LfoSegment::Line), 0.0f };
    c.points[1] = sm::LfoPoint{ 0.5f, 1.0f, static_cast<int>(sm::LfoSegment::Line), 0.0f };

    const float atQuarterRaw    = sm::evalLfoShape(c, 0.125f, 0.0f);
    const float atQuarterSmooth = sm::evalLfoShape(c, 0.125f, 1.0f);
    CHECK_NEAR(atQuarterRaw, 0.25f, 1e-5, "linear segment is linear at smooth=0");
    CHECK_NEAR(atQuarterSmooth, 0.15625f, 1e-4, "smooth=1 gives the smoothstep value");
    CHECK(atQuarterSmooth < atQuarterRaw - 0.05f, "smoothing measurably eases the segment in");

    // Endpoints are untouched at every smooth setting — smoothing rounds the
    // approach, it does not move the breakpoints.
    for (float smooth : { 0.0f, 0.5f, 1.0f }) {
        CHECK_NEAR(sm::evalLfoShape(c, 0.0f,  smooth), 0.0f, 1e-6,
                   "breakpoint value unmoved at start, smooth=" << smooth);
        CHECK_NEAR(sm::evalLfoShape(c, 0.5f,  smooth), 1.0f, 1e-6,
                   "breakpoint value unmoved at end, smooth=" << smooth);
    }

    // A STEP with smoothing becomes a ramp: the segment midpoint moves off the
    // held value once smooth exceeds half the segment.
    sm::ModLfoConfig sq = squareLfo(1.0f);
    CHECK_NEAR(sm::evalLfoShape(sq, 0.25f, 0.0f), -1.0f, 1e-6,
               "STEP holds its value at smooth=0");
    CHECK(sm::evalLfoShape(sq, 0.40f, 1.0f) > -0.5f,
          "STEP becomes a ramp at smooth=1");
}

// ─── VELO / NOTE response curves ─────────────────────────────────────────────

static void testResponseCurves()
{
    std::cout << "VELO / NOTE response curves\n";

    // Fewer than two points is identity — an untouched VELO source is exactly
    // raw velocity, which is what makes adding the source a no-op by default.
    sm::ModCurveConfig identity;
    CHECK_NEAR(sm::evalModCurve(identity, 0.0f), 0.0f, 1e-6, "identity curve at 0");
    CHECK_NEAR(sm::evalModCurve(identity, 0.37f), 0.37f, 1e-6, "identity curve mid");
    CHECK_NEAR(sm::evalModCurve(identity, 1.0f), 1.0f, 1e-6, "identity curve at 1");

    // An inverting curve.
    sm::ModCurveConfig inv;
    inv.numPoints = 2;
    inv.points[0] = sm::CurvePoint{ 0.0f, 1.0f, 0.0f };
    inv.points[1] = sm::CurvePoint{ 1.0f, 0.0f, 0.0f };
    CHECK_NEAR(sm::evalModCurve(inv, 0.0f), 1.0f, 1e-6, "inverted curve at 0");
    CHECK_NEAR(sm::evalModCurve(inv, 0.5f), 0.5f, 1e-6, "inverted curve at midpoint");
    CHECK_NEAR(sm::evalModCurve(inv, 1.0f), 0.0f, 1e-6, "inverted curve at 1");

    // A three-point curve with a knee, and clamping outside the point range.
    sm::ModCurveConfig knee;
    knee.numPoints = 3;
    knee.points[0] = sm::CurvePoint{ 0.0f, 0.0f, 0.0f };
    knee.points[1] = sm::CurvePoint{ 0.5f, 0.9f, 0.0f };
    knee.points[2] = sm::CurvePoint{ 1.0f, 1.0f, 0.0f };
    CHECK_NEAR(sm::evalModCurve(knee, 0.25f), 0.45f, 1e-5, "knee curve first segment");
    CHECK_NEAR(sm::evalModCurve(knee, 0.75f), 0.95f, 1e-5, "knee curve second segment");

    // Tension bends a segment without moving its endpoints.
    sm::ModCurveConfig bent;
    bent.numPoints = 2;
    bent.points[0] = sm::CurvePoint{ 0.0f, 0.0f, 0.5f };
    bent.points[1] = sm::CurvePoint{ 1.0f, 1.0f, 0.0f };
    CHECK_NEAR(sm::evalModCurve(bent, 0.0f), 0.0f, 1e-6, "tension leaves the start alone");
    CHECK_NEAR(sm::evalModCurve(bent, 1.0f), 1.0f, 1e-6, "tension leaves the end alone");
    // t^(2^-1) = sqrt(t): positive tension covers most of the range early.
    CHECK_NEAR(sm::evalModCurve(bent, 0.5f), 0.70711f, 1e-4,
               "positive tension bends the curve up");
    sm::ModCurveConfig bentDown = bent;
    bentDown.points[0].tension = -0.5f;
    CHECK(sm::evalModCurve(bentDown, 0.5f) < 0.5f, "negative tension bends the curve down");

    // ── Through a real sampler ───────────────────────────────────────────────
    // VELO drives slot volume: a half-velocity note must be quieter than a
    // full-velocity one by the amount the route asks for.
    Sampler s;
    prepareSampler(s);
    sm::ModConfig cfg;
    addRoute(cfg, route(sm::kVeloSource, sm::ModTarget::SlotVolume, 0, 1.0f));
    s.setModulation(cfg);

    s.noteOn(60, 1.0f);
    render(s, 2048);
    const int vFull = s.debugFirstActiveVoiceIndex();
    const float volFull = (vFull >= 0) ? s.debugModVoiceSlotVolume(vFull, 0) : -1.0f;
    s.allNotesOff();
    render(s, 4096);

    s.noteOn(60, 0.5f);
    render(s, 2048);
    const int vHalf = s.debugFirstActiveVoiceIndex();
    const float volHalf = (vHalf >= 0) ? s.debugModVoiceSlotVolume(vHalf, 0) : -1.0f;

    // Base slot volume 1.0, span 1.0: velocity 1 → 2.0, velocity 0.5 → 1.5.
    CHECK_NEAR(volFull, 2.0f, 1e-3, "VELO at velocity 1.0 reaches full slot volume");
    CHECK_NEAR(volHalf, 1.5f, 1e-3, "VELO at velocity 0.5 reaches half the route");

    // NOTE maps note number / 127.
    Sampler n;
    prepareSampler(n);
    sm::ModConfig ncfg;
    addRoute(ncfg, route(sm::kNoteSource, sm::ModTarget::SlotVolume, 0, 1.0f));
    n.setModulation(ncfg);
    n.noteOn(127, 1.0f);
    render(n, 2048);
    const int nv = n.debugFirstActiveVoiceIndex();
    if (nv >= 0)
        CHECK_NEAR(n.debugModVoiceSlotVolume(nv, 0), 2.0f, 1e-3,
                   "NOTE at MIDI 127 reaches the top of its range");
}

// ─── Bipolar vs unipolar ─────────────────────────────────────────────────────

static void testBipolarVsUnipolarMath()
{
    std::cout << "Route polarity — bipolar vs unipolar\n";

    // SlotSem has a 48-semitone span, so the numbers below are directly
    // readable as semitones.
    sm::CompiledRoute uni;
    uni.source  = sm::kLfoSource0;                       // an LFO: ±1 natural
    uni.target  = static_cast<int>(sm::ModTarget::SlotSem);
    uni.amount  = 1.0f;
    uni.bipolar = false;

    sm::CompiledRoute bip = uni;
    bip.bipolar = true;

    // UNIPOLAR: the source sweeps the target from base to base + amount.
    CHECK_NEAR(sm::routeOffset(uni, -1.0f, 1.0f),  0.0f, 1e-4, "unipolar at LFO min = base");
    CHECK_NEAR(sm::routeOffset(uni,  0.0f, 1.0f), 24.0f, 1e-4, "unipolar at LFO zero = half span");
    CHECK_NEAR(sm::routeOffset(uni,  1.0f, 1.0f), 48.0f, 1e-4, "unipolar at LFO max = full span");

    // BIPOLAR: the modulation spreads symmetrically AROUND the base.
    CHECK_NEAR(sm::routeOffset(bip, -1.0f, 1.0f), -48.0f, 1e-4, "bipolar at LFO min = -span");
    CHECK_NEAR(sm::routeOffset(bip,  0.0f, 1.0f),   0.0f, 1e-4, "bipolar at LFO zero = base");
    CHECK_NEAR(sm::routeOffset(bip,  1.0f, 1.0f),  48.0f, 1e-4, "bipolar at LFO max = +span");

    // An envelope is unipolar by nature, so the mapping is the mirror image:
    // a unipolar route rises from the base, a bipolar one starts a full span
    // BELOW it and ends a full span above.
    sm::CompiledRoute envUni = uni;
    envUni.source = sm::kEnvSource0;
    sm::CompiledRoute envBip = envUni;
    envBip.bipolar = true;

    CHECK_NEAR(sm::routeOffset(envUni, 0.0f, 1.0f),   0.0f, 1e-4, "unipolar ENV at 0 = base");
    CHECK_NEAR(sm::routeOffset(envUni, 1.0f, 1.0f),  48.0f, 1e-4, "unipolar ENV at 1 = full span");
    CHECK_NEAR(sm::routeOffset(envBip, 0.0f, 1.0f), -48.0f, 1e-4, "bipolar ENV at 0 = -span");
    CHECK_NEAR(sm::routeOffset(envBip, 0.5f, 1.0f),   0.0f, 1e-4, "bipolar ENV at half = base");
    CHECK_NEAR(sm::routeOffset(envBip, 1.0f, 1.0f),  48.0f, 1e-4, "bipolar ENV at 1 = +span");

    // A negative amount inverts, and output amount scales AFTER the polarity
    // mapping — so turning a source down shrinks a bipolar route toward its
    // base rather than sliding it to one extreme.
    sm::CompiledRoute neg = bip;
    neg.amount = -0.5f;
    CHECK_NEAR(sm::routeOffset(neg, 1.0f, 1.0f), -24.0f, 1e-4, "negative amount inverts");
    CHECK_NEAR(sm::routeOffset(bip, 1.0f, 0.0f),   0.0f, 1e-4,
               "output amount 0 collapses a bipolar route to its base");
    CHECK_NEAR(sm::routeOffset(bip, -1.0f, 0.0f),  0.0f, 1e-4,
               "output amount 0 collapses the negative side too");

    // ── Through a real sampler ───────────────────────────────────────────────
    // A constant +1 LFO into slot 0 SEM at 25%: 0.25 * 48 = 12 semitones.
    Sampler s;
    prepareSampler(s);
    sm::ModConfig cfg;
    cfg.lfos[0] = constantLfo(1.0f);
    addRoute(cfg, route(sm::kLfoSource0, sm::ModTarget::SlotSem, 0, 0.25f, /*bipolar=*/true));
    s.setModulation(cfg);
    s.noteOn(60, 1.0f);
    render(s, 4096);
    const int vi = s.debugFirstActiveVoiceIndex();
    CHECK(vi >= 0, "polarity integration voice is active");
    if (vi >= 0)
        CHECK_NEAR(s.debugModVoiceSlotSemis(vi, 0), 12.0f, 1e-3,
                   "bipolar 25% into SEM = +12 semitones");
}

// ─── Cross-modulation, ordering and cycles ───────────────────────────────────

static void testDependencyOrdering()
{
    std::cout << "Cross-modulation — dependency ordering\n";

    // A chain: LFO1 → LFO2's rate → LFO3's rate. Every edge is satisfiable, so
    // the order must place each source before the one it feeds and NO route may
    // be deferred.
    sm::ModConfig cfg;
    for (int i = 0; i < 3; ++i) cfg.lfos[static_cast<size_t>(i)] = constantLfo(1.0f);
    addRoute(cfg, route(sm::kLfoSource0, sm::ModTarget::SrcRate, sm::kLfoSource0 + 1, 0.5f));
    addRoute(cfg, route(sm::kLfoSource0 + 1, sm::ModTarget::SrcRate, sm::kLfoSource0 + 2, 0.5f));

    sm::CompiledModGraph g;
    sm::compileModGraph(cfg, g);

    CHECK(g.evalPos[sm::kLfoSource0] < g.evalPos[sm::kLfoSource0 + 1],
          "LFO1 is evaluated before the LFO2 it feeds");
    CHECK(g.evalPos[sm::kLfoSource0 + 1] < g.evalPos[sm::kLfoSource0 + 2],
          "LFO2 is evaluated before the LFO3 it feeds");
    CHECK(!g.routes[0].deferred && !g.routes[1].deferred,
          "an acyclic chain defers nothing");
    CHECK(!g.anyCycle, "an acyclic chain is not reported as cyclic");

    // Every source appears exactly once in the order.
    std::array<int, sm::kNumSources> seen{};
    for (int i = 0; i < sm::kNumSources; ++i) ++seen[static_cast<size_t>(g.evalOrder[static_cast<size_t>(i)])];
    bool permutation = true;
    for (int i = 0; i < sm::kNumSources; ++i) if (seen[static_cast<size_t>(i)] != 1) permutation = false;
    CHECK(permutation, "evalOrder is a permutation of every source");
}

static void testTwoSourceCycleOneBlockLatency()
{
    std::cout << "Cross-modulation — 2-source cycle, one-block latency\n";

    // LFO1 and LFO2 each modulate the OTHER's output amount by -0.5. One of the
    // two edges cannot be satisfied in order, so exactly one is deferred and
    // reads the previous control block. The route amounts are SYMMETRIC, so the
    // expectations below do not depend on which of the two the compiler picks.
    sm::ModConfig cfg;
    cfg.lfos[0] = constantLfo(1.0f);
    cfg.lfos[1] = constantLfo(1.0f);
    const int L1 = sm::kLfoSource0, L2 = sm::kLfoSource0 + 1;
    addRoute(cfg, route(L1, sm::ModTarget::SrcAmount, L2, -0.5f));
    addRoute(cfg, route(L2, sm::ModTarget::SrcAmount, L1, -0.5f));

    sm::CompiledModGraph g;
    sm::compileModGraph(cfg, g);

    CHECK(g.anyCycle, "a mutual cross-modulation is reported as a cycle");
    const int deferredCount = (g.routes[0].deferred ? 1 : 0) + (g.routes[1].deferred ? 1 : 0);
    CHECK(deferredCount == 1,
          "exactly one edge of a 2-cycle is deferred (got " << deferredCount << ")");

    // ── The latency itself ───────────────────────────────────────────────────
    // Call the source evaluated first A and the other B. The edge B→A is the
    // deferred one; A→B is satisfied in order. Both sources output a constant
    // +1, so a unipolar route maps that to 1.0 and every number below is exact:
    //
    //   block 1   amount[A] = 1 - 0.5·prevAmount[B](0)    = 1.0     ← nothing yet
    //             amount[B] = 1 - 0.5·amount[A](1.0)      = 0.5     ← same block
    //   block 2   amount[A] = 1 - 0.5·prevAmount[B](0.5)  = 0.75    ← one block late
    //             amount[B] = 1 - 0.5·amount[A](0.75)     = 0.625
    //   block 3   amount[A] = 1 - 0.5·prevAmount[B](0.625)= 0.6875
    //
    // A reading its partner's PREVIOUS value while B reads A's CURRENT one, in
    // the same block, is exactly the documented contract.
    const bool aIsL1 = g.evalPos[L1] < g.evalPos[L2];
    const size_t A = static_cast<size_t>(aIsL1 ? L1 : L2);
    const size_t B = static_cast<size_t>(aIsL1 ? L2 : L1);

    sm::ModSourceBank bank;
    float aAmt[3] = { 0, 0, 0 }, bAmt[3] = { 0, 0, 0 };
    for (int blk = 0; blk < 3; ++blk) {
        sm::modBankSnapshot(bank);
        sm::advanceModBank(g, bank, /*evalGlobal=*/true, 120.0, kCtrlDt);
        aAmt[blk] = bank.amount[A];
        bAmt[blk] = bank.amount[B];
    }

    CHECK_NEAR(aAmt[0], 1.0f,    1e-4, "deferred edge reads zero on block 1");
    CHECK_NEAR(bAmt[0], 0.5f,    1e-4, "the in-order edge takes effect on block 1");
    CHECK_NEAR(aAmt[1], 0.75f,   1e-4, "deferred edge sees block 1's value on block 2");
    CHECK_NEAR(bAmt[1], 0.625f,  1e-4, "the in-order edge keeps tracking within the block");
    CHECK_NEAR(aAmt[2], 0.6875f, 1e-4, "the one-block delay holds on block 3");

    // Self-modulation is the degenerate 1-cycle and must behave the same way.
    sm::ModConfig selfCfg;
    selfCfg.lfos[0] = constantLfo(1.0f);
    addRoute(selfCfg, route(L1, sm::ModTarget::SrcRate, L1, 0.5f));
    sm::CompiledModGraph sg;
    sm::compileModGraph(selfCfg, sg);
    CHECK(sg.routes[0].deferred, "self-modulation is deferred");
    CHECK(sg.anyCycle, "self-modulation is reported as a cycle");
}

static void testCycleDoesNotBlowUp()
{
    std::cout << "Cross-modulation — a cycle stays bounded\n";

    // Mutual rate modulation at full depth, plus a third source feeding back
    // into the pair, run for ten seconds of control blocks. A feedback path
    // that iterated to a fixed point could hang here and one without the unit
    // delay could diverge; a plain one-block delay can do neither.
    sm::ModConfig cfg;
    for (int i = 0; i < 3; ++i) {
        cfg.lfos[static_cast<size_t>(i)] = squareLfo(3.0f + static_cast<float>(i));
        cfg.lfos[static_cast<size_t>(i)].behavior = static_cast<int>(sm::LfoBehavior::Free);
    }
    const int L1 = sm::kLfoSource0, L2 = L1 + 1, L3 = L1 + 2;
    addRoute(cfg, route(L1, sm::ModTarget::SrcRate,   L2, 1.0f, true));
    addRoute(cfg, route(L2, sm::ModTarget::SrcRate,   L1, 1.0f, true));
    addRoute(cfg, route(L3, sm::ModTarget::SrcSmooth, L1, 1.0f, true));
    addRoute(cfg, route(L1, sm::ModTarget::SrcAmount, L3, 1.0f, true));
    addRoute(cfg, route(L2, sm::ModTarget::SrcPhase,  L3, 1.0f, true));

    sm::CompiledModGraph g;
    sm::compileModGraph(cfg, g);
    CHECK(g.anyCycle, "the tangled graph is reported as cyclic");

    sm::ModSourceBank bank;
    bool bounded = true;
    const int blocks = static_cast<int>(10.0 / kCtrlDt);
    for (int i = 0; i < blocks; ++i) {
        sm::modBankSnapshot(bank);
        sm::advanceModBank(g, bank, /*evalGlobal=*/true, 120.0, kCtrlDt);
        for (int k = 0; k < sm::kNumSources; ++k) {
            const float v = bank.value[static_cast<size_t>(k)];
            if (!std::isfinite(v) || std::abs(v) > 1.0001f) { bounded = false; break; }
        }
        if (!bounded) break;
    }
    CHECK(bounded, "every source stays finite and within +/-1 across 10 s of feedback");
}

static void testCrossModulationHasEffect()
{
    std::cout << "Cross-modulation — a route actually moves the target\n";

    // Guard against the ordering tests passing while cross-modulation does
    // nothing: a constant +1 source driving another LFO's RATE upward must make
    // that LFO complete measurably more cycles than it would unmodulated.
    auto cycleCount = [](bool withRoute) {
        sm::ModConfig cfg;
        cfg.lfos[0] = constantLfo(1.0f);
        cfg.lfos[1] = squareLfo(2.0f);
        cfg.lfos[1].behavior = static_cast<int>(sm::LfoBehavior::Free);
        // A route is needed in both cases so the graph compiles identically;
        // the "off" case simply carries zero amount.
        addRoute(cfg, route(sm::kLfoSource0, sm::ModTarget::SrcRate,
                            sm::kLfoSource0 + 1, withRoute ? 0.5f : 0.0f, true));
        sm::CompiledModGraph g;
        sm::compileModGraph(cfg, g);

        sm::ModSourceBank bank;
        int rises = 0;
        float prev = -1.0f;
        for (int i = 0; i < static_cast<int>(2.0 / kCtrlDt); ++i) {
            sm::modBankSnapshot(bank);
            sm::advanceModBank(g, bank, true, 120.0, kCtrlDt);
            const float v = bank.value[static_cast<size_t>(sm::kLfoSource0 + 1)];
            if (prev < 0.0f && v > 0.0f) ++rises;
            prev = v;
        }
        return rises;
    };

    const int off = cycleCount(false);
    const int on  = cycleCount(true);
    // 2 Hz for 2 s = 4 cycles unmodulated; +0.5 * 4 octaves = +2 octaves = 4x.
    CHECK(off == 4, "unmodulated 2 Hz LFO completes 4 cycles in 2 s (got " << off << ")");
    CHECK(on >= 15 && on <= 17,
          "rate modulated up 2 octaves completes ~16 cycles (got " << on << ")");
}

static void testEnvStageTimeCrossModulation()
{
    std::cout << "Cross-modulation — an ENV stage time is modulated\n";

    // A constant source stretching ENV1's attack. EnvStageTime is exponential
    // with a 4-octave span, so a bipolar +1 source at amount 0.25 multiplies the
    // attack by 2^(0.25*4) = 2.
    sm::ModConfig cfg;
    cfg.lfos[0] = constantLfo(1.0f);
    cfg.lfos[0].behavior = static_cast<int>(sm::LfoBehavior::Free);
    cfg.envs[0].attack.ms  = 100.0f;
    cfg.envs[0].sustainPct = 100.0f;
    addRoute(cfg, route(sm::kLfoSource0, sm::ModTarget::EnvStageTime, sm::kEnvSource0,
                        0.25f, /*bipolar=*/true,
                        static_cast<int>(sm::EnvStage::Attack)));

    sm::CompiledModGraph g;
    sm::compileModGraph(cfg, g);
    CHECK(g.numRoutes == 1, "the EnvStageTime route survived validation");

    // Evaluate the global LFO and the per-voice envelope together, exactly as
    // the sampler does: globals first, then the voice reads them.
    sm::ModSourceBank globals, voice;
    sm::modTriggerVoice(g, voice, 1.0f, 0.5f);

    double t = 0.0, reached = -1.0;
    for (int i = 0; i < 2000; ++i) {
        sm::modBankSnapshot(globals);
        sm::advanceModBank(g, globals, /*evalGlobal=*/true, 120.0, kCtrlDt);

        sm::modBankSnapshot(voice);
        for (int k = 0; k < sm::kNumSources; ++k)
            if (g.isGlobal[static_cast<size_t>(k)]) {
                voice.value[static_cast<size_t>(k)]  = globals.value[static_cast<size_t>(k)];
                voice.amount[static_cast<size_t>(k)] = globals.amount[static_cast<size_t>(k)];
            }
        sm::advanceModBank(g, voice, /*evalGlobal=*/false, 120.0, kCtrlDt);

        if (voice.value[sm::kEnvSource0] >= 0.9999f && reached < 0.0) { reached = t; break; }
        t += kCtrlDt;
    }
    // The very first block reads the LFO's not-yet-evaluated previous value, so
    // one block runs at the unmodulated length — hence the extra block of slack.
    CHECK_NEAR(reached, 0.200, 3.0 * kCtrlDt + 1e-9,
               "a +1-octave stage-time route doubles a 100 ms attack to 200 ms");
}

// ─── Route validation ────────────────────────────────────────────────────────

static void testRouteValidation()
{
    std::cout << "Route validation\n";

    CHECK(!sm::isRouteValid(route(-1, sm::ModTarget::SlotVolume, 0, 1.0f)),
          "a route with no source is rejected");
    CHECK(!sm::isRouteValid(route(sm::kNumSources, sm::ModTarget::SlotVolume, 0, 1.0f)),
          "a route with an out-of-range source is rejected");
    CHECK(!sm::isRouteValid(route(0, sm::ModTarget::None, 0, 1.0f)),
          "a route with no target is rejected");
    CHECK(!sm::isRouteValid(route(0, sm::ModTarget::SlotVolume, sm::kMaxModSlots, 1.0f)),
          "a slot route past the last slot is rejected");
    CHECK(!sm::isRouteValid(route(0, sm::ModTarget::SrcRate, sm::kEnvSource0, 1.0f)),
          "a RATE route aimed at an envelope is rejected");
    CHECK(sm::isRouteValid(route(0, sm::ModTarget::SrcAmount, sm::kEnvSource0, 1.0f)),
          "an output-amount route aimed at an envelope is accepted");
    CHECK(!sm::isRouteValid(route(0, sm::ModTarget::EnvStageTime, sm::kLfoSource0, 1.0f, false,
                                  static_cast<int>(sm::EnvStage::Attack))),
          "a stage-time route aimed at an LFO is rejected");
    CHECK(!sm::isRouteValid(route(0, sm::ModTarget::EnvStageTime, sm::kEnvSource0, 1.0f, false,
                                  static_cast<int>(sm::EnvStage::Sustain))),
          "a stage-time route aimed at SUSTAIN is rejected — sustain is a level");
    CHECK(sm::isRouteValid(route(0, sm::ModTarget::EnvStageTime, sm::kEnvSource0, 1.0f, false,
                                 static_cast<int>(sm::EnvStage::Release))),
          "a stage-time route aimed at RELEASE is accepted");

    // Invalid routes are dropped at compile time rather than reaching the
    // audio thread.
    sm::ModConfig cfg;
    addRoute(cfg, route(0, sm::ModTarget::SlotVolume, 0, 1.0f));     // valid
    addRoute(cfg, route(0, sm::ModTarget::SrcRate, sm::kEnvSource0, 1.0f));  // invalid
    sm::CompiledModGraph g;
    sm::compileModGraph(cfg, g);
    CHECK(g.numRoutes == 1, "compilation drops invalid routes");
}

// ─── Bypass and legacy identity ──────────────────────────────────────────────

static void testEmptyConfigIsExactBypass()
{
    std::cout << "Bypass — an empty route list changes nothing\n";

    // Render the same note twice: once with no modulation set at all, once with
    // a fully populated config carrying ZERO routes. The two must be
    // sample-identical, which is what makes "the legacy path still works"
    // a checkable claim rather than an assurance.
    juce::AudioBuffer<float> a, b;
    {
        Sampler s;
        prepareSampler(s);
        s.noteOn(64, 0.9f);
        a = render(s, 8192);
    }
    {
        Sampler s;
        prepareSampler(s);
        sm::ModConfig cfg;
        // ENV 1 IS the amp VCA now, so mirror the envelope prepareSampler set
        // (attack 0, release 5 ms) — otherwise setModulation would legitimately
        // change the amplitude contour. Every OTHER source is mangled to prove a
        // source with no route leaves the render untouched.
        cfg.envs[0].release.ms = 5.0f;
        for (int i = 1; i < sm::kNumEnvs; ++i) cfg.envs[static_cast<size_t>(i)].attack.ms = 50.0f;
        for (int i = 0; i < sm::kNumLfos; ++i) cfg.lfos[static_cast<size_t>(i)] = squareLfo(5.0f);
        // No routes.
        s.setModulation(cfg);
        s.noteOn(64, 0.9f);
        b = render(s, 8192);
    }

    CHECK(a.getNumSamples() == b.getNumSamples(), "bypass renders are the same length");
    float maxDiff = 0.0f;
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < a.getNumSamples(); ++i)
            maxDiff = std::max(maxDiff, std::abs(a.getSample(ch, i) - b.getSample(ch, i)));
    CHECK(maxDiff == 0.0f, "a zero-route config is sample-identical to no config at all"
                           " (max diff " << maxDiff << ")");
}

// ─── Per-instance MANGLE routing ─────────────────────────────────────────────

static void testMangleInstanceRouting()
{
    std::cout << "MANGLE modulation — a route's stage selects the chain instance\n";

    // Validity: `stage` is the instance index for the two MANGLE targets, so it
    // must be in [0, kMaxMangleInstances).
    CHECK(sm::isRouteValid(route(sm::kLfoSource0, sm::ModTarget::SlotMangleAmount,
                                 0, 0.5f, false, 2)),
          "a SlotMangleAmount route to instance 2 is valid");
    CHECK(!sm::isRouteValid(route(sm::kLfoSource0, sm::ModTarget::SlotMangleAmount,
                                  0, 0.5f, false, sm::kMaxMangleInstances)),
          "a SlotMangleAmount route to an out-of-range instance is rejected");
    CHECK(!sm::isRouteValid(route(sm::kLfoSource0, sm::ModTarget::SlotMangleMix,
                                  0, 0.5f, false, -1)),
          "a negative instance is rejected");

    // The accumulated offset must land on the addressed slot AND instance, and
    // touch nothing else — the whole point of the per-instance dimension.
    sm::ModConfig cfg;
    cfg.lfos[0] = constantLfo(1.0f);   // steady +1 source
    addRoute(cfg, route(sm::kLfoSource0, sm::ModTarget::SlotMangleAmount,
                        /*slot*/1, 0.5f, /*bipolar*/false, /*stage=instance*/2));
    sm::CompiledModGraph g;
    sm::compileModGraph(cfg, g);

    sm::ModSourceBank bank;
    sm::modBankSnapshot(bank);
    sm::advanceModBank(g, bank, true, 120.0, kCtrlDt);
    sm::ModOffsets off;
    sm::accumulateModOffsets(g, bank, off);

    // Unipolar LFO: (raw+1)/2 = 1; offset = amount·outAmt·1·span(1) = 0.5.
    CHECK_NEAR(off.mangleAmount[1][2], 0.5, 1e-4,
               "the offset lands on slot 1, instance 2 (got " << off.mangleAmount[1][2] << ")");
    CHECK(off.mangleAmount[1][0] == 0.0f && off.mangleAmount[1][1] == 0.0f
          && off.mangleAmount[1][3] == 0.0f,
          "no other instance of the same slot is touched");
    CHECK(off.mangleAmount[0][2] == 0.0f, "no other slot is touched");
    CHECK(off.mangleMix[1][2] == 0.0f, "an Amount route does not move Mix");
}

// ─── ENV 1 IS the amp VCA ────────────────────────────────────────────────────

static void testAmpEnvViaEnv1MatchesSetEnvelope()
{
    std::cout << "Amp envelope — ENV 1 drives the VCA identically to setEnvelope\n";

    // The same DAHDSR applied two ways must render SAMPLE-IDENTICALLY:
    //   (a) the direct setEnvelope() the VCA has always used, and
    //   (b) ENV 1 (envs[0]) driving the VCA through setModulation().
    // This is the automated form of "a legacy-migrated amp envelope sounds the
    // same through ENV 1" — attack, decay, sustain AND the release tail.
    const float dl = 0.0f, at = 8.0f, ho = 3.0f, de = 40.0f, su = 0.6f, re = 75.0f;

    auto renderBoth = [&](bool viaEnv1) {
        Sampler s;
        s.loadSample(makeSine(kEngineSR, 220.0, static_cast<int>(kEngineSR)), kEngineSR, 60);
        s.setCrossfadeMode(true);
        if (viaEnv1) {
            sm::ModConfig cfg;
            cfg.envs[0].delay.ms   = dl;
            cfg.envs[0].attack.ms  = at;
            cfg.envs[0].hold.ms    = ho;
            cfg.envs[0].decay.ms   = de;
            cfg.envs[0].sustainPct = su * 100.0f;
            cfg.envs[0].release.ms = re;
            s.setModulation(cfg);            // derives the VCA from ENV 1
        } else {
            s.setEnvelope(dl, at, ho, de, su, re, 0.0f, 0.0f, 0.0f);
        }
        juce::AudioBuffer<float> out(2, 12000);
        out.clear();
        s.noteOn(60, 1.0f, 0);
        s.processBlock(out, 6000, kEngineSR);      // through attack/decay into sustain
        s.noteOff(60, 0);
        juce::AudioBuffer<float> tail(2, 6000);
        tail.clear();
        s.processBlock(tail, 6000, kEngineSR);     // the release tail
        for (int ch = 0; ch < 2; ++ch)
            out.copyFrom(ch, 6000, tail, ch, 0, 6000);
        return out;
    };

    juce::AudioBuffer<float> direct = renderBoth(false);
    juce::AudioBuffer<float> env1   = renderBoth(true);

    float maxDiff = 0.0f;
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < direct.getNumSamples(); ++i)
            maxDiff = std::max(maxDiff,
                std::abs(direct.getSample(ch, i) - env1.getSample(ch, i)));
    CHECK(maxDiff == 0.0f,
          "ENV 1 reproduces the amp envelope exactly (max diff " << maxDiff << ")");
}

// ─── End-to-end: audible vibrato ─────────────────────────────────────────────

static void testAudibleVibrato()
{
    std::cout << "End-to-end — LFO1 into slot SEM produces vibrato\n";

    // The manual smoke test, run headlessly: a slow bipolar square LFO into
    // slot 0's SEM must make the rendered pitch alternate between two clearly
    // different values. Counting zero crossings in each half-cycle reads the
    // pitch directly.
    Sampler s;
    prepareSampler(s, 220.0);

    sm::ModConfig cfg;
    cfg.lfos[0] = squareLfo(2.0f);                 // 500 ms cycle
    cfg.lfos[0].behavior = static_cast<int>(sm::LfoBehavior::Retrig);
    // 0.25 * 48 = +/-12 semitones: an octave either way, so the two halves are
    // unmistakably different pitches.
    addRoute(cfg, route(sm::kLfoSource0, sm::ModTarget::SlotSem, 0, 0.25f, /*bipolar=*/true));
    s.setModulation(cfg);

    s.noteOn(60, 1.0f);
    juce::AudioBuffer<float> out = render(s, static_cast<int>(kEngineSR * 0.45));

    // First half of the cycle sits on -1 (an octave down), second half on +1.
    const int qtr = static_cast<int>(kEngineSR * 0.10);
    const int zcLow  = countZeroCrossings(out, static_cast<int>(kEngineSR * 0.05), qtr);
    const int zcHigh = countZeroCrossings(out, static_cast<int>(kEngineSR * 0.30), qtr);

    CHECK(zcLow > 0 && zcHigh > 0, "both halves of the vibrato produced audio");
    // An octave down then an octave up is a 4:1 pitch ratio.
    const double ratio = static_cast<double>(zcHigh) / std::max(1, zcLow);
    CHECK(ratio > 3.0 && ratio < 5.0,
          "the two halves differ by two octaves (zc ratio " << ratio << ")");

    // The same route at amount 0 must leave the pitch alone — otherwise the
    // test above could be measuring something other than the route.
    Sampler flat;
    prepareSampler(flat, 220.0);
    sm::ModConfig zero;
    zero.lfos[0] = squareLfo(2.0f);
    addRoute(zero, route(sm::kLfoSource0, sm::ModTarget::SlotSem, 0, 0.0f, true));
    flat.setModulation(zero);
    flat.noteOn(60, 1.0f);
    juce::AudioBuffer<float> flatOut = render(flat, static_cast<int>(kEngineSR * 0.45));
    const int fLow  = countZeroCrossings(flatOut, static_cast<int>(kEngineSR * 0.05), qtr);
    const int fHigh = countZeroCrossings(flatOut, static_cast<int>(kEngineSR * 0.30), qtr);
    CHECK(std::abs(fLow - fHigh) <= 2, "a zero-amount route leaves the pitch flat");
}

static void testMasterVolumeAndPanTargets()
{
    std::cout << "Targets — sampler master volume and pan\n";

    // Master volume: a constant source at amount -0.5 halves the sampler output.
    auto renderWithMaster = [](float amount) {
        Sampler s;
        prepareSampler(s, 220.0);
        sm::ModConfig cfg;
        cfg.lfos[0] = constantLfo(1.0f);
        addRoute(cfg, route(sm::kLfoSource0, sm::ModTarget::MasterVolume, 0, amount,
                            /*bipolar=*/true));
        s.setModulation(cfg);
        s.noteOn(60, 1.0f);
        return render(s, 8192);
    };

    const double full = rmsRange(renderWithMaster(0.0f), 0, 2048, 4096);
    const double half = rmsRange(renderWithMaster(-0.5f), 0, 2048, 4096);
    CHECK(full > 1e-4, "master-volume reference render is audible");
    CHECK_NEAR(half / full, 0.5, 0.05, "master volume at -0.5 halves the output");

    // Master pan: a constant source pushed hard right must leave the left
    // channel far quieter than the right.
    Sampler s;
    prepareSampler(s, 220.0);
    sm::ModConfig cfg;
    cfg.lfos[0] = constantLfo(1.0f);
    addRoute(cfg, route(sm::kLfoSource0, sm::ModTarget::MasterPan, 0, 1.0f, /*bipolar=*/true));
    s.setModulation(cfg);
    s.noteOn(60, 1.0f);
    juce::AudioBuffer<float> out = render(s, 8192);
    const double l = rmsRange(out, 0, 2048, 4096);
    const double r = rmsRange(out, 1, 2048, 4096);
    CHECK(r > 1e-4 && l < r * 0.05, "master pan hard right silences the left channel");
}

// ─── Schema round trip ───────────────────────────────────────────────────────

static bool timeEq(const sm::ModTime& a, const sm::ModTime& b)
{
    return std::abs(a.ms - b.ms) < 1e-4f && a.noteValue == b.noteValue
        && a.triplet == b.triplet && a.dotted == b.dotted;
}

static void testSchemaRoundTrip()
{
    std::cout << "Serialization — schema round trip\n";

    sm::ModConfig c;

    // Populate every kind of field so a dropped key shows up as a failure
    // rather than as a default that happens to match.
    c.envs[0].tempoSync       = true;
    c.envs[0].delay.ms        = 12.5f;
    c.envs[0].attack.noteValue = static_cast<int>(sm::NoteValue::Eighth);
    c.envs[0].attack.triplet  = true;
    c.envs[0].hold.ms         = 33.0f;
    c.envs[0].decay.dotted    = true;
    c.envs[0].release.ms      = 250.0f;
    c.envs[0].sustainPct      = 42.0f;
    c.envs[0].attackTension   = 0.3f;
    c.envs[0].decayTension    = -0.4f;
    c.envs[0].releaseTension  = 0.7f;
    c.envs[0].outputAmount    = 0.6f;
    c.envs[5].attack.ms       = 999.0f;

    c.lfos[0] = squareLfo(7.5f);
    c.lfos[0].smooth       = 55.0f;
    c.lfos[0].phase        = 30.0f;
    c.lfos[0].behavior     = static_cast<int>(sm::LfoBehavior::Envelope);
    c.lfos[0].mono         = true;
    c.lfos[0].outputAmount = 0.8f;
    c.lfos[0].rise.ms      = 40.0f;
    c.lfos[0].delay.ms     = 80.0f;
    c.lfos[3].tempoSync    = true;
    c.lfos[3].syncRate.noteValue = static_cast<int>(sm::NoteValue::Bars4);
    c.lfos[3].syncRate.dotted    = true;
    c.lfos[3].numPoints    = 3;
    c.lfos[3].points[0] = sm::LfoPoint{ 0.0f, -0.5f, static_cast<int>(sm::LfoSegment::Curve), 0.25f };
    c.lfos[3].points[1] = sm::LfoPoint{ 0.4f,  0.9f, static_cast<int>(sm::LfoSegment::Step), 0.0f };
    c.lfos[3].points[2] = sm::LfoPoint{ 0.8f,  0.1f, static_cast<int>(sm::LfoSegment::Line), -0.5f };

    c.velo.numPoints = 2;
    c.velo.points[0] = sm::CurvePoint{ 0.0f, 0.2f, 0.1f };
    c.velo.points[1] = sm::CurvePoint{ 1.0f, 0.9f, 0.0f };
    c.velo.outputAmount = 0.75f;
    c.note.numPoints = 2;
    c.note.points[0] = sm::CurvePoint{ 0.0f, 1.0f, 0.0f };
    c.note.points[1] = sm::CurvePoint{ 1.0f, 0.0f, 0.0f };

    addRoute(c, route(sm::kEnvSource0, sm::ModTarget::SlotVolume, 2, 0.5f, true));
    addRoute(c, route(sm::kLfoSource0, sm::ModTarget::SlotSem, 0, -0.25f, false));
    addRoute(c, route(sm::kVeloSource, sm::ModTarget::MasterPan, 0, 1.0f, true));
    addRoute(c, route(sm::kLfoSource0 + 1, sm::ModTarget::SrcRate, sm::kLfoSource0, 0.3f, true));
    addRoute(c, route(sm::kNoteSource, sm::ModTarget::EnvStageTime, sm::kEnvSource0 + 1,
                      0.2f, false, static_cast<int>(sm::EnvStage::Decay)));

    // ── ModConfig alone ──────────────────────────────────────────────────────
    nlohmann::json j = c;
    sm::ModConfig back;
    sm::from_json(j, back);

    CHECK(back.numRoutes == c.numRoutes, "route count survives the round trip");
    bool routesMatch = (back.numRoutes == c.numRoutes);
    for (int i = 0; i < c.numRoutes && routesMatch; ++i) {
        const auto& x = c.routes[static_cast<size_t>(i)];
        const auto& y = back.routes[static_cast<size_t>(i)];
        routesMatch = x.source == y.source && x.target == y.target && x.index == y.index
                   && x.stage == y.stage && std::abs(x.amount - y.amount) < 1e-4f
                   && x.bipolar == y.bipolar;
    }
    CHECK(routesMatch, "every route field survives the round trip");

    CHECK(back.envs[0].tempoSync == c.envs[0].tempoSync, "env tempoSync survives");
    CHECK(timeEq(back.envs[0].delay,   c.envs[0].delay),   "env delay time survives");
    CHECK(timeEq(back.envs[0].attack,  c.envs[0].attack),  "env attack note value + triplet survive");
    CHECK(timeEq(back.envs[0].hold,    c.envs[0].hold),    "env hold time survives");
    CHECK(timeEq(back.envs[0].decay,   c.envs[0].decay),   "env decay dotted flag survives");
    CHECK(timeEq(back.envs[0].release, c.envs[0].release), "env release time survives");
    CHECK_NEAR(back.envs[0].sustainPct,     42.0f, 1e-4, "env sustain survives");
    CHECK_NEAR(back.envs[0].attackTension,   0.3f, 1e-4, "env attack tension survives");
    CHECK_NEAR(back.envs[0].decayTension,   -0.4f, 1e-4, "env decay tension survives");
    CHECK_NEAR(back.envs[0].releaseTension,  0.7f, 1e-4, "env release tension survives");
    CHECK_NEAR(back.envs[0].outputAmount,    0.6f, 1e-4, "env output amount survives");
    CHECK_NEAR(back.envs[5].attack.ms,     999.0f, 1e-3, "the LAST envelope survives too");

    CHECK(back.lfos[0].numPoints == 2, "LFO point count survives");
    CHECK_NEAR(back.lfos[0].rateHz, 7.5f, 1e-4, "LFO rate survives");
    CHECK_NEAR(back.lfos[0].smooth, 55.0f, 1e-4, "LFO smooth survives");
    CHECK_NEAR(back.lfos[0].phase,  30.0f, 1e-4, "LFO phase survives");
    CHECK(back.lfos[0].behavior == static_cast<int>(sm::LfoBehavior::Envelope),
          "LFO behavior survives");
    CHECK(back.lfos[0].mono, "LFO mono flag survives");
    CHECK(timeEq(back.lfos[0].rise,  c.lfos[0].rise),  "LFO rise survives");
    CHECK(timeEq(back.lfos[0].delay, c.lfos[0].delay), "LFO delay survives");
    CHECK(timeEq(back.lfos[3].syncRate, c.lfos[3].syncRate), "LFO sync rate survives");

    bool pointsMatch = back.lfos[3].numPoints == 3;
    for (int i = 0; i < 3 && pointsMatch; ++i) {
        const auto& x = c.lfos[3].points[static_cast<size_t>(i)];
        const auto& y = back.lfos[3].points[static_cast<size_t>(i)];
        pointsMatch = std::abs(x.time - y.time) < 1e-4f
                   && std::abs(x.value - y.value) < 1e-4f
                   && x.segment == y.segment
                   && std::abs(x.tension - y.tension) < 1e-4f;
    }
    CHECK(pointsMatch, "every LFO shape point survives, segment type and tension included");

    CHECK(back.velo.numPoints == 2, "VELO curve survives");
    CHECK_NEAR(back.velo.points[0].y, 0.2f, 1e-4, "VELO point value survives");
    CHECK_NEAR(back.velo.outputAmount, 0.75f, 1e-4, "VELO output amount survives");
    CHECK(back.note.numPoints == 2, "NOTE curve survives");
    CHECK_NEAR(back.note.points[0].y, 1.0f, 1e-4, "NOTE point value survives");

    // A second trip must be a fixed point.
    nlohmann::json j2 = back;
    CHECK(j == j2, "the round trip is idempotent");

    // ── Through a whole SampleRegion ─────────────────────────────────────────
    SampleRegion r;
    r.id = 7;
    r.name = "mod region";
    r.modulation = c;
    nlohmann::json rj = r;
    SampleRegion rBack;
    from_json(rj, rBack);
    CHECK(rBack.modulation.numRoutes == c.numRoutes,
          "modulation survives a SampleRegion round trip");
    CHECK(rBack.modulation.lfos[0].behavior == static_cast<int>(sm::LfoBehavior::Envelope),
          "LFO behavior survives a SampleRegion round trip");

    // ── Schema 2 compatibility ───────────────────────────────────────────────
    // A project written before this system existed has no "modulation" key at
    // all. It must load with an empty route list — the exact bypass.
    nlohmann::json legacy = rj;
    legacy.erase("modulation");
    SampleRegion legacyBack;
    from_json(legacy, legacyBack);
    CHECK(legacyBack.modulation.numRoutes == 0,
          "a schema-2 region loads with no routes");
    CHECK(legacyBack.modulation.isBypassed(),
          "a schema-2 region is bypassed, not merely empty");
    CHECK(legacyBack.id == 7 && legacyBack.name == "mod region",
          "the rest of a schema-2 region still loads");

    // A malformed modulation block must not throw or corrupt the region.
    nlohmann::json broken = rj;
    broken["modulation"] = "not an object";
    SampleRegion brokenBack;
    bool threw = false;
    try { from_json(broken, brokenBack); } catch (...) { threw = true; }
    CHECK(!threw, "a malformed modulation block does not throw");
    CHECK(brokenBack.modulation.numRoutes == 0, "a malformed modulation block yields defaults");
}

// Source presence — which ENV/LFO sources exist. A default config has only
// ENV 0; presence survives the round trip; ENV 0 is always forced present; and a
// legacy blob with no presence keys reads as all-present so nothing a user built
// before this system vanishes.
static void testSourcePresence()
{
    std::cout << "Source presence — add / remove state\n";

    // Default: ENV 1 (index 0) and LFO 1 (index 0) exist; every other source
    // starts absent, so the tray opens on one envelope and one LFO to shape.
    sm::ModConfig fresh;
    CHECK(fresh.envPresent[0], "a fresh config has ENV 1 present");
    CHECK(!fresh.envPresent[1] && !fresh.envPresent[5], "a fresh config has ENV 2-6 absent");
    CHECK(fresh.lfoPresent[0], "a fresh config has LFO 1 present");
    CHECK(!fresh.lfoPresent[1] && !fresh.lfoPresent[5], "a fresh config has LFO 2-6 absent");
    CHECK(fresh.isSourcePresent(sm::kEnvSource0), "isSourcePresent sees ENV 1");
    CHECK(fresh.isSourcePresent(sm::kLfoSource0), "isSourcePresent sees LFO 1 as present");
    CHECK(fresh.isSourcePresent(sm::kVeloSource) && fresh.isSourcePresent(sm::kNoteSource),
          "VELO and NOTE are always present");

    // A fresh config with no routes is a bypass — presence flags never affect
    // it (an unrouted source, including the default LFO 1, does nothing), so the
    // voice-lifecycle path is untouched.
    CHECK(fresh.isBypassed(), "a fresh config with no routes is an exact bypass");

    // Presence survives the round trip.
    sm::ModConfig c;
    c.envPresent = { true, false, true, false, false, true };
    c.lfoPresent = { true, false, false, true, false, false };
    nlohmann::json j = c;
    sm::ModConfig back;
    sm::from_json(j, back);
    CHECK(back.envPresent == c.envPresent, "envPresent survives the round trip");
    CHECK(back.lfoPresent == c.lfoPresent, "lfoPresent survives the round trip");

    // ENV 0 is forced present even if a payload cleared it.
    sm::ModConfig cleared;
    cleared.envPresent[0] = false;
    cleared.enforceInvariants();
    CHECK(cleared.envPresent[0], "enforceInvariants re-asserts ENV 1");
    nlohmann::json jc = c;
    jc["envPresent"][0] = false;          // a hostile blob turns ENV 1 off
    sm::ModConfig hostile;
    sm::from_json(jc, hostile);
    CHECK(hostile.envPresent[0], "from_json forces ENV 1 present regardless of the blob");

    // A legacy blob has no presence keys: it must read as ALL present so a
    // project built on the old fixed rack keeps every source it had.
    nlohmann::json legacy = c;
    legacy.erase("envPresent");
    legacy.erase("lfoPresent");
    sm::ModConfig legacyBack;
    sm::from_json(legacy, legacyBack);
    bool allEnv = true, allLfo = true;
    for (int i = 0; i < sm::kNumEnvs; ++i) allEnv = allEnv && legacyBack.envPresent[i];
    for (int i = 0; i < sm::kNumLfos; ++i) allLfo = allLfo && legacyBack.lfoPresent[i];
    CHECK(allEnv && allLfo, "a legacy blob (no presence keys) reads as all-present");

    // Presence also survives a whole-region round trip.
    SampleRegion r;
    r.id = 9;
    r.modulation = c;
    nlohmann::json rj = r;
    SampleRegion rBack;
    from_json(rj, rBack);
    CHECK(rBack.modulation.envPresent == c.envPresent,
          "envPresent survives a SampleRegion round trip");
    CHECK(rBack.modulation.lfoPresent == c.lfoPresent,
          "lfoPresent survives a SampleRegion round trip");
}

// ─── MANGLE modulation: dezipper and block-boundary continuity ───────────────
//
// The bug these cover: a MANGLE instance's per-block Runtime lives in the
// stack-local `geo` array, which processVoice rebuilds from the UNMODULATED
// published chain at the top of EVERY audio buffer. The modulated re-design
// only happens at a control-block boundary, and the control-block counter is
// VOICE-relative — so it does not line up with the buffer boundary. Every
// buffer therefore rendered its first `modCountdown` samples (0..31) with the
// base amount before snapping back to the modulated one: a discontinuity per
// buffer, for as long as the route carried a non-zero offset, whether or not
// that offset was CHANGING.
//
// Hence the two properties asserted here: a statically-modulated render must
// equal the equivalently-configured static one, and it must not depend on the
// host buffer size.

namespace mg = xleth::mangle;

// Largest sample-to-sample jump in a window — the discontinuity metric.
static float maxStep(const juce::AudioBuffer<float>& b, int ch, int start, int len)
{
    const int end = std::min(start + len, b.getNumSamples());
    const float* d = b.getReadPointer(ch);
    float m = 0.0f;
    for (int i = std::max(1, start); i < end; ++i)
        m = std::max(m, std::abs(d[i] - d[i - 1]));
    return m;
}

static float maxDiff(const juce::AudioBuffer<float>& a,
                     const juce::AudioBuffer<float>& b, int start = 0)
{
    float m = 0.0f;
    const int n = std::min(a.getNumSamples(), b.getNumSamples());
    for (int ch = 0; ch < std::min(a.getNumChannels(), b.getNumChannels()); ++ch)
        for (int i = start; i < n; ++i)
            m = std::max(m, std::abs(a.getSample(ch, i) - b.getSample(ch, i)));
    return m;
}

// ENV 2 present, no routes at all — so the reference render drives its VCA
// through exactly the same ENV-1 path as the modulated one and the ONLY
// difference between the two is the MANGLE route.
static sm::ModConfig modConfigNoRoutes()
{
    sm::ModConfig cfg;
    cfg.envPresent[1] = true;
    cfg.envs[1].sustainPct = 100.0f;    // instant attack, holds at full forever
    return cfg;
}

// ENV 2 (static at full sustain) → slot 0 / instance `inst` MANGLE amount.
static sm::ModConfig modConfigStaticEnvToMangleAmount(float amount, int inst = 0)
{
    sm::ModConfig cfg = modConfigNoRoutes();
    addRoute(cfg, route(sm::kEnvSource0 + 1, sm::ModTarget::SlotMangleAmount,
                        /*index=*/0, amount, /*bipolar=*/false, /*stage=*/inst));
    return cfg;
}

// The note starts at a sample offset that is NOT a multiple of the 32-sample
// control block, which is the whole point: with an onset of 0 and a power-of-two
// buffer the control block lands exactly on every buffer boundary and the bug is
// invisible. Any real project starts its notes wherever the sequencer says.
static constexpr int kMangleOnset = 13;

static juce::AudioBuffer<float> renderMangle(mg::Mode mode, float baseAmount,
                                             const sm::ModConfig& cfg,
                                             int numSamples, int blockSize)
{
    Sampler s;
    prepareSampler(s, 220.0);
    s.setSlotMangleChain(0, { mg::InstanceConfig{ static_cast<int>(mode),
                                                  baseAmount, 1.0f, false } });
    s.setModulation(cfg);
    s.noteOn(60, 1.0f, kMangleOnset);
    return render(s, numSamples, blockSize);
}

// One mode's worth of the two claims: a STATIC modulated amount must render
// like the same amount set statically, and must not depend on the buffer size.
static void checkStaticModulationMatches(const char* name, mg::Mode mode,
                                         float baseAmount, float offset,
                                         float tol)
{
    constexpr int kN    = 24000;
    // Past the note-start ramp and the declick, so the comparison is of the
    // steady state — the modulated render legitimately dezippers into its
    // offset over the first control block.
    constexpr int kFrom = 4096;

    const sm::ModConfig none = modConfigNoRoutes();
    const sm::ModConfig env  = modConfigStaticEnvToMangleAmount(offset);

    juce::AudioBuffer<float> ref = renderMangle(mode, baseAmount + offset, none, kN, 512);
    juce::AudioBuffer<float> mod = renderMangle(mode, baseAmount, env, kN, 512);

    CHECK(rmsRange(ref, 0, kFrom, kN - kFrom) > 1e-4,
          name << ": the reference render is audible");

    const float refStep = maxStep(ref, 0, kFrom, kN - kFrom);
    const float modStep = maxStep(mod, 0, kFrom, kN - kFrom);
    std::cout << "    " << name << ": max step mod " << modStep
              << " / ref " << refStep << "\n";
    CHECK(modStep <= refStep * 1.05f + 1.0e-4f,
          name << ": a statically-modulated render introduces no discontinuity beyond "
               << "the unmodulated baseline (mod " << modStep << " vs ref " << refStep << ")");

    CHECK(maxDiff(ref, mod, kFrom) < tol,
          name << ": a static modulated amount renders as the same static amount "
               << "(max diff " << maxDiff(ref, mod, kFrom) << ")");

    // Buffer-size independence. The control block is voice-relative, so nothing
    // about the render may depend on how the host slices the stream.
    juce::AudioBuffer<float> mod128 = renderMangle(mode, baseAmount, env, kN, 128);
    CHECK(maxDiff(mod, mod128) == 0.0f,
          name << ": a modulated render is independent of the host buffer size "
               << "(max diff " << maxDiff(mod, mod128) << ")");
}

static void testMangleStaticModulationIsContinuous()
{
    std::cout << "MANGLE modulation — a static modulated amount is click-free\n";

    // (a) the reported case: ENV 2 → a Sync instance's amount, held at sustain.
    checkStaticModulationMatches("SYNC", mg::Mode::Sync, 0.0f, 0.5f, 2.0e-3f);
    // (d) one mode from each of the other groups.
    checkStaticModulationMatches("LPF",   mg::Mode::Lpf,  0.5f, 0.3f, 2.0e-3f);
    checkStaticModulationMatches("TUBE",  mg::Mode::Tube, 0.0f, 0.5f, 2.0e-3f);
    checkStaticModulationMatches("FM",    mg::Mode::Fm,   0.0f, 0.4f, 2.0e-3f);
}

static void testMangleMovingModulationIsBufferAgnostic()
{
    std::cout << "MANGLE modulation — a MOVING modulated amount is buffer-agnostic\n";

    // The static case above proves the block-boundary seam is gone. This one
    // proves the dezipper itself is voice-relative: an amount that is genuinely
    // sweeping — a 40 Hz LFO steps the control block ~19 times per cycle — must
    // still render the same stream whatever the host buffer size is, which no
    // ramp keyed off the BUFFER could manage.
    sm::ModConfig cfg = modConfigNoRoutes();
    cfg.lfos[0] = constantLfo(0.0f);         // placeholder, replaced below
    cfg.lfos[0].numPoints = 0;               // built-in sine
    cfg.lfos[0].rateHz    = 40.0f;
    cfg.lfos[0].behavior  = static_cast<int>(sm::LfoBehavior::Retrig);
    addRoute(cfg, route(sm::kLfoSource0, sm::ModTarget::SlotMangleAmount,
                        /*index=*/0, 0.45f, /*bipolar=*/false, /*stage=*/0));

    constexpr int kN = 24000;
    juce::AudioBuffer<float> a = renderMangle(mg::Mode::Sync, 0.5f, cfg, kN, 512);
    juce::AudioBuffer<float> b = renderMangle(mg::Mode::Sync, 0.5f, cfg, kN, 128);
    juce::AudioBuffer<float> c = renderMangle(mg::Mode::Sync, 0.5f, cfg, kN, 333);

    CHECK(rmsRange(a, 0, 4096, kN - 4096) > 1e-4, "the swept render is audible");
    CHECK(maxDiff(a, b) == 0.0f,
          "a swept MANGLE amount renders identically at 512 and 128 samples "
          << "(max diff " << maxDiff(a, b) << ")");
    CHECK(maxDiff(a, c) == 0.0f,
          "…and at a buffer size that is not a multiple of the control block "
          << "(max diff " << maxDiff(a, c) << ")");
}

static void testMangleModulationSettlesBackToBase()
{
    std::cout << "MANGLE modulation — an envelope that decays to zero settles on base\n";

    // The reported project's other case: ENV 2 at sustain 0%. Once the envelope
    // reaches zero the instance must land exactly on its published amount and
    // stay there — a dezipper that never finished, or one that left a residue,
    // would show up as a tail that never matches the unmodulated render.
    sm::ModConfig cfg = modConfigNoRoutes();
    cfg.envs[1].decay.ms   = 20.0f;
    cfg.envs[1].sustainPct = 0.0f;
    addRoute(cfg, route(sm::kEnvSource0 + 1, sm::ModTarget::SlotMangleAmount,
                        /*index=*/0, 0.5f, /*bipolar=*/false, /*stage=*/0));

    constexpr int kN = 24000;
    juce::AudioBuffer<float> decayed = renderMangle(mg::Mode::Sync, 0.25f, cfg, kN, 512);
    juce::AudioBuffer<float> base    = renderMangle(mg::Mode::Sync, 0.25f,
                                                    modConfigNoRoutes(), kN, 512);

    // 20 ms decay at 48 kHz is ~960 samples; compare well past it.
    const int from = 8000;
    CHECK(rmsRange(base, 0, from, kN - from) > 1e-4, "the base render is audible");
    CHECK(maxDiff(decayed, base, from) < 1e-6f,
          "a decayed-to-zero envelope leaves the instance exactly on its base amount "
          << "(max diff " << maxDiff(decayed, base, from) << ")");

    // …and the two must genuinely have differed earlier, or the check above is
    // measuring a route that never did anything.
    CHECK(maxDiff(decayed, base, 0) > 1e-3f,
          "the envelope did modulate the instance before it decayed");
}

static void testMangleParamRampIsPerSample()
{
    std::cout << "MANGLE modulation — the parameter ramp is per-sample, not stepped\n";

    mg::State st;
    const int n = sm::kControlBlockSamples;
    auto design = [&](float amt, int ramp) {
        return mg::designInstance(st, static_cast<int>(mg::Mode::HardClip),
                                  amt, 1.0f, 440.0, 400.0, 0.0, 48000.0,
                                  kEngineSR, /*armRamp=*/true, ramp);
    };

    mg::Runtime rt = design(0.2f, n);
    CHECK_NEAR(rt.amount, 0.2, 1e-6, "the first design snaps to its value");
    CHECK(rt.rampLeft == 0, "the first design arms no ramp");

    rt = design(0.6f, n);
    CHECK_NEAR(rt.amount, 0.2, 1e-6, "the ramp starts from the value already in force");

    float prev = rt.amount;
    float maxJump = 0.0f;
    int moved = 0;
    for (int i = 0; i < n; ++i) {
        mg::advanceParams(rt, st);
        const float step = std::abs(rt.amount - prev);
        maxJump = std::max(maxJump, step);
        if (step > 0.0f) ++moved;
        prev = rt.amount;
    }
    CHECK(moved == n, "every sample of the block moved the amount (got " << moved << ")");
    CHECK(maxJump < (0.4f / n) * 1.01f + 1e-6f,
          "no single sample jumps more than one " << n << "th of the span "
          << "(max jump " << maxJump << ")");
    CHECK_NEAR(rt.amount, 0.6, 1e-6, "the ramp lands exactly on its target");
    CHECK_NEAR(st.amtTo, 0.6, 1e-6, "the smoothed state holds the target");
    CHECK(rt.rampLeft == 0, "the ramp is spent after exactly one control block");

    // Filter coefficients ride the same ramp — a filter mode must not step its
    // cutoff once per control block.
    mg::State fs;
    auto designF = [&](float amt, int ramp) {
        return mg::designInstance(fs, static_cast<int>(mg::Mode::Lpf),
                                  amt, 1.0f, 440.0, 400.0, 0.0, 48000.0,
                                  kEngineSR, /*armRamp=*/true, ramp);
    };
    mg::Runtime f = designF(0.2f, n);
    const float a2Start = f.a2;
    f = designF(0.9f, n);
    CHECK_NEAR(f.a2, a2Start, 1e-6, "the filter design starts where it left off");
    float prevA2 = f.a2, maxA2Jump = 0.0f;
    for (int i = 0; i < n; ++i) {
        mg::advanceParams(f, fs);
        maxA2Jump = std::max(maxA2Jump, std::abs(f.a2 - prevA2));
        prevA2 = f.a2;
    }
    const mg::Runtime target = mg::makeRuntime(static_cast<int>(mg::Mode::Lpf),
                                               0.9f, 1.0f, 440.0, 400.0, 0.0,
                                               48000.0, kEngineSR);
    CHECK_NEAR(f.a2, target.a2, 1e-6, "the coefficient ramp lands on the target design");
    CHECK(maxA2Jump < std::abs(target.a2 - a2Start) / n * 1.01f + 1e-9f,
          "the coefficient moves in per-sample steps, not one block-rate jump");
}

// A stable checksum of the rendered stream, so "unmodulated MANGLE is
// bit-identical" is a claim a future change cannot quietly break.
static uint64_t renderChecksum(const juce::AudioBuffer<float>& b)
{
    uint64_t h = 1469598103934665603ull;             // FNV-1a
    for (int ch = 0; ch < b.getNumChannels(); ++ch)
        for (int i = 0; i < b.getNumSamples(); ++i) {
            float s = b.getSample(ch, i);
            uint32_t bits;
            std::memcpy(&bits, &s, sizeof(bits));
            for (int k = 0; k < 4; ++k) {
                h ^= static_cast<uint64_t>((bits >> (k * 8)) & 0xFFu);
                h *= 1099511628211ull;
            }
        }
    return h;
}

static void testUnmodulatedMangleIsBitIdentical()
{
    std::cout << "MANGLE modulation — the unmodulated render is untouched\n";

    // Golden checksums captured from the build BEFORE the dezipper landed. The
    // modulation path must not perturb a single sample of a MANGLE render that
    // has no route on it.
    struct Case { const char* name; mg::Mode mode; float amount; uint64_t golden; };
    const Case cases[] = {
        { "SYNC", mg::Mode::Sync, 0.5f,   926315976264600255ull },
        { "LPF",  mg::Mode::Lpf,  0.8f,  4407429191224068331ull },
        { "TUBE", mg::Mode::Tube, 0.5f, 11452566751833619907ull },
        { "FM",   mg::Mode::Fm,   0.4f, 18132423014153668871ull },
    };

    const sm::ModConfig none = modConfigNoRoutes();
    for (const auto& c : cases) {
        juce::AudioBuffer<float> out = renderMangle(c.mode, c.amount, none, 24000, 512);
        const uint64_t got = renderChecksum(out);
        std::cout << "    golden[" << c.name << "] = " << got << "ull\n";
        if (c.golden != 0ull)
            CHECK(got == c.golden,
                  c.name << ": unmodulated MANGLE render is bit-identical "
                         << "(got " << got << ", want " << c.golden << ")");
    }

    // A route that exists but carries a zero offset must also degenerate to the
    // unmodulated render EXACTLY — the dezipper may not add a floor.
    juce::AudioBuffer<float> plain = renderMangle(mg::Mode::Sync, 0.5f, none, 24000, 512);
    juce::AudioBuffer<float> zeroRoute = renderMangle(
        mg::Mode::Sync, 0.5f, modConfigStaticEnvToMangleAmount(0.0f), 24000, 512);
    CHECK(maxDiff(plain, zeroRoute) == 0.0f,
          "a zero-amount MANGLE route renders bit-identically to no route "
          << "(max diff " << maxDiff(plain, zeroRoute) << ")");
}

// ─── main ────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "Running sampler modulation tests...\n\n";

    testEnvTimingMilliseconds();
    testEnvTimingBpmSync();
    testEnvSustainAndRelease();

    testLfoEnvelopeBehaviorHolds();
    testLfoRetrigLoops();
    testLfoFreeRunsWithoutNotes();
    testRetrigResetsPerVoice();
    testMonoSharesOneInstance();

    testLfoDelayAndRise();
    testLfoPhaseOffset();
    testLfoBpmRateIsAPeriod();

    testSmoothPreservesPlateaus();
    testSmoothActuallySmooths();

    testResponseCurves();
    testBipolarVsUnipolarMath();

    testDependencyOrdering();
    testTwoSourceCycleOneBlockLatency();
    testCycleDoesNotBlowUp();
    testCrossModulationHasEffect();
    testEnvStageTimeCrossModulation();
    testRouteValidation();

    testEmptyConfigIsExactBypass();
    testMangleInstanceRouting();
    testMangleStaticModulationIsContinuous();
    testMangleMovingModulationIsBufferAgnostic();
    testMangleModulationSettlesBackToBase();
    testMangleParamRampIsPerSample();
    testUnmodulatedMangleIsBitIdentical();
    testAmpEnvViaEnv1MatchesSetEnvelope();
    testAudibleVibrato();
    testMasterVolumeAndPanTargets();

    testSchemaRoundTrip();
    testSourcePresence();

    std::cout << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED (" << g_passed << " checks)\n";
        return 0;
    }
    std::cerr << "FAILED: " << g_failed << " / " << (g_passed + g_failed) << " checks\n";
    return 1;
}
