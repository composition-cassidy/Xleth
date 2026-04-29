#include "midi/MidiImporter.h"

#include "midi/GMDrumMap.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace
{
using json = nlohmann::json;

constexpr int      kDefaultTempoBpm  = 120;
constexpr int      kBytesPerNote     = 12;
constexpr int      kDrumChannel      = 10;
constexpr uint32_t kMaxPackedTick    = std::numeric_limits<uint32_t>::max();

struct LoadedMidiFile {
    juce::File     file;
    juce::MidiFile midiFile;
    int            fileType  = -1;
    int            tpq       = 0;
    int64_t        fileSize  = 0;
};

struct TempoInfo {
    double sourceBpm                 = kDefaultTempoBpm;
    int    tempoEventCount           = 0;
    bool   hasMidFileTempoChanges    = false;
};

struct TrackScan {
    int              index         = 0;
    std::string      name;
    int              noteCount     = 0;
    std::vector<int> channelsUsed;
    bool             isDrum        = false;
    bool             hasPitchBend  = false;
    std::vector<int> uniqueNotes;
};

struct ImportTrackOptions {
    bool             splitDrums = false;
    std::vector<int> enabledSubNotes;
};

struct ImportOptions {
    std::unordered_set<int>                 enabledTrackIndices;
    std::unordered_map<int, ImportTrackOptions> perTrackOptions;
    bool                                    tempoOverride = false;
    int                                     projectTPQ    = 0;
    double                                  projectBPM    = 0.0;
};

struct OutputTrackMetadata {
    std::string       name;
    int               sourceTrackIndex = 0;
    bool              isDrumSubTrack   = false;
    std::optional<int> drumPitch;
    int               noteCount        = 0;
};

struct TrackRouting {
    bool                           splitDrums         = false;
    std::optional<uint8_t>         defaultOutputIndex;
    std::unordered_map<int, uint8_t> drumOutputIndices;
};

struct PackedNote {
    uint32_t tick             = 0;
    uint32_t duration         = 0;
    uint8_t  noteNumber       = 0;
    uint8_t  velocity         = 0;
    uint8_t  outputTrackIndex = 0;
    uint8_t  flags            = 0;
};

#ifdef XLETH_DEBUG
void debugLog(const char* format, ...)
{
    std::fprintf(stderr, "[MidiImport] ");

    va_list args;
    va_start(args, format);
    std::vfprintf(stderr, format, args);
    va_end(args);

    std::fprintf(stderr, "\n");
    std::fflush(stderr);
}
#else
void debugLog(const char*, ...) {}
#endif

std::string makeErrorJson(const std::string& reason)
{
    return json{
        {"ok", false},
        {"reason", reason}
    }.dump();
}

std::string makeDefaultTrackName(int trackIndex)
{
    return "Track " + std::to_string(trackIndex + 1);
}

std::string getTrackName(const juce::MidiMessageSequence& track, int trackIndex)
{
    for (const auto* event : track) {
        if (event != nullptr && event->message.isTrackNameEvent()) {
            const auto name = event->message.getTextFromTextMetaEvent().toStdString();
            if (!name.empty()) {
                return name;
            }
        }
    }

    return makeDefaultTrackName(trackIndex);
}

bool readValidatedMidiFile(const std::string& filePath,
                           LoadedMidiFile& loaded,
                           std::string& reason)
{
    if (filePath.empty()) {
        reason = "MIDI file path is empty.";
        debugLog("reject reason=\"%s\"", reason.c_str());
        return false;
    }

    loaded.file = juce::File(juce::String::fromUTF8(filePath.c_str()));

    if (!loaded.file.existsAsFile()) {
        reason = "MIDI file not found.";
        debugLog("reject reason=\"%s\" path=\"%s\"", reason.c_str(), filePath.c_str());
        return false;
    }

    loaded.fileSize = loaded.file.getSize();

    juce::FileInputStream stream(loaded.file);
    if (!stream.openedOk()) {
        reason = "Could not open MIDI file.";
        debugLog("reject reason=\"%s\" path=\"%s\"", reason.c_str(), filePath.c_str());
        return false;
    }

    if (!loaded.midiFile.readFrom(stream, true, &loaded.fileType)) {
        reason = "Failed to read MIDI file.";
        debugLog("reject reason=\"%s\" path=\"%s\"", reason.c_str(), filePath.c_str());
        return false;
    }

    if (loaded.midiFile.getTimeFormat() < 0) {
        reason = "SMPTE time format MIDI files are not supported.";
        debugLog("reject reason=\"%s\" path=\"%s\"", reason.c_str(), filePath.c_str());
        return false;
    }

    if (loaded.fileType == 2) {
        reason = "Type 2 MIDI files are not supported.";
        debugLog("reject reason=\"%s\" path=\"%s\"", reason.c_str(), filePath.c_str());
        return false;
    }

    loaded.tpq = loaded.midiFile.getTimeFormat();

    if (loaded.tpq <= 0) {
        reason = "MIDI file has an invalid ticks-per-quarter-note value.";
        debugLog("reject reason=\"%s\" path=\"%s\"", reason.c_str(), filePath.c_str());
        return false;
    }

    return true;
}

TempoInfo buildTempoInfo(const juce::MidiFile& midiFile)
{
    juce::MidiMessageSequence tempoEvents;
    midiFile.findAllTempoEvents(tempoEvents);

    TempoInfo info;
    info.tempoEventCount        = tempoEvents.getNumEvents();
    info.hasMidFileTempoChanges = info.tempoEventCount > 1;

    if (info.tempoEventCount > 0) {
        const auto secondsPerQuarter =
            tempoEvents.getEventPointer(0)->message.getTempoSecondsPerQuarterNote();

        if (secondsPerQuarter > 0.0) {
            info.sourceBpm = 60.0 / secondsPerQuarter;
        }
    }

    return info;
}

TrackScan scanTrack(const juce::MidiMessageSequence& track, int trackIndex)
{
    TrackScan scan;
    scan.index = trackIndex;
    scan.name  = getTrackName(track, trackIndex);

    std::set<int> channelsUsed;
    std::set<int> uniqueNotes;

    for (const auto* event : track) {
        if (event == nullptr) {
            continue;
        }

        const auto& message = event->message;

        if (message.isNoteOn()) {
            ++scan.noteCount;
            channelsUsed.insert(message.getChannel());
            uniqueNotes.insert(message.getNoteNumber());

            if (message.getChannel() == kDrumChannel) {
                scan.isDrum = true;
            }
        } else if (message.isPitchWheel()) {
            scan.hasPitchBend = true;
        }
    }

    scan.channelsUsed.assign(channelsUsed.begin(), channelsUsed.end());
    scan.uniqueNotes.assign(uniqueNotes.begin(), uniqueNotes.end());
    return scan;
}

bool parseTrackIndexKey(const std::string& key, int& outIndex)
{
    try {
        size_t consumed = 0;
        const int value = std::stoi(key, &consumed);
        if (consumed != key.size()) {
            return false;
        }

        outIndex = value;
        return true;
    } catch (...) {
        return false;
    }
}

bool parseImportOptions(const std::string& optionsJson,
                        ImportOptions& options,
                        std::string& reason)
{
    const auto parsed = json::parse(optionsJson, nullptr, false);

    if (parsed.is_discarded() || !parsed.is_object()) {
        reason = "Import options JSON is invalid.";
        debugLog("reject reason=\"%s\"", reason.c_str());
        return false;
    }

    if (parsed.contains("enabledTrackIndices")) {
        const auto& enabledTrackIndices = parsed["enabledTrackIndices"];
        if (!enabledTrackIndices.is_array()) {
            reason = "enabledTrackIndices must be an array.";
            debugLog("reject reason=\"%s\"", reason.c_str());
            return false;
        }

        for (const auto& value : enabledTrackIndices) {
            if (!value.is_number_integer()) {
                reason = "enabledTrackIndices must contain integers.";
                debugLog("reject reason=\"%s\"", reason.c_str());
                return false;
            }

            options.enabledTrackIndices.insert(value.get<int>());
        }
    }

    if (parsed.contains("perTrackOptions")) {
        const auto& perTrackOptions = parsed["perTrackOptions"];
        if (!perTrackOptions.is_object()) {
            reason = "perTrackOptions must be an object.";
            debugLog("reject reason=\"%s\"", reason.c_str());
            return false;
        }

        for (const auto& [key, value] : perTrackOptions.items()) {
            int trackIndex = 0;
            if (!parseTrackIndexKey(key, trackIndex)) {
                reason = "perTrackOptions keys must be integer track indices.";
                debugLog("reject reason=\"%s\"", reason.c_str());
                return false;
            }

            if (!value.is_object()) {
                reason = "Each perTrackOptions entry must be an object.";
                debugLog("reject reason=\"%s\"", reason.c_str());
                return false;
            }

            ImportTrackOptions trackOptions;

            if (value.contains("splitDrums")) {
                if (!value["splitDrums"].is_boolean()) {
                    reason = "splitDrums must be a boolean.";
                    debugLog("reject reason=\"%s\"", reason.c_str());
                    return false;
                }

                trackOptions.splitDrums = value["splitDrums"].get<bool>();
            }

            if (value.contains("enabledSubNotes")) {
                const auto& enabledSubNotes = value["enabledSubNotes"];
                if (!enabledSubNotes.is_array()) {
                    reason = "enabledSubNotes must be an array.";
                    debugLog("reject reason=\"%s\"", reason.c_str());
                    return false;
                }

                std::unordered_set<int> seenNotes;
                for (const auto& noteValue : enabledSubNotes) {
                    if (!noteValue.is_number_integer()) {
                        reason = "enabledSubNotes must contain integers.";
                        debugLog("reject reason=\"%s\"", reason.c_str());
                        return false;
                    }

                    const int noteNumber = noteValue.get<int>();
                    if (noteNumber < 0 || noteNumber > 127) {
                        reason = "enabledSubNotes values must be between 0 and 127.";
                        debugLog("reject reason=\"%s\"", reason.c_str());
                        return false;
                    }

                    if (seenNotes.insert(noteNumber).second) {
                        trackOptions.enabledSubNotes.push_back(noteNumber);
                    }
                }
            }

            options.perTrackOptions[trackIndex] = std::move(trackOptions);
        }
    }

    if (parsed.contains("tempoOverride") && !parsed["tempoOverride"].is_boolean()) {
        reason = "tempoOverride must be a boolean.";
        debugLog("reject reason=\"%s\"", reason.c_str());
        return false;
    }

    options.tempoOverride = parsed.value("tempoOverride", false);

    if (!parsed.contains("projectTPQ") || !parsed["projectTPQ"].is_number_integer()) {
        reason = "projectTPQ must be an integer.";
        debugLog("reject reason=\"%s\"", reason.c_str());
        return false;
    }

    options.projectTPQ = parsed["projectTPQ"].get<int>();
    if (options.projectTPQ <= 0) {
        reason = "projectTPQ must be greater than zero.";
        debugLog("reject reason=\"%s\"", reason.c_str());
        return false;
    }

    if (parsed.contains("projectBPM") && !parsed["projectBPM"].is_number()) {
        reason = "projectBPM must be a number.";
        debugLog("reject reason=\"%s\"", reason.c_str());
        return false;
    }

    options.projectBPM = parsed.value("projectBPM", 0.0);
    if (!options.tempoOverride && options.projectBPM <= 0.0) {
        reason = "projectBPM must be greater than zero when tempoOverride is false.";
        debugLog("reject reason=\"%s\"", reason.c_str());
        return false;
    }

    return true;
}

bool validateEnabledTrackIndices(const ImportOptions& options,
                                 int midiTrackCount,
                                 std::string& reason)
{
    for (const int trackIndex : options.enabledTrackIndices) {
        if (trackIndex < 0 || trackIndex >= midiTrackCount) {
            reason = "enabledTrackIndices contains an out-of-range track index.";
            debugLog("reject reason=\"%s\" trackIndex=%d", reason.c_str(), trackIndex);
            return false;
        }
    }

    for (const auto& [trackIndex, _] : options.perTrackOptions) {
        if (trackIndex < 0 || trackIndex >= midiTrackCount) {
            reason = "perTrackOptions contains an out-of-range track index.";
            debugLog("reject reason=\"%s\" trackIndex=%d", reason.c_str(), trackIndex);
            return false;
        }
    }

    return true;
}

std::optional<uint32_t> scaleTicks(double ticks, double tickScale)
{
    const double scaled = ticks * tickScale;
    if (scaled < 0.0) {
        return std::nullopt;
    }

    const double rounded = std::llround(scaled);
    if (rounded < 0.0 || rounded > static_cast<double>(kMaxPackedTick)) {
        return std::nullopt;
    }

    return static_cast<uint32_t>(rounded);
}

std::string makeDrumOutputTrackName(int noteNumber)
{
    if (const char* name = gmDrumName(noteNumber)) {
        return name;
    }

    return "Note " + std::to_string(noteNumber);
}

bool buildOutputTrackRouting(const juce::MidiFile& midiFile,
                             const ImportOptions& options,
                             std::vector<OutputTrackMetadata>& outputTracks,
                             std::unordered_map<int, TrackRouting>& routingByTrack,
                             std::string& reason)
{
    outputTracks.clear();
    routingByTrack.clear();

    for (int trackIndex = 0; trackIndex < midiFile.getNumTracks(); ++trackIndex) {
        if (options.enabledTrackIndices.find(trackIndex) == options.enabledTrackIndices.end()) {
            continue;
        }

        const auto* track = midiFile.getTrack(trackIndex);
        if (track == nullptr) {
            continue;
        }

        const auto name = getTrackName(*track, trackIndex);
        const auto optionsIt = options.perTrackOptions.find(trackIndex);
        const ImportTrackOptions* trackOptions =
            optionsIt != options.perTrackOptions.end() ? &optionsIt->second : nullptr;

        TrackRouting routing;
        routing.splitDrums = trackOptions != nullptr && trackOptions->splitDrums;

        if (routing.splitDrums) {
            if (trackOptions != nullptr) {
                for (const int noteNumber : trackOptions->enabledSubNotes) {
                    if (outputTracks.size() >= std::numeric_limits<uint8_t>::max() + 1u) {
                        reason = "Import would create more than 255 output tracks.";
                        debugLog("reject reason=\"%s\"", reason.c_str());
                        return false;
                    }

                    const auto outputTrackIndex = static_cast<uint8_t>(outputTracks.size());
                    outputTracks.push_back(OutputTrackMetadata{
                        makeDrumOutputTrackName(noteNumber),
                        trackIndex,
                        true,
                        noteNumber,
                        0
                    });
                    routing.drumOutputIndices[noteNumber] = outputTrackIndex;
                }
            }
        } else {
            if (outputTracks.size() >= std::numeric_limits<uint8_t>::max() + 1u) {
                reason = "Import would create more than 255 output tracks.";
                debugLog("reject reason=\"%s\"", reason.c_str());
                return false;
            }

            const auto outputTrackIndex = static_cast<uint8_t>(outputTracks.size());
            outputTracks.push_back(OutputTrackMetadata{
                name,
                trackIndex,
                false,
                std::nullopt,
                0
            });
            routing.defaultOutputIndex = outputTrackIndex;
        }

        routingByTrack[trackIndex] = std::move(routing);
    }

    return true;
}

void writeUint32LittleEndian(uint8_t* destination, uint32_t value)
{
    destination[0] = static_cast<uint8_t>(value & 0xffu);
    destination[1] = static_cast<uint8_t>((value >> 8u) & 0xffu);
    destination[2] = static_cast<uint8_t>((value >> 16u) & 0xffu);
    destination[3] = static_cast<uint8_t>((value >> 24u) & 0xffu);
}

} // namespace

