#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <mutex>
#include <vector>

// ─── XlethWaveshaperEffect ──────────────────────────────────────────────────
// Stereo waveshaper with user-editable transfer curve stored as a 1024-point
// double-buffered LUT, 4× FIR equiripple oversampling, DC blocking, and
// dry/wet mix.
//
// Parameters (APVTS-backed):
//   pregain   -24 to 48 dB     (Linear 20ms smoothing)
//   postgain  -24 to 24 dB     (Linear 20ms smoothing)
//   mix       0–100 %          (Linear 20ms smoothing)
//   preset    0–5  discrete    0=Custom, 1=SoftClip(tanh), 2=HardClip,
//                               3=Tube(sigmoid), 4=Fold, 5=Rectify
//
// Metering slots:
//   0 — L channel output peak (absolute, max over block)
//   1 — R channel output peak
//
// Oversampling: 4× FIR equiripple (factor exponent 2 → 2^2 = 4×),
//               integer latency, reported via setLatencySamples().
// DC blocker  : 2nd-order Butterworth HP at 10 Hz, applied at base sample
//               rate after downsampling.
//
// pluginId: "waveshaper"

class XlethWaveshaperEffect : public XlethEffectBase
{
public:
    static constexpr int kLutSize = 1024;
    static constexpr int kMaxControlPoints = 32;

    // ── Constructor ─────────────────────────────────────────────────────────
    XlethWaveshaperEffect()
        : XlethEffectBase("waveshaper", createLayout())
        , oversampling_(2, 2,
                        juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple,
                        true, true)
    {
        registerSmoothedParam("pregain",  SmoothType::Linear, 20.0f);
        registerSmoothedParam("postgain", SmoothType::Linear, 20.0f);
        registerSmoothedParam("mix",      SmoothType::Linear, 20.0f);

        // Initialize both LUTs to linear (passthrough)
        generateLinearLUT(lut_[0]);
        generateLinearLUT(lut_[1]);

        // Default control points: linear passthrough
        controlPoints_ = { {-1.0f, -1.0f}, {0.0f, 0.0f}, {1.0f, 1.0f} };
    }

    // ── Control point access (message thread only) ──────────────────────────

    std::vector<std::pair<float,float>> getControlPoints() const
    {
        std::lock_guard<std::mutex> lock(cpMutex_);
        return controlPoints_;
    }

    bool setControlPoints(const std::vector<std::pair<float,float>>& points)
    {
        if (points.size() < 2 || points.size() > kMaxControlPoints)
            return false;

        {
            std::lock_guard<std::mutex> lock(cpMutex_);
            controlPoints_ = points;
            // Sort by x
            std::sort(controlPoints_.begin(), controlPoints_.end(),
                      [](auto& a, auto& b) { return a.first < b.first; });
            // Merge duplicate x-coordinates to prevent spline division by zero
            deduplicatePoints(controlPoints_);
            if (controlPoints_.size() < 2)
                return false;
        }

        // Set preset to Custom when user edits points
        if (auto* p = apvts_.getParameter("preset"))
        {
            auto* rp = dynamic_cast<juce::RangedAudioParameter*>(p);
            if (rp) p->setValueNotifyingHost(rp->convertTo0to1(0.0f));
        }

        regenerateLUT();
        return true;
    }

    void setPreset(int presetIndex)
    {
        presetIndex = juce::jlimit(0, 5, presetIndex);

        if (auto* p = apvts_.getParameter("preset"))
        {
            auto* rp = dynamic_cast<juce::RangedAudioParameter*>(p);
            if (rp) p->setValueNotifyingHost(rp->convertTo0to1(static_cast<float>(presetIndex)));
        }

        if (presetIndex == 0)
        {
            // Custom — regenerate from control points
            regenerateLUT();
        }
        else
        {
            // Generate preset LUT and update control points to match
            const int inactive = 1 - activeLut_.load(std::memory_order_acquire);
            generatePresetLUT(lut_[inactive], presetIndex);
            activeLut_.store(inactive, std::memory_order_release);

            // Update control points to defaults for the preset
            {
                std::lock_guard<std::mutex> lock(cpMutex_);
                controlPoints_ = getPresetDefaultPoints(presetIndex);
            }

#ifdef XLETH_DEBUG
            static const char* presetNames[] = {"Custom", "SoftClip", "HardClip", "Tube", "Fold", "Rectify"};
            DBG("[Waveshaper] Preset changed: " + juce::String(presetNames[presetIndex])
                + " activeLut=" + juce::String(inactive));
#endif
        }
    }

