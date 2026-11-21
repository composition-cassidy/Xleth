#pragma once

/**
 * FFmpegMuxer — Write audio + video into an MP4 container using the FFmpeg C API.
 *
 * This is the render pipeline's output stage.  The caller feeds BGRA video
 * frames (from GridCompositor::readback) and de-interleaved float audio
 * (from MixEngine) into the muxer, which encodes and interleaves them into
 * a single MP4 file.
 *
 * Two encode paths:
 *   Video: BGRA → sws_scale → encoder pix_fmt → avcodec → muxer
 *   Audio: float planar @ mix rate → swr (format + sample-rate conversion)
 *          → FIFO @ encoder rate → encoder frames → avcodec → muxer
 *
 * Audio is a real streaming resampler, not a per-frame format shim: the caller
 * feeds PCM at ExportSettings::mixSampleRate in chunks of any size, swr turns
 * it into the encoder's format AND rate, and whatever it produces is queued in
 * a FIFO that is cut into encoder-sized frames (AAC needs exactly 1024). The
 * mix rate, the requested output rate and the rate the codec can actually run
 * at are three separate numbers and none of them has to match another. PTS
 * counts samples at the ENCODER rate, so A/V sync holds whatever the ratio.
 * finalize() drains the resampler and sends the last short frame as-is.
 *
 * Encoder flushing: NULL frame → drain loop → AVERROR_EOF.  Critical for
 * H.264/H.265 where B-frame reordering delays the last few frames.
 *
 * Async video encode (RENDER_PERF_AUDIT Finding 6a): enableAsyncVideo(depth)
 * moves [sws_scale → avcodec_send_frame → drain] onto a worker thread fed by a
 * BOUNDED queue, so the caller's [decode → composite → readback] overlaps the
 * convert+encode instead of waiting for it. The worker consumes strictly FIFO,
 * so the encoder is handed the identical frame sequence in the identical order
 * the serial path fed it — the encoded bitstream is unchanged. Only the writes
 * into the shared AVFormatContext are serialised (muxMutex_); the expensive
 * stages run on per-stream state outside that lock.
 *
 * No JUCE dependency in this header — audio arrives as raw float pointers.
 */

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// Forward-declare FFmpeg opaque types to avoid pulling heavy headers
struct AVFormatContext;
struct AVCodecContext;
struct AVStream;
struct AVFrame;
struct AVPacket;
struct SwsContext;
struct SwrContext;

// ---------------------------------------------------------------------------
// ExportSettings — configuration for the muxer
// ---------------------------------------------------------------------------
struct ExportSettings {
    std::string outputPath;

    // ── Render input (full quality vs fast/proxy) ────────────────────────────
    // true  = "Full quality (no render proxy)": every element decodes from the
    //         ORIGINAL source, so bit-exact source pixels reach the encoder and
    //         CRF/bitrate operate on full-quality input. This is the DEFAULT and
    //         the recommended setting for final export.
    // false = "Fast export (proxy)": the renderer builds a resolution-aware,
    //         footprint-sized whole-source proxy per heavily-reused source (see
    //         OfflineRenderer::buildRenderProxyPlan) and decodes from it. Sized to
    //         each element's PEAK on-screen footprint at the output resolution and
    //         rounded UP to a bucket, so there is no visible quality loss at output
    //         resolution while a 4K→1080p grid render is dramatically faster.
    //         Sources shown at/near full resolution, and single-use linear sources,
    //         stay on the original. 10-bit sources keep 10-bit proxies.
    bool        useSourceMedia  = true;

    // ── Video ──────────────────────────────────────────────────────────────
    enum class VideoCodec { H264, H265, AV1, DNXHD, PRORES, MPEG4 };
    VideoCodec  videoCodec      = VideoCodec::H264;
    int         width           = 1920;
    int         height          = 1080;
    int         fpsNum          = 30;       // AVRational = {fpsNum, fpsDen}
    int         fpsDen          = 1;
    // ── Rate control ─────────────────────────────────────────────────────────
    // The mode is EXPLICIT, not inferred from which of crf/videoBitrate is set.
    // (Inferring was the historical bug: the crf default below leaked into
    //  bitrate-mode exports and made libx264 ignore the requested bitrate.)
    enum class RateControl {
        CRF,      // constant quality — crf field drives the encoder
        Bitrate   // target/constant bitrate — videoBitrate field drives the encoder
    };
    RateControl rateControl     = RateControl::CRF;

    int         crf             = 23;       // 0..51 quality. <0 = legacy "use bitrate" sentinel
    int         videoBitrate    = 0;        // bps, 0 = codec/resolution-scaled default
    std::string hwEncoderName;              // "h264_nvenc", "h264_amf", or "" for auto

