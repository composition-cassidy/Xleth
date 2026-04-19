#pragma once
#include "TimelineTypes.h"
#include <nlohmann/json.hpp>
#include <string>

// JSON serialization for TrackInfo
void to_json(nlohmann::json& j, const TrackInfo& t);
void from_json(const nlohmann::json& j, TrackInfo& t);

// ── VisualEffect named-key helpers (Prompt 11) ───────────────────────────────
// Named-key serialization is the forward-compatibility contract: adding a new
// param to an existing effect, or a new effect type, does not break old
// project.json files because known keys load and unknown keys default.
std::string         visualEffectTypeToString(VisualEffect::Type t);
VisualEffect::Type  stringToVisualEffectType(const std::string& s);

nlohmann::json visualEffectParamsToNamedJson(VisualEffect::Type type,
                                             const float (&p)[16]);
void           visualEffectParamsFromNamedJson(VisualEffect::Type type,
                                               const nlohmann::json& j,
                                               float (&p)[16]);
