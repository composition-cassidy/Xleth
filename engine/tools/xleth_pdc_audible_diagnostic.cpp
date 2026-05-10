#include "SampleBank.h"
#include "Transport.h"
#include "audio/MixEngine.h"
#include "audio/XlethEffectBase.h"
#include "audio/XlethResonanceSuppressorEffect.h"
#include "export/AudioExporter.h"
#include "model/Timeline.h"
#include "project/ProjectManager.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

#include <nlohmann/json.hpp>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <wincrypt.h>
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

namespace fs = std::filesystem;
using json = nlohmann::json;

constexpr int kDefaultBlockSize = 512;
constexpr double kFallbackSampleRate = 48000.0;

const std::vector<std::string> kRequestedTrackNames = {
    "MAIN CHROUS",
    "AUTO 1",
    "AUTO 2",
    "FREESTYLE",
    "KICK",
    "SNARE",
    "CH",
    "OH",
    "ARP 1",
    "PAD",
    "MELODY",
};

struct Options {
    fs::path repoRoot = fs::current_path();
    fs::path projectDir;
    fs::path originalProjectDir;
    fs::path jsonPath;
    fs::path markdownPath;
    std::string originalHashBefore;
    int blockSize = kDefaultBlockSize;
    bool loadMedia = true;
};

std::string quoteForCommand(const fs::path& path)
{
    std::string s = path.string();
    std::string out = "\"";
    for (char c : s) {
        if (c == '"')
            out += "\\\"";
        else
            out += c;
    }
    out += "\"";
    return out;
}

std::string trim(std::string s)
{
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ' || s.back() == '\t'))
        s.pop_back();
    std::size_t first = 0;
    while (first < s.size() && (s[first] == '\n' || s[first] == '\r' || s[first] == ' ' || s[first] == '\t'))
        ++first;
    return first > 0 ? s.substr(first) : s;
}

std::string runCommand(const std::string& command)
{
    std::array<char, 4096> buffer {};
    std::string result;
#ifdef _WIN32
    FILE* pipe = _popen(command.c_str(), "r");
#else
    FILE* pipe = popen(command.c_str(), "r");
#endif
    if (pipe == nullptr)
        return "";

    while (fgets(buffer.data(), static_cast<int>(buffer.size()), pipe) != nullptr)
        result += buffer.data();

#ifdef _WIN32
    _pclose(pipe);
#else
    pclose(pipe);
#endif
    return trim(result);
}

std::string toHex(const unsigned char* data, std::size_t size)
{
    std::ostringstream out;
    out << std::hex << std::setfill('0') << std::uppercase;
    for (std::size_t i = 0; i < size; ++i)
        out << std::setw(2) << static_cast<int>(data[i]);
    return out.str();
}

std::string sha256File(const fs::path& path)
{
#ifdef _WIN32
    std::ifstream file(path, std::ios::binary);
    if (!file)
        return "";

    HCRYPTPROV provider = 0;
    HCRYPTHASH hash = 0;
    if (!CryptAcquireContext(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT))
        return "";
    if (!CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash)) {
        CryptReleaseContext(provider, 0);
        return "";
    }

    std::array<char, 65536> buffer {};
    while (file.good()) {
        file.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
        const auto n = file.gcount();
        if (n > 0) {
            if (!CryptHashData(hash,
                               reinterpret_cast<const BYTE*>(buffer.data()),
                               static_cast<DWORD>(n),
                               0)) {
                CryptDestroyHash(hash);
                CryptReleaseContext(provider, 0);
                return "";
            }
        }
    }

    BYTE digest[32] {};
    DWORD digestSize = sizeof(digest);
    const BOOL ok = CryptGetHashParam(hash, HP_HASHVAL, digest, &digestSize, 0);
    CryptDestroyHash(hash);
    CryptReleaseContext(provider, 0);
    return ok ? toHex(digest, digestSize) : "";
#else
    (void)path;
    return "";
#endif
}

json parseJsonOr(const std::string& text, json fallback)
{
    try {
        return json::parse(text);
    } catch (...) {
        return fallback;
    }
}

std::string normalizeName(const std::string& s)
{
    std::string out;
    for (unsigned char c : s) {
        if (std::isalnum(c))
            out.push_back(static_cast<char>(std::toupper(c)));
    }
    return out;
}

bool requestedNameMatches(const std::string& actual, const std::string& requested)
{
    return normalizeName(actual) == normalizeName(requested);
}

std::string pluginDisplayName(const std::string& pluginId)
{
    static const std::map<std::string, std::string> names = {
        {"resonancesuppressor", "Resonance Suppressor"},
        {"xletheq", "Xleth EQ"},
        {"smartbalance", "Smart Balance"},
        {"compressor", "Compressor"},
        {"reverb", "Reverb"},
        {"delay", "Delay"},
        {"distortion", "Distortion"},
        {"transientproc", "Transient Processor"},
        {"waveshaper", "Waveshaper"},
        {"phaser", "Phaser"},
        {"flanger", "Flanger"},
        {"chorus", "Chorus"},
        {"limiter", "Limiter"},
        {"overdone", "OTT"},
    };
    auto it = names.find(pluginId);
    return it != names.end() ? it->second : pluginId;
}

json paramsById(const json& params)
{
    json result = json::object();
    if (!params.is_array())
        return result;
    for (const auto& p : params) {
        if (!p.is_object() || !p.contains("id"))
            continue;
        result[p.value("id", "")] = p.value("value", 0.0);
    }
    return result;
}

int rsLatencyForQuality(int qualityIndex)
{
    switch (std::clamp(qualityIndex, 0, 2)) {
        case 0: return 512;
        case 2: return 2048;
        case 1:
        default: return 1024;
    }
}

int rsFftForQuality(int qualityIndex)
{
    return rsLatencyForQuality(qualityIndex);
}

int rsHopForQuality(int qualityIndex)
{
    switch (std::clamp(qualityIndex, 0, 2)) {
        case 0: return 128;
        case 2: return 512;
        case 1:
        default: return 256;
    }
}

int rsFftOrderForQuality(int qualityIndex)
{
    switch (std::clamp(qualityIndex, 0, 2)) {
        case 0: return 9;
        case 2: return 11;
        case 1:
        default: return 10;
    }
}

