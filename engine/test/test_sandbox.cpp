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
//   SB-5             layer mix/mute/solo commands, BakeSandboxCompositeCommand's
//                     closure-injected undo/redo, and composite mixing itself —
//                     the 3-layer (plain / reversed / +12ms offset) fixture
//   SB-6             the DURABLE source reference (path + time range) that
//                     survives a project load where a SampleBank id cannot,
//                     SwapSandboxSampleCommand's undo/redo (undo restores the
//                     old binding, redo re-applies without re-rendering), and
//                     Command::domain — one shared undo stack, two surfaces
//
// Offline only — no audio device, no GPU, no transport.

#include "commands/UndoManager.h"
#include "model/Timeline.h"
#include "sandbox/SandboxCommands.h"
#include "sandbox/SandboxCore.h"
#include "sandbox/SandboxOp.h"
#include "sandbox/SandboxRenderer.h"
#include "sandbox/SandboxSpectrogram.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
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

// A constant-value buffer — used where the composite mixer's arithmetic needs
// to be hand-checkable (a ramp's exact overlap sum is tedious to verify by
// eye once three layers with different offsets are summed).
static SandboxBuffer makeConst(int channels, int samples, float value) {
    SandboxBuffer b(channels, samples);
    for (int ch = 0; ch < channels; ++ch)
        for (int i = 0; i < samples; ++i)
            b.setSample(ch, i, value);
    return b;
}

// A pure tone — used by the restoration/pitch trio's tests, where a
// zero-crossing count stands in for "did the pitch actually move" without
// needing an FFT-based pitch detector in the test itself.
static SandboxBuffer makeSine(int channels, int samples, double freqHz, double sampleRate,
                              float amplitude = 0.5f) {
    SandboxBuffer b(channels, samples);
    for (int ch = 0; ch < channels; ++ch)
        for (int i = 0; i < samples; ++i)
            b.setSample(ch, i, amplitude * static_cast<float>(
                std::sin(2.0 * 3.14159265358979323846 * freqHz * i / sampleRate)));
    return b;
}

static int countZeroCrossings(const SandboxBuffer& b, int64_t start, int64_t end) {
    int count = 0;
    float prev = b.getSample(0, static_cast<int>(start));
    for (int64_t i = start + 1; i < end; ++i) {
        const float cur = b.getSample(0, static_cast<int>(i));
        if ((prev < 0.0f) != (cur < 0.0f)) ++count;
        prev = cur;
    }
    return count;
}

static float rmsOf(const SandboxBuffer& b, int64_t start, int64_t end) {
    double sum = 0.0;
    for (int64_t i = start; i < end; ++i) { const double s = b.getSample(0, static_cast<int>(i)); sum += s * s; }
    const int64_t n = end - start;
    return n > 0 ? static_cast<float>(std::sqrt(sum / static_cast<double>(n))) : 0.0f;
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
    CHECK(pitch.implemented(), "PITCH has DSP (RubberBand, offline)");

    SandboxOp stretch = makeOp(3, SandboxOpType::Stretch, StretchParams{});
    CHECK(!stretch.implemented(), "STRETCH is still a declared stub");

    // SB-4 lands DSP for these three — they were the SB-1 stubs.
    CHECK(makeOp(4, SandboxOpType::Paste,     PasteParams{}).implemented(),     "PASTE lands in SB-4");
    CHECK(makeOp(5, SandboxOpType::Splice,    SpliceParams{}).implemented(),    "SPLICE lands in SB-4");
    CHECK(makeOp(6, SandboxOpType::Crossfade, CrossfadeParams{}).implemented(), "CROSSFADE lands in SB-4");
    CHECK(makeOp(7, SandboxOpType::GainEnvelope, GainEnvelopeParams{}).implemented(),
          "GAIN ENVELOPE has DSP");
    CHECK(makeOp(7, SandboxOpType::GainEnvelope, GainEnvelopeParams{}).autoRender(),
          "GAIN ENVELOPE is cheap enough to auto-render");
    CHECK_EQ(makeOp(7, SandboxOpType::GainEnvelope,
                    GainEnvelopeParams{ { {0, 0.0}, {500, -24.0} } }).outputLength(1000),
             int64_t(1000), "GAIN ENVELOPE is in-place - it never changes length");

    // Restoration/pitch trio — landed alongside PITCH.
    CHECK(makeOp(8, SandboxOpType::FormantShift, FormantShiftParams{}).implemented(), "FORMANT SHIFT has DSP");
    CHECK(makeOp(9, SandboxOpType::Declip,       DeclipParams{}).implemented(),       "DECLIP has DSP");
    CHECK(makeOp(10, SandboxOpType::Denoise,      DenoiseParams{}).implemented(),      "DENOISE has DSP");
    CHECK_EQ(makeOp(8, SandboxOpType::FormantShift, FormantShiftParams{ 300.0 }).outputLength(1000),
             int64_t(1000), "FORMANT SHIFT is in-place — it never changes length");
    CHECK_EQ(makeOp(9, SandboxOpType::Declip, DeclipParams{}).outputLength(1000),
             int64_t(1000), "DECLIP is in-place");
    CHECK_EQ(makeOp(10, SandboxOpType::Denoise, DenoiseParams{}).outputLength(1000),
             int64_t(1000), "DENOISE is in-place");

    // Every op type auto-renders today — no heavy op (e.g. model separation)
    // exists yet. Distinct from implemented(): STRETCH is a stub but still
    // cheap, so it does not opt out of auto-render.
    CHECK(gain.autoRender(),    "GAIN auto-renders");
    CHECK(pitch.autoRender(),   "PITCH auto-renders");
    CHECK(stretch.autoRender(), "STRETCH is unimplemented but still cheap — auto-renders");

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

    // PASTE / SPLICE predict length WITHOUT a buffer — clipboardLengthSamples
    // and gapSamples are exactly what makes that possible.
    SandboxOp pasteInsert = makeOp(1, SandboxOpType::Paste, PasteParams{ 500, -1, 200, true });
    CHECK_EQ(pasteInsert.outputLength(1000), int64_t(1200), "PASTE insert grows by clipboardLengthSamples");
    SandboxOp pasteOverwrite = makeOp(1, SandboxOpType::Paste, PasteParams{ 500, -1, 200, false });
    CHECK_EQ(pasteOverwrite.outputLength(1000), int64_t(1000), "PASTE overwrite preserves length");

    SandboxOp spliceRipple = makeOp(1, SandboxOpType::Splice, SpliceParams{ 400, SandboxRippleMode::Ripple, 999 });
    CHECK_EQ(spliceRipple.outputLength(1000), int64_t(1000),
             "SPLICE ripple preserves length (gapSamples ignored outside Gap mode)");
    SandboxOp spliceGap = makeOp(1, SandboxOpType::Splice, SpliceParams{ 400, SandboxRippleMode::Gap, 50 });
    CHECK_EQ(spliceGap.outputLength(1000), int64_t(1050), "SPLICE gap grows by gapSamples");
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
        makeOp(4, SandboxOpType::Splice,    SpliceParams{ 999, SandboxRippleMode::Gap, 240 }),
        makeOp(5, SandboxOpType::Reverse,   ReverseParams{ 0, -1 }),
        makeOp(6, SandboxOpType::Fade,      FadeParams{ 12, 480, SandboxFadeShape::Hann, false }),
        makeOp(7, SandboxOpType::Gain,      GainParams{ 5, 900, -3.5, true, -1.0 }),
        makeOp(8, SandboxOpType::Crossfade, CrossfadeParams{ 2400, 128, SandboxFadeShape::EqualPower }),
        makeOp(9, SandboxOpType::Pitch,     PitchParams{ -250.5, true }),
        makeOp(10, SandboxOpType::Stretch,  StretchParams{ 1.375, 5 }),
        makeOp(11, SandboxOpType::GainEnvelope,
               GainEnvelopeParams{ { {0, 0.0}, {4800, -18.25}, {9600, -3.5}, {96000, 0.0} } }),
        makeOp(12, SandboxOpType::FormantShift, FormantShiftParams{ 316.0 }),
        makeOp(13, SandboxOpType::Declip,       DeclipParams{ 100, 5000, 0.95, 40 }),
        makeOp(14, SandboxOpType::Denoise,      DenoiseParams{ 0, 4800, 18.0, 2.0 }),
    };
    ops[3].enabled = false;   // bypass must survive the trip

    const nlohmann::json j = stackToJson(ops);
    CHECK_EQ(j.value("sandboxStackVersion", -1), kSandboxStackVersion,
             "stack JSON carries sandboxStackVersion");
    CHECK_EQ(j["ops"].size(), size_t(14), "every op is written");
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
// SandboxCommands — layer mix / mute / solo undo+redo (SB-5)
// ---------------------------------------------------------------------------

static void testLayerMixCommands() {
    std::cout << "\n[SandboxCommands — layer mix/mute/solo undo/redo]\n";

    Timeline    timeline;
    UndoManager undo;
    SandboxCore core;

    const int layerId = core.addLayer("bed", 3, kTestRate);

    // ── Mix (gain/pan/offset) ──
    undo.execute(std::make_unique<SetSandboxLayerMixCommand>(core, layerId, -6.0, 0.5, 576), timeline);
    const SandboxLayer* layer = core.findLayer(layerId);
    CHECK_NEAR(layer->gainDb, -6.0, 1e-9, "gain applied");
    CHECK_NEAR(layer->pan, 0.5, 1e-9, "pan applied");
    CHECK_EQ(layer->offsetSamples, int64_t(576), "offset applied");
    CHECK_EQ(layer->firstDirtyIndex(), layer->ops.size(), "mix params never dirty the stack");

    undo.undo(timeline);
    layer = core.findLayer(layerId);
    CHECK_NEAR(layer->gainDb, 0.0, 1e-9, "undo restores the default gain");
    CHECK_NEAR(layer->pan, 0.0, 1e-9, "undo restores the default pan");
    CHECK_EQ(layer->offsetSamples, int64_t(0), "undo restores the default offset");

    undo.redo(timeline);
    CHECK_NEAR(core.findLayer(layerId)->gainDb, -6.0, 1e-9, "redo re-applies the mix");

    // A no-change mix write is not an edit.
    const int depthBeforeNoop = undo.getUndoCount();
    undo.execute(std::make_unique<SetSandboxLayerMixCommand>(core, layerId, -6.0, 0.5, 576), timeline);
    CHECK_EQ(undo.getUndoCount(), depthBeforeNoop, "writing the mix already held is NOT recorded");

    // ── Mute ──
    undo.execute(std::make_unique<SetSandboxLayerMutedCommand>(core, layerId, true), timeline);
    CHECK(core.findLayer(layerId)->muted, "mute applied");
    undo.undo(timeline);
    CHECK(!core.findLayer(layerId)->muted, "undo un-mutes");
    undo.redo(timeline);
    CHECK(core.findLayer(layerId)->muted, "redo re-mutes");

    // ── Solo ──
    undo.execute(std::make_unique<SetSandboxLayerSoloedCommand>(core, layerId, true), timeline);
    CHECK(core.findLayer(layerId)->soloed, "solo applied");
    undo.undo(timeline);
    CHECK(!core.findLayer(layerId)->soloed, "undo un-solos");
    undo.redo(timeline);
    CHECK(core.findLayer(layerId)->soloed, "redo re-solos");

    // Rejected mutations on an unknown layer must not consume an undo step.
    const int depthBefore = undo.getUndoCount();
    undo.execute(std::make_unique<SetSandboxLayerMutedCommand>(core, 9999, true), timeline);
    CHECK_EQ(undo.getUndoCount(), depthBefore, "muting an unknown layer is NOT recorded");
}

