import flCompose from '../presets/fl-compose.json';
import vegasArrange from '../presets/vegas-arrange.json';
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
  'fl-compose': flCompose as RawPreset,
  'vegas-arrange': vegasArrange as RawPreset,
};

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
