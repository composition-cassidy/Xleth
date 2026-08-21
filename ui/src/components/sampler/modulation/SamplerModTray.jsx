import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePanelRegistry } from '../../../windowing/registry/PanelRegistry'
import useSamplerModulationStore from '../../../stores/samplerModulationStore.js'
import { timelineEvents } from '../../../timelineEvents.js'
import EnvEditor from './EnvEditor.jsx'
import LfoEditor from './LfoEditor.jsx'
import CurveEditor from './CurveEditor.jsx'
import ModRouteList from './ModRouteList.jsx'
import { ModDragGhost, useModCardDrag } from './ModDragLayer.jsx'
import {
  NUM_ENVS, NUM_LFOS, ENV_SOURCE_0, LFO_SOURCE_0, VELO_SOURCE, NOTE_SOURCE,
  routeCountForSource,
} from './modConstants.js'

// ── Modulation tray ──────────────────────────────────────────────────────────
// The sampler's modulation sources live in a tray that slides out past the
// window's RIGHT edge, so an ENV/LFO editor sits beside the knobs it drives.
// Because the panel frame clips its overflow, the tray and its zigzag handle
// are portaled into the floating-window layer (escaping the frame's clip
// while staying in the same z-index stacking context as every other panel)
// and glued to the panel's live rect (a MutationObserver on the frame's
// inline transform tracks window drags).
//
// Layout, top to bottom:
//   • Routes — pinned at the top, its own capped scroll, so the wiring summary is
//     always in view no matter how far the editors below are scrolled.
//   • ENV / LFO — each a horizontal TAB STRIP: one editor is shown at a time and
//     you switch sources by tab instead of scrolling a tall stack. The "+" adds a
//     source (up to six); every tab past ENV 1 carries an "×" that removes it.
//     ENV 1 is the amp envelope / voice gate — permanent, so it has no "×".
//   • Response — VELO and NOTE, the two fixed response curves, as a two-tab
//     strip (the tray is too narrow to edit both side by side at full size).
//
// Every tab is ALSO the drag-to-route handle: a click selects it, a drag drops
// it onto any registered knob to create a route (threshold-gated in
// ModDragLayer). A tab whose source already drives something shows a coloured
// dot. All add/remove goes through the store, which commits once through the
// engine's undoable command.

