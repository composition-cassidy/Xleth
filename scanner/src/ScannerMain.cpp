// xleth-plugin-scanner — out-of-process VST3 validator
//
// Protocol (MemoryBlock payloads, UTF-8):
//   Coordinator → Worker:  "SCAN:<absolute_path>"
//   Worker      → Coordinator:
//       "OK:<xml1>\n<xml2>\n..."   one PluginDescription XML per line, newline-separated
//       "FAIL:<reason>"            if no plugins found or load error
//
// The process intentionally has no crash recovery — if a plugin crashes during
// findAllTypesForFile(), the process dies, the coordinator detects the lost
// connection and marks the file as failed, then spawns a fresh scanner.

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

#include <cstdio>

// ─── Coordinator command-line ID — must match PluginRegistry ─────────────────
static const char* const kScannerUID = "XlethPluginScan";

// ─── File-based log ───────────────────────────────────────────────────────────
// Written next to the scanner exe so PluginRegistry can read it back and forward
// it to host stderr. Flushed after every write so output is visible even if the
// scanner crashes mid-scan.
static FILE* g_log = nullptr;

static void logOpen()
{
    const juce::File logFile =
        juce::File::getSpecialLocation(juce::File::currentExecutableFile)
            .getSiblingFile("scanner-log.txt");
    g_log = std::fopen(logFile.getFullPathName().toRawUTF8(), "w");
}

// SLOG: write a formatted line to the log file and flush immediately.
// Safe to call before logOpen (g_log guard).
#define SLOG(...) \
    do { if (g_log) { std::fprintf(g_log, __VA_ARGS__); std::fflush(g_log); } } while(0)

// ─── PluginScanner ────────────────────────────────────────────────────────────

class PluginScanner : public juce::ChildProcessWorker
{
public:
    PluginScanner()
    {
        // Register all default formats — includes VST3PluginFormat when
        // JUCE_PLUGINHOST_VST3=1 is defined.
        fmt_.addDefaultFormats();
        SLOG("[Scanner] Format manager initialised: %d format(s)\n",
             (int)fmt_.getNumFormats());
        for (auto* f : fmt_.getFormats())
            SLOG("[Scanner]   - %s\n", f->getName().toRawUTF8());
    }

    bool shouldQuit() const { return shouldQuit_.load(); }

    void handleConnectionLost() override
    {
        SLOG("[Scanner] Coordinator disconnected\n");
        shouldQuit_.store(true);
    }

    void handleMessageFromCoordinator(const juce::MemoryBlock& mb) override
    {
        const juce::String msg = mb.toString();
        SLOG("[Scanner] Received message: %s\n", msg.toRawUTF8());

        if (!msg.startsWith("SCAN:"))
        {
            const juce::String reply("FAIL:unrecognised_command");
            SLOG("[Scanner] Sending response: %s\n", reply.toRawUTF8());
            respond(reply);
            return;
        }

        const auto filePath = msg.fromFirstOccurrenceOf("SCAN:", false, false).trim();
        if (filePath.isEmpty())
        {
            const juce::String reply("FAIL:empty_path");
            SLOG("[Scanner] Sending response: %s\n", reply.toRawUTF8());
            respond(reply);
            return;
        }

        SLOG("[Scanner] Scanning: %s\n", filePath.toRawUTF8());

        // findAllTypesForFile loads the DLL. If it crashes, the process dies
        // and the coordinator detects the lost connection.
        juce::OwnedArray<juce::PluginDescription> found;
        for (auto* format : fmt_.getFormats())
        {
            const bool might = format->fileMightContainThisPluginType(filePath);
            SLOG("[Scanner] Format '%s': fileMightContainThisPluginType = %s\n",
                 format->getName().toRawUTF8(), might ? "true" : "false");
            if (might)
                format->findAllTypesForFile(found, filePath);
        }

        SLOG("[Scanner] Found %d plugin(s)\n", (int)found.size());
        for (const auto* d : found)
            SLOG("[Scanner]   - %s by %s\n",
                 d->name.toRawUTF8(), d->manufacturerName.toRawUTF8());

        if (found.isEmpty())
        {
            const juce::String reply("FAIL:no_plugins_in_file");
            SLOG("[Scanner] Sending response: %s\n", reply.toRawUTF8());
            respond(reply);
            return;
        }

        // Serialize all descriptions as newline-delimited XML.
        juce::String xmlList;
        for (const auto* desc : found)
        {
            if (auto xml = desc->createXml())
            {
                xmlList += xml->toString(juce::XmlElement::TextFormat().singleLine());
                xmlList += "\n";
            }
        }

        const juce::String reply("OK:" + xmlList);
        SLOG("[Scanner] Sending response: OK: (%d byte payload)\n",
             (int)(reply.getNumBytesAsUTF8()));
        respond(reply);
    }

private:
    std::atomic<bool> shouldQuit_ { false };
    juce::AudioPluginFormatManager fmt_;

