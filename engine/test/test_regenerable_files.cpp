// test_regenerable_files.cpp — the regenerable-file registry's safety contract.
// Build: see engine/CMakeLists.txt target "test_regenerable_files"
// Pass:  prints "ALL TESTS PASSED" and exits 0
//
// What this pins (each is a way the feature could destroy user data):
//   • only recognised files are ever deleted — source media, project.json,
//     the PREP bake cache and unrecognised files in the same folders survive
//   • a proxy/peak whose INPUT is missing (offline media) is Retained: no scope
//     deletes it, because it is the only copy of those pixels
//   • Cleanup (project stays open) removes only Orphan + Partial; live files stay
//   • Purge (project closing) additionally removes Regenerable
//   • the .tmp sweep touches only .tmp-class files
//   • non-ASCII source names are still recognised as owned, never as orphans

#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "model/SampleRegion.h"
#include "project/RegenerableFiles.h"

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <string>

namespace fs = std::filesystem;
using namespace xleth::project;

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (cond) { ++g_passed; }                                              \
        else { std::cerr << "  FAIL [line " << __LINE__ << "] " << msg << "\n"; ++g_failed; } \
    } while (0)

static void touch(const fs::path& p, std::size_t bytes = 100, const char* prefix = "")
{
    fs::create_directories(p.parent_path());
    std::ofstream out(p, std::ios::binary);
    std::string data(prefix);
    data.resize(bytes, 'x');
    out.write(data.data(), static_cast<std::streamsize>(data.size()));
}

static bool has(const fs::path& p) { return fs::is_regular_file(p); }

static std::string u8(const fs::path& p)
{
    const std::u8string s = p.u8string();
    return std::string(reinterpret_cast<const char*>(s.data()), s.size());
}

// A peak file the registry accepts: it checks the "XLPK" magic.
static void touchPeak(const fs::path& p, std::size_t bytes = 200) { touch(p, bytes, "XLPK"); }

struct Fixture {
    fs::path root, project, external;
    fs::path vidOnline, vidOffline, uniSrc, swapFile, extAudio;
    int idOnline = 0, idOffline = 0, idUni = 0;
    int regOnline = 0, regOffline = 0, regSwapped = 0;
    Timeline tl;

    Fixture()
    {
        root     = fs::temp_directory_path() / "xleth_test_regenerable";
        fs::remove_all(root);
        project  = root / "Proj";
        external = root / "external";
        fs::create_directories(project / "proxies");
        fs::create_directories(project / "cache" / "audio");
        fs::create_directories(external);

        vidOnline  = external / "vid.mp4";                 touch(vidOnline, 1000);
        vidOffline = external / "gone.mp4";                // deliberately NOT created
        uniSrc     = external / fs::path(u8"BFDIA 7： Intruder Alert.mp4");
        touch(uniSrc, 1000);
        swapFile   = project / "swapped" / "swap.mov";     touch(swapFile, 500);
        extAudio   = external / "ext.wav";                 touch(extAudio, 400);

        auto mkSource = [&](const fs::path& p) {
            SourceMedia s;
            s.filePath = u8(p);
            s.hasVideo = true;
            return tl.addSource(s);
        };
        idOnline  = mkSource(vidOnline);
        idOffline = mkSource(vidOffline);
        idUni     = mkSource(uniSrc);

        auto mkRegion = [&](int sourceId) {
            SampleRegion r;
            r.sourceId = sourceId;
            r.startTime = 0.0; r.endTime = 1.0;
            return tl.addRegion(r);
        };
        regOnline  = mkRegion(idOnline);
        regOffline = mkRegion(idOffline);
        // A swapped region on an OFFLINE source: rebuilt from the swap file, so
        // its proxy is regenerable even though the original source is gone.
        SampleRegion sw;
        sw.sourceId = idOffline; sw.endTime = 1.0;
        sw.hasSwappedVideo = true; sw.swappedVideoPath = u8(swapFile);
        regSwapped = tl.addRegion(sw);

        // Audio the project references from OUTSIDE its folder.
        SampleRegion ar;
        ar.sourceId = idOnline; ar.endTime = 1.0;
        ar.audioFilePath = u8(extAudio);
        tl.addRegion(ar);

        populate();
    }

