# Theming Enrichment Review (v2)

Generated: 2026-04-20 (Step 6 — v2 classifier output)
Classifier: v2
Source: `scripts/theming-audit-enriched-v2.json`

## Tier counts

| Tier | Count |
|---|---:|
| HIGH | 185 |
| MEDIUM | 115 |
| LOW | 37 |
| NO-FIT | 238 |
| FALSE-POSITIVE | 9 |
| **Total** | **584** |

## Rule usage

| Rule | Count |
|---|---:|
| `v2-no-fit` | 238 |
| `v2-gate-single-candidate` | 185 |
| `v2-gate-tiebreak-alias-prune` | 53 |
| `v2-gate-tiebreak-hint` | 42 |
| `v2-gate-tiebreak-alphabetical` | 35 |
| `v2-gate-tiebreak-subsystem` | 20 |
| `fp-templated-rgba` | 6 |
| `fp-bare-rgba-helper` | 3 |
| `v2-gate-tiebreak-subsystem-unanchored` | 2 |

## MEDIUM correctness audit (Step 5)

- Sample size: 30 (weighted by subsystem, seeded mulberry32=20260420)
- Verdict: **27/30 = 90.0%** — meets the ≥90% gate
- 3 remaining failures are structural catalog gaps (value collides with a
  semantically-unrelated token). Details under "Known residual catalog gaps".

## LOW entries (37)

LOW entries failed the priority tie-break at the alphabetical fallback (Rule 4)
or were demoted by the subsystem-unanchored guard. Each needs human review to
choose the right token or propose a new one.

### dialogs-modals (3)

- **ui/src/styles/app.css:1839:10** — `#0D0D14` (hex, hint=fg)
  - proposed: `--theme-bg-inset`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:universal
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-bg-inset, --theme-text-on-accent
  - context: `1836: .export-dialog-footer .export-btn-danger { | 1837:   background: var(--danger); | 1838:   border-color: var(--danger); | > 1839:   color: #0D0D14; | 1840: } | 1841: | 1842: .export-dialog-footer .export-btn-danger:`
- **ui/src/styles/app.css:7548:10** — `#0D0D14` (hex, hint=fg)
  - proposed: `--theme-bg-inset`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:universal
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-bg-inset, --theme-text-on-accent
  - context: `7545: .unsaved-dialog-btn.danger { | 7546:   background: var(--danger); | 7547:   border-color: var(--danger); | > 7548:   color: #0D0D14; | 7549: } | 7550: .unsaved-dialog-btn.danger:hover { filter: brightness(1.1); } |`
- **ui/src/styles/app.css:7818:10** — `#0D0D14` (hex, hint=fg)
  - proposed: `--theme-bg-inset`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:universal
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-bg-inset, --theme-text-on-accent
  - context: `7815: .export-progress-actions .export-btn-danger { | 7816:   background: var(--danger); | 7817:   border-color: var(--danger); | > 7818:   color: #0D0D14; | 7819: } | 7820: | 7821: .export-progress-actions .export-btn-d`

### labels (1)

- **ui/src/components/timeline/TrackHeader.jsx:9:36** — `#33CED6` (hex, hint=LABEL_COLORS)
  - proposed: `--theme-border-focus`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:universal
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-border-focus, --theme-info
  - context: `6: | 7: const LABEL_COLORS = [ | 8:   '#FF6B6B', '#FFA94D', '#FFD93D', '#FF6B9D', | >    9:   '#69DB7C', '#748FFC', '#B197FC', '#33CED6', | 10: ] | 11: | 12: export default function TrackHeader({`

### lip-sync-picker (4)

- **ui/src/components/SamplePicker/WaveformScrubber.jsx:11:15** — `#555566` (hex, hint=COLOR)
  - proposed: `--theme-text-placeholder`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:universal
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-text-placeholder, --theme-text-subtle
  - context: `8:   handle:     '#33CED6', | 9:   playhead:   '#33CED6', | 10:   playheadBg: 'rgba(51, 206, 214, 0.08)', | >   11:   text:       '#555566', | 12:   error:      '#555566', | 13: } | 14:`
