import { create } from 'zustand'

// ── Drag-to-route pointer state ──────────────────────────────────────────────
// Deliberately separate from samplerModulationStore: this holds nothing
// persistent and nothing that crosses the bridge. It exists for the ~300 ms a
// source card is being dragged over the panel, and every registered control
// subscribes to it to know whether to light up.
//
// The drag is POINTER-based rather than HTML5 drag-and-drop. The tray is
// portaled to <body> while its drop targets live inside the panel frame, and a
// registered target may be a <canvas> that already owns pointer capture for its
// own value drag; a window-level pointermove plus elementFromPoint hit-testing
// against [data-mod-target] behaves identically on both sides of that boundary
// and needs no dataTransfer round trip.

const useSamplerModDragStore = create((set) => ({
  // Flat source index (ENV 0-5, LFO 6-11, VELO 12, NOTE 13), or null when idle.
  source: null,
  label: '',
  // Pointer position, for the floating ghost.
  x: 0,
  y: 0,
  // targetKey() of the registration currently under the pointer, or null.
  hoverKey: null,

  begin: (source, label, x, y) => set({ source, label, x, y, hoverKey: null }),
  move: (x, y, hoverKey) => set({ x, y, hoverKey }),
  end: () => set({ source: null, label: '', hoverKey: null }),
}))

export default useSamplerModDragStore
