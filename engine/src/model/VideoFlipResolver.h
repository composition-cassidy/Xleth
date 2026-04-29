#pragma once
// VideoFlipResolver — pure state-machine evaluator for the per-track flip system.
//
// Spec: xleth-flip-v2-architecture-spec.md §4 ("State resolution algorithm").
//
// Given a track's VideoFlipConfig and the ordered list of mono trigger events
// on that track, returns one stateIndex per event. The function is deterministic
// (same inputs → same output, always) and stateless (no globals, no caches).
//
// **Mono-only contract.** Chord events (≥2 onsets sharing the same tick on the
// same track) are filtered upstream by the same loop that assigns globalNoteIndex
// today. The resolver never sees chord events; it must not be made aware of them.
// The caller fills chord-event stateIndex from the most recent prior mono event
// (or startStateIndex if none).
//
// **First-trigger rule.** every-note and new-note never advance on the first
// mono trigger; specific-pitches advances on the first trigger if the pitch is
// whitelisted (whitelist semantics override the first-trigger rule); every-n-beats
// is clock-driven and ignores ordinals entirely.
//
// **Wrap is the only cycle behavior.** No ping-pong, no hold, no stop. Users
// replicate ping-pong by enumerating states (e.g. [normal, h, v, h]).

#include "TimelineTypes.h"
#include <cstdint>
#include <vector>

// Single mono trigger event seen by the resolver.
//   tick  — absolute timeline tick (960 PPQ). Strictly ascending across the input.
//   pitch — MIDI note number (0..127). For clip tracks this is the clip's pitch
//           offset semitones; for pattern tracks it is the note's MIDI pitch.
struct TriggerEvent {
    int64_t tick  = 0;
    int     pitch = 60;
};

// Resolves stateIndex for each mono trigger event on a track.
//
//   config             — per-track flip configuration (states, modifier, start, enabled).
//   monoTriggerEvents  — chord-filtered, ascending-tick mono events on this track.
//   ticksPerBeat       — project PPQ (960 in Xleth).
//   beatsPerBar        — time-signature numerator; required for every-n-beats with
//                        subdivision='bar'. Defaulted for tests/users on 4/4 projects.
//
// Returns a vector of stateIndex values, one per input event, in input order.
// On disabled config or single-state config, all entries are 0 (no resolver work).
std::vector<int> resolveStateIndex(const VideoFlipConfig&            config,
                                   const std::vector<TriggerEvent>&  monoTriggerEvents,
                                   int                               ticksPerBeat,
                                   int                               beatsPerBar = 4);
