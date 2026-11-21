import { tokenValue } from '../../theming/tokenValue.ts'

// Canvas colours for every Piano Roll canvas, resolved at DRAW time (never at
// module scope: tokenValue() returns '' before ThemeProvider mounts). Each
// entry is a DESIGN.md token; the literal after || is only the dark-theme
// fallback for test environments without a theme.
export function readPianoRollPalette() {
  const t = (name, fallback) => tokenValue(name) || fallback
  return {
    // Ramp
    g0: t('--ui-g0', '#141414'),
    g1: t('--ui-g1', '#1B1B1B'),
    g2: t('--ui-g2', '#222222'),
    g3: t('--ui-g3', '#2B2B2B'),
    g4: t('--ui-g4', '#3A3A3A'),
    boundary: t('--ui-boundary', '#747474'),
    ink: t('--ui-ink', '#E6E6E6'),
    ink2: t('--ui-ink-2', '#B4B4B4'),
    ink3: t('--ui-ink-3', '#929292'),
    value: t('--ui-value', '#33CED6'),
    select: t('--ui-select', '#33CED6'),
    font: t('--ui-font', '') || t('--xleth-global-font-family', 'system-ui, sans-serif'),
    // Grid (theme tokens: high contrast strengthens these, light inverts them)
    gridBg: t('--theme-pianoroll-grid-bg', '#141414'),
    rowWhite: t('--theme-pianoroll-key-white-bg', '#1B1B1B'),
    rowBlack: t('--theme-pianoroll-key-black-bg', '#141414'),
    lineStep: t('--theme-pianoroll-subdivision-line', 'rgba(255,255,255,0.04)'),
    lineBeat: t('--theme-pianoroll-beat-line', 'rgba(255,255,255,0.06)'),
    lineBar: t('--theme-pianoroll-bar-line', 'rgba(255,255,255,0.14)'),
    lasso: t('--theme-pianoroll-selection-rect', 'rgba(51,206,214,0.18)'),
  }
}

/** Canvas font string in the UI face. */
export function uiFont(palette, px, weight = 500) {
  return `${weight} ${px}px ${palette.font}`
}
