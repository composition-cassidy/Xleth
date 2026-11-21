# Plugin Hosting Log

Running log of the plugin-hosting phases that follow the P0 audit
([PLUGIN_HOSTING_AUDIT.md](PLUGIN_HOSTING_AUDIT.md)). Newest phase last.

---

## P1 — Scan pipeline hardening

Branch `ui-rebuild/phase-0`, on top of `b6ee84e` (P0 audit). WIP commit `e427c4e`, then the
close-out commit that adds this log. VST3 is still the only registered format: no
`JUCE_PLUGINHOST_*` define changed.

### What changed, in one paragraph

The engine now owns the VST3 search folders (`plugin-settings.json`). It enumerates them
per format with JUCE's `searchPathsForPlugins`, which treats a `.vst3` bundle as one item.
That removes the duplicate UniFlange entry at the source, and on load the cache collapses
any bundle/inner-binary duplicate already on disk. Scans are incremental by `fileTime`, and
crash, timeout and failure results persist in `plugin-scan-failures.json` so known crashers
are skipped. A scan builds a new `KnownPluginList` and swaps it in under a mutex. Cancel
merges the partial results into the old list instead of wiping it. Every on-disk file is
written temp-file + rename.

### Files

**Added**

| file | role |
|---|---|
| `tools/test-plugins/CMakeLists.txt` | `XlethTestCrash.vst3` / `XlethTestHang.vst3` fixtures (test-only, not shipped) |
| `tools/test-plugins/src/XlethTestCrash.cpp` | `GetPluginFactory` writes through a null pointer |
| `tools/test-plugins/src/XlethTestHang.cpp` | `GetPluginFactory` sleeps forever |
| `ui/src/components/mixer/__tests__/VstBrowser.searchPaths.test.jsx` | localStorage → engine migration + scan-without-paths |
| `docs/PLUGIN_HOSTING_LOG.md` | this log |

**Changed**

| file | change |
|---|---|
| `engine/src/audio/PluginRegistry.{h,cpp}` | rewritten: settings, failure list, per-format enumeration, incremental/full scan, atomic list swap, non-destructive cancel, cache dedupe, legacy-id fallback, full JSON escaping, atomic writes |
| `scanner/src/ScannerMain.cpp` | `SCAN:<format>\|<path>`, specific `FAIL:` reasons, append-mode log, hard exit on disconnect, SEH filter + no WER dialog, long worker IPC timeout |
| `engine/src/XlethEngineService.cpp` | new/changed handlers (below); hand dispatch of `audio_scanPlugins` removed |
| `bridge/src/XlethAddon.cpp` | hand-written `audio_scanPlugins` wrapper + export removed |
| `ui/rpc-manifest.js` | 5 entries (1 migrated, 4 new) |
| `bridge/src/XlethRpcExports.inc`, `engine/src/XlethRpcDispatch.inc` | regenerated (`scripts/generate-rpc-registries.js`) |
| `ui/preload.js` | hand-written `scanPlugins(paths)` wrapper removed (manifest provides it) |
| `ui/electron-main/vst3.js` | hand-written `xleth:audio:scanPlugins` handler removed |
| `ui/src/components/mixer/VstBrowser.jsx` | folders read/written through the engine; one-time localStorage migration; scan sends `{ mode: 'incremental' }` |
| `ui/src/stores/vstStore.js` | empty `catch {}` → `console.error('[PluginLib] …', err)` |
| `CMakeLists.txt` | `option(XLETH_BUILD_TEST_PLUGINS … OFF)` → `add_subdirectory(tools/test-plugins)` |

### RPCs

All are manifest pass-throughs (`returns: 'value'`), in the `audio.*` namespace of
`window.xleth`.

| method | args | returns |
|---|---|---|
| `audio_scanPlugins` *(changed; moved from hand dispatch into the manifest)* | `{ mode?: 'incremental' \| 'full', retryFailed?: boolean }` (default `incremental`, `retryFailed` false). **No paths.** | `{ ok: true }` or `{ ok: false, error: 'scan-in-progress' \| 'scanner-missing' \| 'bad-mode' }` |
| `audio_cancelPluginScan` *(new)* | — | `{ ok: true, wasScanning: boolean }` |
| `audio_getScanProgress` *(extended)* | — | `{ scanning, done, scanned /* = done, legacy */, total, current /* path */, skippedUnchanged, skippedFailed, failedNew, failedCount /* persisted list size */, cancelled /* last scan */, mode /* 'incremental'\|'full'\|'' */ }` |
| `audio_getPluginSearchPaths` *(new)* | — | `{ [format]: { defaults: string[], user: string[], useDefaults: boolean } }`, one key per registered format (`"VST3"` today) |
| `audio_setPluginSearchPaths` *(new)* | `(format: string, user: string[], useDefaults: boolean = true)` | `{ ok: true }` or `{ ok: false, error: 'scan-in-progress' \| 'unknown-format' \| 'bad-args' \| 'write-failed' }` |
| `audio_getFailedPlugins` *(changed source)* | — | JSON **string** (unchanged transport) of the persisted list: `[{ filePath /* legacy, = path */, path, format, reason, fileTime, firstSeen, lastAttempt, attempts }]` |
| `audio_retryFailedPlugins` *(new)* | `(paths: string[] \| 'all')` | `{ ok: true, removed: number }` or `{ ok: false, removed, error: 'scan-in-progress' \| 'scanner-missing' \| 'nothing-to-retry' \| 'bad-args' }`. It removes those entries, then runs an incremental scan limited to those paths with the failure skip off. |
| `audio_getScannedPlugins` *(unchanged shape)* | — | JSON string `[{ id, name, vendor, category, format, filePath, numInputs, numOutputs, hasEditor }]`, now fully escaped |

Scanner protocol: coordinator → `SCAN:<formatName>|<path>`; worker → `OK:<one
PluginDescription XML per line>` or `FAIL:<reason>`, where the reason is `unknown-format`,
`no-types-found`, `exception` or `bad-request`. The coordinator records `crash` (connection
lost) and `timeout` (no reply within 10 s) itself.

### On-disk files (`%APPDATA%\Xleth\`)

