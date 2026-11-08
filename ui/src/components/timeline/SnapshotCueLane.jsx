// The arrangement's Snapshots cue lane (Phase 3). It used to live under the
// Video tab's read-only mirror timeline, with its own zoom; now it is one lane
// pinned under the arrangement ruler, on the arrangement's own scale, so cues and
// transitions line up with the clips they cut between.
//
// Moved verbatim from VideoMirrorCanvas.jsx (cue marker, transition band and
// editor, tick→px helpers) and VideoMirrorTimeline.jsx (cue IPC: serialized
// mutations that always re-read listCues). The vmt-* class names are kept: the
// transition editor's styling and tests use them.
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
} from 'react'
import { Check, Plus, Trash2, X } from 'lucide-react'
import { IconButton, NumberBox, Select, Toggle, formatValue, THIN_SPACE } from '../../ui-kit'
import styles from './SnapshotCueLane.module.css'
import {
  PPQ, pixelToBeat, beatToPlayheadPixel, snapBeatToGrid, ticksToBeats, beatsToTicks,
} from '../../constants/timeline.js'
import { timelineEvents } from '../../timelineEvents.js'
import SnapshotTransitionBezierEditor, {
  normalizeTransitionEasing,
} from './SnapshotTransitionBezierEditor.jsx'
import LineSweepDirectionControl, { normalizeLineSweepAngle } from './LineSweepDirectionControl.jsx'

const PLAYHEAD_LINE_WIDTH = 1

export const CUE_LANE_HEIGHT = 30

// Cue stems and the shared DOM playhead both call this exact tick-to-x mapping.
// The half-pixel grid alignment is folded into beatToPlayheadPixel for a 1px line.
export function mirrorTickToPixel(tick, scrollOffset, pixelsPerBeat) {
  return beatToPlayheadPixel(ticksToBeats(tick), scrollOffset, pixelsPerBeat, PLAYHEAD_LINE_WIDTH)
}

// ── Snapshot transition editing (Slice 4) ──────────────────────────────────
// The cue MARKER is the fixed pin (the boundary = 50% blend, on the beat) and is
// never moved by the transition editor. The two draggable handles around it —
// Start (left of the pin) and End (right of it) — author the only two values
// that change: startOffsetTicks / endOffsetTicks (>= 0, in TICKS). A hard cut is
// both offsets 0 (the default); transitions are opt-in via the Enable toggle.

// Every persisted engine type has a distinct shader mode and an editor option.
// Parameters remain in the full payload when types change so switching back
// restores that type's previous curated settings.
export const TRANSITION_TYPE_OPTIONS = [
  { value: 'crossfade', label: 'Crossfade', group: 'Basic' },
  { value: 'lineSweep', label: 'Line Sweep', group: 'Basic' },
  { value: 'push', label: 'Push', group: 'Basic' },
  { value: 'slide', label: 'Slide Over', group: 'Basic' },
  { value: 'zoom', label: 'Zoom', group: 'Basic' },
  { value: 'dissolve', label: 'Dissolve', group: 'Basic' },
  { value: 'outThenIn', label: 'Out–Then–In', group: 'Basic' },
  { value: 'radialReveal', label: 'Radial Reveal', group: 'Advanced' },
  { value: 'pixelate', label: 'Pixelate', group: 'Advanced' },
  { value: 'glitch', label: 'Glitch', group: 'Advanced' },
  { value: 'blurThrough', label: 'Blur Through', group: 'Advanced' },
  { value: 'displacement', label: 'Displacement', group: 'Advanced' },
]

export const DEFAULT_TRANSITION_EDGE_SOFTNESS = 0
export const DEFAULT_TRANSITION_ZOOM_AMOUNT = 0.12
export const DEFAULT_TRANSITION_DISSOLVE_GRAIN_PX = 1
export const DEFAULT_TRANSITION_RADIAL_ORIGIN = 0.5
export const DEFAULT_TRANSITION_PIXELATE_MAX_BLOCK_PX = 32
export const DEFAULT_TRANSITION_GLITCH_INTENSITY = 0.65
export const DEFAULT_TRANSITION_GLITCH_BLOCK_PX = 24
export const DEFAULT_TRANSITION_BLUR_RADIUS_PX = 16
export const DEFAULT_TRANSITION_DISPLACEMENT_AMOUNT = 0.06
export const DEFAULT_TRANSITION_DISPLACEMENT_SCALE = 6
export const DEFAULT_TRANSITION_EFFECT_SEED = 0

function clampFinite(value, min, max, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback
}

export function normalizeTransitionEdgeSoftness(value) {
  return clampFinite(value, 0, 0.10, DEFAULT_TRANSITION_EDGE_SOFTNESS)
}

export function normalizeTransitionZoomAmount(value) {
  return clampFinite(value, 0, 0.30, DEFAULT_TRANSITION_ZOOM_AMOUNT)
}

