#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <complex>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

// ─── XlethParametricEQ ─────────────────────────────────────────────────────
// Fully parametric equaliser with up to 16 bands.  Each band is a biquad
// filter (DFII Transposed) with Bristow-Johnson coefficients.
//
// Band types: Bell, LowShelf, HighShelf, LowPass, HighPass, Notch, Tilt.
// Parameters per band (APVTS-backed):
//   b{i}_freq    20–20 000 Hz  (Multiplicative 30 ms smoothing)
//   b{i}_gain    -30–+30 dB    (Linear 20 ms smoothing)
//   b{i}_q       0.1–30        (Multiplicative 30 ms smoothing)
//   b{i}_type    0–6 discrete  (Bell=0, LowShelf=1, HighShelf=2, LowPass=3,
//                                HighPass=4, Notch=5, Tilt=6)
//   b{i}_enabled 0/1 boolean
//
// Coefficients are recomputed once per audio block from smoothed values.
// 0 bands active by default; add/remove dynamically via addBand()/removeBand().
//
// Provides:
//   getResponseCurve()  — |H(e^jω)| at 512 log-spaced frequencies (main thread)
//   getSpectrumData()   — Hann-windowed 2048-point FFT of recent output (main thread)
//
// pluginId: "xletheq"

class XlethParametricEQ : public XlethEffectBase
{
public:
    // ── Constants ────────────────────────────────────────────────────────────
    static constexpr int kMaxBands     = 16;
    static constexpr int kResponseSize = 512;
    static constexpr int kSTFTOrder    = 12;              // 2^12 = 4096
    static constexpr int kSTFTSize     = 1 << kSTFTOrder;
    static constexpr int kSTFTHop      = kSTFTSize / 2;   // 50% overlap, 2048 latency

    // ── Spectrum Analyzer constants ──────────────────────────────────────
    static constexpr int kSpecFFTOrder = 12;              // 2^12 = 4096
    static constexpr int kSpecFFTSize  = 1 << kSpecFFTOrder;
    static constexpr int kSpecBins     = kSpecFFTSize / 2; // 2048 positive-freq bins
    static constexpr int kSpecHop      = kSpecFFTSize / 2; // 50% overlap (hop = 2048)
    static constexpr int kSpecRingSize = kSpecFFTSize * 4; // 16384-sample ring buffer

    enum class BandType : int {
        Bell = 0, LowShelf = 1, HighShelf = 2,
        LowPass = 3, HighPass = 4, Notch = 5, Tilt = 6
    };

    // ── Construction ─────────────────────────────────────────────────────────
    XlethParametricEQ() : XlethEffectBase("xletheq", createLayout()) {}

    ~XlethParametricEQ() override { stopAnalysisThread(); }

    // ── Serialization (extends base to include bandCount_) ───────────────────

    void getStateInformation(juce::MemoryBlock& dest) override
    {
        auto xml = apvts_.copyState().createXml();
        if (xml)
        {
            xml->setAttribute("bandCount", bandCount_.load(std::memory_order_relaxed));
            copyXmlToBinary(*xml, dest);
        }
    }

    void setStateInformation(const void* data, int sizeInBytes) override
    {
        auto xml = getXmlFromBinary(data, sizeInBytes);
        if (xml && xml->hasTagName(apvts_.state.getType()))
        {
            int count = xml->getIntAttribute("bandCount", -1);
            apvts_.replaceState(juce::ValueTree::fromXml(*xml));

            // Backward compat: old saves lack bandCount attr.
            // Infer by scanning for bands with non-default gain (gain != 0).
            if (count < 0)
            {
                count = 0;
                for (int i = 0; i < kMaxBands; ++i)
                {
                    auto* g = apvts_.getRawParameterValue(paramId(i, "gain"));
                    if (g && std::abs(g->load(std::memory_order_relaxed)) > 0.001f)
                        count = i + 1;
                }
            }

            bandCount_.store(count, std::memory_order_relaxed);
            for (int i = 0; i < count && i < kMaxBands; ++i)
                bands_[i].clearState();
        }
    }

    // ── Band management (main thread only) ───────────────────────────────────

    // Add a new band with default params.  Returns band index or -1 if full.
    int addBand()
    {
        int count = bandCount_.load(std::memory_order_relaxed);
        if (count >= kMaxBands) return -1;

        // Reset APVTS params to defaults for the new band
        setParamDirect(count, "freq",    1000.0f);
        setParamDirect(count, "gain",    0.0f);
        setParamDirect(count, "q",       0.707f);
        setParamDirect(count, "type",    0.0f);
        setParamDirect(count, "enabled", 1.0f);
        setParamDirect(count, "mode",        0.0f);
        setParamDirect(count, "dyn_thresh", -20.0f);
        setParamDirect(count, "dyn_ratio",   4.0f);
        setParamDirect(count, "dyn_attack",  10.0f);
        setParamDirect(count, "dyn_release", 100.0f);
        setParamDirect(count, "spec_sens",    0.5f);
        setParamDirect(count, "spec_depth",   0.0f);
        setParamDirect(count, "spec_sel",     5.0f);
        setParamDirect(count, "spec_attack",  10.0f);
        setParamDirect(count, "spec_release", 100.0f);

        // Clear biquad state for the new band
        bands_[count].clearState();

        bandCount_.store(count + 1, std::memory_order_relaxed);
        return count;
    }

    // Remove band at index.  Swaps with last band, decrements count.
    bool removeBand(int index)
    {
        int count = bandCount_.load(std::memory_order_relaxed);
        if (index < 0 || index >= count) return false;

        int last = count - 1;
        if (index != last)
        {
            // Copy last band's APVTS params to the removed slot
            copyBandParams(last, index);
            bands_[index].clearState();
        }
        bands_[last].clearState();
        bandCount_.store(last, std::memory_order_relaxed);
        return true;
    }

    // Set a single band parameter by name.
    // paramName: "freq", "gain", "q", "type", "enabled"
    bool setBandParam(int bandIndex, const std::string& paramName, float value)
    {
        int count = bandCount_.load(std::memory_order_relaxed);
        if (bandIndex < 0 || bandIndex >= count) return false;
        return setParamDirect(bandIndex, paramName, value);
    }

    int getBandCount() const { return bandCount_.load(std::memory_order_relaxed); }

    // ── Response curve (main thread) ─────────────────────────────────────────
    // Writes 512 magnitude values (dB) at log-spaced frequencies into outBuf.
    // Computes coefficients on the fly from APVTS parameters so the curve
    // always reflects the current UI state even when no audio is flowing.
    void getResponseCurve(float* outBuf, int outSize) const
    {
        const int n       = std::min(outSize, kResponseSize);
        const int count   = bandCount_.load(std::memory_order_relaxed);
        const double sr   = sampleRate_.load(std::memory_order_relaxed);
        const double pi   = juce::MathConstants<double>::pi;
        const double logMin = std::log(20.0);
        const double logMax = std::log(20000.0);

        // Snapshot current APVTS parameters and compute coefficients locally
        // so we don't depend on processEffect having run recently.
        struct LocalCoeffs { double b0, b1, b2, a1, a2; bool enabled; };
        LocalCoeffs lc[kMaxBands]{};

        for (int b = 0; b < count; ++b)
        {
            const auto& bs = bands_[b];
            lc[b].enabled = bs.enabledPtr
                ? (bs.enabledPtr->load(std::memory_order_relaxed) > 0.5f) : true;
            if (!lc[b].enabled) continue;

            float freq   = bs.freqPtr ? bs.freqPtr->load(std::memory_order_relaxed) : 1000.0f;
            float gainDb = bs.gainPtr ? bs.gainPtr->load(std::memory_order_relaxed)  : 0.0f;
            float q      = bs.qPtr    ? bs.qPtr->load(std::memory_order_relaxed)     : 0.707f;
            int   type   = bs.typePtr ? static_cast<int>(bs.typePtr->load(std::memory_order_relaxed)) : 0;
            int   mode   = bs.modePtr ? static_cast<int>(bs.modePtr->load(std::memory_order_relaxed)) : 0;
            freq = std::max(freq, 20.0f);
            q    = std::max(q, 0.1f);

            // Model B: Dynamic bands are visually "off" (0 dB) when inactive,
            // and animate toward target gain as activation grows. Snapshot the
            // activation once per call — audio thread stores atomically.
            if (mode == 1)
            {
                const float act = bs.dynActivation.load(std::memory_order_relaxed);
                gainDb *= act;
            }

            // Compute biquad coefficients (same formulas as computeCoefficients)
            BandState tmp;
            computeCoefficients(tmp, static_cast<BandType>(type), freq, gainDb, q, sr);
            lc[b].b0 = tmp.b0;  lc[b].b1 = tmp.b1;  lc[b].b2 = tmp.b2;
            lc[b].a1 = tmp.a1;  lc[b].a2 = tmp.a2;
        }

        for (int i = 0; i < n; ++i)
        {
            const double t    = static_cast<double>(i) / (n - 1);
            const double freq = std::exp(logMin + t * (logMax - logMin));
            const double w    = 2.0 * pi * freq / sr;
            const double cosw  = std::cos(w);
            const double cos2w = std::cos(2.0 * w);
            const double sinw  = std::sin(w);
            const double sin2w = std::sin(2.0 * w);

            double magSq = 1.0; // combined magnitude-squared (product of all bands)

            for (int b = 0; b < count; ++b)
            {
                if (!lc[b].enabled) continue;

                // H(e^jw) = (b0 + b1*e^-jw + b2*e^-j2w) / (1 + a1*e^-jw + a2*e^-j2w)
                double numRe = lc[b].b0 + lc[b].b1 * cosw + lc[b].b2 * cos2w;
                double numIm =          - lc[b].b1 * sinw - lc[b].b2 * sin2w;
                double denRe = 1.0 + lc[b].a1 * cosw + lc[b].a2 * cos2w;
                double denIm =     - lc[b].a1 * sinw - lc[b].a2 * sin2w;

                double numMagSq = numRe * numRe + numIm * numIm;
                double denMagSq = denRe * denRe + denIm * denIm;

                magSq *= (denMagSq > 1e-30) ? (numMagSq / denMagSq) : 1.0;
            }

            // Convert to dB: 10*log10(magSq) = 20*log10(mag)
            outBuf[i] = static_cast<float>(10.0 * std::log10(std::max(magSq, 1e-30)));
        }
    }

