/**
 * What the build is pinned to, and what the NOTICE says it is pinned to.
 *
 * `dovi_tool` goes inside a signed installer, so the version and the hashes
 * are the whole of the guarantee about what shipped. The pair drifting apart
 * is a quiet kind of wrong: the app works either way, and only the licence
 * file is a lie.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM helper shared with the build scripts
import { ASSETS, VERSION, assetUrl, toolName } from '../scripts/lib/dovi-tool.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const assets = ASSETS as Record<string, { file: string; sha256: string; format: string }>

describe('the pinned dovi_tool', () => {
  it('covers every platform an installer is built for', () => {
    expect(Object.keys(assets).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'])
  })

  it('pins a full SHA-256 for each one', () => {
    for (const [platform, asset] of Object.entries(assets)) {
      expect(asset.sha256, platform).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('names the version in every asset, so a half-done bump cannot pass', () => {
    for (const [platform, asset] of Object.entries(assets)) {
      expect(asset.file, platform).toContain(VERSION)
    }
  })

  it('takes both Mac architectures from the one universal binary', () => {
    expect(assets['darwin-arm64'].sha256).toBe(assets['darwin-x64'].sha256)
    expect(assets['darwin-arm64'].file).toContain('universal')
  })

  it('downloads from the project’s own releases and nowhere else', () => {
    for (const platform of Object.keys(assets)) {
      expect(assetUrl(platform)).toMatch(
        /^https:\/\/github\.com\/quietvoid\/dovi_tool\/releases\/download\//
      )
    }
  })

  it('gives Windows the .exe and everything else the bare name', () => {
    expect(toolName('win32-x64')).toBe('dovi_tool.exe')
    expect(toolName('darwin-arm64')).toBe('dovi_tool')
    expect(toolName('linux-x64')).toBe('dovi_tool')
  })

  it('is the version NOTICE.md credits, under the licence it credits', async () => {
    const notice = await readFile(join(ROOT, 'NOTICE.md'), 'utf8')
    expect(notice).toContain('## dovi_tool')
    expect(notice).toContain('quietvoid/dovi_tool')
    expect(notice).toContain('MIT License')
    expect(notice).toContain(`\`${VERSION}\``)
    for (const asset of Object.values(assets)) {
      expect(notice, asset.file).toContain(asset.file)
    }
  })
})
