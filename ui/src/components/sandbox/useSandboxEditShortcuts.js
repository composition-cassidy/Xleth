import useSandboxStore, { hasMeaningfulSelection } from '../../stores/sandboxStore.js'
import { useKeyboardBinding } from '../../windowing/managers/useKeyboardBinding.ts'

// ─── Sample Sandbox edit shortcuts ────────────────────────────────────────────
//
// Delete / Backspace / Ctrl+X / Ctrl+C / Ctrl+V / Ctrl+D, scoped to
// `panel:sampleSandbox` so they only fire while this panel is focused (see
// resolveFocusedPanel in KeyboardManager — a hidden-but-mounted panel never
// gets them, and a focused text field takes precedence over all of them).
//
// ── Every one of these runs the SAME store action the EFFECT ▾ menu does ─────
// Nothing here reimplements an edit. A shortcut is a second door onto
// cutSelection / copySelection / pasteClipboard / duplicateLayer, so a
// keyboard cut and a menu Cut are the same undo entry with the same semantics,
// and a change to one is a change to both. That is also why this file holds no
// clipboard of its own: the clipboard lives in the ENGINE (SandboxRenderer's
// session store, reached via sandbox_copySelection), and the store's
// `clipboard` field is just the handle to it.
//
// ── Delete IS Cut ────────────────────────────────────────────────────────────
// Both Delete and Ctrl+X copy the selection to the clipboard and then remove it
// with a rippling Cut op. Not "Delete discards, Cut keeps": in an audio editor
// the range you just removed is usually the range you are about to put
// somewhere else, and a Delete that quietly dropped it would be the only
// gesture in this panel that destroys material with no way back short of undo.
//
// ── Claiming keys ────────────────────────────────────────────────────────────
// A handler returns 'handled' ONLY when it actually ran an edit. When its
// precondition is not met (no ready layer, no selection, empty clipboard) it
// returns false and the key falls through untouched — Ctrl+C with nothing
// selected must not be swallowed by a panel that had nothing to copy.

// One binding per combo, running `run`. Fixed arity — two combos — rather than
// an array plus a loop, because a hook count that depends on an argument is a
// rules-of-hooks hazard nobody should have to re-verify when this file grows.
// `run` receives the current store state plus the ready active layer and
// returns true if it acted.
//
// The uppercase spellings exist for Caps Lock, where event.key (which is what
// KeyboardManager builds its combo string from) arrives as 'X' rather than 'x'.
function useEditAction(comboA, comboB, run) {
  const handler = (e) => {
    const state = useSandboxStore.getState()
    const layer = readyLayer(state)
    if (!layer) return false
    if (!run(state, layer)) return false
    e.preventDefault()
    e.stopPropagation()
    return 'handled'
  }
  useKeyboardBinding('panel:sampleSandbox', comboA, handler)
  useKeyboardBinding('panel:sampleSandbox', comboB, handler)
}

// The active layer, but only when it is in a state where an edit means
// something. `renderState !== 'ready'` covers both "never rendered" and "the
// last render failed" — in either case the selection's sample indices do not
// describe audio anyone can see, so an edit against them would be a guess.
function readyLayer(state) {
  const layer = state.layers.find((l) => l.id === state.activeLayerId)
  return layer && layer.renderState === 'ready' ? layer : null
}

function selected(state, layer) {
  return hasMeaningfulSelection(state.selection, layer.renderedBuffer?.sampleRate)
}

// CUT — clipboard, then a rippling Cut. 'ripple' rather than 'gap' because that
// is what Delete means everywhere else in the app; leaving silence behind
// instead is the EFFECT ▾ Silence entry.
function runCut(state, layer) {
  if (!selected(state, layer)) return false
  state.cutSelection(layer.id, 'ripple')
  return true
}

export function useSandboxEditShortcuts() {
  useEditAction('Delete', 'Backspace', runCut)
  useEditAction('Ctrl+x', 'Ctrl+X', runCut)

  useEditAction('Ctrl+c', 'Ctrl+C', (state, layer) => {
    if (!selected(state, layer)) return false
    state.copySelection(layer.id)
    return true
  })

  // PASTE — INSERTS at the selection start (or at 0 with no selection),
  // matching the EFFECT ▾ Paste entry exactly. It does not replace a
  // selected range: "replace" would be a cut plus a paste, i.e. two undo steps
  // and a clobbered clipboard, and the engine's PASTE op has no replace-range
  // mode to do it in one (see PasteParams).
  useEditAction('Ctrl+v', 'Ctrl+V', (state, layer) => {
    if (!state.clipboard) return false
    state.pasteClipboard(layer.id, state.selection?.startSample ?? 0, true)
    return true
  })

  // DUPLICATE — the whole layer with its op-stack and mix params, not the
  // selection. Ctrl+C / Ctrl+V is how you duplicate a range.
  useEditAction('Ctrl+d', 'Ctrl+D', (state, layer) => {
    state.duplicateLayer(layer.id)
    return true
  })
}
