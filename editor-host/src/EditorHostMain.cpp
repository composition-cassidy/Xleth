// xleth-editor-host — out-of-process VST3 editor host
//
// Two launch modes:
//
//   IPC mode (normal):
//     Spawned by the worker process via ChildProcessCoordinator. The JUCE IPC
//     pipe args are present in the command line. Worker sends INIT with the
//     plugin path and state; editor responds with REDY once the window is up.
//
//   Fallback mode (manual testing):
//     Launched directly from a terminal with argv[1] = .vst3 path.
//     e.g.  xleth-editor-host.exe "C:\path\to\Plugin.vst3"
//     No IPC — just loads and shows the editor window.
//
// Message protocol (see EditorProcessCoordinator.h for the authoritative spec):
//   Coordinator → Worker:  INIT\n<pluginPath>\n<stateBase64>\n<parentHwndHex>
//                          CLOS
//                          PARM\n<paramIndex>\n<normalizedValue>
//                          STAT\n<stateBase64>
//   Worker → Coordinator:  REDY\n<W>x<H>
//                          CLSD
//                          ERR_\n<message>
//                          PARM\n<paramIndex>\n<normalizedValue>
//
// UID token MUST match kEditorHostUID in EditorProcessCoordinator.h.

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <Windows.h>
#include <shellapi.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <mutex>
#include <string>
#include <unordered_set>

// ─── Open profiling ──────────────────────────────────────────────────────────
// g_t0 is a static global so it is set during CRT init, before JUCE's
// ScopedJuceInitialiser_GUI runs. That means the "main_entry" log line inside
// initialise() shows elapsed from true process-start, and "juce_init_done"
// shows how long ScopedJuceInitialiser_GUI + JUCE message-thread setup took.

static const std::chrono::high_resolution_clock::time_point g_t0 =
    std::chrono::high_resolution_clock::now();

// Writes to stderr always, and to the file log if it is already open.
#define PLOG(stage) \
    do { \
        auto _now = std::chrono::high_resolution_clock::now(); \
        double _ms = std::chrono::duration<double, std::milli>(_now - g_t0).count(); \
        std::fprintf(stderr, "[OpenProfile] stage=%s elapsed_ms=%.3f\n", (stage), _ms); \
        std::fflush(stderr); \
        if (g_log) { \
            std::fprintf(g_log, "[OpenProfile] stage=%s elapsed_ms=%.3f\n", (stage), _ms); \
            std::fflush(g_log); \
        } \
    } while (0)

#include "AudioPumpThread.h"
#include "audio/NamedAudioRing.h"

// UID token — must match kEditorHostUID in EditorProcessCoordinator.h.
static constexpr const char* kEditorHostUID = "XlethEditorHost";

// ─── File-based log ──────────────────────────────────────────────────────────
// Written two directories above the exe so it lands in bridge/ alongside the
// other log files (scanner-log.txt). Flushed after every write.

static FILE* g_log = nullptr;

