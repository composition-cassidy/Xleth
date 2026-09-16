// test_clip_fx_transform.cpp — Pitch Shifter Clip mode (mode 4) for AUDIO CLIPS.
//
// Build: see engine/CMakeLists.txt target "test_clip_fx_transform"
// Run:   ctest --test-dir build -C Release -R "^test_clip_fx_transform$" -V
// Pass:  prints "ALL TESTS PASSED" and exits 0
//
// WHAT THIS GUARDS
//
//   [1] Duration: the shifted buffer is exactly durationSamples long for all 5
//       methods at 0 (formant) / ±7 / ±12 st, plus a stretched clip; the tail
//       is not silent, and any engine undershoot is reported, not hidden.
//   [2] Mix 0 is bit-identical to the PRE-CHANGE engine (golden FNV hashes
//       captured at 6a34820 with the same driver), with the wet render ready.
//   [3] Mix 100 == the shifted render alone; Mix 50 == dry*(1-m) + wet*m per
//       sample — both bit-exact against a reference clip that plays the
//       expected signal through the untouched raw-PCM path.
//   [4] Alignment: measured lag, confidence, and the RESIDUAL lag re-measured
//       after compensation, per method (pasted by the test). Golden no-notch:
//       Mix 50 over a 100 Hz–10 kHz multitone (and a lone 1 kHz sine) never
//       drops more than 3 dB below the no-comb expectation 0.5(|D|+|W|).
//   [5] UndoManager: stack depth and history unchanged across a full mode-4
//       add / change / remove cycle, and the clip itself untouched.
//   [6] Zero allocations on the audio thread while the Mix blend runs.
//   [7] Render storm: 64 distinct clips, a 12-step semitone sweep — no job
//       during the sweep, exactly one batch (<= 64 jobs) after the settle.
//   [8] ClipRenderCache LRU cap: eviction bounds bytes, pinned audio-thread
//       references survive eviction (retirement), the hot window and export
//       suspension protect buffers, and a missed clip heals via the miss ring.
//   [9] Export parity: the offline path (setNonRealtime + export prep + wait)
//       renders the mode-4 clip bit-identically to the realtime path.

#include "clip_fx_test_scenarios.h"

#include "audio/ClipRenderCache.h"
#include "commands/TimelineCommands.h"
#include "commands/UndoManager.h"
#include "dsp/DryWetAlign.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <new>
#include <string>
#include <vector>

// ─── Counting allocator (this thread only, only while armed) ────────────────

