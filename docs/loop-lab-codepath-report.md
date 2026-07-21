# Loop Lab — Sampler Loop/Crossfade Codepath Audit & Integration Plan

**Audience:** an engineer with zero prior context on XLETH's sampler internals who
must build (or extend) the Loop Lab dev panel and trust that its audible preview
is behaviourally identical to what the real sampler produces.

**Bottom line up front:**

1. The loop crossfade is **not a pre-baked buffer**. It is computed **live, per
   sample, inside `Sampler::processVoice`** as an equal-power (cos/sin) blend at
   read time. "Preview parity" therefore means *routing audio through
   `Sampler::processVoice`* — nothing in the UI may re-implement the blend.
2. XLETH already has a first-class **"preview a region through the real sampler"**
   path (`previewSamplers_` + `timeline_previewNote/…NoteOff`). It reads loop and
   crossfade parameters straight off the `SampleRegion`, plays through the exact
   `processVoice` code, and is audible whenever the transport is stopped.
3. `SampleRegion`s are **track-independent**. A region can be created, mapped to
   decoded audio, configured, and auditioned **without any track, pattern, or
   pattern-block**.
4. Consequence: **Loop Lab needs zero new C++ and zero new bridge methods.** It
   composes existing, manifest-wired RPCs. This is the chosen integration
   approach (details in §5).
5. **One correctness trap** dominates the export design: loop indices are in the
   *engine-buffer* sample domain (`bufferSampleRate`, e.g. 48 kHz), **not** the
   original file's rate. The exported dataset must reconcile this (§6).

---

## 1. Where loop/crossfade parameters live and how they reach the engine

### The data model — `SampleRegion`

Loop and crossfade settings are **per-`SampleRegion`** (i.e. per-instrument), not
per-note and not per-track. Every pattern/track that binds to a region shares one
sampler and one set of settings. The fields that matter to Loop Lab:

| Field | Meaning | Domain |
|---|---|---|
| `loopEnabled` | loop on/off | bool |
| `loopStart` | loop start | **engine-buffer samples** |
| `loopEnd` | loop end (0 ⇒ end of sample) | **engine-buffer samples** |
| `crossfadeEnabled` | one-shot (false) vs sustained/looping (true) | bool |
| `crossfadeSamples` | FL-style loop crossfade width (0 = off) | **engine-buffer samples** |
| `smpStart` / `smpLength` | trim window | engine-buffer samples |
| `declickMs` | Hann fade width at trim edges (default 1.5 ms) | ms |
| `rootNote` | pitch of the loaded sample | MIDI note |

`SampleRegion` is declared in `engine/src/model/TimelineTypes.h`; JSON
serialization in `engine/src/model/SampleRegion.{h,cpp}`.

### The setter path (main thread → region → sampler rebuild)

`timeline_updateSamplerSettings(regionId, settings)` is the single entry point
for changing any of the above. Handler:
`Timeline_UpdateSamplerSettings` — `engine/src/XlethEngineService.cpp:9156`.

It merges a **partial** settings object onto the region's current values (so you
can send just `{loopStart, loopEnd, crossfadeSamples}`), executes a
`SetSamplerSettingsCommand` (undoable), then calls **`refreshSamplerForRegion`**
(`XlethEngineService.cpp:871`). That refresh does two things:

- `mix.ensurePreviewSampler(regionId)` — rebuilds the **preview** sampler.
- `mix.rebuildAllSamplers()` — rebuilds every `{trackId, regionId}` **playback**
  sampler that binds the region.

So the preview sampler and the playback sampler are **built from the same region
fields by nearly identical code** — this is what guarantees parity (§4).

Relevant accepted keys (from `Timeline_UpdateSamplerSettings`,
`XlethEngineService.cpp:9291`–`9310`):
`loopEnabled, loopStart, loopEnd, crossfadeEnabled, crossfadeSamples,
smpStart, smpLength, declickMs, fadeInMs, fadeOutMs, rootNote, …`.

---

## 2. How the loop buffer is "produced" — it isn't; the crossfade is live

