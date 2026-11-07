import type { ReactNode } from 'react';

/**
 * Xleth's own glyphs, one family: a 16px grid, one 1.5px stroke, square caps,
 * mitred joins, `currentColor`, no fills. They are drawn from the app's own
 * vocabulary (grid cells, pattern blocks, syllable cuts, patch cables), never
 * from music notes or slider caps. Each entry is the inside of an <svg> whose
 * viewBox is `0 0 16 16`.
 */
export const GLYPHS = {
  // ── Panels ──────────────────────────────────────────────────────────────
  /** Arrangement: three lanes, one pattern block staggered in each. */
  timeline: (
    <>
      <rect x="1.5" y="2" width="6" height="3.5" />
      <rect x="5.5" y="6.25" width="7" height="3.5" />
      <rect x="9" y="10.5" width="5.5" height="3.5" />
    </>
  ),
  /** Browser: a disclosure triangle over indented rows. */
  browser: (
    <>
      <path d="M1.75 3H5.5L3.6 6z" />
      <path d="M7.5 4.5H14.5M5 8.5H14.5M5 12.5H14.5" />
    </>
  ),
  /** Preview: a 16:9 frame with one grid cell in it, a ruler under it. */
  preview: (
    <>
      <rect x="1.5" y="2.5" width="13" height="8" />
      <rect x="8.5" y="5" width="4" height="3.5" />
      <path d="M1.5 13.5H14.5" />
    </>
  ),
  /** Inspector: a panel split by a rule, property rows on one side. */
  inspector: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" />
      <path d="M6.5 1.5V14.5M8.75 5H12.5M8.75 8H12.5M8.75 11H12.5" />
    </>
  ),
  /** Devices: equal-height frames side by side under one title rule. */
  devices: (
    <>
      <rect x="1.5" y="3" width="13" height="10" />
      <path d="M1.5 5.75H14.5M6 5.75V13M10.5 5.75V13" />
    </>
  ),
  /** Mixer: three strips, three different fader positions. */
  mixer: (
    <>
      <path d="M3.5 1.5V14.5M8 1.5V14.5M12.5 1.5V14.5" />
      <rect x="1.75" y="9" width="3.5" height="2.5" />
      <rect x="6.25" y="4" width="3.5" height="2.5" />
      <rect x="10.75" y="6.75" width="3.5" height="2.5" />
    </>
  ),
  /** Piano roll: a pitch/time grid with one note. */
  pianoRoll: (
    <>
      <rect x="1.5" y="2" width="13" height="12" />
      <path d="M1.5 6H14.5M1.5 10H14.5M5 2V14" />
      <rect x="7" y="6.75" width="5" height="2.5" />
    </>
  ),
  /** Sampler: one cell with its trim brackets. */
  sampler: (
    <>
      <rect x="1.5" y="3" width="13" height="10" />
      <path d="M6 5.75H4.5V10.25H6M10 5.75H11.5V10.25H10" />
    </>
  ),
  /** FX graph: two nodes and the patch cable between them. */
  fxGraph: (
    <>
      <rect x="1.5" y="2" width="5" height="3.5" />
      <rect x="9.5" y="10.5" width="5" height="3.5" />
      <path d="M6.5 3.75H8V12.25H9.5" />
    </>
  ),
  /** Node editor: three nodes on one cable. */
  nodeEditor: (
    <>
      <rect x="1.5" y="6.25" width="3.5" height="3.5" />
      <rect x="6.25" y="1.5" width="3.5" height="3.5" />
      <rect x="11" y="10.5" width="3.5" height="3.5" />
      <path d="M5 8H6.25V3.25M8 5V8.5H9.75V12.25H11" />
    </>
  ),
  /** Quick notation: a pattern block over a row of step cells. */
  quickNotation: (
    <>
      <rect x="1.5" y="2.5" width="13" height="5" />
      <rect x="1.5" y="10" width="3.5" height="3.5" />
      <rect x="6.25" y="10" width="3.5" height="3.5" />
      <rect x="11" y="10" width="3.5" height="3.5" />
    </>
  ),
  /** Split syllables: one block, two cuts through it. */
  splitSyllables: (
    <>
      <rect x="1.5" y="4.5" width="13" height="7" />
      <path d="M6 1.5V14.5M10.5 1.5V14.5" />
    </>
  ),
  /** Sample sandbox: layered blocks, the lower one behind a dashed mask edge. */
  sandbox: (
    <>
      <rect x="1.5" y="2" width="9" height="5.5" />
      <rect x="5.5" y="8.5" width="9" height="5.5" strokeDasharray="2 1.5" />
    </>
  ),

  // ── Timeline tools ──────────────────────────────────────────────────────
  /** Select: a marquee of grid cells around a chosen cell. */
  select: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" strokeDasharray="2.5 1.5" />
      <rect x="5.75" y="5.75" width="4.5" height="4.5" />
    </>
  ),
  /** Draw: a block being stretched out by its right edge. */
  draw: (
    <>
      <rect x="1.5" y="5" width="8" height="6" />
      <path d="M11.5 8H14.5M13 6.25L14.75 8L13 9.75" />
    </>
  ),
  /** Slice: a block parted along one cut line. */
  slice: (
    <>
      <rect x="1.5" y="5" width="5.5" height="6" />
      <rect x="9" y="5" width="5.5" height="6" />
      <path d="M8 1.5V14.5" strokeDasharray="1.75 1.5" />
    </>
  ),
  /** Delete: a block struck through. */
  delete: (
    <>
      <rect x="1.5" y="3.5" width="13" height="9" />
      <path d="M5.75 6L10.25 10M10.25 6L5.75 10" />
    </>
  ),

  // ── Browser rows and tabs ───────────────────────────────────────────────
  /** A source with picture: a frame with its play cell. */
  sourceVideo: (
    <>
      <rect x="1.5" y="3" width="13" height="10" />
      <rect x="6" y="6" width="4" height="4" />
    </>
  ),
  /** An audio-only source: level bars of different heights. */
  sourceAudio: (
    <path d="M3 6.5V9.5M5.75 4.5V11.5M8.5 2.5V13.5M11.25 5V11M14 7V9" />
  ),
  /** Media tab: two overlapping source frames. */
  media: (
    <>
      <path d="M4.5 5V2.5H14.5V10H11.5" />
      <rect x="1.5" y="5" width="10" height="8.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type GlyphName = keyof typeof GLYPHS;
