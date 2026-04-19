#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

// ─── PluginRegistry ───────────────────────────────────────────────────────────
// Owns the JUCE AudioPluginFormatManager (VST3 format registered on
// construction) and the KnownPluginList that accumulates scan results.
//
// Responsibilities:
//   • Format manager lifetime — one instance per process.
//   • Search path management — callers add paths before scanning.
//   • Cache persistence — saveScanResults / loadScanResults via JUCE XML.
//   • JSON export — getPluginListAsJSON() for the N-API / React side.
//   • Progress state — isScanning / getScannedCount / getTotalCount.
//
// What it does NOT do:
//   • Scanning — that is VST-02 (async scan lives in a scanner helper).
//   • Audio thread interaction — message thread only.
//
// Non-copyable, non-movable.

class PluginRegistry
{
public:
    PluginRegistry();
    // Joins the scan thread if still running.
    ~PluginRegistry();

    PluginRegistry(const PluginRegistry&)            = delete;
    PluginRegistry& operator=(const PluginRegistry&) = delete;
    PluginRegistry(PluginRegistry&&)                 = delete;
    PluginRegistry& operator=(PluginRegistry&&)      = delete;

    // ── Format manager ────────────────────────────────────────────────────────
    // Returns the manager initialised with all default formats
    // (includes VST3PluginFormat when JUCE_PLUGINHOST_VST3=1).
    juce::AudioPluginFormatManager& getFormatManager();

    // ── Known plugins ─────────────────────────────────────────────────────────
    const juce::KnownPluginList& getKnownPlugins() const;

    // Returns a copy of the PluginDescription matching identifierString, or an
    // empty PluginDescription (name.isEmpty() == true) if not found.
    // Returns by value so callers are never left holding a dangling pointer into
    // KnownPluginList's internal Array (which can reallocate on addType).
    juce::PluginDescription findPluginByIdentifier(const juce::String& identifierString) const;

    // ── Search paths ─────────────────────────────────────────────────────────
    void                addSearchPath(const juce::String& path);
    void                clearSearchPaths();
    juce::StringArray   getSearchPaths() const;

    // ── Cache persistence ────────────────────────────────────────────────────
    // Serialises knownPlugins_ to JUCE's native XML format.
    void saveScanResults(const juce::File& cacheFile) const;

    // Deserialises from cacheFile into knownPlugins_.
    // Returns false if the file is missing, unreadable, or not valid XML.
    bool loadScanResults(const juce::File& cacheFile);

    // ── JSON export (N-API / React) ───────────────────────────────────────────
    // Returns a JSON array string:
    // [{ id, name, vendor, category, format, filePath,
    //    numInputs, numOutputs, hasEditor }, ...]
    juce::String getPluginListAsJSON() const;

    // ── Scan orchestration ────────────────────────────────────────────────────
    // Starts an asynchronous background scan of all search paths.
    // scannerExe must point to xleth-plugin-scanner.exe (sibling of .node).
    // No-op if a scan is already running.
    void scanPlugins(const juce::File& scannerExe);

    // Signals a running scan to stop after the current plugin finishes.
    void cancelScan();

    // ── Scan progress ─────────────────────────────────────────────────────────
    bool           isScanning()     const;
    int            getScannedCount() const;
    int            getTotalCount()   const;
    // Returns a thread-safe copy of the failed-plugin list.
    juce::StringArray getFailedPlugins() const;

    // Exposes the list for direct mutation (message thread only).
    juce::KnownPluginList& getKnownPluginsMutable();

private:
    juce::AudioPluginFormatManager formatManager_;
    juce::KnownPluginList          knownPlugins_;
    juce::StringArray              searchPaths_;
    juce::StringArray              failedPlugins_;

    std::atomic<bool> scanning_{false};
    std::atomic<int>  scannedCount_{0};
    std::atomic<int>  totalCount_{0};

    // Background scan thread + cancel flag.
    std::unique_ptr<std::thread> scanThread_;
    std::atomic<bool>            cancelFlag_{false};

    // Protects failedPlugins_ against concurrent access between the scan thread
    // (writer) and the message thread (reader via getFailedPlugins()).
    mutable std::mutex failedMutex_;
};
