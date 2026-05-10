# Audio Performance: Resonance Suppressor HQ Guardrails Stage 6C

## Evidence summary

Stage 5E showed that Resonance Suppressor High Quality realtime failures are CPU deadline failures, not plugin delay compensation, lock contention, or stale-state failures. PDC/export/live presentation latency had already been implemented and covered separately.

Stage 6A removed obvious WOLA CPU waste. Stage 6B added detector prefix-sum optimization and improved single-instance RS HQ at 64, 128, and 256 samples. The Stage 6B result left single-track RS HQ healthy at 512, warning-level at 256, and still risky at smaller buffers. Multi-track RS HQ improved at 512 but continued to overrun, so multi-instance realtime use cannot be presented as safe.

## Runtime policy

Stage 6C adds warning-level guardrails. It does not disable, downgrade, or silently change RS HQ processing.

- Offline/export: always allowed. Diagnostics report `exportOfflineSafe` and recommend `useHqForExport`.
- Single RS HQ instance:
  - block size 512 or above: `healthy` unless telemetry shows deadline trouble.
  - block size 256: `warning`.
  - block size 128 or below: `warning`.
- Multiple RS HQ instances: `warning` at every realtime block size. At large buffers this remains a warning because Stage 6B showed multiple HQ instances may overrun even at 512.
- Telemetry overrun: escalates to `overrunning` when callback/mix overrun counters or callback/mix p99/max indicate deadline violation.
- WOLA near deadline: adds `wolaNearDeadline` and keeps/escalates to `warning` when RS HQ WOLA timing consumes a conservative share of the callback deadline.

## Why this is not PDC

The guardrail uses sample rate, block size, active HQ instance count, realtime/offline mode, callback/mix telemetry, and WOLA section timing. It does not alter latency publication, PDC graph math, presentation timing, transport position, export preroll, or discard formulas. RS HQ latency remains reported and compensated by the existing engine-owned latency/PDC paths.

## Why HQ remains valid

RS HQ is still appropriate for export/offline rendering and for high-buffer or single-instance realtime contexts when telemetry is healthy. The warning copy is deliberately about realtime CPU cost, not correctness or compensation.

## Added diagnostics fields

The engine and bridge now expose the following through audio performance telemetry:

- `activeResonanceSuppressorHighQualityInstanceCount`
- `realtimeRsHqRiskLevel`: `healthy`, `warning`, or `overrunning`
- `realtimeRsHqRiskReasons`: `smallBlockSize`, `multipleInstances`, `telemetryOverrun`, `wolaNearDeadline`, `exportOfflineSafe`
- `recommendedAction`: `increaseBufferSize`, `reduceHqInstances`, `useNormalQualityForRealtime`, `useHqForExport`, `optimizationNeeded`

The same values are also mirrored inside `resonanceSuppressorHighQuality` as `activeInstanceCount`, `riskLevel`, `riskReasons`, and `recommendedAction`.

## UI

Settings -> Audio Diagnostics includes an "RS HQ Realtime Risk" card with active HQ count, risk level, reasons, and recommended action. The Resonance Suppressor panel shows a compact inline warning when telemetry reports `warning` or `overrunning`. Neither UI path blocks playback or changes parameter values.

## Known limitation

Debug timings are not final product budgets. This policy is conservative and telemetry-aware: it warns early based on Stage 5E/6A/6B evidence, then escalates when live telemetry shows actual deadline overruns.
