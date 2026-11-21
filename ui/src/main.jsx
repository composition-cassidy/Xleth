// Must stay the first import: the first CSS in the bundle fixes the cascade
// layer order (see styles/layers.css and ui/DESIGN.md section 2).
import './styles/layers.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import XlethRoot from './XlethRoot.jsx'
import NodeEditorWindow from './NodeEditorWindow.jsx'
import { ThemeProvider } from './theming/runtime/ThemeProvider'
import { installWheelToHorizontalScroll } from './hooks/wheelToHorizontalScroll'

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
import './ui-kit/motion.css'
import { useMotionStore } from './stores/motionStore.js'

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

// How much the interface moves (Settings > Appearance > Motion). Until this resolves, and in
// every window that never calls it, nothing animates (ui-kit/motion.css: no attribute is flat).
useMotionStore.getState().hydrate()

// Plain wheel over a sideways scrollbar scrolls it sideways (see hooks/wheelToHorizontalScroll.js).
installWheelToHorizontalScroll()

// Boot gate. The workspace window is created while the engine is still loading
// its project, so this bundle is usually evaluated before the project is in.
// Everything above this line is project-independent and has already run; the
// mount waits for main to say the project is ready, so the UI still hydrates
// from a fully loaded project (ui/main.js, "Workspace window boot"). Windows
// that were not created early — and anything without the bridge (tests, the
// Vite page in a plain browser) — are told "ready" at once or skip the wait.
const boot = window.xleth?.boot

// Reports the first commit to main, which shows the window on it. Two frames
// so the commit has actually been painted; the timer covers a window whose
// frames are not being produced yet.
function BootSignal() {
  React.useEffect(() => {
    if (!boot?.notifyMounted) return undefined
    let sent = false
    const send = () => { if (!sent) { sent = true; boot.notifyMounted() } }
    const raf = requestAnimationFrame(() => requestAnimationFrame(send))
    const timer = setTimeout(send, 150)
    return () => { cancelAnimationFrame(raf); clearTimeout(timer) }
  }, [])
  return null
}

function mount() {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <ThemeProvider>
        <BootSignal />
        {Gallery && view === 'ui-kit'
          ? <React.Suspense fallback={null}><Gallery /></React.Suspense>
          : view === 'node-editor' && storeKey
            ? <NodeEditorWindow storeKey={storeKey} trackPos={trackPos ? Number(trackPos) : null} />
            : <XlethRoot />}
      </ThemeProvider>
    </React.StrictMode>
  )
}

if (boot?.whenProjectReady) boot.whenProjectReady().then(mount, mount)
else mount()
