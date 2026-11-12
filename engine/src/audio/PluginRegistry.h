#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// ─── PluginRegistry ───────────────────────────────────────────────────────────
// Owns the engine's AudioPluginFormatManager, the known-plugin list, the
// per-format search-path settings and the persisted scan-failure list, and runs
// the out-of-process scan (P1 hardening, docs/PLUGIN_HOSTING_LOG.md).
//
// Threads:
//   • Every public method is called from the engine worker's Node main thread
//     (the JUCE message thread) — never from the audio thread. The audio thread
//     reaches plugins only through already-built chain snapshots.
//   • scanPlugins() starts one std::thread that drives xleth-plugin-scanner.exe
//     through a JUCE ChildProcessCoordinator. Plugin DLLs are only ever loaded
//     inside that scanner process.
//
// The known-plugin list is an immutable KnownPluginList held by shared_ptr.
// A scan builds a NEW list and swaps it in under listMutex_ in one step, so a
// reader never sees a half-filled list. Readers copy the shared_ptr under the
// same mutex and then read the snapshot lock-free.
//
// On-disk state (all in %APPDATA%\Xleth, all written temp-file + rename):
//   plugin-cache.xml            KnownPluginList XML (JUCE format)
//   plugin-settings.json        { version:1, searchPaths:{ <format>:{ user[], useDefaults } } }
//   plugin-scan-failures.json   { version:1, entries:[{ format, path, reason, fileTime,
//                                                       firstSeen, lastAttempt, attempts }] }
//   plugin-quarantine.json      { version:1, entries:[{ format, uniqueId, deprecatedUid, name,
//                                                       vendor, fileOrIdentifier, phase, context,
//                                                       crashedAt, crashes }] }   (P2)
//   plugin-load-crash.json      the breadcrumb of the last load crash, until the
//                               UI consumes it (audio_getLastLoadCrash)        (P2)
//   plugin-load-inflight.json   written by PluginLoadBreadcrumb around every
//                               third-party load; recovered by initialise()   (P2)
//
// Non-copyable, non-movable.

class PluginRegistry
{
public:
    // Search-path settings for one plugin format.
    struct FormatPaths
    {
        juce::StringArray user;
        bool              useDefaults = true;
    };

    // One persisted scan failure.
    struct FailureEntry
    {
        juce::String format;
        juce::String path;
        // Scanner: crash | timeout | no-types-found | exception | unknown-format.
        // Preflight (P2, never spawns the scanner): not-64bit | arm64 |
        // no-entry-point | not-a-binary | unreadable.
        juce::String reason;
        juce::int64  fileTime = 0; // ms since epoch (see computeFileTime)
        juce::String firstSeen;    // ISO-8601
        juce::String lastAttempt;  // ISO-8601
        int          attempts = 0;
    };

    enum class ScanMode { Incremental, Full };

    struct ScanOptions
    {
        ScanMode          mode        = ScanMode::Incremental;
        bool              retryFailed = false; // ignore the failure list's skip rule
        juce::StringArray onlyPaths;           // non-empty = scan just these items
    };

    struct ScanProgress
    {
        bool         scanning         = false;
        int          done             = 0;
        int          total            = 0;
        juce::String current;
        int          skippedUnchanged = 0;
        int          skippedFailed    = 0;
        int          failedNew        = 0;
        int          failedCount      = 0;  // size of the persisted failure list
        bool         cancelled        = false; // last/current scan was cancelled
        juce::String mode;                 // "incremental" | "full" | "" (never scanned)
    };

    PluginRegistry();
    // Uses dataDir instead of %APPDATA%\Xleth (tests).
    explicit PluginRegistry(const juce::File& dataDir);
    // Cancels and joins the scan thread if still running.
    ~PluginRegistry();

    PluginRegistry(const PluginRegistry&)            = delete;
    PluginRegistry& operator=(const PluginRegistry&) = delete;
    PluginRegistry(PluginRegistry&&)                 = delete;
    PluginRegistry& operator=(PluginRegistry&&)      = delete;

