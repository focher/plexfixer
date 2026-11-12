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
import { hasKnownHostEntry, offeredFingerprints, resolveTarget } from './hostkey.js'

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

/**
 * Why a host-key failure happened, and whether it is the user's to accept.
 *
 * A first connection and a changed key produce nearly the same message from
 * ssh, and they could not be more different: one is the ordinary first-time
 * question, the other is the warning the whole mechanism exists to give. The
 * two are told apart by whether `known_hosts` already has an entry.
 */
async function describeHostKeyFailure(target: SshTarget, stderr: string): Promise<Partial<RemoteCheck>> {
  const changedOutright = stderr.toLowerCase().includes('remote host identification has changed')
  const resolved = await resolveTarget(target)
  const known = await hasKnownHostEntry(resolved)

  if (changedOutright || known) {
    return {
      hostKeyChanged: true,
      problem: `The key ${target.host} is offering does not match the one already recorded for it.`,
      hint:
        'Either that machine was rebuilt, or something else is answering at that address. PlexFixer will not ' +
        'accept this for you: once you are sure which it is, remove the old entry with ' +
        `\`ssh-keygen -R ${resolved.port === 22 ? resolved.hostname : `[${resolved.hostname}]:${resolved.port}`}\` and test again.`
    }
  }

  const fingerprints = await offeredFingerprints(target)
  return {
    hostKeyUnknown: fingerprints.length > 0,
    fingerprints,
    problem: `${target.host} has not been connected to before, so its key is not trusted yet.`,
    hint:
      fingerprints.length > 0
        ? 'Check the fingerprint below against the host, then press Trust this host.'
        : 'The host did not answer with a key. Check that SSH is running there, and on the port you expect.'
  }
}

function failure(target: SshTarget, stderr: string, fallback: string): RemoteCheck {
  const explained = explainSshFailure(stderr)
  return {
    ok: false,
    host: target.host,
    missing: [],
    found: [],
    problem: explained?.problem ?? stderr.trim().split('\n')[0] ?? fallback,
    hint: explained?.hint
  }
}

export async function checkRemote(target: SshTarget, settings: AppSettings): Promise<RemoteCheck> {
  const script = checkScript(settings.remoteFfmpegPath.trim() || 'ffmpeg', settings.remoteFfprobePath.trim() || 'ffprobe')
  const isHostKeyProblem = (text: string): boolean => {
    const lower = text.toLowerCase()
    return lower.includes('host key verification failed') || lower.includes('remote host identification has changed')
  }

  try {
    const result = await sshRun(target, script, { timeoutMs: 25_000 })
    if (result.code !== 0 && !result.stdout.includes('UTIL')) {
      const base = failure(target, result.stderr, `ssh exited with ${result.code}`)
      return isHostKeyProblem(result.stderr)
        ? { ...base, ...(await describeHostKeyFailure(target, result.stderr)) }
        : base
    }
    return parseCheck(target.host, result.stdout)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const base = failure(target, message, message)
    return isHostKeyProblem(message) ? { ...base, ...(await describeHostKeyFailure(target, message)) } : base
  }
}
