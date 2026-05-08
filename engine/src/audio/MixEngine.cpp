#include "audio/MixEngine.h"
#include "audio/TrackMixer.h"
#include "audio/SampleProcessor.h"
#include "audio/EffectChainManager.h"
#include "audio/EditorProcessCoordinator.h"
#include "audio/GuardedPluginWrapper.h"
#include "audio/PluginRegistry.h"
#include "audio/PluginEditorHost.h"
#include "audio/XlethEffectBase.h"
#include "audio/ClipFade.h"
#include "audio/WorldStretchCache.h"
#include "dsp/DeclickEnvelope.h"
#include "model/ClipModulationCompatibility.h"
#include "XlethDebug.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <cstdarg>
#include <cstdio>
#include <thread>

// ─── MixDebugLog ─────────────────────────────────────────────────────────────

int MixDebugLog::nextPow2(int v)
{
    int p = 1;
    while (p < v) p <<= 1;
    return p;
}

MixDebugLog::MixDebugLog(int capacity)
{
    const int cap = nextPow2(capacity);
    buffer_.resize(static_cast<size_t>(cap));
    mask_ = cap - 1;
}

bool MixDebugLog::push(const MixDebugEntry& entry)
{
    const int w = writePos_.load(std::memory_order_relaxed);
    const int r = readPos_.load(std::memory_order_acquire);
    if (((w + 1) & mask_) == (r & mask_))
        return false; // full — drop
    buffer_[w & mask_] = entry;
    writePos_.store((w + 1) & mask_, std::memory_order_release);
    return true;
}

bool MixDebugLog::pop(MixDebugEntry& entry)
{
    const int r = readPos_.load(std::memory_order_relaxed);
    const int w = writePos_.load(std::memory_order_acquire);
    if (r == w)
        return false; // empty
    entry = buffer_[r & mask_];
    readPos_.store((r + 1) & mask_, std::memory_order_release);
    return true;
}

// ─── MixEngine ───────────────────────────────────────────────────────────────


MixEngine::MixEngine()
{
    trackBuffers_.resize(kMaxTracks);
    activeClips_.reserve(256);
    activeBlocks_.reserve(64);

    // WORLD vocoder content cache lives next to ClipRenderCache so the WORLD
    // dispatch branch (worker thread) can reuse analysis across pitch toggles.
    worldStretchCache_ = std::make_unique<xleth::audio::WorldStretchCache>();
    clipRenderCache_.setWorldCache(worldStretchCache_.get());

    // Create plugin registry (registers VST3 format manager).
    pluginRegistry_ = std::make_unique<PluginRegistry>();
    editorHost_     = std::make_unique<PluginEditorHost>();

    // Attempt to warm the known-plugin list from the on-disk cache.
    // %APPDATA%\Xleth\plugin-cache.xml — silently skipped if absent.
    juce::File cacheFile = juce::File::getSpecialLocation(
                               juce::File::userApplicationDataDirectory)
                           .getChildFile("Xleth")
                           .getChildFile("plugin-cache.xml");
    pluginRegistry_->loadScanResults(cacheFile);

    coordinatorReaperThread_ = std::thread([this]() { runCoordinatorReaper(); });

    xleth::dsp::DeclickEnvelope::initialize();
}

MixEngine::~MixEngine()
{
    // Stop and join the reaper thread first. The loop drains any queued
    // coordinators before exiting (reaperStop_ && empty → return).
    {
        std::lock_guard<std::mutex> lock(reaperMutex_);
        reaperStop_.store(true);
    }
    reaperCv_.notify_all();
    if (coordinatorReaperThread_.joinable())
        coordinatorReaperThread_.join();

    // Close all out-of-process VST editors. Any coordinators still in the map
    // (editors open at shutdown) are destroyed here from the destructor thread —
    // safe because no poll thread will self-join (they're joining the reaper, now gone).
    {
        std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
        vstEditorCoordinators_.clear();
    }

    // Close all in-process editor windows (stock effects).
    // This ensures AudioProcessorEditor is released before AudioProcessor.
    if (editorHost_)
        editorHost_->closeAllEditors();
}

// ── Coordinator reaper ────────────────────────────────────────────────────────

void MixEngine::runCoordinatorReaper()
{
    while (true)
    {
        std::unique_ptr<EditorProcessCoordinator> toDestroy;
        {
            std::unique_lock<std::mutex> lock(reaperMutex_);
            reaperCv_.wait(lock, [this] {
                return reaperStop_.load() || !reaperQueue_.empty();
            });
            if (reaperStop_.load() && reaperQueue_.empty())
                return;
            toDestroy = std::move(reaperQueue_.front());
            reaperQueue_.pop_front();
        }
        auto t0 = std::chrono::high_resolution_clock::now();
        toDestroy.reset(); // synchronous destruction — may block 8-10 s on dead IPC pipe
        double ms = std::chrono::duration<double, std::milli>(
            std::chrono::high_resolution_clock::now() - t0).count();
        std::fprintf(stderr,
            "[CloseProfile] reaper destroyed coordinator in %.0fms\n", ms);
        std::fflush(stderr);
    }
}

void MixEngine::reapCoordinator(std::unique_ptr<EditorProcessCoordinator> dying)
{
    if (!dying) return;
    {
        std::lock_guard<std::mutex> lock(reaperMutex_);
        reaperQueue_.push_back(std::move(dying));
    }
    reaperCv_.notify_one();
}

// ── Plugin registry ───────────────────────────────────────────────────────────

PluginRegistry& MixEngine::getPluginRegistry()
{
    return *pluginRegistry_;
}

// ── Plugin editor host ────────────────────────────────────────────────────────

void MixEngine::setEditorHostExe(const std::string& exePath)
{
    editorHostExePath_ = exePath;
}

void MixEngine::setMainWindowHandle(uintptr_t hwnd)
{
    mainWindowHwnd_.store(hwnd);
    std::fprintf(stderr, "[EditorFlow] Main window handle stored: 0x%llX\n",
                 (unsigned long long)hwnd);
}

bool MixEngine::openPluginEditor(int trackId, int nodeId)
{
    // Close-path profiling: measure how long after CLSD_received the next open
    // arrives. Only logged when a close actually happened (flag set in CLSD handler).
    if (g_closeProfileActive)
    {
        CPLOG("new_open_arrived");
        g_closeProfileActive = false;

        // Check whether the old coordinator is still in the map.
        // If it is, onClosed_ has not fired yet — cleanup is still pending,
        // and the new open will race with the deferred teardown.
        const auto probeKey = std::make_pair(trackId, nodeId);
        std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
        auto it = vstEditorCoordinators_.find(probeKey);
        if (it != vstEditorCoordinators_.end())
        {
            std::fprintf(stderr,
                "[CloseProfile] WARNING old coordinator STILL IN MAP for "
                "track=%d node=%d isEditorClosed=%d — onClosed_ not yet fired\n",
                trackId, nodeId, (int)it->second->isEditorClosed());
        }
        else
        {
            std::fprintf(stderr,
                "[CloseProfile] map.find() = end — old coordinator already "
                "removed (onClosed_ fired before new open)\n");
        }
    }

    // Fetch the processor and plugin file path under lock, then release before
    // touching the GUI. Holding chainsMutex_ while creating a window is forbidden.
    juce::AudioProcessor* proc = nullptr;
    juce::String          pluginFilePath;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        EffectChainManager* chain = nullptr;
        if (trackId == -1)
        {
            chain = masterEffectChain_.get();
        }
        else
        {
            auto it = effectChains_.find(trackId);
            if (it != effectChains_.end()) chain = it->second.get();
        }
        if (chain)
        {
            proc           = chain->getProcessor(nodeId);
            pluginFilePath = chain->getPluginFilePath(nodeId);
        }
    }

    if (!proc) return false;

    // ── Route: VST node → out-of-process editor ──────────────────────────────
    auto* wrapper = dynamic_cast<GuardedPluginWrapper*>(proc);
    if (wrapper && pluginFilePath.isNotEmpty())
    {
        const auto key = std::make_pair(trackId, nodeId);

        // Already open and alive — nothing to do.
        {
            std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
            auto it = vstEditorCoordinators_.find(key);
            if (it != vstEditorCoordinators_.end() && !it->second->isEditorClosed())
            {
                std::fprintf(stderr,
                    "[EditorFlow] VST editor already open: track=%d node=%d\n",
                    trackId, nodeId);
                return true;
            }
            vstEditorCoordinators_.erase(key);  // remove stale closed entry if any
        }

        // Validate editor-host exe.
        const juce::File editorHostExe{juce::String(editorHostExePath_)};
        if (!editorHostExe.existsAsFile())
        {
            std::fprintf(stderr,
                "[EditorFlow] xleth-editor-host.exe not found at: %s\n",
                editorHostExe.getFullPathName().toRawUTF8());
            return false;
        }

        // Serialize current plugin state for the editor process.
        juce::MemoryBlock stateBlock;
        proc->getStateInformation(stateBlock);
        juce::String stateBase64;
        if (stateBlock.getSize() > 0)
        {
            juce::MemoryOutputStream mos;
            juce::Base64::convertToBase64(mos, stateBlock.getData(), stateBlock.getSize());
            stateBase64 = mos.toString();
        }

        // Extract the inner AudioPluginInstance for bidirectional param sync.
        // The coordinator will attach a listener to it. nullptr disables sync.
        auto* pluginInstance =
            dynamic_cast<juce::AudioPluginInstance*>(wrapper->getInner());

        // Create coordinator and wire close callback.
        auto coord = std::make_unique<EditorProcessCoordinator>(pluginInstance);

        coord->onClosed_ = [this, key, wrapper]()
        {
            // This lambda was dispatched via callAsync. The elapsed shown here
            // vs. before_onClosed_callback_invoked reveals Win32 message-queue
            // latency in the addon-worker process (prime suspect for 6 s gap).
            CPLOG("on_closed_callback_start");
            std::fprintf(stderr,
                "[EditorFlow] VST editor closed (CLSD/ERR_): track=%d node=%d\n",
                key.first, key.second);

            // Tear down the worker-side audio ring first (editor-host is gone).
            CPLOG("before_disable_ring");
            if (wrapper) wrapper->disableAudioStream();
            CPLOG("after_disable_ring");

            // Extract the coordinator from the map without destroying it yet,
            // so the destructor (which may block in stopThread) runs OUTSIDE
            // the mutex and can be timed independently.
            std::unique_ptr<EditorProcessCoordinator> dying;
            CPLOG("before_erase_from_coordinator_map");
            {
                std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
                auto it = vstEditorCoordinators_.find(key);
                if (it != vstEditorCoordinators_.end())
                {
                    dying = std::move(it->second);   // take ownership; map entry now null
                    vstEditorCoordinators_.erase(it); // remove the (now-empty) entry
                    std::fprintf(stderr,
                        "[CloseProfile] map_erased trackId=%d nodeId=%d\n",
                        key.first, key.second);
                    std::fflush(stderr);
                }
            } // vstEditorCoordinatorsMutex_ released here
            CPLOG("after_erase_from_coordinator_map");

            // Hand destruction to the reaper thread. We are currently executing on
            // the coordinator's own IPC poll thread — destroying the coordinator
            // here would self-join (killWorkerProcess → stopThread → join self → deadlock).
            // The reaper is a distinct long-lived thread guaranteed never to be any
            // coordinator's poll thread.
            reapCoordinator(std::move(dying));
        };

        // Build parent HWND hex string for editor window parenting.
        juce::String parentHwndHex;
        const uintptr_t hwnd = mainWindowHwnd_.load();
        if (hwnd != 0)
        {
            char buf[32];
            std::snprintf(buf, sizeof(buf), "%llX", (unsigned long long)hwnd);
            parentHwndHex = juce::String(buf);
        }
        else
        {
            std::fprintf(stderr,
                "[EditorFlow] Warning: main window HWND not set — editor will be unparented\n");
        }

        // Launch editor-host process.
        std::fprintf(stderr,
            "[EditorFlow] Opening VST editor: track=%d node=%d plugin=%s parent=0x%s\n",
            trackId, nodeId, pluginFilePath.toRawUTF8(),
            parentHwndHex.isEmpty() ? "0" : parentHwndHex.toRawUTF8());

        if (!coord->start(editorHostExe, pluginFilePath, stateBase64, parentHwndHex))
        {
            std::fprintf(stderr,
                "[EditorFlow] Failed to start editor process: track=%d node=%d\n",
                trackId, nodeId);
            return false;
        }

        // Poll for REDY (up to 5 s). The IPC poll thread sets editorReady_
        // directly (not via callAsync), so we can read it here safely.
        constexpr int kMaxWaitMs = 5000;
        constexpr int kPollMs    = 50;
        int waited = 0;
        while (!coord->isEditorReady() && !coord->isEditorClosed() && waited < kMaxWaitMs)
        {
            juce::Thread::sleep(kPollMs);
            waited += kPollMs;
        }

        if (!coord->isEditorReady())
        {
            std::fprintf(stderr,
                "[EditorFlow] Timed out waiting for editor ready: track=%d node=%d"
                " error='%s'\n",
                trackId, nodeId, coord->getErrorMessage().c_str());
            return false;
        }

        std::fprintf(stderr,
            "[EditorFlow] VST editor ready: track=%d node=%d WxH=%dx%d\n",
            trackId, nodeId,
            coord->getEditorWidth(), coord->getEditorHeight());

        // ── Audio streaming: enable worker-side ring, then tell editor-host ──
        // Ordering: ring must exist before the editor-host tries to open it.
        // Construct name: "Xleth_AudioStream_T{trackId}_N{nodeId}".
        char shmBuf[96];
        std::snprintf(shmBuf, sizeof(shmBuf),
                      "Xleth_AudioStream_T%d_N%d", trackId, nodeId);
        const std::string shmName = shmBuf;
        const int streamSr = (int)(preparedSampleRate_ > 0 ? preparedSampleRate_ : 44100);
        const int streamBs =  preparedBlockSize_ > 0 ? preparedBlockSize_ : 512;

        wrapper->enableAudioStream(shmName, streamSr, streamBs);
        coord->sendStreamStart(shmName, streamSr, streamBs);

        {
            std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
            vstEditorCoordinators_[key] = std::move(coord);
        }
        return true;
    }

    // ── Route: stock effect → in-process DocumentWindow ─────────────────────
    return editorHost_->openEditor(proc, trackId, nodeId);
}

