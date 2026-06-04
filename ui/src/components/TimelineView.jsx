import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { Layers, Plus } from 'lucide-react'
import TrackHeaderList from './timeline/TrackHeaderList.jsx'
import PatternListPanel from './timeline/PatternListPanel.jsx'
import TimelineCanvas from './timeline/TimelineCanvas.jsx'
import MacroAutomationLanes from './timeline/MacroAutomationLanes.jsx'
import { buildTrackLayout } from './timeline/timelineRowLayout.js'
import { tokenValue } from '../theming/tokenValue.ts'
import TimelineRuler from './timeline/TimelineRuler.jsx'
import TimelineScrollbar from './timeline/TimelineScrollbar.jsx'
import TimelineToolbar from './timeline/TimelineToolbar.jsx'
import ContextMenu from './ContextMenu.jsx'
import TrackContextMenu from './timeline/TrackContextMenu.jsx'
import FadeBezierEditor from './timeline/FadeBezierEditor.jsx'
import ConfirmConvertDialog from './timeline/ConfirmConvertDialog.jsx'
import QuantizeDialog from './timeline/QuantizeDialog.jsx'
import { buildQuantizeSpecs } from '../utils/quantize.js'
import useTimelineZoom from '../hooks/useTimelineZoom.js'
import useTimelineScroll from '../hooks/useTimelineScroll.js'
import { getGlobalStretchMethodLabel } from '../constants/globalStretchMethods.js'
import { labelHexColor } from '../constants/labels.js'
import { normalizeTrackCustomColor } from './timeline/trackColorResolver.js'
import { subscribe } from '../transportStore.js'
import { startMacroAutomationPlayback } from '../fxgraph/macroAutomationPlayback.js'
import { startEnvelopePlayback } from '../fxgraph/envelopePlayback.js'
import useEffectChainStore from '../stores/effectChainStore.js'
import { playheadClock } from '../services/PlayheadClock.js'
import { editCursor } from '../services/EditCursor.js'
import { timelineEvents } from '../timelineEvents.js'
import {
  BEATS_PER_BAR, TRACK_HEIGHT, PPQ,
  pixelToBeat, snapBeatToGrid, beatsToTicks, regionDurationToTicks, findFreePosition,
  GRANULARITY_BEATS,
} from '../constants/timeline.js'
import { getRegime } from '../utils/waveformRenderer.js'
import { getRegionPlaybackDurationSec } from './timeline/regionDuration.js'
import { getSelectableSyllables } from './SyllableSplitter/syllableModel.js'
import useSnapStore from '../stores/snapStore.js'
import useTimelineDisplayStore from '../stores/timelineDisplayStore.js'
import useUIStore from '../stores/uiStore.js'
import useTimelineFocusStore from '../stores/timelineFocusStore.js'
import usePianoRollStore from '../stores/usePianoRollStore.js'
import useMixerStore from '../stores/mixerStore.js'
import { useToast } from './Toast.jsx'
import { usePanelVisibility } from '../windowing/contexts/PanelVisibilityContext'
import { usePanelRegistry } from '../windowing/registry/PanelRegistry.ts'
import TrackFlipPropertiesPanel from './timeline/TrackFlipPropertiesPanel.jsx'
import { register as registerKeyboardBinding } from '../windowing/managers/KeyboardManager'

// Combos the timeline panel claims. Listed once at module scope so the
// useEffect that registers them stays empty-deps — handler reads fresh
// state through a ref, so re-registration on state changes is gone (the
// 14-dep churn that compounded Bug 1).
const TIMELINE_KEY_COMBOS = [
  // Undo / redo
  'Ctrl+z', 'Ctrl+Z', 'Meta+z', 'Meta+Z',
  'Ctrl+y', 'Ctrl+Y', 'Meta+y', 'Meta+Y',
  'Ctrl+Shift+z', 'Ctrl+Shift+Z', 'Meta+Shift+z', 'Meta+Shift+Z',
  // Select all
  'Ctrl+a', 'Ctrl+A', 'Meta+a', 'Meta+A',
  // Delete selected
  'Delete',
  // Copy / paste / duplicate
  'Ctrl+c', 'Ctrl+C', 'Meta+c', 'Meta+C',
  'Ctrl+v', 'Ctrl+V', 'Meta+v', 'Meta+V',
  'Ctrl+d', 'Ctrl+D', 'Meta+d', 'Meta+D',
  // Loop toggle
  'l', 'L',
  // Pitch shift (no-mod = ±1 semitone, Ctrl/Meta = ±1 cent)
  '+', '=', '-', '_',
  'Ctrl++', 'Ctrl+=', 'Ctrl+-', 'Ctrl+_',
  'Meta++', 'Meta+=', 'Meta+-', 'Meta+_',
  // Tools
  's', 'S', 'p', 'P', 'c', 'C', 'd', 'D',
  // Syllable pick
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
]

const VIBRATO_SYNC_DIVISIONS = [
  ['whole', 'Whole'], ['half', '1/2'], ['quarter', '1/4'], ['eighth', '1/8'],
  ['sixteenth', '1/16'], ['thirtySecond', '1/32'],
  ['quarterTriplet', '1/4T'], ['eighthTriplet', '1/8T'], ['sixteenthTriplet', '1/16T'],
  ['quarterDotted', '1/4D'], ['eighthDotted', '1/8D'], ['sixteenthDotted', '1/16D'],
]
const VIBRATO_SHAPES = [
  ['sine', 'Sine'], ['triangle', 'Triangle'],
  ['sawUp', 'Saw Up'], ['sawDown', 'Saw Down'], ['square', 'Square'],
]
const VIBRATO_DEFAULTS = {
  enabled: true,
  depthCents: 50,
  rateMode: 'freeHz',
  rateHz: 5.0,
  syncDivision: 'eighth',
  shape: 'sine',
  phaseResetOnClipStart: true,
  phaseOffset: 0,
}
const SCRATCH_EDGE_MODES = [
  ['clamp', 'Clamp'],
  ['silence', 'Silence'],
]
const SCRATCH_BABY_DEFAULT_COUNT = 2
const SCRATCH_BABY_DEFAULT_LENGTH_BEATS = 1
const SCRATCH_BABY_LENGTHS = [
  [0.25, '1/4 beat'],
  [0.5, '1/2 beat'],
  [1, '1 beat'],
  [2, '2 beats'],
]
const SCRATCH_PRESETS = [
  {
    key: 'normal',
    label: 'Normal',
    timeMode: 'clipPercent',
    curve: [
      { time: 0.0, rateMultiplier: 1.0, curve: 0.0 },
      { time: 1.0, rateMultiplier: 1.0, curve: 0.0 },
    ],
  },
  {
    key: 'stop',
    label: 'Stop',
    timeMode: 'clipSeconds',
    curve: [
      { time: 0.0, rateMultiplier: 1.0, curve: 0.0 },
      { time: 0.10, rateMultiplier: 0.0, curve: 0.0 },
    ],
  },
  {
    key: 'reverse',
    label: 'Reverse',
    timeMode: 'clipPercent',
    curve: [
      { time: 0.0, rateMultiplier: -1.0, curve: 0.0 },
      { time: 1.0, rateMultiplier: -1.0, curve: 0.0 },
    ],
  },
  {
    key: 'babyScratch',
    label: 'Baby Scratch',
    timeMode: 'beats',
    curve: generateBabyScratchCurve(SCRATCH_BABY_DEFAULT_COUNT, SCRATCH_BABY_DEFAULT_LENGTH_BEATS),
  },
  {
    key: 'tapeStop',
    label: 'Tape Stop',
    timeMode: 'clipSeconds',
    curve: [
      { time: 0.0, rateMultiplier: 1.0, curve: 0.0 },
      { time: 0.45, rateMultiplier: 0.0, curve: 0.0 },
    ],
  },
]
const SCRATCH_DEFAULTS = {
  enabled: false,
  timeMode: 'clipPercent',
  smoothingMs: 2,
  gainCompensationDb: 0,
  edgeMode: 'clamp',
  curve: SCRATCH_PRESETS[0].curve,
}

function clampScratchCount(value) {
  return Math.max(1, Math.min(8, Math.round(Number(value) || SCRATCH_BABY_DEFAULT_COUNT)))
}

function normalizeScratchLengthBeats(value) {
  const numeric = Number(value)
  return SCRATCH_BABY_LENGTHS.some(([length]) => scratchNumbersMatch(length, numeric))
    ? numeric
    : SCRATCH_BABY_DEFAULT_LENGTH_BEATS
}

function scratchNumbersMatch(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.0001
}

function generateBabyScratchCurve(count, lengthBeats) {
  const scratchCount = clampScratchCount(count)
  const length = normalizeScratchLengthBeats(lengthBeats)
  const curve = []
  const addPoint = (time, rateMultiplier) => {
    const last = curve[curve.length - 1]
    if (last && scratchNumbersMatch(last.time, time)) {
      last.rateMultiplier = rateMultiplier
      last.curve = 0.0
      return
    }
    curve.push({ time, rateMultiplier, curve: 0.0 })
  }

  for (let i = 0; i < scratchCount; i += 1) {
    const segment = length / scratchCount
    const start = i * segment
    const mid = start + segment * 0.5
    const end = start + segment
    addPoint(start, 1.0)
    addPoint(mid, -1.0)
    addPoint(end, 1.0)
  }
  return curve
}

function cloneScratchCurve(curve) {
  return (curve ?? []).map(point => ({
    time: point.time,
    rateMultiplier: point.rateMultiplier,
    curve: point.curve,
  }))
}

function scratchCurvesMatch(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((point, i) =>
    scratchNumbersMatch(point.time, b[i].time) &&
    scratchNumbersMatch(point.rateMultiplier, b[i].rateMultiplier) &&
    scratchNumbersMatch(point.curve, b[i].curve)
  )
}

function scratchTimeModeMatches(a, b) {
  return (a ?? SCRATCH_DEFAULTS.timeMode) === b
}

function inferBabyScratchSettings(scratch) {
  if (!scratchTimeModeMatches(scratch?.timeMode, 'beats')) return null
  for (const [lengthBeats, lengthLabel] of SCRATCH_BABY_LENGTHS) {
    for (let count = 1; count <= 8; count += 1) {
      if (scratchCurvesMatch(scratch?.curve, generateBabyScratchCurve(count, lengthBeats))) {
        return { count, lengthBeats, lengthLabel }
      }
    }
  }
  return null
}

function scratchPresetKeyForScratch(scratch) {
  if (inferBabyScratchSettings(scratch)) return 'babyScratch'
  return SCRATCH_PRESETS
    .filter(preset => preset.key !== 'babyScratch')
    .find(preset => scratchTimeModeMatches(scratch?.timeMode, preset.timeMode) && scratchCurvesMatch(scratch?.curve, preset.curve))
    ?.key ?? 'custom'
}

function scratchPresetPatch(presetKey, { scratchCount = SCRATCH_BABY_DEFAULT_COUNT, lengthBeats = SCRATCH_BABY_DEFAULT_LENGTH_BEATS } = {}) {
  const preset = SCRATCH_PRESETS.find(p => p.key === presetKey) ?? SCRATCH_PRESETS[0]
  const curve = preset.key === 'babyScratch'
    ? generateBabyScratchCurve(scratchCount, lengthBeats)
    : preset.curve
  return {
    enabled: true,
    timeMode: preset.timeMode,
    curve: cloneScratchCurve(curve),
  }
}

function scratchCurveSummary(scratch) {
  const babySettings = inferBabyScratchSettings(scratch)
  if (babySettings) return `Curve: ${babySettings.count} scratches / ${babySettings.lengthLabel}`

  const preset = SCRATCH_PRESETS
    .filter(p => p.key !== 'babyScratch')
    .find(p => scratchTimeModeMatches(scratch?.timeMode, p.timeMode) && scratchCurvesMatch(scratch?.curve, p.curve))
  if (preset?.timeMode === 'clipSeconds') {
    const endTime = preset.curve[preset.curve.length - 1]?.time ?? 0
    return `Curve: fixed ${Number(endTime).toFixed(2)}s`
  }
  if (preset?.timeMode === 'clipPercent') return 'Curve: full clip'
  return 'Curve: Custom'
}

function mergeClipModulationPatch(
  clip,
  { vibratoPatch = null, scratchPatch = null, videoPatch = null, forceEnabled = false } = {}
) {
  const existing = clip?.modulation ?? {}
  const existingVibrato = existing.vibrato ?? {}
  const existingScratch = existing.scratch ?? {}
  const existingVideo = existing.video ?? {}
  const nextVibrato = vibratoPatch ? { ...existingVibrato, ...vibratoPatch } : existingVibrato
  const nextScratch = scratchPatch ? { ...existingScratch, ...scratchPatch } : existingScratch
  const nextVideo   = videoPatch   ? { ...existingVideo,   ...videoPatch   } : existingVideo
  const merged = {
    ...existing,
    enabled: Boolean(nextVibrato.enabled || nextScratch.enabled),
  }

  if (vibratoPatch) merged.vibrato = nextVibrato
  if (scratchPatch) merged.scratch = nextScratch
  if (videoPatch)   merged.video   = nextVideo
  if (forceEnabled) merged.enabled = true

  return merged
}

function hasAudioModulationIntent(modulation) {
  if (!modulation) return false
  return Boolean(modulation.enabled && (modulation.vibrato?.enabled || modulation.scratch?.enabled))
}

function hasVideoCompanionIntent(modulation) {
  return Boolean(modulation?.video?.vibratoSwirlEnabled || modulation?.video?.scratchWaveEnabled)
}

function isClipModulationBypassed(clip) {
  // stretchRatio is supported (Phase F.1) — NOT a bypass condition.
  return Boolean(clip?.reversed) || Boolean(clip?.formantPreserve)
}

function getClipModulationStatus(clip) {
  const mod = clip?.modulation
  const audioActive = hasAudioModulationIntent(mod)
  const videoSaved = hasVideoCompanionIntent(mod)
  const anyIntent = audioActive || videoSaved

  if (anyIntent && isClipModulationBypassed(clip)) {
    const reasons = []
    if (clip.reversed) reasons.push('Reverse is enabled')
    if (clip.formantPreserve) reasons.push('Formant Preserve is enabled')
    return { kind: 'bypassed', label: `Bypassed: ${reasons.join(' and ')}` }
  }

  const swirlOrphan = Boolean(mod?.video?.vibratoSwirlEnabled && !mod?.vibrato?.enabled)
  const waveOrphan  = Boolean(mod?.video?.scratchWaveEnabled  && !mod?.scratch?.enabled)
  const orphanSuffix = swirlOrphan && waveOrphan
    ? 'Swirl waits for Vibrato; Wave waits for Scratch'
    : swirlOrphan ? 'Swirl waits for Vibrato'
    : waveOrphan  ? 'Wave waits for Scratch'
    : ''

  if (audioActive) {
    const parts = []
    if (mod.vibrato?.enabled) parts.push('Vibrato')
    if (mod.scratch?.enabled) parts.push('Scratch')
    const base = `Active: ${parts.join(' + ')}`
    return { kind: 'active', label: orphanSuffix ? `${base} · ${orphanSuffix}` : base }
  }

  if (orphanSuffix) {
    return { kind: 'saved', label: `Saved: ${orphanSuffix}` }
  }

  return { kind: 'off', label: 'Off' }
}

function isInteractiveFocusElement(element) {
  if (!element) return false
  if (element instanceof HTMLElement && element.isContentEditable) return true
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  )
}

function ClipSliderRow({ label, value, min, max, step, onCommit, onPreviewChange, formatValue }) {
  const [localVal, setLocalVal] = useState(value)
  const dragging = useRef(false)

  useEffect(() => {
    if (!dragging.current) setLocalVal(value)
  }, [value])

  return (
    <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 11, color: '#aaa', minWidth: 40 }}>{label}</span>
      <input
        type="range" min={min} max={max} step={step}
        value={localVal}
        onChange={(e) => {
          const next = Number(e.target.value)
          dragging.current = true
          setLocalVal(next)
          if (onPreviewChange) onPreviewChange(next)
        }}
        onPointerUp={(e) => {
          const v = Number(e.target.value)
          dragging.current = false
          Promise.resolve(onCommit(v))
          // Draft is cleared by the parent when committed values refresh,
          // not here — clearing on pointer-up causes a one-frame flicker.
        }}
        style={{ flex: 1, accentColor: 'var(--theme-border-focus)' }}
      />
      <span style={{ fontSize: 10, color: '#888', minWidth: 40, textAlign: 'right' }}>
        {formatValue(localVal)}
      </span>
    </div>
  )
}

// ── Static visual FX preview (Phase G.3) ─────────────────────────────────────
// Compact two-pane Original / Effect Preview rendered with Canvas 2D. Uses a
// representative max-intensity snapshot of the Swirl/Wave/Smear shader math so
// users can see what their settings will do before hitting play or render.
const CLIP_FX_PREVIEW_W = 128
const CLIP_FX_PREVIEW_H = 72
const CLIP_FX_TAU = 6.28318530717958647692
const CLIP_FX_VIBRATO_LFO = 1.0
const CLIP_FX_SCRATCH_INTENSITY = 1.0
// Mid-cycle phase keeps wave peaks visible across the full preview height.
const CLIP_FX_SCRATCH_PHASE_01 = 0.25
const CLIP_FX_SCRATCH_RATE_MULT = 1.0

function clipFxClamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

// Bilinear sample with clamp-to-edge from a flat RGBA Uint8ClampedArray.
function clipFxSample(src, w, h, u, v, out) {
  const fx = clipFxClamp(u, 0, 1) * (w - 1)
  const fy = clipFxClamp(v, 0, 1) * (h - 1)
  const x0 = Math.floor(fx), y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1)
  const tx = fx - x0, ty = fy - y0
  const i00 = (y0 * w + x0) * 4
  const i10 = (y0 * w + x1) * 4
  const i01 = (y1 * w + x0) * 4
  const i11 = (y1 * w + x1) * 4
  for (let c = 0; c < 4; c++) {
    const a = src[i00 + c] * (1 - tx) + src[i10 + c] * tx
    const b = src[i01 + c] * (1 - tx) + src[i11 + c] * tx
    out[c] = a * (1 - ty) + b * ty
  }
}