All are written to `<name>.tmp`, then `std::filesystem::rename`, which is MSVC's
`MoveFileExW(MOVEFILE_REPLACE_EXISTING)`.

- **`plugin-settings.json`**, schema 1. Created on the first `audio_setPluginSearchPaths`.
  Until then every format uses `{ user: [], useDefaults: true }`. Unregistered format keys
  read from disk are kept on write.
  ```json
  { "version": 1, "searchPaths": { "VST3": { "user": ["D:\\Plugins\\VST3"], "useDefaults": true } } }
  ```
  VST3 defaults come from `VST3PluginFormat::getDefaultLocationsToSearch()`:
  `%LOCALAPPDATA%\Programs\Common\VST3` and `C:\Program Files\Common Files\VST3`.
- **`plugin-scan-failures.json`**, schema 1.
  ```json
  { "version": 1, "entries": [ { "format": "VST3", "path": "C:\\…\\XlethTestCrash.vst3",
      "reason": "crash", "fileTime": 1794450115301, "firstSeen": "2026-11-12T12:34:06.135+10:00",
      "lastAttempt": "2026-11-12T12:34:06.135+10:00", "attempts": 1 } ] }
  ```
  `reason` is one of `crash`, `timeout`, `no-types-found`, `exception`, `unknown-format`.
  `fileTime` is ms since epoch. For a bundle it is the max mtime of the bundle directory and
  every file in `Contents\*-win\`.
- **`plugin-cache.xml`**: JUCE `KnownPluginList` XML, same format as before. Each entry's
  `fileTime` attribute is now the item's `fileTime` above, which is what incremental
  change detection compares against.
- `scanner-log.txt` sits next to the scanner exe and is opened in append mode. The engine
  rotates it to `scanner-log.prev.txt` once per scan, just before the first scanner launch,
  so a scan that loads nothing leaves it untouched.

### Scan rules as implemented

- **Enumeration.** For each registered format: defaults (if `useDefaults`) plus the user
  folders, then `searchPathsForPlugins(paths, recursive=true, allowAsync=false)`. These calls
  are DLL-free on the engine side.
- **Skip rules.**
  - An item in the failure list whose `fileTime` is unchanged is skipped in both modes,
    unless `retryFailed` is set.
  - In incremental mode, an item whose cached entries all match its `fileTime` keeps them
    without being loaded. "Owned" means `fileOrIdentifier` is the item path or lies inside it.
  - Everything else is scanned.
- **Lazy launch.** The scanner process is spawned only when the first item actually needs
  loading.
- **Merge.** The new list starts from the previous one.
  - Entries owned by an attempted item are replaced by its fresh results, or dropped if it
    failed.
  - Nothing else is touched unless the scan completed unrestricted. In that case, entries
    owned by no enumerated item are dropped and logged: the file no longer exists, or it is
    outside the search paths.
  - The list is swapped under `listMutex_`, then saved. `scanning` goes false last.
- **Readers.** `findPluginByIdentifier`, `getPluginListAsJSON` and `saveScanResults` copy the
  `shared_ptr` snapshot under the same mutex. Their only callers are message-thread RPCs and
  `AudioGraph::addNode` / `createEffect` / `fromJSON` (message thread). The audio thread
  never touches the registry.
- **Lookup fallback.** If the exact `createIdentifierString()` doesn't match, the legacy
  `<format>-<name>-<hex pathhash>-<hex uid>` form is parsed and matched on format plus
  `uniqueId` **or** `deprecatedUid`, with the name as tie-break. Logged as `[PluginReg] legacy id …`.

### Smoke results

These were run against the freshly built `bridge/build/Release/xleth_native.node` from a
standalone Node harness, one process per "app start", with `XLETH_STRICT_IPC=1`, against the
real `%APPDATA%\Xleth`. The user's data was restored afterwards.

1. **PASS. Clean full scan of the default folders → UniFlange once.**
   `VST3: 1 folder(s) searched, 221 item(s) found` … `complete: 218 scanned ok, 3 failed …
   list 22 -> 220 … in 179.8s`. UniFlange appears once:
   `VST3-UniFlange-e566882c-ad82305`, `…\XLETH\UniFlange.vst3` (bundle path).
   The 3 real failures were Guitar Rig 6 (`exception`: JUCE "Cannot resolve plugin FX"),
   ZENOLOGY (`timeout`) and Addictive Drums 2 (`timeout`).
2. **PASS. Restart with the old duplicated cache → one entry plus a collapse line.**
   `[PluginReg] collapsed duplicate VST3 "UniFlange": kept …\UniFlange.vst3\Contents\x86_64-win\UniFlange.vst3 (2/2 io), dropped …\UniFlange.vst3 (0/0 io)`,
   `loaded 22 plugin(s) … (1 duplicate(s) collapsed)`. On disk: 23 → 22 entries.
   *Caveat:* see deviation 9 on how the 2-entry file was rebuilt.
3. **PASS. Incremental right after → nothing loaded.**
   `incremental scan: 221 item(s), 0 to scan, 218 unchanged, 3 known failure(s) skipped`,
   `in 0.0s`. `scanner-log.txt` was byte-identical before and after (md5
   `5bca908b59b528c9745a95a4e6140b5b`, same mtime). No new `[PluginScanner] [pid N] Process
   started` line, so the scanner was never spawned. `skippedUnchanged` (218) equals the
   number of files that have cache entries. The other 3 are counted in `skippedFailed`.
4. **PASS. Crash and hang fixtures.**
   - The fixtures were built standalone (`cmake -S tools/test-plugins`) and their folder was
     added as a VST3 user path.
   - First scan: `FAILED …XlethTestCrash.vst3: crash`, `FAILED …XlethTestHang.vst3:
     timeout`. Both landed in `plugin-scan-failures.json` with those reasons, and the engine
     stayed responsive.
   - Scanner log for the crash fixture: `FATAL: unhandled exception 0xC0000005 while
     scanning "…XlethTestCrash.vst3"`. For the hang fixture: `Coordinator disconnected —
     exiting`. No scanner process was left behind.
   - Incremental rescan: `0 to scan, 218 unchanged, 5 known failure(s) skipped`, and the
     scanner log was unchanged (never spawned).
   - `audio_retryFailedPlugins([crash path])` → `{ok:true, removed:1}`, `incremental scan
     (restricted): 1 item(s), 1 to scan`, attempted again → `crash`.
   - Timing after the IPC-timeout change: crash detected in 2.0 s (4.1 s total), hang in
     10.0 s (10.1 s total). Before the change: 16.1 s and 18.1 s.
5. **PASS. Cancel a full scan halfway → the cache keeps everything.**
   Cancelled at `110/221`: `CANCELLED: 108 scanned ok … list 220 -> 220 (kept 111, replaced
   109 …)`. Cache entries before 220, after 220, lost 0.
6. **PASS. `audio_setPluginSearchPaths` during a scan.**
   It returned `{"error":"scan-in-progress","ok":false}`, and so did a second
   `audio_scanPlugins`. The paths were unchanged afterwards.
7. **PASS (engine). FX-chain preset with the pre-P1 UniFlange id.**
   - The preset id `VST3-UniFlange-753847fd-ad82305` (the inner-binary path) is not in the
     list. Only `…-e566882c-…` is.
   - Applying the FX Chain Library `effects` array through
     `audio_applyMasterEffectChainPreset` gives `[PluginReg] legacy id
     "VST3-UniFlange-753847fd-ad82305" resolved by format+uid to
     "VST3-UniFlange-e566882c-ad82305"`, `{"added":1,…,"skipped":[]}`, and the chain node
     has `missing:false, crashed:false`.
   - A project whose stored `pluginDescription` points at the dropped inner-binary path
     (with the legacy `pluginId`) loads through `project_load` with `missing:false` and
     `getMissingPlugins` → `[]`. `fromJSON` still instantiates from the stored description.

Also run:

- `bridge/test_rpc_manifest.js`: **354/354**.
- `generate-rpc-registries.js --check`: clean.
- Related vitest (`rpcManifest`, `components/mixer`, `fx-chains`): **601/601**.
- New `VstBrowser.searchPaths.test.jsx`: **4/4**.
- Full vitest: **5367 passed, 2 skipped, 0 failed** (336 files).
- `cmake --build bridge/build` (addon + scanner) and `cmake --build build` (root: engine,
  scanner, editor host, all engine test exes): both exit 0.

### Deviations from the P1 prompt

1. **`build.bat` was not run.** Its dispatch does `taskkill /F /IM electron.exe`, and the
   user's dev app was running. The same compiles ran directly instead: `cmake --build
   bridge/build --config Release` (what `build.bat bridge` compiles) and `cmake --build build
   --config Release` (`build.bat engine`). The locked `xleth_native.node` was renamed aside
   (`xleth_native.node.inuse-*`) so the link could proceed.
2. **`audio_scanPlugins` moved into the RPC manifest.** It used to be hand-dispatched because
   `vst3.js` reshaped the path list. With an options object there is nothing to reshape, and
   the old reshape (`paths.length ? [paths] : []`) would have silently dropped the object.
3. **New RPC `audio_cancelPluginScan`.** No cancel RPC existed (`cancelScan()` was
   unreachable from the UI), and smoke test 5 needs one.
4. **Migration trigger.** `audio_getPluginSearchPaths` returns the pure `{[format]: …}` map,
   so the renderer cannot tell whether `plugin-settings.json` exists. The rule is: if the
   legacy key is present, union-merge it into `VST3.user` and delete the key only on
   `{ok:true}`. This is idempotent. Against an old engine the write fails and the key is
   kept.
5. **Lookup fallback matches `uniqueId` or `deprecatedUid`.** JUCE embeds `uniqueId` in the
   id when it is non-zero. UniFlange's id ends in `ad82305` (its `uniqueId`); its
   `deprecatedUid` is `961d138`. Matching only the deprecated uid would never resolve it.
6. **Stale pruning also covers entries outside the search paths**, not only files that no
   longer exist. This applies only on a completed, unrestricted scan. It replaces the old
   "clear everything" behaviour, so removing a folder still removes its plugins. Cancelled
   and retry scans never prune.
7. **IPC timeouts were tuned (not asked).** Coordinator: `launchWorkerProcess(…, 2000)`.
   Scanner: `initialiseFromCommandLine(…, 120000)`. The JUCE default of 8 s cost 8 s to
   detect a dead scanner plus 8 s to tear the pipe down: 16 s per crasher, measured. The
   long worker-side timeout stops a slow (not hung) plugin from making the scanner give up
   on itself, because its ping countdown only resets on the IPC thread that sits inside the
   plugin. A full re-scan of all 223 items gave the same 218 OK and the same failures, so no
   slow load was misread as a crash.
8. **The scanner exits hard** (`TerminateProcess`) on disconnect and on an unhandled SEH
   fault, after logging it. It also sets `SEM_NOGPFAULTERRORBOX`. A normal return would join
   a thread stuck in the plugin, and a WER dialog would turn a crash into a timeout.
9. **Smoke 2's original file.** The on-disk 23-entry `plugin-cache.xml` (2026-06-12) was
   rewritten at 12:22 by another process that loaded the new addon the moment it linked. The
   user's app worker was not it: it was still the 11:58 process running the old engine. That
   happened before the backup copy was taken. The 2-entry version was rebuilt from the
   collapsed file plus the exact audit §8 values for entry B (bundle path, 0/0 I/O,
   `fileTime 19d004aee9b`, same `uniqueId`/`uid`). Restored afterwards as
   `%APPDATA%\Xleth\plugin-cache.xml` (and `plugin-cache.pre-p1-backup.xml`).
10. **Retry semantics.** `audio_retryFailedPlugins` removes the entry before rescanning, as
    specified, so a file that fails again starts a fresh entry (`attempts: 1`, new
    `firstSeen`). `attempts` grows only for failures that recur without a retry.
11. **Additive fields.** In `getScanProgress`: `scanned` (= `done`, for `ScanProgressBar`),
    `skippedFailed`, `cancelled`, `mode`. In `getFailedPlugins`: the legacy `filePath`,
    which `VstBrowser` renders.
12. **A file that fails a rescan loses its cached entries.** It was re-scanned, so it is not
    "unchanged". A plugin that now crashes on load should not stay insertable.

### Found, not fixed

- **The FX Chain Library flags legacy-id presets as "not installed".**
  `FxChainMenuLayer.jsx:83` → `findUnavailablePluginIds` does an exact-id `Set` check, so a
  preset holding a pre-P1 id shows ▲ even though loading it works (the engine resolves it,
  smoke 7). P3 (migration map) or P4 (browser) should resolve ids through the engine.
- **Fast-path descriptions report 0/0 I/O.** A bundle with `moduleinfo.json` is described
  without loading the DLL, so any fresh scan stores UniFlange as `0/0`. The dedupe keeps the
  2/2 inner entry only until the next scan replaces it. The P3 library should not rely on
  these counts, or the scanner could force the slow path.
- **The 10 s per-file timeout is too short for some real instruments.** ZENOLOGY and
  Addictive Drums 2 time out on every scan. They may just be slow, or they may show a
  dialog. Consider a longer or configurable timeout, or a single retry with a longer
  timeout.
- **Instruments are listed as effects** (audit §6). The default-folder scan here has 220
  entries, VSTis included.
- **`useDefaults: true` widens the scan.** It is the spec's default, so the user's next scan
  covers the whole `C:\Program Files\Common Files\VST3` (221 items here) instead of only the
  subfolders they had added (22 plugins). The UI to turn defaults off is P5.
- **A running app on old binaries.** With a renderer hot-reloaded against an older
  main/engine, `VstBrowser` shows no folders and Scan does nothing until the app restarts on
  the new addon. Migration fails safe in that state: the legacy key is kept.
- **Bridge/contract tests share the real `%APPDATA%\Xleth`.** Any process that loads the
  addon runs `loadScanResults` on the real cache, and since P1 can rewrite it (collapse).
  `PluginRegistry(const juce::File& dataDir)` exists for tests, but `MixEngine` always uses
  the default.
- **A plugin that opens a modal dialog during a scan** blocks until the 10 s timeout. There
  is no headless guard.
- **Pre-existing warnings seen while building:** `XlethDelayEffect.h(463)` C4390 (empty
  controlled statement) and `MixEngine.cpp(4629)` C4858 (discarded return value).

### Not done (out of scope by instruction)

- No VST2 or CLAP, and no `JUCE_PLUGINHOST_*` change.
- No plugin menu or `VstBrowser` redesign. The only UI work is the migration and moving its
  folder list onto the engine.
- Project plugin storage and `fromJSON` are unchanged.
- No changes to the editor host, `MixEngine::addEffect` locking or undo.
- Scanning never moved in-process, and JUCE's dead-man's-pedal is not used.
- Nothing was pushed.

---

## P2 — Host safety & editor host

Branch `ui-rebuild/phase-0`, on top of `87d06c1` (P1 close-out). Code commit `52998b3`, then
the commit that adds this section. VST3 is still the only
registered format: no `JUCE_PLUGINHOST_*` define changed, and nothing in the engine process
loads a DLL to inspect it.

### What changed, in one paragraph

Before the scanner is ever spawned, the engine now parses each plugin binary's PE headers
(machine type and export names, read as bytes) and records a binary it could never load as a
"can't load" failure. Every third-party load in the engine — insert, project load, resolve —
is wrapped in a breadcrumb file that names the plugin and the phase. It is written before the
plugin code runs and deleted when the load finishes or fails cleanly. If the engine dies
mid-load, Electron names the plugin in the error the UI gets. The next engine start turns the
breadcrumb into a quarantine entry and a one-time notice. A quarantined plugin is never
instantiated by a project load: it becomes the usual missing-plugin placeholder (state kept)
with reason `quarantined` until it is unquarantined. The editor host now receives the exact
`PluginDescription` plus the engine's sample rate and block size (INIT protocol v2), so it
opens the right class instead of `descriptions[0]` at 48000/480. A stale exe is reported as
`protocol-mismatch` instead of opening the wrong plugin or hanging.

### Files

**Added**

| file | role |
|---|---|
| `engine/src/audio/PluginBinaryInspector.{h,cpp}` | PE preflight: machine, export names, VST3 bundle resolution, per-format required-export table. Pure std, no JUCE. Built as the `XlethPluginInspect` static lib. |
| `engine/src/audio/PluginLoadBreadcrumb.{h,cpp}` | RAII breadcrumb scope (`begin` / `setPhase` / `finish`), startup `takeOrphan`, pid liveness |
| `engine/test/test_plugin_binary_inspector.cpp` | ctest: System32 x64 DLL, SysWOW64 x86 DLL, text renamed `.dll`, 512-byte truncation, prefix sweep, VST3 bundles, missing path |
| `tools/test-plugins/src/XlethTestNoEntry.cpp` | x64 bundle whose DLL exports `XlethTestNotTheFactory` only |
| `tools/test-plugins/src/XlethTestCrashOnCreate.cpp` | SDK-free `IPluginFactory`; `createInstance` writes through null (`XLETH_TEST_CRASH_HARD=1` → `__fastfail`) |
| `tools/test-plugins/src/XlethTestCrashOnCreate.moduleinfo.json` | copied into the bundle's `Contents\Resources\`, so the scan takes JUCE's fast path and never calls `createInstance` |
| `ui/src/components/__tests__/pluginQuarantine.test.jsx` | notice fires once; quarantined dialog row → `unquarantinePlugin` |

**Changed**

| file | change |
|---|---|
| `engine/CMakeLists.txt` | `XlethPluginInspect` lib (linked PUBLIC into `XlethEngineCore`), `PluginLoadBreadcrumb.cpp`, `test_plugin_binary_inspector` + `add_test` |
| `engine/src/audio/PluginRegistry.{h,cpp}` | preflight in the scan loop; quarantine list (load/save/query/unquarantine); startup breadcrumb recovery; `takeLastLoadCrash`; `getDataDir` |
| `engine/src/audio/AudioGraph.{h,cpp}` | breadcrumb at `addNode`/`createEffect` (insert), `fromJSON` (projectLoad) and `tryResolvePlugin` (resolveMissing); quarantine → placeholder; `tryResolvePlugin` refuses quarantined; `missingReason` + quarantine key on missing nodes; `getPluginDescription` |
| `engine/src/audio/EffectChainManager.{h,cpp}` | `getPluginDescription` pass-through |
| `engine/src/audio/EditorProcessCoordinator.{h,cpp}` | INIT v2 (`buildInitMessage`), `VERS` ack, version guard, `isProtocolMismatch` |
| `engine/src/audio/MixEngine.{h,cpp}` | `openPluginEditor` sends the description + current rate/block, records `getLastEditorOpenError()`, reaps a failed coordinator off-thread; `getMissingPluginsJSON` keeps the graph's `pluginVendor` |
| `editor-host/src/EditorHostMain.cpp` | parses INIT v2, replies `VERS` or `ERR_ protocol-mismatch`, instantiates exactly the given description at the given rate/block (the argv test fallback keeps `findAllTypesForFile`) |
| `engine/src/XlethEngineService.cpp` | `Audio_GetLastLoadCrash`, `Audio_UnquarantinePlugin`; additive `error` on `audio_openPluginEditor` |
| `ui/rpc-manifest.js` | 2 entries |
| `bridge/src/XlethRpcExports.inc`, `engine/src/XlethRpcDispatch.inc` | regenerated (`scripts/generate-rpc-registries.js`) |
| `ui/electron-main/worker.js` | `worker.on('exit')` reads the breadcrumb (pid-checked) and names the plugin; `getLastExitPlugin()` |
| `ui/src/XlethRoot.jsx` | one startup toast for `audio.getLastLoadCrash()` through the existing `ToastProvider` |
| `ui/src/components/MissingPluginsDialog.jsx` | quarantined row says so; its Retry calls `audio.unquarantinePlugin` |
| `ui/src/components/devices/EffectDevice.jsx` | status line for a quarantined placeholder |
| `tools/test-plugins/CMakeLists.txt` | the two fixtures + moduleinfo copy |

### RPCs

Both new methods are manifest pass-throughs (`returns: 'value'`) in `window.xleth.audio.*`.

| method | args | returns |
|---|---|---|
| `audio_getLastLoadCrash` *(new)* | — | `null`, or the breadcrumb of the load that killed the previous engine: `{ version: 1, pid, format, name, vendor, fileOrIdentifier, uniqueId, deprecatedUid, phase, context, ts, quarantined: true }`. **Consuming it clears it**, so the second call returns `null`. |
| `audio_unquarantinePlugin` *(new)* | `(format: string, uniqueId: string \| number, deprecatedUid: string \| number)`. Uids are the lower-case hex strings reported by `getMissingPlugins` / `getLastLoadCrash`; a number is converted to hex. | `{ ok: true, removed: boolean, resolved: number, failed: number }` or `{ ok: false, error: 'bad-args' }`. It removes the entry, then retries every placeholder of that plugin through `MixEngine::tryResolvePlugin` (breadcrumb context `resolveMissing`, so a repeat crash re-quarantines it). |
| `audio_openPluginEditor` *(additive)* | unchanged | `{ hasEditor }`, plus on failure `error: 'protocol-mismatch' \| 'editor-host-missing' \| 'editor-host-error' \| 'timeout' \| 'no-description'` |
| `audio_getMissingPlugins`, `audio_getEffectChain`, `audio_getMasterEffectChain` *(additive)* | unchanged | A missing node also carries `missingReason: 'quarantined' \| 'missing'`. A missing VST node also carries `pluginFormat`, `pluginVendor`, `uniqueId` and `deprecatedUid` (hex). `missingReason` is computed live from the quarantine list, so it flips to `missing` the moment the plugin is unquarantined. |

### Quarantine storage: a separate `plugin-quarantine.json`

It is **not** a new reason in `plugin-scan-failures.json`. That list is keyed by path and
driven by scans: prune-on-complete, `fileTime` skips, and `audio_retryFailedPlugins` removing
entries. A load crash is keyed by **format + uniqueId + deprecatedUid**, so a moved or
reinstalled plugin stays quarantined. Mixing the two would let a scan silently un-quarantine
it. All three files below live in `%APPDATA%\Xleth\` and are written temp-file + rename.

- **`plugin-load-inflight.json`** (the breadcrumb):
  `{ version: 1, pid, format, name, vendor, fileOrIdentifier, uniqueId, deprecatedUid, phase: "instantiate"|"prepare"|"setState", context: "insert"|"projectLoad"|"resolveMissing", ts }`.
- **`plugin-quarantine.json`**, schema 1:
  ```json
  { "version": 1, "entries": [ { "format": "VST3", "uniqueId": "e783521a", "deprecatedUid": "5923c135",
      "name": "XlethTestCrashOnCreate", "vendor": "Xleth Test", "fileOrIdentifier": "…\\XlethTestCrashOnCreate.vst3",
      "phase": "instantiate", "context": "insert", "crashedAt": "2026-11-12T13:18:24.951+10:00", "crashes": 1 } ] }
  ```
  A second crash of the same key increments `crashes` instead of adding a row.
- **`plugin-load-crash.json`**: the recovered breadcrumb plus `quarantined: true`. It is kept
  until `audio_getLastLoadCrash` consumes it, so the notice survives an engine start that
  never reached the UI.

### Breadcrumb rules as implemented

- **Where.** One RAII type, `PluginLoadBreadcrumb`, at three choke points:
  - `AudioGraph::addNode` → `createEffect` (context `insert`). `createEffect` opens it before
    `createPluginInstance`. If no scope is passed, it uses a local one.
  - `AudioGraph::fromJSON` (`projectLoad`).
  - `AudioGraph::tryResolvePlugin` (`resolveMissing`).
- **Phases.** `instantiate` covers `createPluginInstance` and the `GuardedPluginWrapper`
  constructor, which negotiates buses. It changes to `prepare` before `addProcessorToGraph`:
  the APG rebuilds synchronously on the message thread, so the plugin's `prepareToPlay` runs
  there. It changes to `setState` before `setStateInformation`.
- **Clearing.** The scope's destructor deletes the file. This covers success, clean failure,
  a `nullptr` instance, and an SEH-caught fault.
- **Thread.** Always the JUCE message thread (the worker's Node main thread). Never the
  audio thread.
- **Write cost.** One small temp-file write and rename per phase. No `FlushFileBuffers`: a
  process crash does not lose data already handed to the OS.
- **Startup.** `PluginRegistry::initialise` runs `recoverLoadCrash()`. If the file exists and
  its pid is not a live process, it is moved into the quarantine and `plugin-load-crash.json`.
  If the pid is live (another engine is mid-load), the file is left alone.
- **Blind vs explicit loads.**
  - **Blind loads are refused for a quarantined plugin:** `fromJSON` (projects, FX-chain
    loads) and `tryResolvePlugin` (`audio_retryMissingPlugin`).
  - **An explicit insert is allowed** and logged
    (`[PluginHost] inserting quarantined plugin … on explicit request`). See deviation 3.

### Preflight rules as implemented

- **When it runs.** In `PluginRegistry::runScan`, for every item in the work list, before the
  lazy scanner launch and before `SCAN:`. Items skipped as unchanged or as known failures are
  not re-inspected.
- **Non-`Ok` result.** The item is recorded in `plugin-scan-failures.json` (`attempts`,
  `fileTime`, as in P1) and counted as attempted, so stale cache entries for it are dropped.
  The scanner is never spawned for it.
- **Reasons**, distinct from the scanner's `crash` / `timeout` / `no-types-found` /
  `exception` / `unknown-format`:

  | status | reason | meaning |
  |---|---|---|
  | `WrongArch32` | `not-64bit` | `IMAGE_FILE_MACHINE_I386`, or a bundle with only `Contents\x86-win\` |
  | `WrongArchArm64` | `arm64` | `IMAGE_FILE_MACHINE_ARM64`, or a bundle with only `arm64*-win` |
  | `NoEntryPoint` | `no-entry-point` | none of the format's required exports (VST3 `GetPluginFactory`; VST `VSTPluginMain`/`main`; CLAP `clap_entry`) |
  | `NotPE` | `not-a-binary` | no MZ/PE, an unknown machine, any out-of-bounds header/section/export offset (truncation), or a bundle with no Windows binary |
  | `Unreadable` | `unreadable` | missing or cannot be opened |

- **Parser.** Reads only the DOS header, COFF header, optional header data directories,
  section table, export directory and name strings, each with a bounds check against the file
  size. It caps sections at 96, names at 65 536, and name length at 1 KiB. The RVA → file
  offset map goes through the section table; a zero-filled tail counts as not on disk.
- **Logging.** `[PluginPreflight] VST3 <path>: <reason> (machine=…, N export(s), binary …) - not sent to the scanner`.
  The completion line now reads `N failed (M by preflight)`.

### INIT protocol v2

Coordinator → editor host. One `key=value` per line; `desc` is **last**, and its value runs to
the end of the message:

```
INIT
protocolVersion=2
sampleRate=<double, e.g. 48000.000>
blockSize=<int>
parentHwnd=<uppercase hex HWND, or empty>
state=<base64 plugin state, or empty>
desc=<PluginDescription::createXml(), TextFormat().singleLine().withoutHeader()>
```

- **New host reply.** `VERS\n2` as soon as it accepts a valid INIT. If `protocolVersion` is
  missing or different, it replies `ERR_\nprotocol-mismatch` and quits. A malformed v2 INIT
  gets `ERR_\nbad-init: description|rate/block`.
- **Engine.** An `ERR_` that arrives **before** `VERS`, or `ERR_ protocol-mismatch`, sets
  `isProtocolMismatch()`. The engine then logs
  `[EditorHost] stale editor-host exe — rebuild (bridge-clean)`. A pre-v2 exe reads
  `protocolVersion=2` as a plugin path and fails fast with `ERR_ no plugins found in: …`, so
  this catches a stale exe next to a fresh `.node`.
- **Instantiation.** The host calls `createPluginInstance(desc, sampleRate, blockSize, error)`
  with exactly that description. It never calls `findAllTypesForFile` on this path; only the
  manual `xleth-editor-host.exe <path>` fallback still does.
- **Unchanged.** PARM, STAT, STRM, STOP, CLOS, REDY and CLSD.

### Electron side

- **`worker.on('exit')`.** It reads `plugin-load-inflight.json` and checks that `crumb.pid`
  equals the worker's pid. If so, `addonError` and every pending rejection become
  `XLETH's engine stopped while loading <name> by <vendor> (<phase>, exit code N)`. The Error
  objects also carry `{ plugin, vendor, phase }`. `getLastExitPlugin()` returns the same
  triple. There is no respawn.
