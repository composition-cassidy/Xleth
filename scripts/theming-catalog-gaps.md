# Catalog Gap Report (v2)

Generated: 2026-04-20 (Step 6 — regenerated from v2 classifier)
Source: `scripts/theming-audit-enriched-v2.json` (584 match entries)

## Summary

- NO-FIT matches: **238** across **198** distinct
  (subsystem, role, value) groups.
- Singleton groups: **161** (one match site each)
- Catalog deltas from Step 2 (drift fixes, renames, new tokens, retirements)
  are preserved from the prior revision of this file — see "Catalog deltas
  (Step 2)" section below.

Per rule: false-positive matches are NOT listed here — they are audit errors,
not catalog gaps. Their preservation is asserted by integrity check 6.

---

## NO-FIT distribution by subsystem

| Subsystem | NO-FIT count |
|---|---:|
| timeline | 42 |
| sampler | 37 |
| stock-effects.dynamics | 36 |
| grid-editor | 20 |
| piano-roll | 16 |
| pattern-list | 15 |
| dialogs-modals | 11 |
| panel-chrome | 9 |
| mixer | 7 |
| stock-effects.eq | 7 |
| syllable-splitter | 5 |
| lip-sync-picker | 5 |
| node-editor | 5 |
| sample-selector | 4 |
| stock-effects.modulation | 3 |
| stock-effects.time | 3 |
| preview-player | 3 |
| project-media | 3 |
| stock-effects.distortion | 3 |
| context-menus | 2 |
| stock-effects.shared | 2 |

---

## Gaps by (subsystem, role, value)

Each row below is a unique (subsystem, inferredRole, matchedText) group.
**Classification**: (a) new token, (b) drift I missed, (c) truly unreachable.

### timeline (42 NO-FIT across 33 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 2 | bg | `#1a1a2e` | (a) new token — review value + role and propose a name | ui/src/components/timeline/TimelineToolbar.jsx:150 |
| 2 | bg | `rgba(255,255,255,0.10)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:610 |
| 2 | bg | `rgba(255,71,87,0.12)` | (a) new token — danger alpha; propose --theme-semantic-danger-bg variant | ui/src/styles/app.css:1002 |
| 2 | border | `#333` | (a) new token — review value + role and propose a name | ui/src/components/timeline/TimelineToolbar.jsx:150 |
| 2 | border | `#555` | (a) new token — review value + role and propose a name | ui/src/components/timeline/FadeBezierEditor.jsx:196 |
| 2 | canvas-fill | `#000` | (c) truly unreachable — near-black decorative; see G5 | ui/src/components/timeline/timelineDrawing.js:496 |
| 2 | canvas-stroke | `rgba(255,255,255,0.12)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/components/timeline/FadeBezierEditor.jsx:77 |
| 2 | fg | `#888` | (a) new token — review value + role and propose a name | ui/src/components/TimelineView.jsx:51 |
| 2 | fg | `#ddd` | (a) new token — review value + role and propose a name | ui/src/components/timeline/TimelineToolbar.jsx:150 |
| 1 | bg | `#333` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/timeline/FadeBezierEditor.jsx:195 |
| 1 | bg | `linear-gradient(` | (a) new token — gradient; product-domain name needed | ui/src/components/timeline/TrackHeader.jsx:60 |
| 1 | bg | `rgba(0,0,0,0.25)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:2280 |
| 1 | bg | `rgba(255,255,255,0.25)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:2289 |
| 1 | bg | `rgba(255,255,255,0.4)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:2295 |
| 1 | bg | `rgba(255,255,255,0.5)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:2299 |
| 1 | bg | `rgba(255,71,87,0.15)` | (a) new token — danger alpha; propose --theme-semantic-danger-bg variant | ui/src/styles/app.css:2606 |
| 1 | bg | `rgba(51,206,214,0.9)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/styles/app.css:1613 |
| 1 | border | `rgba(255,255,255,0.15)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:611 |
| 1 | canvas-fill | `#1a1a1a` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/timeline/FadeBezierEditor.jsx:70 |
| 1 | canvas-fill | `rgba(0, 0, 0, 0.35)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/components/timeline/timelineDrawing.js:441 |
| 1 | canvas-fill | `rgba(0,0,0,0.8)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/components/timeline/timelineDrawing.js:658 |
| 1 | canvas-fill | `rgba(255,107,107,0.10)` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/timeline/timelineDrawing.js:810 |
| 1 | canvas-fill | `rgba(255,255,255,0.9)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/components/timeline/timelineDrawing.js:545 |
| 1 | canvas-fill | `rgba(51, 206, 214, 0.12)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/components/timeline/FadeBezierEditor.jsx:95 |
| 1 | canvas-fill | `rgba(51,206,214,0.08)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/components/timeline/timelineDrawing.js:764 |
| 1 | canvas-stroke | `rgba(255,107,107,0.4)` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/timeline/timelineDrawing.js:812 |
| 1 | canvas-stroke | `rgba(255,255,255,0.08)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/utils/waveformRenderer.js:265 |
| 1 | canvas-stroke | `rgba(51,206,214,0.4)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/components/timeline/timelineDrawing.js:766 |
| 1 | fg | `#000` | (c) truly unreachable — near-black decorative; see G5 | ui/src/styles/app.css:837 |
| 1 | fg | `#aaa` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/TimelineView.jsx:40 |
| 1 | fg | `#ccc` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/timeline/FadeBezierEditor.jsx:195 |
| 1 | lineColor | `rgba(255,255,255,0.45)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/components/timeline/timelineDrawing.js:328 |
| 1 | traceFill | `rgba(255,255,255,0.10)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/components/timeline/timelineDrawing.js:329 |

