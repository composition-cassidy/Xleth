#pragma once

#include "Transport.h"
#include "VideoDecoder.h"
#include "FrameCache.h"
#include "model/TimelineTypes.h"

#include <unordered_map>
#include <vector>

// VideoCompositor is only available when building with GPU support.
// Forward-declare so SyncManager can hold a nullable pointer without
// pulling in <GL/glew.h> or <GLFW/glfw3.h>.
class VideoCompositor;

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

    // Per-track running counter (counts ALL trigger events including chords).
    // Kept for analytics and future modifiers that need a chord-inclusive index.
    // The shader no longer reads this — `orientation` is consumed instead.
    int   globalNoteIndex = 0;

    // Trim end point in source video (seconds). Used by FrameCollector to
    // detect when a note sustains past the sample's trimmed video length.
    // 0.0 = unset (no boundary check).
    double sourceEndTime = 0.0;
    double sourceClampStartTime = 0.0; // Trim start / first valid frame for reverse clamps.

    // Which SampleRegion this event was emitted for (-1 = unset / not region-backed).
    // Used by SyncManager::videoTick and FrameCollector to route to a
    // per-region proxy decoder when one is available.
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

    // Mono ordinal among chord-filtered trigger events on the same track.
    // -1 for chord events (≥2 events sharing one tick on the same track).
    // Set by VideoFlipApplier after the build loop completes.
    int monoOrdinal = -1;

    // Resolved flip-state machine output. stateIndex is the canonical analytics
    // value; orientation is the flat enum the shader consumes (post Phase 4).
    // Both are populated by VideoFlipApplier from the track's VideoFlipConfig.
    int         stateIndex  = 0;
    Orientation orientation = Orientation::None;
};

class Timeline; // fwd decl — only needed for getRegion() lookup in videoTick

class SyncManager {
public:
    // compositor may be nullptr (Phase 0 / headless / bridge mode).
    // When null, videoTick() still decodes frames and fills the FrameCache
    // but skips all GPU upload/render calls.
    SyncManager(Transport& transport,
                std::vector<VideoDecoder*>& decoders,
                FrameCache& cache,
                VideoCompositor* compositor = nullptr);

    // Wire in per-region proxy decoders and the Timeline used to resolve
    // SampleRegion metadata during videoTick(). Both references are stored
    // by pointer/ref and must remain valid for SyncManager's lifetime.
    //
    // regionDecoderPtrs: maps regionId -> VideoDecoder* for the region's proxy.
    //                    Growth of this map during playback is visible through
    //                    the reference. The owning map (unique_ptr) lives in
    //                    XlethAddon; this is just a raw-pointer lookup surface.
    // timeline:           used only for getRegion(regionId) to read
    //                     proxyStartTime/proxyEndTime/proxyReady during videoTick.
    void setRegionProxySources(
        std::unordered_map<int, VideoDecoder*>* regionDecoderPtrs,
        const Timeline*                         timeline);

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

    // Called on a dedicated video thread at ~60Hz.
    // Reads transport position -> determines which events are active ->
    // fetches/decodes frames -> (if compositor != nullptr) uploads + renders.
    double videoTick();

    // Performance stats
    double getLastDriftMs()    const;
    double getMaxDriftMs()     const;
    double getAvgDriftMs()     const;
    double getAvgDecodeTimeMs() const;
    int    getFrameDropCount() const;
    double getCacheHitRate()   const;

private:
    Transport&                  transport_;
    std::vector<VideoDecoder*>& decoders_;
    FrameCache&                 cache_;
    VideoCompositor*            compositor_;  // nullable

    // Region proxy lookup surfaces — both nullable; nullptr disables
    // per-region proxy preference (videoTick falls back to the source decoder).
    std::unordered_map<int, VideoDecoder*>* regionDecoderPtrs_ = nullptr;
    const Timeline*                         timelineForRegions_ = nullptr;

    std::vector<VideoEvent>          events_;
    std::vector<SlideAnimationEvent> slideEvents_;

    // Drift tracking
    std::vector<double> driftSamples_;
    double maxDrift_   = 0.0;
    int    frameDrops_ = 0;

    // Decode timing
    std::vector<double> decodeTimeSamples_;

    // Frame dedup: don't re-upload if same frame
    std::unordered_map<int, int> lastDisplayedFrame_; // layerIndex -> frameNumber

    // Track which layers are currently active for visibility toggling
    int maxLayerIndex_ = 0;

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
