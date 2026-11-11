# Plugin Hosting Audit (P0)

Read-only audit of third-party plugin hosting, scanning and the FX-insert menu, done before the
VST2 (FST), CLAP, out-of-process-scanner and plugin-browser work. Every `file:line` below was
grepped against the working tree on branch `ui-rebuild/phase-0` (HEAD `f8a30b7`, with uncommitted
WIP from other sessions). JUCE sources are cited from the fetched copy at
`bridge/build/_deps/juce-src/` (not in git). No scan was run and the app was not launched; the
plugin data in §8 comes from the cache the last real scan left on disk.

**Headline:** an out-of-process VST3 scanner (`xleth-plugin-scanner.exe`) and an out-of-process
editor host (`xleth-editor-host.exe`) **already exist**. P1 is a hardening job, not a greenfield
one.

---

## 1. Formats & build config

- **JUCE version: 8.0.6.** `engine/CMakeLists.txt:36-46`: `add_subdirectory("C:/JUCE")` if that
  folder exists (it does not on this machine), otherwise FetchContent `GIT_TAG 8.0.6`
  (`engine/CMakeLists.txt:42`). The fetched copy confirms it:
  `bridge/build/_deps/juce-src/modules/juce_core/system/juce_StandardHeader.h:42-44` (8 / 0 / 6).
- **`JUCE_PLUGINHOST_*` defines.** Only VST3 is defined, in four places:
  - `engine/CMakeLists.txt:427`: the engine core (PRIVATE compile defs).
  - `engine/CMakeLists.txt:497`: `XlethEngineHeaders` INTERFACE (header consumers).
  - `scanner/CMakeLists.txt:25`: `xleth-plugin-scanner`.
  - `editor-host/CMakeLists.txt:43`: `xleth-editor-host`.
  - No `JUCE_PLUGINHOST_VST`, `_LV2`, `_LADSPA`, `_AU` or `_ARA` anywhere outside `_deps`.
- **`AudioPluginFormatManager` instances.** There are three, one per process, and each calls
  `addDefaultFormats()`, which registers VST3 only because of the defines above:
  - Engine: `PluginRegistry` member `formatManager_` (`engine/src/audio/PluginRegistry.h:92`),
    populated in the constructor (`engine/src/audio/PluginRegistry.cpp:84`). `PluginRegistry` is
    created by `MixEngine` (`engine/src/audio/MixEngine.cpp:408`).
  - Scanner: `PluginScanner::fmt_` (`scanner/src/ScannerMain.cpp:133`, `:50`), plus a local one in
    manual-test mode (`scanner/src/ScannerMain.cpp:161-162`).
  - Editor host: a local in `loadPluginAndShowEditor` (`editor-host/src/EditorHostMain.cpp:483-484`).

## 2. Scanning

**Processes and threads.**
- The engine (`xleth_native.node`) is loaded in a Node child process started with
  `child_process.fork` and `serialization: 'advanced'` (`ui/electron-main/worker.js:170-182`).
- `PluginRegistry::scanPlugins` starts a `std::thread` inside that engine process
  (`engine/src/audio/PluginRegistry.cpp:267`). That thread acts as a JUCE `ChildProcessCoordinator`
  (`PluginRegistry.cpp:14-76`) and launches `xleth-plugin-scanner.exe` with UID `XlethPluginScan`
  (`PluginRegistry.cpp:306`, `scanner/src/ScannerMain.cpp:20`).
- Plugin DLLs are loaded **only in the scanner process**, inside `findAllTypesForFile`
  (`scanner/src/ScannerMain.cpp:91-99`). The scanner does not link `XlethEngineCore`
  (`scanner/CMakeLists.txt:30-38`).
- The scanner exe is looked up next to the `.node` (`engine/src/XlethEngineService.cpp:19792-19794`).
- Each file is sent as one `"SCAN:<path>"` message. The reply is `OK:<xml per line>` or
  `FAIL:<reason>` (`scanner/src/ScannerMain.cpp:3-7`), with a 10 s timeout per file
  (`PluginRegistry.cpp:340`).

