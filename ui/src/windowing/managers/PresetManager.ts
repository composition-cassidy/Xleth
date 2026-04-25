import flCompose from '../presets/fl-compose.json';
import gridEdit from '../presets/grid-edit.json';
import vegasArrange from '../presets/vegas-arrange.json';
import type { PanelStateMap } from '../registry/PanelRegistry';

const PRESETS: Record<string, PanelStateMap> = {
  'fl-compose': flCompose as unknown as PanelStateMap,
  'vegas-arrange': vegasArrange as unknown as PanelStateMap,
  'grid-edit': gridEdit as unknown as PanelStateMap,
};

export function loadPreset(presetId: string): PanelStateMap | null {
  return PRESETS[presetId] ?? null;
}