void MixEngine::closePluginEditor(int trackId, int nodeId)
{
    const auto key = std::make_pair(trackId, nodeId);

    // Step 1: ask the editor-host to stop its pump + releaseResources, BEFORE
    // destroying the worker-side ring (the editor-host is still reading it).
    // We hold a raw observer of the coordinator only under the map mutex; the
    // STOP send itself is OK from any thread (IPC pipe is thread-safe).
    EditorProcessCoordinator* observedCoord = nullptr;
    {
        std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
        auto it = vstEditorCoordinators_.find(key);
        if (it != vstEditorCoordinators_.end())
            observedCoord = it->second.get();
    }
    if (observedCoord) observedCoord->sendStreamStop();

    // Step 2: find the VST wrapper so we can tear down the worker-side ring.
    GuardedPluginWrapper* wrapper = nullptr;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        EffectChainManager* chain = nullptr;
        if (trackId == -1)
        {
            chain = masterEffectChain_.get();
        }
        else
        {
            auto it = effectChains_.find(trackId);
            if (it != effectChains_.end()) chain = it->second.get();
        }
        if (chain)
            wrapper = dynamic_cast<GuardedPluginWrapper*>(chain->getProcessor(nodeId));
    }
    if (wrapper) wrapper->disableAudioStream();

    // Step 3: destroy the coordinator (closes IPC → editor-host quits).
    // Move out under the mutex, then destruct on a background thread to avoid
    // blocking the message thread if killWorkerProcess() stalls on a dead pipe.
    std::unique_ptr<EditorProcessCoordinator> dyingExplicit;
    {
        std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
        auto it = vstEditorCoordinators_.find(key);
        if (it != vstEditorCoordinators_.end())
        {
            dyingExplicit = std::move(it->second);
            vstEditorCoordinators_.erase(it);
        }
    }
    reapCoordinator(std::move(dyingExplicit));

    // Also close any in-process editor (stock effects).
    editorHost_->closeEditor(trackId, nodeId);
}

void MixEngine::closePluginEditorsForTrack(int trackId)
{
    // Collect nodeIds for this track under the map mutex, then tear down each
    // one individually via closePluginEditor so stream-stop ordering holds.
    std::vector<int> nodesToClose;
    {
        std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
        for (auto& kv : vstEditorCoordinators_)
            if (kv.first.first == trackId)
                nodesToClose.push_back(kv.first.second);
    }
    for (int nodeId : nodesToClose)
        closePluginEditor(trackId, nodeId);

    editorHost_->closeEditorsForTrack(trackId);
}

void MixEngine::closeAllPluginEditors()
{
    // Collect keys first, then tear down each one via the normal path so the
    // STOP → disable → destroy-coordinator ordering is preserved.
    std::vector<std::pair<int,int>> all;
    {
        std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
        all.reserve(vstEditorCoordinators_.size());
        for (auto& kv : vstEditorCoordinators_) all.push_back(kv.first);
    }
    for (auto& key : all) closePluginEditor(key.first, key.second);

    editorHost_->closeAllEditors();
}

bool MixEngine::isPluginEditorOpen(int trackId, int nodeId) const
{
    {
        std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
        auto it = vstEditorCoordinators_.find(std::make_pair(trackId, nodeId));
        if (it != vstEditorCoordinators_.end() && !it->second->isEditorClosed())
            return true;
    }
    return editorHost_->isEditorOpen(trackId, nodeId);
}

// ── Configuration ────────────────────────────────────────────────────────────

void MixEngine::setTimeline(const Timeline* timeline)
{
    timeline_ = timeline;
}

void MixEngine::setSampleBank(const SampleBank* bank)
{
    sampleBank_ = bank;
}

void MixEngine::mapRegionToSample(int regionId, int sampleBankId)
{
    regionToSampleMap_[regionId] = sampleBankId;
}

void MixEngine::clearRegionToSampleMap()
{
    regionToSampleMap_.clear();
}

void MixEngine::unmapRegion(int regionId)
{
    regionToSampleMap_.erase(regionId);
}

int MixEngine::getSampleIdForRegion(int regionId) const
{
    auto it = regionToSampleMap_.find(regionId);
    return it != regionToSampleMap_.end() ? it->second : -1;
}

std::unordered_map<int, int> MixEngine::getRegionToSampleMapSnapshot() const
{
    return regionToSampleMap_;
}

// ── Sampler lifecycle (main thread) ──────────────────────────────────────────

void MixEngine::loadSamplerForTrackRegion(int trackId, int regionId)
{
    if (sampleBank_ == nullptr || timeline_ == nullptr) return;
    if (regionId < 0) return;

    const TrackInfo* track = timeline_->getTrack(trackId);
    if (track == nullptr) return;
    if (track->type != TrackInfo::Type::Pattern) return;

    const SampleRegion* region = timeline_->getRegion(regionId);
    if (region == nullptr) return;

    const int sampleBankId = getSampleIdForRegion(regionId);
    if (sampleBankId < 0) return;
    const auto* buf = sampleBank_->getSample(sampleBankId);
    if (buf == nullptr) return;

    const auto info = sampleBank_->getSampleInfo(sampleBankId);
    const double srcSR = info.originalSampleRate > 0.0
                       ? info.originalSampleRate
                       : 48000.0;

    auto s = std::make_unique<Sampler>();
    s->setRootNote(region->rootNote);
    s->setEnvelope(region->delayMs, region->attackMs, region->holdMs,
                   region->decayMs, region->sustain, region->releaseMs,
                   region->attackTension, region->decayTension, region->releaseTension);
    s->setPitchEnvelope(region->pitchEnvDelayMs, region->pitchEnvAttackMs, region->pitchEnvHoldMs,
                        region->pitchEnvDecayMs, region->pitchEnvSustain, region->pitchEnvReleaseMs,
                        region->pitchEnvAttackTension, region->pitchEnvDecayTension, region->pitchEnvReleaseTension);
    s->setPitchEnvEnabled(region->pitchEnvEnabled);
    s->setPitchEnvAmount(region->pitchEnvAmount);
    s->setLoopPoints(region->loopEnabled, region->loopStart, region->loopEnd);
    s->setCrossfadeMode(region->crossfadeEnabled);
    s->setSmpStart(region->smpStart);
    s->setSmpLength(region->smpLength);
    s->setDeclickMs(region->declickMs);
    s->setFadeIn(region->fadeInMs);
    s->setFadeOut(region->fadeOutMs);
    s->setCrossfadeSamples(region->crossfadeSamples);
    s->setMonoMode(region->monoEnabled);
    s->setPortamento(region->portamentoEnabled, region->portamentoTimeMs);
    s->setArpeggiator(region->arpEnabled, region->arpTempoSync, region->arpDivision,
                      region->arpFreeTimeMs, region->arpGate, region->arpRange,
                      region->arpDirection);
    s->setLfoVol(region->lfoVolEnabled, region->lfoVolAmount, region->lfoVolSpeedHz,
                 region->lfoVolTempoSync, region->lfoVolTempoDivision,
                 region->lfoVolAttackMs, region->lfoVolDelayMs, region->lfoVolWaveform);
    s->setLfoPan(region->lfoPanEnabled, region->lfoPanAmount, region->lfoPanSpeedHz,
                 region->lfoPanTempoSync, region->lfoPanTempoDivision,
                 region->lfoPanAttackMs, region->lfoPanDelayMs, region->lfoPanWaveform);
    s->setLfoPitch(region->lfoPitchEnabled, region->lfoPitchAmount, region->lfoPitchSpeedHz,
                   region->lfoPitchTempoSync, region->lfoPitchTempoDivision,
                   region->lfoPitchAttackMs, region->lfoPitchDelayMs, region->lfoPitchWaveform);

    juce::AudioBuffer<float> working(*buf);
    SampleProcessor::Flags fx{ region->dcOffsetRemoved, region->normalized,
                               region->polarityReversed, region->reversed };
    SampleProcessor::applyFlags(working, fx);
    s->loadSample(working, srcSR, region->rootNote);

    samplers_[{trackId, regionId}] = std::move(s);
}

void MixEngine::unloadSamplerForTrackRegion(int trackId, int regionId)
{
    samplers_.erase({trackId, regionId});
}

void MixEngine::unloadSamplersForTrack(int trackId)
{
    for (auto it = samplers_.begin(); it != samplers_.end(); ) {
        if (it->first.trackId == trackId)
            it = samplers_.erase(it);
        else
            ++it;
    }
}

void MixEngine::unloadSamplersForRegion(int regionId)
{
    for (auto it = samplers_.begin(); it != samplers_.end(); ) {
        if (it->first.regionId == regionId)
            it = samplers_.erase(it);
        else
            ++it;
    }
}

void MixEngine::silenceAllSamplers()
{
    for (auto& [key, sampler] : samplers_)
        if (sampler) sampler->allNotesOff();
    for (auto& [id, sampler] : previewSamplers_)
        if (sampler) sampler->allNotesOff();
}

void MixEngine::rebuildAllSamplers()
{
    if (timeline_ == nullptr) { samplers_.clear(); return; }

    // 1. Collect the set of {trackId, regionId} pairs actually referenced
    //    by any PatternBlock in the timeline (via block → pattern.regionId).
    std::unordered_set<TrackRegionKey, TrackRegionKeyHash> needed;
    for (const PatternBlock* b : timeline_->getAllPatternBlocks()) {
        if (b == nullptr) continue;
        const Pattern* p = timeline_->getPattern(b->patternId);
        if (p == nullptr) continue;
        if (p->regionId < 0) continue;
        const TrackInfo* t = timeline_->getTrack(b->trackId);
        if (t == nullptr || t->type != TrackInfo::Type::Pattern) continue;
        needed.insert({b->trackId, p->regionId});
    }

    // 2. Prune samplers that are no longer referenced by any block.
    for (auto it = samplers_.begin(); it != samplers_.end(); ) {
        if (needed.find(it->first) == needed.end())
            it = samplers_.erase(it);
        else
            ++it;
    }

    // 3. Ensure every needed pair has a fresh sampler (reload to pick up any
    //    region-level setting changes that happened since last rebuild).
    for (const auto& key : needed) {
        loadSamplerForTrackRegion(key.trackId, key.regionId);
    }

    // 4. Update slot mapping and sync audio atomics + volume smoothers.
    //    Safe here because all callers (project load, undo/redo) hold no
    //    concurrent audio thread — see threading constraint in MixEngine.h.
    updateSlotMapping();

    const auto allTracks = timeline_->getAllTracks();
    for (int i = 0; i < static_cast<int>(allTracks.size()) && i < kMaxTracks; ++i)
    {
        const auto* t = allTracks[i];
        if (t == nullptr) continue;
        trackParams_[i].volume.store(t->volume,         std::memory_order_relaxed);
        trackParams_[i].pan.store   (t->pan,            std::memory_order_relaxed);
        trackParams_[i].spread.store(t->stereoSpread,   std::memory_order_relaxed);
        // Snap smoother immediately — no ramp from previous value after undo/load
        volumeSmoothed_[i].setCurrentAndTargetValue(t->volume);
    }
}

// ── Prepare ──────────────────────────────────────────────────────────────────

void MixEngine::prepare(double sampleRate, int maxBlockSize)
{
    preparedSampleRate_ = sampleRate;
    preparedBlockSize_  = maxBlockSize;

    for (int i = 0; i < kMaxTracks; ++i)
    {
        volumeSmoothed_[i].reset(sampleRate, 0.020); // 20ms linear ramp
        // Snap immediately to current atomic value — no initial ramp from 0
        const float cur = trackParams_[i].volume.load(std::memory_order_relaxed);
        volumeSmoothed_[i].setCurrentAndTargetValue(cur);
    }

    // Re-prepare any existing effect chains with the new sample rate / block size
    std::lock_guard<std::mutex> lock(chainsMutex_);
    for (auto& [id, chain] : effectChains_)
    {
        if (chain && chain->isInitialized())
            chain->reprepare(sampleRate, maxBlockSize);
    }
    if (masterEffectChain_ && masterEffectChain_->isInitialized())
        masterEffectChain_->reprepare(sampleRate, maxBlockSize);

    // Phase C: clear any per-clip vibrato readhead state on device prepare.
    clipModReader_.resetAllStates();
}

