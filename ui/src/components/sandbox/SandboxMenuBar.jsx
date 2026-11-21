import { useEffect, useRef, useState } from 'react'
import useSandboxStore from '../../stores/sandboxStore.js'
import useSeparationStore, { SEPARATION_TERMINAL_STATES } from '../../stores/separationStore.js'
import { EFFECT_CATEGORIES, EFFECT_REGISTRY } from '../../stores/sandboxEffectRegistry.js'
import {
  Button, IconButton, Menu, MenuCustom, MenuItem, MenuSeparator, Toolbar, ToolbarSeparator,
} from '../../ui-kit'
import { FALLBACK_TIERS, tierTitle } from './SandboxSeparationStrip.jsx'
import { effectEntry, sentenceCase, useSandboxEffects } from './useSandboxEffects.js'
import styles from './Sandbox.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcArrowUUpLeft = iconComponent('arrow-u-up-left')
const IcArrowUUpRight = iconComponent('arrow-u-up-right')
const IcCaretDown = iconComponent('caret-down')
const IcClipboard = iconComponent('clipboard')
const IcCopy = iconComponent('copy')
const IcPlus = iconComponent('plus')
const IcScissors = iconComponent('scissors')
const IcSliders = iconComponent('sliders')

// ── The action bar ──────────────────────────────────────────────────────────
//
// Everything you DO to the audio, in one row across the top: history, the
// clipboard, the edits that act on the selection, and the Effects menu for the
// rest. Modes (which tool owns the pointer, which view is showing) are the row
// below it, in SandboxToolBar; this row only ever holds commands.
//
// It used to be two words, "Effect" and "View", with every operation in the
// panel behind the first one — the far corner from the selection you had just
// dragged, and two clicks for a fade. The edits an audio editor is used for
// most are buttons now. They run the SAME registry entries the menu does
// (sandboxEffectRegistry.js through useSandboxEffects), so a button and its
// menu row can never behave differently.

// The edits promoted to buttons, in the order they are reached for. Grouped:
// what removes or blanks material, what shapes its level, what flips it.
const BAR_ACTIONS = [
  ['trim', 'silence'],
  ['fadeIn', 'fadeOut'],
  ['gain', 'normalize', 'reverse'],
]

// Everything that has a button on the bar. The Effects menu leaves these out:
// they are one row above it, always visible, and listing all ten again made
// the menu 27 rows long — taller than the panel it opens in.
const ON_THE_BAR = new Set(['cut', 'copy', 'paste', ...BAR_ACTIONS.flat()])

/** The registry's category as the menu names it. "Edit" holds only what the bar does not. */
const categoryLabel = (cat) => (cat === 'EDIT' ? 'More edits' : sentenceCase(cat))

/**
 * Every operation that is not already a button on the action bar, grouped the way the registry groups them,
 * plus stem separation.
 */
