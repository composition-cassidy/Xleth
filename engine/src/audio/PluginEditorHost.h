#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <chrono>
#include <map>
#include <memory>
#include <utility>

class PluginEditorHost;

#ifdef XLETH_DEBUG
// ─── MessageThreadHeartbeat ──────────────────────────────────────────────────
// JUCE Timer that fires every 500 ms on the JUCE message thread.
// Reports in stderr if the actual gap between ticks exceeds 700 ms, which
// means the JUCE message thread was starved (blocked by a long N-API call
// or by the Win32 message queue not being pumped).
// Owned by PluginEditorHost; started on first editor open, stopped when all
// editors are closed.
class MessageThreadHeartbeat : public juce::Timer
{
public:
    void timerCallback() override
    {
        auto now = std::chrono::steady_clock::now();
        auto gapMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                         now - lastTick_).count();
        lastTick_ = now;
        if (gapMs > 700)
            std::fprintf(stderr,
                "[MsgThread] Timer gap: %lldms (expected 500ms) — JUCE message thread starving\n",
                (long long)gapMs);
    }
private:
    std::chrono::steady_clock::time_point lastTick_ = std::chrono::steady_clock::now();
};
#endif  // XLETH_DEBUG

// ─── PluginEditorWindow ──────────────────────────────────────────────────────
// Floating native window (native title bar, close button only) hosting one
// VST3 plugin editor component.
//
// Close-button presses are routed through PluginEditorHost::closeEditor via a
// deferred message so the window is never deleted from within its own callback.

class PluginEditorWindow : public juce::DocumentWindow
{
public:
    PluginEditorWindow(const juce::String& title,
                       PluginEditorHost*   host,
                       int                 trackId,
                       int                 nodeId);

    ~PluginEditorWindow() override = default;

    // juce::DocumentWindow
    void closeButtonPressed() override;

private:
    PluginEditorHost* host_;
    int               trackId_;
    int               nodeId_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PluginEditorWindow)
};

// ─── PluginEditorHost ────────────────────────────────────────────────────────
// Manages floating windows for VST3 plugin GUI editors.
//
// All methods MUST be called on the JUCE message thread.
// Windows are native HWNDs that float above the Electron window — do NOT
// attempt HWND reparenting into Electron.
//
// Ownership:
//   MixEngine owns a std::unique_ptr<PluginEditorHost>.
//   PluginEditorHost owns one PluginEditorWindow per open editor.
//   Each window owns the AudioProcessorEditor (via setContentOwned).

class PluginEditorHost
{
public:
    PluginEditorHost()  = default;
    ~PluginEditorHost();

    // Open a plugin's native editor in a floating window.
    // Title: "[PluginName] — Track [trackId]" (trackId = -1 → "— Master").
    // If the editor is already open, brings it to front and returns true.
    // Returns false if the plugin has no GUI editor.
    bool openEditor(juce::AudioProcessor* plugin,
                    int                   trackId,
                    int                   nodeId);

    // Close the editor for {trackId, nodeId}. No-op if not open.
    // Safe to call directly (not from within a window callback).
    void closeEditor(int trackId, int nodeId);

    // Close all editors for a given track (track deleted / project unloaded).
    void closeEditorsForTrack(int trackId);

    // Close every open editor window.
    void closeAllEditors();

    // Returns true if an editor is currently open for {trackId, nodeId}.
    bool isEditorOpen(int trackId, int nodeId) const;

private:
    struct PositionInfo
    {
        juce::Point<int> position;
        bool             hasPosition = false;
    };

    // Key: {trackId, nodeId}.  Value: the floating window.
    std::map<std::pair<int, int>, std::unique_ptr<PluginEditorWindow>> openEditors_;

    // Saved window positions keyed by plugin name string.
    // Allows reopening a plugin type near its last position.
    std::map<juce::String, PositionInfo> savedPositions_;

#ifdef XLETH_DEBUG
    // Heartbeat timer: active while at least one editor is open.
    // Started in openEditor (first window), stopped in closeEditor (last window).
    std::unique_ptr<MessageThreadHeartbeat> heartbeat_;
#endif

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PluginEditorHost)
};
