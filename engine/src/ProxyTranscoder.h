#pragma once

#include <functional>
#include <string>

// ─── ProxyCodec ───────────────────────────────────────────────────────────────
// Which codec family a preview proxy (whole-source or per-region) is encoded in.
//
//   H264  — the default. Short fixed-GOP H.264 (keyint 48, no scene-cut GOP
//           stretching) in a QuickTime .mov. ~10x smaller than the intra
//           proxies it replaces (a 31-minute 720p episode: ~2.6 GB MJPEG →
//           ~330 MB). Random access decodes at most 47 frames past a keyframe;
//           RenderVideoDecoder's BACKWARD-seek + decode-to-target-PTS loop
//           handles that, and the proxy gets D3D11VA decode (intra codecs are
//           forced to software). Encoder ladder: libx264 (CRF 23, veryfast) if
//           the linked FFmpeg has it, else Media Foundation h264_mf (always
//           present on Windows 10/11 with the Media Feature Pack).
//   Intra — the legacy all-intra ladder (DNxHR LB / MJPEG): every frame a
//           keyframe, exact zero-walk seeks, 10-20x larger files. Opt-in
//           "high-quality proxy" mode.
//
// The codec is part of the proxy FILE NAME (see getSourcePreviewProxyPath /
// getRegionProxyPath), so an H.264 proxy and its legacy intra predecessor can
// coexist on disk. That is what makes migration safe on Windows: the new file
// is written beside the old one (which the live decoder may hold open and
// therefore cannot be overwritten), references switch over once it is complete,
// and only then is the old file retired.
enum class ProxyCodec : int {
    H264  = 0,
    Intra = 1,
};

