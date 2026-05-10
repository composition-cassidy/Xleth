// test_midi_importer.cpp - smoke and regression tests for MidiImporter.
// Build: see engine/CMakeLists.txt target "test_midi_importer"
// Run:   test_midi_importer.exe

#include "midi/MidiImporter.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <cmath>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <vector>

namespace fs = std::filesystem;
using json   = nlohmann::json;

namespace
{
constexpr int kDrumChannel = 10;
constexpr int kBytesPerPackedNote = 12;

struct DecodedNote {
    uint32_t tick = 0;
    uint32_t duration = 0;
    uint8_t noteNumber = 0;
    uint8_t velocity = 0;
    uint8_t outputTrackIndex = 0;
    uint8_t flags = 0;
};

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (cond) {                                                            \
            ++g_passed;                                                        \
        } else {                                                               \
            std::cerr << "  FAIL [line " << __LINE__ << "] " << msg << "\n"; \
            ++g_failed;                                                        \
        }                                                                      \
    } while (0)

#define REQUIRE(cond, msg)                                                     \
    do {                                                                       \
        if (!(cond)) {                                                         \
            std::cerr << "FAILED: " << msg << "\n";                           \
            cleanup();                                                         \
            return 1;                                                          \
        }                                                                      \
    } while (0)

std::vector<DecodedNote> decodePackedNotes(const juce::MemoryBlock& notes)
{
    std::vector<DecodedNote> decoded;
    const auto size = notes.getSize();
    if ((size % kBytesPerPackedNote) != 0u) {
        return decoded;
    }

    decoded.reserve(size / kBytesPerPackedNote);
    const auto* bytes = static_cast<const uint8_t*>(notes.getData());
    for (size_t i = 0; i < size; i += kBytesPerPackedNote) {
        auto readU32LE = [](const uint8_t* p) -> uint32_t {
            return  static_cast<uint32_t>(p[0])
                 | (static_cast<uint32_t>(p[1]) << 8)
                 | (static_cast<uint32_t>(p[2]) << 16)
                 | (static_cast<uint32_t>(p[3]) << 24);
        };

        decoded.push_back(DecodedNote{
            readU32LE(bytes + i + 0),
            readU32LE(bytes + i + 4),
            bytes[i + 8],
            bytes[i + 9],
            bytes[i + 10],
            bytes[i + 11],
        });
    }

    return decoded;
}

json makeImportOptions(int trackIndex, uint32_t maxNoteLengthTicks)
{
    return json{
        {"enabledTrackIndices", json::array({trackIndex})},
        {"perTrackOptions", {
            {std::to_string(trackIndex), {
                {"splitDrums", false},
                {"enabledSubNotes", json::array()}
            }}
        }},
        {"tempoOverride", true},
        {"projectTPQ", 960},
        {"projectBPM", 120.0},
        {"maxNoteLengthByOutputTrack", json::array({maxNoteLengthTicks})}
    };
}

void writeSummaryFixture(const fs::path& midiPath)
{
    juce::MidiFile midiFile;
    midiFile.setTicksPerQuarterNote(480);

    juce::MidiMessageSequence tempoTrack;
    tempoTrack.addEvent(juce::MidiMessage::textMetaEvent(3, "Conductor"), 0.0);
    tempoTrack.addEvent(juce::MidiMessage::tempoMetaEvent(600000), 0.0); // 100 BPM
    tempoTrack.addEvent(juce::MidiMessage::endOfTrack(), 960.0);
    tempoTrack.sort();

    juce::MidiMessageSequence drumTrack;
    drumTrack.addEvent(juce::MidiMessage::textMetaEvent(3, "Drums"), 0.0);
    drumTrack.addEvent(juce::MidiMessage::pitchWheel(kDrumChannel, 8192), 120.0);
    drumTrack.addEvent(juce::MidiMessage::noteOn(kDrumChannel, 36, static_cast<juce::uint8>(100)), 0.0);
    drumTrack.addEvent(juce::MidiMessage::noteOff(kDrumChannel, 36), 240.0);
    drumTrack.addEvent(juce::MidiMessage::endOfTrack(), 480.0);
    drumTrack.sort();

    midiFile.addTrack(tempoTrack);
    midiFile.addTrack(drumTrack);

    juce::File juceMidiFile(juce::String::fromUTF8(midiPath.string().c_str()));
    juce::FileOutputStream stream(juceMidiFile);
    if (!stream.openedOk()) {
        throw std::runtime_error("Could not open summary fixture MIDI file for writing");
    }
    if (!midiFile.writeTo(stream, 1)) {
        throw std::runtime_error("Failed to write summary fixture MIDI file");
    }
    stream.flush();
}

void writeClampFixture(const fs::path& midiPath)
{
    juce::MidiFile midiFile;
    midiFile.setTicksPerQuarterNote(480);

    juce::MidiMessageSequence track;
    track.addEvent(juce::MidiMessage::textMetaEvent(3, "Clamp Track"), 0.0);
    track.addEvent(juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(100)), 0.0);
    track.addEvent(juce::MidiMessage::noteOff(1, 60), 960.0);   // scales to 1920 ticks
    track.addEvent(juce::MidiMessage::noteOn(1, 62, static_cast<juce::uint8>(90)), 1200.0);
    track.addEvent(juce::MidiMessage::noteOff(1, 62), 1260.0);  // scales to 120 ticks
    track.addEvent(juce::MidiMessage::endOfTrack(), 1440.0);
    track.sort();

    midiFile.addTrack(track);

    juce::File juceMidiFile(juce::String::fromUTF8(midiPath.string().c_str()));
    juce::FileOutputStream stream(juceMidiFile);
    if (!stream.openedOk()) {
        throw std::runtime_error("Could not open clamp fixture MIDI file for writing");
    }
    if (!midiFile.writeTo(stream, 0)) {
        throw std::runtime_error("Failed to write clamp fixture MIDI file");
    }
    stream.flush();
}

} // namespace