**Triggers.** A scan only starts when the user asks for one:
- The user clicks Scan in `VstBrowser` (`ui/src/components/mixer/VstBrowser.jsx:49-51`), which calls
  `xleth:audio:scanPlugins` (`ui/preload.js:354`). The call is reshaped in
  `ui/electron-main/vst3.js:24-25` and reaches `Audio_ScanPlugins`
  (`engine/src/XlethEngineService.cpp:19766`).
- No scan runs at startup. Startup only loads the cache (`engine/src/audio/MixEngine.cpp:411-417`).
- Progress is polled through `audio_getScanProgress` (`XlethEngineService.cpp:19799`) by
  `ui/src/components/mixer/ScanProgressBar.jsx:5,22`.

**Paths.**
- There are **no default paths**. `PluginRegistry`'s search list starts empty
  (`PluginRegistry.cpp:89`).
- The user's folders are kept in renderer `localStorage` key `xleth.vstSearchPaths`
  (`VstBrowser.jsx:10-14`, `:63-71`). They are sent on each scan and **replace** the engine's list
  (`XlethEngineService.cpp:19776-19785`).
- Each folder is searched **recursively for both files and directories** matching `*.vst3`
  (`PluginRegistry.cpp:270-279`). This is the cause of the duplicate in §8.
- `VST3PluginFormat::getDefaultLocationsToSearch` / `searchPathsForPlugins` are not used.

**Dead-man's pedal / blacklist: none.**
- Failed files go into an in-memory `failedPlugins_` (`PluginRegistry.cpp:351-354`, `:394-397`).
  That list is cleared at the start of every scan (`PluginRegistry.cpp:258-261`) and never written
  to disk.
- The next scan therefore loads every known crasher again.
- JUCE's `PluginDirectoryScanner` and its dead-man's-pedal file are not used.

**Persistence.**
- `KnownPluginList::createXml()` is written to `%APPDATA%\Xleth\plugin-cache.xml`
  (`PluginRegistry.cpp:438-442`, `:152-159`).
- It is read back at engine start (`MixEngine.cpp:411-417` → `PluginRegistry.cpp:161-172`).
- The on-disk file holds 23 `<PLUGIN>` entries, dated 2026-06-12.

**Trace: a plugin crashes during scan.**
1. The scanner process dies inside `format->findAllTypesForFile` (`ScannerMain.cpp:97-98`). Per its
   own header comment it has no crash handling of its own (`ScannerMain.cpp:9-11`).
2. JUCE calls `ScanCoordinator::handleConnectionLost` on its poll thread. It sets
   `connected=false` and wakes the waiter (`PluginRegistry.cpp:35-41`).
3. `sendAndWait` returns false (`PluginRegistry.cpp:66-74`). The file is added to `failedPlugins_`
   and `coord = nullptr` destroys the coordinator (`PluginRegistry.cpp:342-356`).
4. The next loop iteration starts a fresh scanner (`PluginRegistry.cpp:327-333`).
5. A hang (no reply within 10 s) takes the same path. Destroying the coordinator kills the hung
   worker.
6. The engine process is not affected.

Related defects found along the way:
- **Cancel wipes the cache.**
  1. `cancelScan` breaks the loop (`PluginRegistry.cpp:319-320`).
  2. Execution still reaches `knownPlugins_.clear()` followed by adding only the partial
     `discovered` results (`PluginRegistry.cpp:429-431`).
  3. That partial list is then **saved over** the cache (`PluginRegistry.cpp:442`).
- **No incremental rescan.**
  - Every scan clears the list and loads every file again (`PluginRegistry.cpp:429`).
  - `fileTime` / `pluginNeedsRescanning` are never consulted.
