# XLETH Phase 1 Bug Report

Consolidated list of all known bugs after completing the Phase 1 Integration Test (15/15 steps passed). Each bug includes the affected code area, a brief description of how that part of the architecture works, and the observed problem.

---

## Architecture Quick Reference

| Layer | Description |
|-------|-------------|
| **C++ Engine** | JUCE-based audio/video engine compiled as a Node native addon (`xleth.node`) |
| **addon-worker.js** | Forked child process that loads the native addon; communicates with main process via JSON IPC messages |
| **main.js (Electron main)** | Electron main process; registers `ipcMain.handle` for all `xleth:*` channels; delegates to addon-worker via `callWorker()` |
| **preload.js** | Electron contextBridge; exposes `window.xleth.*` API to renderer (invoke wrappers) |
| **React renderer** | Vite + React 18 app at `ui/src/`; uses `timelineEvents` EventTarget as an internal event bus to coordinate data refresh across components |
| **Timeline data model** | Sources (imported media), Regions (sample markers on sources), Tracks (rows), Clips (placed instances of regions on tracks). Tick resolution: 960 PPQ |

---

## Bug 1 — Project Media tab doesn't show import completion

**Severity:** Medium
**Area:** `ui/src/components/ProjectMediaTab.jsx` (lines 92-116), `ui/src/components/SourceCard.jsx`

**How it works:** When a file is imported, `importFiles()` calls `importSource()` IPC for each file sequentially, then calls `fetchSources()` to re-query the engine and `setSources()` to trigger a React re-render. `SourceCard` renders a spinning loader icon when `source.proxyReady === false` and a check icon when `true`.

**Problem:** After import completes, the source card stays in the "loading" state (spinner). It only visually updates to "done" (check icon) when the user adds another source or switches tabs. The `proxyReady` flag returned by the engine may still be `false` at the moment `fetchSources()` runs because proxy transcoding is async on the C++ side, and there is no follow-up poll or event from the engine to signal completion. The component fetches once and never re-checks.

**Fix direction:** Either poll `getSources()` on a short interval while any source has `proxyReady === false`, or add an IPC event from the engine that fires when transcoding finishes so the renderer can re-fetch.

---

## Bug 2 — No proxy generation progress indicator

**Severity:** Low
**Area:** `ui/src/components/SourceCard.jsx` (lines 51-62), `ui/main.js` (IPC layer)

**How it works:** `SourceCard` already has a `<ProgressBar>` component and a `<Loader2>` spinner that render when `source.proxyReady === false`. However, the progress bar is set to `progress={null}` (indeterminate) because the engine does not expose a progress percentage.

**Problem:** When a video is imported, there is no way to tell the user what is happening (transcoding, analyzing, etc.) or how far along it is. The indeterminate spinner also doesn't appear reliably due to Bug 1 (stale state). For large videos, the user sees nothing happening.

**Fix direction:** Add a `proxyProgress` field (0-100) to the source object returned by `getSources()`, updated by the C++ proxy transcoder. Surface it in `SourceCard` via the existing `<ProgressBar>` component. Also display a label like "Generating proxy..." while in progress.

---

## Bug 3 — Sample Picker has no horizontal scroll (pan)

**Severity:** Medium
**Area:** `ui/src/components/SamplePicker/WaveformScrubber.jsx` (lines 374-433)

**How it works:** The `handleWheel` function maps scroll input to three actions: (1) plain vertical scroll = zoom in/out centered on cursor, (2) `Shift + vertical scroll` = horizontal pan, (3) trackpad horizontal deltaX = horizontal pan. A regular mouse without a horizontal scroll axis only has vertical deltaY.

**Problem:** A standard mouse wheel only generates vertical deltaY events. Without holding Shift, all scroll input zooms instead of panning. This is inconsistent with the main timeline, where scrolling is expected to pan horizontally. Users with a mouse (not trackpad) have no intuitive way to scroll left/right through the waveform.

**Fix direction:** Match the main timeline's scroll convention: plain scroll = horizontal pan, Ctrl+scroll (or pinch) = zoom. Alternatively, add a visible scrollbar at the bottom of the waveform that can be dragged.

---

## Bug 4 — Clip waveforms are invisible on the timeline

**Severity:** Medium
**Area:** `ui/src/components/timeline/timelineDrawing.js` (lines 218-285), `ui/src/constants/labels.js`

**How it works:** Each clip is drawn as a filled rectangle using the label's hex color at 0.6 alpha (unselected) or 0.8 alpha (selected). The waveform is drawn on top as a filled polygon using the **same** hex color at 0.25 alpha (unselected) or 0.35 alpha (selected). The waveform amplitude is scaled to 35% of clip height, centered vertically.

