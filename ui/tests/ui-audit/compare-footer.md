## 5. Found while capturing (behaviour in the app, for a follow-up; nothing was fixed here)

- **FX Graph add menu, Modulators items.** Under automation a pointer click on `Macro` or `Envelope` left the menu open and added no node, while focus plus Enter added it. Other kit menus activate by pointer in the same run (the track menu's *Create Automation Clip*, the File menu). The harness uses Enter in `p60`. Worth one check with a real mouse.
- **Picker sheet and Escape.** After Space is pressed inside the SamplePicker sheet, Escape did not close it; it stayed over the Preview header and blocked the Edit grid button until its Close button was used. The harness now clicks Close.
- **File > Clean up project** on this project shows the status text "Nothing to clean up." and opens no dialog, so `136-dialog-cleanup-project` was not taken (it needs a project with an unused source).
- **Right-click on a Sampler knob** opens no menu in this build, so `167-context-menu-sampler-knob` was not taken.
- **Inspector with nothing selected** is still unreachable once something has been selected (`93`), as in the baseline.

## 6. What changed between the two runs that is not a UI change

- The baseline's `30-sampler-main-1of2/2of2` are now `30-sampler-main-1of1` plus the new `31`, `32` and `36`–`39` (Main, Playback and the four modulation sources at the default dock height). `40-devices-chain-NofM` has 14 pages instead of 6 (25 devices in the chain; p00 now adds Xleth EQ through the picker too), and `85-preview-visualfx-NNofMM` has 4 pages instead of 12 (the Video view replaced the Inspector column). `136` was not re-taken (see above).
- Surfaces are grouped by the harness's `surface` id. A shot scoped to a dock or to the docked-window layer counts everything visible in that scope, so an Inspector problem can show under the timeline (see `timeline-headers`).
- The capture ran against `ui/dist` built on 2026-11-09 from the working tree at `21c966e` **plus uncommitted changes from other work in the same tree** (the Edit Grid rails, MIDI import, media tab). They are in the "after" numbers.
- Low-res (1366×768) shots are in the same launch: `200`–`207`.
