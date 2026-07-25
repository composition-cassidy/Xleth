# Envelope Controller — engine-side evaluation (EVC-E)

Moves the FX Graph Envelope Controller's evaluation out of the renderer and into the
engine, on the authoritative transport clock, and deletes the renderer evaluator so
there is exactly one.

Supersedes the runtime half of EVC-R2 / EVC-R2-r1 / EVC-R2-r2 / EVC-R2-r3. The
persisted schema (EVC-R1 / EVC-R4) and the node UI (EVC-R3) are unchanged.

---

## 1. What the EVC-R0 revert was, and how this design accounts for it

**The revert.** `a550192 "EVC-R0 retire per-voice envelope branch"` removed
`EnvelopeVoiceEvents`, `EnvelopeAhdsr`, `EnvelopeRuntime`, their four `test_envelope_*`
targets, and the Sampler/MixEngine voice-gain hooks — 3,922 deleted lines.

**The reason, in the commit's own words:** the retired direction was the *per-voice
`voiceGain`* Envelope Controller. The commit states the corrected target explicitly:

> The Envelope Controller will instead be a graph-owned parameter-modulation source like
> Macro/LFO (parameter edges -> GraphParameterTarget -> exposed effect parameter),
> implemented in EVC-R1/R2.

So the revert was about **what the envelope modulates**, not about **where it is
evaluated**. That distinction is the whole basis of this workstream, and it is worth
being precise about because the two are easy to conflate:

| Question | EVC-R0's answer | This workstream |
|---|---|---|
| Target? | per-voice `voiceGain` — **rejected** | graph-owned effect parameter via the parameter edge — the corrected target |
| Evaluated where? | engine | engine |
| Output shape? | one value **per voice** — **rejected** | **one value per Envelope node**; overlapping notes/clips collapse into gate regions |

The audit's own central finding (§1) argues *for* engine-side evaluation, not against it:
"the persisted *definition* belongs in `graphState` (renderer), but its *evaluation* must
happen in the engine". EVC-R2 then put evaluation in the renderer anyway — not because
the audit changed its mind, but because the renderer was where the corrected
*parameter-edge* plumbing already existed.

**The revert reason therefore does not stand against this change, and nothing reverted is
resurrected.** Concretely, this workstream:

- **Does not** revive any retired file. `EnvelopeVoiceEvents` / `EnvelopeAhdsr` /
  `EnvelopeRuntime` stay deleted; the new module is
  `engine/src/model/EnvelopeParameterModulation.{h,cpp}` and shares no code with them.
- **Does not** reintroduce per-voice state. There is no voice occurrence key, no
  `maxVoices`, no steal policy, no `spawnCounter`, no Sampler involvement. One Envelope
  node produces one scalar, exactly as EVC-R2 did.
- **Does not** touch `Sampler::processVoice`, `envLevel`, or clip-mix gain — the three
  application points EVC-R0 unwound.
- **Keeps** the corrected target: `GraphParameterTarget` → exposed effect parameter,
  through the same stable `effectInstanceId` the FXG.4-a write path uses.

What was ported from the reverted branch is only the *shape of an idea* the revert never
disputed — that AHDSR is closed-form and therefore reconstructable from position alone.
That idea is re-derived here from the renderer evaluator being replaced, so the semantics
match what shipped, not what was retired.

One thing the retired branch got right and EVC-R2 lost: the retired
`EnvelopeVoiceEvents` mirrored `triggerPatternNotes`' onset/gate/loop math. The renderer
evaluator re-implemented that math independently and drifted (see §4). The new module
mirrors the engine math again — deliberately.

---

## 2. Architecture

