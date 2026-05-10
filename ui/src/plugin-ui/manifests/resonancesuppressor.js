// Resonance Suppressor plugin manifest.
//
// Spectral DSP is live: WOLA/STFT, detector, gain-reduction mask, mix/trim/
// delta, frequency weighting curve, stereo/mid/side modes, and the schema-v2
// visualization contract (kVizTypeResonance, ResonanceBucket = 1584 bytes,
// 128 log-frequency buckets, spectrum/reduction/weighting + activity meta).
// The shipped layout renders the polished parameter-control shell with a
// real spectrum/reduction/weighting visualizer. Draggable curve-node editing
// is a later phase; v1 has no sidechain support.
//
// Engine source: engine/src/audio/XlethResonanceSuppressorEffect.h::createLayout()
// Parameter IDs are case-sensitive and must mirror the engine's createLayout()
// exactly — bridge get/set goes by string ID.

export const RESONANCE_SUPPRESSOR_MANIFEST = {
  pluginId: 'resonancesuppressor',

  // ── Parameter table ──────────────────────────────────────────────────────
  // kind:   'continuous' | 'discrete'
  // format: key in the formats registry (formats.js)
  params: {
    depth:        { kind: 'continuous', min: 0,    max: 100,   defaultValue: 50,    format: 'pct0',       label: 'Depth' },
    sharpness:    { kind: 'continuous', min: 0,    max: 100,   defaultValue: 50,    format: 'pct0',       label: 'Sharpness' },
    selectivity:  { kind: 'continuous', min: 0,    max: 100,   defaultValue: 50,    format: 'pct0',       label: 'Selectivity' },
    attack:       { kind: 'continuous', min: 1,    max: 200,   defaultValue: 15,    format: 'ms1',        label: 'Attack' },
    release:      { kind: 'continuous', min: 10,   max: 2000,  defaultValue: 200,   format: 'ms0',        label: 'Release' },
    mix:          { kind: 'continuous', min: 0,    max: 100,   defaultValue: 100,   format: 'pct0',       label: 'Mix' },
    trim:         { kind: 'continuous', min: -12,  max: 12,    defaultValue: 0,     format: 'dB1_signed', label: 'Trim' },

    delta:        { kind: 'discrete',   min: 0,    max: 1,     defaultValue: 0,     format: 'raw',        label: 'Delta' },
    processing_mode: { kind: 'discrete', min: 0,   max: 1,     defaultValue: 0,     format: 'raw',        label: 'Processing Mode' },
    quality:      { kind: 'discrete',   min: 0,    max: 2,     defaultValue: 1,     format: 'raw',        label: 'Quality' },

    stereo_link:  { kind: 'continuous', min: 0,    max: 100,   defaultValue: 100,   format: 'pct0',       label: 'Stereo Link' },
    stereo_mode:  { kind: 'discrete',   min: 0,    max: 2,     defaultValue: 0,     format: 'raw',        label: 'Stereo Mode' },
    mode:         { kind: 'discrete',   min: 0,    max: 1,     defaultValue: 0,     format: 'raw',        label: 'Mode' },

    // Frequency weighting curve — high-pass / low-pass boundaries plus eight
    // band slots. v1.1 adds active/type/Q per slot; bands 5–8 are new.
    wc_hp:        { kind: 'continuous', min: 20,   max: 2000,  defaultValue: 80,    format: 'hz_smart',   label: 'HP Boundary' },
    wc_lp:        { kind: 'continuous', min: 2000, max: 20000, defaultValue: 16000, format: 'hz_smart',   label: 'LP Boundary' },

    // ── Focus Curve band slots ──────────────────────────────────────────────
    // Per-slot params: active / type / freq (Focus) / gain (Sens) / q (Width).
    // Type enum (matches engine weightingForBin()):
    //   0 = Bell   1 = Low Shelf   2 = High Shelf   3 = Band Reject (UI: Protect)   4 = Tilt
    // Labels intentionally avoid EQ wording (Focus/Sens/Width/Shape) — this is
    // a detector weighting curve, not an audio EQ.

    // ── Band 1 ──────────────────────────────────────────────────────────────
    wc_b1_freq:   { kind: 'continuous', min: 40,   max: 20000, defaultValue: 250,   format: 'hz_smart',   label: 'Band 1 Focus' },
    wc_b1_gain:   { kind: 'continuous', min: -12,  max: 12,    defaultValue: 0,     format: 'dB1_signed', label: 'Band 1 Sens' },
    wc_b1_active: { kind: 'discrete',   min: 0,    max: 1,     defaultValue: 1,     format: 'raw',        label: 'Band 1 Active' },
    wc_b1_type:   { kind: 'discrete',   min: 0,    max: 4,     defaultValue: 0,     format: 'raw',        label: 'Band 1 Shape' },
    wc_b1_q:      { kind: 'continuous', min: 0.25, max: 4,     defaultValue: 1,     format: 'raw',        label: 'Band 1 Width' },

    // ── Band 2 ──────────────────────────────────────────────────────────────
    wc_b2_freq:   { kind: 'continuous', min: 40,   max: 20000, defaultValue: 800,   format: 'hz_smart',   label: 'Band 2 Focus' },
    wc_b2_gain:   { kind: 'continuous', min: -12,  max: 12,    defaultValue: 0,     format: 'dB1_signed', label: 'Band 2 Sens' },
    wc_b2_active: { kind: 'discrete',   min: 0,    max: 1,     defaultValue: 1,     format: 'raw',        label: 'Band 2 Active' },
    wc_b2_type:   { kind: 'discrete',   min: 0,    max: 4,     defaultValue: 0,     format: 'raw',        label: 'Band 2 Shape' },
    wc_b2_q:      { kind: 'continuous', min: 0.25, max: 4,     defaultValue: 1,     format: 'raw',        label: 'Band 2 Width' },

    // ── Band 3 ──────────────────────────────────────────────────────────────
    wc_b3_freq:   { kind: 'continuous', min: 40,   max: 20000, defaultValue: 2500,  format: 'hz_smart',   label: 'Band 3 Focus' },
    wc_b3_gain:   { kind: 'continuous', min: -12,  max: 12,    defaultValue: 0,     format: 'dB1_signed', label: 'Band 3 Sens' },
    wc_b3_active: { kind: 'discrete',   min: 0,    max: 1,     defaultValue: 1,     format: 'raw',        label: 'Band 3 Active' },
    wc_b3_type:   { kind: 'discrete',   min: 0,    max: 4,     defaultValue: 0,     format: 'raw',        label: 'Band 3 Shape' },
    wc_b3_q:      { kind: 'continuous', min: 0.25, max: 4,     defaultValue: 1,     format: 'raw',        label: 'Band 3 Width' },

    // ── Band 4 ──────────────────────────────────────────────────────────────
    wc_b4_freq:   { kind: 'continuous', min: 40,   max: 20000, defaultValue: 8000,  format: 'hz_smart',   label: 'Band 4 Focus' },
    wc_b4_gain:   { kind: 'continuous', min: -12,  max: 12,    defaultValue: 0,     format: 'dB1_signed', label: 'Band 4 Sens' },
    wc_b4_active: { kind: 'discrete',   min: 0,    max: 1,     defaultValue: 1,     format: 'raw',        label: 'Band 4 Active' },
    wc_b4_type:   { kind: 'discrete',   min: 0,    max: 4,     defaultValue: 0,     format: 'raw',        label: 'Band 4 Shape' },
    wc_b4_q:      { kind: 'continuous', min: 0.25, max: 4,     defaultValue: 1,     format: 'raw',        label: 'Band 4 Width' },

    // ── Band 5 (new slot, inactive by default) ───────────────────────────────
    wc_b5_active: { kind: 'discrete',   min: 0,    max: 1,     defaultValue: 0,     format: 'raw',        label: 'Band 5 Active' },
    wc_b5_type:   { kind: 'discrete',   min: 0,    max: 4,     defaultValue: 0,     format: 'raw',        label: 'Band 5 Shape' },
    wc_b5_freq:   { kind: 'continuous', min: 40,   max: 20000, defaultValue: 500,   format: 'hz_smart',   label: 'Band 5 Focus' },
    wc_b5_gain:   { kind: 'continuous', min: -12,  max: 12,    defaultValue: 0,     format: 'dB1_signed', label: 'Band 5 Sens' },
    wc_b5_q:      { kind: 'continuous', min: 0.25, max: 4,     defaultValue: 1,     format: 'raw',        label: 'Band 5 Width' },

    // ── Band 6 (new slot, inactive by default) ───────────────────────────────
    wc_b6_active: { kind: 'discrete',   min: 0,    max: 1,     defaultValue: 0,     format: 'raw',        label: 'Band 6 Active' },
    wc_b6_type:   { kind: 'discrete',   min: 0,    max: 4,     defaultValue: 0,     format: 'raw',        label: 'Band 6 Shape' },
    wc_b6_freq:   { kind: 'continuous', min: 40,   max: 20000, defaultValue: 1500,  format: 'hz_smart',   label: 'Band 6 Focus' },
    wc_b6_gain:   { kind: 'continuous', min: -12,  max: 12,    defaultValue: 0,     format: 'dB1_signed', label: 'Band 6 Sens' },
    wc_b6_q:      { kind: 'continuous', min: 0.25, max: 4,     defaultValue: 1,     format: 'raw',        label: 'Band 6 Width' },

    // ── Band 7 (new slot, inactive by default) ───────────────────────────────
    wc_b7_active: { kind: 'discrete',   min: 0,    max: 1,     defaultValue: 0,     format: 'raw',        label: 'Band 7 Active' },
    wc_b7_type:   { kind: 'discrete',   min: 0,    max: 4,     defaultValue: 0,     format: 'raw',        label: 'Band 7 Shape' },
    wc_b7_freq:   { kind: 'continuous', min: 40,   max: 20000, defaultValue: 4000,  format: 'hz_smart',   label: 'Band 7 Focus' },
    wc_b7_gain:   { kind: 'continuous', min: -12,  max: 12,    defaultValue: 0,     format: 'dB1_signed', label: 'Band 7 Sens' },
    wc_b7_q:      { kind: 'continuous', min: 0.25, max: 4,     defaultValue: 1,     format: 'raw',        label: 'Band 7 Width' },

    // ── Band 8 (new slot, inactive by default) ───────────────────────────────
    wc_b8_active: { kind: 'discrete',   min: 0,    max: 1,     defaultValue: 0,     format: 'raw',        label: 'Band 8 Active' },
    wc_b8_type:   { kind: 'discrete',   min: 0,    max: 4,     defaultValue: 0,     format: 'raw',        label: 'Band 8 Shape' },
    wc_b8_freq:   { kind: 'continuous', min: 40,   max: 20000, defaultValue: 10000, format: 'hz_smart',   label: 'Band 8 Focus' },
    wc_b8_gain:   { kind: 'continuous', min: -12,  max: 12,    defaultValue: 0,     format: 'dB1_signed', label: 'Band 8 Sens' },
    wc_b8_q:      { kind: 'continuous', min: 0.25, max: 4,     defaultValue: 1,     format: 'raw',        label: 'Band 8 Width' },
  },

  // ── Meter slots exposed by this plugin ──────────────────────────────────
  // Match the slots XlethResonanceSuppressorEffect actually writes:
  //   slot 0 = input peak L
  //   slot 1 = input peak R
  //   slot 2 = gain-reduction activity in [0,1]
  meterSlots: ['PEAK_L', 'PEAK_R', 'GAIN_REDUCTION'],

  // ── Visualization source keys ────────────────────────────────────────────
  // Painters live in runtime/visualizers/resonancePainter.js; the canvas is
  // dispatched by `resonance.*` source-key prefix in DynamicsVisualizerCanvas.
  vizSources: [
    'resonance.combined',
    'resonance.spectrum',
    'resonance.reduction',
    'resonance.weighting',
  ],
}
