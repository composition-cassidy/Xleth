// Compressor plugin manifest.
// Temporary until engine-side parameter descriptors expose min/max/default/kind
// via getEffectParameters. At that point this manifest becomes redundant and is
// deleted, replaced by the richer engine response.

export const COMPRESSOR_MANIFEST = {
  pluginId: 'compressor',

  // ── Parameter table ──────────────────────────────────────────────────────
  // kind: 'continuous' | 'discrete'
  // format: key in the formats registry (formats.js)
  params: {
    threshold:   { kind: 'continuous', min: -60,  max: 0,    defaultValue: -20,  format: 'dB1',   label: 'Threshold' },
    ratio:       { kind: 'continuous', min: 1,    max: 100,  defaultValue: 4,    format: 'ratio', label: 'Ratio' },
    attack:      { kind: 'continuous', min: 0.01, max: 100,  defaultValue: 10,   format: 'ms1',   label: 'Attack' },
    release:     { kind: 'continuous', min: 10,   max: 1000, defaultValue: 100,  format: 'ms0',   label: 'Release' },
    knee:        { kind: 'continuous', min: 0,    max: 24,   defaultValue: 6,    format: 'dB1',   label: 'Knee' },
    makeup:      { kind: 'continuous', min: 0,    max: 36,   defaultValue: 0,    format: 'dB1',   label: 'Makeup' },
    mix:         { kind: 'continuous', min: 0,    max: 100,  defaultValue: 100,  format: 'pct0',  label: 'Mix' },
    dry:         { kind: 'continuous', min: 0,    max: 100,  defaultValue: 0,    format: 'pct0',  label: 'Dry' },
    wet:         { kind: 'continuous', min: 0,    max: 100,  defaultValue: 100,  format: 'pct0',  label: 'Wet' },
    mix_linked:  { kind: 'discrete',   min: 0,    max: 1,    defaultValue: 1,    format: 'raw',   label: 'Dry/Wet Link' },
    lookahead:   { kind: 'continuous', min: 0,    max: 10,   defaultValue: 0,    format: 'ms1',   label: 'Lookahead' },
    detect_mode: { kind: 'discrete',  min: 0,    max: 1,    defaultValue: 0,    format: 'raw',   label: 'Detect Mode' },
  },

  // ── Meter slots exposed by this plugin ──────────────────────────────────
  // Must match the slots this plugin's XlethEffectBase actually writes.
  // See docs/dev/dynamics-visualization-diagnostic.md §1.1 and
  //     ui/src/constants/meterSlots.js for slot index definitions.
  meterSlots: ['PEAK_L', 'PEAK_R', 'GAIN_REDUCTION'],

  // ── Visualization source keys ────────────────────────────────────────────
  // The Compressor visualizer pulls bucketed frames from the engine via
  // window.xleth.audio.drainEffectVizFrames. See
  //   engine/src/audio/viz/DynamicsVizFrame.h
  //   ui/src/constants/dynamicsViz.js
  //   ui/src/plugin-ui/runtime/visualizers/compressorPainter.js
  vizSources: [
    'compressor.levelHistory',
    'compressor.gainReductionHistory',
    'compressor.transferCurve',
    'compressor.detector',
    'compressor.combined',
  ],
}
