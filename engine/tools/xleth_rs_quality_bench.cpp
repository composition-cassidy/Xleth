// xleth_rs_quality_bench - offline quality bench for the resonance suppressors.
//
// Measurement baseline for the planned RS / EQ-Spectral rewrite
// (docs/RESONANCE_SUPPRESSOR_AUDIT.md section 4). Instantiates the effects
// directly and drives them block-by-block: no engine, bridge or audio device.
// Reports NUMBERS ONLY; it makes no better/worse judgement.
//
// Subjects (48 kHz stereo; latency + scan also at 44.1 kHz):
//   S1 RS Low Latency            S2 RS High Quality / Fast
//   S3 RS High Quality / Normal  S4 RS High Quality / High
//   S5 EQ, one Spectral band (centre retargeted per resonance, gain/depth -12 dB)
//   "sensitive" variants (jitter / false-trigger test only):
//   S1s..S4s depth 100 %, selectivity 0 %;  S5s EQ spec_sens 1.0 (as specified),
//   S5z EQ spec_sens 0.0 (see note: in the EQ detector, LOW sens = MORE sensitive).
//
// Everything is deterministic (fixed seeds, no wall clock) except the CPU run
// and the output-directory timestamp. Console prefix: [RSBench].
//
// Capability variants (max-depth runs, in addition to the default-parameter subjects):
//   S1c RS LL depth 100 / Hard;  S2c-S4c RS HQ Fast/Normal/High depth 100 / Hard;
//   S5c EQ Spectral band gain -30 dB (max depth), spec_sens 0.0 (most sensitive).
//
// Yardstick: ideal_dB = mean dB boost of the planted RBJ bell over the same
// f0 +/- 1/6 oct Welch-bin window as removed_dB; removed/ideal % is printed next to
// every removed_dB. Detector-geometry check (section 10) reads the RS detector
// baseline through the existing XLETH_RESONANCE_SUPPRESSOR_TEST_HOOKS hook.
//
// v3 (residual vs clean + gates):
//   Residual metrics compare the output with the UNPROCESSED clean signal C (signal A is C filtered by
//   the planted bell, so an ideal suppressor's output equals C): in_window_residual_dB (ideal 0; >0 =
//   resonance remains; <0 = over-suppression) and outside_dev_dB. removed_dB / ideal_dB is kept but is
//   informational only (it exceeds 100 % whenever the output goes BELOW the unboosted spectrum).
//   S5q = EQ Spectral band gain -30 dB, spec_sens 0.0, band Q 8, centre = f0 (the "fair" EQ variant).
//   Gate table (G1..G6, fixed thresholds in the kGate* constants below) grades every subject that is
//   registered with gated = true. ONE registration in registry() adds a subject everywhere (scan, jitter,
//   pre-echo, E, latency, CPU, gates); a subject that is not one of the built-in kinds can supply a
//   `factory`. --cpu-only runs just the CPU benchmark (default subjects, blocks 64/128/512).
//
// v4 (gate hardening; no production source involved):
//   G3 now also gates the UNTOUCHED left channel of signal E (resonance in R only): |in_window| <= 1.0 dB AND outside_dev <= 0.5 dB at every one of
//   the 12 scan f0 (signal E is run at all 12 f0; the R gates stay at 2500 Hz). S5qd = EQ Spectral band gain -30 dB, band Q 8, spec_sens at its DEFAULT
//   (S5q's 0.0 sets threshold = local mean, i.e. over-suppresses by construction). Shape scans at f0 2500 Hz / 48 kHz vary the planted Q {4, 8, 16} at +12 dB
//   and the level {+12, +18} dB at Q 8 (gates G1q/G2q out of 3, G1l/G2l out of 2; ideal recomputed per case; processors are not retuned). G7 = relative CPU:
//   mean %RT / S3's mean %RT in the SAME run <= 1.0 at block 128 and 64 (gated variants get their own CPU run at those two blocks).
//
// v5 (time-varying resonance; no production source involved): every planted resonance in v1-v4 is STATIC, so the bench rewards long detector averaging
//   (the core's detector uses a 200 ms averaging time). Signal T1 switches the +12 dB / Q 8 bell ON and OFF by 5 ms linear crossfades between the clean pink noise C and the
//   bell-filtered noise A built from the SAME noise (the clean reference is exact), 6 events per case, on-durations D in {100, 300, 1000} ms, f0 in {500, 2500, 8000} Hz, one signal per
//   (f0, D). Metrics (STFT 1024 Hann hop 128, in-window = f0 +/- 1/6 oct, latency-aligned, events aligned at their onsets): reaction (t50 / t90 / leak_fraction) and release behaviour
//   (r_off(T) after the offset); gates G8a, G8b (reaction) and G9a, G9b (release) are graded for every gated subject and are part of the overall verdict. Section "T1" below has the definitions;
//   calibration: R0 pass-through must FAIL G8, the oracle R1 (returns the clean reference through Planted::cleanRef, delayed by its latency) must PASS G8 and G9.
// v6: the v5 release gates (over_dB >= -3 dB, settle <= 400 ms) were unsatisfiable by any effective suppressor with a nonzero release (the clean signal is still cut by the depth reached at the
//   offset) and are now informational; G9a / G9b gate whether the cut is GONE: |r_off(500 ms)| <= 1.0 dB and |r_off(1000 ms)| <= 0.5 dB. tau_fit (effective release constant) is reported.
//
// Usage: xleth_rs_quality_bench [--quick] [--no-cpu] [--cpu-only] [--out-dir DIR]
//                               [--ref-subjects] [--subjects ID,ID,...] [--wav label=path]...
//                               [--seed N] [--cpu-worst] [--d1-reconcile] [--core-tau MS] [--core-fast MS]
//   --subjects runs only the listed subjects (iteration speed). Each kept subject's G4 jitter companion and S3 (the
//   G7 CPU reference) are kept automatically. Without it every registered subject runs (default output unchanged).
//   --core-tau MS sets the ResonanceCore detector averaging time constant for C1 / C1c / C1s and tables 10c / 10d
//   (study runs; 0 / absent = the core's default).
//   --seed N shifts the noise seeds of every generated signal (A-E, T1, D, CPU) by N x 1000003; 0 / absent = the original seeds
//   (default output unchanged). Gates and metrics do not read it. Use it to check that a pass is not a lucky noise realisation.
//
// Hardening (after the core's stage C; bench only, no gate threshold or metric definition touched):
//   Known limits: G1 at f0 = 100 Hz is WAIVED by name for C1c, C1c-N and C1c-H (knownLimits() below). The raw G1 count stays visible, the
//   verdict reads "PASS (1 waiver)" when everything else passes, no other subject / frequency is affected.
//   --wav inputs additionally get real-material proxy metrics (table G2): per 1/6-octave band cut, flicker, fraction of frames with a > 6 dB cut.
//   --cpu-worst: per-block timing of C1c and S3c at blocks 64 / 128 on pink noise with a resonance toggling every 2 s (informational).
//   --d1-reconcile: the core's applied cut (bandReductionDb) next to the bench's -r_off(T) on the 9 T1 signals (informational).
//
// Seed protocol (after the tier study; bench only, no threshold or metric definition touched, default output bit-identical):
//   --seedset default|dev|heldout grades EVERY gate once per seed of the set (default = seed 0, dev = 1..6, heldout = 101..106) and writes, next to the per-seed run directories,
//   seedset_gates.csv / seedset_cells.csv / seedset_verdict.csv / summary.md: per gate and per cell the seeds passing, the worst margin (value vs the unchanged limit) and the median value
//   over the seeds. A gate counts as passed in the "robust verdict" only if it passes on EVERY seed of the set (the named G1 waiver applies per seed exactly as in the single-seed verdict).
//   The single-seed verdict is unchanged. TUNING WORK USES DEFAULT + DEV ONLY; the heldout set (101..106) is RESERVED: it is run only for the final confirmation by the person grading.
//   --seedset cannot be combined with --seed (the set chooses the seeds).
//   --corr-diag (diagnostic, no gate): G1 @ 150 Hz and G8a @ 500 Hz of RSC-N / RSC-N0 / C1c-N on dev seeds 1..6 with independent AND fully correlated (R == L) noise; see runCorrDiag().
//
// RS New engine subjects (after the integration): RSC-F0 / RSC-N0 / RSC-H0 (stereo link 0, focus curve open 20 Hz - 20 kHz = the C1c settings through the effect) are graded on every gate
//   against C1c-F / C1c-N / C1c-H; RSC-F / RSC-N / RSC-H (RS defaults, stereo link 100 %) are a characterisation set whose G3 / G9a are printed but not graded (Subject::notGraded).
//   The named G1 100 Hz waiver covers the same tiers as for C1c-*: RSC-N / RSC-H / RSC-N0 / RSC-H0.
//   --cpu-burst: N instances (default 8) of C1c-N and S3c processed back to back per block in one thread on pink noise, hop phases aligned vs staggered (informational, see runCpuBurst()).
//
// [EQCore] Param EQ subjects (the EQ's Spectral bands on the ResonanceCore, spectral_engine = Core): one Spectral band at -24 dB (core depth 1, Hard), its
//   spec_attack / spec_release set to the core defaults 15 / 200 ms, spec_sens / spec_sel default (core sensitivity 0.5), the weight curve opened (no curve:
//   one band covering the whole range) and stereo link 0: EQS-F / EQS-N / EQS-H = the C1c-F / -N / -H settings through the EQ, graded on every gate against
//   C1c-*. EQSl-F / -N / -H: the same at the EQ's default stereo link 1 (characterisation: G3 / G9a printed, not graded). EQSb-N: EQS-N with three flat
//   (0 dB) bell bands in the EQ's biquad path behind the core (diagnostic: does the EQ's signal path change anything). G4 companions EQSs-* / EQSsl-*
//   (spec_sens 0 = core sensitivity 1). The named G1 100 Hz waiver is NOT extended to them (no gate or waiver is changed).
//
// ResonanceCore (stage 1, src/dsp/ResonanceCore.*, wired into no effect) is graded through a bench-only adapter:
//   C1 default Params (gated), C1c depth 1 / Hard (gated), C1s depth 1 / sensitivity 1 / Hard (G4 companion of both).
//   Tables 10c / 10d read the core's detector (baseline lift by planted shape / f0; predicted vs measured noise sigma).
//   --ref-subjects registers two reference subjects (R0 pass-through, R1 oracle = exact inverse of the planted bell on exactly the planted channels with the
//   planted Q / level, built through Subject::factory(bell descriptor)) so the residual metrics and gates can be calibrated: R0 must FAIL G1/G3, R1 must PASS
//   G1-G6. Off by default (default output unchanged).

// Test-only read access to the RS detector baseline (same define as
// engine/test/test_pdc_stage1.cpp). Adds only static members; must precede the
// first include of the RS header. No production source is modified.
#define XLETH_RESONANCE_SUPPRESSOR_TEST_HOOKS 1

#include "audio/XlethEQEffect.h"
#include "audio/XlethResonanceSuppressorEffect.h"
#include "dsp/ResonanceCore.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <numeric>
#include <sstream>
#include <tuple>
#include <string>
#include <utility>
#include <vector>

#if defined(_MSC_VER)
  #include <intrin.h>
#endif

namespace fs = std::filesystem;

// ============================================================================
// Logging / formatting
// ============================================================================

static int g_nonFinite = 0;   // count of NaN/Inf values that reached a table
static int g_warnings  = 0;

static void logf(const char* fmt, ...)
{
    std::printf("[RSBench] ");
    va_list ap; va_start(ap, fmt);
    std::vprintf(fmt, ap);
    va_end(ap);
    std::printf("\n");
    std::fflush(stdout);
}

static void warnf(const char* fmt, ...)
{
    ++g_warnings;
    char buf[1024];
    va_list ap; va_start(ap, fmt);
    std::vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    std::printf("[RSBench] WARNING: %s\n", buf);
    std::fflush(stdout);
}

static std::string num(double v, int prec = 4)
{
    if (!std::isfinite(v)) { ++g_nonFinite; return "NaN"; }
    char b[64];
    std::snprintf(b, sizeof b, "%.*f", prec, v);
    return b;
}

static std::string inum(long long v) { return std::to_string(v); }

// 10*log10 with a floor so an exact zero prints as -300 rather than -inf.
static double dbPow(double p)  { return 10.0 * std::log10(std::max(p, 1.0e-30)); }
static double dbAmp(double a)  { return 20.0 * std::log10(std::max(a, 1.0e-15)); }

// ============================================================================
// Result tables
// ============================================================================

struct Table
{
    std::string title;
    std::string note;
    std::vector<std::string> header;
    std::vector<std::vector<std::string>> rows;

    void add(std::vector<std::string> r) { rows.push_back(std::move(r)); }

    std::string csv() const
    {
        std::ostringstream o;
        for (size_t i = 0; i < header.size(); ++i) o << (i ? "," : "") << header[i];
        o << "\n";
        for (auto& r : rows)
        {
            for (size_t i = 0; i < r.size(); ++i) o << (i ? "," : "") << r[i];
            o << "\n";
        }
        return o.str();
    }

    std::string markdown() const
    {
        std::ostringstream o;
        o << "### " << title << "\n\n";
        if (!note.empty()) o << note << "\n\n";
        o << "|";
        for (auto& h : header) o << " " << h << " |";
        o << "\n|";
        for (size_t i = 0; i < header.size(); ++i)
            o << ((i == 0 || header[i] == "label" || header[i] == "params") ? "---|" : "---:|");
        o << "\n";
        for (auto& r : rows)
        {
            o << "|";
            for (auto& c : r) o << " " << c << " |";
            o << "\n";
        }
        o << "\n";
        return o.str();
    }
};

// ============================================================================
// Options
// ============================================================================

struct Options
{
    bool quick  = false;
    bool noCpu  = false;
    bool cpuOnly = false;
    bool refSubjects = false;   // register the pass-through + oracle reference subjects (metric / gate calibration)
    float coreTauMs = 0.0f;              // --core-tau MS: ResonanceCore detector time constant for C1/C1c/C1s and tables 10c/10d (0 = core default)
    float coreFastMs = -1.0f;            // --core-fast MS: fast-path time constant of the ResonanceCore (0 = fast path off, <0 = core default)
    std::vector<std::string> subjects;   // --subjects A,B,C: run only these (plus their G4 jitter companions and S3, the G7 reference); empty = all
    std::string outBase = "bench_out";
    std::vector<std::pair<std::string, std::string>> wavs;   // label, path
    uint64_t seed = 0;                   // --seed N: shifts the noise seeds of every generated signal (0 = the original seeds; default output unchanged)
    bool cpuWorst = false;               // --cpu-worst: worst-case per-block CPU study (C1c / S3c, blocks 64 / 128, resonance toggling every 2 s)
    bool d1Reconcile = false;            // --d1-reconcile: the core's applied cut vs the bench's r_off(T) on the 9 T1 signals (C1c)
    std::string seedset;                 // --seedset default|dev|heldout: grade every gate per seed of the set + robust verdict (empty = single run)
    bool cpuBurst = false;               // --cpu-burst: multi-instance per-block burst study (C1c-N / S3c, aligned vs staggered hop phases)
    int burstInstances = 8;              // --burst-instances N
    double burstSeconds = 60.0;          // --burst-seconds S: signal length of one burst repetition (3 repetitions, aligned / staggered interleaved)
    std::string burstStagger = "preroll";// --burst-stagger preroll|core: how hop phases are staggered (preroll = bench-only, feeds i*hop/N silent samples first)
    bool corrNoise = false;              // --corr-noise (diagnostic, set by --corr-diag only): both channels of every pink-noise signal use the SAME noise (R == L); default off = independent L/R, output unchanged
    bool corrDiag = false;               // --corr-diag: G1 @ 150 Hz and G8a @ 500 Hz of RSC-N / RSC-N0 / C1c-N on dev seeds 1..6, with independent and with fully correlated L/R noise (diagnostic, no gate)
};

static Options g_opt;
static int g_burstCoreHopOffset = 0;   // --cpu-burst --burst-stagger core: hop phase offset (samples) the core factory applies to the instance being built (bench only; 0 = default)

// --seed N: an offset added to every noise seed (signals A-E, T1, CPU, D bursts). 0 for the default seeds, so default output is bit-identical.
// Neither a gate nor a metric reads it.
static uint64_t seedShift() { return g_opt.seed * 1000003ull; }

static double sigSeconds()   { return g_opt.quick ? 8.0 : 30.0; }
static double dSeconds()     { return g_opt.quick ? 8.0 : 20.0; }
static double cpuSeconds()   { return g_opt.quick ? 8.0 : 10.0; }
static int    cpuReps()      { return g_opt.quick ? 5 : 30; }
static constexpr double kSkipSec = 2.0;     // analysis skips the first 2 s (stream start-up)

// ============================================================================
// Audio containers + deterministic signal generation
// ============================================================================

struct Stereo
{
    std::vector<float> ch[2];
    int size() const { return static_cast<int>(ch[0].size()); }
    void resize(int n) { ch[0].assign(static_cast<size_t>(n), 0.0f); ch[1].assign(static_cast<size_t>(n), 0.0f); }
};

struct Rng   // 64-bit LCG, top 24 bits -> uniform [-1, 1). Fully deterministic.
{
    uint64_t s;
    explicit Rng(uint64_t seed) : s(seed * 0x9E3779B97F4A7C15ull + 0x1234567ull) {}
    double uni()
    {
        s = s * 6364136223846793005ull + 1442695040888963407ull;
        return static_cast<double>(s >> 40) / 8388608.0 - 1.0;
    }
};

// Paul Kellet "economy" pink filter driven by uniform white noise.
static std::vector<double> makePink(int n, uint64_t seed)
{
    std::vector<double> o(static_cast<size_t>(n));
    Rng r(seed);
    double b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (int i = 0; i < n; ++i)
    {
        const double white = r.uni();
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        o[static_cast<size_t>(i)] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        b6 = white * 0.115926;
    }
    return o;
}

static void scaleToRmsDb(std::vector<double>& x, double dbfs)
{
    double acc = 0.0;
    for (double v : x) acc += v * v;
    const double rms = std::sqrt(acc / std::max<size_t>(x.size(), 1));
    const double g = std::pow(10.0, dbfs / 20.0) / std::max(rms, 1.0e-20);
    for (double& v : x) v *= g;
}

// Pink noise at a given RMS, independent per channel (seed namespace `salt`).
static Stereo makePinkStereo(int n, double rmsDbfs, uint64_t salt)
{
    Stereo s; s.resize(n);
    for (int c = 0; c < 2; ++c)
    {
        // --corr-diag only: channel 1 reuses channel 0's noise (fully correlated L/R). Default: independent channels.
        const uint64_t chSeed = g_opt.corrNoise ? 0ull : static_cast<uint64_t>(c);
        auto p = makePink(n, salt * 1000ull + chSeed + 1ull + seedShift());
        scaleToRmsDb(p, rmsDbfs);
        for (int i = 0; i < n; ++i) s.ch[c][static_cast<size_t>(i)] = static_cast<float>(p[static_cast<size_t>(i)]);
    }
    return s;
}

// RBJ peaking biquad (double precision, TDF-II).
static void applyRbjPeak(std::vector<float>& x, double sr, double f0, double q, double gainDb)
{
    const double A = std::pow(10.0, gainDb / 40.0);
    const double w0 = 2.0 * juce::MathConstants<double>::pi * f0 / sr;
    const double alpha = std::sin(w0) / (2.0 * q);
    const double cw = std::cos(w0);
    const double a0 = 1.0 + alpha / A;
    const double b0 = (1.0 + alpha * A) / a0, b1 = (-2.0 * cw) / a0, b2 = (1.0 - alpha * A) / a0;
    const double a1 = (-2.0 * cw) / a0, a2 = (1.0 - alpha / A) / a0;
    double z1 = 0.0, z2 = 0.0;
    for (float& v : x)
    {
        const double in = v;
        const double out = b0 * in + z1;
        z1 = b1 * in - a1 * out + z2;
        z2 = b2 * in - a2 * out;
        v = static_cast<float>(out);
    }
}

// Signals A/B (resonance in both channels) and E (resonance in the RIGHT only). q / gainDb default to the
// standard planted bell (Q 8, +12 dB); the v4 shape scans vary them.
static Stereo makeResonant(const Stereo& basePink, double sr, double f0, bool left, bool right, double q = 8.0, double gainDb = 12.0)
{
    Stereo s = basePink;
    if (left)  applyRbjPeak(s.ch[0], sr, f0, q, gainDb);
    if (right) applyRbjPeak(s.ch[1], sr, f0, q, gainDb);
    return s;
}

// Signal D: -40 dBFS pink bed + decaying noise bursts every 500 ms.
// Burst = white noise at -10 dBFS RMS at onset (instant attack), amplitude
// envelope exp(-t / 80 ms). First onset at 0.5 s.
static std::vector<int> burstOnsets(int n, double sr)
{
    std::vector<int> o;
    for (int k = 1;; ++k)
    {
        const int pos = static_cast<int>(std::llround(0.5 * k * sr));
        if (pos >= n) break;
        o.push_back(pos);
    }
    return o;
}

// bellF0 > 0 -> signal D2: the same +12 dB / Q8 bell is applied to the NOISE BED only
// (before the bursts are added; bursts stay broadband and unfiltered).
static Stereo makeTransientBed(int n, double sr, double bellF0 = 0.0)
{
    Stereo s = makePinkStereo(n, -40.0, 50);
    if (bellF0 > 0.0)
        for (int c = 0; c < 2; ++c) applyRbjPeak(s.ch[c], sr, bellF0, 8.0, 12.0);
    const double peak = std::pow(10.0, -10.0 / 20.0) * std::sqrt(3.0);   // uniform[-1,1) has RMS 1/sqrt(3)
    const auto onsets = burstOnsets(n, sr);
    for (int c = 0; c < 2; ++c)
    {
        Rng r(777u + static_cast<uint64_t>(c) + seedShift());
        for (int pos : onsets)
        {
            const int len = std::min(static_cast<int>(0.5 * sr), n - pos);
            for (int i = 0; i < len; ++i)
            {
                const double env = std::exp(-(static_cast<double>(i) / sr) / 0.080);
                s.ch[c][static_cast<size_t>(pos + i)] += static_cast<float>(peak * env * r.uni());
            }
        }
    }
    return s;
}

static Stereo makeImpulse(int n, int at)
{
    Stereo s; s.resize(n);
    s.ch[0][static_cast<size_t>(at)] = 0.5f;
    s.ch[1][static_cast<size_t>(at)] = 0.5f;
    return s;
}

// ============================================================================
// Subjects + effect factory
// ============================================================================

enum class Kind { RsLL, RsHQ, Eq, Custom };
enum class Group { Primary, Sensitive, Capability };

// Description of the resonance planted in the signal a processor is about to be run on. Only Subject::factory
// subjects (the --ref-subjects oracle) read it; the built-in kinds ignore it. Defaults = the standard planted
// bell (2500 Hz, Q 8, +12 dB, both channels), which is what every non-scan run (latency, jitter, D/D2, CPU) uses.
struct Planted
{
    double f0 = 2500.0, q = 8.0, gainDb = 12.0;
    bool left = true, right = true;
    // v5, time-varying case T1 - ORACLE ONLY (the --ref-subjects R1 factory reads these two; the core, the RS / EQ built-in kinds and R0 never look at them):
    //   cleanRef = the unprocessed clean noise the signal was built from (valid for the duration of the factory call; the oracle copies it),
    //   events   = the switching schedule {onset, offset} in samples (offset = start of the fade-out; the signal has the bell fully on between onset + fade and offset).
    const Stereo* cleanRef = nullptr;
    std::vector<std::pair<int, int>> events;
};

struct Subject
{
    std::string id;        // S1, S1s, ...
    std::string base;      // S1 .. S5
    std::string label;
    Kind kind;
    int quality = 1;       // RS HQ: 0 Fast, 1 Normal, 2 High
    bool sensitive = false;        // RS: depth 100 / selectivity 0
    float eqSens = -1.0f;          // EQ: spec_sens override (<0 = default)
    std::string params;
    bool capability = false;       // max-depth capability variant (RS: depth 100 / Hard)
    float eqGain = -12.0f;         // EQ band gain (= signed depth, dB) when not neutral
    // ---- v3 registration fields (everything the bench needs to know about a subject) ----
    Group group = Group::Primary;  // Primary = default params (CPU + transparency + block size);
                                   // Sensitive = jitter-only; Capability = scan/E/D/D2/jitter/pre-echo + gates when gated
    float eqQ = -1.0f;             // EQ: band Q override (<0 = default 0.707)
    bool reference = false;        // calibration subject (--ref-subjects); excluded from the "a real subject passed everything" alarm
    bool gated = false;            // graded by the G1..G6 gate table (evaluated at THIS variant)
    std::string jitterId;          // G4: id of the registered subject whose jitter run is the "sensitive variant" (empty = this subject)
    std::vector<std::string> notGraded;   // gates ("G3", "G9a") that are PRINTED for this subject but left out of its verdict: a characterisation set (RSC-F / -N / -H run at the RS default stereo link 100 %)
    std::string pairedDefault;     // id of the default-parameter subject this capability variant is paired with
                                   // (empty = none; only paired ones enter the legacy 'capability >= default' sanity line)
    // Optional: build a subject that is not one of the built-in kinds. Returns a prepared processor
    // (the factory calls prepareToPlay itself). `neutral` = depth 0 / no-op config for latency + transparency runs.
    // `bell` describes the resonance planted in the signal about to be processed (centre, Q, level, channels).
    std::function<std::unique_ptr<juce::AudioProcessor>(double sr, int maxBlock, const Planted& bell, bool neutral)> factory;
};

// Reference processor for --ref-subjects: one RBJ peaking biquad (double TDF-II, same maths as applyRbjPeak) on the
// selected channels (the others pass through bit-exactly).
// gainDb = 0 is an exact identity (pass-through); gainDb = -G at the planted f0 / Q is the exact inverse of a planted +G dB bell.
class RefBellProcessor : public juce::AudioProcessor
{
public:
    RefBellProcessor(double sr, double f0, double gainDb, double q = 8.0, bool applyL = true, bool applyR = true)
        : juce::AudioProcessor(BusesProperties().withInput("in", juce::AudioChannelSet::stereo()).withOutput("out", juce::AudioChannelSet::stereo()))
    {
        apply_[0] = applyL; apply_[1] = applyR;
        const double A = std::pow(10.0, gainDb / 40.0);
        const double w0 = 2.0 * juce::MathConstants<double>::pi * f0 / sr;
        const double alpha = std::sin(w0) / (2.0 * q);
        const double cw = std::cos(w0);
        const double a0 = 1.0 + alpha / A;
        b0_ = (1.0 + alpha * A) / a0; b1_ = (-2.0 * cw) / a0; b2_ = (1.0 - alpha * A) / a0;
        a1_ = (-2.0 * cw) / a0;       a2_ = (1.0 - alpha / A) / a0;
    }
    const juce::String getName() const override { return "RefBell"; }
    void prepareToPlay(double, int) override { z1_[0] = z1_[1] = z2_[0] = z2_[1] = 0.0; }
    void releaseResources() override {}
    void processBlock(juce::AudioBuffer<float>& buf, juce::MidiBuffer&) override
    {
        for (int c = 0; c < std::min(2, buf.getNumChannels()); ++c)
        {
            if (!apply_[c]) continue;   // channel not touched by the oracle: bit-exact pass-through
            float* d = buf.getWritePointer(c);
            for (int i = 0; i < buf.getNumSamples(); ++i)
            {
                const double in = d[i];
                const double out = b0_ * in + z1_[c];
                z1_[c] = b1_ * in - a1_ * out + z2_[c];
                z2_[c] = b2_ * in - a2_ * out;
                d[i] = static_cast<float>(out);
            }
        }
    }
    double getTailLengthSeconds() const override { return 0.0; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool hasEditor() const override { return false; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock&) override {}
    void setStateInformation(const void*, int) override {}
private:
    double b0_ = 1, b1_ = 0, b2_ = 0, a1_ = 0, a2_ = 0, z1_[2] = {}, z2_[2] = {};
    bool apply_[2] = { true, true };
};

// Oracle for the time-varying signal T1 (--ref-subjects R1 when Planted::cleanRef is set): ignores its input and returns the clean reference, delayed by
// `latency` samples (R1 has latency 0, so the delay is the identity; the parameter keeps the "delayed by its latency" contract explicit and testable).
// On T1 this is what an ideal instantaneous suppressor outputs: the input with the bell removed exactly when it is on, the input itself when it is off.
class RefCleanProcessor : public juce::AudioProcessor
{
public:
    RefCleanProcessor(const Stereo& clean, int latency)
        : juce::AudioProcessor(BusesProperties().withInput("in", juce::AudioChannelSet::stereo()).withOutput("out", juce::AudioChannelSet::stereo())),
          clean_(clean), latency_(latency)
    {
        setLatencySamples(latency_);
    }
    const juce::String getName() const override { return "RefClean"; }
    void prepareToPlay(double, int) override { pos_ = 0; }
    void releaseResources() override {}
    void processBlock(juce::AudioBuffer<float>& buf, juce::MidiBuffer&) override
    {
        const int n = buf.getNumSamples();
        for (int c = 0; c < std::min(2, buf.getNumChannels()); ++c)
        {
            float* d = buf.getWritePointer(c);
            for (int i = 0; i < n; ++i)
            {
                const int src = pos_ + i - latency_;
                d[i] = (src >= 0 && src < clean_.size()) ? clean_.ch[c][static_cast<size_t>(src)] : 0.0f;
            }
        }
        pos_ += n;
    }
    double getTailLengthSeconds() const override { return 0.0; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool hasEditor() const override { return false; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock&) override {}
    void setStateInformation(const void*, int) override {}
private:
    Stereo clean_;
    int latency_ = 0;
    int pos_ = 0;
};

// Bench adapter for xleth::dsp::resonance::Core (src/dsp/ResonanceCore.*, stage 1, wired into no effect): a thin
// juce::AudioProcessor so the core runs through exactly the same render / latency / CPU paths as every other subject.
// Lives in the bench only. The core sees nothing but audio and its Params block.
class ResonanceCoreProcessor : public juce::AudioProcessor
{
public:
    ResonanceCoreProcessor(const xleth::dsp::resonance::Params& p, float detectorTauMs, xleth::dsp::resonance::Core::FrameTier tier = xleth::dsp::resonance::Core::FrameTier::Normal)
        : juce::AudioProcessor(BusesProperties().withInput("in", juce::AudioChannelSet::stereo()).withOutput("out", juce::AudioChannelSet::stereo())),
          params_(p)
    {
        if (detectorTauMs > 0.0f) core_.setDetectorTimeConstantMs(detectorTauMs);
        if (g_opt.coreFastMs >= 0.0f) core_.setFastTimeConstantMs(g_opt.coreFastMs);
        core_.setFrameTier(tier);
    }
    void setHopPhaseOffset(int samples) { core_.setHopPhaseOffset(samples); }   // before prepareToPlay (--cpu-burst --burst-stagger core)
    const juce::String getName() const override { return "ResonanceCore"; }
    void prepareToPlay(double sr, int maxBlock) override
    {
        core_.prepare(sr, maxBlock, 2);
        setLatencySamples(core_.currentLatency());
    }
    void releaseResources() override {}
    void processBlock(juce::AudioBuffer<float>& buf, juce::MidiBuffer&) override
    {
        core_.process(buf.getArrayOfWritePointers(), buf.getNumChannels(), buf.getNumSamples(), params_);
    }
    double getTailLengthSeconds() const override { return 0.0; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool hasEditor() const override { return false; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock&) override {}
    void setStateInformation(const void*, int) override {}
    const xleth::dsp::resonance::Core& core() const { return core_; }   // read-only introspection (--cpu-worst attribution)
private:
    xleth::dsp::resonance::Core core_;
    xleth::dsp::resonance::Params params_;
};

// Subject::factory for the core. The Planted descriptor is accepted (it is the factory signature every case - scan,
// Q / level scans, right-only - calls through) but deliberately NOT passed to the core: the processor must find the
// resonance from the audio alone (no knowledge of f0, Q, level or channel). `neutral` = depth 0.
static std::function<std::unique_ptr<juce::AudioProcessor>(double, int, const Planted&, bool)> coreFactory(xleth::dsp::resonance::Params p,
    xleth::dsp::resonance::Core::FrameTier tier = xleth::dsp::resonance::Core::FrameTier::Normal)
{
    return [p, tier](double sr, int maxBlock, const Planted& /*bell: intentionally unused*/, bool neutral)
    {
        xleth::dsp::resonance::Params q = p;
        if (neutral) q.depth = 0.0f;
        auto proc = std::make_unique<ResonanceCoreProcessor>(q, g_opt.coreTauMs, tier);
        if (g_burstCoreHopOffset != 0) proc->setHopPhaseOffset(g_burstCoreHopOffset);   // only --cpu-burst --burst-stagger core sets it
        proc->prepareToPlay(sr, maxBlock);
        return std::unique_ptr<juce::AudioProcessor>(std::move(proc));
    };
}

// Subject::factory for the Resonance Suppressor running its NEW High Quality engine (hq_engine = New, i.e. the
// ResonanceCore inside the effect: parameter mapping, RS default focus curve, stereo link, aligned-dry output stage).
// Capability settings: depth 100 %, Hard, every other parameter at the RS default (selectivity 50 %, stereo link 100 %,
// focus curve 0 below 40 Hz / ramp to 80 Hz / ramp down above 16 kHz). `sensitive` = selectivity 0 (core sensitivity 1).
// The instance index is pinned to 0 so the hop phase is the core's historical grid, as for C1c-*.
// `coreDefaults` (diagnostic RSC-N0): stereo link 0 and the focus curve opened to wc_hp 20 Hz / wc_lp 20 kHz (every weight on the
// core's grid is then exactly 1, which the core treats bit-identically to no curve), i.e. the C1c settings through the effect.
static void need(bool ok, const char* what);

static std::function<std::unique_ptr<juce::AudioProcessor>(double, int, const Planted&, bool)> rsNewEngineFactory(int quality,
    bool sensitive, bool coreDefaults = false)
{
    return [quality, sensitive, coreDefaults](double sr, int maxBlock, const Planted& /*bell: intentionally unused*/, bool neutral)
    {
        auto fx = std::make_unique<XlethResonanceSuppressorEffect>();
        fx->setCoreInstanceIndex(0);
        need(fx->setParameterValue("processing_mode", 1.0f), "RSC processing_mode HQ");
        need(fx->setParameterValue("hq_engine", 1.0f), "RSC hq_engine New");
        need(fx->setParameterValue("quality", static_cast<float>(quality)), "RSC quality");
        need(fx->setParameterValue("mode", 1.0f), "RSC mode Hard");
        need(fx->setParameterValue("depth", neutral ? 0.0f : 100.0f), "RSC depth");
        if (sensitive && !neutral) need(fx->setParameterValue("selectivity", 0.0f), "RSC selectivity 0 (sensitive)");
        if (coreDefaults)
        {
            need(fx->setParameterValue("stereo_link", 0.0f), "RSC-N0 stereo_link 0");
            need(fx->setParameterValue("wc_hp", 20.0f), "RSC-N0 wc_hp 20 Hz");
            need(fx->setParameterValue("wc_lp", 20000.0f), "RSC-N0 wc_lp 20 kHz");
        }
        fx->prepareToPlay(sr, maxBlock);
        return std::unique_ptr<juce::AudioProcessor>(std::move(fx));
    };
}

// Subject::factory for the Param EQ with its Spectral bands on the ResonanceCore ([EQCore], spectral_engine = Core): one Spectral band at -24 dB
// (core depth 24 / 24 = 1, Hard knee), spec_attack 15 ms / spec_release 200 ms (the core defaults), spec_sens / spec_sel default (core sensitivity 0.5
// exactly) - the C1c capability settings through the EQ. The weight curve is opened (setSpectralCoreFlatWeightsForBench: the band covers the whole
// range, the core sees no curve, as C1c) and the stereo link is 0 unless `defaultLink` (the EQ's default, 1). `sensitive` = spec_sens 0 (core sensitivity 1,
// the C1s companion). `flatBiquads` adds three 0 dB bell bands to the EQ's biquad path behind the core (diagnostic EQSb-N). `neutral` = band gain 0
// (core depth 0). The instance index is pinned to 0 (the core's historical hop grid, as for C1c-* and RSC-*). The planted resonance is NOT passed.
static std::function<std::unique_ptr<juce::AudioProcessor>(double, int, const Planted&, bool)> eqCoreFactory(int quality, bool sensitive,
    bool defaultLink, bool flatBiquads = false)
{
    return [quality, sensitive, defaultLink, flatBiquads](double sr, int maxBlock, const Planted& /*bell: intentionally unused*/, bool neutral)
    {
        auto eq = std::make_unique<XlethParametricEQ>();
        eq->setCoreInstanceIndex(0);
        need(eq->addBand() == 0, "EQS addBand");
        need(eq->setBandParam(0, "freq", 1000.0f), "EQS freq");
        need(eq->setBandParam(0, "gain", neutral ? 0.0f : -24.0f), "EQS gain (depth)");
        need(eq->setBandParam(0, "spec_attack", 15.0f), "EQS spec_attack 15 ms");
        need(eq->setBandParam(0, "spec_release", 200.0f), "EQS spec_release 200 ms");
        if (sensitive && !neutral) need(eq->setBandParam(0, "spec_sens", 0.0f), "EQS spec_sens 0 (sensitive)");
        need(eq->setBandParam(0, "enabled", 1.0f), "EQS enabled");
        need(eq->setBandParam(0, "mode", 2.0f), "EQS mode Spectral");
        if (flatBiquads)
        {
            const float hz[3] = { 120.0f, 1800.0f, 7000.0f };
            for (int b = 1; b <= 3; ++b)
            {
                need(eq->addBand() == b, "EQSb addBand");
                need(eq->setBandParam(b, "freq", hz[b - 1]), "EQSb freq");
                need(eq->setBandParam(b, "gain", 0.0f), "EQSb gain 0 dB");
                need(eq->setBandParam(b, "q", 1.0f), "EQSb q");
            }
        }
        need(eq->setParameterValue("spectral_engine", 1.0f), "EQS spectral_engine Core");
        need(eq->setParameterValue("spectral_quality", static_cast<float>(quality)), "EQS spectral_quality");
        eq->setSpectralCoreFlatWeightsForBench(true);
        if (!defaultLink) eq->setSpectralCoreStereoLinkForBench(0.0f);
        eq->prepareToPlay(sr, maxBlock);
        return std::unique_ptr<juce::AudioProcessor>(std::move(eq));
    };
}

// THE subject registry. Registering a subject here adds it to every table, CSV, gate and (for Primary) the CPU run.
// Order is preserved inside each group; groups are concatenated Primary, Sensitive, Capability.
static const std::vector<Subject>& registry()
{
    static const std::vector<Subject> reg = []
    {
        std::vector<Subject> r;
        auto add = [&](const char* id, const char* base, const char* label, Kind kind, Group g, const char* params) -> Subject&
        {
            r.emplace_back();
            Subject& s = r.back();
            s.id = id; s.base = base; s.label = label; s.kind = kind; s.group = g; s.params = params;
            return s;
        };

        // -------- Primary: default parameters --------
        add("S1", "S1", "RS Low Latency",           Kind::RsLL, Group::Primary, "defaults (LL)");
        { auto& s = add("S2", "S2", "RS High Quality / Fast",   Kind::RsHQ, Group::Primary, "processing_mode=HQ, quality=Fast (N=512)");    s.quality = 0; }
        { auto& s = add("S3", "S3", "RS High Quality / Normal", Kind::RsHQ, Group::Primary, "processing_mode=HQ, quality=Normal (N=1024)"); s.quality = 1; }
        { auto& s = add("S4", "S4", "RS High Quality / High",   Kind::RsHQ, Group::Primary, "processing_mode=HQ, quality=High (N=2048)");   s.quality = 2; }
        add("S5", "S5", "EQ Spectral (1 band)",     Kind::Eq,   Group::Primary, "band0 mode=Spectral, gain(depth)=-12 dB, freq=resonance, Q/sens/sel/atk/rel default");
        // ResonanceCore stage 1 (unwired DSP class, bench adapter above). Default Params: depth 0.5, sensitivity 0.5,
        // attack 15 ms, release 200 ms, Soft, stereo link 0. Gated at its default parameters too; G4 on C1s.
        { auto& s = add("C1", "C1", "ResonanceCore (default)", Kind::Custom, Group::Primary,
                        "depth 0.5; sensitivity 0.5; attack 15 ms; release 200 ms; Soft; link 0");
          s.gated = true; s.jitterId = "C1s"; s.factory = coreFactory(xleth::dsp::resonance::Params{}); }

        // -------- Sensitive: jitter / false-trigger test only --------
        { auto& s = add("S1s", "S1", "RS Low Latency (sensitive)", Kind::RsLL, Group::Sensitive, "depth=100, selectivity=0"); s.sensitive = true; }
        { auto& s = add("S2s", "S2", "RS HQ Fast (sensitive)",     Kind::RsHQ, Group::Sensitive, "depth=100, selectivity=0"); s.sensitive = true; s.quality = 0; }
        { auto& s = add("S3s", "S3", "RS HQ Normal (sensitive)",   Kind::RsHQ, Group::Sensitive, "depth=100, selectivity=0"); s.sensitive = true; s.quality = 1; }
        { auto& s = add("S4s", "S4", "RS HQ High (sensitive)",     Kind::RsHQ, Group::Sensitive, "depth=100, selectivity=0"); s.sensitive = true; s.quality = 2; }
        { auto& s = add("S5s", "S5", "EQ Spectral (spec_sens=1.0, as spec'd)", Kind::Eq, Group::Sensitive, "spec_sens=1.0 (EQ: HIGHER sens = HIGHER threshold)"); s.eqSens = 1.0f; }
        { auto& s = add("S5z", "S5", "EQ Spectral (spec_sens=0.0)", Kind::Eq, Group::Sensitive, "spec_sens=0.0 (EQ: LOWEST threshold = most sensitive)"); s.eqSens = 0.0f; }
        // Sensitive companion of S5q (G4): same as S5z but with the narrow band Q 8 of the fair variant.
        { auto& s = add("S5qz", "S5", "EQ Spectral (spec_sens=0.0, Q=8)", Kind::Eq, Group::Sensitive, "spec_sens=0.0, band Q=8, gain -12 dB (sensitive companion of S5q)"); s.eqSens = 0.0f; s.eqQ = 8.0f; }
        // Sensitive companion of C1 / C1c (G4): the most sensitive and deepest setting of the core.
        { xleth::dsp::resonance::Params p; p.depth = 1.0f; p.sensitivity = 1.0f; p.hardKnee = true;
          auto& s = add("C1s", "C1", "ResonanceCore (sensitive)", Kind::Custom, Group::Sensitive, "depth 1.0; sensitivity 1.0; Hard; other params default");
          s.factory = coreFactory(p); }
        // Frame-size tier companions of C1s (G4 for C1c-F / C1c-H; C1c-N uses C1s, the same Normal tier).
        { xleth::dsp::resonance::Params p; p.depth = 1.0f; p.sensitivity = 1.0f; p.hardKnee = true;
          { auto& s = add("C1s-F", "C1", "ResonanceCore Fast N=512 (sensitive)", Kind::Custom, Group::Sensitive, "depth 1.0; sensitivity 1.0; Hard; frame tier Fast (N=512)");
            s.factory = coreFactory(p, xleth::dsp::resonance::Core::FrameTier::Fast); }
          { auto& s = add("C1s-H", "C1", "ResonanceCore High N=2048 (sensitive)", Kind::Custom, Group::Sensitive, "depth 1.0; sensitivity 1.0; Hard; frame tier High (N=2048)");
            s.factory = coreFactory(p, xleth::dsp::resonance::Core::FrameTier::High); } }
        // G4 companions of RSC-F / RSC-N / RSC-H: the RS New engine at its most sensitive and deepest (selectivity 0 = core sensitivity 1).
        { auto& s = add("RSCs-F", "RSC", "RS New engine Fast (sensitive)",   Kind::Custom, Group::Sensitive, "RS hq_engine=New, quality Fast, depth 100, Hard, selectivity 0");
          s.factory = rsNewEngineFactory(0, true); }
        { auto& s = add("RSCs-N", "RSC", "RS New engine Normal (sensitive)", Kind::Custom, Group::Sensitive, "RS hq_engine=New, quality Normal, depth 100, Hard, selectivity 0");
          s.factory = rsNewEngineFactory(1, true); }
        { auto& s = add("RSCs-H", "RSC", "RS New engine High (sensitive)",   Kind::Custom, Group::Sensitive, "RS hq_engine=New, quality High, depth 100, Hard, selectivity 0");
          s.factory = rsNewEngineFactory(2, true); }
        // G4 companions of RSC-F0 / RSC-N0 / RSC-H0: the same at stereo link 0 and the focus curve opened to 20 Hz - 20 kHz (the C1s settings through the effect).
        { auto& s = add("RSCs0-F", "RSC", "RS New engine Fast, link 0 + open curve (sensitive)",   Kind::Custom, Group::Sensitive, "RS hq_engine=New, quality Fast, depth 100, Hard, selectivity 0, stereo_link 0, wc_hp 20, wc_lp 20000");
          s.factory = rsNewEngineFactory(0, true, true); }
        { auto& s = add("RSCs0-N", "RSC", "RS New engine Normal, link 0 + open curve (sensitive)", Kind::Custom, Group::Sensitive, "RS hq_engine=New, quality Normal, depth 100, Hard, selectivity 0, stereo_link 0, wc_hp 20, wc_lp 20000");
          s.factory = rsNewEngineFactory(1, true, true); }
        { auto& s = add("RSCs0-H", "RSC", "RS New engine High, link 0 + open curve (sensitive)",   Kind::Custom, Group::Sensitive, "RS hq_engine=New, quality High, depth 100, Hard, selectivity 0, stereo_link 0, wc_hp 20, wc_lp 20000");
          s.factory = rsNewEngineFactory(2, true, true); }
        // [EQCore] G4 companions of EQS-* (link 0) and EQSl-* (default link 1): spec_sens 0 = core sensitivity 1, depth 1, Hard (the C1s settings through the EQ).
        { auto& s = add("EQSs-F", "EQS", "EQ Spectral on the core Fast, link 0 (sensitive)",   Kind::Custom, Group::Sensitive, "EQ spectral_engine=Core, quality Fast, band -24 dB, spec_sens 0, link 0, open curve");
          s.factory = eqCoreFactory(0, true, false); }
        { auto& s = add("EQSs-N", "EQS", "EQ Spectral on the core Normal, link 0 (sensitive)", Kind::Custom, Group::Sensitive, "EQ spectral_engine=Core, quality Normal, band -24 dB, spec_sens 0, link 0, open curve");
          s.factory = eqCoreFactory(1, true, false); }
        { auto& s = add("EQSs-H", "EQS", "EQ Spectral on the core High, link 0 (sensitive)",   Kind::Custom, Group::Sensitive, "EQ spectral_engine=Core, quality High, band -24 dB, spec_sens 0, link 0, open curve");
          s.factory = eqCoreFactory(2, true, false); }
        { auto& s = add("EQSsl-F", "EQS", "EQ Spectral on the core Fast, default link (sensitive)",   Kind::Custom, Group::Sensitive, "EQ spectral_engine=Core, quality Fast, band -24 dB, spec_sens 0, link 1, open curve");
          s.factory = eqCoreFactory(0, true, true); }
        { auto& s = add("EQSsl-N", "EQS", "EQ Spectral on the core Normal, default link (sensitive)", Kind::Custom, Group::Sensitive, "EQ spectral_engine=Core, quality Normal, band -24 dB, spec_sens 0, link 1, open curve");
          s.factory = eqCoreFactory(1, true, true); }
        { auto& s = add("EQSsl-H", "EQS", "EQ Spectral on the core High, default link (sensitive)",   Kind::Custom, Group::Sensitive, "EQ spectral_engine=Core, quality High, band -24 dB, spec_sens 0, link 1, open curve");
          s.factory = eqCoreFactory(2, true, true); }

        // -------- Capability: max-depth runs (gated) --------
        { auto& s = add("S1c", "S1", "RS Low Latency (capability)", Kind::RsLL, Group::Capability, "depth=100, mode=Hard");
          s.capability = true; s.gated = true; s.jitterId = "S1s"; s.pairedDefault = "S1"; }
        { auto& s = add("S2c", "S2", "RS HQ Fast (capability)",     Kind::RsHQ, Group::Capability, "depth=100, mode=Hard");
          s.quality = 0; s.capability = true; s.gated = true; s.jitterId = "S2s"; s.pairedDefault = "S2"; }
        { auto& s = add("S3c", "S3", "RS HQ Normal (capability)",   Kind::RsHQ, Group::Capability, "depth=100, mode=Hard");
          s.quality = 1; s.capability = true; s.gated = true; s.jitterId = "S3s"; s.pairedDefault = "S3"; }
        { auto& s = add("S4c", "S4", "RS HQ High (capability)",     Kind::RsHQ, Group::Capability, "depth=100, mode=Hard");
          s.quality = 2; s.capability = true; s.gated = true; s.jitterId = "S4s"; s.pairedDefault = "S4"; }
        { auto& s = add("S5c", "S5", "EQ Spectral (capability)",    Kind::Eq,   Group::Capability, "band gain=-30 dB (max depth), spec_sens=0.0 (most sensitive)");
          s.eqSens = 0.0f; s.capability = true; s.eqGain = -30.0f; s.gated = true; s.jitterId = "S5z"; s.pairedDefault = "S5"; }
        // Fair EQ variant: a narrow (Q 8) band centred on the resonance so the band's region brackets it.
        { auto& s = add("S5q", "S5", "EQ Spectral (fair: Q=8)",     Kind::Eq,   Group::Capability, "band gain=-30 dB, spec_sens=0.0, band Q=8, centre=f0");
          s.eqSens = 0.0f; s.capability = true; s.eqGain = -30.0f; s.eqQ = 8.0f; s.gated = true; s.jitterId = "S5qz"; }
        // v4 fair EQ variant #2: S5q's sensitivity 0.0 sets threshold = local mean, which over-suppresses by construction.
        // S5qd leaves spec_sens at its DEFAULT (eqSens < 0 = parameter not touched); gain -30 dB, band Q 8, centre = f0, everything else default.
        // G4 is graded on the same sensitive companion as S5q (S5qz): G4 asks "does the most sensitive setting of this processor produce musical noise".
        { auto& s = add("S5qd", "S5", "EQ Spectral (fair: Q=8 default sens)", Kind::Eq, Group::Capability, "band gain=-30 dB; spec_sens=DEFAULT; band Q=8; centre=f0");
          s.capability = true; s.eqGain = -30.0f; s.eqQ = 8.0f; s.gated = true; s.jitterId = "S5qz"; }
        // ResonanceCore capability variant: depth 1.0, Hard, every other parameter at its default.
        { xleth::dsp::resonance::Params p; p.depth = 1.0f; p.hardKnee = true;
          auto& s = add("C1c", "C1", "ResonanceCore (capability)", Kind::Custom, Group::Capability, "depth 1.0; Hard; other params default");
          s.capability = true; s.gated = true; s.jitterId = "C1s"; s.pairedDefault = "C1"; s.factory = coreFactory(p); }
        // Frame-size tier experiment (capability params as C1c; N = 512 / 1024 / 2048 at 48 kHz, every time constant in ms, nothing retuned per tier).
        { xleth::dsp::resonance::Params p; p.depth = 1.0f; p.hardKnee = true;
          { auto& s = add("C1c-F", "C1", "ResonanceCore capability Fast N=512", Kind::Custom, Group::Capability, "C1c params; frame tier Fast (N=512)");
            s.capability = true; s.gated = true; s.jitterId = "C1s-F"; s.factory = coreFactory(p, xleth::dsp::resonance::Core::FrameTier::Fast); }
          { auto& s = add("C1c-N", "C1", "ResonanceCore capability Normal N=1024", Kind::Custom, Group::Capability, "C1c params; frame tier Normal (N=1024)");
            s.capability = true; s.gated = true; s.jitterId = "C1s"; s.factory = coreFactory(p, xleth::dsp::resonance::Core::FrameTier::Normal); }
          { auto& s = add("C1c-H", "C1", "ResonanceCore capability High N=2048", Kind::Custom, Group::Capability, "C1c params; frame tier High (N=2048)");
            s.capability = true; s.gated = true; s.jitterId = "C1s-H"; s.factory = coreFactory(p, xleth::dsp::resonance::Core::FrameTier::High); } }
        // The Resonance Suppressor with its New High Quality engine (the ResonanceCore wired into the effect), at the capability
        // settings next to C1c-F / -N / -H: depth 100 %, Hard, every other RS parameter at its default. The differences to C1c-* are the
        // effect's, not the core's: the RS default focus curve, the parameter mapping and stereo link 100 % (C1c-*: flat curve, link 0).
        // RSC-F / -N / -H are a CHARACTERISATION set (product defaults, stereo link 100 %): their gate rows are printed, but G3 and G9a are
        // "link-100 characterisation, not graded" (a one-channel resonance is cut on both channels by definition; the link also lengthens the
        // release). The graded RS New-engine subjects are RSC-F0 / RSC-N0 / RSC-H0 below (link 0, open curve = the C1c settings through the effect).
        { auto& s = add("RSC-F", "RSC", "RS New engine capability Fast (link 100, characterisation)",   Kind::Custom, Group::Capability, "RS hq_engine=New, quality Fast, depth 100, Hard, other params default");
          s.capability = true; s.gated = true; s.jitterId = "RSCs-F"; s.notGraded = { "G3", "G9a" }; s.factory = rsNewEngineFactory(0, false); }
        { auto& s = add("RSC-N", "RSC", "RS New engine capability Normal (link 100, characterisation)", Kind::Custom, Group::Capability, "RS hq_engine=New, quality Normal, depth 100, Hard, other params default");
          s.capability = true; s.gated = true; s.jitterId = "RSCs-N"; s.notGraded = { "G3", "G9a" }; s.factory = rsNewEngineFactory(1, false); }
        { auto& s = add("RSC-H", "RSC", "RS New engine capability High (link 100, characterisation)",   Kind::Custom, Group::Capability, "RS hq_engine=New, quality High, depth 100, Hard, other params default");
          s.capability = true; s.gated = true; s.jitterId = "RSCs-H"; s.notGraded = { "G3", "G9a" }; s.factory = rsNewEngineFactory(2, false); }
        // Graded RS New-engine subjects: the C1c settings through the effect (stereo link 0, focus curve open to 20 Hz - 20 kHz), graded on ALL
        // gates against C1c-F / C1c-N / C1c-H. Their G4 companions are RSCs0-F / -N / -H (the same open settings at selectivity 0).
        { auto& s = add("RSC-F0", "RSC", "RS New engine Fast, link 0 + open curve", Kind::Custom, Group::Capability,
                        "RS hq_engine=New, quality Fast, depth 100, Hard, stereo_link 0, wc_hp 20, wc_lp 20000");
          s.capability = true; s.gated = true; s.jitterId = "RSCs0-F"; s.factory = rsNewEngineFactory(0, false, true); }
        { auto& s = add("RSC-N0", "RSC", "RS New engine Normal, link 0 + open curve", Kind::Custom, Group::Capability,
                        "RS hq_engine=New, quality Normal, depth 100, Hard, stereo_link 0, wc_hp 20, wc_lp 20000");
          s.capability = true; s.gated = true; s.jitterId = "RSCs0-N"; s.factory = rsNewEngineFactory(1, false, true); }
        { auto& s = add("RSC-H0", "RSC", "RS New engine High, link 0 + open curve", Kind::Custom, Group::Capability,
                        "RS hq_engine=New, quality High, depth 100, Hard, stereo_link 0, wc_hp 20, wc_lp 20000");
          s.capability = true; s.gated = true; s.jitterId = "RSCs0-H"; s.factory = rsNewEngineFactory(2, false, true); }
        // [EQCore] The Param EQ's Spectral bands on the core: the C1c-F / -N / -H settings through the EQ (one band, open curve, link 0), graded on ALL
        // gates against C1c-*; EQSl-* = the EQ's default stereo link 1 (characterisation: G3 / G9a printed, not graded); EQSb-N = EQS-N with three flat
        // bell bands in the EQ's biquad path (diagnostic). The named G1 100 Hz waiver is not extended to them (no gate or waiver changed).
        { auto& s = add("EQS-F", "EQS", "EQ Spectral on the core Fast, link 0 + open curve", Kind::Custom, Group::Capability,
                        "EQ spectral_engine=Core, quality Fast, 1 Spectral band -24 dB, attack 15 / release 200 ms, link 0, open curve");
          s.capability = true; s.gated = true; s.jitterId = "EQSs-F"; s.factory = eqCoreFactory(0, false, false); }
        { auto& s = add("EQS-N", "EQS", "EQ Spectral on the core Normal, link 0 + open curve", Kind::Custom, Group::Capability,
                        "EQ spectral_engine=Core, quality Normal, 1 Spectral band -24 dB, attack 15 / release 200 ms, link 0, open curve");
          s.capability = true; s.gated = true; s.jitterId = "EQSs-N"; s.factory = eqCoreFactory(1, false, false); }
        { auto& s = add("EQS-H", "EQS", "EQ Spectral on the core High, link 0 + open curve", Kind::Custom, Group::Capability,
                        "EQ spectral_engine=Core, quality High, 1 Spectral band -24 dB, attack 15 / release 200 ms, link 0, open curve");
          s.capability = true; s.gated = true; s.jitterId = "EQSs-H"; s.factory = eqCoreFactory(2, false, false); }
        { auto& s = add("EQSl-F", "EQS", "EQ Spectral on the core Fast (default link 1, characterisation)", Kind::Custom, Group::Capability,
                        "EQ spectral_engine=Core, quality Fast, 1 Spectral band -24 dB, attack 15 / release 200 ms, link 1, open curve");
          s.capability = true; s.gated = true; s.jitterId = "EQSsl-F"; s.notGraded = { "G3", "G9a" }; s.factory = eqCoreFactory(0, false, true); }
        { auto& s = add("EQSl-N", "EQS", "EQ Spectral on the core Normal (default link 1, characterisation)", Kind::Custom, Group::Capability,
                        "EQ spectral_engine=Core, quality Normal, 1 Spectral band -24 dB, attack 15 / release 200 ms, link 1, open curve");
          s.capability = true; s.gated = true; s.jitterId = "EQSsl-N"; s.notGraded = { "G3", "G9a" }; s.factory = eqCoreFactory(1, false, true); }
        { auto& s = add("EQSl-H", "EQS", "EQ Spectral on the core High (default link 1, characterisation)", Kind::Custom, Group::Capability,
                        "EQ spectral_engine=Core, quality High, 1 Spectral band -24 dB, attack 15 / release 200 ms, link 1, open curve");
          s.capability = true; s.gated = true; s.jitterId = "EQSsl-H"; s.notGraded = { "G3", "G9a" }; s.factory = eqCoreFactory(2, false, true); }
        { auto& s = add("EQSb-N", "EQS", "EQ Spectral on the core Normal + 3 flat bell bands (diagnostic)", Kind::Custom, Group::Capability,
                        "EQS-N plus three 0 dB bell bands (120 Hz, 1.8 kHz, 7 kHz, Q 1) in the EQ's biquad path");
          s.capability = true; s.gated = true; s.jitterId = "EQSs-N"; s.factory = eqCoreFactory(1, false, false, true); }

        // -------- Reference subjects (opt-in): metric / gate calibration. Registered through Subject::factory. --------
        if (g_opt.refSubjects)
        {
            { auto& s = add("R0", "R0", "Reference: pass-through", Kind::Custom, Group::Capability, "identity processor - the do-nothing floor (expected: FAIL G1 and G3)");
              s.gated = true; s.reference = true;
              s.factory = [](double sr, int, const Planted& b, bool) { return std::make_unique<RefBellProcessor>(sr, b.f0, 0.0, b.q, true, true); }; }
            { auto& s = add("R1", "R1", "Reference: oracle (exact inverse of the planted bell)", Kind::Custom, Group::Capability,
                            "inverse of the planted bell (same f0 / Q, gain = -planted gain) on exactly the planted channels (expected: PASS G1-G6)");
              s.gated = true; s.reference = true;
              s.factory = [](double sr, int, const Planted& b, bool neutral) -> std::unique_ptr<juce::AudioProcessor>
              {
                  // T1 (time-varying): the oracle returns the clean reference (latency 0 = identical to the neutral RefBellProcessor used for the latency measurement).
                  if (b.cleanRef != nullptr && !neutral) return std::make_unique<RefCleanProcessor>(*b.cleanRef, 0);
                  return std::make_unique<RefBellProcessor>(sr, b.f0, neutral ? 0.0 : -b.gainDb, b.q, b.left, b.right);
              }; }
        }

        // --subjects: keep only the listed ids, the G4 jitter companion of each kept subject, and S3 (the G7 CPU
        // reference, so the ratio stays defined). Metric definitions and thresholds are untouched; this only skips work.
        if (!g_opt.subjects.empty())
        {
            std::vector<std::string> keep = g_opt.subjects;
            for (const auto& want : g_opt.subjects)
            {
                bool found = false;
                for (const auto& s : r)
                    if (s.id == want) { found = true; if (!s.jitterId.empty()) keep.push_back(s.jitterId); }
                if (!found) std::printf("[RSBench] WARNING: --subjects: unknown subject id '%s' (ignored)\n", want.c_str());
            }
            keep.push_back("S3");
            std::vector<Subject> f;
            for (auto& s : r)
                if (std::find(keep.begin(), keep.end(), s.id) != keep.end()) f.push_back(std::move(s));
            r = std::move(f);
        }
        return r;
    }();
    return reg;
}

static std::vector<Subject> subjectsOf(Group g)
{
    std::vector<Subject> o;
    for (const auto& s : registry()) if (s.group == g) o.push_back(s);
    return o;
}

static std::vector<Subject> primarySubjects()    { return subjectsOf(Group::Primary); }
static std::vector<Subject> sensitiveSubjects() { return subjectsOf(Group::Sensitive); }
static std::vector<Subject> capabilitySubjects() { return subjectsOf(Group::Capability); }

struct Fx
{
    std::unique_ptr<XlethResonanceSuppressorEffect> rs;
    std::unique_ptr<XlethParametricEQ>              eq;
    std::unique_ptr<juce::AudioProcessor>           custom;   // Subject::factory products

    juce::AudioProcessor& proc()
    {
        if (custom) return *custom;
        return rs ? static_cast<juce::AudioProcessor&>(*rs) : static_cast<juce::AudioProcessor&>(*eq);
    }
    int reported() const
    {
        if (custom) return custom->getLatencySamples();
        return rs ? rs->getLatencySamples() : eq->getLatencySamples();
    }
    // What a host sees through the juce::AudioProcessor base (setLatencySamples value).
    int published() const
    {
        if (custom) return custom->getLatencySamples();
        return rs ? static_cast<const juce::AudioProcessor&>(*rs).getLatencySamples()
                  : eq->getReportedProcessorLatencySamples();
    }
};

static void need(bool ok, const char* what)
{
    if (!ok) warnf("parameter not accepted: %s", what);
}

// neutral = depth 0 / band gain 0 dB (latency and transparency runs).
// `shape` = the planted resonance of the signal about to be run (read by Subject::factory subjects only; its f0 is overridden by eqCentre).
static Fx makeFx(const Subject& s, double sr, double eqCentre, bool neutral, int maxBlock, const Planted* shape = nullptr)
{
    Fx fx;
    if (s.factory)
    {
        Planted bell = shape ? *shape : Planted{};
        bell.f0 = eqCentre;
        fx.custom = s.factory(sr, maxBlock, bell, neutral);
        need(fx.custom != nullptr, "Subject::factory returned null");
    }
    else if (s.kind == Kind::Eq)
    {
        fx.eq = std::make_unique<XlethParametricEQ>();
        auto& eq = *fx.eq;
        need(eq.addBand() == 0, "EQ addBand");
        need(eq.setBandParam(0, "freq", static_cast<float>(eqCentre)), "EQ freq");
        need(eq.setBandParam(0, "gain", neutral ? 0.0f : s.eqGain), "EQ gain");
        need(eq.setBandParam(0, "enabled", 1.0f), "EQ enabled");
        need(eq.setBandParam(0, "mode", 2.0f), "EQ mode");
        if (s.eqSens >= 0.0f) need(eq.setBandParam(0, "spec_sens", s.eqSens), "EQ spec_sens");
        if (s.eqQ > 0.0f) need(eq.setBandParam(0, "q", s.eqQ), "EQ q");
        eq.prepareToPlay(sr, maxBlock);
    }
    else
    {
        fx.rs = std::make_unique<XlethResonanceSuppressorEffect>();
        auto& rs = *fx.rs;
        need(rs.setParameterValue("processing_mode", s.kind == Kind::RsHQ ? 1.0f : 0.0f), "RS processing_mode");
        if (s.kind == Kind::RsHQ) need(rs.setParameterValue("quality", static_cast<float>(s.quality)), "RS quality");
        if (s.sensitive && !neutral)
        {
            need(rs.setParameterValue("depth", 100.0f), "RS depth");
            need(rs.setParameterValue("selectivity", 0.0f), "RS selectivity");
        }
        if (s.capability && !neutral)
        {
            need(rs.setParameterValue("depth", 100.0f), "RS depth 100 (capability)");
            need(rs.setParameterValue("mode", 1.0f), "RS mode Hard (capability)");
        }
        if (neutral) need(rs.setParameterValue("depth", 0.0f), "RS depth 0");
        rs.prepareToPlay(sr, maxBlock);
    }
    return fx;
}

static const std::vector<int> kMixedSchedule = { 1, 37, 128, 255, 511, 1024, 37 };   // test_effects.cpp:2248
static constexpr int kPrepareBlock = 1024;
static constexpr int kStdBlock     = 512;

static Stereo render(Fx& fx, const Stereo& in, const std::vector<int>& sched)
{
    const int n = in.size();
    Stereo out; out.resize(n);
    int maxB = *std::max_element(sched.begin(), sched.end());
    juce::AudioBuffer<float> work(2, maxB);
    juce::MidiBuffer midi;
    size_t si = 0;
    for (int pos = 0; pos < n;)
    {
        const int b = std::min(sched[si++ % sched.size()], n - pos);
        for (int c = 0; c < 2; ++c)
            std::memcpy(work.getWritePointer(c), in.ch[c].data() + pos, sizeof(float) * static_cast<size_t>(b));
        float* ptrs[2] = { work.getWritePointer(0), work.getWritePointer(1) };
        juce::AudioBuffer<float> view(ptrs, 2, b);
        fx.proc().processBlock(view, midi);
        for (int c = 0; c < 2; ++c)
            std::memcpy(out.ch[c].data() + pos, ptrs[c], sizeof(float) * static_cast<size_t>(b));
        pos += b;
    }
    return out;
}

static Stereo renderStd(Fx& fx, const Stereo& in) { return render(fx, in, std::vector<int>{ kStdBlock }); }

// ----------------------------------------------------------------------------
// Latency (measured from a unit impulse, neutral configuration)
// ----------------------------------------------------------------------------

struct LatencyResult { int measured = 0; int reported = 0; int published = 0; bool ok = false; };

static std::map<std::pair<std::string, int>, LatencyResult> g_latCache;

static LatencyResult measureLatency(const Subject& s, double sr)
{
    const auto key = std::make_pair(s.id, static_cast<int>(std::lround(sr)));
    auto it = g_latCache.find(key);
    if (it != g_latCache.end()) return it->second;

    const int impulseAt = 4096;
    const int total = 24576;
    Fx fx = makeFx(s, sr, 2500.0, true, kPrepareBlock);
    const Stereo in = makeImpulse(total, impulseAt);
    const Stereo out = renderStd(fx, in);

    int peakIdx = -1; float peak = 0.0f;
    for (int i = 0; i < total; ++i)
    {
        const float v = std::max(std::abs(out.ch[0][static_cast<size_t>(i)]), std::abs(out.ch[1][static_cast<size_t>(i)]));
        if (v > peak) { peak = v; peakIdx = i; }
    }
    LatencyResult r;
    r.ok = peak > 0.05f;
    r.measured = peakIdx - impulseAt;
    r.reported = fx.reported();
    r.published = fx.published();
    if (!r.ok) warnf("impulse response peak too small for %s @%.0f (peak %.4f)", s.id.c_str(), sr, static_cast<double>(peak));
    g_latCache[key] = r;
    return r;
}

// G6 support: the same impulse measurement through another block schedule (prepareToPlay(maxBlock = largest block)).
// Returns measured latency (peakIdx - impulseAt); ok = peak large enough.
static int measureLatencyWithSchedule(const Subject& s, double sr, const std::vector<int>& sched, bool& ok)
{
    const int impulseAt = 4096;
    const int total = 24576;
    const int maxB = *std::max_element(sched.begin(), sched.end());
    Fx fx = makeFx(s, sr, 2500.0, true, maxB);
    const Stereo out = render(fx, makeImpulse(total, impulseAt), sched);
    int peakIdx = -1; float peak = 0.0f;
    for (int i = 0; i < total; ++i)
    {
        const float v = std::max(std::abs(out.ch[0][static_cast<size_t>(i)]), std::abs(out.ch[1][static_cast<size_t>(i)]));
        if (v > peak) { peak = v; peakIdx = i; }
    }
    ok = peak > 0.05f;
    return peakIdx - impulseAt;
}

// ----------------------------------------------------------------------------
// Alignment
// ----------------------------------------------------------------------------

struct Aligned { Stereo in, out; int skip = 0; int n() const { return in.size(); } };

static Aligned align(const Stereo& in, const Stereo& out, int lat, double sr, double skipSec = kSkipSec)
{
    Aligned a;
    const int n = std::max(0, in.size() - lat);
    a.in.resize(n); a.out.resize(n);
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < n; ++i)
        {
            a.in.ch[c][static_cast<size_t>(i)]  = in.ch[c][static_cast<size_t>(i)];
            a.out.ch[c][static_cast<size_t>(i)] = out.ch[c][static_cast<size_t>(i + lat)];
        }
    a.skip = std::min(static_cast<int>(skipSec * sr), n / 4);
    return a;
}

// ============================================================================
// FFT / Welch PSD / STFT
// ============================================================================

struct Fft
{
    int n = 0;
    std::vector<int> rev;
    std::vector<std::complex<double>> tw;

    explicit Fft(int n_) : n(n_)
    {
        int lg = 0; while ((1 << lg) < n) ++lg;
        rev.resize(static_cast<size_t>(n));
        for (int i = 0; i < n; ++i)
            rev[static_cast<size_t>(i)] = (rev[static_cast<size_t>(i >> 1)] >> 1) | ((i & 1) << (lg - 1));
        tw.resize(static_cast<size_t>(n / 2));
        for (int k = 0; k < n / 2; ++k)
            tw[static_cast<size_t>(k)] = std::polar(1.0, -2.0 * juce::MathConstants<double>::pi * k / n);
    }

    void forward(std::vector<std::complex<double>>& a) const
    {
        for (int i = 0; i < n; ++i)
        {
            const int j = rev[static_cast<size_t>(i)];
            if (j > i) std::swap(a[static_cast<size_t>(i)], a[static_cast<size_t>(j)]);
        }
        for (int len = 2; len <= n; len <<= 1)
        {
            const int half = len / 2, step = n / len;
            for (int i = 0; i < n; i += len)
                for (int j = 0; j < half; ++j)
                {
                    const auto w = tw[static_cast<size_t>(j * step)];
                    const auto u = a[static_cast<size_t>(i + j)];
                    const auto v = a[static_cast<size_t>(i + j + half)] * w;
                    a[static_cast<size_t>(i + j)]        = u + v;
                    a[static_cast<size_t>(i + j + half)] = u - v;
                }
        }
    }
};

static std::vector<double> hannPeriodic(int n)
{
    std::vector<double> w(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i)
        w[static_cast<size_t>(i)] = 0.5 - 0.5 * std::cos(2.0 * juce::MathConstants<double>::pi * i / n);
    return w;
}

static constexpr int kWelchN = 8192;

// Welch PSD (Hann 8192, 50 % overlap) of the listed channels, power-averaged
// over segments and channels. Unnormalised |X|^2 (only ratios are used).
static std::vector<double> welchPsd(const Stereo& s, int begin, int end, bool useL, bool useR)
{
    static const Fft fft(kWelchN);
    static const std::vector<double> win = hannPeriodic(kWelchN);
    std::vector<double> acc(static_cast<size_t>(kWelchN / 2 + 1), 0.0);
    std::vector<std::complex<double>> buf(static_cast<size_t>(kWelchN));
    int count = 0;
    for (int c = 0; c < 2; ++c)
    {
        if ((c == 0 && !useL) || (c == 1 && !useR)) continue;
        for (int p = begin; p + kWelchN <= end; p += kWelchN / 2)
        {
            for (int i = 0; i < kWelchN; ++i)
                buf[static_cast<size_t>(i)] = { s.ch[c][static_cast<size_t>(p + i)] * win[static_cast<size_t>(i)], 0.0 };
            fft.forward(buf);
            for (int k = 0; k <= kWelchN / 2; ++k)
                acc[static_cast<size_t>(k)] += std::norm(buf[static_cast<size_t>(k)]);
            ++count;
        }
    }
    if (count > 0) for (double& v : acc) v /= count;
    return acc;
}

// ideal_dB: the yardstick for removed_dB. The planted RBJ bell's magnitude response
// (dB), averaged over exactly the Welch bins removedCollateral() uses for `removed`
// (k >= 1, f0 / 2^(1/6) <= k*sr/kWelchN <= f0 * 2^(1/6)), i.e. the same mean-of-dB.
static double bellMagDb(double f, double sr, double f0, double q, double gainDb)
{
    const double A = std::pow(10.0, gainDb / 40.0);
    const double w0 = 2.0 * juce::MathConstants<double>::pi * f0 / sr;
    const double alpha = std::sin(w0) / (2.0 * q);
    const double cw = std::cos(w0);
    const double a0 = 1.0 + alpha / A;
    const double b0 = (1.0 + alpha * A) / a0, b1 = (-2.0 * cw) / a0, b2 = (1.0 - alpha * A) / a0;
    const double a1 = (-2.0 * cw) / a0, a2 = (1.0 - alpha / A) / a0;
    const double w = 2.0 * juce::MathConstants<double>::pi * f / sr;
    const std::complex<double> z1 = std::polar(1.0, -w), z2 = std::polar(1.0, -2.0 * w);
    const std::complex<double> hn = b0 + b1 * z1 + b2 * z2;
    const std::complex<double> hd = 1.0 + a1 * z1 + a2 * z2;
    return 10.0 * std::log10(std::max(std::norm(hn) / std::max(std::norm(hd), 1.0e-300), 1.0e-300));
}

static double idealBoostDb(double sr, double f0, double q = 8.0, double gainDb = 12.0)
{
    const double binHz = sr / kWelchN;
    const double s6 = std::pow(2.0, 1.0 / 6.0);
    const double lo1 = f0 / s6, hi1 = f0 * s6;
    double acc = 0; int n = 0;
    for (int k = 1; k <= kWelchN / 2; ++k)
    {
        const double f = static_cast<double>(k) * binHz;
        if (f >= lo1 && f <= hi1) { acc += bellMagDb(f, sr, f0, q, gainDb); ++n; }
    }
    return n ? acc / n : 0.0;
}

struct RC { double removed = 0, collateral = 0; };

static RC removedCollateral(const std::vector<double>& pin, const std::vector<double>& pout, double sr, double f0)
{
    const double binHz = sr / kWelchN;
    const double s6 = std::pow(2.0, 1.0 / 6.0), s3 = std::pow(2.0, 1.0 / 3.0);
    const double lo1 = f0 / s6, hi1 = f0 * s6, lo3 = f0 / s3, hi3 = f0 * s3;
    double sr1 = 0, sc = 0; int n1 = 0, nc = 0;
    for (size_t k = 1; k < pin.size(); ++k)
    {
        const double f = static_cast<double>(k) * binHz;
        const double d = dbPow(pin[k]) - dbPow(pout[k]);
        if (f >= lo1 && f <= hi1) { sr1 += d; ++n1; }
        if (f >= 100.0 && f <= 12000.0 && !(f >= lo3 && f <= hi3)) { sc += std::abs(d); ++nc; }
    }
    RC r;
    r.removed    = n1 ? sr1 / n1 : 0.0;
    r.collateral = nc ? sc / nc : 0.0;
    return r;
}

// ============================================================================
// Metrics
// ============================================================================

// 2. Transparency: RMS(out - in) over both channels, dBFS.
static double rmsDiffDbfs(const Aligned& a)
{
    double acc = 0; long long cnt = 0;
    for (int c = 0; c < 2; ++c)
        for (int i = a.skip; i < a.n(); ++i)
        {
            const double d = static_cast<double>(a.out.ch[c][static_cast<size_t>(i)]) - a.in.ch[c][static_cast<size_t>(i)];
            acc += d * d; ++cnt;
        }
    return dbAmp(std::sqrt(acc / std::max<long long>(cnt, 1)));
}

// ----------------------------------------------------------------------------
// v3: residual vs CLEAN. Signal A is the clean pink noise C filtered by the planted bell, so an ideal
// suppressor's output equals C. Both figures compare the (latency-aligned) output PSD with the PSD of the
// UNPROCESSED clean signal over the same samples, same Welch settings as removed_dB.
//   inWindow   = mean over f0 +/- 1/6 oct of dB(PSD_out) - dB(PSD_clean)   (ideal 0; >0 resonance remains; <0 over-suppressed)
//   outsideDev = mean over 100 Hz-12 kHz excluding f0 +/- 1/3 oct of |dB(PSD_out) - dB(PSD_clean)|
// ----------------------------------------------------------------------------
struct Residual { double inWindow = 0, outsideDev = 0; };

static Residual residualVsClean(const std::vector<double>& pout, const std::vector<double>& pclean, double sr, double f0)
{
    const double binHz = sr / kWelchN;
    const double s6 = std::pow(2.0, 1.0 / 6.0), s3 = std::pow(2.0, 1.0 / 3.0);
    const double lo1 = f0 / s6, hi1 = f0 * s6, lo3 = f0 / s3, hi3 = f0 * s3;
    double sw = 0, sd = 0; int nw = 0, nd = 0;
    for (size_t k = 1; k < pout.size(); ++k)
    {
        const double f = static_cast<double>(k) * binHz;
        const double d = dbPow(pout[k]) - dbPow(pclean[k]);
        if (f >= lo1 && f <= hi1) { sw += d; ++nw; }
        if (f >= 100.0 && f <= 12000.0 && !(f >= lo3 && f <= hi3)) { sd += std::abs(d); ++nd; }
    }
    Residual r;
    r.inWindow   = nw ? sw / nw : 0.0;
    r.outsideDev = nd ? sd / nd : 0.0;
    return r;
}

// Welch PSD of the clean reference, cached per (tag, window, channel selection): the clean signal does not depend on f0 or subject.
static const std::vector<double>& cleanPsd(const std::string& tag, const Stereo& clean, int begin, int end, bool useL, bool useR)
{
    static std::map<std::tuple<std::string, int, int, bool, bool>, std::vector<double>> cache;
    // The seed shift is part of the key: the clean noise depends on it, and a --seedset run grades several seeds in one process (a key without it graded seeds 2.. against seed 1's clean PSD).
    const auto key = std::make_tuple(tag + "#seed" + std::to_string(g_opt.seed) + (g_opt.corrNoise ? "#corr" : ""), begin, end, useL, useR);
    auto it = cache.find(key);
    if (it == cache.end()) it = cache.emplace(key, welchPsd(clean, begin, end, useL, useR)).first;
    return it->second;
}

// 3. Suppression accuracy on an aligned pair (both channels, power-averaged by default) plus the v3 residual
//    figures against `clean` (the unprocessed C, sample-aligned with a.in).
struct Accuracy { RC rc; Residual res; };

static Accuracy suppressionAccuracy(const Aligned& a, const std::string& cleanTag, const Stereo& clean, double sr, double f0,
                                    bool useL = true, bool useR = true)
{
    const auto pin  = welchPsd(a.in,  a.skip, a.n(), useL, useR);
    const auto pout = welchPsd(a.out, a.skip, a.n(), useL, useR);
    Accuracy r;
    r.rc  = removedCollateral(pin, pout, sr, f0);
    r.res = residualVsClean(pout, cleanPsd(cleanTag, clean, a.skip, a.n(), useL, useR), sr, f0);
    return r;
}

// 5. Delta artefact energy outside f0 +/- 1/3 octave vs total input energy (dB).
static double deltaArtefactDb(const Aligned& a, double sr, double f0)
{
    Stereo delta; delta.resize(a.n());
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < a.n(); ++i)
            delta.ch[c][static_cast<size_t>(i)] = a.in.ch[c][static_cast<size_t>(i)] - a.out.ch[c][static_cast<size_t>(i)];
    const auto pd = welchPsd(delta, a.skip, a.n(), true, true);
    const auto pi = welchPsd(a.in,  a.skip, a.n(), true, true);
    const double binHz = sr / kWelchN;
    const double s3 = std::pow(2.0, 1.0 / 3.0);
    const double lo = f0 / s3, hi = f0 * s3;
    double eOut = 0, eIn = 0;
    for (size_t k = 0; k < pd.size(); ++k)
    {
        const double f = static_cast<double>(k) * binHz;
        eIn += pi[k];
        if (!(f >= lo && f <= hi)) eOut += pd[k];
    }
    return dbPow(eOut / std::max(eIn, 1.0e-30));
}

// 6. Pre-echo: for each burst onset, the 20 ms BEFORE it (aligned, both channels).
//    outVsIn  = 10log10(E_out / E_in)            (the specified metric)
//    errVsIn  = 10log10(E_(out-in) / E_in)       (supplementary: error energy, exposes smear
//                                                 that a plain energy ratio can hide)
//    Each is averaged over bursts in dB.
//    bandOutVsIn / bandErrVsIn: the same two ratios restricted to f0 +/- 1/3 octave
//    (rectangular 20 ms window, zero-padded to 2048, Parseval band sum over FFT bins).
struct PreEcho { double outVsIn = 0, errVsIn = 0, bandOutVsIn = 0, bandErrVsIn = 0; int bursts = 0; };

static PreEcho preEcho(const Aligned& a, double sr, double bandF0 = 2500.0)
{
    constexpr int PN = 2048;
    static const Fft fft(PN);
    const int w = static_cast<int>(std::llround(0.020 * sr));
    const double s3 = std::pow(2.0, 1.0 / 3.0);
    const double bLo = bandF0 / s3, bHi = bandF0 * s3;
    const auto onsets = burstOnsets(a.n(), sr);
    double s1 = 0, s2 = 0, b1 = 0, b2 = 0; int cnt = 0;
    std::vector<std::complex<double>> xi(PN), xo(PN), xe(PN);
    for (int pos : onsets)
    {
        if (pos - w < 0 || pos > a.n()) continue;
        double ei = 0, eo = 0, ee = 0, bi = 0, bo = 0, be = 0;
        for (int c = 0; c < 2; ++c)
        {
            std::fill(xi.begin(), xi.end(), std::complex<double>(0.0, 0.0));
            std::fill(xo.begin(), xo.end(), std::complex<double>(0.0, 0.0));
            std::fill(xe.begin(), xe.end(), std::complex<double>(0.0, 0.0));
            for (int i = pos - w; i < pos; ++i)
            {
                const double x = a.in.ch[c][static_cast<size_t>(i)], y = a.out.ch[c][static_cast<size_t>(i)];
                ei += x * x; eo += y * y; ee += (y - x) * (y - x);
                const size_t j = static_cast<size_t>(i - (pos - w));
                xi[j] = x; xo[j] = y; xe[j] = y - x;
            }
            fft.forward(xi); fft.forward(xo); fft.forward(xe);
            for (int k = 1; k < PN / 2; ++k)
            {
                const double f = static_cast<double>(k) * sr / PN;
                if (f < bLo || f > bHi) continue;
                bi += std::norm(xi[static_cast<size_t>(k)]);
                bo += std::norm(xo[static_cast<size_t>(k)]);
                be += std::norm(xe[static_cast<size_t>(k)]);
            }
        }
        s1 += dbPow(eo) - dbPow(ei); s2 += dbPow(ee) - dbPow(ei);
        b1 += dbPow(bo) - dbPow(bi); b2 += dbPow(be) - dbPow(bi);
        ++cnt;
    }
    PreEcho r; r.bursts = cnt;
    if (cnt) { r.outVsIn = s1 / cnt; r.errVsIn = s2 / cnt; r.bandOutVsIn = b1 / cnt; r.bandErrVsIn = b2 / cnt; }
    return r;
}

// 4. Musical-noise jitter. STFT 1024 Hann hop 256, 1/6-octave bands 100 Hz-12 kHz.
struct Jitter
{
    double stdAll = 0, stdLoc = 0, isoAll = 0, isoLoc = 0;
    int bands = 0, bandsLoc = 0, frames = 0;
};

static Jitter jitterMetrics(const Aligned& a, double sr)
{
    constexpr int N = 1024, HOP = 256;
    static const Fft fft(N);
    static const std::vector<double> win = hannPeriodic(N);

    // Band layout: [100*2^(j/6), 100*2^((j+1)/6)) clipped to 12 kHz; keep bands holding >=1 bin.
    std::vector<int> binToBand(static_cast<size_t>(N / 2 + 1), -1);
    std::vector<int> bandIndexOfJ;            // used-band -> j
    std::vector<double> bandCentre;
    {
        std::vector<int> cnt;
        const double binHz = sr / N;
        for (int j = 0;; ++j)
        {
            const double lo = 100.0 * std::pow(2.0, j / 6.0);
            if (lo >= 12000.0) break;
            const double hi = std::min(100.0 * std::pow(2.0, (j + 1) / 6.0), 12000.0);
            int c = 0;
            const int used = static_cast<int>(bandIndexOfJ.size());
            for (int k = 1; k <= N / 2; ++k)
            {
                const double f = k * binHz;
                if (f >= lo && f < hi) { binToBand[static_cast<size_t>(k)] = used; ++c; }
            }
            if (c > 0) { bandIndexOfJ.push_back(j); bandCentre.push_back(std::sqrt(lo * hi)); }
        }
    }
    const int B = static_cast<int>(bandIndexOfJ.size());
    std::vector<char> isLocal(static_cast<size_t>(B), 0);
    int nLoc = 0;
    for (int b = 0; b < B; ++b)
        if (bandCentre[static_cast<size_t>(b)] >= 1250.0 && bandCentre[static_cast<size_t>(b)] <= 5000.0)
        { isLocal[static_cast<size_t>(b)] = 1; ++nLoc; }

    Jitter res; res.bands = B; res.bandsLoc = nLoc;
    int nCh = 0;
    for (int c = 0; c < 2; ++c)
    {
        std::vector<float> G;   // [t][b]
        int T = 0;
        std::vector<std::complex<double>> bi(static_cast<size_t>(N)), bo(static_cast<size_t>(N));
        for (int p = a.skip; p + N <= a.n(); p += HOP, ++T)
        {
            for (int i = 0; i < N; ++i)
            {
                const double w = win[static_cast<size_t>(i)];
                bi[static_cast<size_t>(i)] = { a.in.ch[c][static_cast<size_t>(p + i)] * w, 0.0 };
                bo[static_cast<size_t>(i)] = { a.out.ch[c][static_cast<size_t>(p + i)] * w, 0.0 };
            }
            fft.forward(bi); fft.forward(bo);
            std::vector<double> ei(static_cast<size_t>(B), 0.0), eo(static_cast<size_t>(B), 0.0);
            for (int k = 1; k <= N / 2; ++k)
            {
                const int b = binToBand[static_cast<size_t>(k)];
                if (b < 0) continue;
                ei[static_cast<size_t>(b)] += std::norm(bi[static_cast<size_t>(k)]);
                eo[static_cast<size_t>(b)] += std::norm(bo[static_cast<size_t>(k)]);
            }
            for (int b = 0; b < B; ++b)
                G.push_back(static_cast<float>(10.0 * std::log10((eo[static_cast<size_t>(b)] + 1.0e-20) / (ei[static_cast<size_t>(b)] + 1.0e-20))));
        }
        if (T < 3 || B < 3) continue;
        auto g = [&](int t, int b) { return G[static_cast<size_t>(t) * static_cast<size_t>(B) + static_cast<size_t>(b)]; };

        double sAll = 0, sLoc = 0;
        for (int b = 0; b < B; ++b)
        {
            double m = 0; for (int t = 0; t < T; ++t) m += g(t, b);
            m /= T;
            double v = 0; for (int t = 0; t < T; ++t) { const double d = g(t, b) - m; v += d * d; }
            const double sd = std::sqrt(v / T);
            sAll += sd;
            if (isLocal[static_cast<size_t>(b)]) sLoc += sd;
        }
        long long isoAll = 0, isoLoc = 0, cellsAll = 0, cellsLoc = 0;
        for (int t = 1; t < T - 1; ++t)
            for (int b = 1; b < B - 1; ++b)
            {
                ++cellsAll; if (isLocal[static_cast<size_t>(b)]) ++cellsLoc;
                if (!(g(t, b) < -3.0f)) continue;
                bool iso = true;
                for (int dt = -1; dt <= 1 && iso; ++dt)
                    for (int db = -1; db <= 1; ++db)
                    {
                        if (dt == 0 && db == 0) continue;
                        if (!(g(t + dt, b + db) > -1.5f)) { iso = false; break; }
                    }
                if (iso) { ++isoAll; if (isLocal[static_cast<size_t>(b)]) ++isoLoc; }
            }
        res.stdAll += sAll / B;
        res.stdLoc += nLoc ? sLoc / nLoc : 0.0;
        res.isoAll += cellsAll ? static_cast<double>(isoAll) / cellsAll : 0.0;
        res.isoLoc += cellsLoc ? static_cast<double>(isoLoc) / cellsLoc : 0.0;
        res.frames = T;
        ++nCh;
    }
    if (nCh) { res.stdAll /= nCh; res.stdLoc /= nCh; res.isoAll /= nCh; res.isoLoc /= nCh; }
    return res;
}

// ----------------------------------------------------------------------------
// Real-material proxy metrics (informational, NO gates). STFT 1024 Hann hop 256 of the latency-aligned input and output (the same
// front end and 1/6-octave band layout as the jitter metric), G(t,b) = 10 log10(E_out / E_in) per band, cut = -G (positive = reduction).
//   mean cut   = mean of cut over every (frame, band, channel) cell
//   p95 cut    = 95th percentile of the same cells
//   flicker    = mean |G(t,b) - G(t-1,b)| over bands, frames and channels (frame-to-frame change of the applied gain, dB)
//   frac > 6   = fraction of (frame, channel) pairs in which ANY band is cut by more than 6 dB (mean of the two channels)
// Cells where the input band holds no energy at all (digital silence) are G = 0 by the 1e-20 floor, as in the jitter metric.
// ----------------------------------------------------------------------------
struct ProxyStats { double meanCut = 0, p95Cut = 0, flicker = 0, fracOver6 = 0; int bands = 0, frames = 0; };

static ProxyStats realMaterialProxy(const Aligned& a, double sr)
{
    constexpr int N = 1024, HOP = 256;
    static const Fft fft(N);
    static const std::vector<double> win = hannPeriodic(N);
    std::vector<int> binToBand(static_cast<size_t>(N / 2 + 1), -1);
    int B = 0;
    {
        const double binHz = sr / N;
        for (int j = 0;; ++j)
        {
            const double lo = 100.0 * std::pow(2.0, j / 6.0);
            if (lo >= 12000.0) break;
            const double hi = std::min(100.0 * std::pow(2.0, (j + 1) / 6.0), 12000.0);
            int c = 0;
            for (int k = 1; k <= N / 2; ++k)
            {
                const double f = k * binHz;
                if (f >= lo && f < hi) { binToBand[static_cast<size_t>(k)] = B; ++c; }
            }
            if (c > 0) ++B;
        }
    }
    ProxyStats res; res.bands = B;
    std::vector<float> cuts;
    double flickSum = 0.0; long long flickN = 0, over6 = 0, framePairs = 0;
    int T = 0;
    for (int c = 0; c < 2; ++c)
    {
        std::vector<std::complex<double>> bi(static_cast<size_t>(N)), bo(static_cast<size_t>(N));
        std::vector<float> prev(static_cast<size_t>(B), 0.0f);
        bool havePrev = false;
        T = 0;
        for (int p = a.skip; p + N <= a.n(); p += HOP, ++T)
        {
            for (int i = 0; i < N; ++i)
            {
                const double w = win[static_cast<size_t>(i)];
                bi[static_cast<size_t>(i)] = { a.in.ch[c][static_cast<size_t>(p + i)] * w, 0.0 };
                bo[static_cast<size_t>(i)] = { a.out.ch[c][static_cast<size_t>(p + i)] * w, 0.0 };
            }
            fft.forward(bi); fft.forward(bo);
            std::vector<double> ei(static_cast<size_t>(B), 0.0), eo(static_cast<size_t>(B), 0.0);
            for (int k = 1; k <= N / 2; ++k)
            {
                const int b = binToBand[static_cast<size_t>(k)];
                if (b < 0) continue;
                ei[static_cast<size_t>(b)] += std::norm(bi[static_cast<size_t>(k)]);
                eo[static_cast<size_t>(b)] += std::norm(bo[static_cast<size_t>(k)]);
            }
            bool anyOver = false;
            for (int b = 0; b < B; ++b)
            {
                const float G = static_cast<float>(10.0 * std::log10((eo[static_cast<size_t>(b)] + 1.0e-20) / (ei[static_cast<size_t>(b)] + 1.0e-20)));
                cuts.push_back(-G);
                if (-G > 6.0f) anyOver = true;
                if (havePrev) { flickSum += std::abs(G - prev[static_cast<size_t>(b)]); ++flickN; }
                prev[static_cast<size_t>(b)] = G;
            }
            havePrev = true;
            ++framePairs; if (anyOver) ++over6;
        }
    }
    if (cuts.empty()) return res;
    double sum = 0.0; for (float v : cuts) sum += v;
    res.meanCut = sum / static_cast<double>(cuts.size());
    const size_t k95 = std::min(cuts.size() - 1, static_cast<size_t>(0.95 * static_cast<double>(cuts.size() - 1) + 0.5));
    std::nth_element(cuts.begin(), cuts.begin() + static_cast<std::ptrdiff_t>(k95), cuts.end());
    res.p95Cut = cuts[k95];
    res.flicker = flickN ? flickSum / static_cast<double>(flickN) : 0.0;
    res.fracOver6 = framePairs ? static_cast<double>(over6) / static_cast<double>(framePairs) : 0.0;
    res.frames = T;
    return res;
}

// ----------------------------------------------------------------------------
// Detector geometry (section 10): runs the RS HQ detector front end (sqrt-Hann
// window, unnormalised real FFT, magDb = 10log10(max(|X|^2, 1e-24)), bins 0 and N/2
// = -240) over a signal and reads the detector baseline through the existing test
// hook XlethResonanceSuppressorEffect::computeDetectorBaselinesForTest. Statistics at
// bin k0 are the mean over all frames (hop N/4) and both channels, after the 2 s skip.
// ----------------------------------------------------------------------------

struct GeomStats
{
    double mag = 0, base = 0, excess = 0, pTrig = 0, maxRefPrefixDiff = 0, maxOwnVsHookDiff = 0;
    long long frames = 0;
};

static GeomStats detectorGeometry(const Stereo& sig, int N, int k0, int gap, double offsetDb, int skipSamples)
{
    const int hop = N / 4;
    const Fft fft(N);
    std::vector<double> win(static_cast<size_t>(N));
    for (int i = 0; i < N; ++i)
        win[static_cast<size_t>(i)] = std::sqrt(std::max(0.5 - 0.5 * std::cos(2.0 * juce::MathConstants<double>::pi * i / N), 0.0));
    std::vector<std::complex<double>> buf(static_cast<size_t>(N));
    std::vector<float> magDb(static_cast<size_t>(N / 2 + 1));
    GeomStats g;
    long long trig = 0;
    for (int c = 0; c < 2; ++c)
        for (int p = skipSamples; p + N <= sig.size(); p += hop)
        {
            for (int i = 0; i < N; ++i)
                buf[static_cast<size_t>(i)] = { sig.ch[c][static_cast<size_t>(p + i)] * win[static_cast<size_t>(i)], 0.0 };
            fft.forward(buf);
            magDb[0] = -240.0f;
            magDb[static_cast<size_t>(N / 2)] = -240.0f;
            for (int k = 1; k < N / 2; ++k)
            {
                const float magSq = std::max(static_cast<float>(std::norm(buf[static_cast<size_t>(k)])), 1.0e-24f);
                magDb[static_cast<size_t>(k)] = 10.0f * std::log10(magSq);
            }
            const auto r = XlethResonanceSuppressorEffect::computeDetectorBaselinesForTest(magDb, gap);
            const double m = magDb[static_cast<size_t>(k0)];
            const double b = r.prefix[static_cast<size_t>(k0)];
            g.mag += m; g.base += b; g.excess += m - b;
            if (m - b > offsetDb) ++trig;
            g.maxRefPrefixDiff = std::max(g.maxRefPrefixDiff, std::abs(static_cast<double>(r.reference[static_cast<size_t>(k0)]) - b));
            // Independent re-derivation of the baseline geometry (radius = clamp(k/6+4, 6, 48); window excludes |j-k0| <= gap)
            // from the source, to confirm the radius/window numbers printed in the geometry table match what the hook computed.
            {
                const int rad = std::clamp(k0 / 6 + 4, 6, 48);
                const int lo = std::max(1, k0 - rad), hi = std::min(N / 2 - 1, k0 + rad);
                double sum = 0; int cnt = 0;
                for (int j = lo; j <= hi; ++j)
                    if (std::abs(j - k0) > gap) { sum += magDb[static_cast<size_t>(j)]; ++cnt; }
                if (cnt) g.maxOwnVsHookDiff = std::max(g.maxOwnVsHookDiff, std::abs(sum / cnt - b));
            }
            ++g.frames;
        }
    if (g.frames)
    {
        g.mag /= g.frames; g.base /= g.frames; g.excess /= g.frames;
        g.pTrig = static_cast<double>(trig) / g.frames;
    }
    return g;
}

// ============================================================================
// WAV I/O
// ============================================================================

static bool writeWav(const fs::path& path, const Stereo& s, double sr, int n = -1)
{
    if (n < 0) n = s.size();
    juce::File f(path.string());
    f.deleteFile();
    auto* stream = new juce::FileOutputStream(f);
    if (stream->failedToOpen()) { delete stream; warnf("cannot open %s for writing", path.string().c_str()); return false; }
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::AudioFormatWriter> w(wav.createWriterFor(stream, sr, 2u, 24, {}, 0));
    if (!w) { delete stream; warnf("cannot create WAV writer for %s", path.string().c_str()); return false; }
    const float* d[2] = { s.ch[0].data(), s.ch[1].data() };
    return w->writeFromFloatArrays(d, 2, n);
}

static Stereo deltaOf(const Aligned& a)
{
    Stereo d; d.resize(a.n());
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < a.n(); ++i)
            d.ch[c][static_cast<size_t>(i)] = a.in.ch[c][static_cast<size_t>(i)] - a.out.ch[c][static_cast<size_t>(i)];
    return d;
}

static bool readWav(const std::string& path, Stereo& out, double& sr)
{
    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> r(fm.createReaderFor(juce::File(path)));
    if (!r) return false;
    const int n = static_cast<int>(r->lengthInSamples);
    juce::AudioBuffer<float> buf(static_cast<int>(std::max<unsigned>(r->numChannels, 2u)), n);
    buf.clear();
    r->read(&buf, 0, n, 0, true, true);
    out.resize(n);
    for (int c = 0; c < 2; ++c)
    {
        const int src = (r->numChannels >= 2) ? c : 0;   // mono -> both channels
        std::memcpy(out.ch[c].data(), buf.getReadPointer(src), sizeof(float) * static_cast<size_t>(n));
    }
    sr = r->sampleRate;
    return true;
}

// ============================================================================
// Environment info
// ============================================================================

static std::string cpuBrand()
{
#if defined(_MSC_VER)
    int r[4] = {};
    __cpuid(r, static_cast<int>(0x80000000));
    if (static_cast<unsigned>(r[0]) < 0x80000004u) return "unknown";
    char b[49] = {};
    for (int i = 0; i < 3; ++i)
    {
        __cpuid(r, static_cast<int>(0x80000002 + i));
        std::memcpy(b + 16 * i, r, 16);
    }
    std::string s(b);
    const auto p = s.find_first_not_of(' ');
    return p == std::string::npos ? s : s.substr(p);
#else
    return "unknown";
#endif
}

static std::string buildConfig(bool& isRelease)
{
#if defined(_DEBUG)
    isRelease = false; return "Debug (_DEBUG defined)";
#elif defined(NDEBUG)
    isRelease = true;  return "Release (NDEBUG defined)";
#else
    isRelease = false; return "UNKNOWN (neither _DEBUG nor NDEBUG defined)";
#endif
}

static std::string gitShortHash()
{
    std::string out;
#if defined(_WIN32)
    FILE* p = _popen("git rev-parse --short HEAD 2>nul", "r");
#else
    FILE* p = popen("git rev-parse --short HEAD 2>/dev/null", "r");
#endif
    if (p)
    {
        char b[64] = {};
        if (std::fgets(b, sizeof b, p)) out = b;
#if defined(_WIN32)
        _pclose(p);
#else
        pclose(p);
#endif
    }
    while (!out.empty() && (out.back() == '\n' || out.back() == '\r' || out.back() == ' ')) out.pop_back();
    return out.empty() ? "nogit" : out;
}

static std::string utcStamp()
{
    const std::time_t t = std::time(nullptr);
    std::tm tm{};
#if defined(_WIN32)
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char b[32];
    std::strftime(b, sizeof b, "%Y%m%dT%H%M%SZ", &tm);
    return b;
}

// ============================================================================
// CPU benchmark
// ============================================================================

static double percentile(std::vector<double>& v, double p)
{
    if (v.empty()) return 0.0;
    const size_t k = std::min(v.size() - 1, static_cast<size_t>(p * static_cast<double>(v.size() - 1) + 0.5));
    std::nth_element(v.begin(), v.begin() + static_cast<std::ptrdiff_t>(k), v.end());
    return v[k];
}

struct CpuResult { double medianNs = 0, p95Ns = 0, p99Ns = 0, maxNs = 0, meanNs = 0; };

static CpuResult cpuBench(const Subject& s, const Stereo& sig, double sr, int block)
{
    const int warmSamples = static_cast<int>(sr);   // 1 s untimed warm-up per repetition
    std::vector<double> ns;
    ns.reserve(static_cast<size_t>(cpuReps()) * static_cast<size_t>(sig.size() / block + 1));
    juce::AudioBuffer<float> work(2, block);
    juce::MidiBuffer midi;
    for (int rep = 0; rep < cpuReps(); ++rep)
    {
        Fx fx = makeFx(s, sr, 2500.0, false, block);
        auto& proc = fx.proc();
        const int total = sig.size();
        for (int pos = 0; pos + block <= total; pos += block)
        {
            for (int c = 0; c < 2; ++c)
                std::memcpy(work.getWritePointer(c), sig.ch[c].data() + pos, sizeof(float) * static_cast<size_t>(block));
            const bool timed = pos >= warmSamples;
            const auto t0 = std::chrono::steady_clock::now();
            proc.processBlock(work, midi);
            const auto t1 = std::chrono::steady_clock::now();
            if (timed) ns.push_back(static_cast<double>(std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count()));
        }
    }
    CpuResult r;
    if (!ns.empty())
    {
        r.meanNs = std::accumulate(ns.begin(), ns.end(), 0.0) / static_cast<double>(ns.size());
        r.maxNs = *std::max_element(ns.begin(), ns.end());
    }
    r.p99Ns = percentile(ns, 0.99);
    r.p95Ns = percentile(ns, 0.95);
    r.medianNs = percentile(ns, 0.50);
    return r;
}

// ============================================================================
// T1: time-varying resonance (v5)
// ============================================================================
//
// Signal. Per case (f0, D): clean pink noise C (-20 dBFS RMS, both channels, same generator and seed family as signal A: makePinkStereo(n, -20, 1)) and A = C filtered by the standard planted
// bell (RBJ peak +12 dB, Q 8, f0) in both channels. x = C + g(t) (A - C), g = 5 ms linear crossfades: up over [onset, onset + 5 ms], 1 until offset, down over [offset, offset + 5 ms]; offset = onset + D.
// 6 events, first onset at 2.0 s, off time between events >= 1.5 s (stretched so the nominal 14 s is filled when D is short). The nominal length is 14 s; D = 1000 ms cannot fit 6 events with
// >= 1.5 s gaps after a 2 s start-up (2 + 5 x 2.5 + 1 = 15.5 s) so the signal is extended to last offset + 1.3 s (16.8 s) in that case. The clean reference is C itself.
//
// Frames. STFT 1024 Hann (periodic), hop 128 (2.67 ms), laid out PER EVENT with frame centres at onset + k x 128 so every event has the same sub-sample phase and the events average
// coherently. E(k) = in-window energy (sum |X|^2 over the bins inside f0 +/- 1/6 octave), mean of the two channels. E_out is taken on the latency-aligned output (aligned with the input),
// E_pass on the input itself (= the un-suppressed resonance, what the R0 pass-through returns), E_clean on C. t = k x 128 / sr is the time since the onset.
//
// r(t)       = 10 log10( mean_events E_out / mean_events E_clean ) after smoothing both energy curves with a 10 ms boxcar (fractional edge weights); r_pass(t) the same with E_pass.
//              (ratio of event means, not mean of per-frame ratios: the in-window bin count is small - 2 bins at 500 Hz - so single-frame ratios are noise.)
// p(t)       = 1 - r(t) / r_pass(t), clipped to [0, 1.2], for 0 <= t <= D. Frames with r_pass < kTvPassMinDb (the resonance is not yet visible to the STFT, e.g. the first frames of the
//              Hann window straddling the onset) are given p = 0, so a near-zero denominator cannot create a spurious early crossing.
// t50 / t90  = first t in [0, D] with p >= 0.5 / 0.9. "never" (stored as -1) = not reached within the event; it is a FAILURE for G8a, not a missing value.
// leak       = sum_{0<=t<=D} max(0, E_out - E_clean) / sum_{0<=t<=D} (E_pass - E_clean) on the event-mean energies (1 = nothing suppressed, 0 = perfect).
// over_dB    = per event: min over 0 <= t - D <= 500 ms of 10 log10(E_out / E_clean) (both smoothed 20 ms, this event only), then the mean over events.
// settle_ms  = time after the offset from which |r(t)| (event-mean, 10 ms smoothing) stays <= 1 dB until the end of a 1 s horizon: time of the first frame after the last |r| > 1 dB frame
//              (0 if it never exceeds 1 dB); "never" (-1) if it is still outside 1 dB at the end of the horizon.
//
// r_off(T)   = (v6) the output level relative to the clean reference T ms after the offset: per event, the in-window energies E_out and E_clean are averaged over the interval
//              [D + T - 10 ms, D + T + 10 ms] (exact overlap weights of the 2.67 ms frame cells with the interval, so T need not fall on a frame), then the event MEANS are formed and
//              r_off(T) = 10 log10(mean_events E_out_int / mean_events E_clean_int) (the same event-mean ratio as r(t), no extra 10 ms boxcar: the +/-10 ms interval is the smoothing).
//              Gates (v6): G9a |r_off(500)| <= 1.0 dB, G9b |r_off(1000)| <= 0.5 dB at every (f0, D) (count of 9). A suppressor with a nonzero release is still cutting the clean noise by
//              the depth reached at the offset, so the old over_dB / settle_ms gates measured the depth of the cut, not whether it goes away; r_off(T) at 500 / 1000 ms measures whether it went away.
// tau_fit    = (v6, informational) effective release time constant: cut(T) = -r_off(T) sampled every 25 ms for T in [50, 500] ms (19 points) is fitted by c0 exp(-T / tau) (least squares in
//              dB, c0 free, tau on a log grid 2 ms .. 5 s, refined); "n/a" when cut(50 ms) < 1 dB (nothing to release), ">5000" when the best fit is at the grid limit (a plateau = never releases).
//              The window starts at 50 ms, not 0: the STFT window (+/- 10.7 ms), the +/- 10 ms interval and the 5 ms crossfade still contain on-time resonance at T < ~30 ms, so r_off(0) is
//              typically POSITIVE even for a deep suppressor and "cut at the offset" is not measurable there (r_off(0 / 25) stay in the table as informational values).
// over_dB, settle_ms and r_off(0 / 100 / 250) are INFORMATIONAL (v6), not gates.
//
// Calibration: R0 pass-through: p = 0 -> t50 never, leak 1.0, so it must FAIL G8. Oracle R1 (returns C): E_out = E_clean -> r = 0, p = 1 at the first frame with r_pass >= 1 dB, leak 0,
// over 0, settle 0, r_off 0, so it must PASS G8 and G9. R0 passes G9 (r_off 0: nothing is ever cut).

struct TvEvent { int onset = 0, offset = 0; };

static constexpr int    kTvFftN        = 1024;
static constexpr int    kTvHop         = 128;
static constexpr int    kTvEvents      = 6;
static constexpr double kTvNominalSec  = 14.0;
static constexpr double kTvFirstOnset  = 2.0;
static constexpr double kTvMinGapSec   = 1.5;
static constexpr double kTvTailSec     = 1.3;    // after the last offset: 1 s settle horizon + frame half-width + room for the largest subject latency
static constexpr double kTvFadeSec     = 0.005;
static constexpr double kTvPreSec      = 0.030;  // frames kept before the onset (smoothing support + the pre-onset level)
static constexpr double kTvHorizonSec  = 1.0;    // analysis after the offset (settle horizon)
static constexpr double kTvPassMinDb   = 1.0;    // analysis guard for p(t), see above (not a gate)
static constexpr double kTvSettleBandDb = 1.0;   // |r| band for settle_ms
static constexpr double kTvRoffHalfMs  = 10.0;   // r_off(T): half-width of the averaging interval
static constexpr int    kTvCurveStepMs = 25;     // r_off curve sampling for tau_fit: T = 0, 25, ... 500 ms
static constexpr int    kTvCurveMaxMs  = 500;
static constexpr double kTvTauMinMs    = 2.0;    // tau_fit grid
static constexpr double kTvTauMaxMs    = 5000.0;
static constexpr double kTvTauNaCutDb  = 1.0;    // "n/a" when the cut at the start of the fit is below this
static constexpr int    kTvTauStartMs  = 50;     // fit window T in [50, 500] ms: earlier samples still contain on-time resonance (STFT smear), see tvAnalyse
static const std::array<double, 3> kTvF0 = { 500.0, 2500.0, 8000.0 };
static const std::array<int, 3>    kTvDurMs = { 100, 300, 1000 };

struct TvCase
{
    double f0 = 0.0;
    int durMs = 0;
    std::vector<TvEvent> events;
    Stereo clean, sig;
};

static TvCase makeTvCase(double f0, int durMs, double sr)
{
    TvCase c; c.f0 = f0; c.durMs = durMs;
    const double D = durMs * 1.0e-3;
    const double gap = std::max(kTvMinGapSec, (kTvNominalSec - kTvTailSec - kTvFirstOnset - kTvEvents * D) / (kTvEvents - 1));
    for (int e = 0; e < kTvEvents; ++e)
    {
        TvEvent ev;
        ev.onset  = static_cast<int>(std::llround((kTvFirstOnset + e * (D + gap)) * sr));
        ev.offset = ev.onset + static_cast<int>(std::llround(D * sr));
        c.events.push_back(ev);
    }
    const int n = std::max(static_cast<int>(std::llround(kTvNominalSec * sr)),
                           c.events.back().offset + static_cast<int>(std::llround(kTvTailSec * sr)));
    c.clean = makePinkStereo(n, -20.0, 1);
    const Stereo A = makeResonant(c.clean, sr, f0, true, true);
    const int fade = static_cast<int>(std::llround(kTvFadeSec * sr));
    std::vector<double> g(static_cast<size_t>(n), 0.0);
    for (const auto& ev : c.events)
        for (int i = ev.onset; i < ev.offset + fade && i < n; ++i)
        {
            double v = 1.0;
            if (i < ev.onset + fade)  v = std::min(v, static_cast<double>(i - ev.onset) / fade);
            if (i >= ev.offset)       v = std::min(v, 1.0 - static_cast<double>(i - ev.offset) / fade);
            g[static_cast<size_t>(i)] = v;
        }
    c.sig = c.clean;
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < n; ++i)
        {
            const auto k = static_cast<size_t>(i);
            c.sig.ch[ch][k] = static_cast<float>(static_cast<double>(c.clean.ch[ch][k]) + g[k] * (static_cast<double>(A.ch[ch][k]) - static_cast<double>(c.clean.ch[ch][k])));
        }
    return c;
}

// Frame range (relative to each onset) shared by every curve of a case: k in [kMin, kMax], frame centre = onset + k x hop.
static void tvFrameRange(int durMs, double sr, int& kMin, int& kMax)
{
    kMin = -static_cast<int>(std::ceil(kTvPreSec * sr / kTvHop));
    kMax = static_cast<int>(std::ceil((durMs * 1.0e-3 + kTvHorizonSec + 0.020) * sr / kTvHop));
}

// In-window energy per event and frame (mean of both channels). `s` must share its time axis with the event schedule (aligned output, input or clean).
static std::vector<std::vector<double>> tvWindowEnergy(const Stereo& s, const std::vector<TvEvent>& ev, int kMin, int kMax, double sr, double f0)
{
    static const Fft fft(kTvFftN);
    static const std::vector<double> win = hannPeriodic(kTvFftN);
    const double s6 = std::pow(2.0, 1.0 / 6.0), binHz = sr / kTvFftN;
    std::vector<int> bins;
    for (int k = 1; k < kTvFftN / 2; ++k)
    {
        const double f = k * binHz;
        if (f >= f0 / s6 && f <= f0 * s6) bins.push_back(k);
    }
    std::vector<std::vector<double>> out(ev.size(), std::vector<double>(static_cast<size_t>(kMax - kMin + 1), 0.0));
    std::vector<std::complex<double>> buf(static_cast<size_t>(kTvFftN));
    int outOfRange = 0;
    for (size_t e = 0; e < ev.size(); ++e)
        for (int k = kMin; k <= kMax; ++k)
        {
            const int start = ev[e].onset + k * kTvHop - kTvFftN / 2;
            if (start < 0 || start + kTvFftN > s.size()) { ++outOfRange; continue; }
            double acc = 0.0;
            for (int c = 0; c < 2; ++c)
            {
                for (int i = 0; i < kTvFftN; ++i)
                    buf[static_cast<size_t>(i)] = { s.ch[c][static_cast<size_t>(start + i)] * win[static_cast<size_t>(i)], 0.0 };
                fft.forward(buf);
                for (int b : bins) acc += std::norm(buf[static_cast<size_t>(b)]);
            }
            out[e][static_cast<size_t>(k - kMin)] = acc / 2.0;
        }
    if (outOfRange > 0) warnf("T1: %d analysis frames fell outside the signal (f0 %.0f): the output is shorter than the schedule needs", outOfRange, f0);
    return out;
}

// Boxcar of `widthFrames` frames (fractional: the edge frame gets a partial weight) centred on each frame; the window shrinks at the ends.
static std::vector<double> tvSmooth(const std::vector<double>& x, double widthFrames)
{
    const int m = static_cast<int>(std::ceil(widthFrames / 2.0 + 0.5));
    std::vector<double> o(x.size(), 0.0);
    for (int i = 0; i < static_cast<int>(x.size()); ++i)
    {
        double acc = 0.0, ws = 0.0;
        for (int j = -m; j <= m; ++j)
        {
            const int idx = i + j;
            if (idx < 0 || idx >= static_cast<int>(x.size())) continue;
            const double w = std::clamp(widthFrames / 2.0 - std::abs(j) + 0.5, 0.0, 1.0);
            acc += w * x[static_cast<size_t>(idx)]; ws += w;
        }
        o[static_cast<size_t>(i)] = ws > 0.0 ? acc / ws : 0.0;
    }
    return o;
}

static std::vector<double> tvEventMean(const std::vector<std::vector<double>>& e)
{
    std::vector<double> m(e.empty() ? 0 : e[0].size(), 0.0);
    for (const auto& v : e) for (size_t i = 0; i < m.size(); ++i) m[i] += v[i];
    for (double& x : m) x /= std::max<size_t>(e.size(), 1);
    return m;
}

struct TvMetrics
{
    double t50 = -1.0, t90 = -1.0;      // ms since the onset; -1 = "never" (within the event)
    double leak = 1.0;
    double over = 0.0;                  // dB
    double settle = -1.0;               // ms since the offset; -1 = "never" (within the horizon)
    double rPassPeak = 0.0;             // dB, event-mean r_pass maximum (case-validity evidence)
    double rPeak = 0.0;                 // dB, event-mean r maximum during the on-time (what actually remains of the resonance)
    double rOff = 0.0;                  // dB, INFORMATIONAL: mean event-mean r over 0.5-1.0 s after the offset (steady-state deviation from the clean noise; separates a slow release from a permanent offset)
    // v6: r_off(T), dB, T = 0, 25, ... 500 ms (curve) and the two gated points. rOff500 / rOff1000 are the G9a / G9b values.
    std::vector<double> rOffCurve;      // r_off(0), r_off(25), ... r_off(500)
    double rOff100 = 0.0, rOff250 = 0.0, rOff500 = 0.0, rOff1000 = 0.0;
    double tauFit = -1.0;               // ms; -1 = n/a (cut(0) < 1 dB), -2 = ">5000" (no decay within the grid)
    bool   roffOk = true;               // false if an r_off interval fell outside the analysed frame range (would be a tool bug)
};

// Exact-overlap average of the per-frame event-mean energies `x` (frame i covers [(kMin + i) hop - hop/2, ... + hop/2] ms since the onset) over [centreMs - halfMs, centreMs + halfMs].
static bool tvIntervalMean(const std::vector<double>& x, int kMin, double centreMs, double halfMs, double sr, double& out)
{
    const double hopMs = 1000.0 * kTvHop / sr;
    double acc = 0.0, ws = 0.0;
    const double lo0 = centreMs - halfMs, hi0 = centreMs + halfMs;
    for (size_t i = 0; i < x.size(); ++i)
    {
        const double tc = (kMin + static_cast<int>(i)) * hopMs;
        const double w = std::min(tc + hopMs / 2.0, hi0) - std::max(tc - hopMs / 2.0, lo0);
        if (w > 0.0) { acc += w * x[i]; ws += w; }
    }
    out = ws > 0.0 ? acc / ws : 0.0;
    return ws >= 2.0 * halfMs * 0.999;
}

// Least-squares fit cut(T) ~ c0 exp(-T / tau) over the samples (c0 free, closed form per tau; tau on a log grid, then golden-section refinement). Returns tau in ms.
static double tvFitTau(const std::vector<double>& cut, bool& atLimit)
{
    const int n = static_cast<int>(cut.size());
    auto sse = [&](double tau) {
        double sxx = 0.0, sxy = 0.0, syy = 0.0;
        for (int i = 0; i < n; ++i)
        {
            const double e = std::exp(-static_cast<double>(i * kTvCurveStepMs) / tau), y = cut[static_cast<size_t>(i)];
            sxx += e * e; sxy += e * y; syy += y * y;
        }
        return syy - (sxx > 0.0 ? sxy * sxy / sxx : 0.0);       // residual with the optimal c0
    };
    const int G = 400;
    double best = kTvTauMinMs, bestE = 1.0e300; int bi = 0;
    for (int g = 0; g <= G; ++g)
    {
        const double tau = kTvTauMinMs * std::pow(kTvTauMaxMs / kTvTauMinMs, static_cast<double>(g) / G);
        const double e = sse(tau);
        if (e < bestE) { bestE = e; best = tau; bi = g; }
    }
    atLimit = (bi == G);
    if (bi > 0 && bi < G)
    {
        double a = kTvTauMinMs * std::pow(kTvTauMaxMs / kTvTauMinMs, static_cast<double>(bi - 1) / G);
        double b = kTvTauMinMs * std::pow(kTvTauMaxMs / kTvTauMinMs, static_cast<double>(bi + 1) / G);
        const double phi = 0.6180339887498949;
        for (int it = 0; it < 60; ++it)
        {
            const double c = b - phi * (b - a), d = a + phi * (b - a);
            if (sse(c) < sse(d)) b = d; else a = c;
        }
        best = 0.5 * (a + b);
    }
    return best;
}

static TvMetrics tvAnalyse(const std::vector<std::vector<double>>& eOut, const std::vector<std::vector<double>>& eClean,
                           const std::vector<std::vector<double>>& ePass, int durMs, int kMin, double sr)
{
    TvMetrics m;
    const double hopMs = 1000.0 * kTvHop / sr;
    const double w10 = 10.0 / hopMs, w20 = 20.0 / hopMs;
    const auto mo = tvEventMean(eOut), mc = tvEventMean(eClean), mp = tvEventMean(ePass);
    const auto so = tvSmooth(mo, w10), sc = tvSmooth(mc, w10), sp = tvSmooth(mp, w10);
    const int nK = static_cast<int>(mo.size());
    auto tOf = [&](int i) { return (kMin + i) * 1000.0 * kTvHop / sr; };    // ms since onset
    const double D = static_cast<double>(durMs);
    bool got50 = false, got90 = false;
    double sumLeak = 0.0, sumPass = 0.0;
    m.rPassPeak = -300.0; m.rPeak = -300.0;
    for (int i = 0; i < nK; ++i)
    {
        const double t = tOf(i);
        const double r = dbPow(so[static_cast<size_t>(i)]) - dbPow(sc[static_cast<size_t>(i)]);
        const double rp = dbPow(sp[static_cast<size_t>(i)]) - dbPow(sc[static_cast<size_t>(i)]);
        m.rPassPeak = std::max(m.rPassPeak, rp);
        if (t < 0.0 || t > D + 1.0e-9) continue;
        m.rPeak = std::max(m.rPeak, r);
        const double p = rp < kTvPassMinDb ? 0.0 : std::clamp(1.0 - r / rp, 0.0, 1.2);
        if (!got50 && p >= 0.5) { m.t50 = t; got50 = true; }
        if (!got90 && p >= 0.9) { m.t90 = t; got90 = true; }
        sumLeak += std::max(0.0, mo[static_cast<size_t>(i)] - mc[static_cast<size_t>(i)]);
        sumPass += mp[static_cast<size_t>(i)] - mc[static_cast<size_t>(i)];
    }
    m.leak = sumPass > 0.0 ? sumLeak / sumPass : 1.0;

    // over_dB: per event (smoothed 20 ms), min over 0..500 ms after the offset, mean over events.
    double acc = 0.0; int ne = 0;
    for (size_t e = 0; e < eOut.size(); ++e)
    {
        const auto o20 = tvSmooth(eOut[e], w20), c20 = tvSmooth(eClean[e], w20);
        double mn = 1.0e9;
        for (int i = 0; i < nK; ++i)
        {
            const double dt = tOf(i) - D;
            if (dt < 0.0 || dt > 500.0) continue;
            mn = std::min(mn, dbPow(o20[static_cast<size_t>(i)]) - dbPow(c20[static_cast<size_t>(i)]));
        }
        if (mn < 1.0e8) { acc += mn; ++ne; }
    }
    m.over = ne ? acc / ne : 0.0;

    // settle_ms: |r| (event-mean, 10 ms) back inside kTvSettleBandDb and staying there to the end of the horizon.
    int last = -1, lastIdx = -1;
    double offAcc = 0.0; int offN = 0;
    for (int i = 0; i < nK; ++i)
    {
        const double dt = tOf(i) - D;
        if (dt < 0.0 || dt > kTvHorizonSec * 1000.0) continue;
        lastIdx = i;
        const double r = dbPow(so[static_cast<size_t>(i)]) - dbPow(sc[static_cast<size_t>(i)]);
        if (std::abs(r) > kTvSettleBandDb) last = i;
        if (dt >= 500.0) { offAcc += r; ++offN; }
    }
    m.rOff = offN ? offAcc / offN : 0.0;
    if (last < 0) m.settle = 0.0;
    else if (last == lastIdx) m.settle = -1.0;
    else m.settle = tOf(last + 1) - D;

    // v6: r_off(T) (event-mean energies averaged over D + T +/- 10 ms, then the dB ratio), the gated points and the tau_fit curve.
    auto rOffAt = [&](int T) {
        double o = 0.0, c = 0.0;
        const bool a = tvIntervalMean(mo, kMin, D + T, kTvRoffHalfMs, sr, o);
        const bool b = tvIntervalMean(mc, kMin, D + T, kTvRoffHalfMs, sr, c);
        if (!a || !b) m.roffOk = false;
        return dbPow(o) - dbPow(c);
    };
    for (int T = 0; T <= kTvCurveMaxMs; T += kTvCurveStepMs) m.rOffCurve.push_back(rOffAt(T));
    m.rOff100 = rOffAt(100); m.rOff250 = rOffAt(250); m.rOff500 = rOffAt(500); m.rOff1000 = rOffAt(1000);
    // The first samples of the curve still contain the on-time resonance (Hann window +/- 10.7 ms, interval +/- 10 ms, 5 ms crossfade: r_off(0) is typically POSITIVE even for a deep suppressor),
    // so the fit and the "cut at the offset" test start at kTvTauStartMs.
    std::vector<double> cut;
    for (size_t i = 0; i < m.rOffCurve.size(); ++i)
        if (static_cast<int>(i) * kTvCurveStepMs >= kTvTauStartMs) cut.push_back(-m.rOffCurve[i]);
    if (cut.front() < kTvTauNaCutDb) m.tauFit = -1.0;
    else { bool lim = false; const double tau = tvFitTau(cut, lim); m.tauFit = lim ? -2.0 : tau; }
    return m;
}

// Gate thresholds for G8 / G9 (fixed by the specification; DO NOT tune per subject).
//   G8a  t50 <= kG8aT50Ms                         for D = 300 and D = 1000 ms at every f0 (count of 6); "never" fails
//   G8b  leak <= kG8bLeak300 (D = 300) / kG8bLeak1000 (D = 1000) at every f0 (count of 6)
//   G9a  |r_off(500 ms)| <= kG9aRoff500Db         at every (f0, D) (count of 9, D = 100 included)     (v6; replaces the v5 over_dB gate)
//   G9b  |r_off(1000 ms)| <= kG9bRoff1000Db       at every (f0, D) (count of 9)                       (v6; replaces the v5 settle_ms gate)
//   D = 100 ms: t50 and leak are informational. over_dB, settle_ms, r_off(0 / 100 / 250) and tau_fit are informational (not gates).
static constexpr double kG8aT50Ms     = 100.0;
static constexpr double kG8bLeak300   = 0.5;
static constexpr double kG8bLeak1000  = 0.3;
static constexpr double kG9aRoff500Db  = 1.0;
static constexpr double kG9bRoff1000Db = 0.5;

static bool g8Graded(int durMs) { return durMs == 300 || durMs == 1000; }
static bool g8aCell(const TvMetrics& m) { return m.t50 >= 0.0 && m.t50 <= kG8aT50Ms; }
static bool g8bCell(const TvMetrics& m, int durMs) { return m.leak <= (durMs == 300 ? kG8bLeak300 : kG8bLeak1000); }
static bool g9aCell(const TvMetrics& m) { return m.roffOk && std::abs(m.rOff500) <= kG9aRoff500Db; }
static bool g9bCell(const TvMetrics& m) { return m.roffOk && std::abs(m.rOff1000) <= kG9bRoff1000Db; }

static std::string tvMs(double v, int prec = 1) { return v < 0.0 ? "never" : num(v, prec); }
static std::string tvTau(double v) { return v == -1.0 ? "n/a" : v == -2.0 ? ">5000" : num(v, 1); }

// ============================================================================
// Gates (v3)
// ============================================================================
//
// Fixed acceptance criteria. DO NOT tune these to make a subject pass; they are the specification.
// Every subject registered with gated = true is evaluated at ITS OWN variant (the capability variants S1c..S5c, S5q)
// over the 12 scan frequencies at 48 kHz (the 44.1 kHz scan is reported informationally).
//   G1  in_window_residual_dB >= kG1ResFloorDb  and  <= kG1ResIdealFrac * ideal_dB   at EVERY f0
//   G2  outside_dev_dB <= kG2OutsideDevDb                                             at EVERY f0
//   G3  resonance in the RIGHT channel only (signal E): R at 2500 Hz: G1 + G2 on R. L (untouched channel, MUST equal the clean L) at EVERY one of
//       the 12 scan f0: in_window_residual_dB within +/- kG3LResAbsDb AND outside_dev_dB <= kG2OutsideDevDb. G3 = R gates AND L at 12/12.
//   G4  sensitive-variant jitter (signal C): std "all" <= kG4StdAllDb AND isolated-cell fraction "all" <= kG4IsoAll
//   G5  pre-echo with the mask engaged (D2): broadband E_out/E_in <= kG5BroadbandDb AND band E_out/E_in <= kG5BandDb
//   G6  latency: measured == reported at both sample rates, and identical across every block schedule
//   G1q/G2q  shape scan, Q in {4, 8, 16} at +12 dB, f0 2500 Hz, 48 kHz (same G1/G2 cell tests, ideal recomputed per case): count out of 3
//   G1l/G2l  shape scan, level in {+12, +18} dB at Q 8, f0 2500 Hz, 48 kHz:                                              count out of 2
//   G7  relative CPU: mean % RT / mean % RT of S3 (RS HQ Normal, default params) measured in the SAME run <= kG7CpuRatio at block 128 AND block 64
//   G8a/G8b/G9a/G9b  v5/v6 time-varying resonance (signal T1, thresholds kG8* / kG9* in the T1 section above): reaction speed (G8) and release, i.e. the cut is gone 500 / 1000 ms after the offset (G9)
//   Overall = G1, G2, G1q, G2q, G1l, G2l, G3, G4, G5, G6, G7, G8a, G8b, G9a, G9b all pass (G7 is "n/a" and left out of the verdict when the CPU run is skipped).
static constexpr double kG1ResFloorDb   = -1.5;
static constexpr double kG1ResIdealFrac = 0.30;
static constexpr double kG2OutsideDevDb = 0.5;
static constexpr double kG4StdAllDb     = 0.6;
static constexpr double kG4IsoAll       = 1.0e-3;
static constexpr double kG5BroadbandDb  = 1.0;
static constexpr double kG5BandDb       = 1.0;
static constexpr double kG3LResAbsDb    = 1.0;    // v4: L-channel in-window residual must lie within +/- this on signal E
static constexpr double kG7CpuRatio     = 1.05;   // v4: subject mean %RT / S3 mean %RT (same run), at block 128 and 64; 1.05 = the agreed wall-clock margin (a strict 1.0 failed the same core at 1.0003 and passed it at 0.9957 in one run)

struct EResidual { Residual r, l; bool valid = false; };          // signal E (resonance in R only), per channel

// v4 shape scan (f0 = 2500 Hz, 48 kHz, planted in both channels, same seed as signal A). Q-scan = cases with inQ, level-scan = cases with inLevel.
struct ShapeCase { const char* key; double q, gainDb; bool inQ, inLevel; };
static const std::vector<ShapeCase>& shapeCases()
{
    static const std::vector<ShapeCase> c = {
        { "Q4/+12",  4.0,  12.0, true,  false },
        { "Q8/+12",  8.0,  12.0, true,  true  },
        { "Q16/+12", 16.0, 12.0, true,  false },
        { "Q8/+18",  8.0,  18.0, false, true  },
    };
    return c;
}
struct LatencyGate { bool valid = false, matchAll = true, blockInvariant = true; std::string detail; };

struct BenchData
{
    std::vector<double> scanF0;
    std::map<std::string, std::map<int, double>> ideal;                // "48000" -> f0 -> ideal dB
    std::map<std::string, std::map<int, Residual>> residual;           // "S1c@48000" -> f0 -> residual
    std::map<std::string, EResidual> right;                            // subject id -> signal E residuals (48 kHz, 2500 Hz)
    std::map<std::string, std::map<int, EResidual>> eScan;             // subject id -> f0 -> signal E residuals (48 kHz, every scan f0)
    std::map<std::string, std::map<std::string, Residual>> shape;      // subject id -> shape-case key -> residual (48 kHz, f0 2500 Hz, both channels)
    std::map<std::string, std::pair<double, double>> cpuRatio;         // subject id -> (block 64, block 128) mean %RT / S3 mean %RT
    std::map<std::string, Jitter> jitter;                              // subject id -> signal C jitter
    std::map<std::string, PreEcho> d2;                                 // subject id -> signal D2 pre-echo
    std::map<std::string, LatencyGate> latency;                        // subject id -> G6 evidence
    std::map<std::string, std::map<std::pair<int, int>, TvMetrics>> tv;   // v5: subject id -> (f0 Hz, D ms) -> T1 metrics (48 kHz)
};

struct GateRow
{
    std::string id, label;
    int g1 = 0, g2 = 0, n = 0;                // passing f0 count at 48 kHz, out of n
    int g1_44 = 0, g2_44 = 0, n44 = 0;        // informational: the same at 44.1 kHz
    int g1q = 0, g2q = 0, nq = 0;             // v4 shape scan, Q cases
    int g1l = 0, g2l = 0, nl = 0;             // v4 shape scan, level cases
    bool g3 = false; double g3RRes = 0, g3RDev = 0, g3LRes = 0, g3LDev = 0; bool g3valid = false;
    bool g3R = false; int g3Lpass = 0, g3Ln = 0;   // G3 = R gates at 2500 AND the L gate at every scan f0
    bool g7 = false, g7valid = false; double g7r64 = 0, g7r128 = 0;
    bool g4 = false; double g4Std = 0, g4Iso = 0; bool g4valid = false; std::string g4Id;
    bool g5 = false; double g5Bb = 0, g5Band = 0; bool g5valid = false;
    bool g6 = false; std::string g6detail;
    int g8a = 0, n8a = 0, g8b = 0, n8b = 0;   // v5 reaction: cases passing out of 6 (f0 x D in {300, 1000})
    int g9a = 0, n9a = 0, g9b = 0, n9b = 0;   // v6 release:  cases passing out of 9 (f0 x D in {100, 300, 1000}); |r_off(500)| <= 1.0 dB / |r_off(1000)| <= 0.5 dB
    std::string tauSummary;                   // informational: tau_fit median over the cases with a fit, "(k fitted, a n/a, p >5000)"
    bool pass8a() const { return n8a > 0 && g8a == n8a; }
    bool pass8b() const { return n8b > 0 && g8b == n8b; }
    bool pass9a() const { return n9a > 0 && g9a == n9a; }
    bool pass9b() const { return n9b > 0 && g9b == n9b; }
    // Known limits (named waivers, see knownLimits()): number of G1 cells that FAILED and are waived for this subject, and the printed text of each.
    // pass1() / overall() stay the RAW verdicts (no waiver); the waived verdict is pass1w() / overallWaived() / verdict().
    int g1Waived = 0;
    std::vector<std::string> waivers;
    bool pass1w() const { return n > 0 && g1 + g1Waived == n; }
    bool pass1() const { return n > 0 && g1 == n; }
    bool pass2() const { return n > 0 && g2 == n; }
    bool pass1q() const { return nq > 0 && g1q == nq; }
    bool pass2q() const { return nq > 0 && g2q == nq; }
    bool pass1l() const { return nl > 0 && g1l == nl; }
    bool pass2l() const { return nl > 0 && g2l == nl; }
    // Characterisation subjects (Subject::notGraded): these gates are printed but do not enter the verdict. Empty for every graded subject.
    std::vector<std::string> notGraded;
    bool ungraded(const char* gate) const { return std::find(notGraded.begin(), notGraded.end(), std::string(gate)) != notGraded.end(); }
    bool g3ok() const { return ungraded("G3") || g3; }
    bool g9aok() const { return ungraded("G9a") || pass9a(); }
    bool overall() const { return pass1() && pass2() && pass1q() && pass2q() && pass1l() && pass2l() && g3ok() && g4 && g5 && g6 && (!g7valid || g7)
                                  && pass8a() && pass8b() && g9aok() && pass9b(); }
    // The same verdict with the named G1 waivers applied (every other gate exactly as in overall()).
    bool overallWaived() const { return pass1w() && pass2() && pass1q() && pass2q() && pass1l() && pass2l() && g3ok() && g4 && g5 && g6 && (!g7valid || g7)
                                        && pass8a() && pass8b() && g9aok() && pass9b(); }
    std::string verdict() const
    {
        std::string v;
        if (!overallWaived()) v = "FAIL";
        else if (g1Waived == 0) v = "PASS";
        else v = "PASS (" + std::to_string(g1Waived) + (g1Waived == 1 ? " waiver)" : " waivers)");
        if (!notGraded.empty())
        {
            std::string list;
            for (const auto& x : notGraded) list += (list.empty() ? "" : ", ") + x;
            v += " [link-100 characterisation: " + list + " not graded]";
        }
        return v;
    }
};

// ---------------------------------------------------------------------------------------------------
// Known limits: named, printed exceptions to a gate. They are NOT a redefinition of the gate: the raw count stays visible, the
// waiver applies only to the listed (gate, subject, frequency) cells, only when the cell actually fails, and the evaluator prints it.
//   G1 at f0 = 100 Hz (48 kHz scan) for the ResonanceCore capability subjects C1c, C1c-N, C1c-H.
//   Evidence (docs/RESONANCE_CORE_DESIGN.md "It 3", "Stage C"; engine/src/dsp/ResonanceCore.md): at f0 = 100 Hz a Q 8 bell is 12.5 Hz wide
//   (-3 dB), narrower than one analysis bin (46.9 Hz at N = 1024, 23.4 Hz at N = 2048); the cut is the bin-average excess, so the sub-bin
//   peak stays standing (+3.44 dB at N = 1024, +3.65 dB at N = 2048 vs a limit of 2.10 dB). N = 2048 does not fix it.
// ---------------------------------------------------------------------------------------------------
struct KnownLimit
{
    const char* gate;                   // "G1" is the only gate a waiver can name
    std::vector<std::string> subjects;
    int f0;                             // Hz, a scan frequency
    const char* reason;                 // printed verbatim
};

static const std::vector<KnownLimit>& knownLimits()
{
    static const std::vector<KnownLimit> kl = {
        // The RSC-* subjects (the same core through the effect) carry the waiver exactly as their C1c-* counterparts: the Normal and High tiers
        // (RSC-N / RSC-H and the open-curve variants RSC-N0 / RSC-H0). C1c-F is not named, so RSC-F / RSC-F0 are not either.
        { "G1", { "C1c", "C1c-N", "C1c-H", "RSC-N", "RSC-H", "RSC-N0", "RSC-H0" }, 100, "resonance narrower than one analysis bin (resolution ceiling); see design doc" },
    };
    return kl;
}

static bool g1Cell(const Residual& r, double idealDb)
{
    return r.inWindow >= kG1ResFloorDb && r.inWindow <= kG1ResIdealFrac * idealDb;
}
static bool g2Cell(const Residual& r) { return r.outsideDev <= kG2OutsideDevDb; }
// G3, left (untouched) channel of signal E: the output must equal the clean L, in the window and outside it.
static bool g3LCell(const Residual& r) { return std::abs(r.inWindow) <= kG3LResAbsDb && r.outsideDev <= kG2OutsideDevDb; }

static int countRates(const BenchData& d, const std::string& id, double sr, bool g1, int& total)
{
    int pass = 0; total = 0;
    const auto it = d.residual.find(id + "@" + num(sr, 0));
    if (it == d.residual.end()) return 0;
    for (double f0 : d.scanF0)
    {
        const auto jt = it->second.find(static_cast<int>(f0));
        if (jt == it->second.end()) continue;
        ++total;
        const double ideal = d.ideal.at(num(sr, 0)).at(static_cast<int>(f0));
        if (g1 ? g1Cell(jt->second, ideal) : g2Cell(jt->second)) ++pass;
    }
    return pass;
}

// Works for ANY registered subject: everything it needs comes from the Subject record and the BenchData maps.
static GateRow evaluateGates(const Subject& s, const BenchData& d)
{
    GateRow g; g.id = s.id; g.label = s.label; g.notGraded = s.notGraded;
    int t = 0;
    g.g1 = countRates(d, s.id, 48000.0, true, t);  g.n = t;
    g.g2 = countRates(d, s.id, 48000.0, false, t);
    g.g1_44 = countRates(d, s.id, 44100.0, true, t); g.n44 = t;
    g.g2_44 = countRates(d, s.id, 44100.0, false, t);

    // Known limits (named waivers): applied only to the listed (gate, subject, f0) cell, and only when that cell really fails the unchanged G1 test.
    for (const auto& kl : knownLimits())
    {
        if (std::string(kl.gate) != "G1" || std::find(kl.subjects.begin(), kl.subjects.end(), s.id) == kl.subjects.end()) continue;
        const auto rs = d.residual.find(s.id + "@48000");
        if (rs == d.residual.end()) continue;
        const auto cell = rs->second.find(kl.f0);
        const auto id = d.ideal.find("48000");
        if (cell == rs->second.end() || id == d.ideal.end() || id->second.find(kl.f0) == id->second.end()) continue;
        const double ideal = id->second.at(kl.f0);
        if (g1Cell(cell->second, ideal)) continue;   // the cell passes: nothing to waive
        ++g.g1Waived;
        g.waivers.push_back("G1 at f0 = " + inum(kl.f0) + " Hz WAIVED for " + s.id + ": " + kl.reason + " [raw residual " + num(cell->second.inWindow, 2)
                            + " dB vs limit " + num(kG1ResIdealFrac * ideal, 2) + " dB]");
    }

    // G3
    const auto e = d.right.find(s.id);
    if (e != d.right.end() && e->second.valid)
    {
        g.g3valid = true;
        g.g3RRes = e->second.r.inWindow; g.g3RDev = e->second.r.outsideDev;
        g.g3LRes = e->second.l.inWindow; g.g3LDev = e->second.l.outsideDev;
        const double ideal = d.ideal.at("48000").at(2500);
        g.g3R = g1Cell(e->second.r, ideal) && g2Cell(e->second.r);
        const auto es = d.eScan.find(s.id);
        if (es != d.eScan.end())
            for (double f0 : d.scanF0)
            {
                const auto it = es->second.find(static_cast<int>(f0));
                if (it == es->second.end()) continue;
                ++g.g3Ln;
                if (g3LCell(it->second.l)) ++g.g3Lpass;
            }
        g.g3 = g.g3R && g.g3Ln > 0 && g.g3Lpass == g.g3Ln;
    }

    // v4 shape scans
    {
        const auto sh = d.shape.find(s.id);
        if (sh != d.shape.end())
            for (const auto& c : shapeCases())
            {
                const auto it = sh->second.find(c.key);
                if (it == sh->second.end()) continue;
                const double ideal = idealBoostDb(48000.0, 2500.0, c.q, c.gainDb);
                const bool p1 = g1Cell(it->second, ideal), p2 = g2Cell(it->second);
                if (c.inQ)     { ++g.nq; if (p1) ++g.g1q; if (p2) ++g.g2q; }
                if (c.inLevel) { ++g.nl; if (p1) ++g.g1l; if (p2) ++g.g2l; }
            }
    }

    // v5 time-varying (T1): G8a / G8b on D in {300, 1000} (6 cases), G9a / G9b on every case (9)
    {
        const auto tv = d.tv.find(s.id);
        if (tv != d.tv.end())
            for (const auto& kv : tv->second)
            {
                const int durMs = kv.first.second;
                const TvMetrics& m = kv.second;
                if (g8Graded(durMs))
                {
                    ++g.n8a; if (g8aCell(m)) ++g.g8a;
                    ++g.n8b; if (g8bCell(m, durMs)) ++g.g8b;
                }
                ++g.n9a; if (g9aCell(m)) ++g.g9a;
                ++g.n9b; if (g9bCell(m)) ++g.g9b;
            }
        if (tv != d.tv.end())
        {
            std::vector<double> taus; int na = 0, plateau = 0;
            for (const auto& kv : tv->second)
            {
                const double tf = kv.second.tauFit;
                if (tf == -1.0) ++na; else if (tf == -2.0) ++plateau; else taus.push_back(tf);
            }
            std::sort(taus.begin(), taus.end());
            const std::string med = taus.empty() ? "-" : num(taus[taus.size() / 2], 1);
            g.tauSummary = med + " ms (" + inum(static_cast<int>(taus.size())) + " fitted, " + inum(na) + " n/a, " + inum(plateau) + " >5000)";
        }
    }

    // G7 (relative CPU)
    {
        const auto c = d.cpuRatio.find(s.id);
        if (c != d.cpuRatio.end())
        {
            g.g7valid = true; g.g7r64 = c->second.first; g.g7r128 = c->second.second;
            g.g7 = g.g7r64 <= kG7CpuRatio && g.g7r128 <= kG7CpuRatio;
        }
    }

    // G4: jitter of the subject's registered sensitive variant (its own run when none is named)
    g.g4Id = s.jitterId.empty() ? s.id : s.jitterId;
    const auto j = d.jitter.find(g.g4Id);
    if (j != d.jitter.end())
    {
        g.g4valid = true; g.g4Std = j->second.stdAll; g.g4Iso = j->second.isoAll;
        g.g4 = g.g4Std <= kG4StdAllDb && g.g4Iso <= kG4IsoAll;
    }

    // G5: D2 (mask engaged), the specified E_out vs E_in columns
    const auto p = d.d2.find(s.id);
    if (p != d.d2.end())
    {
        g.g5valid = true; g.g5Bb = p->second.outVsIn; g.g5Band = p->second.bandOutVsIn;
        g.g5 = g.g5Bb <= kG5BroadbandDb && g.g5Band <= kG5BandDb;
    }

    // G6
    const auto l = d.latency.find(s.id);
    if (l != d.latency.end() && l->second.valid)
    {
        g.g6 = l->second.matchAll && l->second.blockInvariant;
        g.g6detail = l->second.detail;
    }
    else g.g6detail = "n/a";
    return g;
}

static std::string pf(bool b) { return b ? "PASS" : "FAIL"; }
static std::string cnt(int p, int n) { return inum(p) + "/" + inum(n); }

// ============================================================================
// CPU run (shared by the full run and --cpu-only)
// ============================================================================

struct CpuRow { std::string id, label; int block = 0; CpuResult r; double budgetNs = 0; };

static std::vector<CpuRow> runCpuRows(const std::vector<Subject>& subs, const std::vector<int>& blocks, double sr, const Stereo& sig)
{
    std::vector<CpuRow> rows;
    for (int block : blocks)
        for (const auto& s : subs)
        {
            CpuRow row; row.id = s.id; row.label = s.label; row.block = block;
            row.r = cpuBench(s, sig, sr, block);
            row.budgetNs = block / sr * 1.0e9;
            rows.push_back(row);
            logf("      %s block %d: mean %.0f ns (%.3f %% RT)  median %.0f  p95 %.0f  p99 %.0f  max %.0f", s.id.c_str(), block,
                 row.r.meanNs, 100.0 * row.r.meanNs / row.budgetNs, row.r.medianNs, row.r.p95Ns, row.r.p99Ns, row.r.maxNs);
        }
    return rows;
}

static void fillCpuTable(Table& t, const std::vector<CpuRow>& rows)
{
    for (const auto& c : rows)
    {
        const auto& r = c.r;
        t.add({ c.id, c.label, inum(c.block), num(r.medianNs, 0), num(r.p95Ns, 0), num(r.p99Ns, 0), num(r.maxNs, 0), num(r.meanNs, 0),
                num(100.0 * r.medianNs / c.budgetNs, 3), num(100.0 * r.p95Ns / c.budgetNs, 3), num(100.0 * r.meanNs / c.budgetNs, 3), num(100.0 * r.maxNs / c.budgetNs, 3) });
    }
}

// ----------------------------------------------------------------------------
// G7: relative CPU. Mean %RT of a subject divided by the mean %RT of S3 (RS HQ Normal, default parameters) measured
// in the SAME run at the SAME block size (the budget is identical, so the ratio of %RT equals the ratio of mean ns).
// ----------------------------------------------------------------------------

static const char* kG7RefId = "S3";

static double cpuMeanNs(const std::vector<CpuRow>& rows, const std::string& id, int block)
{
    for (const auto& r : rows) if (r.id == id && r.block == block) return r.r.meanNs;
    return -1.0;
}

// id -> (ratio @64, ratio @128) for every subject measured at both blocks. Empty if S3 was not measured.
static std::map<std::string, std::pair<double, double>> cpuRatios(const std::vector<CpuRow>& rows)
{
    std::map<std::string, std::pair<double, double>> out;
    const double ref64 = cpuMeanNs(rows, kG7RefId, 64), ref128 = cpuMeanNs(rows, kG7RefId, 128);
    if (ref64 <= 0.0 || ref128 <= 0.0) return out;
    for (const auto& r : rows)
    {
        const double a = cpuMeanNs(rows, r.id, 64), b = cpuMeanNs(rows, r.id, 128);
        if (a < 0.0 || b < 0.0) continue;
        out[r.id] = { a / ref64, b / ref128 };
    }
    return out;
}

static Table cpuRatioTable(const std::vector<CpuRow>& rows, const std::map<std::string, std::pair<double, double>>& ratios)
{
    Table t;
    t.title = "9c. G7 relative CPU (mean % RT / S3 mean % RT, same run; ratios to 4 decimals, G7 compares the unrounded values with <= 1.05)";
    t.note = "Ratio = the subject's mean processBlock time divided by S3's (RS HQ Normal, default parameters) at the same block size, measured in this run. "
             "G7 passes when the ratio is <= 1.05 (kG7CpuRatio) at BOTH block 128 and block 64. Informational for the existing subjects (it grades future subjects against the current "
             "HQ Normal cost); a ratio reflects one noisy wall-clock measurement per subject, so treat 0.9-1.1 as 'about equal'.";
    t.header = { "subject", "label", "mean % RT @64", "ratio @64", "mean % RT @128", "ratio @128", "G7" };
    std::vector<std::string> seen;
    for (const auto& r : rows)
    {
        if (std::find(seen.begin(), seen.end(), r.id) != seen.end()) continue;
        seen.push_back(r.id);
        const auto it = ratios.find(r.id);
        if (it == ratios.end()) continue;
        const double m64 = 100.0 * cpuMeanNs(rows, r.id, 64) / (64.0 / 48000.0 * 1.0e9);
        const double m128 = 100.0 * cpuMeanNs(rows, r.id, 128) / (128.0 / 48000.0 * 1.0e9);
        t.add({ r.id, r.label, num(m64, 3), num(it->second.first, 4), num(m128, 3), num(it->second.second, 4),
                (it->second.first <= kG7CpuRatio && it->second.second <= kG7CpuRatio) ? "PASS" : "FAIL" });
    }
    return t;
}

// Mean cost as % of real time for ONE instance and the x8-instances projection (mean * 8), at the 128-sample block.
static Table cpuProjectionTable(const std::vector<CpuRow>& rows, const std::string& cpuModel)
{
    Table t;
    t.title = "9b. CPU projection @ 128-sample block (48 kHz stereo)";
    t.note = "CPU: " + cpuModel + ". 'mean % RT x1' = mean processBlock time / (128 / 48000 s). 'x8 instances' = mean * 8 (linear projection, "
             "ignores cache / memory-bandwidth contention between instances). p99 is the realistic worst-case block (see table 9).";
    t.header = { "subject", "label", "mean % RT x1", "mean % RT x8 instances", "p99 % RT x1", "p99 % RT x8 instances" };
    for (const auto& c : rows)
    {
        if (c.block != 128) continue;
        const double m = 100.0 * c.r.meanNs / c.budgetNs, p = 100.0 * c.r.p99Ns / c.budgetNs;
        t.add({ c.id, c.label, num(m, 3), num(m * 8.0, 3), num(p, 3), num(p * 8.0, 3) });
    }
    return t;
}

static void logCpuProjection(const std::vector<CpuRow>& rows, const std::string& cpuModel)
{
    logf("CPU model: %s", cpuModel.c_str());
    for (const auto& c : rows)
    {
        if (c.block != 128) continue;
        const double m = 100.0 * c.r.meanNs / c.budgetNs;
        logf("CPU @128 samples / 48 kHz  %-4s mean %8.3f %% RT (1 instance)  ->  %8.3f %% RT (x8 instances)", c.id.c_str(), m, m * 8.0);
    }
}

// ============================================================================
// Worst-case CPU study (--cpu-worst). Informational: nothing here is a gate.
// ============================================================================
//
// Signal: pink noise (-20 dBFS, both channels) with the standard +12 dB / Q 8 bell at 2500 Hz switched ON / OFF every 2 s (5 ms crossfades; off first), 60 s
// at 48 kHz = 44 k blocks at 64 and 22 k at 128 (>= 20 000 either way), after a 1 s untimed warm-up of every repetition, kCpuWorstReps repetitions pooled (a fresh instance each).
// Per block: wall time of processBlock() via steady_clock. For the ResonanceCore (C1c) every block is also CLASSIFIED (untimed, from the core's read-only introspection):
//   no frame            the block did not complete a hop (no FFT / detector work)
//   frame               a hop completed, no forced baseline refresh
//   frame + slow full   the slow estimate's baselines were ALL recomputed this frame (the mean-level-jump guard fired)
//   frame + fast full   the same for the fast estimate;  frame + both
// A baseline counts as "recomputed" when its value changed since the previous frame: a regular frame changes 1/4 (slow) and 1/2 (fast) of the bands, a forced refresh all of them
// (thresholds: > 48 of 96 slow bands, > 72 of 96 fast bands, either channel).

static constexpr int kCpuWorstReps = 5;
static constexpr double kCpuWorstSeconds = 60.0;

// kind 0: the +12 dB / Q 8 bell at 2500 Hz toggles ON / OFF every 2 s (the requested signal). kind 1: the whole signal toggles between 0 dB and -12 dB every 2 s (a
// broadband level step, which moves the mean band level by far more than kBaselineJumpDb and so forces the full baseline refresh at every toggle: the worst case of that path).
static Stereo makeCpuWorstSignal(double sr, double seconds, int kind)
{
    const int n = static_cast<int>(seconds * sr);
    const Stereo clean = makePinkStereo(n, -20.0, 3);
    Stereo bell = kind == 1 ? clean : makeResonant(clean, sr, 2500.0, true, true);
    if (kind == 1)
        for (int c = 0; c < 2; ++c)
            for (auto& v : bell.ch[c]) v *= 0.25118864f;   // -12 dB
    Stereo s = clean;
    const int period = static_cast<int>(std::llround(2.0 * sr)), fade = std::max(1, static_cast<int>(std::llround(0.005 * sr)));
    for (int i = 0; i < n; ++i)
    {
        const int seg = i / period, p = i % period;
        const double ramp = std::min(1.0, static_cast<double>(p) / fade);
        const double g = seg == 0 ? 0.0 : ((seg & 1) ? ramp : 1.0 - ramp);
        if (g <= 0.0) continue;
        for (int c = 0; c < 2; ++c)
        {
            const auto k = static_cast<size_t>(i);
            s.ch[c][k] = static_cast<float>(static_cast<double>(clean.ch[c][k]) + g * (static_cast<double>(bell.ch[c][k]) - static_cast<double>(clean.ch[c][k])));
        }
    }
    return s;
}

struct WorstRun
{
    std::vector<double> ns;
    std::vector<unsigned char> cat;   // 0 no frame, 1 frame, 2 frame + slow full, 3 frame + fast full, 4 both; 255 = not classified
    std::vector<int> rep, idx;        // repetition, block index within the repetition
    int fullSlow = 0, fullFast = 0, frames = 0;   // timed frames only
};

static const char* worstCatName(int c)
{
    switch (c) { case 0: return "no frame"; case 1: return "frame"; case 2: return "frame + slow full refresh"; case 3: return "frame + fast full refresh"; case 4: return "frame + both full refresh"; default: return "(not classified)"; }
}

static WorstRun cpuWorstRun(const Subject& s, const Stereo& sig, double sr, int block, bool classify)
{
    WorstRun r;
    const int warm = static_cast<int>(sr);
    juce::AudioBuffer<float> work(2, block);
    juce::MidiBuffer midi;
    for (int rep = 0; rep < kCpuWorstReps; ++rep)
    {
        Fx fx = makeFx(s, sr, 2500.0, false, block);
        auto& proc = fx.proc();
        const ResonanceCoreProcessor* rcp = classify ? dynamic_cast<const ResonanceCoreProcessor*>(&proc) : nullptr;
        const int B = rcp ? rcp->core().numBands() : 0;
        std::vector<float> prevS[2], prevF[2];
        for (int c = 0; c < 2; ++c) { prevS[c].assign(static_cast<size_t>(B), -1.0e30f); prevF[c].assign(static_cast<size_t>(B), -1.0e30f); }
        long long lastFrames = 0;
        int bi = 0;
        for (int pos = 0; pos + block <= sig.size(); pos += block, ++bi)
        {
            for (int c = 0; c < 2; ++c)
                std::memcpy(work.getWritePointer(c), sig.ch[c].data() + pos, sizeof(float) * static_cast<size_t>(block));
            const auto t0 = std::chrono::steady_clock::now();
            proc.processBlock(work, midi);
            const auto t1 = std::chrono::steady_clock::now();
            unsigned char cat = 255;
            if (rcp)
            {
                cat = 0;
                const long long fr = rcp->core().framesProcessed();
                if (fr != lastFrames)
                {
                    lastFrames = fr;
                    int chS = 0, chF = 0;
                    for (int c = 0; c < 2; ++c)
                    {
                        const float* bs = rcp->core().bandBaselineDb(c);
                        const float* bf = rcp->core().bandFastBaselineDb(c);
                        int ns = 0, nf = 0;
                        for (int b = 0; b < B; ++b)
                        {
                            if (bs[b] != prevS[c][static_cast<size_t>(b)]) ++ns;
                            if (bf[b] != prevF[c][static_cast<size_t>(b)]) ++nf;
                            prevS[c][static_cast<size_t>(b)] = bs[b]; prevF[c][static_cast<size_t>(b)] = bf[b];
                        }
                        chS = std::max(chS, ns); chF = std::max(chF, nf);
                    }
                    const bool fs = chS > (B / 2), ff = chF > (3 * B / 4);
                    cat = static_cast<unsigned char>(fs && ff ? 4 : (fs ? 2 : (ff ? 3 : 1)));
                }
            }
            if (pos >= warm)
            {
                r.ns.push_back(static_cast<double>(std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count()));
                r.cat.push_back(cat); r.rep.push_back(rep); r.idx.push_back(bi);
                if (cat == 2 || cat == 4) ++r.fullSlow;
                if (cat == 3 || cat == 4) ++r.fullFast;
                if (cat >= 1 && cat <= 4) ++r.frames;
            }
        }
    }
    return r;
}

static int runCpuWorst(const std::string& cfg, const std::string& cpu, bool isRelease, const std::string& hash, const std::string& stamp)
{
    const double sr = 48000.0;
    std::vector<Subject> subs;
    for (const char* id : { "C1c", "S3c" })
        for (const auto& s : capabilitySubjects()) if (s.id == id) subs.push_back(s);
    if (subs.empty()) { logf("--cpu-worst: C1c / S3c are not registered (check --subjects)"); return 2; }
    const fs::path dir = fs::path(g_opt.outBase) / (stamp + "_" + hash + "_cpuworst");
    std::error_code ec; fs::create_directories(dir, ec);
    logf("--cpu-worst: %s, %d reps x %.0f s of pink noise with the +12 dB / Q8 bell at 2500 Hz toggling every 2 s; blocks 64 / 128; first 1 s of each rep untimed", cfg.c_str(), kCpuWorstReps, kCpuWorstSeconds);
    if (!isRelease) warnf("*** NOT A RELEASE BUILD - CPU numbers are meaningless ***");
    const char* kindName[2] = { "bell toggle", "level step" };

    Table t1; t1.title = "CPU-W1. Worst-case per-block processing time (48 kHz stereo, pink noise + resonance toggling every 2 s)";
    t1.note = "Build: " + cfg + ". CPU: " + cpu + ". " + inum(kCpuWorstReps) + " repetitions (fresh instance each) pooled, first 1 s of each untimed; per-block wall time of processBlock() via steady_clock. "
              "budget = block / 48000 s (64 -> 1333.3 us, 128 -> 2666.7 us). 'max rep max' / 'min rep max' = the largest block time of the worst / best repetition (the spread is OS scheduling noise, not DSP). "
              "Single thread at normal priority, no isolation from other processes.";
    t1.header = { "signal", "subject", "block", "blocks", "mean us", "p95 us", "p99 us", "p99.9 us", "max us", "mean % budget", "max % budget", "blocks > 25 % budget", "blocks > 50 % budget", "min rep max us", "max rep max us" };
    Table t2; t2.title = "CPU-W2. Where the time goes in C1c (blocks classified from the core's introspection)";
    t2.note = "no frame = the block completed no hop (only FIFO copies); frame = a hop completed, regular staggered baseline refresh; 'full refresh' = every band's flank baseline was recomputed in that frame "
              "(the mean-band-level jump guard, kBaselineJumpDb = 1.5 dB). A baseline counts as recomputed when its value changed since the previous frame (regular frame: 1/4 of the slow, 1/2 of the fast bands; forced: all).";
    t2.header = { "signal", "block", "category", "blocks", "mean us", "p99 us", "max us", "max % budget" };
    Table t3; t3.title = "CPU-W3. The 8 slowest blocks of each run";
    t3.header = { "signal", "subject", "block", "rank", "us", "% budget", "category", "rep", "block index", "stream time s", "hop phase (samples into the hop)" };

    bool flag = false;
    for (int kind : { 0, 1 })
    {
    const Stereo sig = makeCpuWorstSignal(sr, kCpuWorstSeconds, kind);
    logf("  signal: %s", kindName[kind]);
    for (int block : { 64, 128 })
        for (const auto& s : subs)
        {
            const bool isCore = s.id == "C1c";
            const WorstRun r = cpuWorstRun(s, sig, sr, block, isCore);
            const double budgetNs = block / sr * 1.0e9;
            std::vector<double> v = r.ns;
            const double mean = std::accumulate(v.begin(), v.end(), 0.0) / static_cast<double>(std::max<size_t>(v.size(), 1));
            const double mx = *std::max_element(v.begin(), v.end());
            std::vector<double> a = v, b = v, c = v;
            const double p95 = percentile(a, 0.95), p99 = percentile(b, 0.99), p999 = percentile(c, 0.999);
            long long o25 = 0, o50 = 0;
            for (double x : v) { if (x > 0.25 * budgetNs) ++o25; if (x > 0.50 * budgetNs) ++o50; }
            std::vector<double> repMax(kCpuWorstReps, 0.0);
            for (size_t i = 0; i < r.ns.size(); ++i) repMax[static_cast<size_t>(r.rep[i])] = std::max(repMax[static_cast<size_t>(r.rep[i])], r.ns[i]);
            const double rMin = *std::min_element(repMax.begin(), repMax.end()), rMax = *std::max_element(repMax.begin(), repMax.end());
            t1.add({ kindName[kind], s.id, inum(block), inum(static_cast<long long>(v.size())), num(mean / 1000.0, 2), num(p95 / 1000.0, 2), num(p99 / 1000.0, 2), num(p999 / 1000.0, 2), num(mx / 1000.0, 2),
                     num(100.0 * mean / budgetNs, 3), num(100.0 * mx / budgetNs, 2), inum(o25), inum(o50), num(rMin / 1000.0, 2), num(rMax / 1000.0, 2) });
            logf("      %-4s block %3d: %lld blocks  mean %.2f us  p95 %.2f  p99 %.2f  p99.9 %.2f  max %.2f us = %.2f %% of the %.1f us budget  (>25 %%: %lld, >50 %%: %lld; per-rep max %.1f .. %.1f us)",
                 s.id.c_str(), block, static_cast<long long>(v.size()), mean / 1000.0, p95 / 1000.0, p99 / 1000.0, p999 / 1000.0, mx / 1000.0, 100.0 * mx / budgetNs, budgetNs / 1000.0, o25, o50, rMin / 1000.0, rMax / 1000.0);
            if (block == 64 && mx > 0.5 * budgetNs) { flag = true; logf("      FLAG: %s max %.2f us exceeds 50 %% of the real-time budget at 64 samples", s.id.c_str(), mx / 1000.0); }

            // slowest 8
            std::vector<size_t> order(r.ns.size());
            std::iota(order.begin(), order.end(), size_t(0));
            std::partial_sort(order.begin(), order.begin() + std::min<size_t>(8, order.size()), order.end(), [&](size_t x, size_t y) { return r.ns[x] > r.ns[y]; });
            for (size_t k = 0; k < std::min<size_t>(8, order.size()); ++k)
            {
                const size_t i = order[k];
                const long long sample = static_cast<long long>(r.idx[i]) * block;
                t3.add({ kindName[kind], s.id, inum(block), inum(static_cast<long long>(k + 1)), num(r.ns[i] / 1000.0, 2), num(100.0 * r.ns[i] / budgetNs, 2), worstCatName(r.cat[i]), inum(r.rep[i]),
                         inum(r.idx[i]), num(static_cast<double>(sample) / sr, 3), inum(sample % 256) });
                if (k < 4) logf("        slowest #%zu: %.2f us (%.2f %% budget)  %s  rep %d block %d (t = %.3f s, hop phase %lld)", k + 1, r.ns[i] / 1000.0, 100.0 * r.ns[i] / budgetNs,
                                worstCatName(r.cat[i]), r.rep[i], r.idx[i], static_cast<double>(sample) / sr, sample % 256);
            }
            if (isCore)
            {
                logf("      C1c block %d: %d timed frames, forced slow-baseline refreshes %d, forced fast-baseline refreshes %d", block, r.frames, r.fullSlow, r.fullFast);
                for (int cat = 0; cat <= 4; ++cat)
                {
                    std::vector<double> x;
                    for (size_t i = 0; i < r.ns.size(); ++i) if (r.cat[i] == cat) x.push_back(r.ns[i]);
                    if (x.empty()) continue;
                    const double m = std::accumulate(x.begin(), x.end(), 0.0) / static_cast<double>(x.size());
                    const double xm = *std::max_element(x.begin(), x.end());
                    std::vector<double> y = x;
                    const double q99 = percentile(y, 0.99);
                    t2.add({ kindName[kind], inum(block), worstCatName(cat), inum(static_cast<long long>(x.size())), num(m / 1000.0, 2), num(q99 / 1000.0, 2), num(xm / 1000.0, 2), num(100.0 * xm / budgetNs, 2) });
                    logf("        %-26s %8zu blocks  mean %8.2f us  p99 %8.2f us  max %8.2f us", worstCatName(cat), x.size(), m / 1000.0, q99 / 1000.0, xm / 1000.0);
                }
            }
        }
    }
    if (!flag) logf("no run exceeds 50 %% of the real-time budget at 64 samples");
    std::ofstream(dir / "cpu_worst.csv", std::ios::binary) << t1.csv();
    std::ofstream(dir / "cpu_worst_causes.csv", std::ios::binary) << t2.csv();
    std::ofstream(dir / "cpu_worst_slowest.csv", std::ios::binary) << t3.csv();
    std::ofstream(dir / "summary.md", std::ios::binary) << "# RS bench - worst-case CPU\n\n- Git: `" << hash << "`\n- Build: **" << cfg << "**\n- CPU: " << cpu << "\n\n" << t1.markdown() << t2.markdown() << t3.markdown();
    logf("wrote cpu_worst*.csv and summary.md to %s", dir.string().c_str());
    return g_nonFinite == 0 ? 0 : 1;
}

// ============================================================================
// Core applied cut vs the bench's r_off(T) (--d1-reconcile). Informational.
// ============================================================================
//
// Same signals (the 9 T1 cases), same subject (C1c settings: depth 1, Hard, attack 15 ms, release 200 ms, Normal tier). Two views of the SAME run:
//   bench  : -r_off(T) = the in-window (f0 +/- 1/6 oct, STFT 1024 Hann) energy of the latency-aligned OUTPUT relative to the clean reference, +/- 10 ms interval, event mean (tvAnalyse).
//   core   : the core's applied band reduction read through bandReductionDb() after every hop (test_resonance_core D1 reads the same hook):
//            "max band"  = max over the band-grid bands within f0 +/- 1/6 oct of channel 0 (the D1 definition), event mean of the dB values;
//            "window"    = the energy-domain mean over the bench's STFT bins in f0 +/- 1/6 oct of the gain the core applies (both channels), event mean of the power gains.
//   Time    : a frame completed by the hop that brought the input to sample d is "decided" at d (D1's time stamp); its output window is centred N / 2 earlier on the aligned
//            output axis the bench measures. So the bench's T corresponds to the decision time T + N / 2 (10.67 ms at N = 1024); both are printed.
// Between two frames the value is interpolated linearly (events are not hop-aligned).
static int runD1Reconcile(const std::string& hash, const std::string& stamp)
{
    namespace rc = xleth::dsp::resonance;
    const double sr = 48000.0;
    std::vector<Subject> found;   // by value: capabilitySubjects() returns a temporary
    for (const auto& s : capabilitySubjects()) if (s.id == "C1c") found.push_back(s);
    if (found.empty()) { logf("--d1-reconcile: C1c is not registered (check --subjects)"); return 2; }
    const Subject* c1c = &found.front();
    const fs::path dir = fs::path(g_opt.outBase) / (stamp + "_" + hash + "_d1reconcile");
    std::error_code ec; fs::create_directories(dir, ec);
    const std::array<int, 4> Ts = { 100, 250, 500, 1000 };

    Table t1; t1.title = "D1R-1. Applied cut vs bench -r_off(T) on the 9 T1 signals (C1c, 48 kHz), dB";
    t1.note = "bench = -r_off(T) from the latency-aligned output (the gated G9 measure). core max band @T = D1's measure (max over the band-grid bands within f0 +/- 1/6 oct, channel 0, event mean) at the decision time T after the offset "
              "(D1's time stamp). core max band @T+N/2 = the same read N/2 = 10.67 ms later, i.e. the frame whose output window is centred on the aligned time T. core window @T+N/2 = the energy-domain mean over the bench's STFT bins "
              "in f0 +/- 1/6 oct of the gain the core applies (both channels, event mean of the power gain), the like-for-like counterpart of the bench measure.";
    t1.header = { "f0 Hz", "D ms" };
    for (int T : Ts) { t1.header.push_back("bench " + inum(T)); t1.header.push_back("max band @T " + inum(T)); t1.header.push_back("max band @T+N/2 " + inum(T)); t1.header.push_back("window @T+N/2 " + inum(T)); }
    Table t2; t2.title = "D1R-2. Time for the cut to fall to <= 1 dB after the offset (ms), C1c, 48 kHz";
    t2.note = "core (D1 definition) = first decision time T after the offset with the event-mean max-band cut <= 1 dB (1 ms grid). bench = first T >= 50 ms with -r_off(T) <= 1 dB on the aligned output "
              "(T < 50 ms still contains on-time resonance in the STFT window; 1 ms grid, T <= 1000 ms: '>1000' = not reached). cut at the offset = event-mean max-band cut at the offset (decision time).";
    t2.header = { "f0 Hz", "D ms", "cut at the offset (max band) dB", "core <= 1 dB (D1 def) ms", "core window <= 1 dB (aligned) ms", "bench <= 1 dB ms" };

    for (double f0 : kTvF0)
        for (int durMs : kTvDurMs)
        {
            TvCase tc = makeTvCase(f0, durMs, sr);
            int kMin = 0, kMax = 0; tvFrameRange(durMs, sr, kMin, kMax);
            // ---- bench side (exactly the T1 path of the main run)
            Planted pl; pl.f0 = f0; pl.left = true; pl.right = true; pl.cleanRef = &tc.clean;
            for (const auto& ev : tc.events) pl.events.emplace_back(ev.onset, ev.offset);
            Fx fx = makeFx(*c1c, sr, f0, false, kPrepareBlock, &pl);
            const Stereo out = renderStd(fx, tc.sig);
            const auto a = align(tc.sig, out, measureLatency(*c1c, sr).measured, sr);
            const auto eOut = tvWindowEnergy(a.out, tc.events, kMin, kMax, sr, f0);
            const auto eClean = tvWindowEnergy(tc.clean, tc.events, kMin, kMax, sr, f0);
            const auto ePass = tvWindowEnergy(tc.sig, tc.events, kMin, kMax, sr, f0);
            const TvMetrics m = tvAnalyse(eOut, eClean, ePass, durMs, kMin, sr);
            const auto mo = tvEventMean(eOut), mc = tvEventMean(eClean);
            auto benchCut = [&](double T) { double o = 0, c = 0; tvIntervalMean(mo, kMin, durMs + T, kTvRoffHalfMs, sr, o); tvIntervalMean(mc, kMin, durMs + T, kTvRoffHalfMs, sr, c); return -(dbPow(o) - dbPow(c)); };

            // ---- core side: the same signal through a bare Core in hop-sized blocks (one frame per block)
            rc::Params prm; prm.depth = 1.0f; prm.hardKnee = true;
            rc::Core core;
            if (g_opt.coreTauMs > 0.0f) core.setDetectorTimeConstantMs(g_opt.coreTauMs);
            if (g_opt.coreFastMs >= 0.0f) core.setFastTimeConstantMs(g_opt.coreFastMs);
            core.prepare(sr, 1024, 2);
            const int H = core.hopSize(), N = core.fftSize(), B = core.numBands();
            const int frames = tc.sig.size() / H;
            std::vector<int> bandsIn;
            for (int b = 0; b < B; ++b) if (std::abs(std::log2(static_cast<double>(core.bandHz(b)) / f0)) <= 1.0 / 6.0) bandsIn.push_back(b);
            // bench STFT bins in the window and their position on the core's ERB band axis (the core's own bin -> band interpolation)
            auto erb = [](double f) { return 21.4 * std::log10(1.0 + 0.00437 * f); };
            const double erbLo = erb(static_cast<double>(core.bandHz(0))), erbStep = (erb(static_cast<double>(core.bandHz(B - 1))) - erbLo) / (B - 1);
            struct BinPos { int j; double t; };
            std::vector<BinPos> bins;
            {
                const double s6 = std::pow(2.0, 1.0 / 6.0), binHz = sr / kTvFftN;
                for (int k = 1; k < kTvFftN / 2; ++k)
                {
                    const double f = k * binHz;
                    if (f < f0 / s6 || f > f0 * s6) continue;
                    const double x = (erb(f) - erbLo) / erbStep;
                    BinPos bp;
                    if (x <= 0.0) { bp.j = 0; bp.t = 0.0; } else if (x >= B - 1) { bp.j = B - 2; bp.t = 1.0; } else { bp.j = static_cast<int>(std::floor(x)); bp.t = x - bp.j; }
                    bins.push_back(bp);
                }
            }
            std::vector<double> maxBand(static_cast<size_t>(frames), 0.0), pw(static_cast<size_t>(frames), 1.0);
            std::vector<float> l(static_cast<size_t>(H)), r(static_cast<size_t>(H));
            float* ptrs[2] = { l.data(), r.data() };
            for (int f = 0; f < frames; ++f)
            {
                std::memcpy(l.data(), tc.sig.ch[0].data() + static_cast<size_t>(f) * H, sizeof(float) * static_cast<size_t>(H));
                std::memcpy(r.data(), tc.sig.ch[1].data() + static_cast<size_t>(f) * H, sizeof(float) * static_cast<size_t>(H));
                core.process(ptrs, 2, H, prm);
                double mx = 0.0;
                for (int b : bandsIn) mx = std::max(mx, static_cast<double>(core.bandReductionDb(0)[b]));
                maxBand[static_cast<size_t>(f)] = mx;
                double acc = 0.0;
                for (int c = 0; c < 2; ++c)
                {
                    const float* red = core.bandReductionDb(c);
                    for (const auto& bp : bins)
                    {
                        const double rdB = red[bp.j] + bp.t * (red[bp.j + 1] - red[bp.j]);
                        acc += std::pow(10.0, -rdB / 10.0);
                    }
                }
                pw[static_cast<size_t>(f)] = acc / (2.0 * std::max<size_t>(bins.size(), 1));
            }
            auto at = [&](const std::vector<double>& v, double sampleDecision) {   // linear interpolation at the decision sample (frame f is decided at (f + 1) H)
                const double fp = sampleDecision / H - 1.0;
                const int i0 = std::clamp(static_cast<int>(std::floor(fp)), 0, frames - 2);
                const double t = std::clamp(fp - i0, 0.0, 1.0);
                return v[static_cast<size_t>(i0)] * (1.0 - t) + v[static_cast<size_t>(i0 + 1)] * t;
            };
            auto coreMaxBand = [&](double Tms, double shiftSamples) { double s = 0; for (const auto& ev : tc.events) s += at(maxBand, ev.offset + Tms * sr / 1000.0 + shiftSamples); return s / tc.events.size(); };
            auto coreWindow = [&](double Tms, double shiftSamples) { double s = 0; for (const auto& ev : tc.events) s += at(pw, ev.offset + Tms * sr / 1000.0 + shiftSamples); return -10.0 * std::log10(s / tc.events.size()); };

            std::vector<std::string> row = { num(f0, 0), inum(durMs) };
            for (int T : Ts)
            {
                const double bench = -(T == 100 ? m.rOff100 : T == 250 ? m.rOff250 : T == 500 ? m.rOff500 : m.rOff1000);
                row.push_back(num(bench, 2));
                row.push_back(num(coreMaxBand(T, 0.0), 2));
                row.push_back(num(coreMaxBand(T, N / 2.0), 2));
                row.push_back(num(coreWindow(T, N / 2.0), 2));
            }
            t1.add(row);
            logf("      D1R f0 %4.0f D %4d | bench / core max band @T / @T+N/2 / window @T+N/2 :  100: %.2f / %.2f / %.2f / %.2f   250: %.2f / %.2f / %.2f / %.2f   500: %.2f / %.2f / %.2f / %.2f   1000: %.2f / %.2f / %.2f / %.2f",
                 f0, durMs, -m.rOff100, coreMaxBand(100, 0), coreMaxBand(100, N / 2.0), coreWindow(100, N / 2.0), -m.rOff250, coreMaxBand(250, 0), coreMaxBand(250, N / 2.0), coreWindow(250, N / 2.0),
                 -m.rOff500, coreMaxBand(500, 0), coreMaxBand(500, N / 2.0), coreWindow(500, N / 2.0), -m.rOff1000, coreMaxBand(1000, 0), coreMaxBand(1000, N / 2.0), coreWindow(1000, N / 2.0));

            double tCore = -1.0, tWin = -1.0, tBench = -1.0;
            for (int T = 0; T <= 1500 && (tCore < 0.0 || tWin < 0.0); ++T)
            {
                if (tCore < 0.0 && coreMaxBand(T, 0.0) <= 1.0) tCore = T;
                if (tWin < 0.0 && T >= 50 && coreWindow(T, N / 2.0) <= 1.0) tWin = T;
            }
            for (int T = kTvTauStartMs; T <= 1000; ++T) if (benchCut(T) <= 1.0) { tBench = T; break; }
            auto ms = [](double v) { return v < 0.0 ? std::string(">limit") : num(v, 0); };
            t2.add({ num(f0, 0), inum(durMs), num(coreMaxBand(0.0, 0.0), 2), ms(tCore), ms(tWin), tBench < 0.0 ? ">1000" : num(tBench, 0) });
            logf("      D1R f0 %4.0f D %4d | cut at offset (max band) %.2f dB | <= 1 dB: core D1 def %s ms, core window (aligned) %s ms, bench %s ms", f0, durMs, coreMaxBand(0.0, 0.0), ms(tCore).c_str(), ms(tWin).c_str(), tBench < 0.0 ? ">1000" : num(tBench, 0).c_str());
        }
    std::ofstream(dir / "d1_reconcile_cut.csv", std::ios::binary) << t1.csv();
    std::ofstream(dir / "d1_reconcile_time.csv", std::ios::binary) << t2.csv();
    std::ofstream(dir / "summary.md", std::ios::binary) << "# RS bench - core applied cut vs bench r_off(T)\n\n- Git: `" << hash << "`\n\n" << t1.markdown() << t2.markdown();
    logf("wrote d1_reconcile_*.csv and summary.md to %s", dir.string().c_str());
    return g_nonFinite == 0 ? 0 : 1;
}

// ============================================================================
// Seed protocol (--seedset). Informational regrading of the SAME gates; nothing here changes a threshold or a metric definition.
// ============================================================================
//
// A single noise realisation can flatter a design that was tuned on it. --seedset runs the complete graded run once per seed of a set and regrades every gate cell from the
// evidence the run already produced (BenchData), with the unchanged predicates g1Cell / g2Cell / g3LCell / g8aCell / ... and the unchanged limits. Per gate and per cell it reports
//   seeds passing | worst margin (value vs limit, over every seed) | median value over the seeds
// and a ROBUST verdict: a gate is passed only if it passes on EVERY seed of the set (the named G1 waiver of knownLimits() applies per seed, exactly as in the single-seed verdict).
// Margin = distance of the value to the nearest side of its limit in the cell's own unit (positive = headroom, negative = violation); the worst cell of a gate is the one with the smallest
// margin relative to its limit span. Sets: default = {0}, dev = {1..6} (tuning), heldout = {101..106} (RESERVED for the final confirmation by the person grading; never run during tuning).

struct SeedCapture
{
    BenchData bd;
    std::vector<GateRow> rows;       // one per gated subject
    std::vector<Subject> subjects;   // the same subjects, same order
    std::string runDir;
};

static int runGradedRun(const std::string& cfg, const std::string& cpu, bool isRelease, const std::string& hash, const std::string& stamp, SeedCapture* cap);

struct SeedCell
{
    std::string gate, name;
    double value = 0.0, hi = 0.0, lo = 0.0;
    bool hasLo = false;
    bool binary = false;   // G6: pass / fail only, no margin
    bool pass = true;      // the unchanged predicate
    bool waived = false;   // a failing cell waived by name (G1 at 100 Hz): counts as passed in the verdict, excluded from the margin statistics
    double margin() const { return binary ? 0.0 : std::min(hi - value, hasLo ? value - lo : 1.0e30); }
    double relMargin() const { const double span = hasLo ? (hi - lo) : std::abs(hi); return margin() / (span > 0.0 ? span : 1.0); }
};

static constexpr double kNeverValue = 1.0e4;   // value stored for "never reached" (G8a t50) / an unusable r_off interval

static SeedCell mkCell(const char* gate, const std::string& name, double value, double hi, bool pass, bool hasLo = false, double lo = 0.0)
{
    SeedCell c; c.gate = gate; c.name = name; c.value = value; c.hi = hi; c.pass = pass; c.hasLo = hasLo; c.lo = lo;
    return c;
}

static const std::vector<std::string>& seedGateOrder()
{
    static const std::vector<std::string> g = { "G1", "G2", "G1q", "G2q", "G1l", "G2l", "G3", "G4", "G5", "G6", "G7", "G8a", "G8b", "G9a", "G9b" };
    return g;
}

// Every graded cell of one subject for one seed, regraded with the unchanged predicates.
static std::vector<SeedCell> gradeCells(const Subject& s, const BenchData& d, const GateRow& g)
{
    std::vector<SeedCell> out;
    const auto rs = d.residual.find(s.id + "@48000");
    const auto idt = d.ideal.find("48000");
    if (rs != d.residual.end() && idt != d.ideal.end())
        for (double f0 : d.scanF0)
        {
            const int k = static_cast<int>(f0);
            const auto c = rs->second.find(k);
            const auto id = idt->second.find(k);
            if (c == rs->second.end() || id == idt->second.end()) continue;
            const double ideal = id->second;
            SeedCell a = mkCell("G1", inum(k) + " Hz", c->second.inWindow, kG1ResIdealFrac * ideal, g1Cell(c->second, ideal), true, kG1ResFloorDb);
            for (const auto& kl : knownLimits())
                if (std::string(kl.gate) == "G1" && kl.f0 == k && std::find(kl.subjects.begin(), kl.subjects.end(), s.id) != kl.subjects.end() && !a.pass) a.waived = true;
            out.push_back(a);
            out.push_back(mkCell("G2", inum(k) + " Hz", c->second.outsideDev, kG2OutsideDevDb, g2Cell(c->second)));
        }
    const auto sh = d.shape.find(s.id);
    if (sh != d.shape.end())
        for (const auto& c : shapeCases())
        {
            const auto it = sh->second.find(c.key);
            if (it == sh->second.end()) continue;
            const double ideal = idealBoostDb(48000.0, 2500.0, c.q, c.gainDb);
            if (c.inQ)     { out.push_back(mkCell("G1q", c.key, it->second.inWindow, kG1ResIdealFrac * ideal, g1Cell(it->second, ideal), true, kG1ResFloorDb)); out.push_back(mkCell("G2q", c.key, it->second.outsideDev, kG2OutsideDevDb, g2Cell(it->second))); }
            if (c.inLevel) { out.push_back(mkCell("G1l", c.key, it->second.inWindow, kG1ResIdealFrac * ideal, g1Cell(it->second, ideal), true, kG1ResFloorDb)); out.push_back(mkCell("G2l", c.key, it->second.outsideDev, kG2OutsideDevDb, g2Cell(it->second))); }
        }
    const auto e = d.right.find(s.id);
    if (e != d.right.end() && e->second.valid && idt != d.ideal.end() && idt->second.find(2500) != idt->second.end())
    {
        const double ideal = idt->second.at(2500);
        out.push_back(mkCell("G3", "R 2500 Hz in-window", e->second.r.inWindow, kG1ResIdealFrac * ideal, g1Cell(e->second.r, ideal), true, kG1ResFloorDb));
        out.push_back(mkCell("G3", "R 2500 Hz outside-dev", e->second.r.outsideDev, kG2OutsideDevDb, g2Cell(e->second.r)));
        const auto es = d.eScan.find(s.id);
        if (es != d.eScan.end())
            for (double f0 : d.scanF0)
            {
                const auto it = es->second.find(static_cast<int>(f0));
                if (it == es->second.end()) continue;
                out.push_back(mkCell("G3", "L " + inum(static_cast<int>(f0)) + " Hz in-window", it->second.l.inWindow, kG3LResAbsDb, std::abs(it->second.l.inWindow) <= kG3LResAbsDb, true, -kG3LResAbsDb));
                out.push_back(mkCell("G3", "L " + inum(static_cast<int>(f0)) + " Hz outside-dev", it->second.l.outsideDev, kG2OutsideDevDb, it->second.l.outsideDev <= kG2OutsideDevDb));
            }
    }
    const auto j = d.jitter.find(g.g4Id);
    if (j != d.jitter.end())
    {
        out.push_back(mkCell("G4", "std all (" + g.g4Id + ")", j->second.stdAll, kG4StdAllDb, j->second.stdAll <= kG4StdAllDb));
        out.push_back(mkCell("G4", "isolated all (" + g.g4Id + ")", j->second.isoAll, kG4IsoAll, j->second.isoAll <= kG4IsoAll));
    }
    const auto p = d.d2.find(s.id);
    if (p != d.d2.end())
    {
        out.push_back(mkCell("G5", "broadband", p->second.outVsIn, kG5BroadbandDb, p->second.outVsIn <= kG5BroadbandDb));
        out.push_back(mkCell("G5", "band", p->second.bandOutVsIn, kG5BandDb, p->second.bandOutVsIn <= kG5BandDb));
    }
    const auto l = d.latency.find(s.id);
    if (l != d.latency.end() && l->second.valid)
    {
        SeedCell c = mkCell("G6", "latency", 0.0, 0.0, l->second.matchAll && l->second.blockInvariant);
        c.binary = true;
        out.push_back(c);
    }
    const auto cr = d.cpuRatio.find(s.id);
    if (cr != d.cpuRatio.end())
    {
        out.push_back(mkCell("G7", "ratio @128", cr->second.second, kG7CpuRatio, cr->second.second <= kG7CpuRatio));
        out.push_back(mkCell("G7", "ratio @64", cr->second.first, kG7CpuRatio, cr->second.first <= kG7CpuRatio));
    }
    const auto tv = d.tv.find(s.id);
    if (tv != d.tv.end())
        for (const auto& kv : tv->second)
        {
            const int f0 = kv.first.first, durMs = kv.first.second;
            const TvMetrics& m = kv.second;
            const std::string nm = inum(f0) + " Hz D " + inum(durMs);
            if (g8Graded(durMs))
            {
                out.push_back(mkCell("G8a", nm, m.t50 < 0.0 ? kNeverValue : m.t50, kG8aT50Ms, g8aCell(m)));
                out.push_back(mkCell("G8b", nm, m.leak, durMs == 300 ? kG8bLeak300 : kG8bLeak1000, g8bCell(m, durMs)));
            }
            out.push_back(mkCell("G9a", nm, m.roffOk ? std::abs(m.rOff500) : kNeverValue, kG9aRoff500Db, g9aCell(m)));
            out.push_back(mkCell("G9b", nm, m.roffOk ? std::abs(m.rOff1000) : kNeverValue, kG9bRoff1000Db, g9bCell(m)));
        }
    (void)g;
    return out;
}

// Does the cell-level regrade agree with the GateRow the run itself produced? (a mismatch means the regrade drifted from evaluateGates; printed as a warning)
static bool gateAllPass(const std::vector<SeedCell>& cells, const std::string& gate, bool* anyCells = nullptr)
{
    bool any = false, all = true;
    for (const auto& c : cells) if (c.gate == gate) { any = true; if (!c.pass && !c.waived) all = false; }
    if (anyCells) *anyCells = any;
    return any && all;
}

static std::string fmtVal(double v)
{
    if (v >= 1.0e3) return "never";
    return (std::abs(v) < 0.01 && v != 0.0) ? num(v, 6) : num(v, 3);
}
static std::string fmtLimit(const SeedCell& c)
{
    if (c.binary) return "pass";
    return c.hasLo ? "[" + num(c.lo, 2) + " .. " + fmtVal(c.hi) + "]" : "<= " + fmtVal(c.hi);
}
static double medianOf(std::vector<double> v)
{
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    const size_t n = v.size();
    if (n & 1) return v[n / 2];
    const double a = v[n / 2 - 1], b = v[n / 2];
    return (a >= 1.0e3 || b >= 1.0e3) ? std::max(a, b) : 0.5 * (a + b);
}

// The Table CSV writer does not quote: a comma inside a cell would shift the columns.
static Table csvSafe(Table t)
{
    for (auto& h : t.header) for (char& c : h) if (c == ',') c = ';';
    for (auto& r : t.rows) for (auto& x : r) for (char& c : x) if (c == ',') c = ';';
    return t;
}

static int runSeedSet(const std::string& cfg, const std::string& cpu, bool isRelease, const std::string& hash, const std::string& stamp)
{
    std::vector<uint64_t> seeds;
    if (g_opt.seedset == "default") seeds = { 0 };
    else if (g_opt.seedset == "dev") seeds = { 1, 2, 3, 4, 5, 6 };
    else seeds = { 101, 102, 103, 104, 105, 106 };
    const bool heldout = g_opt.seedset == "heldout";
    std::string seedList;
    for (auto s : seeds) seedList += (seedList.empty() ? "" : ", ") + std::to_string(s);
    logf("--seedset %s: seeds {%s}; every gate is graded per seed, the ROBUST verdict needs every gate to pass on every seed", g_opt.seedset.c_str(), seedList.c_str());
    if (heldout) warnf("--seedset heldout: the held-out seeds (101..106) are RESERVED for the final confirmation by the person grading; tuning work uses default + dev only");

    const fs::path setDir = fs::path(g_opt.outBase) / (stamp + "_" + hash + "_seedset_" + g_opt.seedset + (g_opt.quick ? "_quick" : ""));
    std::error_code ec;
    fs::create_directories(setDir / "runs", ec);
    if (ec) { logf("cannot create %s", setDir.string().c_str()); return 3; }
    logf("seed-set directory : %s (per-seed run directories under runs/)", setDir.generic_string().c_str());

    const std::string savedOut = g_opt.outBase;
    g_opt.outBase = (setDir / "runs").string();
    std::vector<SeedCapture> caps(seeds.size());
    int rc = 0;
    for (size_t i = 0; i < seeds.size(); ++i)
    {
        g_opt.seed = seeds[i];
        logf("=== seed-set %s: seed %llu (%zu of %zu) ===", g_opt.seedset.c_str(), static_cast<unsigned long long>(seeds[i]), i + 1, seeds.size());
        const int r = runGradedRun(cfg, cpu, isRelease, hash, stamp, &caps[i]);
        if (r == 3) { g_opt.outBase = savedOut; g_opt.seed = 0; return r; }
        rc |= r;
    }
    g_opt.outBase = savedOut;
    g_opt.seed = 0;
    if (caps.empty() || caps[0].subjects.empty()) { logf("no gated subjects were graded"); return 2; }

    // ---- regrade per seed / subject ----
    struct PerSeed { uint64_t seed; std::vector<SeedCell> cells; std::string verdict; bool overallWaived; };
    struct PerSubject { Subject subj; bool reference; std::vector<PerSeed> seeds; };
    std::vector<PerSubject> subs;
    int drift = 0;
    for (size_t si = 0; si < caps[0].subjects.size(); ++si)
    {
        PerSubject ps; ps.subj = caps[0].subjects[si]; ps.reference = ps.subj.reference;
        for (size_t k = 0; k < caps.size(); ++k)
        {
            const GateRow& g = caps[k].rows[si];
            PerSeed p; p.seed = seeds[k]; p.cells = gradeCells(caps[k].subjects[si], caps[k].bd, g); p.verdict = g.verdict(); p.overallWaived = g.overallWaived();
            // The regrade must reproduce every gate flag of the run itself.
            bool any = false;
            const bool flags[] = { g.pass1w(), g.pass2(), g.pass1q(), g.pass2q(), g.pass1l(), g.pass2l(), g.g3, g.g4, g.g5, g.g6, !g.g7valid || g.g7, g.pass8a(), g.pass8b(), g.pass9a(), g.pass9b() };
            for (size_t gi = 0; gi < seedGateOrder().size(); ++gi)
            {
                const bool mine = gateAllPass(p.cells, seedGateOrder()[gi], &any);
                const bool theirs = flags[gi];
                const bool g7na = seedGateOrder()[gi] == "G7" && !g.g7valid;
                if (!g7na && mine != theirs) { ++drift; warnf("seed-set regrade drift: subject %s seed %llu gate %s: regrade %s, run %s", ps.subj.id.c_str(), static_cast<unsigned long long>(p.seed), seedGateOrder()[gi].c_str(), mine ? "pass" : "fail", theirs ? "pass" : "fail"); }
            }
            ps.seeds.push_back(std::move(p));
        }
        subs.push_back(std::move(ps));
    }
    if (drift == 0) logf("seed-set regrade reproduces every gate flag of every per-seed run (%zu subjects x %zu seeds x %zu gates)", subs.size(), seeds.size(), seedGateOrder().size());

    // ---- aggregate ----
    struct GateAgg
    {
        int seedsPass = 0, seedsPassRaw = 0;
        bool present = false, g7na = false;
        bool hasMargin = false;
        double worstRel = 1.0e30;
        SeedCell worstCell; uint64_t worstSeed = 0;
        std::vector<double> tight;      // per seed: value of that seed's tightest (non-waived, non-binary) cell
        int waivedSeeds = 0;
        std::vector<std::pair<uint64_t, SeedCell>> waivedCells;
    };
    const size_t nSeeds = seeds.size();

    Table tVerdict; tVerdict.title = "Seed set " + g_opt.seedset + " - robust verdict (every gate must pass on every seed)";
    tVerdict.note = "Seeds: {" + seedList + "}. 'seeds passing' = seeds on which the single-seed verdict (named G1 waiver applied) is not FAIL. 'robust verdict' = PASS only if every gate passes on every seed; "
                    "'waiver used' = seeds on which the named G1 waiver at 100 Hz was needed. Thresholds and metric definitions are exactly those of the single-seed run.";
    tVerdict.header = { "subject", "label", "seeds passing", "robust verdict", "gates failing on at least one seed", "waiver used" };
    Table tGates; tGates.title = "Seed set " + g_opt.seedset + " - per gate: seeds passing, worst margin, median value";
    tGates.note = "'seeds passing (waived)' applies the named G1 waiver per seed like the verdict; 'seeds passing (raw)' does not. 'worst cell' = the cell with the smallest margin relative to its limit span over every seed "
                  "(a waived failing cell is excluded here and listed under waived). margin = distance of the value to the nearest side of its limit in the cell's unit (negative = violated). "
                  "'median value' = median over the seeds of the value of each seed's tightest cell (dB, except G4 isolated fraction, G7 ratio, G8a ms, G8b leak; G9 is |r_off| in dB). 'never' = the onset time was never reached.";
    tGates.header = { "subject", "gate", "seeds passing (waived)", "seeds passing (raw)", "worst cell", "worst seed", "worst value", "limit", "worst margin", "median value", "robust" };
    Table tCells; tCells.title = "Seed set " + g_opt.seedset + " - per cell";
    tCells.note = "One row per graded cell (G1 / G2 per f0, shape cases, G3 R + L per f0, G4 / G5 values, G6, G7 ratios, G8 / G9 per (f0, D)). min / max / median over the seeds; 'worst margin' as in the gate table.";
    tCells.header = { "subject", "gate", "cell", "seeds passing", "worst seed", "worst value", "limit", "worst margin", "median value", "min value", "max value", "waived on seeds" };
    Table tSeeds; tSeeds.title = "Seed set " + g_opt.seedset + " - verdict per seed";
    tSeeds.header = { "subject", "seed", "verdict", "failing gates", "run directory" };
    Table tFocus; tFocus.title = "Seed set " + g_opt.seedset + " - focus cells (G1 100 / 150 / 220 Hz, G8a 500 Hz) and gates G4, G5, G9a";
    tFocus.note = "The cells the tier study asks about. Same columns as the per-cell table; G4 / G5 / G9a rows are the gate level (tightest cell per seed). "
                  "G1 100 Hz: 'worst value' is the RAW residual (dB); 'seeds passing' counts the named waiver (for the subjects that carry it), 'waived on seeds' says on how many seeds it was needed.";
    tFocus.header = { "subject", "item", "seeds passing", "worst seed", "worst value", "limit", "worst margin", "median value", "waived on seeds" };
    std::vector<std::string> robustLines;

    for (const auto& ps : subs)
    {
        std::map<std::string, GateAgg> agg;
        for (const auto& gate : seedGateOrder())
        {
            GateAgg a;
            for (const auto& p : ps.seeds)
            {
                bool any = false;
                const bool pass = gateAllPass(p.cells, gate, &any);
                a.present = a.present || any;
                if (pass) ++a.seedsPass;
                bool rawPass = any;
                const SeedCell* tight = nullptr;
                for (const auto& c : p.cells)
                {
                    if (c.gate != gate) continue;
                    if (!c.pass) rawPass = false;
                    if (c.waived) { ++a.waivedSeeds; a.waivedCells.emplace_back(p.seed, c); continue; }
                    if (c.binary) continue;
                    if (!tight || c.relMargin() < tight->relMargin()) tight = &c;
                }
                if (rawPass) ++a.seedsPassRaw;
                if (tight)
                {
                    a.tight.push_back(tight->value);
                    if (tight->relMargin() < a.worstRel) { a.worstRel = tight->relMargin(); a.worstCell = *tight; a.worstSeed = p.seed; a.hasMargin = true; }
                }
            }
            if (gate == "G7" && !a.present) a.g7na = true;
            agg[gate] = a;
        }

        // Characterisation subjects: Subject::notGraded gates are tabulated (seeds passing, worst cell, ...) but are not part of the robust verdict.
        auto isUngraded = [&](const std::string& gate) { return std::find(ps.subj.notGraded.begin(), ps.subj.notGraded.end(), gate) != ps.subj.notGraded.end(); };
        std::string failing; bool robust = true; int waiverSeeds = 0;
        std::string notGradedFailing;   // not-graded gates that did not pass on every seed (information only)
        for (const auto& gate : seedGateOrder())
        {
            const GateAgg& a = agg[gate];
            if (a.g7na) continue;
            if (static_cast<size_t>(a.seedsPass) != nSeeds || !a.present)
            {
                const std::string txt = gate + " (" + std::to_string(a.seedsPass) + "/" + std::to_string(nSeeds) + ")";
                if (isUngraded(gate)) { notGradedFailing += (notGradedFailing.empty() ? "" : "; ") + txt; continue; }
                robust = false; failing += (failing.empty() ? "" : "; ") + txt;
            }
        }
        for (const auto& p : ps.seeds) { bool w = false; for (const auto& c : p.cells) if (c.waived) w = true; if (w) ++waiverSeeds; }
        int seedsPassing = 0;
        for (const auto& p : ps.seeds) if (p.overallWaived) ++seedsPassing;
        std::string robustStr = robust ? (waiverSeeds ? "PASS (G1 100 Hz waived on " + std::to_string(waiverSeeds) + "/" + std::to_string(nSeeds) + " seeds)" : "PASS") : "FAIL";
        if (!ps.subj.notGraded.empty())
        {
            std::string list;
            for (const auto& x : ps.subj.notGraded) list += (list.empty() ? "" : ", ") + x;
            robustStr += " [link-100 characterisation: " + list + " not graded]";
        }
        const std::string failingTxt = (failing.empty() ? std::string("none") : failing)
                                       + (notGradedFailing.empty() ? std::string() : " | not graded (characterisation): " + notGradedFailing);
        tVerdict.add({ ps.subj.id, ps.subj.label, cnt(seedsPassing, static_cast<int>(nSeeds)), robustStr, failingTxt, waiverSeeds ? cnt(waiverSeeds, static_cast<int>(nSeeds)) : "none" });
        robustLines.push_back(ps.subj.id + ": " + robustStr + (failing.empty() ? "" : " - failing: " + failing) + (notGradedFailing.empty() ? "" : " - not graded, would fail: " + notGradedFailing));

        for (const auto& p : ps.seeds)
        {
            std::string f;
            for (const auto& gate : seedGateOrder())
            {
                bool any = false;
                if (!gateAllPass(p.cells, gate, &any) && !(gate == "G7" && !any)) f += (f.empty() ? "" : "; ") + gate + (isUngraded(gate) ? " (not graded)" : "");
            }
            tSeeds.add({ ps.subj.id, std::to_string(p.seed), p.verdict, f.empty() ? "none" : f, "runs/" + fs::path(caps[&p - ps.seeds.data()].runDir).filename().string() });
        }

        for (const auto& gate : seedGateOrder())
        {
            const GateAgg& a = agg[gate];
            if (a.g7na) { tGates.add({ ps.subj.id, gate, "n/a", "n/a", "-", "-", "-", "-", "-", "-", "n/a (--no-cpu)" }); continue; }
            const bool ok = a.present && static_cast<size_t>(a.seedsPass) == nSeeds;
            const std::string robustCell = isUngraded(gate) ? std::string("link-100 characterisation, not graded (") + (ok ? "would PASS" : "would FAIL") + ")" : std::string(ok ? "PASS" : "FAIL");
            std::vector<std::string> row = { ps.subj.id, gate, cnt(a.seedsPass, static_cast<int>(nSeeds)), cnt(a.seedsPassRaw, static_cast<int>(nSeeds)) };
            if (a.hasMargin)
            {
                row.push_back(a.worstCell.name); row.push_back(std::to_string(a.worstSeed)); row.push_back(fmtVal(a.worstCell.value)); row.push_back(fmtLimit(a.worstCell));
                row.push_back(num(a.worstCell.margin(), a.worstCell.hi < 0.01 ? 6 : 3)); row.push_back(fmtVal(medianOf(a.tight)));
            }
            else { for (int q = 0; q < 6; ++q) row.push_back(gate == "G6" ? "-" : "no data"); }
            row.push_back(robustCell);
            tGates.add(row);
            if (a.waivedSeeds > 0)
            {
                std::vector<double> allv;
                for (const auto& p : ps.seeds) for (const auto& c : p.cells) if (c.gate == gate && c.waived) allv.push_back(c.value);
                tGates.add({ ps.subj.id, gate + " (waived cell)", "-", "-", a.waivedCells.front().second.name + " WAIVED on " + cnt(a.waivedSeeds, static_cast<int>(nSeeds)) + " seeds", "-",
                             fmtVal(*std::max_element(allv.begin(), allv.end())), fmtLimit(a.waivedCells.front().second), "-", fmtVal(medianOf(allv)), "named waiver" });
            }
        }

        // per cell
        std::vector<std::pair<std::string, std::string>> keys;   // (gate, cell name), first-seen order
        for (const auto& gate : seedGateOrder())
            for (const auto& c : ps.seeds.front().cells)
                if (c.gate == gate) keys.emplace_back(gate, c.name);
        for (const auto& key : keys)
        {
            int pass = 0, waivedN = 0; std::vector<double> vals; const SeedCell* worst = nullptr; uint64_t worstSeed = 0; SeedCell first;
            bool have = false;
            for (const auto& p : ps.seeds)
                for (const auto& c : p.cells)
                {
                    if (c.gate != key.first || c.name != key.second) continue;
                    if (!have) { first = c; have = true; }
                    if (c.pass || c.waived) ++pass;
                    if (c.waived) ++waivedN;
                    vals.push_back(c.value);
                    if (!c.binary && (!worst || c.margin() < worst->margin())) { worst = &c; worstSeed = p.seed; }
                }
            if (vals.empty()) continue;
            const double mn = *std::min_element(vals.begin(), vals.end()), mx = *std::max_element(vals.begin(), vals.end());
            std::vector<std::string> row = { ps.subj.id, key.first, key.second, cnt(pass, static_cast<int>(nSeeds)), worst ? std::to_string(worstSeed) : "-", worst ? fmtVal(worst->value) : "-",
                                             fmtLimit(first), worst ? num(worst->margin(), worst->hi < 0.01 ? 6 : 3) : "-", first.binary ? "-" : fmtVal(medianOf(vals)),
                                             first.binary ? "-" : fmtVal(mn), first.binary ? "-" : fmtVal(mx), waivedN ? cnt(waivedN, static_cast<int>(nSeeds)) : "none" };
            tCells.add(row);
            const bool focus = (key.first == "G1" && (key.second == "100 Hz" || key.second == "150 Hz" || key.second == "220 Hz")) || (key.first == "G8a" && key.second.rfind("500 Hz", 0) == 0);
            if (focus) tFocus.add({ ps.subj.id, key.first + " " + key.second, row[3], row[4], row[5], row[6], row[7], row[8], row[11] });
        }
        for (const char* gate : { "G4", "G5", "G9a" })
        {
            const GateAgg& a = agg[gate];
            if (!a.hasMargin) continue;
            tFocus.add({ ps.subj.id, std::string(gate) + " (gate; tightest cell " + a.worstCell.name + ")", cnt(a.seedsPass, static_cast<int>(nSeeds)), std::to_string(a.worstSeed), fmtVal(a.worstCell.value),
                         fmtLimit(a.worstCell), num(a.worstCell.margin(), a.worstCell.hi < 0.01 ? 6 : 3), fmtVal(medianOf(a.tight)), "-" });
        }
    }

    // ---- outputs ----
    std::ofstream(setDir / "seedset_verdict.csv", std::ios::binary) << csvSafe(tVerdict).csv();
    std::ofstream(setDir / "seedset_gates.csv", std::ios::binary) << csvSafe(tGates).csv();
    std::ofstream(setDir / "seedset_cells.csv", std::ios::binary) << csvSafe(tCells).csv();
    std::ofstream(setDir / "seedset_per_seed.csv", std::ios::binary) << csvSafe(tSeeds).csv();
    std::ofstream(setDir / "seedset_focus.csv", std::ios::binary) << csvSafe(tFocus).csv();
    // failing cells (fail on >= 1 seed) in the summary; the full per-cell table is the CSV
    Table tFail; tFail.title = "Seed set " + g_opt.seedset + " - cells that fail on at least one seed";
    tFail.header = tCells.header;
    for (const auto& r : tCells.rows)
    {
        const std::string& pc = r[3];
        const auto slash = pc.find('/');
        if (slash != std::string::npos && pc.substr(0, slash) != pc.substr(slash + 1)) tFail.add(r);
    }
    std::ostringstream md;
    md << "# RS bench - seed set `" << g_opt.seedset << "` (" << (g_opt.quick ? "QUICK" : "FULL") << ")\n\n";
    md << "- Git: `" << hash << "` (working tree may be dirty)\n- Build: **" << cfg << "**" << (isRelease ? "" : "  **<-- NOT RELEASE**") << "\n- CPU: " << cpu << "\n";
    md << "- Seeds: {" << seedList << "} (a seed N shifts every generated noise seed by N x 1000003; seed 0 = the original signals)\n";
    md << "- **Seed protocol:** tuning work uses the `default` and `dev` (seeds 1..6) sets only. The `heldout` set (seeds 101..106) is RESERVED: it is run only for the final confirmation by the person grading, "
          "and no held-out result is reported by tuning work.\n";
    md << "- Robust verdict: a gate counts as passed only if it passes on EVERY seed of the set; the named G1 waiver at 100 Hz (C1c / C1c-N / C1c-H and RSC-N / RSC-H / RSC-N0 / RSC-H0) applies per seed exactly as in the single-seed verdict. "
          "RSC-F / RSC-N / RSC-H (stereo link 100 %) are a characterisation set: their G3 and G9a rows are printed but not graded. "
          "Thresholds and metric definitions are unchanged.\n";
    md << "- Regrade check: " << (drift == 0 ? "the per-cell regrade reproduces every gate flag of every per-seed run" : "**" + std::to_string(drift) + " regrade mismatches (see warnings)**") << "\n";
    md << "- Per-seed full runs (CSV, summary.md, WAVs): `runs/`\n\n";
    md << tVerdict.markdown() << tFocus.markdown() << tGates.markdown() << tFail.markdown() << tSeeds.markdown();
    std::ofstream(setDir / "summary.md", std::ios::binary) << md.str();

    logf("---- ROBUST VERDICT, seed set %s {%s} ----", g_opt.seedset.c_str(), seedList.c_str());
    for (const auto& l : robustLines) logf("%s", l.c_str());
    for (const auto& r : tFocus.rows)
        logf("focus %-7s %-44s pass %-4s worst seed %-4s value %-8s limit %-14s margin %-9s median %-8s waived %s", r[0].c_str(), r[1].c_str(), r[2].c_str(), r[3].c_str(), r[4].c_str(), r[5].c_str(), r[6].c_str(), r[7].c_str(), r[8].c_str());
    logf("wrote seedset_*.csv and summary.md to %s", setDir.string().c_str());
    logf("done. non-finite=%d warnings=%d", g_nonFinite, g_warnings);
    return (rc == 0 && g_nonFinite == 0) ? 0 : 1;
}

// ============================================================================
// Multi-instance CPU burst study (--cpu-burst). Informational: nothing here is a gate.
// ============================================================================
//
// Question: all of a hop's FFT / detector / gain work lands in the block that completes the hop (about 72 us = 5.4 % of a 64-sample budget for one C1c). N instances whose hop boundaries
// coincide put N times that into ONE block. The study processes N stereo instances back to back per block in one thread (each on its own pink noise, -20 dBFS, no resonance), timing the whole
// per-block loop, with
//   aligned    every instance starts at stream position 0, so every hop boundary falls in the same block;
//   staggered  instance i is shifted by i x hop / N samples. 'preroll' (bench only) feeds the instance i x hop / N samples first (untimed), which moves its hop boundaries relative to the block grid;
//              'core' prepares the core with its hopPhaseOffset (the same shift, inside the core).
// Aligned and staggered repetitions are interleaved (fresh instances each) so slow drifts of the machine hit both equally. First 1 s of each repetition is untimed. Copy-in is excluded from the timing.
// For the core the number of instances that completed a hop in each block is read from the core's introspection (framesProcessed) and tabulated.

static constexpr int kBurstReps = 3;

struct BurstRun
{
    std::vector<double> ns;
    std::vector<int> framesInBlock;   // core only: instances that completed a hop in the block (-1 = not available)
    std::vector<double> repMax;
};

static void burstOne(const Subject& s, const std::vector<Stereo>& sigs, double sr, int block, bool staggered, bool coreModeRequested, int hop, int reps, BurstRun& out)
{
    const bool coreMode = coreModeRequested && s.id.rfind("C1", 0) == 0;   // the offset exists on the core only; any other subject is staggered by pre-roll
    const int n = static_cast<int>(sigs.size());
    const int warm = static_cast<int>(sr);
    juce::MidiBuffer midi;
    std::vector<juce::AudioBuffer<float>> work;
    for (int i = 0; i < n; ++i) work.emplace_back(2, block);
    for (int rep = 0; rep < reps; ++rep)
    {
        std::vector<Fx> fx; fx.reserve(static_cast<size_t>(n));
        std::vector<int> pos(static_cast<size_t>(n), 0);
        for (int i = 0; i < n; ++i)
        {
            const int off = staggered ? (i * hop) / n : 0;
            g_burstCoreHopOffset = (staggered && coreMode) ? off : 0;
            fx.push_back(makeFx(s, sr, 2500.0, false, block));
            g_burstCoreHopOffset = 0;
            if (staggered && !coreMode && off > 0)
            {
                // pre-roll: consume `off` samples of the instance's own stream in chunks of at most `block`
                for (int done = 0; done < off;)
                {
                    const int k = std::min(block, off - done);
                    for (int c = 0; c < 2; ++c) std::memcpy(work[static_cast<size_t>(i)].getWritePointer(c), sigs[static_cast<size_t>(i)].ch[c].data() + done, sizeof(float) * static_cast<size_t>(k));
                    juce::AudioBuffer<float> view(work[static_cast<size_t>(i)].getArrayOfWritePointers(), 2, k);
                    fx.back().proc().processBlock(view, midi);
                    done += k;
                }
                pos[static_cast<size_t>(i)] = off;
            }
        }
        std::vector<const ResonanceCoreProcessor*> cores(static_cast<size_t>(n), nullptr);
        for (int i = 0; i < n; ++i) cores[static_cast<size_t>(i)] = dynamic_cast<const ResonanceCoreProcessor*>(&fx[static_cast<size_t>(i)].proc());
        std::vector<long long> lastFrames(static_cast<size_t>(n), 0);
        for (int i = 0; i < n; ++i) if (cores[static_cast<size_t>(i)]) lastFrames[static_cast<size_t>(i)] = cores[static_cast<size_t>(i)]->core().framesProcessed();
        double repMax = 0.0;
        const int total = sigs[0].size();
        for (int b = 0;; ++b)
        {
            const int base = b * block;
            if (base + block + (staggered && !coreMode ? hop : 0) > total) break;
            for (int i = 0; i < n; ++i)
                for (int c = 0; c < 2; ++c)
                    std::memcpy(work[static_cast<size_t>(i)].getWritePointer(c), sigs[static_cast<size_t>(i)].ch[c].data() + pos[static_cast<size_t>(i)] + base, sizeof(float) * static_cast<size_t>(block));
            const auto t0 = std::chrono::steady_clock::now();
            for (int i = 0; i < n; ++i) fx[static_cast<size_t>(i)].proc().processBlock(work[static_cast<size_t>(i)], midi);
            const auto t1 = std::chrono::steady_clock::now();
            int nf = -1;
            if (cores[0])
            {
                nf = 0;
                for (int i = 0; i < n; ++i)
                {
                    const long long fr = cores[static_cast<size_t>(i)]->core().framesProcessed();
                    if (fr != lastFrames[static_cast<size_t>(i)]) { ++nf; lastFrames[static_cast<size_t>(i)] = fr; }
                }
            }
            if (base >= warm)
            {
                const double v = static_cast<double>(std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count());
                out.ns.push_back(v); out.framesInBlock.push_back(nf); repMax = std::max(repMax, v);
            }
        }
        out.repMax.push_back(repMax);
    }
}

static int runCpuBurst(const std::string& cfg, const std::string& cpu, bool isRelease, const std::string& hash, const std::string& stamp)
{
    const double sr = 48000.0;
    const int N = g_opt.burstInstances;
    const bool coreMode = g_opt.burstStagger == "core";
    if (coreMode && g_opt.burstStagger == "core") logf("--burst-stagger core: C1c-N instances are prepared with Core::setHopPhaseOffset(i x hop / N); S3c (no such option) is staggered by pre-roll");
    std::vector<Subject> subs;
    for (const char* id : { "C1c-N", "S3c" })
        for (const auto& s : capabilitySubjects()) if (s.id == id) subs.push_back(s);
    if (subs.empty()) { logf("--cpu-burst: C1c-N / S3c are not registered (check --subjects)"); return 2; }
    const fs::path dir = fs::path(g_opt.outBase) / (stamp + "_" + hash + "_cpuburst_" + g_opt.burstStagger);
    std::error_code ec; fs::create_directories(dir, ec);
    if (!isRelease) warnf("*** NOT A RELEASE BUILD - CPU numbers are meaningless ***");
    const int hop = 256;   // Normal tier at 48 kHz for both C1c-N (N = 1024) and the RS HQ Normal effect
    logf("--cpu-burst: %d stereo instances back to back per block, one thread, own pink noise each (-20 dBFS), %d x %.0f s per case (aligned / staggered interleaved), stagger = i x %d / %d samples via '%s'",
         N, kBurstReps, g_opt.burstSeconds, hop, N, g_opt.burstStagger.c_str());
    std::vector<Stereo> sigs;
    const int len = static_cast<int>(g_opt.burstSeconds * sr) + hop + 4096;
    for (int i = 0; i < N; ++i) sigs.push_back(makePinkStereo(len, -20.0, 200 + static_cast<uint64_t>(i)));

    Table t; t.title = "CPU-B1. " + std::to_string(N) + " stereo instances per block (48 kHz, pink noise): per-block TOTAL time, aligned vs staggered hop phases";
    t.note = "Build: " + cfg + ". CPU: " + cpu + ". " + std::to_string(N) + " instances processed back to back per block in one thread; each instance has its own pink noise (-20 dBFS), no resonance; " + std::to_string(kBurstReps) + " repetitions x "
             + num(g_opt.burstSeconds, 0) + " s pooled (fresh instances per repetition, first 1 s untimed, copy-in excluded, steady_clock). Budget = block / 48000 s (64 -> 1333.3 us, 128 -> 2666.7 us) for the WHOLE loop of "
             + std::to_string(N) + " instances. stagger = instance i shifted by i x " + std::to_string(hop) + " / " + std::to_string(N) + " samples (mode: " + g_opt.burstStagger + "). Single thread, normal priority, no isolation from other processes.";
    t.header = { "subject", "block", "hop phases", "blocks", "mean us", "p50 us", "p95 us", "p99 us", "p99.9 us", "max us", "mean % budget", "max % budget", "blocks > 25 % budget", "blocks > 50 % budget", "min rep max us", "max rep max us" };
    Table tf; tf.title = "CPU-B2. C1c-N: how many instances complete a hop in a block";
    tf.note = "Read from the core's framesProcessed() after every block. 'mean us' = mean block total for blocks with that many hop completions.";
    tf.header = { "block", "hop phases", "instances completing a hop", "blocks", "% of blocks", "mean us", "max us" };
    for (const auto& s : subs)
        for (int block : { 64, 128 })
        {
            BurstRun aligned, stag;
            for (int rep = 0; rep < kBurstReps; ++rep)
            {
                burstOne(s, sigs, sr, block, false, coreMode, hop, 1, aligned);
                burstOne(s, sigs, sr, block, true, coreMode, hop, 1, stag);
            }
            for (int m = 0; m < 2; ++m)
            {
                const BurstRun& r = m == 0 ? aligned : stag;
                const char* nm = m == 0 ? "aligned" : "staggered";
                const double budgetNs = block / sr * 1.0e9;
                const std::vector<double>& v = r.ns;
                const double mean = std::accumulate(v.begin(), v.end(), 0.0) / static_cast<double>(std::max<size_t>(v.size(), 1));
                const double mx = *std::max_element(v.begin(), v.end());
                std::vector<double> a = v, b = v, c = v, d = v;
                const double p50 = percentile(a, 0.50), p95 = percentile(b, 0.95), p99 = percentile(c, 0.99), p999 = percentile(d, 0.999);
                long long o25 = 0, o50 = 0;
                for (double x : v) { if (x > 0.25 * budgetNs) ++o25; if (x > 0.50 * budgetNs) ++o50; }
                t.add({ s.id, inum(block), nm, inum(static_cast<long long>(v.size())), num(mean / 1000.0, 2), num(p50 / 1000.0, 2), num(p95 / 1000.0, 2), num(p99 / 1000.0, 2), num(p999 / 1000.0, 2), num(mx / 1000.0, 2),
                        num(100.0 * mean / budgetNs, 3), num(100.0 * mx / budgetNs, 2), inum(o25), inum(o50),
                        num(*std::min_element(r.repMax.begin(), r.repMax.end()) / 1000.0, 2), num(*std::max_element(r.repMax.begin(), r.repMax.end()) / 1000.0, 2) });
                logf("      %-5s block %3d %-9s: %zu blocks  mean %.2f us  p50 %.2f  p95 %.2f  p99 %.2f  p99.9 %.2f  max %.2f us = %.2f %% of the %.1f us budget (mean %.2f %%; per-rep max %.1f .. %.1f us)",
                     s.id.c_str(), block, nm, v.size(), mean / 1000.0, p50 / 1000.0, p95 / 1000.0, p99 / 1000.0, p999 / 1000.0, mx / 1000.0, 100.0 * mx / budgetNs, budgetNs / 1000.0, 100.0 * mean / budgetNs,
                     *std::min_element(r.repMax.begin(), r.repMax.end()) / 1000.0, *std::max_element(r.repMax.begin(), r.repMax.end()) / 1000.0);
                if (s.id == "C1c-N")
                {
                    std::map<int, std::vector<double>> by;
                    for (size_t i = 0; i < r.ns.size(); ++i) by[r.framesInBlock[i]].push_back(r.ns[i]);
                    for (const auto& kv : by)
                    {
                        const double mm = std::accumulate(kv.second.begin(), kv.second.end(), 0.0) / static_cast<double>(kv.second.size());
                        const double xx = *std::max_element(kv.second.begin(), kv.second.end());
                        tf.add({ inum(block), nm, inum(kv.first), inum(static_cast<long long>(kv.second.size())), num(100.0 * static_cast<double>(kv.second.size()) / static_cast<double>(v.size()), 2), num(mm / 1000.0, 2), num(xx / 1000.0, 2) });
                        logf("        %-9s %d instance(s) complete a hop: %zu blocks (%.2f %%)  mean %.2f us  max %.2f us", nm, kv.first, kv.second.size(), 100.0 * static_cast<double>(kv.second.size()) / static_cast<double>(v.size()), mm / 1000.0, xx / 1000.0);
                    }
                }
            }
        }
    std::ofstream(dir / "cpu_burst.csv", std::ios::binary) << t.csv();
    std::ofstream(dir / "cpu_burst_frames.csv", std::ios::binary) << tf.csv();
    std::ofstream(dir / "summary.md", std::ios::binary) << "# RS bench - multi-instance burst\n\n- Git: `" << hash << "`\n- Build: **" << cfg << "**\n- CPU: " << cpu << "\n\n" << t.markdown() << tf.markdown();
    logf("wrote cpu_burst*.csv and summary.md to %s", dir.string().c_str());
    return g_nonFinite == 0 ? 0 : 1;
}

// ============================================================================
// main
// ============================================================================

// ============================================================================
// Correlated-noise diagnostic (--corr-diag). NOT a gate, NOT a verdict: no threshold or metric definition is touched.
// ============================================================================
//
// Question: with the RS default stereo link 100 %, RSC-N cuts on max(L, R) of two detectors. On independent L/R noise that is the max of two independent estimates,
// which raises sensitivity and so may be the reason G1 @ 150 Hz and G8a @ 500 Hz look better than for the link-0 core (C1c-N / RSC-N0) on the dev seeds. With FULLY
// CORRELATED L/R noise (the same noise in both channels, the planted bell in both) the two detectors see identical input, so max(L, R) = L and the link cannot add anything.
// If RSC-N's advantage over RSC-N0 / C1c-N survives there, it is not the independent-noise effect.
// Cells: G1 @ 150 Hz (scan signal A at f0 = 150 Hz, in-window residual vs clean, limit 0.30 x ideal) and G8a @ 500 Hz (T1 f0 = 500 Hz, D = 300 and 1000 ms, t50 vs 100 ms).
// Subjects: RSC-N (link 100), RSC-N0 (link 0, open curve), C1c-N (the core). Normal tier. Dev seeds 1..6. Both noise conditions are run in the same process
// (the cleanPsd cache and the signal generators key on the condition). Everything else (metrics, alignment, processors) is exactly the graded run's.

static int runCorrDiag(const std::string& cfg, const std::string& cpu, bool isRelease, const std::string& hash, const std::string& stamp)
{
    const fs::path dir = fs::path(g_opt.outBase) / (stamp + "_" + hash + "_corrdiag" + (g_opt.quick ? "_quick" : ""));
    std::error_code ec;
    fs::create_directories(dir, ec);
    if (ec) { logf("cannot create %s", dir.string().c_str()); return 3; }
    const double SR = 48000.0;
    const std::vector<uint64_t> seeds = { 1, 2, 3, 4, 5, 6 };
    const std::vector<std::string> ids = { "RSC-N", "RSC-N0", "C1c-N" };
    std::vector<Subject> subs;
    for (const auto& id : ids)
    {
        bool found = false;
        for (const auto& s : capabilitySubjects()) if (s.id == id) { subs.push_back(s); found = true; }
        if (!found) { logf("subject %s is not registered", id.c_str()); return 3; }
    }
    logf("--corr-diag: G1 @ 150 Hz and G8a @ 500 Hz (D 300 / 1000) of %s / %s / %s, dev seeds 1..6, independent vs fully correlated L/R noise", ids[0].c_str(), ids[1].c_str(), ids[2].c_str());

    struct Res { double g1 = 0; double t50[2] = { 0, 0 }; };
    std::map<std::tuple<int, uint64_t, std::string>, Res> res;   // (corr, seed, subject)
    const int nA = static_cast<int>(sigSeconds() * SR);
    const double ideal150 = idealBoostDb(SR, 150.0), limit150 = kG1ResIdealFrac * ideal150;
    const std::array<int, 2> durs = { 300, 1000 };
    for (int corr = 0; corr < 2; ++corr)
        for (uint64_t seed : seeds)
        {
            g_opt.corrNoise = corr != 0;
            g_opt.seed = seed;
            logf("=== corr-diag: %s noise, seed %llu ===", corr ? "CORRELATED" : "independent", static_cast<unsigned long long>(seed));
            const Stereo base = makePinkStereo(nA, -20.0, 1);
            const Stereo sig = makeResonant(base, SR, 150.0, true, true);
            for (const auto& s : subs)
            {
                Fx fx = makeFx(s, SR, 150.0, false, kPrepareBlock);
                const Stereo out = renderStd(fx, sig);
                const auto a = align(sig, out, measureLatency(s, SR).measured, SR);
                res[{ corr, seed, s.id }].g1 = suppressionAccuracy(a, "C@48000", base, SR, 150.0).res.inWindow;
            }
            for (size_t di = 0; di < durs.size(); ++di)
            {
                const int durMs = durs[di];
                TvCase tc = makeTvCase(500.0, durMs, SR);
                int kMin = 0, kMax = 0; tvFrameRange(durMs, SR, kMin, kMax);
                const auto eClean = tvWindowEnergy(tc.clean, tc.events, kMin, kMax, SR, 500.0);
                const auto ePass  = tvWindowEnergy(tc.sig,   tc.events, kMin, kMax, SR, 500.0);
                Planted pl; pl.f0 = 500.0; pl.left = true; pl.right = true; pl.cleanRef = &tc.clean;
                for (const auto& ev : tc.events) pl.events.emplace_back(ev.onset, ev.offset);
                for (const auto& s : subs)
                {
                    Fx fx = makeFx(s, SR, 500.0, false, kPrepareBlock, &pl);
                    const Stereo out = renderStd(fx, tc.sig);
                    const auto a = align(tc.sig, out, measureLatency(s, SR).measured, SR);
                    const auto eOut = tvWindowEnergy(a.out, tc.events, kMin, kMax, SR, 500.0);
                    const TvMetrics m = tvAnalyse(eOut, eClean, ePass, durMs, kMin, SR);
                    res[{ corr, seed, s.id }].t50[di] = m.t50 < 0.0 ? kNeverValue : m.t50;
                }
            }
        }
    g_opt.corrNoise = false;
    g_opt.seed = 0;

    Table t; t.title = "Correlated-noise diagnostic: G1 @ 150 Hz and G8a @ 500 Hz, Normal tier, dev seeds 1..6";
    t.note = "G1 @ 150 Hz: in-window residual vs clean (dB; gate limit " + num(limit150, 3) + " dB = 0.30 x ideal " + num(ideal150, 3) + "; lower = more of the resonance removed). G8a @ 500 Hz: t50 (ms; gate limit "
             + num(kG8aT50Ms, 0) + " ms; 'never' = " + num(kNeverValue, 0) + ") for D = 300 and 1000 ms. 'independent' = the graded run's noise; 'correlated' = the same noise in L and R. "
             "RSC-N = stereo link 100 % (product default), RSC-N0 = link 0 + open curve, C1c-N = the core directly. Diagnostic only: nothing here is a gate.";
    t.header = { "noise", "seed", "subject", "G1 150 Hz (dB)", "G1 pass", "G8a 500 Hz D300 t50 (ms)", "G8a D300 pass", "G8a 500 Hz D1000 t50 (ms)", "G8a D1000 pass" };
    for (int corr = 0; corr < 2; ++corr)
        for (uint64_t seed : seeds)
            for (const auto& s : subs)
            {
                const Res& r = res[{ corr, seed, s.id }];
                const bool p1 = r.g1 >= kG1ResFloorDb && r.g1 <= limit150;
                t.add({ corr ? "correlated" : "independent", std::to_string(seed), s.id, num(r.g1, 3), p1 ? "P" : "F",
                        fmtVal(r.t50[0]), r.t50[0] <= kG8aT50Ms ? "P" : "F", fmtVal(r.t50[1]), r.t50[1] <= kG8aT50Ms ? "P" : "F" });
            }
    // Aggregates per (noise, subject): mean / worst G1 and t50, seeds passing.
    Table agg; agg.title = "Aggregate over the 6 dev seeds";
    agg.header = { "noise", "subject", "G1 150 Hz mean (dB)", "G1 worst (dB)", "G1 seeds passing", "t50 D300 mean (ms)", "t50 D300 worst (ms)", "G8a D300 seeds passing",
                   "t50 D1000 mean (ms)", "t50 D1000 worst (ms)", "G8a D1000 seeds passing" };
    for (int corr = 0; corr < 2; ++corr)
        for (const auto& s : subs)
        {
            double g1s = 0, g1w = -1e9, a3 = 0, w3 = -1e9, a10 = 0, w10 = -1e9; int p1 = 0, p3 = 0, p10 = 0;
            for (uint64_t seed : seeds)
            {
                const Res& r = res[{ corr, seed, s.id }];
                g1s += r.g1; g1w = std::max(g1w, r.g1); a3 += r.t50[0]; w3 = std::max(w3, r.t50[0]); a10 += r.t50[1]; w10 = std::max(w10, r.t50[1]);
                if (r.g1 >= kG1ResFloorDb && r.g1 <= limit150) ++p1;
                if (r.t50[0] <= kG8aT50Ms) ++p3;
                if (r.t50[1] <= kG8aT50Ms) ++p10;
            }
            const double n = static_cast<double>(seeds.size());
            agg.add({ corr ? "correlated" : "independent", s.id, num(g1s / n, 3), num(g1w, 3), cnt(p1, 6), fmtVal(a3 / n), fmtVal(w3), cnt(p3, 6), fmtVal(a10 / n), fmtVal(w10), cnt(p10, 6) });
        }
    std::ofstream(dir / "corr_diag.csv", std::ios::binary) << csvSafe(t).csv();
    std::ofstream(dir / "corr_diag_aggregate.csv", std::ios::binary) << csvSafe(agg).csv();
    std::ofstream(dir / "summary.md", std::ios::binary)
        << "# RS bench - correlated-noise diagnostic (--corr-diag)\n\n- Git: `" << hash << "`\n- Build: **" << cfg << "**" << (isRelease ? "" : "  **<-- NOT RELEASE**") << "\n- CPU: " << cpu << "\n\n"
        << agg.markdown() << t.markdown();
    logf("---- corr-diag aggregate (G1 limit %.3f dB, G8a limit %.0f ms) ----", limit150, kG8aT50Ms);
    for (const auto& r : agg.rows)
        logf("%-11s %-7s | G1 150 Hz mean %7s worst %7s pass %s | G8a D300 t50 mean %7s worst %7s pass %s | D1000 mean %7s worst %7s pass %s",
             r[0].c_str(), r[1].c_str(), r[2].c_str(), r[3].c_str(), r[4].c_str(), r[5].c_str(), r[6].c_str(), r[7].c_str(), r[8].c_str(), r[9].c_str(), r[10].c_str());
    logf("wrote corr_diag.csv, corr_diag_aggregate.csv and summary.md to %s", dir.string().c_str());
    return g_nonFinite == 0 ? 0 : 1;
}

static bool parseArgs(int argc, char** argv)
{
    for (int i = 1; i < argc; ++i)
    {
        const std::string a = argv[i];
        if (a == "--quick") g_opt.quick = true;
        else if (a == "--no-cpu") g_opt.noCpu = true;
        else if (a == "--cpu-only") g_opt.cpuOnly = true;
        else if (a == "--ref-subjects") g_opt.refSubjects = true;
        else if (a == "--out-dir" && i + 1 < argc) g_opt.outBase = argv[++i];
        else if (a == "--core-tau" && i + 1 < argc) g_opt.coreTauMs = static_cast<float>(std::atof(argv[++i]));
        else if (a == "--core-fast" && i + 1 < argc) g_opt.coreFastMs = static_cast<float>(std::atof(argv[++i]));
        else if (a == "--seed" && i + 1 < argc) g_opt.seed = static_cast<uint64_t>(std::strtoull(argv[++i], nullptr, 10));
        else if (a == "--cpu-worst") g_opt.cpuWorst = true;
        else if (a == "--d1-reconcile") g_opt.d1Reconcile = true;
        else if (a == "--cpu-burst") g_opt.cpuBurst = true;
        else if (a == "--corr-diag") g_opt.corrDiag = true;
        else if (a == "--burst-instances" && i + 1 < argc) g_opt.burstInstances = std::max(1, std::atoi(argv[++i]));
        else if (a == "--burst-seconds" && i + 1 < argc) g_opt.burstSeconds = std::max(2.0, std::atof(argv[++i]));
        else if (a == "--burst-stagger" && i + 1 < argc)
        {
            g_opt.burstStagger = argv[++i];
            if (g_opt.burstStagger != "preroll" && g_opt.burstStagger != "core") { std::printf("[RSBench] --burst-stagger expects preroll|core\n"); return false; }
        }
        else if (a == "--seedset" && i + 1 < argc)
        {
            g_opt.seedset = argv[++i];
            if (g_opt.seedset != "default" && g_opt.seedset != "dev" && g_opt.seedset != "heldout")
            { std::printf("[RSBench] --seedset expects default|dev|heldout\n"); return false; }
        }
        else if (a == "--subjects" && i + 1 < argc)
        {
            std::stringstream ss(argv[++i]);
            for (std::string id; std::getline(ss, id, ',');)
                if (!id.empty()) g_opt.subjects.push_back(id);
            if (g_opt.subjects.empty()) { std::printf("[RSBench] --subjects expects a comma-separated id list\n"); return false; }
        }
        else if (a == "--wav" && i + 1 < argc)
        {
            const std::string v = argv[++i];
            const auto eq = v.find('=');
            if (eq == std::string::npos || eq == 0) { std::printf("[RSBench] --wav expects label=path\n"); return false; }
            g_opt.wavs.emplace_back(v.substr(0, eq), v.substr(eq + 1));
        }
        else { std::printf("[RSBench] unknown argument: %s\n", a.c_str()); return false; }
    }
    if (g_opt.cpuOnly && g_opt.noCpu) { std::printf("[RSBench] --cpu-only and --no-cpu are mutually exclusive\n"); return false; }
    if (!g_opt.seedset.empty() && g_opt.seed != 0) { std::printf("[RSBench] --seedset and --seed are mutually exclusive (the set chooses the seeds)\n"); return false; }
    if (g_opt.corrDiag && (!g_opt.seedset.empty() || g_opt.seed != 0 || g_opt.cpuOnly || g_opt.cpuWorst || g_opt.d1Reconcile || g_opt.cpuBurst))
    { std::printf("[RSBench] --corr-diag chooses its own seeds (dev 1..6) and cannot be combined with --seedset / --seed / --cpu-only / --cpu-worst / --d1-reconcile / --cpu-burst\n"); return false; }
    if (!g_opt.seedset.empty() && (g_opt.cpuOnly || g_opt.cpuWorst || g_opt.d1Reconcile || g_opt.cpuBurst))
    { std::printf("[RSBench] --seedset grades the full run; it cannot be combined with --cpu-only / --cpu-worst / --d1-reconcile / --cpu-burst\n"); return false; }
    return true;
}

int main(int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    if (!parseArgs(argc, argv)) return 2;

    bool isRelease = false;
    const std::string cfg = buildConfig(isRelease);
    const std::string cpu = cpuBrand();
    const std::string hash = gitShortHash();
    const std::string stamp = utcStamp();

    logf("=== xleth_rs_quality_bench ===");
    logf("build configuration : %s", cfg.c_str());
    if (!isRelease)
        warnf("*** NOT A RELEASE BUILD - CPU numbers are meaningless; build with --config Release ***");
#if defined(_ITERATOR_DEBUG_LEVEL)
    logf("_ITERATOR_DEBUG_LEVEL : %d", static_cast<int>(_ITERATOR_DEBUG_LEVEL));
#endif
#if defined(XLETH_DEBUG)
    logf("XLETH_DEBUG is defined for this target (the engine ships it ON in Release)");
#endif
    logf("CPU                 : %s", cpu.c_str());
    logf("git                 : %s   mode: %s", hash.c_str(), g_opt.quick ? "QUICK (8 s signals, reduced reps)" : "FULL");

    if (g_opt.cpuOnly)
    {
        const double sr = 48000.0;
        const auto defaults = primarySubjects();
        const fs::path cpuDir = fs::path(g_opt.outBase) / (stamp + "_" + hash + "_cpuonly" + (g_opt.quick ? "_quick" : ""));
        std::error_code ce;
        fs::create_directories(cpuDir, ce);
        logf("--cpu-only: CPU benchmark only (default subjects, blocks 64 / 128 / 512), %d reps x %.0f s per subject/block", cpuReps(), cpuSeconds());
        const Stereo cpuSig = makePinkStereo(static_cast<int>((cpuSeconds() + 1.0) * sr), -20.0, 3);
        const auto rows = runCpuRows(defaults, { 64, 128, 512 }, sr, cpuSig);
        Table t; t.title = "9. CPU (48 kHz stereo)";
        t.note = "Build: " + cfg + ". CPU: " + cpu + ". " + inum(cpuReps()) + " repetitions of " + num(cpuSeconds(), 0) + " s stereo pink noise (-20 dBFS), "
                 "fresh instance per repetition, first 1 s untimed, per-block wall time of processBlock(). % RT = ns / (block / 48000 s)." + (isRelease ? "" : " **NOT A RELEASE BUILD**");
        t.header = { "subject", "label", "block", "median ns", "p95 ns", "p99 ns", "max ns", "mean ns", "median % RT", "p95 % RT", "mean % RT", "max % RT" };
        fillCpuTable(t, rows);
        const Table proj = cpuProjectionTable(rows, cpu);
        logf("---- CPU table (CPU: %s) ----", cpu.c_str());
        logf("%-4s %6s %12s %12s %12s %10s %10s", "subj", "block", "mean ns", "p99 ns", "max ns", "mean %RT", "p99 %RT");
        for (const auto& c : rows)
            logf("%-4s %6d %12.0f %12.0f %12.0f %10.3f %10.3f", c.id.c_str(), c.block, c.r.meanNs, c.r.p99Ns, c.r.maxNs,
                 100.0 * c.r.meanNs / c.budgetNs, 100.0 * c.r.p99Ns / c.budgetNs);
        logCpuProjection(rows, cpu);
        const auto ratios = cpuRatios(rows);
        const Table ratioTable = cpuRatioTable(rows, ratios);
        for (const auto& r : ratioTable.rows)
            logf("G7 ratio vs %s (same run)  %-4s @64: %s  @128: %s  -> %s", kG7RefId, r[0].c_str(), r[3].c_str(), r[5].c_str(), r[6].c_str());
        std::ofstream(cpuDir / "cpu.csv", std::ios::binary) << t.csv();
        std::ofstream(cpuDir / "cpu_g7_ratio.csv", std::ios::binary) << ratioTable.csv();
        std::ofstream(cpuDir / "summary.md", std::ios::binary)
            << "# RS bench - CPU only\n\n- Git: `" << hash << "`\n- Build: **" << cfg << "**\n- CPU: " << cpu << "\n\n" << t.markdown() << proj.markdown() << ratioTable.markdown();
        logf("wrote cpu.csv and summary.md to %s", cpuDir.string().c_str());
        return g_nonFinite == 0 ? 0 : 1;
    }

    if (g_opt.cpuWorst) return runCpuWorst(cfg, cpu, isRelease, hash, stamp);
    if (g_opt.d1Reconcile) return runD1Reconcile(hash, stamp);
    if (g_opt.cpuBurst) return runCpuBurst(cfg, cpu, isRelease, hash, stamp);
    if (g_opt.corrDiag) return runCorrDiag(cfg, cpu, isRelease, hash, stamp);
    if (!g_opt.seedset.empty()) return runSeedSet(cfg, cpu, isRelease, hash, stamp);
    return runGradedRun(cfg, cpu, isRelease, hash, stamp, nullptr);
}

// The graded run for the current g_opt.seed: every table / CSV / WAV / summary.md of a default run. `cap` (seed-set mode only) receives the evidence behind the gate table so
// the seed-set evaluator can regrade it per cell; nothing it holds is written back, so a run with cap == nullptr is exactly the historical run.
static int runGradedRun(const std::string& cfg, const std::string& cpu, bool isRelease, const std::string& hash, const std::string& stamp, SeedCapture* cap)
{
    const fs::path runDir =fs::path(g_opt.outBase) / (stamp + "_" + hash + (g_opt.quick ? "_quick" : "") + (g_opt.seed ? "_seed" + std::to_string(g_opt.seed) : std::string()));
    if (g_opt.seed) logf("noise seed shift   : --seed %llu (all generated signals); 0 = the original seeds", static_cast<unsigned long long>(g_opt.seed));
    const fs::path wavDir = runDir / "wav";
    std::error_code ec;
    fs::create_directories(wavDir, ec);
    if (ec) { logf("cannot create %s", runDir.string().c_str()); return 3; }
    logf("output directory   : %s", runDir.string().c_str());

    const auto primary   = primarySubjects();
    const auto sensitive = sensitiveSubjects();
    const auto capability = capabilitySubjects();
    std::vector<Subject> allSubjects = primary;
    allSubjects.insert(allSubjects.end(), sensitive.begin(), sensitive.end());
    allSubjects.insert(allSubjects.end(), capability.begin(), capability.end());
    // Subjects that get the A/B scan, delta-artefact and D/D2 runs: defaults + capability.
    std::vector<Subject> scanSubjects = primary;
    scanSubjects.insert(scanSubjects.end(), capability.begin(), capability.end());
    for (const auto& s : sensitive)   // a gated subject registered in the Sensitive group is still scanned + graded
        if (s.gated) scanSubjects.push_back(s);

    const std::vector<double> rates = { 48000.0, 44100.0 };
    const std::vector<double> scanF0 = { 100, 150, 220, 330, 500, 750, 1100, 1700, 2500, 3700, 5500, 8000 };

    std::vector<Table> tables;       // summary order
    std::map<std::string, Table> csvTables;   // file stem -> table

    // ---------------------------------------------------------------- latency
    logf("[1/9] latency (unit impulse, neutral config)");
    Table tLat; tLat.title = "1. Latency (samples)";
    tLat.note = "Measured = argmax |out| of a unit impulse (neutral config: RS depth 0, EQ band gain 0 dB) minus the impulse position. "
                "Reported = the effect's own getLatencySamples(); Published = the juce::AudioProcessor base value a host sees (differs from Reported only if the effect forgot setLatencySamples).";
    tLat.header = { "subject", "label", "sr", "measured", "reported", "published", "measured==reported", "ms (measured)" };
    bool latencyAllOk = true;
    for (double sr : rates)
        for (const auto& s : allSubjects)
        {
            const auto L = measureLatency(s, sr);
            const bool match = (L.measured == L.reported);
            if (!match) { latencyAllOk = false; warnf("latency mismatch %s @%.0f: measured %d reported %d", s.id.c_str(), sr, L.measured, L.reported); }
            tLat.add({ s.id, s.label, num(sr, 0), inum(L.measured), inum(L.reported), inum(L.published), match ? "yes" : "NO", num(1000.0 * L.measured / sr, 3) });
        }
    csvTables["latency"] = tLat;
    tables.push_back(tLat);

    // ---------------------------------------------------------------- v3 shared evidence for the gate table
    BenchData bd;
    bd.scanF0 = scanF0;

    // G6: latency must also be independent of the block schedule (impulse re-measured per schedule, both rates, gated subjects).
    {
        struct LSched { std::string name; std::vector<int> v; };
        const std::vector<LSched> ls = { { "64", { 64 } }, { "128", { 128 } }, { "480", { 480 } }, { "512", { 512 } }, { "1024", { 1024 } }, { "mixed", kMixedSchedule } };
        Table t; t.title = "1b. Latency vs block size (gated subjects)";
        t.note = "Impulse latency re-measured through each block schedule (prepareToPlay(maxBlock = largest block of the schedule), neutral config). "
                 "G6 passes when measured == reported at both sample rates AND the value is identical across every schedule.";
        t.header = { "subject", "sr", "reported" };
        for (auto& x : ls) t.header.push_back(x.name);
        t.header.push_back("invariant");
        for (const auto& s : allSubjects)
        {
            if (!s.gated) continue;
            LatencyGate lg; lg.valid = true;
            std::string det;
            for (double sr : rates)
            {
                const auto L = measureLatency(s, sr);
                if (L.measured != L.reported) lg.matchAll = false;
                std::vector<std::string> row = { s.id, num(sr, 0), inum(L.reported) };
                bool inv = true;
                for (auto& x : ls)
                {
                    bool ok = true;
                    const int m = measureLatencyWithSchedule(s, sr, x.v, ok);
                    if (!ok || m != L.measured) inv = false;
                    row.push_back(inum(m));
                }
                if (!inv) lg.blockInvariant = false;
                row.push_back(inv ? "yes" : "NO");
                t.add(row);
                det += (det.empty() ? "" : "; ") + num(sr, 0) + ":" + inum(L.measured) + "/" + inum(L.reported) + (inv ? "" : " BLOCK-DEPENDENT");
            }
            lg.detail = det;
            bd.latency[s.id] = lg;
        }
        csvTables["latency_blocksize"] = t; tables.push_back(t);
    }

    // ---------------------------------------------------------------- signals @48k
    const double SR = 48000.0;
    const int nA = static_cast<int>(sigSeconds() * SR);
    const int nD = static_cast<int>(dSeconds() * SR);
    logf("generating signals (%.0f s A/B/C/E, %.0f s D)", sigSeconds(), dSeconds());
    const Stereo pinkC = makePinkStereo(nA, -20.0, 1);                 // signal C (and base of A/B/E)
    const Stereo sigA2500 = makeResonant(pinkC, SR, 2500.0, true, true);
    const Stereo sigD = makeTransientBed(nD, SR);
    writeWav(wavDir / "A2500_in.wav", sigA2500, SR);
    writeWav(wavDir / "D_in.wav", sigD, SR);

    // ---------------------------------------------------------------- transparency
    logf("[2/9] transparency (depth 0, signal A@2500)");
    Table tTr; tTr.title = "2. Transparency (depth 0 / neutral)";
    tTr.note = "RMS(out - latency-aligned in) in dBFS on signal A (f0 = 2500 Hz), both channels, first 2 s skipped. RS: depth 0. EQ: spectral band gain 0 dB. Lower = more transparent; -300 = bit-exact.";
    tTr.header = { "subject", "label", "RMS(out-in) dBFS" };
    for (const auto& s : primary)
    {
        Fx fx = makeFx(s, SR, 2500.0, true, kPrepareBlock);
        const Stereo out = renderStd(fx, sigA2500);
        const auto a = align(sigA2500, out, measureLatency(s, SR).measured, SR);
        tTr.add({ s.id, s.label, num(rmsDiffDbfs(a), 2) });
    }
    csvTables["transparency"] = tTr; tables.push_back(tTr);

    // ---------------------------------------------------------------- scan (3) + delta (5) + WAV A
    logf("[3/9] resonance scan + suppression accuracy (both sample rates)");
    Table tScanCsv; tScanCsv.header = { "subject", "sr", "f0_hz", "removed_db", "collateral_db", "removed_minus_collateral_db", "ideal_db", "removed_pct_of_ideal" };
    Table tResCsv;  tResCsv.header  = { "subject", "sr", "f0_hz", "in_window_residual_db", "outside_dev_db", "ideal_db", "g1_limit_db", "g1_pass", "g2_pass" };
    std::map<std::string, std::map<int, RC>> scanRes;       // key "S1@48000" -> f0 -> RC
    std::map<std::string, RC> r2500;                        // 48k, f0 2500
    std::map<std::string, Aligned> alignedA2500;
    std::map<std::string, std::map<int, double>> idealDb;   // key "48000" -> f0 -> ideal dB
    auto pct = [](double removed, double ideal) { return ideal > 1.0e-9 ? 100.0 * removed / ideal : 0.0; };
    for (double sr : rates)
        for (double f0 : scanF0)
            idealDb[num(sr, 0)][static_cast<int>(f0)] = idealBoostDb(sr, f0);
    for (double sr : rates)
    {
        const int n = static_cast<int>(sigSeconds() * sr);
        const Stereo base = makePinkStereo(n, -20.0, 1);
        for (double f0 : scanF0)
        {
            const Stereo sig = makeResonant(base, sr, f0, true, true);
            const double ideal = idealDb[num(sr, 0)][static_cast<int>(f0)];
            for (const auto& s : scanSubjects)
            {
                Fx fx = makeFx(s, sr, f0, false, kPrepareBlock);
                const Stereo out = renderStd(fx, sig);
                const auto a = align(sig, out, measureLatency(s, sr).measured, sr);
                const Accuracy acc = suppressionAccuracy(a, "C@" + num(sr, 0), base, sr, f0);
                const RC rc = acc.rc;
                scanRes[s.id + "@" + num(sr, 0)][static_cast<int>(f0)] = rc;
                bd.residual[s.id + "@" + num(sr, 0)][static_cast<int>(f0)] = acc.res;
                tResCsv.add({ s.id, num(sr, 0), num(f0, 0), num(acc.res.inWindow, 4), num(acc.res.outsideDev, 4), num(ideal, 4),
                              num(kG1ResIdealFrac * ideal, 4), g1Cell(acc.res, ideal) ? "1" : "0", g2Cell(acc.res) ? "1" : "0" });
                tScanCsv.add({ s.id, num(sr, 0), num(f0, 0), num(rc.removed, 4), num(rc.collateral, 4), num(rc.removed - rc.collateral, 4),
                               num(ideal, 4), num(pct(rc.removed, ideal), 2) });
                if (sr == SR && f0 == 2500.0)
                {
                    r2500[s.id] = rc;
                    alignedA2500[s.id] = a;
                }
            }
        }
        logf("      scan done @%.0f Hz", sr);
    }
    csvTables["scan"] = tScanCsv;
    csvTables["residual_scan"] = tResCsv;
    bd.ideal = idealDb;
    for (double sr : rates)
    {
        // 0 = defaults, 1 = capability, 2 = removed/ideal % of all (these three are informational, not gates),
        // 3 = residual vs clean (defaults), 4 = residual vs clean (capability / gated)
        for (int variant = 0; variant < 5; ++variant)
        {
            const std::vector<Subject>& subs = (variant == 0 || variant == 3) ? primary : ((variant == 1 || variant == 4) ? capability : scanSubjects);
            Table t;
            if (variant == 3 || variant == 4)
            {
                t.title = std::string(variant == 3 ? "3r. " : "3rc. ") + "Residual vs clean - resonance scan @" + num(sr, 0) + " Hz (" + (variant == 3 ? "default parameters)" : "capability runs, gated)");
                t.note = "Signal A/B = clean pink C (30 s, -20 dBFS RMS) + RBJ peak +12 dB Q 8 at f0 in both channels; the clean reference is the UNPROCESSED C (same seed and length), "
                         "so an ideal suppressor's output equals C. Latency-aligned, Welch PSD (Hann 8192, 50 % overlap, first 2 s skipped), channels power-averaged. "
                         "in_window = mean over f0 +/- 1/6 oct of dB(PSD_out) - dB(PSD_clean) (ideal 0; positive = resonance remains; negative = over-suppression); "
                         "outside_dev = mean over 100 Hz-12 kHz excluding f0 +/- 1/3 oct of |dB(PSD_out) - dB(PSD_clean)|. "
                         "Each cell: in_window / outside_dev (dB). G1 limit = 0.30 x ideal dB (gate range -1.5 .. limit); G2 limit = 0.5 dB.";
                t.header = { "f0 Hz", "ideal dB", "G1 max" };
                for (const auto& s : subs) t.header.push_back(s.id);
                for (double f0 : scanF0)
                {
                    const double ideal = idealDb[num(sr, 0)][static_cast<int>(f0)];
                    std::vector<std::string> row = { num(f0, 0), num(ideal, 2), num(kG1ResIdealFrac * ideal, 2) };
                    for (const auto& s : subs)
                    {
                        const Residual r = bd.residual[s.id + "@" + num(sr, 0)][static_cast<int>(f0)];
                        row.push_back(num(r.inWindow, 2) + " / " + num(r.outsideDev, 2));
                    }
                    t.add(row);
                }
                tables.push_back(t);
                continue;
            }
            if (variant == 0)
            {
                t.title = "3. Suppression accuracy - resonance scan @" + num(sr, 0) + " Hz (default parameters) - informational (not a gate)";
                t.note = "Signal A/B: 30 s pink (-20 dBFS RMS) + RBJ peak +12 dB Q 8 at f0 in both channels. Welch PSD (Hann 8192, 50 % overlap, first 2 s skipped), "
                         "channels power-averaged. removed = mean dB(PSDin - PSDout) over f0 +/- 1/6 oct; collateral = mean |dB(PSDin - PSDout)| over 100 Hz-12 kHz excluding f0 +/- 1/3 oct. "
                         "ideal = analytic mean dB boost of the planted bell over the SAME removed window and bins (the yardstick). "
                         "Each cell: removed (removed/ideal %) / collateral / removed-collateral (dB). S5's band centre = f0.";
            }
            else if (variant == 1)
            {
                t.title = "3c. Suppression accuracy - resonance scan @" + num(sr, 0) + " Hz (capability runs) - informational (not a gate)";
                t.note = "Same signals and metric definitions as table 3. S1c = RS LL depth 100 / Hard; S2c-S4c = RS HQ Fast/Normal/High depth 100 / Hard; "
                         "S5c = EQ Spectral band gain -30 dB, spec_sens 0.0; S5q = same with band Q 8. Each cell: removed (removed/ideal %) / collateral / removed-collateral (dB). "
                         "removed/ideal above 100 % means the output went BELOW the unboosted spectrum, so this table cannot be a pass condition (see 3rc for the gate metric).";
            }
            else
            {
                t.title = "3p. removed / ideal (%) - resonance scan @" + num(sr, 0) + " Hz, all subjects - informational (not a gate)";
                t.note = "removed_dB / ideal_dB x 100, f0 +/- 1/6 oct window, defaults (S1-S5) and capability (S1c-S5c, S5q) side by side. 100 % = the planted +12 dB bell fully flattened.";
            }
            t.header = { "f0 Hz", "ideal dB" };
            for (const auto& s : subs) t.header.push_back(s.id);
            for (double f0 : scanF0)
            {
                const double ideal = idealDb[num(sr, 0)][static_cast<int>(f0)];
                std::vector<std::string> row = { num(f0, 0), num(ideal, 2) };
                for (const auto& s : subs)
                {
                    const RC rc = scanRes[s.id + "@" + num(sr, 0)][static_cast<int>(f0)];
                    if (variant == 2) row.push_back(num(pct(rc.removed, ideal), 1) + " %");
                    else row.push_back(num(rc.removed, 2) + " (" + num(pct(rc.removed, ideal), 0) + " %) / " + num(rc.collateral, 2) + " / " + num(rc.removed - rc.collateral, 2));
                }
                t.add(row);
            }
            tables.push_back(t);
        }
    }

    // ---------------------------------------------------------------- v4 shape scans (Q, level) at f0 = 2500 Hz / 48 kHz
    logf("[3b/9] shape scans: Q in {4,8,16} @ +12 dB and level in {+12,+18} dB @ Q 8 (f0 2500 Hz, 48 kHz)");
    {
        Table tShCsv; tShCsv.header = { "subject", "case", "planted_q", "planted_gain_db", "in_window_residual_db", "outside_dev_db", "ideal_db", "g1_limit_db", "g1_pass", "g2_pass" };
        for (const auto& c : shapeCases())
        {
            const Stereo sig = makeResonant(pinkC, SR, 2500.0, true, true, c.q, c.gainDb);
            const double ideal = idealBoostDb(SR, 2500.0, c.q, c.gainDb);
            Planted pl; pl.f0 = 2500.0; pl.q = c.q; pl.gainDb = c.gainDb; pl.left = true; pl.right = true;
            for (const auto& s : scanSubjects)
            {
                Fx fx = makeFx(s, SR, 2500.0, false, kPrepareBlock, &pl);
                const Stereo out = renderStd(fx, sig);
                const auto a = align(sig, out, measureLatency(s, SR).measured, SR);
                const Accuracy acc = suppressionAccuracy(a, "C@48000", pinkC, SR, 2500.0);
                bd.shape[s.id][c.key] = acc.res;
                tShCsv.add({ s.id, c.key, num(c.q, 1), num(c.gainDb, 1), num(acc.res.inWindow, 4), num(acc.res.outsideDev, 4), num(ideal, 4),
                             num(kG1ResIdealFrac * ideal, 4), g1Cell(acc.res, ideal) ? "1" : "0", g2Cell(acc.res) ? "1" : "0" });
            }
        }
        csvTables["shape_scan"] = tShCsv;
        for (int pass = 0; pass < 2; ++pass)
        {
            Table t;
            t.title = pass == 0 ? "3q. Shape scan - planted Q (f0 2500 Hz, +12 dB, 48 kHz) - gates G1q / G2q"
                                : "3l. Shape scan - planted level (f0 2500 Hz, Q 8, 48 kHz) - gates G1l / G2l";
            t.note = "Signal = the same pink C (seed of signal A) + RBJ peak (Q, level as in the case column) in both channels; clean reference = the unprocessed C; same Welch / residual definitions as 3rc. "
                     "ideal dB is recomputed per case (mean dB boost of THIS bell over f0 +/- 1/6 oct); G1 max = 0.30 x ideal (floor -1.5); G2 limit 0.5 dB. "
                     "Each cell: in_window / outside_dev (dB), then the G1 G2 verdict letters. The processors are NOT retuned per case (EQ band Q stays 8, RS stays depth 100 / Hard). "
                     "The Q8/+12 case is identical to the 2500 Hz row of the main scan and appears in both tables.";
            t.header = { "case", "ideal dB", "G1 max" };
            for (const auto& s : scanSubjects) t.header.push_back(s.id);
            for (const auto& c : shapeCases())
            {
                if (pass == 0 ? !c.inQ : !c.inLevel) continue;
                const double ideal = idealBoostDb(SR, 2500.0, c.q, c.gainDb);
                std::vector<std::string> row = { c.key, num(ideal, 2), num(kG1ResIdealFrac * ideal, 2) };
                for (const auto& s : scanSubjects)
                {
                    const Residual& r = bd.shape[s.id][c.key];
                    row.push_back(num(r.inWindow, 2) + " / " + num(r.outsideDev, 2) + "  " + (g1Cell(r, ideal) ? "P" : "F") + (g2Cell(r) ? "P" : "F"));
                }
                t.add(row);
            }
            tables.push_back(t);
        }
    }

    // delta artefact (5) + WAVs for A@2500
    logf("[4/9] delta artefact energy + WAVs (A@2500)");
    Table tDel; tDel.title = "5. Delta artefact energy (signal A, f0 = 2500 Hz, 48 kHz)";
    tDel.note = "Energy of (in_aligned - out_aligned) OUTSIDE f0 +/- 1/3 octave, relative to total input energy, in dB (Welch PSD sums, first 2 s skipped). S1c-S5c = capability runs.";
    tDel.header = { "subject", "label", "delta energy outside band vs input (dB)" };
    for (const auto& s : scanSubjects)
    {
        const auto& a = alignedA2500[s.id];
        tDel.add({ s.id, s.label, num(deltaArtefactDb(a, SR, 2500.0), 2) });
        writeWav(wavDir / ("A2500_" + s.id + "_out.wav"),   a.out, SR);
        writeWav(wavDir / ("A2500_" + s.id + "_delta.wav"), deltaOf(a), SR);
    }
    csvTables["delta_artefact"] = tDel; tables.push_back(tDel);

    // ---------------------------------------------------------------- jitter (4)
    logf("[5/9] musical-noise jitter (signal C, default + sensitive)");
    Table tJit; tJit.title = "4. Musical-noise jitter (signal C: pink, no resonance, 48 kHz)";
    tJit.note = "STFT 1024 Hann hop 256 of aligned in/out (first 2 s skipped); G(t,b) = 10log10(E_out/E_in) per 1/6-octave band (100 Hz-12 kHz; bands holding no STFT bin are dropped). "
                "std = mean over bands of the std-dev over time of G (dB). isolated = fraction of interior T-F cells with reduction > 3 dB whose 8 neighbours all have reduction < 1.5 dB. "
                "'loc' = only bands centred in 1.25-5 kHz (around the S5 band centre, 2.5 kHz, so S5 is not diluted by the bands it never touches). Mean of the two channels.";
    tJit.header = { "subject", "label", "params", "std all (dB)", "isolated all", "std loc (dB)", "isolated loc", "bands (loc)", "frames" };
    for (const auto& s : allSubjects)
    {
        Fx fx = makeFx(s, SR, 2500.0, false, kPrepareBlock);
        const Stereo out = renderStd(fx, pinkC);
        const auto a = align(pinkC, out, measureLatency(s, SR).measured, SR);
        const Jitter j = jitterMetrics(a, SR);
        bd.jitter[s.id] = j;
        tJit.add({ s.id, s.label, s.params, num(j.stdAll, 4), num(j.isoAll, 6), num(j.stdLoc, 4), num(j.isoLoc, 6),
                   inum(j.bands) + " (" + inum(j.bandsLoc) + ")", inum(j.frames) });
    }
    csvTables["jitter"] = tJit; tables.push_back(tJit);

    // ---------------------------------------------------------------- pre-echo (6)
    logf("[6/9] pre-echo (signal D) + WAVs");
    const Stereo sigD2 = makeTransientBed(nD, SR, 2500.0);
    writeWav(wavDir / "D2_in.wav", sigD2, SR);
    const std::string preNote =
        "-40 dBFS pink bed + noise bursts (-10 dBFS RMS at onset, 80 ms exp. decay time constant) every 500 ms. For each onset the 20 ms BEFORE the onset "
        "(aligned, both channels) is measured, mean over bursts (dB). 'broadband' columns: first = 10log10(E_out/E_in) (the specified metric; >0 = more energy before "
        "the onset in the output than in the input), second (supplementary) = 10log10(E_(out-in)/E_in), the difference signal relative to the input there. "
        "'band' columns: the same two ratios restricted to f0 +/- 1/3 octave (f0 = 2500 Hz; rectangular 20 ms window zero-padded to 2048, Parseval band sum). "
        "S1c-S5c = capability runs.";
    const std::vector<std::string> preHeader = { "subject", "label", "broadband E_out vs E_in (dB)", "broadband E_(out-in) vs E_in (dB)",
                                                 "band E_out vs E_in (dB)", "band E_(out-in) vs E_in (dB)", "bursts" };
    Table tPre; tPre.title = "6. Pre-echo (signal D, 48 kHz) - MASK NOT ENGAGED (no resonance in the signal)";
    tPre.note = preNote;
    tPre.header = preHeader;
    Table tPre2; tPre2.title = "6b. Pre-echo (signal D2, 48 kHz) - mask engaged (+12 dB / Q8 bell at 2500 Hz on the noise bed)";
    tPre2.note = "Signal D2 = signal D with the +12 dB / Q8 RBJ bell at 2500 Hz applied to the noise bed (bursts stay broadband and unfiltered), so the suppressor's mask is "
                 "active at 2500 Hz before every onset. " + preNote;
    tPre2.header = preHeader;
    for (const auto& s : scanSubjects)
    {
        Fx fx = makeFx(s, SR, 2500.0, false, kPrepareBlock);
        const Stereo out = renderStd(fx, sigD);
        const auto a = align(sigD, out, measureLatency(s, SR).measured, SR);
        const PreEcho pe = preEcho(a, SR);
        tPre.add({ s.id, s.label, num(pe.outVsIn, 3), num(pe.errVsIn, 2), num(pe.bandOutVsIn, 3), num(pe.bandErrVsIn, 2), inum(pe.bursts) });
        writeWav(wavDir / ("D_" + s.id + "_out.wav"),   a.out, SR);
        writeWav(wavDir / ("D_" + s.id + "_delta.wav"), deltaOf(a), SR);

        Fx fx2 = makeFx(s, SR, 2500.0, false, kPrepareBlock);
        const Stereo out2 = renderStd(fx2, sigD2);
        const auto a2 = align(sigD2, out2, measureLatency(s, SR).measured, SR);
        const PreEcho pe2 = preEcho(a2, SR);
        bd.d2[s.id] = pe2;
        tPre2.add({ s.id, s.label, num(pe2.outVsIn, 3), num(pe2.errVsIn, 2), num(pe2.bandOutVsIn, 3), num(pe2.bandErrVsIn, 2), inum(pe2.bursts) });
        writeWav(wavDir / ("D2_" + s.id + "_out.wav"),   a2.out, SR);
        writeWav(wavDir / ("D2_" + s.id + "_delta.wav"), deltaOf(a2), SR);
    }
    csvTables["preecho"] = tPre; tables.push_back(tPre);
    csvTables["preecho_d2"] = tPre2; tables.push_back(tPre2);

    // ---------------------------------------------------------------- block size (7)
    logf("[7/9] block-size dependence (signal A@2500)");
    struct Sched { std::string name; std::vector<int> v; };
    const std::vector<Sched> scheds = { { "64", { 64 } }, { "128", { 128 } }, { "480", { 480 } }, { "512", { 512 } }, { "1024", { 1024 } }, { "mixed", kMixedSchedule } };
    Table tBlk; tBlk.title = "7. Block-size dependence (signal A, f0 = 2500 Hz, 48 kHz)";
    tBlk.note = "RMS(out_block - out_512) in dBFS over all channels after the first 2 s (outputs compared sample-for-sample; latency is block independent). "
                "prepareToPlay(maxBlock = 1024) for every run. 'mixed' = {1,37,128,255,511,1024,37} as in test_effects.cpp. Cell: RMS dBFS (max |diff|). -300 = bit-identical.";
    tBlk.header = { "subject", "label" };
    for (auto& sc : scheds) tBlk.header.push_back(sc.name);
    Table tBlkCsv; tBlkCsv.header = { "subject", "schedule", "rms_diff_dbfs", "max_abs_diff" };
    for (const auto& s : primary)
    {
        std::vector<Stereo> outs;
        for (auto& sc : scheds)
        {
            Fx fx = makeFx(s, SR, 2500.0, false, kPrepareBlock);
            outs.push_back(render(fx, sigA2500, sc.v));
        }
        const Stereo& ref = outs[3];   // 512
        std::vector<std::string> row = { s.id, s.label };
        const int skip = static_cast<int>(kSkipSec * SR);
        for (size_t k = 0; k < scheds.size(); ++k)
        {
            double acc = 0, mx = 0; long long cnt = 0;
            for (int c = 0; c < 2; ++c)
                for (int i = skip; i < ref.size(); ++i)
                {
                    const double d = static_cast<double>(outs[k].ch[c][static_cast<size_t>(i)]) - ref.ch[c][static_cast<size_t>(i)];
                    acc += d * d; mx = std::max(mx, std::abs(d)); ++cnt;
                }
            const double rmsDb = dbAmp(std::sqrt(acc / std::max<long long>(cnt, 1)));
            row.push_back(num(rmsDb, 1) + " (" + num(mx, 6) + ")");
            tBlkCsv.add({ s.id, scheds[k].name, num(rmsDb, 4), num(mx, 8) });
        }
        tBlk.add(row);
    }
    csvTables["blocksize"] = tBlkCsv; tables.push_back(tBlk);

    // ---------------------------------------------------------------- right-only (8)
    logf("[8/9] right-only resonance (signal E, every scan f0)");
    Table tRight; tRight.title = "8. Right-only resonance (signal E, f0 = 2500 Hz, 48 kHz)";
    tRight.note = "Resonance planted in the RIGHT channel only (independent pink noise in each channel). removed_dB at f0 +/- 1/6 oct per channel (same definition as metric 3, single channel). "
                  "The left channel has no resonance, so its value shows what a linked / left-driven mask does to a clean channel.";
    tRight.header = { "subject", "label", "removed R (dB)", "removed L (dB)", "collateral R (dB)", "collateral L (dB)" };
    Table tRightRes; tRightRes.title = "8b. Right-only resonance vs clean (signal E, f0 = 2500 Hz, 48 kHz) - gate G3 evidence";
    tRightRes.note = "Same signal and render as table 8; clean reference = unprocessed C (the pink noise E was built from), latency-aligned. Metrics as in 3r, computed per channel "
                     "(R: resonance planted; L: untouched, so its output must equal the clean L). G3 = R gates (R in_window within -1.5 .. 0.30 x ideal AND R outside_dev <= 0.5, at 2500 Hz) "
                     "AND the L gate at EVERY one of the 12 scan f0 (L in_window within +/- 1.0 dB AND L outside_dev <= 0.5; per-f0 table 8c). "
                     "ideal at 2500 Hz / 48 kHz = " + num(bd.ideal["48000"][2500], 2) + " dB. The L columns here are the 2500 Hz values; 'L gate' = f0 passing out of 12.";
    tRightRes.header = { "subject", "label", "R in_window (dB)", "R outside_dev (dB)", "L in_window (dB)", "L outside_dev (dB)", "R gates", "L gate (f0 of 12)", "G3" };
    Table tRightCsv; tRightCsv.header = { "subject", "r_in_window_db", "r_outside_dev_db", "l_in_window_db", "l_outside_dev_db", "ideal_db", "g3", "r_gates", "l_gate_pass_f0", "l_gate_total_f0" };
    Table tRightF0Csv; tRightF0Csv.header = { "subject", "f0_hz", "r_in_window_db", "r_outside_dev_db", "l_in_window_db", "l_outside_dev_db", "l_gate" };
    Table tRightF0; tRightF0.title = "8c. Right-only resonance, LEFT (untouched) channel at every scan f0 (signal E, 48 kHz) - gate G3 L evidence";
    tRightF0.note = "Signal E at each f0 (+12 dB / Q8 bell in R only; clean reference = unprocessed C). Cell: L in_window / L outside_dev (dB), then P/F = L gate verdict "
                    "(|L in_window| <= 1.0 dB AND L outside_dev <= 0.5 dB). The L output of an ideal processor equals the clean L, so both figures are 0.";
    tRightF0.header = { "f0 Hz" };
    for (const auto& s : scanSubjects) tRightF0.header.push_back(s.id);
    {
        std::map<std::string, RC> remR, remL;   // removed/collateral at 2500 Hz (table 8)
        for (double f0 : scanF0)
        {
            const Stereo sigE = makeResonant(pinkC, SR, f0, false, true);
            Planted pl; pl.f0 = f0; pl.left = false; pl.right = true;
            for (const auto& s : scanSubjects)
            {
                Fx fx = makeFx(s, SR, f0, false, kPrepareBlock, &pl);
                const Stereo out = renderStd(fx, sigE);
                const auto a = align(sigE, out, measureLatency(s, SR).measured, SR);
                const Accuracy aR = suppressionAccuracy(a, "C@48000", pinkC, SR, f0, false, true);
                const Accuracy aL = suppressionAccuracy(a, "C@48000", pinkC, SR, f0, true, false);
                EResidual er; er.valid = true; er.r = aR.res; er.l = aL.res;
                bd.eScan[s.id][static_cast<int>(f0)] = er;
                tRightF0Csv.add({ s.id, num(f0, 0), num(er.r.inWindow, 4), num(er.r.outsideDev, 4), num(er.l.inWindow, 4), num(er.l.outsideDev, 4), g3LCell(er.l) ? "1" : "0" });
                if (f0 == 2500.0) { bd.right[s.id] = er; remR[s.id] = aR.rc; remL[s.id] = aL.rc; }
            }
        }
        for (double f0 : scanF0)
        {
            std::vector<std::string> row = { num(f0, 0) };
            for (const auto& s : scanSubjects)
            {
                const EResidual& er = bd.eScan[s.id][static_cast<int>(f0)];
                row.push_back(num(er.l.inWindow, 2) + " / " + num(er.l.outsideDev, 2) + "  " + (g3LCell(er.l) ? "P" : "F"));
            }
            tRightF0.add(row);
        }
        const double ideal = bd.ideal["48000"][2500];
        for (const auto& s : scanSubjects)
        {
            const EResidual& er = bd.right[s.id];
            tRight.add({ s.id, s.label, num(remR[s.id].removed, 2), num(remL[s.id].removed, 2), num(remR[s.id].collateral, 2), num(remL[s.id].collateral, 2) });
            int lp = 0, ln = 0;
            for (double f0 : scanF0) { ++ln; if (g3LCell(bd.eScan[s.id][static_cast<int>(f0)].l)) ++lp; }
            const bool rGates = g1Cell(er.r, ideal) && g2Cell(er.r);
            const bool g3 = rGates && lp == ln;
            tRightRes.add({ s.id, s.label, num(er.r.inWindow, 2), num(er.r.outsideDev, 2), num(er.l.inWindow, 2), num(er.l.outsideDev, 2), pf(rGates), cnt(lp, ln), pf(g3) });
            tRightCsv.add({ s.id, num(er.r.inWindow, 4), num(er.r.outsideDev, 4), num(er.l.inWindow, 4), num(er.l.outsideDev, 4), num(ideal, 4), g3 ? "1" : "0",
                            rGates ? "1" : "0", inum(lp), inum(ln) });
        }
    }
    csvTables["right_only"] = tRight; tables.push_back(tRight);
    csvTables["right_only_residual"] = tRightCsv; tables.push_back(tRightRes);
    csvTables["right_only_residual_scan"] = tRightF0Csv; tables.push_back(tRightF0);

    // ---------------------------------------------------------------- detector geometry (10)
    logf("[8b/9] detector geometry (RS HQ baseline read through the existing test hook)");
    {
        const double f0 = 2500.0;
        const int gap = 3;            // default sharpness 50 % -> centerGap = 1 + lround(0.5 * 4) = 3
        const double offsetDb = 9.0;  // default selectivity 50 % -> thresholdOffset = 2 + 0.5 * 14 = 9 dB
        Table tG1; tG1.title = "10a. Detector geometry - levels at the resonance peak bin (signal A vs signal C, f0 = 2500 Hz, 48 kHz)";
        tG1.note = "RS HQ detector front end replicated (sqrt-Hann window, unnormalised real FFT, magDb = 10log10|X|^2) and the BASELINE read through "
                   "XlethResonanceSuppressorEffect::computeDetectorBaselinesForTest (existing hook, enabled by defining XLETH_RESONANCE_SUPPRESSOR_TEST_HOOKS in this tool only). "
                   "Statistics are means over all frames (hop N/4, first 2 s skipped) and both channels at the peak bin k0 = round(f0 N / sr). "
                   "excess = magDb(k0) - baseline(k0), BEFORE the selectivity offset (default 9 dB at selectivity 50 %); 'excess - offset' is what drives salience. "
                   "Signal C = the same pink noise WITHOUT the resonance (the null reference). baseline lift = baseline(A) - baseline(C): how far the resonance's own skirts raise the baseline. "
                   "bell boost = the planted bell's dB gain at the centre of bin k0. P = fraction of frames with excess > offset (detector would start to act).";
        tG1.header = { "quality", "N", "k0", "bell boost at k0", "A mag", "A baseline", "A excess", "A excess - offset", "C mag", "C baseline", "C excess",
                       "baseline lift A-C", "net excess A-C", "P(A excess>offset)", "P(C excess>offset)" };
        Table tG2; tG2.title = "10b. Detector geometry - baseline window (default sharpness: gap +/-3 bins, selectivity offset 9 dB)";
        tG2.note = "radius = clamp(k0/6 + 4, 6, 48) bins (WolaProcessor::detectorRadiusForBin), window = [k0 - radius, k0 + radius] minus |j - k0| <= gap. "
                   "'bell bins' = bins in the baseline window (gap excluded) where the planted bell still boosts the spectrum by >= 1 dB. "
                   "'bell -3 dB width' = f0/Q = 312.5 Hz. 'own vs hook' = max |independently recomputed baseline - hook baseline| over all frames (dB; float prefix-sum error), "
                   "'ref vs prefix' = max |hook slow reference - hook prefix result| (dB).";
        tG2.header = { "quality", "N", "bin Hz", "radius (bins)", "radius (Hz)", "window Hz", "gap (bins / Hz)", "bins used", "bell bins (>=1 dB)", "bell bins %", "bell -3 dB width (bins)",
                       "own vs hook", "ref vs prefix" };
        const char* qn[3] = { "HQ Fast", "HQ Normal", "HQ High" };
        const int Ns[3] = { 512, 1024, 2048 };
        const int skipS = static_cast<int>(kSkipSec * SR);
        for (int qi = 0; qi < 3; ++qi)
        {
            const int N = Ns[qi];
            const double binHz = SR / N;
            const int k0 = static_cast<int>(std::lround(f0 / binHz));
            const auto gA = detectorGeometry(sigA2500, N, k0, gap, offsetDb, skipS);
            const auto gC = detectorGeometry(pinkC,    N, k0, gap, offsetDb, skipS);
            const double bellK0 = bellMagDb(k0 * binHz, SR, f0, 8.0, 12.0);
            tG1.add({ qn[qi], inum(N), inum(k0), num(bellK0, 2), num(gA.mag, 2), num(gA.base, 2), num(gA.excess, 2), num(gA.excess - offsetDb, 2),
                      num(gC.mag, 2), num(gC.base, 2), num(gC.excess, 2), num(gA.base - gC.base, 2), num(gA.excess - gC.excess, 2),
                      num(gA.pTrig, 3), num(gC.pTrig, 3) });

            const int rad = std::clamp(k0 / 6 + 4, 6, 48);
            const int lo = std::max(1, k0 - rad), hi = std::min(N / 2 - 1, k0 + rad);
            int used = 0, bell = 0;
            for (int j = lo; j <= hi; ++j)
            {
                if (std::abs(j - k0) <= gap) continue;
                ++used;
                if (bellMagDb(j * binHz, SR, f0, 8.0, 12.0) >= 1.0) ++bell;
            }
            tG2.add({ qn[qi], inum(N), num(binHz, 2), inum(rad), num(rad * binHz, 0), num(lo * binHz, 0) + " - " + num(hi * binHz, 0),
                      inum(gap) + " / " + num(gap * binHz, 0), inum(used), inum(bell), num(100.0 * bell / std::max(used, 1), 1) + " %",
                      num((f0 / 8.0) / binHz, 1), num(std::max(gA.maxOwnVsHookDiff, gC.maxOwnVsHookDiff), 4),
                      num(std::max(gA.maxRefPrefixDiff, gC.maxRefPrefixDiff), 4) });
            logf("      %s N=%d k0=%d radius=%d bins (%.0f Hz): A mag %.2f baseline %.2f excess %.2f | C baseline %.2f | lift %.2f dB",
                 qn[qi], N, k0, rad, rad * binHz, gA.mag, gA.base, gA.excess, gC.base, gA.base - gC.base);
        }
        csvTables["detector_levels"] = tG1; tables.push_back(tG1);
        csvTables["detector_window"] = tG2; tables.push_back(tG2);
    }

    // ---------------------------------------------------------------- ResonanceCore detector statistics (10c / 10d)
    // Informational. Read through the core's introspection API (last frame's band level / baseline / sigma), run in hop-sized
    // blocks so every block produces exactly one frame. Detection does not depend on Params (the gain computer does).
    {
        namespace rc = xleth::dsp::resonance;
        logf("[8c/9] ResonanceCore detector statistics (baseline lift on Q / level / f0 scans; noise sigma check)");
        struct DetAcc { std::vector<double> sE, sE2, sL, sB, sR; std::vector<float> sigma; std::vector<long long> a4, a2; long long n = 0; std::vector<float> hz; };
        auto runDet = [&](const Stereo& sig) -> DetAcc
        {
            rc::Core core;
            if (g_opt.coreTauMs > 0.0f) core.setDetectorTimeConstantMs(g_opt.coreTauMs);
            core.prepare(SR, 1024, 2);
            const int H = core.hopSize(), B = core.numBands();
            DetAcc d;
            d.sE.assign(static_cast<size_t>(B), 0.0); d.sE2 = d.sE; d.sL = d.sE; d.sB = d.sE; d.sR = d.sE;
            d.a4.assign(static_cast<size_t>(B), 0); d.a2 = d.a4;
            for (int b = 0; b < B; ++b) d.hz.push_back(core.bandHz(b));
            const int skipFrames = static_cast<int>(kSkipSec * SR) / H;
            std::vector<float> l(static_cast<size_t>(H)), r(static_cast<size_t>(H));
            float* ptrs[2] = { l.data(), r.data() };
            rc::Params prm; prm.depth = 1.0f; prm.hardKnee = true;   // C1c settings: only the reduction column depends on them
            for (int pos = 0, f = 0; pos + H <= sig.size(); pos += H, ++f)
            {
                std::memcpy(l.data(), sig.ch[0].data() + pos, sizeof(float) * static_cast<size_t>(H));
                std::memcpy(r.data(), sig.ch[1].data() + pos, sizeof(float) * static_cast<size_t>(H));
                core.process(ptrs, 2, H, prm);
                if (f < skipFrames) continue;
                const float* sg = core.bandSigmaDb();
                for (int c = 0; c < 2; ++c)
                {
                    const float* L = core.bandLevelDb(c);
                    const float* Bs = core.bandBaselineDb(c);
                    for (int b = 0; b < B; ++b)
                    {
                        const double e = static_cast<double>(L[b]) - Bs[b];
                        d.sE[static_cast<size_t>(b)] += e; d.sE2[static_cast<size_t>(b)] += e * e;
                        d.sL[static_cast<size_t>(b)] += L[b]; d.sB[static_cast<size_t>(b)] += Bs[b];
                        d.sR[static_cast<size_t>(b)] += core.bandReductionDb(c)[b];
                        if (e > rc::Core::thresholdSigmas(0.5f) * sg[b]) ++d.a4[static_cast<size_t>(b)];
                        if (e > rc::Core::thresholdSigmas(1.0f) * sg[b]) ++d.a2[static_cast<size_t>(b)];
                    }
                    ++d.n;
                }
            }
            d.sigma.assign(core.bandSigmaDb(), core.bandSigmaDb() + B);
            return d;
        };
        auto nearestBand = [](const DetAcc& d, double f) { int best = 0; for (int b = 1; b < static_cast<int>(d.hz.size()); ++b) if (std::abs(std::log2(d.hz[static_cast<size_t>(b)] / f)) < std::abs(std::log2(d.hz[static_cast<size_t>(best)] / f))) best = b; return best; };
        const DetAcc dc = runDet(pinkC);
        const double nn = static_cast<double>(std::max<long long>(dc.n, 1));

        Table t10c; t10c.title = "10c. ResonanceCore detector - baseline lift by planted shape and f0 (48 kHz, signal A vs clean C, both channels)";
        t10c.note = "Core Params are irrelevant here (detection is parameter-free). Means over all frames after the 2 s skip. 'band' = the grid band nearest f0. "
                    "lift = baseline(A) - baseline(C) at that band, i.e. how far the planted resonance raises its own baseline (design target: ~0 for Q 4..16). "
                    "'max |lift| +/-1/3 oct' = the largest |lift| over the grid bands within f0 +/- 1/3 octave. excess = level - baseline. "
                    "threshold = 4 sigma_E (sensitivity 0.5); P = fraction of frames x channels with excess above it. reduction = mean applied band reduction with the C1c settings (depth 1, Hard).";
        t10c.header = { "case", "f0 Hz", "band Hz", "A level", "A baseline", "A excess", "C excess", "lift A-C", "max |lift| +/-1/3 oct", "sigma_E", "threshold (4 sigma)", "P(A excess > thr)", "P(C excess > thr)", "reduction C1c (dB)" };
        struct DetCase { std::string key; double f0, q, g; };
        const std::vector<DetCase> dcases = { { "Q4/+12", 2500, 4, 12 }, { "Q8/+12", 2500, 8, 12 }, { "Q16/+12", 2500, 16, 12 }, { "Q8/+18", 2500, 8, 18 },
                                              { "Q8/+12", 100, 8, 12 }, { "Q8/+12", 150, 8, 12 }, { "Q8/+12", 220, 8, 12 }, { "Q8/+12", 330, 8, 12 }, { "Q8/+12", 1100, 8, 12 }, { "Q8/+12", 8000, 8, 12 } };
        Table t10cCsv; t10cCsv.header = { "case", "f0_hz", "band_hz", "a_level_db", "a_baseline_db", "a_excess_db", "c_excess_db", "lift_db", "max_abs_lift_db", "sigma_e_db", "thr_db", "p_a_above", "p_c_above", "reduction_c1c_db" };
        for (const auto& cs : dcases)
        {
            const DetAcc da = runDet(makeResonant(pinkC, SR, cs.f0, true, true, cs.q, cs.g));
            const double na = static_cast<double>(std::max<long long>(da.n, 1));
            const int b = nearestBand(da, cs.f0);
            const auto bi = static_cast<size_t>(b);
            const double lift = (da.sB[bi] / na) - (dc.sB[bi] / nn);
            double maxLift = 0.0;
            const double s3 = std::pow(2.0, 1.0 / 3.0);
            for (size_t j = 0; j < da.hz.size(); ++j)
                if (da.hz[j] >= cs.f0 / s3 && da.hz[j] <= cs.f0 * s3) maxLift = std::max(maxLift, std::abs(da.sB[j] / na - dc.sB[j] / nn));
            const double thr = rc::Core::thresholdSigmas(0.5f) * da.sigma[bi];
            std::vector<std::string> row = { cs.key, num(cs.f0, 0), num(da.hz[bi], 0), num(da.sL[bi] / na, 2), num(da.sB[bi] / na, 2), num(da.sE[bi] / na, 2),
                                             num(dc.sE[bi] / nn, 2), num(lift, 2), num(maxLift, 2), num(da.sigma[bi], 2), num(thr, 2),
                                             num(static_cast<double>(da.a4[bi]) / na, 4), num(static_cast<double>(dc.a4[bi]) / nn, 4), num(da.sR[bi] / na, 2) };
            t10c.add(row); t10cCsv.add(row);
            logf("      core %-7s f0 %5.0f band %6.0f Hz: excess %.2f dB (C %.2f) lift %+.2f dB (max |lift| %.2f) sigma_E %.2f thr %.2f P %.3f red(C1c) %.2f",
                 cs.key.c_str(), cs.f0, da.hz[bi], da.sE[bi] / na, dc.sE[bi] / nn, lift, maxLift, da.sigma[bi], thr, static_cast<double>(da.a4[bi]) / na, da.sR[bi] / na);
        }
        csvTables["core_detector_lift"] = t10cCsv; tables.push_back(t10c);

        Table t10d; t10d.title = "10d. ResonanceCore detector - noise statistics on clean pink C (48 kHz): predicted vs measured sigma of the excess";
        t10d.note = "sigma_E (predicted) is what the threshold is built from: the std-dev of excess = level - baseline for a noise-like input, derived from the window's frame/bin correlations, "
                    "the recursive-average weights, the band weights and the flank median (log-Gamma statistics). 'measured' = std-dev over frames of the actual excess. "
                    "bias = mean excess (ideal 0). P(>4 sigma) / P(>2 sigma) = measured exceedance at sensitivity 0.5 / 1.0 (Gaussian reference 3.2e-5 / 2.3e-2). Band means per region.";
        t10d.header = { "region", "bands", "sigma_E predicted (dB)", "std(excess) measured (dB)", "measured / predicted", "bias (dB)", "P(> 4 sigma)", "P(> 2 sigma)" };
        const std::vector<std::pair<double, double>> regions = { { 20, 200 }, { 200, 1000 }, { 1000, 5000 }, { 5000, 20001 } };
        for (const auto& rg : regions)
        {
            double sp = 0, sm = 0, sb = 0, p4 = 0, p2 = 0; int nbnd = 0;
            for (size_t j = 0; j < dc.hz.size(); ++j)
            {
                if (dc.hz[j] < rg.first || dc.hz[j] >= rg.second) continue;
                const double mean = dc.sE[j] / nn;
                sp += dc.sigma[j];
                sm += std::sqrt(std::max(dc.sE2[j] / nn - mean * mean, 0.0));
                sb += mean;
                p4 += static_cast<double>(dc.a4[j]) / nn; p2 += static_cast<double>(dc.a2[j]) / nn;
                ++nbnd;
            }
            if (nbnd == 0) continue;
            t10d.add({ num(rg.first, 0) + "-" + num(std::min(rg.second, 20000.0), 0) + " Hz", inum(nbnd), num(sp / nbnd, 3), num(sm / nbnd, 3), num(sm / sp, 3),
                       num(sb / nbnd, 3), num(p4 / nbnd, 5), num(p2 / nbnd, 4) });
            logf("      core noise %5.0f-%5.0f Hz (%2d bands): sigma_E pred %.3f meas %.3f (x%.2f) bias %+.3f P>4s %.5f P>2s %.4f",
                 rg.first, std::min(rg.second, 20000.0), nbnd, sp / nbnd, sm / nbnd, sm / sp, sb / nbnd, p4 / nbnd, p2 / nbnd);
        }
        csvTables["core_detector_noise"] = t10d; tables.push_back(t10d);
    }

    // ---------------------------------------------------------------- time-varying resonance T1 (v5): reaction + release
    logf("[8d/9] time-varying resonance T1 (f0 {500, 2500, 8000} Hz x D {100, 300, 1000} ms, %d events each, 5 ms crossfades)", kTvEvents);
    Table tTv; tTv.title = "11. Time-varying resonance (signal T1, 48 kHz) - reaction (G8a / G8b) and release (G9a / G9b)";
    tTv.note = "Pink noise -20 dBFS RMS (seed of signal A); the +12 dB / Q 8 bell at f0 is switched ON and OFF by 5 ms linear crossfades between the clean noise C and the bell-filtered noise A built from the same noise "
               "(the clean reference is exact), 6 events per case, on-duration D, >= 1.5 s off between events, first onset at 2 s (D = 1000 ms: 16.8 s signal instead of 14 s, see the T1 comment in the tool). "
               "STFT 1024 Hann hop 128, window f0 +/- 1/6 oct, latency-aligned output, events aligned at their onsets (frame centres at onset + k x 128), energies = event means, 10 ms boxcar. "
               "r = dB(E_out / E_clean), r_pass the same for the un-suppressed input; p = 1 - r / r_pass in [0, 1.2] during the on-time (p := 0 while r_pass < 1 dB). "
               "t50 / t90 = first time since the onset with p >= 0.5 / 0.9 (never = not reached within D = FAIL). leak = sum of positive (E_out - E_clean) / sum (E_pass - E_clean) over the event (1 = nothing suppressed). "
               "r_pass peak / r peak = the largest event-mean r_pass / r during the on-time (dB). Gates: G8a t50 <= 100 ms and G8b leak <= 0.5 (D = 300) / 0.3 (D = 1000) for D = 300 and 1000 only; "
               "G9a |r_off(500)| <= 1.0 dB and G9b |r_off(1000)| <= 0.5 dB at every case. D = 100 ms: t50 / leak are informational ('-' in the G8 columns). Verdict letters P / F. "
               "r_off(T) = dB(E_out / E_clean), both averaged over [offset + T - 10 ms, offset + T + 10 ms] and over the events (event-mean ratio, same convention as r(t)); negative = the output is still below the clean noise. "
               "tau_fit = informational effective release time constant: exponential fit of the cut -r_off(T) over T = 50..500 ms (every 25 ms; earlier samples still contain on-time resonance), 'n/a' when the cut at T = 50 ms is < 1 dB, '>5000' when it does not decay (plateau).";
    tTv.note += " Columns marked (info) are informational, NOT gates: over = per-event minimum of dB(E_out / E_clean) (20 ms smoothing) within 500 ms after the offset, averaged over events (the depth of the cut reached); "
                "settle = time after the offset until |r| stays <= 1 dB (never = still outside after 1 s); 'r off 0.5-1s' = mean r 0.5-1.0 s after the offset (steady-state deviation from the clean noise; a subject that "
                "permanently cuts the clean noise can never settle, so settle = never with a large |r off| is an offset, not a slow release); r_off(0 / 100 / 250) = the decay curve.";
    tTv.header = { "subject", "f0 Hz", "D ms", "r_pass peak dB", "r peak dB", "t50 ms", "t90 ms", "leak", "over dB (info)", "settle ms (info)", "r off 0.5-1s dB (info)",
                   "r_off(0) dB (info)", "r_off(100) dB (info)", "r_off(250) dB (info)", "r_off(500) dB [G9a]", "r_off(1000) dB [G9b]", "tau_fit ms (info)", "G8a", "G8b", "G9a", "G9b" };
    {
        const double tvSr = SR;
        for (double f0 : kTvF0)
            for (int durMs : kTvDurMs)
            {
                TvCase tc = makeTvCase(f0, durMs, tvSr);
                int kMin = 0, kMax = 0; tvFrameRange(durMs, tvSr, kMin, kMax);
                const auto eClean = tvWindowEnergy(tc.clean, tc.events, kMin, kMax, tvSr, f0);
                const auto ePass  = tvWindowEnergy(tc.sig,   tc.events, kMin, kMax, tvSr, f0);
                Planted pl; pl.f0 = f0; pl.left = true; pl.right = true; pl.cleanRef = &tc.clean;
                for (const auto& ev : tc.events) pl.events.emplace_back(ev.onset, ev.offset);
                const bool wavCase = (f0 == 2500.0 && durMs == 300);
                if (wavCase)
                {
                    writeWav(wavDir / "T1_f2500_D300_in.wav", tc.sig, tvSr);
                    writeWav(wavDir / "T1_f2500_D300_clean.wav", tc.clean, tvSr);
                }
                for (const auto& s : scanSubjects)
                {
                    Fx fx = makeFx(s, tvSr, f0, false, kPrepareBlock, &pl);
                    const Stereo out = renderStd(fx, tc.sig);
                    const auto a = align(tc.sig, out, measureLatency(s, tvSr).measured, tvSr);
                    const auto eOut = tvWindowEnergy(a.out, tc.events, kMin, kMax, tvSr, f0);
                    const TvMetrics m = tvAnalyse(eOut, eClean, ePass, durMs, kMin, tvSr);
                    if (!m.roffOk) warnf("T1: an r_off interval fell outside the analysed frames (subject %s, f0 %.0f, D %d)", s.id.c_str(), f0, durMs);
                    bd.tv[s.id][{ static_cast<int>(f0), durMs }] = m;
                    if (wavCase) writeWav(wavDir / ("T1_f2500_D300_" + s.id + "_out.wav"), a.out, tvSr);
                }
            }
        for (const auto& s : scanSubjects)
            for (double f0 : kTvF0)
                for (int durMs : kTvDurMs)
                {
                    const TvMetrics& m = bd.tv[s.id][{ static_cast<int>(f0), durMs }];
                    const bool gr = g8Graded(durMs);
                    tTv.add({ s.id, num(f0, 0), inum(durMs), num(m.rPassPeak, 2), num(m.rPeak, 2), tvMs(m.t50), tvMs(m.t90), num(m.leak, 3), num(m.over, 2), tvMs(m.settle), num(m.rOff, 2),
                              num(m.rOffCurve.empty() ? 0.0 : m.rOffCurve.front(), 2), num(m.rOff100, 2), num(m.rOff250, 2), num(m.rOff500, 2), num(m.rOff1000, 2), tvTau(m.tauFit),
                              gr ? pf(g8aCell(m)).substr(0, 1) : "-", gr ? pf(g8bCell(m, durMs)).substr(0, 1) : "-", pf(g9aCell(m)).substr(0, 1), pf(g9bCell(m)).substr(0, 1) });
                }
        csvTables["time_varying"] = tTv; tables.push_back(tTv);
        for (const auto& s : scanSubjects)
        {
            if (!s.gated) continue;
            for (double f0 : kTvF0)
                for (int durMs : kTvDurMs)
                {
                    const TvMetrics& m = bd.tv[s.id][{ static_cast<int>(f0), durMs }];
                    logf("      T1 %-4s f0 %4.0f D %4d: t50 %6s t90 %6s leak %5.3f | r_off(500) %6.2f r_off(1000) %6.2f tau_fit %6s | info: over %6.2f settle %6s r_off(0/100/250) %.2f/%.2f/%.2f r off(0.5-1s) %.2f (r_pass peak %.2f, r peak %.2f) | G8a %s G8b %s G9a %s G9b %s",
                         s.id.c_str(), f0, durMs, tvMs(m.t50).c_str(), tvMs(m.t90).c_str(), m.leak, m.rOff500, m.rOff1000, tvTau(m.tauFit).c_str(), m.over, tvMs(m.settle).c_str(),
                         m.rOffCurve.empty() ? 0.0 : m.rOffCurve.front(), m.rOff100, m.rOff250, m.rOff, m.rPassPeak, m.rPeak,
                         g8Graded(durMs) ? (g8aCell(m) ? "P" : "F") : "-", g8Graded(durMs) ? (g8bCell(m, durMs) ? "P" : "F") : "-", g9aCell(m) ? "P" : "F", g9bCell(m) ? "P" : "F");
                }
        }
    }

    // ---------------------------------------------------------------- CPU (9)
    Table tCpu; tCpu.title = "9. CPU (48 kHz stereo)";
    tCpu.header = { "subject", "label", "block", "median ns", "p95 ns", "p99 ns", "max ns", "mean ns", "median % RT", "p95 % RT", "mean % RT", "max % RT" };
    Table tCpuProj, tCpuRatio;
    if (g_opt.noCpu)
    {
        logf("[9/9] CPU skipped (--no-cpu)");
        tCpu.note = "SKIPPED (--no-cpu).";
    }
    else
    {
        logf("[9/9] CPU (%d reps x %.0f s per subject/block; this takes a while)", cpuReps(), cpuSeconds());
        tCpu.note = "Build: " + cfg + ". CPU: " + cpu + ". " + inum(cpuReps()) + " repetitions of " + num(cpuSeconds(), 0) +
                    " s stereo pink noise (-20 dBFS, no resonance), fresh instance per repetition, first 1 s of each repetition untimed (warm-up), "
                    "per-block wall time of processBlock() via steady_clock (copy-in excluded), pooled over all repetitions. % RT = ns / (block/48000 s). "
                    "NOTE: the STFT paths do their FFT work once per hop, so the median block is usually a cheap one; median/p95 under-state the load. "
                    "mean = amortised cost per block (the sustained CPU load); p99/max = the worst-case blocks the audio deadline actually sees. "
                    "S5 band at 2500 Hz, -12 dB. Single thread, normal priority; no isolation from other processes." + (isRelease ? "" : " **NOT A RELEASE BUILD**");
        const Stereo cpuSig = makePinkStereo(static_cast<int>((cpuSeconds() + 1.0) * SR), -20.0, 3);
        const auto cpuRows = runCpuRows(primary, { 64, 128, 512 }, SR, cpuSig);
        fillCpuTable(tCpu, cpuRows);
        tCpuProj = cpuProjectionTable(cpuRows, cpu);
        logCpuProjection(cpuRows, cpu);

        // G7: the gated variants that are not default-parameter subjects (S1c..S5c, S5q, S5qd, references) get their own CPU run at
        // blocks 64 and 128 so they can be compared with S3 in the SAME run. Table 9 / 9b stay on the five default subjects.
        std::vector<Subject> extra;
        for (const auto& sc : scanSubjects)
        {
            if (!sc.gated) continue;
            bool isPrimary = false;
            for (const auto& ps : primary) if (ps.id == sc.id) isPrimary = true;
            if (!isPrimary) extra.push_back(sc);
        }
        logf("      G7: CPU for %zu gated variants at blocks 64 / 128 (compared with %s in this run)", extra.size(), kG7RefId);
        auto allRows = cpuRows;
        const auto extraRows = runCpuRows(extra, { 64, 128 }, SR, cpuSig);
        allRows.insert(allRows.end(), extraRows.begin(), extraRows.end());
        bd.cpuRatio = cpuRatios(allRows);
        tCpuRatio = cpuRatioTable(allRows, bd.cpuRatio);
        for (const auto& r : tCpuRatio.rows)
            logf("G7 ratio vs %s (same run)  %-4s @64: %s  @128: %s  -> %s", kG7RefId, r[0].c_str(), r[3].c_str(), r[5].c_str(), r[6].c_str());
    }
    csvTables["cpu"] = tCpu; tables.push_back(tCpu);
    if (!tCpuProj.rows.empty()) { csvTables["cpu_projection"] = tCpuProj; tables.push_back(tCpuProj); }
    if (!tCpuRatio.rows.empty()) { csvTables["cpu_g7_ratio"] = tCpuRatio; tables.push_back(tCpuRatio); }

    // ---------------------------------------------------------------- --wav inputs (G)
    Table tWav; tWav.title = "G. --wav inputs: depth-0 null";
    tWav.note = "Each file is run at its own sample rate through every default-parameter subject and every gated capability variant (own config, S5 band 2500 Hz / -12 dB); "
                "aligned out and delta WAVs are in wav/. "
                "Only metric: latency-aligned null depth at depth 0 (RS depth 0, EQ band gain 0 dB): RMS(out - in) dBFS, first min(2 s, 25 %) skipped.";
    tWav.header = { "label", "subject", "sr", "latency", "null depth 0 (dBFS)" };
    std::vector<Subject> wavSubjects = primary;   // listening material: defaults + the gated capability variants (C1c, S1c, S3c, ...)
    for (const auto& s : capability) if (s.gated && !s.reference) wavSubjects.push_back(s);
    Table tProxy; tProxy.title = "G2. --wav inputs: real-material proxy metrics (informational, no gates)";
    tProxy.note = "Each file at its own sample rate through the listed subjects at their own configuration (C1 default params; C1c / C1c-H capability; S1c / S3c RS capability). "
                  "STFT 1024 Hann hop 256 of the latency-aligned input and output (first min(2 s, 25 %) skipped), 1/6-octave bands 100 Hz-12 kHz (as the jitter metric), "
                  "G(t,b) = 10log10(E_out / E_in) per band and cut = -G (positive = reduction). mean cut / p95 cut = mean / 95th percentile of the cut over every (frame, band, channel) cell (dB); "
                  "flicker = mean |G(t,b) - G(t-1,b)| over bands, frames and channels (dB; the frame-to-frame change of the applied gain); "
                  "frames > 6 dB = fraction of (frame, channel) pairs in which ANY band is cut by more than 6 dB. No threshold is attached to any of these numbers.";
    tProxy.header = { "label", "subject", "sr", "frames", "bands", "mean cut (dB)", "p95 cut (dB)", "flicker (dB)", "frames with a band cut > 6 dB" };
    const std::vector<std::string> proxyIds = { "C1", "C1c", "C1c-H", "S1c", "S3c" };
    for (const auto& w : g_opt.wavs)
    {
        Stereo in; double sr = 0;
        if (!readWav(w.second, in, sr)) { warnf("cannot read WAV %s", w.second.c_str()); continue; }
        logf("--wav %s: %d samples @%.0f Hz", w.first.c_str(), in.size(), sr);
        for (const auto& s : wavSubjects)
        {
            const int L = measureLatency(s, sr).measured;
            {
                Fx fx = makeFx(s, sr, 2500.0, false, kPrepareBlock);
                const Stereo out = renderStd(fx, in);
                const auto a = align(in, out, L, sr);
                writeWav(wavDir / (w.first + "_" + s.id + "_out.wav"),   a.out, sr);
                writeWav(wavDir / (w.first + "_" + s.id + "_delta.wav"), deltaOf(a), sr);
                if (std::find(proxyIds.begin(), proxyIds.end(), s.id) != proxyIds.end())
                {
                    const ProxyStats ps = realMaterialProxy(a, sr);
                    tProxy.add({ w.first, s.id, num(sr, 0), inum(ps.frames), inum(ps.bands), num(ps.meanCut, 3), num(ps.p95Cut, 3), num(ps.flicker, 3), num(100.0 * ps.fracOver6, 2) + " %" });
                    logf("      proxy %-6s %-6s mean cut %.3f dB  p95 %.3f dB  flicker %.3f dB  frames with a band > 6 dB: %.2f %%", w.first.c_str(), s.id.c_str(), ps.meanCut, ps.p95Cut, ps.flicker, 100.0 * ps.fracOver6);
                }
            }
            Fx fx0 = makeFx(s, sr, 2500.0, true, kPrepareBlock);
            const Stereo out0 = renderStd(fx0, in);
            const auto a0 = align(in, out0, L, sr);
            tWav.add({ w.first, s.id, num(sr, 0), inum(L), num(rmsDiffDbfs(a0), 2) });
        }
    }
    if (!g_opt.wavs.empty()) { csvTables["wav_null"] = tWav; tables.push_back(tWav); }
    if (!tProxy.rows.empty()) { csvTables["wav_proxy"] = tProxy; tables.push_back(tProxy); }

    // ---------------------------------------------------------------- gate table (v3)
    std::vector<GateRow> gateRows;
    for (const auto& s : scanSubjects) if (s.gated) gateRows.push_back(evaluateGates(s, bd));
    if (cap)
    {
        cap->bd = bd;
        cap->rows = gateRows;
        cap->subjects.clear();
        for (const auto& s : scanSubjects) if (s.gated) cap->subjects.push_back(s);
        cap->runDir = runDir.generic_string();
    }

    Table tGate; tGate.title = "Gate table (capability variants, fixed thresholds)";
    tGate.note = "Every subject registered with gated = true is graded at its own variant. G1: in-window residual vs clean within [-1.5 dB, 0.30 x ideal dB] at EVERY one of the 12 scan f0 (48 kHz; count = f0 passing). "
                 "G2: outside deviation <= 0.5 dB at every f0 (count). G1q/G2q: the same two tests on the Q scan (Q 4 / 8 / 16 at +12 dB, f0 2500 Hz; count of 3 cases, ideal recomputed per case). "
                 "G1l/G2l: the same on the level scan (+12 / +18 dB at Q 8, f0 2500 Hz; count of 2 cases). "
                 "G3: resonance in R only (signal E): R gates at 2500 Hz (G1 + G2 on R) AND the untouched L channel at every one of the 12 scan f0 (|L in_window| <= 1.0 dB and L outside_dev <= 0.5 dB; count of 12). "
                 "G4: sensitive-variant jitter (signal C, subject's registered sensitive variant): std all <= 0.6 dB AND isolated-cell fraction all <= 1e-3. "
                 "G5: pre-echo with the mask engaged (D2): broadband E_out/E_in <= +1.0 dB AND band (f0 +/- 1/3 oct) E_out/E_in <= +1.0 dB. "
                 "G6: latency measured == reported at 48 and 44.1 kHz and unchanged across block schedules. "
                 "G7: mean % RT divided by S3's mean % RT in the same run <= 1.05 at block 128 AND block 64 (kG7CpuRatio; the UNROUNDED ratios are compared, strictly, with no tolerance; cell shows ratio @128 / @64 to 4 decimals; 'n/a' with --no-cpu). "
                 "Subjects marked 'link-100 characterisation' (RSC-F / RSC-N / RSC-H, RS default stereo link 100 %) print G3 and G9a but those two gates are not graded for them; RSC-F0 / RSC-N0 / RSC-H0 (link 0, open curve) are graded on every gate. "
                 "G8a: time-varying resonance T1 (table 11), reaction: t50 <= 100 ms for D = 300 and 1000 ms at every f0 (count of 6; 'never' fails). "
                 "G8b: leak_fraction <= 0.5 (D = 300) / <= 0.3 (D = 1000) at every f0 (count of 6). "
                 "G9a: release, the cut is gone 500 ms after the offset: |r_off(500)| <= 1.0 dB at every (f0, D) (count of 9). G9b: |r_off(1000)| <= 0.5 dB at every (f0, D) (count of 9). "
                 "(r_off(T) = dB(E_out / E_clean) in the f0 +/- 1/6 oct window averaged over offset + T +/- 10 ms; see table 11. over_dB, settle_ms, r_off(0 / 100 / 250) and tau_fit are informational, not gates.) "
                 "Overall = every column passes, G8a / G8b / G9a / G9b included (G7 left out of the verdict when n/a). "
                 "Thresholds are the constants kG1..kG9 in the tool; they are not tuned per subject.";
    tGate.header = { "subject", "label", "G1 in-window", "G2 outside-dev", "G1q Q-scan", "G2q Q-scan", "G1l level-scan", "G2l level-scan", "G3 R-only", "G4 jitter", "G5 pre-echo D2", "G6 latency", "G7 CPU vs S3",
                     "G8a t50", "G8b leak", "G9a r_off500", "G9b r_off1000", "overall" };
    Table tGateDetail; tGateDetail.title = "Gate details (raw values behind the gate table)";
    tGateDetail.note = "G1/G2 counts also at 44.1 kHz (informational, not part of the gate). G3: R gates at 2500 Hz, L gate f0 passing out of 12 (per-f0 values in table 8c), and the 2500 Hz R/L in-window and outside-dev (dB). "
                       "G4: std all (dB) / isolated all, measured on the named sensitive variant. G5: broadband / band E_out vs E_in (dB) on D2. G6: measured/reported per rate. G7: CPU ratio vs S3 at block 128 / 64. "
                       "tau_fit (informational, not a gate): median over the T1 cases of the effective release time constant (exponential fit of the cut -r_off(T), T = 50..500 ms); cases with a cut < 1 dB at T = 50 ms are n/a, "
                       "cases whose cut does not decay are '>5000'.";
    tGateDetail.header = { "subject", "G1 @44.1k (info)", "G2 @44.1k (info)", "G3 R gates", "G3 L gate (f0 of 12)", "G3 R in-window", "G3 R outside-dev", "G3 L in-window", "G3 L outside-dev",
                           "G4 variant", "G4 std all", "G4 isolated all", "G5 broadband", "G5 band", "G6 latency", "G7 ratio @128", "G7 ratio @64", "tau_fit median (info)" };
    Table tGateCsv;
    tGateCsv.header = { "subject", "label", "g1_pass_f0", "g1_total_f0", "g1", "g2_pass_f0", "g2_total_f0", "g2", "g3_r_in_window_db", "g3_r_outside_dev_db", "g3_l_outside_dev_db", "g3",
                        "g4_variant", "g4_std_all_db", "g4_isolated_all", "g4", "g5_broadband_db", "g5_band_db", "g5", "g6_detail", "g6", "overall",
                        "info_g1_pass_f0_44k", "info_g2_pass_f0_44k", "info_total_f0_44k",
                        "g1q_pass_cases", "g1q_total_cases", "g1q", "g2q_pass_cases", "g2q", "g1l_pass_cases", "g1l_total_cases", "g1l", "g2l_pass_cases", "g2l",
                        "g3_r_gates", "g3_l_pass_f0", "g3_l_total_f0", "g3_l_in_window_db", "g7_ratio_128", "g7_ratio_64", "g7",
                        "g8a_pass_cases", "g8a_total_cases", "g8a", "g8b_pass_cases", "g8b", "g9a_pass_cases", "g9a_total_cases", "g9a", "g9b_pass_cases", "g9b",
                        // hardening: the columns above are RAW (g1 and overall do not apply any waiver); these state the waiver and the waived verdict.
                        "g1_waived_cells", "known_limit", "verdict" };
    int nOverall = 0;
    for (size_t gi = 0; gi < gateRows.size(); ++gi)
    {
        const auto& g = gateRows[gi];
        const bool isRef = [&] { for (const auto& rs : scanSubjects) if (rs.id == g.id) return rs.reference; return false; }();
        if (g.overall() && !isRef) ++nOverall;
        const char* kCharTag = " [link-100 characterisation, not graded]";
        const std::string g3cell = (g.g3valid ? pf(g.g3) + " (R " + (g.g3R ? "P" : "F") + ", L " + cnt(g.g3Lpass, g.g3Ln) + ")" : "FAIL (no data)") + (g.ungraded("G3") ? kCharTag : "");
        const std::string g9acell = pf(g.pass9a()) + " " + cnt(g.g9a, g.n9a) + (g.ungraded("G9a") ? kCharTag : "");
        // G7 is shown with 4 decimals: the gate compares the UNROUNDED ratio with kG7CpuRatio = 1.05 (no further tolerance), so a cell that reads "1.05" at two decimals can be 1.053 (FAIL) or 1.046 (PASS).
        const std::string g7cell = g.g7valid ? pf(g.g7) + " " + num(g.g7r128, 4) + " / " + num(g.g7r64, 4) : "n/a";
        const std::string g1cell = pf(g.pass1()) + " " + cnt(g.g1, g.n) + (g.g1Waived > 0 ? " (raw; +" + inum(g.g1Waived) + " WAIVED, known limit)" : std::string());
        tGate.add({ g.id, g.label, g1cell, pf(g.pass2()) + " " + cnt(g.g2, g.n),
                    pf(g.pass1q()) + " " + cnt(g.g1q, g.nq), pf(g.pass2q()) + " " + cnt(g.g2q, g.nq), pf(g.pass1l()) + " " + cnt(g.g1l, g.nl), pf(g.pass2l()) + " " + cnt(g.g2l, g.nl),
                    g3cell, g.g4valid ? pf(g.g4) : "FAIL (no data)", g.g5valid ? pf(g.g5) : "FAIL (no data)", pf(g.g6), g7cell,
                    pf(g.pass8a()) + " " + cnt(g.g8a, g.n8a), pf(g.pass8b()) + " " + cnt(g.g8b, g.n8b), g9acell, pf(g.pass9b()) + " " + cnt(g.g9b, g.n9b),
                    g.verdict() + (g.g7valid ? "" : " (G7 n/a)") });
        tGateDetail.add({ g.id, cnt(g.g1_44, g.n44), cnt(g.g2_44, g.n44), pf(g.g3R), cnt(g.g3Lpass, g.g3Ln), num(g.g3RRes, 2), num(g.g3RDev, 2), num(g.g3LRes, 2), num(g.g3LDev, 2),
                          g.g4Id, num(g.g4Std, 3), num(g.g4Iso, 6), num(g.g5Bb, 3), num(g.g5Band, 3), g.g6detail,
                          g.g7valid ? num(g.g7r128, 4) : "n/a", g.g7valid ? num(g.g7r64, 4) : "n/a", g.tauSummary });
        tGateCsv.add({ g.id, g.label, inum(g.g1), inum(g.n), pf(g.pass1()), inum(g.g2), inum(g.n), pf(g.pass2()), num(g.g3RRes, 4), num(g.g3RDev, 4), num(g.g3LDev, 4), pf(g.g3),
                       g.g4Id, num(g.g4Std, 4), num(g.g4Iso, 6), pf(g.g4), num(g.g5Bb, 4), num(g.g5Band, 4), pf(g.g5), g.g6detail, pf(g.g6), pf(g.overall()),
                       inum(g.g1_44), inum(g.g2_44), inum(g.n44),
                       inum(g.g1q), inum(g.nq), pf(g.pass1q()), inum(g.g2q), pf(g.pass2q()), inum(g.g1l), inum(g.nl), pf(g.pass1l()), inum(g.g2l), pf(g.pass2l()),
                       pf(g.g3R), inum(g.g3Lpass), inum(g.g3Ln), num(g.g3LRes, 4),
                       g.g7valid ? num(g.g7r128, 4) : "n/a", g.g7valid ? num(g.g7r64, 4) : "n/a", g.g7valid ? pf(g.g7) : "n/a",
                       inum(g.g8a), inum(g.n8a), pf(g.pass8a()), inum(g.g8b), pf(g.pass8b()), inum(g.g9a), inum(g.n9a), pf(g.pass9a()), inum(g.g9b), pf(g.pass9b()),
                       inum(g.g1Waived), g.waivers.empty() ? std::string("none") : [&] { std::string w; for (const auto& x : g.waivers) w += (w.empty() ? "" : " | ") + x; for (char& ch : w) if (ch == ',') ch = ';'; return w; }(),
                       g.verdict() + (g.g7valid ? "" : " (G7 n/a)") });
    }
    // Per-f0 breakdown at 48 kHz: "in_window / outside_dev" and the two per-cell verdicts (G1 G2).
    Table tGateF0; tGateF0.title = "Gate details per f0 (48 kHz): in_window / outside_dev (dB), then G1 G2 verdict letters (P = pass, F = fail)";
    tGateF0.note = "ideal and the G1 upper limit (0.30 x ideal) per f0 are in the first columns; G1 also requires in_window >= -1.5.";
    tGateF0.header = { "f0 Hz", "ideal dB", "G1 max" };
    for (const auto& g : gateRows) tGateF0.header.push_back(g.id);
    for (double f0 : scanF0)
    {
        const double ideal = bd.ideal["48000"][static_cast<int>(f0)];
        std::vector<std::string> row = { num(f0, 0), num(ideal, 2), num(kG1ResIdealFrac * ideal, 2) };
        for (const auto& g : gateRows)
        {
            const auto it = bd.residual.find(g.id + "@48000");
            if (it == bd.residual.end()) { row.push_back("n/a"); continue; }
            const Residual& r = it->second.at(static_cast<int>(f0));
            row.push_back(num(r.inWindow, 2) + " / " + num(r.outsideDev, 2) + "  " + (g1Cell(r, ideal) ? "P" : "F") + (g2Cell(r) ? "P" : "F"));
        }
        tGateF0.add(row);
    }
    csvTables["gates"] = tGateCsv;

    logf("---- GATE TABLE (G1/G2/G3-L counts are f0 passing out of %zu; q = 3 Q cases, l = 2 level cases) ----", scanF0.size());
    for (const auto& g : gateRows)
    {
        logf("%-4s G1 %-4s %5s | G2 %-4s %5s | G1q %-4s %3s | G2q %-4s %3s | G1l %-4s %3s | G2l %-4s %3s | G3 %-4s (R %s, L %s) | G4 %-4s | G5 %-4s | G6 %-4s | G7 %s | G8a %-4s %3s | G8b %-4s %3s | G9a %-4s %3s | G9b %-4s %3s | overall %s | tau_fit(info) %s",
             g.id.c_str(), pf(g.pass1()).c_str(), cnt(g.g1, g.n).c_str(), pf(g.pass2()).c_str(), cnt(g.g2, g.n).c_str(),
             pf(g.pass1q()).c_str(), cnt(g.g1q, g.nq).c_str(), pf(g.pass2q()).c_str(), cnt(g.g2q, g.nq).c_str(),
             pf(g.pass1l()).c_str(), cnt(g.g1l, g.nl).c_str(), pf(g.pass2l()).c_str(), cnt(g.g2l, g.nl).c_str(),
             (pf(g.g3) + (g.ungraded("G3") ? "*" : "")).c_str(), g.g3R ? "P" : "F", cnt(g.g3Lpass, g.g3Ln).c_str(), pf(g.g4).c_str(), pf(g.g5).c_str(), pf(g.g6).c_str(),
             g.g7valid ? (pf(g.g7) + " " + num(g.g7r128, 4) + "/" + num(g.g7r64, 4)).c_str() : "n/a",
             pf(g.pass8a()).c_str(), cnt(g.g8a, g.n8a).c_str(), pf(g.pass8b()).c_str(), cnt(g.g8b, g.n8b).c_str(),
             (pf(g.pass9a()) + (g.ungraded("G9a") ? "*" : "")).c_str(), cnt(g.g9a, g.n9a).c_str(), pf(g.pass9b()).c_str(), cnt(g.g9b, g.n9b).c_str(), g.verdict().c_str(), g.tauSummary.c_str());
    }
    for (const auto& g : gateRows)
        if (!g.notGraded.empty())
        {
            logf("* %s: link-100 characterisation, not graded: G3 and G9a are printed for this subject but left out of its verdict (RS default stereo link 100 %%: a one-channel resonance is cut on both channels by definition; the link lengthens the release). Graded counterpart: %sF0/N0/H0 against C1c-F/N/H.", g.id.c_str(), "RSC-");
            break;
        }
    for (const auto& g : gateRows)
        for (const auto& w : g.waivers)
            logf("KNOWN LIMIT (waived): %s  [raw G1 stays %s]", w.c_str(), cnt(g.g1, g.n).c_str());

    // G7 definition, verbatim from the constants above (nothing is changed, this only prints what is graded).
    logf("G7 definition: ratio = subject mean processBlock ns / %s mean ns, same run, same block size; PASS iff ratio(@128) <= %.4f AND ratio(@64) <= %.4f (kG7CpuRatio, strict comparison of the UNROUNDED ratios, no tolerance). Cells print @128 / @64 to 4 decimals.",
         kG7RefId, kG7CpuRatio, kG7CpuRatio);

    // RSC-* vs C1c-* at the named G1 cell (100 Hz): raw residual next to the C1c value and the waiver status. Printed only for pairs that were both run.
    std::string rsc100Md;
    {
        struct Pair { const char* rsc; const char* c1c; };
        const Pair pairs[] = { { "RSC-F", "C1c-F" }, { "RSC-F0", "C1c-F" }, { "RSC-N", "C1c-N" }, { "RSC-N0", "C1c-N" }, { "RSC-H", "C1c-H" }, { "RSC-H0", "C1c-H" } };
        auto cellOf = [&](const char* id, double& raw, bool& waived, bool& inList) -> bool
        {
            const auto it = bd.residual.find(std::string(id) + "@48000");
            const auto ideal = bd.ideal.find("48000");
            if (it == bd.residual.end() || ideal == bd.ideal.end() || it->second.find(100) == it->second.end()) return false;
            raw = it->second.at(100).inWindow;
            const bool pass = g1Cell(it->second.at(100), ideal->second.at(100));
            inList = false;
            for (const auto& kl : knownLimits())
                if (std::string(kl.gate) == "G1" && kl.f0 == 100 && std::find(kl.subjects.begin(), kl.subjects.end(), std::string(id)) != kl.subjects.end()) inList = true;
            waived = !pass && inList;
            return true;
        };
        auto status = [](bool pass, bool waived, bool inList) { return pass ? std::string("passes (no waiver needed)") : waived ? std::string("FAILS raw, WAIVED (named limit)") : inList ? std::string("?") : std::string("FAILS raw, NOT waived (not named)"); };
        const double limit100 = bd.ideal.count("48000") && bd.ideal["48000"].count(100) ? kG1ResIdealFrac * bd.ideal["48000"][100] : 0.0;
        bool any = false;
        for (const auto& p : pairs)
        {
            double rr = 0, cr = 0; bool rw = false, cw = false, rl = false, cl = false;
            if (!cellOf(p.rsc, rr, rw, rl) || !cellOf(p.c1c, cr, cw, cl)) continue;
            if (!any) { rsc100Md = "### G1 at 100 Hz: RSC-* vs C1c-* (raw in-window residual, dB; limit " + num(limit100, 2) + ")\n\n| subject | raw residual | status | C1c counterpart | raw residual | status |\n|---|---:|---|---|---:|---|\n"; any = true; }
            const bool rp = rr >= kG1ResFloorDb && rr <= limit100, cp = cr >= kG1ResFloorDb && cr <= limit100;
            logf("G1 @100 Hz  %-7s raw %6.3f dB (limit %.3f): %-34s | %-6s raw %6.3f dB: %s", p.rsc, rr, limit100, status(rp, rw, rl).c_str(), p.c1c, cr, status(cp, cw, cl).c_str());
            rsc100Md += std::string("| ") + p.rsc + " | " + num(rr, 3) + " | " + status(rp, rw, rl) + " | " + p.c1c + " | " + num(cr, 3) + " | " + status(cp, cw, cl) + " |\n";
        }
        if (any) rsc100Md += "\n";
    }
    for (const auto& g : gateRows)
        if (g.pass8a() && g.pass8b() && g.pass9a() && g.pass9b()
            && ![&] { for (const auto& rs : scanSubjects) if (rs.id == g.id) return rs.reference; return false; }())
            warnf("%s passes G8a, G8b, G9a and G9b simultaneously - check the r_off / leak / t50 values in table 11 before trusting it", g.id.c_str());
    if (nOverall > 0)
        warnf("%d gated subject(s) pass ALL gates - baseline expectation is that the current subjects fail most gates; investigate the metrics before trusting this", nOverall);

    // Calibration verdicts (only when --ref-subjects registered R0 / R1): the oracle must pass G1-G6, the pass-through must fail G1 and G3.
    std::string calibLine;
    bool calibOk = true;
    {
        const GateRow* r0 = nullptr; const GateRow* r1 = nullptr;
        for (const auto& g : gateRows) { if (g.id == "R0") r0 = &g; if (g.id == "R1") r1 = &g; }
        if (r0 && r1)
        {
            const bool r1Ok = r1->pass1() && r1->pass2() && r1->pass1q() && r1->pass2q() && r1->pass1l() && r1->pass2l() && r1->g3 && r1->g4 && r1->g5 && r1->g6
                              && r1->pass8a() && r1->pass8b() && r1->pass9a() && r1->pass9b();
            const bool r0Ok = !r0->pass1() && !r0->g3 && !r0->pass8a() && !r0->pass8b() && r0->pass9a() && r0->pass9b();   // v6: pass-through never cuts the clean noise -> r_off 0 -> passes G9
            calibOk = r1Ok && r0Ok;
            calibLine = std::string("oracle R1 passes G1-G6 (incl. shape scans) and G8a/G8b/G9a/G9b = ") + (r1Ok ? "yes" : "NO") + " (G3 L " + cnt(r1->g3Lpass, r1->g3Ln) + "; G8a " + cnt(r1->g8a, r1->n8a)
                      + ", G8b " + cnt(r1->g8b, r1->n8b) + ", G9a " + cnt(r1->g9a, r1->n9a) + ", G9b " + cnt(r1->g9b, r1->n9b) + "); pass-through R0 fails G1, G3, G8a and G8b and passes G9a/G9b = " + (r0Ok ? "yes" : "NO")
                      + " (G1 " + cnt(r0->g1, r0->n) + ", G3 " + pf(r0->g3) + ", L " + cnt(r0->g3Lpass, r0->g3Ln) + ", G8a " + cnt(r0->g8a, r0->n8a) + ", G8b " + cnt(r0->g8b, r0->n8b) + ", G9a " + cnt(r0->g9a, r0->n9a) + ", G9b " + cnt(r0->g9b, r0->n9b) + ")";
            logf("calibration: %s -> %s", calibLine.c_str(), calibOk ? "ok" : "FAIL");
            if (!calibOk) warnf("reference-subject calibration FAILED: %s", calibLine.c_str());
        }
    }

    // ---------------------------------------------------------------- sanity block
    std::ostringstream san;
    san << "### Sanity checks (automatic)\n\n";
    {
        // Looked up by id (not by position) so a --subjects run without S1..S4 does not index past the end.
        auto findPrimary = [&](const char* id) -> const Subject* { for (const auto& s : primary) if (s.id == id) return &s; return nullptr; };
        const Subject* s1 = findPrimary("S1");
        bool llZero = s1 && (measureLatency(*s1, 48000.0).measured == 0 && measureLatency(*s1, 44100.0).measured == 0);
        bool hqEq = true;
        for (const auto& ps : primary)
            for (double sr : rates)
            {
                if (ps.id == "S1") continue;   // the zero-latency subject is checked by llZero
                const auto L = measureLatency(ps, sr);
                if (L.measured != L.reported || L.measured <= 0) hqEq = false;
            }
        san << "- measured latency == reported for every subject/rate: **" << (latencyAllOk ? "PASS" : "FAIL") << "**\n";
        san << "- S1 measured latency == 0 at both rates: **" << (s1 ? (llZero ? "PASS" : "FAIL") : "n/a (S1 not run)") << "**\n";
        san << "- S2-S5 measured == reported and > 0: **" << (hqEq ? "PASS" : "FAIL") << "**\n";
        bool rem = true;
        for (const char* id : { "S2", "S3", "S4" })
            if (findPrimary(id) && !(r2500[id].removed > 0.0)) rem = false;
        san << "- removed_dB > 0 at the planted 2500 Hz resonance for S2-S4: **" << (rem ? "PASS" : "FAIL") << "** (";
        for (const auto& s : primary) san << s.id << "=" << num(r2500[s.id].removed, 2) << (s.id == "S5" ? "" : ", ");
        san << ")\n";

        // removed/ideal must lie in 0..~150 % wherever it is defined. Default-parameter subjects are held to it;
        // capability subjects are counted separately (max depth may legitimately cut BELOW the un-boosted spectrum,
        // i.e. > 100 %, because removed_dB is measured against the input, not against the un-planted noise).
        {
            auto check = [&](const std::vector<Subject>& subs, int& nBad, int& nCells, int& nOver100, std::string& list)
            {
                std::ostringstream bad;
                for (double sr : rates)
                    for (double f0 : scanF0)
                        for (const auto& s : subs)
                        {
                            const double ideal = idealDb[num(sr, 0)][static_cast<int>(f0)];
                            const double p = pct(scanRes[s.id + "@" + num(sr, 0)][static_cast<int>(f0)].removed, ideal);
                            ++nCells;
                            if (p > 100.0) ++nOver100;
                            if (p < 0.0 || p > 150.0) { ++nBad; bad << " " << s.id << "@" << num(sr, 0) << "/" << num(f0, 0) << "=" << num(p, 1) << "%"; }
                        }
                list = bad.str();
            };
            int bD = 0, cD = 0, oD = 0, bC = 0, cC = 0, oC = 0; std::string lD, lC;
            std::vector<Subject> legacyCap;   // capability variants with a paired default subject (S1c..S5c); S5q has none
            for (const auto& cs : capability) if (!cs.pairedDefault.empty()) legacyCap.push_back(cs);
            check(primary, bD, cD, oD, lD);
            check(legacyCap, bC, cC, oC, lC);
            san << "- removed/ideal within 0..150 % for the " << cD << " default-parameter scan cells: **" << (bD == 0 ? "PASS" : "FAIL") << "**"
                << (bD ? " (outside:" + lD + ")" : std::string()) << "\n";
            san << "- capability scan cells: " << cC << " total, " << oC << " above 100 % (output cut below the un-boosted spectrum), "
                << bC << " outside 0..150 % - informational, not a failure: max-depth runs are expected to over-suppress.\n";
            logf("sanity: default removed/ideal in 0..150%% %s (%d outside of %d); capability %d/%d cells >100%%, %d outside 0..150%%",
                 bD == 0 ? "ok" : "FAIL", bD, cD, oC, cC, bC);
        }
        // capability runs should remove at least as much as the matching default run at the planted frequency.
        {
            san << "- capability removed >= default removed at the planted 2500 Hz resonance (48 kHz): ";
            bool allGe = true;
            {
                std::vector<Subject> paired;
                for (const auto& cs : capability) if (!cs.pairedDefault.empty()) paired.push_back(cs);
                for (size_t i = 0; i < paired.size(); ++i)
                {
                    const double d = r2500[paired[i].pairedDefault].removed, c = r2500[paired[i].id].removed;
                    if (c < d) allGe = false;
                    san << paired[i].id << " " << num(c, 2) << " vs " << paired[i].pairedDefault << " " << num(d, 2) << (c >= d ? " ok" : " **LOWER**") << (i + 1 < paired.size() ? "; " : "");
                }
            }
            san << " -> **" << (allGe ? "PASS" : "FAIL (see Notes)") << "**\n";
            logf("sanity: capability >= default at 2500 Hz %s", allGe ? "ok" : "FAIL");
        }
        if (!calibLine.empty()) san << "- reference-subject calibration (--ref-subjects): " << calibLine << " -> **" << (calibOk ? "PASS" : "FAIL") << "**\n";
        san << "- non-finite values that reached a table: **" << g_nonFinite << "**\n";
        san << "- tool warnings: **" << g_warnings << "**\n\n";
        logf("sanity: latency %s | S1=0 %s | S2-S5 %s | removed>0 S2-S4 %s | nonfinite %d | warnings %d",
             latencyAllOk ? "ok" : "FAIL", s1 ? (llZero ? "ok" : "FAIL") : "n/a", hqEq ? "ok" : "FAIL", rem ? "ok" : "FAIL", g_nonFinite, g_warnings);
    }

    // ---------------------------------------------------------------- write outputs
    for (auto& kv : csvTables)
        std::ofstream(runDir / (kv.first + ".csv"), std::ios::binary) << kv.second.csv();

    std::ostringstream md;
    md << "# RS quality bench - " << (g_opt.quick ? "QUICK" : "FULL") << " run\n\n";
    md << "- Run directory: `" << runDir.generic_string() << "`\n";
    md << "- Git: `" << hash << "` (working tree may be dirty)\n";
    md << "- Build configuration: **" << cfg << "**" << (isRelease ? "" : "  **<-- NOT RELEASE: CPU numbers invalid**") << "\n";
    md << "- CPU: " << cpu << "\n";
    if (g_opt.seed) md << "- Noise seed shift: `--seed " << g_opt.seed << "` (every generated signal; 0 = the original seeds)\n";
    for (const auto& lim : knownLimits())
    {
        std::string ids;
        for (const auto& g : gateRows)
            if (g.g1Waived > 0 && std::find(lim.subjects.begin(), lim.subjects.end(), g.id) != lim.subjects.end()) ids += (ids.empty() ? "" : ", ") + g.id;
        if (!ids.empty())
            md << "- **KNOWN LIMIT (waived): " << lim.gate << " at f0 = " << lim.f0 << " Hz is WAIVED for " << ids << ": " << lim.reason << ".** The raw count stays in the gate table; "
                  "a waived subject reads `PASS (1 waiver)` when every other gate passes. No other subject or frequency is waived (section KNOWN LIMITS below).\n";
    }
    md << "- Signals: A/B/C/E " << num(sigSeconds(), 0) << " s, D " << num(dSeconds(), 0) << " s, 48 kHz stereo; latency + scan also at 44.1 kHz. "
          "Single-render block size " << kStdBlock << "; prepareToPlay(maxBlock " << kPrepareBlock << ").\n";
    md << "- All figures are latency-aligned using the MEASURED impulse latency. Numbers only; no ranking implied.\n\n";
    md << "### Subjects\n\n| id | label | params |\n|---|---|---|\n";
    for (const auto& s : allSubjects) md << "| " << s.id << " | " << s.label << " | " << s.params << " |\n";
    md << "\nNote on S5s/S5z: in the EQ detector `thresh = localEnv * (1 + spec_sens * spec_sel)`, so spec_sens 1.0 is the LEAST sensitive setting. "
          "S5s runs sens 1.0 exactly as specified; S5z runs sens 0.0 (the most sensitive) so the false-trigger direction is covered.\n"
          "Capability variants S1c-S5c (max depth): RS depth 100 % / mode Hard (LL and HQ Fast/Normal/High); EQ band gain -30 dB with spec_sens 0.0 (lower = more sensitive). "
          "S5q = the fair EQ variant: band gain -30 dB, spec_sens 0.0, band Q 8, centre = f0 (S5qz = its sensitive jitter companion: sens 0.0, Q 8, gain -12 dB). "
          "S5qd = the same but spec_sens at its DEFAULT (S5q's sens 0.0 sets threshold = local mean, which over-suppresses by construction); its G4 is graded on S5qz. "
          "They run signals A/B (full scan), C (jitter), D and D2 (pre-echo), E and the delta-artefact run, in addition to the default-parameter subjects.\n\n";
    md << tGate.markdown() << tGateDetail.markdown() << tGateF0.markdown() << rsc100Md;
    {
        // Known limits (named waivers): printed whenever a waiver is registered for a graded subject, whether it was needed or not.
        std::ostringstream kl;
        bool any = false;
        for (const auto& lim : knownLimits())
            for (const auto& g : gateRows)
            {
                if (std::find(lim.subjects.begin(), lim.subjects.end(), g.id) == lim.subjects.end()) continue;
                if (!any) { kl << "### KNOWN LIMITS (named waivers)\n\nA waiver is a printed exception for ONE gate / subject / frequency, not a change of the gate: thresholds and metrics are unchanged, "
                                  "the raw count stays in the gate table, and the verdict reads `PASS (n waiver)` only when every other gate passes. No other subject or frequency is waived.\n\n"
                                  "| gate | subject | f0 | raw result | status | reason |\n|---|---|---:|---|---|---|\n"; any = true; }
                kl << "| " << lim.gate << " | " << g.id << " | " << lim.f0 << " Hz | G1 " << cnt(g.g1, g.n) << " | " << (g.g1Waived > 0 ? "**WAIVED**" : "not needed (cell passes)")
                   << " | " << lim.reason << " |\n";
            }
        if (any) md << kl.str() << "\n";
    }
    md << san.str();
    for (const auto& t : tables) md << t.markdown();
    std::ofstream(runDir / "summary.md", std::ios::binary) << md.str();

    logf("wrote %zu CSVs, summary.md and WAVs to %s", csvTables.size(), runDir.string().c_str());
    logf("done. non-finite=%d warnings=%d", g_nonFinite, g_warnings);
    return (g_nonFinite == 0) ? 0 : 1;
}
