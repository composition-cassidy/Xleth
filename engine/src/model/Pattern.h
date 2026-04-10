#pragma once
#include "TimelineTypes.h"
#include <nlohmann/json.hpp>

// JSON serialization for PatternNote and Pattern.
// TickTime is flattened to raw int64_t ticks to keep JSON human-readable.

void to_json(nlohmann::json& j, const PatternNote& n);
void from_json(const nlohmann::json& j, PatternNote& n);

void to_json(nlohmann::json& j, const Pattern& p);
void from_json(const nlohmann::json& j, Pattern& p);
