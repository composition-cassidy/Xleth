#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstring>
#include <initializer_list>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
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
//   b{i}_channel 0–4 discrete  (Stereo=0, Left=1, Right=2, Mid=3, Side=4)
//
// Coefficients are recomputed once per audio block from smoothed values.
// 0 bands active by default; add/remove dynamically via addBand()/removeBand().
//
// Provides:
//   getResponseCurve()  — Stereo-routed |H(e^jω)| at 512 log-spaced frequencies (main thread)
//   getChannelResponseCurves() — one such trace per routing group (St/L/R/M/S)
//   getSpectrumData()   — Hann-windowed 2048-point FFT of recent output (main thread)
//
// Threading ([EQCore] locking fix). The RPC / applier threads (addBand,
// removeBand, setBandParam(s), setParameterValue, setStateInformation) never
// touch audio-thread state. Every parameter the audio thread uses is read ONCE
// per block into a private snapshot (ParamSnapshot) through a sequence counter:
// multi-parameter edits (add / remove / restore / setBandParams) run inside an
// edit window (editSeq_ odd), and a block whose copy overlapped one keeps the
// previous block's snapshot instead (wait-free: no lock, no retry loop on the
// audio thread). Per-band DSP state that an edit invalidates (biquad and
// detector state, spectral envelopes) is cleared by the audio thread itself,
// from a request mask published inside the same edit window. The latency status
// atomics are written by the parameter path only.
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

    // Weighted Overlap-Add (WOLA), same structure as the Resonance Suppressor's
    // WolaProcessor: 75% overlap with a sqrt-Hann window applied on BOTH the
    // analysis and the synthesis side, normalised per hop phase by 1/sum(w^2).
    //
    // Analysis-only windowing at 50% overlap does NOT survive spectral gain
    // modification: the modified frame is no longer confined to the window's
    // support, so its edges land in the output as a step discontinuity once per
    // hop — an audible click train locked to the hop grid.  The synthesis
    // window tapers those edges and 75% overlap keeps four frames summing over
    // every output sample.
    static constexpr int kSTFTHop      = kSTFTSize / 4;   // 75% overlap

    // A frame covering [t, t+kSTFTSize) can only be complete once sample
    // t+kSTFTSize-1 has arrived, so correct WOLA reconstruction costs a full
    // kSTFTSize of latency — not kSTFTHop.  Output is written at
    // frameStart + kSTFTLatency (see processSTFTFrame).
    static constexpr int kSTFTLatency  = kSTFTSize;

    // Power-of-two ring so indexing is a mask, and large enough to hold the
    // live input window plus the latency-shifted output span and one block.
    static constexpr int kSTFTRingSize = kSTFTSize * 4;
    static constexpr int kSTFTRingMask = kSTFTRingSize - 1;

    // Spectral detection soft knee: a bin this far above its local threshold
    // receives the band's full depth; anything less gets a proportional share,
    // so mild protrusions are nudged rather than hard-gated.
    static constexpr float kSpecKneeDb = 6.0f;

    // Fade-in on the first real output of an STFT stream restarted mid-run
    // (Spectral band re-enabled, linear phase left). See processEffect.
    static constexpr double kStftFadeInMs = 5.0;


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

    // Per-band channel routing.  Values match the b{i}_channel APVTS range and
    // the UI's CHANNEL_MODES array order (eqStore.js).
    enum class ChannelMode : int {
        Stereo = 0, Left = 1, Right = 2, Mid = 3, Side = 4
    };
    static constexpr int kNumChannelModes = 5;

    // Filter-state slots per band: L, R, M, S (indices 0..3).
    static constexpr int kNumRoutingSlots = 4;
    static constexpr int kSlotL = 0, kSlotR = 1, kSlotM = 2, kSlotS = 3;

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
            {
                // One edit: the audio thread sees the whole restored state or
                // the previous one, never a mix. It clears the restored bands'
                // DSP state itself (see requestBandClear).
                EditScope edit(*this);

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
                    requestBandClear(i);
            }
            refreshLatencySamples();
        }
    }

    // ── Band management (main thread only) ───────────────────────────────────
    // RPC / applier threads. Each call is ONE edit for the audio thread (see the
    // threading note at the top): it never observes a half-written band.

    // Add a new band with default params.  Returns band index or -1 if full.
    int addBand()
    {
        int count = 0;
        {
            EditScope edit(*this);
            count = bandCount_.load(std::memory_order_relaxed);
            if (count >= kMaxBands) return -1;

            // Reset APVTS params to defaults for the new band
            setParamDirect(count, "freq",    1000.0f);
            setParamDirect(count, "gain",    0.0f);
            setParamDirect(count, "q",       0.707f);
            setParamDirect(count, "type",    0.0f);
            setParamDirect(count, "enabled", 1.0f);
            setParamDirect(count, "channel", 0.0f);   // 0 = Stereo
            setParamDirect(count, "mode",        0.0f);
            setParamDirect(count, "dyn_thresh", -20.0f);
            setParamDirect(count, "dyn_ratio",   4.0f);
            setParamDirect(count, "dyn_attack",  10.0f);
            setParamDirect(count, "dyn_release", 100.0f);
            setParamDirect(count, "dyn_range",   12.0f);
            setParamDirect(count, "spec_sens",    0.5f);
            setParamDirect(count, "spec_sel",     5.0f);
            setParamDirect(count, "spec_attack",  10.0f);
            setParamDirect(count, "spec_release", 100.0f);

            // Clear biquad state for the new band (on the audio thread, with
            // the snapshot that first contains it).
            requestBandClear(count);

            bandCount_.store(count + 1, std::memory_order_relaxed);
        }
        refreshLatencySamples();
        return count;
    }

    // Remove band at index.  Swaps with last band, decrements count.
    bool removeBand(int index)
    {
        {
            EditScope edit(*this);
            int count = bandCount_.load(std::memory_order_relaxed);
            if (index < 0 || index >= count) return false;

            int last = count - 1;
            if (index != last)
            {
                // Copy last band's APVTS params to the removed slot
                copyBandParams(last, index);
                requestBandClear(index);
            }
            requestBandClear(last);
            bandCount_.store(last, std::memory_order_relaxed);
        }
        refreshLatencySamples();
        return true;
    }

    // Set a single band parameter by name.
    // paramName: "freq", "gain", "q", "type", "enabled"
    bool setBandParam(int bandIndex, const std::string& paramName, float value)
    {
        int count = bandCount_.load(std::memory_order_relaxed);
        if (bandIndex < 0 || bandIndex >= count) return false;
        const bool ok = setParamDirect(bandIndex, paramName, value);
        if (ok && isLatencyAffectingBandParam(paramName))
            refreshLatencySamples();
        return ok;
    }

    // Set several parameters of one band as ONE edit: the audio thread uses
    // either all of the new values or none of them in any block (a node drag
    // that moves freq and gain together never renders half-moved). Returns
    // false when the band does not exist or a name is unknown (the known ones
    // are still applied).
    bool setBandParams(int bandIndex, std::initializer_list<std::pair<const char*, float>> params)
    {
        bool ok = true;
        bool latency = false;
        {
            EditScope edit(*this);
            const int count = bandCount_.load(std::memory_order_relaxed);
            if (bandIndex < 0 || bandIndex >= count) return false;
            for (const auto& p : params)
            {
                const std::string name(p.first);
                if (!setParamDirect(bandIndex, name, p.second)) ok = false;
                else if (isLatencyAffectingBandParam(name)) latency = true;
            }
        }
        if (latency)
            refreshLatencySamples();
        return ok;
    }

    int getBandCount() const { return bandCount_.load(std::memory_order_relaxed); }

    // ── Per-block parameter snapshot (audio thread) ─────────────────────────
    // The raw APVTS values of one band exactly as the parameters hold them
    // (conversions happen where they are used, as before the snapshot existed).
    struct BandParamSnapshot
    {
        float freq = 1000.0f, gain = 0.0f, q = 0.707f, type = 0.0f;
        float enabled = 1.0f, channel = 0.0f, mode = 0.0f;
        float dynThresh = -20.0f, dynRatio = 4.0f, dynAttack = 10.0f, dynRelease = 100.0f, dynRange = 12.0f;
        float specSens = 0.5f, specSel = 5.0f, specAttack = 10.0f, specRelease = 100.0f;
    };

    // Everything processEffect reads from the parameters, for one block.
    struct ParamSnapshot
    {
        int   count = 0;                  // bands in use (bandCount_)
        float linPhase = 0.0f;
        float oversample = 0.0f;
        BandParamSnapshot band[kMaxBands];
    };


    // Tests only. The snapshot the LAST processed block used (read it on the
    // processing thread between blocks), and how many blocks took a fresh
    // snapshot vs kept the previous one because an edit overlapped the copy.
    const ParamSnapshot& getAudioParamSnapshotForTest() const noexcept { return snap_; }
    std::uint64_t getSnapshotAcceptedCountForTest() const noexcept { return snapshotsAccepted_; }
    std::uint64_t getSnapshotKeptCountForTest() const noexcept { return snapshotsKept_; }
    // Negative control for the stress test: false = accept every copy even if
    // an edit overlapped it (the pre-fix behaviour, torn reads possible).
    void setSnapshotSeqCheckForTest(bool enabled) noexcept { snapshotSeqCheck_ = enabled; }

    // ── Response curves (main thread) ────────────────────────────────────────
    // A band's routing decides WHICH signal it shapes, so bands with different
    // routing cannot honestly share one trace: a Side-routed +12 dB bell leaves
    // Mid untouched, and a single averaged line would report a bell that
    // neither channel actually gets.  Instead the bands are grouped by
    // (folded) routing and each group gets its own trace:
    //
    //   trace k = 20*log10 | prod over enabled bands routed to k of H_band |
    //
    // Every band in a group acts on the same signal (both channels for Stereo,
    // L / R for Left / Right, the M / S component for Mid / Side) and they
    // commute, so the product is exactly what that signal is filtered by.
    // A group with no bands is a flat 0 dB trace.
    //
    // Computes coefficients on the fly from APVTS parameters so the curves
    // always reflect the current UI state even when no audio is flowing.

    // The standard (Stereo-routed) trace only: writes up to kResponseSize dB
    // values at log-spaced frequencies.  For an all-Stereo chain this is the
    // whole EQ response.
    void getResponseCurve(float* outBuf, int outSize) const
    {
        writeResponseTraces(outBuf, outSize,
                            static_cast<int>(ChannelMode::Stereo), 1);
    }

    // Every routing group's trace, back to back in ChannelMode order
    // (Stereo, Left, Right, Mid, Side).  `outSize` is the per-trace length
    // (capped at kResponseSize) and outBuf must hold kNumChannelModes * n
    // floats; trace k starts at outBuf[k * n].
    void getChannelResponseCurves(float* outBuf, int outSize) const
    {
        writeResponseTraces(outBuf, outSize, 0, kNumChannelModes);
    }

