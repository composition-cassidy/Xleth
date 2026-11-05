import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppShell, floatingPanelKey } from '../AppShell';
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

function configureDockedDemoLayout() {
  const registry = usePanelRegistry.getState();
  registry.openPanel('timeline');
  registry.openPanel('mixer');
  registry.dockPanel('mixer', 'bottom');
  registry.focusPanel('timeline');
}

describe('registry docking behavior', () => {
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

describe('dock region SSR markup', () => {
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

  it('DockRegion renders sized docked slots and splitters between siblings', () => {
    const panels = createInitialPanelStates();
    panels.timeline.hidden = false;
    panels.timeline.mode = 'docked';
    panels.timeline.docked = { ...panels.timeline.docked, region: 'bottom', orderInRegion: 0, sizeInRegion: 300 };
    panels.mixer.hidden = false;
    panels.mixer.mode = 'docked';
    panels.mixer.docked = { ...panels.mixer.docked, region: 'bottom', orderInRegion: 1, sizeInRegion: 260 };
    usePanelRegistry.setState({ panels });

    const html = renderToStaticMarkup(<DockRegion side="bottom" />);

    expect(html).toContain('data-docked-slot-id="timeline"');
    expect(html).toContain('data-docked-slot-id="mixer"');
    expect(html).toContain('--xleth-docked-panel-size:300px');
    expect(html).toContain('--xleth-docked-panel-size:260px');
    expect(html).toContain('data-testid="xleth-dock-splitter-timeline-mixer"');
  });

  it('DockRegion returns null when no panels are docked to that region', () => {
    const html = renderToStaticMarkup(<DockRegion side="top" />);
    expect(html).toBe('');
  });

  it('places a docked panel in its dock region, not the floating layer', () => {
    configureDockedDemoLayout();

    const regionHtml = renderToStaticMarkup(<DockRegion side="bottom" />);
    expect(regionHtml).toContain('data-region="bottom"');
    expect(regionHtml).toContain('data-panel-id="mixer"');
    expect(regionHtml).toContain('data-panel-mode="docked"');

    // The floating layer is driven off the same state and must not claim it.
    const floating = floatingPanelKey(usePanelRegistry.getState().panels).split('|');
    expect(floating).not.toContain('mixer');
    expect(floating).toContain('timeline');
  });

  it('renders the shell harness', () => {
    configureDockedDemoLayout();
    const html = renderToStaticMarkup(<AppShell />);
    expect(html).toContain('data-testid="xleth-windowing-shell"');
  });
});

describe('snap ghost SSR markup', () => {
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
