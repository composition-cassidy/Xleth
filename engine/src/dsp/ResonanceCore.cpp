#include "dsp/ResonanceCore.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace xleth::dsp::resonance
{

Core::Core() = default;
Core::~Core() = default;

int Core::fftSizeFor(double sampleRate) noexcept
{
    // ~21 ms frame: 1024 up to 50 kHz, then doubled per sample-rate octave.
    int n = 1024;
    double sr = sampleRate;
    while (sr > 50000.0 && n < 8192) { sr *= 0.5; n *= 2; }
    return n;
}

void Core::prepare(double sampleRate, int /*maxBlockSize*/, int numChannels)
{
    sampleRate_  = sampleRate > 0.0 ? sampleRate : 48000.0;
    fftSize_     = fftSizeFor(sampleRate_);
    hop_         = fftSize_ / 4;
    numChannels_ = std::clamp(numChannels, 1, kMaxChannels);

    int order = 0;
    while ((1 << order) < fftSize_) ++order;
    fft_ = std::make_unique<juce::dsp::FFT>(order);

    // sqrt of the periodic Hann window, used for analysis and (with the normalisation) synthesis.
    window_.assign(static_cast<size_t>(fftSize_), 0.0f);
    synthesis_.assign(static_cast<size_t>(fftSize_), 0.0f);
    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    for (int n = 0; n < fftSize_; ++n)
    {
        const double hann = 0.5 - 0.5 * std::cos(twoPi * n / fftSize_);
        window_[static_cast<size_t>(n)] = static_cast<float>(std::sqrt(std::max(hann, 0.0)));
    }
    // Per-hop-phase COLA normalisation 1 / sum_k w^2(phase + kH) (the RS WolaProcessor scheme). For the
    // periodic Hann at hop N/4 the sum is exactly 2; computing it keeps the reconstruction exact in float.
    for (int phase = 0; phase < hop_; ++phase)
    {
        double sum = 0.0;
        for (int n = phase; n < fftSize_; n += hop_)
            sum += static_cast<double>(window_[static_cast<size_t>(n)]) * window_[static_cast<size_t>(n)];
        const double norm = sum > 1.0e-8 ? 1.0 / sum : 1.0;
        for (int n = phase; n < fftSize_; n += hop_)
            synthesis_[static_cast<size_t>(n)] = static_cast<float>(window_[static_cast<size_t>(n)] * norm);
    }

    const int nb = fftSize_ / 2 + 1;
    for (int c = 0; c < kMaxChannels; ++c)
    {
        auto& ch = ch_[c];
        ch.inFifo.assign(static_cast<size_t>(fftSize_), 0.0f);
        ch.outAcc.assign(static_cast<size_t>(fftSize_), 0.0f);
        ch.outFifo.assign(static_cast<size_t>(hop_), 0.0f);
        ch.fftBuf.assign(static_cast<size_t>(fftSize_) * 2, 0.0f);
        ch.binGain.assign(static_cast<size_t>(nb), 1.0f);
    }
    reset();
}

void Core::release()
{
    fft_.reset();
    window_.clear(); window_.shrink_to_fit();
    synthesis_.clear(); synthesis_.shrink_to_fit();
    for (auto& ch : ch_)
    {
        ch.inFifo.clear(); ch.inFifo.shrink_to_fit();
        ch.outAcc.clear(); ch.outAcc.shrink_to_fit();
        ch.outFifo.clear(); ch.outFifo.shrink_to_fit();
        ch.fftBuf.clear(); ch.fftBuf.shrink_to_fit();
        ch.binGain.clear(); ch.binGain.shrink_to_fit();
    }
    fftSize_ = hop_ = numChannels_ = hopFill_ = 0;
    frames_ = 0;
}

void Core::reset() noexcept
{
    for (auto& ch : ch_)
    {
        std::fill(ch.inFifo.begin(), ch.inFifo.end(), 0.0f);
        std::fill(ch.outAcc.begin(), ch.outAcc.end(), 0.0f);
        std::fill(ch.outFifo.begin(), ch.outFifo.end(), 0.0f);
        std::fill(ch.fftBuf.begin(), ch.fftBuf.end(), 0.0f);
        std::fill(ch.binGain.begin(), ch.binGain.end(), 1.0f);
    }
    hopFill_ = 0;
    frames_ = 0;
}

void Core::process(float* const* channels, int numChannels, int numSamples, const Params& p) noexcept
{
    if (fftSize_ <= 0 || channels == nullptr || numSamples <= 0) return;
    const int nCh = std::min(numChannels, numChannels_);
    if (nCh <= 0) return;

    const int N = fftSize_, H = hop_;
    int pos = 0;
    while (pos < numSamples)
    {
        const int k = std::min(numSamples - pos, H - hopFill_);
        for (int c = 0; c < nCh; ++c)
        {
            float* x = channels[c] + pos;
            auto& ch = ch_[c];
            // Input first (in-place buffers): the newest hop of the analysis FIFO, then hand out output that
            // was finished one hop ago. Output time t leaves at real time t + N.
            std::memcpy(ch.inFifo.data() + (N - H + hopFill_), x, sizeof(float) * static_cast<size_t>(k));
            std::memcpy(x, ch.outFifo.data() + hopFill_, sizeof(float) * static_cast<size_t>(k));
        }
        hopFill_ += k;
        pos += k;
        if (hopFill_ == H)
        {
            processFrame(nCh, p);
            hopFill_ = 0;
        }
    }
}

void Core::processFrame(int numCh, const Params& p) noexcept
{
    const int N = fftSize_, H = hop_;
    const int nb = N / 2 + 1;

    for (int c = 0; c < numCh; ++c)
    {
        auto& ch = ch_[c];
        float* buf = ch.fftBuf.data();
        const float* in = ch.inFifo.data();
        const float* w = window_.data();
        for (int n = 0; n < N; ++n) buf[n] = in[n] * w[n];
        std::fill(buf + N, buf + 2 * N, 0.0f);
        fft_->performRealOnlyForwardTransform(buf, true);
    }

    const bool applyGain = computeGains(numCh, p);

    for (int c = 0; c < numCh; ++c)
    {
        auto& ch = ch_[c];
        float* buf = ch.fftBuf.data();
        if (applyGain)
        {
            const float* g = ch.binGain.data();
            for (int k = 0; k < nb; ++k)
            {
                buf[2 * k]     *= g[k];
                buf[2 * k + 1] *= g[k];
            }
        }
        fft_->performRealOnlyInverseTransform(buf);

        // Overlap-add: drop the hop that was handed out, append an empty hop, add this frame.
        float* acc = ch.outAcc.data();
        std::memmove(acc, acc + H, sizeof(float) * static_cast<size_t>(N - H));
        std::fill(acc + (N - H), acc + N, 0.0f);
        const float* sw = synthesis_.data();
        for (int n = 0; n < N; ++n) acc[n] += buf[n] * sw[n];
        // acc[0, H) has now received all N/H overlapping frames: it is final.
        std::memcpy(ch.outFifo.data(), acc, sizeof(float) * static_cast<size_t>(H));

        // Advance the analysis FIFO by one hop.
        float* in = ch.inFifo.data();
        std::memmove(in, in + H, sizeof(float) * static_cast<size_t>(N - H));
    }
    ++frames_;
}

bool Core::computeGains(int /*numCh*/, const Params& /*p*/) noexcept
{
    // Stage A skeleton: no detector yet, G(f) = 1.
    return false;
}

} // namespace xleth::dsp::resonance