private:
    void writeResponseTraces(float* outBuf, int outSize,
                             int firstChannel, int numChannels) const
    {
        const int n       = std::min(outSize, kResponseSize);
        const int count   = bandCount_.load(std::memory_order_relaxed);
        const double sr   = sampleRate_.load(std::memory_order_relaxed);
        const double pi   = juce::MathConstants<double>::pi;
        const double logMin = std::log(20.0);
        const double logMax = std::log(20000.0);

        using Cplx = std::complex<double>;

        // Linear Phase folds every band's routing to Stereo (see
        // foldChannelForContext) — the displayed curves must agree with that.
        const bool linPhaseActive = linPhasePtr_
            ? (linPhasePtr_->load(std::memory_order_relaxed) > 0.5f) : false;

        // Snapshot current APVTS parameters and compute coefficients locally
        // so we don't depend on processEffect having run recently.
        struct LocalCoeffs { double b0, b1, b2, a1, a2; bool enabled; int channel; };
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

            // Channel routing snapshot.  numCh = 2 here: this EQ always runs on
            // a stereo bus (prepareEffect sizes everything for 2 channels), and
            // a mono bus folds to Stereo, which is the Stereo group's trace.
            int chMode = bs.channelPtr
                ? static_cast<int>(bs.channelPtr->load(std::memory_order_relaxed)) : 0;
            if (chMode < 0 || chMode >= kNumChannelModes) chMode = 0;
            lc[b].channel = foldChannelForContext(chMode, mode, linPhaseActive, 2);

            // Skip bands whose group the caller did not ask for.
            if (lc[b].channel < firstChannel || lc[b].channel >= firstChannel + numChannels)
            {
                lc[b].enabled = false;
                continue;
            }

            // Dynamic bands: gainDb is the permanent baseline; the curve
            // animates further from it toward gainDb + dyn_range as activation
            // grows. Snapshot activation once per call — audio thread stores
            // it atomically.
            if (mode == 1)
            {
                const float act = bs.dynActivation.load(std::memory_order_relaxed);
                const float rangeDb = bs.dynRangePtr
                    ? bs.dynRangePtr->load(std::memory_order_relaxed) : 12.0f;
                gainDb += act * rangeDb;
            }

            // Spectral bands (mode == 2) are drawn as their plain bell, and
            // that is now honest: the gain knob IS the band's spectral depth
            // and the per-bin influence weight is this very bell normalised to
            // 1 at the centre (see updateSpectralWeights).  So the curve reads
            // as the band's maximum-depth profile — the shape suppression
            // follows, reached by bins fully over threshold.

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

            // Running complex product per routing group; identity = flat.
            Cplx group[kNumChannelModes];
            for (auto& g : group) g = Cplx(1.0, 0.0);

            for (int b = 0; b < count; ++b)
            {
                if (!lc[b].enabled) continue;

                // H(e^jw) = (b0 + b1*e^-jw + b2*e^-j2w) / (1 + a1*e^-jw + a2*e^-j2w)
                const Cplx num(lc[b].b0 + lc[b].b1 * cosw + lc[b].b2 * cos2w,
                                        - lc[b].b1 * sinw - lc[b].b2 * sin2w);
                const Cplx den(1.0 + lc[b].a1 * cosw + lc[b].a2 * cos2w,
                                    - lc[b].a1 * sinw - lc[b].a2 * sin2w);

                const double denMagSq = den.real() * den.real() + den.imag() * den.imag();
                if (denMagSq > 1e-30)
                    group[lc[b].channel] *= num / den;
            }

            // -300 dB floor for exact nulls (HP/LP stopband, notch centre).
            for (int k = 0; k < numChannels; ++k)
            {
                const double db = 20.0 * std::log10(
                    std::max(std::abs(group[firstChannel + k]), 1e-15));
                outBuf[k * n + i] = static_cast<float>(db);
            }
        }
    }

