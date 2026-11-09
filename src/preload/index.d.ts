import type { PlexFixerApi } from './index.js'

declare global {
  interface Window {
    plexfixer: PlexFixerApi
  }
}

export {}
