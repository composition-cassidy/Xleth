#include "EnvelopeAhdsr.h"

// EnvelopeAhdsr — pure closed-form AHDSR evaluation (EVC.4b).
// See EnvelopeAhdsr.h for the design contract and curve convention.

namespace {

// Clamp a level into [0,1] (NaN folds to 0 via the !(x>0) guard).
double clampLevel(double x) {
    if (!(x > 0.0)) return 0.0;
    return x > 1.0 ? 1.0 : x;
}

// Held-phase result: the AHDSR stage and pre-amount level at a gate-held elapsed
// time `t` (>= 0), assuming the gate is still held. Mirrors the Attack→Hold→Decay→
// Sustain math of Sampler::advanceEnvelope, in closed form.
struct HeldEval {
    EnvelopeAhdsrPhase phase;
    double             level;  // pre-amount, 0..1
};

HeldEval heldLevelAt(const EnvelopeAhdsrSettings& s, double t) {
    const double attackEnd = s.attackMs;
    const double holdEnd   = attackEnd + s.holdMs;
    const double decayEnd  = holdEnd + s.decayMs;

    if (t < attackEnd) {
        // Attack rises 0 → 1. attackMs > 0 here (t < attackEnd implies attackMs > 0).
        const double frac = t / s.attackMs;
        return { EnvelopeAhdsrPhase::Attack, envelopeShapeTension(frac, s.attackTension) };
    }
    if (t < holdEnd) {
        // Hold sits at 1.
        return { EnvelopeAhdsrPhase::Hold, 1.0 };
    }
    if (t < decayEnd) {
        // Decay falls 1 → sustain. decayMs > 0 here.
        const double frac   = (t - holdEnd) / s.decayMs;
        const double shaped = envelopeShapeTension(frac, s.decayTension);
        return { EnvelopeAhdsrPhase::Decay, 1.0 - (1.0 - s.sustain) * shaped };
    }
    // Sustain holds while the gate is held.
    return { EnvelopeAhdsrPhase::Sustain, s.sustain };
}

}  // namespace

EnvelopeAhdsrState evaluateEnvelopeAhdsr(const EnvelopeAhdsrSettings& rawSettings,
                                         double elapsedMs,
                                         double gateLengthMs) {
    const EnvelopeAhdsrSettings s = rawSettings.normalized();

    EnvelopeAhdsrState st;
    st.elapsedMs = elapsedMs;

    // Before onset: silent and inactive.
    if (!(elapsedMs >= 0.0)) {  // also catches NaN
        st.phase = EnvelopeAhdsrPhase::Off;
        return st;
    }

    if (!(gateLengthMs >= 0.0)) gateLengthMs = 0.0;

    // ── Gate held: Attack → Hold → Decay → Sustain ────────────────────────────
    if (elapsedMs < gateLengthMs) {
        const HeldEval h = heldLevelAt(s, elapsedMs);
        st.phase           = h.phase;
        st.gateElapsedMs   = elapsedMs;
        st.releaseElapsedMs = 0.0;
        st.normalizedLevel = clampLevel(h.level) * s.amount;
        st.active          = true;
        return st;
    }

    // ── Release: gate has ended ───────────────────────────────────────────────
    // Release starts from the actual level reached at gate end (handles short
    // notes/clips whose gate ends mid-attack/hold/decay — they release from their
    // real level, never an assumed sustain).
    st.gateElapsedMs = gateLengthMs;
    const double releaseStart = clampLevel(heldLevelAt(s, gateLengthMs).level);
    st.releaseStartLevel = releaseStart;

    const double relElapsed = elapsedMs - gateLengthMs;
    st.releaseElapsedMs = relElapsed;

    // Zero release → immediate Off after gate end.
    if (s.releaseMs <= 0.0 || relElapsed >= s.releaseMs) {
        st.phase = EnvelopeAhdsrPhase::Off;
        return st;
    }

    const double frac   = relElapsed / s.releaseMs;
    const double shaped  = envelopeShapeTension(frac, s.releaseTension);
    const double level   = releaseStart * (1.0 - shaped);
    st.phase           = EnvelopeAhdsrPhase::Release;
    st.normalizedLevel = clampLevel(level) * s.amount;
    st.active          = true;
    return st;
}
