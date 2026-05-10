# Plugin Delay Compensation Stage 1 Diagnostics

Date: 2026-05-09

## Files and Functions Touched

- `engine/src/audio/AudioGraph.h`
  - Added `getLatencyEpoch()`.
  - Added `refreshLatencyDiagnostics()`.
- `engine/src/audio/AudioGraph.cpp`
  - Added latency epoch increments from `computePDC()`.
  - Stopped `processBlock()` from doing diagnostic latency recomputation.
  - Fixed `getGraphTopology()` output node `cumulativeLatency` to use cached output latency.
- `engine/src/audio/EffectChainManager.h/.cpp`
  - Forwarded latency epoch and diagnostic refresh.
- `engine/src/audio/MixEngine.h/.cpp`
  - Added diagnostic `isInterTrackLatencyCompensationApplied()`.
  - Added `refreshLatencyDiagnostics()` for tests/tools to recompute chain latency under the existing chain mutex.
- `engine/src/audio/XlethEQEffect.h`
  - Added `getProcessBlockLatencyUpdateCount()`.
  - Added `getNonRealtimeLatencyUpdateCount()`.
  - Added `getReportedProcessorLatencySamples()`.
  - Moved XlethEQ reported-latency updates out of `processEffect()` and into `refreshLatencySamples()`, called from prepare, parameter, band, and state restore paths.
- `engine/test/test_pdc_stage1.cpp`
  - Added focused Stage 1 latency diagnostics.
  - Formalized already-present Stage 2 MixEngine and OfflineRenderer PDC/export behavior as ordinary regression coverage.
- `engine/CMakeLists.txt`
  - Added `test_pdc_stage1`.

## Tests Added

`test_pdc_stage1` covers:

- `XlethEQ Spectral latency diagnostics`
  - Proves Spectral mode reports `XlethParametricEQ::kSTFTHop`.
  - Proves the processor latency update is counted once from the non-audio parameter path on Spectral enable and not double-counted on steady-state blocks.
  - Proves disabling Spectral returns reported latency to zero before the next audio block.
  - Proves `processBlock()` does not call `setLatencySamples()`.
- `AudioGraph output latency cache and epoch`
  - Proves `AudioGraph::getOutputLatencySamples()` can expose a Spectral EQ chain latency after diagnostic recompute.
  - Proves `latencyEpoch_` increments on recompute, not every processed audio block.
  - Proves topology JSON reports the output node latency instead of hard-coding zero.
- PDC regression probes for already-present Stage 2 behavior
  - `track_to_track_impulse_alignment`
  - `master_only_latency_accounting`
  - `track_plus_master_accounting`
  - `export_preroll_discard_accounting`
  - `audio_exporter_preroll_discard`

## Current Regression Interpretation

These probes are now ordinary passing regression tests:

- `track_to_track_impulse_alignment` proves `MixEngine` delays lower-latency audible tracks by `maxAudibleTrackLatency - trackLatency` before summing.
- `master_only_latency_accounting` proves master insert latency is reported separately and is not folded into per-track differential compensation.
- `track_plus_master_accounting` proves track PDC and master/common-path latency remain separate when both are present.
- `export_preroll_discard_accounting` proves export preroll/discard accounting is `maxAudibleTrackLatencySamples + masterInsertLatencySamples`.
- `audio_exporter_preroll_discard` proves `AudioExporter::renderOffline()` discards plugin-latency preroll before writing exported audio.

Historical note:

- Stage 1 added latency observability and the focused tests.
- Stage 2A fixed `AudioExporter::renderOffline()` preroll/discard accounting.
- `MixEngine` inter-track PDC and `OfflineRenderer::renderImpl()` export preroll/discard behavior were already present in this dirty workspace before the Stage 1 diagnostic patch landed. The tests now formalize that behavior as normal regression coverage.

## Evidence: MixEngine Inter-Track PDC

The regression evidence is:

