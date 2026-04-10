import { create } from 'zustand'

// Dispatch IPC to the correct track vs. master variant.
function ipc(key, trackFn, masterFn, ...args) {
  if (key === 'master') return window.xleth?.audio?.[masterFn]?.(...args)
  return window.xleth?.audio?.[trackFn]?.(Number(key), ...args)
}

function parseTopology(raw) {
  if (!raw) return null
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return null }
  }
  return typeof raw === 'object' ? raw : null
}

const useNodeGraphStore = create((set, get) => ({
  // { [key: "master" | String(trackId)]: { nodes: [], connections: [], isLinear: true } }
  graphs: {},

  // Toast message (auto-clears)
  toast: null,

  showToast: (msg, type = 'error') => {
    set({ toast: { msg, type } })
    setTimeout(() => {
      if (get().toast?.msg === msg) set({ toast: null })
    }, 3000)
  },

  fetchTopology: async (key) => {
    try {
      const raw = await ipc(key, 'getGraphTopology', 'getMasterGraphTopology')
      const topo = parseTopology(raw)
      if (topo) {
        set(s => ({ graphs: { ...s.graphs, [key]: topo } }))
      }
    } catch (e) {
      console.warn('[nodeGraphStore] fetchTopology failed:', e?.message)
    }
  },

  isGraphLinear: async (key) => {
    try {
      return await ipc(key, 'isGraphLinear', 'isMasterGraphLinear')
    } catch {
      return true
    }
  },

  addConnection: async (key, srcId, dstId) => {
    try {
      const ok = await ipc(key, 'addConnection', 'addMasterConnection', srcId, dstId)
      if (!ok) {
        get().showToast('Connection rejected — would create cycle')
        return false
      }
      await get().fetchTopology(key)
      return true
    } catch (e) {
      get().showToast('Connection failed: ' + (e?.message ?? 'unknown'))
      return false
    }
  },

  removeConnection: async (key, srcId, dstId) => {
    try {
      await ipc(key, 'removeConnection', 'removeMasterConnection', srcId, dstId)
      await get().fetchTopology(key)
    } catch (e) {
      console.warn('[nodeGraphStore] removeConnection failed:', e?.message)
    }
  },

  setWireGain: async (key, srcId, dstId, gain) => {
    try {
      await ipc(key, 'setWireGain', 'setMasterWireGain', srcId, dstId, gain)
    } catch (e) {
      console.warn('[nodeGraphStore] setWireGain failed:', e?.message)
    }
  },

  setWireMute: async (key, srcId, dstId, muted) => {
    try {
      await ipc(key, 'setWireMute', 'setMasterWireMute', srcId, dstId, muted)
      await get().fetchTopology(key)
    } catch (e) {
      console.warn('[nodeGraphStore] setWireMute failed:', e?.message)
    }
  },

  setNodePosition: async (key, nodeId, x, y) => {
    try {
      await ipc(key, 'setNodePosition', 'setMasterNodePosition', nodeId, x, y)
    } catch (e) {
      console.warn('[nodeGraphStore] setNodePosition failed:', e?.message)
    }
  },

  deleteNode: async (key, nodeId) => {
    // Use removeEffect from existing chain store IPC
    try {
      if (key === 'master') {
        await window.xleth?.audio?.removeMasterEffect?.(nodeId)
      } else {
        await window.xleth?.audio?.removeEffect?.(Number(key), nodeId)
      }
      await get().fetchTopology(key)
    } catch (e) {
      console.warn('[nodeGraphStore] deleteNode failed:', e?.message)
    }
  },

  addEffect: async (key, pluginId) => {
    try {
      const topo = get().graphs[key]
      const position = topo?.nodes?.filter(n => n.pluginId !== '__input__' && n.pluginId !== '__output__').length ?? 0
      if (key === 'master') {
        await window.xleth?.audio?.addMasterEffect?.(pluginId, position)
      } else {
        await window.xleth?.audio?.addEffect?.(Number(key), pluginId, position)
      }
      await get().fetchTopology(key)
    } catch (e) {
      console.warn('[nodeGraphStore] addEffect failed:', e?.message)
    }
  },

  setBypass: async (key, nodeId, bypassed) => {
    try {
      if (key === 'master') {
        await window.xleth?.audio?.setMasterEffectBypass?.(nodeId, bypassed)
      } else {
        await window.xleth?.audio?.setEffectBypass?.(Number(key), nodeId, bypassed)
      }
      await get().fetchTopology(key)
    } catch (e) {
      console.warn('[nodeGraphStore] setBypass failed:', e?.message)
    }
  },
}))

// Re-fetch topology when any window mutates the graph
window.xleth?.onGraphChanged?.((key) => {
  useNodeGraphStore.getState().fetchTopology(key)
})

export default useNodeGraphStore
