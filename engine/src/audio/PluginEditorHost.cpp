#include "audio/PluginEditorHost.h"
#include "audio/PluginCrashGuard.h"

#include <cstdio>

// ─── PluginEditorWindow ──────────────────────────────────────────────────────

PluginEditorWindow::PluginEditorWindow(const juce::String& title,
                                       PluginEditorHost*   host,
                                       int                 trackId,
                                       int                 nodeId)
    : juce::DocumentWindow(title,
                           juce::Colours::darkgrey,
                           juce::DocumentWindow::closeButton),
      host_(host),
      trackId_(trackId),
      nodeId_(nodeId)
{
    setUsingNativeTitleBar(true);
    setResizable(false, false);
}

void PluginEditorWindow::closeButtonPressed()
{
    // Hide immediately so the window disappears to the user.
    setVisible(false);

    // Schedule the actual destruction on the next message-loop iteration so we
    // never delete 'this' while still unwinding from the button-press callback.
    // Component::SafePointer becomes null when this window is destroyed (e.g.
    // by a concurrent closeAllEditors call), making the lambda a safe no-op.
    juce::Component::SafePointer<PluginEditorWindow> safeThis(this);
    auto* h   = host_;
    int   tid = trackId_;
    int   nid = nodeId_;

    juce::MessageManager::callAsync([safeThis, h, tid, nid]
    {
        // If the window was already destroyed (e.g. closeAllEditors() ran
        // between the button click and this deferred call), safeThis is null
        // and we must NOT dereference h — it may point to freed memory.
        if (safeThis != nullptr)
            h->closeEditor(tid, nid);
    });
}

// ─── PluginEditorHost ────────────────────────────────────────────────────────

PluginEditorHost::~PluginEditorHost()
{
    // Destroy all open windows before the host is freed so there are no
    // dangling PluginEditorHost* pointers stored in PluginEditorWindow.
    // This is a synchronous clear — no async messages are pending at this
    // point because JUCE message loop is idle during shutdown teardown.
    openEditors_.clear();
}

