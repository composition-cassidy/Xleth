import { describe, expect, it, vi } from 'vitest'
import { createCoalescedRedraw } from './coalescedRedraw.js'

// A manual scheduler: tasks run when the test says so.
function manualSchedule() {
  const tasks = []
  const schedule = (fn) => tasks.push(fn)
  schedule.flush = () => { while (tasks.length) tasks.shift()() }
  schedule.count = () => tasks.length
  return schedule
}

describe('createCoalescedRedraw', () => {
  it('paints once for a burst of requests, with the first reason', () => {
    const paint = vi.fn()
    const schedule = manualSchedule()
    const redraw = createCoalescedRedraw(paint, schedule)
    redraw.request('clips')
    redraw.request('selection')
    redraw.request('pattern-blocks')
    expect(paint).not.toHaveBeenCalled()
    expect(schedule.count()).toBe(1)
    schedule.flush()
    expect(paint).toHaveBeenCalledTimes(1)
    expect(paint).toHaveBeenCalledWith('clips')
  })

  it('paints again for a request made after the flush', () => {
    const paint = vi.fn()
    const schedule = manualSchedule()
    const redraw = createCoalescedRedraw(paint, schedule)
    redraw.request('a')
    schedule.flush()
    redraw.request('b')
    schedule.flush()
    expect(paint.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
  })

  it('does not repaint what a direct paint already covered', () => {
    const paint = vi.fn()
    const schedule = manualSchedule()
    const redraw = createCoalescedRedraw(paint, schedule)
    redraw.request('clips')
    expect(redraw.pending).toBe(true)
    redraw.settle() // e.g. a zoom frame painted the layer synchronously
    expect(redraw.pending).toBe(false)
    schedule.flush()
    expect(paint).not.toHaveBeenCalled()
  })

  it('accepts a request made from inside the paint', () => {
    const schedule = manualSchedule()
    let redraw
    const paint = vi.fn((reason) => { if (reason === 'first') redraw.request('again') })
    redraw = createCoalescedRedraw(paint, schedule)
    redraw.request('first')
    schedule.flush()
    expect(paint.mock.calls.map((c) => c[0])).toEqual(['first', 'again'])
  })

  it('uses a microtask by default: the paint lands before the next task', async () => {
    const paint = vi.fn()
    const redraw = createCoalescedRedraw(paint)
    redraw.request('x')
    redraw.request('y')
    expect(paint).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(paint).toHaveBeenCalledTimes(1)
  })
})
