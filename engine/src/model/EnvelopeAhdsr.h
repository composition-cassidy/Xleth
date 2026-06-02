#pragma once
// EnvelopeAhdsr — pure, deterministic AHDSR phase/value evaluation for the
// per-voice Envelope Controller (EVC.4b).
//
// Audit: docs/dev/fxgraph-envelope-controller-architecture-audit.md (EVC.1 §5–§7).
//
// This is the engine-side *pure model* for the Envelope node's AHDSR curve. It
// mirrors the normalized EVC.2 graphState data shape (attack/hold/decay/sustain/
// release + per-segment tension + amount) and answers, in closed form, "what is
// the envelope phase and normalized level at an arbitrary elapsed time, given the
// gate length?". It is intentionally:
//
//   • Pure — no JUCE, no audio thread, no transport/playback state, no graphState
//     JSON parsing. Same inputs → same output, always (the VideoFlipResolver and
//     EnvelopeVoiceEvents precedent).
//   • Non-audible — it evaluates levels only; it applies no per-voice gain, drives
//     no Sampler voice, and is never called from audio rendering. EVC.5/EVC.6 add
//     the runtime and gain application.
//   • Closed-form & seek-deterministic — level(P) is a piecewise function of the
//     elapsed time since onset and the gate length, so a mid-note/mid-clip seek is
//     reconstructed directly without replaying intervening samples (audit §5).
//
// Curve convention: the tension shaping matches Sampler::shapeTension exactly
// (`pow(t, pow(2, -tension*2))`, tension 0 → linear), so this pure model and the
// existing per-voice Sampler envelope agree on shape. Sampler::advanceEnvelope is
// NOT modified by this phase — this is an independent pure evaluator.

#include <cmath>
#include <cstdint>
#include <string>

// ─── EnvelopeAhdsrPhase ───────────────────────────────────────────────────────
// The closed-form AHDSR stage at a queried elapsed time. Off means before onset
// or after the release tail has completed (level 0, inactive).

enum class EnvelopeAhdsrPhase : int {
    Off     = 0,
    Attack  = 1,
    Hold    = 2,
    Decay   = 3,
    Sustain = 4,
    Release = 5,
};

inline std::string envelopeAhdsrPhaseToString(EnvelopeAhdsrPhase p) {
    switch (p) {
        case EnvelopeAhdsrPhase::Attack:  return "attack";
        case EnvelopeAhdsrPhase::Hold:    return "hold";
        case EnvelopeAhdsrPhase::Decay:   return "decay";
        case EnvelopeAhdsrPhase::Sustain: return "sustain";
        case EnvelopeAhdsrPhase::Release: return "release";
        case EnvelopeAhdsrPhase::Off:     return "off";
        default:                          return "off";
    }
}

// ─── Tension shaping ──────────────────────────────────────────────────────────
// Identical to Sampler::shapeTension (engine/src/audio/Sampler.cpp): t in [0,1],
// tension in [-1,1]. tension 0 → linear; tension>0 → fast start; tension<0 → slow
// start. Done in double here for closed-form precision; clamps t to [0,1] first so
// callers can pass slightly-out-of-range fracs without producing NaNs.
inline double envelopeShapeTension(double t, double tension) {
    if (!(t > 0.0)) return 0.0;   // also catches NaN
    if (t >= 1.0)   return 1.0;
    if (std::abs(tension) < 0.001) return t;
    const double exponent = std::pow(2.0, -tension * 2.0);
    return std::pow(t, exponent);
}

// ─── EnvelopeAhdsrSettings ────────────────────────────────────────────────────
// Engine-side mirror of the normalized EVC.2 envelope-node data shape. This is a
// plain settings struct — it does NOT parse graphState JSON in this phase (callers
// build it directly, e.g. from tests). `normalized()` repairs malformed input
// defensively so evaluation never divides by zero or produces NaN/Inf.
//
// Defaults match EVC.2 (graphState normalizeEnvelopeNode).

