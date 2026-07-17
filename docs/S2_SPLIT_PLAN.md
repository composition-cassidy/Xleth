# AUDIT.md S2 — Split plan for `engine/src/XlethEngineService.cpp`

**Status: Stage 1 implemented; Stages 2–17 are PLAN ONLY.**

**Baseline coordinates (corrected 2026-07-17).** This plan was originally investigated read-only
against `origin/ci/github-actions` tip = `126ba56` (15,581 lines). It has since been **re-derived
against `main` = `8818117` (16,325 lines)**, which is **13 commits** beyond that baseline
(`126ba56..8818117` = +792 / −48, net **+744**).

An earlier reconciliation attempt used the range `6b10c22..8818117` (8 commits, +342/−4). **That
range is too narrow and must not be used:** `git merge-base` of the original Stage-1 work and `main`
is `126ba56`, which is an *ancestor* of `6b10c22`. The five commits `126ba56..6b10c22` (`0d0ef23`,
`c197fcc`, `fb81d69`, `9788495`, `6b10c22`) fall outside it — and **6 of the 7 globals added since
the original census were added by `fb81d69`**, one of those five. Scanning only `6b10c22..8818117`
finds `g_previewTransitionFreeze` and silently misses the entire poster-prepass cluster.

Stage 1 was **re-derived against main, not rebased**: the original commit deletes lines from a
15,581-line file, and main interleaves 7 new globals *inside* the deleted region, so a rebase would
conflict in exactly the hunks that matter and risk dropping a global. The globals census in §2 below
is authoritative as of `8818117`; the line-range map in §1 has been re-anchored to main.

AUDIT.md S2 (authoritative spec): *"Split XlethEngineService.cpp into domain TUs (transport/project/timeline/audio/preview/export) keeping the existing dispatch as the seam; globals → an explicit context struct passed to handlers | Impact 4, Risk 5, Effort 5, Priority 9 | The header itself warns why this is dangerous: TU-local statics with stable addresses, worker-thread lifetimes, documented lock orders. Move code verbatim, one domain per PR, re-run seek/composite/drift benchmarks each time. Do not combine with any behavior change."*

**One deliberate deviation from the S2 wording, flagged up front:** AUDIT names "globals → an explicit context struct passed to handlers" as part of S2, but also demands "do not combine with any behavior change" and "move code verbatim." Converting every handler to take a context parameter changes the call surface of ~290 functions and cannot ride along with verbatim code moves. This plan therefore does the split with the globals extracted **as globals** (extern declarations in a shared header + one definitions TU), and treats the context-struct conversion as a **separate, later, optional follow-up (§8)** that starts only after every domain move has landed and been benchmarked. Everything else follows the S2 spec exactly: dispatch stays the seam, verbatim moves, one domain per PR, benchmarks per the matrix in §7.

---

## 1. Verified domain → line-range map (corrected)

Verified against the actual file (section headers use `// ─────` dividers; all boundaries below were confirmed by reading the divider lines and the first/last function in each block). Corrections to the map given in the task prompt are **bolded**.

> ### ⚠ These line numbers are `126ba56` coordinates. For **main (`8818117`)** use the table below.
>
> **The shift is NOT a uniform offset** — it accumulates unevenly (+1 at the includes → +34 after the
> anon namespace → +225 at the V-body → +307 at transport → +732 by the audio block). Anchors are
> measured, not derived. Stage 1 has already landed against main; stages 2–17 must re-anchor here.
>
> | main | 126ba56 | Contents | Δ |
> |---|---|---|---|
> | 1–118 | 1–117 | Header + includes. `render/SnapshotTransitionRenderer.h` added @65. | +1 |
> | 119–162 | 118–161 | IPC slow-call macros (`IPC_TIME_START` 132) | +1 |
> | **169–656** | **168–622** | **Anon-namespace globals.** New: `g_previewTransitionFreeze` 245, `g_previewPauseForPosterLoad` 256, prepass cluster 442–454. `PreviewDiagCounters` 258–354, `g_previewDiag` 355, `CANVAS_W/H` 422–423, `ScalerEntry` 465–469, `statsMutex/Snapshot` 635–636, export state 646–650, `g_videoRenderer` 653. | **+34** |
> | 657–3006 | 624–2777 | Helpers. fwd-decl 667; `isInitialised()` 669; trace anon ns 678–687; `BridgeCallLog` 1019; poster/proxy statics 1589–1619; `maybeEnqueueSourcePoster` 1683; **`buildPosterPrepass` 1777 (NEW)**; `maybeEnqueueCellThumbnail` 1876; `drainSourcePosterResults` 1924; `maybeEnqueueSourcePreviewProxy` 2007 | +34→+229 |
> | 3007–4232 | 2778–3926 | Lifecycle. **`videoThreadBody` 3014–~3920** (transition seam 3405–3428, prepass gate 3109/3123, drains 3068). `Initialize` 3922, `Shutdown` 4118, `triggerMipmapGeneration` 4216 | +225→+301 |
> | 4234–4291 | 3927–3985 | Sample management | +307 |
> | 4293–4370 | 3986–4064 | Video management | +307 |
> | **4372–4634** | **4065–4244** | **Transport** — `Play` 4372, `Stop` 4431, `Pause` 4449, `SetBPM` 4467, `GetTransportState` 4484, `Proxy_GetStatus` 4541, **`PosterPrepass_GetStatus` 4572 (NEW)**, **`PosterPrepass_Skip` 4597 (NEW)**, `Transport_Seek` 4612 | +307, **+2 handlers** |
> | 4636–4811 | 4245–4425 | Video frame | +391 |
> | 4813–4909 | 4426–4523 | Legacy timeline events | +387 |
> | 4911–4928 | 4524–4545 | Stats (`GetSyncStats` 4911) | +387 |
> | 4930–5590 | 4546–5200 | Project. `probeAudioInfo` fwd-decl 5172 (trap 4 — def now 14132) | +384 |
> | 5592–5813 | 5201–5423 | Timeline queries | +391 |
> | **5815–9991** | **5424–9869** | **Timeline mutations.** `syncTransportLoopFromTimeline` def 5820. **Snapshot-transition handlers landed here (5966–6228)**, incl. `Timeline_SetCueTransition` 6185. Grid layout follows at 6229. | +391 |
> | 9992–10124 | 9305–9442 | Preview Performance Controls (`Timeline_SetPreviewPosterMode` 10062) | +687 |
> | 10125–10601 | 9443–9630 | Visual Effect Chain | +682 |
> | 10602–10682 | 9870–9950 | Undo/Redo | +732 |
> | 10683–15247 | 9951–14510 | Audio (MixEngine) mega-block. perf-capture statics 11003–11009; `getThisModuleDir` 13251; `g_mainXlethHwnd` 13367; audio export 13619; video export 13811; `probeAudioInfo` def 14132 | +732 |
> | 15248–15313 | 14512–14571 | GPU management | +736 |
> | 15314–15891 | 14572–15053 | `Diag_GetVisualPreviewDiagnostic` 15314 + `Gpu_SetAdapter` 15738 | +731 |
> | 15892–15916 | 15160–15181 | Phase 7 — preview visibility | +732 |
> | 15917–16168 | 15182–15401 | MIDI import | +735 |
> | 16169–16325 | 15402–15581 | Module init: `getInstance` 16169, ffmpeg log filter 16173, `dispatch()` 16183 | +731 |

