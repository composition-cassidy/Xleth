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
 *   Path B (Software): CPU decode → sws_scale to BGRA (downscaled to the
 *                      setMaxOutputSize cap, if any) → default-usage texture
 *                      created with the pixels as initial data → SRV.
 *
 * Per-source DecoderContext keeps the AVFormatContext/AVCodecContext open so
 * sequential reads don't re-open the file.  LRU eviction keeps at most an
 * ADAPTIVE budget of contexts open simultaneously — sized per frame from the
 * distinct source paths the live request set actually needs (the proxy
 * ladder means one source can present as several distinct paths, so path
 * count is the real pressure signal, not source count), clamped to
 * [MAX_OPEN_CONTEXTS, kMaxOpenContextsCap]. A time-based sweep additionally
 * closes contexts untouched for a while so a long session doesn't hold
 * handles forever. Eviction (LRU or idle) never closes the context decode()
 * is currently using — its path is pinned in inFlightPath_ for the duration
 * of the call.
 *
 * Sequential fast path: if no keyframe lies between lastDecodedFrame and the
 * requested frame (lastDecodedFrame + 1 always qualifies), skip the seek and
 * just read forward (forward playback and chorus tracks benefit hugely from
 * this). This is detected automatically inside seekToFrame() — it does NOT
 * depend on the external sequentialHint flag, which was never wired up by any
 * caller. A file may hold several streams (contexts) so cells playing it at
 * different offsets each keep their own forward position — see
 * kMaxStreamsPerSource.
 *
 * DNxHR awareness: intra-frame codecs (every frame is a keyframe) never need
 * to decode a GOP — seeking lands exactly on the target frame.
 */

#include <chrono>
#include <cstdint>
#include <list>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

// GpuDeviceManager.h guards NOMINMAX before <d3d11_4.h>
#include "GpuDeviceManager.h"
#include "FrameCache.h"       // FrameCacheEntry, FrameCacheKey
#include "Nv12Converter.h"    // hw path: NV12 → BGRA on the GPU

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
    // hw path: the CPU-side NV12 frame av_hwframe_transfer_data lands in.
    // Kept across decodes so the transfer reuses its buffers instead of
    // allocating (and page-faulting in) a fresh ~1.4 MB frame every time.
    AVFrame*         hwTransferFrame = nullptr;
    // The most recent frame decodeFrame() produced that fell SHORT of its
    // target. If the file ends before the target is reached, this is the
    // closest frame the file has and is what gets delivered — see decodeFrame.
    AVFrame*         closestFrame = nullptr;
    // hw path, GPU-resident variant: the NV12 texture the decoded array slice
    // is copied into (CopySubresourceRegion), with its two plane views. One
    // per stream, re-created only when the frame size changes; the BGRA
    // texture the shader renders from it is the cache entry, so this is the
    // only per-frame scratch and it never leaves the GPU.
    Microsoft::WRL::ComPtr<ID3D11Texture2D>          hwNv12Scratch;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> hwLumaSrv;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> hwChromaSrv;
    int              hwScratchW   = 0;
    int              hwScratchH   = 0;
    bool             hwGpuPathFailed = false;  // logged once; stream stays on the transfer path
    SwsContext*      swsCtx       = nullptr;   // sw path: src fmt → BGRA
    std::vector<uint8_t> bgraScratch;           // sws destination, reused per frame
    int              videoStreamIdx = -1;

    int              width        = 0;
    int              height       = 0;

    // Frame rate as an EXACT rational — never a double, and never rounded to an
    // integer. This used to be `double fps`, and the frame→PTS conversion built
    // its frame duration as AVRational{1, (int)round(fps)}, which snapped every
    // NTSC-fractional rate to an integer (23.976→24, 29.97→30, 59.94→60). The
    // resulting 1000/1001 error made the delivered frame drift earlier in
    // proportion to depth into the source. See render/FrameRateMath.h.
    AVRational       frameRate    = {30, 1};

    int64_t          lastDecodedFrame = -1;     // drives the auto sequential fast path
    bool             sequentialHint   = false;  // VESTIGIAL: never wired up; seekToFrame
                                                // now auto-detects via lastDecodedFrame
    bool             isIntraOnly      = false;  // DNxHR, MJPEG, ProRes, etc.
    bool             isHwAccel        = false;  // using D3D11VA path
    int              framesDecodedThisCall = 0; // diagnostics: frames decoded by the last decode()

    std::string      sourcePath;

    void close();
};