const TrackInfo* findTrackByRequestedName(const Timeline& timeline, const std::string& name)
{
    for (const TrackInfo* track : timeline.getAllTracks()) {
        if (track != nullptr && requestedNameMatches(track->name, name))
            return track;
    }
    return nullptr;
}

std::set<int> affectedTrackIds(const Timeline& timeline)
{
    std::set<int> ids;
    for (const auto& name : kRequestedTrackNames) {
        if (name == "MAIN CHROUS")
            continue;
        if (const TrackInfo* track = findTrackByRequestedName(timeline, name))
            ids.insert(track->id);
    }
    return ids;
}

bool anySoloTrack(const Timeline& timeline)
{
    for (const TrackInfo* track : timeline.getAllTracks()) {
        if (track != nullptr && track->solo)
            return true;
    }
    return false;
}

bool participatesInPdc(const TrackInfo& track, bool anySolo)
{
    const bool shouldPlay = anySolo ? track.solo : !track.muted;
    return shouldPlay && !track.visualOnly;
}

bool hasTrackContent(const Timeline& timeline, int trackId)
{
    return !timeline.getClipsOnTrack(trackId).empty()
        || !timeline.getPatternBlocksOnTrack(trackId).empty();
}

json sourceMediaAudit(const Timeline& timeline)
{
    json arr = json::array();
    for (const SourceMedia* source : timeline.getAllSources()) {
        if (source == nullptr)
            continue;
        json row;
        row["sourceId"] = source->id;
        row["filePath"] = source->filePath;
        row["fileExists"] = !source->filePath.empty() && fs::exists(source->filePath);
        row["proxyPath"] = source->proxyPath;
        row["proxyExists"] = !source->proxyPath.empty() && fs::exists(source->proxyPath);
        row["hasVideo"] = source->hasVideo;
        arr.push_back(std::move(row));
    }
    return arr;
}

json effectRowsForTrack(MixEngine& mix, int trackId)
{
    const json chain = parseJsonOr(
        trackId == -1 ? mix.getMasterEffectChainState() : mix.getEffectChainState(trackId),
        json::array());
    json rows = json::array();
    if (!chain.is_array())
        return rows;

    for (const auto& node : chain) {
        const int nodeId = node.value("nodeId", -1);
        const std::string pluginId = node.value("pluginId", "");
        const json params = parseJsonOr(
            trackId == -1 ? mix.getMasterEffectParameters(nodeId)
                          : mix.getEffectParameters(trackId, nodeId),
            json::array());
        const json byId = paramsById(params);
        XlethEffectBase* effect = trackId == -1
            ? mix.getMasterEffectPtr(nodeId)
            : mix.getEffectPtr(trackId, nodeId);

        json row;
        row["nodeId"] = nodeId;
        row["pluginId"] = pluginId;
        row["name"] = pluginDisplayName(pluginId);
        row["position"] = node.value("position", -1);
        row["bypassed"] = node.value("bypassed", false);
        row["missing"] = node.value("missing", false);
        row["crashed"] = node.value("crashed", false);
        if (effect != nullptr)
            row["reportedLatencySamples"] = effect->getLatencySamples();
        else
            row["reportedLatencySamples"] = nullptr;
        row["parameters"] = params;

        if (pluginId == "resonancesuppressor") {
            const int quality = static_cast<int>(std::lround(byId.value("quality", 1.0)));
            const int processingMode =
                static_cast<int>(std::lround(byId.value("processing_mode", 0.0)));
            row["resonanceSuppressor"] = {
                {"processing_mode", processingMode},
                {"quality", quality},
                {"mode", static_cast<int>(std::lround(byId.value("mode", 0.0)))},
                {"mix", byId.value("mix", 100.0)},
                {"delta", byId.value("delta", 0.0)},
                {"fftOrder", processingMode == 1 ? rsFftOrderForQuality(quality) : 0},
                {"fftSize", processingMode == 1 ? rsFftForQuality(quality) : 0},
                {"hopSize", processingMode == 1 ? rsHopForQuality(quality) : 0},
                {"expectedHqLatencySamples", processingMode == 1 ? rsLatencyForQuality(quality) : 0},
            };
        }

        rows.push_back(std::move(row));
    }

    return rows;
}

void pumpLatencyBlock(MixEngine& mix,
                      const Timeline& timeline,
                      double sampleRate,
                      int blockSize,
                      int64_t startSample)
{
    Transport transport;
    transport.setSampleRate(sampleRate);
    transport.setBPM(timeline.getBPM());
    transport.seekToSample(startSample);
    transport.play();

    juce::AudioBuffer<float> block(2, blockSize);
    block.clear();
    mix.setNonRealtime(true);
    mix.processBlock(block, blockSize, transport);
    mix.setNonRealtime(false);
}

