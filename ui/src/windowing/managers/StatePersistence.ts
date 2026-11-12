import {
  clearLayoutPersistenceWriter,
  createInitialDockRegionSizes,
  createInitialPanelStates,
  MIN_DOCK_REGION_SIZES,
  normalizeDockSlots,
  setLayoutPersistenceWriter,
  usePanelRegistry,
  type DockRegionSizes,
  type LayoutPersistenceWriter,
  type PanelStateMap,
} from '../registry/PanelRegistry';
import {
  mergeDockRegionSizes,
  mergePanelStateMap,
  normalizeFocus,
} from '../registry/panelStateMerge';
import { DEFAULT_PRESET_ID, loadPreset } from './PresetManager';
import { PANEL_CATALOG, PANEL_IDS, opensFloating } from '../registry/panelCatalog';

// v3 added collapsed panels and dock tab groups. v4 is the tiled shell: a
// mandatory center and a tabbed detail dock. Envelopes from v4 on are merged
// field-by-field over the current defaults, so a later version that only adds
// fields keeps the user's arrangement.
// v5: the Sampler opens as its own window (catalog `opensFloating`). A v4 layout
// holds it as a bottom-dock tab at the old fixed 820x870 float size, so loading
// one moves it to its window once; where the user puts it afterwards is kept.
export const LAYOUT_SCHEMA_VERSION = 5;

/** First version whose saved position for an `opensFloating` panel is the user's own. */
export const FLOATING_TAB_LAYOUT_VERSION = 5;

// Below this, a saved layout was arranged for the floating-timeline shell.
// Merging it would rebuild that shell (a floating arrangement over an empty
// work area), so it is replaced once by the default layout instead.
export const FIRST_TILED_LAYOUT_VERSION = 4;

interface PersistenceAdapter {
  read(): Promise<string | null>;
  write(data: string): Promise<void>;
}

interface PersistedLayoutEnvelope {
  version: number;
  panels: PanelStateMap;
  dockRegionSizes: DockRegionSizes;
}

export const noOpAdapter = {
  async read(): Promise<string | null> {
    return null;
  },

  async write(_data: string): Promise<void> {},
};

export class MemoryAdapter {
  private store = new Map<string, string>();

  async read(): Promise<string | null> {
    return this.store.get('layout') ?? null;
  }

  async write(data: string): Promise<void> {
    this.store.set('layout', data);
  }
}

export class ElectronAdapter {
  async read(): Promise<string | null> {
    if (typeof window === 'undefined') return null;

    const raw = await (window as typeof window & { xleth?: any }).xleth?.layout?.read?.();
    return typeof raw === 'string' ? raw : null;
  }

  async write(data: string): Promise<void> {
    if (typeof window === 'undefined') return;
    await (window as typeof window & { xleth?: any }).xleth?.layout?.write?.(data);
  }
}

let currentAdapter: PersistenceAdapter = noOpAdapter;

export function setPersistenceAdapter(adapter: PersistenceAdapter): void {
  currentAdapter = adapter;
}

function serializeLayoutEnvelope(panels: PanelStateMap, dockRegionSizes: DockRegionSizes): string {
  const payload: PersistedLayoutEnvelope = {
    version: LAYOUT_SCHEMA_VERSION,
    panels,
    dockRegionSizes,
  };
  return JSON.stringify(payload);
}

export function init(): void {
  const writer: LayoutPersistenceWriter = (panels, dockRegionSizes) => {
    void currentAdapter.write(serializeLayoutEnvelope(panels, dockRegionSizes));
  };

  setLayoutPersistenceWriter(writer);
}

export function destroy(): void {
  setLayoutPersistenceWriter(null);
  clearLayoutPersistenceWriter();
}

/**
 * Rebuild a live layout from persisted JSON.
 *
 * The old contract was all-or-nothing: any panel id missing from the envelope
 * threw the WHOLE layout away, which meant every release that added a panel
 * silently reset every user's arrangement. Now the envelope is merged over the
 * current defaults, so unknown ids are ignored, missing ids keep their
 * defaults, and one bad field costs one field.
 *
 * Returns false only when there is genuinely nothing to restore (no saved
 * layout, or bytes that are not JSON at all).
 */
export async function loadPersistedState(): Promise<boolean> {
  const raw = await currentAdapter.read();
  if (raw === null) return false;

  let parsed: Partial<PersistedLayoutEnvelope>;
  try {
    parsed = JSON.parse(raw) as Partial<PersistedLayoutEnvelope>;
  } catch {
    // Corrupt bytes leave the live registry untouched.
    return false;
  }

  if (typeof parsed !== 'object' || parsed === null) return false;
  if (typeof parsed.panels !== 'object' || parsed.panels === null) return false;

  const version = typeof parsed.version === 'number' ? parsed.version : 0;
  if (version < FIRST_TILED_LAYOUT_VERSION) {
    const preset = loadPreset(DEFAULT_PRESET_ID);
    if (preset) {
      const panels = normalizeDockSlots(normalizeFocus(preset.panels));
      usePanelRegistry.setState({ panels, dockRegionSizes: preset.dockRegionSizes });
      // Written now rather than on the next edit, so the migration happens
      // exactly once even if the user changes nothing this session.
      await currentAdapter.write(serializeLayoutEnvelope(panels, preset.dockRegionSizes));
      console.log(`[Shell] layout v${version} -> v${LAYOUT_SCHEMA_VERSION}: migrated to ${DEFAULT_PRESET_ID}`);
      return true;
    }
  }

  const merged = mergePanelStateMap(createInitialPanelStates(), parsed.panels);
  const floatsTabs = version < FLOATING_TAB_LAYOUT_VERSION;
  if (floatsTabs) {
    for (const id of PANEL_IDS) {
      if (!opensFloating(id)) continue;
      merged[id] = {
        ...merged[id],
        mode: 'floating',
        floating: { ...PANEL_CATALOG[id].defaultFloating },
        docked: { ...merged[id].docked, tabGroupId: null, tabOrder: 0, tabActive: true },
        preMaximizeState: null,
      };
    }
  }
  // Slot invariants are re-derived rather than trusted: a persisted tab group
  // whose other members are now hidden collapses back to a plain slot.
  const panels = normalizeDockSlots(normalizeFocus(merged));
  const dockRegionSizes = mergeDockRegionSizes(
    createInitialDockRegionSizes(),
    parsed.dockRegionSizes,
    MIN_DOCK_REGION_SIZES,
  );
  usePanelRegistry.setState({ panels, dockRegionSizes });
  if (floatsTabs) {
    // Written now, so the move happens exactly once: a Sampler the user docks
    // afterwards is not floated again by the next launch.
    await currentAdapter.write(serializeLayoutEnvelope(panels, dockRegionSizes));
    console.log(`[Shell] layout v${version} -> v${LAYOUT_SCHEMA_VERSION}: the Sampler opens in its own window`);
  }
  return true;
}
