import React from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import {
  beginDockedPanelResize,
  useDockedPanelResizePreview,
  type DockedPanelResizeAxis,
} from '../managers/DockedPanelResizeManager';
import { getRegisteredWorkAreaRect } from '../managers/DragManager';
import { useDockRegionResizePreview } from '../managers/DockRegionResizeManager';
import { DockSlotProvider } from '../contexts/DockSlotContext';
import { PANEL_CATALOG, WINDOW_PANEL_IDS, type PanelId } from '../registry/panelCatalog';
import {
  getRegionSlots,
  usePanelRegistry,
  type DockRegion as DockRegionSide,
  type PanelStateMap,
} from '../registry/PanelRegistry';
import { DockRegionResizer } from './DockRegionResizer';
import { PanelFrame } from './PanelFrame';

export interface DockRegionProps {
  side: DockRegionSide;
  renderPanel?: (id: PanelId) => ReactNode;
  excludePanelIds?: readonly PanelId[];
}

const EMPTY_PANEL_IDS: readonly PanelId[] = Object.freeze([]);
/** Keyboard step for a splitter, in px. */
const SPLITTER_KEY_STEP = 16;

function DockTestBody({ label }: { label: string }) {
  return (
    <div className="xleth-windowing-test-panel">
      <div className="xleth-windowing-test-panel__header">{label}</div>
    </div>
  );
}

/**
 * Flat string describing everything about this region that changes rendering.
 *
 * The registry clones the whole panel map on every mutation, so a selector
 * returning objects or arrays would never compare equal and React would
 * re-render the region continuously. Encoding the slot layout as one string
 * keeps the subscription primitive — see usePanelValue for the same rule.
 *
 * Shape: slots separated by "|", tabs within a slot by ",", each tab
 * "id:size:active:collapsed".
 */
export function dockedPanelKey(
  side: DockRegionSide,
  excludePanelIds: readonly PanelId[],
  panels: PanelStateMap,
): string {
  const excluded = new Set(excludePanelIds);
  // A region renders only panels the catalog says are windows. Without this the
  // quarantine gate would hold for the floating layer and leak here: docking a
  // quarantined panel (or a drawer) would mount it after all.
  const renderable = new Set(WINDOW_PANEL_IDS);
  return getRegionSlots(panels, side)
    .map((slot) => slot
      .filter((id) => renderable.has(id) && !excluded.has(id))
      .map((id) => [
        id,
        panels[id].docked.sizeInRegion,
        panels[id].docked.tabActive ? '1' : '0',
        panels[id].collapsed ? '1' : '0',
      ].join(':'))
      .join(','))
    .filter((slot) => slot !== '')
    .join('|');
}

interface DockedSlotEntry {
  ids: PanelId[];
  activeId: PanelId;
  size: number;
  collapsed: boolean;
}

export function parseDockedPanelKey(key: string): DockedSlotEntry[] {
  if (key === '') return [];
  return key.split('|').map((slotKey) => {
    const tabs = slotKey.split(',').map((entry) => {
      const [id, size, active, collapsed] = entry.split(':');
      return {
        id: id as PanelId,
        size: Number(size),
        active: active === '1',
        collapsed: collapsed === '1',
      };
    });
    const active = tabs.find((tab) => tab.active) ?? tabs[0];
    return {
      ids: tabs.map((tab) => tab.id),
      activeId: active.id,
      size: active.size,
      collapsed: active.collapsed,
    };
  });
}

function axisForRegion(side: DockRegionSide): DockedPanelResizeAxis {
  return side === 'top' || side === 'bottom' ? 'horizontal' : 'vertical';
}

function localAxisCoordinate(rect: DOMRect, regionRect: DOMRect, axis: DockedPanelResizeAxis, edge: 'start' | 'end'): number {
  if (axis === 'horizontal') {
    return (edge === 'start' ? rect.left : rect.right) - regionRect.left;
  }
  return (edge === 'start' ? rect.top : rect.bottom) - regionRect.top;
}

