// test_fedda.cpp — XlethFeddaEffect ("fedda"), the stock-effect face of StereoizeCore.
// Build: cmake --build build --config Release --target test_fedda
// Run:   ctest --test-dir build -C Release -R "^test_fedda$" -V
// Pass:  prints "[Fedda] ALL TESTS PASSED" and exits 0.
//
// Spec xleth-spread-spec.md section 7, effect-level rows:
//   T3  zero latency: reported latency 0, mid path sample-aligned with the dry input
//   T4  export parity through processBlock: block sizes 32 / 128 / 333 / 512 / 1024 bit-identical
//   T8  monitors never render: mono_check / compare ignored while non-realtime (OfflineRenderer
//       runs every chain non-realtime during an export) and written as 0 into every saved state
//   T11 state round-trip: every parameter including the seed survives save / load
// Plus: the parameter contract, a fresh seed per new instance, bypass.
// The DSP itself is covered by test_stereoize_core.

#include "audio/XlethFeddaEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <cmath>
#include <cstdint>
#include <iostream>
#include <map>
#include <memory>
#include <set>
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

juce::RangedAudioParameter* findParam(juce::AudioProcessor& p, const char* id)
{
    for (auto* raw : p.getParameters())
        if (auto* rp = dynamic_cast<juce::RangedAudioParameter*>(raw))
            if (rp->paramID == juce::String(id))
                return rp;
    return nullptr;
}

juce::AudioBuffer<float> noise(int n, std::uint32_t seed)
{
    juce::AudioBuffer<float> b(2, n);
    Rng r(seed);
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < n; ++i)
            b.setSample(c, i, r.bip() * 0.4f);
    return b;
}

juce::AudioBuffer<float> render(XlethFeddaEffect& fx, const juce::AudioBuffer<float>& in, int blockSize)
{
    juce::AudioBuffer<float> out(in);
    juce::MidiBuffer midi;
    const int n = in.getNumSamples();
    juce::AudioBuffer<float> blk(2, blockSize);
    for (int off = 0; off < n; off += blockSize)
    {
        const int len = std::min(blockSize, n - off);
        blk.setSize(2, len, false, false, true);
        for (int c = 0; c < 2; ++c) blk.copyFrom(c, 0, out, c, off, len);
        fx.processBlock(blk, midi);
        for (int c = 0; c < 2; ++c) out.copyFrom(c, off, blk, c, 0, len);
    }
    return out;
}

bool sameBuffers(const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
{
    if (a.getNumSamples() != b.getNumSamples()) return false;
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < a.getNumSamples(); ++i)
            if (a.getSample(c, i) != b.getSample(c, i)) return false;
    return true;
}

void testParamContract()
{
    std::cout << "\n[Fedda] parameter contract\n";
    XlethFeddaEffect fx;
    struct Spec { const char* id; float min, max, def; };
    const Spec specs[] = {
        { "width",          0.0f,    200.0f,   50.0f },
        { "character",      0.0f,    2.0f,     1.0f },
        { "size",           0.5f,    30.0f,    8.0f },
        { "low_bypass",     20.0f,   2000.0f,  150.0f },
        { "low_slope",      0.0f,    1.0f,     0.0f },
        { "hf_damp",        2000.0f, 20000.0f, 20000.0f },
        { "guard",          0.0f,    100.0f,   0.0f },
        { "variation",      0.0f,    999.0f,   0.0f },
        { "loudness_match", 0.0f,    1.0f,     0.0f },
        { "mono_check",     0.0f,    1.0f,     0.0f },
        { "compare",        0.0f,    1.0f,     0.0f },
    };
    CHECK(fx.getParameters().size() == static_cast<int>(std::size(specs)), "expected " << std::size(specs) << " parameters, got " << fx.getParameters().size());
    for (const auto& s : specs)
    {
        auto* p = findParam(fx, s.id);
        CHECK(p != nullptr, "missing parameter " << s.id);
        if (!p) continue;
        const auto& r = p->getNormalisableRange();
        CHECK(std::fabs(r.start - s.min) < 1e-4f && std::fabs(r.end - s.max) < 1e-4f, s.id << " range " << r.start << ".." << r.end);
        CHECK(std::fabs(p->convertFrom0to1(p->getDefaultValue()) - s.def) < 1e-3f, s.id << " default " << p->convertFrom0to1(p->getDefaultValue()));
    }
    CHECK(fx.getPluginId() == "fedda", "pluginId " << fx.getPluginId());

    // set / get through the generic bridge path.
    CHECK(fx.setParameterValue("width", 133.0f) && std::fabs(fx.getParameterValue("width") - 133.0f) < 0.01f, "width set/get");
    CHECK(fx.setParameterValue("character", 2.0f) && fx.getParameterValue("character") == 2.0f, "character set/get");
    CHECK(fx.setParameterValue("variation", 417.0f) && fx.getParameterValue("variation") == 417.0f, "variation set/get");
    CHECK(fx.getParametersAsJSON().find("\"low_bypass\"") != std::string::npos, "low_bypass missing from the JSON list");
}

