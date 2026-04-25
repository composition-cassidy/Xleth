import { useEffect, useState, useCallback, useRef } from 'react'
import { timelineEvents } from './timelineEvents.js'
import TitleBar from './components/TitleBar.jsx'
import LeftPanel from './components/LeftPanel.jsx'
import VideoPreview from './components/VideoPreview.jsx'
import TimelineView from './components/TimelineView.jsx'
import PianoRoll from './components/pianoRoll/PianoRoll.jsx'
import TransportBar from './components/TransportBar.jsx'
import ResizablePanel from './components/ResizablePanel.jsx'
import SamplePicker from './components/SamplePicker/SamplePicker.jsx'
import ExportDialog from './components/ExportDialog.jsx'
import VideoExportDialog from './components/VideoExportDialog.jsx'
import SamplerPanel from './components/sampler/SamplerPanel.jsx'
import MixerPanel from './components/mixer/MixerPanel.jsx'
import SettingsPanel from './components/SettingsPanel.jsx'
import MissingPluginsDialog from './components/MissingPluginsDialog.jsx'
import DevThemeSwitcher from './components/debug/DevThemeSwitcher.jsx'
import ThemeEditor from './theming/editor/ThemeEditor'
import { ToastProvider, useToast } from './components/Toast.jsx'
import { showUnsavedChangesDialog } from './components/UnsavedChangesDialog.jsx'
import useGridEditStore from './stores/useGridEditStore.js'
import usePianoRollStore from './stores/usePianoRollStore.js'

const FLOATING_DEFAULT_POS = { x: 120, y: 80 }
const FLOATING_DEFAULT_SIZE = { w: 900, h: 500 }
const FLOATING_MIN_SIZE = { w: 600, h: 400 }

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
      showToast?.('Save failed — could not write to the chosen folder.', 'error')
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

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  )
}

