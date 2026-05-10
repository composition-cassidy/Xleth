# Stage 8A PDC Audible Export Diagnostic

## Checkout
- Branch: `stage8a-pdc-audible-export-diagnostic`
- HEAD: `5625d71 Fix build script RC variable collision`
- Status: `M engine/CMakeLists.txt
 M engine/src/export/AudioExporter.cpp
 M engine/src/export/AudioExporter.h
?? diagnostics/pdc-stage8a/
?? docs/diagnostics/pdc-audible-export-stage8a.md
?? engine/tools/xleth_pdc_audible_diagnostic.cpp`

## Project Safety
- Original project: `C:\Users\Krasen\Desktop\SR\NO MAIL`
- Scratch project: `C:\Users\Krasen\Desktop\XLETH\diagnostics\pdc-stage8a\NO_MAIL_stage8a_copy`
- Original project.json SHA-256 before: `EFC0D5D6AEDA2D34C8D423316338BD3B603DF52C9C15DFE449E583EE395E731F`
- Original project.json SHA-256 after: `EFC0D5D6AEDA2D34C8D423316338BD3B603DF52C9C15DFE449E583EE395E731F`
- Original untouched: yes

## MAIN CHROUS
- Track id/type: `197` / `Clip`
- Participates in PDC: yes
- Declared latency after RS HQ: 2192 samples
- Contributes to max audible track latency: yes

## MAIN CHROUS Chain
| Pos | Node | Effect | Bypassed | Reported latency | RS details |
| ---: | ---: | --- | --- | ---: | --- |
| 0 | 4 | smartbalance / Smart Balance | no | 0 |  |
| 1 | 7 | resonancesuppressor / Resonance Suppressor | no | 2048 | quality=2, processing_mode=1, mode=1, fft=2048, hop=512, expected=2048 |
| 2 | 3 | xletheq / Xleth EQ | no | 0 |  |
| 3 | 5 | compressor / Compressor | no | 144 |  |
| 4 | 6 | reverb / Reverb | no | 0 |  |

## Mutation And Recompute
- Route: `MixEngine::setEffectBypass/setEffectParameter on existing track insert`
- Existing MAIN CHROUS RS node reused: yes
- Bypass false / HQ processing / High quality set: yes / yes / yes
- MAIN CHROUS declared latency before/after mutation: 2192 -> 2192 samples
- Recomputed maxAudibleTrackLatency before/after mutation: 2192 -> 2192 samples

## Latency Summary
| Snapshot | maxAudibleTrackLatency | masterInsertLatency | live track+master | export total preroll | export discard |
| --- | ---: | ---: | ---: | ---: | ---: |
| before RS HQ mutation | 2192 | 2416 | 4608 | 4608 | 4608 |
| after RS HQ mutation | 2192 | 2416 | 4608 | 4608 | 4608 |

## Key Track Compensation
| Track | id | type | before latency | before delay | after latency | after delay | expected after delay | ok |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| MAIN CHROUS | 197 | Clip | 2192 | 0 | 2192 | 0 | 0 | yes |
| AUTO 1 | 406 | Clip | 0 | 2192 | 0 | 2192 | 2192 | yes |
| AUTO 2' | 432 | Clip | 0 | 2192 | 0 | 2192 | 2192 | yes |
| FREESTYLE | 804 | Clip | 76 | 2116 | 76 | 2116 | 2116 | yes |
| KICK | 959 | Clip | 0 | 2192 | 0 | 2192 | 2192 | yes |
| SNARE | 1048 | Clip | 0 | 2192 | 0 | 2192 | 2192 | yes |
| CH | 1075 | Clip | 61 | 2131 | 61 | 2131 | 2131 | yes |
| OH | 1077 | Clip | 61 | 2131 | 61 | 2131 | 2131 | yes |
| ARP 1 | 2077 | Pattern | 0 | 2192 | 0 | 2192 | 2192 | yes |
| PAD | 2119 | Pattern | 0 | 2192 | 0 | 2192 | 2192 | yes |
| MELODY | 2124 | Pattern | 0 | 2192 | 0 | 2192 | 2192 | yes |

## Export Audit
- Formula exposed by AudioExporter: `availablePreroll + maxAudibleTrackLatencySamples + masterInsertLatencySamples`
- Export/live track+master formula match: yes
- Master latency counted once: yes

## Signal Tests
- RS HQ declared latency: 2048 samples
- RS HQ measured impulse delay: 2048 samples
- Declared latency matches observed signal delay: yes
- Synthetic impulse PDC pass: yes

## Classification
- Root cause classification: F. Inconclusive, with exact missing data
- Stage 8B needed: yes
- Recommended Stage 8B plan: No PDC accounting/export formula defect reproduced by Stage 8A. Stage 8B should instrument the real render/live buffer path at the moment the user hears offset: capture per-track post-PDC stem peaks from the scratch project, include missing VST resolution state, and compare UI-configured RS HQ node state against the loaded engine state.

## Missing Data
- No direct per-track post-PDC stem tap exists in MixEngine, so the real project signal-alignment test uses accounting plus a synthetic impulse PDC render.
- The diagnostic does not save the scratch project after mutation; it mutates the loaded MixEngine chain in memory only.
- If a third-party VST is missing on this machine, its real latency cannot be observed by this stock-effect diagnostic run.
