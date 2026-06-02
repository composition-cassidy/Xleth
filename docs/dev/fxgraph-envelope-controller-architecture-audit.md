# FX Graph — Envelope Controller Architecture Audit (EVC.1)

Investigation/foundation document for the per-voice Envelope Controller node. This is a
**documentation-only** phase: no schema changes, no node UI, no runtime ADSR code, no trigger
events, no parameter-edge behavior, no `effectChains` changes. Everything below is an audit finding
or a recommendation for later phases.

Status: EVC.0 passed. EVC.1 (this document) is the audit. EVC.2 implemented the inert renderer-side
graphState schema for the `type: 'envelope'` node per §6 (normalization, pure helpers, graph-mode
store actions, persistence, undo/redo) — no UI, no runtime, no trigger contract yet. EVC.3 added the
visible/editable envelope node UI in the active safe FX Graph (Add Envelope affordance, distinct node
rendering, compact AHDSR/voice/trigger/amount editor, and an illustrative preview curve) — still
renderer-only and non-audible, with no runtime ADSR, trigger contract, engine parsing, per-voice gain
application, `GraphParameterTarget` usage, Mixer Chain mutation, or `effectChains` mutation. EVC.4
implemented the **pure engine-side trigger/voice occurrence contract** per §3/§4/§6/§8: the
engine-internal occurrence key `(trackId, sourceKind, sourceId, onsetTick, loopIteration,
patternBlockId)` and deterministic position-pure enumeration of pattern-note occurrences (mirroring
`MixEngine::triggerPatternNotes` onset/gate/loop math) and clip occurrences (overlap, like
`findActiveClips`). It lives in `engine/src/model/EnvelopeVoiceEvents.h/.cpp` (pure
`XlethEngineModel`, mirroring the `VideoFlipResolver` precedent) with
`engine/test/test_envelope_voice_events.cpp`. EVC.4 is **non-audible**: no runtime ADSR, no per-voice
gain, no graphState runtime parsing, no `GraphParameterTarget`, no bridge/preload/main changes, no
Mixer Chain or `effectChains` mutation. Full mid-note seek reconstruction remains deferred to EVC.4b.
See the "EVC.2 — envelope node graphState schema", "EVC.3 — envelope node UI", and "EVC.4 —
engine-side trigger/voice occurrence contract" sections in
[`fxgraph-architecture.md`](fxgraph-architecture.md).

---

## 1. Executive summary

### The correct model

Envelope Controller v1 is a **per-voice controller**, not a global plugin-parameter modulation
source.

- Pattern notes and timeline clips each create **independent envelope voices**.
- Each note/clip voice owns its own AHDSR curve. Voices never average, sum, max, or otherwise
  combine. A chord behaves like a polyphonic synth: N notes ⇒ N independent envelopes with the
  **same shape**. Adding more notes does not change any individual envelope's shape.
- The clip/note **duration is the gate**: release begins when the clip/note ends.
- Polyphonic is the default mode. Monophonic is a later option and must not shape the architecture.
- First runtime target: **per-voice gain/volume**. The audit confirms this is correct — the engine
  already has a per-voice gain stage (`Sampler::Voice::envLevel`) that is the natural application
  point, and clips already carry a per-clip gain envelope (`Clip::fadeIn/Out*`). See §7.

### What is explicitly deferred

- **Global plugin-parameter output is deferred.** EVC v1 must NOT route through
  `GraphParameterTarget` parameter edges (FXG.4-c), must NOT connect to exposed stock/VST plugin
  parameters, must NOT create a shared-output adapter, and must NOT be faked in React by writing
  global parameter values. The macro-automation runtime (FXG.4-e/f/h) is **global, control-rate,
  renderer-side, single-valued** — it is structurally incapable of representing per-voice state and
  is the wrong substrate for EVC. See §3 and §9.

### Central architectural finding

**Per-voice state lives only in the C++ engine. The graph lives only in the renderer.** The
existing macro→parameter→automation stack (FXG.4-a…h) is entirely renderer-side and drives one
normalized value per macro through IPC. There is no renderer-side concept of a "voice." Therefore a
per-voice envelope evaluator **cannot** live in the renderer and **cannot** reuse the macro
pipeline. The Envelope Controller's persisted *definition* belongs in `graphState` (renderer), but
its *evaluation* must happen in the engine alongside the voices it modulates. This split is the
single most important constraint EVC.2+ must respect.

