import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import { installTauriBridge, isTauri } from './bridge/tauri.js'
import './styles.css'

// Electron installs this same API from its preload script before the page
// loads. Under Tauri there is no preload, so it goes in here — before React
// renders, because the first thing App does is ask for the settings.
if (isTauri()) installTauriBridge()

const container = document.getElementById('root')
if (!container) throw new Error('Root element missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
