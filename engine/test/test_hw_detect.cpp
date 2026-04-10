// test_hw_detect.cpp — Verifies HwEncoderDetector probes and reports encoder availability.
// Runs detection, prints all results, verifies built-in encoders are always available.

#include "render/HwEncoderDetector.h"

extern "C" {
#include <libavcodec/avcodec.h>
}

// Force assert even in Release builds (NDEBUG is defined)
#undef NDEBUG
#include <cassert>
#include <cstdio>

int main()
{
    std::fprintf(stderr, "\n[TEST:HwDetect] Starting hardware encoder detection tests...\n");

    // ── Test 1: Run detection ───────────────────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:HwDetect] --- Test 1: Run detection ---\n");

        HwEncoderDetector detector;
        assert(!detector.hasDetected() && "Should not be detected before detect()");

        detector.detect();
        assert(detector.hasDetected() && "Should be detected after detect()");

        std::fprintf(stderr, "[TEST:HwDetect] Test 1: PASSED\n");
    }

    // ── Test 2: Print all probed encoders ───────────────────────────────────
    HwEncoderDetector detector;
    detector.detect();

    {
        std::fprintf(stderr, "\n[TEST:HwDetect] --- Test 2: Print all probed encoders ---\n");

        // H.264
        auto h264 = detector.getAvailableEncoders(AV_CODEC_ID_H264);
        std::fprintf(stderr, "[TEST:HwDetect] H.264 encoders (%zu probed):\n", h264.size());
        for (const auto& e : h264) {
            std::fprintf(stderr, "[TEST:HwDetect]   %s (%s) hw=%s available=%s\n",
                         e.name.c_str(), e.displayName.c_str(),
                         e.isHardware ? "YES" : "NO",
                         e.isAvailable ? "YES" : "NO");
        }
        assert(!h264.empty() && "H.264 probe list should not be empty");

        // H.265
        auto hevc = detector.getAvailableEncoders(AV_CODEC_ID_HEVC);
        std::fprintf(stderr, "[TEST:HwDetect] H.265 encoders (%zu probed):\n", hevc.size());
        for (const auto& e : hevc) {
            std::fprintf(stderr, "[TEST:HwDetect]   %s (%s) hw=%s available=%s\n",
                         e.name.c_str(), e.displayName.c_str(),
                         e.isHardware ? "YES" : "NO",
                         e.isAvailable ? "YES" : "NO");
        }
        assert(!hevc.empty() && "H.265 probe list should not be empty");

        // AV1
        auto av1 = detector.getAvailableEncoders(AV_CODEC_ID_AV1);
        std::fprintf(stderr, "[TEST:HwDetect] AV1 encoders (%zu probed):\n", av1.size());
        for (const auto& e : av1) {
            std::fprintf(stderr, "[TEST:HwDetect]   %s (%s) hw=%s available=%s\n",
                         e.name.c_str(), e.displayName.c_str(),
                         e.isHardware ? "YES" : "NO",
                         e.isAvailable ? "YES" : "NO");
        }
        assert(!av1.empty() && "AV1 probe list should not be empty");

        std::fprintf(stderr, "[TEST:HwDetect] Test 2: PASSED\n");
    }

    // ── Test 3: Built-in encoders always available ──────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:HwDetect] --- Test 3: Built-in encoders always available ---\n");

        // MPEG-4 (always compiled into FFmpeg)
        auto mpeg4 = detector.getAvailableEncoders(AV_CODEC_ID_MPEG4);
        bool hasMpeg4 = false;
        for (const auto& e : mpeg4) {
            if (e.name == "mpeg4" && e.isAvailable) hasMpeg4 = true;
        }
        std::fprintf(stderr, "[TEST:HwDetect] mpeg4 available: %s\n", hasMpeg4 ? "YES" : "NO");
        assert(hasMpeg4 && "mpeg4 built-in encoder must always be available");

        // AAC (always compiled into FFmpeg)
        auto aac = detector.getAvailableEncoders(AV_CODEC_ID_AAC);
        bool hasAAC = false;
        for (const auto& e : aac) {
            if (e.name == "aac" && e.isAvailable) hasAAC = true;
        }
        std::fprintf(stderr, "[TEST:HwDetect] aac available: %s\n", hasAAC ? "YES" : "NO");
        assert(hasAAC && "aac built-in encoder must always be available");

        // DNxHD (built-in)
        auto dnxhd = detector.getAvailableEncoders(AV_CODEC_ID_DNXHD);
        bool hasDnxhd = false;
        for (const auto& e : dnxhd) {
            if (e.name == "dnxhd" && e.isAvailable) hasDnxhd = true;
        }
        std::fprintf(stderr, "[TEST:HwDetect] dnxhd available: %s\n", hasDnxhd ? "YES" : "NO");
        assert(hasDnxhd && "dnxhd built-in encoder must always be available");

        std::fprintf(stderr, "[TEST:HwDetect] Test 3: PASSED\n");
    }

    // ── Test 4: Default encoder selection ───────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:HwDetect] --- Test 4: Default encoder selection ---\n");

        // MPEG-4 default must always be non-empty (built-in)
        auto defMpeg4 = detector.getDefaultEncoder(AV_CODEC_ID_MPEG4);
        std::fprintf(stderr, "[TEST:HwDetect] Default MPEG-4: '%s'\n", defMpeg4.c_str());
        assert(!defMpeg4.empty() && "Default MPEG-4 encoder must be non-empty");
        assert(defMpeg4 == "mpeg4");

        // H.264: print default (may be hw encoder or empty if no hw + no libx264)
        auto defH264 = detector.getDefaultEncoder(AV_CODEC_ID_H264);
        std::fprintf(stderr, "[TEST:HwDetect] Default H.264: '%s'\n", defH264.c_str());
        // On a system with a discrete GPU, at least one hw encoder should be available.
        // We don't hard-assert this since CI might lack GPU drivers.
        if (defH264.empty()) {
            std::fprintf(stderr, "[TEST:HwDetect] WARNING: No H.264 encoder available "
                         "(no hardware encoder and no libx264 in this FFmpeg build)\n");
        }

        // H.265: print default
        auto defHEVC = detector.getDefaultEncoder(AV_CODEC_ID_HEVC);
        std::fprintf(stderr, "[TEST:HwDetect] Default H.265: '%s'\n", defHEVC.c_str());

        // AV1: print default
        auto defAV1 = detector.getDefaultEncoder(AV_CODEC_ID_AV1);
        std::fprintf(stderr, "[TEST:HwDetect] Default AV1: '%s'\n", defAV1.c_str());

        std::fprintf(stderr, "[TEST:HwDetect] Test 4: PASSED\n");
    }

    // ── Test 5: GPU vendor preference ───────────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:HwDetect] --- Test 5: GPU vendor preference ---\n");

        // Create two detectors with different vendor preferences
        HwEncoderDetector detNV;
        detNV.setGpuVendorId(0x10DE);  // NVIDIA
        detNV.detect();

        HwEncoderDetector detAMD;
        detAMD.setGpuVendorId(0x1002); // AMD
        detAMD.detect();

        auto defNV  = detNV.getDefaultEncoder(AV_CODEC_ID_H264);
        auto defAMD = detAMD.getDefaultEncoder(AV_CODEC_ID_H264);

        std::fprintf(stderr, "[TEST:HwDetect] NVIDIA-preferred H.264: '%s'\n", defNV.c_str());
        std::fprintf(stderr, "[TEST:HwDetect] AMD-preferred H.264: '%s'\n", defAMD.c_str());

        // If both NVENC and AMF are available, the vendor-specific detector
        // should prefer its own vendor's encoder.
        // We just verify it doesn't crash and returns consistent results.
        auto encodersNV = detNV.getAvailableEncoders(AV_CODEC_ID_H264);
        for (const auto& e : encodersNV) {
            // Availability should be the same regardless of vendor preference
            auto encodersAMD = detAMD.getAvailableEncoders(AV_CODEC_ID_H264);
            for (const auto& e2 : encodersAMD) {
                if (e.name == e2.name) {
                    assert(e.isAvailable == e2.isAvailable &&
                           "Availability should not depend on vendor preference");
                }
            }
        }

        std::fprintf(stderr, "[TEST:HwDetect] Test 5: PASSED\n");
    }

    // ── Test 6: Re-detection (refresh) ──────────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:HwDetect] --- Test 6: Re-detection ---\n");

        HwEncoderDetector det;
        det.detect();
        auto first = det.getAvailableEncoders(AV_CODEC_ID_MPEG4);

        det.refresh();
        auto second = det.getAvailableEncoders(AV_CODEC_ID_MPEG4);

        assert(first.size() == second.size() && "Refresh should produce same count");
        for (size_t i = 0; i < first.size(); ++i) {
            assert(first[i].name == second[i].name);
            assert(first[i].isAvailable == second[i].isAvailable);
        }

        std::fprintf(stderr, "[TEST:HwDetect] Test 6: PASSED\n");
    }

    std::fprintf(stderr, "\n[TEST:HwDetect] ALL TESTS PASSED\n");
    std::_Exit(0);
}
