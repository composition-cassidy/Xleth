#pragma once

#include <nlohmann/json.hpp>

#include <cstdint>
#include <string>
#include <variant>
#include <vector>

// ─── Sample Sandbox — op descriptors ──────────────────────────────────────────
//
// One SandboxOp = one DSP transform with parameters. A layer's stack is an
// ordered list of them, evaluated source → op[0] → op[1] → … → output.
//
// ── Why params are a std::variant of typed structs, not a float array ─────────
// VisualEffect (model/TimelineTypes.h) stores its parameters as `float
// params[16]` reinterpreted per effect type. That layout is hand-duplicated in
// the HLSL constant buffers, GridCompositor and the React param panel with no
// registry to keep them honest — the comment there says so explicitly, four
// times. Adding a parameter means editing four files and hoping.
//
// The Sandbox does not repeat that. Every op has its own named struct, the
// variant alternative order is locked to the SandboxOpType enum order (asserted
// below), and the ONE registry is the opTypeName/opTypeFromName pair plus the
// visit sites in SandboxOp.cpp. A new op that forgets a site fails to compile
// rather than silently reading someone else's parameter.
//
// ── Sample-rate domain ───────────────────────────────────────────────────────
// Every index and length in these params is in ENGINE-BUFFER SAMPLES, i.e. the
// rate the source buffer is actually stored at (SampleBank::SampleInfo::
// bufferSampleRate). Nothing here assumes 44100 or 48000, and nothing here is
// in seconds or ticks — a stack authored against a 48 kHz bake must not silently
// mean something else after a re-bake at another rate, so SandboxRenderer folds
// the rate into its cache key instead of letting the params drift.

namespace xleth::sandbox {

// Bumped when the serialized shape of a stack changes incompatibly. Written on
// every stack, read back with a default of 1 so a pre-versioning file (there
// are none in the wild yet, but the read path costs nothing) still loads.
//
//   1 — SB-1..SB-5. Layers carried only sourceBufferId (a SampleBank id).
//   2 — SB-6. Layers additionally carry a DURABLE source reference
//       (sourceFilePath / sourceStartTime / sourceEndTime). A v1 workspace
//       reads back with an empty path, which reloads as an unbound layer
//       (sourceBufferId = -1) whose op-stack is nonetheless intact — the
//       stack was never the part that could not be re-resolved.
inline constexpr int kSandboxStackVersion = 2;

// ─── SandboxOpType ────────────────────────────────────────────────────────────
// Order is load-bearing: it must match the alternative order of SandboxOpParams
// (static_assert'ed at the bottom of this header). Values are explicit so the
// enum can be reordered only deliberately — though note the JSON writes the
// NAME, not the number, so a reorder is not a file-format migration.

enum class SandboxOpType : int {
    Trim      = 0,
    Cut       = 1,
    Paste     = 2,
    Splice    = 3,
    Reverse   = 4,
    Fade      = 5,
    Gain      = 6,
    Crossfade = 7,
    Pitch     = 8,
    Stretch   = 9,
};

inline constexpr int kSandboxOpTypeCount = 10;

// ─── Shared enums ─────────────────────────────────────────────────────────────

// Curve applied across a fade or crossfade window.
enum class SandboxFadeShape : int {
    Linear      = 0,   // gain = t
    EqualPower  = 1,   // gain = sin(t·π/2) — constant power, the crossfade default
    Exponential = 2,   // gain = t²        — slow start, fast finish
    Logarithmic = 3,   // gain = 1-(1-t)²  — fast start, slow finish
    SCurve      = 4,   // gain = t²(3-2t)  — smoothstep, click-free at both ends
    Hann        = 5,   // gain = 0.5(1-cos(t·π)) — same raised-cosine ramp as
                       // dsp::DeclickEnvelope, so a Crossfade seam declicks
                       // exactly like the sampler's trim boundaries do.
};

// What happens to the material after an edit point.
enum class SandboxRippleMode : int {
    Ripple = 0,   // close the gap — everything downstream slides left
    Gap    = 1,   // leave silence in place — buffer length unchanged
};

// ─── Per-op parameter structs ─────────────────────────────────────────────────
//
// Convention shared by every range-carrying op: `endSample < 0` means "to the
// end of the buffer". That keeps a range op meaningful after an upstream op
// changes the length, which is the whole point of a re-evaluable stack —
// a trim that hard-coded the old end would silently truncate after a paste.

// TRIM — keep [startSample, endSample), discard the rest.
struct TrimParams {
    int64_t startSample = 0;
    int64_t endSample   = -1;

    bool operator==(const TrimParams&) const = default;
};

// CUT — remove [startSample, endSample). Ripple closes the gap; Gap replaces the
// range with silence and preserves the buffer length.
struct CutParams {
    int64_t           startSample = 0;
    int64_t           endSample   = -1;
    SandboxRippleMode mode        = SandboxRippleMode::Ripple;

