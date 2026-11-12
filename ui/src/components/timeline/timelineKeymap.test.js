import { describe, expect, it } from 'vitest'
import {
  TIMELINE_GLOBAL_KEY_COMBOS,
  TIMELINE_KEY_COMBOS,
  TIMELINE_PASSTHROUGH_COMMANDS,
  logicalKey,
  resolveTimelineKeyCommand,
} from './timelineKeymap.js'

const press = (key, extra = {}) => ({
  key, code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra,
})
const ctrl = (key, extra = {}) => press(key, { ctrlKey: true, ...extra })
const id = (event) => resolveTimelineKeyCommand(event)?.id ?? null

// Rebuilds the event a registered combo stands for ("Ctrl+Shift+Z" ->
// { ctrlKey, shiftKey, key: 'Z' }). The key itself may be '+', so the
// modifiers are peeled off the front rather than split on '+'.
function eventForCombo(combo) {
  const event = press('')
  let rest = combo
  for (const [prefix, flag] of [['Meta+', 'metaKey'], ['Ctrl+', 'ctrlKey'], ['Shift+', 'shiftKey'], ['Alt+', 'altKey']]) {
    if (rest.length > prefix.length && rest.startsWith(prefix)) {
      event[flag] = true
      rest = rest.slice(prefix.length)
    }
  }
  event.key = rest
  return event
}

describe('logicalKey', () => {
  it('lowercases a letter whatever Caps Lock or Shift did to it', () => {
    expect(logicalKey(press('z'))).toBe('z')
    expect(logicalKey(press('Z'))).toBe('z')
  })

  it('takes the physical key when the layout produces a non-Latin letter', () => {
    expect(logicalKey(press('я', { code: 'KeyZ' }))).toBe('z')
    expect(logicalKey(press('с', { code: 'KeyC' }))).toBe('c')
  })

  it('trusts a Latin letter over the physical key (AZERTY, Dvorak)', () => {
    // AZERTY: the key cap marked A sits where QWERTY has Q.
    expect(logicalKey(press('a', { code: 'KeyQ' }))).toBe('a')
  })

  it('leaves punctuation, digits and named keys alone', () => {
    expect(logicalKey(press(',', { code: 'KeyM' }))).toBe(',')
    expect(logicalKey(press('+'))).toBe('+')
    expect(logicalKey(press('7'))).toBe('7')
    expect(logicalKey(press('Delete'))).toBe('Delete')
  })
})

