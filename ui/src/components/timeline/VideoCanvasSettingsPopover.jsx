import { useCallback, useEffect, useRef, useState } from 'react'
import { Link2 } from 'lucide-react'
import { timelineEvents } from '../../timelineEvents.js'
import { XlethIconButton } from '../common/XlethButton.jsx'
import XlethSelect from '../common/XlethSelect.jsx'

// ── Project canvas presets ────────────────────────────────────────────────────
// Mirrors GridSettingsPanel.jsx's ASPECT_PRESETS/RESOLUTION_PRESETS exactly —
// this popover is a UI relocation of that panel's canvas controls, not a
// behavior change. 'custom' lets width/height define a free ratio.
const ASPECT_PRESETS = [
  { id: '16:9', label: '16:9', w: 16, h: 9  },
  { id: '9:16', label: '9:16', w: 9,  h: 16 },
  { id: '4:3',  label: '4:3',  w: 4,  h: 3  },
  { id: '1:1',  label: '1:1',  w: 1,  h: 1  },
  { id: '21:9', label: '21:9', w: 21, h: 9  },
  { id: 'custom', label: 'Custom', w: 0, h: 0 },
]

const RESOLUTION_PRESETS = {
  '16:9': [
    { label: '720p',  width: 1280, height: 720  },
    { label: '1080p', width: 1920, height: 1080 },
    { label: '1440p', width: 2560, height: 1440 },
    { label: '4K',    width: 3840, height: 2160 },
  ],
  '9:16': [
    { label: '720p',  width: 720,  height: 1280 },
    { label: '1080p', width: 1080, height: 1920 },
    { label: '1440p', width: 1440, height: 2560 },
    { label: '4K',    width: 2160, height: 3840 },
  ],
  '4:3': [
    { label: '480p',  width: 640,  height: 480  },
    { label: '768p',  width: 1024, height: 768  },
    { label: '1080p', width: 1440, height: 1080 },
    { label: '1536p', width: 2048, height: 1536 },
  ],
  '1:1': [
    { label: '720',   width: 720,  height: 720  },
    { label: '1080',  width: 1080, height: 1080 },
    { label: '1440',  width: 1440, height: 1440 },
    { label: '2160',  width: 2160, height: 2160 },
  ],
  '21:9': [
    { label: '1080p', width: 2560, height: 1080 },
    { label: '1440p', width: 3440, height: 1440 },
    { label: '4K',    width: 5120, height: 2160 },
  ],
}

const CANVAS_MIN = 16
const CANVAS_MAX_W = 7680
const CANVAS_MAX_H = 4320
const FPS_OPTIONS = [24, 30, 60, 120].map(fps => ({ value: fps, label: String(fps) }))

function normCanvasDim(v, max) {
  let n = Math.round(Number(v) || 0)
  if (n < CANVAS_MIN) n = CANVAS_MIN
  if (n > max) n = max
  if (n & 1) n -= 1
  return n
}

function aspectRatioValue(aspectId, w, h) {
  const p = ASPECT_PRESETS.find(a => a.id === aspectId)
  if (p && p.id !== 'custom' && p.w > 0 && p.h > 0) return p.w / p.h
  return (w > 0 && h > 0) ? w / h : 16 / 9
}

function resolutionIdForDims(aspectId, w, h) {
  const list = RESOLUTION_PRESETS[aspectId] || []
  const hit = list.find(r => r.width === w && r.height === h)
  return hit ? `${w}x${h}` : 'custom'
}

const notify = () => timelineEvents.dispatchEvent(new Event('timeline-grid-changed'))

