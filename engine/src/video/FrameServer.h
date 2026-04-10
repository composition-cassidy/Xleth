#pragma once

#include "../VideoDecoder.h"
#include "../FrameCache.h"
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

struct SwsContext;  // forward-declare (libswscale)

class Timeline;    // forward-declare

// ─── FrameServer ─────────────────────────────────────────────────────────────
// Wraps VideoDecoder + FrameCache for fast, on-demand frame serving.
// Used by the SamplePicker (and later timeline thumbnails) to replace the
// slow FFmpeg-subprocess approach with native decoding + LRU caching.
//
// Pipeline:  cache check → (miss: decode via VideoDecoder → cache store)
//            → downscale via libswscale → JPEG encode via stb_image_write
//
// Thread safety: call from a single thread (addon-worker main thread).
// The shared FrameCache is internally mutex-protected.

class FrameServer {
public:
    explicit FrameServer(FrameCache& cache);
    ~FrameServer();

    // Open a decoder for the given source.
    // Prefers proxyPath when non-empty, falls back to filePath.
    bool openSource(int sourceId, const std::string& filePath,
                    const std::string& proxyPath = "");

    // Open source by looking up filePath/proxyPath from the Timeline.
    bool openSourceFromTimeline(int sourceId, const Timeline& timeline);

    void closeSource(int sourceId);
    void closeAll();
    bool isSourceOpen(int sourceId) const;

    // Get a JPEG-encoded frame. Returns empty vector on failure.
    // maxWidth/maxHeight: output is scaled to fit within these bounds
    //                     (aspect ratio preserved). 0 means no constraint.
    // quality: JPEG quality 1-100.
    std::vector<uint8_t> getFrameJPEG(int sourceId, double timeSeconds,
                                       int maxWidth = 480, int maxHeight = 270,
                                       int quality = 75);

    struct SourceInfo {
        int    width       = 0;
        int    height      = 0;
        double fps         = 0.0;
        double duration    = 0.0;
        int    totalFrames = 0;
    };
    SourceInfo getSourceInfo(int sourceId) const;

private:
    FrameCache& cache_;

    struct OpenSource {
        std::unique_ptr<VideoDecoder> decoder;
        int sourceId = 0;
        // Per-output-size scaler cache, keyed by dstW * 10000 + dstH
        std::unordered_map<int, SwsContext*> scalers;
    };

    std::unordered_map<int, OpenSource> sources_;

    // Get or create a libswscale context for YUV420P→RGB24 at the target size.
    SwsContext* getScaler(OpenSource& src, int srcW, int srcH,
                          int dstW, int dstH);

    // Compute output dimensions that fit within maxW x maxH, preserving aspect.
    static void computeOutputSize(int srcW, int srcH,
                                  int maxW, int maxH,
                                  int& outW, int& outH);
};
