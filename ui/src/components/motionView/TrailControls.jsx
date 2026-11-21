import { useEffect, useRef, useState } from 'react'
import { Button, Menu, MenuCustom, MenuItem, MenuSeparator, TextField, THIN_SPACE } from '../../ui-kit'
import { iconComponent } from '../../ui-kit/icons'
import { TRAIL_DELAY_PRESETS, formatDelay } from '../../clones/cloneModel.js'
import { TRAIL_DELAY_MAX, TRAIL_DELAY_MIN, clampDelayTicks } from '../../motion/cloneMotion.js'
import { normaliseHex } from '../../motion/schema.js'
import styles from './TrailControls.module.css'

// The two Trail-clone settings that are not numbers on a slider
// (docs/XLETH_CLONE_SPEC.md "Trail clones"), shared by Motion view's Trail rows and
// the Inspector's Clone section:
//
//   DelayPicker  a kit Button naming the delay ('1/8', '700 ticks') that opens a kit
//                Menu of the musical values (TRAIL_DELAY_PRESETS) and an exact-ticks
//                field (Enter sets it). One commit per choice.
//   TintField    a swatch that opens the system colour dialog (committed ONCE, when
//                the dialog closes: the native `change` event, not every movement)
//                and a hex field (#RRGGBB; Enter or leaving it sets it, Escape
//                restores it). One commit per change.
// Neither talks to the engine: `onCommit` does (one setCloneSettings call).

const IcCaret = iconComponent('caret-down')

/** A delay as the UI prints it: the musical value ('1/8') or 'N ticks' with a thin space. */
export const delayText = (ticks) => formatDelay(ticks).replace(/ ticks$/, `${THIN_SPACE}ticks`)

/** The ticks an exact-delay text means ('700', '700 ticks', '1 920'), clamped to the engine's range, or null. */
export function parseDelayText(text) {
  const t = String(text ?? '').replace(/ticks?$/i, '').replace(/[\s   ]/g, '')
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  return clampDelayTicks(Number(t))
}

/**
 * Props: value (ticks), onCommit(ticks), disabled, width (px, the trigger), hint,
 * label (accessible name, default 'Delay'), 'data-testid'.
 */
export function DelayPicker({ value, onCommit, disabled = false, width, hint, label = 'Delay', 'data-testid': testId = 'trail-delay' }) {
  const triggerRef = useRef(null)
  const [anchor, setAnchor] = useState(null)
  const [text, setText] = useState('')
  const open = anchor !== null
  const ticks = Math.round(Number(value) || 0)
  const exact = parseDelayText(text)

  const close = () => setAnchor(null)
  const toggle = () => {
    if (disabled) return
    if (open) { close(); return }
    const r = triggerRef.current?.getBoundingClientRect?.()
    setText(String(ticks))
    setAnchor({ x: r ? r.left : 0, y: r ? r.bottom + 2 : 0 })
  }
  const choose = (t) => {
    close()
    if (t !== null && t !== ticks) onCommit?.(t)
  }

  return (
    <>
      <Button
        ref={triggerRef}
        size="sm"
        variant="ghost"
        disabled={disabled}
        className={styles.trigger}
        style={width ? { width } : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${delayText(ticks)}`}
        data-testid={testId}
        hint={hint ?? `${label}: ${delayText(ticks)} behind the source. Click to choose a musical value or type exact ticks`}
        onMouseDown={(e) => { e.stopPropagation() }}
        onClick={toggle}
      >
        <span className={styles.triggerText}>{delayText(ticks)}</span>
        <span className={styles.caret} aria-hidden="true"><IcCaret size={14} /></span>
      </Button>
      {open ? (
        <Menu x={anchor.x} y={anchor.y} onClose={close} label={label}>
          {TRAIL_DELAY_PRESETS.map((p) => (
            <MenuItem key={p.ticks} checked={p.ticks === ticks} onSelect={() => choose(p.ticks)}>
              {`${p.label} · ${p.ticks}${THIN_SPACE}ticks`}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuCustom>
            <div className={styles.exact}>
              <span className={styles.exactLabel}>Exact ticks</span>
              <TextField
                size="sm"
                mono
                label="Exact delay in ticks"
                className={styles.exactField}
                value={text}
                invalid={text !== '' && exact === null}
                onChange={setText}
                onKeyDown={(e) => {
                  // The menu's own keys (arrows, Home / End) stay out of the field; Escape still closes it.
                  if (e.key !== 'Escape') e.stopPropagation()
                  if (e.key === 'Enter') { e.preventDefault(); if (exact !== null) choose(exact) }
                }}
                hint={`Exact delay: ${TRAIL_DELAY_MIN} to ${TRAIL_DELAY_MAX} ticks (960 = a quarter note, 3840 = a bar)`}
                hintMods="Enter: set it · Escape: close"
                data-testid={`${testId}-exact`}
              />
            </div>
          </MenuCustom>
        </Menu>
      ) : null}
    </>
  )
}

/**
 * Props: value ('#RRGGBB'), onCommit('#RRGGBB'), disabled, width (px, the whole field),
 * hint, label (accessible name, default 'Tint'), 'data-testid'.
 */
export function TintField({ value, onCommit, disabled = false, width, hint, label = 'Tint', 'data-testid': testId = 'trail-tint' }) {
  const inputRef = useRef(null)
  const current = normaliseHex(value) ?? '#FFFFFF'
  const [draft, setDraft] = useState(null)     // the dialog's live colour (local preview only)
  const [text, setText] = useState(current)
  const editing = useRef(false)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit

  // The engine's answer replaces any local preview, and the field shows it unless being typed in.
  useEffect(() => {
    setDraft(null)
    if (!editing.current) setText(current)
  }, [current])

  // The system dialog commits once, when it closes (the native change event).
  useEffect(() => {
    const el = inputRef.current
    if (!el) return undefined
    const onNativeChange = () => {
      const hex = normaliseHex(el.value)
      if (hex && hex !== current) commitRef.current?.(hex)
    }
    el.addEventListener('change', onNativeChange)
    return () => el.removeEventListener('change', onNativeChange)
  }, [current])

  const commitText = () => {
    editing.current = false
    const hex = normaliseHex(text)
    if (!hex) { setText(current); return }
    setText(hex)
    if (hex !== current) commitRef.current?.(hex)
  }

  const shown = draft ?? current
  const valid = normaliseHex(text) !== null
  return (
    <span className={styles.tint} style={width ? { width } : undefined} data-testid={testId}>
      <label
        className={styles.swatch}
        style={{ '--swatch': shown }}
        data-hint={hint ?? `${label}: ${current}. Click the swatch to choose a colour`}
        data-disabled={disabled || undefined}
      >
        <input
          ref={inputRef}
          className={styles.swatchInput}
          type="color"
          aria-label={`${label} colour`}
          value={shown.toLowerCase()}
          disabled={disabled}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(normaliseHex(e.target.value))}
          data-testid={`${testId}-swatch`}
        />
      </label>
      <TextField
        size="sm"
        mono
        label={`${label} hex`}
        className={styles.hex}
        value={text}
        invalid={!valid}
        disabled={disabled}
        maxLength={7}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(v) => { editing.current = true; setText(v) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commitText() } else if (e.key === 'Escape') {
            e.preventDefault()
            editing.current = false
            setText(current)
          }
        }}
        onBlur={commitText}
        hint={hint ?? `${label}: the colour laid over the Trail's picture`}
        hintMods="Type #RRGGBB · Enter: set it · Escape: keep the colour"
        data-testid={`${testId}-hex`}
      />
    </span>
  )
}
