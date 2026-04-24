# Theming corrective pass — report

Generated: 2026-04-20T12:34:34.096Z

## Spec extension (requires sign-off)

Strict directive: detect derived-var → universal base aliases only.
Extended: detect ANY non-base assignment whose resolved value equals a
universal base value (catches derived-formula transparent aliases like
--theme-border-focus and --theme-info, which are functionally identical
at runtime + Phase-1 detachment).

## Statistics

- Entries scanned (HIGH/MEDIUM/LOW with non-null proposed): 337
- POTENTIAL_OVERRIDE candidates found: 31
  - Overridden (heuristic decisive — generic role): 12
  - Kept as derived alias (subsystem-specific tail grounded in context): 16
  - Demoted to LOW (ambiguous): 3

- By tier (POTENTIAL_OVERRIDE distribution):
  - HIGH: 0
  - MEDIUM: 18
  - LOW: 13

- By override target:
  - --theme-accent: 12

- Tier counts (before → after):
  - HIGH:    185 → 185
  - MEDIUM:  115 → 113
  - LOW:     37 → 39
  - NO-FIT:  238 → 238
  - FP:      9 → 9

- Hardcoded TrackHeader.jsx:9 perc-label override applied: true

## Verification — 6 LOW #33CED6 cases pre-approved as --theme-accent

| File:line | Final proposed | Final confidence | Agrees with pre-approval? |
|---|---|---|---|
| ui/src/components/pianoRoll/PianoRollCanvas.jsx:108 | --theme-accent | low | ✓ |
| ui/src/components/pianoRoll/PianoRollCanvas.jsx:579 | --theme-accent | low | ✓ |
| ui/src/components/TimelineView.jsx:49 | --theme-accent | low | ✓ |
| ui/src/components/timeline/FadeBezierEditor.jsx:85 | --theme-accent | low | ✓ |
| ui/src/components/timeline/TimelineCanvas.jsx:467 | --theme-accent | low | ✓ |
| ui/src/components/timeline/TimelineRuler.jsx:132 | --theme-accent | low | ✓ |

**All 6 hardcoded cases agree with pass decision.**

## Per-entry actions

### OVERRIDDEN (assigned → universal base)

| File:line | Tier | Was → Is | Reason |
|---|---|---|---|
| ui/src/components/pianoRoll/PianoRollCanvas.jsx:108 | low | --theme-border-focus → **--theme-accent** | Tail [focus] absent from context and elementHint='canvas-stroke' is generic — semantic intent is the universal base. |
| ui/src/components/pianoRoll/PianoRollCanvas.jsx:579 | low | --theme-border-focus → **--theme-accent** | Tail [focus] absent from context and elementHint='canvas-stroke' is generic — semantic intent is the universal base. |
| ui/src/components/sampler/EnvelopeEditor.jsx:30 | medium | --theme-sampler-lfo-color-volume → **--theme-accent** | Tail [lfo, volume] absent from context and elementHint='fg' is generic — semantic intent is the universal base. |
| ui/src/components/TimelineView.jsx:49 | low | --theme-border-focus → **--theme-accent** | Tail [focus] absent from context and elementHint='accentColor' is generic — semantic intent is the universal base. |
| ui/src/components/timeline/FadeBezierEditor.jsx:85 | low | --theme-border-focus → **--theme-accent** | Tail [focus] absent from context and elementHint='canvas-stroke' is generic — semantic intent is the universal base. |
| ui/src/components/timeline/TimelineCanvas.jsx:467 | low | --theme-border-focus → **--theme-accent** | Tail [focus] absent from context and elementHint='bg' is generic — semantic intent is the universal base. |
| ui/src/components/timeline/TimelineRuler.jsx:132 | low | --theme-border-focus → **--theme-accent** | Tail [focus] absent from context and elementHint='bg' is generic — semantic intent is the universal base. |
| ui/src/components/timeline/TimelineToolbar.jsx:72 | low | --theme-border-focus → **--theme-accent** | Tail [focus] absent from context and elementHint='outline' is generic — semantic intent is the universal base. |
| ui/src/components/timeline/timelineDrawing.js:222 | low | --theme-border-focus → **--theme-accent** | Tail [focus] absent from context and elementHint='canvas-fill' is generic — semantic intent is the universal base. |
| ui/src/components/timeline/timelineDrawing.js:838 | low | --theme-border-focus → **--theme-accent** | Tail [focus] absent from context and elementHint='canvas-fill' is generic — semantic intent is the universal base. |
| ui/src/components/SamplePicker/WaveformScrubber.jsx:269 | low | --theme-border-focus → **--theme-accent** | Tail [focus] absent from context and elementHint='null' is generic — semantic intent is the universal base. |
| ui/src/components/SamplePicker/WaveformScrubber.jsx:270 | low | --theme-border-focus → **--theme-accent** | Tail [focus] absent from context and elementHint='null' is generic — semantic intent is the universal base. |

