#pragma once

#include "audio/ApexDsp.h"
#include "audio/ApexVizAccumulator.h"
#include "audio/XlethEffectBase.h"
#include "audio/viz/DynamicsVizCollector.h"
#include "audio/viz/DynamicsVizFrame.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

// ─── XlethApexEffect ─────────────────────────────────────────────────────────
//
// APEX — XLETH's native multiband maximizer.  Three user-definable bands
// (LOW / MID / HIGH) plus a wideband MASTER stage, each a full dynamics
// processor driven by a node-based curve, followed by saturation, gain staging
// and stereo separation.
//
// pluginId: "apex"
//
// ── Signal flow (design spec section 3) ─────────────────────────────────────
//
//   Input
//     └─ LOW CUT (24 dB/oct HPF, 0–100 Hz, 0 = bypassed bit-transparently)
//          └─ Linkwitz-Riley crossover, LR2 or LR4 selectable PER SPLIT
//             ├─ LOW  ┐
//             ├─ MID  ├─ PRE GAIN → LOOKAHEAD → envelope → curve LUT
//             └─ HIGH ┘  → SAT (2× oversampled) → POST GAIN → STEREO SEP
//          └─ Σ bands ⇄ dry input (same shared delay) via BAND MIX
//               └─ MASTER stage (identical chain, wideband, no lookahead)
//                    └─ Output
//
// ── Lookahead / latency ──────────────────────────────────────────────────────
//
// The engine already has full plugin delay compensation: AudioGraph::computePDC()
// walks the graph in topological order, sums AudioProcessor::getLatencySamples()
// per node and inserts DelayCompensationProcessor on the shorter wires.
// AudioGraph::setEffectParameter / setEffectProgram / setEffectStateInformation /
// setBypass each snapshot getLatencySamples() before and after and call
// rebuildImmediate() when it changed.  APEX therefore needs NO new mechanism —
// it publishes latency through setLatencySamples() exactly like
// XlethLimiterEffect does, and only ever from the main thread (prepare, a
// parameter change, or a state restore).  processEffect() never republishes, so
// the graph is never re-planned from the audio thread.
//
// Reported latency = LOOKAHEAD
//                  + (any of LOW/MID/HIGH saturating ? 47 : 0)
//                  + (MASTER saturating              ? 47 : 0)
//
// The 47 is the exact, integer round-trip latency of the 2× polyphase half-band
// oversampler (see ApexDsp.h).  It is included for the WHOLE band stage as soon
// as ANY of the three bands saturates: the bands that are not saturating are put
// through FixedDelay(47) instead, so no band can ever drift relative to another,
// and the BAND MIX dry leg gets the same treatment.  Because the decision is
// derived only from the saturation amounts (never from band STATE or SOLO),
// muting/soloing/bypassing a band never re-plans the graph.
//
// Main thread and audio thread never compute this independently: updateLatency()
// publishes satStageMask_ and lookaheadSamplesPub_, and the audio thread reads
// ONLY those, so the delay it actually applies always matches the latency the
// PDC planner was told about.
//
// ── True lookahead (documented deviation) ────────────────────────────────────
//
// The chain order in the spec lists "LOOKAHEAD delay → envelope detect".  Read
// literally — detector fed from the DELAYED signal — the knob would be a pure
// latency control with no sonic effect whatsoever, since delaying the audio and
// its own detector by the same amount is indistinguishable from delaying
// neither.  APEX therefore taps the detector at the ring's WRITE point (the
// undelayed, post-PRE-GAIN signal) and applies the resulting gain to the DELAYED
// audio, which is what "lookahead" means everywhere else in audio: the gain
// change lands before the transient it was computed from.  The series signal
// path still follows the specified order exactly; only the detector side-chain
// (which is not a series stage) is tapped early.
//
// ── Audio-thread rules ───────────────────────────────────────────────────────
//
// No allocation, no locks, no logging.  Every buffer is sized in prepareEffect().
// Parameters are read from the APVTS atomics once per block and interpolated
// with per-block linear ramps (BlockRamp) so the dB → linear conversion happens
// at block rate, never per sample.  The dynamics curve reaches the audio thread
// only as a finished LUT, published by atomic index swap.
//
// ── Meter slots ──────────────────────────────────────────────────────────────
//   0 = output L peak          4 = HIGH   band gain reduction (dB, positive)
//   1 = output R peak          5 = MASTER band gain reduction (dB, positive)
//   2 = LOW  band GR (dB)      6 = input peak (post LOW CUT)
//   3 = MID  band GR (dB)      7 = band-sum peak (pre BAND MIX)

class XlethApexEffect : public XlethEffectBase
{
public:
    using CurveNode = xleth_apex::CurveNode;
    using BandState = xleth_apex::BandState;

    static constexpr int kNumBands = xleth_apex::kNumBands;   // low, mid, high, master
    static constexpr int kNumSplitBands = 3;                  // low, mid, high

    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout();

    XlethApexEffect();

    // ── AudioProcessor / XlethEffectBase overrides ──────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override;
    void releaseEffect() override;
    void resetEffect() override;
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;
    void setStateInformation(const void* data, int sizeInBytes) override;
    void onParameterValueChanged(const std::string& paramId, float value) override;

    // ── Curve API (MAIN THREAD ONLY) ────────────────────────────────────────
    //
    // The dynamics curve is structured data, so it cannot travel through the
    // scalar APVTS parameter API.  It is exposed here as a subclass-specific
    // API — the same door EffectChainManager::getEffect() already documents for
    // XlethEQEffect — and it persists through the ordinary stock-FX state path
    // (an APEX_CURVES child of the APVTS ValueTree), so UndoManager and project
    // save/load work unchanged with no new plumbing.
    //
    // `band` is 0=LOW, 1=MID, 2=HIGH, 3=MASTER.  Nodes are clamped to the
    // -24…+12 dB box, sorted by IN, de-duplicated and capped at 32; fewer than
    // two surviving nodes resets the band to unity.  `tensions` holds one value
    // per segment (nodes.size() - 1); a short array is zero-filled.
    bool setBandCurve(int band,
                      const std::vector<CurveNode>& nodes,
                      const std::vector<float>&     tensions);

    // JSON form: {"nodes":[{"in":-24,"out":-24}, …],"tensions":[0, …]}
    std::string getBandCurveJSON(int band) const;
    bool        setBandCurveJSON(int band, const std::string& json);

    // Reset a band's curve to unity (flat, two pinned end nodes).
    bool resetBandCurve(int band);

    // JSON form for ALL bands at once, so an editor opening only pays one
    // bridge round trip instead of four:
    //   {"bands":[{"band":0,"nodes":[…],"tensions":[…]}, …]}
    std::string getAllCurvesJSON() const;

    // ── Visualization (metering) ────────────────────────────────────────────
    //
    // APEX reuses the shared dynamics-viz pipeline (engine ring → N-API
    // ArrayBuffer → renderer DataView) rather than adding a second mechanism.
    // What differs is the CADENCE: the ApexBucket carries a 2048-point FFT
    // spectrum, so it is emitted at kApexVizBucketSize (1024 samples ≈ 43 Hz)
    // instead of the shared 64-sample rate — see DynamicsVizFrame.h. The ring
    // is allocated on the first enable and published to the audio thread by a
    // single atomic; while disabled, processEffect() pays one acquire-load.
    void          setVisualizationEnabled(bool enabled) override;
    std::uint32_t getVisualizationType() const override
        { return xleth::viz::kVizTypeApex; }
    std::uint32_t getVisualizationSchemaVersion() const override
        { return xleth::viz::kDynamicsVizSchemaVersion; }
    std::size_t   drainVizFrames(std::uint8_t* out, std::size_t maxBytes) override;

