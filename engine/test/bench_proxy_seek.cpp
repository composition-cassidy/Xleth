// bench_proxy_seek.cpp — seek-latency benchmark for preview proxies.
//
// Times RenderVideoDecoder::decode() — the exact decoder the live preview uses —
// against one or more proxy files, for the access patterns an editor produces:
//
//   open      first decode after opening the file (frame 0)
//   random    uniformly random frames across the file (cold scrub jumps)
//   stepFwd   single-frame steps forward across a GOP boundary (sequential path)
//   stepBack  single-frame steps BACKWARD across a GOP boundary — the worst case
//             for a long-GOP codec: every step re-seeks to the previous keyframe
//             and decodes forward to the target
//   scrubFwd  forward scrub, 3-frame stride (mouse drag)
//   scrubBack backward scrub, 3-frame stride
//
// It also checks frame ACCURACY across GOP boundaries: for a handful of frames it
// decodes the frame once by random access (seek from elsewhere) and once by
// sequential decode from frame 0 of its GOP, reads both textures back and
// compares their pixel hashes. A long-GOP proxy that landed on the wrong frame
// after a seek would fail this.
//
// Not a ctest test (it needs real proxy files). Usage:
//   bench_proxy_seek <proxyA> [<proxyB> ...]
// Timings exclude the texture readback (only the accuracy pass reads back).
// No preview frame cache is involved: every decode() is a real decode.

#include "render/RenderVideoDecoder.h"
#include "render/GpuDeviceManager.h"
#include "render/FrameCache.h"

extern "C" {
#include <libavformat/avformat.h>
}

#include <d3d11.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <random>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

struct Stats {
    double median = 0, p95 = 0, max = 0, mean = 0;
    int    n = 0, failures = 0;
};

Stats summarize(std::vector<double> v, int failures)
{
    Stats s;
    s.n = static_cast<int>(v.size());
    s.failures = failures;
    if (v.empty()) return s;
    std::sort(v.begin(), v.end());
    s.median = v[v.size() / 2];
    s.p95    = v[std::min(v.size() - 1, static_cast<size_t>(v.size() * 0.95))];
    s.max    = v.back();
    double sum = 0; for (double x : v) sum += x;
    s.mean = sum / v.size();
    return s;
}

// Frame count of the file's video stream (container metadata; falls back to
// duration × fps).
int64_t probeFrameCount(const std::string& path, double& fpsOut)
{
    AVFormatContext* fmt = nullptr;
    int64_t n = 0;
    fpsOut = 24.0;
    if (avformat_open_input(&fmt, path.c_str(), nullptr, nullptr) < 0) return 0;
    if (avformat_find_stream_info(fmt, nullptr) >= 0) {
        const int vi = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
        if (vi >= 0) {
            AVStream* st = fmt->streams[vi];
            if (st->avg_frame_rate.num > 0) fpsOut = av_q2d(st->avg_frame_rate);
            n = st->nb_frames;
            if (n <= 0 && fmt->duration > 0)
                n = static_cast<int64_t>(fmt->duration / double(AV_TIME_BASE) * fpsOut);
        }
    }
    avformat_close_input(&fmt);
    return n;
}

// FNV-1a over the texture's pixels (staging readback).
uint64_t hashTexture(ID3D11Device* dev, ID3D11DeviceContext* ctx, ID3D11Texture2D* tex)
{
    if (!tex) return 0;
    D3D11_TEXTURE2D_DESC d{};
    tex->GetDesc(&d);
    d.Usage = D3D11_USAGE_STAGING;
    d.BindFlags = 0;
    d.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    d.MiscFlags = 0;
    ComPtr<ID3D11Texture2D> staging;
    if (FAILED(dev->CreateTexture2D(&d, nullptr, &staging))) return 0;
    ctx->CopyResource(staging.Get(), tex);
    D3D11_MAPPED_SUBRESOURCE m{};
    if (FAILED(ctx->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &m))) return 0;
    uint64_t h = 1469598103934665603ull;
    for (UINT y = 0; y < d.Height; ++y) {
        const auto* row = static_cast<const uint8_t*>(m.pData) + size_t(y) * m.RowPitch;
        for (UINT x = 0; x < d.Width * 4; ++x) { h ^= row[x]; h *= 1099511628211ull; }
    }
    ctx->Unmap(staging.Get(), 0);
    return h;
}

void printStats(const char* label, const Stats& s)
{
    std::printf("    %-9s n=%-3d median %7.2f ms   p95 %7.2f ms   max %7.2f ms   mean %7.2f ms%s\n",
                label, s.n, s.median, s.p95, s.max, s.mean,
                s.failures ? "   (DECODE FAILURES!)" : "");
}

} // namespace

