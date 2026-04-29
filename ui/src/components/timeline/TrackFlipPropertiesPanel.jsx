import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Plus,
  GripVertical,
  ArrowLeftRight,
  ArrowUpDown,
  RotateCw,
  RotateCcw,
  RefreshCw,
  Square,
} from 'lucide-react'
import {
  ORIENTATIONS,
  ORIENTATION_LABELS,
  MODIFIER_TYPES,
  MODIFIER_TYPE_LABELS,
  MAX_FLIP_STATES,
  defaultVideoFlipConfig,
  resolveStateIndex,
} from '../../types/videoFlipTypes.js'

/**
 * TrackFlipPropertiesPanel — inline popover replacing the legacy 4-option submenu.
 *
 * Spec: xleth-flip-v2-architecture-spec.md §6 (UI architecture).
 *
 * Anchored to the right of the track header; renders into a body-level portal so
 * it can overflow the timeline pane. All chrome reads `--theme-*` tokens —
 * no hardcoded colours (acceptance #9). The component is intentionally
 * self-contained so it can be lifted into the Track Properties tab once the
 * windowing spec ships, without rework.
 *
 * Props:
 *   track       – the track object (must include id, name, videoFlipConfig)
 *   anchorRect  – { right, top, ... } from getBoundingClientRect()
 *   onClose     – fires on outside click / Escape / explicit close
 *   onCommit    – (config) => void; called once per atomic edit (mouseup, blur)
 */
