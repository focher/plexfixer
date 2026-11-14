/**
 * The remote host, without a remote host.
 *
 * The parsing is pure and tested as such. For the rest, a stand-in `ssh` on
 * PATH runs the command it is given on this machine instead of sending it
 * anywhere — which exercises the real quoting, the real `ls`, `stat`, `find`,
 * `tail`/`head`/`base64` and the real parsing of what they print, against a
 * real directory. What it cannot prove is that ssh itself connects; that is
 * the one thing the app's own connection test is for.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { explainSshFailure, shellCommand, shellQuote, sshArgs } from '@shared/plex/ssh.js'
import { checkScript, parseCheck, REQUIRED_UTILITIES } from '@shared/plex/remote-check.js'
import { parseLsLong, parseStatLine, remoteHost } from '@shared/plex/remote-host.js'
import { hostFor, localHost, remoteTargetFor } from './node-host.js'
import { keyMaterial, keysMatch, knownHostsName, parseFingerprints } from '@shared/plex/hostkey.js'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'

describe('shellQuote', () => {
  it('leaves ordinary paths alone', () => {
    expect(shellQuote('/Volumes/Media/Movies')).toBe('/Volumes/Media/Movies')
    expect(shellQuote('ffmpeg')).toBe('ffmpeg')
  })

  it('quotes everything a shell would otherwise act on', () => {
    expect(shellQuote('/media/The Matrix (1999)')).toBe("'/media/The Matrix (1999)'")
    expect(shellQuote('$HOME/x')).toBe("'$HOME/x'")
    expect(shellQuote('a;rm -rf /')).toBe("'a;rm -rf /'")
    expect(shellQuote('')).toBe("''")
  })

  it('survives a single quote in a filename', () => {
    expect(shellQuote("Bill's Movie.mkv")).toBe(`'Bill'\\''s Movie.mkv'`)
  })

  it('joins a command line argument by argument', () => {
    expect(shellCommand(['mv', '-f', '--', '/a b', '/c'])).toBe("mv -f -- '/a b' /c")
  })
})

describe('sshArgs', () => {
  it('never prompts, and only names a port when one is set', () => {
    const args = sshArgs({ host: 'plex@nas' }, 'uname -s')
    expect(args).toContain('BatchMode=yes')
    expect(args).not.toContain('-p')
    expect(args.slice(-2)).toEqual(['plex@nas', 'uname -s'])
    expect(sshArgs({ host: 'nas', port: 2222 }, 'x')).toContain('2222')
  })

  it('offers only the chosen key when one is given', () => {
    const args = sshArgs({ host: 'nas', identityFile: '/Users/me/.ssh/id_ed25519' }, 'x')
    expect(args).toContain('-i')
    expect(args).toContain('/Users/me/.ssh/id_ed25519')
    // Without this, ssh still tries every default identity first, and a host
    // that rejects them fails slowly and for the wrong reason.
    expect(args).toContain('IdentitiesOnly=yes')
    expect(sshArgs({ host: 'nas' }, 'x')).not.toContain('-i')
  })
})

describe('host keys', () => {
  it('names a host the way known_hosts does', () => {
    expect(knownHostsName({ hostname: 'nas.local', port: 22 })).toBe('nas.local')
    expect(knownHostsName({ hostname: 'nas.local', port: 2222 })).toBe('[nas.local]:2222')
  })

  it('compares keys by their material, not by the host they are listed against', () => {
    const recorded = ['nas.local,10.0.0.5 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAfake']
    const sameKey = '[nas.local]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAfake'
    const otherKey = 'nas.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAsomethingelse'

    expect(keyMaterial(recorded[0]!)).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAfake')
    // A hashed entry still compares, because the hash is only the hostname.
    expect(keyMaterial('|1|abc=|def= ssh-rsa AAAAB3Nza')).toBe('ssh-rsa AAAAB3Nza')
    expect(keysMatch(recorded, sameKey)).toBe(true)
    expect(keysMatch(recorded, otherKey)).toBe(false)
    expect(keysMatch([], sameKey)).toBe(false)
  })

  it('reads what ssh-keygen -l prints, type and all', () => {
    const output = [
      '256 SHA256:orNX1IZ7xPY838zo7sE+Qn+t4IpHFV03C3CqfoEVPfw 127.0.0.1 (ED25519)',
      '3072 SHA256:RdTVE05N+lpZP0TGAAY0JBv01zo6A5HYtW/6T42IVkg 127.0.0.1 (RSA)'
    ].join('\n')
    expect(parseFingerprints(output)).toEqual([
      { type: 'ED25519', fingerprint: 'SHA256:orNX1IZ7xPY838zo7sE+Qn+t4IpHFV03C3CqfoEVPfw' },
      { type: 'RSA', fingerprint: 'SHA256:RdTVE05N+lpZP0TGAAY0JBv01zo6A5HYtW/6T42IVkg' }
    ])
    expect(parseFingerprints('no keys here')).toEqual([])
  })
})

describe('explainSshFailure', () => {
  it('turns the three failures that actually happen into something to do', () => {
    expect(explainSshFailure('Host key verification failed.')?.hint).toContain('accept the key')
    expect(explainSshFailure('plex@nas: Permission denied (publickey).')?.hint).toContain('ssh-copy-id')
    expect(explainSshFailure('ssh: Could not resolve hostname nas')?.problem).toContain('does not resolve')
    expect(explainSshFailure('something else entirely')).toBeUndefined()
  })
})

describe('parseLsLong', () => {
  const output = [
    'total 8',
    'drwxr-xr-x  5 501 20       160 Nov 12 10:00 Movies/',
    '-rw-r--r--  1 501 20 431648673 Nov 12 12:05 The Matrix (1999).mkv',
    'lrwxr-xr-x  1 501 20        12 Nov 12 12:05 shortcut -> /elsewhere',
    '-rw-r--r--  1 501 20       123 Nov 12 12:05 notes.txt'
  ].join('\n')

  it('reads type, size and names with spaces in them', () => {
    const entries = parseLsLong(output)
    expect(entries.map((entry) => entry.name)).toEqual(['Movies', 'The Matrix (1999).mkv', 'notes.txt'])
    expect(entries[0]?.isDirectory).toBe(true)
    expect(entries[1]?.sizeBytes).toBe(431648673)
  })

  it('drops symlinks, as the local walker does', () => {
    expect(parseLsLong(output).some((entry) => entry.name === 'shortcut')).toBe(false)
  })
})

describe('parseStatLine', () => {
  it('reads what either coreutils or BSD was asked to print', () => {
    expect(parseStatLine('431648673 1763000000 regular file')).toEqual({
      sizeBytes: 431648673,
      modifiedMs: 1763000000000,
      isDirectory: false
    })
    expect(parseStatLine('160 1763000000 directory')?.isDirectory).toBe(true)
    expect(parseStatLine('')).toBeUndefined()
  })
})

describe('the connection check', () => {
  it('asks about every utility the remote host actually shells out to', () => {
    const script = checkScript('ffmpeg', 'ffprobe')
    for (const utility of REQUIRED_UTILITIES) expect(script).toContain(utility)
    expect(checkScript('/opt/bin/ff mpeg', 'ffprobe')).toContain("'/opt/bin/ff mpeg'")
  })

  it('is only ready when both binaries and every utility answered', () => {
    const lines = [
      'PLATFORM\tLinux x86_64',
      ...REQUIRED_UTILITIES.map((utility) => `UTIL\t${utility}\thave`),
      'FFMPEG\t/usr/bin/ffmpeg',
      'FFMPEGV\tffmpeg version 6.1',
      'FFPROBE\t/usr/bin/ffprobe',
      'FFPROBEV\tffprobe version 6.1'
    ]
    const check = parseCheck('nas', lines.join('\n'))
    expect(check.ok).toBe(true)
    expect(check.platform).toBe('Linux x86_64')
    expect(check.ffmpegVersion).toBe('ffmpeg version 6.1')
    expect(check.missing).toEqual([])
  })

  it('names what is missing rather than just failing', () => {
    const noFfmpeg = parseCheck('nas', 'PLATFORM\tLinux x86_64\nUTIL\tls\thave')
    expect(noFfmpeg.ok).toBe(false)
    expect(noFfmpeg.problem).toContain('ffmpeg and ffprobe')

    const noUtility = parseCheck(
      'nas',
      [
        'UTIL\tbase64\tmiss',
        'FFMPEG\t/usr/bin/ffmpeg',
        'FFPROBE\t/usr/bin/ffprobe'
      ].join('\n')
    )
    expect(noUtility.ok).toBe(false)
    expect(noUtility.problem).toContain('base64')
  })
})

describe('hostFor', () => {
  it('stays local until a host is both set and switched on', () => {
    expect(hostFor(DEFAULT_SETTINGS).kind).toBe('local')
    expect(hostFor({ ...DEFAULT_SETTINGS, remoteHost: 'nas' }).kind).toBe('local')
    expect(hostFor({ ...DEFAULT_SETTINGS, remoteEnabled: true }).kind).toBe('local')
    expect(hostFor({ ...DEFAULT_SETTINGS, remoteEnabled: true, remoteHost: ' nas ' }).kind).toBe('remote')
    expect(
      remoteTargetFor({
        ...DEFAULT_SETTINGS,
        remoteEnabled: true,
        remoteHost: 'nas',
        remotePort: 2222,
        remoteKeyPath: ' /keys/id_ed25519 '
      })
    ).toEqual({ host: 'nas', port: 2222, identityFile: '/keys/id_ed25519' })
  })
})

/* ------------------------------------------------------------------ *
 * Against a stand-in ssh
 * ------------------------------------------------------------------ */

