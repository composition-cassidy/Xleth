import React from 'react';
import { useEffect } from 'react';
import { PanelFrame } from './components/PanelFrame';
import { useEscRestoreMaximized } from './hooks/useEscRestoreMaximized';
import { usePanelRegistry } from './registry/PanelRegistry';
import { PANEL_CATALOG, type PanelId } from './registry/panelCatalog';
import './components/windowing.css';

type DevShellMode = 'single' | 'focus-demo' | 'phase-2-demo';

export interface WindowingAppShellProps {
  mode?: DevShellMode;
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

const SHELL_PANEL_IDS: Record<DevShellMode, PanelId[]> = {
  single: ['timeline'],
  'focus-demo': ['timeline', 'mixer'],
  'phase-2-demo': ['timeline', 'mixer', 'pianoRoll'],
};

export function AppShell({ mode = 'single' }: WindowingAppShellProps) {
  useEscRestoreMaximized();

  useEffect(() => {
    configurePanel('timeline', 96, 72, 560, 320);

    if (mode === 'phase-2-demo') {
      configurePhase2DemoPanels();
    } else if (mode === 'focus-demo') {
      configurePanel('mixer', 704, 136, 460, 280);
      usePanelRegistry.getState().focusPanel('timeline');
    } else {
      usePanelRegistry.getState().closePanel('mixer');
      usePanelRegistry.getState().closePanel('pianoRoll');
    }
  }, [mode]);

  return (
    <div className="xleth-windowing-shell" data-testid="xleth-windowing-shell">
      <div className="xleth-floating-work-area">
        {SHELL_PANEL_IDS[mode].map((panelId) => (
          <PanelFrame key={panelId} id={panelId}>
            <TestPanelBody label={`${PANEL_CATALOG[panelId].title} Test Panel`} />
          </PanelFrame>
        ))}
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

export default AppShell;