- **Clear-then-add is not atomic.** A reader could see a half-filled list between
  `PluginRegistry.cpp:429` and `:431`. This is mitigated only because the UI waits for
  `scanning_ == false` (`PluginRegistry.cpp:446`).
- **Search paths are replaced while a scan is running.** `Audio_ScanPlugins` replaces the search
  paths (`XlethEngineService.cpp:19776`) *before* `scanPlugins`' "already scanning" early-return
  (`PluginRegistry.cpp:236-237`).

## 3. Instantiation & persistence

**Creation (insert path).**
1. The renderer calls `effectChainStore.addEffect(key, pluginId)`
   (`ui/src/stores/effectChainStore.js:3341-3356`).
2. That reaches `Audio_AddEffect` (`engine/src/XlethEngineService.cpp:18518`).
3. Then `MixEngine::addEffect` (`engine/src/audio/MixEngine.cpp:3075-3099`), then
   `EffectChainManager::addEffect` (`engine/src/audio/EffectChainManager.cpp:52-54`).
4. Then `AudioGraph::addNode` (`engine/src/audio/AudioGraph.cpp:300-320`) and finally
   `AudioGraph::createEffect` (`AudioGraph.cpp:3066`).
5. Stock ids are matched with string compares. Anything else falls through to
   `PluginRegistry::findPluginByIdentifier`, which linearly compares `createIdentifierString()`
   (`PluginRegistry.cpp:118-130`).
6. `fmtMgr.createPluginInstance` runs inside `xleth::pluginGuardCall`, an MSVC SEH `__try`
   (`AudioGraph.cpp:3097-3127`, `engine/src/audio/PluginCrashGuard.h:45-56`).

**Thread.**
- The RPC runs on the engine worker's Node main thread.
- That thread is also the JUCE message thread: `ScopedJuceInitialiser_GUI` is created there
  (`XlethEngineService.cpp:197`, comment at `:20218-20219`).
- `MixEngine::addEffect` holds `chainsMutex_` **across the DLL load and prepare** (the "TWO-STRIKE"
  comment at `MixEngine.cpp:3082-3085`).

**Ownership.**
- The instance is wrapped in `GuardedPluginWrapper`, which owns the inner instance through a
  `unique_ptr` (`AudioGraph.cpp:3141`, `engine/src/audio/GuardedPluginWrapper.h:36-39`).
- It is owned by the chain's JUCE `AudioProcessorGraph` inside `AudioGraph`, which belongs to an
  `EffectChainManager` held by `shared_ptr` in `MixEngine::effectChains_` (`MixEngine.cpp:3087-3094`).
- The audio thread reaches chains through an atomic `chainSnapshot_` (`MixEngine.h:1755`).
- Snapshots that are replaced are released on the message thread, never on the audio thread
  (`MixEngine.cpp:4572-4592`).

**Identifier stored in the project.**
- `pluginId` = `PluginDescription::createIdentifierString()`, which is
  `format-name-<hex(fileOrIdentifier.hashCode())>-<hex(uid)>` (JUCE
  `processors/juce_PluginDescription.cpp:48-52`, `:64-68`; exported as `id` at
  `PluginRegistry.cpp:196`).
- **This id embeds a hash of the file path.** Moving a plugin, or switching between the bundle path
  and the inner-DLL path, changes the id.
- In addition, `toJSON` stores the **full `PluginDescription` XML** as `pluginDescription`
  (`AudioGraph.cpp:1222-1228`).
- On load, `fromJSON` instantiates **from that stored description**. It does not look the plugin up
  in the registry (`AudioGraph.cpp:1298-1322`), so projects load even if the scan cache is empty.
- If loading fails, a `PassthroughProcessor` placeholder keeps the stored state and the node is
  marked missing (`AudioGraph.cpp:1385-1403`).
- Missing nodes are retried through `tryResolvePlugin` (`AudioGraph.cpp:1532`, `MixEngine.cpp:3462-3474`)
  and surfaced to the UI through `audio_getMissingPlugins` (`XlethEngineService.cpp:19982`,
  `ui/src/XlethRoot.jsx:252`).

