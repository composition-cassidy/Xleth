#pragma once

/**
 * NoteFade — resolve a NoteFadeSettings into the same fade-percent + bezier
 * contract the user-authored clip fade already uses.
 *
 * Pure math, Model tier: no JUCE, no GPU, no Timeline lookups. Everything the
 * evaluation needs (note length in beats, project BPM) is passed in, so the
 * render path, the preview path and the unit tests all exercise the identical
 * code with no plumbing.
 *
 * The whole feature reduces to two numbers per note — fade-in percent and
 * fade-out percent of the note's own length — because evaluateClipFadeGain
 * (audio/ClipFade.h) already implements exactly that envelope, including the
 * "in + out > 100%" normalization. Resolving every LengthMode back to a percent
 * therefore reuses one evaluator instead of adding a second fade implementation
 * that would drift from the first.
 */

#include "TimelineTypes.h"
#include "audio/ClipFade.h"

#include <algorithm>
#include <cmath>

namespace xleth::notefade {

// Bezier control points for one Curve option, in the SAME orientation
// evaluateClipFadeGain feeds them: x = 0 is the silent end of the fade, x = 1 is
// full opacity. The fade-out passes `remaining / ratio`, so a single option
// produces the same shape measured from silence on both sides — which is why
// the options are named for their behaviour near silence and not for time.
struct CurvePoints { float x1, y1, x2, y2; };

inline CurvePoints curvePoints(NoteFadeSettings::Curve curve) noexcept
{
    switch (curve) {
        // Straight ramp. cubic-bezier(0,0,1,1) is the identity, matching the
        // control points a clip fade uses for its own "linear".
        case NoteFadeSettings::Curve::Linear: return { 0.0f, 0.0f, 1.0f, 1.0f };
        // ease-in-out: eases away from silence AND into full opacity.
        case NoteFadeSettings::Curve::Smooth: return { 0.42f, 0.0f, 0.58f, 1.0f };
        // ease-out: leaves silence fast, settles into full opacity. Keeps a
        // percussive note's attack intact while still removing the hard cut.
        case NoteFadeSettings::Curve::Snappy: return { 0.0f, 0.0f, 0.58f, 1.0f };
        // ease-in: lingers near silence, then rushes to full. The softest option.
        case NoteFadeSettings::Curve::Gentle: return { 0.42f, 0.0f, 1.0f, 1.0f };
    }
    return { 0.0f, 0.0f, 1.0f, 1.0f };
}

// Musical length of one Division setting, in beats. D is the note-value
// denominator and the length is 4/D beats — the same convention the Sampler and
// Phanjer tempo-sync dropdowns use (see LfoParameterModulation.h), so D=4 is one
// beat and D=16 is a sixteenth note. Clamped to the offered range rather than
// rejected: settings arrive from JSON and from the bridge, both of which can
// carry values a future or hand-edited project wrote.
inline double divisionBeats(int divisionDenominator) noexcept
{
    const int d = std::clamp(divisionDenominator,
                             kNoteFadeMinDivisionDenominator,
                             kNoteFadeMaxDivisionDenominator);
    return 4.0 / static_cast<double>(d);
}

/**
 * Resolve one side's configured length into a percent of the note's own length.
 *
 * @param side               the fade-in or fade-out half of NoteFadeSettings
 * @param noteDurationBeats  the note's length (VideoEvent::durationBeats)
 * @param bpm                project tempo, needed only by Milliseconds mode
 * @return  0..100. A non-positive / non-finite note length yields 0 — a note
 *          with no duration cannot carry a fade, and returning 0 keeps the
 *          caller's arithmetic total (gain 1.0) rather than a NaN opacity.
 *
 * Fixed-length modes are expressed as a percent of THIS note, so a fade longer
 * than the note it lives on saturates at 100% instead of running past the note's
 * end. Two saturated sides are then split 50/50 by evaluateClipFadeGain's
 * normalization, which is the sane reading of "fade in and out, both longer than
 * the note".
 */
inline float sidePercent(const NoteFadeSettings::Side& side,
                         double noteDurationBeats,
                         double bpm) noexcept
{
    if (!(noteDurationBeats > 0.0) || !std::isfinite(noteDurationBeats))
        return 0.0f;

    double pct = 0.0;
    switch (side.mode) {
        case NoteFadeSettings::LengthMode::FollowNoteLength:
            pct = std::isfinite(side.percent) ? static_cast<double>(side.percent) : 0.0;
            break;

        case NoteFadeSettings::LengthMode::Division:
            pct = 100.0 * divisionBeats(side.divisionDenominator) / noteDurationBeats;
            break;

        case NoteFadeSettings::LengthMode::Milliseconds: {
            const double safeBpm = (bpm > 0.0 && std::isfinite(bpm)) ? bpm : 140.0;
            const double noteMs  = noteDurationBeats * (60000.0 / safeBpm);
            const double ms      = std::isfinite(side.ms) ? static_cast<double>(side.ms) : 0.0;
            if (!(noteMs > 0.0)) return 0.0f;
            pct = 100.0 * ms / noteMs;
            break;
        }
    }

    if (!std::isfinite(pct)) return 0.0f;
    return static_cast<float>(std::clamp(pct, 0.0, 100.0));
}

/**
 * Opacity multiplier for one note at one moment.
 *
 * @param settings           the track's note-fade config
 * @param noteProgress       0..1 through the note (0 = note start, 1 = note end)
 * @param noteDurationBeats  the note's length
 * @param bpm                project tempo
 * @return  1.0 when the module is disabled or resolves to no fade at all, so
 *          the caller can multiply unconditionally.
 */
inline float gain(const NoteFadeSettings& settings,
                  float  noteProgress,
                  double noteDurationBeats,
                  double bpm) noexcept
{
    if (!settings.enabled) return 1.0f;

    const float inPct  = sidePercent(settings.fadeIn,  noteDurationBeats, bpm);
    const float outPct = sidePercent(settings.fadeOut, noteDurationBeats, bpm);
    if (inPct <= 0.0f && outPct <= 0.0f) return 1.0f;

    const CurvePoints ci = curvePoints(settings.fadeIn.curve);
    const CurvePoints co = curvePoints(settings.fadeOut.curve);

    return evaluateClipFadeGain(noteProgress, inPct, outPct,
                                ci.x1, ci.y1, ci.x2, ci.y2,
                                co.x1, co.y1, co.x2, co.y2);
}

/**
 * True when the config actually produces a fade-OUT on a note of this length.
 *
 * Needed by the fullscreen-behind hold-through-gap bookkeeping, which suppresses
 * the held frame after a fade-out so a track that just faded to nothing does not
 * pop back to full opacity the instant its event ends. That rule already exists
 * for the user-authored clip fade (VideoEvent::fadeOutPercent); a note fade has
 * to feed it too or a Pattern track used as a fullscreen backdrop would fade out
 * and then snap back.
 */
inline bool hasFadeOut(const NoteFadeSettings& settings,
                       double noteDurationBeats,
                       double bpm) noexcept
{
    return settings.enabled
        && sidePercent(settings.fadeOut, noteDurationBeats, bpm) > 0.0f;
}

} // namespace xleth::notefade
