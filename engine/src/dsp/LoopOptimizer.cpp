#include "dsp/LoopOptimizer.h"
#include "dsp/LoopAnalysis.h"

#include <algorithm>
#include <cstdint>
#include <vector>

namespace xleth::dsp {

namespace {

// The empty window / refusal signal. Named so the intent reads at every return
// site: this is "no viable region", not a failure.
constexpr LoopWindow kNoWindow{0, 0};

// Median of a sample set, by value (the copy is the point — callers keep their
// own order, and this runs offline where a copy costs nothing).
// For an even count this takes the upper-middle element rather than averaging
// the two central ones: the caller wants a period in whole samples, and an
// averaged 367.5 would only be rounded back anyway.
template <typename T>
T medianOf(std::vector<T> v)
{
    std::sort(v.begin(), v.end());
    return v[v.size() / 2];
}

// Minimum plateau length for a window to be worth returning, in samples.
// kMinViablePeriods periods at kMinPitchHz — see the header for the reasoning
// behind the period count.
int64_t minViableWindowSamples(double sampleRate)
{
    return (int64_t)(kMinViablePeriods * sampleRate / kMinPitchHz);
}

// One analysis hop's result. The shared pass emits one of these per hop across
// the queried range; detectSteadyStateWindow reads .period/.rms to place the
// window, generateLoopCandidates reads .period/.clarity to gate voicing and pick
// the fundamental.
struct HopAnalysis {
    int   startSample;  // sample index where this hop's analysis frame begins
    int   period;       // detectPeriod result in samples; 0 == unvoiced
    float clarity;      // NSDF peak height at .period (0 when unvoiced)
    float rms;          // level over the first kEnvelopeFrameMs of this hop (see analyzeHops)
};

// The single shared voicing pass, called by BOTH public functions so they can
// never drift apart on frame size, hop, lag bounds, or the definition of
// "voiced". Runs kAnalysisFrame-long frames (clamped to the range) at kAnalysisHop
// spacing over [wStart, wEnd), lag-bounded by the supported pitch range. A hop is
// emitted only where its whole frame fits, so no sample outside [wStart, wEnd) is
// read — this is also where the old degenerate-range guards live now: an empty
// return means the range was shorter than one frame or the lag range collapsed
// (tauMax <= tauMin, or winLen <= tauMin). Unvoiced hops are recorded as
// period == 0, never gap-filled: the unvoiced hops are themselves the signal both
// callers measure.
std::vector<HopAnalysis> analyzeHops(const float* x, double sampleRate,
                                     int wStart, int wEnd)
{
    std::vector<HopAnalysis> hops;
    const int winLen = wEnd - wStart;
    if (winLen <= 0) return hops;

    const int tauMin = std::max(1, (int)(sampleRate / kMaxPitchHz));
    const int tauMax = (int)(sampleRate / kMinPitchHz);
    if (tauMax <= tauMin || winLen <= tauMin) return hops;

    const int frameLen = std::min(kAnalysisFrame, winLen);

    // The level envelope is measured over a SHORT kEnvelopeFrameMs window at the
    // hop's start, NOT over the whole NSDF frame. Reading the level across the full
    // 46 ms frame would look that far ahead of the hop, so on a swelling note each
    // hop would report the louder material in front of it and the attack skip would
    // fire early. It always fits: envLen <= frameLen and the frame is in bounds.
    const int envLen = std::max(1, std::min(frameLen, (int)(kEnvelopeFrameMs * 0.001 * sampleRate)));

    for (int s = wStart; s + frameLen <= wEnd; s += kAnalysisHop) {
        HopAnalysis h{ s, 0, 0.0f, computeRMS(x + s, envLen) };
        const std::vector<float> nsdf = computeNSDF(x + s, frameLen, tauMin, tauMax);
        const int period = detectPeriod(nsdf, tauMin);
        if (period > 0) {
            // detectPeriod returns the lag but not its height, so read the clarity
            // (the McLeod peak height = voicing confidence) back out of the NSDF.
            const int idx = period - tauMin;
            if (idx >= 0 && idx < (int)nsdf.size()) {  // defensive; always in range
                h.period  = period;
                h.clarity = nsdf[(size_t)idx];
            }
        }
        hops.push_back(h);
    }
    return hops;
}

} // namespace

LoopWindow detectSteadyStateWindow(const float* x, int N, double sampleRate)
{
    if (x == nullptr || N <= 0 || sampleRate <= 0.0) return kNoWindow;

    // Voicing is the PRIMARY signal. One shared per-hop pass over the whole buffer;
    // RMS is read back from the same hops as a secondary level cue.
    const std::vector<HopAnalysis> hops = analyzeHops(x, sampleRate, 0, N);
    if (hops.empty()) return kNoWindow;  // buffer too short for a single frame

    // Fundamental period = median over ALL voiced hops, the same robust estimate
    // generateLoopCandidates trusts. Body hops outnumber the occasional overtone-
    // locked hop, so the median lands on the true fundamental.
    std::vector<int> voicedPeriods;
    for (const HopAnalysis& h : hops)
        if (h.period > 0) voicedPeriods.push_back(h.period);
    if (voicedPeriods.empty()) return kNoWindow;   // no voiced hop: true one-shot / texture
    const int fundamental = medianOf(voicedPeriods);
    if (fundamental <= 0) return kNoWindow;

    // A hop is TONAL when voiced at (near) the fundamental. This is the heart of the
    // fix and a deliberate strengthening of a plain voiced/unvoiced test: the corpus
    // proved a loud, non-loopable region need not be unvoiced — on Pitch_17_C3 the
    // loud tail is sparsely voiced at a ~800 Hz overtone (≈6× the 131 Hz body).
    // "Voiced" alone let that tail set the level bar and be chosen; "voiced at the
    // fundamental" excludes it, its period being far outside the ±tolerance band.
    // Octave locks (½× / 2×) fall outside the band too.
    const auto isTonal = [&](const HopAnalysis& h) {
        if (h.period <= 0) return false;
        const double ratio = (double)h.period / (double)fundamental;
        return ratio >= 1.0 - kFundamentalPeriodTolerance
            && ratio <= 1.0 + kFundamentalPeriodTolerance;
    };

    // Pick the loudest VIABLE tonal run. Scan maximal contiguous runs of tonal
    // hops, keep those spanning at least the viability floor, and take the one with
    // the greatest mean RMS. Loudness, not length, is the discriminant: where a
    // sample has two tonal stretches — e.g. Pitch_64_D4's loud clean onset and its
    // quieter, slightly longer decay — the loud one gives usable seams and the
    // quiet one does not, and the overtone tail that used to hijack loudness is no
    // longer in the running (it is not tonal).
    const int64_t minSpan = minViableWindowSamples(sampleRate);
    int    bestStart = -1, bestEnd = -1;
    double bestMeanRms = -1.0;
    for (int i = 0; i < (int)hops.size();) {
        if (!isTonal(hops[(size_t)i])) { ++i; continue; }
        int    j   = i;
        double sum = 0.0;
        while (j < (int)hops.size() && isTonal(hops[(size_t)j])) { sum += hops[(size_t)j].rms; ++j; }
        const int     re   = j - 1;  // inclusive end of the run [i, re]
        const int64_t span = (int64_t)hops[(size_t)re].startSample - hops[(size_t)i].startSample;
        if (span >= minSpan) {
            const double meanRms = sum / (double)(j - i);
            if (meanRms > bestMeanRms) { bestMeanRms = meanRms; bestStart = i; bestEnd = re; }
        }
        i = j;
    }
    if (bestStart < 0) return kNoWindow;  // no tonal run long enough to loop

    // Within the chosen run, anchor the level thresholds to the RUN's own peak RMS
    // (never the file's), then apply the classic attack-skip and sustain trim:
    //   • attack skip — advance to the first hop at kAttackSkipFrac of the run peak,
    //     dropping the onset ramp so loopStart does not land in the attack.
    //   • sustain trim — pull the tail in past any trailing hops below
    //     kSustainThresholdFrac of the run peak (a decay that is still tonal but
    //     fading). Internal dips are kept; only the trailing decay is trimmed.
    double runPeak = 0.0;
    for (int i = bestStart; i <= bestEnd; ++i) runPeak = std::max(runPeak, (double)hops[(size_t)i].rms);
    const double attackThr  = kAttackSkipFrac * runPeak;
    const double sustainThr = kSustainThresholdFrac * runPeak;

    int startHop = bestStart;
    for (int i = bestStart; i <= bestEnd; ++i)
        if ((double)hops[(size_t)i].rms >= attackThr) { startHop = i; break; }

    int endHop = bestEnd;
    while (endHop > startHop && (double)hops[(size_t)endHop].rms < sustainThr) --endHop;

    const int frameLen = std::min(kAnalysisFrame, N);
    const LoopWindow w{
        (int64_t)hops[(size_t)startHop].startSample,
        std::min<int64_t>(N, (int64_t)hops[(size_t)endHop].startSample + frameLen)
    };

    // Viability on the post-trim sustain span (distance between the first and last
    // kept hop starts), not the raw window length: a single tonal hop already spans
    // a whole analysis frame, so a window-length test would let a lone voiced frame
    // slip through, while the span between hop starts is 0 there and only grows with
    // real sustain. The attack/sustain trims can shrink the run, so re-check here.
    const int64_t sustainSpan = (int64_t)hops[(size_t)endHop].startSample
                              - (int64_t)hops[(size_t)startHop].startSample;
    if (sustainSpan < minSpan) return kNoWindow;

    return w;
}

std::vector<LoopCandidate> generateLoopCandidates(const float* x, int N,
                                                  double sampleRate,
                                                  LoopWindow window)
{
    std::vector<LoopCandidate> out;
    if (x == nullptr || N <= 0 || sampleRate <= 0.0) return out;

    // The window is a hard boundary, but a caller-supplied one is not trusted to
    // be in range: clamp to the buffer before anything reads through it.
    const int wStart = (int)std::max<int64_t>(0, window.start);
    const int wEnd   = (int)std::min<int64_t>(N, window.end);
    const int winLen = wEnd - wStart;
    if (winLen <= 0) return out;

    // ── Per-hop period estimate + voicing gate ───────────────────────────────
    // The single shared voicing pass — identical to the one detectSteadyStateWindow
    // runs — so the two never disagree on frame size, hop, lag bounds, or what
    // "voiced" means. An empty result also subsumes the old degenerate-range
    // guards (tauMax <= tauMin, winLen <= tauMin): analyzeHops emits no hops there.
    const std::vector<HopAnalysis> hops = analyzeHops(x, sampleRate, wStart, wEnd);
    if (hops.empty()) return out;

    std::vector<int>   voicedPeriods;
    std::vector<float> voicedClarity;
    for (const HopAnalysis& h : hops) {
        if (h.period > 0) {
            voicedPeriods.push_back(h.period);
            voicedClarity.push_back(h.clarity);
        }
    }
    const int totalHops = (int)hops.size();

    // Strict majority: at exactly half voiced the material is as much unpitched as
    // pitched, and a fundamental derived from the rest describes half the window.
    if ((float)voicedPeriods.size() <= kMinVoicedFrac * (float)totalHops) return out;

    // Not reliably pitched-monophonic. Refuse rather than fall back to a
    // correlation-only guess: that fallback is a later phase, and guessing here
    // would launder unpitched material into confident-looking candidates.
    if (medianOf(voicedClarity) < kMinMedianClarity) return out;

    // Median, not any single hop's estimate: local jitter and the occasional
    // octave-slipped outlier are exactly what a median is robust to and a point
    // estimate is not.
    const int periodSamples = medianOf(voicedPeriods);
    if (periodSamples <= 0) return out;

    // ── Loop start ───────────────────────────────────────────────────────────
    // snapZeroCrossing searches ±10% of t0 around its centre and probes x[i-1],
    // so placing the raw start jitter+1 inside the window keeps that entire
    // search — probe included — within the boundary. It also implements the
    // "soft edges" policy: the window's own edge is never a loop point verbatim.
    const int jitter   = std::max(1, periodSamples / 10);
    const int rawStart = wStart + jitter + 1;
    if (rawStart >= wEnd) return out;
    const int loopStart = snapZeroCrossing(x, N, rawStart, periodSamples);

    // ── Loop length search ───────────────────────────────────────────────────
    // One candidate per k, each a whole number of periods long, phase-aligned by
    // correlation and snapped to a zero crossing.
    const int refN = std::max(1, periodSamples * kSeamCorrelationPeriods);
    const int maxLoopLen = (int)std::min(kMaxLoopDurationSec * sampleRate, (double)winLen);
    const int kMax = maxLoopLen / periodSamples;

    for (int k = 1; k <= kMax; ++k) {
        const int64_t rawEnd = (int64_t)loopStart + (int64_t)k * periodSamples;

        // Search a ±10% neighbourhood of the period-quantized guess — the same
        // jitter convention snapZeroCrossing uses, so the correlation search and
        // the snap that follows it agree on how far a pitch mark may drift.
        const int searchLo = (int)(rawEnd - jitter);
        const int searchHi = (int)(rawEnd + jitter);
        if (searchLo <= loopStart) continue;

        // The whole correlation region stays inside the window. This is the
        // strict reading of the hard boundary, and it happens to reserve exactly
        // the headroom a seam crossfade needs to read past loopEnd. rawEnd only
        // grows with k, so once this fails it fails for every larger k.
        if ((int64_t)searchHi + refN > wEnd) break;

        // Compare the region AT loopStart against the region at each candidate
        // end: if x[end + n] ≈ x[loopStart + n], the jump back is continuous.
        const CorrPeak peak = bestCorrelationLag(x + loopStart, refN,
                                                 x + searchLo, (searchHi - searchLo) + refN,
                                                 0, searchHi - searchLo);

        int loopEnd = searchLo + peak.lag;
        loopEnd = snapZeroCrossing(x, N, loopEnd, periodSamples);

        // The snap can move the point by up to ±jitter, so re-check the boundary
        // rather than trusting the pre-snap check. (The snap's own probe cannot
        // leave the window: searchHi + jitter <= searchHi + refN <= wEnd, since
        // refN is a whole period and jitter is a tenth of one.)
        if (loopEnd <= loopStart) continue;
        if ((int64_t)loopEnd + refN > wEnd) continue;

        // Re-measure at the snapped position. seamNcc must describe the candidate
        // actually returned, not the alignment the search peaked at before the
        // snap moved it — reporting the latter would overstate the seam.
        const float seamNcc = normalizedCrossCorrelation(x + loopStart, x + loopEnd, refN);
        if (seamNcc < kMinSeamNcc) continue;

        const int64_t loopLen = (int64_t)loopEnd - loopStart;

        // The half-loop cap is structural — a crossfade longer than half the loop
        // would overlap itself — so it wins over the click-suppression floor when
        // the two disagree on a short loop. std::clamp is deliberately not used:
        // its lo > hi case is undefined behaviour and is reachable here.
        const int64_t fade = std::min(std::max((int64_t)periodSamples / 4,
                                               kMinClickSuppressionSamples),
                                      loopLen / 2);

        out.push_back(LoopCandidate{
            (int64_t)loopStart,
            (int64_t)loopEnd,
            fade,
            periodSamples,
            k,
            seamNcc,
        });
    }

    return out;
}

} // namespace xleth::dsp
