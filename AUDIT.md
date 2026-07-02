# Xleth — Architecture & Code-Quality Audit

**Date:** 2026-07-02 · **Branch:** `latest` (audit reflects the working tree, which includes a large *uncommitted* change set — the unified-zOrder UI work with several pending file deletions) · **Method:** read-only inspection; nothing was modified.

**Scope note:** This is triage, not a rewrite proposal. Windows-only design is treated as a given, not a defect. Section 4 lists code that sits on the Phase 0 performance floors (28× DNxHR seek, 0.25 ms GPU composite, <15 ms A/V drift) — those items are marked **verify before touching** and are deliberately excluded from the refactor list's "just do it" tier.

---

## 1. Architecture as built

### 1.1 Process map

Five native/JS processes cooperate at runtime:

```
┌─────────────────────────  Electron  ─────────────────────────┐
│                                                              │
│  Renderer (React 18 + zustand, Vite)                         │
│   │ window.xleth.* (contextBridge, ui/preload.js)            │
│   ▼                                                          │
│  Main process (ui/main.js — 4,011 lines)                     │
│   • 323 ipcMain.handle('xleth:…') channels                   │
│   • local HTTP media server for <video> elements (:382)      │
│   • settings/themes/plugin-ui/decal persistence, autosave    │
└───┬──────────────────────────────────────────────────────────┘
    │ child_process.fork, serialization:'advanced' (main.js:529)
    ▼
Engine worker — plain Node.js (NOT Electron)
  ui/addon-worker.js → require('xleth_native.node')
   • bridge/src/XlethAddon.cpp (2,004 lines, 296 exports)
   • statically links XlethEngineCore (JUCE + FFmpeg + D3D11)
   • threads: JUCE audio callback, video/preview tick, proxy &
     poster workers, WORLD processing, export
    │
    ├── xleth-editor-host.exe  (out-of-process VST3 editor GUI;
    │    audio via NamedAudioRing shared memory — editor-host/src)
    └── scanner.exe            (VST plugin scanning, crash-isolated)
```

Why the worker exists (documented in [addon-worker.js:27](ui/addon-worker.js:27)): JUCE/FFmpeg/GLEW DLLs crash in-process under Electron's Chromium runtime, so the addon is hosted in a plain Node child for ABI isolation. Packaged builds ship `vendor/node/node.exe`; dev builds hunt for a system Node ([main.js:464](ui/main.js:464) `resolveSystemNodeExe`, checks `where node`, Program Files, nvm, scoop).

### 1.2 The command path (one call, seven hops)

A single UI action, e.g. "set BPM", travels:

1. React component → `window.xleth.timeline.setBPM(n)` (preload wrapper)
2. `ipcRenderer.invoke('xleth:timeline:setBPM')` → Electron IPC
3. `ipcMain.handle` in main.js → `callWorker('timeline_setBPM', [n])` ([main.js:606](ui/main.js:606); 30 s timeout, per-call logging with a `SILENT_METHODS` suppression set)
4. `worker.send({id, method, args})` → child-process IPC
5. [addon-worker.js:53](ui/addon-worker.js:53) → `xleth.timeline_setBPM(...)` (synchronous N-API call)
6. [XlethAddon.cpp:158](bridge/src/XlethAddon.cpp:158) `dispatchToService` → converts every N-API value to `nlohmann::json` (`napiToJson`)
7. [XlethEngineService.cpp:15826](engine/src/XlethEngineService.cpp:15826) `dispatch()` — **~300 sequential `if (method == "...")` string comparisons** — into a translation-unit-local handler.

The result then makes the same trip back. **Five hand-maintained name registries** must stay in sync for every method: preload method name, IPC channel string, worker method string, addon export name, and dispatch string. There are currently 296 addon exports and 323 IPC channels, all wired by hand.

### 1.3 The engine service

[engine/src/XlethEngineService.cpp](engine/src/XlethEngineService.cpp) is **16,131 lines** — the entire command layer in one translation unit. Its public interface is intentionally tiny ([engine/include/XlethEngineService.h](engine/include/XlethEngineService.h): a singleton with `dispatch(method, json)`), and the header comment explains why: handlers own long-lived worker threads and pointer graphs whose addresses must remain stable.

