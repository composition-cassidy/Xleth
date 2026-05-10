# Stage 8C Real-Buffer PDC Fix

## Checkout
- Branch: `stage8c-fix-real-buffer-pdc-delay-retarget`
- Base HEAD before Stage 8C commit: `e516457 Stage 8B: tap real signal PDC alignment`
- Working status while report was written: modified Stage 8C code/report files plus `diagnostics/pdc-stage8c/`

## Root Cause
- `MixEngine::StereoCompensationDelay::reset()` cleared `currentDelaySamples_`, `sourceDelaySamples_`, and `targetDelaySamples_` to `0`.
- The process-block latency recompute only called `setTargetDelaySamples()` when `cachedTrackCompensationSamples_[slot]` changed.
- After a silent/inactive early-continue reset, the cached accounting could remain nonzero while the real delay line had been reset to zero. When audio resumed with the same expected compensation, the first real buffer bypassed PDC.

## Fix
- Added `StereoCompensationDelay::resetToDelaySamples(delay)` so clearing delay-line history can preserve the configured compensation delay.
- Added `MixEngine::syncTrackCompensationDelayState(slot, compensation, clearHistory)` as the single sync helper.
- Sync rule after fix:
  - latency recompute always synchronizes the real delay processor to the cached compensation, even when the cached value did not change;
  - reset paths that only clear audio history reinitialize the delay line at the current expected compensation;
  - before any audible or tailing track buffer is processed, MixEngine reasserts the current compensation target.
- Audited paths: `prepare()`, `resetLatencyCompensationState()`, pending seek/stop latency reset, latency recompute, muted track early-continue, silent/inactive early-continue, tailing effects, live `processBlock`, and offline/export `processBlock`.

## Before/After Real-Signal Tap
Capture window: `2064000..2304000` samples. Scratch project: `diagnostics/pdc-stage8c/NO_MAIL_stage8c_copy`.

| Track | Expected | Stage 8B observed | Stage 8C observed | Result |
| --- | ---: | ---: | ---: | --- |
| MAIN CHROUS | 0 | 0 | 0 | unchanged |
| AUTO 1 | 2192 | 0 | 2192 | fixed |
| AUTO 2 | 2192 | 0 | 2192 | fixed |
| SNARE | 2192 | 0 | 2192 | fixed |
| OH | 2131 | 0 | 2128 | fixed, within transient tolerance |
| KICK | 2192 | 2192 | 2192 | preserved |
| CH | 2131 | 2128 | 2128 | preserved |
| ARP 1 | 2192 | 2192 | 2192 | preserved |
| PAD | 2192 | 2192 | 2192 | preserved |
| MELODY | 2192 | 2192 | 2192 | preserved |

Stage 8C checks:
- Affected tracks delayed by expected samples in real buffers: yes.
- Live-style and export/offline post-PDC captures: same for comparable captures; `FREESTYLE` remained missing/inconclusive.
- `maxAudibleTrackLatency`: `2192`.
- `masterInsertLatency`: `2416`.
- Capture-window preroll remained `4608`; capture discard remained `9216`, matching Stage 8B for this window.

## Project Safety
- Original project: `C:\Users\Krasen\Desktop\SR\NO MAIL`
- Scratch project: `C:\Users\Krasen\Desktop\XLETH\diagnostics\pdc-stage8c\NO_MAIL_stage8c_copy`
- Original `project.json` SHA-256 before/after: `EFC0D5D6AEDA2D34C8D423316338BD3B603DF52C9C15DFE449E583EE395E731F`
- Original untouched: yes.

## Validation
- `.\build.bat all-clean`: pass.
- `test_pdc_stage1`: pass.
- `test_mix`: pass, including new `[PDC 2b] Silence-gap resume keeps real delay targets`.
- `test_audio_telemetry`: pass.
- `test_offline_render`: pass.
- `test_muxer`: pass.
- `xleth_pdc_audible_diagnostic`: pass; accounting/export checks true, classification remained diagnostic/inconclusive for missing data.
- `xleth_pdc_real_signal_tap --stage8c --start-sample 2064000 --capture-seconds 5`: pass.
- `git diff --check`: pass.

## Limitations
- Missing UniFlange placeholder state remains reported on ARP 1 and MELODY, but it no longer outranks or explains the fixed pre/post PDC rows.
- `FREESTYLE` remained missing/inconclusive in the selected tap window.
- Manual app retest is still useful because the fix targets the engine path and should be verified through the UI transport/export workflow.

## Closeout
This should close the generic audible live/export PDC bug for real track buffers where silence, inactive blocks, reset/resume, or export/offline transitions left the real delay line at zero while cached PDC accounting stayed nonzero.
