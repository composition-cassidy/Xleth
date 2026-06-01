#include "audio/GraphEffectParameters.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <algorithm>
#include <cstdlib>

namespace xleth::audio {

namespace {

// Returns the stable host-facing id for a parameter, or empty if none exists.
//   • stock  : APVTS paramID (RangedAudioParameter → AudioProcessorParameterWithID)
//   • plugin : AudioPluginInstance::HostedParameter::getParameterID(), with a
//              fallback to AudioProcessorParameterWithID::paramID.
std::string stableParameterId(juce::AudioProcessorParameter& param, bool isStock)
{
    if (isStock)
    {
        if (auto* withId = dynamic_cast<juce::AudioProcessorParameterWithID*>(&param))
            return withId->paramID.toStdString();
        return {};
    }

    if (auto* hosted = dynamic_cast<juce::AudioPluginInstance::HostedParameter*>(&param))
    {
        const auto id = hosted->getParameterID();
        if (id.isNotEmpty())
            return id.toStdString();
    }
    if (auto* withId = dynamic_cast<juce::AudioProcessorParameterWithID*>(&param))
        return withId->paramID.toStdString();
    return {};
}

bool parseIndexToken(const std::string& text, int& out)
{
    const char* begin = text.c_str();
    if (*begin == '#')
        ++begin;
    char* end = nullptr;
    const long parsed = std::strtol(begin, &end, 10);
    if (begin == end || *end != '\0')
        return false;
    out = static_cast<int>(parsed);
    return true;
}

} // namespace

nlohmann::json buildGraphEffectParameterDescriptors(juce::AudioProcessor& paramOwner, bool isStock)
{
    nlohmann::json arr = nlohmann::json::array();

    const auto& params = paramOwner.getParameters();
    for (int index = 0; index < params.size(); ++index)
    {
        auto* param = params[index];
        if (param == nullptr)
            continue;

        nlohmann::json d;

        const std::string stableId = stableParameterId(*param, isStock);
        const bool isFallback = stableId.empty();
        d["parameterId"]           = isFallback ? ("#" + std::to_string(index)) : stableId;
        d["parameterIndex"]        = index;
        d["parameterIdIsFallback"] = isFallback;

        d["name"] = param->getName(256).toStdString();
        d["unit"] = param->getLabel().toStdString();

        // Host-facing normalized [0, 1] value & default.
        d["normalizedValue"]        = param->getValue();
        d["defaultNormalizedValue"] = param->getDefaultValue();

        d["automatable"] = param->isAutomatable();
        // JUCE's generic parameter API does not expose a reliable read-only flag
        // for hosted plugins, so read-only is reported only when we positively
        // know it (none today). Non-automatable params surface via automatable.
        d["readOnly"]    = false;
        d["discrete"]    = param->isDiscrete();
        d["boolean"]     = param->isBoolean();
        d["numSteps"]    = param->getNumSteps();

        d["displayValue"] = param->getCurrentValueAsText().toStdString();

        arr.push_back(std::move(d));
    }

    return arr;
}

int resolveGraphEffectParameterIndex(juce::AudioProcessor& paramOwner,
                                     const std::string& parameterId,
                                     bool isStock)
{
    const auto& params = paramOwner.getParameters();
    if (params.isEmpty())
        return -1;

    // 1) Stable id match (preferred long-term automation identity).
    if (!parameterId.empty() && parameterId.front() != '#')
    {
        for (int index = 0; index < params.size(); ++index)
        {
            auto* param = params[index];
            if (param == nullptr)
                continue;
            if (stableParameterId(*param, isStock) == parameterId)
                return index;
        }
    }

    // 2) "#<index>" / "<index>" numeric fallback.
    int parsedIndex = -1;
    if (parseIndexToken(parameterId, parsedIndex)
        && parsedIndex >= 0
        && parsedIndex < params.size())
    {
        return parsedIndex;
    }

    // 3) Display-name match (last resort).
    const juce::String wanted(parameterId);
    for (int index = 0; index < params.size(); ++index)
    {
        auto* param = params[index];
        if (param != nullptr && param->getName(256) == wanted)
            return index;
    }

    return -1;
}

} // namespace xleth::audio
