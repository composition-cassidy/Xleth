import { describe, it, expect } from 'vitest'
import { createUndoGrouper } from './undoGroup.js'

// Records the order calls reach the "engine". beginGroup answers a tick later,
// like a real round trip.
function fakeEngine() {
  const log = []
  let next = 1
  return {
    log,
    beginGroup: (label) => { const token = next++; log.push(`begin ${label} #${token}`); return new Promise((r) => setTimeout(() => r(token), 0)) },
    endGroup: (token) => { log.push(`end #${token}`); return Promise.resolve(true) },
    call: (name) => { log.push(name); return Promise.resolve(name) },
  }
}

describe('createUndoGrouper', () => {
  it('brackets the gesture: begin, the calls, end', async () => {
    const engine = fakeEngine()
    const withUndoGroup = createUndoGrouper(engine)
    const result = await withUndoGroup('Pitch shift', async () => {
      await Promise.all([engine.call('a'), engine.call('b')])
      return 'done'
    })
    expect(result).toBe('done')
    expect(engine.log).toEqual(['begin Pitch shift #1', 'a', 'b', 'end #1'])
  })

  it('starts the gesture synchronously, without waiting for beginGroup to answer', () => {
    const engine = fakeEngine()
    const withUndoGroup = createUndoGrouper(engine)
    let started = false
    withUndoGroup('Drop', async () => { started = true })
    expect(started).toBe(true)
    // ...and beginGroup was still sent first.
    expect(engine.log[0]).toBe('begin Drop #1')
  })

  it('closes the group when the gesture throws, and rethrows', async () => {
    const engine = fakeEngine()
    const withUndoGroup = createUndoGrouper(engine)
    await expect(withUndoGroup('Move', async () => {
      await engine.call('a')
      throw new Error('engine said no')
    })).rejects.toThrow('engine said no')
    expect(engine.log).toEqual(['begin Move #1', 'a', 'end #1'])
  })

  it('a nested gesture joins the open group instead of opening its own', async () => {
    const engine = fakeEngine()
    const withUndoGroup = createUndoGrouper(engine)
    await withUndoGroup('Cut', async () => {
      await engine.call('copy')
      await withUndoGroup('Delete selection', async () => { await engine.call('remove') })
      await engine.call('after')
    })
    expect(engine.log).toEqual(['begin Cut #1', 'copy', 'remove', 'after', 'end #1'])
  })

  it('overlapping gestures share one group, closed when the last one finishes', async () => {
    const engine = fakeEngine()
    const withUndoGroup = createUndoGrouper(engine)
    let releaseA
    const a = withUndoGroup('A', () => new Promise((r) => { releaseA = r }))
    const b = withUndoGroup('B', async () => { await engine.call('b') })
    await b
    expect(engine.log).toEqual(['begin A #1', 'b'])     // B did not close A's group
    releaseA()
    await a
    expect(engine.log).toEqual(['begin A #1', 'b', 'end #1'])
  })

  it('opens a fresh group for the next gesture', async () => {
    const engine = fakeEngine()
    const withUndoGroup = createUndoGrouper(engine)
    await withUndoGroup('One', () => engine.call('a'))
    await withUndoGroup('Two', () => engine.call('b'))
    expect(engine.log).toEqual(['begin One #1', 'a', 'end #1', 'begin Two #2', 'b', 'end #2'])
  })

  it('runs the gesture ungrouped when the engine has no group support', async () => {
    const calls = []
    for (const deps of [
      {},
      { beginGroup: () => null, endGroup: () => calls.push('end') },
      { beginGroup: () => { throw new Error('no such method') }, endGroup: () => calls.push('end') },
      { beginGroup: () => Promise.reject(new Error('rejected')), endGroup: () => calls.push('end') },
    ]) {
      const withUndoGroup = createUndoGrouper(deps)
      expect(await withUndoGroup('Edit', async () => 42)).toBe(42)
    }
    expect(calls).toEqual([])   // no token, so nothing to close
  })

  it('a failing endGroup does not fail the gesture', async () => {
    const withUndoGroup = createUndoGrouper({
      beginGroup: () => 7,
      endGroup: () => Promise.reject(new Error('already closed')),
    })
    expect(await withUndoGroup('Edit', async () => 'ok')).toBe('ok')
  })
})
