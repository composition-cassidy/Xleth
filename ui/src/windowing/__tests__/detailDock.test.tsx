import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activateDetailTab,
  DetailDock,
  detailDockKey,
  parseDetailDockKey,
  togglePopOutDetailTab,
} from '../components/DetailDock';
import { PanelFrame } from '../components/PanelFrame';
import { usePanelRegistry } from '../registry/PanelRegistry';
import { DETAIL_DOCK_TAB_IDS, PANEL_CATALOG, type PanelId } from '../registry/panelCatalog';

function reset() {
  usePanelRegistry.getState().resetLayout();
}

const tabs = () => parseDetailDockKey(detailDockKey(usePanelRegistry.getState().panels));
const stateOf = (id: PanelId) => tabs().find((tab) => tab.id === id)?.state;
const openTabs = () => tabs().filter((tab) => tab.state === 'open').map((tab) => tab.id);

function renderDock() {
  return renderToStaticMarkup(
    <DetailDock renderPanel={(id) => <PanelFrame id={id}><div>{`${id} body`}</div></PanelFrame>} />,
  );
}

describe('detail dock', () => {
  beforeEach(reset);

  it('lists Devices, Mixer, Piano Roll, Sampler, FX Graph and starts collapsed', () => {
    expect(DETAIL_DOCK_TAB_IDS).toEqual(['devices', 'mixer', 'pianoRoll', 'sampler', 'fxGraph']);
    expect(tabs().map((tab) => tab.id)).toEqual(DETAIL_DOCK_TAB_IDS);
    expect(openTabs()).toEqual([]);

    const html = renderDock();
    expect(html).toContain('data-dock-state="collapsed"');
    expect(html).toContain('role="tablist"');
    for (const id of DETAIL_DOCK_TAB_IDS) expect(html).toContain(`data-detail-tab="${id}"`);
    expect(html).not.toContain('xleth-detail-dock-body');
  });

  it('a tab click opens it; clicking the open tab collapses the dock', () => {
    activateDetailTab('mixer');
    expect(openTabs()).toEqual(['mixer']);

    activateDetailTab('mixer');
    expect(openTabs()).toEqual([]);
    expect(stateOf('mixer')).toBe('docked');
  });

  it('shows one panel at a time', () => {
    activateDetailTab('mixer');
    activateDetailTab('fxGraph');
    expect(openTabs()).toEqual(['fxGraph']);
    expect(stateOf('mixer')).toBe('docked');
  });

  it('the F-key toggle opens and collapses its own tab', () => {
    const registry = usePanelRegistry.getState();
    registry.togglePanel('mixer');
    expect(openTabs()).toEqual(['mixer']);
    registry.togglePanel('pianoRoll');
    expect(openTabs()).toEqual(['pianoRoll']);
    registry.togglePanel('pianoRoll');
    expect(openTabs()).toEqual([]);
  });

  it('pops a tab out into a window and brings it back', () => {
    activateDetailTab('mixer');
    togglePopOutDetailTab('mixer');

    const panels = usePanelRegistry.getState().panels;
    expect(panels.mixer.mode).toBe('floating');
    expect(panels.mixer.hidden).toBe(false);
    expect(stateOf('mixer')).toBe('popped');
    expect(openTabs()).toEqual([]);

    // While popped out the tab brings the window forward rather than docking it.
    activateDetailTab('mixer');
    expect(stateOf('mixer')).toBe('popped');

    togglePopOutDetailTab('mixer');
    expect(usePanelRegistry.getState().panels.mixer.mode).toBe('docked');
    expect(openTabs()).toEqual(['mixer']);
  });

  it('a closed pop-out window comes home through its tab', () => {
    togglePopOutDetailTab('pianoRoll');
    usePanelRegistry.getState().closePanel('pianoRoll');
    expect(stateOf('pianoRoll')).toBe('stowed');

    activateDetailTab('pianoRoll');
    expect(openTabs()).toEqual(['pianoRoll']);
  });

  it('renders the open panel without its own titlebar: the tab is the title', () => {
    activateDetailTab('mixer');
    const html = renderDock();
    expect(html).toContain('data-dock-state="open"');
    expect(html).toContain('id="xleth-detail-dock-body"');
    expect(html).toContain('mixer body');
    expect(html).toContain('aria-selected="true"');
    expect(html).not.toContain('xleth-windowing-titlebar');
    expect(html).toContain(`aria-label="Pop out ${PANEL_CATALOG.mixer.title}"`);
  });

  it('a panel dragged to the bottom edge joins the strip while it is open', () => {
    usePanelRegistry.getState().dockPanel('preview', 'bottom');
    expect(tabs().map((tab) => tab.id)).toEqual([...DETAIL_DOCK_TAB_IDS, 'preview']);
    expect(openTabs()).toEqual(['preview']);
  });
});

describe('docked chrome and pop-outs', () => {
  beforeEach(reset);

  it('a docked panel renders no titlebar; its floating window does', () => {
    usePanelRegistry.getState().applyPreset('xleth-arrange');
    const docked = renderToStaticMarkup(<PanelFrame id="inspector"><div /></PanelFrame>);
    expect(docked).toContain('data-panel-mode="docked"');
    expect(docked).not.toContain('xleth-windowing-titlebar');

    usePanelRegistry.getState().undockPanel('inspector', 20, 20);
    const floating = renderToStaticMarkup(<PanelFrame id="inspector"><div /></PanelFrame>);
    expect(floating).toContain('xleth-windowing-titlebar');
    expect(floating).toContain('aria-label="Return Inspector to the dock"');
  });

  it('the popped-out Preview returns to its own slot, left of the Inspector', async () => {
    usePanelRegistry.getState().applyPreset('xleth-arrange');
    const { popOutPreview } = await import('../panels/PreviewPanel');
    popOutPreview();
    expect(usePanelRegistry.getState().panels.preview.mode).toBe('floating');

    const { docked } = usePanelRegistry.getState().panels.preview;
    usePanelRegistry.getState().dockPanel('preview', 'top', docked.orderInRegion);
    const panels = usePanelRegistry.getState().panels;
    expect(panels.preview.docked.orderInRegion).toBe(0);
    expect(panels.inspector.docked.orderInRegion).toBe(1);
  });

  it('in Compose a popped-out Preview offers to return to the left region, not to a top row', async () => {
    const { popOutPreview } = await import('../panels/PreviewPanel');
    popOutPreview();
    const { preview } = usePanelRegistry.getState().panels;
    expect(preview.mode).toBe('floating');
    // Undocking keeps the region the panel sat in; the title bar's return control reads it.
    expect(preview.docked.region).toBe('left');
    const floating = renderToStaticMarkup(<PanelFrame id="preview"><div /></PanelFrame>);
    expect(floating).toContain('aria-label="Return Preview to the dock"');
  });
});
