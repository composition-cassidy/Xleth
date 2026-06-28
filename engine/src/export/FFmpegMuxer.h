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
 *   Audio: float planar → swr_convert → encoder sample_fmt → avcodec → muxer
 *
 * Audio frame buffering: AAC requires exactly 1024 samples per frame.
 * Incoming audio is staged in a float buffer; when a full frame accumulates
 * it is resampled and encoded.  Residual samples are zero-padded at finalize().
 *
 * Encoder flushing: NULL frame → drain loop → AVERROR_EOF.  Critical for
 * H.264/H.265 where B-frame reordering delays the last few frames.
 *
 * No JUCE dependency in this header — audio arrives as raw float pointers.
 */

#include <cstdint>
#include <string>
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
    int         sampleRate      = 48000;
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
     * Encode audio samples.  Internally buffers to match the encoder's
     * frame_size requirement (e.g. 1024 for AAC).
     *
     * @param channels        Channel pointers: channels[0]=L, channels[1]=R
     * @param numSamples      Number of samples in this chunk (any count)
     * @param samplesWritten  Cumulative sample count BEFORE this chunk (PTS base)
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
    SwrContext*      swrCtx_        = nullptr;    // float planar → encoder fmt

    AVPacket*        pkt_           = nullptr;    // shared encode → mux packet

    // ── Audio frame buffering ──────────────────────────────────────────────
    std::vector<float> audioStagingL_;
    std::vector<float> audioStagingR_;
    int  audioBufferSamples_ = 0;     // samples currently in staging
    int  audioFrameSize_     = 0;     // encoder frame_size (1024 for AAC)

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
    bool drainPackets(AVCodecContext* encCtx, AVStream* stream);
    bool flushEncoder(AVCodecContext* encCtx, AVStream* stream);
    bool encodeAudioFrame();
    void cleanup();

    static const void* findAudioEncoder(ExportSettings::AudioCodec codec);
};