export function EffectMenu({ x, y, onClose, onOpenAdvancedSeparation }) {
  const { layer, layerReady, reasonFor, hintFor, run } = useSandboxEffects()
  const separateActiveLayer = useSeparationStore((s) => s.separateActiveLayer)
  const status = useSeparationStore((s) => s.status)
  const statusState = useSeparationStore((s) => s.statusState)
  const catalog = useSeparationStore((s) => s.catalog)
  const job = useSeparationStore((s) => s.job)

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

  return (
    <Menu x={x} y={y} onClose={onClose} label="Effects">
      {EFFECT_CATEGORIES.map((cat) => (
        <div key={cat} role="group" aria-label={categoryLabel(cat)}>
          <MenuCustom><div className={styles.menuCat}>{categoryLabel(cat)}</div></MenuCustom>
          {EFFECT_REGISTRY.filter((e) => e.category === cat && !ON_THE_BAR.has(e.id)).map((entry) => {
            const reason = reasonFor(entry)
            const inStack = entry.maxInstances < Infinity && !!layer && layer.ops.some(entry.matchesStack)
            return (
              <MenuItem
                key={entry.id}
                icon={<IcPlus size={14} />}
                disabled={!!reason || !entry.run}
                onSelect={() => run(entry)}
              >
                <span className={styles.itemLine} title={hintFor(entry)}>
                  <span>{sentenceCase(entry.label)}</span>
                  {inStack && <span className={styles.itemBadge}>In the stack</span>}
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
              <span title={tierTitle(tier, tier.model, durationSec, blocked)}>{sentenceCase(tier.label)}</span>
            </MenuItem>
          )
        })}
        <MenuItem
          icon={<IcSliders size={14} />}
          onSelect={() => onOpenAdvancedSeparation?.()}
        >
          <span title="Ensemble (average two models) and de-bleed (reduce cross-talk between stems)">
            Advanced (ensemble, de-bleed)…
          </span>
        </MenuItem>
      </div>
    </Menu>
  )
}

/**
 * A button that opens the Effects menu under itself. Shared by the action bar and the edit stack's header,
 * so "add something" is offered where the result lands as well as where the commands live.
 */
export function useEffectMenuButton(onOpenAdvancedSeparation) {
  const [at, setAt] = useState(null) // { x, y } | null
  const lastClosed = useRef(0)
  const close = () => { lastClosed.current = Date.now(); setAt(null) }
  const onClick = (e) => {
    // A press on the open menu's own button first closes it (outside press); do not reopen on that click.
    if (at === null && Date.now() - lastClosed.current < 250) return
    if (at) { close(); return }
    const r = e.currentTarget.getBoundingClientRect()
    setAt({ x: r.left, y: r.bottom + 2 })
  }
  const menu = at
    ? <EffectMenu x={at.x} y={at.y} onClose={close} onOpenAdvancedSeparation={onOpenAdvancedSeparation} />
    : null
  return { open: !!at, onClick, menu }
}

export default function SandboxMenuBar({ onOpenAdvancedSeparation }) {
  const { reasonFor, hintFor, run } = useSandboxEffects()
  const history = useSandboxStore((s) => s.history)
  const undo = useSandboxStore((s) => s.undo)
  const redo = useSandboxStore((s) => s.redo)
  const refreshHistory = useSandboxStore((s) => s.refreshHistory)
  const ensureSubscribed = useSeparationStore((s) => s.ensureSubscribed)
  const refreshStatus = useSeparationStore((s) => s.refreshStatus)
  const loadCatalog = useSeparationStore((s) => s.loadCatalog)
  const status = useSeparationStore((s) => s.status)
  const catalog = useSeparationStore((s) => s.catalog)
  const effects = useEffectMenuButton(onOpenAdvancedSeparation)

  // Bootstrap the separation sidecar probe from here rather than only from
  // SandboxSeparationStrip — the strip is mounted conditionally (only while a
  // job/prompt/advanced panel is actually visible), but the Separate section
  // needs real tier availability the moment the menu opens, before any job has
  // ever started.
  useEffect(() => { ensureSubscribed(); refreshStatus() }, [ensureSubscribed, refreshStatus])
  useEffect(() => { if (status?.running && !catalog) loadCatalog() }, [status?.running, catalog, loadCatalog])

  // The panel can be opened onto a session whose edits it never saw (a project
  // load, or edits made while it was closed), so seed the undo state on mount.
  useEffect(() => { refreshHistory() }, [refreshHistory])

  // The undo stack belongs to the engine and is shared with the Timeline.
  // `undoDomain` says whose edit is next in line, so this Undo can refuse (and
  // say why) rather than reach across and undo a timeline edit from here.
  const canUndo = history.canUndo && history.undoDomain === 'sandbox'
  const canRedo = history.canRedo && history.redoDomain === 'sandbox'
  const undoHint = !history.canUndo
    ? 'Nothing to undo'
    : canUndo ? `Undo ${history.undoDescription}` : `The next undo is a ${history.undoDomain} edit (${history.undoDescription})`
  const redoHint = !history.canRedo
    ? 'Nothing to redo'
    : canRedo ? `Redo ${history.redoDescription}` : `The next redo is a ${history.redoDomain} edit (${history.redoDescription})`

  const iconAction = (id, label, glyph) => {
    const entry = effectEntry(id)
    return (
      <IconButton
        label={label}
        disabled={!!reasonFor(entry)}
        onClick={() => run(entry)}
        hint={label}
        hintMods={hintFor(entry)}
      >
        {glyph}
      </IconButton>
    )
  }

  return (
    <Toolbar label="Edit actions" className={styles.actionbar}>
      <IconButton label="Undo" disabled={!canUndo} onClick={() => undo()} hint="Undo" hintMods={undoHint}>
        <IcArrowUUpLeft />
      </IconButton>
      <IconButton label="Redo" disabled={!canRedo} onClick={() => redo()} hint="Redo" hintMods={redoHint}>
        <IcArrowUUpRight />
      </IconButton>
      <ToolbarSeparator />
      {iconAction('cut', 'Cut', <IcScissors />)}
      {iconAction('copy', 'Copy', <IcCopy />)}
      {iconAction('paste', 'Paste', <IcClipboard />)}
      {BAR_ACTIONS.map((group) => (
        <span key={group[0]} className={styles.actionGroup}>
          <ToolbarSeparator />
          {group.map((id) => {
            const entry = effectEntry(id)
            const label = sentenceCase(entry.label)
            return (
              <Button
                key={id}
                variant="ghost"
                data-action={id}
                disabled={!!reasonFor(entry)}
                onClick={() => run(entry)}
                hint={label}
                hintMods={hintFor(entry)}
              >
                {label}
              </Button>
            )
          })}
        </span>
      ))}
      <ToolbarSeparator />
      <Button
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={effects.open}
        onClick={effects.onClick}
        hint="Effects"
        hintMods="Dynamics, restoration, pitch and stem separation, plus the edits that have no button here"
      >
        Effects <IcCaretDown size={14} aria-hidden="true" />
      </Button>
      {effects.menu}
    </Toolbar>
  )
}
