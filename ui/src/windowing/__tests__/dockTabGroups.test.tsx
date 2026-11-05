import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { DockRegion, dockedPanelKey, parseDockedPanelKey } from '../components/DockRegion';
import {
  createInitialDockRegionSizes,
  createInitialPanelStates,
  dockSlotKey,
  getRegionSlots,
  usePanelRegistry,
} from '../registry/PanelRegistry';
import { PANEL_CATALOG } from '../registry/panelCatalog';

function reset() {
  usePanelRegistry.setState({
    panels: createInitialPanelStates(),
    dockRegionSizes: createInitialDockRegionSizes(),
    panelProps: {},
    recentlyClosed: [],
  });
}

function slotIdsFor(region: 'left' | 'right' | 'top' | 'bottom') {
  return getRegionSlots(usePanelRegistry.getState().panels, region);
}

describe('dock tab groups', () => {
  beforeEach(reset);

  it('docking two panels to one region gives each its own slot', () => {
    const registry = usePanelRegistry.getState();
    registry.dockPanel('timeline', 'bottom');
    registry.dockPanel('mixer', 'bottom');

    expect(slotIdsFor('bottom')).toEqual([['timeline'], ['mixer']]);
    const panels = usePanelRegistry.getState().panels;
    expect(panels.timeline.docked.orderInRegion).toBe(0);
    expect(panels.mixer.docked.orderInRegion).toBe(1);
    expect(panels.timeline.docked.tabGroupId).toBeNull();
  });

  it('dockPanelAsTab merges two panels into one slot with one active tab', () => {
    const registry = usePanelRegistry.getState();
    registry.dockPanel('timeline', 'bottom');
    registry.dockPanelAsTab('mixer', 'timeline');

    expect(slotIdsFor('bottom')).toEqual([['timeline', 'mixer']]);
    const panels = usePanelRegistry.getState().panels;
    expect(dockSlotKey(panels.timeline)).toBe(dockSlotKey(panels.mixer));
    expect(panels.mixer.docked.tabActive).toBe(true);
    expect(panels.timeline.docked.tabActive).toBe(false);
    // The slot has one size, not one per member.
    expect(panels.timeline.docked.sizeInRegion).toBe(panels.mixer.docked.sizeInRegion);
  });

  it('activateTab moves the visible tab without disturbing the slot', () => {
    const registry = usePanelRegistry.getState();
    registry.dockPanel('timeline', 'bottom');
    registry.dockPanelAsTab('mixer', 'timeline');
    registry.activateTab('timeline');

    const panels = usePanelRegistry.getState().panels;
    expect(panels.timeline.docked.tabActive).toBe(true);
    expect(panels.mixer.docked.tabActive).toBe(false);
    expect(slotIdsFor('bottom')).toEqual([['timeline', 'mixer']]);
  });

  it('undocking the last tab collapses the group back to a plain slot', () => {
    const registry = usePanelRegistry.getState();
    registry.dockPanel('timeline', 'bottom');
    registry.dockPanelAsTab('mixer', 'timeline');
    registry.undockPanel('mixer', 100, 100);

    const panels = usePanelRegistry.getState().panels;
    expect(panels.mixer.mode).toBe('floating');
    // A group of one carries no group id, so re-docking cannot silently rejoin.
    expect(panels.timeline.docked.tabGroupId).toBeNull();
    expect(panels.mixer.docked.tabGroupId).toBeNull();
    expect(slotIdsFor('bottom')).toEqual([['timeline']]);
  });

  it('reopening a panel never absorbs it into a neighbour slot', () => {
    const registry = usePanelRegistry.getState();
    registry.dockPanel('timeline', 'bottom');
    registry.dockPanel('mixer', 'bottom');
    registry.closePanel('mixer');
    registry.openPanel('mixer');

    expect(slotIdsFor('bottom')).toEqual([['timeline'], ['mixer']]);
  });

  it('closing a tab leaves the remaining tab visible', () => {
    const registry = usePanelRegistry.getState();
    registry.dockPanel('timeline', 'bottom');
    registry.dockPanelAsTab('mixer', 'timeline');
    registry.closePanel('mixer');

    const panels = usePanelRegistry.getState().panels;
    expect(slotIdsFor('bottom')).toEqual([['timeline']]);
    expect(panels.timeline.docked.tabActive).toBe(true);
  });

  it('focusing a background tab brings it to the front of its slot', () => {
    const registry = usePanelRegistry.getState();
    registry.dockPanel('timeline', 'bottom');
    registry.dockPanelAsTab('mixer', 'timeline');
    expect(usePanelRegistry.getState().panels.timeline.docked.tabActive).toBe(false);

    registry.focusPanel('timeline');
    expect(usePanelRegistry.getState().panels.timeline.docked.tabActive).toBe(true);
  });

  it('a splitter resize moves the whole slot, not just the visible tab', () => {
    const registry = usePanelRegistry.getState();
    registry.dockPanel('timeline', 'bottom');
    registry.dockPanelAsTab('mixer', 'timeline');
    registry.dockPanel('pianoRoll', 'bottom');

    registry.resizeDockedPanelPair('bottom', 'mixer', 400, 'pianoRoll', 300);

    const panels = usePanelRegistry.getState().panels;
    expect(panels.mixer.docked.sizeInRegion).toBe(400);
    // Without this the hidden tab would keep the old size and
    // normalizeDockSlots would widen the slot right back.
    expect(panels.timeline.docked.sizeInRegion).toBe(400);
    expect(panels.pianoRoll.docked.sizeInRegion).toBe(300);
  });

  it('renders a tab strip for a shared slot and only the active panel body', () => {
    const registry = usePanelRegistry.getState();
    registry.dockPanel('timeline', 'bottom');
    registry.dockPanelAsTab('mixer', 'timeline');

    const html = renderToStaticMarkup(<DockRegion side="bottom" />);

    expect(html).toContain('data-testid="xleth-panel-tabstrip"');
    expect(html).toContain('data-tab-id="timeline"');
    expect(html).toContain('data-tab-id="mixer"');
    expect(html).toContain('role="tablist"');
    // Mixer is the active tab; Timeline stays mounted but unpainted.
    expect(html).toContain('data-panel-mode="docked"');
    expect(html).toContain('data-panel-mode="inactive-tab"');
    expect(html).toContain('data-slot-tab-count="2"');
  });

  it('a single-panel slot renders no tab strip', () => {
    usePanelRegistry.getState().dockPanel('timeline', 'bottom');
    const html = renderToStaticMarkup(<DockRegion side="bottom" />);
    expect(html).not.toContain('xleth-panel-tabstrip');
  });

  it('dockedPanelKey round-trips slot membership through parseDockedPanelKey', () => {
    const registry = usePanelRegistry.getState();
    registry.dockPanel('timeline', 'bottom');
    registry.dockPanelAsTab('mixer', 'timeline');
    registry.dockPanel('pianoRoll', 'bottom');

    const key = dockedPanelKey('bottom', [], usePanelRegistry.getState().panels);
    const parsed = parseDockedPanelKey(key);

    expect(parsed.map((slot) => slot.ids)).toEqual([['timeline', 'mixer'], ['pianoRoll']]);
    expect(parsed[0].activeId).toBe('mixer');
    expect(parsed[1].activeId).toBe('pianoRoll');
  });

  it('clamps a slot pair against the catalog minimums', () => {
    const registry = usePanelRegistry.getState();
    registry.dockPanel('timeline', 'bottom');
    registry.dockPanel('mixer', 'bottom');

    // Ask for far less than the mixer's declared minimum.
    registry.resizeDockedPanelPair('bottom', 'timeline', 900, 'mixer', 20);

    const panels = usePanelRegistry.getState().panels;
    expect(panels.mixer.docked.sizeInRegion).toBe(PANEL_CATALOG.mixer.minDockedSize);
    expect(panels.timeline.docked.sizeInRegion)
      .toBe(920 - PANEL_CATALOG.mixer.minDockedSize);
  });
});

