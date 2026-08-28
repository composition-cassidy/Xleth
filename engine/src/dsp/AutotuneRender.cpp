#include "dsp/AutotuneRender.h"

#include "dsp/LoopOptimizer.h"   // kAnalysisFrame / kMinPitchHz / kMaxPitchHz

#include <algorithm>
#include <cmath>
#include <vector>

namespace xleth::dsp {

namespace {

// M_PI needs _USE_MATH_DEFINES on MSVC, which this target does not set — same
// local constant CorrectionCurve.cpp and SandboxRenderer.cpp both keep.
constexpr double kPi = 3.14159265358979323846;

// A voiced run shorter than this many source periods is left DRY rather than
// resynthesized. Below three periods there is no interior mark for the
// mark-stepper to lock onto (the seed period plus one on each side), so the
// grain sequence would be almost entirely edge cases — and a run that short is
// a detector twitch inside a consonant far more often than it is a note.
constexpr int kMinRegionPeriods = 3;

// Window-sum floor for the overlap-add normalization. Above it the accumulated
// audio is divided by the accumulated window (which is ~1 wherever grains
// overlap normally, so the division only removes edge attenuation and
// mark-spacing ripple). Below it there is not enough grain coverage for the
// division to mean anything — the only places that happens are the outer edges
// of a region's synthesis span, which sit inside the margin where the
// crossfade mask is already 0 — so the dry signal is used instead of dividing
// by a near-zero denominator.
constexpr float kWindowSumFloor = 0.2f;

double centsOf(double hz) { return 1200.0 * std::log2(hz); }
double hzOfCents(double c) { return std::exp2(c / 1200.0); }

// Raised cosine ramping 0 -> 1 across t in [0,1]. Same curve as
// SandboxFadeShape::Hann and dsp::DeclickEnvelope, so an AUTOTUNE seam
// declicks with exactly the shape the rest of the Sandbox uses.
inline double raisedCos(double t) noexcept {
    t = std::clamp(t, 0.0, 1.0);
    return 0.5 - 0.5 * std::cos(t * kPi);
}

// ─── Frame grid ───────────────────────────────────────────────────────────────
//
// PitchTrackAnalysis reports each frame at the sample its ANALYSIS WINDOW
// STARTS at (`posSample`), but the estimate describes the whole window
// [posSample, posSample + kAnalysisFrame). Rendering against the start would
// place every pitch change and every voicing boundary half a window (~21 ms at
// 48 kHz) early — enough, at a 10 ms crossfade, to put the fade on the wrong
// side of a consonant. So the grid used here is the window CENTRE. The shift is
// uniform across source f0, target f0 and voicing alike, so nothing inside the
// curve is re-timed relative to anything else — only the whole thing relative
// to the audio, which is the point.
struct FrameGrid {
    std::vector<double> srcCents;   // filled across unvoiced runs (see build())
    std::vector<double> tgtCents;   // == srcCents wherever there is nothing to correct
    std::vector<char>   voiced;

    double t0  = 0.0;   // centre time of frame 0, in samples
    double hop = 1.0;   // frame spacing, in samples

    bool empty() const { return voiced.empty(); }

    // Linear interpolation over a uniform grid — O(1), no search. Held flat
    // outside the authored range, same convention as gainEnvelopeDbAt.
    double lerp(const std::vector<double>& v, double sample) const noexcept {
        if (v.empty()) return 0.0;
        const double x = (sample - t0) / hop;
        if (x <= 0.0) return v.front();
        const double xmax = static_cast<double>(v.size() - 1);
        if (x >= xmax) return v.back();
        const size_t i = static_cast<size_t>(x);
        const double f = x - static_cast<double>(i);
        return v[i] + (v[i + 1] - v[i]) * f;
    }

