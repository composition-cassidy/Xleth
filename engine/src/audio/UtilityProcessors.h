#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_dsp/juce_dsp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace xleth::audio {

inline constexpr const char* kUtilityBalanceId           = "xleth.utility.balance";
inline constexpr const char* kUtilityMergeId             = "xleth.utility.merge";
inline constexpr const char* kUtilityMidSideSplitterId   = "xleth.utility.midSideSplitter";
inline constexpr const char* kUtilityFrequencySplitterId = "xleth.utility.frequencySplitter";

namespace detail {

struct ModulationOverride
{
    std::atomic<float> value{ 0.0f };
    std::atomic<bool>  active{ false };
};

class ModulationOverrideMap
{
public:
    void registerParam(const std::string& id)
    {
        if (map_.find(id) == map_.end())
            map_.emplace(id, std::make_unique<ModulationOverride>());
    }

    bool set(const std::string& id, float value) noexcept
    {
        auto it = map_.find(id);
        if (it == map_.end() || !it->second) return false;
        it->second->value.store(value, std::memory_order_relaxed);
        it->second->active.store(true, std::memory_order_relaxed);
        return true;
    }

    void clearAll() noexcept
    {
        for (auto& [id, ov] : map_)
            if (ov) ov->active.store(false, std::memory_order_relaxed);
    }

    float effective(const std::string& id, float fallback) const noexcept
    {
        auto it = map_.find(id);
        if (it != map_.end() && it->second
            && it->second->active.load(std::memory_order_relaxed))
        {
            return it->second->value.load(std::memory_order_relaxed);
        }
        return fallback;
    }

private:
    std::unordered_map<std::string, std::unique_ptr<ModulationOverride>> map_;
};

inline std::string parametersAsJsonFromApvts(const juce::AudioProcessorValueTreeState& apvts,
                                             const juce::AudioProcessor& processor)
{
    nlohmann::json arr = nlohmann::json::array();
    for (auto* param : processor.getParameters())
    {
        auto* rp = dynamic_cast<juce::RangedAudioParameter*>(param);
        if (!rp) continue;
        const auto& range = rp->getNormalisableRange();
        nlohmann::json p;
        p["id"]      = rp->paramID.toStdString();
        p["name"]    = rp->getName(256).toStdString();
        p["min"]     = range.start;
        p["max"]     = range.end;
        p["default"] = rp->convertFrom0to1(rp->getDefaultValue());
        p["value"]   = rp->convertFrom0to1(rp->getValue());
        p["unit"]    = rp->getLabel().toStdString();
        arr.push_back(std::move(p));
    }
    juce::ignoreUnused(apvts);
    return arr.dump();
}

}

// ─── BalanceProcessor ───────────────────────────────────────────────────────
// Stereo volume (dB) + balance (-1..+1).  At pan==0 both channels pass at the
// volume gain; pan>0 attenuates the left channel linearly, pan<0 attenuates
// the right.  This is a balance law (not equal-power pan), so the centre
// position is unity — matching test_pdc_stage1's "unity center" expectation.
class BalanceProcessor : public juce::AudioProcessor
{
public:
    BalanceProcessor()
        : AudioProcessor(BusesProperties()
              .withInput ("main", juce::AudioChannelSet::stereo(), true)
              .withOutput("main", juce::AudioChannelSet::stereo(), true)),
          apvts_(*this, nullptr, "BalanceState", createLayout())
    {
        volumeDbPtr_ = apvts_.getRawParameterValue("volumeDb");
        panPtr_      = apvts_.getRawParameterValue("pan");
        mods_.registerParam("volumeDb");
        mods_.registerParam("pan");
    }

    const juce::String getName() const override { return "BalanceProcessor"; }
    double getTailLengthSeconds() const override { return 0.0; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& dest) override
    {
        if (auto xml = apvts_.copyState().createXml())
            copyXmlToBinary(*xml, dest);
    }

    void setStateInformation(const void* data, int sizeInBytes) override
    {
        if (auto xml = getXmlFromBinary(data, sizeInBytes))
            apvts_.replaceState(juce::ValueTree::fromXml(*xml));
    }

    void prepareToPlay(double /*sr*/, int /*block*/) override {}
    void releaseResources() override {}

