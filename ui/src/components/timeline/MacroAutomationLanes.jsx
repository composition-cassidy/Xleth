import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Repeat } from 'lucide-react'
import ContextMenu from '../ContextMenu.jsx'
import useEffectChainStore from '../../stores/effectChainStore.js'
import { PPQ } from '../../constants/timeline.js'
import {
  LANE_CONTENT_PAD,
  clipPixelRect,
  pxDeltaToTickDelta,
  snapAutomationPointTick,
  snapClipEndTick,
  snapClipStartTick,
  xToClipLocalTick,
  yToValue,
  valueToY,
  buildCurvePoints,
  buildLoopGhostCurveSegments,
  buildLoopRepeatDividers,
} from './macroLaneGeometry.js'

// FXG.4-h-r1 — Real macro automation child-lane layer (replaces the FXG.4-h-fix
// amber overlay strips). Renders one interactive row per visible macro automation
// lane, positioned by the derived `trackLayout` so it sits in the lane's own
// vertical band directly below the parent track and scrolls/zooms with the
// timeline. Lives in the DOM (not the canvas) so automation points are
// individually draggable handles. All edits go through the effectChainStore macro
// automation actions, which enforce the FXG.4-h compatibility/overlap rules and
// keep the macro→parameter-edge runtime path intact (no direct plugin params).

const POINT_HIT_R = 5     // px radius for a draggable point handle
const MIN_CLIP_TICKS = 60 // matches model's positive-int floor for a clip

// Module-level clipboard — a macro automation clip copy is only pasteable into a
// lane for the SAME macro (the payload carries sourceMacroNodeId, enforced by the
// model). Kept outside React so it survives re-renders without a store field.
let macroClipboard = null

function actions() {
  return useEffectChainStore.getState()
}

