import {
  AudioWaveform,
  Clock3,
  Grid3x3,
  PanelLeft,
  Piano,
  SlidersHorizontal,
  Video,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

export const PANEL_IDS = [
  'timeline',
  'sampleSelector',
  'pianoRoll',
  'preview',
  'mixer',
  'gridSettings',
  'fxGraph',
  'nodeEditor',
  'sampler',
] as const;

export type PanelId = (typeof PANEL_IDS)[number];
export const QUARANTINED_PANEL_IDS = ['nodeEditor'] as const;
export const ACTIVE_PANEL_IDS = PANEL_IDS.filter(
  (id): id is Exclude<PanelId, (typeof QUARANTINED_PANEL_IDS)[number]> => (
    !QUARANTINED_PANEL_IDS.includes(id as (typeof QUARANTINED_PANEL_IDS)[number])
  ),
);

export type PanelTypeColorToken =
  | '--theme-panel-timeline'
  | '--theme-text-muted'
  | '--theme-panel-pianoroll'
  | '--theme-panel-preview'
  | '--theme-panel-mixer'
  | '--theme-panel-grid'
  | '--theme-panel-node';

export interface FloatingDimensions {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelCatalogEntry {
  id: PanelId;
  title: string;
  typeColorToken: PanelTypeColorToken;
  icon: LucideIcon;
  fKey: 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10' | 'F11' | 'F12';
  defaultFloating: FloatingDimensions;
  keepAliveWhenHidden: boolean;
}

export const PANEL_CATALOG = {
  timeline: {
    id: 'timeline',
    title: 'Timeline',
    typeColorToken: '--theme-panel-timeline',
    icon: Clock3,
    fKey: 'F5',
    defaultFloating: { x: 260, y: 60, width: 1200, height: 480 },
    keepAliveWhenHidden: true,
  },
  sampleSelector: {
    id: 'sampleSelector',
    title: 'Sample Selector',
    typeColorToken: '--theme-text-muted',
    icon: PanelLeft,
    fKey: 'F6',
    defaultFloating: { x: 24, y: 72, width: 300, height: 640 },
    keepAliveWhenHidden: false,
  },
  pianoRoll: {
    id: 'pianoRoll',
    title: 'Piano Roll',
    typeColorToken: '--theme-panel-pianoroll',
    icon: Piano,
    fKey: 'F7',
    defaultFloating: { x: 320, y: 140, width: 960, height: 540 },
    keepAliveWhenHidden: false,
  },
  preview: {
    id: 'preview',
    title: 'Preview',
    typeColorToken: '--theme-panel-preview',
    icon: Video,
    fKey: 'F8',
    defaultFloating: { x: 400, y: 100, width: 640, height: 360 },
    keepAliveWhenHidden: true,
  },
  mixer: {
    id: 'mixer',
    title: 'Mixer',
    typeColorToken: '--theme-panel-mixer',
    icon: SlidersHorizontal,
    fKey: 'F9',
    defaultFloating: { x: 220, y: 420, width: 1040, height: 320 },
    keepAliveWhenHidden: false,
  },
  gridSettings: {
    id: 'gridSettings',
    title: 'Grid Settings',
    typeColorToken: '--theme-panel-grid',
    icon: Grid3x3,
    fKey: 'F10',
    defaultFloating: { x: 300, y: 120, width: 520, height: 720 },
    keepAliveWhenHidden: false,
  },
  fxGraph: {
    id: 'fxGraph',
    title: 'FX Graph',
    typeColorToken: '--theme-panel-node',
    icon: Workflow,
    fKey: 'F11',
    defaultFloating: { x: 360, y: 120, width: 980, height: 640 },
    keepAliveWhenHidden: false,
  },
  nodeEditor: {
    id: 'nodeEditor',
    title: 'Node Editor',
    typeColorToken: '--theme-panel-node',
    icon: Workflow,
    fKey: 'F11',
    defaultFloating: { x: 400, y: 160, width: 900, height: 600 },
    keepAliveWhenHidden: false,
  },
  sampler: {
    id: 'sampler',
    title: 'Sampler',
    typeColorToken: '--theme-panel-mixer',
    icon: AudioWaveform,
    fKey: 'F12',
    defaultFloating: { x: 340, y: 100, width: 680, height: 520 },
    keepAliveWhenHidden: false,
  },
} satisfies Record<PanelId, PanelCatalogEntry>;

export const PANEL_CATALOG_ORDER = ACTIVE_PANEL_IDS.map((id) => PANEL_CATALOG[id]);

export function panelTypeColorVar(id: PanelId): string {
  return `var(${PANEL_CATALOG[id].typeColorToken})`;
}