    fs::path px(const char8_t* n) const { return project / "proxies" / fs::path(n); }

    void populate()
    {
        const fs::path P = project / "proxies";
        // Whole-source proxies + thumbnails for the ONLINE source.
        touch(P / "vid.preview.720p.h264.mov", 5000);
        touch(P / "vid.preview.720p.mov",      9000);       // legacy intra
        touch(P / "vid.preview.720p10.mov",    7000);       // 10-bit render proxy
        touch(P / "vid.xlposter.jpg",          300);
        touch(P / "vid.t5.xlposter.jpg",       310);
        // ... for the OFFLINE source: not rebuildable ⇒ Retained.
        touch(P / "gone.preview.720p.h264.mov", 4000);
        touch(P / "gone.xlposter.jpg",          250);
        // ... for a source that is no longer in the project ⇒ Orphan.
        touch(P / "removed.preview.720p.h264.mov", 6000);
        touch(P / "removed.t9.xlposter.jpg",       280);
        // Non-ASCII source name: must be recognised as OWNED.
        touch(px(u8"BFDIA 7： Intruder Alert.preview.720p.h264.mov"), 3000);
        touch(px(u8"BFDIA 7： Intruder Alert.xlposter.jpg"),          260);
        // Region proxies.
        touch(P / (std::to_string(regOnline)  + ".h264.mov"), 2000);
        touch(P / (std::to_string(regOnline)  + ".mxf"),      2500);
        touch(P / (std::to_string(regOffline) + ".h264.mov"), 2100);   // Retained
        touch(P / (std::to_string(regSwapped) + ".h264.mov"), 2200);   // swap file exists
        touch(P / "999.mxf",                                  2300);   // no such region
        // Partial outputs of interrupted jobs.
        touch(P / "vid.preview.720p.h264.mov.tmp", 8000);
        touch(P / "7.h264.mov.tmp",                1500);
        // Things the registry must NEVER touch.
        touch(P / "notes.txt",        50);
        touch(P / "readme.mov",       50);
        touch(P / "vid.mp4.bak",      50);
        touch(P / "12.preview.mov",   50);       // not a recognised proxy name
        touch(project / "project.json", 600);

        // Peak caches.
        touchPeak(project / "media" / "a.wav.xlpeak");   touch(project / "media" / "a.wav", 300);
        touchPeak(project / "media" / "b.wav.xlpeak");                                      // audio gone
        touch(project / "media" / "c.wav.xlpeak", 90);   touch(project / "media" / "c.wav", 300); // wrong magic
        touchPeak(fs::path(u8(extAudio) + ".xlpeak"));                                      // referenced, external
        touchPeak(external / "other.wav.xlpeak");        touch(external / "other.wav", 300); // NOT referenced
        // Peak temps.
        touch(project / "media" / "a.wav.xlpeak.0123abcd-4567-89ab-cdef-0123456789ab.tmp", 120);
        touch(fs::path(u8(extAudio) + ".xlpeak.aaaabbbb-cccc-dddd-eeee-ffff00001111.tmp"), 130);
        touch(external / "unrelated.tmp", 70);           // someone else's .tmp — not ours
        touch(project / "media" / "x.xlpeak.notauuid.tmp", 70);   // pattern must be exact

        // Bake cache: only the half-written .part is ours to sweep.
        touch(project / "cache" / "audio" / "bake_0123456789abcdef.xbk",      4000);
        touch(project / "cache" / "audio" / "bake_0123456789abcdef.xbk.part", 1000);
        touch(project / "cache" / "audio" / "bake_zzzz.xbk.part",             10);   // bad name
    }

    RegenLayout layout() const { return RegenLayout::forProjectDir(u8(project)); }
    ~Fixture() { std::error_code ec; fs::remove_all(root, ec); }
};

