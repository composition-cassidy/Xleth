import { useCallback, useEffect, useRef, useState } from 'react'
import {
  listPresets, savePreset, loadPreset, deletePreset, revertState,
} from './presetManager.js'
import { slugifyPresetName } from './slugify.js'

// Named-preset state for one open stock effect: list, load (with one-step
// revert), save (with overwrite confirm) and delete. Shared by the legacy
// EffectPresetBar and the device title bar's preset menu, so both run the same
// presetManager / adapter path (ui/src/fx-presets/effectPresetAdapters.js).
//
//   effectType – stock effect id ("compressor", "apex", …)
//   target     – { trackId, nodeId, storeKey } | null
//   onApplied  – (stateBlob) => void after a load or revert

export default function useEffectPresets({ effectType, target, onApplied }) {
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

  const selectValue = selected ? `${selected.source}:${selected.slug}` : ''
  const hasAny = groups.factory.length > 0 || groups.user.length > 0

  return {
    groups, selected, selectValue, hasAny, hasTarget, busy, errorText, setErrorText,
    saving, draftName, setDraftName, overwriteArmed, setOverwriteArmed, nameInputRef,
    undoBlob, canDelete,
    applyPreset, handleSelectChange, handleUndo, beginSave, cancelSave, commitSave,
    handleNameKeyDown, handleDelete,
  }
}
