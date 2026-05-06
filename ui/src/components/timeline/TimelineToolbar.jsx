import { useState, useRef } from 'react'
import { MousePointer2, Pencil, Scissors, Trash2, Plus, AlignJustify, Layers } from 'lucide-react'
import { labelHexColor } from '../../constants/labels.js'
import { getSelectableSyllables } from '../SyllableSplitter/syllableModel.js'
import useTimelineDisplayStore from '../../stores/timelineDisplayStore.js'
import TimelineDisplayPopover from './TimelineDisplayPopover.jsx'

const TOOLS = [
  { id: 'select', label: 'Select', shortcut: 'S', icon: MousePointer2 },
  { id: 'pencil', label: 'Pencil', shortcut: 'P', icon: Pencil },
  { id: 'split',  label: 'Split',  shortcut: 'C', icon: Scissors },
  { id: 'delete', label: 'Delete', shortcut: 'D', icon: Trash2 },
]

const SNAP_OPTIONS = ['1/64', '1/32', '1/16', '1/8', 'Beat', 'Half', 'Bar']

export default function TimelineToolbar({
  activeTool, setActiveTool,
  activeSampleId, regions,
  snapGranularity,
  onSnapGranularityChange,
  pixelsPerBeat,
  onAddTrack,
  pencilTemplate,
  onSelectSyllable,
  declickMs,
  onDeclickChange,
  onOpenQuantize,
  quantizeSelectionCount = 0,
}) {
  const [showDisplayPopover, setShowDisplayPopover] = useState(false)
  const displayBtnRef = useRef(null)
  const { timelineDisplaySettings, setTimelineDisplaySetting } = useTimelineDisplayStore()

  const activeRegion = activeSampleId ? regions[activeSampleId] : null
  const sampleColor = activeRegion ? labelHexColor(activeRegion.label) : null

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

  return (
    <div className="timeline-toolbar">
      {/* ── Tool buttons ─────────────────────────────────────── */}
      <div className="timeline-toolbar-tools">
        {TOOLS.map(({ id, label, shortcut, icon: Icon }) => (
          <button
            key={id}
            className={`timeline-tool-btn ${activeTool === id ? 'active' : ''}`}
            onClick={() => setActiveTool(id)}
            title={`${label} (${shortcut})`}
          >
            <Icon size={14} />
          </button>
        ))}
      </div>

      {/* ── Separator ────────────────────────────────────────── */}
      <div className="timeline-toolbar-sep" />

      {/* ── Active sample indicator ──────────────────────────── */}
      <div className="timeline-active-sample" title={
        pencilTemplate
          ? `Template: ${pencilTemplate.displayName}`
          : activeRegion ? `Active: ${activeRegion.name}` : 'No sample selected'
      }>
        {pencilTemplate ? (
          <>
            <span
              className="timeline-active-sample-dot"
              style={{
                backgroundColor: labelHexColor(pencilTemplate.label),
                outline: '1.5px solid var(--theme-border-focus)',
                outlineOffset: '1px',
              }}
            />
            <span className="timeline-active-sample-name">
              {pencilTemplate.displayName}
            </span>
          </>
        ) : (
          <>
            {sampleColor && (
              <span className="timeline-active-sample-dot" style={{ backgroundColor: sampleColor }} />
            )}
            <span className="timeline-active-sample-name">
              {activeRegion ? activeRegion.name : 'No sample'}
            </span>
          </>
        )}
      </div>

      {/* ── Syllable picker (pencil + Quote with syllables) ──── */}
      {showSyllablePicker && (
        <>
          <div className="timeline-toolbar-sep" />
          <div className="timeline-syllable-picker" title="Pick syllable (1-9 keys)">
            {selectableSyllables.map(({ syllable: syl, sourceIndex, number }) => (
              <button
                key={sourceIndex}
                className={`timeline-syllable-btn ${currentSyllableIdx === sourceIndex ? 'active' : ''}`}
                onClick={() => onSelectSyllable?.(sourceIndex)}
                title={syl.text ? `${number}: ${syl.text}` : `Syllable ${number}`}
              >
                {number}
              </button>
            ))}
            <button
              className={`timeline-syllable-btn ${currentSyllableIdx === -1 ? 'active' : ''}`}
              onClick={() => onSelectSyllable?.(-1)}
              title="Draw whole quote"
            >
              whole
            </button>
          </div>
        </>
      )}

      {/* ── Separator ────────────────────────────────────────── */}
      <div className="timeline-toolbar-sep" />

      {/* ── Snap granularity dropdown ────────────────────────── */}
      <div className="timeline-toolbar-info">
        <span className="timeline-toolbar-tag">Snap</span>
        <select
          className="timeline-snap-select"
          value={snapGranularity}
          onChange={e => onSnapGranularityChange?.(e.target.value)}
          title="Snap granularity"
        >
          {SNAP_OPTIONS.map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>

      {/* ── Declick ──────────────────────────────────────────── */}
      <div className="timeline-toolbar-sep" />
      <div className="timeline-toolbar-info">
        <span className="timeline-toolbar-tag">Declick</span>
        <input
          type="number"
          className="timeline-declick-input"
          min="0"
          max="5"
          step="0.1"
          value={declickMs}
          onChange={e => {
            const v = parseFloat(e.target.value)
            if (!isNaN(v)) onDeclickChange(v)
          }}
        />
        <span className="timeline-toolbar-tag">ms</span>
      </div>

      {/* ── Quantize ─────────────────────────────────────────── */}
      <div className="timeline-toolbar-sep" />
      <button
        className="timeline-tool-btn"
        onClick={onOpenQuantize}
        disabled={quantizeSelectionCount === 0}
        title={quantizeSelectionCount === 0
          ? 'Quantize (select clips first)'
          : `Quantize ${quantizeSelectionCount} selected`}
      >
        <AlignJustify size={14} />
      </button>

      {/* ── Timeline Display settings ────────────────────────── */}
      <div className="timeline-toolbar-sep" />
      <div className="tl-display-root">
        <button
          ref={displayBtnRef}
          className={`timeline-tool-btn ${showDisplayPopover ? 'active' : ''}`}
          onClick={() => setShowDisplayPopover(v => !v)}
          title="Timeline display settings"
        >
          <Layers size={14} />
        </button>
        {showDisplayPopover && (
          <TimelineDisplayPopover
            settings={timelineDisplaySettings}
            onSet={setTimelineDisplaySetting}
            onClose={() => setShowDisplayPopover(false)}
            triggerRef={displayBtnRef}
          />
        )}
      </div>

      {/* ── Right side: zoom + add track ─────────────────────── */}
      <div className="timeline-toolbar-actions">
        <span className="timeline-zoom-display">
          {pixelsPerBeat.toFixed(0)} px/beat
        </span>
        <button className="tab-icon-btn" title="Add track" onClick={onAddTrack}>
          <Plus size={14} />
        </button>
      </div>
    </div>
  )
}