There is **no separate baked loop buffer**. `Sampler::loadSample`
(`engine/src/audio/Sampler.cpp:11`) just `makeCopyOf`s the decoded audio into
`sampleData_` and records `sourceSampleRate_` and `rootNote_`. The loop and
crossfade are applied at playback time.

### `Sampler::processVoice` — the real loop/crossfade math

`engine/src/audio/Sampler.cpp:859`. Per voice, per output sample:

**Effective loop bounds & crossfade width** (`Sampler.cpp:890`–`910`):
```cpp
const int64_t effLoopEnd   = (loopEnd_ > 0) ? min(loopEnd_, nFrames) : nFrames;
const int64_t effLoopStart = min(loopStart_, effLoopEnd);
const bool    useLoop      = crossfadeEnabled_ && loopEnabled_ && effLoopEnd > effLoopStart;

int64_t effXfade = 0;
if (useLoop && crossfadeSamples_ > 0) {
    effXfade = crossfadeSamples_;
    effXfade = min(effXfade, (effLoopEnd - effLoopStart) / 2);   // ends can't overlap
    effXfade = min(effXfade, effLoopEnd - smpStart_);            // fade-out stays in trim
    effXfade = min(effXfade, clampedEnd - effLoopStart);         // fade-in stays in trim
    if (effXfade < 0) effXfade = 0;
}
const double xfadeStart = double(effLoopEnd - effXfade);
```

**Loop wrap** (`Sampler.cpp:1020`–`1030`) — note the "FL-style" wrap skips the
first `effXfade` samples on wrap so loop content isn't heard twice:
```cpp
if (v.playPosition >= double(effLoopEnd)) {
    const double over = v.playPosition - double(effLoopEnd);
    v.playPosition = double(effLoopStart + effXfade) + over;
}
```

**The crossfade blend itself** (`Sampler.cpp:1090`–`1130`) — equal-power cos/sin,
computed live, blending the current read against a second read `effXfade` before
the loop start:
```cpp
const bool inXfade = (effXfade > 0 && v.playPosition >= xfadeStart);
if (inXfade) {
    float progress = float((v.playPosition - xfadeStart) / double(effXfade));  // 0..1
    fadeOutX   = cosf(progress * kPi * 0.5f);
    fadeInX    = sinf(progress * kPi * 0.5f);
    loopSrcPos = double(effLoopStart) + (v.playPosition - xfadeStart);
}
// per channel:
float sample = readInterp(v.playPosition, srcCh);            // 4-pt cubic Hermite
if (inXfade) {
    float loopStartSample = readInterp(loopSrcPos, srcCh);
    sample = sample * fadeOutX + loopStartSample * fadeInX;  // ← THE crossfade
}
```

Trim edges also get a Hann-window declick (`Sampler.cpp:1055`–`1063`) via the
shared LUT in `engine/src/dsp/DeclickEnvelope.h`. Reads are 4-point cubic Hermite
(`readInterp`, `Sampler.cpp:915`).

**Continuous looping = a sustained held note.** If `loopEnabled && crossfadeEnabled`
and the envelope is holding (note held, not released), `processVoice` wraps at
`effLoopEnd` forever, so the seam cycles audibly on every pass. This is exactly
what Loop Lab's preview needs — hold one note, let it loop.

> **Not to be confused with `engine/src/audio/LoopTrap.h`.** That is the
> *transport master-clock* loop (the timeline loop/render region — a hard jump,
> Phase-1, may click). It is a **different feature** and is *not* on the sampler
> preview path. Ignore it for Loop Lab.

---

## 3. Where preview playback hooks in (audio thread)

### The preview-sampler map

`MixEngine` owns two sampler collections (`engine/src/audio/MixEngine.h`):
- `samplers_` keyed by `{trackId, regionId}` — timeline playback.
- `previewSamplers_` keyed by `regionId` (`MixEngine.h:953`) — audition.

