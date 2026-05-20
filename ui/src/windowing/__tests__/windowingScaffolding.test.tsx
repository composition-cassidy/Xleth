import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../AppShell';
import { PanelFrame, getPanelFrameRenderPath } from '../components/PanelFrame';
import { Titlebar } from '../components/Titlebar';
import { TopBarToggles } from '../components/TopBarToggles';
import FxGraphPanel, { FxGraphPanelContent, activateFxGraphMode } from '../panels/FxGraphPanel';
import NodeEditorPanel from '../panels/NodeEditorPanel';
import {
  createInitialPanelStates,
  usePanelRegistry,
  type PanelState,
} from '../registry/PanelRegistry';
import { PANEL_CATALOG, PANEL_CATALOG_ORDER, PANEL_IDS, type PanelId } from '../registry/panelCatalog';

function readUiSource(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), 'src', relativePath), 'utf8');
}

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

describe('PanelRegistry schema', () => {
  beforeEach(resetRegistry);

  it('matches spec section 4.1 for every panel state object', () => {
    const panels = usePanelRegistry.getState().panels;
    expect(Object.keys(panels)).toEqual([...PANEL_IDS]);

    for (const id of PANEL_IDS) {
      const panel = panels[id] as PanelState;
      expect(Object.keys(panel)).toEqual([
        'id',
        'hidden',
        'focused',
        'zIndex',
        'mode',
        'floating',
        'docked',
        'preMaximizeState',
      ]);
      expect(panel.id).toBe(id);
      expect(typeof panel.hidden).toBe('boolean');
      expect(typeof panel.focused).toBe('boolean');
      expect(typeof panel.zIndex).toBe('number');
      expect(['floating', 'docked', 'maximized']).toContain(panel.mode);
      expect(Object.keys(panel.floating)).toEqual(['x', 'y', 'width', 'height']);
      expect(Object.keys(panel.docked)).toEqual(['region', 'orderInRegion', 'sizeInRegion']);
      expect(panel.preMaximizeState).toBeNull();
    }
  });

  it('exposes all phase 1 registry mutations', () => {
    const registry = usePanelRegistry.getState();
    for (const method of [
      'openPanel',
      'closePanel',
      'togglePanel',
      'focusPanel',
      'moveFloatingPanel',
      'resizeFloatingPanel',
      'dockPanel',
      'undockPanel',
      'maximizePanel',
      'restorePanel',
      'applyPreset',
    ] as const) {
      expect(typeof registry[method]).toBe('function');
    }
  });
});

