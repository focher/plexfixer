/**
 * What the window is allowed to ask the native side for.
 *
 * A permission that is missing from this file does not fail a build, fail a
 * typecheck, or fail at all in the preview — the preview never crosses the
 * bridge. It fails once, in the installed app, as a rejected promise from a
 * plugin call, and if nothing is awaiting that promise it fails as nothing
 * whatsoever. That is what happened to **Save diagnostics…**: `dialog:allow-save`
 * was never listed, so asking for a save dialog threw, the rejection went
 * nowhere, and the menu item did exactly nothing for anyone who pressed it.
 *
 * So each plugin call the app makes is named here beside the permission it
 * needs. The test is dull on purpose: it is a list of things that are easy to
 * forget and impossible to notice.
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

interface Capability {
  permissions: string[]
}

const capability = JSON.parse(
  await readFile(join(root, 'src-tauri/capabilities/default.json'), 'utf8')
) as Capability

/** The plugin calls the renderer makes, and what each one needs to be allowed. */
const NEEDED: { permission: string; because: string }[] = [
  { permission: 'dialog:allow-open', because: 'Add files… and Add folder… open a file dialog' },
  { permission: 'dialog:allow-save', because: 'Save diagnostics… opens a save dialog' },
  { permission: 'opener:allow-open-url', because: 'release notes and service pages open in a browser' },
  { permission: 'opener:allow-reveal-item-in-dir', because: 'a finished repair can be shown in the file manager' },
  { permission: 'os:allow-platform', because: 'the About panel names the platform' },
  { permission: 'updater:default', because: 'the app offers its own updates' }
]

describe('the window may ask for everything the app actually asks for', () => {
  for (const { permission, because } of NEEDED) {
    it(`allows ${permission} — ${because}`, () => {
      expect(capability.permissions).toContain(permission)
    })
  }

  it('asks for nothing twice', () => {
    expect(new Set(capability.permissions).size).toBe(capability.permissions.length)
  })
})

describe('the renderer does not reach for a dialog it has not been allowed', () => {
  it('uses only the dialog calls the capability lists', async () => {
    const source = await readFile(join(root, 'src/renderer/src/bridge/tauri.ts'), 'utf8')
    // `import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'`
    const imported = /from '@tauri-apps\/plugin-dialog'/.test(source)
      ? [...source.matchAll(/\b(open|save|message|confirm|ask)\s+as\s+\w+/g)].map((match) => match[1])
      : []
    for (const call of imported) {
      expect(capability.permissions, `plugin-dialog's ${call}() needs dialog:allow-${call}`).toContain(
        `dialog:allow-${call}`
      )
    }
  })
})
