// Base tokens — the 5 knobs Simple-mode users edit. Every other token in the
// system either is derived from these (per derivation.ts) or is an explicit
// subsystem default that may reference base tokens via `var(--...)`.
//
// Values below reflect the CURRENT hardcoded Xleth aesthetic (see
// ui/src/styles/theme.css). Per spec §7.1 the shipped "Xleth Default" theme
// must match current values exactly — the sample palette in spec §3.1 is
// illustrative only and is superseded by §7.1 for the locked default.

export interface BaseTokens {
  '--theme-bg-primary': string;
  '--theme-bg-surface': string;
  '--theme-accent': string;
  '--theme-text': string;
  '--theme-danger': string;
}

export const BASE_TOKEN_NAMES: ReadonlyArray<keyof BaseTokens> = [
  '--theme-bg-primary',
  '--theme-bg-surface',
  '--theme-accent',
  '--theme-text',
  '--theme-danger',
];

export const BASE_DEFAULTS: BaseTokens = {
  '--theme-bg-primary': '#0A0A0F',
  '--theme-bg-surface': '#1A1A24',
  '--theme-accent':     '#33CED6',
  '--theme-text':       '#E8E8ED',
  '--theme-danger':     '#FF4757',
};

export function isBaseToken(name: string): name is keyof BaseTokens {
  return (BASE_TOKEN_NAMES as ReadonlyArray<string>).includes(name);
}