### sampler (37 NO-FIT across 25 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 3 | bg | `#0a0a10` | (c) truly unreachable — near-black decorative; see G5 | ui/src/components/sampler/LfoSection.jsx:166 |
| 3 | canvas-fill | `#0a0a10` | (c) truly unreachable — near-black decorative; see G5 | ui/src/components/sampler/EnvelopeEditor.jsx:79 |
| 2 | canvas-stroke | `#0a0a10` | (c) truly unreachable — near-black decorative; see G5 | ui/src/components/sampler/EnvelopeEditor.jsx:144 |
| 2 | canvas-stroke | `rgba(255,255,255,0.04)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/components/sampler/EnvelopeEditor.jsx:83 |
| 2 | canvas-stroke | `rgba(255,255,255,0.08)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/components/sampler/LfoWaveformCanvas.jsx:31 |
| 2 | fg | `#0a0a10` | (c) truly unreachable — near-black decorative; see G5 | ui/src/components/sampler/MiniKeyboard.jsx:59 |
| 2 | gradient-stop | `rgba(0,0,0,0.35)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/components/sampler/SamplerWaveform.jsx:142 |
| 2 | gradient-stop | `rgba(0,0,0,0)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/components/sampler/SamplerWaveform.jsx:143 |
| 2 | gradient-stop | `rgba(51,206,214,0.30)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/components/sampler/SamplerWaveform.jsx:160 |
| 2 | gradient-stop | `rgba(51,206,214,0)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/components/sampler/SamplerWaveform.jsx:161 |
| 1 | bg | `#1E4A5C` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/sampler/SamplerPanel.jsx:515 |
| 1 | bg | `#EAEAF0` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/sampler/MiniKeyboard.jsx:58 |
| 1 | bg | `rgba(0,0,0,0.55)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/components/sampler/SamplerPanel.jsx:291 |
| 1 | border | `#4AA8C8` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/sampler/SamplerPanel.jsx:514 |
| 1 | canvas-fill | `rgba(0, 0, 0, 0.45)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/components/sampler/SamplerWaveform.jsx:130 |
| 1 | canvas-fill | `rgba(255,160,60,0.14)` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/sampler/SamplerWaveform.jsx:242 |
| 1 | canvas-fill | `rgba(51, 206, 214, 0.07)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/components/sampler/SamplerWaveform.jsx:135 |
| 1 | canvas-stroke | `rgba(255,160,60,0.55)` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/sampler/SamplerWaveform.jsx:244 |
| 1 | canvas-stroke | `rgba(255,255,255,0.12)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/components/sampler/EnvelopeEditor.jsx:127 |
| 1 | fg | `#333` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/sampler/MiniKeyboard.jsx:59 |
| 1 | fg | `#55556a` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3637 |
| 1 | fg | `#888` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/sampler/MiniKeyboard.jsx:94 |
| 1 | fg | `#9BDBF0` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/sampler/SamplerPanel.jsx:516 |
| 1 | fg | `#C8C8D4` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3613 |
| 1 | shadow | `rgba(0,0,0,0.6)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/components/sampler/SamplerPanel.jsx:308 |

### stock-effects.dynamics (36 NO-FIT across 30 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 2 | bg | `#2ea8a0` | (a) new token — review value + role and propose a name | ui/src/styles/app.css:7062 |
| 2 | bg | `#4ecdc4` | (a) new token — review value + role and propose a name | ui/src/styles/app.css:7062 |
| 2 | bg | `#ff8c00` | (a) new token — review value + role and propose a name | ui/src/styles/app.css:7066 |
| 2 | bg | `linear-gradient(to bottom,#ff6b6b,#ffa94d)` | (a) new token — gradient; product-domain name needed | ui/src/styles/app.css:6040 |
| 2 | canvas-fill | `rgba(255,255,255,0.3)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/components/mixer/SmartBalancePanel.jsx:113 |
| 2 | shadow | `rgba(0,0,0,0.5)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:7088 |
| 1 | bg | `#ff4040` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:7070 |
| 1 | bg | `linear-gradient(to right,#2ea8a0,#4ecdc4)` | (a) new token — gradient; product-domain name needed | ui/src/styles/app.css:7277 |
| 1 | bg | `linear-gradient(to right,#ff8c00,#ffa94d)` | (a) new token — gradient; product-domain name needed | ui/src/styles/app.css:7281 |
| 1 | bg | `linear-gradient(to top,#2ea8a0,#4ecdc4)` | (a) new token — gradient; product-domain name needed | ui/src/styles/app.css:7062 |
| 1 | bg | `linear-gradient(to top,#ff4040,#ff6b6b)` | (a) new token — gradient; product-domain name needed | ui/src/styles/app.css:7070 |
| 1 | bg | `linear-gradient(to top,#ff8c00,#ffa94d)` | (a) new token — gradient; product-domain name needed | ui/src/styles/app.css:7066 |
| 1 | bg | `rgba(255,255,255,0.02)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:7149 |
| 1 | bg | `rgba(255,255,255,0.04)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:7045 |
| 1 | bg | `rgba(255,255,255,0.06)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:7263 |
| 1 | bg | `rgba(255,255,255,0.08)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:7117 |
| 1 | bg | `rgba(255,255,255,0.1)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:7142 |
| 1 | bg | `rgba(255,255,255,0.2)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:7272 |
| 1 | border | `rgba(255,255,255,0.06)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:7163 |
| 1 | border | `rgba(255,255,255,0.1)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:7137 |
| 1 | border | `rgba(255,255,255,0.12)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:7110 |
| 1 | border | `rgba(255,255,255,0.2)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:7142 |
| 1 | border | `rgba(255,255,255,0.25)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:7116 |
| 1 | canvas-fill | `#6BCB77` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/mixer/SmartBalancePanel.jsx:201 |
| 1 | canvas-fill | `rgba(255,255,255,0.12)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/components/mixer/SmartBalancePanel.jsx:236 |
| 1 | canvas-fill | `rgba(255,255,255,0.35)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/components/mixer/SmartBalancePanel.jsx:228 |
| 1 | canvas-fill | `rgba(255,255,255,0.4)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/components/mixer/SmartBalancePanel.jsx:201 |
| 1 | canvas-stroke | `rgba(255,255,255,0.06)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/components/mixer/SmartBalancePanel.jsx:87 |
| 1 | fg | `#4D96FF` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/mixer/SmartBalancePanel.jsx:12 |
| 1 | fg | `#6BCB77` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/mixer/SmartBalancePanel.jsx:11 |