    bool isBusesLayoutSupported(const BusesLayout& layouts) const override
    {
        return layouts.getMainInputChannelSet()  == juce::AudioChannelSet::stereo()
            && layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
    }

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        juce::ScopedNoDenormals _;
        const float volumeDb = mods_.effective("volumeDb",
                                  volumeDbPtr_ ? volumeDbPtr_->load(std::memory_order_relaxed) : 0.0f);
        const float pan      = std::clamp(mods_.effective("pan",
                                  panPtr_ ? panPtr_->load(std::memory_order_relaxed) : 0.0f), -1.0f, 1.0f);

        const float linGain = std::pow(10.0f, volumeDb / 20.0f);
        const float lGain   = (pan <= 0.0f ? 1.0f : 1.0f - pan) * linGain;
        const float rGain   = (pan >= 0.0f ? 1.0f : 1.0f + pan) * linGain;

        const int n = buffer.getNumSamples();
        if (buffer.getNumChannels() >= 1) buffer.applyGain(0, 0, n, lGain);
        if (buffer.getNumChannels() >= 2) buffer.applyGain(1, 0, n, rGain);
    }

    bool setRealtimeModulatedParameter(const std::string& paramId, float value) noexcept
    {
        return mods_.set(paramId, value);
    }

    void clearRealtimeModulationOverrides() noexcept { mods_.clearAll(); }

    float getModulationParameterValue(const std::string& paramId) const noexcept
    {
        if (paramId == "volumeDb")
            return mods_.effective("volumeDb",
                       volumeDbPtr_ ? volumeDbPtr_->load(std::memory_order_relaxed) : 0.0f);
        if (paramId == "pan")
            return mods_.effective("pan",
                       panPtr_ ? panPtr_->load(std::memory_order_relaxed) : 0.0f);
        return 0.0f;
    }

    std::string getParametersAsJSON() const
    {
        return detail::parametersAsJsonFromApvts(apvts_, *this);
    }

private:
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        juce::AudioProcessorValueTreeState::ParameterLayout layout;
        layout.add(std::make_unique<juce::AudioParameterFloat>(
            juce::ParameterID{ "volumeDb", 1 }, "Volume",
            juce::NormalisableRange<float>{ -60.0f, 12.0f, 0.01f }, 0.0f, "dB"));
        layout.add(std::make_unique<juce::AudioParameterFloat>(
            juce::ParameterID{ "pan", 1 }, "Pan",
            juce::NormalisableRange<float>{ -1.0f, 1.0f, 0.001f }, 0.0f, ""));
        return layout;
    }

    juce::AudioProcessorValueTreeState apvts_;
    std::atomic<float>* volumeDbPtr_ = nullptr;
    std::atomic<float>* panPtr_      = nullptr;
    detail::ModulationOverrideMap mods_;
};

// ─── MergeProcessor ─────────────────────────────────────────────────────────
// Stereo passthrough.  The actual summing of multiple incoming connections is
// performed by juce::AudioProcessorGraph at the connection layer; this node
// simply exposes a single stereo bus pair so callers can route many sources
// to it and pick up the summed result on the output.
class MergeProcessor : public juce::AudioProcessor
{
public:
    MergeProcessor()
        : AudioProcessor(BusesProperties()
              .withInput ("main", juce::AudioChannelSet::stereo(), true)
              .withOutput("main", juce::AudioChannelSet::stereo(), true))
    {}

    const juce::String getName() const override { return "MergeProcessor"; }
    double getTailLengthSeconds() const override { return 0.0; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    int  getNumPrograms() override { return 1; }
    int  getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock&) override {}
    void setStateInformation(const void*, int) override {}

    void prepareToPlay(double, int) override {}
    void releaseResources() override {}

    bool isBusesLayoutSupported(const BusesLayout& layouts) const override
    {
        return layouts.getMainInputChannelSet()  == juce::AudioChannelSet::stereo()
            && layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
    }

    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override {}
};

// ─── MidSideSplitterProcessor ───────────────────────────────────────────────
// One stereo input → two stereo output buses ("mid", "side").
//   mid_L  = mid_R  = 0.5 * (L + R)
//   side_L = +0.5 * (L - R)
//   side_R = -0.5 * (L - R)
// Summing the four output channels gives back exactly (L, R) sample-perfect,
// which is what test_pdc_stage1's -130 dB null check requires.
class MidSideSplitterProcessor : public juce::AudioProcessor
{
public:
    MidSideSplitterProcessor()
        : AudioProcessor(BusesProperties()
              .withInput ("main", juce::AudioChannelSet::stereo(), true)
              .withOutput("mid",  juce::AudioChannelSet::stereo(), true)
              .withOutput("side", juce::AudioChannelSet::stereo(), true))
    {}