    // ── Diagnostics / tests ─────────────────────────────────────────────────
    int getReportedLatencySamples() const { return AudioProcessor::getLatencySamples(); }
    int getLookaheadSamples()       const { return lookaheadSamplesPub_.load(std::memory_order_relaxed); }
    int getSaturationLatencySamples() const
    {
        const int m = satStageMask_.load(std::memory_order_relaxed);
        return ((m & 1) ? xleth_apex::kOsLatencySamples : 0)
             + ((m & 2) ? xleth_apex::kOsLatencySamples : 0);
    }
    std::uint64_t getLatencyPublishCount() const
    {
        return latencyPublishCount_.load(std::memory_order_acquire);
    }

    // Parameter id helpers — "lo_", "md_", "hi_", "ms_" prefixes.
    static const char* bandPrefix(int band)
    {
        static const char* kPrefixes[kNumBands] = { "lo_", "md_", "hi_", "ms_" };
        return kPrefixes[std::clamp(band, 0, kNumBands - 1)];
    }
    static std::string bandParamId(int band, const char* suffix)
    {
        return std::string(bandPrefix(band)) + suffix;
    }

private:
    // ── Published curve LUT (main thread writes, audio thread reads) ─────────
    //
    // Slots are pre-allocated; the writer round-robins into a slot the audio
    // thread has not published as in use, then swaps the active index.  Nothing
    // is ever allocated or freed after prepare, and the audio thread only ever
    // does two relaxed atomic loads per block.
    static constexpr int kLutSlots = 8;

    struct BandCurve
    {
        std::vector<CurveNode>                            nodes;
        std::vector<float>                                tensions;
        std::array<xleth_apex::CurveLut, kLutSlots>       slots;
        std::atomic<int>                                  activeSlot { 0 };
        std::atomic<int>                                  inUseSlot  { -1 };
        int                                               nextSlot = 1;
    };

    // ── Per-block snapshot of one band's configuration ──────────────────────
    struct BandBlockConfig
    {
        BandState state          = BandState::On;
        bool      silent         = false;   // MUTED, or excluded by SOLO
        bool      bypass         = false;   // OFF — no DSP at all
        bool      applyDynamics  = false;   // ON only
        bool      rms            = false;
        float     aCoef          = 0.0f;
        float     rCoef          = 0.0f;
        int       holdSamples    = 0;
        xleth_apex::SatConfig sat {};
        bool      satActive      = false;
    };

    // ── Helpers ─────────────────────────────────────────────────────────────
    void  resolveParameterPointers();
    void  updateLatency();                       // main thread only
    void  rebuildBandLut(int band);              // main thread only
    void  rebuildAllLuts();                      // main thread only
    void  writeCurvesToState();                  // main thread only
    void  readCurvesFromState();                 // main thread only
    void  sanitiseCurve(std::vector<CurveNode>& nodes, std::vector<float>& tensions) const;
    float rawParam(std::atomic<float>* p, float fallback) const
    {
        return p ? p->load(std::memory_order_relaxed) : fallback;
    }

    void splitBands(const float* inL, const float* inR, int numSamples);
    void runBandStage(int band, BandBlockConfig& cfg, int numSamples);
    void runMasterStage(BandBlockConfig& cfg, int numSamples);
    BandBlockConfig makeBandConfig(int band, bool anySolo, int numSamples);

    static constexpr float kSatEpsilon = 0.05f;  // |THRESH| % below which SAT is off
    static constexpr const char* kCurveTreeType = "APEX_CURVES";
    static constexpr const char* kCurveBandType = "BAND";

    // ── Parameter pointers (resolved once in prepareEffect) ─────────────────
    struct BandParamPtrs
    {
        std::atomic<float>* state   = nullptr;
        std::atomic<float>* solo    = nullptr;   // null for MASTER
        std::atomic<float>* pre     = nullptr;
        std::atomic<float>* post    = nullptr;
        std::atomic<float>* att     = nullptr;
        std::atomic<float>* rel     = nullptr;
        std::atomic<float>* sus     = nullptr;
        std::atomic<float>* det     = nullptr;
        std::atomic<float>* satTh   = nullptr;
        std::atomic<float>* satCeil = nullptr;
        std::atomic<float>* sep     = nullptr;
    };

    BandParamPtrs       bp_[kNumBands] {};
    std::atomic<float>* pLowCut_    = nullptr;
    std::atomic<float>* pSplitLo_   = nullptr;
    std::atomic<float>* pSplitHi_   = nullptr;
    std::atomic<float>* pSlopeLo_   = nullptr;
    std::atomic<float>* pSlopeHi_   = nullptr;
    std::atomic<float>* pLookahead_ = nullptr;
    std::atomic<float>* pBandMix_   = nullptr;

    // ── Published, main-thread-owned realtime configuration ─────────────────
    // The audio thread reads ONLY these for anything latency-relevant, so the
    // delay it applies always matches the latency the PDC planner was given.
    std::atomic<int>           satStageMask_      { 0 };   // bit0 = band stage, bit1 = master
    std::atomic<int>           lookaheadSamplesPub_ { 0 };
    std::atomic<std::uint64_t> latencyPublishCount_ { 0 };

    // ── DSP state ───────────────────────────────────────────────────────────
    double sampleRate_ = 44100.0;
    int    maxBlock_   = 512;

    xleth_apex::HighPass24 lowCut_;
    xleth_apex::LrSplit    splitLo_;      // LOW  | MID+HIGH
    xleth_apex::LrSplit    splitHi_;      // MID  | HIGH
    xleth_apex::LrSplit    apComp_;       // phase compensation for the LOW band

    xleth_apex::LookaheadRing ring_;
    xleth_apex::FixedDelay    bandOsDelay_[kNumSplitBands];   // when a band is not saturating
    xleth_apex::FixedDelay    dryOsDelay_;
    xleth_apex::FixedDelay    masterOsDelay_;

    xleth_apex::Saturator2x   sat_[kNumBands];
    xleth_apex::EnvelopeFollower env_[kNumBands];

    BandCurve curves_[kNumBands];

    xleth_apex::BlockRamp preRamp_[kNumBands], postRamp_[kNumBands], sepRamp_[kNumBands];
    xleth_apex::BlockRamp mixRamp_;

    float rmsCoef_ = 0.0f;   // fixed 10 ms mean-square window for RMS detection

    // Cached filter settings so the trig in the coefficient designers only runs
    // when the user actually moved something.
    float lastLowCut_  = -1.0f;
    float lastSplitLo_ = -1.0f;
    float lastSplitHi_ = -1.0f;
    int   lastSlopeLo_ = -1;
    int   lastSlopeHi_ = -1;

    // ── Scratch buffers (allocated in prepareEffect, never on the audio path) ─
    juce::AudioBuffer<float> bandBuf_;    // 6 channels: 3 bands x stereo
    juce::AudioBuffer<float> dryBuf_;     // stereo
    juce::AudioBuffer<float> sumBuf_;     // stereo
    std::vector<float>       gainBuf_[kNumBands];
    std::array<float*, xleth_apex::LookaheadRing::kMaxLanes * 2> lanePtrs_ {};

    float bandGrDb_[kNumBands] {};

    // ── Visualization state ─────────────────────────────────────────────────
    // Lazily allocated on the first setVisualizationEnabled(true) and re-used
    // on later enables. vizActive_ is the ONLY thing the audio thread reads —
    // a null pointer there means "do no metering work at all", so every extra
    // per-sample peak tracker below is gated on it.
    std::unique_ptr<xleth::viz::DynamicsVizCollector<xleth::viz::ApexBucket>>
        vizCollector_;
    std::atomic<xleth::viz::DynamicsVizCollector<xleth::viz::ApexBucket>*>
        vizActive_ { nullptr };
    xleth::apexviz::ApexVizAccumulator vizAccum_;
};