export default function TrackFlipPropertiesPanel({ track, anchorRect, onClose, onCommit }) {
  const panelRef = useRef(null)

  // ── Local working copy of the config ────────────────────────────────────
  // Editing happens locally for instant feedback; we IPC-commit once per
  // discrete edit. Drag operations never round-trip per pointer-move.
  const [config, setConfig] = useState(() =>
    track?.videoFlipConfig
      ? cloneConfig(track.videoFlipConfig)
      : defaultVideoFlipConfig()
  )

  // ── Re-sync when the underlying track config changes externally ─────────
  // (e.g., undo/redo, or another panel commits). Only re-sync when we're not
  // mid-edit so a remote refresh doesn't clobber the user's in-flight changes.
  const editingRef = useRef(false)
  useEffect(() => {
    if (editingRef.current) return
    if (!track?.videoFlipConfig) return
    setConfig(cloneConfig(track.videoFlipConfig))
  }, [track?.videoFlipConfig])

  // ── Position the popover ────────────────────────────────────────────────
  // Anchored to the right edge of the track header, top-aligned. Clamped to
  // viewport once the actual content size is known.
  const [pos, setPos] = useState(() => initialPos(anchorRect))
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    setPos((p) => {
      let { left, top } = p
      if (left + r.width  > vw - 8) left = Math.max(8, vw - r.width  - 8)
      if (top  + r.height > vh - 8) top  = Math.max(8, vh - r.height - 8)
      return (left === p.left && top === p.top) ? p : { left, top }
    })
  }, [anchorRect, config.states.length])

  // ── Outside click / Escape — but ignore clicks inside our own portals
  // (orientation picker submenu) which live outside panelRef.
  const [pickerForCard, setPickerForCard] = useState(null) // state index whose picker is open
  useEffect(() => {
    const onMouseDown = (e) => {
      if (panelRef.current && panelRef.current.contains(e.target)) return
      // Picker is rendered into its own portal — let it handle its own dismissal
      if (e.target.closest?.('[data-flip-picker]')) return
      onClose()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (pickerForCard != null) setPickerForCard(null)
        else onClose()
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose, pickerForCard])

  // ── Atomic-commit helper ────────────────────────────────────────────────
  // Every discrete user action (toggle, reorder, modifier change, …) calls
  // `commit(next)`. The IPC fires once per call — drag handlers buffer their
  // intermediate moves into local state and commit on mouseup only.
  const commit = useCallback((next) => {
    setConfig(next)
    onCommit?.(next)
  }, [onCommit])

  // ── Top-level handlers ──────────────────────────────────────────────────
  const setEnabled = (enabled) => commit({ ...config, enabled })

  const setStartStateIndex = (idx) => {
    const clamped = Math.max(0, Math.min(config.states.length - 1, idx | 0))
    if (clamped === config.startStateIndex) return
    commit({ ...config, startStateIndex: clamped })
  }

  const setOrientationAt = (cardIdx, orient) => {
    const states = config.states.map((s, i) => i === cardIdx ? { ...s, orientation: orient } : s)
    commit({ ...config, states })
  }

  const addState = () => {
    if (config.states.length >= MAX_FLIP_STATES) return
    const id = nextStateId(config.states)
    const states = [...config.states, { id, orientation: 'none', label: '' }]
    commit({ ...config, states })
  }

  const removeState = (cardIdx) => {
    if (config.states.length <= 1) return  // ≥1 state required (spec §6.2)
    const states = config.states.filter((_, i) => i !== cardIdx)
    // startStateIndex auto-clamps if it was on the removed card or past the new end.
    let startStateIndex = config.startStateIndex
    if (startStateIndex >= cardIdx)            startStateIndex = Math.max(0, startStateIndex - 1)
    if (startStateIndex >= states.length)      startStateIndex = states.length - 1
    commit({ ...config, states, startStateIndex })
  }

  // ── Drag-reorder ────────────────────────────────────────────────────────
  // EffectChainPanel pattern: pointer-event driven, local preview state,
  // global mouseup commits the result via single IPC. startStateIndex is
  // auto-renumbered to follow the same card the user had marked as start.
  const dragRef = useRef(null) // { id, fromIdx, currentIdx }
  const [dragOrder, setDragOrder] = useState(null) // ephemeral preview
  const displayStates = dragOrder ?? config.states

  useEffect(() => {
    const onUp = () => {
      if (!dragRef.current) return
      const { id, fromIdx, currentIdx } = dragRef.current
      dragRef.current = null
      document.body.style.cursor = ''
      setDragOrder(null)
      editingRef.current = false
      if (currentIdx === fromIdx) return
      // Auto-renumber startStateIndex so it points at the same card the user
      // had marked as start (spec §6.2: "Reordering automatically renumbers
      // startStateIndex to point at the same card.").
      const startId = config.states[config.startStateIndex]?.id
      const reordered = reorderStates(config.states, fromIdx, currentIdx)
      const newStartIdx = Math.max(0, reordered.findIndex(s => s.id === startId))
      commit({ ...config, states: reordered, startStateIndex: newStartIdx })
      // (id is unused after the reorder — only needed during drag preview.)
      void id
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [config, commit])

  const handleDragStart = (id, idx, e) => {
    if (config.states.length < 2) return
    if (!config.enabled) return
    e.preventDefault()
    dragRef.current = { id, fromIdx: idx, currentIdx: idx }
    setDragOrder([...config.states])
    document.body.style.cursor = 'grabbing'
    editingRef.current = true
  }

  const handleDragOver = (toIdx) => {
    if (!dragRef.current) return
    if (toIdx === dragRef.current.currentIdx) return
    dragRef.current.currentIdx = toIdx
    setDragOrder(prev => {
      if (!prev) return prev
      const srcIdx = prev.findIndex(s => s.id === dragRef.current.id)
      if (srcIdx === -1) return prev
      return reorderStates(prev, srcIdx, toIdx)
    })
  }

  // ── Modifier handlers ───────────────────────────────────────────────────
  const setModifierType = (type) => {
    // Reset config-shaped fields when switching type so we don't leak stale
    // pitches into a beat modifier or vice-versa.
    let mc = {}
    if (type === 'specific-pitches') mc = { pitches: config.modifier?.config?.pitches ?? [] }
    if (type === 'every-n-beats')    mc = {
      n: clampInt(config.modifier?.config?.n ?? 1, 1, 32),
      subdivision: config.modifier?.config?.subdivision === 'bar' ? 'bar' : 'beat',
    }
    commit({ ...config, modifier: { type, config: mc } })
  }
  const setN = (n) => commit({
    ...config,
    modifier: { ...config.modifier, config: { ...config.modifier.config, n: clampInt(n, 1, 32) } },
  })
  const setSubdivision = (sub) => commit({
    ...config,
    modifier: { ...config.modifier, config: { ...config.modifier.config, subdivision: sub } },
  })
  const setPitches = (pitches) => commit({
    ...config,
    modifier: { ...config.modifier, config: { ...config.modifier.config, pitches } },
  })

  // ── Live preview events (8 ordinals via the JS resolver) ────────────────
  // Without an upcoming-events IPC (deferred to Phase 6), use a synthetic
  // sequence that exercises the configured modifier so users can read the
  // resolved cycle. For specific-pitches / new-note we mix in the user's
  // whitelist (or a default rising line) so the preview reflects their intent.
  const previewItems = useMemo(() => {
    const previewPitches = buildPreviewPitches(config)
    const monoEvents = previewPitches.map((p, i) => ({ tick: i * 960, pitch: p }))
    const states = resolveStateIndex(config, monoEvents, 960)
    return previewPitches.map((pitch, i) => ({
      pitch,
      pitchLabel: midiNoteLabel(pitch),
      stateIndex: states[i],
      orientation: config.states[states[i]]?.orientation ?? 'none',
    }))
  }, [config])

  // ── Render ──────────────────────────────────────────────────────────────
  const disabled = !config.enabled

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`Video Flip — ${track?.name ?? 'track'}`}
      style={{
        position: 'fixed',
        left: pos.left,
        top:  pos.top,
        zIndex: 10000,
        minWidth: 360,
        maxWidth: 480,
        background: 'var(--theme-contextmenu-bg)',
        color: 'var(--theme-text)',
        border: '1px solid var(--theme-contextmenu-border)',
        borderRadius: 6,
        boxShadow: 'var(--theme-chrome-shadow)',
        padding: '12px 14px',
        fontSize: 12,
        userSelect: 'none',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    marginBottom: 10, gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={14} style={{ color: 'var(--theme-accent)' }} />
          <strong>Video Flip</strong>
          <span style={{ color: 'var(--theme-text-muted)', fontWeight: 'normal' }}>
            — {track?.name ?? `Track ${track?.id ?? '?'}`}
          </span>
        </div>
        <button
          aria-label="Close"
          onClick={onClose}
          style={panelButtonStyle()}
        >×</button>
      </div>

      {/* ── 1. Master toggle ────────────────────────────────────────────── */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
                      cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Enabled</span>
        <span style={{ color: 'var(--theme-text-subtle)', fontSize: 11 }}>
          (off = identity render, no resolver work)
        </span>
      </label>

      {/* The remainder is greyed out when disabled but stays in the DOM
          so screen readers / keyboard users can still inspect the values. */}
      <div style={{ opacity: disabled ? 0.45 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>

        {/* ── 2. Flipping Style row ─────────────────────────────────────── */}
        <SectionLabel>Flipping Style</SectionLabel>
        <div
          role="listbox"
          aria-label="Flip states"
          style={{ display: 'flex', alignItems: 'center', gap: 6,
                   overflowX: 'auto', paddingBottom: 4, marginBottom: 10 }}
          onKeyDown={(e) => onCardsKeyDown(e, displayStates, removeState, setPickerForCard)}
        >
          {displayStates.map((st, idx) => (
            <StateCard
              key={st.id}
              state={st}
              index={idx}
              isStart={idx === config.startStateIndex}
              canDelete={displayStates.length > 1}
              onPick={() => setPickerForCard(idx)}
              onDelete={() => removeState(idx)}
              onDragStart={(e) => handleDragStart(st.id, idx, e)}
              onDragOver={() => handleDragOver(idx)}
            />
          ))}
          <button
            aria-label="Add state"
            disabled={displayStates.length >= MAX_FLIP_STATES}
            onClick={addState}
            style={{
              ...panelButtonStyle(),
              padding: '4px 8px',
              opacity: displayStates.length >= MAX_FLIP_STATES ? 0.4 : 1,
              cursor: displayStates.length >= MAX_FLIP_STATES ? 'not-allowed' : 'pointer',
            }}
            title={displayStates.length >= MAX_FLIP_STATES
              ? `Maximum ${MAX_FLIP_STATES} states`
              : 'Add state'}
          >
            <Plus size={13} />
          </button>
        </div>

        {/* ── 3. Modifier ───────────────────────────────────────────────── */}
        <SectionLabel>Modifier</SectionLabel>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <select
            value={config.modifier?.type ?? 'every-note'}
            onChange={(e) => setModifierType(e.target.value)}
            style={panelSelectStyle()}
          >
            {MODIFIER_TYPES.map((t) => (
              <option key={t} value={t}>{MODIFIER_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>

        {config.modifier?.type === 'specific-pitches' && (
          <PitchListEditor
            pitches={config.modifier.config?.pitches ?? []}
            onChange={setPitches}
          />
        )}

        {config.modifier?.type === 'every-n-beats' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <NumberStepper
              label="N"
              value={clampInt(config.modifier.config?.n ?? 1, 1, 32)}
              min={1}
              max={32}
              onChange={setN}
              ariaLabel="Beats per advance"
            />
            <select
              value={config.modifier.config?.subdivision ?? 'beat'}
              onChange={(e) => setSubdivision(e.target.value)}
              style={panelSelectStyle()}
              aria-label="Subdivision"
            >
              <option value="beat">beat</option>
              <option value="bar">bar</option>
            </select>
          </div>
        )}

        {/* ── 4. Start state ────────────────────────────────────────────── */}
        <SectionLabel>Start State</SectionLabel>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <NumberStepper
            label="#"
            // 1-indexed in the UI, 0-indexed in the config (spec §6.2 row 4).
            value={config.startStateIndex + 1}
            min={1}
            max={config.states.length}
            onChange={(v) => setStartStateIndex((v | 0) - 1)}
            ariaLabel="Start state index (1-based)"
          />
          <span style={{ color: 'var(--theme-text-subtle)' }}>
            of {config.states.length}
          </span>
        </div>

        {/* ── 5. Live preview hint ─────────────────────────────────────── */}
        <SectionLabel>Live Preview (next 8 ordinals)</SectionLabel>
        <div
          aria-label="Live preview of resolved flip states"
          style={{
            display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px',
            background: 'var(--theme-bg-elevated)',
            border: '1px solid var(--theme-border-subtle)',
            borderRadius: 4,
            overflowX: 'auto',
            fontSize: 11,
            color: 'var(--theme-text-muted)',
          }}
        >
          {previewItems.map((it, i) => (
            <PreviewChip key={i} item={it} />
          ))}
        </div>
      </div>

      {/* ── Orientation picker submenu (portal) ────────────────────────── */}
      {pickerForCard != null && (
        <OrientationPicker
          anchor={panelRef.current}
          current={config.states[pickerForCard]?.orientation ?? 'none'}
          onPick={(o) => { setOrientationAt(pickerForCard, o); setPickerForCard(null) }}
          onClose={() => setPickerForCard(null)}
        />
      )}
    </div>,
    document.body
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 10,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      color: 'var(--theme-text-subtle)',
      marginBottom: 4,
    }}>{children}</div>
  )
}

function StateCard({ state, index, isStart, canDelete, onPick, onDelete, onDragStart, onDragOver }) {
  return (
    <div
      role="option"
      tabIndex={0}
      data-state-card
      data-index={index}
      onMouseEnter={onDragOver}
      onContextMenu={(e) => { e.preventDefault(); if (canDelete) onDelete() }}
      style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '4px 6px',
        minWidth: 56,
        background: isStart ? 'var(--theme-accent-bg-subtle)' : 'var(--theme-bg-elevated)',
        border: `1px solid ${isStart ? 'var(--theme-accent)' : 'var(--theme-border-subtle)'}`,
        borderRadius: 4,
        cursor: 'pointer',
      }}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === 'Enter')  { e.preventDefault(); onPick() }
        if (e.key === 'Delete' && canDelete) { e.preventDefault(); onDelete() }
      }}
    >
      <span
        onMouseDown={onDragStart}
        title="Drag to reorder"
        style={{ cursor: 'grab', display: 'inline-flex', color: 'var(--theme-text-subtle)' }}
      ><GripVertical size={11} /></span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <OrientationGlyph orientation={state.orientation} size={14} />
        <span style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>{index + 1}</span>
      </span>
    </div>
  )
}

function OrientationGlyph({ orientation, size = 14 }) {
  const color = 'var(--theme-text)'
  switch (orientation) {
    case 'horizontal':    return <ArrowLeftRight size={size} style={{ color }} />
    case 'vertical':      return <ArrowUpDown    size={size} style={{ color }} />
    case 'rotate-180':    return <RefreshCw      size={size} style={{ color }} />
    case 'rotate-90-cw':  return <RotateCw       size={size} style={{ color }} />
    case 'rotate-90-ccw': return <RotateCcw      size={size} style={{ color }} />
    case 'none':
    default:              return <Square         size={size} style={{ color }} />
  }
}

function OrientationPicker({ anchor, current, onPick, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(() => {
    const r = anchor?.getBoundingClientRect?.()
    if (!r) return { left: 100, top: 100 }
    return { left: r.left + 8, top: r.bottom + 4 }
  })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.right > window.innerWidth - 8)
      setPos((p) => ({ ...p, left: window.innerWidth - r.width - 8 }))
    if (r.bottom > window.innerHeight - 8)
      setPos((p) => ({ ...p, top: window.innerHeight - r.height - 8 }))
  }, [])

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      data-flip-picker
      role="menu"
      style={{
        position: 'fixed',
        left: pos.left,
        top:  pos.top,
        zIndex: 10001,
        background: 'var(--theme-contextmenu-bg)',
        border: '1px solid var(--theme-contextmenu-border)',
        borderRadius: 4,
        boxShadow: 'var(--theme-chrome-shadow)',
        padding: 4,
        minWidth: 180,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {ORIENTATIONS.map((o) => (
        <button
          key={o}
          role="menuitem"
          onClick={() => onPick(o)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            width: '100%',
            padding: '6px 8px',
            background: current === o ? 'var(--theme-accent-bg-subtle)' : 'transparent',
            color: 'var(--theme-text)',
            border: 'none',
            borderRadius: 3,
            cursor: 'pointer',
            textAlign: 'left',
            fontSize: 12,
          }}
          onMouseEnter={(e) => {
            if (current !== o) e.currentTarget.style.background = 'var(--theme-contextmenu-item-hover-bg)'
          }}
          onMouseLeave={(e) => {
            if (current !== o) e.currentTarget.style.background = 'transparent'
          }}
        >
          <OrientationGlyph orientation={o} size={14} />
          <span>{ORIENTATION_LABELS[o]}</span>
        </button>
      ))}
    </div>,
    document.body
  )
}

