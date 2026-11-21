#pragma once

#include "Transport.h"
#include "FrameCache.h"
#include "model/TimelineTypes.h"

#include <functional>
#include <memory>
#include <unordered_map>
#include <vector>

struct VideoEvent {
    double startBeat;       // When this event starts (in beats)
    double durationBeats;   // How long it lasts (exact ticks: startTick / lengthTicks)
    int    sourceId;        // Which video source
    int    trackId = -1;    // Originating track (for grid compositor lookup)
    double sourceStartTime; // Where in the source video to start (seconds)
    int    layerIndex;      // Which compositor layer to use

    // Layout properties
    float x, y;             // Position on screen (-1 to 1)
    float width, height;    // Size on screen
    float opacity;          // Transparency

    // User-authored clip fade envelope. Clip-track events populate these from
    // Clip; pattern/note events keep the zero-fade defaults. The video paths
    // evaluate them dynamically at the current timeline position.
    float fadeInPercent  = 0.0f;
    float fadeOutPercent = 0.0f;
    float fadeInX1  = 0.0f;
    float fadeInY1  = 0.0f;
    float fadeInX2  = 1.0f;
    float fadeInY2  = 1.0f;
    float fadeOutX1 = 0.0f;
    float fadeOutY1 = 0.0f;
    float fadeOutX2 = 1.0f;
    float fadeOutY2 = 1.0f;

    // Per-track running counter (counts ALL trigger events including chords).
    // Kept for analytics and future modifiers that need a chord-inclusive index.
    // The shader no longer reads this — `orientation` is consumed instead.
    int   globalNoteIndex = 0;

    // Internal resolver tie-break metadata. For same-tick note-ons the flip
    // resolver prefers source insertion/id order (pattern note id when
    // available), then pitch, then original emission order. Not persisted.
    bool    hasSourceTriggerOrder = false;
    int64_t sourceTriggerOrder    = 0;
    int     originalEmissionOrder = 0;

    // Trim end point in source video (seconds). Used by FrameCollector to
    // detect when a note sustains past the sample's trimmed video length.
    // 0.0 = unset (no boundary check).
    double sourceEndTime = 0.0;
    double sourceClampStartTime = 0.0; // Trim start / first valid frame for reverse clamps.

    // Which SampleRegion this event was emitted for (-1 = unset / not region-backed).
    // Used by FrameCollector to route to a per-region proxy decoder when one
    // is available.
    int regionId = -1;

    // Clip-track modulation metadata. Pattern/note events leave these at
    // defaults and remain unmodulated in Phase E.1.
    int clipId = -1;
    bool hasClipModulation = false;
    ClipModulation modulation;
    bool clipReversed = false;
    double clipStretchRatio = 1.0;
    bool clipFormantPreserve = false;
    int clipPitchOffsetSemis = 0;
    int clipPitchOffsetCents = 0;
    int64_t clipStartTimelineSamples = 0;

    // ── Flip v2 (per-track state machine — spec §5.1) ─────────────────────
    // Pitch identifier consumed by the resolver:
    //   • Pattern tracks: PatternNote.pitch (MIDI 0..127).
    //   • Clip tracks:    Clip.pitchOffset interpreted as a pitch identifier
    //                     (the track's "specific-pitches" whitelist matches semitone offsets).
    //   • Arp expansion:  resolved arp-step pitch from getNextArpNote().
    int pitch = 60;

    // Resolved trigger ordinal on the same track. In EveryNote mode this
    // counts every note-on, including same-tick chord members. Other modes
    // keep chord-transparent behavior and use -1 for chord events.
    // Set by VideoFlipApplier after the build loop completes.
    int monoOrdinal = -1;

    // Resolved flip-state machine output. stateIndex is the canonical analytics
    // value; orientation is the flat enum the shader consumes (post Phase 4).
    // Both are populated by VideoFlipApplier from the track's VideoFlipConfig.
    int         stateIndex  = 0;
    Orientation orientation = Orientation::None;

    // The event's span in TICKS (960 PPQ), exact: the clip start / the
    // note-on, and the CLAMPED length (a note-off clamped to its block end:
    // where the video actually stops). Lens/Roam keys are evaluated from these
    // (spec Ruling 5: from the note's start tick, never the first frame that
    // sees it), so a key on a zone boundary lands exactly on it, with no beat
    // round trip. Clip and note events carry the integer ticks; arp steps are
    // timed in beat space, so theirs are the beat values * 960. A hand-built
    // event leaves hasTickSpan false and readers fall back to the beats
    // (videoEventStartTick / videoEventLengthTicks below). Kept LAST so no
    // positional initializer of the fields above can shift.
    double startTick   = 0.0;
    double lengthTicks = 0.0;
    bool   hasTickSpan = false;

    // The note this event plays, for its per-note Lens override (spec Ruling
    // 6: overrides are keyed {patternId, noteId}; note ids are unique only
    // inside one pattern). Set on Pattern Track note events; -1 everywhere
    // else (clips, arp steps), which reads as Follow. Kept after the tick
    // span for the same positional-initializer reason.
    int lensPatternId = -1;
    int lensNoteId    = -1;

    // Clones (model/Clone.h): the track whose Track Lens, hit curve and note
    // overrides this event plays. -1 = trackId (every event but a Voice
    // clone's). A note routed to a Voice clone has trackId = the clone (its
    // cell, Roam, Sweep, effects, flip) and lensTrackId = the source when the
    // clone's Lens is Linked, the clone itself when it is Own. Kept last for
    // the positional-initializer reason above.
    int lensTrackId = -1;
};

