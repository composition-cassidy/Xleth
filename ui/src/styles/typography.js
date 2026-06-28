const UI_FONT_VARIABLE = '--xleth-global-font-family'
const FALLBACK_UI_FONT_FAMILY = '"Neuzeit Grotesk", "Inter", "Noto Sans", "Segoe UI", system-ui, sans-serif'

let cachedUiFontFamily = null

export function getUiFontFamily() {
  if (cachedUiFontFamily) return cachedUiFontFamily
  if (typeof document === 'undefined') return FALLBACK_UI_FONT_FAMILY

  cachedUiFontFamily = getComputedStyle(document.documentElement)
    .getPropertyValue(UI_FONT_VARIABLE)
    .trim() || FALLBACK_UI_FONT_FAMILY

  return cachedUiFontFamily
}

export function uiCanvasFont(fontSpec) {
  return `${fontSpec} ${getUiFontFamily()}`
}
