import { useEffect, useRef, useState } from 'react'
import useSandboxStore, { hasMeaningfulSelection } from '../../stores/sandboxStore.js'
import useSeparationStore, { SEPARATION_TERMINAL_STATES } from '../../stores/separationStore.js'
import { EFFECT_CATEGORIES, EFFECT_REGISTRY } from '../../stores/sandboxEffectRegistry.js'
import {
  FALLBACK_TIERS, tierTitle, estimateSeconds, formatDuration,
} from './SandboxSeparationStrip.jsx'

// Audacity-style EFFECT ▾ / VIEW ▾ menu tabs — the single entry point for
// adding an operation (replacing the old "+ ADD OP" select and the selection
// action bars) plus the WAV/SPC view toggle (replacing SandboxToolstrip's own
// toggle buttons). EFFECT renders purely off sandboxEffectRegistry.js and the
// active layer's current op stack; nothing here hardcodes which ops exist.
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

function EffectItem({ entry, layer, hasSelection, hasClipboard, cursorSample, onClose }) {
  const hasLayer = !!layer
  const reason = reasonForEntry(entry, { hasLayer, hasSelection, hasClipboard, layer })
  const disabled = !!reason
  const inStack = entry.maxInstances < Infinity && hasLayer && layer.ops.some(entry.matchesStack)
  const badge = entry.maxInstances === Infinity ? '×N' : inStack ? 'IN STACK' : '1×'

  const handleClick = () => {
    if (disabled || !entry.run) return
    const store = useSandboxStore.getState()
    entry.run(store, {
      layerId: layer.id, selection: store.selection, cursorSample, hasSelection,
    })
    onClose()
  }

  return (
    <button
      type="button"
      className={`sandbox-menu-item${disabled ? ' disabled' : ''}`}
      onClick={handleClick}
      disabled={disabled}
      title={reason || ''}
    >
      <span className="sandbox-menu-item-plus">+</span>
      <span className="sandbox-menu-item-label">{entry.label}</span>
      <span className="sandbox-menu-item-badge">{badge}</span>
    </button>
  )
}

function SeparateItem({ tier, model, durationSec, blocked, onPick }) {
  const disabled = !tier.enabled || !!blocked
  return (
    <button
      type="button"
      className={`sandbox-menu-item sandbox-separation-tier${disabled ? ' disabled' : ''}`}
      onClick={() => onPick(tier)}
      disabled={disabled}
      title={tierTitle(tier, model, durationSec, blocked)}
    >
      {tier.label}
    </button>
  )
}

function EffectDropdown({ open, onClose, onOpenAdvancedSeparation }) {
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
      // Matches SandboxSeparationStrip's wording deliberately: XLETH bundles
      // its own Python runtime, so a missing package means a damaged install,
      // not something the user is expected to go and pip-install.
      return `${tier.label} needs ${missing} — XLETH's bundled runtime looks incomplete, reinstalling should fix it`
    }
    if (model && model.license && model.license.cleared === false) {
      return `${tier.label}'s model (${model.license.spdx || 'licence'}) has not cleared its audit`
    }
    return null
  }

  const onPickTier = (tier) => { separateActiveLayer(tier.id); onClose() }

  if (!open) return null
  return (
    <div className="sandbox-menu-dropdown open" onClick={(e) => e.stopPropagation()}>
      {EFFECT_CATEGORIES.map((cat) => (
        <div key={cat}>
          <div className="sandbox-menu-cat">{cat}</div>
          {EFFECT_REGISTRY.filter((e) => e.category === cat).map((entry) => (
            <EffectItem
              key={entry.id}
              entry={entry}
              layer={layer}
              hasSelection={hasSelection}
              hasClipboard={!!clipboard}
              cursorSample={cursorSample}
              onClose={onClose}
            />
          ))}
        </div>
      ))}
      <div>
        <div className="sandbox-menu-cat">SEPARATE</div>
        {tiers.map((tier) => (
          <SeparateItem
            key={tier.id}
            tier={tier}
            model={tier.model}
            durationSec={durationSec}
            blocked={reasonForTier(tier)}
            onPick={onPickTier}
          />
        ))}
        <button
          type="button"
          className="sandbox-menu-item sandbox-menu-item--advanced-separation"
          onClick={() => { onOpenAdvancedSeparation(); onClose() }}
          title="ENSEMBLE (average two models) and DE-BLEED (reduce cross-talk between stems)"
        >
          <span className="sandbox-menu-item-plus">⚙</span>
          <span className="sandbox-menu-item-label">Advanced (Ensemble / De-Bleed)…</span>
        </button>
      </div>
    </div>
  )
}

function ViewDropdown({ open, onClose }) {
  const viewMode = useSandboxStore((s) => s.viewMode)
  const setViewMode = useSandboxStore((s) => s.setViewMode)

  if (!open) return null
  return (
    <div className="sandbox-menu-dropdown open" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="sandbox-menu-item"
        onClick={() => { setViewMode('wav'); onClose() }}
      >
        <span className="sandbox-menu-item-check">{viewMode === 'wav' ? '✓' : ''}</span>
        <span className="sandbox-menu-item-label">WAVEFORM</span>
      </button>
      <button
        type="button"
        className="sandbox-menu-item"
        onClick={() => { setViewMode('spc'); onClose() }}
      >
        <span className="sandbox-menu-item-check">{viewMode === 'spc' ? '✓' : ''}</span>
        <span className="sandbox-menu-item-label">SPECTRAL</span>
      </button>
    </div>
  )
}

export default function SandboxMenuBar({ onOpenAdvancedSeparation }) {
  const [openMenu, setOpenMenu] = useState(null) // 'effect' | 'view' | null
  const barRef = useRef(null)

  const ensureSubscribed = useSeparationStore((s) => s.ensureSubscribed)
  const refreshStatus = useSeparationStore((s) => s.refreshStatus)
  const loadCatalog = useSeparationStore((s) => s.loadCatalog)
  const status = useSeparationStore((s) => s.status)
  const catalog = useSeparationStore((s) => s.catalog)

  // Bootstrap the separation sidecar probe from here rather than only from
  // SandboxSeparationStrip — the strip is now mounted conditionally (only
  // while a job/prompt/advanced panel is actually visible), but the SEPARATE
  // submenu needs real tier availability the moment the menu opens, before
  // any job has ever started.
  useEffect(() => { ensureSubscribed(); refreshStatus() }, [ensureSubscribed, refreshStatus])
  useEffect(() => { if (status?.running && !catalog) loadCatalog() }, [status?.running, catalog, loadCatalog])

  useEffect(() => {
    const onDocClick = () => setOpenMenu(null)
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [])

  const toggle = (menu) => (e) => {
    e.stopPropagation()
    setOpenMenu((cur) => (cur === menu ? null : menu))
  }

  return (
    <div className="sandbox-menubar" ref={barRef}>
      <div className="sandbox-menu">
        <button
          className={`sandbox-menu-btn${openMenu === 'effect' ? ' open' : ''}`}
          onClick={toggle('effect')}
        >
          EFFECT ▾
        </button>
        <EffectDropdown
          open={openMenu === 'effect'}
          onClose={() => setOpenMenu(null)}
          onOpenAdvancedSeparation={onOpenAdvancedSeparation}
        />
      </div>
      <div className="sandbox-menu">
        <button
          className={`sandbox-menu-btn${openMenu === 'view' ? ' open' : ''}`}
          onClick={toggle('view')}
        >
          VIEW ▾
        </button>
        <ViewDropdown open={openMenu === 'view'} onClose={() => setOpenMenu(null)} />
      </div>
    </div>
  )
}
