# BUILD_DIAGNOSIS

## Current Config

Electron app root: `ui/`

Current `ui/electron-builder.json`:

```json
{
  "appId": "com.xleth.app",
  "productName": "XLETH",
  "files": ["dist/**/*", "main.js", "preload.js"],
  "directories": { "output": "release" },
  "win": { "target": "nsis" }
}
```

Findings:

- Targets: Windows `nsis` only.
- `files`: `dist/**/*`, `main.js`, `preload.js`.
- `directories.output`: `release`.
- `extraResources`: not configured.
- `extraFiles`: not configured.
- `asarUnpack`: not configured.
- `directories.buildResources`: not configured.
- `asar`: not configured.
- `compression`: not configured.
- `win.target`: string `nsis`, not portable.
- `ui/package.json` has no `dist` script.
- `electron-builder` is not installed in `ui/package-lock.json` or `ui/node_modules`.

## Path Resolution Sites

Path-resolution grep results before implementation:

- `ui/tests/baseline/capture.spec.ts:57` - `path.resolve(__dirname, '../..')`
- `ui/tests/baseline/capture.spec.ts:58` - `path.resolve(__dirname, '..', 'fixture')`
- `ui/addon-worker.js:38` - `path.resolve(__dirname, '../bridge/build/Release')`
- `ui/addon-worker.js:39` - `path.resolve(__dirname, '../build/vcpkg_installed/x64-windows/bin')`
- `ui/addon-worker.js:42` - `path.resolve(__dirname, '../bridge/build/Release/xleth_native.node')`
- `ui/main.js:16` - `path.join(app.getPath('userData'), 'xleth-settings.json')`
- `ui/main.js:17` - `path.join(app.getPath('userData'), 'layout.json')`
- `ui/main.js:26` - `path.join(__dirname, 'startup.log')`
- `ui/main.js:125` - `path.join(__dirname, 'addon-worker.js')`
- `ui/main.js:253` - `path.join(__dirname, 'preload.js')`
- `ui/main.js:261` - `path.join(__dirname, 'dist/index.html')`
- `ui/main.js:651` - `path.join(app.getPath('userData'), 'themes')`
- `ui/main.js:1656` - `path.join(__dirname, 'preload.js')`
- `ui/main.js:1665` - `path.join(__dirname, 'dist/index.html')`
- `ui/main.js:1729` - `path.join(__dirname, '../media')`
- `ui/preload.js:18` - `path.resolve(__dirname, '../shm_helper/build/Release/shm_helper.node')`
- `ui/test-addon-load.js:3` - `path.resolve(__dirname, '../bridge/build/Release')`
- `ui/test-addon-load.js:4` - `path.resolve(__dirname, '../build/vcpkg_installed/x64-windows/bin')`
- `ui/test-addon-load.js:9` - `path.resolve(__dirname, '../bridge/build/Release/xleth_native.node')`

Hardcoded relative/runtime artifact paths:

- `ui/addon-worker.js:38` - bridge runtime/DLL folder.
- `ui/addon-worker.js:39` - stale vcpkg DLL folder (`../build/vcpkg_installed/x64-windows/bin`, not present at repo root).
- `ui/addon-worker.js:42` - native addon `.node`.
- `ui/preload.js:18` - shared-memory helper `.node`.
- `ui/main.js:125` - worker script.
- `ui/main.js:253`, `ui/main.js:1656` - preload script.
- `ui/main.js:261`, `ui/main.js:1665` - Vite built renderer HTML.
- `ui/main.js:1729` through `ui/main.js:1736` - root `media` sample/video fixture directory.
- `ui/main.js:1320`, `ui/main.js:1492` - legacy thumbnail/frame extraction calls `ffmpeg` by PATH.
- `engine/src/ProxyTranscoder.cpp:43` - probes duration with `ffprobe` by PATH.
- `engine/src/ProxyTranscoder.cpp:104` and `engine/src/ProxyTranscoder.cpp:124` - builds DNxHR transcode commands with `ffmpeg` by PATH.

Renderer bundled static assets:

- `ui/src/theming/runtime/ThemeLoader.ts:14` through `ui/src/theming/runtime/ThemeLoader.ts:17` import shipped theme JSON through Vite bundling.
- `ui/src/windowing/managers/PresetManager.ts:1` through `ui/src/windowing/managers/PresetManager.ts:3` import window-layout preset JSON through Vite bundling.

No current Electron UI call site references `XlethEngine.exe`; the working runtime is a forked Node child process loading `xleth_native.node`.

## Native Artifacts On Disk

Native addon and sibling runtime artifacts:

- `bridge/build/Release/xleth_native.node`
- `bridge/build/Release/avcodec-62.dll`
- `bridge/build/Release/avformat-62.dll`
- `bridge/build/Release/avutil-60.dll`
- `bridge/build/Release/swresample-6.dll`
- `bridge/build/Release/swscale-9.dll`
- `bridge/build/Release/xleth-editor-host.exe`
- `bridge/build/Release/xleth-plugin-scanner.exe`
- `bridge/build/Release/test_*.exe` files are present but are test artifacts, not runtime requirements.

Shared-memory helper:

