import type { PlexFixerApi } from './bridge/tauri.js'

declare global {
  interface Window {
    /**
     * The app's only way to reach the machine it is running on.
     *
     * Installed by the bridge before React renders. Everything behind it is a
     * Tauri command; nothing in the UI knows that.
     */
    plexfixer: PlexFixerApi
  }
}