- **ui/src/components/SamplePicker/WaveformScrubber.jsx:12:15** — `#555566` (hex, hint=COLOR)
  - proposed: `--theme-text-placeholder`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:universal
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-text-placeholder, --theme-text-subtle
  - context: `9:   playhead:   '#33CED6', | 10:   playheadBg: 'rgba(51, 206, 214, 0.08)', | 11:   text:       '#555566', | >   12:   error:      '#555566', | 13: } | 14: | 15: const HANDLE_W   = 2    // handle line width (px)`
- **ui/src/components/SamplePicker/WaveformScrubber.jsx:269:49** — `#33CED6` (hex, hint=null)
  - proposed: `--theme-border-focus`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-border-focus, --theme-info
  - context: `266:       ctx.moveTo(x - 6, drawH); ctx.lineTo(x + 6, drawH); ctx.lineTo(x, drawH - 10) | 267:       ctx.closePath(); ctx.fill() | 268:     } | >  269:     if (inPoint  !== null) drawHandle(inPoint,  '#33CED6') | 270:  `
- **ui/src/components/SamplePicker/WaveformScrubber.jsx:270:49** — `#33CED6` (hex, hint=null)
  - proposed: `--theme-border-focus`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-border-focus, --theme-info
  - context: `267:       ctx.closePath(); ctx.fill() | 268:     } | 269:     if (inPoint  !== null) drawHandle(inPoint,  '#33CED6') | >  270:     if (outPoint !== null) drawHandle(outPoint, '#33CED6') | 271: | 272:     // ── Time labe`

### node-editor (10)

- **ui/src/components/mixer/NodeEditor.jsx:172:21** — `#555566` (hex, hint=stroke)
  - proposed: `--theme-nodeeditor-port-default`  — rule: `v2-gate-tiebreak-subsystem-unanchored`
  - gates: value → capability → subsystem:same
  - rationale: Subsystem-only match: --theme-nodeeditor-port-default is value-equal but its semantic tail [nodeeditor, port] is absent from the context. Other-subsystem value-equivalents: 2. Likely a catalog gap, not a true MEDIUM.
  - context: `169:       target: String(c.dest), | 170:       data: { gain: c.gain, muted: c.muted, srcId: c.source, dstId: c.dest }, | 171:       style: c.muted | >  172:         ? { stroke: '#555566', strokeWidth: 2, strokeDasharray`
- **ui/src/components/mixer/NodeEditor.jsx:173:21** — `#FFAA33` (hex, hint=stroke)
  - proposed: `--theme-nodeeditor-connection-cv`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-nodeeditor-connection-cv, --theme-nodeeditor-port-connected
  - context: `170:       data: { gain: c.gain, muted: c.muted, srcId: c.source, dstId: c.dest }, | 171:       style: c.muted | 172:         ? { stroke: '#555566', strokeWidth: 2, strokeDasharray: '6 4' } | >  173:         : { stroke: `
- **ui/src/components/mixer/NodeEditor.jsx:174:67** — `#555566` (hex, hint=fg)
  - proposed: `--theme-nodeeditor-port-default`  — rule: `v2-gate-tiebreak-subsystem-unanchored`
  - gates: value → capability → subsystem:same
  - rationale: Subsystem-only match: --theme-nodeeditor-port-default is value-equal but its semantic tail [nodeeditor, port] is absent from the context. Other-subsystem value-equivalents: 2. Likely a catalog gap, not a true MEDIUM.
  - context: `171:       style: c.muted | 172:         ? { stroke: '#555566', strokeWidth: 2, strokeDasharray: '6 4' } | 173:         : { stroke: '#FFAA33', strokeWidth: 2 }, | >  174:       markerEnd: { type: MarkerType.ArrowClosed, `
