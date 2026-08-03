# Clip Control Tuning Lab

The gain/fade tuning lab is a build-only timeline inspector. It changes the
shared renderer/interaction specification in memory and never writes visual
settings into a project.

## Launch

After rebuilding the native bridge, start the flagged development build:

```powershell
.\build.bat bridge
Set-Location ui
npm run dev:clip-controls
```

The lab opens docked over the timeline. Closing it leaves a **Clip control lab**
button in the timeline. An ordinary `npm run dev` or `npm run build` excludes
the lab chunk and uses only the baked `CLIP_CONTROL_DEFAULTS`.

## Eye pass

- Select, hover, and drag real clip gain/fade controls while changing fields.
- Use the production preview matrix for exact `40x20`, `64x46`, `180x46`, and
  `360x86` cases. Its handles are interactive; hold Shift for fine movement.
- Turn on paint bounds, hit regions, and anchors in the **Debug** group.
- Use group reset, full reset, undo, and redo freely. The unfinished session is
  stored only in versioned local storage and is ignored after the defaults hash
  changes.
- Click **Copy full report** and paste the JSON into the implementation task.

The report includes the defaults, normalized final object, exact diff,
coalesced history, preview values and fade curves, app version, theme, DPR,
timeline zoom, viewport, timestamp, revision, and defaults hash. Baking an eye
pass means replacing `CLIP_CONTROL_DEFAULTS` with the report's `final` object,
bumping `CLIP_CONTROL_DEFAULTS_REVISION`, and refreshing visual baselines.
