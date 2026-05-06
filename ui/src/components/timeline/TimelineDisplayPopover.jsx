import { useEffect, useRef } from 'react'

function SegmentGroup({ settingKey, options, value, onSet, disabled = false }) {
  return (
    <div className="tl-display-group">
      {options.map(({ label, val }) => (
        <button
          key={val}
          className={`tl-display-btn${value === val ? ' active' : ''}`}
          disabled={disabled}
          onClick={() => onSet(settingKey, val)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

const BODY_OPTIONS = [
  { label: 'Min', val: 'minimal' },
  { label: 'Plain', val: 'plain' },
  { label: 'Grad', val: 'gradient' },
  { label: 'Solid', val: 'solid' },
]

const GRADIENT_OPTIONS = [
  { label: 'Top', val: 'top' },
  { label: 'Bottom', val: 'bottom' },
]

const CONTRAST_OPTIONS = [
  { label: 'Low', val: 'low' },
  { label: 'Med', val: 'medium' },
  { label: 'High', val: 'high' },
]

const VISIBILITY_OPTIONS = [
  { label: 'Auto', val: 'auto' },
  { label: 'Always', val: 'always' },
  { label: 'Never', val: 'never' },
]

export default function TimelineDisplayPopover({ settings, onSet, onClose, triggerRef }) {
  const popoverRef = useRef(null)

  useEffect(() => {
    function onMouseDown(e) {
      const pop = popoverRef.current
      const btn = triggerRef?.current
      if (pop && pop.contains(e.target)) return
      if (btn && btn.contains(e.target)) return
      onClose()
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose, triggerRef])

  const gradientDisabled =
    settings.timelineClipBodyMode !== 'gradient' &&
    settings.timelinePatternBodyMode !== 'gradient'

  return (
    <div className="tl-display-popover" ref={popoverRef}>

      <div className="tl-display-section">
        <div className="tl-display-label">Clip body</div>
        <SegmentGroup
          settingKey="timelineClipBodyMode"
          options={BODY_OPTIONS}
          value={settings.timelineClipBodyMode}
          onSet={onSet}
        />
      </div>

      <div className="tl-display-section">
        <div className="tl-display-label">Pattern body</div>
        <SegmentGroup
          settingKey="timelinePatternBodyMode"
          options={BODY_OPTIONS}
          value={settings.timelinePatternBodyMode}
          onSet={onSet}
        />
      </div>

      <div className="tl-display-section">
        <div className="tl-display-label">Gradient</div>
        <SegmentGroup
          settingKey="timelineBodyGradientDirection"
          options={GRADIENT_OPTIONS}
          value={settings.timelineBodyGradientDirection}
          onSet={onSet}
          disabled={gradientDisabled}
        />
      </div>

      <div className="tl-display-section">
        <div className="tl-display-label">Contrast</div>
        <SegmentGroup
          settingKey="timelineClipContrast"
          options={CONTRAST_OPTIONS}
          value={settings.timelineClipContrast}
          onSet={onSet}
        />
      </div>

      <div className="tl-display-section">
        <div className="tl-display-label">Names</div>
        <SegmentGroup
          settingKey="timelineShowClipNames"
          options={VISIBILITY_OPTIONS}
          value={settings.timelineShowClipNames}
          onSet={onSet}
        />
      </div>

      <div className="tl-display-section">
        <div className="tl-display-label">Metadata</div>
        <SegmentGroup
          settingKey="timelineShowPitchShift"
          options={VISIBILITY_OPTIONS}
          value={settings.timelineShowPitchShift}
          onSet={onSet}
        />
      </div>

      <div className="tl-display-section">
        <div className="tl-display-label">Waveforms</div>
        <SegmentGroup
          settingKey="timelineShowWaveforms"
          options={VISIBILITY_OPTIONS}
          value={settings.timelineShowWaveforms}
          onSet={onSet}
        />
      </div>

      <div className="tl-display-section">
        <div className="tl-display-label">Pattern preview</div>
        <SegmentGroup
          settingKey="timelineShowPatternPreview"
          options={VISIBILITY_OPTIONS}
          value={settings.timelineShowPatternPreview}
          onSet={onSet}
        />
      </div>

    </div>
  )
}
