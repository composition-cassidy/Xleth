import { useState } from 'react'
import { timelineEvents } from '../../timelineEvents.js'
import { ROOT_NOTES, DEFAULT_SCALE } from './scales.js'
import {
  IconButton, SegmentedControl, Select, Toggle, Toolbar,
  SelectToolIcon, DrawToolIcon, PaintToolIcon, SliceToolIcon, DeleteToolIcon,
} from '../../ui-kit'
import { slotDisplayName } from '../sampler/SlotTabs.jsx'
import useSampleHoverStore from '../../stores/sampleHoverStore.js'
import TrackContextMenu from '../timeline/TrackContextMenu.jsx'
import { buildPianoRollMenu, buildScaleMenu, shortModeLabel } from './pianoRollMenu.js'
import styles from './PianoRoll.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcArrowLineDown = iconComponent('arrow-line-down')
const IcArrowSquareOut = iconComponent('arrow-square-out')
const IcList = iconComponent('list')
const IcRepeat = iconComponent('repeat')
const IcSliders = iconComponent('sliders-horizontal')
const IcCaretDown = iconComponent('caret-down')
const IcPlay = iconComponent('play')
const IcStopFill = iconComponent('stop', 'fill')
const IcX = iconComponent('x')

// Piano Roll title and toolbar. One 32px row, four groups with room between them:
//   menu + title       the menu, pattern Select (its list also holds New pattern and Rename
//                      pattern…), sample region Select, reference slot when the region has
//                      several, sampler settings
//   tools              one rail: Pencil, Paint, Delete, Slice, Select
//   grid               Slide, Snap, Scale (and Voice when the track has clones)
//   playback and view  Play and Loop, Pitch / Sample, detach, close
// Only the active tool is a bright chip; the Selects are flat text until hovered, and the
// housekeeping toggles that sit on all the time (Loop, Scale) use the quiet on-state, so the
// row reads as one tool palette plus plain settings instead of a dozen equal boxes.
// The tool order is Pencil, Paint, Delete, Slice, Select (what an FL Studio hand reaches for).
// Every tool names its one-letter shortcut and its mouse grammar in the hint bar.
//
// What is reached for less (edit and select commands, ghost notes, zoom, quick notation,
// MIDI import) is one menu at the left end, each row printing its shortcut, and the scale's
// root and mode sit behind the Scale button, so the row never grows when Scale is on.

const TOOLS = [
  {
    id: 'pencil', key: 'P', name: 'Pencil', Icon: DrawToolIcon,
    mods: 'Click: add a note · Shift+drag: add and set its length · Drag a note: move · Shift+drag a note: copy · Drag its right edge: resize · Shift+drag the edge: resize without overlap · Ctrl+drag: select · Alt: no snap · Right-click: delete',
  },
  {
    id: 'paint', key: 'B', name: 'Paint', Icon: PaintToolIcon,
    mods: 'Drag: paint notes along the stroke · Shift: one note per step · Alt: half-snap steps · Right-click: delete',
  },
  {
    id: 'delete', key: 'D', name: 'Delete', Icon: DeleteToolIcon,
    mods: 'Click a note: delete it · Right-click deletes with any tool',
  },
  {
    id: 'split', key: 'C', name: 'Slice', Icon: SliceToolIcon,
    mods: 'Drag a line: slice every note it crosses · Shift+click: slice one note, no drag · Alt: no snap · Right-Shift+click works in any tool',
  },
  {
    id: 'select', key: 'S', name: 'Select', Icon: SelectToolIcon,
    mods: 'Drag empty: lasso · Ctrl+click: select · Ctrl+Shift+click: add or remove · Drag a note: move (then Shift: keep pitch, Ctrl: keep time) · Shift+drag a note: copy · Drag its right edge: resize · Shift+drag the edge: resize without overlap · Alt: no snap · Right-click: delete',
  },
]

// Granularities understood by snapBeatToGrid (constants/timeline.js).
export const SNAP_OPTIONS = [
  { value: '1/32', label: '1/32' },
  { value: '1/16', label: '1/16' },
  { value: '1/8', label: '1/8' },
  { value: 'Beat', label: 'Beat' },
  { value: 'Bar', label: 'Bar' },
]