```
                    message thread                    audio thread              applier thread
                    ─────────────                     ────────────              ──────────────
graphState  ──▶ refreshEnvelopeDefinitions()
(persisted,       ├─ parseGraphStateEnvelopes()
 opaque)          ├─ buildTrackGateIntervals()  ─┐
Timeline    ──▶   ├─ buildRoutePlan() (mute/solo)│
                  └─ publish immutable snapshot ─┴──▶ evaluateEnvelopeModulation()
                                                       ├─ ADSR at transport sample
                                                       ├─ clamp(base + depth·env)
                                                       └─ store to mailbox ────▶ applyPendingEnvelopeModulation()
                                                                                   └─ value-only parameter write
```

**Zero new bridge surface.** `graphState` already crosses via
`timeline.setTrackGraphState`; the engine now parses the copy it was already storing.
No new RPC, no preload change, no manifest entry.

### Files

| File | Role |
|---|---|
`engine/src/model/EnvelopeParameterModulation.{h,cpp}` | the whole evaluator: schema parse, gate merge, ADSR, mapping, gate derivation from Timeline, snapshot build
`engine/src/audio/MixEngine.{h,cpp}` | snapshot publication (RCU), audio-thread evaluation, applier, value-only write
`engine/src/commands/UndoManager.{h,cpp}` | `setPostMutationHook()` — the single complete refresh trigger
`engine/src/XlethEngineService.cpp` | installs the hook; refreshes on `setTrackGraphState` / `setTrackFxMode`

---

## 3. The definition-refresh mechanism, and why it is audio-thread-safe

### When it runs

| Trigger | Path |
|---|---|
Any timeline mutation, and undo/redo | `UndoManager` post-mutation hook → `refreshEnvelopeDefinitions()`
`timeline_setTrackGraphState` | explicit call (not undo-tracked)
`timeline_setTrackFxMode` | explicit call (not undo-tracked)
Project load, track add/remove | `setTimeline()` / `syncMixerTrackSlots()` → `syncTrackSlotsFromTimeline()` → refresh

Hooking `UndoManager` rather than each mutation handler is what makes gate coverage
*complete*: every timeline mutation goes through it by project invariant, so notes,
pattern blocks, clips, mute and solo are all covered, and a future command type is
covered without touching the wiring. Per-handler wiring would have been a list that
silently goes stale. **Never per-block.**

### Why the audio thread is safe

Publication is an epoch-based RCU. Not a lock, not a "probably long enough" ring.

1. The audio thread bumps `envelopeAudioEpoch_` at the **start** of every block, *before*
   loading the snapshot pointer, and holds `envelopeAudioInBlock_` for exactly as long as
   the pointer is live in that frame.
2. It loads `envelopeSnapshotLive_` **once** into a local (acquire), so it can never
   observe a half-published snapshot.
3. The message thread stores the new pointer (release), then retires the old `shared_ptr`
   *together with* the epoch observed at publication.
4. A retired snapshot is destroyed only when the audio epoch has moved **past** that
   value — proving the audio thread has entered a block that started after the store, so
   it cannot still hold the old pointer — **or** when no thread is inside the evaluator at
   all, which is sound because the store already happened, so any thread entering
   afterwards can only load the new pointer. (That second clause is what stops retired
   snapshots piling up when there is no audio device, e.g. in offline tests.)

Consequences, which are the actual invariants:

- **No allocation on the audio thread.** Mailboxes live *inside* the snapshot
  (`unique_ptr<EnvelopeMailbox[]>`), so their lifetime *is* the snapshot's lifetime —
  which removes the separate-array lifetime problem rather than managing it. Gate regions
  are pre-merged into flat vectors and read through a non-owning view. Nothing is sized
  or resized during a block.
- **No locks on the audio thread.** `envelopeSnapshotMutex_` is only ever taken by the
  message and applier threads. The audio thread touches atomics only.
- **No logging on the audio thread.** `evaluateEnvelopeModulation` is `noexcept` and
  contains no I/O.
- **No frees on the audio thread.** Destruction always happens on the message thread, on
  the next refresh.
- **Bounded work.** Gate resolution is a binary search over merged regions plus a scan of
  one region's onsets; the mapping is fixed arithmetic (bezier is a fixed 32 iterations).

