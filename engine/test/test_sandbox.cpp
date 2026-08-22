// ===========================================================================
// test_sandbox — Sample Sandbox engine core (SB-1).
// ===========================================================================
//
// Covers:
//   SandboxOp        typed params (no float blob), content hashing, the
//                    id/dirty exclusion rules, predicted output length,
//                    lossless JSON round-trip with sandboxStackVersion
//   SandboxCore      stack mutation, downstream dirty marking, mix params
//                    staying OUT of the stack, workspace serialization
//   SandboxCommands  add/remove/reorder/setParam/setBypassed undo+redo,
//                    rejected mutations not consuming an undo step
//   SandboxRenderer  DSP correctness per op, the prefix cache, and THE
//                    HEADLINE: mutating op 1 of a 3-op stack re-renders 2 ops,
//                    not 3
//
// Offline only — no audio device, no GPU, no transport.

#include "commands/UndoManager.h"
#include "model/Timeline.h"
#include "sandbox/SandboxCommands.h"
#include "sandbox/SandboxCore.h"
#include "sandbox/SandboxOp.h"
#include "sandbox/SandboxRenderer.h"

#include <cmath>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

using namespace xleth::sandbox;

static int g_failures = 0;

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (!(cond)) {                                                         \
            std::cout << "    FAIL: " << (msg) << "\n";                        \
            ++g_failures;                                                      \
        } else {                                                               \
            std::cout << "    ok:   " << (msg) << "\n";                        \
        }                                                                      \
    } while (0)

#define CHECK_EQ(a, b, msg)                                                    \
    do {                                                                       \
        const auto va_ = (a); const auto vb_ = (b);                            \
        if (!(va_ == vb_)) {                                                   \
            std::cout << "    FAIL: " << (msg)                                 \
                      << "  (got " << va_ << ", want " << vb_ << ")\n";        \
            ++g_failures;                                                      \
        } else {                                                               \
            std::cout << "    ok:   " << (msg) << "\n";                        \
        }                                                                      \
    } while (0)

static bool isNear(double a, double b, double eps) { return std::fabs(a - b) <= eps; }

#define CHECK_NEAR(a, b, eps, msg)                                             \
    do {                                                                       \
        const double va_ = (a), vb_ = (b);                                     \
        if (!isNear(va_, vb_, (eps))) {                                        \
            std::cout << "    FAIL: " << (msg) << "  (got " << va_             \
                      << ", want " << vb_ << ", eps " << (eps) << ")\n";       \
            ++g_failures;                                                      \
        } else {                                                               \
            std::cout << "    ok:   " << (msg) << "\n";                        \
        }                                                                      \
    } while (0)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The engine rate is MEASURED, never assumed — the sandbox spec's rule. Nothing
// in this file compares against a literal 44100/48000; this constant exists so
// the test itself demonstrates carrying the rate through rather than baking it.
static constexpr double kTestRate = 48000.0;

// A ramp buffer: sample i of channel ch holds (i + ch*1000) / 10000. Every
// sample is distinct, so a trim/cut/reverse that lands one sample off is caught.
static SandboxBuffer makeRamp(int channels, int samples) {
    SandboxBuffer b(channels, samples);
    for (int ch = 0; ch < channels; ++ch)
        for (int i = 0; i < samples; ++i)
            b.setSample(ch, i, static_cast<float>(i + ch * 1000) / 10000.0f);
    return b;
}

static SandboxOp makeOp(int id, SandboxOpType type, SandboxOpParams params) {
    SandboxOp op;
    op.id     = id;
    op.type   = type;
    op.params = std::move(params);
    return op;
}

// ---------------------------------------------------------------------------
// SandboxOp — typed params, hashing, length prediction
// ---------------------------------------------------------------------------

static void testOpModel() {
    std::cout << "\n[SandboxOp — model]\n";

    SandboxOp gain = makeOp(1, SandboxOpType::Gain, GainParams{ 0, -1, -6.0, false, 0.0 });
    CHECK(gain.consistent(), "a gain op's variant alternative matches its type");
    CHECK(gain.implemented(), "GAIN has DSP in SB-1");

    SandboxOp pitch = makeOp(2, SandboxOpType::Pitch, PitchParams{ 100.0, false });
    CHECK(!pitch.implemented(), "PITCH is a declared stub in SB-1");

    // A hand-built op whose variant disagrees with its type is malformed and
    // must be detectable — this is the failure mode `float params[16]` cannot
    // even represent, let alone catch.
    SandboxOp malformed = makeOp(3, SandboxOpType::Trim, GainParams{});
    CHECK(!malformed.consistent(), "a type/params mismatch is detected, not reinterpreted");

    // ── Hash rules ──
    SandboxOp a = makeOp(1, SandboxOpType::Gain, GainParams{ 0, -1, -6.0, false, 0.0 });
    SandboxOp b = makeOp(99, SandboxOpType::Gain, GainParams{ 0, -1, -6.0, false, 0.0 });
    CHECK_EQ(a.contentHash(), b.contentHash(), "op id is NOT part of the content hash");

    b.dirty = !a.dirty;
    CHECK_EQ(a.contentHash(), b.contentHash(), "dirty flag is NOT part of the content hash");

    b.enabled = false;
    CHECK(a.contentHash() != b.contentHash(), "enabled IS part of the content hash");

    SandboxOp c = makeOp(1, SandboxOpType::Gain, GainParams{ 0, -1, -6.5, false, 0.0 });
    CHECK(a.contentHash() != c.contentHash(), "a param change changes the content hash");

    // Two ops of different types whose params happen to carry the same numbers
    // must not collide — the type is folded in first.
    SandboxOp trimR = makeOp(1, SandboxOpType::Trim,    TrimParams{ 100, 200 });
    SandboxOp revR  = makeOp(1, SandboxOpType::Reverse, ReverseParams{ 100, 200 });
    CHECK(trimR.contentHash() != revR.contentHash(),
          "same range, different op type => different hash");

    // ── Predicted length ──
    CHECK_EQ(trimR.outputLength(1000), int64_t(100), "TRIM predicts end-start");
    SandboxOp cutRipple = makeOp(1, SandboxOpType::Cut,
                                 CutParams{ 100, 200, SandboxRippleMode::Ripple });
    CHECK_EQ(cutRipple.outputLength(1000), int64_t(900), "ripple CUT shortens by the cut length");
    SandboxOp cutGap = makeOp(1, SandboxOpType::Cut,
                              CutParams{ 100, 200, SandboxRippleMode::Gap });
    CHECK_EQ(cutGap.outputLength(1000), int64_t(1000), "gap CUT preserves length");

    SandboxOp bypassed = trimR;
    bypassed.enabled = false;
    CHECK_EQ(bypassed.outputLength(1000), int64_t(1000), "a bypassed op predicts no length change");
    CHECK_EQ(pitch.outputLength(1000), int64_t(1000), "an unimplemented op predicts no length change");

    // "endSample < 0 means to the end" survives an upstream length change —
    // the property that makes a stack re-evaluable rather than frozen.
    SandboxOp toEnd = makeOp(1, SandboxOpType::Trim, TrimParams{ 50, -1 });
    CHECK_EQ(toEnd.outputLength(1000), int64_t(950), "endSample -1 resolves to the buffer end (1000)");
    CHECK_EQ(toEnd.outputLength(500),  int64_t(450), "…and re-resolves after an upstream change (500)");
}