Preview API (`MixEngine.h:165`–`169`):
`ensurePreviewSampler`, `unloadPreviewSampler`, `getPreviewSamplerPtr`,
`hasPreviewSampler`, `silenceAllPreviewSamplers`.

`MixEngine::ensurePreviewSampler` (`MixEngine.cpp:2337`) builds a `Sampler` from a
region using the **same sequence of setters** as the playback builder
`loadSamplerForTrackRegion` (`MixEngine.cpp:1775`) — including
`setLoopPoints / setCrossfadeMode / setCrossfadeSamples / setDeclickMs / loadSample`
and the same `SampleProcessor::applyFlags` pre-processing. (Diff them side by
side: the two functions are line-for-line equivalent in the loop/xfade path.)

### When preview audio is actually rendered

`MixEngine`'s render loop mixes preview samplers **only while the transport is
stopped** (`MixEngine.cpp:4112`–`4129`):
```cpp
if (!isPlaying) {
    previewBuffer_.clear(0, numSamples);
    const double previewBPM = transport.getBPM();
    for (auto& kv : previewSamplers_) {
        Sampler* s = kv.second.get();
        if (s && s->hasSample()) {
            s->setBPM(previewBPM);
            s->processBlock(previewBuffer_, numSamples, sampleRateForPreview);
        }
    }
    // summed into outputBuffer
}
```
On transport stop, held preview notes are released (`MixEngine.cpp:4095`), so
Loop Lab must not start playback in the timeline while auditioning (it wouldn't
anyway — it never touches the transport).

### The RPCs that drive preview notes

All in `engine/src/XlethEngineService.cpp`, all manifest-wired:

| RPC | Handler | Effect |
|---|---|---|
| `timeline_previewNote(regionId, pitch, velocity)` | `Timeline_PreviewNote` @ `:9946` | ensures preview sampler exists, `noteOn` |
| `timeline_previewNoteOff(regionId, pitch)` | `Timeline_PreviewNoteOff` @ `:9971` | `noteOff` (envelope release) |
| `timeline_previewAllNotesOff(regionId)` | `Timeline_PreviewAllNotesOff` @ `:9996` | `allNotesOff` (panic) |

`timeline_previewNote` first calls `ensurePreviewSampler` if absent, so a fresh
region auditions without extra setup.

---

## 4. Why this yields exact parity

The playback sampler (`loadSamplerForTrackRegion`) and the preview sampler
(`ensurePreviewSampler`) are built by the **same setters, in the same order, from
the same region fields, on the same `Sampler` class**, and both render through the
**same `Sampler::processBlock → processVoice`**. The only differences are:
- *when* they're summed (preview: transport stopped; playback: transport playing),
- *what buffer* they add into (both ultimately reach master).

The loop/crossfade/declick/interpolation math is identical because it lives in one
place (`processVoice`) that neither path forks. Therefore, auditioning a region's
gold loop through `timeline_previewNote` is behaviourally identical to how that
region will sound when a pattern plays it. **No UI-side crossfade math is required
or permitted.**

---

## 5. Chosen integration approach

> **Reuse the existing region preview infrastructure. Author each imported WAV as
> a track-independent `SampleRegion`, configure its gold loop via
> `timeline_updateSamplerSettings`, and audition via `timeline_previewNote`. No
> new engine code, no new bridge methods.**

### Why (justified by the code)

- **Parity for free.** The preview sampler *is* the sampler codepath (§4). Direct
  `Sampler` instantiation from JS would require a brand-new bridge surface that
  duplicates `ensurePreviewSampler`/`processBlock` plumbing and an audio-output
  route — more code, and a second thing to keep in sync with the real sampler
  (exactly the drift the task forbids).
- **Regions are cheap and track-free.** `Timeline_AddRegion`
  (`XlethEngineService.cpp:11017`) creates a region from `{name, audioFilePath?, …}`
  with no track. `ensurePreviewSampler(regionId)` only needs
  `timeline_->getRegion(regionId)` + `getSampleIdForRegion(regionId)` — no track,
  pattern, or block. Verified by reading both functions.
