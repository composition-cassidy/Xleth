#include "render/OfflineRenderer.h"

#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "Transport.h"
#include "audio/MixEngine.h"
#include "render/GpuDeviceManager.h"
#include "render/RenderClock.h"
#include "render/FrameCache.h"
#include "render/FrameCollector.h"
#include "render/RenderVideoDecoder.h"
#include "render/GridCompositor.h"
#include "render/AnimationManager.h"
#include "export/FFmpegMuxer.h"
#include "SyncManager.h"          // VideoEvent
#include "render/ArpVideoExpander.h"
#include "render/VideoFlipApplier.h"  // single resolver call site

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
}

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <vector>

// Buffer size: 512 samples = ~10.67ms at 48kHz. Fixed for consistent
// automation resolution and predictable video frame boundaries.
static constexpr int kBufferSize = 512;

namespace {

struct PatternNoteRef {
    const PatternNote* note = nullptr;
    int sourceOrder = 0;
};

bool patternNoteRefLess(const PatternNoteRef& a, const PatternNoteRef& b) {
    if (a.note->position.ticks != b.note->position.ticks)
        return a.note->position.ticks < b.note->position.ticks;

    const int orderA = a.note->id > 0 ? a.note->id : a.sourceOrder;
    const int orderB = b.note->id > 0 ? b.note->id : b.sourceOrder;
    if (orderA != orderB) return orderA < orderB;

    if (a.note->pitch != b.note->pitch) return a.note->pitch < b.note->pitch;
    return a.sourceOrder < b.sourceOrder;
}

std::vector<PatternNoteRef> sortedPatternNoteRefs(const Pattern& pattern) {
    std::vector<PatternNoteRef> refs;
    refs.reserve(pattern.notes.size());
    for (int i = 0; i < static_cast<int>(pattern.notes.size()); ++i)
        refs.push_back({&pattern.notes[static_cast<std::size_t>(i)], i});
    std::sort(refs.begin(), refs.end(), patternNoteRefLess);
    return refs;
}

int sourceOrderFor(const PatternNote& note, int fallbackOrder) {
    return note.id > 0 ? note.id : fallbackOrder;
}

} // namespace

// ===========================================================================
// Constructor / Destructor
// ===========================================================================

OfflineRenderer::OfflineRenderer(const Timeline& timeline,
                                 MixEngine& mixer,
                                 GpuDeviceManager& gpu)
    : timeline_(timeline)
    , mixer_(mixer)
    , gpu_(gpu)
{
}

OfflineRenderer::~OfflineRenderer()
{
    // Request cancel and wait for thread to finish
    progress_.cancelRequested.store(true);
    if (renderThread_ && renderThread_->joinable())
        renderThread_->join();
}

// ===========================================================================
// startRender — spawn the background render thread
// ===========================================================================

bool OfflineRenderer::startRender(int64_t startSample, int64_t endSample,
                                  const ExportSettings& settings)
{
    if (running_.load()) {
        std::fprintf(stderr, "[Renderer] ERROR: render already in progress\n");
        return false;
    }

    // Join any prior thread
    if (renderThread_ && renderThread_->joinable())
        renderThread_->join();

    // Reset progress
    progress_.percentage.store(0.0f);
    progress_.currentFrame.store(0);
    progress_.totalFrames.store(0);
    progress_.speedMultiplier.store(0.0f);
    progress_.etaSeconds.store(0.0f);
    progress_.phase.store(0);
    progress_.cancelRequested.store(false);
    progress_.complete.store(false);
    progress_.failed.store(false);
    progress_.setError("");

    running_.store(true);

    // Capture settings by value for the thread
    renderThread_ = std::make_unique<std::thread>(
        [this, startSample, endSample, settings]() {
            render(startSample, endSample, settings);
            running_.store(false);
        });

    return true;
}

// ===========================================================================
// requestCancel
// ===========================================================================

void OfflineRenderer::requestCancel()
{
    progress_.cancelRequested.store(true);
}

// ===========================================================================
// buildVideoEvents — convert timeline clips+patterns into VideoEvent list
// ===========================================================================