    // ── Format manager ────────────────────────────────────────────────────────
    // The engine-side manager (VST3 only while JUCE_PLUGINHOST_VST3 is the sole
    // host define). Used for instantiation; the scan thread only calls the
    // DLL-free enumeration functions on it.
    juce::AudioPluginFormatManager& getFormatManager();

    // ── Known plugins ─────────────────────────────────────────────────────────
    // Immutable snapshot of the current list. Never null.
    std::shared_ptr<const juce::KnownPluginList> getKnownPluginsSnapshot() const;

    // Exact createIdentifierString() match first; if none, parses the legacy
    // "<format>-<name>-<hex pathhash>-<hex uid>" form and matches format + uid
    // (so ids minted from a path the dedupe dropped still resolve). Returns an
    // empty description (name.isEmpty()) if nothing matches. By value.
    juce::PluginDescription findPluginByIdentifier(const juce::String& identifierString) const;

    // ── Search paths (persisted in plugin-settings.json) ─────────────────────
    // Names of the registered formats ("VST3", later "VST", "CLAP").
    juce::StringArray getFormatNames() const;
    // The format's default locations (empty for an unknown format).
    juce::StringArray getDefaultSearchPaths(const juce::String& formatName) const;
    FormatPaths       getSearchPaths(const juce::String& formatName) const;
    // Returns an empty string on success, otherwise an error code:
    // "scan-in-progress" | "unknown-format" | "write-failed".
    juce::String      setSearchPaths(const juce::String& formatName,
                                     const juce::StringArray& user, bool useDefaults);

    // ── Cache persistence ────────────────────────────────────────────────────
    void saveScanResults(const juce::File& cacheFile) const;
    // Loads, collapses bundle/inner-binary duplicates (logged [PluginReg]), and
    // re-saves the cache if anything collapsed. False if missing / not XML.
    bool loadScanResults(const juce::File& cacheFile);

    // ── JSON export (N-API / React) ───────────────────────────────────────────
    // [{ id, name, vendor, category, format, filePath,
    //    numInputs, numOutputs, hasEditor }, ...]   (fully escaped)
    juce::String getPluginListAsJSON() const;

    // ── Failure list ─────────────────────────────────────────────────────────
    std::vector<FailureEntry> getFailures() const;
    // JSON array string of the failure list; each entry also carries the legacy
    // `filePath` field (== path) the VstBrowser reads.
    juce::String getFailuresAsJSON() const;

    // ── Scan orchestration ────────────────────────────────────────────────────
    // Starts an asynchronous scan. scannerExe = xleth-plugin-scanner.exe.
    // Returns "" when started, otherwise "scan-in-progress" | "scanner-missing".
    juce::String scanPlugins(const juce::File& scannerExe, const ScanOptions& options);

    // Removes the given failure entries (all = every entry) and starts an
    // incremental scan limited to those paths. Same return codes as scanPlugins
    // plus "nothing-to-retry". removedOut receives the number of removed entries.
    juce::String retryFailed(const juce::File& scannerExe, const juce::StringArray& paths,
                             bool all, int& removedOut);

    // Signals a running scan to stop after the current plugin finishes. The
    // partial results are MERGED into the previous list (never a wipe).
    void cancelScan();

    // ── Scan progress ─────────────────────────────────────────────────────────
    bool         isScanning() const;
    ScanProgress getScanProgress() const;

    // ── Load-crash quarantine (P2) ───────────────────────────────────────────
    // A plugin whose load killed the engine (breadcrumb left by a dead pid) is
    // quarantined, keyed by format + uniqueId + deprecatedUid (NOT by path, so a
    // moved plugin stays quarantined). Project load gives it a placeholder
    // (reason "quarantined"); tryResolvePlugin refuses it until unquarantined.
    struct QuarantineEntry
    {
        juce::String format;
        juce::String uniqueId;        // lower-case hex
        juce::String deprecatedUid;   // lower-case hex
        juce::String name;
        juce::String vendor;
        juce::String fileOrIdentifier;
        juce::String phase;           // instantiate | prepare | setState
        juce::String context;         // insert | projectLoad | resolveMissing
        juce::String crashedAt;       // ISO-8601 (breadcrumb ts)
        int          crashes = 1;
    };