    bool operator==(const CutParams&) const = default;
};

// PASTE — insert (or overwrite with) clipboard material at atSample.
//
// clipboardId resolves against SandboxRenderer's session-local clipboard store
// (SB-4). clipboardId == -1, or an id that no longer resolves (e.g. a stack
// reloaded from a project file in a later session — the clipboard is NOT
// persisted), means "no material": the op inserts/overwrites
// clipboardLengthSamples of SILENCE instead. That is also how INSERT SILENCE
// is expressed — there is no separate op type for it. clipboardLengthSamples
// is always authoritative for length prediction (outputLength() needs it
// without touching a buffer), so a stale reference degrades gracefully to
// silence of the same length rather than desyncing the stack's predicted
// length from its actual render.
struct PasteParams {
    int64_t atSample              = 0;
    int     clipboardId           = -1;   // -1 = nothing on the clipboard
    int64_t clipboardLengthSamples = 0;
    bool    insert                = true; // false = overwrite in place

    bool operator==(const PasteParams&) const = default;
};

// SPLICE — split at atSample and swap the two halves (tail moves in front of
// head). Ripple abuts them with no gap; Gap inserts gapSamples of silence at
// the new seam between the (relocated) tail and head.
struct SpliceParams {
    int64_t           atSample   = 0;
    SandboxRippleMode mode       = SandboxRippleMode::Ripple;
    int64_t           gapSamples = 0;   // only consulted when mode == Gap

    bool operator==(const SpliceParams&) const = default;
};

// REVERSE — reverse the material in [startSample, endSample) in place.
struct ReverseParams {
    int64_t startSample = 0;
    int64_t endSample   = -1;

    bool operator==(const ReverseParams&) const = default;
};

// FADE — ramp gain across [startSample, startSample + lengthSamples).
// fadeIn ramps 0→1, otherwise 1→0.
struct FadeParams {
    int64_t          startSample   = 0;
    int64_t          lengthSamples = 0;
    SandboxFadeShape shape         = SandboxFadeShape::Linear;
    bool             fadeIn        = true;

    bool operator==(const FadeParams&) const = default;
};

// GAIN — scale [startSample, endSample) by gainDb, or normalize that range so
// its peak lands on targetPeakDb. Normalize ignores gainDb.
struct GainParams {
    int64_t startSample  = 0;
    int64_t endSample    = -1;
    double  gainDb       = 0.0;
    bool    normalize    = false;
    double  targetPeakDb = 0.0;

    bool operator==(const GainParams&) const = default;
};

// CROSSFADE — declick a seam at atSample by dipping gain toward silence and
// back across lengthSamples (half before the seam, half after), the same
// technique dsp::DeclickEnvelope uses at a clip's hard start/end boundaries,
// just centred on an INTERIOR point instead of the buffer edge. Because a
// single-buffer op stack has no second signal to blend against once upstream
// material has been cut away, this "declicks toward silence" rather than
// true-crossfading two waveforms — which is exactly what makes it re-runnable
// at any point in the stack, including seams the buffer no longer remembers
// the far side of. Default shape is Hann to match the sampler exactly.
struct CrossfadeParams {
    int64_t          atSample      = 0;
    int64_t          lengthSamples = 0;
    SandboxFadeShape shape         = SandboxFadeShape::Hann;

    bool operator==(const CrossfadeParams&) const = default;
};

// PITCH — shift by cents without changing length. STUB in SB-1: pitch/stretch
// DSP routes through the existing stretch engines, wired in a later phase.
struct PitchParams {
    double cents           = 0.0;
    bool   formantPreserve = false;

    bool operator==(const PitchParams&) const = default;
};

// STRETCH — scale length by ratio without changing pitch. STUB in SB-1.
// `algorithm` mirrors StretchMethod (model/TimelineTypes.h); 0 = engine default.
struct StretchParams {
    double ratio     = 1.0;
    int    algorithm = 0;

    bool operator==(const StretchParams&) const = default;
};

// ─── SandboxOpParams ──────────────────────────────────────────────────────────
// Alternative order MUST match SandboxOpType — see the static_assert below.

using SandboxOpParams = std::variant<
    TrimParams,       // 0  Trim
    CutParams,        // 1  Cut
    PasteParams,      // 2  Paste
    SpliceParams,     // 3  Splice
    ReverseParams,    // 4  Reverse
    FadeParams,       // 5  Fade
    GainParams,       // 6  Gain
    CrossfadeParams,  // 7  Crossfade
    PitchParams,      // 8  Pitch
    StretchParams     // 9  Stretch
>;

static_assert(std::variant_size_v<SandboxOpParams> == kSandboxOpTypeCount,
              "SandboxOpParams must carry exactly one alternative per SandboxOpType");

// ─── SandboxOp ────────────────────────────────────────────────────────────────

struct SandboxOp {
    // Stable within its layer's stack. Survives reorder, so a UI selection or a
    // pending command reference stays valid across a drag. NOT part of the
    // content hash: two structurally identical stacks must share a cache entry
    // even if their ops were created in a different order.
    int id = 0;