function ClipFxPreview({ thumbDataUrl, vfx, swirlOn, waveOn, disabledReason }) {
  const origCanvasRef = useRef(null)
  const fxCanvasRef = useRef(null)
  const srcImageDataRef = useRef(null) // ImageData for the loaded thumbnail
  const [loadFailed, setLoadFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const rafRef = useRef(0)

  // Reset failure state when thumbnail dataURL changes.
  useEffect(() => {
    setLoadFailed(false)
    setLoaded(false)
    srcImageDataRef.current = null
  }, [thumbDataUrl])

  // Load thumbnail into an offscreen canvas at preview resolution.
  useEffect(() => {
    if (!thumbDataUrl) return
    let cancelled = false
    const img = new window.Image()
    img.onload = () => {
      if (cancelled) return
      const off = document.createElement('canvas')
      off.width = CLIP_FX_PREVIEW_W
      off.height = CLIP_FX_PREVIEW_H
      const offCtx = off.getContext('2d')
      offCtx.drawImage(img, 0, 0, CLIP_FX_PREVIEW_W, CLIP_FX_PREVIEW_H)
      try {
        srcImageDataRef.current = offCtx.getImageData(
          0, 0, CLIP_FX_PREVIEW_W, CLIP_FX_PREVIEW_H,
        )
        setLoaded(true)
      } catch (e) {
        console.warn('[ClipFxPreview] getImageData failed', e)
        setLoadFailed(true)
      }
    }
    img.onerror = () => { if (!cancelled) setLoadFailed(true) }
    img.src = thumbDataUrl
    return () => { cancelled = true }
  }, [thumbDataUrl])

  // Schedule a single rAF redraw whenever inputs change.
  useEffect(() => {
    if (!loaded) return
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const src = srcImageDataRef.current
      if (!src) return
      const W = CLIP_FX_PREVIEW_W, H = CLIP_FX_PREVIEW_H

      // Original pane: blit unchanged.
      const origCtx = origCanvasRef.current?.getContext('2d')
      if (origCtx) origCtx.putImageData(src, 0, 0)

      // Effect pane: per-pixel CPU remap matching FX_VibratoSwirl /
      // FX_ScratchWaveSmear (sample-and-blend smear).
      const fxCtx = fxCanvasRef.current?.getContext('2d')
      if (!fxCtx) return
      const dst = fxCtx.createImageData(W, H)
      const dstData = dst.data
      const srcData = src.data

      const swirlAmt    = swirlOn ? Number(vfx.swirlAmount    ?? 0.25) : 0
      const swirlRadius = Math.max(Number(vfx.swirlRadius     ?? 0.45), 0.0001)
      const cx          = Number(vfx.swirlCenterX ?? 0.5)
      const cy          = Number(vfx.swirlCenterY ?? 0.5)
      const waveAmt     = waveOn ? Number(vfx.waveAmount      ?? 0.08) : 0
      const waveFreq    = Number(vfx.waveFrequency  ?? 8.0)
      const smearAmt    = waveOn ? Number(vfx.smearAmount     ?? 0.0) : 0
      const reverseW    = !!(vfx.reverseWaveWithScratch ?? true)

      const direction = (reverseW && CLIP_FX_SCRATCH_RATE_MULT < 0) ? -1 : 1
      const phase = CLIP_FX_SCRATCH_PHASE_01 * CLIP_FX_TAU
      const safeFreq = clipFxClamp(waveFreq, 0.25, 64.0)
      const smearOffset = clipFxClamp(
        smearAmt * 0.25 * direction * CLIP_FX_SCRATCH_INTENSITY,
        -0.25, 0.25,
      )
      const smearBlend = clipFxClamp(Math.abs(smearAmt), 0, 1) * CLIP_FX_SCRATCH_INTENSITY

      const baseTap = [0, 0, 0, 0]
      const lTap = [0, 0, 0, 0]
      const rTap = [0, 0, 0, 0]

      for (let py = 0; py < H; py++) {
        const v = py / (H - 1)
        for (let px = 0; px < W; px++) {
          const u = px / (W - 1)
          let uu = u, vv = v

          // ── Swirl ─────────────────────────────────────────────────────
          if (swirlOn) {
            const dx = uu - cx, dy = vv - cy
            const r = Math.sqrt(dx * dx + dy * dy)
            let f = 1 - r / swirlRadius
            if (f < 0) f = 0
            else if (f > 1) f = 1
            const falloff = f * f * (3 - 2 * f)
            let angle = swirlAmt * 3.0 * CLIP_FX_VIBRATO_LFO * falloff
            if (angle < -1.25) angle = -1.25
            else if (angle > 1.25) angle = 1.25
            const ca = Math.cos(angle), sa = Math.sin(angle)
            uu = cx + dx * ca - dy * sa
            vv = cy + dx * sa + dy * ca
          }

          // ── Wave + Smear (sample-and-blend) ───────────────────────────
          if (waveOn) {
            const wave = Math.sin(vv * safeFreq * CLIP_FX_TAU + phase)
            let waveOffset = wave * waveAmt * 1.5 * CLIP_FX_SCRATCH_INTENSITY * direction
            if (waveOffset < -0.35) waveOffset = -0.35
            else if (waveOffset > 0.35) waveOffset = 0.35
            const wuvX = uu + waveOffset
            clipFxSample(srcData, W, H, wuvX, vv, baseTap)
            if (smearBlend > 0 && smearOffset !== 0) {
              clipFxSample(srcData, W, H, wuvX - smearOffset, vv, lTap)
              clipFxSample(srcData, W, H, wuvX + smearOffset, vv, rTap)
              const inv = 1 - smearBlend
              const di = (py * W + px) * 4
              dstData[di    ] = baseTap[0] * inv + ((lTap[0] + rTap[0]) * 0.5) * smearBlend
              dstData[di + 1] = baseTap[1] * inv + ((lTap[1] + rTap[1]) * 0.5) * smearBlend
              dstData[di + 2] = baseTap[2] * inv + ((lTap[2] + rTap[2]) * 0.5) * smearBlend
              dstData[di + 3] = baseTap[3] * inv + ((lTap[3] + rTap[3]) * 0.5) * smearBlend
            } else {
              const di = (py * W + px) * 4
              dstData[di    ] = baseTap[0]
              dstData[di + 1] = baseTap[1]
              dstData[di + 2] = baseTap[2]
              dstData[di + 3] = baseTap[3]
            }
          } else {
            // Swirl-only path: sample once at remapped UV.
            clipFxSample(srcData, W, H, uu, vv, baseTap)
            const di = (py * W + px) * 4
            dstData[di    ] = baseTap[0]
            dstData[di + 1] = baseTap[1]
            dstData[di + 2] = baseTap[2]
            dstData[di + 3] = baseTap[3]
          }
        }
      }

      fxCtx.putImageData(dst, 0, 0)
    })
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    }
  }, [
    loaded, swirlOn, waveOn,
    vfx.swirlAmount, vfx.swirlRadius, vfx.swirlCenterX, vfx.swirlCenterY,
    vfx.waveAmount, vfx.waveFrequency, vfx.smearAmount, vfx.reverseWaveWithScratch,
  ])

  if (!swirlOn && !waveOn) return null

  const noteStyle = {
    padding: '6px 8px', fontSize: 10, color: '#888',
    fontStyle: 'italic',
  }

  if (disabledReason) {
    return <div style={noteStyle}>{disabledReason}</div>
  }
  if (loadFailed || (!thumbDataUrl)) {
    return <div style={noteStyle}>Preview unavailable for this clip.</div>
  }

  const labelStyle = {
    fontSize: 9, color: '#888', textTransform: 'uppercase',
    letterSpacing: 0.4, marginBottom: 2,
  }
  const paneStyle = {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
  }
  const canvasStyle = {
    width: CLIP_FX_PREVIEW_W, height: CLIP_FX_PREVIEW_H,
    border: '1px solid var(--theme-border-subtle, #444)',
    borderRadius: 3,
    background: '#111',
    imageRendering: 'pixelated',
  }

  return (
    <div style={{
      padding: '6px 8px',
      display: 'flex', gap: 8, alignItems: 'flex-start',
    }}>
      <div style={paneStyle}>
        <span style={labelStyle}>Original</span>
        <canvas
          ref={origCanvasRef}
          width={CLIP_FX_PREVIEW_W}
          height={CLIP_FX_PREVIEW_H}
          style={canvasStyle}
        />
      </div>
      <div style={paneStyle}>
        <span style={labelStyle}>Effect Preview</span>
        <canvas
          ref={fxCanvasRef}
          width={CLIP_FX_PREVIEW_W}
          height={CLIP_FX_PREVIEW_H}
          style={canvasStyle}
        />
      </div>
    </div>
  )
}

function clampFadePercent(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n >= 100) return 100
  return n
}

function legacyFadeTicksToPercent(ticks, durationTicks) {
  const t = Number(ticks)
  const d = Number(durationTicks)
  if (!Number.isFinite(t) || !Number.isFinite(d) || t <= 0 || d <= 0) return 0
  return clampFadePercent((t * 100) / d)
}

function normalizeFadePercents(fadeInPercent, fadeOutPercent) {
  let fadeIn = clampFadePercent(fadeInPercent)
  let fadeOut = clampFadePercent(fadeOutPercent)
  const total = fadeIn + fadeOut
  if (total > 100) {
    const scale = 100 / total
    fadeIn *= scale
    fadeOut *= scale
  }
  return { fadeInPercent: fadeIn, fadeOutPercent: fadeOut }
}

function clipFadePercent(clip, side) {
  const percentKey = side === 'in' ? 'fadeInPercent' : 'fadeOutPercent'
  const ticksKey = side === 'in' ? 'fadeInTicks' : 'fadeOutTicks'
  if (clip?.[percentKey] != null) return clampFadePercent(clip[percentKey])
  return legacyFadeTicksToPercent(clip?.[ticksKey], clip?.durationTicks)
}

function normalizeClipFadeFields(clip) {
  const fades = normalizeFadePercents(
    clipFadePercent(clip, 'in'),
    clipFadePercent(clip, 'out')
  )
  return { ...clip, ...fades }
}

