import React, { useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import LeftPanel from '../../components/LeftPanel.jsx';
import { PanelVisibilityProvider } from '../contexts/PanelVisibilityContext';
import { useXlethRootContext } from '../contexts/XlethRootContext.jsx';
import { beginDockRegionResize } from '../managers/DockRegionResizeManager';
import { usePanelRegistry, type PanelRegistryState } from '../registry/PanelRegistry';
import { panelTypeColorVar } from '../registry/panelCatalog';
import './windowing.css';

const SAMPLE_SELECTOR_DRAWER_TWEEN_MS = 180;

type SampleSelectorRegistryActions = Pick<
  PanelRegistryState,
  'focusPanel' | 'setSampleSelectorDockOpen'
>;

type SampleSelectorDrawerPhase = 'expanded' | 'collapsing' | 'collapsed';

function prefersReducedDrawerMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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
  const reactiveDrawerSize = usePanelRegistry((state) => state.dockRegionSizes.left);
  const hidden = typeof window === 'undefined'
    ? usePanelRegistry.getState().panels.sampleSelector.hidden
    : reactiveHidden;
  const drawerSize = typeof window === 'undefined'
    ? usePanelRegistry.getState().dockRegionSizes.left
    : reactiveDrawerSize;
  const {
    onOpenPicker,
    activeSampleId,
    setActiveSampleId,
  } = useXlethRootContext();

  const registry: SampleSelectorRegistryActions = usePanelRegistry.getState();
  const expanded = !hidden;
  const reduceDrawerMotion = prefersReducedDrawerMotion();
  const [renderPhase, setRenderPhase] = useState<SampleSelectorDrawerPhase>(
    () => (expanded ? 'expanded' : 'collapsed'),
  );
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (collapseTimerRef.current !== null) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }

    if (expanded) {
      setRenderPhase('expanded');
      return undefined;
    }

    if (renderPhase === 'collapsed') {
      return undefined;
    }

    if (reduceDrawerMotion) {
      setRenderPhase('collapsed');
      return undefined;
    }

    setRenderPhase('collapsing');
    collapseTimerRef.current = setTimeout(() => {
      setRenderPhase('collapsed');
      collapseTimerRef.current = null;
    }, SAMPLE_SELECTOR_DRAWER_TWEEN_MS);

    return () => {
      if (collapseTimerRef.current !== null) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
    };
  }, [expanded, reduceDrawerMotion]);

  const drawerState: SampleSelectorDrawerPhase = expanded
    ? 'expanded'
    : reduceDrawerMotion || renderPhase === 'collapsed'
      ? 'collapsed'
      : 'collapsing';
  const shouldRenderDrawer = expanded || (!reduceDrawerMotion && renderPhase !== 'collapsed');
  const drawerStyle = {
    '--xleth-windowing-panel-color': panelTypeColorVar('sampleSelector'),
  } as CSSProperties;

  const handleResizeMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    beginDockRegionResize('left', 'horizontal', event.clientX, event.clientY, drawerSize);
  };

  return (
    <PanelVisibilityProvider isVisible={expanded}>
      <div
        className="xleth-sample-selector-drawer-host"
        data-drawer-state={drawerState}
        style={drawerStyle}
      >
        {!shouldRenderDrawer ? (
          <button
            type="button"
            className="xleth-sample-selector-drawer__edge-toggle xleth-sample-selector-drawer__edge-toggle--collapsed"
            aria-label="Open Sample Selector drawer"
            title="Open Sample Selector"
            onMouseDown={stopControlMouseDown}
            onClick={() => openSampleSelectorDrawer(registry)}
          >
            <ChevronRight aria-hidden="true" strokeWidth={2} />
          </button>
        ) : (
          <aside
            className="xleth-sample-selector-drawer"
            aria-label="Sample Selector drawer"
            aria-hidden={drawerState === 'collapsing' ? true : undefined}
            onMouseDown={() => registry.focusPanel('sampleSelector')}
          >
            <button
              type="button"
              className="xleth-sample-selector-drawer__edge-toggle xleth-sample-selector-drawer__edge-toggle--expanded"
              aria-label="Collapse Sample Selector drawer"
              title="Collapse Sample Selector"
              onMouseDown={stopControlMouseDown}
              onClick={() => collapseSampleSelectorDrawer(registry)}
            >
              <ChevronLeft aria-hidden="true" strokeWidth={2} />
            </button>
            <div className="xleth-sample-selector-drawer__body">
              <LeftPanel
                onOpenPicker={onOpenPicker}
                activeSampleId={activeSampleId}
                setActiveSampleId={setActiveSampleId}
              />
            </div>
            <div
              className="xleth-sample-selector-drawer__resize-handle"
              data-testid="xleth-sample-selector-drawer-resize-handle"
              onMouseDown={handleResizeMouseDown}
              aria-hidden="true"
            />
          </aside>
        )}
      </div>
    </PanelVisibilityProvider>
  );
}

export default SampleSelectorDrawer;
