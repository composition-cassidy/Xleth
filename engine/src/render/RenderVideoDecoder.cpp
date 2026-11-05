#include "RenderVideoDecoder.h"

#include "FrameRateMath.h"
#include "XlethDebug.h"
#include "../video/SwsDestBuffer.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <thread>

// ===========================================================================
// DecoderContext
// ===========================================================================

void DecoderContext::close()
{
    if (swsCtx)    { sws_freeContext(swsCtx);          swsCtx    = nullptr; }
    bgraScratch.clear();
    bgraScratch.shrink_to_fit();
    if (frame)           { av_frame_free(&frame);                           }
    if (hwTransferFrame) { av_frame_free(&hwTransferFrame);                 }
    if (packet)          { av_packet_free(&packet);                         }
    if (codecCtx)        { avcodec_free_context(&codecCtx);                }
    if (formatCtx)       { avformat_close_input(&formatCtx);               }

    videoStreamIdx   = -1;
    width            = 0;
    height           = 0;
    frameRate        = AVRational{30, 1};
    lastDecodedFrame = -1;
    sequentialHint   = false;
    isIntraOnly      = false;
    isHwAccel        = false;
    framesDecodedThisCall = 0;
    sourcePath.clear();
}

// ===========================================================================
// Software decode threading
// ===========================================================================

int RenderVideoDecoder::defaultDecodeThreads()
{
    const int hw = static_cast<int>(std::thread::hardware_concurrency());
    return std::clamp(hw / 2, 1, kMaxDecodeThreads);
}

// Applied right before avcodec_open2 on the SOFTWARE path only. Frame
// threading pipelines whole frames across workers (the win for long-GOP
// H.264), slice threading splits one frame (the win for DNxHR/ProRes, which
// are sliced); FFmpeg picks whichever the codec supports. The pipeline fill
// after a seek costs at most (threads - 1) extra packets, which is noise
// next to the GOP re-decode the seek already pays. Left alone for D3D11VA:
// the hw path decodes on the GPU's video engine and gains nothing here.
static void configureSoftwareDecodeThreads(AVCodecContext* codecCtx, int threads)
{
    if (!codecCtx || threads <= 1) return;
    codecCtx->thread_count = threads;
    codecCtx->thread_type  = FF_THREAD_FRAME | FF_THREAD_SLICE;
}

// ===========================================================================
// RenderVideoDecoder — lifecycle
// ===========================================================================

RenderVideoDecoder::RenderVideoDecoder() = default;

RenderVideoDecoder::~RenderVideoDecoder()
{
    shutdown();
}

void RenderVideoDecoder::shutdown()
{
    closeAll();
    if (hwDeviceCtx_) {
        av_buffer_unref(&hwDeviceCtx_);
    }
}

void RenderVideoDecoder::closeAll()
{
    for (auto& [path, entry] : contexts_) {
        entry.ctx.close();
    }
    contexts_.clear();
    lruOrder_.clear();
}

bool RenderVideoDecoder::closeKey(const std::string& key)
{
    auto it = contexts_.find(key);
    if (it == contexts_.end()) return false;

    it->second.ctx.close();
    lruOrder_.erase(it->second.lruIt);
    contexts_.erase(it);
    return true;
}

bool RenderVideoDecoder::closeSource(const std::string& sourcePath)
{
    // Every stream of the file — a caller closing a path is about to delete or
    // overwrite it, and any one handle left open makes that fail on Windows.
    bool closed = false;
    for (int i = 0; i < kMaxStreamsPerSource; ++i)
        closed = closeKey(streamKey(sourcePath, i)) || closed;
    return closed;
}

// ===========================================================================
// D3D11VA hardware device context
// ===========================================================================

bool RenderVideoDecoder::initHwDevice(ID3D11Device* device, ID3D11DeviceContext* deviceCtx)
{
    if (!device || !deviceCtx) {
        std::fprintf(stderr, "[RenderDecoder] initHwDevice: null device/context\n");
        return false;
    }

    // Allocate AVHWDeviceContext for D3D11VA
    hwDeviceCtx_ = av_hwdevice_ctx_alloc(AV_HWDEVICE_TYPE_D3D11VA);
    if (!hwDeviceCtx_) {
        std::fprintf(stderr, "[RenderDecoder] Failed to allocate D3D11VA device context\n");
        return false;
    }

    auto* hwctx = reinterpret_cast<AVHWDeviceContext*>(hwDeviceCtx_->data);
    auto* d3d11Ctx = reinterpret_cast<AVD3D11VADeviceContext*>(hwctx->hwctx);

    // Share our existing D3D11 device. FFmpeg's d3d11va_device_uninit calls
    // Release() on both pointers, but d3d11va_device_init does NOT AddRef.
    // We must AddRef here so the GpuDeviceManager's ComPtr isn't invalidated
    // when FFmpeg's hw context is freed.
    device->AddRef();
    deviceCtx->AddRef();
    d3d11Ctx->device         = device;
    d3d11Ctx->device_context = deviceCtx;

    int ret = av_hwdevice_ctx_init(hwDeviceCtx_);
    if (ret < 0) {
        char errBuf[AV_ERROR_MAX_STRING_SIZE];
        av_strerror(ret, errBuf, sizeof(errBuf));
        std::fprintf(stderr, "[RenderDecoder] Failed to init D3D11VA device context: %s\n", errBuf);
        av_buffer_unref(&hwDeviceCtx_);
        return false;
    }

    std::fprintf(stderr, "[RenderDecoder] D3D11VA hardware device context initialized\n");
    return true;
}

// ===========================================================================
// Context pool — LRU management
// ===========================================================================

