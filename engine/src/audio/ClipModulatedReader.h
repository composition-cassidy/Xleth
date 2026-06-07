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
// Phase C MVP (Vibrato): renders a single timeline clip into a track buffer
// when the clip has top-level modulation enabled and vibrato enabled. Reads
// raw decoded source PCM (NOT the processed ClipRenderCache buffer) and
// applies
//   pitchRatio = 2^((staticCents + vibratoCents) / 1200)
// per output sample, advancing a fractional source readhead.
//
// Phase D.1 (Vinyl Scratch): when scratch is enabled and its curve is
// non-empty, the readhead is *driven* by the deterministic Phase B evaluator
//   sourceBase = regionOffsetSamples + scratchEval.sourceOffsetSeconds * sr
// and the static-pitch + vibrato contribution becomes a per-sample residual
// trim on top:
//   vibTrim   += staticRatio * vibratoRatio - 1.0
//   sourcePos  = sourceBase + vibTrim
// On seek/seed at clip-local sample N, vibTrim is initialised from
//   computeVibratoIntegratedSourceOffsetSamples(...) - N
// (the −N strips the unity readhead motion already in sourceBase). Direction
// flips are masked with a Hann microfade whose width is `scratch.smoothingMs`.
//
// When scratch is OFF, the legacy Phase C path is preserved bit-for-bit.
//
// Static cents usually come from
// `Clip::pitchOffset * 100 + Clip::pitchOffsetCents`. When MixEngine feeds a
// post-cache stretched buffer, the cache has already baked static pitch into
// that buffer, so the caller passes zero static pitch here. Vibrato cents come
// from the stateless Phase B evaluator `xleth::clipmod::evaluateVibrato`.
//
// Activation policy (caller's responsibility — checked in MixEngine):
//   clip.modulation.enabled
//   && (clip.modulation.vibrato.enabled || clip.modulation.scratch.enabled)
//   && !clip.reversed
//   && !clip.formantPreserve
//
// Plain clips use raw PCM plus regionOffsetSamples. Stretched clips use the
// clip-local post-cache buffer plus regionOffsetSamples=0. Reverse and
// formant-preserve remain bypassed by the caller.
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

        // Sample-rate correction (mirrors the raw clip path in MixEngine).
        // srcSampleRate = bake rate of srcBuf; preparedSampleRate = export rate.
        // The readhead advances by srcSampleRate/preparedSampleRate so a buffer
        // baked at one rate plays at correct pitch when exported at another.
        // For post-cache (stretched) clips the caller passes the prepared rate
        // for srcSampleRate, yielding factor 1.0 (cache buffer already at rate).
        double    srcSampleRate;
        double    preparedSampleRate;

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
        // Legacy Phase C readhead used when scratch is OFF. Holds the
        // accumulated fractional source PCM read position (samples).
        double  sourcePosD            = 0.0;

        // Phase D.1 vibrato/static residual when scratch is ON. Accumulates
        // `staticRatio * vibratoRatio - 1.0` per sample so that
        // `sourcePosD = sourceBase + vibTrimD` where `sourceBase` is the
        // closed-form scratch readhead.
        double  vibTrimD              = 0.0;

        // Continuity marker. -1 = needs seed.
        int64_t expectedNextPosInClip = -1;

        // Phase D.1 declick / smoothing state (only meaningful when scratch
        // is active; reset on seed).
        double  prevRate              = 1.0;
        double  smoothedRate          = 1.0;
        int     declickRemaining      = 0;     // samples left in microfade
        int     declickWidth          = 0;     // total width in samples
        bool    declickInverting      = false; // unused for now (single-stage Hann)

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
