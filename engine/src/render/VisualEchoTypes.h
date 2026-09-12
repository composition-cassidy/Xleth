#pragma once

/**
 * VisualEchoTypes — the data contract for the Visual Echo effect.
 *
 * Visual Echo is the video-side twin of a Delay audio effect: it keeps a ring
 * buffer of each cell's finished (post-visual-FX) pixels and re-composites
 * N older copies of it behind the live frame, one per delay repeat.
 *
 * The two halves of the feature deliberately do NOT share any timing math:
 *
 *   • The AUDIO side (XlethDelayEffect) owns every tempo/sync decision and
 *     PUBLISHES the result — one resolved delay length in samples, the
 *     feedback fraction, and whether the delay is in ping-pong mode.
 *   • The VIDEO side consumes that published snapshot and converts samples to
 *     output frames. That is a unit conversion, not a musical one: there is no
 *     BPM, no beat division and no sync-mode branch anywhere in the render
 *     path. If the Delay changes how it resolves its time, the echo follows
 *     automatically with no second implementation to keep in sync.
 *
 * The snapshot is read once per output frame per echoing cell, off the audio
 * thread, through MixEngine::resolveDelaySnapshot. The Delay's writes are plain
 * relaxed atomic stores issued once per audio block — no allocation, no lock
 * and no logging on the callback path.
 */

#include <cstdint>

namespace xleth::echo {

// Hard caps. Both exist because the ring is real GPU memory: one cell-sized
// RGBA texture per buffered frame. A 480x270 cell is ~518 KB a frame, so an
// unbounded ring on a long delay would strand hundreds of megabytes per cell.
//
// kMaxTaps also bounds the per-frame draw cost, which is what the Phase 0
// 0.25 ms GPU composite floor is measured against.
inline constexpr int kMaxTaps       = 8;
inline constexpr int kMaxRingFrames = 96;   // ~3.2 s of history at 30 fps

// Per-ring GPU memory budget. kMaxRingFrames alone is NOT a memory bound,
// because a frame's cost depends entirely on the cell's size: 96 frames of a
// 480x270 grid cell is 48 MB, but 96 frames of a 1920x1080 FULLSCREEN layer is
// 796 MB — enough to take the device down on a modest GPU, from a feature the
// user thinks of as a visual flourish.
//
// So the frame count is clamped by BYTES as well. When the budget bites, the
// ring holds fewer frames than the trail wants and the oldest taps simply do
// not draw — the same failure mode as a trail that has not finished growing in
// after a seek, which is a shorter trail rather than a wrong one. The
// alternative (keeping the frame count and shrinking the textures) would put
// visibly softer pixels in the trail than in the live cell.
inline constexpr uint64_t kMaxRingBytes = 192ull * 1024ull * 1024ull;

/** Largest frame count that fits the budget for a w x h RGBA cell. At least 2,
 *  so a ring that is over budget at any size still buffers enough for one
 *  interpolated tap rather than collapsing to nothing. */
inline int ringFramesWithinBudget(int w, int h, int wantFrames) noexcept {
    const uint64_t perFrame = static_cast<uint64_t>(w > 0 ? w : 1)
                            * static_cast<uint64_t>(h > 0 ? h : 1) * 4ull;
    if (perFrame == 0) return wantFrames;
    const uint64_t affordable = kMaxRingBytes / perFrame;
    if (affordable >= static_cast<uint64_t>(wantFrames)) return wantFrames;
    return affordable < 2ull ? 2 : static_cast<int>(affordable);
}

// ---------------------------------------------------------------------------
// DelaySnapshot — what the video side is allowed to know about a Delay FX.
//
// Written by XlethDelayEffect once per audio block, read by the render thread.
// Deliberately post-resolution: `delaySamples` has already had sync mode, beat
// division, global BPM, stereo mode and the 80 ms time smoother applied to it.
// ---------------------------------------------------------------------------
struct DelaySnapshot {
    bool  valid        = false;  // false = no such effect / not a Delay / never ran
    float delaySamples = 0.0f;   // resolved repeat interval, in samples
    float feedback01   = 0.0f;   // 0..0.95 — the delay's feedback fraction
    bool  pingPong     = false;  // stereo_mode == PingPong
};

// ---------------------------------------------------------------------------
// IDelaySnapshotResolver — the render path's one window onto the audio graph.
//
// FrameCollector holds a pointer to one of these rather than to MixEngine, so
// the render unit tests can drive echo timing with a stub and the collector
// keeps no dependency on the audio stack. Implemented by MixEngineDelayResolver
// (MixEngine.h) for both the live preview tick and the export renderer, which
// is what makes preview and export read the SAME numbers.
// ---------------------------------------------------------------------------
class IDelaySnapshotResolver {
public:
    virtual ~IDelaySnapshotResolver() = default;