**State.**
- Saving: `proc->getStateInformation(mb)` is stored as Base64 `state` (`AudioGraph.cpp:1189-1199`).
  The wrapper guards the call, and a crash saves no state.
- Loading: the wrapper's guarded `setStateInformation` restores it (`AudioGraph.cpp:1338-1347`).
- A missing node writes back its original stored blob (`AudioGraph.cpp:1140-1160`).

**Undo.**
- **Chain-mode insert, remove and reorder do not go through `UndoManager`.**
  `Audio_AddEffect`, `Audio_RemoveEffect` and `Audio_MoveEffect` (`XlethEngineService.cpp:18518`,
  `:18549`, `:18575`) call `MixEngine` directly. No `Command` is created.
- The only effect-chain command is `LoadEffectChainCommand`, which swaps a whole chain for the FX
  Chain Library (`engine/src/commands/EffectChainCommands.h:9-33`).
- Graph-mode (FX Graph) structural edits *are* undoable. They go through
  `timeline_setTrackGraphState(..., undoable)` (`XlethEngineService.cpp:9543`;
  `ui/src/stores/effectChainStore.js:625-633`).

## 4. Editor windows

`MixEngine::openPluginEditor` (`engine/src/audio/MixEngine.cpp:1474`) handles the two kinds of
editor differently:

**Third-party plugins: separate process.**
- Third-party nodes (anything wrapped in `GuardedPluginWrapper`) open in a separate
  `xleth-editor-host.exe` (`MixEngine.cpp:1530-1533`). The exe path is set at engine init
  (`XlethEngineService.cpp:5433-5435`).
- `EditorProcessCoordinator` (`engine/src/audio/EditorProcessCoordinator.h:1-72`) handles the
  protocol: INIT/CLOS/PARM/STAT/STRM/STOP out, and REDY/CLSD/ERR_/PARM back.
- The editor host:
  - **loads a second instance of the plugin** from `fileOrIdentifier`
    (`AudioGraph.cpp:2868-2873` → `editor-host/src/EditorHostMain.cpp:489-513`);
  - mirrors parameters and state both ways;
  - can stream audio for metering through a named shared-memory ring.
- The editor window is a JUCE `DocumentWindow` (`EditorHostMain.cpp:378-386`) in the editor host's
  own message thread.
- It is **not reparented as a child** into Electron. It becomes an *owned* top-level popup of the
  Electron main window through `SetWindowLongPtrW(GWLP_HWNDPARENT)` (`EditorHostMain.cpp:660-686`).
- The owner HWND comes from `audio_setMainWindowHandle` (`MixEngine.cpp:1467`, `:1625-1639`).
- Known limitation: the editor host takes `descriptions[0]` from the file and creates it at a fixed
  48000 Hz / 480 samples (`EditorHostMain.cpp:507`, `:512-513`). **Multi-class (shell) VST3
  bundles will open the wrong plugin's editor.**

**Stock effects: in-process window.**
- Stock effects use an in-process `PluginEditorHost` `DocumentWindow`
  (`engine/src/audio/PluginEditorHost.cpp:12-14`; route at `MixEngine.cpp:1701`).

## 5. Crash behaviour

**Inside the engine process.**
- `GuardedPluginWrapper::processBlock` (`engine/src/audio/GuardedPluginWrapper.cpp:315`) catches
  SEH faults and switches the node to passthrough. It exposes `crashed` (contract in
  `GuardedPluginWrapper.h:13-28`).
- The UI shows a "Crashed" badge (`ui/src/components/mixer/EffectChainPanel.jsx:101-108`).
- Recovery is through `audio_resetCrashedPlugin` (`XlethEngineService.cpp:20038`).
- Instantiation and state calls are SEH-guarded as well (§3).
- SEH does not catch: heap corruption that crashes later, stack overflow that guarding cannot
  recover, or a hang.