describe('panel collapse', () => {
  beforeEach(reset);

  it('collapse keeps the panel open and where it was', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('mixer');
    const before = usePanelRegistry.getState().panels.mixer.floating;

    registry.collapsePanel('mixer');
    const panel = usePanelRegistry.getState().panels.mixer;

    // The distinction that makes minimize different from close.
    expect(panel.collapsed).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(panel.floating).toEqual(before);
  });

  it('toggleCollapsePanel round-trips', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('mixer');
    registry.toggleCollapsePanel('mixer');
    expect(usePanelRegistry.getState().panels.mixer.collapsed).toBe(true);
    registry.toggleCollapsePanel('mixer');
    expect(usePanelRegistry.getState().panels.mixer.collapsed).toBe(false);
  });

  it('opening a collapsed panel expands it', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('mixer');
    registry.collapsePanel('mixer');
    registry.openPanel('mixer');
    expect(usePanelRegistry.getState().panels.mixer.collapsed).toBe(false);
  });

  it('a collapsed docked slot neither fills the region nor grows a splitter', () => {
    const registry = usePanelRegistry.getState();
    registry.dockPanel('timeline', 'bottom');
    registry.dockPanel('mixer', 'bottom');
    registry.collapsePanel('mixer');

    const html = renderToStaticMarkup(<DockRegion side="bottom" />);
    expect(html).toContain('xleth-docked-panel-slot--collapsed');
    expect(html).not.toContain('xleth-dock-splitter-timeline-mixer');
  });

  it('maximizing clears collapse and restoring brings it back', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('mixer');
    registry.collapsePanel('mixer');
    registry.maximizePanel('mixer');
    expect(usePanelRegistry.getState().panels.mixer.collapsed).toBe(false);

    registry.restorePanel('mixer');
    expect(usePanelRegistry.getState().panels.mixer.collapsed).toBe(true);
  });

  it('a fixed-size panel cannot be maximized', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('sampler');
    registry.maximizePanel('sampler');
    expect(usePanelRegistry.getState().panels.sampler.mode).toBe('floating');
  });
});