export function normalizeTransitionDissolveGrain(value) {
  return Math.round(clampFinite(value, 1, 8, DEFAULT_TRANSITION_DISSOLVE_GRAIN_PX))
}

export function normalizeTransitionRadialOrigin(value) {
  return clampFinite(value, 0, 1, DEFAULT_TRANSITION_RADIAL_ORIGIN)
}

export function normalizeTransitionPixelateBlock(value) {
  return Math.round(clampFinite(value, 1, 128, DEFAULT_TRANSITION_PIXELATE_MAX_BLOCK_PX))
}

export function normalizeTransitionGlitchIntensity(value) {
  return clampFinite(value, 0, 1, DEFAULT_TRANSITION_GLITCH_INTENSITY)
}

export function normalizeTransitionGlitchBlock(value) {
  return Math.round(clampFinite(value, 4, 128, DEFAULT_TRANSITION_GLITCH_BLOCK_PX))
}

export function normalizeTransitionBlurRadius(value) {
  return clampFinite(value, 0, 48, DEFAULT_TRANSITION_BLUR_RADIUS_PX)
}

export function normalizeTransitionDisplacementAmount(value) {
  return clampFinite(value, 0, 0.20, DEFAULT_TRANSITION_DISPLACEMENT_AMOUNT)
}

export function normalizeTransitionDisplacementScale(value) {
  return clampFinite(value, 1, 24, DEFAULT_TRANSITION_DISPLACEMENT_SCALE)
}

export function normalizeTransitionEffectSeed(value) {
  return Math.round(clampFinite(value, 0, 65535, DEFAULT_TRANSITION_EFFECT_SEED))
}

// Window seeded on both sides of the pin the moment a hard-cut cue is switched
// to a transition, so the Start/End handles appear off the pin and are grabbable.
export const DEFAULT_TRANSITION_WINDOW_TICKS = PPQ  // one beat

// Snap a handle's pointer position to a whole tick. Offsets are authored in
// ticks, so every drag resolves to an integer tick: by default it snaps to the
// musical grid; holding Alt frees the snap but STILL quantizes to a whole tick
// (the engine's progress curve is sample-deterministic either way).
export function transitionHandleTick(localX, scrollOffset, pixelsPerBeat, modifiers, granularity) {
  const beat = pixelToBeat(localX, scrollOffset, pixelsPerBeat)
  const snappedBeat = snapBeatToGrid(Math.max(0, beat), modifiers, granularity)
  return Math.max(0, beatsToTicks(snappedBeat))
}

// Offsets are stored >= 0 and never cross the pin: Start sits at or left of the
// pin, End at or right of it.
export function clampStartOffsetTicks(pinTick, handleTick) {
  return Math.max(0, pinTick - handleTick)
}
export function clampEndOffsetTicks(pinTick, handleTick) {
  return Math.max(0, handleTick - pinTick)
}

// Merge a partial edit into the FULL transition object the engine
// expects. setCueTransition replaces the whole transition (any omitted field
// reverts to its engine default), so every write must preserve both easing halves.
export function buildCueTransition(current, patch = {}) {
  const pick = (key, fallback) => (
    patch[key] !== undefined ? patch[key]
      : (current && current[key] !== undefined ? current[key] : fallback)
  )
  const merged = {
    enabled:          !!pick('enabled', false),
    startOffsetTicks: Math.max(0, Math.round(pick('startOffsetTicks', 0))),
    endOffsetTicks:   Math.max(0, Math.round(pick('endOffsetTicks', 0))),
    type:             pick('type', 'crossfade'),
    geomAngleDeg:     normalizeLineSweepAngle(pick('geomAngleDeg', 0)),
    edgeSoftness:     normalizeTransitionEdgeSoftness(pick('edgeSoftness', DEFAULT_TRANSITION_EDGE_SOFTNESS)),
    zoomAmount:       normalizeTransitionZoomAmount(pick('zoomAmount', DEFAULT_TRANSITION_ZOOM_AMOUNT)),
    dissolveGrainPx:  normalizeTransitionDissolveGrain(pick('dissolveGrainPx', DEFAULT_TRANSITION_DISSOLVE_GRAIN_PX)),
    radialOriginX:    normalizeTransitionRadialOrigin(pick('radialOriginX', DEFAULT_TRANSITION_RADIAL_ORIGIN)),
    radialOriginY:    normalizeTransitionRadialOrigin(pick('radialOriginY', DEFAULT_TRANSITION_RADIAL_ORIGIN)),
    pixelateMaxBlockPx: normalizeTransitionPixelateBlock(pick('pixelateMaxBlockPx', DEFAULT_TRANSITION_PIXELATE_MAX_BLOCK_PX)),
    glitchIntensity:  normalizeTransitionGlitchIntensity(pick('glitchIntensity', DEFAULT_TRANSITION_GLITCH_INTENSITY)),
    glitchBlockPx:    normalizeTransitionGlitchBlock(pick('glitchBlockPx', DEFAULT_TRANSITION_GLITCH_BLOCK_PX)),
    blurRadiusPx:     normalizeTransitionBlurRadius(pick('blurRadiusPx', DEFAULT_TRANSITION_BLUR_RADIUS_PX)),
    displacementAmount: normalizeTransitionDisplacementAmount(pick('displacementAmount', DEFAULT_TRANSITION_DISPLACEMENT_AMOUNT)),
    displacementScale: normalizeTransitionDisplacementScale(pick('displacementScale', DEFAULT_TRANSITION_DISPLACEMENT_SCALE)),
    effectSeed:       normalizeTransitionEffectSeed(pick('effectSeed', DEFAULT_TRANSITION_EFFECT_SEED)),
    easing:           normalizeTransitionEasing(pick('easing', undefined)),
  }
  // Seed a visible window only when THIS edit is the one enabling a collapsed
  // (hard-cut) transition — never when merely changing another setting later.
  if (patch.enabled === true && merged.startOffsetTicks === 0 && merged.endOffsetTicks === 0) {
    merged.startOffsetTicks = DEFAULT_TRANSITION_WINDOW_TICKS
    merged.endOffsetTicks   = DEFAULT_TRANSITION_WINDOW_TICKS
  }
  return merged
}

