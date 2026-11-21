#pragma once

#include "audio/XlethEffectBase.h"
#include "dsp/szkrezh/SzkrezhCore.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

// ─── XlethSzkrezhEffect ("Szkrezh") ──────────────────────────────────────────
// Granular reverse pitch echo in the H3000 "Reverse Shift" lineage: the stock face of
// xleth::dsp::szkrezh::Core (dsp/szkrezh/SzkrezhCore.h documents the DSP). Two things only XLETH
// can do: splices are worked out from the transport position (a bounce or video export lands every
// splice on the same sample you heard), and Pitch Source can take the pitch from MIDI notes, so the
// crystals play harmonies over a pitch-sample melody or follow a key line from another track.
// Zero latency: the wet path IS a delay effect, compensating it would delay the dry signal.
//
// Parameters (APVTS; the core latches the timing/pitch ones per grain and smooths the rest, so
// none is registered with the base smoothers):
//   pitch_src     Knob / Harmony / Keys       Knob
//   pitch         -3600..3600 cents           +1200      Knob
//   pitch_offset  -2400..2400 cents           0          left down, right up, half each
//   harmony       -14..14 scale steps         +2         Harmony (a third above)
//   key           C..B                        C          Harmony
//   scale         9 scales                    Major      Harmony
//   root          0..127                      60         Keys reference note
//   midi_track    track id, 0 = this track    0          Keys source (not automatable)
//   sync          Off / On                    On
//   splice        10..2000 ms                 500        Free
//   splice_div    1/64 .. 1/1                 1/4        Sync
//   smoothing     5..250 ms                   20         crossfade between splices
//   delay         0..2000 ms                  0          Free
//   delay_div     0, 1/64 .. 1/1              0          Sync
//   splice_offset 0..50 %                     0          shortens the right splice
//   delay_offset  0..50 %                     0          shortens the right delay
//   reverse       Forward / Reverse           Reverse
//   recycle       0..100 %                    35         feedback, capped at 0.98 linear
//   fb_mode       Dual / Ping-pong / Mixed    Dual
//   low_cut       20..5000 Hz                 80         12 dB/oct, in the loop
//   high_cut      500..20000 Hz               20000      12 dB/oct, in the loop
//   freeze        Off / On                    Off        hold the tape
//   dyn_amount    -100..100 %                 0          < 0 gate, > 0 duck
//   dyn_threshold -60..0 dB                   -24
//   dyn_attack    0.1..200 ms                 5
//   dyn_release   10..2000 ms                 250
//   dyn_target    Output / Feedback / Both    Output
//   quality       Vintage / Clean             Vintage    (not automatable)
//   input         -24..24 dB                  0          into the tape
//   output        -24..24 dB                  0          wet out
//   mix           0..100 %                    50         equal power
//
// MIDI: the host track's buffer (XlethEffectBase sCurrentMidi_) carries pattern note-ons on
// channel 1 and clip starts on channel 2; only channel-1 note-ons are notes. A Keys source on
// another track is read from the per-block table MixEngine publishes (findTrackMidi).
//
// Meter slots:
//   0  wet peak L          4  latched pitch R, cents
//   1  wet peak R          5  splice phase L, 0..1
//   2  gate/duck gain      6  last host note (-1 none)
//   3  latched pitch L     7  last Keys note (-1 none)
//
// pluginId: "szkrezh".

class XlethSzkrezhEffect : public XlethEffectBase
{
public:
    enum MeterSlot
    {
        kMeterWetL = 0,
        kMeterWetR,
        kMeterDynGain,
        kMeterCentsL,
        kMeterCentsR,
        kMeterPhase,
        kMeterHostNote,
        kMeterKeyNote,
    };

    static constexpr int kMaxNotesPerBlock = 256;

