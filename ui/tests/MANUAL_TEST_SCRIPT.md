# Manual test script: the checks that need the engine and a human

Phase 8 verified everything that can be verified without the engine (render harness, populated-shell
audit with a fake engine, unit tests). This script is the rest: the DAW Floor items that need live audio,
live video and real scrolling. Run it on a machine with a fresh `xleth_native.node` (see
`tests/baseline/MANUAL.md`, "Before you run it"), at 1920x1080, UI scale 100 %, default (dark) theme unless a
step says otherwise. Record results in the table at the end.

Developer tools: launch with `npm run dev` (the dev build opens DevTools with Ctrl+Shift+I). Console
snippets below are paste-ready.

---

## 1. Track-count test (1080p)

Goal: a 1080p screen shows at least 12 arrangement tracks at default height, and a full 16-step pattern
without scrolling.

1. Open a project with 20 or more tracks (add clip tracks with the "+" at the bottom of the track list).
2. Collapse the detail dock (click the open dock tab). Leave Preview and Inspector as they are.
3. Paste in the console:

```js
(() => {
  const area = document.querySelector('.timeline-canvas-container, .timeline-view') ?? document.body
  const a = area.getBoundingClientRect()
  const rows = [...document.querySelectorAll('.track-header')].filter((h) => {
    const r = h.getBoundingClientRect()
    return r.top >= a.top - 1 && r.bottom <= a.bottom + 1
  })
  console.table({ visibleTracks: rows.length, trackPx: rows[0]?.getBoundingClientRect().height, viewportPx: Math.round(a.height) })
})()
```

4. **Pass:** `visibleTracks` is 12 or more with the dock collapsed. Note the number with the dock open (304 px)
   as well; it will be much lower, and that is the trade the layout makes.
5. Open a Pattern track's piano roll and confirm all 16 steps of a bar are visible without scrolling.

## 2. Stress test: 2,000 notes, 32 metered tracks, scrolling while playing

Goal: 60 fps with 2,000 notes on screen and 32 metered tracks, scrolling while playing, no dropped frames and
no audio glitches.

Setup:

1. Make the dense MIDI file: `cd ui && node tests/fixture/make-stress-midi.mjs 2000 stress-2000.mid`
   (2,000 notes, about 100 bars, overlapping dyads, varied velocity).
2. New project. Import the file (File > Import MIDI) onto a Pattern track and a sample for it.
3. Add 31 more tracks (clip and pattern mix) each with a sound source so every mixer strip meters. You need 32
   strips that are actually receiving signal, not silent.
4. Open Mixer (detail dock). Open the Piano Roll on the dense pattern so the 2,000 notes are in view
   (zoom out until most of them are on screen).
5. Detail dock: Devices tab, then Mixer tab, both with 32 strips scrolling.

Frame-time probe (paste in the console, then press Play and work for 20 s):

```js
(() => {
  const dt = []; let last = performance.now(); let stop = false
  const tick = (t) => { dt.push(t - last); last = t; if (!stop) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  setTimeout(() => {
    stop = true
    const d = dt.slice(10).sort((a, b) => a - b)
    const p = (q) => d[Math.floor(d.length * q)].toFixed(1)
    const dropped = d.filter((x) => x > 25).length
    console.table({ frames: d.length, p50ms: p(0.5), p95ms: p(0.95), p99ms: p(0.99), over25ms: dropped, over25pct: (100 * dropped / d.length).toFixed(2) })
  }, 20000)
})()
```

Do these during the 20 seconds, with playback running:

- Scroll the arrangement horizontally and vertically (wheel and middle-drag).
- Zoom the timeline with Ctrl+wheel.
- Scroll the mixer strips sideways.
- Drag the playhead once, then let it run.

**Pass:** p95 is 17 ms or less (60 fps), `over25pct` is under 1 %. There is no stutter you can see on the
playhead or meters.

