import { describe, expect, it } from 'vitest'

import {
  describeModelSize,
  isModelFileName,
  modelOfPath,
  RECOMMENDED_MODEL,
  whisperModel,
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