Inside, state is ~40+ anonymous-namespace globals (`g_timeline`, `g_undoManager`, `g_projectManager`, `g_frameServer`, `g_proxyManager`, `g_previewCompositor`, `g_gpuDevice`, …, [XlethEngineService.cpp:181-437](engine/src/XlethEngineService.cpp:181)) plus documented lock-ordering rules (e.g. "always syncEventsMutex → g_posterPrepassMtx; never the reverse", :435).

Handlers are written against [XlethServiceJsonApi.h](engine/src/XlethServiceJsonApi.h) — a facade that **mirrors the N-API `Value`/`Env` interface on top of nlohmann::json** so that Phase 0 could move the old bridge handler bodies into the engine unchanged. It works, but it means the engine core natively speaks JavaScript's type system (`$xlethType: "Float32Array" / "ArrayBuffer" / "undefined"`), including a raw-pointer-in-JSON convention (`address` as uint64, `reinterpret_cast` on receipt — [XlethAddon.cpp:84-97](bridge/src/XlethAddon.cpp:84)) that is only safe because addon and engine share a process.

Build topology (clean, worth preserving): engine/CMakeLists.txt layers `XlethEngineModel` → `XlethEngineCore` → `XlethEngineService` static libs; the bridge links `XlethEngineCore` only, which deliberately excludes all OpenGL/GLFW/GLEW ([bridge/CMakeLists.txt:53-57](bridge/CMakeLists.txt:53)).

### 1.4 Data transports (there are six)

| # | Transport | Used for | Notes |
|---|-----------|----------|-------|
| 1 | Async fork-IPC JSON (`invoke` → `callWorker`) | All commands/queries | 30 s timeout; per-method payload fixups in addon-worker.js |
| 2 | `ipcRenderer.sendSync` | shm metadata, backdrop state ([preload.js:27](ui/preload.js:27), :71) | Blocks the renderer main thread |
| 3 | Windows named file mapping | Video frames engine → renderer | Double-buffered; engine writes, preload's `shm_helper.node` reads index + memcpy per rAF tick ([preload.js:24-50](ui/preload.js:24), [VideoPreview.jsx:517](ui/src/components/VideoPreview.jsx:517)) |
| 4 | Local HTTP server in main | `<video>` elements (source preview) | [main.js:382](ui/main.js:382) |
| 5 | `webContents.send` push events | export progress, project-loaded, graph changed | Channel names inconsistently namespaced (see §3.4) |
| 6 | NamedAudioRing shared memory | editor-host VST3 audio pump | editor-host/src/AudioPumpThread.cpp |

### 1.5 State model: engine owns the document, UI polls

The engine owns the project document (`g_timeline` + `UndoManager` + `ProjectManager`). The UI holds **37 zustand stores** (ui/src/stores/) plus two strays at src root (`transportStore.js`, `timelineEvents.js`). Synchronization is **poll-based**:

- `transportStore.js:22` polls `getTransportState` on an interval,
- main.js polls WORLD-processing status at 150 ms active / 1000 ms idle ([main.js:2271](ui/main.js:2271)),
- export dialogs poll progress on intervals (:2215, :2246),
- mutations are followed by imperative refetches.

Every poll traverses the full seven-hop chain in §1.2. This is not just an elegance problem: commit `f5f1f44` ("Fix audio stutter on complex projects: throttle synchronous-pipe UI polling") shows UI polling cadence is **coupled to audio-thread health**. Treat polling changes as performance-sensitive (§4).

---

## 2. Engine / bridge / UI boundary — conflations and leaks

Ranked by how much they'd confuse an external contributor:

