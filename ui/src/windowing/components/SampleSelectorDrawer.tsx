import React from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { ChevronLeft, GripVertical, PanelLeft } from 'lucide-react';
import LeftPanel from '../../components/LeftPanel.jsx';
import { PanelVisibilityProvider } from '../contexts/PanelVisibilityContext';
import { useXlethRootContext } from '../contexts/XlethRootContext.jsx';
import { usePanelRegistry, type PanelRegistryState } from '../registry/PanelRegistry';
import { panelTypeColorVar } from '../registry/panelCatalog';
import './windowing.css';

type SampleSelectorRegistryActions = Pick<
  PanelRegistryState,
  'focusPanel' | 'setSampleSelectorDockOpen'
>;

export function openSampleSelectorDrawer(
  registry: Pick<PanelRegistryState, 'setSampleSelectorDockOpen'> = usePanelRegistry.getState(),
): void {
  registry.setSampleSelectorDockOpen(true);
}

export function collapseSampleSelectorDrawer(
  registry: Pick<PanelRegistryState, 'setSampleSelectorDockOpen'> = usePanelRegistry.getState(),
): void {
  registry.setSampleSelectorDockOpen(false);
}

function stopControlMouseDown(event: MouseEvent<HTMLButtonElement>) {
  event.stopPropagation();
}

export function SampleSelectorDrawer() {
  const reactiveHidden = usePanelRegistry((state) => state.panels.sampleSelector.hidden);
  const reactiveDrawerSize = usePanelRegistry((state) => state.sampleSelectorDockWidth);
  const hidden = typeof window === 'undefined'
    ? usePanelRegistry.getState().panels.sampleSelector.hidden
    : reactiveHidden;
  const drawerSize = typeof window === 'undefined'
    ? usePanelRegistry.getState().sampleSelectorDockWidth
    : reactiveDrawerSize;
  const {
    onOpenPicker,
    activeSampleId,
    setActiveSampleId,
  } = useXlethRootContext();

  const registry: SampleSelectorRegistryActions = usePanelRegistry.getState();
  const expanded = !hidden;
  const drawerStyle = {
    '--xleth-windowing-panel-color': panelTypeColorVar('sampleSelector'),
    '--xleth-sample-selector-drawer-width': `${drawerSize}px`,
  } as CSSProperties;

  return (
    <PanelVisibilityProvider isVisible={expanded}>
      <div
        className="xleth-sample-selector-drawer-host"
        data-drawer-state={expanded ? 'expanded' : 'collapsed'}
        style={drawerStyle}
      >
        {!expanded ? (
          <button
            type="button"
            className="xleth-sample-selector-drawer__handle"
            aria-label="Open Sample Selector drawer"
            title="Open Sample Selector"
            onClick={() => openSampleSelectorDrawer(registry)}
          >
            <GripVertical className="xleth-sample-selector-drawer__handle-grip" aria-hidden="true" />
            <PanelLeft className="xleth-sample-selector-drawer__handle-icon" aria-hidden="true" />
          </button>
        ) : (
          <aside
            className="xleth-sample-selector-drawer"
            aria-label="Sample Selector drawer"
            onMouseDown={() => registry.focusPanel('sampleSelector')}
          >
            <header className="xleth-sample-selector-drawer__chrome">
              <span className="xleth-sample-selector-drawer__accent" aria-hidden="true" />
              <PanelLeft className="xleth-sample-selector-drawer__icon" aria-hidden="true" />
              <h2 className="xleth-sample-selector-drawer__title">Sample Selector</h2>
              <button
                type="button"
                className="xleth-windowing-control-button xleth-sample-selector-drawer__collapse"
                aria-label="Collapse Sample Selector drawer"
                title="Collapse Sample Selector"
                onMouseDown={stopControlMouseDown}
                onClick={() => collapseSampleSelectorDrawer(registry)}
              >
                <ChevronLeft aria-hidden="true" strokeWidth={2} />
              </button>
            </header>
            <div className="xleth-sample-selector-drawer__body">
              <LeftPanel
                onOpenPicker={onOpenPicker}
                activeSampleId={activeSampleId}
                setActiveSampleId={setActiveSampleId}
              />
            </div>
          </aside>
        )}
      </div>
    </PanelVisibilityProvider>
  );
}

export default SampleSelectorDrawer;