json latencySnapshotJson(const std::string& label,
                         MixEngine& mix,
                         const Timeline& timeline,
                         int64_t startSample,
                         int blockSize)
{
    const auto snapshot = mix.getLatencyCompensationSnapshot();
    const bool anySolo = anySoloTrack(timeline);
    const std::set<int> affectedIds = affectedTrackIds(timeline);
    const TrackInfo* main = findTrackByRequestedName(timeline, "MAIN CHROUS");

    json tracks = json::array();
    for (const TrackInfo* track : timeline.getAllTracks()) {
        if (track == nullptr)
            continue;
        const bool pdc = participatesInPdc(*track, anySolo);
        const int declared = mix.getTrackInsertLatencySamples(track->id);
        const int compensation = mix.getTrackCompensationDelaySamples(track->id);
        const int expectedCompensation = pdc
            ? std::max(0, snapshot.maxAudibleTrackLatencySamples - declared)
            : 0;

        json row;
        row["trackId"] = track->id;
        row["trackName"] = track->name;
        row["trackType"] = trackTypeToString(track->type);
        row["muted"] = track->muted;
        row["solo"] = track->solo;
        row["visualOnly"] = track->visualOnly;
        row["audible"] = anySolo ? track->solo : !track->muted;
        row["participatesInPdc"] = pdc;
        row["hasClipsOrPatternBlocksInTestRange"] = hasTrackContent(timeline, track->id);
        row["isMainChrous"] = main != nullptr && track->id == main->id;
        row["isAffectedReproTrack"] = affectedIds.count(track->id) > 0;
        row["declaredLatencySamples"] = declared;
        row["compensationDelaySamples"] = compensation;
        row["expectedCompensationDelaySamples"] = expectedCompensation;
        row["compensationMatchesExpected"] = compensation == expectedCompensation;
        row["effectChain"] = effectRowsForTrack(mix, track->id);
        row["graphTopology"] = parseJsonOr(mix.getGraphTopology(track->id), json::object());
        tracks.push_back(std::move(row));
    }

    const auto preroll = AudioExporter::computePrerollPlan(
        startSample,
        snapshot.maxAudibleTrackLatencySamples,
        snapshot.masterInsertLatencySamples);

    json out;
    out["label"] = label;
    out["transportStartSampleUsedForTest"] = startSample;
    out["blockSize"] = blockSize;
    out["maxAudibleTrackLatencySamples"] = snapshot.maxAudibleTrackLatencySamples;
    out["masterInsertLatencySamples"] = snapshot.masterInsertLatencySamples;
    out["livePresentationLatencySamplesExcludingDevice"] =
        snapshot.maxAudibleTrackLatencySamples + snapshot.masterInsertLatencySamples;
    out["exportPreroll"] = {
        {"formula", "availablePreroll + maxAudibleTrackLatencySamples + masterInsertLatencySamples"},
        {"renderStartSample", preroll.renderStartSample},
        {"availablePrerollSamples", preroll.availablePrerollSamples},
        {"totalPrerollSamples", preroll.totalPrerollSamples},
        {"discardSamples", preroll.discardSamples},
        {"matchesLiveTrackPlusMasterFormula",
         preroll.totalPrerollSamples
             == static_cast<int64_t>(snapshot.maxAudibleTrackLatencySamples)
              + static_cast<int64_t>(snapshot.masterInsertLatencySamples)}
    };
    out["tracks"] = std::move(tracks);

    if (main != nullptr) {
        const int mainLatency = mix.getTrackInsertLatencySamples(main->id);
        out["mainChrous"] = {
            {"trackId", main->id},
            {"trackName", main->name},
            {"trackType", trackTypeToString(main->type)},
            {"participatesInPdc", participatesInPdc(*main, anySolo)},
            {"declaredLatencySamples", mainLatency},
            {"contributesToMaxAudibleTrackLatency", mainLatency > 0 && mainLatency == snapshot.maxAudibleTrackLatencySamples}
        };
    }

    return out;
}

int findResonanceSuppressorNode(MixEngine& mix, int trackId)
{
    const json chain = parseJsonOr(mix.getEffectChainState(trackId), json::array());
    if (!chain.is_array())
        return -1;
    for (const auto& node : chain) {
        if (node.value("pluginId", "") == "resonancesuppressor")
            return node.value("nodeId", -1);
    }
    return -1;
}

json mutateMainChrousToRsHq(MixEngine& mix, const Timeline& timeline)
{
    json result;
    const TrackInfo* main = findTrackByRequestedName(timeline, "MAIN CHROUS");
    if (main == nullptr) {
        result["ok"] = false;
        result["reason"] = "MAIN CHROUS track not found";
        return result;
    }

    int nodeId = findResonanceSuppressorNode(mix, main->id);
    const bool existedBefore = nodeId >= 0;
    if (nodeId < 0)
        nodeId = mix.addEffect(main->id, "resonancesuppressor", 1000);

    const bool nodeOk = nodeId >= 0;
    bool bypassOk = false;
    bool modeOk = false;
    bool qualityOk = false;
    if (nodeOk) {
        bypassOk = mix.setEffectBypass(main->id, nodeId, false);
        modeOk = mix.setEffectParameter(main->id, nodeId, "processing_mode", 1.0f);
        qualityOk = mix.setEffectParameter(main->id, nodeId, "quality", 2.0f);
    }

    result["ok"] = nodeOk && modeOk && qualityOk;
    result["trackId"] = main->id;
    result["trackName"] = main->name;
    result["nodeId"] = nodeId;
    result["existingResonanceSuppressorReused"] = existedBefore;
    result["setBypassFalseOk"] = bypassOk;
    result["setProcessingModeHighQualityOk"] = modeOk;
    result["setQualityHighOk"] = qualityOk;
    result["route"] = existedBefore
        ? "MixEngine::setEffectBypass/setEffectParameter on existing track insert"
        : "MixEngine::addEffect then setEffectBypass/setEffectParameter";
    return result;
}

struct MediaLoadResult {
    int loaded = 0;
    int failed = 0;
    json rows = json::array();
};

MediaLoadResult loadMediaLikeBridge(Timeline& timeline,
                                    SampleBank& sampleBank,
                                    MixEngine& mix,
                                    double engineRate)
{
    MediaLoadResult result;
    mix.clearRegionToSampleMap();
    for (SampleRegion* region : timeline.getAllRegionsMutable()) {
        if (region == nullptr)
            continue;

        std::string audioPath;
        double startTime = 0.0;
        double endTime = 0.0;
        if (region->hasSwappedAudio && !region->swappedAudioPath.empty()) {
            audioPath = region->swappedAudioPath;
            startTime = 0.0;
            endTime = 3600.0;
        } else {
            const SourceMedia* source = timeline.getSource(region->sourceId);
            if (source == nullptr || source->filePath.empty())
                continue;
            audioPath = source->filePath;
            startTime = region->startTime;
            endTime = region->endTime;
            if (!fs::exists(audioPath)
                && source->proxyReady
                && !source->proxyPath.empty()
                && fs::exists(source->proxyPath)) {
                audioPath = source->proxyPath;
            }
        }

        json row;
        row["regionId"] = region->id;
        row["regionName"] = region->name;
        row["audioPath"] = audioPath;
        row["startTimeSec"] = startTime;
        row["endTimeSec"] = endTime;
        row["fileExists"] = !audioPath.empty() && fs::exists(audioPath);

        if (audioPath.empty() || startTime >= endTime || !fs::exists(audioPath)) {
            ++result.failed;
            row["sampleId"] = nullptr;
            row["loaded"] = false;
            result.rows.push_back(std::move(row));
            continue;
        }

        const int sampleId =
            sampleBank.loadSampleFromSource(audioPath, startTime, endTime, engineRate);
        if (sampleId >= 0) {
            mix.mapRegionToSample(region->id, sampleId);
            ++result.loaded;
            row["sampleId"] = sampleId;
            row["loaded"] = true;
        } else {
            ++result.failed;
            row["sampleId"] = nullptr;
            row["loaded"] = false;
        }
        result.rows.push_back(std::move(row));
    }
    mix.rebuildAllSamplers();
    return result;
}

