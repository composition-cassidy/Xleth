#include "sandbox/SandboxRenderer.h"
#include "HardwareTier.h"

#include "dsp/AutotuneRender.h"
#include "dsp/CorrectionCurve.h"
#include "dsp/RubberBandWrapper.h"
#include "dsp/VarispeedResample.h"

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <string>
#include <utility>
#include <vector>

namespace xleth::sandbox {

namespace {

constexpr double kPi = 3.14159265358979323846;

// Same FNV-1a the model tier uses for op hashes — the render key digest has to
// be stable for the same reasons, and this file must not pull in a second hash.
constexpr uint64_t kFnvOffset = 1469598103934665603ull;
constexpr uint64_t kFnvPrime  = 1099511628211ull;

inline uint64_t hashU64(uint64_t h, uint64_t v) noexcept {
    const auto* p = reinterpret_cast<const unsigned char*>(&v);
    for (size_t i = 0; i < sizeof v; ++i) { h ^= static_cast<uint64_t>(p[i]); h *= kFnvPrime; }
    return h;
}

// Resolve [start, end) against a real length, honouring "end < 0 = to the end".
struct Range { int64_t start = 0; int64_t end = 0; };

Range resolveRange(int64_t start, int64_t end, int64_t length) noexcept {
    if (length <= 0) return {};
    const int64_t s = std::clamp<int64_t>(start, 0, length);
    const int64_t e = std::clamp<int64_t>(end < 0 ? length : end, 0, length);
    return (e <= s) ? Range{ s, s } : Range{ s, e };
}

inline float dbToGain(double db) noexcept {
    return static_cast<float>(std::pow(10.0, db / 20.0));
}

// Fade curve at normalized position t in [0,1], for a 0→1 ramp.
float fadeCurve(SandboxFadeShape shape, double t) noexcept {
    t = std::clamp(t, 0.0, 1.0);
    switch (shape) {
        case SandboxFadeShape::Linear:      return static_cast<float>(t);
        case SandboxFadeShape::EqualPower:  return static_cast<float>(std::sin(t * kPi * 0.5));
        case SandboxFadeShape::Exponential: return static_cast<float>(t * t);
        case SandboxFadeShape::Logarithmic: return static_cast<float>(1.0 - (1.0 - t) * (1.0 - t));
        case SandboxFadeShape::SCurve:      return static_cast<float>(t * t * (3.0 - 2.0 * t));
        // Same raised-cosine ramp as dsp::DeclickEnvelope::sLut — kept as an
        // explicit formula (rather than a link against XlethEngineModel's dsp
        // target) so this file's only dependency stays JUCE + <cmath>.
        case SandboxFadeShape::Hann:        return static_cast<float>(0.5 - 0.5 * std::cos(t * kPi));
    }
    return static_cast<float>(t);
}

SandboxBuffer makeBuffer(int channels, int64_t samples) {
    SandboxBuffer b(std::max(1, channels),
                    static_cast<int>(std::max<int64_t>(0, samples)));
    b.clear();
    return b;
}

// ─── The implemented ops ──────────────────────────────────────────────────────
// Everything below works purely in engine-buffer samples. No op consults the
// sample rate: a trim is a trim at any rate, and the rate is carried in the
// cache key so a stack authored at one rate is never reused at another.

SandboxBuffer applyTrim(const SandboxBuffer& in, const TrimParams& p) {
    const int64_t len = in.getNumSamples();
    const Range   r   = resolveRange(p.startSample, p.endSample, len);
    const int64_t out = r.end - r.start;

    SandboxBuffer dst = makeBuffer(in.getNumChannels(), out);
    if (out <= 0) return dst;

    for (int ch = 0; ch < in.getNumChannels(); ++ch)
        dst.copyFrom(ch, 0, in, ch, static_cast<int>(r.start), static_cast<int>(out));
    return dst;
}

SandboxBuffer applyCut(const SandboxBuffer& in, const CutParams& p) {
    const int64_t len = in.getNumSamples();
    const Range   r   = resolveRange(p.startSample, p.endSample, len);
    const int64_t cut = r.end - r.start;

    if (p.mode == SandboxRippleMode::Gap) {
        // Length preserved, range silenced.
        SandboxBuffer dst(in);
        if (cut > 0)
            for (int ch = 0; ch < dst.getNumChannels(); ++ch)
                dst.clear(ch, static_cast<int>(r.start), static_cast<int>(cut));
        return dst;
    }

    // Ripple: close the gap.
    const int64_t out = len - cut;
    SandboxBuffer dst = makeBuffer(in.getNumChannels(), out);
    if (out <= 0) return dst;

    const int64_t tailLen = len - r.end;
    for (int ch = 0; ch < in.getNumChannels(); ++ch) {
        if (r.start > 0)
            dst.copyFrom(ch, 0, in, ch, 0, static_cast<int>(r.start));
        if (tailLen > 0)
            dst.copyFrom(ch, static_cast<int>(r.start), in, ch,
                         static_cast<int>(r.end), static_cast<int>(tailLen));
    }
    return dst;
}

SandboxBuffer applyReverse(const SandboxBuffer& in, const ReverseParams& p) {
    SandboxBuffer dst(in);
    const Range r = resolveRange(p.startSample, p.endSample, in.getNumSamples());
    const int64_t n = r.end - r.start;
    if (n <= 1) return dst;

    for (int ch = 0; ch < dst.getNumChannels(); ++ch) {
        float* d = dst.getWritePointer(ch);
        std::reverse(d + r.start, d + r.end);
    }
    return dst;
}

SandboxBuffer applyFade(const SandboxBuffer& in, const FadeParams& p) {
    SandboxBuffer dst(in);
    const int64_t len = dst.getNumSamples();
    if (len <= 0 || p.lengthSamples <= 0) return dst;

    const Range r = resolveRange(p.startSample, p.startSample + p.lengthSamples, len);
    const int64_t n = r.end - r.start;
    if (n <= 0) return dst;

    // The curve spans the REQUESTED length, not the clamped one: a fade-out
    // whose window runs past the buffer end must still be most of the way down
    // when the audio stops, rather than being stretched to fit what survived.
    const double span = static_cast<double>(p.lengthSamples);

    for (int ch = 0; ch < dst.getNumChannels(); ++ch) {
        float* d = dst.getWritePointer(ch);
        for (int64_t i = 0; i < n; ++i) {
            const double t = static_cast<double>(r.start + i - p.startSample) / span;
            const float  g = fadeCurve(p.shape, p.fadeIn ? t : 1.0 - t);
            d[r.start + i] *= g;
        }
    }
    return dst;
}

SandboxBuffer applyGain(const SandboxBuffer& in, const GainParams& p) {
    SandboxBuffer dst(in);
    const Range r = resolveRange(p.startSample, p.endSample, dst.getNumSamples());
    const int64_t n = r.end - r.start;
    if (n <= 0) return dst;

    float gain;
    if (p.normalize) {
        // Peak of the RANGE, across all channels, so a normalize never shifts
        // the stereo image.
        float peak = 0.0f;
        for (int ch = 0; ch < dst.getNumChannels(); ++ch) {
            const float* d = dst.getReadPointer(ch);
            for (int64_t i = r.start; i < r.end; ++i) peak = std::max(peak, std::abs(d[i]));
        }
        // Digital silence has no peak to normalize to. Leave it alone rather
        // than dividing by zero and handing playback a buffer full of inf.
        if (peak <= 0.0f) return dst;
        gain = dbToGain(p.targetPeakDb) / peak;
    } else {
        gain = dbToGain(p.gainDb);
    }

    for (int ch = 0; ch < dst.getNumChannels(); ++ch)
        dst.applyGain(ch, static_cast<int>(r.start), static_cast<int>(n), gain);
    return dst;
}

// Stereo-linked (max-across-channels) smoothed RMS envelope follower over the
// WHOLE input buffer, in dB. One pass, forward, causal — this is the "natural
// dynamics" trace Relative mode scales its drawn curve against.
//
// Asymmetric one-pole: rises on the ATTACK coefficient whenever the signal's
// mean square is above the current envelope, falls on the RELEASE coefficient
// otherwise. Same coefficient formula the realtime compressor uses
// (XlethCompressorEffect.h) — coeff = exp(-1 / (timeSec * sampleRate)) — so a
// given attack/release number means the same thing here as it does there, even
// though this follower runs once, offline, over a buffer it already holds in
// full rather than sample-by-sample under an audio callback.
//
// Stereo-linked rather than per-channel: applyGainEnvelope applies one gain to
// every channel (never shifting the stereo image), so the envelope it reacts
// to has to be a single shared trace too, not one that could disagree between
// channels about when the transient happened.
std::vector<double> gainEnvelopeFollowerDb(const SandboxBuffer& in, double sampleRate,
                                           double attackMs, double releaseMs) {
    const int64_t len = in.getNumSamples();
    std::vector<double> out(static_cast<size_t>(std::max<int64_t>(0, len)), kGainEnvelopeSilenceDb);
    if (len <= 0 || sampleRate <= 0.0) return out;

    const int numCh = in.getNumChannels();
    const double aCoeff = std::exp(-1.0 / std::max(attackMs  * 0.001 * sampleRate, 1e-6));
    const double rCoeff = std::exp(-1.0 / std::max(releaseMs * 0.001 * sampleRate, 1e-6));

    const auto meanSq = [&](int64_t i) {
        double sq = 0.0;
        for (int ch = 0; ch < numCh; ++ch) {
            const double s = in.getSample(ch, static_cast<int>(i));
            sq += s * s;
        }
        return sq / std::max(1, numCh);
    };

    // Seeded from the FIRST sample rather than from digital silence: this
    // buffer did not just start playing, the whole thing is already in hand,
    // so there is no reason to manufacture a fake "rising from nothing"
    // transient at sample 0. Left seeded at 0, that phantom dip would become
    // the buffer-wide envelope minimum on anything that starts at a normal
    // level, dragging normalized(t) up everywhere else in Relative mode and
    // quietly weakening every duck the curve draws.
    double env = meanSq(0);
    for (int64_t i = 0; i < len; ++i) {
        const double sq = i == 0 ? env : meanSq(i);
        if (i > 0) {
            const double coeff = sq > env ? aCoeff : rCoeff;
            env = coeff * env + (1.0 - coeff) * sq;
        }

        const double level = std::sqrt(std::max(env, 0.0));
        out[static_cast<size_t>(i)] = level > 0.0
            ? std::max(kGainEnvelopeSilenceDb, 20.0 * std::log10(level))
            : kGainEnvelopeSilenceDb;
    }
    return out;
}

// A gain CURVE rather than a scalar: one multiply per sample, the coefficient
// re-evaluated at every sample position from the breakpoint list.
//
// Deliberately NOT block-rate + smoothing, which is how the realtime effects in
// this codebase dezipper their parameters (SmoothedHandle, the per-buffer geo[]
// rebuild in MANGLE). That machinery exists to keep a control-rate parameter
// from stepping audibly between blocks; here there is no control rate to fight.
// The curve is already continuous and already C¹ (smoothstep between
// breakpoints), the whole buffer is in hand, and this runs offline — so the
// exact per-sample coefficient is both cheaper to reason about and strictly
// more correct than any smoothed approximation of it.
//
// The same channel gain is applied to every channel, so a duck never shifts the
// stereo image — the same rule applyGain's normalize path follows.
//
// ── Mode 2 (Relative) ─────────────────────────────────────────────────────────
// The drawn curve does not replace the material's own dynamics, it MULTIPLIES
// them: 0 dB drawn must mean "leave the natural level alone", not "hold the
// output at some fixed absolute level" — the two only coincide in Absolute
// mode. So Relative mode cannot just apply drawnDb(t) as a gain the way
// Absolute does (that IS Absolute — the same numeric curve, applied without
// regard for what the signal is actually doing, is exactly what "flattens"
// microdynamics inside a wide, hand-drawn window: a quiet passage sitting under
// the same drawn dip as a loud transient gets attenuated by the same amount as
// the transient, even though nothing about the quiet passage asked to move).
//
// Instead the drawn dB is scaled by how loud THIS INSTANT is relative to the
// dynamic range the detected envelope covers across the whole buffer:
//
//   normalized(t) = (envDb(t) - envMinDb) / (envMaxDb - envMinDb)   ∈ [0, 1]
//   appliedDb(t)  = drawnDb(t) * normalized(t)
//
// A drawn dip therefore lands almost entirely on whatever the envelope says is
// loudest (normalized ≈ 1 — the transient itself) and almost not at all on
// material sitting near the envelope's own floor (normalized ≈ 0 — the
// microdynamics around it), even when the same dip is drawn wide enough to
// cover both. That is also the textbook definition of expansion vs.
// compression once phrased this way: scaling gain proportionally to level
// widens the gap between loud and quiet (positive drawn dB = expand) or
// narrows it (negative = compress) — and drawn 0 dB multiplies by anything and
// stays 0, so "preserve natural dynamics" falls out for free rather than
// needing its own case.
//
// A buffer whose envelope never moves (silence, or a dead-flat tone) has no
// range to normalize against; normalized(t) is defined as 1 in that case so a
// deliberately drawn curve still has SOME effect rather than silently doing
// nothing.
SandboxBuffer applyGainEnvelope(const SandboxBuffer& in, const GainEnvelopeParams& p,
                                double sampleRate) {
    SandboxBuffer dst(in);
    const int64_t len = dst.getNumSamples();
    if (len <= 0) return dst;

    // Normalize a LOCAL copy rather than trusting the caller. opFromJson
    // already normalizes on every ingest path the RPC surface can reach, but a
    // hand-built op (a test, a future in-engine caller) must not be able to
    // hand the evaluator an unsorted list and get a plausible-looking wrong
    // curve back.
    GainEnvelopeParams env = p;
    normalizeGainEnvelope(env);
    if (env.points.empty()) return dst;   // unity — nothing to do in either mode

    if (env.mode == SandboxGainEnvelopeMode::Absolute) {
        for (int ch = 0; ch < dst.getNumChannels(); ++ch) {
            float* d = dst.getWritePointer(ch);
            for (int64_t i = 0; i < len; ++i)
                d[i] *= static_cast<float>(gainEnvelopeAt(env, i));
        }
        return dst;
    }

    const std::vector<double> envDb =
        gainEnvelopeFollowerDb(in, sampleRate, env.followerAttackMs, env.followerReleaseMs);

    double minDb = envDb.empty() ? 0.0 : envDb.front();
    double maxDb = minDb;
    for (double v : envDb) { minDb = std::min(minDb, v); maxDb = std::max(maxDb, v); }
    const double rangeDb = maxDb - minDb;

    for (int ch = 0; ch < dst.getNumChannels(); ++ch) {
        float* d = dst.getWritePointer(ch);
        for (int64_t i = 0; i < len; ++i) {
            const double normalized = rangeDb > 1e-9 ? std::clamp((envDb[static_cast<size_t>(i)] - minDb) / rangeDb, 0.0, 1.0)
                                                      : 1.0;
            const double appliedDb = gainEnvelopeDbAt(env, i) * normalized;
            d[i] *= static_cast<float>(envDbToGain(appliedDb));
        }
    }
    return dst;
}

// `clipboard` is the resolved buffer for p.clipboardId, or nullptr — nullptr
// covers both clipboardId == -1 (explicit INSERT SILENCE) and a stale id that
// no longer resolves, deliberately the same code path. clipboardLengthSamples
// is authoritative for how much material to place regardless of what the
// resolved buffer's own length happens to be, so a mismatched or short
// clipboard buffer zero-pads rather than shrinking the edit.
SandboxBuffer applyPaste(const SandboxBuffer& in, const PasteParams& p, const SandboxBuffer* clipboard) {
    const int64_t len    = in.getNumSamples();
    const int64_t insLen = std::max<int64_t>(0, p.clipboardLengthSamples);
    const int64_t at     = std::clamp<int64_t>(p.atSample, 0, len);

    auto writeMaterial = [&](SandboxBuffer& dst, int64_t destStart, int64_t count) {
        if (count <= 0) return;
        if (clipboard != nullptr) {
            const int64_t copyLen = std::min<int64_t>(count, clipboard->getNumSamples());
            for (int ch = 0; ch < dst.getNumChannels(); ++ch) {
                // A mono clip broadcasts to every output channel; extra clip
                // channels beyond dst's are simply not read.
                const int srcCh = std::min(ch, clipboard->getNumChannels() - 1);
                if (copyLen > 0)
                    dst.copyFrom(ch, static_cast<int>(destStart), *clipboard, srcCh, 0,
                                 static_cast<int>(copyLen));
            }
        }
        // else: dst was already zero-initialized where it needs to be — see
        // call sites below — so "no clipboard" already reads as silence.
    };

    if (p.insert) {
        SandboxBuffer dst = makeBuffer(in.getNumChannels(), len + insLen);
        for (int ch = 0; ch < in.getNumChannels(); ++ch) {
            if (at > 0)
                dst.copyFrom(ch, 0, in, ch, 0, static_cast<int>(at));
            if (len - at > 0)
                dst.copyFrom(ch, static_cast<int>(at + insLen), in, ch,
                             static_cast<int>(at), static_cast<int>(len - at));
        }
        writeMaterial(dst, at, insLen);
        return dst;
    }

    // Overwrite: length unchanged, writes clamped to the buffer's own end.
    SandboxBuffer dst(in);
    const int64_t writable = std::clamp<int64_t>(insLen, 0, len - at);
    if (writable > 0)
        for (int ch = 0; ch < dst.getNumChannels(); ++ch)
            dst.clear(ch, static_cast<int>(at), static_cast<int>(writable));
    writeMaterial(dst, at, writable);
    return dst;
}

// Split at atSample and swap the two halves. Ripple abuts tail directly
// against head; Gap inserts gapSamples of silence at the new seam.
SandboxBuffer applySplice(const SandboxBuffer& in, const SpliceParams& p) {
    const int64_t len  = in.getNumSamples();
    const int64_t at   = std::clamp<int64_t>(p.atSample, 0, len);
    const int64_t head = at;
    const int64_t tail = len - at;
    const int64_t gap  = (p.mode == SandboxRippleMode::Gap) ? std::max<int64_t>(0, p.gapSamples) : 0;

    SandboxBuffer dst = makeBuffer(in.getNumChannels(), tail + gap + head);
    for (int ch = 0; ch < in.getNumChannels(); ++ch) {
        if (tail > 0)
            dst.copyFrom(ch, 0, in, ch, static_cast<int>(at), static_cast<int>(tail));
        if (head > 0)
            dst.copyFrom(ch, static_cast<int>(tail + gap), in, ch, 0, static_cast<int>(head));
    }
    return dst;
}

// Declicks a seam at atSample by dipping to (near) silence across the window
// and back — see the CrossfadeParams comment for why this is a self-declick
// rather than a two-signal crossfade. Symmetric: half the window fades OUT
// approaching atSample, half fades IN leaving it, so gain is exactly at its
// curve's zero right at the seam sample regardless of what discontinuity sits
// there.
SandboxBuffer applyCrossfade(const SandboxBuffer& in, const CrossfadeParams& p) {
    SandboxBuffer dst(in);
    const int64_t len = dst.getNumSamples();
    if (len <= 0 || p.lengthSamples <= 0) return dst;

    const int64_t at       = std::clamp<int64_t>(p.atSample, 0, len);
    const int64_t halfBefore = p.lengthSamples / 2;
    const int64_t halfAfter  = p.lengthSamples - halfBefore;

    const Range before = resolveRange(at - halfBefore, at, len);
    const Range after  = resolveRange(at, at + halfAfter, len);

    for (int ch = 0; ch < dst.getNumChannels(); ++ch) {
        float* d = dst.getWritePointer(ch);
        // Approaching the seam: 1 far away, 0 at the seam itself.
        for (int64_t i = before.start; i < before.end; ++i) {
            const double t = static_cast<double>(at - i) / static_cast<double>(std::max<int64_t>(1, halfBefore));
            d[i] *= fadeCurve(p.shape, t);
        }
        // Leaving the seam: 0 at the seam, 1 by the far edge of the window.
        for (int64_t i = after.start; i < after.end; ++i) {
            const double t = static_cast<double>(i - at) / static_cast<double>(std::max<int64_t>(1, halfAfter));
            d[i] *= fadeCurve(p.shape, t);
        }
    }
    return dst;
}

// ─── Restoration / pitch trio ─────────────────────────────────────────────────
// PITCH and FORMANT SHIFT both route through dsp::processRubberBand (RubberBand
// R3, offline) — see RubberBandWrapper.h. DECLIP and DENOISE are pure
// sample/spectral-domain reconstruction with no external DSP dependency; the
// project already links RubberBand (rubberband_static, engine/CMakeLists.txt)
// for the sampler's own pitch/stretch, and juce_dsp for the FFT
// XlethResonanceSuppressorEffect's WolaProcessor already uses, so neither op
// needed a new library.

// Varispeed (tape) PITCH — read the waveform faster/slower, so pitch and length
// move together. The output length is NOT computed here: it comes from the same
// SandboxOp::outputLength the UI and the cache already trust, so a predicted
// length can never disagree with a rendered one (see VarispeedResample.h).
SandboxBuffer applyPitchResample(const SandboxBuffer& in, const PitchParams& p) {
    const int64_t inLen = in.getNumSamples();
    const double  ratio = xleth::dsp::varispeedRatio(p.cents);
    const int64_t outLen = xleth::dsp::varispeedOutputLength(inLen, p.cents);
    if (inLen <= 0 || outLen <= 0) return in;

    SandboxBuffer dst(in.getNumChannels(), static_cast<int>(outLen));
    dst.clear();
    for (int ch = 0; ch < in.getNumChannels(); ++ch)
        xleth::dsp::resampleVarispeed(in.getReadPointer(ch), inLen,
                                      dst.getWritePointer(ch), outLen, ratio);
    return dst;
}

SandboxBuffer applyPitch(const SandboxBuffer& in, const PitchParams& p, double sampleRate) {
    if (in.getNumSamples() <= 0) return in;
    if (p.mode == SandboxPitchMode::Resample) return applyPitchResample(in, p);

    dsp::RubberBandParams rp;
    rp.sampleRate          = sampleRate;
    rp.pitchShiftSemitones = p.cents / 100.0;
    rp.stretchRatio        = 1.0;              // Preserve mode never changes length
    rp.formantPreserve     = p.formantPreserve; // the "formant lock" toggle
    return dsp::processRubberBand(in, rp);
}

// Pitch held at 1.0; only the formant envelope moves, via
// RubberBandParams::formantScaleOverride — see that field's comment for why
// this needs the override rather than the ordinary formantPreserve flag.
SandboxBuffer applyFormantShift(const SandboxBuffer& in, const FormantShiftParams& p, double sampleRate) {
    if (in.getNumSamples() <= 0) return in;
    dsp::RubberBandParams rp;
    rp.sampleRate            = sampleRate;
    rp.pitchShiftSemitones   = 0.0;
    rp.stretchRatio          = 1.0;
    rp.formantScaleOverride  = std::pow(2.0, p.cents / 1200.0);
    return dsp::processRubberBand(in, rp);
}

// DECLIP — cubic-Hermite reconstruction of runs pinned at/above `threshold`.
// See DeclipParams for the run-length escape hatch and why threshold is a
// fraction of full scale rather than a dBFS value (a clipped sample sits at a
// fixed CEILING, not a fixed level below it).
SandboxBuffer applyDeclip(const SandboxBuffer& in, const DeclipParams& p) {
    SandboxBuffer dst(in);
    const int64_t len = dst.getNumSamples();
    const Range   r   = resolveRange(p.startSample, p.endSample, len);
    if (r.end <= r.start) return dst;

    const float   thresh = static_cast<float>(std::clamp(p.threshold, 0.5, 1.0));
    const int64_t maxRun = std::max(1, p.maxRunSamples);

    for (int ch = 0; ch < dst.getNumChannels(); ++ch) {
        const float* src = in.getReadPointer(ch);
        float*       out = dst.getWritePointer(ch);

        int64_t i = r.start;
        while (i < r.end) {
            if (std::abs(src[i]) < thresh) { ++i; continue; }

            const int64_t runStart = i;
            while (i < r.end && std::abs(src[i]) >= thresh) ++i;
            const int64_t runEnd = i;                        // [runStart, runEnd)
            if (runEnd - runStart > maxRun) continue;         // too long to be a clip — leave it

            const bool haveLeft  = runStart - 1 >= 0;
            const bool haveRight = runEnd < len;
            if (!haveLeft && !haveRight) continue;            // the whole buffer is "clipped"

            if (!haveLeft) {
                // Run touches sample 0 — nothing to anchor the left side to.
                for (int64_t s = runStart; s < runEnd; ++s) out[s] = src[runEnd];
                continue;
            }
            if (!haveRight) {
                for (int64_t s = runStart; s < runEnd; ++s) out[s] = src[runStart - 1];
                continue;
            }

            // Both anchors exist: cubic Hermite between them, tangents from
            // one more sample past each anchor (0 if that sample doesn't
            // exist either — a flat approach rather than an invented slope).
            const float p0 = src[runStart - 1];
            const float p1 = src[runEnd];
            const float m0 = (runStart - 2 >= 0) ? (p0 - src[runStart - 2]) : 0.0f;
            const float m1 = (runEnd + 1 < len)  ? (src[runEnd + 1] - p1)   : 0.0f;

            const double span = static_cast<double>(runEnd - runStart + 1);
            for (int64_t s = runStart; s < runEnd; ++s) {
                const double t  = static_cast<double>(s - runStart + 1) / span;
                const double t2 = t * t, t3 = t2 * t;
                const double h00 =  2.0 * t3 - 3.0 * t2 + 1.0;
                const double h10 =        t3 - 2.0 * t2 + t;
                const double h01 = -2.0 * t3 + 3.0 * t2;
                const double h11 =        t3 -       t2;
                out[s] = static_cast<float>(h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1);
            }
        }
    }
    return dst;
}

// ─── Denoise ───────────────────────────────────────────────────────────────────
// Offline STFT spectral subtraction. sqrt-Hann analysis+synthesis window with
// a precomputed per-hop-phase sum-of-squares normalization — the exact scheme
// XlethResonanceSuppressorEffect::WolaProcessor::buildWindowAndNormalization
// uses, reused verbatim rather than re-derived because it is already proven
// correct in this codebase. Unlike that class this runs OFFLINE over a whole
// buffer already in hand, so there is no ring buffer or streaming latency —
// every frame that overlaps [0, len) is evaluated in one pass and
// accumulated into a buffer padded by one FFT size on each side, which is
// what lets a frame straddle sample 0 or the buffer end without a separate
// edge case: the padding reads as silence, and the window/normalization
// identity holds regardless of what the frame's data actually is.
namespace denoise {
    constexpr int kFftOrder = 11;
    constexpr int kFftSize  = 1 << kFftOrder;      // 2048
    constexpr int kHopSize  = kFftSize / 4;        // 512 — 4x overlap
    constexpr int kNumBins  = kFftSize / 2 + 1;