#define ELOG(fmt, ...) \
    do { if (g_log) { \
        std::fprintf(g_log, "[EditorHost] " fmt "\n", ##__VA_ARGS__); \
        std::fflush(g_log); \
    } } while (0)

static void logOpen()
{
    // exe = bridge/build/Release/xleth-editor-host.exe
    // exe_dir/../.. = bridge/
    const juce::File logFile =
        juce::File::getSpecialLocation(juce::File::currentExecutableFile)
            .getParentDirectory()   // bridge/build/Release/
            .getParentDirectory()   // bridge/build/
            .getParentDirectory()   // bridge/
            .getChildFile("editor-host.log");

    g_log = std::fopen(logFile.getFullPathName().toRawUTF8(), "w");
}

// ─── Forward declarations ────────────────────────────────────────────────────
class EditorHostApp;

// ─── EditorHostWorker ────────────────────────────────────────────────────────
// ChildProcessWorker subclass. Runs in IPC mode only.
// Callbacks are dispatched to the JUCE message thread via callAsync.

class EditorHostWorker : public juce::ChildProcessWorker
{
public:
    // Set by EditorHostApp after construction.
    std::function<void(const juce::String& pluginPath,
                       const juce::String& stateB64,
                       const juce::String& parentHwndHex)> onInitReceived;
    std::function<void()> onCloseReceived;
    std::function<void()> onConnectionLost;

    // Param sync callbacks — set after plugin load.
    std::function<void(int paramIdx, float value)>  onParamReceived;
    std::function<void(const juce::String& stateB64)> onStatReceived;

    // Audio stream callbacks — set after plugin load.
    std::function<void(const juce::String& shmName, int sr, int bs)> onStreamStart;
    std::function<void()>                                             onStreamStop;

    // ── Outbound messages ─────────────────────────────────────────────────────

    void sendReady(int w, int h)
    {
        const juce::String msg = "REDY\n" + juce::String(w) + "x" + juce::String(h);
        const juce::MemoryBlock mb(msg.toRawUTF8(), (size_t)msg.getNumBytesAsUTF8());
        ELOG("[EditorHost IPC] Sending REDY %dx%d (%d bytes)", w, h, (int)mb.getSize());
        sendMessageToCoordinator(mb);
    }

    void sendClosed()
    {
        const juce::String msg = "CLSD";
        const juce::MemoryBlock mb(msg.toRawUTF8(), (size_t)msg.getNumBytesAsUTF8());
        ELOG("[EditorHost IPC] Sending CLSD (%d bytes)", (int)mb.getSize());
        sendMessageToCoordinator(mb);
    }

    void sendError(const juce::String& errorMsg)
    {
        const juce::String msg = "ERR_\n" + errorMsg;
        const juce::MemoryBlock mb(msg.toRawUTF8(), (size_t)msg.getNumBytesAsUTF8());
        ELOG("[EditorHost IPC] Sending ERR_ (%d bytes): %s",
             (int)mb.getSize(), errorMsg.toRawUTF8());
        sendMessageToCoordinator(mb);
    }

    void sendParamChange(int paramIndex, float normalizedValue)
    {
        const juce::String msg =
            "PARM\n" + juce::String(paramIndex) + "\n" + juce::String(normalizedValue, 6);
        const juce::MemoryBlock mb(msg.toRawUTF8(), (size_t)msg.getNumBytesAsUTF8());
        ELOG("[ParamSync] [EditorHost IPC] Sending PARM editor→worker idx=%d value=%.6f (%d bytes)",
             paramIndex, normalizedValue, (int)mb.getSize());
        sendMessageToCoordinator(mb);
    }

    void sendStateChange(const juce::MemoryBlock& stateBlock)
    {
        juce::MemoryOutputStream mos;
        juce::Base64::convertToBase64(mos, stateBlock.getData(), stateBlock.getSize());
        juce::String b64 = mos.toString();

        const juce::String msg = "STAT\n" + b64;
        const juce::MemoryBlock mb(msg.toRawUTF8(), (size_t)msg.getNumBytesAsUTF8());
        ELOG("[ParamSync] [EditorHost IPC] Sending STAT (%d state bytes → %d bytes IPC)",
             (int)stateBlock.getSize(), (int)mb.getSize());
        sendMessageToCoordinator(mb);
    }

private:
    // ── Inbound messages ──────────────────────────────────────────────────────
    // Called on ChildProcessWorker's internal poll thread.

    void handleMessageFromCoordinator(const juce::MemoryBlock& mb) override
    {
        const juce::String msg = mb.toString();
        ELOG("[EditorHost IPC] Message from coordinator (%d bytes): %.80s",
             (int)mb.getSize(), msg.toRawUTF8());

        if (msg.startsWith("INIT"))
        {
            // INIT\n<pluginPath>\n<stateBase64>\n<parentHwndHex>
            juce::StringArray lines;
            lines.addTokens(msg, "\n", "");

            const juce::String pluginPath    = lines.size() > 1 ? lines[1] : juce::String();
            const juce::String stateB64      = lines.size() > 2 ? lines[2] : juce::String();
            const juce::String parentHwndHex = lines.size() > 3 ? lines[3].trim() : juce::String();

            ELOG("init received plugin=%s stateLen=%d parent=0x%s",
                 pluginPath.toRawUTF8(), stateB64.length(),
                 parentHwndHex.isEmpty() ? "0" : parentHwndHex.toRawUTF8());

            if (onInitReceived)
            {
                auto cb = onInitReceived;
                juce::MessageManager::callAsync([cb, pluginPath, stateB64, parentHwndHex]
                {
                    cb(pluginPath, stateB64, parentHwndHex);
                });
            }
        }
        else if (msg.startsWith("CLOS"))
        {
            ELOG("CLOS received — closing");
            if (onCloseReceived)
            {
                auto cb = onCloseReceived;
                juce::MessageManager::callAsync([cb]{ cb(); });
            }
        }
        else if (msg.startsWith("PARM"))
        {
            // PARM from coordinator (worker plugin changed) → apply to local plugin.
            juce::StringArray lines;
            lines.addTokens(msg, "\n", "");
            const int   paramIdx = lines.size() > 1 ? lines[1].getIntValue()   : -1;
            const float value    = lines.size() > 2 ? lines[2].getFloatValue() : 0.0f;

            ELOG("[ParamSync] PARM worker→editor paramIdx=%d value=%.6f", paramIdx, value);

            if (onParamReceived)
            {
                auto cb = onParamReceived;
                juce::MessageManager::callAsync([cb, paramIdx, value]
                {
                    cb(paramIdx, value);
                });
            }
        }
        else if (msg.startsWith("STAT"))
        {
            // STAT from coordinator (preset load on worker side) → apply to local plugin.
            const juce::String stateB64 =
                msg.fromFirstOccurrenceOf("\n", false, false).trim();

            ELOG("[ParamSync] STAT worker→editor stateLen=%d", stateB64.length());

            if (onStatReceived)
            {
                auto cb = onStatReceived;
                juce::MessageManager::callAsync([cb, stateB64]
                {
                    cb(stateB64);
                });
            }
        }
        else if (msg.startsWith("STRM"))
        {
            // STRM\n<shmName>\n<sampleRate>\n<blockSize>
            juce::StringArray lines;
            lines.addTokens(msg, "\n", "");
            const juce::String shmName = lines.size() > 1 ? lines[1].trim() : juce::String();
            const int sr = lines.size() > 2 ? lines[2].getIntValue() : 0;
            const int bs = lines.size() > 3 ? lines[3].getIntValue() : 0;

            ELOG("[AudioStream] STRM received name=%s sr=%d bs=%d",
                 shmName.toRawUTF8(), sr, bs);

            if (onStreamStart)
            {
                auto cb = onStreamStart;
                juce::MessageManager::callAsync([cb, shmName, sr, bs]
                {
                    cb(shmName, sr, bs);
                });
            }
        }
        else if (msg.startsWith("STOP"))
        {
            ELOG("[AudioStream] STOP received");
            if (onStreamStop)
            {
                auto cb = onStreamStop;
                juce::MessageManager::callAsync([cb]{ cb(); });
            }
        }
        else
        {
            ELOG("unknown message tag: %.4s", msg.toRawUTF8());
        }
    }

    void handleConnectionLost() override
    {
        ELOG("coordinator connection lost — quitting");
        if (onConnectionLost)
        {
            auto cb = onConnectionLost;
            juce::MessageManager::callAsync([cb]{ cb(); });
        }
    }
};

// ─── ParamSyncListener ───────────────────────────────────────────────────────
// Attached to the editor-host's plugin instance. Forwards outgoing param
// changes back to the coordinator process and suppresses echoes of changes we
// applied from the coordinator. Defined before EditorHostApp so the app can
// hold a unique_ptr to it.
//
// Threading: same model as EditorProcessCoordinator::ParamSyncListener.
//   audioProcessorParameterChanged may fire from any thread; we always
//   dispatch IPC sends to the message thread via callAsync.
//
// Loop prevention: suppressedParams_ / inBulkUpdate_ mirror the coordinator side.

class ParamSyncListener : public juce::AudioProcessorListener
{
public:
    explicit ParamSyncListener(EditorHostWorker* worker) : worker_(worker) {}

    void suppressNextChange(int paramIndex)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        suppressedParams_.insert(paramIndex);
    }

    void setBulkUpdate(bool v) { inBulkUpdate_.store(v); }

    // ── AudioProcessorListener ────────────────────────────────────────────────

    void audioProcessorParameterChanged(juce::AudioProcessor* /*processor*/,
                                        int   parameterIndex,
                                        float newValue) override
    {
        if (inBulkUpdate_.load()) return;

        {
            std::lock_guard<std::mutex> lock(mutex_);
            auto it = suppressedParams_.find(parameterIndex);
            if (it != suppressedParams_.end())
            {
                suppressedParams_.erase(it);
                ELOG("[ParamSync] suppressed echo paramIdx=%d", parameterIndex);
                return;
            }
        }

        // Genuine local change (user turned knob in the editor UI) → send to worker.
        ELOG("[ParamSync] editor→worker paramIdx=%d value=%.6f", parameterIndex, newValue);

        auto* w = worker_;
        juce::MessageManager::callAsync([w, parameterIndex, newValue]
        {
            w->sendParamChange(parameterIndex, newValue);
        });
    }

    void audioProcessorChanged(juce::AudioProcessor* processor,
                               const ChangeDetails&  details) override
    {
        if (inBulkUpdate_.load()) return;

        if (!details.programChanged && !details.nonParameterStateChanged) return;

        ELOG("[ParamSync] editor program changed — sending STAT");

        juce::MemoryBlock state;
        processor->getStateInformation(state);

        auto* w = worker_;
        juce::MessageManager::callAsync([w, state]
        {
            w->sendStateChange(state);
        });
    }

private:
    EditorHostWorker*         worker_;
    std::mutex                mutex_;
    std::unordered_set<int>   suppressedParams_;
    std::atomic<bool>         inBulkUpdate_ {false};
};

