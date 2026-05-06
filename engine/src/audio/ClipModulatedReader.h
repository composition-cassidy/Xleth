#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <array>
#include <cmath>
#include <cstdint>

#include "audio/ClipFade.h"
#include "audio/ClipRenderCache.h"
#include "model/TimelineTypes.h"

namespace xleth::audio {

// ─── ClipModulatedReader ─────────────────────────────────────────────────────
//
// Phase C MVP. Renders a single timeline clip into a track buffer when the
// clip has top-level modulation enabled and vibrato enabled. Reads raw decoded
// source PCM (NOT the processed ClipRenderCache buffer) and applies
//   pitchRatio = 2^((staticCents + vibratoCents) / 1200)
// per output sample, advancing a fractional source readhead.
//
// Static cents come from `Clip::pitchOffset * 100 + Clip::pitchOffsetCents`
// (the same fields the cache path keys on). Vibrato cents come from the
// stateless Phase B evaluator `xleth::clipmod::evaluateVibrato`.
//
// Activation policy (caller's responsibility — checked in MixEngine):
//   clip.modulation.enabled
//   && clip.modulation.vibrato.enabled
//   && !clip.reversed
//   && clip.stretchRatio == 1.0
//
// If any of those fail, the caller falls back to the existing cache path.
// Composing vibrato with reverse / time-stretch is deferred to a future phase
// (silently dropping reverse/stretch when vibrato is enabled would be a
// regression for users who set both).
//
// Threading: every public function is audio-thread safe. No allocations, no
// locks, no I/O. Per-clip state is owned by this object (one slot per
// `clip->id` mod `kMaxClipId`, mirroring `ClipRenderCache`'s slot policy).
// State must be reset on transport stop and on transport seek; the unseen-
// states sweep clears state for clips that left the active set.

class ClipModulatedReader
{
public:
    static constexpr int kMaxClipId = ClipRenderCache::kMaxClipId;

    struct BlockParams
    {
        const juce::AudioBuffer<float>* srcBuf;          // raw PCM at engine SR
        int64_t   regionOffsetSamples;
        int64_t   clipStartSample;                       // timeline absolute
        int64_t   clipEndSample;                         // timeline absolute (exclusive)
        int64_t   bufStart;                              // timeline absolute, first output sample
        int       numOutputSamples;
        double    bpm;
        double    sampleRate;

        // Static clip pitch (combined with vibrato cents in cents space).
        int       pitchOffsetSemis;
        int       pitchOffsetCents;

        // Fade context (built once per clip in MixEngine, reused here).
        int64_t   fadeInSamples;
        int64_t   fadeOutSamples;
        const ClipFadeLUT* fadeInLUT;        // nullable iff fadeInSamples == 0
        const ClipFadeLUT* fadeOutLUT;       // nullable iff fadeOutSamples == 0
        int       clipBoundaryFadeN;         // global Hann declick width (0 = disabled)

        float     velocity;
        const ClipModulation* modulation;    // not null
    };

    // Render one clip's contribution into trackBuf (stereo). Mixes (addSample)
    // into channels 0/1. Skips output samples that fall outside the clip's
    // [clipStart, clipEnd) timeline window, matching the cache-path loop.
    void renderBlock(const BlockParams& p,
                     juce::AudioBuffer<float>& trackBuf,
                     int clipId) noexcept;

    // Hard-reset every per-clip state. Call from MixEngine on prepare(),
    // transport stop, and transport seek.
    void resetAllStates() noexcept;

    // Reset a single clip's state. (Also called internally by the unseen sweep.)
    void resetClipState(int clipId) noexcept;

    // Per-block bookkeeping for stale-state detection.
    // Call markClipSeen(clipId) for each clip rendered through the reader in
    // a block; after the clip-render loop, call resetUnseenStates() to clear
    // state for any clip that wasn't rendered. Without this sweep, a clip
    // that played, deactivated, and reactivated would resume from a stale
    // sourcePosD.
    void markClipSeen(int clipId) noexcept;
    void resetUnseenStates() noexcept;

    // Convenience: 2^(cents/1200). Hoist outside the per-sample loop for the
    // static portion; inside the loop only the vibrato term varies.
    static double centsToRatio(double cents) noexcept
    {
        return std::pow(2.0, cents / 1200.0);
    }

private:
    struct State
    {
        double  sourcePosD            = 0.0;   // fractional source PCM read position (samples)
        int64_t expectedNextPosInClip = -1;    // -1 = needs seed
        bool    seenThisBlock         = false;
    };

    static int slotFor(int clipId) noexcept
    {
        // Mirror ClipRenderCache's slot policy: clamp to [0, kMaxClipId).
        // Clip-id collisions across this boundary share the same state slot,
        // matching (and not improving on) the cache's existing limit.
        if (clipId < 0) return 0;
        if (clipId >= kMaxClipId) return clipId % kMaxClipId;
        return clipId;
    }

    std::array<State, kMaxClipId> states_{};
};

} // namespace xleth::audio