- **Startup notice.** `XlethRootInner` calls `reportLastPluginLoadCrash` on mount, which shows
  an `error`-level toast through the existing `ToastProvider`/`showToast`. The engine read and
  the toast sit inside one module-level promise, so a StrictMode double mount neither loses
  the consumed record nor shows it twice.

### Smoke results

**How they were run.** A standalone Node harness drives the **real**
`ui/electron-main/worker.js`, which forks the real `ui/addon-worker.js` and the freshly built
`bridge/build/Release/xleth_native.node`. Only `require('electron')` is stubbed. One worker
process stands for one "app start". `XLETH_STRICT_IPC=1`, against the real `%APPDATA%\Xleth`;
`%APPDATA%\Xleth` was backed up first and restored afterwards (cache byte-identical).
Fixtures were built standalone (`cmake -S tools/test-plugins`) and copied into two scratch
folders: A = NoEntry plus two extra preflight inputs, B = CrashOnCreate. Search paths were
`[…\VST3\XLETH, A, B]` with `useDefaults:false`.

1. **PASS. Preflight unit tests.** `ctest -R test_plugin_binary_inspector`: `ALL TESTS PASSED (32 checks)`.
   - System32 `kernel32.dll` → `Ok`, `AMD64`, more than 500 exports including `CreateFileW`;
     with `VST3` → `NoEntryPoint`.
   - SysWOW64 `kernel32.dll` → `WrongArch32` / `I386`.
   - Text renamed `.dll` → `NotPE`; `MZ` + garbage → `NotPE`.
   - The first 512 bytes of the x64 DLL → `NotPE`, with or without a format.
   - Prefix sweep, 0–4096 bytes in steps of 16 → no crash, never `Ok`.
   - VST3 bundles: `x86_64-win` → parses the inner binary; `x86-win` only → `WrongArch32`;
     no binary → `NotPE`. A missing path → `Unreadable`.
   - Installed `UniFlange.vst3` → `Ok`.
