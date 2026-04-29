import flCompose from '../presets/fl-compose.json';
import gridEdit from '../presets/grid-edit.json';
import vegasArrange from '../presets/vegas-arrange.json';
import {
  DEFAULT_DOCK_REGION_SIZES,
  type DockRegionSizes,
  type PanelStateMap,
} from '../registry/PanelRegistry';

export interface Preset {
  panels: PanelStateMap;
  dockRegionSizes: DockRegionSizes;
}

interface RawPreset {
  panels?: unknown;
  dockRegionSizes?: unknown;
}

const RAW_PRESETS: Record<string, RawPreset> = {
  'fl-compose': flCompose as RawPreset,
  'vegas-arrange': vegasArrange as RawPreset,
  'grid-edit': gridEdit as RawPreset,
};

function normalizeDockRegionSizes(value: unknown): DockRegionSizes {
  if (!value || typeof value !== 'object') return { ...DEFAULT_DOCK_REGION_SIZES };
  const raw = value as Partial<Record<keyof DockRegionSizes, unknown>>;
  return {
    left: typeof raw.left === 'number' ? raw.left : DEFAULT_DOCK_REGION_SIZES.left,
    right: typeof raw.right === 'number' ? raw.right : DEFAULT_DOCK_REGION_SIZES.right,
    top: typeof raw.top === 'number' ? raw.top : DEFAULT_DOCK_REGION_SIZES.top,
    bottom: typeof raw.bottom === 'number' ? raw.bottom : DEFAULT_DOCK_REGION_SIZES.bottom,
  };
}

export function loadPreset(presetId: string): Preset | null {
  const raw = RAW_PRESETS[presetId];
  if (!raw || !raw.panels || typeof raw.panels !== 'object') return null;
  return {
    panels: raw.panels as PanelStateMap,
    dockRegionSizes: normalizeDockRegionSizes(raw.dockRegionSizes),
  };
}
