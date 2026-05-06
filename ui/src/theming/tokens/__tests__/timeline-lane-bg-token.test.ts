// Registration test for --theme-timeline-lane-bg (Pass 5E.1).
// Verifies catalog presence and resolution in default + light themes.
// No consumer of this token exists yet — Pass 5E.3 will add one.

import { describe, it, expect } from 'vitest';
import { TOKENS_BY_NAME } from '../catalog';
import { resolveTheme } from '../../runtime/applyTheme';
import defaultTheme from '../../shipped/xleth-default.json';
import lightTheme from '../../shipped/xleth-light.json';

const TOKEN = '--theme-timeline-lane-bg';

describe('--theme-timeline-lane-bg — Pass 5E.1 registration', () => {
  it('exists in the catalog under the timeline subsystem', () => {
    const def = TOKENS_BY_NAME[TOKEN];
    expect(def, 'token missing from catalog').toBeDefined();
    expect(def.subsystem).toBe('timeline');
    expect(def.category).toBe('Workspace panels');
    expect(def.kind).toBe('color');
  });

  it('resolves to #07070B in the default theme', () => {
    const { values } = resolveTheme(defaultTheme as Parameters<typeof resolveTheme>[0]);
    expect(values[TOKEN]).toBe('#07070B');
  });

  it('resolves to #CACAC6 in the light theme', () => {
    const { values } = resolveTheme(lightTheme as Parameters<typeof resolveTheme>[0]);
    expect(values[TOKEN]).toBe('#CACAC6');
  });
});
