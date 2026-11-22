import { useEffect, useState, useCallback, useMemo } from 'react'
import { timelineEvents } from './timelineEvents.js'
import TitleBar from './components/TitleBar.jsx'
import RenderDialog from './components/RenderDialog.jsx'
import ExportZipDialog from './components/ExportZipDialog.jsx'
import MidiImportDialog from './components/MidiImport/MidiImportDialog.jsx'
import SettingsPanel from './components/SettingsPanel.jsx'
import MissingPluginsDialog from './components/MissingPluginsDialog.jsx'
import PluginLoadingDialog from './components/PluginLoadingDialog.jsx'
import MissingMediaDialog from './components/MissingMediaDialog.jsx'
import DevThemeSwitcher from './components/debug/DevThemeSwitcher.jsx'
import { ToastProvider, useToast } from './components/Toast.jsx'
import UpdateBanner from './components/UpdateBanner.jsx'
import { showUnsavedChangesDialog } from './components/UnsavedChangesDialog.jsx'
import { showCleanupProjectDialog } from './components/CleanupProjectDialog.jsx'
import { CLEANUP_PROJECT_LABEL, reportPurgeOnClose, runCleanupProject } from './components/projectCleanup.js'
import XlethFilePickerProvider from './components/filePicker/XlethFilePickerProvider.jsx'
import { getPickerPath, getPickerPaths, openFilePicker as openXlethFilePicker } from './components/filePicker/filePickerService.js'
import usePianoRollStore from './stores/usePianoRollStore.js'
import { useUiScaleStore } from './stores/uiScaleStore.js'
import useWorldProcessingStore from './stores/worldProcessingStore.js'
import AppShell from './windowing/AppShell.tsx'
import HintBar from './components/HintBar.jsx'
import XlethRootContext from './windowing/contexts/XlethRootContext.jsx'
import { usePanelRegistry } from './windowing/registry/PanelRegistry'
import { runEditorCommand } from './windowing/managers/EditorCommandRegistry'
import { comboFromEvent } from './windowing/managers/shortcutCatalog.ts'
import { load as loadShortcutOverrides, resolveCombos } from './windowing/managers/shortcutOverrides.ts'
import { ElectronAdapter } from './windowing/managers/StatePersistence'
import * as StatePersistence from './windowing/managers/StatePersistence'
import { DEFAULT_PRESET_ID } from './windowing/managers/PresetManager'
import {
  beforeMotionViewProjectSwitch,
  cancelMotionViewProjectSwitch,
  flushMotionViewState,
} from './components/motionView/motionViewSession.js'

const EXPORT_AUDIO_LABEL = 'Export Audio…'
const EXPORT_VIDEO_LABEL = 'Export Video…'
const EXPORT_ZIP_LABEL = 'Export as ZIP…'
const ZOOM_IN_LABEL = 'Zoom In'
const ZOOM_OUT_LABEL = 'Zoom Out'
const RESET_ZOOM_LABEL = 'Reset Zoom'