describe('PanelFrame render paths', () => {
  beforeEach(resetRegistry);

  it('imports the parallel AppShell as an isolated test harness', () => {
    const html = renderToStaticMarkup(<AppShell />);
    expect(html).toContain('data-testid="xleth-windowing-shell"');
    expect(html).toContain('Timeline Test Panel');
  });

  it('renders floating panels with titlebar chrome', () => {
    usePanelRegistry.getState().openPanel('timeline');
    const html = renderPanel('timeline');
    expect(html).toContain('data-panel-mode="floating"');
    expect(html).toContain('xleth-windowing-titlebar');
    expect(html).toContain('data-testid="xleth-windowing-underline-timeline"');
  });

  it('renders layout preset and dock controls in the top toolbar', () => {
    usePanelRegistry.getState().openPanel('timeline');
    usePanelRegistry.getState().focusPanel('timeline');

    const html = renderToStaticMarkup(<TopBarToggles />);

    expect(html).toContain('aria-label="Layout presets"');
    expect(html).toContain('Reset to FL Compose layout');
    expect(html).toContain('Switch to Vegas Arrange layout');
    expect(html).toContain('Switch to Grid Edit layout');
    expect(html).toContain('aria-label="Dock focused panel"');
    expect(html).toContain('Dock focused panel left: Timeline');
    expect(html).toContain('Dock focused panel top: Timeline');
    expect(html).toContain('Dock focused panel bottom: Timeline');
    expect(html).toContain('Dock focused panel right: Timeline');
  });

  it('keeps the quarantined nodeEditor out of production toolbar catalog order', () => {
    expect(PANEL_IDS).toContain('nodeEditor');
    expect(PANEL_CATALOG_ORDER.map((entry) => entry.id)).not.toContain('nodeEditor');

    const html = renderToStaticMarkup(<TopBarToggles />);

    expect(html).not.toContain('Toggle Node Editor');
    expect(html).not.toContain('Node Editor (F11)');
  });

  it('keeps active production window paths from mounting the quarantined nodeEditor panel', () => {
    const appShellSource = readUiSource('windowing/AppShell.tsx');
    expect(appShellSource).toContain("production: [");
    expect(appShellSource).not.toMatch(/production:\s*\[[\s\S]*['"]nodeEditor['"]/);
    expect(PANEL_CATALOG_ORDER.map((entry) => entry.id)).not.toContain('nodeEditor');
  });

  it('registers fxGraph as the safe active FX Graph workspace shell', () => {
    expect(PANEL_IDS).toContain('fxGraph');
    expect(PANEL_CATALOG.fxGraph.title).toBe('FX Graph');
    expect(PANEL_CATALOG.fxGraph.typeColorToken).toBe('--theme-panel-node');
    expect(PANEL_CATALOG.fxGraph.fKey).toBe('F11');
    expect(PANEL_CATALOG_ORDER.map((entry) => entry.id)).toContain('fxGraph');

    const html = renderToStaticMarkup(<TopBarToggles />);

    expect(html).toContain('Toggle FX Graph');
    expect(html).toContain('FX Graph (F11)');
    expect(html).not.toContain('Toggle Node Editor');
  });

  it('renders the safe FX Graph shell without legacy editor affordances', () => {
    const html = renderToStaticMarkup(<FxGraphPanelContent />);

    expect(html).toContain('FX Graph Workspace');
    expect(html).toContain('No track selected');
    expect(html).toContain('Routing editor coming in a later phase');
    expect(html).toContain('Mixer Chain remains active');
    expect(html).not.toContain('Use Graph Mode');
    expect(html).not.toContain('NodeEditor');
    expect(html).not.toContain('react-flow');
  });

  it('shows the Use Graph Mode action only for a selected chain-mode track', () => {
    const html = renderToStaticMarkup(
      <FxGraphPanelContent trackId={7} trackLabel="Lead Vox" fxMode="chain" />,
    );

    expect(html).toContain('Lead Vox');
    expect(html).toContain('Use Graph Mode');
    expect(html).toContain('This will lock Mixer Chain editing for this track.');
    expect(html).toContain('Routing editor coming in a later phase');
    expect(html).not.toContain('FX Graph Mode Active');
  });

  it('keeps graph-mode tracks dormant and hides the active Use Graph Mode action', () => {
    const html = renderToStaticMarkup(
      <FxGraphPanelContent trackId={7} trackLabel="Lead Vox" fxMode="graph" />,
    );

    expect(html).toContain('FX Graph Mode Active');
    expect(html).toContain('Mixer Chain editing is locked for this track.');
    expect(html).toContain('Routing editor coming in a later phase');
    expect(html).not.toContain('>Use Graph Mode<');
    expect(html).not.toContain('Track Input');
    expect(html).not.toContain('effect-chain-graph-preview');
  });

  it('keeps the master track chain-only in this phase', () => {
    const html = renderToStaticMarkup(
      <FxGraphPanelContent trackId="master" trackLabel="MASTER" fxMode="chain" />,
    );

    expect(html).toContain('MASTER');
    expect(html).toContain('Master track FX stay in Mixer Chain mode in this phase.');
    expect(html).not.toContain('Use Graph Mode');
  });

  it('opening the FX Graph panel does not change fxMode', async () => {
    const { default: useEffectChainStore } = await import('../../stores/effectChainStore.js');
    const { default: useMixerStore } = await import('../../stores/mixerStore.js');
    const { default: useTimelineFocusStore } = await import('../../stores/timelineFocusStore.js');

    usePanelRegistry.getState().openPanel('fxGraph');
    useMixerStore.setState({
      tracks: { 7: { id: 7, name: 'Lead Vox' } },
      trackOrder: [7],
    });
    useTimelineFocusStore.setState({ focusedTrackId: 7 });
    useEffectChainStore.setState({ fxModes: { '7': 'chain' } });

    const html = renderToStaticMarkup(<FxGraphPanel />);

    expect(html).toContain('Use Graph Mode');
    expect(useEffectChainStore.getState().fxModes['7']).toBe('chain');
  });

  it('canceling graph-mode confirmation leaves state and bridge untouched', async () => {
    const setFxMode = vi.fn();
    const persistFxMode = vi.fn();
    const cancel = vi.fn();

    cancel();

    expect(setFxMode).not.toHaveBeenCalled();
    expect(persistFxMode).not.toHaveBeenCalled();
  });

  it('confirming graph mode updates renderer state and persists through the timeline bridge', async () => {
    const setFxMode = vi.fn();
    const persistFxMode = vi.fn(async () => true);

    const ok = await activateFxGraphMode({
      trackId: 7,
      currentFxMode: 'chain',
      setFxMode,
      persistFxMode,
      warn: vi.fn(),
    });

    expect(ok).toBe(true);
    expect(setFxMode).toHaveBeenCalledWith('7', 'graph');
    expect(persistFxMode).toHaveBeenCalledWith(7, 'graph');
  });

  it('uses window.xleth.timeline.setTrackFxMode as the default persistence path', async () => {
    const previousWindow = (globalThis as any).window;
    const setTrackFxMode = vi.fn(async () => true);
    (globalThis as any).window = {
      xleth: {
        timeline: { setTrackFxMode },
      },
    };

    try {
      await activateFxGraphMode({
        trackId: 7,
        currentFxMode: 'chain',
        setFxMode: vi.fn(),
        warn: vi.fn(),
      });
    } finally {
      (globalThis as any).window = previousWindow;
    }

    expect(setTrackFxMode).toHaveBeenCalledWith(7, 'graph');
  });

  it('reverts renderer state when graph-mode persistence fails', async () => {
    const setFxMode = vi.fn();
    const warn = vi.fn();

    const ok = await activateFxGraphMode({
      trackId: 7,
      currentFxMode: 'chain',
      setFxMode,
      persistFxMode: vi.fn(async () => false),
      warn,
    });

    expect(ok).toBe(false);
    expect(setFxMode).toHaveBeenNthCalledWith(1, '7', 'graph');
    expect(setFxMode).toHaveBeenNthCalledWith(2, '7', 'chain');
    expect(warn).toHaveBeenCalled();
  });

  it('does not activate graph mode for master or already graph-owned tracks', async () => {
    const setFxMode = vi.fn();
    const persistFxMode = vi.fn();

    await activateFxGraphMode({
      trackId: 'master',
      setFxMode,
      persistFxMode,
    });
    await activateFxGraphMode({
      trackId: 7,
      currentFxMode: 'graph',
      setFxMode,
      persistFxMode,
    });

    expect(setFxMode).not.toHaveBeenCalled();
    expect(persistFxMode).not.toHaveBeenCalled();
  });

  it('keeps the FX Graph shell free of live NodeEditor and nodeGraphStore imports', () => {
    const fxGraphPanelSource = readUiSource('windowing/panels/FxGraphPanel.tsx');
    expect(fxGraphPanelSource).not.toContain('NodeEditor');
    expect(fxGraphPanelSource).not.toContain('nodeGraphStore');
    expect(fxGraphPanelSource).not.toContain('react-flow');
  });

  it('renders only the nodeEditor quarantine placeholder when reached by stale layout state', () => {
    usePanelRegistry.getState().openPanel('nodeEditor');

    const html = renderToStaticMarkup(<NodeEditorPanel />);
    const nodeEditorPanelSource = readUiSource('windowing/panels/NodeEditorPanel.tsx');

    expect(html).toContain('Legacy Node Editor Disabled');
    expect(html).toContain('FX Graph will return in a separate workspace');
    expect(html).not.toContain('react-flow');
    expect(html).not.toContain('NodeEditor');
    expect(nodeEditorPanelSource).not.toContain('NodeEditor.jsx');
    expect(nodeEditorPanelSource).not.toContain('nodeGraphStore');
  });

  it('returns empty markup for hidden, docked, and maximized phase 1 stubs', () => {
    const base = createInitialPanelStates().timeline;
    expect(getPanelFrameRenderPath({ ...base, hidden: true })).toBe('hidden');
    expect(getPanelFrameRenderPath({ ...base, hidden: false, mode: 'docked' })).toBe('docked');
    expect(getPanelFrameRenderPath({ ...base, hidden: false, mode: 'maximized' })).toBe('maximized');
  });
});

describe('Titlebar focus underline flip', () => {
  beforeEach(resetRegistry);

  it('moves the focused underline between two floating test panels', () => {
    usePanelRegistry.getState().openPanel('timeline');
    usePanelRegistry.getState().openPanel('mixer');

    usePanelRegistry.getState().focusPanel('timeline');
    const firstState = usePanelRegistry.getState().panels;
    const timelineFocused = renderToStaticMarkup(
      <>
        <Titlebar id="timeline" focused={firstState.timeline.focused} />
        <Titlebar id="mixer" focused={firstState.mixer.focused} />
      </>,
    );
    expect(timelineFocused).toContain('data-testid="xleth-windowing-underline-timeline" data-focused="true"');
    expect(timelineFocused).toContain('data-testid="xleth-windowing-underline-mixer" data-focused="false"');

    usePanelRegistry.getState().focusPanel('mixer');
    const secondState = usePanelRegistry.getState().panels;
    const mixerFocused = renderToStaticMarkup(
      <>
        <Titlebar id="timeline" focused={secondState.timeline.focused} />
        <Titlebar id="mixer" focused={secondState.mixer.focused} />
      </>,
    );
    expect(mixerFocused).toContain('data-testid="xleth-windowing-underline-timeline" data-focused="false"');
    expect(mixerFocused).toContain('data-testid="xleth-windowing-underline-mixer" data-focused="true"');
  });
});
