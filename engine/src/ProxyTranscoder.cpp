#ifdef _MSC_VER
  #define _CRT_SECURE_NO_WARNINGS
#endif

#include "ProxyTranscoder.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <vector>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswscale/swscale.h>
}

#include <mutex>
#include <unordered_map>
#include <unordered_set>

#if defined(_WIN32) || defined(_WIN64)
  #define WIN32_LEAN_AND_MEAN
  #define NOMINMAX
  #include <windows.h>
#endif

namespace fs = std::filesystem;

// ── Windows-safe file-existence check ────────────────────────────────────────
// std::filesystem on Windows interprets narrow std::string paths as the current
// ANSI codepage, NOT UTF-8. Filenames with non-ANSI Unicode characters (e.g.
// fullwidth colon U+FF1A in "BFDIA 7： Intruder Alert.mp4") fail the ANSI
// lookup and look non-existent even when the file is present. FFmpeg's own
// avformat_open_input converts UTF-8→UTF-16 correctly and finds the file fine.
// We fix fs::exists() calls by converting the UTF-8 std::string to a wide
// string on Windows so the filesystem path is constructed correctly.
#if defined(_WIN32) || defined(_WIN64)
static std::wstring utf8ToWide(const std::string& s)
{
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    if (n <= 0) return {};
    std::wstring w(static_cast<size_t>(n - 1), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
    return w;
}
static fs::path utf8ToPath(const std::string& s)
{
    std::wstring w = utf8ToWide(s);
    return w.empty() ? fs::path(s) : fs::path(w);
}
#else
static fs::path utf8ToPath(const std::string& s) { return fs::path(s); }
#endif

// ── Atomic artifact replace ───────────────────────────────────────────────────
// Generation writes to "<target>.tmp" and only swaps it onto the real path once
// the whole artifact is complete and valid. This guarantees a previously-valid
// poster/proxy is NEVER destroyed by a failed/partial regeneration (the old code
// truncated the target up front, so a failure left nothing). On Windows we use
// MoveFileExW with MOVEFILE_REPLACE_EXISTING for an atomic same-volume swap.
static bool atomicReplace(const std::string& tmpPath, const std::string& dstPath)
{
#if defined(_WIN32) || defined(_WIN64)
    if (MoveFileExW(utf8ToWide(tmpPath).c_str(), utf8ToWide(dstPath).c_str(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_COPY_ALLOWED))
        return true;
    std::cerr << "[ProxyTranscoder] atomicReplace failed (err="
              << GetLastError() << "): " << tmpPath << " -> " << dstPath << "\n";
    return false;
#else
    std::error_code ec;
    fs::rename(utf8ToPath(tmpPath), utf8ToPath(dstPath), ec);
    return !ec;
#endif
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  CLI → in-process migration                                               ║
// ║                                                                          ║
// ║  Poster/proxy generation used to spawn the `ffmpeg` CLI. Packaged builds  ║
// ║  ship only the libav* runtime DLLs (not ffmpeg.exe), so every CLI job     ║
// ║  exited non-zero and silently produced nothing. Everything below now      ║
// ║  decodes/encodes with the *linked* libavformat/libavcodec/libswscale —    ║
// ║  the same libraries RenderVideoDecoder and FFmpegMuxer already use — so    ║
// ║  generation works with zero external binaries. No subprocess anywhere.    ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ── tiny libav helpers ───────────────────────────────────────────────────────

static void logAvErr(const char* msg, int rc)
{
    char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
    av_strerror(rc, buf, sizeof(buf));
    std::cerr << "[ProxyTranscoder] " << msg
              << " (av_err=" << rc << " '" << buf << "')\n";
}

// Force an even, >=2 dimension (yuv420p/yuv422p require even width & height).
static int evenClamp(int v) { v &= ~1; return v < 2 ? 2 : v; }

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Why generation needs D3D11VA (the AV1-software-decode problem)            ║
// ║                                                                           ║
// ║  The vendored FFmpeg (8.1) is built --disable-libdav1d --disable-libaom,   ║
// ║  so the ONLY AV1 decoder it has is the native "av1" decoder. That decoder  ║
// ║  is a *hwaccel bitstream front-end* — it parses AV1 and hands the actual   ║
// ║  decode to a hardware accelerator (D3D11VA here). With NO hwaccel attached  ║
// ║  it emits ZERO frames. That is exactly why live preview (RenderVideoDecoder ║
// ║  attaches D3D11VA) shows the 4K AV1 grid source fine, while the earlier     ║
// ║  software-only generation path produced "0 frames"/"no decodable frame".   ║
// ║                                                                           ║
// ║  Fix: generation now attaches a D3D11VA hardware decoder too (a fresh,     ║
// ║  thread-isolated device via av_hwdevice_ctx_create), decodes on the GPU,    ║
// ║  then downloads each frame to system memory (av_hwframe_transfer_data) so   ║
// ║  sws_scale + the JPEG/DNxHR encoder can run on the CPU. Codecs that already ║
// ║  software-decode (H.264/HEVC/etc.) skip hwaccel. If the GPU path fails we   ║
// ║  fall back to software and, if THAT also yields nothing, fail non-fatally   ║
// ║  (live decode still works). The proper long-term fix is rebuilding FFmpeg   ║
// ║  with --enable-libdav1d; this keeps generation working with zero rebuild.   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// Serialize the heavy decode/encode across the 2 ProxyManager workers. This
// machine has a tiny integrated GPU (≈486 MB VRAM) already hosting the render
// device; running two extra 4K D3D11VA decode devices at once risks VRAM
// exhaustion. Preview artifacts are not latency-critical, so one-at-a-time
// generation trades a little throughput for stability. (Audio/video threads are
// never touched — this only gates the background worker pool.)
static std::mutex g_genMutex;

// FFmpeg get_format callback — choose D3D11 hw frames when offered (mirrors
// RenderVideoDecoder). Returning AV_PIX_FMT_D3D11 commits the decoder to the
// D3D11VA path; otherwise we fall through to the codec's software format.
static enum AVPixelFormat genGetHwFormat(AVCodecContext* /*c*/, const enum AVPixelFormat* fmts)
{
    for (const AVPixelFormat* p = fmts; *p != AV_PIX_FMT_NONE; ++p)
        if (*p == AV_PIX_FMT_D3D11) return AV_PIX_FMT_D3D11;
    return fmts[0];
}

// ── source open (D3D11VA hwaccel where required, software otherwise) ──────────
// Generation runs on a background worker pool. We open a SOFTWARE decoder for
// codecs that decode in software, and attach a D3D11VA hardware decoder for AV1
// (which cannot software-decode in this FFmpeg build — see the box above).
struct SrcCtx {
    AVFormatContext* fmt        = nullptr;
    AVCodecContext*  dec        = nullptr;
    AVBufferRef*     hwDeviceCtx = nullptr;   // owned D3D11VA device (if hwaccel)
    AVFrame*         cpuFrame   = nullptr;     // scratch for hw→sysmem download
    int              streamIdx  = -1;
    int              width      = 0;
    int              height     = 0;
    bool             isHwAccel  = false;
    AVRational       frameRate  = {30, 1};

    void close() {
        if (cpuFrame)    av_frame_free(&cpuFrame);
        if (dec)         avcodec_free_context(&dec);
        if (hwDeviceCtx) av_buffer_unref(&hwDeviceCtx);
        if (fmt)         avformat_close_input(&fmt);
        streamIdx = -1;
        isHwAccel = false;
    }
};

static bool openVideoSource(const std::string& path, SrcCtx& s)
{
    int rc = avformat_open_input(&s.fmt, path.c_str(), nullptr, nullptr);
    if (rc < 0) { logAvErr("avformat_open_input failed", rc); return false; }

    rc = avformat_find_stream_info(s.fmt, nullptr);
    if (rc < 0) { logAvErr("avformat_find_stream_info failed", rc); s.close(); return false; }

    const AVCodec* codec = nullptr;
    s.streamIdx = av_find_best_stream(s.fmt, AVMEDIA_TYPE_VIDEO, -1, -1, &codec, 0);
    if (s.streamIdx < 0 || !codec) {
        std::cerr << "[ProxyTranscoder] No video stream in: " << path << "\n";
        s.close();
        return false;
    }

    AVStream* st = s.fmt->streams[s.streamIdx];

    // Decide whether we MUST use a hardware decoder. The native "av1" decoder in
    // this build needs a hwaccel to emit frames; H.264/HEVC/VP9/etc. all have
    // working software decoders, so we keep those on the CPU (no GPU contention).
    const bool needHw = (codec->id == AV_CODEC_ID_AV1);

    s.dec = avcodec_alloc_context3(codec);
    if (!s.dec) { s.close(); return false; }

    rc = avcodec_parameters_to_context(s.dec, st->codecpar);
    if (rc < 0) { logAvErr("avcodec_parameters_to_context failed", rc); s.close(); return false; }

    s.dec->thread_count = 0;   // 0 = auto (software decode multi-threads)

    if (needHw) {
        // Create a fresh, thread-isolated D3D11VA device (FFmpeg makes its own
        // ID3D11Device). Not shared with the render device — avoids cross-thread
        // D3D11 contention; serialized by g_genMutex so only one is alive.
        rc = av_hwdevice_ctx_create(&s.hwDeviceCtx, AV_HWDEVICE_TYPE_D3D11VA,
                                    nullptr, nullptr, 0);
        if (rc < 0) {
            logAvErr("av_hwdevice_ctx_create (D3D11VA) failed", rc);
            std::cerr << "[ProxyTranscoder] AV1 source but D3D11VA unavailable — "
                         "cannot software-decode AV1 in this FFmpeg build; will fail "
                         "non-fatally and preview falls back to live decode.\n";
            // Continue without hwaccel; decode will produce 0 frames and we bail.
        } else {
            s.dec->hw_device_ctx = av_buffer_ref(s.hwDeviceCtx);
            s.dec->get_format     = genGetHwFormat;
            s.isHwAccel           = true;
        }
    }

    rc = avcodec_open2(s.dec, codec, nullptr);
    if (rc < 0) { logAvErr("avcodec_open2 (decoder) failed", rc); s.close(); return false; }

    s.width  = s.dec->width;
    s.height = s.dec->height;
    AVRational fr = (st->avg_frame_rate.num > 0 && st->avg_frame_rate.den > 0)
                        ? st->avg_frame_rate
                        : st->r_frame_rate;
    if (fr.num <= 0 || fr.den <= 0) fr = AVRational{30, 1};
    s.frameRate = fr;

    std::cout << "[ProxyTranscoder] Opened '" << path << "': "
              << s.width << "x" << s.height << " @ " << av_q2d(fr)
              << " fps codec=" << codec->name
              << " decode=" << (s.isHwAccel ? "D3D11VA" : "software") << "\n";
    return true;
}

// Map a decoded frame to a CPU-accessible frame. D3D11VA frames live in GPU
// memory (AV_PIX_FMT_D3D11) and must be downloaded with av_hwframe_transfer_data
// before sws_scale can touch them; software frames pass through unchanged. The
// returned pointer is owned by SrcCtx (valid until the next call) — do not free.
static AVFrame* mapToCpu(SrcCtx& s, AVFrame* in)
{
    if (!in) return nullptr;
    if (in->format != AV_PIX_FMT_D3D11) return in;   // already in system memory

    if (!s.cpuFrame) s.cpuFrame = av_frame_alloc();
    if (!s.cpuFrame) return nullptr;
    av_frame_unref(s.cpuFrame);

    int rc = av_hwframe_transfer_data(s.cpuFrame, in, 0);
    if (rc < 0) { logAvErr("av_hwframe_transfer_data (GPU→sysmem) failed", rc); return nullptr; }
    // Carry timestamps across so range trimming/PTS logic keeps working.
    s.cpuFrame->pts                  = in->pts;
    s.cpuFrame->best_effort_timestamp = in->best_effort_timestamp;
    return s.cpuFrame;
}

// Decode the first available frame at/after a seek to `seekSec` and return a
// CPU-accessible frame (hw frames are downloaded). The returned frame is owned
// by SrcCtx scratch storage; valid until the next decode on this SrcCtx.
static AVFrame* decodeFrameAt(SrcCtx& s, double seekSec, AVFrame* outFrame)
{
    AVStream* ist = s.fmt->streams[s.streamIdx];

    if (seekSec > 0.0) {
        int64_t ts = av_rescale_q(static_cast<int64_t>(seekSec * AV_TIME_BASE),
                                  AV_TIME_BASE_Q, ist->time_base);
        if (av_seek_frame(s.fmt, s.streamIdx, ts, AVSEEK_FLAG_BACKWARD) >= 0)
            avcodec_flush_buffers(s.dec);
    }

    AVPacket* pkt = av_packet_alloc();
    if (!pkt) return nullptr;

    AVFrame* result  = nullptr;
    int      guard   = 0;
    bool     flushed = false;
    while (!result && guard++ < 100000) {
        int rr = av_read_frame(s.fmt, pkt);
        if (rr < 0) {
            if (flushed) break;             // already draining and nothing left
            avcodec_send_packet(s.dec, nullptr);  // enter drain mode
            flushed = true;
        } else if (pkt->stream_index != s.streamIdx) {
            av_packet_unref(pkt);
            continue;
        } else {
            avcodec_send_packet(s.dec, pkt);
            av_packet_unref(pkt);
        }

        int gr = avcodec_receive_frame(s.dec, outFrame);
        if (gr == 0)               { result = mapToCpu(s, outFrame); break; }
        if (gr == AVERROR_EOF)     break;
        // AVERROR(EAGAIN) → need more packets; loop continues.
    }

    av_packet_free(&pkt);
    return result;
}

// ── decode smoke test (replaces the old name-only AV1 probe) ──────────────────
// The old probe only checked that an AV1 decoder *exists by name* — which lied,
// because the native "av1" decoder exists but can't software-decode. This does
// the honest thing: actually open the source and decode ONE real frame, logging
// SUCCESS (with the decode path) or FAILURE. Cached per source path so it runs
// once and gates wasteful regeneration attempts on a source we can't decode.
static bool smokeTestDecode(const std::string& path)
{
    static std::mutex                            mtx;
    static std::unordered_map<std::string, bool> cache;
    {
        std::lock_guard<std::mutex> lk(mtx);
        auto it = cache.find(path);
        if (it != cache.end()) return it->second;
    }

    bool ok = false;
    SrcCtx s;
    if (openVideoSource(path, s)) {
        AVFrame* f = av_frame_alloc();
        if (f) {
            AVFrame* got = decodeFrameAt(s, 0.0, f);
            ok = (got != nullptr && got->width > 0 && got->height > 0);
            if (ok)
                std::cout << "[ProxyTranscoder] Decode smoke '" << path << "': SUCCESS ("
                          << (s.isHwAccel ? "D3D11VA" : "software") << ", "
                          << got->width << "x" << got->height << ")\n";
            else
                std::cerr << "[ProxyTranscoder] Decode smoke '" << path << "': FAILED — "
                             "no decodable frame (AV1 with no D3D11VA and no libdav1d?). "
                             "Generation will be skipped; preview uses live decode.\n";
            av_frame_free(&f);
        }
        s.close();
    }

    std::lock_guard<std::mutex> lk(mtx);
    cache[path] = ok;
    return ok;
}

// ── ffmpegAvailable (SECONDARY diagnostic only) ───────────────────────────────
// No longer gates generation. Kept purely so a diagnostic capture can still note
// whether the legacy CLI happens to be on PATH. Probed once and cached.
bool ProxyTranscoder::ffmpegAvailable()
{
    static const bool available = [] {
        std::string cmd = "ffmpeg -version >";
#if defined(_WIN32) || defined(_WIN64)
        cmd += " NUL 2>&1";
#else
        cmd += " /dev/null 2>&1";
#endif
        const bool ok = (std::system(cmd.c_str()) == 0);
        std::cout << "[ProxyTranscoder] (diag) ffmpeg CLI on PATH: "
                  << (ok ? "yes" : "no")
                  << " — generation is in-process and does NOT depend on this.\n";
        return ok;
    }();
    return available;
}

// ── source bit-depth probe (cached) ───────────────────────────────────────────
// Opens the container + reads the video stream's coded params (no decode) to get
// bits-per-luma-component. Cached per path so the render plan can call it once per
// source cheaply. Returns 8 on any failure (safe: 8-bit proxy is always valid).
int ProxyTranscoder::probeSourceBitDepth(const std::string& sourcePath)
{
    static std::mutex                           mtx;
    static std::unordered_map<std::string, int> cache;
    {
        std::lock_guard<std::mutex> lk(mtx);
        auto it = cache.find(sourcePath);
        if (it != cache.end()) return it->second;
    }

    int bits = 8;
    AVFormatContext* fmt = nullptr;
    if (avformat_open_input(&fmt, sourcePath.c_str(), nullptr, nullptr) >= 0) {
        if (avformat_find_stream_info(fmt, nullptr) >= 0) {
            int vi = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
            if (vi >= 0) {
                AVCodecParameters* cp = fmt->streams[vi]->codecpar;
                if (cp->bits_per_raw_sample > 0) {
                    bits = cp->bits_per_raw_sample;
                } else {
                    // Fall back to the pixel-format descriptor's component depth.
                    const AVPixFmtDescriptor* d =
                        av_pix_fmt_desc_get(static_cast<AVPixelFormat>(cp->format));
                    if (d && d->nb_components > 0 && d->comp[0].depth > 0)
                        bits = d->comp[0].depth;
                }
            }
        }
        avformat_close_input(&fmt);
    }
    if (bits <= 0) bits = 8;

    std::lock_guard<std::mutex> lk(mtx);
    cache[sourcePath] = bits;
    return bits;
}

// ── path helpers (unchanged) ──────────────────────────────────────────────────

std::string ProxyTranscoder::getProxyPath(const std::string& sourcePath,
                                          const std::string& outputDir)
{
    fs::path src(sourcePath);
    fs::path out(outputDir);
    std::string stem = src.stem().string();
    return (out / (stem + ".dnxhr.mov")).string();
}

std::string ProxyTranscoder::getSourcePreviewProxyPath(const std::string& sourcePath,
                                                       const std::string& outputDir,
                                                       int proxyHeight,
                                                       bool highBitDepth)
{
    fs::path src(sourcePath);
    fs::path out(outputDir);
    std::string stem = src.stem().string();
    // Height-keyed so a 720p and a 480p proxy never collide; the "10" suffix keeps
    // a 10-bit render proxy distinct from an 8-bit preview proxy of the same height.
    const std::string depthTag = highBitDepth ? "p10" : "p";
    return (out / (stem + ".preview." + std::to_string(proxyHeight) + depthTag + ".mov")).string();
}

bool ProxyTranscoder::sourcePreviewProxyExists(const std::string& sourcePath,
                                               const std::string& outputDir,
                                               int proxyHeight,
                                               bool highBitDepth)
{
    std::string proxy = getSourcePreviewProxyPath(sourcePath, outputDir, proxyHeight, highBitDepth);
    std::error_code ec;
    if (!fs::exists(utf8ToPath(proxy), ec)) return false;

    auto srcTime   = fs::last_write_time(utf8ToPath(sourcePath), ec);
    if (ec) return true;   // can't stat source — assume the existing proxy is fine
    auto proxyTime = fs::last_write_time(utf8ToPath(proxy), ec);
    if (ec) return false;
    return proxyTime >= srcTime;
}

std::string ProxyTranscoder::getPosterPath(const std::string& sourcePath,
                                           const std::string& outputDir)
{
    fs::path src(sourcePath);
    fs::path out(outputDir);
    std::string stem = src.stem().string();
    return (out / (stem + ".xlposter.jpg")).string();
}

std::string ProxyTranscoder::getThumbnailPath(const std::string& sourcePath,
                                              const std::string& outputDir,
                                              int bucket)
{
    fs::path src(sourcePath);
    fs::path out(outputDir);
    std::string stem = src.stem().string();
    return (out / (stem + ".t" + std::to_string(bucket) + ".xlposter.jpg")).string();
}

bool ProxyTranscoder::posterExists(const std::string& sourcePath,
                                   const std::string& outputDir)
{
    std::string poster = getPosterPath(sourcePath, outputDir);
    std::error_code ec;
    if (!fs::exists(utf8ToPath(poster), ec)) return false;

    // Poster must be newer than source (a re-imported/edited source invalidates it)
    auto srcTime = fs::last_write_time(utf8ToPath(sourcePath), ec);
    if (ec) return true;   // can't stat source — assume the existing poster is fine
    auto posterTime = fs::last_write_time(utf8ToPath(poster), ec);
    if (ec) return false;
    return posterTime >= srcTime;
}

bool ProxyTranscoder::proxyExists(const std::string& sourcePath,
                                  const std::string& outputDir)
{
    std::string proxy = getProxyPath(sourcePath, outputDir);
    std::error_code ec;
    if (!fs::exists(utf8ToPath(proxy), ec)) return false;

    auto srcTime   = fs::last_write_time(utf8ToPath(sourcePath), ec);
    if (ec) return true;
    auto proxyTime = fs::last_write_time(utf8ToPath(proxy), ec);
    if (ec) return false;
    return proxyTime >= srcTime;
}

// ── extractPoster (in-process, single JPEG) ───────────────────────────────────
// Open source → seek to ~10% (skip black intro) → decode ONE frame → sws_scale to
// the MJPEG encoder's pixel format at <=640px wide → encode a single JPEG packet
// → write the packet bytes straight to disk (a raw MJPEG packet IS a complete
// JPEG file). No muxer, no subprocess, no extra image library.
bool ProxyTranscoder::extractPoster(const std::string& inputPath,
                                    const std::string& outputPath,
                                    double atTimeSec)
{
    std::error_code ec;
    if (!fs::exists(utf8ToPath(inputPath), ec)) {
        std::cerr << "[ProxyTranscoder] Poster source not found: " << inputPath << "\n";
        return false;
    }

    // One-at-a-time generation (tiny shared GPU) — see g_genMutex.
    std::lock_guard<std::mutex> genLock(g_genMutex);

    // Honest decode capability check (one real frame, cached). If this source
    // can't be decoded for generation, bail now rather than truncating anything.
    if (!smokeTestDecode(inputPath)) {
        std::cerr << "[ProxyTranscoder] Poster skipped: source not decodable for "
                     "generation — preview falls back to live decode.\n";
        return false;
    }

    try {
        fs::path out = utf8ToPath(outputPath);
        if (out.has_parent_path()) fs::create_directories(out.parent_path());
    } catch (const std::exception& e) {
        std::cerr << "[ProxyTranscoder] Poster create_directories failed: " << e.what() << "\n";
        return false;
    }

    const AVCodec* enc = avcodec_find_encoder(AV_CODEC_ID_MJPEG);
    if (!enc) {
        std::cerr << "[ProxyTranscoder] Poster FAILED: MJPEG encoder not compiled "
                     "into linked FFmpeg — cannot write JPEG poster.\n";
        return false;
    }

    SrcCtx s;
    if (!openVideoSource(inputPath, s)) {
        std::cerr << "[ProxyTranscoder] Poster FAILED: could not open source for decode "
                     "(see above) — preview falls back to live decode.\n";
        return false;
    }

    // Atomic write: build the JPEG in a temp file and only swap it onto the real
    // poster path on success, so a failed regen never destroys a valid poster.
    const std::string tmpPath = outputPath + ".tmp";

    // Seek target: an explicit per-cell time when given (atTimeSec >= 0), else
    // the base-poster heuristic (~10% in, clamped a touch before the end).
    double durSec  = (s.fmt->duration > 0) ? s.fmt->duration / static_cast<double>(AV_TIME_BASE) : 0.0;
    double seekSec;
    if (atTimeSec >= 0.0) {
        seekSec = (durSec > 0.5) ? std::min(atTimeSec, durSec - 0.5) : atTimeSec;
    } else {
        seekSec = (durSec > 1.0) ? std::min(durSec * 0.10, durSec - 0.5) : 0.0;
    }
    if (seekSec < 0.0) seekSec = 0.0;

    bool ok = false;
    AVFrame*        decFrame = av_frame_alloc();   // raw decode target (maybe GPU)
    AVFrame*        cpuFrame = nullptr;            // CPU-accessible (owned by SrcCtx)
    AVFrame*        jpgFrame = nullptr;
    AVCodecContext* ec2      = nullptr;
    SwsContext*     sws      = nullptr;
    AVPacket*       pkt      = av_packet_alloc();

    if (!decFrame || !pkt) goto done;

    cpuFrame = decodeFrameAt(s, seekSec, decFrame);
    if (!cpuFrame) {
        std::cerr << "[ProxyTranscoder] Poster FAILED: no decodable frame in " << inputPath << "\n";
        goto done;
    }

    {
        // Target size: <=640 wide, even, aspect-preserving even height.
        int srcW = cpuFrame->width  > 0 ? cpuFrame->width  : s.width;
        int srcH = cpuFrame->height > 0 ? cpuFrame->height : s.height;
        if (srcW <= 0 || srcH <= 0) { std::cerr << "[ProxyTranscoder] Poster: bad frame size\n"; goto done; }
        int pw = std::min(640, srcW);
        int ph = static_cast<int>(std::lround(static_cast<double>(pw) * srcH / srcW));
        pw = evenClamp(pw);
        ph = evenClamp(ph);

        // MJPEG wants yuvj420p (full-range JPEG). Verify, else take the encoder's
        // first supported format.
        AVPixelFormat dstFmt = AV_PIX_FMT_YUVJ420P;
        {
            const AVPixelFormat* fmts = nullptr; int nf = 0;
            if (avcodec_get_supported_config(nullptr, enc, AV_CODEC_CONFIG_PIX_FORMAT, 0,
                    reinterpret_cast<const void**>(&fmts), &nf) >= 0 && fmts && nf > 0) {
                bool found = false;
                for (int i = 0; i < nf && fmts[i] != AV_PIX_FMT_NONE; ++i)
                    if (fmts[i] == dstFmt) { found = true; break; }
                if (!found) dstFmt = fmts[0];
            }
        }

        ec2 = avcodec_alloc_context3(enc);
        if (!ec2) goto done;
        ec2->width     = pw;
        ec2->height    = ph;
        ec2->pix_fmt   = dstFmt;
        ec2->time_base = AVRational{1, 25};
        // Constant-quality JPEG ~ old `-q:v 3` (FF_QP2LAMBDA scales qscale→lambda).
        ec2->flags         |= AV_CODEC_FLAG_QSCALE;
        ec2->global_quality = FF_QP2LAMBDA * 3;

        int rc = avcodec_open2(ec2, enc, nullptr);
        if (rc < 0) { logAvErr("Poster avcodec_open2 (mjpeg) failed", rc); goto done; }

        sws = sws_getContext(srcW, srcH, static_cast<AVPixelFormat>(cpuFrame->format),
                             pw, ph, dstFmt, SWS_BILINEAR, nullptr, nullptr, nullptr);
        if (!sws) { std::cerr << "[ProxyTranscoder] Poster: sws_getContext failed\n"; goto done; }

        jpgFrame = av_frame_alloc();
        if (!jpgFrame) goto done;
        jpgFrame->format = dstFmt;
        jpgFrame->width  = pw;
        jpgFrame->height = ph;
        if (av_frame_get_buffer(jpgFrame, 32) < 0) { std::cerr << "[ProxyTranscoder] Poster: frame buffer alloc failed\n"; goto done; }

        sws_scale(sws, cpuFrame->data, cpuFrame->linesize, 0, srcH,
                  jpgFrame->data, jpgFrame->linesize);
        jpgFrame->pts     = 0;
        jpgFrame->quality = ec2->global_quality;

        rc = avcodec_send_frame(ec2, jpgFrame);
        if (rc >= 0) rc = avcodec_send_frame(ec2, nullptr);   // flush (single image)
        if (rc < 0 && rc != AVERROR_EOF) { logAvErr("Poster avcodec_send_frame failed", rc); goto done; }

        rc = avcodec_receive_packet(ec2, pkt);
        if (rc < 0) { logAvErr("Poster avcodec_receive_packet failed", rc); goto done; }

        // A raw MJPEG packet is a complete JPEG — write it to the TEMP file.
        {
            bool wroteOk = false;
#if defined(_WIN32) || defined(_WIN64)
            FILE* f = _wfopen(utf8ToWide(tmpPath).c_str(), L"wb");
#else
            FILE* f = std::fopen(tmpPath.c_str(), "wb");
#endif
            if (f) {
                size_t wrote = std::fwrite(pkt->data, 1, static_cast<size_t>(pkt->size), f);
                std::fclose(f);
                wroteOk = (wrote == static_cast<size_t>(pkt->size) && pkt->size > 0);
            } else {
                std::cerr << "[ProxyTranscoder] Poster: could not open temp file " << tmpPath << "\n";
            }
            // Only swap onto the real path once the temp JPEG is fully written.
            if (wroteOk) ok = atomicReplace(tmpPath, outputPath);
        }

        if (ok)
            std::cout << "[ProxyTranscoder] Poster done in-process: " << outputPath
                      << " (" << pw << "x" << ph << ", " << pkt->size << " bytes, "
                      << (s.isHwAccel ? "D3D11VA decode" : "software decode") << ")\n";

        av_packet_unref(pkt);
    }

done:
    if (sws)      sws_freeContext(sws);
    if (jpgFrame) av_frame_free(&jpgFrame);
    if (ec2)      avcodec_free_context(&ec2);
    if (decFrame) av_frame_free(&decFrame);
    if (pkt)      av_packet_free(&pkt);
    s.close();

    // Never touch the real poster on failure; just discard the temp.
    if (!ok) { std::error_code rmEc; fs::remove(utf8ToPath(tmpPath), rmEc); }
    return ok;
}

// ── proxy encoder selection (runtime-checked, all-intra) ──────────────────────
// Build the ordered list of all-intra proxy encoders ACTUALLY compiled into this
// build. Preference + rationale:
//   1. DNxHR LB (dnxhd encoder + dnxhr_lb profile) — the canonical edit proxy:
//      every frame is a keyframe (instant scrub seeks), modest bitrate, and
//      RenderVideoDecoder already treats AV_CODEC_ID_DNXHD as intra-only.
//      yuv422p, muxed into a QuickTime (.mov) container.
//   2. MJPEG — always compiled in, also all-intra; larger but a reliable
//      fallback when dnxhd was not built. yuvj420p, qscale-controlled, .mov.
// (FFV1 is another all-intra option but is lossless/large and needs a
// matroska/nut container, so we stop at MJPEG, which always exists.)
struct ProxyEnc {
    const AVCodec* codec   = nullptr;
    AVPixelFormat  pixFmt  = AV_PIX_FMT_YUV422P;
    const char*    profile = nullptr;   // "dnxhr_lb" for dnxhd
    bool           qscale  = false;     // MJPEG quality knob
    const char*    label   = "";
};

// highBitDepth=true builds a 10-bit-preserving ladder FIRST so a 10-bit source
// (common for 4K AV1) keeps 10-bit through a render proxy — preventing banding in
// the encoded output. The 8-bit ladder is appended as a graceful fallback if no
// 10-bit intra encoder is compiled in:
//   1. DNxHR HQX (dnxhd + dnxhr_hqx profile, yuv422p10le) — 10-bit edit proxy.
//   2. ProRes (prores_ks/prores, yuv422p10le) — 10-bit, if compiled.
//   3. …then the 8-bit DNxHR LB / MJPEG ladder below.
static std::vector<ProxyEnc> buildProxyEncoders(bool highBitDepth = false)
{
    std::vector<ProxyEnc> out;
    if (highBitDepth) {
        if (const AVCodec* c = avcodec_find_encoder(AV_CODEC_ID_DNXHD))
            out.push_back({c, AV_PIX_FMT_YUV422P10LE, "dnxhr_hqx", false,
                           "DNxHR HQX 10-bit (dnxhd)"});
        const AVCodec* pr = avcodec_find_encoder_by_name("prores_ks");
        if (!pr) pr = avcodec_find_encoder(AV_CODEC_ID_PRORES);
        if (pr)
            out.push_back({pr, AV_PIX_FMT_YUV422P10LE, nullptr, false,
                           "ProRes 10-bit"});
    }
    if (const AVCodec* c = avcodec_find_encoder(AV_CODEC_ID_DNXHD))
        out.push_back({c, AV_PIX_FMT_YUV422P, "dnxhr_lb", false, "DNxHR LB (dnxhd)"});
    if (const AVCodec* c = avcodec_find_encoder(AV_CODEC_ID_MJPEG))
        out.push_back({c, AV_PIX_FMT_YUVJ420P, nullptr, true, "MJPEG"});
    return out;
}

// ── in-process transcode core (whole file or [startSec,endSec)) ───────────────
// startSec < 0 ⇒ whole file. Always downscales to <=1080p (a 4K proxy would not
// help a weak machine) and re-encodes to an all-intra codec via libav. The
// output container is forced to QuickTime regardless of the file extension — the
// proxy is an internal preview artifact opened by content (avformat probe), so a
// .mxf-named mov decodes fine; this keeps us off MXF's strict DNxHD constraints.
static bool transcodeImpl(const std::string& inputPath,
                          const std::string& outputPath,
                          double startSec, double endSec,
                          int targetW, int targetH,
                          std::function<void(float)> progressCb,
                          int swsFlags = SWS_BILINEAR,
                          bool highBitDepth = false)
{
    std::error_code ec;
    if (!fs::exists(utf8ToPath(inputPath), ec)) {
        std::cerr << "[ProxyTranscoder] Source not found: " << inputPath << "\n";
        return false;
    }

    // One-at-a-time generation (tiny shared GPU) — see g_genMutex.
    std::lock_guard<std::mutex> genLock(g_genMutex);

    // Honest decode capability check (one real frame, cached). If this source
    // can't be decoded for generation, bail before touching the output file.
    if (!smokeTestDecode(inputPath)) {
        std::cerr << "[ProxyTranscoder] Proxy skipped: source not decodable for "
                     "generation — preview falls back to live decode.\n";
        return false;
    }

    try {
        fs::path out = utf8ToPath(outputPath);
        if (out.has_parent_path()) fs::create_directories(out.parent_path());
    } catch (const std::exception& e) {
        std::cerr << "[ProxyTranscoder] create_directories failed: " << e.what() << "\n";
        return false;
    }

    std::vector<ProxyEnc> encoders = buildProxyEncoders(highBitDepth);
    if (encoders.empty()) {
        std::cerr << "[ProxyTranscoder] No all-intra proxy encoder (DNxHD/MJPEG) compiled "
                     "into linked FFmpeg — cannot generate proxy; preview falls back to "
                     "live decode.\n";
        return false;
    }

    SrcCtx s;
    if (!openVideoSource(inputPath, s)) {
        std::cerr << "[ProxyTranscoder] Proxy FAILED: could not open source for decode "
                     "(see above) — preview falls back to live decode.\n";
        return false;
    }

    // ── target size: caller hint (or source), even ───────────────────────────
    // Height-only request (targetW<=0, targetH>0): the requested height IS the
    // final target — a resolution bucket already chosen by the caller (preview
    // ≤720p, or a render footprint bucket up to 2160p). Derive width from the
    // source aspect, NEVER upscale, and do NOT apply the 1080p cap (render buckets
    // legitimately exceed 1080). Both-given (region) and both-zero (legacy
    // whole-file) callers keep the historical <=1080p cap.
    int tw, th;
    if (targetW <= 0 && targetH > 0 && s.height > 0) {
        th = std::min(targetH, s.height);
        tw = static_cast<int>(std::lround(static_cast<double>(s.width) * th / s.height));
        tw = evenClamp(tw);
        th = evenClamp(th);
    } else {
        tw = (targetW > 0) ? targetW : s.width;
        th = (targetH > 0) ? targetH : s.height;
        const int kMaxW = 1920, kMaxH = 1080;
        double scale = 1.0;
        if (tw > kMaxW) scale = std::min(scale, static_cast<double>(kMaxW) / tw);
        if (th > kMaxH) scale = std::min(scale, static_cast<double>(kMaxH) / th);
        tw = evenClamp(static_cast<int>(std::lround(tw * scale)));
        th = evenClamp(static_cast<int>(std::lround(th * scale)));
    }

    AVStream*        ist        = s.fmt->streams[s.streamIdx];
    AVFormatContext* oc         = nullptr;
    AVCodecContext*  enc        = nullptr;
    AVStream*        ostream    = nullptr;
    SwsContext*      sws        = nullptr;
    AVFrame*         decFrame   = av_frame_alloc();
    AVFrame*         encFrame   = nullptr;
    AVPacket*        pkt        = av_packet_alloc();
    bool             fileOpened = false;
    bool             headerOK   = false;
    bool             ok         = false;
    const ProxyEnc*  picked     = nullptr;

    // Atomic write: mux into a temp file, swap onto the real path only on success
    // so a failed regen never destroys a previously-valid proxy.
    const std::string tmpPath = outputPath + ".tmp";

    if (!decFrame || !pkt) goto cleanup;

    // ── output container (QuickTime, forced) ──────────────────────────────────
    if (avformat_alloc_output_context2(&oc, nullptr, "mov", tmpPath.c_str()) < 0 || !oc) {
        std::cerr << "[ProxyTranscoder] avformat_alloc_output_context2 (mov) failed\n";
        goto cleanup;
    }
    ostream = avformat_new_stream(oc, nullptr);
    if (!ostream) goto cleanup;

    // ── open the first all-intra encoder that accepts this size/rate ──────────
    for (const ProxyEnc& cand : encoders) {
        if (enc) avcodec_free_context(&enc);
        enc = avcodec_alloc_context3(cand.codec);
        if (!enc) continue;

        enc->width     = tw;
        enc->height    = th;
        enc->pix_fmt   = cand.pixFmt;
        enc->time_base = av_inv_q(s.frameRate);
        enc->framerate = s.frameRate;
        // Set the all-intra profile (e.g. dnxhr_lb). AV_OPT_SEARCH_CHILDREN so it
        // resolves whether "profile" lives on the context or the encoder's
        // priv_data (varies across FFmpeg versions for the dnxhd encoder).
        if (cand.profile)
            av_opt_set(enc, "profile", cand.profile, AV_OPT_SEARCH_CHILDREN);
        if (cand.qscale) {
            enc->flags         |= AV_CODEC_FLAG_QSCALE;
            enc->global_quality = FF_QP2LAMBDA * 4;   // light, fast preview JPEG
        }
        if (oc->oformat->flags & AVFMT_GLOBALHEADER)
            enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

        int rc = avcodec_open2(enc, cand.codec, nullptr);
        if (rc == 0) {
            picked = &cand;
            std::cout << "[ProxyTranscoder] Proxy encoder: " << cand.label
                      << " @ " << tw << "x" << th
                      << " (" << av_get_pix_fmt_name(cand.pixFmt) << ")\n";
            break;
        }
        char eb[AV_ERROR_MAX_STRING_SIZE] = {0};
        av_strerror(rc, eb, sizeof(eb));
        std::cerr << "[ProxyTranscoder] Encoder '" << cand.label << "' rejected "
                  << tw << "x" << th << ": " << eb << " — trying next\n";
    }
    if (!picked || !enc) {
        std::cerr << "[ProxyTranscoder] Proxy FAILED: no all-intra encoder accepted the "
                     "target size — preview falls back to live decode.\n";
        goto cleanup;
    }

    if (avcodec_parameters_from_context(ostream->codecpar, enc) < 0) goto cleanup;
    ostream->time_base = enc->time_base;

    if (!(oc->oformat->flags & AVFMT_NOFILE)) {
        if (avio_open(&oc->pb, tmpPath.c_str(), AVIO_FLAG_WRITE) < 0) {
            std::cerr << "[ProxyTranscoder] avio_open failed: " << tmpPath << "\n";
            goto cleanup;
        }
        fileOpened = true;
    }
    if (avformat_write_header(oc, nullptr) < 0) {
        std::cerr << "[ProxyTranscoder] avformat_write_header failed\n";
        goto cleanup;
    }
    headerOK = true;

    encFrame = av_frame_alloc();
    if (!encFrame) goto cleanup;
    encFrame->format = enc->pix_fmt;
    encFrame->width  = tw;
    encFrame->height = th;
    if (av_frame_get_buffer(encFrame, 32) < 0) goto cleanup;

    // ── decode → scale → encode the requested range ───────────────────────────
    {
        if (startSec > 0.0) {
            int64_t seekTs = av_rescale_q(static_cast<int64_t>(startSec * AV_TIME_BASE),
                                          AV_TIME_BASE_Q, ist->time_base);
            if (av_seek_frame(s.fmt, s.streamIdx, seekTs, AVSEEK_FLAG_BACKWARD) >= 0)
                avcodec_flush_buffers(s.dec);
        }

        // Progress denominator: explicit range, else whole-file duration.
        double spanSec = 0.0;
        if (endSec >= 0.0 && startSec >= 0.0) spanSec = endSec - startSec;
        else if (s.fmt->duration > 0)         spanSec = s.fmt->duration / static_cast<double>(AV_TIME_BASE);

        auto encodeOne = [&](AVFrame* f) -> bool {
            int rc = avcodec_send_frame(enc, f);
            if (rc < 0 && rc != AVERROR(EAGAIN) && rc != AVERROR_EOF) {
                logAvErr("avcodec_send_frame (proxy) failed", rc);
                return false;
            }
            while (true) {
                rc = avcodec_receive_packet(enc, pkt);
                if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF) return true;
                if (rc < 0) { logAvErr("avcodec_receive_packet (proxy) failed", rc); return false; }
                pkt->stream_index = ostream->index;
                av_packet_rescale_ts(pkt, enc->time_base, ostream->time_base);
                int wr = av_interleaved_write_frame(oc, pkt);
                av_packet_unref(pkt);
                if (wr < 0) { logAvErr("av_interleaved_write_frame failed", wr); return false; }
            }
        };

        const double kEps     = 1e-6;
        int64_t      outIdx    = 0;
        bool         done      = false;
        bool         flushed   = false;
        bool         encodeErr = false;

        while (!done) {
            int rr = av_read_frame(s.fmt, pkt);
            if (rr < 0) {
                if (!flushed) { avcodec_send_packet(s.dec, nullptr); flushed = true; }
            } else if (pkt->stream_index != s.streamIdx) {
                av_packet_unref(pkt);
                continue;
            } else {
                avcodec_send_packet(s.dec, pkt);
                av_packet_unref(pkt);
            }

            while (true) {
                int gr = avcodec_receive_frame(s.dec, decFrame);
                if (gr == AVERROR(EAGAIN)) break;
                if (gr == AVERROR_EOF) { done = true; break; }
                if (gr < 0) { logAvErr("avcodec_receive_frame (proxy) failed", gr); done = true; break; }

                int64_t tsRaw = (decFrame->best_effort_timestamp != AV_NOPTS_VALUE)
                                    ? decFrame->best_effort_timestamp
                                    : decFrame->pts;
                double tSec = (tsRaw != AV_NOPTS_VALUE) ? tsRaw * av_q2d(ist->time_base) : 0.0;

                // Cheap range trim BEFORE the (expensive) GPU→sysmem download.
                if (startSec >= 0.0 && tSec < startSec - kEps) { av_frame_unref(decFrame); continue; }
                if (endSec   >= 0.0 && tSec >= endSec - kEps)  { av_frame_unref(decFrame); done = true; break; }

                // Download to system memory if this is a D3D11VA hw frame.
                AVFrame* cpu = mapToCpu(s, decFrame);
                if (!cpu) { av_frame_unref(decFrame); done = true; encodeErr = true; break; }

                if (!sws) {
                    sws = sws_getContext(cpu->width, cpu->height,
                                         static_cast<AVPixelFormat>(cpu->format),
                                         tw, th, enc->pix_fmt,
                                         swsFlags, nullptr, nullptr, nullptr);
                    if (!sws) { std::cerr << "[ProxyTranscoder] proxy sws_getContext failed\n";
                                av_frame_unref(decFrame); done = true; encodeErr = true; break; }
                }

                if (av_frame_make_writable(encFrame) < 0) { av_frame_unref(decFrame); done = true; encodeErr = true; break; }
                sws_scale(sws, cpu->data, cpu->linesize, 0, cpu->height,
                          encFrame->data, encFrame->linesize);
                encFrame->pts = outIdx++;
                if (picked->qscale) encFrame->quality = enc->global_quality;

                if (!encodeOne(encFrame)) { av_frame_unref(decFrame); done = true; encodeErr = true; break; }

                if (progressCb && spanSec > 0.0) {
                    double base = (startSec >= 0.0) ? startSec : 0.0;
                    float  p    = static_cast<float>(std::clamp((tSec - base) / spanSec, 0.0, 1.0));
                    progressCb(p);
                }
                av_frame_unref(decFrame);
            }

            if (rr < 0 && flushed) break;   // drained the decoder at EOF
        }

        if (encodeErr) goto cleanup;
        encodeOne(nullptr);                 // flush the encoder
        if (progressCb) progressCb(1.0f);
        ok = (outIdx > 0);
        if (!ok)
            std::cerr << "[ProxyTranscoder] Proxy produced 0 frames for range — failing\n";
    }

cleanup:
    if (headerOK && oc) av_write_trailer(oc);
    if (sws)      sws_freeContext(sws);
    if (encFrame) av_frame_free(&encFrame);
    if (decFrame) av_frame_free(&decFrame);
    if (pkt)      av_packet_free(&pkt);
    if (enc)      avcodec_free_context(&enc);
    if (oc) {
        if (fileOpened && oc->pb) avio_closep(&oc->pb);   // must close before rename
        avformat_free_context(oc);
    }
    s.close();

    // Swap the completed temp file onto the real path only on success; otherwise
    // discard the temp and leave any existing valid proxy untouched.
    if (ok) {
        if (!atomicReplace(tmpPath, outputPath)) ok = false;
    }
    if (!ok) { std::error_code rmEc; fs::remove(utf8ToPath(tmpPath), rmEc); }
    return ok;
}

// ── transcode (whole file) ────────────────────────────────────────────────────

std::string ProxyTranscoder::transcode(
    const std::string& inputPath,
    const std::string& outputDir,
    std::function<void(float progress)> progressCallback)
{
    std::error_code ec;
    if (!fs::exists(utf8ToPath(inputPath), ec)) {
        std::cerr << "[ProxyTranscoder] Source not found: " << inputPath << "\n";
        return {};
    }
    fs::create_directories(utf8ToPath(outputDir), ec);

    std::string outputPath = getProxyPath(inputPath, outputDir);

    std::cout << "[ProxyTranscoder] Whole-file proxy (in-process)\n"
              << "[ProxyTranscoder] Input : " << inputPath  << "\n"
              << "[ProxyTranscoder] Output: " << outputPath << "\n";

    auto t0 = std::chrono::high_resolution_clock::now();
    if (progressCallback) progressCallback(0.0f);

    // startSec=-1, endSec=-1 ⇒ whole file; targetW/H=0 ⇒ source size capped to 1080p.
    bool ok = transcodeImpl(inputPath, outputPath, -1.0, -1.0, 0, 0, progressCallback);
    if (!ok) return {};

    auto t1 = std::chrono::high_resolution_clock::now();
    double elapsed = std::chrono::duration<double>(t1 - t0).count();
    double srcMB   = static_cast<double>(fs::file_size(utf8ToPath(inputPath),  ec)) / (1024.0 * 1024.0);
    double proxyMB = static_cast<double>(fs::file_size(utf8ToPath(outputPath), ec)) / (1024.0 * 1024.0);
    std::printf("[ProxyTranscoder] Whole-file proxy done in %.1f s — source %.1f MB, proxy %.1f MB\n",
                elapsed, srcMB, proxyMB);
    return outputPath;
}

// ── transcodeRange ────────────────────────────────────────────────────────────

bool ProxyTranscoder::transcodeRange(
    const std::string& inputPath,
    const std::string& outputPath,
    double             startTimeSec,
    double             endTimeSec,
    int                targetWidth,
    int                targetHeight,
    std::function<void(float progress)> progressCallback)
{
    std::error_code ec;
    if (!fs::exists(utf8ToPath(inputPath), ec)) {
        std::cerr << "[ProxyTranscoder] Source not found: " << inputPath << "\n";
        return false;
    }
    if (endTimeSec <= startTimeSec) {
        std::cerr << "[ProxyTranscoder] Invalid range: start=" << startTimeSec
                  << " end=" << endTimeSec << "\n";
        return false;
    }
    if (targetWidth <= 0 || targetHeight <= 0) {
        std::cerr << "[ProxyTranscoder] Invalid target size: "
                  << targetWidth << "x" << targetHeight << "\n";
        return false;
    }

    double rangeDuration = endTimeSec - startTimeSec;
    std::cout << "[ProxyTranscoder] Range proxy (in-process)\n"
              << "[ProxyTranscoder] Range Input : " << inputPath  << "\n"
              << "[ProxyTranscoder] Range Output: " << outputPath << "\n"
              << "[ProxyTranscoder] Range: [" << startTimeSec << ", " << endTimeSec
              << ") (" << rangeDuration << " s)\n"
              << "[ProxyTranscoder] Requested target (pre-1080p-cap): "
              << targetWidth << "x" << targetHeight << "\n";

    auto t0 = std::chrono::high_resolution_clock::now();
    if (progressCallback) progressCallback(0.0f);

    bool ok = transcodeImpl(inputPath, outputPath,
                            startTimeSec, endTimeSec,
                            targetWidth, targetHeight, progressCallback);
    if (!ok) {
        std::cerr << "[ProxyTranscoder] Range proxy FAILED — region streams from original\n";
        return false;
    }

    auto t1 = std::chrono::high_resolution_clock::now();
    double elapsed = std::chrono::duration<double>(t1 - t0).count();
    double proxyMB = static_cast<double>(fs::file_size(utf8ToPath(outputPath), ec)) / (1024.0 * 1024.0);
    std::printf("[ProxyTranscoder] Range proxy done in %.1f s — %.1f MB\n", elapsed, proxyMB);
    return true;
}

// ── transcodeSourcePreview (whole-source, height-keyed, lanczos) ──────────────

bool ProxyTranscoder::transcodeSourcePreview(
    const std::string& inputPath,
    const std::string& outputPath,
    int                targetHeight,
    bool               highBitDepth,
    std::function<void(float progress)> progressCallback)
{
    std::error_code ec;
    if (!fs::exists(utf8ToPath(inputPath), ec)) {
        std::cerr << "[ProxyTranscoder] Source not found: " << inputPath << "\n";
        return false;
    }
    if (targetHeight <= 0) {
        std::cerr << "[ProxyTranscoder] Invalid preview-proxy target height: "
                  << targetHeight << "\n";
        return false;
    }

    std::cout << "[ProxyTranscoder] Whole-source proxy (in-process)\n"
              << "[ProxyTranscoder] Input : " << inputPath  << "\n"
              << "[ProxyTranscoder] Output: " << outputPath << "\n"
              << "[ProxyTranscoder] Target height: " << targetHeight
              << "p (aspect-preserved, lanczos, "
              << (highBitDepth ? "10-bit" : "8-bit") << ")\n";

    auto t0 = std::chrono::high_resolution_clock::now();
    if (progressCallback) progressCallback(0.0f);

    // startSec=-1, endSec=-1 ⇒ whole file. targetW=0 + targetH>0 ⇒ width derived
    // from the source aspect at targetHeight, no 1080p cap (see transcodeImpl).
    // SWS_LANCZOS for high-quality downscaling (paid once, off-thread).
    bool ok = transcodeImpl(inputPath, outputPath, -1.0, -1.0,
                            /*targetW*/0, /*targetH*/targetHeight,
                            progressCallback, SWS_LANCZOS, highBitDepth);
    if (!ok) {
        std::cerr << "[ProxyTranscoder] Whole-source preview proxy FAILED — preview "
                     "falls back to poster/original\n";
        return false;
    }

    auto t1 = std::chrono::high_resolution_clock::now();
    double elapsed = std::chrono::duration<double>(t1 - t0).count();
    double srcMB   = static_cast<double>(fs::file_size(utf8ToPath(inputPath),  ec)) / (1024.0 * 1024.0);
    double proxyMB = static_cast<double>(fs::file_size(utf8ToPath(outputPath), ec)) / (1024.0 * 1024.0);
    std::printf("[ProxyTranscoder] Whole-source preview proxy done in %.1f s — "
                "source %.1f MB, proxy %.1f MB\n", elapsed, srcMB, proxyMB);
    return true;
}
