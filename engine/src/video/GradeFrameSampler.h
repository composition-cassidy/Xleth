#pragma once

// GradeFrameSampler — small CPU frames of a source, for the Color Grade Auto
// helper and the curves histogram (model/ColorGrade.h, GradeAnalysis).
//
// Auto looks at the WHOLE source, not one frame, so it samples a fixed number
// of frames spread evenly over the requested range and the caller accumulates
// them into one set of statistics. The frame times are a pure function of the
// range and the count, so the same file always yields the same frames and
// therefore the same grade.
//
// Decodes on the CPU with its own VideoDecoder (the ORIGINAL file, never a
// proxy: a proxy's presence must not change the result). It shares nothing
// with the preview or the export, so running it cannot disturb either.
// Blocking: call it from the RPC thread, never the video or audio thread.

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace xleth::grade {

struct SampledFrame {
    int                  width  = 0;
    int                  height = 0;
    std::vector<uint8_t> rgb;      // RGB24, tightly packed (stride = width * 3)
};

/**
 * Decode `count` frames evenly spaced inside [startSec, endSec] and hand each
 * to `onFrame`, downscaled to fit maxWidth x maxHeight (aspect kept).
 *
 * endSec <= startSec means "to the end of the file".
 *
 * @return the number of frames delivered. 0 with `error` set when the file
 *         could not be opened or no frame could be decoded.
 */
int sampleSourceFrames(const std::string& filePath,
                       double startSec, double endSec,
                       int count, int maxWidth, int maxHeight,
                       const std::function<void(const SampledFrame&)>& onFrame,
                       std::string& error);

} // namespace xleth::grade