    SandboxOpType   type = SandboxOpType::Gain;
    SandboxOpParams params = GainParams{};

    // false = bypassed. IS part of the content hash — bypassing changes output.
    bool enabled = true;

    // Set on every mutation, cleared by SandboxCore::clearDirty once the
    // renderer has published a buffer that accounts for this op. Render
    // bookkeeping only, so it is NOT part of the content hash: a re-render must
    // not miss a cache entry merely because the flag has not been cleared yet.
    bool dirty = true;

    // True once params.index() agrees with type. A hand-built op that sets one
    // without the other is malformed; deserialization repairs it by trusting
    // the type name and defaulting the params.
    bool consistent() const noexcept {
        return static_cast<int>(params.index()) == static_cast<int>(type);
    }

    // False for the ops whose DSP has not landed yet (Pitch, Stretch — deferred
    // to the phase that wires in the stretch engines). Paste/Splice/Crossfade
    // landed in SB-4. An unimplemented op is a PASS-THROUGH in the renderer,
    // never a silent partial edit — the UI is expected to badge it so
    // "nothing happened" reads as "not built yet" rather than as a bug.
    bool implemented() const noexcept;

    // False for op types that must never auto-trigger a render from a plain
    // stack edit — reserved for a future op heavy enough that running it on
    // every keystroke/drag tick would stall the UI (e.g. model separation).
    // True for every op type that exists today. The UI's auto-render
    // scheduler skips a layer whose stack contains an ENABLED op with
    // autoRender() == false, and that layer then requires the explicit
    // RE-RENDER fallback. Distinct from implemented(): an op can be
    // cheap-and-real (autoRender true) or unimplemented-and-cheap
    // (Pitch/Stretch — still auto-renders today, since a pass-through costs
    // nothing).
    bool autoRender() const noexcept;

    // Length this op produces from an input of `inputLength` samples, without
    // rendering. Bypassed and unimplemented ops return inputLength unchanged.
    int64_t outputLength(int64_t inputLength) const noexcept;

    // Deterministic 64-bit digest of type + params + enabled. Stable across
    // runs, builds and machines: fields are fed in explicitly (never as raw
    // struct bytes, whose padding is not guaranteed to be zeroed) and floats go
    // through their bit pattern.
    uint64_t contentHash() const noexcept;

    bool operator==(const SandboxOp&) const = default;
};

// ─── Registry ─────────────────────────────────────────────────────────────────
// The single source of truth for the type↔name mapping. JSON writes the NAME,
// so reordering the enum is not a file-format migration and an unknown name
// read from a newer file is a clean rejection rather than a wrong op.

const char*   opTypeName(SandboxOpType type) noexcept;
bool          opTypeFromName(const std::string& name, SandboxOpType& out) noexcept;

// Default-constructed params for `type`, with the variant alternative that
// matches it. Used by deserialization and by the UI's "add op" path.
SandboxOpParams defaultParamsFor(SandboxOpType type);

// ─── Stack helpers ────────────────────────────────────────────────────────────

// Digest of the first `count` ops of `ops`, chained. prefixHash(ops, i) is the
// identity of the audio produced after op i-1 has run, which is exactly what
// SandboxRenderer keys its per-prefix cache on: mutating op k leaves every
// prefix hash below k untouched, so the renderer re-runs ops k.. and no more.
//
// `count` is clamped to ops.size(). prefixHash(ops, 0) is the identity of the
// unmodified source.
uint64_t prefixHash(const std::vector<SandboxOp>& ops, size_t count) noexcept;

// Digest of the whole stack — prefixHash(ops, ops.size()).
uint64_t stackHash(const std::vector<SandboxOp>& ops) noexcept;

// Length the whole stack produces from `inputLength`, without rendering.
int64_t stackOutputLength(const std::vector<SandboxOp>& ops, int64_t inputLength) noexcept;

// ─── JSON ─────────────────────────────────────────────────────────────────────
// Round-trips losslessly. Op objects carry every field explicitly rather than
// omitting defaults: a stack is small, and an explicit shape means a future
// default change cannot retroactively alter a saved edit.

nlohmann::json opToJson(const SandboxOp& op);

// Returns false and leaves `out` untouched when the type name is unknown. A
// param that is missing or the wrong JSON type falls back to that param's
// default rather than aborting the load — one corrupt field must not cost the
// user the whole stack.
bool opFromJson(const nlohmann::json& j, SandboxOp& out);

// A whole stack, wrapped with its version:
//   { "sandboxStackVersion": 1, "ops": [ … ] }
nlohmann::json stackToJson(const std::vector<SandboxOp>& ops);

// Reads either the wrapper above or a bare array of ops. Unknown-type ops are
// SKIPPED (and reported via `skipped`) so a file written by a newer build
// degrades to "some ops missing" rather than "project will not open".
bool stackFromJson(const nlohmann::json& j,
                   std::vector<SandboxOp>& out,
                   int* versionOut = nullptr,
                   int* skipped    = nullptr);

} // namespace xleth::sandbox
