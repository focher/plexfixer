/**
 * IPC channel names.
 *
 * These live in `shared` rather than in the main process so the preload bridge
 * can reference them without the renderer's type project pulling in main-process
 * source (and with it `node:fs`, `electron/main` and the rest).
 */
export const IPC = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsReset: 'settings:reset',
  overridesGet: 'overrides:get',
  overridesSet: 'overrides:set',
  envGet: 'env:get',
  envRefresh: 'env:refresh',
  pickPaths: 'dialog:pick-paths',
  pickDirectory: 'dialog:pick-directory',
  pickBinary: 'dialog:pick-binary',
  scanStart: 'scan:start',
  rescanFile: 'scan:rescan-file',
  scanCancel: 'scan:cancel',
  jobsEnqueue: 'jobs:enqueue',
  jobsList: 'jobs:list',
  jobsCancel: 'jobs:cancel',
  jobsCancelAll: 'jobs:cancel-all',
  jobsClear: 'jobs:clear',
  jobsClearQueued: 'jobs:clear-queued',
  revealPath: 'shell:reveal',
  fileContextMenu: 'shell:file-context-menu',
  initialPaths: 'app:initial-paths',
  about: 'app:about',
  saveText: 'app:save-text',
  // Events pushed to the renderer
  scanProgress: 'scan:progress',
  scanComplete: 'scan:complete',
  jobUpdate: 'job:update',
  openPaths: 'app:open-paths',
  showAbout: 'app:show-about'
} as const
