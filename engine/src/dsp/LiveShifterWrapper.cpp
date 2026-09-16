#include "dsp/LiveShifterWrapper.h"

#include <rubberband/RubberBandLiveShifter.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <map>
#include <mutex>
#include <tuple>

namespace xleth::dsp {

using RubberBand::RubberBandLiveShifter;

namespace {

// Sweep resolution for the getStartDelay() maximum. getStartDelay() itself does
// no processing, but on this engine it re-measures the resampler delay on every
// setPitchScale() while m_firstProcess is true, so a fine grid is not free. One
// semitone is plenty for a figure that is diagnostic only.
constexpr double kSweepStepSemis = 1.0;

// Calibration run length, per grid point. `settle` lets the internal rings
// re-equilibrate after the pitch change; `capture` must comfortably exceed the
// longest delay (6396 samples at 48 kHz, i.e. 13 blocks) plus the impulse
// response's own spread.
constexpr int kCalSettleBlocks  = 24;
constexpr int kCalCaptureBlocks = 24;

// Silent blocks run through the shifter at the end of prepare(), to flush the
// first-block pre-pad. Must exceed the longest pad in blocks: ceil(ws * p) at
// +24 st is 10368 input samples, i.e. 21 blocks.
constexpr int kPrimeBlocks = 32;

// Where an impulse response's energy is centred, as the midpoint of the
// kEnergyWindow-sample window holding the most energy.
//
// Neither of the obvious estimators works here. The raw peak flips between
// comparable lobes of the shifter's spread-out response as the ratio changes
// (a lone 331-sample outlier at +18 st while its neighbours agreed to within 4).
// The energy median is dragged around by the response's long tail, which also
// changes shape with ratio (it disagreed with a direct measurement by 741
// samples at the same point). Smoothing first, then taking the peak, is stable
// against both.
int smoothedEnergyPeak(const std::vector<float>& x)
{
    constexpr int kEnergyWindow = 128;

    const int n = (int) x.size();
    if (n <= kEnergyWindow) return n / 2;

    double run = 0.0;
    for (int i = 0; i < kEnergyWindow; ++i) run += (double) x[(size_t) i] * x[(size_t) i];

    double best    = run;
    int    bestPos = 0;
    for (int i = kEnergyWindow; i < n; ++i)
    {
        run += (double) x[(size_t) i] * x[(size_t) i];
        run -= (double) x[(size_t) (i - kEnergyWindow)] * x[(size_t) (i - kEnergyWindow)];
        if (run > best) { best = run; bestPos = i - kEnergyWindow + 1; }
    }

    if (best <= 0.0) return 0;
    return bestPos + kEnergyWindow / 2;
}

// R3LiveShifter::getStartDelay() returns size_t but computes a plain int that
// is negative for downward shifts. Round-trip through int64_t to recover the
// sign, then clamp: a negative "delay" means the shifter is early, which no
// amount of padding can express and which we do not want polluting the max.
int signedStartDelay(const RubberBandLiveShifter& s)
{
    const auto sgn = static_cast<std::int64_t>(s.getStartDelay());
    if (sgn < 0) return 0;
    if (sgn > static_cast<std::int64_t>(INT32_MAX)) return 0;
    return static_cast<int>(sgn);
}

// Calibration is deterministic for a given (rate, channels, options), and it is
// the one expensive part of prepare(), so it is memoised for the process. The
// table is tiny (25 ints per entry) and configurations are few.
using CalKey = std::tuple<int, int, int>;

std::mutex                      g_calMutex;
std::map<CalKey, std::vector<int>> g_calCache;

// prepare()'s calibration deliberately runs the shifter through repeated
// reset()+shift() cycles before it is warmed up (measureDelayAtRatio, the
// prime loop in prepare()/reset()). R3LiveShifter's first shift() after a
// reset() legitimately under-produces while its pre-pad drains, and it
// reports that at Log level 0 — which, per RubberBandLiveShifter.h's Logger
// contract, is NOT gated by setDebugLevel() the way levels 1+ are (the
// library treats 0 as "always tell someone"). Passing this no-op Logger to
// the constructor is the documented, non-vendored way to divert that: it
// only ever runs during prepare()/reset(), both message-thread-only per this
// wrapper's contract (see the class header), so dropping the message here
// changes no audio-thread behaviour — the fallback fill in R3LiveShifter's
// shift() runs regardless of whether anything logs it.
struct SilentLogger : RubberBandLiveShifter::Logger
{
    void log(const char*) override {}
    void log(const char*, double) override {}
    void log(const char*, double, double) override {}
};

const std::shared_ptr<RubberBandLiveShifter::Logger> g_silentLogger =
    std::make_shared<SilentLogger>();

} // namespace

LiveShifterWrapper::LiveShifterWrapper() = default;

// Out of line so the unique_ptr<RubberBandLiveShifter> can be destroyed with
// only a forward declaration in the header.
LiveShifterWrapper::~LiveShifterWrapper() = default;

int LiveShifterWrapper::optionFlags() const noexcept
{
    int opts = 0;
    opts |= (window_ == Window::Medium)
              ? RubberBandLiveShifter::OptionWindowMedium
              : RubberBandLiveShifter::OptionWindowShort;
    opts |= (formantOption_.load(std::memory_order_relaxed) == (int) Formant::Preserved)
              ? RubberBandLiveShifter::OptionFormantPreserved
              : RubberBandLiveShifter::OptionFormantShifted;
    opts |= channelsTogether_
              ? RubberBandLiveShifter::OptionChannelsTogether
              : RubberBandLiveShifter::OptionChannelsApart;
    return opts;
}

void LiveShifterWrapper::setWindowOption(Window w)
{
    if (w == window_) return;
    window_ = w;
    // Construction-time option: the only way to change it is a new shifter.
    if (prepared_) prepare(sampleRate_, numChannels_, maxBlockSize_);
}

void LiveShifterWrapper::setChannelsTogether(bool together)
{
    if (together == channelsTogether_) return;
    channelsTogether_ = together;
    if (prepared_) prepare(sampleRate_, numChannels_, maxBlockSize_);
}

void LiveShifterWrapper::setPitch(int semitones, int cents) noexcept
{
    const double semis = std::clamp((double) semitones + (double) cents / 100.0,
                                    -kMaxSemitones, kMaxSemitones);
    semisTarget_.store(semis, std::memory_order_relaxed);
    pitchTarget_.store(std::pow(2.0, semis / 12.0), std::memory_order_relaxed);
}

void LiveShifterWrapper::setFormantScale(float scale) noexcept
{
    // 0.0 is Rubber Band's "automatic" sentinel and must survive unclamped.
    const double v = (scale <= 0.0f) ? 0.0 : std::clamp((double) scale, 0.25, 4.0);
    formantTarget_.store(v, std::memory_order_relaxed);
}

void LiveShifterWrapper::setFormantOption(Formant f) noexcept
{
    formantOption_.store((int) f, std::memory_order_relaxed);
}

void LiveShifterWrapper::rebuild()
{
    shifter_ = std::make_unique<RubberBandLiveShifter>(
        (size_t) std::lround(sampleRate_), (size_t) numChannels_,
        g_silentLogger, optionFlags());

    // Level 0 is the only level the header guarantees realtime safe by default
    // (levels 2+ may construct messages by allocation). The silent Logger
    // above is what actually stops prepare()'s calibration transient from
    // reaching stderr — see its comment.
    shifter_->setDebugLevel(0);
}

int LiveShifterWrapper::sweepMaxStartDelay()
{
    // Must run before the first shift(): R3LiveShifter only re-measures its
    // resampler delays from setPitchScale() while m_firstProcess is true.
    const double requested = pitchTarget_.load(std::memory_order_relaxed);

    int worst = 0;
    auto probe = [&](double semis)
    {
        shifter_->setPitchScale(std::pow(2.0, semis / 12.0));
        worst = std::max(worst, signedStartDelay(*shifter_));
    };

    for (double semis = -kMaxSemitones; semis <= kMaxSemitones + 1e-9;
         semis += kSweepStepSemis)
        probe(semis);

    // Endpoints exactly, in case the grid stepped past them.
    probe(-kMaxSemitones);
    probe(0.0);
    probe(kMaxSemitones);

    shifter_->setPitchScale(requested);
    return worst;
}

int LiveShifterWrapper::measureDelayAtRatio(double ratio, int settleBlocks, int captureBlocks)
{
    // Runs the shifter directly, bypassing the FIFO adapter and the pad line,
    // so what comes back is the shifter's own pipeline delay.
    //
    // Each point is measured along the SAME path the runtime takes - reset,
    // prime at unity, jump to the target pitch, settle - rather than by walking
    // the grid. That matters because the delay is not a pure function of pitch:
    // measured by walking the grid, +18 st reads 4293 samples, but reached by a
    // jump from unity it reads 5571. Calibrating along one path and running
    // along another just bakes the difference into the compensation.
    for (int c = 0; c < numChannels_; ++c)
        shiftIn_.clear(c, 0, blockSize_);

    shifter_->reset();
    shifter_->setPitchScale(1.0);
    for (int i = 0; i < kPrimeBlocks; ++i)
        shifter_->shift(shiftInPtrs_.data(), shiftOutPtrs_.data());

    shifter_->setPitchScale(ratio);
    for (int i = 0; i < settleBlocks; ++i)
        shifter_->shift(shiftInPtrs_.data(), shiftOutPtrs_.data());

    calScratch_.assign((size_t) (captureBlocks * blockSize_), 0.0f);

    for (int b = 0; b < captureBlocks; ++b)
    {
        for (int c = 0; c < numChannels_; ++c)
            shiftIn_.clear(c, 0, blockSize_);
        if (b == 0)
            for (int c = 0; c < numChannels_; ++c)
                shiftIn_.setSample(c, 0, 1.0f);

        shifter_->shift(shiftInPtrs_.data(), shiftOutPtrs_.data());

        const float* out = shiftOut_.getReadPointer(0);
        for (int i = 0; i < blockSize_; ++i)
            calScratch_[(size_t) (b * blockSize_ + i)] = out[i];
    }

    return smoothedEnergyPeak(calScratch_);
}

void LiveShifterWrapper::calibrateDelayCurve()
{
    const CalKey key { (int) std::lround(sampleRate_), numChannels_, optionFlags() };

    {
        std::lock_guard<std::mutex> lk(g_calMutex);
        const auto it = g_calCache.find(key);
        if (it != g_calCache.end())
        {
            delayCurve_ = it->second;
            return;
        }
    }

    delayCurve_.assign(kCalPoints, 0);
    for (int i = 0; i < kCalPoints; ++i)
    {
        const double semis = -kMaxSemitones + (double) (i * kCalStepSemis);
        delayCurve_[(size_t) i] = measureDelayAtRatio(std::pow(2.0, semis / 12.0),
                                                      kCalSettleBlocks, kCalCaptureBlocks);
    }

    calScratch_ = std::vector<float>();   // message-thread scratch, not audio state

    std::lock_guard<std::mutex> lk(g_calMutex);
    g_calCache[key] = delayCurve_;
}

int LiveShifterWrapper::getCalibratedDelayAt(double semitones) const noexcept
{
    if (delayCurve_.size() != (size_t) kCalPoints) return 0;

    const double s = std::clamp(semitones, -kMaxSemitones, kMaxSemitones);
    const double x = (s + kMaxSemitones) / (double) kCalStepSemis;

    int i = (int) x;
    if (i >= kCalPoints - 1) return delayCurve_[(size_t) (kCalPoints - 1)];

    const double f = x - (double) i;
    const double a = (double) delayCurve_[(size_t) i];
    const double b = (double) delayCurve_[(size_t) (i + 1)];
    return (int) std::lround(a + f * (b - a));
}

void LiveShifterWrapper::prepare(double sampleRate, int numChannels, int maxBlockSize)
{
    prepared_ = false;

    sampleRate_   = (sampleRate > 0.0) ? sampleRate : 48000.0;
    numChannels_  = std::max(1, numChannels);
    maxBlockSize_ = std::max(1, maxBlockSize);

    rebuild();

    blockSize_ = (int) shifter_->getBlockSize();
    if (blockSize_ <= 0) return;

    // Diagnostic only, and it must happen before the first shift() - see
    // finding (a) in the header.
    maxStartDelay_ = sweepMaxStartDelay();

    const int fifoCap = blockSize_ + maxBlockSize_;
    inFifo_  .setSize(numChannels_, fifoCap,   false, true, false);
    outFifo_ .setSize(numChannels_, fifoCap,   false, true, false);
    shiftIn_ .setSize(numChannels_, blockSize_, false, true, false);
    shiftOut_.setSize(numChannels_, blockSize_, false, true, false);

    shiftInPtrs_ .assign((size_t) numChannels_, nullptr);
    shiftOutPtrs_.assign((size_t) numChannels_, nullptr);
    for (int c = 0; c < numChannels_; ++c)
    {
        shiftInPtrs_ [(size_t) c] = shiftIn_ .getReadPointer(c);
        shiftOutPtrs_[(size_t) c] = shiftOut_.getWritePointer(c);
    }

    // Measure what the pipeline actually does, then pad to its worst case.
    calibrateDelayCurve();

    targetDelay_ = *std::max_element(delayCurve_.begin(), delayCurve_.end());
    const int minDelay = *std::min_element(delayCurve_.begin(), delayCurve_.end());

    latencySamples_ = blockSize_ + targetDelay_;

    padCapacity_ = (targetDelay_ - minDelay) + 8;
    padLine_.setSize(numChannels_, padCapacity_, false, true, false);

    // Calibration left the shifter warm and mid-sweep; put it back to a known
    // state and to the pitch the caller actually asked for.
    // Prime away the start-up transient, AT UNITY. reset() re-arms
    // R3LiveShifter's first-block pre-pad (R3LiveShifter.cpp:337-346), which is
    // ceil(ws * p) input zeros - 10368 of them at +24 st - so without this the
    // first few hundred milliseconds of audio come out later than the latency
    // we report, by a pitch-dependent amount. Priming at unity rather than at
    // the staged pitch also makes this the exact path the calibration measured,
    // so the compensation matches what the pipeline actually does.
    shifter_->reset();
    shifter_->setPitchScale(1.0);

    for (int c = 0; c < numChannels_; ++c)
        shiftIn_.clear(c, 0, blockSize_);
    for (int i = 0; i < kPrimeBlocks; ++i)
        shifter_->shift(shiftInPtrs_.data(), shiftOutPtrs_.data());

    shifter_->setPitchScale(pitchTarget_.load(std::memory_order_relaxed));

    appliedPitch_      = pitchTarget_.load(std::memory_order_relaxed);
    appliedFormant_    = -1.0;
    appliedFormantOpt_ = -1;

    inFifo_.clear();
    outFifo_.clear();
    inCount_  = 0;
    outCount_ = blockSize_;   // pre-fill: see the FIFO invariant in the header

    padLine_.clear();
    padWrite_    = 0;
    padCurrent_  = targetDelay_ - getCalibratedDelayAt(
                       semisTarget_.load(std::memory_order_relaxed));
    padPrevious_ = padCurrent_;
    padFade_     = 0;

    prepared_ = true;
}

void LiveShifterWrapper::reset()
{
    if (! prepared_) return;

    shifter_->reset();
    shifter_->setPitchScale(1.0);

    for (int c = 0; c < numChannels_; ++c)
        shiftIn_.clear(c, 0, blockSize_);
    for (int i = 0; i < kPrimeBlocks; ++i)
        shifter_->shift(shiftInPtrs_.data(), shiftOutPtrs_.data());

    shifter_->setPitchScale(appliedPitch_);

    inFifo_.clear();
    outFifo_.clear();
    inCount_  = 0;
    outCount_ = blockSize_;

    padLine_.clear();
    padWrite_    = 0;
    padPrevious_ = padCurrent_;
    padFade_     = 0;
}

void LiveShifterWrapper::applyStagedParams() noexcept
{
    // Audio thread, called only between whole-block shift() calls - never
    // concurrently with one, which is what the LiveShifter header requires.
    const double p = pitchTarget_.load(std::memory_order_relaxed);
    if (p != appliedPitch_)
    {
        shifter_->setPitchScale(p);
        appliedPitch_ = p;
    }

    const int fo = formantOption_.load(std::memory_order_relaxed);
    if (fo != appliedFormantOpt_)
    {
        shifter_->setFormantOption(fo == (int) Formant::Preserved
                                       ? RubberBandLiveShifter::OptionFormantPreserved
                                       : RubberBandLiveShifter::OptionFormantShifted);
        appliedFormantOpt_ = fo;
    }

    const double f = formantTarget_.load(std::memory_order_relaxed);
    if (f != appliedFormant_)
    {
        shifter_->setFormantScale(f);
        appliedFormant_ = f;
    }
}

void LiveShifterWrapper::process(juce::AudioBuffer<float>& block) noexcept
{
    if (! prepared_) return;

    const int n  = block.getNumSamples();
    const int ch = block.getNumChannels();
    if (n <= 0 || n > maxBlockSize_ || ch <= 0 || ch > numChannels_) return;

    // --- 1. Push the caller's block into the input FIFO. ---
    for (int c = 0; c < ch; ++c)
        inFifo_.copyFrom(c, inCount_, block, c, 0, n);
    // Channels the shifter has but the caller did not supply stay silent.
    for (int c = ch; c < numChannels_; ++c)
        inFifo_.clear(c, inCount_, n);
    inCount_ += n;

    // --- 2. Drain whole shifter blocks. ---
    while (inCount_ >= blockSize_)
    {
        for (int c = 0; c < numChannels_; ++c)
            shiftIn_.copyFrom(c, 0, inFifo_, c, 0, blockSize_);

        // Consume from the front of the input FIFO.
        inCount_ -= blockSize_;
        if (inCount_ > 0)
            for (int c = 0; c < numChannels_; ++c)
            {
                float* p = inFifo_.getWritePointer(c);
                // Overlapping ranges - memmove, not FloatVectorOperations::copy.
                std::memmove(p, p + blockSize_, sizeof(float) * (size_t) inCount_);
            }

        // The one legal window for parameter changes.
        applyStagedParams();

        shifter_->shift(shiftInPtrs_.data(), shiftOutPtrs_.data());

        for (int c = 0; c < numChannels_; ++c)
            outFifo_.copyFrom(c, outCount_, shiftOut_, c, 0, blockSize_);
        outCount_ += blockSize_;
    }

    // --- 3. Pop n frames off the output FIFO. ---
    // The invariant inCount_ + outCount_ == blockSize_ (restored at the end of
    // every process()) guarantees outCount_ >= n here: after the drain loop
    // inCount_ < blockSize_, so outCount_ = blockSize_ + n - inCount_ > n.
    for (int c = 0; c < ch; ++c)
        block.copyFrom(c, 0, outFifo_, c, 0, n);

    outCount_ -= n;
    if (outCount_ > 0)
        for (int c = 0; c < numChannels_; ++c)
        {
            float* p = outFifo_.getWritePointer(c);
            std::memmove(p, p + n, sizeof(float) * (size_t) outCount_);
        }

    // --- 4. Pad to the constant total latency. ---
    // The shifter's own delay is a pure function of the current pitch (measured:
    // no hysteresis, see the header), so topping it up to the calibrated worst
    // case keeps the total fixed at latencySamples_ whatever pitch is playing.
    const double semis  = semisTarget_.load(std::memory_order_relaxed);
    const int    wanted = std::clamp(targetDelay_ - getCalibratedDelayAt(semis),
                                     0, padCapacity_ - 2);

    if (wanted != padCurrent_ && padFade_ == 0)
    {
        padPrevious_ = padCurrent_;
        padCurrent_  = wanted;
        padFade_     = kPadFadeLen;
    }

    for (int i = 0; i < n; ++i)
    {
        for (int c = 0; c < ch; ++c)
            padLine_.setSample(c, padWrite_, block.getSample(c, i));

        auto tap = [&](int c, int depth) noexcept
        {
            int r = padWrite_ - depth;
            if (r < 0) r += padCapacity_;
            return padLine_.getSample(c, r);
        };

        if (padFade_ > 0)
        {
            const float a = 1.0f - (float) padFade_ / (float) kPadFadeLen;
            for (int c = 0; c < ch; ++c)
                block.setSample(c, i, (1.0f - a) * tap(c, padPrevious_) + a * tap(c, padCurrent_));
            --padFade_;
        }
        else
        {
            for (int c = 0; c < ch; ++c)
                block.setSample(c, i, tap(c, padCurrent_));
        }

        padWrite_ = (padWrite_ + 1 == padCapacity_) ? 0 : padWrite_ + 1;
    }
}

} // namespace xleth::dsp
