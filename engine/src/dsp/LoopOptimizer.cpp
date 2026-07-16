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

} // namespace

LoopWindow detectSteadyStateWindow(const float* x, int N, double sampleRate)
{
    if (x == nullptr || N <= 0 || sampleRate <= 0.0) return kNoWindow;

    const int frameLen = (int)(kEnvelopeFrameMs * 0.001 * sampleRate);
    if (frameLen <= 0) return kNoWindow;

    // Whole frames only. A partial tail frame would average fewer samples and so
    // read as a level dip that isn't there, which could truncate a plateau that
    // actually runs to the end of the buffer. Dropping it costs at most one frame.
    const int numFrames = N / frameLen;
    if (numFrames <= 0) return kNoWindow;  // buffer shorter than one frame

    std::vector<float> env((size_t)numFrames);
    for (int f = 0; f < numFrames; ++f)
        env[(size_t)f] = computeRMS(x + (size_t)f * frameLen, frameLen);

    const float peak = *std::max_element(env.begin(), env.end());

    // Nothing anywhere in the buffer reaches audibility: there is no envelope to
    // find a plateau in, and every threshold below would be a fraction of noise.
    if (peak < kSilenceRMS) return kNoWindow;

    // Skip the attack transient: first frame reaching kAttackSkipFrac of peak.
    // The peak frame itself always clears this, so the search always succeeds;
    // the guard below is defensive, not a real branch.
    const float attackThr = kAttackSkipFrac * peak;
    int attackEnd = -1;
    for (int f = 0; f < numFrames; ++f)
        if (env[(size_t)f] >= attackThr) { attackEnd = f; break; }
    if (attackEnd < 0) return kNoWindow;

    // Longest contiguous run at or above kSustainThresholdFrac of peak, starting
    // no earlier than the attack. Ties keep the earliest run: on a decaying
    // sustain the earlier region is the louder and more periodic one.
    const float sustainThr = kSustainThresholdFrac * peak;
    int bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
    for (int f = attackEnd; f < numFrames; ++f) {
        if (env[(size_t)f] >= sustainThr) {
            if (curLen == 0) curStart = f;
            ++curLen;
            if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
        } else {
            curLen = 0;
        }
    }
    if (bestLen <= 0) return kNoWindow;

    const LoopWindow w{ (int64_t)bestStart * frameLen,
                        (int64_t)(bestStart + bestLen) * frameLen };

    // The refusal case that matters: a one-shot's plateau is a handful of frames
    // of decay, not a sustain. Below the viability floor we say so instead of
    // returning a window too short to loop.
    if (w.end - w.start < minViableWindowSamples(sampleRate)) return kNoWindow;

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

    // Lag bounds from the supported pitch range. Below tauMin there is nothing to
    // search; computeNSDF clamps tauMax to the frame length itself, so a short
    // window degrades to a narrower lag range rather than reading out of bounds.
    const int tauMin = std::max(1, (int)(sampleRate / kMaxPitchHz));
    const int tauMax = (int)(sampleRate / kMinPitchHz);
    if (tauMax <= tauMin) return out;
    if (winLen <= tauMin) return out;  // no room for even the shortest period

    // ── Per-hop period estimate + voicing gate ───────────────────────────────
    // This mirrors the structure of TDPSOLA.cpp's detectAllPeriods, reimplemented
    // locally on the shared computeNSDF/detectPeriod primitives, with two
    // deliberate differences:
    //   • No unvoiced gap-filling. TDPSOLA forward/backward-fills because it needs
    //     a period at every hop to drive synthesis. The unvoiced hops ARE the
    //     signal here — filling them would erase the very thing the gate measures.
    //   • A plain median over voiced hops instead of a running 5-point median.
    //     TDPSOLA needs a smooth per-hop track; we need one robust number.
    // Frames never straddle the window edge: a frame is taken only where it fits
    // whole, so no sample outside the window is ever read. (TDPSOLA zero-pads its
    // tail frame instead, because it must emit an estimate for every hop; we only
    // need statistics, so dropping a partial frame is strictly cleaner.)
    const int frameLen = std::min(kAnalysisFrame, winLen);

    std::vector<int>   voicedPeriods;
    std::vector<float> voicedClarity;
    int totalHops = 0;

    for (int s = wStart; s + frameLen <= wEnd; s += kAnalysisHop) {
        ++totalHops;
        const std::vector<float> nsdf = computeNSDF(x + s, frameLen, tauMin, tauMax);
        const int period = detectPeriod(nsdf, tauMin);
        if (period <= 0) continue;  // unvoiced: counted in totalHops, never filled

        // detectPeriod returns the lag but not its height, so read the clarity
        // back out of the NSDF at the lag it chose. That height is the McLeod
        // clarity measure and is what "voicing confidence" means here.
        const int idx = period - tauMin;
        if (idx < 0 || idx >= (int)nsdf.size()) continue;  // defensive; unreachable
        voicedPeriods.push_back(period);
        voicedClarity.push_back(nsdf[(size_t)idx]);
    }

    if (totalHops == 0) return out;

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