int main(int argc, char** argv)
{
    if (argc < 2) {
        std::fprintf(stderr, "usage: bench_proxy_seek <proxy> [<proxy> ...]\n");
        return 2;
    }

    GpuDeviceManager gpu;
    if (!gpu.detectAdapters() || !gpu.createDevice()) {
        std::fprintf(stderr, "SKIP: no D3D11 device\n");
        return 0;
    }
    ID3D11Device*        dev = gpu.getDevice();
    ID3D11DeviceContext* ctx = gpu.getContext();

    int exitCode = 0;
    for (int a = 1; a < argc; ++a) {
        const std::string path = argv[a];
        double fps = 24.0;
        const int64_t frames = probeFrameCount(path, fps);
        std::printf("\n== %s\n   %lld frames @ %.3f fps\n", path.c_str(), (long long)frames, fps);
        if (frames < 200) { std::printf("   too short, skipped\n"); continue; }

        using clk = std::chrono::steady_clock;
        auto timeDecode = [&](RenderVideoDecoder& d, int64_t f, int& fails) -> double {
            const auto t0 = clk::now();
            FrameCacheEntry e = d.decode(path, f, dev, ctx);
            ctx->Flush();
            const double ms = std::chrono::duration<double, std::milli>(clk::now() - t0).count();
            if (!e.texture) ++fails;
            return ms;
        };

        RenderVideoDecoder dec;

        // open + first frame
        int fails = 0;
        std::vector<double> v{ timeDecode(dec, 0, fails) };
        const Stats open = summarize(v, fails);

        // Decode path actually used (hw / sw, intra-only?).
        for (const auto& info : dec.openSourceInfos()) {
            if (info.sourcePath == path)
                std::printf("   decoder: %s, intraOnly=%s\n",
                            info.path == RenderVideoDecoder::DecodePath::Hardware ? "D3D11VA" : "software",
                            info.intraOnly ? "yes" : "no");
        }

        std::mt19937 rng(12345);   // same frame sequence for every file
        std::uniform_int_distribution<int64_t> pick(0, frames - 2);
        v.clear(); fails = 0;
        for (int i = 0; i < 60; ++i) v.push_back(timeDecode(dec, pick(rng), fails));
        const Stats rnd = summarize(v, fails);

        // GOP boundary at 48 for the H.264 proxies; stepping 40..63 crosses it.
        const int64_t base = std::min<int64_t>(frames / 2 / 48 * 48, frames - 80);
        v.clear(); fails = 0;
        timeDecode(dec, base - 8, fails);   // position (untimed)
        for (int64_t f = base - 7; f <= base + 16; ++f) v.push_back(timeDecode(dec, f, fails));
        const Stats stepF = summarize(v, fails);

        v.clear(); fails = 0;
        timeDecode(dec, base + 17, fails);
        for (int64_t f = base + 16; f >= base - 7; --f) v.push_back(timeDecode(dec, f, fails));
        const Stats stepB = summarize(v, fails);

        v.clear(); fails = 0;
        const int64_t s0 = std::max<int64_t>(0, base - 120);
        timeDecode(dec, s0, fails);
        for (int64_t f = s0 + 3; f <= s0 + 240 && f < frames - 1; f += 3) v.push_back(timeDecode(dec, f, fails));
        const Stats scrF = summarize(v, fails);

        v.clear(); fails = 0;
        timeDecode(dec, s0 + 243, fails);
        for (int64_t f = s0 + 240; f >= s0 && f > 0; f -= 3) v.push_back(timeDecode(dec, f, fails));
        const Stats scrB = summarize(v, fails);

        printStats("open", open);
        printStats("random", rnd);
        printStats("stepFwd", stepF);
        printStats("stepBack", stepB);
        printStats("scrubFwd", scrF);
        printStats("scrubBack", scrB);

        // ── accuracy across GOP boundaries ──────────────────────────────────
        // Random access (fresh decoder, cold seek) vs sequential decode from the
        // start of the GOP (frame index sequence k*48 .. target).
        int mismatches = 0, checked = 0;
        const int64_t targets[] = { base - 1, base, base + 1, base + 23, base + 47, base + 48 };
        for (int64_t t : targets) {
            RenderVideoDecoder cold;
            cold.decode(path, (t + frames / 3) % (frames - 1), dev, ctx);     // somewhere else first
            FrameCacheEntry r = cold.decode(path, t, dev, ctx);                // random access
            const uint64_t hr = hashTexture(dev, ctx, r.texture.Get());

            RenderVideoDecoder seq;
            const int64_t gopStart = std::max<int64_t>(0, (t / 48) * 48 - 48);
            FrameCacheEntry s;
            for (int64_t f = gopStart; f <= t; ++f) s = seq.decode(path, f, dev, ctx);
            const uint64_t hs = hashTexture(dev, ctx, s.texture.Get());
            ++checked;
            if (hr == 0 || hr != hs) {
                ++mismatches;
                std::printf("    ACCURACY MISMATCH at frame %lld (random %016llx vs sequential %016llx)\n",
                            (long long)t, (unsigned long long)hr, (unsigned long long)hs);
            }
        }
        std::printf("    accuracy: %d/%d GOP-boundary frames identical via random vs sequential access\n",
                    checked - mismatches, checked);
        if (mismatches || rnd.failures || stepB.failures || scrB.failures) exitCode = 1;
    }
    return exitCode;
}
