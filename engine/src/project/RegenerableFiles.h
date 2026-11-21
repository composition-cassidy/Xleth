#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

class Timeline;

// ─── RegenerableFiles ─────────────────────────────────────────────────────────
// The ONE registry of files XLETH writes to disk that it can always rebuild.
// Every "delete regenerable files" feature goes through here:
//   • purge-on-close   (Settings → "Delete regenerable files when closing a project")
//   • Clean up project (File menu)
//   • the .tmp sweep that runs on every project open
//
// A file is only ever deleted if this module can PROVE it is disposable. It
// recognises files by exact name pattern and touches nothing else — never source
// media, never project.json, never an unrecognised file in the same folder.
//
// ── The registry ─────────────────────────────────────────────────────────────
//   Category   Lives in                          Pattern                               Rebuilt by
//   Proxy      <proj>/proxies                    <stem>.preview.<H>p[10][.h264].mov    project-open pass / video tick
//                                                <regionId>.h264.mov | <regionId>.mxf  project-open pass / video tick
//   Thumbnail  <proj>/proxies                    <stem>[.t<bucket>].xlposter.jpg       project-open pass (base poster) /
//                                                                                     poster prepass, video tick (per-cell)
//   PeakCache  beside each audio file the        <audio file>.xlpeak  (magic "XLPK")   WaveformMipmapCache, the first
//              project references + <proj>/media|swapped|exports|slots                 time that waveform is drawn
//   Partial    <proj>/proxies                    *.tmp
//              <proj>/cache/audio                bake_<16 hex>.xbk.part
//              audio dirs (as PeakCache)         <audio file>.xlpeak.<uuid>.tmp
//
// Not in the registry, deliberately: the sampler's PREP bakes (<proj>/cache/audio
// /*.xbk). They ARE rebuildable, but a missing bake plays the raw un-stretched
// sample until it re-renders, which is audible — that is a different trade-off
// from the silent ones above and not something a disk-space setting should make.
// (Their half-written `.part` files are Partial and are swept.)
//
// The frame cache (FrameCache / the GPU render cache) is memory-only, so there is
// nothing on disk to purge for it.
//
// ── Classification (why each delete is safe) ─────────────────────────────────
//   Regenerable  the input it is rebuilt from exists RIGHT NOW (the source file,
//                or the swapped-in video for a swapped region; the audio file
//                for a peak cache).
//   Orphan       nothing in the loaded project can ever read it: its source or
//                region is no longer in the project, or (peaks) its audio file
//                is gone — WaveformMipmapCache only opens a .xlpeak when the
//                audio it describes exists, so it is dead weight.
//   Partial      the half-written output of an interrupted job. Every writer
//                emits <name>.tmp and renames on success, so a .tmp is never
//                referenced. A .tmp a live writer holds open is protected by
//                Windows (no FILE_SHARE_DELETE) and simply fails to delete.
//   Retained     looks like a proxy/peak of a project source but its input is
//                MISSING (offline media). It is the only copy of those pixels,
//                so it is not regenerable and is NEVER deleted by any scope.
//
// ── Scopes ───────────────────────────────────────────────────────────────────
//   Purge         Regenerable + Orphan + Partial   (project is closing)
//   Cleanup       Orphan + Partial                 (project stays open: live files
//                                                   are left alone)
//   PartialsOnly  Partial                          (the on-open sweep)
//
// This file has no JUCE / FFmpeg dependency so it builds into the model library
// and is unit-testable without a decoder.

namespace xleth::project {

enum class RegenCategory : int {
    Proxy = 0,
    Thumbnail,
    PeakCache,
    Partial,
    Count
};

constexpr int kRegenCategoryCount = static_cast<int>(RegenCategory::Count);

const char* regenCategoryId(RegenCategory c);      // stable id: "proxies", ...
const char* regenCategoryLabel(RegenCategory c);   // user-facing plural label

enum class RegenClass {
    Regenerable,
    Orphan,
    Partial,
    Retained,
};

enum class RegenScope {
    Purge,
    Cleanup,
    PartialsOnly,
};

struct RegenEntry {
    std::filesystem::path path;          // exact path (Unicode-safe) used to delete
    std::string           displayName;   // UTF-8 file name, for logs and the UI
    RegenCategory         category = RegenCategory::Proxy;
    RegenClass            cls      = RegenClass::Regenerable;
    std::uint64_t         bytes    = 0;
    std::string           note;          // why it is Orphan / Retained
};

// The folders of a project. Mirrors ProjectManager's get*Dir() accessors; kept
// separate so the registry can be pointed at a project that is being CLOSED
// (ProjectManager already points at the next one by then).
struct RegenLayout {
    std::filesystem::path projectDir;
    std::filesystem::path proxiesDir;
    std::filesystem::path mediaDir;
    std::filesystem::path swappedDir;
    std::filesystem::path exportsDir;
    std::filesystem::path slotsDir;
    std::filesystem::path audioCacheDir;

    static RegenLayout forProjectDir(const std::string& utf8ProjectDir);
    bool valid() const { return !projectDir.empty(); }

    // True only if projectDir really holds a project (a project.json). Every
    // destructive entry point requires it, so a folder that merely has the right
    // NAME — or a stale/mistyped path — is never swept.
    bool looksLikeProject() const;
};

// Do two UTF-8 folder paths name the same directory on disk? (std::filesystem's
// narrow overloads misread non-ANSI names on Windows, so both are decoded first.)
// False if either does not exist.
bool isSameFolder(const std::string& utf8A, const std::string& utf8B);

struct RegenTotals {
    int           files = 0;
    std::uint64_t bytes = 0;
};

struct RegenSummary {
    RegenTotals perCategory[kRegenCategoryCount];
    RegenTotals total;
};

struct RegenResult {
    RegenSummary  removed;
    int           failed      = 0;   // present but could not be deleted (in use)
    std::uint64_t failedBytes = 0;
};

struct RegenScan {
    std::vector<RegenEntry> entries;
};

// Walk the project's regenerable folders and classify every recognised file
// against `timeline` (the project as currently loaded). Read-only.
// partialsOnly skips everything but the Partial class (cheaper; used by the
// on-open sweep).
RegenScan scanRegenerable(const RegenLayout& layout, const Timeline& timeline,
                          bool partialsOnly = false);

// Whether `e` is deleted under `scope`. includePartials=false additionally
// exempts Partial entries (a background job is running and may own a .tmp).
bool regenInScope(const RegenEntry& e, RegenScope scope, bool includePartials = true);

// What removeRegenerable() would delete for this scope. Pure.
RegenSummary summarizeRegenerable(const RegenScan& scan, RegenScope scope,
                                  bool includePartials = true);

// Entries a scope keeps because they are not provably regenerable (Retained).
RegenTotals retainedTotals(const RegenScan& scan);

// Delete every in-scope entry. Never throws; a file that cannot be deleted (open
// in another process) is counted in `failed` and left in place.
RegenResult removeRegenerable(const RegenScan& scan, RegenScope scope,
                              bool includePartials = true);

// scan(partialsOnly) + remove(PartialsOnly): the on-open sweep.
RegenResult sweepPartialFiles(const RegenLayout& layout, const Timeline& timeline);

// "1.5 GB" / "312 MB" / "48 KB" — shared by logs and tests.
std::string formatByteCount(std::uint64_t bytes);

} // namespace xleth::project
