# XLETH Lens + Roam spec (locked 2026-11-13, rulings added after the P0 audit)

## Names (final, use these in code, UI and docs)
- Lens: per-clip framing of the video INSIDE its grid cell (fit, center, zoom, rotation, flip). Replaces the Vegas "Pan/Crop" concept; never use that name.
- Roam: per-track transform of the CELL ITSELF (offset, scale, rotation, bounds). Replaces the Vegas "Track Motion" concept; never use that name.
- Reel lane: read-only video lane under each Pattern Track. One ghost clip per note. Position and length come from the piano roll and cannot be edited in the lane.
- Track Lens: a Pattern Track source's default Lens (keyed {trackId, regionId}) plus its hit curve, the animation every note plays.
- Follow / Nudge / Own: per-note Lens state. Follow = plays the hit curve. Nudge = hit curve plus this note's offset keys. Own = this note's own curve only; hit-curve edits do not reach it.
- Head / Body / Tail: note-relative key anchors. Head = ticks after note-on (fixed). Body = fraction (0..1) of the span between head end and tail start (stretches with the note). Tail = ticks before the clamped note end (fixed).
- Squash / Cut: rule when note length is shorter than head + tail. Squash (default): scale head and tail lengths by noteLen / (head + tail); body length is 0. Cut: tail starts at max(0, noteLen - tail); head is truncated where the tail starts; if noteLen is shorter than tail, the tail starts part-way through.
- Sweep lane: per-track, timeline-absolute Lens offset for moves spanning several notes (later phase).

## Rulings (2026-11-13, from the P0 audit)
1. Fit mode. Lens gains fit (Stretch | Cover | Contain). Old projects migrate to Stretch, which is today's behaviour, so they render bit-identically. New clips and sources default to Cover. zoom 1.0 = the chosen fit. The framing box keeps the cell's aspect in every mode.
2. Existing zoom/pan/rotate data migrates on load into Lens (if it frames content inside the cell) or Roam (if it moves the cell), and the old fields are removed. One source of truth. Anything that lives as an effect in the visual effect chain stays an effect.
3. Lens frames the source BEFORE the visual effects. Effects see what is actually in the cell, and their cost scales with cell size, not source size. Everything that exists today keeps its current order after Lens.
4. Tail anchors to the clamped note end (where the video actually stops), not the raw note-off.
5. Note animation is computed from the note's start tick (the way Note Fade already is), never from the first frame that sees the note. Seeking into a note lands mid-animation; preview and export match.
6. Overrides are keyed {patternId, noteId} (note ids are unique only inside one pattern). Make Unique Copy copies overrides to the new ids. Both UI-engine note converters carry lensOverride, or piano roll edits silently erase it.
7. Threading: Lens/Roam values travel in each cell's render-request copy and add no locks or allocation to the render thread. The render thread's existing per-frame model lock and allocation are pre-existing debt, tracked separately. Export reads a frozen timeline copy (phase P1b).
8. Roam handles live on a new viewer overlay canvas. The existing DOM grid-editor overlay stays as it is for now.

## Parameters
- Lens: fit (Stretch | Cover | Contain), centerX, centerY (0..1, source-normalized), zoom (multiplier; 1.0 = the chosen fit), rotationDeg, flip (FollowTrack | None | Horizontal | Vertical).
- Roam: offsetX, offsetY (cell units; 1.0 = one cell width / height), scale (multiplier), rotationDeg (about the cell center), bounds (Clip | Float; default Clip), layer (GridOrder | AboveNeighbours | Top).
- Identity (fit = Stretch, everything else neutral) reproduces today's rendering exactly. Old projects must render bit-identically.

## Order of operations
- Cell: grid rect (incl. half-grid, Chorus behind-layer) -> Roam -> (future: modulation graph offsets).
- Content: Lens (base -> note animation (Follow / Nudge / Own) -> Sweep offset) -> the existing chain (visual effects, flip) in today's order. Flip still mirrors the framed result.
- Blend: zoom and scale multiply; center, offset and rotation add.
- Bounds Clip: cell and content clipped to the home cell rect. Bounds Float: drawn unclipped over neighbours per the layer setting.

## Time bases (ticks, 960 PPQ)
- Clip Track event Lens keys: ticks from the event start (keys move with the event).
- Pattern note keys: Head / Body / Tail anchors, computed from the note's start tick and its clamped end.
- Roam keys and Sweep keys: timeline-absolute ticks.
- One evaluator in the C++ engine, evaluated against transport ticks, feeds BOTH live preview and export.

## Storage
- Clip Track event: lens { base, keys }.
- Pattern Track source {trackId, regionId}: trackLens { base, hitCurve }.
- Per note, keyed {patternId, noteId}: lensOverride { mode: Nudge | Own, keys }. Absent = Follow.
- Track: roam { base, keys }.
- Schema version bump with migration. Missing fields load as identity; old projects load with fit = Stretch.

## Threading
- UI -> bridge -> UndoManager mutation -> engine copies resolved Lens/Roam values into each cell's render request.
- Lens/Roam add no locks, allocation or logging to the audio or render thread.
- Export reads a frozen timeline copy, never the live Timeline.
- No IPC during drags: local preview on the UI canvas, a single commit on mouseup.

## Hit curve presets (defaults: head 120 ticks = 1/32, tail 240 ticks = 1/16)
- Still: no keys.
- Punch: Head 0 zoom 1.35 -> Head 120 zoom 1.00 (ease out).
- Punch + drift: Head 0 zoom 1.35 -> Head 120 zoom 1.08 -> Tail 240 zoom 1.20 -> Tail 0 zoom 1.00.
- Zoom pulse: Head 0 zoom 1.00 -> Body 0.5 zoom 1.15 -> Tail 0 zoom 1.00.

## UI
- One Lens panel with Simple and Advanced modes; Advanced only reveals more. Simple: framing box on the source frame, Fit control, number boxes, preset buttons. Advanced: keyframe lanes with Head/Body/Tail bands, inherited keys drawn hollow, the note's own keys filled, key inspector with anchor, layer stack with the resolved value at the playhead.
- Reel lane: one more row type in the arrangement's existing child-lane layout. Follow clips are uncoloured; Nudge badge "+", Own badge "O". Overlapping notes stack into sub-rows. Thumbnails only above a zoom threshold. Selection synced with the piano roll.
- Roam: inspector (cells or pixels display, stored in cells), handles and motion path on a new viewer overlay canvas, a timeline-absolute key lane under the track.
- Follow the anti-daw-ui-slop rules. Lanes on canvas, never DOM overlays on canvases. No animation on edit-loop actions.

## Phases
P0 audit + save spec (done, 0ae9bf9) · P0b rulings + feature branch · P1 engine model, fit, migration · P1b export reads a frozen timeline · P2 compositor · P3 bridge + undo · P4 static UI (ship point) · P5 note-ID plumbing for overrides · P6 Reel lane · P7 curve engine · P8 hit curves + Follow/Nudge/Own + presets · P9 Lens Advanced editor · P10 Roam keyframes UI · P11 Sweep lane · P12 verification.

## Out of scope
Modulation graph, compositing graph, per-note Roam, masks, the render thread's existing per-frame lock and allocation.