### KEPT as derived alias (semantic anchor grounded)

| File:line | Tier | Assigned | Reason |
|---|---|---|---|
| ui/src/components/mixer/PeakMeter.jsx:99 | medium | --theme-mixer-meter-peak-hold | Assigned token tail [meter, peak, hold] grounded in context (callsite is subsystem-specific). |
| ui/src/components/sampler/Knob.jsx:20 | medium | --theme-fx-knob-lg-bg | Assigned token tail [fx, knob, lg] grounded in context (callsite is subsystem-specific). |
| ui/src/components/sampler/Knob.jsx:210 | low | --theme-fx-knob-lg-indicator | Assigned token tail [fx, knob, lg, indicator] grounded in context (callsite is subsystem-specific). |
| ui/src/stores/eqStore.js:7 | medium | --theme-eq-band-1 | Assigned token tail [band, 1] grounded in context (callsite is subsystem-specific). |
| ui/src/components/pianoRoll/VelocityLane.jsx:54 | medium | --theme-pianoroll-velocity-bar-fill | Assigned token tail [pianoroll, velocity, bar] grounded in context (callsite is subsystem-specific). |
| ui/src/components/sampler/LfoSection.jsx:5 | medium | --theme-sampler-pitch-envelope-curve | Assigned token tail [pitch, envelope, curve] grounded in context (callsite is subsystem-specific). |
| ui/src/components/sampler/LfoWaveformCanvas.jsx:8 | medium | --theme-sampler-waveform-playhead | Assigned token tail [waveform, playhead] grounded in context (callsite is subsystem-specific). |
| ui/src/components/sampler/SamplerPanel.jsx:642 | medium | --theme-sampler-lfo-color-volume | Assigned token tail [lfo, volume] grounded in context (callsite is subsystem-specific). |
| ui/src/components/sampler/SamplerPanel.jsx:684 | medium | --theme-sampler-lfo-color-volume | Assigned token tail [lfo, volume] grounded in context (callsite is subsystem-specific). |
| ui/src/components/timeline/timelineDrawing.js:214 | medium | --theme-timeline-playhead-line | Assigned token tail [playhead, line] grounded in context (callsite is subsystem-specific). |
| ui/src/components/timeline/timelineDrawing.js:830 | medium | --theme-timeline-playhead-line | Assigned token tail [playhead, line] grounded in context (callsite is subsystem-specific). |
| ui/src/components/SyllableSplitter/SyllableSplitter.jsx:13 | medium | --theme-syllable-marker | Assigned token tail [marker] grounded in context (callsite is subsystem-specific). |
| ui/src/components/SamplePicker/WaveformScrubber.jsx:7 | medium | --theme-lipsync-waveform-playhead | Assigned token tail [lipsync, waveform, playhead] grounded in context (callsite is subsystem-specific). |
| ui/src/components/SamplePicker/WaveformScrubber.jsx:8 | medium | --theme-lipsync-waveform-playhead | Assigned token tail [lipsync, waveform, playhead] grounded in context (callsite is subsystem-specific). |
| ui/src/components/SamplePicker/WaveformScrubber.jsx:9 | medium | --theme-lipsync-waveform-playhead | Assigned token tail [lipsync, waveform, playhead] grounded in context (callsite is subsystem-specific). |
| ui/src/styles/app.css:3633 | medium | --theme-border-focus | Assigned token tail [focus] grounded in context (callsite is subsystem-specific). |

### DEMOTED to LOW (ambiguous — needs human review)

| File:line | Was tier | Assigned (kept) | Universal base candidate | Reason |
|---|---|---|---|---|
| ui/src/components/sampler/Knob.jsx:18 | medium | --theme-border-focus | --theme-accent | Tail [focus] absent from context but elementHint='KNOB_COLOR' is subsystem-coupled — ambiguous, needs human review. |
| ui/src/components/sampler/SamplerWaveform.jsx:5 | medium | --theme-sampler-lfo-color-volume | --theme-accent | Tail [lfo, volume] absent from context but elementHint='WAVE_COLOR' is subsystem-coupled — ambiguous, needs human review. |
| ui/src/components/timeline/TrackHeader.jsx:9 | low | --theme-border-focus | --theme-accent | Tail [focus] absent from context but elementHint='LABEL_COLORS' is subsystem-coupled — ambiguous, needs human review. |

---

Output JSON: theming-audit-enriched-v2-corrected.json
Original JSON preserved: theming-audit-enriched-v2.json (untouched)