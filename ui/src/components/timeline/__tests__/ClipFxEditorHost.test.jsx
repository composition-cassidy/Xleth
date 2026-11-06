import React from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// These tests pin down the per-clip FX editor *ownership* contract, the clip
// identity twin of mixer/__tests__/EffectEditorHost.test.jsx:
//
//   - Per-clip modulation editors are rendered by the global ClipFxEditorHost,
//     mounted at the windowing root — NOT by TimelineView. A floating PanelFrame
//     uses `transform: translate3d(...)`, which would make a `position: fixed`
//     editor mounted inside it clip to the Timeline's box. Hosting the editors
//     outside every PanelFrame keeps them free.
//   - The Timeline clip dropdown only *requests* an editor through
//     openClipFxEditor('vibrato' | 'scratch', clipId); identity ({ clipId })
//     lives in the store.
//   - Orphan handling mirrors closeEffectEditorForNode / closeAllEffectEditors.
//
// NOTE: zustand v5 uses getInitialState() as its server snapshot, so
// renderToStaticMarkup never reflects setState() updates. We therefore assert
// ownership against the React element tree / module graph rather than rendered
// HTML, and assert identity against the store's getState().

const here = dirname(fileURLToPath(import.meta.url))
const TIMELINE_DIR = resolve(here, '..')
const COMPONENTS_DIR = resolve(TIMELINE_DIR, '..')
const WINDOWING_DIR = resolve(COMPONENTS_DIR, '..', 'windowing')

// Collect the component types that a hookless component mounts in its own JSX,
// descending only through host (string-typed) elements — never into nested
// component instances. This reveals which editors a host *owns*.
function collectOwnedComponents(children, acc = []) {
  React.Children.forEach(children, (child) => {
    if (!child || typeof child !== 'object') return
    acc.push(child.type)
    if (typeof child.type === 'string' && child.props?.children) {
      collectOwnedComponents(child.props.children, acc)
    }
  })
  return acc
}

function installWindow(clips = []) {
  globalThis.window = {
    innerWidth: 1600,
    innerHeight: 900,
    xleth: {
      timeline: {
        getClips: vi.fn(async () => clips),
        setClipModulation: vi.fn(async (clipId, modulation) => ({ id: clipId, modulation })),
      },
    },
  }
}

const CLIP = (id, vibrato = {}, scratch = {}) => ({
  id,
  durationTicks: 7680,
  modulation: {
    enabled: true,
    vibrato: { enabled: true, shape: 'sine', ...vibrato },
    scratch: {
      enabled: true,
      timeMode: 'clipPercent',
      smoothingMs: 2,
      edgeMode: 'clamp',
      curve: [
        { time: 0, rateMultiplier: 1, curve: 0 },
        { time: 1, rateMultiplier: 1, curve: 0 },
      ],
      ...scratch,
    },
  },
})

