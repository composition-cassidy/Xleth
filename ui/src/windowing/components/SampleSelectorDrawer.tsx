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
import useBrowserStore from '../../stores/browserStore.js';
import { MediaIcon, SamplerIcon } from '../../ui-kit';
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
import styles from './SampleSelectorDrawer.module.css';

const SAMPLE_SELECTOR_DRAWER_TWEEN_MS = 180;

type SampleSelectorRegistryActions = Pick<
  PanelRegistryState,
  'focusPanel' | 'setSampleSelectorDockOpen'
>;

const DOCK_SIDE_OPTIONS: ReadonlyArray<{ side: DockRegionSide; label: string; Icon: typeof PanelLeft }> = [
  { side: 'left', label: 'Left', Icon: PanelLeft },
  { side: 'right', label: 'Right', Icon: PanelRight },
  { side: 'top', label: 'Top', Icon: PanelTop },
  { side: 'bottom', label: 'Bottom', Icon: PanelBottom },
];

// The collapsed rail's shortcuts: one per Browser tab, same glyphs as the tabs.
const RAIL_TABS = [
  { id: 'media', label: 'Project media', Icon: MediaIcon },
  { id: 'samples', label: 'Samples', Icon: SamplerIcon },
] as const;

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
  const dockIndex = Math.max(0, DOCK_SIDE_OPTIONS.findIndex((option) => option.side === side));
  const currentDock = DOCK_SIDE_OPTIONS[dockIndex];
  const nextDock = DOCK_SIDE_OPTIONS[(dockIndex + 1) % DOCK_SIDE_OPTIONS.length];
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
          <div
            className={styles.rail}
            data-side={side}
            role="toolbar"
            aria-label="Browser, collapsed"
            aria-orientation={orientation === 'horizontal' ? 'horizontal' : 'vertical'}
          >
            <button
              type="button"
              className={`xleth-sample-selector-drawer__edge-toggle xleth-sample-selector-drawer__edge-toggle--collapsed ${styles.control}`}
              aria-label="Open Sample Selector drawer"
              data-hint="Open the Browser"
              data-hint-mods="F6"
              onMouseDown={stopControlMouseDown}
              onClick={() => openSampleSelectorDrawer(registry)}
            >
              <ExpandIcon aria-hidden="true" size={14} />
            </button>
            <span className={styles.railDivider} aria-hidden="true" />
            {RAIL_TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                className={styles.control}
                aria-label={`Open ${label}`}
                data-hint={`Open the Browser on ${label}`}
                onMouseDown={stopControlMouseDown}
                onClick={() => {
                  useBrowserStore.getState().setTab(id);
                  openSampleSelectorDrawer(registry);
                }}
              >
                <Icon size={16} />
              </button>
            ))}
          </div>
        ) : (
          <aside
            className="xleth-sample-selector-drawer"
            aria-label="Sample Selector drawer"
            aria-hidden={drawerState === 'collapsing' ? true : undefined}
            onMouseDown={() => registry.focusPanel('sampleSelector')}
          >
            <div className="xleth-sample-selector-drawer__body">
              <LeftPanel
                onOpenPicker={onOpenPicker}
                activeSampleId={activeSampleId}
                setActiveSampleId={setActiveSampleId}
                orientation={orientation}
                actions={(
                <div className={styles.controls}>
                  <button
                    type="button"
                    className={styles.control}
                    aria-label={`Dock position: ${currentDock.label}. Move to ${nextDock.label}`}
                    data-hint={`Dock position: ${currentDock.label}. Click to move the Browser to the ${nextDock.label.toLowerCase()}.`}
                    onMouseDown={stopControlMouseDown}
                    onClick={() => usePanelRegistry.getState().dockPanel('sampleSelector', nextDock.side)}
                  >
                    <currentDock.Icon aria-hidden="true" size={14} />
                  </button>
                  <button
                    type="button"
                    className={`xleth-sample-selector-drawer__edge-toggle xleth-sample-selector-drawer__edge-toggle--expanded ${styles.control}`}
                    aria-label="Collapse Sample Selector drawer"
                    data-hint="Collapse the Browser to its rail"
                    data-hint-mods="F6"
                    onMouseDown={stopControlMouseDown}
                    onClick={() => collapseSampleSelectorDrawer(registry)}
                  >
                    <CollapseIcon aria-hidden="true" size={14} />
                  </button>
                </div>
                )}
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