- `shm_helper/build/Release/shm_helper.node`

Engine executable artifact:

- `build/engine/XlethEngine_artefacts/Release/XlethEngine.exe`
- `bridge/build/engine/XlethEngine_artefacts/Release/XlethEngine.exe`

Additional engine artifact DLLs:

- `bridge/build/engine/XlethEngine_artefacts/Release/avcodec-62.dll`
- `bridge/build/engine/XlethEngine_artefacts/Release/avformat-62.dll`
- `bridge/build/engine/XlethEngine_artefacts/Release/avutil-60.dll`
- `bridge/build/engine/XlethEngine_artefacts/Release/glew32.dll`
- `bridge/build/engine/XlethEngine_artefacts/Release/glfw3.dll`
- `bridge/build/engine/XlethEngine_artefacts/Release/swresample-6.dll`
- `bridge/build/engine/XlethEngine_artefacts/Release/swscale-9.dll`

Native `.node` files under `ui/node_modules`:

- `ui/node_modules/@rollup/rollup-win32-x64-gnu/rollup.win32-x64-gnu.node`
- `ui/node_modules/@rollup/rollup-win32-x64-msvc/rollup.win32-x64-msvc.node`

FFmpeg CLI status at initial diagnosis:

- No `ffmpeg.exe` or `ffprobe.exe` existed in the repo or build outputs at the time Stage 1 was written.
- This machine resolves global copies at `C:\ProgramData\chocolatey\bin\ffmpeg.exe` and `C:\ProgramData\chocolatey\bin\ffprobe.exe`.
- Later follow-up placed FFmpeg archive contents under `vendor/ffmpeg`; the runtime executables are under `vendor/ffmpeg/bin`.

## Asset Loads

Synchronous filesystem reads/readdir before implementation:

- `ui/tests/baseline/capture.spec.ts:162` - test fixture readdir.
- `ui/main.js:19` - reads `xleth-settings.json`.
- `ui/main.js:350` - reads startup log.
- `ui/main.js:643` - reads `layout.json`.
- `ui/main.js:664` - reads user theme JSON.
- `ui/main.js:677` - lists user theme directory.
- `ui/main.js:1331` - reads temporary FFmpeg thumbnail/frame output.
- `ui/main.js:1360` - reads WAV file data to inspect `smpl` chunk.
- `ui/main.js:1495` - reads temporary FFmpeg thumbnail output.
- `ui/main.js:1515` - reads temporary Windows Shell thumbnail output.

Asset/resource implications:

- Settings, layout, startup log, and user themes must stay in `app.getPath('userData')`.
- Root `media/` samples are read-only bundled resources for startup defaults and must not resolve through `__dirname` in a portable package.
- Temporary thumbnail/frame outputs currently use `os.tmpdir()` and are acceptable as temporary files.
- Project proxies are currently project-directory relative in native code. Blank/untitled imports do not establish a user-data proxy cache, so DNxHR proxy behavior needs separate follow-up if import-before-project-create must persist across portable launches.

## Risks

- Current builder config cannot produce the requested portable artifact.
- Current packaged app would omit `addon-worker.js`, `xleth_native.node`, `shm_helper.node`, bridge DLLs, editor/scanner helper exes, root `media/`, and `XlethEngine.exe`.
- `startup.log` is currently written next to `main.js`, which is not writable/stable in packaged portable mode.
- `__dirname`-relative runtime paths will point into `app.asar` or extracted app code, not stable bundled resource folders.
- `ui/addon-worker.js` mutates the child process `PATH` with development-only paths and would not find packaged DLLs.
- `ui/main.js` intentionally launches system `node.exe` for addon isolation. That preserves the current runtime architecture but means a machine without Node on PATH will not pass worker startup until a bundled Node runtime strategy is added.
- Follow-up verification confirmed this risk (`spawn node.exe ENOENT` from the copied portable launch), so Stage 2 now bundles `vendor/node/node.exe` and resolves it via `runtimeResource("node", "node.exe")` in packaged builds.
- DNxHR proxy transcode depends on `ffmpeg.exe`/`ffprobe.exe` on PATH. Without vendored CLI binaries, a copied portable app can pass on this machine and fail on a clean machine.
- `electron-builder` is absent, so `npm run dist` cannot work until the dependency and script are added.
- The repo has many pre-existing uncommitted changes; implementation must avoid reverting unrelated edits.

## Plan

- Add `ui/runtimePaths.js` as the single source of truth for packaged resources and user-data paths.
- Refactor main/preload/worker path lookups to use runtime resources or userData paths.
- Preserve the current worker/native-addon strategy rather than migrating to direct `XlethEngine.exe` launch.
- Package runtime resources under `resources/`: worker script, bridge runtime, shm helper runtime, media assets, engine artifact, and vendored FFmpeg CLI folder when present.
- Add portable electron-builder config with deterministic `unpackDirName`, normal compression, ASAR, native unpacking, and root `dist` output.
- Add `npm run dist` and `electron-builder` dependency metadata.
- Block final portable verification if `vendor/ffmpeg/ffmpeg.exe` and `vendor/ffmpeg/ffprobe.exe` are absent.
