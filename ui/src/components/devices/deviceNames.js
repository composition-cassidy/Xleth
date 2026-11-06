// The one device-name map (ui/DESIGN.md "Device system"). Sentence case, the
// same string in the device title bar, its window, its hint text and its
// accessible name. Product names keep their own casing (APEX, GLOSS, FET).
//
// PLUGIN_NAMES in components/mixer/effectEditorOpeners.js is the legacy label
// table (Mixer chain rows, FX Graph); it is left alone until Phase 4b moves the
// last editors onto the device frame.

export const DEVICE_NAMES = Object.freeze({
  testgain: 'Test gain',
  compressor: 'Compressor',
  limiter: 'Limiter',
  overdone: 'Overdone',
  transientproc: 'Transient processor',
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
  smartbalance: 'Smart balance',
  resonancesuppressor: 'Resonance suppressor',
  apex: 'APEX',
  gloss: 'GLOSS',
  amp: 'Amp stack',
  pitchshifter: 'Pitch shifter',
  glue: 'Glue comp',
  opto: 'Opto comp',
  fet: 'FET comp',
  varimu: 'Vari-mu comp',
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