1. **Five name registries for one RPC surface** (§1.2). Adding one engine method touches `XlethEngineService.cpp` (handler + dispatch line), `XlethAddon.cpp` (function + export), `main.js` (handler), `preload.js` (wrapper) — five string constants, zero compile-time checking, and a silent-null failure mode if any is missed (next item).
2. **`notImplemented` → silent `null`** ([addon-worker.js:58](ui/addon-worker.js:58)): if the addon doesn't export a method (stale binary, typo in any registry), the renderer receives `null` instead of an error. Deliberate (tolerates un-rebuilt addons in dev) but it converts wiring mistakes into "feature silently does nothing." The project's own smoke-recipe notes ("check xleth_native.node freshness FIRST") exist because of this.
3. **The engine speaks JavaScript types** ([XlethServiceJsonApi.h](engine/src/XlethServiceJsonApi.h)): `$xlethType`, `Float32Array`, `undefined` are engine-core vocabulary. Acknowledged Phase 0 shim, but nothing marks it as transitional in the code besides one header comment.
4. **Raw pointers serialized through JSON** (`address` field, [XlethAddon.cpp:84-97](bridge/src/XlethAddon.cpp:84), [XlethServiceJsonApi.h:61-70](engine/src/XlethServiceJsonApi.h:61)): a zero-copy hack valid only within one process. Nothing enforces that invariant; if a handler's external-binary result were ever forwarded across the fork-IPC boundary un-copied, it would be a garbage pointer. Today addon-worker.js happens to copy in the right places (per-method special cases at :68, :93) — protocol knowledge living in the transport layer.
5. **main.js is a business-logic layer, not a router.** Beyond 323 handlers it owns: import/export orchestration, autosave, theme/plugin-ui-layout/knob-preset/decal file stores, a media HTTP server, grid-layout helpers, update checking. Renderer-visible behavior lives in a 4,011-line file that has no tests.
6. **Preload contains logic, not just exposure**: shm open/read scheduling and cached backdrop state ([preload.js:24-71](ui/preload.js:24)). Preload code is the hardest layer to test and debug; it should be the thinnest.
7. **Addon-worker knows method semantics**: special-casing `getFrameRGBA`, `getFrameBuffer`, `midi_importFull`, typed-array flattening ([addon-worker.js:64-130](ui/addon-worker.js:64)). Transport and protocol are braided together.
8. **Legacy alias exports in the addon**: both `getAudioPerformanceTelemetry` *and* `audio_getAudioPerformanceTelemetry` (etc., 5 pairs around [XlethAddon.cpp:1660-1677](bridge/src/XlethAddon.cpp:1660)); main.js likewise maps both `xleth:currentFrame` and `xleth:frameRGBA` to the same worker call (:767-768). Nobody can tell which name is canonical.
9. **Misleading build config**: [bridge/package.json](bridge/package.json) tells cmake-js `runtime: "electron", runtimeVersion: "41.1.1"` — but the addon is loaded by *plain Node*, never Electron. It works because Node-API is ABI-stable, but a contributor reading the config will draw the wrong architecture diagram.
10. **UI repo tests engine-adjacent code**: `ui/src/addonWorker.routing.test.js` tests `ui/addon-worker.js` routing — reasonable content, odd home (worker is arguably bridge infrastructure, and it lives at `ui/` root while its test lives under `ui/src/`).

---

## 3. Dead code, duplication, inconsistency, repo hygiene

### 3.1 Dead / orphaned code

| Item | Evidence | Size |
|------|----------|------|
| **Legacy OpenGL compositor**: [VideoCompositor.cpp/.h](engine/src/VideoCompositor.cpp), GLFW/GLEW dependency | Excluded from the service and the bridge by design (comment [XlethEngineService.cpp:19](engine/src/XlethEngineService.cpp:19), [bridge/CMakeLists.txt:56](bridge/CMakeLists.txt:56)); only reachable from the dev harness `engine/src/Main.cpp` | ~1,000 lines + a whole dependency set |
| **`engine/src/Main.cpp`** — interactive decode-benchmark harness (`_getch()` loop) | Not part of the shipped app; ships the only consumer of VideoCompositor | 1,534 lines |
| **Six unused effect headers**: `ReverbEffect.h`, `CompressorEffect.h`, `LimiterEffect.h`, `OverdoneEffect.h`, `TransientProcEffect.h`, `WaveshaperEffect.h` in engine/src/audio/ | `#include` grep finds zero includers; each has a maintained `Xleth*Effect.h` successor | ~6 files |
| **`ui/src/components/sampler.bak/`** — 8 files, tracked in git | Full duplicate of `components/sampler/`; `.gitignore` now has `*.bak` but these predate it | ~3,000 lines |
| Untracked `.bak` strays in working tree: `App.jsx.bak`, `TimelineView.jsx.bak`, `timeline/TimelineCanvas.jsx.bak` | Ignored but sitting next to live code | — |
| **`scripts/`** one-shot scratch: `_mutate_enriched*.py` (×4), `_step1_*` (×10+) **plus their .txt/.json outputs**, tracked | Theming-audit scratchwork from a past migration pass | ~30 files |
| **`bridge/build_offline/`** — MSVC build artifacts (`.vcxproj`, `.tlog`, `.sln`) tracked in git | Build output committed; `build/` ignore pattern doesn't match `build_offline` | ~25 files |
| **`bridge/_tmp_*`** dirs (audio-perf captures, midi probe) tracked | Scratch output committed | — |
| **`diagnostics/`** — 56 tracked files including **21 MB and 18 MB stderr logs**, 6 MB JSONs, a full project copy with `.flac`/`.jpg` | Session debugging artifacts committed; main reason `.git` is **2.0 GB** | ~55 MB+ in HEAD, more in history |
| `engine/test/test_proxy.mov`, `vendor/ffmpeg/doc/*.html` (3 MB × 3) | Binary/media assets tracked | ~10 MB |