**If the engine process dies.**
- `worker.on('exit')` logs the exit, sets `workerReady=false` and rejects every pending call with
  `worker exited (code N)` (`ui/electron-main/worker.js:233-240`).
- After that, every `callWorker` rejects with `Engine not ready: …` (`worker.js:251-254`).
- **There is no respawn, no project reload, and no "plugin X crashed" report.** The only error
  screen for the engine is the startup one (`ui/main.js:409-432`).
- The engine cannot say which plugin caused a crash. There is no breadcrumb such as a
  "last-plugin-entered" marker.
- The editor host and the scanner are separate processes, so their crashes stay contained (§2, §4).

## 6. Instruments

- **There is no third-party instrument hosting.**
- Nothing creates a plugin with MIDI input. `GuardedPluginWrapper` only forwards `acceptsMidi()`
  (`GuardedPluginWrapper.h:67`), and chains are effect-only.
- `PluginRegistry` does not filter `isInstrument`. A scanned VSTi would therefore appear in the
  *FX* menu and be inserted as an effect with an empty `MidiBuffer`.
- `hasEditor` in the payload is always `true` (`PluginRegistry.cpp:204-206`).
- Pattern-track sound comes from `Sampler`, a plain C++ class and **not** an `AudioProcessor`
  (`engine/src/audio/Sampler.h:15-21`).
- Samplers are owned in `MixEngine::samplers_`, keyed by `{trackId, regionId}`
  (`engine/src/audio/MixEngine.h:1886`).
- Notes reach them through direct calls (`MixEngine.cpp:5825`, `:5885`). Each sampler renders into
  `trackBuffers_[slot]` (`MixEngine.cpp:7026`, `:7048`) **before** that track's effect chain.
- A VSTi would sit at that same point, as a per-`{trackId, regionId}` source in front of the chain.
  It would need a note-event to `MidiBuffer` adapter, because no MIDI buffer exists on that path
  today.

## 7. UI path

**Components.**
- The shared menu builder is `buildEffectChainMenuItems`
  (`ui/src/components/mixer/EffectChainPanel.jsx:121-140`). It is called by `EffectChainPanel`
  (`:306`) and by the new-UI `DeviceChain` (`ui/src/components/devices/DeviceChain.jsx:152`).
- The VST submenu label is built at `EffectChainPanel.jsx:138`.
- The FX Graph add menu uses `buildEffectPickerGroups` (`ui/src/components/mixer/effectCatalog.js:130-158`).
- **A stale third copy** of the category list is hardcoded in
  `ui/src/components/mixer/NodeEditor.jsx:36` (used at `:248`).

**Plugin-list IPC chain.**
1. `useVstStore.fetchPlugins` (`ui/src/stores/vstStore.js:14-21`).
2. `window.xleth.audio.getScannedPlugins`, generated from the manifest (`ui/rpc-manifest.js:2340-2346`).
3. `xleth:audio:getScannedPlugins`, then `callWorker`, then the addon export
   (`bridge/src/XlethRpcExports.inc:266`).
4. `Audio_GetScannedPlugins` (`XlethEngineService.cpp:19819`), then
   `PluginRegistry::getPluginListAsJSON` (`PluginRegistry.cpp:176-212`).

**Payload.**
- A **JSON string**, hand-built with `+=` concatenation and an escape that handles only `\` and `"`
  (`PluginRegistry.cpp:191-193`). The renderer `JSON.parse`s it.
- Shape:
  ```
  [{ "id": createIdentifierString(), "name", "vendor": manufacturerName, "category",
     "format": pluginFormatName, "filePath": fileOrIdentifier,
     "numInputs", "numOutputs", "hasEditor": true }]
  ```
- `uniqueId`, `deprecatedUid`, `version`, `isInstrument` and `fileTime` are **not** included.

