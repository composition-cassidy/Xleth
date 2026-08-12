import { useEffect, useCallback } from 'react'
import useSamplerModulationStore from '../../../stores/samplerModulationStore.js'
import { timelineEvents } from '../../../timelineEvents.js'
import EnvEditor from './EnvEditor.jsx'
import LfoEditor from './LfoEditor.jsx'
import CurveEditor from './CurveEditor.jsx'
import { buildCards, routeCountForSource } from './modConstants.js'

// ── Modulation source rack ───────────────────────────────────────────────────
// The card rack (ENV 1-6 / LFO 1-6 / VELO / NOTE) plus the editor for the
// selected card. Selecting a card opens its editor below (Serum-style). The
// engine config lives in the zustand store; this component only orchestrates
// selection and binds the per-source preview/commit callbacks.
//
// This phase intentionally has NO drag-to-route — a card shows a "in use" dot
// when routes already leave it (from the engine), but wiring routes up is the
// next phase.

const CARDS = buildCards()

export default function ModulationRack({ regionId, bpm = 140 }) {
  const config = useSamplerModulationStore((s) => s.config)
  const selectedCard = useSamplerModulationStore((s) => s.selectedCard)
  const loading = useSamplerModulationStore((s) => s.loading)
  const load = useSamplerModulationStore((s) => s.load)
  const selectCard = useSamplerModulationStore((s) => s.selectCard)
  const previewEnv = useSamplerModulationStore((s) => s.previewEnv)
  const previewLfo = useSamplerModulationStore((s) => s.previewLfo)
  const previewCurve = useSamplerModulationStore((s) => s.previewCurve)
  const commit = useSamplerModulationStore((s) => s.commit)

  // Load on region change. Reload on external sampler changes NOT originating
  // from our own commit (e.g. undo/redo, a project reload) so the rack stays in
  // sync — our own commit already updated local state, so re-fetching there is
  // just a confirming round trip and harmless.
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

  const card = CARDS.find((c) => c.id === selectedCard) || CARDS[0]

  const renderEditor = useCallback(() => {
    if (!config) return null
    if (card.kind === 'env') {
      return (
        <EnvEditor
          env={config.envs[card.index]}
          color={card.color}
          bpm={bpm}
          preview={(patch) => previewEnv(card.index, patch)}
          commit={commit}
        />
      )
    }
    if (card.kind === 'lfo') {
      return (
        <LfoEditor
          lfo={config.lfos[card.index]}
          color={card.color}
          bpm={bpm}
          preview={(patch) => previewLfo(card.index, patch)}
          commit={commit}
        />
      )
    }
    // velo / note
    const which = card.kind
    return (
      <CurveEditor
        curve={config[which]}
        color={card.color}
        label={card.label}
        preview={(patch) => previewCurve(which, patch)}
        commit={commit}
      />
    )
  }, [config, card, bpm, previewEnv, previewLfo, previewCurve, commit])

  const routes = config?.routes || []

  return (
    <div className="sampler-mod-rack sampler-page">
      <div className="sampler-mod-card-grid">
        {CARDS.map((c) => {
          const active = c.id === selectedCard
          const inUse = routeCountForSource(routes, c.source) > 0
          return (
            <button
              type="button"
              key={c.id}
              className={`sampler-mod-card${active ? ' is-active' : ''}${inUse ? ' is-inuse' : ''}`}
              style={{ '--card-color': c.color }}
              onClick={() => selectCard(c.id)}
              title={inUse ? `${c.label} — ${routeCountForSource(routes, c.source)} route(s)` : c.label}
            >
              <span className="sampler-mod-card-label">{c.label}</span>
              {inUse && <span className="sampler-mod-card-dot" aria-hidden />}
            </button>
          )
        })}
      </div>

      <div className="sampler-mod-editor-well">
        {loading && !config
          ? <div className="sampler-mod-empty">Loading…</div>
          : renderEditor()}
      </div>
    </div>
  )
}