    // Bin 0 (DC) and bin kNumBins-1 (Nyquist) are packed specially by JUCE's
    // real-only FFT and are not safe to read/write as an ordinary complex
    // bin — XlethResonanceSuppressorEffect::updateDetector excludes the same
    // two indices for the same reason. Left untouched: two bins out of 1025
    // carrying no noise reduction is inaudible.
    constexpr int kFirstBin = 1;
    constexpr int kLastBin  = kNumBins - 2;

    struct Window {
        std::array<float, kFftSize> analysis{};
        std::array<float, kHopSize> normalization{};
        Window() {
            for (int n = 0; n < kFftSize; ++n) {
                const float hann = 0.5f - 0.5f * std::cos(2.0f * static_cast<float>(kPi) * n
                                                          / static_cast<float>(kFftSize));
                analysis[static_cast<size_t>(n)] = std::sqrt(std::max(hann, 0.0f));
            }
            for (int phase = 0; phase < kHopSize; ++phase) {
                float sum = 0.0f;
                for (int n = phase; n < kFftSize; n += kHopSize) {
                    const float w = analysis[static_cast<size_t>(n)];
                    sum += w * w;
                }
                normalization[static_cast<size_t>(phase)] = sum > 1.0e-8f ? (1.0f / sum) : 1.0f;
            }
        }
    };
}

SandboxBuffer applyDenoise(const SandboxBuffer& in, const DenoiseParams& p) {
    using namespace denoise;

    const int64_t len      = in.getNumSamples();
    const int     channels = in.getNumChannels();
    if (len <= 0 || channels <= 0) return in;
    if (p.noiseEndSample <= p.noiseStartSample) return in;   // no profile learned — pass-through

    const Range noiseR = resolveRange(p.noiseStartSample, p.noiseEndSample, len);
    if (noiseR.end - noiseR.start < kFftSize) return in;     // region too short to learn a profile

    static const Window W;
    juce::dsp::FFT fft(kFftOrder);

    const float floorGain = static_cast<float>(std::pow(10.0, -std::max(0.0, p.reductionDb) / 20.0));
    const float oversub   = static_cast<float>(std::max(0.0, p.sensitivity));

    SandboxBuffer dst = makeBuffer(channels, len);
    std::vector<float> fftBuf(static_cast<size_t>(kFftSize) * 2);
    std::vector<float> profile(static_cast<size_t>(kNumBins), 0.0f);

    for (int ch = 0; ch < channels; ++ch) {
        const float* src = in.getReadPointer(ch);
        const auto readPadded = [&](int64_t i) -> float {
            return (i >= 0 && i < len) ? src[i] : 0.0f;
        };

        // ── Learn the noise profile: average magnitude spectrum over the
        //    user-selected noise-only region ──
        std::fill(profile.begin(), profile.end(), 0.0f);
        int frames = 0;
        for (int64_t f = noiseR.start; f + kFftSize <= noiseR.end; f += kHopSize) {
            std::fill(fftBuf.begin(), fftBuf.end(), 0.0f);
            for (int n = 0; n < kFftSize; ++n)
                fftBuf[static_cast<size_t>(n)] = src[f + n] * W.analysis[static_cast<size_t>(n)];
            fft.performRealOnlyForwardTransform(fftBuf.data(), false);
            for (int b = kFirstBin; b <= kLastBin; ++b) {
                const float re = fftBuf[static_cast<size_t>(2 * b)];
                const float im = fftBuf[static_cast<size_t>(2 * b + 1)];
                profile[static_cast<size_t>(b)] += std::sqrt(re * re + im * im);
            }
            ++frames;
        }
        if (frames == 0) continue;
        for (auto& v : profile) v /= static_cast<float>(frames);

        // ── Spectrally subtract the profile from every frame across the
        //    WHOLE channel, floored so no bin drops past -reductionDb ──
        std::vector<float> accum(static_cast<size_t>(len) + static_cast<size_t>(2 * kFftSize), 0.0f);
        for (int64_t f = -(kFftSize - kHopSize); f < len; f += kHopSize) {
            std::fill(fftBuf.begin(), fftBuf.end(), 0.0f);
            for (int n = 0; n < kFftSize; ++n)
                fftBuf[static_cast<size_t>(n)] = readPadded(f + n) * W.analysis[static_cast<size_t>(n)];
            fft.performRealOnlyForwardTransform(fftBuf.data(), false);

            for (int b = kFirstBin; b <= kLastBin; ++b) {
                const size_t re_i = static_cast<size_t>(2 * b), im_i = re_i + 1;
                const float re = fftBuf[re_i], im = fftBuf[im_i];
                const float mag = std::sqrt(re * re + im * im);
                const float sub = std::max(mag - oversub * profile[static_cast<size_t>(b)], 0.0f);
                const float gain = std::max(mag > 1.0e-9f ? (sub / mag) : 1.0f, floorGain);
                fftBuf[re_i] = re * gain;
                fftBuf[im_i] = im * gain;
            }

            fft.performRealOnlyInverseTransform(fftBuf.data());
            for (int n = 0; n < kFftSize; ++n) {
                const float y = fftBuf[static_cast<size_t>(n)] * W.analysis[static_cast<size_t>(n)]
                              * W.normalization[static_cast<size_t>(n % kHopSize)];
                accum[static_cast<size_t>(f + n + kFftSize)] += y;
            }
        }

        float* out = dst.getWritePointer(ch);
        for (int64_t i = 0; i < len; ++i) out[i] = accum[static_cast<size_t>(i + kFftSize)];
    }
    return dst;
}

// ─── Spectral paint ─────────────────────────────────────────────────────────
// Offline STFT masking: the exact same sqrt-Hann WOLA scheme applyDenoise
// uses (see that function's comment for where the scheme itself comes from),
// with a per-frame, per-bin gain built from the painted dabs instead of a
// learned noise profile. Own local FFT size/hop rather than sharing Denoise's
// (or SandboxSpectrogramAnalyzer's) — see fadeCurve's comment at the top of
// this file on why formulas are re-derived locally rather than shared.
namespace spectralpaint {
    constexpr int kFftOrder = 11;
    constexpr int kFftSize  = 1 << kFftOrder;      // 2048
    constexpr int kHopSize  = kFftSize / 4;        // 512 — 4x overlap
    constexpr int kNumBins  = kFftSize / 2 + 1;
    constexpr int kFirstBin = 1;                    // DC excluded — see Denoise's comment
    constexpr int kLastBin  = kNumBins - 2;         // Nyquist excluded