    juce::File getDataDir() const { return dataDir_; }

    bool isQuarantined(const juce::PluginDescription& desc) const;
    bool isQuarantined(const juce::String& format, const juce::String& uniqueIdHex,
                       const juce::String& deprecatedUidHex) const;
    // Removes the entry. True if one was removed.
    bool unquarantine(const juce::String& format, const juce::String& uniqueIdHex,
                      const juce::String& deprecatedUidHex);
    std::vector<QuarantineEntry> getQuarantine() const;

    // The breadcrumb of the load crash recovered at startup that the UI has not
    // been told about yet, or void. Consuming it deletes plugin-load-crash.json.
    juce::var takeLastLoadCrash();

    // Trims, strips a "0x" prefix, lower-cases. Uids are always hex strings.
    static juce::String normaliseUidHex(const juce::String& s);

    // ── Helpers (public for tests) ───────────────────────────────────────────
    // Full JSON string-body escaping (\" \\ \b \f \n \r \t, \u00XX for others < 0x20).
    static juce::String escapeJsonString(const juce::String& s);
    // ms since epoch. A file: its mtime. A bundle directory: max of the
    // directory's mtime and every *.vst3 / *.dll / *.clap binary inside it.
    static juce::int64  computeFileTime(const juce::File& item);
    // ISO-8601 "now".
    static juce::String nowIso();

private:
    struct ScanItem
    {
        juce::String formatName;
        juce::String path;
        juce::int64  fileTime = 0;
    };

    void         initialise(const juce::File& dataDir);
    void         loadSettings();
    bool         saveSettingsLocked() const;            // settingsMutex_ held
    void         loadFailures();
    bool         saveFailuresLocked() const;            // failuresMutex_ held
    void         loadQuarantine();
    bool         saveQuarantineLocked() const;          // quarantineMutex_ held
    void         recoverLoadCrash();                    // initialise(): breadcrumb → quarantine
    juce::File   cacheFile() const;
    void         publish(std::shared_ptr<const juce::KnownPluginList> list);
    void         runScan(juce::File scannerExe, ScanOptions options,
                         std::map<juce::String, FormatPaths> settings);
    std::vector<ScanItem> enumerate(const std::map<juce::String, FormatPaths>& settings,
                                    const juce::StringArray& onlyPaths) const;

    static bool  atomicWrite(const juce::File& target, const juce::String& content);

    juce::AudioPluginFormatManager formatManager_;
    juce::File                     dataDir_;

    mutable std::mutex                           listMutex_;
    std::shared_ptr<const juce::KnownPluginList> knownPlugins_;

    mutable std::mutex                  settingsMutex_;
    std::map<juce::String, FormatPaths> settings_;      // includes unregistered formats read from disk

    mutable std::mutex        failuresMutex_;
    std::vector<FailureEntry> failures_;

    mutable std::mutex           quarantineMutex_;
    std::vector<QuarantineEntry> quarantine_;

    // Progress (counters atomic; strings under progressMutex_).
    std::atomic<bool> scanning_{false};
    std::atomic<int>  done_{0};
    std::atomic<int>  total_{0};
    std::atomic<int>  skippedUnchanged_{0};
    std::atomic<int>  skippedFailed_{0};
    std::atomic<int>  failedNew_{0};
    std::atomic<bool> lastCancelled_{false};
    mutable std::mutex progressMutex_;
    juce::String       current_;
    juce::String       lastMode_;

    std::unique_ptr<std::thread> scanThread_;
    std::atomic<bool>            cancelFlag_{false};
};
