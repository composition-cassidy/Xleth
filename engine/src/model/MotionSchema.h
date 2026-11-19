#pragma once

// ─── MotionSchema: the engine's view of the ONE motion property schema ───────
// docs/XLETH_MOTION_VIEW_DESIGN.md section 4.
//
// ui/src/motion/motionSchema.json is the single definition of every motion
// property (id, group, owner, channel, label, type, unit, identity, range,
// clamp, log, animatable, time base, blend, engineIndex, options) plus the
// `limits`. scripts/generate-motion-schema.js turns it into the X-macro lists
// in MotionSchema.generated.inc (checked in; ui/src/motion/motionSchema.test.js
// fails when it is stale). This header expands those lists into constexpr
// tables and lookups, so engine code never re-declares a channel list, a
// range, an identity or a cap:
//
//   motionschema::motionProperty("mask.feather")->clampHi     // 1.0
//   motionschema::optionIndex("mask.mode", "Subtract")         // 1
//   motionschema::kMaxMasksPerTrack                            // 8
//
// The pre-schema enums (LensChannel, RoamChannel in model/LensRoam.h) stay as
// they are; test_lens_roam asserts their order, names and identities match
// this table. Everything NEW (Mask channels, caps, strict mask parsing, mask
// identities and clamps) reads it from here.
//
// Pure, header-only, constexpr, no allocation: safe on every thread.

#include <cstdint>

namespace motionschema {

enum class PropType : uint8_t { Scalar, Enum, Bool, Shape, MotionBlur, Color };
enum class TimeBase : uint8_t { Static, Event, Note, Timeline };
enum class Blend    : uint8_t { Absolute, Multiply, Add };

struct Property {
    const char* id;          // "roam.offsetX"
    const char* group;       // "lens" | "roam" | "mask" | "sweep"
    const char* owner;       // "clip" | "source" | "track" | "mask" | "project"
    const char* channel;     // the JSON / key channel name ("offsetX")
    const char* label;       // UI label (sentence case)
    PropType    type;
    const char* unit;        // "" for non-scalars
    double      identity;    // scalar identity; an enum's identity option index (0)
    double      rangeLo;     // the UI's soft range
    double      rangeHi;
    bool        hasClamp;    // hard clamp the engine enforces
    double      clampLo;
    double      clampHi;
    bool        logScale;
    bool        animatable;
    TimeBase    timeBase;
    Blend       blend;
    int         engineIndex; // the engine channel index (-1 = not a keyed channel)

    // v clamped into the schema's hard clamp (unchanged when there is none).
    constexpr double clamp(double v) const {
        if (!hasClamp) return v;
        return v < clampLo ? clampLo : (v > clampHi ? clampHi : v);
    }
    // Inside the hard clamp (true when there is none). NaN is never inside.
    constexpr bool inClamp(double v) const {
        if (v != v) return false;
        return !hasClamp || (v >= clampLo && v <= clampHi);
    }
};

struct Option {
    const char* propId;
    int         index;
    const char* name;
};

// ── Tables (expanded from the generated X-macro lists) ───────────────────────

#define XLETH_MOTION_SCHEMA_VERSION(v) inline constexpr int kSchemaVersion = v;
#include "MotionSchema.generated.inc"

inline constexpr Property kProperties[] = {
#define XLETH_MOTION_PROP(id, group, owner, channel, label, type, unit, identity, rangeLo, rangeHi, \
                          hasClamp, clampLo, clampHi, logScale, animatable, timeBase, blend,       \
                          engineIndex)                                                             \
    Property{ id, group, owner, channel, label, PropType::type, unit, identity, rangeLo, rangeHi,  \
              hasClamp, clampLo, clampHi, logScale, animatable, TimeBase::timeBase, Blend::blend,  \
              engineIndex },
#include "MotionSchema.generated.inc"
};

inline constexpr Option kOptions[] = {
#define XLETH_MOTION_OPTION(propId, index, name) Option{ propId, index, name },
#include "MotionSchema.generated.inc"
};