static std::map<std::string, RegenClass> classify(const RegenScan& scan)
{
    std::map<std::string, RegenClass> m;
    for (const RegenEntry& e : scan.entries) m[e.displayName] = e.cls;
    return m;
}

static void protectedFilesSurvive(const Fixture& f, const char* when)
{
    const std::string w = when;
    CHECK(has(f.vidOnline),                         w << ": source media survives");
    CHECK(has(f.uniSrc),                            w << ": non-ASCII source media survives");
    CHECK(has(f.swapFile),                          w << ": swapped video survives");
    CHECK(has(f.extAudio),                          w << ": external audio survives");
    CHECK(has(f.project / "project.json"),          w << ": project.json survives");
    CHECK(has(f.project / "proxies" / "notes.txt"), w << ": unrecognised file survives");
    CHECK(has(f.project / "proxies" / "readme.mov"),    w << ": readme.mov survives");
    CHECK(has(f.project / "proxies" / "vid.mp4.bak"),   w << ": vid.mp4.bak survives");
    CHECK(has(f.project / "proxies" / "12.preview.mov"),w << ": 12.preview.mov survives");
    CHECK(has(f.project / "media" / "a.wav"),       w << ": project audio survives");
    CHECK(has(f.project / "cache" / "audio" / "bake_0123456789abcdef.xbk"), w << ": PREP bake survives");
    CHECK(has(f.external / "unrelated.tmp"),        w << ": a foreign .tmp survives");
    CHECK(has(f.project / "media" / "x.xlpeak.notauuid.tmp"), w << ": near-miss peak temp survives");
    CHECK(has(f.project / "cache" / "audio" / "bake_zzzz.xbk.part"), w << ": near-miss bake part survives");
    CHECK(has(f.project / "media" / "c.wav.xlpeak"),w << ": a *.xlpeak without the XLPK magic survives");
    CHECK(has(f.external / "other.wav.xlpeak"),     w << ": a peak of an UNREFERENCED external file survives");
    // Retained: offline-media proxies are the only copy — no scope may delete them.
    CHECK(has(f.project / "proxies" / "gone.preview.720p.h264.mov"), w << ": offline-source proxy retained");
    CHECK(has(f.project / "proxies" / "gone.xlposter.jpg"),          w << ": offline-source thumbnail retained");
    CHECK(has(f.project / "proxies" / (std::to_string(f.regOffline) + ".h264.mov")), w << ": offline region proxy retained");
}