// ═════════════════════════════════════════════════════════════════════════════
// Parameter layout
// ═════════════════════════════════════════════════════════════════════════════

inline juce::AudioProcessorValueTreeState::ParameterLayout XlethApexEffect::createLayout()
{
    using Apf = juce::AudioParameterFloat;
    using Pid = juce::ParameterID;
    using Nar = juce::NormalisableRange<float>;
    using Attr = juce::AudioParameterFloatAttributes;

    std::vector<std::unique_ptr<juce::RangedAudioParameter>> params;

    auto addFloat = [&params](const char* id, const char* name,
                              Nar range, float def, const char* unit)
    {
        params.push_back(std::make_unique<Apf>(
            Pid{ id, 1 }, name, range, def, Attr().withLabel(unit)));
    };

    // ── Global & crossover (spec 4.1) ───────────────────────────────────────
    addFloat("lowcut", "Low Cut", Nar{ 0.0f, 100.0f, 0.0f, 1.0f }, 0.0f, "Hz");

    {
        Nar lo{ 40.0f, 1000.0f, 0.0f, 1.0f };
        lo.setSkewForCentre(200.0f);
        addFloat("split_lo", "Low Split", lo, 200.0f, "Hz");

        Nar hi{ 1000.0f, 18000.0f, 0.0f, 1.0f };
        hi.setSkewForCentre(4000.0f);
        addFloat("split_hi", "High Split", hi, 2000.0f, "Hz");
    }

    // Discrete: 0 = 12 dB/oct (LR2), 1 = 24 dB/oct (LR4)
    addFloat("slope_lo", "Low Slope",  Nar{ 0.0f, 1.0f, 1.0f, 1.0f }, 1.0f, "");
    addFloat("slope_hi", "High Slope", Nar{ 0.0f, 1.0f, 1.0f, 1.0f }, 1.0f, "");

    addFloat("lookahead", "Lookahead", Nar{ 0.0f,  20.0f, 0.0f, 1.0f },   0.0f, "ms");
    addFloat("bandmix",   "Band Mix",  Nar{ 0.0f, 100.0f, 0.0f, 1.0f }, 100.0f, "%");

    // ── Per band (spec 4.2) — identical set for LOW / MID / HIGH / MASTER ────
    static const char* kBandNames[kNumBands] = { "Low", "Mid", "High", "Master" };

    for (int b = 0; b < kNumBands; ++b)
    {
        const std::string p = bandPrefix(b);
        const std::string n = std::string(kBandNames[b]) + " ";

        auto add = [&](const char* suffix, const char* label,
                       Nar range, float def, const char* unit)
        {
            const std::string id   = p + suffix;
            const std::string name = n + label;
            params.push_back(std::make_unique<Apf>(
                Pid{ id, 1 }, name, range, def, Attr().withLabel(unit)));
        };

        // 0 = ON, 1 = COMP OFF, 2 = MUTED, 3 = OFF
        add("state", "State", Nar{ 0.0f, 3.0f, 1.0f, 1.0f }, 0.0f, "");

        // SOLO is L/M/H only (spec 4.2); MASTER has no solo.
        if (b < kNumSplitBands)
            add("solo", "Solo", Nar{ 0.0f, 1.0f, 1.0f, 1.0f }, 0.0f, "");

        add("pre",  "Pre Gain",  Nar{ -24.0f, 24.0f, 0.0f, 1.0f }, 0.0f, "dB");
        add("post", "Post Gain", Nar{ -24.0f, 24.0f, 0.0f, 1.0f }, 0.0f, "dB");

        {
            Nar att{ 0.1f, 100.0f, 0.0f, 1.0f };
            att.setSkewForCentre(5.0f);
            add("att", "Attack", att, 5.0f, "ms");

            Nar rel{ 5.0f, 500.0f, 0.0f, 1.0f };
            rel.setSkewForCentre(100.0f);
            add("rel", "Release", rel, 100.0f, "ms");

            Nar sus{ 0.0f, 500.0f, 0.0f, 1.0f };
            add("sus", "Sustain", sus, 0.0f, "ms");
        }

        // 0 = PEAK, 1 = RMS
        add("det", "Detection", Nar{ 0.0f, 1.0f, 1.0f, 1.0f }, 0.0f, "");

        add("satth", "Sat Thresh", Nar{ -100.0f, 100.0f, 0.0f, 1.0f },  0.0f, "%");
        add("satcl", "Sat Ceil",   Nar{  -60.0f,   0.0f, 0.0f, 1.0f },  0.0f, "dB");
        add("sep",   "Stereo Sep", Nar{ -100.0f, 100.0f, 0.0f, 1.0f },  0.0f, "%");
    }

    return { params.begin(), params.end() };
}

// ═════════════════════════════════════════════════════════════════════════════
// Construction
// ═════════════════════════════════════════════════════════════════════════════

inline XlethApexEffect::XlethApexEffect()
    : XlethEffectBase("apex", createLayout())
{
    // Seed every band with the unity (flat) curve and compile it, so the audio
    // thread always has a valid LUT even before the first prepareToPlay.
    for (int b = 0; b < kNumBands; ++b)
    {
        xleth_apex::makeUnityCurve(curves_[b].nodes, curves_[b].tensions);
        for (auto& slot : curves_[b].slots)
            slot.gainLin.fill(1.0f);
        curves_[b].activeSlot.store(0, std::memory_order_release);
        curves_[b].nextSlot = 1;
    }
    writeCurvesToState();
}

// ═════════════════════════════════════════════════════════════════════════════
// Lifecycle
// ═════════════════════════════════════════════════════════════════════════════

inline void XlethApexEffect::resolveParameterPointers()
{
    for (int b = 0; b < kNumBands; ++b)
    {
        auto get = [this, b](const char* suffix)
        {
            return apvts_.getRawParameterValue(bandParamId(b, suffix));
        };
        bp_[b].state   = get("state");
        bp_[b].solo    = (b < kNumSplitBands) ? get("solo") : nullptr;
        bp_[b].pre     = get("pre");
        bp_[b].post    = get("post");
        bp_[b].att     = get("att");
        bp_[b].rel     = get("rel");
        bp_[b].sus     = get("sus");
        bp_[b].det     = get("det");
        bp_[b].satTh   = get("satth");
        bp_[b].satCeil = get("satcl");
        bp_[b].sep     = get("sep");
    }

    pLowCut_    = apvts_.getRawParameterValue("lowcut");
    pSplitLo_   = apvts_.getRawParameterValue("split_lo");
    pSplitHi_   = apvts_.getRawParameterValue("split_hi");
    pSlopeLo_   = apvts_.getRawParameterValue("slope_lo");
    pSlopeHi_   = apvts_.getRawParameterValue("slope_hi");
    pLookahead_ = apvts_.getRawParameterValue("lookahead");
    pBandMix_   = apvts_.getRawParameterValue("bandmix");
}

