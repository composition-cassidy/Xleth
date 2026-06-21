import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ROOT_APP_SHELL_MODE,
  getFileMenuShortcutLabel,
  getWorkspaceBackdropClassName,
  handleXlethRootMenuAction,
  hydrateProductionLayout,
} from './XlethRoot.jsx'
import { timelineEvents } from './timelineEvents.js'
import { TITLEBAR_MENUS, isDirectTitlebarMenu } from './components/TitleBar.jsx'
import usePianoRollStore from './stores/usePianoRollStore.js'
import { createInitialPanelStates, usePanelRegistry } from './windowing/registry/PanelRegistry'
import * as EditorCommandRegistry from './windowing/managers/EditorCommandRegistry'
import * as StatePersistence from './windowing/managers/StatePersistence'

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
        getInfo: vi.fn().mockResolvedValue(null),
        load: vi.fn().mockResolvedValue(true),
        isDirty: vi.fn().mockResolvedValue(false),
        isExportRunning: vi.fn().mockResolvedValue(false),
        newBlank: newBlankMock,
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

  it('uses production mode and boots persistence from the root helper', async () => {
    const setPersistenceAdapterMock = vi.spyOn(StatePersistence, 'setPersistenceAdapter').mockImplementation(() => {})
    const loadPersistedStateMock = vi.spyOn(StatePersistence, 'loadPersistedState').mockResolvedValue(true)

    const hydrated = await hydrateProductionLayout({
      statePersistence: StatePersistence,
      panelRegistry: usePanelRegistry,
      adapter: { read: vi.fn(), write: vi.fn() },
    })

    expect(ROOT_APP_SHELL_MODE).toBe('production')
    expect(hydrated).toBe(true)
    expect(setPersistenceAdapterMock).toHaveBeenCalledTimes(1)
    expect(loadPersistedStateMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to fl-compose when persisted layout hydration fails', async () => {
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
    expect(applyPresetSpy).toHaveBeenCalledWith('fl-compose')
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

  it('configures the View dropdown as zoom controls only', () => {
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

  it('maps workspace backdrop modes to root classes', () => {
    expect(getWorkspaceBackdropClassName('native-acrylic')).toBe('xleth-backdrop-native-acrylic')
    expect(getWorkspaceBackdropClassName('image')).toBe('xleth-backdrop-image')
    expect(getWorkspaceBackdropClassName('video')).toBe('xleth-backdrop-video')
    expect(getWorkspaceBackdropClassName('off')).toBe('xleth-backdrop-off')
    expect(getWorkspaceBackdropClassName('unsupported')).toBe('xleth-backdrop-off')
  })
})
