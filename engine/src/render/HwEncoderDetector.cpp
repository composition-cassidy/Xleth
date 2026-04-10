#include "render/HwEncoderDetector.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/pixfmt.h>
#include <libavutil/opt.h>
}

#include <algorithm>
#include <cstdio>
#include <cstring>

// ---------------------------------------------------------------------------
// Probe definitions — each codec family's encoder candidates
// ---------------------------------------------------------------------------

namespace {

struct EncoderProbe {
    const char* name;
    const char* displayName;
    int         codecId;       // AVCodecID
    bool        isHardware;
    uint32_t    preferVendor;  // GpuVendor ID, 0 = no preference
};

// Vendor ID constants (mirrored from GpuDeviceManager.h to avoid header dep)
constexpr uint32_t kVendorNVIDIA = 0x10DE;
constexpr uint32_t kVendorAMD    = 0x1002;
constexpr uint32_t kVendorIntel  = 0x8086;

// The probe list: order = priority (first available wins as default)
static const EncoderProbe kProbeList[] = {
    // ── H.264 ──────────────────────────────────────────────────────────
    { "h264_nvenc",   "H.264 (NVENC)",               AV_CODEC_ID_H264, true,  kVendorNVIDIA },
    { "h264_amf",     "H.264 (AMF)",                 AV_CODEC_ID_H264, true,  kVendorAMD    },
    { "h264_qsv",     "H.264 (Quick Sync)",          AV_CODEC_ID_H264, true,  kVendorIntel  },
    { "h264_mf",      "H.264 (Media Foundation)",    AV_CODEC_ID_H264, false, 0             },
    { "libx264",      "H.264 (x264)",                AV_CODEC_ID_H264, false, 0             },

    // ── H.265 / HEVC ──────────────────────────────────────────────────
    { "hevc_nvenc",   "H.265 (NVENC)",               AV_CODEC_ID_HEVC, true,  kVendorNVIDIA },
    { "hevc_amf",     "H.265 (AMF)",                 AV_CODEC_ID_HEVC, true,  kVendorAMD    },
    { "hevc_qsv",     "H.265 (Quick Sync)",          AV_CODEC_ID_HEVC, true,  kVendorIntel  },
    { "hevc_mf",      "H.265 (Media Foundation)",    AV_CODEC_ID_HEVC, false, 0             },
    { "libx265",      "H.265 (x265)",                AV_CODEC_ID_HEVC, false, 0             },

    // ── AV1 ────────────────────────────────────────────────────────────
    { "av1_nvenc",    "AV1 (NVENC)",                  AV_CODEC_ID_AV1,  true,  kVendorNVIDIA },
    { "av1_amf",      "AV1 (AMF)",                    AV_CODEC_ID_AV1,  true,  kVendorAMD    },
    { "av1_qsv",      "AV1 (Quick Sync)",             AV_CODEC_ID_AV1,  true,  kVendorIntel  },
    { "libsvtav1",    "AV1 (SVT-AV1)",                AV_CODEC_ID_AV1,  false, 0             },
    { "libaom-av1",   "AV1 (libaom)",                 AV_CODEC_ID_AV1,  false, 0             },

    // ── Built-in codecs (always available in any FFmpeg build) ─────────
    { "mpeg4",        "MPEG-4 SP",                    AV_CODEC_ID_MPEG4,  false, 0            },
    { "dnxhd",        "DNxHD/DNxHR",                  AV_CODEC_ID_DNXHD,  false, 0            },
    { "prores_ks",    "Apple ProRes",                 AV_CODEC_ID_PRORES,  false, 0            },

    // ── Audio (for completeness) ───────────────────────────────────────
    { "aac",          "AAC",                          AV_CODEC_ID_AAC,     false, 0            },
};

static constexpr int kProbeCount = static_cast<int>(sizeof(kProbeList) / sizeof(kProbeList[0]));

} // anonymous namespace

// ===========================================================================
// codecNameToId — string codec name → AVCodecID
// ===========================================================================

int HwEncoderDetector::codecNameToId(const char* name)
{
    if (!name) return -1;
    if (std::strcmp(name, "h264")   == 0) return AV_CODEC_ID_H264;
    if (std::strcmp(name, "hevc")   == 0) return AV_CODEC_ID_HEVC;
    if (std::strcmp(name, "av1")    == 0) return AV_CODEC_ID_AV1;
    if (std::strcmp(name, "mpeg4")  == 0) return AV_CODEC_ID_MPEG4;
    if (std::strcmp(name, "dnxhd")  == 0) return AV_CODEC_ID_DNXHD;
    if (std::strcmp(name, "prores") == 0) return AV_CODEC_ID_PRORES;
    if (std::strcmp(name, "aac")    == 0) return AV_CODEC_ID_AAC;
    return -1;
}

// ===========================================================================
// Constructor / Destructor
// ===========================================================================

HwEncoderDetector::HwEncoderDetector()  = default;
HwEncoderDetector::~HwEncoderDetector() = default;

// ===========================================================================
// setGpuVendorId
// ===========================================================================

