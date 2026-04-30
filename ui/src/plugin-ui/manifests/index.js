import { COMPRESSOR_MANIFEST } from './compressor.js'
import { LIMITER_MANIFEST } from './limiter.js'

// Central registry: pluginId → manifest
// Add an entry here for each stock plugin as it migrates to the runtime renderer.
export const MANIFESTS = {
  compressor: COMPRESSOR_MANIFEST,
  limiter:    LIMITER_MANIFEST,
}

export function getManifest(pluginId) {
  return MANIFESTS[pluginId] ?? null
}
