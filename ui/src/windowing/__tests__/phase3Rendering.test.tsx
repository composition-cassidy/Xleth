import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AppShell,
  WindowingPhase3DemoShell,
  configurePhase3DemoPanels,
} from '../AppShell';
import { DockRegion } from '../components/DockRegion';
import { SnapGhost } from '../components/SnapGhost';
import {
  type ActiveDragState,
  beginDrag,
  cancelDrag,
  getDragState,
  registerWorkAreaRect,
  updateDrag,
} from '../managers/DragManager';
import {
  createInitialPanelStates,
  usePanelRegistry,
} from '../registry/PanelRegistry';

function resetRegistry() {
  cancelDrag();
  registerWorkAreaRect({ left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity, width: Infinity, height: Infinity });
  usePanelRegistry.setState({ panels: createInitialPanelStates() });
}

describe('Phase 3 registry docking behavior', () => {
  beforeEach(resetRegistry);

  it('dockPanel sets mode and region in registry', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('mixer');
    registry.dockPanel('mixer', 'bottom');
    const panel = usePanelRegistry.getState().panels.mixer;
    expect(panel.mode).toBe('docked');
    expect(panel.docked.region).toBe('bottom');
  });

  it('undockPanel sets mode to floating and writes x/y', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('mixer');
    registry.dockPanel('mixer', 'bottom');
    registry.undockPanel('mixer', 100, 200);
    const panel = usePanelRegistry.getState().panels.mixer;
    expect(panel.mode).toBe('floating');
    expect(panel.floating.x).toBe(100);
    expect(panel.floating.y).toBe(200);
  });
});

describe('Phase 3 dock region SSR markup', () => {
  beforeEach(resetRegistry);

  it('DockRegion renders docked panels with data-region attribute', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('mixer');
    registry.dockPanel('mixer', 'bottom');

    const html = renderToStaticMarkup(<DockRegion side="bottom" />);
    expect(html).toContain('data-region="bottom"');
    expect(html).toContain('data-panel-id="mixer"');
    expect(html).toContain('data-panel-mode="docked"');
  });

  it('DockRegion returns null when no panels are docked to that region', () => {
    const html = renderToStaticMarkup(<DockRegion side="top" />);
    expect(html).toBe('');
  });

  it('phase-3 shell places docked panel in dock region, not floating layer', () => {
    configurePhase3DemoPanels();
    const html = renderToStaticMarkup(<WindowingPhase3DemoShell />);

    expect(html).toContain('data-region="bottom"');
    const bottomRegionStart = html.indexOf('data-region="bottom"');
    const mixerInDoc = html.indexOf('data-panel-id="mixer"', bottomRegionStart);
    expect(mixerInDoc).toBeGreaterThan(bottomRegionStart);

    const floatingLayerStart = html.indexOf('xleth-floating-window-layer');
    const mixerInFloat = html.indexOf('data-panel-id="mixer"', floatingLayerStart);
    expect(mixerInFloat).toBe(-1);
  });

  it('phase-3 AppShell mode renders the shell harness', () => {
    configurePhase3DemoPanels();
    const html = renderToStaticMarkup(<AppShell mode="phase-3-demo" />);
    expect(html).toContain('data-testid="xleth-windowing-shell"');
  });
});

describe('Phase 3 snap ghost SSR markup', () => {
  beforeEach(resetRegistry);

  it('SnapGhost renders with data-snap-target when snap target is active', () => {
    registerWorkAreaRect({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 });
    usePanelRegistry.getState().openPanel('timeline');
    beginDrag(
      'timeline',
      200,
      400,
      usePanelRegistry.getState().panels.timeline.floating.x,
      usePanelRegistry.getState().panels.timeline.floating.y,
    );
    updateDrag(20, 400);

    expect((getDragState() as ActiveDragState).currentSnapTarget).toBe('left');
    const html = renderToStaticMarkup(<SnapGhost />);
    expect(html).toContain('data-snap-target="left"');
  });

  it('SnapGhost renders nothing when no snap target', () => {
    registerWorkAreaRect({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 });
    usePanelRegistry.getState().openPanel('timeline');
    beginDrag(
      'timeline',
      200,
      400,
      usePanelRegistry.getState().panels.timeline.floating.x,
      usePanelRegistry.getState().panels.timeline.floating.y,
    );
    updateDrag(600, 400);

    const html = renderToStaticMarkup(<SnapGhost />);
    expect(html).toBe('');
  });
});
