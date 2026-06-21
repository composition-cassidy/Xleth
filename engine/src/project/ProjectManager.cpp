#include "project/ProjectManager.h"
#include <algorithm>
#include <cctype>
#include <chrono>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <system_error>
#include <nlohmann/json.hpp>

#ifdef XLETH_HAS_DECODER
#include "VideoDecoder.h"
#include "ProxyTranscoder.h"
#include "audio/SourcePlayer.h"
#include <thread>
#endif

namespace fs = std::filesystem;
using json   = nlohmann::json;

static constexpr const char* XLETH_VERSION = "0.1.0";

namespace {

fs::path utf8FilesystemPath(const std::string& path)
{
#ifdef _WIN32
    std::u8string utf8;
    utf8.reserve(path.size());
    for (const unsigned char ch : path)
        utf8.push_back(static_cast<char8_t>(ch));
    return fs::path(utf8);
#else
    return fs::path(path);
#endif
}

bool fileExistsUtf8(const std::string& path)
{
    std::error_code ec;
    const bool exists = fs::exists(utf8FilesystemPath(path), ec);
    return exists && !ec;
}

std::string filenameFromUtf8Path(const std::string& path)
{
    const auto pos = path.find_last_of("/\\");
    return pos == std::string::npos ? path : path.substr(pos + 1);
}

// True for "C:\...", "C:/...", "\\server\share", or POSIX "/abs". A path that is
// none of these is treated as relative-to-project.
bool isAbsolutePath(const std::string& path)
{
    if (path.size() >= 2 && std::isalpha(static_cast<unsigned char>(path[0])) &&
        path[1] == ':')
        return true;                              // Windows drive path
    if (path.size() >= 2 && (path[0] == '\\' || path[0] == '/') &&
        (path[1] == '\\' || path[1] == '/'))
        return true;                              // UNC \\server\share
    if (!path.empty() && (path[0] == '/' || path[0] == '\\'))
        return true;                              // POSIX root
    return false;
}

} // namespace

// ─── Helpers ──────────────────────────────────────────────────────────────────

std::string ProjectManager::currentTimestamp() {
    auto now   = std::chrono::system_clock::now();
    std::time_t t = std::chrono::system_clock::to_time_t(now);
    std::tm tm_buf{};
#ifdef _WIN32
    gmtime_s(&tm_buf, &t);
#else
    gmtime_r(&t, &tm_buf);
#endif
    std::ostringstream oss;
    oss << std::put_time(&tm_buf, "%Y-%m-%dT%H:%M:%SZ");
    return oss.str();
}

std::string ProjectManager::projectFilePath() const {
    return (fs::path(projectDir_) / "project.json").string();
}

void ProjectManager::ensureDirectories() {
    fs::create_directories(projectDir_);
    fs::create_directories(getProxiesDir());
    fs::create_directories(getExportsDir());
    fs::create_directories(getSwappedDir());
}

// ─── Directory Accessors ──────────────────────────────────────────────────────

std::string ProjectManager::getProjectDir()  const { return projectDir_; }

std::string ProjectManager::getProjectName() const { return projectName_; }

std::string ProjectManager::getProxiesDir()  const {
    return (fs::path(projectDir_) / "proxies").string();
}

std::string ProjectManager::getExportsDir()  const {
    return (fs::path(projectDir_) / "exports").string();
}

std::string ProjectManager::getSwappedDir()  const {
    return (fs::path(projectDir_) / "swapped").string();
}

std::string ProjectManager::getMediaDir()    const {
    return (fs::path(projectDir_) / "media").string();
}

// ─── createProject ────────────────────────────────────────────────────────────

bool ProjectManager::createProject(const std::string& projectDir,
                                   const std::string& projectName) {
    std::cout << "[Project] Creating project '" << projectName
              << "' at: " << projectDir << "\n";

    projectDir_  = projectDir;
    projectName_ = projectName;
    createdAt_   = currentTimestamp();

    try {
        ensureDirectories();
    } catch (const std::exception& e) {
        std::cerr << "[Project] ERROR creating directories: " << e.what() << "\n";
        return false;
    }

    Timeline emptyTimeline;
    if (!saveProject(emptyTimeline)) {
        std::cerr << "[Project] ERROR writing initial project.json\n";
        return false;
    }

    std::cout << "[Project] Created project structure: proxies/ exports/ swapped/\n";
    return true;
}

