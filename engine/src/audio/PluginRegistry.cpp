#include "audio/PluginRegistry.h"
#include "audio/PluginBinaryInspector.h"
#include "audio/PluginLoadBreadcrumb.h"

#include <juce_core/juce_core.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <filesystem>
#include <set>
#include <system_error>

// Log prefixes (docs/PLUGIN_HOSTING_LOG.md):
//   [PluginScan]  coordinator + scan loop (scan thread)
//   [PluginReg]   registry, cache, settings, failure list, dedupe
//   [PluginPreflight]  PE preflight in the scan loop (P2)
//   [PluginHost]  load-crash recovery + quarantine (P2)
// Never called on the audio thread.
#define PSCAN_LOG(...) do { std::fprintf(stderr, "[PluginScan] " __VA_ARGS__); std::fflush(stderr); } while (0)
#define PREG_LOG(...)  do { std::fprintf(stderr, "[PluginReg] "  __VA_ARGS__); std::fflush(stderr); } while (0)
#define PFLIGHT_LOG(...) do { std::fprintf(stderr, "[PluginPreflight] " __VA_ARGS__); std::fflush(stderr); } while (0)
#define PHOST_LOG(...)   do { std::fprintf(stderr, "[PluginHost] " __VA_ARGS__); std::fflush(stderr); } while (0)

namespace {

constexpr int kScanTimeoutMs        = 10000;
// JUCE IPC timeout for the coordinator side. JUCE's default (8000 ms) is both
// how long it takes to notice a dead scanner and how long tearing the pipe down
// blocks — measured 8 s + 8 s per crashed plugin. The scanner's ping thread keeps
// pinging while a plugin loads, so a short value does not misread a slow load.
constexpr int kCoordinatorIpcTimeoutMs = 2000;
constexpr int kSettingsSchema       = 1;
constexpr int kFailuresSchema       = 1;
const char* const kScannerUID       = "XlethPluginScan";   // must match ScannerMain.cpp

juce::File defaultDataDir()
{
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
               .getChildFile("Xleth");
}

// Lower-cased full path, used for case-insensitive (Windows) path identity.
juce::String pathKey(const juce::String& p)
{
    return juce::File::createFileWithoutCheckingPath(p).getFullPathName().toLowerCase();
}

// True when `entryPath` IS `itemPath` or lives inside it (bundle dir → inner binary).
bool ownsPath(const juce::String& itemKey, const juce::String& entryKey)
{
    if (entryKey == itemKey)
        return true;
    return entryKey.startsWith(itemKey + juce::File::getSeparatorString());
}

juce::String failureKey(const juce::String& format, const juce::String& path)
{
    return format + "|" + pathKey(path);
}

} // namespace

// ─── ScanCoordinator ─────────────────────────────────────────────────────────
// Coordinator side of the out-of-process IPC pair.
// Callbacks arrive on the coordinator's internal IPC thread (NOT the JUCE
// message thread), so the condition_variable handshake is safe.

struct ScanCoordinator : public juce::ChildProcessCoordinator
{
    struct Result
    {
        bool              received       = false;
        bool              connectionLost = false;
        juce::MemoryBlock data;
    };

    std::mutex              mutex;
    std::condition_variable cv;
    Result                  pending;
    bool                    connected = true; // set false on handleConnectionLost

    // JUCE: subclasses must kill the worker in their own destructor so a late
    // handleConnectionLost never hits a half-destroyed object.
    ~ScanCoordinator() override { killWorkerProcess(); }

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