---

## 2. Current architecture map

Layer legend: **R** = renderer (Electron/React), **B** = bridge/IPC (Node-API addon + Electron
main/preload), **E** = C++ engine.

| Item | Layer | File | Current role |
|------|-------|------|--------------|
| `Sampler` | E | `engine/src/audio/Sampler.h/.cpp` | **Polyphonic pitched sample player with a full per-voice AHDSR.** `Voice` holds `EnvStage {Delay,Attack,Hold,Decay,Sustain,Release,Off}`, `envLevel`, `releaseStartLevel`, `envPosition`, `noteHeld`, plus voice identity (`spawnCounter`, `spawnAbsSample`). One Sampler per `{trackId, regionId}`. This is the existing per-voice envelope + per-voice gain precedent. |
| `Sampler::advanceEnvelope` | E | `engine/src/audio/Sampler.cpp` | Per-sample AHDSR evaluator (with tension curves). Returns the per-voice gain multiplier applied in `processVoice`. The literal "per-voice ADSR evaluator" EVC wants already exists here for pattern notes. |
| `MixEngine` | E | `engine/src/audio/MixEngine.h/.cpp` | Multi-track timeline mixer. Owns `samplers_` (`{trackId,regionId}→Sampler`), reconstructs active content per block, triggers notes, applies per-track volume/pan, runs effect chains, sums to master. The host for any future engine-side voice modulator. |
| `MixEngine::findActiveClips` | E | `MixEngine.cpp:3444` | Each block, rebuilds `activeClips_` by **overlap test** (`clipStart < bufEnd && clipEnd > bufStart`). Deterministic — does not depend on live trigger history. |
| `MixEngine::findActivePatternBlocks` | E | `MixEngine.cpp:3492` | Each block, rebuilds `activeBlocks_` (active `PatternBlock`s) and diffs against the previous block for voice cleanup. |
| `MixEngine::triggerPatternNotes` | E | `MixEngine.cpp:3597` | Converts notes in active blocks to sample-accurate `noteOn`/`noteOff`/`SlideStart` events **only when the note-on tick falls in the current buffer window**. This is the live-trigger path (seek-sensitive — see §5). |
| `MixEngine::processBlock` | E | `MixEngine.cpp:~3860` | Transport-stop and seek detection (`wasPlaying_`, `lastBufferEnd_`); on stop/seek fires `allNotesOff()` on every sampler. Per-track volume smoothing via `volumeSmoothed_[slot]`/`trackParams_[slot]`. |
| `Sampler::Voice::envLevel` | E | `Sampler.h:224` | The per-voice gain multiplier. **The recommended EVC v1 application point for pattern-note voices.** |
| `Clip` (`fadeIn/OutPercent`, bezier, `velocity`) | E | `engine/src/model/TimelineTypes.h:428` | Per-clip gain envelope (CSS cubic-bezier) + per-clip `velocity`. The per-clip gain precedent. Clips are not Sampler voices — they are direct buffer reads via `ClipRenderCache`/`ClipModulatedReader`. |
| `SampleRegion` AHDSR fields | E | `TimelineTypes.h:124` | `attackMs/decayMs/sustain/releaseMs/holdMs/...` — per-instrument (per-region) envelope settings copied into each Sampler. Shows the existing AHDSR field vocabulary EVC's data model should mirror. |
| `VideoFlipResolver::resolveStateIndex` | E | `engine/src/model/VideoFlipResolver.h/.cpp` | **Pure, deterministic, stateless** per-track state machine: given a `VideoFlipConfig` + ordered trigger events, returns one output per event. The determinism/reconstruction pattern EVC should imitate. |
| `VideoFlipApplier::applyTrack` | E | `engine/src/render/VideoFlipApplier.cpp` | Builds the ordered trigger-event list per track (chord detection, tie-break ordering) and feeds the resolver. The trigger-enumeration precedent for note/clip events. |
| `SyncManager` / `VideoEvent` | E | `engine/src/SyncManager.h` | Note/clip → `VideoEvent` list (with `trackId`, `pitch`, `startBeat`, `durationBeats`, `clipId`, `regionId`, `monoOrdinal`). The existing "notes & clips as an ordered event stream" representation. |
| `Transport` | E | `engine/src/Transport.h` | Sample-clock and position authority; `getRenderPositionSamples()` drives all engine reconstruction. |
| `TriggerQueue`/`VoiceManager` | E | `engine/src/TriggerQueue.h`, `VoiceManager.h` | **Legacy** lock-free drum-pad trigger ring + simple voice mixer (32 fixed voices, no ADSR). Used by the old transport path, not the per-region Sampler path. Not the EVC substrate; noted to avoid confusion. |
| `graphState` (per-track JSON) | R + persisted by E | `ui/src/fxgraph/graphState.js`; persisted opaquely in `TrackInfo::graphState` | Renderer-owned graph document. Engine stores it as opaque JSON (`hasGraphState`, `nlohmann::json graphState`) and never parses/executes it. The home for the persisted Envelope **node definition**. |
| Macro nodes + parameter edges | R | `ui/src/fxgraph/graphState.js`, `graphParameterTarget.js` | FXG.4-d…f control sources. Single normalized `0..1` value driving plugin params via IPC. **Not** per-voice. EVC must not reuse this output path. |
| Macro automation lanes/runtime | R | `ui/src/fxgraph/macroAutomation.js`, `macroAutomationPlayback.js` | FXG.4-h timeline automation. Renderer-side, control-rate, transport-polled. Demonstrates the renderer-side persistence + playback pattern, but is global/single-valued. |
| `effectChainStore` | R | `ui/src/stores/effectChainStore.js` | Owns `fxMode` gating, graph mutations, graph undo/redo, macro drive. Where future EVC store actions would live (gated `fxMode === 'graph'`). |
| `timeline.setTrackGraphState` | B | `ui/preload.js:136` → `xleth:timeline:setTrackGraphState` | The one renderer→engine channel that round-trips graphState with the project. The persistence path EVC node settings would ride (no new bridge API needed for persistence). |

