import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import useSamplerModulationStore from '../../../stores/samplerModulationStore.js'
import { timelineEvents } from '../../../timelineEvents.js'
import EnvEditor from './EnvEditor.jsx'
import LfoEditor from './LfoEditor.jsx'
import CurveEditor from './CurveEditor.jsx'
import { NUM_ENVS, NUM_LFOS } from './modConstants.js'

// ── Modulation tray ──────────────────────────────────────────────────────────
// The sampler's modulation sources used to be a tab; they now live in a tray
// that slides out past the window's RIGHT edge, so an ENV/LFO editor sits beside
// the knobs it drives. Because the panel frame clips its overflow, the tray and
// its zigzag handle are portaled to <body> and glued to the panel's live rect
// (a MutationObserver on the frame's inline transform tracks window drags).
//
// ENV and LFO are dynamic: the "+" in each section header adds one source (up to
// six), and every card past ENV 1 carries a "×" that removes it. ENV 1 is the
// amp envelope / voice gate — permanent, so it has no remove control. VELO and
// NOTE are fixed response curves. All add/remove goes through the store, which
// commits once through the engine's undoable command.

export default function SamplerModTray({ regionId, bpm = 140 }) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState(null)

  const config = useSamplerModulationStore((s) => s.config)
  const loading = useSamplerModulationStore((s) => s.loading)
  const load = useSamplerModulationStore((s) => s.load)
  const previewEnv = useSamplerModulationStore((s) => s.previewEnv)
  const previewLfo = useSamplerModulationStore((s) => s.previewLfo)
  const previewCurve = useSamplerModulationStore((s) => s.previewCurve)
  const commit = useSamplerModulationStore((s) => s.commit)
  const addEnv = useSamplerModulationStore((s) => s.addEnv)
  const addLfo = useSamplerModulationStore((s) => s.addLfo)
  const removeEnv = useSamplerModulationStore((s) => s.removeEnv)
  const removeLfo = useSamplerModulationStore((s) => s.removeLfo)

  // Load this region's config; reload on external sampler changes that are not
  // our own commit (undo/redo, project reload) so the tray stays in sync.
  useEffect(() => {
    if (regionId == null) return
    load(regionId)
    const onChanged = (e) => {
      if (e.detail?.regionId && e.detail.regionId !== regionId) return
      load(regionId)
    }
    timelineEvents.addEventListener('timeline-sampler-changed', onChanged)
    return () => timelineEvents.removeEventListener('timeline-sampler-changed', onChanged)
  }, [regionId, load])

  // Track the sampler panel frame's rect so the portaled handle + tray stay
  // glued to its right edge as the window is moved or resized. The frame writes
  // its position as an inline `transform`, so an attribute observer catches
  // every drag frame without a running animation loop.
  useEffect(() => {
    const frame = document.querySelector('[data-panel-id="sampler"]')
    if (!frame) return
    const update = () => {
      const r = frame.getBoundingClientRect()
      setRect({ top: r.top, right: r.right, height: r.height })
    }
    update()
    const mo = new MutationObserver(update)
    mo.observe(frame, { attributes: true, attributeFilter: ['style', 'class', 'data-panel-mode'] })
    window.addEventListener('resize', update)
    return () => { mo.disconnect(); window.removeEventListener('resize', update) }
  }, [regionId])

  if (!rect || typeof document === 'undefined') return null

  const envPresent = config?.envPresent || []
  const lfoPresent = config?.lfoPresent || []
  const envCount = envPresent.filter(Boolean).length
  const lfoCount = lfoPresent.filter(Boolean).length

  const handle = (
    <button
      type="button"
      className={`sampler-mod-tray-handle${open ? ' is-open' : ''}`}
      style={{ top: rect.top + rect.height / 2, left: rect.right }}
      onClick={() => setOpen((o) => !o)}
      title={open ? 'Close modulation tray' : 'Open modulation tray'}
      aria-expanded={open}
      aria-label="Modulation tray"
    >
      <svg width={12} height={44} viewBox="0 0 12 44" aria-hidden>
        <path
          d="M8,6 L4,12 L8,18 L4,24 L8,30 L4,36"
          fill="none" stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round"
        />
      </svg>
    </button>
  )

  const renderSrcCard = (kind, i, editor) => (
    <div className="sampler-mod-src-card" style={{ '--card-color': `var(--mod-${kind})` }}>
      <header className="sampler-mod-src-head">
        <span>{kind === 'env' ? 'ENV' : 'LFO'} {i + 1}</span>
        {!(kind === 'env' && i === 0) && (
          <button
            type="button"
            className="sampler-mod-remove-src"
            onClick={() => (kind === 'env' ? removeEnv(i) : removeLfo(i))}
            title={`Remove ${kind === 'env' ? 'ENV' : 'LFO'} ${i + 1} and its routes`}
            aria-label="Remove source"
          >×</button>
        )}
      </header>
      {editor}
    </div>
  )

  const tray = (
    <aside
      className={`sampler-mod-tray${open ? ' is-open' : ''}`}
      style={{ top: rect.top, left: rect.right, height: rect.height }}
      aria-hidden={!open}
    >
      <div className="sampler-mod-tray-scroll">
        {!config && loading && <div className="sampler-mod-empty">Loading…</div>}
        {config && (
          <>
            <section className="sampler-mod-section">
              <header className="sampler-mod-section-head">
                <span>ENV</span>
                <button
                  type="button" className="sampler-mod-add-src"
                  onClick={addEnv} disabled={envCount >= NUM_ENVS}
                  title={envCount >= NUM_ENVS ? 'All 6 envelopes added' : 'Add an envelope'}
                  aria-label="Add envelope"
                >+</button>
              </header>
              {envPresent.map((present, i) => present && (
                <div key={`env${i}`}>
                  {renderSrcCard('env', i, (
                    <EnvEditor
                      env={config.envs[i]} color="var(--mod-env)" bpm={bpm}
                      preview={(patch) => previewEnv(i, patch)} commit={commit}
                    />
                  ))}
                </div>
              ))}
            </section>

            <section className="sampler-mod-section">
              <header className="sampler-mod-section-head">
                <span>LFO</span>
                <button
                  type="button" className="sampler-mod-add-src"
                  onClick={addLfo} disabled={lfoCount >= NUM_LFOS}
                  title={lfoCount >= NUM_LFOS ? 'All 6 LFOs added' : 'Add an LFO'}
                  aria-label="Add LFO"
                >+</button>
              </header>
              {lfoPresent.map((present, i) => present && (
                <div key={`lfo${i}`}>
                  {renderSrcCard('lfo', i, (
                    <LfoEditor
                      lfo={config.lfos[i]} color="var(--mod-lfo)" bpm={bpm}
                      preview={(patch) => previewLfo(i, patch)} commit={commit}
                    />
                  ))}
                </div>
              ))}
            </section>

            <section className="sampler-mod-section">
              <header className="sampler-mod-section-head"><span>Response</span></header>
              <div className="sampler-mod-src-card" style={{ '--card-color': 'var(--mod-velo)' }}>
                <header className="sampler-mod-src-head"><span>VELO</span></header>
                <CurveEditor
                  curve={config.velo} color="var(--mod-velo)" label="VELO"
                  preview={(patch) => previewCurve('velo', patch)} commit={commit}
                />
              </div>
              <div className="sampler-mod-src-card" style={{ '--card-color': 'var(--mod-note)' }}>
                <header className="sampler-mod-src-head"><span>NOTE</span></header>
                <CurveEditor
                  curve={config.note} color="var(--mod-note)" label="NOTE"
                  preview={(patch) => previewCurve('note', patch)} commit={commit}
                />
              </div>
            </section>
          </>
        )}
      </div>
    </aside>
  )

  return createPortal(<>{handle}{tray}</>, document.body)
}