2. **PASS. `XlethTestNoEntry` → `no-entry-point`, scanner never spawned.**
   - The scan of folder A ended `done 11, failedNew 3, skippedUnchanged 8`, with
     `[PluginPreflight] … XlethTestNoEntry.vst3: no-entry-point (machine=AMD64, 1 export(s), …) - not sent to the scanner`.
   - The extra inputs gave `XlethTestOld32.vst3: not-64bit (machine=I386)` and
     `XlethTestNotABinary.vst3: not-a-binary`. All three are in `plugin-scan-failures.json`
     with those reasons.
   - `scanner-log.txt` was byte-identical before and after (`1759B md5=4c1399a9…`, same
     mtime). `scanner-log.prev.txt` was also unchanged, so no rotation happened, and there
     were **0** `scanner launched` lines during that scan. Neither log mentions any of the
     three.
   - The following scan of B launched the scanner once, and CrashOnCreate scanned OK through
     the moduleinfo fast path: `VST3-XlethTestCrashOnCreate-71540c43-e783521a`.
3. **PASS — both branches exercised.**
   - **SEH branch (the fixture as specified: null write in `createInstance`).**
     `audio_addMasterEffect` rejected after 7 ms with `Failed to add master effect…`. The log
     shows `[PluginHost] CRASH: "XlethTestCrashOnCreate" during createPluginInstance — not loaded`.
     **The breadcrumb file was gone, and the engine was alive:** the next
     `getMasterEffectChain` answered with the chain intact.
   - **Engine-death branch.** This used the same fixture with `XLETH_TEST_CRASH_HARD=1`
     (`__fastfail`, which SEH cannot catch).
     - The worker exited with code `3221226505` (0xC0000409).
     - The pending call rejected with
       **`XLETH's engine stopped while loading XlethTestCrashOnCreate by Xleth Test (instantiate, exit code 3221226505)`**,
       and the error carried `plugin/vendor/phase`. `getLastExitPlugin()` returned
       `{plugin:"XlethTestCrashOnCreate",vendor:"Xleth Test",phase:"instantiate"}`.
     - The breadcrumb stayed on disk with the dead worker's pid, `phase:"instantiate"`,
       `context:"insert"`.
   - **Next start.**
     - The log shows `[PluginHost] previous engine (pid 11236) died while loading VST3 "XlethTestCrashOnCreate" by Xleth Test (phase instantiate, context insert) - quarantined`.
     - `plugin-quarantine.json` has 1 entry.
     - `audio_getLastLoadCrash` #1 returned the object (**one notice**); #2 returned `null`.
   - **Project load.** A project whose master chain holds CrashOnCreate with state
     `UDItU1RB…` (29 bytes) loaded with
     `[PluginHost] "XlethTestCrashOnCreate" is quarantined … placeholder kept, state preserved (29 bytes)`.
     - `getMissingPlugins` returned `missingReason:"quarantined"`, `pluginFormat:"VST3"`,
       `uniqueId:"e783521a"`, `deprecatedUid:"5923c135"`, `pluginVendor:"Xleth Test"`.
     - `audio_retryMissingPlugin` returned `{success:false}`
       (`… is quarantined - not resolved`).
     - `project_save` wrote the node back with `missing:true`, the description, and
       **`state` identical to the original**.
   - **Retry.** `audio_unquarantinePlugin("VST3","e783521a","5923c135")` returned
     `{ok:true, removed:true, resolved:0, failed:1}`.
     - The retry really ran: `CRASH … (retry) — placeholder kept`. With the soft fixture it
       is SEH-caught, the breadcrumb is gone, and the engine is alive.
     - Afterwards the quarantine list was empty and the row's `missingReason` was `missing`.
     - A second unquarantine returned `removed:false`; bad arguments returned
       `{ok:false, error:'bad-args'}`.
   - Re-run on the final binary: same results.
