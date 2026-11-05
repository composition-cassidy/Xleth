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
  select: 'drag = select · drag an edge = adjust · click = cursor · Alt = no zero-cross snap',
  envelope: 'click the line = add point · drag = move · right-click = delete',
  paint: 'drag on the spectrogram = paint attenuation · release = commit',
  region: 'drag on the spectrogram = select a region · then Attenuate / Boost / Mute / Copy',
}
