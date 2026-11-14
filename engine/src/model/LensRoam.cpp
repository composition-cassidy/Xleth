#include "LensRoam.h"

#include "Timeline.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
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

using xleth::keycurve::Interp;
using xleth::keycurve::NoteZones;
using xleth::keycurve::ShortNoteRule;

// Unknown or missing -> Linear: the segment shape P1's default bezier handles
// described, so a key saved before P7 evaluates as it was always meant to.
Interp interpFromString(const std::string& s) {
    if (s == "Hold")    return Interp::Hold;
    if (s == "EaseOut") return Interp::EaseOut;
    return Interp::Linear;
}

template <typename Channel>
json keyToJson(const LensRoamKey<Channel>& k) {
    return json{
        {"channel", channelToString(k.channel)},
        {"anchor",  anchorToString(k.anchor)},
        {"pos",     k.pos},
        {"value",   k.value},
        {"interp",  interpToString(k.interp)},
    };
}

// Strict: a key whose channel/anchor is unknown or whose time/value is not a
// finite number is dropped rather than guessed at. `interp` is tolerant
// (missing/unknown = Linear); P1's p1x..p2y handles, if present, are ignored.
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
    k.interp = interpFromString(stringOr(j, "interp"));
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

const char* lensOverrideModeToString(LensOverrideMode m) {
    return m == LensOverrideMode::Own ? "Own" : "Nudge";
}

const char* interpToString(Interp i) {
    switch (i) {
        case Interp::Hold:    return "Hold";
        case Interp::EaseOut: return "EaseOut";
        default:              return "Linear";
    }
}

const char* shortNoteRuleToString(ShortNoteRule r) {
    return r == ShortNoteRule::Cut ? "Cut" : "Squash";
}

json noteZonesToJson(const NoteZones& z) {
    return json{
        {"headTicks", z.headTicks},
        {"tailTicks", z.tailTicks},
        {"shortNote", shortNoteRuleToString(z.rule)},
    };
}

// Tolerant: a zone length that is missing, non-numeric, non-finite or
// negative loads as the spec default; an unknown rule as Squash (the default).
NoteZones noteZonesFromJson(const json& j) {
    const NoteZones d;
    NoteZones z;
    if (!j.is_object()) return z;
    auto ticks = [&j](const char* key, double fallback) {
        if (!j.contains(key) || !j.at(key).is_number()) return fallback;
        return xleth::keycurve::sanitizeZoneTicks(j.at(key).get<double>(), fallback);
    };
    z.headTicks = ticks("headTicks", d.headTicks);
    z.tailTicks = ticks("tailTicks", d.tailTicks);
    z.rule = stringOr(j, "shortNote") == "Cut" ? ShortNoteRule::Cut : ShortNoteRule::Squash;
    return z;
}

json lensNoteOverrideToJson(const LensNoteOverride& o) {
    json j = json::object();
    j["mode"] = lensOverrideModeToString(o.mode);
    j["keys"] = keysToJson(o.keys);
    return j;
}

LensNoteOverridePtr lensNoteOverrideFromJson(const json& j) {
    if (!j.is_object()) return nullptr;
    const std::string mode = stringOr(j, "mode");
    auto o = std::make_shared<LensNoteOverride>();
    if (mode == "Nudge")    o->mode = LensOverrideMode::Nudge;
    else if (mode == "Own") o->mode = LensOverrideMode::Own;
    else return nullptr;  // no mode is no override: Follow
    o->keys = keysFromJson<LensChannel>(j, "keys");
    return o;
}

