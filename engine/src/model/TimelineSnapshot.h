#pragma once

// ─── Frozen timeline copy for export ──────────────────────────────────────────
// Spec Ruling 7 (docs/XLETH_LENS_ROAM_SPEC.md): export reads a frozen timeline
// copy, never the live Timeline. Before this, OfflineRenderer and MixEngine read
// the live Timeline on the export thread with no lock, so an edit made during
// an export (move a clip, edit notes) raced every field the export read.
//
// makeFrozenTimelineCopy deep-copies the model DATA (sources, regions, tracks,
// clips, patterns, blocks, automation, grid snapshots/cues, loop region): no
// media, no decoders, no caches — those live outside Timeline. MESSAGE THREAD
// ONLY, under the model lock: it allocates, and it must not observe a
// half-applied edit.
//
// The copy is `const` and self-contained:
//   * Timeline has no `mutable` caches, so const reads never write to it and
//     the export thread can read it with no lock.
//   * Its clip-cache invalidator is cleared, so nothing done to or through the
//     copy can reach back into MixEngine.
//
// Ids are preserved exactly, so every id-keyed piece of engine state (clip
// render cache, samplers keyed {trackId, regionId}, effect chains, automation
// bindings) stays valid against the copy.

#include <memory>

class Timeline;

struct FrozenTimelineCopy {
    std::shared_ptr<const Timeline> timeline;
    double copyMs = 0.0;   // wall time of the deep copy alone
};

FrozenTimelineCopy makeFrozenTimelineCopy(const Timeline& live);