describe('resolveTimelineKeyCommand', () => {
  it('maps the edit shortcuts', () => {
    expect(id(ctrl('z'))).toBe('undo')
    expect(id(ctrl('y'))).toBe('redo')
    expect(id(ctrl('a'))).toBe('selectAll')
    expect(id(ctrl('x'))).toBe('cut')
    expect(id(ctrl('c'))).toBe('copy')
    expect(id(ctrl('v'))).toBe('paste')
    expect(id(ctrl('d'))).toBe('duplicate')
    expect(id(press('Delete'))).toBe('delete')
    expect(id(press('z', { metaKey: true }))).toBe('undo')
  })

  it('redoes on Ctrl+Shift+Z, which reports an uppercase Z', () => {
    // The regression: the old handler compared event.key to a lowercase 'z',
    // so this press was routed to the timeline and then ignored.
    expect(id(ctrl('Z', { shiftKey: true, code: 'KeyZ' }))).toBe('redo')
  })

  it('keeps working with Caps Lock on', () => {
    expect(id(ctrl('Z', { code: 'KeyZ' }))).toBe('undo')
    expect(id(ctrl('C', { code: 'KeyC' }))).toBe('copy')
    expect(id(ctrl('V', { code: 'KeyV' }))).toBe('paste')
    expect(resolveTimelineKeyCommand(press('P', { code: 'KeyP' }))).toEqual({ id: 'tool', tool: 'pencil' })
  })

  it('keeps working on a non-Latin layout', () => {
    expect(id(ctrl('я', { code: 'KeyZ' }))).toBe('undo')
    expect(id(ctrl('м', { code: 'KeyV' }))).toBe('paste')
  })

  it('maps the bare tool letters, which share keys with Ctrl shortcuts', () => {
    expect(resolveTimelineKeyCommand(press('s'))).toEqual({ id: 'splitOrSelect' })
    expect(resolveTimelineKeyCommand(press('p'))).toEqual({ id: 'tool', tool: 'pencil' })
    expect(resolveTimelineKeyCommand(press('c'))).toEqual({ id: 'tool', tool: 'split' })
    expect(resolveTimelineKeyCommand(press('d'))).toEqual({ id: 'tool', tool: 'delete' })
    expect(id(press('l'))).toBe('toggleLoop')
  })

  it('maps the pitch keys to semitone, cent and octave steps', () => {
    expect(resolveTimelineKeyCommand(press('='))).toMatchObject({ id: 'pitch', semitones: 1, cents: 0 })
    expect(resolveTimelineKeyCommand(press('-'))).toMatchObject({ id: 'pitch', semitones: -1, cents: 0 })
    expect(resolveTimelineKeyCommand(ctrl('='))).toMatchObject({ id: 'pitch', semitones: 0, cents: 1 })
    expect(resolveTimelineKeyCommand(ctrl('-'))).toMatchObject({ id: 'pitch', semitones: 0, cents: -1 })
    expect(resolveTimelineKeyCommand(press('+', { shiftKey: true }))).toMatchObject({ id: 'pitch', semitones: 12, cents: 0 })
    expect(resolveTimelineKeyCommand(press('_', { shiftKey: true }))).toMatchObject({ id: 'pitch', semitones: -12, cents: 0 })
  })

  it('maps 1-9 to a zero-based syllable index', () => {
    expect(resolveTimelineKeyCommand(press('1'))).toEqual({ id: 'syllable', index: 0 })
    expect(resolveTimelineKeyCommand(press('9'))).toEqual({ id: 'syllable', index: 8 })
    expect(resolveTimelineKeyCommand(press('0'))).toBeNull()
  })

  it('leaves other people\'s shortcuts alone', () => {
    expect(resolveTimelineKeyCommand(ctrl('s'))).toBeNull()                       // Save
    expect(resolveTimelineKeyCommand(ctrl('D', { shiftKey: true }))).toBeNull()   // Focus Detail Dock
    expect(resolveTimelineKeyCommand(ctrl('+', { shiftKey: true }))).toBeNull()   // window zoom
    expect(resolveTimelineKeyCommand(press('z', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(resolveTimelineKeyCommand(press('Delete', { shiftKey: true }))).toBeNull()
    expect(resolveTimelineKeyCommand(press('m'))).toBeNull()                      // Mixer
    expect(resolveTimelineKeyCommand(press(' '))).toBeNull()                      // transport
    expect(resolveTimelineKeyCommand(null)).toBeNull()
  })
})

describe('registered combos', () => {
  it('every registered combo resolves to a command', () => {
    // A combo the router accepts but the resolver rejects is exactly the bug
    // this module exists to remove: a key the timeline takes and then drops.
    const dropped = TIMELINE_KEY_COMBOS.filter((combo) => !resolveTimelineKeyCommand(eventForCombo(combo)))
    expect(dropped).toEqual([])
  })

  it('has no duplicates', () => {
    expect(new Set(TIMELINE_KEY_COMBOS).size).toBe(TIMELINE_KEY_COMBOS.length)
  })

  it('the project-wide combos are undo and redo only, and are also timeline combos', () => {
    for (const combo of TIMELINE_GLOBAL_KEY_COMBOS) {
      expect(['undo', 'redo']).toContain(id(eventForCombo(combo)))
      expect(TIMELINE_KEY_COMBOS).toContain(combo)
    }
  })

  it('only bare-key commands pass through to window listeners', () => {
    const passthroughCombos = TIMELINE_KEY_COMBOS.filter((combo) =>
      TIMELINE_PASSTHROUGH_COMMANDS.has(id(eventForCombo(combo))))
    expect(passthroughCombos.length).toBeGreaterThan(0)
    for (const combo of passthroughCombos) expect(combo).toHaveLength(1)
  })
})