std::string RenderVideoDecoder::streamKey(const std::string& sourcePath, int streamIndex)
{
    // Stream 0 is keyed by the bare path so path lookups keep finding it.
    if (streamIndex == 0) return sourcePath;
    return sourcePath + "\x1f#" + std::to_string(streamIndex);
}

RenderVideoDecoder::ContextEntry*
RenderVideoDecoder::openStreamAt(const std::string& key, const std::string& sourcePath,
                                 int streamIndex)
{
    // Evict if at capacity. key (about to be opened below) cannot itself be
    // picked here: it isn't inserted into contexts_/lruOrder_ until after this
    // loop, so evictLruContext() only ever sees OTHER, already-open contexts.
    while (static_cast<int>(contexts_.size()) >= contextBudget_) {
        if (!evictLruContext()) break;   // nothing left that's safe to evict
    }

    ContextEntry entry;
    if (!openSource(entry.ctx, sourcePath)) {
        return nullptr;
    }

    lruOrder_.push_front(key);
    entry.lruIt = lruOrder_.begin();
    entry.lastTouched = std::chrono::steady_clock::now();
    entry.streamIndex = streamIndex;
    auto [insertIt, _] = contexts_.emplace(key, std::move(entry));
    return &insertIt->second;
}

bool RenderVideoDecoder::canContinueForward(const DecoderContext& ctx, int64_t frameIndex) const
{
    // Intra-only decoders accept the first frame they produce as the target
    // (decodeFrame), so they must always seek — which is cheap for them anyway.
    if (ctx.isIntraOnly || ctx.lastDecodedFrame < 0 || !ctx.formatCtx) return false;
    const int64_t gap = frameIndex - ctx.lastDecodedFrame;
    if (gap < 1) return false;
    if (gap == 1) return true;

    // Forward decoding costs `gap` frames. A seek costs (target - keyframe)
    // frames plus the seek and flush. If no keyframe lies between where the
    // decoder is and the target, the seek would land at or before the current
    // position, so forward is never worse. The container's index says.
    AVStream* stream = ctx.formatCtx->streams[ctx.videoStreamIdx];
    const int64_t targetPts = targetPtsForFrame(ctx, frameIndex);
    const int idx = av_index_search_timestamp(stream, targetPts, AVSEEK_FLAG_BACKWARD);
    if (idx >= 0) {
        if (const AVIndexEntry* e = avformat_index_get_entry(stream, idx))
            return e->timestamp <= targetPtsForFrame(ctx, ctx.lastDecodedFrame);
    }
    // No index to consult (e.g. a stream format without one): bounded guess.
    return gap <= kForwardDecodeFallbackFrames;
}

DecoderContext* RenderVideoDecoder::acquireStream(const std::string& sourcePath,
                                                  int64_t frameIndex)
{
    const auto now = std::chrono::steady_clock::now();
    const auto busyWindow = std::chrono::milliseconds(kStreamBusyMs);

    ContextEntry* best = nullptr;           // can reach frameIndex going forward
    std::string   bestKey;
    int64_t       bestGap = INT64_MAX;
    ContextEntry* lru = nullptr;            // least recently used stream of this file
    std::string   lruKey;
    int           freeIndex = -1;

    for (int i = 0; i < kMaxStreamsPerSource; ++i) {
        std::string key = streamKey(sourcePath, i);
        auto it = contexts_.find(key);
        if (it == contexts_.end()) {
            if (freeIndex < 0) freeIndex = i;
            continue;
        }
        ContextEntry& e = it->second;
        if (canContinueForward(e.ctx, frameIndex)) {
            const int64_t gap = frameIndex - e.ctx.lastDecodedFrame;
            if (gap < bestGap) { bestGap = gap; best = &e; bestKey = key; }
        }
        if (!lru || e.lastTouched < lru->lastTouched) { lru = &e; lruKey = key; }
    }

    // A stream used within busyWindow is presumed to be following a playing
    // cell (a 24 fps source touches its stream every ~42 ms), so it is only
    // taken over — and made to seek away — when the file is at its stream cap.
    ContextEntry* chosen = nullptr;
    std::string   key;
    if (best) {
        chosen = best; key = bestKey;              // continue forward, no seek
    } else if (lru && (now - lru->lastTouched >= busyWindow || freeIndex < 0)) {
        chosen = lru; key = lruKey;                // idle, or at the cap: seek it
    } else {
        key = streamKey(sourcePath, freeIndex);    // every stream is in use: add one
    }

    inFlightPath_ = key;   // pin before any eviction the open below may do
    if (!chosen) {
        chosen = openStreamAt(key, sourcePath, freeIndex);
        if (!chosen) return nullptr;
    } else {
        promoteToMru(key);
    }
    chosen->lastTouched = now;
    return &chosen->ctx;
}

bool RenderVideoDecoder::evictLruContext()
{
    // Walk from the LRU end, skipping the context decode() is currently
    // using (inFlightPath_). That context should never actually be this far
    // back in lruOrder_ while pinned — it was just promoted to MRU by the
    // acquireStream() call that pinned it — but the guard is the one
    // invariant that must hold even if a future caller changes that: never
    // close a context with an in-flight decode on the video thread.
    for (auto rit = lruOrder_.rbegin(); rit != lruOrder_.rend(); ++rit) {
        if (!inFlightPath_.empty() && *rit == inFlightPath_) continue;

        const std::string victim = *rit;
        XLETH_RENDER_LOG(std::fprintf(stderr,
                     "[RenderDecoder] Evicting LRU context: '%s'\n", victim.c_str()));
        closeKey(victim);
        return true;
    }
    return false;
}

void RenderVideoDecoder::setActiveContextBudget(int distinctPathCount)
{
    // Headroom for the extra per-file streams a frame's cells may be playing
    // from, on top of one context per distinct path.
    contextBudget_ = std::clamp(distinctPathCount + (kMaxStreamsPerSource - 1),
                                MAX_OPEN_CONTEXTS, kMaxOpenContextsCap);
}

