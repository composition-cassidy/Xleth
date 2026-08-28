#include "sandbox/SandboxPitchTrack.h"

namespace xleth::sandbox {

SandboxPitchTrackAnalyzer::SandboxPitchTrackAnalyzer(size_t maxEntries)
    : maxEntries_(maxEntries)
{
}

SandboxPitchTrackResult SandboxPitchTrackAnalyzer::analyze(int sourceBufferId,
                                                            const SandboxBuffer& buffer,
                                                            double sampleRate)
{
    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = map_.find(sourceBufferId);
        if (it != map_.end()) {
            lruOrder_.splice(lruOrder_.begin(), lruOrder_, it->second.lruIt);
            return it->second.result;
        }
    }

    const int numSamples  = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (sampleRate <= 0.0 || numSamples <= 0 || numChannels <= 0)
        return {};

    // Mono-sum (average) — the analyzer tracks one pitch curve per buffer,
    // same convention as SandboxSpectrogramAnalyzer::analyze.
    std::vector<float> mono(static_cast<size_t>(numSamples));
    const float scale = 1.0f / static_cast<float>(numChannels);
    for (int i = 0; i < numSamples; ++i) {
        float sum = 0.0f;
        for (int ch = 0; ch < numChannels; ++ch) sum += buffer.getSample(ch, i);
        mono[static_cast<size_t>(i)] = sum * scale;
    }

    auto track = std::make_shared<xleth::dsp::PitchTrackResult>(
        xleth::dsp::analyzePitchTrack(mono.data(), numSamples, sampleRate));
    if (!track->valid()) return {};

    SandboxPitchTrackResult result;
    result.track = track;

    std::lock_guard<std::mutex> lock(mu_);
    auto it = map_.find(sourceBufferId);
    if (it != map_.end()) {
        // Lost a race with another caller analyzing the same id — keep
        // whichever is already cached rather than double-inserting.
        lruOrder_.splice(lruOrder_.begin(), lruOrder_, it->second.lruIt);
        return it->second.result;
    }
    insertLocked(sourceBufferId, result);
    return result;
}

SandboxPitchTrackResult SandboxPitchTrackAnalyzer::lookup(int sourceBufferId)
{
    std::lock_guard<std::mutex> lock(mu_);
    auto it = map_.find(sourceBufferId);
    if (it == map_.end()) return {};
    lruOrder_.splice(lruOrder_.begin(), lruOrder_, it->second.lruIt);
    return it->second.result;
}

void SandboxPitchTrackAnalyzer::primeCache(int sourceBufferId, xleth::dsp::PitchTrackResult result)
{
    if (!result.valid()) return;

    SandboxPitchTrackResult wrapped;
    wrapped.track = std::make_shared<xleth::dsp::PitchTrackResult>(std::move(result));

    std::lock_guard<std::mutex> lock(mu_);
    insertLocked(sourceBufferId, wrapped);
}

void SandboxPitchTrackAnalyzer::insertLocked(int sourceBufferId, SandboxPitchTrackResult result)
{
    auto it = map_.find(sourceBufferId);
    if (it != map_.end()) {
        lruOrder_.splice(lruOrder_.begin(), lruOrder_, it->second.lruIt);
        it->second.result = std::move(result);
        return;
    }
    lruOrder_.push_front(sourceBufferId);
    map_[sourceBufferId] = Entry{ std::move(result), lruOrder_.begin() };
    while (map_.size() > maxEntries_) {
        const int victim = lruOrder_.back();
        lruOrder_.pop_back();
        map_.erase(victim);
    }
}

void SandboxPitchTrackAnalyzer::clearCache()
{
    std::lock_guard<std::mutex> lock(mu_);
    map_.clear();
    lruOrder_.clear();
}

size_t SandboxPitchTrackAnalyzer::entryCount() const
{
    std::lock_guard<std::mutex> lock(mu_);
    return map_.size();
}

} // namespace xleth::sandbox