public:

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
            b["channel"] = static_cast<int>(readParam(i, "channel"));
            b["mode"]        = static_cast<int>(readParam(i, "mode"));
            b["dyn_thresh"]  = readParam(i, "dyn_thresh");
            b["dyn_ratio"]   = readParam(i, "dyn_ratio");
            b["dyn_attack"]  = readParam(i, "dyn_attack");
            b["dyn_release"] = readParam(i, "dyn_release");
            b["dyn_range"]   = readParam(i, "dyn_range");
            b["spec_sens"]    = readParam(i, "spec_sens");
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
        if (hasSpectralBands_.load(std::memory_order_relaxed)) lat += kSTFTLatency;
        if (linPhaseActive_.load(std::memory_order_relaxed)) lat += firLength_ / 2;
        const int currentOSFactor = currentOSFactor_.load(std::memory_order_relaxed);
        if (currentOSFactor > 0)
        {
            auto* os = (currentOSFactor == 1) ? os2x_.get() : os4x_.get();
            if (os) lat += static_cast<int>(std::ceil(os->getLatencyInSamples()));
        }
        return lat;
    }

    std::uint64_t getProcessBlockLatencyUpdateCount() const
    {
        return processBlockLatencyUpdateCount_.load(std::memory_order_acquire);
    }

    std::uint64_t getNonRealtimeLatencyUpdateCount() const
    {
        return nonRealtimeLatencyUpdateCount_.load(std::memory_order_acquire);
    }

    int getReportedProcessorLatencySamples() const
    {
        return AudioProcessor::getLatencySamples();
    }

    bool refreshLatencySamples()
    {
        refreshLatencyStateFromParameters();
        const int newLat = getLatencySamples();
        if (newLat == AudioProcessor::getLatencySamples())
            return false;

        setLatencySamples(newLat);
        nonRealtimeLatencyUpdateCount_.fetch_add(1, std::memory_order_acq_rel);
        return true;
    }

    // ── Tail length ──────────────────────────────────────────────────────────
    // Active EQ bands are stateful. Their biquad/filter state must be allowed
    // to decay through silence gaps so state from clip A is not frozen and
    // injected into clip B when chopped clips resume.
    //
    // This is a practical DAW-style tail, not a mathematical bound for
    // pathological low-frequency/high-Q settings. It covers normal musical EQ
    // use, FIR/oversampler/spectral internal state, and keeps MixEngine's
    // tail-gated silence processing CPU-conscious.
    double getTailLengthSeconds() const override { return 0.2; }

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
            bs.channelPtr = apvts_.getRawParameterValue(paramId(i, "channel"));

            // Advanced mode pointers
            bs.modePtr       = apvts_.getRawParameterValue(paramId(i, "mode"));
            bs.dynThreshPtr  = apvts_.getRawParameterValue(paramId(i, "dyn_thresh"));
            bs.dynRatioPtr   = apvts_.getRawParameterValue(paramId(i, "dyn_ratio"));
            bs.dynAttackPtr  = apvts_.getRawParameterValue(paramId(i, "dyn_attack"));
            bs.dynReleasePtr = apvts_.getRawParameterValue(paramId(i, "dyn_release"));
            bs.dynRangePtr   = apvts_.getRawParameterValue(paramId(i, "dyn_range"));
            bs.specSensPtr    = apvts_.getRawParameterValue(paramId(i, "spec_sens"));
            bs.specSelPtr     = apvts_.getRawParameterValue(paramId(i, "spec_sel"));
            bs.specAttackPtr  = apvts_.getRawParameterValue(paramId(i, "spec_attack"));
            bs.specReleasePtr = apvts_.getRawParameterValue(paramId(i, "spec_release"));

            // Per-bin spectral envelope buffer (audio-thread read/write; sized once here)
            bs.specBinEnv.assign(kSTFTSize / 2, 1.0f);
            // Per-bin bell influence weight (rebuilt lazily on the audio thread
            // by updateSpectralWeights; the -1 freq forces the first rebuild).
            bs.specBinWeight.assign(kSTFTSize / 2, 0.0f);
            bs.specWeightFreq = -1.0f;

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

            float range = bs.dynRangePtr ? bs.dynRangePtr->load(std::memory_order_relaxed) : 12.0f;
            bs.rangeSmooth.reset(sampleRate, 0.020);
            bs.rangeSmooth.setCurrentAndTargetValue(range);

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
            stftInRing_[ch].assign(kSTFTRingSize, 0.0f);
            stftOutRing_[ch].assign(kSTFTRingSize, 0.0f);
        }
        resetSTFTStream();
        stftNeedsRestart_ = false;
        stftFadeIn_       = false;
        pendingStreamReset_.store(false, std::memory_order_relaxed);

        // WOLA window: sqrt of a PERIODIC Hann (denominator kSTFTSize, not
        // kSTFTSize-1 — the periodic form is the one that overlap-adds exactly).
        // The same window is applied on analysis and again on synthesis, so the
        // pair multiplies out to a full Hann.
        {
            const float twoPi = 2.0f * juce::MathConstants<float>::pi;
            for (int i = 0; i < kSTFTSize; ++i)
            {
                const float hann = 0.5f - 0.5f * std::cos(twoPi
                    * static_cast<float>(i) / static_cast<float>(kSTFTSize));
                stftWindow_[i] = std::sqrt(std::max(hann, 0.0f));
            }

            // Per-hop-phase normalisation 1/sum(w^2). Every output sample is
            // covered by kSTFTSize/kSTFTHop frames whose window indices are
            // congruent mod kSTFTHop, so one value per phase is exact.
            for (int phase = 0; phase < kSTFTHop; ++phase)
            {
                float sum = 0.0f;
                for (int i = phase; i < kSTFTSize; i += kSTFTHop)
                    sum += stftWindow_[i] * stftWindow_[i];
                stftNorm_[phase] = (sum > 1.0e-8f) ? (1.0f / sum) : 1.0f;
            }
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

        // Per-bin trig tables for the spectral bell weight (bin-frequency only)
        {
            const int binsN = kSTFTSize / 2;
            stftBinCosW_.resize(binsN);
            stftBinSinW_.resize(binsN);
            stftBinCos2W_.resize(binsN);
            stftBinSin2W_.resize(binsN);
            const double twoPi = 2.0 * juce::MathConstants<double>::pi;
            for (int i = 0; i < binsN; ++i)
            {
                const double w = twoPi * static_cast<double>(i)
                               / static_cast<double>(kSTFTSize);
                stftBinCosW_[i]  = static_cast<float>(std::cos(w));
                stftBinSinW_[i]  = static_cast<float>(std::sin(w));
                stftBinCos2W_[i] = static_cast<float>(std::cos(2.0 * w));
                stftBinSin2W_[i] = static_cast<float>(std::sin(2.0 * w));
            }
        }

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

        // Not processing: the first block's snapshot is the current state, and
        // every band was cleared above, so no clear request is outstanding.
        readParamsInto(snap_);
        pendingBandClear_.store(0u, std::memory_order_relaxed);
        deferredBandClear_ = 0u;

        refreshLatencySamples();
    }

    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = std::min(buffer.getNumChannels(), 2);
        const double sr      = sampleRate_.load(std::memory_order_relaxed);

        // Every parameter this block uses, read once, consistently (the
        // previous block's snapshot if an edit was in progress), and the band
        // state clears the RPC side asked for.
        takeParamSnapshot();
        const ParamSnapshot& P = snap_;
        const int count = P.count;

        // Un-bypass: the stream froze while the base class skipped us. Take the
        // request here, on the audio thread, and let the restart logic below
        // rewind it (or the inactive branch re-arm it) like any other re-entry.
        if (pendingStreamReset_.exchange(false, std::memory_order_acq_rel))
            stftNeedsRestart_ = true;

        // ── Read global mode state ──────────────────────────────────────────
        // Read before the per-band latch below: linear phase folds every band's
        // channel routing back to Stereo. (The status atomics behind
        // getLatencySamples() belong to the parameter path, not to this thread.)
        const bool linPhaseActive = P.linPhase > 0.5f;

        // ── Read band modes + enabled + channel routing ─────────────────────
        bool hasDynamic = false;
        for (int b = 0; b < count; ++b)
        {
            auto& bs = bands_[b];
            const auto& bp = P.band[b];
            bs.mode    = static_cast<int>(bp.mode);
            bs.enabled = bp.enabled > 0.5f;
            bs.channel = static_cast<int>(bp.channel);
            if (bs.channel < 0 || bs.channel >= kNumChannelModes) bs.channel = 0;
            bs.channel = foldChannelForContext(bs.channel, bs.mode, linPhaseActive, numCh);
            if (bs.mode == 1 && bs.enabled) hasDynamic = true;
        }

        // Read oversample factor (0=off, 1=2x, 2=4x)
        int osRaw = static_cast<int>(P.oversample);

        // Spectral + OS mutually exclusive: spectral wins, OS bypassed
        bool anySpectral = false;
        if (!linPhaseActive)
        {
            for (int b = 0; b < count; ++b)
                if (bands_[b].mode == 2 && bands_[b].enabled) { anySpectral = true; break; }
        }
        const int currentOSFactor = anySpectral ? 0 : osRaw;

        // Effective sample rate for coefficient computation
        const double effectiveSR = sr * static_cast<double>(1 << currentOSFactor);

        // ── Dynamic EQ sidechain analysis (Model B, FabFilter-style) ────────
        // Skipped when linPhase is active (all bands treated as Normal).
        // Detector: dedicated constant-skirt BPF (independent of band gain).
        // Output: activation in [0,1]; 0 = band off, 1 = at user target gain.
        if (!linPhaseActive && hasDynamic)
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

                // Attack/release coefficients from APVTS (this block's snapshot)
                float attackMs  = P.band[b].dynAttack;
                float releaseMs = P.band[b].dynRelease;
                bs.dynAttackCoeff  = 1.0f - std::exp(-1.0f / (attackMs  * 0.001f * static_cast<float>(sr)));
                bs.dynReleaseCoeff = 1.0f - std::exp(-1.0f / (releaseMs * 0.001f * static_cast<float>(sr)));

                float thresh = P.band[b].dynThresh;
                float ratio  = P.band[b].dynRatio;
                ratio = std::max(ratio, 1.0f);

                // Recompute sidechain BPF from end-of-block smoothed freq/Q
                // (read before skip() advances — using current value is fine
                // since block-to-block drift is small and smoothers advance
                // again in the main coeff loop below).
                float scFreq = std::max(bs.freqSmooth.getCurrentValue(), 20.0f);
                float scQ    = std::max(bs.qSmooth.getCurrentValue(), 0.1f);
                computeSidechainBPF(bs, scFreq, scQ, sr);

                // Run sidechain BPF on input, compute RMS of detector output.
                // The detector follows the band's channel routing: a Left band
                // must not duck on Right-only content, and an M/S band detects
                // on its own M or S signal.
                double sumSq = 0.0;
                int    rmsCount = 0;

                if (bs.channel == static_cast<int>(ChannelMode::Stereo))
                {
                    for (int ch = 0; ch < numCh; ++ch)
                    {
                        const float* data = buffer.getReadPointer(ch);
                        const int slot = (ch == 0) ? kSlotL : kSlotR;
                        for (int s = 0; s < numSamples; ++s)
                        {
                            float x = data[s];
                            float y  = bs.sc_b0 * x + bs.sc_z1[slot];
                            bs.sc_z1[slot] = bs.sc_b1 * x - bs.sc_a1 * y + bs.sc_z2[slot];
                            bs.sc_z2[slot] = bs.sc_b2 * x - bs.sc_a2 * y;
                            sumSq += static_cast<double>(y * y);
                        }
                    }
                    rmsCount = numSamples * numCh;
                }
                else
                {
                    // Routed: one detector signal only (L, R, M or S).
                    // bs.channel is only non-Stereo when numCh >= 2 (see the
                    // per-block fold), so channel 1 is safe to read here.
                    float wL = 1.0f, wR = 0.0f;
                    int   slot = kSlotL;
                    routingDetectorWeights(bs.channel, wL, wR, slot);

                    const float* dL = buffer.getReadPointer(0);
                    const float* dR = buffer.getReadPointer(1);
                    for (int s = 0; s < numSamples; ++s)
                    {
                        float x = wL * dL[s] + wR * dR[s];
                        float y  = bs.sc_b0 * x + bs.sc_z1[slot];
                        bs.sc_z1[slot] = bs.sc_b1 * x - bs.sc_a1 * y + bs.sc_z2[slot];
                        bs.sc_z2[slot] = bs.sc_b2 * x - bs.sc_a2 * y;
                        sumSq += static_cast<double>(y * y);
                    }
                    rmsCount = numSamples;
                }

                float rmsDb = 10.0f * std::log10(std::max(
                    static_cast<float>(sumSq / std::max(rmsCount, 1)), 1e-30f));

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

                // Meter: signed dB the dynamic swing is currently contributing
                // on top of the baseline gain (the knob itself, always applied).
                float rangeDbNow = P.band[b].dynRange;
                bandGR_[b].store(newAct * rangeDbNow, std::memory_order_relaxed);