function NumberStepper({ label, value, min, max, onChange, ariaLabel }) {
  const dec = () => onChange(Math.max(min, value - 1))
  const inc = () => onChange(Math.min(max, value + 1))
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {label && <span style={{ color: 'var(--theme-text-subtle)' }}>{label}</span>}
      <button onClick={dec} disabled={value <= min} style={panelButtonStyle()}>−</button>
      <input
        type="number"
        aria-label={ariaLabel}
        min={min} max={max} value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10)
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)))
        }}
        style={{
          width: 44, textAlign: 'center',
          background: 'var(--theme-bg-elevated)',
          color: 'var(--theme-text)',
          border: '1px solid var(--theme-border-subtle)',
          borderRadius: 3,
          padding: '2px 4px',
          fontSize: 12,
        }}
      />
      <button onClick={inc} disabled={value >= max} style={panelButtonStyle()}>+</button>
    </div>
  )
}

function PitchListEditor({ pitches, onChange }) {
  const [draft, setDraft] = useState('')
  const addPitch = () => {
    const parsed = parsePitchInput(draft)
    if (parsed != null && !pitches.includes(parsed)) {
      onChange([...pitches, parsed].sort((a, b) => a - b))
    }
    setDraft('')
  }
  const removePitch = (p) => onChange(pitches.filter(x => x !== p))
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
        {pitches.length === 0 && (
          <span style={{ color: 'var(--theme-text-subtle)', fontSize: 11 }}>
            No pitches in whitelist — modifier won't advance.
          </span>
        )}
        {pitches.map((p) => (
          <span key={p} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 6px',
            background: 'var(--theme-accent-bg-subtle)',
            color: 'var(--theme-text)',
            border: '1px solid var(--theme-accent)',
            borderRadius: 10,
            fontSize: 11,
          }}>
            {midiNoteLabel(p)} ({p})
            <button
              onClick={() => removePitch(p)}
              aria-label={`Remove ${midiNoteLabel(p)}`}
              style={{ ...panelButtonStyle(), padding: 0, width: 14, height: 14, lineHeight: '12px' }}
            >×</button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPitch() } }}
          placeholder="C4, D#5, 60 ..."
          aria-label="Add pitch"
          style={{
            flex: 1,
            background: 'var(--theme-bg-elevated)',
            color: 'var(--theme-text)',
            border: '1px solid var(--theme-border-subtle)',
            borderRadius: 3,
            padding: '2px 6px',
            fontSize: 12,
          }}
        />
        <button onClick={addPitch} style={panelButtonStyle()}><Plus size={12} /></button>
      </div>
    </div>
  )
}

