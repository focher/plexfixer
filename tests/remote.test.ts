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
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canMultiplex,
  explainSshFailure,
  literalPattern,
  shellCommand,
  shellQuote,
  sshArgs,
  sshRun,
  type SshRunner
} from '@shared/plex/ssh.js'
import type { RepairHost } from '@shared/host.js'
import { checkScript, parseCheck, REQUIRED_UTILITIES } from '@shared/plex/remote-check.js'
import { parseLsLong, parseStatLine, remoteHost } from '@shared/plex/remote-host.js'
import { hostFor, localHost, remoteTargetFor } from './node-host.js'
import {
  keyMaterial,
  keysMatch,
  knownHostsName,
  parseFingerprints,
  trustHost,
  type HostKeyTools
} from '@shared/plex/hostkey.js'
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

  it('shares one connection across every command when asked to', () => {
    // Each command used to pay for its own TCP connection, key exchange and
    // authentication. A scan runs one ffprobe per file, so on a large library
    // that handshake was the scan.
    const args = sshArgs({ host: 'nas' }, 'x', { multiplex: true })
    expect(args).toContain('ControlMaster=auto')
    expect(args).toContain('ControlPersist=60')
    const path = args.find((arg) => arg.startsWith('ControlPath='))
    expect(path).toBeDefined()
    // %C is ssh's hash of the endpoints, so each destination gets its own
    // socket without this having to invent a name.
    expect(path).toContain('%C')
    // The expansion of this becomes a Unix socket path, capped near 104 bytes,
    // and %C alone spends 40 of them.
    expect(path!.length).toBeLessThan(40)
  })

  it('says no to sharing outright rather than just leaving it out', () => {
    // Windows' own ssh.exe cannot multiplex at all, and it still reads the
    // user's ~/.ssh/config — so omitting these would let a ControlMaster set
    // there break the connection. A command-line -o beats the config file.
    const args = sshArgs({ host: 'nas' }, 'x')
    expect(args).toContain('ControlMaster=no')
    expect(args).toContain('ControlPath=none')
    expect(args).not.toContain('ControlMaster=auto')
  })
})

describe('which machines can share a connection', () => {
  const windows = { sep: '\\' } as RepairHost['paths']
  const posix = { sep: '/' } as RepairHost['paths']
  const runner = (paths: RepairHost['paths']): SshRunner =>
    ({ paths, spawnProcess: () => { throw new Error('not started') } }) as unknown as SshRunner

  it('is about the machine running ssh, not the one being reached', () => {
    expect(canMultiplex(runner(posix))).toBe(true)
    // A Windows machine talking to a Linux NAS still cannot share the
    // connection: the limitation is in its own ssh client.
    expect(canMultiplex(runner(windows))).toBe(false)
  })
})

