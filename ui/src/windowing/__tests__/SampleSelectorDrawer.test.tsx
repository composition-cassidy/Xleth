import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
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

describe('SampleSelectorDrawer', () => {
  beforeEach(resetRegistry);

  it('renders a collapsed left-edge handle when the sample selector is hidden', () => {
    usePanelRegistry.getState().closePanel('sampleSelector');

    const html = renderToStaticMarkup(<SampleSelectorDrawer />);

    expect(html).toContain('xleth-sample-selector-drawer__handle');
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

  it('renders the existing internal tabs inside the expanded drawer', () => {
    openSampleSelectorDrawer();

    const html = renderToStaticMarkup(<SampleSelectorDrawer />);

    expect(html).toContain('xleth-sample-selector-drawer');
    expect(html).toContain('Project Media');
    expect(html).toContain('Sample Selector');
    expect(html).toContain('Grid Settings');
    expect(html).toContain('aria-label="Collapse Sample Selector drawer"');
  });

  it('collapses through the drawer helper', () => {
    openSampleSelectorDrawer();

    collapseSampleSelectorDrawer();

    expect(usePanelRegistry.getState().panels.sampleSelector.hidden).toBe(true);
  });

  it('production shell does not render sample selector as a normal PanelFrame', () => {
    const appShellSource = readUiSource('windowing/AppShell.tsx');

    expect(appShellSource).toContain('<SampleSelectorDrawer />');
    expect(appShellSource).toContain('DRAWER_PANEL_IDS.has(panelId)');
    expect(appShellSource).toContain('excludePanelIds={drawerPanelIds}');
  });
});
