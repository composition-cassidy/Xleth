// @vitest-environment jsdom
// The app's ONE shared undo grouper (withSharedUndoGroup): built lazily on
// window.xleth.undo so the Edit view and Motion view never open competing groups.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetSharedUndoGrouper, sharedUndoGrouper, withSharedUndoGroup } from './undoGroup.js'

let log

function installUndo() {
  let next = 1
  window.xleth = {
    undo: {
      beginGroup: (label) => { const t = next++; log.push(`begin ${label} #${t}`); return new Promise((r) => setTimeout(() => r(t), 0)) },
      endGroup: (t) => { log.push(`end #${t}`); return Promise.resolve(true) },
    },
  }
}

beforeEach(() => {
  log = []
  resetSharedUndoGrouper()
  installUndo()
})

afterEach(() => {
  delete window.xleth
})

describe('withSharedUndoGroup', () => {
  it('is one grouper for every caller, created on first use', () => {
    const a = sharedUndoGrouper()
    expect(sharedUndoGrouper()).toBe(a)
    resetSharedUndoGrouper()
    expect(sharedUndoGrouper()).not.toBe(a)
  })

  it('brackets a gesture with begin / end over window.xleth.undo', async () => {
    const out = await withSharedUndoGroup('Move keys', async () => { log.push('write'); return 7 })
    expect(out).toBe(7)
    expect(log).toEqual(['begin Move keys #1', 'write', 'end #1'])
  })

  it('a gesture from another view started while one is open joins it', async () => {
    let release
    const edit = withSharedUndoGroup('Edit view drag', () => new Promise((r) => { release = r }))
    const motion = withSharedUndoGroup('Motion view plan', async () => { log.push('motion write') })
    await motion
    expect(log).toEqual(['begin Edit view drag #1', 'motion write'])
    release()
    await edit
    expect(log).toEqual(['begin Edit view drag #1', 'motion write', 'end #1'])
  })

  it('reads window.xleth at call time, and runs ungrouped without an undo API', async () => {
    delete window.xleth
    expect(await withSharedUndoGroup('Edit', async () => 'ok')).toBe('ok')
    installUndo()
    await withSharedUndoGroup('Later', async () => {})
    expect(log).toEqual(['begin Later #1', 'end #1'])
  })
})
