// test_szkrezh.cpp — XlethSzkrezhEffect ("szkrezh"), the stock-effect face of SzkrezhCore.
// Build: cmake --build build --config Release --target test_szkrezh
// Run:   ctest --test-dir build -C Release -R "^test_szkrezh$" -V
// Pass:  prints "[Szkrezh] ALL TESTS PASSED" and exits 0.
//
//   W1  parameter contract: 31 ids, defaults, ranges, midi_track + quality not automatable
//   W2  state round-trip through getStateInformation / setStateInformation
//   W3  zero latency
//   W4  MIDI: only channel-1 note-ons are notes (channel 2 carries clip starts)
//   W5  Keys from another track through the per-block track MIDI table
//   W6  tail hold: raised while a short clip's crystals are pending, released once idle
//   W7  export parity through processBlock: block sizes 32 / 128 / 333 / 512 bit-identical
//   W8  bypass passes the dry signal
// The DSP itself is covered by test_szkrezh_core.

#include "audio/XlethSzkrezhEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <map>
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

// One block through the full processBlock path, with the globals MixEngine publishes.
void processAt(XlethSzkrezhEffect& fx, juce::AudioBuffer<float>& block, std::int64_t pos, juce::MidiBuffer* midi = nullptr)
{
    XlethEffectBase::setGlobalBPM(140.0);
    XlethEffectBase::setGlobalTransportPositionSamples(pos);
    juce::MidiBuffer empty;
    XlethEffectBase::setCurrentMidiBuffer(midi != nullptr ? midi : &empty);
    juce::MidiBuffer apg;
    fx.processBlock(block, apg);
    XlethEffectBase::setCurrentMidiBuffer(nullptr);
}

juce::AudioBuffer<float> render(XlethSzkrezhEffect& fx, const juce::AudioBuffer<float>& in, int blockSize)
{
    juce::AudioBuffer<float> out(in);
    for (int i = 0; i < in.getNumSamples(); i += blockSize)
    {
        const int n = std::min(blockSize, in.getNumSamples() - i);
        float* ch[2] = { out.getWritePointer(0, i), out.getWritePointer(1, i) };
        juce::AudioBuffer<float> view(ch, 2, n);
        processAt(fx, view, i);
    }
    return out;
}
} // namespace

static void testParamContract()
{
    std::cout << "\n[Szkrezh] W1 parameter contract\n";
    XlethSzkrezhEffect fx;
    const std::set<std::string> want = {
        "pitch_src", "pitch", "pitch_offset", "harmony", "key", "scale", "root", "midi_track",
        "sync", "splice", "splice_div", "smoothing", "delay", "delay_div", "splice_offset", "delay_offset",
        "reverse", "recycle", "fb_mode", "low_cut", "high_cut", "freeze",
        "dyn_amount", "dyn_threshold", "dyn_attack", "dyn_release", "dyn_target",
        "quality", "input", "output", "mix",
    };
    std::set<std::string> got;
    for (auto* raw : fx.getParameters())
        if (auto* rp = dynamic_cast<juce::RangedAudioParameter*>(raw))
            got.insert(rp->paramID.toStdString());
    CHECK(got == want, "W1 the 31 parameter ids");
    CHECK(fx.getPluginId() == "szkrezh", "W1 pluginId");

    const std::map<std::string, float> defaults = {
        { "pitch_src", 0.0f }, { "pitch", 1200.0f }, { "sync", 1.0f }, { "splice", 500.0f },
        { "splice_div", 10.0f }, { "smoothing", 20.0f }, { "delay", 0.0f }, { "reverse", 1.0f },
        { "recycle", 35.0f }, { "low_cut", 80.0f }, { "high_cut", 20000.0f }, { "mix", 50.0f },
        { "harmony", 2.0f }, { "root", 60.0f }, { "midi_track", 0.0f }, { "quality", 0.0f },
    };
    for (const auto& [id, v] : defaults)
        CHECK(std::fabs(fx.getParameterValue(id) - v) < 1e-3f, "W1 default " << id << " = " << v);

    for (const char* id : { "midi_track", "quality" })
        CHECK(findParam(fx, id) && !findParam(fx, id)->isAutomatable(), "W1 " << id << " is not automatable");
    for (const char* id : { "pitch", "splice", "recycle", "mix", "pitch_src", "harmony" })
        CHECK(findParam(fx, id) && findParam(fx, id)->isAutomatable(), "W1 " << id << " is automatable");

    CHECK(fx.setParameterValue("midi_track", 123457.0f) && fx.getParameterValue("midi_track") == 123457.0f,
          "W1 a large track id round-trips exactly");
    CHECK(fx.setParameterValue("pitch", -700.0f) && fx.getParameterValue("pitch") == -700.0f, "W1 pitch set/get");
}