describe('starting ssh on Windows', () => {
  /** Captures the arguments `ssh` would have been started with. */
  function capturing(sep: string): { local: SshRunner; args: string[] } {
    const args: string[] = []
    const local = {
      paths: { sep } as RepairHost['paths'],
      spawnProcess: (_command: string, given: string[]) => {
        args.push(...given)
        return {
          onStdout: () => undefined,
          onStderr: () => undefined,
          closed: Promise.resolve({ code: 0 }),
          terminate: () => undefined
        }
      }
    } as unknown as SshRunner
    return { local, args }
  }

  it('never asks for a control socket it cannot make', async () => {
    // The regression: these options made every remote command fail with
    // "getsockname failed: Not a socket", so a host that had been green went
    // red. Windows OpenSSH does not implement connection sharing.
    const { local, args } = capturing('\\')
    await sshRun(local, { host: 'nas' }, 'true')

    expect(args).not.toContain('ControlMaster=auto')
    expect(args).not.toContain('ControlPersist=60')
    expect(args.some((arg) => arg.startsWith('ControlPath=~'))).toBe(false)
    expect(args).toContain('ControlMaster=no')
  })

  it('still shares the connection everywhere else', async () => {
    const { local, args } = capturing('/')
    await sshRun(local, { host: 'nas' }, 'true')

    expect(args).toContain('ControlMaster=auto')
    expect(args).toContain('ControlPersist=60')
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

describe('a host that is really an option', () => {
  it('is refused before ssh ever sees it', () => {
    // An argument beginning with a dash is an option wherever it appears, and
    // this one would run a command on this machine.
    expect(() => sshArgs({ host: '-oProxyCommand=touch /tmp/owned' }, 'true')).toThrow(/not a host name/)
    expect(() => sshArgs({ host: '   ' }, 'true')).toThrow(/not a host name/)
    expect(() => sshArgs({ host: 'plex@nas.local' }, 'true')).not.toThrow()
  })
})

describe('literalPattern', () => {
  it('makes a path match itself and nothing else', () => {
    const path = '/media/.plexfixer-ab12-Movie (2019) [1080p].mp4'
    const pattern = new RegExp(literalPattern(path))
    expect(pattern.test(`ffmpeg -i in.mkv ${path}`)).toBe(true)
    // What the unescaped path meant as a pattern: no parentheses, and any one
    // of "1080p" where the brackets were.
    expect(new RegExp(path).test(`ffmpeg -i in.mkv ${path}`)).toBe(false)
    // A dot is a dot, not any character.
    expect(new RegExp(literalPattern('a.mp4')).test('axmp4')).toBe(false)
  })
})

/**
 * `ssh-keyscan` and `ssh-keygen`, replaced.
 *
 * `scans` is what the host answers each time it is asked for its key, in
 * order — the second answer being different from the first is the case that
 * matters. The fingerprint is derived from the key, so a different key always
 * shows as a different fingerprint, as it does for real.
 */
function keyTools(scans: string[], options: { fingerprintsWork?: boolean } = {}): HostKeyTools & { appended: string[] } {
  const appended: string[] = []
  let scan = 0
  return {
    appended,
    exec: async (command, args, execOptions) => {
      if (command === 'ssh-keyscan') return scans[Math.min(scan++, scans.length - 1)] ?? ''
      if (command === 'ssh-keygen' && args[0] === '-lf') {
        if (options.fingerprintsWork === false) throw new Error('(stdin) is not a public key file.')
        return (execOptions?.input ?? '')
          .split('\n')
          .filter((line) => line.trim() && !line.startsWith('#'))
          .map((line) => `256 SHA256:${line.split(/\s+/)[2]} nas (ED25519)`)
          .join('\n')
      }
      // `ssh -G` and `ssh-keygen -F` both fail: no config, and no entry yet.
      throw new Error('nothing')
    },
    knownHosts: {
      read: async () => '',
      append: async (lines) => void appended.push(lines),
      location: async () => '~/.ssh/known_hosts'
    }
  }
}

describe('trusting a host', () => {
  const real = 'nas ssh-ed25519 REALKEY'
  const other = 'nas ssh-ed25519 SOMEONEELSE'
  const shownReal = [{ type: 'ED25519', fingerprint: 'SHA256:REALKEY' }]

  it('records the key that was shown', async () => {
    const tools = keyTools([real])
    const result = await trustHost(tools, { host: 'nas' }, shownReal)

    expect(result.ok).toBe(true)
    expect(tools.appended).toEqual([real])
  })

  it('refuses a key that is not the one that was shown, and records nothing', async () => {
    // The fingerprint on screen was the real machine's. By the time the button
    // is pressed something else answers — and that second answer is what used
    // to be written to known_hosts, unseen.
    const tools = keyTools([other])
    const result = await trustHost(tools, { host: 'nas' }, shownReal)

    expect(result.ok).toBe(false)
    expect(result.problem).toMatch(/not the one you were shown/)
    expect(result.fingerprints).toEqual([{ type: 'ED25519', fingerprint: 'SHA256:SOMEONEELSE' }])
    expect(tools.appended).toEqual([])
  })

  it('refuses an extra key offered alongside the one that was shown', async () => {
    const tools = keyTools([`${real}\n${other}`])
    const result = await trustHost(tools, { host: 'nas' }, shownReal)

    expect(result.ok).toBe(false)
    expect(tools.appended).toEqual([])
  })

  it('refuses when nothing was shown at all', async () => {
    const tools = keyTools([real])
    expect((await trustHost(tools, { host: 'nas' }, [])).ok).toBe(false)
    expect(tools.appended).toEqual([])
  })

  it('will not record a key whose fingerprint it cannot work out', async () => {
    const tools = keyTools([real], { fingerprintsWork: false })
    const result = await trustHost(tools, { host: 'nas' }, shownReal)

    expect(result.ok).toBe(false)
    expect(result.problem).toMatch(/could not be worked out/)
    expect(tools.appended).toEqual([])
  })

  it('writes only the keys, not the scan\'s comments', async () => {
    const tools = keyTools([`# nas:22 SSH-2.0-OpenSSH_9.6\n${real}\n`])
    await trustHost(tools, { host: 'nas' }, shownReal)
    expect(tools.appended).toEqual([real])
  })

  it('never reaches the scan with a host that is really an option', async () => {
    const tools = keyTools([real])
    const result = await trustHost(tools, { host: '-oProxyCommand=evil' }, shownReal)

    expect(result.ok).toBe(false)
    expect(tools.appended).toEqual([])
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

  it('drops symlinks, which the remote scan does not follow either', () => {
    expect(parseLsLong(output).some((entry) => entry.name === 'shortcut')).toBe(false)
  })

  it('keeps a name exactly as written, runs of spaces included', () => {
    // Split on whitespace and joined back with single spaces, this became a
    // name that does not exist.
    const listing = [
      '-rw-r--r--  1 501 20 1 Nov 12 12:05 Two  Spaces.mkv',
      '-rw-r--r--  1 501 20 1 Nov 12 12:05  leading space.mkv',
      '-rw-r--r--  1 501 20 1 Nov 12 12:05 an -> arrow.mkv'
    ].join('\n')
    expect(parseLsLong(listing).map((entry) => entry.name)).toEqual([
      'Two  Spaces.mkv',
      ' leading space.mkv',
      'an -> arrow.mkv'
    ])
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
    // Optional, so its absence is not a problem.
    expect(check.qtFaststartPath).toBeUndefined()

    const withQt = parseCheck('nas', [...lines, 'QTFASTSTART\t/usr/bin/qt-faststart'].join('\n'))
    expect(withQt.ok).toBe(true)
    expect(withQt.qtFaststartPath).toBe('/usr/bin/qt-faststart')
  })

  it('looks for qt-faststart beside ffmpeg, then on PATH, and only reports it', () => {
    const script = checkScript('/opt/ff/ffmpeg', 'ffprobe')
    expect(script).toContain('qt-faststart')
    expect(script).toContain("printf 'QTFASTSTART")
    expect(script).toContain('${f%/*}/qt-faststart')
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

  it('lists and finds a name with a run of spaces in it', async () => {
    await writeFile(join(dir, 'Two  Spaces.mkv'), 'x')
    await writeFile(join(dir, ' leading.mkv'), 'x')

    expect((await host().list(dir)).map((entry) => entry.name).sort()).toEqual([' leading.mkv', 'Two  Spaces.mkv'])
    const found = await host().findMedia([dir], ['mkv'], true)
    expect(found.sort()).toEqual([join(dir, ' leading.mkv'), join(dir, 'Two  Spaces.mkv')])
  })

  it('does not let a newline in a name put another path on the list', async () => {
    // `find` prints one path per line, and a name can contain a newline. This
    // folder's name ends in one, so what is under it prints as a second line
    // that reads as an absolute path somewhere else entirely.
    await mkdir(join(dir, 'Season\n', 'etc'), { recursive: true })
    await writeFile(join(dir, 'Season\n', 'etc', 'other.mkv'), 'x')
    await writeFile(join(dir, 'honest.mkv'), 'x')

    const found = await host().findMedia([dir], ['mkv'], true)

    expect(found).toEqual([join(dir, 'honest.mkv')])
    expect(found).not.toContain('/etc/other.mkv')
  })

  it('stops a process whose path is full of brackets', async () => {
    // The marker is the repair's temporary file, named after the film — and
    // films are named `Title (Year) [Quality]`. pkill reads its argument as a
    // pattern, in which those are a group and a set, so nothing matched and a
    // cancelled remote repair ran on to the end.
    const marker = join(dir, '.plexfixer-ab12-Movie (2019) [1080p].mp4')
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', marker], { stdio: 'ignore' })
    const ended = new Promise<string>((resolve) => child.once('exit', (_code, signal) => resolve(signal ?? 'exited')))
    // Give it a moment to exist before it is looked for.
    await new Promise((resolve) => setTimeout(resolve, 200))

    await host().kill(marker)

    const outcome = await Promise.race([ended, new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 3000))])
    child.kill('SIGKILL')
    expect(outcome).toBe('SIGTERM')
  })

  it('finds media when its method is taken off the host, as the scan takes it', async () => {
    // The Tauri shell passes `host.findMedia` to the scan as a bare reference.
    // Written as a method using `this`, that call arrived with no host to work
    // through and threw on the first line — so a scan in remote mode found
    // nothing, every time, for as long as the Tauri build has existed.
    await mkdir(join(dir, 'Season 1'), { recursive: true })
    await writeFile(join(dir, 'Season 1', 'ep1.mkv'), 'x')
    await writeFile(join(dir, 'movie.mp4'), 'x')

    const findMedia = host().findMedia

    const found = await findMedia([dir], ['mkv', 'mp4'], true)
    expect(found.map((path) => path.replace(`${dir}/`, '')).sort()).toEqual(['Season 1/ep1.mkv', 'movie.mp4'])
  })

  it('takes a single file as a root, detached as well', async () => {
    const file = join(dir, 'just one.mkv')
    await writeFile(file, 'x')
    const findMedia = host().findMedia
    expect(await findMedia([file], ['mkv'], true)).toEqual([file])
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