### grid-editor (20 NO-FIT across 20 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 1 | bg | `rgba(0,0,0,0.35)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:2649 |
| 1 | bg | `rgba(0,0,0,0.7)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:2699 |
| 1 | bg | `rgba(0,0,0,0.75)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:2792 |
| 1 | bg | `rgba(220,60,60,0.06)` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3340 |
| 1 | bg | `rgba(255,149,0,0.2)` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3000 |
| 1 | bg | `rgba(40,60,80,0.4)` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3106 |
| 1 | bg | `rgba(51,206,214,0.2)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/styles/app.css:2995 |
| 1 | bg | `rgba(80,40,80,0.4)` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3130 |
| 1 | border | `#3eb350` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3289 |
| 1 | border | `#4287e5` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3290 |
| 1 | border | `#d6c93a` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3288 |
| 1 | border | `#e5862c` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3287 |
| 1 | border | `#ff9500` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:2801 |
| 1 | border | `rgba(255,255,255,0.25)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:2648 |
| 1 | fg | `#ff9500` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3001 |
| 1 | fg | `rgba(255,255,255,0.6)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:2687 |
| 1 | shadow | `rgba(0,0,0,0.6)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:2735 |
| 1 | shadow | `rgba(0,0,0,0.8)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:2679 |
| 1 | unknown | `linear-gradient(to bottom,transparent calc(50% - 0.5px),rgba(255,255,255,0.15) calc(50% - 0.5px) calc(50% + 0.5px),transparent calc(50% + 0.5px))` | (a) new token — gradient; product-domain name needed | ui/src/styles/app.css:2721 |
| 1 | unknown | `linear-gradient(to right,transparent calc(50% - 0.5px),rgba(255,255,255,0.15) calc(50% - 0.5px) calc(50% + 0.5px),transparent calc(50% + 0.5px))` | (a) new token — gradient; product-domain name needed | ui/src/styles/app.css:2720 |

### piano-roll (16 NO-FIT across 16 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 1 | bg | `#08080c` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3862 |
| 1 | bg | `#0c0c12` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3868 |
| 1 | bg | `#14141c` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3748 |
| 1 | bg | `#1f1f2a` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3748 |
| 1 | bg | `#2a2a34` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/pianoRoll/PianoRollKeyboard.jsx:48 |
| 1 | bg | `#3a3a4a` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/pianoRoll/PianoRollKeyboard.jsx:48 |
| 1 | bg | `#4a3a58` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/pianoRoll/PianoRollKeyboard.jsx:47 |
| 1 | bg | `linear-gradient(135deg,transparent 0%,transparent 45%,rgba(255,255,255,0.25) 45%,rgba(255,255,255,0.25) 55%,transparent 55%,transparent 70%,rgba(255,255,255,0.25) 70%,rgba(255,255,255,0.25) 80%,transparent 80%)` | (a) new token — gradient; product-domain name needed | ui/src/styles/app.css:3803 |
| 1 | bg | `linear-gradient(to bottom,#1f1f2a,#14141c)` | (a) new token — gradient; product-domain name needed | ui/src/styles/app.css:3748 |
| 1 | bg | `rgba(255,255,255,0.18)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:3841 |
| 1 | bg | `rgba(255,255,255,0.28)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:3848 |
| 1 | bg | `rgba(255,255,255,0.35)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:3853 |
| 1 | canvas-fill | `rgba(0,0,0,0.4)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/components/pianoRoll/PianoRollCanvas.jsx:106 |
| 1 | fg | `#666` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/pianoRoll/PianoRollKeyboard.jsx:56 |
| 1 | fg | `#888` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/pianoRoll/PianoRollKeyboard.jsx:56 |
| 1 | unknown | `#E64FE6` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/pianoRoll/PianoRollCanvas.jsx:132 |

