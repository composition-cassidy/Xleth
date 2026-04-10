#pragma once

/**
 * HwEncoderDetector — Probe FFmpeg encoders at startup to find real availability.
 *
 * For each codec family (H.264, H.265, AV1), probes hardware encoders
 * (NVENC, AMF, QSV) and software fallbacks (libx264, libx265, etc.) by
 * actually test-opening them with avcodec_open2.  This catches cases where
 * the encoder exists in FFmpeg but the GPU driver doesn't support it.
 *
 * Results are cached — call detect() once at startup, refresh() on GPU change.
 *
 * Can correlate with GpuDeviceManager's vendorId to prefer the encoder
 * matching the active GPU (e.g. prefer NVENC on NVIDIA, AMF on AMD).
 *
 * No JUCE dependency.
 */

#include <cstdint>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// EncoderInfo — describes one probed encoder
// ---------------------------------------------------------------------------
struct EncoderInfo {
    std::string name;           // "h264_nvenc", "h264_amf", "libx264"
    std::string displayName;    // "H.264 (NVENC)", "H.264 (AMF)", etc.
    int         codecId;        // AV_CODEC_ID_H264 (int to avoid FFmpeg header dep)
    bool        isHardware;
    bool        isAvailable;    // found AND test-open succeeded
};

// ---------------------------------------------------------------------------
// HwEncoderDetector
// ---------------------------------------------------------------------------
class HwEncoderDetector
{
public:
    HwEncoderDetector();
    ~HwEncoderDetector();

    // Non-copyable
    HwEncoderDetector(const HwEncoderDetector&)            = delete;
    HwEncoderDetector& operator=(const HwEncoderDetector&) = delete;

    // ── Detection ─────────────────────────────────────────────────────────

    /**
     * Run full detection for all codec families.
     * Safe to call multiple times (clears and re-detects).
     */
    void detect();

    /**
     * Set the active GPU vendor ID to prefer matching hardware encoders.
     * Call before detect() or refresh() for best results.
     * Uses GpuVendor::NVIDIA (0x10DE), GpuVendor::AMD (0x1002), etc.
     */
    void setGpuVendorId(uint32_t vendorId);

    /** Re-detect all encoders (GPU change or user refresh). */
    void refresh() { detect(); }

    bool hasDetected() const { return detected_; }

    // ── Query ─────────────────────────────────────────────────────────────

    /**
     * Get all probed encoders for a given codec ID.
     * Returns entries even for unavailable encoders (isAvailable=false).
     * @param codecId  AV_CODEC_ID_H264, AV_CODEC_ID_HEVC, AV_CODEC_ID_AV1, etc.
     */
    std::vector<EncoderInfo> getAvailableEncoders(int codecId) const;

    /**
     * Get the recommended encoder name for a codec ID.
     * Returns the first available hardware encoder (preferring the active GPU vendor),
     * then software fallback.  Empty string if nothing is available.
     */
    std::string getDefaultEncoder(int codecId) const;

private:
    bool detected_ = false;
    uint32_t gpuVendorId_ = 0;
    std::vector<EncoderInfo> encoders_;

    /** Test-open an encoder with minimal settings to verify real availability. */
    static bool testEncoder(const char* encoderName);

public:
    /**
     * Map a codec name string to its AVCodecID value.
     * Supported names: "h264", "hevc", "av1", "mpeg4", "dnxhd", "prores", "aac".
     * Returns -1 for unknown names.
     */
    static int codecNameToId(const char* name);
};
