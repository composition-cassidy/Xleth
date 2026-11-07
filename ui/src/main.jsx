// Must stay the first import: the first CSS in the bundle fixes the cascade
// layer order (see styles/layers.css and ui/DESIGN.md section 2).
import './styles/layers.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import XlethRoot from './XlethRoot.jsx'
import NodeEditorWindow from './NodeEditorWindow.jsx'
import { ThemeProvider } from './theming/runtime/ThemeProvider'

// UI font weights
import '@fontsource/inter/300.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/noto-sans/300.css'
import '@fontsource/noto-sans/400.css'
import '@fontsource/noto-sans/500.css'
import '@fontsource/noto-sans/600.css'
import '@fontsource/noto-sans/700.css'
// Timecode and bars|beats readouts (ui/DESIGN.md section 4).
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'

import './styles/legacy.css'
import './ui-kit/tokens.css'

const params = new URLSearchParams(window.location.search)
const view = params.get('view')
const storeKey = params.get('key')
const trackPos = params.get('pos')
// Dev-only UI kit gallery (ui/src/ui-kit/Gallery.jsx): compiled in only when built
// with VITE_XLETH_UI_KIT_GALLERY=1 (`npm run dev:ui-kit`, `npm run shots:gallery`),
// and shown at `?view=ui-kit`. The normal build never contains it.
const UI_KIT_GALLERY = import.meta.env.VITE_XLETH_UI_KIT_GALLERY === '1' || import.meta.env.VITE_XLETH_UI_KIT_GALLERY === 'true'
const Gallery = UI_KIT_GALLERY ? React.lazy(() => import('./ui-kit/Gallery.jsx')) : null

console.log('[UI] App mounting', view ? `(view=${view}, key=${storeKey})` : '')

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      {Gallery && view === 'ui-kit'
        ? <React.Suspense fallback={null}><Gallery /></React.Suspense>
        : view === 'node-editor' && storeKey
          ? <NodeEditorWindow storeKey={storeKey} trackPos={trackPos ? Number(trackPos) : null} />
          : <XlethRoot />}
    </ThemeProvider>
  </React.StrictMode>
)
