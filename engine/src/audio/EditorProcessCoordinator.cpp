#include "audio/EditorProcessCoordinator.h"

#include <cstdio>

// ─── Close-path profiling globals ────────────────────────────────────────────
std::chrono::high_resolution_clock::time_point g_closeProfile_t0;
bool                                           g_closeProfileActive = false;

// ─── ParamSyncListener ───────────────────────────────────────────────────────
// Attached to the WORKER's plugin instance. Forwards outgoing param changes to
// the editor process and suppresses the echo of changes we applied from the
// editor. Defined here (not in the header) to keep the full class private.
//
// Threading:
//   audioProcessorParameterChanged may fire from any thread (RT audio thread,
//   message thread). We always dispatch IPC sends to the message thread via
//   callAsync, accepting the slight latency. The coordinator ptr is raw — caller
//   must ensure the coordinator outlives any pending callAsync lambdas.
//
// Loop prevention:
//   When we receive PARM from the editor and apply it via setValueNotifyingHost,
//   we add paramIndex to suppressedParams_ first. The listener callback fires
//   synchronously (same call stack), sees paramIndex in suppressed, removes it,
//   and returns without forwarding. Additional param changes caused by the
//   plugin's internal logic (cascading) are NOT suppressed and are forwarded.

class EditorProcessCoordinator::ParamSyncListener : public juce::AudioProcessorListener
{
public:
    explicit ParamSyncListener(EditorProcessCoordinator* coord) : coord_(coord) {}

    // Mark paramIndex to be suppressed on the next listener fire.
    // Thread-safe; called from message thread before setValueNotifyingHost.
    void suppressNextChange(int paramIndex)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        suppressedParams_.insert(paramIndex);
    }

    // Set true before a bulk state apply (setStateInformation) to silence all
    // param notifications during the apply. Reset to false immediately after.
    void setBulkUpdate(bool v) { inBulkUpdate_.store(v); }

    // ── AudioProcessorListener ────────────────────────────────────────────────

    void audioProcessorParameterChanged(juce::AudioProcessor* /*processor*/,
                                        int   parameterIndex,
                                        float newValue) override
    {
        if (inBulkUpdate_.load()) return;

        // Suppress-check: if this change was applied by us (incoming PARM from
        // the editor), remove from set and do NOT forward — loop prevention.
        {
            std::lock_guard<std::mutex> lock(mutex_);
            auto it = suppressedParams_.find(parameterIndex);
            if (it != suppressedParams_.end())
            {
                suppressedParams_.erase(it);
                std::fprintf(stderr,
                    "[EditorCoord] [ParamSync] suppressed echo paramIdx=%d\n",
                    parameterIndex);
                return;
            }
        }

        // This is a genuine local change (automation, other UI) → forward to editor.
        // Use callAsync so string building and IPC send happen on the message thread,
        // which is safe even if this callback fired from the RT audio thread.
        std::fprintf(stderr,
            "[EditorCoord] [ParamSync] worker→editor paramIdx=%d value=%.6f\n",
            parameterIndex, newValue);

        auto* c = coord_;
        juce::MessageManager::callAsync([c, parameterIndex, newValue]
        {
            c->sendParamChange(parameterIndex, newValue);
        });
    }

    void audioProcessorChanged(juce::AudioProcessor* processor,
                               const ChangeDetails&  details) override
    {
        if (inBulkUpdate_.load()) return;

        // Only sync on program/preset changes — not on every trivial state update.
        if (!details.programChanged && !details.nonParameterStateChanged) return;

        std::fprintf(stderr,
            "[EditorCoord] [ParamSync] worker program changed — sending STAT\n");

        juce::MemoryBlock state;
        processor->getStateInformation(state);

        auto* c = coord_;
        juce::MessageManager::callAsync([c, state]
        {
            c->sendStateChange(state);
        });
    }

private:
    EditorProcessCoordinator* coord_;
    std::mutex                mutex_;
    std::unordered_set<int>   suppressedParams_;
    std::atomic<bool>         inBulkUpdate_ {false};
};

// ─── Constructor / Destructor ─────────────────────────────────────────────────

