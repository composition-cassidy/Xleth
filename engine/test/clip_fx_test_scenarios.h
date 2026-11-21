// clip_fx_test_scenarios.h — shared render driver for the Pitch Shifter Clip
// mode (mode 4) clip-loop tests.
//
// One Scenario = one audio clip on one track, optionally with a Clip-mode
// Pitch Shifter on that track's chain, rendered through MixEngine::processBlock
// exactly the way the live callback and both exporters drive it.
//
// Kept in its own header because the golden hashes in test_clip_fx_transform
// were captured by this SAME driver against the pre-change engine (6a34820);
// the driver must not drift from what produced them.

#pragma once

#include "audio/MixEngine.h"
#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "SampleBank.h"
#include "Transport.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <memory>
#include <thread>

namespace clipfx_test
{
    struct Scenario
    {
        double bakeRate    = 44100.0;
        double exportRate  = 44100.0;
        double bpm         = 120.0;
        int    srcChannels = 2;
        double srcSeconds  = 1.5;
        float  srcFreq     = 220.0f;
        bool   srcAm       = true;       // 4 Hz AM so the envelope has structure

        double clipStartBeats = 0.25;
        double clipBeats      = 1.0;
        double regionOffsetBeats = 0.0;
        int    pitchSemis  = 0;
        int    pitchCents  = 0;
        double stretch     = 1.0;
        StretchMethod method = StretchMethod::Global;
        bool   reversed    = false;
        float  velocity    = 1.0f;
        float  fadeInPct   = 0.0f;
        float  fadeOutPct  = 0.0f;

        bool   shifter     = false;
        int    fxSemis     = 0;
        int    fxCents     = 0;
        int    fxMethodChoice = 1;       // clip_method choice index (0..4 -> StretchMethod 1..5)
        bool   fxFormant   = false;
        float  mix         = 1.0f;

        bool   warm        = false;      // wait for every render this clip needs

        // Optional replacement source (used verbatim, at bakeRate). Null = the
        // harmonic tone below, which is what the golden hashes were captured with.
        const juce::AudioBuffer<float>* customSource = nullptr;
        double tailSeconds = 0.1;
    };

    // Harmonic tone: fundamental + 2nd/3rd partials, optional slow AM.
    inline juce::AudioBuffer<float> makeTone(int channels, double rate, double seconds,
                                             float freq, bool am)
    {
        const int n = static_cast<int>(rate * seconds);
        juce::AudioBuffer<float> b(channels, n);
        const double twoPi = 2.0 * juce::MathConstants<double>::pi;
        for (int ch = 0; ch < channels; ++ch)
        {
            float* d = b.getWritePointer(ch);
            for (int i = 0; i < n; ++i)
            {
                const double t = i / rate;
                double v = 0.5 * std::sin(twoPi * freq * t + ch * 0.3)
                         + 0.2 * std::sin(twoPi * 2.0 * freq * t)
                         + 0.1 * std::sin(twoPi * 3.0 * freq * t);
                if (am) v *= 0.75 + 0.25 * std::sin(twoPi * 4.0 * t);
                d[i] = static_cast<float>(0.8 * v);
            }
        }
        return b;
    }

    inline std::uint64_t hashBuffer(const juce::AudioBuffer<float>& b)
    {
        std::uint64_t h = 1469598103934665603ULL;
        for (int ch = 0; ch < b.getNumChannels(); ++ch)
        {
            const auto* p = reinterpret_cast<const unsigned char*>(b.getReadPointer(ch));
            const std::size_t bytes = sizeof(float) * static_cast<std::size_t>(b.getNumSamples());
            for (std::size_t i = 0; i < bytes; ++i) { h ^= p[i]; h *= 1099511628211ULL; }
        }
        return h;
    }

    // Everything a test may want to poke at after (or instead of) a render.
    struct Rig
    {
        std::unique_ptr<Timeline>  timeline;
        std::unique_ptr<SampleBank> bank;
        std::unique_ptr<MixEngine> engine;
        int trackId  = -1;
        int regionId = -1;
        int clipId   = -1;
        int sampleId = -1;
        int nodeId   = -1;
    };

    using ReadyFn = std::function<bool(MixEngine&, int clipId)>;