// ---------------------------------------------------------------------------
// SandboxOp — prefix hashing
// ---------------------------------------------------------------------------

static void testPrefixHash() {
    std::cout << "\n[SandboxOp — prefix hashing]\n";

    std::vector<SandboxOp> ops = {
        makeOp(1, SandboxOpType::Gain,    GainParams{ 0, -1, -6.0, false, 0.0 }),
        makeOp(2, SandboxOpType::Reverse, ReverseParams{ 0, -1 }),
        makeOp(3, SandboxOpType::Fade,    FadeParams{ 0, 100, SandboxFadeShape::Linear, true }),
    };

    const uint64_t p0 = prefixHash(ops, 0);
    const uint64_t p1 = prefixHash(ops, 1);
    const uint64_t p2 = prefixHash(ops, 2);
    const uint64_t p3 = prefixHash(ops, 3);

    CHECK(p0 != p1 && p1 != p2 && p2 != p3, "each prefix depth has a distinct hash");
    CHECK_EQ(p3, stackHash(ops), "stackHash == prefixHash at full depth");
    CHECK_EQ(prefixHash(ops, 99), p3, "count is clamped to the stack size");

    // THE property the whole cache design rests on: editing op 1 must leave
    // every prefix at or below 1 byte-identical, and change every one above.
    ops[1].params = ReverseParams{ 10, 500 };
    CHECK_EQ(prefixHash(ops, 0), p0, "editing op 1 leaves prefix 0 unchanged");
    CHECK_EQ(prefixHash(ops, 1), p1, "editing op 1 leaves prefix 1 unchanged");
    CHECK(prefixHash(ops, 2) != p2, "editing op 1 changes prefix 2");
    CHECK(prefixHash(ops, 3) != p3, "editing op 1 changes prefix 3");
}

// ---------------------------------------------------------------------------
// SandboxOp — JSON round-trip
// ---------------------------------------------------------------------------

static void testOpSerialization() {
    std::cout << "\n[SandboxOp — JSON]\n";

    std::vector<SandboxOp> ops = {
        makeOp(1, SandboxOpType::Trim,      TrimParams{ 480, 96000 }),
        makeOp(2, SandboxOpType::Cut,       CutParams{ 100, 200, SandboxRippleMode::Gap }),
        makeOp(3, SandboxOpType::Paste,     PasteParams{ 4800, 7, 1234, false }),
        makeOp(4, SandboxOpType::Splice,    SpliceParams{ 999, SandboxRippleMode::Ripple }),
        makeOp(5, SandboxOpType::Reverse,   ReverseParams{ 0, -1 }),
        makeOp(6, SandboxOpType::Fade,      FadeParams{ 12, 480, SandboxFadeShape::SCurve, false }),
        makeOp(7, SandboxOpType::Gain,      GainParams{ 5, 900, -3.5, true, -1.0 }),
        makeOp(8, SandboxOpType::Crossfade, CrossfadeParams{ 2400, 128, SandboxFadeShape::EqualPower }),
        makeOp(9, SandboxOpType::Pitch,     PitchParams{ -250.5, true }),
        makeOp(10, SandboxOpType::Stretch,  StretchParams{ 1.375, 5 }),
    };
    ops[3].enabled = false;   // bypass must survive the trip

    const nlohmann::json j = stackToJson(ops);
    CHECK_EQ(j.value("sandboxStackVersion", -1), kSandboxStackVersion,
             "stack JSON carries sandboxStackVersion");
    CHECK_EQ(j["ops"].size(), size_t(10), "every op is written");
    CHECK_EQ(j["ops"][6]["type"].get<std::string>(), std::string("gain"),
             "type is written as a NAME, so an enum reorder is not a migration");

    std::vector<SandboxOp> back;
    int version = -1, skipped = -1;
    CHECK(stackFromJson(j, back, &version, &skipped), "stack JSON parses");
    CHECK_EQ(version, kSandboxStackVersion, "version reads back");
    CHECK_EQ(skipped, 0, "nothing was skipped");
    CHECK_EQ(back.size(), ops.size(), "op count round-trips");

    bool allMatch = true;
    for (size_t i = 0; i < back.size() && i < ops.size(); ++i) {
        if (back[i].id != ops[i].id || back[i].type != ops[i].type
            || back[i].enabled != ops[i].enabled || !(back[i].params == ops[i].params))
            allMatch = false;
    }
    CHECK(allMatch, "every op round-trips losslessly (id, type, enabled, typed params)");
    CHECK_EQ(stackHash(back), stackHash(ops), "the reloaded stack hashes identically");
    CHECK(back[0].dirty, "a loaded op starts dirty — nothing has been rendered yet");

    // An op type this build does not know is skipped, not fatal: a project
    // written by a newer build must still open.
    {
        nlohmann::json newer = j;
        nlohmann::json alien = nlohmann::json::object();
        alien["id"] = 42; alien["type"] = "timewarp"; alien["enabled"] = true;
        alien["params"] = nlohmann::json::object();
        newer["ops"].push_back(alien);

        std::vector<SandboxOp> fwd;
        int fwdSkipped = 0;
        CHECK(stackFromJson(newer, fwd, nullptr, &fwdSkipped),
              "a stack containing an unknown op type still loads");
        CHECK_EQ(fwdSkipped, 1, "the unknown op is reported as skipped");
        CHECK_EQ(fwd.size(), ops.size(), "the known ops all survive");
    }

    // A corrupt field falls back to that param's default rather than losing the
    // whole stack.
    {
        nlohmann::json bad = j;
        bad["ops"][0]["params"]["startSample"] = "not-a-number";
        std::vector<SandboxOp> repaired;
        CHECK(stackFromJson(bad, repaired, nullptr, nullptr), "a corrupt field does not abort the load");
        CHECK_EQ(std::get<TrimParams>(repaired[0].params).startSample, int64_t(0),
                 "the corrupt field falls back to its default");
        CHECK_EQ(std::get<TrimParams>(repaired[0].params).endSample, int64_t(96000),
                 "its healthy sibling is preserved");
    }
}

