// motionViewPersistence: load on start and on project load, debounced push,
// never mid-drag, null for an all-default state (R16, R19).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PUSH_DEBOUNCE_MS, startMotionViewPersistence } from './motionViewPersistence.js'
import { useMotionViewStore } from './motionViewStore.js'

const S = () => useMotionViewStore.getState()
const flushPromises = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

let project
let loadedListeners
let session
const SAVED = {
  v: 1, view: 'motion', graph: true,
  edit: { trackHeight: 48, scrollY: 10 },
  motion: { trackRowHeight: 32, scrollY: 5, headerWidth: 400, expanded: ['t:1', 't:1/roam'] },
}

function start(opts = {}) {
  session = startMotionViewPersistence({
    project: () => project,
    onProjectLoaded: (cb) => { loadedListeners.push(cb); return () => { loadedListeners = loadedListeners.filter((f) => f !== cb) } },
    ...opts,
  })
  return session
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  S().reset({ all: true })
  loadedListeners = []
  project = {
    getMotionViewState: vi.fn(async () => JSON.parse(JSON.stringify(SAVED))),
    setMotionViewState: vi.fn(async () => true),
  }
})

afterEach(() => {
  session?.stop()
  session = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('load', () => {
  it('loads the project state on start and does not push it back', async () => {
    start()
    await flushPromises()
    expect(project.getMotionViewState).toHaveBeenCalledTimes(1)
    expect(S().toState()).toEqual(SAVED)
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS * 2)
    expect(project.setMotionViewState).not.toHaveBeenCalled()
  })

  it('an engine without the call, a failed ask or null loads the defaults', async () => {
    S().setView('motion')
    project = {}
    start()
    await flushPromises()
    expect(S().view).toBe('edit')
    session.stop()
    project = { getMotionViewState: vi.fn(async () => { throw new Error('nope') }), setMotionViewState: vi.fn() }
    S().setGraph(true)
    start()
    await flushPromises()
    expect(S().graph).toBe(false)
    expect(console.warn).toHaveBeenCalled()
  })

  it('reloads on every project load; a pending change of the old project is dropped', async () => {
    start()
    await flushPromises()
    S().setHeaderWidth(500)                                 // pending push for the OLD project
    const next = { ...SAVED, view: 'edit', motion: { ...SAVED.motion, headerWidth: 300 } }
    project.getMotionViewState.mockResolvedValueOnce(next)
    loadedListeners.forEach((cb) => cb())
    await flushPromises()
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS * 2)
    expect(project.setMotionViewState).not.toHaveBeenCalled()
    expect(S().toState()).toEqual(next)
  })
})

