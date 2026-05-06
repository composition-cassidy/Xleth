#pragma once
#include "TimelineTypes.h"
#include <nlohmann/json.hpp>

// JSON serialization for Clip
// TickTime is stored as raw int64_t ticks to keep the JSON human-readable.
void to_json(nlohmann::json& j, const Clip& c);
void from_json(const nlohmann::json& j, Clip& c);

// Per-clip modulation FX descriptor — round-tripped as a nested "modulation"
// object on the clip. See ClipModulation in TimelineTypes.h.
void to_json(nlohmann::json& j, const ClipModulation& m);
void from_json(const nlohmann::json& j, ClipModulation& m);
