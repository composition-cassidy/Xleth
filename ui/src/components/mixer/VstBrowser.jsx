import { useState, useMemo, useEffect } from 'react'
import { X, FolderPlus, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import useVstStore from '../../stores/vstStore.js'
import useEffectChainStore from '../../stores/effectChainStore.js'
import ScanProgressBar, { useScanProgress } from './ScanProgressBar.jsx'
import { getPickerPath, openFilePicker } from '../filePicker/filePickerService.js'
import { Button, IconButton, TextField } from '../../ui-kit'
import styles from './VstBrowser.module.css'

// Search folders are engine-owned since P1 (%APPDATA%\Xleth\plugin-settings.json,
// audio.get/setPluginSearchPaths). This key is the pre-P1 renderer copy: it is
// pushed into the engine's VST3 user folders once, then deleted.
const LEGACY_PATHS_KEY = 'xleth.vstSearchPaths'
const FORMAT = 'VST3'

async function loadEnginePaths() {
  const audio = window.xleth?.audio
  const all = await audio?.getPluginSearchPaths?.()
  let vst3 = all?.[FORMAT] ?? { defaults: [], user: [], useDefaults: true }

  let legacy = null
  try { legacy = localStorage.getItem(LEGACY_PATHS_KEY) } catch { legacy = null }
  if (legacy === null) return vst3

  let list = []
  try { list = JSON.parse(legacy) } catch { list = [] }
  const merged = [...vst3.user]
  for (const p of Array.isArray(list) ? list : []) {
    if (typeof p === 'string' && p && !merged.includes(p)) merged.push(p)
  }
  const res = merged.length === vst3.user.length
    ? { ok: true }
    : await audio?.setPluginSearchPaths?.(FORMAT, merged, vst3.useDefaults)
  if (res?.ok) {
    try { localStorage.removeItem(LEGACY_PATHS_KEY) } catch { /* private mode */ }
    vst3 = { ...vst3, user: merged }
  } else {
    console.error('[PluginLib] search-path migration failed', res?.error)
  }
  return vst3
}

export default function VstBrowser({ embedded = false }) {
  const [search,     setSearch]     = useState('')
  const [failedOpen, setFailedOpen] = useState(false)
  const [paths,      setPaths]      = useState([])
  const [useDefaults, setUseDefaults] = useState(true)

  const plugins         = useVstStore(s => s.plugins)
  const failedPlugins   = useVstStore(s => s.failedPlugins)
  const browserOpen     = useVstStore(s => s.browserOpen)
  const browserStoreKey = useVstStore(s => s.browserStoreKey)
  const closeBrowser    = useVstStore(s => s.closeBrowser)
  const fetchPlugins    = useVstStore(s => s.fetchPlugins)
  const fetchFailed     = useVstStore(s => s.fetchFailed)

  const addEffect = useEffectChainStore(s => s.addEffect)
  const isOpen = embedded || browserOpen
  const scan = useScanProgress()

  // Refresh lists when browser opens
  useEffect(() => {
    if (!isOpen) return
    fetchPlugins()
    fetchFailed()
    let live = true
    loadEnginePaths()
      .then((v) => {
        if (!live) return
        setPaths(Array.isArray(v.user) ? v.user : [])
        setUseDefaults(v.useDefaults !== false)
      })
      .catch((err) => console.error('[PluginLib] getPluginSearchPaths failed', err))
    return () => { live = false }
  }, [isOpen, fetchPlugins, fetchFailed])

  const savePaths = async (next) => {
    const res = await window.xleth?.audio?.setPluginSearchPaths?.(FORMAT, next, useDefaults)
    if (res?.ok) setPaths(next)
    else console.error('[PluginLib] setPluginSearchPaths failed', res?.error)
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return plugins
    return plugins.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.vendor || '').toLowerCase().includes(q)
    )
  }, [plugins, search])

  const handleScan = async () => {
    await window.xleth?.audio?.scanPlugins?.({ mode: 'incremental' })
  }

  const handleAddPath = async () => {
    const picked = await openFilePicker({
      mode: 'openDirectory',
      title: 'Add VST3 Search Folder',
      subtitle: 'Choose a folder to scan for VST3 plugins.',
      actionLabel: 'Add path',
      legacyPicker: () => window.xleth?.audio?.addVstSearchPath?.(),
    })
    const dir = getPickerPath(picked)
    if (!dir) return
    if (paths.includes(dir)) return
    await savePaths([...paths, dir])
  }

  const handleRemovePath = (idx) => {
    savePaths(paths.filter((_, i) => i !== idx))
  }

  const handleDoubleClick = (plugin) => {
    if (embedded) return
    if (!browserStoreKey) return
    addEffect(browserStoreKey, plugin.id)
  }

  if (!isOpen) return null

  const countText = search.trim()
    ? `${filtered.length} of ${plugins.length} plugins`
    : `${plugins.length} plugin${plugins.length === 1 ? '' : 's'}`

  return (
    <div className={`${styles.root}`}>
      <div className={styles.toolbar}>
        <TextField
          className={styles.search}
          label="Search plugins"
          type="search"
          placeholder="Search name or vendor…"
          value={search}
          onChange={setSearch}
        />
        <span className={styles.count}>{countText}</span>
        <Button onClick={handleAddPath} glyph={<FolderPlus />} hint="Add a VST3 search folder">
          Add path
        </Button>
        <Button variant="primary" onClick={handleScan} disabled={scan.scanning} glyph={<RefreshCw />}>
          {scan.scanning ? 'Scanning…' : 'Scan plugins'}
        </Button>
        {!embedded && (
          <IconButton label="Close plugin browser" onClick={closeBrowser}>
            <X />
          </IconButton>
        )}
      </div>

      <ScanProgressBar progress={scan} />

      <div className={styles.scroll}>
        {filtered.length === 0 ? (
          <div className={styles.empty}>
            {plugins.length === 0
              ? 'No plugins scanned. Choose Scan plugins to search your folders.'
              : 'No plugins match this search.'}
          </div>
        ) : (
          <table className={styles.table} aria-label="VST3 plugins">
            <colgroup>
              <col className={styles.colName} />
              <col className={styles.colVendor} />
              <col className={styles.colFormat} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Vendor</th>
                <th scope="col">Format</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr
                  key={p.id}
                  title={`${p.name} — ${p.vendor}\n${p.filePath}`}
                  onDoubleClick={() => handleDoubleClick(p)}
                >
                  <td>{p.name}</td>
                  <td className={styles.vendor}>{p.vendor}</td>
                  <td className={styles.format}>{p.format}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {failedPlugins.length > 0 && (
        <div>
          <Button
            variant="ghost"
            aria-expanded={failedOpen}
            glyph={failedOpen ? <ChevronDown /> : <ChevronRight />}
            onClick={() => setFailedOpen(v => !v)}
          >
            {failedPlugins.length} failed plugin{failedPlugins.length !== 1 ? 's' : ''}
          </Button>
          {failedOpen && (
            <ul className={styles.failedList}>
              {failedPlugins.map((f, i) => (
                <li key={i} className={styles.failedItem} title={f.filePath}>
                  {f.filePath.split(/[/\\]/).pop()}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {paths.length > 0 && (
        <div>
          <div className={styles.pathsHead}>Search folders</div>
          <ul className={styles.paths}>
            {paths.map((p, i) => (
              <li key={i} className={styles.pathRow}>
                <span className={styles.pathText} title={p}>{p}</span>
                <IconButton size="sm" variant="ghost" label={`Remove ${p}`} onClick={() => handleRemovePath(i)}>
                  <X />
                </IconButton>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
