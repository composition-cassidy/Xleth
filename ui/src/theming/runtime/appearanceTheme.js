// Stub — full appearance theme builder not yet implemented.
// Returns a minimal ThemeFile that overrides the accent and adjusts bg darkness.

export const APPEARANCE_THEME_SLUG = 'user-appearance';
export const DEFAULT_APPEARANCE_ACCENT = '#33CED6';
export const DEFAULT_APPEARANCE_DARKNESS = 0;

/**
 * Build a ThemeFile from the user's accent color and darkness (0–1) preference.
 * @param {string} accent  Hex color string, e.g. '#33CED6'
 * @param {number} darkness  0 = default dark, 1 = maximum dark
 * @returns {import('../schema/types').ThemeFile}
 */
export function buildAppearanceTheme(accent, darkness) {
  return {
    schemaVersion: 1,
    name: 'User Appearance',
    author: 'user',
    description: '',
    locked: false,
    derivationDetached: [],
    tokens: {
      '--theme-accent': accent ?? DEFAULT_APPEARANCE_ACCENT,
    },
  };
}

/**
 * Ensure the hex string has a leading '#' and is 7 chars.
 * Returns the original string unchanged if it doesn't look like a hex color.
 * @param {string} hex
 * @returns {string}
 */
export function normalizeAccentHex(hex) {
  if (!hex) return DEFAULT_APPEARANCE_ACCENT;
  const s = hex.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s}`;
  return s;
}
