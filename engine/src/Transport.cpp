#include "Transport.h"
#include "audio/LoopTrap.h"
#include "render/RenderClock.h"

#include <cmath>

namespace {
// state_ packing; layout in Transport.h.
constexpr int64_t kPlayingBit = 2;
constexpr int64_t kArmedBit   = 1;

int64_t pack(int64_t pos, bool playing, bool armed)
{
    return pos * 4 + (playing ? kPlayingBit : 0) + (armed ? kArmedBit : 0);
}
int64_t posOf(int64_t s)     { return s >> 2; }   // arithmetic shift: exact for negative positions too
bool    playingOf(int64_t s) { return (s & kPlayingBit) != 0; }
bool    armedOf(int64_t s)   { return (s & kArmedBit) != 0; }

// Message-thread read-modify-write. Retried until nothing else (an advance(),
// another caller) wrote in between, so `next` is applied to the latest state.
template <typename F>
void updateState(std::atomic<int64_t>& state, F next)
{
    int64_t s = state.load(std::memory_order_relaxed);
    while (!state.compare_exchange_weak(s, next(s), std::memory_order_acq_rel,
                                        std::memory_order_relaxed)) {}
}
} // namespace

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
    // Arm immediately if the playhead starts inside the loop window; otherwise
    // stay disarmed and let advance() arm on natural entry (start-outside plays
    // linearly until it first crosses in).
    updateState(state_, [this](int64_t s) {
        const int64_t pos = posOf(s);
        return pack(pos, true, xleth::loopArmOnEvent(
            armedOf(s), /*keepLatch*/ false, pos,
            loopStartSamples_.load(std::memory_order_relaxed),
            loopEndSamples_.load(std::memory_order_relaxed),
            loopEnabled_.load(std::memory_order_relaxed)));
    });
}

void Transport::stop()
{
    state_.store(pack(0, false, false), std::memory_order_release);
}

