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
  'closePanel' | 'dockPanel' | 'focusPanel'
>;

export function openSampleSelectorDrawer(
  registry: Pick<PanelRegistryState, 'dockPanel'> = usePanelRegistry.getState(),
): void {
  registry.dockPanel('sampleSelector', 'left');
}

export function collapseSampleSelectorDrawer(
  registry: Pick<PanelRegistryState, 'closePanel'> = usePanelRegistry.getState(),
): void {
  registry.closePanel('sampleSelector');
}

function stopControlMouseDown(event: MouseEvent<HTMLButtonElement>) {
  event.stopPropagation();
}

export function SampleSelectorDrawer() {
  const reactivePanel = usePanelRegistry((state) => state.panels.sampleSelector);
  const reactiveDrawerSize = usePanelRegistry((state) => state.dockRegionSizes.left);
  const panel = typeof window === 'undefined'
    ? usePanelRegistry.getState().panels.sampleSelector
    : reactivePanel;
  const drawerSize = typeof window === 'undefined'
    ? usePanelRegistry.getState().dockRegionSizes.left
    : reactiveDrawerSize;
  const {
    onOpenPicker,
    activeSampleId,
    setActiveSampleId,
  } = useXlethRootContext();

  const registry: SampleSelectorRegistryActions = usePanelRegistry.getState();
  const expanded = !panel.hidden;
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
