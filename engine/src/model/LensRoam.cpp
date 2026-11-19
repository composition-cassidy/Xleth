#include "LensRoam.h"

#include "Timeline.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <initializer_list>
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

// One crop edge never hides the whole cell on its own (left + right, top +
// bottom are held below 1 together by the evaluator).
constexpr float kMaxCropEdge = 0.99f;

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
        case RoamChannel::ScaleY:      return "scaleY";
        case RoamChannel::CropLeft:    return "cropLeft";
        case RoamChannel::CropRight:   return "cropRight";
        case RoamChannel::CropTop:     return "cropTop";
        case RoamChannel::CropBottom:  return "cropBottom";
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
    if (s == "scaleY")      { out = RoamChannel::ScaleY;      return true; }
    if (s == "cropLeft")    { out = RoamChannel::CropLeft;    return true; }
    if (s == "cropRight")   { out = RoamChannel::CropRight;   return true; }
    if (s == "cropTop")     { out = RoamChannel::CropTop;     return true; }
    if (s == "cropBottom")  { out = RoamChannel::CropBottom;  return true; }
    return false;
}

// Mask channels: names come from the motion schema (mask.feather /
// mask.expansion / mask.opacity, engineIndex = MaskChannel). Declared before
// the key templates below so their unqualified calls find them.
const char* channelToString(MaskChannel c) {
    const motionschema::Property* p =
        motionschema::propertyByEngineIndex("mask", "mask", static_cast<int>(c));
    return p ? p->channel : "feather";
}

bool channelFromString(const std::string& s, MaskChannel& out) {
    const motionschema::Property* p = motionschema::propertyByChannel("mask", "mask", s.c_str());
    if (!p || p->type != motionschema::PropType::Scalar
        || p->engineIndex < 0 || p->engineIndex >= kMaskChannels) return false;
    out = static_cast<MaskChannel>(p->engineIndex);
    return true;
}

// The schema entry of a Mask scalar channel (always present: MotionSchema.h
// static_asserts it).
const motionschema::Property& maskChannelProperty(MaskChannel c) {
    return *motionschema::propertyByEngineIndex("mask", "mask", static_cast<int>(c));
}

using xleth::keycurve::Interp;
using xleth::keycurve::NoteZones;
using xleth::keycurve::ShortNoteRule;

// Unknown or missing -> Linear: the segment shape P1's default bezier handles
// described, so a key saved before P7 evaluates as it was always meant to.
Interp interpFromString(const std::string& s) {
    if (s == "Hold")    return Interp::Hold;
    if (s == "EaseOut") return Interp::EaseOut;
    if (s == "Bezier")  return Interp::Bezier;
    return Interp::Linear;
}

template <typename Channel>
json keyToJson(const LensRoamKey<Channel>& k) {
    json j{
        {"channel", channelToString(k.channel)},
        {"anchor",  anchorToString(k.anchor)},
        {"pos",     k.pos},
        {"value",   k.value},
        {"interp",  interpToString(k.interp)},
    };
    if (k.interp == Interp::Bezier) j["bez"] = bezierToJson(k.bez);
    return j;
}

// Strict: a key whose channel/anchor is unknown or whose time/value is not a
// finite number is dropped rather than guessed at. `interp` is tolerant
// (missing/unknown = Linear); P1's p1x..p2y handles, if present, are ignored.
// A Bezier key's "bez" is tolerant too: missing or malformed = the default
// handles (CSS ease-in-out).
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
    if (k.interp == Interp::Bezier && j.contains("bez"))
        bezierFromJson(j.at("bez"), k.bez);
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
    json j{
        {"offsetX",     p.offsetX},
        {"offsetY",     p.offsetY},
        {"scale",       p.scale},
        {"rotationDeg", p.rotationDeg},
        {"bounds",      roamBoundsToString(p.bounds)},
        {"layer",       roamLayerToString(p.layer)},
    };
    // Scale Y / crop are written only when they are in use, so a project that
    // uses neither re-saves byte-identically to before they existed.
    if (!p.scaleLinked) {
        j["scaleLinked"] = false;
        j["scaleY"]      = p.scaleY;
    }
    if (p.hasCrop()) {
        j["cropLeft"]   = p.cropLeft;
        j["cropRight"]  = p.cropRight;
        j["cropTop"]    = p.cropTop;
        j["cropBottom"] = p.cropBottom;
    }
    return j;
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
    // Migration: a project saved before Scale X/Y split has neither field, so
    // it loads linked (one uniform scale) and renders exactly as it did.
    p.scaleLinked = !(j.contains("scaleLinked") && j.at("scaleLinked").is_boolean()
                      && !j.at("scaleLinked").get<bool>());
    p.scaleY      = positiveOr(j, "scaleY", p.scale);
    p.cropLeft    = std::clamp(finiteOr(j, "cropLeft",   0.0f), 0.0f, kMaxCropEdge);
    p.cropRight   = std::clamp(finiteOr(j, "cropRight",  0.0f), 0.0f, kMaxCropEdge);
    p.cropTop     = std::clamp(finiteOr(j, "cropTop",    0.0f), 0.0f, kMaxCropEdge);
    p.cropBottom  = std::clamp(finiteOr(j, "cropBottom", 0.0f), 0.0f, kMaxCropEdge);
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

json fxKeysToJson(const std::vector<FxKey>& keys) {
    json arr = json::array();
    for (const FxKey& k : keys) {
        json j{
            {"uid",    k.uid},
            {"param",  k.param},
            {"pos",    k.pos},
            {"value",  k.value},
            {"interp", interpToString(k.interp)},
        };
        if (k.interp == Interp::Bezier) j["bez"] = bezierToJson(k.bez);
        arr.push_back(j);
    }
    return arr;
}

std::vector<FxKey> fxKeysFromJson(const json& j) {
    std::vector<FxKey> out;
    if (!j.is_array()) return out;
    for (const auto& e : j) {
        if (!e.is_object()) continue;
        if (!e.contains("uid") || !e.at("uid").is_number_integer()) continue;
        if (!e.contains("param") || !e.at("param").is_number_integer()) continue;
        if (!e.contains("pos") || !e.at("pos").is_number()) continue;
        if (!e.contains("value") || !e.at("value").is_number()) continue;
        FxKey k;
        k.uid   = e.at("uid").get<int>();
        k.param = e.at("param").get<int>();
        k.pos   = e.at("pos").get<double>();
        k.value = e.at("value").get<double>();
        if (k.uid <= 0 || k.param < 0 || k.param >= 16) continue;
        if (!std::isfinite(k.pos) || !std::isfinite(k.value)) continue;
        k.interp = interpFromString(stringOr(e, "interp"));
        if (k.interp == Interp::Bezier && e.contains("bez")) bezierFromJson(e.at("bez"), k.bez);
        out.push_back(k);
    }
    return out;
}

json roamTrackToJson(const RoamTrack& t) {
    json j = json::object();
    j["base"] = roamParamsToJson(t.base);
    j["keys"] = keysToJson(t.keys);
    // Motion view masks: only when there are some, so a project with none
    // re-saves byte-identically (design R16).
    if (!t.masks.empty()) j["masks"] = masksToJson(t.masks);
    return j;
}

RoamTrack roamTrackFromJson(const json& j) {
    RoamTrack t;
    if (!j.is_object()) return t;
    if (j.contains("base")) t.base = roamParamsFromJson(j.at("base"));
    t.keys = keysFromJson<RoamChannel>(j, "keys");
    if (j.contains("masks")) t.masks = masksFromJson(j.at("masks"));
    return t;
}

// ─── Masks: JSON (design 2.2) ────────────────────────────────────────────────

static_assert(motionschema::motionProperty("mask.feather")->engineIndex == static_cast<int>(MaskChannel::Feather)
           && motionschema::motionProperty("mask.expansion")->engineIndex == static_cast<int>(MaskChannel::Expansion)
           && motionschema::motionProperty("mask.opacity")->engineIndex == static_cast<int>(MaskChannel::Opacity),
              "MaskChannel must match the schema's engineIndex");
static_assert(motionschema::optionIndex("mask.shape", "Rectangle") == static_cast<int>(MaskKind::Rectangle)
           && motionschema::optionIndex("mask.shape", "Ellipse")   == static_cast<int>(MaskKind::Ellipse)
           && motionschema::optionIndex("mask.shape", "Path")      == static_cast<int>(MaskKind::Path),
              "MaskKind must match the schema's mask.shape options");