    bool isWorkerConnected()
    {
        std::lock_guard<std::mutex> lock(mutex);
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

// ─── PluginRegistry: construction ─────────────────────────────────────────────

PluginRegistry::PluginRegistry()
{
    initialise(defaultDataDir());
}

PluginRegistry::PluginRegistry(const juce::File& dataDir)
{
    initialise(dataDir);
}

void PluginRegistry::initialise(const juce::File& dataDir)
{
    dataDir_ = dataDir;
    // Registers the built-in formats enabled by the JUCE_PLUGINHOST_* defines
    // (VST3 only today).
    formatManager_.addDefaultFormats();
    knownPlugins_ = std::make_shared<juce::KnownPluginList>();
    loadSettings();
    loadFailures();
    loadQuarantine();
    recoverLoadCrash();
    PREG_LOG("%d format(s) registered; data dir %s\n",
             (int)formatManager_.getNumFormats(), dataDir_.getFullPathName().toRawUTF8());
}

PluginRegistry::~PluginRegistry()
{
    cancelScan();
    if (scanThread_ && scanThread_->joinable())
        scanThread_->join();
}

juce::AudioPluginFormatManager& PluginRegistry::getFormatManager()
{
    return formatManager_;
}

juce::File PluginRegistry::cacheFile() const
{
    return dataDir_.getChildFile("plugin-cache.xml");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

juce::String PluginRegistry::escapeJsonString(const juce::String& s)
{
    juce::String out;
    out.preallocateBytes((size_t)s.getNumBytesAsUTF8() + 8);
    for (auto p = s.getCharPointer(); !p.isEmpty();)
    {
        const juce::juce_wchar c = p.getAndAdvance();
        switch (c)
        {
            case '"':  out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\b': out << "\\b";  break;
            case '\f': out << "\\f";  break;
            case '\n': out << "\\n";  break;
            case '\r': out << "\\r";  break;
            case '\t': out << "\\t";  break;
            default:
                if (c < 0x20)
                    out << "\\u" << juce::String::toHexString((int)c).paddedLeft('0', 4);
                else
                    out << juce::String::charToString(c);
        }
    }
    return out;
}

juce::int64 PluginRegistry::computeFileTime(const juce::File& item)
{
    juce::int64 t = item.getLastModificationTime().toMilliseconds();
    if (!item.isDirectory())
        return t;

    // Bundle: also the binaries in Contents\<arch>-win\ (the "inner binary").
    const auto contents = item.getChildFile("Contents");
    if (contents.isDirectory())
    {
        for (const auto& archDir : contents.findChildFiles(juce::File::findDirectories, false, "*-win"))
            for (const auto& bin : archDir.findChildFiles(juce::File::findFiles, false))
                t = std::max(t, bin.getLastModificationTime().toMilliseconds());
    }
    return t;
}

juce::String PluginRegistry::nowIso()
{
    return juce::Time::getCurrentTime().toISO8601(true);
}

bool PluginRegistry::atomicWrite(const juce::File& target, const juce::String& content)
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

    // MSVC's std::filesystem::rename = MoveFileExW(MOVEFILE_REPLACE_EXISTING):
    // readers see either the old file or the new one, never a torn write.
    std::error_code ec;
    std::filesystem::rename(std::filesystem::path(tmp.getFullPathName().toWideCharPointer()),
                            std::filesystem::path(target.getFullPathName().toWideCharPointer()),
                            ec);
    if (ec)
    {
        PREG_LOG("atomic rename failed for %s: %s\n",
                 target.getFullPathName().toRawUTF8(), ec.message().c_str());
        tmp.deleteFile();
        return false;
    }
    return true;
}

// ── Known plugins ─────────────────────────────────────────────────────────────

std::shared_ptr<const juce::KnownPluginList> PluginRegistry::getKnownPluginsSnapshot() const
{
    std::lock_guard<std::mutex> lock(listMutex_);
    return knownPlugins_;
}

void PluginRegistry::publish(std::shared_ptr<const juce::KnownPluginList> list)
{
    std::lock_guard<std::mutex> lock(listMutex_);
    knownPlugins_ = std::move(list);
}

juce::PluginDescription PluginRegistry::findPluginByIdentifier(
    const juce::String& identifierString) const
{
    const auto snapshot = getKnownPluginsSnapshot();
    const auto types    = snapshot->getTypes();

    for (const auto& desc : types)
        if (desc.createIdentifierString() == identifierString)
            return desc;

    // ── Legacy fallback: "<format>-<name>-<hex pathhash>-<hex uid>" ──────────
    // The id embeds a hash of fileOrIdentifier, so it changes when the surviving
    // path changes (bundle dir vs inner binary). Match on format + uid instead.
    // JUCE writes uniqueId when non-zero, else deprecatedUid — accept either.
    const int uidDash = identifierString.lastIndexOfChar('-');
    if (uidDash <= 0)
        return {};
    const auto uidHex = identifierString.substring(uidDash + 1);
    const auto head1  = identifierString.substring(0, uidDash);
    const int hashDash = head1.lastIndexOfChar('-');
    if (hashDash <= 0)
        return {};
    const auto hashHex = head1.substring(hashDash + 1);
    const auto head2   = head1.substring(0, hashDash);
    const int fmtDash  = head2.indexOfChar('-');
    if (fmtDash <= 0)
        return {};
    const auto format = head2.substring(0, fmtDash);
    const auto name   = head2.substring(fmtDash + 1);

    const juce::String hexChars("0123456789abcdefABCDEF");
    if (uidHex.isEmpty() || hashHex.isEmpty()
        || !uidHex.containsOnly(hexChars) || !hashHex.containsOnly(hexChars))
        return {};

    const int uid = uidHex.getHexValue32();
    if (uid == 0)
        return {};

    const juce::PluginDescription* best = nullptr;
    int matches = 0;
    for (const auto& desc : types)
    {
        if (desc.pluginFormatName != format)
            continue;
        if (desc.uniqueId != uid && desc.deprecatedUid != uid)
            continue;
        ++matches;
        if (best == nullptr || (best->name != name && desc.name == name))
            best = &desc;
    }

    if (best == nullptr)
        return {};

    PREG_LOG("legacy id \"%s\" resolved by format+uid to \"%s\"%s\n",
             identifierString.toRawUTF8(), best->createIdentifierString().toRawUTF8(),
             matches > 1 ? " (ambiguous: name tie-break)" : "");
    return *best;
}

// ── Search paths ─────────────────────────────────────────────────────────────

void PluginRegistry::loadSettings()
{
    const auto file = dataDir_.getChildFile("plugin-settings.json");
    std::lock_guard<std::mutex> lock(settingsMutex_);
    settings_.clear();
    if (!file.existsAsFile())
        return;

    const auto root = juce::JSON::parse(file.loadFileAsString());
    if (!root.isObject())
    {
        PREG_LOG("plugin-settings.json is not valid JSON — using defaults\n");
        return;
    }
    const int version = (int)root.getProperty("version", 0);
    if (version != kSettingsSchema)
        PREG_LOG("plugin-settings.json version %d (expected %d) — reading best-effort\n",
                 version, kSettingsSchema);

    const auto sp = root.getProperty("searchPaths", {});
    if (auto* obj = sp.getDynamicObject())
    {
        for (const auto& prop : obj->getProperties())
        {
            FormatPaths fp;
            const auto& fv = prop.value;
            fp.useDefaults = (bool)fv.getProperty("useDefaults", true);
            if (auto* arr = fv.getProperty("user", {}).getArray())
                for (const auto& u : *arr)
                    if (u.isString() && u.toString().isNotEmpty())
                        fp.user.addIfNotAlreadyThere(u.toString());
            settings_[prop.name.toString()] = fp;
        }
    }
}

bool PluginRegistry::saveSettingsLocked() const
{
    auto* searchPaths = new juce::DynamicObject();
    for (const auto& [fmt, fp] : settings_)
    {
        auto* f = new juce::DynamicObject();
        juce::Array<juce::var> user;
        for (const auto& u : fp.user)
            user.add(u);
        f->setProperty("user", user);
        f->setProperty("useDefaults", fp.useDefaults);
        searchPaths->setProperty(fmt, juce::var(f));
    }
    auto* root = new juce::DynamicObject();
    root->setProperty("version", kSettingsSchema);
    root->setProperty("searchPaths", juce::var(searchPaths));
    return atomicWrite(dataDir_.getChildFile("plugin-settings.json"),
                       juce::JSON::toString(juce::var(root)));
}

juce::StringArray PluginRegistry::getFormatNames() const
{
    juce::StringArray names;
    for (auto* f : formatManager_.getFormats())
        names.add(f->getName());
    return names;
}

juce::StringArray PluginRegistry::getDefaultSearchPaths(const juce::String& formatName) const
{
    juce::StringArray out;
    for (auto* f : formatManager_.getFormats())
    {
        if (f->getName() != formatName)
            continue;
        const auto sp = f->getDefaultLocationsToSearch();
        for (int i = 0; i < sp.getNumPaths(); ++i)
            out.add(sp[i].getFullPathName());
    }
    return out;
}

PluginRegistry::FormatPaths PluginRegistry::getSearchPaths(const juce::String& formatName) const
{
    std::lock_guard<std::mutex> lock(settingsMutex_);
    const auto it = settings_.find(formatName);
    return it != settings_.end() ? it->second : FormatPaths{};
}

juce::String PluginRegistry::setSearchPaths(const juce::String& formatName,
                                            const juce::StringArray& user, bool useDefaults)
{
    if (!getFormatNames().contains(formatName))
        return "unknown-format";

    // settingsMutex_ also serialises against scanPlugins(), which sets scanning_
    // and snapshots the settings under the same lock.
    std::lock_guard<std::mutex> lock(settingsMutex_);
    if (scanning_.load())
        return "scan-in-progress";

    FormatPaths fp;
    fp.useDefaults = useDefaults;
    for (const auto& u : user)
        if (u.trim().isNotEmpty())
            fp.user.addIfNotAlreadyThere(u.trim());

    const auto previous = settings_;
    settings_[formatName] = fp;
    if (!saveSettingsLocked())
    {
        settings_ = previous;
        PREG_LOG("plugin-settings.json write failed\n");
        return "write-failed";
    }
    PREG_LOG("search paths for %s: %d user folder(s), useDefaults=%s\n",
             formatName.toRawUTF8(), fp.user.size(), useDefaults ? "true" : "false");
    return {};
}

// ── Failure list ─────────────────────────────────────────────────────────────

void PluginRegistry::loadFailures()
{
    const auto file = dataDir_.getChildFile("plugin-scan-failures.json");
    std::lock_guard<std::mutex> lock(failuresMutex_);
    failures_.clear();
    if (!file.existsAsFile())
        return;

    const auto root = juce::JSON::parse(file.loadFileAsString());
    if (!root.isObject())
    {
        PREG_LOG("plugin-scan-failures.json is not valid JSON — starting empty\n");
        return;
    }
    if ((int)root.getProperty("version", 0) != kFailuresSchema)
        PREG_LOG("plugin-scan-failures.json version mismatch — reading best-effort\n");

    if (auto* arr = root.getProperty("entries", {}).getArray())
    {
        for (const auto& e : *arr)
        {
            FailureEntry f;
            f.format      = e.getProperty("format", "").toString();
            f.path        = e.getProperty("path", "").toString();
            f.reason      = e.getProperty("reason", "").toString();
            f.fileTime    = (juce::int64)e.getProperty("fileTime", 0);
            f.firstSeen   = e.getProperty("firstSeen", "").toString();
            f.lastAttempt = e.getProperty("lastAttempt", "").toString();
            f.attempts    = (int)e.getProperty("attempts", 1);
            if (f.format.isNotEmpty() && f.path.isNotEmpty())
                failures_.push_back(f);
        }
    }
    PREG_LOG("loaded %d persisted scan failure(s)\n", (int)failures_.size());
}

bool PluginRegistry::saveFailuresLocked() const
{
    juce::Array<juce::var> entries;
    for (const auto& f : failures_)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty("format",      f.format);
        o->setProperty("path",        f.path);
        o->setProperty("reason",      f.reason);
        o->setProperty("fileTime",    f.fileTime);
        o->setProperty("firstSeen",   f.firstSeen);
        o->setProperty("lastAttempt", f.lastAttempt);
        o->setProperty("attempts",    f.attempts);
        entries.add(juce::var(o));
    }
    auto* root = new juce::DynamicObject();
    root->setProperty("version", kFailuresSchema);
    root->setProperty("entries", entries);
    return atomicWrite(dataDir_.getChildFile("plugin-scan-failures.json"),
                       juce::JSON::toString(juce::var(root)));
}

std::vector<PluginRegistry::FailureEntry> PluginRegistry::getFailures() const
{
    std::lock_guard<std::mutex> lock(failuresMutex_);
    return failures_;
}

juce::String PluginRegistry::getFailuresAsJSON() const
{
    const auto list = getFailures();
    juce::String json = "[";
    bool first = true;
    for (const auto& f : list)
    {
        if (!first) json << ",";
        first = false;
        json << "{\"filePath\":\""   << escapeJsonString(f.path)        << "\""
             << ",\"path\":\""       << escapeJsonString(f.path)        << "\""
             << ",\"format\":\""     << escapeJsonString(f.format)      << "\""
             << ",\"reason\":\""     << escapeJsonString(f.reason)      << "\""
             << ",\"fileTime\":"     << juce::String(f.fileTime)
             << ",\"firstSeen\":\""  << escapeJsonString(f.firstSeen)   << "\""
             << ",\"lastAttempt\":\""<< escapeJsonString(f.lastAttempt) << "\""
             << ",\"attempts\":"     << juce::String(f.attempts)
             << "}";
    }
    json << "]";
    return json;
}

// ── Load-crash quarantine (P2) ───────────────────────────────────────────────

namespace {

constexpr int kQuarantineSchema = 1;

juce::String quarantineKey(const juce::String& format, const juce::String& uid,
                           const juce::String& depUid)
{
    return format + "|" + PluginRegistry::normaliseUidHex(uid) + "|"
         + PluginRegistry::normaliseUidHex(depUid);
}

} // namespace

juce::String PluginRegistry::normaliseUidHex(const juce::String& s)
{
    auto t = s.trim().toLowerCase();
    if (t.startsWith("0x"))
        t = t.substring(2);
    return t;
}

void PluginRegistry::loadQuarantine()
{
    const auto file = dataDir_.getChildFile("plugin-quarantine.json");
    std::lock_guard<std::mutex> lock(quarantineMutex_);
    quarantine_.clear();
    if (!file.existsAsFile())
        return;

    const auto root = juce::JSON::parse(file.loadFileAsString());
    if (!root.isObject())
    {
        PHOST_LOG("plugin-quarantine.json is not valid JSON - starting empty\n");
        return;
    }
    if (auto* arr = root.getProperty("entries", {}).getArray())
    {
        for (const auto& e : *arr)
        {
            QuarantineEntry q;
            q.format           = e.getProperty("format", "").toString();
            q.uniqueId         = normaliseUidHex(e.getProperty("uniqueId", "").toString());
            q.deprecatedUid    = normaliseUidHex(e.getProperty("deprecatedUid", "").toString());
            q.name             = e.getProperty("name", "").toString();
            q.vendor           = e.getProperty("vendor", "").toString();
            q.fileOrIdentifier = e.getProperty("fileOrIdentifier", "").toString();
            q.phase            = e.getProperty("phase", "").toString();
            q.context          = e.getProperty("context", "").toString();
            q.crashedAt        = e.getProperty("crashedAt", "").toString();
            q.crashes          = (int)e.getProperty("crashes", 1);
            if (q.format.isNotEmpty())
                quarantine_.push_back(q);
        }
    }
    if (!quarantine_.empty())
        PHOST_LOG("%d plugin(s) quarantined (crashed the engine while loading)\n",
                  (int)quarantine_.size());
}

bool PluginRegistry::saveQuarantineLocked() const
{
    juce::Array<juce::var> entries;
    for (const auto& q : quarantine_)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty("format",           q.format);
        o->setProperty("uniqueId",         q.uniqueId);
        o->setProperty("deprecatedUid",    q.deprecatedUid);
        o->setProperty("name",             q.name);
        o->setProperty("vendor",           q.vendor);
        o->setProperty("fileOrIdentifier", q.fileOrIdentifier);
        o->setProperty("phase",            q.phase);
        o->setProperty("context",          q.context);
        o->setProperty("crashedAt",        q.crashedAt);
        o->setProperty("crashes",          q.crashes);
        entries.add(juce::var(o));
    }
    auto* root = new juce::DynamicObject();
    root->setProperty("version", kQuarantineSchema);
    root->setProperty("entries", entries);
    return atomicWrite(dataDir_.getChildFile("plugin-quarantine.json"),
                       juce::JSON::toString(juce::var(root)));
}