void RenderVideoDecoder::pruneIdleContexts(double idleSeconds)
{
    if (contexts_.empty()) return;

    const auto now = std::chrono::steady_clock::now();
    const auto threshold = std::chrono::duration<double>(idleSeconds);

    // Collect first, close after: closeSource() mutates contexts_/lruOrder_,
    // which would invalidate an in-progress iteration over contexts_.
    // Extra streams belong to one playing cell and go stale much sooner.
    const auto extraThreshold =
        std::chrono::duration<double>(std::min(idleSeconds, kExtraStreamIdleSeconds));
    std::vector<std::string> toClose;
    for (const auto& [key, entry] : contexts_) {
        if (!inFlightPath_.empty() && key == inFlightPath_) continue;
        if (now - entry.lastTouched >= (entry.streamIndex > 0 ? extraThreshold : threshold)) {
            toClose.push_back(key);
        }
    }
    for (const auto& key : toClose) {
        XLETH_RENDER_LOG(std::fprintf(stderr,
                     "[RenderDecoder] Closing idle context (untouched >= %.0fs): '%s'\n",
                     idleSeconds, key.c_str()));
        closeKey(key);
    }
}

void RenderVideoDecoder::promoteToMru(const std::string& sourcePath)
{
    auto it = contexts_.find(sourcePath);
    if (it == contexts_.end()) return;
    lruOrder_.erase(it->second.lruIt);
    lruOrder_.push_front(sourcePath);
    it->second.lruIt = lruOrder_.begin();
}

void RenderVideoDecoder::setSequentialHint(const std::string& sourcePath, bool hint)
{
    auto it = contexts_.find(sourcePath);
    if (it != contexts_.end()) {
        it->second.ctx.sequentialHint = hint;
    }
}

// ===========================================================================
// Decode-path introspection (diagnostics)
// ===========================================================================

std::vector<RenderVideoDecoder::OpenSourceInfo>
RenderVideoDecoder::openSourceInfos() const
{
    std::vector<OpenSourceInfo> out;
    out.reserve(contexts_.size());
    for (const auto& kv : contexts_) {
        const DecoderContext& c = kv.second.ctx;
        OpenSourceInfo info;
        info.sourcePath = c.sourcePath;   // the file, not the stream key
        info.path       = c.isHwAccel ? DecodePath::Hardware : DecodePath::Software;
        info.intraOnly  = c.isIntraOnly;
        info.width      = c.width;
        info.height     = c.height;
        out.push_back(std::move(info));
    }
    return out;
}

RenderVideoDecoder::DecodePath
RenderVideoDecoder::decodePathFor(const std::string& sourcePath) const
{
    for (int i = 0; i < kMaxStreamsPerSource; ++i) {
        auto it = contexts_.find(streamKey(sourcePath, i));
        if (it != contexts_.end())
            return it->second.ctx.isHwAccel ? DecodePath::Hardware : DecodePath::Software;
    }
    return DecodePath::None;
}

// ===========================================================================
// Open a source file
// ===========================================================================

// FFmpeg get_format callback — select D3D11VA if available
static enum AVPixelFormat getHwFormat(AVCodecContext* /*ctx*/, const enum AVPixelFormat* pix_fmts)
{
    for (const AVPixelFormat* p = pix_fmts; *p != AV_PIX_FMT_NONE; ++p) {
        if (*p == AV_PIX_FMT_D3D11) {
            return AV_PIX_FMT_D3D11;
        }
    }
    // Fallback to software format
    std::fprintf(stderr, "[RenderDecoder] D3D11VA format not offered by codec, falling back to SW\n");
    return pix_fmts[0];
}

