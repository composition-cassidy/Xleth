// @vitest-environment jsdom
// ParentPicker (R6, R8): a kit Button + kit Menu; never offers itself or a loop,
// says why deep chains are missing, and reports Alt (keep on screen) from the
// item's click or from the keyboard while the menu is open.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ParentPicker, { PARENT_PICKER_HINT, PARENT_PICKER_MODS, parentLabel, parentPickerModel, tooDeepNote } from './ParentPicker.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// 1 Lead (no parent), 2 Bass follows 1, 3 Drums follows 2, 4 Keys, 5 Pad follows 6, 6 Strings follows 7,
// 7 Choir follows 8, 8 Brass. Track 9 Vox is the one being edited, parent 4.
const TRACKS = [
  { id: 1, name: 'Lead', parentTrackId: -1 },
  { id: 2, name: 'Bass', parentTrackId: 1 },
  { id: 3, name: 'Drums', parentTrackId: 2 },
  { id: 4, name: 'Keys', parentTrackId: -1 },
  { id: 5, name: 'Pad', parentTrackId: 6 },
  { id: 6, name: 'Strings', parentTrackId: 7 },
  { id: 7, name: 'Choir', parentTrackId: 8 },
  { id: 8, name: 'Brass', parentTrackId: -1 },
  { id: 9, name: 'Vox', parentTrackId: 4 },
  { id: 10, name: 'Fx', parentTrackId: 9 },
]

let mount
let root

beforeEach(() => {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
})

const render = (el) => act(async () => root.render(el))
const trigger = () => mount.querySelector('[data-testid="xleth-parent-picker"]')
const menu = () => document.querySelector('[role="menu"]')
const items = () => [...document.querySelectorAll('[role^="menuitem"]')]
const itemNamed = (name) => items().find((el) => el.textContent === name)
const click = (el, init = {}) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })) })
const key = (type, k) => act(async () => { window.dispatchEvent(new KeyboardEvent(type, { key: k, altKey: type === 'keydown' && k === 'Alt', bubbles: true, cancelable: true })) })

describe('pure model', () => {
  it('labels, the too-deep note, a dangling parent reads as none', () => {
    expect(parentLabel(null)).toBe('Parent: none')
    expect(parentLabel({ id: 4, name: 'Keys' })).toBe('Parent: Keys')
    expect(parentLabel({ id: 4 })).toBe('Parent: Track 4')
    expect(tooDeepNote(0)).toBeNull()
    expect(tooDeepNote(1)).toBe('1 track not offered: a chain deeper than 4 parents')
    expect(tooDeepNote(3)).toBe('3 tracks not offered: a chain deeper than 4 parents')
    const m = parentPickerModel(9, TRACKS)
    expect(m.current).toBe(4)
    expect(m.currentTrack.name).toBe('Keys')
    expect(parentPickerModel(9, TRACKS, { parentTrackId: 99 }).current).toBe(-1)
  })

  it('offers neither itself nor a loop, and holds back chains past the cap', () => {
    const m = parentPickerModel(9, TRACKS)
    // 9 has one generation below (10). Pad (5) has 3 above: 1 + 1 + 3 = 5 > 4.
    expect(m.eligible.map((t) => t.name)).toEqual(['Lead', 'Bass', 'Drums', 'Keys', 'Strings', 'Choir', 'Brass'])
    expect(m.tooDeep.map((t) => t.name)).toEqual(['Pad'])
    expect(m.note).toBe('1 track not offered: a chain deeper than 4 parents')
  })
})