- **ui/src/components/mixer/NodeEditor.jsx:174:79** — `#FFAA33` (hex, hint=fg)
  - proposed: `--theme-nodeeditor-connection-cv`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-nodeeditor-connection-cv, --theme-nodeeditor-port-connected
  - context: `171:       style: c.muted | 172:         ? { stroke: '#555566', strokeWidth: 2, strokeDasharray: '6 4' } | 173:         : { stroke: '#FFAA33', strokeWidth: 2 }, | >  174:       markerEnd: { type: MarkerType.ArrowClosed, `
- **ui/src/components/mixer/NodeEditor.jsx:301:28** — `#FFAA33` (hex, hint=stroke)
  - proposed: `--theme-nodeeditor-connection-cv`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-nodeeditor-connection-cv, --theme-nodeeditor-port-connected
  - context: `298:         deleteKeyCode={null} | 299:         proOptions={{ hideAttribution: true }} | 300:         defaultEdgeOptions={{ | >  301:           style: { stroke: '#FFAA33', strokeWidth: 2 }, | 302:           markerEnd: {`
- **ui/src/components/mixer/NodeEditor.jsx:302:61** — `#FFAA33` (hex, hint=fg)
  - proposed: `--theme-nodeeditor-connection-cv`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-nodeeditor-connection-cv, --theme-nodeeditor-port-connected
  - context: `299:         proOptions={{ hideAttribution: true }} | 300:         defaultEdgeOptions={{ | 301:           style: { stroke: '#FFAA33', strokeWidth: 2 }, | >  302:           markerEnd: { type: MarkerType.ArrowClosed, color`
- **ui/src/styles/app.css:5725:26** — `#FFAA33` (hex, hint=border)
  - proposed: `--theme-nodeeditor-connection-cv`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-nodeeditor-connection-cv, --theme-nodeeditor-port-connected
  - context: `5722: } | 5723: | 5724: .ne-node--input { | > 5725:   border-left: 3px solid #FFAA33; | 5726: } | 5727: | 5728: .ne-node--output {`
- **ui/src/styles/app.css:5729:27** — `#FFAA33` (hex, hint=border)
  - proposed: `--theme-nodeeditor-connection-cv`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-nodeeditor-connection-cv, --theme-nodeeditor-port-connected
  - context: `5726: } | 5727: | 5728: .ne-node--output { | > 5729:   border-right: 3px solid #FFAA33; | 5730: } | 5731: | 5732: .ne-node-label {`
- **ui/src/styles/app.css:5797:15** — `#FFAA33` (hex, hint=bg)
  - proposed: `--theme-nodeeditor-connection-cv`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-nodeeditor-connection-cv, --theme-nodeeditor-port-connected
  - context: `5794: .ne-handle { | 5795:   width: 8px !important; | 5796:   height: 8px !important; | > 5797:   background: #FFAA33 !important; | 5798:   border: 1px solid var(--bg-primary) !important; | 5799:   border-radius: 50% !im`
- **ui/src/styles/app.css:5875:15** — `#FFAA33` (hex, hint=bg)
  - proposed: `--theme-nodeeditor-connection-cv`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-nodeeditor-connection-cv, --theme-nodeeditor-port-connected
  - context: `5872:   width: 12px; | 5873:   height: 12px; | 5874:   border-radius: 50%; | > 5875:   background: #FFAA33; | 5876:   cursor: pointer; | 5877:   border: 1px solid var(--bg-primary); | 5878: }`

### piano-roll (3)

- **ui/src/components/pianoRoll/PianoRollCanvas.jsx:108:25** — `#33CED6` (hex, hint=canvas-stroke)
  - proposed: `--theme-border-focus`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-border-focus, --theme-info
  - context: `105:     if (endX < w) { | 106:       ctx.fillStyle = 'rgba(0,0,0,0.4)' | 107:       ctx.fillRect(Math.max(0, endX), 0, w - endX, h) | >  108:       ctx.strokeStyle = '#33CED6' | 109:       ctx.lineWidth = 1 | 110:      `
