// Surface manifest for the UI audit (read-only; nothing here is imported by product code).
// Paths are relative to ui/src. A trailing "/" expands to every non-test .js/.jsx/.ts/.tsx file in that folder.
// `shots` lists the planned screenshot ids (see capture plan); `root` is the DOM selector the metrics pass scopes to.

const M = 'components/mixer/';
const D = 'components/devices/';
const T = 'components/timeline/';

// ── Audio effects: enumerated from components/mixer/effectCatalog.js (EFFECT_CATEGORIES) ──
// id -> [label, category, files]. `device` is decided at inventory time from devices/deviceRegistry.js.
export const AUDIO_EFFECTS = [
  ['compressor', 'Compressor', 'Dynamics', [M + 'CompressorPanel.jsx', D + 'CompressorDevice.jsx', 'plugin-ui/layouts/compressor.json']],
  ['glue', 'Glue Comp', 'Dynamics', [M + 'GlueCompPanel.jsx', D + 'CompressorFamilyDevice.jsx', D + 'compressorFamilyModels.js']],
  ['opto', 'Opto Comp', 'Dynamics', [M + 'OptoCompPanel.jsx', D + 'CompressorFamilyDevice.jsx', D + 'compressorFamilyModels.js']],
  ['fet', 'FET Comp', 'Dynamics', [M + 'FetCompPanel.jsx', D + 'CompressorFamilyDevice.jsx', D + 'compressorFamilyModels.js']],
  ['varimu', 'Vari-Mu Comp', 'Dynamics', [M + 'VariMuCompPanel.jsx', D + 'CompressorFamilyDevice.jsx', D + 'compressorFamilyModels.js']],
  ['limiter', 'Limiter', 'Dynamics', [M + 'LimiterPanel.jsx', D + 'LimiterDevice.jsx', 'plugin-ui/layouts/limiter.json']],
  ['apex', 'APEX', 'Dynamics', [M + 'ApexPanel.jsx', D + 'ApexDevice.jsx', M + 'ApexAnalysis.jsx', M + 'ApexCurveEditor.jsx', M + 'apexGeometry.js']],
  ['gloss', 'GLOSS', 'Dynamics', [M + 'GlossPanel.jsx', D + 'GlossDevice.jsx']],
  ['overdone', 'Overdone', 'Dynamics', [M + 'OTTPanel.jsx', D + 'OverdoneDevice.jsx', D + 'OverdoneCrossoverCanvas.jsx']],
  ['transientproc', 'Transient Proc', 'Dynamics', [M + 'TransientProcPanel.jsx', D + 'TransientProcDevice.jsx']],
  ['resonancesuppressor', 'Resonance Suppressor', 'Dynamics', [M + 'ResonanceSuppressorPanel.jsx', 'plugin-ui/layouts/resonancesuppressor.json']],
  ['xletheq', 'Xleth EQ', 'EQ & Filter', [M + 'EqPanel.jsx', M + 'EqCanvas.jsx', D + 'EqDevice.jsx']],
  ['xlethfilter', 'Xleth Filter', 'EQ & Filter', [M + 'FilterPanel.jsx']],
  ['distortion', 'Distortion', 'Distortion', [M + 'DistortionPanel.jsx', 'plugin-ui/layouts/distortion.json']],
  ['waveshaper', 'Waveshaper', 'Distortion', [M + 'WaveshaperPanel.jsx']],
  ['amp', 'Amp Stack', 'Distortion', [M + 'AmpPanel.jsx']],
  ['uniflange', 'UniFlange', 'Modulation', [M + 'UniFlangePanel.jsx', D + 'UniFlangeDevice.jsx', D + 'UniFlangeScope.jsx']],
  ['chorus', 'Chorus', 'Modulation', [M + 'ChorusPanel.jsx', M + 'ChorusOrbitVisualizer.jsx']],
  ['flanger', 'Flanger', 'Modulation', [M + 'FlangerPanel.jsx', M + 'FlangerVisualizerCanvas.jsx', D + 'FlangerDevice.jsx', D + 'FlangerLfoCanvas.jsx']],
  ['phaser', 'Phaser', 'Modulation', [M + 'PhaserPanel.jsx', M + 'PhaserVisualizerCanvas.jsx']],
  ['phanjer', 'Phanjer', 'Modulation', [M + 'PhanjerPanel.jsx', M + 'PhanjerResponseCanvas.jsx']],
  ['delay', 'Delay', 'Time', [M + 'DelayPanel.jsx', M + 'DelayEchoFieldVisualizer.jsx', M + 'DelayFilterCurve.jsx', D + 'DelayDevice.jsx']],
  ['reverb', 'Reverb', 'Time', [M + 'ReverbPanel.jsx', M + 'ReverbDecayFieldVisualizer.jsx', M + 'ReverbFilterCurve.jsx', D + 'ReverbDevice.jsx']],
  ['pitchshifter', 'Pitch Shifter', 'Pitch', [M + 'PitchShifterPanel.jsx']],
  ['smartbalance', 'Smart Balance', 'Utility', [M + 'SmartBalancePanel.jsx']],
];