static_assert(motionschema::optionIndex("mask.mode", "Add")       == static_cast<int>(MaskMode::Add)
           && motionschema::optionIndex("mask.mode", "Subtract")  == static_cast<int>(MaskMode::Subtract)
           && motionschema::optionIndex("mask.mode", "Intersect") == static_cast<int>(MaskMode::Intersect),
              "MaskMode must match the schema's mask.mode options");

namespace {

constexpr std::size_t kMaxMaskNameChars = 64;

// UTF-8 code points (continuation bytes are not counted).
std::size_t utf8Length(const std::string& s) {
    std::size_t n = 0;
    for (unsigned char c : s) if ((c & 0xC0) != 0x80) ++n;
    return n;
}

// The first `maxChars` code points of `s`.
std::string utf8Truncate(const std::string& s, std::size_t maxChars) {
    std::size_t chars = 0, i = 0;
    for (; i < s.size(); ++i) {
        if ((static_cast<unsigned char>(s[i]) & 0xC0) != 0x80) {
            if (chars == maxChars) break;
            ++chars;
        }
    }
    return s.substr(0, i);
}

std::string defaultMaskName(int id) { return "Mask " + std::to_string(id); }

json vertexToJson(const MaskVertex& v) {
    return json::array({ v.x, v.y, v.inX, v.inY, v.outX, v.outY });
}

json verticesToJson(const std::vector<MaskVertex>& vs) {
    json arr = json::array();
    for (const auto& v : vs) arr.push_back(vertexToJson(v));
    return arr;
}

// The largest |coordinate| a mask vertex or tangent may hold (cell units; the
// cell is 1 wide). Mirrored by ui/src/motion/maskModel.js MAX_MASK_COORD.
constexpr double kMaxMaskCoord = 10000.0;

// [x, y, inX, inY, outX, outY], six finite numbers with |v| <= kMaxMaskCoord.
bool vertexFromJson(const json& j, MaskVertex& v) {
    if (!j.is_array() || j.size() != 6) return false;
    double d[6];
    for (std::size_t i = 0; i < 6; ++i) {
        if (!j[i].is_number()) return false;
        d[i] = j[i].get<double>();
        if (!std::isfinite(d[i]) || std::fabs(d[i]) > kMaxMaskCoord) return false;
    }
    v = MaskVertex{ d[0], d[1], d[2], d[3], d[4], d[5] };
    return true;
}

bool verticesFromJson(const json& j, std::vector<MaskVertex>& out) {
    if (!j.is_array()) return false;
    out.clear();
    out.reserve(j.size());
    for (const auto& e : j) {
        MaskVertex v;
        if (!vertexFromJson(e, v)) return false;
        out.push_back(v);
    }
    return true;
}

bool vertexCountOk(std::size_t n) {
    return n >= static_cast<std::size_t>(motionschema::kMinVerticesPerMask)
        && n <= static_cast<std::size_t>(motionschema::kMaxVerticesPerMask);
}

double maskScalarIdentity(MaskChannel c) { return maskChannelProperty(c).identity; }

// Shape keys in time order, one per pos: stable sort, then a later key at the
// same pos replaces the earlier one (the keycurve rule: the last in stored
// order owns that time).
void sortDedupeShapeKeys(std::vector<MaskShapeKey>& keys) {
    std::stable_sort(keys.begin(), keys.end(),
        [](const MaskShapeKey& a, const MaskShapeKey& b) { return a.pos < b.pos; });
    std::vector<MaskShapeKey> out;
    out.reserve(keys.size());
    for (auto& k : keys) {
        if (!out.empty() && out.back().pos == k.pos) out.back() = std::move(k);
        else out.push_back(std::move(k));
    }
    keys = std::move(out);
}

// Strict interp / bez (the RPC contract): interp optional (Linear), must be
// Hold | Linear | EaseOut | Bezier; bez optional / null, else four finite
// numbers; kept only on a Bezier key.
bool interpFromJsonStrict(const json& e, const std::string& at, Interp& interp,
                          xleth::keycurve::BezierHandles& bez, std::string& err) {
    interp = Interp::Linear;
    bez    = xleth::keycurve::BezierHandles{};
    if (e.contains("interp")) {
        const std::string in = e["interp"].is_string() ? e["interp"].get<std::string>() : "";
        if      (in == "Hold")    interp = Interp::Hold;
        else if (in == "Linear")  interp = Interp::Linear;
        else if (in == "EaseOut") interp = Interp::EaseOut;
        else if (in == "Bezier")  interp = Interp::Bezier;
        else { err = at + ": interp must be Hold | Linear | EaseOut | Bezier"; return false; }
    }
    if (e.contains("bez") && !e["bez"].is_null()) {
        xleth::keycurve::BezierHandles b;
        if (!bezierFromJson(e["bez"], b)) {
            err = at + ": bez must be [x1, y1, x2, y2], four finite numbers";
            return false;
        }
        if (interp == Interp::Bezier) bez = b;
    }
    return true;
}

bool onlyFields(const json& o, std::initializer_list<const char*> allowed, const std::string& at,
                std::string& err) {
    for (auto it = o.begin(); it != o.end(); ++it) {
        bool ok = false;
        for (const char* a : allowed) if (it.key() == a) { ok = true; break; }
        if (!ok) {
            std::string list;
            for (const char* a : allowed) { if (!list.empty()) list += ", "; list += a; }
            err = at + ": unknown field '" + it.key() + "' (" + list + ")";
            return false;
        }
    }
    return true;
}

std::string fmtNum(double v) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%g", v);
    return buf;
}

} // namespace

const char* maskKindToString(MaskKind k) {
    const char* s = motionschema::optionName("mask.shape", static_cast<int>(k));
    return s ? s : "Path";
}

const char* maskModeToString(MaskMode m) {
    const char* s = motionschema::optionName("mask.mode", static_cast<int>(m));
    return s ? s : "Add";
}

const char* maskChannelToString(MaskChannel c) { return channelToString(c); }

json maskToJson(const RoamMask& m) {
    json shape = json::object();
    shape["closed"]   = true;
    shape["vertices"] = verticesToJson(m.base.shape.vertices);
    json base = json::object();
    base["shape"]     = std::move(shape);
    base["feather"]   = m.base.feather;
    base["expansion"] = m.base.expansion;
    base["opacity"]   = m.base.opacity;
    base["mode"]      = maskModeToString(m.base.mode);
    base["invert"]    = m.base.invert;
    // Shape keys are saved sorted by pos (design 2.2). Every reader and the
    // strict parser already keep them sorted; this only matters for a model
    // edited directly. Stable, so equal positions keep their stored order.
    std::vector<const MaskShapeKey*> ordered;
    ordered.reserve(m.shapeKeys.size());
    for (const auto& k : m.shapeKeys) ordered.push_back(&k);
    std::stable_sort(ordered.begin(), ordered.end(),
        [](const MaskShapeKey* a, const MaskShapeKey* b) { return a->pos < b->pos; });
    json shapeKeys = json::array();
    for (const MaskShapeKey* kp : ordered) {
        const MaskShapeKey& k = *kp;
        json sk = json::object();
        sk["pos"]      = k.pos;
        sk["interp"]   = interpToString(k.interp);
        if (k.interp == Interp::Bezier) sk["bez"] = bezierToJson(k.bez);
        sk["vertices"] = verticesToJson(k.vertices);
        shapeKeys.push_back(std::move(sk));
    }
    json j = json::object();
    j["id"]        = m.id;
    j["name"]      = m.name;
    j["kind"]      = maskKindToString(m.kind);
    j["base"]      = std::move(base);
    j["keys"]      = keysToJson(m.keys);
    j["shapeKeys"] = std::move(shapeKeys);
    return j;
}

json masksToJson(const std::vector<RoamMask>& masks) {
    json arr = json::array();
    for (const auto& m : masks) arr.push_back(maskToJson(m));
    return arr;
}