    // Voicing is a boolean: it is sampled at the nearest frame, never blended.
    bool voicedAt(double sample) const noexcept {
        if (voiced.empty()) return false;
        const double x = (sample - t0) / hop;
        const long long i = std::llround(x);
        const long long last = static_cast<long long>(voiced.size()) - 1;
        return voiced[static_cast<size_t>(std::clamp<long long>(i, 0, last))] != 0;
    }
};

// Fills unvoiced frames' cents from the nearest voiced frame (forward pass then
// backward pass, the same two-pass hold TDPSOLA.cpp's detectAllPeriods uses).
// Marks placed just past a voiced boundary need a period, and the last real one
// is a far better guess than a hardcoded default. Returns false when there is
// no voiced frame at all to hold from.
bool buildGrid(const PitchTrackResult&      track,
               const CorrectionCurveResult& curve,
               double                       maxShiftCents,
               FrameGrid&                   out)
{
    const size_t n = track.frames.size();
    if (n == 0) return false;

    out.hop = (track.hopSamples > 0.0) ? track.hopSamples : 1.0;
    out.t0  = static_cast<double>(track.frames[0].posSample) + kAnalysisFrame * 0.5;

    out.srcCents.assign(n, 0.0);
    out.tgtCents.assign(n, 0.0);
    out.voiced.assign(n, 0);

    bool anyVoiced = false;
    for (size_t i = 0; i < n; ++i) {
        const PitchFrame& f = track.frames[i];
        if (!f.voiced || !(f.f0Hz > 0.0f)) continue;

        anyVoiced = true;
        out.voiced[i] = 1;
        out.srcCents[i] = centsOf(static_cast<double>(f.f0Hz));

        const float targetHz = curve.frames[i].targetF0Hz;
        double shift = (targetHz > 0.0f)
            ? centsOf(static_cast<double>(targetHz)) - out.srcCents[i]
            : 0.0;
        shift = std::clamp(shift, -maxShiftCents, maxShiftCents);
        out.tgtCents[i] = out.srcCents[i] + shift;
    }
    if (!anyVoiced) return false;

    // Forward hold, then backward hold for anything before the first voiced
    // frame. Target follows source across the gap: an unvoiced frame has
    // nothing to correct, so its ratio is 1.
    std::vector<char> filled(n, 0);
    for (size_t i = 0; i < n; ++i) filled[i] = out.voiced[i];
    {
        double last = 0.0; bool have = false;
        for (size_t i = 0; i < n; ++i) {
            if (out.voiced[i]) { last = out.srcCents[i]; have = true; }
            else if (have)     { out.srcCents[i] = last; out.tgtCents[i] = last; filled[i] = 1; }
        }
    }
    {
        double next = 0.0; bool have = false;
        for (size_t i = n; i-- > 0; ) {
            if (out.voiced[i]) { next = out.srcCents[i]; have = true; }
            else if (have && !filled[i]) { out.srcCents[i] = next; out.tgtCents[i] = next; filled[i] = 1; }
        }
    }
    return true;
}

// ─── Mark-detection signal ────────────────────────────────────────────────────
//
// A centred moving average over ~1/8 of a period: a crude linear-phase
// low-pass whose first null sits at 8*f0, so harmonics 1-7 survive and the
// high-frequency ripple that would otherwise decide which sample is "the peak"
// does not. Peak PICKING runs on this; the overlap-add itself always reads the
// untouched input, so nothing this filter does reaches the output.
std::vector<float> lowPassForMarks(const std::vector<float>& mono, int halfWidth)
{
    const int N = static_cast<int>(mono.size());
    std::vector<float> out(mono.size(), 0.0f);
    if (N == 0) return out;
    if (halfWidth < 1) return mono;

    // Prefix sums keep this O(N) regardless of the window width.
    std::vector<double> prefix(static_cast<size_t>(N) + 1, 0.0);
    for (int i = 0; i < N; ++i) prefix[i + 1] = prefix[i] + mono[i];

    for (int i = 0; i < N; ++i) {
        const int a = std::max(0, i - halfWidth);
        const int b = std::min(N, i + halfWidth + 1);
        out[i] = static_cast<float>((prefix[b] - prefix[a]) / static_cast<double>(b - a));
    }
    return out;
}

// Index of the largest SIGNED value in [a, b). Signed, not |x|: a glottal pulse
// excursion has one polarity, and picking the same polarity every time is what
// makes consecutive grains phase-coherent when they are overlap-added.
int argMax(const std::vector<float>& x, int a, int b)
{
    a = std::max(0, a);
    b = std::min(static_cast<int>(x.size()), b);
    if (b <= a) return a;
    int best = a;
    float bestV = x[static_cast<size_t>(a)];
    for (int i = a + 1; i < b; ++i) {
        if (x[static_cast<size_t>(i)] > bestV) { bestV = x[static_cast<size_t>(i)]; best = i; }
    }
    return best;
}

} // namespace

AutotuneRenderResult renderAutotune(const juce::AudioBuffer<float>& input,
                                    double                         sampleRate,
                                    const PitchTrackResult&        track,
                                    const CorrectionCurveResult&   curve,
                                    const AutotuneRenderOptions&   opts)
{
    AutotuneRenderResult result;

    const int N = input.getNumSamples();
    const int C = input.getNumChannels();

    if (N <= 0 || C <= 0 || !(sampleRate > 0.0)) {
        result.reason = "empty buffer";
        return result;
    }
    if (!track.valid()) {
        result.reason = "pitch analysis unavailable for this layer";
        return result;
    }
    if (!track.monophonic) {
        // The gate P5-1 sets. Its own wording is user-facing (see
        // PitchTrackResult::reason) — pass it straight through rather than
        // paraphrasing it into a second, driftable copy.
        result.reason = track.reason.empty()
            ? std::string("content is not monophonic — AUTOTUNE needs a single pitched voice")
            : track.reason;
        return result;
    }
    if (track.frames.size() != curve.frames.size()) {
        result.reason = "pitch track and correction curve disagree on frame count";
        return result;
    }

    FrameGrid grid;
    if (!buildGrid(track, curve, std::max(0.0, opts.maxShiftCents), grid)) {
        // Passed the monophonic gate but has no voiced frame to work from
        // (only reachable with a hand-built track). Nothing to correct is not
        // a failure — hand back an exact copy.
        result.buffer = input;
        result.ok = true;
        return result;
    }

    // Output starts as the input: every unvoiced sample, every skipped region
    // and every uncovered edge is a pass-through by construction rather than by
    // remembering to copy it back.
    result.buffer = input;
    result.ok = true;

    // ── One mark set for every channel ──────────────────────────────────────
    // Marks come from the mono sum and are applied identically to each channel.
    // Detecting per channel (which processTDPSOLA does, for a use where it does
    // not matter) would give the two sides different grain boundaries and
    // collapse the stereo image into phasing.
    std::vector<float> mono(static_cast<size_t>(N), 0.0f);
    {
        const float scale = 1.0f / static_cast<float>(C);
        for (int ch = 0; ch < C; ++ch) {
            const float* src = input.getReadPointer(ch);
            for (int i = 0; i < N; ++i) mono[static_cast<size_t>(i)] += src[i] * scale;
        }
    }

    const double minPeriod = std::max(2.0, sampleRate / kMaxPitchHz);
    const double maxPeriod = std::max(minPeriod + 1.0, sampleRate / kMinPitchHz);

    // Median voiced period sets the mark-detection filter width once for the
    // whole buffer: within one take the fundamental does not move enough for a
    // per-region filter to be worth the extra pass.
    double medianPeriod = 0.0;
    {
        std::vector<double> periods;
        periods.reserve(grid.voiced.size());
        for (size_t i = 0; i < grid.voiced.size(); ++i)
            if (grid.voiced[i]) periods.push_back(sampleRate / hzOfCents(grid.srcCents[i]));
        if (!periods.empty()) {
            std::sort(periods.begin(), periods.end());
            medianPeriod = periods[periods.size() / 2];
        }
    }
    const std::vector<float> lp =
        lowPassForMarks(mono, static_cast<int>(std::lround(medianPeriod / 16.0)));

    // Source period at a sample, from the (hold-filled) source-f0 grid.
    auto periodAt = [&](double sample) noexcept {
        const double hz = hzOfCents(grid.lerp(grid.srcCents, sample));
        if (!(hz > 0.0)) return maxPeriod;
        return std::clamp(sampleRate / hz, minPeriod, maxPeriod);
    };

    const int fadeLen  = std::max(1, static_cast<int>(std::lround(sampleRate * opts.crossfadeMs / 1000.0)));
    const int halfFade = std::max(1, fadeLen / 2);

    // ── Walk the voiced runs ────────────────────────────────────────────────
    const size_t numFrames = grid.voiced.size();
    size_t fi = 0;
    while (fi < numFrames) {
        if (!grid.voiced[fi]) { ++fi; continue; }
        size_t fj = fi;
        while (fj + 1 < numFrames && grid.voiced[fj + 1]) ++fj;

        // Region bounds on the CENTRE grid (see FrameGrid's comment), inclusive
        // of the last voiced frame's own hop.
        const int regionStart = static_cast<int>(std::clamp<double>(
            std::llround(grid.t0 + grid.hop * static_cast<double>(fi)), 0.0, N));
        const int regionEnd = static_cast<int>(std::clamp<double>(
            std::llround(grid.t0 + grid.hop * static_cast<double>(fj) + grid.hop), 0.0, N));

        fi = fj + 1;
        ++result.voicedRegions;

        const double regionPeriod = periodAt(0.5 * (regionStart + regionEnd));
        if (regionEnd - regionStart < static_cast<int>(kMinRegionPeriods * regionPeriod)) {
            ++result.regionsSkipped;
            continue;
        }

        // ── The crossfade mask ──────────────────────────────────────────────
        // 1 across the region's interior, ramping through 0 over `fadeLen`
        // centred on each voiced<->unvoiced boundary. A boundary that is the
        // BUFFER's own edge is not a voiced<->unvoiced transition and gets no
        // ramp — fading there would just un-correct the first/last 5 ms of a
        // buffer that happens to start mid-vowel.
        const bool rampIn  = regionStart > 0;
        const bool rampOut = regionEnd   < N;

        auto maskAt = [&](int t) noexcept -> double {
            double w = 1.0;
            if (rampIn) {
                const double u = static_cast<double>(t - (regionStart - halfFade)) / static_cast<double>(fadeLen);
                w = std::min(w, raisedCos(u));
            }
            if (rampOut) {
                const double u = static_cast<double>((regionEnd + halfFade) - t) / static_cast<double>(fadeLen);
                w = std::min(w, raisedCos(u));
            }
            return w;
        };

        // Synthesis span: the region plus a margin wide enough that the mask is
        // still exactly 0 where grain coverage runs out at either end. Two
        // periods past the ramp is generous; the cost is a few extra grains.
        const int margin = halfFade + static_cast<int>(2.0 * maxPeriod);
        const int lo = std::max(0, regionStart - margin);
        const int hi = std::min(N, regionEnd   + margin);
        if (hi - lo < 4) { ++result.regionsSkipped; continue; }

        // ── 1. Analysis marks, pitch-synchronous ────────────────────────────
        std::vector<int> marks;
        {
            const int seedP = static_cast<int>(std::lround(periodAt(lo)));
            int pos = argMax(lp, lo, std::min(hi, lo + std::max(2, seedP)));
            marks.push_back(pos);
            while (true) {
                const double P = periodAt(pos);
                const int cand = pos + static_cast<int>(std::lround(P));
                if (cand >= hi) break;
                // Re-lock to the local peak within a quarter period. The search
                // is centred on the PREVIOUS mark plus one period, so a mark
                // can drift at most T0/4 per step and is re-anchored every
                // step rather than integrating its own error.
                const int r = std::max(1, static_cast<int>(P * 0.25));
                int next = argMax(lp, cand - r, std::min(hi, cand + r + 1));
                if (next <= pos) next = cand;          // never stall or reverse
                marks.push_back(next);
                pos = next;
            }
        }
        if (marks.size() < 3) { ++result.regionsSkipped; continue; }
        result.analysisMarks += static_cast<int64_t>(marks.size());

        // ── 2/3. Synthesis marks at the target period, overlap-added ────────
        const int span = hi - lo;
        std::vector<std::vector<float>> num(static_cast<size_t>(C),
                                            std::vector<float>(static_cast<size_t>(span), 0.0f));
        std::vector<float> den(static_cast<size_t>(span), 0.0f);

        // ── Why the synthesis walk is seeded ON an analysis mark, and steps by
        // the MEASURED mark spacing rather than by sampleRate/targetF0 ────────
        //
        // Both details exist for the same reason: at ratio 1 the synthesis
        // instants must land exactly ON the analysis instants, or every grain
        // is copied from a mark and dropped somewhere else in its own period,
        // and the overlap-add combs its neighbours instead of reinforcing them.
        // A walk seeded at an arbitrary sample (lo) is already half a period
        // out on its first grain; one stepping by sampleRate/f0_estimate then
        // drifts, because the estimate and the re-locked mark spacing agree
        // closely but never exactly, and thousands of grains accumulate it.
        //
        // Stepping by paRight/ratio fixes both: at ratio 1 the step IS the
        // distance to the next mark, so s stays in lockstep forever, and at any
        // other ratio the output period is the local analysis period divided by
        // exactly the ratio the correction asked for — which is the definition
        // of the pitch move, expressed in the marks the audio actually has
        // rather than in an estimate of them.
        double s = static_cast<double>(marks.front());
        while (s < static_cast<double>(hi)) {
            const int sPos = static_cast<int>(std::lround(s));

            // Fade the CORRECTION with the same mask that fades the waveform.
            // At the seam the ratio is 1, so the resynthesis there reconstructs
            // the dry signal and the crossfade has two near-identical sides to
            // blend — which is what stops a consonant boundary from clicking
            // AND from being smeared by a grain rate it never asked for.
            const double w = maskAt(sPos);
            const double srcC = grid.lerp(grid.srcCents, s);
            const double shift = w * (grid.lerp(grid.tgtCents, s) - srcC);
            const double ratio = hzOfCents(shift);   // target f0 / source f0

            // Nearest analysis mark. Time is not scaled — output time IS input
            // time — so "nearest in the output" and "nearest in the input" are
            // the same question, and the mapping is a plain search.
            size_t mi = static_cast<size_t>(
                std::lower_bound(marks.begin(), marks.end(), sPos) - marks.begin());
            if (mi >= marks.size()) mi = marks.size() - 1;
            else if (mi > 0 && (sPos - marks[mi - 1]) <= (marks[mi] - sPos)) --mi;

            const int a = marks[mi];
            const int paLeft  = (mi > 0)                ? (a - marks[mi - 1]) : (marks[1] - marks[0]);
            const int paRight = (mi + 1 < marks.size()) ? (marks[mi + 1] - a) : (a - marks[mi - 1]);

            const double Ps = std::clamp(static_cast<double>(std::max(1, paRight)) / ratio,
                                         minPeriod, maxPeriod);
            if (paLeft < 1 || paRight < 1) { s += Ps; continue; }

            // Asymmetric Hann: a rising half over the previous analysis period,
            // a falling half over the next. When the pitch is steady the two
            // halves are equal and this IS the textbook 2*T0 Hann; when it is
            // moving, each half tracks the period it actually spans instead of
            // averaging the two.
            for (int i = -paLeft; i < paRight; ++i) {
                const int srcIdx = a + i;
                if (srcIdx < 0 || srcIdx >= N) continue;
                const int dstIdx = sPos + i - lo;
                if (dstIdx < 0 || dstIdx >= span) continue;

                const float wg = (i < 0)
                    ? static_cast<float>(0.5 - 0.5 * std::cos(kPi * static_cast<double>(i + paLeft) / paLeft))
                    : static_cast<float>(0.5 + 0.5 * std::cos(kPi * static_cast<double>(i) / paRight));

                for (int ch = 0; ch < C; ++ch)
                    num[static_cast<size_t>(ch)][static_cast<size_t>(dstIdx)] +=
                        input.getReadPointer(ch)[srcIdx] * wg;
                den[static_cast<size_t>(dstIdx)] += wg;
            }

            ++result.grainsSynthesized;
            s += Ps;
        }

        // ── 4. Normalize and crossfade back over the dry signal ─────────────
        // Dividing by the accumulated window is what makes the level correct
        // for ANY ratio: shift up and there are more, tighter grains, so both
        // the audio and the window grow together and the quotient does not
        // move. It also flattens the ripple that irregular mark spacing would
        // otherwise leave, at no extra cost — the denominator is already there.
        for (int ch = 0; ch < C; ++ch) {
            float* dst = result.buffer.getWritePointer(ch);
            const float* dry = input.getReadPointer(ch);
            const std::vector<float>& acc = num[static_cast<size_t>(ch)];
            for (int i = 0; i < span; ++i) {
                const float d = den[static_cast<size_t>(i)];
                if (d <= kWindowSumFloor) continue;   // uncovered edge: stays dry
                const int t = lo + i;
                const double w = maskAt(t);
                if (w <= 0.0) continue;
                const float wet = acc[static_cast<size_t>(i)] / d;
                dst[t] = static_cast<float>(w * wet + (1.0 - w) * dry[t]);
            }
        }
    }

    return result;
}

} // namespace xleth::dsp