void Transport::pause()
{
    updateState(state_, [](int64_t s) { return s & ~kPlayingBit; });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO THREAD ONLY — no alloc, no logging, no locks
void Transport::advance(int numSamples)
{
    int64_t s = state_.load(std::memory_order_acquire);
    for (;;)
    {
        // Stopped or paused — possibly while this block was rendering: honour it.
        if (!playingOf(s))
            return;

        // ── Loop wrap injected on the audio-as-master-clock path ────────────
        // The master sample clock is mutated HERE, on the audio thread, the same
        // instant the mix block is consumed. The position in state_ is the single
        // source of truth the renderer playhead follows (via getTransportState →
        // PlayheadClock). By wrapping the clock at the source — never moving the
        // renderer playhead independently — audio and the on-screen playhead stay
        // phase-locked, so the loop jump cannot tear A/V sync. The decision logic
        // is the pure, alloc/lock/log-free xleth::loopAdvance.
        const int64_t pos = posOf(s);
        bool armed = armedOf(s);
        const int64_t newPos = xleth::loopAdvance(
            pos, numSamples, armed,
            loopStartSamples_.load(std::memory_order_relaxed),
            loopEndSamples_.load(std::memory_order_relaxed),
            loopEnabled_.load(std::memory_order_relaxed));

        // CAS, not store: whatever landed since the load is never written over.
        if (state_.compare_exchange_weak(s, pack(newPos, true, armed),
                                         std::memory_order_acq_rel,
                                         std::memory_order_acquire))
            return;

        // s now holds what landed. A seek or stop moved the playhead: it wins
        // and this block's advance is dropped (MixEngine sees the jump as a
        // seek). Otherwise only the latch changed (play, setLoopBounds) or the
        // CAS failed spuriously: redo the advance on the fresh state.
        if (posOf(s) != pos)
            return;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
int64_t Transport::getPositionSamples() const
{
    return posOf(state_.load(std::memory_order_acquire));
}

int64_t Transport::getRenderPositionSamples() const
{
    return posOf(state_.load(std::memory_order_acquire));
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
    return playingOf(state_.load(std::memory_order_acquire));
}

double Transport::getBPM() const
{
    return bpm_.load(std::memory_order_acquire);
}

double Transport::getSampleRate() const
{
    return sampleRate_;
}

bool Transport::isPresentationPrerolling() const
{
    return false;
}

int64_t Transport::getPresentationLatencySamples() const
{
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
void Transport::seekToSample(int64_t sample)
{
    // Re-evaluate the trap against the new position: seek inside the window
    // stays/becomes armed; seek outside disarms until natural re-entry. Same
    // CAS as the position, so advance() never sees the new position with the
    // old latch (which wraps a seek past the loop end back into the loop).
    updateState(state_, [&](int64_t s) {
        return pack(sample, playingOf(s), xleth::loopArmOnEvent(
            armedOf(s), /*keepLatch*/ false, sample,
            loopStartSamples_.load(std::memory_order_relaxed),
            loopEndSamples_.load(std::memory_order_relaxed),
            loopEnabled_.load(std::memory_order_relaxed)));
    });
}

void Transport::seekToBeat(double beat)
{
    // Route through seekToSample so the loop arm latch is recomputed.
    seekToSample(beatsToSamples(beat));
}

// ─────────────────────────────────────────────────────────────────────────────
// Loop trap — message-thread setters / reads
void Transport::setLoopBounds(int64_t startSamples, int64_t endSamples, bool enabled)
{
    loopStartSamples_.store(startSamples, std::memory_order_release);
    loopEndSamples_.store(endSamples, std::memory_order_release);
    loopEnabled_.store(enabled, std::memory_order_release);
    // keepLatch: preserve an active trap only while the playhead is still inside
    // the resized window. Shrinking past the playhead → disarm (no yank);
    // disabling → disarm. A grow that newly contains the playhead does not force
    // an arm here — natural entry in advance() handles that next buffer.
    updateState(state_, [&](int64_t s) {
        const int64_t pos = posOf(s);
        return pack(pos, playingOf(s), xleth::loopArmOnEvent(
            armedOf(s), /*keepLatch*/ true, pos, startSamples, endSamples, enabled));
    });
}

bool Transport::isLoopEnabled() const
{
    return loopEnabled_.load(std::memory_order_acquire);
}

// AUDIO THREAD ONLY — no alloc, no logging, no locks
int Transport::samplesUntilLoopWrap(int numSamples) const
{
    // Mirrors advance()'s early-out: a stopped transport never moves, so a
    // split here would only re-render the same position N times.
    const int64_t s = state_.load(std::memory_order_acquire);
    if (!playingOf(s))
        return numSamples;

    return xleth::loopSamplesUntilWrap(
        posOf(s),
        numSamples,
        armedOf(s),
        loopStartSamples_.load(std::memory_order_relaxed),
        loopEndSamples_.load(std::memory_order_relaxed),
        loopEnabled_.load(std::memory_order_relaxed));
}

bool Transport::isLoopArmed() const
{
    return armedOf(state_.load(std::memory_order_acquire));
}

// ─────────────────────────────────────────────────────────────────────────────
double Transport::samplesToSeconds(int64_t samples) const
{
    return static_cast<double>(samples) / sampleRate_;
}

// Public API unchanged; the arithmetic lives in RenderClock so every engine
// sample <-> beat conversion shares one implementation.
double Transport::samplesToBeats(int64_t samples) const
{
    const double bpm = bpm_.load(std::memory_order_relaxed);
    return RenderClock::sampleToBeats(samples, static_cast<int>(sampleRate_), bpm);
}

int64_t Transport::beatsToSamples(double beats) const
{
    const double bpm = bpm_.load(std::memory_order_relaxed);
    return RenderClock::beatToSample(beats, static_cast<int>(sampleRate_), bpm);
}