void PluginRegistry::recoverLoadCrash()
{
    const auto crumb = PluginLoadBreadcrumb::takeOrphan(dataDir_);
    if (!crumb.isObject())
        return;

    QuarantineEntry q;
    q.format           = crumb.getProperty("format", "").toString();
    q.uniqueId         = normaliseUidHex(crumb.getProperty("uniqueId", "").toString());
    q.deprecatedUid    = normaliseUidHex(crumb.getProperty("deprecatedUid", "").toString());
    q.name             = crumb.getProperty("name", "").toString();
    q.vendor           = crumb.getProperty("vendor", "").toString();
    q.fileOrIdentifier = crumb.getProperty("fileOrIdentifier", "").toString();
    q.phase            = crumb.getProperty("phase", "").toString();
    q.context          = crumb.getProperty("context", "").toString();
    q.crashedAt        = crumb.getProperty("ts", "").toString();

    PHOST_LOG("previous engine (pid %d) died while loading %s \"%s\" by %s (phase %s, context %s) - quarantined\n",
              (int)crumb.getProperty("pid", 0), q.format.toRawUTF8(), q.name.toRawUTF8(),
              q.vendor.toRawUTF8(), q.phase.toRawUTF8(), q.context.toRawUTF8());

    {
        std::lock_guard<std::mutex> lock(quarantineMutex_);
        const auto key = quarantineKey(q.format, q.uniqueId, q.deprecatedUid);
        bool merged = false;
        for (auto& e : quarantine_)
        {
            if (quarantineKey(e.format, e.uniqueId, e.deprecatedUid) == key)
            {
                e.crashes  += 1;
                e.phase     = q.phase;
                e.context   = q.context;
                e.crashedAt = q.crashedAt;
                e.fileOrIdentifier = q.fileOrIdentifier;
                merged = true;
                break;
            }
        }
        if (!merged)
            quarantine_.push_back(q);
        if (!saveQuarantineLocked())
            PHOST_LOG("failed to write plugin-quarantine.json\n");
    }

    // Keep the breadcrumb for the UI's one-time notice until it is consumed.
    if (auto* obj = crumb.getDynamicObject())
        obj->setProperty("quarantined", true);
    if (!atomicWrite(dataDir_.getChildFile("plugin-load-crash.json"), juce::JSON::toString(crumb)))
        PHOST_LOG("failed to write plugin-load-crash.json\n");
}