**Categories.**
- Stock categories are **hardcoded** in `EFFECT_CATEGORIES` (`ui/src/components/mixer/effectCatalog.js:13-75`).
- `PluginDescription::category` reaches the store but is **never used**. Third-party plugins are a
  flat list sorted by name then vendor (`effectCatalog.js:103-109`) and labelled `name - vendor`
  (`effectCatalog.js:113-116`).

## 8. UniFlange duplicate: root cause

The two entries in `%APPDATA%\Xleth\plugin-cache.xml`:

| field | entry A | entry B |
|---|---|---|
| fileOrIdentifier | `…\VST3\XLETH\UniFlange.vst3\Contents\x86_64-win\UniFlange.vst3` (inner DLL) | `…\VST3\XLETH\UniFlange.vst3` (bundle dir) |
| uniqueId | `ad82305` | `ad82305` |
| deprecatedUid (`uid`) | `961d138` | `961d138` |
| name / manufacturer | UniFlange / Echelon | UniFlange / Echelon |
| version | 0.1.0 | 0.1.0 |
| numInputs / numOutputs | 2 / 2 | **0 / 0** |
| fileTime | `19cc3287b00` | `19d004aee9b` |

The XML attribute mapping is `uniqueId`→`uniqueId` and `uid`→`deprecatedUid` (JUCE
`juce_PluginDescription.cpp:84`, `:93`, `:117-118`).

