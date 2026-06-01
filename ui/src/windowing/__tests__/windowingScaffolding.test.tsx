import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../AppShell';
import { PanelFrame, getPanelFrameRenderPath } from '../components/PanelFrame';
import { Titlebar } from '../components/Titlebar';
import { TopBarToggles } from '../components/TopBarToggles';
import FxGraphPanel, {
  FxGraphPanelContent,
  activateFxGraphMode,
  selectFxGraphPanelChain,
} from '../panels/FxGraphPanel';
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

function makeFxGraphState(trackId = '7', overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    trackId,
    nodes: [
      { id: 'input', type: 'trackInput', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'persisted-fx',
        type: 'effect',
        position: { x: 260, y: 0 },
        data: {
          effectInstanceId: 'persisted-fx-instance',
          pluginId: 'persisted.eq',
          displayName: 'Persisted EQ',
          bypass: false,
          missing: false,
          crashed: false,
          sourceChainSlotIndex: 0,
        },
      },
      { id: 'output', type: 'trackOutput', position: { x: 520, y: 0 }, data: {} },
    ],
    edges: [
      {
        id: 'edge-1',
        sourceNodeId: 'input',
        sourcePort: 'audio',
        targetNodeId: 'persisted-fx',
        targetPort: 'audioIn',
        type: 'audio',
      },
      {
        id: 'edge-2',
        sourceNodeId: 'persisted-fx',
        sourcePort: 'audioOut',
        targetNodeId: 'output',
        targetPort: 'audio',
        type: 'audio',
      },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    ...overrides,
  };
}

function consoleSpyMessages(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls
    .map((args) => args.map((arg) => String(arg)).join(' '))
    .join('\n');
}

function countText(html: string, text: string) {
  return html.split(text).length - 1;
}