bool RenderVideoDecoder::openSource(DecoderContext& ctx, const std::string& sourcePath)
{
    ctx.sourcePath = sourcePath;

    // 1. Open container
    if (avformat_open_input(&ctx.formatCtx, sourcePath.c_str(), nullptr, nullptr) < 0) {
        std::fprintf(stderr, "[RenderDecoder] Could not open: '%s'\n", sourcePath.c_str());
        return false;
    }

    if (avformat_find_stream_info(ctx.formatCtx, nullptr) < 0) {
        std::fprintf(stderr, "[RenderDecoder] Failed to read stream info: '%s'\n", sourcePath.c_str());
        ctx.close();
        return false;
    }

    // 2. Find best video stream
    const AVCodec* codec = nullptr;
    ctx.videoStreamIdx = av_find_best_stream(ctx.formatCtx, AVMEDIA_TYPE_VIDEO,
                                              -1, -1, &codec, 0);
    if (ctx.videoStreamIdx < 0 || !codec) {
        std::fprintf(stderr, "[RenderDecoder] No video stream in: '%s'\n", sourcePath.c_str());
        ctx.close();
        return false;
    }

    AVStream* stream = ctx.formatCtx->streams[ctx.videoStreamIdx];

    // 3. Detect intra-only codec (DNxHR, MJPEG, ProRes, etc.)
    //    AV_CODEC_PROP_INTRA_ONLY means every frame is a keyframe — no GOP.
    if (codec->id == AV_CODEC_ID_DNXHD ||
        codec->id == AV_CODEC_ID_MJPEG ||
        codec->id == AV_CODEC_ID_PRORES) {
        ctx.isIntraOnly = true;
    }
    // Also check the codec descriptor for the INTRA_ONLY property
    const AVCodecDescriptor* desc = avcodec_descriptor_get(codec->id);
    if (desc && (desc->props & AV_CODEC_PROP_INTRA_ONLY)) {
        ctx.isIntraOnly = true;
    }

    // 4. Allocate codec context
    ctx.codecCtx = avcodec_alloc_context3(codec);
    if (!ctx.codecCtx) {
        std::fprintf(stderr, "[RenderDecoder] Failed to alloc codec context\n");
        ctx.close();
        return false;
    }

    if (avcodec_parameters_to_context(ctx.codecCtx, stream->codecpar) < 0) {
        std::fprintf(stderr, "[RenderDecoder] Failed to copy codec params\n");
        ctx.close();
        return false;
    }

    // 5. Try D3D11VA hardware acceleration
    //    DNxHR is intra-frame — hw decode gives minimal benefit and many drivers
    //    don't support it.  Skip hw accel for intra-only codecs.
    if (hwDeviceCtx_ && !ctx.isIntraOnly) {
        ctx.codecCtx->hw_device_ctx = av_buffer_ref(hwDeviceCtx_);
        ctx.codecCtx->get_format    = getHwFormat;
        ctx.isHwAccel = true;
        std::fprintf(stderr, "[RenderDecoder] Attempting D3D11VA for '%s' (codec: %s)\n",
                     sourcePath.c_str(), codec->name);
    } else {
        ctx.isHwAccel = false;
        if (ctx.isIntraOnly) {
            std::fprintf(stderr, "[RenderDecoder] Intra-only codec '%s' — using SW decode for '%s'\n",
                         codec->name, sourcePath.c_str());
        }
    }

    const int swThreads = (decodeThreads_ > 0) ? decodeThreads_ : defaultDecodeThreads();
    if (!ctx.isHwAccel)
        configureSoftwareDecodeThreads(ctx.codecCtx, swThreads);

    // 6. Open codec
    {
        int openRet = avcodec_open2(ctx.codecCtx, codec, nullptr);
        if (openRet < 0) {
            char errBuf[AV_ERROR_MAX_STRING_SIZE] = {0};
            av_strerror(openRet, errBuf, sizeof(errBuf));
            // If hw accel failed, retry without it
            if (ctx.isHwAccel) {
                std::fprintf(stderr,
                             "[RenderDecoder] D3D11VA open failed for '%s' (codec=%s): %s — retrying SW\n",
                             sourcePath.c_str(), codec->name, errBuf);
                avcodec_free_context(&ctx.codecCtx);
                ctx.codecCtx = avcodec_alloc_context3(codec);
                avcodec_parameters_to_context(ctx.codecCtx, stream->codecpar);
                ctx.isHwAccel = false;
                configureSoftwareDecodeThreads(ctx.codecCtx, swThreads);
                int swRet = avcodec_open2(ctx.codecCtx, codec, nullptr);
                if (swRet < 0) {
                    char swErr[AV_ERROR_MAX_STRING_SIZE] = {0};
                    av_strerror(swRet, swErr, sizeof(swErr));
                    std::fprintf(stderr,
                                 "[RenderDecoder] SW fallback also failed for '%s' (codec=%s): %s\n",
                                 sourcePath.c_str(), codec->name, swErr);
                    ctx.close();
                    return false;
                }
            } else {
                std::fprintf(stderr,
                             "[RenderDecoder] Failed to open codec '%s' for '%s': %s\n",
                             codec->name, sourcePath.c_str(), errBuf);
                ctx.close();
                return false;
            }
        }
    }

    // 7. Cache metadata
    ctx.width  = ctx.codecCtx->width;
    ctx.height = ctx.codecCtx->height;

    // Frame rate authority: r_frame_rate, falling back to avg_frame_rate, then
    // 30/1. Kept as an exact rational — see render/FrameRateMath.h for why the
    // old `double` + std::round() form produced depth-proportional desync.
    {
        bool usedFallback = false;
        bool vfrSuspect   = false;
        ctx.frameRate = xleth::frametiming::chooseFrameRate(
            stream->r_frame_rate, stream->avg_frame_rate, &usedFallback, &vfrSuspect);

        if (usedFallback) {
            std::fprintf(stderr,
                "[RenderDecoder] WARNING: '%s' declares no usable r_frame_rate "
                "(r=%d/%d avg=%d/%d); falling back to %d/%d. Frame timing may be "
                "approximate.\n",
                sourcePath.c_str(),
                stream->r_frame_rate.num, stream->r_frame_rate.den,
                stream->avg_frame_rate.num, stream->avg_frame_rate.den,
                ctx.frameRate.num, ctx.frameRate.den);
        }
        if (vfrSuspect) {
            // Small r/avg divergence is normal container rounding (avg is
            // frames/duration and is contaminated by the trailing partial frame).
            // More than ~0.5% means the stream is genuinely variable-frame-rate,
            // which a constant-rate model cannot represent — frames will be wrong
            // regardless of which rate we pick. Fixing that needs a demuxed PTS
            // index; this warning is the signal that it is required.
            std::fprintf(stderr,
                "[RenderDecoder] WARNING: '%s' looks VARIABLE frame rate "
                "(r_frame_rate=%d/%d = %.6f vs avg_frame_rate=%d/%d = %.6f, "
                ">0.5%% apart). Constant-rate frame mapping will be inaccurate for "
                "this source.\n",
                sourcePath.c_str(),
                stream->r_frame_rate.num, stream->r_frame_rate.den,
                av_q2d(stream->r_frame_rate),
                stream->avg_frame_rate.num, stream->avg_frame_rate.den,
                av_q2d(stream->avg_frame_rate));
        }
    }

    // 8. Allocate reusable frame + packet
    ctx.frame  = av_frame_alloc();
    ctx.packet = av_packet_alloc();
    if (!ctx.frame || !ctx.packet) {
        ctx.close();
        return false;
    }

    std::fprintf(stderr, "[RenderDecoder] Opened '%s': %dx%d @ %d/%d fps (%.5f), codec=%s, hw=%s, intra=%s, threads=%d\n",
                 sourcePath.c_str(), ctx.width, ctx.height,
                 ctx.frameRate.num, ctx.frameRate.den, av_q2d(ctx.frameRate),
                 codec->name,
                 ctx.isHwAccel ? "D3D11VA" : "SW",
                 ctx.isIntraOnly ? "yes" : "no",
                 ctx.isHwAccel ? 1 : std::max(1, ctx.codecCtx->thread_count));

    return true;
}

