#pragma once
#include "TimelineTypes.h"
#include <nlohmann/json.hpp>

// JSON serialization for PatternBlock.
// TickTime is flattened to raw int64_t ticks to keep JSON human-readable.

void to_json(nlohmann::json& j, const PatternBlock& b);
void from_json(const nlohmann::json& j, PatternBlock& b);
