#include "sandbox/SandboxRenderer.h"

#include <algorithm>
#include <cmath>

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
    : pool_(std::make_unique<juce::ThreadPool>(kThreads)),
      maxBytes_(maxBytes) {}

SandboxRenderer::~SandboxRenderer() {
    if (pool_) pool_->removeAllJobs(true, 5000);
    pool_.reset();
}

// ─── Op evaluation ────────────────────────────────────────────────────────────

SandboxBuffer SandboxRenderer::applyOp(const SandboxBuffer& in,
                                       const SandboxOp& op,
                                       double /*bufferSampleRate*/,
                                       const SandboxBuffer* clipboard) {
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

        // Guarded by implemented() above — listed so a newly built op that
        // forgets its case here is a compiler warning, not a silent no-op.
        case SandboxOpType::Pitch:
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
        for (const auto& op : ops)
            if (op.enabled && !op.implemented()) ++result.unimplementedOps;
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

        cur = applyOp(cur, op, bufferSampleRate, clipPtr);
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

void SandboxRenderer::clearCache() {
    std::lock_guard<std::mutex> lock(mu_);
    map_.clear();
    lruOrder_.clear();
    bytesNow_.store(0, std::memory_order_relaxed);
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
}

SandboxBufferPtr SandboxRenderer::publishedOutput(int layerId) const noexcept {
    if (layerId < 0 || layerId >= kMaxLayers) return nullptr;
    return published_[layerId].load(std::memory_order_acquire);
}

} // namespace xleth::sandbox
