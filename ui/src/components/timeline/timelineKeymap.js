// The arrangement's keyboard map: which key press means which timeline command.
//
// This is the ONE place a timeline shortcut is spelled. TimelineView registers
// TIMELINE_KEY_COMBOS with the keyboard router and turns every routed event
// into a command with resolveTimelineKeyCommand; it never looks at event.key
// itself.
//
// Why a resolver and not `event.key === 'z'` at the call site: event.key is the
// character the press PRODUCED, so it changes with Caps Lock ('Z'), with Shift
// ('Z' again, which is why Ctrl+Shift+Z never reached redo), and with the
// keyboard layout (a Cyrillic layout reports 'я' for the same key cap). The
// router already matches all of those to the registered combo, so a handler
// that then compared event.key to a lowercase literal accepted the key and
// silently did nothing with it.

const PITCH_UP_KEYS = new Set(['+', '='])
const PITCH_DOWN_KEYS = new Set(['-', '_'])

/**
 * The key the user meant, independent of Caps Lock, Shift and layout: a
 * lowercase letter for letter keys, event.key unchanged for everything else.
 *
 * A Latin letter is taken from event.key, so AZERTY/Dvorak users get the letter
 * printed on their key cap. Only when the layout produces a non-Latin character
 * does the physical key (event.code) decide, which is the convention every
 * editor follows for Ctrl+C on a Cyrillic or Greek layout.
 */
export function logicalKey(event) {
  const key = event?.key
  if (typeof key !== 'string' || key.length !== 1) return key ?? ''
  if (/^[a-z]$/i.test(key)) return key.toLowerCase()
  if (key.charCodeAt(0) > 127) {
    const code = typeof event.code === 'string' ? event.code : ''
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  }
  return key
}

/**
 * Commands on bare letters and digits. They are claimed (preventDefault) but
 * deliberately not stopped from propagating: the Sampler's musical-typing
 * keyboard listens for the same keys on the window and has always heard them.
 */
export const TIMELINE_PASSTHROUGH_COMMANDS = new Set(['splitOrSelect', 'tool', 'syllable'])

/**
 * Commands only Motion view acts on (docs/XLETH_MOTION_VIEW_DESIGN.md R20). In the
 * Edit view they are not the timeline's: Backspace, the arrows and Escape keep
 * going wherever they went before.
 */
export const MOTION_ONLY_COMMANDS = new Set(['toggleGraph', 'nudge', 'escape'])

/**
 * The physical Backquote key (the one left of 1), whatever the layout prints on
 * it. A synthetic event with no code falls back to the character.
 */
export function isBackquoteKey(event) {
  const code = typeof event?.code === 'string' ? event.code : ''
  if (code) return code === 'Backquote'
  return event?.key === '`'
}

/**
 * Maps a keydown to a timeline command, or null when the key is not the
 * timeline's.
 *
 *   Ctrl+Z                 undo            Ctrl+Y / Ctrl+Shift+Z   redo
 *   Ctrl+A                 selectAll       Delete                  delete
 *   Ctrl+X / C / V / D     cut / copy / paste / duplicate
 *   L                      toggleLoop (selected pattern blocks)
 *   + / -                  pitch ±1 semitone; Shift = ±1 octave; Ctrl = ±1 cent
 *   S                      splitOrSelect (split the selection at the playhead,
 *                          else the Select tool)
 *   P / C / D              Pencil / Split / Delete tool
 *   1-9                    syllable pick (Pencil on a Quote sample)
 *   `  (physical key)      toggleView: Edit <-> Motion view (R20)
 *   G                      toggleGraph (Motion view only)
 *   Backspace              delete (Motion view only: selected keys)
 *   Left / Right           nudge selected keys one grid step; Shift = 1/4 step (Motion view)
 *   Escape                 escape: cancel a key gesture, else clear the key selection (Motion view)
 *
 * Meta stands in for Ctrl throughout. Alt is never part of a timeline shortcut.
 */
