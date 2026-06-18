#include "VisualFrameDiagnostics.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <map>
#include <mutex>

#ifdef _WIN32
  #ifndef NOMINMAX
    #define NOMINMAX
  #endif
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #include <windows.h>
#endif

namespace xleth::visualdiag {

const char* pixelFormatName(PixelFormat fmt)
{
    return fmt == PixelFormat::RGBA ? "RGBA" : "BGRA";
}

// ===========================================================================
// Stats computation
// ===========================================================================

FramePixelStats computeFrameStats(const uint8_t* data, int width, int height,
                                  int rowPitch, PixelFormat fmt,
                                  int64_t frameIndex, int64_t tickIndex,
                                  double timestamp)
{
    FramePixelStats s;
    s.format     = fmt;
    s.width      = width;
    s.height     = height;
    s.rowPitch   = rowPitch;
    s.frameIndex = frameIndex;
    s.tickIndex  = tickIndex;
    s.timestamp  = timestamp;

    if (!data || width <= 0 || height <= 0) {
        return s;   // observed stays false
    }

    const int rowBytes = width * 4;
    if (rowPitch < rowBytes) rowPitch = rowBytes;  // defensive: never read past

    // Channel offsets for the "red"/"blue" position so luma is order-aware.
    // BGRA: B=0 G=1 R=2 A=3 ;  RGBA: R=0 G=1 B=2 A=3
    const int rIdx = (fmt == PixelFormat::RGBA) ? 0 : 2;
    const int bIdx = (fmt == PixelFormat::RGBA) ? 2 : 0;

    uint64_t checksum   = 0;
    uint64_t nzBytes    = 0;
    uint64_t nzPixels   = 0;
    double   lumaSum    = 0.0;

    for (int y = 0; y < height; ++y) {
        const uint8_t* row = data + static_cast<size_t>(y) * rowPitch;
        for (int x = 0; x < width; ++x) {
            const uint8_t* px = row + static_cast<size_t>(x) * 4;
            const uint8_t c0 = px[0], c1 = px[1], c2 = px[2], c3 = px[3];
            checksum += c0; checksum += c1; checksum += c2; checksum += c3;
            if (c0) ++nzBytes;
            if (c1) ++nzBytes;
            if (c2) ++nzBytes;
            if (c3) ++nzBytes;
            if (c0 || c1 || c2) ++nzPixels;  // any colour channel (ignore alpha)
            const double R = px[rIdx];
            const double G = px[1];
            const double B = px[bIdx];
            lumaSum += 0.299 * R + 0.587 * G + 0.114 * B;
        }
    }

    s.byteCount     = static_cast<uint64_t>(rowBytes) * height;
    s.checksum64    = checksum;
    s.nonZeroBytes  = nzBytes;
    s.nonZeroPixels = nzPixels;
    const double pixelCount = static_cast<double>(width) * height;
    s.averageLuma   = pixelCount > 0 ? (lumaSum / pixelCount) : 0.0;

    // first16 (row 0)
    const int firstCount = (rowBytes < 16) ? rowBytes : 16;
    std::memcpy(s.first16.data(), data, static_cast<size_t>(firstCount));

    // center pixel
    {
        const int cx = width / 2;
        const int cy = height / 2;
        const uint8_t* p = data + static_cast<size_t>(cy) * rowPitch + static_cast<size_t>(cx) * 4;
        std::memcpy(s.centerPixel.data(), p, 4);
    }

    // four corners: TL, TR, BL, BR
    auto pixelAt = [&](int x, int y, std::array<uint8_t, 4>& out) {
        if (x < 0) x = 0; if (x >= width)  x = width - 1;
        if (y < 0) y = 0; if (y >= height) y = height - 1;
        const uint8_t* p = data + static_cast<size_t>(y) * rowPitch + static_cast<size_t>(x) * 4;
        std::memcpy(out.data(), p, 4);
    };
    pixelAt(0,         0,          s.corners[0]); // TL
    pixelAt(width - 1, 0,          s.corners[1]); // TR
    pixelAt(0,         height - 1, s.corners[2]); // BL
    pixelAt(width - 1, height - 1, s.corners[3]); // BR

    s.observed = true;
    return s;
}

std::string first16Hex(const FramePixelStats& s)
{
    char buf[16 * 3 + 1];
    int n = 0;
    const int count = (s.byteCount == 0) ? 0
                    : (s.width * 4 < 16 ? s.width * 4 : 16);
    for (int i = 0; i < count; ++i) {
        n += std::snprintf(buf + n, sizeof(buf) - n, "%s%02X",
                           i == 0 ? "" : " ", s.first16[i]);
    }
    return std::string(buf, static_cast<size_t>(n));
}

// ===========================================================================
// Gating (cached once)
// ===========================================================================

static bool envFlagOn(const char* name)
{
    const char* v = std::getenv(name);
    return v && v[0] && std::strcmp(v, "0") != 0;
}

bool pixelsEnabled()
{
    static const bool on = envFlagOn("XLETH_VISUAL_DIAG_PIXELS");
    return on;
}

bool dumpFramesEnabled()
{
    // Dumping implies pixel stats (we record stats when we dump). It is a
    // strict superset, but kept independent so a tester can dump without
    // necessarily wiring up the stats reader.
    static const bool on = envFlagOn("XLETH_VISUAL_DIAG_DUMP_FRAMES");
    return on;
}

int maxDumpFramesPerStage()
{
    static const int n = []() {
        const char* v = std::getenv("XLETH_VISUAL_DIAG_DUMP_MAX");
        if (v && v[0]) {
            int parsed = std::atoi(v);
            if (parsed > 0 && parsed < 10000) return parsed;
        }
        return 3;  // default cap per stage per run
    }();
    return n;
}

// ===========================================================================
// Registry
// ===========================================================================

namespace {

struct Entry {
    uint64_t        count = 0;
    uint64_t        dumps = 0;
    FramePixelStats first;
    FramePixelStats latest;
    bool            haveFirst = false;
};

std::mutex              g_mutex;
std::map<std::string, Entry> g_stages;
std::vector<std::string> g_order;   // first-seen ordering for stable reports
std::string             g_sessionDir;
bool                    g_sessionResolved = false;

Entry& entryFor(const std::string& stage)
{
    auto it = g_stages.find(stage);
    if (it == g_stages.end()) {
        g_order.push_back(stage);
        return g_stages[stage];
    }
    return it->second;
}

} // namespace

void record(const char* stage, const FramePixelStats& stats)
{
    if (!pixelsEnabled() || !stage) return;
    std::lock_guard<std::mutex> lk(g_mutex);
    Entry& e = entryFor(stage);
    if (!e.haveFirst) { e.first = stats; e.haveFirst = true; }
    e.latest = stats;
    ++e.count;
}

// ---------------------------------------------------------------------------
// Raw frame dump
// ---------------------------------------------------------------------------

namespace {

// Resolve (and create) the per-run dump folder. Caller holds g_mutex.
const std::string& resolveSessionDirLocked()
{
    if (g_sessionResolved) return g_sessionDir;
    g_sessionResolved = true;

#ifdef _WIN32
    // %LOCALAPPDATA% is reliably set on Windows; avoids a shell32 link dep.
    std::string base;
    if (const char* env = std::getenv("LOCALAPPDATA"); env && env[0]) {
        base = env;
    } else if (const char* tmp = std::getenv("TEMP"); tmp && tmp[0]) {
        base = tmp;  // last-ditch fallback so dumps still land somewhere
    }
    if (base.empty()) { g_sessionDir.clear(); return g_sessionDir; }

    std::time_t now = std::time(nullptr);
    std::tm tmv{};
    localtime_s(&tmv, &now);
    char stamp[32];
    std::snprintf(stamp, sizeof(stamp), "%04d%02d%02d-%02d%02d%02d",
                  tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
                  tmv.tm_hour, tmv.tm_min, tmv.tm_sec);

    std::string dir = base;
    dir += "\\Xleth";                         CreateDirectoryA(dir.c_str(), nullptr);
    // (Xleth, Diagnostics, VisualPreview, <stamp> created progressively below)
    dir += "\\Diagnostics";                   CreateDirectoryA(dir.c_str(), nullptr);
    dir += "\\VisualPreview";                 CreateDirectoryA(dir.c_str(), nullptr);
    dir += "\\"; dir += stamp;                CreateDirectoryA(dir.c_str(), nullptr);
    g_sessionDir = dir;
#else
    g_sessionDir.clear();
#endif
    return g_sessionDir;
}

std::string sanitizeStage(const char* stage)
{
    std::string s(stage);
    for (char& c : s) if (c == '/' || c == '\\' || c == ':') c = '-';
    return s;
}

} // namespace

void maybeDumpFrame(const char* stage, const uint8_t* data, int width, int height,
                    int rowPitch, PixelFormat fmt, const FramePixelStats& stats)
{
    if (!dumpFramesEnabled() || !stage || !data || width <= 0 || height <= 0) return;

    std::string dir;
    uint64_t seq = 0;
    {
        std::lock_guard<std::mutex> lk(g_mutex);
        Entry& e = entryFor(stage);
        if (e.dumps >= static_cast<uint64_t>(maxDumpFramesPerStage())) return;
        dir = resolveSessionDirLocked();
        if (dir.empty()) return;
        seq = e.dumps++;
    }

    const int   rowBytes = width * 4;
    const char* ext = (fmt == PixelFormat::RGBA) ? "rgba" : "bgra";
    const std::string base = dir + "\\" + sanitizeStage(stage) + "-" +
        std::to_string(seq) + "-" + std::to_string(width) + "x" + std::to_string(height);

    // Raw pixel file — tightly packed (rowPitch padding stripped).
    {
        const std::string rawPath = base + "." + ext;
        if (FILE* f = std::fopen(rawPath.c_str(), "wb")) {
            const int srcPitch = (rowPitch < rowBytes) ? rowBytes : rowPitch;
            for (int y = 0; y < height; ++y)
                std::fwrite(data + static_cast<size_t>(y) * srcPitch, 1,
                            static_cast<size_t>(rowBytes), f);
            std::fclose(f);
        }
    }

    // JSON sidecar — human-readable, self-contained.
    {
        const std::string jsonPath = base + ".json";
        if (FILE* f = std::fopen(jsonPath.c_str(), "wb")) {
            const std::string hex = first16Hex(stats);
            std::fprintf(f,
                "{\n"
                "  \"stage\": \"%s\",\n"
                "  \"format\": \"%s\",\n"
                "  \"width\": %d,\n"
                "  \"height\": %d,\n"
                "  \"rowPitch\": %d,\n"
                "  \"byteCount\": %llu,\n"
                "  \"checksum64\": %llu,\n"
                "  \"nonZeroBytes\": %llu,\n"
                "  \"nonZeroPixels\": %llu,\n"
                "  \"averageLuma\": %.4f,\n"
                "  \"first16Bytes\": \"%s\",\n"
                "  \"centerPixel\": [%u, %u, %u, %u],\n"
                "  \"frameIndex\": %lld,\n"
                "  \"tickIndex\": %lld,\n"
                "  \"timestamp\": %.4f\n"
                "}\n",
                stage, pixelFormatName(fmt), width, height, rowPitch,
                static_cast<unsigned long long>(stats.byteCount),
                static_cast<unsigned long long>(stats.checksum64),
                static_cast<unsigned long long>(stats.nonZeroBytes),
                static_cast<unsigned long long>(stats.nonZeroPixels),
                stats.averageLuma, hex.c_str(),
                stats.centerPixel[0], stats.centerPixel[1],
                stats.centerPixel[2], stats.centerPixel[3],
                static_cast<long long>(stats.frameIndex),
                static_cast<long long>(stats.tickIndex),
                stats.timestamp);
            std::fclose(f);
        }
    }
}

std::vector<StageSnapshot> snapshotAll()
{
    std::lock_guard<std::mutex> lk(g_mutex);
    std::vector<StageSnapshot> out;
    out.reserve(g_order.size());
    for (const auto& name : g_order) {
        const Entry& e = g_stages[name];
        StageSnapshot s;
        s.stage       = name;
        s.observed    = e.count > 0;
        s.sampleCount = e.count;
        s.dumpCount   = e.dumps;
        s.first       = e.first;
        s.latest      = e.latest;
        out.push_back(std::move(s));
    }
    return out;
}

std::string dumpSessionDir()
{
    std::lock_guard<std::mutex> lk(g_mutex);
    return g_sessionDir;
}

} // namespace xleth::visualdiag
