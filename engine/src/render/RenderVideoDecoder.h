#pragma once

/**
 * RenderVideoDecoder — Decode source frames to D3D11 textures for the render pipeline.
 *
 * Two decode paths:
 *   Path A (D3D11VA): Hardware-accelerated decode → zero-copy GPU texture.
 *                     The decoded frame lives in an array texture managed by
 *                     FFmpeg's D3D11VA hwframes pool.  We CopySubresourceRegion
 *                     into a standalone texture for the FrameCache.
 *
 *   Path B (Software): CPU decode → sws_scale to BGRA → staging texture upload
 *                      → CopyResource to default-usage texture → SRV.
 *
 * Per-source DecoderContext keeps the AVFormatContext/AVCodecContext open so
 * sequential reads don't re-open the file.  LRU eviction keeps at most
 * MAX_OPEN_CONTEXTS sources open simultaneously.
 *
 * Sequential hint: if the requested frame == lastDecodedFrame + 1, skip the
 * seek and just read forward (chorus tracks benefit hugely from this).
 *
 * DNxHR awareness: intra-frame codecs (every frame is a keyframe) never need
 * to decode a GOP — seeking lands exactly on the target frame.
 */

#include <cstdint>
#include <list>
#include <map>
#include <string>
#include <unordered_map>

// GpuDeviceManager.h guards NOMINMAX before <d3d11_4.h>
#include "GpuDeviceManager.h"
#include "FrameCache.h"       // FrameCacheEntry, FrameCacheKey

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_d3d11va.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>
}

// ---------------------------------------------------------------------------
// DecoderContext — one open source file
// ---------------------------------------------------------------------------
struct DecoderContext {
    AVFormatContext* formatCtx    = nullptr;
    AVCodecContext*  codecCtx     = nullptr;
    AVFrame*         frame        = nullptr;
    AVPacket*        packet       = nullptr;
    SwsContext*      swsCtx       = nullptr;   // sw path: src fmt → BGRA
    int              videoStreamIdx = -1;

    int              width        = 0;
    int              height       = 0;
    double           fps          = 30.0;
    int64_t          lastDecodedFrame = -1;     // for sequential hint
    bool             sequentialHint   = false;  // set by FrameCollector
    bool             isIntraOnly      = false;  // DNxHR, MJPEG, ProRes, etc.
    bool             isHwAccel        = false;  // using D3D11VA path

    std::string      sourcePath;

    void close();
};

// ---------------------------------------------------------------------------
// RenderVideoDecoder
// ---------------------------------------------------------------------------
class RenderVideoDecoder
{
public:
    static constexpr int MAX_OPEN_CONTEXTS = 4;

    RenderVideoDecoder();
    ~RenderVideoDecoder();

    // Non-copyable
    RenderVideoDecoder(const RenderVideoDecoder&)            = delete;
    RenderVideoDecoder& operator=(const RenderVideoDecoder&) = delete;

    // ── Initialization ─────────────────────────────────────────────────────

    /**
     * Initialize the D3D11VA hardware device context wrapping GpuDeviceManager's
     * device.  Call once after GpuDeviceManager::createDevice().
     * Returns false if hw accel is unavailable (sw fallback still works).
     */
    bool initHwDevice(ID3D11Device* device, ID3D11DeviceContext* deviceCtx);

    /** True if D3D11VA hardware decode is available. */
    bool hasHwAccel() const { return hwDeviceCtx_ != nullptr; }

    // ── Decode ─────────────────────────────────────────────────────────────

    /**
     * Decode a single source frame and return it as a FrameCacheEntry
     * containing a D3D11 texture + SRV.
     *
     * @param sourcePath   Path to the source video file
     * @param frameIndex   0-based frame number in the source
     * @param device       D3D11 device for texture creation
     * @param deviceCtx    D3D11 immediate context for copy/upload
     * @return  FrameCacheEntry with texture+SRV, or empty entry on failure
     */
    FrameCacheEntry decode(const std::string& sourcePath,
                           int64_t            frameIndex,
                           ID3D11Device*      device,
                           ID3D11DeviceContext* deviceCtx);

    // ── Context management ─────────────────────────────────────────────────

    /** Close all open decoder contexts. Call on project load / shutdown. */
    void closeAll();

    /** Full shutdown: close all contexts and release the hw device context.
     *  Call before destroying the D3D11 device (GpuDeviceManager). */
    void shutdown();

    /** Set sequential hint for a source (called by FrameCollector). */
    void setSequentialHint(const std::string& sourcePath, bool hint);

    /** Number of currently open contexts. */
    int openContextCount() const { return static_cast<int>(contexts_.size()); }

private:
    // ── Context pool (LRU) ─────────────────────────────────────────────────
    // lruOrder_: front = MRU, back = LRU
    using LruList = std::list<std::string>;
    LruList lruOrder_;

    struct ContextEntry {
        DecoderContext      ctx;
        LruList::iterator   lruIt;
    };
    std::unordered_map<std::string, ContextEntry> contexts_;

    DecoderContext* getOrOpenContext(const std::string& sourcePath);
    void evictLruContext();
    void promoteToMru(const std::string& sourcePath);

    // ── Open a source ──────────────────────────────────────────────────────
    bool openSource(DecoderContext& ctx, const std::string& sourcePath);

    // ── Decode paths ───────────────────────────────────────────────────────

    /** Seek to frame (or skip if sequential). Returns true on success. */
    bool seekToFrame(DecoderContext& ctx, int64_t frameIndex);

    /** Read packets until we get the target frame. */
    bool decodeFrame(DecoderContext& ctx, int64_t frameIndex);

    /** Path A: extract D3D11 texture from hw-decoded AVFrame. */
    FrameCacheEntry extractHwFrame(DecoderContext& ctx, AVFrame* frame,
                                   ID3D11Device* device, ID3D11DeviceContext* deviceCtx);

    /** Path B: sws_scale to BGRA → staging texture → default texture + SRV. */
    FrameCacheEntry uploadSwFrame(DecoderContext& ctx, AVFrame* frame,
                                  ID3D11Device* device, ID3D11DeviceContext* deviceCtx);

    // ── D3D11VA hw device context (shared across all decoder contexts) ──────
    AVBufferRef* hwDeviceCtx_ = nullptr;   // AVHWDeviceContext wrapping our device
};
