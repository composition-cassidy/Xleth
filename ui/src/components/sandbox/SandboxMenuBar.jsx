import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Plus, Settings2 } from 'lucide-react'
import useSandboxStore, { hasMeaningfulSelection } from '../../stores/sandboxStore.js'
import useSeparationStore, { SEPARATION_TERMINAL_STATES } from '../../stores/separationStore.js'
import { EFFECT_CATEGORIES, EFFECT_REGISTRY } from '../../stores/sandboxEffectRegistry.js'
import { Button, Menu, MenuCustom, MenuItem, MenuSeparator } from '../../ui-kit'
import {
  FALLBACK_TIERS, tierTitle, estimateSeconds, formatDuration,
} from './SandboxSeparationStrip.jsx'
import styles from './Sandbox.module.css'

// The Effect and View menus — the single entry point for adding an operation
// plus the waveform / spectral view switch. Effect renders purely off
// sandboxEffectRegistry.js and the active layer's current op stack; nothing
// here hardcodes which ops exist. The menus are kit Menus anchored under
// their button, so keyboard, focus return and outside-press are the kit's.

/** "De-Noise" -> "De-noise": the registry's labels are title case, the UI is sentence case. */
const sentence = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : s)

function reasonForEntry(entry, { hasLayer, hasSelection, hasClipboard, layer }) {
  if (entry.alwaysDisabled) return entry.disabledReason
  if (!hasLayer) return 'Select a layer first'
  if (entry.needsSelection && !hasSelection) return 'Select a range first'
  if (entry.needsClipboard && !hasClipboard) return 'Clipboard is empty'
  if (entry.maxInstances < Infinity) {
    const count = layer.ops.filter(entry.matchesStack).length
    if (count >= entry.maxInstances) return `${entry.whyNoMulti ? entry.whyNoMulti : 'one instance max'} — already in stack`
  }
  return null
}

function EffectMenu({ x, y, onClose, onOpenAdvancedSeparation }) {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const selection = useSandboxStore((s) => s.selection)
  const clipboard = useSandboxStore((s) => s.clipboard)
  const separateActiveLayer = useSeparationStore((s) => s.separateActiveLayer)
  const status = useSeparationStore((s) => s.status)
  const statusState = useSeparationStore((s) => s.statusState)
  const catalog = useSeparationStore((s) => s.catalog)
  const job = useSeparationStore((s) => s.job)

  const layer = layers.find((l) => l.id === activeLayerId) ?? null
  const layerReady = !!layer && layer.renderState === 'ready'
  const hasSelection = layerReady && hasMeaningfulSelection(selection, layer.renderedBuffer?.sampleRate)
  const cursorSample = selection?.startSample ?? 0
  const running = !!job && !SEPARATION_TERMINAL_STATES.has(job.state)

  const pythonMissing = statusState === 'ready' && !status?.python
  const runtimeBroken = status?.runtimeOk === false
  const missingPackages = status?.missing?.length ? status.missing.join(', ') : null
  const globalReason = pythonMissing
    ? 'Python 3.9+ with the sidecar requirements is not installed'
    : runtimeBroken
      ? `Sidecar is missing ${missingPackages || 'required packages'}`
      : !layer
        ? 'Select a layer to separate'
        : !layerReady
          ? 'Waiting for this layer to finish rendering'
          : running
            ? 'A separation is already running'
            : null

  const durationSec = layerReady && layer.renderedBuffer?.channels?.[0]?.length && layer.renderedBuffer.sampleRate
    ? layer.renderedBuffer.channels[0].length / layer.renderedBuffer.sampleRate
    : null

  const tiers = catalog?.tiers?.length
    ? catalog.tiers.map((t) => ({ ...t, model: t.modelId ? catalog.models?.find((m) => m.id === t.modelId) ?? null : null }))
    : FALLBACK_TIERS.map((t) => ({ ...t, model: null }))

  function reasonForTier(tier) {
    if (globalReason) return globalReason
    if (!tier.enabled) return null
    const model = tier.model
    if (model && model.runtimeOk === false) {
      const missing = model.missing?.length ? model.missing.join(', ') : 'required packages'
      // XLETH bundles its own Python runtime, so a missing package means a damaged install,
      // not something the user is expected to go and pip-install.
      return `${tier.label} needs ${missing} — XLETH's bundled runtime looks incomplete, reinstalling should fix it`
    }
    if (model && model.license && model.license.cleared === false) {
      return `${tier.label}'s model (${model.license.spdx || 'licence'}) has not cleared its audit`
    }
    return null
  }

  const runEntry = (entry) => {
    if (!entry.run) return
    const store = useSandboxStore.getState()
    entry.run(store, {
      layerId: layer.id, selection: store.selection, cursorSample, hasSelection,
    })
  }

  return (
    <Menu x={x} y={y} onClose={onClose} label="Effect">
      {EFFECT_CATEGORIES.map((cat) => (
        <div key={cat} role="group" aria-label={sentence(cat)}>
          <MenuCustom><div className={styles.menuCat}>{sentence(cat)}</div></MenuCustom>
          {EFFECT_REGISTRY.filter((e) => e.category === cat).map((entry) => {
            const reason = reasonForEntry(entry, {
              hasLayer: !!layer, hasSelection, hasClipboard: !!clipboard, layer,
            })
            const inStack = entry.maxInstances < Infinity && !!layer && layer.ops.some(entry.matchesStack)
            const badge = entry.maxInstances === Infinity ? '×N' : inStack ? 'In stack' : '1×'
            return (
              <MenuItem
                key={entry.id}
                icon={<Plus size={12} />}
                disabled={!!reason || !entry.run}
                onSelect={() => runEntry(entry)}
              >
                <span className={styles.itemLine} title={reason || ''}>
                  <span>{entry.label}</span>
                  <span className={styles.itemBadge}>{badge}</span>
                </span>
              </MenuItem>
            )
          })}
        </div>
      ))}
      <MenuSeparator />
      <div role="group" aria-label="Separate">
        <MenuCustom><div className={styles.menuCat}>Separate</div></MenuCustom>
        {tiers.map((tier) => {
          const blocked = reasonForTier(tier)
          return (
            <MenuItem
              key={tier.id}
              disabled={!tier.enabled || !!blocked}
              onSelect={() => separateActiveLayer(tier.id)}
            >
              <span title={tierTitle(tier, tier.model, durationSec, blocked)}>{sentence(tier.label)}</span>
            </MenuItem>
          )
        })}
        <MenuItem
          icon={<Settings2 size={12} />}
          onSelect={() => onOpenAdvancedSeparation()}
        >
          <span title="Ensemble (average two models) and de-bleed (reduce cross-talk between stems)">
            Advanced (ensemble, de-bleed)…
          </span>
        </MenuItem>
      </div>
    </Menu>
  )
}

