import { beforeEach, describe, expect, it } from 'vitest'
import useNoteSelectionStore from './useNoteSelectionStore.js'

const get = () => useNoteSelectionStore.getState()
const sel = () => Object.fromEntries(Object.entries(get().byPattern).map(([k, v]) => [k, [...v].sort((a, b) => a - b)]))

describe('useNoteSelectionStore', () => {
  beforeEach(() => get().clear())

  it('selectOnly replaces everything, including other patterns', () => {
    get().selectOnly(1, 10)
    get().selectOnly(2, 20)
    expect(sel()).toEqual({ 2: [20] })
  })

  it('toggle adds and removes, across patterns', () => {
    get().selectOnly(1, 10)
    get().toggle(1, 11)
    get().toggle(2, 5)
    expect(sel()).toEqual({ 1: [10, 11], 2: [5] })
    get().toggle(1, 10)
    get().toggle(2, 5)
    expect(sel()).toEqual({ 1: [11] })
    get().toggle(1, 11)
    expect(sel()).toEqual({})
  })

  it('the roll publishing a selection replaces the whole selection', () => {
    get().selectOnly(2, 20)
    get().setPatternSelection(1, new Set([3, 4]))
    expect(sel()).toEqual({ 1: [3, 4] })
  })

  it('echoing what the store holds for the pattern keeps the other patterns (no mirror loop damage)', () => {
    get().selectOnly(1, 1)
    get().toggle(2, 9)
    const before = get().byPattern
    get().setPatternSelection(1, new Set([1]))
    expect(get().byPattern).toBe(before)
    expect(sel()).toEqual({ 1: [1], 2: [9] })
  })

  it('an empty selection from the roll only clears its own pattern', () => {
    get().selectOnly(2, 20)
    get().setPatternSelection(1, new Set())
    expect(sel()).toEqual({ 2: [20] })
    get().setPatternSelection(2, new Set())
    expect(sel()).toEqual({})
  })

  it('identical writes do not notify', () => {
    get().selectOnly(1, 1)
    let notified = 0
    const off = useNoteSelectionStore.subscribe(() => { notified++ })
    get().selectOnly(1, 1)
    get().clear()
    get().clear()
    off()
    expect(notified).toBe(1) // only the real clear
  })
})
