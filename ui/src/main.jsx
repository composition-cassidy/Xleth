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

import './styles/app.css'

const params = new URLSearchParams(window.location.search)
const view = params.get('view')
const storeKey = params.get('key')
const trackPos = params.get('pos')
const initialBackdropMode = ['native-acrylic', 'image', 'video'].includes(window.xleth?.backdrop?.current?.mode)
  ? window.xleth.backdrop.current.mode
  : 'off'

if (view === 'node-editor') {
  document.documentElement.removeAttribute('data-xleth-backdrop')
} else {
  document.documentElement.setAttribute('data-xleth-backdrop', initialBackdropMode)
}

console.log('[UI] App mounting', view ? `(view=${view}, key=${storeKey})` : '')

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      {view === 'node-editor' && storeKey
        ? <NodeEditorWindow storeKey={storeKey} trackPos={trackPos ? Number(trackPos) : null} />
        : <XlethRoot />}
    </ThemeProvider>
  </React.StrictMode>
)
