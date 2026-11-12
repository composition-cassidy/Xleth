// xleth-plugin-scanner — out-of-process plugin validator
//
// Protocol (MemoryBlock payloads, UTF-8):
//   Coordinator → Worker:  "SCAN:<formatName>|<absolute_path>"
//                          formatName is a JUCE AudioPluginFormat name ("VST3";
//                          later "VST", "CLAP").
//   Worker      → Coordinator:
//       "OK:<xml1>\n<xml2>\n..."   one PluginDescription XML per line
//       "FAIL:<reason>"            reason is one of:
//           unknown-format   no registered format has that name
//           no-types-found   the format found no plugin types in the file
//           exception        a C++ exception escaped the format code
//           bad-request      malformed message / empty path
//
// The process intentionally has no crash recovery — if a plugin crashes during
// findAllTypesForFile(), the process dies, the coordinator sees the lost
// connection and records the file as `crash` (and a hang as `timeout`) in
// %APPDATA%\Xleth\plugin-scan-failures.json, then spawns a fresh scanner.
//
// Log: scanner-log.txt next to this exe, opened in APPEND mode so a respawn
// after a crash keeps the crashed process's lines. The engine rotates it to
// scanner-log.prev.txt once at the start of each scan. Prefix: [PluginScanner].

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <exception>

#ifdef _WIN32
 #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
 #endif
 #ifndef NOMINMAX
  #define NOMINMAX
 #endif
 #include <windows.h>
#endif

// ─── Coordinator command-line ID — must match PluginRegistry ─────────────────
static const char* const kScannerUID = "XlethPluginScan";

// ─── File-based log ───────────────────────────────────────────────────────────
// Flushed after every write so output survives a crash mid-scan.
static FILE* g_log = nullptr;

static void logOpen()
{
    const juce::File logFile =
        juce::File::getSpecialLocation(juce::File::currentExecutableFile)
            .getSiblingFile("scanner-log.txt");
    if (_wfopen_s(&g_log, logFile.getFullPathName().toWideCharPointer(), L"a") != 0)
        g_log = nullptr;
}

static unsigned long currentPid()
{
#ifdef _WIN32
    return (unsigned long)::GetCurrentProcessId();
#else
    return 0;
#endif
}

// SLOG: write a prefixed, formatted line to the log file and flush immediately.
// Safe to call before logOpen (g_log guard).
static void SLOG(const char* fmt, ...)
{
    if (!g_log)
        return;
    std::fprintf(g_log, "[PluginScanner] [pid %lu] ", currentPid());
    va_list args;
    va_start(args, fmt);
    std::vfprintf(g_log, fmt, args);
    va_end(args);
    std::fflush(g_log);
}

// The file currently inside a format call — named in the fatal-fault log line.
static juce::String g_currentFile;

[[noreturn]] static void hardExit(int code)
{
    if (g_log) std::fflush(g_log);
#ifdef _WIN32
    // TerminateProcess: no static destructors, no thread joins. A hung plugin
    // thread can otherwise keep the process alive forever on the way out.
    ::TerminateProcess(::GetCurrentProcess(), (UINT)code);
#endif
    std::_Exit(code);
}

#ifdef _WIN32
// Turn a plugin fault into an immediate, logged process death. Without this,
// Windows Error Reporting may hold the faulting process open behind a dialog,
// which the coordinator would misreport as a timeout.
static LONG WINAPI onUnhandledException(EXCEPTION_POINTERS* info)
{
    const auto code = info && info->ExceptionRecord ? info->ExceptionRecord->ExceptionCode : 0u;
    SLOG("FATAL: unhandled exception 0x%08lX while scanning \"%s\" — exiting\n",
         (unsigned long)code, g_currentFile.toRawUTF8());
    hardExit(3);
}
#endif

// ─── PluginScanner ────────────────────────────────────────────────────────────

class PluginScanner : public juce::ChildProcessWorker
{
public:
    PluginScanner()
    {
        // Registers the formats enabled by JUCE_PLUGINHOST_* (VST3 today).
        fmt_.addDefaultFormats();
        SLOG("Format manager initialised: %d format(s)\n", (int)fmt_.getNumFormats());
        for (auto* f : fmt_.getFormats())
            SLOG("  - %s\n", f->getName().toRawUTF8());
    }

    bool shouldQuit() const { return shouldQuit_.load(); }

    void handleConnectionLost() override
    {
        // Normally: the coordinator finished or gave up on a hung plugin and
        // closed the pipe. If a plugin call is still stuck on the IPC thread,
        // a normal return from main() would block joining it — exit hard.
        SLOG("Coordinator disconnected — exiting\n");
        shouldQuit_.store(true);
        hardExit(0);
    }

