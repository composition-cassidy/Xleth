#ifdef _MSC_VER
  #define _CRT_SECURE_NO_WARNINGS
#endif

#include "ProxyTranscoder.h"

#include <algorithm>
#include <atomic>
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
#include <thread>
#include <unordered_map>
#include <unordered_set>

#if defined(_WIN32) || defined(_WIN64)
  #define WIN32_LEAN_AND_MEAN
  #define NOMINMAX
  #include <windows.h>
  #include <objbase.h>   // CoInitializeEx — Media Foundation needs an MTA thread
  #pragma comment(lib, "ole32.lib")
#endif

#include <condition_variable>
#include <deque>
#include <map>

#include "HardwareTier.h"
#include "render/PixelAlpha.h"
#include "render/GpuDeviceManager.h"

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

// libav equivalent of the CLI `-threads` flag: caps decode/encode worker
// threads so proxy generation doesn't oversubscribe against the audio and
// video threads. g_genGate bounds how many generations run at once; this is
// the remaining per-job knob. Historical value clamp(hw/2-1, 1, 4) — see
// HardwareTier.h.
static int proxyThreadCount()
{
    return xleth::hw::proxyDecodeThreads();
}

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

// Bound the heavy decode/encode across the ProxyManager workers. Originally a
// plain mutex (one generation at a time) because the dev machine had a tiny
// integrated GPU (≈486 MB VRAM) already hosting the render device, and two
// extra 4K D3D11VA decode devices at once risked VRAM exhaustion. That stays
// the rule on small machines; HardwareTier allows a second concurrent job from
// 16 logical cores with ≥ 2 GB dedicated VRAM, so posters and region proxies
// are no longer stuck behind one long whole-source encode. (Audio/video threads
// are never touched — this only gates the background worker pool.)
class GenerationGate {
public:
    void acquire() {
        std::unique_lock<std::mutex> lk(m_);
        cv_.wait(lk, [&] { return active_ < capacity(); });
        ++active_;
    }
    void release() {
        { std::lock_guard<std::mutex> lk(m_); --active_; }
        cv_.notify_one();
    }
    static int capacity() {
        static const int slots = [] {
            const int n = xleth::hw::proxyGenerationSlots(
                GpuDeviceManager::queryMaxDedicatedVramBytes());
            std::cout << "[ProxyTranscoder] generation slots: " << n
                      << " (logical cores " << xleth::hw::logicalCores() << ")\n";
            return n;
        }();
        return slots;
    }
private:
    std::mutex              m_;
    std::condition_variable cv_;
    int                     active_ = 0;
};
static GenerationGate g_genGate;

struct GenerationSlot {
    GenerationSlot()  { g_genGate.acquire(); }
    ~GenerationSlot() { g_genGate.release(); }
    GenerationSlot(const GenerationSlot&) = delete;
    GenerationSlot& operator=(const GenerationSlot&) = delete;
};

int ProxyTranscoder::generationSlots() { return GenerationGate::capacity(); }

// Pipeline helper threads (decode + scale workers) run below normal priority:
// proxies are background work and must yield to the video/preview thread and
// the UI. (The audio callback runs under MMCSS and is unaffected either way.)
static void lowerHelperThreadPriority()
{
#if defined(_WIN32) || defined(_WIN64)
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
#endif
}

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

    s.dec->thread_count = proxyThreadCount();   // was 0 (auto/uncapped); now clamp(hw/2-1, 1, 4)

    if (needHw) {
        // Create a fresh, thread-isolated D3D11VA device (FFmpeg makes its own
        // ID3D11Device). Not shared with the render device — avoids cross-thread
        // D3D11 contention; g_genGate bounds how many are alive at once.
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
                                                       bool highBitDepth,
                                                       ProxyCodec codec)
{
    fs::path src(sourcePath);
    fs::path out(outputDir);
    std::string stem = src.stem().string();
    // Height-keyed so a 720p and a 480p proxy never collide; the "10" suffix keeps
    // a 10-bit render proxy distinct from an 8-bit preview proxy of the same height.
    const std::string depthTag = highBitDepth ? "p10" : "p";
    // Codec tag: only 8-bit H.264 gets one. The untagged name is the legacy
    // intra proxy every pre-H.264 project already has on disk, so it keeps its
    // name and meaning; 10-bit proxies are always intra (no 10-bit H.264 here).
    const std::string codecTagStr =
        (codec == ProxyCodec::H264 && !highBitDepth) ? ".h264" : "";
    return (out / (stem + ".preview." + std::to_string(proxyHeight) + depthTag
                   + codecTagStr + ".mov")).string();
}

bool ProxyTranscoder::sourcePreviewProxyExists(const std::string& sourcePath,
                                               const std::string& outputDir,
                                               int proxyHeight,
                                               bool highBitDepth,
                                               ProxyCodec codec)
{
    std::string proxy = getSourcePreviewProxyPath(sourcePath, outputDir, proxyHeight,
                                                  highBitDepth, codec);
    std::error_code ec;
    if (!fs::exists(utf8ToPath(proxy), ec)) return false;

    auto srcTime   = fs::last_write_time(utf8ToPath(sourcePath), ec);
    if (ec) return true;   // can't stat source — assume the existing proxy is fine
    auto proxyTime = fs::last_write_time(utf8ToPath(proxy), ec);
    if (ec) return false;
    return proxyTime >= srcTime;
}

