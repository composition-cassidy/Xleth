#pragma once

#include "sandbox/SandboxRenderer.h"

#include <juce_dsp/juce_dsp.h>

#include <cstdint>
#include <list>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

// ─── SandboxSpectrogramAnalyzer (P3-1) ─────────────────────────────────────
//
// STFT magnitude analysis of a layer's RENDERED buffer — the post-op-stack
// output SandboxRenderer already published, never the raw source. The SPC
// canvas is a second way to look at exactly the audio the WAV canvas draws,
// so it has to analyze the same buffer WAV reads, not re-derive one.
//
// ── Tokens, not floats ───────────────────────────────────────────────────
// Output is one uint8 "token" per (frame, bin): the frame's dB magnitude,
// clamped to [kMinDb, kMaxDb] and linearly quantized to 0..255. The canvas
// maps a token straight to a monochromatic ramp with one multiply, and the
// wire payload is 4x smaller than sending floats — the same reasoning that
// made SandboxRenderer send interleaved PCM rather than a JSON array.
//
// ── The cache is content-hash keyed, not identity-keyed ─────────────────
// SandboxRenderer's render cache is keyed by (sourceBufferId, opStackHash) —
// identifiers of a PROCESS, cheap to compare, expensive to get wrong (two
// different stacks could hash-collide against ids alone). This cache instead
// hashes the buffer's own sample content, because the only thing offered at
// the call site is a rendered buffer, not the stack that produced it — a
// composite/bake path could hand this analyzer a buffer with no op-stack
// identity at all. A full content hash costs one more read pass over audio
// already being read once to mono-sum it, which is negligible next to the
// FFT work it usually saves: "edit a gain envelope then SPC updates" falls
// out of this for free, because a new render is a new set of samples and
// therefore a new hash — no invalidation plumbing required.
//
// ── Threading ─────────────────────────────────────────────────────────────
// Called from bridge RPC handlers only (main thread in this codebase, same
// as SandboxRenderer::lookup/submit's main-thread half) — never the audio
// callback. The mutex exists for correctness under a future caller, not
// because this is a hot path today.

namespace xleth::sandbox {

struct SandboxSpectrogramResult {
    // Row-major [frame][bin], numFrames*numBins bytes. nullptr = invalid.
    std::shared_ptr<const std::vector<uint8_t>> tokens;

    int    numFrames  = 0;
    int    numBins    = 0;   // FFT bins 0..Nyquist inclusive
    int    hopSize    = 0;   // samples between frame starts, at `sampleRate`
    double sampleRate = 0.0; // rate the analyzed buffer is stored at
    float  minDb      = 0.0f; // token 0   maps to this dB
    float  maxDb      = 0.0f; // token 255 maps to this dB

    bool valid() const { return tokens != nullptr; }
};

class SandboxSpectrogramAnalyzer {
public:
    static constexpr int kFftOrder = 11;                    // 2048-point FFT
    static constexpr int kFftSize  = 1 << kFftOrder;
    static constexpr int kNumBins  = kFftSize / 2 + 1;       // 0..Nyquist inclusive
    static constexpr int kHopSize  = kFftSize / 4;           // 512, 75% overlap
    static constexpr float kMinDb  = -90.0f;
    static constexpr float kMaxDb  = 0.0f;

    explicit SandboxSpectrogramAnalyzer(size_t maxEntries = 16);

    // Mono-sums `buffer` across channels and runs a windowed STFT over it.
    // Returns an invalid result (tokens == nullptr) when sampleRate <= 0 or
    // the buffer is empty — same refusal SandboxRenderer::renderStack makes
    // for a guessed rate.
    SandboxSpectrogramResult analyze(const SandboxBuffer& buffer, double sampleRate);

    void   clearCache();
    size_t entryCount() const;

private:
    struct Entry {
        SandboxSpectrogramResult result;
        std::list<uint64_t>::iterator lruIt;
    };

    static uint64_t contentHash(const std::vector<float>& mono, double sampleRate);

    mutable std::mutex mu_;
    std::list<uint64_t> lruOrder_;   // front = MRU
    std::unordered_map<uint64_t, Entry> map_;
    size_t maxEntries_;

    juce::dsp::FFT     fft_{ kFftOrder };
    std::vector<float> window_;      // periodic Hann, kFftSize samples
};

} // namespace xleth::sandbox