function ViewMenu({ x, y, onClose }) {
  const viewMode = useSandboxStore((s) => s.viewMode)
  const setViewMode = useSandboxStore((s) => s.setViewMode)
  return (
    <Menu x={x} y={y} onClose={onClose} label="View">
      <MenuItem checked={viewMode === 'wav'} onSelect={() => setViewMode('wav')}>Waveform</MenuItem>
      <MenuItem checked={viewMode === 'spc'} onSelect={() => setViewMode('spc')}>Spectral</MenuItem>
    </Menu>
  )
}

export default function SandboxMenuBar({ onOpenAdvancedSeparation }) {
  const [open, setOpen] = useState(null) // { menu: 'effect' | 'view', x, y } | null
  const ensureSubscribed = useSeparationStore((s) => s.ensureSubscribed)
  const refreshStatus = useSeparationStore((s) => s.refreshStatus)
  const loadCatalog = useSeparationStore((s) => s.loadCatalog)
  const status = useSeparationStore((s) => s.status)
  const catalog = useSeparationStore((s) => s.catalog)
  const lastClosed = useRef(0)

  // Bootstrap the separation sidecar probe from here rather than only from
  // SandboxSeparationStrip — the strip is mounted conditionally (only while a
  // job/prompt/advanced panel is actually visible), but the Separate section
  // needs real tier availability the moment the menu opens, before any job has
  // ever started.
  useEffect(() => { ensureSubscribed(); refreshStatus() }, [ensureSubscribed, refreshStatus])
  useEffect(() => { if (status?.running && !catalog) loadCatalog() }, [status?.running, catalog, loadCatalog])

  const close = () => { lastClosed.current = Date.now(); setOpen(null) }

  const toggle = (menu) => (e) => {
    // A press on the open menu's own button first closes it (outside press); do not reopen on that click.
    if (Date.now() - lastClosed.current < 250 && open === null) return
    if (open?.menu === menu) { close(); return }
    const r = e.currentTarget.getBoundingClientRect()
    setOpen({ menu, x: r.left, y: r.bottom + 2 })
  }

  return (
    <div className={styles.menubar} role="toolbar" aria-label="Sandbox menus">
      <Button variant="ghost" size="sm" aria-haspopup="menu" aria-expanded={open?.menu === 'effect'} onClick={toggle('effect')}>
        Effect <ChevronDown size={12} aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="sm" aria-haspopup="menu" aria-expanded={open?.menu === 'view'} onClick={toggle('view')}>
        View <ChevronDown size={12} aria-hidden="true" />
      </Button>
      {open?.menu === 'effect' && (
        <EffectMenu x={open.x} y={open.y} onClose={close} onOpenAdvancedSeparation={onOpenAdvancedSeparation} />
      )}
      {open?.menu === 'view' && <ViewMenu x={open.x} y={open.y} onClose={close} />}
    </div>
  )
}
