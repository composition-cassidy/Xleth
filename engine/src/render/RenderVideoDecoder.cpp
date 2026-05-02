#include "RenderVideoDecoder.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>

// ===========================================================================
// DecoderContext
// ===========================================================================

void DecoderContext::close()
{
    if (swsCtx)    { sws_freeContext(swsCtx);          swsCtx    = nullptr; }
    if (frame)     { av_frame_free(&frame);                                 }
    if (packet)    { av_packet_free(&packet);                               }
    if (codecCtx)  { avcodec_free_context(&codecCtx);                      }
    if (formatCtx) { avformat_close_input(&formatCtx);                     }

    videoStreamIdx   = -1;
    width            = 0;
    height           = 0;
    fps              = 30.0;
    lastDecodedFrame = -1;
    sequentialHint   = false;
    isIntraOnly      = false;
    isHwAccel        = false;
    sourcePath.clear();
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

DecoderContext* RenderVideoDecoder::getOrOpenContext(const std::string& sourcePath)
{
    auto it = contexts_.find(sourcePath);
    if (it != contexts_.end()) {
        promoteToMru(sourcePath);
        return &it->second.ctx;
    }

    // Evict if at capacity
    while (static_cast<int>(contexts_.size()) >= MAX_OPEN_CONTEXTS) {
        evictLruContext();
    }

    // Open new context
    ContextEntry entry;
    if (!openSource(entry.ctx, sourcePath)) {
        return nullptr;
    }

    lruOrder_.push_front(sourcePath);
    entry.lruIt = lruOrder_.begin();
    auto [insertIt, _] = contexts_.emplace(sourcePath, std::move(entry));
    return &insertIt->second.ctx;
}

void RenderVideoDecoder::evictLruContext()
{
    if (lruOrder_.empty()) return;

    const std::string& victim = lruOrder_.back();
    std::fprintf(stderr, "[RenderDecoder] Evicting LRU context: '%s'\n", victim.c_str());

    auto it = contexts_.find(victim);
    if (it != contexts_.end()) {
        it->second.ctx.close();
        contexts_.erase(it);
    }
    lruOrder_.pop_back();
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
    if (stream->r_frame_rate.den > 0)
        ctx.fps = av_q2d(stream->r_frame_rate);
    else
        ctx.fps = 30.0;

    // 8. Allocate reusable frame + packet
    ctx.frame  = av_frame_alloc();
    ctx.packet = av_packet_alloc();
    if (!ctx.frame || !ctx.packet) {
        ctx.close();
        return false;
    }

    std::fprintf(stderr, "[RenderDecoder] Opened '%s': %dx%d @ %.2f fps, codec=%s, hw=%s, intra=%s\n",
                 sourcePath.c_str(), ctx.width, ctx.height, ctx.fps,
                 codec->name,
                 ctx.isHwAccel ? "D3D11VA" : "SW",
                 ctx.isIntraOnly ? "yes" : "no");

    return true;
}

// ===========================================================================
// Seek + decode
// ===========================================================================

bool RenderVideoDecoder::seekToFrame(DecoderContext& ctx, int64_t frameIndex)
{
    // Sequential hint: if we just decoded the previous frame, skip the seek
    if (ctx.sequentialHint && frameIndex == ctx.lastDecodedFrame + 1) {
        std::fprintf(stderr, "[RenderDecoder] Sequential hint: skipping seek for frame %lld\n",
                     (long long)frameIndex);
        return true;
    }

    // For intra-only codecs, we can seek directly — every frame is a keyframe
    AVStream* stream = ctx.formatCtx->streams[ctx.videoStreamIdx];

    // Convert frame index to stream PTS
    // PTS = frameIndex * time_base_den / (time_base_num * fps)
    // Using av_rescale_q for precision:
    //   frame N at fps F → timestamp = N / F seconds
    //   → PTS = N / F / time_base = N * time_base.den / (F * time_base.num)
    AVRational frameDur = {1, static_cast<int>(std::round(ctx.fps))};
    int64_t targetPTS = av_rescale_q(frameIndex, frameDur, stream->time_base);

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

    // Target PTS for the frame we want
    AVRational frameDur = {1, static_cast<int>(std::round(ctx.fps))};
    int64_t targetPTS = av_rescale_q(frameIndex, frameDur, stream->time_base);

    // Read packets and decode until we get a frame at or past targetPTS
    bool gotFrame = false;
    int maxAttempts = 1000;  // safety limit

    while (!gotFrame && maxAttempts-- > 0) {
        int ret = av_read_frame(ctx.formatCtx, ctx.packet);
        if (ret < 0) {
            // EOF or error — try to drain
            avcodec_send_packet(ctx.codecCtx, nullptr);
            ret = avcodec_receive_frame(ctx.codecCtx, ctx.frame);
            if (ret == 0) {
                gotFrame = true;
            }
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

            int64_t pts = (ctx.frame->pts != AV_NOPTS_VALUE)
                              ? ctx.frame->pts
                              : ctx.frame->best_effort_timestamp;

            // For intra-only codecs, the first decoded frame after seek IS the target
            if (ctx.isIntraOnly || pts >= targetPTS) {
                gotFrame = true;
                break;
            }

            // Not yet at target — keep this frame (it's the closest so far)
            // but continue decoding for non-intra codecs
            av_frame_unref(ctx.frame);
        }
    }

    if (gotFrame) {
        ctx.lastDecodedFrame = frameIndex;
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

    // Get or open the decoder context for this source
    DecoderContext* ctx = getOrOpenContext(sourcePath);
    if (!ctx) {
        return empty;
    }

    // Seek to the target frame
    if (!seekToFrame(*ctx, frameIndex)) {
        return empty;
    }

    // Decode until we get the frame
    if (!decodeFrame(*ctx, frameIndex)) {
        std::fprintf(stderr, "[RenderDecoder] Failed to decode frame %lld from '%s'\n",
                     (long long)frameIndex, sourcePath.c_str());
        return empty;
    }

    // Route to hw or sw extraction
    FrameCacheEntry result;
    if (ctx->isHwAccel && ctx->frame->format == AV_PIX_FMT_D3D11) {
        result = extractHwFrame(*ctx, ctx->frame, device, deviceCtx);
    } else {
        result = uploadSwFrame(*ctx, ctx->frame, device, deviceCtx);
    }

    av_frame_unref(ctx->frame);
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
    AVFrame* swFrame = av_frame_alloc();
    if (!swFrame) {
        std::fprintf(stderr, "[RenderDecoder] Failed to alloc SW frame for HW transfer\n");
        return {};
    }
    if (av_hwframe_transfer_data(swFrame, frame, 0) < 0) {
        std::fprintf(stderr, "[RenderDecoder] av_hwframe_transfer_data failed\n");
        av_frame_free(&swFrame);
        return {};
    }
    auto result = uploadSwFrame(ctx, swFrame, device, deviceCtx);
    av_frame_free(&swFrame);
    return result;
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

    // Lazy-init or reinit sws context if needed
    if (!ctx.swsCtx) {
        ctx.swsCtx = sws_getContext(w, h, srcFmt,
                                     w, h, AV_PIX_FMT_BGRA,
                                     SWS_BILINEAR, nullptr, nullptr, nullptr);
        if (!ctx.swsCtx) {
            std::fprintf(stderr, "[RenderDecoder] Failed to create SwsContext (src fmt=%d)\n", srcFmt);
            if (swFrame) av_frame_free(&swFrame);
            return empty;
        }
    }

    // Convert to BGRA
    const int stride = w * 4;
    std::vector<uint8_t> bgraData(static_cast<size_t>(stride) * h);
    uint8_t* dstSlice[1] = { bgraData.data() };
    int dstStride[1] = { stride };

    sws_scale(ctx.swsCtx, frame->data, frame->linesize, 0, h, dstSlice, dstStride);

    if (swFrame) av_frame_free(&swFrame);

    // Create staging texture (CPU writable)
    D3D11_TEXTURE2D_DESC stagingDesc = {};
    stagingDesc.Width              = static_cast<UINT>(w);
    stagingDesc.Height             = static_cast<UINT>(h);
    stagingDesc.MipLevels          = 1;
    stagingDesc.ArraySize          = 1;
    stagingDesc.Format             = DXGI_FORMAT_B8G8R8A8_UNORM;
    stagingDesc.SampleDesc.Count   = 1;
    stagingDesc.SampleDesc.Quality = 0;
    stagingDesc.Usage              = D3D11_USAGE_STAGING;
    stagingDesc.BindFlags          = 0;
    stagingDesc.CPUAccessFlags     = D3D11_CPU_ACCESS_WRITE;
    stagingDesc.MiscFlags          = 0;

    D3D11_SUBRESOURCE_DATA initData = {};
    initData.pSysMem          = bgraData.data();
    initData.SysMemPitch      = static_cast<UINT>(stride);
    initData.SysMemSlicePitch = 0;

    Microsoft::WRL::ComPtr<ID3D11Texture2D> stagingTex;
    HRESULT hr = device->CreateTexture2D(&stagingDesc, &initData, &stagingTex);
    if (FAILED(hr)) {
        std::fprintf(stderr, "[RenderDecoder] Failed to create staging texture, HR=0x%08X\n",
                     static_cast<unsigned int>(hr));
        return empty;
    }

    // Create default-usage texture (GPU readable, shader resource)
    D3D11_TEXTURE2D_DESC defaultDesc = stagingDesc;
    defaultDesc.Usage          = D3D11_USAGE_DEFAULT;
    defaultDesc.BindFlags      = D3D11_BIND_SHADER_RESOURCE;
    defaultDesc.CPUAccessFlags = 0;

    Microsoft::WRL::ComPtr<ID3D11Texture2D> defaultTex;
    hr = device->CreateTexture2D(&defaultDesc, nullptr, &defaultTex);
    if (FAILED(hr)) {
        std::fprintf(stderr, "[RenderDecoder] Failed to create default texture, HR=0x%08X\n",
                     static_cast<unsigned int>(hr));
        return empty;
    }

    // Copy staging → default
    deviceCtx->CopyResource(defaultTex.Get(), stagingTex.Get());

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
    entry.width          = w;
    entry.height         = h;
    entry.memorySizeBytes = static_cast<size_t>(w) * h * 4;

    return entry;
}
