## Preview frozen during playback (compositor gate shut) — XLETH Diagnostic Report

### What we're trying to do
When the user presses **Play** (transport playing, audio audible), the grid video
preview should composite a new frame every video tick (~30 fps) and write it to the
`XlethFrameBuffer` shared memory, where the Electron renderer uploads it to a WebGL
canvas. Expected: a live, continuously-updating grid preview during playback.

### What actually happens
During playback the preview is effectively **frozen** (~0–1 fps). Telemetry shows the
video thread ticks thousands of times but the GPU compositor path is entered only a
handful of times. Audio plays normally and the playhead advances (reached 12.4 s in
one capture), but the compositor almost never runs, so the renderer receives only
3–4 frames total and shows a near-static image. This reproduces on both test laptops.

### Environment
- OS: Windows 11 (build 26200)
- Runtime: Electron 41 renderer + forked Node "addon-worker" hosting a native N-API addon (`xleth_native.node`)
- Key dependencies: JUCE (audio), FFmpeg (decode), D3D11 (GridCompositor), ANGLE/WebGL (renderer canvas)
- Hardware (this capture): AMD Ryzen 5 7520U + Radeon integrated (ANGLE D3D11). Also repros on i7-13700H + RTX 4050.
- Single engine process: `ui/main.js` forks **one** `addon-worker.js` which `require`s the addon. All IPC (`play`, `initVideoSharedMemory`, etc.) and the video thread live in that **one** worker, sharing one global `AudioEngine`.

### Architecture Overview
```
[Renderer] Play button
   → IPC xleth:play
   → [main.js] callWorker('play')
   → [addon-worker.js] process.on('message') → dispatchToService(..., 'play')
   → [engine, worker process] Play() → audioEngine->playTimeline() → Transport::play() (playing_ = true)

[engine, worker process] videoThreadBody()  (separate std::thread, ~30 Hz)
   each tick:  syncManager->videoTick()
               read gate: (isPlaying || forceRender) && !events.empty()
               if gate && compositorReady && !previewPaused → GridCompositor (D3D11) → readback → FrameOutput(shm)
   → [shm XlethFrameBuffer] → [renderer] WebGL texSubImage2D → canvas
```
Audio thread, video thread, and the Play IPC handler all run in the **same** worker
process and reference the **same** global `audioEngine` / `Transport`.

### Code Involved

**`engine/src/XlethEngineService.cpp`** — video thread render gate (the suspect). `compositorPathEntered` only increments when the gate AND inner conditions pass.
```cpp
// videoThreadBody(), ~line 2798
while (videoRunning) {
    g_previewDiag.videoTickCount.fetch_add(1, std::memory_order_relaxed);
    /* drainProxyResults(); drainSourcePosterResults(); drainSourcePreviewResults(); */
    double tickBeatPos = -1.0;
    { std::lock_guard<std::mutex> lock(syncEventsMutex);
      tickBeatPos = syncManager->videoTick(); }

    if (audioEngine && syncManager && frameOutput.isInitialized()) {
        std::lock_guard<std::mutex> eLock(syncEventsMutex);
        const auto& events = syncManager->getEvents();          // ← is this EMPTY during playback?

        Transport& t = audioEngine->getTransport();
        bool isPlaying = t.isPlaying();                          // ← or is THIS false during playback?
        bool forceRender = g_previewDirty.exchange(false);
        /* ... stopped-preview handling ... */

        if ((isPlaying || forceRender) && !events.empty()) {    // ← GATE: passes only 4–6 / ~3000 ticks
            const bool previewPaused =
                g_previewPauseForExport || g_previewPauseForVisibility;   // both = false in logs
            if (g_previewCompositorReady && !previewPaused) {            // compositorReady = true
                g_previewDiag.compositorPathEntered.fetch_add(1, std::memory_order_relaxed);
                /* ... GridCompositor composite + readback + FrameOutput write ... */
```

**`engine/src/XlethEngineService.cpp`** — Play() populates events then starts transport.
```cpp
// Play(), ~line 4001
audioEngine->getMixEngine().rebuildAllSamplers();
rebuildVideoEventsFromClips();        // ← rebuilds video events BEFORE play
audioEngine->playTimeline();          // → Transport::play() → playing_ = true
```

**`engine/src/AudioEngine.cpp`** — same transport the video thread reads.
```cpp
void AudioEngine::playTimeline() { refreshLivePresentationLatency(); transport_.play(); }
```

**`engine/src/Transport.cpp`** — note: the audio path ALSO bails when `!playing_`, so if
`playing_` were false, audio would be silent and the playhead would not advance.
```cpp
void Transport::play()  { /*...*/ playing_.store(true,  std::memory_order_release); }
void Transport::process(/*...*/) {
    if (!playing_.load(std::memory_order_acquire)) return;   // audio advances ONLY if playing_
    /* ... advance position ... */
}
bool Transport::isPlaying() const { return playing_.load(std::memory_order_acquire); }
```

### What the logs/output show
From `Settings → Graphics → Export Visual Preview Diagnostic Log`, two captures on the Ryzen laptop, lowest preview settings (resScale 0.25, effectsBypass ON), during/after pressing Play:

```
                         poster-off        poster-on
  Video tick count:        2788              3219
  Compositor path entered:    4    ←←←          6    ←←←   (0.14% / 0.19% of ticks!)
  compositeFrame() calls:     4                 6
  readback() valid:           2                 3
  readback() not-ready:       2                 3
  Delivered FPS:              0    ←←←          1    ←←←
  frames received (renderer): 3                 4
  renderer last action:    no-frame          no-frame
  Preview time used:       0.000 s           12.400 s  ←  playhead DID advance (audio played)
  Active visual events:    1284              1284       ←  events non-empty (recorded on a compositor entry)
  pauseForExport / pauseForVisibility: no / no   (both captures)
  compositorReady:         yes
  Readback policy:         AsyncQueued (switched: map-stall-too-slow)
  lastReadbackHRESULT:     DXGI_ERROR_WAS_STILL_DRAWING   |   S_OK
  Renderer WebGL:          healthy, 0 context losses, all uploads succeeded
```
Boundary: **the renderer side is healthy and starving.** It opened the shm, uploaded
every frame it received (3–4), zero failures, zero WebGL context losses — it simply
isn't being given new frames because the engine compositor almost never runs.

### What we've already tried
1. **"Poster" fast-preview mode** (replace live cells with stills) — barely changed anything. *Now explained:* with the compositor entered only 4–6 times, there was no per-cell decode load to remove; poster mode optimizes a path that wasn't executing.
2. **Lowest preview settings** (resScale 0.25, effectsBypass ON) — no improvement. *Explained:* the cost-per-frame isn't the problem; the frames aren't being produced.
3. **Tested on a far stronger machine** (i7-13700H + RTX 4050) — still bad. *Explained:* a gating bug is hardware-independent; the gate is shut regardless of GPU.
4. **Per-stage timing instrumentation (section 4b)** — showed avg ≈ 0.000 ms for every stage with huge max spikes. *Explained:* the tick early-exits before the stages on ~99.8% of ticks, so the trailing-average windows are full of zero-cost ticks.

### Suspected root causes (ranked)
1. **`events.empty()` is TRUE on the playback ticks** — i.e. `syncManager->getEvents()` returns an empty list during continuous playback, so the gate `(isPlaying || forceRender) && !events.empty()` fails on the `!events.empty()` term. The "Active visual events: 1284" figure is recorded *inside* the compositor path, so it only reflects the rare entries (which were likely `forceRender` seeks), not the typical playback tick. **Strongly favored** because it's consistent with audio playing + playhead advancing (which require `playing_ == true`) while the compositor stays idle. Possible mechanism: `rebuildVideoEventsFromClips()` populates a structure that `syncManager->getEvents()` does not return during playback, or the events get cleared/not-synced on the playback path while the seek/stopped path repopulates them.
2. **`isPlaying` reads false on the video thread** — contradicted by the fact that audio is audible and the playhead advances on the *same* single `Transport` instance (`Transport::process` also early-returns on `!playing_`). Only plausible if there are unexpectedly two `AudioEngine`/`Transport` instances, or the video thread's `audioEngine` is a different object than the one `Play()` drives. Low probability given single-worker topology, but cheap to rule out.
3. **`forceRender`/seek is the ONLY thing ever driving the preview** — the 4–6 entries correlate with edits/seeks (e.g. the 12.4 s entry = a seek), implying the *playback* path never satisfies the gate at all. This is the same finding as (1)/(2) viewed from the output side.

Secondary (only matters once frames flow): on AMD, `readback() not-ready ≥ valid` and the
policy auto-switched to `AsyncQueued` with reason `map-stall-too-slow` — the GPU→CPU
staging-texture `Map()` chronically stalls (`DXGI_ERROR_WAS_STILL_DRAWING`).

### Key files for the reader to examine
- `engine/src/XlethEngineService.cpp` — `videoThreadBody()` gate (~line 2798–2860); `Play()` (~line 4001); the preview diag getter (~line 14490–14600).
- `engine/src/SyncManager.cpp` / `.h` — `videoTick()` and `getEvents()`: what populates the event list, and whether it differs between playback and seek/stopped paths.
- `engine/src/XlethEngineService.cpp` — `rebuildVideoEventsFromClips()`: confirm it feeds the SAME list `syncManager->getEvents()` returns.
- `engine/src/Transport.cpp` — confirm a single `playing_` drives both audio advance and `isPlaying()`.

### What to try next
1. **Add per-term tick counters and disambiguate in ONE playback run.** In `videoThreadBody()`, inside the `if (audioEngine && syncManager && frameOutput.isInitialized())` block, atomically count each term every tick and expose them in the diag JSON:
   - `gateIsPlayingTrueTicks` (++ when `isPlaying`)
   - `gateEventsNonEmptyTicks` (++ when `!events.empty()`)
   - `gateForceRenderTicks` (++ when `forceRender`)
   - `gatePreviewPausedTicks` (++ when `previewPaused`)
   Press Play, let it run ~10 s, export. Whichever counter is ~0 is the false term. This single run decides between hypotheses (1) and (2) with certainty.
2. **If `gateEventsNonEmptyTicks` ≈ 0 (hypothesis 1):** trace `SyncManager::getEvents()` vs `rebuildVideoEventsFromClips()`. Confirm the playback path actually fills the list the video thread reads (it may only be filled on seek/stopped-preview). Fix by ensuring playback populates/retains the same event vector.
3. **If `gateIsPlayingTrueTicks` ≈ 0 (hypothesis 2):** log `&audioEngine->getTransport()` in both `Play()` and `videoThreadBody()` and compare pointers — verify they're the same instance. If different, unify them.
4. **Only after the gate is fixed and frames flow:** address the AMD readback stall (`map-stall-too-slow`). Make the staging `Map()` non-blocking with a small ring (read frame N-1, never block on the just-submitted frame), or eliminate the GPU→CPU→GPU round trip via a shared D3D11 texture (DXGI keyed-mutex into ANGLE) or a native swapchain child window.
