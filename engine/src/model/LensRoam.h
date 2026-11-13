#pragma once

// ─── Lens + Roam ──────────────────────────────────────────────────────────────
// docs/XLETH_LENS_ROAM_SPEC.md (locked). Names and parameters are final.
//
//   Lens  frames the video INSIDE its grid cell  (fit, center, zoom, rotation, flip)
//   Roam  moves the CELL ITSELF                   (offset, scale, rotation, bounds, layer)
//
// Phase P1 (this file): data, persistence, and an immutable per-frame
// snapshot the compositor can read. P2 renders from it: GridCompositor applies
// the resolved values through render/LensRoamMath.h, the one evaluator the
// live preview and export share. Nothing edits them yet (P3/P4), and keys are
// stored but never evaluated (P7+): every resolve below returns `base`.
//
// Storage (spec "Storage"):
//   Clip Track event          Clip::lens            LensTrack {base, keys}
//   Pattern Track source      TrackInfo::trackLens  regionId -> LensTrack {base, hitCurve}
//                             (the {trackId, regionId} key: the map lives on the track)
//   Track                     TrackInfo::roam       RoamTrack {base, keys}
//   Per-note overrides        later phase (P5)
//
// Identity (LensParams{} / RoamParams{}) reproduces today's rendering
// exactly: fit = Stretch is what GridComposite.hlsl does now (the source is
// stretched across the cell). NEW clips and sources default to fit = Cover
// (LensParams::newContentDefault); old projects load as Stretch (Ruling 1).
//
// Threading: the model types are edited on the message thread under the
// UndoManager. The render thread never reads them. It reads a
// LensRoamSnapshot — built on the message thread, published immutable,
// looked up with binary searches over fixed PODs (no allocation, no lock).

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

class Timeline;
struct TrackInfo;

// ─── Enums ────────────────────────────────────────────────────────────────────

// How the source is fitted to the cell before center/zoom/rotation.
// zoom 1.0 = the chosen fit. The framing box keeps the cell's aspect.
enum class LensFit : uint8_t {
    Stretch = 0,  // today's behaviour: source UV = cell UV, aspect ignored
    Cover   = 1,  // fill the cell, crop the overflow (default for new content)
    Contain = 2,  // fit inside the cell, letterbox the rest
};

// Lens flip. FollowTrack passes the track's flip state machine through
// unchanged (the existing per-event orientation); the others override it.
enum class LensFlip : uint8_t {
    FollowTrack = 0,
    None        = 1,
    Horizontal  = 2,
    Vertical    = 3,
};

enum class RoamBounds : uint8_t {
    Clip  = 0,  // cell and content clipped to the home cell rect (default)
    Float = 1,  // drawn unclipped over neighbours, ordered by RoamLayer
};

enum class RoamLayer : uint8_t {
    GridOrder       = 0,  // today's zOrder
    AboveNeighbours = 1,
    Top             = 2,
};

// ─── Params ───────────────────────────────────────────────────────────────────
// Plain fixed-size values: safe to copy into a CellFrameRequest.

struct LensParams {
    LensFit  fit         = LensFit::Stretch;
    float    centerX     = 0.5f;   // 0..1, source-normalized
    float    centerY     = 0.5f;   // 0..1, source-normalized
    float    zoom        = 1.0f;   // multiplier; 1.0 = the chosen fit
    float    rotationDeg = 0.0f;
    LensFlip flip        = LensFlip::FollowTrack;

    // Exact compare on purpose: identity must branch to today's bit-exact
    // shader path (P2), so "nearly identity" is not identity.
    bool isIdentity() const {
        return fit == LensFit::Stretch
            && centerX == 0.5f && centerY == 0.5f
            && zoom == 1.0f && rotationDeg == 0.0f
            && flip == LensFlip::FollowTrack;
    }

    // What a freshly created clip or Pattern Track source starts with.
    static LensParams newContentDefault() {
        LensParams p;
        p.fit = LensFit::Cover;
        return p;
    }

    bool operator==(const LensParams& o) const {
        return fit == o.fit && centerX == o.centerX && centerY == o.centerY
            && zoom == o.zoom && rotationDeg == o.rotationDeg && flip == o.flip;
    }
    bool operator!=(const LensParams& o) const { return !(*this == o); }
};