**Verdict: a list-merge bug in our code. It is not two installed copies and not two classes in one
bundle.** There is one install, `C:\Program Files\Common Files\VST3\XLETH\UniFlange.vst3\`.

How it happens:
1. `PluginRegistry.cpp:275-278` searches recursively with `findFilesAndDirectories` for `*.vst3`.
   For a bundle, that matches **both** the bundle directory and the inner
   `Contents\x86_64-win\*.vst3` binary, so both are sent to the scanner.
2. UniFlange is the only bundle with `Contents\Resources\moduleinfo.json`. For the bundle path,
   JUCE's `findAllTypesForFile` takes the **fast path**: it reads `moduleinfo.json` and keeps
   `fileOrIdentifier = <bundle dir>` without loading the DLL. This is why the I/O counts are 0/0
   (`juce_VST3PluginFormat.cpp:4136-4142`, `:1040-1066`).
   For the inner-binary path it loads the DLL and records the inner path.
3. `KnownPluginList::addType` treats an entry as a duplicate only when `fileOrIdentifier`,
   `deprecatedUid` and `uniqueId` are all equal (`juce_KnownPluginList.cpp:97-115` →
   `juce_PluginDescription.cpp:38-46`). The paths differ, so both are kept.
4. The two entries also get different `createIdentifierString()`s, because the path hash differs,
   so the menu shows both.
5. **Why TAL-Chorus-LX and TAL-Reverb-4 (also bundles) are not duplicated:** they have no
   `moduleinfo.json`. For their bundle path the slow path runs, and `getLibraryPaths` searches
   *into* the bundle and records the **inner** path (`juce_VST3PluginFormat.cpp:4144-4165`,
   `:4219-4231`). Both scans therefore produce the same `fileOrIdentifier`, and `addType`
   collapses them.
6. Every modern bundle that ships `moduleinfo.json` (VST3 SDK ≥ 3.7.5) will be duplicated the same
   way.

**Caution for the fix:** projects store the path-hashed `pluginId` and the full description (§3).
Whichever path the deduplication keeps changes the `id` of the other one, so existing
UniFlange-VST3 inserts must still resolve after the fix. They do today, because `fromJSON`
instantiates from the stored description, but check this.

Not verified: no scanner log from the last scan exists (`scanner-log.txt` is deleted at the start
of each scan, `PluginRegistry.cpp:290`), so step 5 is inferred from the JUCE source and the cache
contents. It was not observed in a log.

## 9. License

- **The repo has no `LICENSE` / `COPYING` file and no SPDX headers** (`git ls-files` finds only
  `vendor/ffmpeg/LICENSE` and two separation-sidecar notices).
- `ui/package.json:4` is `"private": true` with no `license` field.
- So the outbound license is **undeclared**. By default that means all rights reserved.
- **JUCE.** `bridge/build/_deps/juce-src/LICENSE.md` dual-licenses JUCE 8 under AGPLv3 or the
  commercial JUCE 8 EULA. Nothing in the repo records a commercial or Personal licence: no licence
  key, no build flag, no note. In JUCE 8 the splash-screen flag no longer exists, so the build
  config cannot tell us either way. **Unless the owner holds a JUCE commercial/Personal licence,
  this build is under AGPLv3.**
- **FFmpeg.** The vendored `vendor/ffmpeg/LICENSE` is **GPLv3**, so the shipped binary is already
  a GPLv3 combination.
- **FST, GPLv3-or-later.**
  - **On the AGPL path for JUCE:** compatible. GPLv3 §13 explicitly allows combining with AGPLv3
    work. It also adds no obligation beyond what the GPLv3 FFmpeg already imposes.
  - **On a commercial-JUCE / proprietary path:** **not compatible**. Vendoring FST would force the
    whole application under GPLv3 terms. This is the same problem the GPLv3 FFmpeg already
    creates.
- **⚠ FLAG (not resolved here):**
  1. The repo declares no license.
  2. The JUCE licence path is undocumented.
  3. A GPLv3 FFmpeg is already linked.

  Decide the outbound license, and record which JUCE licence applies, **before** vendoring FST.
  CLAP headers are MIT and have no conflict either way.

## 10. Risks for the planned work

- **DLL load under `chainsMutex_`.**
  - Insert holds `chainsMutex_` across `createPluginInstance` and prepare (`MixEngine.cpp:3082-3095`).
  - The audio thread reads chains lock-free through `chainSnapshot_` (`MixEngine.cpp:6371`, `:7189`).
  - But the automation applier and every other chain RPC queue behind a slow plugin load. A slow
    VST2 or CLAP load will freeze those paths in the same way.
- **Audio-thread allocation and destruction.**
  - Retiring snapshots keeps plugin destructors off the audio thread (`MixEngine.cpp:4576-4592`).
    New adapters (CLAP, VST2 wrapper) must keep that rule.
  - New adapters must not allocate in `process` for event/MIDI translation.
  - `pendingLatencyCompensationReset_` is set on every insert or remove (`MixEngine.cpp:3097`,
    `:3119`). Adapters must report latency through the non-RT `refreshReportedLatency` path
    (`GuardedPluginWrapper.h:30-33`).
- **Single-format assumptions are hardcoded:**
  - `"*.vst3"` enumeration (`PluginRegistry.cpp:278`);
  - `VST3 Plugins (n)` label (`EffectChainPanel.jsx:138`, `effectCatalog.js:99`);
  - "scan VST3 plugins" empty text (`effectCatalog.js:98`);
  - `GuardedPluginWrapper` described as "Used ONLY for VST3" (`GuardedPluginWrapper.h:16`);
  - the editor host uses `descriptions[0]` (`EditorHostMain.cpp:507`).
- **Monolith global state.**
  - `XlethEngineService.cpp` is 24,266 lines.
  - Its globals include `audioEngine` (`:200`) and `juceInit` (`:197`). Every plugin RPC
    (`:19766-19850`, `:19982`, `:20038`) reaches `audioEngine->getMixEngine().getPluginRegistry()`
    through them.
  - `audio_scanPlugins` is still hand-dispatched (`XlethEngineService.cpp:24236`;
    `bridge/src/XlethAddon.cpp:565-568`, `:877`) and is outside the generated manifest.
  - New plugin RPCs should go through the manifest so the S2 split can move them as a block.
- **The 4-layer bridge swallows missing methods.**
  - `ui/addon-worker.js:131-146` replies `notImplemented` (null) unless `XLETH_STRICT_IPC=1`.
  - `worker.js:228` turns that into a rejection.
  - `vstStore` then calls with `?.()` and an empty `catch {}` (`ui/src/stores/vstStore.js:14-30`).
  - Result: a misnamed or unrebuilt RPC shows as "no plugins" with no error. Run the new browser
    work with `XLETH_STRICT_IPC=1`.
- **IPC serialization.**
  - The plugin list travels as one hand-concatenated JSON *string* (`PluginRegistry.cpp:182-211`),
    not structured data.
  - The escape handles only `\` and `"`. A control character (for example a tab) in a vendor or
    category string produces invalid JSON. `JSON.parse` then throws, and the empty `catch {}`
    (`vstStore.js:20`) silently empties the menu.
  - `serialization: 'advanced'` is on (`worker.js:181`), so the new library payload can be a real
    object (structured clone) instead of a string.
