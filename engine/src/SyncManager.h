#pragma once

#include "Transport.h"
#include "VideoDecoder.h"
#include "FrameCache.h"

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

    // Per-track running counter. For pattern events, counts notes in timeline
    // order; for clip events, counts clips in timeline order. Used by the grid
    // compositor to cycle video-flip modes across any track type.
    int   globalNoteIndex = 0;

    // Trim end point in source video (seconds). Used by FrameCollector to
    // detect when a note sustains past the sample's trimmed video length.
    // 0.0 = unset (no boundary check).
    double sourceEndTime = 0.0;
};

class SyncManager {
public:
    // compositor may be nullptr (Phase 0 / headless / bridge mode).
    // When null, videoTick() still decodes frames and fills the FrameCache
    // but skips all GPU upload/render calls.
    SyncManager(Transport& transport,
                std::vector<VideoDecoder*>& decoders,
                FrameCache& cache,
                VideoCompositor* compositor = nullptr);

    // Add video events to the timeline
    void addEvent(const VideoEvent& event);
    void clearEvents();

    // Read-only access to current events (caller must hold external lock if
    // the event list is being mutated concurrently).
    const std::vector<VideoEvent>& getEvents() const { return events_; }

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

    std::vector<VideoEvent> events_;

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