void testSeedPerInstance()
{
    std::cout << "\n[Fedda] a fresh seed per new instance\n";
    std::set<int> seeds;
    for (int k = 0; k < 12; ++k)
    {
        XlethFeddaEffect fx;
        seeds.insert(static_cast<int>(fx.getParameterValue("variation")));
    }
    std::cout << "  12 instances -> " << seeds.size() << " distinct seeds\n";
    CHECK(seeds.size() >= 6, "new instances share seeds (" << seeds.size() << " distinct of 12)");
}

void testStateRoundTrip()
{
    std::cout << "\n[Fedda] T11 state round-trip, T8 monitors not persisted\n";
    XlethFeddaEffect a;
    const std::map<std::string, float> values = {
        { "width", 171.5f }, { "character", 0.0f }, { "size", 17.25f }, { "low_bypass", 333.0f },
        { "low_slope", 1.0f }, { "hf_damp", 7100.0f }, { "guard", 42.0f }, { "variation", 808.0f },
        { "loudness_match", 1.0f },
    };
    for (const auto& [id, v] : values) a.setParameterValue(id, v);
    a.setParameterValue("mono_check", 1.0f);
    a.setParameterValue("compare", 1.0f);

    juce::MemoryBlock mb;
    a.getStateInformation(mb);
    auto xml = juce::AudioProcessor::getXmlFromBinary(mb.getData(), static_cast<int>(mb.getSize()));
    CHECK(xml != nullptr, "saved state is not XML");
    if (xml)
    {
        for (const char* id : { "mono_check", "compare" })
        {
            bool found = false;
            for (auto* child : xml->getChildIterator())
                if (child->getStringAttribute("id") == id)
                {
                    found = true;
                    CHECK(child->getDoubleAttribute("value", -1.0) == 0.0, id << " was saved as " << child->getDoubleAttribute("value"));
                }
            CHECK(found, id << " missing from the saved state");
        }
    }
    // The live instance keeps its monitor state (only the saved copy is cleared).
    CHECK(a.getParameterValue("mono_check") == 1.0f, "getStateInformation cleared the live monitor switch");

    XlethFeddaEffect b;
    b.setStateInformation(mb.getData(), static_cast<int>(mb.getSize()));
    for (const auto& [id, v] : values)
        CHECK(std::fabs(b.getParameterValue(id) - v) < 0.01f, id << " restored as " << b.getParameterValue(id) << ", saved " << v);
    CHECK(b.getParameterValue("mono_check") == 0.0f && b.getParameterValue("compare") == 0.0f, "a monitor switch was restored on");

    // A state saved by hand with the monitor ON (an old or foreign blob) still restores it OFF.
    {
        auto state = juce::ValueTree::fromXml(*xml);
        state.getChildWithProperty("id", "mono_check").setProperty("value", 1.0f, nullptr);
        juce::MemoryBlock forced;
        juce::AudioProcessor::copyXmlToBinary(*state.createXml(), forced);
        XlethFeddaEffect c;
        c.setStateInformation(forced.getData(), static_cast<int>(forced.getSize()));
        CHECK(c.getParameterValue("mono_check") == 0.0f, "mono check restored on from a blob that had it on");
    }
}