---

## 3. Trigger source audit

### Timeline clips — start/end

`MixEngine::findActiveClips` (`MixEngine.cpp:3444`) recomputes the active clip set **every audio
block** by testing buffer overlap against each clip's `[position, position+duration)` in samples.
There is no "clip-start event" object and no live trigger history — a clip is simply *active* while
the playhead is inside it. **Consequence:** clip activity is already a pure function of transport
position, so it is inherently seek-deterministic. An envelope gated on clip start/end can compute
its phase at any position as `elapsed = playhead - clipStart`.

### Pattern notes — start/end

`MixEngine::triggerPatternNotes` (`MixEngine.cpp:3597`) walks the notes of each active
`PatternBlock`, computes absolute note-on/note-off ticks (accounting for block offset and loop
iteration), and emits sample-accurate `noteOn`/`noteOff` into the per-`{trackId,regionId}` Sampler
**only when the event tick lands inside the current buffer window**. The Sampler then owns the
voice for that note, including its AHDSR. **Consequence:** note voices exist only because a live
note-on fired in a buffer that the playhead passed through. A note already sounding at a seek
target is *not* reconstructed (see §5).

### Existing note/clip-triggered behavior (the reusable precedent)

**Video flip** is the canonical existing system that reacts deterministically to per-note/per-clip
triggers:

- `VideoFlipApplier::applyTrack` collects an **ordered, tie-broken trigger-event list** per track
  (chord grouping, `sourceTriggerOrder`/pitch/emission tie-breaks), then calls the **pure**
  `resolveStateIndex` once to assign a state to every event. `applyAll` groups events by `trackId`.