describe('ClipFxEditorHost ownership contract', () => {
  beforeEach(() => {
    vi.resetModules()
    installWindow([CLIP(12), CLIP(14)])
  })

  afterEach(() => {
    delete globalThis.window
  })

  it('mounts every per-clip FX editor at the global host', async () => {
    const { default: ClipFxEditorHost } = await import('../ClipFxEditorHost.jsx')
    const { default: ClipVibratoEditorPanel } = await import('../ClipVibratoEditorPanel.jsx')
    const { default: ClipScratchEditorPanel } = await import('../ClipScratchEditorPanel.jsx')

    const tree = ClipFxEditorHost()   // hookless — safe to invoke directly
    expect(tree.props.className).toBe('clip-fx-editor-host')

    const owned = collectOwnedComponents(tree.props.children)
    expect(owned).toHaveLength(2)
    expect(owned.every((type) => typeof type === 'function')).toBe(true)
    expect(owned).toContain(ClipVibratoEditorPanel)
    expect(owned).toContain(ClipScratchEditorPanel)
  })

  it('does NOT mount any clip FX editor inside TimelineView (anti-nesting guard)', () => {
    // TimelineView must not own editor DOM: if it did, a floating Timeline's
    // transform would clip the editor. Guard against any editor panel being
    // re-introduced into TimelineView's module/JSX.
    const timelineSource = readFileSync(resolve(COMPONENTS_DIR, 'TimelineView.jsx'), 'utf8')
    const editorPanels = ['ClipVibratoEditorPanel', 'ClipScratchEditorPanel', 'ClipFxEditorHost']
    for (const panel of editorPanels) {
      expect(timelineSource).not.toMatch(new RegExp(`import\\s+${panel}\\b`))
      expect(timelineSource).not.toMatch(new RegExp(`<${panel}\\b`))
    }

    // ...they live in the global host instead...
    const hostSource = readFileSync(resolve(TIMELINE_DIR, 'ClipFxEditorHost.jsx'), 'utf8')
    expect(hostSource).toMatch(/<ClipVibratoEditorPanel\b/)
    expect(hostSource).toMatch(/<ClipScratchEditorPanel\b/)

    // ...and that host is mounted by the windowing AppShell, outside every
    // PanelFrame subtree, exactly like EffectEditorHost.
    const shellSource = readFileSync(resolve(WINDOWING_DIR, 'AppShell.tsx'), 'utf8')
    expect(shellSource).toMatch(/import\s+ClipFxEditorHost\b/)
    expect(shellSource).toMatch(/<ClipFxEditorHost\s*\/>/)
  })

  it('the clip dropdown launcher opens the editor with the clip identity', async () => {
    const { default: useClipVibratoEditorStore } = await import('../../../stores/clipVibratoEditorStore.js')
    const { openClipFxEditor } = await import('../clipFxEditorOpeners.js')

    const opened = openClipFxEditor('vibrato', 14)

    expect(opened).toEqual({ ok: true, kind: 'vibrato' })
    expect(useClipVibratoEditorStore.getState().target).toEqual({ clipId: 14 })
  })

  it('the clip dropdown launcher opens the Scratch editor with the clip identity', async () => {
    const { default: useClipScratchEditorStore } = await import('../../../stores/clipScratchEditorStore.js')
    const { openClipFxEditor } = await import('../clipFxEditorOpeners.js')

    const opened = openClipFxEditor('scratch', 14)

    expect(opened).toEqual({ ok: true, kind: 'scratch' })
    expect(useClipScratchEditorStore.getState().target).toEqual({ clipId: 14 })
  })

  it('refuses to open for an unresolved clip or an unknown editor kind', async () => {
    const { openClipFxEditor } = await import('../clipFxEditorOpeners.js')

    expect(openClipFxEditor('vibrato', -1)).toEqual({ ok: false, reason: 'clip_unresolved' })
    expect(openClipFxEditor('vibrato', undefined)).toEqual({ ok: false, reason: 'clip_unresolved' })
    expect(openClipFxEditor('scratch', -1)).toEqual({ ok: false, reason: 'clip_unresolved' })
    expect(openClipFxEditor('reverb', 14)).toEqual({ ok: false, reason: 'unknown_editor' })
  })

  it('closes an editor orphaned by its clip being deleted', async () => {
    const { default: useClipVibratoEditorStore } = await import('../../../stores/clipVibratoEditorStore.js')
    const { default: useClipScratchEditorStore } = await import('../../../stores/clipScratchEditorStore.js')
    const { openClipFxEditor, closeClipFxEditorForClip } = await import('../clipFxEditorOpeners.js')

    openClipFxEditor('vibrato', 14)
    openClipFxEditor('scratch', 14)
    // An unrelated clip's deletion must leave both editors open.
    expect(closeClipFxEditorForClip(12)).toBe(false)
    expect(useClipVibratoEditorStore.getState().target).toEqual({ clipId: 14 })
    expect(useClipScratchEditorStore.getState().target).toEqual({ clipId: 14 })

    expect(closeClipFxEditorForClip(14)).toBe(true)
    expect(useClipVibratoEditorStore.getState().target).toBeNull()
    expect(useClipScratchEditorStore.getState().target).toBeNull()
  })

  it('closes only the editor whose own clip died', async () => {
    const { default: useClipVibratoEditorStore } = await import('../../../stores/clipVibratoEditorStore.js')
    const { default: useClipScratchEditorStore } = await import('../../../stores/clipScratchEditorStore.js')
    const { openClipFxEditor, closeClipFxEditorForClip } = await import('../clipFxEditorOpeners.js')

    openClipFxEditor('vibrato', 12)
    openClipFxEditor('scratch', 14)

    expect(closeClipFxEditorForClip(14)).toBe(true)
    expect(useClipScratchEditorStore.getState().target).toBeNull()
    expect(useClipVibratoEditorStore.getState().target).toEqual({ clipId: 12 })
  })

  it('reconciles open editors against the live clip list', async () => {
    const { default: useClipVibratoEditorStore } = await import('../../../stores/clipVibratoEditorStore.js')
    const { default: useClipScratchEditorStore } = await import('../../../stores/clipScratchEditorStore.js')
    const { openClipFxEditor, reconcileClipFxEditors } = await import('../clipFxEditorOpeners.js')

    openClipFxEditor('vibrato', 14)
    openClipFxEditor('scratch', 14)

    // Still present -> left alone.
    expect(reconcileClipFxEditors([CLIP(12), CLIP(14)])).toBe(false)
    expect(useClipVibratoEditorStore.getState().target).toEqual({ clipId: 14 })
    expect(useClipScratchEditorStore.getState().target).toEqual({ clipId: 14 })

    // An empty list means "engine not ready", never "everything was deleted".
    expect(reconcileClipFxEditors([])).toBe(false)
    expect(reconcileClipFxEditors(undefined)).toBe(false)
    expect(useClipVibratoEditorStore.getState().target).toEqual({ clipId: 14 })
    expect(useClipScratchEditorStore.getState().target).toEqual({ clipId: 14 })

    // Gone from a populated list -> closed.
    expect(reconcileClipFxEditors([CLIP(12)])).toBe(true)
    expect(useClipVibratoEditorStore.getState().target).toBeNull()
    expect(useClipScratchEditorStore.getState().target).toBeNull()
  })

  it('closes every editor on project load (clip ids are reassigned)', async () => {
    const { default: useClipVibratoEditorStore } = await import('../../../stores/clipVibratoEditorStore.js')
    const { default: useClipScratchEditorStore } = await import('../../../stores/clipScratchEditorStore.js')
    const { openClipFxEditor, closeAllClipFxEditors } = await import('../clipFxEditorOpeners.js')

    openClipFxEditor('vibrato', 14)
    openClipFxEditor('scratch', 12)
    closeAllClipFxEditors()
    expect(useClipVibratoEditorStore.getState().target).toBeNull()
    expect(useClipScratchEditorStore.getState().target).toBeNull()
  })

  it('TimelineView wires both orphan paths through the shared openers module', () => {
    const timelineSource = readFileSync(resolve(COMPONENTS_DIR, 'TimelineView.jsx'), 'utf8')
    expect(timelineSource).toMatch(/from '\.\/timeline\/clipFxEditorOpeners\.js'/)
    // fetchClips reconciles every deletion route; project load closes all.
    expect(timelineSource).toMatch(/reconcileClipFxEditors\(normalized\)/)
    expect(timelineSource).toMatch(/closeAllClipFxEditors\(\)/)
  })
})

