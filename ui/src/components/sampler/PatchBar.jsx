import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconButton, Select } from '../../ui-kit'
import { listSamplerPatches, deleteSamplerPatch } from './samplerPatch.js'
import styles from './Sampler.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcFloppyDisk = iconComponent('floppy-disk')
const IcTrash = iconComponent('trash')

// ── PatchBar ────────────────────────────────────────────────────────────────
// Save / load named sampler patches from the panel header. A patch is settings
// only (tuning, trim, loop, prep, mangle, voicing, arpeggiator, modulation): the
// loaded audio is kept. Loading is one engine command, so one Ctrl+Z.
//
// The option value encodes both roots, "user:my-patch" / "factory:tight-one-shot",
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

  const options = useMemo(() => [
    ...patches.user.map((p) => ({ value: `user:${p.slug}`, label: p.name, group: 'Mine' })),
    ...patches.factory.map((p) => ({ value: `factory:${p.slug}`, label: p.name, group: 'Factory' })),
  ], [patches])
  const hasAny = options.length > 0
  const isUser = selected.startsWith('user:')

  return (
    <div className={styles.patch}>
      {naming ? (
        <input
          ref={inputRef}
          className={`${styles.textInput} ${styles.patchName}`}
          value={draft}
          placeholder="Patch name"
          aria-label="Patch name"
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
        <Select
          size="sm"
          className={styles.patchSelect}
          ariaLabel="Sampler patch"
          value={selected}
          options={options}
          placeholder={hasAny ? 'Patch' : 'No patches'}
          disabled={disabled || !hasAny}
          onChange={handleSelect}
          hint={hasAny
            ? 'Load a saved patch: settings only, the loaded samples are kept. One Ctrl+Z undoes it.'
            : 'No patches saved yet'}
        />
      )}
      <IconButton
        size="sm"
        label="Save patch"
        onClick={() => { setDraft(''); setNaming(true) }}
        disabled={disabled || naming}
        hint="Save these settings as a named patch: tuning, trim, loop, prep, mangle, voicing, arpeggiator and modulation (not the audio)"
      >
        <IcFloppyDisk aria-hidden="true" />
      </IconButton>
      <IconButton
        size="sm"
        label="Delete patch"
        onClick={handleDelete}
        disabled={disabled || !isUser}
        hint={isUser ? 'Delete this patch file' : 'Select one of your own patches to delete it'}
      >
        <IcTrash aria-hidden="true" />
      </IconButton>
      {status ? <span className={styles.patchStatus} role="status">{status}</span> : null}
    </div>
  )
}
