#pragma once
#include "TimelineTypes.h"
#include <nlohmann/json.hpp>

// JSON serialization for TrackInfo
void to_json(nlohmann::json& j, const TrackInfo& t);
void from_json(const nlohmann::json& j, TrackInfo& t);
