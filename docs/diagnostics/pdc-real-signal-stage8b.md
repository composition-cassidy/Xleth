# Stage 8B Real-Signal PDC Tap Diagnostic

## Checkout
- Branch: `stage8b-real-signal-pdc-tap-diagnostic`
- HEAD: `236efb2 Stage 8A: diagnose audible PDC export alignment`
- Status: `M engine/CMakeLists.txt
 M engine/src/audio/MixEngine.cpp
 M engine/src/audio/MixEngine.h
?? diagnostics/pdc-stage8b/
?? docs/diagnostics/pdc-real-signal-stage8b.md
?? engine/tools/xleth_pdc_real_signal_tap.cpp`

## Project Safety
- Original project: `C:\Users\Krasen\Desktop\SR\NO MAIL`
- Scratch project: `C:\Users\Krasen\Desktop\XLETH\diagnostics\pdc-stage8b\NO_MAIL_stage8b_copy`
- Scratch source: `C:\Users\Krasen\Desktop\SR\NO MAIL`
- Original project.json SHA-256 before: `EFC0D5D6AEDA2D34C8D423316338BD3B603DF52C9C15DFE449E583EE395E731F`
- Original project.json SHA-256 after: `EFC0D5D6AEDA2D34C8D423316338BD3B603DF52C9C15DFE449E583EE395E731F`
- Original untouched: yes

## Stage 8A Summary
- MAIN CHROUS id/type: `197 / Clip`
- MAIN CHROUS chain latency: `2192` samples
- RS HQ latency: `2048` samples; compressor latency: `144` samples
- maxAudibleTrackLatency before/after: `2192 / 2192`
- masterInsertLatency: `2416`; live track+master latency: `4608`
- export preroll/discard: `4608 / 4608`
- synthetic impulse PDC and affected-track compensation checks passed

## Target Tracks
| Requested | Found | id | Actual | Type |
| --- | --- | ---: | --- | --- |
| MAIN CHROUS | yes | 197 | MAIN CHROUS | Clip |
| AUTO 1 | yes | 406 | AUTO 1 | Clip |
| AUTO 2 | yes | 432 | AUTO 2' | Clip |
| FREESTYLE | yes | 804 | FREESTYLE | Clip |
| KICK | yes | 959 | KICK | Clip |
| SNARE | yes | 1048 | SNARE | Clip |
| CH | yes | 1075 | CH | Clip |
| OH | yes | 1077 | OH | Clip |
| ARP 1 | yes | 2077 | ARP 1 | Pattern |
| PAD | yes | 2119 | PAD | Pattern |
| MELODY | yes | 2124 | MELODY | Pattern |

## Capture Window
- Start sample: `2064000`
- End sample: `2304000`
- Start seconds: `43`
- Duration seconds: `5`
- Selection: automatic
- Reason: highest-scoring window with MAIN CHROUS and drum/reference energy

## Latency Accounting
| Track | id | declared | compensation | expected | ok |
| --- | ---: | ---: | ---: | ---: | --- |
| MAIN CHROUS | 197 | 2192 | 0 | 0 | yes |
| AUTO 1 | 406 | 0 | 2192 | 2192 | yes |
| AUTO 2' | 432 | 0 | 2192 | 2192 | yes |
| FREESTYLE | 804 | 76 | 2116 | 2116 | yes |
| KICK | 959 | 0 | 2192 | 2192 | yes |
| SNARE | 1048 | 0 | 2192 | 2192 | yes |
| CH | 1075 | 61 | 2131 | 2131 | yes |
| OH | 1077 | 61 | 2131 | 2131 | yes |
| ARP 1 | 2077 | 0 | 2192 | 2192 | yes |
| PAD | 2119 | 0 | 2192 | 2192 | yes |
| MELODY | 2124 | 0 | 2192 | 2192 | yes |

## Alignment
| Track | expected pre->post | observed pre->post | corr | PDC observed | post vs MAIN | live vs export |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| MAIN CHROUS | 0 | 0 | 1.000000 | yes | 0 | 0 |
| AUTO 1 | 2192 | 0 | 1.000000 | no | 23520 | 0 |
| AUTO 2' | 2192 | 0 | 1.000000 | no | -22416 | 0 |
| FREESTYLE | 0 |  |  | no |  |  |
| KICK | 2192 | 2192 | 1.000000 | yes | 21680 | 0 |
| SNARE | 2192 | 0 | 1.000000 | no | 23040 | 0 |
| CH | 2131 | 2128 | 0.988327 | yes | -20432 | 0 |
| OH | 2131 | 0 | 1.000000 | no | -12224 | 0 |
| ARP 1 | 2192 | 2192 | 1.000000 | yes | 20288 | 0 |
| PAD | 2192 | 2192 | 1.000000 | yes | -32 | 0 |
| MELODY | 2192 | 2192 | 1.000000 | yes | 23872 | 0 |

## Missing Plugins Or Placeholder State
| Track | Node | Plugin | Missing | Crashed | Reported latency |
| --- | ---: | --- | --- | --- | ---: |
| ARP 1 | 4 | VST3-UniFlange-e566882c-ad82305 | yes | no |  |
| MELODY | 3 | VST3-UniFlange-e566882c-ad82305 | yes | no |  |

## Direct Answers
- MAIN CHROUS real buffers are max-latency track buffers: yes
- Affected tracks delayed by expected samples in real buffers: no
- Live-style and export/offline captures have same post-PDC alignment: same for comparable captures; 1 selected track(s) missing/inconclusive
- Source-reader stale/silent/short flags: not exposed by current SampleBank/MixEngine APIs; silence/shortness is inferred from tap stats and media-load rows.

## Classification
- Root cause classification: A. PDC delay not applied to real buffers
- Secondary signals:
  - D. Plugin placeholder/state latency mismatch: Missing or placeholder plugins are present on selected tracks and can still affect timing/state, but they did not outrank the observed pre/post PDC mismatch.
- Stage 8C needed: yes
- Recommended Stage 8C fix plan: Stage 8C should fix MixEngine's real track-buffer compensation path so a track compensation delay reset cannot leave the delay line at 0 while cached compensation still says a nonzero delay is active. Reapply the target delay after reset or force retarget when audio resumes, then add a regression that taps pre/post PDC on real project material and verifies observed lag equals compensation delay.
