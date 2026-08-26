#include "sandbox/SandboxSpectrogram.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace xleth::sandbox {

SandboxSpectrogramAnalyzer::SandboxSpectrogramAnalyzer(size_t maxEntries)
    : maxEntries_(maxEntries)
{
    // Periodic Hann, matching ApexVizAccumulator's convention: sum(w) == N/2
    // exactly, which is what the 4/N magnitude normalisation below assumes.
    window_.assign(static_cast<size_t>(kFftSize), 0.0f);
    for (int n = 0; n < kFftSize; ++n) {
        window_[static_cast<size_t>(n)] =
            0.5f - 0.5f * std::cos(2.0f * juce::MathConstants<float>::pi
                                   * static_cast<float>(n) / static_cast<float>(kFftSize));
    }
}

uint64_t SandboxSpectrogramAnalyzer::contentHash(const std::vector<float>& mono, double sampleRate)
{
    // FNV-1a 64-bit over sampleRate + every sample byte. A full hash, not a
    // stride sample: this is a CACHE KEY, and a stride that happened to skip
    // an edited region would produce a false cache hit — a stale spectrogram
    // silently shown as current. See the header's cache-design note.
    uint64_t h = 1469598103934665603ull;
    auto mixByte = [&h](uint8_t b) {
        h ^= b;
        h *= 1099511628211ull;
    };
    uint64_t rateBits = 0;
    std::memcpy(&rateBits, &sampleRate, sizeof(rateBits));
    for (int i = 0; i < 8; ++i) mixByte(static_cast<uint8_t>(rateBits >> (i * 8)));

    const uint64_t n = static_cast<uint64_t>(mono.size());
    for (int i = 0; i < 8; ++i) mixByte(static_cast<uint8_t>(n >> (i * 8)));

    const auto* bytes = reinterpret_cast<const uint8_t*>(mono.data());
    const size_t byteCount = mono.size() * sizeof(float);
    for (size_t i = 0; i < byteCount; ++i) mixByte(bytes[i]);
    return h;
}

SandboxSpectrogramResult SandboxSpectrogramAnalyzer::analyze(const SandboxBuffer& buffer, double sampleRate)
{
    const int numSamples  = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (sampleRate <= 0.0 || numSamples <= 0 || numChannels <= 0)
        return {};

    // Mono-sum (average) — the SPC view is one image, not one per channel,
    // same as every other single-image analysis in this codebase (e.g.
    // ApexVizAccumulator::pushInput's 0.5*(L+R)).
    std::vector<float> mono(static_cast<size_t>(numSamples));
    const float scale = 1.0f / static_cast<float>(numChannels);
    for (int i = 0; i < numSamples; ++i) {
        float sum = 0.0f;
        for (int ch = 0; ch < numChannels; ++ch) sum += buffer.getSample(ch, i);
        mono[static_cast<size_t>(i)] = sum * scale;
    }

    const uint64_t hash = contentHash(mono, sampleRate);

    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = map_.find(hash);
        if (it != map_.end()) {
            lruOrder_.splice(lruOrder_.begin(), lruOrder_, it->second.lruIt);
            return it->second.result;
        }
    }

    // Frames cover the whole buffer at hop-sized steps; the trailing partial
    // frame is zero-padded rather than dropped, so numFrames*hopSize always
    // spans >= numSamples — the SPC canvas can map sample 0..numSamples-1 to
    // frame space with the same px-per-sample math the WAV canvas already
    // uses, with no separate "short last frame" case.
    const int numFrames = (numSamples + kHopSize - 1) / kHopSize;

    auto tokens = std::make_shared<std::vector<uint8_t>>(
        static_cast<size_t>(numFrames) * static_cast<size_t>(kNumBins), 0);

    std::vector<float> scratch(static_cast<size_t>(kFftSize) * 2u);
    constexpr float norm = 4.0f / static_cast<float>(kFftSize);

    for (int f = 0; f < numFrames; ++f) {
        const int start = f * kHopSize;
        std::fill(scratch.begin(), scratch.end(), 0.0f);
        const int available = std::min(kFftSize, numSamples - start);
        for (int n = 0; n < available; ++n)
            scratch[static_cast<size_t>(n)] = mono[static_cast<size_t>(start + n)] * window_[static_cast<size_t>(n)];

        fft_.performFrequencyOnlyForwardTransform(scratch.data());

        uint8_t* row = tokens->data() + static_cast<size_t>(f) * static_cast<size_t>(kNumBins);
        for (int k = 0; k < kNumBins; ++k) {
            const float mag = scratch[static_cast<size_t>(k)] * norm;
            const float db  = mag < 1.0e-6f ? -120.0f : 20.0f * std::log10(mag);
            const float t   = std::clamp((db - kMinDb) / (kMaxDb - kMinDb), 0.0f, 1.0f);
            row[k] = static_cast<uint8_t>(std::lround(t * 255.0f));
        }
    }

    SandboxSpectrogramResult result;
    result.tokens     = tokens;
    result.numFrames   = numFrames;
    result.numBins     = kNumBins;
    result.hopSize      = kHopSize;
    result.sampleRate  = sampleRate;
    result.minDb       = kMinDb;
    result.maxDb       = kMaxDb;

    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = map_.find(hash);
        if (it != map_.end()) {
            // Lost a race with another caller analyzing the same content —
            // keep whichever is already cached rather than double-inserting.
            lruOrder_.splice(lruOrder_.begin(), lruOrder_, it->second.lruIt);
            return it->second.result;
        }
        lruOrder_.push_front(hash);
        map_[hash] = Entry{ result, lruOrder_.begin() };
        while (map_.size() > maxEntries_) {
            const uint64_t victim = lruOrder_.back();
            lruOrder_.pop_back();
            map_.erase(victim);
        }
    }
    return result;
}

void SandboxSpectrogramAnalyzer::clearCache()
{
    std::lock_guard<std::mutex> lock(mu_);
    map_.clear();
    lruOrder_.clear();
}

size_t SandboxSpectrogramAnalyzer::entryCount() const
{
    std::lock_guard<std::mutex> lock(mu_);
    return map_.size();
}

} // namespace xleth::sandbox