struct EnvelopeAhdsrSettings {
    double attackMs       = 10.0;
    double holdMs         = 0.0;
    double decayMs        = 120.0;
    double sustain        = 0.7;   // 0..1
    double releaseMs      = 200.0;
    double attackTension  = 0.0;   // -1..+1
    double decayTension   = 0.0;   // -1..+1
    double releaseTension = 0.0;   // -1..+1
    double amount         = 1.0;   // 0..1

    // Repair helpers (static so they are usable without an instance).
    static double repairMs(double v, double dflt) {
        if (!std::isfinite(v)) return dflt;
        return v < 0.0 ? 0.0 : v;
    }
    static double repairUnit(double v, double dflt) {  // clamp to 0..1
        if (!std::isfinite(v)) return dflt;
        if (v < 0.0) return 0.0;
        if (v > 1.0) return 1.0;
        return v;
    }
    static double repairTension(double v) {            // clamp to -1..+1
        if (!std::isfinite(v)) return 0.0;
        if (v < -1.0) return -1.0;
        if (v >  1.0) return  1.0;
        return v;
    }

    // Returns a defensively repaired copy: ms finite & >= 0, sustain/amount in
    // 0..1, tension in -1..+1. Non-finite values fall back to the EVC.2 default.
    EnvelopeAhdsrSettings normalized() const {
        EnvelopeAhdsrSettings o;
        o.attackMs       = repairMs(attackMs,   10.0);
        o.holdMs         = repairMs(holdMs,      0.0);
        o.decayMs        = repairMs(decayMs,   120.0);
        o.sustain        = repairUnit(sustain,   0.7);
        o.releaseMs      = repairMs(releaseMs, 200.0);
        o.attackTension  = repairTension(attackTension);
        o.decayTension   = repairTension(decayTension);
        o.releaseTension = repairTension(releaseTension);
        o.amount         = repairUnit(amount,    1.0);
        return o;
    }
};

// ─── EnvelopeAhdsrState ───────────────────────────────────────────────────────
// The evaluated result at one elapsed time. `normalizedLevel` is the final 0..1
// envelope value AFTER `amount` scaling (so amount 0 → level 0). `releaseStartLevel`
// is the pre-amount held level reached at gate end — carried so callers can see the
// continuity point for short notes that release before reaching sustain.

struct EnvelopeAhdsrState {
    EnvelopeAhdsrPhase phase            = EnvelopeAhdsrPhase::Off;
    double             normalizedLevel  = 0.0;  // 0..1, amount-scaled
    double             elapsedMs        = 0.0;  // query - onset (may be < 0 before onset)
    double             gateElapsedMs    = 0.0;  // time gate held, clamped to gate length
    double             releaseElapsedMs = 0.0;  // time since gate end (0 while gate held)
    double             releaseStartLevel = 0.0; // pre-amount level at gate end
    bool               active           = false; // phase != Off
};

// ─── Evaluation ───────────────────────────────────────────────────────────────
// Closed-form AHDSR at `elapsedMs` (time since onset) given `gateLengthMs` (the
// note/clip duration — the gate). Settings are normalized internally, so callers
// may pass raw values. Behavior:
//
//   • elapsedMs < 0           → Off, level 0, inactive (before onset).
//   • 0 <= elapsedMs < gate   → Attack → Hold → Decay → Sustain by elapsed.
//   • elapsedMs >= gate       → Release from the actual level reached at gate end
//                               (so short notes release from their real level, not
//                               an assumed sustain), falling to 0 over releaseMs.
//   • release complete        → Off, level 0, inactive.
//
// Zero-duration stages never divide by zero: zero attack → immediate 1 at onset;
// zero release → immediate Off after gate end; zero decay → immediate sustain.
EnvelopeAhdsrState evaluateEnvelopeAhdsr(const EnvelopeAhdsrSettings& settings,
                                         double elapsedMs,
                                         double gateLengthMs);
