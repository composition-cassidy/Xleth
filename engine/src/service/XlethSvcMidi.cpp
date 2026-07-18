// XlethSvcMidi.cpp — MIDI Import domain handlers (S2 Stage 2).
//
// Verbatim move of the three midi_* handlers out of XlethEngineService.cpp
// (was lines 15490–15709 at branch base f287c85). No behavior change — see
// docs/S2_SPLIT_PLAN.md §4 Stage 2. dispatch() (still in XlethEngineService.cpp)
// resolves these via XlethSvcMidi.h.

#include "service/XlethSvcGlobals.h"
using namespace xleth::svc;
#include "service/XlethSvcShared.h"
#include "service/XlethSvcHelpers.h"
#include "service/XlethSvcMidi.h"

#include "midi/MidiImporter.h"
#include "commands/ImportMidiCommand.h"
#include "model/TimelineTypes.h"

#include <cstring>
#include <iostream>
#include <mutex>
#include <unordered_map>

// ─────────────────────────────────────────────────────────────────────────────
// MIDI Import
// ─────────────────────────────────────────────────────────────────────────────

JsonApi::Value Midi_ParseSummary(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        JsonApi::TypeError::New(env, "parseMidiSummary(filePath: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string filePath = info[0].As<JsonApi::String>().Utf8Value();

#ifdef XLETH_DEBUG
    std::cout << "[MidiImport] parseSummary: " << filePath << std::endl << std::flush;
#endif

    try {
        std::string json = MidiImporter::parseSummary(filePath);
        return JsonApi::String::New(env, json);
    } catch (const std::exception& e) {
        JsonApi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

JsonApi::Value Midi_ImportFull(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        JsonApi::TypeError::New(env, "importMidiFull(filePath: string, optionsJson: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string filePath    = info[0].As<JsonApi::String>().Utf8Value();
    std::string optionsJson = info[1].As<JsonApi::String>().Utf8Value();

#ifdef XLETH_DEBUG
    std::cout << "[MidiImport] importFull: " << filePath << std::endl << std::flush;
#endif

    try {
        MidiImportFullResult r = MidiImporter::importFull(filePath, optionsJson);

        size_t sizeBytes = r.notes.getSize();
        JsonApi::ArrayBuffer ab = JsonApi::ArrayBuffer::New(env, sizeBytes);
        if (sizeBytes > 0)
            std::memcpy(ab.Data(), r.notes.getData(), sizeBytes);

        JsonApi::Object out = JsonApi::Object::New(env);
        out.Set("metadata", JsonApi::String::New(env, r.metadataJson));
        out.Set("noteData", ab);
        return out;
    } catch (const std::exception& e) {
        JsonApi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

// midi_executeImport(noteData: ArrayBuffer | Buffer | Uint8Array,
//                    optionsJson: string)
//   Commits a parsed MIDI import (output from midi_importFull) into the
//   live timeline as one Pattern track per output track. Atomic + undoable
//   via ImportMidiCommand. Triggers waveform mipmap generation for each
//   newly-loaded sample slot after dispatch.
void Midi_ExecuteImport(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();

    if (!isInitialised() || !g_timeline || !g_undoManager || !audioEngine || !sampleBank) {
        JsonApi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return;
    }

    if (info.Length() < 2 || !info[1].IsString()) {
        JsonApi::TypeError::New(env,
            "midi_executeImport(noteData: ArrayBuffer|Buffer|Uint8Array, optionsJson: string)")
            .ThrowAsJavaScriptException();
        return;
    }

    // Accept ArrayBuffer (renderer path) or Buffer/Uint8Array (worker IPC path).
    const uint8_t* noteBytes  = nullptr;
    size_t         noteLength = 0;
    if (info[0].IsArrayBuffer()) {
        JsonApi::ArrayBuffer ab = info[0].As<JsonApi::ArrayBuffer>();
        noteBytes  = static_cast<const uint8_t*>(ab.Data());
        noteLength = ab.ByteLength();
    } else if (info[0].IsBuffer()) {
        JsonApi::Buffer<uint8_t> b = info[0].As<JsonApi::Buffer<uint8_t>>();
        noteBytes  = b.Data();
        noteLength = b.Length();
    } else if (info[0].IsTypedArray()) {
        JsonApi::TypedArray ta = info[0].As<JsonApi::TypedArray>();
        JsonApi::ArrayBuffer ab = ta.ArrayBuffer();
        noteBytes  = static_cast<const uint8_t*>(ab.Data()) + ta.ByteOffset();
        noteLength = ta.ByteLength();
    } else {
        JsonApi::TypeError::New(env,
            "midi_executeImport: noteData must be ArrayBuffer, Buffer, or TypedArray")
            .ThrowAsJavaScriptException();
        return;
    }

    if ((noteLength % 12u) != 0u) {
        JsonApi::TypeError::New(env,
            "midi_executeImport: noteData length must be a multiple of 12")
            .ThrowAsJavaScriptException();
        return;
    }

    BridgeCallLog log("midi.executeImport");

    const std::string optionsJson = info[1].As<JsonApi::String>().Utf8Value();

    ImportMidiCommandOptions opts;

    try {
        const auto parsed = nlohmann::json::parse(optionsJson);

        opts.tempoOverride = parsed.value("tempoOverride", false);
        opts.sourceBPM     = parsed.value("sourceBPM",    0.0);
        opts.projectTPQ    = parsed.value("projectTPQ",   960);
        opts.sourcePath    = parsed.value("sourcePath",   std::string{});

        const auto& outputTracksJson = parsed.at("outputTracks");
        if (!outputTracksJson.is_array()) {
            JsonApi::TypeError::New(env, "midi_executeImport: outputTracks must be an array")
                .ThrowAsJavaScriptException();
            return;
        }

        opts.outputTracks.reserve(outputTracksJson.size());
        for (const auto& entry : outputTracksJson) {
            ImportMidiCommandOptions::OutputTrackSpec spec;
            spec.outputTrackIndex = entry.value("outputTrackIndex", 0);
            spec.name             = entry.value("name",            std::string{});
            spec.visualOnly       = entry.value("visualOnly",      false);
            spec.regionId         = entry.value("regionId",        -1);
            opts.outputTracks.push_back(std::move(spec));
        }
    } catch (const std::exception& e) {
        JsonApi::TypeError::New(env,
            std::string{"midi_executeImport: invalid options JSON: "} + e.what())
            .ThrowAsJavaScriptException();
        return;
    }

    // Unpack 12-byte PackedNote records, group by outputTrackIndex.
    // Build a lookup outputTrackIndex → spec slot.
    std::unordered_map<int, size_t> indexToSpecSlot;
    indexToSpecSlot.reserve(opts.outputTracks.size());
    for (size_t i = 0; i < opts.outputTracks.size(); ++i) {
        indexToSpecSlot[opts.outputTracks[i].outputTrackIndex] = i;
    }

    auto readU32LE = [](const uint8_t* p) -> uint32_t {
        return  static_cast<uint32_t>(p[0])
             | (static_cast<uint32_t>(p[1]) << 8)
             | (static_cast<uint32_t>(p[2]) << 16)
             | (static_cast<uint32_t>(p[3]) << 24);
    };

    const size_t noteCount = noteLength / 12u;
    for (size_t i = 0; i < noteCount; ++i) {
        const uint8_t* rec = noteBytes + i * 12u;
        const uint32_t tick     = readU32LE(rec + 0);
        const uint32_t duration = readU32LE(rec + 4);
        const uint8_t  noteNum  = rec[8];
        const uint8_t  velocity = rec[9];
        const uint8_t  trackIdx = rec[10];
        // rec[11] = flags (drum-channel marker) — unused at commit time.

        const auto it = indexToSpecSlot.find(static_cast<int>(trackIdx));
        if (it == indexToSpecSlot.end()) continue;

        PatternNote pn;
        pn.position = TickTime{ static_cast<int64_t>(tick) };
        pn.duration = TickTime{ static_cast<int64_t>(duration) };
        pn.pitch    = static_cast<int>(noteNum);
        pn.velocity = static_cast<float>(velocity) / 127.0f;
        opts.outputTracks[it->second].notes.push_back(pn);
    }

#ifdef XLETH_DEBUG
    std::fprintf(stderr,
                 "[MidiImport] Midi_ExecuteImport notes=%zu outputTracks=%zu tempoOverride=%d\n",
                 noteCount, opts.outputTracks.size(), opts.tempoOverride ? 1 : 0);
    std::fflush(stderr);
#endif

    const double engineRate = audioEngine->getSampleRate();
    auto& mixEngine = audioEngine->getMixEngine();

    // Hold a non-owning pointer so we can read created-slot info after dispatch.
    auto cmd = std::make_unique<ImportMidiCommand>(
        std::move(opts), mixEngine, *sampleBank, engineRate);
    ImportMidiCommand* cmdPtr = cmd.get();

    {
        std::lock_guard<std::mutex> lock(syncEventsMutex);
        g_undoManager->execute(std::move(cmd), *g_timeline);
    }
    syncMixerTrackSlots(false);

    // Post-pass: trigger waveform mipmap generation for each newly-loaded
    // sample slot. cmdPtr is still valid — UndoManager owns the command on
    // its undo stack and we just pushed it (no possibility of pop).
    for (const auto& slot : cmdPtr->getCreatedSampleSlots()) {
        triggerMipmapGeneration(slot.sampleBankId, slot.filePath, /*saveXlpeak*/false);
    }

    log.done(std::to_string(cmdPtr->getCreatedSampleSlots().size()) + " slots");
}
