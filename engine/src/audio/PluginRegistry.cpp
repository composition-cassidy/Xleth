#include "audio/PluginRegistry.h"

#include <juce_core/juce_core.h>

#include <chrono>
#include <condition_variable>
#include <cstdio>

// ─── ScanCoordinator ─────────────────────────────────────────────────────────
// Coordinator side of the out-of-process IPC pair.
// Callbacks arrive on the coordinator's internal poll thread (NOT the JUCE
// message thread), so the condition_variable handshake is safe.

struct ScanCoordinator : public juce::ChildProcessCoordinator
{
    struct Result
    {
        bool             received      = false;
        bool             connectionLost = false;
        juce::MemoryBlock data;
    };

    std::mutex              mutex;
    std::condition_variable cv;
    Result                  pending;
    bool                    connected = true; // set false on handleConnectionLost

    void handleMessageFromWorker(const juce::MemoryBlock& mb) override
    {
        std::lock_guard<std::mutex> lock(mutex);
        pending = { true, false, mb };
        cv.notify_one();
    }

    void handleConnectionLost() override
    {
        std::lock_guard<std::mutex> lock(mutex);
        connected = false;
        pending = { false, true, {} };
        cv.notify_one();
    }

    bool isWorkerConnected() const
    {
        std::lock_guard<std::mutex> lock(const_cast<std::mutex&>(mutex));
        return connected;
    }

    // Sends a message and blocks for a response (or connection-lost) up to
    // timeoutMs milliseconds. Returns false on timeout or connection loss.
    bool sendAndWait(const juce::MemoryBlock& msg, juce::MemoryBlock& out, int timeoutMs)
    {
        // Reset pending state before sending — the response can't arrive before
        // the message is sent (pipe is FIFO), so this reset is race-free.
        {
            std::lock_guard<std::mutex> lock(mutex);
            pending = {};
        }

        if (!sendMessageToWorker(msg))
            return false;

        std::unique_lock<std::mutex> lock(mutex);
        const auto deadline = std::chrono::steady_clock::now()
                            + std::chrono::milliseconds(timeoutMs);
        const bool got = cv.wait_until(lock, deadline,
            [&] { return pending.received || pending.connectionLost; });

        if (got && pending.received)
        {
            out = pending.data;
            return true;
        }
        return false; // timeout or connection lost
    }
};

// ─── PluginRegistry ───────────────────────────────────────────────────────────

PluginRegistry::PluginRegistry()
{
    // Registers all built-in JUCE plugin formats, which includes
    // VST3PluginFormat when JUCE_PLUGINHOST_VST3=1 is defined.
    formatManager_.addDefaultFormats();
#ifdef XLETH_DEBUG
    std::fprintf(stderr, "[PluginHost] Format manager has %d format(s)\n",
                 (int)formatManager_.getNumFormats());
#endif
    // searchPaths_ starts empty — caller must supply paths via audio_scanPlugins().
}

PluginRegistry::~PluginRegistry()
{
    cancelScan();
    if (scanThread_ && scanThread_->joinable())
        scanThread_->join();
}

// ── Format manager ────────────────────────────────────────────────────────────

juce::AudioPluginFormatManager& PluginRegistry::getFormatManager()
{
    return formatManager_;
}

// ── Known plugins ─────────────────────────────────────────────────────────────

const juce::KnownPluginList& PluginRegistry::getKnownPlugins() const
{
    return knownPlugins_;
}

juce::KnownPluginList& PluginRegistry::getKnownPluginsMutable()
{
    return knownPlugins_;
}

juce::PluginDescription PluginRegistry::findPluginByIdentifier(
    const juce::String& identifierString) const
{
    // getTypes() returns Array<PluginDescription> by value in JUCE 8 — iterating
    // over it yields a temporary that is destroyed when this function returns.
    // Taking a pointer to an element of that temporary and returning it would be
    // a use-after-free on the caller side.  Returning a copy is always safe.
    for (const auto& desc : knownPlugins_.getTypes())
        if (desc.createIdentifierString() == identifierString)
            return desc;

    return {};
}

