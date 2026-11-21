# Round 3 reconciliation: SPEC.md against the renderer

Written 2026-11-11 from `ui/` at `24a9254` plus the uncommitted working tree. Brief:
`C:\Users\Krasen\Desktop\xleth-ui-reference\SPEC.md`. Contract: `ui/DESIGN.md`. Nothing but this file was changed.

Line numbers are for the **working tree**. Where a file carries uncommitted work from another session the row says
"(WIP)", because HEAD differs there.

## 0. Read this first: the tree is not what the brief assumes

SPEC section 6 says the tree holds uncommitted *engine and bridge* edits. It also holds **about 115 uncommitted `ui/`
files** from other sessions (`git status --short`), and round 3 edits the same files:

| Phase | Files it must edit that already carry someone else's uncommitted hunks |
|---|---|
| 1 | `DESIGN.md` (+115 lines), `src/styles/app.css`, `scripts/legacy-css-baseline.json`, `components/TitleBar.module.css`, `components/TransportBar.jsx`, `welcome.html`, `splash.html`, `main.js` |
| 2 | `DESIGN.md`, `components/VideoPreview.jsx`, `VideoPreview.module.css`, `components/TimelineView.jsx` |
| 3 | `mixer/MixerStrip.jsx`, `MasterStrip.jsx`, `MixerStrip.module.css`, `MixerPanel.module.css`, both mixer tests, `ui-kit/NumberBox.tsx`, `DESIGN.md` |
| 4 | `timeline/timelineDrawing.js` and its test, `TrackHeaderList.jsx` / `.module.css`, `TimelineCanvas.jsx`, `constants/timeline.js`, `DESIGN.md` |
| 5 | `components/TransportBar.jsx`, `pianoRoll/PianoRoll.jsx`, `DESIGN.md` |

Consequences:

- "Commit the files you changed by explicit path" would commit the other sessions' hunks too. Each phase has to stage a
  blob rebuilt from `HEAD` plus only its own hunks (`git hash-object -w` + `git update-index --cacheinfo`), leave the
  working tree alone, and check `git diff --cached --stat` before committing.
- `npm test`, `npm run build` and `npm run shots` run on the working tree, so they verify *HEAD + foreign WIP + the
  phase*. The committed tree (HEAD + the phase) is never built on its own. Each phase must check that its hunks name no
  symbol that exists only in the foreign WIP.
- Failures that pre-date a phase have to be told apart from its own: take a `npm test` baseline before phase 1.

## 1. Amendment by amendment

Risk is the risk of the change as the brief words it. "Does it today" is about the code, not DESIGN.md's account of it.

### A1. Wider neutral ramp

