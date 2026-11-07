// The one source for Xleth's neutral chrome (ui/DESIGN.md section 3). Dark, light
// and high-contrast are three rows of the same table; deriveTheme() builds every
// `--theme-ui-*` ramp and semantic token from the row a theme names (or the row it
// is inferred to belong to), so no shipped theme has to hand-write a surface.
//
// A ramp is expressed as signed lightness steps (HSL L, percentage points) from the
// theme's own base tokens, not as fixed hexes, so a custom theme that changes
// bg-surface or text still gets a coherent ramp. Hue and saturation are inherited
// from the base: a neutral base yields a neutral ramp.
//
//   g0   = bg-primary            ground, wells, the surround of the Preview
//   g1   = bg-surface            panel
//   g2/g3 = bg-surface + step    header, control (raised)
//   g4   = bg-surface + step     divider, DECORATIVE ONLY (< 3:1 by design)
//   ink  = text                  primary text
//   ink-2/ink-3/boundary = text + step   (always moving toward the surface)
//
// Contrast floors (checked per ramp in ui-kit/__tests__/themes.test.ts):
//   ink, ink-2, ink-3 >= 4.5:1 on g0..g3; boundary >= 3:1 on g0..g3 (>= 7:1 in hc);
//   every semantic text token >= 4.5:1 on g0..g3 (>= 7:1 in hc); rec is fills/glyphs
//   only (>= 3:1), rec-text is its text colour.

export type RampName = 'dark' | 'light' | 'hc';

export const RAMP_NAMES: ReadonlyArray<RampName> = ['dark', 'light', 'hc'];

export interface RampSpec {
  name: RampName;
  /** Which way "raised" goes. Used only to word editor hints; the steps carry the sign. */
  polarity: 'dark' | 'light';
  /** The base tokens this ramp ships with (a theme that omits a base gets these). */
  base: {
    '--theme-bg-primary': string;
    '--theme-bg-surface': string;
    '--theme-text': string;
    '--theme-accent': string;
    '--theme-danger': string;
  };
  /** Signed HSL-L steps in percentage points. */
  steps: {
    g2: number;
    g3: number;
    g4: number;
    ink2: number;
    ink3: number;
    boundary: number;
  };
  /** Semantic and signal colours, validated per ramp. */
  semantic: {
    rec: string;
    recText: string;
    solo: string;
    signalAudio: string;
    signalEvents: string;
    signalParameter: string;
    signalVideo: string;
  };
}

export const RAMPS: Readonly<Record<RampName, RampSpec>> = {
  // Contract values from DESIGN.md 3.1: g0 #141414, g1 #1B1B1B, g2 #222222, g3 #2B2B2B,
  // g4 #3A3A3A, ink #E6E6E6, ink-2 #B4B4B4, ink-3 #929292, boundary #747474.
  dark: {
    name: 'dark',
    polarity: 'dark',
    base: {
      '--theme-bg-primary': '#141414',
      '--theme-bg-surface': '#1B1B1B',
      '--theme-text': '#E6E6E6',
      '--theme-accent': '#33CED6',
      '--theme-danger': '#FF4757',
    },
    steps: { g2: 2.745, g3: 6.275, g4: 12.157, ink2: -19.608, ink3: -32.941, boundary: -44.706 },
    semantic: {
      rec: '#E5484D',
      recText: '#F06A6E',
      solo: '#E8B53A',
      signalAudio: '#6FA7EE',
      signalEvents: '#69BA7C',
      signalParameter: '#AA95E8',
      signalVideo: '#CF88C8',
    },
  },
  // Light: ground (g0) is the darkest step, controls and headers are raised toward
  // white, the divider is darker than the panel. Semantic colours keep the dark
  // ramp's OKLCH hue and chroma and only move in lightness, so the hue-exclusion
  // rules (DESIGN.md 3.3/3.4) hold in every theme.
  light: {
    name: 'light',
    polarity: 'light',
    base: {
      '--theme-bg-primary': '#DCDCDC',
      '--theme-bg-surface': '#E9E9E9',
      '--theme-text': '#1A1A1A',
      '--theme-accent': '#006C71',
      '--theme-danger': '#C30730',
    },
    steps: { g2: 2.7, g3: 5.5, g4: -14.5, ink2: 16.5, ink3: 25.9, boundary: 32.9 },
    semantic: {
      rec: '#E04349',
      recText: '#B2303C',
      solo: '#7C5C02',
      signalAudio: '#2C62A4',
      signalEvents: '#176F36',
      signalParameter: '#6A54A1',
      signalVideo: '#8B4986',
    },
  },
  // High contrast: black ground, white ink, bright boundary, and a g4 divider that
  // is visible (>= 2.3:1) rather than decorative-faint, so grid lines survive.
  hc: {
    name: 'hc',
    polarity: 'dark',
    base: {
      '--theme-bg-primary': '#000000',
      '--theme-bg-surface': '#0A0A0A',
      '--theme-text': '#FFFFFF',
      '--theme-accent': '#33CED6',
      '--theme-danger': '#FD8888',
    },
    steps: { g2: 3.9, g3: 8.3, g4: 31, ink2: -12.2, ink3: -21.6, boundary: -18.4 },
    semantic: {
      rec: '#EB4E52',
      recText: '#FE8687',
      solo: '#E8B53A',
      signalAudio: '#74ACF3',
      signalEvents: '#6ABB7D',
      signalParameter: '#B29DF1',
      signalVideo: '#D991D2',
    },
  },
};

export const DEFAULT_RAMP: RampName = 'dark';

export function isRampName(v: unknown): v is RampName {
  return v === 'dark' || v === 'light' || v === 'hc';
}

/** WCAG relative luminance of a #RRGGBB / #RGB colour; NaN for anything else. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(hex.trim());
  if (!m) return NaN;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const lin = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
}

/**
 * Which ramp a theme belongs to when its file does not say. A theme whose panel
 * colour is light is `light`; everything else (including every theme saved before
 * Phase 7) is `dark`. `hc` is never inferred: it must be named.
 */
export function inferRamp(bgSurface: string | undefined): RampName {
  if (!bgSurface) return DEFAULT_RAMP;
  const l = luminance(bgSurface);
  return Number.isFinite(l) && l > 0.4 ? 'light' : 'dark';
}
