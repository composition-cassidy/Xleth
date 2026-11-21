/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ACTIVE_PANEL_IDS, PANEL_CATALOG, TOOLBAR_PANEL_IDS } from '../registry/panelCatalog';

const read = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

/** The names a file imports from lucide-react. */
function lucideImports(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'lucide-react'/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe('panel and tool icons', () => {
  it('every panel is drawn from the Xleth icon family', () => {
    for (const id of ACTIVE_PANEL_IDS) {
      const Icon = PANEL_CATALOG[id].icon;
      const html = renderToStaticMarkup(<Icon />);
      // The one family: Phosphor's 256 grid (custom XLETH glyphs are drawn to the same grid).
      expect(html, id).toContain('viewBox="0 0 256 256"');
      expect(html, id).toContain('aria-hidden="true"');
    }
  });

  it('no two panels share a glyph', () => {
    const drawings = ACTIVE_PANEL_IDS.map((id) => renderToStaticMarkup(React.createElement(PANEL_CATALOG[id].icon)));
    expect(new Set(drawings).size).toBe(drawings.length);
  });

  it('the identity files import nothing from Lucide (Phosphor is the only family)', () => {
    for (const file of [
      'windowing/registry/panelCatalog.ts',
      'components/TitleBar.jsx',
      'components/timeline/TimelineToolbar.jsx',
      'components/ProjectMediaTab.jsx',
      'components/SampleSelectorTab.jsx',
      'components/LeftPanel.jsx',
      'windowing/components/DetailDock.tsx',
      'windowing/components/PanelTabStrip.tsx',
    ]) {
      expect(lucideImports(read(file)), file).toEqual([]);
    }
  });

  it('every launcher names its panel and its F-key for the hint bar', () => {
    // The panel toggles and the Tools menu moved out of TitleBar.jsx in round 2.
    const regions = read('components/TitleBarRegions.jsx');
    expect(regions).toContain('hint={REGION_HINTS[id]}');
    expect(regions).toContain("hintMods={shortcut || 'No shortcut'}");
    expect(regions).toContain('const shortcut = panelShortcut(id)');
    // Every toolbar panel with a shortcut is reachable from the top bar, and its key is declared once in the catalog.
    const withKeys = TOOLBAR_PANEL_IDS.filter((id) => 'fKey' in PANEL_CATALOG[id]);
    expect(withKeys.length).toBeGreaterThan(0);
    for (const id of withKeys) expect((PANEL_CATALOG[id] as { fKey?: string }).fKey).toMatch(/^F(5|6|7|8|9|10|11|12)$/);
  });

  it('the timeline tools use the tool glyphs and name themselves', () => {
    const toolbar = read('components/timeline/TimelineToolbar.jsx');
    for (const name of ['SelectToolIcon', 'DrawToolIcon', 'SliceToolIcon', 'DeleteToolIcon']) expect(toolbar).toContain(name);
    expect(toolbar).toContain('label={`${label} tool`}');
    expect(toolbar).toContain('hint={`${label} tool (${shortcut})`}');
  });
});
