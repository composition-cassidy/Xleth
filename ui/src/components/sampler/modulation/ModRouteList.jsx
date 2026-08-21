import useSamplerModulationStore from '../../../stores/samplerModulationStore.js'
import {
  sourceLabel, targetLabel, formatRouteDepth, modSourceColorVar,
} from './modTargets.js'

// ── Route list ───────────────────────────────────────────────────────────────
// Every route in one place: what drives what, how deep, its polarity, and a
// delete. It is the only view that shows routes whose target knob is currently
// off-screen (a MANGLE instance on an unselected slot, say), and the only way to
// remove a route without hunting down its knob.
//
// Amount and polarity here are the SAME store mutators the rings use, so each
// edit is one commit and one undo step.

export default function ModRouteList() {
  const routes = useSamplerModulationStore((s) => s.config?.routes)
  const toggleRouteBipolar = useSamplerModulationStore((s) => s.toggleRouteBipolar)
  const removeRoute = useSamplerModulationStore((s) => s.removeRoute)

  const list = Array.isArray(routes) ? routes : []

  return (
    <section className="sampler-mod-section sampler-mod-routes">
      <header className="sampler-mod-section-head">
        <span>Routes</span>
        <span className="sampler-mod-route-count">{list.length}</span>
      </header>
      {list.length === 0 ? (
        <div className="sampler-mod-empty">
          Drag a source tab onto a knob to route it.
        </div>
      ) : (
        <ul className="sampler-mod-route-list">
          {list.map((r, i) => {
            return (
              <li className="sampler-mod-route" key={`${r.source}-${r.target}-${r.index}-${r.stage}-${i}`}>
                <span
                  className="sampler-mod-route-src"
                  style={{ '--route-color': `var(${modSourceColorVar(r.source)})` }}
                >
                  {sourceLabel(r.source)}
                </span>
                <span className="sampler-mod-route-arrow" aria-hidden>→</span>
                <span className="sampler-mod-route-dst" title={targetLabel(r.target, r.index, r.stage)}>
                  {targetLabel(r.target, r.index, r.stage)}
                </span>
                <span className="sampler-mod-route-amount">{formatRouteDepth(r)}</span>
                <button
                  type="button"
                  className={`sampler-mod-route-pol${r.bipolar ? ' is-on' : ''}`}
                  onClick={() => toggleRouteBipolar(i)}
                  aria-pressed={!!r.bipolar}
                  title={r.bipolar
                    ? 'Bipolar — spreads ± around the knob’s value. Click for unipolar.'
                    : 'Unipolar — sweeps one way from the knob’s value. Click for bipolar.'}
                >
                  {r.bipolar ? '±' : '+'}
                </button>
                <button
                  type="button"
                  className="sampler-mod-route-del"
                  onClick={() => removeRoute(i)}
                  aria-label="Delete route"
                  title="Delete this route"
                >×</button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
