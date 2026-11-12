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