void testLatencyAndAlignment()
{
    std::cout << "\n[Fedda] T3 zero latency\n";
    XlethFeddaEffect fx;
    fx.prepareToPlay(kSR, 512);
    fx.setParameterValue("width", 180.0f);
    fx.setParameterValue("character", 0.0f);
    CHECK(fx.getLatencySamples() == 0, "latency " << fx.getLatencySamples());

    juce::AudioBuffer<float> in(2, 4096);
    in.clear();
    in.setSample(0, 300, 1.0f);
    in.setSample(1, 300, 0.25f);
    const auto out = render(fx, in, 512);
    double worst = 0.0;
    for (int i = 0; i < 4096; ++i)
        worst = std::max(worst, std::fabs(0.5 * (out.getSample(0, i) + out.getSample(1, i)) - 0.5 * (in.getSample(0, i) + in.getSample(1, i))));
    std::cout << "  impulse mono-sum error " << worst << "\n";
    CHECK(worst < 1e-6, "mid path not aligned with the dry input (" << worst << ")");
    CHECK(fx.getLatencySamples() == 0, "latency changed while processing");
}

void testExportParity()
{
    std::cout << "\n[Fedda] T4 processBlock parity across block sizes\n";
    const auto in = noise(static_cast<int>(kSR * 1.5), 9);
    auto configure = [](XlethFeddaEffect& fx) {
        fx.setParameterValue("width", 160.0f);
        fx.setParameterValue("character", 2.0f);
        fx.setParameterValue("size", 11.0f);
        fx.setParameterValue("guard", 60.0f);
        fx.setParameterValue("hf_damp", 9000.0f);
        fx.setParameterValue("variation", 321.0f);
    };
    XlethFeddaEffect ref;
    configure(ref);
    ref.prepareToPlay(kSR, 64);
    const auto expect = render(ref, in, 64);
    for (int bs : { 32, 128, 333, 512, 1024 })
    {
        XlethFeddaEffect fx;
        configure(fx);
        fx.prepareToPlay(kSR, bs);
        CHECK(sameBuffers(render(fx, in, bs), expect), "block size " << bs << " renders differently");
    }
    // A live-style instance with block size 128 and an export-style non-realtime one agree.
    XlethFeddaEffect offline;
    configure(offline);
    offline.prepareToPlay(kSR, 1024);
    offline.setNonRealtime(true);
    CHECK(sameBuffers(render(offline, in, 1024), expect), "non-realtime render differs from live");
}

void testMonitorsForcedOffOffline()
{
    std::cout << "\n[Fedda] T8 monitors are ignored while non-realtime\n";
    const auto in = noise(static_cast<int>(kSR * 0.5), 5);
    for (const char* id : { "mono_check", "compare" })
    {
        XlethFeddaEffect live, offline, plain;
        for (auto* fx : { &live, &offline, &plain })
        {
            fx->setParameterValue("width", 120.0f);
            fx->setParameterValue("variation", 5.0f);
            fx->prepareToPlay(kSR, 256);
        }
        live.setParameterValue(id, 1.0f);
        offline.setParameterValue(id, 1.0f);
        offline.setNonRealtime(true);

        const auto o = render(offline, in, 256);
        const auto p = render(plain, in, 256);
        const auto l = render(live, in, 256);
        CHECK(sameBuffers(o, p), id << " changed a non-realtime render");
        CHECK(!sameBuffers(l, p), id << " did nothing live");
        CHECK(offline.readMeterValue(XlethFeddaEffect::kMeterMonitors) == 0.0f, id << " meter says engaged during a render");
    }
}