### pattern-list (15 NO-FIT across 11 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 2 | bg | `#15161d` | (a) new token — review value + role and propose a name | ui/src/styles/app.css:745 |
| 2 | bg | `#1d1f28` | (a) new token — review value + role and propose a name | ui/src/styles/app.css:812 |
| 2 | fg | `#666` | (a) new token — review value + role and propose a name | ui/src/styles/app.css:765 |
| 2 | fg | `#ccc` | (a) new token — review value + role and propose a name | ui/src/styles/app.css:806 |
| 1 | bg | `#0d0e13` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:716 |
| 1 | bg | `#111218` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:709 |
| 1 | bg | `#252833` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:886 |
| 1 | fg | `#888` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:725 |
| 1 | fg | `#999` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:780 |
| 1 | fg | `#aaa` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:753 |
| 1 | fg | `#ddd` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:736 |

### dialogs-modals (11 NO-FIT across 9 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 2 | border | `#5adc86` | (a) new token — review value + role and propose a name | ui/src/styles/app.css:7455 |
| 2 | fg | `#ff9aa2` | (a) new token — review value + role and propose a name | ui/src/styles/app.css:7694 |
| 1 | bg | `#141420` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:4049 |
| 1 | bg | `#d8a23a` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:7686 |
| 1 | bg | `rgba(224,112,112,0.08)` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:7930 |
| 1 | bg | `rgba(224,85,85,0.12)` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:1941 |
| 1 | bg | `rgba(255,71,87,0.12)` | (a) new token — danger alpha; propose --theme-semantic-danger-bg variant | ui/src/styles/app.css:4109 |
| 1 | border | `#d8a23a` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:7687 |
| 1 | fg | `#f2d079` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:7688 |