function collectSnapTargets(
  regionElement: HTMLElement,
  axis: DockedPanelResizeAxis,
  startSplitterPosition: number,
): number[] {
  const regionRect = regionElement.getBoundingClientRect();
  const targets: number[] = [];
  const addTarget = (value: number) => {
    if (!Number.isFinite(value)) return;
    if (Math.abs(value - startSplitterPosition) <= 1) return;
    targets.push(Math.round(value));
  };
  const addRect = (rect: DOMRect) => {
    addTarget(localAxisCoordinate(rect, regionRect, axis, 'start'));
    addTarget(localAxisCoordinate(rect, regionRect, axis, 'end'));
  };

  const workArea = getRegisteredWorkAreaRect();
  if (axis === 'horizontal') {
    addTarget(workArea.left - regionRect.left);
    addTarget(workArea.right - regionRect.left);
  } else {
    addTarget(workArea.top - regionRect.top);
    addTarget(workArea.bottom - regionRect.top);
  }

  const root = regionElement.ownerDocument;
  root.querySelectorAll<HTMLElement>('.xleth-docked-panel-slot, .xleth-floating-window-layer > .xleth-panel-frame')
    .forEach((element) => addRect(element.getBoundingClientRect()));

  return Array.from(new Set(targets));
}

interface DockedPanelSplitterProps {
  region: DockRegionSide;
  beforeId: PanelId;
  afterId: PanelId;
  beforeTitle: string;
  afterTitle: string;
  active: boolean;
}

function DockedPanelSplitter({
  region,
  beforeId,
  afterId,
  beforeTitle,
  afterTitle,
  active,
}: DockedPanelSplitterProps) {
  const axis = axisForRegion(region);
  const resizeDockedPanelPair = usePanelRegistry((state) => state.resizeDockedPanelPair);

  const measureSlots = (splitter: HTMLElement) => {
    const regionElement = splitter.closest<HTMLElement>('.xleth-dock-region');
    const beforeSlot = regionElement?.querySelector<HTMLElement>(`[data-docked-slot-id="${beforeId}"]`);
    const afterSlot = regionElement?.querySelector<HTMLElement>(`[data-docked-slot-id="${afterId}"]`);
    if (!regionElement || !beforeSlot || !afterSlot) return null;

    const regionRect = regionElement.getBoundingClientRect();
    const beforeRect = beforeSlot.getBoundingClientRect();
    const afterRect = afterSlot.getBoundingClientRect();
    // Measure the live rendered extent of each slot so the drag tracks the cursor
    // 1:1 and clamps against real geometry. The last docked slot flex-grows to
    // fill the region, so its stored sizeInRegion does not reflect its on-screen
    // size — only the measured rect does.
    return {
      regionElement,
      measuredBefore: Math.round(axis === 'horizontal' ? beforeRect.width : beforeRect.height),
      measuredAfter: Math.round(axis === 'horizontal' ? afterRect.width : afterRect.height),
      startSplitterPosition: axis === 'horizontal'
        ? beforeRect.right - regionRect.left
        : beforeRect.bottom - regionRect.top,
    };
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const measured = measureSlots(event.currentTarget);
    if (!measured) return;

    event.preventDefault();
    beginDockedPanelResize(
      event.clientX,
      event.clientY,
      {
        region,
        axis,
        beforeId,
        afterId,
        beforeSize: measured.measuredBefore,
        afterSize: measured.measuredAfter,
        startSplitterPosition: measured.startSplitterPosition,
        snapTargets: collectSnapTargets(measured.regionElement, axis, measured.startSplitterPosition),
      },
      {
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      },
      { target: event.currentTarget, pointerId: event.pointerId },
    );
  };

  // A separator that can only be dragged is unusable without a pointer, so the
  // same clamped resize is reachable from the arrow keys.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const decreaseKey = axis === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const increaseKey = axis === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    let delta = 0;
    if (event.key === decreaseKey) delta = -SPLITTER_KEY_STEP;
    else if (event.key === increaseKey) delta = SPLITTER_KEY_STEP;
    else return;

    const measured = measureSlots(event.currentTarget);
    if (!measured) return;
    event.preventDefault();
    resizeDockedPanelPair(
      region,
      beforeId,
      measured.measuredBefore + delta,
      afterId,
      measured.measuredAfter - delta,
    );
  };

  return (
    <div
      className={`xleth-dock-splitter xleth-dock-splitter--${axis}`}
      data-testid={`xleth-dock-splitter-${beforeId}-${afterId}`}
      data-before-panel-id={beforeId}
      data-after-panel-id={afterId}
      data-active={active ? 'true' : 'false'}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      role="separator"
      tabIndex={0}
      aria-orientation={axis === 'horizontal' ? 'vertical' : 'horizontal'}
      aria-label={`Resize ${beforeTitle} and ${afterTitle}`}
    />
  );
}