std::vector<VideoEvent> OfflineRenderer::buildVideoEvents(
    const Timeline& timeline,
    std::vector<SlideAnimationEvent>* outSlideEvents,
    double eventSampleRate)
{
    std::vector<VideoEvent> events;
    if (outSlideEvents) outSlideEvents->clear();
    const double bpm = timeline.getBPM();
    const double sampleRate = eventSampleRate > 0.0
        ? eventSampleRate
        : timeline.getSampleRate();

    // ── Clip tracks: each clip → one VideoEvent ──────────────────────────
    int noteCounterPerTrack_clip = 0;
    int lastTrackId_clip = -1;

    // Sort clips by track, then position, for stable globalNoteIndex
    auto allClips = timeline.getAllClips();
    std::sort(allClips.begin(), allClips.end(),
        [](const Clip* a, const Clip* b) {
            if (a->trackId != b->trackId) return a->trackId < b->trackId;
            return a->position < b->position;
        });

    for (const Clip* clip : allClips) {
        if (!clip) continue;

        const TrackInfo* track = timeline.getTrack(clip->trackId);
        if (!track) continue;

        // Find the region to get sourceId
        const SampleRegion* region = timeline.getRegion(clip->regionId);
        if (!region) continue;

        const SourceMedia* source = timeline.getSource(region->sourceId);
        if (!source || !source->hasVideo) continue;

        // Track-level note counter for flip mode cycling
        if (clip->trackId != lastTrackId_clip) {
            noteCounterPerTrack_clip = 0;
            lastTrackId_clip = clip->trackId;
        }

        VideoEvent ev;
        ev.startBeat      = clip->position.toBeats();
        ev.durationBeats   = clip->duration.toBeats();
        ev.sourceId        = region->sourceId;
        ev.trackId         = clip->trackId;
        ev.regionId        = clip->regionId;
        // regionOffset: how many beats into the source to start playback
        ev.sourceStartTime = clip->regionOffset.toBeats() * (60.0 / bpm) + region->startTime;
        ev.sourceEndTime   = region->endTime;
        ev.sourceClampStartTime = region->startTime;
        ev.clipId          = clip->id;
        ev.hasClipModulation = clip->modulation.enabled
            && (clip->modulation.vibrato.enabled || clip->modulation.scratch.enabled);
        ev.modulation = clip->modulation;
        ev.clipReversed = clip->reversed;
        ev.clipStretchRatio = clip->stretchRatio;
        ev.clipFormantPreserve = clip->formantPreserve;
        ev.clipPitchOffsetSemis = clip->pitchOffset;
        ev.clipPitchOffsetCents = clip->pitchOffsetCents;
        ev.clipStartTimelineSamples = static_cast<int64_t>(
            std::llround(ev.startBeat * 60.0 / bpm * sampleRate));
        ev.layerIndex      = 0;  // not used in grid compositor path
        ev.x               = track->videoX;
        ev.y               = track->videoY;
        ev.width           = track->videoW;
        ev.height          = track->videoH;
        ev.opacity         = track->videoOpacity * clip->velocity;
        const int clipEmissionOrder = noteCounterPerTrack_clip++;
        ev.globalNoteIndex = clipEmissionOrder;
        ev.hasSourceTriggerOrder = true;
        ev.sourceTriggerOrder = clip->id > 0 ? clip->id : clipEmissionOrder;
        ev.originalEmissionOrder = clipEmissionOrder;
        // Flip-v2: pitch identifier consumed by the resolver. Spec §1: clip
        // tracks use the clip's pitch-shift value (semitones from source).
        ev.pitch = clip->pitchOffset;

        events.push_back(ev);
    }

    // ── Pattern tracks: each note onset → one VideoEvent ─────────────────
    auto allBlocks = timeline.getAllPatternBlocks();
    std::sort(allBlocks.begin(), allBlocks.end(),
        [](const PatternBlock* a, const PatternBlock* b) {
            if (a->trackId != b->trackId) return a->trackId < b->trackId;
            return a->position < b->position;
        });

    int lastTrackId_pat = -1;
    int noteCounterPerTrack_pat = 0;

    for (const PatternBlock* block : allBlocks) {
        if (!block) continue;

        const Pattern* pattern = timeline.getPattern(block->patternId);
        if (!pattern) continue;

        const SampleRegion* region = timeline.getRegion(pattern->regionId);
        if (!region) continue;

        const SourceMedia* source = timeline.getSource(region->sourceId);
        if (!source || !source->hasVideo) continue;

        const TrackInfo* track = timeline.getTrack(block->trackId);
        if (!track) continue;

        if (block->trackId != lastTrackId_pat) {
            noteCounterPerTrack_pat = 0;
            lastTrackId_pat = block->trackId;
        }

        const double blockStartBeats = block->position.toBeats();
        const double blockDurBeats   = block->duration.toBeats();
        const double patLenBeats     = pattern->length.toBeats();
        if (patLenBeats <= 0.0) continue;

        if (region->arpEnabled) {
            // ── Arp expansion: simulate arpeggiator in beat-space ────────
            const int64_t bpTicks = block->position.ticks;
            const int64_t bdTicks = block->duration.ticks;
            const int64_t boTicks = block->offset.ticks;
            const int64_t wStart  = boTicks;
            const int64_t wEnd    = boTicks + bdTicks;
            const int64_t firstL  = wStart / pattern->length.ticks;
            int64_t       lastL   = (wEnd - 1) / pattern->length.ticks;
            if (!block->loopEnabled)
                lastL = std::min<int64_t>(lastL, 0);

            const auto noteRefs = sortedPatternNoteRefs(*pattern);
            std::vector<const PatternNote*> notesPtrs;
            notesPtrs.reserve(noteRefs.size());
            for (const auto& ref : noteRefs) notesPtrs.push_back(ref.note);

            auto arpEvts = ArpVideoExpander::expandArpVideoEvents(
                notesPtrs, bpTicks, bdTicks,
                pattern->length.ticks, block->loopEnabled,
                firstL, lastL, wStart, wEnd,
                region->arpTempoSync, region->arpDivision,
                region->arpFreeTimeMs, region->arpGate,
                region->arpRange, region->arpDirection,
                bpm, region->sourceId, block->trackId,
                pattern->regionId,
                region->startTime, region->endTime,
                noteCounterPerTrack_pat);

            for (auto& aev : arpEvts) {
                aev.x       = track->videoX;
                aev.y       = track->videoY;
                aev.width   = track->videoW;
                aev.height  = track->videoH;
                aev.opacity *= track->videoOpacity;
            }
            events.insert(events.end(), arpEvts.begin(), arpEvts.end());
        } else {
            // ── Standard per-note emission (unchanged) ───────────────────
            const auto noteRefs = sortedPatternNoteRefs(*pattern);
            for (const auto& noteRef : noteRefs) {
                const PatternNote& note = *noteRef.note;
                const double noteOffsetBeats = note.position.toBeats() - block->offset.toBeats();
                const double noteDurBeats    = note.duration.toBeats();

                // Handle looping: emit events for each loop iteration
                double loopOffset = 0.0;
                while (true) {
                    double evStartInBlock = noteOffsetBeats + loopOffset;
                    if (evStartInBlock >= blockDurBeats) break;
                    if (evStartInBlock < 0.0) {
                        loopOffset += patLenBeats;
                        continue;
                    }

                    double evDur = std::min(noteDurBeats, blockDurBeats - evStartInBlock);
                    if (evDur <= 0.0) { loopOffset += patLenBeats; continue; }

                    // Slide notes don't emit a VideoEvent — they fire a
                    // per-track visual effect on the existing cell.
                    if (note.isSlide) {
                        if (outSlideEvents) {
                            SlideAnimationEvent se;
                            se.startBeat     = blockStartBeats + evStartInBlock;
                            se.durationBeats = evDur;
                            se.trackId       = block->trackId;
                            se.slideVelocity = note.velocity;
                            se.slideCurveCx  = note.slideCurveCx;
                            se.slideCurveCy  = note.slideCurveCy;
                            outSlideEvents->push_back(se);
                        }
                        if (!block->loopEnabled) break;
                        loopOffset += patLenBeats;
                        continue;
                    }

                    VideoEvent ev;
                    ev.startBeat       = blockStartBeats + evStartInBlock;
                    ev.durationBeats   = evDur;
                    ev.sourceId        = region->sourceId;
                    ev.trackId         = block->trackId;
                    ev.regionId        = pattern->regionId;
                    ev.sourceStartTime = region->startTime;
                    ev.sourceEndTime   = region->endTime;
                    ev.sourceClampStartTime = region->startTime;
                    ev.layerIndex      = 0;
                    ev.x               = track->videoX;
                    ev.y               = track->videoY;
                    ev.width           = track->videoW;
                    ev.height          = track->videoH;
                    ev.opacity         = track->videoOpacity * note.velocity;
                    const int noteEmissionOrder = noteCounterPerTrack_pat++;
                    ev.globalNoteIndex = noteEmissionOrder;
                    ev.hasSourceTriggerOrder = true;
                    ev.sourceTriggerOrder = sourceOrderFor(note, noteRef.sourceOrder);
                    ev.originalEmissionOrder = noteEmissionOrder;
                    ev.pitch           = note.pitch;  // flip-v2 resolver input

                    events.push_back(ev);

                    if (!block->loopEnabled) break;
                    loopOffset += patLenBeats;
                }
            }
        }
    }

    // ── Flip-v2 resolution (single call site for all event-build paths) ──
    // Per-track chord detection + pure resolver + write-back of
    // monoOrdinal / stateIndex / orientation. No-op for tracks with
    // VideoFlipConfig.enabled = false.
    videoFlipApplier::applyAll(events, timeline);

    std::fprintf(stderr, "[Renderer] Built %d video events from timeline\n",
                 static_cast<int>(events.size()));
    return events;
}