EditorProcessCoordinator::EditorProcessCoordinator(juce::AudioPluginInstance* workerPlugin)
    : workerPlugin_(workerPlugin)
{
    if (workerPlugin_)
    {
        paramListener_ = std::make_unique<ParamSyncListener>(this);
        workerPlugin_->addListener(paramListener_.get());
        std::fprintf(stderr, "[EditorCoord] ParamSyncListener attached to worker plugin\n");
    }
}

EditorProcessCoordinator::~EditorProcessCoordinator()
{
    CPLOG("dtor_entered");

    // Hold applyMutex_ before touching workerPlugin_ / paramListener_ so we
    // cannot race with a PARM/STAT apply that is mid-flight on the poll thread.
    {
        std::lock_guard<std::recursive_mutex> lock(applyMutex_);
        if (workerPlugin_ && paramListener_)
        {
            workerPlugin_->removeListener(paramListener_.get());
            std::fprintf(stderr, "[EditorCoord] ParamSyncListener detached\n");
        }
    }

    // Call killWorkerProcess() explicitly so we can bracket it with timing.
    // What it does (juce_ConnectedChildProcess.cpp):
    //   1. sendMessageToWorker("__ipc_k_") — sends kill signal to editor-host
    //   2. connection->disconnect()         — closes the named pipe
    //   3. connection.reset()               — ~Connection() → stopThread(10000)
    //                                         BLOCKS up to 10 s for ping thread!
    //   4. childProcess.reset()             — shared_ptr to ChildProcess released
    // ~ChildProcessCoordinator() will call killWorkerProcess() again, but finds
    // connection==nullptr and childProcess==nullptr → instant no-op.
    //
    // dtor_before/after_pipe_close cannot be separated without patching JUCE
    // source — the pipe close (step 2+3) is inside killWorkerProcess().
    CPLOG("dtor_before_kill_child");
    {
        auto killStart = std::chrono::high_resolution_clock::now();
        killWorkerProcess();
        double killMs = std::chrono::duration<double, std::milli>(
            std::chrono::high_resolution_clock::now() - killStart).count();
        if (killMs > 500.0)
        {
            std::fprintf(stderr,
                "[EditorCoord] editor-host did not exit within 500ms, "
                "force-killing (actual: %.0fms)\n", killMs);
            std::fflush(stderr);
        }
    }
    CPLOG("dtor_after_kill_child");

    CPLOG("dtor_exit");
    // ~ChildProcessCoordinator() runs implicitly: calls killWorkerProcess() (no-op).
}

// ─── setWorkerPlugin ─────────────────────────────────────────────────────────

void EditorProcessCoordinator::setWorkerPlugin(juce::AudioPluginInstance* plugin)
{
    std::lock_guard<std::recursive_mutex> lock(applyMutex_);

    // Detach from old plugin.
    if (workerPlugin_ && paramListener_)
        workerPlugin_->removeListener(paramListener_.get());

    workerPlugin_ = plugin;
    paramListener_.reset();

    if (workerPlugin_)
    {
        paramListener_ = std::make_unique<ParamSyncListener>(this);
        workerPlugin_->addListener(paramListener_.get());
        std::fprintf(stderr,
            "[EditorCoord] ParamSyncListener attached to worker plugin (%d params)\n",
            (int)workerPlugin_->getParameters().size());
    }
}

// ─── start ───────────────────────────────────────────────────────────────────