struct RoamParams {
    float      offsetX     = 0.0f;  // cell units: 1.0 = one cell width
    float      offsetY     = 0.0f;  // cell units: 1.0 = one cell height
    float      scale       = 1.0f;  // multiplier
    float      rotationDeg = 0.0f;  // about the cell center
    RoamBounds bounds      = RoamBounds::Clip;
    RoamLayer  layer       = RoamLayer::GridOrder;

    bool isIdentity() const {
        return offsetX == 0.0f && offsetY == 0.0f
            && scale == 1.0f && rotationDeg == 0.0f
            && bounds == RoamBounds::Clip && layer == RoamLayer::GridOrder;
    }

    bool operator==(const RoamParams& o) const {
        return offsetX == o.offsetX && offsetY == o.offsetY && scale == o.scale
            && rotationDeg == o.rotationDeg && bounds == o.bounds && layer == o.layer;
    }
    bool operator!=(const RoamParams& o) const { return !(*this == o); }
};

// ─── Keys (stored, round-tripped, NOT evaluated in P1) ───────────────────────
// One key = one channel at one time. Channels are keyed independently, as in
// ParamTrack: a gesture that only moves the zoom writes only zoom keys. fit,
// flip, bounds and layer are not animatable and live on `base` only.
//
// Time (spec "Time bases", 960 PPQ):
//   Origin  `pos` ticks from the container's origin. Clip lens: the event
//           start (keys move with the event). Roam: timeline tick 0
//           (timeline-absolute).
//   Head    `pos` ticks after note-on (hit curve).
//   Body    `pos` = fraction 0..1 of the span between head end and tail start.
//   Tail    `pos` ticks before the clamped note end.
//
// The segment LEAVING a key is a cubic bezier (p1x, p1y, p2x, p2y), the
// ParamTrack/ParamTrackEase convention; the defaults are exactly linear.

enum class KeyAnchor : uint8_t { Origin = 0, Head = 1, Body = 2, Tail = 3 };

enum class LensChannel : uint8_t { CenterX = 0, CenterY = 1, Zoom = 2, RotationDeg = 3 };
enum class RoamChannel : uint8_t { OffsetX = 0, OffsetY = 1, Scale = 2, RotationDeg = 3 };

template <typename Channel>
struct LensRoamKey {
    Channel   channel{};
    KeyAnchor anchor = KeyAnchor::Origin;
    double    pos    = 0.0;
    double    value  = 0.0;
    float     p1x = 1.0f / 3.0f, p1y = 1.0f / 3.0f;
    float     p2x = 2.0f / 3.0f, p2y = 2.0f / 3.0f;
};

using LensKey = LensRoamKey<LensChannel>;
using RoamKey = LensRoamKey<RoamChannel>;

// The keyframe-ready container: a static base plus keys layered on it later.
// The save format is fixed now so later phases only fill `keys`.
template <typename Params, typename Key>
struct KeyedParams {
    Params           base;
    std::vector<Key> keys;   // empty in P1
};

using LensTrack = KeyedParams<LensParams, LensKey>;
using RoamTrack = KeyedParams<RoamParams, RoamKey>;

