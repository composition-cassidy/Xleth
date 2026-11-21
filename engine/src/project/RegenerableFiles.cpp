#include "project/RegenerableFiles.h"

#include "model/Timeline.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <exception>
#include <fstream>
#include <iostream>
#include <set>
#include <string_view>
#include <unordered_map>
#include <unordered_set>

namespace fs = std::filesystem;

namespace xleth::project {

// ═════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═════════════════════════════════════════════════════════════════════════════
namespace {

// Project paths are stored as UTF-8 std::strings. std::filesystem's narrow
// overloads read them as the ANSI codepage on Windows and miss non-ANSI names,
// so every string entering this module is decoded explicitly.
fs::path fromUtf8(const std::string& s)
{
    return fs::path(std::u8string(reinterpret_cast<const char8_t*>(s.data()), s.size()));
}

std::string toUtf8(const fs::path& p)
{
    const std::u8string u = p.u8string();
    return std::string(reinterpret_cast<const char*>(u.data()), u.size());
}

bool existsFile(const fs::path& p)
{
    std::error_code ec;
    return fs::is_regular_file(p, ec);
}

bool existsFileUtf8(const std::string& utf8)
{
    return !utf8.empty() && existsFile(fromUtf8(utf8));
}

bool endsWith(std::string_view s, std::string_view suffix)
{
    return s.size() >= suffix.size()
        && s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

bool startsWith(std::string_view s, std::string_view prefix)
{
    return s.size() >= prefix.size() && s.compare(0, prefix.size(), prefix) == 0;
}

bool allDigits(std::string_view s)
{
    return !s.empty() && std::all_of(s.begin(), s.end(),
        [](unsigned char c) { return std::isdigit(c) != 0; });
}

// Stable lower-cased key so the same file reached by two routes is listed once.
// (Windows paths are case-insensitive; ASCII folding is enough to dedupe the
// spellings the project actually produces.)
std::string pathKey(const fs::path& p)
{
    std::string k = toUtf8(p.lexically_normal());
    std::replace(k.begin(), k.end(), '\\', '/');
    for (char& c : k)
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    return k;
}

// Must equal the stem ProxyTranscoder's get*Path() functions derive — they all
// read `fs::path(sourcePath).stem().string()`. The narrow bytes that produces
// are the UTF-8 stem (the path is only ever read back through utf8ToPath), but
// both spellings are accepted as owners so a codepage round-trip difference can
// only ever make a file look OWNED (kept), never orphaned (deleted).
void addOwnerStems(const std::string& sourcePath, std::unordered_set<std::string>& stems)
{
    if (sourcePath.empty()) return;
    stems.insert(toUtf8(fromUtf8(sourcePath).stem()));
    try {
        stems.insert(fs::path(sourcePath).stem().string());
    } catch (const std::exception&) {
        // A narrow<->wide conversion can throw on an exotic ANSI codepage; the
        // UTF-8 spelling above is still registered, so nothing is lost.
    }
}

// Is `dir` listable? Iterates at most `cap` entries so a folder with a huge
// number of files (a Downloads folder a source lives in) cannot stall the
// project-open sweep.
constexpr int kMaxEntriesPerDir = 50000;

template <typename Fn>
void forEachFile(const fs::path& dir, Fn&& fn)
{
    std::error_code ec;
    if (dir.empty() || !fs::is_directory(dir, ec)) return;
    int seen = 0;
    for (fs::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
        if (++seen > kMaxEntriesPerDir) return;
        std::error_code fec;
        if (!it->is_regular_file(fec)) continue;
        std::error_code sec;
        const std::uintmax_t bytes = it->file_size(sec);   // -1 on error: report 0, not 16 EB
        fn(it->path(), sec ? 0 : static_cast<std::uint64_t>(bytes));
    }
}

RegenEntry makeEntry(const fs::path& p, std::uint64_t bytes, RegenCategory cat,
                     RegenClass cls, std::string note = {})
{
    RegenEntry e;
    e.path        = p;
    e.displayName = toUtf8(p.filename());
    e.category    = cat;
    e.cls         = cls;
    e.bytes       = bytes;
    e.note        = std::move(note);
    return e;
}

// "XLPK" — the first four bytes WaveformMipmap::saveToFile writes. A file that
// merely happens to be called *.xlpeak is not ours to delete.
bool hasPeakMagic(const fs::path& p)
{
    std::ifstream in(p, std::ios::binary);
    char magic[4] = {};
    in.read(magic, 4);
    return in.gcount() == 4 && std::string_view(magic, 4) == "XLPK";
}

// "<name>.xlpeak.<uuid>.tmp" — WaveformMipmap::saveToFile's private sibling.
bool isPeakTempName(std::string_view name)
{
    if (!endsWith(name, ".tmp")) return false;
    const auto marker = name.rfind(".xlpeak.");
    if (marker == std::string_view::npos || marker == 0) return false;
    const std::string_view uuid =
        name.substr(marker + 8, name.size() - marker - 8 - 4);   // between marker and ".tmp"
    if (uuid.size() != 36) return false;
    return std::all_of(uuid.begin(), uuid.end(), [](unsigned char c) {
        return std::isxdigit(c) != 0 || c == '-';
    });
}

// "bake_<16 hex>.xbk.part" — SlotBakeCache's write-then-rename temp.
bool isBakePartName(std::string_view name)
{
    if (!startsWith(name, "bake_") || !endsWith(name, ".xbk.part")) return false;
    const std::string_view hex = name.substr(5, name.size() - 5 - 9);
    return hex.size() == 16 && std::all_of(hex.begin(), hex.end(),
        [](unsigned char c) { return std::isxdigit(c) != 0; });
}

// The project as the registry sees it: which sources/regions exist and whether
// the media each proxy is rebuilt from is on disk right now.
struct ProjectView {
    // owner stem → is at least one source with that stem online?
    std::unordered_map<std::string, bool> stemOnline;
    // regionId → can its proxy be rebuilt (region's INPUT media exists)?
    std::unordered_map<int, bool> regionRebuildable;
    // Every audio file the project references (peak caches live beside these).
    std::vector<fs::path> audioFiles;
};

ProjectView viewOf(const Timeline& tl)
{
    ProjectView v;
    std::set<std::string> audioSeen;
    auto addAudio = [&](const std::string& utf8) {
        if (utf8.empty()) return;
        const fs::path p = fromUtf8(utf8);
        if (audioSeen.insert(pathKey(p)).second) v.audioFiles.push_back(p);
    };

    std::unordered_map<int, const SourceMedia*> sourceById;
    for (const SourceMedia* s : tl.getAllSources()) {
        if (!s) continue;
        sourceById[s->id] = s;
        const bool online = existsFileUtf8(s->filePath);
        std::unordered_set<std::string> stems;
        addOwnerStems(s->filePath, stems);
        for (const std::string& st : stems) {
            auto& slot = v.stemOnline[st];
            slot = slot || online;
        }
        addAudio(s->filePath);
    }

    for (const SampleRegion* r : tl.getAllRegions()) {
        if (!r) continue;
        // Same input rule as maybeEnqueueRegionProxy: a swapped region is rebuilt
        // from the swap file, otherwise from its source.
        bool rebuildable = false;
        if (r->hasSwappedVideo && !r->swappedVideoPath.empty()) {
            rebuildable = existsFileUtf8(r->swappedVideoPath);
        } else if (auto it = sourceById.find(r->sourceId); it != sourceById.end()) {
            rebuildable = existsFileUtf8(it->second->filePath);
        }
        v.regionRebuildable[r->id] = rebuildable;

        addAudio(r->audioFilePath);
        addAudio(r->swappedAudioPath);
        for (const SampleSlot& slot : r->slots)
            addAudio(slot.audioFilePath);
    }
    return v;
}

// ── proxies/ ─────────────────────────────────────────────────────────────────

struct ProxyName {
    enum Kind { None, Region, SourcePreview, Poster } kind = None;
    int         regionId = -1;
    std::string stem;        // SourcePreview / Poster owner
    std::string altStem;     // Poster: owner if this is really a "<stem>.t<bucket>" thumbnail
};

ProxyName parseProxyName(const std::string& name)
{
    ProxyName out;

    // <regionId>.h264.mov | <regionId>.mxf
    for (const char* ext : { ".h264.mov", ".mxf" }) {
        if (endsWith(name, ext)) {
            const std::string_view id = std::string_view(name).substr(0, name.size() - std::string_view(ext).size());
            if (allDigits(id) && id.size() < 10) {
                out.kind     = ProxyName::Region;
                out.regionId = std::stoi(std::string(id));
                return out;
            }
        }
    }

    // <stem>.preview.<H>p[10][.h264].mov
    if (endsWith(name, ".mov")) {
        std::string_view body = std::string_view(name).substr(0, name.size() - 4);
        if (endsWith(body, ".h264")) body.remove_suffix(5);
        const auto marker = body.rfind(".preview.");
        if (marker != std::string_view::npos && marker > 0) {
            std::string_view tail = body.substr(marker + 9);       // "<H>p" or "<H>p10"
            const auto p = tail.find('p');
            if (p != std::string_view::npos && p > 0 && allDigits(tail.substr(0, p))) {
                const std::string_view depth = tail.substr(p + 1);
                if (depth.empty() || depth == "10") {
                    out.kind = ProxyName::SourcePreview;
                    out.stem = std::string(body.substr(0, marker));
                    return out;
                }
            }
        }
    }

    // <stem>.xlposter.jpg  or  <stem>.t<bucket>.xlposter.jpg
    if (endsWith(name, ".xlposter.jpg")) {
        const std::string_view base = std::string_view(name).substr(0, name.size() - 13);
        if (!base.empty()) {
            out.kind = ProxyName::Poster;
            out.stem = std::string(base);
            const auto t = base.rfind(".t");
            if (t != std::string_view::npos && t > 0 && allDigits(base.substr(t + 2)))
                out.altStem = std::string(base.substr(0, t));
            return out;
        }
    }
    return out;
}

void scanProxies(const RegenLayout& layout, const ProjectView& view, RegenScan& scan)
{
    forEachFile(layout.proxiesDir, [&](const fs::path& p, std::uint64_t bytes) {
        const std::string name = toUtf8(p.filename());
        const ProxyName pn = parseProxyName(name);

        switch (pn.kind) {
        case ProxyName::Region: {
            auto it = view.regionRebuildable.find(pn.regionId);
            if (it == view.regionRebuildable.end()) {
                scan.entries.push_back(makeEntry(p, bytes, RegenCategory::Proxy, RegenClass::Orphan,
                    "its region is no longer in the project"));
            } else if (it->second) {
                scan.entries.push_back(makeEntry(p, bytes, RegenCategory::Proxy, RegenClass::Regenerable));
            } else {
                scan.entries.push_back(makeEntry(p, bytes, RegenCategory::Proxy, RegenClass::Retained,
                    "its source video is offline, so this is the only copy of these frames"));
            }
            break;
        }
        case ProxyName::SourcePreview:
        case ProxyName::Poster: {
            const RegenCategory cat = pn.kind == ProxyName::Poster
                                    ? RegenCategory::Thumbnail : RegenCategory::Proxy;
            const std::string what  = pn.kind == ProxyName::Poster ? "thumbnail" : "proxy";
            const std::string* owners[2] = { &pn.stem, pn.altStem.empty() ? nullptr : &pn.altStem };

            bool owned = false, online = false;
            for (const std::string* o : owners) {
                if (!o) continue;
                if (auto it = view.stemOnline.find(*o); it != view.stemOnline.end()) {
                    owned  = true;
                    online = online || it->second;
                }
            }
            if (!owned) {
                scan.entries.push_back(makeEntry(p, bytes, cat, RegenClass::Orphan,
                    "its source is no longer in the project"));
            } else if (online) {
                scan.entries.push_back(makeEntry(p, bytes, cat, RegenClass::Regenerable));
            } else {
                scan.entries.push_back(makeEntry(p, bytes, cat, RegenClass::Retained,
                    "its source media is offline, so this " + what + " cannot be rebuilt"));
            }
            break;
        }
        case ProxyName::None:
            break;   // unrecognised: never touched
        }
    });
}

// ── *.xlpeak ─────────────────────────────────────────────────────────────────

void scanPeaks(const RegenLayout& layout, const ProjectView& view, RegenScan& scan)
{
    std::set<std::string> seen;
    auto consider = [&](const fs::path& peak, std::uint64_t bytes) {
        if (!seen.insert(pathKey(peak)).second) return;
        if (!hasPeakMagic(peak)) return;                       // not ours
        fs::path audio = peak;
        audio.replace_extension();                              // strip ".xlpeak"
        if (existsFile(audio))
            scan.entries.push_back(makeEntry(peak, bytes, RegenCategory::PeakCache, RegenClass::Regenerable));
        else
            scan.entries.push_back(makeEntry(peak, bytes, RegenCategory::PeakCache, RegenClass::Orphan,
                "the audio file it describes no longer exists"));
    };

    // (1) the exact peak file of every audio file the project references —
    //     including ones outside the project folder. Exact names only: this never
    //     globs a folder the user owns.
    for (const fs::path& audio : view.audioFiles) {
        fs::path peak = audio;
        peak += ".xlpeak";
        std::error_code ec;
        if (!fs::is_regular_file(peak, ec)) continue;
        std::error_code sec;
        const std::uintmax_t bytes = fs::file_size(peak, sec);
        consider(peak, sec ? 0 : static_cast<std::uint64_t>(bytes));
    }
    // (2) any peak file in the project's own asset folders (audio files that were
    //     since removed from the project leave theirs behind).
    for (const fs::path& dir : { layout.projectDir, layout.mediaDir, layout.swappedDir,
                                 layout.exportsDir, layout.slotsDir }) {
        forEachFile(dir, [&](const fs::path& p, std::uint64_t bytes) {
            if (p.extension() == ".xlpeak") consider(p, bytes);
        });
    }
}

// ── partial outputs ──────────────────────────────────────────────────────────

void scanPartials(const RegenLayout& layout, const ProjectView* view, RegenScan& scan)
{
    // One file can be reached from two folders (an audio file kept in the media
    // dir is also a "referenced audio file's parent"); list it once.
    std::set<std::string> partialSeen;
    auto addPartial = [&](const fs::path& p, std::uint64_t bytes) {
        if (partialSeen.insert(pathKey(p)).second)
            scan.entries.push_back(makeEntry(p, bytes, RegenCategory::Partial, RegenClass::Partial,
                "left by an interrupted job"));
    };

    // Proxy/poster writers: <target>.tmp beside the target.
    forEachFile(layout.proxiesDir, [&](const fs::path& p, std::uint64_t bytes) {
        if (p.extension() == ".tmp") addPartial(p, bytes);
    });
    // Slot-bake writer: <bake>.xbk.part.
    forEachFile(layout.audioCacheDir, [&](const fs::path& p, std::uint64_t bytes) {
        if (isBakePartName(toUtf8(p.filename()))) addPartial(p, bytes);
    });
    // Peak writer: <audio>.xlpeak.<uuid>.tmp beside the audio it describes.
    std::set<std::string> dirsSeen;
    std::vector<fs::path> dirs;
    auto addDir = [&](const fs::path& d) {
        if (!d.empty() && dirsSeen.insert(pathKey(d)).second) dirs.push_back(d);
    };
    for (const fs::path& d : { layout.projectDir, layout.mediaDir, layout.swappedDir,
                               layout.exportsDir, layout.slotsDir })
        addDir(d);
    if (view)
        for (const fs::path& audio : view->audioFiles)
            addDir(audio.parent_path());
    for (const fs::path& d : dirs) {
        forEachFile(d, [&](const fs::path& p, std::uint64_t bytes) {
            if (isPeakTempName(toUtf8(p.filename()))) addPartial(p, bytes);
        });
    }
}

} // namespace

// ═════════════════════════════════════════════════════════════════════════════
//  Public API
// ═════════════════════════════════════════════════════════════════════════════

const char* regenCategoryId(RegenCategory c)
{
    switch (c) {
    case RegenCategory::Proxy:     return "proxies";
    case RegenCategory::Thumbnail: return "thumbnails";
    case RegenCategory::PeakCache: return "peaks";
    case RegenCategory::Partial:   return "partials";
    default:                       return "unknown";
    }
}

const char* regenCategoryLabel(RegenCategory c)
{
    switch (c) {
    case RegenCategory::Proxy:     return "Video proxies";
    case RegenCategory::Thumbnail: return "Preview thumbnails";
    case RegenCategory::PeakCache: return "Waveform peak caches";
    case RegenCategory::Partial:   return "Unfinished files from interrupted jobs";
    default:                       return "Other";
    }
}

RegenLayout RegenLayout::forProjectDir(const std::string& utf8ProjectDir)
{
    RegenLayout l;
    if (utf8ProjectDir.empty()) return l;
    l.projectDir    = fromUtf8(utf8ProjectDir);
    l.proxiesDir    = l.projectDir / "proxies";
    l.mediaDir      = l.projectDir / "media";
    l.swappedDir    = l.projectDir / "swapped";
    l.exportsDir    = l.projectDir / "exports";
    l.slotsDir      = l.projectDir / "slots";
    l.audioCacheDir = l.projectDir / "cache" / "audio";
    return l;
}

bool RegenLayout::looksLikeProject() const
{
    if (!valid()) return false;
    std::error_code ec;
    return fs::is_regular_file(projectDir / "project.json", ec);
}

bool isSameFolder(const std::string& utf8A, const std::string& utf8B)
{
    if (utf8A.empty() || utf8B.empty()) return false;
    std::error_code ec;
    const bool same = fs::equivalent(fromUtf8(utf8A), fromUtf8(utf8B), ec);
    return !ec && same;
}

RegenScan scanRegenerable(const RegenLayout& layout, const Timeline& timeline, bool partialsOnly)
{
    RegenScan scan;
    if (!layout.looksLikeProject()) return scan;

    const ProjectView view = viewOf(timeline);
    if (!partialsOnly) {
        scanProxies(layout, view, scan);
        scanPeaks(layout, view, scan);
    }
    scanPartials(layout, &view, scan);
    return scan;
}

bool regenInScope(const RegenEntry& e, RegenScope scope, bool includePartials)
{
    switch (e.cls) {
    case RegenClass::Retained:
        return false;                                   // never, under any scope
    case RegenClass::Partial:
        return includePartials;                         // every scope sweeps them
    case RegenClass::Orphan:
        return scope != RegenScope::PartialsOnly;
    case RegenClass::Regenerable:
        return scope == RegenScope::Purge;
    }
    return false;
}

RegenSummary summarizeRegenerable(const RegenScan& scan, RegenScope scope, bool includePartials)
{
    RegenSummary s;
    for (const RegenEntry& e : scan.entries) {
        if (!regenInScope(e, scope, includePartials)) continue;
        RegenTotals& t = s.perCategory[static_cast<int>(e.category)];
        ++t.files;   t.bytes   += e.bytes;
        ++s.total.files; s.total.bytes += e.bytes;
    }
    return s;
}

RegenTotals retainedTotals(const RegenScan& scan)
{
    RegenTotals t;
    for (const RegenEntry& e : scan.entries)
        if (e.cls == RegenClass::Retained) { ++t.files; t.bytes += e.bytes; }
    return t;
}

RegenResult removeRegenerable(const RegenScan& scan, RegenScope scope, bool includePartials)
{
    RegenResult r;
    for (const RegenEntry& e : scan.entries) {
        if (!regenInScope(e, scope, includePartials)) continue;

        std::error_code ec;
        const bool removed = fs::remove(e.path, ec);
        if (ec) {
            // Almost always a sharing violation: a decoder or a live writer has
            // it open. Leave it; the next open/cleanup gets it.
            ++r.failed;
            r.failedBytes += e.bytes;
            std::cout << "[Regen] could not delete " << e.displayName
                      << " (" << ec.message() << ") — left in place\n";
            continue;
        }
        if (!removed) continue;                         // already gone
        if (e.cls == RegenClass::Partial)
            std::cout << "[Regen] removed partial output " << e.displayName
                      << " (" << formatByteCount(e.bytes) << ")\n";

        RegenTotals& t = r.removed.perCategory[static_cast<int>(e.category)];
        ++t.files;   t.bytes   += e.bytes;
        ++r.removed.total.files; r.removed.total.bytes += e.bytes;
    }
    return r;
}

RegenResult sweepPartialFiles(const RegenLayout& layout, const Timeline& timeline)
{
    const RegenScan scan = scanRegenerable(layout, timeline, /*partialsOnly=*/true);
    return removeRegenerable(scan, RegenScope::PartialsOnly);
}

std::string formatByteCount(std::uint64_t bytes)
{
    char buf[32];
    const double b = static_cast<double>(bytes);
    if (bytes >= (1ull << 30))      std::snprintf(buf, sizeof(buf), "%.2f GB", b / (1ull << 30));
    else if (bytes >= (1ull << 20)) std::snprintf(buf, sizeof(buf), "%.1f MB", b / (1ull << 20));
    else if (bytes >= (1ull << 10)) std::snprintf(buf, sizeof(buf), "%.0f KB", b / (1ull << 10));
    else                            std::snprintf(buf, sizeof(buf), "%llu B", static_cast<unsigned long long>(bytes));
    return buf;
}

} // namespace xleth::project