bool PluginRegistry::isQuarantined(const juce::String& format, const juce::String& uniqueIdHex,
                                   const juce::String& deprecatedUidHex) const
{
    const auto key = quarantineKey(format, uniqueIdHex, deprecatedUidHex);
    std::lock_guard<std::mutex> lock(quarantineMutex_);
    for (const auto& q : quarantine_)
        if (quarantineKey(q.format, q.uniqueId, q.deprecatedUid) == key)
            return true;
    return false;
}

bool PluginRegistry::isQuarantined(const juce::PluginDescription& desc) const
{
    return isQuarantined(desc.pluginFormatName, PluginLoadBreadcrumb::uidHex(desc.uniqueId),
                         PluginLoadBreadcrumb::uidHex(desc.deprecatedUid));
}

bool PluginRegistry::unquarantine(const juce::String& format, const juce::String& uniqueIdHex,
                                  const juce::String& deprecatedUidHex)
{
    const auto key = quarantineKey(format, uniqueIdHex, deprecatedUidHex);
    std::lock_guard<std::mutex> lock(quarantineMutex_);
    const auto before = quarantine_.size();
    quarantine_.erase(std::remove_if(quarantine_.begin(), quarantine_.end(),
        [&](const QuarantineEntry& q) {
            return quarantineKey(q.format, q.uniqueId, q.deprecatedUid) == key;
        }), quarantine_.end());
    if (quarantine_.size() == before)
        return false;
    if (!saveQuarantineLocked())
        PHOST_LOG("failed to write plugin-quarantine.json\n");
    PHOST_LOG("unquarantined %s\n", key.toRawUTF8());
    return true;
}

std::vector<PluginRegistry::QuarantineEntry> PluginRegistry::getQuarantine() const
{
    std::lock_guard<std::mutex> lock(quarantineMutex_);
    return quarantine_;
}

