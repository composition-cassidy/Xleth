#pragma once
// ─────────────────────────────────────────────────────────────────────────────
// HardwareTier — one place that turns "what machine is this" into "how much of
// it may a background subsystem take".
//
// Before this, every pool and cache had its own fixed number (2 proxy workers,
// 512 MB caches, 4 render threads …) chosen for the low-end machine, so a
// 24-thread / 128 GB / 16 GB-VRAM workstation ran the same budgets as a
// 4-core laptop and idled at ~4 % CPU while proxies took minutes.
//
// Rules (keep them monotonic — a bigger machine never gets LESS):
//   • The low tier reproduces the historical constants exactly, so small
//     machines behave as before.
//   • Scaling is bounded: background work never claims the whole machine
//     (the audio callback, video thread and UI must keep their headroom).
//   • Header-only, std + Win32 only: usable from the Model tier (no JUCE).
//
// Every value is overridable with XLETH_HW_* env vars for A/B runs.
// ─────────────────────────────────────────────────────────────────────────────

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <thread>

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#endif

namespace xleth::hw {

inline int envInt(const char* name, int fallback, int lo, int hi)
{
    char buf[32] = {};
#ifdef _MSC_VER
    char*  dup = nullptr;
    size_t len = 0;
    if (_dupenv_s(&dup, &len, name) != 0 || !dup) return fallback;
    std::snprintf(buf, sizeof(buf), "%s", dup);
    std::free(dup);
#else
    const char* v = std::getenv(name);
    if (!v) return fallback;
    std::snprintf(buf, sizeof(buf), "%s", v);
#endif
    char* end = nullptr;
    const long n = std::strtol(buf, &end, 10);
    if (end != buf && n >= lo && n <= hi) return static_cast<int>(n);
    return fallback;
}

// Logical processors (hyper-threads count). Never 0.
inline int logicalCores()
{
    static const int n = [] {
        const int hc = static_cast<int>(std::thread::hardware_concurrency());
        return envInt("XLETH_HW_CORES", hc > 0 ? hc : 4, 1, 1024);
    }();
    return n;
}

// Installed physical RAM in bytes (0 if unknown).
inline uint64_t totalRamBytes()
{
    static const uint64_t bytes = [] {
        const int overrideGb = envInt("XLETH_HW_RAM_GB", 0, 1, 65536);
        if (overrideGb > 0) return static_cast<uint64_t>(overrideGb) << 30;
#ifdef _WIN32
        MEMORYSTATUSEX ms{};
        ms.dwLength = sizeof(ms);
        if (GlobalMemoryStatusEx(&ms)) return static_cast<uint64_t>(ms.ullTotalPhys);
#endif
        return uint64_t{0};
    }();
    return bytes;
}

// RAM multiplier for fixed-size CPU-side caches:
//   < 24 GB → 1x (historical), 24-48 GB → 2x, ≥ 48 GB → 4x.
inline int ramCacheMultiplier()
{
    static const int m = [] {
        const uint64_t gb = totalRamBytes() >> 30;
        int v = 1;
        if (gb >= 48)      v = 4;
        else if (gb >= 24) v = 2;
        return envInt("XLETH_HW_RAM_CACHE_MULT", v, 1, 16);
    }();
    return m;
}

// Scale a historical cache budget by the RAM tier.
inline size_t scaledCacheBytes(size_t baseBytes)
{
    return baseBytes * static_cast<size_t>(ramCacheMultiplier());
}

// Worker count for a background pool whose historical size was `base`:
//   < 12 logical cores → base (historical), 12-19 → 2x, ≥ 20 → 3x,
//   always capped at `cap` and at a quarter of the machine.
inline int backgroundWorkers(int base, int cap)
{
    const int cores = logicalCores();
    int mult = 1;
    if (cores >= 20)      mult = 3;
    else if (cores >= 12) mult = 2;
    const int quarter = (std::max)(1, cores / 4);
    return std::clamp(base * mult, base, (std::max)(base, (std::min)(cap, quarter)));
}

// ── Proxy generation ─────────────────────────────────────────────────────────
// Concurrent proxy/poster generation jobs. One on small machines (the original
// "tiny integrated GPU" constraint: each AV1 job opens its own D3D11VA device);
// two from 16 logical cores with ≥ 2 GB of dedicated VRAM.
inline int proxyGenerationSlots(uint64_t maxDedicatedVramBytes)
{
    int slots = 1;
    if (logicalCores() >= 16 && maxDedicatedVramBytes >= (uint64_t{2} << 30)) slots = 2;
    return envInt("XLETH_HW_PROXY_SLOTS", slots, 1, 8);
}

// Decoder threads per proxy job — the historical clamp(hw/2-1, 1, 4).
inline int proxyDecodeThreads()
{
    return envInt("XLETH_HW_PROXY_DECODE_THREADS",
                  std::clamp(logicalCores() / 2 - 1, 1, 4), 1, 64);
}

// Scaler WORKERS per proxy job (frame-level: each worker scales whole frames
// with its own single-threaded scaler, so output is identical to the historical
// path). 1 below 8 logical cores; otherwise a share of half the machine split
// across concurrent jobs, 2..4. A 1080p→720p Lanczos frame costs ~1.6 ms and the
// H.264 encode ~0.6 ms, so 3-4 workers keep the encoder fed.
inline int proxyScaleThreads(int slots)
{
    const int cores = logicalCores();
    int t = 1;
    if (cores >= 8) t = std::clamp((cores / 2) / (std::max)(1, slots), 2, 4);
    return envInt("XLETH_HW_PROXY_SCALE_THREADS", t, 1, 64);
}

// Overlap decode with scale+encode on a helper thread (bounded frame queue).
// Off below 4 logical cores, where the extra thread only adds contention.
inline bool proxyPipelineEnabled()
{
    return envInt("XLETH_HW_PROXY_PIPELINE", logicalCores() >= 4 ? 1 : 0, 0, 1) == 1;
}

// ── Parallel track mixing ────────────────────────────────────────────────────
// Helper threads that run independent track effect chains during the audio
// callback (MixEngine). 0 = the historical serial mix. Below 8 logical cores the
// wake/hand-off overhead and the contention with the UI/video threads are not
// worth it; above, one helper per 6 logical cores, at most 4 (the audio thread
// itself is the fifth). XLETH_HW_AUDIO_WORKERS overrides (0 disables).
inline int audioWorkerThreads()
{
    const int cores = logicalCores();
    const int n = (cores >= 8) ? std::clamp(cores / 6, 1, 4) : 0;
    return envInt("XLETH_HW_AUDIO_WORKERS", n, 0, 16);
}

// ── GPU frame cache (live preview) ───────────────────────────────────────────
// Historical: fixed 512 MB. Discrete cards get an eighth of dedicated VRAM,
// bounded to [512 MB, 2 GB]; integrated / unknown keep 512 MB.
inline size_t previewFrameCacheBytes(uint64_t dedicatedVramBytes, bool isDiscrete)
{
    constexpr uint64_t MB = uint64_t{1} << 20;
    uint64_t bytes = 512 * MB;
    if (isDiscrete && dedicatedVramBytes > 0)
        bytes = std::clamp<uint64_t>(dedicatedVramBytes / 8, 512 * MB, 2048 * MB);
    const int overrideMb = envInt("XLETH_PREVIEW_FRAME_CACHE_MB", 0, 64, 16384);
    if (overrideMb > 0) bytes = static_cast<uint64_t>(overrideMb) * MB;
    return static_cast<size_t>(bytes);
}

} // namespace xleth::hw
