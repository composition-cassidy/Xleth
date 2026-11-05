import {
  AudioWaveform,
  FlaskConical,
  Music2,
  PanelLeft,
  PanelRight,
  Scissors,
  Video,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { ComponentType } from 'react';
import {
  FxGraphGlyphIcon,
  MixerGlyphIcon,
  PianoRollGlyphIcon,
  TimelineGlyphIcon,
  type GlyphIconProps,
} from './panelGlyphs';

export const PANEL_IDS = [
  'timeline',
  'sampleSelector',
  'pianoRoll',
  'preview',
  'mixer',
  'fxGraph',
  'nodeEditor',
  'sampler',
  'quickNotation',
  'splitSyllables',
  'sampleSandbox',
  'inspector',
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

export type PanelFKey = 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10' | 'F11' | 'F12';

// How the shell presents a panel. 'window' is the default: a real frame that can
// float, dock into a region, tab with its neighbours, or maximize. 'drawer'
// panels are edge-mounted slide-outs owned by their own host component — they
// never float, never join a tab group, and are excluded from the dock regions.
export type PanelPresentation = 'window' | 'drawer';

export type PanelTypeColorToken =
  | '--theme-panel-timeline'
  | '--theme-text-muted'
  | '--theme-panel-pianoroll'
  | '--theme-panel-preview'
  | '--theme-panel-mixer'
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
  icon: LucideIcon | ComponentType<GlyphIconProps>;
  // The single declaration of this panel's function-key toggle. KeyboardManager
  // generates its bindings from these — there is no second hand-written mapping.
  // A collision throws at module load (see PANEL_FKEY_BINDINGS below).
  fKey?: PanelFKey;
  defaultFloating: FloatingDimensions;
  keepAliveWhenHidden: boolean;
  // When false, the panel opens at a fixed size and cannot be resized or
  // maximized: no resize handles, no maximize control, no double-click maximize.
  // Omitted (undefined) means resizable, the default for every other panel.
  resizable?: boolean;
  // Smallest floating size the resize machine will allow.
  minWidth: number;
  minHeight: number;
  // Smallest extent along a dock region's main axis when this panel shares the
  // region with another (the splitter clamp).
  minDockedSize: number;
  presentation: PanelPresentation;
  // When docked, this panel's slot takes the space its region has left over
  // (the region's fill slot) instead of keeping a stored size. Without any
  // dockFill panel in a region, its last open slot fills. Media views set it so
  // the arrangement and the picture get the room, not the side panels.
  dockFill?: boolean;
  // Whether the top bar offers a visibility toggle for this panel. Drawers are
  // excluded automatically (they carry their own edge tab); set this false for
  // a panel that is only ever opened from a context menu and would be noise in
  // a toolbar of primary workspaces.
  showInToolbar?: boolean;
  // A quarantined panel keeps its id (persisted layouts still reference it) but
  // is never offered in the shell: no toggle, no F-key, no production render.
  quarantined?: boolean;
}

export const PANEL_CATALOG = {
  timeline: {
    id: 'timeline',
    title: 'Timeline',
    typeColorToken: '--theme-panel-timeline',
    icon: TimelineGlyphIcon,
    fKey: 'F5',
    defaultFloating: { x: 260, y: 60, width: 1200, height: 480 },
    keepAliveWhenHidden: true,
    minWidth: 280,
    minHeight: 120,
    minDockedSize: 240,
    presentation: 'window',
    dockFill: true,
  },
  sampleSelector: {
    id: 'sampleSelector',
    title: 'Sample Selector',
    typeColorToken: '--theme-text-muted',
    icon: PanelLeft,
    fKey: 'F6',
    defaultFloating: { x: 24, y: 72, width: 300, height: 640 },
    keepAliveWhenHidden: false,
    minWidth: 280,
    minHeight: 120,
    minDockedSize: 220,
    // Edge drawer, not a window: SampleSelectorDrawer owns its chrome and the
    // shell reserves a dock-width CSS variable for it.
    presentation: 'drawer',
  },
  pianoRoll: {
    id: 'pianoRoll',
    title: 'Piano Roll',
    typeColorToken: '--theme-panel-pianoroll',
    icon: PianoRollGlyphIcon,
    fKey: 'F7',
    defaultFloating: { x: 320, y: 140, width: 960, height: 540 },
    keepAliveWhenHidden: false,
    minWidth: 280,
    minHeight: 120,
    minDockedSize: 220,
    presentation: 'window',
  },
  preview: {
    id: 'preview',
    title: 'Preview',
    typeColorToken: '--theme-panel-preview',
    icon: Video,
    fKey: 'F8',
    defaultFloating: { x: 400, y: 100, width: 640, height: 360 },
    keepAliveWhenHidden: true,
    minWidth: 280,
    minHeight: 120,
    minDockedSize: 180,
    presentation: 'window',
    dockFill: true,
  },
  mixer: {
    id: 'mixer',
    title: 'Mixer',
    typeColorToken: '--theme-panel-mixer',
    icon: MixerGlyphIcon,
    fKey: 'F9',
    // +176 over the pre-loudness-meter default: the meter is a third pinned
    // column beside the rack and master strip, and without the extra width it
    // would eat the track area on a fresh layout.
    defaultFloating: { x: 220, y: 420, width: 1216, height: 320 },
    keepAliveWhenHidden: false,
    minWidth: 280,
    // The rack + master strip + loudness meter stop being usable below this.
    minHeight: 260,
    minDockedSize: 260,
    presentation: 'window',
  },
  fxGraph: {
    id: 'fxGraph',
    title: 'FX Graph',
    typeColorToken: '--theme-panel-node',
    icon: FxGraphGlyphIcon,
    fKey: 'F11',
    defaultFloating: { x: 360, y: 120, width: 980, height: 640 },
    keepAliveWhenHidden: false,
    minWidth: 280,
    minHeight: 120,
    minDockedSize: 240,
    presentation: 'window',
  },
  nodeEditor: {
    id: 'nodeEditor',
    title: 'Node Editor',
    typeColorToken: '--theme-panel-node',
    icon: Workflow,
    // No fKey: quarantined panels get no shortcut, and F11 belongs to fxGraph.
    defaultFloating: { x: 400, y: 160, width: 900, height: 600 },
    keepAliveWhenHidden: false,
    minWidth: 280,
    minHeight: 120,
    minDockedSize: 200,
    presentation: 'window',
    // NodeEditor.jsx can mutate live graph topology and must not return before
    // graphState and the FXG.2C gates.
    quarantined: true,
  },
  sampler: {
    id: 'sampler',
    title: 'Sampler',
    typeColorToken: '--theme-panel-mixer',
    icon: AudioWaveform,
    fKey: 'F12',
    // Fixed size per the mockup — see resizable:false below. Sized to the main
    // tab's actual content rather than guessed: 820 wide because the mockup's
    // two-column work row needs ~200px for the prep/process/minis column and
    // the waveform should not end up narrower than it was before the rework;
    // 870 tall because the measured content is ~797px plus 62px of chrome (tab
    // bar + audition bar), and the whole point of the rework was that the main
    // tab stops scrolling. A 3- or 4-instance MANGLE chain still overflows, as
    // it always will — that is the unusual case, not the default one.
    defaultFloating: { x: 340, y: 100, width: 820, height: 870 },
    keepAliveWhenHidden: false,
    resizable: false,
    minWidth: 280,
    minHeight: 120,
    minDockedSize: 220,
    presentation: 'window',
  },
  quickNotation: {
    id: 'quickNotation',
    title: 'Quick Notation',
    typeColorToken: '--theme-text-muted',
    icon: Music2,
    // Opened from the piano roll's notation entry, never from the toolbar.
    showInToolbar: false,
    defaultFloating: { x: 360, y: 140, width: 480, height: 314 },
    keepAliveWhenHidden: false,
    minWidth: 280,
    minHeight: 120,
    minDockedSize: 220,
    presentation: 'window',
  },
  splitSyllables: {
    id: 'splitSyllables',
    title: 'Split Syllables',
    typeColorToken: '--theme-text-muted',
    icon: Scissors,
    // Context-opened from a sample row (no F-key). keepAliveWhenHidden keeps the
    // cached waveform mipmap + marker edits alive across close/reopen.
    defaultFloating: { x: 140, y: 160, width: 1000, height: 352 },
    keepAliveWhenHidden: true,
    minWidth: 280,
    minHeight: 120,
    minDockedSize: 220,
    presentation: 'window',
  },
  sampleSandbox: {
    id: 'sampleSandbox',
    title: 'Sample Sandbox',
    typeColorToken: '--theme-panel-mixer',
    icon: FlaskConical,
    fKey: 'F10',
    defaultFloating: { x: 200, y: 90, width: 1180, height: 640 },
    keepAliveWhenHidden: false,
    minWidth: 280,
    minHeight: 120,
    minDockedSize: 320,
    presentation: 'window',
  },
  inspector: {
    id: 'inspector',
    title: 'Inspector',
    typeColorToken: '--theme-text-muted',
    icon: PanelRight,
    // No fKey: F5-F12 are all taken and shortcuts do not change in Phase 1.
    defaultFloating: { x: 420, y: 80, width: 340, height: 480 },
    keepAliveWhenHidden: false,
    minWidth: 280,
    minHeight: 120,
    minDockedSize: 260,
    presentation: 'window',
  },
} satisfies Record<PanelId, PanelCatalogEntry>;

export const QUARANTINED_PANEL_IDS: PanelId[] = PANEL_IDS.filter(
  (id) => PANEL_CATALOG[id].quarantined === true,
);

// Every panel the shell is allowed to render, toggle, or bind a key to.
export const ACTIVE_PANEL_IDS: PanelId[] = PANEL_IDS.filter((id) => !PANEL_CATALOG[id].quarantined);

// Panels that live in a dock region or float. Drawer panels are hosted by their
// own component and are excluded from both layers.
export const WINDOW_PANEL_IDS: PanelId[] = ACTIVE_PANEL_IDS.filter(
  (id) => PANEL_CATALOG[id].presentation === 'window',
);

export const DRAWER_PANEL_IDS: PanelId[] = PANEL_IDS.filter(
  (id) => PANEL_CATALOG[id].presentation === 'drawer',
);

export const PANEL_CATALOG_ORDER = ACTIVE_PANEL_IDS.map((id) => PANEL_CATALOG[id]);

// Panels the top bar offers a toggle for.
export const TOOLBAR_PANEL_IDS: PanelId[] = WINDOW_PANEL_IDS.filter(
  (id) => PANEL_CATALOG[id].showInToolbar !== false,
);

// Generated from the catalog so an fKey is declared exactly once. A duplicate is
// a programming error that silently costs one panel its shortcut, so it throws
// at module load rather than letting the later entry quietly win.
export const PANEL_FKEY_BINDINGS: ReadonlyMap<PanelFKey, PanelId> = (() => {
  const bindings = new Map<PanelFKey, PanelId>();
  for (const id of ACTIVE_PANEL_IDS) {
    const { fKey } = PANEL_CATALOG[id];
    if (!fKey) continue;
    const existing = bindings.get(fKey);
    if (existing) {
      throw new Error(
        `panelCatalog: ${fKey} is claimed by both "${existing}" and "${id}". `
        + 'Each function key may bind exactly one panel.',
      );
    }
    bindings.set(fKey, id);
  }
  return bindings;
})();

export function panelTypeColorVar(id: PanelId): string {
  return `var(${PANEL_CATALOG[id].typeColorToken})`;
}

export function isPanelId(value: unknown): value is PanelId {
  return typeof value === 'string' && (PANEL_IDS as readonly string[]).includes(value);
}