void HwEncoderDetector::setGpuVendorId(uint32_t vendorId)
{
    gpuVendorId_ = vendorId;
}

// ===========================================================================
// testEncoder — attempt real avcodec_open2 with minimal settings
// ===========================================================================

bool HwEncoderDetector::testEncoder(const char* encoderName)
{
    const AVCodec* codec = avcodec_find_encoder_by_name(encoderName);
    if (!codec) return false;

    AVCodecContext* ctx = avcodec_alloc_context3(codec);
    if (!ctx) return false;

    // ── Audio encoders ────────────────────────────────────────────────────
    if (codec->type == AVMEDIA_TYPE_AUDIO) {
        ctx->sample_rate = 48000;
        ctx->bit_rate    = 128000;

        // Pick a supported sample format via the new FFmpeg 7 API
        const AVSampleFormat* fmts = nullptr;
        int numFmts = 0;
        int cfgRet = avcodec_get_supported_config(nullptr, codec,
                         AV_CODEC_CONFIG_SAMPLE_FORMAT, 0,
                         reinterpret_cast<const void**>(&fmts), &numFmts);
        if (cfgRet >= 0 && fmts && numFmts > 0)
            ctx->sample_fmt = fmts[0];
        else
            ctx->sample_fmt = AV_SAMPLE_FMT_FLTP;

        AVChannelLayout layout = AV_CHANNEL_LAYOUT_STEREO;
        av_channel_layout_copy(&ctx->ch_layout, &layout);

        int ret = avcodec_open2(ctx, codec, nullptr);
        avcodec_free_context(&ctx);
        return ret >= 0;
    }

    // ── Video encoders ────────────────────────────────────────────────────

    // DNxHD/DNxHR requires specific resolution+bitrate+pixfmt profiles.
    // Test with a known valid profile: 1920x1080 @ 120Mbps yuv422p @ 30fps.
    bool isDnxhd = (codec->id == AV_CODEC_ID_DNXHD);
    if (isDnxhd) {
        ctx->width     = 1920;
        ctx->height    = 1080;
        ctx->time_base = { 1001, 30000 };
        ctx->framerate = { 30000, 1001 };
        ctx->pix_fmt   = AV_PIX_FMT_YUV422P;
        ctx->bit_rate  = 120000000;  // 120 Mbps — valid DNxHD profile

        int ret = avcodec_open2(ctx, codec, nullptr);
        avcodec_free_context(&ctx);
        return ret >= 0;
    }

    // General video: minimal 64x64 test
    ctx->width     = 64;
    ctx->height    = 64;
    ctx->time_base = { 1, 30 };
    ctx->framerate = { 30, 1 };

    // Query the encoder's supported pixel formats via the new FFmpeg 7 API.
    // Use the first supported format for the most reliable test.
    AVPixelFormat testFmts[] = { AV_PIX_FMT_NV12, AV_PIX_FMT_YUV420P, AV_PIX_FMT_NONE };

    const AVPixelFormat* supportedFmts = nullptr;
    int numSupported = 0;
    int cfgRet = avcodec_get_supported_config(nullptr, codec,
                     AV_CODEC_CONFIG_PIX_FORMAT, 0,
                     reinterpret_cast<const void**>(&supportedFmts), &numSupported);
    if (cfgRet >= 0 && supportedFmts && numSupported > 0) {
        testFmts[0] = supportedFmts[0];
        testFmts[1] = AV_PIX_FMT_NONE;
    }

    for (int i = 0; testFmts[i] != AV_PIX_FMT_NONE; ++i) {
        ctx->pix_fmt = testFmts[i];

        // Some encoders need a bitrate to avoid error
        ctx->bit_rate = 500000;

        int ret = avcodec_open2(ctx, codec, nullptr);
        if (ret >= 0) {
            avcodec_free_context(&ctx);
            return true;
        }

        // Reset context for next attempt — must re-alloc since open2 may have
        // partially initialized internal state
        avcodec_free_context(&ctx);
        ctx = avcodec_alloc_context3(codec);
        if (!ctx) return false;
        ctx->width     = 64;
        ctx->height    = 64;
        ctx->time_base = { 1, 30 };
        ctx->framerate = { 30, 1 };
    }

    avcodec_free_context(&ctx);
    return false;
}

// ===========================================================================
// detect
// ===========================================================================

