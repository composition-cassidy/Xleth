// A plain mouse wheel over a sideways scrollbar scrolls it sideways.
//
// Browsers only move a horizontal-only scroller for shift+wheel or a trackpad
// swipe, so on a mouse the wheel either did nothing or scrolled the page. This
// installs one document-level listener that turns a vertical wheel tick into
// scrollLeft for the nearest scroller that can move sideways, unless a
// vertical scroller nearer to the pointer should take the wheel instead.
//
// Elements that already handle their own wheel (custom scrollbars, canvases)
// call preventDefault first, so the defaultPrevented check below leaves them
// alone. React's synthetic onWheel is a PASSIVE listener, so a preventDefault
// there is a no-op and defaultPrevented stays false. Controls that turn the
// wheel into a value change (knobs, the EQ / Resonance curve editors) are
// therefore recognised by WHEEL_OWNER_SELECTOR and left alone too, so editing
// a parameter never also scrolls the device chain.

const LINE_PX = 16
// Mark any wheel-driven control that is not one of these with data-wheel-owner.
export const WHEEL_OWNER_SELECTOR =
  'canvas, input, select, textarea, [role="slider"], [role="spinbutton"], [data-wheel-owner]'

const SLACK_PX = 1

function axisOverflowing(el, axis) {
  if (axis === 'x') {
    if (el.scrollWidth <= el.clientWidth + SLACK_PX) return false
  } else if (el.scrollHeight <= el.clientHeight + SLACK_PX) {
    return false
  }
  const style = getComputedStyle(el)
  const overflow = axis === 'x' ? style.overflowX : style.overflowY
  return overflow === 'auto' || overflow === 'scroll'
}

function canMove(el, axis, delta) {
  if (!axisOverflowing(el, axis)) return false
  if (axis === 'x') {
    const max = el.scrollWidth - el.clientWidth
    return delta < 0 ? el.scrollLeft > 0 : el.scrollLeft < max - SLACK_PX
  }
  const max = el.scrollHeight - el.clientHeight
  return delta < 0 ? el.scrollTop > 0 : el.scrollTop < max - SLACK_PX
}

// True when the pointer sits on el's horizontal scrollbar strip, which lies
// below the padding box (between clientHeight and offsetHeight).
function pointerOnHorizontalBar(el, e) {
  const rect = el.getBoundingClientRect()
  const barTop = rect.top + el.clientTop + el.clientHeight
  return e.clientY >= barTop && e.clientY <= rect.bottom
}

function normaliseDelta(e, el) {
  if (e.deltaMode === 1) return e.deltaY * LINE_PX
  if (e.deltaMode === 2) return e.deltaY * el.clientWidth
  return e.deltaY
}

// Returns the element that should scroll sideways for this wheel event, or
// null when the wheel should keep its native behaviour.
export function findSidewaysWheelTarget(e, start) {
  if (!e || e.ctrlKey || e.deltaX !== 0 || e.deltaY === 0) return null
  let node = start
  while (node && node !== document.documentElement && node.nodeType === 1) {
    const deltaY = e.deltaY
    const verticalMove = canMove(node, 'y', deltaY)
    const sidewaysMove = canMove(node, 'x', normaliseDelta(e, node))
    if (sidewaysMove && (pointerOnHorizontalBar(node, e) || !verticalMove)) {
      return node
    }
    if (verticalMove) return null
    node = node.parentElement
  }
  return null
}

// Installs the listener on the window. Returns a function that removes it.
export function installWheelToHorizontalScroll(target = window) {
  const onWheel = (e) => {
    if (e.defaultPrevented) return
    const start = e.target
    if (!start || start.nodeType !== 1) return
    if (start.closest(WHEEL_OWNER_SELECTOR)) return
    const el = findSidewaysWheelTarget(e, start)
    if (!el) return
    el.scrollLeft += normaliseDelta(e, el)
    e.preventDefault()
  }
  target.addEventListener('wheel', onWheel, { passive: false })
  return () => target.removeEventListener('wheel', onWheel)
}
