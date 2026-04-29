// Named formatter registry for knob/meter value display.
// All layout JSON format references must use a key from this map.
// Unknown keys fall back to 'raw'.

const FORMATS = {
  raw:         v => String(Math.round(v)),
  dB1:         v => `${v.toFixed(1)} dB`,
  dB1_signed:  v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`,
  ms0:         v => `${v.toFixed(0)} ms`,
  ms1:         v => `${v.toFixed(1)} ms`,
  pct0:        v => `${v.toFixed(0)} %`,
  pct1:        v => `${v.toFixed(1)} %`,
  ratio:       v => `${v.toFixed(1)}:1`,
  hz_smart:    v => v >= 1000 ? `${(v / 1000).toFixed(1)}k Hz` : `${v.toFixed(0)} Hz`,
  lufs1:       v => `${v.toFixed(1)} LUFS`,
}

export function resolveFormat(key) {
  return FORMATS[key] ?? FORMATS.raw
}

export { FORMATS }
