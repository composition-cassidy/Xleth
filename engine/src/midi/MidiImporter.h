#pragma once

#include <juce_core/juce_core.h>

#include <string>

struct MidiImportFullResult {
    std::string       metadataJson;
    juce::MemoryBlock notes;
};

class MidiImporter
{
public:
    static std::string parseSummary(const std::string& filePath);
    static MidiImportFullResult importFull(const std::string& filePath,
                                           const std::string& optionsJson);
};