juce::var PluginRegistry::takeLastLoadCrash()
{
    const auto file = dataDir_.getChildFile("plugin-load-crash.json");
    if (!file.existsAsFile())
        return {};
    const auto parsed = juce::JSON::parse(file.loadFileAsString());
    file.deleteFile();
    return parsed.isObject() ? parsed : juce::var();
}

// ── Cache persistence ────────────────────────────────────────────────────────

void PluginRegistry::saveScanResults(const juce::File& file) const
{
    const auto snapshot = getKnownPluginsSnapshot();
    if (auto xml = snapshot->createXml())
        if (!atomicWrite(file, xml->toString()))
            PREG_LOG("failed to write %s\n", file.getFullPathName().toRawUTF8());
}

bool PluginRegistry::loadScanResults(const juce::File& file)
{
    if (!file.existsAsFile())
        return false;

    auto xml = juce::XmlDocument::parse(file);
    if (!xml)
    {
        PREG_LOG("%s is not valid XML — ignoring\n", file.getFullPathName().toRawUTF8());
        return false;
    }

    juce::KnownPluginList loaded;
    loaded.recreateFromXml(*xml);
    const auto types = loaded.getTypes();

    // ── Collapse bundle-dir / inner-binary duplicates (audit §8) ─────────────
    // Same format + uniqueId + deprecatedUid, one path the bundle directory and
    // the other inside it. Keep the entry with real I/O counts; on a tie keep
    // the bundle path.
    std::vector<bool> drop((size_t)types.size(), false);
    int collapsed = 0;
    for (int i = 0; i < types.size(); ++i)
    {
        for (int j = 0; j < types.size(); ++j)
        {
            if (i == j || drop[(size_t)i] || drop[(size_t)j])
                continue;
            const auto& bundle = types.getReference(i);
            const auto& inner  = types.getReference(j);
            if (bundle.pluginFormatName != inner.pluginFormatName
                || bundle.uniqueId != inner.uniqueId
                || bundle.deprecatedUid != inner.deprecatedUid)
                continue;
            const auto bKey = pathKey(bundle.fileOrIdentifier);
            const auto iKey = pathKey(inner.fileOrIdentifier);
            if (bKey == iKey || !ownsPath(bKey, iKey))
                continue;

            const bool bundleIO = bundle.numInputChannels != 0 || bundle.numOutputChannels != 0;
            const bool innerIO  = inner.numInputChannels  != 0 || inner.numOutputChannels  != 0;
            const int  keep     = (innerIO && !bundleIO) ? j : i;
            const int  gone     = keep == i ? j : i;
            drop[(size_t)gone] = true;
            ++collapsed;
            PREG_LOG("collapsed duplicate %s \"%s\": kept %s (%d/%d io), dropped %s (%d/%d io)\n",
                     bundle.pluginFormatName.toRawUTF8(), bundle.name.toRawUTF8(),
                     types.getReference(keep).fileOrIdentifier.toRawUTF8(),
                     types.getReference(keep).numInputChannels,
                     types.getReference(keep).numOutputChannels,
                     types.getReference(gone).fileOrIdentifier.toRawUTF8(),
                     types.getReference(gone).numInputChannels,
                     types.getReference(gone).numOutputChannels);
        }
    }

    auto list = std::make_shared<juce::KnownPluginList>();
    for (int i = 0; i < types.size(); ++i)
        if (!drop[(size_t)i])
            list->addType(types.getReference(i));

    PREG_LOG("loaded %d plugin(s) from %s (%d duplicate(s) collapsed)\n",
             list->getNumTypes(), file.getFullPathName().toRawUTF8(), collapsed);
    publish(std::move(list));

    if (collapsed > 0)
        saveScanResults(file);
    return true;
}

// ── JSON export ───────────────────────────────────────────────────────────────

juce::String PluginRegistry::getPluginListAsJSON() const
{
    const auto snapshot = getKnownPluginsSnapshot();
    juce::String json = "[\n";
    bool first = true;

    for (const auto& desc : snapshot->getTypes())
    {
        if (!first) json << ",\n";
        first = false;

        json << "  {"
             << "\"id\":\""       << escapeJsonString(desc.createIdentifierString()) << "\","
             << "\"name\":\""     << escapeJsonString(desc.name)                     << "\","
             << "\"vendor\":\""   << escapeJsonString(desc.manufacturerName)         << "\","
             << "\"category\":\"" << escapeJsonString(desc.category)                 << "\","
             << "\"format\":\""   << escapeJsonString(desc.pluginFormatName)         << "\","
             << "\"filePath\":\"" << escapeJsonString(desc.fileOrIdentifier)         << "\","
             << "\"numInputs\":"  << juce::String(desc.numInputChannels)             << ","
             << "\"numOutputs\":" << juce::String(desc.numOutputChannels)            << ","
             // hasEditor is not in PluginDescription; the editor host refines it
             // on open. Always true, as before.
             << "\"hasEditor\":true"
             << "}";
    }

    json << "\n]";
    return json;
}

// ── Scan progress ─────────────────────────────────────────────────────────────

bool PluginRegistry::isScanning() const { return scanning_.load(); }

PluginRegistry::ScanProgress PluginRegistry::getScanProgress() const
{
    ScanProgress p;
    p.scanning         = scanning_.load();
    p.done             = done_.load();
    p.total            = total_.load();
    p.skippedUnchanged = skippedUnchanged_.load();
    p.skippedFailed    = skippedFailed_.load();
    p.failedNew        = failedNew_.load();
    p.cancelled        = lastCancelled_.load();
    {
        std::lock_guard<std::mutex> lock(progressMutex_);
        p.current = current_;
        p.mode    = lastMode_;
    }
    {
        std::lock_guard<std::mutex> lock(failuresMutex_);
        p.failedCount = (int)failures_.size();
    }
    return p;
}

// ── Scan orchestration ────────────────────────────────────────────────────────

void PluginRegistry::cancelScan()
{
    cancelFlag_.store(true);
}