    XlethSzkrezhEffect() : XlethEffectBase("szkrezh", createLayout())
    {
        for (std::size_t i = 0; i < kParamIds.size(); ++i)
            raw_[i] = apvts_.getRawParameterValue(kParamIds[i]);
    }

    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        core_.prepare(sampleRate);
        monoScratch_.assign(static_cast<std::size_t>(std::max(maxBlockSize, 1)), 0.0f);
    }

    void resetEffect() override { core_.reset(); }

    double getTailLengthSeconds() const override
    {
        if (read(P::Freeze) >= 0.5f) return 30.0;
        const double bpm   = std::max(1.0, getGlobalBPM() > 0.0 ? getGlobalBPM() : 140.0);
        const bool   sync  = read(P::Sync) >= 0.5f;
        const double beat  = 60.0 / bpm;
        const double hop   = std::min(2.0, sync ? xleth::dsp::szkrezh::divisionBeats(static_cast<int>(read(P::SpliceDiv))) * beat
                                                : static_cast<double>(read(P::Splice)) * 1e-3);
        const double delay = std::min(2.0, sync ? xleth::dsp::szkrezh::divisionBeats(static_cast<int>(read(P::DelayDiv))) * beat
                                                : static_cast<double>(read(P::Delay)) * 1e-3);
        const double pass  = delay + 9.0 * (hop + static_cast<double>(read(P::Smoothing)) * 1e-3);
        const double fb    = static_cast<double>(read(P::Recycle)) * 0.01 * 0.98;
        const double repeats = fb > 0.01 ? -3.0 / std::log10(fb) : 0.0;
        return std::min(30.0, pass * (1.0 + repeats));
    }

    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = buffer.getNumChannels();
        if (numSamples <= 0 || numCh <= 0) return;

        core_.setParams(snapshotParams());

        const int  midiTrack    = static_cast<int>(std::lround(read(P::MidiTrack)));
        const bool keysFromHost = midiTrack <= 0;

        xleth::dsp::szkrezh::BlockContext ctx;
        ctx.transportPos = getGlobalTransportPositionSamples();
        ctx.bpm          = getGlobalBPM();
        ctx.barBeats     = 4.0;   // the engine's transport counts 4/4 bars (Transport::getPositionBars)
        ctx.keysFromHost = keysFromHost;
        ctx.hostNotes    = hostNotes_.data();
        ctx.numHostNotes = collectNoteOns(&midi, hostNotes_.data(), numSamples);
        ctx.keyNotes     = keyNotes_.data();
        ctx.numKeyNotes  = keysFromHost ? 0 : collectNoteOns(findTrackMidi(midiTrack), keyNotes_.data(), numSamples);

        float* left = buffer.getWritePointer(0);
        if (numCh >= 2)
        {
            core_.process(left, buffer.getWritePointer(1), numSamples, ctx);
        }
        else
        {
            // Mono bus: run the right engine on a copy of the left and keep the left output.
            const int n = std::min(numSamples, static_cast<int>(monoScratch_.size()));
            std::copy(left, left + n, monoScratch_.begin());
            core_.process(left, monoScratch_.data(), n, ctx);
        }

        writeMeterValue(kMeterWetL,     core_.wetPeak(0));
        writeMeterValue(kMeterWetR,     core_.wetPeak(1));
        writeMeterValue(kMeterDynGain,  core_.dynGain());
        writeMeterValue(kMeterCentsL,   core_.latchedCents(0));
        writeMeterValue(kMeterCentsR,   core_.latchedCents(1));
        writeMeterValue(kMeterPhase,    core_.splicePhase(0));
        writeMeterValue(kMeterHostNote, static_cast<float>(core_.lastHostNote()));
        writeMeterValue(kMeterKeyNote,  static_cast<float>(core_.lastKeyNote()));

        if (core_.holdsTail())
            raiseTailHold();
    }

    const xleth::dsp::szkrezh::Core& core() const noexcept { return core_; }

    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;
        using AfA = juce::AudioParameterFloatAttributes;

        auto f = [](const char* id, const char* name, Nar range, float def, const char* unit) {
            return std::make_unique<Apf>(Pid{ id, 1 }, name, range, def, AfA{}.withLabel(unit));
        };
        auto fixed = [](const char* id, const char* name, Nar range, float def, const char* unit) {
            return std::make_unique<Apf>(Pid{ id, 1 }, name, range, def,
                                         AfA{}.withLabel(unit).withAutomatable(false));
        };

        return {
            f("pitch_src",     "Pitch Source",  Nar{ 0.0f, 2.0f, 1.0f },           0.0f,     ""),
            f("pitch",         "Pitch",         Nar{ -3600.0f, 3600.0f, 1.0f },    1200.0f,  "ct"),
            f("pitch_offset",  "Pitch Offset",  Nar{ -2400.0f, 2400.0f, 1.0f },    0.0f,     "ct"),
            f("harmony",       "Interval",      Nar{ -14.0f, 14.0f, 1.0f },        2.0f,     ""),
            f("key",           "Key",           Nar{ 0.0f, 11.0f, 1.0f },          0.0f,     ""),
            f("scale",         "Scale",         Nar{ 0.0f, 8.0f, 1.0f },           0.0f,     ""),
            f("root",          "Root",          Nar{ 0.0f, 127.0f, 1.0f },         60.0f,    ""),
            // A track id, not a level: automating it would hop between tracks. 0 = this track.
            fixed("midi_track","MIDI Track",    Nar{ 0.0f, 1000000.0f, 1.0f },     0.0f,     ""),
            f("sync",          "Sync",          Nar{ 0.0f, 1.0f, 1.0f },           1.0f,     ""),
            f("splice",        "Splice",        Nar{ 10.0f, 2000.0f, 0.0f, 0.4f }, 500.0f,   "ms"),
            f("splice_div",    "Splice Div",    Nar{ 1.0f, 15.0f, 1.0f },          static_cast<float>(xleth::dsp::szkrezh::kDefaultSpliceDivision), ""),
            f("smoothing",     "Smoothing",     Nar{ 5.0f, 250.0f, 0.0f, 0.5f },   20.0f,    "ms"),
            f("delay",         "Delay",         Nar{ 0.0f, 2000.0f, 0.0f, 0.4f },  0.0f,     "ms"),
            f("delay_div",     "Delay Div",     Nar{ 0.0f, 15.0f, 1.0f },          0.0f,     ""),
            f("splice_offset", "Splice Offset", Nar{ 0.0f, 50.0f, 0.0f, 1.0f },    0.0f,     "%"),
            f("delay_offset",  "Delay Offset",  Nar{ 0.0f, 50.0f, 0.0f, 1.0f },    0.0f,     "%"),
            f("reverse",       "Reverse",       Nar{ 0.0f, 1.0f, 1.0f },           1.0f,     ""),
            f("recycle",       "Recycle",       Nar{ 0.0f, 100.0f, 0.0f, 1.0f },   35.0f,    "%"),
            f("fb_mode",       "FB Mode",       Nar{ 0.0f, 2.0f, 1.0f },           0.0f,     ""),
            f("low_cut",       "Low Cut",       Nar{ 20.0f, 5000.0f, 0.0f, 0.3f }, 80.0f,    "Hz"),
            f("high_cut",      "High Cut",      Nar{ 500.0f, 20000.0f, 0.0f, 0.3f }, 20000.0f, "Hz"),
            f("freeze",        "Freeze",        Nar{ 0.0f, 1.0f, 1.0f },           0.0f,     ""),
            f("dyn_amount",    "Gate/Duck",     Nar{ -100.0f, 100.0f, 0.0f, 1.0f }, 0.0f,    "%"),
            f("dyn_threshold", "Threshold",     Nar{ -60.0f, 0.0f, 0.0f, 1.0f },   -24.0f,   "dB"),
            f("dyn_attack",    "Attack",        Nar{ 0.1f, 200.0f, 0.0f, 0.4f },   5.0f,     "ms"),
            f("dyn_release",   "Release",       Nar{ 10.0f, 2000.0f, 0.0f, 0.4f }, 250.0f,   "ms"),
            f("dyn_target",    "Gate Target",   Nar{ 0.0f, 2.0f, 1.0f },           0.0f,     ""),
            // Switching the reader mid-splice is fine, but it changes CPU by up to 24x: keep it a setting.
            fixed("quality",   "Quality",       Nar{ 0.0f, 1.0f, 1.0f },           0.0f,     ""),
            f("input",         "Input",         Nar{ -24.0f, 24.0f, 0.0f, 1.0f },  0.0f,     "dB"),
            f("output",        "Output",        Nar{ -24.0f, 24.0f, 0.0f, 1.0f },  0.0f,     "dB"),
            f("mix",           "Mix",           Nar{ 0.0f, 100.0f, 0.0f, 1.0f },   50.0f,    "%"),
        };
    }