    inline Rig buildRig(const Scenario& s, const ReadyFn& ready, int blockSize = 512)
    {
        Rig r;
        r.timeline = std::make_unique<Timeline>(s.bpm, s.exportRate);

        TrackInfo track; track.name = "t"; track.volume = 1.0f; track.pan = 0.0f;
        r.trackId = r.timeline->addTrack(track);

        SampleRegion region; region.name = "r"; region.label = SampleLabel::Custom;
        r.regionId = r.timeline->addRegion(region);

        Clip c;
        c.trackId          = r.trackId;
        c.regionId         = r.regionId;
        c.position         = TickTime::fromBeats(s.clipStartBeats);
        c.duration         = TickTime::fromBeats(s.clipBeats);
        c.regionOffset     = TickTime::fromBeats(s.regionOffsetBeats);
        c.pitchOffset      = s.pitchSemis;
        c.pitchOffsetCents = s.pitchCents;
        c.stretchRatio     = s.stretch;
        c.stretchMethod    = s.method;
        c.reversed         = s.reversed;
        c.velocity         = s.velocity;
        c.fadeInPercent    = s.fadeInPct;
        c.fadeOutPercent   = s.fadeOutPct;
        r.clipId = r.timeline->addClip(c);

        r.bank = std::make_unique<SampleBank>();
        r.sampleId = r.bank->addSampleFromBuffer(
            s.customSource != nullptr
                ? *s.customSource
                : makeTone(s.srcChannels, s.bakeRate, s.srcSeconds, s.srcFreq, s.srcAm),
            s.bakeRate, "clipfx");

        r.engine = std::make_unique<MixEngine>();
        r.engine->prepare(s.exportRate, blockSize);
        r.engine->setTimeline(r.timeline.get());
        r.engine->setSampleBank(r.bank.get());
        r.engine->mapRegionToSample(r.regionId, r.sampleId);

        if (s.shifter)
        {
            r.nodeId = r.engine->addEffect(r.trackId, "pitchshifter", 0);
            r.engine->setEffectParameter(r.trackId, r.nodeId, "mode", 3.0f);
            r.engine->setEffectParameter(r.trackId, r.nodeId, "clip_semitones", static_cast<float>(s.fxSemis));
            r.engine->setEffectParameter(r.trackId, r.nodeId, "clip_cents", static_cast<float>(s.fxCents));
            r.engine->setEffectParameter(r.trackId, r.nodeId, "clip_method", static_cast<float>(s.fxMethodChoice));
            r.engine->setEffectParameter(r.trackId, r.nodeId, "clip_formant", s.fxFormant ? 1.0f : 0.0f);
            r.engine->setEffectParameter(r.trackId, r.nodeId, "mix", s.mix);
            // Blocking: the envelope-applier thread can hold chainsMutex_ right
            // after addEffect, and a skipped poll would leave the table unpublished.
            r.engine->pollSourceTransformTableAt(ClipRenderCache::nowMs(), /*blocking=*/true);
            // Re-prepare so every smoother starts AT its parameter value rather
            // than ramping to it from the constructor default.
            r.engine->prepare(s.exportRate, blockSize);
        }

        if (s.warm)
        {
            r.engine->invalidateClipCache(r.clipId, "clipfx_test");
            for (int i = 0; i < 30000; ++i)
            {
                if (ready(*r.engine, r.clipId)) break;
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
            }
        }
        return r;
    }

    inline juce::AudioBuffer<float> renderRig(Rig& r, const Scenario& s, int blockSize = 512)
    {
        Transport transport;
        transport.setSampleRate(s.exportRate);
        transport.setBPM(s.bpm);
        transport.seekToSample(0);
        transport.play();

        const double secPerBeat = 60.0 / s.bpm;
        const int total = static_cast<int>(
            ((s.clipStartBeats + s.clipBeats) * secPerBeat + s.tailSeconds) * s.exportRate);

        juce::AudioBuffer<float> big(2, total);
        big.clear();
        juce::AudioBuffer<float> block(2, blockSize);

        int pos = 0;
        while (pos < total)
        {
            const int n = std::min(blockSize, total - pos);
            block.clear();
            r.engine->processBlock(block, n, transport);
            for (int ch = 0; ch < 2; ++ch)
                big.copyFrom(ch, pos, block, ch, 0, n);
            transport.advance(n);
            pos += n;
        }
        return big;
    }

    inline juce::AudioBuffer<float> render(const Scenario& s, const ReadyFn& ready)
    {
        auto rig = buildRig(s, ready);
        return renderRig(rig, s);
    }
}
