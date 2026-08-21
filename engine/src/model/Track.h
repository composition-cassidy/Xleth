#pragma once
#include "TimelineTypes.h"
#include <nlohmann/json.hpp>
#include <string>

// JSON serialization for TrackInfo
void to_json(nlohmann::json& j, const TrackInfo& t);
void from_json(const nlohmann::json& j, TrackInfo& t);

// ── VideoFlipConfig JSON helpers ─────────────────────────────────────────────
// Shared by Track.cpp (project file persistence) and XlethAddon.cpp (IPC).
// The JSON schema mirrors the TypeScript interface in ui/src/types/videoFlipTypes.js.
nlohmann::json  videoFlipConfigToJson(const VideoFlipConfig& cfg);
VideoFlipConfig videoFlipConfigFromJson(const nlohmann::json& j);

// ── VisualEffect named-key helpers (Prompt 11) ───────────────────────────────
// Named-key serialization is the forward-compatibility contract: adding a new
// param to an existing effect, or a new effect type, does not break old
// project.json files because known keys load and unknown keys default.
std::string         visualEffectTypeToString(VisualEffect::Type t);
VisualEffect::Type  stringToVisualEffectType(const std::string& s);

// ── ZprTracks persistence (Zoom/Pan/Rot schema v2) ───────────────────────────
// Written alongside the legacy scalars, never instead of them, so a v2 project
// still opens on a pre-v2 build. loadOrMigrateZprTracks is the single decision
// point between the two payload shapes — see its definition in Track.cpp.
nlohmann::json zprTracksToJson(const ZprTracks& tr);
void           loadOrMigrateZprTracks(const nlohmann::json& jz, ZoomPanRotSettings& z);

// Direct-authoring counterpart to loadOrMigrateZprTracks: builds a ZprTracks
// straight from a zprTracksToJson-shaped payload (as sent by the keyframe
// editor RPC) with authored ALWAYS true — unlike the project-load path, there
// is no legacy-scalar fallback to consider here, the caller is explicitly
// writing keyframes.
ZprTracks zprTracksFromJson(const nlohmann::json& jt);

nlohmann::json visualEffectParamsToNamedJson(VisualEffect::Type type,
                                             const float (&p)[16]);
void           visualEffectParamsFromNamedJson(VisualEffect::Type type,
                                               const nlohmann::json& j,
                                               float (&p)[16]);
