import { useEffect } from 'react';
import { PANEL_IDS } from '../registry/panelCatalog';
import { usePanelRegistry } from '../registry/PanelRegistry';

function isTextEntryElement(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

export function useEscRestoreMaximized(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (typeof document !== 'undefined' && isTextEntryElement(document.activeElement)) return;

      const registry = usePanelRegistry.getState();
      const focusedPanelId = PANEL_IDS.find((id) => registry.panels[id].focused);
      if (!focusedPanelId) return;

      const focusedPanel = registry.panels[focusedPanelId];
      if (focusedPanel.mode === 'maximized') registry.restorePanel(focusedPanelId);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}

export default useEscRestoreMaximized;
