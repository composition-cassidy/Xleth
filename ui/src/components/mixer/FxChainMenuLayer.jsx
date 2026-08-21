import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ClipboardPaste, Copy, FolderOpen, Library, Plus, RefreshCw, Save, Search,
} from 'lucide-react'

import useFxChainDragStore from '../../stores/fxChainDragStore.js'
import useEffectChainStore, { resolveFxMode } from '../../stores/effectChainStore.js'
import useMixerStore from '../../stores/mixerStore.js'
import useVstStore from '../../stores/vstStore.js'
import { useToast } from '../Toast.jsx'
import {
  applyChainEffects, applySavedChain, buildAvailablePluginIds, captureChainEffects,
  listChains, openLibraryFolder, saveChainFromTrack, MASTER_FX_KEY,
} from '../../fx-chains/chainLibrary.js'
import {
  filterChains, findUnavailablePluginIds, groupChainsByFolder,
} from '../../fx-chains/chainDocument.js'

const EMPTY_CHAIN = []
const HOLD_TO_DRAG_MS = 220

// useToast throws outside a ToastProvider. The mixer always has one in the real
// app, but a strip rendered on its own in a test does not, and a missing toast
// must never be the reason a chain fails to load. useContext still runs before
// the throw, so hook order is unaffected.
function useOptionalToast() {
  try {
    return useToast()
  } catch {
    return { showToast: () => {}, dismiss: () => {} }
  }
}

function labelForKey(fxKey, tracks) {
  if (String(fxKey) === MASTER_FX_KEY) return 'Master'
  return tracks?.[Number(fxKey)]?.name ?? `Track ${fxKey}`
}

// ── Library submenu ──────────────────────────────────────────────────────────