// ---------------------------------------------------------------------------
// SandboxCore — stack mutation + dirty marking
// ---------------------------------------------------------------------------

static void testCoreMutation() {
    std::cout << "\n[SandboxCore — mutation]\n";

    SandboxCore core;
    int hookFires = 0;
    int lastHookLayer = -1;
    core.setChangeHook([&](int layerId) { ++hookFires; lastHookLayer = layerId; });

    const int layerId = core.addLayer("vox", 7, kTestRate);
    CHECK(layerId > 0, "addLayer returns a valid id");
    CHECK_EQ(hookFires, 1, "adding a layer fires the change hook");
    CHECK_EQ(lastHookLayer, layerId, "the hook reports the affected layer");

    int op1 = 0, op2 = 0, op3 = 0;
    CHECK(core.addOp(layerId, makeOp(0, SandboxOpType::Gain, GainParams{ 0, -1, -6.0, false, 0.0 }), -1, &op1),
          "addOp appends");
    CHECK(core.addOp(layerId, makeOp(0, SandboxOpType::Reverse, ReverseParams{ 0, -1 }), -1, &op2),
          "addOp appends a second op");
    CHECK(core.addOp(layerId, makeOp(0, SandboxOpType::Fade, FadeParams{ 0, 64, SandboxFadeShape::Linear, true }), -1, &op3),
          "addOp appends a third op");
    CHECK(op1 != op2 && op2 != op3, "each op gets a distinct id");

    const SandboxLayer* layer = core.findLayer(layerId);
    CHECK_EQ(layer->ops.size(), size_t(3), "the stack holds 3 ops");

    // A malformed op must be refused at the door, not stored to render as a
    // silent pass-through forever.
    CHECK(!core.addOp(layerId, makeOp(0, SandboxOpType::Trim, GainParams{}), -1, nullptr),
          "an op whose params disagree with its type is REJECTED");
    CHECK_EQ(core.findLayer(layerId)->ops.size(), size_t(3), "…and nothing was stored");

    // ── Downstream dirty marking ──
    core.markLayerRendered(layerId);
    CHECK(core.findLayer(layerId)->clean(), "markLayerRendered clears every dirty flag");

    CHECK(core.setOpParams(layerId, op2, ReverseParams{ 10, 500 }),
          "setOpParams accepts a matching variant");
    CHECK_EQ(core.findLayer(layerId)->firstDirtyIndex(), size_t(1),
             "editing op index 1 dirties from index 1 — op 0 stays clean");
    CHECK(!core.findLayer(layerId)->ops[0].dirty, "op 0 is untouched by an edit to op 1");
    CHECK(core.findLayer(layerId)->ops[2].dirty,  "op 2 is dirtied by an edit to op 1");

    // Rejections
    CHECK(!core.setOpParams(layerId, op2, GainParams{}),
          "setOpParams REJECTS a variant that disagrees with the op's type");
    CHECK(!core.setOpParams(layerId, op2, ReverseParams{ 10, 500 }),
          "writing the value already held is not an edit");
    CHECK(!core.setOpParams(layerId, 9999, ReverseParams{}), "unknown op id is rejected");
    CHECK(!core.setOpParams(9999, op2, ReverseParams{}), "unknown layer id is rejected");

    // ── Bypass ──
    core.markLayerRendered(layerId);
    CHECK(core.setOpBypassed(layerId, op1, true), "setOpBypassed toggles");
    CHECK(!core.findLayer(layerId)->ops[0].enabled, "…and clears `enabled`");
    CHECK_EQ(core.findLayer(layerId)->firstDirtyIndex(), size_t(0),
             "bypassing op 0 dirties the whole stack");
    CHECK(!core.setOpBypassed(layerId, op1, true), "a redundant bypass is not an edit");

    // ── Reorder ──
    core.markLayerRendered(layerId);
    CHECK(core.reorderOp(layerId, 2, 0), "reorderOp moves an op");
    CHECK_EQ(core.findLayer(layerId)->ops[0].id, op3, "the moved op landed at index 0");
    CHECK_EQ(core.findLayer(layerId)->firstDirtyIndex(), size_t(0),
             "a reorder dirties from the earlier of the two positions");
    CHECK(!core.reorderOp(layerId, 1, 1), "a no-op reorder is rejected");
    CHECK(!core.reorderOp(layerId, 0, 99), "an out-of-range destination is rejected");

    // ── Mix params are NOT stack state ──
    core.markLayerRendered(layerId);
    const uint64_t hashBefore = core.findLayer(layerId)->stackHash();
    CHECK(core.setLayerMix(layerId, -3.0, 0.5, 480), "setLayerMix accepts");
    CHECK(core.findLayer(layerId)->clean(),
          "a mix-param change does NOT dirty the stack — a level drag keeps the render");
    CHECK_EQ(core.findLayer(layerId)->stackHash(), hashBefore,
             "…and does not change the stack hash");

    // ── Remove ──
    SandboxOp removed;
    int removedIndex = -1;
    CHECK(core.removeOp(layerId, op1, &removed, &removedIndex), "removeOp succeeds");
    CHECK_EQ(removed.id, op1, "the removed op is handed back for undo");
    CHECK_EQ(core.findLayer(layerId)->ops.size(), size_t(2), "the stack shrank");
    CHECK(!core.removeOp(layerId, op1), "removing it twice fails");
}