int peakIndex(const juce::AudioBuffer<float>& buffer, int channel, float* peakOut = nullptr)
{
    int best = -1;
    float bestValue = 0.0f;
    if (channel < 0 || channel >= buffer.getNumChannels())
        return -1;
    const float* data = buffer.getReadPointer(channel);
    for (int i = 0; i < buffer.getNumSamples(); ++i) {
        const float v = std::abs(data[i]);
        if (v > bestValue) {
            bestValue = v;
            best = i;
        }
    }
    if (peakOut != nullptr)
        *peakOut = bestValue;
    return bestValue > 1.0e-5f ? best : -1;
}

juce::File writeImpulseWav(const juce::File& dir,
                           const juce::String& name,
                           double sampleRate,
                           int numSamples,
                           int impulseSample,
                           int impulseChannel)
{
    juce::AudioBuffer<float> buffer(2, numSamples);
    buffer.clear();
    if (impulseSample >= 0 && impulseSample < numSamples
        && impulseChannel >= 0 && impulseChannel < 2) {
        buffer.setSample(impulseChannel, impulseSample, 1.0f);
    }

    juce::WavAudioFormat format;
    juce::File file = dir.getChildFile(name);
    file.deleteFile();
    auto stream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
    if (!stream)
        throw std::runtime_error("failed to create synthetic impulse wav");
    auto writer = std::unique_ptr<juce::AudioFormatWriter>(
        format.createWriterFor(stream.get(), sampleRate, 2, 32, {}, 0));
    if (!writer)
        throw std::runtime_error("failed to create synthetic wav writer");
    stream.release();
    writer->writeFromAudioSampleBuffer(buffer, 0, buffer.getNumSamples());
    return file;
}

juce::AudioBuffer<float> renderRaw(MixEngine& mix,
                                   const Timeline& timeline,
                                   int64_t startSample,
                                   int totalSamples,
                                   double sampleRate,
                                   int blockSize)
{
    juce::AudioBuffer<float> output(2, totalSamples);
    output.clear();

    Transport transport;
    transport.setSampleRate(sampleRate);
    transport.setBPM(timeline.getBPM());
    transport.seekToSample(startSample);
    transport.play();

    juce::AudioBuffer<float> block(2, blockSize);
    int pos = 0;
    int64_t currentSample = startSample;
    mix.setNonRealtime(true);
    while (pos < totalSamples) {
        const int n = std::min(blockSize, totalSamples - pos);
        if (block.getNumSamples() != n)
            block.setSize(2, n, false, false, true);
        block.clear();
        mix.processBlock(block, n, transport);
        for (int ch = 0; ch < 2; ++ch)
            output.copyFrom(ch, pos, block, ch, 0, n);
        transport.advance(n);
        currentSample += n;
        (void)currentSample;
        pos += n;
    }
    mix.setNonRealtime(false);
    return output;
}

json runSyntheticImpulsePdc(double sampleRate, int blockSize)
{
    constexpr int kImpulseSample = 4096;
    constexpr int kSampleLength = 8192;
    constexpr int kRenderLength = 12000;

    juce::File dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
        .getChildFile("xleth_pdc_stage8a_synthetic_"
            + juce::String::toHexString(static_cast<juce::int64>(
                juce::Time::currentTimeMillis())));
    if (!dir.createDirectory())
        throw std::runtime_error("failed to create synthetic temp directory");

    const auto dryWav = writeImpulseWav(dir, "dry_left.wav", sampleRate,
                                        kSampleLength, kImpulseSample, 0);
    const auto wetWav = writeImpulseWav(dir, "wet_right.wav", sampleRate,
                                        kSampleLength, kImpulseSample, 1);

    Timeline timeline(120.0, sampleRate);
    TrackInfo dryTrack;
    dryTrack.name = "synthetic dry clip";
    dryTrack.type = TrackInfo::Type::Clip;
    const int dryTrackId = timeline.addTrack(dryTrack);

    TrackInfo wetTrack;
    wetTrack.name = "synthetic MAIN CHROUS-like clip";
    wetTrack.type = TrackInfo::Type::Clip;
    const int wetTrackId = timeline.addTrack(wetTrack);

    SampleRegion dryRegion;
    dryRegion.name = "dry left impulse";
    dryRegion.audioFilePath = dryWav.getFullPathName().toStdString();
    dryRegion.startTime = 0.0;
    dryRegion.endTime = static_cast<double>(kSampleLength) / sampleRate;
    const int dryRegionId = timeline.addRegion(dryRegion);

    SampleRegion wetRegion;
    wetRegion.name = "wet right impulse";
    wetRegion.audioFilePath = wetWav.getFullPathName().toStdString();
    wetRegion.startTime = 0.0;
    wetRegion.endTime = static_cast<double>(kSampleLength) / sampleRate;
    const int wetRegionId = timeline.addRegion(wetRegion);

    Clip dryClip;
    dryClip.trackId = dryTrackId;
    dryClip.regionId = dryRegionId;
    dryClip.position = TickTime::fromBeats(0.0);
    dryClip.duration = TickTime::fromBeats(1.0);
    timeline.addClip(dryClip);

    Clip wetClip = dryClip;
    wetClip.trackId = wetTrackId;
    wetClip.regionId = wetRegionId;
    timeline.addClip(wetClip);

    SampleBank bank;
    MixEngine mix;
    mix.setTimeline(&timeline);
    mix.setSampleBank(&bank);
    mix.prepare(sampleRate, blockSize);
    const int drySampleId = bank.loadSample(dryWav, sampleRate);
    const int wetSampleId = bank.loadSample(wetWav, sampleRate);
    mix.mapRegionToSample(dryRegionId, drySampleId);
    mix.mapRegionToSample(wetRegionId, wetSampleId);

    const int rsNode = mix.addEffect(wetTrackId, "resonancesuppressor", 0);
    const bool rsModeOk = mix.setEffectParameter(wetTrackId, rsNode, "processing_mode", 1.0f);
    const bool rsQualityOk = mix.setEffectParameter(wetTrackId, rsNode, "quality", 2.0f);

    const auto latency = mix.getLatencyCompensationSnapshot();
    const auto raw = renderRaw(mix, timeline, 0, kRenderLength, sampleRate, blockSize);
    float leftPeak = 0.0f;
    float rightPeak = 0.0f;
    const int leftPeakIndex = peakIndex(raw, 0, &leftPeak);
    const int rightPeakIndex = peakIndex(raw, 1, &rightPeak);

    const int totalSamples = 10000;
    const auto plan = AudioExporter::computePrerollPlan(mix, 0);
    const auto prerollRaw = renderRaw(mix,
                                      timeline,
                                      plan.renderStartSample,
                                      static_cast<int>(plan.discardSamples + totalSamples),
                                      sampleRate,
                                      blockSize);
    juce::AudioBuffer<float> exported(2, totalSamples);
    exported.clear();
    for (int ch = 0; ch < 2; ++ch)
        exported.copyFrom(ch,
                          0,
                          prerollRaw,
                          ch,
                          static_cast<int>(plan.discardSamples),
                          totalSamples);
    float exportLeftPeak = 0.0f;
    float exportRightPeak = 0.0f;
    const int exportLeftPeakIndex = peakIndex(exported, 0, &exportLeftPeak);
    const int exportRightPeakIndex = peakIndex(exported, 1, &exportRightPeak);

    json result;
    result["trackType"] = "Clip";
    result["rsNodeId"] = rsNode;
    result["setProcessingModeHighQualityOk"] = rsModeOk;
    result["setQualityHighOk"] = rsQualityOk;
    result["latency"] = {
        {"maxAudibleTrackLatencySamples", latency.maxAudibleTrackLatencySamples},
        {"masterInsertLatencySamples", latency.masterInsertLatencySamples}
    };
    result["liveRaw"] = {
        {"leftPeakIndex", leftPeakIndex},
        {"rightPeakIndex", rightPeakIndex},
        {"leftPeak", leftPeak},
        {"rightPeak", rightPeak},
        {"expectedPeakIndex", kImpulseSample + latency.maxAudibleTrackLatencySamples},
        {"aligned", leftPeakIndex >= 0 && leftPeakIndex == rightPeakIndex}
    };
    result["exportTrimmed"] = {
        {"leftPeakIndex", exportLeftPeakIndex},
        {"rightPeakIndex", exportRightPeakIndex},
        {"leftPeak", exportLeftPeak},
        {"rightPeak", exportRightPeak},
        {"expectedPeakIndex", kImpulseSample},
        {"prerollPlan", {
            {"renderStartSample", plan.renderStartSample},
            {"discardSamples", plan.discardSamples},
            {"totalPrerollSamples", plan.totalPrerollSamples}
        }},
        {"aligned", exportLeftPeakIndex >= 0 && exportLeftPeakIndex == exportRightPeakIndex}
    };
    result["pass"] = result["liveRaw"].value("aligned", false)
        && result["exportTrimmed"].value("aligned", false)
        && leftPeakIndex == kImpulseSample + latency.maxAudibleTrackLatencySamples
        && exportLeftPeakIndex == kImpulseSample;

    dir.deleteRecursively();
    return result;
}

