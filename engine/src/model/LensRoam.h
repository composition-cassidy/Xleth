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
// Storage (spec "Storage"):
//   Clip Track event          Clip::lens            LensTrack {base, keys}
//   Pattern Track source      TrackInfo::trackLens  regionId -> LensTrack {base, hitCurve}
//                             (the {trackId, regionId} key: the map lives on the track)
//   Track                     TrackInfo::roam       RoamTrack {base, keys}
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
// `interp` shapes the segment LEAVING the key (Hold | Linear | EaseOut; see
// KeyCurve.h). P7 replaced P1's never-evaluated bezier handles with it; a
// stored key without "interp" loads as Linear, which is what P1's default
// handles described.
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
enum class RoamChannel : uint8_t { OffsetX = 0, OffsetY = 1, Scale = 2, RotationDeg = 3 };
inline constexpr int kLensRoamChannels = 4;   // both enums have exactly four

template <typename Channel>
struct LensRoamKey {
    Channel                 channel{};
    KeyAnchor               anchor = KeyAnchor::Origin;
    double                  pos    = 0.0;
    double                  value  = 0.0;
    xleth::keycurve::Interp interp = xleth::keycurve::Interp::Linear;
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
    // (saved with that trackLens entry). A clip lens and a roam are not
    // note-relative: they ignore it and never save it.
    xleth::keycurve::NoteZones zones;
};

using LensTrack = KeyedParams<LensParams, LensKey>;
using RoamTrack = KeyedParams<RoamParams, RoamKey>;

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

// Exact compares (channel, anchor, pos, value, interp, in stored order): what
// an edit command uses to decide whether it changes anything.
template <typename Channel>
inline bool operator==(const LensRoamKey<Channel>& a, const LensRoamKey<Channel>& b) {
    return a.channel == b.channel && a.anchor == b.anchor && a.pos == b.pos
        && a.value == b.value && a.interp == b.interp;
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
const char* shortNoteRuleToString(xleth::keycurve::ShortNoteRule r);
nlohmann::json             noteZonesToJson(const xleth::keycurve::NoteZones& z);
xleth::keycurve::NoteZones noteZonesFromJson(const nlohmann::json& j);

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

    std::vector<TrackEntry>           tracks;     // ascending trackId
    std::vector<ClipEntry>            clips;      // ascending clipId
    std::vector<SourceEntry>          sources;    // ascending (trackId, regionId)
    std::vector<OverrideEntry>        overrides;  // ascending (trackId, patternId, noteId)
    std::vector<xleth::keycurve::Key> keys;       // every compiled key (see KeyRun)

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
    LensParams lensForEventAt(int trackId, int clipId, int regionId, const EventClock& clock,
                              const NoteRef& note = NoteRef{}) const;

    // The override entry for one note on one track, or null (Follow).
    const OverrideEntry* overrideFor(int trackId, int patternId, int noteId) const;

    // The track's Roam, keyed channels at the timeline tick.
    RoamParams roamAt(int trackId, double frameTick) const;

    struct Counts {
        int tracks = 0, roamNonIdentity = 0;
        int clips = 0, clipLensNonIdentity = 0;
        int sources = 0, sourceLensNonIdentity = 0;
        int keys = 0;   // compiled keys across every curve
        int noteNudge = 0, noteOwn = 0;   // per-note overrides (per track placement)
        bool operator==(const Counts& o) const {
            return tracks == o.tracks && roamNonIdentity == o.roamNonIdentity
                && clips == o.clips && clipLensNonIdentity == o.clipLensNonIdentity
                && sources == o.sources && sourceLensNonIdentity == o.sourceLensNonIdentity
                && keys == o.keys && noteNudge == o.noteNudge && noteOwn == o.noteOwn;
        }
        bool operator!=(const Counts& o) const { return !(*this == o); }
    };
    Counts counts() const;
};

// Message thread only (allocates). Caller holds whatever lock guards the
// timeline for reading.
std::shared_ptr<const LensRoamSnapshot> buildLensRoamSnapshot(const Timeline& timeline);
