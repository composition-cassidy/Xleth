#include "export/FFmpegMuxer.h"

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
#include <libavutil/samplefmt.h>
#include <libavutil/frame.h>
#include <libavutil/imgutils.h>
#include <libavutil/mathematics.h>
#include <libavutil/pixfmt.h>
#include <libavutil/error.h>
}

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static void logAvError(const char* msg, int errCode)
{
    char buf[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(errCode, buf, sizeof(buf));
    std::fprintf(stderr, "[Muxer] ERROR: %s (av_err=%d '%s')\n", msg, errCode, buf);
}

/** Pick the best sample format supported by the encoder. */
static AVSampleFormat pickSampleFormat(const AVCodec* codec, AVSampleFormat preferred)
{
    if (!codec) return preferred;

    const AVSampleFormat* fmts = nullptr;
    int numFmts = 0;
    int ret = avcodec_get_supported_config(nullptr, codec,
                  AV_CODEC_CONFIG_SAMPLE_FORMAT, 0,
                  reinterpret_cast<const void**>(&fmts), &numFmts);
    if (ret < 0 || !fmts || numFmts == 0)
        return preferred;

    for (int i = 0; i < numFmts && fmts[i] != AV_SAMPLE_FMT_NONE; ++i)
        if (fmts[i] == preferred)
            return preferred;
    return fmts[0];
}

/** Pick a supported sample rate (prefer the requested one). */
static int pickSampleRate(const AVCodec* codec, int preferred)
{
    if (!codec) return preferred;

    const int* rates = nullptr;
    int numRates = 0;
    int ret = avcodec_get_supported_config(nullptr, codec,
                  AV_CODEC_CONFIG_SAMPLE_RATE, 0,
                  reinterpret_cast<const void**>(&rates), &numRates);
    if (ret < 0 || !rates || numRates == 0)
        return preferred;

    int best = 0;
    for (int i = 0; i < numRates && rates[i]; ++i) {
        if (rates[i] == preferred)
            return preferred;
        if (!best || std::abs(rates[i] - preferred) < std::abs(best - preferred))
            best = rates[i];
    }
    return best ? best : preferred;
}

// ===========================================================================
// Constructor / Destructor
// ===========================================================================

FFmpegMuxer::FFmpegMuxer() = default;

FFmpegMuxer::~FFmpegMuxer()
{
    cleanup();
}

// ===========================================================================
// cleanup — release all FFmpeg resources
// ===========================================================================

void FFmpegMuxer::cleanup()
{
    // Defensive trailer write if init succeeded but finalize wasn't called
    if (fmtCtx_ && headerWritten_ && !trailerWritten_) {
        av_write_trailer(fmtCtx_);
        trailerWritten_ = true;
    }

    if (videoFrame_)    av_frame_free(&videoFrame_);
    if (audioFrame_)    av_frame_free(&audioFrame_);
    if (pkt_)           av_packet_free(&pkt_);
    if (swsCtx_)        { sws_freeContext(swsCtx_);         swsCtx_        = nullptr; }
    if (swrCtx_)        { swr_free(&swrCtx_);                                         }
    if (videoCodecCtx_) { avcodec_free_context(&videoCodecCtx_);                      }
    if (audioCodecCtx_) { avcodec_free_context(&audioCodecCtx_);                      }
    if (fmtCtx_) {
        if (fileOpened_ && fmtCtx_->pb)
            avio_closep(&fmtCtx_->pb);
        avformat_free_context(fmtCtx_);
        fmtCtx_ = nullptr;
    }

    audioStagingL_.clear();
    audioStagingR_.clear();
    audioBufferSamples_ = 0;
    audioFrameSize_     = 0;
    videoPts_           = 0;
    audioPts_           = 0;
    videoPacketCount_   = 0;
    audioPacketCount_   = 0;
    headerWritten_      = false;
    trailerWritten_     = false;
    fileOpened_         = false;
    initialized_        = false;
    videoEncoderName_     = "none";
    videoEncoderFallback_ = false;
    audioEncoderName_     = "none";
}

// ===========================================================================
// Encoder lookup
// ===========================================================================

// Returns true for encoder names that require GPU driver support.
static bool isHardwareEncoderName(const char* name) {
    return std::strstr(name, "_nvenc") || std::strstr(name, "_amf") ||
           std::strstr(name, "_qsv")   || std::strstr(name, "_mf");
}

// Build an ordered list of compiled-in encoder candidates for a codec family.
// The explicit hwName (if non-empty) is inserted first. Duplicates are dropped.
// VideoMode::Software skips all hardware entries; Hardware skips software entries.
static std::vector<const AVCodec*> buildVideoEncoderCandidates(
    ExportSettings::VideoCodec codec, const std::string& hwName,
    ExportSettings::VideoMode mode)
{
    using VC = ExportSettings::VideoCodec;
    using VM = ExportSettings::VideoMode;
    std::vector<const AVCodec*> result;

    auto push = [&](const char* name) {
        bool isHw = isHardwareEncoderName(name);
        if (mode == VM::Software && isHw)  return;  // skip HW in Software mode
        if (mode == VM::Hardware && !isHw) return;  // skip SW in Hardware mode
        const AVCodec* c = avcodec_find_encoder_by_name(name);
        if (!c) return;
        for (const auto* e : result) if (e == c) return;
        result.push_back(c);
    };
    auto pushId = [&](AVCodecID id) {
        if (mode == VM::Hardware) return;  // ID-based lookups yield SW codecs only
        const AVCodec* c = avcodec_find_encoder(id);
        if (!c) return;
        for (const auto* e : result) if (e == c) return;
        result.push_back(c);
    };

    if (!hwName.empty()) push(hwName.c_str());

    switch (codec) {
        case VC::H264:
            for (const char* n : {"h264_nvenc", "h264_amf", "h264_qsv", "h264_mf", "libx264"})
                push(n);
            pushId(AV_CODEC_ID_MPEG4);   // absolute last-resort
            break;
        case VC::H265:
            for (const char* n : {"hevc_nvenc", "hevc_amf", "hevc_qsv", "hevc_mf", "libx265"})
                push(n);
            break;
        case VC::AV1:
            for (const char* n : {"av1_nvenc", "av1_amf", "av1_qsv", "libsvtav1", "libaom-av1"})
                push(n);
            break;
        case VC::DNXHD:  pushId(AV_CODEC_ID_DNXHD); break;
        case VC::PRORES: push("prores_ks");           break;
        case VC::MPEG4:  pushId(AV_CODEC_ID_MPEG4);  break;
    }
    return result;
}

// ===========================================================================
// Rate-control resolution (pure — see header)
// ===========================================================================

int64_t defaultVideoBitrate(int width, int height, int fpsNum, int fpsDen)
{
    if (width <= 0 || height <= 0) { width = 1920; height = 1080; }
    double fps = (fpsDen > 0) ? static_cast<double>(fpsNum) / fpsDen : 30.0;
    if (fps <= 0.0) fps = 30.0;

    // ~0.10 bits per pixel·frame — a conservative H.264 "looks good" rule of
    // thumb (1080p30 ≈ 6.2 Mbps, 1080p60 ≈ 12 Mbps, 4K60 ≈ 50 Mbps).
    double bps = static_cast<double>(width) * static_cast<double>(height) * fps * 0.10;

    int64_t br = static_cast<int64_t>(bps);
    const int64_t kMin = 2'000'000;     // never proxy-grade
    const int64_t kMax = 120'000'000;   // sanity cap
    if (br < kMin) br = kMin;
    if (br > kMax) br = kMax;
    return br;
}

ResolvedRateControl resolveRateControl(const char* encoderName, const ExportSettings& s)
{
    ResolvedRateControl r;
    const char* name = encoderName ? encoderName : "";

    const bool isNvenc = std::strstr(name, "_nvenc") != nullptr;
    const bool isAmf   = std::strstr(name, "_amf")   != nullptr;
    const bool isQsv   = std::strstr(name, "_qsv")   != nullptr;
    const bool isMf    = std::strstr(name, "_mf")    != nullptr;
    // Encoders that expose libx264-style "crf".
    const bool hasCrfOpt = std::strstr(name, "libx264")   != nullptr
                        || std::strstr(name, "libx265")   != nullptr
                        || std::strstr(name, "libsvtav1") != nullptr
                        || std::strstr(name, "libaom")    != nullptr;

    // crf < 0 is the long-standing "disable CRF, use bitrate" sentinel (header,
    // and every existing test). Honor it even when rateControl was left default.
    const bool bitrateMode =
        (s.rateControl == ExportSettings::RateControl::Bitrate) || (s.crf < 0);

    if (bitrateMode) {
        r.bitrateMode = true;
        r.bitrate = (s.videoBitrate > 0)
                        ? static_cast<int64_t>(s.videoBitrate)
                        : defaultVideoBitrate(s.width, s.height, s.fpsNum, s.fpsDen);
        // Hardware defaults vary by driver — pin an explicit VBR mode.
        if      (isNvenc) { r.rcModeKey = "rc";           r.rcModeVal = "vbr"; }
        else if (isAmf)   { r.rcModeKey = "rc";           r.rcModeVal = "vbr_peak"; }
        else if (isMf)    { r.rcModeKey = "rate_control"; r.rcModeVal = "u_vbr"; }
        // qsv + software select VBR/ABR implicitly once bit_rate is set.
        r.notes = "bitrate";
        return r;
    }

    // ── Constant-quality (CRF) mode ──────────────────────────────────────────
    int q = s.crf;
    if (q < 0)  q = 23;
    if (q > 51) q = 51;
    r.crf = q;

    if (hasCrfOpt) {
        r.setCrfPrivOpt = true;
        r.notes = "crf(priv)";
    } else if (isNvenc) {
        r.rcModeKey = "rc";  r.rcModeVal = "constqp";
        r.qpOptKey  = "qp";  r.qpValue   = q;          // NVENC qp shares x264's 0..51 scale
        r.notes = "nvenc constqp";
    } else if (isAmf) {
        r.rcModeKey = "rc";   r.rcModeVal = "cqp";
        r.qpOptKey  = "qp_i"; r.qpValue   = q; r.amfTripleQp = true;
        r.notes = "amf cqp";
    } else if (isQsv) {
        r.useGlobalQuality = true; r.globalQuality = q; // ICQ quality
        r.notes = "qsv icq";
    } else if (isMf) {
        // Media Foundation "quality" is 0..100, higher = better. Map x264 CRF
        // (0..51, lower = better) onto it. Approximate but honest, not a fake crf.
        int mfq = static_cast<int>(std::lround((51.0 - q) / 51.0 * 100.0));
        if (mfq < 0)   mfq = 0;
        if (mfq > 100) mfq = 100;
        r.rcModeKey = "rate_control"; r.rcModeVal = "quality";
        r.qpOptKey  = "quality";      r.qpValue   = mfq;
        r.notes = "mf quality";
    } else {
        // mpeg4 / dnxhd / prores have no recognized constant-quality knob: pick a
        // sane explicit bitrate so output is not proxy-grade.
        r.bitrateMode = true;
        r.bitrate = (s.videoBitrate > 0)
                        ? static_cast<int64_t>(s.videoBitrate)
                        : defaultVideoBitrate(s.width, s.height, s.fpsNum, s.fpsDen);
        r.notes = "no-crf-support→default bitrate";
    }
    return r;
}

const void* FFmpegMuxer::findAudioEncoder(ExportSettings::AudioCodec codec)
{
    using AC = ExportSettings::AudioCodec;
    switch (codec) {
        case AC::AAC:       return avcodec_find_encoder(AV_CODEC_ID_AAC);
        case AC::OPUS:      return avcodec_find_encoder(AV_CODEC_ID_OPUS);
        case AC::FLAC:      return avcodec_find_encoder(AV_CODEC_ID_FLAC);
        case AC::PCM_S16LE: return avcodec_find_encoder(AV_CODEC_ID_PCM_S16LE);
    }
    return nullptr;
}

// ===========================================================================
// init
// ===========================================================================

bool FFmpegMuxer::init(const ExportSettings& settings)
{
    cleanup();
    settings_ = settings;

    // 1. Allocate output format context
    int ret = avformat_alloc_output_context2(&fmtCtx_, nullptr, "mp4",
                                              settings.outputPath.c_str());
    if (ret < 0 || !fmtCtx_) {
        logAvError("avformat_alloc_output_context2", ret);
        return false;
    }

    std::fprintf(stderr, "[Muxer] Init: container=mp4 path='%s'\n",
                 settings.outputPath.c_str());

    // 2. Init streams
    if (!initVideoStream(settings)) { cleanup(); return false; }
    if (!initAudioStream(settings)) { cleanup(); return false; }

    // 3. Allocate shared packet
    pkt_ = av_packet_alloc();
    if (!pkt_) { cleanup(); return false; }

    // 4. Open output file
    if (!(fmtCtx_->oformat->flags & AVFMT_NOFILE)) {
        ret = avio_open(&fmtCtx_->pb, settings.outputPath.c_str(), AVIO_FLAG_WRITE);
        if (ret < 0) {
            logAvError("avio_open", ret);
            cleanup();
            return false;
        }
        fileOpened_ = true;
    }

    // 5. Write header (opts may contain movflags)
    AVDictionary* opts = nullptr;
    if (settings.fragmentedMP4) {
        av_dict_set(&opts, "movflags", "frag_keyframe+empty_moov", 0);
        std::fprintf(stderr, "[Muxer] movflags set: frag_keyframe+empty_moov (fragmented MP4)\n");
    }

    ret = avformat_write_header(fmtCtx_, &opts);
    av_dict_free(&opts);
    if (ret < 0) {
        logAvError("avformat_write_header", ret);
        cleanup();
        return false;
    }
    headerWritten_ = true;

    // CRITICAL: log the CHANGED time bases (MP4 often uses {1, 90000})
    std::fprintf(stderr, "[Muxer] Header written. Video timeBase now=%d/%d, Audio timeBase now=%d/%d\n",
                 videoStream_->time_base.num, videoStream_->time_base.den,
                 audioStream_->time_base.num, audioStream_->time_base.den);

    initialized_ = true;
    return true;
}

// ===========================================================================
// initVideoStream
// ===========================================================================

bool FFmpegMuxer::initVideoStream(const ExportSettings& s)
{
    auto candidates = buildVideoEncoderCandidates(s.videoCodec, s.hwEncoderName, s.videoMode);
    if (candidates.empty()) {
        std::fprintf(stderr,
            "[Muxer] ERROR: No video encoder candidates for mode=%s codec (no matching encoder compiled in)\n",
            s.videoMode == ExportSettings::VideoMode::Hardware ? "hardware" :
            s.videoMode == ExportSettings::VideoMode::Software ? "software" : "auto");
        return false;
    }

    std::fprintf(stderr, "[Muxer] Video encoder candidates (%zu):", candidates.size());
    for (const auto* c : candidates) std::fprintf(stderr, " %s", c->name);
    std::fprintf(stderr, "\n");

    // Create the output stream once. All same-family encoders share AVCodecID so
    // we don't need to recreate the stream on each retry.
    videoStream_ = avformat_new_stream(fmtCtx_, nullptr);
    if (!videoStream_) return false;

    // Try each candidate with real export settings until one opens successfully.
    const AVCodec* chosenCodec = nullptr;
    for (size_t ci = 0; ci < candidates.size(); ++ci) {
        const AVCodec* codec = candidates[ci];

        if (videoCodecCtx_) avcodec_free_context(&videoCodecCtx_);
        videoCodecCtx_ = avcodec_alloc_context3(codec);
        if (!videoCodecCtx_) {
            std::fprintf(stderr, "[Muxer] avcodec_alloc_context3 failed for '%s', skipping\n",
                         codec->name);
            continue;
        }

        videoCodecCtx_->width     = s.width;
        videoCodecCtx_->height    = s.height;
        videoCodecCtx_->time_base = { s.fpsDen, s.fpsNum };
        videoCodecCtx_->framerate = { s.fpsNum, s.fpsDen };
        videoCodecCtx_->pix_fmt   = AV_PIX_FMT_YUV420P;

        // Pick pixel format: prefer yuv420p, let encoder override if unsupported
        // (DNxHD needs yuv422p, ProRes needs yuv422p10le)
        {
            const AVPixelFormat* pixFmts = nullptr;
            int numPixFmts = 0;
            int cfgRet = avcodec_get_supported_config(nullptr, codec,
                             AV_CODEC_CONFIG_PIX_FORMAT, 0,
                             reinterpret_cast<const void**>(&pixFmts), &numPixFmts);
            if (cfgRet >= 0 && pixFmts && numPixFmts > 0) {
                bool found420 = false;
                for (int i = 0; i < numPixFmts && pixFmts[i] != AV_PIX_FMT_NONE; ++i)
                    if (pixFmts[i] == AV_PIX_FMT_YUV420P) { found420 = true; break; }
                if (!found420) videoCodecCtx_->pix_fmt = pixFmts[0];
            }
        }

        // Resolve + apply the encoder-specific rate-control plan. This is the
        // fix for the "CRF/bitrate does nothing" bug: each encoder family needs
        // a different knob, and CRF must never silently clobber a target bitrate
        // (or vice versa).
        const ResolvedRateControl rc = resolveRateControl(codec->name, s);
        if (rc.bitrate > 0)   videoCodecCtx_->bit_rate = rc.bitrate;
        if (rc.setCrfPrivOpt) av_opt_set_int(videoCodecCtx_->priv_data, "crf", rc.crf, 0);
        if (rc.rcModeKey)     av_opt_set(videoCodecCtx_->priv_data, rc.rcModeKey, rc.rcModeVal, 0);
        if (rc.qpOptKey)      av_opt_set_int(videoCodecCtx_->priv_data, rc.qpOptKey, rc.qpValue, 0);
        if (rc.amfTripleQp) {
            av_opt_set_int(videoCodecCtx_->priv_data, "qp_p", rc.qpValue, 0);
            av_opt_set_int(videoCodecCtx_->priv_data, "qp_b", rc.qpValue, 0);
        }
        if (rc.useGlobalQuality) videoCodecCtx_->global_quality = rc.globalQuality;

        if (fmtCtx_->oformat->flags & AVFMT_GLOBALHEADER)
            videoCodecCtx_->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

        std::fprintf(stderr,
                     "[Muxer] Trying encoder '%s' (%zu/%zu): %dx%d pix_fmt=%d "
                     "rc=%s bitrate=%lld crf=%d qp=%d (%s)\n",
                     codec->name, ci + 1, candidates.size(),
                     s.width, s.height, (int)videoCodecCtx_->pix_fmt,
                     rc.bitrateMode ? "bitrate" : "crf",
                     (long long)videoCodecCtx_->bit_rate,
                     rc.setCrfPrivOpt ? rc.crf : -1,
                     rc.qpOptKey ? rc.qpValue : (rc.useGlobalQuality ? rc.globalQuality : -1),
                     rc.notes);

        int ret = avcodec_open2(videoCodecCtx_, codec, nullptr);
        if (ret == 0) {
            chosenCodec = codec;
            // Fallback = true only in Auto mode when at least one candidate was
            // tried and failed AND the chosen encoder is a software encoder. In
            // Software mode ci > 0 just means "first SW candidate not compiled
            // in" — not a hardware-rejected fallback.
            bool chosenIsSoftware = !isHardwareEncoderName(codec->name);
            videoEncoderFallback_ = (s.videoMode == ExportSettings::VideoMode::Auto)
                                 && chosenIsSoftware && (ci > 0);
            break;
        }

        char errBuf[AV_ERROR_MAX_STRING_SIZE];
        av_strerror(ret, errBuf, sizeof(errBuf));
        std::fprintf(stderr, "[Muxer] Encoder '%s' rejected: %s%s\n",
                     codec->name, errBuf,
                     (ci + 1 < candidates.size()) ? " — trying next" : " — no more fallbacks");
        avcodec_free_context(&videoCodecCtx_);
    }

    if (!chosenCodec || !videoCodecCtx_) {
        if (s.videoMode == ExportSettings::VideoMode::Hardware) {
            std::fprintf(stderr, "[Muxer] ERROR: Hardware video mode required but no hardware encoder succeeded\n");
        } else {
            std::fprintf(stderr, "[Muxer] ERROR: All video encoder candidates failed to open\n");
        }
        return false;
    }

    videoEncoderName_ = chosenCodec->name;
    videoStream_->time_base = videoCodecCtx_->time_base;

    // Authoritative one-line summary of the final encoder configuration.
    {
        const ResolvedRateControl rc = resolveRateControl(chosenCodec->name, s);
        const char* mode = s.videoMode == ExportSettings::VideoMode::Hardware ? "hardware"
                         : s.videoMode == ExportSettings::VideoMode::Software ? "software" : "auto";
        std::fprintf(stderr,
            "[Muxer] Resolved encoder config: encoder=%s videoMode=%s rateControl=%s "
            "crf=%d bitrate=%lld qp=%d (%s)\n",
            chosenCodec->name, mode,
            rc.bitrateMode ? "bitrate" : "crf",
            rc.setCrfPrivOpt ? rc.crf : -1,
            (long long)videoCodecCtx_->bit_rate,
            rc.qpOptKey ? rc.qpValue : (rc.useGlobalQuality ? rc.globalQuality : -1),
            rc.notes);
    }

    int ret = avcodec_parameters_from_context(videoStream_->codecpar, videoCodecCtx_);
    if (ret < 0) {
        logAvError("avcodec_parameters_from_context (video)", ret);
        return false;
    }

    // Allocate video frame in encoder's pixel format
    videoFrame_ = av_frame_alloc();
    if (!videoFrame_) return false;
    videoFrame_->format = videoCodecCtx_->pix_fmt;
    videoFrame_->width  = s.width;
    videoFrame_->height = s.height;
    ret = av_frame_get_buffer(videoFrame_, 32);
    if (ret < 0) {
        logAvError("av_frame_get_buffer (video)", ret);
        return false;
    }

    // Create sws context: BGRA → encoder pix_fmt
    swsCtx_ = sws_getContext(s.width, s.height, AV_PIX_FMT_BGRA,
                              s.width, s.height, videoCodecCtx_->pix_fmt,
                              SWS_BILINEAR, nullptr, nullptr, nullptr);
    if (!swsCtx_) {
        std::fprintf(stderr, "[Muxer] ERROR: sws_getContext failed\n");
        return false;
    }

    std::fprintf(stderr,
                 "[Muxer] Video stream: %dx%d %d/%d fps timeBase=%d/%d bitrate=%lld codec=%s pixfmt=%s\n",
                 s.width, s.height, s.fpsNum, s.fpsDen,
                 videoCodecCtx_->time_base.num, videoCodecCtx_->time_base.den,
                 (long long)videoCodecCtx_->bit_rate, chosenCodec->name,
                 av_get_pix_fmt_name(videoCodecCtx_->pix_fmt));

    return true;
}

// ===========================================================================
// initAudioStream
// ===========================================================================

bool FFmpegMuxer::initAudioStream(const ExportSettings& s)
{
    const AVCodec* codec = static_cast<const AVCodec*>(
        findAudioEncoder(s.audioCodec));
    if (!codec) {
        std::fprintf(stderr, "[Muxer] ERROR: No audio encoder found\n");
        return false;
    }
    audioEncoderName_ = codec->name;

    audioStream_ = avformat_new_stream(fmtCtx_, codec);
    if (!audioStream_) return false;

    audioCodecCtx_ = avcodec_alloc_context3(codec);
    if (!audioCodecCtx_) return false;

    // Pick sample format (prefer float planar, fall back to whatever encoder supports)
    audioCodecCtx_->sample_fmt = pickSampleFormat(codec, AV_SAMPLE_FMT_FLTP);

    // Pick sample rate
    audioCodecCtx_->sample_rate = pickSampleRate(codec, s.sampleRate);

    // Channel layout
    av_channel_layout_default(&audioCodecCtx_->ch_layout, s.audioChannels);

    // Bitrate
    if (s.audioBitrate > 0)
        audioCodecCtx_->bit_rate = static_cast<int64_t>(s.audioBitrate) * 1000;

    // Global header
    if (fmtCtx_->oformat->flags & AVFMT_GLOBALHEADER)
        audioCodecCtx_->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

    audioStream_->time_base = { 1, audioCodecCtx_->sample_rate };

    int ret = avcodec_open2(audioCodecCtx_, codec, nullptr);
    if (ret < 0) {
        logAvError("avcodec_open2 (audio)", ret);
        return false;
    }

    ret = avcodec_parameters_from_context(audioStream_->codecpar, audioCodecCtx_);
    if (ret < 0) {
        logAvError("avcodec_parameters_from_context (audio)", ret);
        return false;
    }

    // Determine frame size (PCM codecs have frame_size = 0)
    audioFrameSize_ = audioCodecCtx_->frame_size > 0
                          ? audioCodecCtx_->frame_size
                          : 4096;

    // Allocate audio frame
    audioFrame_ = av_frame_alloc();
    if (!audioFrame_) return false;
    audioFrame_->nb_samples  = audioFrameSize_;
    audioFrame_->format      = audioCodecCtx_->sample_fmt;
    audioFrame_->sample_rate = audioCodecCtx_->sample_rate;
    av_channel_layout_copy(&audioFrame_->ch_layout, &audioCodecCtx_->ch_layout);
    ret = av_frame_get_buffer(audioFrame_, 0);
    if (ret < 0) {
        logAvError("av_frame_get_buffer (audio)", ret);
        return false;
    }

    // Create SWR: float planar (JUCE layout) → encoder's sample format
    AVChannelLayout inLayout;
    av_channel_layout_default(&inLayout, s.audioChannels);

    ret = swr_alloc_set_opts2(&swrCtx_,
        &audioCodecCtx_->ch_layout, audioCodecCtx_->sample_fmt, audioCodecCtx_->sample_rate,
        &inLayout,                   AV_SAMPLE_FMT_FLTP,         s.sampleRate,
        0, nullptr);
    if (ret < 0 || swr_init(swrCtx_) < 0) {
        std::fprintf(stderr, "[Muxer] ERROR: swr init failed\n");
        return false;
    }

    // Allocate staging buffers for audio frame accumulation
    audioStagingL_.resize(audioFrameSize_, 0.0f);
    audioStagingR_.resize(audioFrameSize_, 0.0f);
    audioBufferSamples_ = 0;

    std::fprintf(stderr, "[Muxer] Audio stream: %dHz %dch timeBase=%d/%d bitrate=%lld frameSize=%d codec=%s fmt=%s\n",
                 audioCodecCtx_->sample_rate, s.audioChannels,
                 audioCodecCtx_->time_base.num, audioCodecCtx_->time_base.den,
                 (long long)audioCodecCtx_->bit_rate, audioFrameSize_,
                 codec->name,
                 av_get_sample_fmt_name(audioCodecCtx_->sample_fmt));

    return true;
}

// ===========================================================================
// drainPackets — receive all pending packets from an encoder and write to muxer
// ===========================================================================

bool FFmpegMuxer::drainPackets(AVCodecContext* encCtx, AVStream* stream)
{
    while (true) {
        int r = avcodec_receive_packet(encCtx, pkt_);
        if (r == AVERROR(EAGAIN) || r == AVERROR_EOF)
            return true;
        if (r < 0) {
            logAvError("avcodec_receive_packet", r);
            return false;
        }

        // Track which stream and rescale timestamps
        pkt_->stream_index = stream->index;

        // Log before rescale for debugging
        int64_t origPts = pkt_->pts;
        av_packet_rescale_ts(pkt_, encCtx->time_base, stream->time_base);

        // Periodic logging
        if (stream == videoStream_) {
            ++videoPacketCount_;
            if (videoPacketCount_ % 10 == 1) {
                std::fprintf(stderr, "[Muxer] Video packet: pts=%lld (rescaled=%lld) size=%d\n",
                             (long long)origPts, (long long)pkt_->pts, pkt_->size);
            }
        } else {
            ++audioPacketCount_;
            if (audioPacketCount_ % 100 == 1) {
                std::fprintf(stderr, "[Muxer] Audio packet: pts=%lld (rescaled=%lld) size=%d\n",
                             (long long)origPts, (long long)pkt_->pts, pkt_->size);
            }
        }

        int wr = av_interleaved_write_frame(fmtCtx_, pkt_);
        if (wr < 0) {
            logAvError("av_interleaved_write_frame", wr);
            av_packet_unref(pkt_);
            return false;
        }
        av_packet_unref(pkt_);
    }
}

// ===========================================================================
// flushEncoder — send NULL frame and drain all remaining packets
// ===========================================================================

bool FFmpegMuxer::flushEncoder(AVCodecContext* encCtx, AVStream* stream)
{
    int ret = avcodec_send_frame(encCtx, nullptr);
    if (ret < 0 && ret != AVERROR_EOF) {
        logAvError("flush avcodec_send_frame", ret);
        return false;
    }

    int64_t countBefore = (stream == videoStream_) ? videoPacketCount_ : audioPacketCount_;
    bool ok = drainPackets(encCtx, stream);
    int64_t drained = ((stream == videoStream_) ? videoPacketCount_ : audioPacketCount_) - countBefore;

    if (stream == videoStream_) {
        std::fprintf(stderr, "[Muxer] Video flush done: %lld packets drained\n", (long long)drained);
    } else {
        std::fprintf(stderr, "[Muxer] Audio flush done: %lld packets drained\n", (long long)drained);
    }

    return ok;
}

// ===========================================================================
// writeVideo
// ===========================================================================

bool FFmpegMuxer::writeVideo(const uint8_t* bgraPixels, int stride, int64_t frameIndex)
{
    if (!initialized_) return false;

    // Make frame writable
    int ret = av_frame_make_writable(videoFrame_);
    if (ret < 0) {
        logAvError("av_frame_make_writable (video)", ret);
        return false;
    }

    // BGRA → encoder pixel format
    const uint8_t* srcSlice[1] = { bgraPixels };
    int srcStride[1] = { stride };
    sws_scale(swsCtx_, srcSlice, srcStride, 0, settings_.height,
              videoFrame_->data, videoFrame_->linesize);

    // Set PTS
    videoFrame_->pts = frameIndex;

    // Encode
    ret = avcodec_send_frame(videoCodecCtx_, videoFrame_);
    if (ret < 0 && ret != AVERROR(EAGAIN)) {
        logAvError("avcodec_send_frame (video)", ret);
        return false;
    }

    if (!drainPackets(videoCodecCtx_, videoStream_))
        return false;

    videoPts_ = frameIndex + 1;
    return true;
}

// ===========================================================================
// writeAudio — buffer incoming samples, encode full frames
// ===========================================================================

bool FFmpegMuxer::writeAudio(const float* const* channels, int numSamples,
                               int64_t /*samplesWritten*/)
{
    if (!initialized_) return false;

    int remaining = numSamples;
    int srcOffset = 0;

    while (remaining > 0) {
        int space  = audioFrameSize_ - audioBufferSamples_;
        int toCopy = std::min(remaining, space);

        // Append to staging buffers
        std::memcpy(audioStagingL_.data() + audioBufferSamples_,
                    channels[0] + srcOffset,
                    static_cast<size_t>(toCopy) * sizeof(float));
        if (channels[1]) {
            std::memcpy(audioStagingR_.data() + audioBufferSamples_,
                        channels[1] + srcOffset,
                        static_cast<size_t>(toCopy) * sizeof(float));
        } else {
            // Mono: duplicate left channel
            std::memcpy(audioStagingR_.data() + audioBufferSamples_,
                        channels[0] + srcOffset,
                        static_cast<size_t>(toCopy) * sizeof(float));
        }

        audioBufferSamples_ += toCopy;
        srcOffset  += toCopy;
        remaining  -= toCopy;

        // Full frame accumulated — convert and encode
        if (audioBufferSamples_ >= audioFrameSize_) {
            if (!encodeAudioFrame())
                return false;
            audioPts_ += audioFrameSize_;
            audioBufferSamples_ = 0;
        }
    }

    return true;
}

// ===========================================================================
// encodeAudioFrame — convert staging buffer through SWR and encode
// ===========================================================================

bool FFmpegMuxer::encodeAudioFrame()
{
    int ret = av_frame_make_writable(audioFrame_);
    if (ret < 0) {
        logAvError("av_frame_make_writable (audio)", ret);
        return false;
    }

    // SWR input: float planar channels
    const uint8_t* inData[2] = {
        reinterpret_cast<const uint8_t*>(audioStagingL_.data()),
        reinterpret_cast<const uint8_t*>(audioStagingR_.data())
    };

    int converted = swr_convert(swrCtx_, audioFrame_->data, audioFrameSize_,
                                 inData, audioFrameSize_);
    if (converted < 0) {
        logAvError("swr_convert", converted);
        return false;
    }

    audioFrame_->pts        = audioPts_;
    audioFrame_->nb_samples = converted;

    ret = avcodec_send_frame(audioCodecCtx_, audioFrame_);
    if (ret < 0 && ret != AVERROR(EAGAIN)) {
        logAvError("avcodec_send_frame (audio)", ret);
        return false;
    }

    return drainPackets(audioCodecCtx_, audioStream_);
}

// ===========================================================================
// finalize
// ===========================================================================

bool FFmpegMuxer::finalize()
{
    if (!initialized_) return false;

    // 1. Flush residual audio buffer (zero-pad to full frame)
    if (audioBufferSamples_ > 0) {
        std::memset(audioStagingL_.data() + audioBufferSamples_, 0,
                    static_cast<size_t>(audioFrameSize_ - audioBufferSamples_) * sizeof(float));
        std::memset(audioStagingR_.data() + audioBufferSamples_, 0,
                    static_cast<size_t>(audioFrameSize_ - audioBufferSamples_) * sizeof(float));
        audioBufferSamples_ = audioFrameSize_;  // pretend full
        if (!encodeAudioFrame()) return false;
    }

    // 2. Flush video encoder
    std::fprintf(stderr, "[Muxer] Flushing video encoder...\n");
    if (!flushEncoder(videoCodecCtx_, videoStream_)) return false;

    // 3. Flush audio encoder
    std::fprintf(stderr, "[Muxer] Flushing audio encoder...\n");
    if (!flushEncoder(audioCodecCtx_, audioStream_)) return false;

    // 4. Write trailer
    int ret = av_write_trailer(fmtCtx_);
    if (ret < 0) {
        logAvError("av_write_trailer", ret);
        return false;
    }
    trailerWritten_ = true;

    std::fprintf(stderr, "[Muxer] Finalized: %lld audio packets, %lld video packets, trailer written\n",
                 (long long)audioPacketCount_, (long long)videoPacketCount_);

    // 5. Close file and free resources
    cleanup();
    return true;
}

// ===========================================================================
// shouldWriteVideo
// ===========================================================================

bool FFmpegMuxer::shouldWriteVideo() const
{
    if (!initialized_ || !videoStream_ || !audioStream_)
        return true;
    return av_compare_ts(videoPts_, videoCodecCtx_->time_base,
                         audioPts_, audioCodecCtx_->time_base) <= 0;
}

// ===========================================================================
// Accessors
// ===========================================================================

const char* FFmpegMuxer::videoEncoderName()     const { return videoEncoderName_; }
bool        FFmpegMuxer::isVideoEncoderFallback() const { return videoEncoderFallback_; }
const char* FFmpegMuxer::audioEncoderName()     const { return audioEncoderName_; }