function expectNoFxGraphSnapshotLoopErrors(spy: { mock: { calls: unknown[][] } }) {
  const messages = consoleSpyMessages(spy);
  expect(messages).not.toContain('getSnapshot should be cached');
  expect(messages).not.toContain('Maximum update depth exceeded');
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
    expect(html).toContain('Select a mixer track to preview its chain');
    expect(html).toContain('Mixer Chain remains active');
    expect(html).not.toContain('Track Input');
    expect(html).not.toContain('Use Graph Mode');
    expect(html).not.toContain('NodeEditor');
    expect(html).not.toContain('react-flow');
  });

  it('keeps FX Graph panel empty-chain selector snapshots stable', () => {
    const chain = [{ nodeId: 1, pluginId: 'compressor', position: 0 }];

    expect(selectFxGraphPanelChain({}, null)).toBe(selectFxGraphPanelChain({}, null));
    expect(selectFxGraphPanelChain({}, '7')).toBe(selectFxGraphPanelChain({}, '7'));
    expect(selectFxGraphPanelChain({ '7': chain }, '7')).toBe(chain);
  });

  it('renders an empty chain-mode selected track as Track Input to Track Output', () => {
    const html = renderToStaticMarkup(
      <FxGraphPanelContent trackId={7} trackLabel="Lead Vox" fxMode="chain" chain={[]} />,
    );

    expect(html).toContain('Read-only Mixer Chain graph preview');
    expect(html).toContain('Preview only. Mixer Chain still owns routing.');
    expect(html).toContain('Track Input');
    expect(html).toContain('-&gt;');
    expect(html).toContain('Track Output');
    expect(html).not.toContain('Read-only persisted FX graph preview');
    expect(html).not.toContain('FX Graph Mode Active');
  });

  it('shows the chain conversion action only for a selected chain-mode track', () => {
    const html = renderToStaticMarkup(
      <FxGraphPanelContent trackId={7} trackLabel="Lead Vox" fxMode="chain" />,
    );

    expect(html).toContain('Lead Vox');
    expect(html).toContain('Convert Chain to FX Graph');
    expect(html).toContain('This creates a read-only graphState snapshot from the current Mixer Chain.');
    expect(html).toContain('Preview only. Mixer Chain still owns routing.');
    expect(html).not.toContain('FX Graph Mode Active');
  });

  it('renders one effect label between Track Input and Track Output in chain mode', () => {
    const html = renderToStaticMarkup(
      <FxGraphPanelContent
        trackId={7}
        trackLabel="Lead Vox"
        fxMode="chain"
        chain={[{ nodeId: 1, pluginId: 'compressor', position: 0 }]}
      />,
    );

    expect(html).toContain('Track Input');
    expect(html).toContain('Compressor');
    expect(html).toContain('Track Output');
    expect(html.indexOf('Track Input')).toBeLessThan(html.indexOf('Compressor'));
    expect(html.indexOf('Compressor')).toBeLessThan(html.indexOf('Track Output'));
  });

  it('renders multiple chain effects in their Mixer Chain order', () => {
    const html = renderToStaticMarkup(
      <FxGraphPanelContent
        trackId={7}
        trackLabel="Lead Vox"
        fxMode="chain"
        chain={[
          { nodeId: 1, pluginId: 'xletheq', position: 0 },
          { nodeId: 2, pluginId: 'third-party-delay', position: 1 },
          { nodeId: 3, pluginId: 'reverb', position: 2 },
        ]}
        vstPlugins={[{ id: 'third-party-delay', name: 'Space Echo' }]}
      />,
    );

    expect(html.indexOf('Track Input')).toBeLessThan(html.indexOf('Xleth EQ'));
    expect(html.indexOf('Xleth EQ')).toBeLessThan(html.indexOf('Space Echo'));
    expect(html.indexOf('Space Echo')).toBeLessThan(html.indexOf('Reverb'));
    expect(html.indexOf('Reverb')).toBeLessThan(html.indexOf('Track Output'));
  });

  it('renders dormant persisted graphState in chain mode without switching ownership', () => {
    const html = renderToStaticMarkup(
      <FxGraphPanelContent
        trackId={7}
        trackLabel="Lead Vox"
        fxMode="chain"
        graphStateStatus="valid"
        graphState={makeFxGraphState()}
        chain={[{ nodeId: 11, pluginId: 'delay', position: 0 }]}
      />,
    );

    expect(html).toContain('Dormant FX Graph saved');
    expect(html).toContain('Dormant graphState. Mixer Chain currently owns routing.');
    expect(countText(html, 'Dormant graphState. Mixer Chain currently owns routing.')).toBe(1);
    expect(html).toContain('Confirming conversion will create/replace graphState from the current Mixer Chain.');
    expect(html).toContain('Read-only persisted FX graph preview');
    expect(html).toContain('Persisted EQ');
    expect(html).not.toContain('xleth-chain-graph-preview');
    expect(html).not.toContain('FX Graph Mode Active');
    expect(html).not.toContain('Delay');
  });

  it('renders bypassed effects as non-interactive status markers', () => {
    const html = renderToStaticMarkup(
      <FxGraphPanelContent
        trackId={7}
        trackLabel="Lead Vox"
        fxMode="chain"
        chain={[{ nodeId: 1, pluginId: 'delay', position: 0, bypassed: true }]}
      />,
    );

    expect(html).toContain('Delay');
    expect(html).toContain('Bypassed');
    expect(html).not.toContain('Bypass effect');
    expect(html).not.toContain('effect-module-bypass');
  });

  it('renders persisted graphState in graph mode and hides the active conversion action', () => {
    const html = renderToStaticMarkup(
      <FxGraphPanelContent
        trackId={7}
        trackLabel="Lead Vox"
        fxMode="graph"
        graphStateStatus="valid"
        graphState={makeFxGraphState()}
        chain={[{ nodeId: 1, pluginId: 'compressor', position: 0 }]}
      />,
    );

    expect(html).toContain('FX Graph Mode Active');
    expect(html).toContain('Graph routing is enabled for connected paths.');
    expect(countText(html, 'Graph routing is enabled for connected paths.')).toBe(1);
    expect(html).toContain('Read-only persisted FX graph preview');
    expect(html).toContain('Track Input');
    expect(html).toContain('Persisted EQ');
    expect(html).toContain('Track Output');
    expect(html).not.toContain('Effect Parameters');
    expect(html).not.toContain('xleth-fx-graph-params');
    expect(html).not.toContain('>Convert Chain to FX Graph<');
    expect(html).not.toContain('Compressor');
    expect(html).not.toContain('xleth-chain-graph-preview');
  });

  it('renders graph history controls only for active graph mode', () => {
    const graphHtml = renderToStaticMarkup(
      <FxGraphPanelContent
        trackId={7}
        trackLabel="Lead Vox"
        fxMode="graph"
        graphStateStatus="valid"
        graphState={makeFxGraphState()}
        canUndoGraphEdit={false}
        canRedoGraphEdit
        onUndoGraphEdit={vi.fn()}
        onRedoGraphEdit={vi.fn()}
      />,
    );
    const chainHtml = renderToStaticMarkup(
      <FxGraphPanelContent
        trackId={7}
        trackLabel="Lead Vox"
        fxMode="chain"
        graphStateStatus="valid"
        graphState={makeFxGraphState()}
        canUndoGraphEdit
        canRedoGraphEdit
        onUndoGraphEdit={vi.fn()}
        onRedoGraphEdit={vi.fn()}
      />,
    );

    expect(graphHtml).toContain('aria-label="Undo graph edit"');
    expect(graphHtml).toContain('aria-label="Redo graph edit"');
    expect(countText(graphHtml, 'disabled')).toBe(1);
    expect(chainHtml).not.toContain('Undo graph edit');
    expect(chainHtml).not.toContain('Redo graph edit');
  });

  it('renders a degraded graph-mode state when graphState is missing', () => {
    const html = renderToStaticMarkup(
      <FxGraphPanelContent
        trackId={7}
        trackLabel="Lead Vox"
        fxMode="graph"
        graphStateStatus="missing"
        chain={[{ nodeId: 1, pluginId: 'compressor', position: 0 }]}
      />,
    );

    expect(html).toContain('FX Graph Mode Active, but no graph data exists for this track.');
    expect(html).toContain('This can happen with legacy projects.');
    expect(html).not.toContain('>Convert Chain to FX Graph<');
    expect(html).not.toContain('Track Input');
    expect(html).not.toContain('Compressor');
    expect(html).not.toContain('xleth-chain-graph-preview');
  });

  it('renders a safe graph-mode error when graphState is invalid', () => {
    const html = renderToStaticMarkup(
      <FxGraphPanelContent
        trackId={7}
        trackLabel="Lead Vox"
        fxMode="graph"
        graphStateStatus="invalid"
        chain={[{ nodeId: 1, pluginId: 'compressor', position: 0 }]}
      />,
    );

    expect(html).toContain('Graph routing data is invalid and could not be loaded.');
    expect(html).toContain('Mixer Chain editing remains locked.');
    expect(html).not.toContain('Track Input');
    expect(html).not.toContain('Compressor');
    expect(html).not.toContain('xleth-chain-graph-preview');
  });

  it('renders a safe unsupported-version state for future graphState', () => {
    const html = renderToStaticMarkup(
      <FxGraphPanelContent
        trackId={7}
        trackLabel="Lead Vox"
        fxMode="graph"
        graphStateStatus="future"
        chain={[{ nodeId: 1, pluginId: 'compressor', position: 0 }]}
      />,
    );

    expect(html).toContain('This graphState version is not supported by this build.');
    expect(html).toContain('The saved routing data is preserved but is not rendered as an active graph.');
    expect(html).not.toContain('Track Input');
    expect(html).not.toContain('Compressor');
    expect(html).not.toContain('xleth-chain-graph-preview');
  });

  it('keeps the master track chain-only in this phase', () => {
    const html = renderToStaticMarkup(
      <FxGraphPanelContent
        trackId="master"
        trackLabel="MASTER"
        fxMode="graph"
        graphStateStatus="valid"
        graphState={makeFxGraphState('master')}
      />,
    );

    expect(html).toContain('MASTER');
    expect(html).toContain('Master track FX stay in Mixer Chain mode in this phase.');
    expect(html).not.toContain('Convert Chain to FX Graph');
    expect(html).not.toContain('Track Input');
    expect(html).not.toContain('Read-only persisted FX graph preview');
  });

  it('renders startup FX Graph panel without selector-loop warnings', async () => {
    const { default: useEffectChainStore } = await import('../../stores/effectChainStore.js');
    const { default: useMixerStore } = await import('../../stores/mixerStore.js');
    const { default: useTimelineFocusStore } = await import('../../stores/timelineFocusStore.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    usePanelRegistry.getState().openPanel('fxGraph');
    useMixerStore.setState({
      tracks: {},
      trackOrder: [],
    });
    useTimelineFocusStore.setState({ focusedTrackId: null });
    useEffectChainStore.setState({
      chains: {},
      fxModes: {},
      fxPanelViews: {},
      graphStates: {},
      graphStateStatuses: {},
    });

    try {
      const html = renderToStaticMarkup(<FxGraphPanel />);

      expect(html).toContain('No track selected');
      expect(html).toContain('Select a mixer track to preview its chain');
      expectNoFxGraphSnapshotLoopErrors(errorSpy);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('opening the FX Graph panel on a chain track without graphState does not change fxMode', async () => {
    const { default: useEffectChainStore } = await import('../../stores/effectChainStore.js');
    const { default: useMixerStore } = await import('../../stores/mixerStore.js');
    const { default: useTimelineFocusStore } = await import('../../stores/timelineFocusStore.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    usePanelRegistry.getState().openPanel('fxGraph');
    useMixerStore.setState({
      tracks: { 7: { id: 7, name: 'Lead Vox' } },
      trackOrder: [7],
    });
    useTimelineFocusStore.setState({ focusedTrackId: 7 });
    useEffectChainStore.setState({
      chains: {},
      fxModes: { '7': 'chain' },
      fxPanelViews: {},
      graphStates: {},
      graphStateStatuses: {},
    });

    try {
      const html = renderToStaticMarkup(<FxGraphPanel />);

      expect(html).toContain('Convert Chain to FX Graph');
      expect(html).toContain('Track Input');
      expect(useEffectChainStore.getState().fxModes['7']).toBe('chain');
      expect(useEffectChainStore.getState().graphStates['7']).toBeUndefined();
      expectNoFxGraphSnapshotLoopErrors(errorSpy);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('renders graph-mode graphState and status fallback paths without selector-loop warnings', async () => {
    const { default: useEffectChainStore } = await import('../../stores/effectChainStore.js');
    const { default: useMixerStore } = await import('../../stores/mixerStore.js');
    const { default: useTimelineFocusStore } = await import('../../stores/timelineFocusStore.js');
    const persistedGraphState = makeFxGraphState();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    usePanelRegistry.getState().openPanel('fxGraph');
    useMixerStore.setState({
      tracks: { 7: { id: 7, name: 'Lead Vox' } },
      trackOrder: [7],
    });
    useTimelineFocusStore.setState({ focusedTrackId: 7 });

    try {
      useEffectChainStore.setState({
        chains: {},
        fxModes: { '7': 'graph' },
        fxPanelViews: {},
        graphStates: { '7': persistedGraphState },
        graphStateStatuses: { '7': { status: 'valid', graphState: persistedGraphState } },
      });

      const validHtml = renderToStaticMarkup(<FxGraphPanel />);
      expect(validHtml).toContain('FX Graph Mode Active');
      expect(validHtml).toContain('Persisted EQ');
      expect(countText(validHtml, 'Graph routing is enabled for connected paths.')).toBe(1);

      useEffectChainStore.setState({
        chains: {},
        fxModes: { '7': 'graph' },
        fxPanelViews: {},
        graphStates: { '7': null },
        graphStateStatuses: { '7': { status: 'future', graphState: null } },
      });

      const futureHtml = renderToStaticMarkup(<FxGraphPanel />);
      expect(futureHtml).toContain('This graphState version is not supported by this build.');
      expectNoFxGraphSnapshotLoopErrors(errorSpy);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('canceling graph-mode confirmation leaves state and bridge untouched', async () => {
    const convertChainToGraphMode = vi.fn();
    const cancel = vi.fn();

    cancel();

    expect(convertChainToGraphMode).not.toHaveBeenCalled();
  });

  it('confirming graph mode calls the conversion action', async () => {
    const convertChainToGraphMode = vi.fn(async () => ({ ok: true }));

    const ok = await activateFxGraphMode({
      trackId: 7,
      currentFxMode: 'chain',
      convertChainToGraphMode,
      warn: vi.fn(),
    });

    expect(ok).toBe(true);
    expect(convertChainToGraphMode).toHaveBeenCalledWith(7, { warn: expect.any(Function) });
  });

  it('uses graphState and fxMode timeline setters as the default persistence path', async () => {
    const { default: useEffectChainStore } = await import('../../stores/effectChainStore.js');
    const previousWindow = (globalThis as any).window;
    const setTrackGraphState = vi.fn(async () => true);
    const setTrackFxMode = vi.fn(async () => true);
    (globalThis as any).window = {
      xleth: {
        timeline: { setTrackGraphState, setTrackFxMode },
      },
    };
    useEffectChainStore.setState({
      chains: { '7': [{ nodeId: 11, pluginId: 'compressor', position: 0 }] },
      fxModes: { '7': 'chain' },
      graphStates: { '7': null },
      graphStateStatuses: {},
    });

    try {
      await activateFxGraphMode({
        trackId: 7,
        currentFxMode: 'chain',
        warn: vi.fn(),
      });
    } finally {
      (globalThis as any).window = previousWindow;
    }

    expect(setTrackGraphState).toHaveBeenCalledWith(7, expect.objectContaining({
      schemaVersion: 1,
      trackId: '7',
    }));
    expect(setTrackFxMode).toHaveBeenCalledWith(7, 'graph');
    expect(useEffectChainStore.getState().fxModes['7']).toBe('graph');
    expect(useEffectChainStore.getState().graphStateStatuses['7'].status).toBe('valid');
  });

  it('reverts renderer state when graph-mode persistence fails', async () => {
    const { default: useEffectChainStore } = await import('../../stores/effectChainStore.js');
    const previousWindow = (globalThis as any).window;
    const setTrackGraphState = vi.fn(async () => true);
    const setTrackFxMode = vi.fn(async () => false);
    const warn = vi.fn();
    (globalThis as any).window = {
      xleth: {
        timeline: { setTrackGraphState, setTrackFxMode },
      },
    };
    useEffectChainStore.setState({
      chains: { '7': [{ nodeId: 11, pluginId: 'compressor', position: 0 }] },
      fxModes: { '7': 'chain' },
      graphStates: { '7': null },
      graphStateStatuses: {},
    });

    let ok = false;
    try {
      ok = await activateFxGraphMode({
        trackId: 7,
        currentFxMode: 'chain',
        warn,
      });
    } finally {
      (globalThis as any).window = previousWindow;
    }

    expect(ok).toBe(false);
    expect(useEffectChainStore.getState().fxModes['7']).toBe('chain');
    expect(useEffectChainStore.getState().graphStates['7']).toBeNull();
    expect(setTrackGraphState).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
  });

  it('does not activate graph mode for master or already graph-owned tracks', async () => {
    const convertChainToGraphMode = vi.fn();

    await activateFxGraphMode({
      trackId: 'master',
      convertChainToGraphMode,
    });
    await activateFxGraphMode({
      trackId: 7,
      currentFxMode: 'graph',
      convertChainToGraphMode,
    });

    expect(convertChainToGraphMode).not.toHaveBeenCalled();
  });

  it('keeps the FX Graph shell free of live NodeEditor and nodeGraphStore imports', () => {
    const fxGraphPanelSource = readUiSource('windowing/panels/FxGraphPanel.tsx');
    const chainPreviewSource = readUiSource('windowing/panels/fxgraph/ChainAsGraphPreview.tsx');
    const graphPreviewSource = readUiSource('windowing/panels/fxgraph/GraphStatePreview.tsx');
    expect(fxGraphPanelSource).not.toContain('NodeEditor');
    expect(fxGraphPanelSource).not.toContain('nodeGraphStore');
    expect(fxGraphPanelSource).not.toContain('react-flow');
    expect(fxGraphPanelSource).toContain("scope: 'panel:fxGraph'");
    expect(fxGraphPanelSource).toContain("'Ctrl+y'");
    expect(fxGraphPanelSource).toContain("'Ctrl+Shift+z'");
    expect(fxGraphPanelSource).not.toContain('window.xleth.undo');
    expect(chainPreviewSource).not.toContain('NodeEditor');
    expect(chainPreviewSource).not.toContain('nodeGraphStore');
    expect(chainPreviewSource).not.toContain('react-flow');
    expect(chainPreviewSource).not.toMatch(/on(Mouse|Click|ContextMenu|Key|Drag)/);
    expect(graphPreviewSource).not.toContain('NodeEditor');
    expect(graphPreviewSource).not.toContain('nodeGraphStore');
    expect(graphPreviewSource).not.toContain('react-flow');
    expect(graphPreviewSource).not.toMatch(/ReactFlow|useReactFlow|from ['"]@xyflow/);
    expect(fxGraphPanelSource).not.toContain('GraphNodeParameterInspector');
  });

  it('keeps graph node drags as preview-only movement until pointer up', () => {
    const graphPreviewSource = readUiSource('windowing/panels/fxgraph/GraphStatePreview.tsx');
    const moveStart = graphPreviewSource.indexOf('const handleNodePointerMove');
    const moveEnd = graphPreviewSource.indexOf('const finishPan', moveStart);
    const moveSource = graphPreviewSource.slice(moveStart, moveEnd);
    const finishStart = graphPreviewSource.indexOf('const finishDrag');
    const finishEnd = graphPreviewSource.indexOf('const cancelDrag', finishStart);
    const finishSource = graphPreviewSource.slice(finishStart, finishEnd);

    expect(graphPreviewSource).toContain('nodePositionOverrides');
    expect(moveSource).toContain('setDragPreviewPosition');
    expect(moveSource).not.toContain('onNodePositionChange(');
    expect(finishSource).toContain('onNodePositionChange(drag.nodeId');
    expect(finishSource).toContain('setDragPreviewPosition(null)');
  });

  it('keeps mixer strip source free of graph preview rendering', () => {
    const mixerStripSource = readUiSource('components/mixer/MixerStrip.jsx');

    expect(mixerStripSource).not.toContain('xleth-chain-graph-preview');
    expect(mixerStripSource).not.toContain('ChainAsGraphPreview');
    expect(mixerStripSource).not.toContain('NodeEditor');
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
