#pragma once

#include "dsp/PitchTrackAnalysis.h"
#include "sandbox/SandboxRenderer.h"

#include <cstdint>
#include <list>
#include <memory>
#include <mutex>
#include <unordered_map>

// ─── SandboxPitchTrackAnalyzer ──────────────────────────────────────────────
//
// Caching wrapper around xleth::dsp::analyzePitchTrack (LoopAnalysis's NSDF
// detector, reused verbatim — see PitchTrackAnalysis.h) for the Sample
// Sandbox's AUTOTUNE detection pass. Mirrors SandboxSpectrogramAnalyzer's
// shape (mutex + LRU map), but with a different keying choice:
//
// ── Keyed by sourceBufferId, not content hash ────────────────────────────
// SandboxSpectrogramAnalyzer hashes buffer content because it can be handed
// a buffer with no stable identity at all (a bake/composite path). Pitch
// tracking is always run against a LAYER's bound source
// (SandboxLayer::sourceBufferId), which SampleBank mints fresh on every
// load/swap — see SandboxLayer's own doc comment — so trusting the id is the
// same convention SandboxRenderer's own prefix cache already relies on: a
// real buffer change already means a new id, and there is no ambiguous-
// origin caller here to guard against.
//
// ── Threading ─────────────────────────────────────────────────────────────
// Called from bridge RPC handlers only (main thread), never the audio
// callback — same contract as SandboxSpectrogramAnalyzer.

namespace xleth::sandbox {

struct SandboxPitchTrackResult {
    std::shared_ptr<const xleth::dsp::PitchTrackResult> track;
    bool valid() const { return track != nullptr; }
};

class SandboxPitchTrackAnalyzer {
public:
    explicit SandboxPitchTrackAnalyzer(size_t maxEntries = 32);

    // Mono-sums `buffer` and runs analyzePitchTrack over it. Returns an
    // invalid result (track == nullptr) when sampleRate <= 0, the buffer is
    // empty, or the analysis itself is degenerate (see PitchTrackResult::valid).
    SandboxPitchTrackResult analyze(int sourceBufferId, const SandboxBuffer& buffer, double sampleRate);

    // Non-blocking cache probe. Invalid result if `sourceBufferId` has not
    // been analyzed (or primed) yet. Promotes to most-recently-used.
    SandboxPitchTrackResult lookup(int sourceBufferId);

    // Installs an already-computed result under `sourceBufferId` without
    // running the analysis — used to restore the session-JSON-persisted
    // cache at project load, once layers have been rebound to their fresh
    // ids (see XlethEngineService.cpp's sandbox load path, which re-keys the
    // persisted-by-layerId entries to the newly-minted sourceBufferIds
    // before calling this).
    void primeCache(int sourceBufferId, xleth::dsp::PitchTrackResult result);

    void   clearCache();
    size_t entryCount() const;

private:
    struct Entry {
        SandboxPitchTrackResult       result;
        std::list<int>::iterator lruIt;
    };

    // Caller holds mu_. Inserts/overwrites `sourceBufferId` as MRU and
    // evicts down to maxEntries_.
    void insertLocked(int sourceBufferId, SandboxPitchTrackResult result);

    mutable std::mutex mu_;
    std::list<int> lruOrder_;   // front = MRU
    std::unordered_map<int, Entry> map_;
    size_t maxEntries_;
};

} // namespace xleth::sandbox
