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
// Usage: xleth_rs_quality_bench [--quick] [--no-cpu] [--cpu-only] [--out-dir DIR]
//                               [--ref-subjects] [--wav label=path]...
//   --ref-subjects registers two reference subjects (R0 pass-through, R1 oracle = exact inverse of the planted bell, built through
//   Subject::factory) so the residual metrics and gates can be calibrated: R0 must FAIL G1/G3, R1 must PASS. Off by default (default output unchanged).

// Test-only read access to the RS detector baseline (same define as
// engine/test/test_pdc_stage1.cpp). Adds only static members; must precede the
// first include of the RS header. No production source is modified.
#define XLETH_RESONANCE_SUPPRESSOR_TEST_HOOKS 1

#include "audio/XlethEQEffect.h"
#include "audio/XlethResonanceSuppressorEffect.h"

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
    std::string outBase = "bench_out";
    std::vector<std::pair<std::string, std::string>> wavs;   // label, path
};

static Options g_opt;

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
        auto p = makePink(n, salt * 1000ull + static_cast<uint64_t>(c) + 1ull);
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

// Signals A/B (resonance in both channels) and E (resonance in the RIGHT only).
static Stereo makeResonant(const Stereo& basePink, double sr, double f0, bool left, bool right)
{
    Stereo s = basePink;
    if (left)  applyRbjPeak(s.ch[0], sr, f0, 8.0, 12.0);
    if (right) applyRbjPeak(s.ch[1], sr, f0, 8.0, 12.0);
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
        Rng r(777u + static_cast<uint64_t>(c));
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
    std::string pairedDefault;     // id of the default-parameter subject this capability variant is paired with
                                   // (empty = none; only paired ones enter the legacy 'capability >= default' sanity line)
    // Optional: build a subject that is not one of the built-in kinds. Returns a prepared processor
    // (the factory calls prepareToPlay itself). `neutral` = depth 0 / no-op config for latency + transparency runs.
    std::function<std::unique_ptr<juce::AudioProcessor>(double sr, int maxBlock, double centreHz, bool neutral)> factory;
};

// Reference processor for --ref-subjects: one RBJ peaking biquad (double TDF-II, same maths as applyRbjPeak) per channel.
// gainDb = 0 is an exact identity (pass-through); gainDb = -12 at the planted f0 is the exact inverse of the planted +12 dB / Q8 bell.
class RefBellProcessor : public juce::AudioProcessor
{
public:
    RefBellProcessor(double sr, double f0, double gainDb)
        : juce::AudioProcessor(BusesProperties().withInput("in", juce::AudioChannelSet::stereo()).withOutput("out", juce::AudioChannelSet::stereo()))
    {
        const double A = std::pow(10.0, gainDb / 40.0);
        const double w0 = 2.0 * juce::MathConstants<double>::pi * f0 / sr;
        const double alpha = std::sin(w0) / (2.0 * 8.0);
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
};

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

        // -------- Sensitive: jitter / false-trigger test only --------
        { auto& s = add("S1s", "S1", "RS Low Latency (sensitive)", Kind::RsLL, Group::Sensitive, "depth=100, selectivity=0"); s.sensitive = true; }
        { auto& s = add("S2s", "S2", "RS HQ Fast (sensitive)",     Kind::RsHQ, Group::Sensitive, "depth=100, selectivity=0"); s.sensitive = true; s.quality = 0; }
        { auto& s = add("S3s", "S3", "RS HQ Normal (sensitive)",   Kind::RsHQ, Group::Sensitive, "depth=100, selectivity=0"); s.sensitive = true; s.quality = 1; }
        { auto& s = add("S4s", "S4", "RS HQ High (sensitive)",     Kind::RsHQ, Group::Sensitive, "depth=100, selectivity=0"); s.sensitive = true; s.quality = 2; }
        { auto& s = add("S5s", "S5", "EQ Spectral (spec_sens=1.0, as spec'd)", Kind::Eq, Group::Sensitive, "spec_sens=1.0 (EQ: HIGHER sens = HIGHER threshold)"); s.eqSens = 1.0f; }
        { auto& s = add("S5z", "S5", "EQ Spectral (spec_sens=0.0)", Kind::Eq, Group::Sensitive, "spec_sens=0.0 (EQ: LOWEST threshold = most sensitive)"); s.eqSens = 0.0f; }
        // Sensitive companion of S5q (G4): same as S5z but with the narrow band Q 8 of the fair variant.
        { auto& s = add("S5qz", "S5", "EQ Spectral (spec_sens=0.0, Q=8)", Kind::Eq, Group::Sensitive, "spec_sens=0.0, band Q=8, gain -12 dB (sensitive companion of S5q)"); s.eqSens = 0.0f; s.eqQ = 8.0f; }

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