ProxyTranscoder::ProxyLookup ProxyTranscoder::findSourcePreviewProxy(
    const std::string& sourcePath, const std::string& outputDir,
    int proxyHeight, bool highBitDepth)
{
    ProxyLookup out;
    // H.264 first: when both exist the H.264 one is the migration result and
    // the intra one is its superseded predecessor awaiting deletion.
    for (ProxyCodec c : { ProxyCodec::H264, ProxyCodec::Intra }) {
        if (highBitDepth && c == ProxyCodec::H264) continue;   // 10-bit is intra-only
        if (sourcePreviewProxyExists(sourcePath, outputDir, proxyHeight, highBitDepth, c)) {
            out.found = true;
            out.codec = c;
            out.path  = getSourcePreviewProxyPath(sourcePath, outputDir, proxyHeight,
                                                  highBitDepth, c);
            return out;
        }
    }
    return out;
}

std::string ProxyTranscoder::getRegionProxyPath(const std::string& outputDir,
                                                int regionId, ProxyCodec codec)
{
    // ".mxf" is the historical region-proxy name (the payload has always been
    // QuickTime — transcodeImpl forces the mov muxer). Kept for Intra so every
    // existing project's region proxies still resolve.
    const std::string name = std::to_string(regionId)
                           + (codec == ProxyCodec::H264 ? ".h264.mov" : ".mxf");
    return (fs::path(outputDir) / name).string();
}

bool ProxyTranscoder::fileExistsUtf8(const std::string& path)
{
    if (path.empty()) return false;
    std::error_code ec;
    return fs::exists(utf8ToPath(path), ec);
}