- **Missing persisted failure/blacklist state** (§2): P1 has to add it from scratch.
- **Cancel corrupts the cache** (§2): P1 must fix this, or a cancelled first scan with the new
  scanner will wipe the user's library.

---

## Implications for P1–P5

- **P1: out-of-process scanner.**
  - The process boundary already exists. Keep `xleth-plugin-scanner.exe` and extend it.
  - Add a persisted blacklist / dead-man's pedal: record the file before each scan, clear it on
    success, skip it on the next run unless the user retries.
  - Do incremental rescans by `fileTime`.
  - Make a cancelled scan non-destructive.
  - Enumerate VST3 *bundles* correctly: stop descending into `*.vst3` directories. This fixes §8 at
    the source.
  - Add a format field to `SCAN:` so one scanner serves VST3, VST2 and CLAP.
- **P2: VST2 via FST.**
  - Blocked on the §9 license decision.
  - Technically it needs a `JUCE_PLUGINHOST_VST` or custom-format registration in all three
    `AudioPluginFormatManager`s (§1).
  - It needs `*.dll` enumeration. Most `.dll` files in VST folders are not plugins, which raises
    crash exposure, so the P1 blacklist must come first.
  - VST2 shell plugins (WaveShell) make the editor host's `descriptions[0]` shortcut wrong. Pass
    the full description or uid to the editor host instead of a path.
- **P3: plugin library + dedupe + frecency.**
  - Dedupe on (format, uniqueId/deprecatedUid, normalised bundle path), not on
    `createIdentifierString`.
  - Keep a migration map from old path-hashed ids so saved projects and FX-chain presets still
    resolve.
  - Add `uniqueId`, `version`, `isInstrument` and `fileTime` to the payload.
  - Persist the library outside `plugin-cache.xml`, or version it.
  - Frecency needs a per-insert hook. `effectChainStore.addEffect` (`effectChainStore.js:3341`) is
    the single choke point for chain mode. Graph mode adds through `buildEffectPickerGroups`.
- **P4: browser UI.**
  - Replace both `buildEffectChainMenuItems` and `buildEffectPickerGroups`, and delete the stale
    `NodeEditor.jsx:36` list. Without that, three menus will drift apart.
  - Use the plugin `category` and format, and filter or route instruments separately.
  - Show scan failures and blacklist entries. `audio_getFailedPlugins` exists but is not
    persisted.
  - Report engine death. Today there is none (§5).
- **P5: CLAP adapter.**
  - Needs a JUCE `AudioPluginFormat` subclass, or an `AudioProcessor` adapter, that
    `GuardedPluginWrapper` can wrap. Wrapping keeps SEH, crash badges and snapshot retirement for
    free.
  - The new format must be registered in the scanner, editor host and engine format managers.
  - It needs its own state, latency, param and thread-pool bridging, all without allocating in
    `process`.
  - The editor host must learn to open a CLAP GUI (no `AudioProcessorEditor`), or CLAP GUIs need
    their own host path.
  - Instruments (§6) are a separate project for every format.
