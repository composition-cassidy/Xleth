import compressorDefault from './compressor.json'
import limiterDefault from './limiter.json'
import transientDefault from './transient.json'
import overdoneDefault from './overdone.json'
import distortionDefault from './distortion.json'
import resonanceSuppressorDefault from './resonancesuppressor.json'

// Bundled shipped layouts — imported at build time so they're always available.
// Add one entry per stock plugin as it migrates to the runtime renderer.
export const SHIPPED_LAYOUTS = {
  compressor:          compressorDefault,
  limiter:             limiterDefault,
  transientproc:       transientDefault,
  overdone:            overdoneDefault,
  distortion:          distortionDefault,
  resonancesuppressor: resonanceSuppressorDefault,
}
