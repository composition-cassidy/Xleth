// Transient Processor plugin manifest.
// Mirrors the Compressor / Limiter manifest shape; param table and meter slots
// come from the legacy TransientProcPanel and the engine's
// XlethTransientProcEffect APVTS layout.

export const TRANSIENT_MANIFEST = {
  pluginId: 'transientproc',

  // ── Parameter table ──────────────────────────────────────────────────────
  // kind: 'continuous' | 'discrete'
  // format: key in the formats registry (formats.js)
  //
  // Engine source: engine/src/audio/XlethTransientProcEffect.h::createLayout()
  //   attack       : -100..100 % (bipolar, default 0)    smoothed
  //   sustain      : -100..100 % (bipolar, default 0)    smoothed; envelope mode only
  //   attack_speed : 0.5..20  ms (default 5)             smoothed
  //   threshold    : -60..0   dB (default -60)           smoothed; envelope mode only
  //   mix          : 0..100   % (default 100)            smoothed
  //   midi_detect  : 0..1     (discrete; 0 = Envelope, 1 = MIDI)
  params: {
    attack:       { kind: 'continuous', min: -100, max: 100,  defaultValue: 0,    format: 'pct0', label: 'Attack' },
    sustain:      { kind: 'continuous', min: -100, max: 100,  defaultValue: 0,    format: 'pct0', label: 'Sustain' },
    attack_speed: { kind: 'continuous', min: 0.5,  max: 20,   defaultValue: 5,    format: 'ms1',  label: 'Speed' },
    threshold:    { kind: 'continuous', min: -60,  max: 0,    defaultValue: -60,  format: 'dB1',  label: 'Threshold' },
    mix:          { kind: 'continuous', min: 0,    max: 100,  defaultValue: 100,  format: 'pct0', label: 'Mix' },
    midi_detect:  { kind: 'discrete',   min: 0,    max: 1,    defaultValue: 0,    format: 'raw',  label: 'MIDI Detect' },
  },

  // ── Meter slots exposed by this plugin ──────────────────────────────────
  // Match the slots XlethTransientProcEffect actually writes:
  //   slot 0 = output peak L
  //   slot 1 = output peak R
  //   slot 2 = signed gain dB (positive = boosting, negative = cutting)
  // The signed-gain semantics are unique to Transient — the slot is reused
  // from the dynamics convention but interpreted differently. The visualizer
  // is the primary surface for it; the slot is here so a Designer-built
  // bargraph remains an option.
  meterSlots: ['PEAK_L', 'PEAK_R', 'GAIN_REDUCTION'],

  // ── Visualization source keys ────────────────────────────────────────────
  // Backed by the TransientBucket viz pipeline (engine: XlethTransientProcEffect
  // → DynamicsVizCollector<TransientBucket>; UI: transientPainter.js).
  vizSources: [
    'transient.shaper',
    'transient.envelope',
    'transient.gainChange',
  ],
}
