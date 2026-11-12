/**
 * Does the far end have what a scan and a repair need?
 *
 * Asked once, in one round trip, before anything is run there — because the
 * failure mode this prevents is a repair that dies half way through on a
 * machine the user cannot see. The list is exactly what the remote host
 * implementation uses: ffmpeg and ffprobe to do the work, and a handful of
 * POSIX utilities to walk, measure, move and stop it.
 */

import type { AppSettings, RemoteCheck } from '@shared/types.js'
import { explainSshFailure, shellQuote, sshRun, type SshTarget } from './ssh.js'

/**
 * The utilities the remote host calls by name.
 *
 * `test` is a shell builtin and `printf` is used to produce this very output,
 * so neither can be missing by the time an answer comes back.
 */
export const REQUIRED_UTILITIES = ['ls', 'find', 'stat', 'df', 'mkdir', 'mv', 'rm', 'tail', 'head', 'base64', 'pkill']

/** One script, one round trip: platform, utilities, then both binaries. */
export function checkScript(ffmpeg: string, ffprobe: string): string {
  const lines = [
    `printf 'PLATFORM\\t%s\\n' "$(uname -s -m 2>/dev/null)"`,
    `for u in ${REQUIRED_UTILITIES.join(' ')}; do`,
    `  if command -v "$u" >/dev/null 2>&1; then printf 'UTIL\\t%s\\thave\\n' "$u"; else printf 'UTIL\\t%s\\tmiss\\n' "$u"; fi`,
    `done`
  ]
  for (const [label, binary] of [
    ['FFMPEG', ffmpeg],
    ['FFPROBE', ffprobe]
  ] as const) {
    const quoted = shellQuote(binary)
    lines.push(
      `if command -v ${quoted} >/dev/null 2>&1; then`,
      `  printf '${label}\\t%s\\n' "$(command -v ${quoted})"`,
      `  printf '${label}V\\t%s\\n' "$(${quoted} -version 2>/dev/null | head -n 1)"`,
      `fi`
    )
  }
  return lines.join('\n')
}

export function parseCheck(host: string, output: string): RemoteCheck {
  const check: RemoteCheck = { ok: false, host, missing: [], found: [] }
  for (const line of output.split('\n')) {
    const [tag, first, second] = line.split('\t')
    if (tag === 'PLATFORM') check.platform = first?.trim() || undefined
    else if (tag === 'UTIL' && first) (second?.trim() === 'have' ? check.found : check.missing).push(first)
    else if (tag === 'FFMPEG') check.ffmpegPath = first?.trim() || undefined
    else if (tag === 'FFMPEGV') check.ffmpegVersion = first?.trim() || undefined
    else if (tag === 'FFPROBE') check.ffprobePath = first?.trim() || undefined
    else if (tag === 'FFPROBEV') check.ffprobeVersion = first?.trim() || undefined
  }

  // Both binaries and every utility, or the answer is no — a partial yes here
  // becomes a repair that fails on a machine nobody is watching.
  const missingBinaries = [!check.ffmpegPath && 'ffmpeg', !check.ffprobePath && 'ffprobe'].filter(
    (name): name is string => typeof name === 'string'
  )
  if (missingBinaries.length > 0) {
    check.problem = `${missingBinaries.join(' and ')} ${missingBinaries.length === 1 ? 'is' : 'are'} not on ${host}.`
    check.hint =
      'Install FFmpeg there (most NAS systems have a package for it), or give the full remote path to each binary below.'
    return check
  }
  if (check.missing.length > 0) {
    check.problem = `${host} is missing ${check.missing.join(', ')}.`
    check.hint = 'These are standard POSIX utilities; on a stripped-down system, installing coreutils and procps covers them.'
    return check
  }

  check.ok = true
  return check
}

export async function checkRemote(target: SshTarget, settings: AppSettings): Promise<RemoteCheck> {
  const script = checkScript(settings.remoteFfmpegPath.trim() || 'ffmpeg', settings.remoteFfprobePath.trim() || 'ffprobe')
  try {
    const result = await sshRun(target, script, { timeoutMs: 25_000 })
    if (result.code !== 0 && !result.stdout.includes('UTIL')) {
      const explained = explainSshFailure(result.stderr)
      return {
        ok: false,
        host: target.host,
        missing: [],
        found: [],
        problem: explained?.problem ?? result.stderr.trim().split('\n')[0] ?? `ssh exited with ${result.code}`,
        hint: explained?.hint
      }
    }
    return parseCheck(target.host, result.stdout)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const explained = explainSshFailure(message)
    return {
      ok: false,
      host: target.host,
      missing: [],
      found: [],
      problem: explained?.problem ?? message,
      hint: explained?.hint
    }
  }
}
