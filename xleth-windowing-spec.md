# Xleth windowing system architecture spec

**Version:** 1.1 (beta-blocking)
**Status:** spec approved, implementation pending
**Owner:** Krasen
**Scope:** Wave 1 of pre-beta polish. Replaces current fixed CSS Grid layout with a custom floating/dockable panel system in the Electron main BrowserWindow.
**Depends on:** `xleth-theming-spec.md` (Wave 0 — must ship first)

---

## 1. Overview

Xleth's current UI packs every surface (preview, timeline, mixer, sidebar) into a single fixed layout. That layout hit its ceiling during Phase 3 — mixer is cramped, grid panel is a 2000px-tall wall, empty states feel hostile, and there is no way for users to arrange the app for their actual workflow.

This spec replaces the fixed shell with an FL Studio-style MDI pattern: a single parent Xleth window containing floating, draggable, resizable sub-panels that can maximize *within* the parent (not to OS fullscreen), snap to parent edges, be hidden and re-opened from a top-bar icon row, and switch between preset layouts.

The panel system is fully custom — no third-party library — for aesthetic precision and animation feel. All panels live inside the existing main `BrowserWindow`; no new Electron windows are introduced in this phase (detach-to-OS-window is post-beta).

## 2. Locked decisions

| Area | Decision |
|---|---|
| Implementation | Custom build, no library |
| Docking | Hybrid: free-float by default, snap when dragged within 40px of parent edge |
| Titlebar height | 28px |
| Panel identity | Left accent bar (3px, panel-type color, always visible, 40% opacity when unfocused) |
| Panel focus | Top underline (2px, Xleth teal, only visible on the focused panel) |
| Titlebar controls | Minimize, maximize-within-parent, close |
| Double-click titlebar | Toggles maximize-within-parent |
| Minimize target | Hidden (no tray). Reopenable via top-bar icon row or F-key |
| Keyboard shortcuts | FL-style F-keys default, rebindable in Settings → Keyboard |
| State persistence | Per-user, JSON file in Electron `userData` dir |
| Left sidebar | Always docked left, toggleable hidden (F6), not floatable |
| Preview panel | Floatable and snappable. Must stop all compositor work when hidden |
| Piano Roll | Single window, current pattern only (no multi-pattern comparison) |
| Preset layouts | 3 day-one: FL compose, Vegas arrange, Grid edit |
| Detach to OS window | Deferred post-beta |

## 3. Panel catalog

| Panel | Type color token | F-key | Default in FL preset | Default in Vegas preset | Default in Grid preset |
|---|---|---|---|---|---|
| Timeline | `--theme-panel-timeline` | F5 | Top-right, wide | Bottom half, full width | Bottom, compressed |
| Sample Selector (sidebar) | `--theme-text-muted` (neutral) | F6 | Docked left | Docked left | Docked left |
| Piano Roll | `--theme-panel-pianoroll` | F7 | Hidden | Hidden | Hidden |
| Preview | `--theme-panel-preview` | F8 | Hidden | Top-right, wide | Top-right, wide |
| Mixer | `--theme-panel-mixer` | F9 | Bottom, full width | Hidden | Hidden |
| Grid Settings | `--theme-panel-grid` | F10 | Hidden | Hidden | Top-left, wide |
| Node Editor | `--theme-panel-node` | F11 | Hidden | Hidden | Hidden |

Panel-type color is always applied to the left accent bar. Top underline is always `--theme-accent` regardless of panel type — it signals focus, not identity. Default values for all panel-type tokens are defined in `xleth-theming-spec.md` Section 3.2 (the Default theme hue-rotates accent by 60° per panel type).

## 4. System components

### 4.1 PanelRegistry (Zustand store)

Central state holder for all panels. Single source of truth. All panel state mutations go through this registry; no component holds panel position or size locally.