- The resolver is explicitly *stateless and deterministic* ("same inputs → same output, always; no
  globals, no caches"). It reconstructs the full per-event result from the whole event list, not
  from live playback — exactly the property EVC needs for seek determinism.
- The `VideoEvent` stream (`SyncManager.h`) already carries the fields a per-voice envelope would
  key on: `trackId`, `pitch`, `startBeat`, `durationBeats`, `clipId`, `regionId`, plus
  `monoOrdinal`/`globalNoteIndex` ordinals.

**Reusable concepts (do not implement yet):** (a) the per-track ordered trigger-event list with
stable tie-break ordering; (b) the pure resolver that derives state for *every* event from the full
list (reconstruction-friendly); (c) the clip-overlap test as a position-pure activity function.

---

## 4. Voice ownership audit

### What counts as a playback voice today

- **Pattern note voice:** a `Sampler::Voice` (`Sampler.h:196`). It carries the full envelope state
  machine and per-voice gain (`envLevel`), and is the real polyphonic voice. Up to `MAX_VOICES =
  32` per Sampler, one Sampler per `{trackId, regionId}`.
- **Clip "voice":** an `ActiveClip` entry (`MixEngine.h:820`) — really a per-block view of a clip
  buffer read. It has no envelope state machine; per-clip gain comes from `Clip::fadeIn/OutPercent`
  + bezier and `velocity`. There is no persistent runtime object per playing clip beyond the
  re-derived `activeClips_` list.

### Stable runtime identity

- Pattern voices have a runtime identity: `spawnCounter` (monotonic per Sampler) + `spawnAbsSample`
  (absolute transport sample at spawn). `releaseVoicesSpawnedInRange` already uses
  `spawnAbsSample` to target a specific block's voices. **This is the closest existing thing to a
  per-voice occurrence ID** — but it is Sampler-local and not exposed to the renderer.
- Clips have a persistent model id (`Clip::id`) but **no runtime per-occurrence identity** — each
  block re-derives `activeClips_` from scratch. A looping pattern block re-spawns voices each loop
  iteration with new `spawnCounter`s.

### What is missing for per-voice envelope ownership

1. A **voice occurrence key** that an engine-side envelope evaluator can use to bind one envelope
   instance to one playing note/clip, stable across blocks and reconstructable after a seek.
   Candidate composite (see §6): `(trackId, sourceKind, sourceId, onsetTick, loopIteration)`.
2. **Clips currently have no per-voice runtime object at all.** EVC for clip tracks needs either a
   lightweight per-active-clip envelope state keyed by the occurrence key, or to lean on the fact
   that clip activity is position-pure (compute envelope phase directly from `playhead - clipStart`,
   no stored state needed — preferred, see §7).
3. A **renderer→engine binding** that says "this graphState Envelope node modulates per-voice gain
   for the voices of *this* track," without sending per-voice data across IPC (voices are
   engine-only).

### Distinguishing overlapping notes/clips

- Overlapping **notes** (chord, or a long note overlapping the next): already distinct `Sampler`
  voices with distinct `spawnCounter`/`spawnAbsSample`. An engine envelope keyed per voice handles
  these for free — each voice's onset and release are independent.
- Overlapping **clips** on the same track: distinguished by `Clip::id` + onset sample. Because clip
  activity is position-pure, two overlapping clips yield two independent `elapsed` computations.
- **Different lanes/tracks** never share voices — voice pools are per `{trackId, regionId}`.

---

## 5. Seek/export determinism audit

### What happens on a mid-clip / mid-note seek today

`MixEngine::processBlock` detects a discontinuity (`lastBufferEnd_ >= 0 && bufStart !=
lastBufferEnd_`, `MixEngine.cpp:3949`) and fires `allNotesOff()` on every sampler, resets effect
chains, clears clip-modulation reader state. Then:

- **Clips:** the next block's `findActiveClips` re-derives activity from overlap, so a clip the
  seek landed inside resumes correctly mid-body. **Clips are already seek-deterministic.**
