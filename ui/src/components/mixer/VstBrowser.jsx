import { useState, useMemo, useEffect } from 'react'
import { X, Search, FolderPlus, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import useVstStore from '../../stores/vstStore.js'
import useEffectChainStore from '../../stores/effectChainStore.js'
import ScanProgressBar from './ScanProgressBar.jsx'

const PATHS_KEY = 'xleth.vstSearchPaths'

function loadPaths() {
  try { return JSON.parse(localStorage.getItem(PATHS_KEY) || '[]') } catch { return [] }
}

export default function VstBrowser({ embedded = false }) {
  const [search,     setSearch]     = useState('')
  const [failedOpen, setFailedOpen] = useState(false)
  const [paths,      setPaths]      = useState(loadPaths)

  const plugins         = useVstStore(s => s.plugins)
  const failedPlugins   = useVstStore(s => s.failedPlugins)
  const browserOpen     = useVstStore(s => s.browserOpen)
  const browserStoreKey = useVstStore(s => s.browserStoreKey)
  const closeBrowser    = useVstStore(s => s.closeBrowser)
  const fetchPlugins    = useVstStore(s => s.fetchPlugins)
  const fetchFailed     = useVstStore(s => s.fetchFailed)

  const addEffect = useEffectChainStore(s => s.addEffect)
  const isOpen = embedded || browserOpen

  // Refresh lists when browser opens
  useEffect(() => {
    if (!isOpen) return
    fetchPlugins()
    fetchFailed()
  }, [isOpen, fetchPlugins, fetchFailed])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return plugins
    return plugins.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.vendor || '').toLowerCase().includes(q)
    )
  }, [plugins, search])

  const handleScan = async () => {
    await window.xleth?.audio?.scanPlugins?.(paths)
  }

  const handleAddPath = async () => {
    const dir = await window.xleth?.audio?.addVstSearchPath?.()
    if (!dir) return
    const next = [...paths, dir]
    setPaths(next)
    localStorage.setItem(PATHS_KEY, JSON.stringify(next))
  }

  const handleRemovePath = (idx) => {
    const next = paths.filter((_, i) => i !== idx)
    setPaths(next)
    localStorage.setItem(PATHS_KEY, JSON.stringify(next))
  }

  const handleDoubleClick = (plugin) => {
    if (embedded) return
    if (!browserStoreKey) return
    addEffect(browserStoreKey, plugin.id)
  }

  if (!isOpen) return null

  return (
    <div className={`vst-browser${embedded ? ' vst-browser--embedded' : ''}`}>
      <div className="vst-browser-header">
        <span className="vst-browser-title">VST3 Browser</span>
        {!embedded && (
          <button className="vst-browser-close" onClick={closeBrowser} title="Close">
            <X size={11} />
          </button>
        )}
      </div>

      {/* Search */}
      <div className="vst-browser-search-row">
        <Search size={10} className="vst-browser-search-icon" />
        <input
          className="vst-browser-search-input"
          placeholder="Search name or vendor…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Plugin list */}
      <div className="vst-browser-list">
        {filtered.length === 0 ? (
          <div className="vst-browser-empty">
            {plugins.length === 0
              ? 'No plugins scanned — click Scan Plugins below'
              : 'No results'}
          </div>
        ) : (
          filtered.map(p => (
            <div
              key={p.id}
              className="vst-browser-row"
              title={`${p.name} — ${p.vendor}\n${p.filePath}`}
              onDoubleClick={() => handleDoubleClick(p)}
            >
              <span className="vst-browser-row-name">{p.name}</span>
              <span className="vst-browser-row-vendor">{p.vendor}</span>
              <span className="vst-browser-row-format">{p.format}</span>
            </div>
          ))
        )}
      </div>

      {/* Failed plugins */}
      {failedPlugins.length > 0 && (
        <div className="vst-browser-failed-section">
          <button
            className="vst-browser-failed-toggle"
            onClick={() => setFailedOpen(v => !v)}
          >
            {failedOpen ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
            <span>{failedPlugins.length} failed plugin{failedPlugins.length !== 1 ? 's' : ''}</span>
          </button>
          {failedOpen && (
            <div className="vst-browser-failed-list">
              {failedPlugins.map((f, i) => (
                <div key={i} className="vst-browser-failed-item" title={f.filePath}>
                  {f.filePath.split(/[/\\]/).pop()}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Search paths */}
      {paths.length > 0 && (
        <div className="vst-browser-paths">
          {paths.map((p, i) => (
            <div key={i} className="vst-browser-path-row">
              <span className="vst-browser-path-text" title={p}>{p}</span>
              <button
                className="vst-browser-path-remove"
                onClick={() => handleRemovePath(i)}
                title="Remove path"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Footer */}
      <ScanProgressBar />
      <div className="vst-browser-footer">
        <button className="vst-browser-btn" onClick={handleAddPath} title="Add VST3 search folder">
          <FolderPlus size={10} />
          <span>Add Path</span>
        </button>
        <button className="vst-browser-btn vst-browser-btn--primary" onClick={handleScan}>
          <RefreshCw size={10} />
          <span>Scan Plugins</span>
        </button>
      </div>
    </div>
  )
}