    // ── checkAndRegenerateLUT (message thread) ────────────────────────────────
    // Call from the message thread after the audio thread sets lutDirty_.
    void checkAndRegenerateLUT()
    {
        if (lutDirty_.exchange(false, std::memory_order_acq_rel))
            regenerateLUT();
    }

    // ── prepareEffect ────────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;

        // Cache raw APVTS pointer for preset (non-smoothed)
        presetPtr_ = apvts_.getRawParameterValue("preset");
        lastPreset_ = presetPtr_
            ? static_cast<int>(presetPtr_->load(std::memory_order_relaxed))
            : 0;

        // Oversampling
        oversampling_.reset();
        oversampling_.initProcessing(static_cast<size_t>(maxBlockSize));
        setLatencySamples(static_cast<int>(oversampling_.getLatencyInSamples()));

        // DC blockers at base sample rate (HP @ 10 Hz)
        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate_;
        spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
        spec.numChannels      = 1;

        dcBlockerL_.prepare(spec);
        dcBlockerR_.prepare(spec);
        dcBlockerL_.reset();
        dcBlockerR_.reset();

        auto dcCoeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(
            sampleRate_, 10.0f);
        dcBlockerL_.coefficients = dcCoeffs;
        dcBlockerR_.coefficients = dcCoeffs;

