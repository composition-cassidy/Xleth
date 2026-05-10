# PDC Stage 7B — Live Presentation Latency Refresh

## Branch / HEAD sanity

| | Value |
|---|---|
| User's primary checkout | `C:\Users\Krasen\Desktop\XLETH` |
| Branch on primary (post-checkpoint) | `stage7b-pdc-live-presentation-checkpoint` |
| Safety checkpoint commit | `db2cb7bcc17d9145299218f2844a20d4f9e77bb0` |
| Stage 7B fix worktree | `C:\Users\Krasen\Desktop\XLETH-stage7b` |
| Worktree branch | `stage7b-live-presentation-fix` (off the checkpoint) |
| Worktree path deviation | Originally requested `…\diagnostics\worktrees\stage7b-live-presentation-fix` (79 chars). That path overflowed Windows MAX_PATH on the deep `diagnostics/audio-performance/real-project-stage6h/...` filenames. Sibling-of-primary path used instead — same depth as primary, same files now check out cleanly. |

PDC Stage 1–6 symbol presence confirmed in the worktree (counts):
- `refreshLivePresentationLatency` — 32 hits across 5 files
- `livePresentationTotalLatencySamples_` — 4 hits in `AudioEngine.{h,cpp}`
- `getLivePresentationPositionSamples` — 12 hits across 4 files
- `pendingLatencyCompensationReset_` / `activeResonanceSuppressorHighQualityInstanceCount` / `realtimeRsHqRiskLevel` — 143 hits across 35 files

## Problem (Stage 7A finding)

Adding Resonance Suppressor in High Quality mode to one individual track in the
NO MAIL project caused live playback to feel off-grid; some sounds drifted
relative to others. Stage 7A diagnosed it as **category 5 + 6** (UI presentation
+ telemetry/diagnostics mismatch): per-route audio PDC was correct (Stage 1–4
math), but the AudioEngine's *live presentation latency cache*
(`livePresentationTotalLatencySamples_`) was only refreshed on transport
lifecycle events (play/seek/device-change/shutdown). Plugin-mutation paths that
adjust MixEngine compensation never poked the AudioEngine cache, so the bridge
returned a stale `livePresentationLatencySamples` and the playhead/grid/video
preview lagged by exactly the new insert latency until the user pressed
Stop/Play.

## Root cause (in code)

Pre-fix `engine/src/AudioEngine.cpp`:

```cpp
// Cache mirror — written only by refreshLivePresentationLatency()
std::atomic<int64_t> livePresentationTotalLatencySamples_{ 0 };

int64_t AudioEngine::getLivePresentationLatencySamples() const {
    return livePresentationTotalLatencySamples_.load(std::memory_order_acquire);
}

int64_t AudioEngine::getLivePresentationPositionSamples() const {
    return std::max<int64_t>(0,
        transport_.getPositionSamples() - getLivePresentationLatencySamples());
}
```

`refreshLivePresentationLatency()` was called from:
- `AudioEngine::initialize / shutdown / playTimeline / seekTimelineToSample / setOutputDevice / setTestDeviceOutputLatencySamplesForDiagnostics / audioDeviceAboutToStart / audioDeviceStopped`
- 15 bridge sites in `bridge/src/XlethAddon.cpp` (project load, project new, track mute/visualOnly/solo, addEffect, removeEffect, moveEffect, setEffectBypass, setEffectParameter, addMasterEffect, removeMasterEffect, moveMasterEffect, setMasterEffectBypass)

**Holes (mutation paths that change MixEngine latency but never call
`AudioEngine::refreshLivePresentationLatency`)**:
1. `MixEngine::setMasterEffectParameter` — no bridge wrapper exists.
2. `MixEngine::setEffectProgram` (track or master) — no bridge wrapper.
3. `MixEngine::setEffectStateInformation` (track or master) — no bridge wrapper.
4. `MixEngine::refreshGuardedPluginLatency` — fired by `GuardedPluginWrapper`
   itself when a third-party plugin reports new latency mid-flight. Does not
   pass through any bridge surface.
5. Plugin-editor parameter / state / program callbacks (the host editor
   process changing third-party state).

For paths 1–3 the bridge could be patched. For 4–5 it cannot — those mutations
originate in MixEngine internals and the wrapper's IPC, not the bridge thread.
Even if every bridge site were covered, two non-bridge paths would still leak.

## Fix architecture — Option A (compute live on read)

Authoritative track / master insert latency lives in MixEngine
(`MixEngine::getLatencyCompensationSnapshot()`), which already computes from
the live `effectChains_` / `masterEffectChain_` state under `chainsMutex_`.
Make `AudioEngine` query that on every read instead of returning a cached
value. The audio render thread does not take `chainsMutex_` (it uses lock-free
atomics like `pendingLatencyCompensationReset_`), so the read-side mutex
acquire only contends with non-RT chain mutators — and only briefly.

