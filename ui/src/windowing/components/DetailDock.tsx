import React, { useRef } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { ArrowDownToLine, PictureInPicture2 } from 'lucide-react';
import { DockSlotProvider } from '../contexts/DockSlotContext';
import { getRegisteredWorkAreaRect } from '../managers/DragManager';
import { useDockRegionResizePreview } from '../managers/DockRegionResizeManager';
import {
  DETAIL_DOCK_TAB_IDS,
  PANEL_CATALOG,
  WINDOW_PANEL_IDS,
  isPanelId,
  type PanelId,
} from '../registry/panelCatalog';
import { usePanelRegistry, type PanelState, type PanelStateMap } from '../registry/PanelRegistry';
import { DockRegionResizer } from './DockRegionResizer';
import styles from './DetailDock.module.css';

/**
 * Where a tab's panel is right now.
 * - open:    docked here and showing; the dock is expanded on it.
 * - docked:  lives in the dock, currently closed back to its tab.
 * - popped:  in its own floating (or maximized) window.
 * - stowed:  its pop-out window was closed; the tab brings it home.
 */
export type DetailTabState = 'open' | 'docked' | 'popped' | 'stowed';

function inDock(panel: PanelState): boolean {
  return panel.mode === 'docked' && panel.docked.region === 'bottom';
}

export function detailTabState(panel: PanelState): DetailTabState {
  if (inDock(panel)) return panel.hidden ? 'docked' : 'open';
  return panel.hidden ? 'stowed' : 'popped';
}

/**
 * Flat string of the tab strip: "id:state" per tab. The catalog's dock tabs
 * always show; any other window docked at the bottom (dragged there) joins the
 * strip while it is open. A primitive key keeps the store subscription cheap.
 */
export function detailDockKey(panels: PanelStateMap): string {
  const extras = WINDOW_PANEL_IDS.filter((id) => (
    !DETAIL_DOCK_TAB_IDS.includes(id) && !panels[id].hidden && inDock(panels[id])
  ));
  return [...DETAIL_DOCK_TAB_IDS, ...extras]
    .map((id) => `${id}:${detailTabState(panels[id])}`)
    .join(',');
}

export function parseDetailDockKey(key: string): Array<{ id: PanelId; state: DetailTabState }> {
  if (key === '') return [];
  return key.split(',').flatMap((entry) => {
    const [id, state] = entry.split(':');
    return isPanelId(id) ? [{ id, state: state as DetailTabState }] : [];
  });
}

/** Tab click: open it, collapse the dock if it was the open one, or bring its window forward. */
export function activateDetailTab(id: PanelId): void {
  const registry = usePanelRegistry.getState();
  const state = detailTabState(registry.panels[id]);
  if (state === 'open') {
    console.log(`[Shell] detail dock: collapse (${id})`);
    registry.closePanel(id);
  } else if (state === 'docked') {
    console.log(`[Shell] detail dock: open ${id}`);
    registry.openPanel(id);
  } else if (state === 'popped') {
    registry.focusPanel(id);
  } else {
    console.log(`[Shell] detail dock: return ${id} from its closed window`);
    registry.dockPanel(id, 'bottom');
  }
}

/** Pop a tab out into its own window, or bring a popped-out one back into the dock. */
export function togglePopOutDetailTab(id: PanelId): void {
  const registry = usePanelRegistry.getState();
  const panel = registry.panels[id];
  const state = detailTabState(panel);
  if (state === 'popped' || state === 'stowed') {
    console.log(`[Shell] detail dock: re-dock ${id}`);
    registry.dockPanel(id, 'bottom');
    return;
  }
  const area = getRegisteredWorkAreaRect();
  const fits = Number.isFinite(area.width) && Number.isFinite(area.height) && area.width > 0 && area.height > 0;
  // Centred in the work area; AppShell clamps it to the work area afterwards.
  const x = fits ? Math.max(0, Math.round((area.width - panel.floating.width) / 2)) : panel.floating.x;
  const y = fits ? Math.max(0, Math.round((area.height - panel.floating.height) / 3)) : panel.floating.y;
  console.log(`[Shell] detail dock: pop out ${id}`);
  registry.undockPanel(id, x, y);
}