const MEDIA_IMPORT_FILTERS = [
  { name: 'All Supported', extensions: ['mp4', 'avi', 'mov', 'mkv', 'wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a', 'png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif'] },
  { name: 'Video Files', extensions: ['mp4', 'avi', 'mov', 'mkv'] },
  { name: 'Images and GIFs', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif'] },
  { name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a'] },
  { name: 'All Files', extensions: ['*'] },
]

function sourceNameFromPath(filePath) {
  return String(filePath || '').replace(/^.*[\\/]/, '') || 'source'
}

function assertImportedSourceId(sourceId) {
  if (!Number.isFinite(sourceId) || sourceId < 0) {
    throw new Error('Engine rejected the media file.')
  }
  return sourceId
}

async function currentProjectRoot(xl = window.xleth) {
  try {
    const info = await xl?.project?.getInfo?.()
    return typeof info?.projectDir === 'string' && info.projectDir ? info.projectDir : ''
  } catch {
    return ''
  }
}

/**
 * Save the current project via Save / Save-As flow.
 * Returns:
 *   true         on successful save
 *   'cancelled'  when the user cancels the Save-As folder picker
 *   false        on any other failure (disk / permission / write error)
 *
 * showToast is passed in so this helper can surface failures from outside
 * the component scope.
 */
async function saveCurrentProject(showToast, setProjectName, openFilePicker = openXlethFilePicker) {
  const xl = window.xleth
  try {
    const hasDir = await xl.project.hasProjectDir()
    if (!hasDir) {
      const projectDir = await currentProjectRoot(xl)
      const picked = await openFilePicker({
        mode: 'openDirectory',
        title: 'Save Project As',
        subtitle: 'Choose the folder where this XLETH project should live.',
        actionLabel: 'Save Here',
        initialDirectory: projectDir || undefined,
        legacyPicker: () => xl.project.openSaveAsDialog(),
      })
      const dir = getPickerPath(picked)
      if (!dir) return 'cancelled'
      const name = dir.split(/[\\/]/).pop() || 'Untitled'
      // A Motion view change still in its push debounce goes into this save.
      await flushMotionViewState()
      const ok = await xl.project.saveAs(dir, name)
      if (ok) {
        setProjectName(name)
        return true
      }
      showToast?.('Save failed - could not write to the chosen folder.', 'error')
      return false
    }
    await flushMotionViewState()
    const ok = await xl.project.save()
    if (!ok) {
      showToast?.('Save failed. Check that the project folder is writable.', 'error')
      return false
    }
    return true
  } catch (e) {
    showToast?.(`Save failed: ${e.message || e}`, 'error')
    return false
  }
}

export async function hydrateProductionLayout({
  statePersistence = StatePersistence,
  panelRegistry = usePanelRegistry,
  adapter = new ElectronAdapter(),
} = {}) {
  statePersistence.setPersistenceAdapter(adapter)
  const hydrated = await statePersistence.loadPersistedState()
  if (!hydrated) {
    panelRegistry.getState().applyPreset(DEFAULT_PRESET_ID)
  }
  return hydrated
}

// ─── Global menu shortcuts ──────────────────────────────────────────────────
// The command ids come from shortcutCatalog; the menu labels are the ones
// handleXlethRootMenuAction dispatches on, declared as constants above. This
// map is the only place the two meet, so a rebind in Settings changes which
// key reaches a menu action without touching either side.
const MENU_LABEL_BY_COMMAND = {
  'file.new': 'New Project',
  'file.open': 'Open Project',
  'file.save': 'Save',
  'file.saveAs': 'Save As...',
  'file.importSource': 'Import Source',
  'file.exportAudio': EXPORT_AUDIO_LABEL,
  'file.exportVideo': EXPORT_VIDEO_LABEL,
  'view.zoomIn': ZOOM_IN_LABEL,
  'view.zoomOut': ZOOM_OUT_LABEL,
  'view.resetZoom': RESET_ZOOM_LABEL,
}

export function getFileMenuShortcutLabel(e) {
  const target = e.target
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return null

  const combo = comboFromEvent(e)
  if (!combo) return null

  // Longest-combo-first so Ctrl+Shift+E (Export Video) is tested before
  // Ctrl+E (Export Audio) — resolveCombos returns exact strings, but a user
  // override could legitimately make one command's combo a prefix of
  // another's, and matching the more specific one is always the right answer.
  const ids = Object.keys(MENU_LABEL_BY_COMMAND)
  let best = null
  for (const id of ids) {
    if (!resolveCombos(id).includes(combo)) continue
    if (!best || combo.length > best.combo.length) best = { id, combo }
  }
  return best ? MENU_LABEL_BY_COMMAND[best.id] : null
}

export async function handleXlethRootMenuAction(label, {
  xl = window.xleth,
  showToast,
  setProjectName,
  openRenderDialog,
  setActiveSampleId,
  setPickerSource,
  setCurrentPatternIdByTrack,
  setAllPatterns,
  setMissingPlugins,
  setMissingMedia,
  setExportZipOpen,
  setShowSettings,
  setSettingsInitialCategory,
  openFilePicker = openXlethFilePicker,
} = {}) {
  switch (label) {
    case 'New Project': {
      try {
        if (await xl.project.isExportRunning?.()) {
          showToast?.('Cannot start a new project while exporting.', 'error')
          return
        }
      } catch {}

      let dirty = false
      try { dirty = !!(await xl.project.isDirty?.()) } catch {}
      if (dirty) {
        const choice = await showUnsavedChangesDialog()
        if (choice === 'cancel') return
        if (choice === 'save') {
          const result = await saveCurrentProject(showToast, setProjectName, openFilePicker)
          if (result === 'cancelled') return
          if (result !== true) return
        }
      }

      // Motion view: the pending push lands in THIS project, then pushes wait
      // for the new project's state to load (no old view in the new project).
      await beforeMotionViewProjectSwitch()
      let res
      try {
        res = await xl.project.switchToNew?.()
      } catch (e) {
        cancelMotionViewProjectSwitch()
        throw e
      }
      if (!res || !res.ok) {
        cancelMotionViewProjectSwitch()
        showToast?.(`New Project failed: ${res?.error || 'unknown error'}`, 'error')
        return
      }
      // "Delete regenerable files when closing a project": say what it freed.
      await reportPurgeOnClose({ xl, showToast })

      setProjectName?.('Untitled Project')

      const pianoRollStore = usePianoRollStore.getState()
      pianoRollStore.setPatternId(null)
      pianoRollStore.setDetached(false)
      pianoRollStore.setActiveCenterTab('timeline')
      usePanelRegistry.getState().closePanel('pianoRoll')

      usePanelRegistry.getState().closePanel('sampler')
      setActiveSampleId?.(null)
      setPickerSource?.(null)
      setCurrentPatternIdByTrack?.({})
      setAllPatterns?.({})
      setMissingPlugins?.(null)

      timelineEvents.dispatchEvent(new Event('timeline-sources-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-regions-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-clips-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      break
    }
    case 'Open Project': {
      const picked = await openFilePicker({
        mode: 'openDirectory',
        title: 'Open Project',
        subtitle: 'Choose an XLETH project folder.',
        actionLabel: 'Open Project',
        legacyPicker: () => xl.project.openProjectDialog(),
      })
      const dir = getPickerPath(picked)
      if (!dir) return
      await beforeMotionViewProjectSwitch()
      let loaded
      try {
        loaded = await xl.project.switchToLoad(dir)
      } catch (e) {
        cancelMotionViewProjectSwitch()
        throw e
      }
      // switchToLoad resolves false (or { ok: false }) when the project did not open.
      if (loaded === false || (loaded && typeof loaded === 'object' && loaded.ok === false)) {
        cancelMotionViewProjectSwitch()
      }
      // "Delete regenerable files when closing a project": say what it freed.
      await reportPurgeOnClose({ xl, showToast })
      const info = await xl.project.getInfo()
      setProjectName?.(info?.projectName || dir.split(/[\\/]/).pop() || 'Project')
      timelineEvents.dispatchEvent(new Event('timeline-sources-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-regions-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-clips-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      try {
        const rawMissing = await xl.audio?.getMissingPlugins?.()
        if (rawMissing) {
          const parsed = JSON.parse(rawMissing)
          if (Array.isArray(parsed) && parsed.length > 0) setMissingPlugins?.(parsed)
        }
      } catch (e) {
        console.warn('[Project] getMissingPlugins error:', e)
      }
      // Surface media that the engine could not auto-relink (typically external
      // source videos moved from another machine) so the user can locate them.
      try {
        const media = await xl.project.validateMedia()
        if (Array.isArray(media)) {
          const missing = media.filter((m) => m && m.found === false)
          if (missing.length > 0) setMissingMedia?.(missing)
        }
      } catch (e) {
        console.warn('[Project] validateMedia error:', e)
      }
      break
    }
    case 'Save': {
      const result = await saveCurrentProject(showToast, setProjectName, openFilePicker)
      if (result === true) showToast?.('Project saved.', 'success')
      break
    }
    case 'Save As...': {
      const projectDir = await currentProjectRoot(xl)
      const picked = await openFilePicker({
        mode: 'openDirectory',
        title: 'Save Project As',
        subtitle: 'Choose the destination project folder.',
        actionLabel: 'Save Here',
        initialDirectory: projectDir || undefined,
        legacyPicker: () => xl.project.openSaveAsDialog(),
      })
      const dir = getPickerPath(picked)
      if (!dir) return
      const name = dir.split(/[\\/]/).pop() || 'Untitled'
      await flushMotionViewState()
      const ok = await xl.project.saveAs(dir, name)
      if (ok) {
        setProjectName?.(name)
        showToast?.('Project saved.', 'success')
      } else {
        showToast?.('Save As failed - could not write to the chosen folder.', 'error')
      }
      break
    }
    case 'Import Source': {
      const picked = await openFilePicker({
        mode: 'openFiles',
        title: 'Import Sources',
        subtitle: 'Choose audio, video or image sources to add to the current project.',
        actionLabel: 'Import',
        filters: MEDIA_IMPORT_FILTERS,
        legacyPicker: () => xl.project.openImportDialog(),
      })
      const files = getPickerPaths(picked)
      if (!files.length) return
      let importedCount = 0
      for (const filePath of files) {
        try {
          assertImportedSourceId(await xl.project.importSource(await xl.project.prepareImport(filePath)))
          importedCount += 1
        } catch (e) {
          const name = sourceNameFromPath(filePath)
          console.error(`[ProjectMedia] Error importing ${name}:`, e)
          showToast?.(`Import failed: ${name} (${e?.message || 'unknown error'})`, 'error')
        }
      }
      if (importedCount > 0) {
        timelineEvents.dispatchEvent(new Event('timeline-sources-changed'))
      }
      break
    }
    case EXPORT_AUDIO_LABEL:
      openRenderDialog?.('audio')
      break
    case EXPORT_VIDEO_LABEL:
      openRenderDialog?.('video')
      break
    case EXPORT_ZIP_LABEL:
      setExportZipOpen?.(true)
      break
    case CLEANUP_PROJECT_LABEL:
      await runCleanupProject({ xl, showToast, confirm: showCleanupProjectDialog })
      break
    case ZOOM_IN_LABEL:
      xl.window.zoomIn?.()
      break
    case ZOOM_OUT_LABEL:
      xl.window.zoomOut?.()
      break
    case RESET_ZOOM_LABEL:
      xl.window.resetZoom?.()
      break
    case 'Undo':
      // The arrangement owns the gesture: it pops a compound edit (a paste is
      // an overwrite plus an insert) as one step, exactly as Ctrl+Z does.
      if (!(await runEditorCommand('undo', 'timeline'))) await xl.undo.undo()
      timelineEvents.dispatchEvent(new Event('timeline-tracks-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-track-layout-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
      break
    case 'Redo':
      if (!(await runEditorCommand('redo', 'timeline'))) await xl.undo.redo()
      timelineEvents.dispatchEvent(new Event('timeline-tracks-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-track-layout-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
      break
    case 'Delete':
      await runEditorCommand('deleteSelected')
      break
    case 'Exit':
      xl.window.close()
      break
    case 'Settings':
      setSettingsInitialCategory?.('project')
      setShowSettings?.(true)
      break
    default:
      break
  }
}

// P2 (docs/PLUGIN_HOSTING_LOG.md): if the previous engine died while loading a
// third-party plugin, the engine recovered its breadcrumb at start and
// quarantined that plugin. Show ONE notice for it. Reading the record consumes
// it, so the module-level promise keeps a StrictMode double-mount from
// swallowing it on the first (discarded) mount.
let lastLoadCrashNotice = null

export function reportLastPluginLoadCrash({ xl, showToast }) {
  if (!lastLoadCrashNotice) {
    lastLoadCrashNotice = Promise.resolve()
      .then(() => xl?.audio?.getLastLoadCrash?.())
      .then((crash) => {
        if (!crash || typeof crash.name !== 'string') return false
        const by = crash.vendor ? ` by ${crash.vendor}` : ''
        showToast?.(
          `XLETH's engine stopped while loading ${crash.name}${by} last session. ` +
          'It is quarantined: projects keep it as a placeholder until you retry it.',
          'error',
        )
        return true
      })
      .catch((e) => {
        console.warn('[PluginHost] getLastLoadCrash failed:', e)
        return false
      })
  }
  return lastLoadCrashNotice
}

export default function XlethRoot() {
  return (
    <ToastProvider>
      <XlethFilePickerProvider>
        <XlethRootInner />
      </XlethFilePickerProvider>
    </ToastProvider>
  )
}

function XlethRootInner() {
  const { showToast } = useToast()
  // TODO: lift to Zustand in 6d. These root-owned UI selections still bridge
  // the production windowing wrappers with the legacy app components.
  const [pickerSource, setPickerSource] = useState(null)
  const [activeSampleId, setActiveSampleId] = useState(null)
  const [currentPatternIdByTrack, setCurrentPatternIdByTrack] = useState({})
  const [allPatterns, setAllPatterns] = useState({})

  const [projectName, setProjectName] = useState('Untitled Project')
  const [renderDialogOpen, setRenderDialogOpen] = useState(false)
  const [renderDialogHint, setRenderDialogHint] = useState(null) // 'audio' | 'video' | null
  const [renderDialogRequestNonce, setRenderDialogRequestNonce] = useState(0)
  const [exportZipOpen, setExportZipOpen] = useState(false)
  const [midiImportOpen, setMidiImportOpen] = useState(false)
  const [midiInitialPath, setMidiInitialPath] = useState(null)
  const [missingPlugins, setMissingPlugins] = useState(null)
  const [missingMedia, setMissingMedia] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialCategory, setSettingsInitialCategory] = useState('project')

  const pianoRollPatternId = usePianoRollStore((s) => s.patternId)
  const activeCenterTab = usePianoRollStore((s) => s.activeCenterTab)

  useEffect(() => {
    usePianoRollStore.getState().init()
  }, [])

  // Mirror the global UI scale (window zoom) so Settings and the canvases follow it.
  useEffect(() => {
    useUiScaleStore.getState().hydrate()
  }, [])

  // One notice for a plugin whose load killed the previous engine (P2).
  useEffect(() => {
    void reportLastPluginLoadCrash({ xl: window.xleth, showToast })
  }, [showToast])

  useEffect(() => {
    const offStart = window.xleth?.audio?.onWorldProcessingStart?.(({ clipId }) =>
      useWorldProcessingStore.getState().addProcessingClip(clipId))
    const offComplete = window.xleth?.audio?.onWorldProcessingComplete?.(({ clipId }) =>
      useWorldProcessingStore.getState().removeProcessingClip(clipId))
    return () => { offStart?.(); offComplete?.() }
  }, [])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      await hydrateProductionLayout()
      if (cancelled) return
      StatePersistence.init()
    })()

    return () => {
      cancelled = true
      StatePersistence.destroy()
    }
  }, [])

  const fetchAllPatterns = useCallback(async () => {
    try {
      const list = await window.xleth?.timeline?.getAllPatterns()
      if (Array.isArray(list)) {
        const byId = {}
        for (const pattern of list) byId[pattern.id] = pattern
        setAllPatterns(byId)
      }
    } catch (e) {
      console.warn('[XlethRoot] getAllPatterns failed:', e.message)
    }
  }, [])

  useEffect(() => {
    fetchAllPatterns()
    const onChanged = () => fetchAllPatterns()
    timelineEvents.addEventListener('timeline-patterns-changed', onChanged)
    timelineEvents.addEventListener('timeline-pattern-changed', onChanged)
    return () => {
      timelineEvents.removeEventListener('timeline-patterns-changed', onChanged)
      timelineEvents.removeEventListener('timeline-pattern-changed', onChanged)
    }
  }, [fetchAllPatterns])

  useEffect(() => {
    const onOpen = (e) => {
      const regionId = e.detail?.regionId ?? null
      usePanelRegistry.getState().openPanel('sampler', { regionId })
    }
    const onClose = () => {
      usePanelRegistry.getState().closePanel('sampler')
    }
    timelineEvents.addEventListener('open-sampler-settings', onOpen)
    timelineEvents.addEventListener('close-sampler-settings', onClose)
    return () => {
      timelineEvents.removeEventListener('open-sampler-settings', onOpen)
      timelineEvents.removeEventListener('close-sampler-settings', onClose)
    }
  }, [])

  const handleOpenPicker = useCallback((source) => {
    setPickerSource(source)
  }, [])

  const handleClosePicker = useCallback(() => {
    setPickerSource(null)
  }, [])


  const handleSwitchPattern = useCallback((newPatternId) => {
    if (newPatternId == null || newPatternId < 0) return
    usePianoRollStore.getState().setPatternId(newPatternId)
  }, [])

  const handleNewPatternFromPianoRoll = useCallback(async () => {
    const current = allPatterns[pianoRollPatternId]
    if (!current) return

    const regionId = current.regionId
    const existingNames = new Set(Object.values(allPatterns).map((pattern) => pattern.name))
    let n = 1
    while (existingNames.has(`Pattern ${n}`)) n++

    try {
      const newId = await window.xleth?.timeline?.addPattern({
        name: `Pattern ${n}`,
        regionId,
        lengthTicks: current.lengthTicks || 3840,
      })
      if (newId != null && newId >= 0) {
        timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
        usePianoRollStore.getState().setPatternId(newId)
      }
    } catch (e) {
      console.error('[XlethRoot] addPattern failed:', e)
    }
  }, [allPatterns, pianoRollPatternId])

  const openRenderDialog = useCallback((hint) => {
    setRenderDialogHint(hint)
    setRenderDialogRequestNonce((n) => n + 1)
    setRenderDialogOpen(true)
  }, [])

  const handleMenuAction = useCallback(async (label) => {
    await handleXlethRootMenuAction(label, {
      showToast,
      setProjectName,
      openRenderDialog,
      setActiveSampleId,
      setPickerSource,
      setCurrentPatternIdByTrack,
      setAllPatterns,
      setMissingPlugins,
      setMissingMedia,
      setExportZipOpen,
      setShowSettings,
      setSettingsInitialCategory,
    })
  }, [showToast, openRenderDialog])

  // Persisted shortcut overrides, read once at startup. Until this resolves
  // every command answers to its catalog default, which is also what a user
  // who has never rebound anything gets — so a slow read degrades to shipped
  // behavior rather than to no shortcuts at all.
  useEffect(() => { loadShortcutOverrides() }, [])

  useEffect(() => {
    const onKeyDown = (e) => {
      const label = getFileMenuShortcutLabel(e)
      if (label) {
        e.preventDefault()
        e.stopPropagation()
        handleMenuAction(label)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleMenuAction])

  const currentPattern = pianoRollPatternId != null ? allPatterns[pianoRollPatternId] : null
  const availablePatterns = currentPattern
    ? Object.values(allPatterns).filter((pattern) => pattern.regionId === currentPattern.regionId)
    : []

  const onOpenMidiImport = useCallback((fp = null) => {
    setMidiInitialPath(fp)
    setMidiImportOpen(true)
  }, [])

  const rootContextValue = useMemo(() => ({
    onOpenPicker: handleOpenPicker,
    pickerSource,
    onClosePicker: handleClosePicker,
    activeSampleId,
    setActiveSampleId,
    currentPatternIdByTrack,
    setCurrentPatternIdByTrack,
    activeCenterTab,
    availablePatterns,
    // Every pattern in the project, by id: what the Piano Roll and Sampler tabs fall back on
    // when nothing was chosen for them (windowing/panels/dockTabFallback.ts).
    allPatterns,
    onSwitchPattern: handleSwitchPattern,
    onNewPattern: handleNewPatternFromPianoRoll,
    onOpenMidiImport,
  }), [
    handleOpenPicker,
    pickerSource,
    handleClosePicker,
    activeSampleId,
    currentPatternIdByTrack,
    activeCenterTab,
    availablePatterns,
    allPatterns,
    handleSwitchPattern,
    handleNewPatternFromPianoRoll,
    onOpenMidiImport,
  ])

  const handleAppDragOver = useCallback((e) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
  }, [])

  const handleAppDrop = useCallback((e) => {
    const files = Array.from(e.dataTransfer.files)
    const midiFile = files.find(f => /\.(mid|midi|flp)$/i.test(f.name))
    if (midiFile) {
      e.preventDefault()
      // Electron 41+ removed File.path; the preload bridge resolves it.
      onOpenMidiImport(window.xleth?.getDroppedFilePath?.(midiFile) || midiFile.path || midiFile.name)
    }
  }, [onOpenMidiImport])

  return (
    <div
      className="app"
      onDragOver={handleAppDragOver}
      onDrop={handleAppDrop}
    >
      <TitleBar
        projectName={projectName}
        onAction={handleMenuAction}
        activeMenuLabel={showSettings ? 'Settings' : null}
      />

      {/* One shell, always mounted. The sample picker is a sheet inside it
          (windowing/components/PickerSheet), so the arrangement stays visible. */}
      <div className="app-body" style={{ position: 'relative' }}>
        <XlethRootContext.Provider value={rootContextValue}>
          <AppShell />
        </XlethRootContext.Provider>
      </div>

      <HintBar />

      <RenderDialog
        isOpen={renderDialogOpen}
        onClose={() => setRenderDialogOpen(false)}
        destinationHint={renderDialogHint}
        requestNonce={renderDialogRequestNonce}
        projectName={projectName}
      />
      <ExportZipDialog isOpen={exportZipOpen} onClose={() => setExportZipOpen(false)} />
      <MidiImportDialog
        isOpen={midiImportOpen}
        initialFilePath={midiInitialPath}
        onClose={() => { setMidiImportOpen(false); setMidiInitialPath(null) }}
      />
      {missingPlugins && missingPlugins.length > 0 && (
        <MissingPluginsDialog
          plugins={missingPlugins}
          onClose={() => setMissingPlugins(null)}
        />
      )}
      <PluginLoadingDialog />
      {missingMedia && missingMedia.length > 0 && (
        <MissingMediaDialog
          media={missingMedia}
          onClose={() => setMissingMedia(null)}
        />
      )}
      {showSettings && (
        <SettingsPanel
          initialCategory={settingsInitialCategory}
          onClose={() => setShowSettings(false)}
        />
      )}
      <UpdateBanner />
    </div>
  )
}