json runRsDeclaredLatencyImpulse(double sampleRate, int blockSize)
{
    XlethResonanceSuppressorEffect fx;
    fx.setParameterValue("processing_mode", 1.0f);
    fx.setParameterValue("quality", 2.0f);
    fx.prepareToPlay(sampleRate, blockSize);

    const int declared = fx.getLatencySamples();
    const int total = declared + blockSize * 8;
    juce::AudioBuffer<float> block(2, blockSize);
    juce::MidiBuffer midi;
    std::vector<float> out(static_cast<std::size_t>(total), 0.0f);

    int written = 0;
    while (written < total) {
        block.clear();
        if (written == 0) {
            block.setSample(0, 0, 1.0f);
            block.setSample(1, 0, 1.0f);
        }
        fx.processBlock(block, midi);
        const int n = std::min(blockSize, total - written);
        for (int i = 0; i < n; ++i)
            out[static_cast<std::size_t>(written + i)] = block.getSample(0, i);
        written += n;
    }

    int measured = -1;
    float peak = 0.0f;
    for (int i = 0; i < total; ++i) {
        const float v = std::abs(out[static_cast<std::size_t>(i)]);
        if (v > peak) {
            peak = v;
            measured = i;
        }
    }

    json result;
    result["processing_mode"] = 1;
    result["quality"] = 2;
    result["fftSize"] = rsFftForQuality(2);
    result["hopSize"] = rsHopForQuality(2);
    result["declaredLatencySamples"] = declared;
    result["measuredImpulseDelaySamples"] = measured;
    result["peak"] = peak;
    result["matchesDeclaredLatency"] = measured == declared;
    return result;
}

std::string boolText(bool value)
{
    return value ? "yes" : "no";
}

const json* findTrackRow(const json& snapshot, int trackId)
{
    if (!snapshot.contains("tracks") || !snapshot["tracks"].is_array())
        return nullptr;
    for (const auto& row : snapshot["tracks"]) {
        if (row.value("trackId", -1) == trackId)
            return &row;
    }
    return nullptr;
}

json keyLatencyRows(const Timeline& timeline, const json& before, const json& after)
{
    json rows = json::array();
    for (const auto& requested : kRequestedTrackNames) {
        const TrackInfo* track = findTrackByRequestedName(timeline, requested);
        if (track == nullptr)
            continue;
        const json* b = findTrackRow(before, track->id);
        const json* a = findTrackRow(after, track->id);
        if (b == nullptr || a == nullptr)
            continue;
        rows.push_back({
            {"requestedName", requested},
            {"trackId", track->id},
            {"actualName", track->name},
            {"type", trackTypeToString(track->type)},
            {"beforeDeclaredLatencySamples", b->value("declaredLatencySamples", 0)},
            {"beforeCompensationSamples", b->value("compensationDelaySamples", 0)},
            {"afterDeclaredLatencySamples", a->value("declaredLatencySamples", 0)},
            {"afterCompensationSamples", a->value("compensationDelaySamples", 0)},
            {"afterExpectedCompensationSamples", a->value("expectedCompensationDelaySamples", 0)},
            {"afterCompensationMatchesExpected", a->value("compensationMatchesExpected", false)}
        });
    }
    return rows;
}