export default function MacroAutomationLanes({
  trackLayout,
  graphStates = {},
  pixelsPerBeat,
  scrollOffset,
  snapGranularity = '1/16',
}) {
  const layerRef = useRef(null)
  const [selected, setSelected] = useState(null) // { trackId, laneId, clipId }
  const [menu, setMenu] = useState(null)          // { x, y, kind, trackId, macroNodeId, laneId, clipId }
  const dragRef = useRef(null)

  const macroRows = trackLayout?.getMacroRows?.() ?? []

  // Resolve a lane + its clips from the live graphStates for a given row.
  const laneForRow = useCallback((row) => {
    const gs = graphStates?.[String(row.parentTrackId)]
    const lane = gs?.macroAutomationLanes?.find((l) => l.laneId === row.laneId) ?? null
    return { gs, lane }
  }, [graphStates])

  // ── Shared window-drag plumbing ──────────────────────────────────────────
  const beginDrag = useCallback((onMove, onUp) => {
    const move = (e) => onMove(e)
    const up = (e) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      dragRef.current = null
      onUp?.(e)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [])

  const modsFrom = (e) => ({ alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey })

  // ── Clip move ────────────────────────────────────────────────────────────
  const startClipMove = useCallback((e, row, clip) => {
    if (e.button !== 0 || row.targetUnavailable) return
    e.preventDefault(); e.stopPropagation()
    setSelected({ trackId: row.parentTrackId, laneId: row.laneId, clipId: clip.clipId })
    const originX = e.clientX
    const origStart = clip.startTick
    const ppb = pixelsPerBeat
    dragRef.current = { kind: 'move' }
    beginDrag((me) => {
      const next = snapClipStartTick(
        origStart + pxDeltaToTickDelta(me.clientX - originX, ppb),
        modsFrom(me),
        snapGranularity,
      )
      if (next !== clip.startTick) {
        actions().moveMacroAutomationClipForTrack(row.parentTrackId, clip.clipId, next)
      }
    })
  }, [beginDrag, pixelsPerBeat, snapGranularity])

  // ── Clip resize (edge handles) ───────────────────────────────────────────
  const startClipResize = useCallback((e, row, clip, edge) => {
    if (e.button !== 0 || row.targetUnavailable) return
    e.preventDefault(); e.stopPropagation()
    setSelected({ trackId: row.parentTrackId, laneId: row.laneId, clipId: clip.clipId })
    const originX = e.clientX
    const origStart = clip.startTick
    const origLen = clip.lengthTicks
    const origEnd = origStart + origLen
    const ppb = pixelsPerBeat
    dragRef.current = { kind: 'resize' }
    beginDrag((me) => {
      const mods = modsFrom(me)
      if (edge === 'right') {
        const end = snapClipEndTick(
          origEnd + pxDeltaToTickDelta(me.clientX - originX, ppb),
          origStart,
          MIN_CLIP_TICKS,
          mods,
          snapGranularity,
        )
        const lengthTicks = end - origStart
        actions().resizeMacroAutomationClipForTrack(row.parentTrackId, clip.clipId, { lengthTicks })
      } else {
        const startTick = snapClipStartTick(
          origStart + pxDeltaToTickDelta(me.clientX - originX, ppb),
          mods,
          snapGranularity,
          0,
          origEnd - MIN_CLIP_TICKS,
        )
        const lengthTicks = origEnd - startTick
        actions().resizeMacroAutomationClipForTrack(row.parentTrackId, clip.clipId, { startTick, lengthTicks })
      }
    })
  }, [beginDrag, pixelsPerBeat, snapGranularity])

  // ── Point move ───────────────────────────────────────────────────────────
  const startPointMove = useCallback((e, row, clip, pointIndex, contentTop, contentH) => {
    if (e.button !== 0 || row.targetUnavailable) return
    e.preventDefault(); e.stopPropagation()
    setSelected({ trackId: row.parentTrackId, laneId: row.laneId, clipId: clip.clipId })
    const layerRect = layerRef.current?.getBoundingClientRect()
    const laneTopClient = (layerRect?.top ?? 0) + row.y
    const points = clip.points
    // Keep ordering stable: clamp tick strictly between neighbours during the drag.
    const lowerTick = pointIndex > 0 ? points[pointIndex - 1].tick + 1 : 0
    const upperTick = pointIndex < points.length - 1 ? points[pointIndex + 1].tick - 1 : clip.lengthTicks
    dragRef.current = { kind: 'point' }
    beginDrag((me) => {
      const rawLocal = xToClipLocalTick(me.clientX - (layerRect?.left ?? 0), clip, pixelsPerBeat, scrollOffset)
      const tick = snapAutomationPointTick(rawLocal, clip, modsFrom(me), snapGranularity, PPQ, {
        minTick: lowerTick,
        maxTick: upperTick,
      })
      const value = yToValue(me.clientY - laneTopClient, contentTop, contentH)
      actions().moveMacroAutomationPointForTrack(row.parentTrackId, clip.clipId, pointIndex, { tick, value })
    })
  }, [beginDrag, pixelsPerBeat, scrollOffset, snapGranularity])

  // ── Add point (double-click on clip body) ────────────────────────────────
  const addPointAt = useCallback((e, row, clip, contentTop, contentH) => {
    if (row.targetUnavailable) return
    e.preventDefault(); e.stopPropagation()
    const layerRect = layerRef.current?.getBoundingClientRect()
    const laneTopClient = (layerRect?.top ?? 0) + row.y
    const rawLocal = xToClipLocalTick(e.clientX - (layerRect?.left ?? 0), clip, pixelsPerBeat, scrollOffset)
    const tick = snapAutomationPointTick(rawLocal, clip, modsFrom(e), snapGranularity)
    const value = yToValue(e.clientY - laneTopClient, contentTop, contentH)
    actions().addMacroAutomationPointForTrack(row.parentTrackId, clip.clipId, { tick, value })
  }, [pixelsPerBeat, scrollOffset, snapGranularity])

  // ── Context menus ─────────────────────────────────────────────────────────
  const openClipMenu = useCallback((e, row, clip) => {
    e.preventDefault(); e.stopPropagation()
    setMenu({
      x: e.clientX, y: e.clientY, kind: 'clip',
      trackId: row.parentTrackId, macroNodeId: row.macroNodeId, laneId: row.laneId,
      clipId: clip.clipId, loopEnabled: clip.loopEnabled, targetUnavailable: row.targetUnavailable,
    })
  }, [])

  const openLaneMenu = useCallback((e, row) => {
    // Only when clicking the empty lane (not a clip), and only when a clip for
    // THIS macro is on the clipboard (no other lane action exists for empty space).
    if (e.target !== e.currentTarget) return
    if (row.targetUnavailable) return
    if (!macroClipboard || macroClipboard.sourceMacroNodeId !== row.macroNodeId) return
    e.preventDefault(); e.stopPropagation()
    const layerRect = layerRef.current?.getBoundingClientRect()
    const beat = (e.clientX - (layerRect?.left ?? 0)) / pixelsPerBeat + scrollOffset
    const rawStartTick = Math.max(0, Math.round(beat * PPQ))
    setMenu({
      x: e.clientX, y: e.clientY, kind: 'lane',
      trackId: row.parentTrackId, macroNodeId: row.macroNodeId, laneId: row.laneId,
      startTick: snapClipStartTick(rawStartTick, modsFrom(e), snapGranularity),
    })
  }, [pixelsPerBeat, scrollOffset, snapGranularity])

  const clipMenuItems = useMemo(() => {
    if (!menu) return []
    if (menu.kind === 'clip') {
      const items = [
        {
          label: menu.loopEnabled ? 'Disable Loop' : 'Enable Loop',
          onClick: () => actions().toggleMacroAutomationClipLoopForTrack(menu.trackId, menu.clipId),
        },
        {
          label: 'Copy',
          onClick: () => { macroClipboard = actions().buildMacroAutomationClipCopyPayload(menu.trackId, menu.clipId) },
        },
        { type: 'separator' },
        {
          label: 'Delete',
          danger: true,
          onClick: () => actions().deleteMacroAutomationClipForTrack(menu.trackId, menu.clipId),
        },
      ]
      return items
    }
    // lane (empty space) menu — paste only when the clipboard matches this macro
    // (gated at open time, so the clipboard is guaranteed compatible here).
    return [{
      label: 'Paste',
      onClick: () => {
        actions().pasteMacroAutomationClipForTrack(menu.trackId, menu.macroNodeId, macroClipboard, { startTick: menu.startTick })
      },
    }]
  }, [menu])

  if (macroRows.length === 0) return null

  return (
    <div
      ref={layerRef}
      className="macro-automation-lanes-layer"
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: trackLayout.totalHeight }}
    >
      {macroRows.map((row) => {
        const { lane } = laneForRow(row)
        const clips = lane?.clips ?? []
        const contentTop = LANE_CONTENT_PAD
        const contentH = Math.max(1, row.height - 2 * LANE_CONTENT_PAD)
        return (
          <div
            key={row.id}
            className={`macro-automation-lane${row.targetUnavailable ? ' macro-automation-lane--orphan' : ''}`}
            data-lane-id={row.laneId}
            data-macro-node-id={row.macroNodeId}
            style={{ position: 'absolute', top: row.y, left: 0, width: '100%', height: row.height }}
            onContextMenu={(e) => openLaneMenu(e, row)}
            onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null) }}
          >
            {row.targetUnavailable && (
              <span className="macro-automation-lane-orphan-tag">macro unavailable</span>
            )}
            {clips.map((clip) => {
              const { left, width } = clipPixelRect(clip, pixelsPerBeat, scrollOffset)
              if (left + width < 0 || left > 100000) return null
              const isSelected = selected?.clipId === clip.clipId
              const curve = buildCurvePoints(clip.points, clip, pixelsPerBeat, contentTop, contentH)
              const ghostCurves = buildLoopGhostCurveSegments(clip.points, clip, pixelsPerBeat, contentTop, contentH)
              const loopDividers = buildLoopRepeatDividers(clip.points, clip, pixelsPerBeat)
              return (
                <div
                  key={clip.clipId}
                  className={`macro-automation-clip${isSelected ? ' is-selected' : ''}${clip.loopEnabled ? ' is-looped' : ''}`}
                  data-clip-id={clip.clipId}
                  style={{ position: 'absolute', left, top: 0, width, height: row.height }}
                  onPointerDown={(e) => startClipMove(e, row, clip)}
                  onDoubleClick={(e) => addPointAt(e, row, clip, contentTop, contentH)}
                  onContextMenu={(e) => openClipMenu(e, row, clip)}
                >
                  <svg
                    className="macro-automation-clip-curve"
                    width={width}
                    height={row.height}
                    style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                  >
                    {ghostCurves.map((points, i) => (
                      <polyline
                        key={`ghost-${i}`}
                        className="macro-automation-clip-curve-ghost"
                        points={points}
                        fill="none"
                      />
                    ))}
                    {loopDividers.map((x, i) => (
                      <line
                        key={`divider-${i}`}
                        className="macro-automation-loop-divider"
                        x1={x.toFixed(2)}
                        x2={x.toFixed(2)}
                        y1={contentTop}
                        y2={contentTop + contentH}
                      />
                    ))}
                    <polyline className="macro-automation-clip-curve-main" points={curve} fill="none" />
                  </svg>
                  {!row.targetUnavailable && clip.points.map((p, i) => {
                    const px = (p.tick / PPQ) * pixelsPerBeat
                    const py = valueToY(p.value, contentTop, contentH)
                    const isLoopBoundary = clip.loopEnabled && (i === 0 || i === clip.points.length - 1)
                    return (
                      <button
                        key={i}
                        type="button"
                        className={`macro-automation-point${isLoopBoundary ? ' macro-automation-point--loop-boundary' : ''}`}
                        style={{ position: 'absolute', left: px - POINT_HIT_R, top: py - POINT_HIT_R, width: POINT_HIT_R * 2, height: POINT_HIT_R * 2 }}
                        onPointerDown={(e) => startPointMove(e, row, clip, i, contentTop, contentH)}
                        onContextMenu={(e) => {
                          e.preventDefault(); e.stopPropagation()
                          actions().deleteMacroAutomationPointForTrack(row.parentTrackId, clip.clipId, i)
                        }}
                        aria-label={`Automation point ${i + 1}`}
                      />
                    )
                  })}
                  {!row.targetUnavailable && (
                    <>
                      <span
                        className="macro-automation-clip-handle macro-automation-clip-handle--left"
                        onPointerDown={(e) => startClipResize(e, row, clip, 'left')}
                      />
                      <span
                        className="macro-automation-clip-handle macro-automation-clip-handle--right"
                        onPointerDown={(e) => startClipResize(e, row, clip, 'right')}
                      />
                    </>
                  )}
                  {clip.loopEnabled && (
                    <span className="macro-automation-clip-loop" title="Loop enabled">
                      <Repeat size={10} strokeWidth={2} />
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={clipMenuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
