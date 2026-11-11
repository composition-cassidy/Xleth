#include "dsp/stereoize/StereoizeCore.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace xleth::dsp::stereoize
{
namespace
{

constexpr double kPi = 3.14159265358979323846;

constexpr int   kCtrlInterval        = 16;      // filter coefficient grid (divides kGrid)
constexpr int   kDiffuseStages       = 5;
constexpr int   kNumDiffuseSets      = 6;
constexpr int   kMaxCombTaps         = 6;
constexpr int   kMaxVelvetTaps       = 32;
constexpr int   kVelvetTargetTaps    = 30;
constexpr int   kVelvetCandidates    = 6;
constexpr int   kVelvetSignPasses    = 4;
constexpr float kVelvetLenPerSize    = 3.75f;   // 8 ms Size -> 30 ms sequence
constexpr float kVelvetMinMs         = 2.0f;
constexpr float kVelvetMaxMs         = 60.0f;
constexpr float kVelvetEndDb         = -9.0f;   // amplitude of the last impulse relative to the first
constexpr float kVelvetStartMin      = 0.01f;   // seeded start offset, fraction of the length
constexpr float kVelvetStartSpan     = 0.06f;
constexpr double kPinkLoHz           = 40.0;    // band of the 1/f model the Velvet signs are balanced on
constexpr double kPinkHiHz           = 20000.0;
constexpr float kDiffuseT60MaxMs     = 60.0f;   // per stage (US6111958: keep the decorrelator IR < 60 ms)
constexpr float kDiffusePredelayRatio = 0.125f; // pre-delay = Size / 8 (1 ms at the default)
constexpr float kDiffuseLenJitter    = 0.10f;
constexpr float kDiffusePredelayJitter = 0.20f;
constexpr float kDiffusePreRollT60s  = 1.5f;    // settle to about -90 dB before the crossfade
constexpr float kMaxPreRollMs        = 200.0f;
constexpr float kCombTauJitter       = 0.15f;
constexpr int   kCombPreRoll         = kGrid;   // the two first-order all-passes settle in < 64 samples
constexpr float kMeterTauMs          = 300.0f;
constexpr float kDryMatchTauMs       = 400.0f;
constexpr float kDryMatchMaxGain     = 2.66f;   // +8.5 dB, above the +7 dB of 200 %

// Transient Guard (spec 4.4)
constexpr float kGuardFastAttackMs   = 0.5f;
constexpr float kGuardFastReleaseMs  = 15.0f;
constexpr float kGuardSlowAttackMs   = 20.0f;
constexpr float kGuardSlowReleaseMs  = 80.0f;
constexpr float kDuckAttackMs        = 1.0f;
constexpr float kDuckReleaseMs       = 30.0f;
constexpr float kGuardThreshold      = 0.5f;    // (fast - slow) / slow below this never ducks
constexpr float kGuardSlope          = 1.0f;    // full duck at fast = 2.5 x slow

// Diffuse coefficient sets at 44.1 kHz for the default 8 ms Size. Set 0 is Maher 1997 (left column);
// the others keep its structure (one long stage, decreasing, |a| about 0.68) with other lengths and
// sign patterns so different seeds give unrelated impulse responses.
struct DiffuseSet
{
    int   len[kDiffuseStages];
    float coeff[kDiffuseStages];
};

constexpr DiffuseSet kDiffuseSets[kNumDiffuseSets] = {
    { { 169, 51, 18, 13,  5 }, {  0.684f,  0.678f, -0.673f,  0.692f,  0.686f } },
    { { 157, 61, 23, 11,  7 }, { -0.671f,  0.689f,  0.677f, -0.664f,  0.695f } },
    { { 181, 43, 29, 17,  3 }, {  0.690f, -0.676f,  0.668f,  0.681f, -0.687f } },
    { { 149, 67, 31, 19,  9 }, {  0.662f,  0.698f, -0.688f, -0.672f,  0.680f } },
    { { 173, 47, 37,  7, 11 }, { -0.683f, -0.670f,  0.691f,  0.676f,  0.666f } },
    { { 163, 57, 27, 15,  4 }, {  0.675f,  0.667f,  0.684f, -0.695f, -0.679f } },
};

constexpr int maxDiffuseBaseLen(int stage) noexcept
{
    int m = 0;
    for (const auto& s : kDiffuseSets) m = s.len[stage] > m ? s.len[stage] : m;
    return m;
}

int nextPow2(int v) noexcept
{
    int p = 1;
    while (p < v) p <<= 1;
    return p;
}

int roundUpToGrid(int v) noexcept
{
    return ((std::max(0, v) + kGrid - 1) / kGrid) * kGrid;
}

// Deterministic generator: one independent stream per (variation, purpose).
struct SplitMix
{
    std::uint64_t s;
    std::uint64_t next() noexcept
    {
        std::uint64_t z = (s += 0x9E3779B97F4A7C15ull);
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
        return z ^ (z >> 31);
    }
    float uniform01() noexcept { return static_cast<float>(next() >> 40) * (1.0f / 16777216.0f); }
    float bipolar() noexcept { return uniform01() * 2.0f - 1.0f; }
};

SplitMix streamFor(int variation, std::uint64_t purpose) noexcept
{
    SplitMix r { (static_cast<std::uint64_t>(variation) + 1ull) * 0x100000001B3ull ^ (purpose * 0xD6E8FEB86659FD93ull) };
    r.next();
    return r;
}

struct LinearRamp
{
    float cur = 0.0f, tgt = 0.0f, step = 0.0f;
    int   left = 0, len = 1;

    void setLength(int n) noexcept { len = std::max(1, n); }
    void snap(float v) noexcept { cur = tgt = v; step = 0.0f; left = 0; }
    void setTarget(float v) noexcept
    {
        if (v == tgt) return;
        tgt  = v;
        left = len;
        step = (tgt - cur) / static_cast<float>(len);
    }
    bool active() const noexcept { return left > 0; }
    // The value k samples from now, without advancing.
    float peek(int k) const noexcept
    {
        if (left <= 0) return cur;
        return k >= left ? tgt : cur + step * static_cast<float>(k);
    }
    float next() noexcept
    {
        if (left > 0)
        {
            cur += step;
            if (--left == 0) cur = tgt;
        }
        return cur;
    }
};

// Zavalishin TPT state-variable high-pass (modulation-safe).
struct SvfHp
{
    float ic1 = 0.0f, ic2 = 0.0f;
    float a1 = 1.0f, a2 = 0.0f, a3 = 0.0f;
    float k = 1.41421356f;

    void setQ(float q) noexcept { k = 1.0f / q; }
    void setG(float g) noexcept
    {
        a1 = 1.0f / (1.0f + g * (g + k));
        a2 = g * a1;
        a3 = g * a2;
    }
    void reset() noexcept { ic1 = ic2 = 0.0f; }
    // Near FLT_MIN, flush-to-zero drops the g x state increments of a low cutoff, and the
    // integrators freeze at a tiny non-zero value instead of decaying. Called once per chunk.
    void snapTiny() noexcept
    {
        if (std::fabs(ic1) < 1e-25f) ic1 = 0.0f;
        if (std::fabs(ic2) < 1e-25f) ic2 = 0.0f;
    }
    float process(float x) noexcept
    {
        const float v3 = x - ic2;
        const float v1 = a1 * ic1 + a2 * v3;
        const float v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2.0f * v1 - ic1;
        ic2 = 2.0f * v2 - ic2;
        return x - k * v1 - v2;
    }
};

// TPT one-pole low-pass.
struct OnePoleLp
{
    float s = 0.0f, G = 1.0f;
    void setG(float g) noexcept { G = g / (1.0f + g); }
    void reset() noexcept { s = 0.0f; }
    void snapTiny() noexcept { if (std::fabs(s) < 1e-25f) s = 0.0f; }
    float process(float x) noexcept
    {
        const float v = (x - s) * G;
        const float y = v + s;
        s = y + v;
        return y;
    }
};

float onePoleCoeff(float ms, double fs) noexcept
{
    return static_cast<float>(std::exp(-1.0 / (static_cast<double>(ms) * 0.001 * fs)));
}

// Mirrored ring of the mid signal: every sample is stored at j and j + size, so any window of up to
// `size` samples starting anywhere is contiguous.
struct History
{
    std::vector<float> buf;
    int size = 0, mask = 0, pos = 0;

    void prepare(int minSize)
    {
        size = nextPow2(std::max(minSize, kGrid * 2));
        mask = size - 1;
        buf.assign(static_cast<std::size_t>(size) * 2u, 0.0f);
        pos = 0;
    }
    void clear() noexcept
    {
        std::fill(buf.begin(), buf.end(), 0.0f);
        pos = 0;
    }
    // Writes n samples; returns the ring index of the first.
    int write(const float* x, int n) noexcept
    {
        const int start = pos;
        float* b = buf.data();
        for (int i = 0; i < n; ++i)
        {
            const int j = (start + i) & mask;
            b[j]        = x[i];
            b[j + size] = x[i];
        }
        pos = (start + n) & mask;
        return start;
    }
    // window(start, lag)[i] = the sample written `lag` samples before chunk sample i.
    const float* window(int chunkStart, int lag) const noexcept
    {
        return buf.data() + ((chunkStart - lag) & mask);
    }
};

struct EngineConfig
{
    Character character = Character::Diffuse;
    float     sizeMs    = kDefaultSizeMs;
    int       variation = 0;
};

bool sameConfig(const EngineConfig& a, const EngineConfig& b) noexcept
{
    return a.character == b.character && a.sizeMs == b.sizeMs && a.variation == b.variation;
}

struct Engine
{
    EngineConfig cfg;
    int preRoll = 0;

    // Comb
    int   combTau = 1;
    float apC[2]  = { 0.0f, 0.0f };
    float apX1[2] = { 0.0f, 0.0f };
    float apY1[2] = { 0.0f, 0.0f };
    float combFbCached = -1.0f;
    int   combTaps = 1;
    float combGain[kMaxCombTaps] = { 1.0f };

    // Diffuse
    int   predelay = 1;
    int   len[kDiffuseStages]   = {};
    float coeff[kDiffuseStages] = {};
    std::vector<float> ring[kDiffuseStages];
    int   ringMask[kDiffuseStages] = {};
    int   ringPos[kDiffuseStages]  = {};

    // Velvet
    int   vTaps = 0;
    int   vLength = 0;
    int   vLag[kMaxVelvetTaps]    = {};
    float vGain[kMaxVelvetTaps]   = {};

    void clearState() noexcept
    {
        for (int k = 0; k < 2; ++k) apX1[k] = apY1[k] = 0.0f;
        combFbCached = -1.0f;
        for (int s = 0; s < kDiffuseStages; ++s)
        {
            std::fill(ring[s].begin(), ring[s].end(), 0.0f);
            ringPos[s] = 0;
        }
    }

    void updateCombGains(float fb) noexcept
    {
        combFbCached = fb;
        if (fb <= 0.0f)
        {
            combTaps    = 1;
            combGain[0] = 1.0f;
            return;
        }
        combTaps = kMaxCombTaps;
        float p = 1.0f, energy = 0.0f;
        for (int k = 0; k < kMaxCombTaps; ++k)
        {
            combGain[k] = p;
            energy += p * p;
            p *= fb;
        }
        const float norm = 1.0f / std::sqrt(energy);
        for (int k = 0; k < kMaxCombTaps; ++k) combGain[k] *= norm;
    }
};

// ── Configuration (pure functions of the config and the rate) ───────────────

void configureComb(Engine& e, const EngineConfig& c, double fs) noexcept
{
    // Golden-ratio sequence: neighbouring seeds land far apart in the +-15 % range.
    const double u   = std::fmod(0.5 + 0.6180339887498949 * static_cast<double>(c.variation), 1.0);
    const double off = (2.0 * u - 1.0) * static_cast<double>(kCombTauJitter);
    e.combTau = std::max(1, static_cast<int>(std::lround(static_cast<double>(c.sizeMs) * (1.0 + off) * fs * 0.001)));

    auto rng = streamFor(c.variation, 0xC0BBull);
    for (int k = 0; k < 2; ++k)
    {
        const float mag = 0.2f + 0.3f * rng.uniform01();
        e.apC[k] = rng.uniform01() < 0.5f ? -mag : mag;
    }
    e.combFbCached = -1.0f;
    e.preRoll = kCombPreRoll;
}

void configureDiffuse(Engine& e, const EngineConfig& c, double fs) noexcept
{
    const auto& set = kDiffuseSets[c.variation % kNumDiffuseSets];
    auto rng = streamFor(c.variation, 0xD1FFull);
    const double scale = (static_cast<double>(c.sizeMs) / static_cast<double>(kDefaultSizeMs)) * (fs / 44100.0);
    const double t60Max = static_cast<double>(kDiffuseT60MaxMs) * 0.001 * fs;

    double t60Sum = 0.0;
    int lenSum = 0;
    for (int s = 0; s < kDiffuseStages; ++s)
    {
        const double jit = 1.0 + static_cast<double>(kDiffuseLenJitter) * static_cast<double>(rng.bipolar());
        int n = std::max(1, static_cast<int>(std::lround(set.len[s] * scale * jit)));
        n = std::min(n, e.ringMask[s]);   // ring is sized for the worst case; this never binds in range
        e.len[s] = n;

        const double cap = std::exp(-6.907755 * static_cast<double>(n) / t60Max);
        const double mag = std::min(std::fabs(static_cast<double>(set.coeff[s])), cap);
        e.coeff[s] = static_cast<float>(set.coeff[s] < 0.0f ? -mag : mag);

        const double t60 = mag > 1e-6 ? 6.907755 * static_cast<double>(n) / -std::log(mag) : static_cast<double>(n);
        t60Sum += std::max(static_cast<double>(n), t60);
        lenSum += n;
    }

    const double pjit = 1.0 + static_cast<double>(kDiffusePredelayJitter) * static_cast<double>(rng.bipolar());
    e.predelay = std::max(1, static_cast<int>(std::lround(static_cast<double>(c.sizeMs * kDiffusePredelayRatio) * pjit * fs * 0.001)));

    const double pre = static_cast<double>(e.predelay + lenSum) + static_cast<double>(kDiffusePreRollT60s) * t60Sum;
    e.preRoll = static_cast<int>(std::min(pre, static_cast<double>(kMaxPreRollMs) * 0.001 * fs));
}

// A unit-energy sparse FIR passes white noise at unit power, but on 1/f material its power is
// 1 + C with C = sum over tap pairs a_i a_j r(p_i - p_j) (r = the input's normalised
// autocorrelation), and its correlation with the mid is c = sum a_i r(p_i). Both swing by tens of
// percent from seed to seed, which is what puts a velvet decorrelator off the spec's width
// calibration and leans the image. Signs are free, so each candidate's signs are flipped greedily
// to drive C and c to zero against a 1/f autocorrelation (pinkR, exact, built in prepare()).
// O(taps^2) table reads per pass: about 20 k operations for the whole search.
void configureVelvet(Engine& e, const EngineConfig& c, double fs, const float* pinkR, int pinkLen) noexcept
{
    const float lenMs = std::clamp(c.sizeMs * kVelvetLenPerSize, kVelvetMinMs, kVelvetMaxMs);
    const int   L     = std::max(8, static_cast<int>(std::lround(static_cast<double>(lenMs) * 0.001 * fs)));
    const float decay = std::log(std::pow(10.0f, -kVelvetEndDb / 20.0f));
    auto rAt = [pinkR, pinkLen](int lag) noexcept {
        const int k = lag < 0 ? -lag : lag;
        return k < pinkLen ? pinkR[k] : 0.0f;
    };

    float bestJ = 1e30f;
    int   lag[kMaxVelvetTaps];
    float a[kMaxVelvetTaps];
    float S[kMaxVelvetTaps];

    for (int cand = 0; cand < kVelvetCandidates; ++cand)
    {
        auto rng = streamFor(c.variation, 0x5E1E7000ull + static_cast<std::uint64_t>(cand));
        // Seeded warp: the start offset and the density curve differ per seed, so two instances'
        // early (loudest) impulses rarely land on the same lags.
        const int   t0   = std::max(1, static_cast<int>(std::lround((kVelvetStartMin + kVelvetStartSpan * rng.uniform01()) * L)));
        const float warp = 1.15f + 0.25f * rng.uniform01();
        const int   M    = std::clamp((L - t0) / 2, 2, kVelvetTargetTaps);

        int prev = 0;
        int n = 0;
        float energy = 0.0f;
        for (int i = 0; i < M; ++i)
        {
            const float e0 = static_cast<float>(t0) + static_cast<float>(L - t0) * std::pow(static_cast<float>(i) / M, warp);
            const float e1 = static_cast<float>(t0) + static_cast<float>(L - t0) * std::pow(static_cast<float>(i + 1) / M, warp);
            int p = static_cast<int>(e0 + rng.uniform01() * std::max(1.0f, e1 - e0));
            p = std::max(p, prev + 1);
            const float sign = rng.uniform01() < 0.5f ? -1.0f : 1.0f;
            if (p > L) break;
            lag[n] = p;
            a[n]   = sign * std::exp(-decay * static_cast<float>(p) / static_cast<float>(L));
            energy += a[n] * a[n];
            prev = p;
            ++n;
        }
        const float norm = 1.0f / std::sqrt(std::max(energy, 1e-12f));
        for (int i = 0; i < n; ++i) a[i] *= norm;

        // Greedy sign balancing on J = C^2 + c^2.
        float C = 0.0f, cm = 0.0f;
        for (int i = 0; i < n; ++i)
        {
            float s = 0.0f;
            for (int j = 0; j < n; ++j)
                if (j != i) s += a[j] * rAt(lag[i] - lag[j]);
            S[i] = s;
            C  += a[i] * s;
            cm += a[i] * rAt(lag[i]);
        }
        for (int pass = 0; pass < kVelvetSignPasses; ++pass)
        {
            bool flipped = false;
            for (int i = 0; i < n; ++i)
            {
                const float nC = C - 4.0f * a[i] * S[i];
                const float nc = cm - 2.0f * a[i] * rAt(lag[i]);
                if (nC * nC + nc * nc < C * C + cm * cm)
                {
                    for (int j = 0; j < n; ++j)
                        if (j != i) S[j] -= 2.0f * a[i] * rAt(lag[j] - lag[i]);
                    a[i] = -a[i];
                    C = nC;
                    cm = nc;
                    flipped = true;
                }
            }
            if (!flipped) break;
        }

        const float J = C * C + cm * cm;
        if (J < bestJ)
        {
            bestJ = J;
            e.vTaps = n;
            for (int i = 0; i < n; ++i) { e.vLag[i] = lag[i]; e.vGain[i] = a[i]; }
        }
    }
    e.vLength = L;
    e.preRoll = 0;
}

void configureEngine(Engine& e, const EngineConfig& c, double fs, const float* pinkR, int pinkLen) noexcept
{
    e.cfg = c;
    switch (c.character)
    {
        case Character::Comb:    configureComb(e, c, fs); break;
        case Character::Diffuse: configureDiffuse(e, c, fs); break;
        case Character::Velvet:  configureVelvet(e, c, fs, pinkR, pinkLen); break;
    }
}

// ── Rendering one chunk (n <= kGrid) ────────────────────────────────────────

void renderEngine(Engine& e, const History& h, int chunkStart, int n, const float* fb, float* out) noexcept
{
    switch (e.cfg.character)
    {
        case Character::Comb:
        {
            const float* tap[kMaxCombTaps];
            for (int k = 0; k < kMaxCombTaps; ++k) tap[k] = h.window(chunkStart, (k + 1) * e.combTau);
            for (int i = 0; i < n; ++i)
            {
                if (fb[i] != e.combFbCached) e.updateCombGains(fb[i]);
                float acc = e.combGain[0] * tap[0][i];
                for (int k = 1; k < e.combTaps; ++k) acc += e.combGain[k] * tap[k][i];
                out[i] = acc;
            }
            for (int k = 0; k < 2; ++k)
            {
                const float c = e.apC[k];
                float x1 = e.apX1[k], y1 = e.apY1[k];
                for (int i = 0; i < n; ++i)
                {
                    const float x = out[i];
                    const float y = c * x + x1 - c * y1;
                    x1 = x;
                    y1 = y;
                    out[i] = y;
                }
                e.apX1[k] = x1;
                e.apY1[k] = y1;
            }
            break;
        }

        case Character::Diffuse:
        {
            const float* src = h.window(chunkStart, e.predelay);
            std::memcpy(out, src, sizeof(float) * static_cast<std::size_t>(n));
            for (int s = 0; s < kDiffuseStages; ++s)
            {
                float* ring = e.ring[s].data();
                const int mask = e.ringMask[s];
                const int N = e.len[s];
                const float a = e.coeff[s];
                int pos = e.ringPos[s];
                for (int i = 0; i < n; ++i)
                {
                    const float vN = ring[(pos - N) & mask];
                    const float v  = out[i] + a * vN;
                    ring[pos] = v;
                    out[i] = vN - a * v;
                    pos = (pos + 1) & mask;
                }
                e.ringPos[s] = pos;
            }
            break;
        }

        case Character::Velvet:
        {
            std::fill(out, out + n, 0.0f);
            for (int k = 0; k < e.vTaps; ++k)
            {
                const float* p = h.window(chunkStart, e.vLag[k]);
                const float g = e.vGain[k];
                for (int i = 0; i < n; ++i) out[i] += g * p[i];
            }
            break;
        }
    }
}

float lerpCurve(float widthPct, int field) noexcept
{
    constexpr int count = static_cast<int>(sizeof(kWidthCurve) / sizeof(kWidthCurve[0]));
    auto value = [field](const WidthPoint& p) noexcept { return field == 0 ? p.gain : p.combFeedback; };
    if (!(widthPct > kWidthCurve[0].widthPct)) return value(kWidthCurve[0]);
    for (int i = 1; i < count; ++i)
    {
        if (widthPct <= kWidthCurve[i].widthPct)
        {
            const auto& a = kWidthCurve[i - 1];
            const auto& b = kWidthCurve[i];
            const float t = (widthPct - a.widthPct) / (b.widthPct - a.widthPct);
            return value(a) + t * (value(b) - value(a));
        }
    }
    return value(kWidthCurve[count - 1]);
}

float finiteOr(float v, float fallback) noexcept { return std::isfinite(v) ? v : fallback; }

Params sanitise(const Params& in) noexcept
{
    const Params def;
    Params p = in;
    p.widthPct    = std::clamp(finiteOr(p.widthPct, def.widthPct), kMinWidthPct, kMaxWidthPct);
    p.sizeMs      = std::clamp(finiteOr(p.sizeMs, def.sizeMs), kMinSizeMs, kMaxSizeMs);
    p.sizeMs      = std::round(p.sizeMs * 100.0f) / 100.0f;   // structural: 10 us steps
    p.lowBypassHz = std::clamp(finiteOr(p.lowBypassHz, def.lowBypassHz), kMinLowBypassHz, kMaxLowBypassHz);
    p.hfDampHz    = std::clamp(finiteOr(p.hfDampHz, def.hfDampHz), kMinHfDampHz, kHfDampOffHz);
    p.guard       = std::clamp(finiteOr(p.guard, def.guard), 0.0f, 1.0f);
    p.variation   = std::clamp(p.variation, 0, kMaxVariation);
    const int ch  = static_cast<int>(p.character);
    if (ch < 0 || ch > 2) p.character = def.character;
    if (static_cast<int>(p.lowSlope) != 1) p.lowSlope = LowSlope::Db12;
    return p;
}

} // namespace

namespace detail
{
// Ci(x) = gamma + ln x + integral_0^x (cos t - 1) / t dt. Power series below 4 (exact to double
// rounding there), Abramowitz & Stegun 5.2.38 / 5.2.39 rational auxiliary functions above
// (|error| < 5e-7).
double cosineIntegral(double x) noexcept
{
    if (!(x > 0.0)) return -1e300;
    if (x < 4.0)
    {
        const double x2 = x * x;
        double term = 1.0, sum = 0.0;
        for (int k = 1; k < 60; ++k)
        {
            term *= -x2 / (static_cast<double>(2 * k - 1) * static_cast<double>(2 * k));
            const double add = term / (2.0 * k);
            sum += add;
            if (std::fabs(add) < 1e-18) break;
        }
        return 0.57721566490153286 + std::log(x) + sum;
    }
    const double x2 = x * x, x4 = x2 * x2, x6 = x4 * x2, x8 = x4 * x4;
    const double f = (x8 + 38.027264 * x6 + 265.187033 * x4 + 335.677320 * x2 + 38.102495)
                   / (x8 + 40.021433 * x6 + 322.624911 * x4 + 570.236280 * x2 + 157.105423) / x;
    const double g = (x8 + 42.242855 * x6 + 302.757865 * x4 + 352.018498 * x2 + 21.821899)
                   / (x8 + 48.196927 * x6 + 482.485984 * x4 + 1114.978885 * x2 + 449.690326) / x2;
    return f * std::sin(x) - g * std::cos(x);
}

// Normalised autocorrelation of band-limited 1/f noise (equal power per octave from loHz to hiHz).
double pinkAutocorrelation(double tauSeconds, double loHz, double hiHz) noexcept
{
    const double t = std::fabs(tauSeconds);
    if (t <= 0.0) return 1.0;
    return (cosineIntegral(2.0 * kPi * hiHz * t) - cosineIntegral(2.0 * kPi * loHz * t)) / std::log(hiHz / loHz);
}
} // namespace detail

float widthToGain(float widthPct) noexcept { return lerpCurve(widthPct, 0); }
float widthToCombFeedback(float widthPct) noexcept { return lerpCurve(widthPct, 1); }

// ─────────────────────────────────────────────────────────────────────────────

struct Core::Impl
{
    double fs = 48000.0;
    bool   prepared  = false;
    bool   needsSnap = true;
    long long absPos = 0;

    History hist;
    Engine  eng[2];
    int     active = 0;
    enum class Phase { Idle, PreRoll, Fade } phase = Phase::Idle;
    int     phaseLeft = 0;
    int     fadeLen   = kGrid;
    std::vector<float> fadeShape;   // raised cosine, fadeShape[k] = weight of the new engine k samples into the fade
    std::vector<float> pinkR;       // detail::pinkAutocorrelation per lag in samples, 0 .. Velvet max length
    EngineConfig want;
    long long switchCount = 0;

    LinearRamp gain, fb, lowLog2, hfLog2, hfMix, slopeMix, loudMix, guardAmt, monoMix, cmpMix, cmpGain;

    OnePoleLp hfLp;
    SvfHp     hp12, hp24a, hp24b;
    // Filter warp g = tan(pi fc / fs): computed on the 16-sample grid for the cutoff the ramp will
    // have at the NEXT grid point, and linearly interpolated per sample in between, so a moving
    // cutoff never steps the coefficients.
    float     gLow = 0.0f, gLowStep = 0.0f, gLowLast = -1.0f;
    float     gHf  = 0.0f, gHfStep  = 0.0f, gHfLast  = -1.0f;

    float envFast = 0.0f, envSlow = 0.0f, duck = 1.0f;
    bool  guardRunning = false;
    float cFastA = 0, cFastR = 0, cSlowA = 0, cSlowR = 0, cDuckA = 0, cDuckR = 0;

    double emaLL = 0, emaRR = 0, emaLR = 0, emaMM = 0, emaSS = 0, emaMS = 0, emaWet = 0, emaDry = 0;
    Meters meters;

    float m[kGrid]  = {};
    float d[kGrid]  = {};
    float dB[kGrid] = {};
    float fbA[kGrid] = {};

    void prepare(double sampleRate)
    {
        fs = sampleRate > 0.0 ? sampleRate : 48000.0;
        const double msToS = fs * 0.001;

        const int combLag    = kMaxCombTaps * static_cast<int>(std::ceil(kMaxSizeMs * (1.0f + kCombTauJitter) * msToS));
        const int velvetLag  = static_cast<int>(std::ceil(kVelvetMaxMs * msToS)) + 1;
        const int predelayLag = static_cast<int>(std::ceil(kMaxSizeMs * kDiffusePredelayRatio * (1.0f + kDiffusePredelayJitter) * msToS)) + 1;
        hist.prepare(std::max({ combLag, velvetLag, predelayLag }) + kGrid + 2);

        const double maxScale = (kMaxSizeMs / kDefaultSizeMs) * (fs / 44100.0) * (1.0 + kDiffuseLenJitter);
        for (auto& e : eng)
        {
            for (int s = 0; s < kDiffuseStages; ++s)
            {
                const int maxN = static_cast<int>(std::ceil(maxDiffuseBaseLen(s) * maxScale)) + 2;
                const int size = nextPow2(maxN + 1);
                e.ring[s].assign(static_cast<std::size_t>(size), 0.0f);
                e.ringMask[s] = size - 1;
                e.ringPos[s] = 0;
            }
        }

        const int paramRamp   = std::max(1, static_cast<int>(std::lround(kParamRampMs * msToS)));
        const int monitorRamp = std::max(1, static_cast<int>(std::lround(kMonitorRampMs * msToS)));
        for (auto* r : { &gain, &fb, &lowLog2, &hfLog2, &hfMix, &slopeMix, &loudMix, &guardAmt }) r->setLength(paramRamp);
        monoMix.setLength(monitorRamp);
        cmpMix.setLength(monitorRamp);
        cmpGain.setLength(kGrid);
        fadeLen = roundUpToGrid(static_cast<int>(std::lround(kSwitchFadeMs * msToS)));
        // Raised cosine: a linear fade's corners are slope steps that reach -55 dB above 4 kHz on a
        // low tone; this one's first derivative is continuous at both ends.
        fadeShape.resize(static_cast<std::size_t>(fadeLen));
        for (int k = 0; k < fadeLen; ++k)
            fadeShape[static_cast<std::size_t>(k)] = static_cast<float>(0.5 - 0.5 * std::cos(kPi * k / fadeLen));

        const double hiHz = std::min(kPinkHiHz, 0.45 * fs);
        pinkR.resize(static_cast<std::size_t>(velvetLag) + 1u);
        for (std::size_t k = 0; k < pinkR.size(); ++k)
            pinkR[k] = static_cast<float>(detail::pinkAutocorrelation(static_cast<double>(k) / fs, kPinkLoHz, hiHz));

        hp12.setQ(0.70710678f);
        hp24a.setQ(0.54119610f);
        hp24b.setQ(1.30656296f);

        cFastA = onePoleCoeff(kGuardFastAttackMs, fs);
        cFastR = onePoleCoeff(kGuardFastReleaseMs, fs);
        cSlowA = onePoleCoeff(kGuardSlowAttackMs, fs);
        cSlowR = onePoleCoeff(kGuardSlowReleaseMs, fs);
        cDuckA = onePoleCoeff(kDuckAttackMs, fs);
        cDuckR = onePoleCoeff(kDuckReleaseMs, fs);

        prepared = true;
        reset();
    }

    void reset() noexcept
    {
        hist.clear();
        for (auto& e : eng) e.clearState();
        hfLp.reset();
        hp12.reset();
        hp24a.reset();
        hp24b.reset();
        envFast = envSlow = 0.0f;
        duck = 1.0f;
        guardRunning = false;
        emaLL = emaRR = emaLR = emaMM = emaSS = emaMS = emaWet = emaDry = 0.0;
        meters = Meters {};
        phase = Phase::Idle;
        phaseLeft = 0;
        absPos = 0;
        needsSnap = true;
    }

    static EngineConfig configFrom(const Params& p) noexcept
    {
        EngineConfig c;
        c.character = p.character;
        c.sizeMs = p.sizeMs;
        c.variation = p.variation;
        return c;
    }

    void applyTargets(const Params& p, bool snap) noexcept
    {
        auto set = [snap](LinearRamp& r, float v) noexcept { if (snap) r.snap(v); else r.setTarget(v); };
        const bool hfOn = p.hfDampHz < kHfDampOffHz;
        set(gain,     widthToGain(p.widthPct));
        set(fb,       widthToCombFeedback(p.widthPct));
        set(lowLog2,  std::log2(p.lowBypassHz));
        // While off, the cutoff target stays where it was so the filter does not sweep on the way out.
        if (hfOn || snap) set(hfLog2, std::log2(p.hfDampHz));
        set(hfMix,    hfOn ? 1.0f : 0.0f);
        set(slopeMix, p.lowSlope == LowSlope::Db24 ? 1.0f : 0.0f);
        set(loudMix,  p.loudnessMatch ? 1.0f : 0.0f);
        set(guardAmt, p.guard);
        set(monoMix,  p.monoCheck ? 1.0f : 0.0f);
        set(cmpMix,   p.compareDry ? 1.0f : 0.0f);
        want = configFrom(p);

        if (snap)
        {
            cmpGain.snap(1.0f);
            configureEngine(eng[active], want, fs, pinkR.data(), static_cast<int>(pinkR.size()));
            eng[active].clearState();
            phase = Phase::Idle;
            phaseLeft = 0;
            updateFilterCoeffs(true);
            needsSnap = false;
        }
    }

    float warp(float log2Hz) const noexcept
    {
        const float fc = std::min(std::exp2(log2Hz), static_cast<float>(fs * 0.49));
        return static_cast<float>(std::tan(kPi * fc / fs));
    }

    void applyLowG() noexcept
    {
        hp12.setG(gLow);
        hp24a.setG(gLow);
        hp24b.setG(gLow);
    }

    // One interpolation segment of a filter warp: aims g at `target` over kCtrlInterval samples.
    // Two equal targets in a row mean the cutoff has settled: snap exactly and stop interpolating.
    static bool planSegment(float target, float& g, float& step, float& last, bool force) noexcept
    {
        if (force)
        {
            g = target;
            step = 0.0f;
            last = target;
            return true;
        }
        if (target == last)
        {
            step = 0.0f;
            if (g == target) return false;
            g = target;
            return true;
        }
        step = (target - g) / static_cast<float>(kCtrlInterval);
        last = target;
        return false;
    }

    // On the 16-sample grid (and when snapping). Returns nothing; applies a snapped g at once.
    void updateFilterCoeffs(bool force) noexcept
    {
        if (planSegment(warp(lowLog2.peek(kCtrlInterval)), gLow, gLowStep, gLowLast, force)) applyLowG();
        if (planSegment(warp(hfLog2.peek(kCtrlInterval)), gHf, gHfStep, gHfLast, force)) hfLp.setG(gHf);
    }

    void beginSwitch() noexcept
    {
        Engine& p = eng[active ^ 1];
        configureEngine(p, want, fs, pinkR.data(), static_cast<int>(pinkR.size()));
        p.clearState();
        if (p.preRoll > 0)
        {
            phase = Phase::PreRoll;
            phaseLeft = roundUpToGrid(p.preRoll);
        }
        else
        {
            phase = Phase::Fade;
            phaseLeft = fadeLen;
        }
    }

    // Runs only on the kGrid grid.
    void stepStateMachine() noexcept
    {
        if (phase == Phase::PreRoll && phaseLeft <= 0)
        {
            phase = Phase::Fade;
            phaseLeft = fadeLen;
        }
        if (phase == Phase::Fade && phaseLeft <= 0)
        {
            active ^= 1;
            phase = Phase::Idle;
            ++switchCount;
        }
        if (phase == Phase::Idle)
        {
            if (!sameConfig(want, eng[active].cfg)) beginSwitch();
        }
        else if (phase == Phase::PreRoll && sameConfig(want, eng[active].cfg))
        {
            phase = Phase::Idle;   // changed back before anything was heard
            phaseLeft = 0;
        }
    }

    void process(float* L, float* R, int numSamples, const Params& raw) noexcept
    {
        const Params p = sanitise(raw);
        applyTargets(p, needsSnap);

        float minDuck = 1.0f;
        int offset = 0;
        while (offset < numSamples)
        {
            const int gridPhase = static_cast<int>(absPos % kGrid);
            const int n = std::min(kGrid - gridPhase, numSamples - offset);
            if (gridPhase == 0) stepStateMachine();
            processChunk(L + offset, R + offset, n, minDuck);
            offset += n;
            absPos += n;
        }

        meters.guardDepth = 1.0f - minDuck;
        meters.targetCorrelation = targetCorrelation(gain.cur);
        const double eps = 1e-20;
        meters.correlation = (emaLL > eps && emaRR > eps)
            ? static_cast<float>(std::clamp(emaLR / std::sqrt(emaLL * emaRR), -1.0, 1.0)) : 1.0f;
        meters.msCorrelation = (emaMM > eps && emaSS > eps)
            ? static_cast<float>(std::clamp(emaMS / std::sqrt(emaMM * emaSS), -1.0, 1.0)) : 0.0f;
        meters.midRmsDb  = static_cast<float>(10.0 * std::log10(emaMM + 1e-12));
        meters.sideRmsDb = static_cast<float>(10.0 * std::log10(emaSS + 1e-12));
        meters.dryMatchGainDb = 20.0f * std::log10(std::max(cmpGain.tgt, 1e-6f));
    }

    void processChunk(float* L, float* R, int n, float& minDuck) noexcept
    {
        // 1. Mid into the history.
        for (int i = 0; i < n; ++i)
        {
            const float mid = 0.5f * (L[i] + R[i]);
            m[i] = std::isfinite(mid) ? mid : 0.0f;
        }
        const int chunkStart = hist.write(m, n);

        // 2. Decorrelator(s).
        for (int i = 0; i < n; ++i) fbA[i] = fb.next();
        renderEngine(eng[active], hist, chunkStart, n, fbA, d);
        if (phase != Phase::Idle)
        {
            renderEngine(eng[active ^ 1], hist, chunkStart, n, fbA, dB);
            if (phase == Phase::Fade)
            {
                const float* w = fadeShape.data() + (fadeLen - phaseLeft);
                for (int i = 0; i < n; ++i) d[i] += w[i] * (dB[i] - d[i]);
            }
            phaseLeft -= n;
        }

        // 3. G chain and output.
        const bool hfRun  = hfMix.active() || hfMix.tgt > 0.0f;
        const bool run12  = slopeMix.active() || slopeMix.tgt < 0.5f;
        const bool run24  = slopeMix.active() || slopeMix.tgt > 0.5f;
        if (!hfRun) hfLp.reset();
        if (!run12) hp12.reset();
        if (!run24) { hp24a.reset(); hp24b.reset(); }

        const bool guardNow = guardAmt.active() || guardAmt.tgt > 0.0f || duck < 1.0f;
        if (guardNow && !guardRunning)
            envFast = envSlow = std::fabs(m[0]);   // equal envelopes: no false onset when the guard turns on
        guardRunning = guardNow;

        // Float sums: a chunk is at most kGrid samples.
        float sLL = 0, sRR = 0, sLR = 0, sMM = 0, sSS = 0, sMS = 0, sDry = 0;
        const long long chunkAbs = absPos;

        for (int i = 0; i < n; ++i)
        {
            if (((chunkAbs + i) & (kCtrlInterval - 1)) == 0) updateFilterCoeffs(false);
            lowLog2.next();
            hfLog2.next();
            if (gLowStep != 0.0f) { gLow += gLowStep; applyLowG(); }
            if (gHfStep != 0.0f)  { gHf  += gHfStep;  hfLp.setG(gHf); }

            float x = d[i];
            const float hm = hfMix.next();
            if (hfRun)
            {
                const float y = hfLp.process(x);
                x += hm * (y - x);
            }

            const float sm = slopeMix.next();
            if (run12 && run24)
            {
                const float y12 = hp12.process(x);
                const float y24 = hp24b.process(hp24a.process(x));
                x = y12 + sm * (y24 - y12);
            }
            else if (run24)
            {
                x = hp24b.process(hp24a.process(x));
            }
            else
            {
                x = hp12.process(x);
            }

            const float ga = guardAmt.next();
            if (guardRunning)
            {
                const float a = std::fabs(m[i]);
                envFast = a > envFast ? a + cFastA * (envFast - a) : a + cFastR * (envFast - a);
                envSlow = a > envSlow ? a + cSlowA * (envSlow - a) : a + cSlowR * (envSlow - a);
                const float rel = (envFast - envSlow) / (envSlow + 1e-9f);
                const float t = std::clamp((rel - kGuardThreshold) * kGuardSlope, 0.0f, 1.0f);
                const float target = 1.0f - ga * t;
                duck = target < duck ? target + cDuckA * (duck - target) : target + cDuckR * (duck - target);
                if (duck > 0.999999f && ga == 0.0f && !guardAmt.active()) duck = 1.0f;
                minDuck = std::min(minDuck, duck);
            }

            const float gg = gain.next();
            const float G  = x * duck * gg;
            const float inL = L[i], inR = R[i];
            float oL = inL + G;
            float oR = inR - G;

            const float lm = loudMix.next();
            if (lm > 0.0f)
            {
                const float k = 1.0f + lm * (1.0f / std::sqrt(1.0f + gg * gg) - 1.0f);
                oL *= k;
                oR *= k;
            }

            const float mid  = 0.5f * (oL + oR);
            const float side = 0.5f * (oL - oR);
            sLL += oL * oL;
            sRR += oR * oR;
            sLR += oL * oR;
            sMM += mid * mid;
            sSS += side * side;
            sMS += mid * side;
            sDry += inL * inL + inR * inR;

            const float cm = cmpMix.next();
            const float cg = cmpGain.next();
            if (cm > 0.0f)
            {
                oL += cm * (inL * cg - oL);
                oR += cm * (inR * cg - oR);
            }

            const float mm = monoMix.next();
            if (mm > 0.0f)
            {
                const float mono = 0.5f * (oL + oR);
                oL += mm * (mono - oL);
                oR += mm * (mono - oR);
            }

            L[i] = oL;
            R[i] = oR;
        }

        if (((chunkAbs + n) % kGrid) == 0)   // on the grid only, so the output stays block-size independent
        {
            hfLp.snapTiny();
            hp12.snapTiny();
            hp24a.snapTiny();
            hp24b.snapTiny();
        }

        // 4. Meters (block rate; never touch the audio).
        const double inv = 1.0 / n;
        const double a  = std::exp(-static_cast<double>(n) / (kMeterTauMs * 0.001 * fs));
        const double ad = std::exp(-static_cast<double>(n) / (kDryMatchTauMs * 0.001 * fs));
        emaLL = a * emaLL + (1.0 - a) * sLL * inv;
        emaRR = a * emaRR + (1.0 - a) * sRR * inv;
        emaLR = a * emaLR + (1.0 - a) * sLR * inv;
        emaMM = a * emaMM + (1.0 - a) * sMM * inv;
        emaSS = a * emaSS + (1.0 - a) * sSS * inv;
        emaMS = a * emaMS + (1.0 - a) * sMS * inv;
        emaWet = ad * emaWet + (1.0 - ad) * (static_cast<double>(sLL) + sRR) * inv;
        emaDry = ad * emaDry + (1.0 - ad) * sDry * inv;
        const float match = emaDry > 1e-12
            ? static_cast<float>(std::clamp(std::sqrt(emaWet / emaDry), 1.0, static_cast<double>(kDryMatchMaxGain)))
            : 1.0f;
        cmpGain.setTarget(match);
    }
};

// ─────────────────────────────────────────────────────────────────────────────

Core::Core() : impl_(std::make_unique<Impl>()) {}
Core::~Core() = default;

void Core::prepare(double sampleRate, int /*maxBlockSize*/)
{
    impl_->prepare(sampleRate);
}

void Core::reset() noexcept
{
    if (impl_->prepared) impl_->reset();
}

void Core::process(float* left, float* right, int numSamples, const Params& params) noexcept
{
    if (!impl_->prepared || left == nullptr || right == nullptr || numSamples <= 0) return;
    juce::ScopedNoDenormals noDenormals;
    impl_->process(left, right, numSamples, params);
}

const Meters& Core::meters() const noexcept { return impl_->meters; }

Core::EngineInfo Core::activeEngineInfo() const noexcept
{
    const Engine& e = impl_->eng[impl_->active];
    EngineInfo info;
    info.character = e.cfg.character;
    info.sizeMs = e.cfg.sizeMs;
    info.variation = e.cfg.variation;
    info.combTauSamples = e.combTau;
    info.combAllpass[0] = e.apC[0];
    info.combAllpass[1] = e.apC[1];
    info.diffusePredelay = e.predelay;
    for (int s = 0; s < kDiffuseStages; ++s)
    {
        info.diffuseLength[s] = e.len[s];
        info.diffuseCoeff[s] = e.coeff[s];
    }
    info.velvetTaps = e.vTaps;
    info.velvetLengthSamples = e.vLength;
    info.preRollSamples = e.preRoll;
    return info;
}

bool Core::switchInProgress() const noexcept { return impl_->phase != Impl::Phase::Idle; }
long long Core::engineSwitchCount() const noexcept { return impl_->switchCount; }
double Core::sampleRate() const noexcept { return impl_->fs; }
int Core::fadeSamples() const noexcept { return impl_->fadeLen; }

} // namespace xleth::dsp::stereoize
