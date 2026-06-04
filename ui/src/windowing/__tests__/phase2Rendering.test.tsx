import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AppShell,
  WindowingPhase2DemoShell,
  configurePhase2DemoPanels,
} from '../AppShell';
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

describe('Phase 2 PanelFrame rendering', () => {
  beforeEach(resetRegistry);

  it('renders maximized panels without transform or resize handles', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('timeline');
    registry.maximizePanel('timeline');

    const html = renderPanel('timeline');
    const style = sectionStyleFor(html, 'timeline');

    expect(html).toContain('data-panel-mode="maximized"');
    expect(style).not.toContain('transform');
    expect(html).not.toContain('xleth-resize-handle-');
  });

  it('renders all eight resize handles for floating panels', () => {
    usePanelRegistry.getState().openPanel('timeline');
    const html = renderPanel('timeline');

    for (const edge of RESIZE_EDGES) {
      expect(html).toContain(`data-testid="xleth-resize-handle-${edge}"`);
    }
  });

  it('renders the phase 2 demo shell with three distinct panel accent colors', () => {
    configurePhase2DemoPanels();
    const html = renderToStaticMarkup(<WindowingPhase2DemoShell />);

    expect(html).toContain('data-panel-id="timeline"');
    expect(html).toContain('data-panel-id="mixer"');
    expect(html).toContain('data-panel-id="pianoRoll"');
    expect(html).toContain(`--xleth-windowing-panel-color:${panelTypeColorVar('timeline')}`);
    expect(html).toContain(`--xleth-windowing-panel-color:${panelTypeColorVar('mixer')}`);
    expect(html).toContain(`--xleth-windowing-panel-color:${panelTypeColorVar('pianoRoll')}`);
  });

  it('serializes focused panel z-index stacking in SSR markup', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('timeline');
    registry.openPanel('mixer');
    registry.focusPanel('mixer');
    registry.focusPanel('timeline');

    const html = renderToStaticMarkup(<AppShell mode="focus-demo" />);
    const timelineStyle = sectionStyleFor(html, 'timeline');
    const mixerStyle = sectionStyleFor(html, 'mixer');
    expect(timelineStyle).toContain('z-index:calc(var(--xleth-z-window-floating-base) + ');
    expect(mixerStyle).toContain('z-index:calc(var(--xleth-z-window-floating-base) + ');

    const timelineZ = floatingLayerOffsetFor(timelineStyle);
    const mixerZ = floatingLayerOffsetFor(mixerStyle);

    expect(timelineZ).toBeGreaterThan(mixerZ);
  });
});