export function DockRegion({ side, renderPanel, excludePanelIds = EMPTY_PANEL_IDS }: DockRegionProps) {
  const reactiveDockedPanelKey = usePanelRegistry((state) => dockedPanelKey(side, excludePanelIds, state.panels));
  const reactiveSize = usePanelRegistry((state) => state.dockRegionSizes[side]);
  const isSSR = typeof window === 'undefined';
  const dockedKey = isSSR ? dockedPanelKey(side, excludePanelIds, usePanelRegistry.getState().panels) : reactiveDockedPanelKey;
  const committedSize = isSSR ? usePanelRegistry.getState().dockRegionSizes[side] : reactiveSize;
  const preview = useDockRegionResizePreview(side);
  const splitterPreview = useDockedPanelResizePreview(side);
  const effectiveSize = preview?.size ?? committedSize;
  const docked = parseDockedPanelKey(dockedKey);

  if (docked.length === 0) return null;

  const sizeStyle: CSSProperties = (side === 'left' || side === 'right')
    ? { width: `${effectiveSize}px` }
    : { height: `${effectiveSize}px` };

  return (
    <div
      className={`xleth-dock-region xleth-dock-region--${side}`}
      data-region={side}
      style={sizeStyle}
    >
      {docked.map((entry, index) => {
        const slotId = entry.ids[0];
        const liveSize = splitterPreview?.beforeId === entry.activeId
          ? splitterPreview.beforeSize
          : splitterPreview?.afterId === entry.activeId
            ? splitterPreview.afterSize
            : entry.size;
        const next = docked[index + 1];
        const isLast = next === undefined;
        // A collapsed slot is its own chrome and nothing else, so it neither
        // grows to fill the region nor offers a splitter to drag.
        const slotClassName = [
          'xleth-docked-panel-slot',
          isLast && !entry.collapsed ? 'xleth-docked-panel-slot--fill' : '',
          entry.collapsed ? 'xleth-docked-panel-slot--collapsed' : '',
        ].filter(Boolean).join(' ');
        const showSplitter = Boolean(next) && !entry.collapsed && !next!.collapsed;

        return (
          <React.Fragment key={slotId}>
            <div
              className={slotClassName}
              data-docked-slot-id={entry.activeId}
              data-slot-tab-count={entry.ids.length}
              style={{ '--xleth-docked-panel-size': `${liveSize}px` } as CSSProperties}
            >
              <DockSlotProvider region={side} tabIds={entry.ids} activeId={entry.activeId}>
                {entry.ids.map((panelId) => (
                  <React.Fragment key={panelId}>
                    {renderPanel ? (
                      renderPanel(panelId)
                    ) : (
                      <PanelFrame id={panelId}>
                        <DockTestBody label={PANEL_CATALOG[panelId].title} />
                      </PanelFrame>
                    )}
                  </React.Fragment>
                ))}
              </DockSlotProvider>
            </div>
            {showSplitter ? (
              <DockedPanelSplitter
                region={side}
                beforeId={entry.activeId}
                afterId={next!.activeId}
                beforeTitle={PANEL_CATALOG[entry.activeId].title}
                afterTitle={PANEL_CATALOG[next!.activeId].title}
                active={splitterPreview?.beforeId === entry.activeId && splitterPreview.afterId === next!.activeId}
              />
            ) : null}
          </React.Fragment>
        )
      })}
      <DockRegionResizer region={side} currentSize={committedSize} />
    </div>
  );
}

export default DockRegion;
