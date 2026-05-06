// Depth & elevation token registration tests (Pass 1).
//
// Pass 1 only REGISTERS the depth vocabulary in the catalog — no selector
// consumes it yet. These tests verify the registration is correct and the
// runtime resolves every new token through the existing pipeline.
//
// What this suite asserts:
//   - The new 'depth' subsystem appears in SUBSYSTEMS under Foundations.
//   - Every expected --theme-depth-* token is registered in TOKENS_BY_NAME.
//   - tokensBySubsystem() groups all 29 tokens under 'depth'.
//   - resolveTheme(default) produces a non-empty CSS string for each new
//     token (the resolution path covers both `derived-var` ref tokens and
//     `explicit` literal tokens).
//   - --theme-depth-amplitude resolves to '1' (the unitless multiplier
//     default; future passes consume it via calc() at selector level).
//   - Each token's `kind` matches the validator's expectations
//     (color | shadow | dimension).

import { describe, it, expect } from 'vitest';
import { TOKENS_BY_NAME, SUBSYSTEMS, tokensBySubsystem } from '../catalog';
import { resolveTheme } from '../../runtime/applyTheme';

const DEPTH_TOKENS_BY_KIND = {
  color: [
    '--theme-depth-elevation-1-bg',
    '--theme-depth-elevation-2-bg',
    '--theme-depth-elevation-3-bg',
    '--theme-depth-well-bg',
    '--theme-depth-floating-bg',
    '--theme-depth-pressed-bg',
    '--theme-depth-elevation-1-border',
    '--theme-depth-elevation-2-border',
    '--theme-depth-elevation-3-border',
    '--theme-depth-floating-border',
    '--theme-depth-floating-focused-border',
    '--theme-depth-well-border',
  ],
  shadow: [
    '--theme-depth-elevation-1-top-highlight',
    '--theme-depth-elevation-2-top-highlight',
    '--theme-depth-elevation-3-top-highlight',
    '--theme-depth-floating-top-highlight',
    '--theme-depth-elevation-1-bottom-edge',
    '--theme-depth-elevation-2-outer-shadow',
    '--theme-depth-elevation-3-outer-shadow',
    '--theme-depth-floating-shadow',
    '--theme-depth-floating-focused-shadow',
    '--theme-depth-well-inner-shadow',
    '--theme-depth-well-top-shadow',
    '--theme-depth-pressed-inner-shadow',
    '--theme-depth-accent-glow-subtle',
    '--theme-depth-accent-glow-medium',
    '--theme-depth-accent-glow-strong',
    '--theme-depth-accent-ring',
    '--theme-depth-accent-halo',
  ],
  dimension: [
    '--theme-depth-amplitude',
  ],
} as const;

const ALL_DEPTH_TOKENS = [
  ...DEPTH_TOKENS_BY_KIND.color,
  ...DEPTH_TOKENS_BY_KIND.shadow,
  ...DEPTH_TOKENS_BY_KIND.dimension,
];

describe('depth subsystem — Pass 1 registration', () => {
  it('registers the depth subsystem under Foundations', () => {
    const depth = SUBSYSTEMS.find(s => s.key === 'depth');
    expect(depth).toBeDefined();
    expect(depth?.category).toBe('Foundations');
    expect(depth?.displayName).toBe('Depth & elevation');
  });

  it('registers all 30 depth tokens in the catalog', () => {
    expect(ALL_DEPTH_TOKENS.length).toBe(30);
    for (const name of ALL_DEPTH_TOKENS) {
      expect(TOKENS_BY_NAME[name], `missing catalog entry for ${name}`).toBeDefined();
      expect(TOKENS_BY_NAME[name].subsystem).toBe('depth');
      expect(TOKENS_BY_NAME[name].category).toBe('Foundations');
    }
  });

  it('groups all depth tokens under tokensBySubsystem().depth', () => {
    const groups = tokensBySubsystem();
    expect(groups.depth).toBeDefined();
    const names = new Set(groups.depth.map(t => t.name));
    for (const name of ALL_DEPTH_TOKENS) {
      expect(names.has(name), `${name} not grouped under 'depth'`).toBe(true);
    }
    expect(groups.depth.length).toBe(ALL_DEPTH_TOKENS.length);
  });

  it('uses correct token kind for each category', () => {
    for (const name of DEPTH_TOKENS_BY_KIND.color) {
      expect(TOKENS_BY_NAME[name].kind, `${name} should be 'color'`).toBe('color');
    }
    for (const name of DEPTH_TOKENS_BY_KIND.shadow) {
      expect(TOKENS_BY_NAME[name].kind, `${name} should be 'shadow'`).toBe('shadow');
    }
    for (const name of DEPTH_TOKENS_BY_KIND.dimension) {
      expect(TOKENS_BY_NAME[name].kind, `${name} should be 'dimension'`).toBe('dimension');
    }
  });
});

describe('depth tokens — resolved through ThemeProvider pipeline', () => {
  it('resolves every depth token to a non-empty string in the default theme', () => {
    const { values } = resolveTheme({
      schemaVersion: 1,
      name: 'test-default',
      tokens: {},
    });
    for (const name of ALL_DEPTH_TOKENS) {
      const v = values[name];
      expect(v, `${name} did not resolve`).toBeDefined();
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it('--theme-depth-amplitude resolves to "1"', () => {
    const { values } = resolveTheme({
      schemaVersion: 1,
      name: 'test-default',
      tokens: {},
    });
    expect(values['--theme-depth-amplitude']).toBe('1');
  });

  it('ref-typed depth tokens resolve to var(--ref) so the browser cascades', () => {
    const { values } = resolveTheme({
      schemaVersion: 1,
      name: 'test-default',
      tokens: {},
    });
    expect(values['--theme-depth-elevation-1-bg']).toBe('var(--theme-bg-secondary)');
    expect(values['--theme-depth-elevation-3-outer-shadow']).toBe('var(--theme-chrome-shadow)');
    expect(values['--theme-depth-floating-shadow']).toBe('var(--theme-chrome-shadow)');
  });

  it('explicit depth shadow tokens preserve their literal strings verbatim', () => {
    const { values } = resolveTheme({
      schemaVersion: 1,
      name: 'test-default',
      tokens: {},
    });
    expect(values['--theme-depth-elevation-2-top-highlight'])
      .toBe('inset 0 1px 0 rgba(255, 255, 255, 0.06)');
    expect(values['--theme-depth-accent-glow-medium'])
      .toBe('0 0 16px rgba(51, 206, 214, 0.28)');
    expect(values['--theme-depth-floating-focused-shadow'])
      .toBe('0 0 0 1px var(--theme-accent), 0 12px 40px rgba(0, 0, 0, 0.6)');
  });

  it('user theme overrides win over catalog defaults for depth tokens', () => {
    const { values } = resolveTheme({
      schemaVersion: 1,
      name: 'test-override',
      tokens: {
        '--theme-depth-amplitude': '1.5',
        '--theme-depth-accent-glow-medium': '0 0 20px rgba(0, 200, 255, 0.5)',
      },
    });
    expect(values['--theme-depth-amplitude']).toBe('1.5');
    expect(values['--theme-depth-accent-glow-medium']).toBe('0 0 20px rgba(0, 200, 255, 0.5)');
  });
});