// The track whose Track Lens an event plays (see VideoEvent::lensTrackId).
inline int videoEventLensTrackId(const VideoEvent& ev) {
    return ev.lensTrackId >= 0 ? ev.lensTrackId : ev.trackId;
}

// An event's start and clamped length in ticks: the exact span when the
// builder set it, else derived from the beats (see VideoEvent::startTick).
inline double videoEventStartTick(const VideoEvent& ev) {
    return ev.hasTickSpan ? ev.startTick : ev.startBeat * 960.0;
}
inline double videoEventLengthTicks(const VideoEvent& ev) {
    return ev.hasTickSpan ? ev.lengthTicks : ev.durationBeats * 960.0;
}

class SyncManager {
public:
    // SyncManager owns the realtime preview's VideoEvent list and answers
    // "which beat is the audio the user is hearing right now on?".
    //
    // It used to also drive an OpenGL VideoCompositor: decode a frame per
    // active event, upload it, and set a layerIndex-ordered layer. That
    // compositor was retired (see the Issue 10 note in VIDEO_PREVIEW_AUDIT.txt)
    // — all compositing, preview and export alike, goes through
    // FrameCollector + GridCompositor, which is zOrder-ordered. Nothing here
    // decodes, caches, or renders any more.
    //
    // presentationPositionProvider: optional; returns the sample position of
    // the audio actually leaving the device (vs. the position already
    // rendered). Falls back to Transport::getPositionSamples() when unset.
    explicit SyncManager(Transport& transport,
                         std::function<int64_t()> presentationPositionProvider = {});

    using EventList      = std::vector<VideoEvent>;
    using SlideEventList = std::vector<SlideAnimationEvent>;

    // ── Event list: immutable snapshots ─────────────────────────────────────
    // The list is PUBLISHED, never edited in place: setEvents() swaps in a
    // freshly built pair of lists, and readers take a shared_ptr to whichever
    // pair is current. A reader that holds a snapshot keeps a consistent list
    // for as long as it likes — the video tick holds one across its whole
    // decode / composite / readback, long after it has dropped the model lock
    // — and a rebuild landing in the meantime simply publishes a new one.
    //
    // The pointer swap itself is not atomic. Callers that publish or take a
    // snapshot hold the model lock (syncEventsMutex in the bridge) for that
    // instant only; nothing needs it while USING a snapshot.
    void setEvents(EventList events, SlideEventList slideEvents);
    std::shared_ptr<const EventList>      eventsSnapshot()      const { return events_; }
    std::shared_ptr<const SlideEventList> slideEventsSnapshot() const { return slideEvents_; }

    // Convenience views of the current snapshot. Valid until the next
    // setEvents / addEvent / clearEvents — i.e. only while the caller holds the
    // model lock. Take a snapshot instead when the lock will be released.
    const EventList&      getEvents()      const { return *events_; }
    const SlideEventList& getSlideEvents() const { return *slideEvents_; }

    // Append one event / drop everything. Each publishes a new snapshot, so a
    // reader still holding the previous one is unaffected.
    void addEvent(const VideoEvent& event);
    void addSlideEvent(const SlideAnimationEvent& e);
    void clearEvents();

    // Beat position of the audio currently being heard, or -1.0 when the
    // transport is stopped.
    //
    // Pure function of Transport + the presentation-position provider, both of
    // which are independently thread-safe atomic reads. It touches NO
    // SyncManager state, so callers must NOT take the event-list lock for it —
    // that is the whole point: the video thread used to hold the lock shared
    // with the event-rebuild path for the duration of a full per-event sweep.
    double currentBeatPosition() const;

    // ── Legacy preview stats ────────────────────────────────────────────────
    // Retained because they are published verbatim by the getStats RPC
    // (avgDriftMs / maxDriftMs / frameDrops) and by
    // diag_getVisualPreviewDiagnostic (counters.syncManagerDecodeCount, which
    // bridge/test_perf_regression.js asserts is present and stays 0).
    //
    // All four are now STRUCTURALLY zero, not measured-and-happens-to-be-zero:
    // SyncManager holds no decoder, no frame cache, and no compositor, so there
    // is nothing here that can drift, drop, or decode. getDecodeAttemptCount()
    // in particular was the sentinel for the dead-decode preview-FPS regression
    // (60fps -> ~17fps, fixed 3db1b33); that decode site no longer exists in
    // any build. The perf gate's remaining teeth are its videoTick µs budget
    // and its delivered-FPS floor.
    double getMaxDriftMs()         const { return 0.0; }
    double getAvgDriftMs()         const { return 0.0; }
    int    getFrameDropCount()     const { return 0; }
    int    getDecodeAttemptCount() const { return 0; }

private:
    Transport&               transport_;
    std::function<int64_t()> presentationPositionProvider_;

    // Never null: an empty project has empty lists, not missing ones.
    std::shared_ptr<const EventList>      events_      = std::make_shared<const EventList>();
    std::shared_ptr<const SlideEventList> slideEvents_ = std::make_shared<const SlideEventList>();

public:
    // Preview chorus hold state — written by video thread, reset on clearEvents().
    // Stored here (not as file-scope statics) so it resets on project close/switch.
    int64_t previewLastChorusFrame    = -1;
    int     previewLastChorusSourceId = -1;

    // Per-track hold-last-frame for grid cells — keyed by trackId.
    // Stores FrameKey (not raw CachedFrame*) to survive LRU eviction.
    // Reset alongside chorus hold state in clearEvents().
    std::unordered_map<int, FrameKey> previewLastGridCellKey;
};