function LibrarySubmenu({ entries, availableIds, targetIsEmpty, onChoose, onFlyout, openSlug }) {
  const [query, setQuery] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const groups = useMemo(
    () => groupChainsByFolder(filterChains(entries, query)),
    [entries, query],
  )

  return (
    <div className="fxchain-submenu" onMouseDown={(e) => e.stopPropagation()}>
      <div className="fxchain-search">
        <Search size={12} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Filter chains…"
          aria-label="Filter saved chains"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="fxchain-lib-scroll">
        {groups.length === 0 && (
          <div className="fxchain-lib-empty">
            {entries.length === 0
              ? 'No saved chains yet — save one from any track.'
              : `No chain matches “${query}”.`}
          </div>
        )}

        {groups.map((group) => (
          <div key={group.folder ?? '__root__'}>
            <div className="fxchain-lib-group">
              {group.folder ? <FolderOpen size={11} aria-hidden="true" /> : null}
              <span>{group.folder ?? 'Library'}</span>
            </div>
            {group.chains.map((chain) => {
              const missing = findUnavailablePluginIds(chain.pluginIds, availableIds)
              const rowKey = `${chain.folder ?? ''}/${chain.slug}`
              const title = (chain.pluginIds ?? []).join(' → ')
                + (missing.length ? `  ·  not installed: ${missing.join(', ')}` : '')
              return (
                <button
                  key={rowKey}
                  type="button"
                  className={`fxchain-lib-item${missing.length ? ' is-missing' : ''}${openSlug === rowKey ? ' is-open' : ''}`}
                  title={title}
                  onMouseEnter={(e) => (targetIsEmpty ? null : onFlyout(chain, rowKey, e.currentTarget))}
                  onClick={(e) => {
                    e.stopPropagation()
                    // Nothing to lose on an empty track — skip the
                    // replace/append question and just load it.
                    if (targetIsEmpty) onChoose(chain, 'replace')
                    else onFlyout(chain, rowKey, e.currentTarget)
                  }}
                >
                  <span className="fxchain-lib-name">{chain.name}</span>
                  {missing.length > 0 && (
                    <span className="fxchain-lib-warn" title={`not installed: ${missing.join(', ')}`}>▲</span>
                  )}
                  <span className="fxchain-lib-count">{chain.effectCount} fx</span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Save dialog ──────────────────────────────────────────────────────────────

function SaveChainDialog({ defaultName, effects, folders, canSaveStrip, onCancel, onSave }) {
  const [name, setName] = useState(defaultName)
  const [folder, setFolder] = useState('')
  const [includeStrip, setIncludeStrip] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.select() }, [])

  const commit = useCallback(() => {
    const trimmed = name.trim()
    if (!trimmed) return
    onSave({ name: trimmed, folder: folder || null, includeStrip })
  }, [name, folder, includeStrip, onSave])

  return createPortal(
    <div className="fxchain-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="fxchain-dialog" role="dialog" aria-modal="true" aria-label="Save FX chain">
        <h4>Save FX Chain</h4>
        <div className="fxchain-dialog-body">
          <label htmlFor="fxchain-name">Name</label>
          <input
            id="fxchain-name"
            ref={inputRef}
            type="text"
            value={name}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') onCancel()
            }}
          />

          {folders.length > 0 && (
            <>
              <label htmlFor="fxchain-folder">Folder</label>
              <select
                id="fxchain-folder"
                className="fxchain-dialog-select"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
              >
                <option value="">Library (root)</option>
                {folders.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </>
          )}

          <label>Captured</label>
          <div className="fxchain-capture-list">
            {effects.map((fx, i) => (
              <div className="fxchain-capture-row" key={`${fx.pluginId}-${i}`}>
                <span className="fxchain-capture-idx">{i + 1}</span>
                <span className="fxchain-capture-name">{fx.displayName || fx.pluginId}</span>
                {fx.bypassed && <span className="fxchain-capture-bypass">bypassed</span>}
              </div>
            ))}
          </div>

          {canSaveStrip && (
            <label className="fxchain-opt">
              <input
                type="checkbox"
                checked={includeStrip}
                onChange={(e) => setIncludeStrip(e.target.checked)}
              />
              Also save fader, pan &amp; width
            </label>
          )}
        </div>
        <div className="fxchain-dialog-foot">
          <button type="button" className="fxchain-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="fxchain-btn fxchain-btn--primary" onClick={commit}>Save</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── The layer ────────────────────────────────────────────────────────────────

export default function FxChainMenuLayer() {
  const menu = useFxChainDragStore((s) => s.menu)
  const closeMenu = useFxChainDragStore((s) => s.closeMenu)
  const beginDrag = useFxChainDragStore((s) => s.begin)
  const moveDrag = useFxChainDragStore((s) => s.move)
  const endDrag = useFxChainDragStore((s) => s.end)
  const countDrop = useFxChainDragStore((s) => s.countDrop)
  const dragEffects = useFxChainDragStore((s) => s.effects)
  const dragSourceKey = useFxChainDragStore((s) => s.sourceKey)
  const dragSourceLabel = useFxChainDragStore((s) => s.sourceLabel)
  const dragX = useFxChainDragStore((s) => s.x)
  const dragY = useFxChainDragStore((s) => s.y)
  const clipboard = useFxChainDragStore((s) => s.clipboard)
  const copyChain = useFxChainDragStore((s) => s.copyChain)

  const chains = useEffectChainStore((s) => s.chains)
  const fxModes = useEffectChainStore((s) => s.fxModes)
  const fetchChain = useEffectChainStore((s) => s.fetchChain)
  const tracks = useMixerStore((s) => s.tracks)
  const setVolume = useMixerStore((s) => s.setVolume)
  const setPan = useMixerStore((s) => s.setPan)
  const setSpread = useMixerStore((s) => s.setSpread)
  const vstPlugins = useVstStore((s) => s.plugins)
  const { showToast } = useOptionalToast()

  const [library, setLibrary] = useState({ chains: [], folders: [] })
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [flyout, setFlyout] = useState(null)       // { chain, rowKey, x, y }
  const [saveDraft, setSaveDraft] = useState(null) // { fxKey, effects }
  const menuRef = useRef(null)
  const holdTimer = useRef(null)

  const availableIds = useMemo(() => buildAvailablePluginIds(vstPlugins), [vstPlugins])

  const fxKey = menu?.fxKey ?? null
  const chain = fxKey ? (chains[fxKey] ?? EMPTY_CHAIN) : EMPTY_CHAIN
  const isMaster = fxKey === MASTER_FX_KEY
  const graphMode = fxKey ? resolveFxMode(fxModes, fxKey) === 'graph' : false
  const chainEmpty = chain.length === 0
  const stripName = fxKey ? labelForKey(fxKey, tracks) : ''

  // ── menu lifecycle ─────────────────────────────────────────────────────────

  const dismiss = useCallback(() => {
    setLibraryOpen(false)
    setFlyout(null)
    closeMenu()
  }, [closeMenu])

  // Refresh the library each time a menu opens. It is a folder on disk the user
  // can edit behind the app's back, so a cached list would go stale silently.
  useEffect(() => {
    if (!menu) { setLibraryOpen(false); setFlyout(null); return }
    let cancelled = false
    listChains().then((result) => {
      if (cancelled) return
      setLibrary({ chains: result.chains ?? [], folders: result.folders ?? [] })
    })
    return () => { cancelled = true }
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target)) return
      if (e.target.closest?.('.fxchain-flyout')) return
      dismiss()
    }
    const onKey = (e) => { if (e.key === 'Escape') dismiss() }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu, dismiss])

  // Clamp into the viewport once the menu has a measured size.
  useEffect(() => {
    const el = menuRef.current
    if (!el || !menu) return
    const rect = el.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      el.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`
    }
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`
    }
  }, [menu])

  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current) }, [])

  // ── shared apply path ──────────────────────────────────────────────────────

  const runApply = useCallback(async (targetKey, effects, { label, mode }) => {
    const result = await applyChainEffects(targetKey, effects, { label, mode })
    const targetName = labelForKey(targetKey, tracks)
    if (!result.ok) {
      showToast(`Could not load onto ${targetName}: ${result.error}`, 'error')
      return result
    }
    await fetchChain(targetKey)

    const verb = mode === 'append' ? 'added to' : 'loaded onto'
    const what = label ? `“${label}”` : 'FX chain'
    showToast(`${what} ${verb} ${targetName} — ${result.added} effect${result.added === 1 ? '' : 's'}`)
    if (result.skipped.length > 0) {
      showToast(
        `Not installed on this machine, so skipped: ${result.skipped.join(', ')}`,
        'error',
      )
    }
    return result
  }, [fetchChain, showToast, tracks])

  // ── menu actions ───────────────────────────────────────────────────────────

  const handleSaveClick = useCallback(async () => {
    const captured = await captureChainEffects(fxKey, chain)
    dismiss()
    if (!captured.ok) { showToast(`Could not read the chain: ${captured.error}`, 'error'); return }
    if (captured.effects.length === 0) { showToast('This track has no effects to save.', 'error'); return }
    setSaveDraft({ fxKey, effects: captured.effects })
  }, [fxKey, chain, dismiss, showToast])

  const handleSaveCommit = useCallback(async ({ name, folder, includeStrip }) => {
    const draft = saveDraft
    setSaveDraft(null)
    if (!draft) return

    const track = tracks?.[Number(draft.fxKey)]
    const strip = includeStrip && track
      ? { volume: track.volume, pan: track.pan, spread: track.spread }
      : null

    const result = await saveChainFromTrack({
      fxKey: draft.fxKey,
      chainSlots: chains[draft.fxKey] ?? EMPTY_CHAIN,
      name,
      folder,
      strip,
    })
    if (!result.ok) { showToast(`Could not save: ${result.error}`, 'error'); return }
    showToast(result.overwritten
      ? `Overwrote “${name}” in the library`
      : `Saved “${name}” — ${result.effectCount} effect${result.effectCount === 1 ? '' : 's'}`)
  }, [saveDraft, tracks, chains, showToast])

  const handleCopy = useCallback(async () => {
    const captured = await captureChainEffects(fxKey, chain)
    dismiss()
    if (!captured.ok) { showToast(`Could not read the chain: ${captured.error}`, 'error'); return }
    copyChain(stripName, captured.effects)
    showToast(`Copied ${captured.effects.length} effect${captured.effects.length === 1 ? '' : 's'} from ${stripName}`)
  }, [fxKey, chain, dismiss, copyChain, stripName, showToast])

  const handlePaste = useCallback(() => {
    if (!clipboard) return
    const target = fxKey
    dismiss()
    runApply(target, clipboard.effects, {
      label: `${clipboard.sourceLabel}'s chain`,
      mode: 'replace',
    })
  }, [clipboard, fxKey, dismiss, runApply])

  const handleOpenFolder = useCallback(async () => {
    dismiss()
    const result = await openLibraryFolder()
    if (!result.ok) showToast(`Could not open ${result.root || 'the library folder'}`, 'error')
  }, [dismiss, showToast])

  const handleChooseSaved = useCallback(async (entry, mode) => {
    const target = fxKey
    dismiss()
    const result = await applySavedChain(target, entry.folder, entry.slug, { mode })
    if (!result.ok) {
      showToast(`Could not load “${entry.name}”: ${result.error}`, 'error')
      return
    }
    await fetchChain(target)

    const targetName = labelForKey(target, tracks)
    const verb = mode === 'append' ? 'added to' : 'loaded onto'
    showToast(`“${result.name}” ${verb} ${targetName} — ${result.added} effect${result.added === 1 ? '' : 's'}`)
    if (result.skipped.length > 0) {
      showToast(`Not installed on this machine, so skipped: ${result.skipped.join(', ')}`, 'error')
    }

    // Strip state travels only when the chain was saved with it, and never onto
    // the master strip (which has no pan or width to restore).
    if (result.strip && target !== MASTER_FX_KEY) {
      const trackId = Number(target)
      if (typeof result.strip.volume === 'number') setVolume(trackId, result.strip.volume)
      if (typeof result.strip.pan === 'number') setPan(trackId, result.strip.pan)
      if (typeof result.strip.spread === 'number') setSpread(trackId, result.strip.spread)
    }
  }, [fxKey, dismiss, fetchChain, tracks, showToast, setVolume, setPan, setSpread])

  // ── press-and-hold → sticky drag ───────────────────────────────────────────

  const startHold = useCallback((e) => {
    if (e.button !== 0 || chainEmpty || graphMode) return
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const sourceKey = fxKey
    const sourceName = stripName

    holdTimer.current = setTimeout(async () => {
      holdTimer.current = null
      const captured = await captureChainEffects(sourceKey, chains[sourceKey] ?? EMPTY_CHAIN)
      if (!captured.ok || captured.effects.length === 0) {
        showToast('Could not pick up this chain.', 'error')
        return
      }
      beginDrag(sourceKey, sourceName, captured.effects, startX, startY)
      showToast(`Carrying ${sourceName}'s chain — click each track to drop it, Esc to stop`)
    }, HOLD_TO_DRAG_MS)
  }, [chainEmpty, graphMode, fxKey, stripName, chains, beginDrag, showToast])

  const endHold = useCallback(() => {
    // Released before the hold threshold — that was a click, so save.
    if (!holdTimer.current) return
    clearTimeout(holdTimer.current)
    holdTimer.current = null
    handleSaveClick()
  }, [handleSaveClick])

  // ── drag: window-level pointer tracking + sticky drops ─────────────────────

  const dragging = Array.isArray(dragEffects)

  useEffect(() => {
    if (!dragging) return

    const hitTest = (x, y) => {
      const el = document.elementFromPoint(x, y)
      return el?.closest?.('[data-fx-key]')?.getAttribute('data-fx-key') ?? null
    }

    const onMove = (e) => moveDrag(e.clientX, e.clientY, hitTest(e.clientX, e.clientY))

    const onDown = async (e) => {
      // Right-click, or a click on anything that is not a strip, puts it down.
      const targetKey = e.button === 0 ? hitTest(e.clientX, e.clientY) : null
      if (targetKey == null) { endDrag(); return }
      e.preventDefault()
      e.stopPropagation()

      // The source strip is not a drop target; clicking it is a no-op, not an end.
      if (!countDrop(targetKey)) return

      await runApply(targetKey, dragEffects, {
        label: `${dragSourceLabel}'s chain`,
        mode: 'replace',
      })
      // Deliberately still dragging: "Track 1's effects onto Track 2 AND 3" is
      // one gesture, so the chain stays on the cursor until Escape.
    }

    const onKey = (e) => { if (e.key === 'Escape') endDrag() }
    const onContext = (e) => { e.preventDefault(); endDrag() }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('contextmenu', onContext)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('contextmenu', onContext)
    }
  }, [dragging, dragEffects, dragSourceLabel, moveDrag, endDrag, countDrop, runApply])

  // ── render ─────────────────────────────────────────────────────────────────

  const libraryEntries = library.chains

  return (
    <>
      {menu && createPortal(
        <div
          ref={menuRef}
          className="fxchain-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          aria-label={`${stripName} FX chain`}
        >
          <div className="fxchain-menu-head">
            <span>{isMaster ? 'Master' : 'Track'}</span>
            <b>{stripName}</b>
          </div>

          <button
            type="button"
            role="menuitem"
            className="fxchain-mi fxchain-mi--grab"
            disabled={chainEmpty || graphMode}
            onMouseDown={startHold}
            onMouseUp={endHold}
          >
            <span className="fxchain-grip" aria-hidden="true" />
            <span className="fxchain-glyph"><Save size={13} /></span>
            <span className="fxchain-mi-stack">
              <span>Save FX Chain…</span>
              <span className="fxchain-mi-sub">
                {graphMode ? 'this track is in FX Graph mode'
                  : chainEmpty ? 'no effects on this track'
                  : 'hold to drag onto other tracks'}
              </span>
            </span>
          </button>

          <button
            type="button"
            role="menuitem"
            className="fxchain-mi"
            disabled={chainEmpty || graphMode}
            onClick={handleCopy}
          >
            <span className="fxchain-glyph"><Copy size={13} /></span>
            <span>Copy FX Chain</span>
          </button>

          <button
            type="button"
            role="menuitem"
            className="fxchain-mi"
            disabled={!clipboard || graphMode}
            onClick={handlePaste}
          >
            <span className="fxchain-glyph"><ClipboardPaste size={13} /></span>
            <span>Paste FX Chain</span>
            {clipboard && (
              <span className="fxchain-shortcut">{clipboard.effects.length} fx</span>
            )}
          </button>

          <div className="fxchain-sep" />

          {/* The submenu is a SIBLING of the row, not a child: a menu full of
              buttons nested inside a button is invalid markup and swallows
              clicks. The wrapper is what anchors it and owns the hover. */}
          <div
            className="fxchain-mi-wrap"
            onMouseEnter={() => !graphMode && setLibraryOpen(true)}
          >
            <button
              type="button"
              role="menuitem"
              aria-haspopup="true"
              aria-expanded={libraryOpen}
              className={`fxchain-mi${libraryOpen ? ' is-open' : ''}`}
              disabled={graphMode}
              onClick={(e) => { e.stopPropagation(); if (!graphMode) setLibraryOpen(true) }}
            >
              <span className="fxchain-glyph"><Library size={13} /></span>
              <span className="fxchain-mi-stack">
                <span>FX Chain Library</span>
                {graphMode && <span className="fxchain-mi-sub">chain mode only</span>}
              </span>
              <span className="fxchain-arrow">▸</span>
            </button>

            {libraryOpen && !graphMode && (
              <LibrarySubmenu
                entries={libraryEntries}
                availableIds={availableIds}
                targetIsEmpty={chainEmpty}
                openSlug={flyout?.rowKey ?? null}
                onChoose={handleChooseSaved}
                onFlyout={(entry, rowKey, el) => {
                  const rect = el.getBoundingClientRect()
                  setFlyout({ chain: entry, rowKey, x: rect.right + 3, y: rect.top - 4 })
                }}
              />
            )}
          </div>

          <div className="fxchain-sep" />

          <button
            type="button"
            role="menuitem"
            className="fxchain-mi"
            onClick={handleOpenFolder}
            onMouseEnter={() => setLibraryOpen(false)}
          >
            <span className="fxchain-glyph"><FolderOpen size={13} /></span>
            <span>Open Library Folder</span>
          </button>
        </div>,
        document.body,
      )}

      {menu && flyout && createPortal(
        <div className="fxchain-flyout" style={{ left: flyout.x, top: flyout.y }} role="menu">
          <button
            type="button"
            role="menuitem"
            className="fxchain-mi"
            onClick={(e) => { e.stopPropagation(); handleChooseSaved(flyout.chain, 'replace') }}
          >
            <span className="fxchain-glyph"><RefreshCw size={13} /></span>
            <span>Replace chain</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="fxchain-mi"
            onClick={(e) => { e.stopPropagation(); handleChooseSaved(flyout.chain, 'append') }}
          >
            <span className="fxchain-glyph"><Plus size={13} /></span>
            <span>Add to chain</span>
          </button>
        </div>,
        document.body,
      )}

      {saveDraft && (
        <SaveChainDialog
          defaultName={labelForKey(saveDraft.fxKey, tracks)}
          effects={saveDraft.effects}
          folders={library.folders}
          canSaveStrip={saveDraft.fxKey !== MASTER_FX_KEY}
          onCancel={() => setSaveDraft(null)}
          onSave={handleSaveCommit}
        />
      )}

      {dragging && createPortal(
        <div className="fxchain-ghost" style={{ left: dragX, top: dragY }} aria-hidden="true">
          <span className="fxchain-ghost-count">{dragEffects.length}</span>
          <span>{dragSourceLabel} FX chain</span>
          <span className="fxchain-ghost-hint">click a track · Esc to stop</span>
        </div>,
        document.body,
      )}
    </>
  )
}
