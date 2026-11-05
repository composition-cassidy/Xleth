/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Gallery from '../Gallery.jsx';

describe('dev-only gallery', () => {
  const html = renderToStaticMarkup(<Gallery />);

  it('renders every component in its forced states without throwing', () => {
    for (const state of ['hover', 'active', 'focus']) expect(html).toContain(`data-state="${state}"`);
    expect(html).toContain('aria-disabled="true"'); // disabled knobs / boxes
    expect(html).toContain('data-bipolar="true"');
    expect(html).toContain('role="slider"');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('<canvas'); // meters
    expect(html).toContain('No tracks. Add a clip track or a pattern track.');
  });

  it('labels the synthetic meter signal as such', () => {
    expect(html).toContain('synthetic test signal');
  });

  it('is mounted only behind VITE_XLETH_UI_KIT_GALLERY (main.jsx), lazily, at ?view=ui-kit', () => {
    const main = readFileSync(path.resolve(__dirname, '../../main.jsx'), 'utf8');
    expect(main).toMatch(/VITE_XLETH_UI_KIT_GALLERY/);
    expect(main).toMatch(/React\.lazy\(\(\) => import\('\.\/ui-kit\/Gallery\.jsx'\)\)/);
    expect(main).toMatch(/view === 'ui-kit'/);
    // No static import: the normal bundle must not contain the gallery.
    expect(main).not.toMatch(/^import .*Gallery/m);
  });

  it('has an npm script and a shots mode', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
    expect(pkg.scripts['dev:ui-kit']).toContain('VITE_XLETH_UI_KIT_GALLERY=1');
    expect(pkg.scripts['shots:gallery']).toContain('--gallery');
  });
});