- **Decode + peaks already exist.** `audio_loadSourceRegion(filePath, 0, dur)`
  (`Audio_LoadSourceRegion` @ `:11293`) decodes a WAV via FFmpeg into the
  `SampleBank` and triggers waveform-mipmap generation; `audio_mapRegionToSample`
  (`:11272`) links region→sample slot.

### The end-to-end flow per imported WAV (all existing RPCs)

```
1. sampleId = window.xleth.audio.loadSourceRegion(filePath, 0, durationSec)
2. regionId = window.xleth.timeline.addRegion({ name, audioFilePath: filePath })
3. window.xleth.audio.mapRegionToSample(regionId, sampleId)
4. window.xleth.timeline.updateSamplerSettings(regionId, {
       loopEnabled: true, crossfadeEnabled: true,
       loopStart, loopEnd, crossfadeSamples, rootNote,
   })                       // debounced on edits
5. Preview:  window.xleth.timeline.previewNote(regionId, rootNote, 0.8)   // held → loops
   Stop:     window.xleth.timeline.previewNoteOff(regionId, rootNote)
             window.xleth.timeline.previewAllNotesOff(regionId)           // on unmount/panic
6. Waveform: window.xleth.waveform.getFilePeaks(filePath, 0, durationSec, pixels, channel)
```

Preload/manifest confirmation:
- `timeline.previewNote` — `ui/preload.js:202` (hand-written, default velocity 0.8).
- `timeline.previewNoteOff` / `previewAllNotesOff` — manifest
  (`ui/rpc-manifest.js:1152,1160`) → auto-attached.
- `timeline.addRegion` — manifest (`:960`).
- `timeline.updateSamplerSettings` — manifest (`:1032`).
- `audio.mapRegionToSample` / `audio.loadSourceRegion` — manifest (`:1205,1213`).
- `waveform.getFilePeaks` / `getRegionPeaks` / `getRawSamples` — `ui/preload.js:241`–`248`.

> **Runtime-verify each call.** The four-layer bridge swallows an undefined method
> via optional chaining. Before trusting the flow, log the actual resolved return
> of each call at runtime (e.g. confirm `loadSourceRegion` returns a real sample
> id ≥ 0 and `addRegion` a real region id ≥ 0), not just the TypeScript/JSDoc
> shape.

### Lifecycle / cleanup

Loop Lab's regions are scratch objects. On panel close (or app quit) call
`previewAllNotesOff` for every region, then delete each region
(`timeline_deleteRegion` / equivalent) so they don't leak into the user's project
or its undo stack. Because `addRegion` is undoable, consider that these regions
will appear in undo history — acceptable for a dev tool, but worth a note; if
undesirable, batch-create/destroy at panel open/close.

---

## 6. THE correctness trap: sample-rate domains (drives the export schema)

`SampleBank::loadSampleFromSource` **resamples the source to the engine rate**
before storing (`engine/src/SampleBank.h:29`, `:18`–`25`). So a `SampleInfo` has:
- `originalSampleRate` — the **file's** rate (e.g. 44 100).
- `bufferSampleRate` — the **stored** rate = engine rate (e.g. 48 000).
- `numSamples` — length **at `bufferSampleRate`**.

**Loop indices (`loopStart/loopEnd/crossfadeSamples`) index the stored buffer, so
they are in the `bufferSampleRate` domain — not the file's domain.** `processVoice`
reads them directly against `sampleData_` (which is the resampled buffer).

### Implication for the deliverable

The export must ship the **original untouched WAV** *and* a `dataset.json` whose
`gold_loop {start,end,xfade}`, `sample_rate`, and `num_samples` are **consistent
with that WAV**. If we naively wrote the engine-domain indices next to a 44.1 kHz
file, the downstream auto-optimizer would apply 48 kHz indices to a 44.1 kHz file
— wrong by the rate ratio.

### Required handling (implement in the export step)

Let `ratio = fileSampleRate / bufferSampleRate`.

