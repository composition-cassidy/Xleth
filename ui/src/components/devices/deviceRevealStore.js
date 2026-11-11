import { create } from 'zustand'

// "Show me this device": a one-shot request from outside the Devices tab (a mixer
// strip's insert row) to bring one device of a chain into view. Renderer-only,
// never persisted, never sent to the engine. The Devices tab consumes it: it
// scrolls that device into view and outlines it until the user does something
// else there.

const useDeviceRevealStore = create((set) => ({
  /** { chainKey, index, nonce } or null. `nonce` makes a repeated request for the same device fire again. */
  request: null,
  reveal: (chainKey, index) => set((s) => ({
    request: { chainKey: String(chainKey), index, nonce: (s.request?.nonce ?? 0) + 1 },
  })),
  clear: () => set((s) => (s.request ? { request: null } : s)),
}))

/** Ask the Devices tab to show device `index` of `chainKey`'s chain. */
export function requestDeviceReveal(chainKey, index) {
  if (!Number.isInteger(index) || index < 0) return
  useDeviceRevealStore.getState().reveal(chainKey, index)
}

export default useDeviceRevealStore
