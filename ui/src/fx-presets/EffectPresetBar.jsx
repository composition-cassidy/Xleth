import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Save, Trash2, Undo2, Check, X } from 'lucide-react'
import {
  listPresets, savePreset, loadPreset, deletePreset, revertState,
} from './presetManager.js'
import { slugifyPresetName } from './slugify.js'

// Framework-level preset bar for stock effect windows.
//
// Drop this into any stock effect panel (bespoke ones like ApexPanel, or the
// shared StockPluginRuntimeRenderer chrome that hosts every plugin-ui-layout
// effect) and that effect inherits named preset save / load / delete for free.
// It is fully generic: it only needs the effect's `effectType` id and the open
// `target` ({ trackId, nodeId, storeKey }). All effect-specific state capture /
// apply lives behind the preset adapter registry (effectPresetAdapters.js).
//
// Discrete-action discipline: every operation (select-to-load, save, delete,
// undo) is a single click / submit — there is no drag, so no IPC ever fires
// mid-gesture. Theming: CSS custom-property tokens only, no hardcoded hex,
// tokenValue() is never called here; flat, zero-border-radius; Lucide icons
// only. Reserved script identifiers (name, event, status, …) are never declared.
//
// Props:
//   effectType  – stock effect id ("apex", "compressor", …)
//   target      – { trackId, nodeId, storeKey } | null
//   onApplied   – (stateBlob) => void, called after a load or undo so the host
//                 can sync its own UI from the applied state without re-reading.
//   className   – optional extra class for placement.