    // ── Spectrum Analyzer (double-buffered output, fed by background thread) ──

    // Read post-EQ smoothed spectrum (kSpecBins dB values). Thread-safe.
    void getPostSpectrum(float* outBuf, int outSize) const
    {
        const int n = std::min(outSize, kSpecBins);
        const int rb = specOutputRead_.load(std::memory_order_acquire);
        std::memcpy(outBuf, specOutput_[rb].post, sizeof(float) * n);
    }

    // Read pre-EQ smoothed spectrum (kSpecBins dB values). Thread-safe.
    void getPreSpectrum(float* outBuf, int outSize) const
    {
        const int n = std::min(outSize, kSpecBins);
        const int rb = specOutputRead_.load(std::memory_order_acquire);
        std::memcpy(outBuf, specOutput_[rb].pre, sizeof(float) * n);
    }

    bool isPreSpectrumEnabled() const
    {
        return specPreEnabled_.load(std::memory_order_relaxed);
    }

    void setPreSpectrumEnabled(bool enabled)
    {
        specPreEnabled_.store(enabled, std::memory_order_relaxed);
    }

    // ── Band info query (main thread, for N-API JSON) ────────────────────────
    std::string getBandsAsJSON() const
    {
        nlohmann::json arr = nlohmann::json::array();
        const int count = bandCount_.load(std::memory_order_relaxed);
        for (int i = 0; i < count; ++i)
        {
            nlohmann::json b;
            b["index"]   = i;
            b["freq"]    = readParam(i, "freq");
            b["gain"]    = readParam(i, "gain");
            b["q"]       = readParam(i, "q");
            b["type"]    = static_cast<int>(readParam(i, "type"));
            b["enabled"] = readParam(i, "enabled") > 0.5f;
            b["mode"]        = static_cast<int>(readParam(i, "mode"));
            b["dyn_thresh"]  = readParam(i, "dyn_thresh");
            b["dyn_ratio"]   = readParam(i, "dyn_ratio");
            b["dyn_attack"]  = readParam(i, "dyn_attack");
            b["dyn_release"] = readParam(i, "dyn_release");
            b["spec_sens"]    = readParam(i, "spec_sens");
            b["spec_depth"]   = readParam(i, "spec_depth");
            b["spec_sel"]     = readParam(i, "spec_sel");
            b["spec_attack"]  = readParam(i, "spec_attack");
            b["spec_release"] = readParam(i, "spec_release");
            arr.push_back(std::move(b));
        }
        return arr.dump();
    }

    // ── Per-band gain reduction metering (main thread reads) ────────────────
    float getBandGR(int bandIndex) const
    {
        if (bandIndex >= 0 && bandIndex < kMaxBands)
            return bandGR_[bandIndex].load(std::memory_order_relaxed);
        return 0.0f;
    }

    // ── Sample rate query (main thread) ────────────────────────────────────
    double getSampleRate() const { return sampleRate_.load(std::memory_order_relaxed); }

    // ── Latency query ────────────────────────────────────────────────────────
    int getLatencySamples() const
    {
        int lat = 0;
        if (hasSpectralBands_) lat += kSTFTHop;
        if (linPhaseActive_) lat += firLength_ / 2;
        if (currentOSFactor_ > 0)
        {
            auto* os = (currentOSFactor_ == 1) ? os2x_.get() : os4x_.get();
            if (os) lat += static_cast<int>(std::ceil(os->getLatencyInSamples()));
        }
        return lat;
    }

    // ── Global params query (main thread, for N-API JSON) ────────────────────
    std::string getGlobalParamsAsJSON() const
    {
        nlohmann::json obj;
        obj["linphase"]   = linPhasePtr_
            ? (linPhasePtr_->load(std::memory_order_relaxed) > 0.5f) : false;
        obj["oversample"] = oversamplePtr_
            ? static_cast<int>(oversamplePtr_->load(std::memory_order_relaxed)) : 0;
        return obj.dump();
    }

    // ── XlethEffectBase overrides ────────────────────────────────────────────

    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_.store(sampleRate, std::memory_order_relaxed);

        // Resolve APVTS raw param pointers
        for (int i = 0; i < kMaxBands; ++i)
        {
            auto& bs = bands_[i];
            bs.freqPtr    = apvts_.getRawParameterValue(paramId(i, "freq"));
            bs.gainPtr    = apvts_.getRawParameterValue(paramId(i, "gain"));
            bs.qPtr       = apvts_.getRawParameterValue(paramId(i, "q"));
            bs.typePtr    = apvts_.getRawParameterValue(paramId(i, "type"));
            bs.enabledPtr = apvts_.getRawParameterValue(paramId(i, "enabled"));

            // Advanced mode pointers
            bs.modePtr       = apvts_.getRawParameterValue(paramId(i, "mode"));
            bs.dynThreshPtr  = apvts_.getRawParameterValue(paramId(i, "dyn_thresh"));
            bs.dynRatioPtr   = apvts_.getRawParameterValue(paramId(i, "dyn_ratio"));
            bs.dynAttackPtr  = apvts_.getRawParameterValue(paramId(i, "dyn_attack"));
            bs.dynReleasePtr = apvts_.getRawParameterValue(paramId(i, "dyn_release"));
            bs.specSensPtr    = apvts_.getRawParameterValue(paramId(i, "spec_sens"));
            bs.specDepthPtr   = apvts_.getRawParameterValue(paramId(i, "spec_depth"));
            bs.specSelPtr     = apvts_.getRawParameterValue(paramId(i, "spec_sel"));
            bs.specAttackPtr  = apvts_.getRawParameterValue(paramId(i, "spec_attack"));
            bs.specReleasePtr = apvts_.getRawParameterValue(paramId(i, "spec_release"));

            // Per-bin spectral envelope buffer (audio-thread read/write; sized once here)
            bs.specBinEnv.assign(kSTFTSize / 2, 1.0f);

            // Initialise smoothers
            float f = bs.freqPtr ? bs.freqPtr->load(std::memory_order_relaxed) : 1000.0f;
            float g = bs.gainPtr ? bs.gainPtr->load(std::memory_order_relaxed) : 0.0f;
            float q = bs.qPtr    ? bs.qPtr->load(std::memory_order_relaxed)    : 0.707f;

            bs.freqSmooth.reset(sampleRate, 0.030);
            bs.freqSmooth.setCurrentAndTargetValue(std::max(f, 1e-6f));
            bs.gainSmooth.reset(sampleRate, 0.020);
            bs.gainSmooth.setCurrentAndTargetValue(g);
            bs.qSmooth.reset(sampleRate, 0.030);
            bs.qSmooth.setCurrentAndTargetValue(std::max(q, 1e-6f));

            bs.clearState();
        }

        // Resolve global mode pointers
        linPhasePtr_   = apvts_.getRawParameterValue("linphase");
        oversamplePtr_ = apvts_.getRawParameterValue("oversample");

        // Initialise oversamplers (pre-create both for glitch-free switching)
        os2x_ = std::make_unique<juce::dsp::Oversampling<float>>(
            2, 1, juce::dsp::Oversampling<float>::filterHalfBandPolyphaseIIR, true, true);
        os2x_->initProcessing(static_cast<size_t>(maxBlockSize));

        os4x_ = std::make_unique<juce::dsp::Oversampling<float>>(
            2, 2, juce::dsp::Oversampling<float>::filterHalfBandPolyphaseIIR, true, true);
        os4x_->initProcessing(static_cast<size_t>(maxBlockSize));

