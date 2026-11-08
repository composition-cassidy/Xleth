import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { Button, DeviceSection, IconButton, NumberBox, Select, Toggle } from '../../../ui-kit'
import useSamplerModulationStore from '../../../stores/samplerModulationStore.js'
import {
  formatRouteDepth, parseRouteDepth, routeTargetOptions, sourceLabel, targetLabel,
} from './modTargets.js'
import { ENV_SOURCE_0, LFO_SOURCE_0, NOTE_SOURCE, VELO_SOURCE } from './modConstants.js'
import styles from '../Sampler.module.css'

// ── Routes ───────────────────────────────────────────────────────────────────
// Every route in one place: what drives what, how deep (typed or dragged, in the
// target's own unit), its polarity, and a delete. It is the only view of routes
// whose control is off-screen, and "Add route" is the keyboard alternative to
// dragging a source onto a control. Every edit is one store commit, one undo step.

export default function ModRouteList({ slotIndex = 0, chainLength = 0 }) {
  const config = useSamplerModulationStore((s) => s.config)
  const previewRouteAmount = useSamplerModulationStore((s) => s.previewRouteAmount)
  const setRouteAmount = useSamplerModulationStore((s) => s.setRouteAmount)
  const toggleRouteBipolar = useSamplerModulationStore((s) => s.toggleRouteBipolar)
  const removeRoute = useSamplerModulationStore((s) => s.removeRoute)
  const addRoute = useSamplerModulationStore((s) => s.addRoute)

  const routes = Array.isArray(config?.routes) ? config.routes : []
  const envPresent = config?.envPresent || []
  const lfoPresent = config?.lfoPresent || []

  const sources = useMemo(() => [
    ...envPresent.map((p, i) => (p ? ENV_SOURCE_0 + i : null)),
    ...lfoPresent.map((p, i) => (p ? LFO_SOURCE_0 + i : null)),
    VELO_SOURCE, NOTE_SOURCE,
  ].filter((v) => v != null).map((v) => ({ value: v, label: sourceLabel(v) })), [envPresent, lfoPresent])
  const targets = useMemo(
    () => routeTargetOptions({ slotIndex, chainLength, envPresent, lfoPresent })
      .map((t) => ({ value: t.key, label: t.label, group: t.group, reg: t.reg })),
    [slotIndex, chainLength, envPresent, lfoPresent],
  )
  const [src, setSrc] = useState(null)
  const [tgt, setTgt] = useState(null)
  const srcValue = sources.some((o) => o.value === src) ? src : (sources[0]?.value ?? null)
  const tgtValue = targets.some((o) => o.value === tgt) ? tgt : (targets[0]?.value ?? null)

  return (
    <DeviceSection
      title={`Routes ${routes.length}`}
      className={styles.routes}
      data-section="routes"
    >
      <div className={styles.routeList} role="list" aria-label="Modulation routes">
        {routes.length === 0 ? (
          <span className={styles.caption}>No routes. Drag a source onto a control, or add one below.</span>
        ) : routes.map((r, i) => {
          const name = `${sourceLabel(r.source)} → ${targetLabel(r.target, r.index, r.stage)}`
          return (
            <div className={styles.routeRow} role="listitem" key={`${r.source}-${r.target}-${r.index}-${r.stage}-${i}`} data-route={i}>
              <span className={styles.routeName} data-hint={name}>
                <span className={styles.routeSrc}>{sourceLabel(r.source)}</span>
                {' → '}
                {targetLabel(r.target, r.index, r.stage)}
              </span>
              <NumberBox
                label={`${name} depth`}
                hideLabel
                width={84}
                bipolar
                min={-100} max={100} defaultValue={0} step={1}
                value={(r.amount ?? 0) * 100}
                format={(v) => formatRouteDepth({ ...r, amount: v / 100 })}
                parse={(t) => { const a = parseRouteDepth(r, t); return a == null ? null : a * 100 }}
                onChange={(v) => previewRouteAmount(i, v / 100)}
                onCommit={(v) => setRouteAmount(i, v / 100)}
                hint={`Depth of ${name}, in the target's unit (octaves for a time or rate)`}
                data-route-field="amount"
              />
              <Toggle
                size="sm" className={styles.routePol} on={!!r.bipolar}
                onChange={() => toggleRouteBipolar(i)}
                aria-label={`${name}: bipolar`}
                hint={r.bipolar
                  ? 'Bipolar: spreads either side of the control value. Click for one-sided.'
                  : 'One-sided: sweeps one way from the control value. Click for bipolar.'}
                data-route-field="bipolar"
              >±</Toggle>
              <IconButton size="sm" label={`Delete route ${name}`} onClick={() => removeRoute(i)} data-route-field="delete">
                <X aria-hidden="true" />
              </IconButton>
            </div>
          )
        })}
      </div>
      <div className={styles.routeAdd}>
        <Select size="sm" className={styles.routeAddSrc} ariaLabel="New route source" value={srcValue} options={sources}
          onChange={(v) => setSrc(Number(v))} hint="Source of the new route" />
        <Select size="sm" className={styles.routeAddTgt} ariaLabel="New route target" value={tgtValue} options={targets}
          onChange={(v) => setTgt(v)} hint="Control the new route drives" />
        <Button
          size="sm"
          disabled={srcValue == null || tgtValue == null}
          onClick={() => {
            const t = targets.find((o) => o.value === tgtValue)
            if (t && srcValue != null) addRoute(srcValue, t.reg)
          }}
          hint="Add the route (the same as dragging the source onto the control)"
          data-route-field="add"
        >Add</Button>
      </div>
    </DeviceSection>
  )
}
