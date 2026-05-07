// test_frame_collector.cpp — Verifies FrameCollector collection + deduplication
// Uses mock Timeline/GridLayout/VideoEvent data — no GPU or decoder needed.

#include "render/FrameCollector.h"
#include "render/FrameCache.h"
#include "model/Timeline.h"
#include "SyncManager.h"

#include <algorithm>
#include <cassert>
#include <cstdio>

// ---------------------------------------------------------------------------
// Helper: build a VideoEvent
// ---------------------------------------------------------------------------
static VideoEvent makeEvent(int trackId, int sourceId, double startBeat,
                            double durationBeats, double sourceStartTime,
                            float opacity, int globalNoteIndex)
{
    VideoEvent ev{};
    ev.trackId         = trackId;
    ev.sourceId        = sourceId;
    ev.startBeat       = startBeat;
    ev.durationBeats   = durationBeats;
    ev.sourceStartTime = sourceStartTime;
    ev.layerIndex      = 0;
    ev.x = 0; ev.y = 0; ev.width = 1; ev.height = 1;
    ev.opacity         = opacity;
    ev.globalNoteIndex = globalNoteIndex;
    return ev;
}

int main()
{
    std::fprintf(stderr, "\n[TEST:FrameCollector] Starting collector tests...\n");

    // ── Setup: Timeline with a 4×4 grid ──────────────────────────────────────
    Timeline timeline(140.0, 48000.0);

    // Add two video sources
    SourceMedia srcA;
    srcA.filePath   = "video_A.mp4";
    srcA.hasVideo   = true;
    srcA.fps        = 30.0;
    srcA.duration   = 120.0;
    srcA.totalFrames = 3600;
    srcA.width = 1920; srcA.height = 1080;
    int srcAId = timeline.addSource(srcA);

    SourceMedia srcB;
    srcB.filePath   = "video_B.mp4";
    srcB.hasVideo   = true;
    srcB.fps        = 30.0;
    srcB.duration   = 60.0;
    srcB.totalFrames = 1800;
    srcB.width = 1280; srcB.height = 720;
    int srcBId = timeline.addSource(srcB);

    // Add regions pointing to each source
    SampleRegion regA;
    regA.sourceId  = srcAId;
    regA.startTime = 0.0;
    regA.endTime   = 120.0;
    regA.startFrame = 0;
    regA.endFrame   = 3599;
    timeline.addRegion(regA);

    SampleRegion regB;
    regB.sourceId  = srcBId;
    regB.startTime = 0.0;
    regB.endTime   = 60.0;
    regB.startFrame = 0;
    regB.endFrame   = 1799;
    timeline.addRegion(regB);

    // Add tracks: 4 pattern tracks + 1 chorus + 1 crash
    // Tracks for grid cells
    int trackIds[4];
    for (int i = 0; i < 4; ++i) {
        TrackInfo t;
        t.name = "Track " + std::to_string(i);
        t.type = TrackInfo::Type::Pattern;
        trackIds[i] = timeline.addTrack(t);
    }

    // Chorus track
    TrackInfo chorusTrack;
    chorusTrack.name = "Chorus";
    chorusTrack.type = TrackInfo::Type::Pattern;
    int chorusTrackId = timeline.addTrack(chorusTrack);

    // Crash track
    TrackInfo crashTrack;
    crashTrack.name = "Crash";
    crashTrack.type = TrackInfo::Type::Pattern;
    int crashTrackId = timeline.addTrack(crashTrack);

    // Setup grid layout: 2×2 grid, 4 cells
    GridLayout layout;
    layout.columns = 2;
    layout.rows    = 2;
    layout.fullscreenLayers.push_back({chorusTrackId,
        FullscreenLayerPlacement::BehindGrid, 1.0f});
    layout.fullscreenLayers.push_back({crashTrackId,
        FullscreenLayerPlacement::InFrontOfGrid, 0.7f});

    // Coordinates use fine-grid units (kGridSubUnitsPerColumn per column,
    // kGridSubUnitsPerRow per row). A full main cell has span = column.
    const int FCOL = kGridSubUnitsPerColumn;
    const int FROW = kGridSubUnitsPerRow;
    // Cell (0,0): trackIds[0]
    layout.slots.push_back({trackIds[0],  0,    0,    FCOL, FROW, 1.0f, 0});
    // Cell (1,0): trackIds[1]
    layout.slots.push_back({trackIds[1],  FCOL, 0,    FCOL, FROW, 0.8f, 1});
    // Cell (0,1): trackIds[2] — NOT assigned (gap: trackId = -1)
    layout.slots.push_back({-1,           0,    FROW, FCOL, FROW, 1.0f, 2});
    // Cell (1,1): trackIds[3]
    layout.slots.push_back({trackIds[3],  FCOL, FROW, FCOL, FROW, 0.5f, 3});

    timeline.setGridLayout(layout);

    // ── Build VideoEvents ────────────────────────────────────────────────────
    // At BPM=140, beat 0 = time 0, beat 1 = 60/140 = 0.4286s
    // Output frame 0 at 30fps = sample 0 = beat 0
    // Output frame 30 at 30fps = sample 48000 = time 1.0s = beat 2.333...

    // All 3 grid tracks (0, 1, 3) + chorus + crash have events active at beat 0.
    // Track 0 and Track 1 point to source A at SAME source time (0.0s) → dedup!
    // Track 3 points to source B at 1.0s
    // Chorus points to source A at 2.0s
    // Crash points to source B at 0.5s

    std::vector<VideoEvent> events;
    // Track 0: source A, frame at sourceStartTime=0.0
    events.push_back(makeEvent(trackIds[0], srcAId, 0.0, 4.0, 0.0, 1.0f, 0));
    // Track 1: source A, frame at sourceStartTime=0.0 (SAME as track 0 → dedup)
    events.push_back(makeEvent(trackIds[1], srcAId, 0.0, 4.0, 0.0, 0.9f, 1));
    // Track 2 has no slot assigned (trackId=-1), so no event needed
    // Track 3: source B, frame at sourceStartTime=1.0
    events.push_back(makeEvent(trackIds[3], srcBId, 0.0, 4.0, 1.0, 0.7f, 0));
    // Chorus: source A, frame at sourceStartTime=2.0
    events.push_back(makeEvent(chorusTrackId, srcAId, 0.0, 4.0, 2.0, 1.0f, 0));
    // Crash: source B, frame at sourceStartTime=0.5
    events.push_back(makeEvent(crashTrackId, srcBId, 0.0, 4.0, 0.5, 1.0f, 0));

    // ── Test 1: collectRequests ──────────────────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:FrameCollector] --- Test 1: collectRequests ---\n");

        FrameCollector collector;
        AVRational fps = {30, 1};
        auto requests = collector.collectRequests(0, timeline, 48000, fps, events);

        // Expected: 3 grid cells (slot with trackId=-1 skipped) + 1 chorus + 1 crash = 5
        std::fprintf(stderr, "[TEST:FrameCollector] requests.size() = %d (expected 5)\n",
                     (int)requests.size());
        assert(requests.size() == 5);

        // Check fullscreen layer kinds
        int behindCount = 0, frontCount = 0;
        for (const auto& r : requests) {
            if (r.layerKind == CellLayerKind::FullscreenBehind)  ++behindCount;
            if (r.layerKind == CellLayerKind::FullscreenInFront) ++frontCount;
        }
        assert(behindCount == 1);
        assert(frontCount == 1);
        std::fprintf(stderr, "[TEST:FrameCollector] behind=%d front=%d: PASSED\n",
                     behindCount, frontCount);

        // Check FS-front opacity: layer.opacity(0.7) * event.opacity(1.0) = 0.7
        for (const auto& r : requests) {
            if (r.layerKind == CellLayerKind::FullscreenInFront) {
                std::fprintf(stderr, "[TEST:FrameCollector] FS-front opacity=%.2f (expected 0.70)\n",
                             r.opacity);
                assert(std::abs(r.opacity - 0.7f) < 0.01f);
            }
        }

        // Check that slot opacity * event opacity is applied to grid cells
        for (const auto& r : requests) {
            if (r.layerKind == CellLayerKind::Grid && r.trackId == trackIds[1]) {
                // slot.opacity=0.8, event.opacity=0.9 → 0.72
                std::fprintf(stderr, "[TEST:FrameCollector] track1 opacity=%.2f (expected 0.72)\n",
                             r.opacity);
                assert(std::abs(r.opacity - 0.72f) < 0.01f);
            }
        }

        std::fprintf(stderr, "[TEST:FrameCollector] Test 1: PASSED\n");
    }

    // ── Test 2: deduplicateRequests ──────────────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:FrameCollector] --- Test 2: deduplicateRequests ---\n");

        FrameCollector collector;
        AVRational fps = {30, 1};
        auto requests = collector.collectRequests(0, timeline, 48000, fps, events);

        // Track 0 and Track 1 both show source A frame 0 → should dedup to 1 key
        auto deduped = FrameCollector::deduplicateRequests(requests);

        std::fprintf(stderr, "[TEST:FrameCollector] %d requests -> %d unique keys\n",
                     (int)requests.size(), (int)deduped.size());

        // We have 5 requests:
        //   chorus: srcA @ sourceTime=2.0s → frame = floor(2.0 * 30) = 60
        //   track0: srcA @ sourceTime=0.0s → frame = 0
        //   track1: srcA @ sourceTime=0.0s → frame = 0  (DUPLICATE of track0)
        //   track3: srcB @ sourceTime=1.0s → frame = 30
        //   crash:  srcB @ sourceTime=0.5s → frame = 15
        // Unique keys: (srcA,0), (srcA,60), (srcB,30), (srcB,15) = 4
        assert(deduped.size() == 4);
        assert(deduped.size() < requests.size()); // dedup reduced count

        // Find the key for srcA frame 0 — should map to 2 cells
        FrameCacheKey keyA0;
        keyA0.sourcePath = "video_A.mp4";
        keyA0.frameIndex = 0;
        auto it = deduped.find(keyA0);
        assert(it != deduped.end());
        std::fprintf(stderr, "[TEST:FrameCollector] srcA frame 0 mapped to %d cells (expected 2)\n",
                     (int)it->second.size());
        assert(it->second.size() == 2);

        std::fprintf(stderr, "[TEST:FrameCollector] Test 2: PASSED\n");
    }

    // ── Test 3: gap exclusion with muted track ──────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:FrameCollector] --- Test 3: muted track exclusion ---\n");

        // Mute track 0
        TrackInfo* t0 = timeline.getTrackMutable(trackIds[0]);
        assert(t0);
        t0->muted = true;

        FrameCollector collector;
        AVRational fps = {30, 1};
        auto requests = collector.collectRequests(0, timeline, 48000, fps, events);

        // Now 4 instead of 5 (track0 muted)
        std::fprintf(stderr, "[TEST:FrameCollector] requests with mute: %d (expected 4)\n",
                     (int)requests.size());
        assert(requests.size() == 4);

        // Verify track0 is not in the list
        for (const auto& r : requests) {
            assert(r.trackId != trackIds[0] && "Muted track should be excluded");
        }

        // Unmute
        t0->muted = false;

        std::fprintf(stderr, "[TEST:FrameCollector] Test 3: PASSED\n");
    }

    // ── Test 4: frame index computation at non-zero output frame ────────────
    {
        std::fprintf(stderr, "\n[TEST:FrameCollector] --- Test 4: frame index at output frame 30 ---\n");

        // Output frame 30 at 30fps, 48kHz = sample 48000 = 1.0 second
        // At BPM=140: beatPos = 1.0 * 140/60 = 2.333...
        // Track 0 event: sourceStartTime=0.0, startBeat=0.0
        //   beatsSince = 2.333, secsSince = 2.333 * 60/140 = 1.0s
        //   sourceTime = 0.0 + 1.0 = 1.0s → frame = floor(1.0 * 30) = 30

        FrameCollector collector;
        AVRational fps = {30, 1};
        auto requests = collector.collectRequests(30, timeline, 48000, fps, events);

        // Find track0's request
        const CellFrameRequest* track0Req = nullptr;
        for (const auto& r : requests) {
            if (r.trackId == trackIds[0] && r.layerKind == CellLayerKind::Grid) {
                track0Req = &r;
                break;
            }
        }
        assert(track0Req != nullptr);
        std::fprintf(stderr, "[TEST:FrameCollector] track0 at frame 30: srcFrame=%lld (expected 30)\n",
                     (long long)track0Req->sourceFrameIndex);
        assert(track0Req->sourceFrameIndex == 30);

        std::fprintf(stderr, "[TEST:FrameCollector] Test 4: PASSED\n");
    }

    {
        std::fprintf(stderr, "\n[TEST:FrameCollector] --- Test 4b: scratch timing warp ---\n");

        VideoEvent ev = makeEvent(trackIds[0], srcAId, 0.0, 4.0, 0.0, 1.0f, 0);
        ev.sourceEndTime = 120.0;
        ev.sourceClampStartTime = 0.0;
        ev.clipId = 42;
        ev.hasClipModulation = true;
        ev.modulation.enabled = true;
        ev.modulation.scratch.enabled = true;
        ev.modulation.scratch.timeMode = ClipModulation::Scratch::CurveTimeMode::ClipSeconds;
        ev.modulation.scratch.curve.push_back({0.0f, 2.0f, 0.0f});

        std::vector<VideoEvent> modEvents { ev };

        FrameCollector collector;
        AVRational fps = {30, 1};
        auto requests = collector.collectRequests(30, timeline, 48000, fps, modEvents);

        const CellFrameRequest* track0Req = nullptr;
        for (const auto& r : requests) {
            if (r.trackId == trackIds[0] && r.layerKind == CellLayerKind::Grid) {
                track0Req = &r;
                break;
            }
        }
        assert(track0Req != nullptr);
        std::fprintf(stderr, "[TEST:FrameCollector] scratch rate 2 at output frame 30: srcFrame=%lld (expected 60)\n",
                     (long long)track0Req->sourceFrameIndex);
        assert(track0Req->sourceFrameIndex == 60);

        std::fprintf(stderr, "[TEST:FrameCollector] Test 4b: PASSED\n");
    }

    {
        std::fprintf(stderr, "\n[TEST:FrameCollector] --- Test 4c: companion FX snapshots ---\n");

        VideoEvent vib = makeEvent(trackIds[0], srcAId, 0.0, 4.0, 0.0, 1.0f, 0);
        vib.sourceEndTime = 120.0;
        vib.sourceClampStartTime = 0.0;
        vib.clipId = 43;
        vib.hasClipModulation = true;
        vib.modulation.enabled = true;
        vib.modulation.vibrato.enabled = true;
        vib.modulation.vibrato.depthCents = 50.0f;
        vib.modulation.vibrato.rateHz = 2.0f;
        vib.modulation.video.vibratoSwirlEnabled = true;
        vib.modulation.video.swirlAmount = 0.35f;
        vib.modulation.video.swirlRadius = 0.55f;

        FrameCollector collector;
        AVRational fps = {30, 1};

        auto previewDefaultRequests = collector.collectRequests(15, timeline, 48000, fps,
                                                                std::vector<VideoEvent>{vib});
        const CellFrameRequest* previewDefaultReq = nullptr;
        for (const auto& r : previewDefaultRequests) {
            if (r.trackId == trackIds[0] && r.layerKind == CellLayerKind::Grid) {
                previewDefaultReq = &r;
                break;
            }
        }
        assert(previewDefaultReq != nullptr);
        assert(!previewDefaultReq->companionFx.vibratoSwirlEnabled);
        assert(!previewDefaultReq->companionFx.scratchWaveEnabled);

        collector.setCompanionFxEnabled(true);
        auto vibRequests = collector.collectRequests(15, timeline, 48000, fps,
                                                     std::vector<VideoEvent>{vib});

        const CellFrameRequest* vibReq = nullptr;
        for (const auto& r : vibRequests) {
            if (r.trackId == trackIds[0] && r.layerKind == CellLayerKind::Grid) {
                vibReq = &r;
                break;
            }
        }
        assert(vibReq != nullptr);
        assert(vibReq->companionFx.vibratoSwirlEnabled);
        assert(!vibReq->companionFx.scratchWaveEnabled);
        assert(std::abs(vibReq->companionFx.swirlAmount - 0.35f) < 0.0001f);
        assert(std::abs(vibReq->companionFx.swirlRadius - 0.55f) < 0.0001f);

        VideoEvent scratch = makeEvent(trackIds[0], srcAId, 0.0, 4.0, 0.0, 1.0f, 0);
        scratch.sourceEndTime = 120.0;
        scratch.sourceClampStartTime = 0.0;
        scratch.clipId = 44;
        scratch.hasClipModulation = true;
        scratch.modulation.enabled = true;
        scratch.modulation.scratch.enabled = true;
        scratch.modulation.scratch.timeMode = ClipModulation::Scratch::CurveTimeMode::ClipSeconds;
        scratch.modulation.scratch.curve.push_back({0.0f, -1.0f, 0.0f});
        scratch.modulation.video.scratchWaveEnabled = true;
        scratch.modulation.video.waveAmount = 0.11f;
        scratch.modulation.video.waveFrequency = 6.0f;
        scratch.modulation.video.smearAmount = 0.25f;
        scratch.modulation.video.reverseWaveWithScratch = true;

        auto scratchRequests = collector.collectRequests(15, timeline, 48000, fps,
                                                         std::vector<VideoEvent>{scratch});

        const CellFrameRequest* scratchReq = nullptr;
        for (const auto& r : scratchRequests) {
            if (r.trackId == trackIds[0] && r.layerKind == CellLayerKind::Grid) {
                scratchReq = &r;
                break;
            }
        }
        assert(scratchReq != nullptr);
        assert(!scratchReq->companionFx.vibratoSwirlEnabled);
        assert(scratchReq->companionFx.scratchWaveEnabled);
        assert(std::abs(scratchReq->companionFx.waveAmount - 0.11f) < 0.0001f);
        assert(std::abs(scratchReq->companionFx.waveFrequency - 6.0f) < 0.0001f);
        assert(std::abs(scratchReq->companionFx.smearAmount - 0.25f) < 0.0001f);
        assert(scratchReq->companionFx.reverseWaveWithScratch);

        scratch.clipReversed = true;
        auto bypassRequests = collector.collectRequests(15, timeline, 48000, fps,
                                                        std::vector<VideoEvent>{scratch});
        const CellFrameRequest* bypassReq = nullptr;
        for (const auto& r : bypassRequests) {
            if (r.trackId == trackIds[0] && r.layerKind == CellLayerKind::Grid) {
                bypassReq = &r;
                break;
            }
        }
        assert(bypassReq != nullptr);
        assert(!bypassReq->companionFx.vibratoSwirlEnabled);
        assert(!bypassReq->companionFx.scratchWaveEnabled);

        std::fprintf(stderr, "[TEST:FrameCollector] Test 4c: PASSED\n");
    }

    // ── Phase F.0: companion FX populated for static-pitch-shifted clips ────
    // Static pitch (pitchOffset semis or pitchOffsetCents) is NOT in the bypass
    // list — vibrato + scratch + companion FX must still apply, and the
    // sourceFrameIndex must reflect the static pitch ratio composed with the
    // scratch source-time integral.
    {
        std::fprintf(stderr, "\n[TEST:FrameCollector] --- Test 4d (F.0): static-pitch clip with companion FX ---\n");

        VideoEvent ev = makeEvent(trackIds[0], srcAId, 0.0, 4.0, 0.0, 1.0f, 0);
        ev.sourceEndTime = 120.0;
        ev.sourceClampStartTime = 0.0;
        ev.clipId = 51;
        ev.clipReversed = false;
        ev.clipStretchRatio = 1.0;
        ev.clipFormantPreserve = false;
        ev.clipPitchOffsetSemis = 12;          // +1 octave static pitch
        ev.clipPitchOffsetCents = 0;
        ev.hasClipModulation = true;
        ev.modulation.enabled = true;
        ev.modulation.scratch.enabled = true;
        ev.modulation.scratch.timeMode = ClipModulation::Scratch::CurveTimeMode::ClipSeconds;
        ev.modulation.scratch.curve.push_back({0.0f, 2.0f, 0.0f});
        ev.modulation.vibrato.enabled = true;
        ev.modulation.vibrato.depthCents = 25.0f;
        ev.modulation.vibrato.rateHz = 4.0f;
        ev.modulation.video.vibratoSwirlEnabled = true;
        ev.modulation.video.swirlAmount = 0.4f;
        ev.modulation.video.swirlRadius = 0.6f;
        ev.modulation.video.scratchWaveEnabled = true;
        ev.modulation.video.waveAmount = 0.2f;
        ev.modulation.video.waveFrequency = 5.0f;

        FrameCollector collector;
        collector.setCompanionFxEnabled(true);
        AVRational fps = {30, 1};
        auto requests = collector.collectRequests(30, timeline, 48000, fps,
                                                  std::vector<VideoEvent>{ev});

        const CellFrameRequest* req = nullptr;
        for (const auto& r : requests) {
            if (r.trackId == trackIds[0] && r.layerKind == CellLayerKind::Grid) {
                req = &r;
                break;
            }
        }
        assert(req != nullptr);

        // Companion FX must be populated for a static-pitch-shifted clip.
        assert(req->companionFx.vibratoSwirlEnabled);
        assert(req->companionFx.scratchWaveEnabled);

        // sourceFrameIndex math at output frame 30 (= 1s @ 30fps):
        //   scratchBase    = ∫₀^1 2 dt = 2.0 s
        //   vibratoResidual ≈ clipLocalSeconds * (staticRatio - 1) ≈ 1 * (2 - 1) = 1.0 s
        //   sourceTime     ≈ 3.0 s    (vibrato 25c at 4Hz adds <<1 frame jitter)
        //   srcFrame       ≈ 90       (3.0 × 30 fps)
        std::fprintf(stderr, "[TEST:FrameCollector] static pitch + scratch 2 + vibrato 25c: srcFrame=%lld (expected ~90)\n",
                     (long long)req->sourceFrameIndex);
        assert(req->sourceFrameIndex >= 88 && req->sourceFrameIndex <= 92);

        std::fprintf(stderr, "[TEST:FrameCollector] Test 4d: PASSED\n");
    }

    // Phase F.1: stretched clips use post-cache modulation, while reversed
    // and formant-preserve variants remain bypassed.
    {
        std::fprintf(stderr, "\n[TEST:FrameCollector] --- Test 4e (F.1): stretched clip post-cache modulation ---\n");

        VideoEvent ev = makeEvent(trackIds[0], srcAId, 0.0, 4.0, 0.0, 1.0f, 0);
        ev.sourceEndTime = 120.0;
        ev.sourceClampStartTime = 0.0;
        ev.clipId = 52;
        ev.clipReversed = false;
        ev.clipStretchRatio = 1.5;
        ev.clipFormantPreserve = false;
        ev.hasClipModulation = true;
        ev.modulation.enabled = true;
        ev.modulation.scratch.enabled = true;
        ev.modulation.scratch.timeMode = ClipModulation::Scratch::CurveTimeMode::ClipSeconds;
        ev.modulation.scratch.curve.push_back({0.0f, 2.0f, 0.0f});
        ev.modulation.vibrato.enabled = true;
        ev.modulation.vibrato.depthCents = 25.0f;
        ev.modulation.video.vibratoSwirlEnabled = true;
        ev.modulation.video.swirlAmount = 0.4f;
        ev.modulation.video.scratchWaveEnabled = true;
        ev.modulation.video.waveAmount = 0.2f;

        FrameCollector collector;
        collector.setCompanionFxEnabled(true);
        AVRational fps = {30, 1};
        auto requests = collector.collectRequests(30, timeline, 48000, fps,
                                                  std::vector<VideoEvent>{ev});

        const CellFrameRequest* req = nullptr;
        for (const auto& r : requests) {
            if (r.trackId == trackIds[0] && r.layerKind == CellLayerKind::Grid) {
                req = &r;
                break;
            }
        }
        assert(req != nullptr);

        // Stretched-compatible clips populate companion FX and timing warp.
        assert(req->companionFx.vibratoSwirlEnabled);
        assert(req->companionFx.scratchWaveEnabled);

        // sourceFrameIndex reflects scratch over the stretched clip timeline:
        //   scratchBase = integral of constant rate 2 over 1s = 2.0s
        //   srcFrame    = 60
        std::fprintf(stderr, "[TEST:FrameCollector] stretched active: srcFrame=%lld (expected ~60)\n",
                     (long long)req->sourceFrameIndex);
        assert(req->sourceFrameIndex >= 59 && req->sourceFrameIndex <= 61);

        ev.clipReversed = true;
        auto reversedRequests = collector.collectRequests(30, timeline, 48000, fps,
                                                          std::vector<VideoEvent>{ev});
        const CellFrameRequest* reversedReq = nullptr;
        for (const auto& r : reversedRequests) {
            if (r.trackId == trackIds[0] && r.layerKind == CellLayerKind::Grid) {
                reversedReq = &r;
                break;
            }
        }
        assert(reversedReq != nullptr);
        assert(!reversedReq->companionFx.vibratoSwirlEnabled);
        assert(!reversedReq->companionFx.scratchWaveEnabled);
        assert(reversedReq->sourceFrameIndex == 30);

        ev.clipReversed = false;
        ev.clipFormantPreserve = true;
        auto formantRequests = collector.collectRequests(30, timeline, 48000, fps,
                                                         std::vector<VideoEvent>{ev});
        const CellFrameRequest* formantReq = nullptr;
        for (const auto& r : formantRequests) {
            if (r.trackId == trackIds[0] && r.layerKind == CellLayerKind::Grid) {
                formantReq = &r;
                break;
            }
        }
        assert(formantReq != nullptr);
        assert(!formantReq->companionFx.vibratoSwirlEnabled);
        assert(!formantReq->companionFx.scratchWaveEnabled);
        assert(formantReq->sourceFrameIndex == 30);

        std::fprintf(stderr, "[TEST:FrameCollector] Test 4e: PASSED\n");
    }

    // ── Test 5: massive dedup scenario — 12 cells showing same frame ────────
    {
        std::fprintf(stderr, "\n[TEST:FrameCollector] --- Test 5: massive deduplication ---\n");

        // Create a 4×4 grid where all 16 slots point to different tracks,
        // but all tracks have events pointing to the SAME source at the SAME time
        Timeline bigTimeline(140.0, 48000.0);

        SourceMedia src;
        src.filePath = "big.mp4";
        src.hasVideo = true;
        src.fps = 30.0;
        src.duration = 60.0;
        src.totalFrames = 1800;
        src.width = 1920; src.height = 1080;
        int bigSrcId = bigTimeline.addSource(src);

        GridLayout bigLayout;
        bigLayout.columns = 4;
        bigLayout.rows = 4;

        std::vector<VideoEvent> bigEvents;
        int bigTrackIds[16];
        for (int i = 0; i < 16; ++i) {
            TrackInfo t;
            t.name = "T" + std::to_string(i);
            t.type = TrackInfo::Type::Pattern;
            bigTrackIds[i] = bigTimeline.addTrack(t);

            int col = (i % 4) * kGridSubUnitsPerColumn;
            int row = (i / 4) * kGridSubUnitsPerRow;
            bigLayout.slots.push_back({bigTrackIds[i], col, row,
                                       kGridSubUnitsPerColumn, kGridSubUnitsPerRow,
                                       1.0f, i});

            // ALL point to same source at same time → all should dedup to 1 frame
            bigEvents.push_back(makeEvent(bigTrackIds[i], bigSrcId, 0.0, 4.0, 5.0, 1.0f, i));
        }

        bigTimeline.setGridLayout(bigLayout);

        FrameCollector collector;
        AVRational fps = {30, 1};
        auto requests = collector.collectRequests(0, bigTimeline, 48000, fps, bigEvents);

        assert(requests.size() == 16);

        auto deduped = FrameCollector::deduplicateRequests(requests);
        std::fprintf(stderr, "[TEST:FrameCollector] 16 cells → %d unique frame(s)\n",
                     (int)deduped.size());
        assert(deduped.size() == 1);  // ALL dedup to 1

        // That 1 key should map to all 16 cells
        assert(deduped.begin()->second.size() == 16);

        std::fprintf(stderr, "[TEST:FrameCollector] Test 5: PASSED\n");
    }

    // ── Test 6: no active events → empty requests ───────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:FrameCollector] --- Test 6: no events ---\n");

        std::vector<VideoEvent> emptyEvents;
        FrameCollector collector;
        AVRational fps = {30, 1};
        auto requests = collector.collectRequests(0, timeline, 48000, fps, emptyEvents);

        std::fprintf(stderr, "[TEST:FrameCollector] requests with no events: %d (expected 0)\n",
                     (int)requests.size());
        assert(requests.size() == 0);

        std::fprintf(stderr, "[TEST:FrameCollector] Test 6: PASSED\n");
    }

    std::fprintf(stderr, "\n[TEST:FrameCollector] ALL TESTS PASSED\n");
    return 0;
}
