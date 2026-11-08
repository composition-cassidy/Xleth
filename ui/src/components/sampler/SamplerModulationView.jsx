import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { IconButton, hintAttrs } from '../../ui-kit'
import useSamplerModulationStore from '../../stores/samplerModulationStore.js'
import EnvEditor from './modulation/EnvEditor.jsx'
import LfoEditor from './modulation/LfoEditor.jsx'
import CurveEditor from './modulation/CurveEditor.jsx'
import ModRouteList from './modulation/ModRouteList.jsx'
import { useModCardDrag } from './modulation/ModDragLayer.jsx'
import {
  NUM_ENVS, NUM_LFOS, ENV_SOURCE_0, LFO_SOURCE_0, VELO_SOURCE, NOTE_SOURCE, routeCountForSource,
} from './modulation/modConstants.js'
import { sourceLabel } from './modulation/modTargets.js'
import styles from './Sampler.module.css'

// ── Modulation view ─────────────────────────────────────────────────────────
// Routes on the left; on the right one strip of sources (Env 1..6, LFO 1..6,
// Velocity, Note) above the selected source's editor. Every source tab is also
// the drag-to-route handle: click selects it, a drag drops it on any control
// that accepts modulation (holding the drag over the Main or Playback tab opens
// that view). Env 1 is the amp envelope: permanent, no remove.

// Modulation is a parameter signal: one colour for every source, from the
// signal palette (DESIGN.md 3.3). Which source drives what is said in words.
const SOURCE_COLOR = 'var(--ui-signal-parameter)'

