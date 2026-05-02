// test_distortion.cpp - focused XlethDistortionEffect diagnostics
// Build: cmake --build build --config Release --target test_distortion
// Run:   build\engine\Release\test_distortion.exe

#include "audio/XlethDistortionEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <array>
#include <cmath>
#include <iostream>
#include <string>

namespace
{
constexpr double kSampleRate = 48000.0;
constexpr int    kBlockSize = 4096;
constexpr int    kFundamentalBin = 32;
constexpr float  kFundamentalHz = static_cast<float>(kSampleRate * kFundamentalBin / kBlockSize);
constexpr float  kSineAmp = 0.50f;
constexpr int    kNumModes = 4;
constexpr int    kMaxHarmonic = 11;

const char* modeName(int mode)
{
    switch (mode)
    {
        case 0: return "Tube";
        case 1: return "Soft Clip";
        case 2: return "Hard Clip";
        case 3: return "Analog";
        default: return "Unknown";
    }
}

struct HarmonicSummary
{
    std::array<float, kMaxHarmonic + 1> harmonic {};
    float upperEnergy = 0.0f;
    float evenEnergy = 0.0f;
    float oddEnergy = 0.0f;
    float evenRatio = 0.0f;
};

void fillSineBlock(juce::AudioBuffer<float>& buffer, int blockIndex)
{
    constexpr float twoPi = 2.0f * juce::MathConstants<float>::pi;

    for (int s = 0; s < kBlockSize; ++s)
    {
        const int absoluteSample = blockIndex * kBlockSize + s;
        const float phase = twoPi * static_cast<float>(kFundamentalBin * absoluteSample)
                          / static_cast<float>(kBlockSize);
        const float v = kSineAmp * std::sin(phase);
        buffer.setSample(0, s, v);
        buffer.setSample(1, s, v);
    }
}

float measureBinMagnitude(const juce::AudioBuffer<float>& buffer, int bin)
{
    const float* data = buffer.getReadPointer(0);
    double re = 0.0;
    double im = 0.0;

    for (int s = 0; s < kBlockSize; ++s)
    {
        const double phase = -2.0 * juce::MathConstants<double>::pi
                           * static_cast<double>(bin * s)
                           / static_cast<double>(kBlockSize);
        re += static_cast<double>(data[s]) * std::cos(phase);
        im += static_cast<double>(data[s]) * std::sin(phase);
    }

    return static_cast<float>(2.0 * std::sqrt(re * re + im * im)
                              / static_cast<double>(kBlockSize));
}

HarmonicSummary renderAndMeasureMode(int mode)
{
    XlethDistortionEffect fx;
    fx.setParameterValue("mode", static_cast<float>(mode));
    fx.setParameterValue("drive", 18.0f);
    fx.setParameterValue("tone", 20000.0f);
    fx.setParameterValue("filter_pos", 1.0f);
    fx.setParameterValue("mix", 100.0f);
    fx.prepareToPlay(kSampleRate, kBlockSize);

    juce::AudioBuffer<float> buffer(2, kBlockSize);
    juce::MidiBuffer midi;

    for (int block = 0; block < 6; ++block)
    {
        fillSineBlock(buffer, block);
        fx.processBlock(buffer, midi);
    }

    HarmonicSummary summary;
    for (int h = 1; h <= kMaxHarmonic; ++h)
    {
        summary.harmonic[static_cast<size_t>(h)] =
            measureBinMagnitude(buffer, kFundamentalBin * h);
    }

    for (int h = 2; h <= kMaxHarmonic; ++h)
    {
        const float energy = summary.harmonic[static_cast<size_t>(h)]
                           * summary.harmonic[static_cast<size_t>(h)];

        if (h >= 5)
            summary.upperEnergy += energy;

        if ((h % 2) == 0)
            summary.evenEnergy += energy;
        else
            summary.oddEnergy += energy;
    }

    const float harmonicEnergy = summary.evenEnergy + summary.oddEnergy;
    summary.evenRatio = harmonicEnergy > 1.0e-12f
        ? summary.evenEnergy / harmonicEnergy
        : 0.0f;

    return summary;
}

void printSummary(const std::array<HarmonicSummary, kNumModes>& summaries)
{
    std::cout << "Fundamental: " << kFundamentalHz << " Hz, drive=18 dB, mix=100%, tone=20 kHz\n";
    for (int mode = 0; mode < kNumModes; ++mode)
    {
        const auto& s = summaries[static_cast<size_t>(mode)];
        std::cout << "  " << modeName(mode)
                  << " upperE(h5-h11)=" << s.upperEnergy
                  << " evenRatio(h2-h11)=" << s.evenRatio
                  << " h2=" << s.harmonic[2]
                  << " h3=" << s.harmonic[3]
                  << " h5=" << s.harmonic[5]
                  << " h7=" << s.harmonic[7]
                  << "\n";
    }
}

bool check(bool condition, const std::string& message)
{
    if (!condition)
        std::cerr << "FAIL: " << message << "\n";
    return condition;
}
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::array<HarmonicSummary, kNumModes> summaries {};
    for (int mode = 0; mode < kNumModes; ++mode)
        summaries[static_cast<size_t>(mode)] = renderAndMeasureMode(mode);

    printSummary(summaries);

    const auto& tube = summaries[0];
    const auto& soft = summaries[1];
    const auto& hard = summaries[2];
    const auto& analog = summaries[3];

    bool ok = true;
    // A 20% margin is large enough to catch collapsed or reordered shapers, but
    // loose enough to avoid brittle dependence on exact oversampling/filter bins.
    ok &= check(hard.upperEnergy > soft.upperEnergy * 1.20f,
                "Hard Clip should have clearly more upper harmonic energy than Soft Clip");
    ok &= check(soft.upperEnergy > tube.upperEnergy * 1.20f,
                "Soft Clip should have clearly more upper harmonic energy than Tube");
    const float strongestSymmetricEvenRatio = std::max(tube.evenRatio,
        std::max(soft.evenRatio, hard.evenRatio));
    // Symmetric shapers should have near-zero even harmonics for a centered sine.
    // Analog must be both absolutely visible (>5%) and far above that noise floor.
    ok &= check(analog.evenRatio > 0.05f
             && analog.evenRatio > strongestSymmetricEvenRatio * 20.0f,
                "Analog should have meaningfully stronger even-order harmonic content");

    if (!ok)
        return 1;

    std::cout << "ALL DISTORTION TESTS PASSED\n";
    return 0;
}