### 3.2 Duplicated logic

- **Two video decode/cache stacks**: CPU path ([VideoDecoder.cpp](engine/src/VideoDecoder.cpp) + [FrameCache.h](engine/src/FrameCache.h)) and D3D11 path ([render/RenderVideoDecoder.cpp](engine/src/render/RenderVideoDecoder.cpp) + [render/FrameCache.h](engine/src/render/FrameCache.h)). The split is partially intentional (live vs. render pipelines), but **two different headers are both named `FrameCache.h`** — include mistakes waiting to happen — and the CPU stack's remaining live consumers overlap with the legacy path in §3.1.
- **Two effect families, both wired**: `AudioGraph.cpp` includes legacy `ChorusEffect.h`, `FlangerEffect.h`, `PhaserEffect.h`, `DistortionEffect.h`, `PhanjerEffect.h`, `UniFlangeEffect.h` *and* the current `Xleth*Effect.h` family. A contributor cannot tell which chorus is "the" chorus without reading AudioGraph.
- **~9 structurally identical zustand stores** (chorus/flanger/delay/distortion/phaser/…): the same 19-line "which panel instance is open" template with the name changed ([chorusStore.js](ui/src/stores/chorusStore.js) vs [flangerStore.js](ui/src/stores/flangerStore.js) differ only in identifiers). One `createEffectPanelStore(name)` factory replaces them all.
- **Per-effect fan-out everywhere**: adding an effect touches a store, a panel, an IPC channel group in main.js, addon exports, and dispatch strings — each a near-copy of the last effect's code (see main.js section banners: "EQ-specific", "SmartBalance-specific", "Waveshaper-specific"…).
- **Giant header-only DSP classes**: `XlethResonanceSuppressorEffect.h` (2,606 lines), `XlethReverbEffect.h` (2,010), `XlethEQEffect.h` (1,805) — every TU that includes them recompiles the DSP. Compile-time cost, not correctness.

### 3.3 Monoliths (size alone; several are perf-adjacent — see §4 before touching)

| File | Lines | Role |
|------|-------|------|
| [engine/src/XlethEngineService.cpp](engine/src/XlethEngineService.cpp) | 16,131 | Entire command layer |
| [ui/src/styles/app.css](ui/src/styles/app.css) | 23,150 | Most of the UI's styling in one file (theming migration ~15/22 subsystems done) |
| [engine/src/audio/MixEngine.cpp](engine/src/audio/MixEngine.cpp) | 5,440 | Real-time mixer (`processBlock`) — **perf-critical** |
| [ui/src/components/TimelineView.jsx](ui/src/components/TimelineView.jsx) | 4,442 | Timeline container |
| [ui/main.js](ui/main.js) | 4,011 | Electron main (everything) |
| [engine/src/audio/AudioGraph.cpp](engine/src/audio/AudioGraph.cpp) | 2,819 | Effect graph |
| [ui/src/stores/effectChainStore.js](ui/src/stores/effectChainStore.js) | 2,965 | FX chain state |

### 3.4 Naming & structural inconsistency

