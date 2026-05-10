#include "SampleBank.h"
#include "Transport.h"
#include "audio/MixEngine.h"
#include "audio/XlethEffectBase.h"
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
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <numeric>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace {

namespace fs = std::filesystem;
using json = nlohmann::json;

constexpr int kLiveBlockSize = 512;
constexpr int kOfflineBlockSize = 4096;
constexpr double kFallbackSampleRate = 48000.0;
constexpr double kDefaultCaptureSeconds = 5.0;
constexpr double kDefaultScanSeconds = 150.0;
constexpr float kSignalThreshold = 1.0e-4f;

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

const std::set<std::string> kDrumReferenceNames = {"KICK", "SNARE", "CH", "OH"};

struct Options {
    fs::path repoRoot = fs::current_path();
    fs::path projectDir;
    fs::path originalProjectDir = "C:/Users/Krasen/Desktop/SR/NO MAIL";
    fs::path jsonPath;
    fs::path markdownPath;
    std::string scratchSource;
    std::string stageName = "Stage 8B";
    std::string reportTitle = "Stage 8B Real-Signal PDC Tap Diagnostic";
    int liveBlockSize = kLiveBlockSize;
    int offlineBlockSize = kOfflineBlockSize;
    double captureSeconds = kDefaultCaptureSeconds;
    double scanSeconds = kDefaultScanSeconds;
    int64_t manualStartSample = -1;
    bool loadMedia = true;
};

std::string trim(std::string s)
{
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ' || s.back() == '\t'))
        s.pop_back();
    std::size_t first = 0;
    while (first < s.size() && (s[first] == '\n' || s[first] == '\r' || s[first] == ' ' || s[first] == '\t'))
        ++first;
    return first > 0 ? s.substr(first) : s;
}

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

json loadJsonFileOr(const fs::path& path, json fallback)
{
    std::ifstream in(path);
    if (!in)
        return fallback;
    try {
        json j;
        in >> j;
        return j;
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

const TrackInfo* findTrackByRequestedName(const Timeline& timeline, const std::string& name)
{
    for (const TrackInfo* track : timeline.getAllTracks()) {
        if (track != nullptr && requestedNameMatches(track->name, name))
            return track;
    }
    return nullptr;
}

std::string tapPointToString(MixEngine::DiagnosticTapPoint point)
{
    switch (point) {
        case MixEngine::DiagnosticTapPoint::PrePdcTrack: return "pre_pdc_track";
        case MixEngine::DiagnosticTapPoint::PostPdcTrack: return "post_pdc_track";
        case MixEngine::DiagnosticTapPoint::MasterInputSum: return "master_input_sum";
        case MixEngine::DiagnosticTapPoint::PostMasterOutput: return "post_master_output";
    }
    return "unknown";
}

std::string boolText(bool v)
{
    return v ? "yes" : "no";
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

int rsFftOrderForQuality(int qualityIndex)
{
    switch (std::clamp(qualityIndex, 0, 2)) {
        case 0: return 9;
        case 2: return 11;
        case 1:
        default: return 10;
    }
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
        row["reportedLatencySamples"] = effect != nullptr ? json(effect->getLatencySamples()) : json(nullptr);
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
                {"fftSize", processingMode == 1 ? rsLatencyForQuality(quality) : 0},
                {"hopSize", processingMode == 1 ? rsHopForQuality(quality) : 0},
                {"expectedHqLatencySamples", processingMode == 1 ? rsLatencyForQuality(quality) : 0},
            };
        }

        rows.push_back(std::move(row));
    }
    return rows;
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

int refreshClipCachesLikeBridge(const Timeline& timeline, MixEngine& mix)
{
    int submitted = 0;
    for (const Clip* clip : timeline.getAllClips()) {
        if (clip == nullptr)
            continue;
        const bool needs = clip->pitchOffset != 0
            || clip->pitchOffsetCents != 0
            || clip->reversed
            || clip->stretchRatio != 1.0;
        if (needs) {
            mix.invalidateClipCache(clip->id, "xleth_pdc_real_signal_tap");
            ++submitted;
        }
    }
    return submitted;
}

int64_t projectEndSample(const Timeline& timeline, double sampleRate)
{
    const double bpm = timeline.getBPM();
    int64_t end = 0;
    for (const Clip* clip : timeline.getAllClips()) {
        if (clip == nullptr)
            continue;
        end = std::max(end, (clip->position + clip->duration).toSamples(bpm, sampleRate));
    }
    for (const PatternBlock* block : timeline.getAllPatternBlocks()) {
        if (block == nullptr)
            continue;
        end = std::max(end, (block->position + block->duration).toSamples(bpm, sampleRate));
    }
    return end;
}

struct SignalStats {
    double peak = 0.0;
    double rms = 0.0;
    int64_t firstSignificant = -1;
    int transientCount = 0;
    std::vector<int64_t> transientCandidates;
};

SignalStats analyzeSamples(const std::vector<float>& data, int64_t baseSample = 0)
{
    SignalStats stats;
    if (data.empty())
        return stats;

    long double sumSquares = 0.0;
    float previousEnvelope = 0.0f;
    int refractory = 0;
    for (std::size_t i = 0; i < data.size(); ++i) {
        const float v = std::abs(data[i]);
        stats.peak = std::max(stats.peak, static_cast<double>(v));
        sumSquares += static_cast<long double>(data[i]) * static_cast<long double>(data[i]);
        if (stats.firstSignificant < 0 && v >= kSignalThreshold)
            stats.firstSignificant = baseSample + static_cast<int64_t>(i);

        const float rise = v - previousEnvelope;
        if (refractory > 0) {
            --refractory;
        } else if (v >= kSignalThreshold * 2.0f && rise >= std::max(0.02f, previousEnvelope * 1.5f)) {
            ++stats.transientCount;
            if (stats.transientCandidates.size() < 16)
                stats.transientCandidates.push_back(baseSample + static_cast<int64_t>(i));
            refractory = 512;
        }
        previousEnvelope = previousEnvelope * 0.995f + v * 0.005f;
    }
    stats.rms = std::sqrt(static_cast<double>(sumSquares / static_cast<long double>(data.size())));
    return stats;
}

SignalStats analyzeBufferRange(const juce::AudioBuffer<float>& buffer, int offset, int count, int64_t baseSample)
{
    std::vector<float> mono(static_cast<std::size_t>(std::max(0, count)), 0.0f);
    const int channels = std::min(2, buffer.getNumChannels());
    if (channels <= 0)
        return {};
    for (int i = 0; i < count; ++i) {
        float v = 0.0f;
        for (int ch = 0; ch < channels; ++ch)
            v += buffer.getSample(ch, offset + i);
        mono[static_cast<std::size_t>(i)] = v / static_cast<float>(channels);
    }
    return analyzeSamples(mono, baseSample);
}

json statsToJson(const SignalStats& stats)
{
    json j;
    j["peak"] = stats.peak;
    j["rms"] = stats.rms;
    j["firstSignificantSample"] = stats.firstSignificant >= 0 ? json(stats.firstSignificant) : json(nullptr);
    j["transientCandidateCount"] = stats.transientCount;
    j["transientCandidates"] = stats.transientCandidates;
    return j;
}

struct LagResult {
    bool valid = false;
    int lagSamples = 0;
    double coefficient = 0.0;
    std::string reason;
};

std::vector<double> envelopeBins(const std::vector<float>& data, int stride)
{
    const int safeStride = std::max(1, stride);
    const std::size_t bins = (data.size() + static_cast<std::size_t>(safeStride) - 1)
        / static_cast<std::size_t>(safeStride);
    std::vector<double> out(bins, 0.0);
    for (std::size_t b = 0; b < bins; ++b) {
        const std::size_t begin = b * static_cast<std::size_t>(safeStride);
        const std::size_t end = std::min(data.size(), begin + static_cast<std::size_t>(safeStride));
        double sum = 0.0;
        for (std::size_t i = begin; i < end; ++i)
            sum += std::abs(data[i]);
        out[b] = sum / static_cast<double>(std::max<std::size_t>(1, end - begin));
    }
    return out;
}

LagResult estimateLag(const std::vector<float>& reference,
                      const std::vector<float>& target,
                      int maxLagSamples,
                      int stride = 16)
{
    LagResult result;
    if (reference.empty() || target.empty()) {
        result.reason = "empty signal";
        return result;
    }
    const SignalStats aStats = analyzeSamples(reference);
    const SignalStats bStats = analyzeSamples(target);
    if (aStats.peak < kSignalThreshold || bStats.peak < kSignalThreshold) {
        result.reason = "signal below threshold";
        return result;
    }

    const auto a = envelopeBins(reference, stride);
    const auto b = envelopeBins(target, stride);
    const int nA = static_cast<int>(a.size());
    const int nB = static_cast<int>(b.size());
    if (nA < 8 || nB < 8) {
        result.reason = "too few envelope bins";
        return result;
    }

    const int maxLagBins = std::max(1, std::min(maxLagSamples / stride, std::min(nA, nB) / 2));
    double best = -std::numeric_limits<double>::infinity();
    int bestLag = 0;
    int bestN = 0;

    for (int lag = -maxLagBins; lag <= maxLagBins; ++lag) {
        const int startA = std::max(0, -lag);
        const int startB = std::max(0, lag);
        const int count = std::min(nA - startA, nB - startB);
        if (count < 16)
            continue;

        double meanA = 0.0;
        double meanB = 0.0;
        for (int i = 0; i < count; ++i) {
            meanA += a[static_cast<std::size_t>(startA + i)];
            meanB += b[static_cast<std::size_t>(startB + i)];
        }
        meanA /= static_cast<double>(count);
        meanB /= static_cast<double>(count);

        double numerator = 0.0;
        double denomA = 0.0;
        double denomB = 0.0;
        for (int i = 0; i < count; ++i) {
            const double da = a[static_cast<std::size_t>(startA + i)] - meanA;
            const double db = b[static_cast<std::size_t>(startB + i)] - meanB;
            numerator += da * db;
            denomA += da * da;
            denomB += db * db;
        }
        if (denomA <= 1.0e-16 || denomB <= 1.0e-16)
            continue;
        const double corr = numerator / std::sqrt(denomA * denomB);
        if (corr > best) {
            best = corr;
            bestLag = lag;
            bestN = count;
        }
    }

    if (!std::isfinite(best)) {
        result.reason = "no finite correlation";
        return result;
    }

    result.valid = true;
    result.lagSamples = bestLag * stride;
    result.coefficient = best;
    result.reason = bestN >= 16 ? "ok" : "low overlap";
    return result;
}

json lagToJson(const LagResult& lag)
{
    json j;
    j["valid"] = lag.valid;
    j["lagSamples"] = lag.valid ? json(lag.lagSamples) : json(nullptr);
    j["coefficient"] = lag.valid ? json(lag.coefficient) : json(nullptr);
    j["reason"] = lag.reason;
    return j;
}

struct TrackSelection {
    std::string requestedName;
    int trackId = -1;
    std::string actualName;
    std::string type;
    bool found = false;
};

std::vector<TrackSelection> resolveRequestedTracks(const Timeline& timeline)
{
    std::vector<TrackSelection> out;
    for (const std::string& requested : kRequestedTrackNames) {
        TrackSelection row;
        row.requestedName = requested;
        if (const TrackInfo* track = findTrackByRequestedName(timeline, requested)) {
            row.trackId = track->id;
            row.actualName = track->name;
            row.type = trackTypeToString(track->type);
            row.found = true;
        }
        out.push_back(std::move(row));
    }
    return out;
}

json selectionsToJson(const std::vector<TrackSelection>& selections)
{
    json rows = json::array();
    for (const auto& s : selections) {
        rows.push_back({
            {"requestedName", s.requestedName},
            {"found", s.found},
            {"trackId", s.found ? json(s.trackId) : json(nullptr)},
            {"actualName", s.actualName},
            {"type", s.type},
        });
    }
    return rows;
}

class ScanTapSink final : public MixEngine::DiagnosticTapSink {
public:
    struct TrackBin {
        double peak = 0.0;
        long double sumSquares = 0.0;
        int64_t samples = 0;
        int transientCount = 0;
        bool hadAudio = false;
    };

    struct Bin {
        int64_t startSample = 0;
        std::unordered_map<int, TrackBin> tracks;
    };

    ScanTapSink(std::set<int> trackIds, int64_t binSamples)
        : trackIds_(std::move(trackIds))
        , binSamples_(std::max<int64_t>(1, binSamples))
    {
    }

    bool wantsTrack(int trackId) const override
    {
        return trackIds_.count(trackId) > 0;
    }

    void capture(const MixEngine::DiagnosticTapBlock& block) override
    {
        if (block.point != MixEngine::DiagnosticTapPoint::PrePdcTrack
            || block.buffer == nullptr
            || block.trackId < 0
            || block.numSamples <= 0) {
            return;
        }

        const int64_t bin = block.transportStartSample / binSamples_;
        auto& row = bins_[bin];
        row.startSample = bin * binSamples_;
        auto& track = row.tracks[block.trackId];
        const SignalStats stats =
            analyzeBufferRange(*block.buffer, 0, block.numSamples, block.transportStartSample);
        track.peak = std::max(track.peak, stats.peak);
        track.sumSquares += static_cast<long double>(stats.rms * stats.rms)
            * static_cast<long double>(block.numSamples);
        track.samples += block.numSamples;
        track.transientCount += stats.transientCount;
        track.hadAudio = track.hadAudio || block.hadAudio || stats.peak >= kSignalThreshold;
    }

    const std::map<int64_t, Bin>& bins() const { return bins_; }

private:
    std::set<int> trackIds_;
    int64_t binSamples_ = 1;
    std::map<int64_t, Bin> bins_;
};

struct CaptureBlockSummary {
    uint64_t blockIndex = 0;
    int64_t transportStartSample = 0;
    int offsetInBlock = 0;
    int samples = 0;
    SignalStats stats;
    bool hadAudio = false;
    bool tailing = false;
    bool chainsLocked = false;
};

struct CapturedStream {
    std::string mode;
    MixEngine::DiagnosticTapPoint point = MixEngine::DiagnosticTapPoint::PrePdcTrack;
    int trackId = -1;
    std::string trackName;
    std::string trackType;
    bool muted = false;
    bool solo = false;
    bool visualOnly = false;
    bool audible = false;
    int declaredLatencySamples = 0;
    int compensationDelaySamples = 0;
    int maxAudibleTrackLatencySamples = 0;
    int masterInsertLatencySamples = 0;
    std::vector<float> mono;
    std::vector<CaptureBlockSummary> blocks;
};

std::string captureKey(const std::string& mode, MixEngine::DiagnosticTapPoint point, int trackId)
{
    return mode + "|" + tapPointToString(point) + "|" + std::to_string(trackId);
}

class CaptureTapSink final : public MixEngine::DiagnosticTapSink {
public:
    CaptureTapSink(std::string mode,
                   std::set<int> trackIds,
                   int64_t captureStart,
                   int64_t captureEnd)
        : mode_(std::move(mode))
        , trackIds_(std::move(trackIds))
        , captureStart_(captureStart)
        , captureEnd_(captureEnd)
    {
        windowSamples_ = static_cast<int>(std::max<int64_t>(0, captureEnd_ - captureStart_));
    }

    bool wantsTrack(int trackId) const override
    {
        return trackIds_.count(trackId) > 0;
    }

    void capture(const MixEngine::DiagnosticTapBlock& block) override
    {
        if (block.buffer == nullptr || block.numSamples <= 0 || windowSamples_ <= 0)
            return;
        if (block.point != MixEngine::DiagnosticTapPoint::PrePdcTrack
            && block.point != MixEngine::DiagnosticTapPoint::PostPdcTrack
            && block.point != MixEngine::DiagnosticTapPoint::MasterInputSum
            && block.point != MixEngine::DiagnosticTapPoint::PostMasterOutput) {
            return;
        }
        if (block.trackId >= 0 && trackIds_.count(block.trackId) == 0)
            return;

        const int64_t blockStart = block.transportStartSample;
        const int64_t blockEnd = blockStart + block.numSamples;
        const int64_t overlapStart = std::max(blockStart, captureStart_);
        const int64_t overlapEnd = std::min(blockEnd, captureEnd_);
        if (overlapEnd <= overlapStart)
            return;

        const int offsetInBlock = static_cast<int>(overlapStart - blockStart);
        const int count = static_cast<int>(overlapEnd - overlapStart);
        const int offsetInCapture = static_cast<int>(overlapStart - captureStart_);

        const std::string key = captureKey(mode_, block.point, block.trackId);
        auto& stream = streams_[key];
        if (stream.mono.empty()) {
            stream.mode = mode_;
            stream.point = block.point;
            stream.trackId = block.trackId;
            stream.trackName = block.trackName != nullptr ? block.trackName : "";
            stream.trackType = block.trackId >= 0 ? trackTypeToString(block.trackType) : "Bus";
            stream.muted = block.muted;
            stream.solo = block.solo;
            stream.visualOnly = block.visualOnly;
            stream.audible = block.audible;
            stream.declaredLatencySamples = block.declaredLatencySamples;
            stream.compensationDelaySamples = block.compensationDelaySamples;
            stream.maxAudibleTrackLatencySamples = block.maxAudibleTrackLatencySamples;
            stream.masterInsertLatencySamples = block.masterInsertLatencySamples;
            stream.mono.assign(static_cast<std::size_t>(windowSamples_), 0.0f);
        }

        const int channels = std::min(2, block.buffer->getNumChannels());
        if (channels > 0) {
            for (int i = 0; i < count; ++i) {
                float v = 0.0f;
                for (int ch = 0; ch < channels; ++ch)
                    v += block.buffer->getSample(ch, offsetInBlock + i);
                stream.mono[static_cast<std::size_t>(offsetInCapture + i)] =
                    v / static_cast<float>(channels);
            }
        }

        CaptureBlockSummary summary;
        summary.blockIndex = block.blockIndex;
        summary.transportStartSample = block.transportStartSample;
        summary.offsetInBlock = offsetInBlock;
        summary.samples = count;
        summary.stats = analyzeBufferRange(*block.buffer, offsetInBlock, count, overlapStart);
        summary.hadAudio = block.hadAudio;
        summary.tailing = block.tailing;
        summary.chainsLocked = block.chainsLocked;
        stream.blocks.push_back(std::move(summary));
    }

    const std::map<std::string, CapturedStream>& streams() const { return streams_; }

private:
    std::string mode_;
    std::set<int> trackIds_;
    int64_t captureStart_ = 0;
    int64_t captureEnd_ = 0;
    int windowSamples_ = 0;
    std::map<std::string, CapturedStream> streams_;
};

void renderRange(MixEngine& mix,
                 const Timeline& timeline,
                 MixEngine::DiagnosticTapSink* sink,
                 const std::string& mode,
                 int64_t renderStart,
                 int64_t renderEnd,
                 int blockSize,
                 bool nonRealtime)
{
    juce::ignoreUnused(mode);
    Transport transport;
    transport.setSampleRate(timeline.getSampleRate() > 0.0 ? timeline.getSampleRate() : kFallbackSampleRate);
    transport.setBPM(timeline.getBPM());
    transport.seekToSample(renderStart);
    transport.play();

    mix.setDiagnosticTapSink(sink);
    mix.setNonRealtime(nonRealtime);

    juce::AudioBuffer<float> block(2, blockSize);
    int64_t current = renderStart;
    while (current < renderEnd) {
        const int n = static_cast<int>(std::min<int64_t>(blockSize, renderEnd - current));
        if (block.getNumSamples() != n)
            block.setSize(2, n, false, false, true);
        block.clear();
        mix.processBlock(block, n, transport);
        transport.advance(n);
        current += n;
    }

    mix.setDiagnosticTapSink(nullptr);
    mix.setNonRealtime(false);
    transport.pause();
}

json streamToJson(const CapturedStream& stream, int64_t captureStart)
{
    SignalStats full = analyzeSamples(stream.mono, captureStart);
    json blocks = json::array();
    for (const auto& block : stream.blocks) {
        blocks.push_back({
            {"blockIndex", block.blockIndex},
            {"transportStartSample", block.transportStartSample},
            {"offsetInBlock", block.offsetInBlock},
            {"samples", block.samples},
            {"hadAudio", block.hadAudio},
            {"tailing", block.tailing},
            {"chainsLocked", block.chainsLocked},
            {"stats", statsToJson(block.stats)},
        });
    }
    return {
        {"mode", stream.mode},
        {"tapPoint", tapPointToString(stream.point)},
        {"trackId", stream.trackId},
        {"trackName", stream.trackName},
        {"trackType", stream.trackType},
        {"muted", stream.muted},
        {"solo", stream.solo},
        {"visualOnly", stream.visualOnly},
        {"audible", stream.audible},
        {"declaredLatencySamples", stream.declaredLatencySamples},
        {"compensationDelaySamples", stream.compensationDelaySamples},
        {"maxAudibleTrackLatencySamples", stream.maxAudibleTrackLatencySamples},
        {"masterInsertLatencySamples", stream.masterInsertLatencySamples},
        {"fullWindowStats", statsToJson(full)},
        {"capturedBlockCount", blocks.size()},
        {"blocks", blocks},
    };
}

struct WindowChoice {
    int64_t startSample = 0;
    int64_t endSample = 0;
    bool automatic = true;
    bool sufficient = false;
    std::string reason;
    double score = 0.0;
};

WindowChoice chooseWindow(const ScanTapSink& scan,
                          const std::vector<TrackSelection>& selections,
                          double sampleRate,
                          double captureSeconds,
                          int64_t manualStartSample)
{
    const int64_t captureSamples =
        std::max<int64_t>(1, static_cast<int64_t>(std::llround(captureSeconds * sampleRate)));
    if (manualStartSample >= 0) {
        return {manualStartSample,
                manualStartSample + captureSamples,
                false,
                true,
                "manual start sample supplied",
                0.0};
    }

    int mainId = -1;
    std::set<int> drumIds;
    for (const auto& s : selections) {
        if (!s.found)
            continue;
        if (requestedNameMatches(s.requestedName, "MAIN CHROUS"))
            mainId = s.trackId;
        if (kDrumReferenceNames.count(normalizeName(s.requestedName)) > 0)
            drumIds.insert(s.trackId);
    }

    WindowChoice best;
    best.endSample = captureSamples;
    best.reason = "no scan bins contained MAIN CHROUS plus drum/reference energy";
    const int64_t binSamples = static_cast<int64_t>(std::llround(sampleRate));
    const int binsPerWindow = std::max<int>(1, static_cast<int>(std::ceil(captureSeconds)));

    if (scan.bins().empty()) {
        best.reason = "scan produced no tapped audio bins";
        return best;
    }

    for (auto it = scan.bins().begin(); it != scan.bins().end(); ++it) {
        const int64_t firstBin = it->first;
        double mainPeak = 0.0;
        double mainRmsScore = 0.0;
        int drumActive = 0;
        int targetActive = 0;
        int transients = 0;

        for (int b = 0; b < binsPerWindow; ++b) {
            auto binIt = scan.bins().find(firstBin + b);
            if (binIt == scan.bins().end())
                continue;
            for (const auto& [trackId, stats] : binIt->second.tracks) {
                const double rms = stats.samples > 0
                    ? std::sqrt(static_cast<double>(stats.sumSquares / static_cast<long double>(stats.samples)))
                    : 0.0;
                if (trackId == mainId) {
                    mainPeak = std::max(mainPeak, stats.peak);
                    mainRmsScore += rms;
                }
                if (stats.peak >= kSignalThreshold) {
                    ++targetActive;
                    if (drumIds.count(trackId) > 0)
                        ++drumActive;
                }
                transients += stats.transientCount;
            }
        }

        const bool hasMain = mainId >= 0 && mainPeak >= kSignalThreshold;
        const bool hasDrum = drumActive > 0;
        const double score = (hasMain ? 1000.0 : 0.0)
            + (hasDrum ? 500.0 : 0.0)
            + mainRmsScore * 200.0
            + static_cast<double>(targetActive) * 10.0
            + static_cast<double>(transients);

        if (score > best.score) {
            best.score = score;
            best.startSample = firstBin * binSamples;
            best.endSample = best.startSample + captureSamples;
            best.sufficient = hasMain && hasDrum;
            best.reason = hasMain && hasDrum
                ? "highest-scoring window with MAIN CHROUS and drum/reference energy"
                : "fallback highest-energy window, but required comparable tracks were weak";
        }
    }

    return best;
}

json latencyRows(MixEngine& mix, const Timeline& timeline, const std::vector<TrackSelection>& selections)
{
    const auto snapshot = mix.getLatencyCompensationSnapshot();
    bool anySolo = false;
    for (const TrackInfo* track : timeline.getAllTracks()) {
        if (track != nullptr && track->solo) {
            anySolo = true;
            break;
        }
    }

    json rows = json::array();
    for (const auto& s : selections) {
        json row;
        row["requestedName"] = s.requestedName;
        row["found"] = s.found;
        if (!s.found) {
            rows.push_back(std::move(row));
            continue;
        }
        const TrackInfo* track = timeline.getTrack(s.trackId);
        const bool audible = track != nullptr && (anySolo ? track->solo : !track->muted);
        const int declared = mix.getTrackInsertLatencySamples(s.trackId);
        const int compensation = mix.getTrackCompensationDelaySamples(s.trackId);
        const int expected = (track != nullptr && audible && !track->visualOnly)
            ? std::max(0, snapshot.maxAudibleTrackLatencySamples - declared)
            : 0;
        row["trackId"] = s.trackId;
        row["trackName"] = s.actualName;
        row["type"] = s.type;
        row["muted"] = track != nullptr ? track->muted : false;
        row["solo"] = track != nullptr ? track->solo : false;
        row["visualOnly"] = track != nullptr ? track->visualOnly : false;
        row["audible"] = audible;
        row["declaredLatencySamples"] = declared;
        row["compensationDelaySamples"] = compensation;
        row["expectedCompensationDelaySamples"] = expected;
        row["compensationMatchesExpected"] = compensation == expected;
        row["effectChain"] = effectRowsForTrack(mix, s.trackId);
        rows.push_back(std::move(row));
    }
    return rows;
}

json missingPluginRows(const json& latency)
{
    json rows = json::array();
    for (const auto& track : latency) {
        if (!track.value("found", false) || !track.contains("effectChain"))
            continue;
        for (const auto& fx : track["effectChain"]) {
            if (fx.value("missing", false) || fx.value("crashed", false)) {
                rows.push_back({
                    {"trackId", track.value("trackId", -1)},
                    {"trackName", track.value("trackName", "")},
                    {"nodeId", fx.value("nodeId", -1)},
                    {"pluginId", fx.value("pluginId", "")},
                    {"name", fx.value("name", "")},
                    {"missing", fx.value("missing", false)},
                    {"crashed", fx.value("crashed", false)},
                    {"reportedLatencySamples", fx.value("reportedLatencySamples", json(nullptr))},
                });
            }
        }
    }
    return rows;
}

const CapturedStream* findStream(const std::map<std::string, CapturedStream>& streams,
                                 const std::string& mode,
                                 MixEngine::DiagnosticTapPoint point,
                                 int trackId)
{
    auto it = streams.find(captureKey(mode, point, trackId));
    return it != streams.end() ? &it->second : nullptr;
}

json analyzeAlignment(const std::vector<TrackSelection>& selections,
                      const std::map<std::string, CapturedStream>& live,
                      const std::map<std::string, CapturedStream>& offline,
                      int64_t captureStart)
{
    json rows = json::array();
    int mainId = -1;
    for (const auto& s : selections) {
        if (s.found && requestedNameMatches(s.requestedName, "MAIN CHROUS"))
            mainId = s.trackId;
    }
    const CapturedStream* liveMainPost =
        findStream(live, "live-style", MixEngine::DiagnosticTapPoint::PostPdcTrack, mainId);

    for (const auto& s : selections) {
        if (!s.found)
            continue;
        const CapturedStream* pre =
            findStream(live, "live-style", MixEngine::DiagnosticTapPoint::PrePdcTrack, s.trackId);
        const CapturedStream* post =
            findStream(live, "live-style", MixEngine::DiagnosticTapPoint::PostPdcTrack, s.trackId);
        const CapturedStream* offlinePost =
            findStream(offline, "export-offline", MixEngine::DiagnosticTapPoint::PostPdcTrack, s.trackId);

        json row;
        row["trackId"] = s.trackId;
        row["trackName"] = s.actualName;
        row["requestedName"] = s.requestedName;
        row["type"] = s.type;

        if (pre != nullptr)
            row["prePdcStats"] = statsToJson(analyzeSamples(pre->mono, captureStart));
        if (post != nullptr)
            row["postPdcStats"] = statsToJson(analyzeSamples(post->mono, captureStart));

        const int expected = post != nullptr ? post->compensationDelaySamples : 0;
        row["expectedPreToPostLagSamples"] = expected;

        if (pre != nullptr && post != nullptr) {
            const int maxLag = std::max(4096, expected + 4096);
            row["observedPreToPostLag"] = lagToJson(estimateLag(pre->mono, post->mono, maxLag));
            row["pdcDelayObservedNearExpected"] =
                row["observedPreToPostLag"].value("valid", false)
                && std::abs(row["observedPreToPostLag"].value("lagSamples", 0) - expected) <= 64
                && row["observedPreToPostLag"].value("coefficient", 0.0) >= 0.35;
        } else {
            row["observedPreToPostLag"] = lagToJson({false, 0, 0.0, "missing pre/post capture"});
            row["pdcDelayObservedNearExpected"] = false;
        }

        if (post != nullptr && liveMainPost != nullptr && s.trackId != mainId) {
            row["observedPostPdcLagVsMainChrous"] =
                lagToJson(estimateLag(liveMainPost->mono, post->mono, 24000));
        } else if (s.trackId == mainId) {
            row["observedPostPdcLagVsMainChrous"] =
                lagToJson({true, 0, 1.0, "reference track"});
        } else {
            row["observedPostPdcLagVsMainChrous"] =
                lagToJson({false, 0, 0.0, "missing MAIN CHROUS or post-PDC capture"});
        }

        if (post != nullptr && offlinePost != nullptr) {
            row["liveVsExportOfflinePostPdcLag"] =
                lagToJson(estimateLag(post->mono, offlinePost->mono, 24000));
            const auto& lag = row["liveVsExportOfflinePostPdcLag"];
            row["liveVsExportOfflineSameAlignment"] =
                lag.value("valid", false)
                && std::abs(lag.value("lagSamples", 0)) <= 64
                && lag.value("coefficient", 0.0) >= 0.60;
        } else {
            row["liveVsExportOfflinePostPdcLag"] =
                lagToJson({false, 0, 0.0, "missing live or offline post-PDC capture"});
            row["liveVsExportOfflineSameAlignment"] = false;
        }

        rows.push_back(std::move(row));
    }
    return rows;
}

std::string classifyRootCause(const json& alignmentRows,
                              const json& missingPlugins,
                              bool windowSufficient)
{
    bool anyExpectedDelay = false;
    bool anyPdcObservedMismatch = false;
    bool anyPdcComparable = false;
    bool offlineMismatch = false;
    bool lowComparable = false;

    for (const auto& row : alignmentRows) {
        const int expected = row.value("expectedPreToPostLagSamples", 0);
        if (expected > 0)
            anyExpectedDelay = true;
        const auto prePost = row.value("observedPreToPostLag", json::object());
        if (prePost.value("valid", false) && prePost.value("coefficient", 0.0) >= 0.35) {
            anyPdcComparable = true;
            if (!row.value("pdcDelayObservedNearExpected", false) && expected > 0)
                anyPdcObservedMismatch = true;
        } else if (expected > 0) {
            lowComparable = true;
        }

        const auto liveOffline = row.value("liveVsExportOfflinePostPdcLag", json::object());
        if (liveOffline.value("valid", false)
            && liveOffline.value("coefficient", 0.0) >= 0.60
            && std::abs(liveOffline.value("lagSamples", 0)) > 64) {
            offlineMismatch = true;
        }
    }

    if (offlineMismatch)
        return "C. Export/offline path mismatch";
    if (anyExpectedDelay && anyPdcComparable && anyPdcObservedMismatch)
        return "A. PDC delay not applied to real buffers";
    if (!missingPlugins.empty())
        return "D. Plugin placeholder/state latency mismatch";
    if (!windowSufficient || lowComparable)
        return "F. Capture window insufficient/inconclusive";
    return "B. Pre-PDC source/clip/stretch/decode timing already wrong or not proven by cross-track correlation";
}

std::string recommendedFixForClassification(const std::string& classification)
{
    if (classification.rfind("A.", 0) == 0) {
        return "Stage 8C should fix MixEngine's real track-buffer compensation path so a track compensation delay reset cannot leave the delay line at 0 while cached compensation still says a nonzero delay is active. Reapply the target delay after reset or force retarget when audio resumes, then add a regression that taps pre/post PDC on real project material and verifies observed lag equals compensation delay.";
    }
    if (classification.rfind("B.", 0) == 0) {
        return "Stage 8C should trace clip/source/stretch/decode timing before PDC: compare region offsets, processed clip-cache keys, syllable offsets, stretch cache output length, and raw reader seek trimming for the affected tracks before changing PDC math.";
    }
    if (classification.rfind("C.", 0) == 0) {
        return "Stage 8C should make offline/export enter the same initialized MixEngine state as live playback, then verify live and export post-PDC taps have zero lag for the selected window.";
    }
    if (classification.rfind("D.", 0) == 0) {
        return "Stage 8C should resolve missing/crashed plugin placeholder latency and state restoration first, then rerun this diagnostic with all effect chains resolved.";
    }
    if (classification.rfind("E.", 0) == 0) {
        return "Stage 8C should route special chorus/fullscreen/grid paths through the same real track-buffer tap path that PDC accounting uses, then add a bypass regression.";
    }
    return "Stage 8C should not change behavior yet. Rerun Stage 8B with a manual start sample around the audible failure, or add a temporary paired-transient marker/null-test render so cross-track alignment is comparable.";
}

json secondaryFindingsForClassification(const std::string& classification,
                                        const json& missingPlugins,
                                        const json& alignmentRows)
{
    json findings = json::array();

    if (!missingPlugins.empty() && classification.rfind("D.", 0) != 0) {
        findings.push_back({
            {"classification", "D. Plugin placeholder/state latency mismatch"},
            {"detail", "Missing or placeholder plugins are present on selected tracks and can still affect timing/state, but they did not outrank the observed pre/post PDC mismatch."}
        });
    }

    int missingDelayTracks = 0;
    for (const auto& row : alignmentRows) {
        if (row.value("expectedPreToPostLagSamples", 0) > 0
            && row.value("observedPreToPostLag", json::object()).value("valid", false)
            && !row.value("pdcDelayObservedNearExpected", false)) {
            ++missingDelayTracks;
        }
    }

    if (missingDelayTracks > 0 && classification.rfind("A.", 0) != 0) {
        findings.push_back({
            {"classification", "A. PDC delay not applied to real buffers"},
            {"detail", std::to_string(missingDelayTracks) + " selected track(s) had comparable pre/post buffers but did not show the expected compensation lag."}
        });
    }

    return findings;
}

json sourceMediaAudit(const Timeline& timeline)
{
    json arr = json::array();
    for (const SourceMedia* source : timeline.getAllSources()) {
        if (source == nullptr)
            continue;
        arr.push_back({
            {"sourceId", source->id},
            {"filePath", source->filePath},
            {"fileExists", !source->filePath.empty() && fs::exists(source->filePath)},
            {"proxyPath", source->proxyPath},
            {"proxyExists", !source->proxyPath.empty() && fs::exists(source->proxyPath)},
            {"hasVideo", source->hasVideo},
        });
    }
    return arr;
}

void writeMarkdownReport(const fs::path& path, const json& report)
{
    std::ofstream out(path);
    if (!out)
        throw std::runtime_error("failed to write markdown report");

    out << "# " << report.value("reportTitle", "Stage 8B Real-Signal PDC Tap Diagnostic") << "\n\n";
    out << "## Checkout\n";
    out << "- Branch: `" << report["git"].value("branch", "") << "`\n";
    out << "- HEAD: `" << report["git"].value("head", "") << "`\n";
    out << "- Status: `" << report["git"].value("statusShort", "") << "`\n\n";

    out << "## Project Safety\n";
    out << "- Original project: `" << report["paths"].value("originalProjectDir", "") << "`\n";
    out << "- Scratch project: `" << report["paths"].value("scratchProjectDir", "") << "`\n";
    out << "- Scratch source: `" << report["paths"].value("scratchSource", "") << "`\n";
    out << "- Original project.json SHA-256 before: `"
        << report["originalUntouchedProof"].value("projectJsonSha256Before", "") << "`\n";
    out << "- Original project.json SHA-256 after: `"
        << report["originalUntouchedProof"].value("projectJsonSha256After", "") << "`\n";
    out << "- Original untouched: "
        << boolText(report["originalUntouchedProof"].value("untouched", false)) << "\n\n";

    out << "## Stage 8A Summary\n";
    out << "- MAIN CHROUS id/type: `197 / Clip`\n";
    out << "- MAIN CHROUS chain latency: `2192` samples\n";
    out << "- RS HQ latency: `2048` samples; compressor latency: `144` samples\n";
    out << "- maxAudibleTrackLatency before/after: `2192 / 2192`\n";
    out << "- masterInsertLatency: `2416`; live track+master latency: `4608`\n";
    out << "- export preroll/discard: `4608 / 4608`\n";
    out << "- synthetic impulse PDC and affected-track compensation checks passed\n\n";

    out << "## Target Tracks\n";
    out << "| Requested | Found | id | Actual | Type |\n";
    out << "| --- | --- | ---: | --- | --- |\n";
    for (const auto& row : report["targetTracks"]) {
        out << "| " << row.value("requestedName", "") << " | "
            << boolText(row.value("found", false)) << " | "
            << (row["trackId"].is_null() ? std::string("") : std::to_string(row["trackId"].get<int>())) << " | "
            << row.value("actualName", "") << " | "
            << row.value("type", "") << " |\n";
    }
    out << "\n";

    const auto& window = report["captureWindow"];
    out << "## Capture Window\n";
    out << "- Start sample: `" << window.value("startSample", int64_t(0)) << "`\n";
    out << "- End sample: `" << window.value("endSample", int64_t(0)) << "`\n";
    out << "- Start seconds: `" << window.value("startSeconds", 0.0) << "`\n";
    out << "- Duration seconds: `" << window.value("durationSeconds", 0.0) << "`\n";
    out << "- Selection: " << (window.value("automatic", true) ? "automatic" : "manual") << "\n";
    out << "- Reason: " << window.value("reason", "") << "\n\n";

    out << "## Latency Accounting\n";
    out << "| Track | id | declared | compensation | expected | ok |\n";
    out << "| --- | ---: | ---: | ---: | ---: | --- |\n";
    for (const auto& row : report["latencyAccounting"]["tracks"]) {
        if (!row.value("found", false))
            continue;
        out << "| " << row.value("trackName", "") << " | "
            << row.value("trackId", -1) << " | "
            << row.value("declaredLatencySamples", 0) << " | "
            << row.value("compensationDelaySamples", 0) << " | "
            << row.value("expectedCompensationDelaySamples", 0) << " | "
            << boolText(row.value("compensationMatchesExpected", false)) << " |\n";
    }
    out << "\n";

    out << "## Alignment\n";
    out << "| Track | expected pre->post | observed pre->post | corr | PDC observed | post vs MAIN | live vs export |\n";
    out << "| --- | ---: | ---: | ---: | --- | ---: | ---: |\n";
    for (const auto& row : report["alignment"]["perTrack"]) {
        const auto pp = row.value("observedPreToPostLag", json::object());
        const auto main = row.value("observedPostPdcLagVsMainChrous", json::object());
        const auto exp = row.value("liveVsExportOfflinePostPdcLag", json::object());
        out << "| " << row.value("trackName", "") << " | "
            << row.value("expectedPreToPostLagSamples", 0) << " | "
            << (pp.value("valid", false) ? std::to_string(pp.value("lagSamples", 0)) : std::string("")) << " | "
            << (pp.value("valid", false) ? std::to_string(pp.value("coefficient", 0.0)) : std::string("")) << " | "
            << boolText(row.value("pdcDelayObservedNearExpected", false)) << " | "
            << (main.value("valid", false) ? std::to_string(main.value("lagSamples", 0)) : std::string("")) << " | "
            << (exp.value("valid", false) ? std::to_string(exp.value("lagSamples", 0)) : std::string("")) << " |\n";
    }
    out << "\n";

    out << "## Missing Plugins Or Placeholder State\n";
    if (report["missingPlugins"].empty()) {
        out << "- None reported by loaded effect-chain state.\n\n";
    } else {
        out << "| Track | Node | Plugin | Missing | Crashed | Reported latency |\n";
        out << "| --- | ---: | --- | --- | --- | ---: |\n";
        for (const auto& row : report["missingPlugins"]) {
            out << "| " << row.value("trackName", "") << " | "
                << row.value("nodeId", -1) << " | "
                << row.value("pluginId", "") << " | "
                << boolText(row.value("missing", false)) << " | "
                << boolText(row.value("crashed", false)) << " | "
                << (row["reportedLatencySamples"].is_null() ? std::string("") : std::to_string(row["reportedLatencySamples"].get<int>())) << " |\n";
        }
        out << "\n";
    }

    out << "## Direct Answers\n";
    out << "- MAIN CHROUS real buffers are max-latency track buffers: "
        << boolText(report["checks"].value("mainChrousIsMaxLatencyTrack", false)) << "\n";
    out << "- Affected tracks delayed by expected samples in real buffers: "
        << boolText(report["checks"].value("affectedTracksDelayedByExpectedSamples", false)) << "\n";
    out << "- Live-style and export/offline captures have same post-PDC alignment: "
        << report["checks"].value("liveExportAlignmentSummary", "") << "\n";
    out << "- Source-reader stale/silent/short flags: not exposed by current SampleBank/MixEngine APIs; silence/shortness is inferred from tap stats and media-load rows.\n\n";

    out << "## Classification\n";
    out << "- Root cause classification: " << report.value("rootCauseClassification", "") << "\n";
    if (report.contains("secondaryRootCauseSignals") && !report["secondaryRootCauseSignals"].empty()) {
        out << "- Secondary signals:\n";
        for (const auto& finding : report["secondaryRootCauseSignals"]) {
            out << "  - " << finding.value("classification", "")
                << ": " << finding.value("detail", "") << "\n";
        }
    }
    out << "- Stage 8C needed: " << boolText(report.value("stage8cNeeded", true)) << "\n";
    out << "- Recommended Stage 8C fix plan: " << report.value("recommendedStage8cFixPlan", "") << "\n";
}

Options parseOptions(int argc, char** argv)
{
    Options options;
    options.projectDir = options.repoRoot / "diagnostics" / "pdc-stage8b" / "NO_MAIL_stage8b_copy";
    options.jsonPath = options.repoRoot / "diagnostics" / "pdc-stage8b" / "pdc-real-signal-stage8b.json";
    options.markdownPath = options.repoRoot / "docs" / "diagnostics" / "pdc-real-signal-stage8b.md";

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto value = [&](const char* name) -> std::string {
            if (i + 1 >= argc)
                throw std::runtime_error(std::string("missing value for ") + name);
            return argv[++i];
        };

        if (arg == "--repo-root")
            options.repoRoot = value("--repo-root");
        else if (arg == "--stage8c") {
            options.stageName = "Stage 8C";
            options.reportTitle = "Stage 8C Real-Buffer PDC Fix Diagnostic";
            options.projectDir = options.repoRoot / "diagnostics" / "pdc-stage8c" / "NO_MAIL_stage8c_copy";
            options.jsonPath = options.repoRoot / "diagnostics" / "pdc-stage8c" / "pdc-real-buffer-fix-stage8c.json";
            options.markdownPath = options.repoRoot / "docs" / "diagnostics" / "pdc-real-buffer-fix-stage8c.md";
        }
        else if (arg == "--project")
            options.projectDir = value("--project");
        else if (arg == "--original-project")
            options.originalProjectDir = value("--original-project");
        else if (arg == "--json")
            options.jsonPath = value("--json");
        else if (arg == "--markdown")
            options.markdownPath = value("--markdown");
        else if (arg == "--scratch-source")
            options.scratchSource = value("--scratch-source");
        else if (arg == "--live-block-size")
            options.liveBlockSize = std::stoi(value("--live-block-size"));
        else if (arg == "--offline-block-size")
            options.offlineBlockSize = std::stoi(value("--offline-block-size"));
        else if (arg == "--capture-seconds")
            options.captureSeconds = std::stod(value("--capture-seconds"));
        else if (arg == "--scan-seconds")
            options.scanSeconds = std::stod(value("--scan-seconds"));
        else if (arg == "--start-sample")
            options.manualStartSample = std::stoll(value("--start-sample"));
        else if (arg == "--skip-media-load")
            options.loadMedia = false;
        else if (arg == "--help" || arg == "-h") {
            std::cout
                << "Usage: xleth_pdc_real_signal_tap [options]\n"
                << "  --repo-root <path>\n"
                << "  --stage8c\n"
                << "  --project <scratch project dir>\n"
                << "  --original-project <original project dir>\n"
                << "  --json <path>\n"
                << "  --markdown <path>\n"
                << "  --scratch-source <path or note>\n"
                << "  --start-sample <sample>\n"
                << "  --capture-seconds <seconds>\n"
                << "  --scan-seconds <seconds>\n"
                << "  --skip-media-load\n";
            std::exit(0);
        } else {
            throw std::runtime_error("unknown argument: " + arg);
        }
    }

    if (options.liveBlockSize <= 0 || options.offlineBlockSize <= 0)
        throw std::runtime_error("block sizes must be positive");
    if (options.captureSeconds <= 0.0 || options.scanSeconds <= 0.0)
        throw std::runtime_error("capture and scan durations must be positive");
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
        const std::string originalHashBefore = sha256File(originalProjectJson);

        ProjectManager projectManager;
        auto loaded = projectManager.loadProject(options.projectDir.string());
        if (!loaded)
            throw std::runtime_error("failed to load scratch project");

        Timeline timeline = std::move(*loaded);
        const double sampleRate = timeline.getSampleRate() > 0.0
            ? timeline.getSampleRate()
            : kFallbackSampleRate;
        const int prepareBlockSize = std::max(options.liveBlockSize, options.offlineBlockSize);

        SampleBank sampleBank;
        MixEngine mix;
        mix.setTimeline(&timeline);
        mix.setSampleBank(&sampleBank);
        mix.prepare(sampleRate, prepareBlockSize);
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

        const int clipCacheJobsSubmitted = refreshClipCachesLikeBridge(timeline, mix);
        std::this_thread::sleep_for(std::chrono::milliseconds(500));

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

        renderRange(mix, timeline, nullptr, "latency-prime", 0, options.liveBlockSize,
                    options.liveBlockSize, true);
        const auto snapshot = mix.getLatencyCompensationSnapshot();
        const auto selections = resolveRequestedTracks(timeline);
        std::set<int> selectedIds;
        for (const auto& s : selections)
            if (s.found)
                selectedIds.insert(s.trackId);

        const int64_t binSamples = static_cast<int64_t>(std::llround(sampleRate));
        ScanTapSink scan(selectedIds, binSamples);
        const int64_t projectEnd = projectEndSample(timeline, sampleRate);
        const int64_t scanEnd = std::min<int64_t>(
            std::max<int64_t>(projectEnd, static_cast<int64_t>(sampleRate * options.captureSeconds)),
            static_cast<int64_t>(std::llround(sampleRate * options.scanSeconds)));
        if (options.manualStartSample < 0) {
            renderRange(mix, timeline, &scan, "scan", 0, scanEnd,
                        options.offlineBlockSize, true);
        }

        WindowChoice window = chooseWindow(scan,
                                           selections,
                                           sampleRate,
                                           options.captureSeconds,
                                           options.manualStartSample);
        const int64_t latencyWarmup = static_cast<int64_t>(
            snapshot.maxAudibleTrackLatencySamples
            + snapshot.masterInsertLatencySamples
            + static_cast<int>(sampleRate));
        const int64_t renderStart = std::max<int64_t>(0, window.startSample - latencyWarmup);
        const int64_t renderEnd = window.endSample;

        CaptureTapSink liveCapture("live-style", selectedIds, window.startSample, window.endSample);
        renderRange(mix, timeline, &liveCapture, "live-style", renderStart, renderEnd,
                    options.liveBlockSize, false);

        CaptureTapSink offlineCapture("export-offline", selectedIds, window.startSample, window.endSample);
        renderRange(mix, timeline, &offlineCapture, "export-offline", renderStart, renderEnd,
                    options.offlineBlockSize, true);

        json latency = latencyRows(mix, timeline, selections);
        json missingPlugins = missingPluginRows(latency);
        json alignment = analyzeAlignment(selections,
                                          liveCapture.streams(),
                                          offlineCapture.streams(),
                                          window.startSample);

        bool affectedDelayed = true;
        bool liveExportSame = true;
        bool liveExportComparable = false;
        int liveExportDifferent = 0;
        int liveExportMissing = 0;
        for (const auto& row : alignment) {
            if (row.value("requestedName", "") != "MAIN CHROUS"
                && row.value("expectedPreToPostLagSamples", 0) > 0
                && !row.value("pdcDelayObservedNearExpected", false)) {
                affectedDelayed = false;
            }

            const auto liveOffline =
                row.value("liveVsExportOfflinePostPdcLag", json::object());
            if (liveOffline.value("valid", false)) {
                liveExportComparable = true;
                if (!row.value("liveVsExportOfflineSameAlignment", false)) {
                    liveExportSame = false;
                    ++liveExportDifferent;
                }
            } else {
                ++liveExportMissing;
            }
        }
        if (!liveExportComparable)
            liveExportSame = false;

        std::string liveExportSummary;
        if (!liveExportComparable) {
            liveExportSummary =
                "inconclusive: no comparable live/export post-PDC captures";
        } else if (liveExportDifferent > 0) {
            liveExportSummary =
                "different: " + std::to_string(liveExportDifferent)
                + " selected track(s) had live/export post-PDC lag";
        } else if (liveExportMissing > 0) {
            liveExportSummary =
                "same for comparable captures; "
                + std::to_string(liveExportMissing)
                + " selected track(s) missing/inconclusive";
        } else {
            liveExportSummary = "same for all selected tracks";
        }

        bool mainIsMax = false;
        for (const auto& row : latency) {
            if (row.value("requestedName", "") == "MAIN CHROUS") {
                mainIsMax = row.value("declaredLatencySamples", 0)
                    == snapshot.maxAudibleTrackLatencySamples;
                break;
            }
        }

        const std::string classification =
            classifyRootCause(alignment, missingPlugins, window.sufficient);
        json secondaryFindings =
            secondaryFindingsForClassification(classification, missingPlugins, alignment);
        const std::string originalHashAfter = sha256File(originalProjectJson);
        const bool untouched = !originalHashBefore.empty()
            && !originalHashAfter.empty()
            && originalHashBefore == originalHashAfter;

        json capturedStreams = json::array();
        for (const auto& [key, stream] : liveCapture.streams()) {
            juce::ignoreUnused(key);
            capturedStreams.push_back(streamToJson(stream, window.startSample));
        }
        for (const auto& [key, stream] : offlineCapture.streams()) {
            juce::ignoreUnused(key);
            capturedStreams.push_back(streamToJson(stream, window.startSample));
        }

        const std::string gitBase = "git -C " + quoteForCommand(options.repoRoot);
        const auto preroll = AudioExporter::computePrerollPlan(
            window.startSample,
            snapshot.maxAudibleTrackLatencySamples,
            snapshot.masterInsertLatencySamples);

        json report;
        report["generatedBy"] = "xleth_pdc_real_signal_tap";
        report["stage"] = options.stageName;
        report["reportTitle"] = options.reportTitle;
        report["git"] = {
            {"branch", runCommand(gitBase + " branch --show-current")},
            {"head", runCommand(gitBase + " log --oneline -1")},
            {"logOneline8", runCommand(gitBase + " log --oneline -8")},
            {"statusShort", runCommand(gitBase + " status --short")}
        };
        report["paths"] = {
            {"repoRoot", options.repoRoot.string()},
            {"originalProjectDir", options.originalProjectDir.string()},
            {"scratchProjectDir", options.projectDir.string()},
            {"scratchSource", options.scratchSource},
            {"jsonReport", options.jsonPath.string()},
            {"markdownReport", options.markdownPath.string()}
        };
        report["originalUntouchedProof"] = {
            {"projectJsonSha256Before", originalHashBefore},
            {"projectJsonSha256After", originalHashAfter},
            {"untouched", untouched}
        };
        report["stage8AResultSummary"] = {
            {"mainChrousId", 197},
            {"mainChrousType", "Clip"},
            {"mainChrousChainLatencySamples", 2192},
            {"resonanceSuppressorHqLatencySamples", 2048},
            {"compressorLatencySamples", 144},
            {"maxAudibleTrackLatencyBeforeSamples", 2192},
            {"maxAudibleTrackLatencyAfterSamples", 2192},
            {"masterInsertLatencySamples", 2416},
            {"liveTrackPlusMasterLatencySamples", 4608},
            {"exportPrerollSamples", 4608},
            {"exportDiscardSamples", 4608},
            {"resonanceSuppressorDeclaredImpulseDelaySamples", 2048},
            {"resonanceSuppressorMeasuredImpulseDelaySamples", 2048},
            {"syntheticImpulsePdcPassed", true}
        };
        report["project"] = {
            {"sampleRate", sampleRate},
            {"liveBlockSize", options.liveBlockSize},
            {"offlineBlockSize", options.offlineBlockSize},
            {"bpm", timeline.getBPM()},
            {"trackCount", timeline.getAllTracks().size()},
            {"clipCount", timeline.getAllClips().size()},
            {"patternBlockCount", timeline.getAllPatternBlocks().size()},
            {"projectEndSample", projectEnd},
            {"sourceMediaAudit", sourceMediaAudit(timeline)},
            {"mediaLoad", std::move(mediaLoad)},
            {"clipCacheJobsSubmitted", clipCacheJobsSubmitted},
            {"clipCacheWarmupSleepMs", 500}
        };
        report["targetTracks"] = selectionsToJson(selections);
        report["captureWindow"] = {
            {"startSample", window.startSample},
            {"endSample", window.endSample},
            {"durationSamples", window.endSample - window.startSample},
            {"startSeconds", static_cast<double>(window.startSample) / sampleRate},
            {"durationSeconds", static_cast<double>(window.endSample - window.startSample) / sampleRate},
            {"automatic", window.automatic},
            {"sufficient", window.sufficient},
            {"score", window.score},
            {"reason", window.reason},
            {"scanEndSample", scanEnd},
            {"renderWarmupStartSample", renderStart}
        };
        report["latencyAccounting"] = {
            {"maxAudibleTrackLatencySamples", snapshot.maxAudibleTrackLatencySamples},
            {"masterInsertLatencySamples", snapshot.masterInsertLatencySamples},
            {"liveTrackPlusMasterLatencySamples",
             snapshot.maxAudibleTrackLatencySamples + snapshot.masterInsertLatencySamples},
            {"exportPrerollForCaptureWindow", {
                {"renderStartSample", preroll.renderStartSample},
                {"availablePrerollSamples", preroll.availablePrerollSamples},
                {"totalPrerollSamples", preroll.totalPrerollSamples},
                {"discardSamples", preroll.discardSamples}
            }},
            {"tracks", latency}
        };
        report["capturedStreams"] = std::move(capturedStreams);
        report["alignment"] = {{"perTrack", alignment}};
        report["missingPlugins"] = missingPlugins;
        report["checks"] = {
            {"mainChrousIsMaxLatencyTrack", mainIsMax},
            {"affectedTracksDelayedByExpectedSamples", affectedDelayed},
            {"liveExportSameAlignment", liveExportSame},
            {"liveExportAlignmentSummary", liveExportSummary},
            {"liveExportComparableTracks", liveExportComparable},
            {"liveExportDifferentTrackCount", liveExportDifferent},
            {"liveExportMissingOrInconclusiveTrackCount", liveExportMissing},
            {"windowHadComparableMainAndDrumEnergy", window.sufficient}
        };
        report["diagnosticLimits"] = json::array({
            "Cross-track musical correlation can be weak when tracks do not share comparable transients in the selected window.",
            "Source-reader stale/short flags are not currently exposed; the report infers silence and shortness from captured real buffers and media-load success.",
            "The diagnostic does not save or mutate the scratch project after load."
        });
        report["rootCauseClassification"] = classification;
        report["secondaryRootCauseSignals"] = std::move(secondaryFindings);
        report["stage8cNeeded"] = true;
        report["recommendedStage8cFixPlan"] = recommendedFixForClassification(classification);

        {
            std::ofstream jsonOut(options.jsonPath);
            jsonOut << report.dump(2) << "\n";
        }
        writeMarkdownReport(options.markdownPath, report);

        std::cout << "Wrote JSON: " << options.jsonPath.string() << "\n";
        std::cout << "Wrote Markdown: " << options.markdownPath.string() << "\n";
        std::cout << "Capture window: " << window.startSample << " - " << window.endSample << "\n";
        std::cout << "Classification: " << classification << "\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "[xleth_pdc_real_signal_tap] ERROR: " << e.what() << "\n";
        return 1;
    }
}