export function resolveTimelineKeyCommand(event) {
  if (!event || event.altKey) return null
  const primary = Boolean(event.ctrlKey || event.metaKey)
  const shift = Boolean(event.shiftKey)
  const key = logicalKey(event)

  if (!primary && !shift && isBackquoteKey(event)) return { id: 'toggleView' }
  if (!primary) {
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      return { id: 'nudge', direction: key === 'ArrowLeft' ? -1 : 1, fine: shift }
    }
    if (!shift && key === 'Escape') return { id: 'escape' }
    if (!shift && key === 'Backspace') return { id: 'delete', key: 'Backspace' }
    if (!shift && key === 'g') return { id: 'toggleGraph' }
  }

  if (PITCH_UP_KEYS.has(key) || PITCH_DOWN_KEYS.has(key)) {
    // Ctrl+Shift+plus/minus is the window zoom, not a pitch step.
    if (primary && shift) return null
    const direction = PITCH_UP_KEYS.has(key) ? 1 : -1
    if (shift) return { id: 'pitch', direction, semitones: direction * 12, cents: 0, unit: '12 semitones (1 octave)' }
    if (primary) return { id: 'pitch', direction, semitones: 0, cents: direction, unit: '1 cent' }
    return { id: 'pitch', direction, semitones: direction, cents: 0, unit: '1 semitone' }
  }

  if (primary) {
    if (key === 'z') return { id: shift ? 'redo' : 'undo' }
    if (shift) return null
    switch (key) {
      case 'y': return { id: 'redo' }
      case 'a': return { id: 'selectAll' }
      case 'x': return { id: 'cut' }
      case 'c': return { id: 'copy' }
      case 'v': return { id: 'paste' }
      case 'd': return { id: 'duplicate' }
      default: return null
    }
  }

  if (shift) return null
  switch (key) {
    case 'Delete': return { id: 'delete' }
    case 'l': return { id: 'toggleLoop' }
    case 's': return { id: 'splitOrSelect' }
    case 'p': return { id: 'tool', tool: 'pencil' }
    case 'c': return { id: 'tool', tool: 'split' }
    case 'd': return { id: 'tool', tool: 'delete' }
    default: break
  }
  if (/^[1-9]$/.test(key)) return { id: 'syllable', index: Number(key) - 1 }
  return null
}

// ── Combos registered with the keyboard router ──────────────────────────────
//
// The router matches a registration against event.key AND against the physical
// key, so the lowercase spelling alone covers Caps Lock and non-Latin layouts
// in the app. The uppercase spellings are kept for events that carry no
// event.code (synthetic events, some IMEs).

const bothCases = (letter) => [letter, letter.toUpperCase()]
const withPrimary = (key) => [`Ctrl+${key}`, `Meta+${key}`]

/** Project-wide commands: undo and redo act on the one engine undo stack. */
export const TIMELINE_GLOBAL_KEY_COMBOS = [
  ...bothCases('z').flatMap(withPrimary),
  ...bothCases('y').flatMap(withPrimary),
  ...bothCases('z').flatMap((k) => withPrimary(`Shift+${k}`)),
]

export const TIMELINE_KEY_COMBOS = [
  ...TIMELINE_GLOBAL_KEY_COMBOS,
  // Select all, cut / copy / paste / duplicate
  ...['a', 'x', 'c', 'v', 'd'].flatMap(bothCases).flatMap(withPrimary),
  'Delete',
  // Loop toggle and tools
  ...['l', 's', 'p', 'c', 'd'].flatMap(bothCases),
  // Pitch: bare = semitone, Ctrl/Meta = cent, Shift = octave
  '+', '=', '-', '_',
  ...['+', '=', '-', '_'].flatMap(withPrimary),
  'Shift++', 'Shift+=', 'Shift+-', 'Shift+_',
  // Syllable pick
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
  // Motion view (R20): the view switch, the graph, and the key-editing keys
  '`',
  ...bothCases('g'),
  'Backspace', 'Escape',
  'ArrowLeft', 'ArrowRight', 'Shift+ArrowLeft', 'Shift+ArrowRight',
]

/**
 * Whether a timeline command reaches the Motion view's key handling (the
 * imperative handle) instead of the Edit view's clip handling.
 */
export const MOTION_ROUTED_COMMANDS = new Set(['delete', 'copy', 'cut', 'paste', 'selectAll', 'nudge', 'escape'])

/**
 * What a command means in a view, before anything acts on it:
 *   'global'  undo / redo / the view switch: the same in both views
 *   'motion'  Motion view: goes to MotionView's handle (which may decline it)
 *   'edit'    Edit view: the arrangement's own handling
 *   null      not the timeline's in this view (the key goes on to whoever else binds it)
 * In Motion view the clip tools, pitch, syllable, loop, duplicate and split keys
 * are ignored; in the Edit view the Motion-only keys (G, arrows, Escape,
 * Backspace) are not claimed.
 */
export function timelineCommandRoute(command, view) {
  if (!command) return null
  const id = command.id
  if (id === 'undo' || id === 'redo' || id === 'toggleView') return 'global'
  if (view === 'motion') {
    if (id === 'toggleGraph') return 'global'
    return MOTION_ROUTED_COMMANDS.has(id) ? 'motion' : null
  }
  if (MOTION_ONLY_COMMANDS.has(id)) return null
  if (id === 'delete' && command.key === 'Backspace') return null
  return 'edit'
}