4. **PASS (single class). UniFlange editor.** `audio_openPluginEditor` returned
   `{hasEditor:true}` in 592 ms.
   - `editor-host.log`: `Sending VERS 2`;
     `init v2 received plugin="UniFlange" format=VST3 uid=ad82305 … sr=48000.0 bs=480 stateLen=3684`;
     `loading exact description "UniFlange" (VST3 uid=ad82305) at 48000.0 Hz / 480`;
     `REDY 900x390`.
   - No `findAllTypesForFile` and no argv fallback. `isPluginEditorOpen` was true and
     `closePluginEditor` succeeded.
   - **Multi-class: not tested.** No multi-class VST3 is installed here: the cache has no two
     entries sharing a file.
5. **PASS. Pre-change `xleth-editor-host.exe`** (the Nov 9 build, saved before any rebuild)
   swapped into `bridge/build/Release`.
   - `audio_openPluginEditor` returned **`{hasEditor:false, error:"protocol-mismatch"}` in 94 ms**.
   - The engine log: `ERR_ received: no plugins found in: protocolVersion=2` →
     `[EditorHost] stale editor-host exe — rebuild (bridge-clean)`.
   - The first run took **8097 ms**. The failed coordinator was destroyed inline and blocked
     for JUCE's 8 s IPC teardown, which is why it is now reaped off-thread (deviation 8).
   - After restoring the v2 exe, the editor opened again in 641 ms.

