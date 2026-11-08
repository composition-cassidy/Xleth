import { useState } from 'react'
import { ArrowDownToLine, ExternalLink, X, ZoomIn, ZoomOut } from 'lucide-react'
import { timelineEvents } from '../../timelineEvents.js'
import { SCALE_MODES, ROOT_NOTES, DEFAULT_SCALE, scaleLabel } from './scales.js'
import {
  IconButton, SegmentedControl, Select, Toggle, Toolbar, ToolbarSeparator,
  SelectToolIcon, DrawToolIcon, SliceToolIcon, DeleteToolIcon, SamplerIcon, QuickNotationIcon,
} from '../../ui-kit'
import { slotDisplayName } from '../sampler/SlotTabs.jsx'
import styles from './PianoRoll.module.css'

// Piano Roll title and toolbar (round 2, step 12.5). One 32px row of kit
// controls. Title: pattern Select (its list also holds New pattern and Rename
// pattern…) and the sample region Select, plus a reference-slot Select when
// the region has several slots. No duplicated label, no meta strings. Every
// tool names its one-letter shortcut and its mouse grammar in the hint bar.

const TOOLS = [
  {
    id: 'select', key: 'S', name: 'Select', Icon: SelectToolIcon,
    mods: 'Drag empty: lasso · Shift+click: add or remove · Drag a note: move · Drag its right edge: resize · Alt: no snap · Right-click: delete',
  },
  {
    id: 'pencil', key: 'P', name: 'Pencil', Icon: DrawToolIcon,
    mods: 'Click: add a note · Drag a note: move · Drag its right edge: resize · Ctrl+drag empty: lasso · Alt: no snap · Right-click: delete',
  },
  {
    id: 'split', key: 'C', name: 'Split', Icon: SliceToolIcon,
    mods: 'Click a note: split it at the pointer (unsnapped) · Right-click: delete',
  },
  {
    id: 'delete', key: 'D', name: 'Delete', Icon: DeleteToolIcon,
    mods: 'Click a note: delete it · Right-click deletes with any tool',
  },
]

const NOTE_LENGTHS = [
  { value: 960, label: '1/4' },
  { value: 480, label: '1/8' },
  { value: 240, label: '1/16' },
  { value: 120, label: '1/32' },
]

// Granularities understood by snapBeatToGrid (constants/timeline.js).
export const SNAP_OPTIONS = [
  { value: '1/32', label: '1/32' },
  { value: '1/16', label: '1/16' },
  { value: '1/8', label: '1/8' },
  { value: 'Beat', label: 'Beat' },
  { value: 'Bar', label: 'Bar' },
]

const NEW_PATTERN = '__new__'
const RENAME_PATTERN = '__rename__'