export interface DetailDockProps {
  renderPanel: (id: PanelId) => ReactNode;
}

export function DetailDock({ renderPanel }: DetailDockProps) {
  const reactiveKey = usePanelRegistry((state) => detailDockKey(state.panels));
  const reactiveSize = usePanelRegistry((state) => state.dockRegionSizes.bottom);
  const isSSR = typeof window === 'undefined';
  const key = isSSR ? detailDockKey(usePanelRegistry.getState().panels) : reactiveKey;
  const committedSize = isSSR ? usePanelRegistry.getState().dockRegionSizes.bottom : reactiveSize;
  const preview = useDockRegionResizePreview('bottom');
  const stripRef = useRef<HTMLDivElement>(null);

  const tabs = parseDetailDockKey(key);
  const openTab = tabs.find((tab) => tab.state === 'open') ?? null;
  const size = preview?.size ?? committedSize;
  const dockStyle: CSSProperties | undefined = openTab ? { height: `${size}px` } : undefined;

  // Roving focus across the tabs, per the ARIA tabs pattern. Arrows move focus
  // only; Enter/Space (a click) opens, so browsing never mounts heavy panels.
  const onTabKeyDown = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    stripRef.current?.querySelector<HTMLButtonElement>(`[data-detail-tab="${tabs[next].id}"]`)?.focus();
  };
  const focusableIndex = Math.max(0, tabs.findIndex((tab) => tab.state === 'open'));

  return (
    <section
      className={styles.dock}
      data-testid="xleth-detail-dock"
      data-dock-state={openTab ? 'open' : 'collapsed'}
      aria-label="Detail dock"
      style={dockStyle}
    >
      {openTab ? <DockRegionResizer region="bottom" currentSize={committedSize} /> : null}
      <div ref={stripRef} className={styles.strip} role="tablist" aria-label="Detail views">
        {tabs.map((tab, index) => {
          const entry = PANEL_CATALOG[tab.id];
          const away = tab.state === 'popped' || tab.state === 'stowed';
          const popLabel = away ? `Return ${entry.title} to the dock` : `Pop out ${entry.title}`;
          const fKey = 'fKey' in entry && entry.fKey ? entry.fKey : null;
          const tabHint = tab.state === 'open'
            ? `${entry.title}: click to collapse the dock`
            : tab.state === 'popped'
              ? `${entry.title} is in its own window: click to bring it forward`
              : `${entry.title}: click to open in the dock`;
          return (
            <div key={tab.id} className={styles.tab} data-state={tab.state} role="presentation">
              <button
                type="button"
                className={styles.tabButton}
                role="tab"
                data-detail-tab={tab.id}
                aria-selected={tab.state === 'open'}
                aria-controls={tab.state === 'open' ? 'xleth-detail-dock-body' : undefined}
                tabIndex={index === focusableIndex ? 0 : -1}
                data-hint={tabHint}
                data-hint-mods={fKey ? `${fKey} toggles` : undefined}
                onClick={() => activateDetailTab(tab.id)}
                onKeyDown={onTabKeyDown(index)}
              >
                {entry.title}
              </button>
              <button
                type="button"
                className={styles.popButton}
                aria-label={popLabel}
                data-hint={popLabel}
                onClick={() => togglePopOutDetailTab(tab.id)}
              >
                {away
                  ? <ArrowDownToLine aria-hidden="true" strokeWidth={2} />
                  : <PictureInPicture2 aria-hidden="true" strokeWidth={2} />}
              </button>
            </div>
          );
        })}
      </div>
      {openTab ? (
        <div className={styles.body} id="xleth-detail-dock-body" role="tabpanel" aria-label={PANEL_CATALOG[openTab.id].title}>
          <DockSlotProvider region="bottom" tabIds={[openTab.id]} activeId={openTab.id} chromeless>
            {renderPanel(openTab.id)}
          </DockSlotProvider>
        </div>
      ) : null}
    </section>
  );
}

export default DetailDock;