// ── Search paths ─────────────────────────────────────────────────────────────

void PluginRegistry::addSearchPath(const juce::String& path)
{
    if (!searchPaths_.contains(path))
        searchPaths_.add(path);
}

void PluginRegistry::clearSearchPaths()
{
    searchPaths_.clear();
}

juce::StringArray PluginRegistry::getSearchPaths() const
{
    return searchPaths_;
}

// ── Cache persistence ────────────────────────────────────────────────────────

void PluginRegistry::saveScanResults(const juce::File& cacheFile) const
{
    if (auto xml = knownPlugins_.createXml())
    {
        cacheFile.getParentDirectory().createDirectory();
        xml->writeTo(cacheFile);
    }
}

bool PluginRegistry::loadScanResults(const juce::File& cacheFile)
{
    if (!cacheFile.existsAsFile())
        return false;

    auto xml = juce::XmlDocument::parse(cacheFile);
    if (!xml)
        return false;

    knownPlugins_.recreateFromXml(*xml);
    return true;
}

// ── JSON export ───────────────────────────────────────────────────────────────

juce::String PluginRegistry::getPluginListAsJSON() const
{
#ifdef XLETH_DEBUG
    std::fprintf(stderr, "[PluginHost] getPluginListAsJSON: %d types in knownPlugins_\n",
                 knownPlugins_.getNumTypes());
#endif
    juce::String json = "[\n";
    bool first = true;

    for (const auto& desc : knownPlugins_.getTypes())
    {
        if (!first) json += ",\n";
        first = false;

        // Escape any double-quotes inside string fields.
        auto esc = [](const juce::String& s) -> juce::String {
            return s.replace("\\", "\\\\").replace("\"", "\\\"");
        };

        json += "  {";
        json += "\"id\":"         + juce::String("\"") + esc(desc.createIdentifierString()) + "\",";
        json += "\"name\":"       + juce::String("\"") + esc(desc.name)                     + "\",";
        json += "\"vendor\":"     + juce::String("\"") + esc(desc.manufacturerName)          + "\",";
        json += "\"category\":"   + juce::String("\"") + esc(desc.category)                  + "\",";
        json += "\"format\":"     + juce::String("\"") + esc(desc.pluginFormatName)           + "\",";
        json += "\"filePath\":"   + juce::String("\"") + esc(desc.fileOrIdentifier)           + "\",";
        json += "\"numInputs\":"  + juce::String(desc.numInputChannels)                       + ",";
        json += "\"numOutputs\":" + juce::String(desc.numOutputChannels)                      + ",";
        json += "\"hasEditor\":"  + juce::String(desc.hasSharedContainer ? "true" : (desc.isInstrument ? "true" : "true"));
        // hasEditor is not directly in PluginDescription — default true; the
        // scanner (VST-02) can refine this after instantiation.
        json += "}";
    }

    json += "\n]";
    return json;
}

// ── Scan progress ─────────────────────────────────────────────────────────────

bool PluginRegistry::isScanning()      const { return scanning_.load(); }
int  PluginRegistry::getScannedCount() const { return scannedCount_.load(); }
int  PluginRegistry::getTotalCount()   const { return totalCount_.load(); }

juce::StringArray PluginRegistry::getFailedPlugins() const
{
    std::lock_guard<std::mutex> lock(failedMutex_);
    return failedPlugins_;
}

// ── Scan orchestration ────────────────────────────────────────────────────────

void PluginRegistry::cancelScan()
{
    cancelFlag_.store(true);
}