// ---------------------------------------------------------------------------
// SandboxCore — workspace serialization
// ---------------------------------------------------------------------------

static void testCoreSerialization() {
    std::cout << "\n[SandboxCore — workspace JSON]\n";

    SandboxCore core;
    const int l1 = core.addLayer("vox", 7, kTestRate);
    const int l2 = core.addLayer("drums", 9, kTestRate);

    core.addOp(l1, makeOp(0, SandboxOpType::Trim, TrimParams{ 480, 48000 }), -1);
    core.addOp(l1, makeOp(0, SandboxOpType::Gain, GainParams{ 0, -1, -6.0, false, 0.0 }), -1);
    core.addOp(l2, makeOp(0, SandboxOpType::Reverse, ReverseParams{ 0, -1 }), -1);
    core.setLayerMix(l2, -4.5, -0.25, 576);
    core.setLayerMuted(l2, true);

    const nlohmann::json j = core.toJson();
    CHECK_EQ(j.value("sandboxStackVersion", -1), kSandboxStackVersion,
             "workspace JSON carries sandboxStackVersion");

    SandboxCore loaded;
    int version = -1, skipped = -1;
    CHECK(loaded.fromJson(j, &version, &skipped), "workspace JSON parses");
    CHECK_EQ(version, kSandboxStackVersion, "version reads back");
    CHECK_EQ(skipped, 0, "no ops skipped");
    CHECK_EQ(loaded.layerCount(), size_t(2), "both layers round-trip");

    const SandboxLayer* a = loaded.findLayer(l1);
    const SandboxLayer* b = loaded.findLayer(l2);
    CHECK(a != nullptr && b != nullptr, "layer ids are preserved");
    CHECK_EQ(a->name, std::string("vox"), "layer name round-trips");
    CHECK_EQ(a->ops.size(), size_t(2), "layer 1's stack round-trips");
    CHECK_EQ(a->bufferSampleRate, kTestRate, "the buffer sample rate round-trips");
    CHECK_EQ(a->stackHash(), core.findLayer(l1)->stackHash(),
             "the reloaded stack is hash-identical — a cached render still matches");
    CHECK_NEAR(b->gainDb, -4.5, 1e-9, "mix gain round-trips");
    CHECK_NEAR(b->pan, -0.25, 1e-9, "mix pan round-trips");
    CHECK_EQ(b->offsetSamples, int64_t(576), "mix offset round-trips");
    CHECK(b->muted, "mute round-trips");

    // A new op on a reloaded layer must not collide with an existing id.
    int newOpId = 0;
    loaded.addOp(l1, makeOp(0, SandboxOpType::Fade, FadeParams{ 0, 64, SandboxFadeShape::Linear, true }), -1, &newOpId);
    bool collides = false;
    for (const auto& op : loaded.findLayer(l1)->ops)
        if (&op != &loaded.findLayer(l1)->ops.back() && op.id == newOpId) collides = true;
    CHECK(!collides, "id counters are repaired on load — a new op cannot collide");

    // A new LAYER must not collide either.
    const int l3 = loaded.addLayer("bass", 11, kTestRate);
    CHECK(l3 != l1 && l3 != l2, "the layer id counter is repaired on load too");
}

// ---------------------------------------------------------------------------
// SandboxCommands — undo / redo
// ---------------------------------------------------------------------------

