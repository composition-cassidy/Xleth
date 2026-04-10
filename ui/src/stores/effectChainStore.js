import { create } from 'zustand'
import useEqStore from './eqStore.js'
import useCompressorStore from './compressorStore.js'
import useDistortionStore from './distortionStore.js'
import useWaveshaperStore from './waveshaperStore.js'
import useDelayStore from './delayStore.js'
import useChorusStore from './chorusStore.js'

// Dispatch IPC to the correct track vs. master variant.
// key === 'master' → masterFn(...args)
// key === String(trackId) → trackFn(Number(key), ...args)
function ipc(key, trackFn, masterFn, ...args) {
  if (key === 'master') return window.xleth?.audio?.[masterFn]?.(...args)
  return window.xleth?.audio?.[trackFn]?.(Number(key), ...args)
}

function parseChain(raw) {
  if (!raw) return []
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return [] }
  }
  return Array.isArray(raw) ? raw : []
}

const useEffectChainStore = create((set, get) => ({
  // { [key: "master" | String(trackId)]: [{nodeId, pluginId, position, bypassed}] }
  chains: {},

  fetchChain: async (key) => {
    try {
      const raw = await ipc(key, 'getEffectChain', 'getMasterEffectChain')
      const chain = parseChain(raw)
      set(s => ({ chains: { ...s.chains, [key]: chain } }))
    } catch (e) {
      console.warn('[effectChainStore] fetchChain failed:', e?.message)
    }
  },

  addEffect: async (key, pluginId) => {
    const chain = get().chains[key] ?? []
    if (chain.length >= 100) return

    // Optimistic: append placeholder so UI responds immediately
    const placeholder = { nodeId: -1, pluginId, position: chain.length, bypassed: false }
    set(s => ({ chains: { ...s.chains, [key]: [...(s.chains[key] ?? []), placeholder] } }))

    try {
      await ipc(key, 'addEffect', 'addMasterEffect', pluginId, chain.length)
    } catch (e) {
      console.warn('[effectChainStore] addEffect failed:', e?.message)
    }
    await get().fetchChain(key)
  },

  removeEffect: async (key, nodeId) => {
    // Optimistic: filter out immediately
    set(s => ({
      chains: { ...s.chains, [key]: (s.chains[key] ?? []).filter(fx => fx.nodeId !== nodeId) },
    }))

    try {
      const ok = await ipc(key, 'removeEffect', 'removeMasterEffect', nodeId)
      if (ok === false) {
        console.warn('[effectChainStore] removeEffect failed (stale nodeId?), re-fetching chain')
      }
    } catch (e) {
      console.warn('[effectChainStore] removeEffect failed:', e?.message)
    }
    await get().fetchChain(key)
  },

  moveEffect: async (key, nodeId, newPos) => {
    // Optimistic: reorder locally
    set(s => {
      const arr = [...(s.chains[key] ?? [])]
      const srcIdx = arr.findIndex(fx => fx.nodeId === nodeId)
      if (srcIdx === -1) return s
      const [item] = arr.splice(srcIdx, 1)
      arr.splice(newPos, 0, item)
      return { chains: { ...s.chains, [key]: arr } }
    })

    try {
      const ok = await ipc(key, 'moveEffect', 'moveMasterEffect', nodeId, newPos)
      if (ok === false) {
        console.warn('[effectChainStore] moveEffect failed (stale nodeId?), re-fetching chain')
      }
    } catch (e) {
      console.warn('[effectChainStore] moveEffect failed:', e?.message)
    }
    await get().fetchChain(key)
  },

  setBypass: async (key, nodeId, bypassed) => {
    // Optimistic: flip bypass flag
    set(s => ({
      chains: {
        ...s.chains,
        [key]: (s.chains[key] ?? []).map(fx =>
          fx.nodeId === nodeId ? { ...fx, bypassed } : fx
        ),
      },
    }))

    try {
      const ok = await ipc(key, 'setEffectBypass', 'setMasterEffectBypass', nodeId, bypassed)
      if (ok === false) {
        console.warn('[effectChainStore] setBypass failed (stale nodeId?), re-fetching chain')
      }
    } catch (e) {
      console.warn('[effectChainStore] setBypass failed:', e?.message)
    }
    await get().fetchChain(key)
  },
}))

// Re-fetch chain when any window mutates the graph
window.xleth?.onGraphChanged?.((key) => {
  useEffectChainStore.getState().fetchChain(key)
})

// On project load, all AudioGraph nodeIds have been reassigned by fromJSON.
// Close every open effect editor panel (they hold stale nodeIds in target)
// and re-fetch every cached chain so the store has the new nodeIds.
window.xleth?.onProjectLoaded?.(() => {
  console.log('[effectChainStore] project-loaded — closing panels, refreshing all chains')

  // Close all open effect editor panels
  useEqStore.getState().close()
  useCompressorStore.getState().close()
  useDistortionStore.getState().close()
  useWaveshaperStore.getState().close()
  useDelayStore.getState().close()
  useChorusStore.getState().close()

  // Re-fetch every chain that was cached
  const { chains, fetchChain } = useEffectChainStore.getState()
  for (const key of Object.keys(chains)) {
    fetchChain(key)
  }
})

export default useEffectChainStore