// ===========================================================================
// Seek + decode
// ===========================================================================

int64_t RenderVideoDecoder::targetPtsForFrame(const DecoderContext& ctx,
                                              int64_t               frameIndex)
{
    const AVStream* stream = ctx.formatCtx->streams[ctx.videoStreamIdx];
    return xleth::frametiming::frameToPts(
        frameIndex, ctx.frameRate, stream->time_base, stream->start_time);
}

bool RenderVideoDecoder::seekToFrame(DecoderContext& ctx, int64_t frameIndex)
{
    // ── Automatic sequential fast path ──────────────────────────────────────
    // If the requested frame is exactly the one after the frame we last decoded,
    // the codec is already positioned to read it forward: no seek, no
    // avcodec_flush_buffers(), no GOP re-decode. This is THE common case during
    // forward playback, and skipping the seek+flush is what lets live preview
    // run faster than ~1 FPS.
    //
    // This detection is self-contained on purpose. It used to be gated behind
    // ctx.sequentialHint, which setSequentialHint() was meant to set "from
    // FrameCollector" — but that setter was never actually called anywhere in
    // engine/ or bridge/, so the hint was permanently false and this fast path
    // was dead code. Every preview frame therefore paid for a full
    // av_seek_frame() + flush + re-decode. We now derive the sequential case
    // directly from lastDecodedFrame, so it works without any external wiring.
    //
    // The `lastDecodedFrame >= 0` guard is essential for correctness: a freshly
    // opened context has lastDecodedFrame == -1, and we must NOT treat frame 0
    // as "sequential" (0 == -1 + 1) — the first decode after open must seek.
    // All other non-consecutive requests (random scrub, loop wraparound /
    // seek-back where target < lastDecodedFrame, or a second different frame of
    // the same source within one tick) fail the `+ 1` test and seek as before.
    //
    // Generalised beyond +1: when no keyframe lies between the decoder's
    // position and the target, decoding forward is never more work than a
    // seek (which would land at or before where we already are). This is what
    // a 24 fps source shown at a 60 fps preview, or a cell that just resumed a
    // few frames on, looks like. See canContinueForward().
    if (canContinueForward(ctx, frameIndex)) {
        XLETH_RENDER_LOG(std::fprintf(stderr,
                     "[RenderDecoder] Sequential: decoding forward %lld -> %lld, no seek\n",
                     (long long)ctx.lastDecodedFrame, (long long)frameIndex));
        return true;
    }

    // ── Fresh-open frame-0 short circuit ─────────────────────────────────────
    // A just-opened context is already positioned at the first frame, so frame 0
    // needs no seek. Critically, this also fixes single-frame image sources (the
    // poster .xlposter.jpg is decoded by the demuxer 'jpeg_pipe', which is NOT
    // seekable): calling av_seek_frame on it discards the one buffered packet and
    // leaves nothing to read, so the poster "decodes" to nothing and the preview
    // stays black. Skipping the seek lets decodeFrame() read that first packet
    // and produce the poster frame. Harmless for normal video — a fresh decoder
    // is at frame 0 regardless. (Seek-back to frame 0 on an already-used context,
    // lastDecodedFrame >= 0, still seeks as before.)
    if (ctx.lastDecodedFrame < 0 && frameIndex == 0) {
        return true;
    }

    // For intra-only codecs, we can seek directly — every frame is a keyframe
    AVStream* stream = ctx.formatCtx->streams[ctx.videoStreamIdx];

    // Frame index → stream PTS, at the source's EXACT rational frame rate and
    // including stream->start_time. Shared with decodeFrame() via one helper so
    // the seek target and the decode target cannot disagree.
    int64_t targetPTS = targetPtsForFrame(ctx, frameIndex);

    int flags = AVSEEK_FLAG_BACKWARD;
    // Intra-only codecs: we can seek to any frame, but BACKWARD still works
    // and gives us the exact frame since every frame is a keyframe.

    if (av_seek_frame(ctx.formatCtx, ctx.videoStreamIdx, targetPTS, flags) < 0) {
        std::fprintf(stderr, "[RenderDecoder] Seek failed for frame %lld in '%s'\n",
                     (long long)frameIndex, ctx.sourcePath.c_str());
        return false;
    }

    avcodec_flush_buffers(ctx.codecCtx);
    return true;
}

