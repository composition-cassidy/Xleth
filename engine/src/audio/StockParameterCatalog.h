#pragma once

#include <string>
#include <vector>

class XlethEffectBase;

namespace xleth::audio {

// One catalog entry describes a single user-exposable parameter on a stock
// effect.  Labels, grouping, unit, and scale are curated per plugin so the
// renderer can render a clean modulation-target list; numeric range/default
// fields are filled in at runtime from the effect's APVTS so they stay in
// sync with the effect's actual parameter layout.
struct StockParameterEntry
{
    std::string paramId;
    std::string label;
    std::string compactLabel;     // empty → caller falls back to label
    std::string group;
    float       min          = 0.0f;
    float       max          = 1.0f;
    float       defaultValue = 0.0f;
    std::string unit;
    std::string scale;            // "linear" | "log" | empty (treated as linear)
};

// Returns the public, modulation-targetable parameters for an effect instance.
// Unknown pluginIds fall back to a generic APVTS enumeration.
std::vector<StockParameterEntry> availableStockParameterTargets(
    const std::string& pluginId, XlethEffectBase& effect);

}