inline void XlethApexEffect::prepareEffect(double sampleRate, int maxBlockSize)
{
    sampleRate_ = sampleRate > 0.0 ? sampleRate : 44100.0;
    maxBlock_   = std::max(1, maxBlockSize);

    resolveParameterPointers();

    // 20 ms of lookahead, plus a sample of headroom for the fractional read.
    const int maxLookahead = static_cast<int>(std::ceil(0.020 * sampleRate_)) + 2;

    ring_.prepare(maxLookahead, sampleRate_);
    for (auto& d : bandOsDelay_) d.prepare(xleth_apex::kOsLatencySamples);
    dryOsDelay_.prepare(xleth_apex::kOsLatencySamples);
    masterOsDelay_.prepare(xleth_apex::kOsLatencySamples);

    bandBuf_.setSize(kNumSplitBands * 2, maxBlock_, false, true, true);
    dryBuf_ .setSize(2,                 maxBlock_, false, true, true);
    sumBuf_ .setSize(2,                 maxBlock_, false, true, true);
    for (auto& g : gainBuf_)
        g.assign(static_cast<std::size_t>(maxBlock_), 1.0f);

    rmsCoef_ = xleth_apex::onePoleCoeff(10.0f, sampleRate_);

    // Force a coefficient rebuild on the first block.
    lastLowCut_ = lastSplitLo_ = lastSplitHi_ = -1.0f;
    lastSlopeLo_ = lastSlopeHi_ = -1;

    // Snap every ramp to its current parameter value — no fade-in on prepare.
    for (int b = 0; b < kNumBands; ++b)
    {
        preRamp_ [b].snap(xleth_apex::dbToGain(rawParam(bp_[b].pre,  0.0f)));
        postRamp_[b].snap(xleth_apex::dbToGain(rawParam(bp_[b].post, 0.0f)));
        sepRamp_ [b].snap(1.0f + std::clamp(rawParam(bp_[b].sep, 0.0f) * 0.01f, -1.0f, 1.0f));
    }
    mixRamp_.snap(std::clamp(rawParam(pBandMix_, 100.0f) * 0.01f, 0.0f, 1.0f));

    rebuildAllLuts();
    updateLatency();
    ring_.snapDelay(static_cast<float>(lookaheadSamplesPub_.load(std::memory_order_relaxed)));

    // Every viz allocation (Hann window, FFT history ring, FFT scratch) happens
    // here, on the main thread, before any audio can reach the accumulator.
    vizAccum_.prepare(sampleRate_);

    resetEffect();
}

inline void XlethApexEffect::releaseEffect()
{
    bandBuf_.setSize(0, 0);
    dryBuf_ .setSize(0, 0);
    sumBuf_ .setSize(0, 0);
    for (auto& g : gainBuf_) g.clear();
}

inline void XlethApexEffect::resetEffect()
{
    lowCut_ .reset();
    splitLo_.reset();
    splitHi_.reset();
    apComp_ .reset();

    ring_.reset();
    for (auto& d : bandOsDelay_) d.reset();
    dryOsDelay_.reset();
    masterOsDelay_.reset();

    for (auto& s : sat_) s.reset();
    for (auto& e : env_) e.reset();
    for (auto& g : bandGrDb_) g = 0.0f;

    vizAccum_.reset();
}

// ═════════════════════════════════════════════════════════════════════════════
// Visualization (main thread only)
// ═════════════════════════════════════════════════════════════════════════════

inline void XlethApexEffect::setVisualizationEnabled(bool enabled)
{
    if (enabled)
    {
        if (!vizCollector_)
        {
            vizCollector_ = std::make_unique<
                xleth::viz::DynamicsVizCollector<xleth::viz::ApexBucket>>(
                    xleth::viz::kApexVizBucketSize,
                    xleth::viz::kApexVizRingDepth,
                    xleth::viz::kVizTypeApex);
        }
        else
        {
            // Re-enabling after a close: drop whatever staled in the ring so the
            // reopened editor does not paint a burst of history from last time.
            vizCollector_->reset();
        }
        vizAccum_.reset();
        vizActive_.store(vizCollector_.get(), std::memory_order_release);
    }
    else
    {
        vizActive_.store(nullptr, std::memory_order_release);
    }
}

inline std::size_t XlethApexEffect::drainVizFrames(std::uint8_t* out, std::size_t maxBytes)
{
    if (!vizCollector_) return 0;
    return vizCollector_->drain(out, maxBytes);
}

// ═════════════════════════════════════════════════════════════════════════════
// Latency (main thread only)
// ═════════════════════════════════════════════════════════════════════════════

inline void XlethApexEffect::updateLatency()
{
    const float lookaheadMs = std::clamp(rawParam(pLookahead_, 0.0f), 0.0f, 20.0f);
    const int   lookaheadSamples =
        static_cast<int>(std::lround(lookaheadMs * 0.001 * sampleRate_));

    bool bandOs = false;
    for (int b = 0; b < kNumSplitBands; ++b)
        bandOs = bandOs || std::abs(rawParam(bp_[b].satTh, 0.0f)) > kSatEpsilon;
    const bool masterOs = std::abs(rawParam(bp_[kNumBands - 1].satTh, 0.0f)) > kSatEpsilon;

    const int mask = (bandOs ? 1 : 0) | (masterOs ? 2 : 0);

    // Publish BEFORE setLatencySamples so a graph re-plan can never observe a
    // latency the audio thread is not yet applying.
    lookaheadSamplesPub_.store(lookaheadSamples, std::memory_order_release);
    satStageMask_.store(mask, std::memory_order_release);

    const int total = lookaheadSamples
                    + (bandOs   ? xleth_apex::kOsLatencySamples : 0)
                    + (masterOs ? xleth_apex::kOsLatencySamples : 0);

    if (total != AudioProcessor::getLatencySamples())
    {
        setLatencySamples(total);
        latencyPublishCount_.fetch_add(1, std::memory_order_acq_rel);
    }
}

inline void XlethApexEffect::onParameterValueChanged(const std::string& paramId, float)
{
    // Only LOOKAHEAD and the four saturation THRESH knobs can move the latency.
    // Everything else — including band STATE, SOLO and bypass — is deliberately
    // latency-neutral so ordinary mixing gestures never re-plan the graph.
    const bool isSatThresh = paramId.size() >= 8
                          && paramId.compare(paramId.size() - 5, 5, "satth") == 0;
    if (paramId == "lookahead" || isSatThresh)
        updateLatency();
}

inline void XlethApexEffect::setStateInformation(const void* data, int sizeInBytes)
{
    XlethEffectBase::setStateInformation(data, sizeInBytes);
    readCurvesFromState();
    rebuildAllLuts();
    updateLatency();
}

// ═════════════════════════════════════════════════════════════════════════════
// Curve management (main thread only)
// ═════════════════════════════════════════════════════════════════════════════

inline void XlethApexEffect::sanitiseCurve(std::vector<CurveNode>& nodes,
                                           std::vector<float>&     tensions) const
{
    for (auto& n : nodes)
    {
        n.inDb  = std::clamp(n.inDb,  xleth_apex::kCurveMinDb, xleth_apex::kCurveMaxDb);
        n.outDb = std::clamp(n.outDb, xleth_apex::kCurveMinDb, xleth_apex::kCurveMaxDb);
    }

    std::stable_sort(nodes.begin(), nodes.end(),
                     [](const CurveNode& a, const CurveNode& b) { return a.inDb < b.inDb; });

    // Drop nodes that share an IN with their predecessor — the LUT builder needs
    // a strictly increasing domain to stay single-valued.
    std::vector<CurveNode> unique;
    unique.reserve(nodes.size());
    for (const auto& n : nodes)
        if (unique.empty() || n.inDb > unique.back().inDb + 1.0e-4f)
            unique.push_back(n);
    nodes.swap(unique);

    if (static_cast<int>(nodes.size()) > xleth_apex::kMaxCurveNodes)
        nodes.resize(static_cast<std::size_t>(xleth_apex::kMaxCurveNodes));

    if (nodes.size() < 2)
    {
        xleth_apex::makeUnityCurve(nodes, tensions);
        return;
    }

    tensions.resize(nodes.size() - 1, 0.0f);
    for (auto& t : tensions) t = std::clamp(t, -1.0f, 1.0f);
}

