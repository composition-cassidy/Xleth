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
// Usage: xleth_rs_quality_bench [--quick] [--no-cpu] [--out-dir DIR]
//                               [--wav label=path]...

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
#include <map>
#include <memory>
#include <numeric>
#include <sstream>
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

static Stereo makeTransientBed(int n, double sr)
{
    Stereo s = makePinkStereo(n, -40.0, 50);
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

enum class Kind { RsLL, RsHQ, Eq };

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
};

static std::vector<Subject> primarySubjects()
{
    return {
        { "S1", "S1", "RS Low Latency",            Kind::RsLL, 0, false, -1.0f, "defaults (LL)" },
        { "S2", "S2", "RS High Quality / Fast",    Kind::RsHQ, 0, false, -1.0f, "processing_mode=HQ, quality=Fast (N=512)" },
        { "S3", "S3", "RS High Quality / Normal",  Kind::RsHQ, 1, false, -1.0f, "processing_mode=HQ, quality=Normal (N=1024)" },
        { "S4", "S4", "RS High Quality / High",    Kind::RsHQ, 2, false, -1.0f, "processing_mode=HQ, quality=High (N=2048)" },
        { "S5", "S5", "EQ Spectral (1 band)",      Kind::Eq,   0, false, -1.0f, "band0 mode=Spectral, gain(depth)=-12 dB, freq=resonance, Q/sens/sel/atk/rel default" },
    };
}

static std::vector<Subject> sensitiveSubjects()
{
    return {
        { "S1s", "S1", "RS Low Latency (sensitive)",           Kind::RsLL, 0, true,  -1.0f, "depth=100, selectivity=0" },
        { "S2s", "S2", "RS HQ Fast (sensitive)",               Kind::RsHQ, 0, true,  -1.0f, "depth=100, selectivity=0" },
        { "S3s", "S3", "RS HQ Normal (sensitive)",             Kind::RsHQ, 1, true,  -1.0f, "depth=100, selectivity=0" },
        { "S4s", "S4", "RS HQ High (sensitive)",               Kind::RsHQ, 2, true,  -1.0f, "depth=100, selectivity=0" },
        { "S5s", "S5", "EQ Spectral (spec_sens=1.0, as spec'd)", Kind::Eq, 0, false, 1.0f, "spec_sens=1.0 (EQ: HIGHER sens = HIGHER threshold)" },
        { "S5z", "S5", "EQ Spectral (spec_sens=0.0)",          Kind::Eq,   0, false, 0.0f,  "spec_sens=0.0 (EQ: LOWEST threshold = most sensitive)" },
    };
}

struct Fx
{
    std::unique_ptr<XlethResonanceSuppressorEffect> rs;
    std::unique_ptr<XlethParametricEQ>              eq;

