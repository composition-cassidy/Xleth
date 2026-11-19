import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Menu, MenuCustom, MenuItem, MenuSeparator } from '../../ui-kit'
import { iconComponent } from '../../ui-kit/icons'
import { MAX_PARENT_DEPTH, classifyParents, indexTracks, lookupTrack, parentIdOf } from '../../motion/parentModel.js'
import styles from './ParentPicker.module.css'

// The Parent picker (docs/XLETH_MOTION_VIEW_DESIGN.md R6, R8, 5.3, 5.6): a kit
// Button naming the current parent that opens a kit Menu of the tracks this cell
// may follow. Not a Select: a Select reports only the value, and the choice needs
// its modifier: Alt held while choosing = keep the cell where it is on screen
// (the engine adjusts the child's unkeyed Roam base). Alt is read from the
// item's own click and from keydown / keyup while the menu is open (a keyboard
// Enter carries no altKey). Shared by the Motion view track row and RoamPanel.
//
// It never offers the track itself or a track that already follows it (a loop);
// tracks that would make a chain deeper than the cap are not offered either, and
// one disabled line says how many and why.

const IcCaret = iconComponent('caret-down')

export const PARENT_PICKER_HINT = "Parent: this cell follows another track's Roam. Hold Alt while choosing to keep it where it is on screen."
export const PARENT_PICKER_MODS = 'Alt while choosing: keep on screen'

const nameOf = (t) => (t?.name ? String(t.name) : `Track ${t?.id ?? t?.trackId}`)
const idOf = (t) => t?.id ?? t?.trackId

/** The trigger text: 'Parent: none' or 'Parent: <name>'. */
export function parentLabel(parentTrack) {
  return parentTrack ? `Parent: ${nameOf(parentTrack)}` : 'Parent: none'
}

/** The disabled line for candidates a too-deep chain rules out, or null. */
export function tooDeepNote(count, maxDepth = MAX_PARENT_DEPTH) {
  if (!count) return null
  return `${count} ${count === 1 ? 'track' : 'tracks'} not offered: a chain deeper than ${maxDepth} parents`
}

/**
 * What the picker shows for a track: { current (id or -1), currentTrack, eligible,
 * tooDeep, note }. A dangling or looping parent id reads as none.
 */
export function parentPickerModel(trackId, tracks, { tracksById = null, parentTrackId, maxDepth = MAX_PARENT_DEPTH } = {}) {
  const byId = tracksById ?? indexTracks(tracks)
  const own = lookupTrack(byId, trackId)
  let current = Number.isInteger(parentTrackId) ? parentTrackId : parentIdOf(own)
  const currentTrack = current >= 0 && current !== trackId ? lookupTrack(byId, current) : null
  if (!currentTrack) current = -1
  const { eligible, tooDeep } = classifyParents(trackId, tracks, byId, { maxDepth })
  return { current, currentTrack, eligible, tooDeep, note: tooDeepNote(tooDeep.length, maxDepth) }
}

/**
 * Props: trackId, tracks [{ id, name, parentTrackId }], tracksById? (Map), parentTrackId?
 * (overrides the track's own), onChoose(parentTrackId | -1, { keepOnScreen }), disabled,
 * size ('sm' 24 px default | 'md'), variant (kit Button variant, default 'ghost'),
 * maxDepth, hint, className.
 */
export default function ParentPicker({
  trackId, tracks, tracksById = null, parentTrackId, onChoose, disabled = false, size = 'sm', variant = 'ghost',
  maxDepth = MAX_PARENT_DEPTH, hint, className, 'data-testid': testId = 'xleth-parent-picker',
}) {
  const triggerRef = useRef(null)
  const [anchor, setAnchor] = useState(null)
  const [altHeld, setAltHeld] = useState(false)
  const altRef = useRef(false)
  const open = anchor !== null

  const model = useMemo(
    () => parentPickerModel(trackId, tracks, { tracksById, parentTrackId, maxDepth }),
    [trackId, tracks, tracksById, parentTrackId, maxDepth],
  )

  const setAlt = useCallback((v) => {
    altRef.current = !!v
    setAltHeld(!!v)
  }, [])

  const close = useCallback(() => {
    setAnchor(null)
    setAlt(false)
  }, [setAlt])

  // Alt while the menu is open. preventDefault keeps a lone Alt from moving focus
  // to the window menu bar.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (e.key === 'Alt') { e.preventDefault(); setAlt(true) } else if (e.altKey !== altRef.current) setAlt(e.altKey)
    }
    const onUp = (e) => {
      if (e.key === 'Alt') setAlt(false)
    }
    const onBlur = () => setAlt(false)
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open, setAlt])

  const toggle = (e) => {
    if (disabled) return
    if (open) { close(); return }
    const r = triggerRef.current?.getBoundingClientRect?.()
    setAlt(!!e?.altKey)
    setAnchor({ x: r ? r.left : 0, y: r ? r.bottom + 2 : 0 })
  }

  const choose = (id, e) => {
    const keepOnScreen = !!(e?.altKey || altRef.current)
    if (id === model.current) return
    onChoose?.(id, { keepOnScreen })
  }

  return (
    <>
      <Button
        ref={triggerRef}
        size={size}
        variant={variant}
        disabled={disabled}
        className={`${styles.trigger}${className ? ` ${className}` : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        data-parent={model.current}
        hint={hint ?? PARENT_PICKER_HINT}
        hintMods={PARENT_PICKER_MODS}
        // A press on the trigger while open must not reach the menu's outside-press
        // close, or the click right after would open it again.
        onMouseDown={(e) => { if (open) e.stopPropagation() }}
        onClick={toggle}
      >
        <span className={styles.label}>{parentLabel(model.currentTrack)}</span>
        <span className={styles.caret} aria-hidden="true"><IcCaret size={14} /></span>
      </Button>
      {open ? (
        <Menu x={anchor.x} y={anchor.y} onClose={close} label="Parent" className={styles.menu}>
          <MenuItem checked={model.current === -1} onSelect={(e) => choose(-1, e)}>None</MenuItem>
          {model.eligible.length ? <MenuSeparator /> : null}
          {model.eligible.map((t) => (
            <MenuItem key={idOf(t)} checked={model.current === idOf(t)} onSelect={(e) => choose(idOf(t), e)}>
              {nameOf(t)}
            </MenuItem>
          ))}
          {model.note ? <MenuItem disabled>{model.note}</MenuItem> : null}
          <MenuSeparator />
          <MenuCustom>
            <p className={styles.note} data-alt={altHeld || undefined} data-testid="xleth-parent-picker-alt">
              {altHeld ? 'Alt held: the cell keeps its place on screen' : 'Hold Alt to keep the cell where it is on screen'}
            </p>
          </MenuCustom>
        </Menu>
      ) : null}
    </>
  )
}