| Bullet | Files and symbols | Does the code do it today? | Conflicts | Risk |
|---|---|---|---|---|
| Dark row g0 `#0F0F0F` .. g4 `#444444`, as bases plus signed L steps | `theming/tokens/neutralRamp.ts:68-92` (`RAMPS.dark.base`, `.steps`); `theming/shipped/xleth-default.json:14-17,46,50` and the generated `xleth-warm.json` / `xleth-cool.json`; fallbacks in `ui-kit/tokens.css:18-26`; `theming/tokens/catalog.ts:209` (`--theme-text-on-accent` `#141414`) | No: `#141414 / #1B1B1B / #222222 / #2B2B2B / #3A3A3A`, steps `g2 2.745, g3 6.275, g4 12.157` | `tokens.test.ts` "resolves to the contract values from the Default base" (hard-coded hexes, line 55); "colour fallbacks equal the resolved Default theme" (243); `themes.test.ts` "base tokens equal the ramp row (one source, no drift)"; `theming/tokens/__tests__/timeline-lane-bg-token.test.ts`. All are value pins, so they move with the ramp. Steps that give the brief's hexes: `g2 4.706, g3 9.412, g4 16.471` from base `#1A1A1A` | med |
| ink-3 to about `#9A9A9A`, boundary to about `#7C7C7C` | `neutralRamp.ts:78` (`ink3 -32.941`, `boundary -44.706`) | No: `#929292`, `#747474` | None with DESIGN (3.1 fixes floors, not hexes). Computed on the new ramp: ink-3 `#9A9A9A` 6.81 / 6.19 / 5.38 / **4.56**; boundary `#7C7C7C` 4.59 / 4.17 / 3.63 / **3.07** (g0..g3). The brief's numbers are right. Steps: `ink3 -29.804`, `boundary -41.569` | low |
| **Not in the brief: two more colours fail on the new g3** | `neutralRamp.ts:81` (`recText '#F06A6E'`); `theming/shipped/xleth-cool.json` (`--theme-accent '#6490F2'`) | n/a | `themes.test.ts` "semantic and signal text colours reach 4.5:1 on every surface" and `tokens.test.ts` "rec-text also clears 4.5:1 on g3": rec-text is **4.27** on `#323232`, the cool accent is **4.16**. `#F27478` (4.61) and `#6E97F3` (4.51) pass with the same hue. Everything else passes: accent 6.68, warm 5.33, solo 6.78, signals 4.89 to 5.44, bands 5.27 to 7.04, danger 4.53 on g2 (its floor is g0..g2) | med |
| Bar lines reach 3:1 on the lane ground | `catalog.ts:639` `--theme-timeline-bar-line` `rgba(255,255,255,0.26)`; `xleth-light.json:77`; read at `timeline/timelineDrawing.js:118` | No: 2.27:1 on the new g0 | The token is an **alpha white**, not a hex, so the change is the alpha: 0.34 gives `#616161`, 3.10:1 (0.33 is 2.96). Light needs `rgba(0,0,0,0.44)` (3.09; today 0.28 is 1.95). DESIGN 3.6 and 12 record the gap as open "to keep the grid's quiet look": this reverses a recorded decision, which is what the brief asks | low |
| Light row: widen only if every floor passes; high contrast alone | `neutralRamp.ts:97-121` | n/a | **It cannot widen at the ground end.** Light's 13 semantic colours are solved to sit at about 4.5:1 on g0 `#DCDCDC`; at `#D2D2D2` they are all 4.09 to 4.24 and ink-3 is 4.42. The only free direction is g3 toward white (`#F7` to `#FA`), 3 steps. Recommendation: leave light as it is | low |
| Surface roles: g0 content bodies, g1 chrome, g2 headers, g3 controls | Mixer strip body is g1 (`mixer/MixerStrip.module.css:24`), panel g1 (`MixerPanel.module.css:11`), Browser body g1 (`windowing/components/windowing.css:383,414`), Patterns column and list bodies (module CSS), track header row g2 (`timeline/TrackHeader.module.css:15`) | Partly. Lanes, wells, meter slots and the Preview surround are already g0; strip bodies, the Browser list and the Patterns list are g1 | DESIGN 3.1 role column ("g1 panel") and 22 ("a neutral g2 row") stay true; 10 does not name the strip body tone. `windowing.css` is a legacy-layer sheet (not linted, not ratcheted) and must be edited in place there | med |
| (side effect) hexes copied outside the token system | `welcome.html:16-26`, `splash.html:25` (frozen copies of the dark ramp, DESIGN 23), `main.js:392` (`backgroundColor: '#141414'`) | n/a | All three carry foreign WIP. If they are not re-synced the splash, Welcome and the first paint are a shade lighter than the app | low |

### A2. Compose layout as the default