static void testCommands() {
    std::cout << "\n[SandboxCommands — undo/redo]\n";

    Timeline    timeline;          // required by the Command interface; unused here
    UndoManager undo;
    SandboxCore core;

    const int layerId = core.addLayer("vox", 7, kTestRate);

    // ── Add ──
    auto addCmd = std::make_unique<AddSandboxOpCommand>(
        core, layerId, makeOp(0, SandboxOpType::Gain, GainParams{ 0, -1, -6.0, false, 0.0 }), -1);
    AddSandboxOpCommand* addRaw = addCmd.get();
    undo.execute(std::move(addCmd), timeline);

    const int opId = addRaw->opId();
    CHECK(opId > 0, "AddSandboxOpCommand assigns an op id");
    CHECK_EQ(core.findLayer(layerId)->ops.size(), size_t(1), "the op landed");
    CHECK_EQ(undo.getUndoCount(), 1, "the add is on the undo stack");
    CHECK_EQ(undo.getUndoDescription(), std::string("Add Gain"),
             "describe() names the op, not a type number");

    undo.undo(timeline);
    CHECK_EQ(core.findLayer(layerId)->ops.size(), size_t(0), "undo removes the op");
    undo.redo(timeline);
    CHECK_EQ(core.findLayer(layerId)->ops.size(), size_t(1), "redo restores it");
    CHECK_EQ(core.findLayer(layerId)->ops[0].id, opId,
             "redo restores the ORIGINAL id, so later commands still resolve");

    // ── A rejected add must not consume an undo step ──
    const int depthBefore = undo.getUndoCount();
    undo.execute(std::make_unique<AddSandboxOpCommand>(
        core, 9999, makeOp(0, SandboxOpType::Gain, GainParams{}), -1), timeline);
    CHECK_EQ(undo.getUndoCount(), depthBefore,
             "an add to an unknown layer is NOT recorded in history");

    // ── SetParams ──
    undo.execute(std::make_unique<SetSandboxOpParamsCommand>(
        core, layerId, opId, GainParams{ 0, -1, -12.0, false, 0.0 }), timeline);
    CHECK_NEAR(std::get<GainParams>(core.findLayer(layerId)->ops[0].params).gainDb,
               -12.0, 1e-9, "setParam applied");
    undo.undo(timeline);
    CHECK_NEAR(std::get<GainParams>(core.findLayer(layerId)->ops[0].params).gainDb,
               -6.0, 1e-9, "undo restores the previous params");
    undo.redo(timeline);
    CHECK_NEAR(std::get<GainParams>(core.findLayer(layerId)->ops[0].params).gainDb,
               -12.0, 1e-9, "redo re-applies them");

    // A no-change setParam is not an edit.
    const int depthBeforeNoop = undo.getUndoCount();
    undo.execute(std::make_unique<SetSandboxOpParamsCommand>(
        core, layerId, opId, GainParams{ 0, -1, -12.0, false, 0.0 }), timeline);
    CHECK_EQ(undo.getUndoCount(), depthBeforeNoop,
             "writing the params already held is NOT recorded in history");

    // ── Bypass ──
    undo.execute(std::make_unique<SetSandboxOpBypassedCommand>(core, layerId, opId, true), timeline);
    CHECK(!core.findLayer(layerId)->ops[0].enabled, "bypass applied");
    undo.undo(timeline);
    CHECK(core.findLayer(layerId)->ops[0].enabled, "undo un-bypasses");
    undo.redo(timeline);
    CHECK(!core.findLayer(layerId)->ops[0].enabled, "redo re-bypasses");
    undo.execute(std::make_unique<SetSandboxOpBypassedCommand>(core, layerId, opId, true), timeline);
    // (already bypassed — rejected, so the count below is unchanged)

    // ── Reorder ── build a known 3-op order, then move the last to the front
    undo.clear();
    core.removeOp(layerId, opId);
    int a = 0, b = 0, c = 0;
    core.addOp(layerId, makeOp(0, SandboxOpType::Gain,    GainParams{}),    -1, &a);
    core.addOp(layerId, makeOp(0, SandboxOpType::Reverse, ReverseParams{}), -1, &b);
    core.addOp(layerId, makeOp(0, SandboxOpType::Fade,    FadeParams{}),    -1, &c);

    undo.execute(std::make_unique<ReorderSandboxOpCommand>(core, layerId, 2, 0), timeline);
    CHECK_EQ(core.findLayer(layerId)->ops[0].id, c, "reorder moved op c to the front");
    CHECK_EQ(core.findLayer(layerId)->ops[1].id, a, "…and slid a down");
    undo.undo(timeline);
    CHECK_EQ(core.findLayer(layerId)->ops[0].id, a, "undo restores the exact prior order (a)");
    CHECK_EQ(core.findLayer(layerId)->ops[1].id, b, "undo restores the exact prior order (b)");
    CHECK_EQ(core.findLayer(layerId)->ops[2].id, c, "undo restores the exact prior order (c)");
    undo.redo(timeline);
    CHECK_EQ(core.findLayer(layerId)->ops[0].id, c, "redo re-applies the move");

    // ── Remove ──
    undo.execute(std::make_unique<RemoveSandboxOpCommand>(core, layerId, a), timeline);
    CHECK_EQ(core.findLayer(layerId)->ops.size(), size_t(2), "remove applied");
    CHECK(core.findLayer(layerId)->findOp(a) == nullptr, "the op is gone");
    undo.undo(timeline);
    CHECK_EQ(core.findLayer(layerId)->ops.size(), size_t(3), "undo restores it");
    CHECK(core.findLayer(layerId)->findOp(a) != nullptr, "with its original id");
    CHECK_EQ(core.findLayer(layerId)->ops[1].id, a, "…and at its original index");

    // ── Layer add/remove carries the whole stack ──
    undo.clear();
    auto layerCmd = std::make_unique<RemoveSandboxLayerCommand>(core, layerId);
    undo.execute(std::move(layerCmd), timeline);
    CHECK(core.findLayer(layerId) == nullptr, "the layer is gone");
    undo.undo(timeline);
    CHECK(core.findLayer(layerId) != nullptr, "undo restores the layer");
    CHECK_EQ(core.findLayer(layerId)->ops.size(), size_t(3),
             "…with its whole op-stack, not an empty one");
}

// ---------------------------------------------------------------------------
// SandboxRenderer — per-op DSP correctness
// ---------------------------------------------------------------------------

