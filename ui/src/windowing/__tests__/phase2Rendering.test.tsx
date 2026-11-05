import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { floatingPanelKey } from '../AppShell';
import { PanelFrame } from '../components/PanelFrame';
import {
  createInitialPanelStates,
  usePanelRegistry,
} from '../registry/PanelRegistry';
import { PANEL_CATALOG, panelTypeColorVar, type PanelId } from '../registry/panelCatalog';

const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;

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

function sectionStyleFor(html: string, panelId: PanelId) {
  const match = html.match(new RegExp(`<section(?=[^>]*data-panel-id="${panelId}")[^>]*style="([^"]*)"`));
  return match?.[1] ?? '';
}

function floatingLayerOffsetFor(style: string) {
  const match = style.match(/z-index:\s*calc\(var\(--xleth-z-window-floating-base\)\s*\+\s*([0-9]+)\)/);
  return Number(match?.[1] ?? 0);
}

describe('PanelFrame rendering', () => {
  beforeEach(resetRegistry);

  it('renders maximized panels without transform or resize handles', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('preview');
    registry.maximizePanel('preview');

    const html = renderPanel('preview');
    const style = sectionStyleFor(html, 'preview');

    expect(html).toContain('data-panel-mode="maximized"');
    expect(style).not.toContain('transform');
    expect(html).not.toContain('xleth-resize-handle-');
  });

  it('renders all eight resize handles for floating panels', () => {
    usePanelRegistry.getState().openPanel('preview');
    const html = renderPanel('preview');

    for (const edge of RESIZE_EDGES) {
      expect(html).toContain(`data-testid="xleth-resize-handle-${edge}"`);
    }
  });

  it('gives each open panel its own accent color', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('preview');
    registry.openPanel('inspector');
    registry.openPanel('sampleSandbox');

    for (const id of ['preview', 'inspector', 'sampleSandbox'] as const) {
      const html = renderPanel(id);
      expect(html).toContain(`data-panel-id="${id}"`);
      expect(html).toContain(`--xleth-windowing-panel-color:${panelTypeColorVar(id)}`);
    }

    // All three are live in the floating layer, each with a distinct token.
    expect(floatingPanelKey(usePanelRegistry.getState().panels).split('|'))
      .toEqual(expect.arrayContaining(['preview', 'inspector', 'sampleSandbox']));
  });

  it('serializes focused panel z-index stacking in SSR markup', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('preview');
    registry.openPanel('inspector');
    registry.focusPanel('inspector');
    registry.focusPanel('preview');

    const previewStyle = sectionStyleFor(renderPanel('preview'), 'preview');
    const inspectorStyle = sectionStyleFor(renderPanel('inspector'), 'inspector');
    expect(previewStyle).toContain('z-index:calc(var(--xleth-z-window-floating-base) + ');
    expect(inspectorStyle).toContain('z-index:calc(var(--xleth-z-window-floating-base) + ');

    const previewZ = floatingLayerOffsetFor(previewStyle);
    const inspectorZ = floatingLayerOffsetFor(inspectorStyle);

    expect(previewZ).toBeGreaterThan(inspectorZ);
  });
});