- **Pattern notes:** `triggerPatternNotes` only fires a note whose note-on tick is inside a buffer
  window the playhead *passes through*. After a seek **into the middle of a held note**, that
  note-on tick is in the past, so the voice is **never reconstructed** — the note is silent until
  the next note-on. This is the existing behavior and the exact failure mode the EVC spec warns
  about ("starting playback in the middle of a note must reconstruct correct envelope state instead
  of relying only on live trigger events that already happened").

### What envelope-state reconstruction would require

For a position `P` (seek target), the engine must be able to answer, **without** having observed
the triggers that preceded `P`:

1. **Which voices should be active at P?** For each track in graph mode with an Envelope node:
   enumerate notes/clips whose `[onset, release)` contains `P` (notes: walk the pattern with the
   same block-offset/loop math as `triggerPatternNotes`; clips: overlap test, already available).
2. **What is each active voice's envelope phase at P?** `phaseElapsed = P − onset`. If `P ≥
   releaseStart` (note/clip end), the voice is in its release segment with `releaseElapsed = P −
   releaseStart`; the AHDSR is evaluated forward from the segment boundaries to get `envLevel(P)`
   deterministically. Because AHDSR is a closed-form piecewise function of elapsed time (given the
   stage durations and the sustain level), `envLevel(P)` is computable directly — no need to replay
   intervening samples.
3. **Voice spawn at the seek target.** The engine would spawn the reconstructed voices with their
   envelope pre-advanced to the correct stage/level, rather than starting them at Attack=0.

This is feasible precisely because (a) clip activity is already position-pure and (b) AHDSR is
closed-form. The pattern-note path is the part that needs new reconstruction logic, since today it
is live-trigger-only.

### Risks if EVC only listens for live start events

- **Mid-note seeks produce wrong/zero envelope output** (the note that should be sustaining is
  absent). Matches the current "silent until next note-on" bug class but now also wrong gain.
- **Export/offline traversal** (`OfflineRenderer`) runs the same `processBlock` path; if export is
  ever started at a non-zero offset or uses a different block cadence, a live-trigger-only envelope
  would desync between preview and export. The mitigation is the same reconstruction logic, used
  uniformly by both realtime and offline paths.
- **Loop boundaries** re-spawn voices each iteration (new `spawnCounter`); an envelope keyed only
  on "first observed note-on" would mis-handle the second loop. Keying on
  `(onsetTick, loopIteration)` avoids this.

**Conclusion:** EVC must be designed reconstruction-first (compute active voices + envelope phase
from transport position), with live triggers as an optimization, not the source of truth.

---

## 6. Future EVC data model recommendation (graphState — recommendation only)

Persisted on the graph node inside `graphState`, alongside Macro nodes. **Do not implement in
EVC.1.** Shape proposed for EVC.2:

```jsonc
// node.type === 'envelope' (new graph-owned control node, sibling to 'macro')
{
  "id": "<graphState node id>",
  "type": "envelope",
  "position": { "x": 0, "y": 0 },
  "data": {
    "label": "Envelope 1",

    // AHDSR (internal model is AHDSR; UI may hide Hold for a simple ADSR view)
    "attackMs":  10.0,
    "holdMs":    0.0,
    "decayMs":   120.0,
    "sustain":   0.7,        // 0..1
    "releaseMs": 200.0,
    // optional tension/curve per segment, mirroring SampleRegion/ Sampler vocabulary
    "attackTension":  0.0,   // -1..+1
    "decayTension":   0.0,
    "releaseTension": 0.0,

    "amount":   1.0,         // 0..1 depth of the modulation applied to the target
    "voiceMode": "poly",     // "poly" (default) | "mono" (EVC.7)
    "maxVoices": 32,         // voice cap (>=1); engine clamps to Sampler MAX_VOICES

    // Trigger source: which parent-track events spawn envelope voices
    "triggerSource": {
      "kind": "parentTrack",         // bound to graphState.trackId (single source of truth)
      "events": "notesAndClips"      // "notes" | "clips" | "notesAndClips"
    },

    // Target: per-voice playback property. EVC v1 supports voiceGain only.
    "target": {
      "kind": "voiceGain"            // ONLY voiceGain in v1; reserved for future per-voice targets
    },

    // Future-only knobs, present but inert in v1:
    "monophonic": { "legato": false, "glideMs": 0.0 }  // EVC.7
  }
}
```

Rules to carry forward:

- `triggerSource.kind: "parentTrack"` binds to `graphState.trackId` — **never** store the parent
  track id redundantly (same single-source-of-truth rule as FXG.4-h macro automation lanes).
- `target.kind` is **not** a `GraphParameterTarget`. It is a closed enum of per-voice playback
  properties. v1 ships only `voiceGain`. No `effectInstanceId`, no `parameterId`, no engine node
  id ever appears on an Envelope node.
- Normalized/runtime values are never persisted (consistent with Macro/automation precedent).
- Old projects without the field load with no envelope nodes (`[]`-equivalent), exactly like the
  macro-automation `loadGraphState` upgrade path.

---

## 7. Future runtime design recommendation

### Where the per-voice ADSR evaluator should live

**In the C++ engine, in/next to `MixEngine`/`Sampler` — never in the renderer.** Justification:

- Per-voice state (which notes are sounding, their onsets, their release phase) exists only in the
  engine. The renderer has no voice objects.
- An AHDSR evaluator already exists for pattern voices: `Sampler::advanceEnvelope`. For pattern
  tracks, EVC's per-voice gain is most cleanly a **second per-voice gain stage multiplied into
  `processVoice`** (or a controlled modulation of `envLevel`), driven by the Envelope node's AHDSR
  parameters rather than the region's. This keeps one voice = one envelope instance automatically,
  with correct chord/overlap behavior and free voice cleanup.
- For clip tracks, per-voice gain is applied at the clip read/mix stage (where `Clip::fadeIn/Out`
  gain already applies), computed position-purely as `envLevel(playhead − clipStart)` — no stored
  per-voice object required.

### Why renderer-only global-parameter writing is rejected

The renderer macro pipeline emits **one** normalized value per macro per control tick and writes it
through `setGraphEffectParameterNormalized` to a **single** plugin parameter (FXG.4-a/e/f/h). It
has no per-voice dimension, runs at timeline/control rate (not audio rate), and would force all
simultaneous notes to share one value — which is precisely the "envelopes must not combine"
violation the product decision forbids. Faking per-voice behavior in React by writing global
parameter values is explicitly a non-goal (§11). It would also cross the renderer/engine ownership
boundary in the wrong direction.

### How per-voice gain is applied cleanly

- **Pattern notes:** multiply the EVC envelope's per-voice level into the voice's output gain in
  `Sampler::processVoice`, scaled by node `amount`. The voice already tracks onset
  (`spawnAbsSample`) and held/release state (`noteHeld`, `EnvStage`), so the EVC envelope can be
  advanced per-voice in lockstep with the existing envelope, or reconstructed from
  `spawnAbsSample`/release tick on seek.
- **Clips:** fold an `envLevel(elapsed)` factor into the per-clip gain already applied during
  `activeClips_` mixing. Because activity and elapsed are position-pure, this is automatically seek-
  and export-deterministic.

### Voice cleanup after release

Reuse the existing lifecycle: a voice frees when its release segment completes (`EnvStage::Off`).
For pattern voices this is already handled by the Sampler (`releaseVoicesSpawnedInRange`,
`allNotesOff` on stop/seek). An EVC envelope bound to a voice should be torn down with that voice.
Clip envelopes need no teardown — they evaporate when the clip stops overlapping.

### Max voice limits

Honor `data.maxVoices`, clamped to `Sampler::MAX_VOICES (32)`. The Sampler already steals the
oldest voice when full (`findFreeVoice`); EVC should adopt the same steal policy so the gain
envelope and the sample voice are stolen together (no orphaned envelope). Mono mode (EVC.7) caps
effective polyphony to 1 with legato/glide, reusing the Sampler's existing mono path concepts.

---

## 8. Phase split recommendation after audit

The audit suggests one adjustment to the proposed sequence: insert an explicit **engine voice
identity / reconstruction** phase before the runtime, because pattern-note voices are currently
live-trigger-only and that is the largest technical gap. Recommended order:

| Phase | Scope |
|-------|-------|
| **EVC.2** | graphState schema: `type: 'envelope'` node + `normalizeEnvelopeNode` in `loadGraphState`, persistence round-trip, undo/redo participation. Renderer-only, inert. |
| **EVC.3** | Envelope node UI in the FX Graph (AHDSR controls, amount, voice mode, trigger-source/target selectors). Visual only; no runtime. Tokenized styling, no hardcoded colors. |
| **EVC.4** | Trigger/voice event contract: define the engine-side voice occurrence key `(trackId, sourceKind, sourceId, onsetTick, loopIteration)` and the position-pure enumeration of active voices for notes (mirroring `triggerPatternNotes` math) and clips (overlap). Pure/testable, no audio yet. |
| **EVC.4b (new)** | Seek/reconstruction: engine can compute the active voice set + per-voice envelope phase at any transport position, used by both realtime and offline paths. This is the high-risk piece; isolating it de-risks EVC.5. |
| **EVC.5** | Per-voice ADSR runtime in the engine (evaluate AHDSR per voice; bind one envelope per voice; honor `maxVoices`, steal policy, cleanup). No target application yet (or behind a flag). |
| **EVC.6** | Per-voice gain target: apply the envelope to pattern-voice gain (`Sampler::processVoice`) and clip gain (`activeClips_` mix). The first audible EVC behavior. |
| **EVC.7** | Monophonic mode option (legato/glide), reusing Sampler mono concepts. |
| **EVC.8** | Polish, performance hardening for dense chords, tests, docs cross-link. |

Rationale for the change: EVC.4b is split out because mid-note seek reconstruction is new work with
no current equivalent on the pattern path, and conflating it with the live-runtime in EVC.5 would
make both harder to test.

---

## 9. Risk register

| Risk | Description | Mitigation direction |
|------|-------------|----------------------|
| **Fake global parameter modulation** | Tempting to reuse the working macro→parameter→IPC pipeline (FXG.4-a/e/f/h) because it already drives parameters. It is global/single-valued and cannot represent per-voice state; using it silently violates "envelopes must not combine." | Hard rule: EVC output never touches `GraphParameterTarget`, `setGraphEffectParameterNormalized`, or any exposed plugin parameter in v1. Target enum is per-voice playback properties only. |
| **Seek desync** | Pattern notes are live-trigger-only; a mid-note seek leaves the voice (and its envelope) absent or at the wrong phase. Export starting at an offset would diverge from preview. | Reconstruction-first design (EVC.4b): compute active voices + closed-form AHDSR phase from transport position; same path for realtime and offline. |
| **Voice identity ambiguity** | No renderer-visible per-voice occurrence id today; `spawnCounter`/`spawnAbsSample` are Sampler-local; loops re-spawn voices. | Define a stable occurrence key including `onsetTick` + `loopIteration`; keep it engine-internal; never serialize it. |
| **Dense-note performance** | Chords/overlapping clips multiply voice count; per-sample AHDSR per voice in `processVoice` plus reconstruction scans could spike CPU. | Reuse Sampler's `MAX_VOICES=32` cap and steal policy; honor `maxVoices`; keep AHDSR closed-form; benchmark in EVC.8 against the audio-performance telemetry already in `MixEngine`. |
| **Renderer/engine ownership confusion** | Definition lives in renderer `graphState`; evaluation must live in engine. Mixing them (e.g., evaluating in JS) reintroduces the global-value trap. | Document the split (this audit §1); persisted node = renderer; evaluator = engine; only the node *definition* crosses IPC, never per-voice values. |
| **Accidental Mixer Chain / effectChains mutation** | EVC work sits near the effect-chain/graph runtime; an errant write could corrupt chain mode. | EVC touches voice gain in Sampler/clip-mix only; never calls `addEffect/moveEffect`/`effectChains`; gated on `fxMode === 'graph'` in the store. |
| **Old NodeEditor / nodeGraphStore contamination** | Quarantined `NodeEditor.jsx` and unused `nodeGraphStore.js` could be revived by reflex. | Keep both excluded (asserted by `windowingScaffolding.test.tsx`); EVC nodes use the active `graphState.js`/`effectChainStore.js` path only. |
| **Target leakage to clips' DSP** | Applying voice gain in the wrong stage could double-apply with existing `Clip` fades or region ADSR. | Define a single, explicit application point per source kind (Sampler voice gain for notes; clip-mix gain for clips); multiply EVC `amount` once. |

---

## 10. Test strategy

### Existing tests to extend later

| Test | Location | Relevance |
|------|----------|-----------|
| `test_sampler.cpp` | `engine/test/` | Per-voice envelope + slide/voice-state introspection. Extend for EVC per-voice gain on pattern voices and reconstruction. |
| `test_mix.cpp` | `engine/test/` | MixEngine playback/active-clip/active-block behavior. Extend for clip-gain envelope and seek behavior. |
| `test_flip_determinism.cpp`, `test_video_flip_resolver.cpp`, `test_video_flip_applier.cpp` | `engine/test/` | The determinism/reconstruction precedent. Model EVC reconstruction tests on these. |
| `test_offline_render.cpp` / `test_real_render.cpp` | `engine/test/` | Offline/export traversal. Extend to assert preview/export envelope parity. |
| `test_timeline.cpp`, `test_project.cpp`, `test_undo.cpp` | `engine/test/` | Timeline model, project round-trip, undo. Extend for graphState envelope persistence (engine stores it opaquely). |
| `graphState.test.js` | `ui/src/fxgraph/` | graphState normalization/mutation. Extend with `normalizeEnvelopeNode`, node add/remove, undo. |
| `macroAutomation.test.js`, `macroAutomationPlayback.test.js` | `ui/src/fxgraph/` | Renderer persistence + playback patterns to mirror (NOT to reuse for output). |

### Recommended future test cases

- **Single long note** — one voice, full AHDSR, correct sustain hold and release tail.
- **Short note** — note shorter than attack+hold; envelope enters release before reaching sustain;
  no click.
- **Chord** — N simultaneous notes ⇒ N independent envelopes, identical shape, no averaging/summing.
- **Overlapping clips** — two clips overlapping on one track each get an independent position-pure
  envelope.
- **Playback started mid-clip** — clip envelope phase equals `playhead − clipStart` (deterministic).
- **Playback started mid-note** — held note's voice is reconstructed with envelope pre-advanced to
  the correct stage/level (the new EVC.4b behavior).
- **Release tail cleanup** — voice + its envelope free together at `EnvStage::Off`; no orphaned
  envelope, no stuck gain.
- **Max voice cap** — exceeding `maxVoices`/`MAX_VOICES` steals oldest voice *and* its envelope
  together.
- **Graph mode only** — envelope active only when `fxMode === 'graph'` on a normal track.
- **Chain mode untouched** — chain-mode tracks, master track, and `effectChains` produce byte-for-
  byte identical audio with EVC code present but unused.

---

## 11. Explicit non-goals (EVC v1)

- No exposed plugin-parameter control.
- No `GraphParameterTarget` usage for voice output.
- No global parameter aggregation / shared-output adapter.
- No faking per-voice behavior via renderer global parameter writes.
- No drawable envelope / MSEG.
- No LFO implementation.
- No direct plugin automation clips.
- No graph-to-chain return.
- No Mixer Chain mutation.
- No `effectChains` mutation.
- No React Flow.
- No `NodeEditor.jsx` revival; no `nodeGraphStore.js` usage.

---

## Appendix — key file references

- `engine/src/audio/Sampler.h` — per-voice AHDSR (`Voice::EnvStage`, `envLevel`, `spawnCounter`,
  `spawnAbsSample`); `advanceEnvelope`.
- `engine/src/audio/MixEngine.cpp` — `findActiveClips` (3444), `findActivePatternBlocks` (3492),
  `triggerPatternNotes` (3597), seek/stop handling (~3860–3957).
- `engine/src/model/TimelineTypes.h` — `Clip` (per-clip fade/velocity), `SampleRegion` (AHDSR),
  `PatternNote`/`Pattern`/`PatternBlock`, `TrackInfo` (`fxMode`, opaque `graphState`).
- `engine/src/model/VideoFlipResolver.h/.cpp`, `engine/src/render/VideoFlipApplier.cpp`,
  `engine/src/SyncManager.h` — deterministic per-track trigger-event resolution precedent.
- `ui/src/fxgraph/graphState.js`, `graphParameterTarget.js`, `macroAutomation.js` — renderer graph
  model (definition home; output path explicitly NOT reused).
- `ui/preload.js:136` — `timeline.setTrackGraphState` persistence channel.
- `docs/dev/fxgraph-architecture.md` — FX Graph data-model/ownership reference (FXG.4 series).