void PluginRegistry::scanPlugins(const juce::File& scannerExe)
{
    // Prevent double-start.
    if (scanning_.load())
        return;

    // Cancel + join any previous scan thread.
    cancelFlag_.store(true);
    if (scanThread_ && scanThread_->joinable())
        scanThread_->join();

    cancelFlag_.store(false);

    // Guard: nothing to scan.
    if (searchPaths_.isEmpty())
    {
#ifdef XLETH_DEBUG
        std::fprintf(stderr, "[PluginHost] Scan skipped — no search paths provided\n");
#endif
        return;
    }

    scanning_.store(true);
    scannedCount_.store(0);
    totalCount_.store(0);
    {
        std::lock_guard<std::mutex> lock(failedMutex_);
        failedPlugins_.clear();
    }

    // Capture everything the thread needs by value.
    const juce::StringArray paths  = searchPaths_;
    const juce::File        exeFile = scannerExe;

    scanThread_ = std::make_unique<std::thread>([this, paths, exeFile]()
    {
        // ── 1. Enumerate .vst3 entries ────────────────────────────────────────
        juce::Array<juce::File> vst3Files;
        for (const auto& pathStr : paths)
        {
            juce::File dir(pathStr);
            if (dir.isDirectory())
                dir.findChildFiles(vst3Files,
                                   juce::File::findFilesAndDirectories,
                                   /*recursive=*/true,
                                   "*.vst3");
        }
        totalCount_.store(vst3Files.size());

        // Early exit — no files to scan. Set flag immediately; don't launch the coordinator.
        if (vst3Files.isEmpty())
        {
            scanning_.store(false);
            return;
        }

        // Truncate scanner log from any previous run so we see only this scan's output.
        exeFile.getSiblingFile("scanner-log.txt").deleteFile();

#ifdef XLETH_DEBUG
        std::fprintf(stderr, "[PluginHost] Scan started: %d paths, %d .vst3 files\n",
                     (int)paths.size(), (int)vst3Files.size());
#endif
        const auto scanStart = std::chrono::steady_clock::now();
        int succeededCount = 0;

        // ── 2. Local result accumulator (safe — only this thread writes) ──────
        juce::Array<juce::PluginDescription> discovered;

        // ── 3. Spawn coordinator and scan each file ───────────────────────────
        auto makeCoordinator = [&]() -> std::unique_ptr<ScanCoordinator>
        {
            auto c = std::make_unique<ScanCoordinator>();
            if (!c->launchWorkerProcess(exeFile, "XlethPluginScan", 0))
                return nullptr;
            return c;
        };

        std::unique_ptr<ScanCoordinator> coord = makeCoordinator();
#ifdef XLETH_DEBUG
        std::fprintf(stderr, "[PluginHost] Scanner coordinator launched. Scanning %d files.\n",
                     (int)vst3Files.size());
#endif

        for (int i = 0; i < vst3Files.size(); ++i)
        {
            if (cancelFlag_.load())
                break;

            const auto filePath = vst3Files[i].getFullPathName();
#ifdef XLETH_DEBUG
            std::fprintf(stderr, "[PluginHost] Sending to scanner: %s\n", filePath.toRawUTF8());
#endif

            // Restart coordinator if it crashed on the previous plugin.
            if (!coord || !coord->isWorkerConnected())
            {
                coord = makeCoordinator();
                if (!coord)
                    break; // scanner exe missing — bail
            }

            const juce::String msgStr = "SCAN:" + filePath;
            juce::MemoryBlock msgBlock(msgStr.toRawUTF8(),
                                       (size_t)msgStr.getNumBytesAsUTF8());
            juce::MemoryBlock response;

            const bool ok = coord->sendAndWait(msgBlock, response, /*timeoutMs=*/10000);

            if (!ok || !coord->isWorkerConnected())
            {
                // Timeout or process crash — distinguish for logging.
                const bool procCrashed = !coord->isWorkerConnected();
#ifdef XLETH_DEBUG
                std::fprintf(stderr, "[PluginHost] Scan failed: \"%s\" — %s\n",
                             filePath.toRawUTF8(),
                             procCrashed ? "process crashed" : "timeout");
#endif
                {
                    std::lock_guard<std::mutex> lock(failedMutex_);
                    failedPlugins_.add(filePath);
                }
                coord = nullptr; // force respawn next iteration
            }
            else
            {
                const auto respStr = response.toString();
#ifdef XLETH_DEBUG
                std::fprintf(stderr, "[PluginHost] Scanner response: %s\n", respStr.toRawUTF8());
#endif
                if (respStr.startsWith("OK:"))
                {
                    const auto xmlBlock = respStr.fromFirstOccurrenceOf("OK:", false, false);
                    juce::StringArray lines;
                    lines.addTokens(xmlBlock, "\n", "");
                    for (const auto& line : lines)
                    {
                        if (line.trim().isEmpty())
                            continue;
                        if (auto xml = juce::XmlDocument::parse(line))
                        {
                            juce::PluginDescription desc;
                            if (desc.loadFromXml(*xml))
                                discovered.add(desc);
                        }
                    }
                    ++succeededCount;
#ifdef XLETH_DEBUG
                    if (succeededCount % 10 == 0)
                        std::fprintf(stderr,
                                     "[PluginHost] Scan progress: %d / %d\n",
                                     i + 1, vst3Files.size());
#endif
                }
                else
                {
#ifdef XLETH_DEBUG
                    const auto reason = respStr.fromFirstOccurrenceOf("FAIL:", false, false);
                    std::fprintf(stderr, "[PluginHost] Scan failed: \"%s\" — %s\n",
                                 filePath.toRawUTF8(), reason.toRawUTF8());
#endif
                    {
                        std::lock_guard<std::mutex> lock(failedMutex_);
                        failedPlugins_.add(filePath);
                    }
                }
            }

            scannedCount_.store(i + 1);
        }

        coord = nullptr; // closes IPC channel, scanner process exits cleanly

#ifdef XLETH_DEBUG
        // Forward scanner log to host stderr so its output is visible in Electron.
        {
            const juce::String log = exeFile.getSiblingFile("scanner-log.txt")
                                             .loadFileAsString();
            if (log.isNotEmpty())
                std::fprintf(stderr, "=== Scanner log ===\n%s=== End scanner log ===\n",
                             log.toRawUTF8());
        }
#endif

        // ── 4. Merge results into knownPlugins_ BEFORE clearing scanning_ ────────
        // callAsync requires a live JUCE message loop, which Electron's native
        // addon process model does not guarantee — the lambda would sit in the
        // queue indefinitely while the JS side already sees scanning_==false and
        // calls getPluginListAsJSON, finding an empty list.
        //
        // Instead write directly on the scan thread. KnownPluginList::addType and
        // clear() are guarded by its own CriticalSection. scanning_ is a seq-cst
        // atomic, so any thread that observes scanning_==false via load() is
        // guaranteed to also observe all preceding stores (including the addType calls).
        //
        // Clear first so plugins from removed paths don't persist across scans.
        knownPlugins_.clear();
        for (const auto& desc : discovered)
            knownPlugins_.addType(desc);

#ifdef XLETH_DEBUG
        std::fprintf(stderr, "[PluginHost] knownPlugins_ populated: %d type(s)\n",
                     knownPlugins_.getNumTypes());
#endif

        const juce::File cacheFile =
            juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                .getChildFile("Xleth")
                .getChildFile("plugin-cache.xml");
        saveScanResults(cacheFile);

        // ── 5. Signal completion — after knownPlugins_ is fully written ────────
        // Any caller polling scanning_==false will now see a complete plugin list.
        scanning_.store(false);

#ifdef XLETH_DEBUG
        if (cancelFlag_.load())
            std::fprintf(stderr, "[PluginHost] Scan cancelled by user\n");
        {
            int failedCount = 0;
            {
                std::lock_guard<std::mutex> lock(failedMutex_);
                failedCount = failedPlugins_.size();
            }
            const double elapsed = std::chrono::duration<double>(
                std::chrono::steady_clock::now() - scanStart).count();
            std::fprintf(stderr,
                         "[PluginHost] Scan complete: %d succeeded, %d failed (%.1fs elapsed)\n",
                         succeededCount, failedCount, elapsed);
        }
#endif
    });
}