        // Initialise STFT buffers
        preparedBlockSize_ = maxBlockSize;
        for (int ch = 0; ch < 2; ++ch)
        {
            stftInRing_[ch].assign(kSTFTSize * 2, 0.0f);
            stftOutRing_[ch].assign(kSTFTSize * 2, 0.0f);
        }
        stftWritePos_ = 0;
        stftSinceLastFrame_ = 0;

        // Precompute Hann window for STFT
        {
            const float piF = juce::MathConstants<float>::pi;
            for (int i = 0; i < kSTFTSize; ++i)
                stftWindow_[i] = 0.5f * (1.0f - std::cos(2.0f * piF
                    * static_cast<float>(i) / static_cast<float>(kSTFTSize - 1)));
        }

        // Linear phase FIR
        firLength_ = (sampleRate > 48000.0) ? 8192 : 4096;
        firCoeffs_.assign(firLength_, 0.0f);
        firDirty_ = true;
        for (int ch = 0; ch < 2; ++ch)
            firDelay_[ch].assign(firLength_, 0.0f);
        firDelayPos_ = 0;
        firBuildRe_.resize(firLength_);
        firBuildIm_.resize(firLength_);
        firBuildShift_.resize(firLength_);

        // STFT scratch buffers
        stftTempRe_.resize(kSTFTSize, 0.0f);
        stftTempIm_.resize(kSTFTSize, 0.0f);
        stftMag_.resize(kSTFTSize / 2, 0.0f);
        stftLogMag_.resize(kSTFTSize / 2, 0.0f);

        // ── Spectrum Analyzer initialisation ────────────────────────────────
        stopAnalysisThread(); // stop any existing thread from previous prepare

        // Precompute Hann window for spectrum FFT
        {
            const float piF = juce::MathConstants<float>::pi;
            for (int i = 0; i < kSpecFFTSize; ++i)
                specWindow_[i] = 0.5f * (1.0f - std::cos(2.0f * piF
                    * static_cast<float>(i) / static_cast<float>(kSpecFFTSize - 1)));
        }

        // Normalization: 20*log10(N/4) for Hann-windowed FFT → 0 dBFS calibration
        specNormDb_ = 20.0f * std::log10(static_cast<float>(kSpecFFTSize) / 4.0f);

        // Decay coefficient: ~300ms time constant
        {
            const float framesPerSec = static_cast<float>(sampleRate) / static_cast<float>(kSpecHop);
            specDecayCoeff_ = 1.0f - std::exp(-1.0f / (0.3f * framesPerSec));
        }

        // Create FFT instance
        specFFT_ = std::make_unique<juce::dsp::FFT>(kSpecFFTOrder);

        // Reset ring buffers and analysis state
        std::memset(specPostRing_, 0, sizeof(specPostRing_));
        std::memset(specPreRing_,  0, sizeof(specPreRing_));
        specPostWriteIdx_.store(0, std::memory_order_relaxed);
        specPreWriteIdx_.store(0, std::memory_order_relaxed);
        specPostAnalysisPos_ = 0;
        specPreAnalysisPos_  = 0;
        std::fill(std::begin(specPostSmoothed_), std::end(specPostSmoothed_), -200.0f);
        std::fill(std::begin(specPreSmoothed_),  std::end(specPreSmoothed_),  -200.0f);
        for (auto& out : specOutput_)
        {
            std::fill(std::begin(out.post), std::end(out.post), -200.0f);
            std::fill(std::begin(out.pre),  std::end(out.pre),  -200.0f);
        }
        specOutputRead_.store(0, std::memory_order_relaxed);

        // Start background analysis thread
        specThreadRunning_.store(true, std::memory_order_relaxed);
        specThread_ = std::thread([this] { analysisThreadFunc(); });

