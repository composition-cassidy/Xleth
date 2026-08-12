#pragma once
#include "TimelineTypes.h"
#include "SamplerModulationJson.h"
#include <nlohmann/json.hpp>

// JSON serialization for SampleRegion::Syllable
void to_json(nlohmann::json& j, const SampleRegion::Syllable& s);
void from_json(const nlohmann::json& j, SampleRegion::Syllable& s);

// JSON serialization for SampleSlot (one sampler layer)
void to_json(nlohmann::json& j, const SampleSlot& s);
void from_json(const nlohmann::json& j, SampleSlot& s);

// JSON serialization for SampleRegion
void to_json(nlohmann::json& j, const SampleRegion& r);
void from_json(const nlohmann::json& j, SampleRegion& r);