| Lines (`126ba56`) | Contents |
|---|---|
| 1–117 | File header + includes. **The header comment is stale — it still says "XlethAddon.cpp"** (line 1). Threading model documented at 7–10. |
| 118–161 | IPC slow-call diagnostic (`IPC_TIME_START`/`IPC_TIME_END` macros; used by only 7 handlers) |
| 165–622 | **Global engine state — an *anonymous namespace* (`namespace {` at 168, closes 622).** Not just variables: also contains the (dead) CPU blit helpers `blitYuvToCanvas` (444), `findActiveEventOnTrack` (534), `getCachedFrameForEvent` (559), `getCachedFrameAtSourceTime` (580), diag text helpers (352–402), and the `PreviewDiagCounters` struct (250–342). |
| 624–2777 | **"Helpers" — a 2,150-line region the original map skipped entirely. This is the single biggest cross-cutting hazard**, broken down: |
| — 633–635 | `syncTransportLoopFromTimeline` fwd-decl; `isInitialised()` inline (used **221×** across every domain) |
| — 637–795 | Audio-health trace + 1s sampler thread (own anon namespaces at 644, 682; spawns `g_audioHealthThread`) |
| — 797–984 | Sampler refresh helpers (`refreshSamplerFor*`, `rebuildAllSamplers`), `syncMixerTrackSlots`, clip-cache helpers (`refreshAllClipCaches`, `waitForClipCachesReady`), `Cache_GetWorldActiveJobIds` + 4 `Engine_*` stretch/formant **handlers** (922–975), `syncClipFadeToMixEngine` (976) |
| — 985–1006 | `BridgeCallLog` struct (per-call logging, used by nearly every handler) |
| — 1007–1367 | `ensureSourceDecoder` (1007), video-event ordering helpers, `rebuildVideoEventsFromClips` (1078–1367) |
| — 1368–1909 | Proxy/poster/thumbnail machinery: `invalidateRegionProxy`, `maybeEnqueueRegionProxy`, `enqueueAllRegionProxies`, `drainProxyResults`, poster/thumbnail/preview-proxy enqueue + drain, **plus 7 file-scope statics at 1552–1582** (see §2) |
| — 1910–2777 | JS ↔ model serialization (`jsTo*` / `serialize*` for ClipModulation, PatternNote, Syllable, Track, FullscreenLayer, GridSlot, GridLayout, Region, …) |
| 2778–3926 | Engine lifecycle. **~810 lines of this (2789–3598) is `videoThreadBody()` — the 60 Hz video-thread hot loop, the hottest code in the file.** Then `Initialize` (3621), `Shutdown` (3817), `triggerMipmapGeneration` (3909). SyncManager is constructed at 3692 (captures `decoderPtrs` **by reference**), `setRegionProxySources(&regionDecoderPtrs, g_timeline.get())` at 3716. |
| 3927–3985 | Sample management (`LoadSample`, `TriggerSample`) |
| 3986–4064 | Video management (`LoadVideo`, `GetVideoDuration`) |
| 4065–4244 | Transport (`Play`, `Stop`, `Pause`, `SetBPM`, `GetTransportState`, `Proxy_GetStatus`, `Transport_Seek`) |
| 4245–4425 | Video frame (`InitFrameOutput`, `InitVideoSharedMemory`, `GetFrameBuffer`, `GetCurrentFrameRGBA`, `GetCurrentFrame`, `SetVideoResolution`) |
| 4426–4523 | Legacy timeline events (`AddAudioEvent`, `AddVideoEvent`, `ClearTimeline`) |
| 4524–4545 | **Stats (`GetSyncStats`) — missing from the original map** |
| 4546–5200 | Phase 1 — Project management (`Project_*`). **Contains a second anon-namespace forward declaration of `probeAudioInfo` at 4787** whose definition lives at 13401 (see §2 traps). |
| 5201–5423 | Phase 1 — Timeline queries |
| 5424–7134 | Phase 1 — Timeline mutations, part 1: loop region, BPM, grid layout (5579–5806), output routing + sidechain routes (5853–6100, incl. `makeSidechain*Resolver` 5914/5929), track CRUD/flags, clip CRUD/stretch/pitch/splice |
| 7135–7281 | Pattern/PatternBlock/Note bridge methods, part 1 (`AddPattern`, `GetPattern`, `GetPatternAudioInfo`, `GetRegionAudioInfo`) |
| 7282–7850 | Waveform mipmap bindings (`Waveform_GetRegionPeaks/GetRawSamples/GetClipPeaks/GetFilePeaks`; `wfbLog` anon ns under `#ifdef XLETH_DEBUG` at 7288) |
| **7851–9304** | **Disambiguation of the prompt's "7283–9870" range, part 2: NOT waveform code.** A second pattern/note/mutation block that continues under the "Waveform" section header: `GetAllPatterns`/`RemovePattern`/`UpdateSamplerSettings` (7851–8147), PatternBlocks (8148–8309), Notes incl. batch ops + `Fsc_Parse` + quantize (8310–8753), `ConvertToPattern/ClipTrack` (8754–8800), video flip + hold-last-frame (8801–8906), track visual settings — corner radius, gap, subdivision, color, bounce, zoom/pan/rot, ping-pong, slide (8907–9304) |
| 9305–9442 | **Preview Performance Controls** (own sub-header at 9305; resolution scale, effects bypass, poster mode, proxy height) |
| 9443–9630 | **Visual Effect Chain** (`Timeline_*VisualEffect*`) |
| 9631–9869 | **Clip auto-trim + Region CRUD + syllables** (`AutoTrimClip`, `AddRegion`, `ModifyRegion`, `Set/GetSyllables`, `RemoveRegion`) |
| 9870–9950 | Phase 1 — Undo/Redo |
| 9951–14510 | "Phase 1 — Audio (MixEngine)" mega-block. **Actually seven distinct sub-domains:** |
| — 9951–10111 | Audio core: region↔sample mapping, source-region load, output devices, peak meters |
| — 10113–11403 | Realtime diagnostics + audio performance telemetry/capture (anon ns of report helpers 10158–11113; **5 file-scope statics at 10272–10278**; drain thread spawned at 10588) |
| — 11406–11501 | Track volume/pan/spread + master volume |
| — 11504–11976 | Linear effect chain + effect viz + master effects |
| — 11979–12515 | FX graph + master graph (connections, wires, nodes, graph-owned params, hydrate/sync/adopt) |
| — 12516–12842 | VST3 plugin scanner + plugin editor windows (`getThisModuleDir` 12520, **file-scope `g_mainXlethHwnd` at 12636**) |
| — 12843–13744 | **Export — audio export (12894, spawns worker thread at 13007), VIDEO export (13092 — lives here, not in any video section), duration compute, sample export/swap/revert/load/probe (anon ns at 13396 defining `probeAudioInfo` at 13401)** |
| — 13746–14060 | Source preview playback (`Source_*`) + video source frame serving (`Video_OpenSource/CloseSource/GetFrame/RequestPreviewFrameAtTimelinePosition`) |
| — 14062–14510 | EQ / Waveshaper / SmartBalance parameter bindings |
| 14512–14571 | GPU device management (`Gpu_GetAvailableGpus`). **`Gpu_SetAdapter` is NOT here — it's at 15007, inside the diagnostics section.** |
| 14572–15053 | `Diag_GetVisualPreviewDiagnostic` (14583) + `Gpu_SetAdapter` (15007) |
| 15054–15159 | Hardware encoder detection (`ensureDetector` 15065, `HwEnc_*`) |
| 15160–15181 | Phase 7 — Preview visibility (`Preview_SetEnabled`) |
| 15182–15401 | MIDI import (`Midi_ParseSummary/ImportFull/ExecuteImport`) |
| 15402–15581 | Module initialisation: FFmpeg log filter (function-local static at 15442), `getInstance` (Meyers singleton at 15448), `dispatch()` (15452–end; manifest `XlethRpcDispatch.inc` included at 15466, then ~89 hand-written branches) |

