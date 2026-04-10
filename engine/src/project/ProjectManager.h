#pragma once
#include <functional>
#include <optional>
#include <string>
#include <vector>
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
    bool saveProject(const Timeline& timeline);

    // Save the timeline to a NEW project directory with a NEW name.
    // Creates the directory structure (same as createProject) and writes
    // project.json there. Updates projectDir_ / projectName_ so subsequent
    // save() calls write to the new location. Existing proxies/exports
    // in the OLD directory are NOT copied — they remain where they were.
    bool saveProjectAs(const std::string& newProjectDir,
                       const std::string& newProjectName,
                       const Timeline& timeline);

    // Whether a project directory has been set (via create/load/saveAs).
    bool hasProjectDir() const;

    // Load project.json from projectDir into a new Timeline.
    // Returns nullopt on failure (missing file, parse error, etc.).
    std::optional<Timeline> loadProject(const std::string& projectDir);

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
    //   3. Start proxy transcode to proxies/ in a background thread
    //   4. Add SourceMedia to timeline and return the new source ID
    // Returns -1 on failure.
    // NOTE: Full implementation requires XLETH_HAS_DECODER. Returns -1 otherwise.
    int importSource(Timeline& timeline,
                     const std::string& filePath,
                     std::function<void(float)> progressCallback = nullptr);

    std::string getProjectDir()  const;
    std::string getProxiesDir()  const;
    std::string getExportsDir()  const;
    std::string getSwappedDir()  const;

private:
    std::string projectDir_;
    std::string projectName_;
    std::string createdAt_;

    void        ensureDirectories();
    std::string projectFilePath() const;
    static std::string currentTimestamp();
};
