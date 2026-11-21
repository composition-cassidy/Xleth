#pragma once

// ─── Clones (docs/XLETH_CLONE_SPEC.md) ───────────────────────────────────────
// A Clone is an extra, VIDEO-ONLY cell driven by a Pattern Track (its source).
// Two kinds:
//
//   Voice clone  plays the notes the source cannot (polyphony). Voice 0 is the
//                source track itself; Voice 1, 2, ... are its Voice clones in
//                track order. Owns everything a video cell owns (grid cell,
//                Roam, Masks, Parent, layer, visual effects, flip state). Its
//                Lens is the source's Track Lens (Linked) or its own (Own).
//   Trail clone  replays the source's whole cell result `delayTicks` later,
//                tinted, faded and offset by its own (added) Roam. No grid cell
//                and no Lens of its own.
//
// Clones never make sound: the source's sampler plays every note as before.
// They are tracks (TrackInfo with cloneOf >= 0), so undo, save/load, the track
// list and Motion view treat them like any other track.
//
// Voice assignment (assignVoices below) is DERIVED from the pattern alone, so
// seeking, preview and export always agree. Only the per-note pin
// (PatternNote::voicePin) is stored; the assignment is recomputed on every
// event build (message thread), never on the render or audio thread.

#include <cstdint>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "KeyCurve.h"

class Timeline;
struct Pattern;
struct PatternNote;
struct TrackInfo;
struct TrackLayout;

enum class CloneKind : uint8_t { Voice = 0, Trail = 1 };
enum class CloneLensMode : uint8_t { Linked = 0, Own = 1 };

// PatternNote::voicePin: -1 = Auto (the default, absent on disk), 0 = the
// source cell, k >= 1 = the k-th Voice clone. Pins are voice NUMBERS: deleting
// or reordering Voice clones rewrites them so a pinned note stays with the
// Clone it was pinned to (see clones::rewritePinsFor*). A pin to a voice that
// does not exist (more than the track has) plays as Auto.
inline constexpr int kVoicePinAuto = -1;
inline constexpr int kMaxVoicePin  = 64;   // sanity cap on stored pins

// A Trail clone's own settings. Its added Roam lives in TrackInfo::roam (only
// the offset is applied, on top of the delayed source position).
struct TrailSettings {
    double   delayTicks = 480.0;        // 1/8 at 960 PPQ; > 0
    uint32_t tintRgb    = 0xFFFFFFu;    // multiply colour; white = no tint
    double   opacity    = 1.0;          // base, [0, 1]
    // Opacity keys: timeline-absolute ticks, ABSOLUTE values (a keyed curve
    // ignores the base, like Roam keys). position.base is TimelineTicks.
    std::vector<xleth::keycurve::Key> opacityKeys;

    bool operator==(const TrailSettings& o) const;
    bool operator!=(const TrailSettings& o) const { return !(*this == o); }
};

