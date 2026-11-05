import { create } from 'zustand';
import { loadPreset } from '../managers/PresetManager';
import { PANEL_CATALOG, PANEL_IDS, type PanelId } from './panelCatalog';

export type PanelMode = 'floating' | 'docked' | 'maximized';
/** An edge region: it has a stored thickness and a resizer. */
export type DockRegion = 'left' | 'right' | 'top' | 'bottom';
/**
 * Where a docked panel lives. `center` is the work area itself: it has no
 * stored size (it takes whatever the edge regions leave) and it is never empty.
 */
export type DockArea = DockRegion | 'center';
export type PresetId = 'xleth-arrange' | 'fl-compose' | 'vegas-arrange' | string;

export function isEdgeRegion(value: unknown): value is DockRegion {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom';
}

/** Height of a panel titlebar in px. Mirrored by --xleth-panel-titlebar-height. */
export const PANEL_TITLEBAR_HEIGHT = 32;

export interface FloatingPanelState {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DockedPanelState {
  region: DockArea;
  /** Slot order within the region. Every member of a tab group shares one. */
  orderInRegion: number;
  /** Extent of the whole slot along the region main axis. Shared by a group. */
  sizeInRegion: number;
  /**
   * Tab-group identity. `null` means "own slot" — the classic one-panel slot.
   * A non-null id is shared by every panel tabbed together in the same slot.
   * Grouping is never inferred from orderInRegion: only an explicit
   * dockPanelAsTab() writes this, so reopening a panel can never silently
   * absorb it into a neighbour's tab strip.
   */
  tabGroupId: string | null;
  /** Order within the tab strip. Meaningless when tabGroupId is null. */
  tabOrder: number;
  /** Whether this panel is the visible tab of its slot. */
  tabActive: boolean;
}

export interface PanelState {
  id: PanelId;
  /** Closed. Not rendered, not in the tab strip, not restorable except by open. */
  hidden: boolean;
  /** Open but rolled up to its titlebar. Distinct from hidden — see collapsePanel. */
  collapsed: boolean;
  focused: boolean;
  zIndex: number;
  mode: PanelMode;
  floating: FloatingPanelState;
  docked: DockedPanelState;
  preMaximizeState: Partial<PanelState> | null;
}

export type PanelStateMap = Record<PanelId, PanelState>;

export type DockRegionSizes = Record<DockRegion, number>;

export const DOCK_REGIONS: readonly DockRegion[] = ['left', 'right', 'top', 'bottom'];
export const DOCK_AREAS: readonly DockArea[] = ['left', 'right', 'top', 'bottom', 'center'];

/**
 * The panel the shell puts back into the center when nothing else is there.
 * The center is the arrangement's home; an empty one would expose the
 * workspace ground, which is exactly the dead space the tiled shell removes.
 */
export const CENTER_FALLBACK_PANEL_ID: PanelId = 'timeline';

export const DEFAULT_DOCK_REGION_SIZES: DockRegionSizes = {
  left: 280,
  right: 280,
  top: 140,
  bottom: 140,
};

export const SAMPLE_SELECTOR_DOCK_HANDLE_WIDTH = 32;

export const MIN_DOCK_REGION_SIZES: DockRegionSizes = {
  left: 220,
  right: 220,
  top: 100,
  bottom: 100,
};

// Derived from the catalog — the panel declares its own minimum exactly once.
export const MIN_DOCKED_PANEL_MAIN_SIZES: Record<PanelId, number> = PANEL_IDS.reduce((acc, id) => {
  acc[id] = PANEL_CATALOG[id].minDockedSize;
  return acc;
}, {} as Record<PanelId, number>);

export interface PanelProps {
  [key: string]: unknown;
}

export interface PanelRegistryState {
  panels: PanelStateMap;
  dockRegionSizes: DockRegionSizes;
  /**
   * Per-open context handed to a panel by whoever opened it. Deliberately NOT
   * persisted: it describes one opening, not a layout.
   */
  panelProps: Partial<Record<PanelId, PanelProps>>;
  /** Most recently closed panels, newest last. Drives reopenLastClosed(). */
  recentlyClosed: PanelId[];
  openPanel: (id: PanelId, props?: PanelProps) => void;
  closePanel: (id: PanelId) => void;
  togglePanel: (id: PanelId, props?: PanelProps) => void;
  reopenLastClosed: () => void;
  setPanelProps: (id: PanelId, props: PanelProps) => void;
  focusPanel: (id: PanelId) => void;
  focusNextPanel: (direction: 1 | -1) => void;
  moveFloatingPanel: (id: PanelId, x: number, y: number) => void;
  resizeFloatingPanel: (id: PanelId, x: number, y: number, width: number, height: number) => void;
  dockPanel: (id: PanelId, region: DockArea, slotIndex?: number) => void;
  dockPanelAsTab: (id: PanelId, targetId: PanelId) => void;
  activateTab: (id: PanelId) => void;
  undockPanel: (id: PanelId, x: number, y: number) => void;
  maximizePanel: (id: PanelId) => void;
  restorePanel: (id: PanelId) => void;
  collapsePanel: (id: PanelId) => void;
  expandPanel: (id: PanelId) => void;
  toggleCollapsePanel: (id: PanelId) => void;
  setDockRegionSize: (region: DockRegion, size: number) => void;
  resizeDockedPanelPair: (
    region: DockArea,
    beforeId: PanelId,
    beforeSize: number,
    afterId: PanelId,
    afterSize: number,
  ) => void;
  setSampleSelectorDockOpen: (open: boolean) => void;
  clampFloatingPanelsToWorkArea: (width: number, height: number) => void;
  applyPreset: (presetId: PresetId) => void;
  resetLayout: () => void;
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
  const base = { tabGroupId: null, tabOrder: 0, tabActive: true } as const;
  if (id === CENTER_FALLBACK_PANEL_ID) return { region: 'center', orderInRegion: 0, sizeInRegion: 480, ...base };
  if (id === 'sampleSelector') return { region: 'left', orderInRegion: 0, sizeInRegion: 240, ...base };
  if (id === 'mixer') return { region: 'bottom', orderInRegion: 0, sizeInRegion: 240, ...base };
  return { region: 'bottom', orderInRegion: 0, sizeInRegion: 280, ...base };
}

export function createPanelState(id: PanelId, index: number): PanelState {
  const isCenter = id === CENTER_FALLBACK_PANEL_ID;
  const focused = isCenter;
  return {
    id,
    hidden: !isCenter,
    collapsed: false,
    focused,
    zIndex: focused ? index + 1 : 0,
    // The arrangement starts docked in the center; nothing starts floating over
    // an empty workspace any more.
    mode: PANEL_CATALOG[id].presentation === 'drawer' || isCenter ? 'docked' : 'floating',
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

// ─── Dock slot model ───────────────────────────────────────────────────────
//
// A region is an ordered list of SLOTS; a slot holds one or more panels as
// tabs. Slot identity is `tabGroupId ?? id`, so an ungrouped panel is simply a
// slot of one. Every docking mutation runs through normalizeDockSlots(), which
// re-establishes the invariants rather than asking each caller to maintain
// them: slot order is compact 0..n-1, every member of a slot shares that slot's
// order and size, tab order is compact, and exactly one member is active.

export function dockSlotKey(panel: PanelState): string {
  return panel.docked.tabGroupId ?? panel.id;
}

/** Visible docked panels of one region, grouped into slots in render order. */
export function getRegionSlots(panels: PanelStateMap, region: DockArea): PanelId[][] {
  const members = PANEL_IDS.filter((id) => (
    !panels[id].hidden
    && panels[id].mode === 'docked'
    && panels[id].docked.region === region
  ));

  const slots = new Map<string, PanelId[]>();
  for (const id of members) {
    const key = dockSlotKey(panels[id]);
    const bucket = slots.get(key);
    if (bucket) bucket.push(id);
    else slots.set(key, [id]);
  }

  const ordered = Array.from(slots.values());
  for (const slot of ordered) {
    slot.sort((a, b) => panels[a].docked.tabOrder - panels[b].docked.tabOrder);
  }
  ordered.sort((a, b) => {
    const orderA = Math.min(...a.map((id) => panels[id].docked.orderInRegion));
    const orderB = Math.min(...b.map((id) => panels[id].docked.orderInRegion));
    if (orderA !== orderB) return orderA - orderB;
    return PANEL_IDS.indexOf(a[0]) - PANEL_IDS.indexOf(b[0]);
  });
  return ordered;
}

/** A panel that is visibly docked in the center, or maximized out of it. */
function occupiesCenter(panel: PanelState): boolean {
  if (panel.hidden) return false;
  if (panel.mode === 'docked') return panel.docked.region === 'center';
  // Maximizing lifts the panel out of its slot but it comes back on restore,
  // so the center still belongs to it.
  return panel.mode === 'maximized'
    && panel.preMaximizeState?.mode === 'docked'
    && panel.preMaximizeState.docked?.region === 'center';
}

export function centerOccupants(panels: PanelStateMap): PanelId[] {
  return PANEL_IDS.filter((id) => occupiesCenter(panels[id]));
}

/**
 * True when `id` is the only thing holding the center. Such a panel may not be
 * closed, collapsed, undocked or docked elsewhere: every one of those would
 * leave the work area empty.
 */
export function isPinnedToCenter(panels: PanelStateMap, id: PanelId): boolean {
  const occupants = centerOccupants(panels);
  return occupants.length === 1 && occupants[0] === id;
}

/**
 * Safety net for layouts the registry did not produce itself (a saved file, a
 * preset). The actions below refuse to empty the center, so in normal use this
 * never fires.
 */
export function ensureCenterOccupied(panels: PanelStateMap): PanelStateMap {
  if (centerOccupants(panels).length > 0) return panels;
  const id = CENTER_FALLBACK_PANEL_ID;
  console.log(`[Shell] center was empty; docking ${id} into it`);
  panels[id] = {
    ...panels[id],
    hidden: false,
    collapsed: false,
    mode: 'docked',
    preMaximizeState: null,
    docked: {
      ...panels[id].docked,
      region: 'center',
      orderInRegion: 0,
      tabGroupId: null,
      tabOrder: 0,
      tabActive: true,
    },
  };
  return panels;
}

export function normalizeDockSlots(panels: PanelStateMap): PanelStateMap {
  ensureCenterOccupied(panels);
  for (const region of DOCK_AREAS) {
    const slots = getRegionSlots(panels, region);
    slots.forEach((slot, slotIndex) => {
      // A slot's size is whatever its members agree on; when they disagree
      // (a panel just joined the group) the largest wins so nothing is clipped.
      const slotSize = Math.max(...slot.map((id) => panels[id].docked.sizeInRegion));
      const activeIndex = Math.max(0, slot.findIndex((id) => panels[id].docked.tabActive));
      slot.forEach((id, tabOrder) => {
        const current = panels[id].docked;
        const next: DockedPanelState = {
          region,
          orderInRegion: slotIndex,
          sizeInRegion: slotSize,
          // A slot of one carries no group id — collapsing it back to null
          // keeps "ungrouped" the single canonical representation.
          tabGroupId: slot.length > 1 ? (current.tabGroupId ?? slot[0]) : null,
          tabOrder,
          tabActive: tabOrder === activeIndex,
        };
        if (
          current.region !== next.region
          || current.orderInRegion !== next.orderInRegion
          || current.sizeInRegion !== next.sizeInRegion
          || current.tabGroupId !== next.tabGroupId
          || current.tabOrder !== next.tabOrder
          || current.tabActive !== next.tabActive
        ) {
          panels[id] = { ...panels[id], docked: next };
        }
      });
    });
  }
  return panels;
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

  // Focusing a background tab brings it to the front of its own slot; without
  // this a click routed by a shortcut could focus a panel nobody can see.
  if (updated[id].mode === 'docked' && !updated[id].hidden) {
    activateTabInPanelMap(updated, id);
  }

  return updated;
}

function activateTabInPanelMap(panels: PanelStateMap, id: PanelId): PanelStateMap {
  const target = panels[id];
  if (target.mode !== 'docked') return panels;
  const key = dockSlotKey(target);
  for (const panelId of PANEL_IDS) {
    const panel = panels[panelId];
    if (panel.mode !== 'docked') continue;
    if (panel.docked.region !== target.docked.region) continue;
    if (dockSlotKey(panel) !== key) continue;
    const shouldBeActive = panelId === id;
    if (panel.docked.tabActive !== shouldBeActive) {
      panels[panelId] = { ...panel, docked: { ...panel.docked, tabActive: shouldBeActive } };
    }
  }
  return panels;
}

function panelSnapshotForMaximize(panel: PanelState): Partial<PanelState> {
  return {
    hidden: panel.hidden,
    collapsed: panel.collapsed,
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
    && a.sizeInRegion === b.sizeInRegion
    && a.tabGroupId === b.tabGroupId
    && a.tabOrder === b.tabOrder
    && a.tabActive === b.tabActive;
}

function partialPanelStatesEqual(a: Partial<PanelState> | null, b: Partial<PanelState> | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.hidden === b.hidden
    && a.collapsed === b.collapsed
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
    && a.collapsed === b.collapsed
    && a.focused === b.focused
    && a.zIndex === b.zIndex
    && a.mode === b.mode
    && floatingPanelsEqual(a.floating, b.floating)
    && dockedPanelsEqual(a.docked, b.docked)
    && partialPanelStatesEqual(a.preMaximizeState, b.preMaximizeState);
}

export function panelMapsEqual(a: PanelStateMap, b: PanelStateMap): boolean {
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
  const next = normalizeDockSlots(producer(clonePanelStates(slice.panels)));
  scheduleLayoutPersistence(next, slice.dockRegionSizes);
  return next;
}

const MAX_RECENTLY_CLOSED = 12;

function pushRecentlyClosed(list: PanelId[], id: PanelId): PanelId[] {
  const next = list.filter((entry) => entry !== id);
  next.push(id);
  return next.length > MAX_RECENTLY_CLOSED ? next.slice(next.length - MAX_RECENTLY_CLOSED) : next;
}

export const usePanelRegistry = create<PanelRegistryState>((set) => ({
  panels: createInitialPanelStates(),
  dockRegionSizes: createInitialDockRegionSizes(),
  panelProps: {},
  recentlyClosed: [],

  openPanel: (id, props) => set((state) => {
    const panel = state.panels[id];
    const isDrawer = PANEL_CATALOG[id].presentation === 'drawer';
    const drawerAlreadyOpen = !isDrawer
      || (
        panel.mode === 'docked'
        && panel.docked.orderInRegion === 0
        && panel.preMaximizeState === null
      );
    const nextProps = props === undefined
      ? state.panelProps
      : { ...state.panelProps, [id]: props };
    const propsChanged = nextProps !== state.panelProps;
    if (!panel.hidden && !panel.collapsed && panel.focused && drawerAlreadyOpen) {
      return propsChanged ? { panelProps: nextProps } : state;
    }
    return {
      panelProps: nextProps,
      recentlyClosed: state.recentlyClosed.filter((entry) => entry !== id),
      panels: commitPanels(state, (draft) => {
        draft[id].hidden = false;
        // Opening an explicitly-collapsed panel expands it: the user asked to
        // see this panel, and handing them a titlebar would read as a no-op.
        draft[id].collapsed = false;
        if (isDrawer) {
          draft[id].mode = 'docked';
          draft[id].docked = { ...draft[id].docked, orderInRegion: 0 };
          draft[id].preMaximizeState = null;
        }
        return focusInPanelMap(draft, id);
      }),
    };
  }),

  closePanel: (id) => set((state) => {
    const panel = state.panels[id];
    if (panel.hidden && !panel.focused) return state;
    if (isPinnedToCenter(state.panels, id)) {
      console.log(`[Shell] close refused: ${id} is the only panel in the center`);
      return state;
    }
    return {
      recentlyClosed: pushRecentlyClosed(state.recentlyClosed, id),
      panels: commitPanels(state, (draft) => {
        draft[id].hidden = true;
        draft[id].focused = false;
        return draft;
      }),
    };
  }),

  togglePanel: (id, props) => {
    const { panels } = usePanelRegistry.getState();
    const panel = panels[id];
    if (panel.hidden) usePanelRegistry.getState().openPanel(id, props);
    // The center panel cannot close, so its toggle brings it forward instead of
    // silently doing nothing.
    else if (isPinnedToCenter(panels, id)) usePanelRegistry.getState().focusPanel(id);
    else usePanelRegistry.getState().closePanel(id);
  },

  reopenLastClosed: () => {
    const { recentlyClosed } = usePanelRegistry.getState();
    const id = recentlyClosed[recentlyClosed.length - 1];
    if (!id) return;
    usePanelRegistry.getState().openPanel(id);
  },

  setPanelProps: (id, props) => set((state) => ({
    panelProps: { ...state.panelProps, [id]: props },
  })),

  focusPanel: (id) => set((state) => {
    if (state.panels[id].hidden) return state;
    if (state.panels[id].focused && state.panels[id].docked.tabActive) return state;
    return {
      panels: commitPanels(state, (draft) => focusInPanelMap(draft, id)),
    };
  }),

  focusNextPanel: (direction) => set((state) => {
    const visible = PANEL_IDS.filter((id) => !state.panels[id].hidden);
    if (visible.length === 0) return state;
    const currentIndex = visible.findIndex((id) => state.panels[id].focused);
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + direction + visible.length) % visible.length;
    const nextId = visible[nextIndex];
    if (state.panels[nextId].focused && state.panels[nextId].docked.tabActive) return state;
    return {
      panels: commitPanels(state, (draft) => focusInPanelMap(draft, nextId)),
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

  dockPanel: (id, region, slotIndex) => set((state) => {
    const panel = state.panels[id];
    if (region !== 'center' && isPinnedToCenter(state.panels, id)) {
      console.log(`[Shell] dock refused: ${id} is the only panel in the center`);
      return state;
    }
    if (
      slotIndex === undefined
      && !panel.hidden
      && panel.mode === 'docked'
      && panel.docked.region === region
      && panel.docked.tabGroupId === null
      && panel.focused
    ) {
      return state;
    }
    return {
      panels: commitPanels(state, (draft) => {
        const slots = getRegionSlots(draft, region).filter((slot) => !slot.includes(id));
        // Fractional order slides the panel BETWEEN two existing slots;
        // normalizeDockSlots() compacts the result back to 0..n-1.
        const order = slotIndex === undefined
          ? slots.length
          : Math.max(0, Math.min(slotIndex, slots.length)) - 0.5;
        draft[id].hidden = false;
        draft[id].mode = 'docked';
        draft[id].docked = {
          ...draft[id].docked,
          region,
          orderInRegion: order,
          tabGroupId: null,
          tabOrder: 0,
          tabActive: true,
        };
        return focusInPanelMap(draft, id);
      }),
    };
  }),

  dockPanelAsTab: (id, targetId) => set((state) => {
    const target = state.panels[targetId];
    if (id === targetId) return state;
    if (target.hidden || target.mode !== 'docked') return state;
    if (target.docked.region !== 'center' && isPinnedToCenter(state.panels, id)) return state;
    return {
      panels: commitPanels(state, (draft) => {
        const groupId = draft[targetId].docked.tabGroupId ?? targetId;
        const existing = PANEL_IDS.filter((panelId) => (
          panelId !== id
          && !draft[panelId].hidden
          && draft[panelId].mode === 'docked'
          && dockSlotKey(draft[panelId]) === groupId
        ));
        // Adopt the target slot wholesale, then append at the end of its strip.
        draft[targetId].docked = { ...draft[targetId].docked, tabGroupId: groupId };
        draft[id].hidden = false;
        draft[id].mode = 'docked';
        draft[id].docked = {
          ...draft[id].docked,
          region: target.docked.region,
          orderInRegion: target.docked.orderInRegion,
          sizeInRegion: target.docked.sizeInRegion,
          tabGroupId: groupId,
          tabOrder: existing.length,
          tabActive: true,
        };
        const focused = focusInPanelMap(draft, id);
        return activateTabInPanelMap(focused, id);
      }),
    };
  }),

  activateTab: (id) => set((state) => {
    const panel = state.panels[id];
    if (panel.hidden || panel.mode !== 'docked') return state;
    if (panel.docked.tabActive && panel.focused) return state;
    return {
      panels: commitPanels(state, (draft) => {
        const focused = focusInPanelMap(draft, id);
        return activateTabInPanelMap(focused, id);
      }),
    };
  }),

  undockPanel: (id, x, y) => set((state) => {
    const panel = state.panels[id];
    if (isPinnedToCenter(state.panels, id)) {
      console.log(`[Shell] pop-out refused: ${id} is the only panel in the center`);
      return state;
    }
    if (!panel.hidden && panel.mode === 'floating' && panel.floating.x === x && panel.floating.y === y && panel.focused) {
      return state;
    }
    return {
      panels: commitPanels(state, (draft) => {
        draft[id].hidden = false;
        draft[id].mode = 'floating';
        draft[id].floating = { ...draft[id].floating, x, y };
        // Leaving a tab group must not leave the group id behind, or the panel
        // would re-join that slot the next time it docks.
        draft[id].docked = { ...draft[id].docked, tabGroupId: null, tabOrder: 0, tabActive: true };
        return focusInPanelMap(draft, id);
      }),
    };
  }),

  maximizePanel: (id) => set((state) => {
    const panel = state.panels[id];
    if (panel.hidden || panel.mode === 'maximized') return state;
    if (PANEL_CATALOG[id].resizable === false) return state;
    return {
      panels: commitPanels(state, (draft) => {
        draft[id].hidden = false;
        draft[id].collapsed = false;
        draft[id].preMaximizeState = panelSnapshotForMaximize(panel);
        draft[id].mode = 'maximized';
        return focusInPanelMap(draft, id);
      }),
    };
  }),

  restorePanel: (id) => set((state) => {
    const panel = state.panels[id];
    const snapshot = panel.preMaximizeState;
    if (snapshot) {
      return {
        panels: commitPanels(state, (draft) => {
          draft[id] = {
            ...draft[id],
            ...clonePartialPanelState(snapshot),
            id,
            preMaximizeState: null,
          };
          return draft;
        }),
      };
    }
    // A maximized panel with no snapshot must still be escapable: every route
    // out of maximized (the titlebar control, the double-click, Escape) lands
    // here, so returning `state` would strand the panel over the whole
    // workarea for ever. Fall back to floating — the one mode that always
    // renders, is always draggable, and can be docked anywhere afterwards.
    if (panel.mode !== 'maximized') return state;
    return {
      panels: commitPanels(state, (draft) => {
        draft[id].mode = 'floating';
        draft[id].collapsed = false;
        return draft;
      }),
    };
  }),

  collapsePanel: (id) => set((state) => {
    const panel = state.panels[id];
    if (panel.hidden || panel.collapsed || panel.mode === 'maximized') return state;
    if (isPinnedToCenter(state.panels, id)) return state;
    return {
      panels: commitPanels(state, (draft) => {
        draft[id].collapsed = true;
        return draft;
      }),
    };
  }),

  expandPanel: (id) => set((state) => {
    if (!state.panels[id].collapsed) return state;
    return {
      panels: commitPanels(state, (draft) => {
        draft[id].collapsed = false;
        return draft;
      }),
    };
  }),

  toggleCollapsePanel: (id) => {
    const panel = usePanelRegistry.getState().panels[id];
    if (panel.collapsed) usePanelRegistry.getState().expandPanel(id);
    else usePanelRegistry.getState().collapsePanel(id);
  },

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

    // The splitter moves SLOTS, not panels: every tab in the slot must take the
    // new size or normalizeDockSlots() would widen it back to the group max.
    const beforeKey = dockSlotKey(beforePanel);
    const afterKey = dockSlotKey(afterPanel);
    return {
      panels: commitPanels(state, (draft) => {
        for (const panelId of PANEL_IDS) {
          if (draft[panelId].mode !== 'docked' || draft[panelId].docked.region !== region) continue;
          const key = dockSlotKey(draft[panelId]);
          if (key === beforeKey) {
            draft[panelId].docked = { ...draft[panelId].docked, sizeInRegion: nextSizes.beforeSize };
          } else if (key === afterKey) {
            draft[panelId].docked = { ...draft[panelId].docked, sizeInRegion: nextSizes.afterSize };
          }
        }
        return draft;
      }),
    };
  }),

  setSampleSelectorDockOpen: (open) => {
    if (open) usePanelRegistry.getState().openPanel('sampleSelector');
    else usePanelRegistry.getState().closePanel('sampleSelector');
  },

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
    const panels = normalizeDockSlots(clonePanelStates(preset.panels));
    const dockRegionSizes = { ...preset.dockRegionSizes };
    const current = usePanelRegistry.getState();
    if (panelMapsEqual(current.panels, panels) && dockRegionSizesEqual(current.dockRegionSizes, dockRegionSizes)) {
      return;
    }
    scheduleLayoutPersistence(panels, dockRegionSizes);
    set({ panels, dockRegionSizes });
  },

  resetLayout: () => {
    const panels = createInitialPanelStates();
    const dockRegionSizes = createInitialDockRegionSizes();
    scheduleLayoutPersistence(panels, dockRegionSizes);
    set({ panels, dockRegionSizes, panelProps: {}, recentlyClosed: [] });
  },
}));

export default usePanelRegistry;
