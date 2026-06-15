import { describe, expect, it, vi } from 'vitest'
import { createStoppedPreviewSeekScheduler } from './stoppedPreviewSeekScheduler.js'

function makeManualFrame() {
  const callbacks = []
  return {
    callbacks,
    requestFrame: (cb) => {
      callbacks.push(cb)
      return { type: 'manual', id: callbacks.length - 1 }
    },
    cancelFrame: (handle) => {
      callbacks[handle.id] = null
    },
    runNext: () => {
      const cb = callbacks.shift()
      if (cb) cb()
    },
  }
}

describe('stopped preview seek scheduler', () => {
  it('schedules a stopped click preview request', () => {
    const frame = makeManualFrame()
    const requestPreviewFrame = vi.fn().mockResolvedValue({ ok: true })
    const scheduler = createStoppedPreviewSeekScheduler({
      requestPreviewFrame,
      isPlaying: () => false,
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
    })

    scheduler.schedule({ beat: 4 })
    frame.runNext()

    expect(requestPreviewFrame).toHaveBeenCalledTimes(1)
    expect(requestPreviewFrame).toHaveBeenCalledWith({ beat: 4 }, { generation: 1 })
  })

  it('coalesces rapid stopped drag requests to the latest position', () => {
    const frame = makeManualFrame()
    const requestPreviewFrame = vi.fn().mockResolvedValue({ ok: true })
    const scheduler = createStoppedPreviewSeekScheduler({
      requestPreviewFrame,
      isPlaying: () => false,
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
    })

    scheduler.schedule({ beat: 1 })
    scheduler.schedule({ beat: 2 })
    scheduler.schedule({ beat: 3 })
    frame.runNext()

    expect(requestPreviewFrame).toHaveBeenCalledTimes(1)
    expect(requestPreviewFrame).toHaveBeenCalledWith({ beat: 3 }, { generation: 3 })
  })

  it('does not call the stopped-preview endpoint while playing', () => {
    const frame = makeManualFrame()
    const requestPreviewFrame = vi.fn()
    const scheduler = createStoppedPreviewSeekScheduler({
      requestPreviewFrame,
      isPlaying: () => true,
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
    })

    const result = scheduler.schedule({ beat: 8 })
    frame.runNext()

    expect(result.scheduled).toBe(false)
    expect(requestPreviewFrame).not.toHaveBeenCalled()
  })

  it('does not let stale promise completion become the settled latest request', async () => {
    const frame = makeManualFrame()
    let resolveFirst
    let resolveSecond
    const requestPreviewFrame = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const scheduler = createStoppedPreviewSeekScheduler({
      requestPreviewFrame,
      isPlaying: () => false,
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
    })

    scheduler.schedule({ beat: 1 })
    frame.runNext()
    scheduler.schedule({ beat: 2 })
    frame.runNext()

    resolveFirst({ ok: true })
    await Promise.resolve()
    expect(scheduler.getDebugState().lastSettledGeneration).toBe(0)

    resolveSecond({ ok: true })
    await Promise.resolve()
    expect(scheduler.getDebugState().lastSettledGeneration).toBe(2)
  })
})
