#include "project/ProjectManager.h"
#include <algorithm>
#include <chrono>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
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

std::string ProjectManager::getProxiesDir()  const {
    return (fs::path(projectDir_) / "proxies").string();
}

std::string ProjectManager::getExportsDir()  const {
    return (fs::path(projectDir_) / "exports").string();
}

std::string ProjectManager::getSwappedDir()  const {
    return (fs::path(projectDir_) / "swapped").string();
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

// ─── validateMedia ────────────────────────────────────────────────────────────

std::vector<ProjectManager::MediaStatus>
ProjectManager::validateMedia(const Timeline& timeline) {
    std::cout << "[Project] Validating " << timeline.getAllSources().size()
              << " source(s)\n";

    std::vector<MediaStatus> results;
    results.reserve(timeline.getAllSources().size());

    for (const SourceMedia* src : timeline.getAllSources()) {
        MediaStatus status;
        status.sourceId = src->id;
        status.filePath = src->filePath;
        status.found    = fs::exists(src->filePath);

        if (!status.found) {
            status.error = "Source file not found: " + src->filePath;
            std::cerr << "[Project] WARNING source id=" << src->id
                      << " missing: " << src->filePath << "\n";
        } else if (src->proxyReady && !src->proxyPath.empty() &&
                   !fs::exists(src->proxyPath)) {
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

    std::cout << "[Project] Validated " << results.size() << " source(s)\n";
    return results;
}

// ─── importSource ─────────────────────────────────────────────────────────────

int ProjectManager::importSource(Timeline& timeline,
                                 const std::string& filePath,
                                 std::function<void(float)> progressCallback) {
#ifdef XLETH_HAS_DECODER
    (void)progressCallback; // reserved for future on-demand proxy progress reporting
    std::cout << "[Project] Importing source: " << filePath << "\n";

    if (!fs::exists(filePath)) {
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
        media.fileName    = fs::path(filePath).filename().string();
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
    media.fileName    = fs::path(filePath).filename().string();
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