    // Called on the IPC connection thread.
    void handleMessageFromCoordinator(const juce::MemoryBlock& mb) override
    {
        const juce::String msg = mb.toString();
        SLOG("Received: %s\n", msg.toRawUTF8());

        if (!msg.startsWith("SCAN:"))
            return respond("FAIL:bad-request");

        const auto body       = msg.fromFirstOccurrenceOf("SCAN:", false, false);
        const auto formatName = body.upToFirstOccurrenceOf("|", false, false).trim();
        const auto filePath   = body.fromFirstOccurrenceOf("|", false, false).trim();
        if (!body.containsChar('|') || formatName.isEmpty() || filePath.isEmpty())
            return respond("FAIL:bad-request");

        juce::AudioPluginFormat* format = nullptr;
        for (auto* f : fmt_.getFormats())
            if (f->getName() == formatName)
                format = f;

        if (format == nullptr)
        {
            SLOG("Unknown format '%s'\n", formatName.toRawUTF8());
            return respond("FAIL:unknown-format");
        }

        SLOG("Scanning [%s] %s\n", formatName.toRawUTF8(), filePath.toRawUTF8());

        // findAllTypesForFile loads the DLL. A crash kills this process (the
        // coordinator records `crash`); a C++ exception is reported here.
        juce::OwnedArray<juce::PluginDescription> found;
        g_currentFile = filePath;
        try
        {
            if (format->fileMightContainThisPluginType(filePath))
                format->findAllTypesForFile(found, filePath);
        }
        catch (const std::exception& e)
        {
            g_currentFile.clear();
            SLOG("C++ exception: %s\n", e.what());
            return respond("FAIL:exception");
        }
        catch (...)
        {
            g_currentFile.clear();
            SLOG("Unknown C++ exception\n");
            return respond("FAIL:exception");
        }
        g_currentFile.clear();

        SLOG("Found %d plugin(s)\n", (int)found.size());
        for (const auto* d : found)
            SLOG("  - %s by %s (%d in / %d out) %s\n",
                 d->name.toRawUTF8(), d->manufacturerName.toRawUTF8(),
                 d->numInputChannels, d->numOutputChannels,
                 d->fileOrIdentifier.toRawUTF8());

        if (found.isEmpty())
            return respond("FAIL:no-types-found");

        // Serialize all descriptions as newline-delimited single-line XML.
        juce::String xmlList;
        for (const auto* desc : found)
        {
            if (auto xml = desc->createXml())
            {
                xmlList += xml->toString(juce::XmlElement::TextFormat().singleLine());
                xmlList += "\n";
            }
        }
        respond("OK:" + xmlList);
    }

private:
    std::atomic<bool> shouldQuit_ { false };
    juce::AudioPluginFormatManager fmt_;

    void respond(const juce::String& msg)
    {
        if (msg.startsWith("OK:"))
            SLOG("Reply: OK (%d byte payload)\n", (int)msg.getNumBytesAsUTF8());
        else
            SLOG("Reply: %s\n", msg.toRawUTF8());
        sendMessageToCoordinator(juce::MemoryBlock(msg.toRawUTF8(),
                                                   (size_t)msg.getNumBytesAsUTF8()));
    }
};

// ─── main ─────────────────────────────────────────────────────────────────────

int main(int argc, char* argv[])
{
#ifdef _WIN32
    // No WER / critical-error dialogs: a crashing plugin must kill this process
    // immediately so the coordinator can record it as `crash`.
    ::SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    ::SetUnhandledExceptionFilter(onUnhandledException);
#endif

    // ScopedJuceInitialiser_GUI initialises COM (needed by some VST3s) and
    // the JUCE message manager on this thread.
    juce::ScopedJuceInitialiser_GUI juceInit;

    // ── Manual test mode ─────────────────────────────────────────────────────
    // Usage:  xleth-plugin-scanner.exe "C:\path\to\Plugin.vst3"
    // One-shot scan with every registered format, results to stderr.
    if (argc == 2 && juce::File(argv[1]).exists())
    {
        const juce::String path(argv[1]);
        std::fprintf(stderr, "[PluginScanner] Manual test: %s\n", path.toRawUTF8());

        juce::AudioPluginFormatManager fmt;
        fmt.addDefaultFormats();
        juce::OwnedArray<juce::PluginDescription> found;
        for (auto* f : fmt.getFormats())
        {
            const bool might = f->fileMightContainThisPluginType(path);
            std::fprintf(stderr, "[PluginScanner] Format '%s': fileMightContainThisPluginType = %s\n",
                         f->getName().toRawUTF8(), might ? "true" : "false");
            if (might)
                f->findAllTypesForFile(found, path);
        }

        std::fprintf(stderr, "[PluginScanner] Found %d plugin(s)\n", (int)found.size());
        for (const auto* d : found)
            std::fprintf(stderr, "[PluginScanner]   - %s by %s (%d in / %d out) %s\n",
                         d->name.toRawUTF8(), d->manufacturerName.toRawUTF8(),
                         d->numInputChannels, d->numOutputChannels,
                         d->fileOrIdentifier.toRawUTF8());

        return found.isEmpty() ? 1 : 0;
    }

    // ── IPC mode ─────────────────────────────────────────────────────────────
    logOpen();
    SLOG("Process started (IPC mode), JUCE %s\n", juce::SystemStats::getJUCEVersion().toRawUTF8());

    PluginScanner scanner;

    // JUCE 8's initialiseFromCommandLine expects only the parameters, not argv[0].
    if (argc <= 1)
    {
        SLOG("No arguments provided — exiting\n");
        if (g_log) std::fclose(g_log);
        return 1;
    }
    juce::StringArray argArray(argv + 1, argc - 1);
    const juce::String commandLine = argArray.joinIntoString(" ");

    if (!scanner.initialiseFromCommandLine(commandLine, kScannerUID, 0))
    {
        SLOG("IPC init failed (command line: %s)\n", commandLine.toRawUTF8());
        if (g_log) std::fclose(g_log);
        return 1;
    }

    SLOG("IPC initialised, entering message loop\n");

    // Poll-based message loop. runDispatchLoop() alone returns immediately in
    // console worker contexts on Windows — poll until the coordinator goes away.
    while (!scanner.shouldQuit())
        juce::MessageManager::getInstance()->runDispatchLoopUntil(100);

    SLOG("Message loop exited\n");
    if (g_log) std::fclose(g_log);
    return 0;
}
