import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowUp,
  File,
  Folder,
  FolderPlus,
  HardDrive,
  Home,
  Music,
  Star,
  Video,
  X,
} from 'lucide-react'
import {
  basename,
  dirname,
  ensureSaveExtension,
  fileMatchesFilters,
  formatLength,
  joinPath,
  samePath,
  uniqueParentDirectories,
} from './filePickerHelpers.js'

function pickerApi() {
  return window.xleth?.filePicker || null
}

function projectFolderItems(projectInfo) {
  if (!projectInfo) return []
  const specs = [
    ['Project', projectInfo.projectDir],
    ['Exports', projectInfo.exportsDir],
    ['Swapped', projectInfo.swappedDir],
    ['Proxies', projectInfo.proxiesDir],
  ]
  const seen = new Set()
  return specs
    .filter(([, value]) => typeof value === 'string' && value)
    .filter(([, value]) => {
      const key = value.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(([label, path]) => ({ label, path }))
}

function iconForEntry(entry) {
  if (entry.isDirectory) return Folder
  const ext = String(entry.extension || '').replace(/^\./, '')
  if (['wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a'].includes(ext)) return Music
  if (['mp4', 'avi', 'mov', 'mkv', 'webm', 'wmv'].includes(ext)) return Video
  return File
}

function actionLabelFor(options) {
  if (options.actionLabel) return options.actionLabel
  if (options.mode === 'openDirectory') return 'Select Folder'
  if (options.mode === 'saveFile') return 'Save'
  if (options.mode === 'openFiles') return 'Import'
  return 'Open'
}

function defaultTitleFor(options) {
  if (options.title) return options.title
  if (options.mode === 'openDirectory') return 'Choose Folder'
  if (options.mode === 'saveFile') return 'Choose Output File'
  if (options.mode === 'openFiles') return 'Choose Files'
  return 'Choose File'
}

export default function XlethFilePickerModal({ options, onCancel, onAccept }) {
  const api = pickerApi()
  const [roots, setRoots] = useState({ locations: [], drives: [], favorites: [], home: '' })
  const [projectInfo, setProjectInfo] = useState(null)
  const [sourceFolders, setSourceFolders] = useState([])
  const [currentDir, setCurrentDir] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [entries, setEntries] = useState([])
  const [durations, setDurations] = useState({})
  const [selectedPaths, setSelectedPaths] = useState(() => new Set())
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('New Folder')
  const firstLoadRef = useRef(true)

  const mode = options.mode || 'openFile'
  const filters = useMemo(() => options.filters || [], [options.filters])
  const actionLabel = actionLabelFor(options)
  const title = defaultTitleFor(options)

  const showFiles = mode !== 'openDirectory'
  const visibleEntries = useMemo(() => {
    return entries.filter(entry => {
      if (entry.isDirectory) return true
      if (!showFiles) return false
      return fileMatchesFilters(entry, filters)
    })
  }, [entries, filters, showFiles])

  const selectedEntries = useMemo(() => {
    const selected = []
    for (const entry of visibleEntries) {
      if (selectedPaths.has(entry.path)) selected.push(entry)
    }
    return selected
  }, [selectedPaths, visibleEntries])

  const selectedFiles = selectedEntries.filter(entry => !entry.isDirectory)
  const selectedFolders = selectedEntries.filter(entry => entry.isDirectory)
  const isFavorite = roots.favorites.some(path => samePath(path, currentDir))
  const canGoUp = !!currentDir && dirname(currentDir) && !samePath(dirname(currentDir), currentDir)

  const navigateTo = useCallback((dirPath, { pushHistory = true } = {}) => {
    if (!dirPath) return
    setError('')
    setSelectedPaths(new Set())
    setCurrentDir(previous => {
      if (pushHistory && previous && !samePath(previous, dirPath)) {
        setHistory(items => [...items.slice(-30), previous])
      }
      return dirPath
    })
    setPathInput(dirPath)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function boot() {
      setLoading(true)
      setError('')
      try {
        const nextRoots = await api?.getRoots?.()
        if (cancelled) return
        const rootData = nextRoots || { locations: [], drives: [], favorites: [], home: '' }
        setRoots(rootData)

        try {
          const info = await window.xleth?.project?.getInfo?.()
          if (!cancelled) setProjectInfo(info || null)
        } catch {}
        try {
          const sources = await window.xleth?.timeline?.getSources?.()
          if (!cancelled) setSourceFolders(uniqueParentDirectories(sources))
        } catch {}

        const fallbackDir = rootData.locations?.[0]?.path || rootData.home || rootData.drives?.[0]?.path || ''
        const candidate = options.defaultPath || options.initialPath || options.initialDirectory || ''
        let initialDir = fallbackDir
        let initialInput = candidate || fallbackDir
        if (candidate && api?.validatePath) {
          const checked = await api.validatePath(candidate)
          if (checked?.exists && checked.isDirectory) {
            initialDir = checked.path
            initialInput = checked.path
          } else if (checked?.exists && checked.isFile) {
            initialDir = checked.parentPath || fallbackDir
            initialInput = checked.path
            setSelectedPaths(new Set([checked.path]))
          } else if (mode === 'saveFile' && checked?.parentExists) {
            initialDir = checked.parentPath
            initialInput = ensureSaveExtension(checked.path, filters, options.defaultExtension)
          }
        } else if (options.defaultName && fallbackDir) {
          initialInput = joinPath(fallbackDir, options.defaultName)
        }
        if (mode === 'saveFile' && !candidate && options.defaultName && fallbackDir) {
          initialInput = ensureSaveExtension(joinPath(fallbackDir, options.defaultName), filters, options.defaultExtension)
        }
        if (!initialDir) throw new Error('No accessible starting folder was found.')
        setCurrentDir(initialDir)
        setPathInput(initialInput || initialDir)
      } catch (err) {
        setError(err?.message || 'Could not open file picker.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    boot()
    return () => { cancelled = true }
  }, [api, filters, mode, options.defaultExtension, options.defaultName, options.defaultPath, options.initialDirectory, options.initialPath])

  useEffect(() => {
    if (!currentDir) return
    let cancelled = false
    async function loadDirectory() {
      setLoading(true)
      setError('')
      try {
        const result = await api?.listDirectory?.(currentDir)
        if (cancelled) return
        setEntries(Array.isArray(result?.entries) ? result.entries : [])
        if (!firstLoadRef.current || mode !== 'saveFile') setPathInput(result?.path || currentDir)
        firstLoadRef.current = false
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Could not read folder.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadDirectory()
    return () => { cancelled = true }
  }, [api, currentDir, mode])

  useEffect(() => {
    const mediaPaths = visibleEntries
      .filter(entry => !entry.isDirectory && entry.isMedia)
      .map(entry => entry.path)
    if (mediaPaths.length === 0) {
      setDurations({})
      return
    }
    let cancelled = false
    api?.probeDurations?.(mediaPaths)
      .then(result => { if (!cancelled) setDurations(result || {}) })
      .catch(() => { if (!cancelled) setDurations({}) })
    return () => { cancelled = true }
  }, [api, visibleEntries])

  const refreshFavorites = useCallback(async () => {
    try {
      const favorites = await api?.getFavorites?.()
      setRoots(prev => ({ ...prev, favorites: Array.isArray(favorites) ? favorites : [] }))
    } catch {}
  }, [api])

  const toggleFavorite = useCallback(async () => {
    if (!currentDir) return
    const current = roots.favorites || []
    const next = isFavorite
      ? current.filter(path => !samePath(path, currentDir))
      : [...current, currentDir]
    try {
      const saved = await api?.setFavorites?.(next)
      setRoots(prev => ({ ...prev, favorites: Array.isArray(saved) ? saved : next }))
    } catch (err) {
      setError(err?.message || 'Could not update favorites.')
    }
  }, [api, currentDir, isFavorite, roots.favorites])

  const goBack = useCallback(() => {
    setHistory(items => {
      const previous = items[items.length - 1]
      if (previous) navigateTo(previous, { pushHistory: false })
      return items.slice(0, -1)
    })
  }, [navigateTo])

  const goUp = useCallback(() => {
    const parent = dirname(currentDir)
    if (parent && !samePath(parent, currentDir)) navigateTo(parent)
  }, [currentDir, navigateTo])

  const handleRowClick = (entry, event) => {
    setError('')
    setPathInput(entry.path)
    if (entry.isDirectory && mode !== 'openDirectory') {
      setSelectedPaths(new Set())
      return
    }
    setSelectedPaths(prev => {
      if (mode === 'openFiles' && !entry.isDirectory && (event.ctrlKey || event.metaKey)) {
        const next = new Set(prev)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        return next
      }
      return new Set([entry.path])
    })
  }

  const acceptPath = useCallback(async (rawPath) => {
    const input = String(rawPath || '').trim()
    if (!input) {
      setError('Choose a path first.')
      return
    }
    const checked = await api?.validatePath?.(input)
    if (!checked?.ok) {
      setError(checked?.error || 'Path is not valid.')
      return
    }
    if (checked.exists && checked.isDirectory) {
      if (mode === 'openDirectory') {
        onAccept({ canceled: false, path: checked.path, paths: [checked.path] })
      } else {
        navigateTo(checked.path)
      }
      return
    }
    if (mode === 'saveFile') {
      const outputPath = ensureSaveExtension(checked.path, filters, options.defaultExtension)
      const outputCheck = await api?.validatePath?.(outputPath)
      if (!outputCheck?.parentExists) {
        setError('The destination folder does not exist.')
        return
      }
      onAccept({ canceled: false, path: outputPath, paths: [outputPath] })
      return
    }
    if (!checked.exists || !checked.isFile) {
      setError('Choose an existing file.')
      return
    }
    if (!fileMatchesFilters(checked.path, filters)) {
      setError('That file type is not valid for this action.')
      return
    }
    onAccept({ canceled: false, path: checked.path, paths: [checked.path] })
  }, [api, filters, mode, navigateTo, onAccept, options.defaultExtension])

  const acceptSelection = useCallback(async () => {
    if (mode === 'openDirectory') {
      const target = selectedFolders[0]?.path || currentDir
      await acceptPath(target)
      return
    }
    if (mode === 'openFiles') {
      const paths = selectedFiles.map(entry => entry.path)
      if (paths.length === 0) {
        setError('Choose one or more files.')
        return
      }
      onAccept({ canceled: false, path: paths[0], paths })
      return
    }
    if (mode === 'openFile' && selectedFiles.length > 0) {
      onAccept({ canceled: false, path: selectedFiles[0].path, paths: [selectedFiles[0].path] })
      return
    }
    await acceptPath(pathInput)
  }, [acceptPath, currentDir, mode, onAccept, pathInput, selectedFiles, selectedFolders])

  const handleRowDoubleClick = async (entry) => {
    if (entry.isDirectory) {
      navigateTo(entry.path)
      return
    }
    if (mode === 'openFile' || mode === 'saveFile') await acceptPath(entry.path)
  }

  const handlePathKeyDown = async (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      await acceptPath(pathInput)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    }
  }

  const createFolder = async () => {
    try {
      const created = await api?.createFolder?.(currentDir, newFolderName)
      setNewFolderOpen(false)
      setNewFolderName('New Folder')
      if (created?.path) navigateTo(created.path)
      await refreshFavorites()
    } catch (err) {
      setError(err?.message || 'Could not create folder.')
    }
  }

  const sidebarSections = [
    {
      title: 'Favorite Folders',
      items: (roots.favorites || []).map(path => ({ label: basename(path) || path, path, icon: Star })),
      empty: 'No favorites yet',
    },
    {
      title: 'Project Folders',
      items: projectFolderItems(projectInfo).map(item => ({ ...item, icon: Folder })),
    },
    {
      title: 'Source Folders',
      items: sourceFolders.map(item => ({ ...item, icon: Music })),
    },
    {
      title: 'Locations',
      items: (roots.locations || []).map(item => ({ ...item, icon: item.label === 'Desktop' ? Home : Folder })),
    },
    {
      title: 'Drives',
      items: (roots.drives || []).map(item => ({ ...item, icon: HardDrive })),
    },
  ]

  const acceptDisabled = mode === 'openFiles'
    ? selectedFiles.length === 0
    : mode === 'openFile'
      ? selectedFiles.length === 0 && !pathInput.trim()
      : !currentDir && !pathInput.trim()

  return (
    <div className="xleth-file-picker-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) onCancel()
    }}>
      <div className="xleth-file-picker" role="dialog" aria-modal="true" aria-label={title}>
        <div className="xleth-file-picker__header">
          <div>
            <div className="xleth-file-picker__title">{title}</div>
            <div className="xleth-file-picker__subtitle">{options.subtitle || 'Choose a filesystem path for this XLETH task.'}</div>
          </div>
          <button type="button" className="xleth-file-picker__icon-btn" onClick={onCancel} title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="xleth-file-picker__pathbar">
          <input
            className="xleth-file-picker__path-input"
            value={pathInput}
            onChange={event => setPathInput(event.target.value)}
            onKeyDown={handlePathKeyDown}
            spellCheck={false}
            autoFocus
            aria-label="File path"
          />
          <button type="button" className="xleth-file-picker__icon-btn" onClick={goBack} disabled={history.length === 0} title="Go back">
            <ArrowLeft size={16} />
          </button>
          <button type="button" className="xleth-file-picker__icon-btn" onClick={goUp} disabled={!canGoUp} title="Go up one folder">
            <ArrowUp size={16} />
          </button>
          <button type="button" className="xleth-file-picker__icon-btn" onClick={() => setNewFolderOpen(v => !v)} title="Add new folder">
            <FolderPlus size={16} />
          </button>
          <button type="button" className={`xleth-file-picker__icon-btn${isFavorite ? ' is-active' : ''}`} onClick={toggleFavorite} title={isFavorite ? 'Remove favorite' : 'Favorite current folder'}>
            <Star size={16} fill={isFavorite ? 'currentColor' : 'none'} />
          </button>
        </div>

        {newFolderOpen && (
          <div className="xleth-file-picker__new-folder">
            <input
              value={newFolderName}
              onChange={event => setNewFolderName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') createFolder()
                if (event.key === 'Escape') setNewFolderOpen(false)
              }}
              aria-label="New folder name"
            />
            <button type="button" onClick={createFolder}>Create</button>
            <button type="button" onClick={() => setNewFolderOpen(false)}>Cancel</button>
          </div>
        )}

        <div className="xleth-file-picker__body">
          <aside className="xleth-file-picker__sidebar">
            {sidebarSections.map(section => (
              <div key={section.title} className="xleth-file-picker__sidebar-section">
                <div className="xleth-file-picker__sidebar-title">{section.title}</div>
                {section.items.length === 0 ? (
                  section.empty ? <div className="xleth-file-picker__sidebar-empty">{section.empty}</div> : null
                ) : (
                  section.items.map(item => {
                    const Icon = item.icon || Folder
                    return (
                      <button
                        type="button"
                        key={`${section.title}-${item.path}`}
                        className={`xleth-file-picker__sidebar-item${samePath(item.path, currentDir) ? ' is-active' : ''}`}
                        title={item.path}
                        onClick={() => navigateTo(item.path)}
                      >
                        <Icon size={14} />
                        <span>{item.label}</span>
                      </button>
                    )
                  })
                )}
              </div>
            ))}
          </aside>

          <main className="xleth-file-picker__main">
            <div className="xleth-file-picker__table-head">
              <span>Name</span>
              <span>Length</span>
            </div>
            <div className="xleth-file-picker__table" role="listbox" aria-label="Files and folders">
              {loading ? (
                <div className="xleth-file-picker__empty">Loading...</div>
              ) : visibleEntries.length === 0 ? (
                <div className="xleth-file-picker__empty">No matching items</div>
              ) : (
                visibleEntries.map(entry => {
                  const Icon = iconForEntry(entry)
                  const selected = selectedPaths.has(entry.path)
                  return (
                    <button
                      type="button"
                      key={entry.path}
                      className={`xleth-file-picker__row${selected ? ' is-selected' : ''}`}
                      title={entry.path}
                      onClick={event => handleRowClick(entry, event)}
                      onDoubleClick={() => handleRowDoubleClick(entry)}
                    >
                      <span className="xleth-file-picker__row-name">
                        <Icon size={15} />
                        <span>{entry.name}</span>
                      </span>
                      <span className="xleth-file-picker__row-length">{formatLength(entry, durations[entry.path])}</span>
                    </button>
                  )
                })
              )}
            </div>
          </main>
        </div>

        {error && <div className="xleth-file-picker__error">{error}</div>}

        <div className="xleth-file-picker__footer">
          <div className="xleth-file-picker__hint">
            {mode === 'saveFile' ? basename(pathInput) : selectedEntries.map(entry => entry.name).join(', ')}
          </div>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="xleth-file-picker__primary" disabled={acceptDisabled} onClick={acceptSelection}>
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
