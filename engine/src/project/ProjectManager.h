#pragma once
#include <functional>
#include <optional>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>
#include "model/Timeline.h"

// ─── ProjectManager ───────────────────────────────────────────────────────────
// Manages Xleth project persistence: create, save, load, and validate.
//
// A project is a directory with the layout:
//   MyRemix/
//   ├── project.json      (Timeline serialized to JSON)
//   ├── proxies/          (DNxHR proxy files)
//   ├── exports/          (Exported sample audio files)
//   └── swapped/          (Swapped/processed audio files)
//
// Source media files are referenced by absolute path and are NOT copied.
// If a source file moves, validateMedia() reports it as missing.

class ProjectManager {
public:
    // Create a new project at projectDir with the given name.
    // Creates the directory structure and writes an initial empty project.json.
    bool createProject(const std::string& projectDir, const std::string& projectName);

    // Serialize the given timeline to project.json in the active project dir.
    // Pass non-empty effectChains / masterEffectChain JSON to persist effect chains
    // inside project.json (under "effectChains" and "masterEffectChain" keys).
    bool saveProject(const Timeline& timeline,
                     const nlohmann::json& effectChains     = nlohmann::json::object(),
                     const nlohmann::json& masterEffectChain = nlohmann::json());

    // Save the timeline to a NEW project directory with a NEW name.
    // Creates the directory structure (same as createProject) and writes
    // project.json there. Updates projectDir_ / projectName_ so subsequent
    // save() calls write to the new location. Existing proxies/exports
    // in the OLD directory are NOT copied — they remain where they were.
    bool saveProjectAs(const std::string& newProjectDir,
                       const std::string& newProjectName,
                       const Timeline& timeline,
                       const nlohmann::json& effectChains      = nlohmann::json::object(),
                       const nlohmann::json& masterEffectChain = nlohmann::json());

    // Whether a project directory has been set (via create/load/saveAs).
    bool hasProjectDir() const;

    // Load project.json from projectDir into a new Timeline.
    // Returns nullopt on failure (missing file, parse error, etc.).
    // After a successful load, effect chain JSON read from the file is
    // accessible via getLoadedEffectChains() / getLoadedMasterEffectChain().
    std::optional<Timeline> loadProject(const std::string& projectDir);

    // Returns the per-track effect chain JSON object read during the last
    // successful loadProject() call (keyed by trackId string).
    // Returns an empty object if the project had no "effectChains" key.
    const nlohmann::json& getLoadedEffectChains() const;

    // Returns the master effect chain JSON read during the last successful
    // loadProject() call. Returns an empty/null JSON if not present.
    const nlohmann::json& getLoadedMasterEffectChain() const;

    // Per-source validation result.
    struct MediaStatus {
        int         sourceId;
        std::string filePath;
        bool        found;
        std::string error;
    };

    // Check that every source's original file exists.
    // If proxyReady is true but the proxy file is missing, notes the error and
    // (when built with XLETH_HAS_DECODER) re-transcodes the proxy in the background.
    std::vector<MediaStatus> validateMedia(const Timeline& timeline);

    // Import a media file into the timeline:
    //   1. Validate the file path
    //   2. Open with VideoDecoder to read metadata
    //   3. Add SourceMedia to timeline and return the new source ID
    // Proxy generation is deferred to on-demand (not triggered at import).
    // Returns -1 on failure.
    // NOTE: Full implementation requires XLETH_HAS_DECODER. Returns -1 otherwise.
    int importSource(Timeline& timeline,
                     const std::string& filePath,
                     std::function<void(float)> progressCallback = nullptr);

    std::string getProjectDir()  const;
    std::string getProxiesDir()  const;
    std::string getExportsDir()  const;
    std::string getSwappedDir()  const;

    // Clear the active project directory / name so subsequent save() calls
    // act as "untitled" until createProject / saveProjectAs / loadProject
    // re-establishes a directory. Does NOT touch disk.
    void resetToBlank();

private:
    std::string projectDir_;
    std::string projectName_;
    std::string createdAt_;

    // Populated by loadProject(); consumed by the caller (bridge) to apply
    // effect chains to MixEngine after track routing is set up.
    nlohmann::json loadedEffectChains_      = nlohmann::json::object();
    nlohmann::json loadedMasterEffectChain_ = nlohmann::json();

    void        ensureDirectories();
    std::string projectFilePath() const;
    static std::string currentTimestamp();
};