`test_envelope_modulation_engine` §11 hammers 400 snapshot swaps against a concurrently
rendering thread and asserts no bad value is ever published.

### The one deliberate compromise, stated plainly

Evaluation is sample-accurate on the audio thread. **Application is not on the audio
thread**, and cannot be: `AudioGraph::setGraphEffectParameterNormalized` goes through
`juce::RangedAudioParameter::setValueNotifyingHost`, `XlethEffectBase::setParameterValue`
(documented "main-thread only"), SEH-guarded plugin calls for VST3, and a possible
`rebuildImmediate()`. None of that is realtime-safe, for stock effects or plugins.

So the audio thread publishes into a lock-free mailbox and a dedicated engine-owned
applier thread performs the write. What this does and does not buy:

- **Fixed:** the phase is now derived from the real render position, so play-start, loop
  wrap, seek and stop are all correct by construction, and the gates are the engine's own.
  This is the entire bug class in §4.
- **Not fixed:** the parameter *reaches* the effect at applier rate (≈1 ms while moving,
  10 ms idle), not per sample. A future refinement could shorten the last hop for stock
  effects whose parameters are smoother-backed by writing the raw APVTS atomic from the
  audio thread; that needs a per-effect audit of `onParameterValueChanged` and is
  deliberately out of scope here. VST3 targets cannot take that path at all.

The applier is engine-owned, so even the un-shortened hop removes four IPC layers and the
renderer round-trip entirely.

---

## 4. Before / after sync behavior

| Behavior | Renderer drive (EVC-R2-r3) | Engine evaluation |
|---|---|---|
Clock source | `PlayheadClock` wall-clock estimate, re-anchored by a 250 ms poll with a ±30 ms deadband | `Transport::getRenderPositionSamples()` — the position being rendered |
Play press | dead for up to ~250 ms until the first poll anchors | correct on the **first rendered sample** (§6) |
Steady-state phase error | permanent ±30 ms (the deadband) | none — position *is* the input |
Loop wrap | over-ran by up to ~217 ms | cannot over-run: evaluation is a pure function of position (§7) |
Drive rate | ~38 Hz effective, degrading with each added link | per audio block; independent of link count |
Seek into a held note | renderer reconstruction disagreed with the engine | gate derived from the engine's own note math (§8) |
Note-off timing | gate ran past the block end — **the renderer omitted `absNoteOff = min(onset + dur, blockEnd)`**, so the envelope released later than the note | block-end clamp applied (§1) |
Slide notes | renderer-tagged reconstruction | engine's `isSlide`, opt-in preserved (§3) |
Mute / solo | not modelled | `xleth::buildRoutePlan` closure — the same one the mixer applies (§5) |
Stop | EVC-R4 release to base, via IPC after the poll noticed | release published on the stop transition, in the same block (§9) |
Evaluators | two (renderer + none in engine) | **one** |

Section numbers refer to `engine/test/test_envelope_modulation_engine.cpp`.

The note-off clamp is worth calling out: it is a behavior *fix*, not just a re-hosting.
The renderer emitted `endTick: startTick + dur` with no block-end clamp, so any note whose
duration reached past its pattern block kept the envelope gate open after the engine had
already fired note-off.

---

## 5. Stage durations stay in milliseconds

`attackMs` / `holdMs` / `decayMs` / `releaseMs` are authored in **milliseconds** and are
converted straight to samples in `envelopeShapeToSamples()`. Tempo is not an input to any
evaluator, so a tempo change never rescales an envelope — the same net semantic the
renderer had (it converted ms→ticks via bpm, then compared against tick positions, which
cancels out), reached without the double conversion and its quantization.

**Where a future tempo-sync option would hook in:** add a unit discriminant to
`EnvelopeShape` (e.g. `attackUnit: 'ms' | 'beats'`) and resolve it in
`envelopeShapeToSamples()`, which is the single place the unit domain is interpreted. The
evaluators take samples and must not learn about bpm. Not built.

---

## 6. Renderer removal

Deleted outright:

