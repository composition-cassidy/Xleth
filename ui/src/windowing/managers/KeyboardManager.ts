import { PANEL_IDS } from '../registry/panelCatalog';
import { usePanelRegistry } from '../registry/PanelRegistry';

const bindings = new Map<string, () => void>();

function isTextEntryElement(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

function normalizeKey(key: string): string {
  return key;
}

function registerDefaultBindings(): void {
  registerBinding('F5', () => usePanelRegistry.getState().togglePanel('timeline'));
  registerBinding('F6', () => usePanelRegistry.getState().togglePanel('sampleSelector'));
  registerBinding('F7', () => usePanelRegistry.getState().togglePanel('pianoRoll'));
  registerBinding('F8', () => usePanelRegistry.getState().togglePanel('preview'));
  registerBinding('F9', () => usePanelRegistry.getState().togglePanel('mixer'));
  registerBinding('F10', () => usePanelRegistry.getState().togglePanel('gridSettings'));
  registerBinding('F11', () => usePanelRegistry.getState().togglePanel('nodeEditor'));
  registerBinding('Escape', () => {
    const reg = usePanelRegistry.getState();
    const focusedId = PANEL_IDS.find((id) => reg.panels[id].focused);
    if (focusedId && reg.panels[focusedId].mode === 'maximized') {
      reg.restorePanel(focusedId);
    }
  });
}

export function handleKeyEvent(event: KeyboardEvent): void {
  if (typeof document !== 'undefined' && isTextEntryElement(document.activeElement)) return;

  const action = bindings.get(normalizeKey(event.key));
  action?.();
}

const onKeyDown = (event: KeyboardEvent) => handleKeyEvent(event);

export function init(): void {
  if (typeof document === 'undefined') return;
  document.addEventListener('keydown', onKeyDown);
}

export function destroy(): void {
  if (typeof document === 'undefined') return;
  document.removeEventListener('keydown', onKeyDown);
}

export function registerBinding(key: string, action: () => void): void {
  bindings.set(normalizeKey(key), action);
}

export function getBindings(): ReadonlyMap<string, () => void> {
  return bindings;
}

export function rebind(oldKey: string, newKey: string): boolean {
  const normalizedOldKey = normalizeKey(oldKey);
  const normalizedNewKey = normalizeKey(newKey);

  if (bindings.has(normalizedNewKey)) return false;

  const action = bindings.get(normalizedOldKey);
  if (!action) return true;

  bindings.delete(normalizedOldKey);
  bindings.set(normalizedNewKey, action);
  return true;
}

// test-only
export function resetBindingsForTest(): void {
  bindings.clear();
  registerDefaultBindings();
}

registerDefaultBindings();