        // -------- Reference subjects (opt-in): metric / gate calibration. Registered through Subject::factory. --------
        if (g_opt.refSubjects)
        {
            { auto& s = add("R0", "R0", "Reference: pass-through", Kind::Custom, Group::Capability, "identity processor - the do-nothing floor (expected: FAIL G1 and G3)");
              s.gated = true; s.reference = true;
              s.factory = [](double sr, int, double f0, bool) { return std::make_unique<RefBellProcessor>(sr, f0, 0.0); }; }
            { auto& s = add("R1", "R1", "Reference: oracle (exact inverse bell)", Kind::Custom, Group::Capability, "-12 dB / Q8 bell at f0 = exact inverse of the planted bell (expected: PASS G1/G2/G3)");
              s.gated = true; s.reference = true;
              s.factory = [](double sr, int, double f0, bool neutral) { return std::make_unique<RefBellProcessor>(sr, f0, neutral ? 0.0 : -12.0); }; }
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
static Fx makeFx(const Subject& s, double sr, double eqCentre, bool neutral, int maxBlock)
{
    Fx fx;
    if (s.factory)
    {
        fx.custom = s.factory(sr, maxBlock, eqCentre, neutral);
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

static double idealBoostDb(double sr, double f0)
{
    const double binHz = sr / kWelchN;
    const double s6 = std::pow(2.0, 1.0 / 6.0);
    const double lo1 = f0 / s6, hi1 = f0 * s6;
    double acc = 0; int n = 0;
    for (int k = 1; k <= kWelchN / 2; ++k)
    {
        const double f = static_cast<double>(k) * binHz;
        if (f >= lo1 && f <= hi1) { acc += bellMagDb(f, sr, f0, 8.0, 12.0); ++n; }
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
    const auto key = std::make_tuple(tag, begin, end, useL, useR);
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
// Gates (v3)
// ============================================================================
//
// Fixed acceptance criteria. DO NOT tune these to make a subject pass; they are the specification.
// Every subject registered with gated = true is evaluated at ITS OWN variant (the capability variants S1c..S5c, S5q)
// over the 12 scan frequencies at 48 kHz (the 44.1 kHz scan is reported informationally).
//   G1  in_window_residual_dB >= kG1ResFloorDb  and  <= kG1ResIdealFrac * ideal_dB   at EVERY f0
//   G2  outside_dev_dB <= kG2OutsideDevDb                                             at EVERY f0
//   G3  resonance in the RIGHT channel only (signal E, 2500 Hz): G1 + G2 on R, and L outside_dev_dB <= kG2OutsideDevDb
//   G4  sensitive-variant jitter (signal C): std "all" <= kG4StdAllDb AND isolated-cell fraction "all" <= kG4IsoAll
//   G5  pre-echo with the mask engaged (D2): broadband E_out/E_in <= kG5BroadbandDb AND band E_out/E_in <= kG5BandDb
//   G6  latency: measured == reported at both sample rates, and identical across every block schedule
static constexpr double kG1ResFloorDb   = -1.5;
static constexpr double kG1ResIdealFrac = 0.30;
static constexpr double kG2OutsideDevDb = 0.5;
static constexpr double kG4StdAllDb     = 0.6;
static constexpr double kG4IsoAll       = 1.0e-3;
static constexpr double kG5BroadbandDb  = 1.0;
static constexpr double kG5BandDb       = 1.0;

struct EResidual { Residual r, l; bool valid = false; };          // signal E (resonance in R only), per channel
struct LatencyGate { bool valid = false, matchAll = true, blockInvariant = true; std::string detail; };

struct BenchData
{
    std::vector<double> scanF0;
    std::map<std::string, std::map<int, double>> ideal;                // "48000" -> f0 -> ideal dB
    std::map<std::string, std::map<int, Residual>> residual;           // "S1c@48000" -> f0 -> residual
    std::map<std::string, EResidual> right;                            // subject id -> signal E residuals (48 kHz, 2500 Hz)
    std::map<std::string, Jitter> jitter;                              // subject id -> signal C jitter
    std::map<std::string, PreEcho> d2;                                 // subject id -> signal D2 pre-echo
    std::map<std::string, LatencyGate> latency;                        // subject id -> G6 evidence
};

struct GateRow
{
    std::string id, label;
    int g1 = 0, g2 = 0, n = 0;                // passing f0 count at 48 kHz, out of n
    int g1_44 = 0, g2_44 = 0, n44 = 0;        // informational: the same at 44.1 kHz
    bool g3 = false; double g3RRes = 0, g3RDev = 0, g3LRes = 0, g3LDev = 0; bool g3valid = false;
    bool g4 = false; double g4Std = 0, g4Iso = 0; bool g4valid = false; std::string g4Id;
    bool g5 = false; double g5Bb = 0, g5Band = 0; bool g5valid = false;
    bool g6 = false; std::string g6detail;
    bool pass1() const { return n > 0 && g1 == n; }
    bool pass2() const { return n > 0 && g2 == n; }
    bool overall() const { return pass1() && pass2() && g3 && g4 && g5 && g6; }
};

static bool g1Cell(const Residual& r, double idealDb)
{
    return r.inWindow >= kG1ResFloorDb && r.inWindow <= kG1ResIdealFrac * idealDb;
}
static bool g2Cell(const Residual& r) { return r.outsideDev <= kG2OutsideDevDb; }

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
    GateRow g; g.id = s.id; g.label = s.label;
    int t = 0;
    g.g1 = countRates(d, s.id, 48000.0, true, t);  g.n = t;
    g.g2 = countRates(d, s.id, 48000.0, false, t);
    g.g1_44 = countRates(d, s.id, 44100.0, true, t); g.n44 = t;
    g.g2_44 = countRates(d, s.id, 44100.0, false, t);

    // G3
    const auto e = d.right.find(s.id);
    if (e != d.right.end() && e->second.valid)
    {
        g.g3valid = true;
        g.g3RRes = e->second.r.inWindow; g.g3RDev = e->second.r.outsideDev;
        g.g3LRes = e->second.l.inWindow; g.g3LDev = e->second.l.outsideDev;
        const double ideal = d.ideal.at("48000").at(2500);
        g.g3 = g1Cell(e->second.r, ideal) && g2Cell(e->second.r) && e->second.l.outsideDev <= kG2OutsideDevDb;
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
// main
// ============================================================================

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
        std::ofstream(cpuDir / "cpu.csv", std::ios::binary) << t.csv();
        std::ofstream(cpuDir / "summary.md", std::ios::binary)
            << "# RS bench - CPU only\n\n- Git: `" << hash << "`\n- Build: **" << cfg << "**\n- CPU: " << cpu << "\n\n" << t.markdown() << proj.markdown();
        logf("wrote cpu.csv and summary.md to %s", cpuDir.string().c_str());
        return g_nonFinite == 0 ? 0 : 1;
    }

    const fs::path runDir = fs::path(g_opt.outBase) / (stamp + "_" + hash + (g_opt.quick ? "_quick" : ""));
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
    logf("[8/9] right-only resonance (signal E)");
    Table tRight; tRight.title = "8. Right-only resonance (signal E, f0 = 2500 Hz, 48 kHz)";
    tRight.note = "Resonance planted in the RIGHT channel only (independent pink noise in each channel). removed_dB at f0 +/- 1/6 oct per channel (same definition as metric 3, single channel). "
                  "The left channel has no resonance, so its value shows what a linked / left-driven mask does to a clean channel.";
    tRight.header = { "subject", "label", "removed R (dB)", "removed L (dB)", "collateral R (dB)", "collateral L (dB)" };
    Table tRightRes; tRightRes.title = "8b. Right-only resonance vs clean (signal E, f0 = 2500 Hz, 48 kHz) - gate G3 evidence";
    tRightRes.note = "Same signal and render as table 8; clean reference = unprocessed C (the pink noise E was built from), latency-aligned. Metrics as in 3r, computed per channel "
                     "(R: resonance planted; L: untouched). G3 = (R in_window within -1.5 .. 0.30 x ideal) AND (R outside_dev <= 0.5) AND (L outside_dev <= 0.5). "
                     "ideal at 2500 Hz / 48 kHz = " + num(bd.ideal["48000"][2500], 2) + " dB. L in_window is informational.";
    tRightRes.header = { "subject", "label", "R in_window (dB)", "R outside_dev (dB)", "L in_window (dB)", "L outside_dev (dB)", "G3" };
    Table tRightCsv; tRightCsv.header = { "subject", "r_in_window_db", "r_outside_dev_db", "l_in_window_db", "l_outside_dev_db", "ideal_db", "g3" };
    {
        const Stereo sigE = makeResonant(pinkC, SR, 2500.0, false, true);
        for (const auto& s : scanSubjects)
        {
            Fx fx = makeFx(s, SR, 2500.0, false, kPrepareBlock);
            const Stereo out = renderStd(fx, sigE);
            const auto a = align(sigE, out, measureLatency(s, SR).measured, SR);
            const Accuracy aR = suppressionAccuracy(a, "C@48000", pinkC, SR, 2500.0, false, true);
            const Accuracy aL = suppressionAccuracy(a, "C@48000", pinkC, SR, 2500.0, true, false);
            tRight.add({ s.id, s.label, num(aR.rc.removed, 2), num(aL.rc.removed, 2), num(aR.rc.collateral, 2), num(aL.rc.collateral, 2) });
            EResidual er; er.valid = true; er.r = aR.res; er.l = aL.res;
            bd.right[s.id] = er;
            const double ideal = bd.ideal["48000"][2500];
            const bool g3 = g1Cell(er.r, ideal) && g2Cell(er.r) && er.l.outsideDev <= kG2OutsideDevDb;
            tRightRes.add({ s.id, s.label, num(er.r.inWindow, 2), num(er.r.outsideDev, 2), num(er.l.inWindow, 2), num(er.l.outsideDev, 2), pf(g3) });
            tRightCsv.add({ s.id, num(er.r.inWindow, 4), num(er.r.outsideDev, 4), num(er.l.inWindow, 4), num(er.l.outsideDev, 4), num(ideal, 4), g3 ? "1" : "0" });
        }
    }
    csvTables["right_only"] = tRight; tables.push_back(tRight);
    csvTables["right_only_residual"] = tRightCsv; tables.push_back(tRightRes);

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

    // ---------------------------------------------------------------- CPU (9)
    Table tCpu; tCpu.title = "9. CPU (48 kHz stereo)";
    tCpu.header = { "subject", "label", "block", "median ns", "p95 ns", "p99 ns", "max ns", "mean ns", "median % RT", "p95 % RT", "mean % RT", "max % RT" };
    Table tCpuProj;
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
    }
    csvTables["cpu"] = tCpu; tables.push_back(tCpu);
    if (!tCpuProj.rows.empty()) { csvTables["cpu_projection"] = tCpuProj; tables.push_back(tCpuProj); }

    // ---------------------------------------------------------------- --wav inputs (G)
    Table tWav; tWav.title = "G. --wav inputs: depth-0 null";
    tWav.note = "Each file is run at its own sample rate through every subject (default config, S5 band 2500 Hz / -12 dB); aligned out and delta WAVs are in wav/. "
                "Only metric: latency-aligned null depth at depth 0 (RS depth 0, EQ band gain 0 dB): RMS(out - in) dBFS, first min(2 s, 25 %) skipped.";
    tWav.header = { "label", "subject", "sr", "latency", "null depth 0 (dBFS)" };
    for (const auto& w : g_opt.wavs)
    {
        Stereo in; double sr = 0;
        if (!readWav(w.second, in, sr)) { warnf("cannot read WAV %s", w.second.c_str()); continue; }
        logf("--wav %s: %d samples @%.0f Hz", w.first.c_str(), in.size(), sr);
        for (const auto& s : primary)
        {
            const int L = measureLatency(s, sr).measured;
            {
                Fx fx = makeFx(s, sr, 2500.0, false, kPrepareBlock);
                const Stereo out = renderStd(fx, in);
                const auto a = align(in, out, L, sr);
                writeWav(wavDir / (w.first + "_" + s.id + "_out.wav"),   a.out, sr);
                writeWav(wavDir / (w.first + "_" + s.id + "_delta.wav"), deltaOf(a), sr);
            }
            Fx fx0 = makeFx(s, sr, 2500.0, true, kPrepareBlock);
            const Stereo out0 = renderStd(fx0, in);
            const auto a0 = align(in, out0, L, sr);
            tWav.add({ w.first, s.id, num(sr, 0), inum(L), num(rmsDiffDbfs(a0), 2) });
        }
    }
    if (!g_opt.wavs.empty()) { csvTables["wav_null"] = tWav; tables.push_back(tWav); }

    // ---------------------------------------------------------------- gate table (v3)
    std::vector<GateRow> gateRows;
    for (const auto& s : scanSubjects) if (s.gated) gateRows.push_back(evaluateGates(s, bd));

    Table tGate; tGate.title = "Gate table (capability variants, fixed thresholds)";
    tGate.note = "Every subject registered with gated = true is graded at its own variant. G1: in-window residual vs clean within [-1.5 dB, 0.30 x ideal dB] at EVERY one of the 12 scan f0 (48 kHz; count = f0 passing). "
                 "G2: outside deviation <= 0.5 dB at every f0 (count). G3: resonance in R only (signal E, 2500 Hz): G1 + G2 on R and L outside deviation <= 0.5 dB. "
                 "G4: sensitive-variant jitter (signal C, subject's registered sensitive variant): std all <= 0.6 dB AND isolated-cell fraction all <= 1e-3. "
                 "G5: pre-echo with the mask engaged (D2): broadband E_out/E_in <= +1.0 dB AND band (f0 +/- 1/3 oct) E_out/E_in <= +1.0 dB. "
                 "G6: latency measured == reported at 48 and 44.1 kHz and unchanged across block schedules. Overall = all six pass. "
                 "Thresholds are the constants kG1..kG5 in the tool; they are not tuned per subject.";
    tGate.header = { "subject", "label", "G1 in-window", "G2 outside-dev", "G3 R-only", "G4 jitter", "G5 pre-echo D2", "G6 latency", "overall" };
    Table tGateDetail; tGateDetail.title = "Gate details (raw values behind the gate table)";
    tGateDetail.note = "G1/G2 counts also at 44.1 kHz (informational, not part of the gate). G3: R/L in-window and outside-dev (dB) at 2500 Hz. "
                       "G4: std all (dB) / isolated all, measured on the named sensitive variant. G5: broadband / band E_out vs E_in (dB) on D2. G6: measured/reported per rate.";
    tGateDetail.header = { "subject", "G1 @44.1k (info)", "G2 @44.1k (info)", "G3 R in-window", "G3 R outside-dev", "G3 L in-window", "G3 L outside-dev",
                           "G4 variant", "G4 std all", "G4 isolated all", "G5 broadband", "G5 band", "G6 latency" };
    Table tGateCsv;
    tGateCsv.header = { "subject", "label", "g1_pass_f0", "g1_total_f0", "g1", "g2_pass_f0", "g2_total_f0", "g2", "g3_r_in_window_db", "g3_r_outside_dev_db", "g3_l_outside_dev_db", "g3",
                        "g4_variant", "g4_std_all_db", "g4_isolated_all", "g4", "g5_broadband_db", "g5_band_db", "g5", "g6_detail", "g6", "overall",
                        "info_g1_pass_f0_44k", "info_g2_pass_f0_44k", "info_total_f0_44k" };
    int nOverall = 0;
    for (size_t gi = 0; gi < gateRows.size(); ++gi)
    {
        const auto& g = gateRows[gi];
        const bool isRef = [&] { for (const auto& rs : scanSubjects) if (rs.id == g.id) return rs.reference; return false; }();
        if (g.overall() && !isRef) ++nOverall;
        tGate.add({ g.id, g.label, pf(g.pass1()) + " " + cnt(g.g1, g.n), pf(g.pass2()) + " " + cnt(g.g2, g.n), g.g3valid ? pf(g.g3) : "FAIL (no data)",
                    g.g4valid ? pf(g.g4) : "FAIL (no data)", g.g5valid ? pf(g.g5) : "FAIL (no data)", pf(g.g6), pf(g.overall()) });
        tGateDetail.add({ g.id, cnt(g.g1_44, g.n44), cnt(g.g2_44, g.n44), num(g.g3RRes, 2), num(g.g3RDev, 2), num(g.g3LRes, 2), num(g.g3LDev, 2),
                          g.g4Id, num(g.g4Std, 3), num(g.g4Iso, 6), num(g.g5Bb, 3), num(g.g5Band, 3), g.g6detail });
        tGateCsv.add({ g.id, g.label, inum(g.g1), inum(g.n), pf(g.pass1()), inum(g.g2), inum(g.n), pf(g.pass2()), num(g.g3RRes, 4), num(g.g3RDev, 4), num(g.g3LDev, 4), pf(g.g3),
                       g.g4Id, num(g.g4Std, 4), num(g.g4Iso, 6), pf(g.g4), num(g.g5Bb, 4), num(g.g5Band, 4), pf(g.g5), g.g6detail, pf(g.g6), pf(g.overall()),
                       inum(g.g1_44), inum(g.g2_44), inum(g.n44) });
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

    logf("---- GATE TABLE (G1/G2 counts are f0 passing out of %zu) ----", scanF0.size());
    for (const auto& g : gateRows)
        logf("%-4s G1 %-4s %5s | G2 %-4s %5s | G3 %-4s | G4 %-4s | G5 %-4s | G6 %-4s | overall %s", g.id.c_str(),
             pf(g.pass1()).c_str(), cnt(g.g1, g.n).c_str(), pf(g.pass2()).c_str(), cnt(g.g2, g.n).c_str(), pf(g.g3).c_str(), pf(g.g4).c_str(), pf(g.g5).c_str(), pf(g.g6).c_str(),
             pf(g.overall()).c_str());
    if (nOverall > 0)
        warnf("%d gated subject(s) pass ALL gates - baseline expectation is that the current subjects fail most gates; investigate the metrics before trusting this", nOverall);

    // ---------------------------------------------------------------- sanity block
    std::ostringstream san;
    san << "### Sanity checks (automatic)\n\n";
    {
        bool llZero = (measureLatency(primary[0], 48000.0).measured == 0 && measureLatency(primary[0], 44100.0).measured == 0);
        bool hqEq = true;
        for (size_t i = 1; i < primary.size(); ++i)
            for (double sr : rates)
            {
                const auto L = measureLatency(primary[i], sr);
                if (L.measured != L.reported || L.measured <= 0) hqEq = false;
            }
        san << "- measured latency == reported for every subject/rate: **" << (latencyAllOk ? "PASS" : "FAIL") << "**\n";
        san << "- S1 measured latency == 0 at both rates: **" << (llZero ? "PASS" : "FAIL") << "**\n";
        san << "- S2-S5 measured == reported and > 0: **" << (hqEq ? "PASS" : "FAIL") << "**\n";
        bool rem = true;
        for (int i = 1; i <= 3; ++i) if (!(r2500[primary[static_cast<size_t>(i)].id].removed > 0.0)) rem = false;
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
        san << "- non-finite values that reached a table: **" << g_nonFinite << "**\n";
        san << "- tool warnings: **" << g_warnings << "**\n\n";
        logf("sanity: latency %s | S1=0 %s | S2-S5 %s | removed>0 S2-S4 %s | nonfinite %d | warnings %d",
             latencyAllOk ? "ok" : "FAIL", llZero ? "ok" : "FAIL", hqEq ? "ok" : "FAIL", rem ? "ok" : "FAIL", g_nonFinite, g_warnings);
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
    md << "- Signals: A/B/C/E " << num(sigSeconds(), 0) << " s, D " << num(dSeconds(), 0) << " s, 48 kHz stereo; latency + scan also at 44.1 kHz. "
          "Single-render block size " << kStdBlock << "; prepareToPlay(maxBlock " << kPrepareBlock << ").\n";
    md << "- All figures are latency-aligned using the MEASURED impulse latency. Numbers only; no ranking implied.\n\n";
    md << "### Subjects\n\n| id | label | params |\n|---|---|---|\n";
    for (const auto& s : allSubjects) md << "| " << s.id << " | " << s.label << " | " << s.params << " |\n";
    md << "\nNote on S5s/S5z: in the EQ detector `thresh = localEnv * (1 + spec_sens * spec_sel)`, so spec_sens 1.0 is the LEAST sensitive setting. "
          "S5s runs sens 1.0 exactly as specified; S5z runs sens 0.0 (the most sensitive) so the false-trigger direction is covered.\n"
          "Capability variants S1c-S5c (max depth): RS depth 100 % / mode Hard (LL and HQ Fast/Normal/High); EQ band gain -30 dB with spec_sens 0.0 (lower = more sensitive). "
          "S5q = the fair EQ variant: band gain -30 dB, spec_sens 0.0, band Q 8, centre = f0 (S5qz = its sensitive jitter companion: sens 0.0, Q 8, gain -12 dB). "
          "They run signals A/B (full scan), C (jitter), D and D2 (pre-echo), E and the delta-artefact run, in addition to the default-parameter subjects.\n\n";
    md << tGate.markdown() << tGateDetail.markdown() << tGateF0.markdown();
    md << san.str();
    for (const auto& t : tables) md << t.markdown();
    std::ofstream(runDir / "summary.md", std::ios::binary) << md.str();

    logf("wrote %zu CSVs, summary.md and WAVs to %s", csvTables.size(), runDir.string().c_str());
    logf("done. non-finite=%d warnings=%d", g_nonFinite, g_warnings);
    return (g_nonFinite == 0) ? 0 : 1;
}
