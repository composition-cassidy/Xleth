#pragma once

#include "sandbox/SandboxOp.h"

#include <functional>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

// ─── SandboxCore ──────────────────────────────────────────────────────────────
//
// The Sample Sandbox workspace: N layers, each binding one engine source buffer
// to its own ordered op-stack. Pure model — no JUCE, no audio, no buffers. The
// buffers live in SandboxRenderer (XlethEngineCore tier); this class owns only
// the description of what to do to them.
//
// That split is the reason the whole edit model is unit-testable without an
// audio device, and it is why SandboxCore sits in XlethEngineModel next to
// Timeline rather than beside MixEngine.
//
// ── Mutation discipline ──────────────────────────────────────────────────────
// The methods below are the RAW mutators. UI and RPC callers must NOT reach for
// them directly — every stack mutation goes through the commands in
// SandboxCommands.h so it lands on the UndoManager. The raw form is public
// because the commands need it, and because project load has to rebuild a
// workspace without pushing a hundred undo steps.
//
// ── Mix params are not ops ───────────────────────────────────────────────────
// Per-layer gain / pan / offset / mute / solo live on SandboxLayer, OUTSIDE the
// op-stack, and are applied when the layers are mixed into the composite (SB-5).
// Keeping them out of the stack is what lets a layer's rendered buffer stay
// cached while its level is dragged.
//
// Threading: main/message thread only, exactly like UndoManager. The renderer
// reads a COPY of a stack taken on this thread; it never holds a reference into
// SandboxCore.

namespace xleth::sandbox {

// ─── SandboxLayer ─────────────────────────────────────────────────────────────

struct SandboxLayer {
    int         id   = 0;
    std::string name;

    // SampleBank id of the source PCM this layer edits. -1 = unbound (a layer
    // can exist before its source finishes loading).
    int sourceBufferId = -1;

    // Rate the source buffer is stored at, carried so the renderer's cache key
    // and every sample index in the stack agree on a domain. 0 = unknown; the
    // renderer refuses to render a layer whose rate it has not been told, which
    // is deliberately louder than rendering at a guessed 44100.
    double bufferSampleRate = 0.0;

    // ── Durable source reference (SB-6) ──────────────────────────────────────
    // sourceBufferId is a SampleBank id, and SampleBank is NOT persisted with
    // the project: ids are minted fresh, in region order, on every load (see
    // project_load's regionToSampleMap_ rebuild). Persisting the id alone would
    // reopen a workspace pointing at whatever audio happened to take that slot.
    //
    // This triple is what a load actually re-resolves the buffer FROM — exactly
    // the arguments SampleBank::loadSampleFromSource takes, which is the same
    // call project load already uses to rebuild every region's audio. Empty
    // path = no durable reference (a layer opened over an in-memory asset such
    // as a composite bake): the layer reloads UNBOUND, sourceBufferId = -1,
    // with its op-stack fully intact. It is the audio binding that cannot be
    // recovered, never the edit.
    std::string sourceFilePath;
    double      sourceStartTime = 0.0;
    double      sourceEndTime   = 0.0;

    bool hasDurableSource() const { return !sourceFilePath.empty() && sourceEndTime > sourceStartTime; }

    std::vector<SandboxOp> ops;

    // ── Mix params — NOT part of the op-stack, NOT part of the stack hash ─────
    double  gainDb        = 0.0;
    double  pan           = 0.0;   // -1 = hard left, +1 = hard right
    int64_t offsetSamples = 0;     // positive delays this layer in the composite
    bool    muted         = false;
    bool    soloed        = false;

    // Monotonic within this layer. Never reused, so a stale UI reference to a
    // deleted op resolves to "gone" rather than to whatever took its slot.
    int nextOpId = 1;

    // Index of the first op whose result is not yet reflected in a published
    // render, or ops.size() when the layer is clean. This is what makes a param
    // tweak re-render downstream-only: the renderer starts from the deepest
    // cached prefix, and this tells the caller how much work that will be.
    size_t firstDirtyIndex() const;

    bool clean() const { return firstDirtyIndex() >= ops.size(); }

    // Digest of the whole stack. Combined with sourceBufferId + rate by the
    // renderer to key its cache.
    uint64_t stackHash() const { return xleth::sandbox::stackHash(ops); }

    // Position of `opId` in ops, or -1.
    int indexOfOp(int opId) const;

    const SandboxOp* findOp(int opId) const;
    SandboxOp*       findOp(int opId);
};

// ─── SandboxCore ──────────────────────────────────────────────────────────────

class SandboxCore {
public:
    SandboxCore() = default;

    // ── Layers ───────────────────────────────────────────────────────────────

    // Returns the new layer's id. `name` may be empty; the caller supplies a
    // display name, this class does not invent one. The trailing three
    // arguments are the DURABLE source reference (see SandboxLayer) and may be
    // omitted for a layer over an in-memory asset that has no file behind it.
    int addLayer(const std::string& name, int sourceBufferId, double bufferSampleRate,
                 const std::string& sourceFilePath = {},
                 double sourceStartTime = 0.0, double sourceEndTime = 0.0);

    // Re-adds a layer with its original id and full contents — the undo path for
    // removeLayer. Returns false if that id is already live.
    bool restoreLayer(const SandboxLayer& layer, int atIndex = -1);

    // Returns false if unknown. On success `outRemoved` receives the full layer
    // (with its stack) so a command can put it back verbatim.
    bool removeLayer(int layerId, SandboxLayer* outRemoved = nullptr, int* outIndex = nullptr);

