import compressorDefault from './compressor.json'

// Bundled shipped layouts — imported at build time so they're always available.
// Add one entry per stock plugin as it migrates to the runtime renderer.
export const SHIPPED_LAYOUTS = {
  compressor: compressorDefault,
}
