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
// live preview and export share. P3/P4 edit the static bases.
//
// P7: keys are EVALUATED, through the shared curve engine (model/KeyCurve.h).
// buildLensRoamSnapshot compiles every channel's keys into sorted arrays on
// the message thread; the collector asks lensForEventAt / roamAt per frame
// (binary search + interpolation, nothing else). Clip lens keys run on event
// ticks, Roam keys on timeline ticks, a Pattern Track source's hit curve on
// note anchors for every active note.
//
// P8: per-note overrides (Follow / Nudge / Own) are evaluated on top of that,
// and the hit curve is edited (SetHitCurveCommand, presets in
// model/LensHitPresets.h).
//
// P11: the Sweep lane. A Pattern Track's timeline-absolute Lens offset for moves
// that span several notes (TrackInfo::sweep). It is a LAYER on the track's
// Lens, applied after the note animation and before flip: zoom multiplies,
// centre and rotation add, an unkeyed channel is the layer identity.
//
// Storage (spec "Storage"):
//   Clip Track event          Clip::lens            LensTrack {base, keys}
//   Pattern Track source      TrackInfo::trackLens  regionId -> LensTrack {base, hitCurve}
//                             (the {trackId, regionId} key: the map lives on the track)
//   Track                     TrackInfo::roam       RoamTrack {base, keys, masks}
//                             (masks: Motion view; parent: TrackInfo::parentTrackId)
//   Per note                  PatternNote::lensOverride  LensNoteOverride {mode, keys}
//                             (the {patternId, noteId} key: it lives on the note; P5)
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

#include "KeyCurve.h"
#include "MotionSchema.h"

#include <array>

class Timeline;
struct TrackInfo;
struct VisualEffect;

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
    // `scale` is the cell's width multiplier, and its height one too while
    // `scaleLinked` (the default, and what every project saved before Scale X/Y
    // split loads as). Unlinked, `scaleY` is the height multiplier. A linked
    // cell never reads `scaleY` (nor its keys), so old projects render exactly
    // as before. Read both through scaleXEff() / scaleYEff().
    float      scale       = 1.0f;  // multiplier (X when unlinked)
    float      scaleY      = 1.0f;  // multiplier, read only when !scaleLinked
    bool       scaleLinked = true;
    float      rotationDeg = 0.0f;  // about the cell center
    // Border crop: the share of the DRAWN cell (after offset / scale /
    // rotation, so it travels with the cell) trimmed off each edge, 0..1. The
    // picture is not scaled: a cropped edge just stops showing, so a cell's
    // shape changes without squishing the video. Rendered by the Mask pass.
    float      cropLeft    = 0.0f;
    float      cropRight   = 0.0f;
    float      cropTop     = 0.0f;
    float      cropBottom  = 0.0f;
    RoamBounds bounds      = RoamBounds::Clip;
    RoamLayer  layer       = RoamLayer::GridOrder;

    float scaleXEff() const { return scale; }
    float scaleYEff() const { return scaleLinked ? scale : scaleY; }
    bool  hasCrop() const {
        return cropLeft != 0.0f || cropRight != 0.0f || cropTop != 0.0f || cropBottom != 0.0f;
    }

    bool isIdentity() const {
        return offsetX == 0.0f && offsetY == 0.0f
            && scale == 1.0f && scaleYEff() == 1.0f && rotationDeg == 0.0f
            && !hasCrop()
            && bounds == RoamBounds::Clip && layer == RoamLayer::GridOrder;
    }

    // scaleY of a linked cell is not part of its value (never read), so it is
    // not compared; scaleLinked itself is (it changes what the next edit means).
    bool operator==(const RoamParams& o) const {
        return offsetX == o.offsetX && offsetY == o.offsetY && scale == o.scale
            && scaleLinked == o.scaleLinked && (scaleLinked || scaleY == o.scaleY)
            && rotationDeg == o.rotationDeg
            && cropLeft == o.cropLeft && cropRight == o.cropRight
            && cropTop == o.cropTop && cropBottom == o.cropBottom
            && bounds == o.bounds && layer == o.layer;
    }
    bool operator!=(const RoamParams& o) const { return !(*this == o); }
};

