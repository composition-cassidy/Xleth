# Contributing to Xleth

Xleth is a **Windows-only** application with three build layers:

| Layer | Tech | Build tool |
|-------|------|-----------|
| Engine | C++20, JUCE, FFmpeg, D3D11/OpenGL | CMake + MSVC (VS 2022) |
| Bridge | Node-API addon (`xleth_native.node`) statically linking the engine | cmake-js |
| UI | Electron + React 18 + Vite | npm |

## What CI checks

Every pull request and every push to `main` runs [.github/workflows/ci.yml](.github/workflows/ci.yml), which has two jobs (both pinned to `windows-2022` — the VS 2022 generator and its bundled CMake 3.x are load-bearing):

1. **Engine + bridge (MSVC x64)** — *gating.* Configures and builds the full CMake project (engine libraries, scanner, editor-host, and the engine test executables), then builds the bridge addon with cmake-js and verifies `xleth_native.node` was produced. If this job is red, the PR broke the native build.
2. **UI (Vite build + vitest)** — the Vite production build is *gating*; the vitest suite runs on every PR but is currently **non-blocking** because it has known pre-existing failures (see `AUDIT.md` §3.5). A red vitest step is visible in the job log but does not fail the workflow. Once the suite is green, the `continue-on-error` line in the workflow should be removed so tests gate merges too.

The first CI run on a cold cache is slow (~1–2 h) because vcpkg compiles FFmpeg from source; compiled packages are stored in the GitHub Actions cache, so subsequent runs skip that.

## Reproducing CI locally

Prerequisites:

- **Visual Studio 2022** with the C++ workload. Use the **VS-bundled CMake (3.x line)** — CMake 4.x fails to configure some fetched dependencies, which is why CI pins it too.
- **vcpkg** with the `VCPKG_ROOT` environment variable set (dependencies are declared in [vcpkg.json](vcpkg.json) and installed automatically at configure time).
- **Node.js** (CI uses Node 24).

Then, from the repo root — `build.bat` wraps all of these, or run them directly:

```bat
:: Engine (same as CI "Configure" + "Build" steps, or: build.bat engine)
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release --parallel

:: Bridge (same as CI, or: build.bat bridge) — run AFTER the engine build,
:: it reuses the vcpkg packages installed into build/vcpkg_installed
cd bridge
npm ci
npx cmake-js compile --CDCMAKE_BUILD_TYPE=Release
cd ..

:: UI build + tests (same as CI)
cd ui
npm ci
npm run build
npm test
```

Notes:

- Close any running Xleth/Electron instance before rebuilding the bridge — the loaded `xleth_native.node` locks the output file (`build.bat` does this for you).
- The Playwright baseline screenshots (`ui/tests/baseline`) are not part of CI; they require a built app and local snapshots.

## Running the tests

**Engine (C++):** all 46 `test_*` executables are registered with CTest. After building, run them in one command from the repo root:

```bat
ctest --test-dir build -C Release --output-on-failure
```

`build.bat tests` (menu option 6) does exactly this. Tests execute with the repo root as working directory, matching how they were historically run.

**Bridge (contract scripts):** `npm test` in `bridge/` runs every `test_*.js` script in the directory sequentially (each in its own node process) plus the compiled `test_export_naming.exe` (a C++ unit test built by the bridge's cmake-js build — it is *not* one of the 46 engine CTest targets). Individual scripts are still available via `npm run test:phase1`, `npm run test:transport`, etc.

**UI unit tests (vitest):** `npm test` in `ui/` runs the vitest suite (`vitest run`, jsdom/node components). This is the suite CI runs (currently non-blocking — see "What CI checks" above).

**UI Electron main-process smoke (`ui/tests/smoke`):** a Playwright suite that launches the *real* Electron app (`ui/main.js`) — forking the engine worker and driving the actual preload/IPC/worker stack, nothing stubbed — and asserts three things: the app boots without throwing, the forked engine worker reaches "ready", and a real read-only IPC round-trip (`timeline.getBPM`) completes. It exists so the planned `ui/main.js` decomposition (AUDIT.md S5) has a baseline that fails loudly if boot, worker startup, or the IPC round-trip regresses. Because it drives the built UI, run a UI build first:

```bat
cd ui
npm run build        :: produces dist/index.html (main.js loads it under XLETH_PLAYWRIGHT=1)
npm run test:smoke   :: playwright test --config playwright.smoke.config.ts
```

This suite is separate from the vitest suite (different runner + command) and from the screenshot baseline (`playwright.config.ts` / `ui/tests/baseline`). Like the baseline, it needs a built app and is **not** part of CI — it requires the native `xleth_native.node` addon (built via the Engine + Bridge steps above) and Windows audio/GPU, so it runs locally, not on the `windows-2022` runners.

### Known first-run failures (registration baseline)

The CTest/npm wiring registers the tests; it does not fix them. The following were already failing when first run through the unified commands (they fail the same way when invoked manually) and are tracked as pre-existing:

Engine (`ctest`, 43/47 passed, baseline 2026-07-14):

| Test | Failure |
|------|---------|
| `test_flip_orientation_golden` | assertion failure (GPU shader golden) |
| `test_effects` | assertion failure |
| `test_reverb` | assertion failure |
| `test_real_render` | segfault — also hardcodes the project path `C:\Users\Krasen\Desktop\XLETH\test`, so it can only ever run on that machine |

`test_video_flip_applier` and `test_frame_collector`, previously listed here, now pass on the current build — in particular `test_frame_collector` runs Tests 1–6 to `ALL TESTS PASSED` and the old `0xc0000409` fail-fast crash no longer reproduces. The suite is now 47 tests because the snapshot-transition feature added `test_snapshot_transition` (passing).

Engine note: the FFmpeg-linked tests need the vcpkg DLLs on `PATH`; the CTest registration prepends `<vcpkg_installed>/bin` per test (`ENVIRONMENT_MODIFICATION`), which is what manual runs always relied on. Without it, 15 additional tests die on startup with `0xc0000135` (DLL not found). A stale `test_envelope_voice_events.exe` may exist in old build trees — its target was removed and it is intentionally not registered.

Bridge (`npm test` → `run_contract_tests.js`, 12/15 passed, baseline 2026-07-14):

| Script | Failure |
|--------|---------|
| `test_dynamics_viz.js` | `drain.schema === 1 (got 2)` — schema version mismatch |
| `test_midi_import.js` | expects `C:\Users\Krasen\Desktop\XLETH\test.wav` (missing on disk) and sampler-metadata round-trip fails (`rootNote`/`attackMs` come back `undefined`) |
| `test_pdc_live_presentation_refresh.js` | `EPERM` deleting its scratch copy under `diagnostics\pdc-stage7c\` during cleanup |

`test_patterns.js`, previously listed here, now passes on the current build. `test_snapshot_transition_preview_contract.js` (the snapshot-transition live preview seam) passes.