- `MixEngine::isInterTrackLatencyCompensationApplied()` returns true.
- A dry audible track receives compensation equal to the latent track's Spectral EQ latency.
- The latent track receives zero extra differential compensation.
- Master insert latency is exposed separately through `LatencyCompensationSnapshot::masterInsertLatencySamples`.
- `MixEngine.cpp` contains `trackCompensationDelays_` processing and computes `maxAudibleTrackLatency - trackLatency`.

## Evidence: Export Preroll/Discard

The regression evidence is:

- `maxAudibleTrackLatencySamples + masterInsertLatencySamples` is available as the total export preroll/discard amount.
- `OfflineRenderer::renderImpl()` computes `historyPreroll`, `totalDiscard`, and `renderEnd` from track plus master latency.
- `AudioExporter::renderOffline()` uses the same latency snapshot to render preroll and discard it before writing output.
- The `audio_exporter_preroll_discard` test exports a WAV through a known-latency master Spectral EQ and verifies the output peak remains aligned with the original impulse position.

## Stage 2C: Export Latency Edge Cases

`test_pdc_stage1` now adds focused AudioExporter edge-case regression coverage for:

- export starting at sample 0 with latent master processing, including render-start clamp to zero and exact requested duration,
- export starting before full preroll is available, including `availablePreroll = requestedStartSample`,
- export starting after full preroll is available, including `renderStartSample = requestedStartSample - (maxTrackLatency + masterLatency)`,
- partial final-block exports whose requested duration is not a render-block or MixEngine-block multiple,
- zero-latency project export with no artificial preroll or discard,
- combined track-plus-master latency, proving track PDC remains differential and master latency is not folded into per-track compensation,
- accounting parity between `AudioExporter` and `OfflineRenderer` preroll/discard math for start-zero, partial-preroll, full-preroll, zero-latency, and track-plus-master cases.

The new tests exposed one production bug in `AudioExporter::encodeWithFFmpeg()`: WAV/PCM exports padded the final FFmpeg frame out to the encoder chunk size, so decoded output duration could exceed the requested duration. The minimal fix is to use a short final frame for variable-frame-size encoders such as PCM WAV, while preserving the existing padded fixed-frame behavior for codecs that require fixed frame sizes.

Direct sample-buffer parity against `OfflineRenderer` is still not exercised here because `OfflineRenderer::renderImpl()` is private and coupled to the full A/V mux/GPU export pipeline. Stage 2C therefore covers `OfflineRenderer` consistently at the shared preroll/discard accounting level, while `AudioExporter` gets file-level sample alignment and exact-duration coverage.

## Evidence: XlethEQ Spectral Latency

`XlethEQEffect.h` is the observed high-latency WOLA/STFT path:

- `kSTFTSize = 4096`
- `kSTFTHop = 2048`
- `getLatencySamples()` adds `kSTFTHop` when Spectral/STFT band state is active.
- `refreshLatencySamples()` updates JUCE's reported processor latency via `setLatencySamples(newLat)` from non-audio-thread state-change paths.
- `processEffect()` may read the cached latency-affecting state, but it must not call `setLatencySamples()`.

`test_pdc_stage1` verifies that this path reports `2048` samples, that the non-audio update is counted, and that process-block latency updates stay at zero.

## Stage 4A: XlethEQ Dynamic Latency Hygiene

The old issue was that XlethEQ could discover Spectral/STFT latency inside `processEffect()` and update the host-visible latency from the audio callback. That made graph/PDC/presentation/export state depend on an audio-block side effect.

The rule now is:

- XlethEQ latency-affecting controls refresh reported latency through `refreshLatencySamples()` on non-audio-thread paths.
- The owning `AudioGraph::setEffectParameter()` observes the reported latency change and calls `rebuildImmediate()`, which recomputes PDC and increments the latency epoch once for the intentional change.
- `MixEngine::setEffectParameter()` uses the chain owner path and marks `pendingLatencyCompensationReset_`, so render-side track PDC retargets without graph work in the realtime callback.
- `AudioEngine::refreshLivePresentationLatency()` reads the updated MixEngine latency snapshot; export preroll/discard reads the same snapshot and keeps the existing formula.

XlethEQ controls that affect reported latency:

- Spectral/STFT band mode, when an enabled band is in mode `2` and linear phase is off, adds `kSTFTHop`.
- Linear phase adds `firLength_ / 2`, with `firLength_` prepared from sample rate.
- Oversampling adds the JUCE oversampler latency for the selected 2x/4x path, except Spectral mode bypasses oversampling because Spectral wins that mutual-exclusion path.
- Band enable/disable can affect latency when the affected band is in Spectral mode.
- State restore and sample-rate reprepare call the same refresh path before playback/export relies on the chain.

Stage 4A tests cover process-block no-op latency counters, Spectral on/off graph epoch propagation, linear-phase toggles, oversampling toggles, state restore before first process block, live presentation refresh after an XlethEQ latency change, and export accounting after an XlethEQ latency change.

## Stage 4B: Built-In Dynamic Latency Contract

Stage 4B audits every built-in effect created by `AudioGraph::createEffect()` and
extends the Stage 4A XlethEQ latency hygiene rule to the rest of the stock
effect set:

- Latency-affecting built-in parameters publish reported latency from
  prepare/state/owner parameter paths, not from `processBlock()` or
  `processEffect()`.
- Built-in audio callbacks may read latency-affecting state for DSP, but they
  must not call `setLatencySamples()`, allocate/log/block for latency updates,
  or trigger graph/topology recompute.
- Tail length remains separate from PDC latency. Delay feedback and reverb
  decay are tails, not latency.

Built-in latency classification:

| Effect | Classification | Latency-affecting controls | Stage 4B result |
| --- | --- | --- | --- |
| `xletheq` | Dynamic latency | Spectral band mode/enabled state, linear phase, oversample mode, sample-rate prepare | Already Stage 4A-compliant via `refreshLatencySamples()` from non-audio paths. |
| `compressor` | Dynamic lookahead latency | `lookahead` in ms, sample-rate prepare | Moved reported-latency publication out of `processEffect()` and into prepare, parameter, and state-restore refresh paths. |
| `limiter` | Dynamic style/lookahead latency | `style` chooses lookahead time; oversampler latency is prepare-time static component | Moved style latency publication out of `processEffect()` and into prepare, parameter, and state-restore refresh paths. |
| `resonancesuppressor` | Dynamic spectral latency | `processing_mode`, `quality`, `mix`, `delta`, bypass, sample-rate prepare | Removed process-path latency refresh; state restore now reprepares high-quality WOLA before publishing restored quality latency. |
| `distortion` | Static nonzero latency after prepare | Fixed 4x FIR oversampler | Left unchanged; prepare publishes static oversampling latency and process blocks keep it stable. |
| `waveshaper` | Static nonzero latency after prepare | Fixed 4x FIR oversampler | Left unchanged; prepare publishes static oversampling latency and process blocks keep it stable. |
| `delay` | Static zero latency, nonzero tail possible | None for PDC; delay time/feedback affect creative delay/tail | Confirmed tail is not reported as latency. |
| `reverb` | Static zero latency, nonzero tail possible | None for PDC; predelay/decay are creative/tail timing | Confirmed tail is not reported as latency. |
| `overdone` / OTT | Static zero latency | None | Confirmed multiband crossover/dynamics path does not report PDC latency. |
| `transientproc` | Static zero latency | None | Confirmed envelope/MIDI transient shaping does not report PDC latency. |
| `xlethfilter` | Static zero latency | None | No latency-reporting path. |
| `flanger` | Static zero latency | None for PDC; modulated delay is the effect sound | No latency-reporting path. |
| `phaser` | Static zero latency | None | No latency-reporting path. |

Stage 4B tests added to `test_pdc_stage1`:

- `Builtins processBlock latency publish audit` instantiates stock processors,
  prepares them, processes diagnostic blocks, and verifies dynamic counters or
  stable reported latency.
- `Builtins Dynamic latency parameter and state paths` proves Compressor,
  Limiter, and ResonanceSuppressor publish parameter/state latency before first
  audio processing.