- **C++ handler naming**: `Project_ImportSource` / `Timeline_GetBPM` (PascalCase_underscore) vs. exported `project_importSource` — a deliberate mapping, but undocumented.
- **IPC channels**: commands are consistently `xleth:*` (good), but push events mix `xleth:project-loaded`, `export:progress`, `zip-export:progress`, `video-export:progress`, `stretch:worldProcessingStart` — three styles, two without the `xleth:` namespace.
- **Store naming**: `mixerStore.js` vs `useGridEditStore.js` / `usePianoRollStore.js` — two conventions in one directory; plus `transportStore.js` and `timelineEvents.js` stranded at `ui/src/` root instead of `stores/`.
- **`App.test.jsx` tests `XlethRoot.jsx`** — there is no `App.jsx` anymore.
- **TS/JS split by era**: `windowing/` is TypeScript, `components/` is JSX, `fxgraph/` is JS — fine as a migration snapshot, but no doc says which direction is canonical.
- **Test placement**: colocated `*.test.jsx`, `__tests__/` dirs, and `ui/tests/baseline/` — three conventions.
- `PhanjerEffect.h` — a phaser/flanger portmanteau a contributor will assume is a typo.
- Root directory (untracked but present): ~12 planning/audit `.md` files, build logs, `telem.txt`, path-mangled filenames (`CWINDOWSsystem32cmd.exe .txt`), `.bat` scripts. All gitignored, so contributors cloning the repo won't see them — but `.gitignore` itself now reads as a confession list and several of its patterns (`*.bak`, `build/`) have tracked violations that predate the rules.

### 3.5 Test & CI posture

- **Engine**: 46 `test_*.cpp` targets, **no `enable_testing()`/`add_test()`** — run manually via `build.bat` option 6, whose own docstring lists only 6 of them. No single command provably runs everything.
- **Bridge**: manual `node test_*.js` contract scripts (good content, ad-hoc harness; `npm test` runs only `test_phase1.js`).
- **UI**: 126 vitest/playwright files (genuinely substantial), but prior sessions recorded pre-existing vitest failures — suite health is unverified and nothing gates on it.
- **No CI at all** (no `.github/`). For an open-source repo this is the single biggest contributor-facing gap: nothing tells a PR author whether they broke the build.

---

## 4. Performance-critical map — **verify before touching**

These files implement the Phase 0 floors. None of them should appear in a cleanup PR without a dedicated benchmark run before/after. "Verify" = re-run the relevant perf measurement (seek benchmark, preview tick timing in the visual diagnostic, sync-stats drift), not just tests.

### 4.1 DNxHR proxy & seek path (28× floor)

| File | Why it's hot |
|------|--------------|
| [engine/src/render/RenderVideoDecoder.cpp](engine/src/render/RenderVideoDecoder.cpp) | The seek win itself: D3D11VA zero-copy decode, per-source `DecoderContext` LRU keep-open, and the sequential fast path (skip seek when frame == last+1) |
| [engine/src/ProxyTranscoder.cpp](engine/src/ProxyTranscoder.cpp) | Generates the all-intra DNxHR proxies + posters (in-process libav; recently migrated off ffmpeg.exe — header comment documents why) |
| [engine/src/project/ProxyManager.h](engine/src/project/ProxyManager.h) + region-proxy / poster-prepass sections of XlethEngineService.cpp (~:1388–1990) | Proxy/poster precedence logic was the subject of a recent multi-part fix (poster mode); ordering of guards is load-bearing |
| [engine/src/render/FrameCollector.cpp](engine/src/render/FrameCollector.cpp) | Chooses poster/thumbnail/proxy per cell; per-cell `thumbnailPaths[bucket]` preference is recent and unpushed |
| [engine/src/render/FrameCache.h/.cpp](engine/src/render/FrameCache.h) (`RenderFrameCache`) | GPU LRU; render-thread-only by design (no mutex, thread assert) |

### 4.2 GPU composite (0.25 ms floor)

| File | Why it's hot |
|------|--------------|
| [engine/src/render/GridCompositor.cpp/.h](engine/src/render/GridCompositor.cpp) + [render/shaders/](engine/src/render/shaders) | The composite itself. `CellConstants` is a hand-matched 32-byte HLSL cbuffer layout ([GridCompositor.h:47](engine/src/render/GridCompositor.h:47)) — fragile ABI; draw order = request order (zOrder contract) |
| [engine/src/render/GpuDeviceManager.cpp](engine/src/render/GpuDeviceManager.cpp) | Device/adapter selection, readback staging |
| FrameOutput/shm write in XlethEngineService.cpp (:228, :772-region) + [shm_helper/shm_helper.cpp](shm_helper/shm_helper.cpp) + [preload.js:24-50](ui/preload.js:24) + [VideoPreview.jsx](ui/src/components/VideoPreview.jsx) rAF tick | Frame delivery chain; the per-stage µs counters in the preview diagnostic depend on this exact structure |
| [engine/src/render/VideoFlipApplier.cpp](engine/src/render/VideoFlipApplier.cpp), [ArpVideoExpander](engine/src/render/ArpVideoExpander.cpp), [AnimationManager](engine/src/render/AnimationManager.cpp) | Feed the compositor per-frame; currently mid-change in the working tree |

