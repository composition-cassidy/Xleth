// Peak tiles for the sample editor's waveform.
//
// The engine hands back stride-3 [min, max, rms] columns for any time range at
// any column count (waveform.getFilePeaks, served from the file's mipmap). The
// old scrubber kept exactly one zoomed tile and threw it away the moment the
// view moved, so every wheel notch fell back to the whole-file peaks (1400
// columns for the entire source: four columns across a half-second view) until
// the next fetch landed. Here the tiles are kept:
//
//   - a tile covers a PADDED window around the view it was fetched for, so
//     panning inside the padding needs no fetch at all;
//   - a small LRU of tiles is searched for the densest one that covers the
//     view, so zooming back out, or in again, draws at once from what is held;
//   - a fetch is only asked for when nothing held is dense enough.
//
// Pure: no DOM, no IPC. The component owns the fetch.

export const MAX_TILE_COLS = 8000   // per request (the engine's own cap is 16000)
export const TILE_CACHE_SIZE = 8
const SATISFIED = 0.8               // a tile at 80 % of the wanted density is good enough
const COVER_EPS = 1e-4

/** Wrap a getFilePeaks result. `requestedCols` lets a short answer be recognised. */
export function makeTile(peaks, start, end, requestedCols = 0) {
  const cols = Math.floor((peaks?.length || 0) / 3)
  const span = end - start
  if (cols <= 0 || !(span > 0)) return null
  return {
    peaks,
    cols,
    start,
    end,
    density: cols / span,
    // Fewer columns than asked for: the mipmap has nothing finer for this range.
    maxed: requestedCols > 0 && cols < requestedCols * 0.9,
  }
}

const covers = (tile, start, end) => tile.start <= start + COVER_EPS && tile.end >= end - COVER_EPS

/** The densest held tile that covers [start, end]; `base` (the whole file) always covers. */
export function pickTile(tiles, base, start, end) {
  let best = base || null
  for (const tile of tiles) {
    if (!covers(tile, start, end)) continue
    if (!best || tile.density > best.density) best = tile
  }
  return best
}

/**
 * What to fetch so [start, end] can be drawn at `pixelWidth` columns, or null
 * when what is held is already enough.
 */
export function tileRequest(best, start, end, duration, pixelWidth) {
  const span = end - start
  if (!(span > 0) || !(duration > 0) || !(pixelWidth > 0)) return null
  const wanted = pixelWidth / span
  if (best && (best.maxed || best.density >= wanted * SATISFIED)) return null
  const pad = span * 0.5
  const s = Math.max(0, start - pad)
  const e = Math.min(duration, end + pad)
  const cols = Math.max(16, Math.min(MAX_TILE_COLS, Math.ceil((e - s) * wanted)))
  return { start: s, end: e, cols }
}

/** Newest first, capped. A tile for the same window replaces the old one. */
export function rememberTile(tiles, tile, limit = TILE_CACHE_SIZE) {
  const rest = tiles.filter((t) => !(Math.abs(t.start - tile.start) < COVER_EPS && Math.abs(t.end - tile.end) < COVER_EPS))
  return [tile, ...rest].slice(0, limit)
}

/**
 * The column range of `tile` that spans [start, end], and the times its edges
 * sit at, so a caller can place the slice exactly (columns rarely land on the
 * view's edges).
 */
export function tileSlice(tile, start, end) {
  const colDur = (tile.end - tile.start) / tile.cols
  const c0 = Math.max(0, Math.min(tile.cols, Math.floor((start - tile.start) / colDur)))
  const c1 = Math.max(c0, Math.min(tile.cols, Math.ceil((end - tile.start) / colDur)))
  return { c0, c1, t0: tile.start + c0 * colDur, t1: tile.start + c1 * colDur }
}