std::string MidiImporter::parseSummary(const std::string& filePath)
{
    LoadedMidiFile loaded;
    std::string    reason;

    if (!readValidatedMidiFile(filePath, loaded, reason)) {
        return makeErrorJson(reason);
    }

    const TempoInfo tempoInfo = buildTempoInfo(loaded.midiFile);

    json tracksJson = json::array();
    int  totalNoteCount = 0;

    for (int trackIndex = 0; trackIndex < loaded.midiFile.getNumTracks(); ++trackIndex) {
        const auto* track = loaded.midiFile.getTrack(trackIndex);
        if (track == nullptr) {
            continue;
        }

        const TrackScan scan = scanTrack(*track, trackIndex);
        if (scan.noteCount <= 0) {
            continue;
        }

        totalNoteCount += scan.noteCount;

        tracksJson.push_back(json{
            {"index", trackIndex},
            {"name", scan.name},
            {"noteCount", scan.noteCount},
            {"channelsUsed", scan.channelsUsed},
            {"isDrum", scan.isDrum},
            {"hasPitchBend", scan.hasPitchBend},
            {"uniqueNoteNumbers", scan.uniqueNotes}
        });

        debugLog("track index=%d name=\"%s\" noteCount=%d isDrum=%d hasPitchBend=%d",
                 trackIndex,
                 scan.name.c_str(),
                 scan.noteCount,
                 scan.isDrum ? 1 : 0,
                 scan.hasPitchBend ? 1 : 0);
    }

    debugLog("summary fileSize=%lld fileType=%d tpq=%d trackCount=%d sourceTempo=%.6f hasMidFileTempoChanges=%d totalNoteCount=%d",
             static_cast<long long>(loaded.fileSize),
             loaded.fileType,
             loaded.tpq,
             loaded.midiFile.getNumTracks(),
             tempoInfo.sourceBpm,
             tempoInfo.hasMidFileTempoChanges ? 1 : 0,
             totalNoteCount);

    return json{
        {"ok", true},
        {"fileType", loaded.fileType},
        {"tpq", loaded.tpq},
        {"sourceTempo", tempoInfo.sourceBpm},
        {"hasMidFileTempoChanges", tempoInfo.hasMidFileTempoChanges},
        {"tracks", tracksJson}
    }.dump();
}

