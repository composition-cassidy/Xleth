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

const FLOATING_DEFAULT_POS = { x: 120, y: 80 }
const FLOATING_DEFAULT_SIZE = { w: 900, h: 500 }
const FLOATING_MIN_SIZE = { w: 600, h: 400 }

export default function App() {
  const [pickerSource, setPickerSource] = useState(null)
  const [activeSampleId, setActiveSampleId] = useState(null)
  const [projectName, setProjectName] = useState('Untitled Project')
  const [gridEditMode, setGridEditMode] = useState(false)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [videoExportDialogOpen, setVideoExportDialogOpen] = useState(false)
  const [pianoRollPatternId, setPianoRollPatternId] = useState(null)
  const [samplerPanelRegionId, setSamplerPanelRegionId] = useState(null)

  // Tab + detach state
  const [showSettings, setShowSettings] = useState(false)

  // Tab + detach state
  const [activeCenterTab, setActiveCenterTab] = useState('timeline') // 'timeline' | 'piano-roll'
  const [pianoRollDetached, setPianoRollDetached] = useState(false)
  const [floatPos, setFloatPos] = useState(FLOATING_DEFAULT_POS)
  const [floatSize, setFloatSize] = useState(FLOATING_DEFAULT_SIZE)

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

  // Ref mirror of pianoRollDetached so the event listener below can read the
  // latest value without re-binding each time the flag changes.
  const pianoRollDetachedRef = useRef(pianoRollDetached)
  useEffect(() => { pianoRollDetachedRef.current = pianoRollDetached }, [pianoRollDetached])

  useEffect(() => {
    const onOpen = (e) => {
      const pid = e.detail?.patternId ?? null
      setPianoRollPatternId(pid)
      // When the Piano Roll is floating, update its pattern but keep the
      // main window's tab on Timeline — don't yank the user away.
      if (pid != null && !pianoRollDetachedRef.current) setActiveCenterTab('piano-roll')
    }
    const onClose = () => {
      // "Back to Timeline" — keep patternId, switch tab
      setActiveCenterTab('timeline')
    }
    timelineEvents.addEventListener('open-piano-roll', onOpen)
    timelineEvents.addEventListener('close-piano-roll', onClose)
    return () => {
      timelineEvents.removeEventListener('open-piano-roll', onOpen)
      timelineEvents.removeEventListener('close-piano-roll', onClose)
    }
  }, [])

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

  // Detach / dock events from PianoRollToolbar
  useEffect(() => {
    const onDetach = () => { setPianoRollDetached(true); setActiveCenterTab('timeline') }
    const onDock = () => { setPianoRollDetached(false); setActiveCenterTab('piano-roll') }
    timelineEvents.addEventListener('piano-roll-detach', onDetach)
    timelineEvents.addEventListener('piano-roll-dock', onDock)
    return () => {
      timelineEvents.removeEventListener('piano-roll-detach', onDetach)
      timelineEvents.removeEventListener('piano-roll-dock', onDock)
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
        const dir = await xl.project.openNewProjectDialog()
        if (!dir) return
        const name = dir.split(/[\\/]/).pop() || 'Untitled'
        console.log(`[Project] Creating new project: ${name} in ${dir}`)
        await xl.project.create(dir, name)
        setProjectName(name)
        // Notify panels to refresh
        timelineEvents.dispatchEvent(new Event('timeline-sources-changed'))
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
        break
      }
      case 'Save': {
        const hasDir = await xl.project.hasProjectDir()
        if (!hasDir) {
          // No project directory yet — fall through to Save As
          console.log('[Project] No project dir set — opening Save As dialog')
          const dir = await xl.project.openSaveAsDialog()
          if (!dir) return
          const name = dir.split(/[\\/]/).pop() || 'Untitled'
          const ok = await xl.project.saveAs(dir, name)
          if (ok) {
            setProjectName(name)
            console.log(`[Project] Saved to new location: ${dir}`)
          } else {
            console.error('[Project] Save As failed')
          }
          break
        }
        console.log('[Project] Saving project...')
        const ok = await xl.project.save()
        console.log(ok ? '[Project] Saved' : '[Project] Save FAILED')
        break
      }
      case 'Save As...': {
        const dir = await xl.project.openSaveAsDialog()
        if (!dir) return
        const name = dir.split(/[\\/]/).pop() || 'Untitled'
        console.log(`[Project] Saving project as: ${name} in ${dir}`)
        const ok = await xl.project.saveAs(dir, name)
        if (ok) {
          setProjectName(name)
          console.log('[Project] Saved As')
        } else {
          console.error('[Project] Save As FAILED')
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
        <ResizablePanel left={<LeftPanel onOpenPicker={handleOpenPicker} activeSampleId={activeSampleId} setActiveSampleId={setActiveSampleId} gridEditMode={gridEditMode} setGridEditMode={setGridEditMode} />}>
          <div className="center-area">
            {pickerSource ? (
              <SamplePicker source={pickerSource} onClose={handleClosePicker} />
            ) : (
              <>
                <VideoPreview gridEditMode={gridEditMode} setGridEditMode={setGridEditMode} />
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
                        activeCenterTab={activeCenterTab}
                      />
                    </div>
                  )}
                </div>
              </>
            )}
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
              activeCenterTab={activeCenterTab}
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
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  )
}
