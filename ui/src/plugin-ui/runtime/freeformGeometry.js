// Pure geometry helpers for freeform layer rendering.
// All values are numeric; no user strings enter CSS properties.

/**
 * Converts a validated NodeFrame into a React inline-style object for the
 * absolutely-positioned wrapper div that FreeformLayerNode renders around each child.
 *
 * @param {object} frame - A validated NodeFrame (all fields must be numbers).
 * @returns {object} React inline-style object.
 */
export function applyFrameStyle(frame) {
  if (!frame || typeof frame !== 'object') {
    return { position: 'absolute' }
  }

  const x          = typeof frame.x         === 'number' ? frame.x         : 0
  const y          = typeof frame.y         === 'number' ? frame.y         : 0
  const widthPx    = typeof frame.widthPx   === 'number' ? frame.widthPx   : 0
  const heightPx   = typeof frame.heightPx  === 'number' ? frame.heightPx  : 0
  const rotationDeg = typeof frame.rotationDeg === 'number' ? frame.rotationDeg : 0
  const zIndex     = typeof frame.zIndex    === 'number' ? frame.zIndex    : 0

  const style = {
    position: 'absolute',
    left:     `${x}px`,
    top:      `${y}px`,
    width:    `${widthPx}px`,
    height:   `${heightPx}px`,
    zIndex,
  }

  if (rotationDeg !== 0) {
    style.transform       = `rotate(${rotationDeg}deg)`
    style.transformOrigin = '50% 50%'
  }

  return style
}