// ---------------------------------------------------------------------------
// RenderVideoDecoder
// ---------------------------------------------------------------------------
class RenderVideoDecoder
{
public:
    // Floor of the adaptive context budget, and its value until the first
    // frame reports a request set via setActiveContextBudget(). Kept as the
    // historical name/value — existing callers that never call
    // setActiveContextBudget() see the old fixed-4 behaviour unchanged.
    static constexpr int MAX_OPEN_CONTEXTS = 4;
    // Ceiling of the adaptive budget. An idle open FFmpeg context costs a
    // few hundred KB and a file handle, which is cheap up to this cap.
    static constexpr int kMaxOpenContextsCap = 32;
    // Default idle threshold for pruneIdleContexts().
    static constexpr double kIdleContextSeconds = 30.0;

    // ── Multiple decode streams per file ───────────────────────────────────
    // Several grid cells often play the SAME file at different offsets — with
    // the whole-source preview proxy that is every cell. One context per file
    // made them take turns: each cell's next frame had to seek away from where
    // the previous cell left the decoder, and on a long-GOP proxy every such
    // seek re-decodes up to a GOP (measured, BFDIA 9: 16-48 frames per miss,
    // 15-35 ms each, on seven interleaved offsets into one 720p H.264 proxy).
    // A file may therefore hold up to kMaxStreamsPerSource contexts; a request
    // goes to the stream that can reach it by decoding forward; otherwise an
    // idle stream is seeked, and a new stream is opened only while every
    // existing one has been used within kStreamBusyMs.
    static constexpr int    kMaxStreamsPerSource   = 6;
    // Extra streams are per-playing-cell and go stale quickly.
    static constexpr double kExtraStreamIdleSeconds = 5.0;
    // A stream used this recently is presumed to be following a playing cell.
    static constexpr int    kStreamBusyMs          = 200;
    // Containers with no keyframe index: decode forward instead of seeking
    // when the target is at most this many frames ahead.
    static constexpr int    kForwardDecodeFallbackFrames = 24;

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

    /** True when hardware-decoded frames are converted on the GPU (NV12 copy
     *  + shader) rather than through av_hwframe_transfer_data + sws_scale.
     *  Set up by initHwDevice(); false when the device cannot sample NV12 or
     *  XLETH_HW_NV12_GPU=0 is in the environment (A/B switch). */
    bool hwGpuPathAvailable() const { return nv12Converter_.isReady(); }

    /** Per-path frame counts since construction — the preview diagnostic and
     *  the perf gate read these to prove no hw frame took the CPU detour. */
    struct ExtractStats {
        uint64_t hwGpuFrames      = 0;   // D3D11VA → GPU copy + shader
        uint64_t hwTransferFrames = 0;   // D3D11VA → CPU transfer + sws_scale (fallback)
        uint64_t swFrames         = 0;   // software decode → sws_scale
    };
    const ExtractStats& extractStats() const { return extractStats_; }

    /** Cumulative decode() cost since construction. `opens` is the number of
     *  times a file was (re)opened — each one is an avformat open, a stream
     *  probe and a codec/D3D11VA init (`openUs` is the time spent in exactly
     *  that), so a count far above the number of distinct sources means
     *  contexts are being evicted and reopened. `seeks` counts requests no open
     *  stream could reach by decoding forward; `framesDecoded / calls` is how
     *  many codec frames each delivered frame cost (GOP walk-ups after a seek).
     *  The export logs this once per render. */
    struct DecodeStats {
        uint64_t calls         = 0;
        uint64_t opens         = 0;
        uint64_t seeks         = 0;
        uint64_t framesDecoded = 0;   // codec frames produced, incl. GOP walk-ups
        int64_t  openUs        = 0;
        int64_t  decodeUs      = 0;   // seek + packet read + codec
        int64_t  extractUs     = 0;   // texture extraction / colour convert
    };
    const DecodeStats& decodeStats() const { return decodeStats_; }

