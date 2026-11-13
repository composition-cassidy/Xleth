#include "LensRoam.h"

#include "Timeline.h"

#include <algorithm>
#include <cmath>
#include <tuple>
#include <utility>

namespace lensroam {

namespace {

using json = nlohmann::json;

float finiteOr(const json& j, const char* key, float fallback) {
    if (!j.is_object() || !j.contains(key) || !j.at(key).is_number()) return fallback;
    const double v = j.at(key).get<double>();
    return std::isfinite(v) ? static_cast<float>(v) : fallback;
}

// A multiplier must be finite AND positive: zoom 0 is a black cell, a
// negative one a silent mirror. Anything else loads as identity (1.0).
float positiveOr(const json& j, const char* key, float fallback) {
    const float v = finiteOr(j, key, fallback);
    return v > 0.0f ? v : fallback;
}

std::string stringOr(const json& j, const char* key) {
    if (!j.is_object() || !j.contains(key) || !j.at(key).is_string()) return {};
    return j.at(key).get<std::string>();
}

LensFit lensFitFromString(const std::string& s) {
    if (s == "Cover")   return LensFit::Cover;
    if (s == "Contain") return LensFit::Contain;
    return LensFit::Stretch;
}

LensFlip lensFlipFromString(const std::string& s) {
    if (s == "None")       return LensFlip::None;
    if (s == "Horizontal") return LensFlip::Horizontal;
    if (s == "Vertical")   return LensFlip::Vertical;
    return LensFlip::FollowTrack;
}

RoamBounds roamBoundsFromString(const std::string& s) {
    return s == "Float" ? RoamBounds::Float : RoamBounds::Clip;
}

RoamLayer roamLayerFromString(const std::string& s) {
    if (s == "AboveNeighbours") return RoamLayer::AboveNeighbours;
    if (s == "Top")             return RoamLayer::Top;
    return RoamLayer::GridOrder;
}

const char* anchorToString(KeyAnchor a) {
    switch (a) {
        case KeyAnchor::Head: return "Head";
        case KeyAnchor::Body: return "Body";
        case KeyAnchor::Tail: return "Tail";
        default:              return "Origin";
    }
}

bool anchorFromString(const std::string& s, KeyAnchor& out) {
    if (s == "Origin") { out = KeyAnchor::Origin; return true; }
    if (s == "Head")   { out = KeyAnchor::Head;   return true; }
    if (s == "Body")   { out = KeyAnchor::Body;   return true; }
    if (s == "Tail")   { out = KeyAnchor::Tail;   return true; }
    return false;
}

const char* channelToString(LensChannel c) {
    switch (c) {
        case LensChannel::CenterX:     return "centerX";
        case LensChannel::CenterY:     return "centerY";
        case LensChannel::Zoom:        return "zoom";
        default:                       return "rotationDeg";
    }
}

const char* channelToString(RoamChannel c) {
    switch (c) {
        case RoamChannel::OffsetX:     return "offsetX";
        case RoamChannel::OffsetY:     return "offsetY";
        case RoamChannel::Scale:       return "scale";
        default:                       return "rotationDeg";
    }
}

bool channelFromString(const std::string& s, LensChannel& out) {
    if (s == "centerX")     { out = LensChannel::CenterX;     return true; }
    if (s == "centerY")     { out = LensChannel::CenterY;     return true; }
    if (s == "zoom")        { out = LensChannel::Zoom;        return true; }
    if (s == "rotationDeg") { out = LensChannel::RotationDeg; return true; }
    return false;
}

bool channelFromString(const std::string& s, RoamChannel& out) {
    if (s == "offsetX")     { out = RoamChannel::OffsetX;     return true; }
    if (s == "offsetY")     { out = RoamChannel::OffsetY;     return true; }
    if (s == "scale")       { out = RoamChannel::Scale;       return true; }
    if (s == "rotationDeg") { out = RoamChannel::RotationDeg; return true; }
    return false;
}

template <typename Channel>
json keyToJson(const LensRoamKey<Channel>& k) {
    return json{
        {"channel", channelToString(k.channel)},
        {"anchor",  anchorToString(k.anchor)},
        {"pos",     k.pos},
        {"value",   k.value},
        {"p1x", k.p1x}, {"p1y", k.p1y}, {"p2x", k.p2x}, {"p2y", k.p2y},
    };
}

// Strict: a key whose channel/anchor is unknown or whose time/value is not a
// finite number is dropped rather than guessed at.
template <typename Channel>
bool keyFromJson(const json& j, LensRoamKey<Channel>& k) {
    if (!j.is_object()) return false;
    if (!channelFromString(stringOr(j, "channel"), k.channel)) return false;
    if (!anchorFromString(stringOr(j, "anchor"), k.anchor)) return false;
    if (!j.contains("pos") || !j.at("pos").is_number()) return false;
    if (!j.contains("value") || !j.at("value").is_number()) return false;
    k.pos   = j.at("pos").get<double>();
    k.value = j.at("value").get<double>();
    if (!std::isfinite(k.pos) || !std::isfinite(k.value)) return false;
    const LensRoamKey<Channel> d;
    k.p1x = finiteOr(j, "p1x", d.p1x);
    k.p1y = finiteOr(j, "p1y", d.p1y);
    k.p2x = finiteOr(j, "p2x", d.p2x);
    k.p2y = finiteOr(j, "p2y", d.p2y);
    return true;
}

template <typename Channel>
json keysToJson(const std::vector<LensRoamKey<Channel>>& keys) {
    json arr = json::array();
    for (const auto& k : keys) arr.push_back(keyToJson(k));
    return arr;
}

template <typename Channel>
std::vector<LensRoamKey<Channel>> keysFromJson(const json& j, const char* field) {
    std::vector<LensRoamKey<Channel>> out;
    if (!j.is_object() || !j.contains(field) || !j.at(field).is_array()) return out;
    for (const auto& e : j.at(field)) {
        LensRoamKey<Channel> k;
        if (keyFromJson(e, k)) out.push_back(k);
    }
    return out;
}

} // namespace

const char* lensFitToString(LensFit f) {
    switch (f) {
        case LensFit::Cover:   return "Cover";
        case LensFit::Contain: return "Contain";
        default:               return "Stretch";
    }
}

const char* lensFlipToString(LensFlip f) {
    switch (f) {
        case LensFlip::None:       return "None";
        case LensFlip::Horizontal: return "Horizontal";
        case LensFlip::Vertical:   return "Vertical";
        default:                   return "FollowTrack";
    }
}

const char* roamBoundsToString(RoamBounds b) {
    return b == RoamBounds::Float ? "Float" : "Clip";
}

const char* roamLayerToString(RoamLayer l) {
    switch (l) {
        case RoamLayer::AboveNeighbours: return "AboveNeighbours";
        case RoamLayer::Top:             return "Top";
        default:                         return "GridOrder";
    }
}

json lensParamsToJson(const LensParams& p) {
    return json{
        {"fit",         lensFitToString(p.fit)},
        {"centerX",     p.centerX},
        {"centerY",     p.centerY},
        {"zoom",        p.zoom},
        {"rotationDeg", p.rotationDeg},
        {"flip",        lensFlipToString(p.flip)},
    };
}

LensParams lensParamsFromJson(const json& j) {
    const LensParams d;
    LensParams p;
    if (!j.is_object()) return p;
    p.fit         = lensFitFromString(stringOr(j, "fit"));
    p.centerX     = finiteOr(j, "centerX", d.centerX);
    p.centerY     = finiteOr(j, "centerY", d.centerY);
    p.zoom        = positiveOr(j, "zoom", d.zoom);
    p.rotationDeg = finiteOr(j, "rotationDeg", d.rotationDeg);
    p.flip        = lensFlipFromString(stringOr(j, "flip"));
    return p;
}

json roamParamsToJson(const RoamParams& p) {
    return json{
        {"offsetX",     p.offsetX},
        {"offsetY",     p.offsetY},
        {"scale",       p.scale},
        {"rotationDeg", p.rotationDeg},
        {"bounds",      roamBoundsToString(p.bounds)},
        {"layer",       roamLayerToString(p.layer)},
    };
}

RoamParams roamParamsFromJson(const json& j) {
    const RoamParams d;
    RoamParams p;
    if (!j.is_object()) return p;
    p.offsetX     = finiteOr(j, "offsetX", d.offsetX);
    p.offsetY     = finiteOr(j, "offsetY", d.offsetY);
    p.scale       = positiveOr(j, "scale", d.scale);
    p.rotationDeg = finiteOr(j, "rotationDeg", d.rotationDeg);
    p.bounds      = roamBoundsFromString(stringOr(j, "bounds"));
    p.layer       = roamLayerFromString(stringOr(j, "layer"));
    return p;
}

json lensTrackToJson(const LensTrack& t, const char* keysField) {
    json j = json::object();
    j["base"]    = lensParamsToJson(t.base);
    j[keysField] = keysToJson(t.keys);
    return j;
}

LensTrack lensTrackFromJson(const json& j, const char* keysField) {
    LensTrack t;
    if (!j.is_object()) return t;
    if (j.contains("base")) t.base = lensParamsFromJson(j.at("base"));
    t.keys = keysFromJson<LensChannel>(j, keysField);
    return t;
}

json roamTrackToJson(const RoamTrack& t) {
    json j = json::object();
    j["base"] = roamParamsToJson(t.base);
    j["keys"] = keysToJson(t.keys);
    return j;
}

RoamTrack roamTrackFromJson(const json& j) {
    RoamTrack t;
    if (!j.is_object()) return t;
    if (j.contains("base")) t.base = roamParamsFromJson(j.at("base"));
    t.keys = keysFromJson<RoamChannel>(j, "keys");
    return t;
}

json trackLensToJson(const std::map<int, LensTrack>& m) {
    json arr = json::array();
    for (const auto& [regionId, lens] : m) {
        json e = lensTrackToJson(lens, "hitCurve");
        e["regionId"] = regionId;
        arr.push_back(std::move(e));
    }
    return arr;
}

std::map<int, LensTrack> trackLensFromJson(const json& j) {
    std::map<int, LensTrack> m;
    if (!j.is_array()) return m;
    for (const auto& e : j) {
        if (!e.is_object() || !e.contains("regionId") || !e.at("regionId").is_number_integer())
            continue;
        const int regionId = e.at("regionId").get<int>();
        if (regionId < 0 || m.count(regionId)) continue;  // first wins on a duplicate
        m.emplace(regionId, lensTrackFromJson(e, "hitCurve"));
    }
    return m;
}

LensParams resolveSourceLens(const TrackInfo& track, int regionId) {
    const auto it = track.trackLens.find(regionId);
    if (it != track.trackLens.end()) return resolveBase(it->second);
    return LensParams::newContentDefault();
}

MigrationStats migratePreLensProject(Timeline& timeline) {
    MigrationStats stats;
    stats.clips = static_cast<int>(timeline.getAllClips().size());

    std::vector<int> trackIds;
    for (const TrackInfo* t : timeline.getAllTracks()) trackIds.push_back(t->id);
    stats.tracks = static_cast<int>(trackIds.size());

    for (int trackId : trackIds) {
        TrackInfo* track = timeline.getTrackMutable(trackId);
        if (!track || track->type != TrackInfo::Type::Pattern) continue;
        // The sources this track plays today: the region of every pattern
        // placed on it. Each keeps today's stretched framing.
        for (const PatternBlock* block : timeline.getPatternBlocksOnTrack(trackId)) {
            const Pattern* pattern = timeline.getPattern(block->patternId);
            if (!pattern || pattern->regionId < 0) continue;
            if (track->trackLens.emplace(pattern->regionId, LensTrack{}).second)
                ++stats.patternSources;
        }
    }
    return stats;
}

} // namespace lensroam

