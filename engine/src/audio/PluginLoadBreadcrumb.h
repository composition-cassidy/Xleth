#pragma once

// PluginLoadBreadcrumb — "which third-party plugin was the engine loading when
// it died?" (P2, docs/PLUGIN_HOSTING_LOG.md).
//
// Before every third-party instantiation, and through the prepare/setState
// calls that follow it, the engine keeps
//     %APPDATA%\Xleth\plugin-load-inflight.json
//   { "version":1, "pid":1234, "format":"VST3", "name":"...", "vendor":"...",
//     "fileOrIdentifier":"...", "uniqueId":"...", "deprecatedUid":"...",
//     "phase":"instantiate|setState|prepare",
//     "context":"insert|projectLoad|resolveMissing", "ts":"ISO-8601" }
// on disk. The file is written synchronously (temp + rename) BEFORE the plugin
// code runs, so it survives the process dying inside that code. It is deleted
// when the load completes or fails cleanly (an SEH-caught fault is clean: the
// engine survived). A file left behind by a dead pid therefore names the
// plugin that killed the engine.
//
// uniqueId / deprecatedUid are lower-case hex of the PluginDescription ints
// (the same spelling createIdentifierString() uses).
//
// Threads: JUCE message thread (the engine worker's Node main thread) only.
// Never on the audio thread — it does file I/O.

#include <juce_audio_processors/juce_audio_processors.h>

class PluginLoadBreadcrumb
{
public:
    static constexpr const char* kFileName = "plugin-load-inflight.json";

    PluginLoadBreadcrumb() = default;
    // Deletes the file if the scope is still active (clean completion/failure).
    ~PluginLoadBreadcrumb();

    PluginLoadBreadcrumb(const PluginLoadBreadcrumb&)            = delete;
    PluginLoadBreadcrumb& operator=(const PluginLoadBreadcrumb&) = delete;

    // Starts tracking a load: writes the file with phase "instantiate".
    // dataDir = the PluginRegistry data dir (%APPDATA%\Xleth in production).
    // context: "insert" | "projectLoad" | "resolveMissing".
    void begin(const juce::File& dataDir, const juce::PluginDescription& desc,
               const char* context);

    // Rewrites the file with a new phase ("prepare" | "setState"). No-op when inactive.
    void setPhase(const char* phase);

    // Load finished (or failed cleanly): deletes the file. No-op when inactive.
    void finish();

    bool isActive() const { return active_; }

    // ── Startup recovery ─────────────────────────────────────────────────────
    // If <dataDir>/plugin-load-inflight.json exists and its pid is not a live
    // process (or is this process — impossible for a live load at startup),
    // returns its parsed object and deletes the file. A live foreign pid (another
    // engine mid-load) or no file → void var, file untouched. An unparseable file
    // is deleted and logged; returns void.
    static juce::var takeOrphan(const juce::File& dataDir);

    // Lower-case hex, as in createIdentifierString().
    static juce::String uidHex(int uid);

    static bool isProcessAlive(int pid);
    static int  currentPid();

private:
    void write();

    juce::File              file_;
    juce::PluginDescription desc_;
    juce::String            context_;
    juce::String            phase_;
    bool                    active_ = false;
};