// One tab in an ENV / LFO / response strip. `source` is the flat source index a
// drag drops; `onRemove` is omitted for the permanent tabs (ENV 1, VELO, NOTE).
function ModSourceTab({
  label, source, colorVar, active, routed, onSelect, onRemove, removeTitle, startDrag,
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      className={`sampler-mod-tab${active ? ' is-active' : ''}${routed ? ' is-routed' : ''}`}
      style={{ '--tab-color': `var(${colorVar})` }}
      onPointerDown={startDrag(source, label, onSelect)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
      title={`${label} — click to edit · drag onto a knob to route`}
    >
      {routed > 0 && <span className="sampler-mod-tab-dot" aria-hidden />}
      <span className="sampler-mod-tab-label">{label}</span>
      {onRemove && (
        <button
          type="button"
          className="sampler-mod-tab-x"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          title={removeTitle}
          aria-label={`Remove ${label}`}
        >×</button>
      )}
    </div>
  )
}

export default function SamplerModTray({ regionId, bpm = 140 }) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState(null)
  // Which source is showing in each strip. ENV/LFO hold a source INDEX (0..5);
  // the effective index is clamped to a present one at render, so removing the
  // selected source falls back gracefully without extra bookkeeping.
  const [selEnv, setSelEnv] = useState(0)
  const [selLfo, setSelLfo] = useState(0)
  const [selResp, setSelResp] = useState('velo')

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
  const startCardDrag = useModCardDrag()
  // The tray/handle are portaled out of the panel frame's clipped overflow, so
  // they need to borrow the sampler panel's own stacking position — otherwise
  // they'd float in a different stacking context than the other panels and
  // could never fall behind a focused one. usePanelRegistry is the source of
  // truth PanelFrame itself reads to compute z-index.
  const samplerZIndex = usePanelRegistry((s) => s.panels.sampler?.zIndex ?? 0)

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

  // Same formula PanelFrame uses for the sampler frame's own z-index, so the
  // tray/handle land in the same tier: above the sampler panel itself (they
  // mount after it in the portal container) but below any panel focused
  // more recently, instead of the fixed sky-high offset this used to have.
  const samplerZIndexStyle = `calc(var(--xleth-z-window-floating-base) + ${samplerZIndex})`

  const envPresent = config?.envPresent || []
  const lfoPresent = config?.lfoPresent || []
  const envCount = envPresent.filter(Boolean).length
  const lfoCount = lfoPresent.filter(Boolean).length
  const routes = config?.routes || []

  // Effective (clamped-to-present) selection for each dynamic strip. ENV 1 is
  // always present, so effEnv is never -1; the LFO strip can be empty.
  const firstPresent = (present) => present.findIndex(Boolean)
  const effEnv = envPresent[selEnv] ? selEnv : firstPresent(envPresent)
  const effLfo = lfoPresent[selLfo] ? selLfo : firstPresent(lfoPresent)

  // Adding a source selects it immediately so its editor is what you land on.
  const handleAddEnv = () => { const i = envPresent.findIndex((p) => !p); addEnv(); if (i >= 0) setSelEnv(i) }
  const handleAddLfo = () => { const i = lfoPresent.findIndex((p) => !p); addLfo(); if (i >= 0) setSelLfo(i) }

  const handle = (
    <button
      type="button"
      className={`sampler-mod-tray-handle${open ? ' is-open' : ''}`}
      style={{ top: rect.top + rect.height / 2, left: rect.right, zIndex: samplerZIndexStyle }}
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

  const tray = (
    <aside
      className={`sampler-mod-tray${open ? ' is-open' : ''}`}
      style={{ top: rect.top, left: rect.right, height: rect.height, zIndex: samplerZIndexStyle }}
      aria-hidden={!open}
    >
      {!config && loading && <div className="sampler-mod-tray-scroll"><div className="sampler-mod-empty">Loading…</div></div>}
      {config && (
        <>
          {/* Routes — locked to the top, own capped scroll. */}
          <div className="sampler-mod-tray-routes">
            <ModRouteList />
          </div>

          <div className="sampler-mod-tray-scroll">
            {/* ── ENV strip ─────────────────────────────────────────────── */}
            <section className="sampler-mod-section">
              <div className="sampler-mod-tabstrip" role="tablist" aria-label="Envelopes">
                <div className="sampler-mod-tabs">
                  {envPresent.map((present, i) => present && (
                    <ModSourceTab
                      key={`env${i}`}
                      label={`ENV ${i + 1}`}
                      source={ENV_SOURCE_0 + i}
                      colorVar="--mod-env"
                      active={effEnv === i}
                      routed={routeCountForSource(routes, ENV_SOURCE_0 + i)}
                      onSelect={() => setSelEnv(i)}
                      onRemove={i === 0 ? null : () => removeEnv(i)}
                      removeTitle={`Remove ENV ${i + 1} and its routes`}
                      startDrag={startCardDrag}
                    />
                  ))}
                </div>
                <button
                  type="button" className="sampler-mod-add-src"
                  onClick={handleAddEnv} disabled={envCount >= NUM_ENVS}
                  title={envCount >= NUM_ENVS ? 'All 6 envelopes added' : 'Add an envelope'}
                  aria-label="Add envelope"
                >+</button>
              </div>
              <div className="sampler-mod-tabpanel">
                {effEnv >= 0 && (
                  <EnvEditor
                    key={`env-ed-${effEnv}`}
                    env={config.envs[effEnv]} color="var(--mod-env)" bpm={bpm}
                    source={ENV_SOURCE_0 + effEnv}
                    preview={(patch) => previewEnv(effEnv, patch)} commit={commit}
                  />
                )}
              </div>
            </section>

            {/* ── LFO strip ─────────────────────────────────────────────── */}
            <section className="sampler-mod-section">
              <div className="sampler-mod-tabstrip" role="tablist" aria-label="LFOs">
                <div className="sampler-mod-tabs">
                  {lfoPresent.map((present, i) => present && (
                    <ModSourceTab
                      key={`lfo${i}`}
                      label={`LFO ${i + 1}`}
                      source={LFO_SOURCE_0 + i}
                      colorVar="--mod-lfo"
                      active={effLfo === i}
                      routed={routeCountForSource(routes, LFO_SOURCE_0 + i)}
                      onSelect={() => setSelLfo(i)}
                      onRemove={() => removeLfo(i)}
                      removeTitle={`Remove LFO ${i + 1} and its routes`}
                      startDrag={startCardDrag}
                    />
                  ))}
                </div>
                <button
                  type="button" className="sampler-mod-add-src"
                  onClick={handleAddLfo} disabled={lfoCount >= NUM_LFOS}
                  title={lfoCount >= NUM_LFOS ? 'All 6 LFOs added' : 'Add an LFO'}
                  aria-label="Add LFO"
                >+</button>
              </div>
              <div className="sampler-mod-tabpanel">
                {effLfo >= 0 ? (
                  <LfoEditor
                    key={`lfo-ed-${effLfo}`}
                    lfo={config.lfos[effLfo]} color="var(--mod-lfo)" bpm={bpm}
                    source={LFO_SOURCE_0 + effLfo}
                    preview={(patch) => previewLfo(effLfo, patch)} commit={commit}
                  />
                ) : (
                  <div className="sampler-mod-empty">No LFO — add one with “+”.</div>
                )}
              </div>
            </section>

            {/* ── Response strip (VELO / NOTE) ──────────────────────────── */}
            <section className="sampler-mod-section">
              <div className="sampler-mod-tabstrip" role="tablist" aria-label="Response curves">
                <div className="sampler-mod-tabs">
                  <ModSourceTab
                    label="VELO" source={VELO_SOURCE} colorVar="--mod-velo"
                    active={selResp === 'velo'} routed={routeCountForSource(routes, VELO_SOURCE)}
                    onSelect={() => setSelResp('velo')} startDrag={startCardDrag}
                  />
                  <ModSourceTab
                    label="NOTE" source={NOTE_SOURCE} colorVar="--mod-note"
                    active={selResp === 'note'} routed={routeCountForSource(routes, NOTE_SOURCE)}
                    onSelect={() => setSelResp('note')} startDrag={startCardDrag}
                  />
                </div>
              </div>
              <div className="sampler-mod-tabpanel">
                {selResp === 'velo' ? (
                  <CurveEditor
                    key="velo-ed"
                    curve={config.velo} color="var(--mod-velo)" label="VELO"
                    source={VELO_SOURCE}
                    preview={(patch) => previewCurve('velo', patch)} commit={commit}
                  />
                ) : (
                  <CurveEditor
                    key="note-ed"
                    curve={config.note} color="var(--mod-note)" label="NOTE"
                    source={NOTE_SOURCE}
                    preview={(patch) => previewCurve('note', patch)} commit={commit}
                  />
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </aside>
  )

  // Portal into the floating-window layer (the SAME stacking context every
  // other panel frame's z-index is scoped to), not document.body — that
  // layer establishes its own stacking context (position + z-index), so a
  // body-level portal's z-index would be compared against the WHOLE layer
  // rather than against individual panels inside it, and could never fall
  // behind a focused one no matter what number it carried.
  const portalTarget = document.querySelector('.xleth-floating-window-layer') || document.body

  return createPortal(<>{handle}{tray}<ModDragGhost /></>, portalTarget)
}
