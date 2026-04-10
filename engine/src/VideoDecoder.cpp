#include "VideoDecoder.h"

#include <cstring>
#include <iostream>

VideoDecoder::VideoDecoder() = default;

VideoDecoder::~VideoDecoder()
{
    close();
}

// ── open ─────────────────────────────────────────────────────────────────────

bool VideoDecoder::open(const std::string& filePath)
{
    close();

    // 1. Open the file
    if (avformat_open_input(&formatCtx_, filePath.c_str(), nullptr, nullptr) < 0)
    {
        std::cerr << "[VideoDecoder] Could not open file: " << filePath << "\n";
        return false;
    }

    // 2. Read stream headers
    if (avformat_find_stream_info(formatCtx_, nullptr) < 0)
    {
        std::cerr << "[VideoDecoder] Failed to read stream info\n";
        close();
        return false;
    }

    // 3. Find the best video stream
    const AVCodec* codec = nullptr;
    videoStreamIdx_ = av_find_best_stream(formatCtx_, AVMEDIA_TYPE_VIDEO,
                                          -1, -1, &codec, 0);
    if (videoStreamIdx_ < 0 || codec == nullptr)
    {
        std::cerr << "[VideoDecoder] No video stream found in: " << filePath << "\n";
        close();
        return false;
    }

    AVStream* stream = formatCtx_->streams[videoStreamIdx_];

    // 4. Create and open the decoder context
    codecCtx_ = avcodec_alloc_context3(codec);
    if (!codecCtx_)
    {
        std::cerr << "[VideoDecoder] Failed to allocate codec context\n";
        close();
        return false;
    }

    if (avcodec_parameters_to_context(codecCtx_, stream->codecpar) < 0)
    {
        std::cerr << "[VideoDecoder] Failed to copy codec parameters\n";
        close();
        return false;
    }

    if (avcodec_open2(codecCtx_, codec, nullptr) < 0)
    {
        std::cerr << "[VideoDecoder] Failed to open codec: " << codec->name << "\n";
        close();
        return false;
    }

    // 5. Cache metadata
    width_  = codecCtx_->width;
    height_ = codecCtx_->height;

    if (stream->r_frame_rate.den > 0)
        fps_ = av_q2d(stream->r_frame_rate);
    else
        fps_ = 30.0;

    duration_ = (formatCtx_->duration != AV_NOPTS_VALUE)
                    ? static_cast<double>(formatCtx_->duration) / AV_TIME_BASE
                    : 0.0;

    // 6. SwsContext for pixel-format conversion (if source isn't YUV420P)
    if (codecCtx_->pix_fmt != AV_PIX_FMT_YUV420P)
    {
        swsCtx_ = sws_getContext(width_, height_, codecCtx_->pix_fmt,
                                 width_, height_, AV_PIX_FMT_YUV420P,
                                 SWS_BILINEAR, nullptr, nullptr, nullptr);
        if (!swsCtx_)
        {
            std::cerr << "[VideoDecoder] Failed to create SwsContext\n";
            close();
            return false;
        }

        yuvFrame_ = av_frame_alloc();
        if (!yuvFrame_) { close(); return false; }

        yuvFrame_->format = AV_PIX_FMT_YUV420P;
        yuvFrame_->width  = width_;
        yuvFrame_->height = height_;

        if (av_frame_get_buffer(yuvFrame_, 0) < 0)
        {
            std::cerr << "[VideoDecoder] Failed to allocate yuvFrame buffer\n";
            close();
            return false;
        }
    }

    // 7. Allocate reusable frame and packet
    frame_  = av_frame_alloc();
    packet_ = av_packet_alloc();
    if (!frame_ || !packet_) { close(); return false; }

    // 8. Log info
    std::cout << "[VideoDecoder] Opened: " << filePath          << "\n"
              << "  Resolution : " << width_ << "x" << height_  << "\n"
              << "  FPS        : " << fps_                       << "\n"
              << "  Duration   : " << duration_ << " s"
                    << "  (" << getTotalFrames() << " frames)\n"
              << "  Codec      : " << codec->name                << "\n"
              << "  Pixel fmt  : "
                    << av_get_pix_fmt_name(codecCtx_->pix_fmt)  << "\n";

    return true;
}

// ── close ────────────────────────────────────────────────────────────────────

void VideoDecoder::close()
{
    if (swsCtx_)    { sws_freeContext(swsCtx_);         swsCtx_   = nullptr; }
    if (yuvFrame_)  { av_frame_free(&yuvFrame_);                              }
    if (frame_)     { av_frame_free(&frame_);                                 }
    if (packet_)    { av_packet_free(&packet_);                               }
    if (codecCtx_)  { avcodec_free_context(&codecCtx_);                      }
    if (formatCtx_) { avformat_close_input(&formatCtx_);                     }

    videoStreamIdx_ = -1;
    fps_            = 30.0;
    duration_       = 0.0;
    width_          = 0;
    height_         = 0;
}

bool VideoDecoder::isOpen() const
{
    return formatCtx_ != nullptr && codecCtx_ != nullptr;
}

// ── seekAndDecode ─────────────────────────────────────────────────────────────

