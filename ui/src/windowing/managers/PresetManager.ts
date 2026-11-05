import flCompose from '../presets/fl-compose.json';
import vegasArrange from '../presets/vegas-arrange.json';
import xlethArrange from '../presets/xleth-arrange.json';
import {
  createInitialDockRegionSizes,
  createInitialPanelStates,
  MIN_DOCK_REGION_SIZES,
  type DockRegionSizes,
  type PanelStateMap,
} from '../registry/PanelRegistry';
import { isPanelId } from '../registry/panelCatalog';
import {
  mergeDockRegionSizes,
  mergePanelStateMap,
  normalizeFocus,
} from '../registry/panelStateMerge';

export interface Preset {
  panels: PanelStateMap;
  dockRegionSizes: DockRegionSizes;
}

// A preset is a SPARSE overlay: it states only what the layout decides and
// inherits everything else from the catalog defaults. Panels it does not
// mention stay closed at their default geometry, so adding a panel to the
// catalog can never leave a preset half-populated — and, just as importantly,
// a preset stops freezing a copy of every panel's default size the day it was
// written.
interface RawPreset {
  focused?: unknown;
  panels?: unknown;
  dockRegionSizes?: unknown;
}

const RAW_PRESETS: Record<string, RawPreset> = {
  'xleth-arrange': xlethArrange as RawPreset,
  'fl-compose': flCompose as RawPreset,
  'vegas-arrange': vegasArrange as RawPreset,
};

/** The layout a fresh install, a migrated layout and "Reset layout" land on. */
export const DEFAULT_PRESET_ID = 'xleth-arrange';

export interface LayoutPresetEntry {
  id: string;
  /** Menu label. Says what the layout IS, not where its name came from. */
  label: string;
}

// View -> Layouts, in menu order. The two older presets keep their ids (and
// their Ctrl+Shift+1/2 shortcuts); only their labels changed, because neither
// floats the arrangement any more: each now differs from the default by the
// one window it pops out.
export const LAYOUT_PRESETS: readonly LayoutPresetEntry[] = [
  { id: 'xleth-arrange', label: 'Tiled (default)' },
  { id: 'fl-compose', label: 'Floating mixer' },
  { id: 'vegas-arrange', label: 'Floating preview' },
];

export function listPresetIds(): string[] {
  return Object.keys(RAW_PRESETS);
}

export function loadPreset(presetId: string): Preset | null {
  const raw = RAW_PRESETS[presetId];
  if (!raw) return null;

  const panels = mergePanelStateMap(createInitialPanelStates(), raw.panels);
  const focused = isPanelId(raw.focused) ? raw.focused : null;

  return {
    panels: normalizeFocus(panels, focused),
    dockRegionSizes: mergeDockRegionSizes(
      createInitialDockRegionSizes(),
      raw.dockRegionSizes,
      MIN_DOCK_REGION_SIZES,
    ),
  };
}