- Copy the original WAV **byte-for-byte** (honours "untouched").
- Read the **file's** true `sample_rate`, `channels`, `num_samples` from the WAV
  header directly (in the Electron main process via `fs`), *not* from the engine's
  resampled `SampleInfo`.
- Convert each gold value to the file domain on export:
  `start_file = round(start_engine * ratio)`, likewise `end`, `xfade`.
- When `fileSampleRate == bufferSampleRate` (the common all-48 kHz corpus case)
  `ratio == 1` and the conversion is exact / a no-op.

**Recommended authoring convention** (keeps the UI simple and the export exact):
keep the panel's *canonical* gold loop state in the **file-sample domain** (this
is what the waveform time-axis and the exported dataset both use), and convert
**file → engine** only at the moment of calling `updateSamplerSettings` /
`previewNote`. Then:
- numeric fields, waveform handles, and `dataset.json` all agree (file domain);
- the only lossy step is the audible preview push, and only for off-rate files
  (sub-sample, inaudible; and the point of parity is the *codepath*, which is
  unchanged).

The waveform peaks API (`getFilePeaks`) addresses the file **by time in seconds**,
so it is rate-agnostic for display; place handles by
`x = (sample / fileSampleRate) / durationSec * width`.

### `dataset.json` entry (target schema)

```json
{
  "sample_id": "hard_tuned_vocal_ep12_0007",
  "file": "corpus/Hard-tuned vocal/hard_tuned_vocal_ep12_0007.wav",
  "class": "Hard-tuned vocal",
  "instrument_name": null,
  "behavior_family": "stable_periodic",
  "source": "ep12",
  "root_note": 60,
  "sample_rate": 44100,          // FILE rate (from WAV header)
  "channels": 2,                 // FILE channels
  "num_samples": 132300,         // FILE frame count
  "gold_loop": { "start": 22050, "end": 110250, "xfade": 441 },  // FILE-domain samples
  "measured_features": null      // placeholder for a later phase
}
```

`behavior_family` derivation (auto, with per-sample override):
- `Hard-tuned vocal` → `stable_periodic`
- `Natural vocal` → `vibrato_sustained`
- `Instrument` → by instrument name:
  `flute|organ|synth → stable_periodic`;
  `violin|viola|cello|sax|trumpet|brass → vibrato_sustained`;
  `piano|guitar|mallets → decaying_struck`.

---

## 7. File / symbol index (for the reader)

Engine:
- `engine/src/audio/Sampler.h` / `Sampler.cpp` — the sampler. Loop/xfade setters
  `Sampler.cpp:64,71,99`; the live crossfade in `processVoice` `Sampler.cpp:859`
  (blend `:1090`–`1130`, wrap `:1020`–`1030`, xfade clamps `:898`–`910`).
- `engine/src/audio/MixEngine.cpp` — `loadSamplerForTrackRegion:1775` (playback),
  `ensurePreviewSampler:2337` (preview), preview render `:4112`–`4129`.
- `engine/src/audio/MixEngine.h:165`–`169,953` — preview sampler API + map.
- `engine/src/XlethEngineService.cpp` — `Timeline_UpdateSamplerSettings:9156`,
  `refreshSamplerForRegion:871`, `Timeline_PreviewNote:9946`,
  `Timeline_PreviewNoteOff:9971`, `Timeline_PreviewAllNotesOff:9996`,
  `Timeline_AddRegion:11017`, `Audio_MapRegionToSample:11272`,
  `Audio_LoadSourceRegion:11293`.
- `engine/src/SampleBank.h` — resample/domain contract (`bufferSampleRate` vs
  `originalSampleRate`).
- `engine/src/dsp/DeclickEnvelope.h` — Hann declick LUT used by `processVoice`.
- `engine/src/audio/LoopTrap.h` — **transport** loop; *not* the sampler path.

Bridge / renderer:
- `ui/rpc-manifest.js` — method→handler wiring (`addRegion:960`,
  `updateSamplerSettings:1032`, `previewNoteOff:1152`, `previewAllNotesOff:1160`,
  `mapRegionToSample:1205`, `loadSourceRegion:1213`).