// ─── saveProject ──────────────────────────────────────────────────────────────

bool ProjectManager::saveProject(const Timeline& timeline,
                                  const nlohmann::json& effectChains,
                                  const nlohmann::json& masterEffectChain) {
    // NOTE (Prompt 11): Preview performance settings (previewResolutionScale,
    // previewEffectsBypass) are workstation-local by design and persisted via
    // the Electron settings store (xleth-settings.json), NOT in project.json.
    // This keeps project files portable across machines with different GPUs.
    if (projectDir_.empty()) {
        std::cerr << "[Project] ERROR saveProject: no project directory set"
                     " (call createProject or loadProject first)\n";
        return false;
    }

    // Collect unique custom label names from all regions
    std::vector<std::string> customLabels;
    for (const SampleRegion* region : timeline.getAllRegions()) {
        if (region->label == SampleLabel::Custom && !region->customLabelName.empty()) {
            if (std::find(customLabels.begin(), customLabels.end(),
                          region->customLabelName) == customLabels.end()) {
                customLabels.push_back(region->customLabelName);
            }
        }
    }

    // Delegate array serialization to Timeline's own serializer
    json tl = timeline.toJSON();

    json j;
    j["xleth_version"]  = XLETH_VERSION;
    j["project_name"]   = projectName_;
    j["created_at"]     = createdAt_.empty() ? currentTimestamp() : createdAt_;
    j["modified_at"]    = currentTimestamp();
    j["bpm"]            = timeline.getBPM();
    j["sample_rate"]    = timeline.getSampleRate();
    j["time_signature"] = json::array({timeline.getTimeSigNum(), timeline.getTimeSigDen()});
    j["sources"]        = tl.value("sources", json::array());
    j["regions"]        = tl.value("regions", json::array());
    j["tracks"]         = tl.value("tracks",  json::array());
    j["clips"]          = tl.value("clips",   json::array());
    j["patterns"]       = tl.value("patterns",      json::array());
    j["patternBlocks"]  = tl.value("patternBlocks", json::array());
    j["gridLayout"]     = tl.value("gridLayout", json::object());
    j["declickMs"]      = tl.value("declickMs", 0.0);
    j["globalStretchMethod"] = tl.value("globalStretchMethod", 1);
    j["custom_labels"]  = customLabels;

    // Effect chains — only written when non-empty (keeps project files clean)
    if (effectChains.is_object() && !effectChains.empty())
        j["effectChains"] = effectChains;
    if (masterEffectChain.is_object() && !masterEffectChain.is_null()
            && masterEffectChain.contains("nodes")
            && !masterEffectChain["nodes"].empty())
        j["masterEffectChain"] = masterEffectChain;

    const std::string path = projectFilePath();
    try {
        std::ofstream f(path);
        if (!f.is_open()) {
            std::cerr << "[Project] ERROR saveProject: cannot open for writing: "
                      << path << "\n";
            return false;
        }
        f << j.dump(4);
    } catch (const std::exception& e) {
        std::cerr << "[Project] ERROR saveProject: " << e.what() << "\n";
        return false;
    }

    std::cout << "[Project] Saved '" << projectName_ << "' → " << path
              << " (" << timeline.getAllSources().size() << " sources, "
              << timeline.getAllRegions().size() << " regions, "
              << timeline.getAllTracks().size()  << " tracks, "
              << timeline.getAllClips().size()   << " clips)\n";
    return true;
}

// ─── saveProjectAs ────────────────────────────────────────────────────────────

bool ProjectManager::saveProjectAs(const std::string& newProjectDir,
                                   const std::string& newProjectName,
                                   const Timeline& timeline,
                                   const nlohmann::json& effectChains,
                                   const nlohmann::json& masterEffectChain) {
    if (newProjectDir.empty()) {
        std::cerr << "[Project] ERROR saveProjectAs: empty directory\n";
        return false;
    }

    std::cout << "[Project] Save As '" << newProjectName
              << "' → " << newProjectDir << "\n";

    projectDir_  = newProjectDir;
    projectName_ = newProjectName;
    if (createdAt_.empty())
        createdAt_ = currentTimestamp();

    try {
        ensureDirectories();
    } catch (const std::exception& e) {
        std::cerr << "[Project] ERROR saveProjectAs: creating directories: "
                  << e.what() << "\n";
        return false;
    }

    return saveProject(timeline, effectChains, masterEffectChain);
}