static void testRendererOps() {
    std::cout << "\n[SandboxRenderer — op DSP]\n";

    SandboxRenderer renderer;
    const SandboxBuffer src = makeRamp(2, 1000);

    // ── TRIM ──
    {
        SandboxRenderResult r = renderer.renderStack(
            1, src, { makeOp(1, SandboxOpType::Trim, TrimParams{ 100, 200 }) }, kTestRate);
        CHECK(r.valid(), "TRIM renders");
        CHECK_EQ(r.buffer->getNumSamples(), 100, "TRIM output length is sample-exact");
        CHECK_NEAR(r.buffer->getSample(0, 0), src.getSample(0, 100), 1e-9,
                   "TRIM output starts at the trim point");
        CHECK_NEAR(r.buffer->getSample(0, 99), src.getSample(0, 199), 1e-9,
                   "TRIM output ends one before endSample (half-open range)");
        CHECK_NEAR(r.buffer->getSample(1, 0), src.getSample(1, 100), 1e-9,
                   "TRIM preserves channel 2");
    }

    // ── CUT, ripple ──
    {
        SandboxRenderResult r = renderer.renderStack(
            2, src, { makeOp(1, SandboxOpType::Cut, CutParams{ 100, 200, SandboxRippleMode::Ripple }) },
            kTestRate);
        CHECK_EQ(r.buffer->getNumSamples(), 900, "ripple CUT shortens the buffer");
        CHECK_NEAR(r.buffer->getSample(0, 99),  src.getSample(0, 99),  1e-9, "material before the cut is intact");
        CHECK_NEAR(r.buffer->getSample(0, 100), src.getSample(0, 200), 1e-9, "the seam closes onto endSample");
    }

    // ── CUT, gap ──
    {
        SandboxRenderResult r = renderer.renderStack(
            3, src, { makeOp(1, SandboxOpType::Cut, CutParams{ 100, 200, SandboxRippleMode::Gap }) },
            kTestRate);
        CHECK_EQ(r.buffer->getNumSamples(), 1000, "gap CUT preserves the buffer length");
        CHECK_NEAR(r.buffer->getSample(0, 150), 0.0f, 1e-9, "the cut range is silent");
        CHECK_NEAR(r.buffer->getSample(0, 200), src.getSample(0, 200), 1e-9, "material after it is intact");
    }

    // ── REVERSE ──
    {
        SandboxRenderResult r = renderer.renderStack(
            4, src, { makeOp(1, SandboxOpType::Reverse, ReverseParams{ 0, -1 }) }, kTestRate);
        CHECK_EQ(r.buffer->getNumSamples(), 1000, "REVERSE preserves length");
        CHECK_NEAR(r.buffer->getSample(0, 0),   src.getSample(0, 999), 1e-9, "first sample is the old last");
        CHECK_NEAR(r.buffer->getSample(0, 999), src.getSample(0, 0),   1e-9, "last sample is the old first");
    }

    // Partial-range reverse leaves the rest alone.
    {
        SandboxRenderResult r = renderer.renderStack(
            5, src, { makeOp(1, SandboxOpType::Reverse, ReverseParams{ 100, 200 }) }, kTestRate);
        CHECK_NEAR(r.buffer->getSample(0, 50),  src.getSample(0, 50),  1e-9, "material before the range is untouched");
        CHECK_NEAR(r.buffer->getSample(0, 100), src.getSample(0, 199), 1e-9, "the range is reversed");
        CHECK_NEAR(r.buffer->getSample(0, 500), src.getSample(0, 500), 1e-9, "material after the range is untouched");
    }

    // ── GAIN ──
    {
        SandboxRenderResult r = renderer.renderStack(
            6, src, { makeOp(1, SandboxOpType::Gain, GainParams{ 0, -1, -6.0206, false, 0.0 }) }, kTestRate);
        CHECK_NEAR(r.buffer->getSample(0, 500), src.getSample(0, 500) * 0.5, 1e-4,
                   "-6.02 dB halves the amplitude");
    }

    // ── GAIN, normalize ──
    {
        SandboxBuffer quiet(1, 100);
        for (int i = 0; i < 100; ++i) quiet.setSample(0, i, 0.1f);
        SandboxRenderResult r = renderer.renderStack(
            7, quiet, { makeOp(1, SandboxOpType::Gain, GainParams{ 0, -1, 0.0, true, 0.0 }) }, kTestRate);
        CHECK_NEAR(r.buffer->getSample(0, 50), 1.0, 1e-5, "normalize to 0 dBFS lifts the peak to 1.0");
    }

    // Silence has no peak to normalize to — it must be left alone, not turned
    // into a buffer full of inf.
    {
        SandboxBuffer silence(1, 100);
        silence.clear();
        SandboxRenderResult r = renderer.renderStack(
            8, silence, { makeOp(1, SandboxOpType::Gain, GainParams{ 0, -1, 0.0, true, 0.0 }) }, kTestRate);
        CHECK(std::isfinite(r.buffer->getSample(0, 50)), "normalizing digital silence stays finite");
        CHECK_NEAR(r.buffer->getSample(0, 50), 0.0, 1e-12, "…and stays silent");
    }

    // ── FADE ──
    {
        SandboxBuffer flat(1, 1000);
        for (int i = 0; i < 1000; ++i) flat.setSample(0, i, 1.0f);
        SandboxRenderResult r = renderer.renderStack(
            9, flat, { makeOp(1, SandboxOpType::Fade, FadeParams{ 0, 100, SandboxFadeShape::Linear, true }) },
            kTestRate);
        CHECK_NEAR(r.buffer->getSample(0, 0),   0.0,  1e-6, "linear fade-in starts at silence");
        CHECK_NEAR(r.buffer->getSample(0, 50),  0.5,  1e-6, "…is half way at the midpoint");
        CHECK_NEAR(r.buffer->getSample(0, 100), 1.0,  1e-6, "…reaches unity at the end of the window");
        CHECK_NEAR(r.buffer->getSample(0, 500), 1.0,  1e-6, "…and leaves the rest alone");

        SandboxRenderResult out = renderer.renderStack(
            10, flat, { makeOp(1, SandboxOpType::Fade, FadeParams{ 900, 100, SandboxFadeShape::Linear, false }) },
            kTestRate);
        CHECK_NEAR(out.buffer->getSample(0, 900), 1.0, 1e-6, "fade-out starts at unity");
        CHECK_NEAR(out.buffer->getSample(0, 950), 0.5, 1e-6, "…is half way at the midpoint");
        CHECK_NEAR(out.buffer->getSample(0, 999), 0.0, 1e-2, "…and lands at silence");
    }

    // ── Bypass and stubs are exact pass-throughs ──
    {
        SandboxOp bypassed = makeOp(1, SandboxOpType::Gain, GainParams{ 0, -1, -60.0, false, 0.0 });
        bypassed.enabled = false;
        SandboxRenderResult r = renderer.renderStack(11, src, { bypassed }, kTestRate);
        CHECK_NEAR(r.buffer->getSample(0, 500), src.getSample(0, 500), 1e-9,
                   "a bypassed op passes audio through untouched");

        SandboxRenderResult s = renderer.renderStack(
            12, src, { makeOp(1, SandboxOpType::Pitch, PitchParams{ 1200.0, false }) }, kTestRate);
        CHECK_NEAR(s.buffer->getSample(0, 500), src.getSample(0, 500), 1e-9,
                   "an unimplemented op passes audio through untouched");
        CHECK_EQ(s.unimplementedOps, 1,
                 "…and is REPORTED as unimplemented, so it never reads as a silent failure");
    }

    // ── The rate is never guessed ──
    {
        SandboxRenderResult r = renderer.renderStack(
            13, src, { makeOp(1, SandboxOpType::Trim, TrimParams{ 0, 100 }) }, 0.0);
        CHECK(!r.valid(), "a render with an unknown sample rate is REFUSED, not guessed at 44100");
    }
}

