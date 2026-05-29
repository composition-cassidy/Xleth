// Shared effect-editor opening logic.
//
// Single source of truth for the stock-effect editor registry and the
// chain/graph stock-vs-VST decision. Both the Mixer Chain (EffectModule.jsx)
// and the FX Graph (FxGraphPanel.tsx) open editors through this module so the
// two paths can never diverge.
//
// Every opener and editor store is identity-agnostic: it only needs
// (trackId, engineNodeId, storeKey). Chain mode passes the chain slot's nodeId;
// FX Graph mode passes the engine nodeId it resolved from a graph-owned
// effectInstanceId. Neither path passes graphState's topology node.id.

import useEqStore from '../../stores/eqStore.js'
import useCompressorStore from '../../stores/compressorStore.js'
import useLimiterStore from '../../stores/limiterStore.js'
import useDistortionStore from '../../stores/distortionStore.js'
import useWaveshaperStore from '../../stores/waveshaperStore.js'
import useDelayStore from '../../stores/delayStore.js'
import useChorusStore from '../../stores/chorusStore.js'
import useFlangerStore from '../../stores/flangerStore.js'
import usePhaserStore from '../../stores/phaserStore.js'
import useOverdoneStore from '../../stores/overdoneStore.js'
import useReverbStore from '../../stores/reverbStore.js'
import useTransientProcStore from '../../stores/transientProcStore.js'
import useSmartBalanceStore from '../../stores/smartBalanceStore.js'
import useResonanceSuppressorStore from '../../stores/resonanceSuppressorStore.js'

// Registry: pluginId -> opener(trackId, nodeId, storeKey)
// Add one entry per effect that has a dedicated editor panel.
export const EFFECT_EDITORS = {
  xletheq: (trackId, nodeId, storeKey) => {
    useEqStore.getState().open(trackId, nodeId, storeKey)
  },
  compressor: (trackId, nodeId, storeKey) => {
    useCompressorStore.getState().open(trackId, nodeId, storeKey)
  },
  distortion: (trackId, nodeId, storeKey) => {
    useDistortionStore.getState().open(trackId, nodeId, storeKey)
  },
  waveshaper: (trackId, nodeId, storeKey) => {
    useWaveshaperStore.getState().open(trackId, nodeId, storeKey)
  },
  delay: (trackId, nodeId, storeKey) => {
    useDelayStore.getState().open(trackId, nodeId, storeKey)
  },
  chorus: (trackId, nodeId, storeKey) => {
    useChorusStore.getState().open(trackId, nodeId, storeKey)
  },
  flanger: (trackId, nodeId, storeKey) => {
    useFlangerStore.getState().open(trackId, nodeId, storeKey)
  },
  phaser: (trackId, nodeId, storeKey) => {
    usePhaserStore.getState().open(trackId, nodeId, storeKey)
  },
  overdone: (trackId, nodeId, storeKey) => {
    useOverdoneStore.getState().open(trackId, nodeId, storeKey)
  },
  reverb: (trackId, nodeId, storeKey) => {
    useReverbStore.getState().open(trackId, nodeId, storeKey)
  },
  limiter: (trackId, nodeId, storeKey) => {
    useLimiterStore.getState().open(trackId, nodeId, storeKey)
  },
  transientproc: (trackId, nodeId, storeKey) => {
    useTransientProcStore.getState().open(trackId, nodeId, storeKey)
  },
  smartbalance: (trackId, nodeId, storeKey) => {
    useSmartBalanceStore.getState().open(trackId, nodeId, storeKey)
  },
  resonancesuppressor: (trackId, nodeId, storeKey) => {
    useResonanceSuppressorStore.getState().open(trackId, nodeId, storeKey)
  },
}

export const PLUGIN_NAMES = {
  testgain: 'Test Gain',
  compressor: 'Compressor',
  limiter: 'Limiter',
  overdone: 'Overdone',
  transientproc: 'Transient Proc',
  xletheq: 'Xleth EQ',
  xlethfilter: 'Xleth Filter',
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
}

export function resolveTrackId(storeKey) {
  return storeKey === 'master' ? -1 : Number(storeKey)
}

// True if pluginId has a dedicated stock editor panel.
export function hasStockEffectEditor(pluginId) {
  return Boolean(EFFECT_EDITORS[pluginId])
}

// True if pluginId is a VST/native plugin (no stock-effect display name).
// Mirrors EffectModule.jsx's `!(pluginId in PLUGIN_NAMES)` test.
export function isVstPluginId(pluginId) {
  return !(pluginId in PLUGIN_NAMES)
}

// Open the editor for an engine-backed effect addressed by (trackId, engineNodeId).
// Used by the FX Graph Edit button after it resolves effectInstanceId -> engineNodeId.
// Returns { ok: true, kind } or { ok: false, reason }. Never opens an editor for
// an unresolved engine node, and never touches graphState topology IDs.
export function openEffectEditorByEngineNode({
  pluginId,
  engineNodeId,
  storeKey,
  audio,
}) {
  if (typeof pluginId !== 'string' || pluginId.length === 0 || pluginId === 'placeholder') {
    return { ok: false, reason: 'not_engine_backed' }
  }
  if (!Number.isInteger(engineNodeId) || engineNodeId < 0) {
    return { ok: false, reason: 'engine_node_unresolved' }
  }

  const trackId = resolveTrackId(storeKey)

  const stockOpener = EFFECT_EDITORS[pluginId]
  if (stockOpener) {
    stockOpener(trackId, engineNodeId, storeKey)
    return { ok: true, kind: 'stock' }
  }

  if (typeof audio?.openPluginEditor === 'function') {
    audio.openPluginEditor(trackId, engineNodeId)
    return { ok: true, kind: 'plugin' }
  }

  return { ok: false, reason: 'editor_unavailable' }
}