    // ── Video mode ─────────────────────────────────────────────────────────
    enum class VideoMode {
        Auto,     // try HW first, fall through to software on failure
        Software, // software encode/decode only; display compositing still uses OpenGL
        Hardware  // require HW encode/decode; fail loudly if unavailable
    };
    VideoMode videoMode = VideoMode::Auto;

    // ── Canvas fit ───────────────────────────────────────────────────────────
    // How the project authoring canvas (GridLayout.canvasWidth × canvasHeight)
    // is fitted when width × height above describe a different aspect ratio.
    // Stretch is the legacy fill behavior and the only effect when the export
    // aspect matches the project aspect. See render/CanvasFit.h.
    enum class FitMode { Stretch, Crop, Bars };
    FitMode fitMode = FitMode::Stretch;

    // ── Audio ──────────────────────────────────────────────────────────────
    enum class AudioCodec { AAC, OPUS, FLAC, PCM_S16LE };
    AudioCodec  audioCodec      = AudioCodec::AAC;
    // Sample rate of the ENCODED audio stream the user asked for. The codec may
    // not support it (Opus only runs at 48 kHz) — the muxer then picks the
    // nearest supported rate and resamples to that instead.
    int         sampleRate      = 48000;
    // Sample rate of the PCM handed to writeAudio() — the rate the mix was
    // rendered at. 0 = same as sampleRate. Keeping this separate is what lets
    // the renderer mix at the session rate (so an export sounds exactly like
    // playback, at any output rate) and leave the conversion to the muxer.
    int         mixSampleRate   = 0;
    int audioInputRate() const { return mixSampleRate > 0 ? mixSampleRate : sampleRate; }
    int         audioBitrate    = 192;      // kbps (AAC/OPUS)
    int         audioChannels   = 2;

    // ── Container ──────────────────────────────────────────────────────────
    bool        fragmentedMP4   = false;    // movflags=frag_keyframe+empty_moov
};

// ---------------------------------------------------------------------------
// Rate-control resolution (pure, unit-testable)
// ---------------------------------------------------------------------------
//
// Different encoders expose constant-quality through different knobs:
//   libx264/libx265/libsvtav1/libaom  → "crf" private option
//   *_nvenc                           → rc=constqp + qp
//   *_amf                             → rc=cqp + qp_i/qp_p/qp_b
//   *_qsv                             → global_quality (ICQ)
//   *_mf                              → rate_control=quality + quality (0..100)
//   mpeg4/dnxhd/prores (no CRF knob)  → fall back to a sane target bitrate
//
// resolveRateControl() turns an ExportSettings + encoder name into the exact
// set of values FFmpegMuxer applies to the AVCodecContext. Keeping it a pure
// function lets tests assert that CRF/bitrate survive into encoder config
// without opening a real encoder.
struct ResolvedRateControl {
    bool        bitrateMode      = false;   // true → target/constant bitrate
    int64_t     bitrate          = 0;       // bps → AVCodecContext::bit_rate (0 = leave default)
    bool        setCrfPrivOpt    = false;   // libx264-family: priv_data "crf"
    int         crf              = -1;
    const char* rcModeKey        = nullptr; // priv_data RC-mode key ("rc"/"rate_control") or null
    const char* rcModeVal        = nullptr; // value for rcModeKey
    const char* qpOptKey         = nullptr; // priv_data int QP key ("qp"/"qp_i"/"quality") or null
    int         qpValue          = -1;
    bool        amfTripleQp      = false;   // also set qp_p/qp_b (AMF cqp)
    bool        useGlobalQuality = false;   // qsv ICQ via AVCodecContext::global_quality
    int         globalQuality    = -1;
    const char* notes            = "";      // short human description for logs
};

// Resolution/fps-scaled default video bitrate (bps) — used when bitrate mode is
// requested with 0, or when a codec has no recognized constant-quality control.
int64_t defaultVideoBitrate(int width, int height, int fpsNum, int fpsDen);

// Compute the encoder-specific rate-control plan. Pure; no FFmpeg state touched.
ResolvedRateControl resolveRateControl(const char* encoderName, const ExportSettings& s);

// ---------------------------------------------------------------------------
// FFmpegMuxer
// ---------------------------------------------------------------------------
class FFmpegMuxer
{
public:
    FFmpegMuxer();
    ~FFmpegMuxer();

    // Non-copyable, non-movable
    FFmpegMuxer(const FFmpegMuxer&)            = delete;
    FFmpegMuxer& operator=(const FFmpegMuxer&) = delete;

    // ── Lifecycle ──────────────────────────────────────────────────────────

    /**
     * Open output file, configure video + audio streams, write container header.
     * Returns true on success.
     */
    bool init(const ExportSettings& settings);

