# BUILD_VERIFY

## Build Result

- `npm run dist`: PASS.
- Portable artifact: `C:\Users\Krasen\Desktop\XLETH\dist\Xleth-0.0.1-portable.exe`.
- Size: 225.75 MB.
- Fresh portable copy tested from: `C:\Temp\xleth-portable-test\Xleth-0.0.1-portable.exe`.
- Portable extraction path: `C:\Users\Krasen\AppData\Local\Temp\Xleth-0.0.1`.
- `app.isPackaged`: PASS, logged `true`.
- `process.resourcesPath`: PASS, logged `C:\Users\Krasen\AppData\Local\Temp\Xleth-0.0.1\resources`.
- Worker spawn path: PASS, logged `...\resources\node\node.exe` running `...\resources\worker\addon-worker.js`.
- Native runtime readiness: PASS, logged `[Worker] ready`, `initialize() OK`, and shared memory ready.
- Packaged resources present: `node\node.exe`, `ffmpeg\ffmpeg.exe`, `ffmpeg\ffprobe.exe`, `bridge\xleth_native.node`, `shm_helper\shm_helper.node`, `worker\addon-worker.js`, `engine\XlethEngine.exe`, and `media\KICK_ssedit.wav`.

## Outcome Checklist

- a. PASS - app launched from the fresh portable copy, main window mounted React UI, shared-memory preview initialized, and no module/path-resolution errors were logged. Known non-path issue remains: CSP blocks embedded `data:` fonts.
- b. PASS - current architecture's native worker child process spawned via bundled Node and reached ready; this preserves the existing `addon-worker.js` plus `xleth_native.node` flow rather than spawning `XlethEngine.exe`.
- c. FAIL - DNxHR proxy generation and preview playback passed, but the proxy output path is still native `projectDir\proxies`, not requested `userDataPath("proxy-cache")`. Verified proxy: `C:\Temp\xleth-portable-test\verify-project-1777402642079\proxies\5.mxf` (1086 KB).
- d. PASS - automated 4-bar test with one Chorus, one Pitch, and one Percussion track played; transport reported `isPlaying=true`, sync stats reported `avgDriftMs=0.83`, `maxDriftMs=10.0`, `frameDrops=0`, and preview returned frame pixels.
- e. PASS - mixer volume changed Pitch track to `0.5`; stock `xletheq` was added and bypassed successfully (`bypassed=true`).
- f. PASS - 5-second YouTube-style export completed; `ffprobe` reports playable H.264 video, AAC audio, 1280x720, duration `5.038730`.

## Root Cause Notes

- DNxHR proxy generation itself works when the test source is large enough for the engine's half-resolution DNxHR target. A 640x240 synthetic MP4 produced `5.mxf`; the earlier 320x180 fixture failed because FFmpeg rejects the resulting 160x90 DNxHR target.
- The remaining proxy issue is path semantics: `ProjectManager::getProxiesDir()` still derives `projectDir\proxies`. Moving proxy output to `userDataPath("proxy-cache")` appears to require a native bridge/engine change or a native API for overriding the proxy directory.
- I did not modify `engine` source, CMake, or rebuild native binaries because the prompt explicitly scoped those out.
- Renderer CSP font warnings are visible but are not module-loading or path-resolution failures. I left them unchanged because renderer styling/CSP work was outside the portable path/bundling scope.

## Refactored Call Sites

- `ui/main.js` settings path -> `userDataPath("xleth-settings.json")`.
- `ui/main.js` layout path -> `userDataPath("layout.json")`.
- `ui/main.js` startup log path -> `userDataPath("startup.log")`.
- `ui/main.js` worker path -> `runtimeResource("worker", "addon-worker.js")`.
- `ui/main.js` bridge runtime directory -> `runtimeResource("bridge")`.
- `ui/main.js` FFmpeg runtime directory -> `runtimeResource("ffmpeg")`.
- `ui/main.js` bundled Node path -> `runtimeResource("node", "node.exe")`.
- `ui/main.js` worker `cwd` -> `runtimeResource("bridge")`.
- `ui/main.js` worker `PATH` -> packaged-only bridge, FFmpeg, System32, and Windows entries.
- `ui/main.js` preload path -> `runtimeResource("app", "preload.js")`.
- `ui/main.js` renderer HTML path -> `runtimeResource("app", "dist", "index.html")`.
- `ui/main.js` themes directory -> `userDataPath("themes")`.
- `ui/main.js` main-process FFmpeg CLI calls -> `ffmpegExecutable()` backed by `runtimeResource("ffmpeg", "ffmpeg.exe")` in packaged mode.
- `ui/main.js` startup sample media directory -> `runtimeResource("media")`.
- `ui/preload.js` shared-memory helper path -> `runtimeResource("shm_helper", "shm_helper.node")`.
- `ui/addon-worker.js` native addon and DLL directory -> `XLETH_BRIDGE_DIR` supplied by `ui/main.js` from `runtimeResource("bridge")`.
- `ui/addon-worker.js` FFmpeg CLI/DLL directory -> `XLETH_FFMPEG_DIR` supplied by `ui/main.js` from `runtimeResource("ffmpeg")`.
- `ui/test-addon-load.js` native addon and DLL directory -> `runtimeResource("bridge")`.

## Left Unchanged / Outside Scope

- Shared-memory mapping name and zero-copy frame path were not changed.
- Worker/native-addon architecture was preserved.
- `XlethEngine.exe` is bundled as an artifact but Electron does not spawn it directly.
- Engine source, CMake, vcpkg, audio thread code, preview pipeline, ZPR, MixEngine, and AudioProcessorGraph wiring were not changed.
- Renderer CSP/font warnings were documented but not changed.
