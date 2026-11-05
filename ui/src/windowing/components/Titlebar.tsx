import React from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react';
import { ArrowDownToLine, ChevronDown, ChevronUp, Maximize2, Square, X } from 'lucide-react';
import { armPanelDrag, useIsTabDropTarget } from '../managers/DragManager';
import { isDetailDockTab, PANEL_CATALOG, panelTypeColorVar, type PanelId } from '../registry/panelCatalog';
import { usePanelRegistry } from '../registry/PanelRegistry';
import { usePanelValue } from '../registry/usePanelValue';
import { XlethIconButton } from '../../components/common/XlethButton.jsx';
import './windowing.css';

export interface TitlebarProps {
  id: PanelId;
  focused: boolean;
  children?: ReactNode;
}

/** Keyboard nudge per arrow press; Shift multiplies it. */
const KEYBOARD_MOVE_STEP = 8;
const KEYBOARD_MOVE_STEP_COARSE = 48;

export function isTitlebarControlTarget(target: EventTarget | null): boolean {
  return typeof HTMLElement !== 'undefined'
    && target instanceof HTMLElement
    && Boolean(target.closest('button'));
}

export function Titlebar({ id, focused, children }: TitlebarProps) {
  const entry = PANEL_CATALOG[id];
  const mode = usePanelValue(id, (p) => p.mode);
  const collapsed = usePanelValue(id, (p) => p.collapsed);
  const floatingX = usePanelValue(id, (p) => p.floating.x);
  const floatingY = usePanelValue(id, (p) => p.floating.y);
  const closePanel = usePanelRegistry((state) => state.closePanel);
  const maximizePanel = usePanelRegistry((state) => state.maximizePanel);
  const restorePanel = usePanelRegistry((state) => state.restorePanel);
  const toggleCollapsePanel = usePanelRegistry((state) => state.toggleCollapsePanel);
  const moveFloatingPanel = usePanelRegistry((state) => state.moveFloatingPanel);
  const dockPanel = usePanelRegistry((state) => state.dockPanel);
  const isDropTarget = useIsTabDropTarget(id);

  const stopControlPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const hidePanel = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    closePanel(id);
  };

  // Minimize used to call the same handler as close, which made one of the two
  // buttons a lie. It now rolls the panel up to its titlebar and leaves it in
  // the layout — the panel is still open, still where the user put it, and one
  // click away from full size.
  const toggleCollapse = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    toggleCollapsePanel(id);
  };

  const toggleMaximize = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (mode === 'maximized') restorePanel(id);
    else maximizePanel(id);
  };

  const startTitlebarDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || mode === 'maximized') return;
    event.preventDefault();
    armPanelDrag(id, event.clientX, event.clientY, floatingX, floatingY, {
      target: event.currentTarget,
      pointerId: event.pointerId,
    });
  };

  // A fixed-size panel (resizable === false) never maximizes — no control, and
  // a double-click on its titlebar does nothing.
  const canMaximize = entry.resizable !== false;

  const toggleTitlebarMaximize = (event: MouseEvent<HTMLDivElement>) => {
    if (isTitlebarControlTarget(event.target)) return;
    if (!canMaximize) return;
    if (mode === 'maximized') restorePanel(id);
    else if (mode === 'floating') maximizePanel(id);
  };

  // Keyboard equivalent of dragging the titlebar. Without it a floating panel
  // can only be moved with a pointer, which leaves keyboard-only users unable
  // to reach a panel that opened over the one they need.
  const onTitlebarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mode !== 'floating') return;
    const step = event.shiftKey ? KEYBOARD_MOVE_STEP_COARSE : KEYBOARD_MOVE_STEP;
    let dx = 0;
    let dy = 0;
    if (event.key === 'ArrowLeft') dx = -step;
    else if (event.key === 'ArrowRight') dx = step;
    else if (event.key === 'ArrowUp') dy = -step;
    else if (event.key === 'ArrowDown') dy = step;
    else return;
    event.preventDefault();
    moveFloatingPanel(id, Math.max(0, floatingX + dx), Math.max(0, floatingY + dy));
  };

  const collapseLabel = collapsed ? `Expand ${entry.title}` : `Collapse ${entry.title}`;
  // A popped-out detail-dock panel can go home in one click (dragging it to
  // the bottom edge still works too).
  const canReturnToDock = mode === 'floating' && isDetailDockTab(id);
  const returnLabel = `Return ${entry.title} to the dock`;
  const returnToDock = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    console.log(`[Shell] re-dock ${id} from its window`);
    dockPanel(id, 'bottom');
  };

  return (
    <div
      className="xleth-windowing-titlebar"
      data-panel-id={id}
      data-focused={focused}
      // Marks the drop zone DragManager hit-tests when a dragged panel is over
      // an already-docked one. Tabbing onto a floating panel is not offered:
      // tab strips belong to dock slots.
      data-tab-drop-target={mode === 'docked' ? id : undefined}
      data-drop-target={isDropTarget ? 'true' : undefined}
      style={{ '--xleth-windowing-panel-color': panelTypeColorVar(id) } as CSSProperties}
      onPointerDown={startTitlebarDrag}
      onDoubleClick={toggleTitlebarMaximize}
      onKeyDown={onTitlebarKeyDown}
      role="toolbar"
      aria-label={`${entry.title} title bar`}
      aria-orientation="horizontal"
      tabIndex={mode === 'floating' ? 0 : -1}
    >
      <span className="xleth-windowing-accent-bar" aria-hidden="true" />
      <span
        className="xleth-windowing-focus-underline"
        data-testid={`xleth-windowing-underline-${id}`}
        data-focused={focused}
        aria-hidden="true"
      />
      {children ? <div className="xleth-windowing-titlebar-content">{children}</div> : null}
      <span className="xleth-windowing-drag-zone" aria-hidden="true" />
      <div className="xleth-windowing-controls" aria-label={`${entry.title} panel controls`}>
        {canReturnToDock ? (
          <XlethIconButton
            type="button"
            className="xleth-windowing-control-button"
            aria-label={returnLabel}
            title={returnLabel}
            data-hint={returnLabel}
            onPointerDown={stopControlPointerDown}
            onClick={returnToDock}
          >
            <ArrowDownToLine aria-hidden="true" strokeWidth={2} />
          </XlethIconButton>
        ) : null}
        <XlethIconButton
          type="button"
          className="xleth-windowing-control-button"
          aria-label={collapseLabel}
          aria-expanded={!collapsed}
          title={collapseLabel}
          onPointerDown={stopControlPointerDown}
          onClick={toggleCollapse}
        >
          {collapsed
            ? <ChevronDown aria-hidden="true" strokeWidth={2} />
            : <ChevronUp aria-hidden="true" strokeWidth={2} />}
        </XlethIconButton>
        {canMaximize ? (
          <XlethIconButton
            type="button"
            className="xleth-windowing-control-button"
            aria-label={mode === 'maximized' ? `Restore ${entry.title}` : `Maximize ${entry.title}`}
            title={mode === 'maximized' ? `Restore ${entry.title}` : `Maximize ${entry.title}`}
            onPointerDown={stopControlPointerDown}
            onClick={toggleMaximize}
          >
            {mode === 'maximized'
              ? <Square aria-hidden="true" strokeWidth={2} />
              : <Maximize2 aria-hidden="true" strokeWidth={2} />}
          </XlethIconButton>
        ) : null}
        <XlethIconButton
          type="button"
          className="xleth-windowing-control-button"
          aria-label={`Close ${entry.title}`}
          title={`Close ${entry.title}`}
          onPointerDown={stopControlPointerDown}
          onClick={hidePanel}
        >
          <X aria-hidden="true" strokeWidth={2} />
        </XlethIconButton>
      </div>
    </div>
  );
}

export default Titlebar;