    void respond(const juce::String& msg)
    {
        sendMessageToCoordinator(juce::MemoryBlock(msg.toRawUTF8(),
                                                    (size_t)msg.getNumBytesAsUTF8()));
    }
};

// ─── main ─────────────────────────────────────────────────────────────────────

int main(int argc, char* argv[])
{
    // ScopedJuceInitialiser_GUI initialises COM (needed by some VST3s) and
    // starts the JUCE message thread in the background, leaving main() free
    // to block in the message loop below.
    juce::ScopedJuceInitialiser_GUI juceInit;

    // ── Manual test mode ─────────────────────────────────────────────────────
    // If invoked with a single path argument (not the IPC UID), perform a
    // one-shot scan and print results directly to stderr.
    // Usage:  xleth-plugin-scanner.exe "C:\path\to\Plugin.vst3"
    // This lets you verify format registration outside the IPC context.
    if (argc == 2 && juce::File(argv[1]).exists())
    {
        const juce::String path(argv[1]);
        std::fprintf(stderr, "[Scanner] Manual test: %s\n", path.toRawUTF8());

        juce::AudioPluginFormatManager fmt;
        fmt.addDefaultFormats();
        std::fprintf(stderr, "[Scanner] Formats: %d\n", (int)fmt.getNumFormats());
        for (auto* f : fmt.getFormats())
            std::fprintf(stderr, "[Scanner]   - %s\n", f->getName().toRawUTF8());

        juce::OwnedArray<juce::PluginDescription> found;
        for (auto* f : fmt.getFormats())
        {
            const bool might = f->fileMightContainThisPluginType(path);
            std::fprintf(stderr, "[Scanner] Format '%s': fileMightContainThisPluginType = %s\n",
                         f->getName().toRawUTF8(), might ? "true" : "false");
            if (might)
                f->findAllTypesForFile(found, path);
        }

        std::fprintf(stderr, "[Scanner] Found %d plugin(s)\n", (int)found.size());
        for (const auto* d : found)
            std::fprintf(stderr, "[Scanner]   - %s by %s\n",
                         d->name.toRawUTF8(), d->manufacturerName.toRawUTF8());

        return found.isEmpty() ? 1 : 0;
    }

    // ── IPC mode ─────────────────────────────────────────────────────────────
    logOpen();
    SLOG("[Scanner] Process started (IPC mode)\n");
    SLOG("[Scanner] JUCE: %s\n", juce::SystemStats::getJUCEVersion().toRawUTF8());

    PluginScanner scanner;

    // JUCE 8's initialiseFromCommandLine expects only the parameters, not argv[0].
    if (argc <= 1)
    {
        SLOG("[Scanner] No arguments provided — exiting\n");
        std::fclose(g_log);
        return 1;
    }
    juce::StringArray argArray(argv + 1, argc - 1);
    const juce::String commandLine = argArray.joinIntoString(" ");
    SLOG("[Scanner] Command line: %s\n", commandLine.toRawUTF8());

    if (!scanner.initialiseFromCommandLine(commandLine, kScannerUID, 0))
    {
        SLOG("[Scanner] IPC init failed\n");
        std::fflush(g_log);
        std::fclose(g_log);
        return 1;
    }

    SLOG("[Scanner] IPC initialised, entering message loop\n");
    std::fflush(g_log);

    // Poll-based message loop. runDispatchLoop() alone returns immediately in
    // console worker contexts on Windows — use runDispatchLoopUntil in a polling
    // loop until the coordinator disconnects.
    while (!scanner.shouldQuit())
    {
        juce::MessageManager::getInstance()->runDispatchLoopUntil(100);
    }

    SLOG("[Scanner] Message loop exited cleanly\n");
    std::fflush(g_log);
    std::fclose(g_log);
    return 0;
}