function PreviewChip({ item }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      padding: '2px 6px',
      background: 'var(--theme-bg-secondary)',
      border: '1px solid var(--theme-border-subtle)',
      borderRadius: 10,
      whiteSpace: 'nowrap',
    }}>
      <span style={{ color: 'var(--theme-text)', fontSize: 11 }}>{item.pitchLabel}</span>
      <span style={{ color: 'var(--theme-text-subtle)' }}>→</span>
      <OrientationGlyph orientation={item.orientation} size={11} />
      <span style={{ color: 'var(--theme-text-muted)', fontSize: 10 }}>
        {item.stateIndex + 1}
      </span>
    </span>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function panelButtonStyle() {
  return {
    background: 'var(--theme-bg-elevated)',
    color: 'var(--theme-text)',
    border: '1px solid var(--theme-border-subtle)',
    borderRadius: 3,
    padding: '2px 6px',
    cursor: 'pointer',
    fontSize: 12,
    lineHeight: 1,
  }
}

function panelSelectStyle() {
  return {
    background: 'var(--theme-bg-elevated)',
    color: 'var(--theme-text)',
    border: '1px solid var(--theme-border-subtle)',
    borderRadius: 3,
    padding: '2px 6px',
    fontSize: 12,
  }
}

function initialPos(anchorRect) {
  if (!anchorRect) return { left: 100, top: 100 }
  // Anchor to the right edge of the track header, top-aligned.
  return { left: (anchorRect.right ?? 0) + 6, top: anchorRect.top ?? 0 }
}