// How each parameter prints and parses: the engine's raw value on the rail, a
// value with its unit in the box (DESIGN.md 6).
const PARAMETER_KINDS = {
  percent: {
    format: (v) => formatValue(v * 100, '%'),
    parse: (text) => { const n = parseFloat(String(text).replace(',', '.')); return Number.isFinite(n) ? n / 100 : null },
  },
  px: {
    format: (v) => `${Math.round(v)}${THIN_SPACE}px`,
    parse: (text) => { const n = parseFloat(String(text).replace(',', '.')); return Number.isFinite(n) ? n : null },
  },
  plain: {
    format: (v) => String(Math.round(v)),
    parse: (text) => { const n = parseFloat(text); return Number.isFinite(n) ? n : null },
  },
  decimal1: {
    format: (v) => v.toFixed(1),
    parse: (text) => { const n = parseFloat(String(text).replace(',', '.')); return Number.isFinite(n) ? n : null },
  },
}

// A kit NumberBox: the drag previews locally and writes ONE setCueTransition on
// release (the old slider wrote on every pointer step). Same patch, same range
// and step as before; the value is quantised to the step.
function TransitionParameterControl({ label, value, min, max, step, kind, onChange }) {
  const { format, parse } = PARAMETER_KINDS[kind] ?? PARAMETER_KINDS.plain
  const quantize = useCallback((v) => {
    const q = min + Math.round((v - min) / step) * step
    return Math.min(max, Math.max(min, Math.round(q * 1e6) / 1e6))
  }, [min, max, step])
  return (
    <NumberBox
      className="vmt-transition-parameter"
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      quantize={quantize}
      format={format}
      parse={parse}
      width={208}
      onCommit={onChange}
    />
  )
}

