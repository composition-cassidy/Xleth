# Phase D.2.1 Timeline Shortcut Regression Diagnostic

## Executive summary

Timeline shortcuts are still registered. The failure path is focus/event gating after the Vibrato/Scratch context-menu controls are used.

The timeline shortcut handler is registered once through `KeyboardManager` with scope `panel:timeline`. `KeyboardManager.dispatchMain()` then drops all normal bindings whenever `document.activeElement` is an `HTMLInputElement` or `HTMLTextAreaElement`. The new modulation UI adds several focusable controls inside a portaled `ContextMenu`, including checkboxes, range inputs, and selects. `ContextMenu` closes by setting React state only; it does not restore DOM focus to the timeline panel/root. As a result, after interacting with a modulation control, keyboard events can still reach `document`, but `KeyboardManager` ignores them because focus remains in a context-menu input or outside the timeline focus target.

This is not an engine, bridge, schema, DSP, shader, compositor, or FFmpeg issue. The regression is in UI focus ownership around `TimelineView`, `ContextMenu`, and `KeyboardManager`.

## Exact reproduction steps

Static diagnosis predicts this sequence:

1. Focus the timeline and select a clip.
2. Confirm `Ctrl+C`, `Ctrl+V`, or `Ctrl+Z` works.
3. Right-click the clip to open the clip context menu.
4. Interact with a Vibrato or Scratch checkbox/range/select.
5. Close the context menu with Escape or by clicking away.
6. Try `Ctrl+C`, `Ctrl+V`, or `Ctrl+Z`.

Expected runtime observations:

1. While a checkbox/range input is active, `document.activeElement` is an `HTMLInputElement`.
2. While a select is active, `document.activeElement` is an `HTMLSelectElement`; this path is currently inconsistently handled because `KeyboardManager` does not treat selects as text-entry/interactive controls.
3. Clicking the timeline background should restore timeline focus because `PanelFrame.onMouseDown` focuses the panel and `TimelineView` sets `timelineFocusedRef.current = true`.

Runtime launch was not performed in this pass; the report is based on source and diff inspection only.

## Files and functions inspected

- `ui/src/components/TimelineView.jsx`
  - `TIMELINE_KEY_COMBOS`
  - `timelineKeyHandlerRef.current`
  - keyboard registration `useEffect`
  - `handleSetClipVibrato`
  - `handleSetClipScratch`
  - Vibrato/Scratch context-menu JSX
  - `timelineFocusedRef` / `timelineViewRef` focus tracking
  - context-menu rendering
- `ui/src/components/ContextMenu.jsx`
  - outside-click close handler
  - Escape close handler
  - custom-item `onMouseDown`
- `ui/src/windowing/managers/KeyboardManager.ts`
  - `isTextEntryElement`
  - `dispatchMain`
  - `resolveFocusedPanel`
  - keyboard listener setup
- `ui/src/windowing/components/PanelFrame.tsx`
  - panel focus on mouse down
- `ui/src/windowing/registry/PanelRegistry.ts`
  - panel focused-state ownership
- `ui/src/components/timeline/TimelineCanvas.jsx`
  - clip context-menu request path

## Timeline shortcut call flow

1. `TimelineView.jsx:47-63` declares timeline combos, including `Ctrl+C`, `Ctrl+V`, `Ctrl+Z`, redo, Delete, duplicate, tool keys, and pitch keys.
2. `TimelineView.jsx:2593-2608` registers each combo with `registerKeyboardBinding({ scope: 'panel:timeline', combo, handler: dispatch })`.
3. `KeyboardManager.ts:200-210` installs document/window keydown listeners.
4. `KeyboardManager.ts:91-115` dispatches keydown events:
   - First checks `document.activeElement`.
   - If active element is text-entry, only bindings with `allowInTextEntry` can fire.
   - Otherwise, resolves the focused panel and dispatches `panel:timeline` bindings.
5. `TimelineView.jsx:2120-2591` handles the actual timeline actions:
   - Undo/redo at `2124-2148`.
   - Select all at `2150-2157`.
   - Delete at `2159-2182`.
   - Copy at `2185-2264`.
   - Paste at `2266-2458`.
   - Duplicate at `2460-2508`.

## Current focus/event flow

The current focus/event flow is fragile around portaled context-menu controls:

1. `ContextMenu.jsx:42-69` renders the menu into `document.body` via a portal, outside the timeline panel DOM subtree.
2. `ContextMenu.jsx:52-53` calls `stopPropagation()` on custom menu item `mousedown`.
3. `TimelineView.jsx:3030-3042` has a window capture `mousedown` listener that marks `timelineFocusedRef.current` false whenever the target is not inside `timelineViewRef`.
4. Because the context menu is portaled outside `timelineViewRef`, clicking Vibrato/Scratch controls is outside the timeline for that listener.
5. `ContextMenu.jsx:26-40` closes on outside mousedown or Escape, but `TimelineView.jsx:3215-3221` passes `onClose={() => setContextMenu(null)}` only. No focus restoration happens.
6. `PanelFrame.tsx` focuses the panel only when the panel frame receives mousedown. Portaled context-menu clicks do not bubble through the panel frame.