bool RenderVideoDecoder::decodeFrame(DecoderContext& ctx, int64_t frameIndex)
{
    AVStream* stream = ctx.formatCtx->streams[ctx.videoStreamIdx];

    // Target PTS for the frame we want — same helper seekToFrame() used, so we
    // are hunting for exactly the timestamp we seeked to.
    const int64_t targetPTS = targetPtsForFrame(ctx, frameIndex);

    // Acceptance tolerance. A frame counts as "the one we asked for" once its
    // pts reaches within half a frame of the target. The exact-equality form
    // (pts >= targetPTS) assumes the muxer laid frame timestamps on the same
    // rounding of the ideal grid that frameToPts uses; a muxer that rounds the
    // other way would place the real frame one tick BELOW the target and this
    // loop would sail past it and deliver N+1. Half a frame can never reach back
    // to frame N-1 (it sits a full frame duration below the target), so the
    // tolerance is safe in both directions — proven in test_frame_timing.cpp.
    const int64_t acceptPTS =
        targetPTS - xleth::frametiming::halfFramePts(ctx.frameRate, stream->time_base);

    // Read packets and decode until we get a frame at or past targetPTS
    bool gotFrame = false;
    int maxAttempts = 1000;  // safety limit

    while (!gotFrame && maxAttempts-- > 0) {
        int ret = av_read_frame(ctx.formatCtx, ctx.packet);
        if (ret < 0) {
            // EOF or error — drain. With frame threading the decoder holds up
            // to (threads - 1) finished frames here, so keep receiving until
            // one reaches the target; the last frame delivered before the
            // drain runs dry is the closest the file has, exactly as the
            // single-threaded drain returned its one buffered frame.
            //
            // Received into a scratch frame and moved over: avcodec_receive_
            // frame unrefs its destination before doing anything, so receiving
            // straight into ctx.frame would wipe the kept frame the moment the
            // drain ran dry.
            avcodec_send_packet(ctx.codecCtx, nullptr);
            AVFrame* drained = av_frame_alloc();
            while (drained) {
                if (avcodec_receive_frame(ctx.codecCtx, drained) < 0) break;
                ++ctx.framesDecodedThisCall;
                av_frame_unref(ctx.frame);
                av_frame_move_ref(ctx.frame, drained);
                gotFrame = true;
                const int64_t pts = (ctx.frame->pts != AV_NOPTS_VALUE)
                                        ? ctx.frame->pts
                                        : ctx.frame->best_effort_timestamp;
                if (ctx.isIntraOnly || pts >= acceptPTS) break;
            }
            av_frame_free(&drained);
            break;
        }

        if (ctx.packet->stream_index != ctx.videoStreamIdx) {
            av_packet_unref(ctx.packet);
            continue;
        }

        ret = avcodec_send_packet(ctx.codecCtx, ctx.packet);
        av_packet_unref(ctx.packet);

        if (ret < 0 && ret != AVERROR(EAGAIN)) {
            char errBuf[AV_ERROR_MAX_STRING_SIZE] = {0};
            av_strerror(ret, errBuf, sizeof(errBuf));
            std::fprintf(stderr,
                         "[RenderDecoder] avcodec_send_packet failed (frame=%lld, hw=%s, pixfmt=%d): %s\n",
                         (long long)frameIndex,
                         ctx.isHwAccel ? "D3D11VA" : "SW",
                         (int)ctx.codecCtx->pix_fmt, errBuf);
            continue;
        }

        // Try to receive decoded frames
        while (true) {
            ret = avcodec_receive_frame(ctx.codecCtx, ctx.frame);
            if (ret == AVERROR(EAGAIN)) break;  // need more packets
            if (ret == AVERROR_EOF) break;
            if (ret < 0) {
                char errBuf[AV_ERROR_MAX_STRING_SIZE] = {0};
                av_strerror(ret, errBuf, sizeof(errBuf));
                std::fprintf(stderr,
                             "[RenderDecoder] avcodec_receive_frame failed (frame=%lld, hw=%s, pixfmt=%d): %s\n",
                             (long long)frameIndex,
                             ctx.isHwAccel ? "D3D11VA" : "SW",
                             (int)ctx.codecCtx->pix_fmt, errBuf);
                break;
            }

            ++ctx.framesDecodedThisCall;
            int64_t pts = (ctx.frame->pts != AV_NOPTS_VALUE)
                              ? ctx.frame->pts
                              : ctx.frame->best_effort_timestamp;

            // For intra-only codecs, the first decoded frame after seek IS the target
            if (ctx.isIntraOnly || pts >= acceptPTS) {
                gotFrame = true;
                break;
            }

            // Not yet at target — keep this frame (it's the closest so far)
            // but continue decoding for non-intra codecs
            av_frame_unref(ctx.frame);
        }
    }

    if (gotFrame) {
        // Record the frame we ACTUALLY decoded, derived from its own timestamp —
        // never the frame that was requested. The sequential fast path in
        // seekToFrame() trusts this value to decide it can skip the seek, so
        // storing the request here made any single bad seek permanent: the
        // decoder streamed forward from the wrong position and nothing ever
        // compared decoded PTS against expected PTS again. Deriving it from the
        // delivered PTS means a wrong landing self-corrects on the next request,
        // because frameIndex != lastDecodedFrame + 1 then forces a real seek.
        const int64_t decodedPts = (ctx.frame->pts != AV_NOPTS_VALUE)
                                       ? ctx.frame->pts
                                       : ctx.frame->best_effort_timestamp;
        if (decodedPts != AV_NOPTS_VALUE) {
            ctx.lastDecodedFrame = xleth::frametiming::ptsToFrame(
                decodedPts, ctx.frameRate, stream->time_base, stream->start_time);
        } else {
            // No usable timestamp (rare: some raw/image demuxers). Fall back to
            // the request — no worse than the old behaviour, and single-frame
            // image sources never take the sequential path anyway.
            ctx.lastDecodedFrame = frameIndex;
        }
    }

    return gotFrame;
}

// ===========================================================================
// Decode entry point
// ===========================================================================