std::string classifyRootCause(const json& before,
                              const json& after,
                              const json& synthetic,
                              const json& rsImpulse)
{
    const bool mainParticipates =
        after.value("mainChrous", json::object()).value("participatesInPdc", false);
    const bool mainContributes =
        after.value("mainChrous", json::object()).value("contributesToMaxAudibleTrackLatency", false);
    if (!mainParticipates || !mainContributes)
        return "A. PDC accounting/inclusion bug";

    const bool exportFormula =
        after.value("exportPreroll", json::object()).value("matchesLiveTrackPlusMasterFormula", false);
    if (!exportFormula)
        return "B. Export preroll/discard bug";

    if (!rsImpulse.value("matchesDeclaredLatency", false))
        return "C. Resonance Suppressor declared-latency mismatch";

    if (!synthetic.value("pass", false))
        return "A. PDC accounting/inclusion bug";

    bool affectedOk = true;
    if (after.contains("tracks")) {
        for (const auto& row : after["tracks"]) {
            if (row.value("isAffectedReproTrack", false)
                && !row.value("compensationMatchesExpected", false)) {
                affectedOk = false;
                break;
            }
        }
    }
    if (!affectedOk)
        return "A. PDC accounting/inclusion bug";

    (void)before;
    return "F. Inconclusive, with exact missing data";
}

void writeMarkdownReport(const fs::path& path, const json& report)
{
    std::ofstream out(path);
    if (!out)
        throw std::runtime_error("failed to write markdown report");

    const json& before = report["latencyBefore"];
    const json& after = report["latencyAfter"];
    const json& keyRows = report["keyLatencyRows"];
    const json mutation = report.contains("mutation") ? report["mutation"] : json::object();

    auto findTrackInSnapshot = [](const json& snapshot, int trackId) -> const json* {
        if (!snapshot.contains("tracks") || !snapshot["tracks"].is_array())
            return nullptr;
        for (const auto& row : snapshot["tracks"]) {
            if (row.value("trackId", -1) == trackId)
                return &row;
        }
        return nullptr;
    };

    out << "# Stage 8A PDC Audible Export Diagnostic\n\n";
    out << "## Checkout\n";
    out << "- Branch: `" << report["git"].value("branch", "") << "`\n";
    out << "- HEAD: `" << report["git"].value("head", "") << "`\n";
    out << "- Status: `" << report["git"].value("statusShort", "") << "`\n\n";

    out << "## Project Safety\n";
    out << "- Original project: `" << report["paths"].value("originalProjectDir", "") << "`\n";
    out << "- Scratch project: `" << report["paths"].value("scratchProjectDir", "") << "`\n";
    out << "- Original project.json SHA-256 before: `"
        << report["originalUntouchedProof"].value("projectJsonSha256Before", "") << "`\n";
    out << "- Original project.json SHA-256 after: `"
        << report["originalUntouchedProof"].value("projectJsonSha256After", "") << "`\n";
    out << "- Original untouched: "
        << boolText(report["originalUntouchedProof"].value("untouched", false)) << "\n\n";

    out << "## MAIN CHROUS\n";
    const auto mainAfter = after.value("mainChrous", json::object());
    out << "- Track id/type: `" << mainAfter.value("trackId", -1)
        << "` / `" << mainAfter.value("trackType", "") << "`\n";
    out << "- Participates in PDC: "
        << boolText(mainAfter.value("participatesInPdc", false)) << "\n";
    out << "- Declared latency after RS HQ: "
        << mainAfter.value("declaredLatencySamples", 0) << " samples\n";
    out << "- Contributes to max audible track latency: "
        << boolText(mainAfter.value("contributesToMaxAudibleTrackLatency", false)) << "\n\n";

    const int mainTrackId = mainAfter.value("trackId", -1);
    const json* mainTrackBefore = findTrackInSnapshot(before, mainTrackId);
    const json* mainTrackAfter = findTrackInSnapshot(after, mainTrackId);

    if (mainTrackAfter != nullptr && mainTrackAfter->contains("effectChain")) {
        out << "## MAIN CHROUS Chain\n";
        out << "| Pos | Node | Effect | Bypassed | Reported latency | RS details |\n";
        out << "| ---: | ---: | --- | --- | ---: | --- |\n";
        for (const auto& fx : (*mainTrackAfter)["effectChain"]) {
            std::string rsDetails;
            if (fx.contains("resonanceSuppressor")) {
                const auto& rs = fx["resonanceSuppressor"];
                std::ostringstream rsText;
                rsText << "quality=" << rs.value("quality", -1)
                       << ", processing_mode=" << rs.value("processing_mode", -1)
                       << ", mode=" << rs.value("mode", -1)
                       << ", fft=" << rs.value("fftSize", 0)
                       << ", hop=" << rs.value("hopSize", 0)
                       << ", expected=" << rs.value("expectedHqLatencySamples", 0);
                rsDetails = rsText.str();
            }
            out << "| " << fx.value("position", -1) << " | "
                << fx.value("nodeId", -1) << " | "
                << fx.value("pluginId", "") << " / " << fx.value("name", "") << " | "
                << boolText(fx.value("bypassed", false)) << " | "
                << fx.value("reportedLatencySamples", 0) << " | "
                << rsDetails << " |\n";
        }
        out << "\n";
    }

    out << "## Mutation And Recompute\n";
    out << "- Route: `" << mutation.value("route", "") << "`\n";
    out << "- Existing MAIN CHROUS RS node reused: "
        << boolText(mutation.value("existingResonanceSuppressorReused", false)) << "\n";
    out << "- Bypass false / HQ processing / High quality set: "
        << boolText(mutation.value("setBypassFalseOk", false)) << " / "
        << boolText(mutation.value("setProcessingModeHighQualityOk", false)) << " / "
        << boolText(mutation.value("setQualityHighOk", false)) << "\n";
    out << "- MAIN CHROUS declared latency before/after mutation: "
        << (mainTrackBefore != nullptr ? mainTrackBefore->value("declaredLatencySamples", 0) : 0)
        << " -> "
        << (mainTrackAfter != nullptr ? mainTrackAfter->value("declaredLatencySamples", 0) : 0)
        << " samples\n";
    out << "- Recomputed maxAudibleTrackLatency before/after mutation: "
        << before.value("maxAudibleTrackLatencySamples", 0)
        << " -> "
        << after.value("maxAudibleTrackLatencySamples", 0)
        << " samples\n\n";

    out << "## Latency Summary\n";
    out << "| Snapshot | maxAudibleTrackLatency | masterInsertLatency | live track+master | export total preroll | export discard |\n";
    out << "| --- | ---: | ---: | ---: | ---: | ---: |\n";
    auto writeSummaryRow = [&](const json& s) {
        out << "| " << s.value("label", "") << " | "
            << s.value("maxAudibleTrackLatencySamples", 0) << " | "
            << s.value("masterInsertLatencySamples", 0) << " | "
            << s.value("livePresentationLatencySamplesExcludingDevice", 0) << " | "
            << s.value("exportPreroll", json::object()).value("totalPrerollSamples", 0) << " | "
            << s.value("exportPreroll", json::object()).value("discardSamples", 0) << " |\n";
    };
    writeSummaryRow(before);
    writeSummaryRow(after);
    out << "\n";

    out << "## Key Track Compensation\n";
    out << "| Track | id | type | before latency | before delay | after latency | after delay | expected after delay | ok |\n";
    out << "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |\n";
    for (const auto& row : keyRows) {
        out << "| " << row.value("actualName", "") << " | "
            << row.value("trackId", -1) << " | "
            << row.value("type", "") << " | "
            << row.value("beforeDeclaredLatencySamples", 0) << " | "
            << row.value("beforeCompensationSamples", 0) << " | "
            << row.value("afterDeclaredLatencySamples", 0) << " | "
            << row.value("afterCompensationSamples", 0) << " | "
            << row.value("afterExpectedCompensationSamples", 0) << " | "
            << boolText(row.value("afterCompensationMatchesExpected", false)) << " |\n";
    }
    out << "\n";

    out << "## Export Audit\n";
    out << "- Formula exposed by AudioExporter: `availablePreroll + maxAudibleTrackLatencySamples + masterInsertLatencySamples`\n";
    out << "- Export/live track+master formula match: "
        << boolText(after.value("exportPreroll", json::object()).value("matchesLiveTrackPlusMasterFormula", false)) << "\n";
    out << "- Master latency counted once: "
        << boolText(report["checks"].value("masterLatencyCountedOnce", false)) << "\n\n";

    out << "## Signal Tests\n";
    const json& rs = report["rsDeclaredLatencyImpulse"];
    out << "- RS HQ declared latency: " << rs.value("declaredLatencySamples", 0) << " samples\n";
    out << "- RS HQ measured impulse delay: " << rs.value("measuredImpulseDelaySamples", -1) << " samples\n";
    out << "- Declared latency matches observed signal delay: "
        << boolText(rs.value("matchesDeclaredLatency", false)) << "\n";
    out << "- Synthetic impulse PDC pass: "
        << boolText(report["syntheticImpulsePdc"].value("pass", false)) << "\n\n";

    out << "## Classification\n";
    out << "- Root cause classification: " << report.value("rootCauseClassification", "") << "\n";
    out << "- Stage 8B needed: " << boolText(report.value("stage8bNeeded", true)) << "\n";
    out << "- Recommended Stage 8B plan: " << report.value("recommendedStage8bPlan", "") << "\n\n";

    out << "## Missing Data\n";
    for (const auto& item : report["missingData"])
        out << "- " << item.get<std::string>() << "\n";
}

