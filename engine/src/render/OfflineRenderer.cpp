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
#include "export/FFmpegMuxer.h"
#include "SyncManager.h"          // VideoEvent
#include "render/ArpVideoExpander.h"

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

std::vector<VideoEvent> OfflineRenderer::buildVideoEvents(const Timeline& timeline)
{
    std::vector<VideoEvent> events;
    const double bpm = timeline.getBPM();

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
        // regionOffset: how many beats into the source to start playback
        ev.sourceStartTime = clip->regionOffset.toBeats() * (60.0 / bpm) + region->startTime;
        ev.sourceEndTime   = region->endTime;
        ev.layerIndex      = 0;  // not used in grid compositor path
        ev.x               = track->videoX;
        ev.y               = track->videoY;
        ev.width           = track->videoW;
        ev.height          = track->videoH;
        ev.opacity         = track->videoOpacity * clip->velocity;
        ev.globalNoteIndex = noteCounterPerTrack_clip++;

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

            std::vector<const PatternNote*> notesPtrs;
            notesPtrs.reserve(pattern->notes.size());
            for (const auto& n : pattern->notes) notesPtrs.push_back(&n);
            std::sort(notesPtrs.begin(), notesPtrs.end(),
                [](const PatternNote* a, const PatternNote* b) {
                    return a->position.ticks < b->position.ticks;
                });

            auto arpEvts = ArpVideoExpander::expandArpVideoEvents(
                notesPtrs, bpTicks, bdTicks,
                pattern->length.ticks, block->loopEnabled,
                firstL, lastL, wStart, wEnd,
                region->arpTempoSync, region->arpDivision,
                region->arpFreeTimeMs, region->arpGate,
                region->arpRange, region->arpDirection,
                bpm, region->sourceId, block->trackId,
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
            for (const auto& note : pattern->notes) {
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

                    VideoEvent ev;
                    ev.startBeat       = blockStartBeats + evStartInBlock;
                    ev.durationBeats   = evDur;
                    ev.sourceId        = region->sourceId;
                    ev.trackId         = block->trackId;
                    ev.sourceStartTime = region->startTime;
                    ev.sourceEndTime   = region->endTime;
                    ev.layerIndex      = 0;
                    ev.x               = track->videoX;
                    ev.y               = track->videoY;
                    ev.width           = track->videoW;
                    ev.height          = track->videoH;
                    ev.opacity         = track->videoOpacity * note.velocity;
                    ev.globalNoteIndex = noteCounterPerTrack_pat++;

                    events.push_back(ev);

                    if (!block->loopEnabled) break;
                    loopOffset += patLenBeats;
                }
            }
        }
    }

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
    const int64_t prerollSamples = 0;  // No PDC in direct MixEngine drive
    const int64_t renderStart = startSample;
    std::fprintf(stderr, "[Renderer] PRE-ROLL: %lld samples to discard\n",
                 (long long)prerollSamples);
    std::fprintf(stderr, "[Renderer] PRE-ROLL complete. Rendering starts at sample %lld\n",
                 (long long)renderStart);

    // ── Build video events from timeline ─────────────────────────────────
    auto videoEvents = buildVideoEvents(timeline_);

    // ── Initialize pipeline components ───────────────────────────────────
    // Use fragmented MP4 for crash safety — remux to standard at the end
    ExportSettings muxSettings = settings;
    std::string fragPath = settings.outputPath + ".frag.mp4";
    muxSettings.outputPath = fragPath;
    muxSettings.fragmentedMP4 = true;

    FFmpegMuxer muxer;
    if (!muxer.init(muxSettings)) {
        progress_.setError("Failed to initialize FFmpeg muxer");
        progress_.failed.store(true);
        mixer_.setNonRealtime(false);
        progress_.phase.store(0);
        return;
    }

    // Frame cache + collector (no GPU thread binding needed for offline)
    RenderFrameCache cache;
    FrameCollector collector;

    // Video decoder
    RenderVideoDecoder decoder;
    auto* device = gpu_.getDevice();
    auto* devCtx = gpu_.getContext();
    if (device && devCtx) {
        decoder.initHwDevice(device, devCtx);
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

    std::fprintf(stderr, "[Renderer] START: samples %lld → %lld (%.2fs), latency=%lld, preroll=%lld → %lld\n",
                 (long long)startSample, (long long)endSample,
                 static_cast<double>(totalSamples) / sampleRate,
                 (long long)prerollSamples,
                 (long long)(renderStart - prerollSamples), (long long)renderStart);

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
    int64_t lastVideoFrame = -1;
    int     iterationCount = 0;

    const auto renderStartTime = std::chrono::steady_clock::now();
    const GridLayout& grid = timeline_.getGridLayout();

    while (currentSample < endSample) {
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
            std::min(static_cast<int64_t>(kBufferSize), endSample - currentSample));

        // ── Process audio ────────────────────────────────────────────────
        if (audioBuffer.getNumSamples() != thisBufferSize)
            audioBuffer.setSize(2, thisBufferSize, false, false, true);
        audioBuffer.clear();

        mixer_.processBlock(audioBuffer, thisBufferSize, transport);

        // ── Write audio to muxer ─────────────────────────────────────────
        const float* audioChannels[2] = {
            audioBuffer.getReadPointer(0),
            audioBuffer.getReadPointer(1)
        };
        if (!muxer.writeAudio(audioChannels, thisBufferSize, audioSamplesWritten)) {
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
        auto [firstFrame, lastFrame] = RenderClock::frameBoundsForBuffer(
            audioSamplesWritten, thisBufferSize, sampleRate, fps);

        if (firstFrame <= lastFrame) {
            // Log every 30th frame
            if (iterationCount % 30 == 0) {
                std::fprintf(stderr, "[Renderer] Emit video frames %lld–%lld "
                             "for audio buffer at sample %lld\n",
                             (long long)firstFrame, (long long)lastFrame,
                             (long long)audioSamplesWritten);
            }

            for (int64_t f = firstFrame; f <= lastFrame; ++f) {
                // Collect what each grid cell needs for this output frame
                auto requests = collector.collectRequests(
                    f, timeline_, sampleRate, fps, videoEvents);

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
                    compositor.compositeFrame(requests, cache,
                                              grid.columns, grid.rows);

                    // Readback composited pixels from GPU
                    auto readback = compositor.readback();
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
                    }
                }

                progress_.currentFrame.store(f);
            }

            lastVideoFrame = lastFrame;
        }

        // ── Advance ──────────────────────────────────────────────────────
        transport.advance(thisBufferSize);
        audioSamplesWritten += thisBufferSize;
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
