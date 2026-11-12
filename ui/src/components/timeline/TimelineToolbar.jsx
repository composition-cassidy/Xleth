import { useState, useRef } from 'react'
import {
  IconButton, SegmentedControl, Select, Toolbar, ToolbarSeparator, THIN_SPACE,
  DeleteToolIcon, DrawToolIcon, SelectToolIcon, SliceToolIcon, QuickNotationIcon,
} from '../../ui-kit'
import { labelHexColor } from '../../constants/labels.js'
import { getSelectableSyllables } from '../SyllableSplitter/syllableModel.js'
import useTimelineDisplayStore from '../../stores/timelineDisplayStore.js'
import TimelineDisplayPopover from './TimelineDisplayPopover.jsx'
import styles from './TimelineToolbar.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcFolderPlus = iconComponent('folder-plus')
const IcPlus = iconComponent('plus')
const IcSlidersHorizontal = iconComponent('sliders-horizontal')
const IcXQuantize = iconComponent('xleth-quantize')

// The arrangement toolbar (DESIGN.md 22): one 32px row of kit controls, sentence
// case, every tool with its one-letter key in the hint bar. The sample
// indicator says what it means ("Painting with: Pitch 1") and is absent when
// no sample is selected.

const TOOLS = [
  { id: 'select', label: 'Select', shortcut: 'S', icon: SelectToolIcon, mods: 'Drag empty: lasso · Shift+click: add or remove · Drag a clip: move · Alt: no snap' },
  { id: 'pencil', label: 'Pencil', shortcut: 'P', icon: DrawToolIcon, mods: 'Click or drag: paint the selected sample · Alt: no snap' },
  { id: 'split',  label: 'Split',  shortcut: 'C', icon: SliceToolIcon, mods: 'Click a clip: split it at the pointer' },
  { id: 'delete', label: 'Delete', shortcut: 'D', icon: DeleteToolIcon, mods: 'Click or drag over clips to delete them' },
]

// Values are the keys snapBeatToGrid understands; only the words are ours.
const SNAP_OPTIONS = [
  { value: '1/64', label: '1/64' },
  { value: '1/32', label: '1/32' },
  { value: '1/16', label: '1/16' },
  { value: '1/8', label: '1/8' },
  { value: 'Beat', label: 'Beat' },
  { value: 'Half', label: 'Half note' },
  { value: 'Bar', label: 'Bar' },
]

/**
 * What the zoom readout prints (DESIGN.md 22): how much music is on screen, in bars, which is
 * what a zoom level means to someone arranging. Under one bar it counts beats. Pixels per beat
 * (the engine-side zoom value) stays in the hint. With no measured width it falls back to it.
 */
export function zoomReadout(pixelsPerBeat, viewportWidth, beatsPerBar = 4) {
  const ppb = Number(pixelsPerBeat)
  const w = Number(viewportWidth)
  if (!(ppb > 0) || !(w > 0)) return { text: `${Math.round(ppb) || 0}${THIN_SPACE}px/beat`, spoken: `${Math.round(ppb) || 0} pixels per beat`, bars: null }
  const beats = w / ppb
  const bars = beats / beatsPerBar
  if (bars < 1) {
    const n = beats >= 10 ? Math.round(beats) : Math.round(beats * 10) / 10
    return { text: `${n}${THIN_SPACE}${n === 1 ? 'beat' : 'beats'}`, spoken: `${n} ${n === 1 ? 'beat' : 'beats'} visible`, bars }
  }
  const n = bars >= 10 ? Math.round(bars) : Math.round(bars * 10) / 10
  return { text: `${n}${THIN_SPACE}${n === 1 ? 'bar' : 'bars'}`, spoken: `${n} ${n === 1 ? 'bar' : 'bars'} visible`, bars }
}