juce::String PluginRegistry::scanPlugins(const juce::File& scannerExe, const ScanOptions& options)
{
    std::map<juce::String, FormatPaths> settings;
    {
        // Same lock as setSearchPaths: a path change can never interleave with
        // the start of a scan, and the scan works on this snapshot throughout.
        std::lock_guard<std::mutex> lock(settingsMutex_);
        if (scanning_.load())
            return "scan-in-progress";
        if (!scannerExe.existsAsFile())
        {
            PSCAN_LOG("scanner not found: %s\n", scannerExe.getFullPathName().toRawUTF8());
            return "scanner-missing";
        }

        // The previous thread has finished (scanning_ == false); reap it.
        if (scanThread_ && scanThread_->joinable())
            scanThread_->join();

        settings = settings_;
        cancelFlag_.store(false);
        done_.store(0);
        total_.store(0);
        skippedUnchanged_.store(0);
        skippedFailed_.store(0);
        failedNew_.store(0);
        lastCancelled_.store(false);
        {
            std::lock_guard<std::mutex> pl(progressMutex_);
            current_.clear();
            lastMode_ = options.mode == ScanMode::Full ? "full" : "incremental";
        }
        scanning_.store(true);
    }

    scanThread_ = std::make_unique<std::thread>(
        [this, scannerExe, options, settings]() { runScan(scannerExe, options, settings); });
    return {};
}

juce::String PluginRegistry::retryFailed(const juce::File& scannerExe,
                                         const juce::StringArray& paths, bool all,
                                         int& removedOut)
{
    removedOut = 0;
    if (scanning_.load())
        return "scan-in-progress";

    juce::StringArray toScan;
    {
        std::lock_guard<std::mutex> lock(failuresMutex_);
        std::set<juce::String> wanted;
        for (const auto& p : paths)
            wanted.insert(pathKey(p));

        std::vector<FailureEntry> kept;
        for (const auto& f : failures_)
        {
            if (all || wanted.count(pathKey(f.path)) > 0)
            {
                toScan.addIfNotAlreadyThere(f.path, true);
                ++removedOut;
            }
            else
            {
                kept.push_back(f);
            }
        }
        if (removedOut > 0)
        {
            failures_ = std::move(kept);
            saveFailuresLocked();
        }
    }
    if (!all)
        for (const auto& p : paths)
            toScan.addIfNotAlreadyThere(p, true);

    if (toScan.isEmpty())
        return "nothing-to-retry";

    PSCAN_LOG("retry: %d failure entr%s removed, rescanning %d path(s)\n",
              removedOut, removedOut == 1 ? "y" : "ies", toScan.size());

    ScanOptions opts;
    opts.mode        = ScanMode::Incremental;
    opts.retryFailed = true;
    opts.onlyPaths   = toScan;
    return scanPlugins(scannerExe, opts);
}

std::vector<PluginRegistry::ScanItem> PluginRegistry::enumerate(
    const std::map<juce::String, FormatPaths>& settings,
    const juce::StringArray& onlyPaths) const
{
    std::vector<ScanItem> items;
    std::set<juce::String> seen;

    for (auto* format : formatManager_.getFormats())
    {
        const auto name = format->getName();
        const auto it   = settings.find(name);
        const FormatPaths fp = it != settings.end() ? it->second : FormatPaths{};

        juce::FileSearchPath sp;
        if (fp.useDefaults)
        {
            const auto defaults = format->getDefaultLocationsToSearch();
            for (int i = 0; i < defaults.getNumPaths(); ++i)
                sp.addIfNotAlreadyThere(defaults[i]);
        }
        for (const auto& u : fp.user)
            sp.addIfNotAlreadyThere(juce::File(u));
        sp.removeNonExistentPaths();

        // JUCE's per-format enumeration: for VST3 a .vst3 bundle directory is
        // ONE item and is never descended into (fixes the duplicate entry).
        // DLL-free: it only tests extensions / existence.
        const auto found = format->searchPathsForPlugins(sp, /*recursive=*/true,
                                                         /*allowPluginsWhichRequireAsynchronousInstantiation=*/false);
        PSCAN_LOG("%s: %d folder(s) searched, %d item(s) found\n",
                  name.toRawUTF8(), sp.getNumPaths(), found.size());
        for (const auto& f : found)
        {
            const auto key = name + "|" + pathKey(f);
            if (!seen.insert(key).second)
                continue;
            items.push_back({ name, f, computeFileTime(juce::File(f)) });
        }
    }

    if (onlyPaths.isEmpty())
        return items;

    // Restricted scan (retry): keep the requested items. A requested path that
    // is no longer under any search folder is still attempted if it exists.
    std::vector<ScanItem> restricted;
    for (const auto& p : onlyPaths)
    {
        const auto key = pathKey(p);
        bool matched = false;
        for (const auto& it : items)
        {
            if (pathKey(it.path) == key)
            {
                restricted.push_back(it);
                matched = true;
            }
        }
        if (matched || !juce::File(p).exists())
            continue;

        juce::String fmtName;
        {
            std::lock_guard<std::mutex> lock(failuresMutex_);
            for (const auto& f : failures_)
                if (pathKey(f.path) == key) fmtName = f.format;
        }
        for (auto* format : formatManager_.getFormats())
            if (fmtName.isEmpty() && format->fileMightContainThisPluginType(p))
                fmtName = format->getName();
        if (fmtName.isNotEmpty())
            restricted.push_back({ fmtName, p, computeFileTime(juce::File(p)) });
    }
    return restricted;
}

