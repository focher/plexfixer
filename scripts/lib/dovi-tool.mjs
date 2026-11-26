/**
 * Fetching `dovi_tool`, the only thing that converts Dolby Vision profile 7.
 *
 * Profile 7 is what a UHD Blu-ray rip carries: a base layer, an enhancement
 * layer, and an RPU. Clients that cannot decode Dolby Vision get the base
 * layer, which is fine — but Plex and most hardware decoders cannot handle the
 * dual-layer stream at all, so the file either fails to play or plays as
 * something nobody wants to watch. Profile 8.1 is the single-layer form with
 * an HDR10 base, and it plays everywhere.
 *
 * ffmpeg cannot do the conversion. Nothing in libav parses an RPU well enough
 * to rewrite one, and libplacebo — which reads them for the profile 5 path —
 * only applies them to the picture. `dovi_tool` does exactly this one thing,
 * is the tool every guide on the subject names, and is MIT licensed, so it
 * ships beside ffmpeg as another separate executable rather than being linked
 * into anything.
 *
 * It is downloaded rather than compiled: the project publishes binaries for
 * every platform here, which `mp4v2` and `qt-faststart` do not. Every download
 * is held to a pinned SHA-256 from the release page, for the same reason as
 * ffmpeg's — these go inside a signed installer.
 *
 * Optional, like the others. Without it the app reports a profile 7 file and
 * declines to touch it, which is what it did before this existed.
 */

import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The release, pinned.
 *
 * macOS ships one universal binary covering both architectures, which is why
 * the two Mac entries name the same asset. The Linux builds are musl-linked
 * and so have no glibc floor to worry about.
 *
 * The hashes are the `digest` GitHub lists for each release asset. To move to
 * a newer release, change the version and all four hashes together.
 */
export const VERSION = '2.3.4'

const BASE = `https://github.com/quietvoid/dovi_tool/releases/download/${VERSION}`

export const ASSETS = {
  'darwin-arm64': {
    file: `dovi_tool-${VERSION}-universal-macOS.zip`,
    sha256: '30d4f512eb67b7f1632cd28be5c62989bedad23f4710578aafc20c384b48ece6',
    format: 'zip',
  },
  'darwin-x64': {
    file: `dovi_tool-${VERSION}-universal-macOS.zip`,
    sha256: '30d4f512eb67b7f1632cd28be5c62989bedad23f4710578aafc20c384b48ece6',
    format: 'zip',
  },
  'win32-x64': {
    file: `dovi_tool-${VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: '0d9733d311dfe49f9dca0c350f7e6d978182673d333c6f07f7365daf9e6c81eb',
    format: 'zip',
  },
  'linux-x64': {
    file: `dovi_tool-${VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    sha256: '1844258e13c26607b32224bf1fa82b595d3b35949f5467405fda560daad32b3f',
    format: 'tar',
  },
}

export function assetUrl(platformKey) {
  const asset = ASSETS[platformKey]
  return asset ? `${BASE}/${asset.file}` : undefined
}

/** What the executable is called in a platform folder. */
export function toolName(platformKey) {
  return platformKey.startsWith('win32') ? 'dovi_tool.exe' : 'dovi_tool'
}

export function haveDoviTool(outputDir, platformKey) {
  return existsSync(join(outputDir, toolName(platformKey)))
}

/** Find the executable anywhere inside an extracted tree. */
async function findTool(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = await findTool(full)
      if (found) return found
    } else if (entry.isFile()) {
      const stem = entry.name.toLowerCase()
      if (stem === 'dovi_tool' || stem === 'dovi_tool.exe') return full
    }
  }
  return undefined
}

/**
 * Put `dovi_tool` in the platform folder, and say what happened.
 *
 * Never throws. A profile 7 conversion is one feature of many, and a release
 * that fails because GitHub was slow would be the wrong trade — the app checks
 * for the binary at run time and says plainly when it is not there.
 *
 * `download` and `extract` are passed in rather than imported so this shares
 * the checksum-verifying download the ffmpeg fetch already uses.
 */
export async function ensureDoviTool({ platformKey, outputDir, workDir, force = false, download, extract }) {
  const asset = ASSETS[platformKey]
  if (!asset) return { state: 'skipped', reason: `no dovi_tool build for ${platformKey}` }

  const destination = join(outputDir, toolName(platformKey))
  if (!force && existsSync(destination)) return { state: 'present', version: VERSION }

  try {
    await mkdir(workDir, { recursive: true })
    const archive = join(workDir, asset.file)
    await download(assetUrl(platformKey), archive, { sha256: asset.sha256 })

    const unpacked = join(workDir, 'unpacked')
    await rm(unpacked, { recursive: true, force: true })
    await mkdir(unpacked, { recursive: true })
    await extract(archive, asset.format, unpacked)

    const found = await findTool(unpacked)
    if (!found) return { state: 'skipped', reason: 'the archive held no dovi_tool executable' }

    await mkdir(outputDir, { recursive: true })
    await rm(destination, { force: true })
    await rename(found, destination)
    if (!platformKey.startsWith('win32')) await chmod(destination, 0o755)
    return { state: 'fetched', version: VERSION }
  } catch (error) {
    return { state: 'skipped', reason: String(error?.message ?? error) }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
