#pragma once

// ─── Hit curve presets: the ONE data file ────────────────────────────────────
// docs/XLETH_LENS_ROAM_SPEC.md, "Hit curve presets". Every preset's keys live
// here and nowhere else: the engine applies them (timeline_applyHitPreset ->
// SetHitCurveCommand), and any UI lists them through the engine, never from a
// copy. Exactly the four presets and the keys the spec defines.
//
// Zones: the spec's defaults, head 120 ticks (1/32) and tail 240 ticks (1/16).
// The keys are written in those zones, so applying a preset sets the source's
// head/tail lengths to them (its Squash/Cut rule is the user's and is kept).
//
// Keys are a LAYER on the source's base Lens (zoom multiplies; centre and
// rotation add), so "zoom 1.35 -> 1.00" punches the framing the user set.
//
// Interp (the segment LEAVING a key; see model/KeyCurve.h): the spec marks
// Punch "ease out". The same punch-then-settle segment of "Punch + drift" eases
// out too; every other segment is Linear. The last key's interp is never read.

#include <cstddef>
#include <cstring>
#include <vector>

#include "KeyCurve.h"
#include "LensRoam.h"

namespace lensroam {

struct HitPresetKey {
    LensChannel             channel;
    KeyAnchor               anchor;   // Head ticks | Body fraction | Tail ticks
    double                  pos;
    double                  value;
    xleth::keycurve::Interp interp;
};

struct HitPreset {
    const char*         name;
    const HitPresetKey* keys;
    std::size_t         count;
};

inline constexpr double kHitPresetHeadTicks = 120.0;   // 1/32
inline constexpr double kHitPresetTailTicks = 240.0;   // 1/16

namespace hitpreset_data {
using xleth::keycurve::Interp;
constexpr LensChannel Z = LensChannel::Zoom;

// Punch: Head 0 zoom 1.35 -> Head 120 zoom 1.00 (ease out).
inline constexpr HitPresetKey kPunch[] = {
    { Z, KeyAnchor::Head, 0.0,   1.35, Interp::EaseOut },
    { Z, KeyAnchor::Head, 120.0, 1.00, Interp::Linear  },
};

// Punch + drift: Head 0 zoom 1.35 -> Head 120 zoom 1.08 -> Tail 240 zoom 1.20
// -> Tail 0 zoom 1.00.
inline constexpr HitPresetKey kPunchDrift[] = {
    { Z, KeyAnchor::Head, 0.0,   1.35, Interp::EaseOut },
    { Z, KeyAnchor::Head, 120.0, 1.08, Interp::Linear  },
    { Z, KeyAnchor::Tail, 240.0, 1.20, Interp::Linear  },
    { Z, KeyAnchor::Tail, 0.0,   1.00, Interp::Linear  },
};

// Zoom pulse: Head 0 zoom 1.00 -> Body 0.5 zoom 1.15 -> Tail 0 zoom 1.00.
inline constexpr HitPresetKey kZoomPulse[] = {
    { Z, KeyAnchor::Head, 0.0, 1.00, Interp::Linear },
    { Z, KeyAnchor::Body, 0.5, 1.15, Interp::Linear },
    { Z, KeyAnchor::Tail, 0.0, 1.00, Interp::Linear },
};
} // namespace hitpreset_data

// In the spec's order. Still: no keys.
inline constexpr HitPreset kHitPresets[] = {
    { "Still",         nullptr,                    0 },
    { "Punch",         hitpreset_data::kPunch,     sizeof(hitpreset_data::kPunch)      / sizeof(HitPresetKey) },
    { "Punch + drift", hitpreset_data::kPunchDrift, sizeof(hitpreset_data::kPunchDrift) / sizeof(HitPresetKey) },
    { "Zoom pulse",    hitpreset_data::kZoomPulse, sizeof(hitpreset_data::kZoomPulse)  / sizeof(HitPresetKey) },
};
inline constexpr std::size_t kHitPresetCount = sizeof(kHitPresets) / sizeof(HitPreset);

// Exact, case-sensitive name match (the names are final). Null when unknown.
inline const HitPreset* findHitPreset(const char* name) {
    if (!name) return nullptr;
    for (const HitPreset& p : kHitPresets)
        if (std::strcmp(p.name, name) == 0) return &p;
    return nullptr;
}

// A preset's keys in the stored (LensKey) form a hit curve holds.
inline std::vector<LensKey> hitPresetKeys(const HitPreset& p) {
    std::vector<LensKey> out;
    out.reserve(p.count);
    for (std::size_t i = 0; i < p.count; ++i) {
        LensKey k;
        k.channel = p.keys[i].channel;
        k.anchor  = p.keys[i].anchor;
        k.pos     = p.keys[i].pos;
        k.value   = p.keys[i].value;
        k.interp  = p.keys[i].interp;
        out.push_back(k);
    }
    return out;
}

// The zones a preset's keys are written in, keeping `current`'s short-note rule.
inline xleth::keycurve::NoteZones hitPresetZones(const xleth::keycurve::NoteZones& current) {
    xleth::keycurve::NoteZones z = current;
    z.headTicks = kHitPresetHeadTicks;
    z.tailTicks = kHitPresetTailTicks;
    return z;
}

} // namespace lensroam
