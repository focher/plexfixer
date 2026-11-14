/**
 * The renderer build for the Tauri shell.
 *
 * Same React app, same `src/shared`, same aliases as the Electron renderer —
 * only the host differs. It runs on 5174 rather than 5173 so both shells can
 * be up at once while the port is in progress, and because the scanned library
 * lives in IndexedDB, which is per origin: sharing a port would mean the two
 * builds sharing one library, and drifting to a different port when one is
 * busy would make the library look empty.
 */

import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  resolve: {
    alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') }
  },
  server: { port: 5174, strictPort: true },
  build: {
    outDir: resolve('out/tauri/renderer'),
    emptyOutDir: true,
    rollupOptions: { input: resolve('src/renderer/index.html') }
  },
  // Tauri's own output is the interesting thing in the terminal during a dev
  // run; Vite clearing the screen over it hides build errors.
  clearScreen: false
})