json trackLensToJson(const std::map<int, LensTrack>& m) {
    json arr = json::array();
    for (const auto& [regionId, lens] : m) {
        json e = lensTrackToJson(lens, "hitCurve");
        e["regionId"] = regionId;
        e["zones"]    = noteZonesToJson(lens.zones);
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
        LensTrack t = lensTrackFromJson(e, "hitCurve");
        if (e.contains("zones")) t.zones = noteZonesFromJson(e.at("zones"));
        m.emplace(regionId, std::move(t));
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

namespace {

const LensRoamSnapshot::TrackEntry* findTrack(const std::vector<LensRoamSnapshot::TrackEntry>& v,
                                              int trackId) {
    const auto it = std::lower_bound(v.begin(), v.end(), trackId,
        [](const LensRoamSnapshot::TrackEntry& e, int id) { return e.trackId < id; });
    return (it != v.end() && it->trackId == trackId) ? &*it : nullptr;
}

const LensRoamSnapshot::ClipEntry* findClip(const std::vector<LensRoamSnapshot::ClipEntry>& v,
                                            int clipId) {
    const auto it = std::lower_bound(v.begin(), v.end(), clipId,
        [](const LensRoamSnapshot::ClipEntry& e, int id) { return e.clipId < id; });
    return (it != v.end() && it->clipId == clipId) ? &*it : nullptr;
}

bool overrideLess(const LensRoamSnapshot::OverrideEntry& a, const LensRoamSnapshot::OverrideEntry& b) {
    return std::tie(a.trackId, a.patternId, a.noteId) < std::tie(b.trackId, b.patternId, b.noteId);
}

const LensRoamSnapshot::OverrideEntry* findOverride(
        const std::vector<LensRoamSnapshot::OverrideEntry>& v, int trackId, int patternId, int noteId) {
    LensRoamSnapshot::OverrideEntry key;
    key.trackId = trackId; key.patternId = patternId; key.noteId = noteId;
    const auto it = std::lower_bound(v.begin(), v.end(), key, overrideLess);
    return (it != v.end() && it->trackId == trackId && it->patternId == patternId
            && it->noteId == noteId) ? &*it : nullptr;
}

const LensRoamSnapshot::SourceEntry* findSource(const std::vector<LensRoamSnapshot::SourceEntry>& v,
                                                int trackId, int regionId) {
    const auto it = std::lower_bound(v.begin(), v.end(), std::make_pair(trackId, regionId),
        [](const LensRoamSnapshot::SourceEntry& e, const std::pair<int, int>& k) {
            return std::tie(e.trackId, e.regionId) < std::tie(k.first, k.second);
        });
    return (it != v.end() && it->trackId == trackId && it->regionId == regionId) ? &*it : nullptr;
}

// One keyed channel of an EventTicks / TimelineTicks curve: its keys' value at
// t, or `base` when the channel has no keys (ABSOLUTE: keys replace the base).
float absoluteAt(const std::vector<xleth::keycurve::Key>& pool,
                 const LensRoamSnapshot::KeyRun& run, double t, float base) {
    if (run.count == 0) return base;
    return static_cast<float>(
        xleth::keycurve::valueAt(pool.data() + run.first, run.count, t, base));
}

// An unused layer: every channel unkeyed (constant-initialized, no guard).
const LensRoamSnapshot::ChannelRuns kNoRuns{};

// One channel of a note curve: the LAYER value, or the layer identity when the
// channel has no keys.
double layerAt(const std::vector<xleth::keycurve::Key>& pool,
               const LensRoamSnapshot::KeyRun& run, const xleth::keycurve::NoteSpan& span,
               double tSinceNoteOn, double identity) {
    if (run.count == 0) return identity;
    return xleth::keycurve::valueAtNote(pool.data() + run.first, run.count, span,
                                        tSinceNoteOn, identity);
}

} // namespace

RoamParams LensRoamSnapshot::roamFor(int trackId) const {
    const TrackEntry* e = findTrack(tracks, trackId);
    return e ? e->roam : RoamParams{};
}

LensParams LensRoamSnapshot::lensForClip(int clipId) const {
    const ClipEntry* e = findClip(clips, clipId);
    return e ? e->lens : LensParams{};
}

LensParams LensRoamSnapshot::lensForSource(int trackId, int regionId) const {
    if (const SourceEntry* e = findSource(sources, trackId, regionId)) return e->lens;
    const TrackEntry* tr = findTrack(tracks, trackId);
    return tr ? tr->sourceFallback : LensParams{};
}

const LensRoamSnapshot::OverrideEntry* LensRoamSnapshot::overrideFor(int trackId, int patternId,
                                                                     int noteId) const {
    if (patternId < 0 || overrides.empty()) return nullptr;
    return findOverride(overrides, trackId, patternId, noteId);
}

LensParams LensRoamSnapshot::lensForEventAt(int trackId, int clipId, int regionId,
                                            const EventClock& clock, const NoteRef& note) const {
    const double t = clock.frameTick - clock.eventStartTick;

    if (clipId >= 0) {
        const ClipEntry* e = findClip(clips, clipId);
        if (!e) return LensParams{};
        LensParams p = e->lens;
        if (!e->keyed) return p;
        const auto& r = e->lensKeys;
        p.centerX     = absoluteAt(keys, r[static_cast<int>(LensChannel::CenterX)],     t, p.centerX);
        p.centerY     = absoluteAt(keys, r[static_cast<int>(LensChannel::CenterY)],     t, p.centerY);
        p.zoom        = absoluteAt(keys, r[static_cast<int>(LensChannel::Zoom)],        t, p.zoom);
        p.rotationDeg = absoluteAt(keys, r[static_cast<int>(LensChannel::RotationDeg)], t, p.rotationDeg);
        return p;
    }

    // Pattern note. A source with no entry is new: its fallback base, no hit
    // curve, default zones (an override on it still plays).
    const SourceEntry* e  = findSource(sources, trackId, regionId);
    const OverrideEntry* ov = overrideFor(trackId, note.patternId, note.noteId);
    const bool useHit  = e && e->keyed && (!ov || ov->mode == LensOverrideMode::Nudge);
    const bool useNote = ov && ov->keyed;
    LensParams p = e ? e->lens : lensForSource(trackId, regionId);
    if (!useHit && !useNote) return p;   // Follow/Nudge with no hit curve, Own with no keys

    // Layers on the base (spec "Blend": zoom multiplies; centre and rotation
    // add): Follow = hit curve, Nudge = hit curve then note keys, Own = note
    // keys. An unused layer is its identity (x1, +0), which leaves the
    // double unchanged, so Follow is bit-identical to P7. Computed in double,
    // one rounding. Zones belong to the hit curve: Follow and Nudge play on
    // the source's zones (a Nudge was compiled against them, so one span
    // serves both layers); an Own note plays on the spec defaults, so no
    // hit-curve edit, zones included, ever reaches it.
    const bool own = ov && ov->mode == LensOverrideMode::Own;
    const xleth::keycurve::NoteZones zones = (e && !own) ? e->zones : xleth::keycurve::NoteZones{};
    const xleth::keycurve::NoteSpan span = xleth::keycurve::noteSpan(clock.eventLenTicks, zones);
    const ChannelRuns& h = useHit  ? e->hitCurve : kNoRuns;
    const ChannelRuns& n = useNote ? ov->keys    : kNoRuns;
    auto layer = [&](LensChannel ch, double identity, bool mul) {
        const int c = static_cast<int>(ch);
        const double a = layerAt(keys, h[c], span, t, identity);
        const double b = layerAt(keys, n[c], span, t, identity);
        return mul ? a * b : a + b;
    };
    p.zoom        = static_cast<float>(static_cast<double>(p.zoom)
                  * layer(LensChannel::Zoom, 1.0, true));
    p.centerX     = static_cast<float>(static_cast<double>(p.centerX)
                  + layer(LensChannel::CenterX, 0.0, false));
    p.centerY     = static_cast<float>(static_cast<double>(p.centerY)
                  + layer(LensChannel::CenterY, 0.0, false));
    p.rotationDeg = static_cast<float>(static_cast<double>(p.rotationDeg)
                  + layer(LensChannel::RotationDeg, 0.0, false));
    return p;
}

RoamParams LensRoamSnapshot::roamAt(int trackId, double frameTick) const {
    const TrackEntry* e = findTrack(tracks, trackId);
    if (!e) return RoamParams{};
    RoamParams p = e->roam;
    if (!e->roamKeyed) return p;
    const auto& r = e->roamKeys;
    p.offsetX     = absoluteAt(keys, r[static_cast<int>(RoamChannel::OffsetX)],     frameTick, p.offsetX);
    p.offsetY     = absoluteAt(keys, r[static_cast<int>(RoamChannel::OffsetY)],     frameTick, p.offsetY);
    p.scale       = absoluteAt(keys, r[static_cast<int>(RoamChannel::Scale)],       frameTick, p.scale);
    p.rotationDeg = absoluteAt(keys, r[static_cast<int>(RoamChannel::RotationDeg)], frameTick, p.rotationDeg);
    return p;
}

LensRoamSnapshot::Counts LensRoamSnapshot::counts() const {
    Counts c;
    c.tracks  = static_cast<int>(tracks.size());
    c.clips   = static_cast<int>(clips.size());
    c.sources = static_cast<int>(sources.size());
    c.keys    = static_cast<int>(keys.size());
    for (const auto& t : tracks)  if (!t.roam.isIdentity()) ++c.roamNonIdentity;
    for (const auto& e : clips)   if (!e.lens.isIdentity()) ++c.clipLensNonIdentity;
    for (const auto& e : sources) if (!e.lens.isIdentity()) ++c.sourceLensNonIdentity;
    for (const auto& o : overrides) {
        if (o.mode == LensOverrideMode::Own) ++c.noteOwn;
        else                                 ++c.noteNudge;
    }
    return c;
}

// ─── Key compilation (message thread) ─────────────────────────────────────────
namespace {

bool isMultiplierChannel(LensChannel c) { return c == LensChannel::Zoom; }
bool isMultiplierChannel(RoamChannel c) { return c == RoamChannel::Scale; }

enum class CurveKind { Time, Note };

// Compile one container's stored keys into the pool: per channel, converted to
// keycurve::Key, cleaned, (clamped,) sorted, appended as one run. A zoom or
// scale key <= 0 is dropped (zoom 0 is a black cell, negative a silent
// mirror; the base readers refuse the same values). `scratch` is reused.
template <typename Channel>
bool compileChannelRuns(const std::vector<LensRoamKey<Channel>>& stored,
                        xleth::keycurve::TimeBase origin, CurveKind kind,
                        const xleth::keycurve::NoteZones& zones,
                        std::vector<xleth::keycurve::Key>& pool,
                        std::vector<xleth::keycurve::Key>& scratch,
                        LensRoamSnapshot::KeyRun (&runs)[kLensRoamChannels]) {
    bool any = false;
    for (int c = 0; c < kLensRoamChannels; ++c) {
        scratch.clear();
        for (const auto& k : stored) {
            if (static_cast<int>(k.channel) != c) continue;
            if (isMultiplierChannel(k.channel) && !(k.value > 0.0)) continue;
            scratch.push_back(lensroam::toCurveKey(k, origin));
        }
        if (kind == CurveKind::Note) xleth::keycurve::compileNoteKeys(scratch, zones);
        else                         xleth::keycurve::compileTimeKeys(scratch);
        runs[c].first = static_cast<uint32_t>(pool.size());
        runs[c].count = static_cast<uint32_t>(scratch.size());
        pool.insert(pool.end(), scratch.begin(), scratch.end());
        any = any || !scratch.empty();
    }
    return any;
}

} // namespace

// ─── Dev-only verification hook (P2) ──────────────────────────────────────────
// XLETH_DEV_LENS_ROAM_TRACK=<trackId> forces one track's resolved values in
// EVERY snapshot: Lens zoom 1.5 and rotation 10 deg on all of its content
// (fit and centre left as they are), Roam offset (0.5, -0.3) cells, bounds
// Float. XLETH_DEV_LENS_ROAM_LAYER=grid|above|top picks the Float layer
// (default grid). The model is never touched: nothing is saved, nothing is
// undoable, and the UI shows the real values.
//
// It lives HERE, in the one builder both the live preview and export call, so
// the two are guaranteed to see the same forced values; that is the point of
// the hook (preview/export parity of the P2 compositor). There is no separate
// dev/release compile in this repo (XLETH_DEBUG is defined in every build),
// so the env var is the dev flag; the #ifdef only lets a future build that
// drops XLETH_DEBUG compile the hook away.
namespace {
struct DevLensRoamHook {
    bool      active  = false;
    int       trackId = -1;
    RoamLayer layer   = RoamLayer::GridOrder;
};

DevLensRoamHook devLensRoamHook() {
    DevLensRoamHook h;
#ifdef XLETH_DEBUG
    const char* t = std::getenv("XLETH_DEV_LENS_ROAM_TRACK");
    if (!t || !t[0]) return h;
    char* end = nullptr;
    const long id = std::strtol(t, &end, 10);
    if (end == t) return h;
    h.active  = true;
    h.trackId = static_cast<int>(id);
    if (const char* l = std::getenv("XLETH_DEV_LENS_ROAM_LAYER")) {
        const std::string v = l;
        if (v == "above")    h.layer = RoamLayer::AboveNeighbours;
        else if (v == "top") h.layer = RoamLayer::Top;
    }
#endif
    return h;
}

void applyDevLens(LensParams& p) {
    p.zoom        = 1.5f;
    p.rotationDeg = 10.0f;
}
} // namespace

std::shared_ptr<const LensRoamSnapshot> buildLensRoamSnapshot(const Timeline& timeline) {
    using xleth::keycurve::TimeBase;
    auto snap = std::make_shared<LensRoamSnapshot>();
    const DevLensRoamHook dev = devLensRoamHook();
    std::vector<xleth::keycurve::Key> scratch;   // one channel at a time

    const auto tracks = timeline.getAllTracks();
    snap->tracks.reserve(tracks.size());
    for (const TrackInfo* t : tracks) {
        LensRoamSnapshot::TrackEntry e;
        e.trackId = t->id;
        e.roam    = lensroam::resolveBase(t->roam);
        e.sourceFallback = t->type == TrackInfo::Type::Pattern
            ? LensParams::newContentDefault() : LensParams{};
        const bool devTrack = dev.active && t->id == dev.trackId;
        if (devTrack) {
            e.roam.offsetX = 0.5f;
            e.roam.offsetY = -0.3f;
            e.roam.bounds  = RoamBounds::Float;
            e.roam.layer   = dev.layer;
            applyDevLens(e.sourceFallback);
        }
        // Roam keys: timeline ticks. The dev hook forces static values, so a
        // hooked track's own keys are not compiled (they would override it).
        if (!devTrack)
            e.roamKeyed = compileChannelRuns(t->roam.keys, TimeBase::TimelineTicks,
                                             CurveKind::Time, t->roam.zones,
                                             snap->keys, scratch, e.roamKeys);
        snap->tracks.push_back(e);
        for (const auto& [regionId, lens] : t->trackLens) {
            LensRoamSnapshot::SourceEntry s;
            s.trackId  = t->id;
            s.regionId = regionId;
            s.lens     = lensroam::resolveBase(lens);
            s.zones    = lens.zones;
            if (devTrack) applyDevLens(s.lens);
            // The hit curve: note anchors, clamped and ordered for these zones.
            s.keyed = compileChannelRuns(lens.keys, TimeBase::EventTicks, CurveKind::Note,
                                         lens.zones, snap->keys, scratch, s.hitCurve);
            snap->sources.push_back(s);
        }
    }

    // Per-note overrides (P8), one entry per {track, pattern, note} the
    // timeline actually plays: every pattern placed on a Pattern track. A
    // Nudge is compiled against THAT track's zones for the pattern's source,
    // so it and the hit curve it nudges share one note span at render time;
    // an Own note against the spec defaults (zones are part of the hit curve,
    // which never reaches it). A pattern placed twice on one track compiles once.
    {
        std::vector<std::pair<int, int>> done;   // (trackId, patternId)
        for (const TrackInfo* t : tracks) {
            if (t->type != TrackInfo::Type::Pattern) continue;
            for (const PatternBlock* block : timeline.getPatternBlocksOnTrack(t->id)) {
                const std::pair<int, int> key{ t->id, block->patternId };
                if (std::find(done.begin(), done.end(), key) != done.end()) continue;
                done.push_back(key);
                const Pattern* pattern = timeline.getPattern(block->patternId);
                if (!pattern) continue;
                const auto lensIt = t->trackLens.find(pattern->regionId);
                const xleth::keycurve::NoteZones zones = lensIt != t->trackLens.end()
                    ? lensIt->second.zones : xleth::keycurve::NoteZones{};
                for (const PatternNote& n : pattern->notes) {
                    // An id <= 0 is not an address (old data; no load-time
                    // repair yet): such a note plays Follow.
                    if (!n.lensOverride || n.id <= 0) continue;
                    LensRoamSnapshot::OverrideEntry o;
                    o.trackId   = t->id;
                    o.patternId = pattern->id;
                    o.noteId    = n.id;
                    o.mode      = n.lensOverride->mode;
                    const xleth::keycurve::NoteZones noteZones = o.mode == LensOverrideMode::Own
                        ? xleth::keycurve::NoteZones{} : zones;
                    o.keyed = compileChannelRuns(n.lensOverride->keys, TimeBase::EventTicks,
                                                 CurveKind::Note, noteZones, snap->keys, scratch, o.keys);
                    snap->overrides.push_back(o);
                }
            }
        }
    }

    const auto clips = timeline.getAllClips();
    snap->clips.reserve(clips.size());
    for (const Clip* c : clips) {
        LensRoamSnapshot::ClipEntry e;
        e.clipId = c->id;
        e.lens   = lensroam::resolveBase(c->lens);
        if (dev.active && c->trackId == dev.trackId) {
            applyDevLens(e.lens);            // forced static values: keys not compiled
        } else {
            // Clip lens keys: ticks from the event (clip) start.
            e.keyed = compileChannelRuns(c->lens.keys, TimeBase::EventTicks, CurveKind::Time,
                                         c->lens.zones, snap->keys, scratch, e.lensKeys);
        }
        snap->clips.push_back(e);
    }

    if (dev.active) {
        // Message/setup thread (this builder allocates; it never runs on the
        // render thread). Once per process: it is rebuilt after every edit.
        static bool logged = false;
        if (!logged) {
            logged = true;
            std::fprintf(stderr,
                "[Roam] DEV hook XLETH_DEV_LENS_ROAM_TRACK=%d: lens zoom 1.5 rot 10deg, "
                "roam offset (0.5,-0.3) Float layer=%s (snapshot only, model untouched)\n",
                dev.trackId, lensroam::roamLayerToString(dev.layer));
        }
    }

    std::sort(snap->tracks.begin(), snap->tracks.end(),
        [](const auto& a, const auto& b) { return a.trackId < b.trackId; });
    std::sort(snap->clips.begin(), snap->clips.end(),
        [](const auto& a, const auto& b) { return a.clipId < b.clipId; });
    std::sort(snap->sources.begin(), snap->sources.end(),
        [](const auto& a, const auto& b) {
            return std::tie(a.trackId, a.regionId) < std::tie(b.trackId, b.regionId);
        });
    // A note id is unique inside its pattern, so (track, pattern, note) is a
    // key. Should old data hold a duplicate id, the first note in the pattern
    // wins (stable sort keeps note order), the same note the edit commands
    // address.
    std::stable_sort(snap->overrides.begin(), snap->overrides.end(), overrideLess);
    snap->overrides.erase(std::unique(snap->overrides.begin(), snap->overrides.end(),
        [](const LensRoamSnapshot::OverrideEntry& a, const LensRoamSnapshot::OverrideEntry& b) {
            return !overrideLess(a, b) && !overrideLess(b, a);
        }), snap->overrides.end());
    return snap;
}