        // Dry buffer for mix blend
        wsDryBuf_.setSize(2, maxBlockSize, false, true, true);

#ifdef XLETH_DEBUG
        DBG("[Waveshaper] prepareEffect sr=" + juce::String(sampleRate_)
            + " osFactor=" + juce::String((int)oversampling_.getOversamplingFactor())
            + " osLatency=" + juce::String(oversampling_.getLatencyInSamples(), 1)
            + " blockSize=" + juce::String(maxBlockSize));
#endif
    }

    // ── resetEffect ──────────────────────────────────────────────────────────
    void resetEffect() override
    {
        oversampling_.reset();
        dcBlockerL_.reset();
        dcBlockerR_.reset();
    }

    // ── releaseEffect ────────────────────────────────────────────────────────
    void releaseEffect() override
    {
        wsDryBuf_.setSize(0, 0);
    }

    // ── processEffect ────────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = buffer.getNumChannels();

        // ── 1. Check preset changes (read once per block) ────────────────────
        const int currentPreset = presetPtr_
            ? static_cast<int>(presetPtr_->load(std::memory_order_relaxed))
            : 0;
        if (currentPreset != lastPreset_)
        {
            lastPreset_ = currentPreset;
            // Preset changed via APVTS (e.g. automation) — regenerate LUT
            if (currentPreset > 0)
            {
                const int inactive = 1 - activeLut_.load(std::memory_order_acquire);
                generatePresetLUT(lut_[inactive], currentPreset);
                activeLut_.store(inactive, std::memory_order_release);
            }
            else
            {
                // Custom preset — swap to a linear passthrough LUT immediately
                // (no mutex, no spline computation on audio thread).
                // The message thread will regenerate from control points via lutDirty_.
                const int inactive = 1 - activeLut_.load(std::memory_order_acquire);
                generateLinearLUT(lut_[inactive]);
                activeLut_.store(inactive, std::memory_order_release);
                lutDirty_.store(true, std::memory_order_release);
            }
        }

        // ── 2. Advance smoothers, capture final block values ─────────────────
        float pregainDb  = 0.0f;
        float postgainDb = 0.0f;
        float mixPct     = 100.0f;

        for (int s = 0; s < numSamples; ++s)
        {
            pregainDb  = getNextSmoothedValue("pregain");
            postgainDb = getNextSmoothedValue("postgain");
            mixPct     = getNextSmoothedValue("mix");
        }

        const float pregainLin  = std::pow(10.0f, pregainDb / 20.0f);
        const float postgainLin = std::pow(10.0f, postgainDb / 20.0f);

        // ── 3. Copy dry signal BEFORE processing ─────────────────────────────
        for (int ch = 0; ch < std::min(numCh, wsDryBuf_.getNumChannels()); ++ch)
            wsDryBuf_.copyFrom(ch, 0, buffer, ch, 0, numSamples);

        // ── 4. Apply pregain ─────────────────────────────────────────────────
        for (int ch = 0; ch < numCh; ++ch)
        {
            float* data = buffer.getWritePointer(ch);
            for (int s = 0; s < numSamples; ++s)
                data[s] *= pregainLin;
        }

        // ── 5. Upsample ─────────────────────────────────────────────────────
        juce::dsp::AudioBlock<const float> inputBlock(buffer);
        auto osBlock = oversampling_.processSamplesUp(inputBlock);

        const int osNumSamples = static_cast<int>(osBlock.getNumSamples());
        const int osNumCh      = static_cast<int>(osBlock.getNumChannels());

        // ── 6. LUT lookup per channel per OS sample ──────────────────────────
        for (int ch = 0; ch < osNumCh; ++ch)
        {
            float* data = osBlock.getChannelPointer(static_cast<size_t>(ch));
            for (int s = 0; s < osNumSamples; ++s)
                data[s] = lookupLUT(data[s]);
        }

        // ── 7. Downsample back to sampleRate_ ───────────────────────────────
        juce::dsp::AudioBlock<float> outputBlock(buffer);
        oversampling_.processSamplesDown(outputBlock);

        // ── 8. DC blockers at sampleRate_ ────────────────────────────────────
        {
            float* pL = buffer.getWritePointer(0);
            for (int s = 0; s < numSamples; ++s)
                pL[s] = dcBlockerL_.processSample(pL[s]);

            if (numCh > 1)
            {
                float* pR = buffer.getWritePointer(1);
                for (int s = 0; s < numSamples; ++s)
                    pR[s] = dcBlockerR_.processSample(pR[s]);
            }
        }

        // ── 9. Postgain ─────────────────────────────────────────────────────
        for (int ch = 0; ch < numCh; ++ch)
        {
            float* data = buffer.getWritePointer(ch);
            for (int s = 0; s < numSamples; ++s)
                data[s] *= postgainLin;
        }

        // ── 10. Dry/wet blend ────────────────────────────────────────────────
        const float mixNorm = juce::jlimit(0.0f, 1.0f, mixPct / 100.0f);
        if (mixNorm < 1.0f)
        {
            for (int ch = 0; ch < numCh && ch < wsDryBuf_.getNumChannels(); ++ch)
            {
                const float* dry = wsDryBuf_.getReadPointer(ch);
                float*       wet = buffer.getWritePointer(ch);
                for (int s = 0; s < numSamples; ++s)
                    wet[s] = dry[s] * (1.0f - mixNorm) + wet[s] * mixNorm;
            }
        }

        // ── 11. Metering ─────────────────────────────────────────────────────
        float peakL = 0.0f, peakR = 0.0f;
        {
            const float* pL = buffer.getReadPointer(0);
            for (int s = 0; s < numSamples; ++s)
                peakL = std::max(peakL, std::abs(pL[s]));
        }
        if (numCh > 1)
        {
            const float* pR = buffer.getReadPointer(1);
            for (int s = 0; s < numSamples; ++s)
                peakR = std::max(peakR, std::abs(pR[s]));
        }
        writeMeterValue(0, peakL);
        writeMeterValue(1, numCh > 1 ? peakR : peakL);

#ifdef XLETH_DEBUG
        static int dbgBlockCount_ = 0;
        if ((++dbgBlockCount_ % 500) == 0)
            DBG("[Waveshaper] Throttled:"
                " pregain=" + juce::String(pregainDb, 1) + "dB"
                + " postgain=" + juce::String(postgainDb, 1) + "dB"
                + " mix=" + juce::String(mixPct, 0) + "%"
                + " preset=" + juce::String(currentPreset)
                + " peakL=" + juce::String(peakL, 3)
                + " peakR=" + juce::String(peakR, 3));
