#include "LfoParameterModulation.h"

#include "Timeline.h"

#include <algorithm>
#include <cmath>

namespace xleth::lfomod {
namespace {

// ─── Small JSON helpers ──────────────────────────────────────────────────────
// Local copies, deliberately not shared with EnvelopeParameterModulation.cpp's
// identical-looking helpers: those are TU-local (anonymous namespace) there and
// not exported, so this file cannot call them. Consistent with this codebase's
// existing "mirror, don't generalize" convention for Macro/Envelope/LFO.

bool isFinite(double v) { return std::isfinite(v); }

double clamp01(double v, double fallback = 0.0)
{
    if (!isFinite(v)) return fallback;
    return std::min(1.0, std::max(0.0, v));
}

double clampSigned(double v, double fallback)
{
    if (!isFinite(v)) return fallback;
    return std::min(1.0, std::max(-1.0, v));
}

double clampMs(const nlohmann::json& j, const char* key, double fallback)
{
    if (!j.is_object()) return fallback;
    auto it = j.find(key);
    if (it == j.end() || !it->is_number()) return fallback;
    const double v = it->get<double>();
    return (isFinite(v) && v >= 0.0) ? v : fallback;
}

double clampUnitField(const nlohmann::json& j, const char* key, double fallback)
{
    if (!j.is_object()) return fallback;
    auto it = j.find(key);
    if (it == j.end() || !it->is_number()) return fallback;
    return clamp01(it->get<double>(), fallback);
}

double clampSignedUnitField(const nlohmann::json& j, const char* key, double fallback)
{
    if (!j.is_object()) return fallback;
    auto it = j.find(key);
    if (it == j.end() || !it->is_number()) return fallback;
    return clampSigned(it->get<double>(), fallback);
}

bool isLiteralTrue(const nlohmann::json& j, const char* key)
{
    if (!j.is_object()) return false;
    auto it = j.find(key);
    return it != j.end() && it->is_boolean() && it->get<bool>();
}

bool isNotLiteralFalse(const nlohmann::json& j, const char* key)
{
    if (!j.is_object()) return true;
    auto it = j.find(key);
    if (it == j.end() || !it->is_boolean()) return true;
    return it->get<bool>();
}

std::string readString(const nlohmann::json& j, const char* key)
{
    if (!j.is_object()) return {};
    auto it = j.find(key);
    if (it == j.end() || !it->is_string()) return {};
    return it->get<std::string>();
}

std::string readTrimmedString(const nlohmann::json& j, const char* key)
{
    std::string s = readString(j, key);
    const auto first = s.find_first_not_of(" \t\n\r\f\v");
    if (first == std::string::npos) return {};
    const auto last = s.find_last_not_of(" \t\n\r\f\v");
    return s.substr(first, last - first + 1);
}

const nlohmann::json* findObject(const nlohmann::json& j, const char* key)
{
    if (!j.is_object()) return nullptr;
    auto it = j.find(key);
    if (it == j.end() || !it->is_object()) return nullptr;
    return &(*it);
}

const nlohmann::json* findArray(const nlohmann::json& j, const char* key)
{
    if (!j.is_object()) return nullptr;
    auto it = j.find(key);
    if (it == j.end() || !it->is_array()) return nullptr;
    return &(*it);
}

// normalizeMappingCurve, same shape as envmod's private readCurve: a bezier
// curve needs exactly 4 finite points; anything else falls back to linear.
void readCurve(const nlohmann::json& mappingJson, xleth::envmod::ModulationMapping& out)
{
    out.curve = xleth::envmod::MappingCurve::Linear;

    const nlohmann::json* curve = findObject(mappingJson, "curve");
    if (curve == nullptr) return;
    if (readString(*curve, "type") != "bezier") return;

    const nlohmann::json* points = findArray(*curve, "points");
    if (points == nullptr || points->size() != 4) return;

    double xs[4] = {};
    double ys[4] = {};
    for (std::size_t i = 0; i < 4; ++i) {
        const nlohmann::json& p = (*points)[i];
        if (!p.is_object()) return;
        auto xit = p.find("x");
        auto yit = p.find("y");
        if (xit == p.end() || yit == p.end()) return;
        if (!xit->is_number() || !yit->is_number()) return;
        const double x = xit->get<double>();
        const double y = yit->get<double>();
        if (!isFinite(x) || !isFinite(y)) return;
        xs[i] = std::min(1.0, std::max(0.0, x));
        ys[i] = std::min(1.0, std::max(0.0, y));
    }

    out.curve = xleth::envmod::MappingCurve::Bezier;
    out.cp1x = xs[1];
    out.cp1y = ys[1];
    out.cp2x = xs[2];
    out.cp2y = ys[2];
}

// Reads an Lfo->Parameter edge's `mapping` object into a ModulationMapping.
// No legacy/absolute-range migration exists for LFO edges (brand-new feature,
// nothing to migrate from) — every edge is authored with kind:'modulation'
// already, so this always reads the modulation-kind shape directly.
xleth::envmod::ModulationMapping readModulationMapping(const nlohmann::json& mappingJson)
{
    xleth::envmod::ModulationMapping out;
    out.enabled   = isNotLiteralFalse(mappingJson, "enabled");
    out.base      = clampUnitField(mappingJson, "base", 0.0);
    out.depth     = clampSignedUnitField(mappingJson, "depth", 1.0);
    out.sourceMin = clampUnitField(mappingJson, "sourceMin", 0.0);
    out.sourceMax = clampUnitField(mappingJson, "sourceMax", 1.0);
    readCurve(mappingJson, out);
    return out;
}

// ─── LFO node target resolution ──────────────────────────────────────────────
// A local copy of envmod's resolveTarget (EnvelopeParameterModulation.cpp,
// anonymous namespace, not exported). Identical logic: an Lfo->Parameter edge
// addresses its target the same way an Envelope->Parameter edge does — a
// graphState node id carrying an effectInstanceId plus one of its
// exposedParameterPorts.

struct TargetResolution {
    bool                        ok     = false;
    xleth::envmod::EdgeSkipReason reason = xleth::envmod::EdgeSkipReason::InvalidTarget;
    bool                        readOnly = false;
};

TargetResolution resolveTarget(const nlohmann::json& graphState,
                              const std::string&    graphNodeId,
                              const std::string&    effectInstanceId,
                              const std::string&    parameterId)
{
    TargetResolution res;

    const nlohmann::json* nodes = findArray(graphState, "nodes");
    if (nodes == nullptr) {
        res.reason = xleth::envmod::EdgeSkipReason::MissingNode;
        return res;
    }

    const nlohmann::json* node = nullptr;
    for (const auto& candidate : *nodes) {
        if (!candidate.is_object()) continue;
        if (readString(candidate, "id") == graphNodeId) { node = &candidate; break; }
    }
    if (node == nullptr) {
        res.reason = xleth::envmod::EdgeSkipReason::MissingNode;
        return res;
    }

    const nlohmann::json* data = findObject(*node, "data");
    const std::string nodeEffectInstanceId =
        data != nullptr ? readTrimmedString(*data, "effectInstanceId") : std::string();
    if (nodeEffectInstanceId.empty() || nodeEffectInstanceId != effectInstanceId) {
        res.reason = xleth::envmod::EdgeSkipReason::MissingEffectInstance;
        return res;
    }

    const nlohmann::json* ports =
        data != nullptr ? findArray(*data, "exposedParameterPorts") : nullptr;
    const nlohmann::json* matched = nullptr;
    if (ports != nullptr) {
        for (const auto& port : *ports) {
            if (!port.is_object()) continue;
            if (readString(port, "parameterId") == parameterId) { matched = &port; break; }
        }
    }
    if (matched == nullptr) {
        res.reason = xleth::envmod::EdgeSkipReason::MissingExposedPort;
        return res;
    }

    const bool readOnly = isLiteralTrue(*matched, "readOnly");
    bool automatable = true;
    if (auto it = matched->find("automatable"); it != matched->end() && it->is_boolean())
        automatable = it->get<bool>();

    res.ok       = true;
    res.readOnly = readOnly || !automatable;
    return res;
}

} // namespace

// ─── LFO shape ─────────────────────────────────────────────────────────────

LfoShape normalizeLfoShape(const nlohmann::json& rawData)
{
    const LfoShape defaults;
    if (!rawData.is_object()) return defaults;

    LfoShape out;
    out.rateMode = readString(rawData, "rateMode") == "sync" ? RateMode::Sync : RateMode::Free;
    out.rateMs   = clampMs(rawData, "rateMs", defaults.rateMs);

    {
        auto it = rawData.find("syncDivision");
        if (it != rawData.end() && it->is_number()) {
            const double v = it->get<double>();
            // Kept as a double: fractional values below 1 are the multi-bar
            // rates (0.5 = 2/1, 0.25 = 4/1, 0.125 = 8/1). Truncating to int here
            // would floor every one of them to 0 and then clamp to the minimum.
            out.syncDivision = isFinite(v) ? std::max(kMinSyncDivision, v) : defaults.syncDivision;
        } else {
            out.syncDivision = defaults.syncDivision;
        }
    }

    out.phaseOffset = clampUnitField(rawData, "phaseOffset", defaults.phaseOffset);

    // Each point's t/v default to 0.0 when missing/non-numeric/non-finite,
    // matching the existing "t"/"v" breakpoint codec convention in
    // XlethEngineService.cpp's parseLfoWaveform (points are kept, never
    // dropped, even when malformed).
    const nlohmann::json* waveform = findArray(rawData, "waveform");
    if (waveform != nullptr) {
        out.waveform.reserve(waveform->size());
        for (const auto& pt : *waveform) {
            if (!pt.is_object()) continue;
            SampleRegion::LfoBreakpoint bp;
            if (auto it = pt.find("t"); it != pt.end() && it->is_number()) {
                const double t = it->get<double>();
                bp.time = isFinite(t) ? static_cast<float>(t) : 0.0f;
            }
            if (auto it = pt.find("v"); it != pt.end() && it->is_number()) {
                const double v = it->get<double>();
                bp.value = isFinite(v) ? static_cast<float>(v) : 0.0f;
            }
            out.waveform.push_back(bp);
        }
    }

    return out;
}

// ─── Tempo-sync / rate ───────────────────────────────────────────────────────

double lfoCycleHz(const LfoShape& shape, double bpm)
{
    if (shape.rateMode == RateMode::Sync) {
        const double safeBpm = (isFinite(bpm) && bpm > 0.0) ? bpm : 0.0;
        const double division = std::max(kMinSyncDivision, shape.syncDivision);
        return (safeBpm / 60.0) * (division / 4.0);
    }

    constexpr double epsilon = 1e-6;
    const double rateMs = (isFinite(shape.rateMs) && shape.rateMs > epsilon) ? shape.rateMs : epsilon;
    return 1000.0 / rateMs;
}

// ─── Waveform evaluation ──────────────────────────────────────────────────────

double evaluateLfoWaveform(const std::vector<SampleRegion::LfoBreakpoint>& waveform,
                           double phase01)
{
    if (waveform.empty())
        return std::sin(phase01 * 2.0 * 3.14159265358979323846);
    if (waveform.size() == 1)
        return waveform[0].value;

    double phase = phase01 - std::floor(phase01); // wrap to [0,1), defensive

    // Linear scan for the bracketing breakpoint pair (same scan/lerp shape as
    // Sampler::evaluateLfoWaveform, Sampler.cpp:169-189 — independent copy).
    for (std::size_t i = 0; i + 1 < waveform.size(); ++i) {
        if (phase <= static_cast<double>(waveform[i + 1].time)) {
            const double span =
                static_cast<double>(waveform[i + 1].time) - static_cast<double>(waveform[i].time);
            if (span < 1e-9) return waveform[i].value;
            const double frac = (phase - static_cast<double>(waveform[i].time)) / span;
            return static_cast<double>(waveform[i].value)
                 + (static_cast<double>(waveform[i + 1].value) - static_cast<double>(waveform[i].value)) * frac;
        }
    }
    return waveform.back().value;
}

double evaluateLfoAtPosition(const LfoShape& shape,
                             int64_t         positionSamples,
                             double          bpm,
                             double          sampleRate)
{
    if (!isFinite(sampleRate) || sampleRate <= 0.0) sampleRate = 1.0;

    const double hz = lfoCycleHz(shape, bpm);
    const double cyclePos =
        (static_cast<double>(positionSamples) / sampleRate) * hz + shape.phaseOffset;
    const double phase01 = cyclePos - std::floor(cyclePos);

    return evaluateLfoWaveform(shape.waveform, phase01);
}

// ─── graphState parse ────────────────────────────────────────────────────────

ParsedGraphLfoNodes parseGraphStateLfoNodes(const nlohmann::json& graphState)
{
    ParsedGraphLfoNodes out;
    if (!graphState.is_object()) return out;

    const nlohmann::json* nodes = findArray(graphState, "nodes");
    const nlohmann::json* edges = findArray(graphState, "edges");
    if (nodes == nullptr) return out;

    for (const auto& node : *nodes) {
        if (!node.is_object()) continue;
        if (readString(node, "type") != "lfo") continue;

        const std::string nodeId = readString(node, "id");
        if (nodeId.empty()) continue;

        LfoNodeDefinition def;
        def.nodeId = nodeId;
        const nlohmann::json* data = findObject(node, "data");
        def.shape = normalizeLfoShape(data != nullptr ? *data : nlohmann::json::object());

        if (edges != nullptr) {
            for (const auto& edge : *edges) {
                if (!edge.is_object()) continue;
                if (readString(edge, "type") != "parameter") continue;
                if (readString(edge, "sourceNodeId") != nodeId) continue;

                const std::string edgeId = readString(edge, "id");

                const nlohmann::json* mappingJson = findObject(edge, "mapping");
                const nlohmann::json  emptyMapping = nlohmann::json::object();
                const nlohmann::json& mapping =
                    mappingJson != nullptr ? *mappingJson : emptyMapping;

                xleth::envmod::ModulationMapping normalizedMapping = readModulationMapping(mapping);

                if (!normalizedMapping.enabled) {
                    out.skipped.push_back({edgeId, xleth::envmod::EdgeSkipReason::Disabled});
                    continue;
                }

                const nlohmann::json* targetJson = findObject(edge, "targetParameter");
                if (targetJson == nullptr
                    || readString(*targetJson, "kind") != "graph-parameter") {
                    out.skipped.push_back({edgeId, xleth::envmod::EdgeSkipReason::InvalidTarget});
                    continue;
                }
                const std::string graphNodeId      = readTrimmedString(*targetJson, "graphNodeId");
                const std::string effectInstanceId = readTrimmedString(*targetJson, "effectInstanceId");
                const std::string parameterId      = readTrimmedString(*targetJson, "parameterId");
                if (graphNodeId.empty() || effectInstanceId.empty() || parameterId.empty()) {
                    out.skipped.push_back({edgeId, xleth::envmod::EdgeSkipReason::InvalidTarget});
                    continue;
                }
                if (isLiteralTrue(*targetJson, "parameterIdIsFallback")) {
                    auto it = targetJson->find("parameterIndexFallback");
                    const bool validIndex = it != targetJson->end()
                                         && it->is_number_integer()
                                         && it->get<int64_t>() >= 0;
                    if (!validIndex) {
                        out.skipped.push_back({edgeId, xleth::envmod::EdgeSkipReason::InvalidTarget});
                        continue;
                    }
                }

                const TargetResolution res =
                    resolveTarget(graphState, graphNodeId, effectInstanceId, parameterId);
                if (!res.ok) {
                    out.skipped.push_back({edgeId, res.reason});
                    continue;
                }
                if (res.readOnly) {
                    out.skipped.push_back({edgeId, xleth::envmod::EdgeSkipReason::ReadOnly});
                    continue;
                }

                xleth::envmod::ModulationTargetEdge resolved;
                resolved.edgeId           = edgeId;
                resolved.effectInstanceId = effectInstanceId;
                resolved.parameterId      = parameterId;
                resolved.mapping          = normalizedMapping;
                def.edges.push_back(std::move(resolved));
            }
        }

        out.lfos.push_back(std::move(def));
    }

    return out;
}

// ─── Published snapshot ──────────────────────────────────────────────────────

std::shared_ptr<const LfoModulationSnapshot>
buildLfoModulationSnapshot(const Timeline& timeline)
{
    auto snapshot = std::make_shared<LfoModulationSnapshot>();

    // No RoutePlan / audibility check here — see the doc comment on this
    // function in the header for why: mute/solo "go inert" for an LFO cannot
    // be expressed structurally (unlike Envelope's "omit the gates"), so it is
    // entirely a runtime concern for the later MixEngine integration stage.
    // Every graph-mode, non-master track's LFO nodes get a full snapshot entry
    // here regardless of current mute/solo state.
    const auto allTracks = timeline.getAllTracks();

    for (const auto* track : allTracks) {
        if (track == nullptr) continue;

        // Graph-mode normal tracks only. Chain mode and the master are untouched.
        if (track->fxMode != TrackFxMode::Graph) continue;
        if (!track->hasGraphState) continue;

        const ParsedGraphLfoNodes parsed = parseGraphStateLfoNodes(track->graphState);
        if (parsed.lfos.empty()) continue;

        for (const auto& def : parsed.lfos) {
            if (def.edges.empty()) continue;

            LfoSnapshotEntry entry;
            entry.shape = def.shape;

            entry.edgeOffset = static_cast<int>(snapshot->edges.size());
            entry.edgeCount  = static_cast<int>(def.edges.size());

            for (const auto& edge : def.edges) {
                LfoSnapshotEdge snapshotEdge;
                snapshotEdge.mapping      = edge.mapping;
                snapshotEdge.mailboxIndex = static_cast<int>(snapshot->mailboxTargets.size());
                snapshot->edges.push_back(snapshotEdge);

                LfoMailboxTarget target;
                target.trackId          = track->id;
                target.effectInstanceId = edge.effectInstanceId;
                target.parameterId      = edge.parameterId;
                snapshot->mailboxTargets.push_back(std::move(target));
            }

            snapshot->lfos.push_back(std::move(entry));
        }
    }

    snapshot->mailboxCount = static_cast<int>(snapshot->mailboxTargets.size());
    if (snapshot->mailboxCount > 0)
        snapshot->mailboxes = std::make_unique<LfoMailbox[]>(
            static_cast<std::size_t>(snapshot->mailboxCount));

    return snapshot;
}

} // namespace xleth::lfomod
