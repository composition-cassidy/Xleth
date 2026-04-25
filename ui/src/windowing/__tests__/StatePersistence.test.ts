import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as SP from '../managers/StatePersistence';
import { createInitialPanelStates, usePanelRegistry } from '../registry/PanelRegistry';

function makeAdapter(): SP.MemoryAdapter {
  return new SP.MemoryAdapter();
}

describe('StatePersistence', () => {
  beforeEach(() => {
    SP.destroy();
    SP.setPersistenceAdapter(SP.noOpAdapter);
    usePanelRegistry.setState({ panels: createInitialPanelStates() });
  });

  it('loadPersistedState is a no-op when adapter returns null', async () => {
    SP.setPersistenceAdapter(makeAdapter());
    const before = usePanelRegistry.getState().panels;
    await expect(SP.loadPersistedState()).resolves.toBe(false);
    expect(usePanelRegistry.getState().panels).toEqual(before);
  });

  it('loadPersistedState hydrates registry from stored versioned JSON', async () => {
    const adapter = makeAdapter();
    const panels = createInitialPanelStates();
    panels.mixer.hidden = false;
    await adapter.write(JSON.stringify({
      version: SP.LAYOUT_SCHEMA_VERSION,
      panels,
    }));
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(true);
    expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(false);
  });

  it('loadPersistedState ignores corrupt JSON silently', async () => {
    const adapter = makeAdapter();
    await adapter.write('not json {{');
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(false);
  });

  it('loadPersistedState rejects wrong schema versions', async () => {
    const adapter = makeAdapter();
    const before = usePanelRegistry.getState().panels;
    await adapter.write(JSON.stringify({
      version: SP.LAYOUT_SCHEMA_VERSION + 1,
      panels: createInitialPanelStates(),
    }));
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(false);
    expect(usePanelRegistry.getState().panels).toEqual(before);
  });

  it('loadPersistedState rejects payloads with missing panel ids', async () => {
    const adapter = makeAdapter();
    const before = usePanelRegistry.getState().panels;
    const panels = createInitialPanelStates();
    delete (panels as Partial<typeof panels>).preview;
    await adapter.write(JSON.stringify({
      version: SP.LAYOUT_SCHEMA_VERSION,
      panels,
    }));
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(false);
    expect(usePanelRegistry.getState().panels).toEqual(before);
  });

  it('init wires writes through adapter on state change', async () => {
    const adapter = makeAdapter();
    SP.setPersistenceAdapter(adapter);
    SP.init();
    usePanelRegistry.getState().openPanel('mixer');
    await vi.waitFor(async () => {
      expect(await adapter.read()).toBe(JSON.stringify({
        version: SP.LAYOUT_SCHEMA_VERSION,
        panels: usePanelRegistry.getState().panels,
      }));
    }, { timeout: 1200 });
  });

  it('destroy unwires the writer', async () => {
    const adapter = makeAdapter();
    const spy = vi.spyOn(adapter, 'write');
    SP.setPersistenceAdapter(adapter);
    SP.init();
    SP.destroy();
    usePanelRegistry.getState().openPanel('mixer');
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(spy).not.toHaveBeenCalled();
  });

  it('noOpAdapter does not throw on init + state change', async () => {
    SP.setPersistenceAdapter(SP.noOpAdapter);
    SP.init();
    expect(() => usePanelRegistry.getState().openPanel('preview')).not.toThrow();
    await expect(SP.loadPersistedState()).resolves.toBe(false);
  });
});