    const SandboxLayer* findLayer(int layerId) const;
    SandboxLayer*       findLayer(int layerId);

    const std::vector<SandboxLayer>& layers() const { return layers_; }
    size_t layerCount() const { return layers_.size(); }

    // ── Stack mutations (called BY commands — see SandboxCommands.h) ──────────
    //
    // Every one of these marks the affected ops dirty from the edit point
    // downstream and fires the change hook. All return false on an unknown
    // layer / op / out-of-range index, and a false return means NOTHING was
    // modified — which is what lets a command decline to record itself.

    // `index` < 0 or past the end appends. `op.id` is assigned here unless it is
    // already non-zero (the redo path, which must restore the original id so
    // later commands referring to it stay valid).
    bool addOp(int layerId, SandboxOp op, int index, int* outOpId = nullptr);

    bool removeOp(int layerId, int opId, SandboxOp* outRemoved = nullptr, int* outIndex = nullptr);

    // Moves the op at `fromIndex` to `toIndex`. Both are positions in the
    // post-removal / pre-insertion sense a drag-and-drop list produces.
    bool reorderOp(int layerId, int fromIndex, int toIndex);

    // Replaces an op's params wholesale. Typed — the caller builds the right
    // alternative, and a variant whose index disagrees with the op's type is
    // REJECTED rather than stored, so a malformed write cannot reach the
    // renderer as a silent pass-through.
    bool setOpParams(int layerId, int opId, const SandboxOpParams& params);

    // `bypassed` is the UI's word; the model stores `enabled`. Setting it to the
    // value it already holds is a no-op that returns false, so a redundant
    // command is not recorded.
    bool setOpBypassed(int layerId, int opId, bool bypassed);

    // ── Layer mix params ─────────────────────────────────────────────────────
    // These do NOT dirty the stack — mix params are applied at composite time,
    // so a level drag must not throw away a rendered buffer.
    bool setLayerMix(int layerId, double gainDb, double pan, int64_t offsetSamples);
    bool setLayerMuted(int layerId, bool muted);
    bool setLayerSoloed(int layerId, bool soloed);
    bool setLayerSource(int layerId, int sourceBufferId, double bufferSampleRate);

    // Durable source reference only — does NOT touch sourceBufferId and does
    // NOT dirty the stack. Separate from setLayerSource because the two move
    // independently: project load re-resolves a stored path into a NEW buffer
    // id (setLayerSource), while a swap that rewrites the file behind a layer
    // updates the path without the id having changed yet. Returns false when
    // the layer is unknown or nothing actually changed.
    bool setLayerSourceRef(int layerId, const std::string& sourceFilePath,
                           double sourceStartTime, double sourceEndTime);

    // ── Dirty bookkeeping ────────────────────────────────────────────────────

    // Called by whoever owns the renderer once a buffer accounting for the whole
    // stack has been published. Clears every op's dirty flag on that layer.
    void markLayerRendered(int layerId);

    // Force a full re-render of a layer (source buffer replaced underneath us).
    void markLayerDirty(int layerId);

    // ── Post-load rebinding (SB-6) ───────────────────────────────────────────
    // Drops every layer's sourceBufferId to -1 and marks its whole stack dirty.
    //
    // fromJson() reads sourceBufferId back VERBATIM, because that is what makes
    // the workspace round-trip lossless in-process (a save/reload inside one
    // session keeps its bank). Across a real project load it is a live hazard:
    // SampleBank ids are minted fresh on every load, so the id in the file
    // names some OTHER project's audio. Project load therefore calls this
    // immediately after fromJson and then re-resolves each layer's durable
    // source reference into a new id via setLayerSource. A layer with no
    // durable reference simply stays unbound rather than rendering the wrong
    // audio, which is the whole reason this is a separate, explicit step.
    void unbindAllSources();

    // ── Change hook ──────────────────────────────────────────────────────────
    // Fired once after any mutation that actually changed something, with the
    // affected layer id. Exists so the Core-tier owner can kick SandboxRenderer
    // without SandboxCore knowing that a renderer exists — the same reason
    // UndoManager has setPostMutationHook.
    //
    // Main thread only. Must not throw and must not mutate this SandboxCore.
    void setChangeHook(std::function<void(int layerId)> hook) { changeHook_ = std::move(hook); }

    // ── Serialization ────────────────────────────────────────────────────────
    // Round-trips losslessly, versioned with sandboxStackVersion. Embedded in
    // the project file by SB-6; the shape is settled here so that prompt is a
    // wiring job, not a format decision.
    nlohmann::json toJson() const;

    // Replaces the entire workspace. Returns false only when `j` is not an
    // object — a workspace with no layers is a valid empty sandbox, not an
    // error. Ops of an unknown type are skipped and counted in `skippedOps`.
    bool fromJson(const nlohmann::json& j, int* versionOut = nullptr, int* skippedOps = nullptr);

    void clear();

private:
    void fireChange(int layerId) const;

    // Mark ops[fromIndex..] dirty. Everything upstream of an edit is unaffected
    // by definition, and that is exactly what the renderer exploits.
    static void dirtyFrom(SandboxLayer& layer, size_t fromIndex);

    std::vector<SandboxLayer> layers_;
    int nextLayerId_ = 1;

    std::function<void(int)> changeHook_;
};

} // namespace xleth::sandbox