// ── Visual effects: components/grid/VisualFXAddDropdown.jsx (NC_ITEMS + C_ITEMS) ──
const G = 'components/grid/';
export const VISUAL_EFFECTS = [
  ['bounce', 'Bounce', 'non-chainable', 0],
  ['zoomPanRot', 'Zoom/Pan/Rot', 'non-chainable', 0],
  ['pingPong', 'Ping-Pong Loop', 'non-chainable', 0],
  ['vfx-0', 'Desaturation', 'chainable typeId 0', 0],
  ['vfx-1', 'Tint', 'chainable typeId 1', 1],
  ['vfx-2', 'Brightness & Contrast', 'chainable typeId 2', 2],
  ['vfx-3', 'TV Simulator', 'chainable typeId 3', 3],
  ['vfx-4', 'Zoom/Pan/Rot (per-cell)', 'chainable typeId 4', 4],
  ['vfx-5', 'Chroma Key', 'chainable typeId 5', 5],
  ['vfx-6', 'Outline', 'chainable typeId 6', 6],
  ['vfx-7', 'Drop Shadow', 'chainable typeId 7', 7],
  ['vfx-8', 'Visual Echo', 'chainable typeId 8', 8],
];
export const VISUAL_EFFECT_FILES = {
  'non-chainable': [G + 'NonChainableEffectParams.jsx', G + 'effectParamViews.jsx', G + 'EffectRow.jsx'],
  chainable: [G + 'ChainableEffectParams.jsx', G + 'effectParamViews.jsx', G + 'EffectRow.jsx'],
};
export const VISUAL_EFFECT_FILES_EXTRA = {
  zoomPanRot: [G + 'zprTimeline/'],
  'vfx-4': [G + 'zprTimeline/'],
};

// ── FX Graph node types: fxgraph/graphState.js + GraphStatePreview.tsx ──
export const FXGRAPH_NODE_TYPES = [
  ['trackInput', 'Track input', 'protected; always present'],
  ['trackOutput', 'Track output', 'protected; always present'],
  ['effect', 'Effect (Add Plugin)', 'GraphCanvasAddMenu > Add Plugin'],
  ['macro', 'Macro', 'GraphCanvasAddMenu > Macro'],
  ['envelope', 'Envelope', 'GraphCanvasAddMenu > Envelope'],
  ['lfo', 'LFO', 'GraphCanvasAddMenu > LFO'],
  ['sidechainInput', 'Sidechain input', 'GraphCanvasAddMenu > Sidechain Input'],
  ['unknown', 'Unsupported (preserved)', 'only appears for foreign graphState'],
];

