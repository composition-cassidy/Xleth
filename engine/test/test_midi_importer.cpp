// test_midi_importer.cpp — smoke test for MidiImporter::parseSummary.
// Build: see engine/CMakeLists.txt target "test_midi_importer"
// Run:   test_midi_importer.exe

#include "midi/MidiImporter.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <cmath>
#include <filesystem>
#include <iostream>
#include <nlohmann/json.hpp>

namespace fs = std::filesystem;
using json   = nlohmann::json;

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

int main()
{
    constexpr int kDrumChannel = 10;

    const fs::path tempDir = fs::temp_directory_path() / "xleth_test_midi_importer";
    const fs::path midiPath = tempDir / "summary_fixture.mid";

    const auto cleanup = [&]() {
        if (fs::exists(tempDir)) {
            fs::remove_all(tempDir);
        }
    };

    cleanup();
    fs::create_directories(tempDir);

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
    REQUIRE(stream.openedOk(), "Could not open fixture MIDI file for writing");
    REQUIRE(midiFile.writeTo(stream, 1), "Failed to write fixture MIDI file");
    stream.flush();

    const auto summaryJson = MidiImporter::parseSummary(midiPath.string());
    const auto parsed = json::parse(summaryJson, nullptr, false);
    REQUIRE(!parsed.is_discarded(), "parseSummary returned invalid JSON");
    REQUIRE(parsed.value("ok", false), "parseSummary did not return ok=true");

    CHECK(parsed.value("fileType", -1) == 1, "fileType == 1");
    CHECK(parsed.value("tpq", -1) == 480, "tpq == 480");
    CHECK(std::abs(parsed.value("sourceTempo", 0.0) - 100.0) < 0.0001,
          "sourceTempo == 100 BPM");
    CHECK(parsed.value("hasMidFileTempoChanges", true) == false,
          "hasMidFileTempoChanges == false");

    REQUIRE(parsed.contains("tracks") && parsed["tracks"].is_array(),
            "tracks is an array");
    REQUIRE(parsed["tracks"].size() == 1, "one note-bearing track reported");

    const auto& track = parsed["tracks"][0];
    CHECK(track.value("index", -1) == 1, "track index == 1");
    CHECK(track.value("name", std::string()) == "Drums", "track name == Drums");
    CHECK(track.value("noteCount", 0) == 1, "track noteCount == 1");
    CHECK(track.value("isDrum", false), "track flagged as drum track");
    CHECK(track.value("hasPitchBend", false), "track flagged as pitch bend track");

    REQUIRE(track.contains("channelsUsed") && track["channelsUsed"].is_array(),
            "channelsUsed is an array");
    REQUIRE(track.contains("uniqueNoteNumbers") && track["uniqueNoteNumbers"].is_array(),
            "uniqueNoteNumbers is an array");
    CHECK(track["channelsUsed"].size() == 1 && track["channelsUsed"][0].get<int>() == 10,
          "channelsUsed contains channel 10");
    CHECK(track["uniqueNoteNumbers"].size() == 1
          && track["uniqueNoteNumbers"][0].get<int>() == 36,
          "uniqueNoteNumbers contains 36");

    std::cout << "\nPassed: " << g_passed << "\n";
    std::cout << "Failed: " << g_failed << "\n";

    cleanup();
    return g_failed == 0 ? 0 : 1;
}
