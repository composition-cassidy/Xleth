# Electron baselines: how to capture, and what needs a human

`capture.spec.ts` photographs the **docked shell** (Phase 8 rewrite; the Phase 0 snapshots predated
the windowing system and were removed). It launches the built app with the real engine, so it runs
on a machine that has `xleth_native.node`. The render harness (`npm run shots`) covers chrome without
the engine; this suite is for everything that needs it.

## Capture (Krasen, with the engine)

No snapshots are committed yet: they were not generated in the Phase 8 session because the engine
could not run there (`bridge/build/Release/xleth_native.node` dated 2026-10-22, older than the latest
engine/bridge commit; see "Before you run it"). Generate them, review each PNG, then commit them.

```bash
cd ui
npm run baseline:build
npm run baseline:capture
npm run baseline:check
```

`npm run baseline` does all three. `baseline:capture` writes
`tests/baseline/snapshots/capture.spec.ts/<name>.png`; commit only the files you reviewed.

### Before you run it

1. Close every running XLETH (the worker locks the `.node`).
2. Freshness: `Get-Item bridge\build\Release\xleth_native.node | Select LastWriteTime` must be newer than
   `git log -1 --format=%cd -- engine bridge`. If not: `cmake --build bridge/build --config Release`
   (about 5-10 minutes; no clean step, a clean wipes the runtime DLLs).
3. The FFmpeg / vcpkg DLLs must sit beside the `.node`, or the app will not start.
4. `npm run baseline:build` so `dist/` is current. The suite refuses to run against the Vite server.

## What the suite takes

| Shot | What | Needs |
|---|---|---|
| `01-shell-default` | whole window, empty project | engine |
| `02-top-bar` | the top bar | engine |
| `03-browser-media`, `04-browser-samples` | Browser drawer, both tabs | engine |
| `10-dock-devices` ... `14-dock-fx-graph` | each detail-dock tab | engine + fixture |
| `20-inspector-track-selected` | Inspector with a track selected | fixture tracks |
| `21-preview-edit-grid` | Preview with the Edit Grid row and dock | fixture |
| `22-device-chain` | the device chain strip | fixture effect chain |
| `23-mixer` | the Mixer tab | fixture |
| `24-sample-picker-sheet` | the picker sheet over Preview + Inspector | **an imported source (manual, below)** |
| `30-context-menu` | the kit Menu on a track header | fixture tracks |
| `31-export-dialog` | Export Audio (Ctrl+E); still the legacy dialog | fixture |
| `40-theme-<slug>` x5 | shell default in each shipped theme | engine |

A shot whose control is missing is **skipped, never faked**. Skips are reported by Playwright; a
first capture with skips means the shot needs the manual steps below.

## Shots that need media or a pattern (take by hand)

The fixture (`tests/fixture/project.json`) has two tracks and effect chains, but no imported media
and no pattern block. Name each file exactly as shown and drop it in
`tests/baseline/snapshots/capture.spec.ts/`.

### 24-sample-picker-sheet.png
1. Launch the app, open the fixture project (or any project).
2. Browser > Media > Import, add a video with sound.
3. Double-click the source. The picker sheet opens over Preview and Inspector.
4. Wait for the waveform and the source picture, then screenshot the sheet
   (`[data-testid="picker-sheet"]`).

### 12-dock-piano-roll.png (if skipped)
The Piano Roll tab shows an empty state until a pattern is open.
1. Add a Pattern track, draw a pattern block, double-click it.
2. Detail dock > Piano Roll, screenshot `[data-testid="xleth-detail-dock"]`.

### 13-dock-sampler.png (if skipped)
The Sampler tab needs a pattern track whose pattern has a region (a pitch sample).
1. Import a source, mark a sample in the picker, assign it to a Pattern track.
2. Detail dock > Sampler, screenshot the dock.

### 20-inspector-clip.png (optional, not automated)
Select a clip on a video track; screenshot `[data-testid="xleth-inspector-clip"]`.

### Playing-state shots (never automated)
Meters, the playhead and the scrolling displays are only photographed at rest, because playback
makes pixels non-deterministic. Look at them live: see `ui/tests/MANUAL_TEST_SCRIPT.md`.
