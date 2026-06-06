#include "Transport.h"
#include "audio/LoopTrap.h"

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
    // Arm immediately if the playhead starts inside the loop window; otherwise
    // stay disarmed and let advance() arm on natural entry (start-outside plays
    // linearly until it first crosses in).
    const bool armed = xleth::loopArmOnEvent(
        loopArmed_.load(std::memory_order_relaxed), /*keepLatch*/ false,
        positionSamples_.load(std::memory_order_relaxed),
        loopStartSamples_.load(std::memory_order_relaxed),
        loopEndSamples_.load(std::memory_order_relaxed),
        loopEnabled_.load(std::memory_order_relaxed));
    loopArmed_.store(armed, std::memory_order_release);
}

void Transport::stop()
{
    playing_.store(false, std::memory_order_release);
    positionSamples_.store(0, std::memory_order_release);
    loopArmed_.store(false, std::memory_order_release);
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

    const bool enabled = loopEnabled_.load(std::memory_order_relaxed);
    const int64_t pos  = positionSamples_.load(std::memory_order_relaxed);

    if (!enabled) {
        positionSamples_.store(pos + numSamples, std::memory_order_release);
        return;
    }

    // ── Loop wrap injected on the audio-as-master-clock path ────────────────
    // The master sample clock is mutated HERE, on the audio thread, the same
    // instant the mix block is consumed. positionSamples_ is the single source
    // of truth the renderer playhead follows (via getTransportState →
    // PlayheadClock). By wrapping the clock at the source — never moving the
    // renderer playhead independently — audio and the on-screen playhead stay
    // phase-locked, so the loop jump cannot tear A/V sync. The decision logic is
    // the pure, alloc/lock/log-free xleth::loopAdvance.
    bool armed = loopArmed_.load(std::memory_order_relaxed);
    const int64_t newPos = xleth::loopAdvance(
        pos, numSamples, armed,
        loopStartSamples_.load(std::memory_order_relaxed),
        loopEndSamples_.load(std::memory_order_relaxed),
        enabled);
    loopArmed_.store(armed, std::memory_order_relaxed);
    positionSamples_.store(newPos, std::memory_order_release);
}

// ─────────────────────────────────────────────────────────────────────────────
int64_t Transport::getPositionSamples() const
{
    return positionSamples_.load(std::memory_order_acquire);
}

int64_t Transport::getRenderPositionSamples() const
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
    positionSamples_.store(sample, std::memory_order_release);
    // Re-evaluate the trap against the new position: seek inside the window
    // stays/becomes armed; seek outside disarms until natural re-entry.
    const bool armed = xleth::loopArmOnEvent(
        loopArmed_.load(std::memory_order_relaxed), /*keepLatch*/ false,
        sample,
        loopStartSamples_.load(std::memory_order_relaxed),
        loopEndSamples_.load(std::memory_order_relaxed),
        loopEnabled_.load(std::memory_order_relaxed));
    loopArmed_.store(armed, std::memory_order_release);
}

void Transport::seekToBeat(double beat)
{
    // Route through seekToSample so the loop arm latch is recomputed.
    seekToSample(beatsToSamples(beat));
}

void Transport::seekToBar(int bar)
{
    seekToBeat(static_cast<double>(bar - 1) * 4.0);
}

void Transport::configureLivePresentationTiming(int64_t renderStart,
                                                int64_t requestedStart,
                                                int64_t totalLatency,
                                                int64_t discardSamples)
{
    (void) requestedStart;
    (void) totalLatency;
    (void) discardSamples;
    positionSamples_.store(renderStart, std::memory_order_release);
}

void Transport::clearLivePresentationTiming()
{
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
    const bool armed = xleth::loopArmOnEvent(
        loopArmed_.load(std::memory_order_relaxed), /*keepLatch*/ true,
        positionSamples_.load(std::memory_order_relaxed),
        startSamples, endSamples, enabled);
    loopArmed_.store(armed, std::memory_order_release);
}

bool Transport::isLoopEnabled() const
{
    return loopEnabled_.load(std::memory_order_acquire);
}

bool Transport::isLoopArmed() const
{
    return loopArmed_.load(std::memory_order_acquire);
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
