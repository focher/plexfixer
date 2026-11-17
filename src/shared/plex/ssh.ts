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

import type { HostProcess, RepairHost } from '../host.js'

/**
 * Just enough of a host to start `ssh` with: where the command runs from, and
 * what kind of machine that is. The second matters because connection sharing
 * is a property of the local ssh client, not of the host being reached.
 */
export type SshRunner = Pick<RepairHost, 'spawnProcess' | 'paths'>

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
 * Refuse a host that ssh would read as one of its own options.
 *
 * The host is typed into Settings and handed to `ssh` as an argument, and an
 * argument that begins with a dash is an option wherever it appears:
 * `-oProxyCommand=…` in the host field would run a command on this machine.
 * No real host name or `Host` alias starts with one, so nothing is lost by
 * refusing it — and refusing is clearer than relying on every ssh tool to
 * treat `--` the same way.
 */
export function assertHost(host: string): string {
  if (!host.trim() || host.trim().startsWith('-')) {
    throw new Error(`"${host}" is not a host name. Enter user@host, or a Host from your ssh config.`)
  }
  return host
}

/**
 * The ssh arguments for running one command line on the far end.
 *
 * `-T` because none of this wants a terminal, and `-n` would close stdin,
 * which ffmpeg's `-progress pipe:1` does not need but a future caller might.
 */
/**
 * Where the shared connection's socket lives.
 *
 * `%C` is ssh's own hash of where it is connecting from and to, so each
 * destination gets its own socket and no name has to be invented. `~/.ssh` is
 * the conventional home for these and is certain to exist here: `BatchMode`
 * means a key or an agent, and that is where keys live. The name is kept short
 * on purpose — this becomes a Unix socket path, which the kernel caps at about
 * 104 bytes, and the hash alone is 40 of them.
 *
 * If the socket cannot be made, ssh says so and connects normally, so nothing
 * here can stop a connection that would otherwise have worked.
 */
const CONTROL_PATH = '~/.ssh/pf-%C'

/**
 * Whether the machine running `ssh` can share connections at all.
 *
 * Connection sharing needs a Unix-domain socket, and Windows' own
 * `ssh.exe` — the OpenSSH port that ships with Windows, which is what PlexFixer
 * runs there — does not implement multiplexing. Asking it to produces
 * `getsockname failed: Not a socket` and the connection fails outright, so a
 * remote host that worked went red the moment these options were added.
 *
 * This is about the local client, not the far end: a Windows machine talking to
 * a Linux NAS still cannot share the connection.
 */
export function canMultiplex(local: SshRunner): boolean {
  return local.paths.sep !== '\\'
}

/**
 * The connection-sharing options, or the ones that firmly switch it off.
 *
 * Leaving the options out is not enough on Windows: `ssh.exe` still reads the
 * user's `~/.ssh/config`, and a `ControlMaster` set there fails in exactly the
 * same way. A command-line `-o` beats the config file, so saying no explicitly
 * is what makes PlexFixer work on a machine whose config asks for sharing that
 * its own ssh cannot do.
 */
function multiplexArgs(enabled: boolean): string[] {
  if (!enabled) return ['-o', 'ControlMaster=no', '-o', 'ControlPath=none']
  return [
    // One connection, shared. Without this every command — every ffprobe of
    // every file in a scan — paid for its own TCP connection, key exchange and
    // authentication, which on a thousand-file library is the scan.
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${CONTROL_PATH}`,
    // Outlives the command that opened it, so the next one reuses it. Long
    // enough to cover a scan's gaps, short enough that nothing is left running
    // once the app has been shut for a minute.
    '-o',
    'ControlPersist=60'
  ]
}

export interface SshArgsOptions {
  /** Defaults to off: sharing is added where it is known to work, not assumed. */
  multiplex?: boolean
}

export function sshArgs(
  target: SshTarget,
  remoteCommand: string,
  options: SshArgsOptions = {}
): string[] {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=20',
    ...multiplexArgs(options.multiplex ?? false),
    ...(target.identityFile ? ['-i', target.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
    ...(target.port ? ['-p', String(target.port)] : []),
    assertHost(target.host),
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

/**
 * A literal string as a pattern for `pkill -f` and `pgrep -f`.
 *
 * Both read their argument as an extended regular expression, and the thing
 * being looked for is a file path. `Movie (2019) [1080p].mkv` as a pattern
 * means "Movie 2019 " followed by one character from a set — which is not what
 * the command line says, so nothing matched and a cancelled remote repair went
 * on running. Brackets and parentheses are how a Plex library is named, so
 * that was most of them.
 */
export function literalPattern(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

/** Run a command line on the far end and collect its output. */
export async function sshRun(
  local: SshRunner,
  target: SshTarget,
  remoteCommand: string,
  options: SshRunOptions = {}
): Promise<SshResult> {
  let child: HostProcess
  try {
    child = local.spawnProcess('ssh', sshArgs(target, remoteCommand, { multiplex: canMultiplex(local) }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new SshError(
      message.includes('ENOENT') ? 'The ssh command is not available on this machine.' : message,
      null,
      ''
    )
  }

  const limit = options.maxBytes ?? 32 * 1024 * 1024
  let stdout = ''
  let stderr = ''
  let overflowed = false

  child.onStdout((chunk) => {
    if (stdout.length > limit) {
      overflowed = true
      return
    }
    stdout += chunk
  })
  // Only the tail matters, and a failing command can be noisy.
  child.onStderr((chunk) => {
    stderr = (stderr + chunk).slice(-8192)
  })

  let timedOut = false
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true
        child.terminate()
      }, options.timeoutMs)
    : undefined

  const onAbort = (): void => child.terminate()
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const { code } = await child.closed.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      throw new SshError(
        message.includes('ENOENT') ? 'The ssh command is not available on this machine.' : message,
        null,
        stderr
      )
    })

    if (timedOut) throw new SshError(`ssh timed out after ${options.timeoutMs}ms`, null, stderr)
    if (overflowed) {
      throw new SshError('The remote command produced more output than PlexFixer will read.', code, stderr)
    }
    return { stdout, stderr, code }
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** Run a command, and throw with ssh's own words when it fails. */
export async function sshCheck(
  local: SshRunner,
  target: SshTarget,
  remoteCommand: string,
  options?: SshRunOptions
): Promise<string> {
  const result = await sshRun(local, target, remoteCommand, options)
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
export function sshSpawn(local: SshRunner, target: SshTarget, remoteCommand: string): HostProcess {
  return local.spawnProcess('ssh', sshArgs(target, remoteCommand, { multiplex: canMultiplex(local) }))
}
