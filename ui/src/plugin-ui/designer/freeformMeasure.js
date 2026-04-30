// DOM measurement helpers for freeform node placement.
// All functions are pure side-effect-free reads from the DOM.
// Never imports the store or actions — consumers pass the previewRootEl.
//
// The previewRootEl is the `.pluginui-designer-preview-host` element that
// DesignerPreview exposes via a module-level setter in designerActions.js.

import { clampFrame } from './freeformGeometry.js'

// ── Single-node measurement ───────────────────────────────────────────────────

/**
 * Get the viewport-relative DOMRect for a node in the preview host.
 * Returns { ok: true, rect } or { ok: false, error }.
 */
export function getNodeRectInPreview(previewRootEl, nodeId) {
  if (!previewRootEl || !nodeId) {
    return { ok: false, error: `Missing previewRootEl or nodeId` }
  }
  const el = previewRootEl.querySelector(`[data-pluginui-id="${cssEscape(nodeId)}"]`)
  if (!el) {
    return { ok: false, error: `DOM node not found for id "${nodeId}"` }
  }
  return { ok: true, rect: el.getBoundingClientRect() }
}

/**
 * Get both the node rect and its target layer rect in one call.
 * Returns { ok: true, nodeRect, layerRect } or { ok: false, error }.
 */
export function getNodeRectRelativeToLayer(previewRootEl, nodeId, layerId) {
  const nodeResult = getNodeRectInPreview(previewRootEl, nodeId)
  if (!nodeResult.ok) return nodeResult

  const layerResult = getNodeRectInPreview(previewRootEl, layerId)
  if (!layerResult.ok) {
    return { ok: false, error: `Freeform layer DOM node not found for id "${layerId}"` }
  }

  return { ok: true, nodeRect: nodeResult.rect, layerRect: layerResult.rect }
}

// ── Frame builder ─────────────────────────────────────────────────────────────

/**
 * Convert two viewport DOMRects (node, layer) into a freeform frame object.
 * Coordinates are relative to the layer's top-left corner, rounded to integers.
 * Result is clamped through the designer geometry bounds.
 *
 * options:
 *   defaultWidth  — fallback widthPx when the measured width is 0 (default 80)
 *   defaultHeight — fallback heightPx when the measured height is 0 (default 24)
 */
export function buildFrameFromRects(nodeRect, layerRect, options = {}) {
  const { defaultWidth = 80, defaultHeight = 24 } = options
  const x       = Math.round(nodeRect.left - layerRect.left)
  const y       = Math.round(nodeRect.top  - layerRect.top)
  const widthPx = Math.round(nodeRect.width)  || defaultWidth
  const heightPx= Math.round(nodeRect.height) || defaultHeight
  return clampFrame({ x, y, widthPx, heightPx })
}

// ── Batch measurement ─────────────────────────────────────────────────────────

/**
 * Measure multiple children for placement into a freeform layer.
 *
 * Returns:
 *   { ok: boolean, frames: { [nodeId]: frame }, errors: string[] }
 *
 * `ok` is false if ANY child measurement failed; partial frames are still
 * returned in `frames` for the nodes that were found.
 */
export function measureChildrenForFreeform(previewRootEl, childIds, targetLayerId) {
  const layerResult = getNodeRectInPreview(previewRootEl, targetLayerId)
  if (!layerResult.ok) {
    return { ok: false, frames: {}, errors: [layerResult.error] }
  }

  const frames = {}
  const errors = []

  for (const nodeId of childIds) {
    const nodeResult = getNodeRectInPreview(previewRootEl, nodeId)
    if (!nodeResult.ok) {
      errors.push(nodeResult.error)
      continue
    }
    frames[nodeId] = buildFrameFromRects(nodeResult.rect, layerResult.rect)
  }

  return { ok: errors.length === 0, frames, errors }
}

// ── CSS.escape polyfill ───────────────────────────────────────────────────────

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`)
}
