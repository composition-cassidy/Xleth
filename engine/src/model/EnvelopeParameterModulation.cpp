#include "EnvelopeParameterModulation.h"

#include "Timeline.h"
#include "../audio/TrackRouting.h"

#include <algorithm>
#include <cmath>

namespace xleth::envmod {
namespace {

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

// ms fields: finite and >= 0, else the default. Mirrors clampEnvelopeMs.
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

// A boolean field is only true for a literal JSON true (mirrors `=== true`).
bool isLiteralTrue(const nlohmann::json& j, const char* key)
{
    if (!j.is_object()) return false;
    auto it = j.find(key);
    return it != j.end() && it->is_boolean() && it->get<bool>();
}

// A boolean field is only false for a literal JSON false (mirrors `!== false`).
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

// normalizeNonEmptyString: trims, and an all-whitespace string is empty.
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

// normalizeMappingCurve — a bezier curve needs exactly 4 finite points; anything
// else falls back to linear. Endpoints are forced to (0,0)/(1,1), so only the two
// interior control points are kept.
void readCurve(const nlohmann::json& mappingJson, ModulationMapping& out)
{
    out.curve = MappingCurve::Linear;

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

    out.curve = MappingCurve::Bezier;
    out.cp1x = xs[1];
    out.cp1y = ys[1];
    out.cp2x = xs[2];
    out.cp2y = ys[2];
}

// EVC-R4 migration of a legacy absolute range mapping on an envelope edge:
//   base  = targetMin
//   depth = (targetMax - targetMin) * legacyAmount
// Algebraically identical to the old evaluation for a linear curve and the
// default source window; approximate otherwise (the old code scaled by amount
// before the non-linear stage). Idempotent, because a normalized envelope node
// carries no `amount` and so scales by 1.
ModulationMapping migrateRangeMapping(const nlohmann::json& mappingJson, double legacyAmount)
{
    ModulationMapping out;
    out.enabled   = isNotLiteralFalse(mappingJson, "enabled");
    out.sourceMin = clampUnitField(mappingJson, "sourceMin", 0.0);
    out.sourceMax = clampUnitField(mappingJson, "sourceMax", 1.0);
    readCurve(mappingJson, out);

    const double targetMin = clampUnitField(mappingJson, "targetMin", 0.0);
    const double targetMax = clampUnitField(mappingJson, "targetMax", 1.0);
    const double amount    = clamp01(legacyAmount, 1.0);

    out.base  = clamp01(targetMin, 0.0);
    out.depth = clampSigned((targetMax - targetMin) * amount, 1.0);
    return out;
}

ModulationMapping readModulationMapping(const nlohmann::json& mappingJson)
{
    ModulationMapping out;
    out.enabled   = isNotLiteralFalse(mappingJson, "enabled");
    out.base      = clampUnitField(mappingJson, "base", 0.0);
    out.depth     = clampSignedUnitField(mappingJson, "depth", 1.0);
    out.sourceMin = clampUnitField(mappingJson, "sourceMin", 0.0);
    out.sourceMax = clampUnitField(mappingJson, "sourceMax", 1.0);
    readCurve(mappingJson, out);
    return out;
}

// readLegacyEnvelopeAmount — the retired node-level `amount` master scale, read
// from the RAW node so the fold happens exactly once.
double readLegacyEnvelopeAmount(const nlohmann::json& nodeJson)
{
    const nlohmann::json* data = findObject(nodeJson, "data");
    if (data == nullptr) return 1.0;
    return clampUnitField(*data, "amount", 1.0);
}

} // namespace

// ─── Envelope shape ──────────────────────────────────────────────────────────

EnvelopeShapeSamples envelopeShapeToSamples(const EnvelopeShape& shape, double sampleRate)
{
    EnvelopeShapeSamples out;
    out.sustain = clamp01(shape.sustain, 0.0);
    if (!isFinite(sampleRate) || sampleRate <= 0.0) return out;

    const double perMs = sampleRate / 1000.0;
    out.attack  = std::max(0.0, shape.attackMs)  * perMs;
    out.hold    = std::max(0.0, shape.holdMs)    * perMs;
    out.decay   = std::max(0.0, shape.decayMs)   * perMs;
    out.release = std::max(0.0, shape.releaseMs) * perMs;
    return out;
}

EnvelopeShape normalizeEnvelopeShape(const nlohmann::json& rawData)
{
    const EnvelopeShape defaults;
    if (!rawData.is_object()) return defaults;

    EnvelopeShape out;
    out.attackMs  = clampMs(rawData, "attackMs",  defaults.attackMs);
    out.holdMs    = clampMs(rawData, "holdMs",    defaults.holdMs);
    out.decayMs   = clampMs(rawData, "decayMs",   defaults.decayMs);
    out.releaseMs = clampMs(rawData, "releaseMs", defaults.releaseMs);
    out.sustain   = clampUnitField(rawData, "sustain", defaults.sustain);
    out.includeSlideNotes = isLiteralTrue(rawData, "includeSlideNotes");
    return out;
}

// ─── Modulation mapping ──────────────────────────────────────────────────────

double evaluateBezierCurve(const ModulationMapping& mapping, double xTarget)
{
    const double x = clamp01(xTarget, 0.0);
    if (x == 0.0) return 0.0;
    if (x == 1.0) return 1.0;

    const double cp1x = mapping.cp1x;
    const double cp1y = mapping.cp1y;
    const double cp2x = mapping.cp2x;
    const double cp2y = mapping.cp2y;

    const auto bx = [&](double t) {
        const double s = 1.0 - t;
        return 3.0 * s * s * t * cp1x + 3.0 * s * t * t * cp2x + t * t * t;
    };
    const auto by = [&](double t) {
        const double s = 1.0 - t;
        return 3.0 * s * s * t * cp1y + 3.0 * s * t * t * cp2y + t * t * t;
    };

    // 32 iterations of binary subdivision (~3e-10). Fixed cost — audio-thread safe.
    double lo = 0.0;
    double hi = 1.0;
    for (int i = 0; i < 32; ++i) {
        const double mid = (lo + hi) * 0.5;
        if (bx(mid) < x) lo = mid;
        else             hi = mid;
        if (hi - lo < 1e-9) break;
    }

    return std::min(1.0, std::max(0.0, by((lo + hi) * 0.5)));
}

double evaluateModulationMapping(const ModulationMapping& mapping, double sourceValue)
{
    const double value = clamp01(sourceValue, 0.0);
    const double span  = mapping.sourceMax - mapping.sourceMin;

    double t;
    if (span <= 0.0) {
        // Degenerate window: step instead of dividing by zero.
        t = value < mapping.sourceMin ? 0.0 : 1.0;
    } else {
        t = std::min(1.0, std::max(0.0, (value - mapping.sourceMin) / span));
    }

    const double shaped = mapping.curve == MappingCurve::Bezier
        ? evaluateBezierCurve(mapping, t)
        : t;

    return std::min(1.0, std::max(0.0, mapping.base + mapping.depth * shaped));
}

// ─── Gate timeline ───────────────────────────────────────────────────────────

GateTimeline buildGateTimeline(std::vector<GateInterval> intervals)
{
    GateTimeline out;
    if (intervals.empty()) return out;

    std::stable_sort(intervals.begin(), intervals.end(),
                     [](const GateInterval& a, const GateInterval& b) {
                         return a.startTick < b.startTick;
                     });

    out.regions.reserve(intervals.size());
    out.starts.reserve(intervals.size());

    for (const auto& interval : intervals) {
        const bool joinsCurrent = !out.regions.empty()
                               && interval.startTick < out.regions.back().end;

        if (joinsCurrent) {
            GateRegion& current = out.regions.back();
            current.end = std::max(current.end, interval.endTick);
            // De-duplicate same-tick onsets so a chord collapses into one trigger.
            // Sorted input means a duplicate can only be the most recent start.
            if (out.starts.back() != interval.startTick) {
                out.starts.push_back(interval.startTick);
                ++current.startCount;
            }
        } else {
            GateRegion region;
            region.start       = interval.startTick;
            region.end         = interval.endTick;
            region.startOffset = static_cast<int>(out.starts.size());
            region.startCount  = 1;
            out.starts.push_back(interval.startTick);
            out.regions.push_back(region);
        }
    }

    return out;
}

EnvelopeGateView makeGateView(const GateTimeline& timeline)
{
    EnvelopeGateView view;
    view.regions     = timeline.regions.empty() ? nullptr : timeline.regions.data();
    view.regionCount = static_cast<int>(timeline.regions.size());
    view.starts      = timeline.starts.empty() ? nullptr : timeline.starts.data();
    view.startCount  = static_cast<int>(timeline.starts.size());
    return view;
}

int64_t tickToSample(int64_t tick, double bpm, double sampleRate)
{
    if (!isFinite(bpm) || bpm <= 0.0 || !isFinite(sampleRate) || sampleRate <= 0.0)
        return 0;
    const double seconds = (static_cast<double>(tick) / kTicksPerQuarter) * (60.0 / bpm);
    return static_cast<int64_t>(seconds * sampleRate);
}

ResolvedGate resolveActiveGateAtSample(const EnvelopeGateView& gates,
                                       int64_t querySample,
                                       double  bpm,
                                       double  sampleRate)
{
    ResolvedGate out;
    if (gates.regions == nullptr || gates.regionCount <= 0) return out;
    if (!isFinite(bpm) || bpm <= 0.0 || !isFinite(sampleRate) || sampleRate <= 0.0) return out;

    // Regions are sorted by start and non-overlapping, and tick->sample is
    // monotonic, so the last region whose start is at/before the query is the
    // only candidate: it either contains the query or is the most recent region
    // that already ended (its release tail may still be sounding).
    int lo = 0;
    int hi = gates.regionCount - 1;
    int candidate = -1;
    while (lo <= hi) {
        const int mid = lo + (hi - lo) / 2;
        if (tickToSample(gates.regions[mid].start, bpm, sampleRate) <= querySample) {
            candidate = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (candidate < 0) return out; // no gate has begun yet

    const GateRegion& region = gates.regions[candidate];

    // The latest onset at/before the query, defaulting to the region's first.
    // Once the region has fully ended every onset qualifies, so this is its last
    // onset — which is what the release tail must fall from.
    int64_t gateStartTick = gates.starts[region.startOffset];
    for (int i = 0; i < region.startCount; ++i) {
        const int index = region.startOffset + i;
        if (index >= gates.startCount) break;
        const int64_t start = gates.starts[index];
        if (tickToSample(start, bpm, sampleRate) <= querySample && start > gateStartTick)
            gateStartTick = start;
    }

    out.valid           = true;
    out.gateStartSample = tickToSample(gateStartTick, bpm, sampleRate);
    out.gateEndSample   = tickToSample(region.end, bpm, sampleRate);
    return out;
}

// ─── ADSR ────────────────────────────────────────────────────────────────────

double levelWhileHeld(const EnvelopeShapeSamples& shape, double heldSamples)
{
    if (heldSamples <= 0.0) {
        if (shape.attack > 0.0) return 0.0;
        if (shape.hold > 0.0 || shape.decay > 0.0) return 1.0;
        return shape.sustain;
    }

    const double attackEnd = shape.attack;
    const double holdEnd   = attackEnd + shape.hold;
    const double decayEnd  = holdEnd + shape.decay;

    if (heldSamples < attackEnd) return heldSamples / shape.attack;  // 0 -> 1
    if (heldSamples < holdEnd)   return 1.0;                         // plateau
    if (heldSamples < decayEnd) {
        const double t = shape.decay > 0.0 ? (heldSamples - holdEnd) / shape.decay : 1.0;
        return 1.0 + t * (shape.sustain - 1.0);                      // 1 -> sustain
    }
    return shape.sustain;
}

double evaluateEnvelopeAdsr(const EnvelopeShapeSamples& shape,
                            const ResolvedGate&         gate,
                            int64_t                     querySample)
{
    if (!gate.valid) return 0.0;
    if (querySample < gate.gateStartSample) return 0.0;

    const double heldSpan = std::max<double>(
        0.0, static_cast<double>(gate.gateEndSample - gate.gateStartSample));
    const double sinceStart = static_cast<double>(querySample - gate.gateStartSample);

    if (sinceStart < heldSpan)
        return clamp01(levelWhileHeld(shape, sinceStart));

    // Released. Fall from the level actually reached at gate end.
    const double releaseStartLevel = clamp01(levelWhileHeld(shape, heldSpan));
    const double sinceRelease      = sinceStart - heldSpan;
    if (shape.release <= 0.0) return 0.0;
    if (sinceRelease >= shape.release) return 0.0;
    return clamp01(releaseStartLevel * (1.0 - sinceRelease / shape.release));
}

double evaluateEnvelopeAtSample(const EnvelopeShapeSamples& shape,
                                const EnvelopeGateView&     gates,
                                int64_t                     querySample,
                                double                      bpm,
                                double                      sampleRate)
{
    const ResolvedGate gate = resolveActiveGateAtSample(gates, querySample, bpm, sampleRate);
    return evaluateEnvelopeAdsr(shape, gate, querySample);
}

// ─── graphState parse ────────────────────────────────────────────────────────

const char* toString(EdgeSkipReason reason)
{
    switch (reason) {
        case EdgeSkipReason::Disabled:              return "disabled";
        case EdgeSkipReason::InvalidTarget:         return "invalid_target";
        case EdgeSkipReason::MissingNode:           return "missing_node";
        case EdgeSkipReason::MissingEffectInstance: return "missing_effect_instance";
        case EdgeSkipReason::MissingExposedPort:    return "missing_exposed_port";
        case EdgeSkipReason::ReadOnly:              return "read_only";
    }
    return "unknown";
}

namespace {

// resolveGraphParameterTarget, ported. Returns the skip reason, or nothing on
// success (in which case `readOnly` is filled from the matched exposed port).
struct TargetResolution {
    bool           ok       = false;
    EdgeSkipReason reason   = EdgeSkipReason::InvalidTarget;
    bool           readOnly = false;
};

TargetResolution resolveTarget(const nlohmann::json& graphState,
                              const nlohmann::json& targetJson,
                              const std::string&    graphNodeId,
                              const std::string&    effectInstanceId,
                              const std::string&    parameterId)
{
    (void) targetJson;
    TargetResolution res;

    const nlohmann::json* nodes = findArray(graphState, "nodes");
    if (nodes == nullptr) {
        res.reason = EdgeSkipReason::MissingNode;
        return res;
    }

    const nlohmann::json* node = nullptr;
    for (const auto& candidate : *nodes) {
        if (!candidate.is_object()) continue;
        if (readString(candidate, "id") == graphNodeId) { node = &candidate; break; }
    }
    if (node == nullptr) {
        res.reason = EdgeSkipReason::MissingNode;
        return res;
    }

    const nlohmann::json* data = findObject(*node, "data");
    const std::string nodeEffectInstanceId =
        data != nullptr ? readTrimmedString(*data, "effectInstanceId") : std::string();
    if (nodeEffectInstanceId.empty() || nodeEffectInstanceId != effectInstanceId) {
        res.reason = EdgeSkipReason::MissingEffectInstance;
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
        res.reason = EdgeSkipReason::MissingExposedPort;
        return res;
    }

    // readOnly === true, or automatable === false.
    const bool readOnly = isLiteralTrue(*matched, "readOnly");
    bool automatable = true;
    if (auto it = matched->find("automatable"); it != matched->end() && it->is_boolean())
        automatable = it->get<bool>();

    res.ok       = true;
    res.readOnly = readOnly || !automatable;
    return res;
}

} // namespace

ParsedGraphEnvelopes parseGraphStateEnvelopes(const nlohmann::json& graphState)
{
    ParsedGraphEnvelopes out;
    if (!graphState.is_object()) return out;

    const nlohmann::json* nodes = findArray(graphState, "nodes");
    const nlohmann::json* edges = findArray(graphState, "edges");
    if (nodes == nullptr) return out;

    for (const auto& node : *nodes) {
        if (!node.is_object()) continue;
        if (readString(node, "type") != "envelope") continue;

        const std::string nodeId = readString(node, "id");
        if (nodeId.empty()) continue;

        EnvelopeNodeDefinition def;
        def.nodeId = nodeId;
        const nlohmann::json* data = findObject(node, "data");
        def.shape = normalizeEnvelopeShape(data != nullptr ? *data : nlohmann::json::object());

        // The retired node-level `amount`, folded into each outgoing edge's depth
        // exactly once when the edge's mapping is still a legacy range mapping.
        const double legacyAmount = readLegacyEnvelopeAmount(node);

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

                // Dispatch on the persisted `kind` discriminant: an absent kind
                // means the legacy absolute range mapping, which is migrated.
                const bool isModulation = readString(mapping, "kind") == "modulation";
                ModulationMapping normalizedMapping = isModulation
                    ? readModulationMapping(mapping)
                    : migrateRangeMapping(mapping, legacyAmount);

                if (!normalizedMapping.enabled) {
                    out.skipped.push_back({edgeId, EdgeSkipReason::Disabled});
                    continue;
                }

                // normalizeGraphParameterTarget
                const nlohmann::json* targetJson = findObject(edge, "targetParameter");
                if (targetJson == nullptr
                    || readString(*targetJson, "kind") != "graph-parameter") {
                    out.skipped.push_back({edgeId, EdgeSkipReason::InvalidTarget});
                    continue;
                }
                const std::string graphNodeId      = readTrimmedString(*targetJson, "graphNodeId");
                const std::string effectInstanceId = readTrimmedString(*targetJson, "effectInstanceId");
                const std::string parameterId      = readTrimmedString(*targetJson, "parameterId");
                if (graphNodeId.empty() || effectInstanceId.empty() || parameterId.empty()) {
                    out.skipped.push_back({edgeId, EdgeSkipReason::InvalidTarget});
                    continue;
                }
                // A fallback parameterId requires a finite non-negative integer index.
                if (isLiteralTrue(*targetJson, "parameterIdIsFallback")) {
                    auto it = targetJson->find("parameterIndexFallback");
                    const bool validIndex = it != targetJson->end()
                                         && it->is_number_integer()
                                         && it->get<int64_t>() >= 0;
                    if (!validIndex) {
                        out.skipped.push_back({edgeId, EdgeSkipReason::InvalidTarget});
                        continue;
                    }
                }

                const TargetResolution res = resolveTarget(
                    graphState, *targetJson, graphNodeId, effectInstanceId, parameterId);
                if (!res.ok) {
                    out.skipped.push_back({edgeId, res.reason});
                    continue;
                }
                if (res.readOnly) {
                    out.skipped.push_back({edgeId, EdgeSkipReason::ReadOnly});
                    continue;
                }

                ModulationTargetEdge resolved;
                resolved.edgeId           = edgeId;
                resolved.effectInstanceId = effectInstanceId;
                resolved.parameterId      = parameterId;
                resolved.mapping          = normalizedMapping;
                def.edges.push_back(std::move(resolved));
            }
        }

        out.envelopes.push_back(std::move(def));
    }

    return out;
}

// ─── Authoritative gate derivation from the Timeline ─────────────────────────

TrackGateBuild buildTrackGateIntervals(const Timeline& timeline,
                                      int             trackId,
                                      bool            includeSlideNotes)
{
    TrackGateBuild out;

    // ── Pattern-note gates ──
    // Mirrors MixEngine::triggerPatternNotes exactly. `sawAnyNote` is tracked
    // separately from the emitted intervals so the inferred source is decided
    // BEFORE the slide filter (see the header note): a track holding only slide
    // notes is still a NOTE track and must not fall through to clip gates.
    bool sawAnyNote = false;

    for (const auto* block : timeline.getAllPatternBlocks()) {
        if (block == nullptr) continue;
        if (block->trackId != trackId) continue;

        const Pattern* pattern = timeline.getPattern(block->patternId);
        if (pattern == nullptr) continue;

        const int64_t patternLenTicks = pattern->length.ticks;
        if (patternLenTicks <= 0) continue;

        // A pattern with no bound region produces no audio in the engine
        // (findActivePatternBlocks skips it), so it produces no gates here.
        if (pattern->regionId < 0) continue;
        if (pattern->notes.empty()) continue;

        const int64_t blockPosTicks    = block->position.ticks;
        const int64_t blockOffsetTicks = block->offset.ticks;
        const int64_t blockEndTicks    = blockPosTicks + block->duration.ticks;
        if (blockEndTicks <= blockPosTicks) continue;

        // The whole-block window: the trigger path narrows this to the current
        // buffer, but every onset inside the block fires in exactly one buffer,
        // so the union over all buffers is the block window.
        const int64_t windowStart = blockPosTicks;
        const int64_t windowEnd   = blockEndTicks;

        const int64_t firstLoopIdx = std::max<int64_t>(
            0, (windowStart - blockPosTicks + blockOffsetTicks) / patternLenTicks);
        int64_t lastLoopIdx =
            (windowEnd - blockPosTicks + blockOffsetTicks) / patternLenTicks;
        if (!block->loopEnabled)
            lastLoopIdx = std::min<int64_t>(lastLoopIdx, 0);

        for (const auto& note : pattern->notes) {
            for (int64_t L = firstLoopIdx; L <= lastLoopIdx; ++L) {
                const int64_t absNoteOn = blockPosTicks - blockOffsetTicks
                                        + L * patternLenTicks + note.position.ticks;
                if (absNoteOn < windowStart || absNoteOn >= windowEnd) continue;

                sawAnyNote = true;

                if (note.isSlide && !includeSlideNotes) continue;

                // The block-end clamp: a note whose duration reaches or exceeds
                // the block boundary releases there, exactly as the engine's
                // note-off does.
                const int64_t absNoteOff =
                    std::min<int64_t>(absNoteOn + note.duration.ticks, blockEndTicks);

                GateInterval interval;
                interval.startTick = absNoteOn;
                interval.endTick   = absNoteOff > absNoteOn ? absNoteOff : absNoteOn;
                out.intervals.push_back(interval);
            }
        }
    }

    if (sawAnyNote) {
        out.source = GateSourceKind::Notes;
        return out;
    }

    // ── Clip gates ──
    // Clip activity is position-pure in the engine (findActiveClips is a plain
    // overlap test against [position, position + duration)), so the gate is the
    // clip's own span.
    out.intervals.clear();
    for (const auto* clip : timeline.getAllClips()) {
        if (clip == nullptr) continue;
        if (clip->trackId != trackId) continue;

        const int64_t startTick = clip->position.ticks;
        if (startTick < 0) continue;
        const int64_t durTicks = std::max<int64_t>(0, clip->duration.ticks);

        GateInterval interval;
        interval.startTick = startTick;
        interval.endTick   = startTick + durTicks;
        out.intervals.push_back(interval);
    }

    if (!out.intervals.empty())
        out.source = GateSourceKind::Clips;
    return out;
}

// ─── Published snapshot ──────────────────────────────────────────────────────

std::shared_ptr<const EnvelopeModulationSnapshot>
buildEnvelopeModulationSnapshot(const Timeline& timeline)
{
    auto snapshot = std::make_shared<EnvelopeModulationSnapshot>();

    // Route-aware mute/solo closure — the same plan the audio thread builds, so
    // the envelope's idea of "this track is playing" cannot drift from the mixer's.
    const auto allTracks = timeline.getAllTracks();
    xleth::RoutePlanSlotInput routeInputs[xleth::RoutePlan::kMaxSlots];
    int slotCount = 0;
    for (const auto* t : allTracks) {
        if (t == nullptr || slotCount >= xleth::RoutePlan::kMaxSlots) continue;
        routeInputs[slotCount].trackId             = t->id;
        routeInputs[slotCount].outputTargetTrackId = t->outputRoute.targetTrackId;
        routeInputs[slotCount].muted               = t->muted;
        routeInputs[slotCount].solo                = t->solo;
        routeInputs[slotCount].visualOnly          = t->visualOnly;
        ++slotCount;
    }
    xleth::RoutePlan routePlan;
    xleth::buildRoutePlan(routeInputs, slotCount, routePlan);

    int slot = 0;
    for (const auto* track : allTracks) {
        if (track == nullptr) continue;
        const int currentSlot = slot++;
        if (currentSlot >= slotCount) break;

        // Graph-mode normal tracks only. Chain mode and the master are untouched.
        if (track->fxMode != TrackFxMode::Graph) continue;
        if (!track->hasGraphState) continue;

        const ParsedGraphEnvelopes parsed = parseGraphStateEnvelopes(track->graphState);
        if (parsed.envelopes.empty()) continue;

        const bool audible = routePlan.audible[currentSlot];

        for (const auto& def : parsed.envelopes) {
            if (def.edges.empty()) continue;

            SnapshotEnvelope entry;
            entry.shape = def.shape;

            // An inaudible track gets NO gates: the envelope reads 0 everywhere,
            // which every edge maps to exactly its authored base. Muting releases
            // the modulation rather than freezing it at its last value.
            if (audible) {
                TrackGateBuild gates =
                    buildTrackGateIntervals(timeline, track->id, def.shape.includeSlideNotes);
                entry.gates = buildGateTimeline(std::move(gates.intervals));
            }

            entry.edgeOffset = static_cast<int>(snapshot->edges.size());
            entry.edgeCount  = static_cast<int>(def.edges.size());

            for (const auto& edge : def.edges) {
                SnapshotEdge snapshotEdge;
                snapshotEdge.mapping      = edge.mapping;
                snapshotEdge.mailboxIndex = static_cast<int>(snapshot->mailboxTargets.size());
                snapshot->edges.push_back(snapshotEdge);

                EnvelopeMailboxTarget target;
                target.trackId          = track->id;
                target.effectInstanceId = edge.effectInstanceId;
                target.parameterId      = edge.parameterId;
                snapshot->mailboxTargets.push_back(std::move(target));
            }

            snapshot->envelopes.push_back(std::move(entry));
        }
    }

    snapshot->mailboxCount = static_cast<int>(snapshot->mailboxTargets.size());
    if (snapshot->mailboxCount > 0)
        snapshot->mailboxes = std::make_unique<EnvelopeMailbox[]>(
            static_cast<std::size_t>(snapshot->mailboxCount));

    return snapshot;
}

} // namespace xleth::envmod
