/**
 * @vitest-environment jsdom
 */
// Simple mode renders neutral-ramp controls only, and the readouts say what they measure.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import SimpleMode from '../editor/SimpleMode';
import ChromeReadouts from '../editor/ChromeReadouts';
import { resolveTheme } from '../runtime/applyTheme';
import { getShippedTheme } from '../runtime/ThemeLoader';
import type { ThemeFile } from '../schema/types';

const noop = () => {};
const valuesOf = (slug: string) => resolveTheme(getShippedTheme(slug)!).values;

describe('theme editor Simple mode', () => {
  const html = renderToStaticMarkup(
    <SimpleMode values={valuesOf('xleth-default')} onChromeChange={noop} onTokenChange={noop} onNeutralize={noop} />,
  );

  it('offers brightness, text contrast and a capped tint for surfaces, and no surface colour pickers', () => {
    for (const id of ['simple-brightness', 'simple-contrast', 'simple-tint', 'simple-tint-hue']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).not.toContain('simple---theme-bg-primary');
    expect(html).not.toContain('simple---theme-bg-surface');
    expect(html).not.toContain('simple---theme-text"');
    // Accent and danger remain free colours.
    expect(html).toContain('id="simple---theme-accent"');
    expect(html).toContain('id="simple---theme-danger"');
  });

  it('stops the contrast slider at the Floor-preserving minimum', () => {
    expect(html).toMatch(/id="simple-contrast"[^>]*aria-valuemin="80"/);
  });

  it('shows live contrast readouts for ink, ink 3 and boundary against the panel', () => {
    expect(html).toContain('Against panel');
    for (const label of ['Ink', 'Ink 3', 'Boundary']) expect(html).toContain(label);
    expect(html).toContain('Pass');
  });

  it('shows no tinted-chrome warning for a neutral theme', () => {
    expect(html).not.toContain('tinted-chrome-warning');
  });
});

describe('tinted chrome warning', () => {
  const legacy: ThemeFile = {
    schemaVersion: 1,
    name: 'old',
    derivationDetached: [],
    tokens: { '--theme-bg-primary': '#0A0A0F', '--theme-bg-surface': '#1A1A24' },
  };

  it('appears for a blue-grey theme and offers Neutralize', () => {
    const html = renderToStaticMarkup(<ChromeReadouts values={resolveTheme(legacy).values} onNeutralize={noop} />);
    expect(html).toContain('tinted-chrome-warning');
    expect(html).toContain('Tinted chrome.');
    expect(html).toContain('Neutralize');
  });

  it('prints a ratio and a Pass / Below word for every row, never colour alone', () => {
    const html = renderToStaticMarkup(<ChromeReadouts values={valuesOf('xleth-high-contrast')} />);
    expect((html.match(/ : 1/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(html).toMatch(/Pass/);
  });
});