    const juce::String getName() const override { return "MidSideSplitterProcessor"; }
    double getTailLengthSeconds() const override { return 0.0; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    int  getNumPrograms() override { return 1; }
    int  getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock&) override {}
    void setStateInformation(const void*, int) override {}

    void prepareToPlay(double, int) override {}
    void releaseResources() override {}

    bool isBusesLayoutSupported(const BusesLayout& layouts) const override
    {
        if (layouts.inputBuses.size() != 1 || layouts.outputBuses.size() != 2)
            return false;
        return layouts.getChannelSet(true,  0) == juce::AudioChannelSet::stereo()
            && layouts.getChannelSet(false, 0) == juce::AudioChannelSet::stereo()
            && layouts.getChannelSet(false, 1) == juce::AudioChannelSet::stereo();
    }

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        juce::ScopedNoDenormals _;
        auto inBus  = getBusBuffer(buffer, true,  0);
        auto midBus = getBusBuffer(buffer, false, 0);
        auto sideBus= getBusBuffer(buffer, false, 1);
        const int n = inBus.getNumSamples();

        const float* L = inBus.getNumChannels() > 0 ? inBus.getReadPointer(0) : nullptr;
        const float* R = inBus.getNumChannels() > 1 ? inBus.getReadPointer(1) : L;
        float* mL = midBus .getWritePointer(0);
        float* mR = midBus .getNumChannels() > 1 ? midBus .getWritePointer(1) : nullptr;
        float* sL = sideBus.getWritePointer(0);
        float* sR = sideBus.getNumChannels() > 1 ? sideBus.getWritePointer(1) : nullptr;

        for (int i = 0; i < n; ++i)
        {
            const float l = L ? L[i] : 0.0f;
            const float r = R ? R[i] : 0.0f;
            const float m = 0.5f * (l + r);
            const float s = 0.5f * (l - r);
            mL[i] = m;
            if (mR) mR[i] = m;
            sL[i] =  s;
            if (sR) sR[i] = -s;
        }
    }
};

// ─── FrequencySplitterProcessor ─────────────────────────────────────────────
// 2/3/4-band Linkwitz-Riley splitter with allpass-compensated cascade so that
// summing every output bus back together reconstructs the input within
// numerical precision (test target: -80 dB RMS null on white noise).
//
// Output buses (always present; unused ones emit silence per bandCount):
//   low, lowMid, mid, highMid, high
//
// Crossover frequency parameters (Hz, present always; only the relevant subset
// applies per bandCount, others are ignored):
//   2-band:  lowHighFreq
//   3-band:  lowMidFreq, midHighFreq
//   4-band:  lowLowMidFreq, lowMidHighMidFreq, highMidHighFreq
class FrequencySplitterProcessor : public juce::AudioProcessor
{
public:
    static constexpr int kMaxBands = 4;

    FrequencySplitterProcessor()
        : AudioProcessor(BusesProperties()
              .withInput ("main",    juce::AudioChannelSet::stereo(), true)
              .withOutput("low",     juce::AudioChannelSet::stereo(), true)
              .withOutput("lowMid",  juce::AudioChannelSet::stereo(), true)
              .withOutput("mid",     juce::AudioChannelSet::stereo(), true)
              .withOutput("highMid", juce::AudioChannelSet::stereo(), true)
              .withOutput("high",    juce::AudioChannelSet::stereo(), true)),
          apvts_(*this, nullptr, "FreqSplitState", createLayout())
    {
        bandCountPtr_         = apvts_.getRawParameterValue("bandCount");
        lowHighPtr_           = apvts_.getRawParameterValue("lowHighFreq");
        lowMidPtr_            = apvts_.getRawParameterValue("lowMidFreq");
        midHighPtr_           = apvts_.getRawParameterValue("midHighFreq");
        lowLowMidPtr_         = apvts_.getRawParameterValue("lowLowMidFreq");
        lowMidHighMidPtr_     = apvts_.getRawParameterValue("lowMidHighMidFreq");
        highMidHighPtr_       = apvts_.getRawParameterValue("highMidHighFreq");

        for (const char* id : { "lowHighFreq", "lowMidFreq", "midHighFreq",
                                "lowLowMidFreq", "lowMidHighMidFreq", "highMidHighFreq" })
            mods_.registerParam(id);
    }