// ── Threading note ───────────────────────────────────────────────────────────
// In Xleth, the N-API main thread and the JUCE message thread are THE SAME
// thread (ScopedJuceInitialiser_GUI is constructed on the Node.js main thread).
// Every synchronous N-API call therefore blocks JUCE's message dispatch for its
// duration — delaying VST editor timer callbacks and repaint events.
//
// If Win32 marks the Electron main window "Not Responding":
//   1. Check [IPC-SLOW] lines in stderr — they indicate which N-API function is
//      the bottleneck.  The 10 ms threshold is set in XlethAddon.cpp.
//   2. Common culprit: audio_getAllPeaks (called at 20 Hz by the peak meter loop
//      in MixerPanel.jsx) iterating many tracks under the timeline lock.
//   3. createEditorIfNeeded() below can take 50-300 ms for VST3 plugins that load
//      GUI resources lazily.  This is a one-shot stall on first open.
//
// Long-term fix: move JUCE's message thread to a dedicated worker thread so IPC
// and VST editor dispatch are fully decoupled (Option A from the architecture doc).
// ─────────────────────────────────────────────────────────────────────────────
bool PluginEditorHost::openEditor(juce::AudioProcessor* plugin,
                                  int                   trackId,
                                  int                   nodeId)
{
    if (!plugin) return false;

    auto key = std::make_pair(trackId, nodeId);

    // Already open — bring to front.
    auto it = openEditors_.find(key);
    if (it != openEditors_.end())
    {
        it->second->toFront(true);
        return true;
    }

    // Ask the plugin for an editor component.  Outer SEH guard: even though the
    // GuardedPluginWrapper guards createEditor() internally, this belt-and-braces
    // layer protects against any unwrapped AudioPluginInstance and against faults
    // in JUCE's intermediate createEditorIfNeeded machinery.
    juce::AudioProcessorEditor* editor = nullptr;
    const bool editorOk = xleth::pluginGuardCall([&]
    {
        editor = plugin->createEditorIfNeeded();
    });
    if (!editorOk)
    {
#ifdef XLETH_DEBUG
        std::fprintf(stderr,
                     "[PluginHost] Editor failed: \"%s\" — createEditor crashed\n",
                     plugin->getName().toRawUTF8());
#endif
        return false;
    }
    if (!editor)
    {
#ifdef XLETH_DEBUG
        std::fprintf(stderr, "[PluginHost] Editor failed: \"%s\" — no editor available\n",
                     plugin->getName().toRawUTF8());
#endif
        return false;
    }

    // Build window title.
    juce::String title = plugin->getName() + " \xe2\x80\x94 ";   // — (em dash, UTF-8)
    if (trackId == -1)
        title += "Master";
    else
        title += "Track " + juce::String(trackId);

    auto window = std::make_unique<PluginEditorWindow>(title, this, trackId, nodeId);
    window->setContentOwned(editor, true);   // window owns editor; resizes to fit

    // Check for suspiciously small editor (probable missing DPI awareness).
    // In that case, we still open it at the reported size — trust the plugin.
    // (The PositionInfo struct has a dpiScale field reserved for future scaling.)
    const int editorW = window->getWidth();
    const int editorH = window->getHeight();

    // Position: restore saved only if it is on a currently connected monitor.
    // Discarding off-screen coords prevents windows opening on a disconnected
    // secondary display where they'd be invisible and unreachable.
    const juce::String posKey = plugin->getName();
    auto pit = savedPositions_.find(posKey);
    bool restoredPosition = false;
    if (pit != savedPositions_.end() && pit->second.hasPosition)
    {
        // Validate the saved position is on a currently connected monitor.
        // Iterate all displays — findDisplayForRect is deprecated in JUCE 8.
        bool positionOnScreen = false;
        const auto& disps = juce::Desktop::getInstance().getDisplays();
        for (const auto& d : disps.displays)
        {
            if (d.totalArea.contains(pit->second.position))
            {
                positionOnScreen = true;
                break;
            }
        }
        if (positionOnScreen)
        {
            window->setTopLeftPosition(pit->second.position);
            restoredPosition = true;
        }
    }
    if (!restoredPosition)
        window->centreWithSize(editorW, editorH);

    // Clamp to the display's usable area so the window is always accessible.
    if (auto* display = juce::Desktop::getInstance().getDisplays().getPrimaryDisplay())
    {
        auto bounds = window->getBounds().constrainedWithin(display->userArea);
        window->setBounds(bounds);
    }

    // Stay above Electron so the plugin window is immediately findable.
    window->setAlwaysOnTop(true);
    window->setVisible(true);
    window->toFront(true);

#ifdef XLETH_DEBUG
    std::fprintf(stderr,
                 "[PluginHost] Editor opened: \"%s\" (track %d, node %d) — %dx%d,"
                 " visible=%d, onDesktop=%d, bounds=(%d,%d,%d,%d)\n",
                 plugin->getName().toRawUTF8(), trackId, nodeId, editorW, editorH,
                 (int)window->isVisible(),
                 (int)window->isOnDesktop(),
                 window->getX(), window->getY(), window->getWidth(), window->getHeight());
#endif

    openEditors_[key] = std::move(window);

#ifdef XLETH_DEBUG
    // Start the heartbeat on the first editor opened so we can detect message
    // thread starvation while any VST editor is on screen.
    if (openEditors_.size() == 1)
    {
        heartbeat_ = std::make_unique<MessageThreadHeartbeat>();
        heartbeat_->startTimer(500);
        std::fprintf(stderr, "[MsgThread] Heartbeat started (editor count: 1)\n");
    }
#endif

    return true;
}

void PluginEditorHost::closeEditor(int trackId, int nodeId)
{
    auto key = std::make_pair(trackId, nodeId);
    auto it  = openEditors_.find(key);
    if (it == openEditors_.end()) return;

    // Save window position before destruction.
    if (auto* win = it->second.get())
    {
        auto* editor = dynamic_cast<juce::AudioProcessorEditor*>(win->getContentComponent());
        if (editor)
        {
            const juce::String posKey = editor->getAudioProcessor()->getName();
            savedPositions_[posKey] = { win->getPosition(), true };
#ifdef XLETH_DEBUG
            std::fprintf(stderr, "[PluginHost] Editor closed: \"%s\"\n",
                         posKey.toRawUTF8());
#endif
        }
    }

    openEditors_.erase(it);   // unique_ptr destructor: window → editor destroyed

#ifdef XLETH_DEBUG
    if (openEditors_.empty() && heartbeat_)
    {
        heartbeat_->stopTimer();
        heartbeat_.reset();
        std::fprintf(stderr, "[MsgThread] Heartbeat stopped (no open editors)\n");
    }
#endif
}

void PluginEditorHost::closeEditorsForTrack(int trackId)
{
    // Collect keys first — erasing while iterating is undefined.
    std::vector<std::pair<int, int>> toClose;
    for (const auto& [key, _] : openEditors_)
        if (key.first == trackId)
            toClose.push_back(key);

    for (const auto& key : toClose)
        closeEditor(key.first, key.second);
}

void PluginEditorHost::closeAllEditors()
{
    std::vector<std::pair<int, int>> toClose;
    toClose.reserve(openEditors_.size());
    for (const auto& [key, _] : openEditors_)
        toClose.push_back(key);

    for (const auto& key : toClose)
        closeEditor(key.first, key.second);
}

bool PluginEditorHost::isEditorOpen(int trackId, int nodeId) const
{
    return openEditors_.count({ trackId, nodeId }) > 0;
}
