#pragma once

#include <functional>
#include <string>

// ─── ProxyTranscoder ──────────────────────────────────────────────────────────
// Preview-only artifact generation: a single representative poster JPEG per
// source, and downscaled all-intra proxy clips for fast scrubbing/playback.
//
// IN-PROCESS libav (migrated from the ffmpeg.exe CLI):
//   This class used to shell out to the `ffmpeg` *command-line binary* for every
//   poster and proxy job. The engine, however, links FFmpeg as *libraries*
//   (libavformat/libavcodec/libswscale) and packaged builds ship ONLY those
//   runtime DLLs — not ffmpeg.exe. So on a shipped build every CLI job exited
//   non-zero and silently produced nothing (empty proxies/, posterReady=false).
//
//   Every generation path below now decodes and encodes with the *linked*
//   libav, so it works with zero external binaries. There is no subprocess and
//   no dependency on ffmpeg.exe being on PATH. The export/offline render path is
//   unaffected — it always uses the original full-quality source, never a proxy.
//
//   Non-fatal everywhere: if the linked build lacks an AV1 decoder (the grid's
//   heaviest real source is 4K AV1) or a usable all-intra encoder, generation
//   fails loudly in the log and the caller falls back to live decode. Nothing
//   here crashes or blocks the audio/video threads — all jobs run on the
//   ProxyManager worker pool.
class ProxyTranscoder {
public:
    // Transcode the whole source video to a downscaled (<=1080p) all-intra proxy.
    // BLOCKING call — runs in-process on the linked libav (no subprocess).
    // Returns path to proxy file on success, empty string on failure.
    static std::string transcode(
        const std::string& inputPath,
        const std::string& outputDir,
        std::function<void(float progress)> progressCallback = nullptr
    );

    // Transcode a time range [startTimeSec, endTimeSec) of inputPath to
    // outputPath as a downscaled all-intra proxy at (targetWidth × targetHeight),
    // capped to <=1080p. BLOCKING, in-process (no subprocess). Returns true on
    // success. Creates parent dirs. Seeks to the keyframe at/before startTimeSec,
    // decodes forward, and re-encodes only the frames inside the range.
    static bool transcodeRange(
        const std::string& inputPath,
        const std::string& outputPath,
        double             startTimeSec,
        double             endTimeSec,
        int                targetWidth,
        int                targetHeight,
        std::function<void(float progress)> progressCallback = nullptr
    );

    // ── Whole-source preview proxy (preview-only, all cells) ─────────────────
    // Transcode the ENTIRE source to ONE small all-intra preview proxy at
    // `targetHeight` (aspect-preserved, even dims, HIGH-QUALITY lanczos scaling).
    // This is the single artifact that every preview decode reads from — grid
    // cells AND fullscreen/backdrop layers — so we never live-decode the 4K
    // original during preview. Every source frame is kept at the source frame
    // rate, so frame indices map 1:1: a caller that decodes frame N of the proxy
    // gets the same instant as frame N of the source (no time-base remap).
    //
    // Codec: all-intra (every frame a keyframe) so random access / scrubbing is a
    // cheap exact seek with no GOP to walk. We reuse the same encoder preference
    // ladder as the region proxy — DNxHR LB first, MJPEG fallback:
    //   • DNxHR LB  — small files for an intra codec, very cheap to decode, exact
    //                 seek; the canonical edit proxy. Best size/decode balance.
    //   • all-intra H.264 (libx264 -intra) would decode even cheaper per frame
    //     but this vendored FFmpeg ships no x264 encoder, and a long-GOP H.264
    //     would defeat the exact-seek requirement; MJPEG is the always-present
    //     intra fallback (bigger files, still trivially seekable).
    // The size penalty of an all-intra proxy (vs a long-GOP one) is the explicit
    // tradeoff we accept to make scrubbing into unvisited regions decode in ~0 ms.
    //
    // BLOCKING, in-process (no subprocess). Progress-reported via progressCallback
    // (0..1). Writes atomically (temp + rename). Non-fatal: returns false and logs
    // loudly if the source can't be decoded or no intra encoder accepts the size —
    // the caller then falls back to poster/original. Returns true on success.
    //
    // highBitDepth=true preserves 10-bit through the proxy (10-bit intra encoder
    // ladder) — used by the RENDER path for 10-bit sources so the encoded output
    // does not band. Preview always passes false (8-bit is fine for editing and
    // keeps the cache shared with 8-bit render proxies of the same height).
    static bool transcodeSourcePreview(
        const std::string& inputPath,
        const std::string& outputPath,
        int                targetHeight,
        bool               highBitDepth = false,
        std::function<void(float progress)> progressCallback = nullptr);