| Bullet | Files and symbols | Does the code do it today? | Conflicts | Risk |
|---|---|---|---|---|
| New preset `xleth-compose`: left 304 with Preview above the Browser, top empty, Inspector hidden and docked right at 280 | `windowing/presets/` (new JSON), `managers/PresetManager.ts:35-39` (`RAW_PRESETS`), `:54-58` (`LAYOUT_PRESETS`) | Presets are sparse overlays over the catalog defaults (`PresetManager.ts:64-80`), so a preset can state `inspector: { hidden: true, mode: 'docked', docked: { region: 'right' } }` and the region toggle (`TitleBarRegions.jsx:46`, `togglePanel`) then opens it docked right at `dockRegionSizes.right` (280). **Preview above the Browser is not possible today: see section 2** | DESIGN 8 diagram and 8.1 table describe the top row as the layout | **high** (the stacking) |
| `xleth-arrange` relabelled "Tiled (preview row)" | `PresetManager.ts:55` | Label is "Tiled (default)" | `App.test.jsx:333` "offers the tiled default first under View > Layouts, with honest names for the others" pins ids and labels | low |
| Fresh profiles and failed hydration get `xleth-compose`; saved layouts not migrated | `PresetManager.ts:42` `DEFAULT_PRESET_ID`; used by `XlethRoot.jsx:121` (nothing persisted), `registry/PanelRegistry.ts:964` (`resetLayout`), `managers/StatePersistence.ts:133` (layouts older than the first tiled version) | One constant decides all three | The third use *is* a migration: a pre-tiled layout would now land on Compose. That is the existing behaviour with a new target; the brief's "not migrated" holds for every tiled layout (`StatePersistence.ts:145-156` merges them untouched). `StatePersistence.test.ts:244` reads the constant, so it follows | low |
| Chrome 95 to 83: toolbar 38 to 32, cue lane 30 to 24 | `layout/shellLayout.ts:25-32`; `timeline/TimelineToolbar.module.css:11` (`height: 38px`); `timeline/SnapshotCueLane.jsx:27` (`CUE_LANE_HEIGHT = 30`); ruler `constants/timeline.js:33` (26) | No | DESIGN 22 "one 38px row (the height `shellLayout` budgets)"; 8.1 "95px chrome (toolbar 38, ruler 26, cue lane 30)". `shellLayout.test.ts` imports the constants, but its two fixed expectations ("8 rows", "7 rows") are for the top-row layout and still hold (383 and 362 px give 8 and 7 rows at 83 too). The cue lane's pin and grips keep 24px hit areas only if nothing in the lane is taller than 24: `SnapshotCueLane.module.css:84` has a 26px element | med |
| Acceptance: 13 or more rows at 1920x1080, picture 300px or wider | `shellLayout.ts:76-79` | Arithmetic holds: column A 1022, dock 409, no top row: 613 - 83 = 530 = **14 rows**. In a 1032px window (taskbar): A 974, dock 390, 584 - 83 = 501 = **13 rows**. At 1366x768: A 710, dock 320, 390 - 83 = 307 = **8 rows** (7 today) | none | low |

### A3. Mixer

