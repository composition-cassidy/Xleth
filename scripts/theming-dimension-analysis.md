# Dimension Analysis

Generated: 2026-04-19T20:21:39.630Z

## Purpose

The color-only enrichment excludes chrome-dimension matches (spacing, padding, gap, border-radius, width/height, etc.). A spacing/radius scale design is queued as a separate track. This file is pure data — no assignments, no per-match enrichment.

## Total dimension matches

851

## Top 30 most-frequent dimension values

| Value | Count | Files (top 5) |
|---|---:|---|
| `6px` | 63 | ui/src/styles/app.css:63 |
| `2px` | 62 | ui/src/styles/app.css:60, ui/src/components/timeline/TimelineCanvas.jsx:1, ui/src/components/timeline/TimelineRuler.jsx:1 |
| `4px` | 60 | ui/src/styles/app.css:58, ui/src/components/SampleSelectorTab.jsx:1, ui/src/components/SamplePicker/SamplePicker.jsx:1 |
| `8px` | 59 | ui/src/styles/app.css:58, ui/src/components/SampleSelectorTab.jsx:1 |
| `3px` | 52 | ui/src/styles/app.css:52 |
| `20px` | 46 | ui/src/styles/app.css:46 |
| `12px` | 33 | ui/src/styles/app.css:33 |
| `6px 10px` | 23 | ui/src/styles/app.css:21, ui/src/components/sampler/SamplerPanel.jsx:1, ui/src/components/SampleSelectorTab.jsx:1 |
| `14px` | 22 | ui/src/styles/app.css:22 |
| `10px` | 21 | ui/src/styles/app.css:21 |
| `1px` | 19 | ui/src/styles/app.css:19 |
| `18px` | 17 | ui/src/styles/app.css:17 |
| `16px` | 15 | ui/src/styles/app.css:15 |
| `4px 6px` | 11 | ui/src/styles/app.css:8, ui/src/components/sampler/SamplerPanel.jsx:3 |
| `24px` | 11 | ui/src/styles/app.css:11 |
| `22px` | 11 | ui/src/styles/app.css:11 |
| `0 2px` | 10 | ui/src/styles/app.css:10 |
| `4px 10px` | 9 | ui/src/styles/app.css:9 |
| `32px` | 9 | ui/src/styles/app.css:9 |
| `4px 8px` | 8 | ui/src/styles/app.css:6, ui/src/components/TimelineView.jsx:1, ui/src/components/SampleSelectorTab.jsx:1 |
| `28px` | 8 | ui/src/styles/app.css:8 |
| `80px` | 8 | ui/src/styles/app.css:8 |
| `12px 16px` | 8 | ui/src/styles/app.css:8 |
| `420px` | 8 | ui/src/styles/app.css:8 |
| `2px 6px` | 7 | ui/src/styles/app.css:6, ui/src/components/sampler/LfoSection.jsx:1 |
| `1px 4px` | 7 | ui/src/styles/app.css:5, ui/src/components/timeline/FadeBezierEditor.jsx:1, ui/src/components/timeline/TimelineToolbar.jsx:1 |
| `0 4px` | 7 | ui/src/styles/app.css:6, ui/src/components/SampleSelectorTab.jsx:1 |
| `120px` | 7 | ui/src/styles/app.css:7 |
| `60px` | 7 | ui/src/styles/app.css:7 |
| `4px 0` | 6 | ui/src/styles/app.css:6 |

## Top 20 element hints

| Hint | Count |
|---|---:|
| padding | 234 |
| gap | 180 |
| width | 108 |
| height | 98 |
| border-radius | 85 |
| min-width | 29 |
| max-width | 15 |
| margin-top | 14 |
| margin | 12 |
| margin-bottom | 12 |
| margin-left | 11 |
| top | 10 |
| margin-right | 7 |
| min-height | 7 |
| borderRadius | 6 |
| right | 6 |
| max-height | 6 |
| left | 3 |
| padding-left | 2 |
| padding-top | 2 |

## File distribution (top 10)

| File | Count |
|---|---:|
| ui/src/styles/app.css | 821 |
| ui/src/components/sampler/SamplerPanel.jsx | 9 |
| ui/src/components/SampleSelectorTab.jsx | 5 |
| ui/src/components/sampler/LfoSection.jsx | 3 |
| ui/src/components/TimelineView.jsx | 3 |
| ui/src/components/SamplePicker/SamplePicker.jsx | 3 |
| ui/src/components/sampler/MiniKeyboard.jsx | 2 |
| ui/src/components/sampler/Knob.jsx | 1 |
| ui/src/components/timeline/FadeBezierEditor.jsx | 1 |
| ui/src/components/timeline/TimelineCanvas.jsx | 1 |

## Next steps

The spacing/radius token scale belongs to a separate design track. Options:

1. Define a canonical dimension scale (e.g. `--theme-space-1` … `--theme-space-12`, `--theme-radius-sm/md/lg`) and replace raw px values across the codebase.
2. Define per-subsystem dimension tokens for the few cases where a subsystem needs divergent spacing.
3. Accept raw pixel values in non-themable chrome (app shell) and only tokenise where Advanced mode needs to override.

This document is the data input for that design decision — no action is taken here.