### panel-chrome (9 NO-FIT across 9 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 1 | bg | `#111118` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3732 |
| 1 | bg | `#15151c` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3587 |
| 1 | bg | `rgba(0,0,0,0.55)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:7476 |
| 1 | bg | `rgba(0,0,0,0.6)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:4041 |
| 1 | bg | `rgba(255,255,255,0.02)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:3679 |
| 1 | bg | `rgba(255,71,87,0.18)` | (a) new token — danger alpha; propose --theme-semantic-danger-bg variant | ui/src/styles/app.css:3710 |
| 1 | bg | `rgba(51,206,214,0.08)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/styles/app.css:1574 |
| 1 | border | `#888` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3286 |
| 1 | shadow | `rgba(0,0,0,0.5)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:92 |

### mixer (7 NO-FIT across 6 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 2 | bg | `rgba(51,206,214,0.1)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/styles/app.css:4427 |
| 1 | bg | `#0a0a10` | (c) truly unreachable — near-black decorative; see G5 | ui/src/styles/app.css:4385 |
| 1 | bg | `#c0392b` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:4619 |
| 1 | bg | `rgba(255,170,51,0.15)` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:4276 |
| 1 | bg | `rgba(255,71,87,0.15)` | (a) new token — danger alpha; propose --theme-semantic-danger-bg variant | ui/src/styles/app.css:4271 |
| 1 | bg | `rgba(51,206,214,0.08)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/styles/app.css:4168 |

### stock-effects.eq (7 NO-FIT across 6 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 2 | shadow | `rgba(0,0,0,0.5)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:5019 |
| 1 | bg | `rgba(0,0,0,0.3)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:5530 |
| 1 | bg | `rgba(240,163,208,0.1)` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:5436 |
| 1 | fg | `#fff` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:5558 |
| 1 | shadow | `rgba(0,0,0,0.55)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:5591 |
| 1 | shadow | `rgba(0,0,0,0.6)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:5559 |

### syllable-splitter (5 NO-FIT across 4 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 2 | fg | `#000` | (c) truly unreachable — near-black decorative; see G5 | ui/src/styles/app.css:3503 |
| 1 | bg | `rgba(51,206,214,0.08)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/styles/app.css:3426 |
| 1 | fg | `#ff7070` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:3541 |
| 1 | shadow | `rgba(0,0,0,0.6)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:3523 |

### lip-sync-picker (5 NO-FIT across 5 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 1 | bg | `#3a1e1e` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/SamplePicker/SamplePicker.jsx:498 |
| 1 | canvas-fill | `rgba(255,255,255,0.07)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/components/SamplePicker/WaveformScrubber.jsx:307 |
| 1 | canvas-fill | `rgba(51,206,214,0.45)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/components/SamplePicker/WaveformScrubber.jsx:311 |
| 1 | COLOR | `rgba(51, 206, 214, 0.08)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/components/SamplePicker/WaveformScrubber.jsx:10 |
| 1 | fg | `#ff8a8a` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/SamplePicker/SamplePicker.jsx:497 |

### node-editor (5 NO-FIT across 5 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 1 | bg | `rgba(255,60,60,0.2)` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:5930 |
| 1 | bg | `rgba(255,71,87,0.9)` | (a) new token — danger alpha; propose --theme-semantic-danger-bg variant | ui/src/styles/app.css:5824 |
| 1 | bg | `rgba(51,206,214,0.9)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/styles/app.css:5829 |
| 1 | fg | `#ff4444` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:5931 |
| 1 | shadow | `rgba(0,0,0,0.4)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:5851 |

### sample-selector (4 NO-FIT across 3 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 2 | fg | `#ff8a8a` | (a) new token — review value + role and propose a name | ui/src/components/SampleSelectorTab.jsx:420 |
| 1 | bg | `#3a1e1e` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/SampleSelectorTab.jsx:419 |
| 1 | bg | `black` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:2243 |