export default function VideoCanvasSettingsPopover({ layout, setLayout, onClose, triggerRef }) {
  const [customSizeMode, setCustomSizeMode] = useState(false)
  const [dimsLocked, setDimsLocked] = useState(true)
  const popoverRef = useRef(null)

  useEffect(() => {
    function onMouseDown(e) {
      const pop = popoverRef.current
      const btn = triggerRef?.current
      if (pop && pop.contains(e.target)) return
      if (btn && btn.contains(e.target)) return
      if (e.target?.closest?.('.xleth-select-popup')) return
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

  const canvasW      = layout.canvasWidth  ?? 1920
  const canvasH      = layout.canvasHeight ?? 1080
  const canvasAspect = layout.canvasAspectRatio ?? '16:9'
  const resList      = RESOLUTION_PRESETS[canvasAspect] || []
  const resId        = resolutionIdForDims(canvasAspect, canvasW, canvasH)
  const showSizeInputs = customSizeMode || resId === 'custom'
  const previewFps = Number(layout.previewFps ?? 60)
  const fpsOptions = FPS_OPTIONS.some(option => Number(option.value) === previewFps)
    ? FPS_OPTIONS
    : [...FPS_OPTIONS, { value: previewFps, label: String(previewFps) }]

  const persistCanvas = useCallback(async (patch) => {
    const tl = window.xleth?.timeline
    const base = (await tl?.getGridLayout?.()) || layout
    const next = { ...base, ...patch }
    setLayout(next)
    console.log('[VideoCanvasSettings] persisting canvas patch:', patch)
    await tl?.setGridLayout(next)
    notify()
  }, [layout, setLayout])

  const handleAspectChange = useCallback((id) => {
    if (id === 'custom') {
      setCustomSizeMode(true)
      setDimsLocked(false)
      persistCanvas({ canvasAspectRatio: 'custom' })
      return
    }
    const list = RESOLUTION_PRESETS[id] || []
    const def  = list[1] || list[0]
    setCustomSizeMode(false)
    setDimsLocked(true)
    persistCanvas({
      canvasAspectRatio: id,
      canvasWidth:  def ? def.width  : canvasW,
      canvasHeight: def ? def.height : canvasH,
    })
  }, [persistCanvas, canvasW, canvasH])

  const handleResolutionChange = useCallback((value) => {
    if (value === 'custom') { setCustomSizeMode(true); return }
    const [w, h] = String(value).split('x').map(Number)
    if (!w || !h) return
    setCustomSizeMode(false)
    persistCanvas({ canvasWidth: w, canvasHeight: h })
  }, [persistCanvas])

  const handleCanvasDimChange = useCallback((which, raw) => {
    const max = which === 'w' ? CANVAS_MAX_W : CANVAS_MAX_H
    const v   = normCanvasDim(raw, max)
    if (dimsLocked) {
      const ratio = aspectRatioValue(canvasAspect, canvasW, canvasH)
      if (which === 'w') {
        persistCanvas({ canvasWidth: v, canvasHeight: normCanvasDim(v / ratio, CANVAS_MAX_H) })
      } else {
        persistCanvas({ canvasWidth: normCanvasDim(v * ratio, CANVAS_MAX_W), canvasHeight: v })
      }
    } else {
      const patch = which === 'w' ? { canvasWidth: v } : { canvasHeight: v }
      persistCanvas({ ...patch, canvasAspectRatio: 'custom' })
    }
  }, [dimsLocked, persistCanvas, canvasAspect, canvasW, canvasH])

  const handleToggleLock = useCallback(() => {
    setDimsLocked((locked) => {
      const next = !locked
      if (!next) persistCanvas({ canvasAspectRatio: 'custom' })
      return next
    })
  }, [persistCanvas])

  const handleFpsChange = useCallback(async (fps) => {
    const clamped = Math.max(1, Math.min(120, parseInt(fps) || 30))
    console.log(`[VideoCanvasSettings] fps changed to ${clamped}`)
    await window.xleth?.timeline?.setPreviewFps(clamped)
    notify()
  }, [])

  return (
    <div className="tl-display-popover" ref={popoverRef}>
      <div className="gsp-canvas-controls">
        <div className="gsp-canvas-row">
          <span className="gsp-canvas-label">Aspect</span>
          <XlethSelect
            className="gsp-canvas-select"
            value={canvasAspect}
            options={ASPECT_PRESETS.map(a => ({ value: a.id, label: a.label }))}
            onChange={handleAspectChange}
            ariaLabel="Project aspect ratio"
          />
        </div>

        <div className="gsp-canvas-row">
          <span className="gsp-canvas-label">Size</span>
          <XlethSelect
            className="gsp-canvas-select"
            value={showSizeInputs ? 'custom' : resId}
            options={[
              ...resList.map(r => ({ value: `${r.width}x${r.height}`, label: `${r.label} (${r.width}×${r.height})` })),
              { value: 'custom', label: 'Custom…' },
            ]}
            onChange={handleResolutionChange}
            ariaLabel="Project base resolution"
          />
        </div>

        {showSizeInputs && (
          <div className="gsp-canvas-row gsp-canvas-size">
            <input
              className="gsp-dim-input"
              type="number" min={CANVAS_MIN} max={CANVAS_MAX_W} step={2}
              value={canvasW}
              onChange={(e) => handleCanvasDimChange('w', e.target.value)}
            />
            <XlethIconButton
              type="button"
              className={`gsp-link-btn${dimsLocked ? ' active' : ''}`}
              active={dimsLocked}
              onClick={handleToggleLock}
              title={dimsLocked ? 'Aspect locked — width/height stay in ratio' : 'Aspect unlocked — free ratio'}
              aria-label={dimsLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
            >
              <Link2 aria-hidden="true" />
            </XlethIconButton>
            <input
              className="gsp-dim-input"
              type="number" min={CANVAS_MIN} max={CANVAS_MAX_H} step={2}
              value={canvasH}
              onChange={(e) => handleCanvasDimChange('h', e.target.value)}
            />
          </div>
        )}

        <div className="gsp-canvas-row">
          <span className="gsp-canvas-label">FPS</span>
          <XlethSelect
            className="gsp-canvas-select"
            value={previewFps}
            options={fpsOptions}
            onChange={handleFpsChange}
            ariaLabel="Project frame rate"
          />
        </div>
      </div>
    </div>
  )
}