- **ui/src/components/pianoRoll/PianoRollCanvas.jsx:40:19** — `#0d0d14` (hex, hint=canvas-fill)
  - proposed: `--theme-bg-inset`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:universal
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-bg-inset, --theme-text-on-accent
  - context: `37: | 38: function drawBackground(ctx, w, h, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY, patternLenBeats) { | 39:   ctx.clearRect(0, 0, w, h) | >   40:   ctx.fillStyle = '#0d0d14' | 41:   ctx.fillRect(0, 0, w, h)`
- **ui/src/components/pianoRoll/PianoRollCanvas.jsx:579:24** — `#33CED6` (hex, hint=canvas-stroke)
  - proposed: `--theme-border-focus`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-border-focus, --theme-info
  - context: `576:       const y1 = Math.max(sy0, sy1) | 577:       ov.fillStyle = 'rgba(51, 206, 214, 0.12)' | 578:       ov.fillRect(x0, y0, x1 - x0, y1 - y0) | >  579:       ov.strokeStyle = '#33CED6' | 580:       ov.lineWidth = 1 `

### preview-player (1)

- **ui/src/components/VideoPreview.jsx:210:27** — `#555566` (hex, hint=canvas-fill)
  - proposed: `--theme-text-placeholder`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:universal
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-text-placeholder, --theme-text-subtle
  - context: `207:       } else if (ctx2d) { | 208:         ctx2d.fillStyle = '#111118' | 209:         ctx2d.fillRect(0, 0, canvas.width, canvas.height) | >  210:         ctx2d.fillStyle = '#555566' | 211:         ctx2d.font = '500 14`

### sampler (1)

- **ui/src/components/sampler/SamplerWaveform.jsx:94:23** — `#555566` (hex, hint=canvas-fill)
  - proposed: `--theme-text-placeholder`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:universal
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-text-placeholder, --theme-text-subtle
  - context: `91:     ctx.fillRect(0, 0, width, height) | 92: | 93:     if (!peaks) { | >   94:       ctx.fillStyle = '#555566' | 95:       ctx.font = '11px sans-serif' | 96:       ctx.textAlign = 'center' | 97:       ctx.fillText(loa`

### stock-effects.dynamics (1)

- **ui/src/components/mixer/SmartBalancePanel.jsx:80:19** — `#0d0d14` (hex, hint=canvas-fill)
  - proposed: `--theme-bg-inset`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:universal
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-bg-inset, --theme-text-on-accent
  - context: `77: function drawBackground(ctx, w, h, bandRanges) { | 78:   ctx.clearRect(0, 0, w, h) | 79:   // Overall dark fill | >   80:   ctx.fillStyle = '#0d0d14' | 81:   ctx.fillRect(0, 0, w, h) | 82:   // Band columns | 83:   f`

### stock-effects.shared (3)

- **ui/src/components/sampler/Knob.jsx:19:21** — `rgba(255,255,255,0.08)` (rgba, hint=TRACK_COLOR)
  - proposed: `--theme-fx-knob-lg-track`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-fx-knob-lg-track, --theme-fx-knob-sm-track
  - context: `16: //   dragRange        pixels of vertical travel = full min→max sweep (default 180) | 17: | 18: const KNOB_COLOR = '#33CED6' | >   19: const TRACK_COLOR = 'rgba(255,255,255,0.08)' | 20: const BG_COLOR = '#1A1A24' | 21`
