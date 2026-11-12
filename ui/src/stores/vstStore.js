import { create } from 'zustand'

// Shared state for the VST3 plugin system:
// - scanned plugin list (shared between EffectChainPanel submenus and VstBrowser)
// - scan progress (polled by ScanProgressBar)
// - browser panel visibility + which chain double-click targets

const useVstStore = create((set) => ({
  plugins:      [],   // [{ id, name, vendor, category, format, filePath, numInputs, numOutputs }]
  failedPlugins: [],  // persisted scan failures: [{ filePath, path, format, reason, fileTime, firstSeen, lastAttempt, attempts }]
  browserOpen:  false,
  browserStoreKey: null,  // storeKey ('master' | '0' | '1' | ...) for double-click add

  fetchPlugins: async () => {
    try {
      const raw = await window.xleth?.audio?.getScannedPlugins?.()
      if (!raw) return
      const list = JSON.parse(raw)
      set({ plugins: Array.isArray(list) ? list : [] })
    } catch (err) {
      // An invalid payload or a missing RPC used to vanish here as an empty
      // menu. Keep the current list, but say why.
      console.error('[PluginLib] getScannedPlugins failed', err)
    }
  },

  fetchFailed: async () => {
    try {
      const raw = await window.xleth?.audio?.getFailedPlugins?.()
      if (!raw) return
      const list = JSON.parse(raw)
      set({ failedPlugins: Array.isArray(list) ? list : [] })
    } catch (err) {
      console.error('[PluginLib] getFailedPlugins failed', err)
    }
  },

  openBrowser:  (storeKey = null) => set({ browserOpen: true, browserStoreKey: storeKey }),
  closeBrowser: ()                => set({ browserOpen: false }),
}))

export default useVstStore