// ── Everything else: one row per surface ──
// kind: panel | dock-tab | floating-window | editor | dialog | menu | context-menu | popover | toast | sheet
export const SURFACES = [
  // Shell
  { id: 'shell', name: 'App shell (regions, resizers, panel frames)', kind: 'panel', open: 'Always mounted (windowing/AppShell)', files: ['windowing/AppShell.tsx', 'windowing/components/DockRegion.tsx', 'windowing/components/DockRegionResizer.tsx', 'windowing/components/PanelFrame.tsx', 'windowing/components/PanelTabStrip.tsx', 'windowing/components/ResizeHandles.tsx', 'windowing/components/SnapGhost.tsx', 'windowing/components/windowing.css'] },
  { id: 'topbar', name: 'Top bar (menus, transport, panel toggles, window controls)', kind: 'panel', open: 'Always mounted', files: ['components/TitleBar.jsx', 'components/TransportBar.jsx', 'windowing/components/Titlebar.tsx', 'components/PreviewTimecode.jsx'] },
  { id: 'hintbar', name: 'Hint bar', kind: 'panel', open: 'Always mounted; hover a control', files: ['components/HintBar.jsx'] },
  { id: 'detaildock', name: 'Detail dock (tab strip, collapse)', kind: 'panel', open: 'Bottom region; click a tab / collapse chevron', files: ['windowing/components/DetailDock.tsx'] },
  // Panels from PANEL_CATALOG
  { id: 'panel-timeline', name: 'Timeline / arrangement panel', kind: 'panel', open: 'F5 / top-bar toggle', files: ['windowing/panels/TimelinePanel.tsx', 'components/TimelineView.jsx', T + 'TimelineCanvas.jsx', T + 'TimelineRuler.jsx', T + 'TimelineScrollbar.jsx'] },
  { id: 'timeline-toolbar', name: 'Timeline toolbar', kind: 'panel', open: 'Top of Timeline panel', files: [T + 'TimelineToolbar.jsx', T + 'tools/'] },
  { id: 'timeline-headers', name: 'Track header list (audio + video tracks)', kind: 'panel', open: 'Left of Timeline', files: [T + 'TrackHeader.jsx', T + 'TrackHeaderList.jsx', T + 'VideoTrackList.jsx', T + 'TrackTypeIcons.jsx', T + 'TrackHeader.module.css'] },
  { id: 'timeline-macro-lanes', name: 'Macro / automation lanes', kind: 'panel', open: 'FX Graph macro context menu > Show automation lane', files: [T + 'MacroAutomationLanes.jsx', T + 'automationLaneGeometry.js'] },
  { id: 'timeline-cue-lane', name: 'Snapshot cue lane', kind: 'panel', open: 'Pinned under the ruler', files: [T + 'SnapshotCueLane.jsx', T + 'SnapshotTransitionBezierEditor.jsx'] },
  { id: 'timeline-loop-bar', name: 'Loop region bar', kind: 'panel', open: 'Under ruler; toolbar loop toggle', files: [T + 'LoopRegionBar.jsx'] },
  { id: 'timeline-pattern-list', name: 'Pattern list panel', kind: 'panel', open: 'Timeline toolbar > Patterns', files: [T + 'PatternListPanel.jsx', T + 'patternPreview/'] },
  { id: 'timeline-track-ctx', name: 'Track context menu', kind: 'context-menu', open: 'Right-click a track header', files: [T + 'TrackContextMenu.jsx', T + 'TrackFlipSection.jsx', 'components/ContextMenu.jsx', 'ui-kit/Menu.tsx'] },
  { id: 'timeline-clip-ctx', name: 'Clip / canvas context menu', kind: 'context-menu', open: 'Right-click a clip', files: ['components/ContextMenu.jsx', T + 'TimelineCanvas.jsx'] },
  { id: 'timeline-color-popover', name: 'Track colour popover', kind: 'popover', open: 'Click the track identity stripe', files: [T + 'TrackColorPopover.jsx'] },
  { id: 'timeline-display-popover', name: 'Timeline display popover', kind: 'popover', open: 'Timeline toolbar > Display', files: [T + 'TimelineDisplayPopover.jsx'] },
  { id: 'timeline-canvas-popover', name: 'Video canvas settings popover', kind: 'popover', open: 'Timeline toolbar > Canvas', files: [T + 'VideoCanvasSettingsPopover.jsx', T + 'TrackVideoProperties.jsx'] },
  { id: 'timeline-quantize', name: 'Quantize dialog', kind: 'dialog', open: 'Pattern/clip context menu > Quantize', files: [T + 'QuantizeDialog.jsx'] },
  { id: 'timeline-convert', name: 'Convert track dialog', kind: 'dialog', open: 'Track context menu > Convert', files: [T + 'ConfirmConvertDialog.jsx'] },
  { id: 'timeline-clipfx-editors', name: 'Clip FX editors (vibrato, scratch, host)', kind: 'editor', open: 'Clip inspector > clip FX badge', files: [T + 'ClipFxEditorHost.jsx', T + 'ClipVibratoEditorPanel.jsx', T + 'ClipScratchEditorPanel.jsx', T + 'clipFxEditorOpeners.js', 'components/common/BreakpointCurveEditor.jsx'] },
  { id: 'timeline-clip-controls', name: 'Clip control tuner (dev flag only)', kind: 'editor', open: 'npm run dev:clip-controls (VITE_XLETH_CLIP_CONTROL_TUNER)', files: [T + 'clipControlTuner/', T + 'clipControls.css'] },
  { id: 'panel-preview', name: 'Preview panel (video)', kind: 'panel', open: 'F8 / top-bar toggle', files: ['windowing/panels/PreviewPanel.tsx', 'components/VideoPreview.jsx', 'windowing/panels/PreviewPanel.module.css'] },
  { id: 'preview-edit-grid', name: 'Edit Grid mode (dock, overlay, toolbar)', kind: 'panel', open: 'Preview > Edit Grid', files: ['components/GridEditorDock.jsx', 'components/GridEditorOverlay.jsx', G + 'GridEditToolbar.jsx', G + 'CornerRadiusControl.jsx', G + 'CustomGapControl.jsx'] },
  { id: 'preview-visual-fx', name: 'Visual FX panel (section, add dropdown, rows)', kind: 'panel', open: 'Edit Grid > a cell > Visual FX', files: [G + 'VisualFXSection.jsx', G + 'VisualFXSectionHeader.jsx', G + 'VisualFXAddDropdown.jsx', G + 'EffectRow.jsx'] },
  { id: 'preview-note-fade', name: 'Note Fade + Slide note effect sections', kind: 'editor', open: 'Edit Grid > pattern cell', files: [G + 'NoteFadeSection.jsx', G + 'SlideNoteEffectSection.jsx'] },
  { id: 'preview-zpr', name: 'Zoom/Pan/Rot keyframe timeline + viewport', kind: 'editor', open: 'Visual FX > Zoom/Pan/Rot', files: [G + 'zprTimeline/'] },
  { id: 'panel-inspector', name: 'Inspector (track / clip / pattern / none)', kind: 'panel', open: 'Top-right region; select something', files: ['windowing/panels/InspectorPanel.tsx', 'components/inspector/'] },
  { id: 'dock-devices', name: 'Devices tab (device chain)', kind: 'dock-tab', open: 'Detail dock > Devices', files: ['windowing/panels/DevicesPanel.tsx', D + 'DeviceChain.jsx', D + 'EffectDevice.jsx', D + 'DevicePresetMenu.jsx', D + 'deviceUiStore.js', D + 'deviceRegistry.js'] },
  { id: 'device-floating', name: 'Floating (popped-out) device window', kind: 'floating-window', open: 'Device title bar > Pop out', files: [D + 'FloatingDevice.jsx', M + 'EffectEditorHost.jsx'] },
  { id: 'fx-picker-chain', name: 'FX picker (chain add menu)', kind: 'menu', open: 'Devices > "Drop effects here" / mixer inserts +', files: [M + 'EffectChainPanel.jsx', M + 'FxChainMenuLayer.jsx', M + 'effectCatalog.js', M + 'VstBrowser.jsx'] },
  { id: 'fx-picker-graph', name: 'FX picker (FX Graph)', kind: 'popover', open: 'FX Graph > canvas right-click > Add Plugin', files: ['windowing/panels/fxgraph/FxGraphEffectPicker.tsx', 'windowing/panels/fxgraph/fxGraphEffectPicker.css'] },
  { id: 'dock-mixer', name: 'Mixer tab', kind: 'dock-tab', open: 'Detail dock > Mixer / F9', files: ['windowing/panels/MixerPanel.tsx', M + 'MixerPanel.jsx', M + 'MixerStrip.jsx', M + 'MasterStrip.jsx', M + 'RoutingBand.jsx', M + 'routingCables.js', M + 'MixerStrip.module.css', 'components/MasterLoudnessMeter.jsx'] },
  { id: 'dock-pianoroll', name: 'Piano Roll tab', kind: 'dock-tab', open: 'Detail dock > Piano Roll / F7', files: ['windowing/panels/PianoRollPanel.tsx', 'components/pianoRoll/'] },
  { id: 'dock-sampler', name: 'Sampler tab (SamplerPanelContent)', kind: 'dock-tab', open: 'Detail dock > Sampler / F12', files: ['windowing/panels/SamplerWindowPanel.tsx', 'components/sampler/'] },
  { id: 'sampler-modulation', name: 'Sampler modulation tray (ENV/LFO/VELO/NOTE)', kind: 'editor', open: 'Sampler > modulation tab', files: ['components/sampler/modulation/'] },
  { id: 'dock-fxgraph', name: 'FX Graph tab', kind: 'dock-tab', open: 'Detail dock > FX Graph / F11', files: ['windowing/panels/FxGraphPanel.tsx', 'windowing/panels/fxgraph/GraphStatePreview.tsx', 'windowing/panels/fxgraph/ChainAsGraphPreview.tsx', 'windowing/panels/fxgraph/graphParameterUtils.ts', 'windowing/panels/fxgraph/fxGraph.css'] },
  { id: 'fxgraph-envelope-editor', name: 'FX Graph envelope node editor', kind: 'editor', open: 'FX Graph > Envelope node', files: ['windowing/panels/fxgraph/EnvelopeEditor.tsx'] },
  { id: 'fxgraph-lfo-editor', name: 'FX Graph LFO node editor', kind: 'editor', open: 'FX Graph > LFO node', files: ['windowing/panels/fxgraph/LfoEditor.tsx'] },
  { id: 'fxgraph-add-menu', name: 'FX Graph canvas add menu / node context menu / mapping editor', kind: 'context-menu', open: 'Right-click graph canvas or a node; click an edge', files: ['windowing/panels/fxgraph/GraphStatePreview.tsx'] },
  { id: 'panel-nodeeditor', name: 'Node Editor (quarantined)', kind: 'panel', open: 'NOT reachable (quarantined in panelCatalog)', files: ['windowing/panels/NodeEditorPanel.tsx', M + 'NodeEditor.jsx', 'NodeEditorWindow.jsx'] },
  // Browser + related
  { id: 'browser', name: 'Browser drawer (Media + Samples tabs)', kind: 'panel', open: 'F6 / left rail', files: ['windowing/panels/SampleSelectorPanel.tsx', 'windowing/components/SampleSelectorDrawer.tsx', 'components/LeftPanel.jsx', 'components/browser/', 'components/ProjectMediaTab.jsx', 'components/SampleSelectorTab.jsx', 'components/SampleRow.jsx', 'components/SampleGroup.jsx', 'components/SourceCard.jsx', 'components/SampleThumbnail.jsx', 'components/ImportDropZone.jsx', 'components/ProxyBatchBadge.jsx', 'components/browser/Browser.module.css'] },
  { id: 'picker-sheet', name: 'SamplePicker sheet', kind: 'sheet', open: 'Double-click a source in Browser > Media', files: ['windowing/components/PickerSheet.tsx', 'components/SamplePicker/', 'windowing/components/PickerSheet.module.css'] },
  { id: 'panel-quicknotation', name: 'Quick Notation', kind: 'floating-window', open: 'Piano roll notation entry', files: ['windowing/panels/QuickNotationPanel.tsx'] },
  { id: 'panel-splitsyllables', name: 'Split Syllables', kind: 'floating-window', open: 'Sample row context menu > Split syllables', files: ['windowing/panels/SplitSyllablesPanel.tsx', 'components/SyllableSplitter/'] },
  { id: 'panel-sandbox', name: 'Sample Sandbox', kind: 'floating-window', open: 'F10 / top-bar toggle', files: ['windowing/panels/SampleSandboxPanel.tsx', 'components/sandbox/'] },
  { id: 'loop-lab', name: 'Loop Lab (overlay deleted in Phase 8)', kind: 'floating-window', open: 'NOT reachable: UI deleted; only loopLabMeta/Rater logic remains', files: ['components/loopLab/'] },
  { id: 'filepicker', name: 'Xleth file picker modal', kind: 'dialog', open: 'File > Open Project / Import Source / Save As', files: ['components/filePicker/'] },
  // Menus
  { id: 'menu-file', name: 'File menu', kind: 'menu', open: 'Top bar > File', files: ['components/TitleBar.jsx', 'ui-kit/Menu.tsx'] },
  { id: 'menu-edit', name: 'Edit menu', kind: 'menu', open: 'Top bar > Edit', files: ['components/TitleBar.jsx', 'ui-kit/Menu.tsx'] },
  { id: 'menu-view', name: 'View menu (+ Layouts)', kind: 'menu', open: 'Top bar > View', files: ['components/TitleBar.jsx', 'ui-kit/Menu.tsx', 'windowing/presets/'] },
  { id: 'menu-settings', name: 'Settings menu entry (direct action, no dropdown)', kind: 'menu', open: 'Top bar > Settings', files: ['components/TitleBar.jsx'] },
  { id: 'menu-generic-ctx', name: 'Generic ContextMenu (media, sampler, piano roll, mixer…)', kind: 'context-menu', open: 'Right-click in many panels (~40 callers)', files: ['components/ContextMenu.jsx', 'ui-kit/Menu.tsx'] },
  { id: 'menu-sandbox-ctx', name: 'Sandbox selection context menu + menu bar', kind: 'context-menu', open: 'Sandbox > right-click selection', files: ['components/sandbox/SandboxSelectionContextMenu.jsx', 'components/sandbox/SandboxMenuBar.jsx'] },
  // Dialogs
  { id: 'dlg-settings', name: 'Settings panel (shell)', kind: 'dialog', open: 'Top bar > Settings', files: ['components/SettingsPanel.jsx'] },
  { id: 'settings-project', name: 'Settings > Project > General', kind: 'dialog', open: 'Settings > Project', files: ['components/SettingsPanel.jsx'] },
  { id: 'settings-clipfx', name: 'Settings > Project > Clip FX', kind: 'dialog', open: 'Settings > Project > Clip FX', files: ['components/SettingsPanel.jsx'] },
  { id: 'settings-audio', name: 'Settings > Application > Audio', kind: 'dialog', open: 'Settings > Application > Audio', files: ['components/SettingsPanel.jsx', 'components/debug/AudioPerformanceDiagnosticsPanel.jsx'] },
  { id: 'settings-plugins', name: 'Settings > Application > Plugins', kind: 'dialog', open: 'Settings > Application > Plugins', files: ['components/SettingsPanel.jsx', M + 'ScanProgressBar.jsx'] },
  { id: 'settings-graphics', name: 'Settings > Application > Graphics', kind: 'dialog', open: 'Settings > Application > Graphics', files: ['components/SettingsPanel.jsx'] },
  { id: 'settings-appearance', name: 'Settings > Application > Appearance', kind: 'dialog', open: 'Settings > Application > Appearance', files: ['components/SettingsPanel.jsx'] },
  { id: 'settings-shortcuts', name: 'Settings > Application > Shortcuts (keyboard shortcuts)', kind: 'dialog', open: 'Settings > Application > Shortcuts', files: ['components/settings/ShortcutsSection.jsx'] },
  { id: 'settings-launchers', name: 'Settings > Application > Launchers', kind: 'dialog', open: 'Settings > Application > Launchers', files: ['components/SettingsPanel.jsx'] },
  { id: 'settings-logs', name: 'Settings > Application > Logs', kind: 'dialog', open: 'Settings > Application > Logs', files: ['components/settings/LogsSection.jsx'] },
  { id: 'theme-editor', name: 'Theme editor (Settings > Appearance > Open editor)', kind: 'editor', open: 'Settings > Appearance > Open editor', files: ['theming/editor/'] },
  { id: 'dlg-export', name: 'Export dialog (Audio / YouTube / Discord / Custom tabs)', kind: 'dialog', open: 'Ctrl+E (audio) / Ctrl+Shift+E (video) / File menu', files: ['components/RenderDialog.jsx', 'components/RenderRangeSection.jsx', 'components/TailRenderControls.jsx', 'components/ProgressBar.jsx', 'components/exportPresets/'] },
  { id: 'dlg-midi-import', name: 'MIDI import dialog', kind: 'dialog', open: 'Drop a .mid / Timeline > Import MIDI', files: ['components/MidiImport/'] },
  { id: 'dlg-missing-media', name: 'Missing media dialog', kind: 'dialog', open: 'Open a project whose media moved', files: ['components/MissingMediaDialog.jsx'] },
  { id: 'dlg-missing-plugins', name: 'Missing plugins dialog', kind: 'dialog', open: 'Open a project that uses an unscanned VST3', files: ['components/MissingPluginsDialog.jsx'] },
  { id: 'dlg-unsaved', name: 'Unsaved changes dialog', kind: 'dialog', open: 'New / Open / Close with unsaved edits', files: ['components/UnsavedChangesDialog.jsx', 'ui-kit/Dialog.tsx'] },
  { id: 'dlg-cleanup', name: 'Clean up project dialog', kind: 'dialog', open: 'File > Clean up project…', files: ['components/CleanupProjectDialog.jsx', 'components/projectCleanup.js'] },
  { id: 'dlg-export-zip', name: 'Export as ZIP dialog', kind: 'dialog', open: 'File > Export as ZIP…', files: ['components/ExportZipDialog.jsx', 'components/ExportZipDialog.module.css'] },
  { id: 'dlg-automation-delete', name: 'Automation delete confirm dialog', kind: 'dialog', open: 'Remove an automated effect / knob', files: [M + 'AutomationDeleteConfirmDialog.jsx', M + 'automationDeletionGuard.js'] },
  { id: 'dlg-about', name: 'About dialog', kind: 'dialog', open: 'DOES NOT EXIST (no About surface in the renderer)', files: [] },
  { id: 'toast', name: 'Toast (top-bar status text)', kind: 'toast', open: 'Any action that reports status', files: ['components/Toast.jsx', 'components/Toast.module.css'] },
  { id: 'update-banner', name: 'Update banner', kind: 'toast', open: 'Stub: renders nothing (UpdateBanner.jsx is 6 lines)', files: ['components/UpdateBanner.jsx'] },
  { id: 'welcome', name: 'Welcome window (separate BrowserWindow)', kind: 'floating-window', open: 'App start (welcome.html)', files: ['../welcome.html'] },
  { id: 'dev-themeswitcher', name: 'Dev theme switcher (dev builds only)', kind: 'popover', open: 'Dev build only', files: ['components/debug/DevThemeSwitcher.jsx'] },
  { id: 'plugin-ui-runtime', name: 'Plugin-UI runtime (data-driven effect panels)', kind: 'editor', open: 'Used inside Overdone / Transient / Distortion / Resonance Suppressor / Compressor / Limiter windows', files: ['plugin-ui/runtime/'] },
];