inline void XlethApexEffect::rebuildBandLut(int band)
{
    BandCurve& c = curves_[band];

    // Pick a slot the audio thread has not published as in use.
    int slot = c.nextSlot;
    for (int i = 0; i < kLutSlots; ++i)
    {
        if (slot != c.inUseSlot.load(std::memory_order_acquire)) break;
        slot = (slot + 1) % kLutSlots;
    }

    xleth_apex::buildCurveLut(c.nodes.data(),
                              static_cast<int>(c.nodes.size()),
                              c.tensions.data(),
                              static_cast<int>(c.tensions.size()),
                              c.slots[static_cast<std::size_t>(slot)]);

    c.activeSlot.store(slot, std::memory_order_release);
    c.nextSlot = (slot + 1) % kLutSlots;
}

inline void XlethApexEffect::rebuildAllLuts()
{
    for (int b = 0; b < kNumBands; ++b)
        rebuildBandLut(b);
}

inline bool XlethApexEffect::setBandCurve(int band,
                                          const std::vector<CurveNode>& nodes,
                                          const std::vector<float>&     tensions)
{
    if (band < 0 || band >= kNumBands) return false;

    curves_[band].nodes    = nodes;
    curves_[band].tensions = tensions;
    sanitiseCurve(curves_[band].nodes, curves_[band].tensions);
    rebuildBandLut(band);
    writeCurvesToState();
    return true;
}

inline bool XlethApexEffect::resetBandCurve(int band)
{
    if (band < 0 || band >= kNumBands) return false;
    xleth_apex::makeUnityCurve(curves_[band].nodes, curves_[band].tensions);
    rebuildBandLut(band);
    writeCurvesToState();
    return true;
}

inline std::string XlethApexEffect::getBandCurveJSON(int band) const
{
    if (band < 0 || band >= kNumBands) return "{}";

    nlohmann::json j;
    j["band"]  = band;
    j["nodes"] = nlohmann::json::array();
    for (const auto& n : curves_[band].nodes)
        j["nodes"].push_back({ { "in", n.inDb }, { "out", n.outDb } });
    j["tensions"] = curves_[band].tensions;
    return j.dump();
}

// One round trip for the whole editor. The per-band objects are byte-identical
// to what getBandCurveJSON(b) returns, so an undo capture can take either form
// and feed it straight back into setBandCurveJSON without translation.
inline std::string XlethApexEffect::getAllCurvesJSON() const
{
    nlohmann::json j;
    j["bands"] = nlohmann::json::array();
    for (int b = 0; b < kNumBands; ++b)
    {
        nlohmann::json band;
        band["band"]  = b;
        band["nodes"] = nlohmann::json::array();
        for (const auto& n : curves_[b].nodes)
            band["nodes"].push_back({ { "in", n.inDb }, { "out", n.outDb } });
        band["tensions"] = curves_[b].tensions;
        j["bands"].push_back(std::move(band));
    }
    return j.dump();
}

inline bool XlethApexEffect::setBandCurveJSON(int band, const std::string& json)
{
    if (band < 0 || band >= kNumBands) return false;

    nlohmann::json j = nlohmann::json::parse(json, nullptr, false);
    if (j.is_discarded() || !j.is_object()) return false;

    std::vector<CurveNode> nodes;
    std::vector<float>     tensions;

    if (j.contains("nodes") && j["nodes"].is_array())
    {
        for (const auto& n : j["nodes"])
        {
            if (!n.is_object()) continue;
            CurveNode node;
            node.inDb  = n.value("in",  0.0f);
            node.outDb = n.value("out", 0.0f);
            nodes.push_back(node);
        }
    }
    if (j.contains("tensions") && j["tensions"].is_array())
        for (const auto& t : j["tensions"])
            tensions.push_back(t.is_number() ? t.get<float>() : 0.0f);

    return setBandCurve(band, nodes, tensions);
}

// ── ValueTree persistence ───────────────────────────────────────────────────
// Curves live as an APEX_CURVES child of the APVTS state tree.  The base class
// serialises apvts_.copyState() verbatim, so this rides the existing stock-FX
// preset / undo / project-save path with no new plumbing anywhere.

inline void XlethApexEffect::writeCurvesToState()
{
    auto tree = apvts_.state.getOrCreateChildWithName(kCurveTreeType, nullptr);
    tree.removeAllChildren(nullptr);

    for (int b = 0; b < kNumBands; ++b)
    {
        juce::ValueTree bandTree(kCurveBandType);
        bandTree.setProperty("index", b, nullptr);

        juce::String nodesStr;
        for (std::size_t i = 0; i < curves_[b].nodes.size(); ++i)
        {
            if (i > 0) nodesStr << ",";
            nodesStr << juce::String(curves_[b].nodes[i].inDb, 6) << ":"
                     << juce::String(curves_[b].nodes[i].outDb, 6);
        }
        bandTree.setProperty("nodes", nodesStr, nullptr);

        juce::String tensStr;
        for (std::size_t i = 0; i < curves_[b].tensions.size(); ++i)
        {
            if (i > 0) tensStr << ",";
            tensStr << juce::String(curves_[b].tensions[i], 6);
        }
        bandTree.setProperty("tensions", tensStr, nullptr);

        tree.appendChild(bandTree, nullptr);
    }
}

