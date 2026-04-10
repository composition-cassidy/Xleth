#include "Transport.h"

#include <cmath>

Transport::Transport() = default;

// ─────────────────────────────────────────────────────────────────────────────
void Transport::setSampleRate(double sr)
{
    sampleRate_ = sr;
}

void Transport::setBPM(double bpm)
{
    bpm_.store(bpm, std::memory_order_relaxed);
}

// ─────────────────────────────────────────────────────────────────────────────
void Transport::play()
{
    playing_.store(true, std::memory_order_release);
}

void Transport::stop()
{
    playing_.store(false, std::memory_order_release);
    positionSamples_.store(0, std::memory_order_release);
}

void Transport::pause()
{
    playing_.store(false, std::memory_order_release);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO THREAD ONLY — no alloc, no logging, no locks
void Transport::advance(int numSamples)
{
    if (!playing_.load(std::memory_order_acquire))
        return;
    positionSamples_.fetch_add(numSamples, std::memory_order_release);
}

// ─────────────────────────────────────────────────────────────────────────────
int64_t Transport::getPositionSamples() const
{
    return positionSamples_.load(std::memory_order_acquire);
}

double Transport::getPositionSeconds() const
{
    return samplesToSeconds(getPositionSamples());
}

double Transport::getPositionBeats() const
{
    return samplesToBeats(getPositionSamples());
}

int Transport::getPositionBars() const
{
    return static_cast<int>(std::floor(getPositionBeats() / 4.0)) + 1;
}

bool Transport::isPlaying() const
{
    return playing_.load(std::memory_order_acquire);
}

double Transport::getBPM() const
{
    return bpm_.load(std::memory_order_acquire);
}

double Transport::getSampleRate() const
{
    return sampleRate_;
}

// ─────────────────────────────────────────────────────────────────────────────
void Transport::seekToSample(int64_t sample)
{
    positionSamples_.store(sample, std::memory_order_release);
}

void Transport::seekToBeat(double beat)
{
    positionSamples_.store(beatsToSamples(beat), std::memory_order_release);
}

void Transport::seekToBar(int bar)
{
    seekToBeat(static_cast<double>(bar - 1) * 4.0);
}

// ─────────────────────────────────────────────────────────────────────────────
double Transport::samplesToSeconds(int64_t samples) const
{
    return static_cast<double>(samples) / sampleRate_;
}

double Transport::samplesToBeats(int64_t samples) const
{
    const double bpm = bpm_.load(std::memory_order_relaxed);
    // beats = samples / (sampleRate * 60 / bpm)
    return static_cast<double>(samples) / (sampleRate_ * 60.0 / bpm);
}

int64_t Transport::beatsToSamples(double beats) const
{
    const double bpm = bpm_.load(std::memory_order_relaxed);
    return static_cast<int64_t>(beats * (sampleRate_ * 60.0 / bpm));
}
