#pragma once
// EnvelopeVoiceEvents — pure, deterministic enumeration of per-voice Envelope
// Controller trigger occurrences (EVC.4).
//
// Audit: docs/dev/fxgraph-envelope-controller-architecture-audit.md (EVC.1 §3–§6).
//
// This is the engine-side *contract/model only* phase of the per-voice Envelope
// Controller. It defines how Xleth enumerates the parent-track clip/note voice
// occurrences an Envelope node would later modulate. It is intentionally:
//
//   • Pure — no JUCE, no audio thread, no transport/playback state, no graphState
//     parsing. Same inputs → same output, always (the VideoFlipResolver precedent).
//   • Non-audible — it evaluates no AHDSR, applies no per-voice gain, and creates
//     no runtime voice objects. EVC.5/EVC.6 add the runtime; EVC.4b adds full
//     mid-note seek reconstruction.
//   • Engine-internal — occurrence keys are never exposed to the renderer/IPC and
//     are never serialized into graphState.
//
// Two trigger sources become per-voice occurrences:
//
//   • Timeline clips  — position-pure via the same overlap test as
//                       MixEngine::findActiveClips. A clip occurrence's gate is
//                       [clipStart, clipStart + clipDuration). A query window that
//                       overlaps the gate yields the occurrence (reconstruction-
//                       friendly), since clip activity is already seek-deterministic.
//   • Pattern notes   — onset/gate/loop math mirrors MixEngine::triggerPatternNotes
//                       (block position, block offset, loop iteration, note offset,
//                       note length, note-off clamp to block end). The note path is
//                       live-trigger-style here: an occurrence is produced when its
//                       onset tick falls inside the query window (held-note seek
//                       reconstruction is deferred to EVC.4b). The full gate end is
//                       still carried on each occurrence for later use.

#include "TimelineTypes.h"

#include <cstdint>
#include <string>
#include <vector>

// ─── EnvelopeVoiceSourceKind ──────────────────────────────────────────────────
// What spawned the voice occurrence. The underlying values define a stable
// secondary sort rank, so do not reorder.

enum class EnvelopeVoiceSourceKind : int {
    PatternNote  = 0,
    TimelineClip = 1,
};

inline std::string envelopeVoiceSourceKindToString(EnvelopeVoiceSourceKind k) {
    switch (k) {
        case EnvelopeVoiceSourceKind::PatternNote:  return "patternNote";
        case EnvelopeVoiceSourceKind::TimelineClip: return "timelineClip";
        default:                                    return "patternNote";
    }
}

// ─── EnvelopeTriggerEvents ────────────────────────────────────────────────────
// Mirrors the graphState `triggerSource.events` enum (EVC.2). Selects which
// parent-track events spawn envelope voices. This is a pure value passed *into*
// the enumerator — the engine still does not read graphState here.

enum class EnvelopeTriggerEvents : int {
    Notes         = 0,
    Clips         = 1,
    NotesAndClips = 2,
};

inline std::string envelopeTriggerEventsToString(EnvelopeTriggerEvents e) {
    switch (e) {
        case EnvelopeTriggerEvents::Notes:         return "notes";
        case EnvelopeTriggerEvents::Clips:         return "clips";
        case EnvelopeTriggerEvents::NotesAndClips: return "notesAndClips";
        default:                                   return "notesAndClips";
    }
}

// Repairs an unknown/missing string to the EVC.2 default (notesAndClips), never
// throws. Used by tests and future callers that read the renderer-supplied
// trigger-source selector; it does not parse a graphState document.
inline EnvelopeTriggerEvents stringToEnvelopeTriggerEvents(const std::string& s) {
    if (s == "notes") return EnvelopeTriggerEvents::Notes;
    if (s == "clips") return EnvelopeTriggerEvents::Clips;
    return EnvelopeTriggerEvents::NotesAndClips;
}

// ─── EnvelopeQueryWindow ──────────────────────────────────────────────────────
// Half-open tick range [startTick, endTick) the enumeration is scoped to. Ticks
// are 960-PPQ absolute timeline ticks (TickTime). A window with
// endTick <= startTick matches nothing.

struct EnvelopeQueryWindow {
    int64_t startTick = 0;
    int64_t endTick   = 0;

    bool isEmpty() const { return endTick <= startTick; }
};

// ─── EnvelopeVoiceOccurrenceKey ───────────────────────────────────────────────
// Stable engine-internal identity for one playing note/clip occurrence. The
// composite distinguishes overlapping clips, same-tick chord notes, and the same
// note across loop iterations (audit §4 candidate composite, extended with
// patternBlockId so the same pattern placed on two blocks never collides).
//
// NEVER expose this to the renderer/IPC; NEVER serialize it into graphState.

struct EnvelopeVoiceOccurrenceKey {
    int                     trackId        = -1;
    EnvelopeVoiceSourceKind sourceKind     = EnvelopeVoiceSourceKind::PatternNote;
    int                     sourceId       = -1;  // PatternNote.id or Clip.id
    int64_t                 onsetTick      = 0;
    int64_t                 loopIteration  = 0;    // 0 for clips and non-looping blocks
    int                     patternBlockId = -1;   // -1 for clips