/**
 * The sample list: "No sample", then the samples whose audio or video has been swapped (the ones
 * being worked on), under their own header, then the rest in the engine's order.
 */
export function sampleOptions(regions) {
  const all = Array.isArray(regions) ? regions : []
  const isSwapped = (r) => !!(r.hasSwappedAudio || r.hasSwappedVideo)
  const swapped = all.filter(isSwapped)
  const group = (name) => (swapped.length ? { group: name } : {})
  return [
    { value: -1, label: 'No sample' },
    ...swapped.map((r) => ({ value: r.id, label: r.name, ...group('Swapped') })),
    ...all.filter((r) => !isSwapped(r)).map((r) => ({ value: r.id, label: r.name, ...group('Samples') })),
  ]
}

const NEW_PATTERN = '__new__'
const RENAME_PATTERN = '__rename__'

export default function PianoRollToolbar({
  patternName,
  activeTool, onToolChange,
  slideMode = false, onSlideModeChange,
  snap = '1/16', onSnapChange,
  scale = DEFAULT_SCALE, onScaleChange,
  onZoomIn, onZoomOut,
  onOpenSamplerSettings,
  samplerSettingsDisabled = false,
  onOpenQuickNotation,
  // Menu: runs a command of the roll's command table by id; keymap prints each row's combo.
  onCommand, keymap, selectionCount = 0,
  onClose,
  floating = false, onDetach, onDock,
  availablePatterns, currentPatternId, onSwitchPattern, onNewPattern,
  regions, currentRegionId, onRegionChange,
  regionSlots = [], refSlotIndex = 0, onRefSlotChange,
  labelMode = 'pitch', onLabelModeChange, sampleViewAvailable = false,
  showGhosts = true, onShowGhostsChange,
  auditioning = false, auditionLoop = true, auditionAvailable = false,
  onToggleAudition, onAuditionLoopChange,
  // Voice pin of the selected notes (Clones): options (voicePin.js
  // voicePinSelectOptions) only when the pattern's track has Voice clones; the
  // value is the selection's shared pin, 'mixed', or null with nothing selected.
  voicePinOptions = null, voicePinValue = null, onVoicePinChange,
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState(null) // { kind: 'main' | 'scale', x, y } under the button that opened it
  const hasPattern = currentPatternId != null

  const openMenu = (kind) => (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({ kind, x: r.left, y: r.bottom + 2 })
  }
  const menuItems = !menu ? [] : menu.kind === 'scale'
    ? buildScaleMenu({ scale, onScaleChange })
    : buildPianoRollMenu({
      keymap, run: (command) => onCommand?.(command), hasPattern, selectionCount,
      showGhosts, onShowGhostsChange, onZoomIn, onZoomOut, onOpenQuickNotation,
    })

  const patternOptions = [
    ...(Array.isArray(availablePatterns) ? availablePatterns : []).map((p) => ({ value: p.id, label: p.name })),
    { value: NEW_PATTERN, label: 'New pattern', group: 'Pattern' },
    ...(hasPattern ? [{ value: RENAME_PATTERN, label: 'Rename pattern…', group: 'Pattern' }] : []),
  ]
  const regionOptions = sampleOptions(regions)

  const onPatternSelect = (value) => {
    if (value === NEW_PATTERN) { onNewPattern?.(); return }
    if (value === RENAME_PATTERN) {
      setDraft(patternName || '')
      setRenaming(true)
      return
    }
    const id = Number(value)
    if (!Number.isNaN(id)) onSwitchPattern?.(id)
  }

  const finishRename = async (commit) => {
    setRenaming(false)
    const name = draft.trim()
    if (!commit || !name || name === patternName || currentPatternId == null) return
    try { await window.xleth?.timeline?.setPatternName?.(currentPatternId, name) }
    catch (e) { console.warn('[PianoRollToolbar] setPatternName failed', e) }
    timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
  }

  const flat = styles.flat
  return (
    <div className={styles.toolbar}>
      <div className={styles.group}>
        <IconButton
          size="sm"
          label="Piano roll menu"
          aria-haspopup="menu"
          onClick={openMenu('main')}
          hint="Menu: edit, select, view, quick notation, MIDI import"
          hintMods="Every row shows its shortcut"
        >
          <IcList size={16} />
        </IconButton>
        {renaming ? (
          <input
            autoFocus
            className={`${styles.textInput} ${styles.selectPattern}`}
            value={draft}
            aria-label="Pattern name"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => finishRename(true)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') { e.preventDefault(); finishRename(true) }
              else if (e.key === 'Escape') { e.preventDefault(); finishRename(false) }
            }}
          />
        ) : (
          <Select
            size="sm"
            className={`${flat} ${styles.strong} ${styles.selectPattern}`}
            ariaLabel="Pattern"
            placeholder="Select a pattern"
            value={hasPattern ? currentPatternId : null}
            options={patternOptions}
            onChange={onPatternSelect}
            hint="Pattern being edited"
            hintMods="The list also holds New pattern and Rename pattern…"
          />
        )}
        <Select
          size="sm"
          className={`${flat} ${styles.dim} ${styles.selectSample}`}
          ariaLabel="Sample region"
          value={currentRegionId ?? -1}
          options={regionOptions}
          onChange={(v) => onRegionChange?.(Number(v))}
          onHighlight={(v) => useSampleHoverStore.getState().setRegionId(v != null && v >= 0 ? Number(v) : null)}
          disabled={!hasPattern}
          hint="Sample region this pattern plays through its sampler"
          hintMods="Swapped samples come first · With the Samples tab open, the sample under the pointer is scrolled to and marked there"
        />
        {regionSlots.length > 1 ? (
          <Select
            size="sm"
            className={`${flat} ${styles.dim} ${styles.selectSlot}`}
            ariaLabel="Reference slot"
            value={refSlotIndex}
            options={regionSlots.map((s, i) => ({ value: i, label: slotDisplayName(s, i) }))}
            onChange={(v) => onRefSlotChange?.(Number(v))}
            hint="Reference slot: the Sample view measures transposition from this slot's root"
            hintMods="Every note plays all sounding slots; this only changes the labels"
          />
        ) : null}
        <IconButton
          size="sm"
          label="Sampler settings"
          onClick={onOpenSamplerSettings}
          disabled={samplerSettingsDisabled}
          hint={samplerSettingsDisabled ? 'Sampler settings: assign a sample region first' : 'Sampler settings for this sample region'}
        >
          <IcSliders size={16} />
        </IconButton>
      </div>

      <Toolbar label="Piano roll tools" className={styles.rail}>
        {TOOLS.map(({ id, key, name, Icon, mods }) => (
          <IconButton
            key={id}
            size="sm"
            label={`${name} tool`}
            pressed={activeTool === id}
            keyHint={key}
            onClick={() => onToolChange(id)}
            hint={`${name} tool (${key})`}
            hintMods={mods}
          >
            <Icon size={16} />
          </IconButton>
        ))}
      </Toolbar>

      <div className={styles.group}>
        <Toggle
          size="sm"
          className={styles.slideButton}
          on={slideMode}
          onChange={(next) => onSlideModeChange?.(next)}
          hint="Slide: new notes are drawn as slide notes"
        >Slide</Toggle>
        <span className={styles.divider} aria-hidden="true" />
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Snap</span>
          <Select
            size="sm"
            className={flat}
            ariaLabel="Snap"
            value={snap}
            options={SNAP_OPTIONS}
            onChange={(v) => onSnapChange?.(v)}
            hint="Snap for drawing, moving and resizing notes"
            hintMods="Alt: no snap"
          />
        </label>
        <span className={styles.split}>
          <Toggle
            size="sm"
            tone="quiet"
            className={styles.scaleButton}
            on={scale.enabled}
            onChange={(next) => onScaleChange?.({ ...scale, enabled: next })}
            hint={scale.enabled ? 'Snap to scale: on' : 'Snap to scale: restrict notes to one scale'}
            hintMods="Click: switch on or off · In-scale rows are lifted · ↑ ↓ step by scale degree"
          >{scale.enabled ? `${ROOT_NOTES[scale.root] ?? 'C'} ${shortModeLabel(scale.mode)}` : 'Scale'}</Toggle>
          <IconButton
            size="sm"
            label="Scale root and mode"
            aria-haspopup="menu"
            onClick={openMenu('scale')}
            hint="Scale root and mode"
          >
            <IcCaretDown size={12} />
          </IconButton>
        </span>
        {Array.isArray(voicePinOptions) && voicePinOptions.length > 0 ? (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Voice</span>
            <Select
              size="sm"
              className={`${flat} ${styles.selectVoice}`}
              ariaLabel="Voice of the selected notes"
              value={Number.isInteger(voicePinValue) ? voicePinValue : null}
              placeholder={voicePinValue === 'mixed' ? 'Mixed' : 'No notes'}
              options={voicePinOptions}
              disabled={voicePinValue == null}
              onChange={(v) => onVoicePinChange?.(Number(v))}
              hint={voicePinValue == null
                ? 'Voice: select notes to choose which cell plays them'
                : 'Voice: which cell plays the selected notes. Auto takes the lowest free voice'}
              hintMods="Pinned notes show V0 (the source) or V1, V2… (a voice clone) · One undo step"
            />
          </label>
        ) : null}
      </div>

      <div className={styles.group}>
        <IconButton
          size="sm"
          label={auditioning ? 'Stop pattern' : 'Play pattern'}
          pressed={auditioning}
          onClick={onToggleAudition}
          disabled={!auditionAvailable}
          hint={auditioning ? 'Stop the pattern audition' : (
            auditionAvailable
              ? 'Play this pattern on its own, through its track effects'
              : 'Play pattern: assign a sample region with notes first')}
          hintMods="Plays only this pattern, not the arrangement · Starting normal playback stops it"
        >
          {auditioning ? <IcStopFill size={16} /> : <IcPlay size={16} />}
        </IconButton>
        <IconButton
          size="sm"
          tone="quiet"
          label="Loop"
          pressed={auditionLoop}
          onClick={() => onAuditionLoopChange?.(!auditionLoop)}
          disabled={!hasPattern}
          hint={auditionLoop ? 'Loop on: the pattern repeats until stopped' : 'Loop off: the pattern plays once'}
          hintMods="Switching it off while playing lets the current pass finish"
        >
          <IcRepeat size={16} />
        </IconButton>
      </div>

      <SegmentedControl
        size="sm"
        className={styles.viewSwitch}
        label="Note labels"
        value={labelMode}
        onChange={(v) => onLabelModeChange?.(v)}
        options={[
          { value: 'pitch', label: 'Pitch', hint: 'Pitch view: notes show their note name' },
          {
            value: 'sample',
            label: 'Sample',
            disabled: !sampleViewAvailable,
            hint: sampleViewAvailable
              ? 'Sample view: notes show how far the sample is transposed from its root, in semitones'
              : 'Sample view needs a sample region on this pattern',
          },
        ]}
      />

      <span className={styles.spacer} />

      <div className={styles.group}>
        {floating ? (
          <IconButton size="sm" label="Dock" onClick={onDock} hint="Return the piano roll to the dock">
            <IcArrowLineDown size={16} />
          </IconButton>
        ) : (
          onDetach ? (
            <IconButton size="sm" label="Detach" onClick={onDetach} hint="Float the piano roll in its own window">
              <IcArrowSquareOut size={16} />
            </IconButton>
          ) : null
        )}
        <IconButton size="sm" label={floating ? 'Close' : 'Back to timeline'} onClick={onClose} hint={floating ? 'Close the piano roll' : 'Close the piano roll and return to the timeline'}>
          <IcX size={16} />
        </IconButton>
      </div>
      {menu ? (
        <TrackContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
    </div>
  )
}