describe('push', () => {
  it('debounces: several changes, one push of the latest state', async () => {
    start()
    await flushPromises()
    S().setMotionScrollY(10)
    S().setMotionScrollY(20)
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS - 10)
    S().setMotionScrollY(30)
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS - 10)
    expect(project.setMotionViewState).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20)
    expect(project.setMotionViewState).toHaveBeenCalledTimes(1)
    expect(project.setMotionViewState.mock.calls[0][0].motion.scrollY).toBe(30)
  })

  it('session-only changes (selection, focus) push nothing', async () => {
    start()
    await flushPromises()
    S().selectKeys([['a', {}]])
    S().selectRow('t:1')
    S().setSelectedMask({ trackId: 1, maskId: 1 })
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS * 3)
    expect(project.setMotionViewState).not.toHaveBeenCalled()
  })

  it('never during a drag: waits for the draft to clear', async () => {
    start()
    await flushPromises()
    S().setDraft({ trackId: 1, keys: [] })
    S().setGraph(false)
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS * 4)
    expect(project.setMotionViewState).not.toHaveBeenCalled()
    S().clearDraft()
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 10)
    expect(project.setMotionViewState).toHaveBeenCalledTimes(1)
    expect(project.setMotionViewState.mock.calls[0][0].graph).toBe(false)
  })

  it('an all-default state is pushed as null (nothing saved: old projects stay byte-identical)', async () => {
    start()
    await flushPromises()
    S().loadState(null)            // the user put everything back
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 10)
    expect(project.setMotionViewState).toHaveBeenCalledWith(null)
  })

  it('a project that only scrolled the Edit view pushes null (R16: old projects stay byte-identical)', async () => {
    project.getMotionViewState = vi.fn(async () => null)
    start()
    await flushPromises()
    S().setEditScrollY(640)
    S().setEditTrackHeight(60)
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 10)
    expect(project.setMotionViewState).toHaveBeenCalledTimes(1)
    expect(project.setMotionViewState).toHaveBeenCalledWith(null)
  })

  it('flush() pushes at once (before a save); stop() unsubscribes', async () => {
    start()
    await flushPromises()
    S().setHeaderWidth(520)
    expect(await session.flush()).toBe(true)
    expect(project.setMotionViewState).toHaveBeenCalledTimes(1)
    expect(await session.flush()).toBe(false)            // nothing new
    session.stop()
    S().setHeaderWidth(600)
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS * 2)
    expect(project.setMotionViewState).toHaveBeenCalledTimes(1)
    expect(loadedListeners).toHaveLength(0)
  })

  it('beforeProjectSwitch: the pending change lands in the OLD project, then nothing until the next load', async () => {
    start()
    await flushPromises()
    S().setHeaderWidth(520)                                   // pending, inside the debounce
    expect(await session.beforeProjectSwitch()).toBe(true)
    expect(project.setMotionViewState).toHaveBeenCalledTimes(1)
    expect(project.setMotionViewState.mock.calls[0][0].motion.headerWidth).toBe(520)
    expect(session.isSwitching()).toBe(true)
    // The engine switches; the old view keeps changing (UI teardown): no push.
    S().setHeaderWidth(610)
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS * 3)
    expect(await session.flush()).toBe(false)
    expect(project.setMotionViewState).toHaveBeenCalledTimes(1)
    // The new project loads: its state replaces the store, pushes resume.
    const next = { ...SAVED, motion: { ...SAVED.motion, headerWidth: 300 } }
    project.getMotionViewState.mockResolvedValueOnce(next)
    loadedListeners.forEach((cb) => cb())
    await flushPromises()
    expect(session.isSwitching()).toBe(false)
    expect(S().toState()).toEqual(next)
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS * 2)
    expect(project.setMotionViewState).toHaveBeenCalledTimes(1)  // the load is not pushed back
    S().setHeaderWidth(330)
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 10)
    expect(project.setMotionViewState).toHaveBeenCalledTimes(2)
    expect(project.setMotionViewState.mock.calls[1][0].motion.headerWidth).toBe(330)
  })

  it('cancelProjectSwitch: a failed switch resumes pushes and reschedules a held change', async () => {
    start()
    await flushPromises()
    await session.beforeProjectSwitch()                       // nothing pending: no push
    expect(project.setMotionViewState).not.toHaveBeenCalled()
    S().setHeaderWidth(480)                                   // held while switching
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS * 2)
    expect(project.setMotionViewState).not.toHaveBeenCalled()
    session.cancelProjectSwitch()
    expect(session.isSwitching()).toBe(false)
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 10)
    expect(project.setMotionViewState).toHaveBeenCalledTimes(1)
    expect(project.setMotionViewState.mock.calls[0][0].motion.headerWidth).toBe(480)
  })

  it('a failed push is logged and retried with the next change', async () => {
    start()
    await flushPromises()
    project.setMotionViewState.mockRejectedValueOnce(new Error('engine busy'))
    S().setHeaderWidth(520)
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 10)
    expect(console.error).toHaveBeenCalled()
    expect(await session.flush()).toBe(true)
    expect(project.setMotionViewState).toHaveBeenCalledTimes(2)
  })
})