FrameCacheEntry RenderVideoDecoder::decode(const std::string& sourcePath,
                                            int64_t            frameIndex,
                                            ID3D11Device*      device,
                                            ID3D11DeviceContext* deviceCtx)
{
    FrameCacheEntry empty;

    if (!device || !deviceCtx) {
        std::fprintf(stderr, "[RenderDecoder] decode: null D3D11 device/context\n");
        return empty;
    }

    // acquireStream pins the chosen stream's key in inFlightPath_ for the
    // duration of this call, so eviction (LRU or idle) can never close the
    // context this decode is using, on any return path.
    struct InFlightGuard {
        std::string& slot;
        ~InFlightGuard() { slot.clear(); }
    } inFlightGuard{inFlightPath_};

    using Clock = std::chrono::steady_clock;
    const auto t0 = Clock::now();
    const size_t openBefore = contexts_.size();

    // Pick (or open) the stream of this file that should serve the frame
    DecoderContext* ctx = acquireStream(sourcePath, frameIndex);
    const bool wasOpen = contexts_.size() <= openBefore;
    if (!ctx) {
        return empty;
    }
    const auto tOpened = Clock::now();

    // Seek to the target frame
    const int64_t prevDecoded = ctx->lastDecodedFrame;
    if (!seekToFrame(*ctx, frameIndex)) {
        return empty;
    }

    // Decode until we get the frame
    ctx->framesDecodedThisCall = 0;
    if (!decodeFrame(*ctx, frameIndex)) {
        std::fprintf(stderr, "[RenderDecoder] Failed to decode frame %lld from '%s'\n",
                     (long long)frameIndex, sourcePath.c_str());
        return empty;
    }
    const auto tDecoded = Clock::now();

    // Route to hw or sw extraction
    FrameCacheEntry result;
    if (ctx->isHwAccel && ctx->frame->format == AV_PIX_FMT_D3D11) {
        result = extractHwFrame(*ctx, ctx->frame, device, deviceCtx);
    } else {
        result = uploadSwFrame(*ctx, ctx->frame, device, deviceCtx);
    }

    av_frame_unref(ctx->frame);

    // Slow-decode breakdown — where a preview hitch came from. Gated.
    const auto ms = [](Clock::time_point a, Clock::time_point b) {
        return std::chrono::duration<double, std::milli>(b - a).count();
    };
    const double totalMs = ms(t0, Clock::now());
    if (totalMs > 15.0) {
        XLETH_RENDER_LOG(std::fprintf(stderr,
            "[RenderDecoder] SLOW %.1fms '%s' frame=%lld (prev=%lld): open=%.1f%s "
            "decode=%.1f (%d frames) extract=%.1f %dx%d %s\n",
            totalMs, sourcePath.c_str(), (long long)frameIndex, (long long)prevDecoded,
            ms(t0, tOpened), wasOpen ? "" : " [NEW]",
            ms(tOpened, tDecoded), ctx->framesDecodedThisCall,
            ms(tDecoded, Clock::now()), ctx->width, ctx->height,
            ctx->isHwAccel ? "hw" : "sw"));
    }
    return result;
}

// ===========================================================================
// Path A: D3D11VA hardware frame extraction
// ===========================================================================

FrameCacheEntry RenderVideoDecoder::extractHwFrame(DecoderContext& ctx, AVFrame* frame,
                                                    ID3D11Device* device,
                                                    ID3D11DeviceContext* deviceCtx)
{
    // D3D11VA produces NV12 texture arrays. Creating an SRV directly on NV12
    // requires dual-plane views (R8_UNORM for Y, R8G8_UNORM for UV) plus
    // YUV→BGR shader support — not yet implemented.
    //
    // Interim path: transfer the HW frame to CPU via av_hwframe_transfer_data,
    // then go through uploadSwFrame which converts NV12→BGRA via sws_scale and
    // uploads a standard D3D11 BGRA texture the compositor already handles.
    //
    // D3D11VA decode still runs on the GPU video engine (faster than SW decode
    // for 1080p H.264) — only the texture format conversion takes a GPU→CPU→GPU
    // detour. Zero-copy NV12 SRV + YUV shader is a future optimization.
    //
    // The destination frame is kept on the context and reused. When it still
    // holds buffers of the right shape, av_hwframe_transfer_data copies into
    // them in place; otherwise (first frame, or the stream changed size) it is
    // emptied so the transfer allocates fresh. Before this it was a new frame
    // — a fresh NV12 allocation, ~1.4 MB at 720p, faulted in and freed per
    // decoded frame.
    if (!ctx.hwTransferFrame) ctx.hwTransferFrame = av_frame_alloc();
    AVFrame* swFrame = ctx.hwTransferFrame;
    if (!swFrame) {
        std::fprintf(stderr, "[RenderDecoder] Failed to alloc SW frame for HW transfer\n");
        return {};
    }
    if (swFrame->buf[0]) {
        const auto* hwFrames = frame->hw_frames_ctx
            ? reinterpret_cast<const AVHWFramesContext*>(frame->hw_frames_ctx->data)
            : nullptr;
        const bool reusable = hwFrames
            && swFrame->width  == frame->width
            && swFrame->height == frame->height
            && swFrame->format == hwFrames->sw_format;
        if (!reusable) av_frame_unref(swFrame);
    }
    if (av_hwframe_transfer_data(swFrame, frame, 0) < 0) {
        std::fprintf(stderr, "[RenderDecoder] av_hwframe_transfer_data failed\n");
        av_frame_unref(swFrame);
        return {};
    }
    return uploadSwFrame(ctx, swFrame, device, deviceCtx);
}

// ===========================================================================
// Path B: Software decode → BGRA → staging texture → default texture + SRV
// ===========================================================================

