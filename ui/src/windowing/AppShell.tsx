import React from 'react';
import { useEffect, useRef } from 'react';
import { DockRegion } from './components/DockRegion';
import { PanelFrame } from './components/PanelFrame';
import { SnapGhost } from './components/SnapGhost';
import { TopBarToggles } from './components/TopBarToggles';
import { registerWorkAreaRect } from './managers/DragManager';
import * as KeyboardManager from './managers/KeyboardManager';
import { usePanelRegistry } from './registry/PanelRegistry';
import { PANEL_CATALOG, type PanelId } from './registry/panelCatalog';
import './components/windowing.css';

const TimelinePanel = React.lazy(() => import('./panels/TimelinePanel'));
const MixerPanel = React.lazy(() => import('./panels/MixerPanel'));
const PianoRollPanel = React.lazy(() => import('./panels/PianoRollPanel'));
const SampleSelectorPanel = React.lazy(() => import('./panels/SampleSelectorPanel'));
const PreviewPanel = React.lazy(() => import('./panels/PreviewPanel'));
const GridSettingsPanel = React.lazy(() => import('./panels/GridSettingsPanel'));
const NodeEditorPanel = React.lazy(() => import('./panels/NodeEditorPanel'));

type DevShellMode =
  | 'single'
  | 'focus-demo'
  | 'phase-2-demo'
  | 'phase-3-demo'
  | 'phase-4-demo'
  | 'phase-5-demo'
  | 'phase-6b-demo';

export type AppShellMode = DevShellMode | 'production';

export interface WindowingAppShellProps {
  mode?: AppShellMode;
}

export function shouldRenderRealPanels(mode: AppShellMode): boolean {
  return mode === 'phase-6b-demo' || mode === 'production';
}

function TestPanelBody({ label }: { label: string }) {
  return (
    <div className="xleth-windowing-test-panel">
      <div className="xleth-windowing-test-panel__header">{label}</div>
      <div className="xleth-windowing-test-panel__body">Windowing Wave 1 Phase 1</div>
    </div>
  );
}

function configurePanel(id: PanelId, x: number, y: number, width: number, height: number) {
  const registry = usePanelRegistry.getState();
  registry.openPanel(id);
  registry.resizeFloatingPanel(id, x, y, width, height);
}

export function configurePhase2DemoPanels() {
  configurePanel('timeline', 96, 72, 620, 340);
  configurePanel('mixer', 420, 176, 540, 300);
  configurePanel('pianoRoll', 256, 256, 680, 360);
  usePanelRegistry.getState().focusPanel('timeline');
}

export function configurePhase3DemoPanels() {
  const registry = usePanelRegistry.getState();
  configurePanel('timeline', 96, 72, 620, 340);
  configurePanel('pianoRoll', 256, 256, 680, 360);
  registry.openPanel('sampleSelector');
  registry.dockPanel('sampleSelector', 'left');
  registry.openPanel('mixer');
  registry.dockPanel('mixer', 'bottom');
  registry.focusPanel('timeline');
}

export function configurePhase5DemoPanels() {
  usePanelRegistry.getState().applyPreset('fl-compose');
}

export function configurePhase6bDemoPanels() {
  // Same layout as phase-5-demo for parity, but rendered through
  // the new wrappers.
  usePanelRegistry.getState().applyPreset('fl-compose');
}

export function applyDemoShellMode(mode: AppShellMode): void {
  if (mode === 'production') return;

  configurePanel('timeline', 96, 72, 560, 320);

  if (mode === 'phase-3-demo') {
    configurePhase3DemoPanels();
  } else if (mode === 'phase-2-demo') {
    configurePhase2DemoPanels();
  } else if (mode === 'focus-demo') {
    configurePanel('mixer', 704, 136, 460, 280);
    usePanelRegistry.getState().focusPanel('timeline');
  } else if (mode === 'phase-5-demo') {
    configurePhase5DemoPanels();
  } else if (mode === 'phase-6b-demo') {
    configurePhase6bDemoPanels();
  } else {
    usePanelRegistry.getState().closePanel('mixer');
    usePanelRegistry.getState().closePanel('pianoRoll');
  }
}