    juce::AudioProcessor& proc() { return rs ? static_cast<juce::AudioProcessor&>(*rs) : static_cast<juce::AudioProcessor&>(*eq); }
    int reported() const { return rs ? rs->getLatencySamples() : eq->getLatencySamples(); }
    // What a host sees through the juce::AudioProcessor base (setLatencySamples value).
    int published() const
    {
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
    if (s.kind == Kind::Eq)
    {
        fx.eq = std::make_unique<XlethParametricEQ>();
        auto& eq = *fx.eq;
        need(eq.addBand() == 0, "EQ addBand");
        need(eq.setBandParam(0, "freq", static_cast<float>(eqCentre)), "EQ freq");
        need(eq.setBandParam(0, "gain", neutral ? 0.0f : -12.0f), "EQ gain");
        need(eq.setBandParam(0, "enabled", 1.0f), "EQ enabled");
        need(eq.setBandParam(0, "mode", 2.0f), "EQ mode");
        if (s.eqSens >= 0.0f) need(eq.setBandParam(0, "spec_sens", s.eqSens), "EQ spec_sens");
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

// 3. Suppression accuracy on an aligned pair (both channels, power-averaged).
static RC suppressionAccuracy(const Aligned& a, double sr, double f0, bool useL = true, bool useR = true)
{
    const auto pin  = welchPsd(a.in,  a.skip, a.n(), useL, useR);
    const auto pout = welchPsd(a.out, a.skip, a.n(), useL, useR);
    return removedCollateral(pin, pout, sr, f0);
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
struct PreEcho { double outVsIn = 0, errVsIn = 0; int bursts = 0; };

static PreEcho preEcho(const Aligned& a, double sr)
{
    const int w = static_cast<int>(std::llround(0.020 * sr));
    const auto onsets = burstOnsets(a.n(), sr);
    double s1 = 0, s2 = 0; int cnt = 0;
    for (int pos : onsets)
    {
        if (pos - w < 0 || pos > a.n()) continue;
        double ei = 0, eo = 0, ee = 0;
        for (int c = 0; c < 2; ++c)
            for (int i = pos - w; i < pos; ++i)
            {
                const double x = a.in.ch[c][static_cast<size_t>(i)], y = a.out.ch[c][static_cast<size_t>(i)];
                ei += x * x; eo += y * y; ee += (y - x) * (y - x);
            }
        s1 += dbPow(eo) - dbPow(ei); s2 += dbPow(ee) - dbPow(ei); ++cnt;
    }
    PreEcho r; r.bursts = cnt;
    if (cnt) { r.outVsIn = s1 / cnt; r.errVsIn = s2 / cnt; }
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
// main
// ============================================================================

static bool parseArgs(int argc, char** argv)
{
    for (int i = 1; i < argc; ++i)
    {
        const std::string a = argv[i];
        if (a == "--quick") g_opt.quick = true;
        else if (a == "--no-cpu") g_opt.noCpu = true;
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

    const fs::path runDir = fs::path(g_opt.outBase) / (stamp + "_" + hash + (g_opt.quick ? "_quick" : ""));
    const fs::path wavDir = runDir / "wav";
    std::error_code ec;
    fs::create_directories(wavDir, ec);
    if (ec) { logf("cannot create %s", runDir.string().c_str()); return 3; }
    logf("output directory   : %s", runDir.string().c_str());

    const auto primary   = primarySubjects();
    const auto sensitive = sensitiveSubjects();
    std::vector<Subject> allSubjects = primary;
    allSubjects.insert(allSubjects.end(), sensitive.begin(), sensitive.end());

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
    Table tScanCsv; tScanCsv.header = { "subject", "sr", "f0_hz", "removed_db", "collateral_db", "removed_minus_collateral_db" };
    std::map<std::string, std::map<int, RC>> scanRes;       // key "S1@48000" -> f0 -> RC
    std::map<std::string, RC> r2500;                        // 48k, f0 2500
    std::map<std::string, Aligned> alignedA2500;
    for (double sr : rates)
    {
        const int n = static_cast<int>(sigSeconds() * sr);
        const Stereo base = makePinkStereo(n, -20.0, 1);
        for (double f0 : scanF0)
        {
            const Stereo sig = makeResonant(base, sr, f0, true, true);
            for (const auto& s : primary)
            {
                Fx fx = makeFx(s, sr, f0, false, kPrepareBlock);
                const Stereo out = renderStd(fx, sig);
                const auto a = align(sig, out, measureLatency(s, sr).measured, sr);
                const RC rc = suppressionAccuracy(a, sr, f0);
                scanRes[s.id + "@" + num(sr, 0)][static_cast<int>(f0)] = rc;
                tScanCsv.add({ s.id, num(sr, 0), num(f0, 0), num(rc.removed, 4), num(rc.collateral, 4), num(rc.removed - rc.collateral, 4) });
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
    for (double sr : rates)
    {
        Table t; t.title = "3. Suppression accuracy - resonance scan @" + num(sr, 0) + " Hz";
        t.note = "Signal A/B: 30 s pink (-20 dBFS RMS) + RBJ peak +12 dB Q 8 at f0 in both channels. Welch PSD (Hann 8192, 50 % overlap, first 2 s skipped), "
                 "channels power-averaged. removed = mean dB(PSDin - PSDout) over f0 +/- 1/6 oct; collateral = mean |dB(PSDin - PSDout)| over 100 Hz-12 kHz excluding f0 +/- 1/3 oct. "
                 "Each cell: removed / collateral / removed-collateral (dB). S5's band centre = f0.";
        t.header = { "f0 Hz" };
        for (const auto& s : primary) t.header.push_back(s.id);
        for (double f0 : scanF0)
        {
            std::vector<std::string> row = { num(f0, 0) };
            for (const auto& s : primary)
            {
                const RC rc = scanRes[s.id + "@" + num(sr, 0)][static_cast<int>(f0)];
                row.push_back(num(rc.removed, 2) + " / " + num(rc.collateral, 2) + " / " + num(rc.removed - rc.collateral, 2));
            }
            t.add(row);
        }
        tables.push_back(t);
    }

    // delta artefact (5) + WAVs for A@2500
    logf("[4/9] delta artefact energy + WAVs (A@2500)");
    Table tDel; tDel.title = "5. Delta artefact energy (signal A, f0 = 2500 Hz, 48 kHz)";
    tDel.note = "Energy of (in_aligned - out_aligned) OUTSIDE f0 +/- 1/3 octave, relative to total input energy, in dB (Welch PSD sums, first 2 s skipped).";
    tDel.header = { "subject", "label", "delta energy outside band vs input (dB)" };
    for (const auto& s : primary)
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
        tJit.add({ s.id, s.label, s.params, num(j.stdAll, 4), num(j.isoAll, 6), num(j.stdLoc, 4), num(j.isoLoc, 6),
                   inum(j.bands) + " (" + inum(j.bandsLoc) + ")", inum(j.frames) });
    }
    csvTables["jitter"] = tJit; tables.push_back(tJit);

    // ---------------------------------------------------------------- pre-echo (6)
    logf("[6/9] pre-echo (signal D) + WAVs");
    Table tPre; tPre.title = "6. Pre-echo (signal D, 48 kHz)";
    tPre.note = "-40 dBFS pink bed + noise bursts (-10 dBFS RMS at onset, 80 ms exp. decay time constant) every 500 ms. For each onset: 10log10(E_out/E_in) of the 20 ms BEFORE the onset "
                "(aligned, both channels), mean over bursts (dB). Column 1 (the specified metric) = 10log10(E_out/E_in): >0 = more energy before the onset in the output than in the input. "
                "Column 2 (supplementary) = 10log10(E_(out-in)/E_in): energy of the difference signal in that window relative to the input there.";
    tPre.header = { "subject", "label", "pre-onset E_out vs E_in (dB)", "pre-onset E_(out-in) vs E_in (dB)", "bursts" };
    for (const auto& s : primary)
    {
        Fx fx = makeFx(s, SR, 2500.0, false, kPrepareBlock);
        const Stereo out = renderStd(fx, sigD);
        const auto a = align(sigD, out, measureLatency(s, SR).measured, SR);
        const PreEcho pe = preEcho(a, SR);
        tPre.add({ s.id, s.label, num(pe.outVsIn, 3), num(pe.errVsIn, 2), inum(pe.bursts) });
        writeWav(wavDir / ("D_" + s.id + "_out.wav"),   a.out, SR);
        writeWav(wavDir / ("D_" + s.id + "_delta.wav"), deltaOf(a), SR);
    }
    csvTables["preecho"] = tPre; tables.push_back(tPre);

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
    {
        const Stereo sigE = makeResonant(pinkC, SR, 2500.0, false, true);
        for (const auto& s : primary)
        {
            Fx fx = makeFx(s, SR, 2500.0, false, kPrepareBlock);
            const Stereo out = renderStd(fx, sigE);
            const auto a = align(sigE, out, measureLatency(s, SR).measured, SR);
            const RC rR = suppressionAccuracy(a, SR, 2500.0, false, true);
            const RC rL = suppressionAccuracy(a, SR, 2500.0, true, false);
            tRight.add({ s.id, s.label, num(rR.removed, 2), num(rL.removed, 2), num(rR.collateral, 2), num(rL.collateral, 2) });
        }
    }
    csvTables["right_only"] = tRight; tables.push_back(tRight);

    // ---------------------------------------------------------------- CPU (9)
    Table tCpu; tCpu.title = "9. CPU (48 kHz stereo)";
    tCpu.header = { "subject", "label", "block", "median ns", "p95 ns", "p99 ns", "max ns", "mean ns", "median % RT", "p95 % RT", "mean % RT", "max % RT" };
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
        for (int block : { 64, 128, 512 })
            for (const auto& s : primary)
            {
                const auto r = cpuBench(s, cpuSig, SR, block);
                const double budget = block / SR * 1.0e9;
                tCpu.add({ s.id, s.label, inum(block), num(r.medianNs, 0), num(r.p95Ns, 0), num(r.p99Ns, 0), num(r.maxNs, 0), num(r.meanNs, 0),
                           num(100.0 * r.medianNs / budget, 3), num(100.0 * r.p95Ns / budget, 3), num(100.0 * r.meanNs / budget, 3), num(100.0 * r.maxNs / budget, 3) });
                logf("      %s block %d: mean %.0f ns (%.3f %% RT)  median %.0f  p95 %.0f  max %.0f", s.id.c_str(), block, r.meanNs, 100.0 * r.meanNs / budget, r.medianNs, r.p95Ns, r.maxNs);
            }
    }
    csvTables["cpu"] = tCpu; tables.push_back(tCpu);

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
          "S5s runs sens 1.0 exactly as specified; S5z runs sens 0.0 (the most sensitive) so the false-trigger direction is covered.\n\n";
    md << san.str();
    for (const auto& t : tables) md << t.markdown();
    std::ofstream(runDir / "summary.md", std::ios::binary) << md.str();

    logf("wrote %zu CSVs, summary.md and WAVs to %s", csvTables.size(), runDir.string().c_str());
    logf("done. non-finite=%d warnings=%d", g_nonFinite, g_warnings);
    return (g_nonFinite == 0) ? 0 : 1;
}