        // Reset latency
        setLatencySamples(0);
    }

    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = std::min(buffer.getNumChannels(), 2);
        const int count      = bandCount_.load(std::memory_order_relaxed);
        const double sr      = sampleRate_.load(std::memory_order_relaxed);

        // ── Read band modes + enabled state ─────────────────────────────────
        bool hasDynamic = false;
        for (int b = 0; b < count; ++b)
        {
            auto& bs = bands_[b];
            bs.mode    = bs.modePtr    ? static_cast<int>(bs.modePtr->load(std::memory_order_relaxed)) : 0;
            bs.enabled = bs.enabledPtr ? (bs.enabledPtr->load(std::memory_order_relaxed) > 0.5f) : true;
            if (bs.mode == 1 && bs.enabled) hasDynamic = true;
        }

        // ── Read global mode state ──────────────────────────────────────────
        linPhaseActive_ = linPhasePtr_
            ? (linPhasePtr_->load(std::memory_order_relaxed) > 0.5f) : false;

        // Read oversample factor (0=off, 1=2x, 2=4x)
        int osRaw = oversamplePtr_
            ? static_cast<int>(oversamplePtr_->load(std::memory_order_relaxed)) : 0;

        // Spectral + OS mutually exclusive: spectral wins, OS bypassed
        bool anySpectral = false;
        if (!linPhaseActive_)
        {
            for (int b = 0; b < count; ++b)
                if (bands_[b].mode == 2 && bands_[b].enabled) { anySpectral = true; break; }
        }
        currentOSFactor_ = anySpectral ? 0 : osRaw;

        // Effective sample rate for coefficient computation
        const double effectiveSR = sr * static_cast<double>(1 << currentOSFactor_);

        // ── Dynamic EQ sidechain analysis (Model B, FabFilter-style) ────────
        // Skipped when linPhase is active (all bands treated as Normal).
        // Detector: dedicated constant-skirt BPF (independent of band gain).
        // Output: activation in [0,1]; 0 = band off, 1 = at user target gain.
        if (!linPhaseActive_ && hasDynamic)
        {
            for (int b = 0; b < count; ++b)
            {
                auto& bs = bands_[b];
                if (bs.mode != 1 || !bs.enabled)
                {
                    bs.dynActivation.store(0.0f, std::memory_order_relaxed);
                    bandGR_[b].store(0.0f, std::memory_order_relaxed);
                    continue;
                }

                // Attack/release coefficients from APVTS
                float attackMs  = bs.dynAttackPtr  ? bs.dynAttackPtr->load(std::memory_order_relaxed)  : 10.0f;
                float releaseMs = bs.dynReleasePtr ? bs.dynReleasePtr->load(std::memory_order_relaxed) : 100.0f;
                bs.dynAttackCoeff  = 1.0f - std::exp(-1.0f / (attackMs  * 0.001f * static_cast<float>(sr)));
                bs.dynReleaseCoeff = 1.0f - std::exp(-1.0f / (releaseMs * 0.001f * static_cast<float>(sr)));

                float thresh = bs.dynThreshPtr ? bs.dynThreshPtr->load(std::memory_order_relaxed) : -20.0f;
                float ratio  = bs.dynRatioPtr  ? bs.dynRatioPtr->load(std::memory_order_relaxed)  : 4.0f;
                ratio = std::max(ratio, 1.0f);

                // Recompute sidechain BPF from end-of-block smoothed freq/Q
                // (read before skip() advances — using current value is fine
                // since block-to-block drift is small and smoothers advance
                // again in the main coeff loop below).
                float scFreq = std::max(bs.freqSmooth.getCurrentValue(), 20.0f);
                float scQ    = std::max(bs.qSmooth.getCurrentValue(), 0.1f);
                computeSidechainBPF(bs, scFreq, scQ, sr);

                // Run sidechain BPF on input, compute RMS of detector output.
                double sumSq = 0.0;
                for (int ch = 0; ch < numCh; ++ch)
                {
                    const float* data = buffer.getReadPointer(ch);
                    for (int s = 0; s < numSamples; ++s)
                    {
                        float x = data[s];
                        float y  = bs.sc_b0 * x + bs.sc_z1[ch];
                        bs.sc_z1[ch] = bs.sc_b1 * x - bs.sc_a1 * y + bs.sc_z2[ch];
                        bs.sc_z2[ch] = bs.sc_b2 * x - bs.sc_a2 * y;
                        sumSq += static_cast<double>(y * y);
                    }
                }

                float rmsDb = 10.0f * std::log10(std::max(
                    static_cast<float>(sumSq / (numSamples * numCh)), 1e-30f));

                // Map overshoot → activation target in [0,1].
                // 0 dB over → 0; grows asymptotically toward 1 with more overshoot.
                // Ratio controls curve steepness (higher ratio = steeper).
                float overshoot = std::max(0.0f, rmsDb - thresh);
                float k = (1.0f - 1.0f / ratio) * 0.23f; // 0.23 ≈ 1/ln(10) scaling
                float activationTarget = 1.0f - std::exp(-overshoot * k);
                if (activationTarget < 0.0f) activationTarget = 0.0f;
                if (activationTarget > 1.0f) activationTarget = 1.0f;

                // One-pole attack/release on activation (attack = growing toward 1).
                float cur = bs.dynActivation.load(std::memory_order_relaxed);
                float coeff = (activationTarget > cur) ? bs.dynAttackCoeff : bs.dynReleaseCoeff;
                float newAct = coeff * activationTarget + (1.0f - coeff) * cur;
                bs.dynActivation.store(newAct, std::memory_order_relaxed);

                // Meter: signed dB the band is currently contributing.
                float targetGainDb = bs.gainPtr ? bs.gainPtr->load(std::memory_order_relaxed) : 0.0f;
                bandGR_[b].store(newAct * targetGainDb, std::memory_order_relaxed);

#ifdef XLETH_DEBUG
                bs.dynLogCounter += numSamples;
                if (bs.dynLogCounter >= static_cast<int>(sr))
                {
                    bs.dynLogCounter = 0;
                    std::fprintf(stderr, "[EQ-Dyn] band=%d act=%.3f rms=%.1fdB thr=%.1fdB\n",
                                 b, newAct, rmsDb, thresh);
                }
#endif
            }
        }
        else
        {
            for (int b = 0; b < count; ++b)
            {
                bands_[b].dynActivation.store(0.0f, std::memory_order_relaxed);
                bandGR_[b].store(0.0f, std::memory_order_relaxed);
            }
        }

        // ── Update smoother targets + recompute coefficients once per block ──
        for (int b = 0; b < count; ++b)
        {
            auto& bs = bands_[b];

            // Read APVTS atomics
            float freq    = bs.freqPtr ? bs.freqPtr->load(std::memory_order_relaxed) : 1000.0f;
            float gainDb  = bs.gainPtr ? bs.gainPtr->load(std::memory_order_relaxed) : 0.0f;
            float q       = bs.qPtr    ? bs.qPtr->load(std::memory_order_relaxed)    : 0.707f;
            int   type    = bs.typePtr ? static_cast<int>(bs.typePtr->load(std::memory_order_relaxed)) : 0;

            // Advance smoothers to end-of-block position
            bs.freqSmooth.setTargetValue(std::max(freq, 20.0f));
            bs.gainSmooth.setTargetValue(gainDb);
            bs.qSmooth.setTargetValue(std::max(q, 0.1f));

            float smoothFreq = bs.freqSmooth.skip(numSamples);
            float smoothGain = bs.gainSmooth.skip(numSamples);
            float smoothQ    = bs.qSmooth.skip(numSamples);

            // Apply Dynamic EQ activation (Model B): band is off at 0 dB
            // when untriggered, moves toward user target gain as activation → 1.
            if (bs.mode == 1)
                smoothGain = bs.dynActivation.load(std::memory_order_relaxed) * smoothGain;

            if (bs.enabled)
                computeCoefficients(bs, static_cast<BandType>(type),
                                    smoothFreq, smoothGain, smoothQ, effectiveSR);
        }

        // ── Pre-EQ spectrum tap (before any filtering) ───────────────────────
        if (specPreEnabled_.load(std::memory_order_relaxed))
        {
            const float* L = buffer.getReadPointer(0);
            const float* R = numCh > 1 ? buffer.getReadPointer(1) : L;
            int wi = specPreWriteIdx_.load(std::memory_order_relaxed);
            for (int s = 0; s < numSamples; ++s)
            {
                specPreRing_[wi & (kSpecRingSize - 1)] = (L[s] + R[s]) * 0.5f;
                ++wi;
            }
            specPreWriteIdx_.store(wi, std::memory_order_release);
        }

        // ── STFT Spectral Dynamics (skipped when linPhase) ────────────────────
        if (!linPhaseActive_)
        {
            hasSpectralBands_ = false;
            for (int b = 0; b < count; ++b)
            {
                if (bands_[b].mode == 2 && bands_[b].enabled)
                {
                    hasSpectralBands_ = true;
                    break;
                }
            }

            // Auto-enable pre-EQ spectrum when any Spectral band is active.
            // Do NOT auto-disable; user may want pre-spectrum with other modes too.
            if (hasSpectralBands_ && !specPreEnabled_.load(std::memory_order_relaxed))
                specPreEnabled_.store(true, std::memory_order_release);

            if (hasSpectralBands_)
            {
                const int ringSize = kSTFTSize * 2;
                for (int s = 0; s < numSamples; ++s)
                {
                    int wp = stftWritePos_ % ringSize;
                    for (int ch = 0; ch < numCh; ++ch)
                        stftInRing_[ch][wp] = buffer.getSample(ch, s);

                    stftWritePos_++;
                    stftSinceLastFrame_++;

                    if (stftSinceLastFrame_ >= kSTFTHop)
                    {
                        stftSinceLastFrame_ = 0;
                        processSTFTFrame(numCh, sr);
                    }

                    int rp = ((stftWritePos_ - kSTFTHop) % ringSize + ringSize) % ringSize;
                    for (int ch = 0; ch < numCh; ++ch)
                    {
                        buffer.setSample(ch, s, stftOutRing_[ch][rp]);
                        stftOutRing_[ch][rp] = 0.0f;
                    }
                }
            }
        }
        else
        {
            hasSpectralBands_ = false; // linPhase disables spectral
        }

        // Update reported latency
        {
            int newLat = getLatencySamples();
            if (newLat != AudioProcessor::getLatencySamples())
                setLatencySamples(newLat);
        }

        // ── Processing path ─────────────────────────────────────────────────

        if (linPhaseActive_)
        {
            // ── Linear Phase FIR convolution (replaces biquad cascade) ──────
            if (firDirty_)
                rebuildFIR();

            if (currentOSFactor_ > 0)
            {
                // Oversampled FIR: upsample → FIR → downsample
                auto* os = (currentOSFactor_ == 1) ? os2x_.get() : os4x_.get();
                juce::dsp::AudioBlock<float> block(buffer);
                auto upBlock = os->processSamplesUp(block);

                const int upN = static_cast<int>(upBlock.getNumSamples());
                for (int s = 0; s < upN; ++s)
                {
                    int wp = firDelayPos_ % firLength_;
                    for (int ch = 0; ch < numCh; ++ch)
                    {
                        float* data = upBlock.getChannelPointer(ch);
                        firDelay_[ch][wp] = data[s];

                        float sum = 0.0f;
                        int rp = wp;
                        for (int i = 0; i < firLength_; ++i)
                        {
                            sum += firCoeffs_[i] * firDelay_[ch][rp];
                            if (--rp < 0) rp += firLength_;
                        }
                        data[s] = sum;
                    }
                    firDelayPos_++;
                }

                os->processSamplesDown(block);
            }
            else
            {
                // FIR convolution at native rate
                for (int s = 0; s < numSamples; ++s)
                {
                    int wp = firDelayPos_ % firLength_;
                    for (int ch = 0; ch < numCh; ++ch)
                    {
                        float* data = buffer.getWritePointer(ch);
                        firDelay_[ch][wp] = data[s];

                        float sum = 0.0f;
                        int rp = wp;
                        for (int i = 0; i < firLength_; ++i)
                        {
                            sum += firCoeffs_[i] * firDelay_[ch][rp];
                            if (--rp < 0) rp += firLength_;
                        }
                        data[s] = sum;
                    }
                    firDelayPos_++;
                }
            }
        }
        else if (currentOSFactor_ > 0)
        {
            // ── Oversampled biquad: upsample → cascade → downsample ─────────
            auto* os = (currentOSFactor_ == 1) ? os2x_.get() : os4x_.get();
            juce::dsp::AudioBlock<float> block(buffer);
            auto upBlock = os->processSamplesUp(block);

            const int upN = static_cast<int>(upBlock.getNumSamples());
            for (int ch = 0; ch < numCh; ++ch)
            {
                float* data = upBlock.getChannelPointer(ch);
                for (int s = 0; s < upN; ++s)
                {
                    float x = data[s];
                    for (int b = 0; b < count; ++b)
                    {
                        auto& bs = bands_[b];
                        if (!bs.enabled || bs.mode == 2) continue;

                        float y  = bs.b0 * x + bs.z1[ch];
                        bs.z1[ch] = bs.b1 * x - bs.a1 * y + bs.z2[ch];
                        bs.z2[ch] = bs.b2 * x - bs.a2 * y;
                        x = y;
                    }
                    data[s] = x;
                }
            }

            os->processSamplesDown(block);
        }
        else
        {
            // ── Biquad processing (DFII Transposed) ─────────────────────────
            // Spectral-mode bands skip biquad — processed by STFT above.
            for (int ch = 0; ch < numCh; ++ch)
            {
                float* data = buffer.getWritePointer(ch);

                for (int s = 0; s < numSamples; ++s)
                {
                    float x = data[s];

                    for (int b = 0; b < count; ++b)
                    {
                        auto& bs = bands_[b];
                        if (!bs.enabled || bs.mode == 2) continue;

                        float y  = bs.b0 * x + bs.z1[ch];
                        bs.z1[ch] = bs.b1 * x - bs.a1 * y + bs.z2[ch];
                        bs.z2[ch] = bs.b2 * x - bs.a2 * y;
                        x = y;
                    }

                    data[s] = x;
                }
            }
        }

        // ── Post-EQ spectrum tap (after all filtering) ──────────────────────
        {
            const float* L = buffer.getReadPointer(0);
            const float* R = numCh > 1 ? buffer.getReadPointer(1) : L;
            int wi = specPostWriteIdx_.load(std::memory_order_relaxed);
            for (int s = 0; s < numSamples; ++s)
            {
                specPostRing_[wi & (kSpecRingSize - 1)] = (L[s] + R[s]) * 0.5f;
                ++wi;
            }
            specPostWriteIdx_.store(wi, std::memory_order_release);
        }

        // ── Metering (output peaks) ─────────────────────────────────────────
        writeMeterValue(0, buffer.getMagnitude(0, 0, numSamples));
        if (numCh > 1)
            writeMeterValue(1, buffer.getMagnitude(1, 0, numSamples));
    }

    void releaseEffect() override
    {
        stopAnalysisThread();
        for (int i = 0; i < kMaxBands; ++i)
            bands_[i].clearState();
    }

    void resetEffect() override
    {
        for (int i = 0; i < kMaxBands; ++i)
            bands_[i].clearState();
    }