namespace {
thread_local bool      t_countAllocs = false;
std::atomic<long long> g_allocCount { 0 };

inline void countAlloc() noexcept
{
    if (t_countAllocs) g_allocCount.fetch_add(1, std::memory_order_relaxed);
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

using namespace clipfx_test;

static const char* kMethodNames[] = { "PSOLA", "Rubber", "WSOLA", "PhaseVoc", "WORLD" };

static const ReadyFn kReady = [](MixEngine& e, int id) { return e.isClipCacheReady(id); };

static bool waitUntil(const std::function<bool()>& pred, int timeoutMs = 60000)
{
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    while (std::chrono::steady_clock::now() < deadline)
    {
        if (pred()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return pred();
}

static int64_t clipStartSample(const Scenario& s)
{
    return TickTime::fromBeats(s.clipStartBeats).toSamples(s.bpm, s.exportRate);
}

static int64_t clipLenSamples(const Scenario& s)
{
    return (TickTime::fromBeats(s.clipStartBeats) + TickTime::fromBeats(s.clipBeats)).toSamples(s.bpm, s.exportRate)
         - TickTime::fromBeats(s.clipStartBeats).toSamples(s.bpm, s.exportRate);
}

// Goertzel magnitude of `freq` over [a, b) of channel 0.
static double toneMagnitude(const juce::AudioBuffer<float>& buf, int a, int b,
                            double freq, double sampleRate)
{
    const int n = b - a;
    if (n <= 0) return 0.0;
    const double w = 2.0 * juce::MathConstants<double>::pi * freq / sampleRate;
    const double coeff = 2.0 * std::cos(w);
    double s1 = 0.0, s2 = 0.0;
    const float* x = buf.getReadPointer(0);
    for (int i = a; i < b; ++i)
    {
        const double s0 = x[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    const double p = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    return std::sqrt(std::max(0.0, p)) * 2.0 / n;
}

static std::shared_ptr<const CacheEntry> fxEntryFor(Rig& r)
{
    return r.engine->getClipRenderCache().peekEntry(r.clipId, /*fxLane=*/true);
}

// ─── [1] Duration ───────────────────────────────────────────────────────────

static void testDurationPreserved()
{
    std::cout << "\n[1] shifted buffer length == durationSamples (5 methods x 0/+-7/+-12 st)\n";
    std::cout << "    method    fx    length   duration  engineOut  undershoot  tailRMS\n";

    struct Case { int semis; bool formant; double stretch; };
    const Case cases[] = { {0, true, 1.0}, {7, false, 1.0}, {-7, false, 1.0},
                           {12, false, 1.0}, {-12, false, 1.0}, {7, false, 1.5} };

    for (int m = 0; m < 5; ++m)
    {
        for (const auto& c : cases)
        {
            if (c.stretch != 1.0 && m != 1) continue;   // one stretched case (Rubber)
            Scenario s;
            s.shifter = true; s.fxMethodChoice = m; s.fxSemis = c.semis; s.fxFormant = c.formant;
            s.stretch = c.stretch; s.mix = 1.0f; s.warm = true;
            if (c.stretch != 1.0) s.method = StretchMethod::Rubber;
            auto rig = buildRig(s, kReady);

            const auto e = fxEntryFor(rig);
            const bool ready = e && e->ready.load() && e->buffer;
            CHECK(ready, kMethodNames[m] << " fx " << c.semis << " rendered");
            if (!ready) continue;

            const int64_t dur = e->key.durationSamples;
            const int     len = e->buffer->getNumSamples();
            const auto&   rep = e->alignment;

            // Tail: the last 2048 samples must carry signal unless undershoot says otherwise.
            const int tailN = static_cast<int>(std::min<int64_t>(2048, dur));
            double tail = 0.0;
            for (int i = len - tailN; i < len; ++i)
                tail += static_cast<double>(e->buffer->getSample(0, i)) * e->buffer->getSample(0, i);
            const double tailRms = std::sqrt(tail / std::max(1, tailN));

            std::cout << "    " << std::left << std::setw(9) << kMethodNames[m] << std::right
                      << std::setw(4) << c.semis << (c.formant ? "f" : " ")
                      << (c.stretch != 1.0 ? "s" : " ")
                      << std::setw(8) << len << std::setw(11) << dur
                      << std::setw(11) << rep.engineSamples
                      << std::setw(12) << rep.undershootSamples
                      << "  " << std::fixed << std::setprecision(4) << tailRms << "\n"
                      << std::defaultfloat;

            CHECK(len == dur, kMethodNames[m] << " fx " << c.semis << ": outBuf " << len
                  << " == durationSamples " << dur);
            CHECK(dur == clipLenSamples(s), "durationSamples is the clip's own length");

            // The transform was actually applied: strongest partial near the
            // shifted fundamental (220 Hz * 2^(st/12)), scanned over +-4 st.
            if (c.semis != 0 && c.stretch == 1.0)
            {
                const double target = 220.0 * std::pow(2.0, c.semis / 12.0);
                auto peakFreq = [&](const juce::AudioBuffer<float>& buf, int a, int b)
                {
                    double bestF = 0.0, bestP = -1.0;
                    for (double cents = -400.0; cents <= 400.0; cents += 2.0)
                    {
                        const double f = target * std::pow(2.0, cents / 1200.0);
                        const double p = toneMagnitude(buf, a, b, f, 44100.0);
                        if (p > bestP) { bestP = p; bestF = f; }
                    }
                    return bestF;
                };
                const double fxF = peakFreq(*e->buffer, len / 4, 3 * len / 4);

                // Reference: the SAME engine at the SAME shift through the
                // clip's own pitch field — the pre-existing clip render path.
                Scenario ref; ref.pitchSemis = c.semis;
                ref.method = static_cast<StretchMethod>(m + 1); ref.warm = true;
                auto refRig = buildRig(ref, kReady);
                const auto refBuf = refRig.engine->getClipProcessedBuffer(refRig.clipId);
                const double refF = refBuf ? peakFreq(*refBuf, len / 4, 3 * len / 4) : 0.0;

                const double fxOff  = 1200.0 * std::log2(fxF / target);
                const double refOff = refF > 0.0 ? 1200.0 * std::log2(refF / target) : 0.0;
                std::cout << "              f0 mode-4 " << std::fixed << std::setprecision(1) << fxF
                          << " Hz (" << std::showpos << fxOff << " c)   same engine via clip pitch "
                          << std::noshowpos << refF << " Hz (" << std::showpos << refOff << " c)"
                          << std::noshowpos << std::defaultfloat
                          << (std::abs(refOff) > 25.0 ? "   <- engine itself off-target" : "") << "\n";
                CHECK(refBuf != nullptr, "reference clip-pitch render ready");
                // Mode 4 must deliver what the engine delivers — it adds no pitch error.
                CHECK(std::abs(fxOff - refOff) <= 15.0, kMethodNames[m] << " fx " << c.semis
                      << ": mode-4 fundamental " << fxF << " Hz vs same engine via clip pitch " << refF << " Hz");
            }

            if (rep.undershootSamples == 0)
                CHECK(tailRms > 1e-3, kMethodNames[m] << " fx " << c.semis
                      << ": no silent tail when no undershoot is reported (rms " << tailRms << ")");
            else
                CHECK(rep.undershootSamples <= dur, "undershoot is reported within the buffer");
        }
    }
}

// ─── [2] Mix 0 golden ───────────────────────────────────────────────────────

static void testMixZeroGolden()
{
    std::cout << "\n[2] Mix 0 bit-identical to the pre-change engine (goldens from 6a34820)\n";

    Scenario g1; g1.velocity = 0.8f; g1.fadeInPct = 10.0f; g1.fadeOutPct = 20.0f;
    Scenario g2; g2.bakeRate = 48000.0; g2.srcChannels = 1;
    Scenario g3; g3.pitchSemis = 5; g3.method = StretchMethod::Rubber; g3.warm = true;
    Scenario g4; g4.reversed = true; g4.warm = true;
    Scenario g5 = g1; g5.shifter = true; g5.fxSemis = 7; g5.mix = 0.0f; g5.warm = true;
    Scenario g6 = g3; g6.shifter = true; g6.fxSemis = -3; g6.fxMethodChoice = 0; g6.mix = 0.0f;
    Scenario g7 = g2; g7.shifter = true; g7.fxSemis = 12; g7.mix = 0.0f; g7.warm = true;

    struct G { const char* name; Scenario s; std::uint64_t golden; };
    const G all[] = {
        { "g1 identity+fades",          g1, 0x6f288f9daa053fb1ULL },
        { "g2 identity cross-rate",     g2, 0xdac6329f8418cf63ULL },
        { "g3 pitched cache hit",       g3, 0x976d82cc09a8e09cULL },
        { "g4 reversed cache hit",      g4, 0x08a218c6dd3ec5bdULL },
        { "g5 = g1 + Clip +7 mix 0",    g5, 0x6f288f9daa053fb1ULL },
        { "g6 = g3 + Clip -3 PSOLA m0", g6, 0x976d82cc09a8e09cULL },
        { "g7 = g2 + Clip +12 mix 0",   g7, 0xdac6329f8418cf63ULL },
    };
    for (const auto& g : all)
    {
        auto rig = buildRig(g.s, kReady);
        if (g.s.shifter)
            CHECK(rig.engine->getClipFxProcessedBuffer(rig.clipId) != nullptr,
                  g.name << ": wet render is live (the Mix-0 path had a wet to ignore)");
        const auto out = renderRig(rig, g.s);
        const auto h = hashBuffer(out);
        std::cout << "    " << std::left << std::setw(28) << g.name << std::right
                  << " 0x" << std::hex << std::setw(16) << std::setfill('0') << h
                  << (h == g.golden ? "  == golden" : "  != golden 0x") ;
        if (h != g.golden) std::cout << std::setw(16) << g.golden;
        std::cout << std::dec << std::setfill(' ') << "\n";
        CHECK(h == g.golden, g.name << ": bit-identical to the pre-change output");
    }
}

// ─── [3] Mix 100 and mid-mix formula ────────────────────────────────────────

static juce::AudioBuffer<float> renderReferenceClip(const Scenario& base,
                                                    const juce::AudioBuffer<float>& signal)
{
    // A plain identity clip whose SOURCE is the expected clip signal: it goes
    // through today's raw-PCM path (sample * gain), so any difference against
    // the mode-4 render is a difference in the blend itself.
    Scenario ref = base;
    ref.shifter = false; ref.warm = false; ref.pitchSemis = 0; ref.pitchCents = 0;
    ref.regionOffsetBeats = 0.0; ref.customSource = &signal; ref.bakeRate = base.exportRate;
    return render(ref, kReady);
}

static double maxAbsDiff(const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
{
    double d = 0.0;
    const int n = std::min(a.getNumSamples(), b.getNumSamples());
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < n; ++i)
            d = std::max(d, std::abs(static_cast<double>(a.getSample(ch, i)) - b.getSample(ch, i)));
    return d;
}

static void testMixHundredAndFormula()
{
    std::cout << "\n[3] Mix 100 == shifted only; Mix 50 == dry*(1-m) + wet*m per sample\n";

    Scenario s; s.shifter = true; s.fxSemis = 7; s.fxMethodChoice = 1; s.warm = true;

    // Mix 100
    s.mix = 1.0f;
    auto rig1 = buildRig(s, kReady);
    const auto wet = rig1.engine->getClipFxProcessedBuffer(rig1.clipId);
    CHECK(wet != nullptr, "wet ready");
    if (!wet) return;
    const auto out100 = renderRig(rig1, s);
    const auto ref100 = renderReferenceClip(s, *wet);
    const double d100 = maxAbsDiff(out100, ref100);
    std::cout << "    Mix 100 vs shifted-only reference: max |diff| = " << d100
              << "  hash " << std::hex << hashBuffer(out100) << " / " << hashBuffer(ref100) << std::dec << "\n";
    CHECK(hashBuffer(out100) == hashBuffer(ref100), "Mix 100 output is bit-identical to the shifted render alone");

    // Mix 50 and Mix 25, against the per-sample formula.
    for (const float m : { 0.5f, 0.25f })
    {
        s.mix = m;
        auto rig = buildRig(s, kReady);
        const auto w = rig.engine->getClipFxProcessedBuffer(rig.clipId);
        CHECK(w != nullptr, "wet ready (mix " << m << ")");
        if (!w) return;

        // dry = the raw source segment (identity clip, regionOffset 0)
        const auto tone = makeTone(s.srcChannels, s.bakeRate, s.srcSeconds, s.srcFreq, s.srcAm);
        const int n = w->getNumSamples();
        juce::AudioBuffer<float> expected(2, n);
        for (int ch = 0; ch < 2; ++ch)
            for (int i = 0; i < n; ++i)
            {
                const float dry = tone.getSample(ch, i);
                const float wt  = w->getSample(std::min(ch, w->getNumChannels() - 1), i);
                expected.setSample(ch, i, dry * (1.0f - m) + wt * m);
            }
        const auto out = renderRig(rig, s);
        const auto ref = renderReferenceClip(s, expected);
        const double d = maxAbsDiff(out, ref);
        std::cout << "    Mix " << m * 100 << " vs formula reference: max |diff| = " << d << "\n";
        CHECK(d == 0.0, "Mix " << m * 100 << ": output matches dry*(1-m) + wet*m exactly (max diff " << d << ")");

        // And the render actually differs from both endpoints.
        CHECK(maxAbsDiff(out, out100) > 1e-3, "Mix " << m * 100 << " is not the wet alone");
    }
}

// ─── [4] Alignment + golden no-notch ────────────────────────────────────────

static juce::AudioBuffer<float> makeMultitone(double rate, double seconds, bool singleKHz)
{
    const int n = static_cast<int>(rate * seconds);
    juce::AudioBuffer<float> b(2, n);
    b.clear();
    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    for (int k = 0; k <= 24; ++k)
    {
        const double f = singleKHz ? 1000.0 : 100.0 * std::pow(100.0, k / 24.0);
        const double amp = singleKHz ? 0.5 : 0.03;
        const double phase = 0.7 * k * k;
        for (int ch = 0; ch < 2; ++ch)
        {
            float* d = b.getWritePointer(ch);
            for (int i = 0; i < n; ++i)
                d[i] += static_cast<float>(amp * std::sin(twoPi * f * i / rate + phase));
        }
        if (singleKHz) break;
    }
    return b;
}

static void testAlignmentAndNoNotch()
{
    std::cout << "\n[4] dry/wet alignment per method (measured, applied, residual after compensation)\n";
    std::cout << "    method    fx   basis     peak   measuredLag  applied  residualLag  confident\n";

    const auto multitone = makeMultitone(44100.0, 1.5, false);
    const auto sine1k    = makeMultitone(44100.0, 1.5, true);

    struct NotchRow { int method; double worstDb; double worstHz; bool multiConfident; int multiLag;
                      double kHzDb; bool kHzConfident; int kHzLag; };
    std::vector<NotchRow> notchRows;

    for (int m = 0; m < 5; ++m)
    {
        // (a) Alignment report on harmonic material, same pitch and shifted.
        for (const auto& fx : { std::pair<int, bool>{0, true}, std::pair<int, bool>{7, false} })
        {
            Scenario s; s.shifter = true; s.fxMethodChoice = m; s.fxSemis = fx.first;
            s.fxFormant = fx.second; s.warm = true; s.mix = 1.0f; s.clipBeats = 2.0;
            auto rig = buildRig(s, kReady);
            const auto e = fxEntryFor(rig);
            if (!(e && e->ready.load())) { CHECK(false, kMethodNames[m] << " wet ready"); continue; }

            const auto tone = makeTone(s.srcChannels, s.bakeRate, s.srcSeconds, s.srcFreq, s.srcAm);
            const int n = e->buffer->getNumSamples();
            const auto residual = xleth::dsp::estimateWetLag(tone, n, *e->buffer, n,
                                                             4410, fx.first == 0, 44100.0);
            const auto& rep = e->alignment;
            std::cout << "    " << std::left << std::setw(9) << kMethodNames[m] << std::right
                      << std::setw(4) << fx.first << (fx.second ? "f" : " ")
                      << std::setw(8) << (rep.basis == 1 ? "wave" : rep.basis == 2 ? "env" : "none")
                      << std::setw(9) << std::fixed << std::setprecision(3) << rep.peak << std::defaultfloat
                      << std::setw(13) << rep.measuredLag << std::setw(9) << rep.appliedLag
                      << std::setw(13) << residual.lagSamples
                      << std::setw(11) << (rep.confident ? "yes" : "NO (reported)") << "\n";

            CHECK(rep.measured, kMethodNames[m] << ": alignment was measured");
            if (rep.confident)
                CHECK(std::abs(residual.lagSamples) <= 1,
                      kMethodNames[m] << " fx " << fx.first << ": residual lag "
                      << residual.lagSamples << " after compensating " << rep.appliedLag);
            else
                CHECK(rep.appliedLag == 0, kMethodNames[m] << ": no compensation applied when not confident");
        }

        // (b) Golden no-notch at Mix 50 (same pitch: formant-only transform).
        NotchRow row { m, 0.0, 0.0, false, 0, 0.0, false, 0 };
        for (const bool single : { false, true })
        {
            Scenario s; s.shifter = true; s.fxMethodChoice = m; s.fxSemis = 0; s.fxFormant = true;
            s.clipBeats = 2.0; s.customSource = single ? &sine1k : &multitone; s.warm = true;

            s.mix = 0.0f; auto rigD = buildRig(s, kReady); const auto dry = renderRig(rigD, s);
            s.mix = 1.0f; auto rigW = buildRig(s, kReady); const auto wet = renderRig(rigW, s);
            s.mix = 0.5f; auto rigM = buildRig(s, kReady); const auto mix = renderRig(rigM, s);
            const auto e = fxEntryFor(rigM);
            const bool confident = e && e->alignment.confident;
            const int  lag       = e ? e->alignment.appliedLag : 0;
            if (e && !confident)
                CHECK(rigM.engine->getClipRenderCache().unalignedRenderCount() >= 1,
                      kMethodNames[m] << ": a non-confident alignment is counted (reported)");

            const int a = static_cast<int>(clipStartSample(s) + clipLenSamples(s) / 4);
            const int b = static_cast<int>(clipStartSample(s) + 3 * clipLenSamples(s) / 4);
            double worst = 0.0, worstHz = 0.0;
            for (int k = 0; k <= 24; ++k)
            {
                const double f = single ? 1000.0 : 100.0 * std::pow(100.0, k / 24.0);
                const double D = toneMagnitude(dry, a, b, f, 44100.0);
                const double W = toneMagnitude(wet, a, b, f, 44100.0);
                const double M = toneMagnitude(mix, a, b, f, 44100.0);
                const double expect = 0.5 * (D + W);
                const double db = expect > 1e-9 ? 20.0 * std::log10(std::max(M, 1e-12) / expect) : 0.0;
                if (k == 0 || db < worst) { worst = db; worstHz = f; }
                if (single) break;
            }
            if (single) { row.kHzDb = worst; row.kHzConfident = confident; row.kHzLag = lag; }
            else        { row.worstDb = worst; row.worstHz = worstHz; row.multiConfident = confident; row.multiLag = lag; }
        }
        notchRows.push_back(row);
    }

    auto alignedText = [](bool confident, int lag)
    {
        return confident ? "aligned(" + std::to_string(lag) + ")" : std::string("NOT ALIGNED - reported");
    };
    std::cout << "\n    golden no-notch @ Mix 50 (fx 0 st + formant; level vs 0.5(|D|+|W|))\n";
    std::cout << "    method    multitone worst dB  at Hz   alignment                1kHz sine dB  alignment\n";
    for (const auto& r : notchRows)
    {
        std::cout << "    " << std::left << std::setw(9) << kMethodNames[r.method] << std::right
                  << std::setw(12) << std::fixed << std::setprecision(2) << r.worstDb
                  << std::setw(13) << std::setprecision(0) << r.worstHz << std::defaultfloat
                  << "   " << std::left << std::setw(25) << alignedText(r.multiConfident, r.multiLag) << std::right
                  << std::setw(10) << std::fixed << std::setprecision(2) << r.kHzDb << std::defaultfloat
                  << "   " << alignedText(r.kHzConfident, r.kHzLag) << "\n";
        if (r.multiConfident)
            CHECK(r.worstDb >= -3.0, kMethodNames[r.method] << ": no notch below -3 dB across 100 Hz-10 kHz (worst "
                  << r.worstDb << " dB at " << r.worstHz << " Hz)");
        if (r.kHzConfident)
            CHECK(r.kHzDb >= -3.0, kMethodNames[r.method] << ": 1 kHz sine at Mix 50 within 3 dB (" << r.kHzDb << ")");
    }
    // The gate must actually gate something: Rubber Band is a delay-free
    // resynthesis at 0 st and has to be aligned and notch-free.
    CHECK(notchRows.size() == 5 && notchRows[1].multiConfident && notchRows[1].kHzConfident,
          "Rubber Band aligns confidently on both signals");
}

// ─── [5] UndoManager ────────────────────────────────────────────────────────

static void testUndoStackUntouched()
{
    std::cout << "\n[5] UndoManager stack unchanged across mode-4 add/change/remove\n";

    Scenario s; s.warm = false;
    auto rig = buildRig(s, kReady);
    UndoManager undo(100);

    // A real history entry so "unchanged" is not trivially "empty".
    Clip extra = *rig.timeline->getClip(rig.clipId);
    extra.position = TickTime::fromBeats(3.0);
    undo.execute(std::make_unique<AddClipCommand>(extra), *rig.timeline);

    const auto undoBefore = undo.getUndoHistory();
    const auto redoBefore = undo.getRedoHistory();
    const Clip clipBefore = *rig.timeline->getClip(rig.clipId);
    const auto clipsBefore = rig.timeline->getAllClips().size();

    auto& e = *rig.engine;
    const int node = e.addEffect(rig.trackId, "pitchshifter", 0);
    e.setEffectParameter(rig.trackId, node, "mode", 3.0f);
    e.setEffectParameter(rig.trackId, node, "clip_semitones", 5.0f);
    e.pollSourceTransformTableAt(ClipRenderCache::nowMs(), true);
    e.flushSourceTransformInvalidations(ClipRenderCache::nowMs(), true);
    CHECK(waitUntil([&] { return e.isClipCacheReady(rig.clipId); }), "add: wet rendered");
    renderRig(rig, s);

    e.setEffectParameter(rig.trackId, node, "clip_semitones", -9.0f);
    e.setEffectParameter(rig.trackId, node, "clip_method", 3.0f);
    e.pollSourceTransformTableAt(ClipRenderCache::nowMs(), true);
    e.flushSourceTransformInvalidations(ClipRenderCache::nowMs(), true);
    CHECK(waitUntil([&] { return e.isClipCacheReady(rig.clipId); }), "change: wet re-rendered");
    renderRig(rig, s);

    CHECK(e.removeEffect(rig.trackId, node), "remove");
    e.pollSourceTransformTableAt(ClipRenderCache::nowMs(), true);
    e.flushSourceTransformInvalidations(ClipRenderCache::nowMs(), true);
    renderRig(rig, s);
    CHECK(e.getClipRenderCache().peekEntry(rig.clipId, true) == nullptr, "remove: fx lane dropped");

    const auto undoAfter = undo.getUndoHistory();
    const auto redoAfter = undo.getRedoHistory();
    bool same = undoAfter.size() == undoBefore.size() && redoAfter.size() == redoBefore.size();
    for (std::size_t i = 0; same && i < undoAfter.size(); ++i)
        same = undoAfter[i].description == undoBefore[i].description
            && undoAfter[i].domain == undoBefore[i].domain;
    std::cout << "    undo " << undoBefore.size() << " -> " << undoAfter.size()
              << ", redo " << redoBefore.size() << " -> " << redoAfter.size() << "\n";
    CHECK(same, "undo/redo history identical");
    CHECK(undo.getUndoCount() == 1 && undo.getRedoCount() == 0, "stack depth unchanged");

    const Clip& c = *rig.timeline->getClip(rig.clipId);
    CHECK(rig.timeline->getAllClips().size() == clipsBefore, "no clips added/removed");
    CHECK(c.pitchOffset == clipBefore.pitchOffset && c.pitchOffsetCents == clipBefore.pitchOffsetCents
          && c.stretchRatio == clipBefore.stretchRatio && c.stretchMethod == clipBefore.stretchMethod
          && c.position == clipBefore.position && c.duration == clipBefore.duration,
          "the clip itself is untouched (render-path only)");
}

// ─── [6] Zero allocations on the blend path ─────────────────────────────────

static long long countBlockAllocs(Scenario s, bool* wetLive = nullptr)
{
    auto rig = buildRig(s, kReady);
    if (wetLive) *wetLive = rig.engine->getClipFxProcessedBuffer(rig.clipId) != nullptr;
    renderRig(rig, s);
    Transport transport;
    transport.setSampleRate(s.exportRate); transport.setBPM(s.bpm);
    transport.seekToSample(0); transport.play();
    juce::AudioBuffer<float> block(2, 512);
    const int total = static_cast<int>(clipStartSample(s) + clipLenSamples(s));
    long long allocs = 0;
    for (int pos = 0; pos < total; pos += 512)
    {
        block.clear();
        g_allocCount.store(0);
        t_countAllocs = true;
        rig.engine->processBlock(block, 512, transport);
        t_countAllocs = false;
        allocs += g_allocCount.load();
        transport.advance(512);
    }
    return allocs;
}

static void testBlendPathAllocationFree()
{
    std::cout << "\n[6] zero allocations on the audio thread from the Mix blend\n";

    // processBlock ALREADY allocates on this thread, before mode 4 (measured
    // on an identity clip with no chain at all). So the blend path is proven
    // allocation-free differentially: the SAME chain, clip, cache state and
    // block count, with the transform active (wet ready, Mix 50 blend running
    // every sample) versus inactive (Clip mode at 0 st, no formant → no table
    // entry → today's path). Any allocation the blend makes shows up as a
    // difference.
    Scenario plain;
    const long long baseline = countBlockAllocs(plain);

    Scenario inactive; inactive.shifter = true; inactive.fxSemis = 0; inactive.fxFormant = false;
    inactive.mix = 0.5f; inactive.pitchSemis = 2; inactive.method = StretchMethod::Rubber; inactive.warm = true;
    const long long off = countBlockAllocs(inactive);

    Scenario active = inactive; active.fxSemis = 4;
    bool wetLive = false, wetLiveOff = true;
    countBlockAllocs(inactive, &wetLiveOff);
    const long long on = countBlockAllocs(active, &wetLive);
    CHECK(wetLive && !wetLiveOff, "active case had a live wet; inactive case had none");

    std::cout << "    pre-existing, identity clip, no chain:        " << baseline << " allocations\n";
    std::cout << "    Clip-mode shifter, transform INACTIVE (today): " << off << " allocations\n";
    std::cout << "    Clip-mode shifter, Mix 50 blend ACTIVE:        " << on << " allocations\n";
    std::cout << "    attributable to the blend path: " << (on - off) << "\n";
    CHECK(on == off, "the Mix blend adds no allocation (active " << on << " vs inactive " << off << ")");
}


// ─── [7] Render storm ───────────────────────────────────────────────────────

static void testRenderStorm()
{
    std::cout << "\n[7] render storm: 64-clip track, 12-step semitone sweep\n";

    Scenario s;
    auto rig = buildRig(s, kReady);
    auto& e = *rig.engine;
    auto& cache = e.getClipRenderCache();

    // 63 more clips, each a distinct slice of the region (distinct keys, no sharing).
    Clip proto = *rig.timeline->getClip(rig.clipId);
    std::vector<int> ids { rig.clipId };
    for (int i = 1; i < 64; ++i)
    {
        Clip c = proto;
        c.position     = TickTime::fromBeats(0.25 + 0.1 * i);
        c.duration     = TickTime::fromBeats(0.1);
        c.regionOffset = TickTime::fromBeats(0.01 * i);
        ids.push_back(rig.timeline->addClip(c));
    }

    const int node = e.addEffect(rig.trackId, "pitchshifter", 0);
    e.setEffectParameter(rig.trackId, node, "mode", 3.0f);
    e.setEffectParameter(rig.trackId, node, "clip_semitones", 1.0f);
    const uint64_t jobs0 = cache.submittedRenderCount();
    const int64_t t0 = ClipRenderCache::nowMs() + 100000;   // synthetic clock, ahead of real time
    e.pollSourceTransformTableAt(t0, true);
    CHECK(cache.submittedRenderCount() == jobs0, "change detected: nothing submitted before the settle");
    CHECK(e.flushSourceTransformInvalidations(t0 + 100) == 0, "not due at +100 ms");
    const int first = e.flushSourceTransformInvalidations(t0 + MixEngine::kSourceTransformSettleMs);
    const uint64_t jobs1 = cache.submittedRenderCount();
    std::cout << "    initial: flush invalidated " << first << " clips, " << jobs1 - jobs0 << " jobs\n";
    CHECK(first == 64 && jobs1 - jobs0 == 64, "initial transform: one batch of 64 jobs");
    CHECK(waitUntil([&] { for (int id : ids) if (!e.isClipCacheReady(id)) return false; return true; }),
          "initial renders complete");

    // Sweep: 12 commits 40 ms apart — every one inside the previous one's settle.
    Transport transport;
    transport.setSampleRate(s.exportRate); transport.setBPM(s.bpm);
    transport.seekToSample(0); transport.play();
    juce::AudioBuffer<float> block(2, 512);

    int64_t t = t0 + 1000;
    int republishes = 0;
    for (int semis = 2; semis <= 13; ++semis, t += 40)
    {
        e.setEffectParameter(rig.trackId, node, "clip_semitones", static_cast<float>(semis));
        republishes += e.pollSourceTransformTableAt(t, true) ? 1 : 0;
        for (int b = 0; b < 8; ++b)   // play through clips: stale-key misses pile up
        {
            block.clear();
            e.processBlock(block, 512, transport);
            transport.advance(512);
        }
        e.serviceClipRenderCache();   // drains those misses — must not resubmit a settling track
    }
    const uint64_t jobsDuringSweep = cache.submittedRenderCount() - jobs1;
    const int settled = e.flushSourceTransformInvalidations(t - 40 + MixEngine::kSourceTransformSettleMs);
    const uint64_t jobsAfter = cache.submittedRenderCount() - jobs1;
    std::cout << "    sweep: " << republishes << " republishes, " << jobsDuringSweep
              << " jobs during the sweep, flush invalidated " << settled << " clips, "
              << jobsAfter << " jobs total (undebounced would be " << 12 * 64 << ")\n";
    CHECK(republishes == 12, "every sweep step was seen by the table");
    CHECK(jobsDuringSweep == 0, "no render submitted while the track was settling");
    CHECK(settled == 64, "one settle flush covers the whole track");
    CHECK(jobsAfter <= 64, "bounded: at most one job per clip after the debounce (" << jobsAfter << ")");
    CHECK(waitUntil([&] { for (int id : ids) if (!e.isClipCacheReady(id)) return false; return true; }),
          "final renders complete");
    const auto fe = cache.peekEntry(rig.clipId, true);
    CHECK(fe && fe->key.fxPitchSemis == 13, "the settled render is the LAST sweep value");
}

// ─── [8] LRU cap ────────────────────────────────────────────────────────────

static void testLruCap()
{
    std::cout << "\n[8] ClipRenderCache LRU byte cap, retirement, hot window, export suspension\n";

    Scenario s; s.pitchSemis = 3; s.method = StretchMethod::Rubber;
    auto rig = buildRig(s, kReady);
    auto& e = *rig.engine;
    auto& cache = e.getClipRenderCache();
    std::cout << "    default cap: " << cache.maxBytes() / (1024 * 1024) << " MB\n";
    CHECK(cache.maxBytes() == 512ull * 1024 * 1024, "default cap is 512 MB");

    Clip proto = *rig.timeline->getClip(rig.clipId);
    std::vector<int> ids { rig.clipId };
    for (int i = 1; i < 8; ++i)
    {
        Clip c = proto;
        c.pitchOffset = 3 + i;   // distinct keys
        c.position = TickTime::fromBeats(0.25 + i);
        ids.push_back(rig.timeline->addClip(c));
    }
    for (int id : ids) e.invalidateClipCache(id, "lru");
    CHECK(waitUntil([&] { for (int id : ids) if (!e.isClipCacheReady(id)) return false; return true; }),
          "8 renders resident");
    const size_t perEntry = cache.currentBytes() / ids.size();
    std::cout << "    resident " << cache.residentEntryCount() << " entries, " << cache.currentBytes() << " bytes\n";
    CHECK(cache.residentEntryCount() == 8, "8 resident entries");

    // Pin one entry the way the audio thread does, then shrink the cap.
    const auto key0 = e.buildClipCacheKey(*rig.timeline->getClip(rig.clipId),
                                          *rig.bank->getSample(rig.sampleId));
    auto pinned = cache.acquire(rig.clipId, key0, ClipRenderCache::nowMs() - 1000000);
    CHECK(pinned != nullptr, "pinned an entry");
    const float probe = pinned ? pinned->buffer->getSample(0, 1000) : 0.0f;

    // Hot window protects everything just published / played.
    cache.setHotWindowMs(60000);
    for (int id : ids) cache.acquire(id, e.buildClipCacheKey(*rig.timeline->getClip(id), *rig.bank->getSample(rig.sampleId)), ClipRenderCache::nowMs());
    const auto over0 = cache.overCapEvents();
    cache.setMaxBytes(perEntry * 3);
    CHECK(cache.evictionCount() == 0 && cache.overCapEvents() > over0,
          "hot entries are never evicted; the over-cap condition is counted");

    // Export suspension.
    cache.setHotWindowMs(0);
    e.setNonRealtime(true);
    cache.setMaxBytes(perEntry * 3 + 1);
    CHECK(cache.evictionCount() == 0, "no eviction while an export runs");
    e.setNonRealtime(false);   // deferred pass runs here
    std::cout << "    after export end: resident " << cache.residentEntryCount() << ", bytes " << cache.currentBytes()
              << " (cap " << cache.maxBytes() << "), evictions " << cache.evictionCount()
              << ", retired " << cache.retiredCount() << "\n";
    CHECK(cache.currentBytes() <= cache.maxBytes(), "bytes bounded by the cap");
    CHECK(cache.evictionCount() >= 5, "LRU evicted down to the cap");

    // The pinned entry was evicted (it was the least recently used) but its
    // buffer is still valid: retirement kept it alive.
    const bool evictedPinned = cache.peekEntry(rig.clipId, false) == nullptr;
    CHECK(evictedPinned, "the pinned (oldest) entry was evicted");
    CHECK(pinned && pinned->buffer->getSample(0, 1000) == probe, "pinned buffer still readable after eviction");
    CHECK(cache.retiredCount() >= 1, "evicted-but-pinned entry is parked on the retire list");
    pinned.reset();   // "audio thread" lets go — it is NOT the last owner
    CHECK(cache.retiredCount() == 0, "retire list frees it once it is the sole owner");

    // Miss ring heal: play the evicted clip, service, and it comes back.
    cache.setMaxBytes(ClipRenderCache::kDefaultMaxBytes);
    Transport transport;
    transport.setSampleRate(s.exportRate); transport.setBPM(s.bpm);
    transport.seekToSample(clipStartSample(s)); transport.play();
    juce::AudioBuffer<float> block(2, 512);
    e.processBlock(block, 512, transport);
    e.serviceClipRenderCache();
    CHECK(waitUntil([&] { return e.isClipCacheReady(rig.clipId); }), "evicted clip re-rendered via the miss ring");
}

// ─── [9] Export parity ──────────────────────────────────────────────────────

static void testExportParity()
{
    std::cout << "\n[9] export parity: offline path == realtime path for a mode-4 clip\n";

    Scenario s; s.shifter = true; s.fxSemis = -5; s.fxMethodChoice = 1; s.mix = 0.5f; s.warm = true;
    s.pitchSemis = 2; s.method = StretchMethod::Rubber;

    auto live = buildRig(s, kReady);
    const auto a = renderRig(live, s);

    // The export sequence XlethEngineService runs before OfflineRenderer /
    // AudioExporter spawn, minus the thread: setNonRealtime + prepare, publish
    // the table with no settle, refresh every clip that needs a render, await.
    Scenario cold = s; cold.warm = false;
    auto exp = buildRig(cold, kReady);
    exp.engine->setNonRealtime(true);
    exp.engine->prepare(s.exportRate, 512);
    exp.engine->prepareSourceTransformsForExport();
    for (const Clip* c : exp.timeline->getAllClips())
        if (exp.engine->clipNeedsCacheRender(*c)) exp.engine->invalidateClipCache(c->id, "export");
    CHECK(waitUntil([&] { return exp.engine->isClipCacheReady(exp.clipId); }), "export wait: both renders ready");
    const auto b = renderRig(exp, s);
    exp.engine->setNonRealtime(false);

    std::cout << "    realtime 0x" << std::hex << hashBuffer(a) << "  offline 0x" << hashBuffer(b) << std::dec << "\n";
    CHECK(hashBuffer(a) == hashBuffer(b), "offline render is bit-identical to realtime");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << std::unitbuf;   // a crash must not swallow the report so far
    std::cout << "=== test_clip_fx_transform ===\n";

    testMixZeroGolden();
    testMixHundredAndFormula();
    testExportParity();
    testUndoStackUntouched();
    testBlendPathAllocationFree();
    testRenderStorm();
    testLruCap();
    testDurationPreserved();
    testAlignmentAndNoNotch();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0)
    {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    return 1;
}