Handler census: **~290 dispatchable handler functions**, of which only ~32 helper functions are `static`; the handlers themselves are **non-static free functions with external linkage** — this is what makes the split mechanically feasible without touching the dispatch mechanism or the generated `.inc` (dispatch just needs declarations).

Build wiring: the file is the sole source of the `XlethEngineService` STATIC library (`engine/CMakeLists.txt:396–398`), linked by the bridge (`bridge/CMakeLists.txt`). New TUs are added to this same target, so they inherit `XLETH_DEBUG` and all include paths automatically.

---

## 2. Globals census

**Legend — threads:** B = bridge/Node main thread (== JUCE message thread) · V = video thread (`videoThreadBody`) · X = audio-export worker (lambda at 13007) · H = audio-health sampler thread (688–770) · D = perf-capture drain thread (10588) · R = OfflineRenderer's internal render thread (owns refs, see flags). The JUCE audio RT thread touches **none** of these globals directly (it lives inside AudioEngine/MixEngine), consistent with the file's threading comment.

**⚑ = address/reference captured elsewhere** — moving these carelessly (or splitting their single definition) risks dangling references or lock-order/ODR bugs. Details after the table.

### 2a. Main block (anonymous namespace, 168–622)

| Global (line) | Type | Referencing domains (ref counts from grep) | Threads | ⚑ |
|---|---|---|---|---|
| `juceInit` (173) | `unique_ptr<ScopedJuceInitialiser_GUI>` | Lifecycle only | B | must be created first / destroyed last (COM init) |
| `sampleBank` (175) | `unique_ptr<SampleBank>` | Export(12), Pattern(6), Lifecycle(6), Project(4), Waveform, Regions, MIDI, Sample, Audio-core | B | |
| `audioEngine` (176) | `unique_ptr<AudioEngine>` | **everywhere** — Audio-fx(64), Audio-core(46), TL-mut(34), sampler-helpers(30), VST3(28), Project(24), Lifecycle(22), Export(17), Source(13), Transport(11), +12 more domains | B, V(4), H(4), D(9), X(2) | ⚑ `getTransport()` ref into SyncManager (3693); referenced **by name** inside capture-less lambdas stored in SyncManager (3697) and in sidechain resolvers stored via Timeline commands (5918, 5933) |
| `frameCache` (177) | `unique_ptr<FrameCache>` | Lifecycle, Project, Legacy-TL | B, V(1) | ⚑ `*frameCache` ref into SyncManager (3695) and FrameServer (3689) |
| `g_mipmapCache` (181) | `unique_ptr<WaveformMipmapCache>` | Waveform(8), Lifecycle(4) | B (+ its own internal generation threads) | |
| `g_timeline` (184) | `unique_ptr<Timeline>` | **everywhere** — TL-mut(132), TL-mut2(96), Project(38), video-helpers(30), Export(27), queries(25), regions(21), VFX(18), Lifecycle(15), +11 more | B, V(8), X(1) | ⚑ raw `.get()` into `syncManager->setRegionProxySources` (3716); `*g_timeline` ref into OfflineRenderer (13247); MixEngine also wired to it at init |
| `g_undoManager` (185) | `unique_ptr<UndoManager>` | TL-mut(68), TL-mut2(60), VFX(12), Undo(12), regions(10), Project(7), Pattern, MIDI | B | |
| `g_projectManager` (186) | `unique_ptr<ProjectManager>` | Project(30), video-helpers(8), Export(8), Audio-core(3) | B | |
| `g_frameServer` (189) | `unique_ptr<FrameServer>` | Source(7), Project(7), Lifecycle | B | holds `*frameCache` ref |
| `decoderOwner` (198) | `deque<unique_ptr<VideoDecoder>>` | Project, Lifecycle, Legacy-TL, VideoMgmt, video-helpers | B | deque chosen deliberately so push_back never invalidates elements |
| `decoderPtrs` (199) | `vector<VideoDecoder*>` | video-helpers(9), Project(6), VideoMgmt(4), Lifecycle, Legacy-TL, sampler-helpers | B, V (via SyncManager) | **⚑⚑ SyncManager ctor holds `std::vector<VideoDecoder*>&` — a reference to the vector object itself (3694). The variable's address is load-bearing.** |
| `regionDecoderOwner` (206) | `unordered_map<int, unique_ptr<VideoDecoder>>` | video-helpers(4), Project, Lifecycle | B (mutations under `syncEventsMutex`) | |
| `regionDecoderPtrs` (207) | `unordered_map<int, VideoDecoder*>` | video-helpers(3), Lifecycle, Project | B, V (via SyncManager) | **⚑⚑ pointer passed via `setRegionProxySources(&regionDecoderPtrs, …)` (3716)** |
| `g_proxyManager` (209) | `unique_ptr<ProxyManager>` | video-helpers(14), Project(6), Lifecycle, Transport, Diag | B (+ its own transcode workers) | |
| `syncManager` (211) | `unique_ptr<SyncManager>` | Lifecycle(10), video-helpers(5), Legacy-TL(3), Project | B, V (videoTick) | holds refs to transport/decoderPtrs/frameCache |
| `videoThread` (214) | `std::thread` | Lifecycle | B | joined before `frameOutput` reconfig (documented invariant, 2782–2788) |
| `videoRunning` (215), `videoThreadCompletedTicks` (216) | `atomic<bool>` / `atomic<uint64_t>` | Lifecycle (+Video-frame) | B, V | |
| `g_previewDirty` (217) | `atomic<bool>` | TL-mut2(8), VFX(6), PrevPerf(5), video-helpers, Lifecycle, Source, Project | B (set), V (consume) | |
| `g_latestStoppedPreviewSeq` … `g_pendingStoppedPreviewSample` (218–222) | 5 × `atomic<uint64_t>/<int64_t>` | Lifecycle/V-body, Source, Diag | B, V | stopped-preview handshake |
| `syncEventsMutex` (226) | `std::mutex` | video-helpers(26), TL-mut(8), Project(7), Lifecycle(6), Undo(3), regions, Legacy-TL, PrevPerf, MIDI, sampler-helpers | B, V | ⚑ guards SyncManager event mutations *and* videoTick; documented lock order; single definition mandatory (ODR) |
| `frameOutput` (229) | `FrameOutput` (by value) | Video-frame(25), Lifecycle/V-body(33), Diag(5), Legacy-TL | B, V — **lock-free**; reconfigured only while video thread is joined | ⚑ V-thread touches it with no mutex; the object must stay a single stable instance |
| `g_gpuDevice` (232) | `unique_ptr<GpuDeviceManager>` | Diag(13), Lifecycle(11), Export(7), HwEnc(6), Gpu(4), Video-frame, PrevPerf | B, V(2) | ⚑ `*g_gpuDevice` ref into OfflineRenderer (13250) |
| `g_previewCompositor` (235) | `unique_ptr<GridCompositor>` | Lifecycle/V-body(19+11), PrevPerf(7), Video-frame(4), Diag | B, V | guarded by `g_previewCompositorMutex` |
| `g_previewRenderCache` (236), `g_previewRenderDecoder` (237), `g_previewAnimMgr` (238), `g_previewCollector` (239) | 4 × `unique_ptr` | Lifecycle/V-body, Project, Legacy-TL, Diag | B, V | preview pipeline set |
| **`g_previewTransitionFreeze`** (**main 245**) | `xleth::TransitionFreezeState` (POD) | **Preview/V-body only** — defs 245; refs 3424, 3428, both inside `videoThreadBody` | **V only** (read+write on the preview tick; nearest enclosing lock is `g_previewCompositorMutex` @3229) | **⚑ reverse capture** — see 2c trap 10 |
| `g_previewCompositorMutex` (241 / **main 247**) | `std::mutex` | Project, Lifecycle, Video-frame, PrevPerf, Legacy-TL, Diag | B, V | ⚑ lock order with `syncEventsMutex` documented in code; single definition mandatory |
| `g_previewCompositorReady` (242 / **main 248**), `g_previewPauseForExport` (243 / **249**), `g_previewPauseForVisibility` (244 / **250**) | 3 × `atomic<bool>` | Lifecycle/V-body, Video-frame, PrevPerf, Export, PreviewVis, Diag | B, V | pause flags: written by Export/PreviewVis handlers, polled by V |
| **`g_previewPauseForPosterLoad`** (**main 256**) | `std::atomic<bool>` | video-helpers (1967), V-body gate (3109, 3123), Lifecycle/Shutdown (4139), Transport Play/Stop/Pause (4425, 4446, 4462), PosterPrepass handlers (4583, 4600), PrevPerf (10083) | **B + V** | 4th pause flag; pairs with `g_previewPauseForExport`/`ForVisibility` |
| `g_previewDiag` (343) | `PreviewDiagCounters` — **~70 atomics** | **V-body(79 refs!)**, Diag(80), Video-frame, PrevPerf | B (read), V (write, every tick) | latency-sensitive instrumentation of the 0.25 ms composite floor; struct def (250–342) must move to the shared header with it |
| `g_hwEncoderDetector` (405) | `unique_ptr<HwEncoderDetector>` | HwEnc(8) only | B | |
| `CANVAS_W/H` (410–411) | `constexpr int` | Lifecycle(10), PrevPerf, Diag | — | compile-time; goes in header |
| `g_previewResolutionScale` (416), `g_previewEffectsBypass` (417), `g_previewPosterMode` (423), `g_previewProxyTargetHeight` (431) | `static float/bool/bool/int` — **plain, non-atomic** | PrevPerf(3–5 each), Lifecycle, video-helpers, Diag | B (write), **V reads `g_previewPosterMode`** (2 sites in V-body) | plain bool read cross-thread — pre-existing benign race; **do not "fix" during the move** (that's a behavior change) |
| `scalerCache` (439) | `unordered_map<int, ScalerEntry>` (SwsContext ptrs) | Lifecycle (Shutdown cleanup) only — **the CPU blit path that used it is `#if 0` (3518)** | B | effectively dead; move verbatim anyway (§9 cleanup note) |
| `statsMutex` (601), `statsSnapshot` (602) | `std::mutex` + `StatsSnapshot` | V-body(write, 4), Stats handler(read) | B, V | struct def (595–600) → header |
| `g_exportStateMutex` (612), `g_exportProgress` (613), `g_exportCancel` (614), `g_exportRunning` (615), `g_exportThread` (616) | mutex, snapshot struct, 2 atomics, `unique_ptr<thread>` | Export only | B, X | export worker writes progress under mutex; struct def (605–611) → header |
| `g_videoRenderer` (619) | `unique_ptr<OfflineRenderer>` | Export(11), **Project(2 — `Project_IsExportRunning`)** | B, R (internal) | ⚑ holds refs to `*g_timeline`, MixEngine, `*g_gpuDevice` → **destruction-order coupling** |
| `g_audioSuspendedForExport` (620) | `atomic<bool>` | Export | B | |

### 2b. Globals scattered OUTSIDE the main block (five clusters — all confirmed)

| Global (line) | Type | Domain / threads | Notes |
|---|---|---|---|
| `g_audioTraceMutex` (646), `g_audioTraceFile` (647), `g_audioTraceInit` (648) | mutex, `ofstream`, bool | audioTrace() static member fns; B + H | own anon ns at 644; `audioTrace` is a **public static member of XlethEngineService** — its TU placement is constrained by the class |
| `g_audioHealthThread` (650), `g_audioHealthStop` (651) | thread + atomic | health sampler; B spawns, H runs | thread body `audioHealthLoop` reads `audioEngine` |
| `g_posterEnqueued` (1552 / **main 1589**), `g_proxyEnqueuedRegions` (1560 / **1597**), `g_genFailCount` (1571 / **1608**), `g_genDisabled` (1572 / **1609**), `g_thumbnailEnqueued` (1577 / **1614**), `g_sourcePreviewEnqueued` (1582 / **1619**) | `unordered_set`/`map` (6 statics + `kGenMaxFailures` constexpr) | poster/proxy/thumbnail machinery (video-helpers), + Project, PrevPerf, Lifecycle | **B + V** — ⚠ **corrected**, see below | Touched only while holding `syncEventsMutex` — that lock discipline is what makes the B+V access safe, and it was documented correctly all along. |
| `g_audioPerformanceCaptureMutex` (10272), `g_lastAudioPerformanceCapture{Json,Markdown}Path` (10275–6), `g_audioPerformanceCaptureDrainThread` (10277), `g_audioPerformanceCaptureDrainStop` (10278) | mutex, 2 strings, thread, atomic | Audio-core perf capture; B + D | self-contained within audio-core |
| `g_mainXlethHwnd` (12636 / **main 13367**) | `atomic<uintptr_t>` | VST3 editor windows; B | self-contained |

#### ⚠ Correction to the §2b thread column for the poster/proxy/thumbnail statics

The original table classified those six as **"B only (enqueue/drain both run on message thread)"**.
**That is false, and it was already false at `126ba56`** — a census error, not drift introduced by
main. The enqueue/drain entry points are called from `videoThreadBody` as well as from bridge
handlers:

| Call site | at main | at 126ba56 | Thread |
|---|---|---|---|
| `drainSourcePosterResults()` | **3068** | **2843** | inside `videoThreadBody` → **V** |
| `maybeEnqueueSourcePoster(ev.sourceId)` | 3278 | 3025 | inside `videoThreadBody` → **V** |
| `maybeEnqueueCellThumbnail(...)` | 3279 | 3031 | inside `videoThreadBody` → **V** |
| `maybeEnqueueSourcePreviewProxy(...)` | 3315 | 3059 | inside `videoThreadBody` → **V** |

(`videoThreadBody` spans 3014–3922 on main; 2789–3621 at `126ba56`.)

The **lock** documentation ("Touched only while holding `syncEventsMutex`") is **correct** and is
exactly what makes the B+V access safe — only the thread column was wrong. Consequence: §6's claim
that "Stages 2–9 … Concurrency surface: none" is weakened for anything touching this cluster.

#### Poster prepass cluster (added on main by `fb81d69` — "Option B warm-on-engage")

| Global (main) | Type | Referencing domains | Threads | ⚑ |
|---|---|---|---|---|
| `g_posterPrepassMtx` (**442**) | `std::mutex` | video-helpers (1856, 1962), Transport (4422), PosterPrepass (4578, 4603), PrevPerf (10085) | **B + V** | **⚑ documented lock order** (trap 6b); single definition mandatory |
| `g_posterPrepassTotal` (**443**) | `int` (plain) | 1859, 4424, 4579 | B + V (**under `g_posterPrepassMtx`**) | — |
| `g_posterPrepassCompleted` (**444**) | `int` (plain) | 1860, 1964, 4424, 4580 | B + V (**under `g_posterPrepassMtx`**) | — |
| `g_posterPrepassActive` (**445**) | `std::atomic<bool>` | 1861, 1961, 1966, 4140, 4416, 4423, 4582, 4601, Project_Load 5336, PrevPerf 10080/10084 | **B + V** | — |
| `g_posterPrepassPending` (**454**) | `std::unordered_set<long long>` | 1857–1859, 1963, 1965, 4604, 10086 | B + V (**under `g_posterPrepassMtx`**) | — |

New handlers/functions this cluster brought: `buildPosterPrepass` (main 1777),
`PosterPrepass_GetStatus` (4572), `PosterPrepass_Skip` (4597). **Sequencing note:** every consumer
lands in **stage 17** (preview/transport/video core) except `Project_Load` (stage 12) — the cluster
is *not* spread across the schedule.

`g_posterPrepassTotal`/`Completed` are plain `int`s today. They are mutex-guarded, so promoting them
to cross-TU externs adds no race — but they are new cross-TU plain integers and worth a reviewer
note. Duplicating them per-TU (trap 3) would silently diverge the Play gate from the drain and hang
the video hold forever.

Plus notable **function-local statics** (safe — they move with their functions, listed for completeness): the V-body per-thread statics (~3364, explicitly commented safe), `ffmpegLogFilterInstalled` (15442), `static XlethEngineService instance` (15448), `ensureDetector()`'s lazy init.

### 2c. Cross-TU traps (the things a naive move breaks)

1. **`decoderPtrs` / `regionDecoderPtrs` addresses are held by SyncManager** (ctor ref at 3694; pointer at 3716). Stage 1 keeps them as process globals so nothing dangles — but their *definitions* must never be duplicated or turned into per-TU copies (which is exactly what would happen if two TUs each kept an anonymous-namespace copy — see trap 3).
2. **Destruction-order coupling.** `g_videoRenderer` → refs `*g_timeline`/MixEngine/`*g_gpuDevice`; `syncManager` → refs transport/`decoderPtrs`/`*frameCache`; `g_frameServer` → refs `*frameCache`; everything JUCE → `juceInit`. Today all these are statics **in one TU**, so C++ guarantees reverse-declaration-order destruction at process exit (explicit `Shutdown()` is the primary path, static destruction is the backstop). **Stage 1 rule: all globals go into ONE definitions TU, preserving today's relative declaration order.** Never spread definitions across domain TUs — cross-TU static destruction order is unspecified.
3. **The whole block is an anonymous namespace (internal linkage).** If two future TUs both included a header that *defined* these names in an anon namespace, each TU would get its own private copy — silent state divergence, no linker error. The extraction must convert them to **extern (named-namespace) declarations + single definition**, which is a linkage change but not a runtime behavior change.
4. **`probeAudioInfo` anon-namespace pincer** — forward-declared in an anon ns at 4787 (used by Project at 4856/5167), *defined* in a different anon ns at 13401 (Export/sample-swap). This only links because both ends are in the same TU today. The first stage that separates Project from Export must promote it to a shared internal header with external linkage.
5. **Capture-less lambdas referencing globals by name** are stored in long-lived subsystems: SyncManager's presentation-position callback (3697) and the sidechain resolvers (5918/5933) both name `audioEngine`. They keep working across any TU move *as long as `audioEngine` remains a process global* — another reason the context-struct conversion is deferred (§8): it would have to rework these captures, which is semantic surgery.
6. **Mutexes and documented lock orders.** There are **TWO** documented orders in this file, and both must be carried into the shared header and preserved by every later stage:
   - **(a)** `syncEventsMutex` ↔ `g_previewCompositorMutex` — both taken around SyncManager/compositor work.
   - **(b)** `syncEventsMutex` → `g_posterPrepassMtx`; **never the reverse.** Stated in code at main 441 and again at main 1776. Verified honored at the one nesting site: `drainSourcePosterResults` takes `syncEventsMutex` (1931) then nests `g_posterPrepassMtx` (1961); `buildPosterPrepass` (1777) does the same. This second invariant did not exist when this plan was first written and was missing from the original trap 6.

   Nothing captures these mutexes' addresses, but each must have exactly one definition (trap 3) and their locking comments must move with them into the shared header.
7. **`frameOutput` is touched lock-free by the video thread**; the documented invariant (2782–2788) is that reconfiguration happens only while the thread is joined. It is a by-value global — the single-definition rule covers it.
8. **`XlethEngineService::audioTrace`/`audioTraceEnabled` are class static members** (declared in `engine/include/XlethEngineService.h`) backed by the statics at 644–652 — whichever TU gets the trace statics must also define these two member functions.
9. **`isInitialised()` (221 uses), `BridgeCallLog` (985), `IPC_TIME_*` macros, `jsTo*`/`serialize*` helpers, `CANVAS_W/H`** are cross-cutting — they need a shared internal header (and, for the serde functions, eventually their own TU) before most domain moves can compile.
10. **`g_previewTransitionFreeze` is the INVERSE of trap 1 — a reverse capture.** Trap-1 globals are *captured by* a subsystem (SyncManager holds `decoderPtrs&`). This one *holds* a **non-owning** raw `ID3D11Texture2D* texA` pointing **into a render target owned by `g_previewCompositor`**. Two consequences:
    - It is a **trivially-destructible POD** (bool / int64_t / raw ptr, no user dtor), so it adds **no** static-destruction hazard today — nothing dangles at teardown because nothing is released. **Trap 2 does not bind it.**
    - `texA` is used as an **identity** check ("is the frozen A still in the RT I think it is?"), never dereferenced for ownership. Its correctness rests on invalidation discipline, not declaration order.

    Nevertheless it is declared **after** `g_previewCompositor` (main 245 vs 236), so it is destroyed **before** the compositor it observes — observer dies before observed, the correct direction. That is load-bearing-by-luck and worth keeping: **never hoist it above `g_previewCompositor`**, because a future type change (e.g. adding a `ComPtr`) would silently invert it into a use-after-free.

    **Domain note:** it is **V-body-only state and belongs to stage 17**, even though the 14 snapshot/cue/transition handlers that shipped with it landed in **Timeline mutations (stage 10)** — `Timeline_SetCueTransition` is a model mutation (`g_timeline->setCueTransition`), which is why those sit there. The handlers mutate the model; this freeze cache is a render-side artifact. **Do not let the stage-10 move drag it along.** (Stage 10 consequently grows by ~263 lines, 1,710 → ~1,973, and inherits the snapshot/cue surface; its mandatory seek/composite/drift row is unchanged but now more load-bearing.)

---

## 3. Stage 1 — globals extraction (zero handler moves, zero behavior change)

**PR 1 of the series. No handler or helper function bodies move.**

1. Create `engine/src/service/XlethSvcGlobals.h` (internal — lives in `src/`, NOT `include/`, so the "no host-runtime types leak" promise of the public header is untouched):
   - A named namespace (e.g. `namespace xleth::svc`) containing `extern` declarations for **every** variable in §2a and §2b, in documented groups, carrying over every threading/lock-order comment verbatim.
   - The type definitions those variables need: `PreviewDiagCounters`, `PolicySwitchReason`, `ScalerEntry`, `StatsSnapshot`, `ExportProgressSnapshot`, plus `CANVAS_W/H` as `inline constexpr`.
2. Create `engine/src/service/XlethSvcGlobals.cpp` defining **all of them, in today's exact relative order** (preserves init/destruction order — §2c trap 2). Add it to the `XlethEngineService` CMake target.
3. In `XlethEngineService.cpp`: delete the anonymous-namespace variable definitions, `#include "service/XlethSvcGlobals.h"`, and add `using namespace xleth::svc;` — this keeps all ~1,500 use sites compiling **without touching a single handler line**.
4. Also extract into a `XlethSvcShared.h` (same PR — these are declarations/macros, not code moves): `IPC_TIME_*` macros, `isInitialised()` (inline), `BridgeCallLog` (its full struct is 20 lines; keep it header-inline), and the fwd-decl of `syncTransportLoopFromTimeline`.
5. **Not** in Stage 1: helper function bodies (blit helpers, sampler/proxy/serde helpers) stay where they are; the scattered statics in §2b **also stay declared in the header but defined in the globals TU** — i.e. the six poster/proxy sets, the perf-capture statics, `g_mainXlethHwnd` and the trace statics lose their local-anon-ns homes and join the single definitions TU. This is deliberate: after Stage 1 there is exactly one place where engine-service state lives, and every later stage moves only *code*.
6. Flagged, comment-only rider (zero object-code impact): fix the stale `// XlethAddon.cpp` header line while the file header is being edited anyway. If reviewers prefer absolute purity, drop this.

7. **DEFERRED — the `XlethSvcAudioPerfCapture.h` split.** An earlier draft proposed moving
   `AudioPerformanceCaptureOptions/State` + the 7 perf-capture globals into their own header "and
   dropping `MixEngine.h` + `nlohmann/json.hpp` from `XlethSvcGlobals.h`". **That rationale is void
   and has been struck**, verified against main's committed headers:
   - `audio/MixEngine.h` **cannot** be dropped: `XlethSvcGlobals.h` must include `AudioEngine.h` for
     `extern std::unique_ptr<AudioEngine> audioEngine;` (the definitions TU instantiates the
     `unique_ptr` destructor, so the type must be complete), and `AudioEngine.h:16` includes
     `audio/MixEngine.h`. `AudioEngine` also holds `MixEngine mixEngine_;` **by value**
     (`AudioEngine.h:102`) — the dependency is structural. Removing the explicit include changes
     **zero** preprocessing cost.
   - `nlohmann/json.hpp` **cannot** be dropped: it arrives via **three** independently-required
     paths — `model/Timeline.h:12` (for `g_timeline`), `project/ProjectManager.h:6` (for
     `g_projectManager`), and `audio/MixEngine.h:5` (itself reached via `AudioEngine.h`).

   The split would also be a **deliberate exception to trap 2** (ONE definitions TU). The remaining
   argument for it is **domain cohesion** — the 7 globals + 2 types are self-contained within
   audio-core and the drain thread **D** is a self-contained unit — which is a real argument, but a
   different one, and it belongs with **Stage 13 (audio core)**, where its own benchmark row already
   exists. Stage 1's whole value is "one place, zero behavior change"; it does not carry a
   domain-cohesion refactor. **Perf-capture therefore stays in the universal header/TU for Stage 1.**

**Semantic delta, stated honestly:** internal → external linkage for **78** names (71 originally
censused + the 7 added on main). Not observable at runtime; the only theoretical effect is the
optimizer no longer proving TU-locality (relevant to the `g_preview*` flag reads on the V-thread).
`g_posterPrepassTotal`/`Completed` join that set as new cross-TU plain `int`s — they are
mutex-guarded, so no new race, but they are worth a reviewer note. This is why Stage 1 ends with one
benchmark capture (§7), which doubles as the recorded baseline for every later stage.

**Verification for Stage 1** (against the **corrected** baseline — the old "46 found, 4 known-fail"
is stale in both numerator and failure identities): clean rebuild; full ctest **43/47** (4 known:
`test_flip_orientation_golden`, `test_effects`, `test_reverb`, `test_real_render` — the last
segfaults and hardcodes `C:\Users\Krasen\Desktop\XLETH\test`, so it is machine-bound); bridge
contract **12/15** (3 known: `test_dynamics_viz`, `test_midi_import`,
`test_pdc_live_presentation_refresh`); app smoke via CDP (per the established recipe — check
`xleth_native.node` freshness first); one seek/composite/composite-under-load/drift capture as the
series baseline.

---

## 4. Stage 2+ — one domain TU per stage/PR, ordered

Ordering rationale, in priority order: (1) **prove the recipe on something trivially off the hot path first** (MIDI); (2) **read-only / delegating domains next** (diag, waveform, VST3, EQ bindings) — they reference few globals and call few cross-domain helpers, so each stage exposes at most one or two helpers into headers; (3) **model-mutating bridge-thread domains** in the middle (undo, queries, mutations, project) — large but single-threaded, their risk is bulk, not concurrency; (4) **cross-thread and hot-path domains last** (audio, export, source-preview, and finally transport/video/preview lifecycle), when the recipe, the shared headers, and the benchmark cadence are all proven. Within (4), audio precedes export because export's worker thread interacts with both audio suspension and preview pause; the video/transport/preview core goes dead last because `videoThreadBody` + its helpers are the 0.25 ms/60 Hz floor itself.

New files live in `engine/src/service/`, all added to the existing `XlethEngineService` CMake target. Each stage: move functions **verbatim** (review with `git diff --color-moved`), add the needed declarations to a per-domain header (for dispatch and cross-domain callers), keep `using namespace xleth::svc;` at the top of each new TU, run the §7 verification row. The generated `XlethRpcDispatch.inc` and `dispatch()` itself never change — handlers already have external linkage; `dispatch()`'s TU just includes the per-domain handler headers.

| Stage | New TU | Moves (lines from §1 map) | ~LOC | Cross-domain calls OUT (→ header exposure needed) | Hot path? |
|---|---|---|---|---|---|
| 2 | `XlethSvcMidi.cpp` | 15182–15401 | 220 | `rebuildVideoEventsFromClips` (via `syncEventsMutex` block), `syncMixerTrackSlots`, `triggerMipmapGeneration` → declare in `XlethSvcHelpers.h` (new, grows over stages) | No |
| 3 | `XlethSvcGpuDiag.cpp` | 14512–14571 (GPU mgmt) + 14572–15053 (Diag + `Gpu_SetAdapter`) + 15054–15159 (HW enc) + 15160–15181 (preview visibility) | 670 | reads `g_previewDiag`/pause flags/`g_gpuDevice` (globals only — already shared); diag text helpers (352–402) move along | No — read-side instrumentation & on-demand device enum. (`Gpu_SetAdapter` restarts the preview device; still a settings-time action, not per-tick.) |
| 4 | `XlethSvcWaveform.cpp` | 7282–7850 | 570 | `g_mipmapCache`, `sampleBank`, `g_timeline` (globals only); `wfbLog` anon-ns moves with it | No — UI waveform display |
| 5 | `XlethSvcVst3.cpp` | 12516–12842 | 330 | `getThisModuleDir` also used at Lifecycle(1) + fwd-decl at 163 → expose in helpers header | No |
| 6 | `XlethSvcEqWs.cpp` | 14062–14510 (EQ/WS/SmartBalance bindings) | 450 | pure MixEngine delegation | No — param bindings on B thread (DSP itself lives in engine, untouched) |
| 7 | `XlethSvcUndo.cpp` | 9870–9950 | 80 | `refreshAllClipCaches`, `rebuildAllSamplers`, `syncTransportLoopFromTimeline`, `rebuildVideoEventsFromClips` → helpers header | Indirect (rebuilds state the V thread reads) — cheap composite/drift check |
| 8 | `XlethSvcSerde.cpp/.h` + `XlethSvcTimelineQueries.cpp` | 1910–2777 (serde) + 5201–5423 (queries) | 1,090 | serde helpers become the shared serde TU consumed by every later timeline stage | No |
| 9 | `XlethSvcPatterns.cpp` | 7135–7281 + 7851–8800 (patterns/blocks/notes/Fsc/quantize/convert) | 1,100 | sampler-refresh helpers, serde | No (B-thread mutations) |
| 10 | `XlethSvcTimelineMut.cpp` | 5424–7134 (loop/BPM/grid/routing/sidechain/tracks/clips) + `makeSidechain*Resolver` | 1,710 | `syncTransportLoopFromTimeline` **definition** (5430) moves here or to helpers TU; `maybeEnqueueRegionProxy`, `invalidateRegionProxy`, serde, sampler helpers | Indirect — grid/routing mutations feed V-thread state; composite/drift check |
| 11 | `XlethSvcTimelineVisual.cpp` | 8801–9304 (flip/visual track settings) + 9443–9630 (VFX chain) + 9631–9869 (regions/auto-trim/syllables) | 1,030 | `g_previewDirty`, serde, `invalidateRegionProxy`, sampler helpers | Indirect — sets `g_previewDirty`, mutates visual model; composite check |
| 12 | `XlethSvcProject.cpp` | 4546–5200 | 650 | **promote `probeAudioInfo` to a shared header now (§2c trap 4)**; `ensureSourceDecoder`, `enqueueAllRegionProxies`, decoder teardown, `syncClipFadeToMixEngine`, `rebuildAllSamplers`, preview cache clears | **Yes** — project load rebuilds decoders/proxies (seek floor) and preview caches |
| 13 | `XlethSvcAudioCore.cpp` | 9951–11501 (core, RT diag, perf capture incl. its statics' *code*, track/master params) | 1,550 | MixEngine delegation; perf-capture thread self-contained | Adjacent — B-thread only, but exercise drift + audio-perf capture |
| 14 | `XlethSvcAudioFx.cpp` | 11504–12515 (chains, viz, FX graph, master graph) | 1,010 | MixEngine delegation | Adjacent — drift check |
| 15 | `XlethSvcExport.cpp` | 12843–13744 (audio/video/sample export) | 900 | `resolveExportScope`, `computeFullTimelineEndTick` move along; `refreshAllClipCaches`/`waitForClipCachesReady`, `refreshSamplerForRegion`, `triggerMipmapGeneration`, `probeAudioInfo` | **Yes** — spawns export worker, suspends audio, toggles `g_previewPauseForExport` |
| 16 | `XlethSvcSourcePreview.cpp` | 13746–14060 (`Source_*`, `Video_OpenSource/GetFrame/RequestPreviewFrame…`) | 320 | `g_frameServer`, stopped-preview seq atomics, `g_previewDirty` | **Yes** — stopped-preview re-render handshake with V thread |
| 17 | `XlethSvcPreviewCore.cpp` (optionally split a/b) | 624–1909 (trace/health + sampler + video/proxy/poster helpers — the definitions, now declared in helpers header) + 2778–3926 (lifecycle + `videoThreadBody` + `triggerMipmapGeneration`) + 3927–4064 (sample/video mgmt) + 4065–4244 (transport) + 4245–4425 (video frame) + 4426–4545 (legacy events + stats) + 9305–9442 (preview perf controls) + dead blit helpers (441–592) | ~3,900 (split a: transport/frame/legacy/stats ~700; split b: lifecycle + V-body + helpers ~3,200) | this TU *defines* most helpers others consume; `audioTrace` member fns move here (or stay in the residual dispatch TU — decide at PR time, §2c trap 8) | **YES — this IS the Phase 0 hot path** (60 Hz V-body, seek, drift, composite) |

**Residual `XlethEngineService.cpp` after Stage 17:** includes, module init + FFmpeg log filter, `getInstance`, `dispatch()` (+ the `.inc`), aggregate handler-header includes — a few hundred lines. Dispatch remains the seam throughout, exactly as AUDIT requires.

(17 stages ≈ 16 PRs is deliberately more granular than AUDIT's six named domains; stages 8–11 and 13–14 are the six domains split by bulk so each PR stays reviewable. If the team prefers strictly six PRs, stages merge cleanly along the domain names: timeline = 8+9+10+11, audio = 13+14, preview = 16+17.)

---

## 5. Per-TU dependency notes for header design

- **Everything** depends on: `XlethSvcGlobals.h`, `XlethSvcShared.h` (isInitialised/BridgeCallLog/IPC macros), `XlethServiceJsonApi.h`.
- **Serde** (`jsTo*`/`serialize*`) is consumed by: queries, patterns, mutations, visual, project, MIDI, export. It must land (stage 8) before stages 9–12.
- **Sampler/clip-cache helpers** (797–1006) are consumed by: patterns, mutations, undo, project, export, MIDI, transport. Declared in `XlethSvcHelpers.h` from stage 2 onward; definitions stay in the main TU until stage 17 claims them.
- **Proxy/poster/thumbnail helpers** (1368–1909) are consumed by: mutations, regions/visual, project, preview-perf, transport, V-body. Same header treatment; definitions move in stage 17.
- **`syncTransportLoopFromTimeline`** (def 5430): consumed by TL-mut, undo, project, trace. Moves with stage 10 (or into the helpers TU — either way, declared in the helpers header from stage 7).
- **`probeAudioInfo`**: shared Project ↔ Export; promoted at stage 12 (§2c trap 4).
- **`getThisModuleDir`**: VST3 + lifecycle; promoted at stage 5.
- No domain calls *into* MIDI, waveform, VST3, EQ/WS, GPU/diag, or export handlers — those six are pure leaves, which is exactly why they front-load the schedule (2–6) or sit self-contained late (15).

---

## 6. Threading summary per stage (what each PR can possibly break)

- Stages 2–9: bridge-thread-only code. Concurrency surface: none beyond globals already shared. Worst case is a compile/link error, not a race.
- Stages 10–12: bridge-thread code that mutates state read by the V thread **under existing locks** (`syncEventsMutex`, compositor mutex) — verbatim moves can't change lock behavior, but these stages touch the largest number of lock sites; review focuses on "no line changed inside any locked region."
- Stages 13–14: bridge thread ↔ audio RT boundary is entirely inside MixEngine (not moved); perf-capture drain thread moves as a self-contained unit.
- Stage 15: export worker thread + audio suspension + preview pause flags — three-thread interaction (B, X, V).
- Stage 16: stopped-preview sequence handshake (B ↔ V atomics).
- Stage 17: the video thread itself, `frameOutput` lock-free contract, thread start/join lifecycle, SyncManager reference captures (§2c traps 1, 7).

---

## 7. Benchmark matrix (Phase 0 floors: DNxHR proxy seek 28×, 0.25 ms GPU composite, <15 ms A/V drift)

Measurement mechanisms already in the product: composite = `Diag_GetVisualPreviewDiagnostic` (`avg/maxCompositeUs`, `avgTickUs`, `deliveredFps`) captured via CDP per the app-smoke recipe; drift = `getSyncStats` (`avgDriftMs`/`maxDriftMs`); seek = the Phase 0 DNxHR proxy seek capture (Transport_Seek against proxied sources). Always verify `xleth_native.node` embeds the rebuilt engine before capturing.

AUDIT's letter says re-run benchmarks "each time"; the matrix below marks where that is **mandatory** (hot path demonstrably involved) vs. where the stage is provably off the hot path and a smoke test suffices. Since the capture is cheap and scripted, the recommended posture is: run composite+drift after *every* stage anyway; the Mandatory column is the non-negotiable floor.

| Stage | Domain | Seek | Composite | Drift | Rationale |
|---|---|---|---|---|---|
| 1 | Globals extraction | ✅ baseline | ✅ baseline | ✅ baseline | linkage change touches V-thread-read flags; this capture is the series baseline |
| 2 | MIDI | — | — | — | provably off hot path (import-time, B thread) |
| 3 | GPU/Diag/HwEnc/PreviewVis | — | recommended | — | reads hot-path counters but only on demand; `Preview_SetEnabled`/`Gpu_SetAdapter` are settings-time |
| 4 | Waveform | — | — | — | off hot path |
| 5 | VST3 | — | — | — | off hot path |
| 6 | EQ/WS bindings | — | — | recommended | B-thread param sets; RT untouched |
| 7 | Undo | — | recommended | recommended | triggers full rebuilds consumed by V thread |
| 8 | Serde + queries | — | — | — | off hot path |
| 9 | Patterns/notes | — | recommended | — | mutations feed video events |
| 10 | Timeline mutations | ✅ | ✅ | ✅ | **mandatory** — loop region/BPM/grid/routing feed transport trap + V thread |
| 11 | Visual settings/VFX/regions | — | ✅ | — | **mandatory composite** — visual model + `g_previewDirty` |
| 12 | Project | ✅ | ✅ | ✅ | **mandatory** — project load rebuilds decoders/proxies (the seek floor lives here) |
| 13 | Audio core | — | — | ✅ | **mandatory drift** — transport/audio-engine adjacency + perf-capture threads |
| 14 | Audio FX/graphs | — | — | ✅ | **mandatory drift** |
| 15 | Export | ✅ | ✅ | ✅ | **mandatory** — audio suspension + preview pause + post-export resume |
| 16 | Source preview | — | ✅ | — | **mandatory composite** — stopped-preview handshake |
| 17 | Preview/Transport/Video core | ✅ | ✅ | ✅ | **mandatory, both sub-PRs** — this is the hot path itself |

---

## 8. Explicitly deferred follow-up (separate from S2's move series): context struct

Converting `xleth::svc` globals into an explicitly-passed `EngineServiceContext&` is **not part of any stage above** and must not be combined with any of them: it changes the call surface of ~290 handlers, reworks the capture-less lambdas stored in SyncManager/Timeline (§2c trap 5), and re-opens every destruction-order question. If pursued at all, it starts only after stage 17 has landed and held its benchmarks, as its own AUDIT item with its own risk row. The S2 series is complete and valuable without it: after stage 17, all state is enumerated in one header + one TU with documented threading columns — which is most of the safety benefit the context struct was after.

## 9. Cleanups noticed but deliberately NOT folded into any move PR

- Stale `// XlethAddon.cpp` header comment (line 1) — comment-only rider proposed in Stage 1, or its own trivial commit.
- Dead legacy CPU blit path: `blitYuvToCanvas`, `findActiveEventOnTrack`, `getCachedFrameForEvent/AtSourceTime`, `scalerCache` are only reachable from an `#if 0` block (3518–3539). Move verbatim in stage 17; delete later as a separate, trivially-reviewable PR.
- The pre-existing non-atomic cross-thread read of `g_previewPosterMode` (§2a) — document it in the globals header, do not change it in this series.
