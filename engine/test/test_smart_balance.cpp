// test_smart_balance.cpp - SmartBalanceEffect ("smartbalance"), the gentle 4-band
// leveller with Warmth.
// Build: cmake --build build --config Release --target test_smart_balance
// Run:   ctest --test-dir build -C Release -R "^test_smart_balance$" -V
//        (header-only effect, JUCE only: the exe also runs directly)
// Pass:  prints "[SmartBalance] ALL TESTS PASSED" and exits 0.
//
// Render mode (A/B on real material, not part of the test run):
//   test_smart_balance --render in.wav out.wav [param=value ...] [--csv meters.csv]
//
// Every signal is built so the effect's OWN band split sees the intended band
// levels: band-limited noises are calibrated through a replica of the effect's
// LR4 tree, not by assumption.

#include "audio/SmartBalanceEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <string>
#include <vector>

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (cond) {                                                            \
            ++g_passed;                                                        \
        } else {                                                               \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";        \
            ++g_failed;                                                        \
        }                                                                      \
    } while (0)

namespace
{
constexpr double kSR = 48000.0;
constexpr int    kBands = SmartBalanceEffect::kBands;
using Buf = juce::AudioBuffer<float>;
using Params = std::map<std::string, double>;

struct Rng
{
    std::uint32_t s;
    explicit Rng(std::uint32_t seed) : s(seed ? seed : 1u) {}
    float bip()
    {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        return static_cast<float>(s & 0x00FFFFFFu) / 16777215.0f * 2.0f - 1.0f;
    }
};

float dbOf(double power) { return static_cast<float>(10.0 * std::log10(std::max(power, 1e-20))); }

juce::RangedAudioParameter* findParam(juce::AudioProcessor& p, const std::string& id)
{
    for (auto* raw : p.getParameters())
        if (auto* rp = dynamic_cast<juce::RangedAudioParameter*>(raw))
            if (rp->paramID == juce::String(id))
                return rp;
    return nullptr;
}

std::unique_ptr<SmartBalanceEffect> makeFx(const Params& params, int maxBlock = 1024)
{
    auto fx = std::make_unique<SmartBalanceEffect>();
    for (const auto& [id, v] : params)
        fx->setParameterValue(id, static_cast<float>(v));
    fx->prepareToPlay(kSR, maxBlock);
    fx->reset();
    return fx;
}

// Process `in` in blocks; `onBlock(fx, endSample)` runs after each block.
template <typename OnBlock>
Buf render(SmartBalanceEffect& fx, const Buf& in, int blockSize, OnBlock onBlock)
{
    Buf out(in);
    juce::MidiBuffer midi;
    const int n = in.getNumSamples();
    const int ch = in.getNumChannels();
    Buf blk(ch, blockSize);
    for (int off = 0; off < n; off += blockSize)
    {
        const int len = std::min(blockSize, n - off);
        blk.setSize(ch, len, false, false, true);
        for (int c = 0; c < ch; ++c) blk.copyFrom(c, 0, out, c, off, len);
        fx.processBlock(blk, midi);
        for (int c = 0; c < ch; ++c) out.copyFrom(c, off, blk, c, 0, len);
        onBlock(fx, off + len);
    }
    return out;
}

Buf render(SmartBalanceEffect& fx, const Buf& in, int blockSize = 512)
{
    return render(fx, in, blockSize, [](SmartBalanceEffect&, int) {});
}

// A replica of the effect's balanced LR4 tree, used to measure band powers
// exactly as the effect sees them.
struct BandSplit
{
    juce::dsp::LinkwitzRileyFilter<float> mid, low, high, apLow, apHigh;
    BandSplit()
    {
        juce::dsp::ProcessSpec spec { kSR, 1024, 2 };
        for (auto* f : { &mid, &low, &high, &apLow, &apHigh }) f->prepare(spec);
        apLow.setType(juce::dsp::LinkwitzRileyFilterType::allpass);
        apHigh.setType(juce::dsp::LinkwitzRileyFilterType::allpass);
        low.setCutoffFrequency(150.0f);  apLow.setCutoffFrequency(150.0f);
        mid.setCutoffFrequency(800.0f);
        high.setCutoffFrequency(4000.0f); apHigh.setCutoffFrequency(4000.0f);
    }
    void split(int ch, float in, float* out)
    {
        float lo, hi;
        mid.processSample(ch, in, lo, hi);
        high.processSample(ch, apLow.processSample(ch, hi), out[2], out[3]);
        low.processSample(ch, apHigh.processSample(ch, lo), out[0], out[1]);
    }
};

// Mean band power (stereo mean) over [from, to).
std::array<double, kBands> bandPowers(const Buf& b, int from, int to)
{
    BandSplit sp;
    std::array<double, kBands> acc {};
    const int ch = b.getNumChannels();
    for (int i = 0; i < to; ++i)
        for (int c = 0; c < std::min(ch, 2); ++c)
        {
            float o[kBands];
            sp.split(c, b.getSample(c, i), o);
            if (i >= from)
                for (int k = 0; k < kBands; ++k) acc[k] += 0.5 * o[k] * o[k];
        }
    for (auto& a : acc) a /= std::max(1, to - from);
    return acc;
}

// Independent white noises, each pushed through its own band filter three
// times, summed with per-band gains. Same seed -> same signal. (White noise
// through one LR4 skirt leaks into the next band only ~10 dB down, so a "dull"
// or "absent" band could not be built from a single pass.)
struct BandNoise
{
    std::vector<Buf> bands;   // unit-gain band-limited noises
    explicit BandNoise(int n, std::uint32_t seed)
    {
        for (int k = 0; k < kBands; ++k)
        {
            Buf b(2, n);
            BandSplit sp[3];
            Rng r(seed + 7919u * static_cast<std::uint32_t>(k + 1));
            for (int i = 0; i < n; ++i)
                for (int c = 0; c < 2; ++c)
                {
                    float x = r.bip();
                    for (auto& f : sp)
                    {
                        float o[kBands];
                        f.split(c, x, o);
                        x = o[k];
                    }
                    b.setSample(c, i, x);
                }
            bands.push_back(std::move(b));
        }
    }
    Buf mix(const std::array<float, kBands>& gains) const
    {
        Buf out(2, bands[0].getNumSamples());
        out.clear();
        for (int k = 0; k < kBands; ++k)
            for (int c = 0; c < 2; ++c)
                out.addFrom(c, 0, bands[k], c, 0, out.getNumSamples(), gains[k]);
        return out;
    }
    // Gains so the effect's split measures band k at baseDb + share[k] + delta[k].
    std::array<float, kBands> calibrate(float baseDb, const std::array<float, kBands>& delta) const
    {
        std::array<float, kBands> g { 1.0f, 1.0f, 1.0f, 1.0f };
        const int n = bands[0].getNumSamples();
        for (int it = 0; it < 3; ++it)
        {
            const auto p = bandPowers(mix(g), n / 4, n);
            for (int k = 0; k < kBands; ++k)
            {
                const float want = baseDb + SmartBalanceEffect::kShareDb[k] + delta[k];
                g[k] *= std::pow(10.0f, (want - dbOf(p[k])) / 20.0f);
            }
        }
        return g;
    }
};

// BS.1770 K-weighted loudness (48 kHz coefficients), independent of the effect.
double kLoudness(const Buf& b, int from, int to)
{
    double sum = 0.0;
    for (int c = 0; c < std::min(2, b.getNumChannels()); ++c)
    {
        double x1 = 0, x2 = 0, y1 = 0, y2 = 0;   // stage 1 (shelf) history
        double z1 = 0, z2 = 0;                   // stage 2 (RLB high-pass) output history
        for (int i = 0; i < to; ++i)
        {
            const double x = b.getSample(c, i);
            const double y = 1.53512485958697 * x - 2.69169618940638 * x1 + 1.19839281085285 * x2
                           + 1.69065929318241 * y1 - 0.73248077421585 * y2;
            const double z = y - 2.0 * y1 + y2 + 1.99004745483398 * z1 - 0.99007225036621 * z2;
            x2 = x1; x1 = x;
            y2 = y1; y1 = y;
            z2 = z1; z1 = z;
            if (i >= from) sum += z * z;
        }
    }
    return -0.691 + 10.0 * std::log10(std::max(sum / std::max(1, to - from), 1e-20));
}

double rms(const Buf& b, int from, int to)
{
    double s = 0.0;
    int n = 0;
    for (int c = 0; c < b.getNumChannels(); ++c)
        for (int i = std::max(0, from); i < std::min(to, b.getNumSamples()); ++i, ++n)
            s += static_cast<double>(b.getSample(c, i)) * b.getSample(c, i);
    return std::sqrt(s / std::max(1, n));
}

double peak(const Buf& b, int from, int to)
{
    double p = 0.0;
    for (int c = 0; c < b.getNumChannels(); ++c)
        for (int i = std::max(0, from); i < std::min(to, b.getNumSamples()); ++i)
            p = std::max(p, static_cast<double>(std::fabs(b.getSample(c, i))));
    return p;
}

// Goertzel magnitude of `freq` over [from, from + n) of channel 0, Hann window.
double tone(const Buf& b, double freq, int from, int n)
{
    const double w = 2.0 * juce::MathConstants<double>::pi * freq / kSR;
    double re = 0.0, im = 0.0;
    for (int i = 0; i < n; ++i)
    {
        const double win = 0.5 - 0.5 * std::cos(2.0 * juce::MathConstants<double>::pi * i / (n - 1));
        const double x = b.getSample(0, from + i) * win;
        re += x * std::cos(w * i);
        im -= x * std::sin(w * i);
    }
    return std::sqrt(re * re + im * im);
}

Buf sine(double freq, double amp, int n)
{
    Buf b(2, n);
    for (int i = 0; i < n; ++i)
    {
        const float v = static_cast<float>(amp * std::sin(2.0 * juce::MathConstants<double>::pi * freq * i / kSR));
        b.setSample(0, i, v);
        b.setSample(1, i, v);
    }
    return b;
}

// Average of the gain meters (slots 4..7) over the blocks ending after `from`.
struct GainAverager
{
    int from;
    std::array<double, kBands> sum {};
    double makeup = 0.0;
    int count = 0;
    void operator()(SmartBalanceEffect& fx, int end)
    {
        if (end < from) return;
        for (int k = 0; k < kBands; ++k) sum[k] += fx.readMeterValue(k + 4);
        makeup += fx.debugMakeup_.load();
        ++count;
    }
    float gain(int k) const { return count ? static_cast<float>(sum[k] / count) : 0.0f; }
};

std::string fmtGains(const GainAverager& g)
{
    std::string s;
    for (int k = 0; k < kBands; ++k)
        s += juce::String(g.gain(k), 2).toStdString() + (k < kBands - 1 ? " / " : "");
    return s;
}

// ── Tests ────────────────────────────────────────────────────────────────────

void testParamContract()
{
    std::cout << "\n[SmartBalance] parameter contract\n";
    SmartBalanceEffect fx;
    struct Spec { std::string id; float min, max, def; };
    std::vector<Spec> specs = {
        { "amount", 0, 100, 60 }, { "preserve", 0, 100, 50 }, { "response", 10, 500, 150 },
        { "mix", 0, 100, 100 }, { "mode", 0, 1, 0 },
        { "warmth", 0, 100, 0 }, { "output", -12, 12, 0 }, { "loudness_match", 0, 1, 1 },
    };
    for (int b = 0; b < kBands; ++b)
    {
        specs.push_back({ SmartBalanceEffect::targetId(b), -40, 12, 0 });
        specs.push_back({ SmartBalanceEffect::bandAmtId(b), 0, 100, 100 });
        specs.push_back({ SmartBalanceEffect::floorId(b), -96, -20, -60 });
    }
    CHECK(fx.getParameters().size() == static_cast<int>(specs.size()),
          "expected " << specs.size() << " parameters, got " << fx.getParameters().size());
    for (const auto& s : specs)
    {
        auto* p = findParam(fx, s.id);
        CHECK(p != nullptr, "missing parameter " << s.id);
        if (!p) continue;
        const auto& r = p->getNormalisableRange();
        CHECK(std::fabs(r.start - s.min) < 1e-4f && std::fabs(r.end - s.max) < 1e-4f,
              s.id << " range " << r.start << ".." << r.end);
        CHECK(std::fabs(p->convertFrom0to1(p->getDefaultValue()) - s.def) < 1e-3f,
              s.id << " default " << p->convertFrom0to1(p->getDefaultValue()));
    }
    // The v1 ids, in the v1 order, still lead the list (saved projects and
    // automation address them by id; nothing was renamed).
    const char* v1[] = { "amount", "preserve", "response", "mix", "mode", "target_sub" };
    for (int i = 0; i < 6; ++i)
    {
        auto* rp = dynamic_cast<juce::RangedAudioParameter*>(fx.getParameters()[i]);
        CHECK(rp != nullptr && rp->paramID == juce::String(v1[i]), "parameter " << i << " is not " << v1[i]);
    }
    fx.prepareToPlay(kSR, 512);
    CHECK(fx.getLatencySamples() == 0, "latency " << fx.getLatencySamples());
}

void testStateRoundTrip()
{
    std::cout << "\n[SmartBalance] state round-trip\n";
    SmartBalanceEffect a;
    const Params set = { { "amount", 83 }, { "preserve", 12 }, { "response", 333 }, { "mix", 71 },
                         { "mode", 1 }, { "target_air", -17 }, { "bandamt_lomid", 44 }, { "floor_sub", -72 },
                         { "warmth", 64 }, { "output", -3.5f }, { "loudness_match", 0 } };
    for (const auto& [id, v] : set) a.setParameterValue(id, static_cast<float>(v));
    juce::MemoryBlock mb;
    a.getStateInformation(mb);
    SmartBalanceEffect b;
    b.setStateInformation(mb.getData(), static_cast<int>(mb.getSize()));
    for (const auto& [id, v] : set)
        CHECK(std::fabs(b.getParameterValue(id) - v) < 0.01f, id << " restored as " << b.getParameterValue(id));

    // A v1 state (no warmth / output / loudness_match) loads with their defaults.
    SmartBalanceEffect fresh;
    juce::MemoryBlock mb1;
    fresh.getStateInformation(mb1);
    auto xml = juce::AudioProcessor::getXmlFromBinary(mb1.getData(), static_cast<int>(mb1.getSize()));
    CHECK(xml != nullptr, "state xml");
    if (xml)
    {
        for (const char* id : { "warmth", "output", "loudness_match" })
            if (auto* e = xml->getChildByAttribute("id", id)) xml->removeChildElement(e, true);
        juce::MemoryBlock legacy;
        juce::AudioProcessor::copyXmlToBinary(*xml, legacy);
        SmartBalanceEffect c;
        c.setParameterValue("warmth", 90);
        c.setStateInformation(legacy.getData(), static_cast<int>(legacy.getSize()));
        CHECK(c.getParameterValue("loudness_match") == 1.0f, "legacy state: loudness_match " << c.getParameterValue("loudness_match"));
        CHECK(std::fabs(c.getParameterValue("output")) < 1e-4f, "legacy state: output " << c.getParameterValue("output"));
    }
}

void testTransparency()
{
    std::cout << "\n[SmartBalance] Amount 0 / Mix 0 are magnitude-transparent\n";
    for (const double f : { 30.0, 100.0, 150.0, 400.0, 800.0, 2000.0, 4000.0, 10000.0 })
    {
        const Buf in = sine(f, 0.3, static_cast<int>(kSR));
        auto fx = makeFx({ { "amount", 0 } });
        const Buf out = render(*fx, in);
        const int from = static_cast<int>(kSR * 0.5);
        const double d = 20.0 * std::log10(rms(out, from, in.getNumSamples()) / rms(in, from, in.getNumSamples()));
        CHECK(std::fabs(d) < 0.05, "amount 0 at " << f << " Hz: " << d << " dB");

        auto fx2 = makeFx({ { "amount", 100 }, { "mix", 0 }, { "warmth", 100 } });
        const Buf out2 = render(*fx2, in);
        const double d2 = 20.0 * std::log10(rms(out2, from, in.getNumSamples()) / rms(in, from, in.getNumSamples()));
        CHECK(std::fabs(d2) < 0.05, "mix 0 at " << f << " Hz: " << d2 << " dB");
    }
}

void testBalanceBehaviour()
{
    std::cout << "\n[SmartBalance] balance: leave balanced alone, pull bright / dull bands\n";
    const int n = static_cast<int>(kSR * 8);
    const BandNoise noise(n, 1234u);
    const int from = static_cast<int>(kSR * 4);

    auto run = [&](const std::array<float, kBands>& delta, const Params& extra = {}) {
        const Buf in = noise.mix(noise.calibrate(-24.0f, delta));
        Params p = { { "amount", 100 } };
        for (const auto& kv : extra) p[kv.first] = kv.second;
        auto fx = makeFx(p);
        GainAverager avg { from };
        render(*fx, in, 512, std::ref(avg));
        return avg;
    };

    const auto bal = run({ 0, 0, 0, 0 });
    std::cout << "  balanced gains " << fmtGains(bal) << "\n";
    for (int k = 0; k < kBands; ++k)
        CHECK(std::fabs(bal.gain(k)) < 0.75f, "balanced: band " << k << " moved " << bal.gain(k) << " dB");

    const auto bright = run({ 0, 0, 0, 9 });
    std::cout << "  air +9 dB gains " << fmtGains(bright) << "\n";
    CHECK(bright.gain(3) < -2.5f, "bright air not cut: " << bright.gain(3));
    CHECK(bright.gain(3) > -SmartBalanceEffect::kCutMaxDb, "bright air cut past the limit: " << bright.gain(3));
    for (int k = 0; k < 3; ++k)
        CHECK(bright.gain(k) > -0.5f && bright.gain(k) < 1.5f, "bright: band " << k << " " << bright.gain(k));

    const auto dull = run({ 0, 0, 0, -12 });
    std::cout << "  air -12 dB gains " << fmtGains(dull) << "\n";
    CHECK(dull.gain(3) > 1.5f && dull.gain(3) <= SmartBalanceEffect::kLiftMaxDb[3] + 0.01f, "dull air lift " << dull.gain(3));
    for (int k = 0; k < 3; ++k)
        CHECK(dull.gain(k) > -2.0f && dull.gain(k) < 0.5f, "dull: band " << k << " " << dull.gain(k));

    // A band that is not really there (a voice clip's sub, a low-bitrate file's
    // empty top): never pulled up out of the noise. Built with a steep 2.5 kHz
    // low-pass (8 x 12 dB/oct) so not even a crossover skirt reaches the band.
    {
        Buf in = noise.mix(noise.calibrate(-24.0f, { 0, 0, 0, 0 }));
        std::vector<juce::dsp::IIR::Filter<float>> lp(16);
        const auto co = juce::dsp::IIR::Coefficients<float>::makeLowPass(kSR, 2500.0f);
        for (auto& f : lp) { f.coefficients = co; f.reset(); }
        for (int c = 0; c < 2; ++c)
            for (int i = 0; i < n; ++i)
            {
                float x = in.getSample(c, i);
                for (int s = 0; s < 8; ++s) x = lp[c * 8 + s].processSample(x);
                in.setSample(c, i, x);
            }
        auto fx = makeFx({ { "amount", 100 } });
        GainAverager absent { from };
        render(*fx, in, 512, std::ref(absent));
        const auto pw = bandPowers(in, from, n);
        std::cout << "  no air (" << dbOf(pw[3]) - dbOf(pw[2]) << " dB under upper-mid) gains " << fmtGains(absent) << "\n";
        CHECK(absent.gain(3) < 0.5f, "absent air lifted " << absent.gain(3) << " dB");
    }

    // Band amount 0 leaves that band alone; an offset moves its target.
    const auto noAir = run({ 0, 0, 0, 9 }, { { "bandamt_air", 0 } });
    CHECK(std::fabs(noAir.gain(3)) < 0.05f, "bandamt_air 0 still moved air " << noAir.gain(3));
    const auto offset = run({ 0, 0, 0, 0 }, { { "target_air", -6 } });
    CHECK(offset.gain(3) < -1.5f, "target_air -6 did not cut air: " << offset.gain(3));

    // Amount scales the correction monotonically.
    float last = 0.0f;
    for (const float amt : { 25.0f, 50.0f, 75.0f, 100.0f })
    {
        const auto r = run({ 0, 0, 0, 9 }, { { "amount", amt } });
        CHECK(r.gain(3) < last + 0.05f, "amount " << amt << ": air " << r.gain(3) << " not below " << last);
        last = r.gain(3);
    }

    // Absolute mode: the band is pulled toward the literal level.
    // (-40 dB is the bottom of target_*; the signal sits 10+ dB over it.)
    const Buf loud = noise.mix(noise.calibrate(-14.0f, { 0, 0, 0, 0 }));
    auto absFx = makeFx({ { "amount", 100 }, { "mode", 1 }, { "target_sub", -40 }, { "target_lomid", -40 },
                          { "target_upmid", -40 }, { "target_air", -40 } });
    GainAverager absMode { from };
    render(*absFx, loud, 512, std::ref(absMode));
    std::cout << "  absolute -40 dBFS gains " << fmtGains(absMode) << "\n";
    for (int k = 0; k < kBands; ++k)
        CHECK(absMode.gain(k) < -3.0f, "absolute: band " << k << " not cut toward -40 dBFS: " << absMode.gain(k));
}

void testGapsNotLifted()
{
    // What makes an OTT-style chain harsh is lifting the room between notes
    // ABOVE the notes. The tonal correction is an EQ and applies to both alike
    // (the hiss keeps its distance under the notes); a gap may never get more
    // gain than the notes around it, band by band.
    std::cout << "\n[SmartBalance] gaps between notes are not lifted above the notes\n";
    const int n = static_cast<int>(kSR * 6);
    const BandNoise noise(n, 99u);
    const Buf notes = noise.mix(noise.calibrate(-22.0f, { 0, 0, 0, -6 }));
    const BandNoise hissSrc(n, 5u);
    const Buf hiss = hissSrc.mix(hissSrc.calibrate(-84.0f, { 0, 0, 0, 0 }));
    // 300 ms on / 500 ms off, hiss in the gaps.
    const int period = static_cast<int>(kSR * 0.8), on = static_cast<int>(kSR * 0.3);
    Buf in(notes);
    for (int i = 0; i < n; ++i)
        if (i % period >= on)
            for (int c = 0; c < 2; ++c) in.setSample(c, i, hiss.getSample(c, i));

    auto fx = makeFx({ { "amount", 100 }, { "loudness_match", 0 } });
    const Buf out = render(*fx, in);
    double worst = -100.0;
    for (int start = period * 2; start + period <= n; start += period)
    {
        const int n0 = start + static_cast<int>(kSR * 0.1), n1 = start + on;              // a note
        const int g0 = start + on + static_cast<int>(kSR * 0.15), g1 = start + period;    // its gap
        // Per-band gain over the note and over the gap.
        BandSplit si, so;
        std::array<double, kBands> nin {}, nout {}, gin {}, gout {};
        for (int i = 0; i < g1; ++i)
        {
            float a[kBands], b[kBands];
            si.split(0, in.getSample(0, i), a);
            so.split(0, out.getSample(0, i), b);
            for (int k = 0; k < kBands; ++k)
            {
                if (i >= n0 && i < n1) { nin[k] += a[k] * a[k]; nout[k] += b[k] * b[k]; }
                if (i >= g0)           { gin[k] += a[k] * a[k]; gout[k] += b[k] * b[k]; }
            }
        }
        for (int k = 0; k < kBands; ++k)
            worst = std::max(worst, dbOf(gout[k] / gin[k]) - static_cast<double>(dbOf(nout[k] / nin[k])));
    }
    std::cout << "  worst gap gain over its note's gain, any band: " << worst << " dB\n";
    CHECK(worst < 1.0, "a gap got " << worst << " dB more gain than its note");
}

void testPreserve()
{
    std::cout << "\n[SmartBalance] Preserve keeps hits and stops the post-hit pump\n";
    const int n = static_cast<int>(kSR * 6);
    const BandNoise noise(n, 4242u);
    const Buf body = noise.mix(noise.calibrate(-36.0f, { 0, 0, 0, 0 }));
    // A kick: Sub and Low-mid only, 15 dB over the body, 140 ms, 50 ms decay.
    // A full-band hit barely moves the leveller (the program anchor rises with
    // it); a low-band-only hit is the case that pumps an OTT-style chain.
    const BandNoise hitNoise(n, 777u);
    const Buf hitSrc = hitNoise.mix(hitNoise.calibrate(-21.0f, { 0, 0, -80, -80 }));
    const int period = static_cast<int>(kSR * 0.5);
    Buf in(body);
    for (int i = 0; i < n; ++i)
    {
        const int ph = i % period;
        const float env = ph < static_cast<int>(kSR * 0.14) ? std::exp(-static_cast<float>(ph) / static_cast<float>(kSR * 0.05)) : 0.0f;
        for (int c = 0; c < 2; ++c) in.addSample(c, i, hitSrc.getSample(c, i) * env);
    }

    // Measured on the Sub band of the output, where the kick lives:
    // crest: the hit's energy (first 100 ms) over the band just before it;
    // pump:  the band 160..360 ms after the hit over the band before it.
    struct Res { double crest, pumpDb; };
    auto measure = [&](const Buf& full) {
        Buf b(1, full.getNumSamples());
        BandSplit sp;
        for (int i = 0; i < full.getNumSamples(); ++i)
        {
            float o[kBands];
            sp.split(0, full.getSample(0, i), o);
            b.setSample(0, i, o[0]);
        }
        double crest = 0.0, pump = 0.0;
        int count = 0;
        for (int start = period * 6; start + period <= n; start += period, ++count)
        {
            const double pre  = rms(b, start - static_cast<int>(kSR * 0.12), start - static_cast<int>(kSR * 0.01));
            const double hit  = rms(b, start, start + static_cast<int>(kSR * 0.1));
            const double post = rms(b, start + static_cast<int>(kSR * 0.16), start + static_cast<int>(kSR * 0.36));
            crest += 20.0 * std::log10(hit / pre);
            pump  += 20.0 * std::log10(post / pre);
        }
        return Res { crest / count, pump / count };
    };

    // The reference is the effect at Amount 0 (the crossover allpass alone).
    // Response 40 ms: at the default 150 ms the detector is slow enough that a
    // kick moves the sub band < 0.5 dB even without Preserve; the fast setting
    // ("everything at max") is where an OTT-style chain pumps.
    auto ref = makeFx({ { "amount", 0 }, { "loudness_match", 0 } });
    const Res dry = measure(render(*ref, in));
    auto run = [&](float preserve) {
        auto fx = makeFx({ { "amount", 100 }, { "preserve", preserve }, { "response", 40 }, { "loudness_match", 0 } });
        return measure(render(*fx, in));
    };
    const Res p0 = run(0.0f), p100 = run(100.0f);
    std::cout << "  crest (amount 0) " << dry.crest << " | preserve 0: " << p0.crest << " (pump " << p0.pumpDb
              << ") | preserve 100: " << p100.crest << " (pump " << p100.pumpDb << ") amount-0 pump " << dry.pumpDb << "\n";
    CHECK(p100.crest > p0.crest + 1.0, "Preserve did not keep more of the hit: " << p100.crest << " vs " << p0.crest);
    CHECK(std::fabs(p100.crest - dry.crest) < 0.75, "Preserve 100 hit " << p100.crest << " vs " << dry.crest);
    CHECK(std::fabs(p100.pumpDb - dry.pumpDb) < 0.75, "Preserve 100 still pumps: " << p100.pumpDb << " vs " << dry.pumpDb);
    CHECK(std::fabs(p100.pumpDb - dry.pumpDb) < std::fabs(p0.pumpDb - dry.pumpDb),
          "Preserve 100 pumps more than 0: " << p100.pumpDb << " vs " << p0.pumpDb);
}

void testLoudnessMatch()
{
    std::cout << "\n[SmartBalance] loudness match holds the K-weighted level\n";
    const int n = static_cast<int>(kSR * 20);
    const BandNoise noise(n, 31337u);
    Buf in = noise.mix(noise.calibrate(-26.0f, { 2, -3, 1, -10 }));
    // Section level steps every 2.5 s.
    const float steps[] = { 0, -8, 3, -4, 0, -10, 2, -2 };
    for (int i = 0; i < n; ++i)
    {
        const float g = std::pow(10.0f, steps[(i / static_cast<int>(kSR * 2.5)) % 8] / 20.0f);
        for (int c = 0; c < 2; ++c) in.setSample(c, i, in.getSample(c, i) * g);
    }
    const int from = static_cast<int>(kSR * 3);
    const double lin = kLoudness(in, from, n);

    for (const float warmth : { 0.0f, 100.0f })
    {
        auto on = makeFx({ { "amount", 100 }, { "warmth", warmth } });
        const double lon = kLoudness(render(*on, in), from, n);
        auto off = makeFx({ { "amount", 100 }, { "warmth", warmth }, { "loudness_match", 0 } });
        const double loff = kLoudness(render(*off, in), from, n);
        std::cout << "  warmth " << warmth << ": in " << lin << " LUFS, match on " << lon << ", match off " << loff << "\n";
        CHECK(std::fabs(lon - lin) < 1.0, "warmth " << warmth << ": match on is " << (lon - lin) << " LU from the input");
    }
    // Output trim is applied after the match.
    auto trim = makeFx({ { "amount", 100 }, { "output", -6 } });
    const double lt = kLoudness(render(*trim, in), from, n);
    CHECK(std::fabs(lt - (lin - 6.0)) < 1.0, "output -6: " << (lt - lin) << " LU");
}

void testWarmth()
{
    std::cout << "\n[SmartBalance] Warmth: low-order harmonics, low bands only, level-independent\n";
    const int n = static_cast<int>(kSR * 2);
    const int from = static_cast<int>(kSR * 1), len = static_cast<int>(kSR * 0.5);

    auto harmonics = [&](double f, double amp, float warmth) {
        auto fx = makeFx({ { "amount", 0 }, { "warmth", warmth }, { "loudness_match", 0 } });
        const Buf out = render(*fx, sine(f, amp, n));
        const double h1 = tone(out, f, from, len);
        double sum = 0.0;
        std::array<double, 7> h {};
        for (int k = 2; k <= 6; ++k)
        {
            h[k] = tone(out, f * k, from, len) / h1;
            sum += h[k] * h[k];
        }
        h[0] = std::sqrt(sum);   // THD
        return h;
    };

    for (const double f : { 70.0, 300.0 })
    {
        const auto off  = harmonics(f, 0.25, 0.0f);
        const auto full = harmonics(f, 0.25, 100.0f);
        const auto half = harmonics(f, 0.25, 50.0f);
        const auto quiet = harmonics(f, 0.0125, 100.0f);
        std::cout << "  " << f << " Hz THD: warmth 0 " << 100 * off[0] << " %, 50 " << 100 * half[0]
                  << " %, 100 " << 100 * full[0] << " % (H2 " << 20 * std::log10(full[2]) << " dB, H3 "
                  << 20 * std::log10(full[3]) << " dB); -38 dBFS: " << 100 * quiet[0] << " %\n";
        CHECK(off[0] < 1.0e-4, f << " Hz: warmth 0 THD " << off[0]);
        CHECK(full[0] > 0.005 && full[0] < 0.08, f << " Hz: warmth 100 THD " << full[0]);
        CHECK(half[0] > off[0] && half[0] < full[0], f << " Hz: THD not monotonic in Warmth");
        CHECK(full[2] > 0.001, f << " Hz: no 2nd harmonic (" << full[2] << ")");
        CHECK(std::fabs(20.0 * std::log10(quiet[0] / full[0])) < 3.0, f << " Hz: THD level-dependent " << quiet[0] << " vs " << full[0]);
    }
    // Nothing above 800 Hz is saturated. What remains is the tone's -32 dB
    // crossover residue inside Low-mid, driven only lightly because the drive
    // is floored 18 dB under the full-band level (without that floor: 0.26 %).
    const auto hi = harmonics(2000.0, 0.25, 100.0f);
    std::cout << "  2 kHz THD at warmth 100: " << 100 * hi[0] << " % (" << 20 * std::log10(hi[0]) << " dB)\n";
    CHECK(hi[0] < 1.0e-3, "2 kHz THD at warmth 100: " << hi[0]);

    // Warmth 0 is exactly the same output as never touching it.
    const BandNoise noise(static_cast<int>(kSR), 3u);
    const Buf in = noise.mix(noise.calibrate(-20.0f, { 0, 0, 0, 0 }));
    auto a = makeFx({ { "amount", 70 } });
    auto b = makeFx({ { "amount", 70 }, { "warmth", 0.0f } });
    const Buf oa = render(*a, in), ob = render(*b, in);
    bool same = true;
    for (int c = 0; c < 2 && same; ++c)
        for (int i = 0; i < in.getNumSamples(); ++i)
            if (oa.getSample(c, i) != ob.getSample(c, i)) { same = false; break; }
    CHECK(same, "warmth 0 differs from default");
}

void testLowBandStaysClean()
{
    std::cout << "\n[SmartBalance] the fastest Response does not distort the low band\n";
    const int n = static_cast<int>(kSR * 3);
    const int from = static_cast<int>(kSR * 2), len = static_cast<int>(kSR * 0.5);
    for (const double f : { 45.0, 90.0 })
    {
        // Absolute target far below: the sub band is held at the full cut.
        auto fx = makeFx({ { "amount", 100 }, { "response", 10 }, { "preserve", 0 }, { "mode", 1 },
                           { "target_sub", -40 }, { "target_lomid", -40 }, { "loudness_match", 0 } });
        const Buf out = render(*fx, sine(f, 0.4, n));
        const double h1 = tone(out, f, from, len);
        double sum = 0.0;
        for (int k = 2; k <= 5; ++k) { const double h = tone(out, f * k, from, len) / h1; sum += h * h; }
        const double thdDb = 10.0 * std::log10(std::max(sum, 1e-20));
        std::cout << "  " << f << " Hz at response 10 ms, gain " << fx->readMeterValue(4) << " dB: THD " << thdDb << " dB\n";
        CHECK(thdDb < -45.0, f << " Hz THD " << thdDb << " dB");
    }
}

void testBlockSizeIndependence()
{
    std::cout << "\n[SmartBalance] block-size independence\n";
    const int n = static_cast<int>(kSR * 3);
    const BandNoise noise(n, 8u);
    Buf in = noise.mix(noise.calibrate(-20.0f, { 3, -2, 0, -8 }));
    for (int i = 0; i < n; ++i)
        if ((i / 9000) % 3 == 2)
            for (int c = 0; c < 2; ++c) in.setSample(c, i, in.getSample(c, i) * 0.05f);

    const Params p = { { "amount", 85 }, { "preserve", 60 }, { "warmth", 70 }, { "mix", 80 } };
    auto ref = makeFx(p, 1024);
    const Buf want = render(*ref, in, 512);
    for (const int bs : { 1, 7, 32, 128, 333, 1024 })
    {
        auto fx = makeFx(p, 1024);
        const Buf got = render(*fx, in, bs);
        float maxDiff = 0.0f;
        for (int c = 0; c < 2; ++c)
            for (int i = 0; i < n; ++i)
                maxDiff = std::max(maxDiff, std::fabs(got.getSample(c, i) - want.getSample(c, i)));
        CHECK(maxDiff == 0.0f, "block size " << bs << " differs by " << maxDiff);
    }
}

void testRobustness()
{
    std::cout << "\n[SmartBalance] silence, DC, full-scale square, mono, reset\n";
    auto finite = [](const Buf& b) {
        for (int c = 0; c < b.getNumChannels(); ++c)
            for (int i = 0; i < b.getNumSamples(); ++i)
                if (!std::isfinite(b.getSample(c, i))) return false;
        return true;
    };
    const int n = static_cast<int>(kSR * 2);
    {
        Buf z(2, n); z.clear();
        auto fx = makeFx({ { "amount", 100 }, { "warmth", 100 } });
        const Buf out = render(*fx, z);
        CHECK(peak(out, 0, n) == 0.0, "silence in, " << peak(out, 0, n) << " out");
    }
    {
        Buf sq(2, n);
        for (int i = 0; i < n; ++i) for (int c = 0; c < 2; ++c) sq.setSample(c, i, ((i / 480) % 2) ? 1.0f : -1.0f);
        auto fx = makeFx({ { "amount", 100 }, { "warmth", 100 }, { "output", 12 }, { "response", 10 } });
        const Buf out = render(*fx, sq);
        CHECK(finite(out), "square: non-finite output");
        CHECK(peak(out, 0, n) < 16.0, "square: peak " << peak(out, 0, n));
    }
    {
        Buf dc(2, n);
        for (int i = 0; i < n; ++i) for (int c = 0; c < 2; ++c) dc.setSample(c, i, 0.5f);
        auto fx = makeFx({ { "amount", 100 }, { "warmth", 100 } });
        const Buf out = render(*fx, dc);
        CHECK(finite(out), "DC: non-finite output");
    }
    {
        const BandNoise noise(n, 11u);
        const Buf st = noise.mix(noise.calibrate(-20.0f, { 0, 0, 0, -8 }));
        Buf mono(1, n);
        mono.copyFrom(0, 0, st, 0, 0, n);
        auto fx = makeFx({ { "amount", 100 }, { "warmth", 60 } });
        const Buf out = render(*fx, mono);
        CHECK(finite(out) && peak(out, 0, n) > 0.0, "mono: no sane output");

        // After a reset the effect is in its initial state: silence stays silence
        // and the same input renders the same output.
        fx->reset();
        Buf z(1, 4096); z.clear();
        const Buf zo = render(*fx, z);
        CHECK(peak(zo, 0, 4096) == 0.0, "reset: silence in, " << peak(zo, 0, 4096) << " out");
        fx->reset();
        const Buf again = render(*fx, mono);
        auto fresh = makeFx({ { "amount", 100 }, { "warmth", 60 } });
        const Buf first = render(*fresh, mono);
        bool same = true;
        for (int i = 0; i < n && same; ++i) same = again.getSample(0, i) == first.getSample(0, i);
        CHECK(same, "reset does not restore the initial state");
    }
}

void testCpu()
{
    std::cout << "\n[SmartBalance] CPU\n";
    const int n = static_cast<int>(kSR * 10);
    const BandNoise noise(static_cast<int>(kSR), 1u);
    const Buf one = noise.mix(noise.calibrate(-20.0f, { 0, 0, 0, 0 }));
    Buf in(2, n);
    for (int i = 0; i < n; i += one.getNumSamples())
        for (int c = 0; c < 2; ++c) in.copyFrom(c, i, one, c, 0, std::min(one.getNumSamples(), n - i));
    auto fx = makeFx({ { "amount", 100 }, { "warmth", 100 } });
    const auto t0 = std::chrono::steady_clock::now();
    render(*fx, in, 512);
    const double sec = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    std::cout << "  10 s of stereo audio in " << sec * 1000.0 << " ms (" << 100.0 * sec / 10.0 << " % of one core)\n";
    CHECK(sec < 1.0, "10 s took " << sec << " s");
}

// ── Render mode ──────────────────────────────────────────────────────────────
int renderFile(int argc, char** argv)
{
    if (argc < 4)
    {
        std::cerr << "usage: test_smart_balance --render in.wav out.wav [param=value ...] [--csv meters.csv]\n";
        return 2;
    }
    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fm.createReaderFor(juce::File(argv[2])));
    if (!reader) { std::cerr << "cannot read " << argv[2] << "\n"; return 2; }
    const int n  = static_cast<int>(reader->lengthInSamples);
    const int ch = static_cast<int>(std::min<unsigned>(2u, reader->numChannels));
    Buf in(ch, n);
    reader->read(&in, 0, n, 0, true, ch > 1);

    Params params;
    std::string csvPath;
    for (int i = 4; i < argc; ++i)
    {
        const std::string a = argv[i];
        if (a == "--csv" && i + 1 < argc) { csvPath = argv[++i]; continue; }
        const auto eq = a.find('=');
        if (eq != std::string::npos) params[a.substr(0, eq)] = std::stod(a.substr(eq + 1));
    }

    auto fx = std::make_unique<SmartBalanceEffect>();
    for (const auto& [id, v] : params)
        if (!fx->setParameterValue(id, static_cast<float>(v))) std::cerr << "unknown parameter " << id << "\n";
    fx->prepareToPlay(reader->sampleRate, 512);
    fx->reset();

    std::ofstream csv;
    if (!csvPath.empty())
    {
        csv.open(csvPath);
        csv << "t,lvl0,lvl1,lvl2,lvl3,g0,g1,g2,g3,program,makeup\n";
    }
    std::array<double, kBands> gsum {};
    int blocks = 0;
    const double sr = reader->sampleRate;
    const Buf out = render(*fx, in, 512, [&](SmartBalanceEffect& e, int end) {
        for (int k = 0; k < kBands; ++k) gsum[k] += e.readMeterValue(k + 4);
        ++blocks;
        if (csv.is_open())
        {
            csv << end / sr;
            for (int k = 0; k < 8; ++k) csv << "," << e.readMeterValue(k);
            csv << "," << e.debugProgram_.load() << "," << e.debugMakeup_.load() << "\n";
        }
    });

    juce::File outFile(argv[3]);
    outFile.deleteFile();
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::OutputStream> os(outFile.createOutputStream());
    if (!os) { std::cerr << "cannot write " << argv[3] << "\n"; return 2; }
    std::unique_ptr<juce::AudioFormatWriter> writer(wav.createWriterFor(os.get(), sr, static_cast<unsigned>(ch), 32, {}, 0));
    if (!writer) { std::cerr << "no wav writer\n"; return 2; }
    os.release();
    writer->writeFromAudioSampleBuffer(out, 0, n);
    writer.reset();

    std::cout << "mean band gain (dB):";
    for (int k = 0; k < kBands; ++k) std::cout << " " << gsum[k] / std::max(1, blocks);
    std::cout << " | final makeup " << fx->debugMakeup_.load() << " dB\n";
    return 0;
}
} // namespace

int main(int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    if (argc > 1 && std::string(argv[1]) == "--render")
        return renderFile(argc, argv);

    std::cout << "[SmartBalance] test_smart_balance\n";
    testParamContract();
    testStateRoundTrip();
    testTransparency();
    testBalanceBehaviour();
    testGapsNotLifted();
    testPreserve();
    testLoudnessMatch();
    testWarmth();
    testLowBandStaysClean();
    testBlockSizeIndependence();
    testRobustness();
    testCpu();
    std::cout << "\n[SmartBalance] " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0) std::cout << "[SmartBalance] ALL TESTS PASSED\n";
    return g_failed == 0 ? 0 : 1;
}
