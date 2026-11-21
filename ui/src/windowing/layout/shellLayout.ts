// How the centre column (top row, arrangement, detail dock) shares its height.
// Pure arithmetic so the rule is testable without a DOM. ui/DESIGN.md section 8.1.

/** Detail dock collapsed: the 28px tab strip plus its 1px top border. */
export const DOCK_STRIP_H = 29;
/** The smallest the detail dock can be dragged to (MIN_DOCK_REGION_SIZES.bottom). */
export const DOCK_MIN_H = 160;
/** Default open height = clamp(320, 40% of the column, 520). */
export const DOCK_AUTO_MIN_H = 320;
export const DOCK_AUTO_MAX_H = 520;
export const DOCK_AUTO_RATIO = 0.4;
/**
 * Every layout saved before the auto size existed holds this number for the dock,
 * because it was the default. A stored value equal to it means "never resized".
 */
export const LEGACY_DOCK_DEFAULT_H = 304;
/** The same trick for the top row: its stored default (the shipped preset). */
export const LEGACY_TOP_DEFAULT_H = 340;

/** Preview + Inspector row: never squeezed below this. */
export const TOP_MIN_H = 200;
/** What the top row becomes when the window cannot hold all three regions. */
export const TOP_STRIP_H = 28;

/** Timeline toolbar 32 + ruler 26 + video cue lane 24 + 1px of borders, measured. (95 until round 3: 38 / 26 / 30.) */
export const ARRANGEMENT_CHROME_H = 83;
/** Default track row height (TRACK_HEIGHT). */
export const TRACK_ROW_H = 36;
/** Hard minimum: 4 rows. */
export const ARRANGEMENT_MIN_H = ARRANGEMENT_CHROME_H + 4 * TRACK_ROW_H;
/** What an untouched top row leaves for the arrangement when it can: 8 rows. */
export const ARRANGEMENT_PREFERRED_H = ARRANGEMENT_CHROME_H + 8 * TRACK_ROW_H;

export type TopRowMode = 'full' | 'strip' | 'none';

export interface ShellLayoutInput {
  /** Height of the centre column. */
  columnH: number;
  dockOpen: boolean;
  /** Stored (or live-dragged) detail dock height. */
  dockStored: number;
  /** False while the stored dock height is the legacy default (never resized). */
  dockUserSized: boolean;
  topStored: number;
  topUserSized: boolean;
  /** Whether the top region holds any panel at all. */
  topPresent: boolean;
}

export interface ShellLayout {
  dockH: number;
  topMode: TopRowMode;
  /** 0 for 'none', TOP_STRIP_H for 'strip'. */
  topH: number;
  arrangementH: number;
}

export function autoDockHeight(columnH: number): number {
  return Math.round(Math.min(DOCK_AUTO_MAX_H, Math.max(DOCK_AUTO_MIN_H, columnH * DOCK_AUTO_RATIO)));
}

export function isDockUserSized(stored: number): boolean {
  return stored !== LEGACY_DOCK_DEFAULT_H;
}

export function isTopUserSized(stored: number): boolean {
  return stored !== LEGACY_TOP_DEFAULT_H;
}

export function computeShellLayout(input: ShellLayoutInput): ShellLayout {
  const { columnH: A, dockOpen, dockStored, dockUserSized, topStored, topUserSized, topPresent } = input;

  let dock = DOCK_STRIP_H;
  if (dockOpen) dock = Math.max(DOCK_MIN_H, dockUserSized ? Math.round(dockStored) : autoDockHeight(A));

  if (!topPresent) {
    if (dockOpen) dock = Math.max(DOCK_MIN_H, Math.min(dock, A - ARRANGEMENT_MIN_H));
    return { dockH: dock, topMode: 'none', topH: 0, arrangementH: A - dock };
  }

  if (A - dock >= TOP_MIN_H + ARRANGEMENT_MIN_H) {
    // An untouched top row leaves the arrangement 8 rows; one the user resized
    // may take everything down to the 4-row minimum.
    const floor = topUserSized ? ARRANGEMENT_MIN_H : ARRANGEMENT_PREFERRED_H;
    const top = Math.max(TOP_MIN_H, Math.min(Math.round(topStored), A - dock - floor));
    return { dockH: dock, topMode: 'full', topH: top, arrangementH: A - dock - top };
  }

  // Not all three fit: the top row folds to a strip. The dock yields only when
  // the arrangement would otherwise fall under its 4 rows.
  if (dockOpen) dock = Math.max(DOCK_MIN_H, Math.min(dock, A - TOP_STRIP_H - ARRANGEMENT_MIN_H));
  return { dockH: dock, topMode: 'strip', topH: TOP_STRIP_H, arrangementH: A - dock - TOP_STRIP_H };
}