void MixEngine::setNonRealtime(bool nr)
{
    nonRealtime_.store(nr, std::memory_order_relaxed);
    // Propagate to each effect chain's JUCE AudioProcessorGraph.
    // JUCE's AudioProcessorGraph::processBlock() only builds its render
    // sequence synchronously when prepareToPlay() is called from the message
    // thread; from any other thread it defers via triggerAsyncUpdate().
    // Setting nonRealtime on the graph activates its built-in spin-wait so
    // processBlock() waits for the render sequence rather than clearing audio.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    for (auto& [id, chain] : effectChains_)
        if (chain) chain->setNonRealtime(nr);
    if (masterEffectChain_)
        masterEffectChain_->setNonRealtime(nr);
}

// ── Direct atomic parameter setters (slot-based via trackIdToSlot_) ─────────

void MixEngine::setTrackVolume(int trackId, float volume)
{
    std::shared_lock<std::shared_mutex> lock(slotMutex_);
    auto it = trackIdToSlot_.find(trackId);
    if (it == trackIdToSlot_.end()) return;
    trackParams_[it->second].volume.store(volume, std::memory_order_relaxed);
}

void MixEngine::setTrackPan(int trackId, float pan)
{
    std::shared_lock<std::shared_mutex> lock(slotMutex_);
    auto it = trackIdToSlot_.find(trackId);
    if (it == trackIdToSlot_.end()) return;
    trackParams_[it->second].pan.store(pan, std::memory_order_relaxed);
}

void MixEngine::setTrackSpread(int trackId, float spread)
{
    std::shared_lock<std::shared_mutex> lock(slotMutex_);
    auto it = trackIdToSlot_.find(trackId);
    if (it == trackIdToSlot_.end()) return;
    trackParams_[it->second].spread.store(spread, std::memory_order_relaxed);
}

void MixEngine::setMasterVolume(float volume)
{
    masterVolume_.store(volume, std::memory_order_relaxed);
}

void MixEngine::setClipBoundaryFadeSamples(int n)
{
    clipBoundaryFadeSamples_.store(n < 0 ? 0 : n, std::memory_order_relaxed);
}

// ── Global clip-processing defaults ─────────────────────────────────────────

void MixEngine::setGlobalStretchMethod(int method) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[EngineConfig] globalStretchMethod changed: %d→%d\n",
            globalStretchMethod_, (method >= 1 && method <= 5) ? method : 1);
#endif
    globalStretchMethod_ = (method >= 1 && method <= 5) ? method : 1;
}

void MixEngine::setGlobalFormantPreserve(bool enabled) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[EngineConfig] globalFormantPreserve changed: %d→%d\n",
            (int)globalFormantPreserve_, (int)enabled);
#endif
    globalFormantPreserve_ = enabled;
}

void MixEngine::invalidateAllGlobalMethodClips() {
    if (!timeline_) return;
    int count = 0;
    for (const Clip* c : timeline_->getAllClips()) {
        if (!c || c->stretchMethod != StretchMethod::Global) continue;
        const bool needs = (c->pitchOffset != 0 || c->pitchOffsetCents != 0
                         || c->reversed || c->stretchRatio != 1.0);
        if (needs) { invalidateClipCache(c->id, "invalidateAllGlobalMethodClips"); ++count; }
    }
#ifdef XLETH_DEBUG
    fprintf(stderr, "[EngineConfig] mass markDirty: %d clips invalidated\n", count);
#endif
}

// ── Clip render cache (message thread) ──────────────────────────────────────

void MixEngine::invalidateClipCache(int clipId, const char* trigger)
{
    // [PITCHDBG] unconditional — remove after pitch-shift regression is diagnosed
    fprintf(stderr, "[PITCHDBG] invalidateClipCache entry: clip=%d trigger=%s\n",
            clipId, trigger ? trigger : "null");
    fflush(stderr);
#ifdef XLETH_DEBUG
    fprintf(stderr, "[CacheQueue] invalidateClipCache entry: clip=%d trigger=%s\n",
            clipId, trigger ? trigger : "null");
    fflush(stderr);
#endif
    clipRenderCache_.markDirty(clipId);

    if (!timeline_ || !sampleBank_) {
        fprintf(stderr, "[PITCHDBG] SKIP clip=%d reason=no_timeline_or_sampleBank trigger=%s\n",
                clipId, trigger ? trigger : "null");
        fflush(stderr);
#ifdef XLETH_DEBUG
        fprintf(stderr, "[CacheQueue] SKIP clip=%d reason=no_timeline_or_sampleBank trigger=%s\n",
                clipId, trigger ? trigger : "null");
        fflush(stderr);
#endif
        return;
    }

    const Clip* clip = timeline_->getClip(clipId);
    if (!clip) {
        fprintf(stderr, "[PITCHDBG] SKIP clip=%d reason=clip_not_in_timeline trigger=%s\n",
                clipId, trigger ? trigger : "null");
        fflush(stderr);
#ifdef XLETH_DEBUG
        fprintf(stderr, "[CacheQueue] SKIP clip=%d reason=clip_not_in_timeline trigger=%s\n",
                clipId, trigger ? trigger : "null");
        fflush(stderr);
#endif
        return;
    }

    // Only submit a render job if the clip actually needs processing
    const bool needsProcessing = (clip->pitchOffset != 0
                               || clip->pitchOffsetCents != 0
                               || clip->reversed
                               || clip->stretchRatio != 1.0);
    fprintf(stderr, "[PITCHDBG] clip=%d regionId=%d pitchSemi=%d cents=%d reversed=%d stretch=%.3f needsProcessing=%d trigger=%s\n",
            clipId, clip->regionId, clip->pitchOffset, clip->pitchOffsetCents,
            clip->reversed ? 1 : 0, clip->stretchRatio, needsProcessing ? 1 : 0,
            trigger ? trigger : "null");
    fflush(stderr);
    if (!needsProcessing) {
#ifdef XLETH_DEBUG
        fprintf(stderr, "[CacheQueue] SKIP clip=%d reason=identity_params "
                "(pitchSemi=%d cents=%d reversed=%d stretch=%.3f) trigger=%s\n",
                clipId, clip->pitchOffset, clip->pitchOffsetCents,
                clip->reversed ? 1 : 0, clip->stretchRatio,
                trigger ? trigger : "null");
        fflush(stderr);
#endif
        return;
    }

    auto it = regionToSampleMap_.find(clip->regionId);
    if (it == regionToSampleMap_.end()) {
        fprintf(stderr, "[PITCHDBG] SKIP clip=%d reason=region_%d_not_in_sampleMap trigger=%s\n",
                clipId, clip->regionId, trigger ? trigger : "null");
        fflush(stderr);
#ifdef XLETH_DEBUG
        fprintf(stderr, "[CacheQueue] SKIP clip=%d reason=region_%d_not_in_sampleMap trigger=%s\n",
                clipId, clip->regionId, trigger ? trigger : "null");
        fflush(stderr);
#endif
        return;
    }

    const juce::AudioBuffer<float>* srcBuf = sampleBank_->getSample(it->second);
    if (!srcBuf) {
#ifdef XLETH_DEBUG
        fprintf(stderr, "[CacheQueue] SKIP clip=%d reason=sampleBank_no_buffer trigger=%s\n",
                clipId, trigger ? trigger : "null");
        fflush(stderr);
#endif
        return;
    }

    const double bpm = timeline_->getBPM();
    const double sr  = preparedSampleRate_;

    const int64_t clipStartSample = clip->position.toSamples(bpm, sr);
    const int64_t clipEndSample   = (clip->position + clip->duration).toSamples(bpm, sr);

    // Syllable offset + clip-level regionOffset — must match findActiveClips() exactly.
    int64_t regionOffsetSamples = 0;
    if (clip->syllableIndex >= 0)
    {
        const auto* region = timeline_->getRegion(clip->regionId);
        if (region != nullptr && clip->syllableIndex < static_cast<int>(region->syllables.size()))
        {
            const auto& syl = region->syllables[clip->syllableIndex];
            regionOffsetSamples = static_cast<int64_t>(syl.startTime * sr);
        }
    }
    if (clip->regionOffset.ticks > 0)
        regionOffsetSamples += clip->regionOffset.toSamples(bpm, sr);

    CacheKey key;
    key.regionId            = clip->regionId;
    key.syllableIndex       = clip->syllableIndex;
    key.regionOffsetSamples = regionOffsetSamples;
    key.durationSamples     = clipEndSample - clipStartSample;
    key.sourceLengthSamples = srcBuf->getNumSamples();
    key.pitchOffsetSemis    = clip->pitchOffset;
    key.pitchOffsetCents    = clip->pitchOffsetCents;
    key.reversed            = clip->reversed;
    key.stretchRatio        = clip->stretchRatio;
    {
        const bool isGlobal = (clip->stretchMethod == StretchMethod::Global);
        key.stretchMethod   = isGlobal ? globalStretchMethod_
                                       : static_cast<int>(clip->stretchMethod);
        key.formantPreserve = isGlobal ? globalFormantPreserve_
                                       : clip->formantPreserve;
    }

    fprintf(stderr, "[PITCHDBG] ENQUEUE clip=%d regionId=%d pitch=%dst+%dc stretch=%.3f trigger=%s\n",
            clipId, clip->regionId, clip->pitchOffset, clip->pitchOffsetCents,
            clip->stretchRatio, trigger ? trigger : "null");
    fflush(stderr);
#ifdef XLETH_DEBUG
    fprintf(stderr, "[CacheQueue] ENQUEUE clip=%d regionId=%d stretchRatio=%.3f reversed=%d "
            "stretchMethod=%d (resolved=%d) pitch=%dst+%dc trigger=%s\n",
            clipId, clip->regionId, clip->stretchRatio, clip->reversed ? 1 : 0,
            (int)clip->stretchMethod, key.stretchMethod,
            clip->pitchOffset, clip->pitchOffsetCents,
            trigger ? trigger : "null");
    fflush(stderr);
#endif
    clipRenderCache_.submitJob(clipId, key, *srcBuf, sr);
}

// ── Clip processed buffer lookup (message thread) ────────────────────────────

const juce::AudioBuffer<float>* MixEngine::getClipProcessedBuffer(int clipId) const
{
    if (!timeline_ || !sampleBank_) return nullptr;

    const Clip* clip = timeline_->getClip(clipId);
    if (!clip) return nullptr;

    const bool needsProcessing = (clip->pitchOffset    != 0
                               || clip->pitchOffsetCents != 0
                               || clip->reversed
                               || clip->stretchRatio   != 1.0);
    if (!needsProcessing) return nullptr;

    auto it = regionToSampleMap_.find(clip->regionId);
    if (it == regionToSampleMap_.end()) return nullptr;

    const juce::AudioBuffer<float>* srcBuf = sampleBank_->getSample(it->second);
    if (!srcBuf) return nullptr;

    const double bpm = timeline_->getBPM();
    const double sr  = preparedSampleRate_;

    const int64_t clipStartSample = clip->position.toSamples(bpm, sr);
    const int64_t clipEndSample   = (clip->position + clip->duration).toSamples(bpm, sr);

    int64_t regionOffsetSamples = 0;
    if (clip->syllableIndex >= 0)
    {
        const auto* region = timeline_->getRegion(clip->regionId);
        if (region != nullptr && clip->syllableIndex < static_cast<int>(region->syllables.size()))
        {
            const auto& syl = region->syllables[clip->syllableIndex];
            regionOffsetSamples = static_cast<int64_t>(syl.startTime * sr);
        }
    }
    if (clip->regionOffset.ticks > 0)
        regionOffsetSamples += clip->regionOffset.toSamples(bpm, sr);

    CacheKey key;
    key.regionId            = clip->regionId;
    key.syllableIndex       = clip->syllableIndex;
    key.regionOffsetSamples = regionOffsetSamples;
    key.durationSamples     = clipEndSample - clipStartSample;
    key.sourceLengthSamples = srcBuf->getNumSamples();
    key.pitchOffsetSemis    = clip->pitchOffset;
    key.pitchOffsetCents    = clip->pitchOffsetCents;
    key.reversed            = clip->reversed;
    key.stretchRatio        = clip->stretchRatio;
    {
        const bool isGlobal = (clip->stretchMethod == StretchMethod::Global);
        key.stretchMethod   = isGlobal ? globalStretchMethod_
                                       : static_cast<int>(clip->stretchMethod);
        key.formantPreserve = isGlobal ? globalFormantPreserve_
                                       : clip->formantPreserve;
    }

    return clipRenderCache_.getProcessedBuffer(clipId, key);
}

// ── Slot mapping (main thread only) ─────────────────────────────────────────

void MixEngine::updateSlotMapping()
{
    if (timeline_ == nullptr) return;
    const auto allTracks = timeline_->getAllTracks();
    std::unique_lock<std::shared_mutex> lock(slotMutex_);
    trackIdToSlot_.clear();
    for (int i = 0; i < static_cast<int>(allTracks.size()) && i < kMaxTracks; ++i)
    {
        if (allTracks[i] != nullptr)
            trackIdToSlot_[allTracks[i]->id] = i;
    }
}

bool MixEngine::hasSampler(int trackId, int regionId) const
{
    return samplers_.find({trackId, regionId}) != samplers_.end();
}

Sampler* MixEngine::getSamplerPtr(int trackId, int regionId)
{
    auto it = samplers_.find({trackId, regionId});
    return it != samplers_.end() ? it->second.get() : nullptr;
}

// ── Preview samplers ─────────────────────────────────────────────────────────