describe('ClipVibratoEditorPanel write path', () => {
  beforeEach(() => {
    vi.resetModules()
    installWindow([CLIP(14, { depthCents: 50, customShape: [] })])
  })

  afterEach(() => {
    delete globalThis.window
  })

  it('never writes to the engine during a point drag, and commits exactly once on release', async () => {
    const { default: useClipVibratoEditorStore } = await import('../../../stores/clipVibratoEditorStore.js')
    const store = useClipVibratoEditorStore.getState()

    store.open(14)
    await Promise.resolve()
    await Promise.resolve()

    const setClipModulation = globalThis.window.xleth.timeline.setClipModulation
    setClipModulation.mockClear()

    // Simulate a drag: many preview frames...
    for (let i = 1; i <= 20; i++) {
      useClipVibratoEditorStore.getState().previewShape([
        { time: 0, value: 0 },
        { time: 0.5, value: i / 20 },
        { time: 1, value: 0 },
      ])
    }
    expect(setClipModulation).not.toHaveBeenCalled()
    expect(useClipVibratoEditorStore.getState().draftShape).not.toBeNull()

    // ...then one release.
    await useClipVibratoEditorStore.getState().commitShape([
      { time: 0, value: 0 },
      { time: 0.5, value: 1 },
      { time: 1, value: 0 },
    ])

    expect(setClipModulation).toHaveBeenCalledTimes(1)
    const [clipId, merged] = setClipModulation.mock.calls[0]
    expect(clipId).toBe(14)
    expect(merged.vibrato.customShape).toEqual([
      { time: 0, value: 0 },
      { time: 0.5, value: 1 },
      { time: 1, value: 0 },
    ])
    // The merge preserved the scalars the dropdown owns.
    expect(merged.vibrato.depthCents).toBe(50)
    // Draft cleared once the engine has the value.
    expect(useClipVibratoEditorStore.getState().draftShape).toBeNull()
  })

  it('goes through mergeClipModulationPatch rather than a parallel write path', async () => {
    const storeSource = readFileSync(
      resolve(COMPONENTS_DIR, '..', 'stores', 'clipVibratoEditorStore.js'), 'utf8',
    )
    expect(storeSource).toMatch(/mergeClipModulationPatch/)
    expect(storeSource).toMatch(/setClipModulation/)
    // The one shared merge helper, not a local re-implementation.
    expect(storeSource).toMatch(/from '\.\.\/components\/timeline\/clipModulationPatch\.js'/)
  })
})

