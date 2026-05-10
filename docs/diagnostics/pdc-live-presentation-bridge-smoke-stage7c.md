# PDC Stage 7C - Bridge Live Presentation Smoke

## Branch / HEAD

| Field | Value |
|---|---|
| Worktree | `C:\Users\Krasen\Desktop\XLETH-stage7b` |
| Branch | `stage7b-live-presentation-fix` |
| Stage 7B commit | `15181e5edf5820e964f3a83fab1848eb88bf3334` |
| Stage 7B subject | `Stage 7B: live presentation latency reads MixEngine on demand` |
| Stage 7C smoke test | `bridge/test_pdc_live_presentation_refresh.js` |

## Project Safety

| Field | Value |
|---|---|
| Source duplicate | `C:\Users\Krasen\Desktop\XLETH\diagnostics\pdc-stage7a\NO_MAIL_project_copy` |
| Stage 7C scratch copy | `C:\Users\Krasen\Desktop\XLETH-stage7b\diagnostics\pdc-stage7c\NO_MAIL_bridge_smoke_copy` |
| Original project | `C:\Users\Krasen\Desktop\SR\NO MAIL` |
| Original untouched proof | Directory stat unchanged before/after: `mtime=2026-05-09T16:34:33.507Z`, `size=0` |
| Source duplicate proof | `project.json` stat unchanged before/after: `size=3645997`, `mtime=2026-05-09T16:35:50.694Z` |
| Scratch cleanup | Scratch copy is deleted after successful smoke run unless `XLETH_KEEP_STAGE7C_SCRATCH=1` |

The test never calls `project_save`, never writes to the Stage 7A source duplicate, and never touches `C:\Users\Krasen\Desktop\SR\NO MAIL`.

## Smoke Scenario

Selected individual track:

| Field | Value |
|---|---|
| Track id | `959` |
| Track name | `KICK` |
| Track type | `Clip` |
| Pre-existing KICK RS count | `0` |

Master chain before mutation:

| Field | Value |
|---|---|
| Master node count | `4` |
| Master Resonance Suppressor count | `1` |
| Master RS HQ count | `1` |
| Master RS params | `processing_mode=1`, `quality=2`, `bypassed=false` |

Mutation:
- Loaded only the Stage 7C scratch project.
- Simulated live transport with `transport_seek(64.0)` before mutation.
- Added `resonancesuppressor` to KICK only with `audio_addEffect(959, "resonancesuppressor", 3)`.
- Configured KICK RS HQ through production bridge calls:
  - `audio_setEffectParameter(959, nodeId, "processing_mode", 1.0)`
  - `audio_setEffectParameter(959, nodeId, "quality", 2.0)`
- Did not call stop/play/seek after mutation.
- Did not call `refreshLivePresentationLatency` from JS.

## Latency Results

Telemetry fields:

| Field | Baseline | Post-mutation |
|---|---:|---:|
| `rawPositionSamples` | `1298028` | `1298028` |
| `presentationPositionSamples` | `1294896` | `1293084` |
| `livePresentationLatencySamples` | `3132` | `4944` |
| `maxAudibleTrackLatencySamples` | `236` | `2048` |
| `masterInsertLatencySamples` | `2416` | `2416` |
| `audioDeviceOutputLatencySamples` | `480` | `480` |
| `activeResonanceSuppressorHighQualityInstanceCount` | `1` | `2` |

Assertion summary:
- `livePresentationLatencySamples` increased immediately: `3132 -> 4944`.
- KICK RS HQ contributed to max track latency: `236 -> 2048`.
- Master latency stayed counted once: `2416 -> 2416`.
- Raw transport position stayed raw and did not jump: `1298028 -> 1298028`.
- Presentation position matched `raw - liveLatency`: `1298028 - 4944 = 1293084`.
- Active RS HQ count increased: `1 -> 2`.
- Master node count stayed unchanged: `4 -> 4`.
- Master RS count stayed unchanged: `1 -> 1`.
- KICK RS count increased exactly once: `0 -> 1`.

## Bridge Limitations

- The requested `cmd /c "set PATH=...\debug\bin;C:\Windows\System32;C:\Windows& node ..."` form removes `node.exe` from PATH on this machine. Validation used the same DLL path plus `C:\Program Files\nodejs`.
- `bridge/test_phase1.js` hardcodes `bridge/build/Release/xleth_native.node`, so a Release `xleth_native` target was built in addition to the requested Debug build to run that legacy test unchanged.
- Starting full playback on the loaded NO MAIL scratch project crashed before the mutation during setup. The final smoke uses the plan-approved simulated live transport path: nonzero raw transport position from `transport_seek(64.0)`, then bridge mutation and immediate telemetry/transport reads without any post-mutation stop/play/seek.

## Validation

| Command / Target | Result |
|---|---|
| Stage 7B prerequisite commit | Passed: `15181e5edf5820e964f3a83fab1848eb88bf3334` |
| `cmake --build bridge\build --config Debug` | Passed |
| `node bridge\test_pdc_live_presentation_refresh.js` | Passed: `53/53` |
| `node bridge\test_audio_telemetry.js` | Passed: `515/515` |
| `node bridge\test_transport_contract.js` | Passed: `54/54` |
| `node bridge\test_phase1.js` | Passed: `80/80` |
| `cmake --build build --target test_pdc_stage1 --config Debug` | Passed |
| `build\engine\Debug\test_pdc_stage1.exe` | Passed: `584 passed, 0 failed` |

## Conclusion

Stage 7C closes the remaining bridge smoke gap for the live sync bug: through the real bridge effect-add and parameter paths, an individual-track RS HQ mutation updates `livePresentationLatencySamples` and presentation position immediately, without any stop/play/seek after mutation and without adding anything to master. The original NO MAIL project remained untouched.