bool ProxyTranscoder::removeFileUtf8(const std::string& path)
{
    if (path.empty()) return true;
    std::error_code ec;
    const fs::path p = utf8ToPath(path);
    fs::remove(p, ec);
    std::error_code ec2;
    return !fs::exists(p, ec2);
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

    // Bounded concurrent generation (tiny shared GPU on small machines) — see g_genGate.
    GenerationSlot genSlot;

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
    // A JPEG poster would turn transparent pixels black.
    if (pixFmtMayHaveAlpha(s.fmt->streams[s.streamIdx]->codecpar->format)) {
        std::cout << "[ProxyTranscoder] Poster skipped: source has alpha, preview uses live frames.\n";
        s.close();
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
        ec2->width       = pw;
        ec2->height      = ph;
        ec2->pix_fmt     = dstFmt;
        ec2->time_base   = AVRational{1, 25};
        ec2->thread_count = proxyThreadCount();
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
// How an encoder candidate is tuned once its context is allocated.
enum class EncTuning { Intra, X264, MediaFoundation };

struct ProxyEnc {
    const AVCodec* codec   = nullptr;
    AVPixelFormat  pixFmt  = AV_PIX_FMT_YUV422P;
    const char*    profile = nullptr;   // "dnxhr_lb" for dnxhd
    bool           qscale  = false;     // MJPEG quality knob
    const char*    label   = "";
    EncTuning      tuning  = EncTuning::Intra;
};

// ── H.264 proxy tuning ────────────────────────────────────────────────────────
// GOP length is the seek-cost knob: a random seek decodes up to kH264Gop-1
// frames past the preceding keyframe. 48 frames = 2 s at 24 fps, 0.8 s at 60.
// No B-frames on the MF path (it never emits them in Baseline anyway), so decode
// order == display order and no reorder delay is added to a seek.
static constexpr int  kH264Gop        = 48;
static constexpr int  kX264Crf        = 23;           // libx264 constant-quality
static constexpr char kX264Preset[]   = "veryfast";
// Media Foundation has no CRF; its quality-VBR mode (0..100) is the equivalent.
// Measured on a 60 s 1080p→720p excerpt of a real episode, against the
// source (SSIM, 1.0 = identical):
//     MJPEG q4 (legacy proxy)  111.8 MB  0.9908
//     h264_mf quality 55        10.6 MB  0.9892   ← chosen: 10.6x smaller
//     h264_mf quality 60        12.8 MB  0.9920
//     libx264 CRF 23 veryfast    7.4 MB  0.9941
// 55 lands the ~10x size target at a visually indistinguishable SSIM for a
// preview proxy.
static constexpr int  kMfQuality      = 55;

// Apply the H.264-specific options to an allocated (not yet opened) context.
// Options live in the encoder's priv_data, hence AV_OPT_SEARCH_CHILDREN.
static void tuneH264Encoder(AVCodecContext* enc, EncTuning tuning)
{
    enc->gop_size = kH264Gop;
    if (tuning == EncTuning::X264) {
        av_opt_set    (enc, "preset", kX264Preset, AV_OPT_SEARCH_CHILDREN);
        av_opt_set_int(enc, "crf",    kX264Crf,    AV_OPT_SEARCH_CHILDREN);
    } else if (tuning == EncTuning::MediaFoundation) {
        enc->max_b_frames = 0;
        av_opt_set    (enc, "rate_control", "quality",  AV_OPT_SEARCH_CHILDREN);
        av_opt_set_int(enc, "quality",      kMfQuality, AV_OPT_SEARCH_CHILDREN);
        // Software MFT: identical output on every machine. The hardware MFTs are
        // vendor-specific (and async), and proxy encode is not the bottleneck —
        // this runs ~35x realtime at 720p on the software encoder.
        av_opt_set_int(enc, "hw_encoding",  0,          AV_OPT_SEARCH_CHILDREN);
    }
}

// Ordered H.264 candidates compiled into the linked FFmpeg.
//   1. libx264 — best size/quality; only present if FFmpeg was built with it
//      (the vcpkg build this project ships is --disable-libx264, see
//      vcpkg.json: enabling it means adding the port's "x264" feature, which
//      makes the FFmpeg DLLs GPL).
//   2. h264_mf — Windows Media Foundation encoder, part of every Windows 10/11
//      install that has the Media Feature Pack (absent on "N" editions until
//      the pack is installed).
static std::vector<ProxyEnc> buildH264Encoders()
{
    std::vector<ProxyEnc> out;
    if (const AVCodec* c = avcodec_find_encoder_by_name("libx264"))
        out.push_back({c, AV_PIX_FMT_YUV420P, nullptr, false,
                       "H.264 (libx264, CRF 23, veryfast, GOP 48)", EncTuning::X264});
    if (const AVCodec* c = avcodec_find_encoder_by_name("h264_mf"))
        out.push_back({c, AV_PIX_FMT_NV12, nullptr, false,
                       "H.264 (Media Foundation, quality 55, GOP 48)",
                       EncTuning::MediaFoundation});
    return out;
}

// highBitDepth=true builds a 10-bit-preserving ladder FIRST so a 10-bit source
// (common for 4K AV1) keeps 10-bit through a render proxy — preventing banding in
// the encoded output. The 8-bit ladder is appended as a graceful fallback if no
// 10-bit intra encoder is compiled in:
//   1. DNxHR HQX (dnxhd + dnxhr_hqx profile, yuv422p10le) — 10-bit edit proxy.
//   2. ProRes (prores_ks/prores, yuv422p10le) — 10-bit, if compiled.
//   3. …then the 8-bit DNxHR LB / MJPEG ladder below.
//
// preferMjpeg=true swaps the 8-bit ladder to MJPEG-then-DNxHR-LB. DNxHR is a
// constant-bits-per-frame codec — every frame must fit a fixed budget — and on
// very long, high-motion/high-entropy sources (a 31-minute action-heavy source
// crashed here) a frame can occasionally exceed what dnxhd's rate control
// allocated, overrunning its output buffer and hitting libavcodec's internal
// `put_bits` bounds assertion, which calls abort() and kills the whole engine
// process (not just the background job). MJPEG's bitstream size follows the
// frame's actual entropy instead of a fixed budget, so it doesn't have this
// failure mode. Used for whole-source preview-proxy generation, which is the
// long-running, low-priority path most exposed to this: it re-encodes an
// entire source (tens of thousands of frames) as an unattended background job,
// and a hard crash there isn't memoized, so a bad frame retriggers the same
// crash every time the project reloads.
static std::vector<ProxyEnc> buildProxyEncoders(bool highBitDepth = false, bool preferMjpeg = false)
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
    const AVCodec* dnxhd = avcodec_find_encoder(AV_CODEC_ID_DNXHD);
    const AVCodec* mjpeg = avcodec_find_encoder(AV_CODEC_ID_MJPEG);
    ProxyEnc dnxhrLb{dnxhd, AV_PIX_FMT_YUV422P, "dnxhr_lb", false, "DNxHR LB (dnxhd)"};
    ProxyEnc mjpegEnc{mjpeg, AV_PIX_FMT_YUVJ420P, nullptr, true, "MJPEG"};
    if (preferMjpeg) {
        if (mjpeg) out.push_back(mjpegEnc);
        if (dnxhd) out.push_back(dnxhrLb);
    } else {
        if (dnxhd) out.push_back(dnxhrLb);
        if (mjpeg) out.push_back(mjpegEnc);
    }
    return out;
}

// ── COM apartment for Media Foundation ────────────────────────────────────────
// FFmpeg's h264_mf refuses to open on a thread whose COM apartment is STA
// ("COM must not be in STA mode"). Engine threads differ: the JUCE message /
// N-API thread is STA, pool and render threads usually have no apartment yet.
// runInMta(fn) runs fn on the calling thread after joining the MTA; if that
// thread is already STA (CoInitializeEx → RPC_E_CHANGED_MODE) it runs fn on a
// short-lived helper thread that is MTA, and waits for it. Every successful
// CoInitializeEx is balanced by CoUninitialize.
template <typename Fn>
static auto runInMta(Fn&& fn) -> decltype(fn())
{
#if defined(_WIN32) || defined(_WIN64)
    const HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (hr == RPC_E_CHANGED_MODE) {
        decltype(fn()) result{};
        std::thread helper([&] {
            const HRESULT h2 = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
            result = fn();
            if (SUCCEEDED(h2)) CoUninitialize();
        });
        helper.join();
        return result;
    }
    auto result = fn();
    if (SUCCEEDED(hr)) CoUninitialize();
    return result;
#else
    return fn();
#endif
}

// ── proxy codec preference ────────────────────────────────────────────────────

static std::atomic<int> g_requestedProxyCodec{ static_cast<int>(ProxyCodec::H264) };

void ProxyTranscoder::setPreferredCodec(ProxyCodec codec)
{
    g_requestedProxyCodec.store(static_cast<int>(codec), std::memory_order_relaxed);
    std::cout << "[ProxyTranscoder] Proxy codec setting: " << codecTag(codec)
              << " (effective for new proxies: " << codecTag(preferredCodec()) << ")\n";
}

ProxyCodec ProxyTranscoder::requestedCodec()
{
    return static_cast<ProxyCodec>(g_requestedProxyCodec.load(std::memory_order_relaxed));
}

const char* ProxyTranscoder::codecTag(ProxyCodec codec)
{
    return codec == ProxyCodec::H264 ? "h264" : "intra";
}

// Probed once: can any H.264 candidate actually OPEN at a typical proxy size?
// avcodec_find_encoder alone is not enough for h264_mf — the codec is compiled
// in on every Windows build, but the Media Foundation transform behind it is
// missing on "N" editions without the Media Feature Pack, and only open fails.
bool ProxyTranscoder::h264EncoderAvailable()
{
    static const bool available = runInMta([] {
        for (const ProxyEnc& cand : buildH264Encoders()) {
            AVCodecContext* enc = avcodec_alloc_context3(cand.codec);
            if (!enc) continue;
            enc->width     = 1280;
            enc->height    = 720;
            enc->pix_fmt   = cand.pixFmt;
            enc->time_base = AVRational{1, 24};
            enc->framerate = AVRational{24, 1};
            tuneH264Encoder(enc, cand.tuning);
            const int rc = avcodec_open2(enc, cand.codec, nullptr);
            avcodec_free_context(&enc);
            if (rc == 0) {
                std::cout << "[ProxyTranscoder] H.264 proxy encoder available: "
                          << cand.label << "\n";
                return true;
            }
            logAvErr("H.264 proxy encoder probe failed to open", rc);
        }
        std::cerr << "[ProxyTranscoder] WARNING: no usable H.264 encoder (libx264 not "
                     "compiled in; Media Foundation h264_mf unavailable — Windows N "
                     "without the Media Feature Pack?). New proxies fall back to the "
                     "all-intra codec.\n";
        return false;
    });
    return available;
}

ProxyCodec ProxyTranscoder::preferredCodec()
{
    const ProxyCodec req = requestedCodec();
    if (req == ProxyCodec::H264 && !h264EncoderAvailable()) return ProxyCodec::Intra;
    return req;
}

ProxyCodec ProxyTranscoder::codecForTargetSize(int targetW, int targetH)
{
    if (targetW < 128 || targetH < 72) return ProxyCodec::Intra;
    return preferredCodec();
}

// ── in-process transcode core (whole file or [startSec,endSec)) ───────────────
// startSec < 0 ⇒ whole file. Always downscales to <=1080p (a 4K proxy would not
// help a weak machine) and re-encodes via libav — to `codec` (H.264 or the
// intra ladder; highBitDepth / uncappedNative always use the intra ladder). The
// output container is forced to QuickTime regardless of the file extension — the
// proxy is an internal preview artifact opened by content (avformat probe), so a
// .mxf-named mov decodes fine; this keeps us off MXF's strict DNxHD constraints.
//
// shouldCancel is polled once per decoded frame; a cancelled job fails like any
// other failure (temp deleted, existing output untouched).
static bool transcodeImplBody(const std::string& inputPath,
                              const std::string& outputPath,
                              double startSec, double endSec,
                              int targetW, int targetH,
                              std::function<void(float)> progressCb,
                              int swsFlags,
                              bool highBitDepth,
                              bool uncappedNative,
                              bool preferMjpeg,
                              ProxyCodec codec,
                              const ProxyTranscoder::CancelFn& shouldCancel);

static bool transcodeImpl(const std::string& inputPath,
                          const std::string& outputPath,
                          double startSec, double endSec,
                          int targetW, int targetH,
                          std::function<void(float)> progressCb,
                          int swsFlags = SWS_BILINEAR,
                          bool highBitDepth = false,
                          bool uncappedNative = false,
                          bool preferMjpeg = false,
                          ProxyCodec codec = ProxyCodec::Intra,
                          const ProxyTranscoder::CancelFn& shouldCancel = nullptr)
{
    auto body = [&] {
        return transcodeImplBody(inputPath, outputPath, startSec, endSec, targetW, targetH,
                                 progressCb, swsFlags, highBitDepth, uncappedNative,
                                 preferMjpeg, codec, shouldCancel);
    };
    // Only the Media Foundation H.264 path cares about the COM apartment; the
    // intra path runs exactly as before, on the calling thread.
    return (codec == ProxyCodec::H264) ? runInMta(body) : body();
}

static bool transcodeImplBody(const std::string& inputPath,
                              const std::string& outputPath,
                              double startSec, double endSec,
                              int targetW, int targetH,
                              std::function<void(float)> progressCb,
                              int swsFlags,
                              bool highBitDepth,
                              bool uncappedNative,
                              bool preferMjpeg,
                              ProxyCodec codec,
                              const ProxyTranscoder::CancelFn& shouldCancel)
{
    std::error_code ec;
    if (!fs::exists(utf8ToPath(inputPath), ec)) {
        std::cerr << "[ProxyTranscoder] Source not found: " << inputPath << "\n";
        return false;
    }

    // Bounded concurrent generation (tiny shared GPU on small machines) — see g_genGate.
    GenerationSlot genSlot;

    // A job cancelled while it queued on g_genGate should not start at all.
    if (shouldCancel && shouldCancel()) {
        std::cout << "[ProxyTranscoder] Cancelled before start: " << outputPath << "\n";
        return false;
    }

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

    // H.264 is 8-bit only here, and the native-resolution section export is a
    // mastering artifact (not a proxy) — both stay on the intra ladder. An H.264
    // request does NOT fall back to intra inside this function: the output file
    // is named for its codec, so the caller must pick Intra (preferredCodec()
    // already does when no H.264 encoder opens) rather than get an intra file
    // behind an .h264 name.
    const bool useH264 = (codec == ProxyCodec::H264) && !highBitDepth && !uncappedNative;
    std::vector<ProxyEnc> encoders = useH264 ? buildH264Encoders()
                                             : buildProxyEncoders(highBitDepth, preferMjpeg);
    if (encoders.empty()) {
        std::cerr << "[ProxyTranscoder] No " << (useH264 ? "H.264" : "all-intra (DNxHD/MJPEG)")
                  << " proxy encoder compiled into linked FFmpeg — cannot generate "
                     "proxy; preview falls back to live decode.\n";
        return false;
    }

    SrcCtx s;
    if (!openVideoSource(inputPath, s)) {
        std::cerr << "[ProxyTranscoder] Proxy FAILED: could not open source for decode "
                     "(see above) — preview falls back to live decode.\n";
        return false;
    }

    // A still image (image2 / *_pipe demuxer) is one frame: nothing to proxy,
    // and a one-frame H.264 encode comes out empty. Live decode of it is cheap.
    // A source with alpha would lose it in any proxy codec (see PixelAlpha.h).
    {
        const std::string demux = s.fmt->iformat ? s.fmt->iformat->name : "";
        if (demux == "image2" || demux.find("_pipe") != std::string::npos
            || pixFmtMayHaveAlpha(s.fmt->streams[s.streamIdx]->codecpar->format)) {
            std::cout << "[ProxyTranscoder] Proxy skipped: still image or alpha source — preview uses the original.\n";
            s.close();
            return false;
        }
    }

    // ── target size: caller hint (or source), even ───────────────────────────
    // Height-only request (targetW<=0, targetH>0): the requested height IS the
    // final target — a resolution bucket already chosen by the caller (preview
    // ≤720p, or a render footprint bucket up to 2160p). Derive width from the
    // source aspect, NEVER upscale, and do NOT apply the 1080p cap (render buckets
    // legitimately exceed 1080). Both-given (region) and both-zero (legacy
    // whole-file) callers keep the historical <=1080p cap.
    int tw, th;
    if (uncappedNative) {
        // Full-quality section export (transcodeSectionHQX): the whole point is
        // to preserve source resolution exactly, even above 1080p/4K — never
        // apply the preview-proxy resolution cap below.
        tw = evenClamp(s.width);
        th = evenClamp(s.height);
    } else if (targetW <= 0 && targetH > 0 && s.height > 0) {
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

    // ── open the first encoder in the ladder that accepts this size/rate ──────
    for (const ProxyEnc& cand : encoders) {
        if (enc) avcodec_free_context(&enc);
        enc = avcodec_alloc_context3(cand.codec);
        if (!enc) continue;

        enc->width        = tw;
        enc->height       = th;
        enc->pix_fmt      = cand.pixFmt;
        enc->time_base    = av_inv_q(s.frameRate);
        enc->framerate    = s.frameRate;
        enc->thread_count = proxyThreadCount();
        if (cand.tuning != EncTuning::Intra)
            tuneH264Encoder(enc, cand.tuning);
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
        std::cerr << "[ProxyTranscoder] Proxy FAILED: no proxy encoder accepted the "
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
    //
    // Three stages, measured on a 1080p24 H.264 source → 720p proxy (120 s of
    // footprint): decode (4 thr) + Lanczos scale (1 thr) 4.7 s, encode 2.6 s.
    // Run back-to-back on one thread that was ~7.3 s per 120 s — the whole
    // 22-minute episode proxy took 104 s. Two changes, both bounded by
    // HardwareTier (small machines keep the historical single-threaded path):
    //   1. The scaler is threaded (sws slice threads; 4.7 s → 2.4 s).
    //   2. Decoding runs on a helper thread feeding a small bounded queue, so it
    //      overlaps scale+encode on this thread (which stays the MTA thread the
    //      Media Foundation encoder was opened on).
    // Output is identical: same decoder, same scaler flags/colour handling
    // (explicitly-initialised context — frame colour tags are NOT read, exactly
    // like the legacy sws_scale path), same encoder, same frame order.
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

        const int  scaleWorkers = xleth::hw::proxyScaleThreads(GenerationGate::capacity());
        const bool pipelined    = xleth::hw::proxyPipelineEnabled();

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

        // Stages: decode → scale → encode. Serial mode runs all three on this
        // thread. Pipelined mode runs decode on one helper thread, scaling on
        // `scaleWorkers` helper threads (FRAME-level parallelism: each worker has
        // its own single-threaded scaler and scales whole frames, which scales
        // linearly — swscale's slice threading gave ~1.3x from 6 threads on a
        // 1080p→720p Lanczos), and encoding stays on this (MTA) thread, fed in
        // frame order. Every frame goes through exactly the same scaler setup as
        // the historical path, so the output is bit-identical.
        int64_t outIdx = 0;
        using StageClock = std::chrono::steady_clock;
        double encodeSec = 0.0, waitSec = 0.0, progressSec = 0.0;
        std::atomic<int64_t> scaleMicros{0};
        const auto jobStart = StageClock::now();
        auto secSince = [](StageClock::time_point t) {
            return std::chrono::duration<double>(StageClock::now() - t).count();
        };

        // The historical scaler: explicitly initialised, single-threaded.
        auto makeScaler = [&](const AVFrame* cpu) -> SwsContext* {
            return sws_getContext(cpu->width, cpu->height,
                                  static_cast<AVPixelFormat>(cpu->format),
                                  tw, th, enc->pix_fmt,
                                  swsFlags, nullptr, nullptr, nullptr);
        };
        auto scaleInto = [&](SwsContext*& ctx, AVFrame* dst, const AVFrame* cpu) -> bool {
            if (!ctx) {
                ctx = makeScaler(cpu);
                if (!ctx) { std::cerr << "[ProxyTranscoder] proxy sws_getContext failed\n"; return false; }
            }
            const auto t = StageClock::now();
            sws_scale(ctx, cpu->data, cpu->linesize, 0, cpu->height, dst->data, dst->linesize);
            scaleMicros += static_cast<int64_t>(secSince(t) * 1e6);
            return true;
        };
        auto encodeScaled = [&](AVFrame* scaled, double tSec) -> bool {
            scaled->pts = outIdx++;
            if (picked->qscale) scaled->quality = enc->global_quality;
            const auto tEnc = StageClock::now();
            if (!encodeOne(scaled)) return false;
            encodeSec += secSince(tEnc);
            if (progressCb && spanSec > 0.0) {
                const auto tProg = StageClock::now();
                double base = (startSec >= 0.0) ? startSec : 0.0;
                float  p    = static_cast<float>(std::clamp((tSec - base) / spanSec, 0.0, 1.0));
                progressCb(p);
                progressSec += secSince(tProg);
            }
            return true;
        };

        // Decode stage: reads, decodes, range-trims and downloads hw frames,
        // handing each kept CPU frame to `sink`. Returns false on a decode
        // error, a cancellation, or when `sink` refuses a frame.
        const double kEps = 1e-6;
        std::atomic<bool> cancelled{false};
        auto decodeAll = [&](const std::function<bool(AVFrame*, double)>& sink) -> bool {
            AVPacket* rpkt    = av_packet_alloc();
            bool      flushed = false;
            bool      okLoop  = (rpkt != nullptr);
            bool      done    = !okLoop;
            while (!done) {
                int rr = av_read_frame(s.fmt, rpkt);
                if (rr < 0) {
                    if (!flushed) { avcodec_send_packet(s.dec, nullptr); flushed = true; }
                } else if (rpkt->stream_index != s.streamIdx) {
                    av_packet_unref(rpkt);
                    continue;
                } else {
                    avcodec_send_packet(s.dec, rpkt);
                    av_packet_unref(rpkt);
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

                    if (shouldCancel && shouldCancel()) {
                        cancelled = true;
                        av_frame_unref(decFrame); done = true; okLoop = false; break;
                    }

                    // Cheap range trim BEFORE the (expensive) GPU→sysmem download.
                    if (startSec >= 0.0 && tSec < startSec - kEps) { av_frame_unref(decFrame); continue; }
                    if (endSec   >= 0.0 && tSec >= endSec - kEps)  { av_frame_unref(decFrame); done = true; break; }

                    // Download to system memory if this is a D3D11VA hw frame.
                    AVFrame* cpu = mapToCpu(s, decFrame);
                    if (!cpu) { av_frame_unref(decFrame); done = true; okLoop = false; break; }

                    const bool accepted = sink(cpu, tSec);
                    av_frame_unref(decFrame);
                    if (!accepted) { done = true; okLoop = false; break; }
                }

                if (rr < 0 && flushed) break;   // drained the decoder at EOF
            }
            if (rpkt) av_packet_free(&rpkt);
            return okLoop;
        };

        bool encodeErr = false;
        if (!pipelined) {
            // Historical single-thread path (small machines / XLETH_HW_PROXY_PIPELINE=0).
            if (!decodeAll([&](AVFrame* cpu, double tSec) {
                    return av_frame_make_writable(encFrame) >= 0
                        && scaleInto(sws, encFrame, cpu)
                        && encodeScaled(encFrame, tSec);
                }))
                encodeErr = true;
        } else {
            // decode thread ──(decoded, bounded)──▶ N scale workers ──(scaled,
            // reordered by sequence, bounded)──▶ this thread encodes in order.
            // The decode thread owns `s` and decFrame; each worker owns its
            // scaler; this thread owns enc/oc. Frames cross as owned refs.
            struct Item { AVFrame* f; double t; int64_t seq; };
            std::mutex              qm;
            std::condition_variable qcv;
            std::deque<Item>        decoded;
            std::map<int64_t, Item> scaled;
            const size_t  kDecodedCap = static_cast<size_t>(scaleWorkers) * 2 + 2;
            const int64_t kScaledWindow = static_cast<int64_t>(scaleWorkers) * 2 + 4;
            int64_t produced     = 0;      // frames pushed by the decoder
            int64_t nextToEncode = 0;
            bool    producerDone = false;
            bool    producerOk   = true;
            bool    abortAll     = false;
            bool    scaleFailed  = false;

            std::thread producer([&] {
                lowerHelperThreadPriority();
                const bool okDec = decodeAll([&](AVFrame* cpu, double tSec) -> bool {
                    AVFrame* own = av_frame_alloc();
                    if (!own) return false;
                    av_frame_move_ref(own, cpu);   // takes decFrame's (or the hw download's) buffers
                    std::unique_lock<std::mutex> lk(qm);
                    qcv.wait(lk, [&] { return decoded.size() < kDecodedCap || abortAll; });
                    if (abortAll) { av_frame_free(&own); return false; }
                    decoded.push_back({own, tSec, produced++});
                    qcv.notify_all();
                    return true;
                });
                std::lock_guard<std::mutex> lk(qm);
                producerDone = true;
                producerOk   = okDec;
                qcv.notify_all();
            });

            std::vector<std::thread> workers;
            workers.reserve(static_cast<size_t>(scaleWorkers));
            for (int w = 0; w < scaleWorkers; ++w) {
                workers.emplace_back([&] {
                    lowerHelperThreadPriority();
                    SwsContext* ctx = nullptr;
                    while (true) {
                        Item it{nullptr, 0.0, -1};
                        {
                            std::unique_lock<std::mutex> lk(qm);
                            // Only take a frame that fits the reorder window, so a
                            // slow frame can't let the others run unboundedly ahead.
                            qcv.wait(lk, [&] {
                                return abortAll
                                    || (!decoded.empty() && decoded.front().seq < nextToEncode + kScaledWindow)
                                    || (decoded.empty() && producerDone);
                            });
                            if (abortAll || decoded.empty()) break;
                            it = decoded.front();
                            decoded.pop_front();
                            qcv.notify_all();
                        }
                        AVFrame* out = av_frame_alloc();
                        bool ok = (out != nullptr);
                        if (ok) {
                            out->format = enc->pix_fmt;
                            out->width  = tw;
                            out->height = th;
                            ok = av_frame_get_buffer(out, 32) >= 0 && scaleInto(ctx, out, it.f);
                        }
                        av_frame_free(&it.f);
                        std::lock_guard<std::mutex> lk(qm);
                        if (!ok) {
                            if (out) av_frame_free(&out);
                            scaleFailed = true;
                            abortAll    = true;
                            qcv.notify_all();
                            break;
                        }
                        scaled.emplace(it.seq, Item{out, it.t, it.seq});
                        qcv.notify_all();
                    }
                    if (ctx) sws_freeContext(ctx);
                });
            }

            while (true) {
                Item it{nullptr, 0.0, -1};
                {
                    std::unique_lock<std::mutex> lk(qm);
                    const auto tWait = StageClock::now();
                    qcv.wait(lk, [&] {
                        return abortAll
                            || scaled.count(nextToEncode) != 0
                            || (producerDone && nextToEncode >= produced);
                    });
                    waitSec += secSince(tWait);
                    if (abortAll) break;
                    auto found = scaled.find(nextToEncode);
                    if (found == scaled.end()) break;      // all produced frames encoded
                    it = found->second;
                    scaled.erase(found);
                    ++nextToEncode;
                    qcv.notify_all();
                }
                const bool okFrame = encodeScaled(it.f, it.t);
                av_frame_free(&it.f);
                if (!okFrame) {
                    encodeErr = true;
                    std::lock_guard<std::mutex> lk(qm);
                    abortAll = true;
                    qcv.notify_all();
                    break;
                }
            }
            {
                // Release every helper (a decode error / cancel ends the producer;
                // the workers drain or stop on abort).
                std::lock_guard<std::mutex> lk(qm);
                if (encodeErr) abortAll = true;
                qcv.notify_all();
            }
            producer.join();
            {
                std::lock_guard<std::mutex> lk(qm);
                qcv.notify_all();
            }
            for (std::thread& t : workers) t.join();
            for (Item& left : decoded) av_frame_free(&left.f);
            for (auto& kv : scaled)    av_frame_free(&kv.second.f);
            decoded.clear();
            scaled.clear();
            if (!producerOk || scaleFailed) encodeErr = true;
        }

        std::cout << "[ProxyTranscoder] stages: " << outIdx << " frames in "
                  << secSince(jobStart) << " s — scale " << (scaleMicros.load() / 1e6)
                  << " s cpu over " << (pipelined ? scaleWorkers : 1) << " worker(s), encode "
                  << encodeSec << " s, encoder waiting " << waitSec << " s, progress "
                  << progressSec << " s"
                  << (pipelined ? " [pipelined]" : " [serial]") << "\n";
        if (cancelled)
            std::cout << "[ProxyTranscoder] Cancelled mid-transcode after "
                      << outIdx << " frame(s) — discarding " << tmpPath << "\n";

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
    std::function<void(float progress)> progressCallback,
    ProxyCodec         codec,
    CancelFn           shouldCancel)
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
              << targetWidth << "x" << targetHeight
              << " codec=" << codecTag(codec) << "\n";

    auto t0 = std::chrono::high_resolution_clock::now();
    if (progressCallback) progressCallback(0.0f);

    bool ok = transcodeImpl(inputPath, outputPath,
                            startTimeSec, endTimeSec,
                            targetWidth, targetHeight, progressCallback,
                            SWS_BILINEAR, /*highBitDepth=*/false,
                            /*uncappedNative=*/false, /*preferMjpeg=*/false,
                            codec, shouldCancel);
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

// ── transcodeSectionHQX (full-quality section export, NOT a preview artifact) ─

bool ProxyTranscoder::transcodeSectionHQX(
    const std::string& inputPath,
    const std::string& outputPath,
    double             startTimeSec,
    double             endTimeSec,
    std::function<void(float progress)> progressCallback)
{
    std::error_code ec;
    if (!fs::exists(utf8ToPath(inputPath), ec)) {
        std::cerr << "[ProxyTranscoder] Source not found: " << inputPath << "\n";
        return false;
    }
    if (endTimeSec <= startTimeSec) {
        std::cerr << "[ProxyTranscoder] Invalid section range: start=" << startTimeSec
                  << " end=" << endTimeSec << "\n";
        return false;
    }

    std::cout << "[ProxyTranscoder] Section export (in-process, native resolution)\n"
              << "[ProxyTranscoder] Section Input : " << inputPath  << "\n"
              << "[ProxyTranscoder] Section Output: " << outputPath << "\n"
              << "[ProxyTranscoder] Section Range: [" << startTimeSec << ", " << endTimeSec
              << ") (" << (endTimeSec - startTimeSec) << " s)\n";

    auto t0 = std::chrono::high_resolution_clock::now();
    if (progressCallback) progressCallback(0.0f);

    // targetW/targetH are ignored when uncappedNative=true (source dims used
    // directly); highBitDepth=true puts DNxHR HQX first in the encoder ladder.
    bool ok = transcodeImpl(inputPath, outputPath,
                            startTimeSec, endTimeSec,
                            0, 0, progressCallback,
                            SWS_BILINEAR, /*highBitDepth=*/true, /*uncappedNative=*/true);
    if (!ok) {
        std::cerr << "[ProxyTranscoder] Section export FAILED\n";
        return false;
    }

    auto t1 = std::chrono::high_resolution_clock::now();
    double elapsed = std::chrono::duration<double>(t1 - t0).count();
    double outMB = static_cast<double>(fs::file_size(utf8ToPath(outputPath), ec)) / (1024.0 * 1024.0);
    std::printf("[ProxyTranscoder] Section export done in %.1f s — %.1f MB\n", elapsed, outMB);
    return true;
}

// ── transcodeSourcePreview (whole-source, height-keyed, lanczos) ──────────────

bool ProxyTranscoder::transcodeSourcePreview(
    const std::string& inputPath,
    const std::string& outputPath,
    int                targetHeight,
    bool               highBitDepth,
    std::function<void(float progress)> progressCallback,
    ProxyCodec         codec,
    CancelFn           shouldCancel)
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
              << (highBitDepth ? "10-bit intra" : (codec == ProxyCodec::H264
                                                       ? "8-bit H.264" : "8-bit intra"))
              << ")\n";

    auto t0 = std::chrono::high_resolution_clock::now();
    if (progressCallback) progressCallback(0.0f);

    // startSec=-1, endSec=-1 ⇒ whole file. targetW=0 + targetH>0 ⇒ width derived
    // from the source aspect at targetHeight, no 1080p cap (see transcodeImpl).
    // SWS_LANCZOS for high-quality downscaling (paid once, off-thread).
    // preferMjpeg=true (intra ladder only): this is the unattended, whole-source,
    // tens-of-thousands-of-frames background job — the one most exposed to
    // DNxHR's fixed-budget put_bits overrun on a rare high-entropy frame (see
    // buildProxyEncoders). H.264 rate control has no fixed per-frame budget.
    bool ok = transcodeImpl(inputPath, outputPath, -1.0, -1.0,
                            /*targetW*/0, /*targetH*/targetHeight,
                            progressCallback, SWS_LANCZOS, highBitDepth,
                            /*uncappedNative*/false, /*preferMjpeg*/true,
                            codec, shouldCancel);
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