    const juce::String getName() const override { return "FrequencySplitterProcessor"; }
    double getTailLengthSeconds() const override { return 0.0; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    int  getNumPrograms() override { return 1; }
    int  getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& dest) override
    {
        if (auto xml = apvts_.copyState().createXml())
            copyXmlToBinary(*xml, dest);
    }
    void setStateInformation(const void* data, int sizeInBytes) override
    {
        if (auto xml = getXmlFromBinary(data, sizeInBytes))
            apvts_.replaceState(juce::ValueTree::fromXml(*xml));
    }

    void prepareToPlay(double sampleRate, int block) override
    {
        sampleRate_ = sampleRate;
        const juce::dsp::ProcessSpec spec{ sampleRate, static_cast<std::uint32_t>(std::max(0, block)), 2 };
        for (auto& f : lpFilters_) { f.setType(juce::dsp::LinkwitzRileyFilterType::lowpass);  f.prepare(spec); f.reset(); }
        for (auto& f : hpFilters_) { f.setType(juce::dsp::LinkwitzRileyFilterType::highpass); f.prepare(spec); f.reset(); }
        for (auto& f : apFilters_) { f.setType(juce::dsp::LinkwitzRileyFilterType::allpass);  f.prepare(spec); f.reset(); }
    }

    void releaseResources() override {}

    bool isBusesLayoutSupported(const BusesLayout& layouts) const override
    {
        if (layouts.inputBuses.size() != 1 || layouts.outputBuses.size() != kNumOutputBuses)
            return false;
        if (layouts.getChannelSet(true, 0) != juce::AudioChannelSet::stereo())
            return false;
        for (int i = 0; i < kNumOutputBuses; ++i)
            if (layouts.getChannelSet(false, i) != juce::AudioChannelSet::stereo())
                return false;
        return true;
    }

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        juce::ScopedNoDenormals _;
        const int n = buffer.getNumSamples();
        const int bandCount = std::clamp(
            static_cast<int>(std::round(bandCountPtr_ ? bandCountPtr_->load(std::memory_order_relaxed) : 4.0f)),
            2, kMaxBands);

        auto inBus = getBusBuffer(buffer, true, 0);
        std::array<juce::AudioBuffer<float>, kNumOutputBuses> out;
        for (int i = 0; i < kNumOutputBuses; ++i)
        {
            out[i] = getBusBuffer(buffer, false, i);
            out[i].clear();
        }

        // Working copies of the (stereo) input for each filter pass.
        juce::AudioBuffer<float> work(2, n);
        for (int ch = 0; ch < 2; ++ch)
            work.copyFrom(ch, 0, inBus, std::min(ch, inBus.getNumChannels() - 1), 0, n);

        auto processAllpass = [&](int filterIdx, juce::AudioBuffer<float>& target, float fc)
        {
            apFilters_[filterIdx].setCutoffFrequency(fc);
            juce::dsp::AudioBlock<float> block(target);
            juce::dsp::ProcessContextReplacing<float> ctx(block);
            apFilters_[filterIdx].process(ctx);
        };
        auto processLowpass = [&](int filterIdx, juce::AudioBuffer<float>& target, float fc)
        {
            lpFilters_[filterIdx].setCutoffFrequency(fc);
            juce::dsp::AudioBlock<float> block(target);
            juce::dsp::ProcessContextReplacing<float> ctx(block);
            lpFilters_[filterIdx].process(ctx);
        };
        auto processHighpass = [&](int filterIdx, juce::AudioBuffer<float>& target, float fc)
        {
            hpFilters_[filterIdx].setCutoffFrequency(fc);
            juce::dsp::AudioBlock<float> block(target);
            juce::dsp::ProcessContextReplacing<float> ctx(block);
            hpFilters_[filterIdx].process(ctx);
        };

        auto copyToOutBus = [&](const juce::AudioBuffer<float>& src, int busIndex)
        {
            auto& dst = out[busIndex];
            const int channels = std::min(dst.getNumChannels(), src.getNumChannels());
            for (int ch = 0; ch < channels; ++ch)
                dst.copyFrom(ch, 0, src, ch, 0, n);
        };