namespace lensroam {

// P1 resolve: the base, keys ignored. The ONE place later phases replace with
// the stateless evaluator (spec "Time bases": one evaluator feeds preview and
// export). Every reader goes through these.
inline const LensParams& resolveBase(const LensTrack& t) { return t.base; }
inline const RoamParams& resolveBase(const RoamTrack& t) { return t.base; }

// A Pattern Track source's resolved base Lens. A source with no entry is new
// (added after the project reached schema v8; pre-v8 sources are materialized
// as Stretch by migratePreLensProject), so it gets newContentDefault().
LensParams resolveSourceLens(const TrackInfo& track, int regionId);

// ── JSON ──────────────────────────────────────────────────────────────────────
// Enums are written as strings. Readers are tolerant: a missing field loads as
// identity, an unknown enum string as the enum's identity value, a
// non-finite number as identity, and a malformed key is dropped.

nlohmann::json lensParamsToJson(const LensParams& p);
LensParams     lensParamsFromJson(const nlohmann::json& j);
nlohmann::json roamParamsToJson(const RoamParams& p);
RoamParams     roamParamsFromJson(const nlohmann::json& j);

// keysField: "keys" for a clip lens and a roam, "hitCurve" for a source lens.
nlohmann::json lensTrackToJson(const LensTrack& t, const char* keysField = "keys");
LensTrack      lensTrackFromJson(const nlohmann::json& j, const char* keysField = "keys");
nlohmann::json roamTrackToJson(const RoamTrack& t);
RoamTrack      roamTrackFromJson(const nlohmann::json& j);

// TrackInfo::trackLens as an array of {regionId, base, hitCurve}, ascending regionId.
nlohmann::json            trackLensToJson(const std::map<int, LensTrack>& m);
std::map<int, LensTrack>  trackLensFromJson(const nlohmann::json& j);

const char* lensFitToString(LensFit f);
const char* lensFlipToString(LensFlip f);
const char* roamBoundsToString(RoamBounds b);
const char* roamLayerToString(RoamLayer l);

// ── Migration (schema v7 -> v8) ───────────────────────────────────────────────
// Ruling 1: an old project renders exactly as before, so every Pattern Track
// source it already uses gets an explicit Stretch entry (clips already load as
// Stretch: Clip from_json maps a missing "lens" to identity). Roam loads as
// identity from the missing key. Nothing else migrates: every existing
// zoom/pan/rotate datum is an effect (see ProjectManager.h, v8).
struct MigrationStats {
    int tracks         = 0;  // tracks seen (all get identity Roam)
    int patternSources = 0;  // {trackId, regionId} entries materialized as Stretch
    int clips          = 0;  // clips (all loaded as Stretch)
};
MigrationStats migratePreLensProject(Timeline& timeline);

} // namespace lensroam

// ─── LensRoamSnapshot ─────────────────────────────────────────────────────────
// Immutable, resolved Lens/Roam values for one timeline state. Built on the
// message thread (buildLensRoamSnapshot), published as
// shared_ptr<const LensRoamSnapshot>, and only ever READ by the collector:
// three sorted vectors of PODs, binary-searched, so a lookup neither
// allocates nor locks. A lookup miss (an id the snapshot predates) returns
// identity — today's rendering — never a guess.
struct LensRoamSnapshot {
    struct TrackEntry {
        int        trackId = -1;
        RoamParams roam;
        // Lens for a source of this track that has no entry (a new source):
        // newContentDefault() on a Pattern track, identity on a Clip track.
        LensParams sourceFallback;
    };
    struct ClipEntry   { int clipId = -1; LensParams lens; };
    struct SourceEntry { int trackId = -1; int regionId = -1; LensParams lens; };

    std::vector<TrackEntry>  tracks;   // ascending trackId
    std::vector<ClipEntry>   clips;    // ascending clipId
    std::vector<SourceEntry> sources;  // ascending (trackId, regionId)

    RoamParams roamFor(int trackId) const;
    LensParams lensForClip(int clipId) const;
    LensParams lensForSource(int trackId, int regionId) const;

    // A VideoEvent's Lens: clip events (clipId >= 0) use the clip's lens,
    // pattern/note events the {trackId, regionId} source lens.
    LensParams lensForEvent(int trackId, int clipId, int regionId) const {
        return clipId >= 0 ? lensForClip(clipId) : lensForSource(trackId, regionId);
    }

    struct Counts {
        int tracks = 0, roamNonIdentity = 0;
        int clips = 0, clipLensNonIdentity = 0;
        int sources = 0, sourceLensNonIdentity = 0;
        bool operator==(const Counts& o) const {
            return tracks == o.tracks && roamNonIdentity == o.roamNonIdentity
                && clips == o.clips && clipLensNonIdentity == o.clipLensNonIdentity
                && sources == o.sources && sourceLensNonIdentity == o.sourceLensNonIdentity;
        }
        bool operator!=(const Counts& o) const { return !(*this == o); }
    };
    Counts counts() const;
};

// Message thread only (allocates). Caller holds whatever lock guards the
// timeline for reading.
std::shared_ptr<const LensRoamSnapshot> buildLensRoamSnapshot(const Timeline& timeline);
