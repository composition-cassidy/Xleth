/**
 * @vitest-environment jsdom
 *
 * The Sampler shell and its Sample view, mounted for real against a stubbed
 * bridge. Each control is driven with the kit's keyboard grammar (arrows nudge,
 * Enter types) and the assertion reads the captured IPC payload, so the test
 * proves the exact call the old control made still goes out.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness, makeSlot, stubCanvas } from './samplerHarness.jsx'

const h = createHarness()

beforeEach(() => {
  stubCanvas()
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(async () => { await h.unmount(); vi.unstubAllGlobals() })

describe('Sampler header', () => {
  it('has slot tabs, the patch control and sentence-case view tabs', async () => {
    await h.mount([makeSlot(), makeSlot({ name: 'Second' })])
    const slots = h.container.querySelector('[role="tablist"][aria-label="Sample slots"]')
    expect(slots).toBeTruthy()
    expect([...slots.querySelectorAll('[role="tab"]')].map((t) => t.getAttribute('aria-label')))
      .toEqual(['Slot 1: Layer 1', 'Slot 2: Second'])
    const views = h.container.querySelector('[role="tablist"][aria-label="Sampler views"]')
    expect([...views.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim())).toEqual(['Sample', 'Envelope', 'Playback', 'Modulation'])
    expect(h.container.querySelector('[aria-label="Sampler patch"]')).toBeTruthy()
  })

  it('a silent slot says so in its name, not by colour alone', async () => {
    await h.mount([makeSlot(), makeSlot({ name: 'Muted', mute: true })])
    const tab = h.container.querySelector('[role="tab"][aria-label^="Slot 2"]')
    expect(tab.getAttribute('aria-label')).toBe('Slot 2: Muted (silent)')
    expect(tab.getAttribute('data-silent')).toBe('true')
  })

  it('the slot bar (level, pitch, mute, solo, menu) stays in every view', async () => {
    await h.mount()
    for (const view of ['Sample', 'Envelope', 'Playback', 'Modulation']) {
      await h.view(view)
      const bar = h.container.querySelector('[role="group"][aria-label^="Slot 1 level and pitch"]')
      expect(bar, view).toBeTruthy()
      expect([...bar.querySelectorAll('[role="slider"]')].map((b) => b.getAttribute('aria-label')), view)
        .toEqual(['Volume', 'Pan', 'Root', 'Octave', 'Semi', 'Fine', 'Coarse'])
      // Mute and solo are one output pearl (click = on/off, right-click = solo).
      expect(bar.querySelector('[aria-label="Slot 1 output"]'), view).toBeTruthy()
      expect(bar.querySelector('[aria-label="Slot 1 actions"]'), view).toBeTruthy()
    }
  })

  it('selecting a slot rebinds the slot bar and the Sample view to that layer', async () => {
    await h.mount([makeSlot({ semitone: 0 }), makeSlot({ name: 'Two', semitone: -5 })])
    expect(h.slider('Semi').getAttribute('aria-valuenow')).toBe('0')
    const tab = h.container.querySelector('[role="tab"][aria-label^="Slot 2"]')
    await act(async () => { tab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    await h.settle()
    expect(h.slider('Semi').getAttribute('aria-valuenow')).toBe('-5')
  })
})

describe('Sample view layout', () => {
  it('puts what is drawn on the waveform first: Trim and Loop, then Mode, Time stretch, Process', async () => {
    await h.mount()
    const order = [...h.container.querySelectorAll('[data-view="main"] [data-section]')].map((e) => e.getAttribute('data-section'))
    expect(order).toEqual(['trim', 'loop', 'mode', 'prep', 'process'])
    const titles = [...h.container.querySelectorAll('[data-view="main"] [data-section] [role="heading"]')]
      .map((e) => e.firstChild.textContent.trim())
    expect(titles).toEqual(['Trim', 'Loop', 'Mode', 'Time stretch', 'Process'])
  })

  it('names the loaded file over the waveform and offers Replace there', async () => {
    await h.mount()
    const head = h.container.querySelector('[data-view="main"] [role="toolbar"][aria-label="Waveform view"]').parentElement
    expect(head.textContent).toContain('x.wav')
    await h.click(h.container.querySelector('[data-field="replaceAudio"]'))
    // The stubbed picker returns no file, so nothing is swapped: the click only has to reach it.
    expect(h.calls.some((c) => c.name === 'swapRegionAudio')).toBe(false)
  })

  it('labels crossfadeEnabled by what it does (One-shot / Sustained), never as a crossfade toggle', async () => {
    await h.mount()
    const labels = await h.options('crossfadeEnabled')
    expect(labels).toEqual(['One-shot', 'Sustained'])
    expect(h.container.querySelector('[data-field="crossfadeEnabled"]').getAttribute('aria-label')).toBe('Notes')
  })

  it('shows every value with its unit, and no inline font styling', async () => {
    await h.mount()
    expect(h.slider('Semi').getAttribute('aria-valuetext')).toBe('Semi, 0 st')
    expect(h.slider('Fine').getAttribute('aria-valuetext')).toBe('Fine, 0 ct')
    expect(h.slider('Volume').getAttribute('aria-valuetext')).toBe('Volume, 0.0 dB')
    expect(h.slider('Pan').getAttribute('aria-valuetext')).toBe('Pan, C')
    expect(h.slider('Root').getAttribute('aria-valuetext')).toBe('Root, C4')
    expect(h.slider('Declick').getAttribute('aria-valuetext')).toBe('Declick, 1.5 ms')
    expect(h.slider('Length').getAttribute('aria-valuetext')).toBe('Length, Full')
    for (const el of h.container.querySelectorAll('[style]')) {
      expect(el.getAttribute('style')).not.toMatch(/font-size|letter-spacing|text-transform/)
    }
  })

  it('names the sample positions in time, with the sample count in the hint', async () => {
    await h.mount([makeSlot({ smpStart: 4800 })])
    const start = h.slider('Start')
    expect(start.getAttribute('aria-valuetext')).toBe('Start, 100 ms')
    expect(start.getAttribute('data-hint')).toContain('4,800 samples')
  })
})

describe('Envelope view', () => {
  it('is the amp envelope (Env 1) on the kit editor, and a stage edit commits the modulation config', async () => {
    await h.mount([makeSlot()], {}, {
      envPresent: [true, false, false, false, false, false],
      envs: [{ tempoSync: false, attack: { ms: 10 }, decay: { ms: 100 }, release: { ms: 50 }, sustainPct: 80 }],
    })
    await h.view('Envelope')
    const view = h.container.querySelector('[data-view="envelope"]')
    expect(view.querySelector('[data-section="amp"] [role="heading"]').textContent).toContain('Amp envelope')
    expect(view.querySelector('[data-editor="env"]')).toBeTruthy()
    expect(h.slider('Sustain').getAttribute('aria-valuetext')).toMatch(/^Sustain, 80\s%$/)
    await h.key(h.slider('Sustain'), 'ArrowDown')
    expect(h.modSets.at(-1).envs[0].sustainPct).toBe(79)
  })

  it('the display is to scale and is the editor: dragging the decay point sets that stage, one commit on release', async () => {
    await h.mount([makeSlot()], {}, {
      envPresent: [true, false, false, false, false, false],
      envs: [{ tempoSync: false, attack: { ms: 10 }, decay: { ms: 100 }, release: { ms: 50 }, sustainPct: 80 }],
    })
    await h.view('Envelope')
    const canvas = h.container.querySelector('[data-env-canvas]')
    expect(canvas.getAttribute('aria-label')).toBe('Amp envelope shape, drawn to scale')
    // Span defaults to a fixed 1 s, shared by every envelope and LFO display.
    expect(h.container.querySelector('[data-mod-field="span"]').textContent).toContain('1 s')

    // jsdom has no layout: the canvas is its 460x140 fallback, so the plot is 420px wide from x = 30,
    // 44px of it the sustain break: 376 px per second. The decay point sits at 110 ms, 80 %.
    const pps = 376
    const x = 30 + 0.11 * pps
    const y = 22 + 112 * (1 - 0.8)
    const ev = (type, cx, cy) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: cx, clientY: cy })
      Object.defineProperty(e, 'pointerId', { value: 1 })
      return e
    }
    const before = h.modSets.length
    await act(async () => { canvas.dispatchEvent(ev('pointerdown', x, y)) })
    expect(canvas.getAttribute('data-active')).toBe('decay')
    await act(async () => { canvas.dispatchEvent(ev('pointermove', x + 0.1 * pps, y)) })
    // Previewed, not yet sent.
    expect(h.modSets.length).toBe(before)
    expect(h.slider('Decay').getAttribute('aria-valuenow')).toBe('200')
    await act(async () => { canvas.dispatchEvent(ev('pointerup', x + 0.1 * pps, y)) })
    await h.settle()
    expect(h.modSets.length).toBe(before + 1)
    expect(h.modSets.at(-1).envs[0].decay.ms).toBe(200)
    expect(h.modSets.at(-1).envs[0].sustainPct).toBe(80)
    // The neighbours did not move: a stage is edited alone.
    expect(h.modSets.at(-1).envs[0].attack.ms).toBe(10)
    expect(h.modSets.at(-1).envs[0].release.ms).toBe(50)
  })
})

describe('Sample view wiring (one commit per gesture, same payload as before)', () => {
  it('pitch boxes commit the whole slot list (the engine undo unit)', async () => {
    await h.mount()
    await h.key(h.slider('Semi'), 'ArrowUp')
    const c = h.lastCommit('slots')
    expect(c.payload.slots[0].semitone).toBe(1)
  })

  it('volume reads in dB and still commits linear gain', async () => {
    await h.mount([makeSlot({ volume: 2 })])
    expect(h.slider('Volume').getAttribute('aria-valuetext')).toBe('Volume, +6.0 dB')
    await h.key(h.slider('Volume'), 'ArrowDown')
    expect(h.lastCommit('slots').payload.slots[0].volume).toBeCloseTo(1.99)
  })

  it('Mode commits crossfadeEnabled', async () => {
    await h.mount()
    await h.choose('crossfadeEnabled', 'oneshot')
    expect(h.lastCommit('crossfadeEnabled').payload).toMatchObject({ crossfadeEnabled: false, slotIndex: 0 })
  })

  it('in One-shot the Loop strip says it needs Sustained', async () => {
    await h.mount([makeSlot()], { crossfadeEnabled: false })
    const loop = h.container.querySelector('[data-section="loop"]')
    expect(loop.textContent).toContain('Needs Sustained')
  })

  it('trim knobs commit sample indices on the selected slot', async () => {
    await h.mount()
    await h.key(h.slider('Fade in'), 'ArrowUp')
    expect(h.lastCommit('fadeInMs').payload.slotIndex).toBe(0)
    await h.key(h.slider('Declick'), 'ArrowUp')
    expect(h.lastCommit('declickMs').payload.declickMs).toBeCloseTo(1.6)
  })

  it('process toggles commit their flag and stay visibly on', async () => {
    await h.mount()
    const norm = h.container.querySelector('[data-field="normalized"]')
    await h.click(norm)
    expect(h.lastCommit('normalized').payload.normalized).toBe(true)
    expect(h.container.querySelector('[data-field="normalized"]').getAttribute('aria-pressed')).toBe('true')
  })

  it('loop on/off, direction and exit-on-release commit their fields', async () => {
    await h.mount()
    await h.click(h.container.querySelector('[data-field="loopEnabled"]'))
    expect(h.lastCommit('loopEnabled').payload.loopEnabled).toBe(true)
    expect(await h.options('loopMode')).toEqual(['Forward', 'Ping-pong', 'Reverse'])
    await h.choose('loopMode', 1)
    expect(h.lastCommit('loopMode').payload.loopMode).toBe(1)
    await h.choose('exitLoopOnRelease', 'exit')
    expect(h.lastCommit('exitLoopOnRelease').payload.exitLoopOnRelease).toBe(true)
  })

  it('Auto runs the engine analysis on the selected slot and remembers its result', async () => {
    await h.mount()
    await h.click(h.container.querySelector('[data-field="autoLoop"]'))
    const call = h.calls.find((c) => c.name === 'autoLoopForSelection')
    expect(call.args).toEqual([7, 0, 48000, 0])
    expect(h.calls.some((c) => c.name === 'loopTelemetry.append')).toBe(true)
    expect(h.container.querySelector('[data-field="autoLoop"]').getAttribute('data-hint')).toContain('3 of 12 candidate spans kept')
  })

  it('the root note commits per slot', async () => {
    await h.mount()
    await h.key(h.slider('Root'), 'ArrowUp')
    expect(h.lastCommit('rootNote').payload).toMatchObject({ rootNote: 61, slotIndex: 0 })
  })

  it('prep algorithm and stretch commit the prep fields', async () => {
    await h.mount()
    await h.key(h.slider('Stretch'), 'ArrowUp')
    expect(h.lastCommit('prepStretch').payload.prepStretch).toBeGreaterThan(1)
  })
})

describe('Audition bar', () => {
  it('shows the key range in tabular numerals and shifts it by octave', async () => {
    await h.mount()
    const bar = h.container.querySelector('[role="group"][aria-label="Audition"]')
    expect(bar.textContent).toContain('C4–E6')
    await h.key(h.slider('Key octave'), 'ArrowUp')
    expect(bar.textContent).toContain('C5–E7')
    expect(h.slider('Key octave').getAttribute('aria-valuetext')).toBe('Key octave, +1')
  })

  it('auditions from the computer keys at the bar velocity, and plays the root once', async () => {
    await h.mount()
    await h.key(h.slider('Velocity'), 'ArrowDown')
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', key: 'z', bubbles: true })) })
    const on = h.calls.find((c) => c.name === 'previewNote')
    expect(on.args[1]).toBe(60)
    expect(on.args[2]).toBeCloseTo(101 / 127)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyZ', key: 'z', bubbles: true })) })
    expect(h.calls.some((c) => c.name === 'previewNoteOff')).toBe(true)
    await h.click(h.container.querySelector('[data-field="playRoot"]'))
    expect(h.calls.filter((c) => c.name === 'previewNote').at(-1).args[1]).toBe(60)
  })
})