    /** Cap decoded frames to fit within w x h (aspect preserved, never
     *  upscaled); 0 x 0 = no cap, the default. The preview sets this to its
     *  compositor surface. Export never sets it, so export decodes originals
     *  at full size exactly as before. Takes effect on the next decode; frames
     *  already cached keep the size they were decoded at. */
    void setMaxOutputSize(int w, int h) { maxOutputW_ = w; maxOutputH_ = h; }

    /** Worker threads for SOFTWARE decode (frame + slice threading). 0 — the
     *  default — picks clamp(hardware_concurrency / 2, 1, kMaxDecodeThreads):
     *  half the machine, so the audio callback, the UI and the renderer keep
     *  their cores, capped because frame threading past four buys little at
     *  preview sizes. Applies to contexts opened AFTER the call. FFmpeg's own
     *  default is ONE thread, which left every sw decode (DNxHR proxies, any
     *  file D3D11VA declines, every export on a machine without hw decode)
     *  serial on one core. The hw (D3D11VA) path is unaffected. */
    void setDecodeThreads(int threads) { decodeThreads_ = threads; }
    static constexpr int kMaxDecodeThreads = 4;
    static int defaultDecodeThreads();

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

    /** Close the cached decoder context for ONE path, if open, releasing the
     *  file handle. Required before deleting/overwriting a file this decoder
     *  may have open: on Windows an open FFmpeg handle makes the delete fail,
     *  and a proxy that cannot be deleted is silently reused (see
     *  invalidateRegionProxy). Returns true if a context was actually closed.
     *  Caller must hold the compositor mutex — this mutates contexts_. */
    bool closeSource(const std::string& sourcePath);

    /** Full shutdown: close all contexts and release the hw device context.
     *  Call before destroying the D3D11 device (GpuDeviceManager). */
    void shutdown();

    /** After a file fails to open, refuse to try it again for this long.
     *
     *  0 (the default) retries on every request, which is what an export
     *  wants: each frame is decoded exactly once, so a retry costs nothing and
     *  a transient failure must not blank later frames.
     *
     *  The live preview asks for the same file again on EVERY tick. A source
     *  that cannot be opened — offline media, a drive that went away — would
     *  otherwise cost a failed avformat_open_input and a log line per cell,
     *  sixty times a second, for as long as it stays on screen. The preview
     *  sets a couple of seconds; the cell simply stays empty in between, and
     *  the file is picked up again shortly after it comes back.
     *
     *  closeSource() / closeAll() forget recorded failures, so a path that is
     *  about to be rewritten is retried straight away. */
    void setOpenFailureBackoff(double seconds) { openFailureBackoffSeconds_ = seconds; }

    /** True while `sourcePath` is inside its open-failure backoff, i.e. the
     *  last attempt to OPEN it failed. Lets the preview tell "this file cannot
     *  be opened" (drop the proxy, fall back to another file) from "this frame
     *  could not be decoded" (transient; keep the file). Always false when no
     *  backoff is configured. */
    bool openFailedRecently(const std::string& sourcePath) const
    {
        return failedOpens_.find(sourcePath) != failedOpens_.end();
    }

    /** Set sequential hint for a source. VESTIGIAL — kept for API
     *  compatibility only. seekToFrame() no longer consults this flag; the
     *  sequential fast path is auto-detected from lastDecodedFrame. No caller
     *  in engine/ or bridge/ ever invoked this. */
    void setSequentialHint(const std::string& sourcePath, bool hint);

    /** Number of currently open contexts. */
    int openContextCount() const { return static_cast<int>(contexts_.size()); }

    /** Size the open-context budget from the number of DISTINCT source paths
     *  the current frame's live request set needs (e.g. the count of unique
     *  FrameCacheKey::sourcePath values in deduplicateRequests()'s output,
     *  before checking the cache — a cache hit still represents a source
     *  the grid is actively using). Clamped to
     *  [MAX_OPEN_CONTEXTS, kMaxOpenContextsCap]. Call once per frame, before
     *  the decode-miss loop; cheap, no I/O, does not itself evict anything
     *  (the next stream open applies the new ceiling). */
    void setActiveContextBudget(int distinctPathCount);