### stock-effects.modulation (3 NO-FIT across 1 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 3 | shadow | `rgba(0,0,0,0.5)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:6731 |

### stock-effects.time (3 NO-FIT across 2 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 2 | shadow | `rgba(0,0,0,0.5)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:6527 |
| 1 | fg | `#000` | (c) truly unreachable — near-black decorative; see G5 | ui/src/styles/app.css:6601 |

### preview-player (3 NO-FIT across 3 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 1 | bg | `rgba(73,205,122,0.18)` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:528 |
| 1 | border | `#49cd7a` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:530 |
| 1 | fg | `#49cd7a` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/styles/app.css:529 |

### project-media (3 NO-FIT across 3 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 1 | bg | `rgba(255,255,255,0.04)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:4789 |
| 1 | bg | `rgba(255,255,255,0.06)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/styles/app.css:4728 |
| 1 | bg | `rgba(51,206,214,0.1)` | (a) new token — accent alpha; crossSubsystem candidate (waveform-shared / fx-shared family) | ui/src/styles/app.css:4945 |

### stock-effects.distortion (3 NO-FIT across 3 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 1 | shadow | `rgba(0,0,0,0.5)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:6286 |
| 1 | unknown | `rgba(0,0,0,0.3)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/components/mixer/WaveshaperPanel.jsx:262 |
| 1 | unknown | `rgba(255,255,255,0.1)` | (a) new token — white surface tint; consider adding to fx-surface-tint family | ui/src/components/mixer/WaveshaperPanel.jsx:270 |

### context-menus (2 NO-FIT across 2 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 1 | bg | `rgba(255,71,87,0.12)` | (a) new token — danger alpha; propose --theme-semantic-danger-bg variant | ui/src/styles/app.css:1982 |
| 1 | shadow | `rgba(0,0,0,0.5)` | (a) new token — black overlay/shadow; candidate for shared surface tint | ui/src/styles/app.css:1953 |

### stock-effects.shared (2 NO-FIT across 2 groups)

| × | role | matchedText | classification | example |
|---:|---|---|---|---|
| 1 | bg | `#0a0a10` | (c) truly unreachable — near-black decorative; see G5 | ui/src/components/sampler/Knob.jsx:210 |
| 1 | fg | `#BBBBCC` | (c) truly unreachable — one-off decorative; accept as NO-FIT | ui/src/components/sampler/Knob.jsx:220 |

---

## Catalog deltas (Step 2) — preserved

### Drift fixes (in-place value changes)

- `--theme-sampler-lfo-color-pitch`  `#33CED6` → `#E8A020` (swapped with volume — LfoSection.jsx:5 ground truth)
- `--theme-sampler-lfo-color-volume` `#E8A020` → `#33CED6` (swap pair)
- `--theme-sampler-lfo-bg-pitch`     `#1E3A3C` → `#3C2E1A` (swap pair)
- `--theme-sampler-lfo-bg-volume`    `#3C2E1A` → `#1E3A3C` (swap pair)
- `--theme-sampler-envelope-fill`    `rgba(51,206,214,0.08)` → `var(--theme-waveform-envelope-fill)` (0.35 per SamplerWaveform.jsx:110)

### Renames

- `--theme-sampler-lfo-color-filter` → `--theme-sampler-lfo-color-pan` (value unchanged `#9B59B6`)
- `--theme-sampler-lfo-bg-filter`    → `--theme-sampler-lfo-bg-pan`    (value unchanged `#2A1E3A`)
- `--theme-lipsync-playback-indicator` → `--theme-waveform-envelope-fill` (moved to `waveform-shared` with `crossSubsystem:true`)
- `--theme-lipsync-scroll-thumb`       → `--theme-waveform-rms-body`       (moved to `waveform-shared` with `crossSubsystem:true`)

### New tokens

