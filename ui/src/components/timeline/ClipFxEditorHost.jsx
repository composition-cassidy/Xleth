import ClipVibratoEditorPanel from './ClipVibratoEditorPanel.jsx'
import ClipScratchEditorPanel from './ClipScratchEditorPanel.jsx'

// Global per-clip FX editor host.
//
// The clip-identity twin of components/mixer/EffectEditorHost.jsx, and it exists
// for exactly the same reason.
//
// Per-clip modulation editors (Vibrato and Scratch) are `position: fixed`,
// viewport-anchored floating windows. They must be
// mounted at the windowing root — NOT inside the Timeline panel — so they are
// never a DOM descendant of a floating PanelFrame.
//
// A floating PanelFrame positions itself with `transform: translate3d(...)`
// (see PanelFrame.tsx). A CSS transform establishes a containing block for
// `position: fixed` descendants and clips them to the frame's overflow box. An
// editor mounted inside TimelineView would therefore be trapped in the
// Timeline's frame whenever the Timeline floats, and roam free only when it
// happened to be docked. Hosting the editors here, outside every PanelFrame
// subtree, makes them behave identically no matter where the Timeline is.
//
// Ownership model:
//   - The Timeline clip dropdown only *requests* an editor, via
//     openClipFxEditor('vibrato', clipId) in clipFxEditorOpeners.js. It never
//     owns the editor's DOM placement or lifecycle.
//   - This host owns mounting. Each panel subscribes to its own store and
//     renders nothing until that store has a `target`, so an always-mounted host
//     costs nothing while idle.
//   - Clip identity (`{ clipId }`) lives entirely in the editor stores.

export default function ClipFxEditorHost() {
  return (
    <div className="clip-fx-editor-host" data-testid="clip-fx-editor-host">
      <ClipVibratoEditorPanel />
      <ClipScratchEditorPanel />
    </div>
  )
}
