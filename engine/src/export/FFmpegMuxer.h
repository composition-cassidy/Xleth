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

    // ── Video ──────────────────────────────────────────────────────────────
    enum class VideoCodec { H264, H265, AV1, DNXHD, PRORES, MPEG4 };
    VideoCodec  videoCodec      = VideoCodec::H264;
    int         width           = 1920;
    int         height          = 1080;
    int         fpsNum          = 30;       // AVRational = {fpsNum, fpsDen}
    int         fpsDen          = 1;
    int         crf             = 23;       // -1 = disable CRF, use bitrate
    int         videoBitrate    = 0;        // bps, 0 = codec default / CRF mode
    std::string hwEncoderName;              // "h264_nvenc", "h264_amf", or "" for auto

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

    // Names cached after encoder selection
    const char* videoEncoderName_ = "none";
    const char* audioEncoderName_ = "none";

    // ── Internal helpers ───────────────────────────────────────────────────
    bool initVideoStream(const ExportSettings& s);
    bool initAudioStream(const ExportSettings& s);
    bool drainPackets(AVCodecContext* encCtx, AVStream* stream);
    bool flushEncoder(AVCodecContext* encCtx, AVStream* stream);
    bool encodeAudioFrame();
    void cleanup();

    static const void* findVideoEncoder(ExportSettings::VideoCodec codec,
                                         const std::string& hwName);
    static const void* findAudioEncoder(ExportSettings::AudioCodec codec);
};
