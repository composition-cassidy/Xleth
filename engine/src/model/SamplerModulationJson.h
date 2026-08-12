#pragma once

#include "SamplerModulationConfig.h"

#include <nlohmann/json.hpp>

// ─── JSON for the sampler modulation config ──────────────────────────────────
// Declared in the same namespace as the types so ADL finds them from
// nlohmann's generic get<>/= paths, and kept out of SamplerModulationConfig.h
// so the audio layer can include the config without pulling in nlohmann.
//
// ── Compatibility rules ──────────────────────────────────────────────────────
// Every reader is TOLERANT: a missing key keeps the default. That is what lets
// a project written before this system existed load with an empty route list —
// an exact bypass — and what lets a later phase add a field without a second
// schema bump. Enum-valued fields (segment, behavior, target, noteValue) are
// persisted BY INDEX and range-checked on read, so an unknown value from a
// newer build degrades to the default instead of indexing off the end.

namespace xleth::sampmod {

void to_json(nlohmann::json& j, const ModTime& t);
void from_json(const nlohmann::json& j, ModTime& t);

void to_json(nlohmann::json& j, const ModEnvConfig& c);
void from_json(const nlohmann::json& j, ModEnvConfig& c);

void to_json(nlohmann::json& j, const LfoPoint& p);
void from_json(const nlohmann::json& j, LfoPoint& p);

void to_json(nlohmann::json& j, const ModLfoConfig& c);
void from_json(const nlohmann::json& j, ModLfoConfig& c);

void to_json(nlohmann::json& j, const CurvePoint& p);
void from_json(const nlohmann::json& j, CurvePoint& p);

void to_json(nlohmann::json& j, const ModCurveConfig& c);
void from_json(const nlohmann::json& j, ModCurveConfig& c);

void to_json(nlohmann::json& j, const ModRoute& r);
void from_json(const nlohmann::json& j, ModRoute& r);

void to_json(nlohmann::json& j, const ModConfig& c);
void from_json(const nlohmann::json& j, ModConfig& c);

} // namespace xleth::sampmod
