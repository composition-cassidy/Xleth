import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as SP from '../managers/StatePersistence';
import {
  createInitialDockRegionSizes,
  createInitialPanelStates,
  DEFAULT_DOCK_REGION_SIZES,
  usePanelRegistry,
} from '../registry/PanelRegistry';

function makeAdapter(): SP.MemoryAdapter {
  return new SP.MemoryAdapter();
}

describe('StatePersistence', () => {
  beforeEach(() => {
    SP.destroy();
    SP.setPersistenceAdapter(SP.noOpAdapter);
    usePanelRegistry.setState({
      panels: createInitialPanelStates(),
      dockRegionSizes: createInitialDockRegionSizes(),
    });
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
    const dockRegionSizes = { left: 320, right: 280, top: 240, bottom: 320 };
    await adapter.write(JSON.stringify({
      version: SP.LAYOUT_SCHEMA_VERSION,
      panels,
      dockRegionSizes,
    }));
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(true);
    expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(false);
    expect(usePanelRegistry.getState().dockRegionSizes).toEqual(dockRegionSizes);
  });

  it('loadPersistedState ignores corrupt JSON silently', async () => {
    const adapter = makeAdapter();
    await adapter.write('not json {{');
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(false);
  });

  it('loadPersistedState rejects forward-incompat schema versions', async () => {
    const adapter = makeAdapter();
    const before = usePanelRegistry.getState().panels;
    await adapter.write(JSON.stringify({
      version: SP.LAYOUT_SCHEMA_VERSION + 1,
      panels: createInitialPanelStates(),
      dockRegionSizes: createInitialDockRegionSizes(),
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
      dockRegionSizes: createInitialDockRegionSizes(),
    }));
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(false);
    expect(usePanelRegistry.getState().panels).toEqual(before);
  });

  it('loadPersistedState rejects v2 payloads with missing dockRegionSizes', async () => {
    const adapter = makeAdapter();
    await adapter.write(JSON.stringify({
      version: SP.LAYOUT_SCHEMA_VERSION,
      panels: createInitialPanelStates(),
      dockRegionSizes: { left: 280, right: 280 },
    }));
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(false);
  });

  it('loadPersistedState rejects v2 payloads with below-min dock region sizes', async () => {
    const adapter = makeAdapter();
    await adapter.write(JSON.stringify({
      version: SP.LAYOUT_SCHEMA_VERSION,
      panels: createInitialPanelStates(),
      dockRegionSizes: { left: 100, right: 280, top: 240, bottom: 240 },
    }));
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(false);
  });

  it('loadPersistedState soft-migrates v1 envelopes by filling default dockRegionSizes', async () => {
    const adapter = makeAdapter();
    const panels = createInitialPanelStates();
    panels.mixer.hidden = false;
    await adapter.write(JSON.stringify({
      version: 1,
      panels,
    }));
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(true);
    expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(false);
    expect(usePanelRegistry.getState().dockRegionSizes).toEqual(DEFAULT_DOCK_REGION_SIZES);
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
        dockRegionSizes: usePanelRegistry.getState().dockRegionSizes,
      }));
    }, { timeout: 1200 });
  });

  it('init persists setDockRegionSize changes through adapter', async () => {
    const adapter = makeAdapter();
    SP.setPersistenceAdapter(adapter);
    SP.init();
    usePanelRegistry.getState().setDockRegionSize('left', 360);
    await vi.waitFor(async () => {
      const raw = await adapter.read();
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.dockRegionSizes.left).toBe(360);
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