// ---------------------------------------------------------------------------
// SandboxRenderer — the prefix cache
// ---------------------------------------------------------------------------

static void testRendererCache() {
    std::cout << "\n[SandboxRenderer — prefix cache]\n";

    SandboxRenderer renderer;
    const SandboxBuffer src = makeRamp(2, 4000);

    std::vector<SandboxOp> ops = {
        makeOp(1, SandboxOpType::Trim,    TrimParams{ 100, 3000 }),
        makeOp(2, SandboxOpType::Gain,    GainParams{ 0, -1, -6.0, false, 0.0 }),
        makeOp(3, SandboxOpType::Reverse, ReverseParams{ 0, -1 }),
    };

    SandboxRenderResult first = renderer.renderStack(100, src, ops, kTestRate);
    CHECK(first.valid(), "the 3-op stack renders");
    CHECK_EQ(first.opsEvaluated, 3, "a cold render evaluates all 3 ops");
    CHECK_EQ(first.resumedAtOp, 0, "…starting from the raw source");
    CHECK_EQ(renderer.entryCount(), size_t(3), "every intermediate prefix is cached");

    // Re-render, unchanged: nothing should run at all.
    SandboxRenderResult again = renderer.renderStack(100, src, ops, kTestRate);
    CHECK_EQ(again.opsEvaluated, 0, "an unchanged re-render evaluates NOTHING");
    CHECK(again.fullyCached, "…and reports itself fully cached");

    // A different source id is a different render even with the same stack.
    SandboxRenderResult otherSrc = renderer.renderStack(101, src, ops, kTestRate);
    CHECK_EQ(otherSrc.opsEvaluated, 3, "a different source buffer id re-renders from scratch");

    // A different sample rate must not reuse the 48k render.
    SandboxRenderResult otherRate = renderer.renderStack(100, src, ops, 44100.0);
    CHECK_EQ(otherRate.opsEvaluated, 3,
             "the same stack at another rate is a DIFFERENT render, not a reused one");
}

// ---------------------------------------------------------------------------
// THE DELIVERABLE: build a 3-op stack, render, mutate op 1, confirm the
// re-render is downstream-only.
// ---------------------------------------------------------------------------

static void testDownstreamOnlyRerender() {
    std::cout << "\n[SB-1 deliverable — downstream-only re-render]\n";

    Timeline    timeline;
    UndoManager undo;
    SandboxCore core;
    SandboxRenderer renderer;

    // A generated buffer, and a layer bound to it at a MEASURED rate.
    const int    sourceBufferId = 77;
    const SandboxBuffer src     = makeRamp(2, 8000);
    const int layerId = core.addLayer("smoke", sourceBufferId, kTestRate);

    // 3-op stack: trim → gain → reverse.
    auto add = [&](SandboxOpType type, SandboxOpParams params) {
        auto cmd = std::make_unique<AddSandboxOpCommand>(core, layerId, makeOp(0, type, std::move(params)), -1);
        AddSandboxOpCommand* raw = cmd.get();
        undo.execute(std::move(cmd), timeline);
        return raw->opId();
    };

    const int opTrim    = add(SandboxOpType::Trim,    TrimParams{ 500, 6000 });
    const int opGain    = add(SandboxOpType::Gain,    GainParams{ 0, -1, -6.0206, false, 0.0 });
    const int opReverse = add(SandboxOpType::Reverse, ReverseParams{ 0, -1 });
    (void)opTrim; (void)opReverse;

    const SandboxLayer* layer = core.findLayer(layerId);
    CHECK_EQ(layer->ops.size(), size_t(3), "3-op stack built through the UndoManager");
    CHECK_EQ(undo.getUndoCount(), 3, "…as 3 undoable steps");

    // ── Render 1: cold ──
    const uint64_t evalsBefore = renderer.opEvalCount();
    SandboxRenderResult r1 = renderer.renderStack(sourceBufferId, src, layer->ops, layer->bufferSampleRate);
    const uint64_t evals1 = renderer.opEvalCount() - evalsBefore;

    CHECK(r1.valid(), "cold render produced a buffer");
    CHECK_EQ(evals1, uint64_t(3), "cold render evaluated 3 ops");
    CHECK_EQ(r1.buffer->getNumSamples(), 5500, "output length = trim(500..6000)");
    // trim → gain(-6dB) → reverse: the last output sample is the first trimmed
    // sample, halved.
    CHECK_NEAR(r1.buffer->getSample(0, 5499), src.getSample(0, 500) * 0.5, 1e-4,
               "the cold render's audio is what the stack describes");

    renderer.publish(layerId, r1.buffer);
    core.markLayerRendered(layerId);
    CHECK(core.findLayer(layerId)->clean(), "the layer is clean after a full render");

    // ── Mutate op 1 (the GAIN, index 1 of 3) through the UndoManager ──
    undo.execute(std::make_unique<SetSandboxOpParamsCommand>(
        core, layerId, opGain, GainParams{ 0, -1, -12.0412, false, 0.0 }), timeline);

    layer = core.findLayer(layerId);
    CHECK_EQ(layer->firstDirtyIndex(), size_t(1), "op 0 is still clean; the dirt starts at op 1");
    CHECK(!layer->ops[0].dirty, "op 0 (TRIM) was not dirtied");
    CHECK(layer->ops[1].dirty,  "op 1 (GAIN) was dirtied");
    CHECK(layer->ops[2].dirty,  "op 2 (REVERSE) was dirtied");

    // ── Render 2: must resume from the cached prefix at depth 1 ──
    const uint64_t evalsBefore2 = renderer.opEvalCount();
    SandboxRenderResult r2 = renderer.renderStack(sourceBufferId, src, layer->ops, layer->bufferSampleRate);
    const uint64_t evals2 = renderer.opEvalCount() - evalsBefore2;

    CHECK(r2.valid(), "the re-render produced a buffer");
    CHECK_EQ(r2.resumedAtOp, 1, "the re-render RESUMED at op 1 — op 0's prefix was reused");
    CHECK_EQ(evals2, uint64_t(2), "the re-render evaluated 2 ops, not 3  <<< DOWNSTREAM-ONLY");
    CHECK_EQ(r2.opsEvaluated, 2, "…and reports the same count in its result");

    // And it is genuinely the right audio, not just a cheap one.
    CHECK_EQ(r2.buffer->getNumSamples(), 5500, "the re-render's length is unchanged");
    CHECK_NEAR(r2.buffer->getSample(0, 5499), src.getSample(0, 500) * 0.25, 1e-4,
               "the re-rendered audio reflects the NEW gain (-12.04 dB = 0.25x)");

    // ── Mutating the LAST op re-renders exactly 1 ──
    core.markLayerRendered(layerId);
    undo.execute(std::make_unique<SetSandboxOpParamsCommand>(
        core, layerId, opReverse, ReverseParams{ 0, 1000 }), timeline);

    const uint64_t evalsBefore3 = renderer.opEvalCount();
    SandboxRenderResult r3 = renderer.renderStack(sourceBufferId, src, core.findLayer(layerId)->ops,
                                                  kTestRate);
    CHECK_EQ(renderer.opEvalCount() - evalsBefore3, uint64_t(1),
             "editing the LAST op re-renders exactly 1 op");
    CHECK_EQ(r3.resumedAtOp, 2, "…resuming at op 2");

    // ── Undo returns to an already-cached state: zero DSP ──
    undo.undo(timeline);
    const uint64_t evalsBefore4 = renderer.opEvalCount();
    SandboxRenderResult r4 = renderer.renderStack(sourceBufferId, src, core.findLayer(layerId)->ops,
                                                  kTestRate);
    CHECK_EQ(renderer.opEvalCount() - evalsBefore4, uint64_t(0),
             "undoing back to a rendered state costs ZERO ops — the cache still holds it");
    CHECK(r4.fullyCached, "…and reports itself fully cached");

    // ── Bypassing op 0 invalidates everything below it ──
    core.markLayerRendered(layerId);
    undo.execute(std::make_unique<SetSandboxOpBypassedCommand>(core, layerId, opTrim, true), timeline);
    const uint64_t evalsBefore5 = renderer.opEvalCount();
    SandboxRenderResult r5 = renderer.renderStack(sourceBufferId, src, core.findLayer(layerId)->ops,
                                                  kTestRate);
    CHECK_EQ(renderer.opEvalCount() - evalsBefore5, uint64_t(3),
             "bypassing op 0 re-renders all 3 — a bypass IS a content change");
    CHECK_EQ(r5.buffer->getNumSamples(), 8000, "…and the trim really is gone");
}