static void testStateRoundTrip()
{
    std::cout << "\n[Szkrezh] W2 state round-trip\n";
    XlethSzkrezhEffect a;
    const std::map<std::string, float> values = {
        { "pitch_src", 2.0f }, { "pitch", -500.0f }, { "pitch_offset", 24.0f }, { "harmony", -3.0f },
        { "key", 9.0f }, { "scale", 1.0f }, { "root", 57.0f }, { "midi_track", 4242.0f }, { "sync", 0.0f },
        { "splice", 333.0f }, { "splice_div", 7.0f }, { "smoothing", 47.0f }, { "delay", 125.0f },
        { "delay_div", 4.0f }, { "splice_offset", 20.0f }, { "delay_offset", 10.0f }, { "reverse", 0.0f },
        { "recycle", 77.0f }, { "fb_mode", 1.0f }, { "low_cut", 300.0f }, { "high_cut", 8000.0f },
        { "freeze", 1.0f }, { "dyn_amount", -40.0f }, { "dyn_threshold", -18.0f }, { "dyn_attack", 12.0f },
        { "dyn_release", 600.0f }, { "dyn_target", 2.0f }, { "quality", 1.0f }, { "input", -3.0f },
        { "output", 2.5f }, { "mix", 100.0f },
    };
    for (const auto& [id, v] : values) a.setParameterValue(id, v);
    juce::MemoryBlock mb;
    a.getStateInformation(mb);
    XlethSzkrezhEffect b;
    b.setStateInformation(mb.getData(), static_cast<int>(mb.getSize()));
    bool all = true;
    for (const auto& [id, v] : values)
    {
        const bool ok = std::fabs(b.getParameterValue(id) - v) < 0.01f;
        if (!ok) std::cerr << "    " << id << ": " << b.getParameterValue(id) << " != " << v << "\n";
        all = all && ok;
    }
    CHECK(all, "W2 every parameter survives save / load");
}

static void testLatency()
{
    std::cout << "\n[Szkrezh] W3 zero latency\n";
    XlethSzkrezhEffect fx;
    fx.prepareToPlay(kSR, 512);
    CHECK(fx.getLatencySamples() == 0, "W3 reports no latency");
}

static void testMidiChannels()
{
    std::cout << "\n[Szkrezh] W4 only channel-1 note-ons are notes\n";
    XlethSzkrezhEffect fx;
    fx.setParameterValue("pitch_src", 1.0f);   // Harmony
    fx.prepareToPlay(kSR, 512);
    juce::AudioBuffer<float> block(2, 512);
    block.clear();

    juce::MidiBuffer clipStart;
    clipStart.addEvent(juce::MidiMessage::noteOn(2, 60, static_cast<juce::uint8>(100)), 10);
    processAt(fx, block, 0, &clipStart);
    CHECK(fx.readMeterValue(XlethSzkrezhEffect::kMeterHostNote) == -1.0f, "W4 a clip start (channel 2) is not a note");

    juce::MidiBuffer note;
    note.addEvent(juce::MidiMessage::noteOn(1, 64, static_cast<juce::uint8>(100)), 10);
    processAt(fx, block, 512, &note);
    CHECK(fx.readMeterValue(XlethSzkrezhEffect::kMeterHostNote) == 64.0f, "W4 a pattern note (channel 1) is");
}

