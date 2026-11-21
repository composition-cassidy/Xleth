#include "Clone.h"

#include "LensRoam.h"        // interpToString / bezierToJson / bezierFromJson
#include "Timeline.h"
#include "TimelineTypes.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <numeric>
#include <set>

using xleth::keycurve::Interp;
using xleth::keycurve::Key;
using xleth::keycurve::Position;
using xleth::keycurve::TimeBase;

namespace {

Interp interpFromName(const std::string& s) {
    if (s == "Hold")    return Interp::Hold;
    if (s == "EaseOut") return Interp::EaseOut;
    if (s == "Bezier")  return Interp::Bezier;
    return Interp::Linear;
}

bool sameKey(const Key& a, const Key& b) {
    return a.value == b.value && a.interp == b.interp
        && a.position.base == b.position.base && a.position.v == b.position.v
        && (a.interp != Interp::Bezier || a.bez == b.bez);
}

double clamp01(double v) { return std::clamp(v, 0.0, 1.0); }

} // namespace

bool TrailSettings::operator==(const TrailSettings& o) const {
    if (delayTicks != o.delayTicks || tintRgb != o.tintRgb || opacity != o.opacity) return false;
    if (opacityKeys.size() != o.opacityKeys.size()) return false;
    for (size_t i = 0; i < opacityKeys.size(); ++i)
        if (!sameKey(opacityKeys[i], o.opacityKeys[i])) return false;
    return true;
}