Audio: Settings > Audio Diagnostics. Start a capture, repeat the scrolling for 60 s, stop. **Pass:** no
underruns / xruns and no deadline misses reported. Listen for clicks the whole time; one audible glitch is a fail.

Repeat once with the Preview playing video, and once at UI scale 150 % (Settings > Appearance).

Nothing renders one DOM node per note or per step. To check: in the console run
`document.querySelectorAll('[data-note], .piano-roll-note').length` with the roll open; **pass:** 0, because
notes are drawn on canvas (any large number means a regression).

## 3. Keyboard-only pass

Put the mouse away. Tab order and visible focus must reach everything; no keyboard trap.

1. Tab from the top bar: menus, transport, panel toggles, window controls. Each shows a focus ring (1 px cyan
   outline). Arrow keys move within the menu bar and the panel-toggle row.
2. Open a menu with Enter, move with the arrows, choose with Enter, close with Escape: focus returns to the
   trigger.
3. Detail dock: Left / Right move between tabs, Enter opens, and the tab's panel is reachable by Tab.
4. Devices tab: Tab through every control of the Compressor device. For each knob or number box: arrow keys
   nudge, Shift + arrows is x10, Enter or F2 opens the type-in field, type a value, Enter commits, Escape
   cancels. (Home and End are deliberately not bound on controls: Home is the app's rewind.)
5. Context menus: try to open a track header's context menu from the keyboard (Menu key or Shift+F10). Once
   open, arrows move, Enter picks, Escape closes and focus returns. **Open question:** the menu itself is fully
   keyboard-operable, but nothing in the code binds a keyboard way to open it (right-click is the opener).
   If the Menu key does nothing, record it as a Floor gap rather than a test failure.
6. Dialogs: File > Export as ZIP. Focus lands inside the dialog, Tab cycles inside it (never leaves), Escape
   closes it (not while exporting), focus returns to the menu item.
7. Transport: Space plays and stops; the shortcuts in the hint bar work with no mouse.

**Pass:** every step completes; nothing needs the mouse; focus is always visible.

## 4. Screen-reader names (one device)

Use Narrator (Win + Ctrl + Enter) or NVDA. Open the Compressor in the Devices tab.

1. Tab to the Threshold knob. **Expected announcement:** "Threshold, -18.0 dB" (the kit slider name plus its
   value with unit), role slider.
2. Tab to Attack, Release, Ratio: each is "name, value unit".
3. Tab to the bypass activator: it announces its name and on / off state, and bypassed devices are announced as
   Off (not only dimmed).
4. Tab to the title bar controls: Fold, Name (reorder), Preset, A/B, More, Pop out each have a name.
5. Open the Mixer: a strip announces its track name, and mute / solo / volume controls announce state.

**Pass:** no control is announced as just "button" or "slider" with no name; values include their unit.

## 5. Other items that need the engine

| Check | How | Pass |
|---|---|---|
| Meters in dB with peak hold and clip latch | Play a loud source through a strip | printed dB scale, peak hold holds, clip LED latches until clicked |
| Displays driven by real audio | Compressor GR trace, EQ spectrum, with and without signal | animated only with signal; idle and empty without it (nothing fabricated) |
| Mute / solo / bypass at rest | Mute a track, bypass a device | dimmed content plus a glyph, not colour alone |
| Every edit undoable | Move a clip, a mixer fader, a device in a chain; Ctrl+Z | known gap: stock-effect parameters and chain moves have no engine undo (DESIGN.md section 9) |
| Sample picker sheet | Import a source, double-click it | sheet over Preview + Inspector; arrangement and transport stay live; Space is the transport's again outside the sheet |

## Results

| Test | Date | Machine | Result | Notes |
|---|---|---|---|---|
| 1. Track count (dock collapsed) | | | | tracks visible: |
| 1. Track count (dock open) | | | | tracks visible: |
| 2. Stress: p95 / over25pct | | | | |
| 2. Stress: audio glitches | | | | |
| 2. Stress at 150 % | | | | |
| 3. Keyboard-only | | | | |
| 4. Screen reader | | | | |