namespace clones {

inline constexpr double kMinTrailDelayTicks = 1.0;
inline constexpr double kMaxTrailDelayTicks = 960.0 * 4.0 * 64.0;   // 64 bars

const char* cloneKindToString(CloneKind k);
bool        cloneKindFromString(const std::string& s, CloneKind& out);
const char* cloneLensModeToString(CloneLensMode m);
bool        cloneLensModeFromString(const std::string& s, CloneLensMode& out);

// "#RRGGBB" (upper case) <-> 0xRRGGBB. The parser accepts "#rrggbb" / "#RRGGBB"
// only; returns false otherwise and leaves `out` alone.
std::string tintToString(uint32_t rgb);
bool        tintFromString(const std::string& s, uint32_t& out);

// Opacity keys as [{pos, value, interp, bez?}]. Tolerant reader: a key with a
// non-finite / missing pos or value is dropped; values are clamped to [0, 1];
// keys are sorted by pos (stable).
nlohmann::json                    opacityKeysToJson(const std::vector<xleth::keycurve::Key>& keys);
std::vector<xleth::keycurve::Key> opacityKeysFromJson(const nlohmann::json& arr);

// The Trail's opacity at a timeline tick (keys if any, else the base), in [0, 1].
// Allocates nothing; message or render thread (the render thread reads the
// compiled copy in the LensRoamSnapshot, which is built by the same function).
double trailOpacityAt(const TrailSettings& t, double tick);

// Clone fields on a track's JSON (written only when the track is a Clone, so
// every other track saves exactly as before). Tolerant reader.
void cloneFieldsToJson(nlohmann::json& j, const TrackInfo& t);
void cloneFieldsFromJson(const nlohmann::json& j, TrackInfo& t);

// ── Topology (message thread) ────────────────────────────────────────────────
// A track's clones in track order (order, then id). Voice clones are voices
// 1, 2, ... in that order.
std::vector<const TrackInfo*> voiceClonesOf(const Timeline& timeline, int sourceTrackId);
std::vector<const TrackInfo*> trailClonesOf(const Timeline& timeline, int sourceTrackId);
std::vector<const TrackInfo*> allClonesOf(const Timeline& timeline, int sourceTrackId);
// The source a clone belongs to, or nullptr (not a clone / dangling source).
const TrackInfo* sourceOf(const Timeline& timeline, const TrackInfo& clone);
// The voice number of a Voice clone (1-based), or 0 when it is not one.
int voiceNumberOf(const Timeline& timeline, const TrackInfo& clone);

// ── Voice assignment ─────────────────────────────────────────────────────────
// For each note of `pattern` (index-aligned with pattern.notes): the voice that
// plays it, 0 .. voiceCloneCount, and whether it OVERFLOWED (more notes sound
// at once than there are voices; it plays on the source, voice 0, the way a
// Pattern Track always has).
//
// Rules (spec "How notes are assigned to voices"):
//   - Decided from the pattern alone; no chord window, no tolerance.
//   - Pinned notes (0 <= pin <= voiceCloneCount) are placed first.
//   - Auto notes in start order; on the same tick, highest pitch first (then
//     note id, then index): each takes the LOWEST-numbered voice that is free
//     for its whole span [start, end), i.e. no note already on that voice
//     overlaps it. A note that ends exactly where another starts does not
//     overlap it.
//   - No free voice: overflow (voice 0, overflow = true). An overflow note does
//     not occupy a voice.
//   - Slide notes and notes with no length spawn no cell: voice 0, never
//     overflow, and they occupy nothing.
// With voiceCloneCount == 0 every note is voice 0 and nothing overflows.
struct VoiceSlot {
    int  voice    = 0;
    bool overflow = false;
};
std::vector<VoiceSlot> assignVoices(const Pattern& pattern, int voiceCloneCount);

// Same, from plain note spans (the unit-test / JS-parity entry point).
struct VoiceNote {
    int64_t start = 0, end = 0;   // ticks inside the pattern; end > start or the note is inert
    int     pitch = 60;
    int     id    = 0;
    int     pin   = kVoicePinAuto;
    bool    inert = false;        // slide note: spawns no cell
};
std::vector<VoiceSlot> assignVoices(const std::vector<VoiceNote>& notes, int voiceCloneCount);

// ── Pin rewrites (message thread; pure) ──────────────────────────────────────
// Deleting voice `removedVoice` (1-based): its pins go Auto, higher pins move
// down by one. Returns true when any note changed.
bool rewritePinsForRemovedVoice(std::vector<PatternNote>& notes, int removedVoice);
// Reordering: newVoiceOfOld[k] = the new number of old voice k (index 0 unused,
// 0 -> 0). Pins beyond the table are left alone. Returns true when any changed.
bool rewritePinsForReorder(std::vector<PatternNote>& notes, const std::vector<int>& newVoiceOfOld);

// The patterns a source plays (every block on the track), each once, ascending id.
std::vector<int> patternsPlayedBy(const Timeline& timeline, int trackId);

// ── Track list ───────────────────────────────────────────────────────────────
// Clones always sit directly under their source, in the source's container
// (the root list or the source's folder), in their CURRENT order (the
// timeline's track order now, whatever the incoming layout says: a Voice
// clone's place is its voice number, and renumbering must rewrite pins, which
// only ReorderClonesCommand does). Every layout write that comes from an edit
// (Timeline::setTrackLayout / setTrackOrder) goes through this, so dragging a
// source carries its Clones. A Clone whose source is gone stays where it is.
TrackLayout withClonesAfterSources(const TrackLayout& in, const Timeline& timeline);
// The same for a flat id list (setTrackOrder).
std::vector<int> withClonesAfterSources(const std::vector<int>& flat, const Timeline& timeline);

} // namespace clones