| Bullet | Files and symbols | Does the code do it today? | Conflicts | Risk |
|---|---|---|---|---|
| Default width 68; number and name on two rows | `mixer/mixerUiStore.js:8-17` (`STRIP_WIDTHS`, `readStripWidthMode` defaults to `'normal'`); `MixerStrip.jsx:130-134`, `MixerStrip.module.css:59-89` | No: default 84, one 21px head row | DESIGN 10 "84 px normal, 68 px compact". A stored `'normal'` must keep meaning 84, so only the *unset* default changes. Strip floor `--strip-floor: 248px` (WIP, `MixerStrip.module.css:21`) is computed from today's rows | low |
| Inserts button becomes five 16px named rows, "+N more", a row opens Devices on that device | `MixerStrip.jsx:136-144`, `MasterStrip.jsx:65-73`, `mixerMath.js:54` (`insertLabel`) | No. Names are reachable: see section 3 | DESIGN 10 "inserts button". There is **no "selected device" in the Devices tab** (no such state in `DeviceChain`, `mixerStore` or `effectChainStore`), so "opens Devices on that device" needs a small renderer-only reveal request, or it can only open the track's chain as `openDevicesFor` does today (`MixerStrip.jsx:33-37`). Five rows cost 80px against today's 24: with the Pan / Width words gone the fader loses about 40px; at the 320px dock (1366x768) it lands near 60px, just over the 56px floor the WIP comment names | **high** |
| dB numerals once, in a left gutter and on the Master; strips keep ticks; clip latch only when latched | `ui-kit/Meter.tsx:16` (`DEFAULT_SCALE_DB`), `:139-155` (numerals and ticks are one block behind `showScale`), `:249-256` (the clip button always renders) | No. `showScale={false}` removes the ticks too, and the latch is always drawn as an outline | The kit Meter needs two additions (ticks without numerals; latch hidden until latched). DESIGN 10 "Fader + Meter (printed dB scale, peak hold, clip latch)". `Meter.module.css:1-3` documents "outline = clear, filled = clipped, so it is never colour alone": an absent box that appears filled is still not colour alone. A hidden latch must stay keyboard-reachable only while latched | med |
| "Pan" and "Width" leave the strips | `MixerStrip.jsx:162-171` (`label="Pan"`, `label="Width"`) | No. The WIP already hides them under 280px of panel height (`MixerStrip.module.css:174-178`) by CSS on the knob's first `span` | DESIGN 7 "every control shows its value and unit" still holds (values stay). The kit Knob needs a way to keep `label` as the accessible name without printing it (NumberBox has `hideLabel`) | low |
| Volume NumberBox loses its fill bar in the mixer | `ui-kit/NumberBox.tsx:122` (`.fill` always rendered) (WIP file) | No | Needs a kit prop. Gallery snapshot of NumberBox unaffected if it defaults to on | low |
| `formatValue`: explicit plus on positive gain | `ui-kit/format.ts:31-32,45-49` | **Already there**: `opts.signed` prints `+`. Nothing passes it for the mixer: NumberBox and Fader format through the unit with no `signed` | DESIGN 6 table shows no plus rule; adding it to the table is the change. Making dB signed *globally* would also mark thresholds and ceilings (always negative, so harmless) and LUFS targets (untouched, different unit); the safe scope is a `signed` prop used by the mixer's volume controls | low |
| MasterStrip uses the same tick set | `MasterStrip.jsx:87`, `Meter.tsx:16,143-148` | **Already the same set.** Both pass no `scaleDb`, so both use `DEFAULT_SCALE_DB` (which contains -6). The strips drop -6 because labels closer than 12px are skipped (`MIN_LABEL_GAP`) and the Master's meter is taller (no M/S/V or knob rows) | None. With numerals in a gutter the ticks need one shared layout, which settles it | low |
| Selected strip: outline plus header one step lighter | `MixerStrip.module.css:31-34,70` | Outline only; head is g2 | none (selection is still never fill alone) | low |
| Loudness dock: 28px rail while Off, click expands, persisted | `components/MasterLoudnessMeter.module.css:7,10` (148px), `MasterLoudnessMeter.jsx:242,285` (enabled flag in `localStorage`) | No. **The dock also hosts the strip-width switch** (`MasterLoudnessMeter.jsx:365`), so a rail needs a home for it | DESIGN 10 "Loudness dock. Off, or nothing measured: every value is '-'" | med |
| Meter fill: match 3.3 or record why not | `ui-kit/Meter.tsx:58` (`fill: tokenValue('--ui-value')`) | Uses the accent (the lavender in `02` is the user's accent) | DESIGN 3.3 "Four hues for cables, ports and meters by signal type" against 3.2 "`--ui-value`: value fills, active displays". The kit Meter is also the gain-reduction meter in the compressors (16), where the accent is right, so the audio hue has to be opt-in per meter | low |

### A4. Timeline

| Bullet | Files and symbols | Does the code do it today? | Conflicts | Risk |
|---|---|---|---|---|
| Name gets 120px or more of the column; "..." leaves the resting row | `timeline/TrackHeader.jsx:139-148`, `TrackHeader.module.css:9-13,155-172`, `constants/timeline.js:36` (`HEADER_WIDTH = 212`, not 211) | No: the name cell is 62px (212 - 10 padding - 24 chip - 76 toggles - 24 menu - 16 gaps) | **120px is not reachable at 212.** Three 24px toggles and the 24px chip are hit-area floors (DESIGN 1, 5): 212 - 72 - 24 = 116 with every gap at zero. Removing the menu gives 90; tightening gaps and tucking the chip against the stripe gives about 104. 120 needs the column at 228. `TrackHeader.test.jsx` asserts the menu button | med |
| Pattern blocks: no hatch; title strip + low-lightness identity body + notes | `timelineDrawing.js:880-889` (hatch constants), `:907-926` (`drawPatternHatch`), `:1926-1932` (the call in `paintPatternBlock`) (WIP file) | No. The shared painters the brief asks for already exist (`paintTitleStrip`, `paintInsetBorder`, `paintPatternNotes`, DESIGN 25) | `timelineDrawing.blocks.test.js` exercises the block painters; DESIGN 25 does not mention the hatch | low |
| Neutralise `--theme-timeline-pattern-lane-tint` | `catalog.ts:653` (`rgba(106, 169, 255, 0.07)`), `xleth-light.json:86` (`rgba(0, 40, 120, 0.04)`); painted at `timelineDrawing.js:260-269` | No. It is defined in **two** places only: Default, warm, cool and high contrast inherit the catalog value | `themes.test.ts` "chrome is neutral" does not list this token (so nothing caught it); add it there. DESIGN 3.6 claims panel-local tints are neutral in every theme | low |
| Bar-group shading every 4 bars, every bar above about 600px per group | `timelineDrawing.js:253` (`drawGrid`), new token | No | DESIGN 25 "Repaints" (grid layer only) is compatible. New catalog token, per ramp | med |
| Ruler: every 4th bar `--type-12` ink, others `--type-10` ink-3 | `timelineDrawing.js:418-500` (`drawRuler`; numerals at `600 9px` in `--theme-text-placeholder`) | No. Today's numerals are **9px, under the 10px Floor** (DESIGN 1) | `timelineDrawing.chrome.test.js` | low |
| Patterns rows: edge in the pattern's colour, mini preview, steps to the hint | `timeline/PatternListPanel.jsx:25,217` (`PATTERN_ACCENT = 'var(--theme-drag-preview-default)'`), `:238` (`patternStepsLabel`), `PatternListPanel.module.css` | No | **A pattern has no colour of its own** in the data. The only colour derivable is the Piano Roll's rule (DESIGN 15: the track of the pattern's first block, else the value colour). DESIGN 22 "the length in steps with the unit"; `TimelineToolbarAndPatterns.test.jsx` asserts the steps text | med |
| Zoom readout in bars visible | `timeline/TimelineToolbar.jsx:199-201` | No (`{ppb} px/beat`) | DESIGN 22 "a tabular `40 px/beat`"; same test file. The toolbar needs the lane viewport width, which it is not given today | low |

### A5. Dock tabs never dead-end

| Bullet | Files and symbols | Does the code do it today? | Conflicts | Risk |
|---|---|---|---|---|
| Piano Roll with no pattern: the most recently edited, else the first | `windowing/panels/PianoRollPanel.tsx:9,54`, `stores/usePianoRollStore.js:8,18-39,64`, `XlethRootContext` (`availablePatterns`) | No. `patternId` starts `null`; nothing records "most recently edited" | DESIGN 15 "No pattern ... the panel shows the kit EmptyState"; audit phase p01 shoots 04 with no pattern open. `PianoRollPanel.tsx:24` sets `patternId` to null on close, which would immediately re-open one: closing must keep meaning closed. Opening through the `open-piano-roll` event also switches the centre tab (`usePianoRollStore.js:39`), so the fallback must set the id only, never dispatch that event (Prompt 5: no tab switching, no focus stealing) | med |
| Sampler: the open pattern's sampler, else the last sample used | `windowing/panels/SamplerWindowPanel.tsx:15,23-27` (`regionId` from `openPanel('sampler', { regionId })` props, not persisted) | No. A pattern's region is `pattern.regionId` (`pianoRoll/PianoRoll.jsx:320`), so the first half is derivable; "last sample used" needs a remembered id | DESIGN 14 says the Sampler is "opened ... by Sampler settings in the Piano Roll" | low |
| Renderer state only | above | n/a | none | low |

### A6. Quiet on-state

| Bullet | Files and symbols | Does the code do it today? | Conflicts | Risk |
|---|---|---|---|---|
| Region toggles and the tempo lock: g3 fill, ink glyph when on | `components/TitleBarRegions.jsx:40-49,56-65` (four `IconButton pressed`), `components/TransportBar.jsx:236-247` (tempo lock, `IconButton pressed`) (WIP), `ui-kit/Button.module.css:94-98` (`.btn[aria-pressed="true"]` is the inverted chip) | No | These are kit **IconButtons, not Toggles**; the variant belongs on the shared button class both use. DESIGN 1 "the toggle chip is the real separator" and 3.2 "`--ui-on` ... toggles that are on" need the carve-out written in. g3 on the top bar's g2 is 1.2:1, so the fill alone is not a state signal: the on-state also needs the 3:1 boundary outline (off is a borderless ghost), and the lock already swaps its glyph. The bar has two more pressed chips the brief does not name, metronome and auto-scroll (`TransportBar.jsx:252-271`); auto-scroll is on by default | low |

### A7. Top bar readout

| Bullet | Files and symbols | Does the code do it today? | Conflicts | Risk |
|---|---|---|---|---|
| Time and bars.beats at `--type-16` mono | `components/TransportBar.module.css:37-50` (`.readout`, `--type-13`, 24px well) | No | DESIGN 4 scale: 16 is "panel and dialog title"; a transport readout at 16 is a new use to record. The 36px bar holds it | low |
| Master peak mini-meter if the level is already in the snapshot | `mixer/meterTelemetry.js:89-98`, `mixer/mixerMeterBus.js:36,34-39` | The level is there: see section 4. The feed is not always running | see section 4 | med |

## 2. A2 in detail

**How a region stacks two panels.** `DockRegion` (`windowing/components/DockRegion.tsx:288`) renders the visible docked
panels of one region as *slots* in `orderInRegion` order (`registry/PanelRegistry.ts:261-290`, `getRegionSlots`). The
main axis is vertical for `left` and `right` and horizontal for `top`, `bottom` and `center` (`DockRegion.tsx:114-117`).
Each slot is `flex: 0 0 var(--xleth-docked-panel-size)` from its `sizeInRegion`
(`windowing.css:149-156`, `DockRegion.tsx:344`); one slot is the fill slot (`flex: 1 1 0`, `windowing.css:163-165`): the
first open `dockFill` panel, else the last open slot (`DockRegion.tsx:279-286`). A `DockedPanelSplitter` sits between
neighbours (`:360-369`). So two *window* panels docked `left` already stack one above the other with a splitter.

**Can the left region hold Preview above the Browser today? No.** The Browser is not in the left region. It is the
`sampleSelector` panel with `presentation: 'drawer'` (`registry/panelCatalog.ts:121-135`), drawn by
`SampleSelectorDrawer` as its own flex child of `.xleth-windowing-shell`, *outside* `.xleth-app-workarea`
(`AppShell.tsx:211-212`, `windowing.css:13-67`), and the left `DockRegion` excludes drawers
(`AppShell.tsx:217`, `excludePanelIds={DRAWER_PANEL_IDS}`). Docking Preview `left` today gives a **second column** to
the right of the Browser. Both columns read the same stored number, `dockRegionSizes.left`
(`AppShell.tsx:119`, `DockRegion.tsx:294,311`), so at 304 that is 608px of side columns.

**Recommended approach (one layout system, no new stored key).** Place the existing left region inside the drawer's
column instead of beside it:

1. When the Browser's dock side is `left` or `right` and the edge region on that same side holds a panel, `AppShell`
   renders that `DockRegion` in the drawer host, above the drawer, and does not render it in the docked layer. The host
   becomes a flex column: stacked region, then the drawer taking the rest.
2. `DockRegion` gets a `stacked` flag: it takes the host's width (the same `dockRegionSizes` value, so still one number
   and one resizer: the drawer's own, `SampleSelectorDrawer.tsx:251`), draws no region resizer of its own
   (`DockRegion.tsx:373`), and is as tall as its content. A stacked Preview slot is `28px + width x 9/16` from the
   project aspect, not a stored size.
3. While the column holds a stacked panel, collapsing the Browser cannot collapse the column to the 28px rail
   (`windowing.css:56-58`): the rail becomes a 28px row under the Preview.
4. Browser docked `top` or `bottom`: no stacking, the left region is its own column as today.

Registry, presets, persistence, splitters and every stored key keep their meaning. Rejected: turning the Browser into a
window panel (it would stack natively, but its rail, its dock-side cycle and F6 are drawer behaviour and the stored
`sampleSelector` state would change meaning). Known wrinkles to handle in phase 2: the floating layer's work area
(`AppShell.tsx:212`) does not include the drawer host, so a stacked Preview sits outside it (fine for a docked panel;
check the drag-to-dock `left` zone still lands there); `PanelFrame` only hides panels for `top` and `center`
(`layout/shellLayoutStore.ts:37-45`), so a stacked Preview correctly reports visible; and `dockHomeOf('preview')` and
`('inspector')` are `'top'` (`panelCatalog.ts:162,289`), so popping either out and pressing "Return to dock"
(`windowing/components/Titlebar.tsx:107-115`) rebuilds the top row. Return-to-dock should go back to the region the
panel was last docked in (`panel.docked.region` survives undocking) and fall back to `dockHome`.

**What `topMode` becomes when the top region is empty.** `'none'`, already implemented and tested:
`useShellLayout.ts:43-45` computes `topPresent` from the region's docked key; `computeShellLayout` returns
`{ topMode: 'none', topH: 0, arrangementH: A - dock }` (`shellLayout.ts:76-79`); `shellLayout.test.ts:81-84`
"has no top row when the region holds nothing" (dock 409, arrangement 613 at A 1022). `DockRegion` renders nothing
for an empty region (`DockRegion.tsx:303`) and `TopRowStrip` only mounts for `'strip'` (`AppShell.tsx:222`).

**Where the default preset is chosen.** One constant, `DEFAULT_PRESET_ID` (`managers/PresetManager.ts:42`). Its three
uses are in the A2 table above. The menu reads `LAYOUT_PRESETS` (`PresetManager.ts:54-58`, rendered at
`components/TitleBar.jsx:164`), so no menu code changes.

## 3. A3 in detail: insert names and the cache

**Where names can be read.** `useEffectChainStore` keeps `chains[key]` (`stores/effectChainStore.js:1601`), keyed by
`String(trackId)` or `'master'`, filled by `fetchChain` (`:3323-3339`, `getEffectChain` / `getMasterEffectChain`,
existing IPC). Each entry has a `pluginId`; `deviceName(effect, vstPlugins)` (`components/devices/deviceNames.js:39-46`)
turns it into the name the device title bar shows (stock names from `DEVICE_NAMES`, a plugin's own name, else its id).
`resolveFxMode` (`effectChainStore.js:160`) says when a track's effects belong to its FX Graph instead; that case keeps
the "FX graph" text. No new IPC is needed.

**What the comment at `MixerStrip.jsx:72` means.** It says the chain cache was only ever filled by the Devices and FX
Graph panels, for the selected track, so every other strip read an empty array and printed "No FX" until it was
selected. Two facts the brief does not have:

- **The comment and its fix are uncommitted.** `git show HEAD:ui/src/components/mixer/MixerStrip.jsx` has neither; the
  `fetchChain(fxKey)` effect at lines 75-77 (and the matching one in `MasterStrip.jsx:26-28`) belongs to another
  session's working-tree edits. In HEAD the inserts button really is stale.
- With that effect, each strip fetches its chain once when it mounts. After that the cache stays fresh for edits made
  through the store (`addEffect`, `removeEffect`, `moveEffect` and the preset loads all write `chains[key]`). It is not
  refreshed by a project load while the Mixer stays mounted, by undo of a chain load, or by an edit made through the
  FX Graph. A renderer-only fix is to refetch on the events `MixerPanel` already listens to
  (`MixerPanel.jsx:65-76`, including `onProjectLoaded`).

Phase 3 therefore either depends on the other session's hunk or re-states the same four lines in its own commit.

## 4. A7 in detail: is the master level in the `getAllPeaks` snapshot?

Yes. `mergeMeterTelemetry` copies `data.master.peakL / peakR` into `peaksSnapshot.master`
(`mixer/meterTelemetry.js:89-98`) and `publishMeters` serves the key `'master'` from it (`mixer/mixerMeterBus.js:34-38`);
the Master strip's meter already subscribes to it (`MasterStrip.jsx:23`).

But **the one poll only runs while the Mixer tab is mounted and visible**: the loop lives in `MixerPanel`'s effect
behind `if (!visible) return` (`MixerPanel.jsx:106-130`), and `visible` follows the mixer panel's `hidden` flag
(`windowing/panels/MixerPanel.tsx:11-15`). With the dock on Devices or Piano Roll there is no poll, so a top-bar meter
fed by the bus would sit at the floor: not fabricated, but dead for most of a session.

Options, none of which adds a second poll: (a) show the mini-meter only while the poll is running; (b) move the *same*
loop out of `MixerPanel` into the bus and run it while at least one meter is subscribed, so there is still exactly one
loop at 125 ms and it stops when nothing listens. (b) is the one that makes the feature worth having; it extends when
the existing IPC call is made (whenever the top bar is up, about 8 calls a second), which is a change of load and should
be Krasen's call. `pollMasterLoudness` rides the same tick and self-gates (`MixerPanel.jsx:119-121`), so it moves with it.

## 5. Where SPEC.md is wrong about the code

1. **"Left region ... holding Preview above the Browser"** (A2). The Browser is a drawer beside the work area, not a
   member of the left region. Section 2.
2. **Uncommitted work is not only engine and bridge** (section 6 of the brief). Section 0.
3. **"The chain cache the button already reads ... the comment at `MixerStrip.jsx:72`"** (A3). That comment and the fetch
   it describes are uncommitted; HEAD has no fill at all.
4. **"`MasterStrip` uses the same tick set (today it alone has -6)"** (A3). It already uses the same set; -6 is dropped
   on the shorter strip meters by the 12px label-collision rule.
5. **`formatValue` needs an explicit plus** (A3). It has had `signed` since Phase 0; the mixer does not pass it.
6. **Track header column 211, name 120 or more** (A4, section 3). The column is 212 and 120 is arithmetically
   impossible at that width with three 24px toggles and the chip.
7. **"Edge in the pattern's own colour"** (A4). Patterns carry no colour.
8. **"Neutralise it in the shipped themes"** (A4). The tint is one catalog default plus one override in light.
9. **`#606060` bar lines** (A1). The token is an alpha over the ground; the fix is the alpha (0.34).
10. **A1's floor list is incomplete.** rec-text and the cool accent also fall under 4.5:1 on the new g3, and the light row
    cannot widen at its ground end.
11. **"A kit Toggle variant"** (Prompt 1) for controls that are `IconButton`s; and the top bar has two more pressed chips
    (metronome, auto-scroll).
12. **"Only if the master level is already in the snapshot"** (A7) is true and beside the point: the snapshot is only
    refreshed while the Mixer tab is showing.
13. **Loudness dock "147x359"**: 148px, and it also holds the strip-width switch, which a 28px rail has to rehome.
14. **Ruler numerals "uniform"**: also 9px, already under the Floor.

Measurements the brief gets right: chrome 95 (38 + 26 + 30 + 1 border) and 83; 14 rows at a 1080 window and 13 at
1032; strip pitch 84 and 68; the ink-3 and boundary contrast figures; `topMode 'none'`.

## 6. Order and scope

Keep the order (1 ramp and toggles, 2 layout, 3 mixer, 4 timeline, 5 dock tabs, top bar and close-out): the ramp is under
everything, and the layout decides the widths the mixer and timeline are judged at. Scope changes:

| Phase | Change | Reason |
|---|---|---|
| every | Stage rebuilt blobs, not paths, for files in the section 0 table; state in the report that the committed tree was not built alone | foreign WIP in the same files |
| 1 | Also re-solve `recText` (dark) and the cool accent; raise the bar-line alphas (dark 0.34, light 0.44) and assert them; leave the light ramp (adding the pattern-lane tint to the "chrome is neutral" test list stays in phase 4) | they fail the existing floors on the new g3; light has no room |
| 1 | Put the quiet variant on the kit button class (`IconButton` and `Toggle` both use it), with a boundary outline as the non-colour signal | the controls are IconButtons; g3 on g2 is 1.2:1 |
| 2 | Includes the "stacked side region" shell change of section 2, and return-to-dock going to the last docked region | the brief's layout is not expressible today |
| 3 | Kit additions first (Meter: ticks without numerals, latch hidden until latched, opt-in audio hue; NumberBox: no fill; Knob: hidden label; a `signed` prop), then the strip. Rehome the strip-width switch. Refetch chains on the Mixer's existing events | section 1 and 3 |
| 4 | Widen `HEADER_WIDTH` 212 to 228 to reach a 120px name (16px of a 1,300px lane area), or accept about 104px at 212: Krasen's call, default to 228. Pattern edge colour = the owning track's (the Piano Roll's rule) | the brief's two numbers cannot both hold |
| 5 | The mini-meter needs the poll hoisted into the bus (section 4, option b) or it is skipped | a meter that only moves with the Mixer tab open is not worth the space |

## 7. What was not checked

Nothing was run against the engine. The shots harness has no engine either (`window.xleth` absent). Contrast figures are
WCAG 2.x computed from the hexes; the L steps were derived for exact greys and still have to be confirmed through
`deriveTheme`'s 8-bit rounding when phase 1 changes the table.
