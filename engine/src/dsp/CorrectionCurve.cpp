#include "dsp/CorrectionCurve.h"

#include <algorithm>
#include <cmath>

namespace xleth::dsp {

namespace {

// Low-pass boundary between "center" (real pitch correction) and "vibrato"
// (the singer's own wobble) in the Preserve Vibrato split. The spec gives a
// ~5-8 Hz range for this boundary rather than one exact figure; 5 Hz (the
// low end) is used so that vibrato at the low end of a natural singing
// vibrato's range (~5-8 Hz) still reads mostly as "fast", not "slow drift".
// A single fixed constant, not a control.
constexpr double kVibratoBoundaryHz = 5.0;

// M_PI isn't guaranteed available without _USE_MATH_DEFINES (MSVC), which
// this target doesn't set — a local constant avoids the compile-flag coupling.
constexpr double kPi = 3.14159265358979323846;

double centsOf(double hz) { return 1200.0 * std::log2(hz); }
double hzOfCents(double cents) { return std::exp2(cents / 1200.0); }

double clamp01Pct(double pct) { return std::clamp(pct, 0.0, 100.0) / 100.0; }

} // namespace

std::vector<int> scaleIntervals(ScaleType scale)
{
    switch (scale) {
        case ScaleType::Ionian:          return { 0, 2, 4, 5, 7, 9, 11 };
        case ScaleType::Dorian:          return { 0, 2, 3, 5, 7, 9, 10 };
        case ScaleType::Phrygian:        return { 0, 1, 3, 5, 7, 8, 10 };
        case ScaleType::Lydian:          return { 0, 2, 4, 6, 7, 9, 11 };
        case ScaleType::Mixolydian:      return { 0, 2, 4, 5, 7, 9, 10 };
        case ScaleType::Aeolian:         return { 0, 2, 3, 5, 7, 8, 10 };
        case ScaleType::Locrian:         return { 0, 1, 3, 5, 6, 8, 10 };
        case ScaleType::HarmonicMinor:   return { 0, 2, 3, 5, 7, 8, 11 };
        case ScaleType::MelodicMinor:    return { 0, 2, 3, 5, 7, 9, 11 };
        case ScaleType::MajorPentatonic: return { 0, 2, 4, 7, 9 };
        case ScaleType::MinorPentatonic: return { 0, 3, 5, 7, 10 };
    }
    return { 0, 2, 4, 5, 7, 9, 11 };  // unreachable: every enumerator handled above
}

std::vector<int> allowedPitchClasses(int key, ScaleType scale)
{
    std::vector<int> out;
    for (int iv : scaleIntervals(scale))
        out.push_back(((key + iv) % 12 + 12) % 12);
    std::sort(out.begin(), out.end());
    out.erase(std::unique(out.begin(), out.end()), out.end());
    return out;
}

double quantizeToNearestNote(double hz, const std::vector<int>& pitchClasses)
{
    if (!(hz > 0.0) || pitchClasses.empty()) return hz;

    const double midi = 69.0 + 12.0 * std::log2(hz / 440.0);
    double bestMidi = midi;
    double bestDist = 1e18;
    for (int pc : pitchClasses) {
        // Nearest MIDI note with this pitch class: round to the nearest
        // whole octave offset from `pc` rather than searching octaves.
        const double k = std::round((midi - (double)pc) / 12.0);
        const double candidate = k * 12.0 + (double)pc;
        const double dist = std::abs(candidate - midi);
        if (dist < bestDist) { bestDist = dist; bestMidi = candidate; }
    }
    return 440.0 * std::exp2((bestMidi - 69.0) / 12.0);
}

CorrectionCurveResult computeCorrectionCurve(
    const std::vector<PitchFrame>&  f0track,
    const std::vector<NoteSegment>& segments,
    double                          sampleRate,
    ScaleType                       scale,
    int                             key,
    const std::vector<int>&         allowedNotes,
    const CorrectionParams&         params)
{
    CorrectionCurveResult result;
    result.frames.reserve(f0track.size());
    if (f0track.empty() || !(sampleRate > 0.0)) return result;

    std::vector<int> pcs = allowedNotes;
    std::sort(pcs.begin(), pcs.end());
    pcs.erase(std::unique(pcs.begin(), pcs.end()), pcs.end());
    if (pcs.empty()) pcs = allowedPitchClasses(key, scale);

    const double holdMs     = std::clamp(params.jumpiness, 0.0, 100.0);  // 1% == 1ms
    const double amount     = clamp01Pct(params.correctionAmount);
    const double preserveV  = clamp01Pct(params.preserveVibrato);
    const double retuneMs   = std::max(0.0, params.retuneSpeedMs);
    const double smoothMs   = std::max(0.0, params.smoothnessMs);
    const double vibTauSec  = 1.0 / (2.0 * kPi * kVibratoBoundaryHz);

    bool   haveCommitted      = false;
    double committedCents     = 0.0;
    double lastCommitTimeSec  = 0.0;
    double releaseWindowEndS  = 0.0;
    double runningCents       = 0.0;
    double lastVoicedTimeSec  = 0.0;

    // Two cascaded one-pole stages (12 dB/oct) rather than one (6 dB/oct) —
    // still O(1) per frame, no allocations — so the slow/fast split actually
    // separates a real singing vibrato (5-8 Hz) from slow pitch drift near
    // the boundary instead of leaking half of it either way.
    bool   vibLpfInit   = false;
    double vibLpfState1 = 0.0;
    double vibLpfState2 = 0.0;

    bool   prevVoiced = false;
    size_t segIdx     = 0;

    for (const auto& fr : f0track) {
        CorrectionFrame out;
        out.posSample = fr.posSample;

        if (!fr.voiced || !(fr.f0Hz > 0.0f)) {
            out.targetF0Hz      = fr.f0Hz;
            out.correctionCents = 0.0f;
            result.frames.push_back(out);
            prevVoiced = false;
            continue;
        }

        const double tSec       = (double)fr.posSample / sampleRate;
        const double inputCents = centsOf((double)fr.f0Hz);

        // ── 1. quantize segment target ───────────────────────────────────
        while (segIdx + 1 < segments.size() && fr.posSample >= segments[segIdx].endSample)
            ++segIdx;
        double candidateHz;
        if (segIdx < segments.size()
            && fr.posSample >= segments[segIdx].startSample
            && fr.posSample <  segments[segIdx].endSample) {
            candidateHz = quantizeToNearestNote(segments[segIdx].medianF0Hz, pcs);
        } else {
            // No covering segment (shouldn't happen for a voiced frame from
            // analyzePitchTrack's own segmentation, but stay well-defined).
            candidateHz = quantizeToNearestNote((double)fr.f0Hz, pcs);
        }
        const double candidateCents = centsOf(candidateHz);

        const bool onset = !prevVoiced || !haveCommitted;
        if (onset) {
            committedCents    = candidateCents;
            lastCommitTimeSec = tSec;
            releaseWindowEndS = tSec;       // no release ramp needed at onset
            runningCents      = inputCents; // start exactly at the input pitch
            lastVoicedTimeSec = tSec;       // dt == 0 for this frame
            haveCommitted     = true;
            vibLpfInit        = false;      // reset the slow/fast split across the gap
        } else if (std::abs(candidateCents - committedCents) > 1e-9) {
            // ── 2. jumpiness hold ──────────────────────────────────────
            const double sinceLastCommitMs = (tSec - lastCommitTimeSec) * 1000.0;
            if (holdMs <= 0.0 || sinceLastCommitMs >= holdMs) {
                committedCents    = candidateCents;
                lastCommitTimeSec = tSec;
                releaseWindowEndS = tSec + smoothMs / 1000.0;
            }
            // else: held — the previously committed note stays in force.
        }

        // ── 3/4. retune-speed approach within the hold, or smoothness
        // ramp during the post-switch release window ──────────────────
        const double dt       = std::max(0.0, tSec - lastVoicedTimeSec);
        const bool   inRelease = tSec < releaseWindowEndS;
        const double tauMs     = inRelease ? smoothMs : retuneMs;
        if (tauMs <= 0.0) {
            runningCents = committedCents;
        } else {
            const double alpha = 1.0 - std::exp(-dt / (tauMs / 1000.0));
            runningCents += (committedCents - runningCents) * alpha;
        }
        const double correctedRawCents = runningCents;

        // ── 5. re-add scaled vibrato ────────────────────────────────────
        const double correction = correctedRawCents - inputCents;
        if (!vibLpfInit) {
            vibLpfState1 = correction;
            vibLpfState2 = correction;
            vibLpfInit = true;
        } else {
            const double alphaV = 1.0 - std::exp(-dt / vibTauSec);
            vibLpfState1 += (correction    - vibLpfState1) * alphaV;
            vibLpfState2 += (vibLpfState1  - vibLpfState2) * alphaV;
        }
        const double correctionSlow = vibLpfState2;
        const double correctionFast = correction - correctionSlow;
        const double correctionApplied = correctionSlow + (1.0 - preserveV) * correctionFast;

        // ── 6. scale total correction by amount ─────────────────────────
        const double finalCents = inputCents + amount * correctionApplied;

        out.targetF0Hz      = (float)hzOfCents(finalCents);
        out.correctionCents = (float)(finalCents - inputCents);
        result.frames.push_back(out);

        prevVoiced        = true;
        lastVoicedTimeSec = tSec;
    }

    return result;
}

} // namespace xleth::dsp