- `ui/src/fxgraph/envelopePlayback.js` + `.test.js` — the drive controller, the
  transport-lifecycle subscription, the 60 Hz `onFrame` drive, the latest-wins in-flight
  discipline, the stop release, and the renderer note reconstruction.
- `ui/src/fxgraph/envelopeModulation.js` + `.test.js` — the renderer ADSR evaluator, gate
  merge and trigger inference. Its only consumers were the two removed drive paths.
- `effectChainStore.js`: `applyEnvelopeModulationAtTick`, `driveEnvelopeParameterEdges`,
  `envelopeRuntimeLastValues` / `envelopeRuntimeKey` / `clearEnvelopeRuntimeCache`,
  `resetEnvelopeModulationRuntime`, and the hydration-time cache clear.
- `TimelineView.jsx`: the `startEnvelopePlayback` mount and `envelopeTriggerDataRef`.
- The corresponding drive tests in `effectChainStore.test.js` and two now-unused fixtures.

No flag was used: the engine path is the only path, so there is nothing to stage or to
default. Two evaluators never coexisted.

Kept deliberately:

- The persisted schema and node UI (`normalizeEnvelopeNodeData`, `addGraphEnvelopeNode`,
  `updateGraphEnvelopeNodeData`, `connectEnvelopeToParameter`,
  `captureEnvelopeModulationBase`, `EnvelopeEditor.tsx`) — authoring, not runtime.
- `collectEnvelopeParameterWrites` in `graphState.js`, now with no runtime consumer, as
  the renderer-side executable specification of the edge skip semantics
  (`disabled` / `invalid_target` / `missing_node` / `missing_effect_instance` /
  `missing_exposed_port` / `read_only`) and the base+depth mapping that
  `parseGraphStateEnvelopes` mirrors. Its tests are the parity reference for the port. Its
  doc comment says so, so it is not wired back into a drive.

---

## 7. Value-only parameter writes

`Audio_SetGraphEffectParameterNormalized` called `refreshLivePresentationLatency()` — and
therefore `syncSidechainTargetBuses()` — and set `pendingLatencyCompensationReset_` on
**every** write. Affordable for a user turning a knob; not for a continuous modulation
source.

`MixEngine::setGraphEffectParameterNormalizedValueOnly()` is the applier's path. It
compares the chain's **latency epoch** across the write and requests the PDC reset only
when the parameter actually moved the effect's reported latency. This is not "skip the
reset and hope": a write that changed no latency needs no PDC work, so the skip is the
accurate amount of work rather than a traded-away correctness guarantee.

The user-driven RPC path is unchanged.

---

## 8. Tests

| Target | Coverage |
|---|---|
`test_envelope_parameter_modulation` (new, 179 checks) | shape normalization and clamps; ms→samples; every ADSR stage incl. zero-duration safety and release-from-actual-level; gate merge, chord collapse, abutting-vs-overlapping regions, restart retrigger; gate resolution in the sample domain incl. a 200-region binary-search cross-check; base + signed depth, negative depth, both clamp rails, source window, degenerate window, bezier monotonicity; graphState parse + all six skip reasons; the legacy range→modulation migration incl. inverted ranges, the retired `amount` fold, and its idempotence; stop-rests-at-base
`test_envelope_modulation_engine` (new, 88 checks) | gate derivation from a real Timeline with the engine's note math and the block-end clamp; block offset; region-less patterns; chords; looped and loop-disabled blocks; slide notes both ways incl. the slide-only-track inference trap; clip gates and overlap; snapshot construction (chain mode inert, graph mode picked up, mute, solo elsewhere, self-solo, disabled-edge-only envelopes dropped); play-start on the first sample; loop wrap; seek into a held note; stop rests at the authored base; base+depth through `processBlock` incl. negative depth and both rails and a sample-accurate attack traversal; live refresh + 400 concurrent snapshot swaps

Both are registered in `XLETH_ENGINE_TESTS`, so `ctest` runs them.
