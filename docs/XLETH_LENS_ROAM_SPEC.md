# XLETH Lens + Roam spec (locked 2026-11-13)

## Names (final, use these in code, UI and docs)
- Lens: per-clip framing of the video INSIDE its grid cell (center, zoom, rotation, flip). Replaces the Vegas "Pan/Crop" concept; never use that name.
- Roam: per-track transform of the CELL ITSELF (offset, scale, rotation, bounds). Replaces the Vegas "Track Motion" concept; never use that name.
- Reel lane: read-only video lane under each Pattern Track. One ghost clip per note. Position and length come from the piano roll and cannot be edited in the lane.
- Track Lens: a Pattern Track source's default Lens (keyed {trackId, regionId}) plus its hit curve, the animation every note plays.
- Follow / Nudge / Own: per-note Lens state. Follow = plays the hit curve. Nudge = hit curve plus this note's offset keys. Own = this note's own curve only; hit-curve edits do not reach it.
- Head / Body / Tail: note-relative key anchors. Head = ticks after note-on (fixed). Body = fraction (0..1) of the span between head end and tail start (stretches with the note). Tail = ticks before note-off (fixed).
- Squash / Cut: rule when note length is shorter than head + tail. Squash (default): scale head and tail lengths by noteLen / (head + tail); body length is 0. Cut: tail starts at max(0, noteLen - tail); head is truncated where the tail starts; if noteLen is shorter than tail, the tail starts part-way through.
- Sweep lane: per-track, timeline-absolute Lens offset for moves spanning several notes (later phase).

## Parameters
- Lens: centerX, centerY (0..1, source-normalized), zoom (multiplier; 1.0 = source cover-fits the cell using the CELL's aspect ratio), rotationDeg, flip (FollowTrack | None | Horizontal | Vertical). Aspect is always locked to the cell's aspect, never the project's.
- Roam: offsetX, offsetY (cell units; 1.0 = one cell width / height), scale (multiplier), rotationDeg (about the cell center), bounds (Clip | Float; default Clip), layer (GridOrder | AboveNeighbours | Top).
- Identity values reproduce today's rendering exactly. Old projects must render bit-identically.

## Order of operations
- Cell: grid rect (incl. half-grid, Chorus behind-layer) -> Roam -> (future: modulation graph offsets).
- Content: Lens base -> note animation (Follow / Nudge / Own) -> Sweep offset -> flip (mirrors the framed result).
- Blend: zoom and scale multiply; center, offset and rotation add.
- Bounds Clip: cell and content clipped to the home cell rect. Bounds Float: drawn unclipped over neighbours per the layer setting.

## Time bases (ticks, 960 PPQ)
- Clip Track event Lens keys: ticks from the event start (keys move with the event).
- Pattern note keys: Head / Body / Tail anchors.
- Roam keys and Sweep keys: timeline-absolute ticks.
- One evaluator in the C++ engine, evaluated against transport ticks, feeds BOTH live preview and export.

## Storage
- Clip Track event: lens { base, keys }.
- Pattern Track source {trackId, regionId}: trackLens { base, hitCurve }.
- Per note, by stable noteId: lensOverride { mode: Nudge | Own, keys }. Absent = Follow.
- Track: roam { base, keys }.
- Schema version bump with migration. Missing fields load as identity.

## Threading
- UI -> bridge -> UndoManager mutation -> engine publishes an immutable snapshot of Lens/Roam state for the compositor.
- No locks, allocation or logging on the audio or render thread.
- No IPC during drags: local preview on the UI canvas, a single commit on mouseup.

## Hit curve presets (defaults: head 120 ticks = 1/32, tail 240 ticks = 1/16)
- Still: no keys.
- Punch: Head 0 zoom 1.35 -> Head 120 zoom 1.00 (ease out).
- Punch + drift: Head 0 zoom 1.35 -> Head 120 zoom 1.08 -> Tail 240 zoom 1.20 -> Tail 0 zoom 1.00.
- Zoom pulse: Head 0 zoom 1.00 -> Body 0.5 zoom 1.15 -> Tail 0 zoom 1.00.

## UI
- One Lens panel with Simple and Advanced modes; Advanced only reveals more. Simple: framing box on the source frame, number boxes, preset buttons. Advanced: keyframe lanes with Head/Body/Tail bands, inherited keys drawn hollow, the note's own keys filled, key inspector with anchor, layer stack with the resolved value at the playhead.
- Reel lane: Follow clips are uncoloured; Nudge badge "+", Own badge "O". Overlapping notes stack into sub-rows. Thumbnails only above a zoom threshold. Selection synced with the piano roll.
- Roam: inspector (cells or pixels display, stored in cells), viewer handles and motion path, a timeline-absolute key lane under the track.
- Follow the anti-daw-ui-slop rules. Lanes on canvas, never DOM overlays on canvases. No animation on edit-loop actions.

## Out of scope
Modulation graph, compositing graph, per-note Roam, masks.