MidiImportFullResult MidiImporter::importFull(const std::string& filePath,
                                              const std::string& optionsJson)
{
    MidiImportFullResult result;

    LoadedMidiFile loaded;
    std::string    reason;

    if (!readValidatedMidiFile(filePath, loaded, reason)) {
        result.metadataJson = makeErrorJson(reason);
        return result;
    }

    ImportOptions options;
    if (!parseImportOptions(optionsJson, options, reason)) {
        result.metadataJson = makeErrorJson(reason);
        return result;
    }

    if (!validateEnabledTrackIndices(options, loaded.midiFile.getNumTracks(), reason)) {
        result.metadataJson = makeErrorJson(reason);
        return result;
    }

    const TempoInfo tempoInfo = buildTempoInfo(loaded.midiFile);

    std::vector<OutputTrackMetadata>       outputTracks;
    std::unordered_map<int, TrackRouting>  routingByTrack;
    if (!buildOutputTrackRouting(loaded.midiFile, options, outputTracks, routingByTrack, reason)) {
        result.metadataJson = makeErrorJson(reason);
        return result;
    }

    double tickScale = static_cast<double>(options.projectTPQ)
                     / static_cast<double>(loaded.tpq);

    if (!options.tempoOverride) {
        tickScale *= (tempoInfo.sourceBpm / options.projectBPM);
    }

    std::vector<PackedNote> packedNotes;
    size_t estimatedNoteCount = 0;

    for (int trackIndex = 0; trackIndex < loaded.midiFile.getNumTracks(); ++trackIndex) {
        if (options.enabledTrackIndices.find(trackIndex) == options.enabledTrackIndices.end()) {
            continue;
        }

        const auto* track = loaded.midiFile.getTrack(trackIndex);
        if (track == nullptr) {
            continue;
        }

        const TrackScan scan = scanTrack(*track, trackIndex);
        estimatedNoteCount += static_cast<size_t>(std::max(scan.noteCount, 0));

        debugLog("track index=%d name=\"%s\" noteCount=%d isDrum=%d hasPitchBend=%d",
                 trackIndex,
                 scan.name.c_str(),
                 scan.noteCount,
                 scan.isDrum ? 1 : 0,
                 scan.hasPitchBend ? 1 : 0);
    }

    packedNotes.reserve(estimatedNoteCount);

    for (int trackIndex = 0; trackIndex < loaded.midiFile.getNumTracks(); ++trackIndex) {
        if (options.enabledTrackIndices.find(trackIndex) == options.enabledTrackIndices.end()) {
            continue;
        }

        const auto* track = loaded.midiFile.getTrack(trackIndex);
        if (track == nullptr) {
            continue;
        }

        const auto routingIt = routingByTrack.find(trackIndex);
        if (routingIt == routingByTrack.end()) {
            continue;
        }

        const TrackRouting& routing = routingIt->second;

        for (const auto* event : *track) {
            if (event == nullptr || !event->message.isNoteOn()) {
                continue;
            }

            const auto& message = event->message;
            const int noteNumber = message.getNoteNumber();

            std::optional<uint8_t> outputTrackIndex;
            if (routing.splitDrums) {
                const auto outputIt = routing.drumOutputIndices.find(noteNumber);
                if (outputIt == routing.drumOutputIndices.end()) {
                    continue;
                }

                outputTrackIndex = outputIt->second;
            } else {
                outputTrackIndex = routing.defaultOutputIndex;
            }

            if (!outputTrackIndex.has_value()) {
                continue;
            }

            const double startTick = message.getTimeStamp();
            double endTick = startTick;

            if (event->noteOffObject != nullptr) {
                endTick = event->noteOffObject->message.getTimeStamp();
            } else {
                endTick = startTick + static_cast<double>(loaded.tpq);
                debugLog("orphaned note-on track=%d channel=%d note=%d startTick=%.0f defaultDurationTicks=%d",
                         trackIndex,
                         message.getChannel(),
                         noteNumber,
                         startTick,
                         loaded.tpq);
            }

            const double durationTicks = std::max(0.0, endTick - startTick);

            const auto scaledTick = scaleTicks(startTick, tickScale);
            const auto scaledDuration = scaleTicks(durationTicks, tickScale);

            if (!scaledTick.has_value() || !scaledDuration.has_value()) {
                reason = "Imported note timing exceeds the packed uint32 range.";
                debugLog("reject reason=\"%s\" track=%d note=%d startTick=%.6f durationTicks=%.6f",
                         reason.c_str(),
                         trackIndex,
                         noteNumber,
                         startTick,
                         durationTicks);
                result.metadataJson = makeErrorJson(reason);
                result.notes.setSize(0);
                return result;
            }

            packedNotes.push_back(PackedNote{
                *scaledTick,
                *scaledDuration,
                static_cast<uint8_t>(noteNumber),
                static_cast<uint8_t>(message.getVelocity()),
                *outputTrackIndex,
                static_cast<uint8_t>(message.getChannel() == kDrumChannel ? 0x01 : 0x00)
            });

            ++outputTracks[*outputTrackIndex].noteCount;
        }
    }

    result.notes.setSize(packedNotes.size() * static_cast<size_t>(kBytesPerNote), false);
    auto* destination = static_cast<uint8_t*>(result.notes.getData());

    for (const auto& note : packedNotes) {
        writeUint32LittleEndian(destination + 0, note.tick);
        writeUint32LittleEndian(destination + 4, note.duration);
        destination[8]  = note.noteNumber;
        destination[9]  = note.velocity;
        destination[10] = note.outputTrackIndex;
        destination[11] = note.flags;
        destination += kBytesPerNote;
    }

    json outputTracksJson = json::array();
    for (const auto& outputTrack : outputTracks) {
        json entry{
            {"name", outputTrack.name},
            {"sourceTrackIndex", outputTrack.sourceTrackIndex},
            {"isDrumSubTrack", outputTrack.isDrumSubTrack},
            {"drumPitch", outputTrack.drumPitch.has_value()
                ? json(*outputTrack.drumPitch)
                : json(nullptr)},
            {"noteCount", outputTrack.noteCount}
        };
        outputTracksJson.push_back(std::move(entry));
    }

    result.metadataJson = json{
        {"outputTracks", outputTracksJson},
        {"noteCount", packedNotes.size()},
        {"bytesPerNote", kBytesPerNote}
    }.dump();

    debugLog("import fileSize=%lld fileType=%d tpq=%d trackCount=%d sourceTempo=%.6f hasMidFileTempoChanges=%d totalNoteCount=%d",
             static_cast<long long>(loaded.fileSize),
             loaded.fileType,
             loaded.tpq,
             loaded.midiFile.getNumTracks(),
             tempoInfo.sourceBpm,
             tempoInfo.hasMidFileTempoChanges ? 1 : 0,
             static_cast<int>(packedNotes.size()));

    return result;
}
