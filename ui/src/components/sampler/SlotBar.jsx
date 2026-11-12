import { useRef, useState } from 'react'
import {
  Icon, IconButton, Menu, MenuItem, MenuSeparator, NumberBox, Pearl, isHeard,
} from '../../ui-kit'
import { ModNumberBox } from './kitMod.jsx'
import {
  formatGainDb, formatOffset, formatPan, noteName, parseGainDb, parseNote, parseOffset, parsePan,
  slotColorVar,
} from './samplerFormat.js'
import { slotDisplayName } from './SlotTabs.jsx'
import {
  TARGET_SLOT_VOLUME, TARGET_SLOT_PAN, TARGET_SLOT_SEM, TARGET_SLOT_FINE, TARGET_SLOT_COARSE,
} from './modulation/modTargets.js'
import styles from './Sampler.module.css'

// ── Slot bar ────────────────────────────────────────────────────────────────
// The selected slot's level and pitch, on one row directly under its tab and
// shown in every view: the controls reached for most are never a view switch
// away, and a modulation source can be dropped on them from the Modulation view
// without leaving it. Level first, then pitch from coarse to fine, then the
// slot's mute, solo and menu.

const round = (v) => Math.round(v)

function SlotMenu({ slotIndex, slotCount, maxSlots, busy, canPaste, actions }) {
  const [at, setAt] = useState(null)
  const btnRef = useRef(null)
  const isRegion = slotIndex === 0
  const full = slotCount >= maxSlots
  return (
    <>
      <IconButton
        ref={btnRef}
        size="sm"
        label={`Slot ${slotIndex + 1} actions`}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={() => {
          const r = btnRef.current?.getBoundingClientRect()
          setAt(r ? { x: r.left, y: r.bottom } : { x: 0, y: 0 })
        }}
        hint="Load or replace audio, duplicate, copy and paste settings, rename, remove"
      >
        <Icon name="dots-three" />
      </IconButton>
      {at ? (
        <Menu x={at.x} y={at.y} onClose={() => setAt(null)} label={`Slot ${slotIndex + 1} actions`}>
          <MenuItem disabled={busy} onSelect={actions.swap}>
            {isRegion ? 'Replace region audio…' : 'Replace slot audio…'}
          </MenuItem>
          <MenuItem disabled={busy || full} onSelect={actions.duplicate}>Duplicate slot</MenuItem>
          <MenuSeparator />
          <MenuItem disabled={busy} onSelect={actions.copy}>Copy settings</MenuItem>
          <MenuItem disabled={busy || !canPaste} onSelect={actions.paste}>Paste settings</MenuItem>
          <MenuItem onSelect={actions.rename}>Rename</MenuItem>
          <MenuSeparator />
          <MenuItem danger disabled={isRegion || busy} onSelect={actions.remove}>
            {isRegion ? 'Slot 1 holds the region sample' : 'Remove slot'}
          </MenuItem>
        </Menu>
      ) : null}
    </>
  )
}

export default function SlotBar({
  slots, slotIndex, maxSlots, rootNote, busy, canPaste, actions,
}) {
  const slot = slots[slotIndex] || {}
  const n = slotIndex + 1
  const v = (f, d = 0) => Number(slot?.[f] ?? d)
  const reg = (target) => ({ target, index: slotIndex, stage: 0, scale: 1 })
  const box = (field, width, props) => (
    <ModNumberBox
      key={field}
      width={width}
      disabled={busy}
      value={v(field, field === 'volume' ? 1 : 0)}
      onChange={(x) => actions.previewSlotField(slotIndex, field, x)}
      onCommit={(x) => actions.commitSlotField(slotIndex, field, x)}
      data-slot-field={field}
      {...props}
    />
  )

  return (
    <div
      className={styles.slotBar}
      role="group"
      aria-label={`Slot ${n} level and pitch: ${slotDisplayName(slot, slotIndex)}`}
      style={{ '--slot-color': slotColorVar(slotIndex) }}
    >
      {box('volume', 104, { label: 'Volume', min: 0, max: 2, step: 0.01, defaultValue: 1,
        format: formatGainDb, parse: parseGainDb, modTarget: reg(TARGET_SLOT_VOLUME),
        hint: 'Level of this slot. Linear gain 0 to 2 (up to +6.0 dB)' })}
      {box('pan', 80, { label: 'Pan', min: -1, max: 1, step: 0.01, defaultValue: 0, bipolar: true,
        format: formatPan, parse: parsePan, modTarget: reg(TARGET_SLOT_PAN), hint: 'Stereo position of this slot' })}

      <span className={styles.barGap} aria-hidden="true" />

      <NumberBox
        label="Root"
        width={80}
        value={rootNote ?? 60}
        min={0} max={127} step={1} quantize={round} defaultValue={60}
        pxPerRange={600}
        format={noteName} parse={parseNote}
        onChange={(x) => actions.setField('rootNote', Math.round(x))}
        onCommit={(x) => actions.commitField('rootNote', Math.round(x))}
        hint="Root note: the key that plays this slot at its own pitch. Type a note (C4) or drag."
        data-field="rootNote"
      />
      {/* Octave is deliberately not a modulation target: the engine has none. */}
      {box('octave', 92, { label: 'Octave', min: -4, max: 4, step: 1, quantize: round, defaultValue: 0, bipolar: true,
        format: (x) => formatOffset(x, 'oct'), parse: parseOffset, pxPerRange: 160, hint: 'Transpose this slot by octaves' })}
      {box('semitone', 80, { label: 'Semi', min: -12, max: 12, step: 1, quantize: round, defaultValue: 0, bipolar: true,
        format: (x) => formatOffset(x, 'st'), parse: parseOffset, pxPerRange: 192, modTarget: reg(TARGET_SLOT_SEM),
        hint: 'Transpose this slot in semitones' })}
      {box('fine', 88, { label: 'Fine', min: -100, max: 100, step: 1, defaultValue: 0, bipolar: true,
        format: (x) => formatOffset(x, 'ct'), parse: parseOffset, modTarget: reg(TARGET_SLOT_FINE),
        hint: 'Fine tune this slot in cents' })}
      {box('coarse', 96, { label: 'Coarse', min: -48, max: 48, step: 1, quantize: round, defaultValue: 0, bipolar: true,
        format: (x) => formatOffset(x, 'st'), parse: parseOffset, pxPerRange: 384, modTarget: reg(TARGET_SLOT_COARSE),
        hint: 'Coarse tune this slot in semitones (±4 octaves)' })}

      <span className={styles.spacer} />

      <div className={styles.flags}>
        <Pearl
          lit={isHeard({ id: slotIndex, muted: !!slot.mute, soloed: !!slot.solo }, slots.map((sl, i) => ({ id: i, muted: !!sl.mute, soloed: !!sl.solo })))}
          label={`Slot ${n}`}
          onToggle={() => (actions.pearlSlot ? actions.pearlSlot(slotIndex, 'toggle') : actions.toggleSlotFlag(slotIndex, 'mute'))}
          onSolo={() => (actions.pearlSlot ? actions.pearlSlot(slotIndex, 'solo') : actions.toggleSlotFlag(slotIndex, 'solo'))}
        />
        <SlotMenu
          slotIndex={slotIndex} slotCount={slots.length} maxSlots={maxSlots}
          busy={busy} canPaste={canPaste} actions={actions.slot}
        />
      </div>
    </div>
  )
}