**State schema per panel:**
```ts
interface PanelState {
  id: PanelId;                    // 'timeline' | 'mixer' | ...
  hidden: boolean;                // true when minimized / closed
  focused: boolean;               // only one panel is focused at a time
  zIndex: number;                 // incremented on focus
  mode: 'floating' | 'docked' | 'maximized';
  floating: {                     // valid when mode === 'floating'
    x: number; y: number;
    width: number; height: number;
  };
  docked: {                       // valid when mode === 'docked'
    region: 'left' | 'right' | 'top' | 'bottom';
    orderInRegion: number;
    sizeInRegion: number;         // px along cross-axis
  };
  preMaximizeState: Partial<PanelState> | null;  // restore target on un-maximize
}
```

**Methods:**
- `openPanel(id)` — sets hidden=false, focuses
- `closePanel(id)` — sets hidden=true, clears focus
- `togglePanel(id)` — the top-bar icon action
- `focusPanel(id)` — bumps zIndex, sets focused=true on this panel and false on all others
- `moveFloatingPanel(id, x, y)`
- `resizeFloatingPanel(id, x, y, width, height)` — also used for resize-from-any-edge
- `dockPanel(id, region)` — transitions mode floating → docked
- `undockPanel(id, x, y)` — transitions mode docked → floating
- `maximizePanel(id)` — caches current state to preMaximizeState, fills work area
- `restorePanel(id)` — reverts to preMaximizeState
- `applyPreset(presetId)` — overwrites entire registry state from preset JSON

**Debounced persistence:** any state change triggers a 500ms-debounced save to `userData/layout.json`.

### 4.2 PanelFrame component

The visual wrapper. Every panel-type component (MixerPanel, TimelinePanel, etc.) renders its content inside a `PanelFrame`.

Reads its own state from the registry via panel id. Renders:
- Floating: absolutely-positioned div with CSS transform for position, width/height set directly.
- Docked: flex item inside the appropriate DockRegion, size driven by region layout.
- Maximized: absolutely-positioned div filling the work area (excludes docked regions).
- Hidden: returns null. Not rendered. No lifecycle hooks fire.

Responsibilities:
- Click anywhere on the frame → call `focusPanel(id)`.
- Render `Titlebar` (see 4.3).
- Render children as panel body.
- Render 8 resize handles (4 edges + 4 corners), 4px hit zones, cursor changes per edge.
- Resize handle drag → call `resizeFloatingPanel`.

### 4.3 Titlebar component

28px tall. Flex row: `[icon] [name] [ ...drag zone... ] [controls]`.

**Structure:**
```
<div class="titlebar" onMouseDown={startDrag} onDoubleClick={toggleMaximize}>
  <AccentBarLeft color={typeColor} opacity={focused ? 1.0 : 0.4} />
  <TopUnderline visible={focused} />  // 2px teal, absolute positioned at titlebar bottom
  <PanelIcon type={type} />            // 14x14, tinted by typeColor
  <PanelName>{title}</PanelName>       // 12px, weight 500, white when focused / grey when not
  <DragZone />                         // flex: 1, transparent, grab cursor
  <Controls>
    <MinimizeButton onClick={() => closePanel(id)} />
    <MaximizeButton onClick={() => toggleMaximize(id)} />
    <CloseButton onClick={() => closePanel(id)} />
  </Controls>
</div>
```

Minimize and Close are the same action (hide the panel). We render both for muscle-memory familiarity but they do the same thing. Alternative: collapse to a single "hide" button. Decision deferred — implement two buttons for now, collect beta feedback.

### 4.4 DragManager

Single global instance (module singleton or React context). Tracks at most one active drag.

**State:**
```ts
{
  draggingPanelId: PanelId | null;
  startMouseX, startMouseY: number;
  startPanelX, startPanelY: number;
  currentSnapTarget: 'left' | 'right' | 'top' | 'bottom' | null;
  snapDwellStart: number;  // timestamp when snap target first detected
}
```

**On drag start (mousedown on titlebar):**
- If panel is docked, call `undockPanel(id, currentX, currentY)` to transition to floating first.
- Capture starting mouse and panel coords.
- Set `draggingPanelId`.
- Bind mousemove and mouseup to `window`.

**On mousemove:**
- Compute new panel position: `startPanelX + (mouseX - startMouseX)`.
- Call `moveFloatingPanel(id, newX, newY)`.
- Check proximity to parent edges (work-area rect, not OS window):
  - Within 40px of any edge → set `currentSnapTarget` and `snapDwellStart` if not already set.
  - Not within 40px of any edge → clear both.
