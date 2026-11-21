#pragma once

#include <array>
#include <atomic>
#include <cstdint>

namespace xleth
{
namespace metronome_data
{
/// One embedded click: mono 16-bit PCM at its native rate.
struct ClickData
{
    const int16_t* pcm;
    int            frames;
    int            sampleRate;
};
extern const ClickData gBump;
extern const ClickData gHat;
extern const ClickData gRim;
} // namespace metronome_data

/// Transport-synced click track.
///
///   * One click per beat; the FIRST beat of every bar is the accent, played
///     +3 semitones up. The pitch shift is plain resampling (the click is read
///     back 2^(3/12) times faster) - no time-stretcher, no PSOLA.
///   * Rendered AFTER the mix, outside the master bus: it is a monitoring aid,
///     so it never reaches export, the loudness meter or any effect chain.
///   * The beat grid is a pure function of the transport position, so seeking
///     and loop wraps need no state; it only fires while the transport plays.
///
/// Threading: setters are atomic and callable from any thread. prepare() is
/// main-thread only. process() is AUDIO-THREAD ONLY: no alloc, no locks.
class Metronome
{
public:
    enum class Sound : int { Bump = 0, Hat = 1, Rim = 2 };

    static constexpr int   kMaxVoices        = 16;
    static constexpr float kAccentSemitones  = 3.0f;
    static constexpr int   kDefaultBeatsPerBar = 4;

    Metronome();

    /// Main thread. Retains the device rate used for the resampling ratio.
    void prepare(double deviceSampleRate);

    void  setEnabled(bool on)           { enabled_.store(on, std::memory_order_relaxed); }
    bool  isEnabled() const             { return enabled_.load(std::memory_order_relaxed); }
    void  setVolume(float gain01);
    float getVolume() const             { return volume_.load(std::memory_order_relaxed); }
    void  setSound(int soundIndex);
    int   getSound() const              { return sound_.load(std::memory_order_relaxed); }
    void  setBeatsPerBar(int beats);
    int   getBeatsPerBar() const        { return beatsPerBar_.load(std::memory_order_relaxed); }

    /// Resampling ratio for a click: native/device rate, times the accent's
    /// pitch factor when `accent`. Public so the pitch maths is unit-testable.
    static double playbackRatio(double clickRate, double deviceRate, bool accent);

    /// Sample index of beat `k` (0-based) at this tempo. The single definition
    /// of the grid - process() and the tests both use it.
    static int64_t beatSample(int64_t k, double samplesPerBeat);

    /// AUDIO THREAD. Mixes (adds) clicks into `channels[0..numChannels)` for the
    /// `numSamples`-long chunk that starts at timeline sample `chunkStart`
    /// (callers pass the position already shifted by any compensation delay).
    /// Voices already sounding keep ringing out when `playing` is false.
    void process(float* const* channels, int numChannels, int numSamples,
                 int64_t chunkStart, double bpm, bool playing);

    /// Test hook: number of voices currently sounding.
    int activeVoices() const;

private:
    struct Voice
    {
        bool          active = false;
        double        pos    = 0.0;   // read position in source samples
        double        step   = 1.0;   // source samples per output sample
        float         gain   = 1.0f;
        const metronome_data::ClickData* data = nullptr;
    };

    void  startVoice(bool accent);
    void  renderVoices(float* const* channels, int numChannels, int from, int to);
    static float readCubic(const int16_t* x, int n, double pos);

    std::atomic<bool>  enabled_{ false };
    std::atomic<float> volume_{ 0.8f };
    std::atomic<int>   sound_{ static_cast<int>(Sound::Bump) };
    std::atomic<int>   beatsPerBar_{ kDefaultBeatsPerBar };
    std::atomic<double> deviceRate_{ 44100.0 };

    std::array<Voice, kMaxVoices> voices_{};
    int nextVoice_ = 0;
};

} // namespace xleth
