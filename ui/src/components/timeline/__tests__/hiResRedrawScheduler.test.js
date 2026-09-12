import { describe, it, expect, vi } from 'vitest'
import { createHiResRedrawScheduler } from '../hiResRedrawScheduler.js'

// Fake frame clock: request() queues, flush() runs one frame's callbacks.
function makeClock() {
  let next = 1
  const queued = new Map()
  return {
    raf: (fn) => { const id = next++; queued.set(id, fn); return id },
    caf: (id) => { queued.delete(id) },
    flush() {
      const fns = [...queued.values()]
      queued.clear()
      fns.forEach((fn) => fn())
    },
    pending: () => queued.size,
  }
}

describe('createHiResRedrawScheduler', () => {
  it('collapses many requests in one frame into a single redraw', () => {
    // The regression: 125 hi-res jobs resolved within a few ms of each other
    // and each called redrawContent() synchronously — 125 full canvas rebuilds
    // where 124 were immediately overwritten.
    const redraw = vi.fn()
    const clock = makeClock()
    const s = createHiResRedrawScheduler(redraw, clock)

    for (let i = 0; i < 125; i++) s.request()
    expect(redraw).not.toHaveBeenCalled()   // nothing runs synchronously
    expect(clock.pending()).toBe(1)         // exactly one frame scheduled

    clock.flush()
    expect(redraw).toHaveBeenCalledTimes(1)
  })

  it('a request in a later frame redraws again', () => {
    const redraw = vi.fn()
    const clock = makeClock()
    const s = createHiResRedrawScheduler(redraw, clock)

    s.request(); clock.flush()
    s.request(); clock.flush()
    expect(redraw).toHaveBeenCalledTimes(2)
  })

  it('a request made from inside the redraw schedules the next frame', () => {
    // The handle must be cleared BEFORE redraw() runs, or a job resolving in
    // the same microtask flush would be silently dropped as already-pending.
    const clock = makeClock()
    let reentered = false
    const s = createHiResRedrawScheduler(() => {
      if (!reentered) { reentered = true; s.request() }
    }, clock)

    s.request()
    clock.flush()
    expect(s.isPending()).toBe(true)
  })

  it('cancel() drops a pending redraw (unmount path)', () => {
    const redraw = vi.fn()
    const clock = makeClock()
    const s = createHiResRedrawScheduler(redraw, clock)

    s.request()
    expect(s.isPending()).toBe(true)
    s.cancel()
    expect(s.isPending()).toBe(false)
    clock.flush()
    expect(redraw).not.toHaveBeenCalled()
  })

  it('cancel() is safe with nothing pending, and re-arms afterwards', () => {
    const redraw = vi.fn()
    const clock = makeClock()
    const s = createHiResRedrawScheduler(redraw, clock)

    expect(() => s.cancel()).not.toThrow()
    s.request(); clock.flush()
    expect(redraw).toHaveBeenCalledTimes(1)
  })
})