void HwEncoderDetector::detect()
{
    encoders_.clear();
    encoders_.reserve(kProbeCount);

    std::fprintf(stderr, "[HwDetect] Starting encoder detection...\n");

    int availableCount = 0;

    for (int i = 0; i < kProbeCount; ++i) {
        const auto& probe = kProbeList[i];

        EncoderInfo info;
        info.name        = probe.name;
        info.displayName = probe.displayName;
        info.codecId     = probe.codecId;
        info.isHardware  = probe.isHardware;
        info.isAvailable = false;

        // Step 1: Check if encoder is compiled into FFmpeg
        const AVCodec* codec = avcodec_find_encoder_by_name(probe.name);
        bool found = (codec != nullptr);

        // Step 2: If found, test-open to verify real hardware/driver support
        bool testOpen = false;
        if (found) {
            testOpen = testEncoder(probe.name);
            info.isAvailable = testOpen;
            if (testOpen) ++availableCount;
        }

        std::fprintf(stderr, "[HwDetect] Probing '%s': found=%s testOpen=%s\n",
                     probe.name,
                     found ? "yes" : "no",
                     found ? (testOpen ? "yes" : "no") : "n/a");

        if (found && !testOpen) {
            // Log why it failed (for debugging driver issues)
            // Re-run to get the error code for logging
            AVCodecContext* ctx = avcodec_alloc_context3(codec);
            if (ctx) {
                ctx->width = 64; ctx->height = 64;
                ctx->time_base = {1, 30};
                ctx->framerate = {30, 1};
                if (codec->type == AVMEDIA_TYPE_AUDIO) {
                    ctx->sample_rate = 48000;
                    ctx->sample_fmt = AV_SAMPLE_FMT_FLTP;
                    ctx->bit_rate = 128000;
                    AVChannelLayout layout = AV_CHANNEL_LAYOUT_STEREO;
                    av_channel_layout_copy(&ctx->ch_layout, &layout);
                } else {
                    ctx->pix_fmt = AV_PIX_FMT_NV12;
                    ctx->bit_rate = 500000;
                }
                int ret = avcodec_open2(ctx, codec, nullptr);
                std::fprintf(stderr, "[HwDetect] '%s' test-open failed: avcodec_open2 returned %d\n",
                             probe.name, ret);
                avcodec_free_context(&ctx);
            }
        }

        encoders_.push_back(std::move(info));
    }

    detected_ = true;

    std::fprintf(stderr, "[HwDetect] Detection complete: %d encoders available out of %d probed\n",
                 availableCount, kProbeCount);

    // Log per-codec summary
    auto bestH264 = getDefaultEncoder(AV_CODEC_ID_H264);
    auto bestHEVC = getDefaultEncoder(AV_CODEC_ID_HEVC);
    auto bestAV1  = getDefaultEncoder(AV_CODEC_ID_AV1);

    std::fprintf(stderr, "[HwDetect] H.264: %s | H.265: %s | AV1: %s\n",
                 bestH264.empty() ? "(none)" : bestH264.c_str(),
                 bestHEVC.empty() ? "(none)" : bestHEVC.c_str(),
                 bestAV1.empty()  ? "(none)" : bestAV1.c_str());

    // Log default selection details
    if (!bestH264.empty()) {
        bool hw = false;
        for (const auto& e : encoders_)
            if (e.name == bestH264) { hw = e.isHardware; break; }
        std::fprintf(stderr, "[HwDetect] Default H.264 encoder: '%s' (hardware=%s)\n",
                     bestH264.c_str(), hw ? "yes" : "no");
    }
    if (!bestHEVC.empty()) {
        bool hw = false;
        for (const auto& e : encoders_)
            if (e.name == bestHEVC) { hw = e.isHardware; break; }
        std::fprintf(stderr, "[HwDetect] Default H.265 encoder: '%s' (hardware=%s)\n",
                     bestHEVC.c_str(), hw ? "yes" : "no");
    }
    if (!bestAV1.empty()) {
        bool hw = false;
        for (const auto& e : encoders_)
            if (e.name == bestAV1) { hw = e.isHardware; break; }
        std::fprintf(stderr, "[HwDetect] Default AV1 encoder: '%s' (hardware=%s)\n",
                     bestAV1.c_str(), hw ? "yes" : "no");
    }
}

// ===========================================================================
// getAvailableEncoders
// ===========================================================================

std::vector<EncoderInfo> HwEncoderDetector::getAvailableEncoders(int codecId) const
{
    std::vector<EncoderInfo> result;
    for (const auto& e : encoders_) {
        if (e.codecId == codecId)
            result.push_back(e);
    }
    return result;
}

// ===========================================================================
// getDefaultEncoder
// ===========================================================================

std::string HwEncoderDetector::getDefaultEncoder(int codecId) const
{
    // Phase 1: Find hardware encoders matching the active GPU vendor
    if (gpuVendorId_ != 0) {
        for (int i = 0; i < kProbeCount; ++i) {
            const auto& probe = kProbeList[i];
            if (probe.codecId != codecId || !probe.isHardware)
                continue;
            if (probe.preferVendor != gpuVendorId_)
                continue;
            // Check if it was found available
            for (const auto& e : encoders_) {
                if (e.name == probe.name && e.isAvailable)
                    return e.name;
            }
        }
    }

    // Phase 2: First available hardware encoder (any vendor)
    for (const auto& e : encoders_) {
        if (e.codecId == codecId && e.isHardware && e.isAvailable)
            return e.name;
    }

    // Phase 3: First available software encoder
    for (const auto& e : encoders_) {
        if (e.codecId == codecId && !e.isHardware && e.isAvailable)
            return e.name;
    }

    return "";
}
