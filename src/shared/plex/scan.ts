/**
 * Walking a set of paths and probing what is there.
 *
 * The loop is the same whichever shell is running it and whichever machine the
 * files are on, so it lives here: the two things that differ — how to find the
 * files, and how to clean up leftovers — are handed in.
 *
 * Results stream out one file at a time rather than arriving together at the
 * end, so a long scan fills the table as it goes and the library is saved
 * progressively. A scan of ten thousand files that reports nothing until it
 * finishes is indistinguishable from one that has hung.
 */

import type {
  AnalysisResult,
  AppSettings,
  ScanCompleteEvent,
  ScanError,
  ScanProgressEvent
} from '../types.js'
import type { ProbeHost } from '../host.js'
import { isTemporaryName } from '../temporary.js'
import { analyzeFile } from './analyze.js'
import { ProbeError, probeFile } from './probe.js'

export interface ScanRequest {
  scanId: string
  inputPaths: string[]
  settings: AppSettings
  host: ProbeHost
  ffprobePath: string
  /** Every media file under these roots, as absolute paths. */
  findMedia: (roots: string[], extensions: string[], recursive: boolean) => Promise<string[]>
  signal: AbortSignal
  onProgress: (event: ScanProgressEvent) => void
  /**
   * Remove the leftover repair temporaries the walk turned up. Left out where
   * the shell cannot write yet, in which case they are simply not listed as
   * library files.
   */
  cleanTemporaries?: (paths: string[]) => Promise<{ path: string; bytes: number }[]>
}

/** A scanned path and the folder it stands for. */
export interface ScanRoot {
  /** The path as it was given to the scan. */
  input: string
  /** That path if it is a folder, otherwise the folder holding it. */
  root: string
}

/**
 * Resolve each scanned path to the folder it stands for, once.
 *
 * This used to be worked out again for every file found, which meant a `stat`
 * per input path per file. On another machine each of those is a command over
 * the link, so a thousand files under one folder asked the same question a
 * thousand times and got the same answer every time. The inputs do not change
 * during a scan, so neither does this.
 */
export async function resolveScanRoots(inputPaths: string[], host: ProbeHost): Promise<ScanRoot[]> {
  const { dirname } = host.paths
  const roots: ScanRoot[] = []
  for (const input of inputPaths) {
    const info = await host.stat(input)
    if (!info) continue
    roots.push({ input, root: info.isDirectory ? input : dirname(input) })
  }
  return roots
}

/**
 * Which of the scanned paths a file came from.
 *
 * Used to re-scan the right folder later, and to tell a file that is still in
 * the library from one whose folder is no longer being watched. Pure, and
 * decided from roots resolved up front, so it costs nothing per file.
 */
export function scanRootOf(roots: ScanRoot[], filePath: string, sep: string): string | undefined {
  for (const { input, root } of roots) {
    if (filePath === input) return root
    if (filePath.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return root
  }
  return undefined
}

export async function runScan(request: ScanRequest): Promise<ScanCompleteEvent> {
  const { scanId, inputPaths, settings, host, signal, onProgress } = request

  // Resolved once, before anything is probed: on a remote host each of these
  // is a command over the link, and the answer is the same for every file.
  const roots = await resolveScanRoots(inputPaths, host)
  const { sep } = host.paths

  const found = await request.findMedia(inputPaths, settings.mediaExtensions, settings.recursive)
  // A repair's temporary file has a media extension but is not a library file:
  // it is either in use right now or left over from a repair that never
  // finished. Either way it is not something to report on.
  const files = found.filter((path) => !isTemporaryName(path))
  const temporaries = found.filter((path) => isTemporaryName(path))

  onProgress({ scanId, processed: 0, total: files.length })

  const errors: ScanError[] = []

  // ffprobe is I/O bound and cheap; a little parallelism keeps a network share
  // from dominating the wall-clock time without thrashing it.
  const parallelism = Math.max(1, Math.min(8, settings.concurrency * 2))
  let cursor = 0
  let processed = 0

  const worker = async (): Promise<void> => {
    while (!signal.aborted) {
      const index = cursor++
      if (index >= files.length) return
      const filePath = files[index]
      let result: AnalysisResult | undefined
      try {
        const probed = await probeFile(filePath, { ffprobePath: request.ffprobePath, host })
        result = {
          ...analyzeFile(probed, settings),
          scannedAt: Date.now(),
          scanRoot: scanRootOf(roots, filePath, sep)
        }
      } catch (error) {
        errors.push({
          path: filePath,
          message:
            error instanceof ProbeError ? error.message : error instanceof Error ? error.message : String(error)
        })
      } finally {
        processed++
        onProgress({ scanId, processed, total: files.length, currentPath: filePath, result })
      }
    }
  }

  await Promise.all(Array.from({ length: parallelism }, worker))

  // A cancelled scan did not look at everything, so it has no business
  // deciding which leftovers are stale.
  const cleaned =
    signal.aborted || !request.cleanTemporaries ? [] : await request.cleanTemporaries(temporaries)

  return {
    scanId,
    inputPaths,
    errors,
    foundPaths: files,
    cancelled: signal.aborted,
    ...(cleaned.length > 0 ? { cleaned } : {})
  }
}