static void testKeysFromOtherTrack()
{
    std::cout << "\n[Szkrezh] W5 Keys from another track\n";
    XlethSzkrezhEffect fx;
    fx.setParameterValue("pitch_src", 2.0f);   // Keys
    fx.setParameterValue("midi_track", 42.0f);
    fx.setParameterValue("root", 60.0f);
    fx.prepareToPlay(kSR, 512);
    juce::AudioBuffer<float> block(2, 512);
    block.clear();

    juce::MidiBuffer track42;
    track42.addEvent(juce::MidiMessage::noteOn(1, 67, static_cast<juce::uint8>(100)), 0);
    juce::MidiBuffer other;
    const XlethEffectBase::TrackMidiRef refs[] = { { 7, &other }, { 42, &track42 } };
    XlethEffectBase::setTrackMidiDirectory(refs, 2);
    processAt(fx, block, 0);
    XlethEffectBase::setTrackMidiDirectory(nullptr, 0);
    processAt(fx, block, 512);   // the retrigger lands 10 ms (480 samples) after the note
    CHECK(fx.readMeterValue(XlethSzkrezhEffect::kMeterKeyNote) == 67.0f, "W5 the Keys note comes from track 42");
    CHECK(fx.readMeterValue(XlethSzkrezhEffect::kMeterCentsL) == 700.0f, "W5 G over Root C: +700");

    XlethSzkrezhEffect missing;
    missing.setParameterValue("pitch_src", 2.0f);
    missing.setParameterValue("midi_track", 99.0f);
    missing.prepareToPlay(kSR, 512);
    XlethEffectBase::setTrackMidiDirectory(refs, 2);
    processAt(missing, block, 0);
    XlethEffectBase::setTrackMidiDirectory(nullptr, 0);
    CHECK(missing.readMeterValue(XlethSzkrezhEffect::kMeterKeyNote) == -1.0f, "W5 a track not in the table gives no notes");
    CHECK(XlethEffectBase::findTrackMidi(42) == nullptr, "W5 the table is gone once cleared");
}

static void testTailHold()
{
    std::cout << "\n[Szkrezh] W6 tail hold flag\n";
    XlethSzkrezhEffect fx;
    fx.prepareToPlay(kSR, 512);
    juce::AudioBuffer<float> block(2, 512);
    Rng r(3);
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < 512; ++i) block.setSample(c, i, r.bip() * 0.5f);
    (void) XlethEffectBase::takeTailHold();
    processAt(fx, block, 0);
    CHECK(XlethEffectBase::takeTailHold(), "W6 raised while a clip's crystals are pending");

    bool released = false;
    std::int64_t pos = 512;
    for (int k = 0; k < 2000 && !released; ++k, pos += 512)
    {
        block.clear();
        processAt(fx, block, pos);
        released = !XlethEffectBase::takeTailHold();
    }
    std::cout << "  released after " << pos / kSR << " s\n";
    CHECK(released, "W6 released once the tail has died");
}

static void testExportParity()
{
    std::cout << "\n[Szkrezh] W7 block sizes 32 / 128 / 333 / 512 through processBlock\n";
    const int n = static_cast<int>(1.0 * kSR);
    juce::AudioBuffer<float> in(2, n);
    Rng r(9);
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < n; ++i) in.setSample(c, i, r.bip() * 0.4f);

    auto make = [] {
        auto fx = std::make_unique<XlethSzkrezhEffect>();
        fx->setParameterValue("pitch", 700.0f);
        fx->setParameterValue("splice_div", 7.0f);
        fx->setParameterValue("recycle", 60.0f);
        fx->setParameterValue("pitch_offset", 40.0f);
        fx->setParameterValue("splice_offset", 25.0f);
        fx->setParameterValue("fb_mode", 1.0f);
        fx->prepareToPlay(kSR, 512);
        return fx;
    };
    auto ref = make();
    const auto a = render(*ref, in, 512);
    bool all = true;
    for (int bs : { 32, 128, 333 })
    {
        auto fx = make();
        const auto b = render(*fx, in, bs);
        bool same = true;
        for (int c = 0; c < 2; ++c)
            same = same && std::memcmp(a.getReadPointer(c), b.getReadPointer(c), sizeof(float) * static_cast<std::size_t>(n)) == 0;
        std::cout << "  " << bs << ": " << (same ? "same" : "DIFF") << "\n";
        all = all && same;
    }
    CHECK(all, "W7 bit-identical across block sizes");
}

static void testBypass()
{
    std::cout << "\n[Szkrezh] W8 bypass\n";
    XlethSzkrezhEffect fx;
    fx.prepareToPlay(kSR, 512);
    fx.setBypassed(true);
    fx.reset();
    juce::AudioBuffer<float> block(2, 512);
    Rng r(4);
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < 512; ++i) block.setSample(c, i, r.bip() * 0.5f);
    juce::AudioBuffer<float> dry(block);
    processAt(fx, block, 0);
    bool same = true;
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < 512; ++i) same = same && block.getSample(c, i) == dry.getSample(c, i);
    CHECK(same, "W8 bypassed output is the input");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << "[Szkrezh] test_szkrezh\n";
    testParamContract();
    testStateRoundTrip();
    testLatency();
    testMidiChannels();
    testKeysFromOtherTrack();
    testTailHold();
    testExportParity();
    testBypass();
    std::cout << "\n[Szkrezh] " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0) std::cout << "[Szkrezh] ALL TESTS PASSED\n";
    return g_failed == 0 ? 0 : 1;
}
