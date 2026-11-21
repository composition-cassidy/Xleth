import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getFileMenuShortcutLabel,
  handleXlethRootMenuAction,
  hydrateProductionLayout,
} from './XlethRoot.jsx'
import { timelineEvents } from './timelineEvents.js'
import {
  RESET_LAYOUT_ID,
  TITLEBAR_MENUS,
  applyLayoutChoice,
  isDirectTitlebarMenu,
} from './components/TitleBar.jsx'
import { LAYOUT_PRESETS } from './windowing/managers/PresetManager'
import usePianoRollStore from './stores/usePianoRollStore.js'
import { createInitialPanelStates, usePanelRegistry } from './windowing/registry/PanelRegistry'
import * as EditorCommandRegistry from './windowing/managers/EditorCommandRegistry'
import * as StatePersistence from './windowing/managers/StatePersistence'

// The real dialog mounts into document.body; this suite runs in node. The
// dialog itself is covered by CleanupProjectDialog.test.jsx.
const cleanupDialogChoice = vi.hoisted(() => ({ value: true }))
vi.mock('./components/CleanupProjectDialog.jsx', () => ({
  default: () => null,
  showCleanupProjectDialog: vi.fn(async () => cleanupDialogChoice.value),
}))

// Motion view persistence hooks: record the order against the project calls.
const motionCalls = vi.hoisted(() => ({ log: [] }))
vi.mock('./components/motionView/motionViewSession.js', async (importOriginal) => ({
  ...(await importOriginal()),
  beforeMotionViewProjectSwitch: vi.fn(async () => { motionCalls.log.push('beforeSwitch'); return false }),
  cancelMotionViewProjectSwitch: vi.fn(() => { motionCalls.log.push('cancelSwitch') }),
  flushMotionViewState: vi.fn(async () => { motionCalls.log.push('flush'); return false }),
}))