function CueMarker({
  cue, x, laneWidth, snapshots, selected, onSelect, onClose, onMoveCue, onRemoveCue, onRepointCue,
  onSetCueTransition, pixelsPerBeatRef, scrollOffsetRef, containerRef,
}) {
  const markerRef = useRef(null)

  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const startClientX = e.clientX
    const startX = x
    let dragTick = cue.tick
    let dragged = false

    const onMove = (moveEvent) => {
      const delta = moveEvent.clientX - startClientX
      if (!dragged && Math.abs(delta) < 3) return
      dragged = true
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const localX = Math.max(0, Math.min(laneWidth, moveEvent.clientX - rect.left))
      const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      dragTick = Math.max(0, beatsToTicks(beat))
      const dragX = mirrorTickToPixel(dragTick, scrollOffsetRef.current, pixelsPerBeatRef.current)
      if (markerRef.current) markerRef.current.style.transform = 'translateX(' + dragX + 'px)'
    }

    const onUp = async () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!dragged) {
        onSelect(cue.tick)
        return
      }
      const moved = await onMoveCue(cue.tick, dragTick)
      // Collision/IPC failure: restore the original pixel immediately. The
      // parent's mandatory listCues reconciliation supplies the durable position.
      if (!moved && markerRef.current) {
        markerRef.current.style.transform = 'translateX(' + startX + 'px)'
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }, [containerRef, cue.tick, laneWidth, onMoveCue, onSelect, pixelsPerBeatRef, scrollOffsetRef, x])

  const options = snapshots.map((snapshot) => ({ value: snapshot.id, label: snapshot.name }))
  const transitionType = cue.transition?.type || 'crossfade'

  return (
    <div
      ref={markerRef}
      className={'vmt-cue-marker-wrap ' + styles.markerWrap + (selected ? ' is-selected' : '') + (x > laneWidth - 160 ? ' is-editor-left' : '')}
      style={{ transform: 'translateX(' + x + 'px)' }}
      data-tick={cue.tick}
    >
      <button
        type="button"
        className={`vmt-cue-marker ${styles.marker}`}
        onPointerDown={handlePointerDown}
        onMouseDown={(e) => e.stopPropagation()}
        aria-label={'Snapshot cue at tick ' + cue.tick}
        data-hint="Snapshot cue"
        data-hint-mods="Drag: move · Click: choose its snapshot and transition"
      />
      {selected && (
        <div className={`vmt-cue-editor ${styles.editor}`} role="group" aria-label="Snapshot cue" onMouseDown={(e) => e.stopPropagation()}>
          <div className={`vmt-cue-editor-row ${styles.editorRow}`}>
            <Select
              size="sm"
              className={`vmt-cue-select ${styles.snapshotSelect}`}
              value={cue.snapshotId}
              options={options}
              onChange={(snapshotId) => onRepointCue(cue.tick, snapshotId)}
              ariaLabel={'Snapshot for cue at tick ' + cue.tick}
              disabled={options.length === 0}
              hint="Snapshot this cue switches to"
            />
            <IconButton
              size="sm"
              className="vmt-cue-action vmt-close-cue-editor"
              onClick={onClose}
              label={'Close cue editor at tick ' + cue.tick}
              hint="Close the cue editor"
            >
              <X size={14} aria-hidden="true" />
            </IconButton>
            <IconButton
              size="sm"
              variant="danger"
              className="vmt-cue-action vmt-delete-cue"
              onClick={() => onRemoveCue(cue.tick)}
              label={'Delete cue at tick ' + cue.tick}
              hint="Delete this cue"
            >
              <Trash2 size={13} aria-hidden="true" />
            </IconButton>
          </div>
          {/* Boundary animation. The pin (this marker) stays put; only the
              Start/End handles on the timeline and these fields change. */}
          <div className={`vmt-transition-editor ${styles.transitionEditor}`}>
            <Toggle
              size="sm"
              className={`vmt-transition-enable ${styles.transitionToggle}`}
              on={!!cue.transition?.enabled}
              onChange={(enabled) => onSetCueTransition(
                cue.tick, buildCueTransition(cue.transition, { enabled }),
              )}
              glyph={<Check size={12} aria-hidden="true" />}
              hint="Transition: blend between the two snapshots around this cue instead of cutting"
            >Transition</Toggle>
            {cue.transition?.enabled && (
              <div className={`vmt-transition-fields ${styles.fields}`}>
                <Select
                  size="sm"
                  className={`vmt-transition-type ${styles.typeSelect}`}
                  value={transitionType}
                  options={TRANSITION_TYPE_OPTIONS}
                  onChange={(type) => onSetCueTransition(
                    cue.tick, buildCueTransition(cue.transition, { type }),
                  )}
                  ariaLabel={'Animation type for cue at tick ' + cue.tick}
                  hint="Animation of the transition"
                />
                {['lineSweep', 'push', 'slide', 'blurThrough'].includes(transitionType) && (
                  <LineSweepDirectionControl
                    value={cue.transition?.geomAngleDeg}
                    cardinalOnly={transitionType === 'push' || transitionType === 'slide'}
                    ariaLabel={`${TRANSITION_TYPE_OPTIONS.find((option) => option.value === transitionType)?.label} direction`}
                    onCommit={(geomAngleDeg) => onSetCueTransition(
                      cue.tick, buildCueTransition(cue.transition, { geomAngleDeg }),
                    )}
                  />
                )}
                {transitionType === 'lineSweep' && (
                  <TransitionParameterControl
                    label="Feather"
                    value={normalizeTransitionEdgeSoftness(cue.transition?.edgeSoftness)}
                    min={0}
                    max={0.10}
                    step={0.005}
                    kind="percent"
                    onChange={(edgeSoftness) => onSetCueTransition(
                      cue.tick, buildCueTransition(cue.transition, { edgeSoftness }),
                    )}
                  />
                )}
                {transitionType === 'zoom' && (
                  <TransitionParameterControl
                    label="Zoom intensity"
                    value={normalizeTransitionZoomAmount(cue.transition?.zoomAmount)}
                    min={0}
                    max={0.30}
                    step={0.01}
                    kind="percent"
                    onChange={(zoomAmount) => onSetCueTransition(
                      cue.tick, buildCueTransition(cue.transition, { zoomAmount }),
                    )}
                  />
                )}
                {transitionType === 'dissolve' && (
                  <TransitionParameterControl
                    label="Dissolve grain"
                    value={normalizeTransitionDissolveGrain(cue.transition?.dissolveGrainPx)}
                    min={1}
                    max={8}
                    step={1}
                    kind="px"
                    onChange={(dissolveGrainPx) => onSetCueTransition(
                      cue.tick, buildCueTransition(cue.transition, { dissolveGrainPx }),
                    )}
                  />
                )}
                {transitionType === 'radialReveal' && (
                  <>
                    <TransitionParameterControl
                      label="Origin X"
                      value={normalizeTransitionRadialOrigin(cue.transition?.radialOriginX)}
                      min={0}
                      max={1}
                      step={0.01}
                      kind="percent"
                      onChange={(radialOriginX) => onSetCueTransition(
                        cue.tick, buildCueTransition(cue.transition, { radialOriginX }),
                      )}
                    />
                    <TransitionParameterControl
                      label="Origin Y"
                      value={normalizeTransitionRadialOrigin(cue.transition?.radialOriginY)}
                      min={0}
                      max={1}
                      step={0.01}
                      kind="percent"
                      onChange={(radialOriginY) => onSetCueTransition(
                        cue.tick, buildCueTransition(cue.transition, { radialOriginY }),
                      )}
                    />
                    <TransitionParameterControl
                      label="Feather"
                      value={normalizeTransitionEdgeSoftness(cue.transition?.edgeSoftness)}
                      min={0}
                      max={0.10}
                      step={0.005}
                      kind="percent"
                      onChange={(edgeSoftness) => onSetCueTransition(
                        cue.tick, buildCueTransition(cue.transition, { edgeSoftness }),
                      )}
                    />
                  </>
                )}
                {transitionType === 'pixelate' && (
                  <TransitionParameterControl
                    label="Max block"
                    value={normalizeTransitionPixelateBlock(cue.transition?.pixelateMaxBlockPx)}
                    min={1}
                    max={128}
                    step={1}
                    kind="px"
                    onChange={(pixelateMaxBlockPx) => onSetCueTransition(
                      cue.tick, buildCueTransition(cue.transition, { pixelateMaxBlockPx }),
                    )}
                  />
                )}
                {transitionType === 'glitch' && (
                  <>
                    <TransitionParameterControl
                      label="Intensity"
                      value={normalizeTransitionGlitchIntensity(cue.transition?.glitchIntensity)}
                      min={0}
                      max={1}
                      step={0.05}
                      kind="percent"
                      onChange={(glitchIntensity) => onSetCueTransition(
                        cue.tick, buildCueTransition(cue.transition, { glitchIntensity }),
                      )}
                    />
                    <TransitionParameterControl
                      label="Slice height"
                      value={normalizeTransitionGlitchBlock(cue.transition?.glitchBlockPx)}
                      min={4}
                      max={128}
                      step={1}
                      kind="px"
                      onChange={(glitchBlockPx) => onSetCueTransition(
                        cue.tick, buildCueTransition(cue.transition, { glitchBlockPx }),
                      )}
                    />
                    <TransitionParameterControl
                      label="Seed"
                      value={normalizeTransitionEffectSeed(cue.transition?.effectSeed)}
                      min={0}
                      max={255}
                      step={1}
                      kind="plain"
                      onChange={(effectSeed) => onSetCueTransition(
                        cue.tick, buildCueTransition(cue.transition, { effectSeed }),
                      )}
                    />
                  </>
                )}
                {transitionType === 'blurThrough' && (
                  <TransitionParameterControl
                    label="Blur radius"
                    value={normalizeTransitionBlurRadius(cue.transition?.blurRadiusPx)}
                    min={0}
                    max={48}
                    step={1}
                    kind="px"
                    onChange={(blurRadiusPx) => onSetCueTransition(
                      cue.tick, buildCueTransition(cue.transition, { blurRadiusPx }),
                    )}
                  />
                )}
                {transitionType === 'displacement' && (
                  <>
                    <TransitionParameterControl
                      label="Strength"
                      value={normalizeTransitionDisplacementAmount(cue.transition?.displacementAmount)}
                      min={0}
                      max={0.20}
                      step={0.01}
                      kind="percent"
                      onChange={(displacementAmount) => onSetCueTransition(
                        cue.tick, buildCueTransition(cue.transition, { displacementAmount }),
                      )}
                    />
                    <TransitionParameterControl
                      label="Noise scale"
                      value={normalizeTransitionDisplacementScale(cue.transition?.displacementScale)}
                      min={1}
                      max={24}
                      step={0.5}
                      kind="decimal1"
                      onChange={(displacementScale) => onSetCueTransition(
                        cue.tick, buildCueTransition(cue.transition, { displacementScale }),
                      )}
                    />
                    <TransitionParameterControl
                      label="Seed"
                      value={normalizeTransitionEffectSeed(cue.transition?.effectSeed)}
                      min={0}
                      max={255}
                      step={1}
                      kind="plain"
                      onChange={(effectSeed) => onSetCueTransition(
                        cue.tick, buildCueTransition(cue.transition, { effectSeed }),
                      )}
                    />
                  </>
                )}
                <SnapshotTransitionBezierEditor
                  easing={cue.transition?.easing}
                  onChange={(easing) => onSetCueTransition(
                    cue.tick, buildCueTransition(cue.transition, { easing }),
                  )}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// The transition editor's on-timeline half: a shaded window around a cue's fixed
// pin. The pin never moves here (that stays the CueMarker's drag) — only the two
// offsets change. Rendered for every enabled cue as a visualization; the
// selected cue additionally gets the draggable Start/End handles.
function TransitionBand({
  cue, laneWidth, interactive,
  pixelsPerBeatRef, scrollOffsetRef, snapGranularityRef, containerRef,
  onSetCueTransition,
}) {
  const bandRef = useRef(null)
  const startRef = useRef(null)
  const endRef = useRef(null)

  const tr = cue.transition || {}
  const pinTick = cue.tick
  const startOffset = Math.max(0, tr.startOffsetTicks || 0)
  const endOffset = Math.max(0, tr.endOffsetTicks || 0)
  const scroll = scrollOffsetRef.current
  const ppb = pixelsPerBeatRef.current
  const startX = mirrorTickToPixel(Math.max(0, pinTick - startOffset), scroll, ppb)
  const endX = mirrorTickToPixel(pinTick + endOffset, scroll, ppb)

  const startDrag = useCallback((which) => (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    // Keep the outgoing offset fixed while dragging one handle; buildCueTransition
    // supplies the complete transition object each write needs.
    let next = buildCueTransition(tr, { enabled: true })
    const paint = () => {
      const s = mirrorTickToPixel(Math.max(0, pinTick - next.startOffsetTicks), scrollOffsetRef.current, pixelsPerBeatRef.current)
      const en = mirrorTickToPixel(pinTick + next.endOffsetTicks, scrollOffsetRef.current, pixelsPerBeatRef.current)
      if (bandRef.current) {
        bandRef.current.style.left = s + 'px'
        bandRef.current.style.width = Math.max(0, en - s) + 'px'
      }
      if (startRef.current) startRef.current.style.transform = 'translateX(' + s + 'px)'
      if (endRef.current) endRef.current.style.transform = 'translateX(' + en + 'px)'
    }
    const onMove = (moveEvent) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const localX = Math.max(0, Math.min(laneWidth, moveEvent.clientX - rect.left))
      const modifiers = { alt: moveEvent.altKey, shift: moveEvent.shiftKey, ctrl: moveEvent.ctrlKey || moveEvent.metaKey }
      const handleTick = transitionHandleTick(localX, scrollOffsetRef.current, pixelsPerBeatRef.current, modifiers, snapGranularityRef.current)
      const patch = which === 'start'
        ? { startOffsetTicks: clampStartOffsetTicks(pinTick, handleTick) }
        : { endOffsetTicks: clampEndOffsetTicks(pinTick, handleTick) }
      next = buildCueTransition(next, patch)
      paint()
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      onSetCueTransition(pinTick, next)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }, [tr, pinTick, laneWidth, containerRef, scrollOffsetRef, pixelsPerBeatRef, snapGranularityRef, onSetCueTransition])

  return (
    <>
      <div
        ref={bandRef}
        className={`vmt-transition-band ${styles.band}`}
        style={{ left: startX, width: Math.max(0, endX - startX) }}
        aria-hidden="true"
      />
      {interactive && (
        <>
          <div
            ref={startRef}
            className={`vmt-transition-handle vmt-transition-handle-start ${styles.handle}`}
            style={{ transform: 'translateX(' + startX + 'px)' }}
            onPointerDown={startDrag('start')}
            onMouseDown={(e) => e.stopPropagation()}
            role="slider"
            aria-label={'Transition start for cue at tick ' + pinTick}
            aria-valuenow={startOffset}
            data-hint="Transition start" data-hint-mods="Drag: set it · Snaps to the grid · Alt: free"
          />
          <div
            ref={endRef}
            className={`vmt-transition-handle vmt-transition-handle-end ${styles.handle}`}
            style={{ transform: 'translateX(' + endX + 'px)' }}
            onPointerDown={startDrag('end')}
            onMouseDown={(e) => e.stopPropagation()}
            role="slider"
            aria-label={'Transition end for cue at tick ' + pinTick}
            aria-valuenow={endOffset}
            data-hint="Transition end" data-hint-mods="Drag: set it · Snaps to the grid · Alt: free"
          />
        </>
      )}
    </>
  )
}

export function CueLane({
  top, width, cues, snapshots, defaultSnapshotId, totalBeats,
  pixelsPerBeatRef, scrollOffsetRef, snapGranularityRef, containerRef,
  onMoveCue, onRemoveCue, onRepointCue, onSetCueTransition,
}) {
  const [selectedTick, setSelectedTick] = useState(null)
  const names = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot.name]))
  const sorted = [...cues].sort((a, b) => a.tick - b.tick)
  const lastCueTick = sorted.length > 0 ? sorted[sorted.length - 1].tick : 0
  const endTick = Math.max(beatsToTicks(totalBeats), lastCueTick)

  useEffect(() => {
    if (selectedTick !== null && !cues.some((cue) => cue.tick === selectedTick)) {
      setSelectedTick(null)
    }
  }, [cues, selectedTick])

  // Safety audit: with no cues this still creates one default/Base span from
  // tick zero through the visible song extent.
  const spans = []
  let startTick = 0
  let snapshotId = defaultSnapshotId
  for (const cue of sorted) {
    spans.push({ startTick, endTick: cue.tick, snapshotId })
    startTick = cue.tick
    snapshotId = cue.snapshotId
  }
  spans.push({ startTick, endTick, snapshotId })

  return (
    <div
      className={`vmt-cue-lane ${styles.cueLane}`}
      style={{ top, height: CUE_LANE_HEIGHT }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelectedTick(null)
      }}
    >
      <div className={`vmt-cue-spans ${styles.spans}`} aria-hidden="true">
        {spans.map((span, index) => {
          const left = mirrorTickToPixel(span.startTick, scrollOffsetRef.current, pixelsPerBeatRef.current)
          const right = mirrorTickToPixel(span.endTick, scrollOffsetRef.current, pixelsPerBeatRef.current)
          const label = names.get(span.snapshotId) || 'Base'
          return (
            <div
              key={span.startTick + '-' + span.endTick + '-' + index}
              className={'vmt-cue-span vmt-cue-span-' + (index % 2) + ' ' + styles.span}
              style={{ left, width: Math.max(0, right - left) }}
            >
              <span>{label}</span>
            </div>
          )
        })}
      </div>
      {/* Transition windows (visualization for every enabled cue; the selected
          cue also gets draggable Start/End handles). Rendered under the markers
          so the fixed pin stays on top. */}
      {sorted.filter((cue) => cue.transition?.enabled).map((cue) => (
        <TransitionBand
          key={'tb-' + cue.tick}
          cue={cue}
          laneWidth={width}
          interactive={selectedTick === cue.tick}
          pixelsPerBeatRef={pixelsPerBeatRef}
          scrollOffsetRef={scrollOffsetRef}
          snapGranularityRef={snapGranularityRef}
          containerRef={containerRef}
          onSetCueTransition={onSetCueTransition}
        />
      ))}
      {sorted.map((cue) => {
        const x = mirrorTickToPixel(cue.tick, scrollOffsetRef.current, pixelsPerBeatRef.current)
        return (
          <CueMarker
            key={cue.tick}
            cue={cue}
            x={x}
            laneWidth={width}
            snapshots={snapshots}
            selected={selectedTick === cue.tick}
            onSelect={setSelectedTick}
            onClose={() => setSelectedTick(null)}
            onMoveCue={async (oldTick, newTick) => {
              const moved = await onMoveCue(oldTick, newTick)
              if (moved) setSelectedTick(newTick)
              return moved
            }}
            onRemoveCue={onRemoveCue}
            onRepointCue={onRepointCue}
            onSetCueTransition={onSetCueTransition}
            pixelsPerBeatRef={pixelsPerBeatRef}
            scrollOffsetRef={scrollOffsetRef}
            containerRef={containerRef}
          />
        )
      })}
    </div>
  )
}

// ── Cue data + mutations (moved from VideoMirrorTimeline) ───────────────────
// Safety audit: cue writes are serialized, and every attempt finishes by
// re-reading listCues. React state is therefore only a view of IPC truth,
// including under rapid add/move/delete input.
export function useSnapshotCues(playheadBeatRef) {
  const [cues, setCues] = useState([])
  const [snapshots, setSnapshots] = useState([])
  const [defaultSnapshotId, setDefaultSnapshotId] = useState('')
  const cueMutationQueueRef = useRef(Promise.resolve())

  const fetchCues = useCallback(async () => {
    try {
      const next = await window.xleth?.timeline?.listCues?.()
      if (Array.isArray(next)) setCues(next)
    } catch (e) {
      console.error('[Arrange] listCues failed:', e)
    }
  }, [])

  const fetchSnapshots = useCallback(async () => {
    try {
      const timeline = window.xleth?.timeline
      const [next, defaultId] = await Promise.all([
        timeline?.listSnapshots?.(),
        timeline?.getDefaultSnapshot?.(),
      ])
      if (Array.isArray(next)) setSnapshots(next)
      if (typeof defaultId === 'string') setDefaultSnapshotId(defaultId)
    } catch (e) {
      console.error('[Arrange] snapshot lookup failed:', e)
    }
  }, [])

  useEffect(() => {
    fetchCues(); fetchSnapshots()
    // Snapshot deletion broadcasts this after the engine prunes its cues, so both
    // lists are re-read and dangling markers disappear.
    const onGrid = () => { fetchCues(); fetchSnapshots() }
    timelineEvents.addEventListener('timeline-grid-changed', onGrid)
    const offProjectLoaded = window.xleth?.onProjectLoaded?.(() => { fetchCues(); fetchSnapshots() })
    return () => {
      timelineEvents.removeEventListener('timeline-grid-changed', onGrid)
      if (typeof offProjectLoaded === 'function') offProjectLoaded()
    }
  }, [fetchCues, fetchSnapshots])

  const mutateCue = useCallback((label, mutation) => {
    const run = cueMutationQueueRef.current
      .catch(() => {})
      .then(async () => {
        try {
          const timeline = window.xleth?.timeline
          if (!timeline) return false
          return await mutation(timeline)
        } catch (e) {
          console.error('[Arrange] ' + label + ' failed:', e)
          return false
        } finally {
          await fetchCues()
          timelineEvents.dispatchEvent(new Event('timeline-grid-changed'))
        }
      })
    cueMutationQueueRef.current = run.catch(() => {})
    return run
  }, [fetchCues])

  const activeSnapshotId = snapshots.find((snapshot) => snapshot.active)?.id || ''

  const addCueAtPlayhead = useCallback(() => {
    if (!activeSnapshotId) return Promise.resolve(false)
    const playheadTick = Math.max(0, beatsToTicks(playheadBeatRef?.current ?? 0))
    // addCue deliberately handles an occupied tick; the engine replaces that
    // cue's snapshot and the subsequent listCues read shows one marker.
    return mutateCue('addCue', (timeline) => timeline.addCue(playheadTick, activeSnapshotId))
  }, [activeSnapshotId, mutateCue, playheadBeatRef])

  const repointCue = useCallback((tick, snapshotId) => {
    if (!snapshots.some((snapshot) => snapshot.id === snapshotId)) return Promise.resolve(false)
    return mutateCue('addCue', (timeline) => timeline.addCue(tick, snapshotId))
  }, [mutateCue, snapshots])

  const moveCue = useCallback((oldTick, newTick) => mutateCue('moveCue', async (timeline) => {
    if (oldTick === newTick) return true
    // Never ask the engine to move onto an occupied tick.
    const latest = await timeline.listCues()
    if (!Array.isArray(latest)) return false
    if (latest.some((cue) => cue.tick === newTick && cue.tick !== oldTick)) return false
    return await timeline.moveCue(oldTick, newTick) === true
  }), [mutateCue])

  const removeCue = useCallback((tick) => (
    mutateCue('removeCue', (timeline) => timeline.removeCue(tick))
  ), [mutateCue])

  // setCueTransition replaces the whole transition, so callers always pass the
  // complete object. The engine renders the blend; the UI never animates it.
  const setCueTransition = useCallback((tick, transition) => (
    mutateCue('setCueTransition', (timeline) => {
      if (typeof timeline.setCueTransition !== 'function') return false
      return timeline.setCueTransition(tick, transition)
    })
  ), [mutateCue])

  return {
    cues, snapshots, defaultSnapshotId, activeSnapshotId,
    addCueAtPlayhead, repointCue, moveCue, removeCue, setCueTransition,
  }
}

/**
 * The lane itself, for the arrangement's canvas column. Cue positions are read
 * from the same refs the canvases draw with; applyView() (called per frame by
 * TimelineView's commitViewportRedraw) re-places them while the view animates.
 */
const SnapshotCueLane = forwardRef(function SnapshotCueLane({
  pixelsPerBeatRef, scrollOffsetRef, cues = [], snapshots = [], defaultSnapshotId = '',
  totalBeats = 0, snapGranularity = '1/16',
  onMoveCue, onRemoveCue, onRepointCue, onSetCueTransition,
}, ref) {
  const containerRef = useRef(null)
  const snapGranularityRef = useRef(snapGranularity)
  snapGranularityRef.current = snapGranularity
  const [width, setWidth] = useState(0)
  const [, setViewTick] = useState(0)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    setWidth(el.clientWidth || 0)
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width)
      if (w > 0) setWidth(w)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useImperativeHandle(ref, () => ({
    applyView: () => setViewTick((n) => (n + 1) % 1e9),
  }), [])

  return (
    <div
      ref={containerRef}
      className={styles.lane}
      style={{ height: CUE_LANE_HEIGHT }}
      data-testid="snapshot-cue-lane"
    >
      <CueLane
        top={0}
        width={width}
        cues={cues}
        snapshots={snapshots}
        defaultSnapshotId={defaultSnapshotId}
        totalBeats={totalBeats}
        pixelsPerBeatRef={pixelsPerBeatRef}
        scrollOffsetRef={scrollOffsetRef}
        snapGranularityRef={snapGranularityRef}
        containerRef={containerRef}
        onMoveCue={onMoveCue}
        onRemoveCue={onRemoveCue}
        onRepointCue={onRepointCue}
        onSetCueTransition={onSetCueTransition}
      />
    </div>
  )
})

/** The lane's cell in the track-header column: its name and "add at playhead". */
export function SnapshotCueLaneHeader({ onAddCue, disabled }) {
  return (
    <div className={styles.header} style={{ height: CUE_LANE_HEIGHT }} data-testid="snapshot-cue-lane-header">
      <span>Snapshots</span>
      <IconButton size="sm" label="Add snapshot cue at playhead" onClick={onAddCue} disabled={disabled} hint="Add a snapshot cue at the playhead">
        <Plus aria-hidden="true" />
      </IconButton>
    </div>
  )
}

export default SnapshotCueLane