namespace clones {

const char* cloneKindToString(CloneKind k) {
    return k == CloneKind::Trail ? "Trail" : "Voice";
}

bool cloneKindFromString(const std::string& s, CloneKind& out) {
    if (s == "Voice") { out = CloneKind::Voice; return true; }
    if (s == "Trail") { out = CloneKind::Trail; return true; }
    return false;
}

const char* cloneLensModeToString(CloneLensMode m) {
    return m == CloneLensMode::Own ? "Own" : "Linked";
}

bool cloneLensModeFromString(const std::string& s, CloneLensMode& out) {
    if (s == "Linked") { out = CloneLensMode::Linked; return true; }
    if (s == "Own")    { out = CloneLensMode::Own;    return true; }
    return false;
}

std::string tintToString(uint32_t rgb) {
    char buf[8];
    std::snprintf(buf, sizeof(buf), "#%06X", static_cast<unsigned>(rgb & 0xFFFFFFu));
    return buf;
}

bool tintFromString(const std::string& s, uint32_t& out) {
    if (s.size() != 7 || s[0] != '#') return false;
    uint32_t v = 0;
    for (size_t i = 1; i < 7; ++i) {
        const char c = s[i];
        uint32_t d;
        if (c >= '0' && c <= '9')      d = static_cast<uint32_t>(c - '0');
        else if (c >= 'a' && c <= 'f') d = static_cast<uint32_t>(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') d = static_cast<uint32_t>(c - 'A' + 10);
        else return false;
        v = (v << 4) | d;
    }
    out = v;
    return true;
}

nlohmann::json opacityKeysToJson(const std::vector<Key>& keys) {
    nlohmann::json arr = nlohmann::json::array();
    for (const Key& k : keys) {
        nlohmann::json j{
            {"pos",    k.position.v},
            {"value",  k.value},
            {"interp", lensroam::interpToString(k.interp)},
        };
        if (k.interp == Interp::Bezier) j["bez"] = lensroam::bezierToJson(k.bez);
        arr.push_back(std::move(j));
    }
    return arr;
}

std::vector<Key> opacityKeysFromJson(const nlohmann::json& arr) {
    std::vector<Key> out;
    if (!arr.is_array()) return out;
    for (const auto& e : arr) {
        if (!e.is_object()) continue;
        if (!e.contains("pos") || !e.at("pos").is_number()) continue;
        if (!e.contains("value") || !e.at("value").is_number()) continue;
        Key k;
        k.position = Position::timelineTicks(e.at("pos").get<double>());
        k.value    = e.at("value").get<double>();
        if (!std::isfinite(k.position.v) || !std::isfinite(k.value) || k.position.v < 0.0) continue;
        k.value  = clamp01(k.value);
        k.interp = (e.contains("interp") && e.at("interp").is_string())
            ? interpFromName(e.at("interp").get<std::string>()) : Interp::Linear;
        if (k.interp == Interp::Bezier && e.contains("bez"))
            lensroam::bezierFromJson(e.at("bez"), k.bez);
        out.push_back(k);
    }
    std::stable_sort(out.begin(), out.end(),
        [](const Key& a, const Key& b) { return a.position.v < b.position.v; });
    return out;
}

double trailOpacityAt(const TrailSettings& t, double tick) {
    if (t.opacityKeys.empty()) return clamp01(t.opacity);
    return clamp01(xleth::keycurve::valueAt(t.opacityKeys.data(), t.opacityKeys.size(),
                                            tick, t.opacity));
}

void cloneFieldsToJson(nlohmann::json& j, const TrackInfo& t) {
    if (t.cloneOf < 0) return;
    j["cloneOf"]   = t.cloneOf;
    j["cloneKind"] = cloneKindToString(t.cloneKind);
    if (t.cloneKind == CloneKind::Voice) {
        j["lensMode"] = cloneLensModeToString(t.cloneLensMode);
    } else {
        j["delayTicks"] = t.trail.delayTicks;
        j["tint"]       = tintToString(t.trail.tintRgb);
        j["opacity"]    = t.trail.opacity;
        if (!t.trail.opacityKeys.empty())
            j["opacityKeys"] = opacityKeysToJson(t.trail.opacityKeys);
    }
}

void cloneFieldsFromJson(const nlohmann::json& j, TrackInfo& t) {
    // Assigned unconditionally so a reused TrackInfo never keeps stale values.
    t.cloneOf       = -1;
    t.cloneKind     = CloneKind::Voice;
    t.cloneLensMode = CloneLensMode::Linked;
    t.trail         = TrailSettings{};
    if (!j.is_object() || !j.contains("cloneOf") || !j.at("cloneOf").is_number()) return;
    const double of = j.at("cloneOf").get<double>();
    if (!std::isfinite(of) || of < 0.0 || of > 2147483647.0 || of != std::floor(of)) return;
    if (static_cast<int>(of) == t.id) return;   // a clone of itself is not a clone
    CloneKind kind = CloneKind::Voice;
    if (j.contains("cloneKind") && j.at("cloneKind").is_string()
        && !cloneKindFromString(j.at("cloneKind").get<std::string>(), kind))
        return;   // an unknown kind from a newer build: load as an ordinary track
    t.cloneOf   = static_cast<int>(of);
    t.cloneKind = kind;
    if (kind == CloneKind::Voice) {
        CloneLensMode m = CloneLensMode::Linked;
        if (j.contains("lensMode") && j.at("lensMode").is_string())
            cloneLensModeFromString(j.at("lensMode").get<std::string>(), m);
        t.cloneLensMode = m;
        return;
    }
    if (j.contains("delayTicks") && j.at("delayTicks").is_number()) {
        const double d = j.at("delayTicks").get<double>();
        if (std::isfinite(d))
            t.trail.delayTicks = std::clamp(d, kMinTrailDelayTicks, kMaxTrailDelayTicks);
    }
    if (j.contains("tint") && j.at("tint").is_string())
        tintFromString(j.at("tint").get<std::string>(), t.trail.tintRgb);
    if (j.contains("opacity") && j.at("opacity").is_number()) {
        const double o = j.at("opacity").get<double>();
        if (std::isfinite(o)) t.trail.opacity = clamp01(o);
    }
    if (j.contains("opacityKeys"))
        t.trail.opacityKeys = opacityKeysFromJson(j.at("opacityKeys"));
}

// ── Topology ──────────────────────────────────────────────────────────────────

namespace {
std::vector<const TrackInfo*> clonesOf(const Timeline& timeline, int sourceTrackId,
                                       bool voice, bool trail) {
    std::vector<const TrackInfo*> out;
    if (sourceTrackId < 0) return out;
    for (const TrackInfo* t : timeline.getAllTracks()) {   // already (order, id)
        if (t->cloneOf != sourceTrackId || t->id == sourceTrackId) continue;
        if ((t->cloneKind == CloneKind::Voice && voice)
            || (t->cloneKind == CloneKind::Trail && trail))
            out.push_back(t);
    }
    return out;
}
} // namespace

std::vector<const TrackInfo*> voiceClonesOf(const Timeline& timeline, int sourceTrackId) {
    return clonesOf(timeline, sourceTrackId, true, false);
}

std::vector<const TrackInfo*> trailClonesOf(const Timeline& timeline, int sourceTrackId) {
    return clonesOf(timeline, sourceTrackId, false, true);
}

std::vector<const TrackInfo*> allClonesOf(const Timeline& timeline, int sourceTrackId) {
    return clonesOf(timeline, sourceTrackId, true, true);
}

const TrackInfo* sourceOf(const Timeline& timeline, const TrackInfo& clone) {
    if (clone.cloneOf < 0 || clone.cloneOf == clone.id) return nullptr;
    const TrackInfo* s = timeline.getTrack(clone.cloneOf);
    if (!s || s->cloneOf >= 0) return nullptr;   // no clone of a clone
    return s;
}

int voiceNumberOf(const Timeline& timeline, const TrackInfo& clone) {
    if (!clone.isVoiceClone()) return 0;
    const auto v = voiceClonesOf(timeline, clone.cloneOf);
    for (size_t i = 0; i < v.size(); ++i)
        if (v[i]->id == clone.id) return static_cast<int>(i) + 1;
    return 0;
}

// ── Voice assignment ──────────────────────────────────────────────────────────

std::vector<VoiceSlot> assignVoices(const std::vector<VoiceNote>& notes, int voiceCloneCount) {
    const int n = static_cast<int>(notes.size());
    std::vector<VoiceSlot> out(static_cast<size_t>(n));
    if (voiceCloneCount <= 0 || n == 0) return out;   // every note on the source
    const int voices = voiceCloneCount + 1;

    // Busy spans per voice, in placement order. Overlap = start < e && s < end.
    std::vector<std::vector<std::pair<int64_t, int64_t>>> busy(static_cast<size_t>(voices));
    auto isFree = [&](int v, int64_t s, int64_t e) {
        for (const auto& [bs, be] : busy[static_cast<size_t>(v)])
            if (s < be && bs < e) return false;
        return true;
    };
    auto live = [](const VoiceNote& vn) { return !vn.inert && vn.end > vn.start; };

    // 1. Pinned notes first, at their pinned voice.
    std::vector<int> autoIdx;
    autoIdx.reserve(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) {
        const VoiceNote& vn = notes[static_cast<size_t>(i)];
        if (!live(vn)) continue;
        if (vn.pin >= 0 && vn.pin <= voiceCloneCount) {
            out[static_cast<size_t>(i)].voice = vn.pin;
            busy[static_cast<size_t>(vn.pin)].push_back({ vn.start, vn.end });
        } else {
            autoIdx.push_back(i);
        }
    }

    // 2. Auto notes in start order; same tick: highest pitch first.
    std::stable_sort(autoIdx.begin(), autoIdx.end(), [&](int a, int b) {
        const VoiceNote& x = notes[static_cast<size_t>(a)];
        const VoiceNote& y = notes[static_cast<size_t>(b)];
        if (x.start != y.start) return x.start < y.start;
        if (x.pitch != y.pitch) return x.pitch > y.pitch;
        if (x.id != y.id)       return x.id < y.id;
        return a < b;
    });
    for (int i : autoIdx) {
        const VoiceNote& vn = notes[static_cast<size_t>(i)];
        int chosen = -1;
        for (int v = 0; v < voices; ++v) {
            if (isFree(v, vn.start, vn.end)) { chosen = v; break; }
        }
        VoiceSlot& slot = out[static_cast<size_t>(i)];
        if (chosen < 0) {
            slot.voice    = 0;
            slot.overflow = true;
            continue;
        }
        slot.voice = chosen;
        busy[static_cast<size_t>(chosen)].push_back({ vn.start, vn.end });
    }
    return out;
}

std::vector<VoiceSlot> assignVoices(const Pattern& pattern, int voiceCloneCount) {
    std::vector<VoiceNote> notes;
    notes.reserve(pattern.notes.size());
    for (const PatternNote& pn : pattern.notes) {
        VoiceNote vn;
        vn.start = pn.position.ticks;
        vn.end   = pn.position.ticks + pn.duration.ticks;
        vn.pitch = pn.pitch;
        vn.id    = pn.id;
        vn.pin   = pn.voicePin;
        vn.inert = pn.isSlide;
        notes.push_back(vn);
    }
    return assignVoices(notes, voiceCloneCount);
}

// ── Pin rewrites ──────────────────────────────────────────────────────────────

bool rewritePinsForRemovedVoice(std::vector<PatternNote>& notes, int removedVoice) {
    if (removedVoice < 1) return false;
    bool changed = false;
    for (PatternNote& n : notes) {
        if (n.voicePin == removedVoice) { n.voicePin = kVoicePinAuto; changed = true; }
        else if (n.voicePin > removedVoice) { --n.voicePin; changed = true; }
    }
    return changed;
}

bool rewritePinsForReorder(std::vector<PatternNote>& notes, const std::vector<int>& newVoiceOfOld) {
    bool changed = false;
    for (PatternNote& n : notes) {
        if (n.voicePin < 1 || n.voicePin >= static_cast<int>(newVoiceOfOld.size())) continue;
        const int nv = newVoiceOfOld[static_cast<size_t>(n.voicePin)];
        if (nv != n.voicePin) { n.voicePin = nv; changed = true; }
    }
    return changed;
}

namespace {
// clone id -> source id, for every Clone whose source is a live track.
std::map<int, int> liveCloneSources(const Timeline& timeline) {
    std::map<int, int> m;
    for (const TrackInfo* t : timeline.getAllTracks())
        if (const TrackInfo* s = sourceOf(timeline, *t)) m[t->id] = s->id;
    return m;
}

// Every track id in the timeline's current order.
std::vector<int> currentOrder(const Timeline& timeline) {
    std::vector<int> ids;
    for (const TrackInfo* t : timeline.getAllTracks()) ids.push_back(t->id);
    return ids;
}

// Removes the live clones from `ids` and re-inserts each source's clones
// (in their order of appearance in `order`) right after the source.
void regroup(std::vector<int>& ids, const std::map<int, int>& cloneSource,
             const std::vector<int>& order) {
    std::vector<int> kept;
    kept.reserve(ids.size());
    for (int id : ids) if (!cloneSource.count(id)) kept.push_back(id);
    std::vector<int> out;
    out.reserve(ids.size());
    for (int id : kept) {
        out.push_back(id);
        for (int c : order) {
            auto it = cloneSource.find(c);
            if (it != cloneSource.end() && it->second == id) out.push_back(c);
        }
    }
    ids.swap(out);
}
} // namespace

TrackLayout withClonesAfterSources(const TrackLayout& in, const Timeline& timeline) {
    const std::map<int, int> cloneSource = liveCloneSources(timeline);
    if (cloneSource.empty()) return in;
    // The clones keep their CURRENT order (the track order the timeline has
    // now), whatever order the incoming layout lists them in: the order of
    // Voice clones is their voice numbering, and renumbering must rewrite
    // pins, which only ReorderClonesCommand does (it bypasses this path).
    const std::vector<int> order = currentOrder(timeline);
    // Each live clone is dropped from wherever it sits and re-emitted right
    // after its source, in whichever container holds the source.
    auto clonesAfter = [&](int sourceId, auto&& emit) {
        for (int c : order) {
            auto it = cloneSource.find(c);
            if (it != cloneSource.end() && it->second == sourceId) emit(c);
        }
    };
    TrackLayout out = in;
    {
        std::vector<TrackLayoutItem> items;
        items.reserve(in.rootOrder.size());
        for (const auto& item : in.rootOrder) {
            if (item.kind == TrackLayoutItem::Kind::Folder) { items.push_back(item); continue; }
            if (cloneSource.count(item.id)) continue;
            items.push_back(item);
            clonesAfter(item.id, [&](int c) {
                items.push_back({ TrackLayoutItem::Kind::Track, c });
            });
        }
        out.rootOrder = std::move(items);
    }
    for (auto& f : out.folders) {
        std::vector<int> ids;
        ids.reserve(f.trackIds.size());
        for (int id : f.trackIds) {
            if (cloneSource.count(id)) continue;
            ids.push_back(id);
            clonesAfter(id, [&](int c) { ids.push_back(c); });
        }
        f.trackIds = std::move(ids);
    }
    return out;
}

std::vector<int> withClonesAfterSources(const std::vector<int>& flat, const Timeline& timeline) {
    const std::map<int, int> cloneSource = liveCloneSources(timeline);
    if (cloneSource.empty()) return flat;
    std::vector<int> ids = flat;
    regroup(ids, cloneSource, currentOrder(timeline));
    return ids;
}

std::vector<int> patternsPlayedBy(const Timeline& timeline, int trackId) {
    std::vector<int> ids;
    for (const PatternBlock* b : timeline.getPatternBlocksOnTrack(trackId))
        if (b) ids.push_back(b->patternId);
    std::sort(ids.begin(), ids.end());
    ids.erase(std::unique(ids.begin(), ids.end()), ids.end());
    return ids;
}

} // namespace clones