void PluginRegistry::runScan(juce::File exeFile, ScanOptions options,
                             std::map<juce::String, FormatPaths> settings)
{
    const auto scanStart  = std::chrono::steady_clock::now();
    const bool restricted = !options.onlyPaths.isEmpty();
    const bool full       = options.mode == ScanMode::Full;

    // ── 1. Enumerate ──────────────────────────────────────────────────────────
    const auto items = enumerate(settings, options.onlyPaths);
    total_.store((int)items.size());

    const auto prev      = getKnownPluginsSnapshot();
    const auto prevTypes = prev->getTypes();

    std::vector<juce::String> prevKeys;
    prevKeys.reserve((size_t)prevTypes.size());
    for (const auto& d : prevTypes)
        prevKeys.push_back(pathKey(d.fileOrIdentifier));

    auto ownerIndices = [&](const ScanItem& item) {
        std::vector<int> owned;
        const auto key = pathKey(item.path);
        for (int i = 0; i < prevTypes.size(); ++i)
            if (prevTypes.getReference(i).pluginFormatName == item.formatName
                && ownsPath(key, prevKeys[(size_t)i]))
                owned.push_back(i);
        return owned;
    };

    std::map<juce::String, FailureEntry> failureSnapshot;
    {
        std::lock_guard<std::mutex> lock(failuresMutex_);
        for (const auto& f : failures_)
            failureSnapshot[failureKey(f.format, f.path)] = f;
    }

    // ── 2. Classify: skip unchanged / known failures, collect work ──────────
    std::vector<const ScanItem*> work;
    int done = 0;
    for (const auto& item : items)
    {
        const auto fit = failureSnapshot.find(failureKey(item.formatName, item.path));
        if (!options.retryFailed && fit != failureSnapshot.end()
            && fit->second.fileTime == item.fileTime)
        {
            skippedFailed_.fetch_add(1);
            done_.store(++done);
            continue;
        }

        if (!full)
        {
            const auto owned = ownerIndices(item);
            bool unchanged = !owned.empty();
            for (int i : owned)
                if (prevTypes.getReference(i).lastFileModTime.toMilliseconds() != item.fileTime)
                    unchanged = false;
            if (unchanged && fit == failureSnapshot.end())
            {
                skippedUnchanged_.fetch_add(1);
                done_.store(++done);
                continue;
            }
        }
        work.push_back(&item);
    }

    PSCAN_LOG("%s scan%s: %d item(s), %d to scan, %d unchanged, %d known failure(s) skipped\n",
              full ? "full" : "incremental", restricted ? " (restricted)" : "",
              (int)items.size(), (int)work.size(),
              skippedUnchanged_.load(), skippedFailed_.load());

    // ── 3. Scan the work list in the out-of-process scanner ──────────────────
    std::vector<const ScanItem*>                              attempted;  // success or failure
    std::vector<std::pair<const ScanItem*, juce::PluginDescription>> results;
    int  succeeded = 0;
    bool aborted   = false;
    bool rotated   = false;
    std::unique_ptr<ScanCoordinator> coord;
    const auto scannerLog = exeFile.getSiblingFile("scanner-log.txt");

    auto recordFailure = [&](const ScanItem& item, const juce::String& reason) {
        failedNew_.fetch_add(1);
        std::lock_guard<std::mutex> lock(failuresMutex_);
        const auto now = nowIso();
        for (auto& f : failures_)
        {
            if (f.format == item.formatName && pathKey(f.path) == pathKey(item.path))
            {
                f.reason      = reason;
                f.fileTime    = item.fileTime;
                f.lastAttempt = now;
                f.attempts   += 1;
                return;
            }
        }
        failures_.push_back({ item.formatName, item.path, reason, item.fileTime, now, now, 1 });
    };
    auto clearFailure = [&](const ScanItem& item) {
        std::lock_guard<std::mutex> lock(failuresMutex_);
        failures_.erase(std::remove_if(failures_.begin(), failures_.end(),
            [&](const FailureEntry& f) {
                return f.format == item.formatName && pathKey(f.path) == pathKey(item.path);
            }), failures_.end());
    };

    int preflightFailed = 0;
    for (const ScanItem* item : work)
    {
        if (cancelFlag_.load())
            break;

        {
            std::lock_guard<std::mutex> pl(progressMutex_);
            current_ = item->path;
        }

        // ── Preflight (P2): parse the PE file, never load it ────────────────
        // A binary we could never load (32-bit, ARM64, no entry point, not a
        // PE, unreadable) is recorded straight into the failure list and the
        // scanner is never spawned for it. These reasons stay distinct from
        // crash/timeout: "can't load" vs "misbehaved".
        {
            const auto pre = PluginBinaryInspector::inspect(
                std::wstring(item->path.toWideCharPointer()), item->formatName.toStdString());
            if (pre.status != PluginBinaryInfo::Status::Ok)
            {
                const juce::String reason(PluginBinaryInspector::failureReason(pre.status));
                PFLIGHT_LOG("%s %s: %s (machine=%s, %d export(s), binary %s) - not sent to the scanner\n",
                            item->formatName.toRawUTF8(), item->path.toRawUTF8(),
                            reason.toRawUTF8(), pre.machine.empty() ? "?" : pre.machine.c_str(),
                            (int)pre.exports.size(), pre.binaryPath.c_str());
                attempted.push_back(item);
                recordFailure(*item, reason);
                ++preflightFailed;
                done_.store(++done);
                continue;
            }
        }

        // Launch lazily: a scan with nothing to load never spawns the scanner.
        if (!coord || !coord->isWorkerConnected())
        {
            coord.reset();
            if (!rotated)
            {
                // Keep the previous scan's log instead of deleting it.
                rotated = true;
                if (scannerLog.existsAsFile())
                {
                    const auto prevLog = exeFile.getSiblingFile("scanner-log.prev.txt");
                    prevLog.deleteFile();
                    scannerLog.moveFileTo(prevLog);
                }
            }
            const auto tl = juce::Time::getMillisecondCounterHiRes();
            auto c = std::make_unique<ScanCoordinator>();
            if (!c->launchWorkerProcess(exeFile, kScannerUID, kCoordinatorIpcTimeoutMs))
            {
                PSCAN_LOG("failed to launch %s — aborting scan\n",
                          exeFile.getFullPathName().toRawUTF8());
                aborted = true;
                break;
            }
            coord = std::move(c);
            PSCAN_LOG("scanner launched in %.0f ms\n", juce::Time::getMillisecondCounterHiRes() - tl);
        }

        PSCAN_LOG("scanning %s %s\n", item->formatName.toRawUTF8(), item->path.toRawUTF8());
        const juce::String msgStr = "SCAN:" + item->formatName + "|" + item->path;
        juce::MemoryBlock msgBlock(msgStr.toRawUTF8(), (size_t)msgStr.getNumBytesAsUTF8());
        juce::MemoryBlock response;

        const auto t0 = juce::Time::getMillisecondCounterHiRes();
        const bool ok = coord->sendAndWait(msgBlock, response, kScanTimeoutMs);
        const auto waitedMs = juce::Time::getMillisecondCounterHiRes() - t0;
        attempted.push_back(item);

        if (!ok || !coord->isWorkerConnected())
        {
            // Connection lost = the scanner died inside the plugin (crash).
            // Still connected = no reply within kScanTimeoutMs (hang); destroying
            // the coordinator disconnects the pipe and the scanner exits itself.
            const bool crashed = !coord->isWorkerConnected();
            const juce::String reason = crashed ? "crash" : "timeout";
            recordFailure(*item, reason);
            const auto t1 = juce::Time::getMillisecondCounterHiRes();
            coord.reset(); // respawn for the next item
            PSCAN_LOG("FAILED %s: %s (detected after %.0f ms, scanner teardown %.0f ms)\n",
                      item->path.toRawUTF8(), reason.toRawUTF8(), waitedMs,
                      juce::Time::getMillisecondCounterHiRes() - t1);
        }
        else
        {
            const auto respStr = response.toString();
            if (respStr.startsWith("OK:"))
            {
                juce::StringArray lines;
                lines.addTokens(respStr.fromFirstOccurrenceOf("OK:", false, false), "\n", "");
                int n = 0;
                for (const auto& line : lines)
                {
                    if (line.trim().isEmpty())
                        continue;
                    if (auto xml = juce::XmlDocument::parse(line))
                    {
                        juce::PluginDescription desc;
                        if (desc.loadFromXml(*xml))
                        {
                            // Our change-detection stamp for the whole item
                            // (bundle dir + inner binary), see computeFileTime.
                            desc.lastFileModTime = juce::Time(item->fileTime);
                            results.emplace_back(item, desc);
                            ++n;
                        }
                    }
                }
                if (n > 0)
                {
                    ++succeeded;
                    clearFailure(*item);
                    PSCAN_LOG("ok %s: %d type(s)\n", item->path.toRawUTF8(), n);
                }
                else
                {
                    PSCAN_LOG("FAILED %s: no-types-found (unparseable reply)\n",
                              item->path.toRawUTF8());
                    recordFailure(*item, "no-types-found");
                }
            }
            else
            {
                auto reason = respStr.fromFirstOccurrenceOf("FAIL:", false, false).trim();
                if (reason.isEmpty())
                    reason = "unknown";
                PSCAN_LOG("FAILED %s: %s\n", item->path.toRawUTF8(), reason.toRawUTF8());
                recordFailure(*item, reason);
            }
        }

        done_.store(++done);
    }

    coord.reset(); // closes the IPC channel; the scanner exits

    const bool cancelled = cancelFlag_.load() || aborted;
    const bool pruneStale = !cancelled && !restricted;

    // ── 4. Merge into a NEW list, then swap it in atomically ────────────────
    // Start from the previous list. Entries owned by an item we attempted are
    // replaced by that item's fresh results (or dropped if it failed). Nothing
    // else is removed unless the scan COMPLETED unrestricted, in which case
    // entries that no enumerated item owns are stale (file deleted, or its
    // folder removed from the search paths). A cancelled scan therefore only
    // ever adds/replaces what it actually re-scanned.
    std::vector<juce::String> attemptedKeys;
    for (const auto* it : attempted)
        attemptedKeys.push_back(it->formatName + "|" + pathKey(it->path));
    std::vector<std::pair<juce::String, juce::String>> itemKeys; // (format, key)
    for (const auto& it : items)
        itemKeys.emplace_back(it.formatName, pathKey(it.path));

    auto list = std::make_shared<juce::KnownPluginList>();
    int kept = 0, replaced = 0, stale = 0;
    for (int i = 0; i < prevTypes.size(); ++i)
    {
        const auto& d   = prevTypes.getReference(i);
        const auto& key = prevKeys[(size_t)i];

        bool ownedByAttempt = false;
        for (const auto* it : attempted)
            if (it->formatName == d.pluginFormatName && ownsPath(pathKey(it->path), key))
                ownedByAttempt = true;
        if (ownedByAttempt)
        {
            ++replaced;
            continue;
        }

        if (pruneStale)
        {
            bool ownedByItem = false;
            for (const auto& [fmt, ik] : itemKeys)
                if (fmt == d.pluginFormatName && ownsPath(ik, key))
                    ownedByItem = true;
            if (!ownedByItem)
            {
                bool exists = false;
                for (auto* f : formatManager_.getFormats())
                    if (f->getName() == d.pluginFormatName)
                        exists = f->doesPluginStillExist(d);
                PREG_LOG("removed stale entry \"%s\" (%s): %s\n",
                         d.name.toRawUTF8(), d.fileOrIdentifier.toRawUTF8(),
                         exists ? "outside the search paths" : "file no longer exists");
                ++stale;
                continue;
            }
        }

        list->addType(d);
        ++kept;
    }
    for (const auto& [item, desc] : results)
        list->addType(desc);

    publish(list);
    saveScanResults(cacheFile());

    {
        std::lock_guard<std::mutex> lock(failuresMutex_);
        if (pruneStale)
        {
            failures_.erase(std::remove_if(failures_.begin(), failures_.end(),
                [](const FailureEntry& f) { return !juce::File(f.path).exists(); }),
                failures_.end());
        }
        if (!saveFailuresLocked())
            PREG_LOG("failed to write plugin-scan-failures.json\n");
    }

    {
        std::lock_guard<std::mutex> pl(progressMutex_);
        current_.clear();
    }
    lastCancelled_.store(cancelled);

    const double elapsed = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - scanStart).count();
    PSCAN_LOG("%s: %d scanned ok, %d failed (%d by preflight), %d unchanged, %d known failure(s) skipped; "
              "list %d -> %d (kept %d, replaced %d, stale %d, new %d) in %.1fs\n",
              cancelled ? (aborted ? "ABORTED" : "CANCELLED") : "complete",
              succeeded, failedNew_.load(), preflightFailed, skippedUnchanged_.load(), skippedFailed_.load(),
              prevTypes.size(), list->getNumTypes(), kept, replaced, stale,
              (int)results.size(), elapsed);

    // Last: any poller that sees scanning == false also sees the swapped list.
    scanning_.store(false);
}