## Root cause with exact line references

Root cause: the modulation context-menu controls can leave DOM focus in a portaled control, while `KeyboardManager` globally suppresses timeline bindings whenever `document.activeElement` is an input/textarea and no close path restores focus to the timeline.

Evidence:

- `KeyboardManager.ts:36-40` defines text-entry as `contentEditable`, `HTMLInputElement`, or `HTMLTextAreaElement`.
- `KeyboardManager.ts:91-103` returns without firing normal bindings when `document.activeElement` is text-entry.
- `TimelineView.jsx:2899`, `2968`, and `202-212` create checkboxes/range inputs used by the modulation UI. These are `HTMLInputElement`s and trip the text-entry guard.
- `TimelineView.jsx:2911-2918`, `2931-2937`, `2942-2948`, `2973-2984`, and `2995-3001` create selects in the modulation UI. `HTMLSelectElement` is not included in `KeyboardManager.ts:36-40`, so selects are handled inconsistently with the expected behavior.
- `ContextMenu.jsx:42-69` portals the menu to `document.body`, outside the timeline panel subtree.
- `ContextMenu.jsx:26-40` closes the menu but does not restore focus.
- `TimelineView.jsx:3215-3221` passes a close callback that only clears context-menu state.

Secondary issue: `TimelineView.jsx:3030-3042` tracks `timelineFocusedRef` from raw DOM containment. Since portaled menu clicks are outside `timelineViewRef`, this makes non-Ctrl tool shortcuts more likely to stop after interacting with the menu. Ctrl shortcuts mostly depend on `KeyboardManager` panel focus, but the same focus-loss pattern explains the wider "likely other timeline shortcuts" symptom.

## Evidence from diffs/runtime inspection

Preflight:

- Working directory: `C:\Users\Krasen\Desktop\XLETH`
- Branch: `feature/clip-modulation-fx-integration`
- Scratch/Vibrato UI is uncommitted in the current working tree.
- `git diff --stat` shows the only UI source change is `ui/src/components/TimelineView.jsx`; other modified files are existing native D.1 work.

Diff evidence:

- The current `TimelineView.jsx` diff adds Vibrato controls and Scratch controls to the clip context menu.
- D.2 specifically adds Scratch controls at `TimelineView.jsx:2955-3005`.
- C.2/D.2 together add several focusable controls to the context menu:
  - checkboxes,
  - range sliders via `ClipSliderRow`,
  - multiple selects.

Important comparison:

- Volume/Fade already used `ClipSliderRow`, so the underlying focus-management weakness predates Scratch.
- C.2 introduced a larger modulation section with selects and more persistent controls.
- D.2 added another modulation section with additional focusable controls, making the bug much easier to hit.
- Therefore this is best classified as an existing context-menu/keyboard-focus bug exposed by C.2 and amplified by D.2, not a Scratch DSP/API bug.

Runtime inspection:

- Not performed in this pass.
- Recommended DevTools checks are:
  - `document.activeElement` before opening the menu.
  - `document.activeElement` while a Vibrato/Scratch checkbox/range/select is focused.
  - `document.activeElement` after closing with Escape.
  - `document.activeElement` after clicking the timeline background.

## Answers to required questions

1. Where are timeline keyboard shortcuts handled?
   - Registered in `TimelineView.jsx:2593-2608`.
   - Handled in `TimelineView.jsx:2120-2591`.
   - Routed by `KeyboardManager.ts:91-115`.

2. Are the shortcuts still registered?
   - Yes. `TIMELINE_KEY_COMBOS` includes copy/paste/undo at `TimelineView.jsx:47-63`, and they are registered at `TimelineView.jsx:2604-2605`.

3. Are keyboard events failing to fire, or firing but being ignored?
   - Static evidence points to events firing and then being ignored by `KeyboardManager.dispatchMain()` when `document.activeElement` is an input/textarea.

4. Is focus stuck inside an input/select/context-menu element?
   - Very likely. The new controls are portaled outside the timeline and there is no focus restoration on close.

5. Is a new `onKeyDown`/`onPointerDown`/`stopPropagation`/`preventDefault` blocking shortcuts?
   - No new keyboard handler blocks shortcuts. The relevant stop is the existing `ContextMenu.jsx:52-53` custom-item `onMouseDown` stop. It prevents the menu from closing while controls are used, but it is not directly swallowing keydown events.

