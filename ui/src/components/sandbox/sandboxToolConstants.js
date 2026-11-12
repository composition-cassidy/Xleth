// Shared between SandboxSelectionActionBar (Fade In/Out) and SandboxStackPanel
// (inline shape editors for FADE/CROSSFADE ops) — one list of curve names
// rather than two copies drifting apart.
export const FADE_SHAPES = [
  { value: 'linear', label: 'Linear' },
  { value: 'equalPower', label: 'Equal Power' },
  { value: 'exponential', label: 'Exponential' },
  { value: 'logarithmic', label: 'Logarithmic' },
  { value: 'sCurve', label: 'S-Curve' },
  { value: 'hann', label: 'Hann' },
]

// ── Which tool owns the pointer, and what it does ───────────────────────────
// Derived from the three mutually-exclusive arm flags rather than stored: they
// are the actual state the canvas gates on (see SandboxWaveformCanvas), and a
// fourth "activeTool" field would be a second source of truth able to disagree
// with them.
//
// Shared with the status bar, which is where the hint is shown — the tool
// column is 88px wide and a sentence does not fit in it.
export function activeToolOf({ paintEditMode, envelopeEditMode, spcSelectMode }) {
  if (paintEditMode) return 'paint'
  if (envelopeEditMode) return 'envelope'
  if (spcSelectMode) return 'region'
  return 'select'
}

export const TOOL_HINTS = {
  select: 'Drag to select. Drag an edge to adjust it, click to place the cursor, right-click for edits.',
  envelope: 'Click the line to add a point, drag a point to move it, right-click a point to delete it.',
  paint: 'Drag on the spectrogram to paint with the brush. The stroke is applied when you release.',
  region: 'Drag on the spectrogram to select a region, then attenuate, boost, mute or copy it.',
}

// ── The Keys list (status bar) ──────────────────────────────────────────────
// What the Sandbox answers to, grouped by what you are doing. A row is either a
// catalog command (`cmd`), whose CURRENT binding is looked up when the list
// opens — so a key rebound in Settings is shown as rebound — or a fixed mouse
// gesture (`keys`) that has no binding to look up.
export const SANDBOX_KEYS = [
  ['Play', [
    { cmd: 'sandbox.playComposite', what: 'Play or stop the mix' },
    { cmd: 'sandbox.auditionLayer', what: 'Play the active layer alone' },
    { cmd: 'sandbox.toggleLoop', what: 'Loop the played range' },
  ]],
  ['Select and edit', [
    { cmd: 'sandbox.selectAll', what: 'Select the whole layer' },
    { keys: 'Double-click', what: 'Select the whole layer' },
    { keys: 'Alt + drag', what: 'Select without zero-crossing snap' },
    { cmd: 'sandbox.cut', what: 'Cut the selection' },
    { cmd: 'sandbox.copy', what: 'Copy the selection' },
    { cmd: 'sandbox.paste', what: 'Paste at the cursor' },
    { cmd: 'sandbox.duplicateLayer', what: 'Duplicate the layer' },
  ]],
  ['Navigate', [
    { keys: 'Ctrl + wheel', what: 'Zoom at the pointer' },
    { keys: 'Shift + wheel', what: 'Scroll' },
    { cmd: 'sandbox.zoomToSelection', what: 'Zoom to the selection' },
    { cmd: 'sandbox.zoomToFit', what: 'Fit the whole layer' },
    { cmd: 'sandbox.cursorStart', what: 'Cursor to the start' },
    { cmd: 'sandbox.cursorEnd', what: 'Cursor to the end' },
  ]],
  ['Tools', [
    { cmd: 'sandbox.toolSelect', what: 'Select' },
    { cmd: 'sandbox.toolEnvelope', what: 'Envelope' },
    { cmd: 'sandbox.toolPaint', what: 'Paint' },
    { cmd: 'sandbox.toolRegion', what: 'Region' },
  ]],
]