std::vector<RoamMask> masksFromJson(const json& j) {
    std::vector<RoamMask> out;
    if (!j.is_array()) return out;
    std::vector<bool> idOk(j.size(), false);
    std::vector<int> usedIds;
    for (std::size_t i = 0; i < j.size(); ++i) {
        const json& e = j[i];
        if (!e.is_object() || !e.contains("id") || !e.at("id").is_number()) continue;
        const double d = e.at("id").get<double>();
        if (!std::isfinite(d) || d < 1.0 || d > 2147483647.0 || d != std::floor(d)) continue;
        const int id = static_cast<int>(d);
        if (std::find(usedIds.begin(), usedIds.end(), id) != usedIds.end()) continue;  // first wins
        usedIds.push_back(id);
        idOk[i] = true;
    }

    int vertexTotal = 0;
    for (std::size_t i = 0; i < j.size(); ++i) {
        if (static_cast<int>(out.size()) >= motionschema::kMaxMasksPerTrack) break;
        const json& e = j[i];
        if (!e.is_object() || !e.contains("base") || !e.at("base").is_object()) continue;
        const json& b = e.at("base");
        if (!b.contains("shape") || !b.at("shape").is_object()) continue;
        const json& shape = b.at("shape");
        RoamMask m;
        if (!shape.contains("vertices") || !verticesFromJson(shape.at("vertices"), m.base.shape.vertices))
            continue;
        const std::size_t vc = m.base.shape.vertices.size();
        if (!vertexCountOk(vc)) continue;
        if (vertexTotal + static_cast<int>(vc) > motionschema::kMaxMaskVerticesPerTrack) continue;
        m.base.shape.closed = true;   // v1 has closed paths only

        auto scalar = [&b](MaskChannel c) {
            const motionschema::Property& p = maskChannelProperty(c);
            const char* key = p.channel;
            if (!b.contains(key) || !b.at(key).is_number()) return p.identity;
            const double v = b.at(key).get<double>();
            return std::isfinite(v) ? p.clamp(v) : p.identity;
        };
        m.base.feather   = scalar(MaskChannel::Feather);
        m.base.expansion = scalar(MaskChannel::Expansion);
        m.base.opacity   = scalar(MaskChannel::Opacity);
        {
            const int mode = motionschema::optionIndex("mask.mode", stringOr(b, "mode").c_str());
            m.base.mode = mode >= 0 ? static_cast<MaskMode>(mode) : MaskMode::Add;
        }
        m.base.invert = b.contains("invert") && b.at("invert").is_boolean() && b.at("invert").get<bool>();

        m.id = idOk[i] ? static_cast<int>(e.at("id").get<double>()) : 0;
        {
            const int kind = motionschema::optionIndex("mask.shape", stringOr(e, "kind").c_str());
            m.kind = kind >= 0 ? static_cast<MaskKind>(kind) : MaskKind::Path;
            // A Rectangle / Ellipse without exactly 4 points loads as a Path
            // (maskModel.fromWire does the same; the strict parser rejects it).
            if (m.kind != MaskKind::Path && vc != 4) m.kind = MaskKind::Path;
        }
        if (e.contains("name") && e.at("name").is_string())
            m.name = utf8Truncate(e.at("name").get<std::string>(), kMaxMaskNameChars);

        // Scalar keys: Origin anchors only (timeline ticks), pos >= 0, values
        // clamped into the schema clamp.
        for (MaskKey k : keysFromJson<MaskChannel>(e, "keys")) {
            if (k.anchor != KeyAnchor::Origin || !(k.pos >= 0.0)) continue;
            k.value = maskChannelProperty(k.channel).clamp(k.value);
            m.keys.push_back(k);
        }

        if (e.contains("shapeKeys") && e.at("shapeKeys").is_array()) {
            for (const json& sk : e.at("shapeKeys")) {
                if (!sk.is_object() || !sk.contains("pos") || !sk.at("pos").is_number()) continue;
                MaskShapeKey k;
                k.pos = sk.at("pos").get<double>();
                if (!std::isfinite(k.pos) || k.pos < 0.0) continue;
                if (!sk.contains("vertices") || !verticesFromJson(sk.at("vertices"), k.vertices)) continue;
                if (k.vertices.size() != vc) continue;
                k.interp = interpFromString(stringOr(sk, "interp"));
                if (k.interp == Interp::Bezier && sk.contains("bez")) bezierFromJson(sk.at("bez"), k.bez);
                m.shapeKeys.push_back(std::move(k));
            }
            sortDedupeShapeKeys(m.shapeKeys);
        }

        vertexTotal += static_cast<int>(vc);
        out.push_back(std::move(m));
    }

    // Fresh ids for masks that had none (or a duplicate): the smallest positive
    // id no kept mask uses (never overflows, unlike max + 1 after INT_MAX).
    std::vector<int> taken;
    for (const auto& m : out) if (m.id != 0) taken.push_back(m.id);
    for (auto& m : out) {
        if (m.id == 0) {
            int id = 1;
            while (std::find(taken.begin(), taken.end(), id) != taken.end()) ++id;
            m.id = id;
            taken.push_back(id);
        }
        if (m.name.empty()) m.name = defaultMaskName(m.id);
    }
    return out;
}