- Render edge-snap ghost if `currentSnapTarget` is set and dwell ≥ 0 (ghost appears immediately, commit happens only on release after 150ms dwell).

**On mouseup:**
- If `currentSnapTarget` is set AND `Date.now() - snapDwellStart >= 150ms`, call `dockPanel(id, snapTarget)`.
- Otherwise, panel remains floating at its current position.
- Clear drag state.

**Edge-snap ghost:**
Semi-transparent rectangle using `--theme-accent` at 18% alpha with a 2px `--theme-accent` border, showing where the panel would dock. Rendered by a sibling to the panel layer, positioned absolutely. For each snap target:
- Left: full height, 320px wide at left edge
- Right: full height, 320px wide at right edge
- Top: full width, 280px tall at top edge (below toolbar)
- Bottom: full width, 280px tall at bottom edge (above transport)

Defaults are heuristic; user can resize after snap.

### 4.5 DockRegion component

Four instances rendered by the main app shell: left, right, top, bottom. Each reads its panel list from the registry.

Multiple panels docked to the same region stack along the region's primary axis (left/right: vertical stack; top/bottom: horizontal stack). Each panel in a region gets a resize handle on its shared boundary. Dividers between docked region and floating work area are also resizable.

If only one panel is docked to a region, that panel fills the whole region.

Future enhancement (post-beta): tabbed mode where multiple panels in a region can share space via tab group.

### 4.6 TopBarToggles

Rendered in the top toolbar (see 4.10). One icon per panel type in order: Timeline, Piano Roll, Mixer, Preview, Grid, Node. Sample Selector does not appear here (always-docked, toggled via F6 or View menu).

Each icon:
- 28x28 hit zone, 16x16 icon rendered centered.
- When panel is open (`hidden === false`): icon tinted in panel-type color.
- When panel is hidden (`hidden === true`): icon tinted neutral grey (`#5F5E5A`).
- Click: calls `togglePanel(id)`.
- Tooltip: panel name + keyboard shortcut ("Mixer (F9)").
- Focus indicator: 1px bottom border in Xleth teal when the corresponding panel is currently focused.

### 4.7 PresetManager

Three day-one presets stored as JSON under `/src/windowing/presets/`:

- `fl-compose.json`
- `vegas-arrange.json`
- `grid-edit.json`

Each preset is a full `PanelRegistry` state snapshot. Apply = overwrite.

**View menu integration:**
```
View
├── Layouts
│   ├── FL compose        (Ctrl+Shift+1)
│   ├── Vegas arrange     (Ctrl+Shift+2)
│   ├── Grid edit         (Ctrl+Shift+3)
│   ├── ────────
│   ├── Save current as…
│   └── Reset to FL compose
├── Panels
│   ├── ☑ Timeline        (F5)
│   ├── ☐ Piano Roll      (F7)
│   ├── ☑ Mixer           (F9)
│   └── …
```

User-saved custom layouts append to the Layouts submenu. Stored alongside default presets in `userData/custom-layouts/`.

### 4.8 KeyboardManager

Module that registers global keyboard listeners on the document. Respects input focus — shortcuts do not fire when a text input or contentEditable is focused.

**Default bindings:**

| Shortcut | Action |
|---|---|
| F5 | Toggle Timeline |
| F6 | Toggle Sample Selector |
| F7 | Toggle Piano Roll |
| F8 | Toggle Preview |
| F9 | Toggle Mixer |
| F10 | Toggle Grid Settings |
| F11 | Toggle Node Editor |
| Esc | Restore focused maximized panel |
| Ctrl+Shift+1 | Apply FL compose preset |
| Ctrl+Shift+2 | Apply Vegas arrange preset |
| Ctrl+Shift+3 | Apply Grid edit preset |

**Rebinding:** Settings → Keyboard shows every binding with a "click to rebind" cell. Custom bindings stored in user settings JSON. Resolution order: custom binding → default binding.

### 4.9 StatePersistence

`layout.json` in Electron's `app.getPath('userData')` directory.

