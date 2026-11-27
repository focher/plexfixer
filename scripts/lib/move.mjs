/**
 * Move a fetched file into place, around the two ways this fails for real.
 *
 * A temp directory on another volume gives EXDEV, which CI runners do often —
 * the Windows runner unpacks into `C:\...\Temp` and checks the repository out
 * on `D:`, so every rename between them fails. Windows also gives EPERM,
 * because a rename needs delete access to the source and something else is
 * holding the file open: Defender scans an executable the moment it is closed,
 * and a freshly extracted ffmpeg.exe is about the most interesting thing it
 * will see all day. That scan ends in a moment, so the rename is retried
 * before falling back to a copy — which needs only to read the source, and so
 * goes through while the scan is still running.
 *
 * In its own file because it was not in one. `fetch-ffmpeg.mjs` had this, and
 * `dovi-tool.mjs` — added later, and the only tool that is downloaded ready
 * built rather than compiled where it lands — called `rename` directly. It hit
 * EXDEV on every Windows build, reported itself as skipped because it is
 * written never to fail a release, and so dovi_tool.exe has never once shipped
 * on Windows. Every Dolby Vision profile 7 film there failed for want of it.
 */

import { copyFile, rename, rm } from 'node:fs/promises'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function move(from, to) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (error.code === 'EXDEV') break
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
      if (attempt === 5) break
      await delay(100 * 2 ** attempt)
    }
  }
  await copyFile(from, to)
  // The source sits in a temp directory that is removed wholesale afterwards,
  // so a lock that outlives the copy is not worth failing the fetch over.
  await rm(from, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
}