    /** Close any open context untouched for >= idleSeconds, so a long
     *  session doesn't hold file handles/contexts forever. Never closes the
     *  context decode() is currently using. Call once per frame/tick from
     *  the video thread, BETWEEN decode() calls — not from inside one. */
    void pruneIdleContexts(double idleSeconds = kIdleContextSeconds);

    /** Drive the stream pool's notion of "now" from the OUTPUT timeline instead
     *  of the wall clock. Call once per output frame, before its decode()s,
     *  with that frame's presentation time.
     *
     *  The pool decides whether a stream is "busy following a playing cell" by
     *  how recently it was touched (kStreamBusyMs). That is a statement about
     *  playback time. The live preview runs at 1x, so wall time is playback
     *  time there. An offline render does not: 200 ms of wall time covers
     *  however much output the machine happens to get through, so which stream
     *  serves a request — and with it how many contexts get opened and how the
     *  decode work is ordered — depended on render speed, and the faster the
     *  export ran the more streams looked "busy". On the presentation clock the
     *  heuristic means what it was written to mean and a render makes the same
     *  stream choices on every machine at every speed.
     *
     *  This is about determinism, not speed: measured on a 4-source project it
     *  did not change the open count on its own (the frame-cache budget is what
     *  cut decode work — see exportFrameCacheBytes in OfflineRenderer.cpp).
     *
     *  Never called by the preview, which keeps the wall clock. */
    void setPresentationClock(double seconds);

    // ── Decode-path introspection (diagnostics) ─────────────────────────────
    // Reports the active decode path for each currently-open source so the
    // Visual Preview Diagnostic Log can show whether a 1080p source is being
    // hardware-decoded (D3D11VA) or software-decoded, and whether it is an
    // intra-only codec (DNxHR proxy) or a long-GOP original.
    enum class DecodePath { None, Hardware, Software };

    struct OpenSourceInfo {
        std::string sourcePath;
        DecodePath  path        = DecodePath::None;
        bool        intraOnly   = false;
        int         width       = 0;
        int         height      = 0;
    };

    /** Snapshot of every open decoder context (MRU→LRU order not guaranteed).
     *  Cheap copy; safe to call from the diagnostic reader thread when no
     *  decode is in flight (the preview pipeline is single-threaded). */
    std::vector<OpenSourceInfo> openSourceInfos() const;

    /** Active decode path for one source path, or None if it is not open. */
    DecodePath decodePathFor(const std::string& sourcePath) const;

private:
    // ── Context pool (LRU) ─────────────────────────────────────────────────
    // lruOrder_: front = MRU, back = LRU
    using LruList = std::list<std::string>;
    LruList lruOrder_;

    struct ContextEntry {
        DecoderContext      ctx;
        LruList::iterator   lruIt;
        std::chrono::steady_clock::time_point lastTouched;
        int                 streamIndex = 0;   // 0 = the file's primary stream
    };
    // Keyed by streamKey(path, i). Stream 0's key IS the path, so a plain
    // path lookup still finds a file's primary context.
    std::unordered_map<std::string, ContextEntry> contexts_;

    static std::string streamKey(const std::string& sourcePath, int streamIndex);
    // Picks (opening if need be) the stream that should decode frameIndex.
    DecoderContext* acquireStream(const std::string& sourcePath, int64_t frameIndex);
    // Opens a context under an explicit key (evicting to the budget first).
    ContextEntry* openStreamAt(const std::string& key, const std::string& sourcePath,
                               int streamIndex);
    // True if decoding forward from ctx's position reaches frameIndex without
    // passing a keyframe — i.e. forward is never more work than seeking.
    bool canContinueForward(const DecoderContext& ctx, int64_t frameIndex) const;
    bool closeKey(const std::string& key);

    // "Now" for stream recency: the wall clock, or the presentation clock once
    // setPresentationClock() has been called (offline render).
    std::chrono::steady_clock::time_point clockNow() const;
    bool   usePresentationClock_ = false;
    std::chrono::steady_clock::time_point presentationNow_{};