// ─── LensRoamSnapshot ─────────────────────────────────────────────────────────

RoamParams LensRoamSnapshot::roamFor(int trackId) const {
    const auto it = std::lower_bound(tracks.begin(), tracks.end(), trackId,
        [](const TrackEntry& e, int id) { return e.trackId < id; });
    return (it != tracks.end() && it->trackId == trackId) ? it->roam : RoamParams{};
}

LensParams LensRoamSnapshot::lensForClip(int clipId) const {
    const auto it = std::lower_bound(clips.begin(), clips.end(), clipId,
        [](const ClipEntry& e, int id) { return e.clipId < id; });
    return (it != clips.end() && it->clipId == clipId) ? it->lens : LensParams{};
}

LensParams LensRoamSnapshot::lensForSource(int trackId, int regionId) const {
    const auto it = std::lower_bound(sources.begin(), sources.end(),
        std::make_pair(trackId, regionId),
        [](const SourceEntry& e, const std::pair<int, int>& k) {
            return std::tie(e.trackId, e.regionId) < std::tie(k.first, k.second);
        });
    if (it != sources.end() && it->trackId == trackId && it->regionId == regionId)
        return it->lens;
    const auto tr = std::lower_bound(tracks.begin(), tracks.end(), trackId,
        [](const TrackEntry& e, int id) { return e.trackId < id; });
    return (tr != tracks.end() && tr->trackId == trackId) ? tr->sourceFallback : LensParams{};
}

