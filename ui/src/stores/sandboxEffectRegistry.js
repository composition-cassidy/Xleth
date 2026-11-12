import {
  GAIN_ENVELOPE_MODE, GAIN_ENVELOPE_ATTACK_MS_DEFAULT, GAIN_ENVELOPE_RELEASE_MS_DEFAULT,
  PITCH_MODE,
} from './sandboxStore.js'

// The EFFECT ▾ menu's op metadata — one entry per addable operation, grouped
// into the categories the menu renders in order. This is the "op registry"
// the Sample Sandbox restructure calls for: SandboxMenuBar reads this table
// (plus a layer's current `ops`) to decide what to show/disable, rather than
// hardcoding a per-category list in the component itself.
//
// `matchesStack(op)` + `maxInstances` together express "how many of THIS may
// exist on one layer" — most ops are unlimited (Infinity, i.e. every click
// just appends another instance via the underlying store action), a few are
// singletons because the underlying engine op genuinely only has one slot on
// a layer (Reverse, Normalize, the Gain Envelope pair). `matchesStack` is
// only read when `maxInstances` is finite.
//
// Two entries here don't correspond 1:1 with an engine op type:
//  - GAIN vs NORMALIZE are both the `gain` op type, split by its own
//    `normalize` flag — matchesStack checks the flag, not just the type.
//  - PITCH SHIFT vs VARISPEED are both the `pitch` op type, split by its own
//    `mode` flag (PITCH_MODE) — the same shape as GAIN/NORMALIZE. Both are
//    unlimited, so neither needs matchesStack; the two entries exist because
//    "shift the pitch" and "speed the tape up" are different intentions a user
//    arrives with, and burying the second one inside a dropdown on the first
//    means nobody finds it.
//  - GAIN ENVELOPE vs DYNAMICS MOD both target the single `gainEnvelope` op
//    (Absolute vs Relative mode — see GAIN_ENVELOPE_MODE) since the engine
//    has no separate "dynamics mod" op type. Whichever is added first blocks
//    the other, because they share one matchesStack predicate.
//
// AUTOTUNE is a plain singleton over SandboxOpType::Autotune (P5-3) — it was
// the one permanently-disabled entry here until that op landed.
export const EFFECT_CATEGORIES = ['EDIT', 'DYNAMICS', 'RESTORATION', 'PITCH']