- Base: `--theme-fg-inverse` = `#ffffff`
- Base: `--theme-bg-inset` = `#0d0d14`
- Text: `--theme-text-on-accent` = `#0d0d14`
- Semantic: `--theme-drag-preview-default` = `#6aa9ff`
- Syllable splitter: `--theme-syllable-splitter-bg` = `#1b1b24`
- Syllable splitter: `--theme-syllable-section-alt` = `rgba(51,206,214,0.06)`
- Stock-effects shared (crossSubsystem): `--theme-fx-surface-tint-subtle` = `rgba(255,255,255,0.05)`
- Waveform-shared (crossSubsystem): `--theme-waveform-envelope-fill` = `rgba(51,206,214,0.35)` (via rename)
- Waveform-shared (crossSubsystem): `--theme-waveform-rms-body` = `rgba(51,206,214,0.55)` (via rename)

### Retirements

- `--theme-sampler-lfo-fill` — ghost token; LfoWaveformCanvas.jsx:65 dynamically computes fill as `color + '18'`.

### Subsystem additions

- `waveform-shared` (§3.4.26) — cross-subsystem waveform primitives.

### Schema additions

- `TokenDef.crossSubsystem?: true` — bypasses Gate 3 subsystem-equality check.

---

## Future cleanup (not beta-blocking)

These are observations surfaced during Step 1/2/5/6 that would tighten the catalog
but do not block the beta. File for a later wave.

### G1 — FX-shared cross-subsystem rgba family

Stock-effects subsystems share `rgba(51,206,214,{0.08,0.12,0.18,0.30})` and
`rgba(255,255,255,{0.03,0.05,0.06,0.10,0.25})` across ~20 tokens. Consolidate
into a richer `stock-effects.shared` subsystem with `crossSubsystem:true` flags.

### G2 — SmartBalancePanel per-data-color tokens

`stock-effects.dynamics.SmartBalancePanel` uses `#6bcb77`, `#2ea8a0`, `#ff8c00`,
`#4ecdc4`, `#4d96ff`, `#FFD93D` as channel / stereo-field data-encoding colors.
Needs product-domain names (which channel? which stereo lobe?) before tokenization.
**Also covers the residual Step 5 failure #04** (`#FFD93D` mapping to label-hihat).

### G3 — One-off low-frequency gaps

161 match groups with x1 occurrence each — mostly local
decorative values. Accept as NO-FIT in v2; revisit per-component during migration cleanup.

### G4 — LFO canvas dynamic-alpha helper

`LfoWaveformCanvas.jsx:65` applies opacity via hex-alpha suffix: `ctx.fillStyle = color + '18'`.
A future `withAlpha(tokenName, alpha)` helper would let the LFO canvas consume
`--theme-sampler-lfo-color-<tab>` + 0.094 opacity through a theme-aware API.

### G5 — LFO canvas `#0a0a10` background

`LfoWaveformCanvas.jsx:27,85` and `EnvelopeEditor.jsx:79,144` hardcode `#0a0a10`
(canvas background + handle stroke). Distinct from `#0d0d14` (`--theme-bg-inset`) and
`#0A0A0F` (`--theme-bg-primary`). A future `--theme-sampler-canvas-bg` would cover it.

### G6 — `--theme-text-on-accent` vs `--theme-text-inverse` convergence candidate

`--theme-text-on-accent` (`#0d0d14`) and `--theme-text-inverse` (resolves to
`#0A0A0F`) serve the same role with near-identical values. A future pass could
repoint the 10 app.css callsites and retire `--theme-text-on-accent`.

### G7 — LFO `-color-filter` / `-bg-filter` orphan history

The renamed tokens (`-filter` → `-pan`) had zero component callsites — they were
defined in `catalog.ts` and appeared only in generated resolve-dumps. Evidence of
catalog-to-component drift; similar audits of orphan tokens in other subsystems
could surface more such drift.

### G8 — Lipsync selection-edge and LFO_COLORS multi-line assignment

Two residual Step 5 failures (#10 lipsync selEdge, #15 LFO_COLORS.vol) share the
same root cause: the value `#33CED6` (the accent) is re-used across multiple
semantically-distinct roles, so the v2 classifier cannot disambiguate without
hint context that the upstream audit doesn't provide. Options:
  - Add `--theme-lipsync-selection-edge` (pure new token).
  - Improve the upstream audit to emit per-line context that includes the
    active property name on multi-color assignment lines (e.g. LFO_COLORS).
  - Or accept these three as known catalog gaps and let manual migration
    decide — they are LOW-frequency, not beta-blocking.

