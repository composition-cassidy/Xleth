/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GLYPH_NAMES, Icon } from '../icons';

describe('Xleth icon set', () => {
  it('has the panels, tools and browser glyphs the shell needs', () => {
    for (const name of [
      'timeline', 'browser', 'preview', 'inspector', 'devices', 'mixer', 'pianoRoll', 'sampler',
      'fxGraph', 'quickNotation', 'splitSyllables', 'sandbox', 'select', 'draw', 'slice', 'delete',
      'sourceVideo', 'sourceAudio', 'media',
    ]) expect(GLYPH_NAMES).toContain(name);
  });

  it('is one family: 16px grid, 1.5 stroke, currentColor, nothing filled or coloured', () => {
    for (const name of GLYPH_NAMES) {
      const html = renderToStaticMarkup(<Icon name={name} />);
      expect(html, name).toContain('viewBox="0 0 16 16"');
      expect(html, name).toContain('stroke="currentColor"');
      expect(html, name).toContain('stroke-width="1.5"');
      expect(html, name).toContain('fill="none"');
      // Only currentColor: no hex, rgb() or var() colour anywhere in the drawing.
      expect(html, name).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(|hsl\(|var\(/);
      // Inside the grid: every drawn number is within 0..16.
      const drawing = html.replace(/<svg[^>]*>/, '');
      for (const n of drawing.match(/-?\d+(\.\d+)?/g) ?? []) {
        expect(Number(n), `${name}: ${n}`).toBeGreaterThanOrEqual(0);
        expect(Number(n), `${name}: ${n}`).toBeLessThanOrEqual(16);
      }
    }
  });

  it('cannot be given another stroke weight', () => {
    const html = renderToStaticMarkup(<Icon name="timeline" strokeWidth={4} />);
    expect(html).toContain('stroke-width="1.5"');
  });

  it('is decorative unless it is given a name', () => {
    expect(renderToStaticMarkup(<Icon name="mixer" />)).toContain('aria-hidden="true"');
    const named = renderToStaticMarkup(<Icon name="mixer" aria-label="Mixer" />);
    expect(named).toContain('role="img"');
    expect(named).not.toContain('aria-hidden');
  });
});
