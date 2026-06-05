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

export const DEFAULT_SAMPLE_SELECTOR_DOCK_WIDTH = 320;
export const MIN_SAMPLE_SELECTOR_DOCK_WIDTH = 260;
export const SAMPLE_SELECTOR_DOCK_HANDLE_WIDTH = 32;

export const MIN_DOCK_REGION_SIZES: DockRegionSizes = {
  left: 220,
  right: 220,
  top: 160,
  bottom: 200,
};

export const MIN_DOCKED_PANEL_MAIN_SIZES: Record<PanelId, number> = {
  timeline: 240,
  sampleSelector: 220,
  pianoRoll: 220,
  preview: 180,
  mixer: 220,
  gridSettings: 180,
  fxGraph: 240,
  nodeEditor: 200,
  sampler: 220,
};

export interface PanelRegistryState {
  panels: PanelStateMap;
  dockRegionSizes: DockRegionSizes;
  sampleSelectorDockWidth: number;
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
  resizeDockedPanelPair: (
    region: DockRegion,
    beforeId: PanelId,
    beforeSize: number,
    afterId: PanelId,
    afterSize: number,
  ) => void;
  setSampleSelectorDockOpen: (open: boolean) => void;
  setSampleSelectorDockWidth: (width: number) => void;
  clampFloatingPanelsToWorkArea: (width: number, height: number) => void;
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

function floatingPanelsEqual(a: FloatingPanelState, b: FloatingPanelState): boolean {
  return a.x === b.x
    && a.y === b.y
    && a.width === b.width
    && a.height === b.height;
}

function dockedPanelsEqual(a: DockedPanelState, b: DockedPanelState): boolean {
  return a.region === b.region
    && a.orderInRegion === b.orderInRegion
    && a.sizeInRegion === b.sizeInRegion;
}

function partialPanelStatesEqual(a: Partial<PanelState> | null, b: Partial<PanelState> | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.hidden === b.hidden
    && a.focused === b.focused
    && a.zIndex === b.zIndex
    && a.mode === b.mode
    && (a.floating === b.floating || Boolean(a.floating && b.floating && floatingPanelsEqual(a.floating, b.floating)))
    && (a.docked === b.docked || Boolean(a.docked && b.docked && dockedPanelsEqual(a.docked, b.docked)))
    && partialPanelStatesEqual(a.preMaximizeState ?? null, b.preMaximizeState ?? null);
}

function panelStatesEqual(a: PanelState, b: PanelState): boolean {
  return a.id === b.id
    && a.hidden === b.hidden
    && a.focused === b.focused
    && a.zIndex === b.zIndex
    && a.mode === b.mode
    && floatingPanelsEqual(a.floating, b.floating)
    && dockedPanelsEqual(a.docked, b.docked)
    && partialPanelStatesEqual(a.preMaximizeState, b.preMaximizeState);
}

function panelMapsEqual(a: PanelStateMap, b: PanelStateMap): boolean {
  return PANEL_IDS.every((id) => panelStatesEqual(a[id], b[id]));
}

function dockRegionSizesEqual(a: DockRegionSizes, b: DockRegionSizes): boolean {
  return a.left === b.left
    && a.right === b.right
    && a.top === b.top
    && a.bottom === b.bottom;
}

function clampDockedPanelPairSizes(
  beforeId: PanelId,
  beforeSize: number,
  afterId: PanelId,
  afterSize: number,
): { beforeSize: number; afterSize: number } {
  const beforeMin = MIN_DOCKED_PANEL_MAIN_SIZES[beforeId];
  const afterMin = MIN_DOCKED_PANEL_MAIN_SIZES[afterId];
  const total = Math.max(beforeMin + afterMin, Math.round(beforeSize + afterSize));
  let nextBefore = Math.round(beforeSize);
  let nextAfter = total - nextBefore;

  if (nextBefore < beforeMin) {
    nextBefore = beforeMin;
    nextAfter = total - nextBefore;
  }

  if (nextAfter < afterMin) {
    nextAfter = afterMin;
    nextBefore = total - nextAfter;
  }

  return {
    beforeSize: nextBefore,
    afterSize: nextAfter,
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
  sampleSelectorDockWidth: DEFAULT_SAMPLE_SELECTOR_DOCK_WIDTH,

  openPanel: (id) => set((state) => {
    const panel = state.panels[id];
    const sampleSelectorAlreadyDocked = id !== 'sampleSelector'
      || (
        panel.mode === 'docked'
        && panel.docked.region === 'left'
        && panel.docked.orderInRegion === 0
        && panel.preMaximizeState === null
      );
    if (!panel.hidden && panel.focused && sampleSelectorAlreadyDocked) return state;
    return {
      panels: commitPanels(state, (draft) => {
        draft[id].hidden = false;
        if (id === 'sampleSelector') {
          draft[id].mode = 'docked';
          draft[id].docked = {
            ...draft[id].docked,
            region: 'left',
            orderInRegion: 0,
          };
          draft[id].preMaximizeState = null;
        }
        return focusInPanelMap(draft, id);
      }),
    };
  }),

  closePanel: (id) => set((state) => {
    const panel = state.panels[id];
    if (panel.hidden && !panel.focused) return state;
    return {
      panels: commitPanels(state, (draft) => {
        draft[id].hidden = true;
        draft[id].focused = false;
        return draft;
      }),
    };
  }),

  togglePanel: (id) => {
    const panel = usePanelRegistry.getState().panels[id];
    if (panel.hidden) usePanelRegistry.getState().openPanel(id);
    else usePanelRegistry.getState().closePanel(id);
  },

  focusPanel: (id) => set((state) => {
    if (state.panels[id].hidden) return state;
    if (state.panels[id].focused) return state;
    return {
      panels: commitPanels(state, (draft) => focusInPanelMap(draft, id)),
    };
  }),

  moveFloatingPanel: (id, x, y) => set((state) => {
    const floating = state.panels[id].floating;
    if (floating.x === x && floating.y === y) return state;
    return {
      panels: commitPanels(state, (draft) => {
        draft[id].floating = { ...draft[id].floating, x, y };
        return draft;
      }),
    };
  }),

  resizeFloatingPanel: (id, x, y, width, height) => set((state) => {
    if (floatingPanelsEqual(state.panels[id].floating, { x, y, width, height })) return state;
    return {
      panels: commitPanels(state, (draft) => {
        draft[id].floating = { x, y, width, height };
        return draft;
      }),
    };
  }),

  dockPanel: (id, region) => set((state) => {
    const panel = state.panels[id];
    if (!panel.hidden && panel.mode === 'docked' && panel.docked.region === region && panel.focused) {
      return state;
    }
    return {
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
    };
  }),

  undockPanel: (id, x, y) => set((state) => {
    const panel = state.panels[id];
    if (!panel.hidden && panel.mode === 'floating' && panel.floating.x === x && panel.floating.y === y && panel.focused) {
      return state;
    }
    return {
      panels: commitPanels(state, (draft) => {
        draft[id].hidden = false;
        draft[id].mode = 'floating';
        draft[id].floating = { ...draft[id].floating, x, y };
        return focusInPanelMap(draft, id);
      }),
    };
  }),

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

  resizeDockedPanelPair: (region, beforeId, beforeSize, afterId, afterSize) => set((state) => {
    const beforePanel = state.panels[beforeId];
    const afterPanel = state.panels[afterId];
    const canResize = !beforePanel.hidden
      && !afterPanel.hidden
      && beforePanel.mode === 'docked'
      && afterPanel.mode === 'docked'
      && beforePanel.docked.region === region
      && afterPanel.docked.region === region;
    if (!canResize) return state;

    const nextSizes = clampDockedPanelPairSizes(beforeId, beforeSize, afterId, afterSize);
    if (
      beforePanel.docked.sizeInRegion === nextSizes.beforeSize
      && afterPanel.docked.sizeInRegion === nextSizes.afterSize
    ) {
      return state;
    }

    return {
      panels: commitPanels(state, (draft) => {
        draft[beforeId].docked = {
          ...draft[beforeId].docked,
          sizeInRegion: nextSizes.beforeSize,
        };
        draft[afterId].docked = {
          ...draft[afterId].docked,
          sizeInRegion: nextSizes.afterSize,
        };
        return draft;
      }),
    };
  }),

  setSampleSelectorDockOpen: (open) => set((state) => {
    const panel = state.panels.sampleSelector;
    if (open) {
      const alreadyOpen = !panel.hidden
        && panel.mode === 'docked'
        && panel.docked.region === 'left'
        && panel.docked.orderInRegion === 0
        && panel.preMaximizeState === null;
      if (alreadyOpen) return state;
      return {
        panels: commitPanels(state, (draft) => {
          draft.sampleSelector.hidden = false;
          draft.sampleSelector.mode = 'docked';
          draft.sampleSelector.docked = {
            ...draft.sampleSelector.docked,
            region: 'left',
            orderInRegion: 0,
          };
          draft.sampleSelector.preMaximizeState = null;
          return draft;
        }),
      };
    }

    if (panel.hidden && !panel.focused) return state;
    return {
      panels: commitPanels(state, (draft) => {
        draft.sampleSelector.hidden = true;
        draft.sampleSelector.focused = false;
        return draft;
      }),
    };
  }),

  setSampleSelectorDockWidth: (width) => set((state) => {
    const clamped = Math.max(MIN_SAMPLE_SELECTOR_DOCK_WIDTH, Math.round(width));
    if (state.sampleSelectorDockWidth === clamped) return state;
    return { sampleSelectorDockWidth: clamped };
  }),

  clampFloatingPanelsToWorkArea: (width, height) => set((state) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return state;
    }

    let changed = false;
    const nextPanels = clonePanelStates(state.panels);
    for (const id of PANEL_IDS) {
      const panel = nextPanels[id];
      if (panel.hidden || panel.mode !== 'floating') continue;

      const nextWidth = Math.max(1, Math.min(panel.floating.width, width));
      const nextHeight = Math.max(1, Math.min(panel.floating.height, height));
      const nextX = Math.max(0, Math.min(panel.floating.x, Math.max(0, width - nextWidth)));
      const nextY = Math.max(0, Math.min(panel.floating.y, Math.max(0, height - nextHeight)));
      const nextFloating = {
        x: nextX,
        y: nextY,
        width: nextWidth,
        height: nextHeight,
      };

      if (!floatingPanelsEqual(panel.floating, nextFloating)) {
        panel.floating = nextFloating;
        changed = true;
      }
    }

    if (!changed) return state;
    scheduleLayoutPersistence(nextPanels, state.dockRegionSizes);
    return { panels: nextPanels };
  }),

  applyPreset: (presetId) => {
    const preset = loadPreset(presetId);
    if (!preset) return;
    const panels = clonePanelStates(preset.panels);
    const dockRegionSizes = { ...preset.dockRegionSizes };
    const current = usePanelRegistry.getState();
    if (panelMapsEqual(current.panels, panels) && dockRegionSizesEqual(current.dockRegionSizes, dockRegionSizes)) {
      return;
    }
    scheduleLayoutPersistence(panels, dockRegionSizes);
    set({ panels, dockRegionSizes });
  },
}));

export default usePanelRegistry;
