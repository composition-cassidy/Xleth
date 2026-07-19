// test_loop_optimizer.cpp — Unit tests for the Auto Loop Optimizer's steady-
// state window detection and loop-candidate generation (dsp/LoopOptimizer.h).
//
// Build: see engine/CMakeLists.txt target "test_loop_optimizer"
// Run (unit tests):  test_loop_optimizer.exe
//   Pass: prints "ALL TESTS PASSED" and exits 0. Fail: prints "FAIL ..." exit 1.
// Run (diagnostic):  test_loop_optimizer.exe path\to\mono16.wav
//   Loads the WAV and prints the detected window, period and every candidate to
//   stdout. This is a real-material sanity tool, NOT a pass/fail gate — it always
//   exits 0 once the file loads, whatever the analysis finds.
//
// This is the highest-risk phase in the feature, so every unit case is synthetic
// with a KNOWN correct answer and asserts real numbers (true period within a
// sample, k=1 seam ≈ 1, no harmonic lock) rather than pinning a baseline.

#include "dsp/LoopOptimizer.h"
#include "dsp/LoopAnalysis.h"

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <vector>

using namespace xleth::dsp;

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (cond) { ++g_passed; }                                               \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; ++g_failed; } \
    } while (0)

static constexpr double kSR = 48000.0;

// ── Synthetic signal builders ────────────────────────────────────────────────

static std::vector<float> makeSine(int n, double freqHz, double sampleRate)
{
    std::vector<float> v((size_t)n);
    const double w = 2.0 * juce::MathConstants<double>::pi * freqHz / sampleRate;
    for (int i = 0; i < n; ++i)
        v[(size_t)i] = (float)std::sin(w * i);
    return v;
}

// Fundamental f0 plus a decaying harmonic series — a stand-in for a pad or vocal
// chop, whose spectrum has strong overtones that trip naive autocorrelation into
// locking onto a harmonic (period/2) or subharmonic (2*period).
static std::vector<float> makeHarmonic(int n, double f0, double sampleRate)
{
    std::vector<float> v((size_t)n, 0.0f);
    const double amps[] = {1.0, 0.6, 0.4, 0.25, 0.15};
    for (int h = 0; h < 5; ++h) {
        const double w = 2.0 * juce::MathConstants<double>::pi * f0 * (h + 1) / sampleRate;
        for (int i = 0; i < n; ++i)
            v[(size_t)i] += (float)(amps[h] * std::sin(w * i));
    }
    // Normalise so the peak sits near unity, purely to keep the numbers readable.
    float peak = 0.0f;
    for (float s : v) peak = std::max(peak, std::abs(s));
    if (peak > 0.0f) for (float& s : v) s /= peak;
    return v;
}

// A one-shot: near-instant attack, exponential decay, no sustain. tauMs controls
// how fast it dies — small enough here that no run of frames holds above 50% of
// peak for the viability floor.
static std::vector<float> makeOneShot(int n, double freqHz, double sampleRate, double tauMs)
{
    std::vector<float> v((size_t)n);
    const double w   = 2.0 * juce::MathConstants<double>::pi * freqHz / sampleRate;
    const double tau = tauMs * 0.001 * sampleRate;  // decay constant in samples
    for (int i = 0; i < n; ++i)
        v[(size_t)i] = (float)(std::exp(-i / tau) * std::sin(w * i));
    return v;
}

