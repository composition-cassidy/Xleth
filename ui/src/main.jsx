import React from 'react'
import ReactDOM from 'react-dom/client'
import XlethRoot from './XlethRoot.jsx'
import NodeEditorWindow from './NodeEditorWindow.jsx'
import { ThemeProvider } from './theming/runtime/ThemeProvider'

// Hanken Grotesk font weights
import '@fontsource/hanken-grotesk/300.css'
import '@fontsource/hanken-grotesk/400.css'
import '@fontsource/hanken-grotesk/500.css'
import '@fontsource/hanken-grotesk/600.css'
import '@fontsource/hanken-grotesk/700.css'

import './styles/app.css'

const params = new URLSearchParams(window.location.search)
const view = params.get('view')
const storeKey = params.get('key')
const trackPos = params.get('pos')

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
