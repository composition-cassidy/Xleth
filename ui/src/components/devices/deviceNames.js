// The one device-name map (ui/DESIGN.md "Device system"). Title Case, the
// same string in the device title bar, its window, its hint text and its
// accessible name. Product names keep their own casing (APEX, GLOSS, FET).
//
// DEVICE_SHORT_NAMES is the same list abbreviated for the one place that is
// narrow: a Mixer strip's insert rows (72 px wide, about 12 characters). Every
// name that already fits is repeated unchanged, so the table is complete.
//
// PLUGIN_NAMES in components/mixer/effectEditorOpeners.js is the legacy label
// table (Mixer chain rows, FX Graph); it is left alone until Phase 4b moves the
// last editors onto the device frame.

export const DEVICE_NAMES = Object.freeze({
  testgain: 'Test Gain',
  compressor: 'Compressor',
  limiter: 'Limiter',
  overdone: 'Overdone',
  transientproc: 'Transient Processor',
  xletheq: 'Parametric EQ',
  xlethfilter: 'Filter',
  distortion: 'Distortion',
  waveshaper: 'Waveshaper',
  uniflange: 'UniFlange',
  chorus: 'Chorus',
  flanger: 'Flanger',
  phaser: 'Phaser',
  phanjer: 'Phanjer',
  delay: 'Delay',
  reverb: 'Reverb',
  smartbalance: 'Smart Balance',
  resonancesuppressor: 'Resonance Suppressor',
  apex: 'APEX',
  gloss: 'GLOSS',
  amp: 'Amp Stack',
  pitchshifter: 'Pitch Shifter',
  glue: 'Glue Comp',
  opto: 'Opto Comp',
  fet: 'FET Comp',
  varimu: 'Vari-Mu Comp',
  fedda: 'Fedda',
})

export const DEVICE_SHORT_NAMES = Object.freeze({
  testgain: 'Test Gain',
  compressor: 'Compressor',
  limiter: 'Limiter',
  overdone: 'Overdone',
  transientproc: 'Trans. Proc.',
  xletheq: 'Param. EQ',
  xlethfilter: 'Filter',
  distortion: 'Distortion',
  waveshaper: 'Waveshaper',
  uniflange: 'UniFlange',
  chorus: 'Chorus',
  flanger: 'Flanger',
  phaser: 'Phaser',
  phanjer: 'Phanjer',
  delay: 'Delay',
  reverb: 'Reverb',
  smartbalance: 'Smart Bal.',
  resonancesuppressor: 'Res. Suppr.',
  apex: 'APEX',
  gloss: 'GLOSS',
  amp: 'Amp Stack',
  pitchshifter: 'Pitch Shift',
  glue: 'Glue Comp',
  opto: 'Opto Comp',
  fet: 'FET Comp',
  varimu: 'Vari-Mu',
  fedda: 'Fedda',
})

/** Display name for a chain entry: stock name, else the plugin's own, else its id. */
export function deviceName(effect, vstPlugins = []) {
  const explicit = effect?.displayName ?? effect?.name ?? effect?.pluginName
  if (explicit) return explicit
  const stock = DEVICE_NAMES[effect?.pluginId]
  if (stock) return stock
  const vst = vstPlugins.find((p) => p.id === effect?.pluginId)
  return vst?.name ?? effect?.pluginId ?? 'Effect'
}

/**
 * The abbreviated name for a narrow row. A stock effect uses its short name even
 * when the chain entry carries an explicit displayName (the engine stores the full
 * name there); a plugin or a renamed entry keeps its own name, which the row clips.
 */
export function deviceShortName(effect, vstPlugins = []) {
  const stock = DEVICE_SHORT_NAMES[effect?.pluginId]
  if (stock) return stock
  return deviceName(effect, vstPlugins)
}
