// Track palette token registration tests (Pass 6B).
//
// Pass 6B only REGISTERS the 16-slot track identity palette in the catalog —
// no renderer consumes these tokens yet. These tests verify the registration
// is correct and the runtime resolves every new token through the existing
// pipeline in both dark (default) and light shipped themes.
//
// What this suite asserts:
//   - The new 'track-palette' subsystem appears in SUBSYSTEMS under Labels.
//   - Every --theme-track-palette-N token (1–16) is registered in TOKENS_BY_NAME.
//   - tokensBySubsystem() groups all 16 tokens under 'track-palette'.
//   - All 16 resolve to valid #RRGGBB hex in the default shipped theme.
//   - All 16 resolve to valid #RRGGBB hex in the light shipped theme.
//   - Spot-checks for exact values in default and light themes.

import { describe, it, expect } from 'vitest';
import { TOKENS_BY_NAME, SUBSYSTEMS, tokensBySubsystem } from '../catalog';
import { resolveTheme } from '../../runtime/applyTheme';
import defaultTheme from '../../shipped/xleth-default.json';
import lightTheme from '../../shipped/xleth-light.json';

const PALETTE_TOKENS = Array.from({ length: 16 }, (_, i) => `--theme-track-palette-${i + 1}`);

const HEX6_RE = /^#[0-9A-Fa-f]{6}$/;

describe('track-palette subsystem — Pass 6B registration', () => {
  it('registers the track-palette subsystem under Labels', () => {
    const sub = SUBSYSTEMS.find(s => s.key === 'track-palette');
    expect(sub, 'track-palette subsystem missing from SUBSYSTEMS').toBeDefined();
    expect(sub?.category).toBe('Labels');
    expect(sub?.displayName).toBe('Track palette');
  });

  it('registers all 16 track palette tokens in the catalog', () => {
    for (const name of PALETTE_TOKENS) {
      const def = TOKENS_BY_NAME[name];
      expect(def, `missing catalog entry for ${name}`).toBeDefined();
      expect(def.subsystem, `${name} wrong subsystem`).toBe('track-palette');
      expect(def.category,  `${name} wrong category`).toBe('Labels');
      expect(def.kind,      `${name} wrong kind`).toBe('color');
      expect(def.capability,`${name} wrong capability`).toBe('solid');
    }
  });

  it('groups all 16 tokens under tokensBySubsystem().track-palette', () => {
    const groups = tokensBySubsystem();
    expect(groups['track-palette'], 'track-palette group missing').toBeDefined();
    const names = new Set(groups['track-palette'].map(t => t.name));
    for (const name of PALETTE_TOKENS) {
      expect(names.has(name), `${name} not grouped under 'track-palette'`).toBe(true);
    }
    expect(groups['track-palette'].length).toBe(16);
  });
});

describe('track palette — resolved through ThemeProvider pipeline', () => {
  it('all 16 resolve to valid #RRGGBB in the default theme', () => {
    const { values } = resolveTheme(defaultTheme as Parameters<typeof resolveTheme>[0]);
    for (const name of PALETTE_TOKENS) {
      const v = values[name];
      expect(v, `${name} did not resolve in default theme`).toBeDefined();
      expect(HEX6_RE.test(v), `${name} default value "${v}" is not valid #RRGGBB`).toBe(true);
    }
  });

  it('all 16 resolve to valid #RRGGBB in the light theme', () => {
    const { values } = resolveTheme(lightTheme as Parameters<typeof resolveTheme>[0]);
    for (const name of PALETTE_TOKENS) {
      const v = values[name];
      expect(v, `${name} did not resolve in light theme`).toBeDefined();
      expect(HEX6_RE.test(v), `${name} light value "${v}" is not valid #RRGGBB`).toBe(true);
    }
  });

  it('default theme palette values match spec', () => {
    const { values } = resolveTheme(defaultTheme as Parameters<typeof resolveTheme>[0]);
    expect(values['--theme-track-palette-1']).toBe('#4CC9F0');
    expect(values['--theme-track-palette-16']).toBe('#FB7185');
  });

  it('light theme palette values match spec', () => {
    const { values } = resolveTheme(lightTheme as Parameters<typeof resolveTheme>[0]);
    expect(values['--theme-track-palette-1']).toBe('#167FA3');
    expect(values['--theme-track-palette-16']).toBe('#B43A52');
  });

  it('catalog defaults resolve without any theme override', () => {
    const { values } = resolveTheme({ schemaVersion: 1, name: 'test-bare', tokens: {} });
    for (const name of PALETTE_TOKENS) {
      const v = values[name];
      expect(v, `${name} did not resolve from catalog default`).toBeDefined();
      expect(HEX6_RE.test(v), `${name} catalog default "${v}" is not valid #RRGGBB`).toBe(true);
    }
  });
});