bool VideoDecoder::seekAndDecode(double timeSeconds, DecodedFrame& outFrame)
{
    if (!isOpen()) return false;

    AVStream* stream = formatCtx_->streams[videoStreamIdx_];

    // Convert wall-clock time to stream PTS
    int64_t targetPTS = static_cast<int64_t>(timeSeconds / av_q2d(stream->time_base));

    // Seek backward to the nearest keyframe
    if (av_seek_frame(formatCtx_, videoStreamIdx_, targetPTS,
                      AVSEEK_FLAG_BACKWARD) < 0)
    {
        std::cerr << "[VideoDecoder] Seek failed at " << timeSeconds << " s\n";
        return false;
    }

    // Clear any buffered state in the decoder
    avcodec_flush_buffers(codecCtx_);

    return decodeUntilFrame(targetPTS, outFrame);
}

// ── decodeNext ────────────────────────────────────────────────────────────────

bool VideoDecoder::decodeNext(DecodedFrame& outFrame)
{
    if (!isOpen()) return false;

    while (av_read_frame(formatCtx_, packet_) >= 0)
    {
        if (packet_->stream_index != videoStreamIdx_)
        {
            av_packet_unref(packet_);
            continue;
        }

        int ret = avcodec_send_packet(codecCtx_, packet_);
        av_packet_unref(packet_);
        if (ret < 0) continue;

        ret = avcodec_receive_frame(codecCtx_, frame_);
        if (ret == 0)
        {
            copyFrameToOutput(frame_, outFrame);
            av_frame_unref(frame_);
            return true;
        }
    }

    // Drain any remaining frames from the decoder
    avcodec_send_packet(codecCtx_, nullptr);
    if (avcodec_receive_frame(codecCtx_, frame_) == 0)
    {
        copyFrameToOutput(frame_, outFrame);
        av_frame_unref(frame_);
        return true;
    }

    return false;
}

// ── internal: decodeUntilFrame ────────────────────────────────────────────────

bool VideoDecoder::decodeUntilFrame(int64_t targetPTS, DecodedFrame& outFrame)
{
    AVFrame* best = av_frame_alloc();
    if (!best) return false;

    bool found        = false;
    bool reachedTarget = false;

    while (!reachedTarget && av_read_frame(formatCtx_, packet_) >= 0)
    {
        if (packet_->stream_index != videoStreamIdx_)
        {
            av_packet_unref(packet_);
            continue;
        }

        int ret = avcodec_send_packet(codecCtx_, packet_);
        av_packet_unref(packet_);
        if (ret < 0) continue;

        while (!reachedTarget)
        {
            ret = avcodec_receive_frame(codecCtx_, frame_);
            if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) break;
            if (ret < 0) break;

            int64_t pts = (frame_->pts != AV_NOPTS_VALUE)
                              ? frame_->pts
                              : frame_->best_effort_timestamp;

            // Keep the latest frame decoded so far
            av_frame_unref(best);
            av_frame_ref(best, frame_);
            found = true;

            av_frame_unref(frame_);

            if (pts >= targetPTS)
                reachedTarget = true;
        }
    }

    if (found)
        copyFrameToOutput(best, outFrame);

    av_frame_free(&best);
    return found;
}

// ── internal: copyFrameToOutput ──────────────────────────────────────────────

void VideoDecoder::copyFrameToOutput(AVFrame* src, DecodedFrame& outFrame)
{
    AVFrame* yuv = src;

    // Convert to YUV420P if the decoder produced a different format
    if (swsCtx_)
    {
        sws_scale(swsCtx_,
                  src->data, src->linesize, 0, height_,
                  yuvFrame_->data, yuvFrame_->linesize);
        yuv = yuvFrame_;
    }

    outFrame.width   = width_;
    outFrame.height  = height_;
    outFrame.yStride = yuv->linesize[0];
    outFrame.uStride = yuv->linesize[1];
    outFrame.vStride = yuv->linesize[2];

    // Derive frame number from PTS when available
    if (src->pts != AV_NOPTS_VALUE)
    {
        AVStream* stream = formatCtx_->streams[videoStreamIdx_];
        double t = static_cast<double>(src->pts) * av_q2d(stream->time_base);
        outFrame.frameNumber = timeToFrame(t);
    }
    else
    {
        outFrame.frameNumber = -1;
    }

    const int ySize = yuv->linesize[0] *  height_;
    const int uSize = yuv->linesize[1] * (height_ / 2);
    const int vSize = yuv->linesize[2] * (height_ / 2);

    outFrame.yPlane.resize(ySize);
    outFrame.uPlane.resize(uSize);
    outFrame.vPlane.resize(vSize);

    std::memcpy(outFrame.yPlane.data(), yuv->data[0], ySize);
    std::memcpy(outFrame.uPlane.data(), yuv->data[1], uSize);
    std::memcpy(outFrame.vPlane.data(), yuv->data[2], vSize);
}

// ── accessors ─────────────────────────────────────────────────────────────────

int    VideoDecoder::getWidth()    const { return width_;  }
int    VideoDecoder::getHeight()   const { return height_; }
double VideoDecoder::getFPS()      const { return fps_;    }
double VideoDecoder::getDuration() const { return duration_; }

int VideoDecoder::getTotalFrames() const
{
    if (fps_ > 0.0 && duration_ > 0.0)
        return static_cast<int>(duration_ * fps_);
    return 0;
}

int VideoDecoder::timeToFrame(double seconds) const
{
    if (fps_ <= 0.0) return 0;
    return static_cast<int>(seconds * fps_);
}

double VideoDecoder::frameToTime(int frameNumber) const
{
    if (fps_ <= 0.0) return 0.0;
    return static_cast<double>(frameNumber) / fps_;
}