// ---------------------------------------------------------------------------
// BakeSandboxCompositeCommand — undo/redo of the closure-injected bake (SB-5)
// ---------------------------------------------------------------------------

static void testBakeCompositeCommand() {
    std::cout << "\n[BakeSandboxCompositeCommand — undo/redo]\n";

    Timeline    timeline;
    UndoManager undo;

    // A minimal fake "asset store" standing in for SampleBank — tombstone /
    // restore semantics only, exactly what the command needs. Proves the
    // command's own contract (bake once, redo restores rather than re-bakes)
    // without depending on SampleBank's own link footprint.
    struct FakeAsset { bool live = false; };
    std::vector<FakeAsset> store;
    int bakeCalls = 0;

    BakeSandboxCompositeCommand::BakeFn bakeFn = [&]() -> int {
        ++bakeCalls;
        const int id = static_cast<int>(store.size());
        store.push_back(FakeAsset{ true });
        return id;
    };
    BakeSandboxCompositeCommand::UndoFn undoFn = [&](int id) {
        if (id >= 0 && id < static_cast<int>(store.size())) store[static_cast<size_t>(id)].live = false;
    };
    BakeSandboxCompositeCommand::RestoreFn restoreFn = [&](int id) -> bool {
        if (id < 0 || id >= static_cast<int>(store.size()) || store[static_cast<size_t>(id)].live) return false;
        store[static_cast<size_t>(id)].live = true;
        return true;
    };

    auto cmd = std::make_unique<BakeSandboxCompositeCommand>("mix", bakeFn, undoFn, restoreFn);
    BakeSandboxCompositeCommand* raw = cmd.get();
    undo.execute(std::move(cmd), timeline);

    const int sampleId = raw->bakedSampleId();
    CHECK(sampleId >= 0, "bake registers a new asset id");
    CHECK_EQ(bakeCalls, 1, "bakeFn ran exactly once");
    CHECK(store[static_cast<size_t>(sampleId)].live, "the asset is live right after bake");
    CHECK_EQ(undo.getUndoCount(), 1, "the bake is on the undo stack");

    undo.undo(timeline);
    CHECK(!store[static_cast<size_t>(sampleId)].live, "undo tombstones the asset");

    undo.redo(timeline);
    CHECK(store[static_cast<size_t>(sampleId)].live, "redo restores it");
    CHECK_EQ(bakeCalls, 1, "…without re-baking — restoreFn ran, not bakeFn a second time");

    undo.undo(timeline);
    CHECK(!store[static_cast<size_t>(sampleId)].live, "undo again tombstones it again");
    undo.redo(timeline);
    CHECK(store[static_cast<size_t>(sampleId)].live, "…and a second redo restores it again");

    // A bake whose composite came back empty must not consume an undo step.
    const int depthBefore = undo.getUndoCount();
    BakeSandboxCompositeCommand::BakeFn emptyBakeFn = []() -> int { return -1; };
    undo.execute(std::make_unique<BakeSandboxCompositeCommand>(
                     "empty", emptyBakeFn, BakeSandboxCompositeCommand::UndoFn{},
                     BakeSandboxCompositeCommand::RestoreFn{}),
                 timeline);
    CHECK_EQ(undo.getUndoCount(), depthBefore, "an empty composite is NOT recorded in history");
}

// ---------------------------------------------------------------------------
// SandboxRenderer — composite mixing (SB-5)
// ---------------------------------------------------------------------------
//
// THE DELIVERABLE FIXTURE: 3 layers — one plain, one reversed, one offset
// +12ms — bakes to a composite whose rendered length/level match expectation.

