import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import { installTauriBridge, isTauri } from './bridge/tauri.js'
import './styles.css'

// Electron installs this same API from its preload script before the page
// loads. Under Tauri there is no preload, so it goes in here — before React
// renders, because the first thing App does is ask for the settings.
//
// Outside a Tauri window there is no machine to ask, and the app would throw on
// that first call rather than draw anything. The preview bridge stands in with
// fabricated answers so the interface can be looked at in an ordinary browser —
// a real build never reaches that branch.
if (isTauri()) {
  installTauriBridge()
} else {
  const { installPreviewBridge } = await import('./bridge/preview.js')
  installPreviewBridge()
}

const container = document.getElementById('root')
if (!container) throw new Error('Root element missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