Also run:

- `build.bat engine` → `[build.bat] engine OK`: root engine, all engine test exes, the
  scanner and the editor host.
- `cmake --build bridge/build --config Release` (addon + scanner + editor host): exit 0. No
  new warnings in the touched files; `EditorHostMain.cpp(113)` C4996 `fopen` is pre-existing.
- Full `ctest --test-dir build -C Release`: **97/101 pass**. The 4 failures are all on the known-failing baseline (`test_flip_orientation_golden`, `test_xlethfilter_analog`, `test_frame_collector`, `test_real_render`); none is plugin-related.
- `bridge/test_rpc_manifest.js`: **356/356**. `generate-rpc-registries.js --check`: clean.
- vitest over `components/__tests__`, `components/mixer`, `components/devices`,
  `stores/__tests__` and `src/__tests__`: **78 files, 1031 tests, all passed**. That includes
  the new `pluginQuarantine.test.jsx` (3/3). Its first version caught a real double-toast bug
  under concurrent mounts, fixed before commit.
- eslint on the touched UI files: clean.

### Deviations from the P2 prompt

1. **`build.bat bridge` was not run.** Its `npx cmake-js` misdetects VS2026 on this machine
   ("no VC++ compiler"), independent of this change. The bridge was built with
   `cmake --build bridge/build --config Release`, as in P1. `build.bat engine` was run and
   passed.