### 4.3 Audio master clock & A/V sync (<15 ms floor)

| File | Why it's hot |
|------|--------------|
| [engine/src/audio/MixEngine.cpp](engine/src/audio/MixEngine.cpp) | `processBlock` on the real-time audio thread; documented lock-strategy flags and underrun accounting. Do not "clean up" locking, allocation, or logging here casually |
| [engine/src/SyncManager.cpp/.h](engine/src/SyncManager.cpp) | Video-event scheduling against the audio clock; drift sampling (`driftSamples_`) |
| [engine/src/AudioEngine.cpp](engine/src/AudioEngine.cpp), [AudioScheduler](engine/src/AudioScheduler.cpp), [TriggerQueue.h](engine/src/TriggerQueue.h), [Transport](engine/src/Transport.cpp), [VoiceManager](engine/src/VoiceManager.cpp) | Device callback plumbing and trigger timing |
| UI polling cadence: [transportStore.js](ui/src/transportStore.js), `SILENT_METHODS` + WORLD poll in [main.js:491,2271](ui/main.js:2271) | Commit `f5f1f44` proves polling frequency can starve audio on complex projects. Any "tidy the polling" refactor must re-verify audio health |
| Lock-order comments in XlethEngineService.cpp (e.g. :435) | The documented orderings are the only thing standing between refactors and deadlocks |

Also adjacent: [OfflineRenderer.cpp](engine/src/render/OfflineRenderer.cpp), [FFmpegMuxer.cpp](engine/src/export/FFmpegMuxer.cpp), [RenderClock](engine/src/render/RenderClock.cpp) (export timing correctness — the loop-region and rate-control fixes live here).

---

## 5. Prioritized refactor list

Scored per the tech-debt framework: **Priority = (Impact + Risk) × (6 − Effort)**, each 1–5.

### 5.1 Quick wins — low risk, low effort, no perf exposure

| # | Item | I | R | E | Score | Notes |
|---|------|---|---|---|-------|-------|
| Q1 | **Add CI** (GitHub Actions: engine build + bridge build + vitest; even build-only at first) | 5 | 4 | 2 | 36 | The multiplier for everything else. No `.github/` exists today |
| Q2 | **Untrack committed junk**: `bridge/build_offline/`, `bridge/_tmp_*`, `diagnostics/` big logs, `scripts/_step1_*`/`_mutate_*` + outputs, `vendor/ffmpeg/doc`, `test_proxy.mov` (`git rm --cached` + ignore rules) | 4 | 3 | 1 | 35 | Shrinks clone pain; history rewrite for the 2 GB `.git` is optional and separate — decide deliberately if ever |
| Q3 | **Delete dead code**: 6 unused effect headers; `sampler.bak/`; stray `.bak` files | 3 | 2 | 1 | 25 | Pure deletion; grep-verified no includers |
| Q4 | **Register engine tests with CTest** (`enable_testing()` + `add_test` per target) and make `npm test` in bridge run all contract scripts | 4 | 3 | 2 | 28 | Turns 46 orphan exes into one command; feeds Q1 |
| Q5 | **Write the architecture README** (§1 of this document is a draft): process map, the seven-hop call path, the six transports, how to add a method, build instructions | 5 | 2 | 2 | 28 | Highest contributor-clarity return per hour of any item here |
| Q6 | **Collapse the ~9 template zustand stores** into a `createEffectPanelStore()` factory | 2 | 1 | 1 | 15 | Mechanical |
| Q7 | **Rename one `FrameCache.h`** (e.g. render one → `RenderFrameCache.h`) | 2 | 2 | 1 | 20 | Header-only rename + include fixups |
| Q8 | **Kill alias exports** (pick canonical names for `audio_*`/bare pairs and the `xleth:currentFrame`/`frameRGBA` twins), leaving one deprecation shim with a comment | 2 | 2 | 1 | 20 | Do renderer-side callers in the same pass |
| Q9 | **File moves**: `transportStore.js`/`timelineEvents.js` → proper homes; `App.test.jsx` → `XlethRoot.test.jsx`; unify push-event channel names under `xleth:` | 2 | 1 | 1 | 15 | Pure hygiene |
| Q10 | **Fix bridge/package.json cmake-js runtime** to match reality (Node runtime, with a comment explaining Node-API ABI stability) | 2 | 2 | 1 | 20 | One config block + verify a rebuild |
| Q11 | **Make `notImplemented` loud in dev** (log-once per method, or env-gated throw) | 3 | 3 | 1 | 30 | Small change in addon-worker.js; kills a whole class of silent failures |
| Q12 | **Verify and fix the failing vitest suite** so Q1 can gate on it | 3 | 3 | 2 | 24 | Failures were recorded as "pre-existing" in prior sessions; unquantified today |

