#ifdef _WIN32
 #ifndef NOMINMAX
  #define NOMINMAX
 #endif
 #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
 #endif
 #include <windows.h>
#endif

#include "audio/PluginLoadBreadcrumb.h"

#include <cstdio>
#include <filesystem>
#include <system_error>

#ifdef _WIN32
 #include <process.h>
#else
 #include <signal.h>
 #include <unistd.h>
#endif

#define PHOST_LOG(...) do { std::fprintf(stderr, "[PluginHost] " __VA_ARGS__); std::fflush(stderr); } while (0)

namespace {

// temp + rename (MSVC std::filesystem::rename = MoveFileExW(REPLACE_EXISTING)):
// a reader (Electron main on worker exit) sees the old file or the new one,
// never a torn write. No FlushFileBuffers: a process crash does not lose data
// already handed to the OS, and the flush would cost milliseconds per load.
bool writeAtomically(const juce::File& target, const juce::String& content)
{
    if (!target.getParentDirectory().createDirectory())
        return false;
    const auto tmp = target.getSiblingFile(target.getFileName() + ".tmp");
    tmp.deleteFile();
    {
        juce::FileOutputStream os(tmp);
        if (!os.openedOk())
            return false;
        if (!os.writeText(content, false, false, nullptr))
            return false;
        os.flush();
        if (os.getStatus().failed())
            return false;
    }
    std::error_code ec;
    std::filesystem::rename(std::filesystem::path(tmp.getFullPathName().toWideCharPointer()),
                            std::filesystem::path(target.getFullPathName().toWideCharPointer()), ec);
    if (ec)
    {
        tmp.deleteFile();
        return false;
    }
    return true;
}

} // namespace

PluginLoadBreadcrumb::~PluginLoadBreadcrumb()
{
    finish();
}

juce::String PluginLoadBreadcrumb::uidHex(int uid)
{
    return juce::String::toHexString(uid).toLowerCase();
}

int PluginLoadBreadcrumb::currentPid()
{
#ifdef _WIN32
    return _getpid();
#else
    return (int)getpid();
#endif
}

bool PluginLoadBreadcrumb::isProcessAlive(int pid)
{
    if (pid <= 0)
        return false;
#ifdef _WIN32
    HANDLE h = ::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)pid);
    if (h == nullptr)
        return ::GetLastError() == ERROR_ACCESS_DENIED;  // exists, just not ours to query
    DWORD code = 0;
    const bool alive = ::GetExitCodeProcess(h, &code) && code == STILL_ACTIVE;
    ::CloseHandle(h);
    return alive;
#else
    return ::kill(pid, 0) == 0;
#endif
}

void PluginLoadBreadcrumb::begin(const juce::File& dataDir, const juce::PluginDescription& desc,
                                 const char* context)
{
    finish();   // a scope tracks one load at a time
    file_    = dataDir.getChildFile(kFileName);
    desc_    = desc;
    context_ = context;
    phase_   = "instantiate";
    active_  = true;
    write();
}

void PluginLoadBreadcrumb::setPhase(const char* phase)
{
    if (!active_)
        return;
    phase_ = phase;
    write();
}

void PluginLoadBreadcrumb::finish()
{
    if (!active_)
        return;
    active_ = false;
    if (!file_.deleteFile())
        PHOST_LOG("could not delete %s\n", file_.getFullPathName().toRawUTF8());
}

void PluginLoadBreadcrumb::write()
{
    auto* o = new juce::DynamicObject();
    o->setProperty("version",          1);
    o->setProperty("pid",              currentPid());
    o->setProperty("format",           desc_.pluginFormatName);
    o->setProperty("name",             desc_.name);
    o->setProperty("vendor",           desc_.manufacturerName);
    o->setProperty("fileOrIdentifier", desc_.fileOrIdentifier);
    o->setProperty("uniqueId",         uidHex(desc_.uniqueId));
    o->setProperty("deprecatedUid",    uidHex(desc_.deprecatedUid));
    o->setProperty("phase",            phase_);
    o->setProperty("context",          context_);
    o->setProperty("ts",               juce::Time::getCurrentTime().toISO8601(true));

    if (!writeAtomically(file_, juce::JSON::toString(juce::var(o))))
        PHOST_LOG("could not write load breadcrumb %s\n", file_.getFullPathName().toRawUTF8());
}

juce::var PluginLoadBreadcrumb::takeOrphan(const juce::File& dataDir)
{
    const auto file = dataDir.getChildFile(kFileName);
    if (!file.existsAsFile())
        return {};

    const auto parsed = juce::JSON::parse(file.loadFileAsString());
    if (!parsed.isObject() || parsed.getProperty("name", "").toString().isEmpty())
    {
        PHOST_LOG("unreadable load breadcrumb %s - deleted\n", file.getFullPathName().toRawUTF8());
        file.deleteFile();
        return {};
    }

    const int pid = (int)parsed.getProperty("pid", 0);
    if (pid != currentPid() && isProcessAlive(pid))
    {
        PHOST_LOG("load breadcrumb belongs to live pid %d (another engine mid-load) - left alone\n", pid);
        return {};
    }

    file.deleteFile();
    return parsed;
}