Options parseOptions(int argc, char** argv)
{
    Options options;
    options.projectDir = options.repoRoot / "diagnostics" / "pdc-stage8a" / "NO_MAIL_stage8a_copy";
    options.originalProjectDir = "C:/Users/Krasen/Desktop/SR/NO MAIL";
    options.jsonPath = options.repoRoot / "diagnostics" / "pdc-stage8a" / "pdc-audible-export-stage8a.json";
    options.markdownPath = options.repoRoot / "docs" / "diagnostics" / "pdc-audible-export-stage8a.md";

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto value = [&](const char* name) -> std::string {
            if (i + 1 >= argc)
                throw std::runtime_error(std::string("missing value for ") + name);
            return argv[++i];
        };

        if (arg == "--repo-root")
            options.repoRoot = value("--repo-root");
        else if (arg == "--project")
            options.projectDir = value("--project");
        else if (arg == "--original-project")
            options.originalProjectDir = value("--original-project");
        else if (arg == "--json")
            options.jsonPath = value("--json");
        else if (arg == "--markdown")
            options.markdownPath = value("--markdown");
        else if (arg == "--original-project-json-hash-before")
            options.originalHashBefore = value("--original-project-json-hash-before");
        else if (arg == "--block-size")
            options.blockSize = std::stoi(value("--block-size"));
        else if (arg == "--skip-media-load")
            options.loadMedia = false;
        else if (arg == "--help" || arg == "-h") {
            std::cout
                << "Usage: xleth_pdc_audible_diagnostic [options]\n"
                << "  --repo-root <path>\n"
                << "  --project <scratch project dir>\n"
                << "  --original-project <original project dir>\n"
                << "  --json <report json path>\n"
                << "  --markdown <report markdown path>\n"
                << "  --original-project-json-hash-before <sha256>\n"
                << "  --block-size <samples>\n"
                << "  --skip-media-load\n";
            std::exit(0);
        } else {
            throw std::runtime_error("unknown argument: " + arg);
        }
    }

    if (options.blockSize <= 0)
        throw std::runtime_error("block size must be positive");
    return options;
}

} // namespace