// ===========================================================================
// render — the main offline render loop (runs on dedicated thread)
// ===========================================================================

void OfflineRenderer::render(int64_t startSample, int64_t endSample,
                              const ExportSettings& settings)
{
    try {
        renderImpl(startSample, endSample, settings);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "[Renderer] ERROR: %s\n", e.what());
        progress_.setError(e.what());
        progress_.failed.store(true);
        mixer_.setNonRealtime(false);
        progress_.phase.store(0);
    } catch (...) {
        std::fprintf(stderr, "[Renderer] ERROR: unknown exception\n");
        progress_.setError("Unknown exception during render");
        progress_.failed.store(true);
        mixer_.setNonRealtime(false);
        progress_.phase.store(0);
    }
}

// ===========================================================================
// renderImpl — actual render logic (called from render() with try/catch)
// ===========================================================================

void OfflineRenderer::renderImpl(int64_t startSample, int64_t endSample,
                                  const ExportSettings& settings)
{
    const int sampleRate = settings.sampleRate;
    const AVRational fps = { settings.fpsNum, settings.fpsDen };
    const double bpm = timeline_.getBPM();

    const bool isRegion = (startSample > 0);
    std::fprintf(stderr, "[Renderer] Region mode: %s\n",
                 isRegion ? "region" : "full timeline");
    if (isRegion) {
        std::fprintf(stderr, "[Renderer] Region: %lld → %lld\n",
                     (long long)startSample, (long long)endSample);
    }

    const int64_t totalSamples = endSample - startSample;
    const int64_t totalVideoFrames = RenderClock::sampleToVideoFrame(
        totalSamples, sampleRate, fps);
    progress_.totalFrames.store(totalVideoFrames);

    // ── PHASE 1: PRE-ROLL ────────────────────────────────────────────────
    progress_.phase.store(1);

    // Prepare MixEngine with the export sample rate
    mixer_.setNonRealtime(true);
    mixer_.prepare(static_cast<double>(sampleRate), kBufferSize);
    std::fprintf(stderr, "[Renderer] prepareToPlay(sampleRate=%d, bufferSize=%d) done, nonRealtime=1\n",
                 sampleRate, kBufferSize);

    // Pre-roll: skip latency compensation samples (no latency in offline mode
    // since we're not using the JUCE AudioProcessorGraph's realtime path).
    // The MixEngine is driven directly — no graph latency to compensate.
    const auto latencySnapshot = mixer_.getLatencyCompensationSnapshot();
    const int64_t totalPrerollSamples =
        static_cast<int64_t>(latencySnapshot.maxAudibleTrackLatencySamples)
        + static_cast<int64_t>(latencySnapshot.masterInsertLatencySamples);
    const int64_t historyPreroll = std::min(startSample, totalPrerollSamples);
    const int64_t renderStart = startSample - historyPreroll;
    const int64_t totalDiscard = historyPreroll + totalPrerollSamples;
    const int64_t renderSamplesNeeded = totalSamples + totalDiscard;
    const int64_t renderEnd = renderStart + renderSamplesNeeded;
    std::fprintf(stderr,
                 "[Renderer] PRE-ROLL: track=%d master=%d history=%lld discard=%lld start=%lld renderStart=%lld renderEnd=%lld\n",
                 latencySnapshot.maxAudibleTrackLatencySamples,
                 latencySnapshot.masterInsertLatencySamples,
                 (long long)historyPreroll,
                 (long long)totalDiscard,
                 (long long)startSample,
                 (long long)renderStart,
                 (long long)renderEnd);

    // ── Build video events from timeline ─────────────────────────────────
    std::vector<SlideAnimationEvent> slideEvents;
    auto videoEvents = buildVideoEvents(timeline_, &slideEvents, sampleRate);

    // ── Initialize pipeline components ───────────────────────────────────
    // Use fragmented MP4 for crash safety — remux to standard at the end
    ExportSettings muxSettings = settings;
    std::string fragPath = settings.outputPath + ".frag.mp4";
    muxSettings.outputPath = fragPath;
    muxSettings.fragmentedMP4 = true;

    // GPU device references are declared early so failure-path [VideoMode] logs can use them.
    auto* device = gpu_.getDevice();
    auto* devCtx = gpu_.getContext();

    using VM = ExportSettings::VideoMode;
    auto videoModeStr = [&]() -> const char* {
        switch (settings.videoMode) {
            case VM::Hardware: return "hardware";
            case VM::Software: return "software";
            default:           return "auto";
        }
    };

    FFmpegMuxer muxer;
    if (!muxer.init(muxSettings)) {
        // At this point the decoder has not been attempted yet; report what decode
        // would have been based on GPU availability.
        const char* wouldBeDec = (settings.videoMode != VM::Software && device && devCtx)
                                 ? "d3d11va" : "software";
        const char* reason = (settings.videoMode == VM::Hardware)
                             ? "hardware_encoder_unavailable" : "encoder_init_failed";
        std::fprintf(stderr,
            "[VideoMode] requested=%s decode=%s encode=none reason=%s\n",
            videoModeStr(), wouldBeDec, reason);

        progress_.setError(
            settings.videoMode == VM::Hardware
            ? "Hardware video mode selected, but no compatible hardware encoder could be "
              "opened. Switch Video mode to Auto or Software in Settings."
            : "Failed to initialize video encoder");
        progress_.failed.store(true);
        mixer_.setNonRealtime(false);
        progress_.phase.store(0);
        return;
    }
    // Surface encoder name and fallback flag to the UI
    progress_.setVideoEncoderName(muxer.videoEncoderName());
    progress_.videoEncoderFallback.store(muxer.isVideoEncoderFallback());

    // Frame cache + collector (no GPU thread binding needed for offline)
    RenderFrameCache cache;
    FrameCollector collector;
    AnimationManager animMgr;
    collector.setAnimationManager(&animMgr);
    collector.setCompanionFxEnabled(true);

    // Diagnostic counters for AMD/NVIDIA divergence: track frames where the GL
    // compositor produced no readback. A non-zero count means the export is
    // degraded — typically a sign of a GL upload/composite failure.
    int64_t videoFramesAttempted = 0;
    int64_t invalidReadbackCount = 0;

    // Video decoder — init path depends on VideoMode preference
    RenderVideoDecoder decoder;

    if (settings.videoMode == VM::Software) {
        // Intentionally skip initHwDevice — software decode/encode unconditionally.
        // Display compositing still uses OpenGL; this disables only HW video codecs.
    } else if (settings.videoMode == VM::Hardware) {
        if (!device || !devCtx || !decoder.initHwDevice(device, devCtx)) {
            // Encoder succeeded (muxer passed), but D3D11VA decode is unavailable.
            std::fprintf(stderr,
                "[VideoMode] requested=hardware decode=unavailable encode=%s reason=hardware_decode_init_failed\n",
                muxer.videoEncoderName());
            progress_.setError(
                "Hardware video mode selected, but D3D11VA hardware decode could not be "
                "initialized. Switch Video mode to Auto or Software in Settings.");
            progress_.failed.store(true);
            muxer.finalize();
            std::filesystem::remove(fragPath);
            mixer_.setNonRealtime(false);
            progress_.phase.store(0);
            return;
        }
    } else {  // Auto
        if (device && devCtx) {
            decoder.initHwDevice(device, devCtx);
        }
    }

    // [VideoMode] diagnostic log — resolved decode/encode path for this export
    {
        const char* decMode = decoder.hasHwAccel() ? "d3d11va" : "software";
        const char* encMode = muxer.videoEncoderName();
        const char* reason  = (settings.videoMode == VM::Hardware) ? "forced_hardware"
                            : (settings.videoMode == VM::Software) ? "user_setting"
                            : muxer.isVideoEncoderFallback()       ? "auto_fallback_no_hw_encoder"
                                                                    : "auto_detected";
        std::fprintf(stderr, "[VideoMode] requested=%s decode=%s encode=%s reason=%s\n",
                     videoModeStr(), decMode, encMode, reason);
    }

    // GPU compositor
    GridCompositor compositor;
    if (device && devCtx) {
        if (!compositor.init(device, devCtx, settings.width, settings.height)) {
            progress_.setError("Failed to initialize GPU compositor");
            progress_.failed.store(true);
            muxer.finalize();
            mixer_.setNonRealtime(false);
            progress_.phase.store(0);
            return;
        }
    }

    std::fprintf(stderr, "[Renderer] START: samples %lld → %lld (%.2fs), renderStart=%lld discard=%lld renderEnd=%lld\n",
                 (long long)startSample, (long long)endSample,
                 static_cast<double>(totalSamples) / sampleRate,
                 (long long)renderStart,
                 (long long)totalDiscard,
                 (long long)renderEnd);

    // ── PHASE 2: RENDER ──────────────────────────────────────────────────
    progress_.phase.store(2);

    // Local transport for offline rendering (independent of realtime AudioEngine)
    Transport transport;
    transport.setSampleRate(static_cast<double>(sampleRate));
    transport.setBPM(bpm);
    transport.seekToSample(renderStart);
    transport.play();

    // Allocate audio buffer ONCE — reuse across iterations
    juce::AudioBuffer<float> audioBuffer(2, kBufferSize);
    juce::MidiBuffer emptyMidi;

    int64_t currentSample = renderStart;
    int64_t audioSamplesWritten = 0;
    int64_t samplesRemainingToDiscard = totalDiscard;
    int64_t lastVideoFrame = -1;
    int     iterationCount = 0;
    double  prevBeat = -1.0;  // for slide-event beat-crossing dispatch

    const auto renderStartTime = std::chrono::steady_clock::now();
    const GridLayout& grid = timeline_.getGridLayout();

    while (currentSample < renderEnd && audioSamplesWritten < totalSamples) {
        // ── Check cancel every buffer ────────────────────────────────────
        if (progress_.cancelRequested.load()) {
            std::fprintf(stderr, "[Renderer] CANCELLED at %.1f%% (sample %lld). "
                         "Finalizing partial file...\n",
                         progress_.percentage.load(), (long long)currentSample);
            muxer.finalize();
            // Clean up frag file
            std::filesystem::remove(fragPath);
            mixer_.setNonRealtime(false);
            progress_.phase.store(0);
            return;
        }

        // Handle last partial buffer
        const int thisBufferSize = static_cast<int>(
            std::min(static_cast<int64_t>(kBufferSize), renderEnd - currentSample));

        // ── Process audio ────────────────────────────────────────────────
        if (audioBuffer.getNumSamples() != thisBufferSize)
            audioBuffer.setSize(2, thisBufferSize, false, false, true);
        audioBuffer.clear();

        mixer_.processBlock(audioBuffer, thisBufferSize, transport);

        // ── Write audio to muxer ─────────────────────────────────────────
        const int discardThisBlock = static_cast<int>(
            std::min<int64_t>(samplesRemainingToDiscard, thisBufferSize));
        samplesRemainingToDiscard -= discardThisBlock;

        int keepOffset = discardThisBlock;
        int keepSamples = thisBufferSize - discardThisBlock;
        if (keepSamples > 0)
        {
            const int64_t samplesRemainingToWrite = totalSamples - audioSamplesWritten;
            keepSamples = static_cast<int>(
                std::min<int64_t>(keepSamples, samplesRemainingToWrite));
        }

        const float* audioChannels[2] = {
            audioBuffer.getReadPointer(0) + keepOffset,
            audioBuffer.getReadPointer(1) + keepOffset
        };
        if (keepSamples > 0
            && !muxer.writeAudio(audioChannels, keepSamples, audioSamplesWritten)) {
            progress_.setError("Audio encoding failed");
            progress_.failed.store(true);
            muxer.finalize();
            std::filesystem::remove(fragPath);
            mixer_.setNonRealtime(false);
            progress_.phase.store(0);
            return;
        }

        // ── Emit video frames at audio-derived boundaries ────────────────
        // Use audioSamplesWritten (0-based relative to export start) for
        // video frame calculation, so frame 0 aligns with sample 0 of output.
        int64_t firstFrame = 1;
        int64_t lastFrame = 0;
        if (keepSamples > 0)
        {
            const auto frameBounds = RenderClock::frameBoundsForBuffer(
                audioSamplesWritten, keepSamples, sampleRate, fps);
            firstFrame = frameBounds.first;
            lastFrame = frameBounds.second;
        }

        if (keepSamples > 0 && firstFrame <= lastFrame) {
            // Log every 30th frame
            if (iterationCount % 30 == 0) {
                std::fprintf(stderr, "[Renderer] Emit video frames %lld–%lld "
                             "for audio buffer at sample %lld\n",
                             (long long)firstFrame, (long long)lastFrame,
                             (long long)audioSamplesWritten);
            }

            for (int64_t f = firstFrame; f <= lastFrame; ++f) {
                // Advance animation state before collecting
                const float frameDurationMs = 1000.0f * static_cast<float>(fps.den)
                                            / static_cast<float>(fps.num);
                animMgr.advanceAll(frameDurationMs);
                const int64_t localFrameSample = RenderClock::videoFrameToSample(
                    f, sampleRate, fps);
                const int64_t projectFrameSample = startSample + localFrameSample;

                // ── Slide-note beat-crossing dispatch ───────────────────
                // Compute current beat from the absolute project frame sample and fire
                // any SlideAnimationEvents whose startBeat falls in the
                // (prevBeat, currentBeat] window. Reset on first iteration.
                {
                    const int64_t currentPpq = RenderClock::sampleToPPQ(
                        projectFrameSample, sampleRate, bpm);
                    const double ticksPerBeat = static_cast<double>(TickTime::fromBeats(1).ticks);
                    const double currentBeat = static_cast<double>(currentPpq) / ticksPerBeat;
                    if (prevBeat < 0.0 || currentBeat + 1e-6 < prevBeat)
                        prevBeat = currentBeat - 1e-6;
                    for (const auto& se : slideEvents) {
                        if (se.startBeat > prevBeat && se.startBeat <= currentBeat) {
                            const TrackInfo* tr = timeline_.getTrack(se.trackId);
                            if (!tr) continue;
                            const auto& cfg = tr->slideNoteEffect;
                            if (cfg.type == SlideNoteEffectSettings::EffectType::None)
                                continue;
                            double durationMs;
                            if (cfg.durationMode
                                == SlideNoteEffectSettings::DurationMode::FollowSlide) {
                                durationMs = se.durationBeats * (60000.0 / bpm);
                            } else {
                                durationMs = cfg.fixedDurationMs;
                            }
                            animMgr.onSlideEvent(
                                se.trackId,
                                static_cast<float>(durationMs),
                                cfg,
                                se.slideCurveCx, se.slideCurveCy);
                        }
                    }
                    prevBeat = currentBeat;
                }

                // Collect what each grid cell needs for this output frame.
                // Export honors settings.useSourceMedia so the encoder gets
                // original-source pixels by default; preview keeps proxy use.
                auto requests = collector.collectRequests(
                    f, timeline_, sampleRate, fps, videoEvents,
                    /*allowProxy=*/ !settings.useSourceMedia,
                    /*projectStartSample=*/ startSample);

                // Deduplicate: multiple cells may reference the same source frame
                auto deduplicated = FrameCollector::deduplicateRequests(requests);

                // Check cache and find what needs decoding
                auto misses = FrameCollector::resolveFrames(deduplicated, cache);

                // Decode cache misses
                if (device && devCtx) {
                    for (const auto& key : misses) {
                        auto entry = decoder.decode(key.sourcePath, key.frameIndex,
                                                    device, devCtx);
                        if (entry.texture) {
                            cache.put(key, std::move(entry));
                        }
                    }
                }

                // Composite
                if (compositor.isInitialized()) {
                    // Global shader time drives visual-state evaluation, so
                    // subrange exports must sample it in absolute project time
                    // even while encoded frame numbers stay local from zero.
                    const float currentTime = static_cast<float>(
                        RenderClock::sampleToSeconds(projectFrameSample, sampleRate));
                    compositor.compositeFrame(requests, cache,
                                              grid.columns, grid.rows,
                                              currentTime, grid.gapScale);

                    // Readback composited pixels from GPU
                    auto readback = compositor.readback();
                    ++videoFramesAttempted;
                    if (readback.valid) {
                        if (!muxer.writeVideo(readback.pixels.data(),
                                              readback.stride, f)) {
                            progress_.setError("Video encoding failed at frame "
                                             + std::to_string(f));
                            progress_.failed.store(true);
                            muxer.finalize();
                            std::filesystem::remove(fragPath);
                            mixer_.setNonRealtime(false);
                            progress_.phase.store(0);
                            return;
                        }
                    } else {
                        ++invalidReadbackCount;
                        if (invalidReadbackCount <= 5 || (invalidReadbackCount % 100) == 0) {
                            std::fprintf(stderr,
                                         "[Renderer] Compositor readback invalid at frame %lld "
                                         "(total invalid=%lld)\n",
                                         (long long)f, (long long)invalidReadbackCount);
                        }
                        // Early abort: if every readback so far has been invalid, the D3D11
                        // compositor is failing at the GPU/staging-texture level — fail fast
                        // rather than silently write a video file with zero frames.
                        //
                        // readback.valid==false means D3D11 staging texture Map() failed
                        // (a GPU/driver error), NOT empty/transparent content. An empty or
                        // transparent composite still produces valid black BGRA pixels, so
                        // this check cannot false-fire on empty-timeline exports.
                        constexpr int64_t kEarlyAbortThreshold = 10;
                        if (videoFramesAttempted >= kEarlyAbortThreshold &&
                            invalidReadbackCount == videoFramesAttempted) {
                            progress_.setError(
                                "Compositor readback failed for the first "
                                + std::to_string(kEarlyAbortThreshold)
                                + " video frames (D3D11 staging Map failed). "
                                "Check engine log for GPU/driver errors.");
                            progress_.failed.store(true);
                            muxer.finalize();
                            std::filesystem::remove(fragPath);
                            mixer_.setNonRealtime(false);
                            progress_.phase.store(0);
                            return;
                        }
                    }
                }

                progress_.currentFrame.store(f);
            }

            lastVideoFrame = lastFrame;
        }

        // ── Advance ──────────────────────────────────────────────────────
        transport.advance(thisBufferSize);
        audioSamplesWritten += keepSamples;
        currentSample += thisBufferSize;
        ++iterationCount;

        // ── Update progress ──────────────────────────────────────────────
        const float pct = static_cast<float>(audioSamplesWritten)
                        / static_cast<float>(totalSamples) * 100.0f;
        progress_.percentage.store(pct);

        const auto elapsed = std::chrono::steady_clock::now() - renderStartTime;
        const double elapsedSec = std::chrono::duration<double>(elapsed).count();
        if (elapsedSec > 0.01) {
            const double renderedSec = static_cast<double>(audioSamplesWritten) / sampleRate;
            const float speed = static_cast<float>(renderedSec / elapsedSec);
            progress_.speedMultiplier.store(speed);
            if (speed > 0.0f) {
                const double remainingSec = static_cast<double>(totalSamples - audioSamplesWritten) / sampleRate;
                progress_.etaSeconds.store(static_cast<float>(remainingSec / speed));
            }
        }

        // Log every 100 buffers
        if (iterationCount % 100 == 0) {
            std::fprintf(stderr, "[Renderer] PROGRESS: %.1f%% | frame %lld/%lld | "
                         "%.1fx realtime | ETA %.0fs\n",
                         pct,
                         (long long)progress_.currentFrame.load(),
                         (long long)totalVideoFrames,
                         progress_.speedMultiplier.load(),
                         progress_.etaSeconds.load());
        }
    }

    // ── PHASE 3: FINALIZE ────────────────────────────────────────────────
    progress_.phase.store(3);
    std::fprintf(stderr, "[Renderer] FINALIZING: flushing encoders...\n");

    if (videoFramesAttempted > 0) {
        const double invalidPct = 100.0 * static_cast<double>(invalidReadbackCount)
                                        / static_cast<double>(videoFramesAttempted);
        std::fprintf(stderr,
                     "[Renderer] Video frames: attempted=%lld, invalid_readback=%lld (%.1f%%)\n",
                     (long long)videoFramesAttempted,
                     (long long)invalidReadbackCount,
                     invalidPct);
        if (invalidReadbackCount > 0) {
            std::fprintf(stderr,
                         "[Renderer] WARN: export degraded — %lld of %lld frames had invalid GPU readback "
                         "(compositor produced no pixels). Check earlier log for [VideoCompositor] errors.\n",
                         (long long)invalidReadbackCount,
                         (long long)videoFramesAttempted);
        }
    }

    if (!muxer.finalize()) {
        progress_.setError("Muxer finalization failed");
        progress_.failed.store(true);
        std::filesystem::remove(fragPath);
        mixer_.setNonRealtime(false);
        progress_.phase.store(0);
        return;
    }

    // ── Remux fragmented MP4 → standard MP4 with faststart ───────────────
    if (!progress_.cancelRequested.load()) {
        std::fprintf(stderr, "[Renderer] Remuxing frag MP4 → standard MP4 with faststart...\n");

        if (!remuxToFaststart(fragPath, settings.outputPath)) {
            // Remux failed — fall back: just rename frag file as output
            std::fprintf(stderr, "[Renderer] Remux failed, using fragmented file directly\n");
            std::error_code ec;
            std::filesystem::rename(fragPath, settings.outputPath, ec);
        } else {
            // Remove the temporary fragmented file
            std::filesystem::remove(fragPath);
        }

        // Report final file info
        std::error_code ec;
        auto fileSize = std::filesystem::file_size(settings.outputPath, ec);
        if (!ec) {
            std::fprintf(stderr, "[Renderer] Remux complete. File: '%s' size=%lld bytes\n",
                         settings.outputPath.c_str(), (long long)fileSize);
        }
    } else {
        // Cancelled during finalize — clean up
        std::filesystem::remove(fragPath);
    }

    // ── Complete ─────────────────────────────────────────────────────────
    const auto totalElapsed = std::chrono::steady_clock::now() - renderStartTime;
    const double totalSec = std::chrono::duration<double>(totalElapsed).count();
    const double renderedSec = static_cast<double>(totalSamples) / sampleRate;

    std::fprintf(stderr, "[Renderer] COMPLETE: %lld frames, %.2fs rendered in %.2fs (%.1fx realtime)\n",
                 (long long)progress_.currentFrame.load(),
                 renderedSec, totalSec,
                 totalSec > 0.0 ? renderedSec / totalSec : 0.0);

    progress_.percentage.store(100.0f);
    progress_.complete.store(true);
    progress_.phase.store(0);

    // Restore realtime lock mode for the audio thread
    mixer_.setNonRealtime(false);

    // Shutdown video pipeline resources
    compositor.shutdown();
    decoder.closeAll();
    cache.clear();
}