    /** @param trackId  track owning the Delay
     *  @param nodeId   APG node uid of the bound Delay effect
     *  @return snapshot; .valid == false when the binding does not resolve. */
    virtual DelaySnapshot resolve(int trackId, int nodeId) const = 0;
};

// ---------------------------------------------------------------------------
// EchoSettings — the resolved per-cell echo configuration for ONE output frame.
//
// Built by FrameCollector from the track's VisualEcho VisualEffect plus the
// Delay snapshot, and carried on CellFrameRequest. Plain values only: the
// compositor never dereferences live Timeline or audio-graph state.
// ---------------------------------------------------------------------------
struct EchoSettings {
    bool     active      = false;  // false = this cell composites exactly as before
    int      taps        = 0;      // 1..kMaxTaps
    float    tapGain     = 0.0f;   // g — tap n is drawn at g^n (before the taper)
    float    frameDelay  = 0.0f;   // D, in OUTPUT FRAMES, fractional
    float    scaleTrail  = 0.0f;   // 0..1 scale-toward-centre per tap
    int      flipMode    = 0;      // see kFlip* below
    float    drift       = 0.0f;   // 0..1 ping-pong edge drift (0 unless pingPong)
    bool     pingPong    = false;  // bound delay is in ping-pong mode
    bool     additive    = false;  // additive trail instead of normal alpha blend
    uint64_t ringKey     = 0;      // stable ring identity for this cell

    // Ring depth this frame needs: ceil(taps * frameDelay) + 2, capped.
    // +2 covers the fractional tap's second sample and one frame of slack so a
    // delay time that creeps upward does not truncate the oldest tap mid-glide.
    int requiredRingFrames() const noexcept;
};

// Tap flip modes. Every one of these stays inside {None, Horizontal, Vertical,
// Rotate180} — the Klein four-group — which is the largest subgroup of D4 that
// is BOTH closed under composition and fully representable by the 6-state
// Orientation enum the composite shader already implements. See
// composeTapOrientation() for why that matters.
inline constexpr int kFlipNone          = 0;
inline constexpr int kFlipAltHorizontal = 1;
inline constexpr int kFlipAltVertical   = 2;
inline constexpr int kFlipAltHalfTurn   = 3;
inline constexpr int kFlipKleinCycle    = 4;
inline constexpr int kFlipModeCount     = 5;

/**
 * Orientation for tap `n` (1-based), composed onto the cell's own orientation.
 *
 * `baseOrientation` and the return value are both the Orientation enum as int
 * (0=None 1=Horizontal 2=Vertical 3=Rotate180 4=Rotate90CW 5=Rotate90CCW) —
 * the same value CellConstants::orientation carries to the shader.
 *
 * DEVIATION, deliberate and documented: D4 has 8 elements but the shader
 * implements 6 — the two diagonal reflections have no UV transform. The 6 are
 * therefore NOT closed under composition: Horizontal ∘ Rotate90CW is a diagonal
 * reflection and cannot be emitted. Rather than emit a wrong-but-close
 * orientation, this composes EXACTLY within the Klein subgroup and drops the
 * mirror component when the cell's own orientation is a quarter-turn (where
 * only the half-turn component stays representable). Every value this function
 * returns is the exact composition of what it actually applied.
 */
int composeTapOrientation(int baseOrientation, int flipMode, int tapIndex) noexcept;

/**
 * Gain for tap `n` (1-based) out of `taps`, before the cell's own opacity.
 *
 * Two factors multiply:
 *   g^n          the delay's own decay, so the trail dies away like the audio
 *   raised-cos   a taper that reaches EXACTLY zero at n == taps
 *
 * The taper is what makes the tap CAP invisible. Without it, raising or
 * lowering the tap count pops a fully-opaque copy in or out of the frame; with
 * it, the last tap is already at zero so the cap is never a visible edge. It is
 * also why drawEchoTaps can cheaply skip the final tap.
 */
float tapGainAt(float g, int taps, int tapIndex) noexcept;

} // namespace xleth::echo