- `Builtins Dynamic latency owner propagation` proves an owner-path Compressor
  lookahead change updates AudioGraph output latency/epoch, MixEngine track
  latency diagnostics, live presentation diagnostics, and export preroll
  accounting.
- Tail-only Delay/Reverb checks prove tail length stays separate from PDC
  latency.

## Stage 4C: Third-Party Dynamic Latency Refresh

Stage 4C formalizes the third-party/VST latency contract around
`GuardedPluginWrapper`:

- `GuardedPluginWrapper::refreshReportedLatency()` is the only wrapper path that
  polls `inner_->getLatencySamples()` and publishes changed latency via
  `setLatencySamples()`. It is intended for non-audio-thread owner calls.
- Safe refresh triggers are wrapper construction, `prepareToPlay()`,
  `setStateInformation()`, guarded program changes, crash recovery, owner-routed
  third-party parameter changes, missing-plugin resolution, project load, and
  out-of-process editor PARM/STAT mutation callbacks.
- `processBlock()` does not call `setLatencySamples()`, does not poll plugin
  latency, and does not mark graph/PDC state dirty. The diagnostic
  `processBlockLatencyPublishCount` is expected to remain zero.
- `AudioGraph::refreshGuardedPluginLatency()` consumes changed wrapper latency
  by using the existing immediate rebuild/PDC recompute path. This updates graph
  output latency and latency epochs without adding a parallel PDC system.
- `MixEngine::refreshGuardedPluginLatency()` and parameter/state owner paths mark
  the existing pending latency-compensation reset, so inter-track PDC, export
  preroll/discard accounting, and live presentation diagnostics continue to use
  the established latency formulas.
- Diagnostic counters exposed on the wrapper are
  `nonRealtimeLatencyRefreshCount`, `latencyChangePublishCount`,
  `processBlockLatencyPublishCount`, `pendingLatencyChangeFlagCount`, and
  `staleLatencyDetectedCount`.

No message-thread polling was added in Stage 4C. The remaining limitation is
third-party plugins that change latency internally without any parameter,
program, state, recovery, or host/editor mutation event. Those plugins need an
explicit future polling policy or plugin-specific host notification before Xleth
can detect the change without touching the realtime callback.

Stage 4C tests added to `test_pdc_stage1`:

- `GuardedPluginWrapper Third-party latency refresh contract` proves
  constructor/prepare/state refresh, no-op refresh, pending-flag diagnostics,
  and zero process-block latency publishing.
- `Graph Third-party wrapper latency propagation` proves owner refresh updates
  AudioGraph output latency/epoch and unchanged refreshes do not churn epochs.
- `MixEngine Third-party latency propagation` proves refreshed third-party
  latency reaches MixEngine inter-track PDC, export accounting, and live
  presentation diagnostics.

## Stage 4D: Third-Party Mutation Route Audit

Stage 4D hardens every host-visible real third-party mutation route around the
same `GuardedPluginWrapper` refresh contract. No parallel latency/PDC system was
added.