// ===========================================================================
// remuxToFaststart — remux fragmented MP4 to standard MP4 with moov at front
// ===========================================================================

bool OfflineRenderer::remuxToFaststart(const std::string& fragPath,
                                        const std::string& outputPath)
{
    // Use FFmpeg C API to remux: open input, copy streams, write with faststart
    AVFormatContext* inCtx = nullptr;
    AVFormatContext* outCtx = nullptr;
    AVPacket* pkt = nullptr;
    bool ok = false;

    auto cleanup = [&]() {
        if (pkt) av_packet_free(&pkt);
        if (inCtx) avformat_close_input(&inCtx);
        if (outCtx) {
            if (outCtx->pb) avio_closep(&outCtx->pb);
            avformat_free_context(outCtx);
        }
    };

    // Open input
    int ret = avformat_open_input(&inCtx, fragPath.c_str(), nullptr, nullptr);
    if (ret < 0) { cleanup(); return false; }

    ret = avformat_find_stream_info(inCtx, nullptr);
    if (ret < 0) { cleanup(); return false; }

    // Allocate output
    ret = avformat_alloc_output_context2(&outCtx, nullptr, "mp4", outputPath.c_str());
    if (ret < 0 || !outCtx) { cleanup(); return false; }

    // Copy stream configurations
    for (unsigned i = 0; i < inCtx->nb_streams; ++i) {
        AVStream* inStream = inCtx->streams[i];
        AVStream* outStream = avformat_new_stream(outCtx, nullptr);
        if (!outStream) { cleanup(); return false; }
        ret = avcodec_parameters_copy(outStream->codecpar, inStream->codecpar);
        if (ret < 0) { cleanup(); return false; }
        outStream->time_base = inStream->time_base;
        outStream->codecpar->codec_tag = 0;
    }

    // Open output with faststart (movflags=+faststart)
    AVDictionary* opts = nullptr;
    av_dict_set(&opts, "movflags", "+faststart", 0);

    ret = avio_open(&outCtx->pb, outputPath.c_str(), AVIO_FLAG_WRITE);
    if (ret < 0) { av_dict_free(&opts); cleanup(); return false; }

    ret = avformat_write_header(outCtx, &opts);
    av_dict_free(&opts);
    if (ret < 0) { cleanup(); return false; }

    // Copy packets
    pkt = av_packet_alloc();
    if (!pkt) { cleanup(); return false; }

    while (av_read_frame(inCtx, pkt) >= 0) {
        AVStream* inStream  = inCtx->streams[pkt->stream_index];
        AVStream* outStream = outCtx->streams[pkt->stream_index];

        av_packet_rescale_ts(pkt, inStream->time_base, outStream->time_base);
        pkt->pos = -1;

        ret = av_interleaved_write_frame(outCtx, pkt);
        av_packet_unref(pkt);
        if (ret < 0) { cleanup(); return false; }
    }

    ret = av_write_trailer(outCtx);
    ok = (ret >= 0);

    cleanup();
    return ok;
}