void MixEngine::ensurePreviewSampler(int regionId)
{
    if (sampleBank_ == nullptr || timeline_ == nullptr) return;
    const SampleRegion* r = timeline_->getRegion(regionId);
    if (r == nullptr) {
        previewSamplers_.erase(regionId);
        return;
    }

    const int sampleBankId = getSampleIdForRegion(regionId);
    if (sampleBankId < 0) return;
    const auto* buf = sampleBank_->getSample(sampleBankId);
    if (buf == nullptr) return;

    const auto info = sampleBank_->getSampleInfo(sampleBankId);
    const double srcSR = info.originalSampleRate > 0.0
                       ? info.originalSampleRate
                       : 48000.0;

    auto s = std::make_unique<Sampler>();
    s->setRootNote(r->rootNote);
    s->setEnvelope(r->delayMs, r->attackMs, r->holdMs,
                   r->decayMs, r->sustain, r->releaseMs,
                   r->attackTension, r->decayTension, r->releaseTension);
    s->setPitchEnvelope(r->pitchEnvDelayMs, r->pitchEnvAttackMs, r->pitchEnvHoldMs,
                        r->pitchEnvDecayMs, r->pitchEnvSustain, r->pitchEnvReleaseMs,
                        r->pitchEnvAttackTension, r->pitchEnvDecayTension, r->pitchEnvReleaseTension);
    s->setPitchEnvEnabled(r->pitchEnvEnabled);
    s->setPitchEnvAmount(r->pitchEnvAmount);
    s->setLoopPoints(r->loopEnabled, r->loopStart, r->loopEnd);
    s->setCrossfadeMode(r->crossfadeEnabled);
    s->setSmpStart(r->smpStart);
    s->setSmpLength(r->smpLength);
    s->setDeclickMs(r->declickMs);
    s->setFadeIn(r->fadeInMs);
    s->setFadeOut(r->fadeOutMs);
    s->setCrossfadeSamples(r->crossfadeSamples);
    s->setMonoMode(r->monoEnabled);
    s->setPortamento(r->portamentoEnabled, r->portamentoTimeMs);
    s->setArpeggiator(r->arpEnabled, r->arpTempoSync, r->arpDivision,
                      r->arpFreeTimeMs, r->arpGate, r->arpRange,
                      r->arpDirection);
    s->setLfoVol(r->lfoVolEnabled, r->lfoVolAmount, r->lfoVolSpeedHz,
                 r->lfoVolTempoSync, r->lfoVolTempoDivision,
                 r->lfoVolAttackMs, r->lfoVolDelayMs, r->lfoVolWaveform);
    s->setLfoPan(r->lfoPanEnabled, r->lfoPanAmount, r->lfoPanSpeedHz,
                 r->lfoPanTempoSync, r->lfoPanTempoDivision,
                 r->lfoPanAttackMs, r->lfoPanDelayMs, r->lfoPanWaveform);
    s->setLfoPitch(r->lfoPitchEnabled, r->lfoPitchAmount, r->lfoPitchSpeedHz,
                   r->lfoPitchTempoSync, r->lfoPitchTempoDivision,
                   r->lfoPitchAttackMs, r->lfoPitchDelayMs, r->lfoPitchWaveform);

    juce::AudioBuffer<float> working(*buf);
    SampleProcessor::Flags fx{ r->dcOffsetRemoved, r->normalized,
                               r->polarityReversed, r->reversed };
    SampleProcessor::applyFlags(working, fx);
    s->loadSample(working, srcSR, r->rootNote);

    previewSamplers_[regionId] = std::move(s);
}

void MixEngine::unloadPreviewSampler(int regionId)
{
    previewSamplers_.erase(regionId);
}

Sampler* MixEngine::getPreviewSamplerPtr(int regionId)
{
    auto it = previewSamplers_.find(regionId);
    return it != previewSamplers_.end() ? it->second.get() : nullptr;
}

bool MixEngine::hasPreviewSampler(int regionId) const
{
    return previewSamplers_.find(regionId) != previewSamplers_.end();
}

void MixEngine::silenceAllPreviewSamplers()
{
    for (auto& [id, sampler] : previewSamplers_)
        if (sampler) sampler->allNotesOff();
}

// ── Effect chain management (main thread only) ─────────────────────────────

void MixEngine::initEffectChain(int trackId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (effectChains_.count(trackId)) return;
    auto chain = std::make_unique<EffectChainManager>();
    chain->setPluginRegistry(pluginRegistry_.get());
    chain->init(preparedSampleRate_, preparedBlockSize_);
    effectChains_[trackId] = std::move(chain);
}

void MixEngine::destroyEffectChain(int trackId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    effectChains_.erase(trackId);
}

void MixEngine::destroyAllEffectChains()
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    const size_t nTrack = effectChains_.size();
    effectChains_.clear();
    const bool hadMaster = (bool)masterEffectChain_;
    masterEffectChain_.reset();
    std::fprintf(stderr,
                 "[MixEngine] destroyAllEffectChains: cleared %zu track chain(s)%s\n",
                 nTrack, hadMaster ? ", destroyed master chain" : "");
}

int MixEngine::addEffect(int trackId, const std::string& pluginId, int position)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    // Auto-init chain on first add
    auto& chain = effectChains_[trackId];
    if (!chain)
    {
        chain = std::make_unique<EffectChainManager>();
        chain->setPluginRegistry(pluginRegistry_.get());
        chain->init(preparedSampleRate_, preparedBlockSize_);
    }
    return chain->addEffect(pluginId, position);
}

bool MixEngine::removeEffect(int trackId, int nodeId)
{
    // Close any open editor (in-process or out-of-process) BEFORE removing the
    // AudioProcessor node. This avoids dangling AudioProcessor* references in
    // PluginEditorWindow and EditorProcessCoordinator::ParamSyncListener.
    closePluginEditor(trackId, nodeId);

    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    return it->second->removeEffect(nodeId);
}

bool MixEngine::moveEffect(int trackId, int nodeId, int newPosition)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    return it->second->moveEffect(nodeId, newPosition);
}

bool MixEngine::setEffectBypass(int trackId, int nodeId, bool bypassed)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    return it->second->setBypass(nodeId, bypassed);
}

std::string MixEngine::getEffectChainState(int trackId) const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return "[]";
    return it->second->getChainState().dump();
}

// ── Master effect chain ─────────────────────────────────────────────────────

void MixEngine::initMasterEffectChain()
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (masterEffectChain_) return;
    masterEffectChain_ = std::make_unique<EffectChainManager>();
    masterEffectChain_->setPluginRegistry(pluginRegistry_.get());
    masterEffectChain_->init(preparedSampleRate_, preparedBlockSize_);
}

void MixEngine::destroyMasterEffectChain()
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    masterEffectChain_.reset();
}

int MixEngine::addMasterEffect(const std::string& pluginId, int position)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_)
    {
        masterEffectChain_ = std::make_unique<EffectChainManager>();
        masterEffectChain_->setPluginRegistry(pluginRegistry_.get());
        masterEffectChain_->init(preparedSampleRate_, preparedBlockSize_);
    }
    return masterEffectChain_->addEffect(pluginId, position);
}

bool MixEngine::removeMasterEffect(int nodeId)
{
    // Close editor before destroying the node (trackId = -1 = master chain).
    editorHost_->closeEditor(-1, nodeId);

    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return false;
    return masterEffectChain_->removeEffect(nodeId);
}

bool MixEngine::moveMasterEffect(int nodeId, int newPosition)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return false;
    return masterEffectChain_->moveEffect(nodeId, newPosition);
}

bool MixEngine::setMasterEffectBypass(int nodeId, bool bypassed)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return false;
    return masterEffectChain_->setBypass(nodeId, bypassed);
}

std::string MixEngine::getMasterEffectChainState() const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return "[]";
    return masterEffectChain_->getChainState().dump();
}

// ── Effect chain serialization ───────────────────────────────────────────────

nlohmann::json MixEngine::getEffectChainJSON(int trackId) const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return nlohmann::json::object();
    return it->second->graphToJSON();
}

nlohmann::json MixEngine::getMasterEffectChainJSON() const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return nlohmann::json::object();
    return masterEffectChain_->graphToJSON();
}

bool MixEngine::loadEffectChainFromJSON(int trackId, const nlohmann::json& j)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto& chain = effectChains_[trackId];
    if (!chain) {
        chain = std::make_unique<EffectChainManager>();
        chain->setPluginRegistry(pluginRegistry_.get());
        chain->init(preparedSampleRate_, preparedBlockSize_);
    }
    return chain->graphFromJSON(j);
}

bool MixEngine::loadMasterEffectChainFromJSON(const nlohmann::json& j)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) {
        masterEffectChain_ = std::make_unique<EffectChainManager>();
        masterEffectChain_->setPluginRegistry(pluginRegistry_.get());
        masterEffectChain_->init(preparedSampleRate_, preparedBlockSize_);
    }
    return masterEffectChain_->graphFromJSON(j);
}

// ── Missing-plugin support ──────────────────────────────────────────────────

std::string MixEngine::getMissingPluginsJSON() const
{
    nlohmann::json arr = nlohmann::json::array();
    std::lock_guard<std::mutex> lock(chainsMutex_);

    auto appendMissing = [&](int trackId, const EffectChainManager* chain)
    {
        if (!chain) return;
        for (const auto& node : chain->getMissingNodesJSON())
        {
            nlohmann::json entry = node;
            entry["trackId"] = trackId;

            // Enrich with human-readable name by reading the processor's display name.
            // PassthroughProcessor::getName() returns "[Missing: OriginalName]" — strip the wrapper.
            const int nid = node.value("nodeId", -1);
            juce::AudioProcessor* proc = nid >= 0
                ? const_cast<EffectChainManager*>(chain)->getProcessor(nid)
                : nullptr;

            std::string displayName = node.value("pluginId", "Unknown");
            if (proc)
            {
                const std::string raw = proc->getName().toStdString();
                constexpr auto prefix = "[Missing: ";
                constexpr auto prefixLen = 10; // strlen("[Missing: ")
                if (raw.size() > prefixLen + 1
                        && raw.substr(0, prefixLen) == prefix
                        && raw.back() == ']')
                    displayName = raw.substr(prefixLen, raw.size() - prefixLen - 1);
                else
                    displayName = raw;
            }
            entry["pluginName"]   = displayName;
            entry["pluginVendor"] = "";
            entry["filePath"]     = "";

            arr.push_back(entry);
        }
    };

    for (const auto& [tid, chain] : effectChains_)
        appendMissing(tid, chain.get());
    appendMissing(-1, masterEffectChain_.get());

    return arr.dump();
}

bool MixEngine::tryResolvePlugin(int trackId, int nodeId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!pluginRegistry_) return false;

    if (trackId == -1)
    {
        if (!masterEffectChain_) return false;
        return masterEffectChain_->tryResolvePlugin(nodeId, *pluginRegistry_);
    }
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    return it->second->tryResolvePlugin(nodeId, *pluginRegistry_);
}

void MixEngine::removeAllMissingPlugins()
{
    std::lock_guard<std::mutex> lock(chainsMutex_);

    auto removeFromChain = [&](EffectChainManager* chain)
    {
        if (!chain) return;
        const auto missingJson = chain->getMissingNodesJSON();
        for (const auto& node : missingJson)
        {
            const int nid = node.value("nodeId", -1);
            if (nid >= 0) chain->removeEffect(nid);
        }
    };

    for (auto& [tid, chain] : effectChains_)
        removeFromChain(chain.get());
    removeFromChain(masterEffectChain_.get());
}

bool MixEngine::resetCrashedPlugin(int trackId, int nodeId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (trackId == -1)
    {
        if (!masterEffectChain_) return false;
        return masterEffectChain_->resetCrashedPlugin(nodeId);
    }
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    return it->second->resetCrashedPlugin(nodeId);
}

// ── Graph-mode routing (per-track) ──────────────────────────────────────────

bool MixEngine::addConnection(int trackId, int sourceNodeId, int destNodeId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    return it->second->addConnection(sourceNodeId, destNodeId);
}

bool MixEngine::removeConnection(int trackId, int sourceNodeId, int destNodeId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    return it->second->removeConnection(sourceNodeId, destNodeId);
}

bool MixEngine::setWireGain(int trackId, int srcId, int dstId, float gain)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    return it->second->setWireGain(srcId, dstId, gain);
}

bool MixEngine::setWireMute(int trackId, int srcId, int dstId, bool muted)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    return it->second->setWireMute(srcId, dstId, muted);
}

void MixEngine::setNodePosition(int trackId, int nodeId, float x, float y)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return;
    it->second->setNodePosition(nodeId, x, y);
}

std::string MixEngine::getGraphTopology(int trackId) const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return "{}";
    return it->second->getGraphTopology().dump();
}

bool MixEngine::isGraphLinear(int trackId) const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return true;
    return it->second->isGraphLinear();
}

// ── Graph-mode routing (master) ─────────────────────────────────────────────

bool MixEngine::addMasterConnection(int sourceNodeId, int destNodeId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return false;
    return masterEffectChain_->addConnection(sourceNodeId, destNodeId);
}

bool MixEngine::removeMasterConnection(int sourceNodeId, int destNodeId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return false;
    return masterEffectChain_->removeConnection(sourceNodeId, destNodeId);
}

bool MixEngine::setMasterWireGain(int srcId, int dstId, float gain)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return false;
    return masterEffectChain_->setWireGain(srcId, dstId, gain);
}

bool MixEngine::setMasterWireMute(int srcId, int dstId, bool muted)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return false;
    return masterEffectChain_->setWireMute(srcId, dstId, muted);
}

