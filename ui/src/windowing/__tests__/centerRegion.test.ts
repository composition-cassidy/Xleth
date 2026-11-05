import { beforeEach, describe, expect, it } from 'vitest';
import { fillSlotIndex } from '../components/DockRegion';
import {
  centerOccupants,
  clonePanelStates,
  createInitialDockRegionSizes,
  createInitialPanelStates,
  getRegionSlots,
  isPinnedToCenter,
  normalizeDockSlots,
  usePanelRegistry,
} from '../registry/PanelRegistry';
import { mergePanelStateMap } from '../registry/panelStateMerge';

function reset() {
  usePanelRegistry.setState({
    panels: createInitialPanelStates(),
    dockRegionSizes: createInitialDockRegionSizes(),
    panelProps: {},
    recentlyClosed: [],
  });
}

const panels = () => usePanelRegistry.getState().panels;

describe('center region', () => {
  beforeEach(reset);

  it('starts with the timeline docked in the center', () => {
    expect(panels().timeline.hidden).toBe(false);
    expect(panels().timeline.mode).toBe('docked');
    expect(getRegionSlots(panels(), 'center')).toEqual([['timeline']]);
  });

  it('refuses every action that would leave the center empty', () => {
    const registry = usePanelRegistry.getState();
    registry.closePanel('timeline');
    registry.collapsePanel('timeline');
    registry.undockPanel('timeline', 40, 40);
    registry.dockPanel('timeline', 'left');
    registry.openPanel('mixer');
    registry.dockPanel('mixer', 'bottom');
    registry.dockPanelAsTab('timeline', 'mixer');

    expect(panels().timeline.hidden).toBe(false);
    expect(panels().timeline.collapsed).toBe(false);
    expect(getRegionSlots(panels(), 'center')).toEqual([['timeline']]);
  });

  it('lets the timeline leave once another panel shares the center', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('pianoRoll');
    registry.dockPanelAsTab('pianoRoll', 'timeline');
    expect(isPinnedToCenter(panels(), 'timeline')).toBe(false);

    registry.closePanel('timeline');

    expect(panels().timeline.hidden).toBe(true);
    expect(centerOccupants(panels())).toEqual(['pianoRoll']);
    expect(isPinnedToCenter(panels(), 'pianoRoll')).toBe(true);
  });

  it('a maximized center panel still owns the center and restores into it', () => {
    const registry = usePanelRegistry.getState();
    registry.maximizePanel('timeline');
    expect(centerOccupants(panels())).toEqual(['timeline']);

    registry.restorePanel('timeline');
    expect(panels().timeline.mode).toBe('docked');
    expect(panels().timeline.docked.region).toBe('center');
  });

  it('puts the timeline back when a stored layout leaves the center empty', () => {
    const stored = mergePanelStateMap(createInitialPanelStates(), {
      timeline: { hidden: false, mode: 'floating', floating: { x: 260, y: 60, width: 1200, height: 480 } },
    });
    expect(centerOccupants(stored)).toEqual([]);

    const normalized = normalizeDockSlots(clonePanelStates(stored));
    expect(normalized.timeline.mode).toBe('docked');
    expect(normalized.timeline.docked.region).toBe('center');
  });

  it('never lets a drawer be stored in the center', () => {
    const merged = mergePanelStateMap(createInitialPanelStates(), {
      sampleSelector: { docked: { region: 'center' } },
    });
    expect(merged.sampleSelector.docked.region).toBe('left');
  });
});

describe('fill slot', () => {
  const slot = (activeId: 'preview' | 'mixer' | 'pianoRoll', collapsed = false) => ({
    ids: [activeId],
    activeId,
    size: 300,
    collapsed,
  });

  it('prefers a dockFill panel over the last slot', () => {
    expect(fillSlotIndex([slot('preview'), slot('mixer')])).toBe(0);
  });

  it('falls back to the last open slot', () => {
    expect(fillSlotIndex([slot('mixer'), slot('pianoRoll')])).toBe(1);
    expect(fillSlotIndex([slot('mixer'), slot('pianoRoll', true)])).toBe(0);
  });

  it('reports no fill slot when every slot is collapsed', () => {
    expect(fillSlotIndex([slot('mixer', true)])).toBe(-1);
  });
});

describe('default layout', () => {
  beforeEach(reset);

  it('resetLayout lands on the tiled default: browser, preview + inspector, arrangement', () => {
    const registry = usePanelRegistry.getState();
    registry.applyPreset('fl-compose');
    registry.resetLayout();

    const state = usePanelRegistry.getState();
    expect(getRegionSlots(state.panels, 'center')).toEqual([['timeline']]);
    expect(getRegionSlots(state.panels, 'top')).toEqual([['preview'], ['inspector']]);
    expect(state.panels.sampleSelector.hidden).toBe(false);
    expect(state.panels.mixer.hidden).toBe(true);
    expect(state.dockRegionSizes.top).toBe(340);
  });
});