#ifdef XLETH_RT_TRACE
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

            // This block's parameter snapshot
            const auto& bp = P.band[b];
            float freq    = bp.freq;
            float gainDb  = bp.gain;
            float q       = bp.q;
            int   type    = static_cast<int>(bp.type);
            float rangeDb = bp.dynRange;

            // Advance smoothers to end-of-block position
            bs.freqSmooth.setTargetValue(std::max(freq, 20.0f));
            bs.gainSmooth.setTargetValue(gainDb);
            bs.qSmooth.setTargetValue(std::max(q, 0.1f));
            bs.rangeSmooth.setTargetValue(rangeDb);

            float smoothFreq  = bs.freqSmooth.skip(numSamples);
            float smoothGain  = bs.gainSmooth.skip(numSamples);
            float smoothQ     = bs.qSmooth.skip(numSamples);
            float smoothRange = bs.rangeSmooth.skip(numSamples);

            // Apply Dynamic EQ activation: the gain knob is a permanent
            // baseline, always applied. Range is how far the band swings
            // further from that baseline as activation grows toward 1 —
            // positive range boosts further on trigger, negative ducks.
            if (bs.mode == 1)
                smoothGain = smoothGain + bs.dynActivation.load(std::memory_order_relaxed) * smoothRange;

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
        if (!linPhaseActive)
        {
            bool hasSpectralBands = false;
            for (int b = 0; b < count; ++b)
            {
                if (bands_[b].mode != 2) continue;
                if (bands_[b].enabled)
                    hasSpectralBands = true;
                else
                    bandGR_[b].store(0.0f, std::memory_order_relaxed);  // don't strand the meter
            }

            // Auto-enable pre-EQ spectrum when any Spectral band is active.
            // Do NOT auto-disable; user may want pre-spectrum with other modes too.
            if (hasSpectralBands && !specPreEnabled_.load(std::memory_order_relaxed))
                specPreEnabled_.store(true, std::memory_order_release);

            if (hasSpectralBands)
            {
                // The stream only advances while Spectral is active, so after any
                // inactive block (band disabled, linear phase, ...) its rings and
                // counters still hold the previous spectral period. Rewind it on
                // the inactive -> active edge or that audio splices into the new
                // audio (docs/RESONANCE_SUPPRESSOR_AUDIT.md 3.3 #6). Allocation-free:
                // fills of preallocated buffers only. prepare/reset leave
                // stftNeedsRestart_ false, so transport start and seek are unchanged.
                if (stftNeedsRestart_)
                {
                    resetSTFTStream();
                    for (int b = 0; b < count; ++b)
                        if (bands_[b].mode == 2)
                            std::fill(bands_[b].specBinEnv.begin(),
                                      bands_[b].specBinEnv.end(), 1.0f);
                    stftNeedsRestart_ = false;
                    stftFadeIn_       = true;
                }

                // A restarted stream emits kSTFTLatency samples of silence and
                // then the input's first sample at full level: a step. Ramp
                // the first kStftFadeInMs of real output.
                const std::int64_t fadeLen = std::max<std::int64_t>(
                    1, static_cast<std::int64_t>(sr * kStftFadeInMs * 0.001));

                for (int s = 0; s < numSamples; ++s)
                {
                    const int inIdx =
                        static_cast<int>(stftSamplesWritten_ & kSTFTRingMask);
                    for (int ch = 0; ch < numCh; ++ch)
                        stftInRing_[ch][inIdx] = buffer.getSample(ch, s);
                    ++stftSamplesWritten_;

                    // Run every frame whose kSTFTSize-sample window just became
                    // complete. At 75% overlap this fires once per kSTFTHop.
                    while (stftNextFrameStart_ + kSTFTSize <= stftSamplesWritten_)
                    {
                        processSTFTFrame(stftNextFrameStart_, numCh, sr);
                        stftNextFrameStart_ += kSTFTHop;
                    }

                    float fadeGain = 1.0f;
                    if (stftFadeIn_)
                    {
                        const std::int64_t k = stftSamplesEmitted_ - kSTFTLatency;
                        if (k >= fadeLen)
                            stftFadeIn_ = false;
                        else if (k >= 0)
                            fadeGain = static_cast<float>(k + 1)
                                     / static_cast<float>(fadeLen);
                    }

                    const int outIdx =
                        static_cast<int>(stftSamplesEmitted_ & kSTFTRingMask);
                    for (int ch = 0; ch < numCh; ++ch)
                    {
                        buffer.setSample(ch, s, stftOutRing_[ch][outIdx] * fadeGain);
                        stftOutRing_[ch][outIdx] = 0.0f;
                    }
                    ++stftSamplesEmitted_;
                }
            }
            else
            {
                stftNeedsRestart_ = true;   // stream goes stale while inactive
            }
        }
        else
        {
            stftNeedsRestart_ = true;       // linear phase also freezes the stream
            for (int b = 0; b < count; ++b)
                if (bands_[b].mode == 2)
                    bandGR_[b].store(0.0f, std::memory_order_relaxed);
        }

        // ── Processing path ─────────────────────────────────────────────────

        if (linPhaseActive)
        {
            // ── Linear Phase FIR convolution (replaces biquad cascade) ──────
            if (firDirty_)
                rebuildFIR();

            if (currentOSFactor > 0)
            {
                // Oversampled FIR: upsample → FIR → downsample
                auto* os = (currentOSFactor == 1) ? os2x_.get() : os4x_.get();
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
        else if (currentOSFactor > 0 && numCh > 0)
        {
            // ── Oversampled biquad: upsample → cascade → downsample ─────────
            auto* os = (currentOSFactor == 1) ? os2x_.get() : os4x_.get();
            juce::dsp::AudioBlock<float> block(buffer);
            auto upBlock = os->processSamplesUp(block);

            // Sample-outer so an (L, R) pair can be carried through the cascade
            // together — per-band M/S routing needs both channels in hand.
            const int upN = static_cast<int>(upBlock.getNumSamples());
            float* upL = upBlock.getChannelPointer(0);
            float* upR = (numCh > 1) ? upBlock.getChannelPointer(1) : nullptr;
            const bool hasR = (upR != nullptr);

            for (int s = 0; s < upN; ++s)
            {
                float L = upL[s];
                float R = hasR ? upR[s] : 0.0f;

                processCascadeSample(count, L, R, hasR);

                upL[s] = L;
                if (hasR) upR[s] = R;
            }

            os->processSamplesDown(block);
        }
        else if (numCh > 0)
        {
            // ── Biquad processing (DFII Transposed) ─────────────────────────
            // Spectral-mode bands skip biquad — processed by STFT above.
            //
            // Sample-outer rather than channel-outer: per-band channel routing
            // (Mid/Side especially) needs the L and R samples of one frame in
            // hand at the same time.
            float* dataL = buffer.getWritePointer(0);
            float* dataR = (numCh > 1) ? buffer.getWritePointer(1) : nullptr;
            const bool hasR = (dataR != nullptr);

            for (int s = 0; s < numSamples; ++s)
            {
                float L = dataL[s];
                float R = hasR ? dataR[s] : 0.0f;

                processCascadeSample(count, L, R, hasR);

                dataL[s] = L;
                if (hasR) dataR[s] = R;
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

        // Also rewind the WOLA stream: without this a seek leaves up to
        // kSTFTSize of the previous position's audio in the rings, which
        // overlap-adds into the new position as a splice.
        resetSTFTStream();
        stftNeedsRestart_ = false;
        stftFadeIn_       = false;
        // The stream is pristine now; a pending un-bypass restart is redundant
        // (and would add a fade-in a plain reset does not have).
        pendingStreamReset_.store(false, std::memory_order_relaxed);
    }

private:
    // Called from setBypassed() on the RPC / applier thread, NOT the audio
    // thread, so it only raises a flag: the rings and per-bin envelopes are
    // audio-thread state and are rewound by processEffect (see
    // pendingStreamReset_). Only the un-bypass edge matters. While bypassed the
    // base class does not call processEffect (after the 5 ms crossfade), so the
    // stream freezes and goes stale; raising it on the bypass edge as well would
    // rewind the stream mid-crossfade and drop the wet side out of the fade.
    void onBypassChanged(bool bypassed) override
    {
        if (!bypassed)
            pendingStreamReset_.store(true, std::memory_order_release);
    }

    void onParameterValueChanged(const std::string& paramId, float /*value*/) override
    {
        if (isLatencyAffectingParameterId(paramId))
            refreshLatencySamples();
    }

    // ── Edits vs the audio thread's snapshot ────────────────────────────────
    // A multi-parameter edit (non-audio threads only). Writers are serialised
    // by editMutex_ (never taken by the audio thread); while the scope lives,
    // editSeq_ is odd, so a snapshot copy that overlaps it is rejected by the
    // audio thread (which keeps its previous snapshot for that block).
    // Sequence-lock memory orders (Boehm, "Can seqlocks get along with
    // programming language memory models?"): odd store relaxed + release fence
    // before the data stores, even store release after them; the reader loads
    // the counter with acquire, the data relaxed, then an acquire fence and the
    // counter again.
    struct EditScope
    {
        explicit EditScope(XlethParametricEQ& e) : eq(e), lock(e.editMutex_)
        {
            eq.editSeq_.store(eq.editSeq_.load(std::memory_order_relaxed) + 1u, std::memory_order_relaxed);
            std::atomic_thread_fence(std::memory_order_release);
        }
        ~EditScope()
        {
            eq.editSeq_.store(eq.editSeq_.load(std::memory_order_relaxed) + 1u, std::memory_order_release);
        }
        EditScope(const EditScope&) = delete;
        EditScope& operator=(const EditScope&) = delete;
        XlethParametricEQ& eq;
        std::lock_guard<std::mutex> lock;
    };

    // Inside an EditScope: the band's DSP state (biquad / detector state,
    // spectral envelopes) is cleared by the AUDIO thread, together with the
    // first snapshot that contains this edit. The activation meter is an
    // atomic the UI reads, so it is zeroed here as well (as the old in-place
    // clear did); the audio thread zeroes it again when it clears.
    void requestBandClear(int band) noexcept
    {
        if (band < 0 || band >= kMaxBands) return;
        bands_[band].dynActivation.store(0.0f, std::memory_order_relaxed);
        pendingBandClear_.fetch_or(1u << band, std::memory_order_relaxed);
    }

    // Reads every parameter processEffect uses (relaxed atomic loads only).
    void readParamsInto(ParamSnapshot& s) const noexcept
    {
        s.count = std::clamp(bandCount_.load(std::memory_order_relaxed), 0, kMaxBands);
        s.linPhase   = linPhasePtr_   ? linPhasePtr_->load(std::memory_order_relaxed)   : 0.0f;
        s.oversample = oversamplePtr_ ? oversamplePtr_->load(std::memory_order_relaxed) : 0.0f;
        for (int b = 0; b < s.count; ++b)
        {
            const auto& bs = bands_[b];
            auto& o = s.band[b];
            auto rd = [](const std::atomic<float>* p, float fallback) noexcept {
                return p ? p->load(std::memory_order_relaxed) : fallback;
            };
            o.freq        = rd(bs.freqPtr, 1000.0f);
            o.gain        = rd(bs.gainPtr, 0.0f);
            o.q           = rd(bs.qPtr, 0.707f);
            o.type        = rd(bs.typePtr, 0.0f);
            o.enabled     = rd(bs.enabledPtr, 1.0f);
            o.channel     = rd(bs.channelPtr, 0.0f);
            o.mode        = rd(bs.modePtr, 0.0f);
            o.dynThresh   = rd(bs.dynThreshPtr, -20.0f);
            o.dynRatio    = rd(bs.dynRatioPtr, 4.0f);
            o.dynAttack   = rd(bs.dynAttackPtr, 10.0f);
            o.dynRelease  = rd(bs.dynReleasePtr, 100.0f);
            o.dynRange    = rd(bs.dynRangePtr, 12.0f);
            o.specSens    = rd(bs.specSensPtr, 0.5f);
            o.specSel     = rd(bs.specSelPtr, 5.0f);
            o.specAttack  = rd(bs.specAttackPtr, 10.0f);
            o.specRelease = rd(bs.specReleasePtr, 100.0f);
        }
    }

    // Audio thread, once at the top of processEffect. Wait-free: one copy of
    // the parameters, accepted only if no edit overlapped it; otherwise the
    // previous block's snapshot stays in force for this block. The band clears
    // requested inside an edit are applied with the first snapshot that
    // contains that edit. No allocation, no lock, no logging.
    void takeParamSnapshot() noexcept
    {
        const std::uint32_t s1 = editSeq_.load(std::memory_order_acquire);
        bool accepted = false;
        if ((s1 & 1u) == 0u || !snapshotSeqCheck_)
        {
            readParamsInto(snapWork_);
            if (pendingBandClear_.load(std::memory_order_relaxed) != 0u)
                deferredBandClear_ |= pendingBandClear_.exchange(0u, std::memory_order_acq_rel);
            std::atomic_thread_fence(std::memory_order_acquire);
            accepted = !snapshotSeqCheck_ || editSeq_.load(std::memory_order_relaxed) == s1;
        }

        if (!accepted)
        {
            ++snapshotsKept_;
            return;
        }

        snap_ = snapWork_;
        ++snapshotsAccepted_;
        if (deferredBandClear_ != 0u)
        {
            for (int b = 0; b < kMaxBands; ++b)
                if ((deferredBandClear_ & (1u << b)) != 0u)
                    bands_[b].clearState();
            deferredBandClear_ = 0u;
        }
    }

    // ── Per-band state ───────────────────────────────────────────────────────
    struct BandState
    {
        // APVTS raw pointers (resolved in prepareEffect)
        std::atomic<float>* freqPtr    = nullptr;
        std::atomic<float>* gainPtr    = nullptr;
        std::atomic<float>* qPtr       = nullptr;
        std::atomic<float>* typePtr    = nullptr;
        std::atomic<float>* enabledPtr = nullptr;
        std::atomic<float>* channelPtr = nullptr;

        // Smoothers (audio thread only)
        juce::SmoothedValue<float, juce::ValueSmoothingTypes::Multiplicative> freqSmooth;
        juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>         gainSmooth;
        juce::SmoothedValue<float, juce::ValueSmoothingTypes::Multiplicative> qSmooth;
        juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>         rangeSmooth;

        // Current biquad coefficients (normalised: a0 = 1)
        float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f;
        float a1 = 0.0f, a2 = 0.0f;

        // DFII Transposed state, one slot per routable signal:
        //   0 = L, 1 = R, 2 = M, 3 = S.
        // A band only ever runs in one routing at a time, but keeping all four
        // slots means switching routing mid-stream never drags foreign state in.
        float z1[kNumRoutingSlots]{}, z2[kNumRoutingSlots]{};

        bool enabled = true;

        // Channel routing, latched once per block (see ChannelMode).
        int channel = 0;

        // ── Mode (0=Normal, 1=Dynamic, 2=Spectral) ─────────────────────────
        std::atomic<float>* modePtr = nullptr;
        int mode = 0;

        // ── Dynamic EQ APVTS pointers ───────────────────────────────────────
        std::atomic<float>* dynThreshPtr  = nullptr;
        std::atomic<float>* dynRatioPtr   = nullptr;
        std::atomic<float>* dynAttackPtr  = nullptr;
        std::atomic<float>* dynReleasePtr = nullptr;
        std::atomic<float>* dynRangePtr   = nullptr;

        // Dedicated sidechain BPF coefficients (constant-skirt, peak 0 dB).
        // Recomputed once per block from smoothed freq/Q; independent of band gain.
        float sc_b0 = 1.0f, sc_b1 = 0.0f, sc_b2 = 0.0f;
        float sc_a1 = 0.0f, sc_a2 = 0.0f;

        // Dynamic EQ runtime state (audio thread)
        // Same slot layout as z1/z2: the detector follows the band's routing.
        float sc_z1[kNumRoutingSlots]{}, sc_z2[kNumRoutingSlots]{};
        std::atomic<float> dynActivation{0.0f}; // activation [0,1]: 0 = band off, 1 = at target
        float dynAttackCoeff = 0.0f;     // one-pole attack coefficient
        float dynReleaseCoeff = 0.0f;    // one-pole release coefficient
#ifdef XLETH_RT_TRACE
        int dynLogCounter = 0;
        int specLogCounter = 0;
#endif

        // ── Spectral Dynamics APVTS pointers ────────────────────────────────
        // Spectral depth is NOT its own parameter: the band's gain knob is the
        // signed depth in dB (see processSTFTFrame).
        std::atomic<float>* specSensPtr    = nullptr;
        std::atomic<float>* specSelPtr     = nullptr;
        std::atomic<float>* specAttackPtr  = nullptr;
        std::atomic<float>* specReleasePtr = nullptr;

        // Per-bin spectral reduction envelope, smoothed across STFT frames.
        // Value in [0, 1+]: 1 = no change, <1 = attenuation, >1 = boost
        // (upward spectral). Sized kSTFTSize/2 in prepareEffect.
        std::vector<float> specBinEnv;

        // Per-bin bell influence weight in [0, 1]: 1 at the band centre,
        // falling off with the band's own Q so the suppression profile has the
        // shape getResponseCurve draws. Sized kSTFTSize/2 in prepareEffect,
        // rebuilt only when the cached freq/Q/|depth| below move materially.
        std::vector<float> specBinWeight;
        float specWeightFreq  = -1.0f;   // < 0 = never built
        float specWeightQ     = 0.0f;
        float specWeightDepth = 0.0f;

        void clearState()
        {
            for (int i = 0; i < kNumRoutingSlots; ++i)
            {
                z1[i] = z2[i] = 0.0f;
                sc_z1[i] = sc_z2[i] = 0.0f;
            }
            dynActivation.store(0.0f, std::memory_order_relaxed);
            std::fill(specBinEnv.begin(), specBinEnv.end(), 1.0f);
            specWeightFreq = -1.0f;   // force a weight rebuild
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
    std::atomic<bool> linPhaseActive_{false};
    std::atomic<int> currentOSFactor_{0};  // 0=off, 1=2x, 2=4x
    std::atomic<std::uint64_t> processBlockLatencyUpdateCount_{0};
    std::atomic<std::uint64_t> nonRealtimeLatencyUpdateCount_{0};

    // ── STFT state (Spectral Dynamics) ──────────────────────────────────────
    std::vector<float> stftInRing_[2];
    std::vector<float> stftOutRing_[2];

    // Absolute sample counters (WOLA scheduling, mirrors SpectralChannelState).
    // Both channels advance in lockstep, so one set covers the pair.
    std::int64_t stftSamplesWritten_ = 0;   // inputs accepted
    std::int64_t stftSamplesEmitted_ = 0;   // outputs handed back
    std::int64_t stftNextFrameStart_ = 0;   // start of the next frame to run

    // Audio thread only. stftNeedsRestart_: a block has run with the STFT path
    // inactive since the last prepare/reset, so the rings are stale and the next
    // active block must rewind them. stftFadeIn_: ramp the first real output of
    // a restarted stream (see processEffect).
    bool stftNeedsRestart_ = false;
    bool stftFadeIn_       = false;

    // Set by onBypassChanged(false) (non-audio thread), consumed with an
    // exchange at the top of processEffect, which folds it into
    // stftNeedsRestart_ so the SAME rewind + envelope reset + fade-in runs.
    // A bypassed effect never reaches processEffect, so the "inactive last
    // block" edge detection cannot see a bypass.
    std::atomic<bool> pendingStreamReset_{false};

    // ── Parameter snapshot / edits ([EQCore] locking fix) ───────────────────
    std::mutex editMutex_;                        // edit writers only (never the audio thread)
    std::atomic<std::uint32_t> editSeq_{0};       // odd while an edit runs
    std::atomic<std::uint32_t> pendingBandClear_{0};   // bit b: clear band b's DSP state
    ParamSnapshot snap_;                          // audio thread: the block's parameters
    ParamSnapshot snapWork_;                      // audio thread: copy in progress
    std::uint32_t deferredBandClear_ = 0;         // audio thread: clears waiting for an accepted snapshot
    std::uint64_t snapshotsAccepted_ = 0;         // audio thread (tests)
    std::uint64_t snapshotsKept_ = 0;             // audio thread (tests)
    bool snapshotSeqCheck_ = true;                // tests: negative control switch


    float stftWindow_[kSTFTSize]{};         // sqrt-Hann (analysis AND synthesis)
    float stftNorm_[kSTFTHop]{};            // 1/sum(w^2) per hop phase
    std::atomic<bool> hasSpectralBands_{false};
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

    // Per-bin e^-jw / e^-j2w tables. Bin frequencies are fixed (w = 2*pi*i/N),
    // so updateSpectralWeights can evaluate a biquad's |H| per bin without
    // running any trig on the audio thread. Sized kSTFTSize/2 in prepareEffect.
    std::vector<float> stftBinCosW_;
    std::vector<float> stftBinSinW_;
    std::vector<float> stftBinCos2W_;
    std::vector<float> stftBinSin2W_;

    // ── Channel routing helpers ─────────────────────────────────────────────

    // Collapse a band's requested routing to what the current context can
    // actually honour.  Everything that cannot be routed folds to Stereo:
    //
    //  • Mono input (numCh < 2) — there is no second channel to route against.
    //  • Spectral-mode bands (mode == 2) — routing is deliberately NOT
    //    implemented for these.  M/S spectral processing needs the STFT itself
    //    run in the M/S domain (a second analysis/synthesis pair plus M/S
    //    per-bin envelopes), which is a separate unit of work.
    //  • Linear Phase — deliberately NOT implemented.  Per-channel linear phase
    //    needs a 2x2 MIMO FIR matrix (four kernels, cross terms included)
    //    instead of the single shared zero-phase kernel rebuildFIR() produces.
    //    Also a separate unit of work.
    static int foldChannelForContext(int channel, int mode, bool linPhaseActive, int numCh)
    {
        if (numCh < 2)      return static_cast<int>(ChannelMode::Stereo);
        if (mode == 2)      return static_cast<int>(ChannelMode::Stereo);
        if (linPhaseActive) return static_cast<int>(ChannelMode::Stereo);
        return channel;
    }

    // One DFII-Transposed biquad step on slot `slot` of the band's state.
    static inline float biquadTick(BandState& bs, int slot, float x)
    {
        const float y  = bs.b0 * x + bs.z1[slot];
        bs.z1[slot] = bs.b1 * x - bs.a1 * y + bs.z2[slot];
        bs.z2[slot] = bs.b2 * x - bs.a2 * y;
        return y;
    }

    // Run one sample of the whole band cascade over an (L, R) pair, honouring
    // each band's channel routing.  `hasR` is false for mono input, in which
    // case every band behaves as Stereo and only L is touched.
    //
    // Audio thread; no allocation, no locks, no logging.
    inline void processCascadeSample(int count, float& L, float& R, bool hasR)
    {
        for (int b = 0; b < count; ++b)
        {
            auto& bs = bands_[b];
            if (!bs.enabled || bs.mode == 2) continue;  // Spectral handled by STFT

            switch (static_cast<ChannelMode>(bs.channel))
            {
            case ChannelMode::Left:
                L = biquadTick(bs, kSlotL, L);
                break;

            case ChannelMode::Right:
                R = biquadTick(bs, kSlotR, R);
                break;

            case ChannelMode::Mid:
            {
                const float m = 0.5f * (L + R);
                const float s = 0.5f * (L - R);
                const float mf = biquadTick(bs, kSlotM, m);
                L = mf + s;
                R = mf - s;
                break;
            }

            case ChannelMode::Side:
            {
                const float m = 0.5f * (L + R);
                const float s = 0.5f * (L - R);
                const float sf = biquadTick(bs, kSlotS, s);
                L = m + sf;
                R = m - sf;
                break;
            }

            case ChannelMode::Stereo:
            default:
                L = biquadTick(bs, kSlotL, L);
                if (hasR) R = biquadTick(bs, kSlotR, R);
                break;
            }
        }
    }

    // Detector input mix for a routed Dynamic band: x = wL*L + wR*R.
    // Stereo is handled separately (it sums both channels' detector energy).
    static void routingDetectorWeights(int channel, float& wL, float& wR, int& slot)
    {
        switch (static_cast<ChannelMode>(channel))
        {
        case ChannelMode::Left:  wL = 1.0f; wR =  0.0f; slot = kSlotL; break;
        case ChannelMode::Right: wL = 0.0f; wR =  1.0f; slot = kSlotR; break;
        case ChannelMode::Mid:   wL = 0.5f; wR =  0.5f; slot = kSlotM; break;
        case ChannelMode::Side:  wL = 0.5f; wR = -0.5f; slot = kSlotS; break;
        default:                 wL = 1.0f; wR =  0.0f; slot = kSlotL; break;
        }
    }

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

    // ── STFT stream reset ──────────────────────────────────────────────────

    // Rewind the WOLA stream. nextFrameStart starts kSTFTSize-kSTFTHop *before*
    // zero so frames begin firing from the first hop and ramp in through the
    // window overlap instead of stepping in at full amplitude; the out-of-range
    // reads that implies return silence.
    void resetSTFTStream()
    {
        stftSamplesWritten_ = 0;
        stftSamplesEmitted_ = 0;
        stftNextFrameStart_ = -static_cast<std::int64_t>(kSTFTSize)
                            +  static_cast<std::int64_t>(kSTFTHop);
        for (int ch = 0; ch < 2; ++ch)
        {
            std::fill(stftInRing_[ch].begin(),  stftInRing_[ch].end(),  0.0f);
            std::fill(stftOutRing_[ch].begin(), stftOutRing_[ch].end(), 0.0f);
        }
    }

    // ── Spectral bell influence weight (audio thread, cached) ──────────────

    // Rebuild a spectral band's per-bin influence weight: the RBJ bell the
    // band would have at |depthDb| dB with its own Q, evaluated at every STFT
    // bin and normalised to 1.0 at the peak (the band centre).  This replaces
    // the old rectangular freq ± freq/Q gate, so the Q knob now shapes the
    // suppression profile exactly the way getResponseCurve draws it.
    //
    // The shape is always a Bell regardless of the band's type: Spectral mode
    // exists to tame resonances, and a LowPass/HighPass has no gain peak to
    // normalise against.
    //
    // Cached on smoothed freq/Q/|depth|, so a parked band costs nothing per
    // frame and a knob sweep costs one pass of pure arithmetic (bin trig is
    // precomputed in prepareEffect).
    void updateSpectralWeights(BandState& bs, float freq, float q,
                               float depthDb, double sr)
    {
        const int   binsN    = kSTFTSize / 2;
        const float absDepth = std::abs(depthDb);

        // Clamp before comparing, or a sub-20 Hz smoother ramp would never
        // match the clamped cache and would rebuild on every frame.
        const float useFreq = std::max(freq, 20.0f);
        const float useQ    = std::max(q, 0.1f);

        const bool fresh = (bs.specWeightFreq < 0.0f);
        if (!fresh
            && std::abs(useFreq - bs.specWeightFreq) <= bs.specWeightFreq * 0.001f
            && std::abs(useQ - bs.specWeightQ) <= 0.001f
            && std::abs(absDepth - bs.specWeightDepth) <= 0.01f)
            return;

        bs.specWeightFreq  = useFreq;
        bs.specWeightQ     = useQ;
        bs.specWeightDepth = absDepth;

        // An RBJ bell's dB profile depends only weakly on its gain, but
        // normalising by a near-zero peak is unstable — so the shape is always
        // computed at >= 1 dB.  At depth 0 every bin's target is 0 dB anyway,
        // which makes the shape irrelevant there.
        const float shapeDb = std::max(absDepth, 1.0f);

        // Allocation-free: every vector inside a default-constructed BandState
        // is empty, and computeCoefficients only writes the scalar coeffs.
        BandState tmp;
        computeCoefficients(tmp, BandType::Bell, bs.specWeightFreq, shapeDb,
                            bs.specWeightQ, sr);

        float peakDb = -1.0e9f;
        for (int i = 0; i < binsN; ++i)
        {
            const float cw = stftBinCosW_[i],  sw = stftBinSinW_[i];
            const float c2 = stftBinCos2W_[i], s2 = stftBinSin2W_[i];

            // H(e^jw) = (b0 + b1 e^-jw + b2 e^-j2w) / (1 + a1 e^-jw + a2 e^-j2w)
            const float nRe = tmp.b0 + tmp.b1 * cw + tmp.b2 * c2;
            const float nIm =        - tmp.b1 * sw - tmp.b2 * s2;
            const float dRe = 1.0f   + tmp.a1 * cw + tmp.a2 * c2;
            const float dIm =        - tmp.a1 * sw - tmp.a2 * s2;

            const float dMagSq = dRe * dRe + dIm * dIm;
            const float magSq  = (dMagSq > 1e-30f)
                ? (nRe * nRe + nIm * nIm) / dMagSq : 1.0f;

            const float magDb = 10.0f * std::log10(std::max(magSq, 1e-30f));
            bs.specBinWeight[i] = magDb;
            if (magDb > peakDb) peakDb = magDb;
        }

        const float invPeak = (peakDb > 1.0e-3f) ? (1.0f / peakDb) : 0.0f;
        for (int i = 0; i < binsN; ++i)
            bs.specBinWeight[i] = std::max(0.0f, bs.specBinWeight[i] * invPeak);
    }

    // ── STFT frame processing (Spectral Dynamics) ───────────────────────────

    void processSTFTFrame(std::int64_t frameStart, int numCh, double sr)
    {
        const int count = snap_.count;   // this block's snapshot (audio thread)
        const int binsN = kSTFTSize / 2;

        // Envelope coefficients derived from STFT frame period (hopSize / sr),
        // not per-sample period, because the envelope updates once per frame.
        const float framePeriodSec = static_cast<float>(kSTFTHop) / static_cast<float>(sr);

        for (int ch = 0; ch < numCh; ++ch)
        {
            // Read this frame's kSTFTSize samples, apply the sqrt-Hann
            // analysis window. Positions outside the accepted stream (the
            // startup ramp) read as silence.
            std::fill(stftTempRe_.begin(), stftTempRe_.end(), 0.0f);
            std::fill(stftTempIm_.begin(), stftTempIm_.end(), 0.0f);

            for (int i = 0; i < kSTFTSize; ++i)
            {
                const std::int64_t src = frameStart + i;
                const float x = (src >= 0 && src < stftSamplesWritten_)
                    ? stftInRing_[ch][static_cast<int>(src & kSTFTRingMask)]
                    : 0.0f;
                stftTempRe_[i] = x * stftWindow_[i];
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
                if (static_cast<int>(bs.specBinWeight.size()) < binsN) continue;
                // Spectral bands ignore channel routing (folded to Stereo by
                // foldChannelForContext): the same per-bin envelope is applied
                // to both channels. M/S spectral would need the STFT itself run
                // in the M/S domain — out of scope here.

                float bandFreq = bs.freqSmooth.getCurrentValue();
                float bandQ    = bs.qSmooth.getCurrentValue();

                // The band's GAIN knob IS the spectral depth, signed in dB:
                // negative suppresses detected resonances, positive boosts
                // them, 0 leaves the band inert.  Spectral bands skip the
                // biquad cascade entirely (see its `mode == 2` skip), so the
                // gain knob has no other meaning in this mode — hence no
                // separate spec_depth parameter.
                float depthDb = bs.gainSmooth.getCurrentValue();
                float sens  = snap_.band[b].specSens;
                float sel   = snap_.band[b].specSel;
                float atkMs = snap_.band[b].specAttack;
                float relMs = snap_.band[b].specRelease;

                const float attackCoeff  = 1.0f - std::exp(-framePeriodSec / (atkMs * 0.001f));
                const float releaseCoeff = 1.0f - std::exp(-framePeriodSec / (relMs * 0.001f));

                // Envelope update only on ch=0 to preserve per-frame semantics.
                if (ch == 0)
                {
                    // Influence zone: the band's own bell, per bin, normalised
                    // to 1 at the centre.  Cached, so this only does real work
                    // when the smoothed freq/Q/depth have moved materially.
                    updateSpectralWeights(bs, bandFreq, bandQ, depthDb, sr);

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

                        const float w = bs.specBinWeight[i];

                        float target = 1.0f;
                        if (w > 1.0e-4f && runCnt > 0)
                        {
                            const float localLog = runSum / static_cast<float>(runCnt);
                            const float localEnv = std::exp(localLog);
                            const float thresh   = localEnv * (1.0f + sens * sel);
                            if (thresh > 1.0e-20f && stftMag_[i] > thresh)
                            {
                                // Proportional detection: how far this bin
                                // protrudes above its local threshold, through
                                // a kSpecKneeDb soft knee.  A bin 1 dB over
                                // gets a sixth of the knob, one 6 dB or more
                                // over gets all of it — no hard gate.
                                const float overDb =
                                    20.0f * std::log10(stftMag_[i] / thresh);
                                const float knee = std::min(
                                    overDb * (1.0f / kSpecKneeDb), 1.0f);
                                const float targetDb = depthDb * w * knee;
                                target = std::pow(10.0f, targetDb * 0.05f);
                            }
                        }
                        // Outside the bell / below threshold: relax toward 1.0.

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

                    // Signed per-band GR for the UI's eqGetBandGR poll (negative
                    // = suppression, positive = upward boost).  Computed in the
                    // loop above unconditionally — it is only a compare.
                    bandGR_[b].store(maxReductionDb, std::memory_order_relaxed);

#ifdef XLETH_RT_TRACE
                    bs.specLogCounter += kSTFTHop;
                    if (bs.specLogCounter >= static_cast<int>(sr))
                    {
                        bs.specLogCounter = 0;
                        std::fprintf(stderr, "[EQ-Spec] band=%d activeBins=%d maxRed=%.1fdB\n",
                                     b, activeBins, maxReductionDb);
                    }
#else
                    (void)activeBins;
#endif
                }

                // Apply the smoothed per-bin envelope to this channel's
                // spectrum.  The bell weight has no hard edge, so every bin is
                // swept; untouched bins sit at exactly 1.0 and stay bit-exact.
                for (int i = 1; i < binsN; ++i)
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

            // Weighted overlap-add: sqrt-Hann synthesis window + per-phase
            // 1/sum(w^2), written kSTFTLatency ahead of the frame start so
            // every output sample has all four overlapping frames before it is
            // read. Slots already handed back are skipped (startup only).
            const std::int64_t outStart = frameStart + kSTFTLatency;
            int phase = 0;
            for (int i = 0; i < kSTFTSize; ++i)
            {
                const std::int64_t dst = outStart + i;
                if (dst >= stftSamplesEmitted_)
                    stftOutRing_[ch][static_cast<int>(dst & kSTFTRingMask)] +=
                        stftTempRe_[i] * stftWindow_[i] * stftNorm_[phase];
                if (++phase == kSTFTHop) phase = 0;
            }
        }
    }

    // ── FIR rebuild (Linear Phase) ─────────────────────────────────────────

    void rebuildFIR()
    {
        const int N = firLength_;
        const int count = snap_.count;   // audio thread: this block's snapshot
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
                // All bands included as Normal (Dynamic/Spectral folded in).
                // Channel routing is also folded to Stereo here: one shared
                // zero-phase kernel is applied to both channels. Per-channel
                // linear phase would need a 2x2 MIMO FIR matrix — out of scope,
                // see foldChannelForContext().
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

    float readGlobalParam(const char* paramId, float fallback) const
    {
        auto* raw = apvts_.getRawParameterValue(paramId);
        return raw ? raw->load(std::memory_order_relaxed) : fallback;
    }

    void refreshLatencyStateFromParameters()
    {
        const bool linPhase = readGlobalParam("linphase", 0.0f) > 0.5f;
        const int osRaw = std::clamp(
            static_cast<int>(std::lround(readGlobalParam("oversample", 0.0f))),
            0, 2);

        bool anySpectral = false;
        const int count = bandCount_.load(std::memory_order_relaxed);
        if (!linPhase)
        {
            for (int b = 0; b < count; ++b)
            {
                const bool enabled = readParam(b, "enabled") > 0.5f;
                const int mode = static_cast<int>(std::lround(readParam(b, "mode")));
                if (enabled && mode == 2)
                {
                    anySpectral = true;
                    break;
                }
            }
        }

        linPhaseActive_.store(linPhase, std::memory_order_relaxed);
        hasSpectralBands_.store(anySpectral, std::memory_order_relaxed);
        currentOSFactor_.store(anySpectral ? 0 : osRaw, std::memory_order_relaxed);
    }

    static bool isLatencyAffectingBandParam(const std::string& name)
    {
        return name == "enabled" || name == "mode";
    }

    static bool isLatencyAffectingParameterId(const std::string& paramId)
    {
        return paramId == "linphase"
            || paramId == "oversample"
            || paramId.find("_enabled") != std::string::npos
            || paramId.find("_mode") != std::string::npos;
    }

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
            "channel",
            "mode", "dyn_thresh", "dyn_ratio", "dyn_attack", "dyn_release", "dyn_range",
            "spec_sens", "spec_sel",
            "spec_attack", "spec_release" };
        for (const char* n : names)
            setParamDirect(dstBand, n, readParam(srcBand, n));
    }

    // ── APVTS parameter layout factory ───────────────────────────────────────

    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        std::vector<std::unique_ptr<juce::RangedAudioParameter>> params;
        params.reserve(kMaxBands * 16 + 2);

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

            // Per-band channel routing. Default 0 (= Stereo) is what every
            // pre-routing project save restores to, so old saves keep their
            // original full-stereo behaviour.
            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "channel", 1 },
                label + "Channel",
                // 0=Stereo, 1=Left, 2=Right, 3=Mid, 4=Side
                juce::NormalisableRange<float>(0.0f, 4.0f, 1.0f),
                0.0f));

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

            // Signed: how far the band swings from its baseline gain (above)
            // as activation grows toward 1. Positive boosts further on
            // trigger, negative ducks — independent of the baseline's sign.
            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "dyn_range", 1 },
                label + "Dyn Range",
                juce::NormalisableRange<float>(-30.0f, 30.0f),
                12.0f,
                juce::AudioParameterFloatAttributes().withLabel("dB")));

            params.push_back(std::make_unique<juce::AudioParameterFloat>(
                juce::ParameterID{ prefix + "spec_sens", 1 },
                label + "Spec Sens",
                juce::NormalisableRange<float>(0.0f, 1.0f),
                0.5f));

            // No spec_depth: a Spectral band's depth is its own gain knob
            // (signed, +-30 dB, see processSTFTFrame).
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