// ---------------------------------------------------------------------------
// SandboxRenderer — worker thread + the audio-thread handoff
// ---------------------------------------------------------------------------

static void testWorkerAndPublish() {
    std::cout << "\n[SandboxRenderer — worker thread + publish]\n";

    SandboxRenderer renderer;
    const SandboxBuffer src = makeRamp(2, 4000);
    const int layerId = 3;

    CHECK(renderer.publishedOutput(layerId) == nullptr,
          "nothing is published before the first render");

    std::vector<SandboxOp> ops = {
        makeOp(1, SandboxOpType::Trim, TrimParams{ 0, 2000 }),
        makeOp(2, SandboxOpType::Gain, GainParams{ 0, -1, -6.0206, false, 0.0 }),
    };

    CHECK(renderer.submit(layerId, 200, src, ops, kTestRate), "submit queues a job");
    renderer.waitForPendingJobs(10000);

    SandboxBufferPtr out = renderer.publishedOutput(layerId);
    CHECK(out != nullptr, "the worker published a buffer");
    if (out != nullptr) {
        CHECK_EQ(out->getNumSamples(), 2000, "the published buffer is the rendered one");
        CHECK_NEAR(out->getSample(0, 1000), src.getSample(0, 1000) * 0.5, 1e-4,
                   "…with the stack applied");
    }
    CHECK(renderer.completionEpoch() > 0, "the completion epoch advanced");
    CHECK_EQ(renderer.pendingCount(), size_t(0), "no jobs left pending");

    // An unknown layer must never write past the published_ array.
    CHECK(!renderer.submit(9999, 200, src, ops, kTestRate),
          "a layer id past kMaxLayers is refused rather than overrunning the slot array");
    CHECK(renderer.publishedOutput(-1) == nullptr, "a negative layer id reads back nullptr");
    CHECK(renderer.publishedOutput(999999) == nullptr, "an out-of-range layer id reads back nullptr");

    // The handoff is atomic: a holder of the old pointer keeps its buffer alive.
    SandboxBufferPtr held = renderer.publishedOutput(layerId);
    renderer.publish(layerId, std::make_shared<const SandboxBuffer>(makeRamp(1, 10)));
    CHECK(held != nullptr && held->getNumSamples() == 2000,
          "a held buffer survives a newer publish — the swap is a handoff, not a mutation");
    CHECK_EQ(renderer.publishedOutput(layerId)->getNumSamples(), 10, "…and the new one is live");

    renderer.unpublish(layerId);
    CHECK(renderer.publishedOutput(layerId) == nullptr, "unpublish clears the slot");
}

// ---------------------------------------------------------------------------

int main() {
    std::cout << "=== test_sandbox ===\n";

    testOpModel();
    testPrefixHash();
    testOpSerialization();
    testCoreMutation();
    testCoreSerialization();
    testCommands();
    testRendererOps();
    testRendererCache();
    testDownstreamOnlyRerender();
    testWorkerAndPublish();

    std::cout << "\n";
    if (g_failures == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cout << g_failures << " TEST(S) FAILED\n";
    return 1;
}