#endif
    }

    // ── Serialization ────────────────────────────────────────────────────────
    void getStateInformation(juce::MemoryBlock& dest) override
    {
        auto state = apvts_.copyState();

        // Add control points as a child element
        juce::ValueTree cpTree("ControlPoints");
        std::lock_guard<std::mutex> lock(cpMutex_);
        for (size_t i = 0; i < controlPoints_.size(); ++i)
        {
            juce::ValueTree pt("Point");
            pt.setProperty("x", controlPoints_[i].first,  nullptr);
            pt.setProperty("y", controlPoints_[i].second, nullptr);
            cpTree.addChild(pt, -1, nullptr);
        }
        state.addChild(cpTree, -1, nullptr);

        auto xml = state.createXml();
        if (xml) copyXmlToBinary(*xml, dest);
    }

    void setStateInformation(const void* data, int sizeInBytes) override
    {
        auto xml = getXmlFromBinary(data, sizeInBytes);
        if (!xml || !xml->hasTagName(apvts_.state.getType()))
            return;

        auto tree = juce::ValueTree::fromXml(*xml);

        // Extract control points before replacing state
        auto cpTree = tree.getChildWithName("ControlPoints");
        if (cpTree.isValid())
        {
            std::vector<std::pair<float,float>> pts;
            for (int i = 0; i < cpTree.getNumChildren(); ++i)
            {
                auto pt = cpTree.getChild(i);
                float x = pt.getProperty("x", 0.0f);
                float y = pt.getProperty("y", 0.0f);
                pts.push_back({x, y});
            }
            tree.removeChild(cpTree, nullptr);

            if (pts.size() >= 2)
            {
                std::lock_guard<std::mutex> lock(cpMutex_);
                controlPoints_ = std::move(pts);
            }
        }

        apvts_.replaceState(tree);

        // Regenerate LUT from restored state
        int preset = presetPtr_
            ? static_cast<int>(presetPtr_->load(std::memory_order_relaxed))
            : 0;
        if (preset > 0)
        {
            const int inactive = 1 - activeLut_.load(std::memory_order_acquire);
            generatePresetLUT(lut_[inactive], preset);
            activeLut_.store(inactive, std::memory_order_release);
        }
        else
        {
            regenerateLUT();
        }
    }