| Route | Owner path | Thread/context | Latency refresh and PDC result |
| --- | --- | --- | --- |
| Bridge/UI parameter edit and host parameter automation | `XlethAddon::Audio_SetEffectParameter()` -> `MixEngine::setEffectParameter()` -> `EffectChainManager` -> `AudioGraph::setEffectParameter()` -> `GuardedPluginWrapper::setWrappedParameterValue()` | Bridge/message thread, non-audio | Wrapper applies the normalized parameter, owner calls `refreshReportedLatency()`, and changed latency rebuilds AudioGraph PDC plus MixEngine pending compensation reset. |
| Out-of-process plugin editor parameter edit | `EditorProcessCoordinator` PARM -> `GuardedPluginWrapper::setWrappedParameterValue()` -> `MixEngine::refreshGuardedPluginLatency(track,node,publishCountBefore)` | Editor IPC poll thread, non-audio | Editor changes no longer mutate the inner plugin bare; the wrapper guards the apply and owner refresh handles changed latency. |
| Out-of-process editor preset/state apply | `EditorProcessCoordinator` STAT -> `GuardedPluginWrapper::setStateInformation()` -> publish-count-aware owner refresh | Editor IPC poll thread, non-audio | If the wrapper already published during state restore, the owner still rebuilds PDC by comparing the wrapper publish count from before the apply. |
| Program change | `AudioGraph::setEffectProgram()` / `EffectChainManager::setEffectProgram()` / `MixEngine::setEffectProgram()` -> `GuardedPluginWrapper::setWrappedCurrentProgram()` | Owner/message thread, non-audio | Program latency is refreshed before the next audio block; changed latency triggers the existing graph and MixEngine PDC mechanisms. |
| Project restore and missing-plugin resolve | `AudioGraph::fromJSON()` and `AudioGraph::tryResolvePlugin()` restore state through `GuardedPluginWrapper::setStateInformation()` and finish with the existing rebuild path | Project load/reload owner path, non-audio | Restored plugin latency is visible before first processing after load/resolve. Missing placeholders remain zero-latency passthrough until resolved. |
| Bypass toggle | `AudioGraph::setBypass()` -> `GuardedPluginWrapper::setWrappedBypass()` -> refresh | Owner/message thread, non-audio | Insert bypass preserves PDC latency while the plugin remains inserted. Removing/disabling the insert removes it from chain latency accounting. |
| Crash recovery | `MixEngine::resetCrashedPlugin()` -> `EffectChainManager` -> `AudioGraph::resetCrashedPlugin()` -> `GuardedPluginWrapper::resetCrashed()` | Owner/message thread, non-audio | Successful recovery refreshes wrapper latency and owner PDC if it changed. A still-crashed plugin keeps the last published insert latency as the safe value until recovery/removal, avoiding under-reporting. |
| Plugin-internal process-time latency changes | none in realtime callback | Audio callback | Deliberately not polled or published from `processBlock()`. The wrapper may observe stale inner latency for diagnostics, but realtime code does not rebuild or mark PDC dirty. |

Bypass policy: a bypassed third-party insert keeps contributing its preserved
active latency to PDC unless the insert is removed from the processing topology.
This avoids track-alignment jumps when users toggle bypass. If a plugin reports
lower or zero latency while bypassed, `GuardedPluginWrapper` preserves the last
active latency and will only raise the published latency if the bypassed report
is higher. Removing the insert removes its latency.

Polling decision: no low-frequency non-audio polling was added in Stage 4D.
Xleth now refreshes on all audited host-observable mutation routes. The
remaining limitation is third-party plugins that change latency internally
without any host-visible parameter, program, state, bypass, recovery, editor, or
project-restore event. Those plugins require a future explicit host notification
or a carefully throttled non-audio polling policy.

## Stage 5: Audio Performance Telemetry

PDC diagnostics are now deliberately separate from realtime CPU deadline
diagnostics. Stage 5 adds a fixed-size POD telemetry ring and off-thread
aggregation for callback duration, MixEngine duration, chain/effect timing,
overruns, lock misses, stale state reuse, latency epoch churn, and compensation
target churn. See
[`audio-performance-telemetry-stage5.md`](audio-performance-telemetry-stage5.md)
for interpretation guidance, especially for ResonanceSuppressor High Quality
WOLA timing.

Stage 4D tests added to `test_pdc_stage1`:

- `Graph Third-party program/state/bypass/editor latency routes` covers
  program changes, owner state restore, editor-style STAT after the wrapper has
  already published latency, no-op state restore with no epoch churn, bypass
  latency preservation, and removal latency removal.
- `MixEngine Third-party latency propagation` now also covers owner-routed
  third-party program and state restore changes in MixEngine diagnostics.
- The fake third-party plugin now changes latency from real parameter,
  program, state, and bypass parameter callbacks; no real VST is required.

## Next Stage Target

The current regression tests cover Stage 1 observability, Stage 2 MixEngine/OfflineRenderer behavior, Stage 2A/2C AudioExporter preroll/discard behavior, and Stage 3 live presentation latency. Keep these tests green while touching export, mix, bridge transport-state, or live video/playhead paths.

