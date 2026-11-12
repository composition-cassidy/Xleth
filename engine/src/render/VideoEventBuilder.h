#pragma once

// VideoEventBuilder — the ONE place a timeline is turned into VideoEvents.
//
// There used to be two: rebuildVideoEventsFromClips() in XlethEngineService.cpp
// for the live preview and OfflineRenderer::buildVideoEvents() for export. They
// were written at different times against the same intent and drifted, so the
// preview and the exported file could disagree about WHICH notes exist:
//
//   - a pattern note whose duration overran its block kept its cell lit past the
//     block end in the preview, while export (and audio) cut it at the block end;
//   - a non-looping block that was left-trimmed and then extended past the
//     pattern end made export wrap notes in from the next loop pass — picture
//     with no sound — while the preview and audio stayed silent;
//   - the preview dropped every event whose source had no legacy decoder open,
//     export had no such gate.
//
// Both callers now go through build(). Audio is the reference for every rule
// here: MixEngine::processPatternBlock decides which note-ons exist and where a
// note-off is clamped, and this file mirrors that tick-for-tick, in the same
// integer tick domain, so a note is visible exactly while it is audible.
//
// Everything downstream — FrameCollector, the compositor, the flip resolver —
// was already shared. This closes the last fork.

#include "SyncManager.h"            // VideoEvent
#include "model/TimelineTypes.h"    // SlideAnimationEvent

#include <vector>

class Timeline;

namespace xleth::videoevents {

struct BuildStats {
    int clipEvents    = 0;   // VideoEvents emitted from clips
    int noteEvents    = 0;   // VideoEvents emitted from pattern notes / arp steps
    int slideEvents   = 0;   // SlideAnimationEvents emitted
    int clipsSkipped  = 0;   // clips with no track / region / video source
    int blocksSkipped = 0;   // pattern blocks with no pattern / region / video source
};

struct BuildResult {
    std::vector<VideoEvent>          events;
    std::vector<SlideAnimationEvent> slideEvents;
    BuildStats                       stats;
};

// Build every VideoEvent and SlideAnimationEvent for `timeline`.
//
// bpm         tempo the events are timed against (the transport's for preview,
//             the timeline's for export — they are the same number in practice,
//             but each caller keeps reading the one it always read).
// sampleRate  rate the audio side runs at; only feeds
//             VideoEvent::clipStartTimelineSamples (vibrato phase alignment).
//
// Pure with respect to its arguments: reads the timeline, touches no globals,
// takes no locks. The caller owns whatever exclusion the timeline needs.
// Flip state (monoOrdinal / stateIndex / orientation) is already resolved in
// the returned events — videoFlipApplier::applyAll runs inside.
BuildResult build(const Timeline& timeline, double bpm, double sampleRate);

} // namespace xleth::videoevents