describe('ParentPicker', () => {
  it('a kit Button naming the parent, with its hint and a 24 px hit', async () => {
    await render(<ParentPicker trackId={9} tracks={TRACKS} onChoose={() => {}} />)
    const t = trigger()
    expect(t.tagName).toBe('BUTTON')
    expect(t.textContent).toBe('Parent: Keys')
    expect(t.getAttribute('data-size')).toBe('sm')
    expect(t.getAttribute('data-hint')).toBe(PARENT_PICKER_HINT)
    expect(t.getAttribute('data-hint-mods')).toBe(PARENT_PICKER_MODS)
    expect(t.getAttribute('aria-haspopup')).toBe('menu')
    expect(t.getAttribute('aria-expanded')).toBe('false')
    expect(menu()).toBeNull()
  })

  it('opens a kit Menu: None, the eligible tracks (current checked), the too-deep note, the Alt note', async () => {
    await render(<ParentPicker trackId={9} tracks={TRACKS} onChoose={() => {}} />)
    await click(trigger())
    expect(menu()).not.toBeNull()
    expect(menu().getAttribute('aria-label')).toBe('Parent')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(items().map((el) => el.textContent)).toEqual([
      'None', 'Lead', 'Bass', 'Drums', 'Keys', 'Strings', 'Choir', 'Brass', '1 track not offered: a chain deeper than 4 parents',
    ])
    expect(itemNamed('Keys').getAttribute('aria-checked')).toBe('true')
    expect(itemNamed('None').getAttribute('aria-checked')).toBe('false')
    expect(itemNamed('Vox')).toBeUndefined()         // itself
    expect(itemNamed('Fx')).toBeUndefined()          // already follows it
    expect(items().at(-1).getAttribute('aria-disabled')).toBe('true')
    expect(document.querySelector('[data-testid="xleth-parent-picker-alt"]').textContent).toBe('Hold Alt to keep the cell where it is on screen')
  })

  it('choosing reports the id and keepOnScreen false, and closes', async () => {
    const onChoose = vi.fn()
    await render(<ParentPicker trackId={9} tracks={TRACKS} onChoose={onChoose} />)
    await click(trigger())
    await click(itemNamed('Lead'))
    expect(onChoose).toHaveBeenCalledWith(1, { keepOnScreen: false })
    expect(menu()).toBeNull()
    await click(trigger())
    await click(itemNamed('None'))
    expect(onChoose).toHaveBeenLastCalledWith(-1, { keepOnScreen: false })
  })

  it('Alt on the item click = keep on screen', async () => {
    const onChoose = vi.fn()
    await render(<ParentPicker trackId={9} tracks={TRACKS} onChoose={onChoose} />)
    await click(trigger())
    await click(itemNamed('Brass'), { altKey: true })
    expect(onChoose).toHaveBeenCalledWith(8, { keepOnScreen: true })
  })

  it('Alt held on the keyboard while open = keep on screen (Enter carries no altKey); keyup releases it', async () => {
    const onChoose = vi.fn()
    await render(<ParentPicker trackId={9} tracks={TRACKS} onChoose={onChoose} />)
    await click(trigger())
    await key('keydown', 'Alt')
    const note = () => document.querySelector('[data-testid="xleth-parent-picker-alt"]')
    expect(note().textContent).toBe('Alt held: the cell keeps its place on screen')
    expect(note().hasAttribute('data-alt')).toBe(true)
    await click(itemNamed('Lead'))
    expect(onChoose).toHaveBeenLastCalledWith(1, { keepOnScreen: true })
    await click(trigger())
    await key('keydown', 'Alt')
    await key('keyup', 'Alt')
    await click(itemNamed('Bass'))
    expect(onChoose).toHaveBeenLastCalledWith(2, { keepOnScreen: false })
  })

  it('a lone Alt keydown is kept from the window menu bar', async () => {
    await render(<ParentPicker trackId={9} tracks={TRACKS} onChoose={() => {}} />)
    await click(trigger())
    const ev = new KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true, cancelable: true })
    await act(async () => { window.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(true)
  })

  it('choosing the current parent sends nothing', async () => {
    const onChoose = vi.fn()
    await render(<ParentPicker trackId={9} tracks={TRACKS} onChoose={onChoose} />)
    await click(trigger())
    await click(itemNamed('Keys'), { altKey: true })
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('pressing the trigger again closes it (the outside-press close does not reopen it)', async () => {
    await render(<ParentPicker trackId={9} tracks={TRACKS} onChoose={() => {}} />)
    await click(trigger())
    await act(async () => { trigger().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
    expect(menu()).not.toBeNull()
    await click(trigger())
    expect(menu()).toBeNull()
    // A press elsewhere closes it.
    await click(trigger())
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(menu()).toBeNull()
  })

  it('disabled does not open; parentTrackId overrides the track list; tracksById is accepted', async () => {
    await render(<ParentPicker trackId={9} tracks={TRACKS} disabled onChoose={() => {}} />)
    await click(trigger())
    expect(menu()).toBeNull()
    expect(trigger().disabled).toBe(true)
    await render(<ParentPicker trackId={1} tracks={TRACKS} tracksById={new Map(TRACKS.map((t) => [t.id, t]))} parentTrackId={8} onChoose={() => {}} />)
    expect(trigger().textContent).toBe('Parent: Brass')
    expect(trigger().getAttribute('data-parent')).toBe('8')
  })
})
