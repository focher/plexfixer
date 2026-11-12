/**
 * The version details behind the About panel.
 *
 * Pure, so the panel on screen and the text someone pastes into a bug report
 * are built from the same rows: a screenshot of one and a paste of the other
 * can never disagree about what version was running.
 */

import type { AboutInfo, EnvironmentInfo } from './types.js'

/**
 * The product name, spelled the one way.
 *
 * `app.getName()` is the lowercase package name in a dev run and the product
 * name only once packaged, which would have the panel and the text it copies
 * disagree with each other depending on how the app was started.
 */
export const PRODUCT_NAME = 'PlexFixer'

/** Where releases are published — the one link the panel offers. */
export const RELEASES_URL = 'https://github.com/focher/plexfixer/releases'

export interface AboutRow {
  label: string
  value: string
  /** Paths and version strings read better in the monospace face. */
  mono?: boolean
}

export function platformName(platform: string): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform
}

/**
 * `0.1.10`, or `0.1.10 (development build)` when the app is not packaged.
 *
 * A dev run reports whatever version is in the working tree, which is rarely
 * the version of any release — worth saying, since the whole point of this
 * panel is answering "what exactly are you running?".
 */
export function versionLine(about: AboutInfo): string {
  return about.packaged ? about.version : `${about.version} (development build)`
}

/**
 * `ffmpeg version n8.1.2 Copyright (c) 2000-2026 …` → `n8.1.2`.
 *
 * The copyright half of the banner says nothing about which build this is, and
 * it pushes the half that does off the end of the line.
 */
export function shortFfmpegVersion(version: string): string {
  const match = /^ffmpeg version (\S+)/.exec(version.trim())
  return match?.[1] ?? version.trim().split('\n')[0] ?? version
}

function sourceName(source: EnvironmentInfo['ffmpegSource']): string {
  if (source === 'settings') return 'chosen in Settings'
  if (source === 'bundled') return 'bundled with PlexFixer'
  if (source === 'path') return 'found on PATH'
  return 'source unknown'
}

function encoderNames(environment?: EnvironmentInfo): string | undefined {
  const capabilities = environment?.capabilities
  if (!capabilities) return undefined
  const names = [
    capabilities.nvenc && 'NVENC',
    capabilities.qsv && 'Quick Sync',
    capabilities.amf && 'AMF',
    capabilities.videotoolbox && 'VideoToolbox'
  ].filter((name): name is string => typeof name === 'string')
  return names.length > 0 ? names.join(', ') : 'none — transcodes run on the CPU'
}

/**
 * Everything the panel shows, in order.
 *
 * ffmpeg is the part of the stack that genuinely differs between machines, so
 * it is named with its build *and* where that build came from: "it works here"
 * and "it works there" are different claims when one is the bundled binary and
 * the other is whatever Homebrew installed.
 */
export function aboutRows(about: AboutInfo, environment?: EnvironmentInfo): AboutRow[] {
  // The version itself is the panel's headline and the first line of the
  // copied text, so it is not repeated here.
  const rows: AboutRow[] = [
    {
      label: 'Platform',
      value: `${platformName(about.platform)} ${about.systemVersion} · ${about.arch}`
    },
    { label: 'Electron', value: `${about.electron} · Chromium ${about.chrome} · Node ${about.node}` },
    {
      label: 'FFmpeg',
      value: environment?.ffmpegVersion
        ? `${shortFfmpegVersion(environment.ffmpegVersion)} (${sourceName(environment.ffmpegSource)})`
        : (environment?.problem ?? 'not available')
    }
  ]

  if (environment?.ffmpegPath) rows.push({ label: 'ffmpeg', value: environment.ffmpegPath, mono: true })
  if (environment?.ffprobePath) rows.push({ label: 'ffprobe', value: environment.ffprobePath, mono: true })

  const encoders = encoderNames(environment)
  if (encoders) rows.push({ label: 'Hardware encoders', value: encoders })

  rows.push({ label: 'Settings folder', value: about.userDataPath, mono: true })
  return rows
}

/** The same rows as plain text, for pasting into an issue. */
export function buildAboutText(about: AboutInfo, environment?: EnvironmentInfo): string {
  const rows = aboutRows(about, environment)
  const width = Math.max(...rows.map((row) => row.label.length))
  return [
    `${PRODUCT_NAME} ${versionLine(about)}`,
    '',
    ...rows.map((row) => `${row.label.padEnd(width)}  ${row.value}`)
  ].join('\n')
}