int main(int argc, char** argv)
{
    try {
        const Options options = parseOptions(argc, argv);
        fs::create_directories(options.jsonPath.parent_path());
        fs::create_directories(options.markdownPath.parent_path());

        const fs::path originalProjectJson = options.originalProjectDir / "project.json";
        const std::string originalHashBefore = options.originalHashBefore.empty()
            ? sha256File(originalProjectJson)
            : options.originalHashBefore;

        ProjectManager projectManager;
        auto loaded = projectManager.loadProject(options.projectDir.string());
        if (!loaded)
            throw std::runtime_error("failed to load scratch project");

        Timeline timeline = std::move(*loaded);
        const double sampleRate = timeline.getSampleRate() > 0.0
            ? timeline.getSampleRate()
            : kFallbackSampleRate;

        SampleBank sampleBank;
        MixEngine mix;
        mix.setTimeline(&timeline);
        mix.setSampleBank(&sampleBank);
        mix.prepare(sampleRate, options.blockSize);
        mix.setGlobalStretchMethod(timeline.getGlobalStretchMethod());

        json mediaLoad = {
            {"enabled", options.loadMedia},
            {"loadedRegions", 0},
            {"failedRegions", 0},
            {"regions", json::array()}
        };
        if (options.loadMedia) {
            MediaLoadResult load = loadMediaLikeBridge(timeline, sampleBank, mix, sampleRate);
            mediaLoad["loadedRegions"] = load.loaded;
            mediaLoad["failedRegions"] = load.failed;
            mediaLoad["regions"] = std::move(load.rows);
        }

        const auto& chains = projectManager.getLoadedEffectChains();
        if (chains.is_object()) {
            for (auto it = chains.begin(); it != chains.end(); ++it) {
                try {
                    mix.loadEffectChainFromJSON(std::stoi(it.key()), it.value());
                } catch (...) {
                }
            }
        }
        const auto& masterChain = projectManager.getLoadedMasterEffectChain();
        if (masterChain.is_object() && !masterChain.is_null())
            mix.loadMasterEffectChainFromJSON(masterChain);

        const int64_t transportSample = 0;
        pumpLatencyBlock(mix, timeline, sampleRate, options.blockSize, transportSample);
        json before = latencySnapshotJson("before RS HQ mutation",
                                          mix,
                                          timeline,
                                          transportSample,
                                          options.blockSize);

        json mutation = mutateMainChrousToRsHq(mix, timeline);
        pumpLatencyBlock(mix, timeline, sampleRate, options.blockSize, transportSample);
        json after = latencySnapshotJson("after RS HQ mutation",
                                         mix,
                                         timeline,
                                         transportSample,
                                         options.blockSize);

        const json synthetic = runSyntheticImpulsePdc(sampleRate, options.blockSize);
        const json rsImpulse = runRsDeclaredLatencyImpulse(sampleRate, options.blockSize);
        const json keyRows = keyLatencyRows(timeline, before, after);
        const std::string classification =
            classifyRootCause(before, after, synthetic, rsImpulse);

        const std::string originalHashAfter = sha256File(originalProjectJson);
        const bool untouched = !originalHashBefore.empty()
            && !originalHashAfter.empty()
            && originalHashBefore == originalHashAfter;

        const std::string gitBase = "git -C " + quoteForCommand(options.repoRoot);
        json report;
        report["generatedBy"] = "xleth_pdc_audible_diagnostic";
        report["git"] = {
            {"branch", runCommand(gitBase + " branch --show-current")},
            {"head", runCommand(gitBase + " log --oneline -1")},
            {"logOneline5", runCommand(gitBase + " log --oneline -5")},
            {"statusShort", runCommand(gitBase + " status --short")}
        };
        report["paths"] = {
            {"repoRoot", options.repoRoot.string()},
            {"originalProjectDir", options.originalProjectDir.string()},
            {"scratchProjectDir", options.projectDir.string()},
            {"jsonReport", options.jsonPath.string()},
            {"markdownReport", options.markdownPath.string()}
        };
        report["originalUntouchedProof"] = {
            {"projectJsonSha256Before", originalHashBefore},
            {"projectJsonSha256After", originalHashAfter},
            {"untouched", untouched}
        };
        report["project"] = {
            {"sampleRate", sampleRate},
            {"blockSize", options.blockSize},
            {"bpm", timeline.getBPM()},
            {"trackCount", timeline.getAllTracks().size()},
            {"clipCount", timeline.getAllClips().size()},
            {"patternBlockCount", timeline.getAllPatternBlocks().size()},
            {"sourceMediaAudit", sourceMediaAudit(timeline)},
            {"mediaLoad", std::move(mediaLoad)}
        };
        report["mutation"] = std::move(mutation);
        report["latencyBefore"] = std::move(before);
        report["latencyAfter"] = std::move(after);
        report["keyLatencyRows"] = keyRows;
        report["rsDeclaredLatencyImpulse"] = rsImpulse;
        report["syntheticImpulsePdc"] = synthetic;
        report["checks"] = {
            {"mainChrousParticipatesInPdc",
             report["latencyAfter"].value("mainChrous", json::object()).value("participatesInPdc", false)},
            {"mainChrousContributesToMaxAudibleTrackLatency",
             report["latencyAfter"].value("mainChrous", json::object()).value("contributesToMaxAudibleTrackLatency", false)},
            {"exportUsesLiveTrackPlusMasterFormula",
             report["latencyAfter"].value("exportPreroll", json::object()).value("matchesLiveTrackPlusMasterFormula", false)},
            {"masterLatencyCountedOnce",
             report["latencyAfter"].value("exportPreroll", json::object()).value("totalPrerollSamples", 0)
                 == report["latencyAfter"].value("maxAudibleTrackLatencySamples", 0)
                  + report["latencyAfter"].value("masterInsertLatencySamples", 0)}
        };
        report["rootCauseClassification"] = classification;
        report["stage8bNeeded"] = classification.rfind("F.", 0) == 0;
        report["recommendedStage8bPlan"] =
            classification.rfind("F.", 0) == 0
            ? "No PDC accounting/export formula defect reproduced by Stage 8A. Stage 8B should instrument the real render/live buffer path at the moment the user hears offset: capture per-track post-PDC stem peaks from the scratch project, include missing VST resolution state, and compare UI-configured RS HQ node state against the loaded engine state."
            : "Implement the classified fix narrowly, then rerun this diagnostic and the Stage 1/export PDC regression tests.";
        report["missingData"] = json::array({
            "No direct per-track post-PDC stem tap exists in MixEngine, so the real project signal-alignment test uses accounting plus a synthetic impulse PDC render.",
            "The diagnostic does not save the scratch project after mutation; it mutates the loaded MixEngine chain in memory only.",
            "If a third-party VST is missing on this machine, its real latency cannot be observed by this stock-effect diagnostic run."
        });

        {
            std::ofstream jsonOut(options.jsonPath);
            jsonOut << report.dump(2) << "\n";
        }
        writeMarkdownReport(options.markdownPath, report);

        std::cout << "Wrote JSON: " << options.jsonPath.string() << "\n";
        std::cout << "Wrote Markdown: " << options.markdownPath.string() << "\n";
        std::cout << "Classification: " << classification << "\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "[xleth_pdc_audible_diagnostic] ERROR: " << e.what() << "\n";
        return 1;
    }
}
