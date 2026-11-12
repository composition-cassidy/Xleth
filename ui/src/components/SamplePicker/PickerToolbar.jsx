import { useCallback, useRef, useState } from 'react'
import { Button, IconButton, NumberBox, Select, TextField, Toggle } from '../../ui-kit'
import { labelColor } from '../../constants/labels.js'
import { formatSpan, formatTimecode, parseTimecode } from './pickerFormat.js'
import styles from './SamplePicker.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcArrowsOutLineHorizontal = iconComponent('arrows-out-line-horizontal')
const IcFrameCorners = iconComponent('frame-corners')
const IcPauseFill = iconComponent('pause', 'fill')
const IcPlay = iconComponent('play')
const IcPlus = iconComponent('plus')
const IcRepeat = iconComponent('repeat')

const ADD_CUSTOM = '__add_custom__'
const EDGE_STEP = 0.001   // one millisecond per arrow key / wheel notch on In and Out

const EDGE_MODS = 'Drag: move · Shift: fine · Arrows: 1 ms (Shift 10 ms) · Double-click: type · Ctrl+click: reset'

/**
 * The editor's two control rows under the waveform.
 *
 *   Row 1, audition and selection:  play, loop, In, Out, length, zoom
 *   (the playhead's own time is under the source picture)
 *   Row 2, what it becomes:         label, name, Add sample
 *
 * The kit controls never touch the engine: every callback is the picker's.
 */