    bool operator==(const EnvelopeVoiceOccurrenceKey& o) const {
        return trackId        == o.trackId
            && sourceKind     == o.sourceKind
            && sourceId       == o.sourceId
            && onsetTick      == o.onsetTick
            && loopIteration  == o.loopIteration
            && patternBlockId == o.patternBlockId;
    }
    bool operator!=(const EnvelopeVoiceOccurrenceKey& o) const { return !(*this == o); }

    // Total order for deterministic de-dup/lookups (mirrors the event sort).
    bool operator<(const EnvelopeVoiceOccurrenceKey& o) const {
        if (trackId        != o.trackId)        return trackId        < o.trackId;
        if (sourceKind     != o.sourceKind)     return static_cast<int>(sourceKind)
                                                     < static_cast<int>(o.sourceKind);
        if (patternBlockId != o.patternBlockId) return patternBlockId < o.patternBlockId;
        if (onsetTick      != o.onsetTick)      return onsetTick      < o.onsetTick;
        if (loopIteration  != o.loopIteration)  return loopIteration  < o.loopIteration;
        return sourceId < o.sourceId;
    }
};

// ─── EnvelopeVoiceEvent ───────────────────────────────────────────────────────
// One enumerated per-voice occurrence. Carries the occurrence key plus the
// onset/gate-end in both tick and sample domains, and the minimal source
// metadata EVC.4b/EVC.5 will key on. No AHDSR, no level, no runtime state.

struct EnvelopeVoiceEvent {
    EnvelopeVoiceOccurrenceKey key;

    int                     trackId      = -1;
    EnvelopeVoiceSourceKind sourceKind   = EnvelopeVoiceSourceKind::PatternNote;
    int                     sourceId     = -1;

    // Gate, tick domain (authoritative for determinism — 960 PPQ).
    int64_t onsetTick   = 0;
    int64_t gateEndTick = 0;   // release begins here; == onsetTick for zero-length

    // Gate, sample domain (derived via TickTime::toSamples — the same conversion
    // MixEngine uses; clamped to >= 0).
    int64_t onsetSample   = 0;
    int64_t gateEndSample = 0;

    int64_t loopIteration  = 0;   // 0 for clips and non-looping blocks
    int     pitch          = 60;  // PatternNote.pitch (MIDI) or Clip.pitchOffset (semitones)
    float   velocity       = 1.0f;
    int     regionId       = -1;
    int     patternId      = -1;  // -1 for clips
    int     patternBlockId = -1;  // -1 for clips

    int64_t gateLengthTicks() const {
        return gateEndTick > onsetTick ? gateEndTick - onsetTick : 0;
    }
};

// Deterministic total ordering for occurrence lists. Sorts by onset, then a fixed
// tie-break chain (source kind, track, block, loop iteration, pitch, source id) so
// same-tick chord members stay separate and ordered, never collapsed. Mirrors the
// VideoFlipApplier tie-break precedent (tick → source order → pitch → emission).
bool envelopeVoiceEventLess(const EnvelopeVoiceEvent& a, const EnvelopeVoiceEvent& b);

// ─── Enumeration helpers ──────────────────────────────────────────────────────
// All pure: they read only the supplied model data + window + tempo, never live
// playback history, transport state, or graphState. Each returns a stable
// deterministically-sorted list. `parentTrackId` is the Envelope node's owning
// track (graphState.trackId) — only that track's clips/notes are enumerated.

// Timeline clip occurrences. Overlap semantics (clip gate overlaps the window),
// matching MixEngine::findActiveClips, so a mid-clip query still returns the clip.
std::vector<EnvelopeVoiceEvent> enumerateEnvelopeClipOccurrences(
    const std::vector<Clip>& clips,
    int                      parentTrackId,
    const EnvelopeQueryWindow& window,
    double                   bpm,
    double                   sampleRate);

// Pattern note occurrences. Onset/gate/loop math mirrors
// MixEngine::triggerPatternNotes. An occurrence is produced when its onset tick
// falls inside the window (live-trigger semantics; held-note reconstruction is
// EVC.4b). `patterns` resolves each block's patternId; blocks on other tracks,
// blocks with no resolvable/region-less pattern, and zero-length patterns are
// skipped safely.
std::vector<EnvelopeVoiceEvent> enumerateEnvelopePatternNoteOccurrences(
    const std::vector<PatternBlock>& blocks,
    const std::vector<Pattern>&      patterns,
    int                              parentTrackId,
    const EnvelopeQueryWindow&       window,
    double                           bpm,
    double                           sampleRate);

// Combined enumeration honoring the trigger-source selector. Notes-only /
// clips-only / both, merged into one deterministically-sorted list.
std::vector<EnvelopeVoiceEvent> enumerateEnvelopeVoiceOccurrences(
    const std::vector<Clip>&         clips,
    const std::vector<PatternBlock>& blocks,
    const std::vector<Pattern>&      patterns,
    int                              parentTrackId,
    EnvelopeTriggerEvents            events,
    const EnvelopeQueryWindow&       window,
    double                           bpm,
    double                           sampleRate);