function SourceTab({ source, label, active, routed, onSelect, onRemove, startDrag }) {
  return (
    <div className={styles.sourceTabWrap}>
      <div
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        className={styles.sourceTab}
        data-selected={active || undefined}
        data-source={source}
        onPointerDown={startDrag(source, label, onSelect)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
        aria-label={`${label}${routed ? `, drives ${routed} control${routed > 1 ? 's' : ''}` : ''}`}
        {...hintAttrs({
          hint: `${label}${routed ? `: drives ${routed} control${routed > 1 ? 's' : ''}` : ''}`,
          hintMods: 'Click: edit · Drag onto a control: route it',
        })}
      >
        {label}
        {routed ? <span className={styles.sourceCount}>{routed}</span> : null}
      </div>
      {onRemove ? (
        <IconButton size="sm" className={styles.sourceRemove} label={`Remove ${label} and its routes`} onClick={onRemove}>
          <X aria-hidden="true" />
        </IconButton>
      ) : null}
    </div>
  )
}

export default function SamplerModulationView({ slotIndex, chainLength, bpm }) {
  const [sel, setSel] = useState({ kind: 'env', index: 0 })
  const config = useSamplerModulationStore((s) => s.config)
  const loading = useSamplerModulationStore((s) => s.loading)
  const previewEnv = useSamplerModulationStore((s) => s.previewEnv)
  const previewLfo = useSamplerModulationStore((s) => s.previewLfo)
  const previewCurve = useSamplerModulationStore((s) => s.previewCurve)
  const commit = useSamplerModulationStore((s) => s.commit)
  const addEnv = useSamplerModulationStore((s) => s.addEnv)
  const addLfo = useSamplerModulationStore((s) => s.addLfo)
  const removeEnv = useSamplerModulationStore((s) => s.removeEnv)
  const removeLfo = useSamplerModulationStore((s) => s.removeLfo)
  const startDrag = useModCardDrag()

  if (!config) {
    return <div className={styles.modulation} data-view="modulation"><span className={styles.caption}>{loading ? 'Loading…' : 'No modulation data'}</span></div>
  }

  const envPresent = config.envPresent || []
  const lfoPresent = config.lfoPresent || []
  const routes = config.routes || []
  const envCount = envPresent.filter(Boolean).length
  const lfoCount = lfoPresent.filter(Boolean).length

  // The selection falls back to a present source when its own is removed.
  const firstPresent = (present) => present.findIndex(Boolean)
  let eff = sel
  if (sel.kind === 'env' && !envPresent[sel.index]) eff = { kind: 'env', index: firstPresent(envPresent) }
  if (sel.kind === 'lfo' && !lfoPresent[sel.index]) {
    eff = firstPresent(lfoPresent) >= 0 ? { kind: 'lfo', index: firstPresent(lfoPresent) } : { kind: 'env', index: 0 }
  }

  const tab = (kind, index, source, onRemove) => (
    <SourceTab
      key={`${kind}${index}`}
      source={source}
      label={sourceLabel(source)}
      active={eff.kind === kind && eff.index === index}
      routed={routeCountForSource(routes, source)}
      onSelect={() => setSel({ kind, index })}
      onRemove={onRemove}
      startDrag={startDrag}
    />
  )
  const addEnvTab = () => { const i = envPresent.findIndex((p) => !p); addEnv(); if (i >= 0) setSel({ kind: 'env', index: i }) }
  const addLfoTab = () => { const i = lfoPresent.findIndex((p) => !p); addLfo(); if (i >= 0) setSel({ kind: 'lfo', index: i }) }

  let editor = null
  if (eff.kind === 'env') {
    const src = ENV_SOURCE_0 + eff.index
    editor = (
      <EnvEditor
        key={`env-${eff.index}`} env={config.envs[eff.index]} color={SOURCE_COLOR} bpm={bpm} source={src}
        label={sourceLabel(src)} preview={(patch) => previewEnv(eff.index, patch)} commit={commit}
      />
    )
  } else if (eff.kind === 'lfo') {
    const src = LFO_SOURCE_0 + eff.index
    editor = (
      <LfoEditor
        key={`lfo-${eff.index}`} lfo={config.lfos[eff.index]} color={SOURCE_COLOR} bpm={bpm} source={src}
        label={sourceLabel(src)} preview={(patch) => previewLfo(eff.index, patch)} commit={commit}
      />
    )
  } else {
    const which = eff.kind
    const src = which === 'velo' ? VELO_SOURCE : NOTE_SOURCE
    editor = (
      <CurveEditor
        key={`${which}-ed`} curve={config[which]} color={SOURCE_COLOR} source={src}
        label={sourceLabel(src)} preview={(patch) => previewCurve(which, patch)} commit={commit}
      />
    )
  }

  return (
    <div className={styles.modulation} data-view="modulation">
      <ModRouteList slotIndex={slotIndex} chainLength={chainLength} />
      <div className={styles.modRight}>
        <div className={styles.sourceStrip} role="tablist" aria-label="Modulation sources">
          {envPresent.map((p, i) => (p ? tab('env', i, ENV_SOURCE_0 + i, i === 0 ? null : () => removeEnv(i)) : null))}
          <IconButton size="sm" label="Add an envelope" disabled={envCount >= NUM_ENVS} onClick={addEnvTab}
            hint={envCount >= NUM_ENVS ? `All ${NUM_ENVS} envelopes are in use` : 'Add an envelope'}>
            <Plus aria-hidden="true" />
          </IconButton>
          <span className={styles.stripGap} aria-hidden="true" />
          {lfoPresent.map((p, i) => (p ? tab('lfo', i, LFO_SOURCE_0 + i, () => removeLfo(i)) : null))}
          <IconButton size="sm" label="Add an LFO" disabled={lfoCount >= NUM_LFOS} onClick={addLfoTab}
            hint={lfoCount >= NUM_LFOS ? `All ${NUM_LFOS} LFOs are in use` : 'Add an LFO'}>
            <Plus aria-hidden="true" />
          </IconButton>
          <span className={styles.stripGap} aria-hidden="true" />
          {tab('velo', 0, VELO_SOURCE, null)}
          {tab('note', 0, NOTE_SOURCE, null)}
        </div>
        {editor}
      </div>
    </div>
  )
}