// ─── ProxyTranscoder ──────────────────────────────────────────────────────────
// Preview-only artifact generation: a single representative poster JPEG per
// source, and downscaled proxy clips for fast scrubbing/playback.
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
    // Polled by long transcodes between frames; returning true abandons the job
    // (the partial .tmp is deleted, any existing proxy is left untouched). Used
    // so a project close / project switch never has to wait out — or kill — a
    // multi-minute whole-source encode.
    using CancelFn = std::function<bool()>;

    // ── Proxy codec preference (process-wide) ────────────────────────────────
    // The user's proxy-codec setting (app settings, pushed by the UI at engine
    // start and on change). Applies to proxies generated from now on; existing
    // proxies are only re-encoded by the explicit on-open migration.
    static void       setPreferredCodec(ProxyCodec codec);
    static ProxyCodec requestedCodec();
    // The codec new proxies will ACTUALLY be encoded in: requestedCodec(),
    // downgraded to Intra when no H.264 encoder can be opened in this build /
    // on this machine (logged once). Callers name output files with THIS value
    // so a file called *.h264.mov is always really H.264.
    static ProxyCodec preferredCodec();
    // True if libx264 or h264_mf can be opened (probed once, cached).
    static bool       h264EncoderAvailable();
    // preferredCodec() for a proxy of targetW × targetH: Intra below 128×72,
    // because the Media Foundation H.264 encoder rejects very small frames
    // (MF_E_INVALIDMEDIATYPE under ~64 px wide) and such proxies cost nothing
    // as intra anyway. Callers size-check with THIS before naming a file.
    static ProxyCodec codecForTargetSize(int targetW, int targetH);
    static const char* codecTag(ProxyCodec codec);   // "h264" | "intra"

    // Transcode the whole source video to a downscaled (<=1080p) all-intra proxy.
    // BLOCKING call — runs in-process on the linked libav (no subprocess).
    // Returns path to proxy file on success, empty string on failure.
    static std::string transcode(
        const std::string& inputPath,
        const std::string& outputDir,
        std::function<void(float progress)> progressCallback = nullptr
    );

    // Transcode a time range [startTimeSec, endTimeSec) of inputPath to
    // outputPath as a downscaled proxy at (targetWidth × targetHeight) in
    // `codec`, capped to <=1080p. BLOCKING, in-process (no subprocess). Returns
    // true on success. Creates parent dirs. Seeks to the keyframe at/before
    // startTimeSec, decodes forward, and re-encodes only the frames inside the
    // range.
    static bool transcodeRange(
        const std::string& inputPath,
        const std::string& outputPath,
        double             startTimeSec,
        double             endTimeSec,
        int                targetWidth,
        int                targetHeight,
        std::function<void(float progress)> progressCallback = nullptr,
        ProxyCodec         codec = ProxyCodec::Intra,
        CancelFn           shouldCancel = nullptr
    );

    // Per-region proxy path, keyed by codec:
    //   H264 : <outputDir>/<regionId>.h264.mov
    //   Intra: <outputDir>/<regionId>.mxf   (legacy name; QuickTime inside —
    //                                        see transcodeImpl)
    static std::string getRegionProxyPath(const std::string& outputDir,
                                          int regionId,
                                          ProxyCodec codec);

    // ── Full-quality section export (NOT a preview artifact) ─────────────────
    // Transcode a time range [startTimeSec, endTimeSec) of inputPath to
    // outputPath as a VIDEO-ONLY DNxHR HQX 10-bit .mov at the source's NATIVE
    // resolution — unlike transcode()/transcodeRange() above, this never
    // downscales or caps to 1080p. Used by the sample "Export Video" feature to
    // produce a re-encoded, frame-accurate section a user can mask externally
    // (e.g. green-screen rotoscope) and swap back in. Falls back to DNxHR LB /
    // MJPEG if HQX isn't compiled in (same ladder as the highBitDepth preview
    // proxy). Callers that also need the section's audio must mux it in
    // separately (see XlethEngineService.cpp's Video_ExportRegion, which reuses
    // SampleBank for the audio decode). BLOCKING, in-process. Returns true on
    // success.
    static bool transcodeSectionHQX(
        const std::string& inputPath,
        const std::string& outputPath,
        double             startTimeSec,
        double             endTimeSec,
        std::function<void(float progress)> progressCallback = nullptr
    );

    // ── Whole-source preview proxy (preview-only, all cells) ─────────────────
    // Transcode the ENTIRE source to ONE small preview proxy at `targetHeight`
    // (aspect-preserved, even dims, HIGH-QUALITY lanczos scaling). This is the
    // single artifact that every preview decode reads from — grid cells AND
    // fullscreen/backdrop layers — so we never live-decode the 4K original
    // during preview. Every source frame is kept at the source frame rate, so
    // frame indices map 1:1: a caller that decodes frame N of the proxy gets the
    // same instant as frame N of the source (no time-base remap).
    //
    // Codec (see ProxyCodec):
    //   • H264  — short fixed GOP (48). Random access walks <=47 frames from the
    //             preceding keyframe; the decoders already seek BACKWARD and
    //             decode forward to the target PTS, and D3D11VA decode keeps the
    //             walk cheap. ~10x smaller than the intra ladder.
    //   • Intra — MJPEG first, DNxHR LB fallback (see buildProxyEncoders for why
    //             this long, unattended job prefers MJPEG). Exact zero-walk
    //             seeks at 10-20x the disk cost.
    //
    // BLOCKING, in-process (no subprocess). Progress-reported via progressCallback
    // (0..1). Writes atomically (temp + rename). Non-fatal: returns false and logs
    // loudly if the source can't be decoded or no encoder accepts the size —
    // the caller then falls back to poster/original. Returns true on success.
    //
    // highBitDepth=true preserves 10-bit through the proxy (10-bit intra encoder
    // ladder; `codec` is ignored — the H.264 encoders here are 8-bit only) — used
    // by the RENDER path for 10-bit sources so the encoded output does not band.
    // Preview always passes false (8-bit is fine for editing and keeps the cache
    // shared with 8-bit render proxies of the same height).
    static bool transcodeSourcePreview(
        const std::string& inputPath,
        const std::string& outputPath,
        int                targetHeight,
        bool               highBitDepth = false,
        std::function<void(float progress)> progressCallback = nullptr,
        ProxyCodec         codec = ProxyCodec::Intra,
        CancelFn           shouldCancel = nullptr);

    // Expected whole-source proxy path, keyed by (source, height, bitDepth, codec):
    //   8-bit H.264 : <outputDir>/<stem>.preview.<height>p.h264.mov
    //   8-bit intra : <outputDir>/<stem>.preview.<height>p.mov      (legacy name)
    //   10-bit      : <outputDir>/<stem>.preview.<height>p10.mov    (always intra)
    // Height-keyed so a 720p and a 480p proxy never collide; bit-depth-keyed so an
    // 8-bit preview proxy and a 10-bit render proxy of the same height stay
    // distinct (and an 8-bit render proxy reuses the preview proxy); codec-keyed
    // so migration can write the H.264 proxy beside the intra one it replaces.
    // All persist on disk across sessions.
    static std::string getSourcePreviewProxyPath(const std::string& sourcePath,
                                                 const std::string& outputDir,
                                                 int proxyHeight,
                                                 bool highBitDepth = false,
                                                 ProxyCodec codec = ProxyCodec::Intra);

    // True if a whole-source proxy for (source, height, bitDepth, codec) exists on
    // disk and is newer than the source (idempotent restart: reuse, don't rebuild).
    static bool sourcePreviewProxyExists(const std::string& sourcePath,
                                         const std::string& outputDir,
                                         int proxyHeight,
                                         bool highBitDepth = false,
                                         ProxyCodec codec = ProxyCodec::Intra);

    // Resolve the whole-source proxy to USE for (source, height, bitDepth),
    // whatever codec it is in: the H.264 file if valid, else the legacy intra
    // file if valid, else found=false. This — not a single-codec exists() check —
    // is what every consumer (project load, preview self-heal, render planner)
    // uses, so switching the codec setting never orphans a valid proxy ("the
    // setting applies to new proxies only") and an un-migrated legacy proxy keeps
    // serving preview until its H.264 replacement is complete.
    struct ProxyLookup {
        bool        found = false;
        std::string path;
        ProxyCodec  codec = ProxyCodec::Intra;
    };
    static ProxyLookup findSourcePreviewProxy(const std::string& sourcePath,
                                              const std::string& outputDir,
                                              int proxyHeight,
                                              bool highBitDepth = false);

    // ── Proxy-directory housekeeping ─────────────────────────────────────────
    // Sweeping the "*.tmp" partial outputs of interrupted generations is NOT done
    // here: it lives in project/RegenerableFiles (sweepPartialFiles), the single
    // registry of everything that may be deleted, so the on-open sweep, "Clean
    // up project" and purge-on-close can never disagree about what a leftover is.

    // Delete one file by UTF-8 path (std::filesystem's narrow-string overloads
    // use the ANSI codepage on Windows and miss non-ANSI names). Returns true if
    // the file is gone afterwards (removed, or never existed).
    static bool removeFileUtf8(const std::string& path);

    // UTF-8-safe existence check (same ANSI-codepage reason as above).
    static bool fileExistsUtf8(const std::string& path);

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

    // How many proxy/poster generations may run at once on this machine
    // (1 on small machines; see HardwareTier::proxyGenerationSlots). ProxyManager
    // sizes its worker pool from this so a long whole-source encode never
    // blocks every poster and region proxy behind it.
    static int generationSlots();
};