    /**
     * Encode one video frame from BGRA pixel data.
     * @param bgraPixels  Pointer to width×height×4 bytes in BGRA order
     * @param stride      Bytes per row (typically width×4)
     * @param frameIndex  0-based output frame number (used as video PTS)
     */
    bool writeVideo(const uint8_t* bgraPixels, int stride, int64_t frameIndex);

    /**
     * Zero-copy variant of writeVideo() for a producer that can render straight
     * into the muxer's memory (GridCompositor::readback with a destination).
     *
     * acquireVideoBuffer() returns a tightly packed width×height×4 BGRA buffer
     * (stride = width×4). On the async path it is one of the pooled queue
     * buffers, so it blocks exactly where writeVideo() would have blocked — when
     * the producer is a full queue ahead of the encoder. Fill it, then either
     * submitVideoBuffer() it (queued/encoded as frame `frameIndex`) or
     * releaseVideoBuffer() it unused. Returns nullptr once encoding has failed.
     * At most one buffer is out at a time; do not interleave with writeVideo()
     * while one is held.
     */
    uint8_t* acquireVideoBuffer();
    bool     submitVideoBuffer(int64_t frameIndex);
    void     releaseVideoBuffer();

    /** Bytes in one acquireVideoBuffer() frame (width × height × 4). */
    size_t videoBufferBytes() const;

    /**
     * Finding 6a — enable the pipelined video encode path.
     *
     * Must be called AFTER a successful init() and BEFORE the first
     * writeVideo(). writeVideo() then copies the BGRA frame into a pooled
     * buffer, hands it to a worker thread and returns; the worker performs the
     * colour conversion, the encode and the mux. `queueDepth` frames may be in
     * flight (plus the one being encoded), so peak extra memory is bounded at
     * (queueDepth + 1) × width × height × 4 bytes and writeVideo() blocks once
     * the producer runs that far ahead of the encoder.
     *
     * queueDepth <= 0 leaves the muxer strictly synchronous.
     *
     * Encoder input order is unchanged (single FIFO consumer), so the output is
     * identical to the serial path's. A worker-side failure is latched: the next
     * writeVideo() and finalize() both return false.
     */
    void enableAsyncVideo(int queueDepth);

    /** True while the async video worker thread is running. */
    bool isAsyncVideo() const { return videoWorkerRunning_; }

    /**
     * Encode audio samples at ExportSettings::audioInputRate(). Resamples to
     * the encoder's rate/format and buffers to its frame_size requirement
     * (e.g. 1024 for AAC).
     *
     * @param channels        Channel pointers: channels[0]=L, channels[1]=R
     *                        (channels[1] may be null: mono is duplicated)
     * @param numSamples      Number of samples in this chunk (any count)
     * @param samplesWritten  Unused — PTS is derived from the samples actually
     *                        encoded. Kept for source compatibility.
     */
    bool writeAudio(const float* const* channels, int numSamples,
                    int64_t samplesWritten);

    /**
     * Flush residual audio buffer, flush both encoders, write trailer, close file.
     * Must be called exactly once after all writeVideo/writeAudio calls.
     */
    bool finalize();

    // ── Query ──────────────────────────────────────────────────────────────

    /** True if video PTS <= audio PTS (caller should produce video next). */
    bool shouldWriteVideo() const;

    /** Name of the video encoder actually selected. */
    const char* videoEncoderName() const;

    /** True if the chosen video encoder was not the first candidate — i.e., at
     *  least one higher-priority (hardware) encoder was tried and rejected by
     *  avcodec_open2 before falling back to the selected one. */
    bool isVideoEncoderFallback() const;

    /** Name of the audio encoder actually selected. */
    const char* audioEncoderName() const;

    /** True when the requested audio codec had no usable encoder in this FFmpeg
     *  build and AAC was used instead (Opus without libopus: FFmpeg's built-in
     *  Opus encoder is experimental and drops audio, so it is never used). */
    bool isAudioCodecFallback() const { return audioCodecFallback_; }

    /** Sample rate of the encoded audio stream (may differ from the request). */
    int audioEncoderSampleRate() const;

    bool isInitialized() const { return initialized_; }

private:
    // ── FFmpeg state ───────────────────────────────────────────────────────
    AVFormatContext* fmtCtx_        = nullptr;

    AVCodecContext*  videoCodecCtx_ = nullptr;
    AVStream*        videoStream_   = nullptr;
    AVFrame*         videoFrame_    = nullptr;    // encoder pix_fmt
    SwsContext*      swsCtx_        = nullptr;    // BGRA → encoder pix_fmt