int main()
{
    const fs::path tempDir = fs::temp_directory_path() / "xleth_test_midi_importer";
    const fs::path summaryMidiPath = tempDir / "summary_fixture.mid";
    const fs::path clampMidiPath = tempDir / "clamp_fixture.mid";

    const auto cleanup = [&]() {
        if (fs::exists(tempDir)) {
            fs::remove_all(tempDir);
        }
    };

    cleanup();
    fs::create_directories(tempDir);

    try {
        writeSummaryFixture(summaryMidiPath);
        writeClampFixture(clampMidiPath);
    } catch (const std::exception& e) {
        std::cerr << "FAILED: " << e.what() << "\n";
        cleanup();
        return 1;
    }

    const auto summaryJson = MidiImporter::parseSummary(summaryMidiPath.string());
    const auto parsedSummary = json::parse(summaryJson, nullptr, false);
    REQUIRE(!parsedSummary.is_discarded(), "parseSummary returned invalid JSON");
    REQUIRE(parsedSummary.value("ok", false), "parseSummary did not return ok=true");

    CHECK(parsedSummary.value("fileType", -1) == 1, "fileType == 1");
    CHECK(parsedSummary.value("tpq", -1) == 480, "tpq == 480");
    CHECK(std::abs(parsedSummary.value("sourceTempo", 0.0) - 100.0) < 0.0001,
          "sourceTempo == 100 BPM");
    CHECK(parsedSummary.value("hasMidFileTempoChanges", true) == false,
          "hasMidFileTempoChanges == false");

    REQUIRE(parsedSummary.contains("tracks") && parsedSummary["tracks"].is_array(),
            "tracks is an array");
    REQUIRE(parsedSummary["tracks"].size() == 1, "one note-bearing track reported");

    const auto& summaryTrack = parsedSummary["tracks"][0];
    CHECK(summaryTrack.value("index", -1) == 1, "track index == 1");
    CHECK(summaryTrack.value("name", std::string()) == "Drums", "track name == Drums");
    CHECK(summaryTrack.value("noteCount", 0) == 1, "track noteCount == 1");
    CHECK(summaryTrack.value("isDrum", false), "track flagged as drum track");
    CHECK(summaryTrack.value("hasPitchBend", false), "track flagged as pitch bend track");

    REQUIRE(summaryTrack.contains("channelsUsed") && summaryTrack["channelsUsed"].is_array(),
            "channelsUsed is an array");
    REQUIRE(summaryTrack.contains("uniqueNoteNumbers") && summaryTrack["uniqueNoteNumbers"].is_array(),
            "uniqueNoteNumbers is an array");
    CHECK(summaryTrack["channelsUsed"].size() == 1 && summaryTrack["channelsUsed"][0].get<int>() == 10,
          "channelsUsed contains channel 10");
    CHECK(summaryTrack["uniqueNoteNumbers"].size() == 1
          && summaryTrack["uniqueNoteNumbers"][0].get<int>() == 36,
          "uniqueNoteNumbers contains 36");

    const auto clampSummaryJson = MidiImporter::parseSummary(clampMidiPath.string());
    const auto parsedClampSummary = json::parse(clampSummaryJson, nullptr, false);
    REQUIRE(!parsedClampSummary.is_discarded(), "clamp parseSummary returned invalid JSON");
    REQUIRE(parsedClampSummary.value("ok", false), "clamp parseSummary returned ok=true");
    REQUIRE(parsedClampSummary.contains("tracks") && parsedClampSummary["tracks"].is_array(),
            "clamp tracks is an array");
    REQUIRE(parsedClampSummary["tracks"].size() == 1, "clamp fixture reports one track");

    const int clampTrackIndex = parsedClampSummary["tracks"][0].value("index", -1);
    REQUIRE(clampTrackIndex == 0, "clamp track index == 0");

    const auto offResult = MidiImporter::importFull(
        clampMidiPath.string(), makeImportOptions(clampTrackIndex, 0).dump());
    const auto offMeta = json::parse(offResult.metadataJson, nullptr, false);
    REQUIRE(!offMeta.is_discarded() && offMeta.contains("noteCount"),
            "clamp-off metadata is valid JSON");
    REQUIRE(offMeta.value("noteCount", 0) == 2, "clamp-off imports both notes");
    const auto offNotes = decodePackedNotes(offResult.notes);
    REQUIRE(offNotes.size() == 2, "clamp-off decoded note count == 2");
    CHECK(offNotes[0].duration == 1920, "clamp disabled preserves long note duration");
    CHECK(offNotes[1].duration == 120, "clamp disabled preserves short note duration");

    const auto clampedResult = MidiImporter::importFull(
        clampMidiPath.string(), makeImportOptions(clampTrackIndex, 240).dump());
    const auto clampedMeta = json::parse(clampedResult.metadataJson, nullptr, false);
    REQUIRE(!clampedMeta.is_discarded() && clampedMeta.contains("noteCount"),
            "clamped metadata is valid JSON");
    REQUIRE(clampedMeta.value("noteCount", 0) == 2, "clamped import keeps both notes");
    const auto clampedNotes = decodePackedNotes(clampedResult.notes);
    REQUIRE(clampedNotes.size() == 2, "clamped decoded note count == 2");
    CHECK(clampedNotes[0].duration == 240, "long note clamps to max length");
    CHECK(clampedNotes[1].duration == 120, "short note remains unchanged under clamp");

    std::cout << "\nPassed: " << g_passed << "\n";
    std::cout << "Failed: " << g_failed << "\n";

    cleanup();
    return g_failed == 0 ? 0 : 1;
}