export const EFFECT_REGISTRY = [
  // ── EDIT ───────────────────────────────────────────────────────────────
  {
    id: 'trim', label: 'Trim', category: 'EDIT', maxInstances: Infinity, needsSelection: true,
    run: (store, ctx) => store.addOp(ctx.layerId, {
      type: 'trim', params: { startSample: ctx.selection.startSample, endSample: ctx.selection.endSample },
    }),
  },
  {
    id: 'cut', label: 'Cut', category: 'EDIT', maxInstances: Infinity, needsSelection: true,
    run: (store, ctx) => store.cutSelection(ctx.layerId, 'ripple'),
  },
  {
    id: 'silence', label: 'Silence', category: 'EDIT', maxInstances: Infinity, needsSelection: true,
    run: (store, ctx) => store.insertSilence(
      ctx.layerId, ctx.selection.startSample, ctx.selection.endSample - ctx.selection.startSample, false,
    ),
  },
  {
    // No selection needed: with only a cursor the fade runs from the layer's
    // start up to it, and with the cursor on that edge it covers the whole
    // layer (sandboxStore._fadeRange). Fade Out mirrors it toward the end.
    id: 'fadeIn', label: 'Fade In', category: 'EDIT', maxInstances: Infinity, needsSelection: false,
    run: (store, ctx) => store.fadeSelection(ctx.layerId, true, 'equalPower'),
  },
  {
    id: 'fadeOut', label: 'Fade Out', category: 'EDIT', maxInstances: Infinity, needsSelection: false,
    run: (store, ctx) => store.fadeSelection(ctx.layerId, false, 'equalPower'),
  },
  {
    // Gain and Normalize act on the selection, or on the whole layer without
    // one (sandboxStore._editRange). Gain arrives at 0 dB with its row open:
    // the amount is the user's to set, and an op that changes nothing until
    // it is touched is the same contract Pitch Shift (0 cents) already has.
    id: 'gain', label: 'Gain', category: 'EDIT', maxInstances: Infinity, needsSelection: false,
    run: (store, ctx) => store.gainSelection(ctx.layerId, 0),
  },
  {
    id: 'normalize', label: 'Normalize', category: 'EDIT', maxInstances: 1, needsSelection: false,
    matchesStack: (op) => op.type === 'gain' && !!op.params?.normalize,
    whyNoMulti: 'idempotent — one instance max',
    run: (store, ctx) => store.normalizeSelection(ctx.layerId, -0.1),
  },
  {
    id: 'reverse', label: 'Reverse', category: 'EDIT', maxInstances: 1, needsSelection: false,
    matchesStack: (op) => op.type === 'reverse',
    whyNoMulti: 'two reverses cancel out',
    run: (store, ctx) => store.reverseSelection(ctx.layerId),
  },
  // Not named by the mockup's EDIT list, but real, working ops today —
  // kept so the restructure loses no reachable capability (see the plan's
  // "EFFECT menu category membership" conflict).
  {
    id: 'splice', label: 'Splice', category: 'EDIT', maxInstances: Infinity, needsSelection: false,
    run: (store, ctx) => store.spliceAtCursor(ctx.layerId, ctx.cursorSample, 'ripple', 0),
  },
  {
    id: 'crossfade', label: 'Crossfade', category: 'EDIT', maxInstances: Infinity, needsSelection: false,
    run: (store, ctx) => store.crossfadeAtCursor(ctx.layerId, ctx.cursorSample, 256, 'hann'),
  },
  {
    id: 'insertSilence', label: 'Insert Silence', category: 'EDIT', maxInstances: Infinity, needsSelection: true,
    run: (store, ctx) => store.insertSilence(
      ctx.layerId, ctx.selection.startSample, ctx.selection.endSample - ctx.selection.startSample, true,
    ),
  },
  {
    id: 'copy', label: 'Copy', category: 'EDIT', maxInstances: Infinity, needsSelection: true,
    run: (store, ctx) => store.copySelection(ctx.layerId),
  },
  {
    id: 'paste', label: 'Paste', category: 'EDIT', maxInstances: Infinity, needsSelection: false, needsClipboard: true,
    run: (store, ctx) => store.pasteClipboard(ctx.layerId, ctx.cursorSample, true),
  },

  // ── DYNAMICS ───────────────────────────────────────────────────────────
  {
    id: 'gainEnvelope', label: 'Gain Envelope', category: 'DYNAMICS', maxInstances: 1, needsSelection: false,
    matchesStack: (op) => op.type === 'gainEnvelope',
    run: (store, ctx) => store.setGainEnvelope(ctx.layerId, []),
  },
  {
    id: 'dynamicsMod', label: 'Dynamics Mod', category: 'DYNAMICS', maxInstances: 1, needsSelection: false,
    matchesStack: (op) => op.type === 'gainEnvelope',
    whyNoMulti: 'one follower per layer',
    run: async (store, ctx) => {
      await store.setGainEnvelope(ctx.layerId, [])
      await store.setGainEnvelopeFollower(ctx.layerId, {
        mode: GAIN_ENVELOPE_MODE.relative,
        followerAttackMs: GAIN_ENVELOPE_ATTACK_MS_DEFAULT,
        followerReleaseMs: GAIN_ENVELOPE_RELEASE_MS_DEFAULT,
      })
    },
  },

  // ── RESTORATION ────────────────────────────────────────────────────────
  {
    id: 'denoise', label: 'De-Noise', category: 'RESTORATION', maxInstances: Infinity, needsSelection: false,
    run: (store, ctx) => store.addDenoise(ctx.layerId),
  },
  {
    id: 'declip', label: 'De-Clip', category: 'RESTORATION', maxInstances: Infinity, needsSelection: false,
    run: (store, ctx) => store.addDeclip(ctx.layerId, 0.98, 64),
  },

  // ── PITCH ──────────────────────────────────────────────────────────────
  {
    id: 'pitch', label: 'Pitch Shift', category: 'PITCH', maxInstances: Infinity, needsSelection: false,
    run: (store, ctx) => store.addPitchShift(ctx.layerId, 0, false, PITCH_MODE.preserve),
  },
  {
    // Same op, `mode: resample` — see the header note. Length moves with the
    // pitch here, which is exactly why it is worth its own menu row.
    id: 'varispeed', label: 'Varispeed (Resample)', category: 'PITCH', maxInstances: Infinity, needsSelection: false,
    run: (store, ctx) => store.addPitchShift(ctx.layerId, 0, false, PITCH_MODE.resample),
  },
  {
    id: 'formantShift', label: 'Formant Shift', category: 'PITCH', maxInstances: Infinity, needsSelection: false,
    run: (store, ctx) => store.addFormantShiftOp(ctx.layerId, 0),
  },
  {
    id: 'autotune', label: 'Autotune', category: 'PITCH', maxInstances: 1, needsSelection: false,
    // P5-3 landed the DSP: NSDF detection (P5-1) -> target-f0 curve (P5-2) ->
    // TD-PSOLA resynthesis (dsp/AutotuneRender.h). A SINGLETON per layer, and
    // genuinely so rather than by convention — two stacked corrections would
    // have the second one detecting pitch in audio the first already
    // resynthesized, which is a worse input than the source and asks the user
    // to reason about an order that has no musical meaning.
    //
    // Whole-buffer: needsSelection is false and addAutotune ignores the
    // current selection. Pitch correction is a property of a performance, and
    // AutotuneParams has no range to scope it to.
    matchesStack: (op) => op.type === 'autotune',
    run: (store, ctx) => store.addAutotune(ctx.layerId),
  },
]
