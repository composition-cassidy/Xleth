// A requestAnimationFrame loop that runs only while its canvas is on screen.
//
// A chain of ten devices has most of them scrolled out of view; the param-driven
// displays (Chorus orbit, Phaser sweep) animate continuously, so a hidden one
// would repaint 60 times a second for nothing. This pauses the loop while the
// canvas is outside the viewport or its scroll container and resumes it on
// return. It changes no data path: `frame(now)` is called exactly as before.
//
// Without IntersectionObserver (jsdom) the canvas counts as visible.
//
// Returns the stop function for the effect cleanup.
export function startVisibleLoop(canvas, frame) {
  let raf = 0
  let visible = true
  let stopped = false

  const tick = (now) => {
    raf = 0
    if (stopped || !visible) return
    frame(now)
    if (!stopped && visible && !raf) raf = requestAnimationFrame(tick)
  }
  const kick = () => {
    if (!raf && !stopped && visible) raf = requestAnimationFrame(tick)
  }

  let io = null
  if (canvas && typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1].isIntersecting
      if (visible) kick()
    })
    io.observe(canvas)
  }
  kick()

  return () => {
    stopped = true
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    if (io) io.disconnect()
  }
}
