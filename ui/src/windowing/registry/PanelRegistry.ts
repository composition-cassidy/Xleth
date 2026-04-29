import { create } from 'zustand';
import { loadPreset } from '../managers/PresetManager';
import { PANEL_CATALOG, PANEL_IDS, type PanelId } from './panelCatalog';

export type PanelMode = 'floating' | 'docked' | 'maximized';
export type DockRegion = 'left' | 'right' | 'top' | 'bottom';
export type PresetId = 'fl-compose' | 'vegas-arrange' | 'grid-edit' | string;

export interface FloatingPanelState {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DockedPanelState {
  region: DockRegion;
  orderInRegion: number;
  sizeInRegion: number;
}

export interface PanelState {
  id: PanelId;
  hidden: boolean;
  focused: boolean;
  zIndex: number;
  mode: PanelMode;
  floating: FloatingPanelState;
  docked: DockedPanelState;
  preMaximizeState: Partial<PanelState> | null;
}

export type PanelStateMap = Record<PanelId, PanelState>;

export type DockRegionSizes = Record<DockRegion, number>;

export const DEFAULT_DOCK_REGION_SIZES: DockRegionSizes = {
  left: 280,
  right: 280,
  top: 240,
  bottom: 240,
};

export const MIN_DOCK_REGION_SIZES: DockRegionSizes = {
  left: 220,
  right: 220,
  top: 160,
  bottom: 200,
};

export interface PanelRegistryState {
  panels: PanelStateMap;
  dockRegionSizes: DockRegionSizes;
  openPanel: (id: PanelId) => void;
  closePanel: (id: PanelId) => void;
  togglePanel: (id: PanelId) => void;
  focusPanel: (id: PanelId) => void;
  moveFloatingPanel: (id: PanelId, x: number, y: number) => void;
  resizeFloatingPanel: (id: PanelId, x: number, y: number, width: number, height: number) => void;
  dockPanel: (id: PanelId, region: DockRegion) => void;
  undockPanel: (id: PanelId, x: number, y: number) => void;
  maximizePanel: (id: PanelId) => void;
  restorePanel: (id: PanelId) => void;
  setDockRegionSize: (region: DockRegion, size: number) => void;
  applyPreset: (presetId: PresetId) => void;
}

export const LAYOUT_PERSISTENCE_DEBOUNCE_MS = 500;

export type LayoutPersistenceWriter = (
  panels: PanelStateMap,
  dockRegionSizes: DockRegionSizes,
) => void | Promise<void>;

let persistenceWriter: LayoutPersistenceWriter | null = null;
let persistenceTimer: ReturnType<typeof setTimeout> | null = null;

export function setLayoutPersistenceWriter(writer: LayoutPersistenceWriter | null): void {
  persistenceWriter = writer;
}

export function clearLayoutPersistenceWriter(): void {
  persistenceWriter = null;
  if (persistenceTimer) clearTimeout(persistenceTimer);
  persistenceTimer = null;
}

function scheduleLayoutPersistence(
  panels: PanelStateMap,
  dockRegionSizes: DockRegionSizes,
): void {
  if (!persistenceWriter) return;
  if (persistenceTimer) clearTimeout(persistenceTimer);

  const panelsSnapshot = clonePanelStates(panels);
  const sizesSnapshot = { ...dockRegionSizes };
  persistenceTimer = setTimeout(() => {
    void persistenceWriter?.(panelsSnapshot, sizesSnapshot);
  }, LAYOUT_PERSISTENCE_DEBOUNCE_MS);
  (persistenceTimer as { unref?: () => void }).unref?.();
}

function defaultDockedState(id: PanelId): DockedPanelState {
  if (id === 'sampleSelector') return { region: 'left', orderInRegion: 0, sizeInRegion: 240 };
  if (id === 'mixer') return { region: 'bottom', orderInRegion: 0, sizeInRegion: 240 };
  return { region: 'bottom', orderInRegion: 0, sizeInRegion: 280 };
}

function createPanelState(id: PanelId, index: number): PanelState {
  const focused = id === 'timeline';
  return {
    id,
    hidden: id !== 'timeline',
    focused,
    zIndex: focused ? index + 1 : 0,
    mode: id === 'sampleSelector' ? 'docked' : 'floating',
    floating: { ...PANEL_CATALOG[id].defaultFloating },
    docked: defaultDockedState(id),
    preMaximizeState: null,
  };
}

export function createInitialPanelStates(): PanelStateMap {
  return PANEL_IDS.reduce((acc, id, index) => {
    acc[id] = createPanelState(id, index);
    return acc;
  }, {} as PanelStateMap);
}

export function createInitialDockRegionSizes(): DockRegionSizes {
  return { ...DEFAULT_DOCK_REGION_SIZES };
}

function clonePartialPanelState(state: Partial<PanelState>): Partial<PanelState> {
  return {
    ...state,
    floating: state.floating ? { ...state.floating } : undefined,
    docked: state.docked ? { ...state.docked } : undefined,
    preMaximizeState: state.preMaximizeState ? clonePartialPanelState(state.preMaximizeState) : null,
  };
}

export function clonePanelState(panel: PanelState): PanelState {
  return {
    ...panel,
    floating: { ...panel.floating },
    docked: { ...panel.docked },
    preMaximizeState: panel.preMaximizeState ? clonePartialPanelState(panel.preMaximizeState) : null,
  };
}

export function clonePanelStates(panels: PanelStateMap): PanelStateMap {
  return PANEL_IDS.reduce((acc, id) => {
    acc[id] = clonePanelState(panels[id]);
    return acc;
  }, {} as PanelStateMap);
}

function maxZIndex(panels: PanelStateMap): number {
  return Math.max(0, ...PANEL_IDS.map((id) => panels[id].zIndex));
}

function focusInPanelMap(panels: PanelStateMap, id: PanelId): PanelStateMap {
  const nextZIndex = maxZIndex(panels) + 1;
  const updated = PANEL_IDS.reduce((acc, panelId) => {
    const panel = panels[panelId];
    acc[panelId] = {
      ...panel,
      focused: panelId === id,
      zIndex: panelId === id ? nextZIndex : panel.zIndex,
    };
    return acc;
  }, {} as PanelStateMap);

  // Re-rank z-indices as 1..N after each focus to prevent unbounded growth.
  const sorted = PANEL_IDS.slice().sort((a, b) => updated[a].zIndex - updated[b].zIndex);
  sorted.forEach((panelId, i) => {
    updated[panelId] = { ...updated[panelId], zIndex: i + 1 };
  });

  return updated;
}

function panelSnapshotForMaximize(panel: PanelState): Partial<PanelState> {
  return {
    hidden: panel.hidden,
    focused: panel.focused,
    zIndex: panel.zIndex,
    mode: panel.mode,
    floating: { ...panel.floating },
    docked: { ...panel.docked },
  };
}

interface RegistryPersistenceSlice {
  panels: PanelStateMap;
  dockRegionSizes: DockRegionSizes;
}

function commitPanels(
  slice: RegistryPersistenceSlice,
  producer: (draft: PanelStateMap) => PanelStateMap,
): PanelStateMap {
  const next = producer(clonePanelStates(slice.panels));
  scheduleLayoutPersistence(next, slice.dockRegionSizes);
  return next;
}

export const usePanelRegistry = create<PanelRegistryState>((set) => ({
  panels: createInitialPanelStates(),
  dockRegionSizes: createInitialDockRegionSizes(),

  openPanel: (id) => set((state) => ({
    panels: commitPanels(state, (draft) => {
      draft[id].hidden = false;
      return focusInPanelMap(draft, id);
    }),
  })),

  closePanel: (id) => set((state) => ({
    panels: commitPanels(state, (draft) => {
      draft[id].hidden = true;
      draft[id].focused = false;
      return draft;
    }),
  })),

  togglePanel: (id) => {
    const panel = usePanelRegistry.getState().panels[id];
    if (panel.hidden) usePanelRegistry.getState().openPanel(id);
    else usePanelRegistry.getState().closePanel(id);
  },

  focusPanel: (id) => set((state) => {
    if (state.panels[id].hidden) return state;
    return {
      panels: commitPanels(state, (draft) => focusInPanelMap(draft, id)),
    };
  }),

  moveFloatingPanel: (id, x, y) => set((state) => ({
    panels: commitPanels(state, (draft) => {
      draft[id].floating = { ...draft[id].floating, x, y };
      return draft;
    }),
  })),

  resizeFloatingPanel: (id, x, y, width, height) => set((state) => ({
    panels: commitPanels(state, (draft) => {
      draft[id].floating = { x, y, width, height };
      return draft;
    }),
  })),

  dockPanel: (id, region) => set((state) => ({
    panels: commitPanels(state, (draft) => {
      const orderInRegion = PANEL_IDS.filter((panelId) => (
        panelId !== id
        && !draft[panelId].hidden
        && draft[panelId].mode === 'docked'
        && draft[panelId].docked.region === region
      )).length;
      draft[id].hidden = false;
      draft[id].mode = 'docked';
      draft[id].docked = {
        ...draft[id].docked,
        region,
        orderInRegion,
      };
      return focusInPanelMap(draft, id);
    }),
  })),

  undockPanel: (id, x, y) => set((state) => ({
    panels: commitPanels(state, (draft) => {
      draft[id].hidden = false;
      draft[id].mode = 'floating';
      draft[id].floating = { ...draft[id].floating, x, y };
      return focusInPanelMap(draft, id);
    }),
  })),

  maximizePanel: (id) => set((state) => {
    const panel = state.panels[id];
    if (panel.hidden || panel.mode === 'maximized') return state;
    return {
      panels: commitPanels(state, (draft) => {
        draft[id].hidden = false;
        draft[id].preMaximizeState = panelSnapshotForMaximize(panel);
        draft[id].mode = 'maximized';
        return focusInPanelMap(draft, id);
      }),
    };
  }),

  restorePanel: (id) => set((state) => {
    const panel = state.panels[id];
    if (!panel.preMaximizeState) return state;
    return {
      panels: commitPanels(state, (draft) => {
        draft[id] = {
          ...draft[id],
          ...clonePartialPanelState(panel.preMaximizeState),
          id,
          preMaximizeState: null,
        };
        return draft;
      }),
    };
  }),

  setDockRegionSize: (region, size) => set((state) => {
    const minSize = MIN_DOCK_REGION_SIZES[region];
    const clamped = Math.max(minSize, size);
    if (state.dockRegionSizes[region] === clamped) return state;
    const nextSizes = { ...state.dockRegionSizes, [region]: clamped };
    scheduleLayoutPersistence(state.panels, nextSizes);
    return { dockRegionSizes: nextSizes };
  }),

  applyPreset: (presetId) => {
    const preset = loadPreset(presetId);
    if (!preset) return;
    const panels = clonePanelStates(preset.panels);
    const dockRegionSizes = { ...preset.dockRegionSizes };
    scheduleLayoutPersistence(panels, dockRegionSizes);
    set({ panels, dockRegionSizes });
  },
}));

export default usePanelRegistry;