private:
    enum class P : int
    {
        PitchSrc = 0, Pitch, PitchOffset, Harmony, Key, Scale, Root, MidiTrack,
        Sync, Splice, SpliceDiv, Smoothing, Delay, DelayDiv, SpliceOffset, DelayOffset, Reverse,
        Recycle, FbMode, LowCut, HighCut, Freeze,
        DynAmount, DynThreshold, DynAttack, DynRelease, DynTarget,
        Quality, Input, Output, Mix,
        Count
    };

    static constexpr std::array<const char*, static_cast<std::size_t>(P::Count)> kParamIds = {
        "pitch_src", "pitch", "pitch_offset", "harmony", "key", "scale", "root", "midi_track",
        "sync", "splice", "splice_div", "smoothing", "delay", "delay_div", "splice_offset", "delay_offset", "reverse",
        "recycle", "fb_mode", "low_cut", "high_cut", "freeze",
        "dyn_amount", "dyn_threshold", "dyn_attack", "dyn_release", "dyn_target",
        "quality", "input", "output", "mix",
    };

    float read(P p) const noexcept
    {
        const auto* r = raw_[static_cast<std::size_t>(p)];
        return r != nullptr ? r->load(std::memory_order_relaxed) : 0.0f;
    }

    int readInt(P p) const noexcept { return static_cast<int>(std::lround(read(p))); }

    xleth::dsp::szkrezh::Params snapshotParams() const noexcept
    {
        using namespace xleth::dsp::szkrezh;
        Params q;
        q.pitchSource      = static_cast<PitchSource>(std::clamp(readInt(P::PitchSrc), 0, 2));
        q.pitchCents       = read(P::Pitch);
        q.pitchOffsetCents = read(P::PitchOffset);
        q.harmonySteps     = readInt(P::Harmony);
        q.key              = readInt(P::Key);
        q.scale            = readInt(P::Scale);
        q.rootNote         = readInt(P::Root);
        q.sync             = read(P::Sync) >= 0.5f;
        q.spliceMs         = read(P::Splice);
        q.spliceDiv        = readInt(P::SpliceDiv);
        q.smoothingMs      = read(P::Smoothing);
        q.delayMs          = read(P::Delay);
        q.delayDiv         = readInt(P::DelayDiv);
        q.spliceOffset     = read(P::SpliceOffset) * 0.01f;
        q.delayOffset      = read(P::DelayOffset) * 0.01f;
        q.reverse          = read(P::Reverse) >= 0.5f;
        q.quality          = read(P::Quality) >= 0.5f ? Quality::Clean : Quality::Vintage;
        q.recycle          = read(P::Recycle) * 0.01f;
        q.fbMode           = static_cast<FeedbackMode>(std::clamp(readInt(P::FbMode), 0, 2));
        q.lowCutHz         = read(P::LowCut);
        q.highCutHz        = read(P::HighCut);
        q.freeze           = read(P::Freeze) >= 0.5f;
        q.dynAmount        = read(P::DynAmount) * 0.01f;
        q.dynThresholdDb   = read(P::DynThreshold);
        q.dynAttackMs      = read(P::DynAttack);
        q.dynReleaseMs     = read(P::DynRelease);
        q.dynTarget        = static_cast<DynTarget>(std::clamp(readInt(P::DynTarget), 0, 2));
        q.inputGainDb      = read(P::Input);
        q.outputGainDb     = read(P::Output);
        q.mix              = read(P::Mix) * 0.01f;
        return q;
    }

    // Channel-1 note-ons only (channel 2 carries clip starts). Raw bytes: no MidiMessage built.
    static int collectNoteOns(const juce::MidiBuffer* mb, xleth::dsp::szkrezh::NoteEvent* out, int numSamples) noexcept
    {
        if (mb == nullptr) return 0;
        int n = 0;
        for (const auto meta : *mb)
        {
            if (meta.numBytes < 3) continue;
            const juce::uint8* d = meta.data;
            if (d[0] != 0x90 || d[2] == 0) continue;
            if (n >= kMaxNotesPerBlock) break;
            out[n++] = { std::clamp(meta.samplePosition, 0, std::max(0, numSamples - 1)), static_cast<int>(d[1]) };
        }
        return n;
    }

    xleth::dsp::szkrezh::Core core_;
    std::array<std::atomic<float>*, static_cast<std::size_t>(P::Count)> raw_ {};
    std::array<xleth::dsp::szkrezh::NoteEvent, kMaxNotesPerBlock> hostNotes_ {};
    std::array<xleth::dsp::szkrezh::NoteEvent, kMaxNotesPerBlock> keyNotes_ {};
    std::vector<float> monoScratch_;
};