bool ProjectManager::hasProjectDir() const {
    return !projectDir_.empty();
}

void ProjectManager::resetToBlank() {
    std::cout << "[Project] Reset to blank (was '"
              << projectName_ << "' at '" << projectDir_ << "')\n";
    projectDir_.clear();
    projectName_.clear();
    createdAt_.clear();
    loadedEffectChains_      = nlohmann::json::object();
    loadedMasterEffectChain_ = nlohmann::json();
}

// ─── loadProject ──────────────────────────────────────────────────────────────

std::optional<Timeline> ProjectManager::loadProject(const std::string& projectDir) {
    std::cout << "[Project] Loading project from: " << projectDir << "\n";

    // Reset so stale data from a previous load is never returned on failure.
    loadedEffectChains_      = nlohmann::json::object();
    loadedMasterEffectChain_ = nlohmann::json();

    projectDir_ = projectDir;
    ensureDirectories();
    const std::string path = projectFilePath();

    if (!fs::exists(path)) {
        std::cerr << "[Project] ERROR loadProject: project.json not found: "
                  << path << "\n";
        return std::nullopt;
    }

    json j;
    try {
        std::ifstream f(path);
        if (!f.is_open()) {
            std::cerr << "[Project] ERROR loadProject: cannot open: " << path << "\n";
            return std::nullopt;
        }
        f >> j;
    } catch (const std::exception& e) {
        std::cerr << "[Project] ERROR loadProject: JSON parse error: "
                  << e.what() << "\n";
        return std::nullopt;
    }

    projectName_ = j.value("project_name", "Untitled");
    createdAt_   = j.value("created_at", "");

    // Translate project.json keys → the format Timeline::fromJSON expects
    json tl;
    tl["bpm"]        = j.value("bpm", 140.0);
    tl["sampleRate"] = j.value("sample_rate", 44100.0);

    if (j.contains("time_signature") &&
        j["time_signature"].is_array() &&
        j["time_signature"].size() >= 2) {
        tl["timeSigNum"] = j["time_signature"][0].get<int>();
        tl["timeSigDen"] = j["time_signature"][1].get<int>();
    } else {
        tl["timeSigNum"] = 4;
        tl["timeSigDen"] = 4;
    }

    tl["sources"]       = j.value("sources", json::array());
    tl["regions"]       = j.value("regions", json::array());
    tl["tracks"]        = j.value("tracks",  json::array());
    tl["clips"]         = j.value("clips",   json::array());
    tl["patterns"]      = j.value("patterns",      json::array());
    tl["patternBlocks"] = j.value("patternBlocks", json::array());
    if (j.contains("gridLayout")) tl["gridLayout"] = j["gridLayout"];
    tl["declickMs"] = j.value("declickMs", 0.0);
    tl["globalStretchMethod"] = j.value("globalStretchMethod", 1);

    // Compute nextId = max(all entity ids) + 1 so the timeline counter is correct
    int maxId = 0;
    for (const auto& arr : { tl["sources"], tl["regions"], tl["tracks"], tl["clips"],
                              tl["patterns"], tl["patternBlocks"] }) {
        for (const auto& item : arr) {
            if (item.contains("id"))
                maxId = std::max(maxId, item["id"].get<int>());
        }
    }
    tl["nextId"] = maxId + 1;

    Timeline timeline;
    if (!timeline.fromJSON(tl)) {
        std::cerr << "[Project] ERROR loadProject: failed to deserialize timeline\n";
        return std::nullopt;
    }

    // Stash effect chain JSON for the caller (bridge) to apply after track routing
    // is fully set up. Graceful no-op for older projects that lack these keys.
    if (j.contains("effectChains") && j["effectChains"].is_object())
        loadedEffectChains_ = j["effectChains"];
    if (j.contains("masterEffectChain") && j["masterEffectChain"].is_object())
        loadedMasterEffectChain_ = j["masterEffectChain"];

    // Heal in-project asset paths (swapped/exports/media/proxies) that broke
    // because the project moved. External sources that can't be found here stay
    // missing and surface to the relink UI via validateMedia().
    resolveMediaPaths(timeline);

    std::cout << "[Project] Loaded '" << projectName_
              << "': BPM=" << timeline.getBPM()
              << ", SR=" << timeline.getSampleRate()
              << ", " << timeline.getAllSources().size() << " sources"
              << ", " << timeline.getAllRegions().size() << " regions"
              << ", " << timeline.getAllTracks().size()  << " tracks"
              << ", " << timeline.getAllClips().size()   << " clips\n";
    return timeline;
}

