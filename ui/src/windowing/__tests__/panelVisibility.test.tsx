import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { PanelFrame } from '../components/PanelFrame';
import {
  createInitialPanelStates,
  usePanelRegistry,
} from '../registry/PanelRegistry';
import { PANEL_CATALOG, PANEL_IDS, type PanelId } from '../registry/panelCatalog';

function resetRegistry() {
  usePanelRegistry.setState({ panels: createInitialPanelStates() });
}

function renderPanel(id: PanelId) {
  return renderToStaticMarkup(
    <PanelFrame id={id}>
      <div>{PANEL_CATALOG[id].title}</div>
    </PanelFrame>,
  );
}

describe('PanelVisibility keep-alive rendering', () => {
  beforeEach(resetRegistry);

  it('hidden panel with keepAliveWhenHidden=false returns empty string', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('mixer');
    registry.closePanel('mixer');

    expect(renderPanel('mixer')).toBe('');
  });

  it('hidden panel with keepAliveWhenHidden=true renders display:none wrapper', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('timeline');
    registry.closePanel('timeline');

    const html = renderPanel('timeline');

    expect(html).toContain('data-panel-mode="hidden-alive"');
    expect(html).toMatch(/display:\s?none/);
  });

  it.skip('context value requires jsdom', () => {});

  it.skip('effects require jsdom', () => {});

  it('keepAliveWhenHidden is true for timeline, preview and splitSyllables only', () => {
    const keepAliveIds = ['timeline', 'preview', 'splitSyllables'] as const;
    for (const id of keepAliveIds) {
      expect(PANEL_CATALOG[id].keepAliveWhenHidden).toBe(true);
    }

    for (const id of PANEL_IDS) {
      if ((keepAliveIds as readonly string[]).includes(id)) continue;
      expect(PANEL_CATALOG[id].keepAliveWhenHidden).toBe(false);
    }
  });
});