function cloneConfig(c) {
  return {
    enabled: !!c.enabled,
    states: (c.states || []).map((s, i) => ({
      id:          s.id || `s${i}`,
      orientation: s.orientation || 'none',
      label:       s.label || '',
    })),
    modifier: c.modifier
      ? { type: c.modifier.type || 'every-note', config: { ...(c.modifier.config || {}) } }
      : { type: 'every-note', config: {} },
    startStateIndex: Math.max(0, c.startStateIndex | 0),
  }
}

function nextStateId(states) {
  // Pick the lowest "sN" not already in use so reused IDs don't collide
  // when a card is deleted then re-added.
  const used = new Set(states.map(s => s.id))
  for (let i = 0; i < 1000; ++i) {
    const id = `s${i}`
    if (!used.has(id)) return id
  }
  return `s${Date.now()}`
}

function reorderStates(states, fromIdx, toIdx) {
  const out = [...states]
  const [item] = out.splice(fromIdx, 1)
  out.splice(toIdx, 0, item)
  return out
}

function clampInt(v, min, max) {
  const n = (v | 0)
  return Math.max(min, Math.min(max, n))
}

// MIDI 60 = C4 (Yamaha convention used by Xleth).
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
function midiNoteLabel(midi) {
  const safe = ((midi % 12) + 12) % 12
  const oct  = Math.floor(midi / 12) - 1   // MIDI 60 → C4
  return `${NOTE_NAMES[safe]}${oct}`
}