**Schema:**
```json
{
  "version": 1,
  "lastActivePreset": "fl-compose",
  "panels": { /* PanelRegistry state */ },
  "customKeyBindings": { /* overrides */ }
}
```

**Read path:** on app boot, after Electron ready + before React renders, read `layout.json`. If missing or version mismatch, fall back to `fl-compose.json`. Populate registry from loaded state.

**Write path:** 500ms-debounced write whenever registry state changes. Write is async, non-blocking. Errors logged but don't crash the app.

### 4.10 Main shell layout

The app root becomes:

```
┌─────────────────────────────────────────────────┐
│ MenuBar        (XLETH | File | Edit | ...)     │  24px
├─────────────────────────────────────────────────┤
│ TopToolbar     (actions | ... | panel icons)   │  36px
├────┬────────────────────────────────────┬──────┤
│    │                                    │      │
│ DL │        FloatingWorkArea            │ DR   │  flex: 1
│    │                                    │      │
├────┴────────────────────────────────────┴──────┤
│ DB (docked bottom region)                       │  variable
├─────────────────────────────────────────────────┤
│ Transport      (play | time | BPM | ...)       │  32px
└─────────────────────────────────────────────────┘
```

`DL` = DockRegion left, `DR` = DockRegion right, `DB` = DockRegion bottom. `FloatingWorkArea` is the positioning context for all floating panels. Docked regions occupy work area edges; floating panels only live inside the FloatingWorkArea.

### 4.11 Preview performance coupling

**Critical engineering requirement.** When the Preview panel is hidden, the entire video pipeline must idle. Audio playback must continue uninterrupted.

**Engine IPC additions:**
- `setPreviewEnabled(enabled: boolean)` — issued from renderer to engine process.
- When `enabled === false`:
  - Compositor stops dispatching frames to renderer.
  - D3D11 preview backbuffer textures released.
  - Source frame decoders pause (no new frames decoded until resumed or export job requests them).
  - Frame cache retained (cheap to keep, useful when preview re-enabled).
- When `enabled === true`:
  - Compositor resumes at next audio-clock tick.
  - Decoders resume.
  - First-frame latency: acceptable ≤200ms warm-up.

**Invariants preserved regardless of preview state:**
- Audio playback runs uninterrupted (audio is master clock, independent of video pipeline).
- Playhead advances normally.
- MIDI → sampler dispatch runs normally.
- Audio effects chain runs normally.
- Clip-track audio plays normally.

**Implementation hook:**
`PreviewPanel` subscribes to its own `hidden` state in the registry. On change, calls `ipcRenderer.invoke('preview:setEnabled', !hidden)`. The main process relays this to the engine worker via the existing IPC bridge.

**Acceptance test:**
With playback running and a busy grid composition, toggle Preview hidden (F8). CPU and GPU usage drops by ≥40% within 2 frames. Audio remains glitch-free through the transition.

### 4.12 Theme integration

Every color, gradient, and chrome dimension in this windowing system resolves from a theme token defined in `xleth-theming-spec.md`. No hardcoded hex values appear in any windowing component.

**Token consumption:**
- `Titlebar` reads `--theme-chrome-titlebar-bg`, `--theme-chrome-titlebar-fg`, `--theme-chrome-titlebar-height`, `--theme-chrome-accent-bar-width`, `--theme-chrome-underline-thickness`
- `PanelFrame` reads `--theme-bg-primary`, `--theme-border-subtle`, `--theme-chrome-border-radius`
- Accent bar color is resolved per-panel via `var(--theme-panel-{type})` — e.g., Mixer reads `var(--theme-panel-mixer)`
- Focus underline reads `var(--theme-accent)` always (never panel-type color)
- `SnapGhost` reads `var(--theme-accent)` with opacity 0.18
- `TopBarToggles` icons colored by `var(--theme-panel-{type})` when open, `var(--theme-text-muted)` when hidden

**Live theme switching:**
When the user clicks Apply in the Theme Editor, `:root` CSS variables update. All windowing components inherit via CSS cascade — no re-mount required. Panel positions, sizes, and z-order state remain untouched. Visually the entire window system repaints in one frame with new colors.

