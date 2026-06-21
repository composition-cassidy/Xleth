import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SampleSelectorDrawer,
  collapseSampleSelectorDrawer,
  openSampleSelectorDrawer,
} from '../components/SampleSelectorDrawer';
import {
  createInitialDockRegionSizes,
  createInitialPanelStates,
  usePanelRegistry,
} from '../registry/PanelRegistry';

vi.mock('../../components/Toast.jsx', () => ({
  ToastProvider: ({ children }: { children: unknown }) => children,
  useToast: () => ({ dismiss: () => {}, showToast: () => undefined }),
}));

function readUiSource(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), 'src', relativePath), 'utf8');
}

function resetRegistry() {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  usePanelRegistry.setState({
    panels: createInitialPanelStates(),
    dockRegionSizes: createInitialDockRegionSizes(),
  });
}

function countRegistryNotifications(run: () => void): number {
  let notifications = 0;
  const unsubscribe = usePanelRegistry.subscribe(() => {
    notifications += 1;
  });
  run();
  unsubscribe();
  return notifications;
}

describe('SampleSelectorDrawer', () => {
  beforeEach(resetRegistry);

  it('renders a collapsed centered edge tab when the sample selector is hidden', () => {
    usePanelRegistry.getState().closePanel('sampleSelector');

    const html = renderToStaticMarkup(<SampleSelectorDrawer />);

    expect(html).toContain('xleth-sample-selector-drawer__edge-toggle');
    expect(html).toContain('xleth-sample-selector-drawer__edge-toggle--collapsed');
    expect(html).toContain('aria-label="Open Sample Selector drawer"');
    expect(html).not.toContain('left-panel-tabs');
  });

  it('opens through the drawer helper and normalizes to docked-left state', () => {
    const panels = createInitialPanelStates();
    panels.sampleSelector.hidden = true;
    panels.sampleSelector.mode = 'floating';
    panels.sampleSelector.docked.region = 'right';
    usePanelRegistry.setState({ panels });

    openSampleSelectorDrawer();

    const panel = usePanelRegistry.getState().panels.sampleSelector;
    expect(panel.hidden).toBe(false);
    expect(panel.mode).toBe('docked');
    expect(panel.docked.region).toBe('left');
    expect(panel.docked.orderInRegion).toBe(0);
  });

  it('renders the production shell with a reserved sample dock column when open', () => {
    openSampleSelectorDrawer();

    const appShellSource = readUiSource('windowing/AppShell.tsx');

    expect(appShellSource).toContain('sample-dock-open');
    expect(appShellSource).toContain('<SampleSelectorDrawer />');
    expect(appShellSource).toContain('data-testid="xleth-app-workarea"');
    expect(appShellSource.indexOf('<SampleSelectorDrawer />')).toBeLessThan(
      appShellSource.indexOf('data-testid="xleth-app-workarea"'),
    );
  });

  it('collapses to only the reserved edge-tab column and lets WorkArea expand', () => {
    openSampleSelectorDrawer();
    collapseSampleSelectorDrawer();

    const html = renderToStaticMarkup(<SampleSelectorDrawer />);
    const css = readUiSource('windowing/components/windowing.css');

    expect(html).toContain('xleth-sample-selector-drawer__edge-toggle--collapsed');
    expect(css).toMatch(/\.xleth-windowing-shell\s*\{[\s\S]*grid-template-columns:\s*var\(--xleth-sample-dock-width\)\s+minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.xleth-windowing-shell\s*\{[\s\S]*transition:\s*grid-template-columns\s+180ms\s+cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/);
    expect(css).toMatch(/\.xleth-windowing-shell\.sample-dock-collapsed\s*\{[\s\S]*grid-template-columns:\s*var\(--xleth-sample-dock-handle-width\)\s+minmax\(0,\s*1fr\)/);
  });

  it('disables the drawer tween when reduced motion is requested', () => {
    const css = readUiSource('windowing/components/windowing.css');

    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.xleth-windowing-shell,\s*[\s\S]*\.xleth-sample-selector-drawer\s*\{[\s\S]*transition:\s*none/);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.xleth-sample-selector-drawer\s*\{[\s\S]*animation:\s*none/);
  });

  it('mounts docked, floating, and maximized layers inside WorkArea', () => {
    const appShellSource = readUiSource('windowing/AppShell.tsx');
    const css = readUiSource('windowing/components/windowing.css');

    expect(appShellSource.indexOf('data-testid="xleth-app-workarea"')).toBeLessThan(
      appShellSource.indexOf('data-testid="xleth-docked-window-layer"'),
    );
    expect(appShellSource.indexOf('data-testid="xleth-app-workarea"')).toBeLessThan(
      appShellSource.indexOf('data-testid="xleth-floating-window-layer"'),
    );
    expect(appShellSource).toContain('ref={workAreaRef}');
    expect(css).toMatch(/\.xleth-app-workarea\s*\{[\s\S]*position:\s*relative/);
    expect(css).toMatch(/\.xleth-floating-window-layer[^{]*\{[\s\S]*position:\s*absolute[\s\S]*inset:\s*0/);
    expect(css).toMatch(/\[data-panel-mode="maximized"\]\s*\{[\s\S]*position:\s*absolute[\s\S]*inset:\s*0/);
  });

  it('keeps Sample Selector out of normal floating and maximized panel mounting paths', () => {
    const appShellSource = readUiSource('windowing/AppShell.tsx');
    const sampleSelectorPanelSource = readUiSource('windowing/panels/SampleSelectorPanel.tsx');

    expect(appShellSource).toContain('<SampleSelectorDrawer />');
    expect(appShellSource).toContain('DRAWER_PANEL_IDS.has(panelId)');
    expect(appShellSource).toContain('excludePanelIds={drawerPanelIds}');
    expect(sampleSelectorPanelSource).toContain('return null');
  });

  it('renders the existing internal tabs inside the expanded drawer', () => {
    openSampleSelectorDrawer();

    const html = renderToStaticMarkup(<SampleSelectorDrawer />);

    expect(html).toContain('xleth-sample-selector-drawer');
    expect(html).toContain('Project Media');
    expect(html).toContain('Sample Selector');
    expect(html).toContain('Grid Settings');
    expect(html).not.toContain('xleth-sample-selector-drawer__chrome');
    expect(html).toContain('xleth-sample-selector-drawer__edge-toggle--expanded');
    expect(html).toContain('aria-label="Collapse Sample Selector drawer"');
  });

  it('renders a drawer resize handle for the left dock region', () => {
    openSampleSelectorDrawer();

    const html = renderToStaticMarkup(<SampleSelectorDrawer />);
    const source = readUiSource('windowing/components/SampleSelectorDrawer.tsx');

    expect(html).toContain('xleth-sample-selector-drawer__resize-handle');
    expect(html).toContain('data-testid="xleth-sample-selector-drawer-resize-handle"');
    expect(source).toContain("beginDockRegionResize('left', 'horizontal'");
    expect(source).toContain('state.dockRegionSizes.left');
    expect(source).not.toContain('sampleSelectorDockWidth');
  });

  it('collapses through the drawer helper', () => {
    openSampleSelectorDrawer();

    collapseSampleSelectorDrawer();

    expect(usePanelRegistry.getState().panels.sampleSelector.hidden).toBe(true);
  });

  it('does not notify registry subscribers for repeated drawer open or close writes', () => {
    openSampleSelectorDrawer();
    expect(countRegistryNotifications(() => openSampleSelectorDrawer())).toBe(0);

    collapseSampleSelectorDrawer();
    expect(countRegistryNotifications(() => collapseSampleSelectorDrawer())).toBe(0);
  });

  it('production shell does not render sample selector as a normal PanelFrame', () => {
    const appShellSource = readUiSource('windowing/AppShell.tsx');

    expect(appShellSource).toContain('<SampleSelectorDrawer />');
    expect(appShellSource).toContain('DRAWER_PANEL_IDS.has(panelId)');
    expect(appShellSource).toContain('excludePanelIds={drawerPanelIds}');
  });
});