// ─── Keys ─────────────────────────────────────────────────────────────────────
// One key = one channel at one time: the stored form of a generic
// xleth::keycurve::Key (value, interp, position) plus the channel it drives.
// Channels are keyed independently, as in ParamTrack: a gesture that only
// moves the zoom writes only zoom keys. fit, flip, bounds and layer are not
// animatable and live on `base` only.
//
// Time (spec "Time bases", 960 PPQ):
//   Origin  `pos` ticks from the container's origin. Clip lens: the event
//           start (keycurve EventTicks; keys move with the event). Roam:
//           timeline tick 0 (keycurve TimelineTicks).
//   Head    `pos` ticks after note-on (hit curve).
//   Body    `pos` = fraction 0..1 of the span between head end and tail start.
//   Tail    `pos` ticks before the clamped note end.
//
// `interp` shapes the segment LEAVING the key (Hold | Linear | EaseOut |
// Bezier; see KeyCurve.h). P7 replaced P1's never-evaluated p1x..p2y handles
// with it; a stored key without "interp" loads as Linear, which is what P1's
// default handles described. A Bezier key carries its own handles in `bez`
// (saved as "bez": [x1, y1, x2, y2]); every other key ignores `bez` and keeps
// the default, so two keys that only differ in an unread `bez` never exist.
//
// What a key's value MEANS (P7):
//   Clip lens keys and Roam keys are ABSOLUTE: a keyed channel follows its
//   keys, an unkeyed one holds the base (ParamTrack's constantValue rule).
//   A hit curve is the note-animation LAYER on top of the source's base, and
//   blends per the spec: zoom multiplies; centerX/Y and rotation add. So an
//   unkeyed hit-curve channel is the layer identity (zoom 1, offsets 0), and
//   the presets' "zoom 1.35 -> 1.00" punch the framing the user set.

enum class KeyAnchor : uint8_t { Origin = 0, Head = 1, Body = 2, Tail = 3 };

enum class LensChannel : uint8_t { CenterX = 0, CenterY = 1, Zoom = 2, RotationDeg = 3 };
// Scale is the width (and the height while linked); ScaleY only counts unlinked.
// Crop channels are fractions 0..1 of the drawn cell, kept below 1 together.
enum class RoamChannel : uint8_t {
    OffsetX = 0, OffsetY = 1, Scale = 2, RotationDeg = 3,
    ScaleY = 4, CropLeft = 5, CropRight = 6, CropTop = 7, CropBottom = 8,
};
// Slots in a ChannelRuns: sized for the widest enum (Roam). Lens, Sweep and the
// Mask scalars use the first four (or three) and leave the rest empty.
inline constexpr int kLensRoamChannels = 9;
inline constexpr int kLensChannelCount = 4;   // LensChannel has exactly four

template <typename Channel>
struct LensRoamKey {
    Channel                 channel{};
    KeyAnchor               anchor = KeyAnchor::Origin;
    double                  pos    = 0.0;
    double                  value  = 0.0;
    xleth::keycurve::Interp interp = xleth::keycurve::Interp::Linear;
    xleth::keycurve::BezierHandles bez;   // Bezier only; default otherwise
};

using LensKey = LensRoamKey<LensChannel>;
using RoamKey = LensRoamKey<RoamChannel>;

// The keyframe-ready container: a static base plus keys.
template <typename Params, typename Key>
struct KeyedParams {
    Params           base;
    std::vector<Key> keys;
    // Head / Body / Tail zone lengths and the short-note rule, for
    // note-anchored keys. Only a Pattern Track source's hit curve reads it
    // (saved with that trackLens entry). A clip lens is not note-relative: it
    // ignores it and never saves it.
    xleth::keycurve::NoteZones zones;
};

using LensTrack = KeyedParams<LensParams, LensKey>;

// ─── Masks (Motion view, docs/XLETH_MOTION_VIEW_DESIGN.md 2.2, R11-R15) ──────
// A Mask is a closed bezier path in the cell's own space that cuts what the
// cell shows. It belongs to Roam (it moves, scales, rotates, bounces and blurs
// with the cell). Several masks per track combine top to bottom (R12).
//
// Space (R11): normalized CELL space. Origin at the centre of the drawn cell;
// x in [-0.5, 0.5] spans the cell width left -> right, y in [-0.5, 0.5] its
// height top -> bottom (y down). Feather and Expansion are distances in units
// of the drawn cell's SHORTER side.
//
// Every mask has one base shape and optional SHAPE keys (each stores every
// vertex; all have the base's vertex count, R14) plus scalar keys on the
// Mask channels below. Keys are timeline-absolute (anchor Origin, TimelineTicks),
// like every Roam key, and ABSOLUTE: a keyed channel follows its keys, an
// unkeyed one holds the base.
//
// Channel names, identities, clamps and the caps come from the motion schema
// (model/MotionSchema.h): mask.feather / mask.expansion / mask.opacity carry
// engineIndex 0 / 1 / 2 = MaskChannel.
enum class MaskChannel : uint8_t { Feather = 0, Expansion = 1, Opacity = 2 };
inline constexpr int kMaskChannels = 3;
using MaskKey = LensRoamKey<MaskChannel>;

// Rectangle / Ellipse are kinds of the same path (4 vertices); the vertices are
// always stored. Editing one vertex of a Rectangle or Ellipse makes it a Path.
enum class MaskKind : uint8_t { Rectangle = 0, Ellipse = 1, Path = 2 };
enum class MaskMode : uint8_t { Add = 0, Subtract = 1, Intersect = 2 };

// One path vertex. The tangents are RELATIVE to the vertex (handle offsets);
// a corner has zero tangents. Wire form: [x, y, inX, inY, outX, outY].
struct MaskVertex {
    double x = 0.0, y = 0.0;
    double inX = 0.0, inY = 0.0;
    double outX = 0.0, outY = 0.0;
    bool operator==(const MaskVertex& o) const {
        return x == o.x && y == o.y && inX == o.inX && inY == o.inY
            && outX == o.outX && outY == o.outY;
    }
    bool operator!=(const MaskVertex& o) const { return !(*this == o); }
};