private:
    // ── Parameter layout ─────────────────────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            std::make_unique<Apf>(Pid{"pregain",  1}, "Pre Gain",
                Nar{-24.0f, 48.0f, 0.0f, 1.0f},  0.0f, "dB"),
            std::make_unique<Apf>(Pid{"postgain", 1}, "Post Gain",
                Nar{-24.0f, 24.0f, 0.0f, 1.0f},  0.0f, "dB"),
            std::make_unique<Apf>(Pid{"mix",      1}, "Mix",
                Nar{0.0f, 100.0f,  0.0f, 1.0f}, 100.0f, "%"),
            std::make_unique<Apf>(Pid{"preset",   1}, "Preset",
                Nar{0.0f,   5.0f,  1.0f, 1.0f},   0.0f, ""),
        };
    }

    // ── Point deduplication helper ───────────────────────────────────────────
    // Merge consecutive sorted points whose x-values differ by < epsilon.
    // Keeps the later point's y-value. Must be called after sorting by x.
    static void deduplicatePoints(std::vector<std::pair<float,float>>& pts)
    {
        constexpr float kMinXSpacing = 1e-5f;
        for (auto it = pts.begin(); it != pts.end() && std::next(it) != pts.end(); )
        {
            auto nxt = std::next(it);
            if (nxt->first - it->first < kMinXSpacing)
            {
                it->second = nxt->second;
                pts.erase(nxt);
            }
            else
            {
                ++it;
            }
        }
    }

    // ── LUT lookup (audio thread, lock-free) ─────────────────────────────────
    float lookupLUT(float input) const
    {
        const auto& table = lut_[activeLut_.load(std::memory_order_acquire)];
        float norm = juce::jlimit(0.0f, 1.0f, (input + 1.0f) * 0.5f);
        float index = norm * 1023.0f;
        int i0 = static_cast<int>(index);
        int i1 = std::min(i0 + 1, 1023);
        float frac = index - static_cast<float>(i0);
        float result = table[static_cast<size_t>(i0)]
                     + frac * (table[static_cast<size_t>(i1)] - table[static_cast<size_t>(i0)]);
        return std::isnan(result) ? 0.0f : result;
    }

    // ── LUT generation helpers ───────────────────────────────────────────────

    static void generateLinearLUT(std::array<float, kLutSize>& lut)
    {
        for (int i = 0; i < kLutSize; ++i)
        {
            float x = (static_cast<float>(i) / 1023.0f) * 2.0f - 1.0f;
            lut[static_cast<size_t>(i)] = x;
        }
    }

    static void generatePresetLUT(std::array<float, kLutSize>& lut, int presetIndex)
    {
        for (int i = 0; i < kLutSize; ++i)
        {
            float x = (static_cast<float>(i) / 1023.0f) * 2.0f - 1.0f;
            float y;

            switch (presetIndex)
            {
                case 1: // SoftClip — tanh
                    y = std::tanh(3.0f * x);
                    break;

                case 2: // HardClip
                    y = juce::jlimit(-1.0f, 1.0f, 2.0f * x);
                    break;

                case 3: // Tube — sigmoid
                    y = (2.0f / (1.0f + std::exp(-3.0f * x))) - 1.0f;
                    break;

                case 4: // Fold — sine-based foldback
                    y = std::sin(x * juce::MathConstants<float>::pi);
                    break;

                case 5: // Rectify
                    y = std::abs(x);
                    break;

                default: // Custom / linear
                    y = x;
                    break;
            }

            lut[static_cast<size_t>(i)] = y;
        }
    }

    // ── Cubic spline interpolation (message thread) ──────────────────────────
    // Natural cubic spline through sorted control points, evaluated at kLutSize
    // evenly-spaced x values in [-1, 1].

    void regenerateLUT()
    {
        std::vector<std::pair<float,float>> pts;
        {
            std::lock_guard<std::mutex> lock(cpMutex_);
            pts = controlPoints_;
        }

        if (pts.size() < 2)
            return;

        // Sort by x and deduplicate to prevent spline division by zero
        std::sort(pts.begin(), pts.end(),
                  [](auto& a, auto& b) { return a.first < b.first; });
        deduplicatePoints(pts);

        if (pts.size() < 2)
            return;

        const int n = static_cast<int>(pts.size());
        const int inactive = 1 - activeLut_.load(std::memory_order_acquire);

        if (n == 2)
        {
            // Linear interpolation between two points
            for (int i = 0; i < kLutSize; ++i)
            {
                float x = (static_cast<float>(i) / 1023.0f) * 2.0f - 1.0f;
                float t = (x - pts[0].first) / (pts[1].first - pts[0].first + 1e-12f);
                t = juce::jlimit(0.0f, 1.0f, t);
                lut_[inactive][static_cast<size_t>(i)] = pts[0].second + t * (pts[1].second - pts[0].second);
            }
        }
        else
        {
            // Natural cubic spline
            std::vector<float> h(static_cast<size_t>(n - 1));
            std::vector<float> alpha(static_cast<size_t>(n - 1));
            std::vector<float> l(static_cast<size_t>(n), 1.0f);
            std::vector<float> mu(static_cast<size_t>(n), 0.0f);
            std::vector<float> z(static_cast<size_t>(n), 0.0f);
            std::vector<float> c(static_cast<size_t>(n), 0.0f);
            std::vector<float> b(static_cast<size_t>(n - 1));
            std::vector<float> d(static_cast<size_t>(n - 1));

            for (int i = 0; i < n - 1; ++i)
                h[static_cast<size_t>(i)] = std::max(1e-7f,
                    pts[static_cast<size_t>(i + 1)].first
                  - pts[static_cast<size_t>(i)].first);

            for (int i = 1; i < n - 1; ++i)
            {
                const auto si  = static_cast<size_t>(i);
                const auto si1 = static_cast<size_t>(i + 1);
                const auto sim = static_cast<size_t>(i - 1);
                alpha[si] = (3.0f / h[si]) * (pts[si1].second - pts[si].second)
                          - (3.0f / h[sim]) * (pts[si].second - pts[sim].second);
            }

            for (int i = 1; i < n - 1; ++i)
            {
                const auto si  = static_cast<size_t>(i);
                const auto sim = static_cast<size_t>(i - 1);
                l[si]  = 2.0f * (pts[static_cast<size_t>(i + 1)].first
                        - pts[sim].first) - h[sim] * mu[sim];
                mu[si] = h[si] / l[si];
                z[si]  = (alpha[si] - h[sim] * z[sim]) / l[si];
            }

            for (int j = n - 2; j >= 0; --j)
            {
                const auto sj  = static_cast<size_t>(j);
                const auto sj1 = static_cast<size_t>(j + 1);
                c[sj] = z[sj] - mu[sj] * c[sj1];
                b[sj] = (pts[sj1].second - pts[sj].second) / h[sj]
                       - h[sj] * (c[sj1] + 2.0f * c[sj]) / 3.0f;
                d[sj] = (c[sj1] - c[sj]) / (3.0f * h[sj]);
            }

            // Evaluate spline at each LUT sample
            for (int i = 0; i < kLutSize; ++i)
            {
                float x = (static_cast<float>(i) / 1023.0f) * 2.0f - 1.0f;

                // Clamp to control point range and find segment
                if (x <= pts[0].first)
                {
                    lut_[inactive][static_cast<size_t>(i)] = pts[0].second;
                    continue;
                }
                if (x >= pts[static_cast<size_t>(n - 1)].first)
                {
                    lut_[inactive][static_cast<size_t>(i)] = pts[static_cast<size_t>(n - 1)].second;
                    continue;
                }

                // Binary search for segment
                int seg = 0;
                for (int j = n - 2; j >= 0; --j)
                {
                    if (x >= pts[static_cast<size_t>(j)].first)
                    {
                        seg = j;
                        break;
                    }
                }

                const auto ss = static_cast<size_t>(seg);
                float dx = x - pts[ss].first;
                float y = pts[ss].second + b[ss] * dx + c[ss] * dx * dx + d[ss] * dx * dx * dx;
                lut_[inactive][static_cast<size_t>(i)] = juce::jlimit(-1.0f, 1.0f, y);
            }
        }

        activeLut_.store(inactive, std::memory_order_release);

#ifdef XLETH_DEBUG
        DBG("[Waveshaper] LUT regenerated: points=" + juce::String(n)
            + " activeLut=" + juce::String(inactive));
#endif
    }

    // ── Default control points for presets ────────────────────────────────────
    static std::vector<std::pair<float,float>> getPresetDefaultPoints(int presetIndex)
    {
        // Approximate the preset curve with representative control points
        switch (presetIndex)
        {
            case 1: // SoftClip
                return { {-1.0f, -0.9951f}, {-0.5f, -0.9051f}, {0.0f, 0.0f},
                         {0.5f, 0.9051f}, {1.0f, 0.9951f} };
            case 2: // HardClip
                return { {-1.0f, -1.0f}, {-0.5f, -1.0f}, {0.0f, 0.0f},
                         {0.5f, 1.0f}, {1.0f, 1.0f} };
            case 3: // Tube
                return { {-1.0f, -0.9051f}, {-0.5f, -0.6457f}, {0.0f, 0.0f},
                         {0.5f, 0.6457f}, {1.0f, 0.9051f} };
            case 4: // Fold
                return { {-1.0f, 0.0f}, {-0.5f, -1.0f}, {0.0f, 0.0f},
                         {0.5f, 1.0f}, {1.0f, 0.0f} };
            case 5: // Rectify
                return { {-1.0f, 1.0f}, {-0.5f, 0.5f}, {0.0f, 0.0f},
                         {0.5f, 0.5f}, {1.0f, 1.0f} };
            default:
                return { {-1.0f, -1.0f}, {0.0f, 0.0f}, {1.0f, 1.0f} };
        }
    }

    // ── Raw APVTS pointer for preset (non-smoothed) ──────────────────────────
    std::atomic<float>* presetPtr_ = nullptr;
    int lastPreset_ = 0;

    // ── Double-buffered LUT ──────────────────────────────────────────────────
    std::array<float, kLutSize> lut_[2];
    std::atomic<int> activeLut_{0};
    std::atomic<bool> lutDirty_{false};

    // ── Control points (message thread, mutex-protected) ─────────────────────
    mutable std::mutex cpMutex_;
    std::vector<std::pair<float,float>> controlPoints_;

    // ── 4× FIR equiripple oversampling ───────────────────────────────────────
    juce::dsp::Oversampling<float> oversampling_;

    // ── DC blockers: 2nd-order HP @ 10 Hz ────────────────────────────────────
    juce::dsp::IIR::Filter<float> dcBlockerL_;
    juce::dsp::IIR::Filter<float> dcBlockerR_;

    // ── Dry copy buffer ──────────────────────────────────────────────────────
    juce::AudioBuffer<float> wsDryBuf_;

    // ── State ────────────────────────────────────────────────────────────────
    double sampleRate_ = 44100.0;
};