Suggested order: Q1 → Q2 → Q4/Q12 → Q3 → Q5, then the rest opportunistically.

### 5.2 Major surgery — each needs its own dedicated effort, contract tests first, perf re-verification after

| # | Item | I | R | E | Score | Risk profile |
|---|------|---|---|---|-------|--------------|
| S1 | **Single source of truth for the RPC surface.** Either a method manifest that generates the five registries, or a generic `invoke('xleth:call', method, args)` passthrough with an allowlist. Must preserve the special-cased binary paths (frames, MIDI buffers) explicitly | 5 | 4 | 4 | 18 | Touches every layer; silent-null failure mode (Q11) must be fixed first so regressions surface. Do behind the bridge contract tests |
| S2 | **Split XlethEngineService.cpp into domain TUs** (transport/project/timeline/audio/preview/export) keeping the existing dispatch as the seam; globals → an explicit context struct passed to handlers | 4 | 5 | 5 | 9 | The header itself warns why this is dangerous: TU-local statics with stable addresses, worker-thread lifetimes, documented lock orders. Move code verbatim, one domain per PR, re-run seek/composite/drift benchmarks each time. **Do not combine with any behavior change** |
| S3 | **Retire the legacy OpenGL stack** (`VideoCompositor`, GLFW/GLEW, CPU `VideoDecoder`/`FrameCache` where unused, `Main.cpp` harness) | 3 | 3 | 3 | 18 | Blocked on preview unification (SyncManager still schedules against structures shared with the old path — verify per §4.3). Payoff: a whole dependency set and ~3k lines gone |
| S4 | **Engine→UI event push to replace polling** (dirty-flag infrastructure already exists: `g_previewDirty`, seq counters) | 4 | 4 | 4 | 16 | Directly touches the audio-stutter-sensitive polling path (§4.3). Needs before/after audio-health telemetry on a complex project |
| S5 | **Decompose ui/main.js** into modules (worker lifecycle, media server, persistence stores, handler tables by domain) | 3 | 3 | 3 | 18 | Mostly mechanical but zero test coverage today — write smoke tests (app boots, worker ready, one command round-trips) first |
| S6 | **Finish the theming migration, then split app.css** by subsystem | 3 | 2 | 4 | 10 | Ordering matters: splitting before the token migration finishes doubles the work |
| S7 | **Unify the dual effect families** in AudioGraph (legacy Chorus/Flanger/Phaser/Distortion/Phanjer/UniFlange vs `Xleth*`) | 3 | 4 | 4 | 14 | Audibly user-facing: existing projects reference these effects; needs project-compat testing, not just unit tests |
| S8 | **Split TimelineView.jsx** (4.4k lines) | 2 | 3 | 4 | 10 | Only with interaction tests in place; heavy in-flight churn in the working tree right now — wait for the zOrder work to land |

**Deliberately not proposed:** rewriting the JsonApi shim out of the engine (it's ugly but stable and load-bearing for all 300 handlers — revisit only as part of S1/S2), any restructuring of MixEngine/SyncManager/GridCompositor internals (§4), and any cross-platform abstraction work.

---

*Compiled from direct inspection of the working tree on branch `latest`. Line numbers reference the current uncommitted state and will drift once the in-flight zOrder work lands.*