struct MaskShape {
    bool closed = true;                   // v1: always closed (open paths are rejected)
    std::vector<MaskVertex> vertices;     // 3..32 (schema limits)
    bool operator==(const MaskShape& o) const { return closed == o.closed && vertices == o.vertices; }
    bool operator!=(const MaskShape& o) const { return !(*this == o); }
};

struct MaskParams {
    MaskShape shape;
    double    feather   = 0.0;            // [0, 1] shorter-side units, centred on the edge
    double    expansion = 0.0;            // [-1, 1] shorter-side units
    double    opacity   = 1.0;            // [0, 1]; 0 = the mask has no effect
    MaskMode  mode      = MaskMode::Add;
    bool      invert    = false;
    bool operator==(const MaskParams& o) const {
        return shape == o.shape && feather == o.feather && expansion == o.expansion
            && opacity == o.opacity && mode == o.mode && invert == o.invert;
    }
    bool operator!=(const MaskParams& o) const { return !(*this == o); }
};

// A shape key: the whole path at one timeline tick. interp/bez shape the
// segment LEAVING the key (the blend factor every vertex and tangent lerps by).
struct MaskShapeKey {
    double                         pos    = 0.0;   // timeline ticks
    xleth::keycurve::Interp        interp = xleth::keycurve::Interp::Linear;
    xleth::keycurve::BezierHandles bez;            // Bezier only; default otherwise
    std::vector<MaskVertex>        vertices;       // the base's vertex count
    bool operator==(const MaskShapeKey& o) const {
        return pos == o.pos && interp == o.interp
            && (interp != xleth::keycurve::Interp::Bezier || bez == o.bez)
            && vertices == o.vertices;
    }
    bool operator!=(const MaskShapeKey& o) const { return !(*this == o); }
};

struct RoamMask {
    int                       id   = 0;          // > 0, unique within the track
    std::string               name;              // <= 64 characters
    MaskKind                  kind = MaskKind::Path;
    MaskParams                base;
    std::vector<MaskKey>      keys;              // feather / expansion / opacity, Origin
    std::vector<MaskShapeKey> shapeKeys;         // ascending pos, one per pos
    bool operator==(const RoamMask& o) const {
        return id == o.id && name == o.name && kind == o.kind && base == o.base
            && keys == o.keys && shapeKeys == o.shapeKeys;
    }
    bool operator!=(const RoamMask& o) const { return !(*this == o); }
};

// A track's Roam: its own struct (not the KeyedParams alias LensTrack uses), so
// the masks belong to Roam only. Roam keys are timeline ticks; Roam never had
// note zones (it never saved them), so it carries none.
struct RoamTrack {
    RoamParams            base;
    std::vector<RoamKey>  keys;
    std::vector<RoamMask> masks;    // top to bottom; saved only when non-empty
};

// ─── Video effect parameter keys (Motion view) ───────────────────────────────
// One key on one param of one chain effect. `uid` is VisualEffect::uid, `param`
// the params[] index, `pos` timeline ticks (anchor Origin), `value` the param's
// own units (the same number a static edit writes). Absolute, like a Roam key.
struct FxKey {
    int                     uid    = 0;
    int                     param  = 0;
    double                  pos    = 0.0;
    double                  value  = 0.0;
    xleth::keycurve::Interp interp = xleth::keycurve::Interp::Linear;
    xleth::keycurve::BezierHandles bez;   // Bezier only; default otherwise
    bool operator==(const FxKey& o) const {
        return uid == o.uid && param == o.param && pos == o.pos && value == o.value
            && interp == o.interp
            && (interp != xleth::keycurve::Interp::Bezier || bez == o.bez);
    }
    bool operator!=(const FxKey& o) const { return !(*this == o); }
};

namespace fxparam {
// The params[] of a chain effect that can be animated: continuous scalars. Colours
// (RGB), enums, flags, the Echo's tap count and its Delay binding are not. Mirrors
// ui/src/components/devices/video/videoFxCatalog.js (CHAIN_PARAMS, minus Taps).
// `type` is VisualEffect::Type as an int. True and [lo, hi] when animatable.
bool range(int type, int param, double& lo, double& hi);
} // namespace fxparam

// ─── Sweep (P11, spec "Sweep lane") ──────────────────────────────────────────
// A track's timeline-absolute Lens offset. Keys are Lens channels (centerX,
// centerY, zoom, rotationDeg) on TimelineTicks (anchor Origin, pos = ticks from
// timeline tick 0). There is no base: Sweep is a LAYER, like the hit curve.
// An unkeyed channel is the layer identity (zoom x1, centre +0, rotation +0),
// and a keyed channel's value blends with the note's Lens per the spec
// ("Blend"): zoom multiplies; centre and rotation add. So a zoom bump keyed
// across two notes multiplies each note's own framing and one continuous move
// plays through both.
//
// Order of operations (spec, unchanged): Lens base -> note animation (Follow /
// Nudge / Own) -> Sweep -> the existing chain (flip mirrors the framed result).
struct SweepTrack {
    std::vector<LensKey> keys;
};