FrameCacheEntry RenderVideoDecoder::uploadSwFrame(DecoderContext& ctx, AVFrame* frame,
                                                   ID3D11Device* device,
                                                   ID3D11DeviceContext* deviceCtx)
{
    FrameCacheEntry empty;

    const int w = frame->width;
    const int h = frame->height;
    if (w <= 0 || h <= 0) return empty;

    // Set up sws_scale to convert to BGRA (matches DXGI_FORMAT_B8G8R8A8_UNORM)
    AVPixelFormat srcFmt = static_cast<AVPixelFormat>(frame->format);

    // If frame is a hardware format, transfer to CPU first
    AVFrame* swFrame = nullptr;
    if (srcFmt == AV_PIX_FMT_D3D11 || srcFmt == AV_PIX_FMT_DXVA2_VLD) {
        swFrame = av_frame_alloc();
        if (av_hwframe_transfer_data(swFrame, frame, 0) < 0) {
            std::fprintf(stderr, "[RenderDecoder] Failed to transfer HW frame to CPU\n");
            av_frame_free(&swFrame);
            return empty;
        }
        frame = swFrame;
        srcFmt = static_cast<AVPixelFormat>(frame->format);
    }

    // Output size: the decoded size, unless a cap is set (the preview sets it
    // to its compositor surface — nothing on screen can show more pixels than
    // that, and the compositor samples in UV space, so a smaller texture is
    // transparent to it). sws_scale then converts AND downscales in one pass,
    // which costs less than the plain conversion did, and the upload and the
    // cache entry shrink with it: a 1280x720 proxy frame capped to 960x540 is
    // 44% fewer bytes in every later step and in the 512 MB frame cache.
    int outW = w, outH = h;
    if (maxOutputW_ > 0 && maxOutputH_ > 0 && (w > maxOutputW_ || h > maxOutputH_)) {
        const double scale = std::min(static_cast<double>(maxOutputW_) / w,
                                      static_cast<double>(maxOutputH_) / h);
        outW = std::max(1, static_cast<int>(std::lround(w * scale)));
        outH = std::max(1, static_cast<int>(std::lround(h * scale)));
    }

    // Cached per context; rebuilt only when the source format or either size
    // changes (sws_getCachedContext compares and reuses).
    ctx.swsCtx = sws_getCachedContext(ctx.swsCtx, w, h, srcFmt,
                                      outW, outH, AV_PIX_FMT_BGRA,
                                      SWS_BILINEAR, nullptr, nullptr, nullptr);
    if (!ctx.swsCtx) {
        std::fprintf(stderr, "[RenderDecoder] Failed to create SwsContext (src fmt=%d)\n", srcFmt);
        if (swFrame) av_frame_free(&swFrame);
        return empty;
    }

    // Convert to BGRA. The destination carries sws_scale's write slack — see
    // video/SwsDestBuffer.h. A bare vector sized w*4*h here was the
    // STATUS_HEAP_CORRUPTION (0xC0000374): yuv422p sources (dnxhd proxies)
    // overflowed it by 32 bytes on every decoded frame. The buffer is reused
    // across frames (it used to be a fresh allocation per decoded frame).
    const int stride = outW * 4;
    const size_t needed = static_cast<size_t>(stride) * outH + xleth::kSwsDestPadding;
    if (ctx.bgraScratch.size() < needed) ctx.bgraScratch.resize(needed);
    uint8_t* dstSlice[1] = { ctx.bgraScratch.data() };
    int dstStride[1] = { stride };

    sws_scale(ctx.swsCtx, frame->data, frame->linesize, 0, h, dstSlice, dstStride);

    if (swFrame) av_frame_free(&swFrame);

    // One default-usage texture, initialised straight from the converted
    // pixels. This used to create a CPU-writable STAGING texture with the
    // pixels, a second DEFAULT texture, and CopyResource between them — two
    // allocations and an extra full-frame GPU copy per decoded frame for
    // exactly the same result.
    D3D11_TEXTURE2D_DESC texDesc = {};
    texDesc.Width              = static_cast<UINT>(outW);
    texDesc.Height             = static_cast<UINT>(outH);
    texDesc.MipLevels          = 1;
    texDesc.ArraySize          = 1;
    texDesc.Format             = DXGI_FORMAT_B8G8R8A8_UNORM;
    texDesc.SampleDesc.Count   = 1;
    texDesc.SampleDesc.Quality = 0;
    texDesc.Usage              = D3D11_USAGE_DEFAULT;
    texDesc.BindFlags          = D3D11_BIND_SHADER_RESOURCE;
    texDesc.CPUAccessFlags     = 0;
    texDesc.MiscFlags          = 0;

    D3D11_SUBRESOURCE_DATA initData = {};
    initData.pSysMem          = ctx.bgraScratch.data();
    initData.SysMemPitch      = static_cast<UINT>(stride);
    initData.SysMemSlicePitch = 0;

    Microsoft::WRL::ComPtr<ID3D11Texture2D> defaultTex;
    HRESULT hr = device->CreateTexture2D(&texDesc, &initData, &defaultTex);
    if (FAILED(hr)) {
        std::fprintf(stderr, "[RenderDecoder] Failed to create frame texture, HR=0x%08X\n",
                     static_cast<unsigned int>(hr));
        return empty;
    }
    (void)deviceCtx;

    // Create SRV
    D3D11_SHADER_RESOURCE_VIEW_DESC srvDesc = {};
    srvDesc.Format                    = DXGI_FORMAT_B8G8R8A8_UNORM;
    srvDesc.ViewDimension             = D3D11_SRV_DIMENSION_TEXTURE2D;
    srvDesc.Texture2D.MostDetailedMip = 0;
    srvDesc.Texture2D.MipLevels       = 1;

    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> srv;
    hr = device->CreateShaderResourceView(defaultTex.Get(), &srvDesc, &srv);
    if (FAILED(hr)) {
        std::fprintf(stderr, "[RenderDecoder] Failed to create SRV, HR=0x%08X\n",
                     static_cast<unsigned int>(hr));
        return empty;
    }

    FrameCacheEntry entry;
    entry.texture        = defaultTex;
    entry.srv            = srv;
    entry.width          = outW;
    entry.height         = outH;
    entry.memorySizeBytes = static_cast<size_t>(outW) * outH * 4;

    return entry;
}