export default function EffectPresetBar({ effectType, target, onApplied, className }) {
  const [groups, setGroups] = useState({ factory: [], user: [] })
  const [selected, setSelected] = useState(null)   // { source, slug } | null
  const [busy, setBusy] = useState(false)
  const [errorText, setErrorText] = useState(null)

  const [saving, setSaving] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [overwriteArmed, setOverwriteArmed] = useState(false)
  const nameInputRef = useRef(null)

  const [undoBlob, setUndoBlob] = useState(null)   // pre-load state for one-step undo

  const hasTarget = !!target
  const nodeKey = target ? `${target.storeKey}:${target.nodeId}` : null

  const refreshList = useCallback(async () => {
    if (!effectType) return
    try {
      const next = await listPresets(effectType)
      setGroups(next)
    } catch (err) {
      setErrorText(err?.message || 'Failed to list presets')
    }
  }, [effectType])

  // Reset per-instance state and reload the list whenever the open effect (or
  // its type) changes — a stale undo blob or selection must never leak across
  // effect instances.
  useEffect(() => {
    setSelected(null)
    setUndoBlob(null)
    setErrorText(null)
    setSaving(false)
    setOverwriteArmed(false)
    setDraftName('')
    refreshList()
  }, [effectType, nodeKey, refreshList])

  useEffect(() => {
    if (saving && nameInputRef.current) nameInputRef.current.focus()
  }, [saving])

  // ── Load / apply ────────────────────────────────────────────────────────────

  const applyPreset = useCallback(async (source, slug) => {
    if (!hasTarget || busy) return
    setBusy(true)
    setErrorText(null)
    try {
      const { before, after } = await loadPreset(effectType, source, slug, target)
      setUndoBlob(before)
      setSelected({ source, slug })
      onApplied?.(after)
    } catch (err) {
      // effectType mismatch and any load failure surface here, visibly.
      setErrorText(err?.message || 'Failed to load preset')
      setSelected(null)
    } finally {
      setBusy(false)
    }
  }, [effectType, target, hasTarget, busy, onApplied])

  const handleSelectChange = useCallback((e) => {
    const raw = e.target.value
    if (!raw) { setSelected(null); return }
    const sep = raw.indexOf(':')
    const source = raw.slice(0, sep)
    const slug = raw.slice(sep + 1)
    applyPreset(source, slug)
  }, [applyPreset])

  // ── Undo (single step) ──────────────────────────────────────────────────────

  const handleUndo = useCallback(async () => {
    if (!undoBlob || !hasTarget || busy) return
    setBusy(true)
    try {
      await revertState(effectType, target, undoBlob)
      onApplied?.(undoBlob)
      setUndoBlob(null)
      setSelected(null)
    } catch (err) {
      setErrorText(err?.message || 'Failed to undo preset load')
    } finally {
      setBusy(false)
    }
  }, [undoBlob, effectType, target, hasTarget, busy, onApplied])

  // ── Save ─────────────────────────────────────────────────────────────────────

  const beginSave = useCallback(() => {
    setErrorText(null)
    setOverwriteArmed(false)
    setDraftName('')
    setSaving(true)
  }, [])

  const cancelSave = useCallback(() => {
    setSaving(false)
    setOverwriteArmed(false)
    setDraftName('')
  }, [])

  const commitSave = useCallback(async () => {
    const trimmed = draftName.trim()
    if (!trimmed) { setErrorText('Enter a preset name'); return }
    const slug = slugifyPresetName(trimmed)
    const exists = groups.user.some(p => p.slug === slug)
    if (exists && !overwriteArmed) {
      setOverwriteArmed(true)   // second submit confirms the overwrite
      return
    }
    if (!hasTarget || busy) return
    setBusy(true)
    try {
      const res = await savePreset(effectType, trimmed, target)
      await refreshList()
      setSelected({ source: 'user', slug: res?.slug || slug })
      cancelSave()
    } catch (err) {
      setErrorText(err?.message || 'Failed to save preset')
    } finally {
      setBusy(false)
    }
  }, [draftName, groups.user, overwriteArmed, effectType, target, hasTarget, busy, refreshList, cancelSave])

  const handleNameKeyDown = useCallback((e) => {
    // Panels host their own Ctrl+Z etc.; keep keystrokes inside the input.
    e.stopPropagation()
    if (e.key === 'Enter') { e.preventDefault(); commitSave() }
    else if (e.key === 'Escape') { e.preventDefault(); cancelSave() }
  }, [commitSave, cancelSave])

  // ── Delete (user presets only) ────────────────────────────────────────────

  const canDelete = selected?.source === 'user'
  const handleDelete = useCallback(async () => {
    if (!canDelete || busy) return
    setBusy(true)
    setErrorText(null)
    try {
      await deletePreset(effectType, selected.slug)
      await refreshList()
      setSelected(null)
    } catch (err) {
      setErrorText(err?.message || 'Failed to delete preset')
    } finally {
      setBusy(false)
    }
  }, [canDelete, busy, effectType, selected, refreshList])

  // ── Render ────────────────────────────────────────────────────────────────

  const selectValue = selected ? `${selected.source}:${selected.slug}` : ''
  const hasAny = groups.factory.length > 0 || groups.user.length > 0

  return (
    <div className={`fx-preset-bar${className ? ' ' + className : ''}`} data-effect-type={effectType}>
      {saving ? (
        <div className="fx-preset-bar__save-form">
          <input
            ref={nameInputRef}
            type="text"
            className="fx-preset-bar__name-input"
            placeholder={overwriteArmed ? 'Overwrite existing preset?' : 'Preset name'}
            value={draftName}
            maxLength={80}
            onChange={(e) => { setDraftName(e.target.value); setOverwriteArmed(false) }}
            onKeyDown={handleNameKeyDown}
            aria-label="Preset name"
          />
          <button
            type="button"
            className={`fx-preset-bar__icon-btn${overwriteArmed ? ' fx-preset-bar__icon-btn--warn' : ''}`}
            onClick={commitSave}
            disabled={busy}
            title={overwriteArmed ? 'Confirm overwrite' : 'Save preset'}
          >
            <Check size={13} />
          </button>
          <button
            type="button"
            className="fx-preset-bar__icon-btn"
            onClick={cancelSave}
            title="Cancel"
          >
            <X size={13} />
          </button>
        </div>
      ) : (
        <>
          <select
            className="fx-preset-bar__select"
            value={selectValue}
            onChange={handleSelectChange}
            disabled={!hasTarget || busy}
            title="Load a preset"
          >
            <option value="">{hasAny ? 'Presets…' : 'No presets'}</option>
            {groups.factory.length > 0 && (
              <optgroup label="Factory">
                {groups.factory.map(p => (
                  <option key={`factory:${p.slug}`} value={`factory:${p.slug}`}>{p.name}</option>
                ))}
              </optgroup>
            )}
            {groups.user.length > 0 && (
              <optgroup label="User">
                {groups.user.map(p => (
                  <option key={`user:${p.slug}`} value={`user:${p.slug}`}>{p.name}</option>
                ))}
              </optgroup>
            )}
          </select>

          <button
            type="button"
            className="fx-preset-bar__icon-btn"
            onClick={beginSave}
            disabled={!hasTarget || busy}
            title="Save current settings as a preset"
          >
            <Save size={13} />
          </button>

          <button
            type="button"
            className="fx-preset-bar__icon-btn"
            onClick={handleDelete}
            disabled={!canDelete || busy}
            title={canDelete ? 'Delete this user preset' : 'Only user presets can be deleted'}
          >
            <Trash2 size={13} />
          </button>

          {undoBlob && (
            <button
              type="button"
              className="fx-preset-bar__icon-btn"
              onClick={handleUndo}
              disabled={busy}
              title="Undo preset load"
            >
              <Undo2 size={13} />
            </button>
          )}
        </>
      )}

      {errorText && (
        <div className="fx-preset-bar__error" role="alert">
          <span className="fx-preset-bar__error-text">{errorText}</span>
          <button
            type="button"
            className="fx-preset-bar__icon-btn"
            onClick={() => setErrorText(null)}
            title="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