// ─── Effect chain getters ─────────────────────────────────────────────────────

const nlohmann::json& ProjectManager::getLoadedEffectChains() const {
    return loadedEffectChains_;
}

const nlohmann::json& ProjectManager::getLoadedMasterEffectChain() const {
    return loadedMasterEffectChain_;
}

// ─── Path resolution (relink-on-load) ─────────────────────────────────────────

std::optional<std::string>
ProjectManager::resolveMediaPath(const std::string& stored) const {
    if (stored.empty() || projectDir_.empty())
        return std::nullopt;

    // 1. Stored path exists as-is (the normal same-machine case).
    if (fileExistsUtf8(stored))
        return stored;

    // 2. Stored path is project-relative (written by Export ZIP) → join to dir.
    if (!isAbsolutePath(stored)) {
        const std::string joined = projectDir_ + "/" + stored;
        if (fileExistsUtf8(joined))
            return joined;
    }

    // Normalize separators for the substring scans below.
    std::string norm = stored;
    std::replace(norm.begin(), norm.end(), '\\', '/');

    // 3. In-project subfolder tail: an absolute path from another machine still
    //    carries ".../swapped/foo.wav"; rebuild that tail from the current dir.
    static const char* kSubdirs[] = { "media", "swapped", "exports", "proxies" };
    for (const char* sub : kSubdirs) {
        const std::string needle = std::string("/") + sub + "/";
        size_t tailStart = std::string::npos;
        if (const auto pos = norm.rfind(needle); pos != std::string::npos)
            tailStart = pos + 1;                                  // keep "<sub>/..."
        else if (norm.rfind(std::string(sub) + "/", 0) == 0)
            tailStart = 0;                                        // begins with "<sub>/"
        if (tailStart != std::string::npos) {
            const std::string joined = projectDir_ + "/" + norm.substr(tailStart);
            if (fileExistsUtf8(joined))
                return joined;
        }
    }

    // 4. Last resort: basename match inside the in-project asset folders.
    const std::string base = filenameFromUtf8Path(stored);
    for (const std::string& dir : { getMediaDir(), getSwappedDir(), getExportsDir() }) {
        const std::string candidate = dir + "/" + base;
        if (fileExistsUtf8(candidate))
            return candidate;
    }

    return std::nullopt;
}

void ProjectManager::resolveMediaPaths(Timeline& timeline) {
    int relinked = 0;

    for (const SourceMedia* csrc : timeline.getAllSources()) {
        SourceMedia* src = timeline.getSourceMutable(csrc->id);
        if (!src) continue;
        if (auto r = resolveMediaPath(src->filePath); r && *r != src->filePath) {
            std::cout << "[Project] Auto-relinked source id=" << src->id
                      << ": " << src->filePath << " -> " << *r << "\n";
            src->filePath = *r;
            ++relinked;
        }
        if (auto r = resolveMediaPath(src->proxyPath); r && *r != src->proxyPath)
            src->proxyPath = *r;
    }

    for (SampleRegion* reg : timeline.getAllRegionsMutable()) {
        if (auto r = resolveMediaPath(reg->swappedAudioPath);
                r && *r != reg->swappedAudioPath) {
            std::cout << "[Project] Auto-relinked region id=" << reg->id
                      << " swapped audio -> " << *r << "\n";
            reg->swappedAudioPath = *r;
            ++relinked;
        }
        if (auto r = resolveMediaPath(reg->audioFilePath);
                r && *r != reg->audioFilePath) {
            reg->audioFilePath = *r;
            ++relinked;
        }
    }

    if (relinked > 0)
        std::cout << "[Project] resolveMediaPaths: auto-relinked "
                  << relinked << " in-project path(s)\n";
}

