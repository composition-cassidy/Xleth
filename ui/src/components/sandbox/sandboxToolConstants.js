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