    AVCodecContext*  audioCodecCtx_ = nullptr;
    AVStream*        audioStream_   = nullptr;
    AVFrame*         audioFrame_    = nullptr;    // encoder sample_fmt
    SwrContext*      swrCtx_        = nullptr;    // float planar @ mix rate → encoder fmt @ encoder rate
    struct AVAudioFifo* audioFifo_  = nullptr;    // converted samples awaiting a full encoder frame
    uint8_t**        audioConv_     = nullptr;    // swr output scratch (encoder fmt)
    int              audioConvCap_  = 0;          // samples audioConv_ can hold

    AVPacket*        pkt_           = nullptr;    // shared encode → mux packet

    // ── Async video encode (Finding 6a) ─────────────────────────────
    // One frame of work handed to the encode worker. `pixels` is recycled
    // through videoFree_, so the steady state allocates nothing.
    struct VideoJob {
        std::vector<uint8_t> pixels;
        int                  stride     = 0;
        int64_t              frameIndex = 0;
    };

    // Serialises av_interleaved_write_frame() on fmtCtx_ between the audio
    // drain (caller thread) and the video drain (worker thread). Held ONLY
    // across that one call — sws_scale and avcodec_* touch per-stream state and
    // stay outside it, which is where the whole win comes from.
    std::mutex               muxMutex_;

    AVPacket*                videoPkt_ = nullptr;   // worker's packet; pkt_ stays the caller's

    std::thread              videoWorker_;
    std::mutex               videoQueueMutex_;
    std::condition_variable  videoReadyCv_;   // producer → worker: a frame is queued
    std::condition_variable  videoFreeCv_;    // worker → producer: a buffer was recycled
    std::deque<VideoJob>             videoReady_;
    std::deque<std::vector<uint8_t>> videoFree_;
    int                      videoQueueDepth_    = 0;
    bool                     videoWorkerRunning_ = false;
    bool                     videoWorkerStop_    = false;  // guarded by videoQueueMutex_
    std::atomic<bool>        videoAsyncFailed_{false};
    int64_t                  videoAsyncFailFrame_ = -1;

    // ── Audio frame buffering ──────────────────────────────────────────────
    int  audioFrameSize_     = 0;     // encoder frame_size (1024 for AAC)
    bool audioCodecFallback_ = false;

    // ── Zero-copy video submit ─────────────────────────────────────────────
    std::vector<uint8_t> videoHeld_;          // buffer handed out by acquireVideoBuffer()
    bool                 videoHeldOut_ = false;

    // ── PTS tracking ───────────────────────────────────────────────────────
    int64_t videoPts_ = 0;
    int64_t audioPts_ = 0;

    // ── Counters (for logging) ─────────────────────────────────────────────
    int64_t videoPacketCount_ = 0;
    int64_t audioPacketCount_ = 0;

    // ── State flags ────────────────────────────────────────────────────────
    bool headerWritten_  = false;
    bool trailerWritten_ = false;
    bool fileOpened_     = false;
    bool initialized_    = false;

    ExportSettings settings_;

    // Names and fallback flag cached after encoder selection
    const char* videoEncoderName_     = "none";
    bool        videoEncoderFallback_ = false;
    const char* audioEncoderName_     = "none";

    // ── Internal helpers ───────────────────────────────────────────────────
    bool initVideoStream(const ExportSettings& s);
    bool initAudioStream(const ExportSettings& s);
    bool drainPackets(AVCodecContext* encCtx, AVStream* stream, AVPacket* pkt);
    // sws_scale + send_frame + drain for ONE video frame. Runs on the caller
    // thread when synchronous, on videoWorker_ when async; `pkt` keeps the two
    // paths off each other's AVPacket.
    bool encodeVideoFrame(const uint8_t* bgraPixels, int stride, int64_t frameIndex,
                          AVPacket* pkt);
    void videoWorkerLoop();
    void stopVideoWorker();   // drains the queue, then joins. Idempotent.
    bool flushEncoder(AVCodecContext* encCtx, AVStream* stream);
    // Resample `numSamples` of input (or drain the resampler when in == null)
    // into audioFifo_.
    bool convertAudioIntoFifo(const uint8_t* const* in, int numSamples);
    // Pop `numSamples` (<= frame size) from audioFifo_ and encode them.
    bool encodeAudioFromFifo(int numSamples);
    // Queue (async) or encode (sync) an owned BGRA frame.
    bool enqueueVideoBuffer(std::vector<uint8_t>&& pixels, int stride, int64_t frameIndex);
    void cleanup();

    // Resolves the encoder for `codec`; sets *fellBack when a different codec
    // had to be substituted.
    static const void* findAudioEncoder(ExportSettings::AudioCodec codec, bool* fellBack);
};
