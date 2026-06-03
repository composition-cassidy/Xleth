import { MIN_VIEWPORT_ZOOM, MAX_VIEWPORT_ZOOM } from './graphState.js';

export { MIN_VIEWPORT_ZOOM, MAX_VIEWPORT_ZOOM };

// Clamp a zoom value to the valid graph viewport range.
// NaN returns the default zoom 1; all other values (including Infinity/-Infinity) are clamped.
export function clampGraphZoom(zoom) {
  if (Number.isNaN(zoom)) return 1;
  return Math.min(MAX_VIEWPORT_ZOOM, Math.max(MIN_VIEWPORT_ZOOM, zoom));
}

// Convert a client-space point to canvas-space using viewport + stage bounds.
// stageRect: the bounding rect of the stage container (viewportRef.getBoundingClientRect()).
// Returns the canvas-space point { x, y } (same coordinate system as node positions in the layout).
export function screenToGraphPoint(clientPoint, viewport, stageRect) {
  const sx = clientPoint.x - stageRect.left;
  const sy = clientPoint.y - stageRect.top;
  return {
    x: (sx - viewport.x) / viewport.zoom,
    y: (sy - viewport.y) / viewport.zoom,
  };
}

// Convert a canvas-space point to client-space (exact inverse of screenToGraphPoint).
export function graphToScreenPoint(graphPoint, viewport, stageRect) {
  return {
    x: graphPoint.x * viewport.zoom + viewport.x + stageRect.left,
    y: graphPoint.y * viewport.zoom + viewport.y + stageRect.top,
  };
}

// Return a new viewport where the canvas-space point under clientPoint remains
// fixed after the zoom changes to nextZoom.
export function zoomViewportAroundScreenPoint(viewport, clientPoint, nextZoom, stageRect) {
  const clampedZoom = clampGraphZoom(nextZoom);
  const sx = clientPoint.x - stageRect.left;
  const sy = clientPoint.y - stageRect.top;
  // Canvas-space point under cursor before the zoom change:
  const gx = (sx - viewport.x) / viewport.zoom;
  const gy = (sy - viewport.y) / viewport.zoom;
  // New viewport origin that keeps gx/gy under the cursor:
  return {
    x: sx - gx * clampedZoom,
    y: sy - gy * clampedZoom,
    zoom: clampedZoom,
  };
}

// Pan viewport by a screen-space delta. Zoom is preserved.
export function panViewport(viewport, deltaScreen) {
  return {
    x: viewport.x + deltaScreen.x,
    y: viewport.y + deltaScreen.y,
    zoom: viewport.zoom,
  };
}

// Compute a viewport that fits all nodes within containerSize with padding.
// nodes: array of { x, y, width, height } in canvas-space (layout positions).
// containerSize: { width, height } of the visible stage container.
// Returns { x, y, zoom } — node positions are never mutated.
export function fitGraphViewport(nodes, containerSize, options = {}) {
  const { padding = 48 } = options;

  if (!nodes || nodes.length === 0) {
    return { x: 0, y: 0, zoom: 1 };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes) {
    const x0 = Number.isFinite(node.x) ? node.x : 0;
    const y0 = Number.isFinite(node.y) ? node.y : 0;
    const w  = Number.isFinite(node.width)  ? node.width  : 0;
    const h  = Number.isFinite(node.height) ? node.height : 0;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x0 + w > maxX) maxX = x0 + w;
    if (y0 + h > maxY) maxY = y0 + h;
  }

  const nodesWidth  = maxX - minX;
  const nodesHeight = maxY - minY;
  const availW = containerSize.width  - 2 * padding;
  const availH = containerSize.height - 2 * padding;

  let zoom;
  if (nodesWidth <= 0 || nodesHeight <= 0 || availW <= 0 || availH <= 0) {
    zoom = 1;
  } else {
    zoom = clampGraphZoom(Math.min(availW / nodesWidth, availH / nodesHeight));
  }

  // Center the node bounds within the container.
  // screen_x = canvas_x * zoom + vx  →  vx = (cW - nodesWidth*zoom)/2 - minX*zoom
  const x = (containerSize.width  - nodesWidth  * zoom) / 2 - minX * zoom;
  const y = (containerSize.height - nodesHeight * zoom) / 2 - minY * zoom;

  return { x, y, zoom };
}
