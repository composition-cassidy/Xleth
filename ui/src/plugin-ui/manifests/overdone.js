// Overdone (3-band OTT) plugin manifest.
//
// Mirrors the Compressor / Limiter / Transient manifest shape. Param table
// taken from engine/src/audio/XlethOTTEffect.h::createLayout(); meter slots
// taken from ui/src/constants/meterSlots.js (multiband bank — slot 2/3/4 are
// per-band GR rather than the single GAIN_REDUCTION used by single-band
// dynamics plugins). Visualization is backed by the MultibandBucket pipeline.

export const OVERDONE_MANIFEST = {
  pluginId: 'overdone',

  // ── Parameter table ──────────────────────────────────────────────────────
  // Engine source: engine/src/audio/XlethOTTEffect.h::createLayout()
  //   depth      : 0..100   % (default 70)              smoothed
  //   time       : 0..100   % (default 50)              smoothed
  //   xover_low  : 40..400  Hz (default 88)             smoothed (multiplicative)
  //   xover_high : 1000..8000 Hz (default 2500)         smoothed (multiplicative)
  //   gain_low   : -12..12 dB (default 0)               smoothed
  //   gain_mid   : -12..12 dB (default 0)               smoothed
  //   gain_high  : -12..12 dB (default 0)               smoothed
  params: {
    depth:      { kind: 'continuous', min: 0,    max: 100,  defaultValue: 70,   format: 'pct0',     label: 'Depth' },
    time:       { kind: 'continuous', min: 0,    max: 100,  defaultValue: 50,   format: 'pct0',     label: 'Time' },
    xover_low:  { kind: 'continuous', min: 40,   max: 400,  defaultValue: 88,   format: 'hz_smart', label: 'Lo Xover' },
    xover_high: { kind: 'continuous', min: 1000, max: 8000, defaultValue: 2500, format: 'hz_smart', label: 'Hi Xover' },
    gain_low:   { kind: 'continuous', min: -12,  max: 12,   defaultValue: 0,    format: 'dB1_signed', label: 'Low Gain' },
    gain_mid:   { kind: 'continuous', min: -12,  max: 12,   defaultValue: 0,    format: 'dB1_signed', label: 'Mid Gain' },
    gain_high:  { kind: 'continuous', min: -12,  max: 12,   defaultValue: 0,    format: 'dB1_signed', label: 'High Gain' },
  },

  // ── Meter slots exposed by this plugin ──────────────────────────────────
  // Match the slots XlethOTTEffect actually writes (XlethOTTEffect.h:244-248):
  //   slot 0 = output peak L
  //   slot 1 = output peak R
  //   slot 2 = low band GR  (dB, positive = reduction amount)
  //   slot 3 = mid band GR
  //   slot 4 = high band GR
  // The slot 2/3/4 indices are aliased in meterSlots.js as BAND_GR_LOW /
  // BAND_GR_MID / BAND_GR_HIGH so a Designer-authored meter can surface them
  // on the panel.
  meterSlots: ['PEAK_L', 'PEAK_R', 'BAND_GR_LOW', 'BAND_GR_MID', 'BAND_GR_HIGH'],

  // ── Visualization source keys ────────────────────────────────────────────
  // Backed by the MultibandBucket viz pipeline (engine: XlethOTTEffect →
  // DynamicsVizCollector<MultibandBucket>; UI: multibandPainter.js).
  vizSources: [
    'overdone.multiband',
    'overdone.bands',
    'overdone.gainReduction',
  ],
}