// ─── relinkSource / relinkRegionAudio ─────────────────────────────────────────

bool ProjectManager::relinkSource(Timeline& timeline, int sourceId,
                                  const std::string& newPath) {
    SourceMedia* src = timeline.getSourceMutable(sourceId);
    if (!src) {
        std::cerr << "[Project] relinkSource: unknown source id=" << sourceId << "\n";
        return false;
    }
    if (!fileExistsUtf8(newPath)) {
        std::cerr << "[Project] relinkSource: new path not found: " << newPath << "\n";
        return false;
    }

    src->filePath   = newPath;
    src->fileName   = filenameFromUtf8Path(newPath);
    // The old proxy belongs to the old file — clear so it regenerates on demand.
    src->proxyPath  = "";
    src->proxyReady = true;

#ifdef XLETH_HAS_DECODER
    // Best-effort re-probe so resolution/fps/duration match the new file.
    VideoDecoder decoder;
    if (decoder.open(newPath)) {
        src->width       = decoder.getWidth();
        src->height      = decoder.getHeight();
        src->fps         = decoder.getFPS();
        src->duration    = decoder.getDuration();
        src->totalFrames = decoder.getTotalFrames();
        src->hasVideo    = (src->width > 0 && src->height > 0);
        decoder.close();
    } else {
        double audioDuration = 0.0;
        if (SourcePlayer::probeAudio(newPath, audioDuration)) {
            src->width = src->height = src->totalFrames = 0;
            src->fps = 0.0;
            src->duration = audioDuration;
            src->hasVideo = false;
        }
    }
#endif

    std::cout << "[Project] Relinked source id=" << sourceId
              << " -> " << newPath << "\n";
    return true;
}

bool ProjectManager::relinkRegionAudio(Timeline& timeline, int regionId,
                                       const std::string& newPath) {
    SampleRegion* reg = timeline.getRegionMutable(regionId);
    if (!reg) {
        std::cerr << "[Project] relinkRegionAudio: unknown region id="
                  << regionId << "\n";
        return false;
    }
    if (!fileExistsUtf8(newPath)) {
        std::cerr << "[Project] relinkRegionAudio: new path not found: "
                  << newPath << "\n";
        return false;
    }

    reg->swappedAudioPath = newPath;
    reg->hasSwappedAudio  = true;
    std::cout << "[Project] Relinked region id=" << regionId
              << " swapped audio -> " << newPath << "\n";
    return true;
}

// ─── validateMedia ────────────────────────────────────────────────────────────

std::vector<ProjectManager::MediaStatus>
ProjectManager::validateMedia(const Timeline& timeline) {
    std::cout << "[Project] Validating " << timeline.getAllSources().size()
              << " source(s)\n";

    std::vector<MediaStatus> results;
    results.reserve(timeline.getAllSources().size());

    for (const SourceMedia* src : timeline.getAllSources()) {
        MediaStatus status;
        status.sourceId    = src->id;
        status.kind        = "source";
        status.filePath    = src->filePath;
        status.displayName = src->fileName.empty()
                                 ? filenameFromUtf8Path(src->filePath)
                                 : src->fileName;
        status.found       = fileExistsUtf8(src->filePath);

        if (!status.found) {
            status.error = "Source file not found: " + src->filePath;
            std::cerr << "[Project] WARNING source id=" << src->id
                      << " missing: " << src->filePath << "\n";
        } else if (src->proxyReady && !src->proxyPath.empty() &&
                   !fileExistsUtf8(src->proxyPath)) {
            // Original exists but proxy was lost — note it and optionally re-transcode
            status.error = "Proxy missing (original OK): " + src->proxyPath;
            std::cout << "[Project] WARNING proxy missing for source id=" << src->id
                      << ": " << src->proxyPath << "\n";

#ifdef XLETH_HAS_DECODER
            std::string proxiesDir = getProxiesDir();
            std::string srcPath    = src->filePath;
            std::thread([srcPath, proxiesDir]() {
                std::cout << "[Project] Re-transcoding proxy for: " << srcPath << "\n";
                std::string result = ProxyTranscoder::transcode(srcPath, proxiesDir);
                if (result.empty())
                    std::cerr << "[Project] ERROR re-transcode failed for: "
                              << srcPath << "\n";
                else
                    std::cout << "[Project] Re-transcoded proxy → " << result << "\n";
            }).detach();
#endif
        } else {
            std::cout << "[Project] OK source id=" << src->id
                      << ": " << src->filePath << "\n";
        }

        results.push_back(std::move(status));
    }

    // Per-region swapped audio lives inside the project folder (swapped/).
    // resolveMediaPaths() heals the in-project ones on load; anything still
    // missing here is a genuine relink candidate. (audioFilePath is intentionally
    // not validated: it is not used by the playback load path — audio_loadRegionAudio
    // reads swappedAudioPath or the source filePath — so reporting it would only
    // produce false-positive relink prompts.)
    for (const SampleRegion* reg : timeline.getAllRegions()) {
        if (!reg->hasSwappedAudio || reg->swappedAudioPath.empty())
            continue;
        MediaStatus status;
        status.regionId    = reg->id;
        status.kind        = "swappedAudio";
        status.filePath    = reg->swappedAudioPath;
        status.displayName = filenameFromUtf8Path(reg->swappedAudioPath);
        status.found       = fileExistsUtf8(reg->swappedAudioPath);
        if (!status.found) {
            status.error = "Swapped audio not found: " + reg->swappedAudioPath;
            std::cerr << "[Project] WARNING region id=" << reg->id
                      << " swapped audio missing: " << reg->swappedAudioPath << "\n";
        }
        results.push_back(std::move(status));
    }

    std::cout << "[Project] Validated " << results.size() << " media reference(s)\n";
    return results;
}