// Deterministic uniform noise in [-amp, amp] — a fixed LCG keeps the "loud
// unvoiced segment" reproducible across runs and platforms.
static std::vector<float> makeNoise(int n, double amp, std::uint32_t seed)
{
    std::vector<float> v((size_t)n);
    std::uint32_t s = seed;
    for (int i = 0; i < n; ++i) {
        s = s * 1664525u + 1013904223u;
        const float u = (float)((double)(s >> 8) / (double)(1u << 24)) * 2.0f - 1.0f;
        v[(size_t)i] = (float)(amp * u);
    }
    return v;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// Pure sine: period detected within a sample, and a k=1 candidate exists whose
// seam correlates near-perfectly (one period of a sine is identical to the next).
static void testPureSine()
{
    const double freq   = 200.0;                 // → 240-sample period at 48 kHz
    const int    period = (int)std::lround(kSR / freq);
    const int    N      = (int)kSR;              // 1 s
    const auto   x      = makeSine(N, freq, kSR);

    // Auto-detected window on a steady sine should span essentially the whole
    // buffer (flat envelope → one plateau).
    const LoopWindow w = detectSteadyStateWindow(x.data(), N, kSR);
    CHECK(w.end - w.start > (int64_t)(0.9 * N), "pure sine: window should cover ~all of a steady tone");

    const auto cands = generateLoopCandidates(x.data(), N, kSR, w);
    CHECK(!cands.empty(), "pure sine: expected at least one candidate");
    if (cands.empty()) return;

    // Period is quantized to the true fundamental within a sample.
    CHECK(std::abs(cands[0].periodSamples - period) <= 1,
          "pure sine: periodSamples " << cands[0].periodSamples << " != " << period << " (±1)");

    // A k=1 candidate must exist and its seam must be near-perfect.
    bool haveK1 = false;
    for (const auto& c : cands) {
        if (c.periodMultiple == 1) {
            haveK1 = true;
            CHECK(c.seamNcc > 0.99f, "pure sine: k=1 seamNcc " << c.seamNcc << " should be ≈ 1");
            CHECK(c.loopEnd - c.loopStart >= period - 2 && c.loopEnd - c.loopStart <= period + 2,
                  "pure sine: k=1 loop length " << (c.loopEnd - c.loopStart) << " should be ≈ one period");
        }
    }
    CHECK(haveK1, "pure sine: expected a k=1 candidate");

    // Every candidate is a whole-period multiple and stays inside the window.
    for (const auto& c : cands) {
        CHECK(c.loopStart >= w.start && c.loopEnd <= w.end, "pure sine: candidate outside window");
        CHECK(c.crossfadeSamples >= kMinClickSuppressionSamples
                  || c.crossfadeSamples == (c.loopEnd - c.loopStart) / 2,
              "pure sine: crossfade below floor without being half-loop clamped");
        CHECK(c.crossfadeSamples <= (c.loopEnd - c.loopStart) / 2, "pure sine: crossfade exceeds half the loop");
    }
}

// Additive tone with harmonics: the detected period must be the FUNDAMENTAL, not
// a harmonic (period/2) or subharmonic (2*period). This is the real, previously
// observed failure mode — naive autocorrelation on two of the corpus samples
// locked onto a harmonic and a 1/3-period subharmonic. McLeod/NSDF with the
// clarity threshold is supposed to avoid it; this proves it on a known signal.
static void testHarmonicFundamental()
{
    const double f0     = 150.0;                 // → 320-sample period
    const int    period = (int)std::lround(kSR / f0);
    const int    N      = (int)kSR;
    const auto   x      = makeHarmonic(N, f0, kSR);

    const LoopWindow w = detectSteadyStateWindow(x.data(), N, kSR);
    const auto cands = generateLoopCandidates(x.data(), N, kSR, w);
    CHECK(!cands.empty(), "harmonic: expected candidates for a strongly pitched tone");
    if (cands.empty()) return;

    const int detected = cands[0].periodSamples;
    CHECK(std::abs(detected - period) <= 2,
          "harmonic: periodSamples " << detected << " != fundamental " << period << " (±2)");
    // Spell out the two wrong answers explicitly so a regression names itself.
    CHECK(std::abs(detected - period / 2) > 4, "harmonic: locked onto the 2nd harmonic (period/2)");
    CHECK(std::abs(detected - period * 2) > 4, "harmonic: locked onto the subharmonic (2*period)");

    // The fundamental's seam should still correlate well.
    CHECK(cands[0].seamNcc > 0.9f, "harmonic: k=1 seamNcc " << cands[0].seamNcc << " unexpectedly low");
}

// Silent and DC buffers: no crash, no NaN, empty candidates. A silent buffer also
// yields an empty steady-state window (the one-shot-refusal path).
static void testSilenceAndDC()
{
    const int N = (int)kSR;

    std::vector<float> silent((size_t)N, 0.0f);
    const LoopWindow ws = detectSteadyStateWindow(silent.data(), N, kSR);
    CHECK(ws.start == 0 && ws.end == 0, "silence: expected empty window");
    const auto cs = generateLoopCandidates(silent.data(), N, kSR, LoopWindow{0, N});
    CHECK(cs.empty(), "silence: expected no candidates");

    // DC: nonzero constant. It has RMS, so it may register a window, but it has no
    // varying shape to correlate, so no candidate can clear the seam floor.
    std::vector<float> dc((size_t)N, 0.5f);
    const auto cdc = generateLoopCandidates(dc.data(), N, kSR, LoopWindow{0, N});
    CHECK(cdc.empty(), "DC: expected no candidates (zero-variance seam)");
    for (const auto& c : cdc) CHECK(std::isfinite(c.seamNcc), "DC: seamNcc not finite");
}

// A one-shot with a sharp attack and fast decay has no sustain: the steady-state
// detector must refuse it with an empty window.
static void testOneShotRefused()
{
    const int  N = (int)(0.4 * kSR);             // 400 ms total
    const auto x = makeOneShot(N, 220.0, kSR, /*tauMs*/ 15.0);
    const LoopWindow w = detectSteadyStateWindow(x.data(), N, kSR);
    CHECK(w.start == 0 && w.end == 0,
          "one-shot: expected empty window, got [" << w.start << "," << w.end << ")");
}

// Regression guard for the exact failure this fix addresses (observed on
// Pitch_17_C3): a QUIET but cleanly-voiced tone sitting next to a LOUDER unvoiced
// noise burst. RMS-only windowing anchors its threshold to the loud noise and
// selects it, so the optimizer refuses a perfectly loopable tone. Voicing-aware
// windowing must land on the tonal region instead — the noise is never voiced, so
// it can neither set the level bar nor be chosen as the plateau.
static void testVoicedRegionOverLoudNoise()
{
    const int toneLen = (int)(0.5 * kSR);        // 0.5 s of quiet clean tone
    const int noiseLen = (int)(0.5 * kSR);       // 0.5 s of loud noise after it
    const int N = toneLen + noiseLen;
    const double freq = 200.0;                   // 240-sample period
    const int    period = (int)std::lround(kSR / freq);

    std::vector<float> x((size_t)N, 0.0f);
    const auto tone  = makeSine(toneLen, freq, kSR);          // amplitude 1.0…
    for (int i = 0; i < toneLen; ++i) x[(size_t)i] = 0.2f * tone[(size_t)i];  // …scaled quiet
    const auto noise = makeNoise(noiseLen, /*amp*/ 0.9, /*seed*/ 0xC0FFEEu);  // loud, unvoiced
    for (int i = 0; i < noiseLen; ++i) x[(size_t)(toneLen + i)] = noise[(size_t)i];

    // Sanity: the noise really is louder than the tone, so an RMS-only detector
    // would be pulled onto it. (This is what makes the test meaningful.)
    const float toneRms  = computeRMS(x.data(), toneLen);
    const float noiseRms = computeRMS(x.data() + toneLen, noiseLen);
    CHECK(noiseRms > toneRms, "noise-vs-tone: setup should have louder noise than tone");

    const LoopWindow w = detectSteadyStateWindow(x.data(), N, kSR);
    CHECK(w.end > w.start, "noise-adjacent: expected a non-empty window on the tone");
    // The window must sit on the tonal region, not the loud noise. A frame that
    // straddles the tone→noise boundary can be voiced, so allow at most one
    // analysis frame of spill past toneLen; the start must be inside the tone.
    CHECK(w.start < toneLen, "noise-adjacent: window started in the loud noise region ("
                                 << w.start << " >= " << toneLen << ")");
    CHECK(w.end <= (int64_t)toneLen + kAnalysisFrame,
          "noise-adjacent: window extended into the loud noise region (end " << w.end << ")");

    // And the window must be usable: candidates at the tone's true period.
    const auto cands = generateLoopCandidates(x.data(), N, kSR, w);
    CHECK(!cands.empty(), "noise-adjacent: expected candidates on the tonal window");
    if (!cands.empty())
        CHECK(std::abs(cands[0].periodSamples - period) <= 3,
              "noise-adjacent: periodSamples " << cands[0].periodSamples << " != " << period);
}

// A window narrower than one period must return empty rather than crash or emit a
// degenerate candidate. 150 Hz has a 320-sample period; the window is 200 samples.
static void testSubPeriodWindow()
{
    const int  N = (int)kSR;
    const auto x = makeSine(N, 150.0, kSR);
    const auto cands = generateLoopCandidates(x.data(), N, kSR, LoopWindow{0, 200});
    CHECK(cands.empty(), "sub-period window: expected no candidates");
}

// A window shorter than even the minimum lag (and a zero-length window) must be
// handled without reading out of bounds.
static void testDegenerateWindows()
{
    const int  N = (int)kSR;
    const auto x = makeSine(N, 200.0, kSR);

    const auto tiny = generateLoopCandidates(x.data(), N, kSR, LoopWindow{100, 110});
    CHECK(tiny.empty(), "10-sample window: expected empty");

    const auto zero = generateLoopCandidates(x.data(), N, kSR, LoopWindow{500, 500});
    CHECK(zero.empty(), "zero-length window: expected empty");

    // Out-of-range window is clamped, not trusted.
    const auto oob = generateLoopCandidates(x.data(), N, kSR, LoopWindow{-1000, N + 1000});
    for (const auto& c : oob)
        CHECK(c.loopStart >= 0 && c.loopEnd <= N, "OOB window: candidate escaped the buffer");
}

// ── Diagnostic mode ───────────────────────────────────────────────────────────

// Replicates the optimizer's per-hop gate math purely to REPORT it, so the
// diagnostic can show the detected period, voiced fraction and median clarity
// even when the material fails the gate and generateLoopCandidates returns empty.
// This is observation only; it must mirror LoopOptimizer.cpp's constants.
static void reportPerHopAnalysis(const float* x, int N, double sampleRate, LoopWindow window)
{
    const int wStart = (int)std::max<int64_t>(0, window.start);
    const int wEnd   = (int)std::min<int64_t>(N, window.end);
    const int winLen = wEnd - wStart;
    if (winLen <= 0) { std::cout << "  (empty window — no per-hop analysis)\n"; return; }

    const int tauMin   = std::max(1, (int)(sampleRate / kMaxPitchHz));
    const int tauMax   = (int)(sampleRate / kMinPitchHz);
    const int frameLen = std::min(kAnalysisFrame, winLen);

    std::vector<int>   periods;
    std::vector<float> clarity;
    int totalHops = 0;
    for (int s = wStart; s + frameLen <= wEnd; s += kAnalysisHop) {
        ++totalHops;
        const auto nsdf = computeNSDF(x + s, frameLen, tauMin, tauMax);
        const int p = detectPeriod(nsdf, tauMin);
        if (p <= 0) continue;
        const int idx = p - tauMin;
        if (idx < 0 || idx >= (int)nsdf.size()) continue;
        periods.push_back(p);
        clarity.push_back(nsdf[(size_t)idx]);
    }

    const double voicedFrac = totalHops > 0 ? (double)periods.size() / totalHops : 0.0;
    int   medPeriod = 0;
    float medClar   = 0.0f;
    if (!periods.empty()) {
        auto ps = periods; std::sort(ps.begin(), ps.end()); medPeriod = ps[ps.size() / 2];
        auto cs = clarity; std::sort(cs.begin(), cs.end()); medClar   = cs[cs.size() / 2];
    }
    std::cout << "  hops=" << totalHops << " voiced=" << periods.size()
              << " (" << (int)(voicedFrac * 100.0) << "%)"
              << "  median period=" << medPeriod << " samp";
    if (medPeriod > 0) std::cout << " (" << (sampleRate / medPeriod) << " Hz)";
    std::cout << "  median clarity=" << medClar
              << "  [gate: voiced>" << (int)(kMinVoicedFrac * 100) << "% & clarity>=" << kMinMedianClarity << "]\n";
}

static int runDiagnostic(const char* path)
{
    juce::AudioFormatManager fm;
    fm.registerBasicFormats();

    juce::File f(juce::String::fromUTF8(path));
    std::unique_ptr<juce::AudioFormatReader> reader(fm.createReaderFor(f));
    if (reader == nullptr) {
        std::cerr << "diagnostic: could not open '" << path << "'\n";
        return 2;
    }

    const int    N  = (int)reader->lengthInSamples;
    const double sr = reader->sampleRate;
    juce::AudioBuffer<float> buf((int)reader->numChannels, N);
    reader->read(&buf, 0, N, 0, true, true);

    // Fold to mono: the optimizer analyses a single channel.
    std::vector<float> mono((size_t)N, 0.0f);
    for (int ch = 0; ch < buf.getNumChannels(); ++ch) {
        const float* p = buf.getReadPointer(ch);
        for (int i = 0; i < N; ++i) mono[(size_t)i] += p[i];
    }
    if (buf.getNumChannels() > 1)
        for (float& s : mono) s /= (float)buf.getNumChannels();

    std::cout << "── Loop Optimizer diagnostic ──────────────────────────────\n";
    std::cout << "file: " << path << "\n";
    std::cout << "samples=" << N << "  sampleRate=" << sr
              << "  duration=" << (N / sr) << " s  channels=" << reader->numChannels << "\n\n";

    const LoopWindow w = detectSteadyStateWindow(mono.data(), N, sr);
    std::cout << "detectSteadyStateWindow: ";
    if (w.start == 0 && w.end == 0) std::cout << "EMPTY (no sustain / refused)\n";
    else std::cout << "[" << w.start << ", " << w.end << ")  len=" << (w.end - w.start)
                   << " samp (" << ((w.end - w.start) / sr) << " s)\n";

    // Report the gate inputs over the detected window (or the whole file if the
    // detector refused, so we can still see why).
    std::cout << "per-hop over detected window:\n";
    reportPerHopAnalysis(mono.data(), N, sr, (w.end > w.start) ? w : LoopWindow{0, N});

    const auto cands = generateLoopCandidates(mono.data(), N, sr, w);
    std::cout << "\ngenerateLoopCandidates: " << cands.size() << " candidate(s)\n";
    for (size_t i = 0; i < cands.size(); ++i) {
        const auto& c = cands[i];
        std::cout << "  #" << i
                  << "  k=" << c.periodMultiple
                  << "  period=" << c.periodSamples
                  << "  loop=[" << c.loopStart << ", " << c.loopEnd << ")"
                  << "  len=" << (c.loopEnd - c.loopStart)
                  << "  xfade=" << c.crossfadeSamples
                  << "  seamNcc=" << c.seamNcc << "\n";
    }
    std::cout << "───────────────────────────────────────────────────────────\n";
    return 0;  // diagnostic is never a pass/fail gate
}

int main(int argc, char** argv)
{
    // A path argument switches to diagnostic mode; no arguments runs unit tests.
    if (argc >= 2)
        return runDiagnostic(argv[1]);

    testPureSine();
    testHarmonicFundamental();
    testSilenceAndDC();
    testOneShotRefused();
    testVoicedRegionOverLoudNoise();
    testSubPeriodWindow();
    testDegenerateWindows();

    std::cout << "\ntest_loop_optimizer: " << g_passed << " checks passed, "
              << g_failed << " failed\n";
    if (g_failed == 0) { std::cout << "ALL TESTS PASSED\n"; return 0; }
    std::cout << "TESTS FAILED\n";
    return 1;
}
