// ─── mixerCanvasTheme.js ──────────────────────────────────────────────────────
// Token reading + colour maths for the Delay and Reverb panels' canvases.
//
// Canvas cannot consume `var(--token)` directly, so every colour is resolved
// from the live computed style of the canvas element on each frame. That keeps
// the drawing theme-reactive (a theme swap repaints correctly on the next
// frame) without any component ever hardcoding a hex value.
//
// `withAlpha` is pure and unit-tested; `readMixerCanvasTheme` touches the DOM.

/**
 * Re-expresses a resolved colour (#rgb, #rrggbb, rgb(), rgba()) at a new alpha.
 * Returns a neutral grey rgba() when the input cannot be parsed, so a missing
 * token degrades to something visible rather than throwing mid-frame.
 */
export function withAlpha(color, alpha) {
  const value = String(color || '').trim()
  const a = Math.max(0, Math.min(1, alpha))

  const hex6 = value.match(/^#([0-9a-f]{6})$/i)
  if (hex6) {
    const n = Number.parseInt(hex6[1], 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
  }

  const hex3 = value.match(/^#([0-9a-f]{3})$/i)
  if (hex3) {
    const [r, g, b] = hex3[1].split('').map(ch => Number.parseInt(ch + ch, 16))
    return `rgba(${r}, ${g}, ${b}, ${a})`
  }

  const rgb = value.match(/^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i)
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${a})`

  return `rgba(160, 160, 168, ${a})`
}

// Fallbacks are only reached before ThemeProvider has applied its variables —
// they mirror the flat palette so a pre-mount frame is not jarring.
const FALLBACKS = {
  '--theme-bg-inset': '#0b0b0b',
  '--theme-bg-secondary': '#131313',
  '--theme-accent': '#00b896',
  '--theme-text': '#e8e8e8',
  '--theme-text-muted': '#9a9a9a',
  '--theme-text-subtle': '#6a6a6a',
  '--theme-border-subtle': '#242424',
  '--theme-border-strong': '#353535',
}

/**
 * Resolves a mixer panel canvas's palette from `canvas`'s computed style.
 * Call once per frame — getComputedStyle is cheap relative to the draw.
 */
export function readMixerCanvasTheme(canvas) {
  const cs = canvas && typeof getComputedStyle === 'function' ? getComputedStyle(canvas) : null
  const get = (key) => {
    const v = cs?.getPropertyValue(key)?.trim()
    return v || FALLBACKS[key]
  }
  return {
    well: get('--theme-bg-inset'),
    surface: get('--theme-bg-secondary'),
    accent: get('--theme-accent'),
    text: get('--theme-text'),
    textMuted: get('--theme-text-muted'),
    textSubtle: get('--theme-text-subtle'),
    border: get('--theme-border-subtle'),
    borderStrong: get('--theme-border-strong'),
  }
}

/** Shared canvas typeface for every mixer-panel canvas. */
export const MONO = '600 9px ui-monospace, "Cascadia Mono", Consolas, monospace'
export const MONO_SM = '600 8px ui-monospace, "Cascadia Mono", Consolas, monospace'

/**
 * DPR-aware backing-store sync. Returns { cssW, cssH } in CSS pixels, or null
 * when the element has no layout box yet.
 */
export function syncCanvasSize(canvas, fallbackW, fallbackH) {
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const rect = canvas.getBoundingClientRect()
  const cssW = rect.width > 0 ? rect.width : fallbackW
  const cssH = rect.height > 0 ? rect.height : fallbackH
  const tw = Math.round(cssW * dpr)
  const th = Math.round(cssH * dpr)
  if (canvas.width !== tw || canvas.height !== th) {
    canvas.width = tw
    canvas.height = th
  }
  return { cssW, cssH, dpr }
}