function AppInner() {
  const { showToast } = useToast()
  const [pickerSource, setPickerSource] = useState(null)
  const [activeSampleId, setActiveSampleId] = useState(null)
  const [projectName, setProjectName] = useState('Untitled Project')
  const gridEditMode = useGridEditStore((s) => s.gridEditMode)
  const setGridEditMode = useGridEditStore((s) => s.setGridEditMode)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [videoExportDialogOpen, setVideoExportDialogOpen] = useState(false)
  const pianoRollPatternId = usePianoRollStore((s) => s.patternId)
  const setPianoRollPatternId = usePianoRollStore((s) => s.setPatternId)
  const [samplerPanelRegionId, setSamplerPanelRegionId] = useState(null)
  const [missingPlugins, setMissingPlugins] = useState(null) // null = closed, [] or array = open

  // Tab + detach state
  const [showSettings, setShowSettings] = useState(false)
  const [showThemeEditor, setShowThemeEditor] = useState(false)

  // Tab + detach state
  const activeCenterTab = usePianoRollStore((s) => s.activeCenterTab)
  const setActiveCenterTab = usePianoRollStore((s) => s.setActiveCenterTab)
  const pianoRollDetached = usePianoRollStore((s) => s.detached)
  const setPianoRollDetached = usePianoRollStore((s) => s.setDetached)
  const [floatPos, setFloatPos] = useState(FLOATING_DEFAULT_POS)
  const [floatSize, setFloatSize] = useState(FLOATING_DEFAULT_SIZE)

  // One-time wiring of timelineEvents handlers that own piano-roll state.
  const pianoRollStoreInitialized = useRef(false)
  if (!pianoRollStoreInitialized.current) {
    pianoRollStoreInitialized.current = true
    usePianoRollStore.getState().init()
  }

  // Hoisted: current pattern per pattern-track (client-only state)
  const [currentPatternIdByTrack, setCurrentPatternIdByTrack] = useState({})

  // Patterns list for the PianoRoll dropdown (fetched here, shared)
  const [allPatterns, setAllPatterns] = useState({})

  const fetchAllPatterns = useCallback(async () => {
    try {
      const list = await window.xleth?.timeline?.getAllPatterns()
      if (Array.isArray(list)) {
        const byId = {}
        for (const p of list) byId[p.id] = p
        setAllPatterns(byId)
      }
    } catch (e) {
      console.warn('[App] getAllPatterns failed:', e.message)
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
    const onOpen = (e) => setSamplerPanelRegionId(e.detail?.regionId ?? null)
    const onClose = () => setSamplerPanelRegionId(null)
    timelineEvents.addEventListener('open-sampler-settings', onOpen)
    timelineEvents.addEventListener('close-sampler-settings', onClose)
    return () => {
      timelineEvents.removeEventListener('open-sampler-settings', onOpen)
      timelineEvents.removeEventListener('close-sampler-settings', onClose)
    }
  }, [])

  const handleBackToTimeline = useCallback(() => {
    setActiveCenterTab('timeline')
    timelineEvents.dispatchEvent(new CustomEvent('close-piano-roll'))
  }, [])

  const handleFullyClosePianoRoll = useCallback(() => {
    setPianoRollPatternId(null)
    setPianoRollDetached(false)
    setActiveCenterTab('timeline')
  }, [])

  const handleDetachPianoRoll = useCallback(() => {
    setPianoRollDetached(true)
    setActiveCenterTab('timeline')
  }, [])

  const handleDockPianoRoll = useCallback(() => {
    setPianoRollDetached(false)
    setActiveCenterTab('piano-roll')
  }, [])

  const handleSwitchPattern = useCallback((newPatternId) => {
    if (newPatternId == null || newPatternId < 0) return
    setPianoRollPatternId(newPatternId)
  }, [])

  const handleNewPatternFromPianoRoll = useCallback(async () => {
    const current = allPatterns[pianoRollPatternId]
    if (!current) return
    // Pattern tracks are sample-agnostic now, but each pattern still owns one
    // regionId. Seed the new pattern's regionId from the currently-open
    // pattern (piano-roll context).
    const regionId = current.regionId
    // Auto-name: "Pattern N" (unique across ALL patterns — flat global list)
    const existingNames = new Set(Object.values(allPatterns).map((p) => p.name))
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
        setPianoRollPatternId(newId)
      }
    } catch (e) {
      console.error('[App] addPattern failed:', e)
    }
  }, [allPatterns, pianoRollPatternId])

  const handleOpenPicker = useCallback((source) => {
    console.log(`[App] Opening Sample Picker for source: ${source.name}`)
    setPickerSource(source)
  }, [])

  const handleClosePicker = useCallback(() => {
    console.log('[App] Closing Sample Picker')
    setPickerSource(null)
  }, [])

  const handleCloseSamplerPanel = useCallback(() => {
    setSamplerPanelRegionId(null)
    timelineEvents.dispatchEvent(new CustomEvent('close-sampler-settings'))
  }, [])

  // ── Floating panel drag ──────────────────────────────────────────────────
  const floatDragRef = useRef(null)
  const handleFloatDragStart = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    floatDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: floatPos.x,
      origY: floatPos.y,
    }
    const onMove = (me) => {
      const d = floatDragRef.current
      if (!d) return
      const dx = me.clientX - d.startX
      const dy = me.clientY - d.startY
      // Clamp within app-body; allow a 40px overflow past each edge so users
      // can park the panel near edges or against the transport bar.
      const bodyEl = document.querySelector('.app-body')
      const rect = bodyEl?.getBoundingClientRect()
      const overflow = 40
      const maxX = rect ? Math.max(-overflow, rect.width - floatSize.w + overflow) : 9999
      const maxY = rect ? Math.max(-overflow, rect.height - floatSize.h + overflow) : 9999
      setFloatPos({
        x: Math.max(-overflow, Math.min(maxX, d.origX + dx)),
        y: Math.max(-overflow, Math.min(maxY, d.origY + dy)),
      })
    }
    const onUp = () => {
      floatDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [floatPos.x, floatPos.y, floatSize.w, floatSize.h])

  // ── Floating panel resize (bottom-right grip) ───────────────────────────
  const floatResizeRef = useRef(null)
  const handleFloatResizeStart = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    floatResizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origW: floatSize.w,
      origH: floatSize.h,
    }
    const onMove = (me) => {
      const d = floatResizeRef.current
      if (!d) return
      const dw = me.clientX - d.startX
      const dh = me.clientY - d.startY
      const bodyEl = document.querySelector('.app-body')
      const rect = bodyEl?.getBoundingClientRect()
      const maxW = rect ? Math.max(FLOATING_MIN_SIZE.w, rect.width - floatPos.x + 40) : 4000
      const maxH = rect ? Math.max(FLOATING_MIN_SIZE.h, rect.height - floatPos.y + 40) : 4000
      setFloatSize({
        w: Math.max(FLOATING_MIN_SIZE.w, Math.min(maxW, d.origW + dw)),
        h: Math.max(FLOATING_MIN_SIZE.h, Math.min(maxH, d.origH + dh)),
      })
    }
    const onUp = () => {
      floatResizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [floatSize.w, floatSize.h, floatPos.x, floatPos.y])

  const handleMenuAction = useCallback(async (label) => {
    const xl = window.xleth
    switch (label) {
      case 'New Project': {
        // Guard: can't reset while an export is running.
        try {
          if (await xl.project.isExportRunning?.()) {
            showToast('Cannot start a new project while exporting.', 'error')
            return
          }
        } catch {}

        // Unsaved-changes prompt.
        let dirty = false
        try { dirty = !!(await xl.project.isDirty?.()) } catch {}
        if (dirty) {
          const choice = await showUnsavedChangesDialog()
          if (choice === 'cancel') return
          if (choice === 'save') {
            const result = await saveCurrentProject(showToast, setProjectName)
            if (result === 'cancelled') return
            if (result !== true) return  // save failed — toast already shown
          }
          // 'discard' → fall through and wipe.
        }

        const res = await xl.project.newBlank?.()
        if (!res || !res.ok) {
          showToast(`New Project failed: ${res?.error || 'unknown error'}`, 'error')
          return
        }

        setProjectName('Untitled Project')
        // Close any panels that might hold stale IDs from the cleared project.
        setPianoRollPatternId(null)
        setSamplerPanelRegionId(null)
        setActiveSampleId(null)
        setPickerSource(null)
        setCurrentPatternIdByTrack({})
        setAllPatterns({})

        // Notify panels to refresh — same events as project load.
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
        console.log(`[Project] Loading project from: ${dir}`)
        await xl.project.load(dir)
        const info = await xl.project.getInfo()
        setProjectName(info?.projectName || dir.split(/[\\/]/).pop() || 'Project')
        // Notify all panels to refetch — project load replaces all timeline data
        timelineEvents.dispatchEvent(new Event('timeline-sources-changed'))
        timelineEvents.dispatchEvent(new Event('timeline-regions-changed'))
        timelineEvents.dispatchEvent(new Event('timeline-clips-changed'))
        timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
        timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
        // Show missing-plugins dialog if any plugins could not be loaded
        try {
          const rawMissing = await xl.audio?.getMissingPlugins?.()
          if (rawMissing) {
            const parsed = JSON.parse(rawMissing)
            if (Array.isArray(parsed) && parsed.length > 0)
              setMissingPlugins(parsed)
          }
        } catch (e) {
          console.warn('[Project] getMissingPlugins error:', e)
        }
        break
      }
      case 'Save': {
        const result = await saveCurrentProject(showToast, setProjectName)
        if (result === true) showToast('Project saved.', 'success')
        break
      }
      case 'Save As...': {
        const dir = await xl.project.openSaveAsDialog()
        if (!dir) return
        const name = dir.split(/[\\/]/).pop() || 'Untitled'
        const ok = await xl.project.saveAs(dir, name)
        if (ok) {
          setProjectName(name)
          showToast('Project saved.', 'success')
        } else {
          showToast('Save As failed — could not write to the chosen folder.', 'error')
        }
        break
      }
      case 'Import Source': {
        const files = await xl.project.openImportDialog()
        if (!files) return
        for (const f of files) {
          console.log(`[Project] Importing source: ${f}`)
          await xl.project.importSource(f)
        }
        timelineEvents.dispatchEvent(new Event('timeline-sources-changed'))
        break
      }
      case 'Export Audio…':
        setExportDialogOpen(true)
        break
      case 'Export Video…':
        setVideoExportDialogOpen(true)
        break
      case 'Undo':
        await xl.undo.undo()
        break
      case 'Redo':
        await xl.undo.redo()
        break
      case 'Exit':
        xl.window.close()
        break
      case 'Settings':
        setShowSettings(true)
        break
      case 'Theme Editor':
        setShowThemeEditor(true)
        break
      default:
        break
    }
  }, [])

  useEffect(() => {
    console.log('[UI] App mounted')
  }, [])

  // ── Global keyboard shortcuts for the File menu ────────────────────────────
  // These mirror the shortcuts shown in the TitleBar File menu so users can
  // trigger them from anywhere in the app without opening the menu first.
  useEffect(() => {
    const onKeyDown = (e) => {
      // Don't intercept while the user is typing into an input/textarea/contentEditable
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return

      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl) return

      const key = e.key.toLowerCase()
      let label = null

      if (key === 'n' && !e.shiftKey && !e.altKey) label = 'New Project'
      else if (key === 'o' && !e.shiftKey && !e.altKey) label = 'Open Project'
      else if (key === 's' && e.shiftKey && !e.altKey) label = 'Save As...'
      else if (key === 's' && !e.shiftKey && !e.altKey) label = 'Save'
      else if (key === 'i' && !e.shiftKey && !e.altKey) label = 'Import Source'
      else if (key === 'e' && e.shiftKey && !e.altKey) label = 'Export Video…'
      else if (key === 'e' && !e.shiftKey && !e.altKey) label = 'Export Audio…'

      if (label) {
        e.preventDefault()
        e.stopPropagation()
        console.log(`[Keyboard] File menu shortcut → ${label}`)
        handleMenuAction(label)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleMenuAction])

  // Derived: patterns filtered by the current piano-roll pattern's region
  const currentPattern = pianoRollPatternId != null ? allPatterns[pianoRollPatternId] : null
  const availablePatterns = currentPattern
    ? Object.values(allPatterns).filter((p) => p.regionId === currentPattern.regionId)
    : []
  const patternName = currentPattern?.name || ''

  const showPianoRollInTab = pianoRollPatternId != null && !pianoRollDetached
  const showPianoRollFloating = pianoRollPatternId != null && pianoRollDetached

  const tabLabel = pianoRollDetached
    ? 'Piano Roll (detached)'
    : (patternName ? `Piano Roll: ${patternName}` : 'Piano Roll')

  return (
    <div className="app">
      <TitleBar projectName={projectName} onAction={handleMenuAction} />

      <div className="app-body" style={{ position: 'relative' }}>
        <ResizablePanel left={<LeftPanel onOpenPicker={handleOpenPicker} activeSampleId={activeSampleId} setActiveSampleId={setActiveSampleId} />}>
          <div className="center-area">
            {/* SamplePicker: conditionally mounted (unmounts on close) */}
            {pickerSource && (
              <SamplePicker source={pickerSource} onClose={handleClosePicker} />
            )}

            {/* Timeline subtree: always mounted, hidden while picker is open */}
            <div style={{ display: pickerSource ? 'none' : 'contents' }}>
              <VideoPreview />
              {/* Center tabs */}
              <div className="center-tabs">
                <button
                  className={`center-tab ${activeCenterTab === 'timeline' ? 'active' : ''}`}
                  onClick={() => setActiveCenterTab('timeline')}
                >
                  Timeline
                </button>
                {pianoRollPatternId != null && (
                  <button
                    className={`center-tab ${activeCenterTab === 'piano-roll' ? 'active' : ''} ${pianoRollDetached ? 'center-tab--detached' : ''}`}
                    onClick={() => {
                      if (pianoRollDetached) handleDockPianoRoll()
                      else setActiveCenterTab('piano-roll')
                    }}
                    title={pianoRollDetached ? 'Click to dock' : ''}
                  >
                    <span>{tabLabel}</span>
                    <span
                      className="center-tab-close"
                      title="Close pattern"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        handleFullyClosePianoRoll()
                      }}
                    >✕</span>
                  </button>
                )}
              </div>
              <div className="center-area-body">
                <div
                  className="center-panel-slot"
                  style={{ display: activeCenterTab === 'timeline' ? 'flex' : 'none' }}
                >
                  <TimelineView
                    activeSampleId={activeSampleId}
                    currentPatternIdByTrack={currentPatternIdByTrack}
                    setCurrentPatternIdByTrack={setCurrentPatternIdByTrack}
                    activeCenterTab={activeCenterTab}
                  />
                </div>
                {showPianoRollInTab && (
                  <div
                    className="center-panel-slot"
                    style={{ display: activeCenterTab === 'piano-roll' ? 'flex' : 'none' }}
                  >
                    <PianoRoll
                      patternId={pianoRollPatternId}
                      onClose={handleBackToTimeline}
                      onDetach={handleDetachPianoRoll}
                      availablePatterns={availablePatterns}
                      currentPatternId={pianoRollPatternId}
                      onSwitchPattern={handleSwitchPattern}
                      onNewPattern={handleNewPatternFromPianoRoll}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </ResizablePanel>

        {/* Floating piano roll card */}
        {showPianoRollFloating && (
          <div
            className="piano-roll-floating"
            style={{
              position: 'absolute',
              top: floatPos.y,
              left: floatPos.x,
              width: floatSize.w,
              height: floatSize.h,
              zIndex: 8,
            }}
          >
            <PianoRoll
              patternId={pianoRollPatternId}
              onClose={handleFullyClosePianoRoll}
              onDock={handleDockPianoRoll}
              floating
              onTitleMouseDown={handleFloatDragStart}
              onTitleDoubleClick={handleDockPianoRoll}
              availablePatterns={availablePatterns}
              currentPatternId={pianoRollPatternId}
              onSwitchPattern={handleSwitchPattern}
              onNewPattern={handleNewPatternFromPianoRoll}
            />
            <div
              className="piano-roll-floating-resize-grip"
              onMouseDown={handleFloatResizeStart}
              title="Resize"
            />
          </div>
        )}

        {samplerPanelRegionId != null && (
          <SamplerPanel regionId={samplerPanelRegionId} onClose={handleCloseSamplerPanel} />
        )}
      </div>

      <MixerPanel />
      <TransportBar />

      <ExportDialog isOpen={exportDialogOpen} onClose={() => setExportDialogOpen(false)} />
      <VideoExportDialog isOpen={videoExportDialogOpen} onClose={() => setVideoExportDialogOpen(false)} />
      {missingPlugins && missingPlugins.length > 0 && (
        <MissingPluginsDialog
          plugins={missingPlugins}
          onClose={() => setMissingPlugins(null)}
        />
      )}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showThemeEditor && <ThemeEditor onClose={() => setShowThemeEditor(false)} />}
      {import.meta.env.DEV && <DevThemeSwitcher />}
    </div>
  )
}