bool EditorProcessCoordinator::start(const juce::File&   editorHostExe,
                                     const juce::String& pluginPath,
                                     const juce::String& stateBase64,
                                     const juce::String& parentHwndHex)
{
    openStart_ = std::chrono::high_resolution_clock::now();
    std::fprintf(stderr, "[EditorCoord] start: plugin=%s parent=0x%s\n",
                 pluginPath.toRawUTF8(),
                 parentHwndHex.isEmpty() ? "0" : parentHwndHex.toRawUTF8());

    if (!editorHostExe.existsAsFile())
    {
        std::fprintf(stderr, "[EditorCoord] xleth-editor-host.exe not found at: %s\n",
                     editorHostExe.getFullPathName().toRawUTF8());
        return false;
    }

    if (!launchWorkerProcess(editorHostExe, kEditorHostUID))
    {
        std::fprintf(stderr, "[EditorCoord] Failed to launch worker process\n");
        return false;
    }

    std::fprintf(stderr, "[EditorCoord] Worker process launched. Sending INIT.\n");

    // INIT\n<pluginPath>\n<stateBase64>\n<parentHwndHex>
    // parentHwndHex is empty if the main window HWND was not yet set.
    const juce::String initPayload =
        "INIT\n" + pluginPath + "\n" + stateBase64 + "\n" + parentHwndHex;
    const juce::MemoryBlock msgBlock(initPayload.toRawUTF8(),
                                     (size_t)initPayload.getNumBytesAsUTF8());

    std::fprintf(stderr, "[EditorCoord] [EditorHost IPC] Sending INIT (%d bytes)\n",
                 (int)msgBlock.getSize());

    if (!sendMessageToWorker(msgBlock))
    {
        std::fprintf(stderr, "[EditorCoord] sendMessageToWorker(INIT) failed\n");
        return false;
    }

    {
        double ms = std::chrono::duration<double, std::milli>(
            std::chrono::high_resolution_clock::now() - openStart_).count();
        std::fprintf(stderr, "[OpenProfile] stage=INIT_sent elapsed_ms=%.3f\n", ms);
        std::fflush(stderr);
    }

    std::fprintf(stderr, "[EditorCoord] INIT sent — waiting for REDY\n");
    return true;
}

// ─── close ───────────────────────────────────────────────────────────────────

void EditorProcessCoordinator::close()
{
    if (editorClosed_.load())
    {
        std::fprintf(stderr, "[EditorCoord] close() called but editor already closed\n");
        return;
    }

    std::fprintf(stderr, "[EditorCoord] Sending CLOS\n");
    const juce::String closStr = "CLOS";
    const juce::MemoryBlock closBlock(closStr.toRawUTF8(),
                                      (size_t)closStr.getNumBytesAsUTF8());
    std::fprintf(stderr, "[EditorCoord] [EditorHost IPC] Sending CLOS (%d bytes)\n",
                 (int)closBlock.getSize());
    sendMessageToWorker(closBlock);
}

// ─── sendParamChange ─────────────────────────────────────────────────────────

void EditorProcessCoordinator::sendParamChange(int paramIndex, float normalizedValue)
{
    // PARM\n<paramIndex>\n<value>
    const juce::String msg =
        "PARM\n" + juce::String(paramIndex) + "\n" + juce::String(normalizedValue, 6);
    const juce::MemoryBlock mb(msg.toRawUTF8(), (size_t)msg.getNumBytesAsUTF8());

    std::fprintf(stderr,
        "[EditorCoord] [ParamSync] [EditorHost IPC] Sending PARM worker→editor"
        " idx=%d value=%.6f (%d bytes)\n",
        paramIndex, normalizedValue, (int)mb.getSize());

    sendMessageToWorker(mb);
}

// ─── sendStateChange ─────────────────────────────────────────────────────────

void EditorProcessCoordinator::sendStateChange(const juce::MemoryBlock& stateBlock)
{
    juce::MemoryOutputStream mos;
    juce::Base64::convertToBase64(mos, stateBlock.getData(), stateBlock.getSize());
    juce::String b64 = mos.toString();

    const juce::String msg = "STAT\n" + b64;
    const juce::MemoryBlock mb(msg.toRawUTF8(), (size_t)msg.getNumBytesAsUTF8());

    std::fprintf(stderr,
        "[EditorCoord] [ParamSync] [EditorHost IPC] Sending STAT"
        " (%d state bytes → %d bytes IPC)\n",
        (int)stateBlock.getSize(), (int)mb.getSize());

    sendMessageToWorker(mb);
}

// ─── sendStreamStart / sendStreamStop ────────────────────────────────────────

void EditorProcessCoordinator::sendStreamStart(const std::string& shmName,
                                               int                sampleRate,
                                               int                blockSize)
{
    const juce::String msg =
        "STRM\n" + juce::String(shmName) + "\n"
        + juce::String(sampleRate) + "\n"
        + juce::String(blockSize);
    const juce::MemoryBlock mb(msg.toRawUTF8(), (size_t)msg.getNumBytesAsUTF8());

    std::fprintf(stderr,
        "[AudioStream] [EditorHost IPC] Sending STRM name=%s sr=%d bs=%d (%d bytes)\n",
        shmName.c_str(), sampleRate, blockSize, (int)mb.getSize());
    std::fflush(stderr);

    sendMessageToWorker(mb);
}