describe('panel props channel', () => {
  beforeEach(reset);

  it('openPanel carries per-open context and keeps it out of the layout', () => {
    usePanelRegistry.getState().openPanel('splitSyllables', { region: { id: 7 } });

    expect(usePanelRegistry.getState().panelProps.splitSyllables)
      .toEqual({ region: { id: 7 } });
    // Props describe one opening, so they must never reach a persisted panel
    // state. (`docked.region` is a real field, so look for the payload value.)
    expect(usePanelRegistry.getState().panels.splitSyllables)
      .not.toHaveProperty('panelProps');
    expect(JSON.stringify(usePanelRegistry.getState().panels)).not.toContain('"id":7');
  });

  it('reopening with new context replaces the old context', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('sampler', { regionId: 1 });
    registry.closePanel('sampler');
    registry.openPanel('sampler', { regionId: 2 });

    expect(usePanelRegistry.getState().panelProps.sampler).toEqual({ regionId: 2 });
  });

  it('opening without context leaves the previous context untouched', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('sampler', { regionId: 1 });
    registry.closePanel('sampler');
    registry.openPanel('sampler');

    expect(usePanelRegistry.getState().panelProps.sampler).toEqual({ regionId: 1 });
  });
});

describe('reopen last closed', () => {
  beforeEach(reset);

  it('reopens the most recently closed panel', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('mixer');
    registry.openPanel('pianoRoll');
    registry.closePanel('mixer');
    registry.closePanel('pianoRoll');

    registry.reopenLastClosed();
    expect(usePanelRegistry.getState().panels.pianoRoll.hidden).toBe(false);
    expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(true);

    usePanelRegistry.getState().reopenLastClosed();
    expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(false);
  });

  it('is a no-op when nothing has been closed', () => {
    expect(() => usePanelRegistry.getState().reopenLastClosed()).not.toThrow();
  });
});