**Problem:** Same-color-on-same-color with only a small opacity difference produces almost no visual contrast. The waveform blends into the clip background and is effectively invisible, especially for lighter label colors (yellow hihat, green pitch). The clip just looks like a solid colored block.

**Fix direction:** Use a contrasting waveform color. Options: (a) use white or near-white fill for the waveform at ~0.5 alpha, (b) use a darker shade of the label color, or (c) draw the waveform as a stroke (outline) instead of fill. Also consider increasing `wfAmp` from 0.35 to 0.45 so the waveform occupies more of the clip height.

---

## Bug 5 — No multi-clip copy/paste

**Severity:** High
**Area:** `ui/src/components/TimelineView.jsx` (lines 649-699)

**How it works:** `Ctrl+C` reads `selectedClipIds`, but only copies the **first** clip from the Set into `clipboardRef` (a single-clip object). `Ctrl+V` pastes that single clip at the playhead position, then auto-advances the playhead to the end of the pasted clip.

Multi-select **does** exist (Ctrl+click, Shift+click, rubber-band in `selectTool.js` lines 171-278), but the clipboard doesn't use it.

**Problem:** Users can select 20 clips but Ctrl+C only copies one. There is no way to copy a group of clips and paste them as a unit at a new position. This makes arranging and restructuring a timeline extremely tedious.

**Fix direction:** Change `clipboardRef` to store an array of clip objects with their relative offsets (relative to the earliest clip's position). On paste, recreate all clips with offsets adjusted to the playhead. Advance playhead to the end of the last pasted clip.

---

## Bug 6 — No batch clip delete

**Severity:** Medium
**Area:** `ui/src/components/TimelineView.jsx` (lines 635-647), `ui/src/components/timeline/tools/deleteTool.js` (lines 83-105)

**How it works:** The Delete key handler loops through `selectedClipIds` and calls `removeClip()` one at a time via IPC, awaiting each. The delete tool's sweep-delete also loops with `await` per clip. Both clear selection after all deletions, then call `fetchClips()` once.

**Problem:** Each deletion is a separate IPC round-trip (renderer -> main -> worker -> C++ -> back). With 20+ clips, this takes several seconds of visible one-by-one removal. The UI freezes during this because the `for` loop is synchronous (`await` inside loop).

**Fix direction:** Add a `removeClips(ids[])` batch IPC endpoint to the engine that removes multiple clips in one call. Or at minimum, fire all `removeClip` calls in parallel (`Promise.all`) and do a single `fetchClips()` at the end.

---

## Bug 7 — Track number counter resets on re-entry

**Severity:** Medium
**Area:** `ui/src/components/TimelineView.jsx` (line 31, lines 324-326)

**How it works:** Track names are generated as `Track ${nextTrackNum.current++}` where `nextTrackNum` is a `useRef(1)` initialized at component mount. When the user navigates away from the timeline (e.g., opens the Sample Picker), `TimelineView` unmounts. When they return, it remounts and `nextTrackNum` resets to 1.

Existing tracks are fetched from the engine via `fetchTracks()` on mount, but the counter is never synchronized with the highest existing track number.

**Problem:** After leaving and returning to the timeline, adding new tracks creates "Track 1", "Track 2" again — duplicating names of existing tracks.

**Fix direction:** On mount (or after `fetchTracks()`), scan the loaded track names, parse the highest `Track N` number, and set `nextTrackNum.current = maxN + 1`. Alternatively, generate names server-side in the C++ engine.

---

## Bug 8 — No track deletion UI

**Severity:** Medium
**Area:** `ui/src/components/TimelineView.jsx` (lines 363-373, lines 749-756), `ui/src/components/timeline/TrackHeader.jsx`

**How it works:** A `handleRemove(id)` function exists in TimelineView and it works (calls `removeTrack` IPC, then `fetchTracks()`). A context menu with "Delete Track" also exists (line 754). TrackHeader accepts an `onRemove` prop.

**Problem:** The user reported no way to delete tracks. This suggests the context menu isn't triggering (possibly the right-click target area is wrong, or the context menu doesn't appear on track headers). The feature is implemented but not accessible.

**Fix direction:** Verify the right-click handler is wired to TrackHeader's `onContextMenu`. If it only fires on the canvas area, extend it to the track header list. Add a visible delete button (trash icon) on hover of each track header as an alternative.

---

## Bug 9 — Horizontal scroll snaps back to position 0