void MixEngine::setMasterNodePosition(int nodeId, float x, float y)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return;
    masterEffectChain_->setNodePosition(nodeId, x, y);
}

std::string MixEngine::getMasterGraphTopology() const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return "{}";
    return masterEffectChain_->getGraphTopology().dump();
}

bool MixEngine::isMasterGraphLinear() const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return true;
    return masterEffectChain_->isGraphLinear();
}

// ── Effect parameter / meter access ─────────────────────────────────────────

std::string MixEngine::getEffectParameters(int trackId, int nodeId) const
{
    if (trackId == -1) return getMasterEffectParameters(nodeId);
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return "[]";
    return it->second->getEffectParameters(nodeId);
}

bool MixEngine::setEffectParameter(int trackId, int nodeId, const std::string& paramId, float value)
{
    // trackId == -1 selects the master chain (header contract). The master
    // variant takes chainsMutex_ itself — early-return before locking here.
    if (trackId == -1) return setMasterEffectParameter(nodeId, paramId, value);
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    return it->second->setEffectParameter(nodeId, paramId, value);
}

std::string MixEngine::getEffectMeter(int trackId, int nodeId) const
{
    if (trackId == -1) return getMasterEffectMeter(nodeId);
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return "[0,0,0,0,0,0,0,0]";
    return it->second->getEffectMeter(nodeId);
}

std::string MixEngine::getMasterEffectParameters(int nodeId) const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return "[]";
    return masterEffectChain_->getEffectParameters(nodeId);
}

bool MixEngine::setMasterEffectParameter(int nodeId, const std::string& paramId, float value)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return false;
    return masterEffectChain_->setEffectParameter(nodeId, paramId, value);
}

std::string MixEngine::getMasterEffectMeter(int nodeId) const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return "[0,0,0,0,0,0,0,0]";
    return masterEffectChain_->getEffectMeter(nodeId);
}

// ── Direct effect pointer access ────────────────────────────────────────────

XlethEffectBase* MixEngine::getEffectPtr(int trackId, int nodeId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return nullptr;
    return it->second->getEffect(nodeId);
}

XlethEffectBase* MixEngine::getMasterEffectPtr(int nodeId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return nullptr;
    return masterEffectChain_->getEffect(nodeId);
}

// ── Effect visualization access ─────────────────────────────────────────────

bool MixEngine::setEffectVisualizationEnabled(int trackId, int nodeId, bool enabled)
{
    auto* effect = (trackId == -1)
        ? getMasterEffectPtr(nodeId)
        : getEffectPtr(trackId, nodeId);
    if (!effect) return false;
    effect->setVisualizationEnabled(enabled);
    return true;
}

std::size_t MixEngine::drainEffectVizFrames(int trackId, int nodeId,
                                            std::uint8_t* out, std::size_t maxBytes)
{
    auto* effect = (trackId == -1)
        ? getMasterEffectPtr(nodeId)
        : getEffectPtr(trackId, nodeId);
    if (!effect) return 0;
    return effect->drainVizFrames(out, maxBytes);
}

std::uint32_t MixEngine::getEffectVisualizationType(int trackId, int nodeId) const
{
    auto* effect = (trackId == -1)
        ? const_cast<MixEngine*>(this)->getMasterEffectPtr(nodeId)
        : const_cast<MixEngine*>(this)->getEffectPtr(trackId, nodeId);
    return effect ? effect->getVisualizationType() : 0u;
}

std::uint32_t MixEngine::getEffectVisualizationSchemaVersion(int trackId, int nodeId) const
{
    auto* effect = (trackId == -1)
        ? const_cast<MixEngine*>(this)->getMasterEffectPtr(nodeId)
        : const_cast<MixEngine*>(this)->getEffectPtr(trackId, nodeId);
    return effect ? effect->getVisualizationSchemaVersion() : 0u;
}

// ── Peak meter reads (slot-based via trackIdToSlot_) ─────────────────────────

float MixEngine::getTrackPeakL(int trackId) const
{
    std::shared_lock<std::shared_mutex> lock(slotMutex_);
    auto it = trackIdToSlot_.find(trackId);
    if (it == trackIdToSlot_.end()) return 0.0f;
    return trackPeaks_[it->second].peakL.load(std::memory_order_relaxed);
}

float MixEngine::getTrackPeakR(int trackId) const
{
    std::shared_lock<std::shared_mutex> lock(slotMutex_);
    auto it = trackIdToSlot_.find(trackId);
    if (it == trackIdToSlot_.end()) return 0.0f;
    return trackPeaks_[it->second].peakR.load(std::memory_order_relaxed);
}

// ── Track buffer management ──────────────────────────────────────────────────

void MixEngine::ensureTrackBuffers(int numSamples)
{
    if (trackBufferSize_ >= numSamples) return;

    // Re-allocate all track buffers (called rarely — only when buffer size grows)
    for (auto& buf : trackBuffers_)
        buf.setSize(2, numSamples, false, true, false);

    trackBufferSize_ = numSamples;
}

// ── Find active clips ────────────────────────────────────────────────────────

void MixEngine::findActiveClips(int64_t bufferStart, int64_t bufferEnd,
                                double bpm, double sampleRate)
{
    activeClips_.clear();

    if (timeline_ == nullptr) return;

    for (const auto* clip : timeline_->getAllClips())
    {
        if (clip == nullptr) continue;

        const int64_t clipStart = clip->position.toSamples(bpm, sampleRate);
        const int64_t clipEnd   = (clip->position + clip->duration).toSamples(bpm, sampleRate);

        // Skip clips that don't overlap this buffer
        if (clipEnd <= bufferStart || clipStart >= bufferEnd)
            continue;

        // Look up sample bank ID for this clip's region
        auto it = regionToSampleMap_.find(clip->regionId);
        if (it == regionToSampleMap_.end())
        {
            // Warn on unmapped region (throttled in maybeLogDebug)
            continue;
        }

        // Calculate region offset for syllable clips
        int64_t regionOffset = 0;
        if (clip->syllableIndex >= 0 && timeline_ != nullptr)
        {
            const auto* region = timeline_->getRegion(clip->regionId);
            if (region != nullptr && clip->syllableIndex < static_cast<int>(region->syllables.size()))
            {
                const auto& syl = region->syllables[clip->syllableIndex];
                regionOffset = static_cast<int64_t>(syl.startTime * sampleRate);
            }
        }

        // Clip-level regionOffset (from split or manual offset)
        if (clip->regionOffset.ticks > 0)
            regionOffset += clip->regionOffset.toSamples(bpm, sampleRate);

        activeClips_.push_back({clip, it->second, clipStart, clipEnd, regionOffset});
    }
}

// ── Find active pattern blocks ───────────────────────────────────────────────

void MixEngine::findActivePatternBlocks(int64_t bufferStart, int64_t bufferEnd,
                                        double bpm, double sampleRate)
{
    // Fix C: snapshot previous buffer's active blocks for per-block dropout
    // diff. Using swap preserves capacity in both vectors (no heap churn on
    // the audio thread), and populates prevActiveBlocks_ as a side effect.
    prevActiveBlocks_.swap(activeBlocks_);
    activeBlocks_.clear();

#ifdef XLETH_DEBUG
    // Audio-thread guardrail: the per-block diff below is O(N*M). "Typically
    // small" is exactly the assumption that breaks later — if a pattern-heavy
    // section ever drives this into the hundreds, catch it in debug builds
    // before it becomes an audio-thread stall in a release build.
    jassert(prevActiveBlocks_.size() < 64);
#endif

    if (timeline_ != nullptr)
    {
        for (const auto* block : timeline_->getAllPatternBlocks())
        {
            if (block == nullptr) continue;

            const int64_t blockStart = block->position.toSamples(bpm, sampleRate);
            const int64_t blockEnd   = (block->position + block->duration).toSamples(bpm, sampleRate);

            if (blockEnd <= bufferStart || blockStart >= bufferEnd) continue;

            const Pattern* pattern = timeline_->getPattern(block->patternId);
            if (pattern == nullptr) continue;
            if (pattern->regionId < 0) continue;

            // Samplers are keyed by {trackId, regionId}. Look up the pair
            // this block needs — audio thread does lookup only, never
            // allocates. If the sampler is missing (race with a new block
            // added mid-playback, SampleBank not yet populated), skip the
            // block. The main thread is responsible for ensuring every
            // referenced pair has a sampler before Play() starts.
            auto sit = samplers_.find({block->trackId, pattern->regionId});
            if (sit == samplers_.end()) continue;
            Sampler* sampler = sit->second.get();
            if (sampler == nullptr || !sampler->hasSample()) continue;

            activeBlocks_.push_back({block, pattern, sampler, blockStart, blockEnd});
        }
    }

    // Fix C: per-block dropout diff. The {trackId, regionId}-keyed
    // prevActiveKeys_ diff below only fires when a whole sampler drops out.
    // It cannot see the adjacent-block case: block X ends, block Y begins,
    // both on the same {track, region} → sampler stays live → prevActiveKeys_
    // thinks nothing changed, but X's held voices have lost their owning
    // block and can strand. This diff identifies blocks that were active
    // last buffer but aren't anymore, and if the sampler is still alive it
    // releases only the voices that spawned inside the dropped block.
    for (const auto& prev : prevActiveBlocks_)
    {
        if (prev.block == nullptr || prev.sampler == nullptr) continue;

        bool stillActive = false;
        for (const auto& cur : activeBlocks_) {
            if (cur.block == prev.block) { stillActive = true; break; }
        }
        if (stillActive) continue;

        // Block dropped. If the sampler is still alive in activeBlocks_,
        // prevActiveKeys_'s allNotesOff will NOT fire for it. Release
        // only the voices that belong to this dropped block.
        bool samplerStillAlive = false;
        for (const auto& cur : activeBlocks_) {
            if (cur.sampler == prev.sampler) { samplerStillAlive = true; break; }
        }
        if (samplerStillAlive) {
            prev.sampler->releaseVoicesSpawnedInRange(
                prev.blockStartSample, prev.blockEndSample);
        }
        // If the sampler is NOT still alive, the prevActiveKeys_ diff below
        // handles it (after Fix B that is a release-envelope, not hard-kill).
    }

    // Block-exit voice cutting: diff active {trackId, regionId} keys against
    // the previous buffer's set. Any key that WAS active but no longer has
    // an active block gets allNotesOff() on its sampler — handles block
    // deletion, block moves, and playhead jumping away mid-note. Keyed per
    // region so a block ending doesn't cut voices on a different region's
    // sampler that shares the same track.
    std::unordered_set<TrackRegionKey, TrackRegionKeyHash> currentKeys;
    for (const auto& apb : activeBlocks_) {
        if (apb.block && apb.pattern)
            currentKeys.insert({apb.block->trackId, apb.pattern->regionId});
    }

    for (const auto& key : prevActiveKeys_)
    {
        if (currentKeys.count(key) == 0)
        {
            auto it = samplers_.find(key);
            if (it != samplers_.end() && it->second) it->second->allNotesOff();
        }
    }
    prevActiveKeys_ = std::move(currentKeys);
}

// ── Trigger pattern notes (block-granular) ───────────────────────────────────