describe('XlethRoot Motion view persistence around project switch / save', () => {
  function xlLogged(overrides = {}) {
    const log = motionCalls.log
    const rec = (name, value) => vi.fn(async (...args) => { log.push(`${name}(${args.join(',')})`); return value })
    return {
      project: {
        hasProjectDir: vi.fn().mockResolvedValue(true),
        save: rec('save', true),
        saveAs: rec('saveAs', true),
        openSaveAsDialog: vi.fn().mockResolvedValue(null),
        openProjectDialog: vi.fn().mockResolvedValue(null),
        getInfo: vi.fn().mockResolvedValue({ projectName: 'Next' }),
        isDirty: vi.fn().mockResolvedValue(false),
        isExportRunning: vi.fn().mockResolvedValue(false),
        switchToNew: rec('switchToNew', { ok: true }),
        switchToLoad: rec('switchToLoad', true),
        takeLastPurge: vi.fn().mockResolvedValue(null),
        validateMedia: vi.fn().mockResolvedValue([]),
        ...overrides,
      },
      audio: { getMissingPlugins: vi.fn().mockResolvedValue(null) },
    }
  }

  beforeEach(() => { motionCalls.log.length = 0 })

  it('New Project: holds Motion view pushes right before switchToNew', async () => {
    await handleXlethRootMenuAction('New Project', { xl: xlLogged(), showToast: vi.fn(), setProjectName: vi.fn() })
    expect(motionCalls.log).toEqual(['beforeSwitch', 'switchToNew()'])
  })

  it('New Project failure (not ok, or a throw) cancels the hold', async () => {
    const showToast = vi.fn()
    await handleXlethRootMenuAction('New Project', {
      xl: xlLogged({ switchToNew: vi.fn(async () => ({ ok: false, error: 'busy' })) }), showToast, setProjectName: vi.fn(),
    })
    expect(motionCalls.log).toEqual(['beforeSwitch', 'cancelSwitch'])
    expect(showToast).toHaveBeenCalledWith('New Project failed: busy', 'error')
    motionCalls.log.length = 0
    await expect(handleXlethRootMenuAction('New Project', {
      xl: xlLogged({ switchToNew: vi.fn(async () => { throw new Error('ipc down') }) }), showToast, setProjectName: vi.fn(),
    })).rejects.toThrow('ipc down')
    expect(motionCalls.log).toEqual(['beforeSwitch', 'cancelSwitch'])
  })

  it('Open Project: holds before switchToLoad(dir); a failed load or a throw cancels', async () => {
    const openFilePicker = vi.fn().mockResolvedValue({ path: 'C:\\P\\Next' })
    await handleXlethRootMenuAction('Open Project', { xl: xlLogged(), showToast: vi.fn(), setProjectName: vi.fn(), openFilePicker })
    expect(motionCalls.log).toEqual(['beforeSwitch', 'switchToLoad(C:\\P\\Next)'])
    motionCalls.log.length = 0
    await handleXlethRootMenuAction('Open Project', {
      xl: xlLogged({ switchToLoad: vi.fn(async () => false) }), showToast: vi.fn(), setProjectName: vi.fn(), openFilePicker,
    })
    expect(motionCalls.log).toEqual(['beforeSwitch', 'cancelSwitch'])
    motionCalls.log.length = 0
    await expect(handleXlethRootMenuAction('Open Project', {
      xl: xlLogged({ switchToLoad: vi.fn(async () => { throw new Error('gone') }) }), showToast: vi.fn(), setProjectName: vi.fn(), openFilePicker,
    })).rejects.toThrow('gone')
    expect(motionCalls.log).toEqual(['beforeSwitch', 'cancelSwitch'])
  })

  it('Save and Save As flush the Motion view state first', async () => {
    // Save goes through saveCurrentProject, which reads window.xleth.
    const saveXl = xlLogged()
    vi.stubGlobal('window', { xleth: saveXl })
    try {
      await handleXlethRootMenuAction('Save', { xl: saveXl, showToast: vi.fn(), setProjectName: vi.fn() })
      expect(motionCalls.log).toEqual(['flush', 'save()'])
      motionCalls.log.length = 0
      // Save with no project folder yet goes through Save As: flush first too.
      const firstXl = xlLogged({ hasProjectDir: vi.fn().mockResolvedValue(false) })
      vi.stubGlobal('window', { xleth: firstXl })
      await handleXlethRootMenuAction('Save', {
        xl: firstXl, showToast: vi.fn(), setProjectName: vi.fn(),
        openFilePicker: vi.fn().mockResolvedValue({ path: 'C:\\P\\First' }),
      })
      expect(motionCalls.log).toEqual(['flush', 'saveAs(C:\\P\\First,First)'])
    } finally {
      vi.unstubAllGlobals()
    }
    motionCalls.log.length = 0
    await handleXlethRootMenuAction('Save As...', {
      xl: xlLogged(), showToast: vi.fn(), setProjectName: vi.fn(),
      openFilePicker: vi.fn().mockResolvedValue({ path: 'C:\\P\\Copy' }),
    })
    expect(motionCalls.log).toEqual(['flush', 'saveAs(C:\\P\\Copy,Copy)'])
  })
})

