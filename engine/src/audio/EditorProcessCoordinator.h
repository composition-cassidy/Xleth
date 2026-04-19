#pragma once

// EditorProcessCoordinator — coordinator side of the out-of-process VST editor IPC.
//
// Spawns xleth-editor-host.exe as a JUCE ChildProcessWorker, sends it an INIT
// message with the plugin path and state, and handles REDY / CLSD / ERR_.
//
// EDIT-03 additions: bidirectional parameter sync.
//   worker plugin → PARM/STAT → editor process's plugin instance
//   editor knob → PARM       → worker plugin instance
//
// Loop prevention: each side suppresses the echo of changes it just applied via
// a mutex-protected suppressedParams_ set. See suppressNextChange() / ParamSyncListener.
//
// Threading model:
//   handleMessageFromWorker / handleConnectionLost: ChildProcess poll thread
//   PARM / STAT applies: direct on poll thread (no callAsync — see .cpp for rationale)
//   REDY / CLSD / ERR_ callbacks: dispatched to message thread via callAsync
//   ParamSyncListener::audioProcessorParameterChanged: may fire from any thread;
//     dispatches IPC sends via callAsync (RT-safe) — separate from inbound apply path

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

#include <atomic>
#include <chrono>
#include <functional>
#include <mutex>
#include <string>
#include <unordered_set>

// UID token used to match this coordinator with the editor-host worker.
// MUST match kEditorHostUID in EditorHostMain.cpp.
static constexpr const char* kEditorHostUID = "XlethEditorHost";

// ─── Close-path profiling ─────────────────────────────────────────────────────
// g_closeProfile_t0 is set the instant CLSD/ERR_ arrives from the editor-host.
// All [CloseProfile] stages in any TU are relative to this timestamp.
// g_closeProfileActive is set true on CLSD and cleared on the next openPluginEditor
// call so the "new_open_arrived" stage is only logged after a real close.

extern std::chrono::high_resolution_clock::time_point g_closeProfile_t0;
extern bool                                            g_closeProfileActive;

#define CPLOG(stage) \
    do { \
        double _cpm = std::chrono::duration<double, std::milli>( \
            std::chrono::high_resolution_clock::now() - g_closeProfile_t0).count(); \
        std::fprintf(stderr, "[CloseProfile] stage=%s elapsed_ms=%.3f\n", (stage), _cpm); \
        std::fflush(stderr); \
    } while (0)

// ─── Message protocol (all tags are 4 chars) ──────────────────────────────────
//
// Coordinator → Worker:
//   INIT\n<pluginPath>\n<stateBase64>\n<parentHwndHex>
//   CLOS      (no payload)
//   PARM\n<paramIndex>\n<normalizedValue>
//   STAT\n<stateBase64>
//   STRM\n<shmName>\n<sampleRate>\n<blockSize>
//   STOP      (no payload)   — stop audio streaming, release editor-side plugin
//
// Worker → Coordinator:
//   REDY\n<W>x<H>
//   CLSD      (editor closed by user)
//   ERR_\n<message>
//   PARM\n<paramIndex>\n<normalizedValue>

class EditorProcessCoordinator : public juce::ChildProcessCoordinator
{
public:
    // workerPlugin: the plugin instance running in the AudioGraph. Pass nullptr
    // in test mode (EDIT-02/03 test) — param sync is silently skipped.
    explicit EditorProcessCoordinator(juce::AudioPluginInstance* workerPlugin = nullptr);
    ~EditorProcessCoordinator() override;

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    // Launches xleth-editor-host.exe and sends the INIT message.
    //   editorHostExe  : path to xleth-editor-host.exe
    //   pluginPath     : absolute path to the .vst3 file to open
    //   stateBase64    : base64-encoded plugin state (empty = no state restore)
    //   parentHwndHex  : uppercase hex HWND of the main Xleth window; empty = no parenting
    bool start(const juce::File&   editorHostExe,
               const juce::String& pluginPath,
               const juce::String& stateBase64,
               const juce::String& parentHwndHex = juce::String());

    // Sends CLOS. Non-blocking — worker sends CLSD back → onClosed_ fires.
    void close();

    // ── Plugin wiring ─────────────────────────────────────────────────────────

    // Attach (or replace) the worker plugin for param sync.
    // Must be called on the message thread. Safe to call with nullptr to detach.
    void setWorkerPlugin(juce::AudioPluginInstance* plugin);

    // ── Outbound param sync ───────────────────────────────────────────────────

    // Push a single param change from the worker to the editor process.
    // Called by ParamSyncListener when the worker's plugin emits a param change
    // that originated locally (not from an incoming PARM echo).
    // Safe to call from any thread (sends on calling thread; pipe is thread-safe).
    void sendParamChange(int paramIndex, float normalizedValue);

    // Push full plugin state from the worker to the editor (e.g. preset load).
    void sendStateChange(const juce::MemoryBlock& stateBlock);

    // ── Audio stream control ─────────────────────────────────────────────────
    // Tells the editor-host to open the named shared-memory ring and start a
    // pump thread feeding its plugin instance. Call AFTER the worker-side
    // GuardedPluginWrapper::enableAudioStream (the ring must already exist).
    void sendStreamStart(const std::string& shmName,
                         int                sampleRate,
                         int                blockSize);

    // Tells the editor-host to stop the pump thread and releaseResources on
    // its plugin. Send BEFORE disabling the worker-side stream.
    void sendStreamStop();

    // ── State queries ─────────────────────────────────────────────────────────

    bool        isEditorReady()   const { return editorReady_.load();  }
    bool        isEditorClosed()  const { return editorClosed_.load(); }
    int         getEditorWidth()  const { return editorWidth_;         }
    int         getEditorHeight() const { return editorHeight_;        }
    std::string getErrorMessage() const { return errorMessage_;        }

    // ── Callbacks (set before calling start()) ───────────────────────────────
    std::function<void(int w, int h)> onReady_;
    std::function<void()>             onClosed_;

private:
    // ── IPC overrides ─────────────────────────────────────────────────────────
    void handleMessageFromWorker(const juce::MemoryBlock&) override;
    void handleConnectionLost()                            override;

    // ── Param sync listener (nested — defined in .cpp) ────────────────────────
    class ParamSyncListener;
    std::unique_ptr<ParamSyncListener> paramListener_;

    // ── State ─────────────────────────────────────────────────────────────────
    juce::AudioPluginInstance* workerPlugin_ {nullptr};

    int         editorWidth_   {0};
    int         editorHeight_  {0};
    std::string errorMessage_;

    std::atomic<bool> editorReady_  {false};
    std::atomic<bool> editorClosed_ {false};

    // Set at the top of start() so handleMessageFromWorker can report elapsed
    // time from INIT-sent to REDY-received in [OpenProfile] lines.
    std::chrono::high_resolution_clock::time_point openStart_;

    // Serialises PARM/STAT applies (poll thread) against plugin pointer mutations
    // and destructor teardown (main thread). Must be recursive_mutex: setValueNotifyingHost
    // fires listeners synchronously, and a listener (including ParamSyncListener itself)
    // may re-enter an apply path on the same thread.
    std::recursive_mutex applyMutex_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(EditorProcessCoordinator)
};