// ─── EditorWindow ────────────────────────────────────────────────────────────

class EditorWindow : public juce::DocumentWindow
{
public:
    std::function<void()> onClose;

    EditorWindow(const juce::String& pluginName, juce::AudioProcessorEditor* editor)
        : juce::DocumentWindow(pluginName,
                               juce::Colours::darkgrey,
                               juce::DocumentWindow::allButtons)
    {
        setUsingNativeTitleBar(true);
        setResizable(editor->isResizable(), false);
        setContentOwned(editor, true);
        centreWithSize(editor->getWidth(), editor->getHeight());
    }

    void closeButtonPressed() override
    {
        ELOG("window closed");
        if (onClose) onClose();
    }

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(EditorWindow)
};

// ─── EditorHostApp ───────────────────────────────────────────────────────────

class EditorHostApp : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName()    override { return "xleth-editor-host"; }
    const juce::String getApplicationVersion() override { return "1.0.0"; }
    bool moreThanOneInstanceAllowed()           override { return true; }

    void initialise(const juce::String& commandLine) override
    {
        PLOG("main_entry");      // earliest user code — process CRT init already done
        logOpen();
        PLOG("juce_init_done");  // ScopedJuceInitialiser_GUI completed before initialise() fires
        ELOG("starting");
        ELOG("JUCE: %s", juce::SystemStats::getJUCEVersion().toRawUTF8());

        // ── Attempt IPC mode ─────────────────────────────────────────────────
        // commandLine = argv[1..n] joined with spaces (argv[0] stripped by JUCE).

        worker_ = std::make_unique<EditorHostWorker>();

        worker_->onInitReceived = [this](const juce::String& path,
                                         const juce::String& stateB64,
                                         const juce::String& parentHwndHex)
        {
            loadPluginAndShowEditor(path, stateB64, parentHwndHex);
        };

        worker_->onCloseReceived = [this]
        {
            ELOG("CLOS processed — quitting");
            quit();
        };

        worker_->onConnectionLost = [this]
        {
            ELOG("connection lost — quitting");
            quit();
        };

        const bool ipcOk = worker_->initialiseFromCommandLine(
            commandLine, kEditorHostUID);

        if (ipcOk)
        {
            ipcMode_ = true;
            ELOG("IPC mode — waiting for INIT message");
            ELOG("entering message loop");
            return; // Wait for INIT to arrive via handleMessageFromCoordinator.
        }

        // ── Fallback: argv[1] = plugin path ──────────────────────────────────
        // Allows manual testing:  xleth-editor-host.exe "C:\path\plugin.vst3"
        ELOG("IPC init failed (not in IPC mode) — trying argv fallback");
        worker_.reset(); // Not needed in fallback mode.

        int argc = 0;
        LPWSTR* wargv = ::CommandLineToArgvW(::GetCommandLineW(), &argc);
        const juce::String pluginPath =
            argc >= 2 ? juce::String(juce::CharPointer_UTF16(wargv[1])) : juce::String();
        ::LocalFree(wargv);

        if (pluginPath.isEmpty())
        {
            ELOG("no plugin path — usage: xleth-editor-host.exe <path.vst3>");
            quit();
            return;
        }

        ELOG("parsed args plugin=%s", pluginPath.toRawUTF8());
        loadPluginAndShowEditor(pluginPath, juce::String());
    }

    // ── Plugin loading (called on the message thread) ─────────────────────────
    void loadPluginAndShowEditor(const juce::String& pluginPath,
                                 const juce::String& stateBase64,
                                 const juce::String& parentHwndHex = juce::String())
    {
        ELOG("creating plugin format manager");
        juce::AudioPluginFormatManager formatManager;
        formatManager.addDefaultFormats();

        ELOG("format manager has %d format(s)", (int)formatManager.getNumFormats());
        for (auto* fmt : formatManager.getFormats())
            ELOG("  format: %s", fmt->getName().toRawUTF8());

        // Scan file for plugin descriptions.
        juce::OwnedArray<juce::PluginDescription> descriptions;
        for (auto* fmt : formatManager.getFormats())
        {
            if (fmt->fileMightContainThisPluginType(pluginPath))
                fmt->findAllTypesForFile(descriptions, pluginPath);
        }

        if (descriptions.isEmpty())
        {
            const juce::String err = "no plugins found in: " + pluginPath;
            ELOG("%s", err.toRawUTF8());
            if (ipcMode_ && worker_) worker_->sendError(err);
            quit();
            return;
        }

        ELOG("found %d plugin(s) — using first", (int)descriptions.size());
        ELOG("loading plugin");

        juce::String errorMsg;
        PLOG("before_create_instance");
        plugin_ = formatManager.createPluginInstance(
            *descriptions[0], 48000.0, 480, errorMsg);
        PLOG("after_create_instance");

        if (!plugin_)
        {
            const juce::String err = "createPluginInstance failed: " + errorMsg;
            ELOG("%s", err.toRawUTF8());
            if (ipcMode_ && worker_) worker_->sendError(err);
            quit();
            return;
        }

        // prepareToPlay / processBlock are driven lazily: they are invoked only
        // when the coordinator sends STRM (audio-stream start) with the
        // worker's real sample-rate and block-size. Until then the plugin sits
        // uninitialised-for-audio; its editor runs fine. See onStreamStart.

        ELOG("plugin loaded name=%s latency=%d",
             plugin_->getName().toRawUTF8(),
             plugin_->getLatencySamples());

        // Apply saved state if provided.
        if (stateBase64.isNotEmpty())
        {
            ELOG("applying saved state (%d chars base64)", stateBase64.length());
            juce::MemoryOutputStream memOut;
            if (juce::Base64::convertFromBase64(memOut, stateBase64))
            {
                const juce::MemoryBlock& stateBlock = memOut.getMemoryBlock();
                plugin_->setStateInformation(stateBlock.getData(),
                                             (int)stateBlock.getSize());
                ELOG("state applied (%d bytes)", (int)stateBlock.getSize());
            }
            else
            {
                ELOG("base64 decode failed — state not applied");
            }
        }

        // ── Attach param sync listener (IPC mode only) ────────────────────────
        if (ipcMode_ && worker_)
        {
            paramListener_ = std::make_unique<ParamSyncListener>(worker_.get());
            plugin_->addListener(paramListener_.get());
            ELOG("[ParamSync] ParamSyncListener attached (%d params)",
                 (int)plugin_->getParameters().size());

            // Wire inbound PARM: coordinator → this process's plugin.
            auto* plugin   = plugin_.get();
            auto* listener = paramListener_.get();

            worker_->onParamReceived = [plugin, listener](int paramIdx, float value)
            {
                const auto& params = plugin->getParameters();
                if (paramIdx < 0 || paramIdx >= params.size())
                {
                    ELOG("[ParamSync] PARM: idx=%d out of range (size=%d)",
                         paramIdx, (int)params.size());
                    return;
                }
                ELOG("[ParamSync] applied from worker paramIdx=%d value=%.6f",
                     paramIdx, value);
                listener->suppressNextChange(paramIdx);
                params[paramIdx]->setValueNotifyingHost(value);
            };

            // Wire inbound STAT: coordinator → this process's plugin.
            worker_->onStatReceived = [plugin, listener](const juce::String& stateB64)
            {
                ELOG("[ParamSync] STAT from worker stateLen=%d", stateB64.length());
                juce::MemoryOutputStream memOut;
                if (!juce::Base64::convertFromBase64(memOut, stateB64))
                {
                    ELOG("[ParamSync] STAT: base64 decode failed");
                    return;
                }
                const juce::MemoryBlock& state = memOut.getMemoryBlock();
                ELOG("[ParamSync] STAT: applying %d bytes", (int)state.getSize());
                listener->setBulkUpdate(true);
                plugin->setStateInformation(state.getData(), (int)state.getSize());
                listener->setBulkUpdate(false);
                ELOG("[ParamSync] STAT: applied");
            };

            // ── Audio-stream wiring (STRM/STOP) ────────────────────────────
            worker_->onStreamStart = [this](const juce::String& shmName,
                                            int sr, int bs)
            {
                startAudioStream(shmName, sr, bs);
            };
            worker_->onStreamStop = [this]
            {
                stopAudioStream();
            };
        }

        ELOG("creating editor");
        PLOG("before_create_editor");
        auto* editor = plugin_->createEditorIfNeeded();
        PLOG("after_create_editor");

        if (!editor)
        {
            const juce::String err = "plugin returned null editor (no UI)";
            ELOG("%s", err.toRawUTF8());
            if (ipcMode_ && worker_) worker_->sendError(err);
            plugin_.reset();
            quit();
            return;
        }

        ELOG("editor created size=%dx%d", editor->getWidth(), editor->getHeight());
        const int edW = editor->getWidth();
        const int edH = editor->getHeight();

        window_ = std::make_unique<EditorWindow>(plugin_->getName(), editor);

        // Wire close callback: stop pump first, then send CLSD, then quit.
        // Order is critical: pump must be joined before quit() so the process
        // exits cleanly and the coordinator's killWorkerProcess() doesn't wait
        // 8 seconds for the pump thread to finish.
        EditorHostWorker* w = ipcMode_ ? worker_.get() : nullptr;
        window_->onClose = [this, w]
        {
            // Step 1: Stop audio pump synchronously BEFORE anything else.
            if (audioPump_)
            {
                ELOG("[AudioStream] stopping pump thread before window close");
                audioPump_->stop();
                audioPump_.reset();
                if (plugin_)
                {
                    plugin_->releaseResources();
                    ELOG("[AudioStream] releaseResources called before close");
                }
            }
            // Step 2: Tell coordinator the editor is closing.
            if (w) w->sendClosed();
            // Step 3: Quit JUCE app; shutdown() has nothing left on the audio side.
            quit();
        };

        ELOG("showing window");
        window_->setVisible(true);
        window_->toFront(true);

        // ── Window parenting (EDIT-05) ────────────────────────────────────────
        // Make the editor window an owned popup of the main Xleth window so it:
        //   • minimizes/restores with the main window
        //   • stays above the main window in Z-order (but not all other apps)
        //   • does not get a separate taskbar button
        // Must be done AFTER setVisible so the HWND exists in the Win32 hierarchy.
        // GWLP_HWNDPARENT sets the OWNER (not the child-parent); the window
        // remains a top-level popup — correct semantics for plugin editors.
#ifdef _WIN32
        if (parentHwndHex.isNotEmpty())
        {
            try
            {
                const uintptr_t parentHwndVal =
                    (uintptr_t)std::stoull(parentHwndHex.toStdString(), nullptr, 16);
                const HWND parentHwnd = reinterpret_cast<HWND>(parentHwndVal);
                if (parentHwnd != nullptr)
                {
                    auto* peer = window_->getPeer();
                    if (peer)
                    {
                        const HWND editorHwnd =
                            static_cast<HWND>(peer->getNativeHandle());
                        if (editorHwnd)
                        {
                            ::SetWindowLongPtrW(editorHwnd, GWLP_HWNDPARENT,
                                               reinterpret_cast<LONG_PTR>(parentHwnd));
                            ELOG("parented to 0x%llX",
                                 (unsigned long long)(uintptr_t)parentHwnd);
                            PLOG("after_reparent");
                        }
                        else
                        {
                            ELOG("parenting skipped: no native HWND for editor window");
                        }
                    }
                    else
                    {
                        ELOG("parenting skipped: no ComponentPeer");
                    }
                }
                else
                {
                    ELOG("parenting skipped: parentHwndHex='%s' resolved to NULL",
                         parentHwndHex.toRawUTF8());
                }
            }
            catch (...)
            {
                ELOG("parenting failed: could not parse parentHwndHex='%s'",
                     parentHwndHex.toRawUTF8());
            }
        }
        else
        {
            ELOG("no parent HWND provided — window runs unparented");
        }
#endif  // _WIN32

        ELOG("entering message loop");

        // In IPC mode, notify the coordinator that the editor is ready.
        if (ipcMode_ && worker_)
        {
            PLOG("before_redy");
            worker_->sendReady(edW, edH);
        }
    }

    // ── Audio stream control (message thread) ───────────────────────────────
    // Called from the STRM IPC handler. Opens the named ring, prepares the
    // plugin for audio, and spawns the pump thread that feeds processBlock.
    void startAudioStream(const juce::String& shmName, int sampleRate, int blockSize)
    {
        if (!plugin_)
        {
            ELOG("[AudioStream] STRM ignored — plugin not loaded");
            return;
        }
        if (sampleRate <= 0 || blockSize <= 0)
        {
            ELOG("[AudioStream] STRM rejected: invalid sr=%d bs=%d",
                 sampleRate, blockSize);
            return;
        }

        // If an existing stream is running, tear it down first.
        if (audioPump_)
        {
            ELOG("[AudioStream] STRM received while pump running — restarting");
            stopAudioStream();
        }

        auto ring = NamedAudioRing::openExisting(shmName.toStdString());
        if (!ring)
        {
            ELOG("[AudioStream] failed to open ring name=%s (OpenFileMapping "
                 "err=%lu)",
                 shmName.toRawUTF8(), (unsigned long)::GetLastError());
            return;
        }
        ELOG("[AudioStream] opened ring name=%s sr=%d bs=%d",
             shmName.toRawUTF8(), sampleRate, blockSize);

        // Force forced-stereo in/out to match the worker's GuardedPluginWrapper.
        plugin_->setPlayConfigDetails(/*in*/ 2, /*out*/ 2,
                                      (double)sampleRate, blockSize);

        juce::AudioProcessor::BusesLayout stereoLayout;
        stereoLayout.inputBuses.add (juce::AudioChannelSet::stereo());
        stereoLayout.outputBuses.add(juce::AudioChannelSet::stereo());
        const bool busesOk = plugin_->setBusesLayout(stereoLayout);
        if (!busesOk)
            ELOG("[AudioStream] setBusesLayout(stereo/stereo) returned false — "
                 "continuing with plugin's existing layout");

        plugin_->prepareToPlay((double)sampleRate, blockSize);
        ELOG("[AudioStream] prepareToPlay called sr=%d bs=%d", sampleRate, blockSize);

        audioPump_ = std::make_unique<AudioPumpThread>(plugin_.get(), std::move(ring));
        ELOG("[AudioStream] pump thread started");
    }

    void stopAudioStream()
    {
        if (!audioPump_)
        {
            ELOG("[AudioStream] STOP ignored — no pump running");
            return;
        }
        ELOG("[AudioStream] stopping pump thread");
        audioPump_.reset();   // joins thread + closes ring
        if (plugin_)
        {
            plugin_->releaseResources();
            ELOG("[AudioStream] releaseResources called");
        }
    }

    void shutdown() override
    {
        ELOG("shutting down");

        // Stop audio pump before plugin teardown.
        if (audioPump_)
        {
            audioPump_.reset();
            ELOG("[AudioStream] pump thread stopped (shutdown)");
        }

        // Detach param listener before destroying the plugin.
        if (plugin_ && paramListener_)
        {
            plugin_->removeListener(paramListener_.get());
            ELOG("[ParamSync] ParamSyncListener detached");
        }
        paramListener_.reset();

        // Destroy window first (→ destroys editor → calls editorBeingDeleted).
        window_.reset();

        // Then unload the plugin.
        plugin_.reset();

        // IPC worker cleanup.
        worker_.reset();

        ELOG("exit");

        if (g_log)
        {
            std::fflush(g_log);
            std::fclose(g_log);
            g_log = nullptr;
        }
    }

    void systemRequestedQuit() override { quit(); }

private:
    bool                                       ipcMode_ {false};
    std::unique_ptr<EditorHostWorker>          worker_;
    std::unique_ptr<juce::AudioPluginInstance> plugin_;
    std::unique_ptr<EditorWindow>              window_;
    std::unique_ptr<ParamSyncListener>         paramListener_;
    std::unique_ptr<AudioPumpThread>           audioPump_;
};

START_JUCE_APPLICATION(EditorHostApp)
