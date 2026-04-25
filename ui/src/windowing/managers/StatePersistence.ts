import {
  clearLayoutPersistenceWriter,
  setLayoutPersistenceWriter,
  usePanelRegistry,
  type LayoutPersistenceWriter,
  type PanelStateMap,
} from '../registry/PanelRegistry';

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

let currentAdapter: Pick<MemoryAdapter, 'read' | 'write'> = noOpAdapter;

export function setPersistenceAdapter(adapter: Pick<MemoryAdapter, 'read' | 'write'>): void {
  currentAdapter = adapter;
}

export function init(): void {
  const writer: LayoutPersistenceWriter = (panels) => {
    void currentAdapter.write(JSON.stringify(panels));
  };

  setLayoutPersistenceWriter(writer);
}

export function destroy(): void {
  setLayoutPersistenceWriter(null);
  clearLayoutPersistenceWriter();
}

export async function loadPersistedState(): Promise<void> {
  const raw = await currentAdapter.read();
  if (raw === null) return;

  try {
    const panels = JSON.parse(raw) as PanelStateMap;
    usePanelRegistry.setState({ panels });
  } catch {
    // Corrupt persisted layout data should leave the live registry untouched.
  }
}