- `ui/preload.js` — `timeline.previewNote:202`; `waveform.*:241`–`248`;
  `audio.*` block from `:258`.

---

## 8. What Loop Lab must build (nothing below is in the engine yet)

Pure renderer/main-process work — **no C++**:
1. Dev-mode-gated floating panel (windowing store registration).
2. Batch WAV import → panel-local sample list (name/duration/rate/class badge),
   each backed by a scratch region via the §5 flow.
3. Canvas waveform (via `getFilePeaks`) with draggable loop-start/end handles,
   xfade control, sample-accurate numeric fields, zoom — **canvas draw calls
   only, no DOM overlays**.
4. Audible preview (spacebar) — held `previewNote`, debounced
   `updateSamplerSettings` on edits, `previewNoteOff` on stop.
5. Sticky metadata bar (class / instrument / source) persisted across restarts.
6. Auto-naming + `behavior_family` derivation with override.
7. ZIP export (original WAVs under `corpus/<class>/<instrument?>/<name>.wav` +
   `dataset.json`), with the §6 domain conversion.

Because there is no C++ change, `build.bat bridge-clean` is not required for
functionality; run it only if the audit turns out to need an engine tweak. The
mandatory verification is the **runtime console smoke test** (import → set loops →
audible preview → sticky-metadata auto-apply → export → inspect ZIP + parse
`dataset.json`).

---

## 9. Verification status & manual smoke test

**Implemented (commit `feat(loop-lab): …`).** Files:
`ui/src/components/loopLab/{LoopLab,LoopLabWaveform,LoopLabDevMount}.jsx`,
`loopLabMeta.js`, `loopLab.css`, `__tests__/*`;
`ui/electron-main/loopLabExport.js`; IPC in `ui/main.js`; wrappers in
`ui/preload.js`; DEV mount in `ui/src/XlethRoot.jsx`.

**Automatically verified (no audio needed):**
- `npm run build` (vite) clean — the whole Loop Lab module graph is statically
  imported by `XlethRoot`, so a clean build proves it all transforms/resolves.
- `npm run test` (vitest): full suite green except the 2 pre-existing mixer
  failures (`MasterStrip`, `MixerStrip.routing` — unrelated, untouched files).
- 20 dedicated Loop Lab unit tests pass, covering behaviour-family derivation,
  auto-naming, sticky-metadata persistence, WAV-header parsing, the
  engine→file **domain conversion** (identity + off-rate scaling + clamping),
  the full `dataset.json` schema/paths, id/name disambiguation, and a **real
  archiver ZIP round-trip**.
- No C++ changed → `build.bat bridge-clean` not required.

**Manual smoke test (audible part — run in the app, `npm run dev`):**
1. Bottom-left shows a **🔁 Loop Lab** launcher (DEV only). Click it.
2. Set the sticky bar: Class = *Hard-tuned vocal*, Source = `ep12`. Click
   **Import WAVs**, pick **3** WAVs. They appear named `hard_tuned_vocal_ep12_0001..3`.
3. Select each; drag the loop-start/end handles (or edit the numeric fields),
   set a crossfade width; press **Space** — the loop should audibly cycle
   continuously with the seam you hear updating as you edit (rebake is debounced).
   Wheel = zoom, drag empty = pan, **Fit** resets.
4. Change the sticky Class to *Instrument*, type Instrument = `flute`, import a
   **4th** WAV → it is named `flute_0004` and its behavior family auto-derives to
   `stable_periodic`; confirm the earlier three kept their vocal metadata.
5. Click **Export ZIP**, choose a path. Then verify on disk:
   ```
   unzip -l corpus.zip           # corpus/Hard-tuned vocal/*.wav, corpus/Instrument/flute/*.wav, dataset.json
   unzip -p corpus.zip dataset.json | python -m json.tool   # parses; one entry per sample matching the §6 schema
   ```
   Each `gold_loop {start,end,xfade}` is in the WAV's own sample domain, and the
   WAVs are byte-identical copies of the originals.