private:
    // ── Per-band state ───────────────────────────────────────────────────────
    struct BandState
    {
        // APVTS raw pointers (resolved in prepareEffect)
        std::atomic<float>* freqPtr    = nullptr;
        std::atomic<float>* gainPtr    = nullptr;
        std::atomic<float>* qPtr       = nullptr;
        std::atomic<float>* typePtr    = nullptr;
        std::atomic<float>* enabledPtr = nullptr;

        // Smoothers (audio thread only)
        juce::SmoothedValue<float, juce::ValueSmoothingTypes::Multiplicative> freqSmooth;
        juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>         gainSmooth;
        juce::SmoothedValue<float, juce::ValueSmoothingTypes::Multiplicative> qSmooth;

        // Current biquad coefficients (normalised: a0 = 1)
        float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f;
        float a1 = 0.0f, a2 = 0.0f;

        // DFII Transposed state per channel (stereo max)
        float z1[2]{}, z2[2]{};

        bool enabled = true;

        // ── Mode (0=Normal, 1=Dynamic, 2=Spectral) ─────────────────────────
        std::atomic<float>* modePtr = nullptr;
        int mode = 0;

        // ── Dynamic EQ APVTS pointers ───────────────────────────────────────
        std::atomic<float>* dynThreshPtr  = nullptr;
        std::atomic<float>* dynRatioPtr   = nullptr;
        std::atomic<float>* dynAttackPtr  = nullptr;
        std::atomic<float>* dynReleasePtr = nullptr;

        // Dedicated sidechain BPF coefficients (constant-skirt, peak 0 dB).
        // Recomputed once per block from smoothed freq/Q; independent of band gain.
        float sc_b0 = 1.0f, sc_b1 = 0.0f, sc_b2 = 0.0f;
        float sc_a1 = 0.0f, sc_a2 = 0.0f;

        // Dynamic EQ runtime state (audio thread)
        float sc_z1[2]{}, sc_z2[2]{};   // sidechain bandpass DFII state
        std::atomic<float> dynActivation{0.0f}; // activation [0,1]: 0 = band off, 1 = at target
        float dynAttackCoeff = 0.0f;     // one-pole attack coefficient
        float dynReleaseCoeff = 0.0f;    // one-pole release coefficient
#ifdef XLETH_DEBUG
        int dynLogCounter = 0;
        int specLogCounter = 0;
#endif

        // ── Spectral Dynamics APVTS pointers ────────────────────────────────
        std::atomic<float>* specSensPtr    = nullptr;
        std::atomic<float>* specDepthPtr   = nullptr;
        std::atomic<float>* specSelPtr     = nullptr;
        std::atomic<float>* specAttackPtr  = nullptr;
        std::atomic<float>* specReleasePtr = nullptr;

        // Per-bin spectral reduction envelope, smoothed across STFT frames.
        // Value in [0, 1+]: 1 = no change, <1 = attenuation toward depthLin,
        // >1 = boost (upward spectral). Sized kSTFTSize/2 in prepareEffect.
        std::vector<float> specBinEnv;

        void clearState()
        {
            z1[0] = z1[1] = 0.0f;
            z2[0] = z2[1] = 0.0f;
            sc_z1[0] = sc_z1[1] = 0.0f;
            sc_z2[0] = sc_z2[1] = 0.0f;
            dynActivation.store(0.0f, std::memory_order_relaxed);
            std::fill(specBinEnv.begin(), specBinEnv.end(), 1.0f);
        }
    };

    BandState bands_[kMaxBands]{};
    std::atomic<int> bandCount_{0};
    std::atomic<double> sampleRate_{44100.0};

    // ── Spectrum Analyzer ────────────────────────────────────────────────
    // SPSC ring buffers (audio thread writes, analysis thread reads)
    float specPostRing_[kSpecRingSize]{};
    float specPreRing_[kSpecRingSize]{};
    std::atomic<int> specPostWriteIdx_{0};
    std::atomic<int> specPreWriteIdx_{0};

    // Pre-EQ display toggle (set from N-API, read by audio + analysis)
    std::atomic<bool> specPreEnabled_{false};

    // Background analysis thread
    std::unique_ptr<juce::dsp::FFT> specFFT_;
    std::thread specThread_;
    std::atomic<bool> specThreadRunning_{false};
    float specWindow_[kSpecFFTSize]{};
    float specNormDb_ = 0.0f;
    float specDecayCoeff_ = 0.1f;

    // Analysis thread internal state (only touched by analysis thread)
    float specPostSmoothed_[kSpecBins]{};
    float specPreSmoothed_[kSpecBins]{};
    int specPostAnalysisPos_ = 0;
    int specPreAnalysisPos_  = 0;

    // Double-buffered output (analysis thread writes, N-API reads)
    struct SpectrumOutput { float post[kSpecBins]{}; float pre[kSpecBins]{}; };
    SpectrumOutput specOutput_[2];
    std::atomic<int> specOutputRead_{0};

    // ── Per-band gain reduction metering (audio→main) ───────────────────────
    std::atomic<float> bandGR_[kMaxBands]{};

    // ── Global mode pointers ────────────────────────────────────────────────
    std::atomic<float>* linPhasePtr_   = nullptr;
    std::atomic<float>* oversamplePtr_ = nullptr;
    bool linPhaseActive_ = false;
    int  currentOSFactor_ = 0;  // 0=off, 1=2x, 2=4x

    // ── STFT state (Spectral Dynamics) ──────────────────────────────────────
    std::vector<float> stftInRing_[2];
    std::vector<float> stftOutRing_[2];
    int stftWritePos_ = 0;
    int stftSinceLastFrame_ = 0;
    float stftWindow_[kSTFTSize]{};
    bool hasSpectralBands_ = false;
    int  preparedBlockSize_ = 512;

    // ── Linear Phase (direct FIR convolution) ───────────────────────────────
    int firLength_ = 4096;
    std::vector<float> firCoeffs_;      // FIR taps
    bool firDirty_ = true;
    std::vector<float> firDelay_[2];    // Per-channel circular delay line
    int firDelayPos_ = 0;
    std::vector<float> firBuildRe_;     // Scratch for rebuildFIR (avoid audio-thread alloc)
    std::vector<float> firBuildIm_;
    std::vector<float> firBuildShift_;

    // ── Oversampling ────────────────────────────────────────────────────────
    std::unique_ptr<juce::dsp::Oversampling<float>> os2x_;
    std::unique_ptr<juce::dsp::Oversampling<float>> os4x_;

    // ── STFT scratch buffers (audio thread only, avoid per-frame allocation) ─
    std::vector<float> stftTempRe_;
    std::vector<float> stftTempIm_;
    std::vector<float> stftMag_;      // per-bin magnitude (positive freqs, size kSTFTSize/2)
    std::vector<float> stftLogMag_;   // per-bin log magnitude for local-env rolling sum

    // ── Sidechain BPF (constant-skirt-gain, peak 0 dB) ──────────────────────
    // Bristow-Johnson "BPF (constant 0 dB peak gain)" form. Independent of
    // band gain — used as the Dynamic-EQ detector so its selectivity does
    // not collapse when the band sits near 0 dB target.
    static void computeSidechainBPF(BandState& bs, float freq, float Q, double sr)
    {
        const double pi   = juce::MathConstants<double>::pi;
        const double w0   = 2.0 * pi * static_cast<double>(freq) / sr;
        const double cosw = std::cos(w0);
        const double sinw = std::sin(w0);
        const double alpha = sinw / (2.0 * std::max(static_cast<double>(Q), 1e-6));

        const double a0 = 1.0 + alpha;
        const double inv = 1.0 / a0;
        bs.sc_b0 = static_cast<float>( alpha * inv);
        bs.sc_b1 = 0.0f;
        bs.sc_b2 = static_cast<float>(-alpha * inv);
        bs.sc_a1 = static_cast<float>(-2.0 * cosw * inv);
        bs.sc_a2 = static_cast<float>((1.0 - alpha) * inv);
    }

    // ── Bristow-Johnson coefficient computation ─────────────────────────────

    static void computeCoefficients(BandState& bs, BandType type,
                                     float freq, float gainDb, float Q, double sr)
    {
        const double pi   = juce::MathConstants<double>::pi;
        const double w0   = 2.0 * pi * static_cast<double>(freq) / sr;
        const double cosw = std::cos(w0);
        const double sinw = std::sin(w0);
        const double alpha = sinw / (2.0 * static_cast<double>(Q));
        const double A    = std::pow(10.0, static_cast<double>(gainDb) / 40.0);
        const double sqrtA = std::sqrt(A);

        double b0, b1, b2, a0, a1, a2;

        switch (type)
        {
        case BandType::Bell:
            b0 =  1.0 + alpha * A;
            b1 = -2.0 * cosw;
            b2 =  1.0 - alpha * A;
            a0 =  1.0 + alpha / A;
            a1 = -2.0 * cosw;
            a2 =  1.0 - alpha / A;
            break;

        case BandType::LowShelf:
        {
            double twoSqrtAAlpha = 2.0 * sqrtA * alpha;
            b0 =      A * ((A + 1.0) - (A - 1.0) * cosw + twoSqrtAAlpha);
            b1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cosw);
            b2 =      A * ((A + 1.0) - (A - 1.0) * cosw - twoSqrtAAlpha);
            a0 =            (A + 1.0) + (A - 1.0) * cosw + twoSqrtAAlpha;
            a1 =     -2.0 * ((A - 1.0) + (A + 1.0) * cosw);
            a2 =            (A + 1.0) + (A - 1.0) * cosw - twoSqrtAAlpha;
            break;
        }

        case BandType::HighShelf:
        {
            double twoSqrtAAlpha = 2.0 * sqrtA * alpha;
            b0 =      A * ((A + 1.0) + (A - 1.0) * cosw + twoSqrtAAlpha);
            b1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cosw);
            b2 =      A * ((A + 1.0) + (A - 1.0) * cosw - twoSqrtAAlpha);
            a0 =            (A + 1.0) - (A - 1.0) * cosw + twoSqrtAAlpha;
            a1 =      2.0 * ((A - 1.0) - (A + 1.0) * cosw);
            a2 =            (A + 1.0) - (A - 1.0) * cosw - twoSqrtAAlpha;
            break;
        }

        case BandType::LowPass:
            b0 = (1.0 - cosw) / 2.0;
            b1 =  1.0 - cosw;
            b2 = (1.0 - cosw) / 2.0;
            a0 =  1.0 + alpha;
            a1 = -2.0 * cosw;
            a2 =  1.0 - alpha;
            break;

        case BandType::HighPass:
            b0 =  (1.0 + cosw) / 2.0;
            b1 = -(1.0 + cosw);
            b2 =  (1.0 + cosw) / 2.0;
            a0 =   1.0 + alpha;
            a1 =  -2.0 * cosw;
            a2 =   1.0 - alpha;
            break;

        case BandType::Notch:
            b0 =  1.0;
            b1 = -2.0 * cosw;
            b2 =  1.0;
            a0 =  1.0 + alpha;
            a1 = -2.0 * cosw;
            a2 =  1.0 - alpha;
            break;

        case BandType::Tilt:
        {
            // Tilt = LowShelf with a gentle slope (ignores Q, uses fixed 0.5).
            double tiltQ   = 0.5;
            double tiltAlpha = sinw / (2.0 * tiltQ);
            double tiltSqrtA = 2.0 * sqrtA * tiltAlpha;
            b0 =      A * ((A + 1.0) - (A - 1.0) * cosw + tiltSqrtA);
            b1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cosw);
            b2 =      A * ((A + 1.0) - (A - 1.0) * cosw - tiltSqrtA);
            a0 =            (A + 1.0) + (A - 1.0) * cosw + tiltSqrtA;
            a1 =     -2.0 * ((A - 1.0) + (A + 1.0) * cosw);
            a2 =            (A + 1.0) + (A - 1.0) * cosw - tiltSqrtA;
            break;
        }

        default:
            b0 = 1.0; b1 = 0.0; b2 = 0.0;
            a0 = 1.0; a1 = 0.0; a2 = 0.0;
            break;
        }

        // Normalise by a0
        const double inv = 1.0 / a0;
        bs.b0 = static_cast<float>(b0 * inv);
        bs.b1 = static_cast<float>(b1 * inv);
        bs.b2 = static_cast<float>(b2 * inv);
        bs.a1 = static_cast<float>(a1 * inv);
        bs.a2 = static_cast<float>(a2 * inv);
    }

    // ── FFT (radix-2 Cooley-Tukey, in-place) ────────────────────────────────

    static void fftCompute(float* re, float* im, int n)
    {
        // Bit-reversal permutation
        for (int i = 1, j = 0; i < n; ++i)
        {
            int bit = n >> 1;
            for (; j & bit; bit >>= 1)
                j ^= bit;
            j ^= bit;
            if (i < j)
            {
                std::swap(re[i], re[j]);
                std::swap(im[i], im[j]);
            }
        }

        const float pi = juce::MathConstants<float>::pi;

        // Butterfly passes
        for (int len = 2; len <= n; len <<= 1)
        {
            float ang = -2.0f * pi / static_cast<float>(len);
            float wRe = std::cos(ang);
            float wIm = std::sin(ang);

            for (int i = 0; i < n; i += len)
            {
                float curRe = 1.0f, curIm = 0.0f;
                int half = len >> 1;
                for (int j = 0; j < half; ++j)
                {
                    int u = i + j;
                    int v = u + half;
                    float tRe = curRe * re[v] - curIm * im[v];
                    float tIm = curRe * im[v] + curIm * re[v];
                    re[v] = re[u] - tRe;
                    im[v] = im[u] - tIm;
                    re[u] += tRe;
                    im[u] += tIm;
                    float newCurRe = curRe * wRe - curIm * wIm;
                    curIm = curRe * wIm + curIm * wRe;
                    curRe = newCurRe;
                }
            }
        }
    }

    // ── Inverse FFT ─────────────────────────────────────────────────────────

    static void ifftCompute(float* re, float* im, int n)
    {
        // Conjugate input
        for (int i = 0; i < n; ++i)
            im[i] = -im[i];
        // Forward FFT
        fftCompute(re, im, n);
        // Conjugate and scale
        const float invN = 1.0f / static_cast<float>(n);
        for (int i = 0; i < n; ++i)
        {
            re[i] *= invN;
            im[i] = -im[i] * invN;
        }
    }

    // ── STFT frame processing (Spectral Dynamics) ───────────────────────────

    void processSTFTFrame(int numCh, double sr)
    {
        const int ringSize = kSTFTSize * 2;
        const int count = bandCount_.load(std::memory_order_relaxed);
        const int binsN = kSTFTSize / 2;

        // Envelope coefficients derived from STFT frame period (hopSize / sr),
        // not per-sample period, because the envelope updates once per frame.
        const float framePeriodSec = static_cast<float>(kSTFTHop) / static_cast<float>(sr);

        for (int ch = 0; ch < numCh; ++ch)
        {
            // Read kSTFTSize samples from input ring, apply Hann window
            std::fill(stftTempRe_.begin(), stftTempRe_.end(), 0.0f);
            std::fill(stftTempIm_.begin(), stftTempIm_.end(), 0.0f);

            int readStart = ((stftWritePos_ - kSTFTSize) % ringSize + ringSize) % ringSize;
            for (int i = 0; i < kSTFTSize; ++i)
            {
                int idx = (readStart + i) % ringSize;
                stftTempRe_[i] = stftInRing_[ch][idx] * stftWindow_[i];
            }

            // Forward FFT
            fftCompute(stftTempRe_.data(), stftTempIm_.data(), kSTFTSize);

            // Per-bin magnitude + log-magnitude (used by local-envelope rolling sum).
            // Only channel 0 detects/updates envelope; channel 1 applies the same env
            // so per-bin state stays once-per-frame (not once-per-channel).
            if (ch == 0)
            {
                const float eps = 1e-20f;
                for (int i = 0; i < binsN; ++i)
                {
                    float re = stftTempRe_[i];
                    float im = stftTempIm_[i];
                    float m  = std::sqrt(re * re + im * im);
                    stftMag_[i]    = m;
                    stftLogMag_[i] = std::log(m + eps);
                }
            }

            // Apply spectral dynamics for each Spectral-mode band
            for (int b = 0; b < count; ++b)
            {
                auto& bs = bands_[b];
                if (bs.mode != 2 || !bs.enabled) continue;
                if (static_cast<int>(bs.specBinEnv.size()) < binsN) continue;

                float bandFreq = bs.freqSmooth.getCurrentValue();
                float bandQ    = bs.qSmooth.getCurrentValue();
                float sens  = bs.specSensPtr    ? bs.specSensPtr->load(std::memory_order_relaxed)    : 0.5f;
                float depth = bs.specDepthPtr   ? bs.specDepthPtr->load(std::memory_order_relaxed)   : 0.0f;
                float sel   = bs.specSelPtr     ? bs.specSelPtr->load(std::memory_order_relaxed)     : 5.0f;
                float atkMs = bs.specAttackPtr  ? bs.specAttackPtr->load(std::memory_order_relaxed)  : 10.0f;
                float relMs = bs.specReleasePtr ? bs.specReleasePtr->load(std::memory_order_relaxed) : 100.0f;

                const float depthLin = std::pow(10.0f, depth / 20.0f);
                const float attackCoeff  = 1.0f - std::exp(-framePeriodSec / (atkMs * 0.001f));
                const float releaseCoeff = 1.0f - std::exp(-framePeriodSec / (relMs * 0.001f));

                // Influence zone: freq ± (freq / Q)
                const float bwHz   = bandFreq / std::max(bandQ, 0.1f);
                const float loFreq = std::max(bandFreq - bwHz, 0.0f);
                const float hiFreq = bandFreq + bwHz;
                const float binHz  = static_cast<float>(sr) / static_cast<float>(kSTFTSize);

                // Envelope update only on ch=0 to preserve per-frame semantics.
                if (ch == 0)
                {
                    // Local envelope: arithmetic mean of logMag in ±half octave
                    // around each bin [i/sqrt(2), i*sqrt(2)]. Rolling sum = O(N).
                    const float loFactor = 0.70710678f; // 1 / sqrt(2)
                    const float hiFactor = 1.41421356f; // sqrt(2)

                    int runLo = 1, runHi = 0;
                    float runSum = 0.0f;
                    int   runCnt = 0;

                    int activeBins = 0;
                    float maxReductionDb = 0.0f;

                    for (int i = 1; i < binsN; ++i)
                    {
                        int loBin = static_cast<int>(static_cast<float>(i) * loFactor);
                        int hiBin = static_cast<int>(static_cast<float>(i) * hiFactor);
                        if (loBin < 1)      loBin = 1;
                        if (hiBin >= binsN) hiBin = binsN - 1;

                        while (runHi < hiBin)
                        {
                            ++runHi;
                            runSum += stftLogMag_[runHi];
                            ++runCnt;
                        }
                        while (runLo < loBin)
                        {
                            runSum -= stftLogMag_[runLo];
                            --runCnt;
                            ++runLo;
                        }

                        const float binFreq = static_cast<float>(i) * binHz;
                        const bool  inZone  = (binFreq >= loFreq && binFreq <= hiFreq);

                        float target = 1.0f;
                        if (inZone && runCnt > 0)
                        {
                            const float localLog = runSum / static_cast<float>(runCnt);
                            const float localEnv = std::exp(localLog);
                            const float thresh   = localEnv * (1.0f + sens * sel);
                            if (stftMag_[i] > thresh)
                                target = depthLin;
                        }
                        // Outside zone: relax toward 1.0 via releaseCoeff (set target=1).

                        const float cur = bs.specBinEnv[i];
                        // Attack = envelope moving toward a stronger reduction
                        // (away from 1.0). Release = envelope returning to 1.0.
                        const bool intensifying =
                            (target < 1.0f && target < cur) ||
                            (target > 1.0f && target > cur);
                        const float coeff = intensifying ? attackCoeff : releaseCoeff;
                        bs.specBinEnv[i] = coeff * target + (1.0f - coeff) * cur;

                        if (bs.specBinEnv[i] < 0.99f || bs.specBinEnv[i] > 1.01f)
                        {
                            ++activeBins;
                            const float redDb = 20.0f * std::log10(std::max(bs.specBinEnv[i], 1e-6f));
                            if (std::abs(redDb) > std::abs(maxReductionDb))
                                maxReductionDb = redDb;
                        }
                    }

#ifdef XLETH_DEBUG
                    bs.specLogCounter += kSTFTHop;
                    if (bs.specLogCounter >= static_cast<int>(sr))
                    {
                        bs.specLogCounter = 0;
                        std::fprintf(stderr, "[EQ-Spec] band=%d activeBins=%d maxRed=%.1fdB\n",
                                     b, activeBins, maxReductionDb);
                    }
#else
                    (void)activeBins;
                    (void)maxReductionDb;
#endif
                }

                // Apply the smoothed per-bin envelope to this channel's spectrum.
                // Only bins within the influence zone are touched.
                const int loBinZ = std::max(1,
                    static_cast<int>(std::floor(loFreq / binHz)));
                const int hiBinZ = std::min(binsN - 1,
                    static_cast<int>(std::ceil(hiFreq / binHz)));
                for (int i = loBinZ; i <= hiBinZ; ++i)
                {
                    const float g = bs.specBinEnv[i];
                    stftTempRe_[i] *= g;
                    stftTempIm_[i] *= g;
                    int mi = kSTFTSize - i;
                    if (mi > 0 && mi < kSTFTSize)
                    {
                        stftTempRe_[mi] *= g;
                        stftTempIm_[mi] *= g;
                    }
                }
            }

            // Inverse FFT
            ifftCompute(stftTempRe_.data(), stftTempIm_.data(), kSTFTSize);

            // Overlap-add into output ring (no synthesis window — Hann OLA)
            int writeStart = ((stftWritePos_ - kSTFTSize) % ringSize + ringSize) % ringSize;
            for (int i = 0; i < kSTFTSize; ++i)
            {
                int idx = (writeStart + i) % ringSize;
                stftOutRing_[ch][idx] += stftTempRe_[i];
            }
        }
    }

    // ── FIR rebuild (Linear Phase) ─────────────────────────────────────────

    void rebuildFIR()
    {
        const int N = firLength_;
        const int count = bandCount_.load(std::memory_order_relaxed);
        const double pi   = juce::MathConstants<double>::pi;

        // Compute magnitude response at N uniformly-spaced frequency bins
        std::fill(firBuildRe_.begin(), firBuildRe_.end(), 0.0f);
        std::fill(firBuildIm_.begin(), firBuildIm_.end(), 0.0f);

        for (int k = 0; k < N; ++k)
        {
            const double w    = 2.0 * pi * static_cast<double>(k) / static_cast<double>(N);
            const double cosw = std::cos(w);
            const double cos2w = std::cos(2.0 * w);
            const double sinw  = std::sin(w);
            const double sin2w = std::sin(2.0 * w);

            double magSq = 1.0;
            for (int b = 0; b < count; ++b)
            {
                if (!bands_[b].enabled) continue;
                // All bands included as Normal (Dynamic/Spectral folded in)
                const double cb0 = bands_[b].b0, cb1 = bands_[b].b1, cb2 = bands_[b].b2;
                const double ca1 = bands_[b].a1, ca2 = bands_[b].a2;

                double numRe = cb0 + cb1 * cosw + cb2 * cos2w;
                double numIm =     - cb1 * sinw - cb2 * sin2w;
                double denRe = 1.0 + ca1 * cosw + ca2 * cos2w;
                double denIm =     - ca1 * sinw - ca2 * sin2w;

                double numMagSq = numRe * numRe + numIm * numIm;
                double denMagSq = denRe * denRe + denIm * denIm;

                magSq *= (denMagSq > 1e-30) ? (numMagSq / denMagSq) : 1.0;
            }

            // Magnitude only, zero phase → real spectrum
            firBuildRe_[k] = static_cast<float>(std::sqrt(std::max(magSq, 0.0)));
        }

        // IFFT → zero-phase impulse response
        ifftCompute(firBuildRe_.data(), firBuildIm_.data(), N);

        // Circular shift by N/2 to make causal
        for (int i = 0; i < N; ++i)
            firBuildShift_[i] = firBuildRe_[(i + N / 2) % N];

        // Blackman window to reduce truncation artefacts
        const float piF = juce::MathConstants<float>::pi;
        for (int i = 0; i < N; ++i)
        {
            float t = static_cast<float>(i) / static_cast<float>(N - 1);
            float w = 0.42f - 0.5f * std::cos(2.0f * piF * t)
                             + 0.08f * std::cos(4.0f * piF * t);
            firBuildShift_[i] *= w;
        }

        std::copy(firBuildShift_.begin(), firBuildShift_.end(), firCoeffs_.begin());
        firDirty_ = false;
    }

    // ── Spectrum analysis thread ────────────────────────────────────────

    void stopAnalysisThread()
    {
        specThreadRunning_.store(false, std::memory_order_relaxed);
        if (specThread_.joinable())
            specThread_.join();
    }

    void processSpectrumFrame(const float* ring, int writeIdx, float* smoothedDb)
    {
        // Allocate FFT scratch on stack (analysis thread, not audio thread)
        std::vector<float> fftBuf(kSpecFFTSize * 2, 0.0f);

        // Read windowed frame from ring buffer
        for (int i = 0; i < kSpecFFTSize; ++i)
        {
            const int idx = (writeIdx - kSpecFFTSize + i) & (kSpecRingSize - 1);
            fftBuf[i] = ring[idx] * specWindow_[i];
        }

        // Forward real-only FFT (output: interleaved complex in fftBuf)
        specFFT_->performRealOnlyForwardTransform(fftBuf.data(), true);

        // Compute magnitude in dB per bin, apply smoothing
        // Bin layout: [re(0), im(0), re(1), im(1), ..., re(N/2), im(N/2)]
        smoothedDb[0] = -200.0f; // DC excluded

        for (int i = 1; i < kSpecBins; ++i)
        {
            const float re = fftBuf[i * 2];
            const float im = fftBuf[i * 2 + 1];
            const float magSq = re * re + im * im;
            const float db = 10.0f * std::log10(std::max(magSq, 1e-30f)) - specNormDb_;

            if (db > smoothedDb[i])
                smoothedDb[i] = db;  // instant attack
            else
                smoothedDb[i] += specDecayCoeff_ * (db - smoothedDb[i]); // slow decay
        }
    }

    void analysisThreadFunc()
    {
        while (specThreadRunning_.load(std::memory_order_relaxed))
        {
            bool didWork = false;

            // ── Post-EQ spectrum ────────────────────────────────────────
            {
                const int wi = specPostWriteIdx_.load(std::memory_order_acquire);
                while (wi - specPostAnalysisPos_ >= kSpecFFTSize)
                {
                    processSpectrumFrame(specPostRing_,
                        specPostAnalysisPos_ + kSpecFFTSize, specPostSmoothed_);
                    specPostAnalysisPos_ += kSpecHop;
                    didWork = true;
                }
            }

            // ── Pre-EQ spectrum (only if enabled) ───────────────────────
            if (specPreEnabled_.load(std::memory_order_relaxed))
            {
                const int wi = specPreWriteIdx_.load(std::memory_order_acquire);
                while (wi - specPreAnalysisPos_ >= kSpecFFTSize)
                {
                    processSpectrumFrame(specPreRing_,
                        specPreAnalysisPos_ + kSpecFFTSize, specPreSmoothed_);
                    specPreAnalysisPos_ += kSpecHop;
                    didWork = true;
                }
            }

            if (didWork)
            {
                // Publish to double buffer (atomic swap)
                const int writeBuf = 1 - specOutputRead_.load(std::memory_order_relaxed);
                std::memcpy(specOutput_[writeBuf].post, specPostSmoothed_,
                    sizeof(float) * kSpecBins);
                std::memcpy(specOutput_[writeBuf].pre, specPreSmoothed_,
                    sizeof(float) * kSpecBins);
                specOutputRead_.store(writeBuf, std::memory_order_release);
            }
            else
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
            }
        }
    }

    // ── APVTS helpers ────────────────────────────────────────────────────────

    static juce::String paramId(int bandIndex, const char* suffix)
    {
        return "b" + juce::String(bandIndex) + "_" + suffix;
    }

    bool setParamDirect(int bandIndex, const std::string& name, float value)
    {
        juce::String pid = paramId(bandIndex, name.c_str());
        auto* param = apvts_.getParameter(pid);
        if (!param) return false;
        auto* rp = dynamic_cast<juce::RangedAudioParameter*>(param);
        if (!rp) return false;
        param->setValueNotifyingHost(rp->convertTo0to1(value));
        return true;
    }

    float readParam(int bandIndex, const char* suffix) const
    {
        auto* raw = apvts_.getRawParameterValue(paramId(bandIndex, suffix));
        return raw ? raw->load(std::memory_order_relaxed) : 0.0f;
    }

    void copyBandParams(int srcBand, int dstBand)
    {
        static const char* names[] = { "freq", "gain", "q", "type", "enabled",
            "mode", "dyn_thresh", "dyn_ratio", "dyn_attack", "dyn_release",
            "spec_sens", "spec_depth", "spec_sel",
            "spec_attack", "spec_release" };
        for (const char* n : names)
            setParamDirect(dstBand, n, readParam(srcBand, n));
    }

    // ── APVTS parameter layout factory ───────────────────────────────────────

    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        std::vector<std::unique_ptr<juce::RangedAudioParameter>> params;
        params.reserve(kMaxBands * 13 + 2);

        // Skew factors: makes midpoint of slider map to a musically useful value.
        // JUCE formula: value = start + (end-start) * exp(log(proportion)/skew)
        // For freq: midpoint (0.5) → ~1 kHz  → skew ≈ 0.23
        // For Q:    midpoint (0.5) → ~0.7    → skew ≈ 0.18
        constexpr float kFreqSkew = 0.23f;
        constexpr float kQSkew    = 0.18f;

        for (int i = 0; i < kMaxBands; ++i)
        {
            juce::String prefix = "b" + juce::String(i) + "_";
            juce::String label  = "B" + juce::String(i) + " ";

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "freq", 1 },
                label + "Freq",
                juce::NormalisableRange<float>(20.0f, 20000.0f, 0.0f, kFreqSkew),
                1000.0f,
                juce::AudioParameterFloatAttributes().withLabel("Hz")));

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "gain", 1 },
                label + "Gain",
                juce::NormalisableRange<float>(-30.0f, 30.0f),
                0.0f,
                juce::AudioParameterFloatAttributes().withLabel("dB")));

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "q", 1 },
                label + "Q",
                juce::NormalisableRange<float>(0.1f, 30.0f, 0.0f, kQSkew),
                0.707f));

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "type", 1 },
                label + "Type",
                juce::NormalisableRange<float>(0.0f, 6.0f, 1.0f), // step = 1 → discrete
                0.0f));

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "enabled", 1 },
                label + "Enabled",
                juce::NormalisableRange<float>(0.0f, 1.0f, 1.0f), // step = 1 → boolean
                1.0f));

            // ── Advanced mode params ────────────────────────────────────────

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "mode", 1 },
                label + "Mode",
                juce::NormalisableRange<float>(0.0f, 2.0f, 1.0f), // 0=Normal,1=Dynamic,2=Spectral
                0.0f));

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "dyn_thresh", 1 },
                label + "Dyn Thresh",
                juce::NormalisableRange<float>(-60.0f, 0.0f),
                -20.0f,
                juce::AudioParameterFloatAttributes().withLabel("dB")));

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "dyn_ratio", 1 },
                label + "Dyn Ratio",
                juce::NormalisableRange<float>(1.0f, 20.0f),
                4.0f));

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "dyn_attack", 1 },
                label + "Dyn Attack",
                juce::NormalisableRange<float>(0.1f, 100.0f),
                10.0f,
                juce::AudioParameterFloatAttributes().withLabel("ms")));

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "dyn_release", 1 },
                label + "Dyn Release",
                juce::NormalisableRange<float>(1.0f, 1000.0f),
                100.0f,
                juce::AudioParameterFloatAttributes().withLabel("ms")));

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "spec_sens", 1 },
                label + "Spec Sens",
                juce::NormalisableRange<float>(0.0f, 1.0f),
                0.5f));

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "spec_depth", 1 },
                label + "Spec Depth",
                juce::NormalisableRange<float>(-30.0f, 30.0f),
                0.0f,
                juce::AudioParameterFloatAttributes().withLabel("dB")));

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "spec_sel", 1 },
                label + "Spec Sel",
                juce::NormalisableRange<float>(1.0f, 20.0f),
                5.0f));

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "spec_attack", 1 },
                label + "Spec Attack",
                juce::NormalisableRange<float>(0.1f, 100.0f),
                10.0f,
                juce::AudioParameterFloatAttributes().withLabel("ms")));

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "spec_release", 1 },
                label + "Spec Release",
                juce::NormalisableRange<float>(10.0f, 1000.0f),
                100.0f,
                juce::AudioParameterFloatAttributes().withLabel("ms")));
        }

        // ── Global params ───────────────────────────────────────────────────

        params.push_back(std::make_unique<juce::AudioParameterFloat>(
            juce::ParameterID{ "linphase", 1 },
            "Linear Phase",
            juce::NormalisableRange<float>(0.0f, 1.0f, 1.0f),
            0.0f));

        params.push_back(std::make_unique<juce::AudioParameterFloat>(
            juce::ParameterID{ "oversample", 1 },
            "Oversample",
            juce::NormalisableRange<float>(0.0f, 2.0f, 1.0f), // 0=off, 1=2x, 2=4x
            0.0f));

        return { std::make_move_iterator(params.begin()),
                 std::make_move_iterator(params.end()) };
    }
};

// Keep the old name as a typedef so existing factory references compile.
using XlethEQEffect = XlethParametricEQ;
