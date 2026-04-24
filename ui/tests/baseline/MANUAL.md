# Phase 0 Baseline — Manual Capture Steps

Panels that cannot be reached programmatically by the automated Playwright suite.
For each: capture a screenshot manually, name it exactly as shown, and drop it into
`tests/baseline/snapshots/capture.spec.ts/`.

---

## 11-piano-roll.png

**Why it can't be automated:** The Piano Roll requires a Pattern track with at least one
pattern block. The app starts with an empty timeline (no tracks auto-populated in
Playwright mode), and creating a pattern programmatically requires a full IPC round-trip
through the JUCE backend that isn't scripted in the test suite.

**Manual steps:**
1. Launch the app normally (not via Playwright).
2. Click "Add Track" in the timeline → a Pattern track appears.
3. With the Pencil tool active, click on the timeline canvas to draw a pattern block.
4. Double-click the pattern block to open the Piano Roll.
5. Wait for the Piano Roll canvas to fully render.
6. Take a full screenshot of the `.center-area-body` element (or the entire center pane).
7. Save as `11-piano-roll.png`.

---

## 12-sampler-panel.png

**Why it can't be automated:** The Sampler panel only mounts when `samplerPanelRegionId`
is non-null, which requires a Pattern track whose current pattern has a region (a pitch
sample assignment). This requires imported media and a configured track — neither of which
exists in Playwright mode.

**Manual steps:**
1. Import an audio/video source via **Project Media → Import source**.
2. Add a Pattern track and draw a pattern block.
3. Drag a sample from the **Sample Selector** tab onto the pattern block to assign a
   region.
4. Click the track header's instrument icon to open the Sampler panel.
5. Wait for the waveform canvas to render.
6. Take a screenshot of the `.sampler-panel` element.
7. Save as `12-sampler-panel.png`.

---

## 17-distortion-panel.png

**Why it can't be automated:** After the automated tests add EQ, Compressor, Reverb, and
Delay effects to the master chain (4 modules), the effect chain overflows and the "+"
add-button scrolls out of the visible area. Playwright cannot reliably scroll the chain
footer into view.

**Manual steps:**
1. Launch the app. Open the Mixer (press **M**).
2. On a channel strip with an **empty** effect chain, click "+" → **Distortion** →
   **Distortion**.
3. Click the module name text ("Distortion") to open the panel.
4. Take a screenshot of the `.distortion-panel` element.
5. Save as `17-distortion-panel.png`.

---

## 18-modulation-panel.png

**Why it can't be automated:** Same root cause as 17 — the effect chain is full by the
time the modulation tests run.

**Manual steps:**
1. Launch the app. Open the Mixer (press **M**).
2. On an empty effect chain, click "+" → **Modulation** → **UniFlange** (or Chorus).
3. Click the module name text to open its panel.
4. Take a screenshot of the panel element (`.chorus-panel`, `.flange-panel`, etc.).
5. Save as `18-modulation-panel.png`.

---

## 20-sample-picker.png  ·  25-syllable-splitter.png  ·  26-waveform-scrubber.png

**Why they can't be automated:** The Sample Picker opens when double-clicking a source
row in the Sample Selector tab. In Playwright mode the source list is empty ("No sources
imported"), so there is no row to click.

**Manual steps:**
1. Import at least one audio source via **Project Media → Import source**.
2. Navigate to the **Sample Selector** tab in the left panel.
3. Double-click a source row to open the Sample Picker.
4. Wait for the waveform scrubber canvas to render.
5. Take screenshots:
   - Full picker → `20-sample-picker.png`
   - Waveform scrubber element (`.waveform-scrubber`) → `26-waveform-scrubber.png`
   - Syllable splitter element (`.syllable-splitter`, if visible) → `25-syllable-splitter.png`

---

## 24-toast.png

**Why it can't be automated:** Ctrl+S only emits a save toast when the project has
unsaved changes **and** the save completes successfully. In the automated test run the
project may have already been saved or the toast dismisses before the assertion fires.

**Manual steps:**
1. Make any change (add a track, move a clip, change BPM).
2. Press **Ctrl+S**.
3. A `.toast` notification appears briefly — screenshot it immediately.
4. Save as `24-toast.png`.

---

_Last updated: 2026-04-20. Re-capture after any major UI change that affects these panels._
