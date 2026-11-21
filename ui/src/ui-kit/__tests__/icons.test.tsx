/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GLYPH_NAMES, ICON_NAMES, Icon, IconActive, resolveIconName } from '../icons';
import { IconButton } from '../Button';
import Toggle from '../Toggle';

describe('XLETH icon family (Phosphor + custom)', () => {
  it('keeps every old house glyph name working as an alias', () => {
    for (const name of [
      'timeline', 'browser', 'preview', 'inspector', 'devices', 'mixer', 'pianoRoll', 'sampler',
      'fxGraph', 'quickNotation', 'splitSyllables', 'sandbox', 'select', 'draw', 'slice', 'delete',
      'sourceVideo', 'sourceAudio', 'media',
    ]) {
      expect(GLYPH_NAMES).toContain(name);
      expect(ICON_NAMES).toContain(resolveIconName(name as never));
    }
  });

  it('is one family: 256 grid, currentColor only, no colour or stroke-width props', () => {
    for (const name of ICON_NAMES) {
      for (const weight of ['regular', 'fill'] as const) {
        const html = renderToStaticMarkup(<Icon name={name} weight={weight} />);
        expect(html, name).toContain('viewBox="0 0 256 256"');
        expect(html, name).toContain(`data-weight="${weight}"`);
        expect(html, `${name} ${weight}`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|var\(/);
        // Custom glyphs stroke at Phosphor Regular weight: 16 units on the 256 grid.
        const sw = html.match(/stroke-width="([\d.]+)"/);
        const scale = html.match(/scale\(([\d.]+)\)/);
        if (sw) expect(Number(sw[1]) * (scale ? Number(scale[1]) : 1), name).toBeCloseTo(16, 0);
      }
    }
  });

  it('cannot be given another stroke weight', () => {
    const html = renderToStaticMarkup(<Icon name="x" strokeWidth={4} />);
    expect(html).not.toContain('stroke-width="4"');
  });

  it('is decorative unless it is given a name', () => {
    expect(renderToStaticMarkup(<Icon name="faders" />)).toContain('aria-hidden="true"');
    const named = renderToStaticMarkup(<Icon name="faders" aria-label="Mixer" />);
    expect(named).toContain('role="img"');
    expect(named).not.toContain('aria-hidden');
  });

  it('renders Fill inside an "on" control and Regular otherwise (active = Fill)', () => {
    expect(renderToStaticMarkup(<IconButton label="Loop" pressed><Icon name="repeat" /></IconButton>)).toContain('data-weight="fill"');
    expect(renderToStaticMarkup(<IconButton label="Loop" pressed={false}><Icon name="repeat" /></IconButton>)).toContain('data-weight="regular"');
    expect(renderToStaticMarkup(<Toggle on glyph={<Icon name="eye" />} aria-label="Visual only" />)).toContain('data-weight="fill"');
    expect(renderToStaticMarkup(<Toggle on={false} glyph={<Icon name="eye" />} aria-label="Visual only" />)).toContain('data-weight="regular"');
    // An explicit weight wins over the host.
    expect(renderToStaticMarkup(<IconActive.Provider value><Icon name="x" weight="regular" /></IconActive.Provider>)).toContain('data-weight="regular"');
  });

  it('every icon name written in the renderer source exists', () => {
    const root = join(__dirname, '..', '..');
    const missing: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p); continue; }
        if (!/\.(jsx|tsx|js|ts)$/.test(f) || /\.test\./.test(f)) continue;
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/<Icon\b[^>]*?\bname="([^"]+)"/g)) {
          if (!ICON_NAMES.includes(resolveIconName(m[1] as never))) missing.push(`${p}: ${m[1]}`);
        }
        for (const m of src.matchAll(/\b(?:drawIcon\([^,]+,|iconComponent\()\s*'([^']+)'/g)) {
          if (!ICON_NAMES.includes(m[1] as never)) missing.push(`${p}: ${m[1]}`);
        }
      }
    };
    walk(root);
    expect(missing).toEqual([]);
  });

  it('no renderer source imports lucide-react any more', () => {
    const root = join(__dirname, '..', '..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.(jsx|tsx|js|ts)$/.test(f)) continue;
        if (/from ['"]lucide-react['"]/.test(readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
