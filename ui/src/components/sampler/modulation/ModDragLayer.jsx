import { useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import useSamplerModDragStore from '../../../stores/samplerModDragStore.js'
import useSamplerModulationStore from '../../../stores/samplerModulationStore.js'
import { parseTargetKey, modSourceColorVar } from './modTargets.js'

// ── Drag-to-route ────────────────────────────────────────────────────────────
// A source TAB starts the drag; window-level listeners track it; the control
// under the pointer is found by elementFromPoint + the [data-mod-target]
// attribute every registration renders. On release the key is parsed straight
// back into {target, index, stage} — the three fields a ModRoute needs — and one
// addRoute() commits the whole config once, so the drop is a single undoable
// step.
//
// The tab is BOTH a selector and a drag handle, so the gesture is
// threshold-gated: a press that never travels past DRAG_THRESHOLD is a tap
// (select the tab, via onTap) and starts no drag; only real travel arms the
// route drag. That is why pointerdown does not preventDefault or begin() up
// front — a plain click must stay a plain click.
//
// Window listeners rather than pointer capture on the tab: capture would keep
// every move event on the tab and stop the drop targets from ever seeing the
// pointer, and the tray is portaled to <body> while its targets live inside the
// panel frame, so there is no common ancestor to delegate from either.

// Pixels of travel before a press becomes a route drag rather than a tab select.
const DRAG_THRESHOLD = 4

function targetKeyAt(x, y) {
  if (typeof document === 'undefined' || !document.elementFromPoint) return null
  const el = document.elementFromPoint(x, y)
  const host = el?.closest?.('[data-mod-target]')
  return host ? host.getAttribute('data-mod-target') : null
}

export function useModCardDrag() {
  const begin = useSamplerModDragStore((s) => s.begin)
  const move = useSamplerModDragStore((s) => s.move)
  const end = useSamplerModDragStore((s) => s.end)
  const addRoute = useSamplerModulationStore((s) => s.addRoute)

  return useCallback((source, label, onTap) => (e) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    let started = false

    const onMove = (ev) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
        started = true
        ev.preventDefault()
        begin(source, label, startX, startY)
      }
      move(ev.clientX, ev.clientY, targetKeyAt(ev.clientX, ev.clientY))
    }
    const finish = (dropKey) => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
      if (!started) { onTap?.(); return }   // a tap, not a drag — just select
      end()
      if (!dropKey) return
      const reg = parseTargetKey(dropKey)
      if (reg) addRoute(source, reg)
    }
    const onUp = (ev) => finish(ev.type === 'pointerup' ? targetKeyAt(ev.clientX, ev.clientY) : null)
    const onCancel = () => finish(null)

    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
  }, [begin, move, end, addRoute])
}

// The label that follows the pointer. Portaled to <body> and pointer-events:none
// so it can never become the elementFromPoint hit itself.
export function ModDragGhost() {
  const source = useSamplerModDragStore((s) => s.source)
  const label = useSamplerModDragStore((s) => s.label)
  const x = useSamplerModDragStore((s) => s.x)
  const y = useSamplerModDragStore((s) => s.y)
  const hoverKey = useSamplerModDragStore((s) => s.hoverKey)

  // A drag is a modal gesture; the cursor should say so panel-wide.
  useEffect(() => {
    if (source == null) return undefined
    const prev = document.body.style.cursor
    document.body.style.cursor = 'grabbing'
    return () => { document.body.style.cursor = prev }
  }, [source])

  if (source == null || typeof document === 'undefined') return null
  return createPortal(
    <div
      className={`sampler-mod-drag-ghost${hoverKey ? ' is-over' : ''}`}
      style={{ left: x, top: y, '--ghost-color': `var(${modSourceColorVar(source)})` }}
    >
      {label}
    </div>,
    document.body,
  )
}

export default ModDragGhost
