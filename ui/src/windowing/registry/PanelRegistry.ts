import { create } from 'zustand';
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

export interface PanelRegistryState {
  panels: PanelStateMap;
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
  applyPreset: (presetId: PresetId) => void;
}

export const LAYOUT_PERSISTENCE_DEBOUNCE_MS = 500;

type LayoutPersistenceWriter = (panels: PanelStateMap) => void | Promise<void>;

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

function scheduleLayoutPersistence(panels: PanelStateMap): void {
  if (!persistenceWriter) return;
  if (persistenceTimer) clearTimeout(persistenceTimer);

  const snapshot = clonePanelStates(panels);
  persistenceTimer = setTimeout(() => {
    void persistenceWriter?.(snapshot);
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
  return PANEL_IDS.reduce((acc, panelId) => {
    const panel = panels[panelId];
    acc[panelId] = {
      ...panel,
      focused: panelId === id,
      zIndex: panelId === id ? nextZIndex : panel.zIndex,
    };
    return acc;
  }, {} as PanelStateMap);
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

function commitPanels(
  panels: PanelStateMap,
  producer: (draft: PanelStateMap) => PanelStateMap,
): PanelStateMap {
  const next = producer(clonePanelStates(panels));
  scheduleLayoutPersistence(next);
  return next;
}

export const usePanelRegistry = create<PanelRegistryState>((set, get) => ({
  panels: createInitialPanelStates(),

  openPanel: (id) => set((state) => ({
    panels: commitPanels(state.panels, (draft) => {
      draft[id].hidden = false;
      return focusInPanelMap(draft, id);
    }),
  })),

  closePanel: (id) => set((state) => ({
    panels: commitPanels(state.panels, (draft) => {
      draft[id].hidden = true;
      draft[id].focused = false;
      return draft;
    }),
  })),

  togglePanel: (id) => {
    const panel = get().panels[id];
    if (panel.hidden) get().openPanel(id);
    else get().closePanel(id);
  },

  focusPanel: (id) => set((state) => {
    if (state.panels[id].hidden) return state;
    return {
      panels: commitPanels(state.panels, (draft) => focusInPanelMap(draft, id)),
    };
  }),

  moveFloatingPanel: (id, x, y) => set((state) => ({
    panels: commitPanels(state.panels, (draft) => {
      draft[id].floating = { ...draft[id].floating, x, y };
      return draft;
    }),
  })),

  resizeFloatingPanel: (id, x, y, width, height) => set((state) => ({
    panels: commitPanels(state.panels, (draft) => {
      draft[id].floating = { x, y, width, height };
      return draft;
    }),
  })),

  dockPanel: (id, region) => set((state) => ({
    panels: commitPanels(state.panels, (draft) => {
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
    panels: commitPanels(state.panels, (draft) => {
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
      panels: commitPanels(state.panels, (draft) => {
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
      panels: commitPanels(state.panels, (draft) => {
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

  applyPreset: (_presetId) => {
    // Phase 5 owns preset JSON loading. Phase 1 exposes the registry entry point
    // so future preset application still flows through this store.
  },
}));

export default usePanelRegistry;
