import { describe, expect, it } from 'vitest'
import type { AboutInfo, EnvironmentInfo } from '@shared/types.js'
import { aboutRows, buildAboutText, platformName, shortFfmpegVersion, versionLine } from '@shared/about.js'

const about: AboutInfo = {
  version: '0.1.10',
  packaged: true,
  tauri: '2.11.3',
  webview: 'WebKit 620.1.16',
  platform: 'darwin',
  arch: 'arm64',
  systemVersion: '15.1',
  userDataPath: '/Users/someone/Library/Application Support/PlexFixer'
}

const environment: EnvironmentInfo = {
  ready: true,
  ffmpegPath: '/Applications/PlexFixer.app/Contents/Resources/bin/darwin-arm64/ffmpeg',
  ffprobePath: '/Applications/PlexFixer.app/Contents/Resources/bin/darwin-arm64/ffprobe',
  ffmpegSource: 'bundled',
  ffprobeSource: 'bundled',
  ffmpegVersion: '7.1',
  capabilities: { platform: 'darwin', available: ['h264_videotoolbox'], nvenc: false, videotoolbox: true, qsv: false, amf: false, libplacebo: false }
}

function valueOf(rows: ReturnType<typeof aboutRows>, label: string): string | undefined {
  return rows.find((row) => row.label === label)?.value
}

describe('versionLine', () => {
  it('marks an unpackaged run, whose version is the working tree, not a build', () => {
    expect(versionLine(about)).toBe('0.1.10')
    expect(versionLine({ ...about, packaged: false })).toBe('0.1.10 (development build)')
  })
})

describe('platformName', () => {
  it('names the platforms people recognise and passes anything else through', () => {
    expect(platformName('darwin')).toBe('macOS')
    expect(platformName('win32')).toBe('Windows')
    expect(platformName('linux')).toBe('Linux')
    expect(platformName('freebsd')).toBe('freebsd')
  })
})

describe('shortFfmpegVersion', () => {
  it('keeps the version and drops the copyright banner', () => {
    expect(shortFfmpegVersion('ffmpeg version n8.1.2 Copyright (c) 2000-2026 the FFmpeg developers')).toBe('n8.1.2')
    expect(shortFfmpegVersion('ffmpeg version 7.1.1-tessus')).toBe('7.1.1-tessus')
  })

  it('passes through anything that is not the usual banner', () => {
    expect(shortFfmpegVersion('6.0')).toBe('6.0')
  })
})

describe('aboutRows', () => {
  it('names the ffmpeg build and where it came from', () => {
    const rows = aboutRows(about, environment)
    expect(valueOf(rows, 'FFmpeg')).toBe('7.1 (bundled with PlexFixer)')
    expect(rows.some((row) => row.label === 'Version')).toBe(false)
    expect(valueOf(rows, 'ffmpeg')).toBe(environment.ffmpegPath)
    expect(valueOf(rows, 'Platform')).toBe('macOS 15.1 · arm64')
  })

  it('distinguishes a binary chosen in Settings from one found on PATH', () => {
    expect(valueOf(aboutRows(about, { ...environment, ffmpegSource: 'settings' }), 'FFmpeg')).toBe(
      '7.1 (chosen in Settings)'
    )
    expect(valueOf(aboutRows(about, { ...environment, ffmpegSource: 'path' }), 'FFmpeg')).toBe('7.1 (found on PATH)')
  })

  it('reports the encoders found, and says so when there are none', () => {
    expect(valueOf(aboutRows(about, environment), 'Hardware encoders')).toBe('VideoToolbox')
    const software = { ...environment, capabilities: { ...environment.capabilities!, videotoolbox: false } }
    expect(valueOf(aboutRows(about, software), 'Hardware encoders')).toBe('none — transcodes run on the CPU')
  })

  it('carries the toolchain problem where the version would be, and still shows the rest', () => {
    const broken: EnvironmentInfo = { ready: false, problem: 'Could not find ffmpeg and ffprobe.' }
    const rows = aboutRows(about, broken)
    expect(valueOf(rows, 'FFmpeg')).toBe('Could not find ffmpeg and ffprobe.')
    expect(valueOf(rows, 'Platform')).toBe('macOS 15.1 · arm64')
    expect(valueOf(rows, 'Settings folder')).toBe(about.userDataPath)
  })

  it('works before the environment has been detected', () => {
    const rows = aboutRows(about)
    expect(valueOf(rows, 'FFmpeg')).toBe('not available')
    expect(rows.some((row) => row.label === 'Hardware encoders')).toBe(false)
  })
})

describe('buildAboutText', () => {
  it('leads with the name and version, then aligns every row', () => {
    const lines = buildAboutText(about, environment).split('\n')
    expect(lines[0]).toBe('PlexFixer 0.1.10')
    expect(lines[1]).toBe('')
    expect(lines[2]).toBe('Platform           macOS 15.1 · arm64')
    expect(lines).toContain('ffmpeg             ' + environment.ffmpegPath)
  })
})
