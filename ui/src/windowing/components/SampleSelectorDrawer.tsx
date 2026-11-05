import React, { useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
} from 'lucide-react';
import LeftPanel from '../../components/LeftPanel.jsx';
import { PanelVisibilityProvider } from '../contexts/PanelVisibilityContext';
import { useXlethRootContext } from '../contexts/XlethRootContext.jsx';
import { DockRegionResizer } from './DockRegionResizer';
import {
  isEdgeRegion,
  usePanelRegistry,
  type DockRegion as DockRegionSide,
  type PanelRegistryState,
} from '../registry/PanelRegistry';
import { panelTypeColorVar } from '../registry/panelCatalog';
import './windowing.css';

const SAMPLE_SELECTOR_DRAWER_TWEEN_MS = 180;

type SampleSelectorRegistryActions = Pick<
  PanelRegistryState,
  'focusPanel' | 'setSampleSelectorDockOpen'
>;

const DOCK_SIDE_OPTIONS: ReadonlyArray<{ side: DockRegionSide; label: string; Icon: typeof PanelLeft }> = [
  { side: 'left', label: 'Dock Left', Icon: PanelLeft },
  { side: 'right', label: 'Dock Right', Icon: PanelRight },
  { side: 'top', label: 'Dock Top', Icon: PanelTop },
  { side: 'bottom', label: 'Dock Bottom', Icon: PanelBottom },
];

function collapseIconForSide(side: DockRegionSide): typeof ChevronLeft {
  if (side === 'right') return ChevronRight;
  if (side === 'top') return ChevronUp;
  if (side === 'bottom') return ChevronDown;
  return ChevronLeft;
}

function expandIconForSide(side: DockRegionSide): typeof ChevronLeft {
  if (side === 'right') return ChevronLeft;
  if (side === 'top') return ChevronDown;
  if (side === 'bottom') return ChevronUp;
  return ChevronRight;
}

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
  const reactiveSide = usePanelRegistry((state) => state.panels.sampleSelector.docked.region);
  const hidden = typeof window === 'undefined'
    ? usePanelRegistry.getState().panels.sampleSelector.hidden
    : reactiveHidden;
  const storedSide = typeof window === 'undefined'
    ? usePanelRegistry.getState().panels.sampleSelector.docked.region
    : reactiveSide;
  // The merge layer already keeps a drawer on an edge; this only narrows the type.
  const side: DockRegionSide = isEdgeRegion(storedSide) ? storedSide : 'left';
  const reactiveDrawerSize = usePanelRegistry((state) => state.dockRegionSizes[side]);
  const drawerSize = typeof window === 'undefined'
    ? usePanelRegistry.getState().dockRegionSizes[side]
    : reactiveDrawerSize;
  const {
    onOpenPicker,
    activeSampleId,
    setActiveSampleId,
  } = useXlethRootContext();

  const registry: SampleSelectorRegistryActions = usePanelRegistry.getState();
  const expanded = !hidden;
  const CollapseIcon = collapseIconForSide(side);
  const ExpandIcon = expandIconForSide(side);
  const orientation = side === 'top' || side === 'bottom' ? 'horizontal' : 'vertical';
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

  return (
    <PanelVisibilityProvider isVisible={expanded}>
      <div
        className="xleth-sample-selector-drawer-host"
        data-drawer-state={drawerState}
        data-drawer-side={side}
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
            <ExpandIcon aria-hidden="true" strokeWidth={2} />
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
              <CollapseIcon aria-hidden="true" strokeWidth={2} />
            </button>
            <div className="xleth-sample-selector-drawer__dock-picker" role="group" aria-label="Dock position">
              {DOCK_SIDE_OPTIONS.map(({ side: optionSide, label, Icon }) => (
                <button
                  key={optionSide}
                  type="button"
                  className={`xleth-sample-selector-drawer__dock-picker-btn${optionSide === side ? ' active' : ''}`}
                  aria-label={label}
                  aria-pressed={optionSide === side}
                  title={label}
                  onMouseDown={stopControlMouseDown}
                  onClick={() => usePanelRegistry.getState().dockPanel('sampleSelector', optionSide)}
                >
                  <Icon aria-hidden="true" strokeWidth={2} size={13} />
                </button>
              ))}
            </div>
            <div className="xleth-sample-selector-drawer__body">
              <LeftPanel
                onOpenPicker={onOpenPicker}
                activeSampleId={activeSampleId}
                setActiveSampleId={setActiveSampleId}
                orientation={orientation}
              />
            </div>
            <DockRegionResizer region={side} currentSize={drawerSize} />
          </aside>
        )}
      </div>
    </PanelVisibilityProvider>
  );
}

export default SampleSelectorDrawer;