// ─── Per-note Lens override (spec "Storage", Ruling 6) ───────────────────────
// Stored ON the PatternNote (PatternNote::lensOverride), so the spec's
// {patternId, noteId} key is the note's own address: it rides every note
// snapshot, undo entry and copy for free. Absent (null) = Follow: the note
// plays its source's hit curve. Nudge = hit curve plus `keys`; Own = `keys`
// only. Keys use the note anchors (Head / Body / Tail).
//
// P5 carries the override without losing it. P8 evaluates it
// (LensRoamSnapshot::lensForEventAt) and edits it through UndoManager
// commands (SetNoteLensModeCommand, SetNoteLensKeysCommand,
// RevertNotesToFollowCommand). Keys are a LAYER, like the hit curve: an
// unkeyed channel is the layer identity (zoom 1, offsets 0), so a Nudge with
// no keys plays exactly the hit curve and an Own with no keys holds the base.
// Zones (head/tail lengths, Squash/Cut) belong to the hit curve: a Nudge's
// keys play on the source's zones, an Own note's on the spec defaults (120,
// 240, Squash), so no hit-curve edit, zones included, reaches an Own note.
//
// Immutable once built and shared by shared_ptr<const>: copying a note (undo
// snapshots, the export's frozen timeline copy, piano-roll list edits) never
// deep-copies or allocates; an edit replaces the pointer.
enum class LensOverrideMode : uint8_t { Nudge = 0, Own = 1 };

struct LensNoteOverride {
    LensOverrideMode     mode = LensOverrideMode::Nudge;
    std::vector<LensKey> keys;
};

using LensNoteOverridePtr = std::shared_ptr<const LensNoteOverride>;

// Exact compares (channel, anchor, pos, value, interp, and a Bezier key's
// handles, in stored order): what an edit command uses to decide whether it
// changes anything.
template <typename Channel>
inline bool operator==(const LensRoamKey<Channel>& a, const LensRoamKey<Channel>& b) {
    return a.channel == b.channel && a.anchor == b.anchor && a.pos == b.pos
        && a.value == b.value && a.interp == b.interp
        && (a.interp != xleth::keycurve::Interp::Bezier || a.bez == b.bez);
}
template <typename Channel>
inline bool operator!=(const LensRoamKey<Channel>& a, const LensRoamKey<Channel>& b) {
    return !(a == b);
}

// Two overrides (either may be null = Follow) are the same state.
inline bool sameLensOverride(const LensNoteOverridePtr& a, const LensNoteOverridePtr& b) {
    if (a == b) return true;
    if (!a || !b) return false;
    return a->mode == b->mode && a->keys == b->keys;
}

// ─── Evaluated masks for one cell (render-request copy, design 3.3) ──────────
// Fixed capacity from the schema caps, so a CellFrameRequest can carry it by
// value with no allocation. Filled by LensRoamSnapshot::masksAt.
inline constexpr int kMaxMasksPerTrack        = motionschema::kMaxMasksPerTrack;         // 8
inline constexpr int kMaxMaskVerticesPerTrack = motionschema::kMaxMaskVerticesPerTrack;  // 64

// One evaluated vertex, cell space (R11), tangents relative to the vertex.
struct MaskVertexF { float x, y, inX, inY, outX, outY; };

struct MaskFrameEntry {
    uint8_t  mode;          // MaskMode
    uint8_t  invert;        // 0 / 1
    uint8_t  vertexCount;   // 3..32
    uint16_t firstVertex;   // into MaskFrame::verts
    float    feather, expansion, opacity;   // clamped into the schema clamps
};

// A frame holds the track's user masks plus ONE more mask: the Roam border crop
// (an Intersect rectangle appended last by masksAt, 4 corner vertices), so a
// track with the full 8 masks can still crop.
inline constexpr int kCropMaskVertices  = 4;
// Points the crop rectangle may flatten to: 4 straight corners, or a rounded rectangle
// (4 arcs of up to 15 points) when the cell has corner rounding.
inline constexpr int kCropMaskPoints    = 64;
inline constexpr int kMaskFrameMasks    = kMaxMasksPerTrack + 1;
inline constexpr int kMaskFrameVertices = kMaxMaskVerticesPerTrack + kCropMaskVertices;

struct MaskFrame {
    uint8_t count = 0;      // masks in use, top to bottom (R12 combination order)
    int8_t  cropSlot = -1;  // the entry that is the Roam crop rectangle, -1 = none
    std::array<MaskFrameEntry, kMaskFrameMasks>     masks;
    std::array<MaskVertexF, kMaskFrameVertices> verts;
};

