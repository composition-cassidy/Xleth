import {
  clearLayoutPersistenceWriter,
  setLayoutPersistenceWriter,
  usePanelRegistry,
  type LayoutPersistenceWriter,
  type PanelStateMap,
} from '../registry/PanelRegistry';
import { PANEL_IDS } from '../registry/panelCatalog';

export const LAYOUT_SCHEMA_VERSION = 1;

interface PersistenceAdapter {
  read(): Promise<string | null>;
  write(data: string): Promise<void>;
}

interface PersistedLayoutEnvelope {
  version: number;
  panels: PanelStateMap;
}

export const noOpAdapter = {
  async read(): Promise<string | null> {
    return null;
  },

  async write(_data: string): Promise<void> {},
};

export class MemoryAdapter {
  private store = new Map<string, string>();

  async read(): Promise<string | null> {
    return this.store.get('layout') ?? null;
  }

  async write(data: string): Promise<void> {
    this.store.set('layout', data);
  }
}

export class ElectronAdapter {
  async read(): Promise<string | null> {
    if (typeof window === 'undefined') return null;

    const raw = await (window as typeof window & { xleth?: any }).xleth?.layout?.read?.();
    return typeof raw === 'string' ? raw : null;
  }

  async write(data: string): Promise<void> {
    if (typeof window === 'undefined') return;
    await (window as typeof window & { xleth?: any }).xleth?.layout?.write?.(data);
  }
}

let currentAdapter: PersistenceAdapter = noOpAdapter;

export function setPersistenceAdapter(adapter: PersistenceAdapter): void {
  currentAdapter = adapter;
}

function serializeLayoutEnvelope(panels: PanelStateMap): string {
  const payload: PersistedLayoutEnvelope = {
    version: LAYOUT_SCHEMA_VERSION,
    panels,
  };
  return JSON.stringify(payload);
}

function isValidPanelStateMap(value: unknown): value is PanelStateMap {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return PANEL_IDS.every((panelId) => (
    Object.prototype.hasOwnProperty.call(record, panelId)
    && record[panelId] != null
  ));
}

export function init(): void {
  const writer: LayoutPersistenceWriter = (panels) => {
    void currentAdapter.write(serializeLayoutEnvelope(panels));
  };

  setLayoutPersistenceWriter(writer);
}

export function destroy(): void {
  setLayoutPersistenceWriter(null);
  clearLayoutPersistenceWriter();
}

export async function loadPersistedState(): Promise<boolean> {
  const raw = await currentAdapter.read();
  if (raw === null) return false;

  try {
    const parsed = JSON.parse(raw) as PersistedLayoutEnvelope;
    if (parsed?.version !== LAYOUT_SCHEMA_VERSION) return false;
    if (!isValidPanelStateMap(parsed?.panels)) return false;
    usePanelRegistry.setState({ panels: parsed.panels });
    return true;
  } catch {
    // Corrupt persisted layout data should leave the live registry untouched.
    return false;
  }
}