export default function PickerToolbar({
  playing,
  loop,
  onTogglePlay,
  onToggleLoop,
  inPoint,
  outPoint,
  duration,
  onSetIn,
  onSetOut,
  onInChange,
  onOutChange,
  viewInfo,
  onZoomToSelection,
  onFit,
  label,
  allLabels,
  onLabelChange,
  onAddCustomLabel,
  labelPickerSignal = 0,
  labelSelectKey = 0,
  sampleName,
  onNameChange,
  onAddSample,
  error,
}) {
  const [addingCustom, setAddingCustom] = useState(false)
  const [customDraft, setCustomDraft] = useState('')
  const customRef = useRef(null)

  const hasBoth = inPoint !== null && outPoint !== null
  const length = hasBoth ? Math.abs(outPoint - inPoint) : null
  const canAdd = length !== null && length >= 0.01
  const max = duration > 0 ? duration : 1

  // Dragging an In / Out field by N px moves that edge N px on the waveform.
  const pxPerRange = viewInfo?.width > 0 && viewInfo?.dur > 0 && duration > 0
    ? Math.max(200, viewInfo.width * (duration / viewInfo.dur))
    : 200

  const handleLabel = useCallback((value) => {
    if (value === ADD_CUSTOM) {
      setAddingCustom(true)
      setCustomDraft('')
      setTimeout(() => customRef.current?.focus(), 0)
    } else {
      onLabelChange(value)
    }
  }, [onLabelChange])

  const commitCustom = useCallback(() => {
    const trimmed = customDraft.trim()
    if (trimmed) onAddCustomLabel(trimmed)
    setAddingCustom(false)
    setCustomDraft('')
  }, [customDraft, onAddCustomLabel])

  const labelOptions = [
    ...allLabels.map((name, i) => ({
      value: name,
      label: name,
      hint: `Label the selection ${name}`,
      hintMods: i < 9 ? `${i + 1}` : undefined,
    })),
    { value: ADD_CUSTOM, label: 'Add custom label…' },
  ]

  const playHint = playing
    ? 'Pause the preview'
    : canAdd ? 'Play the selection, In to Out' : 'Play from the playhead'

  return (
    <div className={styles.controls} data-testid="picker-controls">
      <div className={styles.row} role="group" aria-label="Preview and selection">
        <IconButton
          size="sm"
          variant="default"
          label={playing ? 'Pause' : 'Play'}
          pressed={playing}
          onClick={onTogglePlay}
          hint={playHint}
          hintMods="Space"
          data-testid="picker-play"
        >
          {playing ? <IcPauseFill aria-hidden="true" /> : <IcPlay aria-hidden="true" />}
        </IconButton>
        <Toggle
          size="sm"
          on={loop}
          onChange={onToggleLoop}
          glyph={<IcRepeat aria-hidden="true" />}
          aria-label="Loop the selection"
          hint="Loop: the selection repeats while you adjust its edges"
          hintMods="L"
          data-testid="picker-loop"
        />

        <span className={styles.sep} aria-hidden="true" />

        <NumberBox
          label="In"
          value={inPoint ?? 0}
          min={0}
          max={max}
          step={EDGE_STEP}
          defaultValue={0}
          width={96}
          pxPerRange={pxPerRange}
          format={(v) => (inPoint === null ? formatTimecode(null) : formatTimecode(v))}
          parse={parseTimecode}
          onChange={onInChange}
          hint="In point of the selection"
          hintMods={EDGE_MODS}
          data-testid="picker-in"
        />
        <Button size="sm" onClick={onSetIn} hint="Set In at the playhead" hintMods="I · Shift+I: go to In" data-testid="picker-set-in">
          Set In
        </Button>
        <NumberBox
          label="Out"
          value={outPoint ?? 0}
          min={0}
          max={max}
          step={EDGE_STEP}
          defaultValue={max}
          width={96}
          pxPerRange={pxPerRange}
          format={(v) => (outPoint === null ? formatTimecode(null) : formatTimecode(v))}
          parse={parseTimecode}
          onChange={onOutChange}
          hint="Out point of the selection"
          hintMods={EDGE_MODS}
          data-testid="picker-out"
        />
        <Button size="sm" onClick={onSetOut} hint="Set Out at the playhead" hintMods="O · Shift+O: go to Out" data-testid="picker-set-out">
          Set Out
        </Button>

        <span className={styles.readout} data-hint="Length of the selection">
          <span className={styles.readoutLabel}>Length</span>
          <span className={styles.readoutValue} data-testid="picker-length">{formatSpan(length)}</span>
        </span>

        <span className={styles.spring} />

        <IconButton
          size="sm"
          label="Zoom to selection"
          onClick={onZoomToSelection}
          disabled={!canAdd}
          hint="Zoom the waveform to the selection"
          hintMods="Z"
        >
          <IcFrameCorners aria-hidden="true" />
        </IconButton>
        <IconButton
          size="sm"
          label="Fit whole source"
          onClick={onFit}
          disabled={!viewInfo?.zoomed}
          hint="Show the whole source"
          hintMods="F · Double-click the overview"
        >
          <IcArrowsOutLineHorizontal aria-hidden="true" />
        </IconButton>
      </div>

      <div className={styles.row} role="group" aria-label="Add as a sample">
        <span
          className={styles.swatch}
          style={{ '--picker-label-color': labelColor(label) }}
          aria-hidden="true"
        />
        {addingCustom ? (
          <TextField
            ref={customRef}
            size="sm"
            label="New label name"
            className={styles.labelField}
            placeholder="Label name"
            value={customDraft}
            onChange={setCustomDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitCustom() }
              if (e.key === 'Escape') { setAddingCustom(false); setCustomDraft('') }
              e.stopPropagation()
            }}
            onBlur={commitCustom}
            maxLength={24}
            data-testid="picker-custom-label"
          />
        ) : (
          <Select
            key={labelSelectKey}
            size="sm"
            width={132}
            value={label}
            options={labelOptions}
            onChange={handleLabel}
            ariaLabel="Sample label"
            openSignal={labelPickerSignal}
            hint="Label for the sample being added"
            hintMods="1 to 9: pick a label"
            data-testid="picker-label"
          />
        )}
        <TextField
          size="sm"
          label="Sample name"
          className={styles.nameField}
          value={sampleName}
          onChange={onNameChange}
          onKeyDown={(e) => {
            // Typing belongs to the field; Enter adds, so a name can be typed and committed in one go.
            if (e.key === 'Enter') { e.preventDefault(); onAddSample() }
            e.stopPropagation()
          }}
          placeholder="Sample name"
          maxLength={48}
          invalid={!!error}
          hint="Name of the sample being added"
          hintMods="Enter: add"
          data-testid="picker-name"
        />
        <Button
          size="sm"
          variant="primary"
          glyph={<IcPlus aria-hidden="true" />}
          onClick={onAddSample}
          disabled={!canAdd}
          hint={canAdd ? 'Add the selection to the project as a sample' : 'Mark In and Out first'}
          hintMods="Enter"
          data-testid="picker-add"
        >
          Add sample
        </Button>
      </div>

      {error ? <div className={styles.error} role="alert">{error}</div> : null}
    </div>
  )
}
