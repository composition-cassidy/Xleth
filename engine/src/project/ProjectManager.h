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

// ─── Project schema version ───────────────────────────────────────────────────
// Written as project.json["schema_version"]. Absent ⇒ 1.
//   1 — single sample per sampler; per-sample state lived as top-level scalars
//       on each region (rootNote/smpStart/loop*/fade*/declickMs/destructive flags).
//   2 — 8-slot layered sampler. Per-sample state moved onto SampleRegion::slots;
//       v1 regions migrate losslessly into slot 0 (see SampleRegion.cpp from_json).
//   3 — Sampler modulation system: SampleRegion::modulation carries 6 envelopes,
//       6 LFOs, the VELO/NOTE response curves and the route list. A v2 region
//       has no "modulation" key at all, which reads back as an empty route list
//       — an exact bypass — so the migration is lossless and silent. The legacy
//       ADSR / pitch envelope / three drawable LFOs are UNTOUCHED by this
//       version: they still load, save and sound exactly as in v2.
// Loading an older schema migrates in memory and re-saves at the current version.
// 4 — sampler modulation unified. The hardcoded pitch envelope and the three
//     drawable VOL/PAN/PITCH LFOs migrate into the general ENV/LFO source bank
//     and route list on load, and the amplitude DAHDSR is mirrored into ENV 1
//     (it stays the VCA and the voice-lifecycle gate, so it is NOT a route).
//     See model/SamplerLegacyMigration.h for the mapping and the one place it
//     is deliberately not bit-exact.
//     NOTE: the legacy fields themselves are still present and still drive the
//     engine — removing them is a follow-up. Until then a v4+ project carries
//     BOTH, and the migration's numRoutes == 0 gate is what stops it re-running
//     over routes the user has since edited.
// v5: per-slot MANGLE chain. A single MANGLE (schema ≤4 mangleMode/Amount/Mix)
//     migrates to a one-instance chain with identical sound on load.
// v6: Zoom/Pan/Rot keyframe tracks (ParamTrack). The legacy scalars
//     (startZoom/targetZoom/pan/rotation/durationMs/easing) are still written
//     and are still the edit surface; a `zoomPanRot.tracks` block carrying the
//     four canonical ParamTracks is written alongside them. A v≤5 project has
//     no tracks block and is migrated on load by loadOrMigrateZprTracks, which
//     maps each named easing to its EXACT cubic bezier.
//     NOT bit-exact: zoom is now interpolated in log2 space rather than
//     linearly. Endpoints and the post-animation hold are unchanged; the
//     interior of a zoom sweep differs by that reparameterization. A 1x→8x
//     sweep now reads 2.83x at its midpoint instead of 4.5x.
inline constexpr int XLETH_PROJECT_SCHEMA_VERSION = 6;

class ProjectManager {
public:
    // Schema version of the most recently loaded project (1 when the file
    // predates the key). Lets callers report/telemeter a migration.
    int loadedSchemaVersion() const { return loadedSchemaVersion_; }

    // Create a new project at projectDir with the given name.
    // Creates the directory structure and writes an initial empty project.json.
    bool createProject(const std::string& projectDir, const std::string& projectName);

    // Serialize the given timeline to project.json in the active project dir.
    // Pass non-empty effectChains / masterEffectChain JSON to persist effect chains
    // inside project.json (under "effectChains" and "masterEffectChain" keys).
    // masterVolume is a MixEngine-only value (no Timeline field backs it), so it
    // has to be passed in explicitly to be persisted.
    bool saveProject(const Timeline& timeline,
                     const nlohmann::json& effectChains     = nlohmann::json::object(),
                     const nlohmann::json& masterEffectChain = nlohmann::json(),
                     float masterVolume = 1.0f);

    // Save the timeline to a NEW project directory with a NEW name.
    // Creates the directory structure (same as createProject) and writes
    // project.json there. Updates projectDir_ / projectName_ so subsequent
    // save() calls write to the new location. Existing proxies/exports
    // in the OLD directory are NOT copied — they remain where they were.
    bool saveProjectAs(const std::string& newProjectDir,
                       const std::string& newProjectName,
                       const Timeline& timeline,
                       const nlohmann::json& effectChains      = nlohmann::json::object(),
                       const nlohmann::json& masterEffectChain = nlohmann::json(),
                       float masterVolume = 1.0f);

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