// ─── importSource ─────────────────────────────────────────────────────────────

int ProjectManager::importSource(Timeline& timeline,
                                 const std::string& filePath,
                                 std::function<void(float)> progressCallback) {
#ifdef XLETH_HAS_DECODER
    (void)progressCallback; // reserved for future on-demand proxy progress reporting
    std::cout << "[Project] Importing source: " << filePath << "\n";

    if (!fileExistsUtf8(filePath)) {
        std::cerr << "[Project] ERROR importSource: file not found: " << filePath << "\n";
        return -1;
    }

    VideoDecoder decoder;
    const bool hasVideoStream = decoder.open(filePath);

    if (!hasVideoStream) {
        // No video stream — try audio-only path.
        double audioDuration = 0.0;
        if (!SourcePlayer::probeAudio(filePath, audioDuration)) {
            std::cerr << "[Project] ERROR importSource: no video or audio streams: "
                      << filePath << "\n";
            return -1;
        }

        SourceMedia media;
        media.filePath    = filePath;
        media.fileName    = filenameFromUtf8Path(filePath);
        media.width       = 0;
        media.height      = 0;
        media.fps         = 0.0;
        media.duration    = audioDuration;
        media.totalFrames = 0;
        media.hasVideo    = false;
        media.proxyPath   = "";
        media.proxyReady  = true;   // nothing to transcode

        int srcId = timeline.addSource(media);
        std::cout << "[Project] Importing source id=" << srcId
                  << " '" << media.fileName << "'"
                  << " duration=" << media.duration << "s"
                  << " hasVideo=0 (audio-only)\n";
        return srcId;
    }

    SourceMedia media;
    media.filePath    = filePath;
    media.fileName    = filenameFromUtf8Path(filePath);
    media.width       = decoder.getWidth();
    media.height      = decoder.getHeight();
    media.fps         = decoder.getFPS();
    media.duration    = decoder.getDuration();
    media.totalFrames = decoder.getTotalFrames();
    media.hasVideo    = (media.width > 0 && media.height > 0);
    media.proxyPath   = "";    // no proxy at import time; generated on-demand
    media.proxyReady  = true;  // original file used directly — no transcode needed
    decoder.close();

    int srcId = timeline.addSource(media);
    std::cout << "[Project] Importing source id=" << srcId
              << " '" << media.fileName << "' "
              << media.width << "x" << media.height
              << " fps=" << media.fps
              << " duration=" << media.duration << "s"
              << " hasVideo=" << media.hasVideo << "\n";

    return srcId;
#else
    std::cerr << "[Project] ERROR importSource: not available"
                 " (build with XLETH_HAS_DECODER)\n";
    (void)timeline;
    (void)filePath;
    (void)progressCallback;
    return -1;
#endif
}
