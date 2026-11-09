#pragma once

// ─── ResonanceCore — shared resonance detector / gain computer / spectral renderer ──
// Stage 1 of the resonance-suppressor rewrite (docs/RESONANCE_SUPPRESSOR_AUDIT.md
// §5.2 / §6). One self-contained DSP object, NOT wired into any effect yet. No
// juce::AudioProcessor / APVTS dependency: it is driven with raw channel pointers
// and a POD parameter block, so it can be unit-tested and benchmarked headless.
//
// Signal path (per channel, block-size independent, latency = N exactly):
//
//   input ─► FIFO ─► sqrt-Hann ─► real FFT(N) ─┬─► detector ─► gain computer ─► G(f)
//                                               │                                 │
//                                               └──────────► × G(f) (real, zero-phase)
//                                                               │
//                                    output ◄─ overlap-add ◄─ sqrt-Hann·1/Σw² ◄─ IFFT
//
//   N   = 1024 at 44.1 / 48 kHz, doubled per sample-rate octave above that (2048 at
//         88.2 / 96 kHz) so the frame stays about 21 ms. Hop N/4.
//   COLA: synthesis window = sqrt-Hann × the per-hop-phase normalisation 1/Σw², the
//         same scheme as the RS High Quality WolaProcessor.
//
// Realtime contract: prepare() / release() allocate and run on a non-audio thread.
// process() and reset() never allocate, lock or log.

#include <juce_dsp/juce_dsp.h>

#include <cstdint>
#include <memory>
#include <vector>

namespace xleth::dsp::resonance
{

constexpr int kMaxChannels = 2;

// Parameter block, copied by value into process() once per block. Plain data only.
struct Params
{
    float depth       = 0.5f;    // 0..1  maximum reduction (x 12 dB Soft, x 24 dB Hard)
    float sensitivity = 0.5f;    // 0..1  detection threshold, in standard deviations of the averaged band level
    float attackMs    = 15.0f;   // per-band reduction attack
    float releaseMs   = 200.0f;  // per-band reduction release
    bool  hardKnee    = false;   // false = Soft mapping, true = Hard mapping
    float stereoLink  = 0.0f;    // 0..1  blend of each channel's reduction towards max(L, R)

    // HOOK (not implemented in stage 1, ignored): per-grid-band focus / sensitivity weight, length numBands().
    const float* focusWeight = nullptr;
};

// HOOK (not implemented in stage 1): per-region output. Stage 1 has exactly one full-band region and
// regionOutput() returns zeros.
struct RegionOutput
{
    float maxReductionDb = 0.0f;
    float activity       = 0.0f;
};

class Core
{
public:
    Core();
    ~Core();
    Core(const Core&) = delete;
    Core& operator=(const Core&) = delete;

    // Allocates everything process() will ever touch. numChannels is clamped to 1..kMaxChannels.
    void prepare(double sampleRate, int maxBlockSize, int numChannels);
    void release();
    // Clears all signal state (FIFOs, overlap-add, detector, gain smoothers). RT-safe.
    void reset() noexcept;

    static int fftSizeFor(double sampleRate) noexcept;
    // Latency in samples for a given rate (constant; independent of every Params field).
    static int latencyFor(double sampleRate) noexcept { return fftSizeFor(sampleRate); }
    int currentLatency() const noexcept { return fftSize_; }

    // In place. Channels [0, min(numChannels, prepared channels)) are processed; any others are untouched.
    // numSamples may be any value >= 0 (it is NOT limited to the prepared maxBlockSize).
    void process(float* const* channels, int numChannels, int numSamples, const Params& p) noexcept;

    // ---- hooks (stage 1: not implemented) ----
    int numRegions() const noexcept { return 1; }
    RegionOutput regionOutput(int /*regionIndex*/) const noexcept { return {}; }

    // ---- introspection (tests / bench; read on the processing thread between process() calls) ----
    int fftSize() const noexcept { return fftSize_; }
    int hopSize() const noexcept { return hop_; }
    int numBins() const noexcept { return fftSize_ / 2 + 1; }
    double sampleRate() const noexcept { return sampleRate_; }
    long long framesProcessed() const noexcept { return frames_; }

private:
    struct Channel
    {
        std::vector<float> inFifo;    // last N input samples; the newest hop is filled at [N - H, N)
        std::vector<float> outAcc;    // overlap-add accumulator, N samples, index 0 = oldest output
        std::vector<float> outFifo;   // H finished output samples handed out during the next hop
        std::vector<float> fftBuf;    // 2N (JUCE real-FFT layout)
        std::vector<float> binGain;   // N/2 + 1 real gains applied to this frame
    };

    void processFrame(int numCh, const Params& p) noexcept;
    // Detector + gain computer: writes Channel::binGain for channels [0, numCh). Returns false when every
    // gain is exactly 1 (the multiply is then skipped).
    bool computeGains(int numCh, const Params& p) noexcept;

    double sampleRate_ = 0.0;
    int fftSize_ = 0, hop_ = 0, numChannels_ = 0;
    int hopFill_ = 0;
    long long frames_ = 0;

    std::unique_ptr<juce::dsp::FFT> fft_;
    std::vector<float> window_;      // sqrt-Hann (periodic), analysis
    std::vector<float> synthesis_;   // sqrt-Hann × 1/Σw² of its hop phase
    Channel ch_[kMaxChannels];
};

} // namespace xleth::dsp::resonance
