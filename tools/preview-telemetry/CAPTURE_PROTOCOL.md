# Preview Telemetry Capture Protocol

Goal: find out **which stage of the preview pipeline is actually eating the frame
time** — decode, composite, GPU→CPU readback, or transport — instead of guessing.

No code changes, no rebuild. Your existing diagnostic export already records
per-stage timings (section **4b. PREVIEW TICK STAGE TIMING**). You capture a few
exports under controlled conditions; the analyzer script ranks the stages and
tells you where the wall is.

---

## What you do (≈10 minutes)

### 1. Pick projects
Because grid shape varies, capture **two project types** if you have them:

- **Project A — single base source** (classic YTPMV: many cells, same source pitched/flipped).
- **Project B — multi-source** (several distinct episodes / YouTube rips on the grid).

One heavy project of each is enough. If you only have time for one, use the **heaviest** one you've got.

### 2. For EACH project, capture 2 exports
Set preview to your **lowest** settings (low resolution scale, effects on as normal).

1. **Poster OFF** — turn poster mode off so cells show live video.
   - Press **Play**. Let it run **~10 seconds** so the rolling averages settle (the
     avg columns are 60-sample / ~1s windows — don't export in the first second).
   - While still playing, open **Settings → Graphics → Export Visual Preview Diagnostic Log**.
   - Save it.
2. **Poster ON** — turn poster mode back on. Play ~10s. Export again.

> The Poster OFF → ON pair is the key experiment: it isolates per-cell **decode**
> cost (which poster removes) from the **always-on** cost — readback + composite +
> transport — that poster can't touch. If the always-on floor is still high, decode
> was never your problem.

### 3. (Optional but useful) one more per project
- **effectsBypass ON, poster OFF** — isolates how much the GPU **effect chains**
  cost vs. plain compositing.

### 4. Do it on BOTH laptops
Repeat on the Ryzen 5 7520U *and* the i7-13700H + RTX 4050. The cross-machine
delta tells us whether the bottleneck scales with CPU, GPU, or neither (neither =
architectural, which is my standing bet).

### 5. Name the files so the analyzer can read the conditions
The analyzer detects poster state from the filename. Use this pattern:

```
<laptop>-<project>-poster-off.txt
<laptop>-<project>-poster-on.txt
```

Examples:
```
ryzen-projA-poster-off.txt
ryzen-projA-poster-on.txt
i7-projB-poster-off.txt
i7-projB-poster-on.txt
i7-projB-effectsbypass-poster-off.txt
```

Put them all in one folder, e.g. `tools/preview-telemetry/logs/`.

---

## What I do
Run the analyzer (or send me the .txt files and I'll run it):

```
node tools/preview-telemetry/analyze-preview-telemetry.mjs tools/preview-telemetry/logs
```

It prints, per file:
- The dominant stage and its % of the frame budget.
- Delivered FPS vs target, and whether the wall is **inside** the video tick or
  **outside** it (rAF / audio coupling / shm hand-off).

And across the poster OFF/ON pair:
- How much poster actually removed, and what always-on floor remains.
- A verdict: decode-bound (multi-source path) vs. readback-bound (round-trip) vs. both.

---

## What the verdict drives
- **Readback dominates** → kill the GPU→CPU→GPU round trip (shared D3D11 texture /
  DXGI keyed-mutex into ANGLE, or a native swapchain child window). Universal win.
- **Decode dominates only with multi-source** → proxies (intra-frame) + raise
  `MAX_OPEN_CONTEXTS` + decode at preview res. Helps the heavy mashups.
- **Whole tick is within budget but FPS is still low** → the cap is outside the
  tick: decouple the audio/video clocks and the rAF poll.

That decision is what we hand to Claude Code (Opus, Xhigh) as a scoped change —
measured, not guessed.

---

### Notes / gotchas
- Export **while playing**, at steady state. A snapshot taken while stopped or in
  the first second has cold/zero averages.
- Poster state is **not** stored in the engine log — the filename is the only
  record. Label carefully.
- If section 4b says "no engine counters — preview tick has not run," the preview
  wasn't actually playing when you exported. Re-do while playing.
- The export path is whatever you choose in the save dialog (or the app's
  user-data folder if the dialog is unavailable).