export default function PianoRollToolbar({
  patternName,
  activeTool, onToolChange,
  slideMode = false, onSlideModeChange,
  stickyNoteLength, onStickyNoteLengthChange,
  snap = '1/16', onSnapChange,
  scale = DEFAULT_SCALE, onScaleChange,
  onZoomIn, onZoomOut,
  onOpenSamplerSettings,
  samplerSettingsDisabled = false,
  onOpenQuickNotation,
  onClose,
  floating = false, onDetach, onDock,
  availablePatterns, currentPatternId, onSwitchPattern, onNewPattern,
  regions, currentRegionId, onRegionChange,
  regionSlots = [], refSlotIndex = 0, onRefSlotChange,
  labelMode = 'pitch', onLabelModeChange, sampleViewAvailable = false,
  showGhosts = true, onShowGhostsChange,
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const hasPattern = currentPatternId != null

  const patternOptions = [
    ...(Array.isArray(availablePatterns) ? availablePatterns : []).map((p) => ({ value: p.id, label: p.name })),
    { value: NEW_PATTERN, label: 'New pattern', group: 'Pattern' },
    ...(hasPattern ? [{ value: RENAME_PATTERN, label: 'Rename pattern…', group: 'Pattern' }] : []),
  ]
  const regionOptions = [
    { value: -1, label: 'No sample' },
    ...(Array.isArray(regions) ? regions : []).map((r) => ({ value: r.id, label: r.name })),
  ]

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

  return (
    <div className={styles.toolbar}>
      <div className={styles.title}>
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
            className={styles.selectPattern}
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
          className={styles.selectSample}
          ariaLabel="Sample region"
          value={currentRegionId ?? -1}
          options={regionOptions}
          onChange={(v) => onRegionChange?.(Number(v))}
          disabled={!hasPattern}
          hint="Sample region this pattern plays through its sampler"
        />
        {regionSlots.length > 1 ? (
          <Select
            size="sm"
            className={styles.selectSlot}
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
          <SamplerIcon size={16} />
        </IconButton>
      </div>

      <ToolbarSeparator />
      <Toolbar label="Piano roll tools">
        {TOOLS.map(({ id, key, name, Icon, mods }) => (
          <IconButton
            key={id}
            size="sm"
            label={`${name} tool`}
            pressed={activeTool === id}
            onClick={() => onToolChange(id)}
            hint={`${name} tool (${key})`}
            hintMods={mods}
          >
            <Icon size={16} />
          </IconButton>
        ))}
      </Toolbar>
      <Toggle
        size="sm"
        on={slideMode}
        onChange={(next) => onSlideModeChange?.(next)}
        hint="Slide: new notes are drawn as slide notes"
      >Slide</Toggle>

      <ToolbarSeparator />
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Length</span>
        <Select
          size="sm"
          className={styles.selectSmall}
          ariaLabel="Note length"
          value={stickyNoteLength}
          options={NOTE_LENGTHS}
          onChange={(v) => onStickyNoteLengthChange(Number(v))}
          hint="Length of new notes (resizing a note sets it too)"
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Snap</span>
        <Select
          size="sm"
          className={styles.selectSmall}
          ariaLabel="Snap"
          value={snap}
          options={SNAP_OPTIONS}
          onChange={(v) => onSnapChange?.(v)}
          hint="Snap for drawing, moving and resizing notes"
          hintMods="Alt: no snap · Ctrl: 1/8"
        />
      </label>
      <Toggle
        size="sm"
        on={scale.enabled}
        onChange={(next) => onScaleChange?.({ ...scale, enabled: next })}
        hint={scale.enabled ? `Snap to scale: ${scaleLabel(scale.root, scale.mode)}` : 'Snap to scale: restrict notes to one scale'}
        hintMods="In-scale rows are lifted · ↑ ↓ step by scale degree"
      >Scale</Toggle>
      {scale.enabled ? (
        <>
          <Select
            size="sm"
            className={styles.selectRoot}
            ariaLabel="Scale root"
            value={scale.root}
            options={ROOT_NOTES.map((n, i) => ({ value: i, label: n }))}
            onChange={(v) => onScaleChange?.({ ...scale, root: Number(v) })}
          />
          <Select
            size="sm"
            className={styles.selectMode}
            ariaLabel="Scale"
            value={scale.mode}
            options={SCALE_MODES.map((m) => ({ value: m.id, label: m.label }))}
            onChange={(v) => onScaleChange?.({ ...scale, mode: v })}
          />
        </>
      ) : null}

      <ToolbarSeparator />
      <SegmentedControl
        size="sm"
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
      <Toggle
        size="sm"
        on={showGhosts}
        onChange={(next) => onShowGhostsChange?.(next)}
        hint="Ghost notes: other patterns playing at the same time"
        hintMods="Solid grey: same sample · Outline: another sample"
      >Ghosts</Toggle>

      <ToolbarSeparator />
      <IconButton size="sm" label="Zoom out" onClick={onZoomOut} hint="Zoom out" hintMods="Ctrl+wheel: time zoom · Alt+wheel: pitch zoom">
        <ZoomOut size={16} />
      </IconButton>
      <IconButton size="sm" label="Zoom in" onClick={onZoomIn} hint="Zoom in" hintMods="Ctrl+wheel: time zoom · Alt+wheel: pitch zoom">
        <ZoomIn size={16} />
      </IconButton>
      <IconButton
        size="sm"
        label="Quick notation"
        onClick={onOpenQuickNotation}
        disabled={!hasPattern}
        hint="Quick notation: type chord tokens (Cmaj7, Dmin***) to place notes"
      >
        <QuickNotationIcon size={16} />
      </IconButton>

      <span className={styles.spacer} />
      {floating ? (
        <IconButton size="sm" label="Dock" onClick={onDock} hint="Return the piano roll to the dock">
          <ArrowDownToLine size={16} />
        </IconButton>
      ) : (
        onDetach ? (
          <IconButton size="sm" label="Detach" onClick={onDetach} hint="Float the piano roll in its own window">
            <ExternalLink size={16} />
          </IconButton>
        ) : null
      )}
      <IconButton size="sm" label={floating ? 'Close' : 'Back to timeline'} onClick={onClose} hint={floating ? 'Close the piano roll' : 'Close the piano roll and return to the timeline'}>
        <X size={16} />
      </IconButton>
    </div>
  )
}