inline void XlethApexEffect::readCurvesFromState()
{
    auto tree = apvts_.state.getChildWithName(kCurveTreeType);
    if (!tree.isValid())
    {
        // Older state (or a preset authored before curves existed) — unity.
        for (int b = 0; b < kNumBands; ++b)
            xleth_apex::makeUnityCurve(curves_[b].nodes, curves_[b].tensions);
        writeCurvesToState();
        return;
    }

    for (int i = 0; i < tree.getNumChildren(); ++i)
    {
        auto bandTree = tree.getChild(i);
        const int b = static_cast<int>(bandTree.getProperty("index", -1));
        if (b < 0 || b >= kNumBands) continue;

        std::vector<CurveNode> nodes;
        auto nodeTokens = juce::StringArray::fromTokens(
            bandTree.getProperty("nodes").toString(), ",", "");
        for (const auto& tok : nodeTokens)
        {
            const int colon = tok.indexOfChar(':');
            if (colon <= 0) continue;
            CurveNode n;
            n.inDb  = tok.substring(0, colon).getFloatValue();
            n.outDb = tok.substring(colon + 1).getFloatValue();
            nodes.push_back(n);
        }

        std::vector<float> tensions;
        auto tensTokens = juce::StringArray::fromTokens(
            bandTree.getProperty("tensions").toString(), ",", "");
        for (const auto& tok : tensTokens)
            if (tok.isNotEmpty())
                tensions.push_back(tok.getFloatValue());

        curves_[b].nodes    = std::move(nodes);
        curves_[b].tensions = std::move(tensions);
        sanitiseCurve(curves_[b].nodes, curves_[b].tensions);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Audio thread
// ═════════════════════════════════════════════════════════════════════════════

inline XlethApexEffect::BandBlockConfig
XlethApexEffect::makeBandConfig(int band, bool anySolo, int numSamples)
{
    BandBlockConfig cfg;

    cfg.state = xleth_apex::bandStateFromFloat(rawParam(bp_[band].state, 0.0f));

    const bool isSplitBand = band < kNumSplitBands;
    const bool soloed      = isSplitBand
                           && rawParam(bp_[band].solo, 0.0f) > 0.5f;

    cfg.bypass        = (cfg.state == BandState::Off);
    cfg.silent        = (cfg.state == BandState::Muted)
                     || (isSplitBand && anySolo && !soloed);
    cfg.applyDynamics = (cfg.state == BandState::On);

    // Envelope ballistics — one exp() per coefficient per block, never per sample.
    cfg.rms         = rawParam(bp_[band].det, 0.0f) > 0.5f;
    cfg.aCoef       = xleth_apex::onePoleCoeff(
                          std::clamp(rawParam(bp_[band].att, 5.0f), 0.1f, 100.0f), sampleRate_);
    cfg.rCoef       = xleth_apex::onePoleCoeff(
                          std::clamp(rawParam(bp_[band].rel, 100.0f), 5.0f, 500.0f), sampleRate_);
    cfg.holdSamples = static_cast<int>(
                          std::clamp(rawParam(bp_[band].sus, 0.0f), 0.0f, 500.0f)
                          * 0.001 * sampleRate_);

    const float satTh = rawParam(bp_[band].satTh, 0.0f);
    cfg.sat.set(satTh, rawParam(bp_[band].satCeil, 0.0f));
    cfg.satActive = std::abs(satTh) > kSatEpsilon
                 && !cfg.bypass && !cfg.silent;

    preRamp_ [band].setTarget(xleth_apex::dbToGain(rawParam(bp_[band].pre,  0.0f)), numSamples);
    postRamp_[band].setTarget(xleth_apex::dbToGain(rawParam(bp_[band].post, 0.0f)), numSamples);
    sepRamp_ [band].setTarget(
        1.0f + std::clamp(rawParam(bp_[band].sep, 0.0f) * 0.01f, -1.0f, 1.0f), numSamples);

    return cfg;
}

// Split the (already low-cut) stereo input into the three band buffers.
//
// The LOW band is passed through apComp_ — a second crossover configured
// identically to the HIGH split — and its two outputs summed.  By construction
// that sum is exactly the allpass of the HIGH split, for LR2 and LR4 alike, so
//
//     low + mid + high == apComp(splitLo.lo) + apComp(splitLo.hi)
//                      == allpass_hi( allpass_lo( input ) )
//
// i.e. magnitude-flat reconstruction, which is what makes the parallel BAND MIX
// blend meaningful.  Deriving the allpass coefficients separately would risk a
// mismatch with the split actually in use; running the split itself cannot.
inline void XlethApexEffect::splitBands(const float* inL, const float* inR, int numSamples)
{
    float* lowL  = bandBuf_.getWritePointer(0);
    float* lowR  = bandBuf_.getWritePointer(1);
    float* midL  = bandBuf_.getWritePointer(2);
    float* midR  = bandBuf_.getWritePointer(3);
    float* highL = bandBuf_.getWritePointer(4);
    float* highR = bandBuf_.getWritePointer(5);

    for (int s = 0; s < numSamples; ++s)
    {
        float lo, hi, a, b;

        splitLo_.process(0, inL[s], lo, hi);
        apComp_ .process(0, lo, a, b);
        lowL[s] = a + b;
        splitHi_.process(0, hi, midL[s], highL[s]);

        splitLo_.process(1, inR[s], lo, hi);
        apComp_ .process(1, lo, a, b);
        lowR[s] = a + b;
        splitHi_.process(1, hi, midR[s], highR[s]);
    }
}

// Everything downstream of the lookahead ring for one of LOW / MID / HIGH:
// curve gain → SAT → POST GAIN → STEREO SEP → band state.
inline void XlethApexEffect::runBandStage(int band, BandBlockConfig& cfg, int numSamples)
{
    float* chans[2] = { bandBuf_.getWritePointer(band * 2),
                        bandBuf_.getWritePointer(band * 2 + 1) };

    const bool bandOsStage = (satStageMask_.load(std::memory_order_relaxed) & 1) != 0;

    if (cfg.silent)
    {
        // MUTED (or excluded by SOLO): silence out, and push that silence
        // THROUGH the saturation-stage delay so the lane's state stays
        // consistent — then discard whatever tail the delay produced, so the
        // mute is instantaneous rather than leaking 47 samples of history.
        std::fill(chans[0], chans[0] + numSamples, 0.0f);
        std::fill(chans[1], chans[1] + numSamples, 0.0f);
        if (bandOsStage) bandOsDelay_[band].processBlock(chans, 2, numSamples);
        std::fill(chans[0], chans[0] + numSamples, 0.0f);
        std::fill(chans[1], chans[1] + numSamples, 0.0f);
        postRamp_[band].finish();
        sepRamp_ [band].finish();
        bandGrDb_[band] = 0.0f;
        return;
    }

    if (cfg.bypass)
    {
        // OFF: band passes its raw crossover output, DSP skipped entirely.
        // The only thing it still pays is the published saturation-stage delay,
        // without which it would drift ahead of the bands that are saturating.
        if (bandOsStage) bandOsDelay_[band].processBlock(chans, 2, numSamples);
        postRamp_[band].finish();
        sepRamp_ [band].finish();
        bandGrDb_[band] = 0.0f;
        return;
    }

    // ── Curve gain (computed pre-delay, applied to the delayed audio) ────────
    if (cfg.applyDynamics)
    {
        const float* g = gainBuf_[band].data();
        for (int s = 0; s < numSamples; ++s)
        {
            chans[0][s] *= g[s];
            chans[1][s] *= g[s];
        }
    }

    // ── Saturation (2× oversampled) or the matching integer delay ───────────
    if (bandOsStage)
    {
        if (cfg.satActive)
            sat_[band].processBlock(chans, 2, numSamples, cfg.sat);
        else
            bandOsDelay_[band].processBlock(chans, 2, numSamples);
    }

    // ── POST GAIN ───────────────────────────────────────────────────────────
    if (!postRamp_[band].isStatic(1.0f))
    {
        for (int s = 0; s < numSamples; ++s)
        {
            const float g = postRamp_[band].next();
            chans[0][s] *= g;
            chans[1][s] *= g;
        }
    }
    postRamp_[band].finish();

    // ── STEREO SEP (M/S encode → side scale → decode) ───────────────────────
    if (!sepRamp_[band].isStatic(1.0f))
    {
        for (int s = 0; s < numSamples; ++s)
        {
            const float sg   = sepRamp_[band].next();
            const float mid  = 0.5f * (chans[0][s] + chans[1][s]);
            const float side = 0.5f * (chans[0][s] - chans[1][s]) * sg;
            chans[0][s] = mid + side;
            chans[1][s] = mid - side;
        }
    }
    sepRamp_[band].finish();
}

inline void XlethApexEffect::runMasterStage(BandBlockConfig& cfg, int numSamples)
{
    constexpr int band = kNumBands - 1;

    float* chans[2] = { sumBuf_.getWritePointer(0), sumBuf_.getWritePointer(1) };
    const bool masterOsStage = (satStageMask_.load(std::memory_order_relaxed) & 2) != 0;

    if (cfg.silent)
    {
        std::fill(chans[0], chans[0] + numSamples, 0.0f);
        std::fill(chans[1], chans[1] + numSamples, 0.0f);
        preRamp_ [band].finish();
        postRamp_[band].finish();
        sepRamp_ [band].finish();
        bandGrDb_[band] = 0.0f;
        if (masterOsStage) masterOsDelay_.processBlock(chans, 2, numSamples);
        return;
    }

    if (cfg.bypass)
    {
        preRamp_ [band].finish();
        postRamp_[band].finish();
        sepRamp_ [band].finish();
        bandGrDb_[band] = 0.0f;
        // Still pay the published saturation latency so the reported number
        // stays honest regardless of band state.
        if (masterOsStage) masterOsDelay_.processBlock(chans, 2, numSamples);
        return;
    }

    // ── PRE GAIN ────────────────────────────────────────────────────────────
    if (!preRamp_[band].isStatic(1.0f))
    {
        for (int s = 0; s < numSamples; ++s)
        {
            const float g = preRamp_[band].next();
            chans[0][s] *= g;
            chans[1][s] *= g;
        }
    }
    preRamp_[band].finish();

    // ── Envelope + curve gain (MASTER has no lookahead, so it is in-line) ────
    float minGain = 1.0f;
    if (cfg.applyDynamics)
    {
        const int slot = curves_[band].activeSlot.load(std::memory_order_acquire);
        curves_[band].inUseSlot.store(slot, std::memory_order_release);
        const auto& lut = curves_[band].slots[static_cast<std::size_t>(slot)];

        for (int s = 0; s < numSamples; ++s)
        {
            const float l = chans[0][s];
            const float r = chans[1][s];
            const float level = cfg.rms ? env_[band].rmsLevel(l, r, rmsCoef_)
                                        : std::max(std::abs(l), std::abs(r));
            const float e  = env_[band].process(level, cfg.aCoef, cfg.rCoef, cfg.holdSamples);
            const float g  = lut.lookup(xleth_apex::gainToDb(e));
            minGain = std::min(minGain, g);
            chans[0][s] = l * g;
            chans[1][s] = r * g;
        }

        curves_[band].inUseSlot.store(-1, std::memory_order_release);
    }
    bandGrDb_[band] = -xleth_apex::gainToDb(minGain);

    // ── SAT ─────────────────────────────────────────────────────────────────
    if (masterOsStage)
    {
        if (cfg.satActive)
            sat_[band].processBlock(chans, 2, numSamples, cfg.sat);
        else
            masterOsDelay_.processBlock(chans, 2, numSamples);
    }

    // ── POST GAIN ───────────────────────────────────────────────────────────
    if (!postRamp_[band].isStatic(1.0f))
    {
        for (int s = 0; s < numSamples; ++s)
        {
            const float g = postRamp_[band].next();
            chans[0][s] *= g;
            chans[1][s] *= g;
        }
    }
    postRamp_[band].finish();

    // ── STEREO SEP ──────────────────────────────────────────────────────────
    if (!sepRamp_[band].isStatic(1.0f))
    {
        for (int s = 0; s < numSamples; ++s)
        {
            const float sg   = sepRamp_[band].next();
            const float mid  = 0.5f * (chans[0][s] + chans[1][s]);
            const float side = 0.5f * (chans[0][s] - chans[1][s]) * sg;
            chans[0][s] = mid + side;
            chans[1][s] = mid - side;
        }
    }
    sepRamp_[band].finish();
}

inline void XlethApexEffect::processEffect(juce::AudioBuffer<float>& buffer,
                                           juce::MidiBuffer& /*midi*/)
{
    const int numSamples = buffer.getNumSamples();
    const int numCh      = buffer.getNumChannels();
    if (numSamples <= 0 || numCh <= 0 || numSamples > maxBlock_) return;

    // Single acquire-load. Null (the common case — no editor open) means every
    // metering tap below is skipped entirely.
    auto* vizCol = vizActive_.load(std::memory_order_acquire);

    // ── Block-rate configuration ────────────────────────────────────────────
    const float lowCutHz = std::clamp(rawParam(pLowCut_, 0.0f), 0.0f, 100.0f);
    if (lowCutHz != lastLowCut_)
    {
        lowCut_.configure(lowCutHz, sampleRate_);
        lastLowCut_ = lowCutHz;
    }

    const float splitLoHz = std::clamp(rawParam(pSplitLo_, 200.0f),   40.0f,  1000.0f);
    const float splitHiHz = std::clamp(rawParam(pSplitHi_, 2000.0f), 1000.0f, 18000.0f);
    const int   slopeLo   = rawParam(pSlopeLo_, 1.0f) > 0.5f ? 4 : 2;
    const int   slopeHi   = rawParam(pSlopeHi_, 1.0f) > 0.5f ? 4 : 2;

    if (splitLoHz != lastSplitLo_ || slopeLo != lastSlopeLo_)
    {
        splitLo_.configure(splitLoHz, sampleRate_, slopeLo);
        lastSplitLo_ = splitLoHz;
        lastSlopeLo_ = slopeLo;
    }
    if (splitHiHz != lastSplitHi_ || slopeHi != lastSlopeHi_)
    {
        splitHi_.configure(splitHiHz, sampleRate_, slopeHi);
        apComp_ .configure(splitHiHz, sampleRate_, slopeHi);
        lastSplitHi_ = splitHiHz;
        lastSlopeHi_ = slopeHi;
    }

    ring_.setTargetDelay(
        static_cast<float>(lookaheadSamplesPub_.load(std::memory_order_relaxed)));
    mixRamp_.setTarget(std::clamp(rawParam(pBandMix_, 100.0f) * 0.01f, 0.0f, 1.0f), numSamples);

    bool anySolo = false;
    for (int b = 0; b < kNumSplitBands; ++b)
        anySolo = anySolo || rawParam(bp_[b].solo, 0.0f) > 0.5f;

    BandBlockConfig cfg[kNumBands];
    for (int b = 0; b < kNumBands; ++b)
        cfg[b] = makeBandConfig(b, anySolo, numSamples);

    // ── LOW CUT + input capture ─────────────────────────────────────────────
    float* dryL = dryBuf_.getWritePointer(0);
    float* dryR = dryBuf_.getWritePointer(1);
    const float* srcL = buffer.getReadPointer(0);
    const float* srcR = numCh > 1 ? buffer.getReadPointer(1) : srcL;

    float inPeak = 0.0f;
    if (lowCut_.isActive())
    {
        for (int s = 0; s < numSamples; ++s)
        {
            dryL[s] = lowCut_.process(0, srcL[s]);
            dryR[s] = lowCut_.process(1, srcR[s]);
            inPeak = std::max(inPeak, std::max(std::abs(dryL[s]), std::abs(dryR[s])));
        }
    }
    else
    {
        for (int s = 0; s < numSamples; ++s)
        {
            dryL[s] = srcL[s];
            dryR[s] = srcR[s];
            inPeak = std::max(inPeak, std::max(std::abs(dryL[s]), std::abs(dryR[s])));
        }
    }

    // ── Spectrum tap ────────────────────────────────────────────────────────
    // Must happen HERE, not at the end: dryL/dryR are lanes 6 and 7 of the
    // shared lookahead ring below, so after ring_.processBlock() they hold the
    // delayed dry leg rather than the input. No FFT runs here — this only
    // copies into a pre-allocated history ring; the transform itself happens
    // once per ~1024 samples inside observeBlock().
    if (vizCol) vizAccum_.pushInput(dryL, dryR, numSamples);

    // ── Crossover ───────────────────────────────────────────────────────────
    splitBands(dryL, dryR, numSamples);

    // ── PRE GAIN + detector (both PRE-delay: this is what makes it lookahead) ─
    for (int b = 0; b < kNumSplitBands; ++b)
    {
        float* l = bandBuf_.getWritePointer(b * 2);
        float* r = bandBuf_.getWritePointer(b * 2 + 1);

        if (cfg[b].bypass || cfg[b].silent)
        {
            // OFF skips its DSP entirely; MUTED is zeroed after the ring (the
            // ring must still see the real signal so unmuting is click-free).
            preRamp_[b].finish();
            bandGrDb_[b] = 0.0f;
            continue;
        }

        if (!preRamp_[b].isStatic(1.0f))
        {
            for (int s = 0; s < numSamples; ++s)
            {
                const float g = preRamp_[b].next();
                l[s] *= g;
                r[s] *= g;
            }
        }
        preRamp_[b].finish();

        if (!cfg[b].applyDynamics)
        {
            bandGrDb_[b] = 0.0f;
            continue;
        }

        const int slot = curves_[b].activeSlot.load(std::memory_order_acquire);
        curves_[b].inUseSlot.store(slot, std::memory_order_release);
        const auto& lut = curves_[b].slots[static_cast<std::size_t>(slot)];

        float* g = gainBuf_[b].data();
        float  minGain = 1.0f;
        for (int s = 0; s < numSamples; ++s)
        {
            const float level = cfg[b].rms ? env_[b].rmsLevel(l[s], r[s], rmsCoef_)
                                           : std::max(std::abs(l[s]), std::abs(r[s]));
            const float e = env_[b].process(level, cfg[b].aCoef, cfg[b].rCoef,
                                            cfg[b].holdSamples);
            g[s] = lut.lookup(xleth_apex::gainToDb(e));
            minGain = std::min(minGain, g[s]);
        }
        curves_[b].inUseSlot.store(-1, std::memory_order_release);
        bandGrDb_[b] = -xleth_apex::gainToDb(minGain);
    }

    // ── Shared LOOKAHEAD delay: LOW, MID, HIGH and the BAND MIX dry leg ──────
    // One ring, one write position, one ramped delay value — which is exactly
    // why the dry leg can never drift out of alignment with the band legs.
    lanePtrs_[0] = bandBuf_.getWritePointer(0);
    lanePtrs_[1] = bandBuf_.getWritePointer(1);
    lanePtrs_[2] = bandBuf_.getWritePointer(2);
    lanePtrs_[3] = bandBuf_.getWritePointer(3);
    lanePtrs_[4] = bandBuf_.getWritePointer(4);
    lanePtrs_[5] = bandBuf_.getWritePointer(5);
    lanePtrs_[6] = dryL;
    lanePtrs_[7] = dryR;
    ring_.processBlock(lanePtrs_.data(), 4, 2, numSamples);

    // ── Per-band chain downstream of the delay ──────────────────────────────
    for (int b = 0; b < kNumSplitBands; ++b)
        runBandStage(b, cfg[b], numSamples);

    // The dry leg must carry the SAME saturation-stage latency the bands do.
    if ((satStageMask_.load(std::memory_order_relaxed) & 1) != 0)
    {
        float* dryChans[2] = { dryL, dryR };
        dryOsDelay_.processBlock(dryChans, 2, numSamples);
    }

    // ── Σ bands ⇄ dry  via BAND MIX ─────────────────────────────────────────
    float* sumL = sumBuf_.getWritePointer(0);
    float* sumR = sumBuf_.getWritePointer(1);
    const float* b0L = bandBuf_.getReadPointer(0);
    const float* b0R = bandBuf_.getReadPointer(1);
    const float* b1L = bandBuf_.getReadPointer(2);
    const float* b1R = bandBuf_.getReadPointer(3);
    const float* b2L = bandBuf_.getReadPointer(4);
    const float* b2R = bandBuf_.getReadPointer(5);

    // The two endpoints take exact fast paths: at 100 % the output IS the band
    // sum and at 0 % it IS the delayed dry, bit-for-bit.  Without this, the
    // lerp's `dry + 1*(band - dry)` would differ from `band` by a rounding step
    // and an OFF band would no longer be bit-transparent.
    float bandPeak = 0.0f;
    const bool fullWet = mixRamp_.isStatic(1.0f);
    const bool fullDry = mixRamp_.isStatic(0.0f);

    // Per-band OUTPUT peaks for the viz payload — measured here because this is
    // the one place all three post-chain band signals are already in registers.
    // Gated on vizCol so a closed editor pays nothing for them.
    float bandOutAbs[kNumBands] = { 0.0f, 0.0f, 0.0f, 0.0f };

    for (int s = 0; s < numSamples; ++s)
    {
        const float bl = b0L[s] + b1L[s] + b2L[s];
        const float br = b0R[s] + b1R[s] + b2R[s];
        bandPeak = std::max(bandPeak, std::max(std::abs(bl), std::abs(br)));

        if (vizCol)
        {
            bandOutAbs[0] = std::max(bandOutAbs[0],
                                     std::max(std::abs(b0L[s]), std::abs(b0R[s])));
            bandOutAbs[1] = std::max(bandOutAbs[1],
                                     std::max(std::abs(b1L[s]), std::abs(b1R[s])));
            bandOutAbs[2] = std::max(bandOutAbs[2],
                                     std::max(std::abs(b2L[s]), std::abs(b2R[s])));
        }

        if (fullWet)
        {
            sumL[s] = bl;
            sumR[s] = br;
        }
        else if (fullDry)
        {
            sumL[s] = dryL[s];
            sumR[s] = dryR[s];
        }
        else
        {
            const float m = mixRamp_.next();
            sumL[s] = dryL[s] + m * (bl - dryL[s]);
            sumR[s] = dryR[s] + m * (br - dryR[s]);
        }
    }
    mixRamp_.finish();

    // ── MASTER ──────────────────────────────────────────────────────────────
    runMasterStage(cfg[kNumBands - 1], numSamples);

    // ── Output ──────────────────────────────────────────────────────────────
    float peakL = 0.0f, peakR = 0.0f;
    float* outL = buffer.getWritePointer(0);
    float* outR = numCh > 1 ? buffer.getWritePointer(1) : nullptr;
    for (int s = 0; s < numSamples; ++s)
    {
        outL[s] = sumL[s];
        peakL = std::max(peakL, std::abs(sumL[s]));
        if (outR)
        {
            outR[s] = sumR[s];
            peakR = std::max(peakR, std::abs(sumR[s]));
        }
    }

    writeMeterValue(0, peakL);
    writeMeterValue(1, outR ? peakR : peakL);
    writeMeterValue(2, bandGrDb_[0]);
    writeMeterValue(3, bandGrDb_[1]);
    writeMeterValue(4, bandGrDb_[2]);
    writeMeterValue(5, bandGrDb_[3]);
    writeMeterValue(6, inPeak);
    writeMeterValue(7, bandPeak);

    // ── Batched viz payload ─────────────────────────────────────────────────
    // One call per block; it emits a bucket only every kApexVizBucketSize
    // samples (~43 Hz), and that emit is the only place the FFT runs. MASTER's
    // "band output" is the effect's final output, which is exactly what the
    // MASTER stage produced.
    if (vizCol)
    {
        const float outPeak = std::max(peakL, outR ? peakR : peakL);
        bandOutAbs[kNumBands - 1] = outPeak;

        // Derived from the SAME two published atomics the audio thread already
        // uses for its delays, not from AudioProcessor::getLatencySamples() —
        // so the number the meter reports can never disagree with the delay
        // this block actually applied, even mid-republish.
        const int lookaheadSamples = lookaheadSamplesPub_.load(std::memory_order_relaxed);
        const int mask             = satStageMask_.load(std::memory_order_relaxed);
        const int totalLatency     = lookaheadSamples
                                   + ((mask & 1) ? xleth_apex::kOsLatencySamples : 0)
                                   + ((mask & 2) ? xleth_apex::kOsLatencySamples : 0);

        vizAccum_.observeBlock(
            numSamples,
            inPeak,
            outPeak,
            bandGrDb_,
            bandOutAbs,
            static_cast<float>(lookaheadSamples),
            static_cast<float>(totalLatency),
            splitLoHz,
            splitHiHz,
            *vizCol);
    }
}