function parsePitchInput(s) {
  if (!s) return null
  const trimmed = s.trim()
  if (!trimmed) return null
  // Plain integer
  if (/^-?\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10)
    if (n >= 0 && n <= 127) return n
    return null
  }
  // Note name like C4, D#5, Eb3 (flat → preceding sharp on the lower note)
  const m = trimmed.match(/^([A-Ga-g])([#b]?)(-?\d+)$/)
  if (!m) return null
  const [, letter, accidental, octStr] = m
  let semitone = NOTE_NAMES.indexOf(letter.toUpperCase())
  if (semitone < 0) return null
  if (accidental === '#') semitone += 1
  if (accidental === 'b') semitone -= 1
  const oct = parseInt(octStr, 10)
  const midi = (oct + 1) * 12 + semitone
  if (midi < 0 || midi > 127) return null
  return midi
}

function buildPreviewPitches(config) {
  // For modifiers that key off pitch identity, produce a sequence that
  // exercises the rule. For every-note / every-n-beats, pitch is irrelevant
  // so we just feed a default rising-line.
  const t = config.modifier?.type
  if (t === 'specific-pitches') {
    const wl = config.modifier?.config?.pitches ?? []
    if (wl.length === 0) {
      // No whitelist → resolver never advances. Show C4 ×8 to make this visible.
      return new Array(8).fill(60)
    }
    // Alternate whitelisted + non-whitelisted so the user sees the gating in action.
    const out = []
    for (let i = 0; i < 8; ++i) out.push(i % 2 === 0 ? wl[(i / 2) % wl.length] : 62)
    return out
  }
  if (t === 'new-note') {
    // Mix repeats + changes so the user sees no-advance + advance side-by-side.
    return [60, 60, 62, 62, 64, 60, 64, 67]
  }
  // every-note / every-n-beats: rising line — visually clearer than all-same.
  return [60, 62, 64, 65, 67, 69, 71, 72]
}

function onCardsKeyDown(e, displayStates, removeState, openPicker) {
  // Tab is handled natively (cards have tabIndex=0). We layer Delete + Enter.
  const target = e.target
  if (!target?.dataset || target.dataset.stateCard == null) return
  const idx = parseInt(target.dataset.index, 10)
  if (Number.isNaN(idx)) return
  if (e.key === 'Delete' && displayStates.length > 1) {
    e.preventDefault()
    removeState(idx)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    openPicker(idx)
  }
}
