#!/usr/bin/env node
/**
 * `npm run dev`, forwarding PlexFixer's own arguments to the Electron app.
 *
 * electron-vite only hands Electron what comes after a `--`, and npm only hands
 * a script what comes after *its* `--`, so without this wrapper a folder would
 * need `npm run dev -- -- --volume …`. Both of these work instead:
 *
 *   npm run dev -- --volume "/Volumes/Media"
 *   npm run dev --volume "/Volumes/Media"
 *
 * In the second form npm keeps `--volume` for itself (it becomes
 * npm_config_volume=true) and passes the path through bare, which the app
 * scans just the same.
 */

import { spawn } from 'node:child_process'

const args = process.argv.slice(2)

// VS Code (itself Electron) sets this in some terminals; it makes Electron start
// as plain Node, and the app then fails importing BrowserWindow.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const command = process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite'
const child = spawn(command, ['dev', '--', ...args], { stdio: 'inherit', env, shell: process.platform === 'win32' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
