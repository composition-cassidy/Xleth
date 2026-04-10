#pragma once

#include <cstdint>
#include <string>
#include <vector>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>
#include <libavutil/avutil.h>
#include <libavutil/imgutils.h>
}

class VideoDecoder {
public:
    struct DecodedFrame {
        std::vector<uint8_t> yPlane;
        std::vector<uint8_t> uPlane;
        std::vector<uint8_t> vPlane;
        int yStride = 0, uStride = 0, vStride = 0;
        int width = 0, height = 0;
        int frameNumber = 0;
    };

    VideoDecoder();
    ~VideoDecoder();

    // Open a video file. Returns true on success.
    bool open(const std::string& filePath);
    void close();
    bool isOpen() const;

    // Seek to a specific time and decode that frame.
    bool seekAndDecode(double timeSeconds, DecodedFrame& outFrame);

    // Decode the next sequential frame.
    bool decodeNext(DecodedFrame& outFrame);

    // Video info
    int    getWidth()       const;
    int    getHeight()      const;
    double getFPS()         const;
    double getDuration()    const;
    int    getTotalFrames() const;

    // Timestamp <-> frame number conversion
    int    timeToFrame(double seconds)     const;
    double frameToTime(int frameNumber)    const;

private:
    AVFormatContext* formatCtx_ = nullptr;
    AVCodecContext*  codecCtx_  = nullptr;
    AVFrame*         frame_     = nullptr;
    AVFrame*         yuvFrame_  = nullptr;  // conversion target when src isn't YUV420P
    AVPacket*        packet_    = nullptr;
    SwsContext*      swsCtx_    = nullptr;  // pixel-format conversion
    int              videoStreamIdx_ = -1;

    double fps_      = 30.0;
    double duration_ = 0.0;
    int    width_    = 0;
    int    height_   = 0;

    // Decode packets forward until we have a frame at or past targetPTS.
    bool decodeUntilFrame(int64_t targetPTS, DecodedFrame& outFrame);

    // Copy (and optionally convert) a decoded AVFrame into outFrame.
    void copyFrameToOutput(AVFrame* src, DecodedFrame& outFrame);
};
