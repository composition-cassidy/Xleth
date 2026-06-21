import { useEffect, useState, useCallback, useMemo } from 'react'
import { timelineEvents } from './timelineEvents.js'
import TitleBar from './components/TitleBar.jsx'
import TransportBar from './components/TransportBar.jsx'
import SamplePicker from './components/SamplePicker/SamplePicker.jsx'
import ExportDialog from './components/ExportDialog.jsx'
import ExportZipDialog from './components/ExportZipDialog.jsx'
import MidiImportDialog from './components/MidiImport/MidiImportDialog.jsx'
import VideoExportDialog from './components/VideoExportDialog.jsx'
import useSamplerPanelStore from './stores/samplerPanelStore.js'
import SettingsPanel from './components/SettingsPanel.jsx'
import MissingPluginsDialog from './components/MissingPluginsDialog.jsx'
import MissingMediaDialog from './components/MissingMediaDialog.jsx'
import DevThemeSwitcher from './components/debug/DevThemeSwitcher.jsx'
import { ToastProvider, useToast } from './components/Toast.jsx'
import UpdateBanner from './components/UpdateBanner.jsx'
import { showUnsavedChangesDialog } from './components/UnsavedChangesDialog.jsx'
import usePianoRollStore from './stores/usePianoRollStore.js'
import useWorldProcessingStore from './stores/worldProcessingStore.js'
import AppShell from './windowing/AppShell.tsx'
import XlethRootContext from './windowing/contexts/XlethRootContext.jsx'
import { usePanelRegistry } from './windowing/registry/PanelRegistry'
import { runEditorCommand } from './windowing/managers/EditorCommandRegistry'
import { ElectronAdapter } from './windowing/managers/StatePersistence'
import * as StatePersistence from './windowing/managers/StatePersistence'

const EXPORT_AUDIO_LABEL = 'Export Audio…'
const EXPORT_VIDEO_LABEL = 'Export Video…'
const EXPORT_ZIP_LABEL = 'Export as ZIP…'
const ZOOM_IN_LABEL = 'Zoom In'
const ZOOM_OUT_LABEL = 'Zoom Out'
const RESET_ZOOM_LABEL = 'Reset Zoom'
export const ROOT_APP_SHELL_MODE = 'production'

function sourceNameFromPath(filePath) {
  return String(filePath || '').replace(/^.*[\\/]/, '') || 'source'
}

function assertImportedSourceId(sourceId) {
  if (!Number.isFinite(sourceId) || sourceId < 0) {
    throw new Error('Engine rejected the media file.')
  }
  return sourceId
}