    // Master fader gain read during the last successful loadProject().
    // Defaults to 1.0 (0 dB) for projects saved before it was persisted.
    float getLoadedMasterVolume() const;

    // Per-media validation result. Covers both Media Pool sources and the
    // per-region swapped/extracted audio that lives inside the project folder.
    struct MediaStatus {
        int         sourceId = -1;          // set when kind == "source"
        int         regionId = -1;          // set when kind == "swappedAudio"/"audio"
        std::string kind;                   // "source" | "swappedAudio" | "audio"
        std::string filePath;               // the (still) stored path
        std::string displayName;            // basename, for the relink UI
        bool        found = false;
        std::string error;
    };

    // Check that every media reference resolves on disk: each source's original
    // file plus each region's swapped/extracted audio. Items that resolveMediaPaths
    // already healed report found=true; only genuine externals stay found=false.
    // If proxyReady is true but the proxy file is missing, notes the error and
    // (when built with XLETH_HAS_DECODER) re-transcodes the proxy in the background.
    std::vector<MediaStatus> validateMedia(const Timeline& timeline);

    // Point a Media Pool source at a user-chosen replacement file. Updates
    // filePath/fileName, clears the (now-stale) proxy so it regenerates, and
    // (when built with XLETH_HAS_DECODER) re-probes width/height/fps/duration.
    // Returns false if the source id is unknown or newPath does not exist.
    bool relinkSource(Timeline& timeline, int sourceId, const std::string& newPath);

    // Point a region's swapped audio at a user-chosen replacement file.
    // Returns false if the region id is unknown or newPath does not exist.
    bool relinkRegionAudio(Timeline& timeline, int regionId, const std::string& newPath);

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
    std::string getProjectName() const;
    std::string getProxiesDir()  const;
    std::string getExportsDir()  const;
    std::string getSwappedDir()  const;
    std::string getMediaDir()    const;   // <projectDir>/media (consolidated sources)
    std::string getSlotsDir()    const;   // <projectDir>/slots (per-slot layer audio)

    // <projectDir>/cache/audio — derived audio the project can always rebuild:
    // today, the sampler's per-slot PREP bakes. Safe to delete at any time;
    // anything missing is simply re-rendered on next use. Empty when no
    // project directory is set.
    std::string getAudioCacheDir() const;

    // Clear the active project directory / name so subsequent save() calls
    // act as "untitled" until createProject / saveProjectAs / loadProject
    // re-establishes a directory. Does NOT touch disk.
    void resetToBlank();

private:
    std::string projectDir_;
    std::string projectName_;
    std::string createdAt_;
    int         loadedSchemaVersion_ = XLETH_PROJECT_SCHEMA_VERSION;

    // Populated by loadProject(); consumed by the caller (bridge) to apply
    // effect chains to MixEngine after track routing is set up.
    nlohmann::json loadedEffectChains_      = nlohmann::json::object();
    nlohmann::json loadedMasterEffectChain_ = nlohmann::json();
    float          loadedMasterVolume_      = 1.0f;

    void        ensureDirectories();
    std::string projectFilePath() const;
    static std::string currentTimestamp();

    // Resolve a single stored media path against the *current* project dir when
    // the stored (often absolute, from another machine) path is missing.
    // Tries, in order: the stored path as-is, the stored path as project-relative,
    // an in-project subfolder tail (media/swapped/exports/proxies), and a basename
    // match inside media/swapped/exports. Returns the path to use, or nullopt if
    // nothing resolves (caller leaves it for the manual relink prompt).
    std::optional<std::string> resolveMediaPath(const std::string& stored) const;

    // Walk every source/region path and rewrite any that resolveMediaPath heals.
    // Called at the end of loadProject so moved in-project assets self-heal.
    void resolveMediaPaths(Timeline& timeline);
};
