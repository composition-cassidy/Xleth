#include "Metronome.h"

#include <algorithm>
#include <cmath>

namespace xleth
{

Metronome::Metronome() = default;

void Metronome::prepare(double deviceSampleRate)
{
    if (deviceSampleRate > 0.0)
        deviceRate_.store(deviceSampleRate, std::memory_order_relaxed);
}

void Metronome::setVolume(float gain01)
{
    volume_.store(std::clamp(gain01, 0.0f, 1.0f), std::memory_order_relaxed);
}

void Metronome::setSound(int soundIndex)
{
    sound_.store(std::clamp(soundIndex, 0, 2), std::memory_order_relaxed);
}

void Metronome::setBeatsPerBar(int beats)
{
    beatsPerBar_.store(std::clamp(beats, 1, 32), std::memory_order_relaxed);
}

double Metronome::playbackRatio(double clickRate, double deviceRate, bool accent)
{
    const double base = deviceRate > 0.0 ? clickRate / deviceRate : 1.0;
    // +3 semitones == 2^(3/12): reading the click faster raises pitch (and
    // shortens it) exactly as a varispeed resample does.
    return accent ? base * std::pow(2.0, static_cast<double>(kAccentSemitones) / 12.0)
                  : base;
}

int64_t Metronome::beatSample(int64_t k, double samplesPerBeat)
{
    return static_cast<int64_t>(std::llround(static_cast<double>(k) * samplesPerBeat));
}

int Metronome::activeVoices() const
{
    int n = 0;
    for (const auto& v : voices_)
        n += v.active ? 1 : 0;
    return n;
}

// Catmull-Rom cubic through x[i-1..i+2]; samples outside the click are silence.
float Metronome::readCubic(const int16_t* x, int n, double pos)
{
    const int    i = static_cast<int>(pos);
    const float  t = static_cast<float>(pos - i);
    auto at = [&](int j) -> float {
        return (j < 0 || j >= n) ? 0.0f : static_cast<float>(x[j]) * (1.0f / 32768.0f);
    };
    const float y0 = at(i - 1), y1 = at(i), y2 = at(i + 1), y3 = at(i + 2);
    const float c1 = 0.5f * (y2 - y0);
    const float c2 = y0 - 2.5f * y1 + 2.0f * y2 - 0.5f * y3;
    const float c3 = 0.5f * (y3 - y0) + 1.5f * (y1 - y2);
    return ((c3 * t + c2) * t + c1) * t + y1;
}

void Metronome::startVoice(bool accent)
{
    const metronome_data::ClickData* data = &metronome_data::gBump;
    switch (static_cast<Sound>(sound_.load(std::memory_order_relaxed)))
    {
        case Sound::Hat: data = &metronome_data::gHat; break;
        case Sound::Rim: data = &metronome_data::gRim; break;
        default: break;
    }

    // Reuse a free slot, else steal round-robin (the oldest click is the
    // quietest - these are ~100 ms transients).
    int slot = -1;
    for (int i = 0; i < kMaxVoices; ++i)
    {
        const int idx = (nextVoice_ + i) % kMaxVoices;
        if (!voices_[idx].active) { slot = idx; break; }
    }
    if (slot < 0) slot = nextVoice_;
    nextVoice_ = (slot + 1) % kMaxVoices;

    Voice& v = voices_[slot];
    v.active = true;
    v.pos    = 0.0;
    v.step   = playbackRatio(data->sampleRate, deviceRate_.load(std::memory_order_relaxed), accent);
    v.gain   = volume_.load(std::memory_order_relaxed);
    v.data   = data;
}

void Metronome::renderVoices(float* const* channels, int numChannels, int from, int to)
{
    if (to <= from) return;
    for (auto& v : voices_)
    {
        if (!v.active) continue;
        const int n = v.data->frames;
        for (int i = from; i < to; ++i)
        {
            if (v.pos >= static_cast<double>(n)) { v.active = false; break; }
            const float s = readCubic(v.data->pcm, n, v.pos) * v.gain;
            for (int c = 0; c < numChannels; ++c)
                channels[c][i] += s;
            v.pos += v.step;
        }
    }
}

void Metronome::process(float* const* channels, int numChannels, int numSamples,
                        int64_t chunkStart, double bpm, bool playing)
{
    if (numSamples <= 0 || numChannels <= 0)
        return;

    const bool   enabled = enabled_.load(std::memory_order_relaxed);
    const double sr      = deviceRate_.load(std::memory_order_relaxed);

    int cursor = 0;
    if (enabled && playing && bpm > 0.0 && sr > 0.0)
    {
        const double  spb      = sr * 60.0 / bpm;
        const int64_t perBar   = getBeatsPerBar();
        const int64_t chunkEnd = chunkStart + numSamples;

        // Start one beat early: llround(k*spb) can land on either side of
        // chunkStart for the beat straddling it. Every beat falls in exactly
        // one contiguous chunk because beatSample() is a pure function of k.
        int64_t k = static_cast<int64_t>(std::floor(static_cast<double>(chunkStart) / spb)) - 1;
        if (k < 0) k = 0;
        for (;; ++k)
        {
            const int64_t at = beatSample(k, spb);
            if (at >= chunkEnd) break;
            if (at < chunkStart) continue;

            const int off = static_cast<int>(at - chunkStart);
            renderVoices(channels, numChannels, cursor, off);
            cursor = off;
            startVoice(/*accent*/ (k % perBar) == 0);
        }
    }
    renderVoices(channels, numChannels, cursor, numSamples);
}

} // namespace xleth