void MixEngine::triggerPatternNotes(const ActivePatternBlock& apb,
                                    int64_t bufferStart, int64_t bufferEnd,
                                    double bpm, double sampleRate)
{
    // Convert sample positions to ticks (960 PPQ).
    auto sampleToTick = [&](int64_t sample) -> int64_t {
        const double seconds = static_cast<double>(sample) / sampleRate;
        return static_cast<int64_t>(seconds * (bpm / 60.0) * 960.0);
    };

    const int64_t bufStartTick       = sampleToTick(bufferStart);
    const int64_t bufEndTick         = sampleToTick(bufferEnd);
    // Widen search by ±2 ticks to catch notes whose tick-domain position
    // rounds to just outside the narrow window but whose true sample position
    // falls within this buffer.  Sample-domain membership is the authoritative
    // filter applied in the dispatch loop below.
    const int64_t bufStartTickSearch = bufStartTick - 2;
    const int64_t bufEndTickSearch   = bufEndTick   + 2;

    const int64_t blockPosTicks    = apb.block->position.ticks;
    const int64_t blockOffsetTicks = apb.block->offset.ticks;
    const int64_t patternLenTicks  = apb.pattern->length.ticks;
    if (patternLenTicks <= 0) return;

    const int64_t blockEndTicks = blockPosTicks + apb.block->duration.ticks;

    const int64_t windowStart = std::max<int64_t>(bufStartTickSearch, blockPosTicks);
    const int64_t windowEnd   = std::min<int64_t>(bufEndTickSearch, blockEndTicks);
    if (windowEnd <= windowStart) return;

    // Loop iteration range for the (pattern-local) time axis. Clamp first to 0
    // so a block whose offset rolls the effective start negative still fires
    // notes from loop iteration 0 onward.
    const int64_t firstLoopIdx = std::max<int64_t>(
        0, (windowStart - blockPosTicks + blockOffsetTicks) / patternLenTicks);
    int64_t lastLoopIdx  =
        (windowEnd - blockPosTicks + blockOffsetTicks) / patternLenTicks;

    // When loopEnabled is false, only iteration 0 plays — notes past the
    // pattern boundary become silence (visible "empty space" in the UI).
    if (!apb.block->loopEnabled)
        lastLoopIdx = std::min<int64_t>(lastLoopIdx, 0);

    // Collect audio events (noteOn/noteOff/slideStart) into a stack-allocated
    // buffer so we can sort them before firing. The sort order guarantees:
    //   1. NoteOffs fire before NoteOns at the same tick — critical for
    //      arpeggiator chord transitions; without it, adjacent chords leak
    //      notes into each other because heldNotes_ never empties.
    //      (Mirrors XlethAddon::emitArpVideoEvents.)
    //   2. NoteOns fire before SlideStarts at the same tick — so a slide
    //      note that lands on the same tick as a chord's noteOns correctly
    //      captures those just-spawned voices in its group, instead of
    //      targeting future voices.
    //
    // Slide notes (PatternNote.isSlide == true) emit a single SlideStart
    // event — NO noteOn, NO noteOff. They are silent pitch-target markers
    // consumed by Sampler::beginGroupSlide.
    struct AudioEvent {
        enum Type : uint8_t { NoteOff = 0, NoteOn = 1, SlideStart = 2 };
        int64_t tick;
        Type    type;
        int     pitch;
        float   velocity;             // NoteOn only
        double  slideDurationSamples; // SlideStart only
        float   cx;                   // SlideStart only (bezier ctrl x)
        float   cy;                   // SlideStart only (bezier ctrl y)
    };
    static constexpr int kMaxEvents = 512;
    AudioEvent events[kMaxEvents];
    int eventCount = 0;

    for (const auto& note : apb.pattern->notes)
    {
        for (int64_t L = firstLoopIdx; L <= lastLoopIdx; ++L)
        {
            const int64_t absNoteOn  = blockPosTicks - blockOffsetTicks
                                       + L * patternLenTicks + note.position.ticks;
            // Clamp the note-off to the block end so notes whose duration
            // reaches (or exceeds) the block boundary still release instead
            // of ringing past it.
            const int64_t rawNoteOff = absNoteOn + note.duration.ticks;
            const int64_t absNoteOff = std::min<int64_t>(rawNoteOff, blockEndTicks);

            if (note.isSlide)
            {
                // Slide note → single SlideStart event at the start tick.
                // Duration is the note's TickTime duration converted to
                // samples; cx/cy carry bezier easing for the audio glide.
                if (absNoteOn >= windowStart && absNoteOn < windowEnd
                    && eventCount < kMaxEvents) {
                    AudioEvent e{};
                    e.tick = absNoteOn;
                    e.type = AudioEvent::SlideStart;
                    e.pitch = note.pitch;
                    e.velocity = 0.0f;
                    e.slideDurationSamples =
                        static_cast<double>(note.duration.toSamples(bpm, sampleRate));
                    e.cx = note.slideCurveCx;
                    e.cy = note.slideCurveCy;
                    events[eventCount++] = e;
                }
                // Slide notes do NOT emit NoteOn/NoteOff — silence by design.
                continue;
            }

            if (absNoteOn >= windowStart && absNoteOn < windowEnd
                && eventCount < kMaxEvents) {
                AudioEvent e{};
                e.tick = absNoteOn;
                e.type = AudioEvent::NoteOn;
                e.pitch = note.pitch;
                e.velocity = note.velocity;
                events[eventCount++] = e;
#ifdef XLETH_DEBUG
                // Log where the noteOff for this note would land relative to the window.
                // offInWin=YES means both events fire in the same buffer (very short note).
                // offInWin=NO means the noteOff must be picked up in a later buffer.
                fprintf(stderr, "[NoteOffDiag] noteOnTick=%lld noteOffTick=%lld dur=%lld "
                        "blockEnd=%lld windowStart=%lld windowEnd=%lld offInWin=%s\n",
                        (long long)absNoteOn, (long long)absNoteOff,
                        (long long)note.duration.ticks, (long long)blockEndTicks,
                        (long long)windowStart, (long long)windowEnd,
                        (absNoteOff > windowStart && absNoteOff <= windowEnd) ? "YES" : "NO");
#endif
            }

            // Half-open on the start side, inclusive on the end side so an
            // off-event that lands exactly on windowEnd (common: note ends at
            // pattern/block boundary) still fires in this buffer.
            if (absNoteOff > windowStart && absNoteOff <= windowEnd
                && eventCount < kMaxEvents) {
                AudioEvent e{};
                e.tick = absNoteOff;
                e.type = AudioEvent::NoteOff;
                e.pitch = note.pitch;
                e.velocity = 0.0f;
                events[eventCount++] = e;
            }
        }
    }

    // Catch capacity overflow in debug builds — a dropped noteOff means a
    // stuck voice, so surface this during testing rather than silently clipping.
    jassert(eventCount < kMaxEvents);

    // Sort by tick, then by type (NoteOff < NoteOn < SlideStart) at equal tick.
    // - NoteOff before NoteOn: arpeggiator drains heldNotes_ before the next
    //   chord enters.
    // - NoteOn before SlideStart: a same-tick slide can capture just-spawned
    //   voices instead of targeting future-spawned ones.
    std::sort(events, events + eventCount,
        [](const AudioEvent& a, const AudioEvent& b) {
            if (a.tick != b.tick) return a.tick < b.tick;
            return a.type < b.type;
        });

    const int numSamples = static_cast<int>(bufferEnd - bufferStart);

    for (int i = 0; i < eventCount; ++i) {
        const AudioEvent& e = events[i];
        const int64_t absSample = TickTime{e.tick}.toSamples(bpm, sampleRate);

        // Sample-domain membership is the authoritative filter.
        // The widened tick window may have admitted candidates from adjacent
        // buffers; discard them here before computing the offset.
        if (absSample < bufferStart) continue;

        switch (e.type) {
            case AudioEvent::NoteOn: {
                if (absSample >= bufferEnd) continue;
                const int sampleOffset = static_cast<int>(absSample - bufferStart);
                jassert(sampleOffset >= 0 && sampleOffset < numSamples);
#ifdef XLETH_DEBUG
                fprintf(stderr, "[PatternTrig] absTick=%lld absSample=%lld "
                        "bufStart=%lld bufEnd=%lld numSamples=%d offset=%d\n",
                        (long long)e.tick, (long long)absSample,
                        (long long)bufferStart, (long long)bufferEnd, numSamples,
                        sampleOffset);
#endif
                apb.sampler->noteOn(e.pitch, e.velocity, sampleOffset);
                break;
            }
            case AudioEvent::NoteOff: {
                // Inclusive end (> not >=). A note-off whose sample equals
                // bufferEnd MUST dispatch in this buffer — in the next buffer
                // the owning PatternBlock is absent from activeBlocks_
                // (half-open [blockStart, blockEnd) filter) and no pending-off
                // state would re-emit it. Admitting it here is the last chance.
                if (absSample > bufferEnd) continue;
                int noteOffOffset = static_cast<int>(absSample - bufferStart);
                // Clamp for the deferred-release scheduler: the sample-loop
                // gate `s >= v.releaseSample` is never true when
                // releaseSample == numSamples, which would strand the voice.
                // Firing one sample early at the edge is inaudible.
                if (noteOffOffset >= numSamples) noteOffOffset = numSamples - 1;
                jassert(noteOffOffset >= 0 && noteOffOffset < numSamples);
#ifdef XLETH_DEBUG
                fprintf(stderr, "[PatternOff] absTick=%lld absSample=%lld "
                        "bufStart=%lld bufEnd=%lld numSamples=%d offset=%d\n",
                        (long long)e.tick, (long long)absSample,
                        (long long)bufferStart, (long long)bufferEnd, numSamples,
                        noteOffOffset);
#endif
                apb.sampler->noteOff(e.pitch, noteOffOffset, /*force=*/true);
                break;
            }
            case AudioEvent::SlideStart: {
                if (absSample >= bufferEnd) continue;
                const int sampleOffset = static_cast<int>(absSample - bufferStart);
                jassert(sampleOffset >= 0 && sampleOffset < numSamples);
#ifdef XLETH_DEBUG
                fprintf(stderr, "[PatternSlide] absTick=%lld absSample=%lld "
                        "targetPitch=%d durSamples=%.1f cx=%.3f cy=%.3f offset=%d\n",
                        (long long)e.tick, (long long)absSample,
                        e.pitch, e.slideDurationSamples,
                        e.cx, e.cy, sampleOffset);
#endif
                apb.sampler->beginGroupSlide(e.pitch, e.slideDurationSamples,
                                             e.cx, e.cy, sampleOffset);
                break;
            }
        }
    }
}

// ── processBlock ─────────────────────────────────────────────────────────────
// AUDIO THREAD — no alloc (after first call), no locks, no I/O.

