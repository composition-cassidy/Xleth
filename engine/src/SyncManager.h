#pragma once

#include "Transport.h"
#include "FrameCache.h"
#include "model/TimelineTypes.h"

#include <functional>
#include <unordered_map>
#include <vector>

struct VideoEvent {
    double startBeat;       // When this event starts (in beats)
    double durationBeats;   // How long it lasts
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
};

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

    // Add video events to the timeline
    void addEvent(const VideoEvent& event);
    void clearEvents();

    // Read-only access to current events (caller must hold external lock if
    // the event list is being mutated concurrently).
    const std::vector<VideoEvent>& getEvents() const { return events_; }

    // Slide animation events — parallel list to video events, populated by
    // pattern-track rebuild for notes flagged isSlide. Cleared by clearEvents().
    void addSlideEvent(const SlideAnimationEvent& e) { slideEvents_.push_back(e); }
    const std::vector<SlideAnimationEvent>& getSlideEvents() const { return slideEvents_; }

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

    std::vector<VideoEvent>          events_;
    std::vector<SlideAnimationEvent> slideEvents_;

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
