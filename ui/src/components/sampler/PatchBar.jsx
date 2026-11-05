import { useCallback, useEffect, useRef, useState } from 'react'
import { Save, Trash2 } from 'lucide-react'
import { listSamplerPatches, deleteSamplerPatch } from './samplerPatch.js'

// ── PatchBar ────────────────────────────────────────────────────────────────
// Save / load named sampler patches from the panel's tab bar.
//
// A native <select> on purpose: the sampler is a floating window, and the panel
// layer has its own stacking context — a portaled menu here has to be mounted
// into the panel's own shell to come out above it. The OS renders a native
// select's popup outside the page entirely, so it has no such problem, and the
// panel's other dropdowns (PREP algorithm, MANGLE mode) are already native.
//
// The value encodes both roots: "user:my-patch" / "factory:tight-one-shot",
// because a user patch and a factory one can share a slug.

export default function PatchBar({ onSave, onLoad, disabled }) {
  const [patches, setPatches] = useState({ factory: [], user: [] })
  const [selected, setSelected] = useState('')
  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState(null)
  const inputRef = useRef(null)
  const statusTimer = useRef(null)

  const refresh = useCallback(async () => {
    setPatches(await listSamplerPatches())
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => () => clearTimeout(statusTimer.current), [])

  useEffect(() => {
    if (naming) { inputRef.current?.focus(); inputRef.current?.select() }
  }, [naming])

  const flash = useCallback((msg) => {
    setStatus(msg)
    clearTimeout(statusTimer.current)
    statusTimer.current = setTimeout(() => setStatus(null), 2400)
  }, [])

  const commitSave = useCallback(async () => {
    const name = draft.trim()
    setNaming(false)
    if (!name) return
    const res = await onSave(name)
    if (res?.ok) {
      await refresh()
      setSelected(`user:${res.slug}`)
      flash(res.overwritten ? 'Replaced' : 'Saved')
    } else {
      flash(res?.error || 'Save failed')
    }
  }, [draft, onSave, refresh, flash])

  const handleSelect = useCallback(async (value) => {
    setSelected(value)
    if (!value) return
    const [source, slug] = value.split(':')
    const res = await onLoad(source, slug)
    flash(res?.ok ? 'Loaded' : (res?.error || 'Load failed'))
  }, [onLoad, flash])

  const handleDelete = useCallback(async () => {
    if (!selected.startsWith('user:')) return
    const slug = selected.slice('user:'.length)
    if (await deleteSamplerPatch(slug)) {
      setSelected('')
      await refresh()
      flash('Deleted')
    } else {
      flash('Delete failed')
    }
  }, [selected, refresh, flash])

  const hasAny = patches.factory.length > 0 || patches.user.length > 0

  return (
    <div className="sampler-patch-bar">
      {naming ? (
        <input
          ref={inputRef}
          className="sampler-patch-name"
          value={draft}
          placeholder="Patch name"
          maxLength={80}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitSave}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') { e.preventDefault(); commitSave() }
            else if (e.key === 'Escape') { e.preventDefault(); setNaming(false) }
          }}
        />
      ) : (
        <>
          <select
            className="sampler-select sampler-patch-select"
            value={selected}
            disabled={disabled || !hasAny}
            onChange={(e) => handleSelect(e.target.value)}
            title={hasAny
              ? 'Load a saved patch — settings only, your loaded samples are kept'
              : 'No patches saved yet'}
          >
            <option value="">{hasAny ? 'Patch…' : 'No patches'}</option>
            {patches.user.length > 0 && (
              <optgroup label="Mine">
                {patches.user.map((p) => (
                  <option key={`user:${p.slug}`} value={`user:${p.slug}`}>{p.name}</option>
                ))}
              </optgroup>
            )}
            {patches.factory.length > 0 && (
              <optgroup label="Factory">
                {patches.factory.map((p) => (
                  <option key={`factory:${p.slug}`} value={`factory:${p.slug}`}>{p.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            type="button"
            className="sampler-patch-btn"
            onClick={() => { setDraft(''); setNaming(true) }}
            disabled={disabled}
            title="Save these settings as a named patch — tuning, trim, loop, prep, mangle, voicing, arp and modulation (not the audio)"
            aria-label="Save patch"
          ><Save size={12} /></button>
          <button
            type="button"
            className="sampler-patch-btn sampler-patch-btn--danger"
            onClick={handleDelete}
            disabled={disabled || !selected.startsWith('user:')}
            title={selected.startsWith('user:') ? 'Delete this patch' : 'Select one of your own patches to delete it'}
            aria-label="Delete patch"
          ><Trash2 size={12} /></button>
        </>
      )}
      {status && <span className="sampler-patch-status">{status}</span>}
    </div>
  )
}