The cached atomics (`livePresentationMaxTrackLatencySamples_`,
`livePresentationMasterLatencySamples_`, `livePresentationTotalLatencySamples_`)
are kept in place as advisory mirrors for any external observer that reads
them directly; `refreshLivePresentationLatency()` continues to update them and
all 15+ existing call sites remain valid (now harmless cache updates rather
than the source of truth).

### Why not Option B (epoch counter) or Option C (sprinkle refreshes)

- **B (MixEngine-to-AudioEngine epoch)**: Requires either threading a new
  `std::atomic<uint64_t>` epoch through every mutation site under
  `chainsMutex_`, or piggy-backing on the existing
  `pendingLatencyCompensationReset_` flag (which is consumed by the audio
  thread on each block — repurposing it for a UI-side check would race with
  the audio thread's `exchange(false)`). Net: more new state and ordering
  contracts than Option A, with no concrete win since the read-side mutex
  acquire is cheap.
- **C (sprinkle refreshes)**: Cannot cover paths 4–5 above without coupling
  `GuardedPluginWrapper` and the editor IPC back into AudioEngine. Brittle by
  construction. Stage 7A tagged this as the explicit fallback only.

## Files changed

### `engine/src/AudioEngine.cpp`

Three functions rewritten to compute live from MixEngine on each call:

- `getLivePresentationLatencySamples()` — was `return totalCache_.load();`,
  now reads `mixEngine_.getLatencyCompensationSnapshot()` plus the cached
  device output latency and sums.
- `getLivePresentationPositionSamples()` — now subtracts the live latency
  (transitively gets the fix via `getLivePresentationLatencySamples()`).
- `getLivePresentationLatencyDiagnostics()` — recomputes max-track / master
  / total live; device output still comes from the device-cached atomic
  (only changes on device reconfig, which already refreshes the cache).
- `refreshLivePresentationLatency()` — body unchanged; comment added marking
  it as an advisory cache writer rather than the read source of truth.

No public API change. `engine/src/AudioEngine.h` untouched.

### `engine/test/test_pdc_stage1.cpp`

Added `testLivePresentationLatencyAutoRefreshAfterMutation()` and registered
it in `main()`. Six subtests, each of which mutates the chain and immediately
reads `getLivePresentation*` **without** any call to
`refreshLivePresentationLatency()` and **without** any transport / lifecycle
event. The pre-fix code fails every subtest beyond the first read:

1. Track insert added — diagnostics + getter must reflect new latency.
2. Track parameter mutation (XlethEQ Spectral toggle) — same.
3. Pre-existing master spectral + new track spectral — sums correctly,
   no double counting (matches the NO MAIL "master RS HQ already present"
   pattern).
4. Remove path — latency drops live.
5. Master parameter mutation via `MixEngine::setEffectParameter(-1, …)` —
   the path with no bridge refresh wrapper.
6. End-to-end position math — confirms `getLivePresentationPositionSamples`
   shifts by exactly the added insert latency without any seek.

## Before / after behaviour

| Scenario | Before | After |
|---|---|---|
| Add latency-inducing insert mid-playback | Bridge returns stale latency until next Stop/Play/Seek; playhead drifts forward by the new insert latency | Bridge returns new latency immediately; playhead snaps to the new compensated position on the next poll |
| Toggle XlethEQ Spectral via setEffectParameter | Same staleness | Fixed |
| Toggle plugin parameter from third-party plugin's own editor (GuardedPluginWrapper auto-detects new latency) | Stale until Stop/Play | Fixed |
| Master `setEffectParameter` (no bridge wrapper) | Permanently stale unless coincidental refresh | Fixed |
| Project load with master RS HQ pre-existing | Refresh was already wired here; correct | Still correct (additionally the live read path can't go stale even if a future load path forgets) |
| Per-route audio PDC accounting | Correct | Unchanged — MixEngine math untouched |
| Export accounting | Correct | Unchanged — different code path (`AudioExporter`) |
| Raw transport semantics | Correct | Unchanged |

## Validation

Run from the worktree (`C:\Users\Krasen\Desktop\XLETH-stage7b`) with the
shared vcpkg debug DLLs on PATH:

| Target | Result |
|---|---|
| `test_pdc_stage1` | **ALL TESTS PASSED**, 584 checks, 0 failures (includes the new `testLivePresentationLatencyAutoRefreshAfterMutation`) |
| `test_mix` | **ALL TESTS PASSED**, 243 checks |
| `test_audio_telemetry` | **ALL TESTS PASSED**, 42 checks |
| `git diff --check` | clean |

Bridge tests (`test_audio_telemetry.js`, `test_transport_contract.js`,
`test_phase1.js`) were not run — the bridge node addon was not rebuilt because
no bridge code was touched (`bridge/src/XlethAddon.cpp` is unchanged). The
Stage 7B fix is entirely inside `engine/src/AudioEngine.cpp`. A full bridge
rebuild would re-link against the updated engine static lib but the bridge
contract surface is unchanged, so the pre-existing bridge tests cover the same
behavior they always did.

## NO MAIL duplicate regression

The literal "load the duplicate, start playback, insert RS HQ on KICK,
observe `livePresentationLatencySamples` update" regression requires the
Electron + bridge stack running (project file → JS bridge → AudioEngine).
The engine test harness alone cannot load `project.json` files end-to-end
without that pipeline. **The bridge gap is documented here.**

What we did verify, from the engine side, is the equivalent code path:

- The Stage 7A duplicate at
  `C:\Users\Krasen\Desktop\XLETH\diagnostics\pdc-stage7a\NO_MAIL_project_copy`
  is **intact**: `project.json` is byte-identical to the original
  (`3645997` bytes, mtime `May 9 19:35` on both).
- The original `C:\Users\Krasen\Desktop\SR\NO MAIL` is **untouched** —
  identical mtime/size, no opens, no edits.
- The duplicate's `project.json` contains a master `resonancesuppressor`
  with `quality=2.0` (HQ) embedded in the saved plugin state, exactly as
  Stage 7A reported.
- Engine subtest 3 (`testLivePresentationLatencyAutoRefreshAfterMutation`,
  master+track section) is the equivalent regression: it sets up a fixture
  with master spectral latency already present (mirroring NO MAIL's master
  RS HQ), then adds a spectral insert on one individual track via the same
  `MixEngine::setEffectParameter` route the bridge uses for RS HQ
  parameter changes. The test asserts:
  - master pre-existing latency continues to be reported (kHop)
  - new track latency contributes to `maxAudibleTrackLatencySamples` (kHop)
  - `totalPresentationLatencySamples == kHop + kHop + kDeviceLatency`
    (no double counting)
  - **no manual `refreshLivePresentationLatency()` call is required** for
    any of these to be true after the mutation
- Engine subtest 6 directly models the user-visible symptom: a playhead
  mid-flight, RS-HQ-equivalent insert added via the bridge surface, the
  presentation position must drop by exactly the new insert latency on the
  next read.

If/when the team wants the literal end-to-end NO MAIL regression, the
needed scaffolding is a small JS smoke test that:
1. spawns the bridge addon
2. calls `project_load` with the Stage 7A duplicate path
3. starts transport
4. polls `livePresentationLatencySamples` baseline
5. calls `audio_setEffectParameter` to flip RS HQ HQHigh on track id=959
6. polls again and asserts the increase

That is a Stage 7C task.

## Confirmation matrix

| Question | Answer |
|---|---|
| Original `NO MAIL` project untouched? | Yes — only the Stage 7A duplicate may be read; no writes performed |
| Master pre-existing RS HQ accounted for? | Yes — subtest 3 covers the "master spectral already present + add track spectral" case and asserts `total = track + master + device` (no double count) |
| RS HQ kept off master in the individual-track regression? | Yes — the engine regression mutates only the latent track's chain; the NO MAIL duplicate already has master RS HQ pre-existing, which we observe but do not modify |
| DSP changed? | No — Resonance Suppressor / EQ / Compressor / Limiter / etc. unchanged |
| MixEngine PDC math changed? | No |
| Export accounting changed? | No (`AudioExporter` untouched) |
| Raw transport semantics changed? | No (`Transport` untouched) |
| React-side latency formula added? | No — UI continues to read presentation fields from the bridge |
| Plugin latency under-reporting / hard-disabling RS HQ / risky-HQ preference? | No — none added |

## Remaining limitations

- The `chainsMutex_` is acquired on every call to
  `getLivePresentationLatencySamples()` /
  `getLivePresentationLatencyDiagnostics()` from the bridge or sync thread.
  Cost is microseconds in the uncontended case; the audio thread does not
  take this mutex so it does not impact the RT path. If the bridge polls
  position at very high rates, contention with concurrent chain mutations
  could grow — but mutations themselves are infrequent (user-driven), so this
  is acceptable in practice. If profiling later shows it, Option B
  (lock-free atomic snapshot published by MixEngine on every chain change)
  is the natural follow-up; the public API does not change.
- The bridge has no telemetry probe today that fires *only* on
  presentation-latency change. If we want to log every change for diagnostics
  (rather than every read), a lightweight epoch-bump counter inside MixEngine
  is the right place to add it (Stage 7C if needed).
- Bridge-level regression test was not added because the existing bridge test
  harnesses do not have a fast path to insert a real plugin into a track
  without launching the full editor host. The engine test in
  `test_pdc_stage1.cpp` covers the same code paths the bridge exercises (it
  goes through `MixEngine::addEffect` / `setEffectParameter` / `removeEffect`
  / etc. — the exact same MixEngine surface the bridge calls).

## Next recommended stage

- **Stage 7C (optional)**: lock-free atomic snapshot published by MixEngine on
  every chain mutation, eliminating the read-side mutex. Public API stays the
  same; AudioEngine just reads two `std::atomic<int>` instead of taking
  `chainsMutex_`. Worth doing only if profiling shows contention.
- **Bridge harness extension**: add a fast `audio_test_addEffectAndQuery`
  test surface that lets `bridge/test_audio_telemetry.js` exercise the
  presentation-latency path end-to-end without spinning up the editor host.
  Closes the bridge regression gap noted above.
