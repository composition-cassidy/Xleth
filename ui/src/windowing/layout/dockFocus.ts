import { DETAIL_DOCK_TAB_IDS, type PanelId } from '../registry/panelCatalog';
import { usePanelRegistry, type PanelStateMap } from '../registry/PanelRegistry';
import { useShellLayoutStore } from './shellLayoutStore';

// Opening, closing and focusing the detail dock as a whole (the top bar's
// "Detail dock" toggle, the dock's focus button, and the Ctrl+Shift+D command).
// Kept apart from DetailDock.tsx so the component and its callers do not import
// each other.

function openDetailTabId(panels: PanelStateMap): PanelId | null {
  return DETAIL_DOCK_TAB_IDS.find((id) => {
    const panel = panels[id];
    return panel.mode === 'docked' && panel.docked.region === 'bottom' && !panel.hidden;
  }) ?? null;
}

let lastTab: PanelId = DETAIL_DOCK_TAB_IDS[0];
// Whatever opens a tab (a click, an F-key, "inserts" in the mixer) is remembered,
// so reopening the dock lands where the user last was.
usePanelRegistry.subscribe((state) => {
  const open = openDetailTabId(state.panels);
  if (open) lastTab = open;
});

export function isDetailDockOpen(): boolean {
  return openDetailTabId(usePanelRegistry.getState().panels) !== null;
}

/** Opens the last-used tab (Devices on a fresh layout) when no tab is open. */
export function openDetailDock(): void {
  const registry = usePanelRegistry.getState();
  if (openDetailTabId(registry.panels)) return;
  const panel = registry.panels[lastTab];
  if (panel.mode === 'docked' && panel.docked.region === 'bottom') registry.openPanel(lastTab);
  else registry.dockPanel(lastTab, 'bottom');
}

export function closeDetailDock(): void {
  const registry = usePanelRegistry.getState();
  const open = openDetailTabId(registry.panels);
  if (open) registry.closePanel(open);
}

export function toggleDetailDock(): void {
  if (isDetailDockOpen()) closeDetailDock();
  else openDetailDock();
}

/** Dock focus mode: the dock takes the whole centre column; the same call restores. */
export function toggleDockFocus(): void {
  const store = useShellLayoutStore.getState();
  if (store.focus) {
    store.setFocus(false);
    return;
  }
  openDetailDock();
  store.setFocus(true);
}
