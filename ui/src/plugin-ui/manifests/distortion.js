// Distortion plugin manifest.
// Param table mirrors engine/src/audio/XlethDistortionEffect.h::createLayout().

export const DISTORTION_MANIFEST = {
  pluginId: 'distortion',

  params: {
    mode:       { kind: 'discrete',   min: 0,  max: 3,     defaultValue: 0,    format: 'raw',  label: 'Mode' },
    drive:      { kind: 'continuous', min: 0,  max: 48,    defaultValue: 12,   format: 'dB1',  label: 'Drive' },
    tone:       { kind: 'continuous', min: 20, max: 20000, defaultValue: 8000, format: 'hz0',  label: 'Tone' },
    filter_pos: { kind: 'discrete',   min: 0,  max: 1,     defaultValue: 1,    format: 'raw',  label: 'Filter Position' },
    mix:        { kind: 'continuous', min: 0,  max: 100,   defaultValue: 100,  format: 'pct0', label: 'Mix' },
  },

  meterSlots: ['PEAK_L', 'PEAK_R'],

  vizSources: [],
}