describe('XlethRoot New Project reset', () => {
  let newBlankMock
  let showToast

  beforeEach(() => {
    vi.restoreAllMocks()
    usePanelRegistry.setState({ panels: createInitialPanelStates() })
    usePanelRegistry.getState().openPanel('pianoRoll')
    usePianoRollStore.setState({
      patternId: 42,
      activeCenterTab: 'piano-roll',
      detached: true,
    })

    newBlankMock = vi.fn().mockResolvedValue({ ok: true })
    showToast = vi.fn()
  })

  function makeXleth() {
    return {
      project: {
        hasProjectDir: vi.fn().mockResolvedValue(false),
        save: vi.fn().mockResolvedValue(true),
        saveAs: vi.fn().mockResolvedValue(true),
        openSaveAsDialog: vi.fn().mockResolvedValue(null),
        openProjectDialog: vi.fn().mockResolvedValue(null),
        openImportDialog: vi.fn().mockResolvedValue(null),
        importSource: vi.fn().mockResolvedValue(true),
        prepareImport: vi.fn(async (p) => p),
        getInfo: vi.fn().mockResolvedValue(null),
        load: vi.fn().mockResolvedValue(true),
        isDirty: vi.fn().mockResolvedValue(false),
        isExportRunning: vi.fn().mockResolvedValue(false),
        newBlank: vi.fn().mockResolvedValue({ ok: true }),
        switchToNew: newBlankMock,
        switchToLoad: vi.fn().mockResolvedValue(true),
        takeLastPurge: vi.fn().mockResolvedValue(null),
        cleanupScan: vi.fn().mockResolvedValue({
          hasProject: true,
          willFree: { files: 2, bytes: 2048, categories: [] },
          kept: { files: 0, bytes: 0, items: [] },
          partialsSkipped: false,
        }),
        cleanupRun: vi.fn().mockResolvedValue({ ok: true, freedBytes: 2048, filesRemoved: 2, filesFailed: 0 }),
      },
      timeline: {
        getAllPatterns: vi.fn().mockResolvedValue([]),
      },
      undo: {
        undo: vi.fn().mockResolvedValue(undefined),
        redo: vi.fn().mockResolvedValue(undefined),
      },
      audio: {
        getMissingPlugins: vi.fn().mockResolvedValue(null),
      },
      window: {
        close: vi.fn(),
        minimize: vi.fn(),
        maximize: vi.fn(),
        zoomIn: vi.fn(),
        zoomOut: vi.fn(),
        resetZoom: vi.fn(),
      },
    }
  }

  it('clears the piano roll store and closes the piano roll panel on New Project', async () => {
    const setProjectName = vi.fn()
    const xl = makeXleth()

    await handleXlethRootMenuAction('New Project', {
      xl,
      showToast,
      setProjectName,
      setSamplerPanelRegionId: vi.fn(),
      setActiveSampleId: vi.fn(),
      setPickerSource: vi.fn(),
      setCurrentPatternIdByTrack: vi.fn(),
      setAllPatterns: vi.fn(),
      setMissingPlugins: vi.fn(),
    })

    expect(newBlankMock).toHaveBeenCalledTimes(1)
    expect(setProjectName).toHaveBeenCalledWith('Untitled Project')
    expect(usePianoRollStore.getState().patternId).toBeNull()
    expect(usePianoRollStore.getState().detached).toBe(false)
    expect(usePianoRollStore.getState().activeCenterTab).toBe('timeline')
    expect(usePanelRegistry.getState().panels.pianoRoll.hidden).toBe(true)
  })

  it('reports what purge-on-close freed after New Project and Open Project', async () => {
    const purge = { freedBytes: 5 * 1024 * 1024 * 1024, filesRemoved: 12, filesFailed: 0 }

    const xlNew = makeXleth()
    xlNew.project.takeLastPurge.mockResolvedValue(purge)
    await handleXlethRootMenuAction('New Project', { xl: xlNew, showToast, setProjectName: vi.fn() })
    expect(xlNew.project.takeLastPurge).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith(
      'Freed 5 GB of regenerable files from the previous project.', 'success')

    showToast.mockClear()
    const xlOpen = makeXleth()
    xlOpen.project.takeLastPurge.mockResolvedValue(purge)
    await handleXlethRootMenuAction('Open Project', {
      xl: xlOpen,
      showToast,
      setProjectName: vi.fn(),
      openFilePicker: vi.fn().mockResolvedValue({ path: 'C:\\Projects\\Next' }),
    })
    expect(xlOpen.project.switchToLoad).toHaveBeenCalledWith('C:\\Projects\\Next')
    expect(xlOpen.project.takeLastPurge).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith(
      'Freed 5 GB of regenerable files from the previous project.', 'success')
  })

  it('says nothing after a project switch when purge-on-close freed nothing', async () => {
    const xl = makeXleth()                     // takeLastPurge → null (setting off)
    await handleXlethRootMenuAction('New Project', { xl, showToast, setProjectName: vi.fn() })
    expect(xl.project.takeLastPurge).toHaveBeenCalledTimes(1)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('routes the File > Clean up project menu item: scan, confirm, then delete', async () => {
    cleanupDialogChoice.value = true
    const xl = makeXleth()
    await handleXlethRootMenuAction('Clean up project…', { xl, showToast })
    expect(xl.project.cleanupScan).toHaveBeenCalledTimes(1)
    expect(xl.project.cleanupRun).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('Freed 2 KB (2 files).', 'success')
  })

  it('does not delete anything when the Clean up confirmation is declined', async () => {
    cleanupDialogChoice.value = false
    const xl = makeXleth()
    await handleXlethRootMenuAction('Clean up project…', { xl, showToast })
    expect(xl.project.cleanupScan).toHaveBeenCalledTimes(1)
    expect(xl.project.cleanupRun).not.toHaveBeenCalled()
    cleanupDialogChoice.value = true
  })

  it('uses production mode and boots persistence from the root helper', async () => {
    const setPersistenceAdapterMock = vi.spyOn(StatePersistence, 'setPersistenceAdapter').mockImplementation(() => {})
    const loadPersistedStateMock = vi.spyOn(StatePersistence, 'loadPersistedState').mockResolvedValue(true)

    const hydrated = await hydrateProductionLayout({
      statePersistence: StatePersistence,
      panelRegistry: usePanelRegistry,
      adapter: { read: vi.fn(), write: vi.fn() },
    })

    expect(hydrated).toBe(true)
    expect(setPersistenceAdapterMock).toHaveBeenCalledTimes(1)
    expect(loadPersistedStateMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to the default Compose layout when persisted layout hydration fails', async () => {
    vi.spyOn(StatePersistence, 'setPersistenceAdapter').mockImplementation(() => {})
    vi.spyOn(StatePersistence, 'loadPersistedState').mockResolvedValue(false)
    const applyPresetSpy = vi.fn()
    usePanelRegistry.setState({ applyPreset: applyPresetSpy })

    const hydrated = await hydrateProductionLayout({
      statePersistence: StatePersistence,
      panelRegistry: usePanelRegistry,
      adapter: { read: vi.fn(), write: vi.fn() },
    })

    expect(hydrated).toBe(false)
    expect(applyPresetSpy).toHaveBeenCalledWith('xleth-compose')
  })

  it('maps root keyboard shortcuts without triggering inside inputs', () => {
    expect(getFileMenuShortcutLabel({
      key: 'n',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target: { tagName: 'DIV', isContentEditable: false },
    })).toBe('New Project')

    expect(getFileMenuShortcutLabel({
      key: 'e',
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: false,
      target: { tagName: 'DIV', isContentEditable: false },
    })).toBe('Export Video…')

    expect(getFileMenuShortcutLabel({
      key: '=',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target: { tagName: 'DIV', isContentEditable: false },
    })).toBe('Zoom In')

    expect(getFileMenuShortcutLabel({
      key: '-',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target: { tagName: 'DIV', isContentEditable: false },
    })).toBe('Zoom Out')

    expect(getFileMenuShortcutLabel({
      key: '0',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target: { tagName: 'DIV', isContentEditable: false },
    })).toBe('Reset Zoom')

    expect(getFileMenuShortcutLabel({
      key: 's',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target: { tagName: 'INPUT', isContentEditable: false },
    })).toBeNull()
  })

  it('routes zoom menu actions to the Electron window bridge', async () => {
    const xl = makeXleth()

    await handleXlethRootMenuAction('Zoom In', { xl })
    await handleXlethRootMenuAction('Zoom Out', { xl })
    await handleXlethRootMenuAction('Reset Zoom', { xl })

    expect(xl.window.zoomIn).toHaveBeenCalledTimes(1)
    expect(xl.window.zoomOut).toHaveBeenCalledTimes(1)
    expect(xl.window.resetZoom).toHaveBeenCalledTimes(1)
  })

  it('shows a toast when source import is rejected', async () => {
    const xl = makeXleth()
    const filePath = 'C:\\Videos\\bad.mp4'
    xl.project.openImportDialog.mockResolvedValue([filePath])
    xl.project.importSource.mockResolvedValue(-1)
    const dispatchSpy = vi.spyOn(timelineEvents, 'dispatchEvent')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await handleXlethRootMenuAction('Import Source', { xl, showToast })

    expect(xl.project.importSource).toHaveBeenCalledWith(filePath)
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('Import failed: bad.mp4'),
      'error',
    )
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('configures the top Settings label as a direct action instead of a dropdown', () => {
    const settingsMenu = TITLEBAR_MENUS.find(menu => menu.label === 'Settings')

    expect(settingsMenu).toBeTruthy()
    expect(isDirectTitlebarMenu(settingsMenu)).toBe(true)
    expect(settingsMenu.items).toEqual([])
    expect(settingsMenu.action).toBe('Settings')
  })

  it('does not expose Theme as a top-level titlebar menu', () => {
    const themeMenu = TITLEBAR_MENUS.find(menu => menu.label === 'Theme')

    expect(themeMenu).toBeUndefined()
  })

  it('configures the Edit dropdown as editing actions only', () => {
    const editMenu = TITLEBAR_MENUS.find(menu => menu.label === 'Edit')

    expect(editMenu).toBeTruthy()
    expect(isDirectTitlebarMenu(editMenu)).toBe(false)
    expect(editMenu.items.map(item => item.action)).toEqual([
      'Undo',
      'Redo',
      'Delete',
    ])
    expect(editMenu.items.map(item => item.label)).toEqual([
      'Undo',
      'Redo',
      'Delete',
    ])
  })

  it('keeps the View dropdown zoom actions unchanged', () => {
    const viewMenu = TITLEBAR_MENUS.find(menu => menu.label === 'View')

    expect(viewMenu).toBeTruthy()
    expect(isDirectTitlebarMenu(viewMenu)).toBe(false)
    expect(viewMenu.items.map(item => item.action)).toEqual([
      'Zoom In',
      'Zoom Out',
      'Reset Zoom',
    ])
    expect(viewMenu.items.map(item => item.label)).toEqual([
      'Zoom In',
      'Zoom Out',
      'RESET',
    ])
  })

  it('offers Compose first under View > Layouts, with honest names for the others', () => {
    expect(LAYOUT_PRESETS.map((preset) => [preset.id, preset.label])).toEqual([
      ['xleth-compose', 'Compose (default)'],
      ['xleth-arrange', 'Tiled (preview row)'],
      ['fl-compose', 'Floating mixer'],
      ['vegas-arrange', 'Floating preview'],
    ])
  })

  it('View > Layouts applies a preset, and Reset layout restores the default', () => {
    const registry = { applyPreset: vi.fn(), resetLayout: vi.fn() }

    applyLayoutChoice('vegas-arrange', registry)
    applyLayoutChoice(RESET_LAYOUT_ID, registry)

    expect(registry.applyPreset).toHaveBeenCalledWith('vegas-arrange')
    expect(registry.resetLayout).toHaveBeenCalledTimes(1)
  })

  it('routes Delete to the focused editor command registry', async () => {
    const runEditorCommand = vi
      .spyOn(EditorCommandRegistry, 'runEditorCommand')
      .mockResolvedValue(true)

    await handleXlethRootMenuAction('Delete', { xl: makeXleth() })

    expect(runEditorCommand).toHaveBeenCalledWith('deleteSelected')
  })

  it('routes Settings directly to the consolidated Settings surface', async () => {
    const setShowSettings = vi.fn()
    const setSettingsInitialCategory = vi.fn()
    const setShowThemeEditor = vi.fn()

    await handleXlethRootMenuAction('Settings', {
      xl: makeXleth(),
      setShowSettings,
      setSettingsInitialCategory,
      setShowThemeEditor,
    })

    expect(setSettingsInitialCategory).toHaveBeenCalledWith('project')
    expect(setShowSettings).toHaveBeenCalledWith(true)
    expect(setShowThemeEditor).not.toHaveBeenCalled()
  })
})