const PANEL_BODY_FOR_6B: Record<PanelId, React.LazyExoticComponent<React.FC>> = {
  timeline: TimelinePanel,
  mixer: MixerPanel,
  pianoRoll: PianoRollPanel,
  sampleSelector: SampleSelectorPanel,
  preview: PreviewPanel,
  gridSettings: GridSettingsPanel,
  nodeEditor: NodeEditorPanel,
};

const SHELL_PANEL_IDS: Record<AppShellMode, PanelId[]> = {
  single: ['timeline'],
  'focus-demo': ['timeline', 'mixer'],
  'phase-2-demo': ['timeline', 'mixer', 'pianoRoll'],
  'phase-3-demo': ['timeline', 'mixer', 'pianoRoll', 'sampleSelector'],
  'phase-4-demo': ['timeline', 'mixer', 'pianoRoll', 'sampleSelector'],
  'phase-5-demo': [
    'timeline',
    'mixer',
    'pianoRoll',
    'sampleSelector',
    'preview',
    'gridSettings',
    'nodeEditor',
  ],
  'phase-6b-demo': [
    'timeline',
    'mixer',
    'pianoRoll',
    'sampleSelector',
    'preview',
    'gridSettings',
    'nodeEditor',
  ],
  production: [
    'timeline',
    'mixer',
    'pianoRoll',
    'sampleSelector',
    'preview',
    'gridSettings',
    'nodeEditor',
  ],
};

export function AppShell({ mode = 'single' }: WindowingAppShellProps) {
  const workAreaRef = useRef<HTMLDivElement>(null);
  const reactivePanels = usePanelRegistry((state) => state.panels);
  const panels = typeof window === 'undefined'
    ? usePanelRegistry.getState().panels
    : reactivePanels;
  const rendersRealPanels = shouldRenderRealPanels(mode);

  useEffect(() => {
    KeyboardManager.init();
    return KeyboardManager.destroy;
  }, []);

  useEffect(() => {
    applyDemoShellMode(mode);
  }, [mode]);

  useEffect(() => {
    if (workAreaRef.current) {
      registerWorkAreaRect(workAreaRef.current.getBoundingClientRect());
    }
  });

  const renderPhase6bPanel = (panelId: PanelId) => {
    const PanelBody = PANEL_BODY_FOR_6B[panelId];
    return (
      <React.Suspense key={panelId} fallback={null}>
        <PanelBody />
      </React.Suspense>
    );
  };

  return (
    <div className="xleth-windowing-app">
      <TopBarToggles />
      <div className="xleth-windowing-shell" data-testid="xleth-windowing-shell">
        <DockRegion side="left" renderPanel={rendersRealPanels ? renderPhase6bPanel : undefined} />
        <div className="xleth-center-column">
          <DockRegion side="top" renderPanel={rendersRealPanels ? renderPhase6bPanel : undefined} />
          <div className="xleth-floating-work-area" ref={workAreaRef}>
            <SnapGhost />
            {SHELL_PANEL_IDS[mode]
              .filter((panelId) => (
                rendersRealPanels
                  ? panels[panelId].mode !== 'docked' || panels[panelId].hidden
                  : panels[panelId].mode !== 'docked'
              ))
              .map((panelId) => {
                if (rendersRealPanels) return renderPhase6bPanel(panelId);
                return (
                  <PanelFrame key={panelId} id={panelId}>
                    <TestPanelBody label={`${PANEL_CATALOG[panelId].title} Test Panel`} />
                  </PanelFrame>
                );
              })}
          </div>
          <DockRegion side="bottom" renderPanel={rendersRealPanels ? renderPhase6bPanel : undefined} />
        </div>
        <DockRegion side="right" renderPanel={rendersRealPanels ? renderPhase6bPanel : undefined} />
      </div>
    </div>
  );
}

export function WindowingFocusDemoShell() {
  return <AppShell mode="focus-demo" />;
}

export function WindowingPhase2DemoShell() {
  return <AppShell mode="phase-2-demo" />;
}

export function WindowingPhase3DemoShell() {
  return <AppShell mode="phase-3-demo" />;
}

export function WindowingPhase4DemoShell() {
  return <AppShell mode="phase-4-demo" />;
}

export function WindowingPhase5DemoShell() {
  return <AppShell mode="phase-5-demo" />;
}

export function WindowingPhase6bDemoShell() {
  return <AppShell mode="phase-6b-demo" />;
}

export default AppShell;