2. **Commits.** The three parts share `MixEngine`, `XlethEngineService.cpp`, the manifest and
   the registries, and those files carry another session's uncommitted WIP. So the code went
   in as **one** commit, with each mixed file staged as HEAD + only the P2 hunks
   (blob reconstruction), followed by a docs commit. It was not one commit per build.
3. **An explicit insert of a quarantined plugin is allowed** (logged); only blind loads are
   refused (project/FX-chain `fromJSON`, `tryResolvePlugin`). Refusing inserts would leave no
   UI way out of quarantine for a plugin that crashed on insert: it is in no project, so there
   is no placeholder row to retry.
4. **Minimal UI wiring beyond the notice.**
   - `MissingPluginsDialog`: a quarantined row's detail reads "Quarantined: it crashed XLETH's
     engine while loading", and its existing **Retry** button calls `audio.unquarantinePlugin`.
   - `EffectDevice`: the status line for a quarantined placeholder.
   - Without these, the new state could not be seen or left from the UI. There is no new
     surface and no redesign.
5. **`ERR_` framing.** The host sends `ERR_\nprotocol-mismatch` (the existing `ERR_\n<message>`
   framing), not `ERR_:protocol-mismatch`. The engine also treats any `ERR_` before `VERS` as
   a mismatch, because a pre-v2 exe cannot know to say "protocol-mismatch".