namespace lensroam {

// The static base, keys ignored. What the snapshot's base lookups (roamFor,
// lensForClip, lensForSource) return and what the UI edits. The animated
// value at a frame comes from LensRoamSnapshot::lensForEventAt / roamAt.
inline const LensParams& resolveBase(const LensTrack& t) { return t.base; }
inline const RoamParams& resolveBase(const RoamTrack& t) { return t.base; }

// A stored key as a generic curve key. `origin` is what an Origin anchor means
// in this container: EventTicks for a clip lens, TimelineTicks for a roam.
template <typename Channel>
xleth::keycurve::Key toCurveKey(const LensRoamKey<Channel>& k, xleth::keycurve::TimeBase origin) {
    using xleth::keycurve::Position;
    xleth::keycurve::Key c;
    c.value  = k.value;
    c.interp = k.interp;
    if (k.interp == xleth::keycurve::Interp::Bezier) c.bez = k.bez;
    switch (k.anchor) {
        case KeyAnchor::Head: c.position = Position::head(k.pos); break;
        case KeyAnchor::Body: c.position = Position::body(k.pos); break;
        case KeyAnchor::Tail: c.position = Position::tail(k.pos); break;
        default:              c.position = { origin, k.pos };     break;
    }
    return c;
}

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
// TrackInfo::sweep as {keys: [...]} (Lens channels, Origin anchors). Saved only
// when it has keys, so a project with no Sweep is byte-identical to before P11.
nlohmann::json sweepTrackToJson(const SweepTrack& t);
SweepTrack     sweepTrackFromJson(const nlohmann::json& j);

// ── Masks (design 2.2) ────────────────────────────────────────────────────────
// roamTrackToJson writes "masks" only when the track has one, so a project
// with no masks saves exactly as before.
//
// Wire / file shape of one mask:
//   { id, name, kind: Rectangle|Ellipse|Path,
//     base: { shape: { closed: true, vertices: [[x,y,inX,inY,outX,outY], ...] },
//             feather, expansion, opacity, mode: Add|Subtract|Intersect, invert },
//     keys: [{ channel: feather|expansion|opacity, anchor: Origin, pos, value,
//              interp, bez? }],
//     shapeKeys: [{ pos, interp, bez?, vertices: [[...6 numbers], ...] }] }
nlohmann::json        maskToJson(const RoamMask& m);
nlohmann::json        masksToJson(const std::vector<RoamMask>& masks);
// TOLERANT (project load): a mask whose base shape is malformed (not 3..32
// vertices of six finite numbers) is dropped; a missing / invalid / duplicate id
// gets a fresh one (max + 1); a name is cut to 64 characters; an unknown kind
// loads as Path, an unknown mode as Add; scalars missing -> identity, out of
// the schema clamp -> clamped; malformed keys and shape keys (wrong vertex
// count, non-finite) are dropped; shape keys are sorted by pos (a later key at
// the same pos wins). Masks past the caps (8 per track, 64 vertices in total)
// are dropped in order.
std::vector<RoamMask> masksFromJson(const nlohmann::json& j);
// STRICT (the timeline_setTrackMasks RPC): the whole list. Unknown field, wrong
// type, non-finite number, value outside the schema clamp, unknown enum string,
// open path, a vertex count outside 3..32, a shape key whose vertex count is
// not the base's, two shape keys at one pos, a duplicate or non-positive id, a
// name over 64 characters, a key whose anchor is not Origin or pos < 0, or a
// cap exceeded -> false + `err` (nothing written to `out`). Required per mask:
// `id` and `base.shape.vertices`; everything else defaults (name "Mask <id>",
// kind Path, identity scalars, no keys). Shape keys come back sorted by pos.
bool masksFromJsonStrict(const nlohmann::json& j, std::vector<RoamMask>& out, std::string& err);

const char* maskKindToString(MaskKind k);
const char* maskModeToString(MaskMode m);
const char* maskChannelToString(MaskChannel c);

// Default shapes (design 2.2): Rectangle = 4 corners clockwise from the top
// left, zero tangents; Ellipse = 4 vertices top, right, bottom, left with
// kappa tangents (clockwise on screen, y down). The UI adds them inset +-0.4 /
// radii 0.4.
inline constexpr double kEllipseKappa = 0.5522847498;
MaskShape rectangleMaskShape(double halfW, double halfH);
MaskShape ellipseMaskShape(double rx, double ry);

// Every vertex of every mask's base shape (what the 64-per-track cap counts).
int maskVertexTotal(const std::vector<RoamMask>& masks);

// ── Roam evaluated straight from the model (message thread; allocates) ───────
// The same compile + evaluation path as LensRoamSnapshot::roamAt, so the value
// is bit-identical to what the renderer computes at that tick. Used by the
// Parent keep-on-screen solve (model/ParentMath.h).
RoamParams roamAtTick(const RoamTrack& t, double tick);
// True when the track has at least one key on channel `c` (that channel then
// ignores the base).
bool roamChannelKeyed(const RoamTrack& t, RoamChannel c);

// TrackInfo::trackLens as an array of {regionId, base, hitCurve, zones},
// ascending regionId. zones = {headTicks, tailTicks, shortNote: Squash|Cut};
// a missing or malformed field loads as the spec default (120, 240, Squash).
nlohmann::json            trackLensToJson(const std::map<int, LensTrack>& m);
std::map<int, LensTrack>  trackLensFromJson(const nlohmann::json& j);

// PatternNote::lensOverride as {mode: "Nudge"|"Own", keys: [...]}. The reader
// returns null (Follow) for null / a non-object / a missing or unknown mode;
// malformed keys are dropped like everywhere else. Used by Pattern.cpp (save /
// load) and by both engine<->UI note converters.
nlohmann::json      lensNoteOverrideToJson(const LensNoteOverride& o);
LensNoteOverridePtr lensNoteOverrideFromJson(const nlohmann::json& j);

const char* lensOverrideModeToString(LensOverrideMode m);

const char* interpToString(xleth::keycurve::Interp i);
// A Bezier key's handles as [x1, y1, x2, y2]. The reader is strict: it returns
// false (and leaves `out` alone) unless `j` is an array of four finite
// numbers; x1 / x2 are clamped into [0, 1] (KeyCurve's sanitizeBezier).
nlohmann::json bezierToJson(const xleth::keycurve::BezierHandles& b);
bool           bezierFromJson(const nlohmann::json& j, xleth::keycurve::BezierHandles& out);
const char* shortNoteRuleToString(xleth::keycurve::ShortNoteRule r);
nlohmann::json             noteZonesToJson(const xleth::keycurve::NoteZones& z);
xleth::keycurve::NoteZones noteZonesFromJson(const nlohmann::json& j);

// TrackInfo::fxKeys as an array of {uid, param, pos, value, interp, bez?}. The
// reader drops a malformed key (non-finite, uid <= 0, param outside 0..15).
nlohmann::json      fxKeysToJson(const std::vector<FxKey>& keys);
std::vector<FxKey>  fxKeysFromJson(const nlohmann::json& j);

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
// sorted vectors of PODs, binary-searched, so a lookup neither allocates nor
// locks. A lookup miss (an id the snapshot predates) returns identity —
// today's rendering — never a guess.
//
// P7: every channel's keys are compiled into `keys` (one pool) at build time:
// converted to keycurve::Key, malformed ones dropped (non-finite, or a zoom /
// scale value <= 0), clamped into their note zones and sorted (keycurve
// compileTimeKeys / compileNoteKeys). An entry addresses its runs with
// KeyRun {first, count}. A frame lookup is then a binary search per keyed
// channel plus one interpolation: the render thread never sorts, allocates,
// locks or logs. Live preview and export both build their snapshot with
// buildLensRoamSnapshot and evaluate it with the functions below, so the
// same timeline tick gives the same bits in both.
struct LensRoamSnapshot {
    // One channel's compiled keys: keys[first, first + count), in time order.
    struct KeyRun {
        uint32_t first = 0;
        uint32_t count = 0;
    };
    using ChannelRuns = KeyRun[kLensRoamChannels];   // indexed by Lens/RoamChannel