LensRoamSnapshot::Counts LensRoamSnapshot::counts() const {
    Counts c;
    c.tracks  = static_cast<int>(tracks.size());
    c.clips   = static_cast<int>(clips.size());
    c.sources = static_cast<int>(sources.size());
    for (const auto& t : tracks)  if (!t.roam.isIdentity()) ++c.roamNonIdentity;
    for (const auto& e : clips)   if (!e.lens.isIdentity()) ++c.clipLensNonIdentity;
    for (const auto& e : sources) if (!e.lens.isIdentity()) ++c.sourceLensNonIdentity;
    return c;
}

std::shared_ptr<const LensRoamSnapshot> buildLensRoamSnapshot(const Timeline& timeline) {
    auto snap = std::make_shared<LensRoamSnapshot>();

    const auto tracks = timeline.getAllTracks();
    snap->tracks.reserve(tracks.size());
    for (const TrackInfo* t : tracks) {
        LensRoamSnapshot::TrackEntry e;
        e.trackId = t->id;
        e.roam    = lensroam::resolveBase(t->roam);
        e.sourceFallback = t->type == TrackInfo::Type::Pattern
            ? LensParams::newContentDefault() : LensParams{};
        snap->tracks.push_back(e);
        for (const auto& [regionId, lens] : t->trackLens)
            snap->sources.push_back({ t->id, regionId, lensroam::resolveBase(lens) });
    }

    const auto clips = timeline.getAllClips();
    snap->clips.reserve(clips.size());
    for (const Clip* c : clips)
        snap->clips.push_back({ c->id, lensroam::resolveBase(c->lens) });

    std::sort(snap->tracks.begin(), snap->tracks.end(),
        [](const auto& a, const auto& b) { return a.trackId < b.trackId; });
    std::sort(snap->clips.begin(), snap->clips.end(),
        [](const auto& a, const auto& b) { return a.clipId < b.clipId; });
    std::sort(snap->sources.begin(), snap->sources.end(),
        [](const auto& a, const auto& b) {
            return std::tie(a.trackId, a.regionId) < std::tie(b.trackId, b.regionId);
        });
    return snap;
}
