/**
 * Host keys: reading one, showing it, and recording it once the user says so.
 *
 * SSH's first-connection question — "the authenticity of this host can't be
 * established, do you want to continue?" — has to be asked somewhere, and a
 * batch-mode connection cannot ask it. So PlexFixer asks it in the connection
 * test: the key the host offers is fetched, its fingerprint is shown, and only
 * an explicit press writes it to `~/.ssh/known_hosts`.
 *
 * What is never offered is accepting a *changed* key. An existing entry that
 * no longer matches is either a rebuilt machine or someone else answering at
 * that address, and no button should make that distinction on the user's
 * behalf.
 */

import { execFile, spawn } from 'node:child_process'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { HostKeyFingerprint } from '@shared/types.js'
import type { SshTarget } from './ssh.js'

const execFileAsync = promisify(execFile)

export interface ResolvedTarget {
  /** The address ssh will actually connect to, after `~/.ssh/config`. */
  hostname: string
  port: number
}

/**
 * Ask ssh what a target resolves to.
 *
 * `ssh -G` applies the user's own config, so a `Host nas` alias pointing at
 * `10.0.0.5:2222` is scanned at the address that will really be used rather
 * than at the alias, which has no key of its own.
 */
export async function resolveTarget(target: SshTarget): Promise<ResolvedTarget> {
  const fallbackHost = target.host.includes('@') ? target.host.split('@').pop()! : target.host
  const fallback = { hostname: fallbackHost, port: target.port ?? 22 }
  try {
    const args = ['-G', ...(target.port ? ['-p', String(target.port)] : []), target.host]
    const { stdout } = await execFileAsync('ssh', args, { timeout: 10_000, windowsHide: true })
    const read = (key: string): string | undefined =>
      stdout
        .split('\n')
        .find((line) => line.toLowerCase().startsWith(`${key} `))
        ?.slice(key.length + 1)
        .trim()
    const hostname = read('hostname') || fallback.hostname
    const port = Number(read('port')) || fallback.port
    return { hostname, port }
  } catch {
    return fallback
  }
}

/** How a key for this host is written in `known_hosts`. */
export function knownHostsName(resolved: ResolvedTarget): string {
  return resolved.port === 22 ? resolved.hostname : `[${resolved.hostname}]:${resolved.port}`
}

export function knownHostsPath(): string {
  return join(homedir(), '.ssh', 'known_hosts')
}

/** The `known_hosts` lines already recorded for this host, if any. */
export async function knownHostEntries(resolved: ResolvedTarget): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('ssh-keygen', ['-F', knownHostsName(resolved)], {
      timeout: 10_000,
      windowsHide: true
    })
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  } catch {
    // `ssh-keygen -F` exits non-zero when it finds nothing.
    return []
  }
}

export async function hasKnownHostEntry(resolved: ResolvedTarget): Promise<boolean> {
  return (await knownHostEntries(resolved)).length > 0
}

/**
 * The key material of a `known_hosts` line, without the host it is recorded
 * against.
 *
 * Hostnames are sometimes hashed and sometimes listed several to a line, and
 * neither affects whether this is the same key — the type and the base64 blob
 * do, and only those are compared.
 */
export function keyMaterial(line: string): string | undefined {
  const fields = line.trim().split(/\s+/)
  // A marker like `@cert-authority` may come first.
  const start = fields[0]?.startsWith('@') ? 1 : 0
  const type = fields[start + 1]
  const blob = fields[start + 2]
  return type && blob ? `${type} ${blob}` : undefined
}

/** Do the keys this host is offering include one already recorded for it? */
export function keysMatch(known: string[], offered: string): boolean {
  const recorded = new Set(known.map(keyMaterial).filter((value): value is string => value != null))
  if (recorded.size === 0) return false
  return offered
    .split('\n')
    .map(keyMaterial)
    .some((material) => material != null && recorded.has(material))
}

/** The keys a host offers, as `known_hosts` lines. */
export async function scanHostKeys(resolved: ResolvedTarget): Promise<string> {
  const { stdout } = await execFileAsync(
    'ssh-keyscan',
    ['-T', '5', ...(resolved.port !== 22 ? ['-p', String(resolved.port)] : []), resolved.hostname],
    { timeout: 15_000, windowsHide: true }
  )
  return stdout
}

/** `256 SHA256:… host (ED25519)` → the two parts worth showing. */
export function parseFingerprints(output: string): HostKeyFingerprint[] {
  const out: HostKeyFingerprint[] = []
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/)
    const fingerprint = parts.find((part) => part.startsWith('SHA256:') || part.startsWith('MD5:'))
    if (!fingerprint) continue
    const type = parts[parts.length - 1]?.replace(/[()]/g, '') ?? 'unknown'
    out.push({ type, fingerprint })
  }
  return out
}

/** Run a command with something on its stdin, which `execFile` cannot do. */
function runWithInput(command: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with ${code}`))))
    child.stdin.end(input)
  })
}

export async function fingerprintsFor(keyLines: string): Promise<HostKeyFingerprint[]> {
  if (!keyLines.trim()) return []
  try {
    // The scan output goes in on stdin, so nothing is written to disk just to
    // find out what the key is.
    return parseFingerprints(await runWithInput('ssh-keygen', ['-lf', '-'], keyLines))
  } catch {
    return []
  }
}

export interface TrustResult {
  ok: boolean
  /** Fingerprints that were recorded. */
  fingerprints: HostKeyFingerprint[]
  problem?: string
  hint?: string
}

/**
 * Record the host's key, after checking there is not already a different one.
 *
 * The existing-entry check is the whole safety of this: without it, pressing
 * "Trust" on a host whose key has changed would paper over exactly the warning
 * SSH exists to give.
 */
export async function trustHost(target: SshTarget): Promise<TrustResult> {
  const resolved = await resolveTarget(target)
  const known = await knownHostEntries(resolved)

  let keyLines: string
  try {
    keyLines = await scanHostKeys(resolved)
  } catch (error) {
    return {
      ok: false,
      fingerprints: [],
      problem: `Could not read a host key from ${resolved.hostname}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
    }
  }

  if (!keyLines.trim()) {
    return {
      ok: false,
      fingerprints: [],
      problem: `${resolved.hostname} offered no host key.`,
      hint: 'Check that SSH is running there, and on the port you expect.'
    }
  }

  const fingerprints = await fingerprintsFor(keyLines)

  if (known.length > 0) {
    // Already recorded, and the same key: nothing to write, and nothing wrong.
    if (keysMatch(known, keyLines)) return { ok: true, fingerprints }
    return {
      ok: false,
      fingerprints,
      problem: `There is already a key for ${knownHostsName(resolved)}, and it is not the one the host is offering now.`,
      hint:
        'Either that machine was rebuilt, or something else is answering at that address. PlexFixer will not ' +
        `overwrite it for you: once you are sure which it is, run \`ssh-keygen -R ${knownHostsName(resolved)}\` and test again.`
    }
  }

  const path = knownHostsPath()
  await mkdir(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 })
  // Its own line, whatever the file ended with.
  const existing = await readFile(path, 'utf8').catch(() => '')
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  await appendFile(path, `${prefix}${keyLines.trimEnd()}\n`, { mode: 0o600 })

  return { ok: true, fingerprints }
}

/** The fingerprints a host is offering, for showing before anything is written. */
export async function offeredFingerprints(target: SshTarget): Promise<HostKeyFingerprint[]> {
  try {
    const resolved = await resolveTarget(target)
    return await fingerprintsFor(await scanHostKeys(resolved))
  } catch {
    return []
  }
}