void MixEngine::processBlock(juce::AudioBuffer<float>& outputBuffer,
                             int                       numSamples,
                             const Transport&          transport)
{
    // Early out: no timeline
    if (timeline_ == nullptr)
    {
        masterPeakL_.store(0.0f, std::memory_order_relaxed);
        masterPeakR_.store(0.0f, std::memory_order_relaxed);
        return;
    }

    const double sampleRateForPreview = transport.getSampleRate();

    // When transport is stopped, still render any active sampler voices so
    // note-preview (keyboard click) is audible. Skip the full clip/pattern
    // pipeline — just mix sampler voices into a dedicated preview bus.
    const bool isPlaying = transport.isPlaying();
    // Transport-stop transition: release any held notes so sustained envelopes
    // begin their release tail immediately instead of continuing to hold.
    if (wasPlaying_ && !isPlaying)
    {
        for (auto& kv : samplers_)
            if (kv.second) kv.second->allNotesOff();
        for (auto& kv : previewSamplers_)
            if (kv.second) kv.second->allNotesOff();
        // Reset active-block tracking so a subsequent Play doesn't think the
        // pre-stop blocks were previously active (and spuriously silence them).
        prevActiveKeys_.clear();
        lastBufferEnd_ = -1;
        pendingEffectChainReset_ = true;
        std::fill(std::begin(tailEndSamples_), std::end(tailEndSamples_), int64_t(0));
        clipModReader_.resetAllStates();
    }
    wasPlaying_ = isPlaying;

    if (!isPlaying)
    {
        if (previewBuffer_.getNumSamples() < numSamples)
            previewBuffer_.setSize(2, numSamples, false, true, false);
        previewBuffer_.clear(0, numSamples);

        const double previewBPM = transport.getBPM();
        for (auto& kv : samplers_)
        {
            Sampler* s = kv.second.get();
            if (s != nullptr && s->hasSample()) {
                s->setBPM(previewBPM);
                s->processBlock(previewBuffer_, numSamples, sampleRateForPreview);
            }
        }
        for (auto& kv : previewSamplers_)
        {
            Sampler* s = kv.second.get();
            if (s != nullptr && s->hasSample()) {
                s->setBPM(previewBPM);
                s->processBlock(previewBuffer_, numSamples, sampleRateForPreview);
            }
        }

        for (int ch = 0; ch < std::min(2, outputBuffer.getNumChannels()); ++ch)
            outputBuffer.addFrom(ch, 0, previewBuffer_, ch, 0, numSamples);

        for (int ch = 0; ch < outputBuffer.getNumChannels(); ++ch)
        {
            float* data = outputBuffer.getWritePointer(ch);
            for (int s = 0; s < numSamples; ++s)
            {
                if (data[s] > 1.0f)       data[s] = 1.0f;
                else if (data[s] < -1.0f) data[s] = -1.0f;
            }
        }

        const float mL = outputBuffer.getMagnitude(0, 0, numSamples);
        const float mR = outputBuffer.getNumChannels() >= 2
                       ? outputBuffer.getMagnitude(1, 0, numSamples)
                       : 0.0f;
        masterPeakL_.store(mL, std::memory_order_relaxed);
        masterPeakR_.store(mR, std::memory_order_relaxed);
        return;
    }

    const double bpm        = transport.getBPM();
    XlethEffectBase::setGlobalBPM(bpm);
    const double sampleRate = transport.getSampleRate();
    const int64_t position  = transport.getPositionSamples();
    const int64_t bufStart  = position;
    const int64_t bufEnd    = position + numSamples;

    // Seek detection: if buffer start doesn't continue from previous buffer
    // end, the playhead jumped. Release all held pattern notes so stale
    // voices from the old position don't ring indefinitely at the new one.
    if (lastBufferEnd_ >= 0 && bufStart != lastBufferEnd_) {
        for (auto& kv : samplers_)
            if (kv.second) kv.second->allNotesOff();
        pendingEffectChainReset_ = true;
        std::fill(std::begin(tailEndSamples_), std::end(tailEndSamples_), int64_t(0));
        clipModReader_.resetAllStates();
    }
    lastBufferEnd_ = bufEnd;

    ensureTrackBuffers(numSamples);

    // Find clips active in this buffer window
    findActiveClips(bufStart, bufEnd, bpm, sampleRate);

    // Determine which tracks are in use, and check for solo
    auto allTracks = timeline_->getAllTracks();
    bool anySolo = false;
    for (const auto* t : allTracks)
    {
        if (t != nullptr && t->solo)
        {
            anySolo = true;
            break;
        }
    }

    // Build a set of track IDs that have active clips (to know which buffers to clear)
    // Use a simple bitfield for track indices 0..kMaxTracks-1
    // We need to map trackId → index. Use trackId directly if < kMaxTracks.
    // For safety, build a map of trackId → track slot index.
    // Since track IDs are small integers from Timeline's auto-increment, they'll
    // generally be small. We'll use an unordered_map for safety.
    struct TrackSlot
    {
        int             slotIndex;
        const TrackInfo* info;
        bool            hasClips;
        bool            hasReleasingVoices;
    };

    // Stack-allocated array for up to kMaxTracks track slots
    TrackSlot trackSlots[kMaxTracks];
    int numTrackSlots = 0;
    std::unordered_map<int, int> trackIdToSlot;

    for (const auto* t : allTracks)
    {
        if (t == nullptr || numTrackSlots >= kMaxTracks) continue;
        const int slot = numTrackSlots++;
        trackSlots[slot] = {slot, t, false, false};
        trackIdToSlot[t->id] = slot;
    }

    // Clear track buffers that will be used
    for (int i = 0; i < numTrackSlots; ++i)
        trackBuffers_[i].clear(0, numSamples);

    // Precompute clip boundary fade length for this block (0 = disabled, no overhead).
    const int clipFadeN = clipBoundaryFadeSamples_.load(std::memory_order_relaxed);

    // ── Render active clips into track buffers ───────────────────────────────
    for (const auto& ac : activeClips_)
    {
        auto slotIt = trackIdToSlot.find(ac.clip->trackId);
        if (slotIt == trackIdToSlot.end()) continue;

        const int slot = slotIt->second;
        trackSlots[slot].hasClips = true;

        auto& trackBuf = trackBuffers_[slot];

        const auto* srcBuf = sampleBank_->getSample(ac.sampleBankId);
        if (srcBuf == nullptr) continue;

        const int srcChannels = srcBuf->getNumChannels();
        const int srcTotal    = srcBuf->getNumSamples();

        const bool isGlobalStretch = (ac.clip->stretchMethod == StretchMethod::Global);
        const int resolvedStretchMethod = isGlobalStretch
            ? globalStretchMethod_
            : static_cast<int>(ac.clip->stretchMethod);
        const bool resolvedFormantPreserve = isGlobalStretch
            ? globalFormantPreserve_
            : ac.clip->formantPreserve;

        // ── Cache check (zero overhead when no processing needed) ────────────
        const bool needsProcessing = (ac.clip->pitchOffset    != 0
                                   || ac.clip->pitchOffsetCents != 0
                                   || ac.clip->reversed
                                   || ac.clip->stretchRatio   != 1.0);

        // Build CacheKey and attempt a lock-free cache hit
        const juce::AudioBuffer<float>* readBuf  = nullptr; // points to processed buffer
        bool                            cacheHit = false;

        if (needsProcessing)
        {
            CacheKey key;
            key.regionId            = ac.clip->regionId;
            key.syllableIndex       = ac.clip->syllableIndex;
            key.regionOffsetSamples = ac.regionOffsetSamples;
            key.durationSamples     = ac.clipEndSample - ac.clipStartSample;
            key.sourceLengthSamples = srcTotal;
            key.pitchOffsetSemis    = ac.clip->pitchOffset;
            key.pitchOffsetCents    = ac.clip->pitchOffsetCents;
            key.reversed            = ac.clip->reversed;
            key.stretchRatio        = ac.clip->stretchRatio;
            key.stretchMethod       = resolvedStretchMethod;
            key.formantPreserve     = resolvedFormantPreserve;

            readBuf  = clipRenderCache_.getProcessedBuffer(ac.clip->id, key);
            cacheHit = (readBuf != nullptr);
        }

#ifdef XLETH_DEBUG
        // Throttled render-loop log: fire once every 1024 calls per clip slot (lock-free)
        if (needsProcessing) {
            static std::atomic<int> renderLogCounters[ClipRenderCache::kMaxClipId] {};
            const int clipSlot = (ac.clip->id >= 0 && ac.clip->id < ClipRenderCache::kMaxClipId) ? ac.clip->id : 0;
            if ((renderLogCounters[clipSlot].fetch_add(1, std::memory_order_relaxed) & 1023) == 0) {
                fprintf(stderr, "[MixRender] clip=%d needsProcessing=true cacheHit=%d\n",
                        ac.clip->id, (int)cacheHit);
            }
        }
#endif

        // ── Per-clip bezier fade LUTs (stack-allocated, built once per clip) ──
        const int64_t clipLen = ac.clipEndSample - ac.clipStartSample;
        float fadeInPercent = ac.clip->fadeInPercent;
        float fadeOutPercent = ac.clip->fadeOutPercent;
        normalizeClipFadePercents(fadeInPercent, fadeOutPercent);

        const int64_t fadeInSamples = clipFadePercentToSamples(clipLen, fadeInPercent);
        const int64_t fadeOutSamples = clipFadePercentToSamples(clipLen, fadeOutPercent);

        ClipFadeLUT fadeInLUT, fadeOutLUT;
        if (fadeInSamples > 0)
            fadeInLUT.build(ac.clip->fadeInX1, ac.clip->fadeInY1,
                           ac.clip->fadeInX2, ac.clip->fadeInY2);
        if (fadeOutSamples > 0)
            fadeOutLUT.build(ac.clip->fadeOutX1, ac.clip->fadeOutY1,
                            ac.clip->fadeOutX2, ac.clip->fadeOutY2);

        // ── Phase C / D.1: Clip Modulation FX — vibrato + vinyl scratch ─────
        // Plain clips read raw source PCM through a fractional, modulated
        // readhead. Stretched clips read ClipRenderCache's processed buffer:
        // the cache has already consumed regionOffsetSamples and written a
        // clip-local post-stretch buffer starting at sample 0. Fades, boundary
        // declick, and velocity are still applied exactly once by the reader.
        const auto& clipMod = ac.clip->modulation;
        const bool useModulatedReader = xleth::clipmod::isClipModulationCompatible(
            ac.clip->reversed,
            ac.clip->stretchRatio,
            resolvedFormantPreserve,
            clipMod);
        const bool usePostCacheModulatedReader =
            useModulatedReader
            && ac.clip->stretchRatio != 1.0
            && !ac.clip->reversed
            && !resolvedFormantPreserve;

        if (useModulatedReader)
        {
            if (usePostCacheModulatedReader && !cacheHit)
            {
                // Cache jobs are requested by the existing clip-processing
                // invalidation path off the audio thread. On a miss, silence
                // this clip block rather than modulating raw PCM and bypassing
                // the user's selected stretch engine.
                continue;
            }

            xleth::audio::ClipModulatedReader::BlockParams p {};
            p.srcBuf              = usePostCacheModulatedReader ? readBuf : srcBuf;
            p.regionOffsetSamples = usePostCacheModulatedReader ? 0 : ac.regionOffsetSamples;
            p.clipStartSample     = ac.clipStartSample;
            p.clipEndSample       = ac.clipEndSample;
            p.bufStart            = bufStart;
            p.numOutputSamples    = numSamples;
            p.bpm                 = bpm;
            p.sampleRate          = sampleRate;
            p.pitchOffsetSemis    = usePostCacheModulatedReader ? 0 : ac.clip->pitchOffset;
            p.pitchOffsetCents    = usePostCacheModulatedReader ? 0 : ac.clip->pitchOffsetCents;
            p.fadeInSamples       = fadeInSamples;
            p.fadeOutSamples      = fadeOutSamples;
            p.fadeInLUT           = (fadeInSamples > 0)  ? &fadeInLUT  : nullptr;
            p.fadeOutLUT          = (fadeOutSamples > 0) ? &fadeOutLUT : nullptr;
            p.clipBoundaryFadeN   = clipFadeN;
            p.velocity            = ac.clip->velocity;
            p.modulation          = &ac.clip->modulation;

            clipModReader_.renderBlock(p, trackBuf, ac.clip->id);
            clipModReader_.markClipSeen(ac.clip->id);
            continue;
        }

        // For each sample in this buffer, calculate what to read from the source
        for (int s = 0; s < numSamples; ++s)
        {
            const int64_t absPos = bufStart + s;

            // Skip samples outside this clip's range
            if (absPos < ac.clipStartSample || absPos >= ac.clipEndSample)
                continue;

            const int64_t posInClip = absPos - ac.clipStartSample;
            const int64_t fromEnd   = clipLen - 1 - posInClip;

            // Velocity × per-side fade. User bezier curve takes priority on each
            // side independently; global Hann declick fills any side without one.
            float gain = ac.clip->velocity;

            // IN side
            if (fadeInSamples > 0 && posInClip < fadeInSamples)
            {
                const float t = static_cast<float>(posInClip) / static_cast<float>(fadeInSamples);
                gain *= fadeInLUT.sample(t);
            }
            else if (fadeInSamples == 0 && clipFadeN > 0)
            {
                gain *= xleth::dsp::DeclickEnvelope::fadeIn(static_cast<int>(posInClip), clipFadeN);
            }

            // OUT side
            if (fadeOutSamples > 0 && fromEnd < fadeOutSamples)
            {
                const float t = static_cast<float>(fromEnd) / static_cast<float>(fadeOutSamples);
                gain *= fadeOutLUT.sample(t);
            }
            else if (fadeOutSamples == 0 && clipFadeN > 0)
            {
                gain *= xleth::dsp::DeclickEnvelope::fadeOut(static_cast<int>(fromEnd), clipFadeN);
            }

            if (cacheHit)
            {
                // ── Cache hit: read from pre-processed buffer ────────────────
                // readBuf is indexed from 0 (= clip start), no offset needed.
                const int rp         = static_cast<int>(posInClip);
                const int readCh     = readBuf->getNumChannels();
                const int readTotal  = readBuf->getNumSamples();
                if (rp < 0 || rp >= readTotal) continue;

                if (readCh == 1)
                {
                    const float sample = readBuf->getSample(0, rp) * gain;
                    trackBuf.addSample(0, s, sample);
                    trackBuf.addSample(1, s, sample);
                }
                else
                {
                    trackBuf.addSample(0, s, readBuf->getSample(0, rp) * gain);
                    trackBuf.addSample(1, s, readBuf->getSample(std::min(1, readCh - 1), rp) * gain);
                }
            }
            else
            {
                // ── Raw PCM fallback (cache miss or no processing needed) ────
                const int64_t samplePos = posInClip + ac.regionOffsetSamples;
                if (samplePos < 0 || samplePos >= srcTotal) continue;
                const int sp = static_cast<int>(samplePos);

                if (srcChannels == 1)
                {
                    const float sample = srcBuf->getSample(0, sp) * gain;
                    trackBuf.addSample(0, s, sample);
                    trackBuf.addSample(1, s, sample);
                }
                else
                {
                    trackBuf.addSample(0, s, srcBuf->getSample(0, sp) * gain);
                    trackBuf.addSample(1, s, srcBuf->getSample(std::min(1, srcChannels - 1), sp) * gain);
                }
            }
        }
    }

    // Phase C: clear vibrato-reader state for any clip that wasn't rendered
    // through the modulated path this block (e.g. clip ended, was deleted, or
    // had vibrato turned off). Without this, a clip that re-activates later
    // would resume from a stale sourcePosD.
    clipModReader_.resetUnseenStates();

    // ── Render pattern blocks into track buffers ─────────────────────────────
    findActivePatternBlocks(bufStart, bufEnd, bpm, sampleRate);

    // Deterministic cross-block event dispatch order at shared-sampler boundaries.
    // When two ActivePatternBlocks share the same Sampler and events collide at a
    // boundary tick, the earlier-starting block must dispatch first so noteOff binds
    // to the original voice before noteOn spawns a new one. stable_sort preserves
    // timeline storage order as the tiebreaker when blockStartSample collides.
    std::stable_sort(activeBlocks_.begin(), activeBlocks_.end(),
        [](const ActivePatternBlock& a, const ActivePatternBlock& b) {
            return a.blockStartSample < b.blockStartSample;
        });

    for (const auto& apb : activeBlocks_)
    {
        auto slotIt = trackIdToSlot.find(apb.block->trackId);
        if (slotIt == trackIdToSlot.end()) continue;
        const int slot = slotIt->second;
        trackSlots[slot].hasClips = true;   // mark track as having audio

        // Pass BPM for arpeggiator tempo sync.
        apb.sampler->setBPM(bpm);

        // INVARIANT: pass bufStart (buffer-start absolute sample) — not bufEnd or a
        // per-sample counter. fireNoteOn computes spawnAbsSample as
        // (currentAbsSample_ + sampleOffset), where sampleOffset is BUFFER-RELATIVE.
        apb.sampler->setCurrentSample(bufStart);

        // Sample-accurate (block-granular) note triggering.
        triggerPatternNotes(apb, bufStart, bufEnd, bpm, sampleRate);

        // Mirror visualOnly flag into the sampler so processBlock zeroes its output.
        apb.sampler->setVisualOnly(trackSlots[slot].info->visualOnly);

        // Additively render sampler voices into the track buffer.
        apb.sampler->processBlock(trackBuffers_[slot], numSamples, sampleRate);
    }


    // ── Drain releasing sampler voices (block just ended) ───────────────────
    // After allNotesOff() fires in findActivePatternBlocks(), voices enter
    // their release phase but the block is no longer in activeBlocks_.
    // Render them here so the release tail is audible and feeds the effect chain.
    for (auto& [key, sampler] : samplers_)
    {
        if (!sampler || !sampler->hasSample()) continue;
        if (sampler->activeVoiceCount() == 0) continue;

        // Skip if this sampler was already rendered by the activeBlocks_ loop
        if (prevActiveKeys_.count(key) > 0) continue;

        auto slotIt = trackIdToSlot.find(key.trackId);
        if (slotIt == trackIdToSlot.end()) continue;
        const int slot = slotIt->second;
        if (slot >= numTrackSlots) continue;

        trackSlots[slot].hasReleasingVoices = true;
        sampler->setVisualOnly(trackSlots[slot].info->visualOnly);
        sampler->processBlock(trackBuffers_[slot], numSamples, sampleRate);
    }

    // ── Populate per-track MidiBuffers with onset events ──────────────────────
    // Effects (e.g. TransientProcessor) can read these for sample-accurate
    // note-on and clip-start timing.  Channel 1 = pattern notes, channel 2 =
    // clip starts.  Only note-on events — no note-offs.
    for (int i = 0; i < numTrackSlots; ++i)
        trackMidiBuffers_[i].clear();

    // Clip-start events (channel 2, pitch 60, velocity from clip)
    for (const auto& ac : activeClips_)
    {
        if (ac.clipStartSample >= bufStart && ac.clipStartSample < bufEnd)
        {
            auto slotIt = trackIdToSlot.find(ac.clip->trackId);
            if (slotIt == trackIdToSlot.end()) continue;
            const int bufOffset = static_cast<int>(ac.clipStartSample - bufStart);
            const auto vel = static_cast<juce::uint8>(
                juce::jlimit(0.0f, 1.0f, ac.clip->velocity) * 127.0f);
            trackMidiBuffers_[slotIt->second].addEvent(
                juce::MidiMessage::noteOn(2, 60, vel), bufOffset);
        }
    }

    // Pattern note-on events (channel 1, pitch & velocity from note)
    for (const auto& apb : activeBlocks_)
    {
        auto slotIt = trackIdToSlot.find(apb.block->trackId);
        if (slotIt == trackIdToSlot.end()) continue;
        const int slot = slotIt->second;

        const int64_t blockPosTicks    = apb.block->position.ticks;
        const int64_t blockOffsetTicks = apb.block->offset.ticks;
        const int64_t patternLenTicks  = apb.pattern->length.ticks;
        if (patternLenTicks <= 0) continue;
        const int64_t blockEndTicks = blockPosTicks + apb.block->duration.ticks;

        auto tickToSample = [&](int64_t tick) -> int64_t {
            return static_cast<int64_t>((tick / 960.0) * (60.0 / bpm) * sampleRate);
        };
        auto sampleToTick = [&](int64_t sample) -> int64_t {
            return static_cast<int64_t>(
                (static_cast<double>(sample) / sampleRate) * (bpm / 60.0) * 960.0);
        };

        const int64_t bufStartTick = sampleToTick(bufStart);
        const int64_t bufEndTick   = sampleToTick(bufEnd);
        const int64_t windowStart  = std::max<int64_t>(bufStartTick, blockPosTicks);
        const int64_t windowEnd    = std::min<int64_t>(bufEndTick, blockEndTicks);
        if (windowEnd <= windowStart) continue;

        const int64_t firstLoop = std::max<int64_t>(
            0, (windowStart - blockPosTicks + blockOffsetTicks) / patternLenTicks);
        int64_t lastLoop = (windowEnd - blockPosTicks + blockOffsetTicks) / patternLenTicks;
        if (!apb.block->loopEnabled)
            lastLoop = std::min<int64_t>(lastLoop, 0);

        for (const auto& note : apb.pattern->notes)
        {
            for (int64_t L = firstLoop; L <= lastLoop; ++L)
            {
                const int64_t absNoteOn = blockPosTicks - blockOffsetTicks
                                          + L * patternLenTicks + note.position.ticks;
                if (absNoteOn < windowStart || absNoteOn >= windowEnd) continue;

                const int64_t absNoteOnSample = tickToSample(absNoteOn);
                const int bufOffset = static_cast<int>(absNoteOnSample - bufStart);
                if (bufOffset < 0 || bufOffset >= numSamples) continue;

                const auto vel = static_cast<juce::uint8>(
                    juce::jlimit(0.0f, 1.0f, note.velocity) * 127.0f);
                trackMidiBuffers_[slot].addEvent(
                    juce::MidiMessage::noteOn(1, note.pitch, vel), bufOffset);
            }
        }
    }

    // [MidiPop] Throttled debug log — every ~500 blocks
    {
        static int midiPopCounter = 0;
        if (++midiPopCounter >= 500)
        {
            midiPopCounter = 0;
            for (int i = 0; i < numTrackSlots; ++i)
            {
                if (trackMidiBuffers_[i].getNumEvents() > 0)
                {
                    MixDebugEntry entry;
                    entry.type = MixDebugEntry::Peaks; // reuse existing type
                    snprintf(entry.message, sizeof(entry.message),
                             "[MidiPop] track slot %d: %d events",
                             i, trackMidiBuffers_[i].getNumEvents());
                    debugLog_.push(entry);
                }
            }
        }
    }

    // ── Per-track processing: volume, pan, peaks, sum to output ──────────────
    // Acquire the chains mutex for effect processing.  In realtime mode,
    // use try_to_lock to avoid blocking the audio thread (skip effects if
    // contended).  In offline/non-realtime mode, block until acquired so
    // effects are never skipped.
    std::unique_lock<std::mutex> chainsLockGuard(chainsMutex_, std::defer_lock);
    if (nonRealtime_.load(std::memory_order_relaxed))
        chainsLockGuard.lock();
    else
        (void)chainsLockGuard.try_lock();
    const bool chainsLocked = chainsLockGuard.owns_lock();

    if (pendingEffectChainReset_ && chainsLocked)
    {
        for (auto& [trackId, chain] : effectChains_)
        {
            juce::ignoreUnused(trackId);
            if (chain)
                chain->resetProcessors();
        }

        if (masterEffectChain_)
            masterEffectChain_->resetProcessors();

        pendingEffectChainReset_ = false;
    }

    float masterPeakL = 0.0f;
    float masterPeakR = 0.0f;

    for (int i = 0; i < numTrackSlots; ++i)
    {
        const auto* track = trackSlots[i].info;

        // Mute/solo logic: if any track is soloed, only play soloed tracks.
        // If a track is muted (and not soloed), skip it.
        const bool shouldPlay = anySolo ? track->solo : !track->muted;

        if (!shouldPlay)
        {
            trackPeaks_[i].peakL.store(0.0f, std::memory_order_relaxed);
            trackPeaks_[i].peakR.store(0.0f, std::memory_order_relaxed);
            tailEndSamples_[i] = 0;
            continue;
        }

        // Tail-aware processing: keep calling the effect chain after content
        // ends so delay/reverb internal buffers drain naturally.
        const bool hasAudio  = trackSlots[i].hasClips || trackSlots[i].hasReleasingVoices;
        const bool isTailing = !hasAudio
                             && tailEndSamples_[i] > 0
                             && bufStart < tailEndSamples_[i];

        if (!hasAudio && !isTailing)
        {
            trackPeaks_[i].peakL.store(0.0f, std::memory_order_relaxed);
            trackPeaks_[i].peakR.store(0.0f, std::memory_order_relaxed);
            tailEndSamples_[i] = 0;
            continue;
        }

        // 1. Update smoothed volume target so the ramp stays current even
        //    while effects run.  Indexed by slot i (always in [0, kMaxTracks)).
        volumeSmoothed_[i].setTargetValue(
            trackParams_[i].volume.load(std::memory_order_relaxed));

        // Per-track insert effect chain (if present) — runs on the full-level
        // input so level-dependent effects (compressor, gate, etc.) respond to
        // the original dynamics, not the fader position.
        if (chainsLocked)
        {
            auto chainIt = effectChains_.find(track->id);
            if (chainIt != effectChains_.end() && chainIt->second && chainIt->second->isInitialized())
            {
                chainIt->second->processBlock(trackBuffers_[i], numSamples,
                                              trackMidiBuffers_[i]);

                // While audio is entering the effect chain, keep refreshing the
                // tail-end timestamp.  Once content stops, the countdown runs
                // from the last refresh and the chain processes silent buffers
                // until its internal state drains.
                if (hasAudio)
                {
                    const double tailSec = chainIt->second->getMaxTailLengthSeconds();
                    if (tailSec > 0.0)
                        tailEndSamples_[i] = bufEnd
                            + static_cast<int64_t>(tailSec * sampleRate);
                    else
                        tailEndSamples_[i] = 0;
                }
            }
        }

        // Post-effects fader — 20ms linear ramp to eliminate zipper noise.
        {
            const int nCh = trackBuffers_[i].getNumChannels();
            float* bufL = trackBuffers_[i].getWritePointer(0);
            float* bufR = nCh > 1 ? trackBuffers_[i].getWritePointer(1) : nullptr;
            for (int s = 0; s < numSamples; ++s)
            {
                const float g = volumeSmoothed_[i].getNextValue();
                bufL[s] *= g;
                if (bufR != nullptr) bufR[s] *= g;
            }
        }

        // 2. Pan + spread + peak measurement.
        //    Pass volume=1.0f — volume was already applied by SmoothedValue above.
        //    Indexed by slot i, not track ID.
        const float pan    = trackParams_[i].pan.load(std::memory_order_relaxed);
        const float spread = trackParams_[i].spread.load(std::memory_order_relaxed);
        float tpL = 0.0f, tpR = 0.0f;
        TrackMixer::process(trackBuffers_[i], 1.0f, pan, spread, tpL, tpR);

        // Store track peaks
        trackPeaks_[i].peakL.store(tpL, std::memory_order_relaxed);
        trackPeaks_[i].peakR.store(tpR, std::memory_order_relaxed);

        // Sum into output
        for (int ch = 0; ch < std::min(2, outputBuffer.getNumChannels()); ++ch)
        {
            outputBuffer.addFrom(ch, 0, trackBuffers_[i], ch, 0, numSamples);
        }

        masterPeakL = std::max(masterPeakL, tpL);
        masterPeakR = std::max(masterPeakR, tpR);
    }

    // ── Preview samplers (audition bus, also audible during playback) ────────
    // Piano-roll / MiniKeyboard auditioned notes render here into a dedicated
    // bus so they never compete with timeline playback voices on the same
    // region. Mixes directly into the master output, bypassing track routing.
    if (previewBuffer_.getNumSamples() < numSamples)
        previewBuffer_.setSize(2, numSamples, false, true, false);
    previewBuffer_.clear(0, numSamples);
    for (auto& kv : previewSamplers_)
    {
        Sampler* s = kv.second.get();
        if (s != nullptr && s->hasSample())
            s->processBlock(previewBuffer_, numSamples, sampleRate);
    }
    for (int ch = 0; ch < std::min(2, outputBuffer.getNumChannels()); ++ch)
        outputBuffer.addFrom(ch, 0, previewBuffer_, ch, 0, numSamples);

    // Master bus insert effect chain
    if (chainsLocked && masterEffectChain_ && masterEffectChain_->isInitialized())
        masterEffectChain_->processBlock(outputBuffer, numSamples, emptyMasterMidi_);

    // Master volume fader (post-effect-chain)
    const float masterVol = masterVolume_.load(std::memory_order_relaxed);
    if (masterVol != 1.0f)
        outputBuffer.applyGain(masterVol);

    // ── Clamp output to [-1, +1] (hard safety limit; replace with soft limiter in P3) ──
    for (int ch = 0; ch < outputBuffer.getNumChannels(); ++ch)
    {
        float* data = outputBuffer.getWritePointer(ch);
        for (int s = 0; s < numSamples; ++s)
        {
            if (data[s] > 1.0f)       data[s] = 1.0f;
            else if (data[s] < -1.0f) data[s] = -1.0f;
        }
    }

    // Recompute master peaks from clamped output
    masterPeakL = outputBuffer.getMagnitude(0, 0, numSamples);
    if (outputBuffer.getNumChannels() >= 2)
        masterPeakR = outputBuffer.getMagnitude(1, 0, numSamples);

    masterPeakL_.store(masterPeakL, std::memory_order_relaxed);
    masterPeakR_.store(masterPeakR, std::memory_order_relaxed);

    // Debug logging (throttled to ~1 Hz)
    maybeLogDebug(numSamples, sampleRate);
}

