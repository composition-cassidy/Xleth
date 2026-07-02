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
- Engine test executables are built by CI but not yet executed (no CTest registration yet — see `AUDIT.md` Q4). Run them locally via `build.bat tests`.