    struct TrackEntry {
        int         trackId = -1;
        RoamParams  roam;                  // the static base
        // Lens for a source of this track that has no entry (a new source):
        // newContentDefault() on a Pattern track, identity on a Clip track.
        LensParams  sourceFallback;
        ChannelRuns roamKeys{};            // TimelineTicks, absolute values
        bool        roamKeyed = false;
        // The track crops its cell (a non-zero base or any crop key): masksAt
        // appends the crop as the last mask. Precomputed so a frame without
        // masks or crop costs one flag test.
        bool        cropActive = false;
        ChannelRuns sweepKeys{};           // TimelineTicks, a LAYER (P11)
        bool        swept = false;
        // Motion view. The RESOLVED parent: -1 when none, when the stored id
        // is dangling (no such track) or names the track itself. Cycles are
        // cut by parentChain (bounded walk), never here.
        int         parentTrackId = -1;
        // This track's compiled masks: masks[maskFirst, maskFirst + maskCount).
        uint32_t    maskFirst = 0;
        uint8_t     maskCount = 0;
        // This track's compiled video-effect param keys: fxRuns[fxFirst, fxFirst + fxCount).
        uint32_t    fxFirst = 0;
        uint32_t    fxCount = 0;
    };

    // One animated param of one chain effect (Motion view). The run lives in the
    // shared `keys` pool (TimelineTicks, absolute); lo / hi clamp the value.
    struct FxRun {
        int     uid   = 0;
        int     param = 0;
        int     type  = 0;       // VisualEffect::Type the keys were compiled for
        float   lo    = 0.0f;
        float   hi    = 1.0f;
        KeyRun  run{};
    };

