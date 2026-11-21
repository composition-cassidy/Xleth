import { useCallback, useEffect, useRef } from 'react'
import {
  degFmt, mulFmt, pctFmt, signedDegFmt, signedPctFmt, zoomFmt,
} from '../../lensRoam/lensFormats.js'
import lens from './lensRoam.module.css'

// The layer stack of one note or event: what the framing is made of, with the
// value of every layer at the playhead and the resolved value they add up to.
// (Spec "Blend": zoom multiplies; centre and rotation add. Sweep is P11, so its
// row says "none".)
//
// The numbers follow the playhead, which is engine time pushed at frame rate:
// they are written straight into the cells (textContent), never through React
// state, so playback does not re-render the panel.

const COLS = [
  { channel: 'zoom', head: 'Zoom' },
  { channel: 'centerX', head: 'Center X' },
  { channel: 'centerY', head: 'Center Y' },
  { channel: 'rotationDeg', head: 'Rotate' },
]

const ABS = { zoom: zoomFmt.format, centerX: pctFmt.format, centerY: pctFmt.format, rotationDeg: degFmt.format }
const LAYER = { zoom: mulFmt.format, centerX: signedPctFmt.format, centerY: signedPctFmt.format, rotationDeg: signedDegFmt.format }

/**
 * @param {object} props
 * @param {{id: string, label: string, status?: string, layer: boolean}[]} props.rows
 *        in stack order; `layer` rows print as a multiplier / offset, others as a value
 * @param {() => ({values: Object<string, object|null>, note: string|null})} props.compute
 *        values[rowId] = {zoom, centerX, centerY, rotationDeg} | null (the layer does not apply)
 * @param {(cb: () => void) => (() => void)} [props.subscribePlayhead]
 * @param {string} props.label
 */
export default function LensLayerStack({ rows, compute, subscribePlayhead, label }) {
  const rootRef = useRef(null)
  const computeRef = useRef(compute)
  computeRef.current = compute

  const update = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    const { values, note } = computeRef.current()
    for (const row of root.querySelectorAll('[data-row]')) {
      const id = row.getAttribute('data-row')
      const isLayer = row.getAttribute('data-layer') === 'true'
      const v = values?.[id]
      for (const col of row.querySelectorAll('[data-col]')) {
        const ch = col.getAttribute('data-col')
        const x = v ? v[ch] : null
        const text = x == null ? '—' : (isLayer ? LAYER : ABS)[ch](x)
        if (col.textContent !== text) col.textContent = text
      }
    }
    const noteEl = root.querySelector('[data-stack-note]')
    if (noteEl) {
      const text = note ?? ''
      if (noteEl.textContent !== text) noteEl.textContent = text
    }
  }, [])

  useEffect(() => { update() })   // props / data change; never per frame
  useEffect(() => (subscribePlayhead ? subscribePlayhead(update) : undefined), [subscribePlayhead, update])

  return (
    <div ref={rootRef} className={lens.stack} data-testid="lens-layer-stack">
      <table aria-label={label}>
        <thead>
          <tr>
            <th scope="col"><span className={lens.srOnly}>Layer</span></th>
            {COLS.map((c) => <th key={c.channel} scope="col">{c.head}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id} data-row={r.id} data-layer={r.layer ? 'true' : 'false'}
              data-resolved={r.id === 'resolved' ? 'true' : undefined}
              data-inert={r.status ? 'true' : undefined}
            >
              <th scope="row">
                <span>{r.label}</span>
                {r.status && <span className={lens.stackStatus} data-testid={`lens-layer-status-${r.id}`}>{r.status}</span>}
              </th>
              {COLS.map((c) => <td key={c.channel} data-col={c.channel}>—</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <p className={lens.note} data-stack-note data-testid="lens-stack-note" aria-live="off" />
    </div>
  )
}

