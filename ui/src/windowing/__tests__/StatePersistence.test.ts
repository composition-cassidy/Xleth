import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as SP from '../managers/StatePersistence';
import { DEFAULT_PRESET_ID, loadPreset } from '../managers/PresetManager';
import {
  createInitialDockRegionSizes,
  createInitialPanelStates,
  DEFAULT_DOCK_REGION_SIZES,
  MIN_DOCK_REGION_SIZES,
  usePanelRegistry,
} from '../registry/PanelRegistry';
import { PANEL_CATALOG } from '../registry/panelCatalog';

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

  it('loadPersistedState merges envelopes written by a newer schema version', async () => {
    // A forward version is merged field-by-field like any other: unknown fields
    // are ignored and known ones validated, which beats discarding a layout the
    // user spent time arranging.
    const adapter = makeAdapter();
    const panels = createInitialPanelStates();
    panels.mixer.hidden = false;
    await adapter.write(JSON.stringify({
      version: SP.LAYOUT_SCHEMA_VERSION + 1,
      panels,
      dockRegionSizes: createInitialDockRegionSizes(),
      somethingFromTheFuture: { nope: true },
    }));
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(true);
    expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(false);
  });

  it('loadPersistedState keeps the panels it has when an id is missing', async () => {
    // THE regression this contract exists for: every release that adds a panel
    // used to invalidate the whole saved layout and silently reset everyone.
    const adapter = makeAdapter();
    const panels = createInitialPanelStates();
    panels.mixer.hidden = false;
    panels.mixer.floating = { x: 11, y: 22, width: 640, height: 480 };
    delete (panels as Partial<typeof panels>).preview;
    await adapter.write(JSON.stringify({
      version: SP.LAYOUT_SCHEMA_VERSION,
      panels,
      dockRegionSizes: createInitialDockRegionSizes(),
    }));
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(true);

    const loaded = usePanelRegistry.getState().panels;
    expect(loaded.mixer.hidden).toBe(false);
    expect(loaded.mixer.floating).toEqual({ x: 11, y: 22, width: 640, height: 480 });
    // The absent panel falls back to its catalog default rather than undefined.
    expect(loaded.preview).toBeDefined();
    expect(loaded.preview.floating).toEqual(PANEL_CATALOG.preview.defaultFloating);
  });

  it('loadPersistedState ignores panel ids that are no longer in the catalog', async () => {
    const adapter = makeAdapter();
    const panels = createInitialPanelStates() as Record<string, unknown>;
    panels.someRetiredPanel = { id: 'someRetiredPanel', hidden: false };
    await adapter.write(JSON.stringify({
      version: SP.LAYOUT_SCHEMA_VERSION,
      panels,
      dockRegionSizes: createInitialDockRegionSizes(),
    }));
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(true);
    expect(usePanelRegistry.getState().panels).not.toHaveProperty('someRetiredPanel');
  });

  it('loadPersistedState fills dock region sizes the envelope omits', async () => {
    const adapter = makeAdapter();
    await adapter.write(JSON.stringify({
      version: SP.LAYOUT_SCHEMA_VERSION,
      panels: createInitialPanelStates(),
      dockRegionSizes: { left: 320, right: 280 },
    }));
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(true);
    expect(usePanelRegistry.getState().dockRegionSizes).toEqual({
      ...DEFAULT_DOCK_REGION_SIZES,
      left: 320,
      right: 280,
    });
  });

  it('loadPersistedState clamps below-min dock region sizes instead of rejecting', async () => {
    const adapter = makeAdapter();
    await adapter.write(JSON.stringify({
      version: SP.LAYOUT_SCHEMA_VERSION,
      panels: createInitialPanelStates(),
      dockRegionSizes: { left: 100, right: 280, top: 240, bottom: 240 },
    }));
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(true);
    expect(usePanelRegistry.getState().dockRegionSizes.left).toBe(MIN_DOCK_REGION_SIZES.left);
    expect(usePanelRegistry.getState().dockRegionSizes.bottom).toBe(240);
  });

  it('loadPersistedState falls back per-field on a corrupt panel entry', async () => {
    const adapter = makeAdapter();
    const panels = createInitialPanelStates() as Record<string, any>;
    panels.mixer = {
      id: 'mixer',
      hidden: false,
      mode: 'not-a-mode',
      floating: { x: 42, y: Number.NaN, width: 'wide', height: 500 },
      docked: { region: 'nowhere', sizeInRegion: -9000, tabGroupId: 'ghostPanel' },
    };
    await adapter.write(JSON.stringify({
      version: SP.LAYOUT_SCHEMA_VERSION,
      panels,
      dockRegionSizes: createInitialDockRegionSizes(),
    }));
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(true);

    const mixer = usePanelRegistry.getState().panels.mixer;
    expect(mixer.hidden).toBe(false);                 // valid field survives
    expect(mixer.floating.x).toBe(42);                // valid field survives
    expect(mixer.mode).toBe('floating');              // bad enum -> default
    expect(mixer.floating.y).toBe(PANEL_CATALOG.mixer.defaultFloating.y);
    expect(mixer.floating.width).toBe(PANEL_CATALOG.mixer.defaultFloating.width);
    expect(mixer.floating.height).toBe(500);
    expect(mixer.docked.region).toBe('bottom');       // bad enum -> default
    expect(mixer.docked.sizeInRegion).toBe(PANEL_CATALOG.mixer.minDockedSize);
    expect(mixer.docked.tabGroupId).toBeNull();       // unknown id -> own slot
  });

  // A maximized panel used to come back with preMaximizeState nulled, which
  // made restorePanel() — the titlebar control, the double-click and Escape
  // alike — a permanent no-op: the panel owned the whole workarea and could
  // never be moved, docked or shared with another panel again.
  it('loadPersistedState restores a maximized panel with its restore target', async () => {
    const adapter = makeAdapter();
    const panels = createInitialPanelStates();
    usePanelRegistry.getState().openPanel('pianoRoll');
    usePanelRegistry.getState().dockPanel('pianoRoll', 'top');
    usePanelRegistry.getState().maximizePanel('pianoRoll');
    panels.pianoRoll = usePanelRegistry.getState().panels.pianoRoll;
    expect(panels.pianoRoll.preMaximizeState).not.toBeNull();

    await adapter.write(JSON.stringify({
      version: SP.LAYOUT_SCHEMA_VERSION,
      panels,
      dockRegionSizes: createInitialDockRegionSizes(),
    }));
    usePanelRegistry.setState({ panels: createInitialPanelStates() });
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(true);

    expect(usePanelRegistry.getState().panels.pianoRoll.mode).toBe('maximized');
    usePanelRegistry.getState().restorePanel('pianoRoll');
    const pianoRoll = usePanelRegistry.getState().panels.pianoRoll;
    expect(pianoRoll.mode).toBe('docked');
    expect(pianoRoll.docked.region).toBe('top');
    expect(pianoRoll.preMaximizeState).toBeNull();
  });

  it('loadPersistedState un-maximizes a panel whose restore target was lost', async () => {
    const adapter = makeAdapter();
    const panels = createInitialPanelStates() as Record<string, any>;
    // Exactly what builds before this fix wrote: maximized, nothing to restore to.
    panels.pianoRoll = { ...panels.pianoRoll, hidden: false, mode: 'maximized', preMaximizeState: null };
    await adapter.write(JSON.stringify({
      version: SP.LAYOUT_SCHEMA_VERSION,
      panels,
      dockRegionSizes: createInitialDockRegionSizes(),
    }));
    SP.setPersistenceAdapter(adapter);
    await expect(SP.loadPersistedState()).resolves.toBe(true);
    expect(usePanelRegistry.getState().panels.pianoRoll.mode).toBe('floating');
  });

  it('loadPersistedState fills default dockRegionSizes when a tiled envelope omits them', async () => {
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
    expect(usePanelRegistry.getState().dockRegionSizes).toEqual(DEFAULT_DOCK_REGION_SIZES);
  });

  it.each([1, 2, 3, undefined])(
    'migrates a pre-tiled (v%s) layout once to the default layout and writes it back',
    async (version) => {
      const adapter = makeAdapter();
      // The old default: a floating arrangement over an empty work area.
      const panels = createInitialPanelStates() as unknown as Record<string, Record<string, unknown>>;
      panels.timeline = { ...panels.timeline, mode: 'floating' };
      panels.mixer = { ...panels.mixer, hidden: false, mode: 'docked' };
      await adapter.write(JSON.stringify({ version, panels }));
      SP.setPersistenceAdapter(adapter);

      await expect(SP.loadPersistedState()).resolves.toBe(true);

      const expected = loadPreset(DEFAULT_PRESET_ID)!;
      const state = usePanelRegistry.getState();
      expect(state.panels.timeline.docked.region).toBe('center');
      expect(state.panels.preview.docked.region).toBe('top');
      expect(state.panels.inspector.hidden).toBe(false);
      expect(state.dockRegionSizes).toEqual(expected.dockRegionSizes);

      // Written back as v4 straight away, so the next launch merges it instead
      // of migrating again.
      const written = JSON.parse((await adapter.read())!);
      expect(written.version).toBe(SP.LAYOUT_SCHEMA_VERSION);
      expect(written.panels.timeline.docked.region).toBe('center');
    },
  );

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

  it('init persists docked panel pair resize changes through adapter', async () => {
    const adapter = makeAdapter();
    const panels = createInitialPanelStates();
    panels.timeline.hidden = false;
    panels.timeline.mode = 'docked';
    panels.timeline.docked = { region: 'bottom', orderInRegion: 0, sizeInRegion: 300 };
    panels.mixer.hidden = false;
    panels.mixer.mode = 'docked';
    panels.mixer.docked = { region: 'bottom', orderInRegion: 1, sizeInRegion: 300 };
    usePanelRegistry.setState({ panels });

    SP.setPersistenceAdapter(adapter);
    SP.init();
    // 320/280 keeps both panels above MIN_DOCKED_PANEL_MAIN_SIZES (mixer: 260);
    // a clamped-to-current write would be a registry no-op and never persist.
    usePanelRegistry.getState().resizeDockedPanelPair('bottom', 'timeline', 320, 'mixer', 280);

    await vi.waitFor(async () => {
      const raw = await adapter.read();
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.panels.timeline.docked.sizeInRegion).toBe(320);
      expect(parsed.panels.mixer.docked.sizeInRegion).toBe(280);
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
