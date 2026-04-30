// Limiter plugin manifest.
// Mirrors the Compressor manifest shape; param table and meter slots are taken
// from the legacy LimiterPanel and engine atomic meter slots.

export const LIMITER_MANIFEST = {
  pluginId: 'limiter',

  // ── Parameter table ──────────────────────────────────────────────────────
  // kind: 'continuous' | 'discrete'
  // format: key in the formats registry (formats.js)
  params: {
    gain:    { kind: 'continuous', min: 0,    max: 36,   defaultValue: 0,    format: 'dB1', label: 'Gain' },
    ceiling: { kind: 'continuous', min: -12,  max: 0,    defaultValue: -0.3, format: 'dB1', label: 'Ceiling' },
    release: { kind: 'continuous', min: 10,   max: 1000, defaultValue: 100,  format: 'ms0', label: 'Release' },
    style:   { kind: 'discrete',   min: 0,    max: 2,    defaultValue: 0,    format: 'raw', label: 'Style' },
  },

  // ── Meter slots exposed by this plugin ──────────────────────────────────
  // Match the slots the Limiter's XlethEffectBase actually writes:
  //   slot 0/1 = peak L/R (universal)
  //   slot 2   = gain reduction (dB, positive = amount reduced)
  //   slot 3   = momentary LUFS
  //   slot 4   = short-term LUFS
  // See ui/src/constants/meterSlots.js and the legacy LimiterPanel polling code.
  meterSlots: ['PEAK_L', 'PEAK_R', 'GAIN_REDUCTION', 'LUFS_MOMENTARY', 'LUFS_SHORT_TERM'],

  // ── Visualization source keys ────────────────────────────────────────────
  // Backed by the LimiterBucket viz pipeline (engine: XlethLimiterEffect →
  // DynamicsVizCollector<LimiterBucket>; UI: limiterPainter.js).
  vizSources: [
    'limiter.realtime',
    'limiter.gainReductionHistory',
    'limiter.meterOnly',
  ],
}