6. **New `VERS` message** (host → engine), needed for 5.
7. **The INIT `desc` is single-line XML** (`singleLine().withoutHeader()`) and the last field,
   so line framing stays unambiguous. The host also accepts multi-line XML there.
8. **A failed editor open hands its coordinator to the existing reaper thread** after
   detaching it from the plugin (`setWorkerPlugin(nullptr)`). Smoke 5 measured 8.1 s → 94 ms.
9. **`getMissingPluginsJSON` keeps `pluginVendor`** from the graph instead of overwriting it
   with `""`.
10. **Fixture extras.** `XLETH_TEST_CRASH_HARD=1` makes `XlethTestCrashOnCreate` uncatchable,
    so the engine-death path can be tested on demand; SEH catches the null write. Smoke 2 also
    used a 32-bit bundle (a SysWOW64 DLL under `x86-win`) and a text `.vst3`.
11. **Unit tests use the existing ctest harness** (`add_executable` + `add_test`), not a new
    `XLETH_BUILD_TESTS` option. The prefix sweep steps 16 bytes: step 1 took 50 s because
    every PE-looking write is AV-scanned.
12. **`XlethPluginInspect` is a standalone static lib** the scanner could link, but **the
    scanner does not call it**. The engine never sends it a binary that fails preflight.
13. **`missingReason` is not persisted.** It is recomputed on load from the quarantine list,
    so the project format is unchanged.

### Found, not fixed

- **UI callers ignore `audio_openPluginEditor`'s result.** `EffectDevice.jsx`,
  `effectEditorOpeners.js` and `EffectModule.jsx` drop `{hasEditor:false, error}`. The
  protocol-mismatch error therefore reaches the RPC result and the engine log, but no toast.
- **New exe + v1 INIT is not exercised end-to-end** (old `.node` with a fresh exe → host
  `ERR_ protocol-mismatch`). It needs a pre-change engine build. The code path is the same
  version check smoke 5 hit from the other side.
- **No multi-class VST3 is installed**, so the per-class editor check (smoke 4, part 2) was not
  run.
- **Concurrent engines share one breadcrumb file.** With the dev app and a test harness both
  loading plugins, one engine's `finish()` can delete the other's breadcrumb. The pid checks
  prevent misattribution, but a crash in that window would go unrecorded.
- **Not every load ends in a plugin crash.** Killing the engine (closing the app, Task Manager)
  during a long plugin load is blamed on that plugin and quarantines it. The notice tells the
  user, and Retry undoes it.
- **A reused pid after reboot.** If the dead engine's pid now belongs to a live process, the
  breadcrumb is left alone until that pid dies.
- **Third-party calls outside the three choke points are not breadcrumbed:**
  `resetCrashedPlugin` (re-prepare + state restore), `AudioGraph::reprepare` on device
  changes, and state saves.
- **An SEH-caught `createInstance` fault unwinds without C++ destructors**, so JUCE's module
  handle may leak. The engine stayed responsive afterwards (smoke 3), but long-term heap
  integrity after such a fault is not proven.
- **`getChainState` takes the quarantine mutex once per missing node** on each chain poll. It
  is cheap and runs on the message thread, but it is new work on a hot UI path.
- **The exit code in the crash message is printed in decimal** (`3221226505`). Hex
  (`0xC0000409`) would be more recognisable.
- **Pre-existing:** `EditorHostMain.cpp(113)` C4996 `fopen`.

### Not done (out of scope by instruction)

- No new plugin format, and no `JUCE_PLUGINHOST_*` change.
- No DLL is loaded in the engine for inspection: preflight is a PE parse only.
- `MixEngine::addEffect`'s `chainsMutex_` scope is unchanged.
- No engine auto-respawn and no project auto-reload.
- No UI redesign: the notice goes through the existing toast. See deviation 4 for the two
  status-text and Retry wirings.
- The project file format is unchanged.
- Nothing was hand-dispatched: both RPCs are in `ui/rpc-manifest.js`.
- Nothing was pushed.