static void testCompositeMixing() {
    std::cout << "\n[SandboxRenderer — composite mixing]\n";

    const int64_t offsetSamplesC = static_cast<int64_t>(0.012 * kTestRate);   // 12ms @ 48kHz = 576
    CHECK_EQ(offsetSamplesC, int64_t(576), "fixture sanity: 12ms @ 48kHz is 576 samples");

    auto layerA = std::make_shared<const SandboxBuffer>(makeConst(1, 1000, 0.4f));

    SandboxBuffer bRamp = makeRamp(1, 500);
    { float* d = bRamp.getWritePointer(0); std::reverse(d, d + 500); }
    auto layerB = std::make_shared<const SandboxBuffer>(std::move(bRamp));   // the REVERSED layer

    auto layerC = std::make_shared<const SandboxBuffer>(makeConst(1, 1000, 0.3f));   // the OFFSET +12ms layer

    std::vector<SandboxLayerMixInput> mix = {
        { layerA, kTestRate, 0.0, 0.0, 0,             false, false },
        { layerB, kTestRate, 0.0, 0.0, 0,             false, false },
        { layerC, kTestRate, 0.0, 0.0, offsetSamplesC, false, false },
    };

    auto composite = SandboxRenderer::renderComposite(mix);
    CHECK(composite.valid(), "composite renders");
    CHECK_EQ(composite.buffer->getNumSamples(), 1576,
             "length = the offset layer's start (576) + its own length (1000) — the longest span");
    CHECK_EQ(composite.buffer->getNumChannels(), 2, "composite is always stereo");
    CHECK_NEAR(composite.sampleRate, kTestRate, 1e-9, "composite rate = the (only) rate present");
    CHECK_EQ(composite.layersMixed, 3, "all three layers are unmuted and unsoloed — all three mixed");

    const double centerGain = std::cos(3.14159265358979323846 / 4.0);   // pan=0 → both channels equal
    const float* outL = composite.buffer->getReadPointer(0);
    const float* outR = composite.buffer->getReadPointer(1);

    // Sample 0: A[0]=0.4 + the REVERSED layer's first sample, which is its
    // source ramp's LAST sample (499/10000) — proves reversal survived into
    // the mix untouched, since renderComposite just sums whatever buffer it
    // is handed.
    {
        const float expected = static_cast<float>((0.4 + 499.0 / 10000.0) * centerGain);
        CHECK_NEAR(outL[0], expected, 1e-4, "sample 0 sums A + reversed-B's first (= B's original last) sample");
        CHECK_NEAR(outR[0], expected, 1e-4, "…identically on R at pan=0");
    }
    // Sample 700: B has ended (700 >= 500); A still active; C (started at 576,
    // local index 124) is constant 0.3.
    {
        const float expected = static_cast<float>((0.4 + 0.3) * centerGain);
        CHECK_NEAR(outL[700], expected, 1e-4, "sample 700: A + the offset layer C, B already ended");
    }
    // Sample 1200: A ended at 1000, B ended at 500 — only the delayed layer
    // C is still sounding. This is the offset test: without a working delay,
    // C would already have ended too (576+1000=1576 > 1200, so it hasn't).
    {
        const float expected = static_cast<float>(0.3 * centerGain);
        CHECK_NEAR(outL[1200], expected, 1e-4,
                   "past every other layer's end, only the +12ms-delayed layer still sounds");
    }
    // The composite's very last sample is the offset layer's own last sample.
    {
        const float expected = static_cast<float>(0.3 * centerGain);
        CHECK_NEAR(outL[1575], expected, 1e-4, "the composite's last sample is C's own last sample");
    }

    // ── Solo: only B plays ──
    mix[1].soloed = true;
    auto soloed = SandboxRenderer::renderComposite(mix);
    CHECK_EQ(soloed.layersMixed, 1, "soloing one layer excludes the other two");
    {
        const float expected = static_cast<float>((499.0 / 10000.0) * centerGain);
        CHECK_NEAR(soloed.buffer->getReadPointer(0)[0], expected, 1e-4, "…and only its own audio sounds");
    }
    mix[1].soloed = false;

    // ── Mute always wins over solo, for that one layer ──
    mix[1].soloed = true;
    mix[1].muted  = true;
    auto muted = SandboxRenderer::renderComposite(mix);
    CHECK_EQ(muted.layersMixed, 0, "soloed-but-muted excludes itself AND every non-soloed layer");
    CHECK_EQ(muted.buffer->getNumSamples(), 1576,
             "…but composite LENGTH still reflects every layer, muted or not");
    CHECK_NEAR(muted.buffer->getReadPointer(0)[700], 0.0f, 1e-6, "and it is genuinely silent, not just empty");
    mix[1].soloed = false;
    mix[1].muted  = false;

    // ── Gain (dB) + hard pan, isolated from the overlap geometry above ──
    {
        auto solo = std::make_shared<const SandboxBuffer>(makeConst(1, 10, 1.0f));
        std::vector<SandboxLayerMixInput> one = { { solo, kTestRate, -6.0, 1.0, 0, false, false } };
        auto r = SandboxRenderer::renderComposite(one);
        CHECK(r.valid(), "single-layer composite renders");
        const float expectedGain = static_cast<float>(std::pow(10.0, -6.0 / 20.0));   // ≈ 0.50119
        CHECK_NEAR(r.buffer->getReadPointer(0)[0], 0.0f, 1e-4, "hard pan-right: L channel is silent");
        CHECK_NEAR(r.buffer->getReadPointer(1)[0], expectedGain, 1e-4, "…and R carries the full -6dB gain");
    }

    // ── Edge cases ──
    CHECK(!SandboxRenderer::renderComposite({}).valid(), "an empty layer list is an invalid composite");
    {
        auto empty = std::make_shared<const SandboxBuffer>(SandboxBuffer(1, 0));
        std::vector<SandboxLayerMixInput> zero = { { empty, kTestRate, 0.0, 0.0, 0, false, false } };
        CHECK(!SandboxRenderer::renderComposite(zero).valid(),
              "a layer whose stack trimmed itself to zero length contributes nothing to mix");
    }
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

    // ── PASTE, insert-silence (clipboardId -1 is the INSERT SILENCE case) ──
    {
        SandboxRenderResult r = renderer.renderStack(
            14, src, { makeOp(1, SandboxOpType::Paste, PasteParams{ 200, -1, 50, true }) }, kTestRate);
        CHECK_EQ(r.buffer->getNumSamples(), 1050, "PASTE insert grows the buffer by clipboardLengthSamples");
        CHECK_NEAR(r.buffer->getSample(0, 199), src.getSample(0, 199), 1e-9, "material before the insert point is intact");
        CHECK_NEAR(r.buffer->getSample(0, 200), 0.0, 1e-9, "an unresolved clipboardId inserts SILENCE");
        CHECK_NEAR(r.buffer->getSample(0, 249), 0.0, 1e-9, "…for the full requested length");
        CHECK_NEAR(r.buffer->getSample(0, 250), src.getSample(0, 200), 1e-9, "material after the insert resumes exactly at the old position");
    }

    // ── PASTE, overwrite-with-silence ──
    {
        SandboxRenderResult r = renderer.renderStack(
            15, src, { makeOp(1, SandboxOpType::Paste, PasteParams{ 200, -1, 50, false }) }, kTestRate);
        CHECK_EQ(r.buffer->getNumSamples(), 1000, "PASTE overwrite preserves length");
        CHECK_NEAR(r.buffer->getSample(0, 225), 0.0, 1e-9, "the overwritten range is silent");
        CHECK_NEAR(r.buffer->getSample(0, 250), src.getSample(0, 250), 1e-9, "material after the range is untouched (no shift)");
    }

    // ── PASTE, real clipboard content (CUT/COPY/PASTE round trip) ──
    {
        const int clipId = renderer.captureClipboard(src, 300, 350);
        CHECK(clipId >= 0, "captureClipboard returns a valid id for a real range");
        SandboxBufferPtr clip = renderer.clipboardBuffer(clipId);
        CHECK(clip != nullptr, "the captured buffer resolves");
        if (clip) CHECK_EQ(clip->getNumSamples(), 50, "the captured clip is sample-exact");

        SandboxRenderResult r = renderer.renderStack(
            16, src, { makeOp(1, SandboxOpType::Paste, PasteParams{ 0, clipId, 50, true }) }, kTestRate);
        CHECK_EQ(r.buffer->getNumSamples(), 1050, "pasting a real clip still predicts by clipboardLengthSamples");
        CHECK_NEAR(r.buffer->getSample(0, 0),  src.getSample(0, 300), 1e-9, "pasted audio IS the copied range (sample-accurate)");
        CHECK_NEAR(r.buffer->getSample(0, 49), src.getSample(0, 349), 1e-9, "…through its last sample");
        CHECK_NEAR(r.buffer->getSample(0, 50), src.getSample(0, 0),   1e-9, "the original material resumes right after");

        CHECK(renderer.clipboardBuffer(999999) == nullptr, "an unknown clipboard id resolves to nullptr");
        CHECK(renderer.captureClipboard(src, 500, 500) < 0, "an empty range is not capturable");
    }

    // ── SPLICE, ripple: split and swap, no gap ──
    {
        SandboxRenderResult r = renderer.renderStack(
            17, src, { makeOp(1, SandboxOpType::Splice, SpliceParams{ 400, SandboxRippleMode::Ripple, 0 }) },
            kTestRate);
        CHECK_EQ(r.buffer->getNumSamples(), 1000, "ripple SPLICE preserves length");
        CHECK_NEAR(r.buffer->getSample(0, 0),   src.getSample(0, 400), 1e-9, "output starts with the TAIL");
        CHECK_NEAR(r.buffer->getSample(0, 599), src.getSample(0, 999), 1e-9, "…through the old end");
        CHECK_NEAR(r.buffer->getSample(0, 600), src.getSample(0, 0),   1e-9, "…then the HEAD resumes");
        CHECK_NEAR(r.buffer->getSample(0, 999), src.getSample(0, 399), 1e-9, "…up to the split point");
    }

    // ── SPLICE, gap: split, swap, and open a gap at the new seam ──
    {
        SandboxRenderResult r = renderer.renderStack(
            18, src, { makeOp(1, SandboxOpType::Splice, SpliceParams{ 400, SandboxRippleMode::Gap, 100 }) },
            kTestRate);
        CHECK_EQ(r.buffer->getNumSamples(), 1100, "gap SPLICE grows the buffer by gapSamples");
        CHECK_NEAR(r.buffer->getSample(0, 599), src.getSample(0, 999), 1e-9, "the tail still ends where ripple mode left it");
        CHECK_NEAR(r.buffer->getSample(0, 650), 0.0, 1e-9, "the gap itself is silent");
        CHECK_NEAR(r.buffer->getSample(0, 700), src.getSample(0, 0),   1e-9, "the head starts right after the gap");
    }

    // ── CROSSFADE: declicks a hard discontinuity at the seam ──
    {
        SandboxBuffer click(1, 1000);
        for (int i = 0; i < 1000; ++i) click.setSample(0, i, i < 500 ? -1.0f : 1.0f);

        SandboxRenderResult r = renderer.renderStack(
            19, click, { makeOp(1, SandboxOpType::Crossfade, CrossfadeParams{ 500, 100, SandboxFadeShape::Hann }) },
            kTestRate);
        CHECK_NEAR(r.buffer->getSample(0, 500), 0.0, 1e-6, "the seam sample itself lands at exactly zero — every shape's curve is 0 at t=0");
        CHECK(std::fabs(r.buffer->getSample(0, 499)) < 0.1, "just before the seam the discontinuity is masked, not audible");
        CHECK(std::fabs(r.buffer->getSample(0, 500)) < 0.1, "…and just after it too");
        CHECK_NEAR(r.buffer->getSample(0, 450), -1.0, 1e-6, "the window's far edge is untouched (gain 1)");
        CHECK_NEAR(r.buffer->getSample(0, 0),   -1.0, 1e-9, "material well outside the window is untouched");
        CHECK_NEAR(r.buffer->getSample(0, 999),  1.0, 1e-9, "…on both sides");
    }

    // ── Bypass and stubs are exact pass-throughs ──
    {
        SandboxOp bypassed = makeOp(1, SandboxOpType::Gain, GainParams{ 0, -1, -60.0, false, 0.0 });
        bypassed.enabled = false;
        SandboxRenderResult r = renderer.renderStack(11, src, { bypassed }, kTestRate);
        CHECK_NEAR(r.buffer->getSample(0, 500), src.getSample(0, 500), 1e-9,
                   "a bypassed op passes audio through untouched");

        SandboxRenderResult s = renderer.renderStack(
            12, src, { makeOp(1, SandboxOpType::Stretch, StretchParams{ 1.5, 0 }) }, kTestRate);
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
// SB-6 — durable source reference, swap-in command, undo domains
// ---------------------------------------------------------------------------

static void testDurableSourceRef() {
    std::cout << "\n[SandboxLayer — durable source reference (SB-6)]\n";

    SandboxCore core;
    const int withFile = core.addLayer("vox", 7, kTestRate, "C:/proj/media/vox.wav", 1.25, 3.5);
    const int noFile   = core.addLayer("bake", 9, kTestRate);

    CHECK(core.findLayer(withFile)->hasDurableSource(),
          "a layer opened over a real file has a durable source");
    CHECK(!core.findLayer(noFile)->hasDurableSource(),
          "a layer over an in-memory asset (a composite bake) does not");

    // An empty range is not a usable reference even with a path — loading it
    // would decode zero samples, which is worse than reporting unresolved.
    core.setLayerSourceRef(noFile, "C:/proj/media/x.wav", 2.0, 2.0);
    CHECK(!core.findLayer(noFile)->hasDurableSource(),
          "a zero-length time range does not count as a durable source");

    CHECK(core.setLayerSourceRef(withFile, "C:/proj/swapped/vox_swapped.wav", 0.0, 2.25),
          "setLayerSourceRef accepts a real change");
    CHECK(!core.setLayerSourceRef(withFile, "C:/proj/swapped/vox_swapped.wav", 0.0, 2.25),
          "…and rejects a rewrite of the value it already holds");

    // The source REFERENCE is bookkeeping about provenance; only the buffer
    // moving invalidates a render.
    core.addOp(withFile, makeOp(0, SandboxOpType::Reverse, ReverseParams{ 0, -1 }), -1);
    core.markLayerRendered(withFile);
    CHECK(core.findLayer(withFile)->clean(), "the layer starts clean");
    core.setLayerSourceRef(withFile, "C:/proj/other.wav", 0.0, 1.0);
    CHECK(core.findLayer(withFile)->clean(),
          "changing only the source REFERENCE does not dirty the stack");
    core.setLayerSource(withFile, 12, kTestRate);
    CHECK(!core.findLayer(withFile)->clean(),
          "…but changing the bound BUFFER does");

    // ── Round-trip ───────────────────────────────────────────────────────────
    SandboxCore src;
    const int l = src.addLayer("kick", 3, kTestRate, "C:/proj/media/kick.wav", 0.5, 1.75);
    src.addOp(l, makeOp(0, SandboxOpType::Trim, TrimParams{ 100, 900 }), -1);

    SandboxCore loaded;
    int version = -1;
    CHECK(loaded.fromJson(src.toJson(), &version, nullptr), "workspace with a source ref parses");
    CHECK_EQ(version, 2, "sandboxStackVersion is 2 now that layers carry a source ref");
    const SandboxLayer* rl = loaded.findLayer(l);
    CHECK(rl != nullptr, "the layer round-trips");
    CHECK_EQ(rl->sourceFilePath, std::string("C:/proj/media/kick.wav"), "sourceFilePath round-trips");
    CHECK_NEAR(rl->sourceStartTime, 0.5, 1e-12, "sourceStartTime round-trips");
    CHECK_NEAR(rl->sourceEndTime, 1.75, 1e-12, "sourceEndTime round-trips");
    CHECK_EQ(rl->sourceBufferId, 3,
             "sourceBufferId also reads back verbatim — in-process round-trip is lossless");

    // …which is exactly why project load must NOT trust it. SampleBank ids are
    // minted fresh on every load, so the id in the file names another project's
    // audio; unbindAllSources is the explicit step that drops it.
    loaded.markLayerRendered(l);
    loaded.unbindAllSources();
    CHECK_EQ(loaded.findLayer(l)->sourceBufferId, -1,
             "unbindAllSources drops the stale SampleBank id");
    CHECK_EQ(loaded.findLayer(l)->bufferSampleRate, 0.0,
             "…and the rate that went with it");
    CHECK(!loaded.findLayer(l)->clean(),
          "…and marks the whole stack dirty, so nothing renders off the old buffer");
    CHECK_EQ(loaded.findLayer(l)->ops.size(), size_t(1),
          "the op-stack survives unbinding — it is the BINDING that is lost, never the edit");
    CHECK(loaded.findLayer(l)->hasDurableSource(),
          "…and the durable reference survives, so the owner can re-resolve it");

    // A v1 workspace (no source-ref keys at all) still loads.
    nlohmann::json v1 = {
        { "sandboxStackVersion", 1 },
        { "nextLayerId", 2 },
        { "layers", nlohmann::json::array({ nlohmann::json{
            { "id", 1 }, { "name", "legacy" }, { "sourceBufferId", 4 },
            { "bufferSampleRate", kTestRate }, { "ops", nlohmann::json::array() } } }) }
    };
    SandboxCore legacy;
    int v1Version = -1;
    CHECK(legacy.fromJson(v1, &v1Version, nullptr), "a v1 workspace still parses");
    CHECK_EQ(v1Version, 1, "…and reports its own version");
    CHECK_EQ(legacy.layerCount(), size_t(1), "…with its layer intact");
    CHECK(!legacy.findLayer(1)->hasDurableSource(),
          "…and no durable source, so it reloads unbound rather than guessing");
}

static void testSwapInCommand() {
    std::cout << "\n[SwapSandboxSampleCommand — undo/redo]\n";

    Timeline    timeline;
    UndoManager undo;

    // Fake binding store standing in for MixEngine::regionToSampleMap_ plus the
    // region's swapped-audio fields — the whole of what a swap changes. Same
    // rationale as testBakeCompositeCommand's fake asset store: proves the
    // command's contract without dragging in the audio tier.
    struct Binding { int sampleId = -1; std::string path; };
    Binding live{ 100, "" };            // the region's original audio
    int swapCalls = 0, applyCalls = 0, revertCalls = 0;

    const Binding before = live;

    SwapSandboxSampleCommand::SwapFn swapFn = [&]() -> int {
        ++swapCalls;
        live = Binding{ 200, "swapped/sandbox_r5_1.wav" };
        return live.sampleId;
    };
    SwapSandboxSampleCommand::RevertFn revertFn = [&]() -> bool {
        ++revertCalls; live = before; return true;
    };
    SwapSandboxSampleCommand::ApplyFn applyFn = [&](int id) -> bool {
        ++applyCalls; live = Binding{ id, "swapped/sandbox_r5_1.wav" }; return true;
    };

    auto cmd = std::make_unique<SwapSandboxSampleCommand>(
        "vox", /*trackId*/ 3, /*regionId*/ 5, swapFn, revertFn, applyFn);
    SwapSandboxSampleCommand* raw = cmd.get();
    undo.execute(std::move(cmd), timeline);

    CHECK_EQ(raw->swappedSampleId(), 200, "the swap reports the new sample id");
    CHECK_EQ(raw->trackId(), 3, "…and echoes the trackId it was addressed with");
    CHECK_EQ(raw->regionId(), 5, "…and the regionId");
    CHECK_EQ(swapCalls, 1, "swapFn ran exactly once");
    CHECK_EQ(live.sampleId, 200, "the binding now points at the sandbox output");
    CHECK_EQ(undo.getUndoCount(), 1, "the swap is on the undo stack");
    CHECK_EQ(undo.getUndoDomain(), std::string("sandbox"),
             "…tagged as a sandbox edit, so the Sandbox panel's Undo may take it");

    undo.undo(timeline);
    CHECK_EQ(revertCalls, 1, "undo runs revertFn");
    CHECK_EQ(live.sampleId, 100, "undo restores the ORIGINAL sample");
    CHECK_EQ(live.path, std::string(""), "…including its swapped-audio state");

    undo.redo(timeline);
    CHECK_EQ(live.sampleId, 200, "redo re-applies the swap");
    CHECK_EQ(swapCalls, 1, "…WITHOUT re-rendering — applyFn ran, not swapFn a second time");
    CHECK_EQ(applyCalls, 1, "applyFn ran exactly once");

    undo.undo(timeline);
    CHECK_EQ(live.sampleId, 100, "a second undo restores the original again");
    undo.redo(timeline);
    CHECK_EQ(live.sampleId, 200, "…and a second redo re-applies the swap again");
    CHECK_EQ(swapCalls, 1, "still exactly one render for the whole undo/redo cycle");

    // A swap that could not produce a buffer must not consume an undo step.
    const int depthBefore = undo.getUndoCount();
    SwapSandboxSampleCommand::SwapFn failFn = []() -> int { return -1; };
    undo.execute(std::make_unique<SwapSandboxSampleCommand>(
                     "doomed", 3, 5, failFn,
                     SwapSandboxSampleCommand::RevertFn{},
                     SwapSandboxSampleCommand::ApplyFn{}),
                 timeline);
    CHECK_EQ(undo.getUndoCount(), depthBefore, "a failed swap is NOT recorded in history");
    CHECK_EQ(live.sampleId, 200, "…and leaves the live binding untouched");
}

static void testUndoDomains() {
    std::cout << "\n[Command::domain — one shared stack, two surfaces]\n";

    Timeline    timeline;
    UndoManager undo;
    SandboxCore core;

    // A stand-in timeline edit: any command that does NOT override domain().
    struct PlainCommand : public Command {
        void        execute(Timeline&) override {}
        void        undo(Timeline&) override {}
        std::string describe() const override { return "Move Clip"; }
    };

    const int layerId = core.addLayer("vox", 7, kTestRate);
    undo.execute(std::make_unique<AddSandboxOpCommand>(
                     core, layerId, makeOp(0, SandboxOpType::Reverse, ReverseParams{ 0, -1 }), -1),
                 timeline);
    CHECK_EQ(undo.getUndoDomain(), std::string("sandbox"), "a sandbox op edit is domain 'sandbox'");

    undo.execute(std::make_unique<PlainCommand>(), timeline);
    CHECK_EQ(undo.getUndoDomain(), std::string("timeline"),
             "a command that does not override domain() defaults to 'timeline'");
    CHECK_EQ(undo.getUndoDescription(), std::string("Move Clip"),
             "…and the panel can say WHAT is on top instead of undoing it blindly");

    CHECK_EQ(undo.countByDomain("sandbox"), 1, "one sandbox entry on the shared stack");
    CHECK_EQ(undo.countByDomain("timeline"), 1, "one timeline entry");

    const auto hist = undo.getUndoHistory();
    CHECK_EQ(hist.size(), size_t(2), "the history snapshot has both entries");
    CHECK_EQ(hist.front().domain, std::string("sandbox"), "history is OLDEST first");
    CHECK_EQ(hist.back().domain, std::string("timeline"), "…so the LAST entry is the next undo");

    undo.undo(timeline);
    CHECK_EQ(undo.getRedoDomain(), std::string("timeline"), "the redo side is tagged too");
    CHECK_EQ(undo.getUndoDomain(), std::string("sandbox"),
             "…and the sandbox edit is now what an Undo would take");

    // Every sandbox command type carries the tag, not just the one above.
    undo.execute(std::make_unique<SetSandboxLayerMutedCommand>(core, layerId, true), timeline);
    CHECK_EQ(undo.getUndoDomain(), std::string("sandbox"), "layer mix/mute commands are tagged too");
    undo.execute(std::make_unique<RemoveSandboxLayerCommand>(core, layerId), timeline);
    CHECK_EQ(undo.getUndoDomain(), std::string("sandbox"), "layer lifecycle commands are tagged too");
}

// ---------------------------------------------------------------------------
// GAIN ENVELOPE — normalization, the curve itself, and the headline gesture:
// a duck drawn over a spike actually ducks the spike.
// ---------------------------------------------------------------------------

static void testGainEnvelope() {
    std::cout << "\n[GainEnvelope]\n";

    // ── normalizeGainEnvelope ──
    {
        GainEnvelopeParams p{ { {500, -6.0}, {100, 0.0}, {500, -12.0}, {-7, 3.0}, {900, 999.0} } };
        normalizeGainEnvelope(p);
        CHECK_EQ(p.points.size(), size_t(3), "a negative position is dropped and a duplicate collapses");
        CHECK_EQ(p.points[0].samplePos, int64_t(100), "points come back sorted by position");
        CHECK_EQ(p.points[1].samplePos, int64_t(500), "…ascending");
        CHECK_NEAR(p.points[1].db, -12.0, 1e-12,
                   "of two points at the same position the LAST written wins");
        CHECK_NEAR(p.points[2].db, kGainEnvelopeMaxDb, 1e-12,
                   "an out-of-range dB is clamped, not rejected");
    }

    // ── The curve ──
    {
        const GainEnvelopeParams empty{};
        CHECK_NEAR(gainEnvelopeAt(empty, 0),    1.0, 1e-12, "an empty envelope is unity — a pass-through");
        CHECK_NEAR(gainEnvelopeAt(empty, 9999), 1.0, 1e-12, "…at every position");

        const GainEnvelopeParams one{ { {5000, -6.0} } };
        const double sixDown = std::pow(10.0, -6.0 / 20.0);
        CHECK_NEAR(gainEnvelopeAt(one, 0),     sixDown, 1e-9, "a single point is a plain constant gain");
        CHECK_NEAR(gainEnvelopeAt(one, 99999), sixDown, 1e-9, "…everywhere, before and after it");

        const GainEnvelopeParams ramp{ { {0, 0.0}, {1000, -12.0} } };
        CHECK_NEAR(gainEnvelopeAt(ramp, 0),    1.0, 1e-9, "the curve hits its first breakpoint exactly");
        CHECK_NEAR(gainEnvelopeAt(ramp, 1000), std::pow(10.0, -12.0 / 20.0), 1e-9,
                   "…and its last exactly");
        // Smoothstep at t=0.5 is 0.5, so the midpoint is the dB midpoint — this
        // is the check that says the interpolation happens in dB, not in linear
        // gain (which would land at -3.5 dB, not -6).
        CHECK_NEAR(gainEnvelopeAt(ramp, 500), std::pow(10.0, -6.0 / 20.0), 1e-9,
                   "the midpoint is -6 dB — interpolation is in dB, matching the line the UI draws");
        CHECK_NEAR(gainEnvelopeAt(ramp, -50), 1.0, 1e-9,
                   "before the first point the curve is HELD, not extrapolated");
        CHECK_NEAR(gainEnvelopeAt(ramp, 5000), std::pow(10.0, -12.0 / 20.0), 1e-9,
                   "after the last point it is held too");

        // Zero slope at every breakpoint is what makes the composed curve C1 —
        // the reason there is no zipper to dezipper. Sample either side of an
        // interior handle and both one-sample slopes must be ~0.
        const GainEnvelopeParams vee{ { {0, 0.0}, {1000, -24.0}, {2000, 0.0} } };
        const double slopeBefore = gainEnvelopeAt(vee, 1000) - gainEnvelopeAt(vee, 999);
        const double slopeAfter  = gainEnvelopeAt(vee, 1001) - gainEnvelopeAt(vee, 1000);
        CHECK(std::abs(slopeBefore) < 1e-5 && std::abs(slopeAfter) < 1e-5,
              "the curve has ~zero slope on both sides of an interior breakpoint");

        const GainEnvelopeParams mute{ { {0, kGainEnvelopeMinDb} } };
        CHECK_NEAR(gainEnvelopeAt(mute, 0), 0.0, 1e-12,
                   "the dB floor is EXACT silence, not 1.6e-5 of noise");
    }

    // ── mode / follower params ──
    {
        GainEnvelopeParams p{ { {0, 0.0} }, SandboxGainEnvelopeMode::Absolute, 5.0, 150.0 };
        CHECK(p.mode == SandboxGainEnvelopeMode::Absolute, "default-constructed field order still puts mode where the aggregate init above expects it");

        GainEnvelopeParams wild{};
        wild.mode              = static_cast<SandboxGainEnvelopeMode>(7);   // not a declared enumerator
        wild.followerAttackMs  = -50.0;                                    // below the floor
        wild.followerReleaseMs = 999999.0;                                 // above the ceiling
        normalizeGainEnvelope(wild);
        CHECK(wild.mode == SandboxGainEnvelopeMode::Absolute, "an out-of-range mode repairs to Absolute, not UB");
        CHECK_NEAR(wild.followerAttackMs, kGainEnvelopeMinAttackMs, 1e-12, "attack is clamped to its floor");
        CHECK_NEAR(wild.followerReleaseMs, kGainEnvelopeMaxReleaseMs, 1e-12, "release is clamped to its ceiling");

        // gainEnvelopeAt / gainEnvelopeDbAt are mode-agnostic — mode only
        // changes how SandboxRenderer APPLIES the curve, not what the curve
        // itself evaluates to at a position.
        const GainEnvelopeParams ramp{ { {0, 0.0}, {1000, -12.0} }, SandboxGainEnvelopeMode::Relative, 5.0, 150.0 };
        CHECK_NEAR(gainEnvelopeDbAt(ramp, 500), -6.0, 1e-9,
                   "gainEnvelopeDbAt agrees with gainEnvelopeAt's dB-domain midpoint");
        CHECK_NEAR(gainEnvelopeAt(ramp, 500), std::pow(10.0, -6.0 / 20.0), 1e-9,
                   "…converted through the same exact-silence-floor rule as Absolute");
    }

    // ── JSON round-trip ──
    {
        SandboxOp op = makeOp(1, SandboxOpType::GainEnvelope,
                              GainEnvelopeParams{ { {0, 0.0}, {2400, -21.5}, {7200, 6.25} },
                                                  SandboxGainEnvelopeMode::Relative, 8.0, 220.0 });
        SandboxOp back;
        CHECK(opFromJson(opToJson(op), back), "a gain-envelope op parses back");
        CHECK(back.params == op.params, "every breakpoint round-trips losslessly (position AND dB)");
        CHECK(std::get<GainEnvelopeParams>(back.params).mode == SandboxGainEnvelopeMode::Relative,
              "mode round-trips too");
        CHECK_NEAR(std::get<GainEnvelopeParams>(back.params).followerAttackMs, 8.0, 1e-12,
                   "…and the follower times");
        CHECK_EQ(back.contentHash(), op.contentHash(), "…so the reloaded op hits the same cache entry");

        // A file written before Mode 2 existed has neither field: it must load
        // as Absolute with the stock follower defaults, not fail to parse.
        nlohmann::json legacy = opToJson(op);
        legacy["params"].erase("mode");
        legacy["params"].erase("followerAttackMs");
        legacy["params"].erase("followerReleaseMs");
        SandboxOp fromLegacy;
        CHECK(opFromJson(legacy, fromLegacy), "a pre-Mode-2 file still parses");
        const auto& legacyParams = std::get<GainEnvelopeParams>(fromLegacy.params);
        CHECK(legacyParams.mode == SandboxGainEnvelopeMode::Absolute, "…defaulting to Absolute");
        CHECK_NEAR(legacyParams.followerAttackMs, kGainEnvelopeDefaultAttackMs, 1e-12,
                   "…and the stock follower defaults");

        // Flipping mode alone, with the curve untouched, must still invalidate
        // the render cache — it changes the audio just as much as a breakpoint
        // edit would.
        SandboxOp absoluteTwin = op;
        std::get<GainEnvelopeParams>(absoluteTwin.params).mode = SandboxGainEnvelopeMode::Absolute;
        CHECK(absoluteTwin.contentHash() != op.contentHash(),
              "mode alone changes the content hash");
        SandboxOp slowerRelease = op;
        std::get<GainEnvelopeParams>(slowerRelease.params).followerReleaseMs = 500.0;
        CHECK(slowerRelease.contentHash() != op.contentHash(),
              "retuning the follower alone changes the content hash too");

        // Point count is part of the digest: dropping one must not collide.
        SandboxOp fewer = op;
        std::get<GainEnvelopeParams>(fewer.params).points.pop_back();
        CHECK(fewer.contentHash() != op.contentHash(), "removing a breakpoint changes the content hash");

        // An unsorted curve out of a hand-edited file is repaired on read.
        nlohmann::json wild = opToJson(op);
        wild["params"]["points"] = nlohmann::json::array({
            nlohmann::json{ {"samplePos", 7200}, {"db", 6.25} },
            nlohmann::json{ {"samplePos", 0},    {"db", 0.0}  },
            nlohmann::json{ {"samplePos", 2400}, {"db", -21.5} },
        });
        SandboxOp repaired;
        CHECK(opFromJson(wild, repaired), "an unsorted curve still parses");
        CHECK(repaired.params == op.params, "…and comes back normalized into the same curve");
    }

    // ── THE DELIVERABLE: a duck drawn over a spike ducks the spike ──
    // A flat 0.5 bed with a 1.0 spike at 2000..3000, and a curve that sits at
    // unity, dives to -20 dB across the spike, and comes back.
    {
        SandboxBuffer src = makeConst(2, 6000, 0.5f);
        for (int ch = 0; ch < 2; ++ch)
            for (int i = 2000; i < 3000; ++i) src.setSample(ch, i, 1.0f);

        SandboxRenderer renderer;
        const GainEnvelopeParams duck{ { {1500, 0.0}, {2000, -20.0}, {3000, -20.0}, {3500, 0.0} } };
        SandboxRenderResult r = renderer.renderStack(
            900, src, { makeOp(1, SandboxOpType::GainEnvelope, duck) }, kTestRate);

        CHECK(r.valid(), "the envelope renders");
        CHECK_EQ(r.buffer->getNumSamples(), 6000, "length is untouched");
        CHECK_NEAR(r.buffer->getSample(0, 0),    0.5f, 1e-6,
                   "material before the curve starts is at unity, unchanged");
        CHECK_NEAR(r.buffer->getSample(0, 5999), 0.5f, 1e-6, "…and after it ends");

        const float duckedPeak = r.buffer->getSample(0, 2500);
        CHECK_NEAR(duckedPeak, static_cast<float>(std::pow(10.0, -20.0 / 20.0)), 1e-5,
                   "the spike is ducked by exactly the 20 dB drawn over it");
        CHECK(duckedPeak < 0.5f, "…so the spike now sits BELOW the surrounding bed");
        CHECK_NEAR(r.buffer->getSample(1, 2500), duckedPeak, 1e-9,
                   "both channels get the same gain — a duck never shifts the stereo image");

        // Bypass is the same pass-through every other op gets.
        SandboxOp bypassed = makeOp(1, SandboxOpType::GainEnvelope, duck);
        bypassed.enabled = false;
        SandboxRenderResult rb = renderer.renderStack(901, src, { bypassed }, kTestRate);
        CHECK(rb.valid(), "a bypassed envelope still renders");
        CHECK_NEAR(rb.buffer->getSample(0, 2500), 1.0f, 1e-6,
                   "bypass removes the duck entirely — the spike is back at full scale");
    }

    // ── Undo of a curve edit restores the previous curve, not the default ──
    {
        Timeline timeline;
        UndoManager undo;
        SandboxCore core;

        const int layerId = core.addLayer("env", 1, kTestRate);
        SandboxOp op = makeOp(0, SandboxOpType::GainEnvelope,
                              GainEnvelopeParams{ { {0, 0.0}, {1000, -6.0} } });
        int opId = 0;
        CHECK(core.addOp(layerId, op, -1, &opId), "the envelope op is added");

        const GainEnvelopeParams edited{ { {0, 0.0}, {1000, -30.0}, {2000, 0.0} } };
        undo.execute(std::make_unique<SetSandboxOpParamsCommand>(core, layerId, opId, edited),
                     timeline);
        CHECK_EQ(std::get<GainEnvelopeParams>(
                     core.findLayer(layerId)->findOp(opId)->params).points.size(), size_t(3),
                 "the edited curve is what the core holds");

        undo.undo(timeline);
        const auto& afterUndo = std::get<GainEnvelopeParams>(
            core.findLayer(layerId)->findOp(opId)->params);
        CHECK_EQ(afterUndo.points.size(), size_t(2), "undo restores the PREVIOUS curve");
        CHECK_NEAR(afterUndo.points[1].db, -6.0, 1e-12, "…breakpoint for breakpoint");

        undo.redo(timeline);
        CHECK_EQ(std::get<GainEnvelopeParams>(
                     core.findLayer(layerId)->findOp(opId)->params).points.size(), size_t(3),
                 "redo re-applies the edit");
    }
}

// ---------------------------------------------------------------------------
// GAIN ENVELOPE, Mode 2 (Relative) — the same dip drawn over a transient ducks
// the transient without flattening the quiet material sharing its window,
// which is the whole reason Mode 2 exists over Mode 1.
// ---------------------------------------------------------------------------

static double computeRms(const SandboxBuffer& b, int channel, int64_t start, int64_t end) {
    double acc = 0.0;
    const int64_t n = end - start;
    if (n <= 0) return 0.0;
    for (int64_t i = start; i < end; ++i) {
        const double s = b.getSample(channel, static_cast<int>(i));
        acc += s * s;
    }
    return std::sqrt(acc / static_cast<double>(n));
}

static void testGainEnvelopeRelativeMode() {
    std::cout << "\n[GainEnvelope — Relative mode]\n";

    // A quiet bed (0.1) the whole way through, with one loud transient (0.9)
    // sitting inside a dip drawn wide enough to cover the ramp leading up to
    // it too — the exact shape a hand-drawn dip has in practice, since nobody
    // draws a duck that starts and ends exactly on the transient's own edges.
    //
    //   samples   0 ......... 3000 ......... 6000 ... 7000 ......... 10000 .. 12000
    //   signal    |---- bed 0.1 ----|-- bed 0.1 --|-- SPIKE 0.9 --|-- bed 0.1 --|
    //   drawn dB  |------ 0 dB -----|--- ramp --> -20 dB flat --> ramp ---|-- 0 dB --|
    //
    // The bed is CONSTANT from sample 0, so with the default 5ms attack the
    // follower is pinned to it (exactly, once seeded — see
    // gainEnvelopeFollowerDb) well before the ramp even starts at 3000. That
    // pins the buffer's envelope MINIMUM to the bed's own level, which is the
    // property this test leans on: material at the bed level normalizes to
    // exactly 0, so Relative mode applies exactly 0 dB to it regardless of
    // what the drawn curve says there.
    SandboxBuffer src = makeConst(2, 12000, 0.1f);
    for (int ch = 0; ch < 2; ++ch)
        for (int64_t i = 6000; i < 7000; ++i) src.setSample(ch, static_cast<int>(i), 0.9f);

    const GainEnvelopeParams dip{ { {3000, 0.0}, {6000, -20.0}, {7000, -20.0}, {10000, 0.0} },
                                  SandboxGainEnvelopeMode::Absolute,
                                  kGainEnvelopeDefaultAttackMs, kGainEnvelopeDefaultReleaseMs };
    GainEnvelopeParams relativeDip = dip;
    relativeDip.mode = SandboxGainEnvelopeMode::Relative;

    SandboxRenderer renderer;
    SandboxRenderResult absoluteResult = renderer.renderStack(
        2000, src, { makeOp(1, SandboxOpType::GainEnvelope, dip) }, kTestRate);
    SandboxRenderResult relativeResult = renderer.renderStack(
        2001, src, { makeOp(1, SandboxOpType::GainEnvelope, relativeDip) }, kTestRate);
    CHECK(absoluteResult.valid() && relativeResult.valid(), "both modes render");

    // ── Pre-transient ramp material (sample 4500, entirely bed-level) ──
    // Absolute has no idea 4500 is quiet material, not the transient — it
    // applies whatever the drawn ramp says there (halfway from 0 to -20 dB,
    // i.e. -10 dB, dB-domain smoothstep midpoint) regardless.
    const float wantAbsolute4500 = static_cast<float>(0.1 * std::pow(10.0, -10.0 / 20.0));
    CHECK_NEAR(absoluteResult.buffer->getSample(0, 4500), wantAbsolute4500, 1e-5,
               "Absolute cuts pre-transient bed material by the drawn ramp's dB, same as anything else under it");
    CHECK(absoluteResult.buffer->getSample(0, 4500) < 0.1f * 0.5f,
          "…enough of a cut that it clearly does not sound like untouched bed level");

    // Relative mode's follower has been pinned to the bed's own level since
    // before the ramp started, so normalized(4500) is exactly 0 — the drawn
    // -10 dB there multiplies by zero and vanishes.
    CHECK_NEAR(relativeResult.buffer->getSample(0, 4500), 0.1f, 1e-5,
               "Relative leaves pre-transient bed material at its natural level — nothing there is loud enough to trigger the duck");

    // ── The transient itself (sample 6500, mid-attack into the spike) ──
    // Both modes still duck it substantially: Absolute by exactly the drawn
    // -20 dB, Relative by very nearly as much once the follower has caught up
    // partway through the spike's own duration.
    const float wantAbsolute6500 = static_cast<float>(0.9 * std::pow(10.0, -20.0 / 20.0));
    CHECK_NEAR(absoluteResult.buffer->getSample(0, 6500), wantAbsolute6500, 1e-5,
               "Absolute ducks the transient by exactly the 20 dB drawn over it");
    const float relative6500 = relativeResult.buffer->getSample(0, 6500);
    CHECK(relative6500 < 0.9f * 0.3f,
          "Relative ducks the transient substantially too — this is not a bypass with extra steps");
    CHECK(relative6500 > wantAbsolute6500 * 0.5f,
          "…though not bit-identical to Absolute, since the follower is still mid-attack at this sample");

    // ── The deliverable, stated as one comparison ──
    // The SAME dip, drawn over the SAME material, leaves pre-transient bed
    // material far closer to its original level in Relative than in Absolute.
    CHECK(std::abs(relativeResult.buffer->getSample(0, 4500) - 0.1f)
              < std::abs(absoluteResult.buffer->getSample(0, 4500) - 0.1f),
          "Relative mode's pre-transient sample sits closer to the untouched bed level than Absolute's does");

    // ── Peak/RMS comparison over the whole pre-transient ramp window ──
    // [3000, 6000) is bed-only — no part of the transient itself is in this
    // range. Relative's RMS there should reproduce the untouched bed's RMS
    // (0.1) almost exactly; Absolute's is measurably pulled down by the ramp
    // it cannot tell apart from a real level change.
    const double rmsSrc      = computeRms(src, 0, 3000, 6000);
    const double rmsAbsolute = computeRms(*absoluteResult.buffer, 0, 3000, 6000);
    const double rmsRelative = computeRms(*relativeResult.buffer, 0, 3000, 6000);
    CHECK_NEAR(rmsRelative, rmsSrc, 1e-5,
               "Relative mode's RMS over the pre-transient window matches the untouched source almost exactly");
    CHECK(rmsAbsolute < rmsSrc * 0.9,
          "Absolute mode's RMS over the same window is measurably reduced by the ramp");

    // Peak of the transient itself, across the whole buffer: Absolute brings
    // it down from the untouched 0.9 peak instantly, confirming the duck is
    // real audio behaviour and not just an RMS-window artefact.
    const auto peakOf = [](const SandboxBuffer& b, int64_t start, int64_t end) {
        float p = 0.0f;
        for (int64_t i = start; i < end; ++i) p = std::max(p, std::abs(b.getSample(0, static_cast<int>(i))));
        return p;
    };
    CHECK_NEAR(peakOf(src, 0, src.getNumSamples()), 0.9f, 1e-6, "the untouched source peak is the spike itself");
    CHECK(peakOf(*absoluteResult.buffer, 0, absoluteResult.buffer->getNumSamples()) < 0.9f * 0.5f,
          "Absolute reduces the buffer's peak substantially");

    // Relative mode is causal: it cannot duck a transient before its follower
    // has had time to react, so the transient's very first samples (still
    // mid-attack, normalized(t) still low) legitimately let more through than
    // Absolute does — that lag is the honest cost of reacting to the material
    // instead of a fixed schedule. The SUSTAINED part of the spike, once the
    // follower has caught up, still ducks hard.
    CHECK(peakOf(*relativeResult.buffer, 6200, 7000) < 0.9f * 0.5f,
          "Relative reduces the SUSTAINED transient's peak substantially once the follower has caught up");
}

// ---------------------------------------------------------------------------
// SandboxRenderer — restoration/pitch trio (PITCH DSP, FORMANT SHIFT, DECLIP,
// DENOISE)
// ---------------------------------------------------------------------------

static void testRestorationOps() {
    std::cout << "\n[SandboxRenderer — restoration/pitch trio]\n";

    SandboxRenderer renderer;

    // ── PITCH ──
    {
        const int N = 8192;
        const SandboxBuffer tone = makeSine(1, N, 220.0, kTestRate);
        const int baseCrossings = countZeroCrossings(tone, 500, N - 500);

        SandboxRenderResult unity = renderer.renderStack(
            100, tone, { makeOp(1, SandboxOpType::Pitch, PitchParams{ 0.0, false }) }, kTestRate);
        CHECK_EQ(unity.buffer->getNumSamples(), N, "PITCH never changes length");
        CHECK_NEAR(rmsOf(*unity.buffer, 0, N), rmsOf(tone, 0, N), 0.01f,
                   "PITCH at 0 cents is near-identity (RubberBand's own early exit)");

        SandboxRenderResult up = renderer.renderStack(
            101, tone, { makeOp(1, SandboxOpType::Pitch, PitchParams{ 1200.0, false }) }, kTestRate);
        CHECK_EQ(up.buffer->getNumSamples(), N, "PITCH +1200 cents still never changes length");
        const int upCrossings = countZeroCrossings(*up.buffer, 500, N - 500);
        CHECK(upCrossings > baseCrossings * 3 / 2,
              "PITCH +1200 cents (one octave) roughly doubles the zero-crossing rate");
    }

    // ── PITCH — formant lock actually changes the render ──
    {
        const int N = 8192;
        const SandboxBuffer voice = makeSine(1, N, 180.0, kTestRate);   // a low fundamental
        SandboxRenderResult locked = renderer.renderStack(
            110, voice, { makeOp(1, SandboxOpType::Pitch, PitchParams{ 700.0, true }) }, kTestRate);
        SandboxRenderResult unlocked = renderer.renderStack(
            111, voice, { makeOp(1, SandboxOpType::Pitch, PitchParams{ 700.0, false }) }, kTestRate);
        CHECK(locked.valid() && unlocked.valid(), "both formant-lock states render");

        bool differ = false;
        for (int64_t i = 1000; i < N - 1000 && !differ; i += 37)
            if (std::fabs(locked.buffer->getSample(0, static_cast<int>(i))
                         - unlocked.buffer->getSample(0, static_cast<int>(i))) > 1e-4f)
                differ = true;
        CHECK(differ, "formant lock ON vs OFF changes the render at the same pitch shift");
    }

    // ── FORMANT SHIFT ──
    {
        const int N = 8192;
        const SandboxBuffer tone = makeSine(1, N, 220.0, kTestRate);

        SandboxRenderResult unity = renderer.renderStack(
            120, tone, { makeOp(1, SandboxOpType::FormantShift, FormantShiftParams{ 0.0 }) }, kTestRate);
        CHECK_EQ(unity.buffer->getNumSamples(), N, "FORMANT SHIFT never changes length");
        CHECK_NEAR(rmsOf(*unity.buffer, 0, N), rmsOf(tone, 0, N), 0.01f,
                   "FORMANT SHIFT at 0 cents is near-identity");

        const int crossingsUnshifted = countZeroCrossings(tone, 500, N - 500);
        SandboxRenderResult shifted = renderer.renderStack(
            121, tone, { makeOp(1, SandboxOpType::FormantShift, FormantShiftParams{ 1200.0 }) }, kTestRate);
        const int crossingsShifted = countZeroCrossings(*shifted.buffer, 500, N - 500);
        // A pure tone has no formant structure to speak of, but the point
        // stands either way: FORMANT SHIFT must never move the fundamental —
        // zero-crossing rate is a pitch measure, not a formant one.
        CHECK(std::abs(crossingsShifted - crossingsUnshifted) <= 2,
              "FORMANT SHIFT leaves pitch (zero-crossing rate) unchanged");
    }

    // ── DECLIP ──
    {
        const int N = 4000;
        SandboxBuffer clipped = makeSine(1, N, 300.0, kTestRate, 1.0f);
        float* d = clipped.getWritePointer(0);
        for (int i = 0; i < N; ++i) d[i] = std::clamp(d[i], -0.5f, 0.5f);

        int pinnedBefore = 0;
        for (int i = 0; i < N; ++i) if (std::fabs(clipped.getSample(0, i)) >= 0.5f - 1e-6f) ++pinnedBefore;
        CHECK(pinnedBefore > 0, "the fixture actually has clipped runs to fix");

        SandboxRenderResult r = renderer.renderStack(
            130, clipped, { makeOp(1, SandboxOpType::Declip, DeclipParams{ 0, -1, 0.5, 64 }) }, kTestRate);
        CHECK(r.valid(), "DECLIP renders");
        CHECK_EQ(r.buffer->getNumSamples(), N, "DECLIP never changes length");

        int pinnedAfter = 0;
        for (int i = 0; i < N; ++i) if (std::fabs(r.buffer->getSample(0, i)) >= 0.5f - 1e-6f) ++pinnedAfter;
        CHECK(pinnedAfter < pinnedBefore, "DECLIP breaks up the flat-topped runs");

        // A run longer than maxRunSamples is the escape hatch: left alone.
        SandboxBuffer longRun(1, 1000);
        longRun.clear();
        for (int i = 200; i < 800; ++i) longRun.setSample(0, i, 0.99f);   // 600-sample flat run
        SandboxRenderResult r2 = renderer.renderStack(
            131, longRun, { makeOp(1, SandboxOpType::Declip, DeclipParams{ 0, -1, 0.9, 64 }) }, kTestRate);
        CHECK_NEAR(r2.buffer->getSample(0, 500), 0.99f, 1e-6,
                   "a run past maxRunSamples is left untouched, not reconstructed");
    }

    // ── DENOISE ──
    {
        const int N = 16384;
        SandboxBuffer mix(1, N);
        // Deterministic pseudo-noise (LCG), not real random — reproducible.
        uint32_t seed = 12345u;
        auto nextNoise = [&]() {
            seed = seed * 1664525u + 1013904223u;
            return (static_cast<float>(seed) / static_cast<float>(0xFFFFFFFFu)) * 2.0f - 1.0f;
        };
        for (int i = 0; i < N; ++i) {
            const float tone = 0.4f * static_cast<float>(std::sin(2.0 * 3.14159265358979323846 * 500.0 * i / kTestRate));
            mix.setSample(0, i, tone + 0.15f * nextNoise());
        }

        SandboxRenderResult noProfile = renderer.renderStack(
            140, mix, { makeOp(1, SandboxOpType::Denoise, DenoiseParams{}) }, kTestRate);
        CHECK_NEAR(noProfile.buffer->getSample(0, 5000), mix.getSample(0, 5000), 1e-9,
                   "DENOISE with no learned profile (noiseEndSample<=noiseStartSample) is a pass-through");

        // A noise-only region: the SAME noise stream continued, no tone — the
        // learned profile has to come from genuinely noise-only material, not
        // a separately-seeded stand-in.
        SandboxBuffer noiseOnly(1, N + 8192);
        for (int i = 0; i < N; ++i) noiseOnly.setSample(0, i, mix.getSample(0, i));
        for (int i = N; i < N + 8192; ++i) noiseOnly.setSample(0, i, 0.15f * nextNoise());

        SandboxRenderResult learned = renderer.renderStack(
            141, noiseOnly,
            { makeOp(1, SandboxOpType::Denoise, DenoiseParams{ N, N + 8192, 18.0, 1.5 }) },
            kTestRate);
        CHECK(learned.valid(), "DENOISE with a learned profile renders");
        CHECK_EQ(learned.buffer->getNumSamples(), noiseOnly.getNumSamples(), "DENOISE never changes length");

        const float noiseRmsBefore = rmsOf(noiseOnly, N, N + 8192);
        const float noiseRmsAfter  = rmsOf(*learned.buffer, N, N + 8192);
        CHECK(noiseRmsAfter < noiseRmsBefore * 0.7f,
              "DENOISE measurably attenuates the noise-only region it learned from");

        const float toneRmsBefore = rmsOf(noiseOnly, 2000, 6000);
        const float toneRmsAfter  = rmsOf(*learned.buffer, 2000, 6000);
        CHECK(toneRmsAfter > toneRmsBefore * 0.6f,
              "DENOISE leaves the tone-dominant material largely intact, not silenced");
    }
}

// ---------------------------------------------------------------------------
// Restoration/pitch trio — deliverable fixtures
// ---------------------------------------------------------------------------
// Not correctness checks (CHECK-free by design): "no chipmunk", "peaks look
// reconstructed", "hiss down but the music is intact" are judgment calls a
// listener makes by ear, which a numeric assertion cannot stand in for. Every
// buffer here is produced by SandboxRenderer::applyOp — the exact function
// the DSP-correctness tests above already exercise — so what gets written is
// provably the same code path a real op stack runs, not a hand-rolled stand-in.

// A crude "vocal" proxy: a handful of harmonics of a low fundamental with a
// hand-picked amplitude profile roughly peaking where the first two formants
// of a spoken vowel would sit. Real singing has far more structure than this,
// but it is enough spectral shape for formant-locked vs. unlocked pitch shift
// to sound audibly different, which is the whole point of the fixture.
static SandboxBuffer makeVocalLike(int samples, double f0, double sampleRate) {
    SandboxBuffer b(1, samples);
    b.clear();
    float* d = b.getWritePointer(0);
    struct Harmonic { int n; float amp; };
    static const Harmonic kHarmonics[] = {
        { 1, 0.50f }, { 2, 0.35f }, { 3, 0.55f }, { 4, 0.60f }, { 5, 0.40f },
        { 6, 0.25f }, { 7, 0.15f }, { 8, 0.50f }, { 9, 0.35f }, { 10, 0.15f },
    };
    for (int i = 0; i < samples; ++i) {
        const double t = static_cast<double>(i) / sampleRate;
        double s = 0.0;
        for (const auto& h : kHarmonics)
            s += h.amp * std::sin(2.0 * 3.14159265358979323846 * f0 * h.n * t);
        d[i] = static_cast<float>(s * 0.12);
    }
    return b;
}

static juce::File writeFixtureWav(const juce::File& dir, const juce::String& name,
                                  const SandboxBuffer& buf, double sampleRate) {
    juce::File file = dir.getChildFile(name + ".wav");
    file.deleteFile();
    auto outStream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
    if (outStream == nullptr) return {};
    juce::WavAudioFormat wavFmt;
    std::unique_ptr<juce::AudioFormatWriter> writer(wavFmt.createWriterFor(
        outStream.get(), sampleRate, static_cast<unsigned int>(buf.getNumChannels()), 16, {}, 0));
    if (writer == nullptr) return {};
    outStream.release();   // writer takes ownership
    writer->writeFromAudioSampleBuffer(buf, 0, buf.getNumSamples());
    return file;
}

// ---------------------------------------------------------------------------
// Spectrogram (P3-1) — STFT analysis of the rendered buffer, content-hash cache
// ---------------------------------------------------------------------------
static void testSpectrogram() {
    std::cout << "\n[Spectrogram -- STFT analysis + content-hash cache]\n";

    // A tone at EXACTLY FFT bin 50's frequency — a windowed DFT of a pure
    // sinusoid puts all its energy in one bin only when frequency (not phase)
    // is bin-aligned, so this is deterministic and leak-free regardless of
    // which frame/hop offset happens to sample it. See ApexVizAccumulator's
    // computeSpectrum comment for the same |X[k]| = A*N/4 identity this
    // analyzer's normalisation (4/N) is built to match.
    const int    expectedBin = 50;
    const double toneHz = kTestRate * expectedBin / SandboxSpectrogramAnalyzer::kFftSize;
    SandboxBuffer tone = makeSine(1, static_cast<int>(kTestRate * 2), toneHz, kTestRate, 0.8f);

    SandboxSpectrogramAnalyzer analyzer;
    auto result = analyzer.analyze(tone, kTestRate);
    CHECK(result.valid(), "analyze() returns a valid result for a real buffer");
    CHECK_EQ(result.numBins, SandboxSpectrogramAnalyzer::kNumBins, "numBins == kFftSize/2+1");
    const int expectedFrames =
        (tone.getNumSamples() + SandboxSpectrogramAnalyzer::kHopSize - 1) / SandboxSpectrogramAnalyzer::kHopSize;
    CHECK_EQ(result.numFrames, expectedFrames, "numFrames covers the whole buffer at hop stride");
    CHECK_EQ(result.hopSize, SandboxSpectrogramAnalyzer::kHopSize, "hopSize reported matches kHopSize");
    CHECK_NEAR(result.sampleRate, kTestRate, 0.001, "sampleRate carried through unchanged");

    const int frameIdx = result.numFrames / 2; // safely inside the tone, a full window away from either edge
    const uint8_t* row = result.tokens->data()
        + static_cast<size_t>(frameIdx) * static_cast<size_t>(result.numBins);
    int peakBin = 0;
    for (int k = 1; k < result.numBins; ++k) if (row[k] > row[peakBin]) peakBin = k;
    CHECK_EQ(peakBin, expectedBin, "peak magnitude bin lands exactly on the bin-aligned tone's own bin");
    CHECK(row[peakBin] > 200, "peak bin token sits near the top of 0..255 for a -1.9dBFS tone");

    // Silence quantizes to the floor token everywhere.
    SandboxBuffer silence = makeConst(1, static_cast<int>(kTestRate), 0.0f);
    auto silentResult = analyzer.analyze(silence, kTestRate);
    CHECK(silentResult.valid(), "analyze() handles an all-zero buffer");
    bool allFloor = true;
    for (uint8_t t : *silentResult.tokens) if (t != 0) { allFloor = false; break; }
    CHECK(allFloor, "a silent buffer quantizes to token 0 (minDb) at every frame/bin");

    // Invalid input refuses rather than guessing, same discipline as
    // SandboxRenderer::renderStack's own sampleRate <= 0 refusal.
    CHECK(!analyzer.analyze(tone, 0.0).valid(), "analyze() refuses a non-positive sampleRate");
    SandboxBuffer empty(1, 0);
    CHECK(!analyzer.analyze(empty, kTestRate).valid(), "analyze() refuses an empty buffer");

    // ── Content-hash cache ──────────────────────────────────────────────────
    SandboxSpectrogramAnalyzer cacheAnalyzer;
    SandboxBuffer bufA     = makeSine(1, 4000, 440.0, kTestRate, 0.5f);
    SandboxBuffer bufACopy = makeSine(1, 4000, 440.0, kTestRate, 0.5f); // identical content, different object
    SandboxBuffer bufB     = makeSine(1, 4000, 880.0, kTestRate, 0.5f); // different content

    auto r1 = cacheAnalyzer.analyze(bufA, kTestRate);
    CHECK_EQ(cacheAnalyzer.entryCount(), static_cast<size_t>(1), "first analyze() inserts one cache entry");
    auto r2 = cacheAnalyzer.analyze(bufACopy, kTestRate);
    CHECK(r1.tokens.get() == r2.tokens.get(),
          "identical buffer CONTENT (a different object) hits the cache -- same tokens pointer");
    CHECK_EQ(cacheAnalyzer.entryCount(), static_cast<size_t>(1), "a cache hit does not grow the cache");

    auto r3 = cacheAnalyzer.analyze(bufB, kTestRate);
    CHECK(r1.tokens.get() != r3.tokens.get(), "different buffer content is a cache miss -- different tokens pointer");
    CHECK_EQ(cacheAnalyzer.entryCount(), static_cast<size_t>(2), "distinct content adds a second cache entry");

    // Simulates a gain-envelope re-render producing new samples for the same
    // layer: the hash changes, so "SPC updates after auto-render" falls out
    // of the cache keying with no invalidation call needed.
    SandboxBuffer bufAEdited = bufA;
    bufAEdited.applyGain(0, 0, bufAEdited.getNumSamples(), 0.5f);
    auto r4 = cacheAnalyzer.analyze(bufAEdited, kTestRate);
    CHECK(r4.tokens.get() != r1.tokens.get(),
          "a gain change on the same layer (different samples) is a cache miss, not a stale hit");

    // LRU eviction under an entry budget.
    SandboxSpectrogramAnalyzer smallAnalyzer(/*maxEntries=*/2);
    smallAnalyzer.analyze(makeSine(1, 2000, 100.0, kTestRate), kTestRate);
    smallAnalyzer.analyze(makeSine(1, 2000, 200.0, kTestRate), kTestRate);
    smallAnalyzer.analyze(makeSine(1, 2000, 300.0, kTestRate), kTestRate);
    CHECK_EQ(smallAnalyzer.entryCount(), static_cast<size_t>(2),
             "a 2-entry cache evicts down to its cap rather than growing unbounded");

    smallAnalyzer.clearCache();
    CHECK_EQ(smallAnalyzer.entryCount(), static_cast<size_t>(0), "clearCache() empties the cache");
}

static void generateFixtures() {
    std::cout << "\n[Sample Sandbox -- restoration/pitch trio fixtures]\n";

    juce::File dir(
        "C:\\Users\\Krasen\\AppData\\Local\\Temp\\claude\\C--Users-Krasen-Desktop-XLETH"
        "\\bd799a1b-0364-45ce-8d84-9cd89e799215\\scratchpad\\sandbox_fixtures");
    dir.createDirectory();

    // ── 1. Pitched vocal — with and without formant lock ──
    {
        const int N = static_cast<int>(kTestRate * 2.0);
        const SandboxBuffer vocal = makeVocalLike(N, 140.0, kTestRate);
        writeFixtureWav(dir, "1_vocal_source", vocal, kTestRate);

        const SandboxBuffer chipmunk = SandboxRenderer::applyOp(
            vocal, makeOp(1, SandboxOpType::Pitch, PitchParams{ 700.0, false }), kTestRate);
        writeFixtureWav(dir, "1_vocal_pitch_up_NO_formant_lock_chipmunky", chipmunk, kTestRate);

        const SandboxBuffer natural = SandboxRenderer::applyOp(
            vocal, makeOp(1, SandboxOpType::Pitch, PitchParams{ 700.0, true }), kTestRate);
        writeFixtureWav(dir, "1_vocal_pitch_up_WITH_formant_lock_natural", natural, kTestRate);
        std::cout << "    wrote 1_vocal_source / _NO_formant_lock_chipmunky / _WITH_formant_lock_natural\n";
    }

    // ── 2. Clipped, square-ish recording, before/after DECLIP ──
    {
        const int N = static_cast<int>(kTestRate * 1.5);
        SandboxBuffer clipped = makeSine(1, N, 220.0, kTestRate, 1.0f);
        float* d = clipped.getWritePointer(0);
        for (int i = 0; i < N; ++i) d[i] = std::clamp(d[i], -0.35f, 0.35f);   // hard clip -> near-square
        writeFixtureWav(dir, "2_clipped_before", clipped, kTestRate);

        const SandboxBuffer declipped = SandboxRenderer::applyOp(
            clipped, makeOp(1, SandboxOpType::Declip, DeclipParams{ 0, -1, 0.35, 80 }), kTestRate);
        writeFixtureWav(dir, "2_declipped_after", declipped, kTestRate);
        std::cout << "    wrote 2_clipped_before / 2_declipped_after\n";
    }

    // ── 3. "YouTube rip with hiss" — tone + broadband noise, before/after DENOISE ──
    {
        const int N = static_cast<int>(kTestRate * 3.0);
        SandboxBuffer mix(1, N);
        uint32_t seed = 777u;
        auto nextNoise = [&]() {
            seed = seed * 1664525u + 1013904223u;
            return (static_cast<float>(seed) / static_cast<float>(0xFFFFFFFFu)) * 2.0f - 1.0f;
        };
        for (int i = 0; i < N; ++i) {
            const double t = static_cast<double>(i) / kTestRate;
            const float music =
                0.30f * static_cast<float>(std::sin(2.0 * 3.14159265358979323846 * 330.0 * t))
              + 0.15f * static_cast<float>(std::sin(2.0 * 3.14159265358979323846 * 660.0 * t));
            mix.setSample(0, i, music + 0.08f * nextNoise());
        }
        // A genuinely noise-only tail, appended after the "song" — the region
        // the fixture's DENOISE op learns its profile from.
        const int noiseLen = static_cast<int>(kTestRate * 1.0);
        SandboxBuffer withTail(1, N + noiseLen);
        for (int i = 0; i < N; ++i) withTail.setSample(0, i, mix.getSample(0, i));
        for (int i = 0; i < noiseLen; ++i) withTail.setSample(0, N + i, 0.08f * nextNoise());
        writeFixtureWav(dir, "3_hiss_before", withTail, kTestRate);

        const SandboxBuffer denoised = SandboxRenderer::applyOp(
            withTail,
            makeOp(1, SandboxOpType::Denoise, DenoiseParams{ N, N + noiseLen, 18.0, 1.5 }),
            kTestRate);
        writeFixtureWav(dir, "3_hiss_after", denoised, kTestRate);
        std::cout << "    wrote 3_hiss_before / 3_hiss_after\n";
    }

    std::cout << "    fixtures written to: " << dir.getFullPathName() << "\n";
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
    testLayerMixCommands();
    testBakeCompositeCommand();
    testDurableSourceRef();
    testSwapInCommand();
    testUndoDomains();
    testCompositeMixing();
    testRendererOps();
    testRestorationOps();
    testRendererCache();
    testDownstreamOnlyRerender();
    testWorkerAndPublish();
    testGainEnvelope();
    testGainEnvelopeRelativeMode();
    testSpectrogram();

    generateFixtures();

    std::cout << "\n";
    if (g_failures == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cout << g_failures << " TEST(S) FAILED\n";
    return 1;
}