bool masksFromJsonStrict(const json& j, std::vector<RoamMask>& outMasks, std::string& err) {
    using motionschema::kMaxMasksPerTrack;
    using motionschema::kMaxMaskVerticesPerTrack;
    if (!j.is_array()) { err = "masks must be an array"; return false; }
    if (static_cast<int>(j.size()) > kMaxMasksPerTrack) {
        err = "too many masks: " + std::to_string(j.size()) + " (at most "
            + std::to_string(kMaxMasksPerTrack) + " per track)";
        return false;
    }
    std::vector<RoamMask> out;
    int vertexTotal = 0;
    auto readVertices = [&err](const json& arr, const std::string& at, std::vector<MaskVertex>& vs) {
        if (!arr.is_array()) { err = at + " must be an array of [x, y, inX, inY, outX, outY]"; return false; }
        vs.clear();
        for (std::size_t v = 0; v < arr.size(); ++v) {
            MaskVertex mv;
            if (!vertexFromJson(arr[v], mv)) {
                err = at + "[" + std::to_string(v) + "] must be [x, y, inX, inY, outX, outY], six finite numbers"
                    " with |v| <= " + fmtNum(kMaxMaskCoord);
                return false;
            }
            vs.push_back(mv);
        }
        return true;
    };

    for (std::size_t i = 0; i < j.size(); ++i) {
        const json& e = j[i];
        const std::string at = "masks[" + std::to_string(i) + "]";
        if (!e.is_object()) { err = at + " must be an object"; return false; }
        if (!onlyFields(e, { "id", "name", "kind", "base", "keys", "shapeKeys" }, at, err)) return false;

        RoamMask m;
        // id: a positive integer, unique within the track.
        if (!e.contains("id") || !e["id"].is_number()) { err = at + ": id must be a positive integer"; return false; }
        {
            const double d = e["id"].get<double>();
            if (!std::isfinite(d) || d < 1.0 || d > 2147483647.0 || d != std::floor(d)) {
                err = at + ": id must be a positive integer"; return false;
            }
            m.id = static_cast<int>(d);
            for (const auto& o : out)
                if (o.id == m.id) { err = at + ": duplicate id " + std::to_string(m.id); return false; }
        }
        if (e.contains("name")) {
            if (!e["name"].is_string()) { err = at + ": name must be a string"; return false; }
            m.name = e["name"].get<std::string>();
            if (utf8Length(m.name) > kMaxMaskNameChars) {
                err = at + ": name must be at most " + std::to_string(kMaxMaskNameChars) + " characters";
                return false;
            }
            if (m.name.empty()) m.name = defaultMaskName(m.id);   // same as the tolerant load
        } else {
            m.name = defaultMaskName(m.id);
        }
        if (e.contains("kind")) {
            const int kind = e["kind"].is_string()
                ? motionschema::optionIndex("mask.shape", e["kind"].get<std::string>().c_str()) : -1;
            if (kind < 0) { err = at + ": kind must be Rectangle | Ellipse | Path"; return false; }
            m.kind = static_cast<MaskKind>(kind);
        }

        // base (required): shape (required) plus optional scalars / mode / invert.
        if (!e.contains("base") || !e["base"].is_object()) { err = at + ": base must be an object"; return false; }
        const json& b = e["base"];
        const std::string atB = at + ".base";
        if (!onlyFields(b, { "shape", "feather", "expansion", "opacity", "mode", "invert" }, atB, err)) return false;
        if (!b.contains("shape") || !b["shape"].is_object()) { err = atB + ": shape must be an object"; return false; }
        {
            const json& s = b["shape"];
            const std::string atS = atB + ".shape";
            if (!onlyFields(s, { "closed", "vertices" }, atS, err)) return false;
            if (s.contains("closed")) {
                if (!s["closed"].is_boolean()) { err = atS + ": closed must be a boolean"; return false; }
                if (!s["closed"].get<bool>()) { err = atS + ": open paths are not supported (closed must be true)"; return false; }
            }
            if (!s.contains("vertices")) { err = atS + ": vertices is required"; return false; }
            if (!readVertices(s["vertices"], atS + ".vertices", m.base.shape.vertices)) return false;
        }
        const std::size_t vc = m.base.shape.vertices.size();
        if (!vertexCountOk(vc)) {
            err = atB + ".shape: " + std::to_string(vc) + " vertices (a mask has "
                + std::to_string(motionschema::kMinVerticesPerMask) + " to "
                + std::to_string(motionschema::kMaxVerticesPerMask) + ")";
            return false;
        }
        // A Rectangle / Ellipse is its 4-point preset (R14); more or fewer points
        // is a Path (maskModel.validateMask says the same).
        if ((m.kind == MaskKind::Rectangle || m.kind == MaskKind::Ellipse) && vc != 4) {
            err = at + (m.kind == MaskKind::Ellipse ? ": an " : ": a ")
                + std::string(maskKindToString(m.kind)) + " has exactly 4 points (has "
                + std::to_string(vc) + "); edit it as a Path";
            return false;
        }
        vertexTotal += static_cast<int>(vc);
        if (vertexTotal > kMaxMaskVerticesPerTrack) {
            err = at + ": too many mask vertices on the track: " + std::to_string(vertexTotal)
                + " (at most " + std::to_string(kMaxMaskVerticesPerTrack) + " in total)";
            return false;
        }
        for (MaskChannel c : { MaskChannel::Feather, MaskChannel::Expansion, MaskChannel::Opacity }) {
            const motionschema::Property& p = maskChannelProperty(c);
            if (!b.contains(p.channel)) continue;
            const json& v = b[p.channel];
            if (!v.is_number() || !std::isfinite(v.get<double>())) {
                err = atB + ": " + p.channel + " must be a finite number"; return false;
            }
            const double d = v.get<double>();
            if (!p.inClamp(d)) {
                err = atB + ": " + p.channel + " must be in [" + fmtNum(p.clampLo) + ", " + fmtNum(p.clampHi) + "]";
                return false;
            }
            (c == MaskChannel::Feather ? m.base.feather
             : c == MaskChannel::Expansion ? m.base.expansion : m.base.opacity) = d;
        }
        if (b.contains("mode")) {
            const int mode = b["mode"].is_string()
                ? motionschema::optionIndex("mask.mode", b["mode"].get<std::string>().c_str()) : -1;
            if (mode < 0) { err = atB + ": mode must be Add | Subtract | Intersect"; return false; }
            m.base.mode = static_cast<MaskMode>(mode);
        }
        if (b.contains("invert")) {
            if (!b["invert"].is_boolean()) { err = atB + ": invert must be a boolean"; return false; }
            m.base.invert = b["invert"].get<bool>();
        }

        // Scalar keys: Mask channels, Origin anchor, timeline ticks.
        if (e.contains("keys")) {
            if (!e["keys"].is_array()) { err = at + ": keys must be an array"; return false; }
            const json& arr = e["keys"];
            for (std::size_t k = 0; k < arr.size(); ++k) {
                const json& kj = arr[k];
                const std::string atK = at + ".keys[" + std::to_string(k) + "]";
                if (!kj.is_object()) { err = atK + " must be an object"; return false; }
                if (!onlyFields(kj, { "channel", "anchor", "pos", "value", "interp", "bez" }, atK, err)) return false;
                MaskKey key;
                if (!kj.contains("channel") || !kj["channel"].is_string()
                    || !channelFromString(kj["channel"].get<std::string>(), key.channel)) {
                    err = atK + ": channel must be feather | expansion | opacity"; return false;
                }
                if (!kj.contains("anchor") || !kj["anchor"].is_string() || kj["anchor"].get<std::string>() != "Origin") {
                    err = atK + ": anchor must be 'Origin' (a Mask key is timeline ticks)"; return false;
                }
                key.anchor = KeyAnchor::Origin;
                if (!kj.contains("pos") || !kj["pos"].is_number() || !std::isfinite(kj["pos"].get<double>())
                    || kj["pos"].get<double>() < 0.0) {
                    err = atK + ": pos must be a finite number >= 0"; return false;
                }
                if (!kj.contains("value") || !kj["value"].is_number() || !std::isfinite(kj["value"].get<double>())) {
                    err = atK + ": value must be a finite number"; return false;
                }
                key.pos   = kj["pos"].get<double>();
                key.value = kj["value"].get<double>();
                const motionschema::Property& p = maskChannelProperty(key.channel);
                if (!p.inClamp(key.value)) {
                    err = atK + ": a " + p.channel + " value must be in [" + fmtNum(p.clampLo) + ", "
                        + fmtNum(p.clampHi) + "]";
                    return false;
                }
                if (!interpFromJsonStrict(kj, atK, key.interp, key.bez, err)) return false;
                m.keys.push_back(key);
            }
        }

        // Shape keys: every vertex, the base's vertex count, one per pos.
        if (e.contains("shapeKeys")) {
            if (!e["shapeKeys"].is_array()) { err = at + ": shapeKeys must be an array"; return false; }
            const json& arr = e["shapeKeys"];
            for (std::size_t k = 0; k < arr.size(); ++k) {
                const json& kj = arr[k];
                const std::string atK = at + ".shapeKeys[" + std::to_string(k) + "]";
                if (!kj.is_object()) { err = atK + " must be an object"; return false; }
                if (!onlyFields(kj, { "pos", "interp", "bez", "vertices" }, atK, err)) return false;
                MaskShapeKey sk;
                if (!kj.contains("pos") || !kj["pos"].is_number() || !std::isfinite(kj["pos"].get<double>())
                    || kj["pos"].get<double>() < 0.0) {
                    err = atK + ": pos must be a finite number >= 0"; return false;
                }
                sk.pos = kj["pos"].get<double>();
                for (const auto& o : m.shapeKeys)
                    if (o.pos == sk.pos) { err = atK + ": a shape key already sits at pos " + fmtNum(sk.pos); return false; }
                if (!kj.contains("vertices")) { err = atK + ": vertices is required"; return false; }
                if (!readVertices(kj["vertices"], atK + ".vertices", sk.vertices)) return false;
                if (sk.vertices.size() != vc) {
                    err = atK + ": " + std::to_string(sk.vertices.size()) + " vertices, the base has "
                        + std::to_string(vc) + " (every shape key has the base's vertex count)";
                    return false;
                }
                if (!interpFromJsonStrict(kj, atK, sk.interp, sk.bez, err)) return false;
                m.shapeKeys.push_back(std::move(sk));
            }
            std::stable_sort(m.shapeKeys.begin(), m.shapeKeys.end(),
                [](const MaskShapeKey& a, const MaskShapeKey& b) { return a.pos < b.pos; });
        }
        out.push_back(std::move(m));
    }
    outMasks = std::move(out);
    return true;
}

MaskShape rectangleMaskShape(double halfW, double halfH) {
    MaskShape s;
    s.vertices = {
        { -halfW, -halfH, 0, 0, 0, 0 },
        {  halfW, -halfH, 0, 0, 0, 0 },
        {  halfW,  halfH, 0, 0, 0, 0 },
        { -halfW,  halfH, 0, 0, 0, 0 },
    };
    return s;
}

MaskShape ellipseMaskShape(double rx, double ry) {
    const double kx = kEllipseKappa * rx, ky = kEllipseKappa * ry;
    MaskShape s;
    // Clockwise on screen (y down): top -> right -> bottom -> left. The out
    // tangent points toward the next vertex, the in tangent back.
    s.vertices = {
        {  0.0, -ry, -kx, 0.0,  kx, 0.0 },   // top
        {  rx,  0.0, 0.0, -ky, 0.0,  ky },   // right
        {  0.0,  ry,  kx, 0.0, -kx, 0.0 },   // bottom
        { -rx,  0.0, 0.0,  ky, 0.0, -ky },   // left
    };
    return s;
}

int maskVertexTotal(const std::vector<RoamMask>& masks) {
    int n = 0;
    for (const auto& m : masks) n += static_cast<int>(m.base.shape.vertices.size());
    return n;
}

