import { PANEL_CATALOG, PANEL_IDS, isPanelId, type PanelId } from './panelCatalog';
import type {
  DockArea,
  DockRegion,
  DockRegionSizes,
  DockedPanelState,
  FloatingPanelState,
  PanelMode,
  PanelState,
  PanelStateMap,
} from './PanelRegistry';

// Field-by-field merge of an UNTRUSTED partial layout onto a known-good base.
//
// Both consumers — sparse preset JSON and the persisted layout on disk — are
// data the registry must not take on faith. Every field is validated
// individually and a bad one falls back to the base value instead of
// discarding the whole layout, so a corrupt `floating.x` costs the user one
// coordinate rather than their entire arrangement, and a panel id added after
// the layout was written simply keeps its defaults.

const PANEL_MODES: readonly PanelMode[] = ['floating', 'docked', 'maximized'];
/** Modes a maximized panel may restore INTO — 'maximized' is not one of them. */
const RESTORABLE_MODES: readonly PanelMode[] = ['floating', 'docked'];
const DOCK_REGION_NAMES: readonly DockRegion[] = ['left', 'right', 'top', 'bottom'];
/** Where a docked panel may live: the four edges plus the center. */
const DOCK_AREA_NAMES: readonly DockArea[] = [...DOCK_REGION_NAMES, 'center'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T
    : fallback;
}

function mergeFloating(
  base: FloatingPanelState,
  overlay: unknown,
  id: PanelId,
): FloatingPanelState {
  if (!isRecord(overlay)) return base;
  const entry = PANEL_CATALOG[id];
  return {
    x: pickFinite(overlay.x, base.x),
    y: pickFinite(overlay.y, base.y),
    // A persisted width below the panel's own minimum would render a frame the
    // resize machine immediately refuses to reproduce; clamp on the way in.
    width: Math.max(entry.minWidth, pickFinite(overlay.width, base.width)),
    height: Math.max(entry.minHeight, pickFinite(overlay.height, base.height)),
  };
}

function mergeDocked(base: DockedPanelState, overlay: unknown, id: PanelId): DockedPanelState {
  if (!isRecord(overlay)) return base;
  const rawTabGroup = overlay.tabGroupId;
  // A drawer is edge-mounted by definition; it can never be the work area.
  const areas: readonly DockArea[] = PANEL_CATALOG[id].presentation === 'drawer' ? DOCK_REGION_NAMES : DOCK_AREA_NAMES;
  return {
    region: pickEnum(overlay.region, areas, base.region),
    orderInRegion: Math.max(0, Math.round(pickFinite(overlay.orderInRegion, base.orderInRegion))),
    sizeInRegion: Math.max(
      PANEL_CATALOG[id].minDockedSize,
      pickFinite(overlay.sizeInRegion, base.sizeInRegion),
    ),
    // A tab group is keyed by the panel id that founded it, so anything that is
    // not a live panel id is meaningless and drops the panel back to its own slot.
    tabGroupId: isPanelId(rawTabGroup) ? rawTabGroup : null,
    tabOrder: Math.max(0, Math.round(pickFinite(overlay.tabOrder, base.tabOrder))),
    tabActive: pickBoolean(overlay.tabActive, base.tabActive),
  };
}

// The restore target a maximized panel came from. Validated field-by-field
// like the rest of the layout, and never itself maximized — restoring into
// "maximized" would be a dead end.
function mergePreMaximizeState(base: PanelState, overlay: unknown): Partial<PanelState> | null {
  if (!isRecord(overlay)) return null;
  const id = base.id;
  const entry = PANEL_CATALOG[id];
  const mode = entry.presentation === 'drawer'
    ? 'docked'
    : pickEnum(overlay.mode, RESTORABLE_MODES, 'floating');
  return {
    hidden: pickBoolean(overlay.hidden, base.hidden),
    collapsed: pickBoolean(overlay.collapsed, base.collapsed),
    focused: pickBoolean(overlay.focused, base.focused),
    zIndex: Math.max(0, Math.round(pickFinite(overlay.zIndex, base.zIndex))),
    mode,
    floating: mergeFloating(base.floating, overlay.floating, id),
    docked: mergeDocked(base.docked, overlay.docked, id),
  };
}

export function mergePanelState(base: PanelState, overlay: unknown): PanelState {
  if (!isRecord(overlay)) return base;
  const id = base.id;
  const entry = PANEL_CATALOG[id];

  let mode = pickEnum(overlay.mode, PANEL_MODES, base.mode);
  // Catalog rules outrank stored state: a drawer is never a floating window,
  // and a fixed-size panel can never come back maximized.
  if (entry.presentation === 'drawer') mode = 'docked';
  if (entry.resizable === false && mode === 'maximized') mode = 'floating';

  // preMaximizeState is what restorePanel() un-maximizes INTO, so it has to
  // survive the round-trip: dropping it used to reload a maximized panel with
  // nothing to restore to, and restorePanel — the control, the titlebar
  // double-click and Escape alike — became a permanent no-op. It is only
  // meaningful while the panel is maximized; a stale one on a floating or
  // docked panel is dropped.
  const preMaximizeState = mode === 'maximized'
    ? mergePreMaximizeState(base, overlay.preMaximizeState)
    : null;
  // Invariant the whole restore path assumes: maximized implies a restore
  // target. A layout that has lost one (older builds wrote null here) comes
  // back un-maximized rather than stuck.
  if (mode === 'maximized' && !preMaximizeState) mode = 'floating';

  return {
    id,
    hidden: pickBoolean(overlay.hidden, base.hidden),
    collapsed: pickBoolean(overlay.collapsed, base.collapsed),
    focused: pickBoolean(overlay.focused, base.focused),
    zIndex: Math.max(0, Math.round(pickFinite(overlay.zIndex, base.zIndex))),
    mode,
    floating: mergeFloating(base.floating, overlay.floating, id),
    docked: mergeDocked(base.docked, overlay.docked, id),
    preMaximizeState,
  };
}

export function mergePanelStateMap(base: PanelStateMap, overlay: unknown): PanelStateMap {
  const source = isRecord(overlay) ? overlay : {};
  return PANEL_IDS.reduce((acc, id) => {
    acc[id] = mergePanelState(base[id], source[id]);
    return acc;
  }, {} as PanelStateMap);
}

export function mergeDockRegionSizes(
  base: DockRegionSizes,
  overlay: unknown,
  minimums: DockRegionSizes,
): DockRegionSizes {
  const source = isRecord(overlay) ? overlay : {};
  return DOCK_REGION_NAMES.reduce((acc, region) => {
    acc[region] = Math.max(minimums[region], pickFinite(source[region], base[region]));
    return acc;
  }, {} as DockRegionSizes);
}

/**
 * Exactly one panel may be focused. Assigns z-order so the focused panel is on
 * top and every other visible panel keeps its relative stacking.
 */
export function normalizeFocus(panels: PanelStateMap, preferredId?: PanelId | null): PanelStateMap {
  const candidates = PANEL_IDS.filter((id) => !panels[id].hidden);
  const focusedId = (preferredId && !panels[preferredId].hidden)
    ? preferredId
    : candidates.find((id) => panels[id].focused) ?? candidates[0] ?? null;

  const ranked = PANEL_IDS.slice().sort((a, b) => panels[a].zIndex - panels[b].zIndex);
  const next = { ...panels };
  ranked.forEach((id, index) => {
    next[id] = { ...next[id], focused: id === focusedId, zIndex: index + 1 };
  });
  if (focusedId) {
    next[focusedId] = { ...next[focusedId], zIndex: PANEL_IDS.length + 1 };
  }
  return next;
}