    // One compiled mask. Scalars: base values (already clamped) plus runs in
    // the shared `keys` pool (TimelineTicks, absolute). Shape: the base path
    // at maskVertices[baseVertex, baseVertex + vertexCount) and, when keyed,
    // shapeKeys[firstShapeKey, firstShapeKey + shapeKeyCount) (ascending pos,
    // one per pos, each pointing at its own vertexCount vertices).
    struct MaskEntry {
        uint8_t     mode = 0;              // MaskMode
        uint8_t     invert = 0;
        uint8_t     vertexCount = 0;
        float       feather = 0.0f, expansion = 0.0f, opacity = 1.0f;
        ChannelRuns scalarKeys{};          // indexed by MaskChannel (slot 3 unused)
        bool        scalarKeyed = false;
        uint32_t    baseVertex = 0;
        uint32_t    firstShapeKey = 0;
        uint32_t    shapeKeyCount = 0;
    };
    struct ShapeKeyEntry {
        double                         pos = 0.0;      // timeline ticks
        xleth::keycurve::Interp        interp = xleth::keycurve::Interp::Linear;
        xleth::keycurve::BezierHandles bez;            // sanitized; Bezier only
        uint32_t                       firstVertex = 0;
    };
    struct ClipEntry {
        int         clipId = -1;
        LensParams  lens;                  // the static base
        ChannelRuns lensKeys{};            // EventTicks, absolute values
        bool        keyed = false;
    };
    struct SourceEntry {
        int         trackId = -1;
        int         regionId = -1;
        LensParams  lens;                  // the static base
        ChannelRuns hitCurve{};            // note anchors, a layer on `lens`
        xleth::keycurve::NoteZones zones;
        bool        keyed = false;
    };

    // A per-note Lens override (P8), compiled for ONE track's placement of
    // its pattern: the keys are clamped into that track's source zones, so a
    // pattern placed on two tracks with different zones gets two entries.
    // Only notes that HAVE an override (Nudge / Own) get one; a miss is
    // Follow.
    struct OverrideEntry {
        int              trackId   = -1;
        int              patternId = -1;
        int              noteId    = -1;
        LensOverrideMode mode      = LensOverrideMode::Nudge;
        ChannelRuns      keys{};           // note anchors, a layer
        bool             keyed     = false;
    };

    // A Trail clone (model/Clone.h), compiled: the source whose whole cell
    // result it replays `delayTicks` later, its multiply tint and its opacity
    // (base + timeline-absolute keys, ABSOLUTE values, in `keys`). Its added
    // Roam is its own TrackEntry's (roamAt(trackId, tick); offset only).
    struct TrailEntry {
        int      trackId       = -1;   // the Trail clone
        int      sourceTrackId = -1;
        double   delayTicks    = 0.0;
        uint32_t tintRgb       = 0xFFFFFFu;
        double   opacity       = 1.0;
        KeyRun   opacityKeys{};
        bool     keyed         = false;
    };

    std::vector<TrackEntry>           tracks;     // ascending trackId
    // Ascending sourceTrackId; within a source FARTHEST delay first (the draw
    // order under the source: the nearest delay sits closest to it), then id.
    std::vector<TrailEntry>           trails;
    std::vector<ClipEntry>            clips;      // ascending clipId
    std::vector<SourceEntry>          sources;    // ascending (trackId, regionId)
    std::vector<OverrideEntry>        overrides;  // ascending (trackId, patternId, noteId)
    std::vector<xleth::keycurve::Key> keys;       // every compiled key (see KeyRun)
    std::vector<FxRun>                fxRuns;       // per track, see TrackEntry::fxFirst
    std::vector<MaskEntry>            masks;        // per track, see TrackEntry::maskFirst
    std::vector<ShapeKeyEntry>        shapeKeys;    // see MaskEntry::firstShapeKey
    std::vector<MaskVertexF>          maskVertices; // base shapes and shape keys

    // ── Static bases (keys ignored) ─────────────────────────────────────────
    RoamParams roamFor(int trackId) const;
    LensParams lensForClip(int clipId) const;
    LensParams lensForSource(int trackId, int regionId) const;

    // A VideoEvent's base Lens: clip events (clipId >= 0) use the clip's lens,
    // pattern/note events the {trackId, regionId} source lens.
    LensParams lensForEvent(int trackId, int clipId, int regionId) const {
        return clipId >= 0 ? lensForClip(clipId) : lensForSource(trackId, regionId);
    }

    // ── Animated values at one frame (render thread) ────────────────────────
    // The one evaluator for live preview and export. All times are ticks
    // (960 PPQ), and every value is a pure function of these inputs.
    struct EventClock {
        double frameTick      = 0.0;  // the frame's timeline tick
        double eventStartTick = 0.0;  // the clip start / the note-on
        double eventLenTicks  = 0.0;  // the event's CLAMPED length (where it stops)
    };

    // Which note a pattern event plays: the {patternId, noteId} key of its
    // override (spec Ruling 6). -1 = not a note (a clip, an arp step): Follow.
    struct NoteRef {
        int patternId = -1;
        int noteId    = -1;
    };

    // Clip event: the clip lens, keyed channels at (frameTick - eventStartTick).
    // Pattern event: the source lens with the note animation blended on top,
    // at (frameTick - note-on) inside a note of eventLenTicks (Squash/Cut per
    // the source's zones). The note's override picks the layers (spec
    // "Blend": zoom multiplies; centre and rotation add):
    //   Follow (no override)  base x hit curve
    //   Nudge                 base x hit curve x note keys
    //   Own                   base x note keys          (hit-curve edits never reach it)
    // = applySweep(lensBeforeSweep(...)): the track's Sweep (P11) goes on last.
    LensParams lensForEventAt(int trackId, int clipId, int regionId, const EventClock& clock,
                              const NoteRef& note = NoteRef{}) const;