        if (bandCount == 2)
        {
            const float fc = std::clamp(currentFreq("lowHighFreq", lowHighPtr_, 1000.0f),
                                        20.0f, static_cast<float>(sampleRate_ * 0.5 - 1.0));
            juce::AudioBuffer<float> low(2, n);
            juce::AudioBuffer<float> high(2, n);
            for (int ch = 0; ch < 2; ++ch)
            {
                low .copyFrom(ch, 0, work, ch, 0, n);
                high.copyFrom(ch, 0, work, ch, 0, n);
            }
            processLowpass (0, low,  fc);
            processHighpass(0, high, fc);
            copyToOutBus(low,  kBusLow);
            copyToOutBus(high, kBusHigh);
        }
        else if (bandCount == 3)
        {
            float fL = std::clamp(currentFreq("lowMidFreq",  lowMidPtr_,  300.0f),
                                  20.0f, static_cast<float>(sampleRate_ * 0.5 - 1.0));
            float fH = std::clamp(currentFreq("midHighFreq", midHighPtr_, 3000.0f),
                                  fL + 1.0f, static_cast<float>(sampleRate_ * 0.5 - 1.0));

            juce::AudioBuffer<float> lowMid(2, n);  // will be split into low+mid
            juce::AudioBuffer<float> high  (2, n);
            for (int ch = 0; ch < 2; ++ch)
            {
                lowMid.copyFrom(ch, 0, work, ch, 0, n);
                high  .copyFrom(ch, 0, work, ch, 0, n);
            }
            processLowpass (0, lowMid, fH);
            processHighpass(0, high,   fH);

            juce::AudioBuffer<float> low(2, n);
            juce::AudioBuffer<float> mid(2, n);
            for (int ch = 0; ch < 2; ++ch)
            {
                low.copyFrom(ch, 0, lowMid, ch, 0, n);
                mid.copyFrom(ch, 0, lowMid, ch, 0, n);
            }
            processLowpass (1, low, fL);
            processHighpass(1, mid, fL);

            // High band missed the fL split — apply an allpass at fL so the
            // phase response matches low+mid for clean sum-back.
            processAllpass(0, high, fL);

            copyToOutBus(low,  kBusLow);
            copyToOutBus(mid,  kBusMid);
            copyToOutBus(high, kBusHigh);
        }
        else // bandCount == 4
        {
            float f1 = std::clamp(currentFreq("lowLowMidFreq",     lowLowMidPtr_,      200.0f),
                                  20.0f, static_cast<float>(sampleRate_ * 0.5 - 1.0));
            float f2 = std::clamp(currentFreq("lowMidHighMidFreq", lowMidHighMidPtr_, 1000.0f),
                                  f1 + 1.0f, static_cast<float>(sampleRate_ * 0.5 - 1.0));
            float f3 = std::clamp(currentFreq("highMidHighFreq",   highMidHighPtr_,   5000.0f),
                                  f2 + 1.0f, static_cast<float>(sampleRate_ * 0.5 - 1.0));

            // Cascade: split at f3, then split the LP-of-f3 at f2, then split
            // the LP-of-f2 at f1.  Apply allpass compensation upstream so all
            // four bands stay phase-coherent.
            juce::AudioBuffer<float> belowF3(2, n);
            juce::AudioBuffer<float> high   (2, n);
            for (int ch = 0; ch < 2; ++ch)
            {
                belowF3.copyFrom(ch, 0, work, ch, 0, n);
                high   .copyFrom(ch, 0, work, ch, 0, n);
            }
            processLowpass (0, belowF3, f3);
            processHighpass(0, high,    f3);

            juce::AudioBuffer<float> belowF2(2, n);
            juce::AudioBuffer<float> highMid(2, n);
            for (int ch = 0; ch < 2; ++ch)
            {
                belowF2.copyFrom(ch, 0, belowF3, ch, 0, n);
                highMid.copyFrom(ch, 0, belowF3, ch, 0, n);
            }
            processLowpass (1, belowF2, f2);
            processHighpass(1, highMid, f2);

            juce::AudioBuffer<float> low   (2, n);
            juce::AudioBuffer<float> lowMid(2, n);
            for (int ch = 0; ch < 2; ++ch)
            {
                low   .copyFrom(ch, 0, belowF2, ch, 0, n);
                lowMid.copyFrom(ch, 0, belowF2, ch, 0, n);
            }
            processLowpass (2, low,    f1);
            processHighpass(2, lowMid, f1);

            // Allpass compensation: every band needs an allpass at every split
            // its signal did not pass through, applied at the cutoff freq of
            // the missed split.
            processAllpass(0, highMid, f1);
            processAllpass(1, high,    f1);
            processAllpass(2, high,    f2);

            copyToOutBus(low,     kBusLow);
            copyToOutBus(lowMid,  kBusLowMid);
            copyToOutBus(highMid, kBusHighMid);
            copyToOutBus(high,    kBusHigh);
        }
    }

    bool setRealtimeModulatedParameter(const std::string& paramId, float value) noexcept
    {
        return mods_.set(paramId, value);
    }

    void clearRealtimeModulationOverrides() noexcept { mods_.clearAll(); }

    float getModulationParameterValue(const std::string& paramId) const noexcept
    {
        if (paramId == "lowHighFreq")        return currentFreq(paramId, lowHighPtr_,       1000.0f);
        if (paramId == "lowMidFreq")         return currentFreq(paramId, lowMidPtr_,         300.0f);
        if (paramId == "midHighFreq")        return currentFreq(paramId, midHighPtr_,       3000.0f);
        if (paramId == "lowLowMidFreq")      return currentFreq(paramId, lowLowMidPtr_,      200.0f);
        if (paramId == "lowMidHighMidFreq")  return currentFreq(paramId, lowMidHighMidPtr_, 1000.0f);
        if (paramId == "highMidHighFreq")    return currentFreq(paramId, highMidHighPtr_,   5000.0f);
        if (paramId == "bandCount")
            return bandCountPtr_ ? bandCountPtr_->load(std::memory_order_relaxed) : 4.0f;
        return 0.0f;
    }

    std::string getParametersAsJSON() const
    {
        return detail::parametersAsJsonFromApvts(apvts_, *this);
    }