    // Adaptive ceiling applied by openStreamAt(); set via
    // setActiveContextBudget(), starts at the historical fixed value.
    int contextBudget_ = MAX_OPEN_CONTEXTS;

    // See setOpenFailureBackoff(). Keyed by source path (not stream key): a
    // file that will not open will not open as a second stream either.
    double openFailureBackoffSeconds_ = 0.0;
    std::unordered_map<std::string, std::chrono::steady_clock::time_point> failedOpens_;

    // Path decode() is currently servicing, if any. Eviction (LRU or idle)
    // skips this path so a frame's own decode can never be evicted out from
    // under itself on the video thread.
    std::string inFlightPath_;

    // Closes one LRU-eligible context (never inFlightPath_). Returns false
    // if nothing was safe to evict (e.g. every open context is pinned).
    bool evictLruContext();
    void promoteToMru(const std::string& sourcePath);

    // ── Open a source ──────────────────────────────────────────────────────
    bool openSource(DecoderContext& ctx, const std::string& sourcePath);

    // ── Decode paths ───────────────────────────────────────────────────────

    /**
     * Stream PTS to target for a given source frame index — the SINGLE place
     * that conversion happens. seekToFrame() and decodeFrame() both call this
     * so their targets cannot silently diverge (they previously each open-coded
     * the same buggy expression, and fixing one without the other would have
     * left the decoder hunting for a frame it never seeked to).
     * Delegates to xleth::frametiming::frameToPts.
     */
    static int64_t targetPtsForFrame(const DecoderContext& ctx, int64_t frameIndex);

    /** Seek to frame (or skip if sequential). Returns true on success. */
    bool seekToFrame(DecoderContext& ctx, int64_t frameIndex);

    /** Read packets until we get the target frame. */
    bool decodeFrame(DecoderContext& ctx, int64_t frameIndex);

    /** Path A: extract D3D11 texture from hw-decoded AVFrame. Tries the
     *  GPU-resident route (extractHwFrameOnGpu) first and falls back to the
     *  CPU transfer + uploadSwFrame when that is unavailable or fails. */
    FrameCacheEntry extractHwFrame(DecoderContext& ctx, AVFrame* frame,
                                   ID3D11Device* device, ID3D11DeviceContext* deviceCtx);

    /** Path A, GPU-resident: CopySubresourceRegion the decoded NV12 array
     *  slice into ctx.hwNv12Scratch, then render it through the NV12→BGRA
     *  shader into the cache entry's texture (downscaled to the
     *  setMaxOutputSize cap in the same pass). Empty entry on any failure. */
    FrameCacheEntry extractHwFrameOnGpu(DecoderContext& ctx, AVFrame* frame,
                                        ID3D11Device* device, ID3D11DeviceContext* deviceCtx);

    /** Path B: sws_scale to BGRA → staging texture → default texture + SRV. */
    FrameCacheEntry uploadSwFrame(DecoderContext& ctx, AVFrame* frame,
                                  ID3D11Device* device, ID3D11DeviceContext* deviceCtx);

    /** Output size for a decoded w x h frame under the setMaxOutputSize cap
     *  (aspect preserved, never upscaled). The ONE place both extraction
     *  paths compute it, so a hw- and a sw-decoded frame of the same source
     *  land in the cache at the same size and byte count. */
    void cappedOutputSize(int w, int h, int& outW, int& outH) const;

    // ── D3D11VA hw device context (shared across all decoder contexts) ──────
    AVBufferRef* hwDeviceCtx_ = nullptr;   // AVHWDeviceContext wrapping our device

    // NV12 → BGRA shader pass for the GPU-resident hw path (initHwDevice).
    Nv12Converter nv12Converter_;
    ExtractStats  extractStats_;
    DecodeStats   decodeStats_;

    int maxOutputW_ = 0;   // setMaxOutputSize(); 0 = decode size
    int maxOutputH_ = 0;
    int decodeThreads_ = 0;   // setDecodeThreads(); 0 = defaultDecodeThreads()
};