int main()
{
    // ── [1] classification ───────────────────────────────────────────────────
    std::cout << "\n[1] classification\n";
    {
        Fixture f;
        const RegenScan scan = scanRegenerable(f.layout(), f.tl);
        const auto c = classify(scan);
        auto is = [&](const std::string& name, RegenClass want) {
            auto it = c.find(name);
            return it != c.end() && it->second == want;
        };
        CHECK(is("vid.preview.720p.h264.mov", RegenClass::Regenerable), "online H.264 source proxy is Regenerable");
        CHECK(is("vid.preview.720p.mov",      RegenClass::Regenerable), "online legacy intra proxy is Regenerable");
        CHECK(is("vid.preview.720p10.mov",    RegenClass::Regenerable), "online 10-bit render proxy is Regenerable");
        CHECK(is("vid.xlposter.jpg",          RegenClass::Regenerable), "poster is Regenerable");
        CHECK(is("vid.t5.xlposter.jpg",       RegenClass::Regenerable), "per-offset thumbnail resolves to its source");
        CHECK(is("gone.preview.720p.h264.mov",RegenClass::Retained),    "offline-source proxy is Retained");
        CHECK(is("gone.xlposter.jpg",         RegenClass::Retained),    "offline-source poster is Retained");
        CHECK(is("removed.preview.720p.h264.mov", RegenClass::Orphan),  "proxy of a removed source is Orphan");
        CHECK(is("removed.t9.xlposter.jpg",   RegenClass::Orphan),      "thumbnail of a removed source is Orphan");
        CHECK(is(u8(fs::path(u8"BFDIA 7： Intruder Alert.preview.720p.h264.mov")), RegenClass::Regenerable),
              "non-ASCII source name is OWNED, not orphaned");
        CHECK(is(u8(fs::path(u8"BFDIA 7： Intruder Alert.xlposter.jpg")), RegenClass::Regenerable),
              "non-ASCII poster is OWNED, not orphaned");
        CHECK(is(std::to_string(f.regOnline) + ".h264.mov", RegenClass::Regenerable), "online region proxy Regenerable");
        CHECK(is(std::to_string(f.regOnline) + ".mxf",      RegenClass::Regenerable), "legacy .mxf region proxy Regenerable");
        CHECK(is(std::to_string(f.regOffline) + ".h264.mov",RegenClass::Retained),    "offline region proxy Retained");
        CHECK(is(std::to_string(f.regSwapped) + ".h264.mov",RegenClass::Regenerable), "swapped region rebuilds from the swap file");
        CHECK(is("999.mxf",                   RegenClass::Orphan),      "proxy of a removed region is Orphan");
        CHECK(is("vid.preview.720p.h264.mov.tmp", RegenClass::Partial), "proxy .tmp is Partial");
        CHECK(is("7.h264.mov.tmp",            RegenClass::Partial),     "region .tmp is Partial");
        CHECK(is("a.wav.xlpeak",              RegenClass::Regenerable), "peak of an existing audio file is Regenerable");
        CHECK(is("b.wav.xlpeak",              RegenClass::Orphan),      "peak of a vanished audio file is Orphan");
        CHECK(is("ext.wav.xlpeak",            RegenClass::Regenerable), "peak beside a referenced EXTERNAL audio file is found");
        CHECK(is("a.wav.xlpeak.0123abcd-4567-89ab-cdef-0123456789ab.tmp", RegenClass::Partial), "peak temp in media/ is Partial");
        CHECK(is("ext.wav.xlpeak.aaaabbbb-cccc-dddd-eeee-ffff00001111.tmp", RegenClass::Partial), "peak temp beside external audio is Partial");
        CHECK(is("bake_0123456789abcdef.xbk.part", RegenClass::Partial), "half-written bake is Partial");
        CHECK(c.find("bake_0123456789abcdef.xbk") == c.end(), "a finished PREP bake is not in the registry");
        CHECK(c.find("notes.txt") == c.end() && c.find("readme.mov") == c.end()
              && c.find("project.json") == c.end() && c.find("12.preview.mov") == c.end(),
              "unrecognised files are not in the registry at all");
        CHECK(c.find("c.wav.xlpeak") == c.end(), "wrong-magic .xlpeak is not in the registry");
        CHECK(c.find("other.wav.xlpeak") == c.end(), "peak of an unreferenced external file is not in the registry");
        CHECK(c.find("unrelated.tmp") == c.end(), "a foreign .tmp outside proxies/ is not in the registry");
    }

    // ── [2] Cleanup scope: only Orphan + Partial ─────────────────────────────
    std::cout << "\n[2] Cleanup (project stays open)\n";
    {
        Fixture f;
        const RegenScan scan = scanRegenerable(f.layout(), f.tl);
        const RegenSummary would = summarizeRegenerable(scan, RegenScope::Cleanup);
        const RegenResult r = removeRegenerable(scan, RegenScope::Cleanup);
        CHECK(r.failed == 0, "nothing failed to delete");
        CHECK(r.removed.total.files == would.total.files && r.removed.total.bytes == would.total.bytes,
              "the dry-run summary equals what was actually deleted");

        // Orphans gone.
        CHECK(!has(f.project / "proxies" / "removed.preview.720p.h264.mov"), "orphan proxy deleted");
        CHECK(!has(f.project / "proxies" / "removed.t9.xlposter.jpg"),       "orphan thumbnail deleted");
        CHECK(!has(f.project / "proxies" / "999.mxf"),                       "orphan region proxy deleted");
        CHECK(!has(f.project / "media" / "b.wav.xlpeak"),                    "orphan peak deleted");
        // Partials gone.
        CHECK(!has(f.project / "proxies" / "vid.preview.720p.h264.mov.tmp"), "partial deleted");
        CHECK(!has(f.project / "proxies" / "7.h264.mov.tmp"),                "region partial deleted");
        CHECK(!has(f.project / "cache" / "audio" / "bake_0123456789abcdef.xbk.part"), "bake .part deleted");
        CHECK(!has(f.project / "media" / "a.wav.xlpeak.0123abcd-4567-89ab-cdef-0123456789ab.tmp"), "peak temp deleted");
        // LIVE files untouched by Cleanup.
        CHECK(has(f.project / "proxies" / "vid.preview.720p.h264.mov"), "live proxy kept by Cleanup");
        CHECK(has(f.project / "proxies" / "vid.preview.720p.mov"),      "live legacy proxy kept by Cleanup");
        CHECK(has(f.project / "proxies" / "vid.xlposter.jpg"),          "live poster kept by Cleanup");
        CHECK(has(f.project / "proxies" / (std::to_string(f.regOnline) + ".h264.mov")), "live region proxy kept by Cleanup");
        CHECK(has(f.project / "media" / "a.wav.xlpeak"),                "live peak kept by Cleanup");
        protectedFilesSurvive(f, "after Cleanup");
    }

    // ── [3] Cleanup with a job running: partials are left to the job ─────────
    std::cout << "\n[3] includePartials=false\n";
    {
        Fixture f;
        const RegenScan scan = scanRegenerable(f.layout(), f.tl);
        removeRegenerable(scan, RegenScope::Cleanup, /*includePartials=*/false);
        CHECK(has(f.project / "proxies" / "vid.preview.720p.h264.mov.tmp"), "a running job's .tmp is not deleted");
        CHECK(!has(f.project / "proxies" / "999.mxf"), "orphans are still deleted");
    }

    // ── [4] Purge scope: + Regenerable, still never Retained ─────────────────
    std::cout << "\n[4] Purge (project closing)\n";
    {
        Fixture f;
        const RegenScan scan = scanRegenerable(f.layout(), f.tl);
        const RegenSummary would = summarizeRegenerable(scan, RegenScope::Purge);
        const RegenResult r = removeRegenerable(scan, RegenScope::Purge);
        CHECK(r.failed == 0, "nothing failed to delete");
        CHECK(r.removed.total.files == would.total.files && r.removed.total.bytes == would.total.bytes,
              "purge summary equals what was deleted");
        CHECK(r.removed.total.bytes > 0, "space was freed");

        CHECK(!has(f.project / "proxies" / "vid.preview.720p.h264.mov"), "purged: proxy");
        CHECK(!has(f.project / "proxies" / "vid.preview.720p.mov"),      "purged: legacy proxy");
        CHECK(!has(f.project / "proxies" / "vid.preview.720p10.mov"),    "purged: 10-bit proxy");
        CHECK(!has(f.project / "proxies" / "vid.xlposter.jpg"),          "purged: poster");
        CHECK(!has(f.project / "proxies" / "vid.t5.xlposter.jpg"),       "purged: thumbnail");
        CHECK(!has(f.px(u8"BFDIA 7： Intruder Alert.preview.720p.h264.mov")), "purged: non-ASCII proxy");
        CHECK(!has(f.project / "proxies" / (std::to_string(f.regOnline) + ".h264.mov")), "purged: region proxy");
        CHECK(!has(f.project / "proxies" / (std::to_string(f.regOnline) + ".mxf")),      "purged: legacy region proxy");
        CHECK(!has(f.project / "proxies" / (std::to_string(f.regSwapped) + ".h264.mov")),"purged: swapped region proxy");
        CHECK(!has(f.project / "media" / "a.wav.xlpeak"),                "purged: peak");
        CHECK(!has(fs::path(u8(f.extAudio) + ".xlpeak")),                "purged: peak beside external audio");
        protectedFilesSurvive(f, "after Purge");

        // Idempotent: a second purge (e.g. quit right after a switch) finds nothing.
        const RegenScan again = scanRegenerable(f.layout(), f.tl);
        const RegenResult r2 = removeRegenerable(again, RegenScope::Purge);
        CHECK(r2.removed.total.files == 0 && r2.failed == 0, "second purge is a no-op");
        protectedFilesSurvive(f, "after 2nd Purge");
    }

    // ── [5] on-open sweep: .tmp only ─────────────────────────────────────────
    std::cout << "\n[5] sweepPartialFiles (project open)\n";
    {
        Fixture f;
        const RegenResult r = sweepPartialFiles(f.layout(), f.tl);
        CHECK(r.removed.total.files == 5, "swept exactly the five partials (got " << r.removed.total.files << ")");
        CHECK(r.removed.perCategory[static_cast<int>(RegenCategory::Partial)].files == 5, "all counted as Partial");
        CHECK(has(f.project / "proxies" / "vid.preview.720p.h264.mov"), "live proxy untouched by the sweep");
        CHECK(has(f.project / "proxies" / "999.mxf"),                   "orphan untouched by the sweep");
        CHECK(has(f.project / "media" / "a.wav.xlpeak"),                "live peak untouched by the sweep");
        protectedFilesSurvive(f, "after sweep");
    }

    // ── [6] robustness ───────────────────────────────────────────────────────
    std::cout << "\n[6] robustness\n";
    {
        Timeline empty;
        const RegenScan none = scanRegenerable(RegenLayout::forProjectDir(""), empty);
        CHECK(none.entries.empty(), "an empty layout (untitled project) scans nothing");
        const RegenScan missing = scanRegenerable(
            RegenLayout::forProjectDir((fs::temp_directory_path() / "xleth_no_such_project_dir").string()), empty);
        CHECK(missing.entries.empty(), "a project folder that does not exist scans nothing");
        CHECK(formatByteCount(0) == "0 B", "format 0");
        CHECK(formatByteCount(1536) == "2 KB", "format KB");
        CHECK(formatByteCount(5ull << 20) == "5.0 MB", "format MB");
        CHECK(formatByteCount(3ull << 30) == "3.00 GB", "format GB");
    }

    // ── [7] only ever a real project folder ─────────────────────────────────
    std::cout << "\n[7] project-folder guards\n";
    {
        Fixture f;
        CHECK(f.layout().looksLikeProject(), "a folder holding project.json is a project");
        CHECK(!RegenLayout::forProjectDir("").looksLikeProject(), "an empty path is not");
        CHECK(!RegenLayout::forProjectDir(u8(f.external)).looksLikeProject(), "a plain folder is not");

        // Without project.json the folder is not a project: nothing is scanned,
        // so nothing could be deleted even with every recognised file present.
        fs::remove(f.project / "project.json");
        CHECK(!f.layout().looksLikeProject(), "removing project.json makes it not a project");
        CHECK(scanRegenerable(f.layout(), f.tl).entries.empty(),
              "a folder without project.json is never scanned");
        CHECK(has(f.project / "proxies" / "vid.preview.720p.h264.mov"), "…and its files are untouched");

        CHECK(isSameFolder(u8(f.project), u8(f.project / ".." / "Proj")), "the same folder spelled two ways");
        CHECK(!isSameFolder(u8(f.project), u8(f.external)), "different folders");
        CHECK(!isSameFolder(u8(f.project), u8(f.root / "no_such_folder")), "a folder that does not exist");
        CHECK(!isSameFolder("", u8(f.project)) && !isSameFolder(u8(f.project), ""), "an empty path");

        const fs::path uni = f.root / fs::path(u8"\u041F\u0440\u043E\u0435\u043A\u0442 \uFF1A");   // non-ANSI name
        fs::create_directories(uni);
        CHECK(isSameFolder(u8(uni), u8(uni)), "a non-ANSI folder name compares correctly (UTF-8 decoded)");
    }

    std::cout << "\n" << g_passed << " checks passed, " << g_failed << " failed\n";
    if (g_failed == 0) { std::cout << "ALL TESTS PASSED\n"; return 0; }
    std::cerr << "FAILED\n";
    return 1;
}