    struct Window {
        std::array<float, kFftSize> analysis{};
        std::array<float, kHopSize> normalization{};
        Window() {
            for (int n = 0; n < kFftSize; ++n) {
                const float hann = 0.5f - 0.5f * std::cos(2.0f * static_cast<float>(kPi) * n
                                                          / static_cast<float>(kFftSize));
                analysis[static_cast<size_t>(n)] = std::sqrt(std::max(hann, 0.0f));
            }
            for (int phase = 0; phase < kHopSize; ++phase) {
                float sum = 0.0f;
                for (int n = phase; n < kFftSize; n += kHopSize) {
                    const float w = analysis[static_cast<size_t>(n)];
                    sum += w * w;
                }
                normalization[static_cast<size_t>(phase)] = sum > 1.0e-8f ? (1.0f / sum) : 1.0f;
            }
        }
    };

    // Raised-cosine falloff: 1.0 inside the core half-extent, eases to 0.0
    // across `feather` past it, 0.0 beyond that. `feather <= 0` is a hard
    // edge (feather has already been floored to >= 0 by the caller, so this
    // only ever sees the "no feather authored" case, not a negative one).
    inline float falloff(double dist, double half, double feather) noexcept {
        if (dist <= half) return 1.0f;
        if (feather <= 0.0 || dist >= half + feather) return dist <= half ? 1.0f : 0.0f;
        const double t = (dist - half) / feather;
        return static_cast<float>(0.5 + 0.5 * std::cos(t * kPi));
    }
}

// Empty `dabs` is a GATE, checked before any FFT machinery runs: it must be a
// bit-transparent pass-through, not merely an inaudible one — a WOLA
// round-trip is only IDENTITY up to floating-point rounding, and "no paint
// yet" must never cost so much as an ULP. Every dab past this point is
// assumed to have gone through the same clamps this function applies
// (amountDb floored, feather floored to >= 0) since SandboxOp.h's JSON
// ingest does not clamp them itself — see SpectralPaintDab's own comment.
SandboxBuffer applySpectralPaint(const SandboxBuffer& in, const SpectralPaintParams& p,
                                 double bufferSampleRate) {
    using namespace spectralpaint;

    if (p.dabs.empty()) return in;

    const int64_t len      = in.getNumSamples();
    const int     channels = in.getNumChannels();
    if (len <= 0 || channels <= 0 || bufferSampleRate <= 0.0) return in;

    static const Window W;
    juce::dsp::FFT fft(kFftOrder);
    const double binHz = bufferSampleRate / static_cast<double>(kFftSize);

    // Per-dab derived bounds, computed once rather than per frame/bin.
    struct Dab {
        int64_t centerSample, timeExtentSamples;
        double  centerFreqHz, freqExtentHz;
        double  halfWidthSamples, featherSamples;
        double  halfHeightHz, featherFreqHz;
        double  amountDb;
    };
    std::vector<Dab> dabs;
    dabs.reserve(p.dabs.size());
    for (const auto& d : p.dabs) {
        Dab e;
        e.centerSample       = d.centerSample;
        e.halfWidthSamples   = static_cast<double>(std::max<int64_t>(0, d.halfWidthSamples));
        e.featherSamples     = std::max(0.0, d.featherTimeMs) * 0.001 * bufferSampleRate;
        e.timeExtentSamples  = static_cast<int64_t>(std::ceil(e.halfWidthSamples + e.featherSamples));
        e.centerFreqHz       = d.centerFreqHz;
        e.halfHeightHz       = std::max(0.0, d.halfHeightHz);
        e.featherFreqHz      = std::max(0.0, d.featherFreqHz);
        e.freqExtentHz       = e.halfHeightHz + e.featherFreqHz;
        e.amountDb           = std::max(kSpectralPaintMinAmountDb, std::min(kSpectralPaintMaxAmountDb, d.amountDb));
        dabs.push_back(e);
    }

    SandboxBuffer dst = makeBuffer(channels, len);
    std::vector<float> fftBuf(static_cast<size_t>(kFftSize) * 2);
    std::vector<float> gainDb(static_cast<size_t>(kNumBins));

    for (int ch = 0; ch < channels; ++ch) {
        const float* src = in.getReadPointer(ch);
        const auto readPadded = [&](int64_t i) -> float {
            return (i >= 0 && i < len) ? src[i] : 0.0f;
        };

        std::vector<float> accum(static_cast<size_t>(len) + static_cast<size_t>(2 * kFftSize), 0.0f);
        for (int64_t f = -(kFftSize - kHopSize); f < len; f += kHopSize) {
            const int64_t frameCenter = f + kFftSize / 2;

            std::fill(gainDb.begin(), gainDb.end(), 0.0f);
            for (const auto& d : dabs) {
                const double dt = std::abs(static_cast<double>(frameCenter - d.centerSample));
                if (dt > d.halfWidthSamples + d.featherSamples) continue;
                const float timeWeight = falloff(dt, d.halfWidthSamples, d.featherSamples);
                if (timeWeight <= 0.0f) continue;

                const double loFreq = std::max(0.0, d.centerFreqHz - d.freqExtentHz);
                const double hiFreq = d.centerFreqHz + d.freqExtentHz;
                const int loBin = std::clamp(static_cast<int>(std::floor(loFreq / binHz)), kFirstBin, kLastBin);
                const int hiBin = std::clamp(static_cast<int>(std::ceil(hiFreq / binHz)),  kFirstBin, kLastBin);
                for (int b = loBin; b <= hiBin; ++b) {
                    const double df = std::abs(b * binHz - d.centerFreqHz);
                    const float freqWeight = falloff(df, d.halfHeightHz, d.featherFreqHz);
                    if (freqWeight <= 0.0f) continue;
                    gainDb[static_cast<size_t>(b)] += timeWeight * freqWeight * static_cast<float>(d.amountDb);
                }
            }

            std::fill(fftBuf.begin(), fftBuf.end(), 0.0f);
            for (int n = 0; n < kFftSize; ++n)
                fftBuf[static_cast<size_t>(n)] = readPadded(f + n) * W.analysis[static_cast<size_t>(n)];
            fft.performRealOnlyForwardTransform(fftBuf.data(), false);

            for (int b = kFirstBin; b <= kLastBin; ++b) {
                const size_t re_i = static_cast<size_t>(2 * b), im_i = re_i + 1;
                const float totalDb = std::clamp(gainDb[static_cast<size_t>(b)],
                                                 static_cast<float>(kSpectralPaintFloorDb),
                                                 static_cast<float>(kSpectralPaintCeilDb));
                if (totalDb == 0.0f) continue;   // no dab touches this bin this frame — leave it untouched
                const float gain = static_cast<float>(std::pow(10.0, totalDb / 20.0));
                fftBuf[re_i] *= gain;
                fftBuf[im_i] *= gain;
            }

            fft.performRealOnlyInverseTransform(fftBuf.data());
            for (int n = 0; n < kFftSize; ++n) {
                const float y = fftBuf[static_cast<size_t>(n)] * W.analysis[static_cast<size_t>(n)]
                              * W.normalization[static_cast<size_t>(n % kHopSize)];
                accum[static_cast<size_t>(f + n + kFftSize)] += y;
            }
        }

        float* out = dst.getWritePointer(ch);
        for (int64_t i = 0; i < len; ++i) out[i] = accum[static_cast<size_t>(i + kFftSize)];
    }
    return dst;
}

// Constant-power pan, mirroring TrackMixer::applyPan's formula/convention
// (engine/src/audio/TrackMixer.h) so a layer panned in the Sandbox sits at the
// same apparent level as a track panned the same way on the main mixer. Kept
// as a local formula rather than a link against the audio target, same reason
// fadeCurve() above re-derives DeclickEnvelope's Hann curve instead of linking
// against it.
void panGains(double pan, float& gainL, float& gainR) noexcept {
    const double angle = (std::clamp(pan, -1.0, 1.0) + 1.0) * (kPi * 0.25);
    gainL = static_cast<float>(std::cos(angle));
    gainR = static_cast<float>(std::sin(angle));
}

// Resamples `src` to `dstRate` with juce::LagrangeInterpolator, per channel —
// the same approach SampleBank::loadSample uses to bring a source to the
// engine rate. A cheap copy when the rates already agree (within 0.5 Hz, the
// same tolerance SampleBank uses).
// ─── Autotune (P5-3) ──────────────────────────────────────────────────────────

// Mono-sum + NSDF pitch track for one buffer. The same mono convention
// SandboxPitchTrackAnalyzer and SandboxSpectrogramAnalyzer both use (a plain
// channel average): AUTOTUNE tracks ONE pitch curve per buffer, and a stereo
// take's two sides are the same performance.
xleth::dsp::PitchTrackResult analyzeBufferPitch(const SandboxBuffer& in, double sampleRate) {
    const int N = in.getNumSamples();
    const int C = in.getNumChannels();
    if (N <= 0 || C <= 0 || !(sampleRate > 0.0)) return {};

    std::vector<float> mono(static_cast<size_t>(N), 0.0f);
    const float scale = 1.0f / static_cast<float>(C);
    for (int ch = 0; ch < C; ++ch) {
        const float* src = in.getReadPointer(ch);
        for (int i = 0; i < N; ++i) mono[static_cast<size_t>(i)] += src[i] * scale;
    }
    return xleth::dsp::analyzePitchTrack(mono.data(), N, sampleRate);
}

// AUTOTUNE — detection (PitchTrackAnalysis) → target curve (CorrectionCurve) →
// TD-PSOLA resynthesis (AutotuneRender). This function owns none of that math.
// It resolves the analysis, hands the three pieces to each other in order, and
// turns a refusal into a pass-through plus a reason.
//
// `provided` is the renderer's cached analysis of THIS op's input (see
// SandboxRenderer::analyzeFor). It is re-derived here when absent — or when it
// describes a different sample rate than the one we were handed, which would
// silently mis-scale every period in the render.
SandboxBuffer applyAutotune(const SandboxBuffer& in,
                            const AutotuneParams& p,
                            double sampleRate,
                            const xleth::dsp::PitchTrackResult* provided,
                            std::string* refusalOut) {
    if (in.getNumSamples() <= 0 || !(sampleRate > 0.0)) return in;

    xleth::dsp::PitchTrackResult local;
    const xleth::dsp::PitchTrackResult* track = provided;
    if (track == nullptr || !track->valid()
        || std::abs(track->sampleRate - sampleRate) > 1e-6) {
        local = analyzeBufferPitch(in, sampleRate);
        track = &local;
    }

    if (!track->valid()) {
        if (refusalOut) *refusalOut = "pitch analysis unavailable for this material";
        return in;
    }
    // The monophonic gate, checked BEFORE the correctionAmount == 0 early-out
    // below: whether AUTOTUNE can work on this material does not depend on how
    // far the user has pushed the amount knob, and a refusal badge that
    // appeared and vanished as the knob passed zero would read as a bug.
    if (!track->monophonic) {
        if (refusalOut)
            *refusalOut = track->reason.empty()
                ? std::string("content is not monophonic -- AUTOTUNE needs a single pitched voice")
                : track->reason;
        return in;
    }

    // 0% is an exact bypass. CorrectionCurve already makes the TARGET equal the
    // input at 0, but a unity-ratio PSOLA pass is only ALMOST an identity —
    // returning the input itself is both free and exactly right.
    if (p.correction.correctionAmount <= 0.0) return in;

    // MANUAL and SCALE are two sources of the same CorrectionCurveResult —
    // renderAutotune below never knows which mode produced the curve it
    // consumes (see AutotuneMode's comment in SandboxOp.h).
    const xleth::dsp::CorrectionCurveResult curve =
        (p.mode == AutotuneMode::Manual)
            ? xleth::dsp::computeManualCorrectionCurve(
                  track->frames, sampleRate, p.manualPoints, p.correction)
            : xleth::dsp::computeCorrectionCurve(
                  track->frames, track->notes, sampleRate,
                  p.scale, p.key, p.allowedNotes, p.correction);

    xleth::dsp::AutotuneRenderResult rendered =
        xleth::dsp::renderAutotune(in, sampleRate, *track, curve);
    if (!rendered.ok) {
        if (refusalOut) *refusalOut = rendered.reason;
        return in;
    }
    return std::move(rendered.buffer);
}

SandboxBuffer resampleTo(const SandboxBuffer& src, double srcRate, double dstRate) {
    if (srcRate <= 0.0 || dstRate <= 0.0 || std::abs(srcRate - dstRate) <= 0.5)
        return SandboxBuffer(src);

    const double speedRatio = srcRate / dstRate;
    const int    srcSamples = src.getNumSamples();
    const int    outSamples = static_cast<int>(std::ceil(static_cast<double>(srcSamples) / speedRatio));

    SandboxBuffer dst(src.getNumChannels(), std::max(0, outSamples));
    for (int ch = 0; ch < src.getNumChannels(); ++ch) {
        juce::LagrangeInterpolator interp;
        interp.reset();
        interp.process(speedRatio, src.getReadPointer(ch), dst.getWritePointer(ch),
                       outSamples, srcSamples, 0);
    }
    return dst;
}

} // namespace

// ─── SandboxRenderKey ─────────────────────────────────────────────────────────

uint64_t SandboxRenderKey::digest() const noexcept {
    uint64_t h = hashU64(kFnvOffset, static_cast<uint64_t>(static_cast<uint32_t>(sourceBufferId)));
    h = hashU64(h, opStackHash);
    h = hashU64(h, static_cast<uint64_t>(static_cast<uint32_t>(opCount)));
    h = hashU64(h, static_cast<uint64_t>(static_cast<uint32_t>(sampleRateHz)));
    return h;
}

// ─── SandboxRenderJob ─────────────────────────────────────────────────────────

class SandboxRenderJob : public juce::ThreadPoolJob {
public:
    SandboxRenderJob(SandboxRenderer& owner,
                     int layerId,
                     int sourceBufferId,
                     const SandboxBuffer& source,
                     std::vector<SandboxOp> ops,
                     double bufferSampleRate)
        : juce::ThreadPoolJob("SandboxRender"),
          owner_(owner),
          layerId_(layerId),
          sourceBufferId_(sourceBufferId),
          source_(source),                    // copied here — caller may pass a temporary
          ops_(std::move(ops)),
          rate_(bufferSampleRate) {}