export default function TimelineToolbar({
  activeTool, setActiveTool,
  activeSampleId, regions,
  snapGranularity,
  onSnapGranularityChange,
  pixelsPerBeat,
  viewportWidth,
  onAddTrack,
  onAddFolder,
  selectedTrackCount = 0,
  pencilTemplate,
  onSelectSyllable,
  onOpenQuantize,
  quantizeSelectionCount = 0,
  onOpenQuickNotation,
}) {
  const [showDisplayPopover, setShowDisplayPopover] = useState(false)
  const displayBtnRef = useRef(null)
  const timelineDisplaySettings = useTimelineDisplayStore((s) => s.timelineDisplaySettings)
  const setTimelineDisplaySetting = useTimelineDisplayStore((s) => s.setTimelineDisplaySetting)

  const activeRegion = activeSampleId ? regions[activeSampleId] : null

  // The region whose syllables should drive the selector (template takes precedence)
  const syllableRegion = pencilTemplate
    ? regions[pencilTemplate.regionId]
    : activeRegion
  const selectableSyllables = getSelectableSyllables(syllableRegion?.syllables)
  const showSyllablePicker =
    activeTool === 'pencil' &&
    syllableRegion?.label === 'Quote' &&
    selectableSyllables.length > 0
  const currentSyllableIdx = pencilTemplate?.syllableIndex ?? -1

  // What the pencil paints: the template (a syllable of a quote) or the selected sample.
  const paintName = pencilTemplate ? pencilTemplate.displayName : (activeRegion ? activeRegion.name : null)
  const paintColor = pencilTemplate
    ? labelHexColor(pencilTemplate.label)
    : (activeRegion ? labelHexColor(activeRegion.label) : null)

  const quickNotationReady = !!syllableRegion && syllableRegion.label === 'Quote' && selectableSyllables.length > 0
  const ppb = pixelsPerBeat.toFixed(pixelsPerBeat < 10 ? 1 : 0)
  const zoom = zoomReadout(pixelsPerBeat, viewportWidth)

  return (
    <div className={`timeline-toolbar ${styles.bar}`}>
      <Toolbar label="Arrangement tools" className={styles.tools}>
        {TOOLS.map(({ id, label, shortcut, icon: Icon, mods }) => (
          <IconButton
            key={id}
            size="sm"
            label={`${label} tool`}
            pressed={activeTool === id}
            keyHint={shortcut}
            onClick={() => setActiveTool(id)}
            hint={`${label} tool (${shortcut})`}
            hintMods={mods}
          >
            <Icon size={16} />
          </IconButton>
        ))}
      </Toolbar>

      {paintName ? (
        <>
          <ToolbarSeparator />
          <div className={styles.paint} data-hint="The pencil paints clips of this sample"
            data-hint-mods={pencilTemplate ? 'Choose a syllable below, or the whole quote' : 'Pick another sample in the browser'}>
            <span className={styles.paintLabel}>Painting with:</span>
            <span className={styles.paintDot} data-template={pencilTemplate ? 'true' : 'false'}
              style={paintColor ? { backgroundColor: paintColor } : undefined} aria-hidden="true" />
            <span className={`timeline-active-sample-name ${styles.paintName}`} title={paintName}>{paintName}</span>
          </div>
        </>
      ) : null}

      {showSyllablePicker && (
        <>
          <ToolbarSeparator />
          <SegmentedControl
            size="sm"
            label="Syllable to paint"
            value={currentSyllableIdx}
            onChange={(v) => onSelectSyllable?.(Number(v))}
            hint="Syllable to paint: keys 1 to 9"
            options={[
              ...selectableSyllables.map(({ syllable: syl, sourceIndex, number }) => ({
                value: sourceIndex,
                label: String(number),
                ariaLabel: syl.text ? `Syllable ${number}: ${syl.text}` : `Syllable ${number}`,
                hint: syl.text ? `Syllable ${number}: ${syl.text}` : `Syllable ${number}`,
              })),
              { value: -1, label: 'Whole', hint: 'Paint the whole quote' },
            ]}
          />
        </>
      )}

      <ToolbarSeparator />
      <IconButton
        size="sm"
        label="Quick notation"
        onClick={() => onOpenQuickNotation?.()}
        disabled={!quickNotationReady}
        hint={quickNotationReady
          ? 'Quick notation: place clips by typing rhythm patterns'
          : 'Quick notation: select a quote with syllables first'}
      >
        <QuickNotationIcon size={16} />
      </IconButton>

      <ToolbarSeparator />
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Snap</span>
        <Select
          size="sm"
          className={styles.snap}
          ariaLabel="Snap"
          value={snapGranularity}
          options={SNAP_OPTIONS}
          onChange={(v) => onSnapGranularityChange?.(v)}
          hint="Snap for placing, moving and resizing clips"
          hintMods="Alt: no snap · Ctrl: 1/8"
        />
      </label>

      {/* Declick has no toolbar control — the engine keeps applying its
          declick envelope, the value is just no longer user-editable here. */}

      <ToolbarSeparator />
      <IconButton
        size="sm"
        label="Quantize"
        onClick={onOpenQuantize}
        disabled={quantizeSelectionCount === 0}
        hint={quantizeSelectionCount === 0
          ? 'Quantize: select clips first'
          : `Quantize ${quantizeSelectionCount} selected`}
      >
        <IcXQuantize size={16} />
      </IconButton>

      {/* A press on the button never counts as "outside" for the popover's menu, so the
          click toggles it instead of closing and reopening it. */}
      <IconButton
        ref={displayBtnRef}
        size="sm"
        label="Timeline display settings"
        pressed={showDisplayPopover}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setShowDisplayPopover(v => !v)}
        hint="Timeline display: clip bodies, names, waveforms and pitch chips"
      >
        <IcSlidersHorizontal size={16} />
      </IconButton>
      {showDisplayPopover && (
        <TimelineDisplayPopover
          settings={timelineDisplaySettings}
          onSet={setTimelineDisplaySetting}
          onClose={() => setShowDisplayPopover(false)}
          triggerRef={displayBtnRef}
        />
      )}

      {/* ── Right side: zoom + add track ─────────────────────── */}
      <span className={styles.spacer} />
      <span className={`timeline-zoom-display ${styles.zoom}`} role="status" aria-label={`Zoom: ${zoom.spoken}`}
        data-hint={zoom.bars == null ? `Zoom: ${ppb} pixels per beat` : `Zoom: ${zoom.spoken} (${ppb} pixels per beat)`} data-hint-mods="Ctrl+wheel: zoom · Alt+wheel: lane height · Shift+wheel: scroll">
        {zoom.text}
      </span>
      <IconButton
        size="sm"
        label={selectedTrackCount > 0
          ? `Create folder with ${selectedTrackCount} selected track${selectedTrackCount === 1 ? '' : 's'}`
          : 'Create empty track folder'}
        onClick={onAddFolder}
        hint={selectedTrackCount > 0
          ? `New folder with the ${selectedTrackCount} selected track${selectedTrackCount === 1 ? '' : 's'}`
          : 'New empty track folder'}
      >
        <IcFolderPlus size={16} />
      </IconButton>
      <IconButton size="sm" label="Add track" onClick={onAddTrack} hint="Add a track">
        <IcPlus size={16} />
      </IconButton>
    </div>
  )
}
