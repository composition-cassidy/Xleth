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
    await SP.loadPersistedState();
    expect(usePanelRegistry.getState().panels).toEqual(before);
  });

  it('loadPersistedState hydrates registry from stored JSON', async () => {
    const adapter = makeAdapter();
    const panels = createInitialPanelStates();
    panels.mixer.hidden = false;
    await adapter.write(JSON.stringify(panels));
    SP.setPersistenceAdapter(adapter);
    await SP.loadPersistedState();
    expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(false);
  });

  it('loadPersistedState ignores corrupt JSON silently', async () => {
    const adapter = makeAdapter();
    await adapter.write('not json {{');
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBeUndefined();
  });

  it('init wires writes through adapter on state change', async () => {
    const adapter = makeAdapter();
    SP.setPersistenceAdapter(adapter);
    SP.init();
    usePanelRegistry.getState().openPanel('mixer');
    await vi.waitFor(async () => {
      expect(await adapter.read()).not.toBeNull();
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
    await expect(SP.loadPersistedState()).resolves.toBeUndefined();
  });
});
