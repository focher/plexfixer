import { describe, expect, it } from 'vitest'

import {
  buildAdvice,
  buildsFor,
  describeModelSize,
  describeWhisper,
  isModelFileName,
  MAC_INSTRUCTION,
  modelOfPath,
  RECOMMENDED_MODEL,
  whisperBuild,
  whisperModel,
  WHISPER_BUILDS,
  WHISPER_MODELS
} from '@shared/subtitles/models.js'

/**
 * The catalogue is data, and the things that can be wrong with data are that
 * it does not match what the native side will accept and that an entry is
 * subtly malformed. Both are cheap to check and neither is obvious by eye.
 */
describe('the Whisper model catalogue', () => {
  it('names files the native side will accept', () => {
    // The same rule `is_model_file` applies in Rust. A name that fails here is
    // a model the app offers and then refuses to fetch.
    for (const model of WHISPER_MODELS) {
      expect(isModelFileName(model.file), model.file).toBe(true)
    }
  })

  it('pins a size and a hash for every entry', () => {
    for (const model of WHISPER_MODELS) {
      expect(model.sha256, model.file).toMatch(/^[0-9a-f]{64}$/)
      expect(model.sizeBytes, model.file).toBeGreaterThan(100_000_000)
      expect(model.summary.length, model.file).toBeGreaterThan(20)
    }
  })

  it('has no duplicates, and recommends one of its own', () => {
    const files = WHISPER_MODELS.map((model) => model.file)
    expect(new Set(files).size).toBe(files.length)
    expect(new Set(WHISPER_MODELS.map((model) => model.sha256)).size).toBe(files.length)
    expect(whisperModel(RECOMMENDED_MODEL)).toBeDefined()
  })

  it('recommends one that hears more than English', () => {
    // The feature exists to subtitle films that have no subtitles, and those
    // are disproportionately not in English.
    expect(whisperModel(RECOMMENDED_MODEL)?.multilingual).toBe(true)
  })
})

describe('model file names', () => {
  it('refuses anything that is really a path', () => {
    for (const name of [
      '../ggml-base.en.bin',
      'ggml-base.en.bin/../../etc/passwd',
      '/models/ggml-base.en.bin',
      'C:\\ggml-base.en.bin',
      'ggml-base.en.exe',
      'base.en.bin',
      'ggml-.bin',
      ''
    ]) {
      expect(isModelFileName(name), name).toBe(false)
    }
  })

  it('recognises a model wherever it is kept', () => {
    expect(modelOfPath('/Users/me/models/ggml-large-v3-turbo-q5_0.bin')?.label).toBe('Large v3 turbo (quantised)')
    expect(modelOfPath('C:\\models\\ggml-base.en.bin')?.file).toBe('ggml-base.en.bin')
    expect(modelOfPath('/Users/me/models/something-else.bin')).toBeUndefined()
    expect(modelOfPath('')).toBeUndefined()
  })
})

describe('sizes', () => {
  it('reads the way a download dialog reads', () => {
    expect(describeModelSize(147_964_211)).toBe('148 MB')
    expect(describeModelSize(574_041_195)).toBe('574 MB')
    expect(describeModelSize(1_624_555_275)).toBe('1.6 GB')
    expect(describeModelSize(3_095_033_483)).toBe('3.1 GB')
  })
})

describe('the whisper.cpp build catalogue', () => {
  it('pins a tag, a size and a hash for every build', () => {
    for (const build of WHISPER_BUILDS) {
      // A version tag carries no assets at all, which is the trap; the rolling
      // build tags are what the archives hang off.
      expect(build.tag, build.id).toMatch(/^b\d+$/)
      expect(build.sha256, build.id).toMatch(/^[0-9a-f]{64}$/)
      expect(build.asset, build.id).toMatch(/^whisper-[A-Za-z0-9._-]+\.(zip|tar\.gz)$/)
      expect(build.sizeBytes, build.id).toBeGreaterThan(1_000_000)
      // Unpacked is always larger than the archive; saying otherwise on screen
      // would be a plain lie about what the install costs.
      expect(build.installedBytes, build.id).toBeGreaterThan(build.sizeBytes)
    }
  })

  it('offers the graphics-card build first on Windows, and nothing on a Mac', () => {
    // The two halves arrive the way `about` reports them — `process.platform`
    // and `process.arch` — not pre-joined. 0.2.12 shipped with the catalogue
    // filing builds under `win32-x64` and the caller passing `win32`, so every
    // Windows machine was told whisper.cpp published nothing for it.
    const windows = buildsFor('win32', 'x64')
    expect(windows.length).toBe(2)
    expect(windows[0].accelerator).toBe('cuda')
    // Upstream publishes an xcframework and no command-line build for macOS,
    // so there is nothing to download and the panel says so instead.
    expect(buildsFor('darwin', 'arm64')).toEqual([])
    expect(buildsFor('darwin', 'x64')).toEqual([])
  })

  it('does not match a joined name handed in as the platform', () => {
    // The shape of the old bug, from the other side: nobody should be able to
    // make it pass again by loosening the comparison.
    expect(buildsFor('win32-x64', 'x64')).toEqual([])
    expect(buildsFor('win32', '')).toEqual([])
  })

  it('names Homebrew only on the platform Homebrew is the answer for', () => {
    expect(buildAdvice('darwin')).toContain(MAC_INSTRUCTION)
    for (const platform of ['win32', 'linux']) {
      expect(buildAdvice(platform), platform).not.toContain('brew')
      expect(buildAdvice(platform), platform).toContain('whisper-cli')
    }
  })

  it('finds a build by id and nothing by a made-up one', () => {
    expect(whisperBuild('win-cuda')?.asset).toBe('whisper-bin-win-cuda-12.4.0-x64.zip')
    expect(whisperBuild('nonsense')).toBeUndefined()
  })
})

describe('what the panel says about the binary in use', () => {
  it('distinguishes a typed path from one that was found', () => {
    expect(describeWhisper({ source: 'settings', path: '/x/whisper-cli' })).toContain('named below')
    expect(describeWhisper({ source: 'installed', path: '/x/whisper-cli' })).toContain('PlexFixer installed')
    expect(describeWhisper({ source: 'path', path: '/opt/homebrew/bin/whisper-cli' })).toContain('already installed')
    expect(describeWhisper({ source: 'none' })).toContain('needs one')
  })
})