    // Expected whole-source proxy path, keyed by (source, proxyHeight, bitDepth):
    //   8-bit : <outputDir>/<stem>.preview.<height>p.mov
    //   10-bit: <outputDir>/<stem>.preview.<height>p10.mov
    // Height-keyed so a 720p and a 480p proxy never collide; bit-depth-keyed so an
    // 8-bit preview proxy and a 10-bit render proxy of the same height stay
    // distinct (and an 8-bit render proxy reuses the preview proxy). All persist on
    // disk across sessions.
    static std::string getSourcePreviewProxyPath(const std::string& sourcePath,
                                                 const std::string& outputDir,
                                                 int proxyHeight,
                                                 bool highBitDepth = false);

    // True if a whole-source proxy for (source, proxyHeight, bitDepth) exists on
    // disk and is newer than the source (idempotent restart: reuse, don't rebuild).
    static bool sourcePreviewProxyExists(const std::string& sourcePath,
                                         const std::string& outputDir,
                                         int proxyHeight,
                                         bool highBitDepth = false);

    // Probe the source's coded bit depth (bits per luma component: 8/10/12…).
    // Cheap (opens format + reads stream params, no decode) and cached per path.
    // Returns 8 on any failure. The render path uses this to decide whether a
    // proxy must preserve 10-bit.
    static int probeSourceBitDepth(const std::string& sourcePath);

    // Check if a valid proxy already exists (and is newer than source)
    static bool proxyExists(const std::string& sourcePath, const std::string& outputDir);

    // Get the expected proxy path for a source file
    static std::string getProxyPath(const std::string& sourcePath, const std::string& outputDir);

    // ── Poster / thumbnail (fast-preview representative frame) ───────────────
    // Decode ONE representative frame from inputPath in-process and write it as a
    // JPEG sidecar at outputPath, downscaled to <=640px wide (even height) so the
    // resident texture stays light. BLOCKING, no subprocess. Returns true on
    // success. Creates parent dirs. Writes atomically (temp file + rename).
    //   atTimeSec < 0 → base poster: seek to ~10% of the source duration (avoids
    //                   a black intro; the libav replacement for the old CLI
    //                   `thumbnail` filter).
    //   atTimeSec >= 0 → per-cell thumbnail: seek to that exact source time.
    static bool extractPoster(const std::string& inputPath,
                              const std::string& outputPath,
                              double atTimeSec = -1.0);

    // Per-offset thumbnail sidecar path: <outputDir>/<stem>.t<bucket>.xlposter.jpg.
    // `bucket` is a coarse source-time bucket (1-second granularity) so nearby
    // offsets of the same source share one thumbnail.
    static std::string getThumbnailPath(const std::string& sourcePath,
                                        const std::string& outputDir,
                                        int bucket);

    // Get the expected poster sidecar path (<outputDir>/<stem>.xlposter.jpg).
    static std::string getPosterPath(const std::string& sourcePath,
                                     const std::string& outputDir);

    // True if a poster sidecar exists and is newer than the source.
    static bool posterExists(const std::string& sourcePath,
                             const std::string& outputDir);

    // ── Diagnostics ──────────────────────────────────────────────────────────
    // SECONDARY diagnostic only — NOT used to gate generation any more.
    // Generation is now fully in-process on the linked libav, so a missing
    // ffmpeg.exe no longer matters. This probe is kept purely so a diagnostic
    // capture can still report whether the CLI happens to be on PATH (useful
    // when comparing against the legacy CLI path). Probed once and cached.
    static bool ffmpegAvailable();
};
