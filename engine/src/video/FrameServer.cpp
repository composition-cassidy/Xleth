#include "FrameServer.h"
#include "../model/Timeline.h"

extern "C" {
#include <libswscale/swscale.h>
#include <libavutil/pixfmt.h>
}

// ── stb JPEG encoder (implementation in this TU only) ────────────────────────
#ifdef _MSC_VER
#pragma warning(push)
#pragma warning(disable: 4244 4996)  // conversion, deprecated
#endif

#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_WRITE_NO_STDIO            // we only use the callback API
#include "../vendor/stb_image_write.h"

#ifdef _MSC_VER
#pragma warning(pop)
#endif

#include <algorithm>
#include <cstring>

// ── stb write callback: appends JPEG bytes to a std::vector ──────────────────
static void stbWriteCallback(void* context, void* data, int size) {
    auto* out = static_cast<std::vector<uint8_t>*>(context);
    auto* bytes = static_cast<const uint8_t*>(data);
    out->insert(out->end(), bytes, bytes + size);
}

// ─── FrameServer ─────────────────────────────────────────────────────────────

FrameServer::FrameServer(FrameCache& cache)
    : cache_(cache) {}

FrameServer::~FrameServer() {
    closeAll();
}

bool FrameServer::openSource(int sourceId, const std::string& filePath,
                              const std::string& proxyPath) {
    // Close existing if re-opened
    closeSource(sourceId);

    auto decoder = std::make_unique<VideoDecoder>();
    const std::string& path = (!proxyPath.empty()) ? proxyPath : filePath;
    if (!decoder->open(path)) return false;

    OpenSource os;
    os.decoder  = std::move(decoder);
    os.sourceId = sourceId;
    sources_[sourceId] = std::move(os);
    return true;
}

bool FrameServer::openSourceFromTimeline(int sourceId, const Timeline& timeline) {
    const auto* src = timeline.getSource(sourceId);
    if (!src) return false;

    const std::string& proxy =
        (src->proxyReady && !src->proxyPath.empty()) ? src->proxyPath : "";
    return openSource(sourceId, src->filePath, proxy);
}

void FrameServer::closeSource(int sourceId) {
    auto it = sources_.find(sourceId);
    if (it == sources_.end()) return;

    // Free all libswscale contexts for this source
    for (auto& [key, ctx] : it->second.scalers) {
        if (ctx) sws_freeContext(ctx);
    }
    sources_.erase(it);
}

void FrameServer::closeAll() {
    // Collect IDs first to avoid iterator invalidation
    std::vector<int> ids;
    ids.reserve(sources_.size());
    for (auto& [id, _] : sources_) ids.push_back(id);
    for (int id : ids) closeSource(id);
}

bool FrameServer::isSourceOpen(int sourceId) const {
    return sources_.count(sourceId) > 0;
}

FrameServer::SourceInfo FrameServer::getSourceInfo(int sourceId) const {
    auto it = sources_.find(sourceId);
    if (it == sources_.end()) return {};

    const auto& dec = *it->second.decoder;
    return {
        dec.getWidth(),
        dec.getHeight(),
        dec.getFPS(),
        dec.getDuration(),
        dec.getTotalFrames()
    };
}

// ─── Main pipeline: cache → decode → downscale → JPEG ───────────────────────

std::vector<uint8_t> FrameServer::getFrameJPEG(int sourceId, double timeSeconds,
                                                 int maxWidth, int maxHeight,
                                                 int quality) {
    auto it = sources_.find(sourceId);
    if (it == sources_.end()) return {};

    auto& src = it->second;
    auto& decoder = *src.decoder;

    const int srcW = decoder.getWidth();
    const int srcH = decoder.getHeight();
    if (srcW <= 0 || srcH <= 0) return {};

    const int frameNumber = decoder.timeToFrame(timeSeconds);
    const FrameKey key = { sourceId, frameNumber };

    // 1. Check cache
    const CachedFrame* cached = cache_.get(key);

    // 2. On miss: decode and insert into cache
    if (!cached) {
        VideoDecoder::DecodedFrame decoded;
        if (!decoder.seekAndDecode(timeSeconds, decoded)) return {};

        CachedFrame cf;
        cf.yPlane  = std::move(decoded.yPlane);
        cf.uPlane  = std::move(decoded.uPlane);
        cf.vPlane  = std::move(decoded.vPlane);
        cf.width   = decoded.width;
        cf.height  = decoded.height;
        cf.yStride = decoded.yStride;
        cf.uStride = decoded.uStride;
        cf.vStride = decoded.vStride;

        cache_.put(key, std::move(cf));
        cached = cache_.get(key);
        if (!cached) return {};  // should not happen
    }

    // 3. Compute output dimensions
    int outW = 0, outH = 0;
    computeOutputSize(cached->width, cached->height, maxWidth, maxHeight, outW, outH);
    if (outW <= 0 || outH <= 0) return {};

    // 4. Get or create libswscale context for YUV420P → RGB24 with downscale
    SwsContext* sws = getScaler(src, cached->width, cached->height, outW, outH);
    if (!sws) return {};

    // 5. Convert + downscale in one pass
    const uint8_t* srcSlice[3] = {
        cached->yPlane.data(),
        cached->uPlane.data(),
        cached->vPlane.data()
    };
    int srcStride[3] = { cached->yStride, cached->uStride, cached->vStride };

    std::vector<uint8_t> rgb(outW * outH * 3);
    uint8_t* dstSlice[1] = { rgb.data() };
    int dstStride[1] = { outW * 3 };

    sws_scale(sws, srcSlice, srcStride, 0, cached->height, dstSlice, dstStride);

    // 6. Encode RGB24 → JPEG
    std::vector<uint8_t> jpeg;
    jpeg.reserve(outW * outH / 4);  // rough estimate
    stbi_write_jpg_to_func(stbWriteCallback, &jpeg, outW, outH, 3, rgb.data(), quality);

    return jpeg;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

SwsContext* FrameServer::getScaler(OpenSource& src, int srcW, int srcH,
                                    int dstW, int dstH) {
    const int key = dstW * 10000 + dstH;
    auto it = src.scalers.find(key);
    if (it != src.scalers.end()) return it->second;

    SwsContext* ctx = sws_getContext(
        srcW, srcH, AV_PIX_FMT_YUV420P,
        dstW, dstH, AV_PIX_FMT_RGB24,
        SWS_BILINEAR, nullptr, nullptr, nullptr
    );
    if (ctx) src.scalers[key] = ctx;
    return ctx;
}

void FrameServer::computeOutputSize(int srcW, int srcH,
                                     int maxW, int maxH,
                                     int& outW, int& outH) {
    if (srcW <= 0 || srcH <= 0) { outW = outH = 0; return; }

    // No constraint
    if (maxW <= 0 && maxH <= 0) { outW = srcW; outH = srcH; return; }

    double scale = 1.0;
    if (maxW > 0) scale = std::min(scale, static_cast<double>(maxW) / srcW);
    if (maxH > 0) scale = std::min(scale, static_cast<double>(maxH) / srcH);

    outW = std::max(2, static_cast<int>(srcW * scale) & ~1);  // even width
    outH = std::max(2, static_cast<int>(srcH * scale) & ~1);  // even height
}
