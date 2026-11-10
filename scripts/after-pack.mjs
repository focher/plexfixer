/**
 * electron-builder afterPack hook.
 *
 * Asserts that the bundled ffmpeg/ffprobe actually landed where the app looks
 * for them (`<resources>/bin/<platform>-<arch>/`). Without this check, a
 * mis-resolved `extraResources` path ships an installer that looks fine and
 * then cannot probe a single file — a failure that only shows up on the user's
 * machine.
 */

import { access, constants, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { licenseOf } from './lib/ffmpeg-license.mjs'

/** electron-builder's Arch enum index -> the `process.arch` value it means. */
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

export default async function afterPack(context) {
  const platform = context.electronPlatformName // 'darwin' | 'win32' | 'linux'
  const arch = ARCH_NAMES[context.arch] ?? String(context.arch)

  const resourcesDir =
    platform === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources')

  const binDir = join(resourcesDir, 'bin', `${platform}-${arch}`)
  const suffix = platform === 'win32' ? '.exe' : ''
  const expected = ['ffmpeg', 'ffprobe'].map((name) => join(binDir, `${name}${suffix}`))

  const missing = []
  for (const path of expected) {
    try {
      await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    } catch {
      missing.push(path)
    }
  }

  if (missing.length > 0) {
    let contents = '(bin directory not present)'
    try {
      contents = (await readdir(join(resourcesDir, 'bin'))).join(', ') || '(empty)'
    } catch {
      /* leave the default */
    }
    throw new Error(
      `afterPack: bundled ffmpeg is missing from the ${platform}-${arch} build.\n` +
        `  Expected: ${missing.join('\n            ')}\n` +
        `  Found in resources/bin: ${contents}\n` +
        '  Run "npm run fetch:ffmpeg -- --all" before building, and check the\n' +
        '  extraResources paths in electron-builder.yml.'
    )
  }

  // One flag makes a build undistributable, and nothing about the file says
  // so. This is the last point where it can still be caught.
  for (const path of expected) {
    const license = await licenseOf(path)
    if (license.redistributable === false) {
      throw new Error(
        `afterPack: ${path} is an ${license.reason} FFmpeg build.\n` +
          '  That may be used but not redistributed, so it cannot go into an installer.\n' +
          '  Replace it in resources/bin and rebuild — see NOTICE.md.'
      )
    }
    if (license.redistributable === true) {
      console.log(`  • ${basename(path)} licence: ${license.license}`)
    } else {
      console.log(`  ! ${basename(path)} build configuration unreadable; licence unverified`)
    }
  }

  // Windows and Linux ship a shared build: the executables are a few hundred
  // kilobytes and do nothing without libav* beside them. An installer that
  // passed the check above and still cannot probe a file is the exact failure
  // this hook exists to prevent.
  if (platform === 'win32' || platform === 'linux') {
    const libraries = (await readdir(binDir)).filter((name) => /^(av|sw)[a-z]+[-.]/.test(name))
    if (libraries.length === 0) {
      throw new Error(
        `afterPack: the ${platform}-${arch} build has ffmpeg but none of its shared libraries.\n` +
          `  Found in ${binDir}: ${(await readdir(binDir)).join(', ') || '(empty)'}\n` +
          '  Re-run "npm run fetch:ffmpeg -- --force" to fetch the shared build in full.'
      )
    }
    console.log(`  • bundled ffmpeg verified  path=${binDir}  libraries=${libraries.length}`)
    return
  }

  console.log(`  • bundled ffmpeg verified  path=${binDir}`)
}