- **ui/src/components/sampler/Knob.jsx:210:43** — `#E8E8ED` (hex, hint=fg)
  - proposed: `--theme-fx-knob-lg-indicator`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-fx-knob-lg-indicator, --theme-fx-knob-lg-value, --theme-fx-knob-sm-value
  - context: `207:           }} | 208:           style={{ | 209:             width: size, fontSize: 10, textAlign: 'center', | >  210:             background: '#0a0a10', color: '#E8E8ED', | 211:             border: `1px solid ${KNOB_C`
- **ui/src/components/sampler/Knob.jsx:229:31** — `#8888A0` (hex, hint=fg)
  - proposed: `--theme-fx-axis-label`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-fx-axis-label, --theme-fx-slider-label
  - context: `226:       )} | 227:       {label && ( | 228:         <div style={{ | >  229:           fontSize: 9, color: '#8888A0', textTransform: 'uppercase', | 230:           letterSpacing: 0.5, fontWeight: 500, | 231:         }}> `

### syllable-splitter (1)

- **ui/src/components/SyllableSplitter/SyllableSplitter.jsx:11:13** — `#555566` (hex, hint=COLOR)
  - proposed: `--theme-text-placeholder`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-text-placeholder, --theme-text-subtle
  - context: `8: const DELETE_EDGE = 6    // drag this close to left/right edge → delete marker | 9: const COLOR = { | 10:   bg:       '#1b1b24', | >   11:   wave:     '#555566', | 12:   waveDim:  '#3a3a4a', | 13:   marker:   '#33CED6`

### timeline (9)

- **ui/src/components/timeline/FadeBezierEditor.jsx:85:23** — `#33CED6` (hex, hint=canvas-stroke)
  - proposed: `--theme-border-focus`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-border-focus, --theme-info
  - context: `82:     ctx.beginPath() | 83:     ctx.moveTo(p0.cx, p0.cy) | 84:     ctx.bezierCurveTo(cp1.cx, cp1.cy, cp2.cx, cp2.cy, p3.cx, p3.cy) | >   85:     ctx.strokeStyle = '#33CED6' | 86:     ctx.lineWidth = 2 | 87:     ctx.str`
- **ui/src/components/timeline/TimelineCanvas.jsx:467:28** — `#33CED6` (hex, hint=bg)
  - proposed: `--theme-border-focus`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-border-focus, --theme-info
  - context: `464:           left: 0, | 465:           width: '2px', | 466:           height: '100%', | >  467:           backgroundColor: '#33CED6', | 468:           pointerEvents: 'none', | 469:           zIndex: 10, | 470:         `
- **ui/src/components/timeline/timelineDrawing.js:180:19** — `#555566` (hex, hint=canvas-fill)
  - proposed: `--theme-text-placeholder`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:universal
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-text-placeholder, --theme-text-subtle
  - context: `177:   } | 178: | 179:   // Bar numbers | >  180:   ctx.fillStyle = '#555566' | 181:   ctx.font = '600 9px "Hanken Grotesk", system-ui, sans-serif' | 182:   ctx.textBaseline = 'top' | 183:   const firstBar = Math.floor(s`
- **ui/src/components/timeline/timelineDrawing.js:222:19** — `#33CED6` (hex, hint=canvas-fill)
  - proposed: `--theme-border-focus`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-border-focus, --theme-info
  - context: `219:   ctx.stroke() | 220: | 221:   // Small triangle at top | >  222:   ctx.fillStyle = '#33CED6' | 223:   ctx.beginPath() | 224:   ctx.moveTo(x, 0) | 225:   ctx.lineTo(x - 4, -0) // flat top edge`
- **ui/src/components/timeline/timelineDrawing.js:838:19** — `#33CED6` (hex, hint=canvas-fill)
  - proposed: `--theme-border-focus`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-border-focus, --theme-info
  - context: `835:   ctx.stroke() | 836: | 837:   // Downward triangle | >  838:   ctx.fillStyle = '#33CED6' | 839:   ctx.beginPath() | 840:   ctx.moveTo(x, h) | 841:   ctx.lineTo(x - 4, h - 6)`
- **ui/src/components/timeline/TimelineRuler.jsx:132:28** — `#33CED6` (hex, hint=bg)
  - proposed: `--theme-border-focus`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-border-focus, --theme-info
  - context: `129:           left: 0, | 130:           width: '2px', | 131:           height: '100%', | >  132:           backgroundColor: '#33CED6', | 133:           pointerEvents: 'none', | 134:           zIndex: 10, | 135:         `
- **ui/src/components/timeline/TimelineToolbar.jsx:72:38** — `#33CED6` (hex, hint=outline)
  - proposed: `--theme-border-focus`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-border-focus, --theme-info
  - context: `69:               className="timeline-active-sample-dot" | 70:               style={{ | 71:                 backgroundColor: labelHexColor(pencilTemplate.label), | >   72:                 outline: '1.5px solid #33CED6', `
- **ui/src/components/TimelineView.jsx:49:40** — `#33CED6` (hex, hint=accentColor)
  - proposed: `--theme-border-focus`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:same
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-border-focus, --theme-info
  - context: `46:           const v = Number(e.target.value) | 47:           Promise.resolve(onCommit(v)).finally(() => { dragging.current = false }) | 48:         }} | >   49:         style={{ flex: 1, accentColor: '#33CED6' }} | 50:`
- **ui/src/styles/app.css:1614:10** — `#0D0D14` (hex, hint=fg)
  - proposed: `--theme-bg-inset`  — rule: `v2-gate-tiebreak-alphabetical`
  - gates: value → capability → subsystem:universal
  - rationale: Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: --theme-bg-inset, --theme-text-on-accent
  - context: `1611: | 1612: .timeline-copied-tooltip { | 1613:   background: rgba(51, 206, 214, 0.9); | > 1614:   color: #0D0D14; | 1615:   font-size: 11px; | 1616:   font-weight: 600; | 1617:   padding: 2px 8px;`

## FALSE-POSITIVE table (9)

Preserved byte-identical from v1 per integrity assertion 6.

| path:line:col | matchedText | rule |
|---|---|---|
| ui/src/components/pianoRoll/PianoRollCanvas.jsx:18:11 | `rgba(` | `fp-bare-rgba-helper` |
| ui/src/components/sampler/EnvelopeEditor.jsx:110:22 | `rgba(` | `fp-bare-rgba-helper` |
| ui/src/components/timeline/timelineDrawing.js:161:26 | `rgba(` | `fp-templated-rgba` |
| ui/src/components/timeline/timelineDrawing.js:240:11 | `rgba(` | `fp-bare-rgba-helper` |
| ui/src/components/timeline/timelineDrawing.js:397:20 | `rgba(` | `fp-templated-rgba` |
| ui/src/components/timeline/timelineDrawing.js:398:20 | `rgba(` | `fp-templated-rgba` |
| ui/src/components/timeline/timelineDrawing.js:419:20 | `rgba(` | `fp-templated-rgba` |
| ui/src/components/timeline/timelineDrawing.js:420:20 | `rgba(` | `fp-templated-rgba` |
| ui/src/components/timeline/timelineDrawing.js:78:24 | `rgba(` | `fp-templated-rgba` |

## Known residual catalog gaps (from Step 5 audit)

These are MEDIUM assignments whose *value* matches a catalog token but whose *role*
does not — the catalog has no semantically-correct token. Flagged for catalog work,
not for classifier retuning.

1. **SmartBalancePanel band `#FFD93D`** — classifier picks `--theme-label-hihat`
   because it is the only catalog token holding that value. The hihat label is
   semantically unrelated; SmartBalancePanel needs a product-domain token for its
   frequency-band data color. (Tracked under "G2" in gaps report.)
2. **LipSyncView selection edge `#33CED6`** — classifier picks
   `--theme-lipsync-waveform-playhead` because it shares the accent value.
   Selection-edge is a different role; add `--theme-lipsync-selection-edge`
   or repoint to `--theme-accent`.
3. **LFO_COLORS.vol `#33CED6`** — classifier picks
   `--theme-sampler-pitch-envelope-curve` by tie-break; the LFO_COLORS object
   line assigns all three LFO tab colors on one multi-color source line, which
   denies any hint disambiguation. Prefer `--theme-sampler-lfo-color-volume`
   — requires per-match context refinement in the upstream audit, not here.