describe('the remote host, over a stand-in ssh', () => {
  let dir: string
  let binDir: string
  let originalPath: string | undefined

  beforeAll(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'plexfixer-ssh-'))
    const fake = join(binDir, 'ssh')
    // ssh's last argument is the command line; run it here instead of there.
    await writeFile(fake, '#!/bin/sh\nfor last in "$@"; do :; done\nexec /bin/sh -c "$last"\n')
    await chmod(fake, 0o755)
    originalPath = process.env['PATH']
    process.env['PATH'] = `${binDir}:${originalPath ?? ''}`
  })

  afterAll(async () => {
    process.env['PATH'] = originalPath
    await rm(binDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plexfixer-remote-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const host = (): ReturnType<typeof remoteHost> => remoteHost({ host: 'stand-in' }, localHost())

  it('lists a directory, sizes and all', async () => {
    await mkdir(join(dir, 'Season 1'))
    await writeFile(join(dir, 'The Matrix (1999).mkv'), 'x'.repeat(1234))
    const entries = await host().list(dir)
    expect(entries.map((entry) => entry.name).sort()).toEqual(['Season 1', 'The Matrix (1999).mkv'])
    expect(entries.find((entry) => entry.name === 'Season 1')?.isDirectory).toBe(true)
    expect(entries.find((entry) => entry.name.startsWith('The Matrix'))?.sizeBytes).toBe(1234)
  })

  it('stats a file and a directory', async () => {
    const file = join(dir, 'a file.mkv')
    await writeFile(file, 'hello')
    const info = await host().stat(file)
    expect(info?.sizeBytes).toBe(5)
    expect(info?.isDirectory).toBe(false)
    expect(info?.modifiedMs).toBeGreaterThan(0)
    expect((await host().stat(dir))?.isDirectory).toBe(true)
    expect(await host().stat(join(dir, 'nothing'))).toBeUndefined()
  })

  it('reads an arbitrary byte range, which is what MP4 box walking needs', async () => {
    const file = join(dir, 'bytes.bin')
    await writeFile(file, Buffer.from('0123456789abcdef'))
    // A Uint8Array now, not a Buffer: the same code runs in a webview.
    const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
    expect(text(await host().readRange(file, 0, 4))).toBe('0123')
    expect(text(await host().readRange(file, 10, 6))).toBe('abcdef')
  })

  it('finds media files, skipping backups and the wrong extensions', async () => {
    await mkdir(join(dir, 'Season 1'), { recursive: true })
    await mkdir(join(dir, '.plexfixer-backups'), { recursive: true })
    await writeFile(join(dir, 'Season 1', 'ep1.mkv'), 'x')
    await writeFile(join(dir, 'poster.jpg'), 'x')
    await writeFile(join(dir, '.plexfixer-backups', 'old.mkv'), 'x')
    await writeFile(join(dir, 'movie.mp4'), 'x')

    const found = await host().findMedia([dir], ['mkv', 'mp4'], true)
    expect(found.map((path) => path.replace(`${dir}/`, '')).sort()).toEqual(['Season 1/ep1.mkv', 'movie.mp4'])

    const shallow = await host().findMedia([dir], ['mkv', 'mp4'], false)
    expect(shallow.map((path) => path.replace(`${dir}/`, ''))).toEqual(['movie.mp4'])
  })

  it('makes, moves and removes, which is how a repair lands', async () => {
    const remote = host()
    const nested = join(dir, 'out', 'deeper')
    await remote.mkdirp(nested)
    const from = join(nested, 'temp file.mkv')
    const to = join(nested, 'final.mkv')
    await writeFile(from, 'data')
    expect(await remote.exists(from)).toBe(true)
    await remote.rename(from, to)
    expect(await remote.exists(from)).toBe(false)
    expect((await remote.stat(to))?.sizeBytes).toBe(4)
    await remote.remove(to)
    expect(await remote.exists(to)).toBe(false)
  })

  it('runs a binary and gives back its output', async () => {
    expect((await host().exec('printf', ['%s-%s', 'a', 'b'])).trim()).toBe('a-b')
    await expect(host().exec('sh', ['-c', 'exit 3'])).rejects.toThrow()
  })
})
