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
import { join } from 'node:path'

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

  console.log(`  • bundled ffmpeg verified  path=${binDir}`)
}