json sweepTrackToJson(const SweepTrack& t) {
    json j = json::object();
    j["keys"] = keysToJson(t.keys);
    return j;
}

SweepTrack sweepTrackFromJson(const json& j) {
    SweepTrack t;
    if (!j.is_object()) return t;
    t.keys = keysFromJson<LensChannel>(j, "keys");
    return t;
}

const char* lensOverrideModeToString(LensOverrideMode m) {
    return m == LensOverrideMode::Own ? "Own" : "Nudge";
}

const char* interpToString(Interp i) {
    switch (i) {
        case Interp::Hold:    return "Hold";
        case Interp::EaseOut: return "EaseOut";
        case Interp::Bezier:  return "Bezier";
        default:              return "Linear";
    }
}

json bezierToJson(const xleth::keycurve::BezierHandles& b) {
    return json::array({ b.x1, b.y1, b.x2, b.y2 });
}

bool bezierFromJson(const json& j, xleth::keycurve::BezierHandles& out) {
    if (!j.is_array() || j.size() != 4) return false;
    double v[4];
    for (std::size_t i = 0; i < 4; ++i) {
        if (!j[i].is_number()) return false;
        v[i] = j[i].get<double>();
        if (!std::isfinite(v[i])) return false;
    }
    out = xleth::keycurve::sanitizeBezier({ v[0], v[1], v[2], v[3] });
    return true;
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

// A zoom / scale the renderer can divide by. Linear, Hold and EaseOut between
// positive keys stay positive, but a Bezier segment may overshoot past 0 (its
// y handles are unclamped), so every multiplier leaving the evaluator is held
// above this floor. A no-op for every key the UI can write (>= 0.05).
constexpr double kMinMultiplier = 1e-3;
inline double floorMultiplier(double v) { return v > kMinMultiplier ? v : kMinMultiplier; }

// Keep the crop edges of an opposite pair from meeting: the visible strip is
// never thinner than kMinCropVisible of the cell.
constexpr float kMinCropVisible = 0.01f;
constexpr float kCropEdgeCap    = 0.99f;   // = lensroam's kMaxCropEdge
inline void clampCropPair(float& a, float& b) {
    a = std::clamp(a, 0.0f, kCropEdgeCap);
    b = std::clamp(b, 0.0f, kCropEdgeCap);
    const float over = (a + b) - (1.0f - kMinCropVisible);
    if (over > 0.0f) {
        const float t = a + b;                       // > 0 here
        a -= over * (a / t);
        b -= over * (b / t);
    }
}

// Every Roam channel at one tick: keyed channels follow their keys, unkeyed hold
// the base. The one evaluator behind LensRoamSnapshot::roamAt, roamAtTick and the
// crop mask. A linked cell never reads Scale Y (nor its keys): scaleY mirrors scale.
void applyRoamKeys(RoamParams& p, const std::vector<xleth::keycurve::Key>& pool,
                   const LensRoamSnapshot::ChannelRuns& r, double tick) {
    auto ch = [&](RoamChannel c) -> const LensRoamSnapshot::KeyRun& { return r[static_cast<int>(c)]; };
    p.offsetX     = absoluteAt(pool, ch(RoamChannel::OffsetX), tick, p.offsetX);
    p.offsetY     = absoluteAt(pool, ch(RoamChannel::OffsetY), tick, p.offsetY);
    p.scale       = static_cast<float>(floorMultiplier(
                        absoluteAt(pool, ch(RoamChannel::Scale), tick, p.scale)));
    p.rotationDeg = absoluteAt(pool, ch(RoamChannel::RotationDeg), tick, p.rotationDeg);
    if (!p.scaleLinked)
        p.scaleY  = static_cast<float>(floorMultiplier(
                        absoluteAt(pool, ch(RoamChannel::ScaleY), tick, p.scaleY)));
    p.cropLeft    = absoluteAt(pool, ch(RoamChannel::CropLeft),   tick, p.cropLeft);
    p.cropRight   = absoluteAt(pool, ch(RoamChannel::CropRight),  tick, p.cropRight);
    p.cropTop     = absoluteAt(pool, ch(RoamChannel::CropTop),    tick, p.cropTop);
    p.cropBottom  = absoluteAt(pool, ch(RoamChannel::CropBottom), tick, p.cropBottom);
    clampCropPair(p.cropLeft, p.cropRight);
    clampCropPair(p.cropTop,  p.cropBottom);
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
    return applySweep(trackId, lensBeforeSweep(trackId, clipId, regionId, clock, note),
                      clock.frameTick);
}

LensParams LensRoamSnapshot::applySweep(int trackId, const LensParams& p, double frameTick) const {
    const TrackEntry* e = findTrack(tracks, trackId);
    if (!e || !e->swept) return p;
    // A layer on the framing (spec "Blend"): an unkeyed channel is the layer
    // identity, which leaves the double unchanged.
    const auto& r = e->sweepKeys;
    auto layer = [&](LensChannel ch, double identity) {
        const KeyRun& run = r[static_cast<int>(ch)];
        if (run.count == 0) return identity;
        return xleth::keycurve::valueAt(keys.data() + run.first, run.count, frameTick, identity);
    };
    LensParams out = p;
    out.zoom        = static_cast<float>(floorMultiplier(
                          static_cast<double>(p.zoom) * layer(LensChannel::Zoom, 1.0)));
    out.centerX     = static_cast<float>(static_cast<double>(p.centerX) + layer(LensChannel::CenterX, 0.0));
    out.centerY     = static_cast<float>(static_cast<double>(p.centerY) + layer(LensChannel::CenterY, 0.0));
    out.rotationDeg = static_cast<float>(static_cast<double>(p.rotationDeg) + layer(LensChannel::RotationDeg, 0.0));
    return out;
}

LensParams LensRoamSnapshot::lensBeforeSweep(int trackId, int clipId, int regionId,
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
        p.zoom        = static_cast<float>(floorMultiplier(
                            absoluteAt(keys, r[static_cast<int>(LensChannel::Zoom)], t, p.zoom)));
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
    p.zoom        = static_cast<float>(floorMultiplier(static_cast<double>(p.zoom)
                  * layer(LensChannel::Zoom, 1.0, true)));
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
    applyRoamKeys(p, keys, e->roamKeys, frameTick);
    return p;
}

// ─── Video effect param keys (render thread) ─────────────────────────────────

namespace fxparam {

namespace {
struct ParamRange { int type; int param; double lo; double hi; };
// VisualEffect::Type: 0 Desaturation, 1 Tint, 2 BrightnessContrast, 3 TVSimulator,
// 4 ZoomPanRotation, 5 ChromaKey, 6 Outline, 7 DropShadow, 8 VisualEcho.
constexpr ParamRange kRanges[] = {
    {0, 0, 0.0, 1.0},
    {1, 3, 0.0, 1.0}, {1, 4, 0.0, 1.0}, {1, 5, 0.0, 1.0},
    {2, 0, -1.0, 1.0}, {2, 1, -1.0, 1.0},
    {3, 0, 0.0, 1.0}, {3, 1, 0.0, 5.0}, {3, 2, 0.0, 1.0}, {3, 3, 0.0, 0.01},
    {3, 4, 0.0, 1.0}, {3, 5, 0.0, 10.0}, {3, 6, 0.0, 0.02},
    {4, 1, 0.25, 4.0}, {4, 4, -1.0, 1.0}, {4, 5, -1.0, 1.0}, {4, 7, -360.0, 360.0},
    {5, 3, 0.0, 0.6}, {5, 4, 0.0, 0.8}, {5, 5, 0.0, 1.0}, {5, 6, 0.0, 8.0}, {5, 7, 0.0, 8.0},
    {6, 3, 0.0, 24.0}, {6, 4, 0.0, 1.0}, {6, 5, 0.0, 1.0}, {6, 6, 0.5, 0.99},
    {7, 3, 0.0, 64.0}, {7, 4, 0.0, 360.0}, {7, 5, 0.0, 1.0}, {7, 6, 0.0, 1.0},
    {7, 7, 0.0, 1.0}, {7, 9, 0.5, 0.99},
    {8, 1, 0.0, 1.0}, {8, 3, 0.0, 1.0}, {8, 5, 0.0, 1.0},
};
} // namespace

bool range(int type, int param, double& lo, double& hi) {
    for (const ParamRange& r : kRanges) {
        if (r.type == type && r.param == param) { lo = r.lo; hi = r.hi; return true; }
    }
    return false;
}

} // namespace fxparam

void LensRoamSnapshot::applyFxKeys(int trackId, double frameTick, std::vector<VisualEffect>& chain) const {
    const TrackEntry* e = findTrack(tracks, trackId);
    if (!e || e->fxCount == 0 || chain.empty()) return;
    bool chromaTouched = false;
    for (uint32_t i = 0; i < e->fxCount; ++i) {
        const FxRun& r = fxRuns[e->fxFirst + i];
        for (VisualEffect& fx : chain) {
            if (fx.uid != r.uid) continue;
            if (static_cast<int>(fx.type) != r.type) break;       // the chain changed since this snapshot
            const double v = xleth::keycurve::valueAt(keys.data() + r.run.first, r.run.count,
                                                      frameTick, static_cast<double>(fx.params[r.param]));
            fx.params[r.param] = static_cast<float>(std::clamp(v, static_cast<double>(r.lo), static_cast<double>(r.hi)));
            if (r.type == static_cast<int>(VisualEffect::Type::ChromaKey)) chromaTouched = true;
            break;
        }
    }
    if (chromaTouched) {
        // Chroma Key: Softness (params[4]) is the edge threshold and must stay above
        // Tolerance (params[3]); two keyed curves can cross, so hold a small gap.
        for (VisualEffect& fx : chain) {
            if (fx.type == VisualEffect::Type::ChromaKey && fx.params[4] < fx.params[3] + 0.001f)
                fx.params[4] = fx.params[3] + 0.001f;
        }
    }
}

// ─── Motion view: Masks and Parent (render thread) ───────────────────────────

namespace {

// The schema clamps of the Mask scalars (constant-initialized pointers into the
// constexpr schema table: no guard, no allocation).
constexpr const motionschema::Property* kMaskFeatherProp   = motionschema::motionProperty("mask.feather");
constexpr const motionschema::Property* kMaskExpansionProp = motionschema::motionProperty("mask.expansion");
constexpr const motionschema::Property* kMaskOpacityProp   = motionschema::motionProperty("mask.opacity");

inline float lerpF(float a, float b, double f) {
    return static_cast<float>(static_cast<double>(a)
                              + (static_cast<double>(b) - static_cast<double>(a)) * f);
}

} // namespace

bool LensRoamSnapshot::masksAt(int trackId, double frameTick, MaskFrame& out) const {
    out.count = 0;
    out.cropSlot = -1;
    const TrackEntry* e = findTrack(tracks, trackId);
    if (!e || (e->maskCount == 0 && !e->cropActive)) return false;

    uint32_t nextVertex = 0;
    for (uint32_t i = 0; i < e->maskCount && out.count < kMaxMasksPerTrack; ++i) {
        const MaskEntry& m = masks[e->maskFirst + i];
        const uint32_t vc = m.vertexCount;
        if (nextVertex + vc > static_cast<uint32_t>(kMaxMaskVerticesPerTrack)) break;

        MaskFrameEntry& f = out.masks[out.count];
        f.mode        = m.mode;
        f.invert      = m.invert;
        f.vertexCount = m.vertexCount;
        f.firstVertex = static_cast<uint16_t>(nextVertex);
        f.feather   = m.feather;
        f.expansion = m.expansion;
        f.opacity   = m.opacity;
        if (m.scalarKeyed) {
            const ChannelRuns& r = m.scalarKeys;
            f.feather   = static_cast<float>(kMaskFeatherProp->clamp(
                absoluteAt(keys, r[static_cast<int>(MaskChannel::Feather)], frameTick, m.feather)));
            f.expansion = static_cast<float>(kMaskExpansionProp->clamp(
                absoluteAt(keys, r[static_cast<int>(MaskChannel::Expansion)], frameTick, m.expansion)));
            f.opacity   = static_cast<float>(kMaskOpacityProp->clamp(
                absoluteAt(keys, r[static_cast<int>(MaskChannel::Opacity)], frameTick, m.opacity)));
        }

        MaskVertexF* dst = out.verts.data() + nextVertex;
        if (m.shapeKeyCount == 0) {
            const MaskVertexF* src = maskVertices.data() + m.baseVertex;
            for (uint32_t v = 0; v < vc; ++v) dst[v] = src[v];
        } else {
            // The keycurve rule on whole paths: before the first key its path,
            // at / after the last key its path, else segment [a, b) shaped by
            // a's interp (the blend factor every coordinate lerps by).
            const ShapeKeyEntry* k = shapeKeys.data() + m.firstShapeKey;
            const uint32_t n = m.shapeKeyCount;
            const ShapeKeyEntry* hold = nullptr;
            if (!(frameTick >= k[0].pos)) {
                hold = &k[0];                                  // before the first key (or NaN)
            } else {
                uint32_t lo = 1, hi = n;                       // upper_bound: first pos > t
                while (lo < hi) {
                    const uint32_t mid = lo + (hi - lo) / 2;
                    if (k[mid].pos <= frameTick) lo = mid + 1;
                    else                         hi = mid;
                }
                if (lo >= n) hold = &k[n - 1];
                else {
                    const ShapeKeyEntry& a = k[lo - 1];
                    const ShapeKeyEntry& b = k[lo];
                    const double u = (frameTick - a.pos) / (b.pos - a.pos);
                    xleth::keycurve::Key ka, kb;
                    ka.value = 0.0; ka.interp = a.interp; ka.bez = a.bez;
                    kb.value = 1.0;
                    const double fct = xleth::keycurve::interpolate(ka, kb, u);
                    const MaskVertexF* va = maskVertices.data() + a.firstVertex;
                    const MaskVertexF* vb = maskVertices.data() + b.firstVertex;
                    for (uint32_t v = 0; v < vc; ++v) {
                        dst[v].x    = lerpF(va[v].x,    vb[v].x,    fct);
                        dst[v].y    = lerpF(va[v].y,    vb[v].y,    fct);
                        dst[v].inX  = lerpF(va[v].inX,  vb[v].inX,  fct);
                        dst[v].inY  = lerpF(va[v].inY,  vb[v].inY,  fct);
                        dst[v].outX = lerpF(va[v].outX, vb[v].outX, fct);
                        dst[v].outY = lerpF(va[v].outY, vb[v].outY, fct);
                    }
                }
            }
            if (hold) {
                const MaskVertexF* src = maskVertices.data() + hold->firstVertex;
                for (uint32_t v = 0; v < vc; ++v) dst[v] = src[v];
            }
        }
        nextVertex += vc;
        ++out.count;
    }

    // Roam border crop: ONE more mask, last, an Intersect rectangle. Cell
    // space (R11): centre origin, y down, so the edges are the drawn cell's own
    // edges and travel with it. It sits behind the user masks' room, so a track
    // with eight masks still crops.
    if (e->cropActive) {
        RoamParams p = e->roam;
        if (e->roamKeyed) applyRoamKeys(p, keys, e->roamKeys, frameTick);
        if (p.hasCrop() && out.count < kMaskFrameMasks
            && nextVertex + kCropMaskVertices <= static_cast<uint32_t>(kMaskFrameVertices)) {
            const float x0 = -0.5f + p.cropLeft,  x1 = 0.5f - p.cropRight;
            const float y0 = -0.5f + p.cropTop,   y1 = 0.5f - p.cropBottom;
            MaskVertexF* dst = out.verts.data() + nextVertex;
            dst[0] = MaskVertexF{ x0, y0, 0.0f, 0.0f, 0.0f, 0.0f };
            dst[1] = MaskVertexF{ x1, y0, 0.0f, 0.0f, 0.0f, 0.0f };
            dst[2] = MaskVertexF{ x1, y1, 0.0f, 0.0f, 0.0f, 0.0f };
            dst[3] = MaskVertexF{ x0, y1, 0.0f, 0.0f, 0.0f, 0.0f };
            MaskFrameEntry& f = out.masks[out.count];
            f.mode        = static_cast<uint8_t>(MaskMode::Intersect);
            f.invert      = 0;
            f.vertexCount = static_cast<uint8_t>(kCropMaskVertices);
            f.firstVertex = static_cast<uint16_t>(nextVertex);
            f.feather     = 0.0f;
            f.expansion   = 0.0f;
            f.opacity     = 1.0f;
            out.cropSlot  = static_cast<int8_t>(out.count);
            ++out.count;
        }
    }
    return out.count > 0;
}

int LensRoamSnapshot::parentOf(int trackId) const {
    const TrackEntry* e = findTrack(tracks, trackId);
    return e ? e->parentTrackId : -1;
}

void LensRoamSnapshot::trailsOf(int sourceTrackId, std::size_t& first, std::size_t& count) const {
    const auto lo = std::lower_bound(trails.begin(), trails.end(), sourceTrackId,
        [](const TrailEntry& e, int id) { return e.sourceTrackId < id; });
    const auto hi = std::upper_bound(lo, trails.end(), sourceTrackId,
        [](int id, const TrailEntry& e) { return id < e.sourceTrackId; });
    first = static_cast<std::size_t>(lo - trails.begin());
    count = static_cast<std::size_t>(hi - lo);
}

double LensRoamSnapshot::trailOpacityAt(const TrailEntry& t, double frameTick) const {
    double v = t.opacity;
    if (t.keyed && t.opacityKeys.count > 0)
        v = xleth::keycurve::valueAt(keys.data() + t.opacityKeys.first, t.opacityKeys.count,
                                     frameTick, t.opacity);
    return std::clamp(v, 0.0, 1.0);
}

int LensRoamSnapshot::parentChain(int trackId, int (&out)[motionschema::kMaxParentDepth]) const {
    int n = 0;
    int cur = trackId;
    while (n < motionschema::kMaxParentDepth) {
        const TrackEntry* e = findTrack(tracks, cur);
        if (!e || e->parentTrackId < 0) break;
        const int p = e->parentTrackId;
        bool seen = (p == trackId);
        for (int i = 0; i < n && !seen; ++i) seen = (out[i] == p);
        if (seen) break;                       // a cycle in damaged data: the chain ends here
        out[n++] = p;
        cur = p;
    }
    return n;
}

LensRoamSnapshot::Counts LensRoamSnapshot::counts() const {
    Counts c;
    c.tracks  = static_cast<int>(tracks.size());
    c.clips   = static_cast<int>(clips.size());
    c.sources = static_cast<int>(sources.size());
    c.keys    = static_cast<int>(keys.size());
    c.masks   = static_cast<int>(masks.size());
    for (const auto& t : tracks)  if (!t.roam.isIdentity()) ++c.roamNonIdentity;
    for (const auto& t : tracks)  if (t.swept) ++c.sweepTracks;
    for (const auto& t : tracks)  if (t.maskCount > 0) ++c.maskTracks;
    for (const auto& t : tracks)  if (t.parentTrackId >= 0) ++c.parentedTracks;
    c.trails  = static_cast<int>(trails.size());
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
bool isMultiplierChannel(RoamChannel c) { return c == RoamChannel::Scale || c == RoamChannel::ScaleY; }
bool isMultiplierChannel(MaskChannel)   { return false; }   // feather / expansion / opacity

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

bool finiteVertex(const MaskVertex& v) {
    return std::isfinite(v.x) && std::isfinite(v.y) && std::isfinite(v.inX) && std::isfinite(v.inY)
        && std::isfinite(v.outX) && std::isfinite(v.outY);
}

MaskVertexF toVertexF(const MaskVertex& v) {
    return MaskVertexF{ static_cast<float>(v.x),   static_cast<float>(v.y),
                        static_cast<float>(v.inX), static_cast<float>(v.inY),
                        static_cast<float>(v.outX), static_cast<float>(v.outY) };
}

// Compile one track's masks into the snapshot (design 3.3). The caps are
// enforced again here (a model edited outside the readers could exceed them):
// at most 8 masks and 64 vertices per track, 3..32 vertices per mask, finite
// vertices only; a mask that does not fit is skipped. Scalars are clamped into
// the schema clamps; shape keys with the wrong vertex count or a non-finite
// value are dropped, the rest sorted by pos with one key per pos (the later
// one wins). `withKeys` false (the dev hook's track) compiles the bases only.
void compileTrackMasks(const std::vector<RoamMask>& stored, bool withKeys,
                       LensRoamSnapshot& snap, LensRoamSnapshot::TrackEntry& e,
                       std::vector<xleth::keycurve::Key>& scratch) {
    using motionschema::kMaxVerticesPerMask;
    using motionschema::kMinVerticesPerMask;
    e.maskFirst = static_cast<uint32_t>(snap.masks.size());
    e.maskCount = 0;
    int vertexTotal = 0;
    std::vector<const MaskShapeKey*> order;
    for (const RoamMask& m : stored) {
        if (e.maskCount >= kMaxMasksPerTrack) break;
        const int vc = static_cast<int>(m.base.shape.vertices.size());
        if (vc < kMinVerticesPerMask || vc > kMaxVerticesPerMask) continue;
        if (vertexTotal + vc > kMaxMaskVerticesPerTrack) continue;
        if (!std::all_of(m.base.shape.vertices.begin(), m.base.shape.vertices.end(), finiteVertex)) continue;

        LensRoamSnapshot::MaskEntry me;
        me.mode        = static_cast<uint8_t>(m.base.mode);
        me.invert      = m.base.invert ? 1 : 0;
        me.vertexCount = static_cast<uint8_t>(vc);
        auto clampOr = [](const motionschema::Property* p, double v) {
            return static_cast<float>(std::isfinite(v) ? p->clamp(v) : p->identity);
        };
        me.feather   = clampOr(kMaskFeatherProp,   m.base.feather);
        me.expansion = clampOr(kMaskExpansionProp, m.base.expansion);
        me.opacity   = clampOr(kMaskOpacityProp,   m.base.opacity);
        me.baseVertex = static_cast<uint32_t>(snap.maskVertices.size());
        for (const auto& v : m.base.shape.vertices) snap.maskVertices.push_back(toVertexF(v));

        if (withKeys) {
            me.scalarKeyed = compileChannelRuns(m.keys, xleth::keycurve::TimeBase::TimelineTicks,
                                                CurveKind::Time, xleth::keycurve::NoteZones{},
                                                snap.keys, scratch, me.scalarKeys);
            order.clear();
            for (const auto& k : m.shapeKeys) {
                if (static_cast<int>(k.vertices.size()) != vc || !std::isfinite(k.pos)) continue;
                if (!std::all_of(k.vertices.begin(), k.vertices.end(), finiteVertex)) continue;
                order.push_back(&k);
            }
            std::stable_sort(order.begin(), order.end(),
                [](const MaskShapeKey* a, const MaskShapeKey* b) { return a->pos < b->pos; });
            me.firstShapeKey = static_cast<uint32_t>(snap.shapeKeys.size());
            for (const MaskShapeKey* k : order) {
                LensRoamSnapshot::ShapeKeyEntry se;
                se.pos         = k->pos;
                se.interp      = k->interp;
                se.bez         = xleth::keycurve::sanitizeBezier(k->bez);
                se.firstVertex = static_cast<uint32_t>(snap.maskVertices.size());
                for (const auto& v : k->vertices) snap.maskVertices.push_back(toVertexF(v));
                // One key per pos: a later key at the same pos replaces the earlier.
                if (snap.shapeKeys.size() > me.firstShapeKey && snap.shapeKeys.back().pos == se.pos)
                    snap.shapeKeys.back() = se;
                else
                    snap.shapeKeys.push_back(se);
            }
            me.shapeKeyCount = static_cast<uint32_t>(snap.shapeKeys.size()) - me.firstShapeKey;
            if (me.shapeKeyCount == 0) me.firstShapeKey = 0;
        }
        snap.masks.push_back(me);
        vertexTotal += vc;
        ++e.maskCount;
    }
    if (e.maskCount == 0) e.maskFirst = 0;
}

// Compile one track's video effect param keys (Motion view): grouped by
// (uid, param), only for an effect that is in the chain NOW and a param that can
// be animated, timeline ticks, sorted and cleaned by the shared curve compiler.
void compileTrackFxKeys(const TrackInfo& t, LensRoamSnapshot& snap, LensRoamSnapshot::TrackEntry& e,
                        std::vector<xleth::keycurve::Key>& scratch) {
    e.fxFirst = static_cast<uint32_t>(snap.fxRuns.size());
    e.fxCount = 0;
    if (t.fxKeys.empty()) { e.fxFirst = 0; return; }
    std::vector<const FxKey*> order;
    order.reserve(t.fxKeys.size());
    for (const FxKey& k : t.fxKeys) order.push_back(&k);
    std::stable_sort(order.begin(), order.end(), [](const FxKey* a, const FxKey* b) {
        return a->uid != b->uid ? a->uid < b->uid : a->param < b->param;
    });
    for (std::size_t i = 0; i < order.size();) {
        std::size_t j = i;
        while (j < order.size() && order[j]->uid == order[i]->uid && order[j]->param == order[i]->param) ++j;
        const int uid = order[i]->uid, param = order[i]->param;
        const VisualEffect* fx = nullptr;
        for (const VisualEffect& c : t.visualEffectChain) if (c.uid == uid) { fx = &c; break; }
        double lo = 0.0, hi = 1.0;
        if (fx && param >= 0 && param < 16 && fxparam::range(static_cast<int>(fx->type), param, lo, hi)) {
            scratch.clear();
            for (std::size_t m = i; m < j; ++m) {
                const FxKey& k = *order[m];
                if (!std::isfinite(k.pos) || !std::isfinite(k.value)) continue;
                xleth::keycurve::Key c;
                c.value  = k.value;
                c.interp = k.interp;
                if (k.interp == xleth::keycurve::Interp::Bezier) c.bez = k.bez;
                c.position = { xleth::keycurve::TimeBase::TimelineTicks, k.pos };
                scratch.push_back(c);
            }
            xleth::keycurve::compileTimeKeys(scratch);
            if (!scratch.empty()) {
                LensRoamSnapshot::FxRun r;
                r.uid = uid; r.param = param; r.type = static_cast<int>(fx->type);
                r.lo = static_cast<float>(lo); r.hi = static_cast<float>(hi);
                r.run.first = static_cast<uint32_t>(snap.keys.size());
                r.run.count = static_cast<uint32_t>(scratch.size());
                snap.keys.insert(snap.keys.end(), scratch.begin(), scratch.end());
                snap.fxRuns.push_back(r);
                ++e.fxCount;
            }
        }
        i = j;
    }
    if (e.fxCount == 0) e.fxFirst = 0;
}

} // namespace

// ─── Roam straight from the model (message thread) ───────────────────────────

namespace lensroam {

RoamParams roamAtTick(const RoamTrack& t, double tick) {
    RoamParams p = t.base;
    if (t.keys.empty()) return p;
    std::vector<xleth::keycurve::Key> pool, scratch;
    LensRoamSnapshot::ChannelRuns runs{};
    if (!compileChannelRuns(t.keys, xleth::keycurve::TimeBase::TimelineTicks, CurveKind::Time,
                            xleth::keycurve::NoteZones{}, pool, scratch, runs))
        return p;
    // Exactly LensRoamSnapshot::roamAt's arithmetic.
    applyRoamKeys(p, pool, runs, tick);
    return p;
}

bool roamChannelKeyed(const RoamTrack& t, RoamChannel c) {
    for (const auto& k : t.keys) if (k.channel == c) return true;
    return false;
}

} // namespace lensroam

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
        clampCropPair(e.roam.cropLeft, e.roam.cropRight);
        clampCropPair(e.roam.cropTop,  e.roam.cropBottom);
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
                                             CurveKind::Time, xleth::keycurve::NoteZones{},
                                             snap->keys, scratch, e.roamKeys);
        e.cropActive = e.roam.hasCrop();
        if (e.roamKeyed) {
            for (RoamChannel c : { RoamChannel::CropLeft, RoamChannel::CropRight,
                                   RoamChannel::CropTop, RoamChannel::CropBottom })
                if (e.roamKeys[static_cast<int>(c)].count > 0) e.cropActive = true;
        }
        // Sweep keys (P11): timeline ticks, a layer. The dev hook forces static
        // values on its track, so that track's Sweep is not compiled either.
        if (!devTrack) {
            e.swept = compileChannelRuns(t->sweep.keys, TimeBase::TimelineTicks,
                                         CurveKind::Time, xleth::keycurve::NoteZones{},
                                         snap->keys, scratch, e.sweepKeys);
        }
        // Motion view: the stored parent (resolved once every track is in,
        // below) and the masks (the dev hook's track: bases only, like its
        // Roam and Sweep keys).
        e.parentTrackId = t->parentTrackId;
        compileTrackMasks(t->roam.masks, !devTrack, *snap, e, scratch);
        compileTrackFxKeys(*t, *snap, e, scratch);
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
    //
    // Clones: a Voice clone whose Lens is Own plays the source's notes on ITS
    // Track Lens (VideoEvent::lensTrackId = the clone), so the overrides of
    // those notes are compiled for it too, against its own zones. A Linked
    // clone plays the source's Track Lens and needs nothing extra (the event
    // keeps lensTrackId = the source).
    {
        std::vector<std::pair<int, int>> done;   // (trackId, patternId)
        for (const TrackInfo* t : tracks) {
            if (t->type != TrackInfo::Type::Pattern || t->isClone()) continue;
            std::vector<const TrackInfo*> owners{ t };
            for (const TrackInfo* c : clones::voiceClonesOf(timeline, t->id))
                if (c->cloneLensMode == CloneLensMode::Own) owners.push_back(c);
            for (const PatternBlock* block : timeline.getPatternBlocksOnTrack(t->id)) {
                const Pattern* pattern = timeline.getPattern(block->patternId);
                if (!pattern) continue;
                for (const TrackInfo* owner : owners) {
                    const std::pair<int, int> key{ owner->id, block->patternId };
                    if (std::find(done.begin(), done.end(), key) != done.end()) continue;
                    done.push_back(key);
                    const auto lensIt = owner->trackLens.find(pattern->regionId);
                    const xleth::keycurve::NoteZones zones = lensIt != owner->trackLens.end()
                        ? lensIt->second.zones : xleth::keycurve::NoteZones{};
                    for (const PatternNote& n : pattern->notes) {
                        // An id <= 0 is not an address (old data; no load-time
                        // repair yet): such a note plays Follow.
                        if (!n.lensOverride || n.id <= 0) continue;
                        LensRoamSnapshot::OverrideEntry o;
                        o.trackId   = owner->id;
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
    }

    // Trail clones (model/Clone.h): each one whose source is a live Pattern
    // track. Opacity keys: timeline ticks, absolute, one run in the pool.
    for (const TrackInfo* t : tracks) {
        if (!t->isTrailClone()) continue;
        const TrackInfo* src = clones::sourceOf(timeline, *t);
        if (!src || src->type != TrackInfo::Type::Pattern) continue;
        LensRoamSnapshot::TrailEntry e;
        e.trackId       = t->id;
        e.sourceTrackId = src->id;
        e.delayTicks    = std::clamp(t->trail.delayTicks, clones::kMinTrailDelayTicks,
                                     clones::kMaxTrailDelayTicks);
        e.tintRgb       = t->trail.tintRgb & 0xFFFFFFu;
        e.opacity       = std::clamp(t->trail.opacity, 0.0, 1.0);
        if (!t->trail.opacityKeys.empty()) {
            scratch.assign(t->trail.opacityKeys.begin(), t->trail.opacityKeys.end());
            for (auto& k : scratch) k.position.base = TimeBase::TimelineTicks;
            xleth::keycurve::compileTimeKeys(scratch);
            if (!scratch.empty()) {
                e.opacityKeys.first = static_cast<uint32_t>(snap->keys.size());
                e.opacityKeys.count = static_cast<uint32_t>(scratch.size());
                snap->keys.insert(snap->keys.end(), scratch.begin(), scratch.end());
                e.keyed = true;
            }
        }
        snap->trails.push_back(e);
    }
    std::sort(snap->trails.begin(), snap->trails.end(),
        [](const LensRoamSnapshot::TrailEntry& a, const LensRoamSnapshot::TrailEntry& b) {
            if (a.sourceTrackId != b.sourceTrackId) return a.sourceTrackId < b.sourceTrackId;
            if (a.delayTicks != b.delayTicks) return a.delayTicks > b.delayTicks;   // farthest first
            return a.trackId < b.trackId;
        });

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
    // Parent resolution (design 2.1): a dangling id (the track is gone) or a
    // self-reference is "no parent". Cycles are left to parentChain's bounded
    // walk, which ends a chain before any id repeats.
    for (auto& e : snap->tracks) {
        if (e.parentTrackId < 0) { e.parentTrackId = -1; continue; }
        if (e.parentTrackId == e.trackId || !findTrack(snap->tracks, e.parentTrackId))
            e.parentTrackId = -1;
    }
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
