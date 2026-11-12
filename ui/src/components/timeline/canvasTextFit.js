// Truncate-with-ellipsis for canvas labels, with a cache.
//
// Fitting a label is a binary search over ctx.measureText(), which is one of
// the slower canvas calls. The timeline does it for every named block on every
// frame, and during a pan nothing about the answer changes (same text, same
// font, same available width), so the result is cached per (font, text, width).
//
// The cache is cleared when a web font finishes loading, because that changes
// glyph metrics without changing the font string.

const ELLIPSIS = '…'
const MAX_ENTRIES = 4000

const _fitCache = new Map()   // `${font}\n${bare}\n${maxWidth}\n${text}` -> fitted string
const _widthCache = new Map() // `${font}\n${text}` -> full width

export function clearCanvasTextFitCache() {
  _fitCache.clear()
  _widthCache.clear()
}

if (typeof document !== 'undefined' && document.fonts?.addEventListener) {
  document.fonts.addEventListener('loadingdone', clearCanvasTextFitCache)
}

/** Cached `ctx.measureText(text).width`. Same `font` contract as fitCanvasText. */
export function measureCanvasTextWidth(ctx, font, text) {
  const key = font + '\n' + text
  let width = _widthCache.get(key)
  if (width === undefined) {
    if (_widthCache.size >= MAX_ENTRIES) _widthCache.clear()
    width = ctx.measureText(text).width
    _widthCache.set(key, width)
  }
  return width
}

/**
 * The longest prefix of `text` that fits `maxWidth` with an ellipsis appended,
 * or the whole text if it fits. Returns '' when nothing fits; with
 * `allowBareEllipsis` a lone ellipsis is returned instead when it alone fits.
 *
 * `ctx.font` must already be set; pass that same string as `font` (it is the
 * cache key, the context is never read for it).
 */
export function fitCanvasText(ctx, font, text, maxWidth, allowBareEllipsis = false) {
  if (!text || maxWidth <= 0) return ''
  const full = String(text)
  if (measureCanvasTextWidth(ctx, font, full) <= maxWidth) return full

  const fitKey = font + '\n' + (allowBareEllipsis ? 1 : 0) + '\n' + maxWidth + '\n' + full
  const cached = _fitCache.get(fitKey)
  if (cached !== undefined) return cached

  let fitted = ''
  if (ctx.measureText(ELLIPSIS).width <= maxWidth) {
    let lo = 0, hi = full.length, best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (ctx.measureText(full.slice(0, mid) + ELLIPSIS).width <= maxWidth) { best = mid; lo = mid + 1 }
      else hi = mid - 1
    }
    if (best > 0) fitted = full.slice(0, best) + ELLIPSIS
    else if (allowBareEllipsis) fitted = ELLIPSIS
  }

  if (_fitCache.size >= MAX_ENTRIES) _fitCache.clear()
  _fitCache.set(fitKey, fitted)
  return fitted
}
