#pragma once

// ─── SourceTransformCapability ──────────────────────────────────────────────
// Session-only description of a SOURCE-LEVEL transform an effect asks the
// engine to apply to the audio feeding its track, before that audio reaches
// the effect chain at all. The Pitch Shifter's Clip mode is the one provider:
// it does no realtime DSP, and instead names an offline re-render of every clip
// on its track (semitones/cents through one of the StretchMethod engines).
//
// POD, no dependencies, so the engine can build, compare and publish tables of
// these without pulling in JUCE headers — the same shape SidechainCapability
// has for the same reason.
//
// IMPORTANT: capability is RUNTIME-DISCOVERED and NEVER persisted as project
// truth. The effect's own APVTS parameters are what get saved; this struct is
// re-derived from them (XlethEffectBase::provideSourceTransform) whenever the
// engine rebuilds its per-track transform table. Mirrors SidechainCapability.
//
// DELIBERATELY NO `mix` FIELD. Mix is automatable, and XLETH's automation path
// writes the raw APVTS atomic without ever calling onParameterValueChanged (see
// XlethEffectBase::resolveAutomationParameter). A mix carried here would go
// stale under automation, or would force a table rebuild every block to keep
// up. The struct therefore carries ONLY the render-relevant identity — the
// fields that decide WHICH buffer gets rendered. A consumer that blends wet
// against dry reads mix per block from the owning node's smoothed parameter.

namespace xleth
{
    struct SourceTransform
    {
        // True iff this transform changes the source at all. An inactive
        // transform must be treated exactly as if none was provided.
        bool active = false;

        // Whole semitones, [-24, 24].
        int semis = 0;

        // Cents, [-100, 100]. Added to `semis`; the consumer owns the combined
        // clamp.
        int cents = 0;

        // StretchMethod value (model/TimelineTypes.h): PSOLA=1, Rubber=2,
        // WSOLA=3, PhaseVocoder=4, WORLD=5. Global=0 is the internal
        // "no fx transform" sentinel and is never produced by a provider.
        int method = 2;

        // Formant-preserving render. A formant-only transform (semis == 0,
        // cents == 0, formant == true) is ACTIVE: formant shift without a
        // repitch is a legitimate use.
        bool formant = false;

        bool operator==(const SourceTransform& o) const noexcept
        {
            return active == o.active && semis == o.semis && cents == o.cents
                && method == o.method && formant == o.formant;
        }
        bool operator!=(const SourceTransform& o) const noexcept { return !(*this == o); }
    };

    // The activity rule, in one place so the provider and the tests agree.
    // `sourceModeSelected` is the provider's own "I am in a source-transform
    // mode" flag (for the Pitch Shifter: mode == Clip).
    constexpr bool isSourceTransformActive(bool sourceModeSelected,
                                           int semis, int cents, bool formant) noexcept
    {
        return sourceModeSelected && (semis != 0 || cents != 0 || formant);
    }
}
