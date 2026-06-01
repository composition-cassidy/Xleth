#pragma once

#include <nlohmann/json.hpp>

#include <string>

namespace juce { class AudioProcessor; }

// ─── GraphEffectParameters ──────────────────────────────────────────────────
// FXG.4-a: unified, graph-owned parameter descriptor layer.
//
// One descriptor shape covers BOTH parameter sources:
//   • Stock Xleth effects  — enumerated from the effect's own APVTS, the single
//     source of truth for ranges/defaults (no duplicated parameter definitions).
//   • Third-party plugins  — enumerated from the hosted AudioProcessor's
//     host-facing parameters (juce::AudioProcessorParameter). Parameters are
//     ASKED of the processor, never scraped from a native editor UI.
//
// All values are host-facing NORMALIZED floats in [0.0, 1.0]. A stable string
// parameterId is preferred (APVTS paramID for stock, HostedParameter id for
// plugins); when no stable id is available a "#<index>" fallback is emitted and
// flagged with parameterIdIsFallback so later automation can target the most
// stable identity available.
//
// These are pure helpers — main-thread only, no engine state. The caller
// resolves the parameter owner (the stock effect itself, or the inner plugin
// processor) and is responsible for wrapping plugin calls in the SEH guard.

namespace xleth::audio {

// Builds a JSON array of normalized parameter descriptors for every host-facing
// parameter exposed by `paramOwner`. `isStock` selects the stable-id strategy
// and the automatable default. Never throws; returns an empty array if the
// owner exposes no parameters.
nlohmann::json buildGraphEffectParameterDescriptors(juce::AudioProcessor& paramOwner,
                                                     bool isStock);

// Resolves `parameterId` (a stable id, or a "#<index>"/"<index>" fallback) to a
// 0-based parameter index within `paramOwner`. Returns -1 when unresolved.
int resolveGraphEffectParameterIndex(juce::AudioProcessor& paramOwner,
                                     const std::string& parameterId,
                                     bool isStock);

} // namespace xleth::audio