// ── Debug logging ────────────────────────────────────────────────────────────

void MixEngine::maybeLogDebug(int numSamples, double sampleRate)
{
    debugSampleRate_ = sampleRate;
    debugSampleCounter_ += numSamples;

    if (debugSampleCounter_ < static_cast<int64_t>(sampleRate))
        return; // less than 1 second since last log

    debugSampleCounter_ = 0;

    // Log active clip count
    {
        MixDebugEntry entry;
        entry.type = MixDebugEntry::ActiveClips;
        std::snprintf(entry.message, sizeof(entry.message),
                      "Active clips: %d", static_cast<int>(activeClips_.size()));
        debugLog_.push(entry);
    }

    // Log peak meters
    {
        MixDebugEntry entry;
        entry.type = MixDebugEntry::Peaks;
        std::snprintf(entry.message, sizeof(entry.message),
                      "Master peaks: L=%.4f R=%.4f",
                      masterPeakL_.load(std::memory_order_relaxed),
                      masterPeakR_.load(std::memory_order_relaxed));
        debugLog_.push(entry);
    }

    // Warn on unmapped regions
    if (timeline_ != nullptr)
    {
        for (const auto* clip : timeline_->getAllClips())
        {
            if (clip == nullptr) continue;
            if (regionToSampleMap_.find(clip->regionId) == regionToSampleMap_.end())
            {
                MixDebugEntry entry;
                entry.type = MixDebugEntry::UnmappedRegion;
                std::snprintf(entry.message, sizeof(entry.message),
                              "WARNING: region %d (clip %d) unmapped",
                              clip->regionId, clip->id);
                debugLog_.push(entry);
            }
        }
    }
}