export default function TimelineView({
  activeSampleId,
  currentPatternIdByTrack = {},
  setCurrentPatternIdByTrack = () => {},
  activeCenterTab = 'timeline',
}) {
  // ── Tool state ──────────────────────────────────────────────────────────────
  const [activeTool, setActiveTool] = useState('select')
  const [stickyNoteLength, setStickyNoteLength] = useState(240) // 1/16 = PPQ/4
  const snapGranularity = useSnapStore((s) => s.snapGranularity)
  const setSnapGranularity = useSnapStore((s) => s.setSnapGranularity)
  const timelineDisplaySettings = useTimelineDisplayStore((s) => s.timelineDisplaySettings)
  const focusedTrackId = useTimelineFocusStore((s) => s.focusedTrackId)
  const setFocusedTrackId = useTimelineFocusStore((s) => s.setFocusedTrackId)
  const timelineTrackHeaderWidth = useUIStore((s) => s.timelineTrackHeaderWidth)
  const setTimelineTrackHeaderWidth = useUIStore((s) => s.setTimelineTrackHeaderWidth)
  const focusedTrackIdRef = useRef(focusedTrackId)
  useEffect(() => { focusedTrackIdRef.current = focusedTrackId }, [focusedTrackId])
  const { showToast } = useToast()
  const { useOnVisibilityChange } = usePanelVisibility()

  // Keep arranger clip length in sync with snap granularity
  useEffect(() => {
    const beats = GRANULARITY_BEATS[snapGranularity] ?? GRANULARITY_BEATS['1/16']
    setStickyNoteLength(Math.round(beats * PPQ))
  }, [snapGranularity])

  const [patternListCollapsed, setPatternListCollapsed] = useState(false)
  const lastSplitUndoCountRef = useRef(0)
  const timelineFocusedRef = useRef(false)
  const timelineViewRef = useRef(null)

  // FXG.4-h: graphStates needed to render macro automation lane clips on the timeline.
  const graphStates = useEffectChainStore((s) => s.graphStates)

  // ── Track state ────────────────────────────────────────────────────────────
  const [tracks, setTracks] = useState([])

  // FXG.4-h-r1: derive the flattened timeline row model (track rows + macro
  // automation child-lane rows). Threaded into the canvas geometry, hit-testing,
  // the left header, and the macro lane layer so all four share one source of
  // truth for where each row sits. Recomputes only when tracks or graphStates
  // change — tracks with no lanes produce the original contiguous geometry.
  const trackLayout = useMemo(
    () => buildTrackLayout({ tracks, graphStates }),
    [tracks, graphStates],
  )

  const [contextMenu, setContextMenu] = useState(null)
  // Phase G.4: compact quick-FX popover anchored to a clip's on-canvas FX badge
  const [quickFxMenu, setQuickFxMenu] = useState(null)  // { clipId, x, y } | null
  const [audioModSectionOpen, setAudioModSectionOpen] = useState(true)
  const [videoModSectionOpen, setVideoModSectionOpen] = useState(false)
  const [trackMenu, setTrackMenu] = useState(null)         // { track, x, y }
  const [flipPanel, setFlipPanel] = useState(null)         // { track, anchorRect }
  const [confirmDialog, setConfirmDialog] = useState(null)  // { title, message, onConfirm }
  const [quantizeOpen, setQuantizeOpen] = useState(false)
  const nextTrackNum = useRef(1)
  const focusTimelinePanel = usePanelRegistry((s) => s.focusPanel)

  // ── Clip state ─────────────────────────────────────────────────────────────
  const [clips, setClips] = useState([])
  const [regions, setRegions] = useState({})        // { [id]: region }
  const [selectedClipIds, setSelectedClipIds] = useState(new Set())
  const clipsRef = useRef([])
  const clipboardRef = useRef(null)  // stores copied clip properties for paste
  const patternBlockClipboardRef = useRef(null)  // stores copied pattern block data for paste
  const pencilTemplateRef = useRef(null) // middle-click template for pencil tool
  const [pencilTemplate, setPencilTemplate] = useState(null)
  const dropPreviewRef = useRef(null)
  const loadedRegionAudioRef = useRef(new Set()) // track which regions have audio loaded
  const [sources, setSources] = useState({})     // { [id]: source }
  const waveformCacheRef = useRef({})             // { [regionId]: { peaks, stride, peakWidth } }
  const waveformLruRef = useRef([])               // LRU order: most-recent at end
  const WAVEFORM_CACHE_MAX = 128                  // max cached regions before eviction
  const hiResCacheRef = useRef({})                // { [regionId|"c"+clipId]: { peaks?, samples?, startSec, endSec, ... } }
  const hiResFetchTimer = useRef(null)            // debounce timer for hi-res fetches
  const regionSampleRates = useRef({})            // { [regionId]: sampleRate } — learned from getRegionPeaks
  const clipPeakCacheRef = useRef({})             // { [clipId]: { peaks, stride, peakWidth, pitchOffset, pitchOffsetCents, reversed, stretchRatio } }
  const clipPeakRetryRef = useRef({})             // { [clipId]: retryCount } — resets on param change or success

  // ── Pattern state ──────────────────────────────────────────────────────────
  const [patternBlocks, setPatternBlocks] = useState([])
  const [patterns, setPatterns] = useState({})        // { [id]: pattern }
  const [selectedBlockIds, setSelectedBlockIds] = useState(new Set())
  // EVC-R2 — live snapshot of the timeline data the Envelope modulation playback
  // controller reads to reconstruct per-track note/clip triggers. Updated each render so
  // the once-mounted controller (see useEffect below) always sees current data.
  const envelopeTriggerDataRef = useRef({ clips: [], patternBlocks: [], patterns: {} })
  envelopeTriggerDataRef.current = { clips: clipsRef.current, patternBlocks, patterns }

  // ── Transport state ────────────────────────────────────────────────────────
  const [isPlaying, setIsPlaying] = useState(false)
  const isPlayingRef = useRef(false)
  const playheadBeatRef = useRef(0)
  const bpmRef = useRef(140)

  // ── User-scroll guard (prevents ensureVisible from fighting manual scroll) ─
  const userScrollingRef = useRef(false)
  const scrollTimeoutRef = useRef(null)
  const markUserScrolling = useCallback(() => {
    userScrollingRef.current = true
    clearTimeout(scrollTimeoutRef.current)
    scrollTimeoutRef.current = setTimeout(() => {
      userScrollingRef.current = false
    }, 2000)
  }, [])

  // ── Zoom / Scroll ──────────────────────────────────────────────────────────
  const { pixelsPerBeat, pixelsPerBeatRef, applyZoom, zoomAtCursor } = useTimelineZoom()
  const { scrollOffset, scrollOffsetRef, applyScroll, scrollBy, scrollTo, ensureVisible, setMaxScroll } = useTimelineScroll()

  // ── Canvas refs ────────────────────────────────────────────────────────────
  const canvasRef = useRef(null)    // TimelineCanvas imperative handle
  const rulerRef = useRef(null)     // TimelineRuler imperative handle
  const [canvasWidth, setCanvasWidth] = useState(800)
  const canvasAreaRef = useRef(null)
  const scrollContainerRef = useRef(null)

  // ── Track-header column resize ─────────────────────────────────────────────
  const timelineBodyRef = useRef(null)
  const [headerDragLineX, setHeaderDragLineX] = useState(null)

  const handleHeaderResizeStart = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = timelineTrackHeaderWidth
    const bodyEl = timelineBodyRef.current

    if (bodyEl) {
      const bodyRect = bodyEl.getBoundingClientRect()
      setHeaderDragLineX(startX - bodyRect.left)
    }
    document.body.style.cursor = 'col-resize'

    const onMove = (moveE) => {
      if (!bodyEl) return
      const bodyRect = bodyEl.getBoundingClientRect()
      setHeaderDragLineX(moveE.clientX - bodyRect.left)
    }

    const onUp = (upE) => {
      const dx = upE.clientX - startX
      const newWidth = Math.max(120, Math.min(480, startWidth + dx))
      setTimelineTrackHeaderWidth(newWidth)
      setHeaderDragLineX(null)
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [timelineTrackHeaderWidth, setTimelineTrackHeaderWidth])

  const [declickMs, setDeclickMs] = useState(0.5)
  const [globalStretchMethod, setGlobalStretchMethod] = useState(1) // 1=PSOLA,2=Rubber,3=WSOLA,4=PhaseVocoder,5=WORLD
  const declickMountedRef = useRef(true)
  useEffect(() => {
    declickMountedRef.current = true
    window.xleth?.timeline?.getDeclickMs()
      .then(v => { if (declickMountedRef.current && v != null) setDeclickMs(v) })
      .catch(() => {})
    const refreshGlobalStretchMethod = () => {
      window.xleth?.timeline?.getGlobalStretchMethod()
        .then(m => { if (declickMountedRef.current && m != null) setGlobalStretchMethod(m) })
        .catch(() => {})
    }
    refreshGlobalStretchMethod()
    const offProjectLoaded = window.xleth?.onProjectLoaded?.(refreshGlobalStretchMethod)

    const onGlobalStretchMethodChanged = (event) => {
      const method = Number(event.detail?.method)
      if (method >= 1 && method <= 5) setGlobalStretchMethod(method)
    }
    window.addEventListener('xleth:globalStretchMethod-changed', onGlobalStretchMethodChanged)

    return () => {
      declickMountedRef.current = false
      offProjectLoaded?.()
      window.removeEventListener('xleth:globalStretchMethod-changed', onGlobalStretchMethodChanged)
    }
  }, [])
  const handleDeclick = useCallback((v) => {
    const clamped = Math.max(0, Math.min(5, v))
    setDeclickMs(clamped)
    window.xleth?.timeline?.setDeclickMs(clamped)
  }, [])

  // ── Pencil template (middle-click quick copy) ──────────────────────────────

  const updatePencilTemplate = useCallback((template) => {
    pencilTemplateRef.current = template
    setPencilTemplate(template)
    if (template) setStickyNoteLength(template.durationTicks)
  }, [])

  // ── Select syllable index for pencil drawing ───────────────────────────────
  // Creates/updates a pencil template that carries the syllable index so the
  // pencilTool picks it up when drawing new clips.
  const handleSelectSyllable = useCallback((syllableIndex) => {
    const existing = pencilTemplateRef.current
    if (existing) {
      updatePencilTemplate({ ...existing, syllableIndex })
      return
    }
    // No template yet — build one from the active sample
    if (activeSampleId == null) return
    const region = regions[activeSampleId]
    if (!region) return
    updatePencilTemplate({
      regionId:          region.id,
      regionOffsetTicks: 0,
      durationTicks:     stickyNoteLength,
      velocity:          1.0,
      pitchOffset:       0,
      syllableIndex,
      displayName:       region.name || '?',
      label:             region.label,
    })
  }, [activeSampleId, regions, stickyNoteLength, updatePencilTemplate])

  // Clear pencil template when user selects a different sample in Sample Selector
  useEffect(() => {
    if (activeSampleId != null && pencilTemplateRef.current != null) {
      updatePencilTemplate(null)
    }
  }, [activeSampleId, updatePencilTemplate])

  // ── Fetch tracks from engine ───────────────────────────────────────────────

  const fetchTracks = useCallback(async () => {
    try {
      const t = await window.xleth?.timeline?.getTracks()
      if (t) {
        setTracks(t)
        // Keep mixer in sync without an extra IPC round-trip
        useMixerStore.getState().syncFromTimeline(t)
        console.log(`[Timeline] Tracks loaded: ${t.length}`)
      }
    } catch { /* engine not ready */ }
  }, [])

  const fetchClips = useCallback(async () => {
    try {
      const c = await window.xleth?.timeline?.getClips()
      if (c) {
        const normalized = c.map(normalizeClipFadeFields)
        setClips(normalized)
        clipsRef.current = normalized
        console.log(`[TimelineClips] Clips loaded: ${normalized.length}`)
      }
    } catch { /* engine not ready */ }
  }, [])

  const fetchRegions = useCallback(async () => {
    try {
      const r = await window.xleth?.timeline?.getRegions()
      if (r) {
        const map = {}
        r.forEach((reg) => { map[reg.id] = reg })
        setRegions(map)
        console.log(`[TimelineClips] Regions loaded: ${r.length}`)
      }
    } catch { /* engine not ready */ }
  }, [])

  const fetchPatterns = useCallback(async () => {
    try {
      const list = await window.xleth?.timeline?.getAllPatterns()
      if (list) {
        const map = {}
        list.forEach((p) => { map[p.id] = p })
        setPatterns(map)
      }
    } catch { /* engine not ready */ }
  }, [])

  const fetchPatternBlocks = useCallback(async () => {
    try {
      const b = await window.xleth?.timeline?.getPatternBlocks()
      if (b) setPatternBlocks(b)
    } catch { /* engine not ready */ }
  }, [])

  const fetchSources = useCallback(async () => {
    try {
      const s = await window.xleth?.timeline?.getSources()
      if (s) {
        const map = {}
        s.forEach(src => { map[src.id] = src })
        setSources(map)
      }
    } catch { /* engine not ready */ }
  }, [])

  // ── Rebuild audio mappings for regions that don't have samples loaded yet ──
  const rebuildAudioMappings = useCallback(async (regionsMap, cancelled) => {
    const regionList = Object.values(regionsMap)
    const unloaded = regionList.filter(r => r.sourceId != null && !loadedRegionAudioRef.current.has(r.id))
    if (unloaded.length === 0) return

    // Fetch sources to get file paths
    let sources = []
    try {
      sources = await window.xleth?.timeline?.getSources() || []
    } catch { return }
    if (cancelled.current) return

    const sourceById = {}
    sources.forEach(s => { sourceById[s.id] = s })

    for (const region of unloaded) {
      if (cancelled.current) break
      const source = sourceById[region.sourceId]
      if (!source?.filePath || region.startTime == null || region.endTime == null) continue

      try {
        // Swap-aware: bridge loads swappedAudioPath if region.hasSwappedAudio,
        // else the original source range. It also calls mapRegionToSample.
        const sampleId = await window.xleth?.audio?.loadRegionAudio(region.id)
        if (cancelled.current) break
        if (sampleId != null && sampleId >= 0) {
          loadedRegionAudioRef.current.add(region.id)
          console.log(`[Timeline] Audio mapped: region=${region.id} → sample=${sampleId}${region.hasSwappedAudio ? ' (swapped)' : ''}`)
        }
      } catch (e) {
        console.warn(`[Timeline] Audio load failed for region ${region.id}:`, e.message)
      }
    }
  }, [])

  // ── Quantize apply (per-edge batch) ────────────────────────────────────────
  const handleQuantizeApply = useCallback(async ({ startAction, endAction }) => {
    const clipSel  = clipsRef.current.filter(c => selectedClipIds.has(c.id))
    const blockSel = patternBlocks.filter(b => selectedBlockIds.has(b.id))
    if (clipSel.length === 0 && blockSel.length === 0) {
      console.warn('[Quantize] nothing selected, closing dialog')
      setQuantizeOpen(false)
      return
    }
    const { specs, skipped } = buildQuantizeSpecs(
      clipSel, blockSel, startAction, endAction, snapGranularity
    )
    console.log(`[Quantize] start=${startAction} end=${endAction} snap=${snapGranularity} `
      + `→ ${specs.length} specs, ${skipped.length} skipped`)
    if (skipped.length > 0) {
      for (const s of skipped) console.log(`[Quantize] skip ${s.kind} id=${s.id}: ${s.reason}`)
    }
    if (specs.length === 0) {
      setQuantizeOpen(false)
      return
    }
    try {
      await window.xleth?.timeline?.quantizeClipsBatch(specs)
      await fetchClips()
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[Quantize] quantizeClipsBatch failed:', err)
    }
    setQuantizeOpen(false)
  }, [selectedClipIds, selectedBlockIds, patternBlocks, snapGranularity, fetchClips])

  useEffect(() => {
    fetchTracks()
    fetchClips()
    fetchRegions()
    fetchSources()
    fetchPatterns()
    fetchPatternBlocks()

    // Refresh regions/clips when samples are added/removed via SamplePicker
    const onRegionsChanged = () => { loadedRegionAudioRef.current.clear(); fetchTracks(); fetchRegions(); fetchSources() }
    const onClipsChanged = () => { fetchTracks(); fetchClips() }
    const onPatternsChanged = () => { fetchPatterns() }
    const onPatternBlocksChanged = () => { fetchPatternBlocks() }
    const onPatternChanged = () => { fetchPatterns() }
    const onRegionAudioLoaded = (e) => {
      if (e.detail?.regionId != null) loadedRegionAudioRef.current.add(e.detail.regionId)
    }
    timelineEvents.addEventListener('timeline-regions-changed', onRegionsChanged)
    timelineEvents.addEventListener('timeline-clips-changed', onClipsChanged)
    timelineEvents.addEventListener('timeline-region-audio-loaded', onRegionAudioLoaded)
    timelineEvents.addEventListener('timeline-patterns-changed', onPatternsChanged)
    timelineEvents.addEventListener('timeline-pattern-blocks-changed', onPatternBlocksChanged)
    timelineEvents.addEventListener('timeline-pattern-changed', onPatternChanged)
    return () => {
      timelineEvents.removeEventListener('timeline-regions-changed', onRegionsChanged)
      timelineEvents.removeEventListener('timeline-clips-changed', onClipsChanged)
      timelineEvents.removeEventListener('timeline-region-audio-loaded', onRegionAudioLoaded)
      timelineEvents.removeEventListener('timeline-patterns-changed', onPatternsChanged)
      timelineEvents.removeEventListener('timeline-pattern-blocks-changed', onPatternBlocksChanged)
      timelineEvents.removeEventListener('timeline-pattern-changed', onPatternChanged)
    }
  }, [fetchTracks, fetchClips, fetchRegions, fetchSources, fetchPatterns, fetchPatternBlocks])

  // ── Rebuild audio mappings when regions change (e.g. on project load) ──────
  useEffect(() => {
    const cancelled = { current: false }
    if (Object.keys(regions).length > 0) {
      rebuildAudioMappings(regions, cancelled)
    }
    return () => { cancelled.current = true }
  }, [regions, rebuildAudioMappings])

  // ── Sync track counter from existing track names on mount/re-entry ──────────
  useEffect(() => {
    if (tracks.length > 0) {
      const maxNum = tracks.reduce((max, t) => {
        const match = t.name.match(/^Track (\d+)$/)
        return match ? Math.max(max, parseInt(match[1])) : max
      }, 0)
      nextTrackNum.current = maxNum + 1
    }
  }, [tracks.length])

  // ── Maintain focusedTrackId invariant ──────────────────────────────────────
  // - Initialize to first track on project load
  // - Focus newly added track when list grew from empty
  // - Shift focus to previous track when focused track is deleted
  // - Drop to null when list becomes empty
  // Session-only: never serialized to project file.
  const prevTrackIdsRef = useRef([])
  useEffect(() => {
    const ids = tracks.map((t) => t.id)
    const prev = prevTrackIdsRef.current
    const current = focusedTrackIdRef.current

    if (ids.length === 0) {
      if (current !== null) setFocusedTrackId(null)
    } else if (current == null) {
      // Cold start, or recovering from empty list — focus first track
      setFocusedTrackId(ids[0])
    } else if (!ids.includes(current)) {
      // Focused track was removed — shift to previous in the prior order,
      // falling back forward, then to the first remaining track.
      const prevIdx = prev.indexOf(current)
      let next = null
      if (prevIdx > 0) {
        for (let i = prevIdx - 1; i >= 0; i--) {
          if (ids.includes(prev[i])) { next = prev[i]; break }
        }
      }
      if (next == null) {
        for (let i = prevIdx + 1; i < prev.length; i++) {
          if (ids.includes(prev[i])) { next = prev[i]; break }
        }
      }
      if (next == null) next = ids[0]
      setFocusedTrackId(next)
    }
    prevTrackIdsRef.current = ids
  }, [tracks, setFocusedTrackId])

  // ── Fetch waveform peaks for clip rendering (via WaveformMipmap) ─────────────
  useEffect(() => {
    if (Object.keys(regions).length === 0 || Object.keys(sources).length === 0) return

    let cancelled = false

    // LRU helpers
    function lruTouch(id) {
      const lru = waveformLruRef.current
      const idx = lru.indexOf(id)
      if (idx !== -1) lru.splice(idx, 1)
      lru.push(id)
    }
    function lruEvict() {
      const lru = waveformLruRef.current
      while (lru.length > WAVEFORM_CACHE_MAX) {
        const evictId = lru.shift()
        delete waveformCacheRef.current[evictId]
      }
    }

    async function fetchWaveforms() {
      const PEAKS_PER_SECOND = 200
      const MIN_PEAKS = 800
      const MAX_PEAKS = 16000

      for (const region of Object.values(regions)) {
        if (cancelled) break
        if (waveformCacheRef.current[region.id]) {
          lruTouch(region.id)
          continue
        }

        const source = sources[region.sourceId]
        if (!source?.filePath || region.startTime == null || region.endTime == null) continue

        try {
          // Swap-aware: extend fetch span past video range when swapped audio is longer.
          const durSec = getRegionPlaybackDurationSec(region)
          const peakWidth = Math.max(MIN_PEAKS, Math.min(MAX_PEAKS,
            Math.round(durSec * PEAKS_PER_SECOND)))

          // Use mipmap-backed N-API binding (replaces 8kHz FFmpeg pipeline)
          const data = await window.xleth?.waveform?.getRegionPeaks(
            region.id, 0, durSec, peakWidth, -1
          )
          if (cancelled) break

          if (data && data.ready && data.peaks?.length > 0) {
            // Store in cache format compatible with timelineDrawing.js
            // peaks is [min,max,rms, min,max,rms, ...] — 3 values per column
            waveformCacheRef.current[region.id] = { peaks: data.peaks, stride: 3, peakWidth }
            // Remember engine sample rate for spp computation
            if (data.sampleRate) regionSampleRates.current[region.id] = data.sampleRate
            lruTouch(region.id)
            lruEvict()
            canvasRef.current?.redrawContent('waveform')
          } else if (data && !data.ready) {
            // Mipmap still generating — retry after a short delay
            setTimeout(() => {
              if (!cancelled) {
                delete waveformCacheRef.current[region.id]
                fetchWaveforms()
              }
            }, 150)
            return  // stop iterating, will retry all pending
          }
        } catch (e) {
          console.warn(`[Timeline] Waveform fetch failed for region ${region.id}:`, e.message)
        }
      }
    }

    fetchWaveforms()
    return () => { cancelled = true }
  }, [regions, sources])

  // ── Fetch waveform peaks for processed clips (stretch/pitch/reverse) ─────────
  // Runs whenever clips change. Fetches from ClipRenderCache via waveform_getClipPeaks.
  // Invalidates stale entries when a clip's processing params have changed.
  useEffect(() => {
    if (clips.length === 0) return
    let cancelled = false

    async function fetchClipPeaks() {
      const PEAKS_PER_SECOND = 200
      const MIN_PEAKS = 800
      const MAX_PEAKS = 16000
      const bpm = bpmRef.current || 120

      for (const clip of clips) {
        if (cancelled) break

        const hasProcessing = (clip.pitchOffset ?? 0) !== 0
                           || (clip.pitchOffsetCents ?? 0) !== 0
                           || clip.reversed
                           || ((clip.stretchRatio ?? 1.0) !== 1.0)
        if (!hasProcessing) {
          // Clip no longer processed — evict stale clip-peak entry
          if (clipPeakCacheRef.current[clip.id]) {
            delete clipPeakCacheRef.current[clip.id]
            delete hiResCacheRef.current[`c${clip.id}`]
          }
          continue
        }

        // Invalidate cache if params have changed since last fetch
        const cached = clipPeakCacheRef.current[clip.id]
        if (cached) {
          if (cached.pitchOffset      === (clip.pitchOffset ?? 0) &&
              cached.pitchOffsetCents === (clip.pitchOffsetCents ?? 0) &&
              cached.reversed         === !!clip.reversed &&
              cached.stretchRatio     === (clip.stretchRatio ?? 1.0)) {
            continue  // still valid
          }
          // Params changed — evict and refetch, reset retry counter
          delete clipPeakCacheRef.current[clip.id]
          delete hiResCacheRef.current[`c${clip.id}`]
          clipPeakRetryRef.current[clip.id] = 0
        }

        const clipDurSec = (clip.durationTicks / PPQ) / (bpm / 60)
        if (clipDurSec <= 0) continue

        const peakWidth = Math.max(MIN_PEAKS, Math.min(MAX_PEAKS,
          Math.round(clipDurSec * PEAKS_PER_SECOND)))

        try {
          const data = await window.xleth?.waveform?.getClipPeaks(
            clip.id, 0, clipDurSec, peakWidth)
          if (cancelled) break

          if (data?.ready && data.peaks?.length > 0) {
            clipPeakCacheRef.current[clip.id] = {
              peaks: data.peaks, stride: 3, peakWidth,
              pitchOffset:      clip.pitchOffset ?? 0,
              pitchOffsetCents: clip.pitchOffsetCents ?? 0,
              reversed:         !!clip.reversed,
              stretchRatio:     clip.stretchRatio ?? 1.0,
            }
            canvasRef.current?.redrawContent('waveform')
          } else if (data && !data.ready) {
            // Cache miss — exponential backoff, max 4 retries (150→300→600→1200ms), then fall back
            const RETRY_DELAYS = [150, 300, 600, 1200]
            const retryCount = clipPeakRetryRef.current[clip.id] ?? 0
            if (retryCount < RETRY_DELAYS.length) {
              clipPeakRetryRef.current[clip.id] = retryCount + 1
              setTimeout(() => {
                if (!cancelled) {
                  delete clipPeakCacheRef.current[clip.id]
                  fetchClipPeaks()
                }
              }, RETRY_DELAYS[retryCount])
              return
            } else {
              // Max retries — fall back to raw region waveform and stop requesting
              console.warn(`[Timeline] Clip ${clip.id} cache not ready after ${RETRY_DELAYS.length} retries, falling back to region peaks`)
              clipPeakRetryRef.current[clip.id] = 0
              if (clip.regionId != null) {
                try {
                  const fallback = await window.xleth?.waveform?.getRegionPeaks(
                    clip.regionId, 0, clipDurSec, peakWidth, -1)
                  if (!cancelled && fallback?.ready && fallback.peaks?.length > 0) {
                    clipPeakCacheRef.current[clip.id] = {
                      peaks: fallback.peaks, stride: 3, peakWidth,
                      pitchOffset:      clip.pitchOffset ?? 0,
                      pitchOffsetCents: clip.pitchOffsetCents ?? 0,
                      reversed:         !!clip.reversed,
                      stretchRatio:     clip.stretchRatio ?? 1.0,
                    }
                    canvasRef.current?.redrawContent('waveform')
                  }
                } catch (fe) {
                  console.warn(`[Timeline] Fallback region peaks failed for clip ${clip.id}:`, fe.message)
                }
              }
            }
          }
        } catch (e) {
          console.warn(`[Timeline] Clip peak fetch failed for clip ${clip.id}:`, e.message)
        }
      }
    }

    fetchClipPeaks()
    return () => { cancelled = true }
  }, [clips])

  // ── Waveform cache invalidation (e.g. after swap/revert audio) ─────────────
  useEffect(() => {
    const handler = (e) => {
      const regionId = e.detail?.regionId
      if (regionId == null) return
      delete waveformCacheRef.current[regionId]
      delete hiResCacheRef.current[regionId]
      const lru = waveformLruRef.current
      const lruIdx = lru.indexOf(regionId)
      if (lruIdx !== -1) lru.splice(lruIdx, 1)
      // Drop the JS-side "already loaded" flag so rebuildAudioMappings re-runs
      // for this region and picks up the new swapped/original audio.
      loadedRegionAudioRef.current.delete(regionId)
      // Force waveform + audio remap effects to re-run by refetching regions.
      fetchRegions()
    }
    timelineEvents.addEventListener('timeline-waveform-invalidate', handler)
    return () => timelineEvents.removeEventListener('timeline-waveform-invalidate', handler)
  }, [fetchRegions])

  // ── Viewport-aware hi-res waveform fetch (for waveform-line & sample regimes) ─
  // Runs on scroll/zoom changes. Computes which clips are visible, determines the
  // zoom regime, and fetches viewport-appropriate data.  The visible time window
  // shrinks as zoom increases, keeping data volume bounded by viewport pixel width.
  useEffect(() => {
    // Gate: only relevant at zoom levels beyond envelope mode
    const ppb = pixelsPerBeatRef.current
    const bpm = bpmRef.current || 120
    const DEFAULT_SR = 48000
    const pixelsPerSecond = ppb * (bpm / 60)
    const spp = DEFAULT_SR / pixelsPerSecond
    const regime = getRegime(spp)

    if (regime === 'envelope') {
      // Clear any stale hi-res data when zoomed back out
      if (Object.keys(hiResCacheRef.current).length > 0) {
        hiResCacheRef.current = {}
      }
      return
    }

    // Debounce: only fetch after scroll/zoom settles (80ms)
    if (hiResFetchTimer.current) clearTimeout(hiResFetchTimer.current)
    hiResFetchTimer.current = setTimeout(async () => {
      const scroll = scrollOffsetRef.current
      const w = canvasWidth || 800

      for (const clip of clips) {
        const region = regions[clip.regionId]
        if (!region) continue
        // Swap-aware: extend draw span past video range when swapped audio is longer.
        const regionDurSec = getRegionPlaybackDurationSec(region)
        if (regionDurSec <= 0) continue

        const beatPos = clip.positionTicks / PPQ
        const beatDur = clip.durationTicks / PPQ
        const x = (beatPos - scroll) * ppb
        const clipW = beatDur * ppb

        // Skip off-screen clips
        if (x + clipW < 0 || x > w) continue

        // Visible pixel range (clip ∩ viewport)
        const visL = Math.max(0, x)
        const visR = Math.min(w, x + clipW)
        if (visR <= visL) continue

        const clipDurSec = (clip.durationTicks / PPQ) / (bpm / 60)
        const regionOffsetSec = ((clip.regionOffsetTicks ?? 0) / PPQ) / (bpm / 60)
        const secPerPx = clipDurSec / clipW
        const visStartSec = regionOffsetSec + (visL - x) * secPerPx
        const visEndSec   = regionOffsetSec + (visR - x) * secPerPx
        const visPxWidth  = Math.ceil(visR - visL)
        const sr = regionSampleRates.current[clip.regionId] || DEFAULT_SR

        const hasProcessing = (clip.pitchOffset ?? 0) !== 0
                           || (clip.pitchOffsetCents ?? 0) !== 0
                           || clip.reversed
                           || ((clip.stretchRatio ?? 1.0) !== 1.0)

        if (hasProcessing && regime !== 'sample') {
          // Processed clip: use clip-local time coords (0 = start of processed buffer).
          // Keyed by "c"+clipId so multiple clips on the same region don't collide.
          const clipLocalStart = (visL - x) * secPerPx   // 0..clipDurSec
          const clipLocalEnd   = (visR - x) * secPerPx
          const hiResKey = `c${clip.id}`
          const cachedClip = hiResCacheRef.current[hiResKey]
          if (cachedClip?.peaks &&
              cachedClip.startSec <= clipLocalStart + 0.001 &&
              cachedClip.endSec   >= clipLocalEnd   - 0.001) continue

          try {
            const data = await window.xleth?.waveform?.getClipPeaks(
              clip.id, clipLocalStart, clipLocalEnd, visPxWidth)
            if (data?.ready && data.peaks?.length > 0) {
              hiResCacheRef.current[hiResKey] = {
                peaks: data.peaks,
                stride: 3,
                startSec: clipLocalStart,
                endSec:   clipLocalEnd,
              }
            }
          } catch (e) {
            console.warn(`[Timeline] Hi-res clip peak fetch failed for clip ${clip.id}:`, e.message)
          }
          continue
        }

        // Unprocessed clip (or sample regime): use existing region-based logic.
        // Check if existing cache entry already covers this window
        const cached = hiResCacheRef.current[clip.regionId]
        if (cached && cached.startSec <= visStartSec + 0.001 && cached.endSec >= visEndSec - 0.001) {
          if (regime === 'sample' && cached.samples) continue
          if ((regime === 'trace' || regime === 'waveform') && cached.peaks) continue
        }

        try {
          if (regime === 'sample') {
            // Request raw samples for the visible window
            const startSample = Math.floor(visStartSec * sr)
            const endSample   = Math.ceil(visEndSec * sr)
            const data = await window.xleth?.waveform?.getRawSamples(
              clip.regionId, startSample, endSample, -1)
            if (data?.samples?.length > 0) {
              hiResCacheRef.current[clip.regionId] = {
                samples: data.samples,
                startSample,
                endSample,
                startSec: visStartSec,
                endSec: visEndSec,
                sampleRate: data.sampleRate || sr,
              }
            }
          } else {
            // Waveform mode: request hi-res peaks for the visible window
            const data = await window.xleth?.waveform?.getRegionPeaks(
              clip.regionId, visStartSec, visEndSec, visPxWidth, -1)
            if (data?.ready && data.peaks?.length > 0) {
              hiResCacheRef.current[clip.regionId] = {
                peaks: data.peaks,
                stride: 3,
                startSec: visStartSec,
                endSec: visEndSec,
                sampleRate: data.sampleRate || sr,
              }
            }
          }
        } catch (e) {
          console.warn(`[Timeline] Hi-res fetch failed for region ${clip.regionId}:`, e.message)
        }
      }
      // Trigger redraw with the new hi-res data
      canvasRef.current?.redrawContent('hires-waveform')
    }, 80)

    return () => {
      if (hiResFetchTimer.current) clearTimeout(hiResFetchTimer.current)
    }
  }, [pixelsPerBeat, scrollOffset, clips, regions, canvasWidth])

  // ── Transport polling (control state only — position comes from PlayheadClock)

  useEffect(() => subscribe((s) => {
    bpmRef.current = s.bpm

    if (s.isPlaying !== isPlayingRef.current) {
      isPlayingRef.current = s.isPlaying
      setIsPlaying(s.isPlaying)
      if (!s.isPlaying) {
        // Final position at engine-reported stopped position
        const stopBeat = s.positionMs * s.bpm / 60000
        playheadBeatRef.current = stopBeat
        editCursor.setPosition(stopBeat)
        canvasRef.current?.positionPlayhead(stopBeat)
        rulerRef.current?.redrawOverlay()
      }
    }
  }), [])

  // FXG.4-h — drive parent-attached macro automation lanes at control rate. The
  // controller subscribes to the same transport poller and evaluates each graph-mode
  // track's macro automation at the current tick, then drives the macro's connected
  // parameter edges. Mounted once for the app session; no audio-thread work.
  useEffect(() => startMacroAutomationPlayback(), [])

  // EVC-R2 — drive Envelope-to-parameter modulation at control rate. Reuses the same
  // transport poller as macro automation; while playing it reconstructs each graph-mode
  // track's note/clip triggers from the live timeline snapshot and drives each Envelope
  // node's ADSR output through its connected parameter edges. Mounted once; on stop it
  // flushes connected parameters to 0. No audio-thread work, no graphState mutation.
  useEffect(() => startEnvelopePlayback({ getTriggerData: () => envelopeTriggerDataRef.current }), [])

  // ── PlayheadClock 60fps auto-scroll ─────────────────────────────────────────
  // Playhead drawing is handled by TimelineCanvas and TimelineRuler directly.

  // During playback, editCursor follows the playback position (10fps, no re-renders).
  // When stopped, editCursor is authoritative and won't be overwritten.
  useEffect(() => {
    return playheadClock.onDisplayUpdate((posMs, bpm) => {
      if (!isPlayingRef.current) return
      editCursor.setPosition((posMs / 1000) * (bpm / 60))
    })
  }, [])

  useEffect(() => {
    const unsub = playheadClock.onFrame((posMs) => {
      playheadBeatRef.current = posMs * bpmRef.current / 60000

      // Auto-scroll only during playback and only when user isn't manually scrolling
      if (!isPlayingRef.current || userScrollingRef.current) return
      const el = canvasAreaRef.current
      if (el) {
        const w = el.getBoundingClientRect().width
        ensureVisible(playheadBeatRef.current, w, pixelsPerBeatRef.current)
      }
    })
    return unsub
  }, [ensureVisible])

  useEffect(() => {
    function handleThemeChange() {
      canvasRef.current?.redrawGrid('theme')
      canvasRef.current?.redrawContent('theme')
      rulerRef.current?.redraw()
    }
    window.addEventListener('xleth-theme-changed', handleThemeChange)
    return () => window.removeEventListener('xleth-theme-changed', handleThemeChange)
  }, [])

  // ── Redraw grid/ruler when zoom or scroll changes (via state) ──────────────

  useEffect(() => {
    canvasRef.current?.redrawGrid('zoom')
    canvasRef.current?.redrawContent('zoom')
    rulerRef.current?.redraw()
    canvasRef.current?.positionPlayhead(playheadBeatRef.current)
    rulerRef.current?.redrawOverlay()

    const barsVisible = (canvasAreaRef.current?.getBoundingClientRect().width || 800) / pixelsPerBeat / BEATS_PER_BAR
    console.log(`[Timeline] Zoom: ${pixelsPerBeat.toFixed(1)}px/beat, ~${barsVisible.toFixed(1)} bars visible`)
  }, [pixelsPerBeat])

  useEffect(() => {
    canvasRef.current?.redrawGrid('scroll')
    canvasRef.current?.redrawContent('scroll')
    rulerRef.current?.redraw()
    canvasRef.current?.positionPlayhead(playheadBeatRef.current)
    rulerRef.current?.redrawOverlay()
  }, [scrollOffset])

  // ── Redraw content layer when clips/regions/selection change ───────────────

  useEffect(() => {
    canvasRef.current?.redrawContent('clips')
  }, [clips, regions, tracks])

  // Grid needs a redraw when tracks/regions change because Pattern-track rows
  // get a tint based on the assigned region's label color.
  useEffect(() => {
    canvasRef.current?.redrawGrid('tracks-or-regions')
  }, [tracks, regions])

  useEffect(() => {
    canvasRef.current?.redrawContent('pattern-blocks')
  }, [patternBlocks, patterns])

  useEffect(() => {
    canvasRef.current?.redrawContent('selection')
  }, [selectedClipIds, selectedBlockIds])

  useEffect(() => {
    canvasRef.current?.redrawContent('display-settings')
  }, [timelineDisplaySettings])

  // ── Total song length (independent of container width) ────────────────────
  // Derived from the longest clip/pattern-block end + 64 bars of padding,
  // floored at 512 bars. This decouples horizontal scroll range from layout.
  const totalBeats = useMemo(() => {
    const minBeats = 512 * BEATS_PER_BAR // 2048 beats (512 bars)
    const padBeats = 64 * BEATS_PER_BAR  // 64 bars trailing room
    let maxEndBeat = 0
    for (const c of clips) {
      const end = (c.positionTicks + c.durationTicks) / PPQ
      if (end > maxEndBeat) maxEndBeat = end
    }
    for (const b of patternBlocks) {
      const end = (b.positionTicks + b.durationTicks) / PPQ
      if (end > maxEndBeat) maxEndBeat = end
    }
    return Math.max(minBeats, maxEndBeat + padBeats)
  }, [clips, patternBlocks])

  // ── Max scroll: total length minus the currently visible window ──────────
  useEffect(() => {
    const visibleBeats = canvasWidth / (pixelsPerBeat || 40)
    setMaxScroll(Math.max(0, totalBeats - visibleBeats))
  }, [totalBeats, canvasWidth, pixelsPerBeat, setMaxScroll])

  // ── Track canvas area width for scrollbar ──────────────────────────────────

  useEffect(() => {
    const el = canvasAreaRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width)
      if (w > 0) setCanvasWidth(w)
    })
    setCanvasWidth(el.clientWidth || 800)
    observer.observe(el)
    return () => observer.disconnect()
  }, [tracks.length > 0])

  useOnVisibilityChange((isVisible) => {
    if (!isVisible) return
    // Re-show kick: display:none leaves ResizeObserver flaky and
    // canvas dimensions stale. Read clientWidth synchronously
    // and force imperative redraws at the now-correct layout.
    const el = canvasAreaRef.current
    if (el) {
      const w = el.clientWidth || 800
      if (w > 0) setCanvasWidth(w)
    }
    canvasRef.current?.redrawGrid('visibility')
    canvasRef.current?.redrawContent('visibility')
    rulerRef.current?.redraw()
    canvasRef.current?.positionPlayhead(playheadBeatRef.current)
  })

  // ── Wheel handler (shared between ruler and canvas) ────────────────────────

  // Wheel on canvas/ruler:
  //   Ctrl+wheel  = zoom (cursor-centered)
  //   Shift+wheel = horizontal scroll
  //   plain wheel = vertical track scroll
  const handleWheel = useCallback((e) => {
    if (e.ctrlKey) {
      e.preventDefault()
      markUserScrolling()
      const rect = canvasAreaRef.current?.getBoundingClientRect()
      if (!rect) return
      const cursorBeat = pixelToBeat(
        e.clientX - rect.left,
        scrollOffsetRef.current,
        pixelsPerBeatRef.current
      )
      zoomAtCursor(e.deltaY, cursorBeat, scrollOffsetRef, applyScroll)
      return
    }
    if (e.shiftKey || e.deltaX !== 0) {
      e.preventDefault()
      markUserScrolling()
      const dy = e.shiftKey ? e.deltaY : 0
      const delta = ((dy + e.deltaX) / (pixelsPerBeatRef.current || 40)) * 0.8
      scrollBy(delta)
      return
    }
    // Plain wheel → vertical scroll on the canvas-scroll wrapper
    const sc = scrollContainerRef.current
    if (sc && sc.scrollHeight > sc.clientHeight) {
      e.preventDefault()
      sc.scrollTop += e.deltaY
    }
  }, [zoomAtCursor, scrollOffsetRef, applyScroll, scrollBy, markUserScrolling])

  // ── Track mutations ────────────────────────────────────────────────────────

  const handleAddTrack = useCallback(async () => {
    const num = nextTrackNum.current++
    const name = `Track ${num}`
    console.log(`[Timeline] Track added: ${name}`)
    if (window.xleth?.timeline?.addTrack) {
      try {
        await window.xleth.timeline.addTrack({ name })
        await fetchTracks()
        return
      } catch { /* fall through to local */ }
    }
    // Offline / no-engine fallback — add locally
    setTracks((prev) => [
      ...prev,
      { id: Date.now(), name, type: 'Audio', volume: 1, pan: 0, muted: false, solo: false, visualOnly: false },
    ])
  }, [fetchTracks])

  const handleMute = useCallback(async (id) => {
    const current = tracks.find((t) => t.id === id)
    if (!current) return
    const next = !current.muted
    if (window.xleth?.timeline?.setTrackMuted) {
      try {
        await window.xleth.timeline.setTrackMuted(id, next)
        await fetchTracks()
        return
      } catch { /* fall through */ }
    }
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, muted: next } : t))
    )
  }, [tracks, fetchTracks])

  const handleSolo = useCallback(async (id) => {
    const current = tracks.find((t) => t.id === id)
    if (!current) return
    const next = !current.solo
    if (window.xleth?.timeline?.setTrackSolo) {
      try {
        await window.xleth.timeline.setTrackSolo(id, next)
        await fetchTracks()
        return
      } catch { /* fall through */ }
    }
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, solo: next } : t))
    )
  }, [tracks, fetchTracks])

  const handleVisualOnly = useCallback(async (id) => {
    const current = tracks.find((t) => t.id === id)
    if (!current) return
    const next = !current.visualOnly
    if (window.xleth?.timeline?.setTrackVisualOnly) {
      try {
        await window.xleth.timeline.setTrackVisualOnly(id, next)
        await fetchTracks()
        return
      } catch { /* fall through */ }
    }
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, visualOnly: next } : t))
    )
  }, [tracks, fetchTracks])

  // Pass 6D + 6F — centralized track color assignment. Sanitizes input
  // UI-side, then delegates to the engine command (undo/redo-safe). With no
  // engine available, mutates local state so dev fixtures and standalone
  // harnesses can exercise the resolver. Pass 6E added the Auto/paletteSlot
  // picker; Pass 6F adds the custom-hex code path (no UI yet — exposed in 6G).
  const handleSetTrackColor = useCallback(async (id, assignment) => {
    const rawMode = assignment?.mode
    let mode = 'auto'
    let slot = 0
    let customColor = ''

    if (rawMode === 'paletteSlot') {
      const n = typeof assignment?.slot === 'number' ? Math.trunc(assignment.slot) : NaN
      if (Number.isFinite(n) && n >= 1 && n <= 16) { mode = 'paletteSlot'; slot = n }
    } else if (rawMode === 'custom') {
      const normalized = normalizeTrackCustomColor(assignment?.customColor)
      if (normalized) { mode = 'custom'; customColor = normalized }
    }

    let sanitized
    if (mode === 'paletteSlot')      sanitized = { mode: 'paletteSlot', slot }
    else if (mode === 'custom')      sanitized = { mode: 'custom', customColor }
    else                              sanitized = { mode: 'auto' }

    if (window.xleth?.timeline?.setTrackColor) {
      try {
        await window.xleth.timeline.setTrackColor(id, sanitized)
        await fetchTracks()
        return
      } catch (e) {
        console.warn('[Timeline] setTrackColor failed', e)
      }
    }
    setTracks((prev) => prev.map((t) => {
      if (t.id !== id) return t
      if (sanitized.mode === 'paletteSlot') {
        const { trackColorCustom: _c, ...rest } = t
        return { ...rest, trackColorMode: 'paletteSlot', trackColorSlot: sanitized.slot }
      }
      if (sanitized.mode === 'custom') {
        const { trackColorSlot: _s, ...rest } = t
        return { ...rest, trackColorMode: 'custom', trackColorCustom: sanitized.customColor }
      }
      const { trackColorSlot: _s, trackColorCustom: _c, ...rest } = t
      return { ...rest, trackColorMode: 'auto' }
    }))
  }, [fetchTracks])

  const handleRename = useCallback(async (id, name) => {
    // Persist to engine first so undo/redo and project save see the change.
    if (window.xleth?.timeline?.setTrackName) {
      try {
        await window.xleth.timeline.setTrackName(id, name)
      } catch (e) {
        console.warn('[Timeline] setTrackName failed', e)
      }
    }
    setTracks((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, name } : t))
      useMixerStore.getState().syncFromTimeline(next)
      return next
    })
    console.log(`[Timeline] Track ${id} renamed to "${name}"`)
  }, [])

  const handlePatternRename = useCallback(async (id, name) => {
    if (window.xleth?.timeline?.setPatternName) {
      try {
        await window.xleth.timeline.setPatternName(id, name)
      } catch (e) {
        console.warn('[Timeline] setPatternName failed', e)
      }
    }
    setPatterns((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], name } } : prev))
    // Notify other views (App.jsx keeps its own pattern cache for the Piano
    // Roll title/dropdown).
    timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
    console.log(`[Timeline] Pattern ${id} renamed to "${name}"`)
  }, [])

  const handleRemove = useCallback(async (id) => {
    console.log(`[Timeline] Track ${id} removed`)
    if (window.xleth?.timeline?.removeTrack) {
      try {
        await window.xleth.timeline.removeTrack(id)
        await fetchTracks()
        return
      } catch { /* fall through */ }
    }
    setTracks((prev) => prev.filter((t) => t.id !== id))
  }, [fetchTracks])

  const handleReorder = useCallback((fromIndex, toIndex) => {
    setTracks((prev) => {
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      // Reorder is local-only (not persisted to engine), so sync mixer directly
      useMixerStore.getState().syncFromTimeline(next)
      return next
    })
  }, [])

  // ── Pattern-track conversion helpers ───────────────────────────────────────

  // Auto-generate the next unique pattern name (flat global numbering —
  // pattern tracks are sample-agnostic, so names are scoped to the project).
  // The regionId argument is retained for call-site symmetry but unused.
  const nextPatternName = useCallback((_regionId) => {
    const used = new Set(Object.values(patterns).map(p => p.name))
    let n = 1
    while (used.has(`Pattern ${n}`)) n++
    return `Pattern ${n}`
  }, [patterns])

  // Core: convert a Clip track → Pattern track (sample-agnostic container).
  // Deletes existing clips, then flips the track type. Caller is responsible
  // for the confirmation UI when the track has clips.
  const performConvertToPatternTrack = useCallback(async (trackId) => {
    try {
      // Delete existing clips on that track
      const existing = clipsRef.current.filter(c => c.trackId === trackId)
      for (const c of existing) {
        await window.xleth?.timeline?.removeClip(c.id)
      }
      // Convert track (no region binding — pattern tracks are sample-agnostic)
      await window.xleth?.timeline?.convertToPatternTrack(trackId)
      console.log(`[Timeline] Converted track ${trackId} → Pattern`)
      // Notify all listeners
      await fetchTracks()
      await fetchClips()
      timelineEvents.dispatchEvent(new Event('timeline-clips-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      return true
    } catch (err) {
      console.error('[Timeline] convertToPatternTrack failed:', err)
      return false
    }
  }, [fetchTracks, fetchClips])

  // Wrap convert with a confirmation dialog when the track has clips
  const confirmAndConvertToPatternTrack = useCallback((track) => {
    return new Promise((resolve) => {
      const clipCount = clipsRef.current.filter(c => c.trackId === track.id).length
      if (clipCount === 0) {
        performConvertToPatternTrack(track.id).then((ok) => resolve(ok))
        return
      }
      setConfirmDialog({
        title: 'Convert to Pattern Track?',
        message: (
          <>
            Convert <strong>"{track.name}"</strong> to a Pattern Track?
            <br />
            This will delete <strong>{clipCount} clip{clipCount !== 1 ? 's' : ''}</strong> on this track.
          </>
        ),
        confirmLabel: 'Convert',
        onConfirm: async () => {
          setConfirmDialog(null)
          const ok = await performConvertToPatternTrack(track.id)
          resolve(ok)
        },
        onCancel: () => { setConfirmDialog(null); resolve(false) },
      })
    })
  }, [performConvertToPatternTrack])

  const handleConvertToClipTrack = useCallback(async (trackId) => {
    try {
      await window.xleth?.timeline?.convertToClipTrack(trackId)
      console.log(`[Timeline] Converted track ${trackId} → Clip`)
      setCurrentPatternIdByTrack(prev => {
        const next = { ...prev }
        delete next[trackId]
        return next
      })
      await fetchTracks()
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
    } catch (err) {
      console.error('[Timeline] convertToClipTrack failed:', err)
    }
  }, [setCurrentPatternIdByTrack, fetchTracks])

  const handleNewPatternForTrack = useCallback(async (trackId) => {
    const track = tracks.find(t => t.id === trackId)
    if (!track || track.type !== 'Pattern') return
    // Seed the new pattern's regionId:
    // 1) the sample highlighted in the Sample Selector, or
    // 2) the track's currently-active pattern, or
    // 3) the first Pitch region.
    let seedRegionId = -1
    if (activeSampleId != null && regions[activeSampleId]) {
      seedRegionId = activeSampleId
    }
    if (seedRegionId < 0) {
      const currentPatId = currentPatternIdByTrack?.[trackId]
      if (currentPatId != null && currentPatId >= 0) {
        seedRegionId = patterns[currentPatId]?.regionId ?? -1
      }
    }
    if (seedRegionId < 0) {
      const firstPitch = Object.values(regions).find(r => r.label === 'Pitch')
      if (firstPitch) seedRegionId = firstPitch.id
    }
    if (seedRegionId < 0) {
      console.warn('[Timeline] No Pitch region available — cannot create new pattern')
      return
    }
    const name = nextPatternName(seedRegionId)
    try {
      const patternId = await window.xleth?.timeline?.addPattern({
        name,
        regionId: seedRegionId,
        lengthTicks: PPQ * 4,
      })
      if (patternId != null && patternId >= 0) {
        setCurrentPatternIdByTrack(prev => ({ ...prev, [trackId]: patternId }))
      }
      await fetchPatterns()
      timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
      console.log(`[Timeline] New pattern "${name}" (id=${patternId}) created for track ${trackId}`)
    } catch (err) {
      console.error('[Timeline] addPattern failed:', err)
    }
  }, [tracks, patterns, regions, currentPatternIdByTrack, nextPatternName, setCurrentPatternIdByTrack, fetchPatterns, activeSampleId])

  const handleSelectPatternForTrack = useCallback((trackId, patternId) => {
    setCurrentPatternIdByTrack(prev => ({ ...prev, [trackId]: patternId }))
    console.log(`[Timeline] Track ${trackId} current pattern → ${patternId}`)
  }, [setCurrentPatternIdByTrack])

  // Phase 5: every flip-config edit goes through this single commit path.
  // The popover (TrackFlipPropertiesPanel) buffers in-flight edits locally
  // and only calls this on atomic actions (toggle, reorder mouseup, modifier
  // change, stepper change). One IPC per commit — no per-tick round-trips.
  const handleSetVideoFlipConfig = useCallback(async (trackId, config) => {
    try {
      await window.xleth?.timeline?.setVideoFlipConfig(trackId, config)
      await fetchTracks()
    } catch (err) {
      console.error('[Timeline] setVideoFlipConfig failed:', err)
    }
  }, [fetchTracks])

  const handleSetVideoHoldLastFrame = useCallback(async (trackId, hold) => {
    try {
      await window.xleth?.timeline?.setVideoHoldLastFrame(trackId, hold)
      await fetchTracks()
      console.log(`[Timeline] Track ${trackId} videoHoldLastFrame → ${hold}`)
    } catch (err) {
      console.error('[Timeline] setVideoHoldLastFrame failed:', err)
    }
  }, [fetchTracks])

  const handleRequestTrackContextMenu = useCallback((track, x, y) => {
    setTrackMenu({ track, x, y })
  }, [])

  const buildTrackMenuItems = useCallback((track) => {
    if (!track) return []
    const items = []

    if (track.type === 'Pattern') {
      const allPatterns = Object.values(patterns).sort((a, b) => a.id - b.id)
      const currentPatId = currentPatternIdByTrack?.[track.id]
      items.push({
        label: 'New Pattern',
        onClick: () => handleNewPatternForTrack(track.id),
      })
      items.push({
        label: 'Select Pattern',
        disabled: allPatterns.length === 0,
        submenu: allPatterns.map(p => ({
          label: p.name || `Pattern ${p.id}`,
          checked: p.id === currentPatId,
          onClick: () => handleSelectPatternForTrack(track.id, p.id),
        })),
      })
      items.push({ type: 'separator' })
      items.push({
        label: 'Convert to Clip Track',
        onClick: () => handleConvertToClipTrack(track.id),
      })
    } else {
      // Clip track → convert to sample-agnostic Pattern track
      items.push({
        label: 'Convert to Pattern Track',
        onClick: () => confirmAndConvertToPatternTrack(track),
      })
    }

    // Video Flip — opens the inline Track Flip Properties popover (spec §6.1).
    // The popover replaces the legacy 4-option submenu. Mark "✓" when the
    // flip cycle is enabled so the menu still surfaces the on/off state.
    items.push({
      label: 'Video Flip…',
      checked: !!track.videoFlipConfig?.enabled,
      onClick: () => {
        // Anchor the popover at the menu's click position; the popover then
        // clamps itself to the viewport. (When the windowing spec lands and
        // this UI moves into the Track Properties tab, anchorRect can come
        // from the tab's bounding box instead.)
        const anchorRect = trackMenu
          ? { right: trackMenu.x, top: trackMenu.y }
          : { right: 200, top: 200 }
        setFlipPanel({ track, anchorRect })
      },
    })

    const currentHold = track.videoHoldLastFrame || false
    items.push({
      label: 'Hold Last Frame',
      checked: currentHold,
      onClick: () => handleSetVideoHoldLastFrame(track.id, !currentHold),
    })

    items.push({ type: 'separator' })
    items.push({
      label: 'Delete Track',
      danger: true,
      onClick: () => handleRemove(track.id),
    })
    return items
  }, [patterns, currentPatternIdByTrack, handleNewPatternForTrack, handleSelectPatternForTrack, handleSetVideoHoldLastFrame, handleConvertToClipTrack, confirmAndConvertToPatternTrack, handleRemove, trackMenu])

  // ── Seek via ruler ─────────────────────────────────────────────────────────

  const handleSeek = useCallback((beat) => {
    editCursor.setPosition(beat)
    const posMs = beat * 60000 / bpmRef.current
    playheadClock.syncFromEngine(posMs, bpmRef.current, isPlayingRef.current)
    playheadBeatRef.current = beat
    canvasRef.current?.positionPlayhead(beat)
    rulerRef.current?.redrawOverlay()
    window.xleth?.transport?.seek(beat)  // fire-and-forget
  }, [])

  // ── Mutation callbacks (passed to tools via canvas) ────────────────────────

  const handleCreateClip = useCallback(async (trackId, regionId, positionTicks, durationTicks, opts = {}) => {
    const { regionOffsetTicks = 0, velocity = 1.0, pitchOffset = 0, syllableIndex = -1 } = opts
    console.log(`[PencilTool] Creating clip: region=${regionId}, track=${trackId}, pos=${positionTicks}t, dur=${durationTicks}t`)
    try {
      const clipId = await window.xleth?.timeline?.addClip({
        trackId, regionId, positionTicks, durationTicks,
        regionOffsetTicks, velocity, pitchOffset, syllableIndex,
      })
      console.log(`[PencilTool] Clip created: id=${clipId}`)
      await fetchClips()
    } catch (err) {
      console.error('[PencilTool] addClip failed:', err)
    }
  }, [fetchClips])

  const handleDeleteClip = useCallback(async (clipId) => {
    console.log(`[DeleteTool] Deleting clip ${clipId}`)
    try {
      await window.xleth?.timeline?.removeClip(clipId)
      setSelectedClipIds((prev) => {
        const next = new Set(prev)
        next.delete(clipId)
        return next
      })
      await fetchClips()
    } catch (err) {
      console.error(`[DeleteTool] removeClip(${clipId}) failed:`, err)
    }
  }, [fetchClips])

  const handleMoveClip = useCallback(async (clipId, newTrackId, newPositionTicks) => {
    console.log(`[SelectTool] Moving clip ${clipId}: track=${newTrackId}, pos=${newPositionTicks}t`)
    try {
      await window.xleth?.timeline?.moveClip(clipId, newTrackId, newPositionTicks)
      await fetchClips()
    } catch (err) {
      console.error(`[SelectTool] moveClip(${clipId}) failed:`, err)
    }
  }, [fetchClips])

  const handleResizeClip = useCallback(async (clipId, newDurationTicks) => {
    console.log(`[SelectTool] Resizing clip ${clipId}: dur=${newDurationTicks}t`)
    try {
      await window.xleth?.timeline?.resizeClip(clipId, newDurationTicks)
      await fetchClips()
    } catch (err) {
      console.error(`[SelectTool] resizeClip(${clipId}) failed:`, err)
    }
  }, [fetchClips])

  const handleSplitClip = useCallback(async (clipId, leftDuration, rightDuration) => {
    const clip = clipsRef.current.find((c) => c.id === clipId)
    if (!clip) return
    console.log(`[SplitTool] Splitting clip ${clipId}: left=${leftDuration}t, right=${rightDuration}t`)
    try {
      const originalOffset = clip.regionOffsetTicks ?? 0

      await window.xleth?.timeline?.removeClip(clipId)
      await window.xleth?.timeline?.addClip({
        trackId: clip.trackId, regionId: clip.regionId,
        positionTicks: clip.positionTicks, durationTicks: leftDuration,
        regionOffsetTicks: originalOffset,
        syllableIndex: clip.syllableIndex ?? -1,
        velocity: clip.velocity ?? 1.0,
        pitchOffset: clip.pitchOffset ?? 0,
        pitchOffsetCents: clip.pitchOffsetCents ?? 0,
        reversed: clip.reversed ?? false,
        stretchRatio: clip.stretchRatio ?? 1.0,
        stretchMethod: clip.stretchMethod ?? 0,
        formantPreserve: clip.formantPreserve ?? false,
        fadeInPercent:  clip.fadeInPercent  ?? 0,
        fadeOutPercent: clip.fadeOutPercent ?? 0,
        fadeInX1:  clip.fadeInX1  ?? 0,  fadeInY1:  clip.fadeInY1  ?? 0,
        fadeInX2:  clip.fadeInX2  ?? 1,  fadeInY2:  clip.fadeInY2  ?? 1,
        fadeOutX1: clip.fadeOutX1 ?? 0,  fadeOutY1: clip.fadeOutY1 ?? 0,
        fadeOutX2: clip.fadeOutX2 ?? 1,  fadeOutY2: clip.fadeOutY2 ?? 1,
      })
      await window.xleth?.timeline?.addClip({
        trackId: clip.trackId, regionId: clip.regionId,
        positionTicks: clip.positionTicks + leftDuration, durationTicks: rightDuration,
        regionOffsetTicks: originalOffset + leftDuration,
        syllableIndex: clip.syllableIndex ?? -1,
        velocity: clip.velocity ?? 1.0,
        pitchOffset: clip.pitchOffset ?? 0,
        pitchOffsetCents: clip.pitchOffsetCents ?? 0,
        reversed: clip.reversed ?? false,
        stretchRatio: clip.stretchRatio ?? 1.0,
        stretchMethod: clip.stretchMethod ?? 0,
        formantPreserve: clip.formantPreserve ?? false,
        fadeInPercent:  clip.fadeInPercent  ?? 0,
        fadeOutPercent: clip.fadeOutPercent ?? 0,
        fadeInX1:  clip.fadeInX1  ?? 0,  fadeInY1:  clip.fadeInY1  ?? 0,
        fadeInX2:  clip.fadeInX2  ?? 1,  fadeInY2:  clip.fadeInY2  ?? 1,
        fadeOutX1: clip.fadeOutX1 ?? 0,  fadeOutY1: clip.fadeOutY1 ?? 0,
        fadeOutX2: clip.fadeOutX2 ?? 1,  fadeOutY2: clip.fadeOutY2 ?? 1,
      })
      lastSplitUndoCountRef.current = 3
      setSelectedClipIds(new Set())
      await fetchClips()
      console.log(`[SplitTool] Split complete`)
    } catch (err) {
      console.error(`[SplitTool] split failed:`, err)
    }
  }, [fetchClips])

  // Splits every selected clip that the transport playhead currently intersects.
  // Returns true if at least one clip was split (used to decide S key fallback).
  const handleSpliceSelectedClips = useCallback(async (splitTick) => {
    const qualifying = clipsRef.current.filter(
      (c) => selectedClipIds.has(c.id) &&
             splitTick > c.positionTicks &&
             splitTick < c.positionTicks + c.durationTicks
    )
    if (qualifying.length === 0) return false
    const entries = qualifying.map((c) => ({ clipId: c.id, splitTick }))
    try {
      const pairs = await window.xleth.timeline.spliceClipsAtPlayhead(entries)
      const newIds = pairs.flat()
      setSelectedClipIds(new Set(newIds))
      await fetchClips()
    } catch (err) {
      console.error('[Splice] spliceClipsAtPlayhead failed:', err)
    }
    return true
  }, [selectedClipIds, fetchClips])

  // ── Pattern Block mutations (used by tools) ────────────────────────────────

  const handleCreatePatternBlock = useCallback(async (trackId, patternId, positionTicks, durationTicks, offsetTicks = 0) => {
    console.log(`[PencilTool] Creating pattern block: track=${trackId}, pattern=${patternId}, pos=${positionTicks}t, dur=${durationTicks}t`)
    try {
      const blockId = await window.xleth?.timeline?.addPatternBlock({
        trackId, patternId, positionTicks, durationTicks, offsetTicks,
      })
      console.log(`[PencilTool] Pattern block created: id=${blockId}`)
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[PencilTool] addPatternBlock failed:', err)
    }
  }, [])

  const handleMovePatternBlock = useCallback(async (blockId, trackId, positionTicks) => {
    console.log(`[SelectTool] Moving pattern block ${blockId}: track=${trackId}, pos=${positionTicks}t`)
    try {
      await window.xleth?.timeline?.movePatternBlock(blockId, trackId, positionTicks)
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[SelectTool] movePatternBlock failed:', err)
    }
  }, [])

  const handleResizePatternBlock = useCallback(async (blockId, durationTicks) => {
    console.log(`[SelectTool] Resizing pattern block ${blockId}: dur=${durationTicks}t`)
    try {
      await window.xleth?.timeline?.resizePatternBlock(blockId, durationTicks)
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[SelectTool] resizePatternBlock failed:', err)
    }
  }, [])

  const handleResizePatternBlockLeft = useCallback(async (blockId, positionTicks, durationTicks, offsetTicks) => {
    console.log(`[SelectTool] Left-resizing pattern block ${blockId}: pos=${positionTicks}t, dur=${durationTicks}t, offset=${offsetTicks}t`)
    try {
      await window.xleth?.timeline?.resizePatternBlockLeft(blockId, positionTicks, durationTicks, offsetTicks)
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[SelectTool] resizePatternBlockLeft failed:', err)
    }
  }, [])

  const handleDeletePatternBlock = useCallback(async (blockId) => {
    console.log(`[DeleteTool] Deleting pattern block ${blockId}`)
    try {
      await window.xleth?.timeline?.removePatternBlock(blockId)
      setSelectedBlockIds(prev => {
        const next = new Set(prev)
        next.delete(blockId)
        return next
      })
      // Optimistic: remove from local state immediately so the canvas doesn't
      // repaint the ghost block during the async reconciliation fetch.
      setPatternBlocks(prev => prev.filter(b => b.id !== blockId))
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[DeleteTool] removePatternBlock failed:', err)
    }
  }, [])

  const handleSplitPatternBlock = useCallback(async (blockId, splitPositionTicks) => {
    const block = patternBlocks.find(b => b.id === blockId)
    if (!block) return
    const pattern = patterns[block.patternId]
    const patLen = pattern?.lengthTicks || (PPQ * 4)
    const leftDur = splitPositionTicks - block.positionTicks
    const rightDur = block.durationTicks - leftDur
    if (leftDur <= 0 || rightDur <= 0) return
    const baseOffset = block.offsetTicks || 0
    const splitOffsetInPattern = (baseOffset + leftDur) % patLen
    console.log(`[SplitTool] Splitting block ${blockId}: leftDur=${leftDur}, rightDur=${rightDur}, secondOffset=${splitOffsetInPattern}`)
    try {
      // Resize first half
      await window.xleth?.timeline?.resizePatternBlock(blockId, leftDur)
      // Create second half
      await window.xleth?.timeline?.addPatternBlock({
        trackId: block.trackId,
        patternId: block.patternId,
        positionTicks: splitPositionTicks,
        durationTicks: rightDur,
        offsetTicks: splitOffsetInPattern,
      })
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[SplitTool] splitPatternBlock failed:', err)
    }
  }, [patternBlocks, patterns])

  const handleResizeClipLeft = useCallback(async (clipId, newPositionTicks, newDurationTicks, newRegionOffset) => {
    console.log(`[SelectTool] Left-resize clip ${clipId}: pos=${newPositionTicks}t, dur=${newDurationTicks}t, offset=${newRegionOffset}t`)
    try {
      await window.xleth?.timeline?.resizeClipLeft(clipId, newPositionTicks, newDurationTicks, newRegionOffset)
      await fetchClips()
    } catch (err) {
      console.error(`[SelectTool] resizeClipLeft(${clipId}) failed:`, err)
    }
  }, [fetchClips])

  const handleStretchClip = useCallback(async (clipId, newDurationTicks) => {
    console.log(`[SelectTool] Stretching clip ${clipId}: dur=${newDurationTicks}t`)
    try {
      await window.xleth?.timeline?.stretchClip(clipId, newDurationTicks)
      await fetchClips()
    } catch (err) {
      console.error(`[SelectTool] stretchClip(${clipId}) failed:`, err)
    }
  }, [fetchClips])

  const handleStretchClipLeft = useCallback(async (clipId, newPositionTicks, newDurationTicks) => {
    console.log(`[SelectTool] Left-stretch clip ${clipId}: pos=${newPositionTicks}t, dur=${newDurationTicks}t`)
    try {
      await window.xleth?.timeline?.stretchClipLeft(clipId, newPositionTicks, newDurationTicks)
      await fetchClips()
    } catch (err) {
      console.error(`[SelectTool] stretchClipLeft(${clipId}) failed:`, err)
    }
  }, [fetchClips])

  // ── Drag-over (preview while dragging sample onto timeline) ────────────────

  const handleCanvasDragOver = useCallback((localX, localY, e) => {
    const types = e.dataTransfer.types
    const isSample  = types.includes('application/xleth-sample')
    const isSource  = types.includes('application/xleth-source')
    const isPattern = types.includes('application/xleth-pattern')
    if (!isSample && !isSource && !isPattern) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'

    const trackIndex = Math.floor(localY / TRACK_HEIGHT)
    if (trackIndex < 0 || trackIndex >= tracks.length) {
      dropPreviewRef.current = null
      canvasRef.current?.redrawOverlay()
      return
    }

    const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
    const modifiers = { alt: e.altKey, shift: e.shiftKey }
    const snappedBeat = snapBeatToGrid(Math.max(0, beat), modifiers, snapGranularity)

    // Read drag payload from global (can't read dataTransfer during dragover)
    const dragData = isPattern
      ? window.__xlethDragPattern
      : isSource
        ? window.__xlethDragSource
        : window.__xlethDragSample
    if (!dragData) return

    let durationBeats
    let color
    let name
    if (isPattern) {
      durationBeats = (dragData.lengthTicks || PPQ * 4) / PPQ
      const region  = regions[dragData.regionId]
      color = region ? labelHexColor(region.label || 'Custom') : tokenValue('--theme-drag-preview-default')
      name  = dragData.name
    } else if (isSource) {
      durationBeats = (dragData.duration || 0) * (bpmRef.current / 60)
      color = labelHexColor('Custom')
      name  = dragData.fileName
    } else {
      durationBeats = Math.abs(dragData.endTime - dragData.startTime) * (bpmRef.current / 60)
      color = labelHexColor(dragData.label)
      name  = dragData.name
    }

    const snapLabel = modifiers.shift ? 'free' : modifiers.alt ? '32nd' : '16th'
    console.log(`[TimelineClips] Drop preview: beat=${snappedBeat.toFixed(2)}, track=${trackIndex}, snap=${snapLabel}`)

    dropPreviewRef.current = {
      beat: snappedBeat,
      trackIndex,
      durationBeats,
      color,
      name,
    }
    canvasRef.current?.redrawOverlay()
  }, [tracks, regions])

  // ── Drop (create clip from dropped sample) ─────────────────────────────────

  const handleCanvasDrop = useCallback(async (localX, localY, e) => {
    e.preventDefault()
    dropPreviewRef.current = null
    canvasRef.current?.redrawOverlay()

    const sourceRaw  = e.dataTransfer.getData('application/xleth-source')
    const sampleRaw  = e.dataTransfer.getData('application/xleth-sample')
    const patternRaw = e.dataTransfer.getData('application/xleth-pattern')
    if (!sourceRaw && !sampleRaw && !patternRaw) return

    const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
    const trackIndex = Math.floor(localY / TRACK_HEIGHT)

    if (trackIndex < 0 || trackIndex >= tracks.length) {
      console.warn('[TimelineClips] WARNING: drop outside track area')
      return
    }

    const modifiers = { alt: e.altKey, shift: e.shiftKey }
    const snappedBeat = snapBeatToGrid(Math.max(0, beat), modifiers, snapGranularity)
    const track = tracks[trackIndex]
    const positionTicks = beatsToTicks(snappedBeat)

    // ── Pattern drop: create PatternBlock on Pattern-type track ─────────────
    // Pattern tracks are sample-agnostic — any pattern is accepted on any
    // pattern track. The block's pattern carries its own regionId.
    if (patternRaw) {
      let pd
      try { pd = JSON.parse(patternRaw) } catch { return }
      if (track.type !== 'Pattern') {
        console.warn(`[TimelineClips] Pattern drop rejected: track "${track.name}" is not a Pattern track`)
        return
      }
      const durationTicks = pd.lengthTicks || (PPQ * 4)
      try {
        const blockId = await window.xleth?.timeline?.addPatternBlock({
          trackId: track.id,
          patternId: pd.patternId,
          positionTicks,
          durationTicks,
          offsetTicks: 0,
        })
        console.log(`[TimelineClips] PatternBlock created via drag: id=${blockId}, pattern=${pd.patternId}, pos=${positionTicks}t, dur=${durationTicks}t`)
        timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      } catch (err) {
        console.error('[TimelineClips] addPatternBlock (drag) failed:', err)
      }
      return
    }

    // ── Source drop: create region + clip spanning the full source ──────────
    if (sourceRaw) {
      let src
      try { src = JSON.parse(sourceRaw) } catch { return }
      const durationTicks = regionDurationToTicks(0, src.duration || 0, bpmRef.current)
      console.log(`[TimelineClips] Source drop: "${src.fileName}" on track "${track.name}" at beat ${snappedBeat.toFixed(2)} (pos=${positionTicks}t, dur=${durationTicks}t)`)
      try {
        const regionId = await window.xleth?.timeline?.addRegion({
          sourceId:  src.sourceId,
          startTime: 0,
          endTime:   src.duration || 0,
          label:     'Custom',
          name:      src.fileName,
        })
        if (typeof regionId !== 'number' || regionId < 0) {
          console.warn('[TimelineClips] addRegion returned invalid id:', regionId)
          return
        }
        const clipId = await window.xleth?.timeline?.addClip({
          trackId: track.id,
          regionId,
          positionTicks,
          durationTicks,
          velocity: 1.0,
        })
        console.log(`[TimelineClips] Source clip created: region=${regionId} clip=${clipId}`)
        // rebuildAudioMappings() picks up the new region and loads it into SampleBank.
        timelineEvents.dispatchEvent(new Event('timeline-regions-changed'))
        await fetchClips()
      } catch (err) {
        console.error('[TimelineClips] source drop failed:', err)
      }
      return
    }

    // ── Sample drop (existing behavior) ─────────────────────────────────────
    let data
    try { data = JSON.parse(sampleRaw) } catch { return }

    // ── Pitch sample on a Pattern track → PatternBlock ─────────────────────
    // On a Clip track, a Pitch drop falls through to the regular clip path
    // below. Use the right-click "Convert to Pattern Track" menu to opt into
    // pattern/sampler behavior explicitly.
    if (data.label === 'Pitch' && track.type === 'Pattern') {
      // Find or create a pattern matching the dropped sample's region.
      // Priority: (1) current pattern for this track if regionId matches,
      // (2) any existing pattern with that regionId, (3) create new.
      let patternId = -1
      const currentPatId = currentPatternIdByTrack?.[track.id]
      if (currentPatId != null && currentPatId >= 0) {
        const p = patterns[currentPatId]
        if (p && p.regionId === data.regionId) patternId = currentPatId
      }
      if (patternId < 0) {
        const match = Object.values(patterns).find(p => p.regionId === data.regionId)
        if (match) patternId = match.id
      }
      if (patternId < 0) {
        const name = nextPatternName(data.regionId)
        try {
          const newId = await window.xleth?.timeline?.addPattern({
            name,
            regionId: data.regionId,
            lengthTicks: PPQ * 4,
          })
          if (newId != null && newId >= 0) {
            patternId = newId
            await fetchPatterns()
            timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
          }
        } catch (err) {
          console.error('[TimelineClips] addPattern failed:', err)
          return
        }
      }
      if (patternId < 0) {
        console.warn('[TimelineClips] No pattern available for block creation')
        return
      }
      setCurrentPatternIdByTrack(prev => ({ ...prev, [track.id]: patternId }))

      // Create a PatternBlock at drop position — duration = one pattern loop
      const pattern = patterns[patternId]
      const durationTicks = pattern?.lengthTicks || (PPQ * 4)
      try {
        const blockId = await window.xleth?.timeline?.addPatternBlock({
          trackId: track.id,
          patternId,
          positionTicks,
          durationTicks,
          offsetTicks: 0,
        })
        console.log(`[TimelineClips] PatternBlock created: id=${blockId}, pattern=${patternId}, pos=${positionTicks}t, dur=${durationTicks}t`)
        timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      } catch (err) {
        console.error('[TimelineClips] addPatternBlock failed:', err)
      }
      return
    }

    // ── Non-pitch sample → Clip (existing behavior) ────────────────────────
    const durationTicks = regionDurationToTicks(data.startTime, data.endTime, bpmRef.current)

    console.log(`[TimelineClips] Clip created via drop: "${data.name}" on track "${track.name}" at beat ${snappedBeat.toFixed(2)} (pos=${positionTicks}t, dur=${durationTicks}t)`)

    try {
      const clipId = await window.xleth?.timeline?.addClip({
        trackId: track.id,
        regionId: data.regionId,
        positionTicks,
        durationTicks,
        velocity: 1.0,
      })
      console.log(`[TimelineClips] Clip created: id=${clipId}`)
      await fetchClips()
    } catch (err) {
      console.error('[TimelineClips] addClip failed:', err)
    }
  }, [tracks, fetchClips, fetchPatterns, patterns, currentPatternIdByTrack, nextPatternName, setCurrentPatternIdByTrack])

  // ── Drag leave (clear preview) ─────────────────────────────────────────────

  const handleCanvasDragLeave = useCallback((e) => {
    // Only clear if leaving the canvas container (not entering a child)
    if (e.currentTarget.contains(e.relatedTarget)) return
    dropPreviewRef.current = null
    canvasRef.current?.redrawOverlay()
    console.log('[TimelineClips] Drop preview cleared')
  }, [])

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  //
  // Routed through the central KeyboardManager — the router gates on focused
  // panel + text-entry, so the inline checks for activeCenterTab and INPUT/
  // TEXTAREA target are gone. Handler is held in a ref so state changes don't
  // re-register; the registration useEffect is empty-deps and runs once.

  const timelineKeyHandlerRef = useRef(null)
  timelineKeyHandlerRef.current = async (e) => {
      const ctrl = e.ctrlKey || e.metaKey

      // ── Undo / Redo (global, no focus gate) ───────────────────────────
      if (e.key === 'z' && ctrl && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        if (lastSplitUndoCountRef.current > 0) {
          const count = lastSplitUndoCountRef.current
          lastSplitUndoCountRef.current = 0
          for (let i = 0; i < count; i++) await window.xleth?.undo?.undo()
          console.log(`[Keyboard] Undo (split batch ×${count})`)
        } else {
          await window.xleth?.undo?.undo()
          console.log('[Keyboard] Undo')
        }
        await fetchClips()
        return
      }
      if ((e.key === 'y' && ctrl) || (e.key === 'z' && ctrl && e.shiftKey)) {
        e.preventDefault()
        e.stopPropagation()
        await window.xleth?.undo?.redo()
        await fetchClips()
        lastSplitUndoCountRef.current = 0
        console.log('[Keyboard] Redo')
        return
      }

      // ── Select all (global) ───────────────────────────────────────────
      if (e.key === 'a' && ctrl) {
        e.preventDefault()
        e.stopPropagation()
        setSelectedClipIds(new Set(clipsRef.current.map((c) => c.id)))
        console.log('[Keyboard] Select all')
        return
      }

      // ── Delete selected clips + blocks (parallel) ─────────────────────
      if (e.key === 'Delete' && (selectedClipIds.size > 0 || selectedBlockIds.size > 0)) {
        e.preventDefault()
        e.stopPropagation()
        const clipIdList = [...selectedClipIds]
        const blockIdList = [...selectedBlockIds]
        console.log(`[Keyboard] Deleting ${clipIdList.length} clip(s), ${blockIdList.length} block(s)`)
        setSelectedClipIds(new Set())
        setSelectedBlockIds(new Set())
        await Promise.all([
          ...clipIdList.map(id =>
            window.xleth?.timeline?.removeClip(id).catch(err =>
              console.error(`[Keyboard] removeClip(${id}) failed:`, err)
            )
          ),
          ...blockIdList.map(id =>
            window.xleth?.timeline?.removePatternBlock(id).catch(err =>
              console.error(`[Keyboard] removePatternBlock(${id}) failed:`, err)
            )
          ),
        ])
        if (clipIdList.length > 0) await fetchClips()
        if (blockIdList.length > 0) timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
        return
      }

      // ── Copy clips + pattern blocks (Ctrl+C) — supports multi-selection ──
      if (e.key === 'c' && ctrl) {
        e.preventDefault()
        e.stopPropagation()
        if (selectedClipIds.size > 0) {
          const selectedClips = clipsRef.current
            .filter(c => selectedClipIds.has(c.id))
            .sort((a, b) => a.positionTicks - b.positionTicks)
          if (selectedClips.length > 0) {
            const basePosition = selectedClips[0].positionTicks
            const trackOrder = tracks.map(t => t.id)
            const baseTrackIdx = trackOrder.indexOf(selectedClips[0].trackId)
            clipboardRef.current = selectedClips.map(clip => ({
              regionId: clip.regionId,
              trackId: clip.trackId,
              sourceTrackType: 'Clip',
              durationTicks: clip.durationTicks,
              regionOffsetTicks: clip.regionOffsetTicks ?? 0,
              velocity: clip.velocity ?? 1.0,
              pitchOffset: clip.pitchOffset ?? 0,
              syllableIndex: clip.syllableIndex ?? -1,
              relativePosition: clip.positionTicks - basePosition,
              relativeTrackIndex: trackOrder.indexOf(clip.trackId) - baseTrackIdx,
              // Non-fade playback modifiers (defaults match engine Clip struct)
              pitchOffsetCents: clip.pitchOffsetCents ?? 0,
              reversed: clip.reversed ?? false,
              stretchRatio: clip.stretchRatio ?? 1.0,
              stretchMethod: clip.stretchMethod ?? 0,   // 0 == StretchMethod::Global
              formantPreserve: clip.formantPreserve ?? false,
              // Fade envelope (percent + cubic-bezier control points)
              fadeInPercent:  clip.fadeInPercent  ?? 0,
              fadeOutPercent: clip.fadeOutPercent ?? 0,
              fadeInX1:  clip.fadeInX1  ?? 0,
              fadeInY1:  clip.fadeInY1  ?? 0,
              fadeInX2:  clip.fadeInX2  ?? 1,
              fadeInY2:  clip.fadeInY2  ?? 1,
              fadeOutX1: clip.fadeOutX1 ?? 0,
              fadeOutY1: clip.fadeOutY1 ?? 0,
              fadeOutX2: clip.fadeOutX2 ?? 1,
              fadeOutY2: clip.fadeOutY2 ?? 1,
            }))
            console.log(`[Keyboard] Copied ${selectedClips.length} clip(s)`)
            console.log('[ClipCopy] source clips (raw React state) =',
              JSON.stringify(selectedClips, null, 2))
            console.log('[ClipCopy] clipboardRef =',
              JSON.stringify(clipboardRef.current, null, 2))
            patternBlockClipboardRef.current = null
          }
        }
        if (selectedBlockIds.size > 0) {
          const selectedBlocks = patternBlocks
            .filter(b => selectedBlockIds.has(b.id))
            .sort((a, b) => a.positionTicks - b.positionTicks)
          if (selectedBlocks.length > 0) {
            const basePosition = selectedBlocks[0].positionTicks
            const trackOrder = tracks.map(t => t.id)
            const baseTrackIdx = trackOrder.indexOf(selectedBlocks[0].trackId)
            patternBlockClipboardRef.current = selectedBlocks.map(block => {
              const pattern = patterns[block.patternId]
              const srcRegionId = pattern?.regionId ?? -1
              const srcRegion = regions[srcRegionId]
              return {
                patternId: block.patternId,
                srcRegionId,
                srcRootNote: srcRegion?.rootNote ?? 60,
                trackId: block.trackId,
                sourceTrackType: 'Pattern',
                durationTicks: block.durationTicks,
                offsetTicks: block.offsetTicks ?? 0,
                loopEnabled: block.loopEnabled ?? false,
                relativePosition: block.positionTicks - basePosition,
                relativeTrackIndex: trackOrder.indexOf(block.trackId) - baseTrackIdx,
              }
            })
            console.log(`[Keyboard] Copied ${selectedBlocks.length} pattern block(s)`)
            clipboardRef.current = null
          }
        }
        return
      }

      // ── Paste clips + pattern blocks at edit cursor (Ctrl+V) ─────────
      if (e.key === 'v' && ctrl) {
        e.preventDefault()
        e.stopPropagation()

        // Aggregated skip reasons — surfaced as a single toast at end of paste.
        // 'typeMismatchClip'   = clip → non-Clip track under focus
        // 'typeMismatchBlock'  = pattern block → non-Pattern track under focus
        // 'overflow'           = relativeTrackIndex pushes past the last track
        const skipped = { typeMismatchClip: 0, typeMismatchBlock: 0, overflow: 0 }

        const cb = clipboardRef.current
        if (cb && Array.isArray(cb) && cb.length > 0) {
          // Read & snap edit cursor — instant, no IPC
          const baseBeat = snapBeatToGrid(editCursor.getPosition())
          const baseTicks = beatsToTicks(baseBeat)

          // Predict end position from clipboard geometry (pure math, no I/O)
          let predictedEndTicks = baseTicks
          for (const item of cb) {
            const end = baseTicks + item.relativePosition + item.durationTicks
            if (end > predictedEndTicks) predictedEndTicks = end
          }

          // Advance edit cursor IMMEDIATELY — spamming Ctrl+V reads fresh values
          const predictedEndBeat = predictedEndTicks / PPQ
          editCursor.setPosition(predictedEndBeat)

          // Fire-and-forget transport sync (engine follows editor, not vice versa)
          window.xleth?.transport?.seek(predictedEndBeat)
          playheadClock.syncFromEngine(predictedEndBeat * 60000 / bpmRef.current, bpmRef.current, isPlayingRef.current)
          playheadBeatRef.current = predictedEndBeat
          canvasRef.current?.positionPlayhead(predictedEndBeat)
          rulerRef.current?.redrawOverlay()

          // Rebase point: focused track if it matches the clipboard's source type,
          // else fall back to the clipboard's source track. This preserves the
          // "paste lands where I'm focused" behavior when types are compatible,
          // and prevents silent type-mismatch skips when a Pattern track is
          // focused while clips are in the clipboard.
          const trackOrder = tracks.map(t => t.id)
          const focusId = focusedTrackIdRef.current
          const focusedTrackObj = focusId ? tracks.find(t => t.id === focusId) : null
          const expectedTypeForRebase = cb[0].sourceTrackType ?? 'Clip'
          const focusUsable = !!focusedTrackObj && focusedTrackObj.type === expectedTypeForRebase
          const baseTrackIdx = focusUsable
            ? Math.max(0, trackOrder.indexOf(focusId))
            : Math.max(0, trackOrder.indexOf(cb[0].trackId))
          try {
            const newIds = []
            const virtualClips = [...clipsRef.current]  // includes in-batch placements
            let pasteIdx = 0
            for (const item of cb) {
              const targetTrackIdx = baseTrackIdx + item.relativeTrackIndex
              if (targetTrackIdx < 0 || targetTrackIdx >= trackOrder.length) {
                skipped.overflow++
                continue
              }
              const trackId = trackOrder[targetTrackIdx]
              const destTrack = tracks.find(t => t.id === trackId)
              if (!destTrack) { skipped.overflow++; continue }
              const expectedType = item.sourceTrackType ?? 'Clip'
              if (destTrack.type !== expectedType) {
                skipped.typeMismatchClip++
                console.warn(`[Keyboard] Clip paste rejected: track ${trackId} is ${destTrack.type}, expected ${expectedType}`)
                continue
              }
              const proposedTicks = baseTicks + item.relativePosition
              const safeTicks = findFreePosition(trackId, proposedTicks, item.durationTicks, virtualClips)
              const payload = {
                trackId,
                regionId: item.regionId,
                positionTicks: safeTicks,
                durationTicks: item.durationTicks,
                regionOffsetTicks: item.regionOffsetTicks,
                syllableIndex: item.syllableIndex,
                velocity: item.velocity,
                pitchOffset: item.pitchOffset,
                // Carry all playback modifiers from the clipboard snapshot
                pitchOffsetCents: item.pitchOffsetCents,
                reversed: item.reversed,
                stretchRatio: item.stretchRatio,
                stretchMethod: item.stretchMethod,
                formantPreserve: item.formantPreserve,
                fadeInPercent:  item.fadeInPercent,
                fadeOutPercent: item.fadeOutPercent,
                fadeInX1:  item.fadeInX1,  fadeInY1:  item.fadeInY1,
                fadeInX2:  item.fadeInX2,  fadeInY2:  item.fadeInY2,
                fadeOutX1: item.fadeOutX1, fadeOutY1: item.fadeOutY1,
                fadeOutX2: item.fadeOutX2, fadeOutY2: item.fadeOutY2,
              }
              console.log('[ClipPaste] payload for clip', pasteIdx++, '=',
                JSON.stringify(payload, null, 2))
              const newId = await window.xleth?.timeline?.addClip(payload)
              if (newId != null) {
                newIds.push(newId)
                virtualClips.push({ trackId, positionTicks: safeTicks, durationTicks: item.durationTicks })
              }
            }
            await fetchClips()
            setSelectedClipIds(new Set(newIds))
            console.log(`[Keyboard] Pasted ${newIds.length}/${cb.length} clip(s) at edit cursor (${baseTicks}t), cursor → ${predictedEndTicks}t`)
          } catch (err) {
            console.error('[Keyboard] Paste failed:', err)
          }
        }

        // ── Paste pattern blocks at edit cursor (Ctrl+V) ───────────────
        const pbcb = patternBlockClipboardRef.current
        if (pbcb && Array.isArray(pbcb) && pbcb.length > 0) {
          const baseBeat = snapBeatToGrid(editCursor.getPosition())
          const baseTicks = beatsToTicks(baseBeat)

          // Predict end position & advance cursor immediately (same pattern as clip paste)
          let predictedEndTicks = baseTicks
          for (const item of pbcb) {
            const end = baseTicks + item.relativePosition + item.durationTicks
            if (end > predictedEndTicks) predictedEndTicks = end
          }
          const predictedEndBeat = predictedEndTicks / PPQ
          editCursor.setPosition(predictedEndBeat)
          window.xleth?.transport?.seek(predictedEndBeat)
          playheadClock.syncFromEngine(predictedEndBeat * 60000 / bpmRef.current, bpmRef.current, isPlayingRef.current)
          playheadBeatRef.current = predictedEndBeat
          canvasRef.current?.positionPlayhead(predictedEndBeat)
          rulerRef.current?.redrawOverlay()

          // Same compatibility fallback as the clip-paste branch — if focused
          // track type doesn't match the clipboard's source type, rebase on
          // the source track instead of silently skipping every block.
          const trackOrder = tracks.map(t => t.id)
          const focusId = focusedTrackIdRef.current
          const focusedTrackObj = focusId ? tracks.find(t => t.id === focusId) : null
          const expectedTypeForRebase = pbcb[0].sourceTrackType ?? 'Pattern'
          const focusUsable = !!focusedTrackObj && focusedTrackObj.type === expectedTypeForRebase
          const baseTrackIdx = focusUsable
            ? Math.max(0, trackOrder.indexOf(focusId))
            : Math.max(0, trackOrder.indexOf(pbcb[0].trackId))
          try {
            const newIds = []
            for (const item of pbcb) {
              const targetTrackIdx = baseTrackIdx + item.relativeTrackIndex
              if (targetTrackIdx < 0 || targetTrackIdx >= trackOrder.length) {
                skipped.overflow++
                continue
              }
              const destTrackId = trackOrder[targetTrackIdx]
              const destTrack = tracks.find(t => t.id === destTrackId)
              if (!destTrack) { skipped.overflow++; continue }
              const expectedType = item.sourceTrackType ?? 'Pattern'
              if (destTrack.type !== expectedType) {
                skipped.typeMismatchBlock++
                console.warn(`[Keyboard] Pattern block paste rejected: track ${destTrackId} is ${destTrack.type}, expected ${expectedType}`)
                continue
              }

              // Pattern tracks are sample-agnostic — paste the pattern verbatim.
              const blockId = await window.xleth?.timeline?.addPatternBlock({
                trackId: destTrackId,
                patternId: item.patternId,
                positionTicks: baseTicks + item.relativePosition,
                durationTicks: item.durationTicks,
                offsetTicks: item.offsetTicks,
              })
              if (blockId != null && blockId >= 0) newIds.push(blockId)
            }
            await fetchPatternBlocks()
            timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
            setSelectedBlockIds(new Set(newIds))
            console.log(`[Keyboard] Pasted ${newIds.length}/${pbcb.length} pattern block(s) at ${baseTicks}t, cursor → ${predictedEndTicks}t`)
          } catch (err) {
            console.error('[Keyboard] Pattern block paste failed:', err)
          }
        }

        // ── Aggregate skip reasons into a single toast (suppress on clean paste) ──
        const messages = []
        if (skipped.typeMismatchClip > 0) {
          const n = skipped.typeMismatchClip
          messages.push(`${n} clip${n === 1 ? '' : 's'} skipped — focus an audio track to paste them`)
        }
        if (skipped.typeMismatchBlock > 0) {
          const n = skipped.typeMismatchBlock
          messages.push(`${n} pattern block${n === 1 ? '' : 's'} skipped — focus a pattern track to paste them`)
        }
        if (skipped.overflow > 0) {
          const n = skipped.overflow
          messages.push(`${n} item${n === 1 ? '' : 's'} skipped — not enough tracks below focus`)
        }
        if (messages.length > 0) showToast(messages.join(' · '), 'info')
        return
      }

      // ── Duplicate clip after source (Ctrl+D) ─────────────────────────
      if (e.key === 'd' && ctrl) {
        e.preventDefault()
        e.stopPropagation()
        if (selectedClipIds.size >= 1) {
          const clipId = [...selectedClipIds][0]
          const clip = clipsRef.current.find(c => c.id === clipId)
          if (clip) {
            const proposedTicks = clip.positionTicks + clip.durationTicks
            const newPositionTicks = findFreePosition(clip.trackId, proposedTicks, clip.durationTicks, clipsRef.current)
            try {
              const payload = {
                trackId: clip.trackId,
                regionId: clip.regionId,
                positionTicks: newPositionTicks,
                durationTicks: clip.durationTicks,
                regionOffsetTicks: clip.regionOffsetTicks ?? 0,
                syllableIndex: clip.syllableIndex ?? -1,
                velocity: clip.velocity ?? 1.0,
                pitchOffset: clip.pitchOffset ?? 0,
                pitchOffsetCents: clip.pitchOffsetCents ?? 0,
                reversed: clip.reversed ?? false,
                stretchRatio: clip.stretchRatio ?? 1.0,
                stretchMethod: clip.stretchMethod ?? 0,
                formantPreserve: clip.formantPreserve ?? false,
                fadeInPercent:  clip.fadeInPercent  ?? 0,
                fadeOutPercent: clip.fadeOutPercent ?? 0,
                fadeInX1:  clip.fadeInX1  ?? 0,  fadeInY1:  clip.fadeInY1  ?? 0,
                fadeInX2:  clip.fadeInX2  ?? 1,  fadeInY2:  clip.fadeInY2  ?? 1,
                fadeOutX1: clip.fadeOutX1 ?? 0,  fadeOutY1: clip.fadeOutY1 ?? 0,
                fadeOutX2: clip.fadeOutX2 ?? 1,  fadeOutY2: clip.fadeOutY2 ?? 1,
              }
              console.log('[ClipDuplicate] source clip (raw React state) =',
                JSON.stringify(clip, null, 2))
              console.log('[ClipDuplicate] payload =',
                JSON.stringify(payload, null, 2))
              const newId = await window.xleth?.timeline?.addClip(payload)
              await fetchClips()
              if (newId != null) setSelectedClipIds(new Set([newId]))
              // Advance playhead + editCursor to end of duplicated clip
              const dupEndBeat = (newPositionTicks + clip.durationTicks) / PPQ
              handleSeek(dupEndBeat)
              console.log(`[Keyboard] Duplicated clip ${clipId} → ${newPositionTicks}t, playhead → ${newPositionTicks + clip.durationTicks}t`)
            } catch (err) {
              console.error('[Keyboard] Duplicate failed:', err)
            }
          }
        }
        return
      }

      // ── Toggle pattern-block loop (L) ─────────────────────────────────
      if (!ctrl && (e.key === 'l' || e.key === 'L') && selectedBlockIds.size > 0) {
        e.preventDefault()
        e.stopPropagation()
        const ids = [...selectedBlockIds]
        // Determine new state from the first selected block's current loopEnabled
        // (treat undefined as true for backward compat) — toggle to the opposite,
        // then apply uniformly to all selected blocks so they stay in sync.
        const first = patternBlocks.find(b => b.id === ids[0])
        const nextEnabled = !((first?.loopEnabled ?? true))
        try {
          await Promise.all(ids.map(id =>
            window.xleth?.timeline?.setPatternBlockLoop(id, nextEnabled)
              .catch(err => console.error(`[Keyboard] setPatternBlockLoop(${id}) failed:`, err))
          ))
          await fetchPatternBlocks()
          timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
          console.log(`[Keyboard] Toggled loop → ${nextEnabled} on ${ids.length} block(s)`)
        } catch (err) {
          console.error('[Keyboard] Loop toggle failed:', err)
        }
        return
      }

      // ── Pitch shift selected clips (+/- keys) ────────────────────────
      if ((e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') && selectedClipIds.size > 0) {
        e.preventDefault()
        e.stopPropagation()
        const direction = (e.key === '+' || e.key === '=') ? 1 : -1
        const ids = [...selectedClipIds]
        if (ctrl) {
          // Ctrl +/- = ±1 cent
          await Promise.all(ids.map(id =>
            window.xleth?.timeline?.pitchShiftClip(id, 0, direction)
              .catch(err => console.error(`[Keyboard] pitchShiftClip(${id}) failed:`, err))
          ))
          console.log(`[Keyboard] Pitch ${direction > 0 ? '+' : '-'}1 cent on ${ids.length} clip(s)`)
        } else {
          // +/- = ±1 semitone
          await Promise.all(ids.map(id =>
            window.xleth?.timeline?.pitchShiftClip(id, direction, 0)
              .catch(err => console.error(`[Keyboard] pitchShiftClip(${id}) failed:`, err))
          ))
          console.log(`[Keyboard] Pitch ${direction > 0 ? '+' : '-'}1 semitone on ${ids.length} clip(s)`)
        }
        await fetchClips()
        return
      }

      // ── Tool shortcuts (only when timeline is focused, no Ctrl) ───────
      if (!ctrl && timelineFocusedRef.current) {
        const key = e.key.toLowerCase()
        if (key === 's') {
          const splitTick = beatsToTicks(playheadBeatRef.current)
          const didSplice = await handleSpliceSelectedClips(splitTick)
          if (didSplice) { e.preventDefault(); e.stopPropagation(); return }
          setActiveTool('select')
          console.log('[Keyboard] Tool → Select')
          return
        }
        if (key === 'p') { setActiveTool('pencil');  console.log('[Keyboard] Tool → Pencil');  return }
        if (key === 'c') { setActiveTool('split');   console.log('[Keyboard] Tool → Split');   return }
        if (key === 'd') { setActiveTool('delete');  console.log('[Keyboard] Tool → Delete');  return }

        // ── Syllable pick (1-9) when pencil + Quote with syllables is active ─
        if (activeTool === 'pencil' && /^[1-9]$/.test(e.key)) {
          const tmpl = pencilTemplateRef.current
          const regionId = tmpl ? tmpl.regionId : activeSampleId
          const region = regionId != null ? regions[regionId] : null
          const selectableSyllables = getSelectableSyllables(region?.syllables)
          if (region?.label === 'Quote' && selectableSyllables.length > 0) {
            const idx = parseInt(e.key, 10) - 1
            const selected = selectableSyllables[idx]
            if (selected) {
              handleSelectSyllable(selected.sourceIndex)
              console.log(`[Keyboard] Syllable → ${idx + 1}`)
            }
            return
          }
        }
      }
  }

  useEffect(() => {
    const dispatch = (e) => {
      // Each handled branch in the ref'd handler calls preventDefault
      // synchronously before any await, so defaultPrevented after invoke
      // is a reliable claim signal. No-op branches (e.g. Delete with no
      // selection) leave the event unclaimed and the router falls
      // through to lower-priority scopes — no global binding overlaps
      // TIMELINE_KEY_COMBOS today, but this preserves correct semantics.
      timelineKeyHandlerRef.current?.(e)
      return e.defaultPrevented ? 'handled' : undefined
    }
    const unsubscribers = TIMELINE_KEY_COMBOS.map((combo) =>
      registerKeyboardBinding({ scope: 'panel:timeline', combo, handler: dispatch }),
    )
    return () => { unsubscribers.forEach((u) => u()) }
  }, [])

  // ── Context menu ───────────────────────────────────────────────────────────

  const handleAutoTrimClip = useCallback(async (clipId) => {
    try {
      const result = await window.xleth.timeline.autoTrimClip(clipId, -54)
      console.log('[Timeline] Auto-Trim result:', result)
      if (!result?.success) {
        console.warn('[Timeline] Auto-Trim failed:', result?.reason)
        return
      }
      await fetchClips()
      window.dispatchEvent(new CustomEvent('timeline-clips-changed'))
    } catch (err) {
      console.error('[Timeline] Auto-Trim error:', err)
    }
  }, [fetchClips])

  const handlePitchShiftClip = useCallback(async (clipId, semiDelta, centsDelta = 0) => {
    try {
      await window.xleth.timeline.pitchShiftClip(clipId, semiDelta, centsDelta)
      await fetchClips()
    } catch (err) {
      console.error('[Timeline] pitchShiftClip error:', err)
    }
  }, [fetchClips])

  const handleReverseClip = useCallback(async (clipId) => {
    try {
      await window.xleth.timeline.reverseClip(clipId)
      await fetchClips()
    } catch (err) {
      console.error('[Timeline] reverseClip error:', err)
    }
  }, [fetchClips])

  const handleSetClipStretchMethod = useCallback(async (clipId, method) => {
    console.log(`[UIStretch] setClipStretchMethod: clip=${clipId} method=${method}`)
    try {
      await window.xleth.timeline.setClipParams(clipId, { stretchMethod: method })
      await fetchClips()
    } catch (err) {
      console.error('[Timeline] setClipStretchMethod error:', err)
    }
  }, [fetchClips])

  const handleSetClipFormantPreserve = useCallback(async (clipId, enabled) => {
    console.log(`[UIStretch] setClipFormantPreserve: clip=${clipId} enabled=${enabled}`)
    try {
      await window.xleth.timeline.setClipParams(clipId, { formantPreserve: enabled })
      await fetchClips()
    } catch (err) {
      console.error('[Timeline] setClipFormantPreserve error:', err)
    }
  }, [fetchClips])

  const handleSetClipVelocity = useCallback(async (clipId, velocity) => {
    try {
      await window.xleth.timeline.setClipParams(clipId, { velocity })
      await fetchClips()
    } catch (err) {
      console.error('[Timeline] setClipVelocity error:', err)
    }
  }, [fetchClips])

  const handleSetClipVibrato = useCallback(async (clipId, vibratoPatch) => {
    try {
      const clip = clipsRef.current.find(c => c.id === clipId)
      const merged = mergeClipModulationPatch(clip, {
        vibratoPatch,
        forceEnabled: vibratoPatch.enabled === true,
      })
      await window.xleth.timeline.setClipModulation(clipId, merged)
      await fetchClips()
    } catch (err) {
      console.error('[Timeline] setClipVibrato error:', err)
    }
  }, [fetchClips])

  const handleSetClipScratch = useCallback(async (clipId, scratchPatch, options = {}) => {
    try {
      const clip = clipsRef.current.find(c => c.id === clipId)
      const existingScratch = clip?.modulation?.scratch ?? {}
      let nextPatch = scratchPatch
      let forceEnabled = false

      if (options.presetKey) {
        nextPatch = {
          ...scratchPatch,
          ...scratchPresetPatch(options.presetKey, {
            scratchCount: options.scratchCount,
            lengthBeats: options.lengthBeats,
          }),
        }
        forceEnabled = true
      } else if (scratchPatch.enabled === true) {
        const hasCurve = Array.isArray(existingScratch.curve) && existingScratch.curve.length > 0
        nextPatch = hasCurve
          ? scratchPatch
          : {
              ...scratchPatch,
              timeMode: SCRATCH_PRESETS[0].timeMode,
              curve: cloneScratchCurve(SCRATCH_PRESETS[0].curve),
            }
        forceEnabled = true
      }

      const merged = mergeClipModulationPatch(clip, {
        scratchPatch: nextPatch,
        forceEnabled,
      })
      await window.xleth.timeline.setClipModulation(clipId, merged)
      await fetchClips()
    } catch (err) {
      console.error('[Timeline] setClipScratch error:', err)
    }
  }, [fetchClips])

  const handleSetClipVideoFx = useCallback(async (clipId, videoPatch) => {
    try {
      const clip = clipsRef.current.find(c => c.id === clipId)
      const merged = mergeClipModulationPatch(clip, { videoPatch })
      await window.xleth.timeline.setClipModulation(clipId, merged)
      await fetchClips()
    } catch (err) {
      console.error('[Timeline] setClipVideoFx error:', err)
    }
  }, [fetchClips])

  const handleSetClipFade = useCallback(async (clipId, fadeParams) => {
    try {
      const clip = clipsRef.current.find(c => c.id === clipId)
      let payload = fadeParams
      if (clip && ('fadeInPercent' in fadeParams || 'fadeOutPercent' in fadeParams)) {
        const next = normalizeFadePercents(
          fadeParams.fadeInPercent ?? clipFadePercent(clip, 'in'),
          fadeParams.fadeOutPercent ?? clipFadePercent(clip, 'out')
        )
        payload = {
          ...fadeParams,
          ...next,
          fadeInTicks: Math.round((next.fadeInPercent / 100) * (clip.durationTicks ?? 0)),
          fadeOutTicks: Math.round((next.fadeOutPercent / 100) * (clip.durationTicks ?? 0)),
        }
      }
      await window.xleth.timeline.setClipParams(clipId, payload)
      await fetchClips()
    } catch (err) {
      console.error('[Timeline] setClipFade error:', err)
    }
  }, [fetchClips])

  // Phase G.4: auto-close the quick FX menu if its clip is no longer present
  useEffect(() => {
    if (!quickFxMenu) return
    if (!clips.find(c => c.id === quickFxMenu.clipId)) {
      setQuickFxMenu(null)
    }
  }, [clips, quickFxMenu])

  const closeClipContextMenu = useCallback(() => {
    setContextMenu(null)
    requestAnimationFrame(() => {
      const activeElement = document.activeElement
      if (isInteractiveFocusElement(activeElement)) return
      if (!usePanelRegistry.getState().panels.timeline.focused) return

      focusTimelinePanel('timeline')

      const timelinePanel = timelineViewRef.current?.closest?.('[data-panel-id="timeline"]')
      if (timelinePanel instanceof HTMLElement) {
        timelinePanel.focus()
        timelineFocusedRef.current = true
      } else if (timelineViewRef.current instanceof HTMLElement) {
        timelineViewRef.current.focus()
        timelineFocusedRef.current = true
      }

      if (usePianoRollStore.getState().activeCenterTab !== 'timeline') {
        usePianoRollStore.getState().setActiveCenterTab('timeline')
      }
    })
  }, [focusTimelinePanel])

  const contextMenuClip = contextMenu?.type === 'clip'
    ? clipsRef.current.find(c => c.id === contextMenu.clipId)
    : null
  const contextModulationStatus = getClipModulationStatus(contextMenuClip)

  // ── Phase G.3: live preview draft + thumbnail cache ───────────────────────
  const [videoPreviewDraft, setVideoPreviewDraft] = useState({})
  const thumbCacheRef = useRef(new Map()) // sourceId → dataURL
  const [thumbVersion, setThumbVersion] = useState(0)

  const contextVfx = contextMenuClip?.modulation?.video ?? {}
  const contextRegion = contextMenuClip ? regions[contextMenuClip.regionId] : null
  const contextSource = contextRegion ? sources[contextRegion.sourceId] : null
  const contextHasVideo = !!contextSource && contextSource.hasVideo !== false
  // thumbVersion is read so eslint's exhaustive-deps doesn't complain when we
  // depend on cache reads via the ref.
  void thumbVersion
  const contextThumbDataUrl = contextSource
    ? thumbCacheRef.current.get(contextSource.id) ?? null
    : null

  // Reset draft when committed video vfx changes (post-fetchClips). This is
  // the natural moment — clearing on slider pointer-up causes a one-frame
  // flicker between draft and committed values.
  useEffect(() => {
    setVideoPreviewDraft({})
  }, [
    contextMenu?.clipId,
    contextVfx.swirlAmount, contextVfx.waveAmount,
    contextVfx.waveFrequency, contextVfx.smearAmount,
  ])

  // Lazy-fetch the source thumbnail when the menu opens with Video FX expanded.
  useEffect(() => {
    if (!contextMenu || !videoModSectionOpen) return
    if (!contextHasVideo) return
    if (contextThumbDataUrl) return
    if (!contextSource?.filePath) return
    let cancelled = false
    ;(async () => {
      try {
        const url = await window.xleth?.project
          ?.getSourceThumbnail(contextSource.filePath, contextSource.duration)
        if (!cancelled && url) {
          thumbCacheRef.current.set(contextSource.id, url)
          setThumbVersion(v => v + 1)
        }
      } catch (e) {
        console.warn('[ClipFxPreview] thumbnail fetch failed', e)
      }
    })()
    return () => { cancelled = true }
  }, [
    contextMenu, videoModSectionOpen,
    contextSource?.id, contextSource?.filePath, contextSource?.duration,
    contextHasVideo, contextThumbDataUrl,
  ])

  const contextMenuItems = contextMenu
    ? (contextMenu.type === 'clip'
        ? [
            { label: 'Auto-Trim Silence (−54 dB)', onClick: () => handleAutoTrimClip(contextMenu.clipId) },
            { type: 'separator' },
            {
              type: 'custom', key: 'volume-slider',
              content: (
                <ClipSliderRow
                  label="Volume"
                  value={Math.round((contextMenuClip?.velocity ?? 1.0) * 100)}
                  min={0} max={200} step={1}
                  onCommit={(v) => handleSetClipVelocity(contextMenu.clipId, v / 100)}
                  formatValue={(v) => `${v}%`}
                />
              ),
            },
            {
              type: 'custom', key: 'fade-in',
              content: (
                <div>
                  <ClipSliderRow
                    label="Fade In"
                    value={contextMenuClip?.fadeInPercent ?? 0}
                    min={0} max={100} step={1}
                    onCommit={(v) => handleSetClipFade(contextMenu.clipId, { fadeInPercent: v })}
                    formatValue={(v) => `${Math.round(v)}%`}
                  />
                  {(contextMenuClip?.fadeInPercent ?? 0) > 0 && (
                    <div style={{ padding: '0 8px 6px' }}>
                      <FadeBezierEditor
                        x1={contextMenuClip?.fadeInX1 ?? 0} y1={contextMenuClip?.fadeInY1 ?? 0}
                        x2={contextMenuClip?.fadeInX2 ?? 1} y2={contextMenuClip?.fadeInY2 ?? 1}
                        type="fadeIn" width={180} height={100}
                        onChange={(fx1, fy1, fx2, fy2) => handleSetClipFade(contextMenu.clipId, {
                          fadeInX1: fx1, fadeInY1: fy1, fadeInX2: fx2, fadeInY2: fy2,
                        })}
                      />
                    </div>
                  )}
                </div>
              ),
            },
            {
              type: 'custom', key: 'fade-out',
              content: (
                <div>
                  <ClipSliderRow
                    label="Fade Out"
                    value={contextMenuClip?.fadeOutPercent ?? 0}
                    min={0} max={100} step={1}
                    onCommit={(v) => handleSetClipFade(contextMenu.clipId, { fadeOutPercent: v })}
                    formatValue={(v) => `${Math.round(v)}%`}
                  />
                  {(contextMenuClip?.fadeOutPercent ?? 0) > 0 && (
                    <div style={{ padding: '0 8px 6px' }}>
                      <FadeBezierEditor
                        x1={contextMenuClip?.fadeOutX1 ?? 0} y1={contextMenuClip?.fadeOutY1 ?? 0}
                        x2={contextMenuClip?.fadeOutX2 ?? 1} y2={contextMenuClip?.fadeOutY2 ?? 1}
                        type="fadeOut" width={180} height={100}
                        onChange={(fx1, fy1, fx2, fy2) => handleSetClipFade(contextMenu.clipId, {
                          fadeOutX1: fx1, fadeOutY1: fy1, fadeOutX2: fx2, fadeOutY2: fy2,
                        })}
                      />
                    </div>
                  )}
                </div>
              ),
            },
            { type: 'separator' },
            {
              label: contextMenuClip?.reversed ? '✓ Reverse' : 'Reverse',
              onClick: () => handleReverseClip(contextMenu.clipId),
            },
            { type: 'separator' },
            {
              label: (contextMenuClip?.stretchMethod ?? 0) === 0
                ? `● Method: Global (${getGlobalStretchMethodLabel(globalStretchMethod)})`
                : `○ Method: Global (${getGlobalStretchMethodLabel(globalStretchMethod)})`,
              onClick: () => handleSetClipStretchMethod(contextMenu.clipId, 0),
            },
            {
              label: contextMenuClip?.stretchMethod === 1
                ? `● Method: ${getGlobalStretchMethodLabel(1)}`
                : `○ Method: ${getGlobalStretchMethodLabel(1)}`,
              onClick: () => handleSetClipStretchMethod(contextMenu.clipId, 1),
            },
            {
              label: contextMenuClip?.stretchMethod === 2
                ? `● Method: ${getGlobalStretchMethodLabel(2)}`
                : `○ Method: ${getGlobalStretchMethodLabel(2)}`,
              onClick: () => handleSetClipStretchMethod(contextMenu.clipId, 2),
            },
            {
              label: contextMenuClip?.stretchMethod === 3
                ? `● Method: ${getGlobalStretchMethodLabel(3)}`
                : `○ Method: ${getGlobalStretchMethodLabel(3)}`,
              onClick: () => handleSetClipStretchMethod(contextMenu.clipId, 3),
            },
            {
              label: contextMenuClip?.stretchMethod === 5
                ? `● Method: ${getGlobalStretchMethodLabel(5)}`
                : `○ Method: ${getGlobalStretchMethodLabel(5)}`,
              onClick: () => handleSetClipStretchMethod(contextMenu.clipId, 5),
            },
            {
              label: contextMenuClip?.stretchMethod === 4
                ? `● Method: ${getGlobalStretchMethodLabel(4)}`
                : `○ Method: ${getGlobalStretchMethodLabel(4)}`,
              onClick: () => handleSetClipStretchMethod(contextMenu.clipId, 4),
            },
            {
              label: contextMenuClip?.formantPreserve ? '✓ Formant Preserve' : 'Formant Preserve',
              onClick: () => handleSetClipFormantPreserve(contextMenu.clipId, !contextMenuClip?.formantPreserve),
            },
            { type: 'separator' },
            {
              type: 'custom', key: 'clip-modulation-group',
              content: (() => {
                const status = contextModulationStatus
                const pillColor =
                  status.kind === 'bypassed' ? 'var(--theme-semantic-warning-text)'
                  : status.kind === 'active'  ? 'var(--theme-semantic-success-text, var(--theme-text-secondary, #ddd))'
                  : status.kind === 'saved'   ? 'var(--theme-semantic-info-text, var(--theme-text-secondary, #bbb))'
                  : 'var(--theme-text-tertiary, #888)'

                const v = contextMenuClip?.modulation?.vibrato ?? {}
                const vibEnabled = v.enabled ?? false
                const vibRateMode = v.rateMode ?? 'freeHz'
                const onVibEnable = (e) => {
                  const next = e.target.checked
                  if (next && !v.enabled && (v.depthCents ?? 0) === 0) {
                    handleSetClipVibrato(contextMenu.clipId, { ...VIBRATO_DEFAULTS, enabled: true })
                  } else {
                    handleSetClipVibrato(contextMenu.clipId, { enabled: next })
                  }
                }

                const s = contextMenuClip?.modulation?.scratch ?? {}
                const scrEnabled = s.enabled ?? false
                const scrPresetKey = scratchPresetKeyForScratch(s)
                const babySettings = inferBabyScratchSettings(s) ?? {
                  count: SCRATCH_BABY_DEFAULT_COUNT,
                  lengthBeats: SCRATCH_BABY_DEFAULT_LENGTH_BEATS,
                }
                const showBabyScratchControls = scrPresetKey === 'babyScratch'
                const onScrEnable = (e) => {
                  handleSetClipScratch(contextMenu.clipId, { enabled: e.target.checked })
                }
                const updateBabyScratch = (patch) => {
                  handleSetClipScratch(contextMenu.clipId, {}, {
                    presetKey: 'babyScratch',
                    scratchCount: patch.count ?? babySettings.count,
                    lengthBeats: patch.lengthBeats ?? babySettings.lengthBeats,
                  })
                }

                const vfx = contextMenuClip?.modulation?.video ?? {}
                const swirlOn = vfx.vibratoSwirlEnabled ?? false
                const waveOn  = vfx.scratchWaveEnabled ?? false
                const setVideo = (patch) => handleSetClipVideoFx(contextMenu.clipId, patch)

                const stopFocus = (e) => { e.preventDefault(); e.stopPropagation() }
                const headerStyle = {
                  width: '100%', textAlign: 'left',
                  background: 'transparent', border: 'none',
                  padding: '4px 8px', fontSize: 11, color: '#aaa',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                  fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase',
                }

                return (
                  <div>
                    <div style={{ padding: '4px 8px 2px', fontSize: 11, color: '#aaa', fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase' }}>
                      Clip Modulation
                    </div>
                    <div style={{ padding: '2px 8px 4px', display: 'flex', alignItems: 'center', gap: 6, maxWidth: 240, lineHeight: 1.25 }}>
                      <span style={{
                        fontSize: 9, fontWeight: 700, letterSpacing: 0.4,
                        padding: '1px 6px', borderRadius: 999,
                        border: '1px solid var(--theme-border-subtle, #444)',
                        color: pillColor, textTransform: 'uppercase',
                      }}>{status.kind}</span>
                      <span style={{ fontSize: 11, color: '#bbb', flex: 1 }}>{status.label}</span>
                    </div>

                    <button
                      type="button"
                      onMouseDown={stopFocus}
                      onClick={() => setAudioModSectionOpen(o => !o)}
                      style={headerStyle}
                    >
                      <span style={{ display: 'inline-block', width: 10 }}>{audioModSectionOpen ? '▾' : '▸'}</span>
                      Audio Modulation
                    </button>

                    {audioModSectionOpen && (
                      <>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px 2px 18px', fontSize: 12 }}>
                          <input type="checkbox" checked={vibEnabled} onChange={onVibEnable} />
                          Vibrato
                        </label>
                        {vibEnabled && (
                          <div style={{ paddingLeft: 10 }}>
                            <ClipSliderRow
                              label="Depth"
                              value={Math.round(v.depthCents ?? 0)}
                              min={0} max={1200} step={1}
                              onCommit={(val) => handleSetClipVibrato(contextMenu.clipId, { depthCents: val })}
                              formatValue={(val) => `${val} ¢`}
                            />
                            <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                              <span style={{ fontSize: 11, color: '#aaa', minWidth: 40 }}>Rate</span>
                              <select
                                value={vibRateMode}
                                onChange={(e) => handleSetClipVibrato(contextMenu.clipId, { rateMode: e.target.value })}
                                style={{ flex: 1 }}
                              >
                                <option value="freeHz">Free</option>
                                <option value="tempoSync">Sync</option>
                              </select>
                            </div>
                            {vibRateMode === 'freeHz' ? (
                              <ClipSliderRow
                                label="Hz"
                                value={Number((v.rateHz ?? 5.0).toFixed(2))}
                                min={0.01} max={20} step={0.01}
                                onCommit={(val) => handleSetClipVibrato(contextMenu.clipId, { rateHz: val })}
                                formatValue={(val) => `${val.toFixed(2)} Hz`}
                              />
                            ) : (
                              <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                                <span style={{ fontSize: 11, color: '#aaa', minWidth: 40 }}>Sync</span>
                                <select
                                  value={v.syncDivision ?? 'eighth'}
                                  onChange={(e) => handleSetClipVibrato(contextMenu.clipId, { syncDivision: e.target.value })}
                                  style={{ flex: 1 }}
                                >
                                  {VIBRATO_SYNC_DIVISIONS.map(([val, lbl]) => <option key={val} value={val}>{lbl}</option>)}
                                </select>
                              </div>
                            )}
                            <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                              <span style={{ fontSize: 11, color: '#aaa', minWidth: 40 }}>Shape</span>
                              <select
                                value={v.shape ?? 'sine'}
                                onChange={(e) => handleSetClipVibrato(contextMenu.clipId, { shape: e.target.value })}
                                style={{ flex: 1 }}
                              >
                                {VIBRATO_SHAPES.map(([val, lbl]) => <option key={val} value={val}>{lbl}</option>)}
                              </select>
                            </div>
                          </div>
                        )}

                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px 2px 18px', fontSize: 12 }}>
                          <input type="checkbox" checked={scrEnabled} onChange={onScrEnable} />
                          Scratch
                        </label>
                        {scrEnabled && (
                          <div style={{ paddingLeft: 10 }}>
                            <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                              <span style={{ fontSize: 11, color: '#aaa', minWidth: 40 }}>Preset</span>
                              <select
                                value={scrPresetKey}
                                onChange={(e) => {
                                  if (e.target.value !== 'custom') handleSetClipScratch(contextMenu.clipId, {}, { presetKey: e.target.value })
                                }}
                                style={{ flex: 1 }}
                              >
                                <option value="custom" disabled>Custom</option>
                                {SCRATCH_PRESETS.map(preset => (
                                  <option key={preset.key} value={preset.key}>{preset.label}</option>
                                ))}
                              </select>
                            </div>
                            <ClipSliderRow
                              label="Smooth"
                              value={Number((s.smoothingMs ?? SCRATCH_DEFAULTS.smoothingMs).toFixed(1))}
                              min={0} max={50} step={0.1}
                              onCommit={(val) => handleSetClipScratch(contextMenu.clipId, { smoothingMs: val })}
                              formatValue={(val) => `${Number(val).toFixed(1)} ms`}
                            />
                            <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                              <span style={{ fontSize: 11, color: '#aaa', minWidth: 40 }}>Edge</span>
                              <select
                                value={s.edgeMode ?? SCRATCH_DEFAULTS.edgeMode}
                                onChange={(e) => handleSetClipScratch(contextMenu.clipId, { edgeMode: e.target.value })}
                                style={{ flex: 1 }}
                              >
                                {SCRATCH_EDGE_MODES.map(([val, lbl]) => <option key={val} value={val}>{lbl}</option>)}
                              </select>
                            </div>
                            {showBabyScratchControls && (
                              <>
                                <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                                  <span style={{ fontSize: 11, color: '#aaa', minWidth: 78 }}>Scratch Count</span>
                                  <input
                                    type="range" min={1} max={8} step={1}
                                    value={babySettings.count}
                                    onChange={(e) => updateBabyScratch({ count: clampScratchCount(e.target.value) })}
                                    style={{ flex: 1, accentColor: 'var(--theme-border-focus)' }}
                                  />
                                  <input
                                    type="number" min={1} max={8} step={1}
                                    value={babySettings.count}
                                    onChange={(e) => updateBabyScratch({ count: clampScratchCount(e.target.value) })}
                                    style={{ width: 44 }}
                                  />
                                </div>
                                <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                                  <span style={{ fontSize: 11, color: '#aaa', minWidth: 78 }}>Length</span>
                                  <select
                                    value={babySettings.lengthBeats}
                                    onChange={(e) => updateBabyScratch({ lengthBeats: normalizeScratchLengthBeats(e.target.value) })}
                                    style={{ flex: 1 }}
                                  >
                                    {SCRATCH_BABY_LENGTHS.map(([length, label]) => (
                                      <option key={length} value={length}>{label}</option>
                                    ))}
                                  </select>
                                </div>
                              </>
                            )}
                            <div style={{ padding: '2px 8px 6px', fontSize: 11, color: '#888' }}>
                              {scratchCurveSummary(s)}
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    <button
                      type="button"
                      onMouseDown={stopFocus}
                      onClick={() => setVideoModSectionOpen(o => !o)}
                      style={headerStyle}
                    >
                      <span style={{ display: 'inline-block', width: 10 }}>{videoModSectionOpen ? '▾' : '▸'}</span>
                      Video Companion FX
                    </button>

                    {videoModSectionOpen && (
                      <>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px 2px 18px', fontSize: 12 }}>
                          <input
                            type="checkbox"
                            checked={swirlOn}
                            onChange={(e) => setVideo({ vibratoSwirlEnabled: e.target.checked })}
                          />
                          Swirl with Vibrato
                        </label>
                        {swirlOn && !vibEnabled && (
                          <div style={{ padding: '0 8px 2px 28px', fontSize: 10, color: '#888' }}>
                            Activates when Vibrato is enabled.
                          </div>
                        )}
                        {swirlOn && (
                          <div style={{ paddingLeft: 10 }}>
                            <ClipSliderRow
                              label="Swirl"
                              value={Number((vfx.swirlAmount ?? 0.25).toFixed(2))}
                              min={-1} max={1} step={0.01}
                              onCommit={(val) => setVideo({ swirlAmount: val })}
                              onPreviewChange={(v) => setVideoPreviewDraft(d => ({ ...d, swirlAmount: v }))}
                              formatValue={(val) => Number(val).toFixed(2)}
                            />
                          </div>
                        )}

                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px 2px 18px', fontSize: 12 }}>
                          <input
                            type="checkbox"
                            checked={waveOn}
                            onChange={(e) => setVideo({ scratchWaveEnabled: e.target.checked })}
                          />
                          Wave with Scratch
                        </label>
                        {waveOn && !scrEnabled && (
                          <div style={{ padding: '0 8px 2px 28px', fontSize: 10, color: '#888' }}>
                            Activates when Scratch is enabled.
                          </div>
                        )}
                        {waveOn && (
                          <div style={{ paddingLeft: 10 }}>
                            <ClipSliderRow
                              label="Wave"
                              value={Number((vfx.waveAmount ?? 0.08).toFixed(2))}
                              min={-1} max={1} step={0.01}
                              onCommit={(val) => setVideo({ waveAmount: val })}
                              onPreviewChange={(v) => setVideoPreviewDraft(d => ({ ...d, waveAmount: v }))}
                              formatValue={(val) => Number(val).toFixed(2)}
                            />
                            <ClipSliderRow
                              label="Freq"
                              value={Number((vfx.waveFrequency ?? 8).toFixed(2))}
                              min={0.25} max={64} step={0.25}
                              onCommit={(val) => setVideo({ waveFrequency: val })}
                              onPreviewChange={(v) => setVideoPreviewDraft(d => ({ ...d, waveFrequency: v }))}
                              formatValue={(val) => `${Number(val).toFixed(2)}×`}
                            />
                            <ClipSliderRow
                              label="Smear"
                              value={Number((vfx.smearAmount ?? 0).toFixed(2))}
                              min={-1} max={1} step={0.01}
                              onCommit={(val) => setVideo({ smearAmount: val })}
                              onPreviewChange={(v) => setVideoPreviewDraft(d => ({ ...d, smearAmount: v }))}
                              formatValue={(val) => Number(val).toFixed(2)}
                            />
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px', fontSize: 12 }}>
                              <input
                                type="checkbox"
                                checked={vfx.reverseWaveWithScratch ?? true}
                                onChange={(e) => setVideo({ reverseWaveWithScratch: e.target.checked })}
                              />
                              Reverse Wave with Scratch
                            </label>
                          </div>
                        )}

                        {(swirlOn || waveOn) && (() => {
                          const reversed = !!contextMenuClip?.reversed
                          const formantPreserve = !!contextMenuClip?.formantPreserve
                          const disabledReason =
                            (reversed || formantPreserve)  ? 'Preview bypassed for this clip.'
                          : !contextHasVideo               ? 'Preview unavailable for this clip.'
                          : null
                          const effectiveVfx = { ...vfx, ...videoPreviewDraft }
                          return (
                            <ClipFxPreview
                              thumbDataUrl={contextThumbDataUrl}
                              vfx={effectiveVfx}
                              swirlOn={swirlOn}
                              waveOn={waveOn}
                              disabledReason={disabledReason}
                            />
                          )
                        })()}
                      </>
                    )}
                  </div>
                )
              })(),
            },
            { label: 'Delete', danger: true, onClick: () => handleDeleteClip(contextMenu.clipId) },
          ]
        : [
            { label: 'Rename', onClick: () => { /* focus rename */ } },
            { label: 'Duplicate', onClick: () => handleAddTrack() },
            { type: 'separator' },
            { label: 'Delete Track', danger: true, onClick: () => handleRemove(contextMenu.trackId) },
          ])
    : []

  // ── Timeline focus tracking (for keyboard shortcut gating) ─────────────────

  useEffect(() => {
    const onMouseDown = (e) => {
      const inTimeline = !!timelineViewRef.current?.contains(e.target)
      timelineFocusedRef.current = inTimeline
      // Scenario A: user clicks into timeline while piano roll was active.
      // Claim activeCenterTab so the keyboard gate at line 1791 passes through.
      // TODO: remove when central keyboard router replaces activeCenterTab —
      // trigger: when unified keyboard-focus router lands and line 1791 is gone.
      if (inTimeline && usePianoRollStore.getState().activeCenterTab !== 'timeline')
        usePianoRollStore.getState().setActiveCenterTab('timeline')
    }
    window.addEventListener('mousedown', onMouseDown, true)
    return () => window.removeEventListener('mousedown', onMouseDown, true)
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  const hasTracks = tracks.length > 0

  return (
    <div className="timeline-view" ref={timelineViewRef} tabIndex={-1}>
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <TimelineToolbar
        activeTool={activeTool}
        setActiveTool={setActiveTool}
        activeSampleId={activeSampleId}
        regions={regions}
        snapGranularity={snapGranularity}
        onSnapGranularityChange={setSnapGranularity}
        pixelsPerBeat={pixelsPerBeat}
        onAddTrack={handleAddTrack}
        pencilTemplate={pencilTemplate}
        onSelectSyllable={handleSelectSyllable}
        declickMs={declickMs}
        onDeclickChange={handleDeclick}
        onOpenQuantize={() => setQuantizeOpen(true)}
        quantizeSelectionCount={selectedClipIds.size + selectedBlockIds.size}
      />

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="timeline-body" ref={timelineBodyRef}>
        {headerDragLineX !== null && (
          <div className="timeline-header-drag-line" style={{ left: headerDragLineX }} />
        )}
        {hasTracks ? (
          <>
            {/* Left-most: pattern list (FL-style strip) */}
            <PatternListPanel
              patterns={patterns}
              collapsed={patternListCollapsed}
              onToggleCollapsed={() => setPatternListCollapsed(v => !v)}
              onOpenPianoRoll={(patternId) => {
                timelineEvents.dispatchEvent(new CustomEvent('open-piano-roll', { detail: { patternId } }))
              }}
              onRename={handlePatternRename}
            />

            {/* Left: track headers */}
            <TrackHeaderList
              tracks={tracks}
              patterns={patterns}
              currentPatternIdByTrack={currentPatternIdByTrack}
              focusedTrackId={focusedTrackId}
              onFocusTrack={setFocusedTrackId}
              onAddTrack={handleAddTrack}
              onMute={handleMute}
              onSolo={handleSolo}
              onVisualOnly={handleVisualOnly}
              onRename={handleRename}
              onRemove={handleRemove}
              onReorder={handleReorder}
              onRequestContextMenu={handleRequestTrackContextMenu}
              onSetTrackColor={handleSetTrackColor}
              scrollContainerRef={scrollContainerRef}
              width={timelineTrackHeaderWidth}
              macroRows={trackLayout.macroRows}
              onHideMacroLane={(trackId, macroNodeId) =>
                useEffectChainStore.getState().hideMacroAutomationLaneForTrack?.(trackId, macroNodeId)}
            />

            {/* Resize handle — 4px drag zone between header column and canvas */}
            <div
              className="timeline-header-resize-handle"
              onMouseDown={handleHeaderResizeStart}
            />

            {/* Right: canvas area */}
            <div className="timeline-canvas-area" ref={canvasAreaRef}>
              <TimelineRuler
                ref={rulerRef}
                pixelsPerBeatRef={pixelsPerBeatRef}
                scrollOffsetRef={scrollOffsetRef}
                playheadBeatRef={playheadBeatRef}
                onSeek={handleSeek}
                onWheel={handleWheel}
              />
              <div
                className="timeline-canvas-scroll"
                ref={scrollContainerRef}
                onScroll={(e) => {
                  // Sync vertical scroll to track headers
                  const headerScroll = document.querySelector('.timeline-header-scroll')
                  if (headerScroll && headerScroll.scrollTop !== e.currentTarget.scrollTop) {
                    headerScroll.scrollTop = e.currentTarget.scrollTop
                  }
                }}
              >
                <TimelineCanvas
                  ref={canvasRef}
                  trackCount={tracks.length}
                  pixelsPerBeatRef={pixelsPerBeatRef}
                  scrollOffsetRef={scrollOffsetRef}
                  playheadBeatRef={playheadBeatRef}
                  onWheel={handleWheel}
                  clips={clips}
                  regions={regions}
                  tracks={tracks}
                  selectedClipIds={selectedClipIds}
                  dropPreviewRef={dropPreviewRef}
                  waveformCacheRef={waveformCacheRef}
                  hiResCacheRef={hiResCacheRef}
                  clipPeakCacheRef={clipPeakCacheRef}
                  bpmRef={bpmRef}
                  activeTool={activeTool}
                  stickyNoteLength={stickyNoteLength}
                  setStickyNoteLength={setStickyNoteLength}
                  activeSampleId={activeSampleId}
                  snapGranularity={snapGranularity}
                  onCreateClip={handleCreateClip}
                  onDeleteClip={handleDeleteClip}
                  onMoveClip={handleMoveClip}
                  onResizeClip={handleResizeClip}
                  onResizeClipLeft={handleResizeClipLeft}
                  onStretchClip={handleStretchClip}
                  onStretchClipLeft={handleStretchClipLeft}
                  onSplitClip={handleSplitClip}
                  onRequestClipContextMenu={(clipId, x, y) => {
                    setQuickFxMenu(null)
                    setContextMenu({ type: 'clip', clipId, x, y })
                  }}
                  onOpenClipFxQuickMenu={(clipId, anchor) => {
                    setContextMenu(null)
                    setQuickFxMenu({ clipId, x: anchor.x, y: anchor.y })
                  }}
                  scrollOffset={scrollOffset}
                  pixelsPerBeat={pixelsPerBeat}
                  trackLayout={trackLayout}
                  setSelectedClipIds={setSelectedClipIds}
                  onFocusTrack={setFocusedTrackId}
                  pencilTemplateRef={pencilTemplateRef}
                  onSetPencilTemplate={updatePencilTemplate}
                  onCanvasDragOver={handleCanvasDragOver}
                  onCanvasDrop={handleCanvasDrop}
                  onCanvasDragLeave={handleCanvasDragLeave}
                  patternBlocks={patternBlocks}
                  patterns={patterns}
                  selectedBlockIds={selectedBlockIds}
                  setSelectedBlockIds={setSelectedBlockIds}
                  currentPatternIdByTrack={currentPatternIdByTrack}
                  onCreatePatternBlock={handleCreatePatternBlock}
                  onMovePatternBlock={handleMovePatternBlock}
                  onResizePatternBlock={handleResizePatternBlock}
                  onResizePatternBlockLeft={handleResizePatternBlockLeft}
                  onDeletePatternBlock={handleDeletePatternBlock}
                  onSplitPatternBlock={handleSplitPatternBlock}
                  onOpenPianoRoll={(patternId, blockId) => {
                    timelineEvents.dispatchEvent(new CustomEvent('open-piano-roll', { detail: { patternId, blockId } }))
                  }}
                  timelineDisplaySettings={timelineDisplaySettings}
                />
                <MacroAutomationLanes
                  trackLayout={trackLayout}
                  graphStates={graphStates}
                  pixelsPerBeat={pixelsPerBeat}
                  scrollOffset={scrollOffset}
                  snapGranularity={snapGranularity}
                />
              </div>
              <TimelineScrollbar
                scrollOffsetRef={scrollOffsetRef}
                pixelsPerBeatRef={pixelsPerBeatRef}
                totalBeats={totalBeats}
                canvasWidth={canvasWidth}
                onScroll={(delta) => { markUserScrolling(); scrollBy(delta) }}
                onScrollTo={(beat) => { markUserScrolling(); scrollTo(beat) }}
                scrollOffset={scrollOffset}
                pixelsPerBeat={pixelsPerBeat}
              />
            </div>
          </>
        ) : (
          /* ── Empty state ──────────────────────────────────────────────── */
          <div className="timeline-empty">
            <Layers size={36} strokeWidth={1} className="tab-placeholder-icon" />
            <p>No tracks yet</p>
            <p className="tab-placeholder-hint">Click + to add tracks to the timeline</p>
            <button className="timeline-empty-add" onClick={handleAddTrack}>
              <Plus size={14} />
              <span>Add Track</span>
            </button>
          </div>
        )}
      </div>

      {/* ── Context menu ─────────────────────────────────────────────────── */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={closeClipContextMenu}
        />
      )}

      {/* ── Phase G.4: Quick FX menu (anchored to on-clip FX badge) ─────── */}
      {quickFxMenu && (() => {
        const clip = clipsRef.current.find(c => c.id === quickFxMenu.clipId)
        if (!clip) return null
        const mod = clip?.modulation ?? {}
        const v = mod.vibrato ?? {}
        const s = mod.scratch ?? {}
        const vfx = mod.video ?? {}
        const reversed = !!clip?.reversed
        const formant = !!clip?.formantPreserve
        const vibratoOn = !!(mod.enabled && v.enabled)
        const scratchOn = !!(mod.enabled && s.enabled)
        const swirlSaved = !!vfx.vibratoSwirlEnabled
        const waveSaved  = !!vfx.scratchWaveEnabled
        const presetKey = scratchPresetKeyForScratch(s)
        const showBabyScratchControls = scratchOn && presetKey === 'babyScratch'
        const babySettings = inferBabyScratchSettings(s) ?? {
          count: SCRATCH_BABY_DEFAULT_COUNT,
          lengthBeats: SCRATCH_BABY_DEFAULT_LENGTH_BEATS,
        }
        const updateBabyScratch = (patch) => {
          handleSetClipScratch(clip.id, {}, {
            presetKey: 'babyScratch',
            scratchCount: patch.count ?? babySettings.count,
            lengthBeats: patch.lengthBeats ?? babySettings.lengthBeats,
          })
        }
        const stopFocusQ = (e) => { e.preventDefault(); e.stopPropagation() }
        const sectionLabel = {
          padding: '4px 8px 0', fontSize: 10, color: '#aaa',
          fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase',
        }
        const tinyHint = {
          padding: '0 8px 4px', fontSize: 10,
          color: 'var(--theme-text-tertiary, #888)',
        }
        const content = (
          <div style={{ minWidth: 230, maxWidth: 260 }}>
            <div
              onMouseDown={stopFocusQ}
              style={{
                padding: '4px 8px', fontSize: 11, color: '#aaa',
                fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
                borderBottom: '1px solid var(--theme-border-subtle, #333)',
              }}
            >Quick FX</div>

            {(reversed || formant) && (
              <div style={{ padding: '4px 8px 2px' }}>
                {reversed && (
                  <div style={{ fontSize: 11, color: 'var(--theme-semantic-warning-text)' }}>
                    Bypassed: Reverse
                  </div>
                )}
                {formant && (
                  <div style={{ fontSize: 11, color: 'var(--theme-semantic-warning-text)' }}>
                    Bypassed: Formant
                  </div>
                )}
              </div>
            )}

            {vibratoOn && (
              <>
                <div style={sectionLabel}>Vibrato</div>
                <ClipSliderRow
                  label="Vib Depth"
                  value={Math.round(v.depthCents ?? 0)}
                  min={0} max={1200} step={1}
                  onCommit={(val) => handleSetClipVibrato(clip.id, { depthCents: val })}
                  formatValue={(val) => `${val} ¢`}
                />
                {v.rateMode === 'tempoSync' ? (
                  <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <span style={{ fontSize: 11, color: '#aaa', minWidth: 60 }}>Vib Sync</span>
                    <select
                      value={v.syncDivision ?? 'eighth'}
                      onChange={(e) => handleSetClipVibrato(clip.id, { syncDivision: e.target.value })}
                      style={{ flex: 1 }}
                    >
                      {VIBRATO_SYNC_DIVISIONS.map(([val, lbl]) => <option key={val} value={val}>{lbl}</option>)}
                    </select>
                  </div>
                ) : (
                  <ClipSliderRow
                    label="Vib Rate"
                    value={Number((v.rateHz ?? 5).toFixed(2))}
                    min={0.1} max={20} step={0.1}
                    onCommit={(val) => handleSetClipVibrato(clip.id, { rateHz: val })}
                    formatValue={(val) => `${val.toFixed(2)} Hz`}
                  />
                )}
              </>
            )}

            {scratchOn && (
              <>
                <div style={sectionLabel}>Scratch</div>
                <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <span style={{ fontSize: 11, color: '#aaa', minWidth: 60 }}>Preset</span>
                  <select
                    value={presetKey}
                    onChange={(e) => {
                      if (e.target.value !== 'custom') handleSetClipScratch(clip.id, {}, { presetKey: e.target.value })
                    }}
                    style={{ flex: 1 }}
                  >
                    <option value="custom" disabled>Custom</option>
                    {SCRATCH_PRESETS.map(preset => (
                      <option key={preset.key} value={preset.key}>{preset.label}</option>
                    ))}
                  </select>
                </div>
                <ClipSliderRow
                  label="Scratch Smooth"
                  value={Number((s.smoothingMs ?? SCRATCH_DEFAULTS.smoothingMs).toFixed(1))}
                  min={0} max={50} step={0.1}
                  onCommit={(val) => handleSetClipScratch(clip.id, { smoothingMs: val })}
                  formatValue={(val) => `${Number(val).toFixed(1)} ms`}
                />
                {showBabyScratchControls && (
                  <>
                    <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <span style={{ fontSize: 11, color: '#aaa', minWidth: 78 }}>Scratch Count</span>
                      <input
                        type="range" min={1} max={8} step={1}
                        value={babySettings.count}
                        onChange={(e) => updateBabyScratch({ count: clampScratchCount(e.target.value) })}
                        style={{ flex: 1, accentColor: 'var(--theme-border-focus)' }}
                      />
                      <input
                        type="number" min={1} max={8} step={1}
                        value={babySettings.count}
                        onChange={(e) => updateBabyScratch({ count: clampScratchCount(e.target.value) })}
                        style={{ width: 44 }}
                      />
                    </div>
                    <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <span style={{ fontSize: 11, color: '#aaa', minWidth: 78 }}>Length</span>
                      <select
                        value={babySettings.lengthBeats}
                        onChange={(e) => updateBabyScratch({ lengthBeats: normalizeScratchLengthBeats(e.target.value) })}
                        style={{ flex: 1 }}
                      >
                        {SCRATCH_BABY_LENGTHS.map(([length, label]) => (
                          <option key={length} value={length}>{label}</option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
              </>
            )}

            {swirlSaved && (
              <>
                <div style={sectionLabel}>Video Swirl</div>
                <ClipSliderRow
                  label="Swirl"
                  value={Number((vfx.swirlAmount ?? 0.25).toFixed(2))}
                  min={-1} max={1} step={0.01}
                  onCommit={(val) => handleSetClipVideoFx(clip.id, { swirlAmount: val })}
                  formatValue={(val) => Number(val).toFixed(2)}
                />
                {!vibratoOn && (
                  <div style={tinyHint}>Waiting for Vibrato</div>
                )}
              </>
            )}

            {waveSaved && (
              <>
                <div style={sectionLabel}>Video Wave</div>
                <ClipSliderRow
                  label="Wave"
                  value={Number((vfx.waveAmount ?? 0.08).toFixed(2))}
                  min={-1} max={1} step={0.01}
                  onCommit={(val) => handleSetClipVideoFx(clip.id, { waveAmount: val })}
                  formatValue={(val) => Number(val).toFixed(2)}
                />
                <ClipSliderRow
                  label="Freq"
                  value={Number((vfx.waveFrequency ?? 8).toFixed(2))}
                  min={0.25} max={64} step={0.25}
                  onCommit={(val) => handleSetClipVideoFx(clip.id, { waveFrequency: val })}
                  formatValue={(val) => `${Number(val).toFixed(2)}×`}
                />
                <ClipSliderRow
                  label="Smear"
                  value={Number((vfx.smearAmount ?? 0).toFixed(2))}
                  min={-1} max={1} step={0.01}
                  onCommit={(val) => handleSetClipVideoFx(clip.id, { smearAmount: val })}
                  formatValue={(val) => Number(val).toFixed(2)}
                />
                {!scratchOn && (
                  <div style={tinyHint}>Waiting for Scratch</div>
                )}
              </>
            )}
          </div>
        )
        return (
          <ContextMenu
            x={quickFxMenu.x}
            y={quickFxMenu.y}
            items={[{ type: 'custom', key: 'quick-fx', content }]}
            onClose={() => setQuickFxMenu(null)}
          />
        )
      })()}

      {/* ── Track context menu (pattern/clip track actions) ──────────────── */}
      {trackMenu && (
        <TrackContextMenu
          x={trackMenu.x}
          y={trackMenu.y}
          items={buildTrackMenuItems(trackMenu.track)}
          onClose={() => setTrackMenu(null)}
        />
      )}

      {/* ── Track Flip Properties popover (replaces the legacy submenu) ──── */}
      {flipPanel && (
        <TrackFlipPropertiesPanel
          // Look the track up from the live `tracks` array so undo/redo and
          // remote commits propagate into the panel without remounting it.
          track={tracks.find(t => t.id === flipPanel.track.id) ?? flipPanel.track}
          anchorRect={flipPanel.anchorRect}
          onClose={() => setFlipPanel(null)}
          onCommit={(config) => handleSetVideoFlipConfig(flipPanel.track.id, config)}
        />
      )}

      {/* ── Confirmation dialog ──────────────────────────────────────────── */}
      {confirmDialog && (
        <ConfirmConvertDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          cancelLabel={confirmDialog.cancelLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={confirmDialog.onCancel}
        />
      )}

      {/* ── Quantize dialog ──────────────────────────────────────────────── */}
      <QuantizeDialog
        isOpen={quantizeOpen}
        onClose={() => setQuantizeOpen(false)}
        onApply={handleQuantizeApply}
        snapGranularity={snapGranularity}
        selectionCount={selectedClipIds.size + selectedBlockIds.size}
        hasPatternBlock={selectedBlockIds.size > 0}
        hasClip={selectedClipIds.size > 0}
      />
    </div>
  )
}