void EditorProcessCoordinator::sendStreamStop()
{
    const juce::String msg = "STOP";
    const juce::MemoryBlock mb(msg.toRawUTF8(), (size_t)msg.getNumBytesAsUTF8());

    std::fprintf(stderr,
        "[AudioStream] [EditorHost IPC] Sending STOP (%d bytes)\n",
        (int)mb.getSize());
    std::fflush(stderr);

    sendMessageToWorker(mb);
}

// ─── handleMessageFromWorker ─────────────────────────────────────────────────

void EditorProcessCoordinator::handleMessageFromWorker(const juce::MemoryBlock& mb)
{
    const juce::String msg = mb.toString();
    std::fprintf(stderr,
        "[EditorCoord] [EditorHost IPC] Message from worker (%d bytes): %.80s\n",
        (int)mb.getSize(), msg.toRawUTF8());

    if (msg.startsWith("REDY"))
    {
        const juce::String dim = msg.fromFirstOccurrenceOf("\n", false, false).trim();
        const int xPos = dim.indexOfChar('x');
        if (xPos > 0)
        {
            editorWidth_  = dim.substring(0, xPos).getIntValue();
            editorHeight_ = dim.substring(xPos + 1).getIntValue();
        }
        editorReady_.store(true);

        {
            double ms = std::chrono::duration<double, std::milli>(
                std::chrono::high_resolution_clock::now() - openStart_).count();
            std::fprintf(stderr, "[OpenProfile] stage=REDY_received elapsed_ms=%.3f\n", ms);
            std::fflush(stderr);
        }

        std::fprintf(stderr, "[EditorCoord] REDY received WxH=%dx%d\n",
                     editorWidth_, editorHeight_);

        if (onReady_)
        {
            const int w = editorWidth_, h = editorHeight_;
            auto cb = onReady_;
            juce::MessageManager::callAsync([cb, w, h]{ cb(w, h); });
        }
    }
    else if (msg.startsWith("CLSD"))
    {
        // ── Close-path profiling: t0 ──────────────────────────────────────────
        g_closeProfile_t0    = std::chrono::high_resolution_clock::now();
        g_closeProfileActive = true;
        std::fprintf(stderr, "[CloseProfile] stage=CLSD_received elapsed_ms=0.000\n");
        std::fflush(stderr);
        // ─────────────────────────────────────────────────────────────────────

        std::fprintf(stderr, "[EditorCoord] editor closed by user\n");
        editorClosed_.store(true);

        if (onClosed_)
        {
            // Invoke directly on the IPC poll thread — same fix as the PARM handler.
            // callAsync would queue this on the JUCE message thread which is never
            // pumped in the addon-worker process (libuv doesn't drive Win32 messages),
            // causing the map erase to stall until the next openPluginEditor drains it.
            auto ms_enter = std::chrono::duration<double, std::milli>(
                std::chrono::high_resolution_clock::now() - g_closeProfile_t0).count();
            std::fprintf(stderr,
                "[CloseProfile] stage=onClosed_entering_on_poll_thread elapsed_ms=%.3f\n",
                ms_enter);
            std::fflush(stderr);
            onClosed_();
            auto ms_exit = std::chrono::duration<double, std::milli>(
                std::chrono::high_resolution_clock::now() - g_closeProfile_t0).count();
            std::fprintf(stderr,
                "[CloseProfile] stage=onClosed_returned elapsed_ms=%.3f\n",
                ms_exit);
            std::fflush(stderr);
        }
    }
    else if (msg.startsWith("ERR_"))
    {
        errorMessage_ = msg.fromFirstOccurrenceOf("\n", false, false)
                            .trim().toStdString();
        std::fprintf(stderr, "[EditorCoord] ERR_ received: %s\n", errorMessage_.c_str());
        editorClosed_.store(true);

        if (onClosed_)
            onClosed_();
    }
    else if (msg.startsWith("PARM"))
    {
        // PARM from editor (user turned a knob) → apply to worker plugin.
        //
        // Previously dispatched via juce::MessageManager::callAsync, but the
        // addon-worker process has no mechanism pumping the JUCE message queue
        // (libuv does not pump Win32 messages; ScopedJuceInitialiser_GUI is
        // constructed but its dispatch loop is never driven). The callAsync
        // lambdas queued forever and setValueNotifyingHost was never called.
        //
        // Fix: apply directly on the ChildProcessCoordinator poll thread.
        // setValueNotifyingHost is safe from any non-audio thread. applyMutex_
        // serialises this against destructor teardown and setWorkerPlugin.
        //
        // TODO: when the dedicated JUCE message thread refactor lands (see
        // PluginEditorHost.cpp) this path may move back to callAsync — but only
        // after verifying the message thread is actually pumped in the worker.
        juce::StringArray lines;
        lines.addTokens(msg, "\n", "");
        const int   paramIdx = lines.size() > 1 ? lines[1].getIntValue()   : -1;
        const float value    = lines.size() > 2 ? lines[2].getFloatValue() : 0.0f;

        std::fprintf(stderr,
            "[EditorCoord] [ParamSync] editor→worker paramIdx=%d value=%.6f\n",
            paramIdx, value);

        std::lock_guard<std::recursive_mutex> lock(applyMutex_);

        if (!workerPlugin_ || !paramListener_)
        {
            std::fprintf(stderr,
                "[EditorCoord] [ParamSync] no worker plugin — param change ignored\n");
            return;
        }

        const auto& params = workerPlugin_->getParameters();
        if (paramIdx < 0 || paramIdx >= params.size())
        {
            std::fprintf(stderr,
                "[EditorCoord] [ParamSync] PARM: idx=%d out of range (size=%d)\n",
                paramIdx, (int)params.size());
            return;
        }

        std::fprintf(stderr,
            "[EditorCoord] [ParamSync] applied from editor paramIdx=%d value=%.6f\n",
            paramIdx, value);
        paramListener_->suppressNextChange(paramIdx);
        params[paramIdx]->setValueNotifyingHost(value);
    }
    else if (msg.startsWith("STAT"))
    {
        // STAT from editor (preset loaded in editor) → apply to worker plugin.
        // Same rationale as PARM above — apply directly on the poll thread.
        // NOTE: some VST3 plugins assume setStateInformation runs on the UI/message
        // thread (e.g. plugins that cache wavetables or touch UI state during load).
        // If a plugin crashes or misbehaves on preset load, this is the likely cause —
        // report it and consider a dedicated apply thread for STAT only.
        const juce::String stateB64 =
            msg.fromFirstOccurrenceOf("\n", false, false).trim();

        std::fprintf(stderr,
            "[EditorCoord] [ParamSync] STAT from editor stateLen=%d\n",
            stateB64.length());

        std::lock_guard<std::recursive_mutex> lock(applyMutex_);

        if (!workerPlugin_ || !paramListener_)
        {
            std::fprintf(stderr,
                "[EditorCoord] [ParamSync] no worker plugin — STAT ignored\n");
            return;
        }

        juce::MemoryOutputStream memOut;
        if (!juce::Base64::convertFromBase64(memOut, stateB64))
        {
            std::fprintf(stderr,
                "[EditorCoord] [ParamSync] STAT: base64 decode failed\n");
            return;
        }
        const juce::MemoryBlock& state = memOut.getMemoryBlock();
        std::fprintf(stderr,
            "[EditorCoord] [ParamSync] STAT: applying %d bytes to worker plugin\n",
            (int)state.getSize());

        paramListener_->setBulkUpdate(true);
        workerPlugin_->setStateInformation(state.getData(), (int)state.getSize());
        paramListener_->setBulkUpdate(false);

        std::fprintf(stderr,
            "[EditorCoord] [ParamSync] STAT: applied\n");
    }
    else
    {
        std::fprintf(stderr, "[EditorCoord] Unknown message tag: %.8s\n",
                     msg.toRawUTF8());
    }
}

// ─── handleConnectionLost ────────────────────────────────────────────────────

void EditorProcessCoordinator::handleConnectionLost()
{
    std::fprintf(stderr, "[EditorCoord] Connection to editor-host lost\n");

    if (editorClosed_.exchange(true))
        return; // already handled via CLSD

    if (onClosed_)
        onClosed_();
}