6. Is `fetchClips()` or a rerender causing timeline focus loss?
   - `fetchClips()` is not the primary cause. It rerenders after Vibrato/Scratch commits, but the focus problem exists because focusable controls live in a portal and no close path restores focus. `fetchClips()` can make the symptom more visible if it rerenders while focus is already in a control.

7. Does the bug happen only after interacting with Scratch controls, or immediately on app load?
   - Static evidence says it should not happen immediately on app load if the timeline panel is focused. It should happen after interacting with context-menu controls, especially modulation inputs/selects.

8. Does clicking timeline background restore shortcuts?
   - Expected yes. `PanelFrame.tsx` focuses the panel on mousedown, and `TimelineView.jsx:3030-3042` marks the timeline DOM as focused when the click target is inside `timelineViewRef`.

9. Is the issue caused by D.2 Scratch UI, C.2 Vibrato UI, or an older WIP change?
   - The underlying bug is older focus-management behavior in `ContextMenu`/`KeyboardManager`. C.2 exposed it by adding Vibrato controls with selects/ranges. D.2 amplified it by adding more Scratch controls. The Scratch-specific state merge/API work is not implicated.

10. What is the minimal safe fix?
   - Restore focus to the timeline panel/root after the clip context menu closes, and make interactive-control gating explicit and consistent for input, textarea, select, and contentEditable.

## Proposed fix plan

Do not implement in this diagnostic pass. Recommended implementation:

1. Add a timeline focus-restoration helper in `TimelineView.jsx`.
   - On context-menu close, call `setContextMenu(null)`.
   - Then, on the next animation frame or microtask, focus the owning timeline panel/root if no input/select/textarea/contentEditable remains active.
   - Prefer focusing the panel frame if accessible; otherwise make the timeline root focusable with `tabIndex={-1}` and focus `timelineViewRef.current`.

2. Narrow shortcut blocking to active editing.
   - Update `KeyboardManager.isTextEntryElement()` to include `HTMLSelectElement`.
   - Treat `input`, `textarea`, `select`, and `contentEditable` as interactive controls.
   - Allow timeline shortcuts only when the context menu is closed and no interactive control is actively focused.

3. Do not remove `ContextMenu.jsx:52-53` blindly.
   - The custom-item `onMouseDown` stop likely exists to prevent custom controls from immediately closing the menu.
   - If changed, narrow it carefully and manually retest sliders/selects.

4. Do not make `fetchClips()` responsible for focus.
   - `fetchClips()` should remain data refresh.
   - If needed, focus restoration should be tied to UI lifecycle events: context-menu close, committing a menu action that closes the menu, or explicit timeline background click.

5. Optional hardening:
   - Add an overlay/context-menu keyboard mode so timeline panel shortcuts are suspended while the context menu is open, except Escape.
   - This would prevent accidental timeline `Ctrl+C` while a select is focused once `HTMLSelectElement` is included.

## Risks of the proposed fix

- Focusing `timelineViewRef.current` directly may not update `PanelRegistry` focus unless the panel frame is already focused. Prefer also calling the panel focus action if available.
- Including `HTMLSelectElement` in `KeyboardManager` will change behavior globally: shortcuts will no longer fire while any select is focused. This matches the stated expected behavior but should be checked across mixer/plugin UI panels.
- Removing or changing context-menu `stopPropagation` could cause sliders/selects to close the menu on first click, which would regress the modulation UI.
- Restoring focus too aggressively could steal focus from legitimate editors, rename fields, dialogs, or contentEditable surfaces. The close handler should only restore focus for timeline-owned context menus after they close.

## Manual checks for the fix

1. Timeline focused, no menu open: `Ctrl+C`, `Ctrl+V`, `Ctrl+Z`, Delete, duplicate, and tool shortcuts work.
2. Vibrato/Scratch checkbox focused while menu is open: timeline shortcuts do not fire.
3. Vibrato/Scratch range focused while menu is open: timeline shortcuts do not fire.
4. Vibrato/Scratch select focused while menu is open: timeline shortcuts do not fire.
5. Close menu with Escape: focus returns to timeline and shortcuts work.
6. Close menu by clicking timeline background: focus returns to timeline and shortcuts work.
7. Close menu by clicking outside the timeline: shortcuts do not incorrectly claim timeline focus unless the timeline panel remains focused by design.
8. Rename/text input/contentEditable surfaces still block timeline shortcuts while editing.
9. Copy/paste/undo continue to work after `handleSetClipVibrato`/`handleSetClipScratch` triggers `fetchClips()`.

## Explicit non-goals

- No source fix in this pass.
- No engine DSP investigation or changes.
- No bridge/API/schema changes.
- No shader/compositor/FFmpeg work.
- No Scratch/Vibrato schema or preset changes.
- No new branch, commit, or worktree.