**Severity:** High
**Area:** `ui/src/hooks/useTimelineScroll.js` (lines 24-32), `ui/src/components/TimelineView.jsx` (lines 241-254)

**How it works:** `scrollOffset` state lives in `useTimelineScroll` hook (initialized to 0). The `ensureVisible(beat)` function auto-scrolls to keep the playhead in view — if the playhead is past 80% of the viewport, it calls `applyScroll()` to reposition. This is called every animation frame (60fps) from `playheadClock.onFrame()`.

Scroll input comes through the scrollbar component (`TimelineScrollbar.jsx`) and wheel events. The canvas, ruler, and clips all read `scrollOffsetRef.current` for drawing.

**Problem:** When the user scrolls right, the next `ensureVisible()` frame sees the playhead is now to the left of the viewport (because the view moved right) and snaps the scroll back to center on the playhead. During playback this creates a tug-of-war; when stopped, the playhead at beat 0 pulls the view back to 0 on the very next frame.

**Fix direction:** Only call `ensureVisible()` during active playback (`isPlaying === true`), and add a "user is scrolling" debounce flag that suppresses auto-scroll for ~1-2 seconds after manual scroll input. Alternatively, only auto-scroll forward (never backward) so manual scroll-ahead is preserved.

---

## Bug 10 — Double `audio_loadSourceRegion` on mount (dev only)

**Severity:** Low (dev-only)
**Area:** `ui/src/components/TimelineView.jsx` (useEffect hooks)

**How it works:** React 18 StrictMode double-invokes effects during development to help detect side effects. Each mount triggers `fetchRegions()` + audio loading twice.

**Problem:** Every region's audio is loaded twice on component mount in dev builds. This doubles IPC calls and C++ audio buffer allocations. Not an issue in production builds where StrictMode is stripped.

**Fix direction:** Optional — add a cleanup/abort flag in the effect or use a `hasLoaded` ref guard. Low priority since it doesn't affect production.

---

## Bug 11 — Split undo labels are generic

**Severity:** Low
**Area:** Undo stack (C++ engine side), `ui/src/components/TimelineView.jsx` (undo/redo handlers)

**How it works:** The C++ undo system records operations with string labels. Split operations create "Remove Clip" + "Add Clip" entries in the stack.

**Problem:** After splitting a clip, the undo history shows generic "Remove Clip" entries instead of "Split Clip". The user can't distinguish a split undo from a regular delete undo in the history.

**Fix direction:** Add a `"Split Clip"` label variant in the C++ undo system for split operations.

---

## Bug 12 — No video playback

**Severity:** High (feature gap)
**Area:** `ui/src/components/VideoPreview.jsx`, C++ engine video decoder

**How it works:** A `<VideoPreview>` component exists in the layout and renders a `<video>` element. The `xleth-media://` protocol in `main.js` serves local files with proper Range header support for seeking. However, the video frame is not synchronized to the transport position.

**Problem:** The video preview area exists but shows nothing during playback. No video frames are decoded or displayed in sync with the audio timeline. This is a known feature gap — video playback was not part of Phase 1 scope.

**Fix direction:** Implement frame-accurate video sync: either use the `<video>` element's `currentTime` property driven by transport polls, or decode frames in C++ and send them as textures/bitmaps to the renderer via shared memory or IPC.

---

## Summary Table

| # | Bug | Severity | Primary File(s) |
|---|-----|----------|-----------------|
| 1 | Source import completion not reflected | Medium | `ProjectMediaTab.jsx`, `SourceCard.jsx` |
| 2 | No proxy progress indicator | Low | `SourceCard.jsx`, engine IPC |
| 3 | Sample Picker no horizontal scroll | Medium | `WaveformScrubber.jsx` |
| 4 | Clip waveforms invisible | Medium | `timelineDrawing.js`, `labels.js` |
| 5 | No multi-clip copy/paste | High | `TimelineView.jsx` |
| 6 | No batch clip delete | Medium | `TimelineView.jsx`, `deleteTool.js` |
| 7 | Track counter resets | Medium | `TimelineView.jsx` |
| 8 | No track deletion UI | Medium | `TimelineView.jsx`, `TrackHeader.jsx` |
| 9 | Horizontal scroll snaps to 0 | High | `useTimelineScroll.js`, `TimelineView.jsx` |
| 10 | Double audio load (dev) | Low | `TimelineView.jsx` |
| 11 | Split undo labels generic | Low | C++ engine undo system |
| 12 | No video playback | High | `VideoPreview.jsx`, engine |