// limits: one constexpr int per schema limit, under its schema name.
namespace limits {
#define XLETH_MOTION_LIMIT(name, value) inline constexpr int name = value;
#include "MotionSchema.generated.inc"
} // namespace limits

inline constexpr int kPropertyCount = static_cast<int>(sizeof(kProperties) / sizeof(kProperties[0]));
inline constexpr int kOptionCount   = static_cast<int>(sizeof(kOptions) / sizeof(kOptions[0]));

// The caps (design R15) under engine-style names.
inline constexpr int kMaxParentDepth          = limits::maxParentDepth;           // 4 ancestors
inline constexpr int kMaxMasksPerTrack        = limits::maxMasksPerTrack;         // 8
inline constexpr int kMaxVerticesPerMask      = limits::maxVerticesPerMask;       // 32
inline constexpr int kMinVerticesPerMask      = limits::minVerticesPerMask;       // 3
inline constexpr int kMaxMaskVerticesPerTrack = limits::maxMaskVerticesPerTrack;  // 64

// ── Lookups (constexpr; a miss is nullptr / -1) ──────────────────────────────

constexpr bool streq(const char* a, const char* b) {
    if (!a || !b) return a == b;
    while (*a && *a == *b) { ++a; ++b; }
    return *a == *b;
}

constexpr const Property* motionProperty(const char* id) {
    for (const Property& p : kProperties)
        if (streq(p.id, id)) return &p;
    return nullptr;
}

// The keyed property of `group`/`owner` driving engine channel `engineIndex`
// (e.g. ("mask", "mask", 0) -> mask.feather).
constexpr const Property* propertyByEngineIndex(const char* group, const char* owner, int engineIndex) {
    for (const Property& p : kProperties)
        if (p.engineIndex == engineIndex && streq(p.group, group) && streq(p.owner, owner)) return &p;
    return nullptr;
}

// The keyed property of `group`/`owner` whose channel name is `channel`.
constexpr const Property* propertyByChannel(const char* group, const char* owner, const char* channel) {
    for (const Property& p : kProperties)
        if (streq(p.channel, channel) && streq(p.group, group) && streq(p.owner, owner)) return &p;
    return nullptr;
}

constexpr int optionCount(const char* propId) {
    int n = 0;
    for (const Option& o : kOptions)
        if (streq(o.propId, propId)) ++n;
    return n;
}

constexpr int optionIndex(const char* propId, const char* name) {
    for (const Option& o : kOptions)
        if (streq(o.propId, propId) && streq(o.name, name)) return o.index;
    return -1;
}

constexpr const char* optionName(const char* propId, int index) {
    for (const Option& o : kOptions)
        if (streq(o.propId, propId) && o.index == index) return o.name;
    return nullptr;
}

// Compile-time guards: the engine code below relies on these entries.
static_assert(motionProperty("mask.feather")   != nullptr, "schema: mask.feather");
static_assert(motionProperty("mask.expansion") != nullptr, "schema: mask.expansion");
static_assert(motionProperty("mask.opacity")   != nullptr, "schema: mask.opacity");
static_assert(motionProperty("mask.shape")     != nullptr, "schema: mask.shape");
static_assert(motionProperty("mask.mode")      != nullptr, "schema: mask.mode");
static_assert(optionCount("mask.mode") == 3 && optionCount("mask.shape") == 3, "schema: mask options");
static_assert(kMaxMasksPerTrack > 0 && kMaxMasksPerTrack <= 255, "MaskFrame counts masks in a uint8_t");
static_assert(kMaxVerticesPerMask <= 255, "MaskFrameEntry counts vertices in a uint8_t");
static_assert(kMinVerticesPerMask >= 3 && kMinVerticesPerMask <= kMaxVerticesPerMask, "vertex caps");
static_assert(kMaxMaskVerticesPerTrack <= 65535, "MaskFrameEntry addresses vertices with a uint16_t");

} // namespace motionschema
