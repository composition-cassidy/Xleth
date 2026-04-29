// ─── theme.js ────────────────────────────────────────────────────────────────
// Cached per-rAF theme-token reads for canvas painters. Reading CSS custom
// properties is cheap-ish but not free; painters call readDynamicsTheme()
// once per frame and reuse the returned object.

const TOKEN_KEYS = Object.freeze([
  '--theme-bg-primary',
  '--theme-bg-secondary',
  '--theme-bg-inset',
  '--theme-text',
  '--theme-text-muted',
  '--theme-text-subtle',
  '--theme-accent',
  '--theme-accent-bg-subtle',
])

// Fallback colors used when a token is missing. We never hardcode a vivid
// palette here; the fallbacks are neutral so a stripped theme still renders.
const FALLBACK = {
  '--theme-bg-primary':       '#1a1a1a',
  '--theme-bg-secondary':     '#222',
  '--theme-bg-inset':         '#0f0f0f',
  '--theme-text':             '#e0e0e0',
  '--theme-text-muted':       '#888',
  '--theme-text-subtle':      '#555',
  '--theme-accent':           '#4ecdc4',
  '--theme-accent-bg-subtle': '#2a3a3a',
}

export function readDynamicsTheme(targetEl) {
  const cs = targetEl ? getComputedStyle(targetEl) : null
  const out = {}
  for (const k of TOKEN_KEYS) {
    const v = cs?.getPropertyValue(k)?.trim()
    out[k] = v && v.length > 0 ? v : FALLBACK[k]
  }
  return {
    bg:        out['--theme-bg-primary'],
    bgInset:   out['--theme-bg-inset'],
    surface:   out['--theme-bg-secondary'],
    text:      out['--theme-text'],
    textMuted: out['--theme-text-muted'],
    grid:      out['--theme-text-subtle'],
    accent:    out['--theme-accent'],
    accentDim: out['--theme-accent-bg-subtle'],
  }
}