describe('ClipScratchEditorPanel write path', () => {
  beforeEach(() => {
    vi.resetModules()
    installWindow([CLIP(14, {}, { smoothingMs: 7, gainCompensationDb: -3 })])
  })

  afterEach(() => {
    delete globalThis.window
  })

  it('never writes to the engine during a curve drag, and commits exactly once on release', async () => {
    const { default: useClipScratchEditorStore } = await import('../../../stores/clipScratchEditorStore.js')
    const store = useClipScratchEditorStore.getState()

    store.open(14)
    await Promise.resolve()
    await Promise.resolve()

    const setClipModulation = globalThis.window.xleth.timeline.setClipModulation
    setClipModulation.mockClear()

    // Simulate a drag: many preview frames...
    for (let i = 1; i <= 20; i++) {
      useClipScratchEditorStore.getState().previewCurve([
        { time: 0, rateMultiplier: 1, tension: 0 },
        { time: 0.5, rateMultiplier: -i / 20, tension: 0 },
        { time: 1, rateMultiplier: 1, tension: 0 },
      ])
    }
    expect(setClipModulation).not.toHaveBeenCalled()
    expect(useClipScratchEditorStore.getState().draftCurve).not.toBeNull()

    // ...then one release.
    await useClipScratchEditorStore.getState().commitCurve([
      { time: 0, rateMultiplier: 1, tension: 0 },
      { time: 0.5, rateMultiplier: -1, tension: 0 },
      { time: 1, rateMultiplier: 1, tension: 0 },
    ])

    expect(setClipModulation).toHaveBeenCalledTimes(1)
    const [clipId, merged] = setClipModulation.mock.calls[0]
    expect(clipId).toBe(14)
    // Author points are baked to the engine's `{ time, rateMultiplier, curve }`.
    expect(merged.scratch.curve).toEqual([
      { time: 0, rateMultiplier: 1, curve: 0 },
      { time: 0.5, rateMultiplier: -1, curve: 0 },
      { time: 1, rateMultiplier: 1, curve: 0 },
    ])
    // The merge preserved the scalars the dropdown owns.
    expect(merged.scratch.smoothingMs).toBe(7)
    expect(merged.scratch.gainCompensationDb).toBe(-3)
    // Draft cleared once the engine has the value.
    expect(useClipScratchEditorStore.getState().draftCurve).toBeNull()
  })

  it('bakes a tensioned segment into real breakpoints on commit', async () => {
    const { default: useClipScratchEditorStore } = await import('../../../stores/clipScratchEditorStore.js')
    const { SCRATCH_BAKE_SEGMENTS, unbakeScratchCurve } = await import('../clipScratch.js')

    useClipScratchEditorStore.getState().open(14)
    await Promise.resolve()
    await Promise.resolve()

    const setClipModulation = globalThis.window.xleth.timeline.setClipModulation
    setClipModulation.mockClear()

    await useClipScratchEditorStore.getState().commitCurve([
      { time: 0, rateMultiplier: 1, tension: 0.6 },
      { time: 1, rateMultiplier: 0, tension: 0 },
    ])

    expect(setClipModulation).toHaveBeenCalledTimes(1)
    const merged = setClipModulation.mock.calls[0][1]
    // The engine plays straight lines, so the bend must BE straight lines.
    expect(merged.scratch.curve).toHaveLength(SCRATCH_BAKE_SEGMENTS + 1)
    // ...and the editor can read its own tension back out again.
    const recovered = unbakeScratchCurve(merged.scratch.curve)
    expect(recovered).toHaveLength(2)
    expect(recovered[0].tension).toBeCloseTo(0.6, 4)
  })

  it('round-trips the edge modes the dropdown used to hide', async () => {
    const { default: useClipScratchEditorStore } = await import('../../../stores/clipScratchEditorStore.js')
    useClipScratchEditorStore.getState().open(14)
    await Promise.resolve()
    await Promise.resolve()

    const setClipModulation = globalThis.window.xleth.timeline.setClipModulation
    for (const edgeMode of ['wrap', 'pingPong']) {
      setClipModulation.mockClear()
      await useClipScratchEditorStore.getState().commitScratch({ edgeMode })
      expect(setClipModulation.mock.calls[0][1].scratch.edgeMode).toBe(edgeMode)
    }

    setClipModulation.mockClear()
    await useClipScratchEditorStore.getState().commitScratch({ gainCompensationDb: 6 })
    expect(setClipModulation.mock.calls[0][1].scratch.gainCompensationDb).toBe(6)
  })

  it('stamps a preset as ONE commit carrying both the points and its time mode', async () => {
    const { default: useClipScratchEditorStore } = await import('../../../stores/clipScratchEditorStore.js')
    const { scratchPresetPatch, scratchPresetKeyForScratch } = await import('../clipScratch.js')

    useClipScratchEditorStore.getState().open(14)
    await Promise.resolve()
    await Promise.resolve()

    const setClipModulation = globalThis.window.xleth.timeline.setClipModulation
    setClipModulation.mockClear()

    await useClipScratchEditorStore.getState().commitScratch(
      scratchPresetPatch('babyScratch', { scratchCount: 3, lengthBeats: 0.5 }),
    )

    expect(setClipModulation).toHaveBeenCalledTimes(1)
    const merged = setClipModulation.mock.calls[0][1].scratch
    expect(merged.timeMode).toBe('beats')
    expect(scratchPresetKeyForScratch(merged)).toBe('babyScratch')
  })

  it('goes through mergeClipModulationPatch rather than a parallel write path', () => {
    const storeSource = readFileSync(
      resolve(COMPONENTS_DIR, '..', 'stores', 'clipScratchEditorStore.js'), 'utf8',
    )
    expect(storeSource).toMatch(/mergeClipModulationPatch/)
    expect(storeSource).toMatch(/setClipModulation/)
    // The one shared merge helper, not a local re-implementation.
    expect(storeSource).toMatch(/from '\.\.\/components\/timeline\/clipModulationPatch\.js'/)
  })

  it('the Scratch section (in the Inspector since Phase 3) launches the graph editor', () => {
    const inspectorSource = readFileSync(resolve(COMPONENTS_DIR, 'inspector', 'ClipInspector.jsx'), 'utf8')
    expect(inspectorSource).toMatch(/openClipFxEditor\('scratch', clipId\)/)
    expect(inspectorSource).toMatch(/from '\.\.\/timeline\/clipScratch\.js'/)
    const timelineSource = readFileSync(resolve(COMPONENTS_DIR, 'TimelineView.jsx'), 'utf8')
    // ...and the preset vocabulary is shared with the editor, not duplicated.
    expect(timelineSource).toMatch(/from '\.\/timeline\/clipScratch\.js'/)
    expect(timelineSource).not.toMatch(/^const SCRATCH_PRESETS = \[/m)
    expect(timelineSource).not.toMatch(/^function generateBabyScratchCurve\b/m)
  })
})
