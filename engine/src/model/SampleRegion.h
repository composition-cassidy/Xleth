#pragma once
#include "TimelineTypes.h"
#include <nlohmann/json.hpp>

// JSON serialization for SampleRegion::Syllable
void to_json(nlohmann::json& j, const SampleRegion::Syllable& s);
void from_json(const nlohmann::json& j, SampleRegion::Syllable& s);

// JSON serialization for SampleRegion
void to_json(nlohmann::json& j, const SampleRegion& r);
void from_json(const nlohmann::json& j, SampleRegion& r);
