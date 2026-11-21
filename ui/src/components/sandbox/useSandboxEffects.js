import useSandboxStore, { hasMeaningfulSelection } from '../../stores/sandboxStore.js'
import { EFFECT_REGISTRY } from '../../stores/sandboxEffectRegistry.js'

// ── One way to run an operation ─────────────────────────────────────────────
//
// The action bar's buttons, the Effects menu and the waveform's right-click
// menu all offer entries from sandboxEffectRegistry.js. Each used to carry its
// own copy of "is this allowed right now, and if not why" and its own call to
// `entry.run` — three doors that could drift into three behaviours. This hook
// is the one implementation: every door asks it the same two questions
// (`reasonFor`, `hintFor`) and runs through the same `run`.

const ENTRY_BY_ID = Object.fromEntries(EFFECT_REGISTRY.map((e) => [e.id, e]))

export const effectEntry = (id) => ENTRY_BY_ID[id] ?? null

/** "Fade In" -> "Fade in": the registry's labels are title case, the UI is sentence case. */
export const sentenceCase = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : s)

// What a click will do, said for the state the panel is in right now. The rule
// that a bare cursor means "the whole layer" (or, for a fade, "between the
// cursor and the edge") is only learnable if the control says it before the
// click, so the hint is computed rather than fixed.
function describe(id, { hasSelection, cursorSample, numSamples }) {
  const scope = hasSelection ? 'the selection' : 'the whole layer'
  switch (id) {
    case 'cut': return 'Remove the selection and close the gap. It goes to the clipboard (Ctrl+X or Delete)'
    case 'copy': return 'Copy the selection to the clipboard (Ctrl+C)'
    case 'paste': return 'Insert the clipboard at the cursor (Ctrl+V)'
    case 'trim': return 'Keep the selection and remove everything outside it'
    case 'silence': return 'Replace the selection with silence, keeping the length'
    case 'insertSilence': return 'Insert silence as long as the selection, pushing the rest later'
    case 'fadeIn':
      if (hasSelection) return 'Fade the selection in'
      return cursorSample > 0 && cursorSample < numSamples
        ? 'Fade in from the start of the layer to the cursor'
        : 'Fade the whole layer in. Place the cursor or select a range to fade less'
    case 'fadeOut':
      if (hasSelection) return 'Fade the selection out'
      return cursorSample > 0 && cursorSample < numSamples
        ? 'Fade out from the cursor to the end of the layer'
        : 'Fade the whole layer out. Place the cursor or select a range to fade less'
    case 'gain': return `Add a gain to ${scope}, then set the amount in the edit stack`
    case 'normalize': return `Raise ${scope} until its peak reaches the target level`
    case 'reverse': return `Play ${scope} backwards`
    case 'splice': return 'Split at the cursor and swap the two halves'
    case 'crossfade': return 'Smooth the seam at the cursor with a short crossfade'
    default: return ''
  }
}

export function useSandboxEffects() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const selection = useSandboxStore((s) => s.selection)
  const clipboard = useSandboxStore((s) => s.clipboard)

  const layer = layers.find((l) => l.id === activeLayerId) ?? null
  const layerReady = !!layer && layer.renderState === 'ready'
  const sampleRate = layer?.renderedBuffer?.sampleRate
  const numSamples = layer?.renderedBuffer?.numSamples ?? 0
  const hasSelection = layerReady && hasMeaningfulSelection(selection, sampleRate)
  const cursorSample = selection?.startSample ?? 0
  const ctx = { hasSelection, cursorSample, numSamples }

  /** Why `entry` cannot run now, or null when it can. */
  const reasonFor = (entry) => {
    if (!entry) return 'Not available'
    if (entry.alwaysDisabled) return entry.disabledReason
    if (!layer) return 'Add a layer first'
    if (!layerReady) return 'Waiting for this layer to finish rendering'
    if (entry.needsSelection && !hasSelection) return 'Select a range first'
    if (entry.needsClipboard && !clipboard) return 'The clipboard is empty'
    if (entry.maxInstances < Infinity) {
      const count = layer.ops.filter(entry.matchesStack).length
      if (count >= entry.maxInstances) return `Already in the edit stack (${entry.whyNoMulti || 'one per layer'})`
    }
    return null
  }

  /** What `entry` will do now; the reason it cannot, when it cannot. */
  const hintFor = (entry) => reasonFor(entry) || (entry ? describe(entry.id, ctx) : '')

  const run = (entry) => {
    if (!entry?.run || !layer || reasonFor(entry)) return
    const store = useSandboxStore.getState()
    entry.run(store, {
      layerId: layer.id, selection: store.selection, cursorSample, hasSelection,
    })
  }

  return { layer, layerReady, hasSelection, cursorSample, sampleRate, numSamples, clipboard, reasonFor, hintFor, run }
}