private:
    static constexpr int kNumOutputBuses = 5;
    enum BusIndex { kBusLow = 0, kBusLowMid = 1, kBusMid = 2, kBusHighMid = 3, kBusHigh = 4 };

    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        juce::AudioProcessorValueTreeState::ParameterLayout layout;
        layout.add(std::make_unique<juce::AudioParameterFloat>(
            juce::ParameterID{ "bandCount", 1 }, "Band Count",
            juce::NormalisableRange<float>{ 2.0f, 4.0f, 1.0f }, 4.0f, ""));
        auto freq = [](const char* id, const char* name, float def)
        {
            return std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ id, 1 }, name,
                juce::NormalisableRange<float>{ 20.0f, 20000.0f, 0.1f, 0.3f }, def, "Hz");
        };
        layout.add(freq("lowHighFreq",        "Low/High Xover",         1000.0f));
        layout.add(freq("lowMidFreq",         "Low/Mid Xover",           300.0f));
        layout.add(freq("midHighFreq",        "Mid/High Xover",         3000.0f));
        layout.add(freq("lowLowMidFreq",      "Low/Low-Mid Xover",       200.0f));
        layout.add(freq("lowMidHighMidFreq",  "Low-Mid/High-Mid Xover", 1000.0f));
        layout.add(freq("highMidHighFreq",    "High-Mid/High Xover",    5000.0f));
        return layout;
    }

    float currentFreq(const std::string& id, std::atomic<float>* ptr, float fallback) const noexcept
    {
        const float base = ptr ? ptr->load(std::memory_order_relaxed) : fallback;
        return mods_.effective(id, base);
    }

    double sampleRate_ = 48000.0;
    juce::AudioProcessorValueTreeState apvts_;
    std::atomic<float>* bandCountPtr_     = nullptr;
    std::atomic<float>* lowHighPtr_       = nullptr;
    std::atomic<float>* lowMidPtr_        = nullptr;
    std::atomic<float>* midHighPtr_       = nullptr;
    std::atomic<float>* lowLowMidPtr_     = nullptr;
    std::atomic<float>* lowMidHighMidPtr_ = nullptr;
    std::atomic<float>* highMidHighPtr_   = nullptr;

    // 3 LP + 3 HP for the 4-band cascade; 3 AP for compensation.
    std::array<juce::dsp::LinkwitzRileyFilter<float>, 3> lpFilters_;
    std::array<juce::dsp::LinkwitzRileyFilter<float>, 3> hpFilters_;
    std::array<juce::dsp::LinkwitzRileyFilter<float>, 3> apFilters_;

    detail::ModulationOverrideMap mods_;
};

}
