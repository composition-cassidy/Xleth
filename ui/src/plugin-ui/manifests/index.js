import { COMPRESSOR_MANIFEST } from './compressor.js'
import { LIMITER_MANIFEST } from './limiter.js'
import { TRANSIENT_MANIFEST } from './transient.js'
import { OVERDONE_MANIFEST } from './overdone.js'
import { DISTORTION_MANIFEST } from './distortion.js'
import { RESONANCE_SUPPRESSOR_MANIFEST } from './resonancesuppressor.js'

// Central registry: pluginId → manifest
// Add an entry here for each stock plugin as it migrates to the runtime renderer.
export const MANIFESTS = {
  compressor:          COMPRESSOR_MANIFEST,
  limiter:             LIMITER_MANIFEST,
  transientproc:       TRANSIENT_MANIFEST,
  overdone:            OVERDONE_MANIFEST,
  distortion:          DISTORTION_MANIFEST,
  resonancesuppressor: RESONANCE_SUPPRESSOR_MANIFEST,
}

export function getManifest(pluginId) {
  return MANIFESTS[pluginId] ?? null
}
