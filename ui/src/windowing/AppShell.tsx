import React from 'react';
import { useEffect } from 'react';
import { PanelFrame } from './components/PanelFrame';
import { usePanelRegistry } from './registry/PanelRegistry';
import type { PanelId } from './registry/panelCatalog';
import './components/windowing.css';

type DevShellMode = 'single' | 'focus-demo';

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

export function AppShell({ mode = 'single' }: WindowingAppShellProps) {
  useEffect(() => {
    configurePanel('timeline', 96, 72, 560, 320);

    if (mode === 'focus-demo') {
      configurePanel('mixer', 704, 136, 460, 280);
      usePanelRegistry.getState().focusPanel('timeline');
    } else {
      usePanelRegistry.getState().closePanel('mixer');
    }
  }, [mode]);

  return (
    <div className="xleth-windowing-shell" data-testid="xleth-windowing-shell">
      <div className="xleth-floating-work-area">
        <PanelFrame id="timeline">
          <TestPanelBody label="Timeline Test Panel" />
        </PanelFrame>
        {mode === 'focus-demo' ? (
          <PanelFrame id="mixer">
            <TestPanelBody label="Mixer Test Panel" />
          </PanelFrame>
        ) : null}
      </div>
    </div>
  );
}

export function WindowingFocusDemoShell() {
  return <AppShell mode="focus-demo" />;
}

export default AppShell;