export function getWorkspaceBackdropClassName(mode) {
  if (mode === 'native-acrylic') return 'xleth-backdrop-native-acrylic'
  if (mode === 'image') return 'xleth-backdrop-image'
  if (mode === 'video') return 'xleth-backdrop-video'
  return 'xleth-backdrop-off'
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
async function saveCurrentProject(showToast, setProjectName) {
  const xl = window.xleth
  try {
    const hasDir = await xl.project.hasProjectDir()
    if (!hasDir) {
      const dir = await xl.project.openSaveAsDialog()
      if (!dir) return 'cancelled'
      const name = dir.split(/[\\/]/).pop() || 'Untitled'
      const ok = await xl.project.saveAs(dir, name)
      if (ok) {
        setProjectName(name)
        return true
      }
      showToast?.('Save failed - could not write to the chosen folder.', 'error')
      return false
    }
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
    panelRegistry.getState().applyPreset('fl-compose')
  }
  return hydrated
}

export function getFileMenuShortcutLabel(e) {
  const target = e.target
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return null

  const ctrl = e.ctrlKey || e.metaKey
  if (!ctrl) return null

  const key = e.key.toLowerCase()
  if (key === 'n' && !e.shiftKey && !e.altKey) return 'New Project'
  if (key === 'o' && !e.shiftKey && !e.altKey) return 'Open Project'
  if (key === 's' && e.shiftKey && !e.altKey) return 'Save As...'
  if (key === 's' && !e.shiftKey && !e.altKey) return 'Save'
  if (key === 'i' && !e.shiftKey && !e.altKey) return 'Import Source'
  if (key === 'e' && e.shiftKey && !e.altKey) return EXPORT_VIDEO_LABEL
  if (key === 'e' && !e.shiftKey && !e.altKey) return EXPORT_AUDIO_LABEL
  if ((key === '=' || key === '+') && !e.altKey) return ZOOM_IN_LABEL
  if ((key === '-' || key === '_') && !e.altKey) return ZOOM_OUT_LABEL
  if (key === '0' && !e.shiftKey && !e.altKey) return RESET_ZOOM_LABEL
  return null
}

export async function handleXlethRootMenuAction(label, {
  xl = window.xleth,
  showToast,
  setProjectName,
  setExportDialogOpen,
  setVideoExportDialogOpen,
  setActiveSampleId,
  setPickerSource,
  setCurrentPatternIdByTrack,
  setAllPatterns,
  setMissingPlugins,
  setMissingMedia,
  setExportZipOpen,
  setShowSettings,
  setSettingsInitialCategory,
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
          const result = await saveCurrentProject(showToast, setProjectName)
          if (result === 'cancelled') return
          if (result !== true) return
        }
      }

      const res = await xl.project.newBlank?.()
      if (!res || !res.ok) {
        showToast?.(`New Project failed: ${res?.error || 'unknown error'}`, 'error')
        return
      }

      setProjectName?.('Untitled Project')

      const pianoRollStore = usePianoRollStore.getState()
      pianoRollStore.setPatternId(null)
      pianoRollStore.setDetached(false)
      pianoRollStore.setActiveCenterTab('timeline')
      usePanelRegistry.getState().closePanel('pianoRoll')

      useSamplerPanelStore.getState().setRegionId(null)
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
      const dir = await xl.project.openProjectDialog()
      if (!dir) return
      await xl.project.load(dir)
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
      const result = await saveCurrentProject(showToast, setProjectName)
      if (result === true) showToast?.('Project saved.', 'success')
      break
    }
    case 'Save As...': {
      const dir = await xl.project.openSaveAsDialog()
      if (!dir) return
      const name = dir.split(/[\\/]/).pop() || 'Untitled'
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
      const files = await xl.project.openImportDialog()
      if (!files) return
      let importedCount = 0
      for (const filePath of files) {
        try {
          assertImportedSourceId(await xl.project.importSource(filePath))
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
      setExportDialogOpen?.(true)
      break
    case EXPORT_VIDEO_LABEL:
      setVideoExportDialogOpen?.(true)
      break
    case EXPORT_ZIP_LABEL:
      setExportZipOpen?.(true)
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
      await xl.undo.undo()
      break
    case 'Redo':
      await xl.undo.redo()
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

export default function XlethRoot() {
  return (
    <ToastProvider>
      <XlethRootInner />
    </ToastProvider>
  )
}

function XlethRootInner() {
  const { showToast } = useToast()
  const [workspaceBackdropMode, setWorkspaceBackdropMode] = useState(() => (
    ['native-acrylic', 'image', 'video'].includes(window.xleth?.backdrop?.current?.mode)
      ? window.xleth.backdrop.current.mode
      : 'off'
  ))
  const [workspaceBackdropImageUrl, setWorkspaceBackdropImageUrl] = useState(() => (
    window.xleth?.backdrop?.current?.mode === 'image'
      ? window.xleth.backdrop.current.imageUrl || ''
      : ''
  ))

  // TODO: lift to Zustand in 6d. These root-owned UI selections still bridge
  // the production windowing wrappers with the legacy app components.
  const [pickerSource, setPickerSource] = useState(null)
  const [activeSampleId, setActiveSampleId] = useState(null)
  const [currentPatternIdByTrack, setCurrentPatternIdByTrack] = useState({})
  const [allPatterns, setAllPatterns] = useState({})

  const [projectName, setProjectName] = useState('Untitled Project')
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [videoExportDialogOpen, setVideoExportDialogOpen] = useState(false)
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

  useEffect(() => {
    const applyBackdropState = (state) => {
      const mode = ['native-acrylic', 'image', 'video'].includes(state?.mode) ? state.mode : 'off'
      setWorkspaceBackdropMode(mode)
      setWorkspaceBackdropImageUrl(mode === 'image' ? state?.imageUrl || '' : '')
      document.documentElement.setAttribute('data-xleth-backdrop', mode)
    }

    applyBackdropState(window.xleth?.backdrop?.current)
    window.xleth?.backdrop?.getState?.()
      .then(applyBackdropState)
      .catch((e) => console.warn('[XlethRoot] backdrop state failed:', e?.message || e))

    return window.xleth?.backdrop?.onModeChanged?.(applyBackdropState)
  }, [])

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
      useSamplerPanelStore.getState().setRegionId(regionId)
      usePanelRegistry.getState().openPanel('sampler')
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

  const handleMenuAction = useCallback(async (label) => {
    await handleXlethRootMenuAction(label, {
      showToast,
      setProjectName,
      setExportDialogOpen,
      setVideoExportDialogOpen,
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
  }, [showToast])

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
    activeSampleId,
    setActiveSampleId,
    currentPatternIdByTrack,
    setCurrentPatternIdByTrack,
    activeCenterTab,
    availablePatterns,
    onSwitchPattern: handleSwitchPattern,
    onNewPattern: handleNewPatternFromPianoRoll,
    onOpenMidiImport,
  }), [
    handleOpenPicker,
    activeSampleId,
    currentPatternIdByTrack,
    activeCenterTab,
    availablePatterns,
    handleSwitchPattern,
    handleNewPatternFromPianoRoll,
    onOpenMidiImport,
  ])

  const handleAppDragOver = useCallback((e) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
  }, [])

  const handleAppDrop = useCallback((e) => {
    const files = Array.from(e.dataTransfer.files)
    const midiFile = files.find(f => /\.(mid|midi)$/i.test(f.name))
    if (midiFile) {
      e.preventDefault()
      onOpenMidiImport(midiFile.path || midiFile.name)
    }
  }, [onOpenMidiImport])

  return (
    <div
      className={`app ${getWorkspaceBackdropClassName(workspaceBackdropMode)}`}
      style={{
        '--xleth-workspace-backdrop-image': workspaceBackdropImageUrl
          ? `url("${workspaceBackdropImageUrl.replace(/"/g, '\\"')}")`
          : 'none',
      }}
      onDragOver={handleAppDragOver}
      onDrop={handleAppDrop}
    >
      <TitleBar
        projectName={projectName}
        onAction={handleMenuAction}
        activeMenuLabel={showSettings ? 'Settings' : null}
      />

      <div className="app-body" style={{ position: 'relative' }}>
        {pickerSource && (
          <SamplePicker source={pickerSource} onClose={handleClosePicker} />
        )}

        <div style={{ display: pickerSource ? 'none' : 'contents' }}>
          <XlethRootContext.Provider value={rootContextValue}>
            <AppShell mode={ROOT_APP_SHELL_MODE} backdropImageUrl={workspaceBackdropImageUrl} />
          </XlethRootContext.Provider>
        </div>
      </div>

      <TransportBar />

      <ExportDialog isOpen={exportDialogOpen} onClose={() => setExportDialogOpen(false)} />
      <VideoExportDialog isOpen={videoExportDialogOpen} onClose={() => setVideoExportDialogOpen(false)} />
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