void testBypass()
{
    std::cout << "\n[Fedda] bypass\n";
    XlethFeddaEffect fx;
    fx.setParameterValue("width", 200.0f);
    fx.prepareToPlay(kSR, 256);
    fx.setBypassed(true);
    const auto in = noise(static_cast<int>(kSR * 0.2), 3);
    const auto out = render(fx, in, 256);
    double worst = 0.0;
    for (int c = 0; c < 2; ++c)
        for (int i = 1024; i < in.getNumSamples(); ++i)
            worst = std::max(worst, static_cast<double>(std::fabs(out.getSample(c, i) - in.getSample(c, i))));
    CHECK(worst == 0.0, "bypassed output differs from the input (" << worst << ")");
}

void testMeters()
{
    std::cout << "\n[Fedda] meters\n";
    {
        // Before the first block the slots say "silent", never 0 dB at correlation 0.
        XlethFeddaEffect idle;
        CHECK(idle.readMeterValue(XlethFeddaEffect::kMeterMidDb) <= -100.0f, "idle mid meter reads a level");
        CHECK(idle.readMeterValue(XlethFeddaEffect::kMeterSideDb) <= -100.0f, "idle side meter reads a level");
        CHECK(idle.readMeterValue(XlethFeddaEffect::kMeterCorrelation) == 1.0f, "idle correlation is not 1");
        CHECK(std::fabs(idle.readMeterValue(XlethFeddaEffect::kMeterTargetCorrelation) - 0.6f) < 1e-5f,
              "idle target for width 50 is " << idle.readMeterValue(XlethFeddaEffect::kMeterTargetCorrelation));
        // The target follows the width without a processed block (transport stopped) ...
        idle.setParameterValue("width", 100.0f);
        CHECK(std::fabs(idle.readMeterValue(XlethFeddaEffect::kMeterTargetCorrelation)) < 1e-6f,
              "target did not follow a width write while not processing");
        // ... and a restored state.
        XlethFeddaEffect wide;
        wide.setParameterValue("width", 200.0f);
        juce::MemoryBlock mb;
        wide.getStateInformation(mb);
        XlethFeddaEffect restored;
        restored.setStateInformation(mb.getData(), static_cast<int>(mb.getSize()));
        CHECK(std::fabs(restored.readMeterValue(XlethFeddaEffect::kMeterTargetCorrelation) + 0.6f) < 1e-5f,
              "target after restore is " << restored.readMeterValue(XlethFeddaEffect::kMeterTargetCorrelation));
    }
    XlethFeddaEffect fx;
    fx.setParameterValue("width", 100.0f);
    fx.setParameterValue("low_bypass", 20.0f);
    fx.prepareToPlay(kSR, 512);
    juce::AudioBuffer<float> in(2, static_cast<int>(kSR));
    Rng r(4);
    for (int i = 0; i < in.getNumSamples(); ++i) { const float v = r.bip() * 0.3f; in.setSample(0, i, v); in.setSample(1, i, v); }
    render(fx, in, 512);
    const float rho = fx.readMeterValue(XlethFeddaEffect::kMeterCorrelation);
    const float target = fx.readMeterValue(XlethFeddaEffect::kMeterTargetCorrelation);
    std::cout << "  mono white noise at width 100: correlation " << rho << " (target " << target << "), side "
              << fx.readMeterValue(XlethFeddaEffect::kMeterSideDb) << " dB, mid " << fx.readMeterValue(XlethFeddaEffect::kMeterMidDb) << " dB\n";
    CHECK(std::fabs(rho) < 0.1f, "correlation meter " << rho << " at width 100");
    CHECK(std::fabs(target) < 1e-6f, "target meter " << target);
}

} // namespace

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << "[Fedda] test_fedda\n";
    testParamContract();
    testSeedPerInstance();
    testStateRoundTrip();
    testLatencyAndAlignment();
    testExportParity();
    testMonitorsForcedOffOffline();
    testBypass();
    testMeters();
    std::cout << "\n[Fedda] " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0) std::cout << "[Fedda] ALL TESTS PASSED\n";
    return g_failed == 0 ? 0 : 1;
}