Do not change clip, note, timeline, or UI positioning to compensate latency. Scheduling and export stay on raw transport; live display uses presentation time.

## Stage 3: Live Presentation Latency

Live playback now separates the musical transport clock from the presentation clock:

- Raw transport is still `Transport::getPositionSamples()` and remains the clock for audio rendering, clip dispatch, notes, automation, timeline edits, and export.
- Live presentation position is owned by `AudioEngine` and is computed as:

  `max(0, rawTransportSample - (maxAudibleTrackLatencySamples + masterInsertLatencySamples + audioDeviceOutputLatencySamples))`

- Plugin latency comes from the existing MixEngine latency accounting: max audible track latency plus master insert latency.
- Device output latency is cached from `juce::AudioIODevice::getOutputLatencyInSamples()` outside the realtime callback. If there is no active audio device, the cached device latency is zero. Tests can inject this component through the AudioEngine diagnostic override.
- Offline export excludes audio-device output latency because exports are rendered to files, not to the active live playback device.
- Live video and playhead consumers should use the engine presentation getters/bridge presentation fields. They must not duplicate this formula in React or apply renderer-only offsets.
- Bridge transport state exposes `positionMs`, `positionBeats`, `positionBars`, and `positionSamples` as live presentation fields for UI display. `rawPositionMs`, `rawPositionBeats`, `rawPositionBars`, and `rawPositionSamples` remain available for editing, scheduling diagnostics, and tests that need unshifted transport time.

## Stage 3 Test Cleanup

Older `test_mix` live-preview probes used a hidden Transport-owned preroll model. Those probes have been rewritten so live playback starts at the raw requested sample, `getRenderPositionSamples()` equals raw transport time, and presentation lag is asserted separately from MixEngine latency diagnostics. Export preroll/discard tests remain separate and still cover file render alignment.

## Stage 3D: Runtime Harness Stabilization

`test_offline_render` could previously exit before printing its first harness
diagnostic. With no FFmpeg DLL path, Windows failed the process at load time
with `0xC0000135`; with the DLL path present, the Debug harness could exhaust
the default MSVC stack reserve before `main()` printed any step marker. The
Debug `test_offline_render` target now reserves a larger stack on MSVC so real
renderer failures reach the existing `[TEST:Renderer]` diagnostics instead of
ending as a silent process exit.

The bridge shutdown/re-init failure was lifecycle ordering, not transport math.
Tests could call `shutdown()` immediately after `initialize()` while the preview
video thread was still entering its first SyncManager/frame-cache tick, and
native teardown could release SyncManager/project state while the AudioEngine
device was still live. `initialize()` now waits briefly for the first completed
preview tick before returning, and `shutdown()` stops AudioEngine before
releasing SyncManager/timeline-owned state. The shutdown path also emits
`[BridgeShutdown]` step markers so future lifecycle failures identify the exact
teardown owner instead of surfacing as an ambiguous process exit.

`bridge/test_transport_contract.js` is the dedicated Stage 3 bridge transport
contract test. It asserts that `positionMs`, `positionBeats`, and
`positionSamples` are live presentation fields; that `rawPositionMs`,
`rawPositionBeats`, and `rawPositionSamples` remain raw transport fields; that
nonzero live presentation latency keeps raw position greater than or equal to
presentation position; and that zero latency keeps the raw and presentation
positions equal. It uses the engine-provided presentation diagnostics and does
not add a React- or bridge-side latency formula. The test uses the
`initialize({ disablePreviewGpu: true })` diagnostic option so this transport
contract does not depend on preview GPU hardware; `bridge/test_phase1.js` still
exercises the normal preview lifecycle during shutdown/re-init.

Production behavior touched in this pass was limited to bridge/native lifecycle
stabilization, explicit preview compositor shutdown, and exposing the existing
AudioEngine diagnostic latency override to JS tests. PDC math, export
preroll/discard math, OfflineRenderer timing math, the Stage 3
presentation-latency formula, raw transport semantics, XlethEQ DSP, and
timeline data were not changed.
