/**
 * Whether an MP4's index is at the front, read straight from the file.
 *
 * The app asks its host for the bytes; the tests check a file they have just
 * written, which is simpler done directly.
 */

import { open } from 'node:fs/promises'
import { walkBoxes } from '../src/shared/plex/probe.js'

export async function hasFaststart(filePath: string): Promise<boolean | undefined> {
  const handle = await open(filePath, 'r').catch(() => undefined)
  if (!handle) return undefined
  try {
    const { size } = await handle.stat()
    return await walkBoxes(size, async (offset, length) => {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      return buffer.subarray(0, bytesRead)
    })
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}