    // The Lens with the note animation applied and NO Sweep: what lensForEventAt
    // returned before P11, bit for bit. A held gap stores this, so its Sweep keeps
    // running on the timeline tick while the frozen picture does not move.
    LensParams lensBeforeSweep(int trackId, int clipId, int regionId, const EventClock& clock,
                               const NoteRef& note = NoteRef{}) const;

    // The track's Sweep (P11) at the timeline tick, blended onto `p` (zoom
    // multiplies; centre and rotation add). A track with no Sweep keys returns
    // `p` untouched, bit for bit. Double math, one rounding, like the note layers.
    LensParams applySweep(int trackId, const LensParams& p, double frameTick) const;

    // The override entry for one note on one track, or null (Follow).
    const OverrideEntry* overrideFor(int trackId, int patternId, int noteId) const;

    // The track's Roam, keyed channels at the timeline tick.
    RoamParams roamAt(int trackId, double frameTick) const;

    // Video effect param keys (Motion view): overwrite the keyed params[] of the
    // request's COPY of the track's chain with their value at the timeline tick,
    // clamped to the param's range. An effect is matched by uid and type, so a
    // chain edited since this snapshot was built is left alone where it no longer
    // matches. A track with no fx keys returns at once. No allocation, lock or log.
    void applyFxKeys(int trackId, double frameTick, std::vector<VisualEffect>& chain) const;

    // ── Motion view: Masks and Parent (render thread) ───────────────────────
    // The track's masks at the timeline tick into a FIXED-capacity frame: no
    // allocation, lock or log. Scalars (feather, expansion, opacity) follow
    // their keys or hold the base, then are clamped into the schema clamps.
    // The shape follows its shape keys (R14): before the first key the first
    // key's path, at / after the last the last's, between two keys every
    // vertex and tangent lerps by the LEAVING key's blend factor (Hold 0,
    // Linear u, EaseOut, Bezier with its handles; a Bezier factor may
    // overshoot). Shape keys are evaluated at the frame tick only (the cell's
    // motion blurs the mask). `out.count` = 0 for a track with no masks (or a
    // miss). Returns out.count > 0.
    bool masksAt(int trackId, double frameTick, MaskFrame& out) const;

    // ── Clones: Trail clones (render thread) ────────────────────────────────
    // The Trail clones of a source: trails[first, first + count), farthest
    // delay first. count 0 for a track with none (nearly every track).
    // Binary search; no allocation.
    void trailsOf(int sourceTrackId, std::size_t& first, std::size_t& count) const;
    // A Trail's opacity at the timeline tick (keys, else the base), in [0, 1].
    double trailOpacityAt(const TrailEntry& t, double frameTick) const;

    // The track's resolved parent (-1 = none / dangling / self).
    int parentOf(int trackId) const;

    // The track's ancestors, NEAREST FIRST, into `out` (at most
    // motionschema::kMaxParentDepth = 4). The walk stops at a track with no
    // (resolved) parent, at the depth cap, or before an id already seen (the
    // track itself included), so a cycle in damaged data ends the chain
    // instead of looping. Returns the count. Binary searches only.
    int parentChain(int trackId, int (&out)[motionschema::kMaxParentDepth]) const;

    struct Counts {
        int tracks = 0, roamNonIdentity = 0;
        int clips = 0, clipLensNonIdentity = 0;
        int sources = 0, sourceLensNonIdentity = 0;
        int keys = 0;   // compiled keys across every curve
        int noteNudge = 0, noteOwn = 0;   // per-note overrides (per track placement)
        int sweepTracks = 0;              // tracks with at least one Sweep key (P11)
        int masks = 0;                    // compiled masks across every track (Motion view)
        int maskTracks = 0;               // tracks with at least one mask
        int parentedTracks = 0;           // tracks with a resolved parent
        int trails = 0;                   // Trail clones with a live source (Clones)
        bool operator==(const Counts& o) const {
            return tracks == o.tracks && roamNonIdentity == o.roamNonIdentity
                && clips == o.clips && clipLensNonIdentity == o.clipLensNonIdentity
                && sources == o.sources && sourceLensNonIdentity == o.sourceLensNonIdentity
                && keys == o.keys && noteNudge == o.noteNudge && noteOwn == o.noteOwn
                && sweepTracks == o.sweepTracks && masks == o.masks
                && maskTracks == o.maskTracks && parentedTracks == o.parentedTracks
                && trails == o.trails;
        }
        bool operator!=(const Counts& o) const { return !(*this == o); }
    };
    Counts counts() const;
};

// Message thread only (allocates). Caller holds whatever lock guards the
// timeline for reading.
std::shared_ptr<const LensRoamSnapshot> buildLensRoamSnapshot(const Timeline& timeline);