**Gradient-capable chrome tokens:**
`--theme-chrome-titlebar-bg` supports solid, linear, radial, or conic values. This is how users reproduce FL's skeuomorphic gradient titlebars or Vegas's flat titlebars from the same chrome spec.

**Dimension tokens:**
If a user edits `--theme-chrome-titlebar-height` from 28px to 32px, every titlebar in every panel updates immediately. No re-layout logic needed beyond CSS.

**No windowing state in theme JSON:** themes describe appearance only. Panel positions, open/closed state, and preset assignments live in `layout.json` (see Section 4.9), completely separate from theme JSON. Users can switch themes without affecting their layout, and share layouts across themes.

## 5. File structure

```
src/
├── windowing/
│   ├── registry/
│   │   ├── PanelRegistry.ts         # Zustand store + types
│   │   └── panelCatalog.ts          # Panel → color, icon, F-key map
│   ├── components/
│   │   ├── PanelFrame.tsx
│   │   ├── Titlebar.tsx
│   │   ├── DockRegion.tsx
│   │   ├── SnapGhost.tsx
│   │   └── TopBarToggles.tsx
│   ├── managers/
│   │   ├── DragManager.ts
│   │   ├── KeyboardManager.ts
│   │   ├── PresetManager.ts
│   │   └── StatePersistence.ts
│   ├── presets/
│   │   ├── fl-compose.json
│   │   ├── vegas-arrange.json
│   │   └── grid-edit.json
│   └── panels/
│       ├── MixerPanel.tsx          # Wraps existing <Mixer />
│       ├── TimelinePanel.tsx
│       ├── PreviewPanel.tsx        # Wraps preview + preview perf hook
│       ├── PianoRollPanel.tsx
│       ├── GridSettingsPanel.tsx
│       ├── NodeEditorPanel.tsx
│       └── SampleSelectorPanel.tsx # Always-docked variant
└── AppShell.tsx                     # New root, replaces current fixed-grid shell
```

## 6. Implementation phases

**Prerequisite:** Phase 0 of `xleth-theming-spec.md` must complete first. The theming token infrastructure (catalog, deriveTheme, ThemeProvider, default theme JSON, and replacement of all existing hardcoded hex codes in Xleth) is the foundation this system is built on. Windowing Phase 1 assumes every color already resolves from a theme token.

Each phase below is independently testable. Later phases assume earlier phases work.

**Phase 1 — Shell scaffolding.** Create the Zustand `PanelRegistry`, the `PanelFrame` + `Titlebar` components, and basic floating behavior (no drag, no resize yet — panels render at hardcoded positions). Build an `AppShell` that hosts a single test panel to verify the rendering pipeline. At this point the existing app UI is not yet migrated; this is a parallel system under `src/windowing/`.

**Phase 2 — Drag, resize, maximize.** Wire up `DragManager`. Resize handles on all 8 positions. Maximize-within-parent + double-click-titlebar. Click-to-focus with z-index bumping. No docking yet — panels are free-floating only.

**Phase 3 — Dock regions + edge snap.** Build `DockRegion` left/right/bottom. Implement edge-snap detection in drag manager with 150ms dwell and teal ghost preview. Dividers between docked regions and floating area are resizable.

**Phase 4 — Top bar + keyboard.** Build `TopBarToggles` component. Build `KeyboardManager` with default F-key bindings. Settings → Keyboard rebind UI (simple: list of actions, "click to rebind" pattern).

**Phase 5 — Presets + persistence.** Build `PresetManager` and the three default preset JSONs. Build `StatePersistence` with debounced writes and boot-time load. View menu → Layouts integration. Ctrl+Shift+1/2/3 shortcuts.

**Phase 6 — Panel migration.** Wrap each existing surface (Mixer, Timeline, Piano Roll, Preview, Grid Settings, Node Editor, Sample Selector) in a `*Panel` component that plugs into the registry. Delete the old fixed-grid `AppShell` layout. This is the cutover — after Phase 6 the new system is the only UI.

**Phase 7 — Preview performance coupling.** Add `preview:setEnabled` IPC in `main.js`. Wire engine worker to accept it and toggle compositor. Hook `PreviewPanel` to dispatch on hidden state change. Verify acceptance test (CPU/GPU drop ≥40% when hidden).

