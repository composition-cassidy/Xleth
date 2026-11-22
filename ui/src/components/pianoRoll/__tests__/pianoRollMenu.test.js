import { describe, expect, it, vi } from 'vitest'
import { buildPianoRollMenu, buildScaleMenu, comboOf, shortModeLabel } from '../pianoRollMenu.js'
import { PIANO_ROLL_KEYMAP } from '../PianoRoll.jsx'
import { DEFAULT_SCALE } from '../scales.js'

const find = (items, label) => items.find((i) => i.label === label)

function menu(over = {}) {
  const run = vi.fn()
  const items = buildPianoRollMenu({
    keymap: PIANO_ROLL_KEYMAP, run, hasPattern: true, selectionCount: 0, showGhosts: true,
    onShowGhostsChange: vi.fn(), onZoomIn: vi.fn(), onZoomOut: vi.fn(), onOpenQuickNotation: vi.fn(),
    ...over,
  })
  return { items, run }
}

describe('piano roll menu', () => {
  it('prints the combo the keyboard binding uses', () => {
    expect(comboOf(PIANO_ROLL_KEYMAP, 'cut')).toBe('Ctrl + X')
    expect(comboOf(PIANO_ROLL_KEYMAP, 'delete')).toBe('Del')
    expect(comboOf(PIANO_ROLL_KEYMAP, 'stepUp')).toBe('↑')
    expect(comboOf(PIANO_ROLL_KEYMAP, 'nope')).toBeUndefined()
  })

  it('runs the roll command with the row\'s id', () => {
    const { items, run } = menu({ selectionCount: 2 })
    find(find(items, 'Edit').submenu, 'Duplicate').onClick()
    find(find(items, 'Edit').submenu, 'Cut').onClick()
    expect(run.mock.calls).toEqual([['duplicate'], ['cut']])
  })

  it('greys out selection-only commands with nothing selected, not the ones that act on every note', () => {
    const edit = find(menu({ selectionCount: 0 }).items, 'Edit').submenu
    expect(find(edit, 'Cut').disabled).toBe(true)
    expect(find(edit, 'Transpose up').disabled).toBe(true)
    expect(find(edit, 'Duplicate').disabled).toBe(false)
    expect(find(edit, 'Discard lengths').disabled).toBe(false)
    const picked = find(menu({ selectionCount: 3 }).items, 'Edit').submenu
    expect(find(picked, 'Cut').disabled).toBe(false)
  })

  it('disables every command when no pattern is open', () => {
    const { items } = menu({ hasPattern: false })
    expect(find(find(items, 'Select').submenu, 'All').disabled).toBe(true)
    expect(find(items, 'Quick notation…').disabled).toBe(true)
  })

  it('keeps ghost notes and zoom reachable from View', () => {
    const onShowGhostsChange = vi.fn()
    const onZoomIn = vi.fn()
    const view = find(menu({ showGhosts: true, onShowGhostsChange, onZoomIn }).items, 'View').submenu
    expect(find(view, 'Ghost notes').checked).toBe(true)
    find(view, 'Ghost notes').onClick()
    expect(onShowGhostsChange).toHaveBeenCalledWith(false)
    find(view, 'Zoom in').onClick()
    expect(onZoomIn).toHaveBeenCalled()
  })

  it('prints a shortcut on most rows', () => {
    const labelled = []
    const walk = (items) => items.forEach((i) => { if (i.submenu) walk(i.submenu); else if (i.shortcut) labelled.push(i) })
    walk(menu().items)
    expect(labelled.length).toBeGreaterThan(20)
  })
})

describe('scale menu', () => {
  it('switches the scale on and sets root and mode without losing the others', () => {
    const onScaleChange = vi.fn()
    const items = buildScaleMenu({ scale: DEFAULT_SCALE, onScaleChange })
    find(items, 'Snap to scale').onClick()
    expect(onScaleChange).toHaveBeenLastCalledWith({ enabled: true, root: 0, mode: 'ionian' })
    find(find(items, 'Root: C').submenu, 'D').onClick()
    expect(onScaleChange).toHaveBeenLastCalledWith({ enabled: false, root: 2, mode: 'ionian' })
    find(find(items, 'Mode: Major').submenu, 'Minor / Aeolian').onClick()
    expect(onScaleChange).toHaveBeenLastCalledWith({ enabled: false, root: 0, mode: 'aeolian' })
  })

  it('names the mode short for the button', () => {
    expect(shortModeLabel('aeolian')).toBe('Minor')
    expect(shortModeLabel('ionian')).toBe('Major')
    expect(shortModeLabel('dorian')).toBe('Dorian')
  })
})
