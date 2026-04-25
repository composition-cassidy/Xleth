import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ROOT_APP_SHELL_MODE,
  getFileMenuShortcutLabel,
  handleXlethRootMenuAction,
  hydrateProductionLayout,
} from './XlethRoot.jsx'
import usePianoRollStore from './stores/usePianoRollStore.js'
import { createInitialPanelStates, usePanelRegistry } from './windowing/registry/PanelRegistry'
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

  it('maps file-menu keyboard shortcuts without triggering inside inputs', () => {
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
      key: 's',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target: { tagName: 'INPUT', isContentEditable: false },
    })).toBeNull()
  })
})