Estimated effort: 5–7 focused days at Krasen's pace. Phases 1–3 are the bulk; 4–7 are comparatively small.

## 7. Acceptance criteria

A release of this wave is considered complete when all of the following pass:

1. All 7 panels render correctly in floating, docked, maximized, and hidden states.
2. Drag works from titlebar for every panel; resize works from all 8 positions.
3. Edge-snap activates within 40px, requires 150ms dwell, ghost renders correctly, commit on release.
4. Double-click titlebar toggles maximize-within-parent; Esc restores focused maximized panel.
5. All 7 F-key bindings toggle the correct panels. Rebinding in Settings works and persists.
6. Three presets load correctly and fully replace registry state.
7. Layout persists across app restart within the same OS user profile.
8. Top-bar icon row correctly reflects open/closed state, click toggles, keyboard-shortcut tooltip shows.
9. Hiding the Preview panel reduces CPU + GPU usage by ≥40% within 2 frames during active playback. Audio does not glitch through the transition.
10. All existing functionality (Mixer audio, Timeline editing, Piano Roll editing, Grid editing, Node Editor, sample management) works identically inside the new panel frames.
11. Every color and chrome dimension resolves from a theme token — no hardcoded hex in any windowing component. Switching themes (via the Theme Editor's Apply action) updates the entire window system visually in one frame without touching panel positions, sizes, or open/closed state.

## 8. Known decision debt (deferred post-beta)

- Detach-to-OS-window for multi-monitor support.
- Multi-pattern Piano Roll (open multiple patterns side-by-side).
- Per-project layout overrides (currently global per-user only).
- Right-click context menus on panel titlebars (rename, clone, save as layout, detach).
- Tabbed dock mode (multiple panels sharing a dock region as tabs).
- Plugin/VST plugin window always-on-top behavior (requires VST support first).
- Transport bar relocation (currently bottom, could be top — collect feedback first).
- Custom titlebar drag physics (spring/inertia on snap — currently linear).

## 9. Open sub-decisions (to lock during implementation)

These are small, don't block spec approval, but will be raised in relevant Claude Code prompts:

- Exact hex for "unfocused accent bar" opacity: 0.4 vs 0.5 vs 0.3 — prototype and eyeball.
- Minimize and Close as separate buttons or single "hide" — implement both, collect feedback.
- Default floating panel sizes when first opened — need per-panel defaults in `panelCatalog.ts`.
- Whether dragging a panel within 8px does nothing vs tiny reposition — threshold to prevent jitter.
- Top-bar icon hover animation (dim → bright) — 80ms ease-out vs instant.
- Snap-release animation: instant snap vs 120ms ease-in.

---

## Appendix A: Preset JSON example (fl-compose)

```json
{
  "version": 1,
  "presetName": "FL compose",
  "panels": {
    "timeline": {
      "hidden": false,
      "focused": true,
      "zIndex": 10,
      "mode": "floating",
      "floating": { "x": 260, "y": 60, "width": 1200, "height": 480 }
    },
    "mixer": {
      "hidden": false,
      "focused": false,
      "zIndex": 5,
      "mode": "docked",
      "docked": { "region": "bottom", "orderInRegion": 0, "sizeInRegion": 240 }
    },
    "sampleSelector": {
      "hidden": false,
      "focused": false,
      "zIndex": 3,
      "mode": "docked",
      "docked": { "region": "left", "orderInRegion": 0, "sizeInRegion": 240 }
    },
    "preview": { "hidden": true, "focused": false, "zIndex": 0, "mode": "floating", "floating": { "x": 400, "y": 100, "width": 640, "height": 360 } },
    "pianoRoll": { "hidden": true, "focused": false, "zIndex": 0, "mode": "floating", "floating": { "x": 320, "y": 140, "width": 960, "height": 540 } },
    "gridSettings": { "hidden": true, "focused": false, "zIndex": 0, "mode": "floating", "floating": { "x": 300, "y": 120, "width": 520, "height": 720 } },
    "nodeEditor": { "hidden": true, "focused": false, "zIndex": 0, "mode": "floating", "floating": { "x": 400, "y": 160, "width": 900, "height": 600 } }
  }
}
```
