// test_auto_loop_policy — unit tests + parity diagnostic for the selection-first
// AUTO loop policy (dsp/AutoLoopPolicy.h), the C++ port of loop_optimizer's
// policy v2.
//
// Two modes, following test_loop_optimizer's convention:
//
//   • No args: run synthetic unit tests (known-answer invariants). CI gate.
//   • Args `<buffer.f32> <sampleRate> <selStart> <selEnd> [formant <winStart> <winEnd>]`:
//     load a raw little-endian float32 mono buffer and print a one-line JSON
//     result (+ timing). The parity harness (tools/loop_optimizer parity script)
//     dumps the SAME ingested buffer the Python reference analyses, so the two
//     operate on identical samples and the only differences measured are the
//     algorithm port itself (NSDF-vs-YIN period, LPC formants).
//
//     The optional `formant` tail dumps the per-frame F1-F3 (Hz) track over
//     [winStart, winEnd) for diffing against loop_optimizer.formants.

#include "dsp/AutoLoopPolicy.h"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

static constexpr double kPi = 3.14159265358979323846;

using namespace xleth::dsp;

namespace {

int g_failures = 0;

void check(bool cond, const char* what)
{
    if (!cond) { std::printf("  FAIL: %s\n", what); ++g_failures; }
    else       std::printf("  ok:   %s\n", what);
}

// A band-limited periodic tone: fundamental + a few harmonics. Deterministic.
std::vector<float> makeTone(int n, double period, double sampleRate, double f2Hz = 0.0)
{
    (void)sampleRate;
    std::vector<float> x((size_t)n);
    const double w = 2.0 * kPi / period;
    for (int i = 0; i < n; ++i) {
        double v = std::sin(w * i) + 0.5 * std::sin(2.0 * w * i) + 0.25 * std::sin(3.0 * w * i);
        if (f2Hz > 0.0) v += 0.4 * std::sin(2.0 * kPi * f2Hz * i / sampleRate);
        x[(size_t)i] = (float)(0.3 * v);
    }
    return x;
}

void testSteadyToneLoops()
{
    std::printf("[testSteadyToneLoops]\n");
    const double sr = 44100.0, period = 200.0;  // 220.5 Hz
    const int n = 44100;                         // 1 s
    std::vector<float> x = makeTone(n, period, sr);

    // Selection well inside the tone.
    const AutoLoopResult r = autoLoopForSelection(x.data(), n, sr, 8000, 30000);
    check(r.valid, "valid result on a steady tone");
    check(r.period > 195.0 && r.period < 205.0, "period recovered near 200 samples");

    const int64_t length = r.loopEnd - r.loopStart;
    const double k = (double)length / r.period;
    check(std::abs(k - std::round(k)) < 0.05, "loop length is an integer period multiple");
    check(r.crossfadeSamples > 0, "crossfade is nonzero");

    // The audible advance = length - xfade must also be a whole period multiple
    // (the engine's FL-style wrap skips the fade-in on wrap).
    const double adv = (double)(length - r.crossfadeSamples) / r.period;
    check(std::abs(adv - std::round(adv)) < 0.1, "advance is an integer period multiple");

    // Loop points inside the selection window (±15% margin).
    check(r.loopStart >= 8000 - 3300 && r.loopEnd <= 30000 + 3300, "loop inside padded selection");
}

void testWholeSampleFallback()
{
    std::printf("[testWholeSampleFallback]\n");
    const double sr = 44100.0, period = 147.0;
    const int n = 30000;
    std::vector<float> x = makeTone(n, period, sr);
    const AutoLoopResult r = autoLoopForSelection(x.data(), n, sr, 0, n);
    check(r.valid, "valid on whole-sample selection");
    check(r.crossfadeSamples <= (r.loopEnd - r.loopStart) / 2, "xfade <= half loop (clamp honoured)");
}

void testRefusesSilence()
{
    std::printf("[testRefusesSilence]\n");
    std::vector<float> x(20000, 0.0f);
    const AutoLoopResult r = autoLoopForSelection(x.data(), (int)x.size(), 44100.0, 2000, 18000);
    check(!r.valid, "refuses silent material");
}

void testFormantFrameResolves()
{
    std::printf("[testFormantFrameResolves]\n");
    // A glottal-ish pulse train through two resonances ~700 / ~1800 Hz: a crude
    // synthetic vowel. We only assert the tracker resolves ordered formants in a
    // plausible range, not exact values.
    const double sr = 44100.0;
    const int n = (int)std::llround(kFormantFrameMs * 0.001 * sr);
    std::vector<float> frame((size_t)n);
    for (int i = 0; i < n; ++i) {
        const double t = i / sr;
        frame[(size_t)i] = (float)(0.5 * std::sin(2 * kPi * 700 * t)
                                 + 0.3 * std::sin(2 * kPi * 1800 * t)
                                 + 0.15 * std::sin(2 * kPi * 2600 * t));
    }
    const std::array<double, kNumFormants> f = frameFormantsHz(frame.data(), n, sr);
    check(std::isfinite(f[0]) && std::isfinite(f[1]), "F1 and F2 resolved");
    check(f[0] < f[1], "formants sorted ascending");
    check(f[0] > 400.0 && f[0] < 1100.0, "F1 in a plausible band");
}

int runUnitTests()
{
    std::printf("=== test_auto_loop_policy ===\n");
    testSteadyToneLoops();
    testWholeSampleFallback();
    testRefusesSilence();
    testFormantFrameResolves();
    std::printf("=== %s (%d failure%s) ===\n", g_failures ? "FAILED" : "PASSED",
                g_failures, g_failures == 1 ? "" : "s");
    return g_failures ? 1 : 0;
}

std::vector<float> readF32(const char* path)
{
    std::vector<float> v;
    FILE* f = std::fopen(path, "rb");
    if (!f) { std::fprintf(stderr, "cannot open %s\n", path); return v; }
    std::fseek(f, 0, SEEK_END);
    long bytes = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    v.resize((size_t)(bytes / (long)sizeof(float)));
    if (!v.empty()) { size_t rd = std::fread(v.data(), sizeof(float), v.size(), f); (void)rd; }
    std::fclose(f);
    return v;
}

int runDiagnostic(int argc, char** argv)
{
    const std::vector<float> x = readF32(argv[1]);
    const double sr = std::atof(argv[2]);
    const int64_t selStart = std::atoll(argv[3]);
    const int64_t selEnd = std::atoll(argv[4]);
    const int N = (int)x.size();

    // Optional formant-track dump.
    if (argc >= 8 && std::string(argv[5]) == "formant") {
        const int64_t ws = std::atoll(argv[6]), we = std::atoll(argv[7]);
        const int frameLen = std::max(8, (int)std::llround(kFormantFrameMs * 0.001 * sr));
        const int hop = std::max(1, (int)std::llround(kFormantHopMs * 0.001 * sr));
        std::printf("[");
        bool first = true;
        for (int64_t s = ws; s + frameLen <= we && s + frameLen <= N; s += hop) {
            const std::array<double, kNumFormants> f = frameFormantsHz(x.data() + s, frameLen, sr);
            std::printf("%s[%.2f,%.2f,%.2f]", first ? "" : ",", f[0], f[1], f[2]);
            first = false;
        }
        std::printf("]\n");
        return 0;
    }

    // Per-hop median period (for NSDF-vs-YIN validation).
    const double periodWin = periodInWindow(x.data(), N, sr, selStart, selEnd);

    const auto t0 = std::chrono::steady_clock::now();
    const AutoLoopResult r = autoLoopForSelection(x.data(), N, sr, selStart, selEnd);
    const auto t1 = std::chrono::steady_clock::now();
    const double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

    std::string gates = "[";
    for (size_t i = 0; i < r.gatesBound.size(); ++i)
        gates += (i ? ",\"" : "\"") + r.gatesBound[i] + "\"";
    gates += "]";

    std::printf(
        "{\"valid\":%s,\"loopStart\":%lld,\"loopEnd\":%lld,\"crossfadeSamples\":%lld,"
        "\"period\":%.6f,\"periodInWindow\":%.6f,\"periodMultiple\":%d,\"maxXfade\":%d,"
        "\"spanDriftCents\":%.4f,\"driftCutCents\":%.4f,\"selectionMedianDriftCents\":%.4f,"
        "\"spansConsidered\":%d,\"spansKept\":%d,\"longestSpan\":%lld,\"gatesBound\":%s,"
        "\"reason\":\"%s\",\"elapsedMs\":%.3f}\n",
        r.valid ? "true" : "false", (long long)r.loopStart, (long long)r.loopEnd,
        (long long)r.crossfadeSamples, r.period, periodWin, r.periodMultiple, r.maxXfade,
        r.spanDriftCents, r.driftCutCents, r.selectionMedianDriftCents, r.spansConsidered,
        r.spansKept, (long long)r.longestSpan, gates.c_str(), r.reason.c_str(), ms);
    return 0;
}

} // namespace

int main(int argc, char** argv)
{
    if (argc >= 5) return runDiagnostic(argc, argv);
    return runUnitTests();
}
