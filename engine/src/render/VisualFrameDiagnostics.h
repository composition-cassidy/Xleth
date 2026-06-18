#pragma once

/**
 * VisualFrameDiagnostics — opt-in pixel-content instrumentation for the video
 * pipeline. Lets a tester build prove *where* visible pixels disappear on a
 * failing machine (e.g. AMD hybrid-GPU) rather than only proving that bytes
 * move through the system.
 *
 * Everything here is GATED behind environment variables and is a no-op in a
 * normal preview/export run:
 *   XLETH_VISUAL_DIAG_PIXELS=1        → compute + record per-stage pixel stats
 *   XLETH_VISUAL_DIAG_DUMP_FRAMES=1   → additionally dump capped raw frames
 *
 * Callers MUST gate the (cheap) compute themselves so there is zero overhead
 * when disabled, e.g.:
 *
 *   if (xleth::visualdiag::pixelsEnabled()) {
 *       auto s = xleth::visualdiag::computeFrameStats(
 *           ptr, w, h, rowPitch, PixelFormat::BGRA, frameIndex);
 *       xleth::visualdiag::record("post-d3d11-readback", s);
 *       xleth::visualdiag::maybeDumpFrame("post-d3d11-readback", ptr, w, h,
 *                                         rowPitch, PixelFormat::BGRA, s);
 *   }
 *
 * The compute is deterministic (simple uint64 byte sum, no hashing) and labels
 * the channel order (BGRA vs RGBA) so the renderer-side RGBA readPixels stats
 * are never blindly compared against native BGRA bytes.
 *
 * No dependency on D3D11 / JUCE / FFmpeg — pure byte buffers, so it links into
 * both the engine core and the N-API bridge.
 */

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace xleth::visualdiag {

enum class PixelFormat { BGRA, RGBA };

const char* pixelFormatName(PixelFormat fmt);

// ---------------------------------------------------------------------------
// FramePixelStats — content fingerprint of one frame buffer.
// ---------------------------------------------------------------------------
struct FramePixelStats {
    bool        observed      = false;
    PixelFormat format        = PixelFormat::BGRA;
    int         width         = 0;
    int         height        = 0;
    int         rowPitch      = 0;   // bytes per row in the source buffer
    uint64_t    byteCount     = 0;   // meaningful bytes inspected (width*height*4)
    uint64_t    checksum64    = 0;   // simple sum of all meaningful bytes
    uint64_t    nonZeroBytes  = 0;
    uint64_t    nonZeroPixels = 0;   // pixels where any colour channel != 0
    double      averageLuma   = 0.0; // 0..255, channel-order aware
    std::array<uint8_t, 16> first16{};        // first 16 bytes of row 0
    std::array<uint8_t, 4>  centerPixel{};    // BGRA/RGBA per `format`
    std::array<std::array<uint8_t, 4>, 4> corners{}; // TL, TR, BL, BR
    int64_t     frameIndex    = -1;
    int64_t     tickIndex     = -1;
    double      timestamp     = 0.0; // seconds, if known (else 0)
};

/**
 * Compute content stats over a (possibly row-padded) BGRA/RGBA buffer.
 * `rowPitch` is honoured: only the first width*4 bytes of each row are
 * inspected, padding is ignored. Safe to call with a tightly-packed buffer
 * (pass rowPitch == width*4).
 */
FramePixelStats computeFrameStats(const uint8_t* data, int width, int height,
                                  int rowPitch, PixelFormat fmt,
                                  int64_t frameIndex = -1, int64_t tickIndex = -1,
                                  double timestamp = 0.0);

// Hex string of first16 (e.g. "00 11 22 ...").
std::string first16Hex(const FramePixelStats& s);

// ---------------------------------------------------------------------------
// Gating — cached once; cheap to call per frame.
// ---------------------------------------------------------------------------
bool pixelsEnabled();      // XLETH_VISUAL_DIAG_PIXELS=1
bool dumpFramesEnabled();  // XLETH_VISUAL_DIAG_DUMP_FRAMES=1

// Max raw frames written per stage per process run when dumping is enabled.
// Override with XLETH_VISUAL_DIAG_DUMP_MAX=<n>.
int maxDumpFramesPerStage();

// ---------------------------------------------------------------------------
// Per-stage registry — last + first sample, with a running count.
// Thread-safe. record() is a no-op if pixels are disabled.
// ---------------------------------------------------------------------------
void record(const char* stage, const FramePixelStats& stats);

/**
 * Optionally write one raw frame (.bgra/.rgba) + .json metadata to the
 * diagnostics folder. No-op unless dumpFramesEnabled() and the per-stage cap
 * has not been reached. Writes synchronously but is hard-capped so it cannot
 * snowball on the realtime preview thread.
 */
void maybeDumpFrame(const char* stage, const uint8_t* data, int width, int height,
                    int rowPitch, PixelFormat fmt, const FramePixelStats& stats);

struct StageSnapshot {
    std::string     stage;
    bool            observed     = false;
    uint64_t        sampleCount  = 0;
    uint64_t        dumpCount    = 0;
    FramePixelStats first;
    FramePixelStats latest;
};

// All recorded stages, in first-seen order.
std::vector<StageSnapshot> snapshotAll();

// Absolute path of the dump session folder (created lazily on first dump),
// or empty string if nothing has been dumped this run.
std::string dumpSessionDir();

} // namespace xleth::visualdiag
