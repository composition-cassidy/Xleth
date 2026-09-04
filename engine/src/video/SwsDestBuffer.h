#pragma once

/*
 * SwsDestBuffer.h — correctly sized destination buffers for sws_scale().
 *
 * libswscale's optimised output paths write in aligned SIMD blocks, so they can
 * store PAST the last useful byte of the destination: the write is rounded up to
 * the block size rather than clipped to width*bytesPerPixel*height. FFmpeg's own
 * contract is that scale destinations come from av_image_alloc/av_frame_get_buffer,
 * which allocate that slack for you. Handing sws_scale a container sized to exactly
 * the pixel bytes is a heap-buffer overflow.
 *
 * Measured, not assumed: a yuv422p (dnxhd) 360x240 frame converting to BGRA wrote
 * 32 bytes past a std::vector<uint8_t>(360*4*240). That smashed the allocator's
 * metadata and the worker process died at the next heap operation with
 * STATUS_HEAP_CORRUPTION (0xC0000374) — asynchronously, inside whatever unrelated
 * call happened to allocate next, which is what made it so hard to place. yuvj420p
 * sources (mjpeg posters) went through a different path and never overflowed, so
 * only projects carrying 422 proxies crashed.
 *
 * Destinations that are already AVFrames (ProxyTranscoder, FFmpegMuxer) need none
 * of this — av_frame_get_buffer has the slack. This is for the cases that convert
 * into a plain byte container before handing the pixels somewhere else (a D3D11
 * staging texture, a JPEG encoder, a cell composite).
 *
 * Not covered here: FrameOutput::writeFrameYUV scales straight into the
 * double-buffer's back half, where a same-shaped overwrite lands in the sibling
 * buffer or in the 64-byte control region holding the atomic front/back index.
 * Fixing that means moving the index (it sits at exactly 2*bufferSize, a value
 * reported to JS as indexOffset), so it is deliberately left alone.
 */

#include <cstddef>
#include <cstdint>
#include <vector>

namespace xleth {

// Slack past the last pixel byte. libswscale does not document an exact bound;
// 64 covers the 32 bytes measured above with room for a wider block on another
// path, and costs one cache line per conversion.
inline constexpr std::size_t kSwsDestPadding = 64;

/** A byte buffer holding `pixelBytes` of image data plus the slack sws_scale
 *  may write past it. Pass .data() as the scale destination; read back only
 *  the first `pixelBytes`. */
inline std::vector<std::uint8_t> makeSwsDestBuffer(std::size_t pixelBytes)
{
    return std::vector<std::uint8_t>(pixelBytes + kSwsDestPadding);
}

} // namespace xleth