    JobStatus runJob() override {
        const SandboxRenderResult res =
            owner_.renderStack(sourceBufferId_, source_, ops_, rate_);
        // Record the refusal BEFORE publishing: a caller woken by the new
        // buffer must find the explanation already in place, not race it.
        owner_.recordRefusal(layerId_, res.refusedOps, res.refusalReason);
        if (res.valid()) owner_.publish(layerId_, res.buffer);
        owner_.finishJob(layerId_);
        return jobHasFinished;
    }

private:
    SandboxRenderer&       owner_;
    int                    layerId_;
    int                    sourceBufferId_;
    SandboxBuffer          source_;
    std::vector<SandboxOp> ops_;
    double                 rate_;
};

// ─── SandboxRenderer ──────────────────────────────────────────────────────────

SandboxRenderer::SandboxRenderer(size_t maxBytes)
    // kThreads (2) on small machines; up to 4 workers from 12 logical cores
    // (HardwareTier::backgroundWorkers — never more than a quarter of the CPU).
    : pool_(std::make_unique<juce::ThreadPool>(xleth::hw::backgroundWorkers(kThreads, 4))),
      maxBytes_(maxBytes) {}

SandboxRenderer::~SandboxRenderer() {
    if (pool_) pool_->removeAllJobs(true, 5000);
    pool_.reset();
}

// ─── Op evaluation ────────────────────────────────────────────────────────────

SandboxBuffer SandboxRenderer::applyOp(const SandboxBuffer& in,
                                       const SandboxOp& op,
                                       double bufferSampleRate,
                                       const SandboxBuffer* clipboard,
                                       const xleth::dsp::PitchTrackResult* pitchTrack,
                                       std::string* refusalOut) {
    // A bypassed, malformed or not-yet-built op is a PASS-THROUGH. Never a
    // partial edit: "half applied" is indistinguishable from a DSP bug at the
    // waveform, and the result carries unimplementedOps so the UI can say why.
    if (!op.enabled || !op.consistent() || !op.implemented()) return in;

    switch (op.type) {
        case SandboxOpType::Trim:      return applyTrim(in, std::get<TrimParams>(op.params));
        case SandboxOpType::Cut:       return applyCut(in, std::get<CutParams>(op.params));
        case SandboxOpType::Paste:     return applyPaste(in, std::get<PasteParams>(op.params), clipboard);
        case SandboxOpType::Splice:    return applySplice(in, std::get<SpliceParams>(op.params));
        case SandboxOpType::Reverse:   return applyReverse(in, std::get<ReverseParams>(op.params));
        case SandboxOpType::Fade:      return applyFade(in, std::get<FadeParams>(op.params));
        case SandboxOpType::Gain:      return applyGain(in, std::get<GainParams>(op.params));
        case SandboxOpType::Crossfade: return applyCrossfade(in, std::get<CrossfadeParams>(op.params));
        case SandboxOpType::GainEnvelope:
            return applyGainEnvelope(in, std::get<GainEnvelopeParams>(op.params), bufferSampleRate);
        case SandboxOpType::Pitch:
            return applyPitch(in, std::get<PitchParams>(op.params), bufferSampleRate);
        case SandboxOpType::FormantShift:
            return applyFormantShift(in, std::get<FormantShiftParams>(op.params), bufferSampleRate);
        case SandboxOpType::Declip:
            return applyDeclip(in, std::get<DeclipParams>(op.params));
        case SandboxOpType::Denoise:
            return applyDenoise(in, std::get<DenoiseParams>(op.params));
        case SandboxOpType::SpectralPaint:
            return applySpectralPaint(in, std::get<SpectralPaintParams>(op.params), bufferSampleRate);
        case SandboxOpType::Autotune:
            return applyAutotune(in, std::get<AutotuneParams>(op.params), bufferSampleRate,
                                 pitchTrack, refusalOut);

        // Guarded by implemented() above — listed so a newly built op that
        // forgets its case here is a compiler warning, not a silent no-op.
        case SandboxOpType::Stretch:
            return in;
    }
    return in;
}

// ─── renderComposite — mix N layers by their mix params ──────────────────────

SandboxCompositeResult SandboxRenderer::renderComposite(const std::vector<SandboxLayerMixInput>& layers) {
    SandboxCompositeResult result;
    if (layers.empty()) return result;

    // Highest rate present wins, so mixing never throws away resolution —
    // every OTHER layer is upsampled to meet it, never the reverse.
    double compositeRate = 0.0;
    for (const auto& l : layers)
        if (l.buffer && l.buffer->getNumSamples() > 0 && l.bufferSampleRate > 0.0)
            compositeRate = std::max(compositeRate, l.bufferSampleRate);
    if (compositeRate <= 0.0) return result;   // nothing with real audio to mix

    const bool anySoloed = std::any_of(layers.begin(), layers.end(),
                                       [](const SandboxLayerMixInput& l) { return l.soloed; });

    // Pass 1: span. Every layer with real audio contributes to the composite's
    // LENGTH regardless of mute, so silencing a layer never shrinks the
    // timeline out from under the others.
    int64_t compositeLen = 0;
    for (const auto& l : layers) {
        if (!l.buffer || l.buffer->getNumSamples() <= 0 || l.bufferSampleRate <= 0.0) continue;
        const int64_t startAt     = std::max<int64_t>(0, l.offsetSamples);
        const double  rateRatio   = compositeRate / l.bufferSampleRate;
        const int64_t placedLen   = static_cast<int64_t>(std::llround(l.buffer->getNumSamples() * rateRatio));
        const int64_t placedStart = static_cast<int64_t>(std::llround(static_cast<double>(startAt) * rateRatio));
        compositeLen = std::max(compositeLen, placedStart + placedLen);
    }
    if (compositeLen <= 0) return result;

    SandboxBuffer out(2, static_cast<int>(compositeLen));
    out.clear();

    // Pass 2: sum the AUDIBLE layers. Mute always wins over solo for that one
    // layer; otherwise, if anyone is soloed, only soloed layers sound.
    for (const auto& l : layers) {
        if (!l.buffer || l.buffer->getNumSamples() <= 0 || l.bufferSampleRate <= 0.0) continue;
        if (l.muted || (anySoloed && !l.soloed)) continue;

        const SandboxBuffer resampled = resampleTo(*l.buffer, l.bufferSampleRate, compositeRate);
        const int srcLen = resampled.getNumSamples();
        if (srcLen <= 0) continue;

        const int64_t startAt     = std::max<int64_t>(0, l.offsetSamples);
        const double  rateRatio   = compositeRate / l.bufferSampleRate;
        const int64_t placedStart = static_cast<int64_t>(std::llround(static_cast<double>(startAt) * rateRatio));

        const float gain = dbToGain(l.gainDb);
        float gainL = 1.0f, gainR = 1.0f;
        panGains(l.pan, gainL, gainR);

        // A mono layer broadcasts to both output channels before panning —
        // same idiom applyPaste uses for a mono clip against a stereo dest.
        const int srcChannels = resampled.getNumChannels();
        const float* srcL = resampled.getReadPointer(0);
        const float* srcR = resampled.getReadPointer(srcChannels > 1 ? 1 : 0);

        float* outL = out.getWritePointer(0);
        float* outR = out.getWritePointer(1);

        const int64_t writable = std::min<int64_t>(srcLen, compositeLen - placedStart);
        for (int64_t i = 0; i < writable; ++i) {
            const int64_t o = placedStart + i;
            outL[o] += srcL[static_cast<int>(i)] * gain * gainL;
            outR[o] += srcR[static_cast<int>(i)] * gain * gainR;
        }
        ++result.layersMixed;
    }

    result.buffer     = std::make_shared<const SandboxBuffer>(std::move(out));
    result.sampleRate = compositeRate;
    return result;
}

// ─── Spectral extraction (SPC selection "Copy to New Layer") ─────────────────
//
// The complement of applySpectralPaint: instead of ATTENUATING what falls
// inside the dabs, this KEEPS only what falls inside them and silences
// everything else. Reuses the exact same STFT scaffold (spectralpaint::Window
// / falloff, same 2048/512 WOLA) so an extracted region and "everything but
// that region attenuated to nothing" describe the same mask — the two
// operations should sound identical at a dab's feathered edge.
//
// Coverage from overlapping dabs takes the MAX, not the SUM SPECTRAL_PAINT
// uses: this is "kept if inside ANY dab", not "attenuated by every dab that
// touches it". amountDb is not consulted at all — keep/silence has no notion
// of "how much", only "which dabs' time/frequency footprint (with feather)
// this bin falls within". DC and Nyquist (kFirstBin/kLastBin's own excluded
// pair) are left untouched, same as Denoise/SpectralPaint's own comment on
// those two bins — inaudible either way.
//
// Empty `keepDabs` is NOT a pass-through gate the way SPECTRAL_PAINT's own
// empty-dabs case is — nothing selected means nothing kept, i.e. silence.
// There is no "select nothing" gesture this needs to survive bit-exactly, so
// it short-circuits straight to a zeroed buffer rather than running the STFT
// round-trip for a result that would come out silent anyway.
//
// Pure/static/no-cache — exposed on SandboxRenderer for testing exactly like
// applyOp/renderComposite. Never touches SandboxCore or SampleBank; the RPC
// layer registers the result as a new asset.
SandboxBuffer SandboxRenderer::extractSelection(const SandboxBuffer& in,
                                                const std::vector<SpectralPaintDab>& keepDabs,
                                                double bufferSampleRate) {
    using namespace spectralpaint;

    const int64_t len      = in.getNumSamples();
    const int     channels = in.getNumChannels();
    if (len <= 0 || channels <= 0 || bufferSampleRate <= 0.0)
        return makeBuffer(channels, len);
    if (keepDabs.empty()) return makeBuffer(channels, len);

    static const Window W;
    juce::dsp::FFT fft(kFftOrder);
    const double binHz = bufferSampleRate / static_cast<double>(kFftSize);

    struct Dab {
        int64_t centerSample;
        double  halfWidthSamples, featherSamples;
        double  centerFreqHz, halfHeightHz, featherFreqHz;
    };
    std::vector<Dab> dabs;
    dabs.reserve(keepDabs.size());
    for (const auto& d : keepDabs) {
        Dab e;
        e.centerSample     = d.centerSample;
        e.halfWidthSamples = static_cast<double>(std::max<int64_t>(0, d.halfWidthSamples));
        e.featherSamples   = std::max(0.0, d.featherTimeMs) * 0.001 * bufferSampleRate;
        e.centerFreqHz     = d.centerFreqHz;
        e.halfHeightHz     = std::max(0.0, d.halfHeightHz);
        e.featherFreqHz    = std::max(0.0, d.featherFreqHz);
        dabs.push_back(e);
    }

    SandboxBuffer dst = makeBuffer(channels, len);
    std::vector<float> fftBuf(static_cast<size_t>(kFftSize) * 2);
    std::vector<float> gain(static_cast<size_t>(kNumBins));

    for (int ch = 0; ch < channels; ++ch) {
        const float* src = in.getReadPointer(ch);
        const auto readPadded = [&](int64_t i) -> float {
            return (i >= 0 && i < len) ? src[i] : 0.0f;
        };

        std::vector<float> accum(static_cast<size_t>(len) + static_cast<size_t>(2 * kFftSize), 0.0f);
        for (int64_t f = -(kFftSize - kHopSize); f < len; f += kHopSize) {
            const int64_t frameCenter = f + kFftSize / 2;

            std::fill(gain.begin(), gain.end(), 0.0f);
            for (const auto& d : dabs) {
                const double dt = std::abs(static_cast<double>(frameCenter - d.centerSample));
                if (dt > d.halfWidthSamples + d.featherSamples) continue;
                const float timeWeight = falloff(dt, d.halfWidthSamples, d.featherSamples);
                if (timeWeight <= 0.0f) continue;

                const double loFreq = std::max(0.0, d.centerFreqHz - (d.halfHeightHz + d.featherFreqHz));
                const double hiFreq = d.centerFreqHz + d.halfHeightHz + d.featherFreqHz;
                const int loBin = std::clamp(static_cast<int>(std::floor(loFreq / binHz)), kFirstBin, kLastBin);
                const int hiBin = std::clamp(static_cast<int>(std::ceil(hiFreq / binHz)),  kFirstBin, kLastBin);
                for (int b = loBin; b <= hiBin; ++b) {
                    const double df = std::abs(b * binHz - d.centerFreqHz);
                    const float freqWeight = falloff(df, d.halfHeightHz, d.featherFreqHz);
                    if (freqWeight <= 0.0f) continue;
                    const float coverage = timeWeight * freqWeight;
                    if (coverage > gain[static_cast<size_t>(b)]) gain[static_cast<size_t>(b)] = coverage;
                }
            }

            std::fill(fftBuf.begin(), fftBuf.end(), 0.0f);
            for (int n = 0; n < kFftSize; ++n)
                fftBuf[static_cast<size_t>(n)] = readPadded(f + n) * W.analysis[static_cast<size_t>(n)];
            fft.performRealOnlyForwardTransform(fftBuf.data(), false);

            for (int b = kFirstBin; b <= kLastBin; ++b) {
                const size_t re_i = static_cast<size_t>(2 * b), im_i = re_i + 1;
                const float g = gain[static_cast<size_t>(b)];
                fftBuf[re_i] *= g;
                fftBuf[im_i] *= g;
            }

            fft.performRealOnlyInverseTransform(fftBuf.data());
            for (int n = 0; n < kFftSize; ++n) {
                const float y = fftBuf[static_cast<size_t>(n)] * W.analysis[static_cast<size_t>(n)]
                              * W.normalization[static_cast<size_t>(n % kHopSize)];
                accum[static_cast<size_t>(f + n + kFftSize)] += y;
            }
        }

        float* out = dst.getWritePointer(ch);
        for (int64_t i = 0; i < len; ++i) out[i] = accum[static_cast<size_t>(i + kFftSize)];
    }

    return dst;
}

// ─── renderStack — the prefix walk ────────────────────────────────────────────

SandboxRenderResult SandboxRenderer::renderStack(int sourceBufferId,
                                                 const SandboxBuffer& source,
                                                 const std::vector<SandboxOp>& ops,
                                                 double bufferSampleRate) {
    SandboxRenderResult result;

    // Never guess a rate. A stack whose indices were authored against an unknown
    // domain is not renderable, and rendering it at an assumed 44100 would be
    // wrong in a way nobody notices until the pitch is off.
    if (bufferSampleRate <= 0.0)  return result;
    if (source.getNumSamples() <= 0 || source.getNumChannels() <= 0) return result;

    const int rateHz  = static_cast<int>(std::lround(bufferSampleRate));
    const int opCount = static_cast<int>(ops.size());

    auto keyAt = [&](int count) {
        return SandboxRenderKey{ sourceBufferId,
                                 prefixHash(ops, static_cast<size_t>(count)),
                                 count, rateHz };
    };

    // Walk DOWN from the full stack for the deepest prefix already rendered.
    // Editing op k left prefixes 0..k untouched, so this lands on k and the loop
    // below runs ops k.. — the downstream-only re-render, for free.
    SandboxBufferPtr resume;
    int              resumeAt = 0;
    for (int i = opCount; i >= 1; --i) {
        if (auto hit = lookupKey(keyAt(i))) { resume = std::move(hit); resumeAt = i; break; }
    }

    result.resumedAtOp = resumeAt;
    renderCount_.fetch_add(1, std::memory_order_relaxed);

    if (resumeAt == opCount && resume != nullptr) {
        // Whole stack already cached — no DSP at all.
        result.buffer      = std::move(resume);
        result.fullyCached = true;
        cacheHitCount_.fetch_add(1, std::memory_order_relaxed);
        for (int i = 0; i < opCount; ++i) {
            const SandboxOp& op = ops[static_cast<size_t>(i)];
            if (!op.enabled) continue;
            if (!op.implemented()) { ++result.unimplementedOps; continue; }
            // A refusal is a property of the op's INPUT, not of the render that
            // did or did not just run — so it is still knowable with nothing to
            // re-render. Probe the analysis cache at this op's input prefix
            // rather than letting the message disappear on the second look at
            // the same stack. A probe miss (evicted) just means no message.
            if (op.type == SandboxOpType::Autotune && op.consistent()) {
                if (auto pt = lookupPitch(keyAt(i)); pt && !pt->monophonic) {
                    ++result.refusedOps;
                    if (result.refusalReason.empty()) result.refusalReason = pt->reason;
                }
            }
        }
        return result;
    }

    if (resume != nullptr) cacheHitCount_.fetch_add(1, std::memory_order_relaxed);

    // Seed: the cached prefix, or a copy of the raw source.
    SandboxBuffer cur = (resume != nullptr) ? SandboxBuffer(*resume) : SandboxBuffer(source);

    for (int i = resumeAt; i < opCount; ++i) {
        const SandboxOp& op = ops[static_cast<size_t>(i)];
        if (op.enabled && !op.implemented()) ++result.unimplementedOps;

        SandboxBufferPtr clip;
        const SandboxBuffer* clipPtr = nullptr;
        if (op.type == SandboxOpType::Paste && op.enabled && op.consistent()) {
            clip = clipboardBuffer(std::get<PasteParams>(op.params).clipboardId);
            clipPtr = clip.get();
        }

        // AUTOTUNE's detection pass, resolved against the identity of what this
        // op is about to RECEIVE (keyAt(i) — the prefix state above it). Held
        // for the duration of the applyOp call, exactly like `clip` above.
        PitchTrackPtr pitch;
        if (op.type == SandboxOpType::Autotune && op.enabled && op.consistent())
            pitch = analyzeFor(keyAt(i), cur, bufferSampleRate);

        std::string refusal;
        cur = applyOp(cur, op, bufferSampleRate, clipPtr, pitch.get(), &refusal);
        if (!refusal.empty()) {
            ++result.refusedOps;
            if (result.refusalReason.empty()) result.refusalReason = refusal;
        }
        ++result.opsEvaluated;
        opEvalCount_.fetch_add(1, std::memory_order_relaxed);

        // Cache every intermediate state, not just the final one. That is what
        // makes the NEXT edit cheap regardless of which op it lands on.
        insert(keyAt(i + 1), std::make_shared<const SandboxBuffer>(cur));
    }

    if (opCount == 0) {
        // An empty stack still has an identity worth caching: the source itself.
        auto buf = std::make_shared<const SandboxBuffer>(std::move(cur));
        insert(keyAt(0), buf);
        result.buffer = std::move(buf);
        return result;
    }

    result.buffer = lookupKey(keyAt(opCount));
    if (result.buffer == nullptr)   // evicted between insert and read — rare, not fatal
        result.buffer = std::make_shared<const SandboxBuffer>(std::move(cur));
    return result;
}

// ─── AUTOTUNE detection cache ─────────────────────────────────────────────────
// Keyed by the render key of the audio being analyzed — see the declaration in
// SandboxRenderer.h for why that, and not sourceBufferId, is the correct key.

SandboxRenderer::PitchTrackPtr SandboxRenderer::lookupPitch(const SandboxRenderKey& key) {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = pitchCache_.find(key);
    if (it == pitchCache_.end()) return nullptr;
    pitchLru_.remove(key);
    pitchLru_.push_front(key);
    return it->second;
}

SandboxRenderer::PitchTrackPtr SandboxRenderer::analyzeFor(const SandboxRenderKey& key,
                                                           const SandboxBuffer& in,
                                                           double bufferSampleRate) {
    if (auto hit = lookupPitch(key)) return hit;

    // Computed with the lock RELEASED. An NSDF pass over a whole buffer is
    // hundreds of milliseconds; holding mu_ for it would stall the other pool
    // thread, every main-thread lookup() and the clipboard alike.
    auto track = std::make_shared<const xleth::dsp::PitchTrackResult>(
        analyzeBufferPitch(in, bufferSampleRate));
    if (!track->valid()) return nullptr;

    std::lock_guard<std::mutex> lock(mu_);
    auto it = pitchCache_.find(key);
    if (it != pitchCache_.end()) {
        // Lost a race with the other worker on the same prefix — keep what is
        // already cached rather than double-inserting, same as
        // SandboxPitchTrackAnalyzer::analyze.
        pitchLru_.remove(key);
        pitchLru_.push_front(key);
        return it->second;
    }
    pitchCache_[key] = track;
    pitchLru_.push_front(key);
    while (pitchCache_.size() > kMaxPitchEntries) {
        pitchCache_.erase(pitchLru_.back());
        pitchLru_.pop_back();
    }
    return track;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

SandboxBufferPtr SandboxRenderer::lookupKey(const SandboxRenderKey& key) {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = map_.find(key);
    if (it == map_.end()) return nullptr;
    lruOrder_.splice(lruOrder_.begin(), lruOrder_, it->second.lruIt);   // promote to MRU
    it->second.lruIt = lruOrder_.begin();
    return it->second.buffer;
}

SandboxBufferPtr SandboxRenderer::lookup(int sourceBufferId,
                                         const std::vector<SandboxOp>& ops,
                                         double bufferSampleRate) {
    if (bufferSampleRate <= 0.0) return nullptr;
    return lookupKey(SandboxRenderKey{ sourceBufferId,
                                       stackHash(ops),
                                       static_cast<int>(ops.size()),
                                       static_cast<int>(std::lround(bufferSampleRate)) });
}

void SandboxRenderer::insert(const SandboxRenderKey& key, SandboxBufferPtr buffer) {
    if (buffer == nullptr) return;
    const size_t bytes = bufferBytes(*buffer);

    std::lock_guard<std::mutex> lock(mu_);

    if (auto it = map_.find(key); it != map_.end()) {
        // Re-render of an already-cached key: replace in place, keep LRU slot.
        bytesNow_.fetch_sub(it->second.bytes, std::memory_order_relaxed);
        it->second.buffer = std::move(buffer);
        it->second.bytes  = bytes;
        bytesNow_.fetch_add(bytes, std::memory_order_relaxed);
        lruOrder_.splice(lruOrder_.begin(), lruOrder_, it->second.lruIt);
        it->second.lruIt = lruOrder_.begin();
        return;
    }

    lruOrder_.push_front(key);
    Entry e;
    e.buffer = std::move(buffer);
    e.lruIt  = lruOrder_.begin();
    e.bytes  = bytes;
    map_.emplace(key, std::move(e));
    bytesNow_.fetch_add(bytes, std::memory_order_relaxed);

    evictLocked();
}

void SandboxRenderer::evictLocked() {
    const size_t cap = maxBytes_.load(std::memory_order_relaxed);
    while (bytesNow_.load(std::memory_order_relaxed) > cap && !lruOrder_.empty()) {
        const SandboxRenderKey victim = lruOrder_.back();
        if (auto it = map_.find(victim); it != map_.end()) {
            bytesNow_.fetch_sub(it->second.bytes, std::memory_order_relaxed);
            map_.erase(it);
        }
        lruOrder_.pop_back();
    }
}

size_t SandboxRenderer::bufferBytes(const SandboxBuffer& b) noexcept {
    return static_cast<size_t>(b.getNumChannels())
         * static_cast<size_t>(b.getNumSamples())
         * sizeof(float);
}

// ─── Clipboard ────────────────────────────────────────────────────────────────

int SandboxRenderer::captureClipboard(const SandboxBuffer& source, int64_t startSample, int64_t endSample) {
    const Range r = resolveRange(startSample, endSample, source.getNumSamples());
    const int64_t n = r.end - r.start;
    if (n <= 0) return -1;

    auto buf = std::make_shared<SandboxBuffer>(source.getNumChannels(), static_cast<int>(n));
    for (int ch = 0; ch < source.getNumChannels(); ++ch)
        buf->copyFrom(ch, 0, source, ch, static_cast<int>(r.start), static_cast<int>(n));

    std::lock_guard<std::mutex> lock(mu_);
    const int id = nextClipboardId_++;
    clipboard_.emplace(id, std::move(buf));
    clipboardOrder_.push_back(id);
    while (clipboardOrder_.size() > kMaxClipboardEntries) {
        clipboard_.erase(clipboardOrder_.front());
        clipboardOrder_.pop_front();
    }
    return id;
}

SandboxBufferPtr SandboxRenderer::clipboardBuffer(int clipboardId) const {
    if (clipboardId < 0) return nullptr;
    std::lock_guard<std::mutex> lock(mu_);
    auto it = clipboard_.find(clipboardId);
    return it != clipboard_.end() ? it->second : nullptr;
}

void SandboxRenderer::recordRefusal(int layerId, int count, const std::string& reason) {
    std::lock_guard<std::mutex> lock(mu_);
    if (count <= 0) refusals_.erase(layerId);
    else            refusals_[layerId] = LayerRefusal{ count, reason };
}

SandboxRenderer::LayerRefusal SandboxRenderer::lastRefusal(int layerId) const {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = refusals_.find(layerId);
    return (it == refusals_.end()) ? LayerRefusal{} : it->second;
}

void SandboxRenderer::clearCache() {
    std::lock_guard<std::mutex> lock(mu_);
    map_.clear();
    lruOrder_.clear();
    bytesNow_.store(0, std::memory_order_relaxed);
    // The AUTOTUNE detection cache is keyed by the same render keys, so it goes
    // with them — leaving it behind would keep entries whose keys nothing can
    // reach any more.
    pitchCache_.clear();
    pitchLru_.clear();
}

size_t SandboxRenderer::entryCount() const {
    std::lock_guard<std::mutex> lock(mu_);
    return map_.size();
}

// ─── Job queue ────────────────────────────────────────────────────────────────

bool SandboxRenderer::submit(int layerId,
                             int sourceBufferId,
                             const SandboxBuffer& source,
                             const std::vector<SandboxOp>& ops,
                             double bufferSampleRate) {
    if (bufferSampleRate <= 0.0) return false;
    if (layerId < 0 || layerId >= kMaxLayers) return false;

    {
        std::lock_guard<std::mutex> lock(mu_);
        if (auto it = pending_.find(layerId); it != pending_.end() && it->second) return false;
        pending_[layerId] = true;
    }

    pool_->addJob(new SandboxRenderJob(*this, layerId, sourceBufferId, source, ops, bufferSampleRate),
                  true);
    return true;
}

void SandboxRenderer::finishJob(int layerId) {
    {
        std::lock_guard<std::mutex> lock(mu_);
        pending_.erase(layerId);
    }
    completionEpoch_.fetch_add(1, std::memory_order_release);
}

bool SandboxRenderer::isPending(int layerId) const {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = pending_.find(layerId);
    return it != pending_.end() && it->second;
}

size_t SandboxRenderer::pendingCount() const {
    std::lock_guard<std::mutex> lock(mu_);
    return pending_.size();
}

void SandboxRenderer::waitForPendingJobs(int timeoutMs) {
    if (!pool_) return;
    // Poll rather than removeAllJobs(): removeAllJobs CANCELS anything still
    // queued instead of letting it run, so a render submitted a moment earlier
    // would silently never happen. SlotBakeCache::waitForPendingJobs carries
    // the same note for the same reason. Main thread / tests only.
    const auto deadline = juce::Time::getMillisecondCounter()
                        + static_cast<uint32_t>(std::max(0, timeoutMs));
    while (pool_->getNumJobs() > 0
           && juce::Time::getMillisecondCounter() < deadline) {
        juce::Thread::sleep(2);
    }
}

// ─── Publication — the audio-thread handoff ───────────────────────────────────

void SandboxRenderer::publish(int layerId, SandboxBufferPtr buffer) {
    if (layerId < 0 || layerId >= kMaxLayers) return;
    // Atomic store. A block already holding the previous shared_ptr keeps that
    // buffer alive until it is done with it, so the swap is a handoff and never
    // an in-place mutation of something the audio thread is reading.
    published_[layerId].store(std::move(buffer), std::memory_order_release);
}

void SandboxRenderer::unpublish(int layerId) {
    if (layerId < 0 || layerId >= kMaxLayers) return;
    published_[layerId].store(nullptr, std::memory_order_release);
    std::lock_guard<std::mutex> lock(mu_);
    refusals_.erase(layerId);
}

SandboxBufferPtr SandboxRenderer::publishedOutput(int layerId) const noexcept {
    if (layerId < 0 || layerId >= kMaxLayers) return nullptr;
    return published_[layerId].load(std::memory_order_acquire);
}

} // namespace xleth::sandbox
