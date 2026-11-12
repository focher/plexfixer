/**
 * Talking to the machine that holds the files, over the system `ssh`.
 *
 * Shelling out to `ssh` rather than embedding an SSH library is the whole
 * design: the user's `~/.ssh/config`, their keys, their agent, their
 * `known_hosts` and their jump hosts all apply, and PlexFixer never sees a
 * credential. The cost is that authentication has to work without a prompt —
 * `BatchMode=yes` is set deliberately, because a password prompt on a pipe
 * would simply hang — so a key (or an agent) is required.
 *
 * Host keys are *not* auto-accepted. A first connection that fails host-key
 * verification is reported with the fix (connect once from a terminal), which
 * is the honest thing to do rather than trusting whatever answers on that
 * address.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface SshTarget {
  /** `user@host`, or a Host alias from the user's ssh config. */
  host: string
  /** Only when it differs from what ssh would use by itself. */
  port?: number
  /**
   * A private key to authenticate with. Without one, ssh uses the agent and
   * the default identities, which is what most setups want; with one, only
   * that key is offered, so a host that rejects it fails quickly and clearly
   * rather than after trying everything else.
   */
  identityFile?: string
}

export interface SshResult {
  stdout: string
  stderr: string
  code: number | null
}

export class SshError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly stderr: string
  ) {
    super(message)
    this.name = 'SshError'
  }
}

/**
 * Wrap one value so a POSIX shell reads it as a single literal argument.
 *
 * Everything crossing to the far end goes through here: a path with a space,
 * a quote or a `$` in it is ordinary in a media library, and the remote shell
 * would otherwise split or expand it.
 */
export function shellQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** A whole command line, quoted argument by argument. */
export function shellCommand(parts: string[]): string {
  return parts.map(shellQuote).join(' ')
}

/**
 * The ssh arguments for running one command line on the far end.
 *
 * `-T` because none of this wants a terminal, and `-n` would close stdin,
 * which ffmpeg's `-progress pipe:1` does not need but a future caller might.
 */
export function sshArgs(target: SshTarget, remoteCommand: string): string[] {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=20',
    ...(target.identityFile ? ['-i', target.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
    ...(target.port ? ['-p', String(target.port)] : []),
    target.host,
    remoteCommand
  ]
}

/**
 * Turn ssh's own failure into something a person can act on.
 *
 * These are the three that actually happen, and each has a different fix; a
 * bare "exit code 255" has none.
 */
export function explainSshFailure(stderr: string): { problem: string; hint?: string } | undefined {
  const text = stderr.toLowerCase()
  if (text.includes('host key verification failed') || text.includes('remote host identification has changed')) {
    return {
      problem: 'The host key is not trusted yet (or has changed).',
      hint: 'Connect once from a terminal — `ssh <host>` — and accept the key, then try again.'
    }
  }
  if (text.includes('permission denied')) {
    return {
      problem: 'The host refused the key.',
      hint: 'PlexFixer never asks for a password, so key-based login has to work on its own: `ssh-copy-id <host>`, or add the key to your agent.'
    }
  }
  if (text.includes('could not resolve hostname') || text.includes('name or service not known')) {
    return { problem: 'That hostname does not resolve.', hint: 'Check the spelling, or use the IP address.' }
  }
  if (text.includes('connection refused')) {
    return { problem: 'Nothing is listening for SSH there.', hint: 'Check the host is up and SSH is enabled on it.' }
  }
  if (text.includes('connection timed out') || text.includes('operation timed out')) {
    return { problem: 'The host did not answer in time.', hint: 'Check the address, and that you are on the same network as it.' }
  }
  return undefined
}

export interface SshRunOptions {
  timeoutMs?: number
  /** ffprobe JSON for a long file is large; the default is generous. */
  maxBytes?: number
  signal?: AbortSignal
}

/** Run a command line on the far end and collect its output. */
export function sshRun(target: SshTarget, remoteCommand: string, options: SshRunOptions = {}): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', sshArgs(target, remoteCommand), { windowsHide: true })
    const limit = options.maxBytes ?? 32 * 1024 * 1024
    let stdout = ''
    let stderr = ''
    let settled = false
    let overflowed = false

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL')
          finish(() => reject(new SshError(`ssh timed out after ${options.timeoutMs}ms`, null, stderr)))
        }, options.timeoutMs)
      : undefined

    const onAbort = (): void => {
      child.kill('SIGTERM')
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length > limit) {
        overflowed = true
        return
      }
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // Only the tail matters, and a failing command can be noisy.
      stderr = (stderr + chunk).slice(-8192)
    })

    child.on('error', (error) =>
      finish(() =>
        reject(
          new SshError(
            error.message.includes('ENOENT') ? 'The ssh command is not available on this machine.' : error.message,
            null,
            stderr
          )
        )
      )
    )

    child.on('close', (code) =>
      finish(() => {
        if (overflowed) {
          reject(new SshError('The remote command produced more output than PlexFixer will read.', code, stderr))
          return
        }
        resolve({ stdout, stderr, code })
      })
    )
  })
}

/** Run a command, and throw with ssh's own words when it fails. */
export async function sshCheck(
  target: SshTarget,
  remoteCommand: string,
  options?: SshRunOptions
): Promise<string> {
  const result = await sshRun(target, remoteCommand, options)
  if (result.code !== 0) {
    const explained = explainSshFailure(result.stderr)
    throw new SshError(
      explained?.problem ?? result.stderr.trim().split('\n')[0] ?? `ssh exited with ${result.code}`,
      result.code,
      result.stderr
    )
  }
  return result.stdout
}

/** Start a long-running remote command, streaming its output as it goes. */
export function sshSpawn(target: SshTarget, remoteCommand: string): ChildProcessWithoutNullStreams {
  return spawn('ssh', sshArgs(target, remoteCommand), { windowsHide: true })
}
