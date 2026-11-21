import useSandboxStore from '../../stores/sandboxStore.js'
import { useShortcutCommand } from '../../windowing/managers/useKeyboardBinding.ts'

// ─── Sample Sandbox navigation & transport shortcuts ─────────────────────────
//
// Zoom, scroll, cursor movement and audition, scoped to `panel:sampleSandbox`
// exactly like the edit shortcuts next door (see useSandboxEditShortcuts.js for
// the claim-the-key contract these follow — a handler returns 'handled' only
// when it actually did something, so a combo the panel had no use for falls
// through untouched).
//
// The combos follow the conventions of the editors people arrive here already
// knowing — Ctrl+E / Ctrl+F for zoom-to-selection and fit are Audacity's, and
// +/− are universal. Nothing here invents a gesture where a familiar one
// exists.
//
// These are deliberately NOT wired through the EFFECT ▾ menu the way the edit
// shortcuts are: zooming is not an edit, it produces no op and no undo entry,
// and putting it in a menu of destructive operations would imply otherwise.
// The tool column's zoom buttons are their discoverable half instead.

function useViewAction(commandId, run) {
  useShortcutCommand(commandId, (e) => {
    const state = useSandboxStore.getState()
    // Nothing to navigate without a rendered layer — let the key through.
    const layer = state.layers.find((l) => l.id === state.activeLayerId)
    if (!layer || layer.renderState !== 'ready') return false
    if (run(state, layer) === false) return false
    e.preventDefault()
    e.stopPropagation()
    return 'handled'
  })
}

export function useSandboxViewShortcuts() {
  // ── Zoom ────────────────────────────────────────────────────────────────
  useViewAction('sandbox.zoomIn', (state) => { state.zoomBy(1 / 1.6); return true })
  useViewAction('sandbox.zoomOut', (state) => { state.zoomBy(1.6); return true })
  useViewAction('sandbox.zoomToSelection', (state) => { state.zoomToSelection(); return true })
  useViewAction('sandbox.zoomToFit', (state) => { state.zoomToFit(); return true })

  // ── Scroll ──────────────────────────────────────────────────────────────
  // A fifth of the visible width per press: enough to move, small enough to
  // keep a landmark on screen between presses.
  useViewAction('sandbox.scrollLeft', (state) => { state.panByFraction(-0.2); return true })
  useViewAction('sandbox.scrollRight', (state) => { state.panByFraction(0.2); return true })

  // ── Cursor ──────────────────────────────────────────────────────────────
  // Home/End move the CURSOR (a zero-width selection — the same representation
  // a click on the waveform produces), not the view: moving the cursor is the
  // thing that changes where the next play starts, and the view follows it
  // only if the user asked for follow.
  useViewAction('sandbox.cursorStart', (state) => {
    state.setSelection({ startSample: 0, endSample: 0 })
    return true
  })
  useViewAction('sandbox.cursorEnd', (state, layer) => {
    const n = layer.renderedBuffer?.numSamples ?? 0
    state.setSelection({ startSample: n, endSample: n })
    return true
  })

  // ── Transport ───────────────────────────────────────────────────────────
  // Shift+Space auditions the ACTIVE LAYER alone; plain Space (registered in
  // SandboxPanelContent) plays the composite. That split matches what the two
  // actually cost: the layer path plays PCM already sitting in this process,
  // the composite path may have to render first.
  useViewAction('sandbox.auditionLayer', (state, layer) => {
    state.toggleLayerPreview(layer.id)
    return true
  })
  useViewAction('sandbox.toggleLoop', (state) => { state.toggleLoopPlayback(); return true })

  // ── Tools ───────────────────────────────────────────────────────────────
  // One letter each, the same grammar the timeline's tools use. They go
  // through the store's selectTool, which is also what the tool bar's buttons
  // call, so a key and its button cannot arm a tool differently.
  useViewAction('sandbox.toolSelect', (state) => { state.selectTool('select'); return true })
  useViewAction('sandbox.toolEnvelope', (state) => { state.selectTool('envelope'); return true })
  useViewAction('sandbox.toolPaint', (state) => { state.selectTool('paint'); return true })
  useViewAction('sandbox.toolRegion', (state) => { state.selectTool('region'); return true })
}
