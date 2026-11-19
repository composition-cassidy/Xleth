#include "video/GradeFrameSampler.h"

#include "VideoDecoder.h"
#include "video/SwsDestBuffer.h"

#include <algorithm>
#include <cmath>

namespace xleth::grade {

int sampleSourceFrames(const std::string& filePath,
                       double startSec, double endSec,
                       int count, int maxWidth, int maxHeight,
                       const std::function<void(const SampledFrame&)>& onFrame,
                       std::string& error)
{
    error.clear();
    if (filePath.empty() || count <= 0 || !onFrame) {
        error = "nothing to analyse";
        return 0;
    }

    VideoDecoder decoder;
    if (!decoder.open(filePath)) {
        error = "could not open the source file";
        return 0;
    }

    const int srcW = decoder.getWidth();
    const int srcH = decoder.getHeight();
    if (srcW <= 0 || srcH <= 0) {
        error = "the source has no picture";
        return 0;
    }

    const double duration = decoder.getDuration();
    double t0 = std::max(0.0, startSec);
    double t1 = endSec > startSec ? endSec : duration;
    if (duration > 0.0) {
        t0 = std::min(t0, duration);
        t1 = std::min(t1, duration);
    }
    if (t1 < t0) t1 = t0;

    // Fit inside maxWidth x maxHeight, never upscaling, even dimensions.
    double scale = 1.0;
    if (maxWidth > 0)  scale = std::min(scale, static_cast<double>(maxWidth) / srcW);
    if (maxHeight > 0) scale = std::min(scale, static_cast<double>(maxHeight) / srcH);
    const int outW = std::max(2, static_cast<int>(std::lround(srcW * scale)) & ~1);
    const int outH = std::max(2, static_cast<int>(std::lround(srcH * scale)) & ~1);

    SwsContext* sws = nullptr;
    int swsW = 0, swsH = 0;
    int delivered = 0;

    for (int i = 0; i < count; ++i) {
        // Centre of the i-th of `count` equal slices: never exactly the first
        // or last instant of the range, which are the likeliest to be a fade,
        // a black frame or a cut.
        const double t = t0 + (t1 - t0) * ((static_cast<double>(i) + 0.5) / count);

        VideoDecoder::DecodedFrame frame;
        if (!decoder.seekAndDecode(t, frame)) continue;
        if (frame.width <= 0 || frame.height <= 0) continue;

        if (!sws || swsW != frame.width || swsH != frame.height) {
            if (sws) sws_freeContext(sws);
            sws = sws_getContext(frame.width, frame.height, AV_PIX_FMT_YUV420P,
                                 outW, outH, AV_PIX_FMT_RGB24,
                                 SWS_BILINEAR, nullptr, nullptr, nullptr);
            swsW = frame.width;
            swsH = frame.height;
            if (sws) {
                // HD is Rec.709, SD is Rec.601: the same rule the export uses
                // (FFmpegMuxer), limited range in, full range out.
                const int* coeffs = sws_getCoefficients(
                    frame.height >= 720 ? SWS_CS_ITU709 : SWS_CS_ITU601);
                sws_setColorspaceDetails(sws, coeffs, /*srcRange=*/0,
                                         sws_getCoefficients(SWS_CS_DEFAULT), /*dstRange=*/1,
                                         0, 1 << 16, 1 << 16);
            }
        }
        if (!sws) {
            error = "could not convert the source's frames";
            break;
        }

        const uint8_t* srcSlice[3]  = { frame.yPlane.data(), frame.uPlane.data(), frame.vPlane.data() };
        const int      srcStride[3] = { frame.yStride, frame.uStride, frame.vStride };

        // Padded for sws_scale's write slack — see SwsDestBuffer.h.
        const size_t pixelBytes = static_cast<size_t>(outW) * outH * 3;
        std::vector<uint8_t> padded = xleth::makeSwsDestBuffer(pixelBytes);
        uint8_t* dstSlice[1]  = { padded.data() };
        int      dstStride[1] = { outW * 3 };
        sws_scale(sws, srcSlice, srcStride, 0, frame.height, dstSlice, dstStride);
        padded.resize(pixelBytes);

        SampledFrame out;
        out.width  = outW;
        out.height = outH;
        out.rgb    = std::move(padded);
        onFrame(out);
        ++delivered;
    }

    if (sws) sws_freeContext(sws);
    if (delivered == 0 && error.empty()) error = "no frame of the source could be decoded";
    return delivered;
}

} // namespace xleth::grade
