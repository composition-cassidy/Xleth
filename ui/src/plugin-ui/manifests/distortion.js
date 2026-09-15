// Distortion plugin manifest.
// Param table mirrors engine/src/audio/XlethDistortionEffect.h::createLayout().

export const DISTORTION_MANIFEST = {
  pluginId: 'distortion',

  params: {
    mode:       { kind: 'discrete',   min: 0,  max: 6,     defaultValue: 0,    format: 'raw',  label: 'Mode' },
    drive:      { kind: 'continuous', min: 0,  max: 48,    defaultValue: 12,   format: 'dB1',  label: 'Drive' },
    tone:       { kind: 'continuous', min: 20, max: 20000, defaultValue: 8000, format: 'hz0',  label: 'Tone' },
    filter_pos: { kind: 'discrete',   min: 0,  max: 1,     defaultValue: 1,    format: 'raw',  label: 'Filter Position' },
    mix:        { kind: 'continuous', min: 0,  max: 100,   defaultValue: 100,  format: 'pct0', label: 'Mix' },
    // Mode-specific params. Each default is the transparent value for its mode,
    // matching the engine defaults exactly (that is what keeps pre-expansion
    // sessions sounding identical).
    symmetry:   { kind: 'continuous', min: 0,  max: 100,   defaultValue: 100,  format: 'pct0', label: 'Symmetry' },
    bits:       { kind: 'continuous', min: 2,  max: 16,    defaultValue: 16,   format: 'raw',  label: 'Bits' },
    downsample: { kind: 'continuous', min: 1,  max: 40,    defaultValue: 1,    format: 'raw',  label: 'Downsample' },
  },

  meterSlots: ['PEAK_L', 'PEAK_R'],

  vizSources: [],
}
