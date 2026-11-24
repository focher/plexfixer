import { describe, expect, it } from 'vitest'
import { isProblem, type HttpReply } from '@shared/subtitles/providers/types.js'
import {
  chatRequest,
  checkEndpoint,
  joinEndpoint,
  llmEngine,
  LLM_ENGINES,
  modelsRequest,
  readChat,
  readModels,
  type LlmTarget
} from '@shared/subtitles/llm.js'
import {
  buildAudioExtractCommand,
  buildUpload,
  buildWhisperCommand,
  isHallucinatedFiller,
  planChunks,
  readTranscription,
  secondsPerUpload,
  WHISPER_BYTES_PER_SECOND,
  asrService
} from '@shared/subtitles/asr.js'
import {
  applyTranslation,
  batchOfMissing,
  decodeFromWire,
  encodeForWire,
  LINE_BREAK,
  planBatches,
  readBatch,
  renderBatch,
  splitBatch,
  tokenBudget,
  translationInstruction
} from '@shared/subtitles/translate.js'
import type { Cue } from '@shared/subtitles/cues.js'

function reply(body: unknown, status = 200): HttpReply {
  return { status, text: typeof body === 'string' ? body : JSON.stringify(body) }
}

/* ------------------------------------------------------------------ *
 * Model endpoints
 * ------------------------------------------------------------------ */

describe('endpoints', () => {
  it('does not double a /v1 somebody pasted in', () => {
    // Every example in every vendor's documentation includes /v1, so people
    // paste it, and the result used to be /v1/v1/chat/completions.
    expect(joinEndpoint('https://api.openai.com/v1', '/v1/chat/completions')).toBe('https://api.openai.com/v1/chat/completions')
    expect(joinEndpoint('https://api.openai.com', '/v1/chat/completions')).toBe('https://api.openai.com/v1/chat/completions')
    expect(joinEndpoint('http://127.0.0.1:11434/', '/api/tags')).toBe('http://127.0.0.1:11434/api/tags')
  })

  it('refuses an address that is not one, with a sentence', () => {
    expect(checkEndpoint('')?.problem).toContain('No endpoint')
    expect(checkEndpoint('not an address')?.problem).toContain('not an address')
    expect(checkEndpoint('javascript:alert(1)')?.problem).toContain('not something this can fetch')
    expect(checkEndpoint('file:///etc/passwd')?.problem).toContain('not something this can fetch')
    expect(checkEndpoint('http://127.0.0.1:11434')).toBeUndefined()
    expect(checkEndpoint('https://api.anthropic.com')).toBeUndefined()
  })

  it('knows its engines and that only the hosted ones want a key', () => {
    expect(LLM_ENGINES.map((e) => e.id)).toEqual(['ollama', 'openai', 'anthropic'])
    expect(llmEngine('ollama')?.needsKey).toBe(false)
    expect(llmEngine('anthropic')?.needsKey).toBe(true)
    expect(llmEngine('nope')).toBeUndefined()
  })
})

describe('listing models', () => {
  const ollama: LlmTarget = { shape: 'ollama', endpoint: 'http://127.0.0.1:11434', model: '' }

  it('asks Ollama what it has', () => {
    const built = modelsRequest(ollama)
    expect(isProblem(built) ? '' : built.url).toBe('http://127.0.0.1:11434/api/tags')
  })

  it('reads an Ollama listing, size and all', () => {
    const models = readModels(
      'ollama',
      reply({
        models: [
          {
            name: 'qwen2.5:14b',
            model: 'qwen2.5:14b',
            size: 9_000_000_000,
            details: { parameter_size: '14.8B', quantization_level: 'Q4_K_M' }
          },
          { name: 'llama3.2:3b', model: 'llama3.2:3b', size: 2_000_000_000, details: {} }
        ]
      })
    )
    if (isProblem(models)) throw new Error(models.problem)
    expect(models.map((m) => m.id)).toEqual(['llama3.2:3b', 'qwen2.5:14b'])
    expect(models[1]).toMatchObject({ parameters: '14.8B', quantisation: 'Q4_K_M', sizeBytes: 9_000_000_000 })
  })

  it('says Ollama is not running rather than reporting a parse failure', () => {
    const problem = readModels('ollama', { status: 0, text: '' })
    expect(isProblem(problem) && problem.hint).toContain('ollama serve')
  })

  it('reads a hosted listing', () => {
    const models = readModels('anthropic', reply({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }] }))
    if (isProblem(models)) throw new Error(models.problem)
    expect(models).toEqual([{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }])
  })

  it('will not even ask a hosted service without a token', () => {
    const built = modelsRequest({ shape: 'openai', endpoint: 'https://api.openai.com', model: 'x' })
    expect(isProblem(built) && built.hint).toContain('Ollama')
  })

  it('reports a rejected token plainly', () => {
    const problem = readModels('openai', reply({ error: { message: 'bad key' } }, 401))
    expect(isProblem(problem) && problem.problem).toContain('not accepted')
  })
})

describe('asking a model something', () => {
  const ask = { system: 'be brief', user: 'translate this', maxTokens: 2048 }

  it('builds the three shapes at their own addresses', () => {
    const ollama = chatRequest({ shape: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'qwen2.5' }, ask)
    const openai = chatRequest({ shape: 'openai', endpoint: 'https://api.openai.com', model: 'gpt-4o-mini', apiKey: 'k' }, ask)
    const anthropic = chatRequest({ shape: 'anthropic', endpoint: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', apiKey: 'k' }, ask)
    if (isProblem(ollama) || isProblem(openai) || isProblem(anthropic)) throw new Error('expected requests')

    expect(ollama.url).toBe('http://127.0.0.1:11434/api/chat')
    expect(openai.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(anthropic.url).toBe('https://api.anthropic.com/v1/messages')
    expect(anthropic.headers?.['anthropic-version']).toBe('2023-06-01')
    expect(openai.headers?.Authorization).toBe('Bearer k')
  })

  it('tells Ollama not to stream', () => {
    // Streaming hands the transport newline-delimited JSON, and it returns one
    // body: the first fragment of the answer and nothing else.
    const built = chatRequest({ shape: 'ollama', endpoint: 'http://h:1', model: 'm' }, ask)
    if (isProblem(built)) throw new Error(built.problem)
    expect(JSON.parse(built.body ?? '{}').stream).toBe(false)
  })

  it('does not sample: the same line must come back the same way', () => {
    for (const shape of ['ollama', 'openai', 'anthropic'] as const) {
      const built = chatRequest({ shape, endpoint: 'https://h', model: 'm', apiKey: 'k' }, ask)
      if (isProblem(built)) throw new Error(built.problem)
      const body = JSON.parse(built.body ?? '{}')
      expect(shape === 'ollama' ? body.options.temperature : body.temperature).toBe(0)
    }
  })

  it('refuses with no model chosen', () => {
    const built = chatRequest({ shape: 'ollama', endpoint: 'http://h:1', model: '  ' }, ask)
    expect(isProblem(built) && built.hint).toContain('Pick one')
  })

  it('reads the answer out of all three shapes', () => {
    expect(readChat('anthropic', reply({ content: [{ type: 'text', text: 'Hello' }] }))).toBe('Hello')
    expect(readChat('openai', reply({ choices: [{ message: { content: 'Hello' } }] }))).toBe('Hello')
    expect(readChat('ollama', reply({ message: { content: 'Hello' } }))).toBe('Hello')
  })

  it('catches the Ollama failure that arrives as a success', () => {
    // A model that was never pulled: status 200, and an error field.
    const problem = readChat('ollama', reply({ error: 'model "qwen9" not found, try pulling it first' }))
    expect(isProblem(problem) && problem.problem).toContain('not found')
    expect(isProblem(problem) && problem.hint).toContain('ollama pull')
  })

  it('passes on whatever the service said went wrong', () => {
    const problem = readChat('openai', reply({ error: { message: 'model_not_found' } }, 404))
    expect(isProblem(problem) && problem.problem).toContain('model_not_found')
  })
})

/* ------------------------------------------------------------------ *
 * Transcription
 * ------------------------------------------------------------------ */

describe('audio for whisper', () => {
  it('takes the track it was told to and resamples it', () => {
    const args = buildAudioExtractCommand('/films/a.mkv', 2, '/tmp/a.wav')
    expect(args).toEqual([
      '-i', '/films/a.mkv',
      '-vn', '-sn', '-dn',
      '-map', '0:2',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      '-y', '/tmp/a.wav'
    ])
  })

  it('seeks before the input, which is the fast kind', () => {
    const args = buildAudioExtractCommand('/films/a.mkv', 1, '/tmp/a.wav', { startSeconds: 600, durationSeconds: 300 })
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args.indexOf('-t')).toBeGreaterThan(args.indexOf('-i'))
  })
})

describe('whisper on this machine', () => {
  it('writes an SRT beside the stem it was given', () => {
    const args = buildWhisperCommand({
      binary: 'whisper-cli',
      modelPath: '/models/ggml-large-v3.bin',
      audioPath: '/tmp/a.wav',
      outputStem: '/tmp/a',
      language: 'rus',
      threads: 8
    })
    expect(args).toContain('-osrt')
    expect(args.slice(args.indexOf('-l'), args.indexOf('-l') + 2)).toEqual(['-l', 'ru'])
    expect(args).not.toContain('-tr')
  })

  it('lets whisper detect the language when the file does not say', () => {
    const args = buildWhisperCommand({ binary: 'w', modelPath: 'm', audioPath: 'a', outputStem: 'o', language: 'und' })
    expect(args.slice(args.indexOf('-l'), args.indexOf('-l') + 2)).toEqual(['-l', 'auto'])
  })

  it('can translate to English in the same pass', () => {
    const args = buildWhisperCommand({ binary: 'w', modelPath: 'm', audioPath: 'a', outputStem: 'o', language: 'rus', translateToEnglish: true })
    expect(args).toContain('-tr')
  })
})

describe('cutting a film into uploadable pieces', () => {
  it('leaves a short film in one piece', () => {
    expect(planChunks(600, 900, [])).toEqual([{ index: 0, startSeconds: 0, durationSeconds: 600 }])
  })

  it('turns an upload limit into minutes of audio', () => {
    // 16-bit mono at 16 kHz is 32 kB a second, so 25 MB is about thirteen minutes.
    const seconds = secondsPerUpload(25 * 1024 * 1024)
    expect(seconds).toBeGreaterThan(700)
    expect(seconds).toBeLessThan(800)
    expect(seconds * WHISPER_BYTES_PER_SECOND).toBeLessThan(25 * 1024 * 1024)
  })

  it('cuts in silence rather than through a word', () => {
    // Speech everywhere except a gap at 9 minutes 30.
    const speech = [
      { startMs: 0, endMs: 570_000 },
      { startMs: 575_000, endMs: 1_200_000 }
    ]
    const chunks = planChunks(1200, 600, speech)
    // The gap's middle is 572.5s, inside the last fifth of the 600s allowance,
    // so the first cut lands there rather than on the limit.
    expect(chunks[0].durationSeconds).toBeCloseTo(572.5, 1)
    expect(chunks[1].startSeconds).toBeCloseTo(572.5, 1)
    // Which leaves 627.5s, more than one piece can hold, so there are three.
    for (const chunk of chunks) expect(chunk.durationSeconds).toBeLessThanOrEqual(600)
  })

  it('cuts on time when there is no silence to cut in', () => {
    const chunks = planChunks(1200, 600, [{ startMs: 0, endMs: 1_200_000 }])
    expect(chunks.map((c) => c.startSeconds)).toEqual([0, 600])
  })

  it('covers the whole film with no gaps and no overlaps', () => {
    const speech = Array.from({ length: 40 }, (_, i) => ({ startMs: i * 180_000, endMs: i * 180_000 + 170_000 }))
    const chunks = planChunks(7200, 600, speech)
    let at = 0
    for (const chunk of chunks) {
      expect(chunk.startSeconds).toBeCloseTo(at, 3)
      at = chunk.startSeconds + chunk.durationSeconds
    }
    expect(at).toBeCloseTo(7200, 1)
  })
})

describe('a speech endpoint', () => {
  const service = asrService('groq')!

  it('asks for segments, in the language it was told', () => {
    const upload = buildUpload({ service, apiKey: 'k', language: 'rus' }, 'chunk0.wav')
    if (isProblem(upload)) throw new Error(upload.problem)
    expect(upload.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(upload.fields).toMatchObject({ model: 'whisper-large-v3', response_format: 'verbose_json', language: 'ru' })
    expect(upload.headers.Authorization).toBe('Bearer k')
  })

  it('uses the translation endpoint, which takes no language', () => {
    const upload = buildUpload({ service, apiKey: 'k', language: 'rus', translateToEnglish: true }, 'chunk0.wav')
    if (isProblem(upload)) throw new Error(upload.problem)
    expect(upload.url).toContain('/v1/audio/translations')
    expect(upload.fields.language).toBeUndefined()
  })

  it('will not build an upload without a token', () => {
    const upload = buildUpload({ service }, 'chunk0.wav')
    expect(isProblem(upload) && upload.hint).toContain('local Whisper')
  })

  it('reads segments and shifts them by where the chunk started', () => {
    const cues = readTranscription(
      reply({ segments: [{ start: 1.5, end: 3.25, text: ' Привет ' }, { start: 4, end: 5, text: 'Как дела' }] }),
      600
    )
    if (isProblem(cues)) throw new Error(cues.problem)
    expect(cues).toEqual([
      { startMs: 601_500, endMs: 603_250, text: 'Привет' },
      { startMs: 604_000, endMs: 605_000, text: 'Как дела' }
    ])
  })

  it('falls back to reading plain SRT when that is what came back', () => {
    const cues = readTranscription({ status: 200, text: '1\n00:00:01,000 --> 00:00:02,000\nHello\n' }, 60)
    if (isProblem(cues)) throw new Error(cues.problem)
    expect(cues).toEqual([{ startMs: 61_000, endMs: 62_000, text: 'Hello' }])
  })

  it('explains a chunk that was too big instead of reporting 413', () => {
    const problem = readTranscription(reply({}, 413))
    expect(isProblem(problem) && problem.hint).toContain('chunk length')
  })

  it('drops the credits Whisper invents over silence', () => {
    const cues = readTranscription(
      reply({
        segments: [
          { start: 0, end: 4, text: 'Субтитры сделал DimaTorzok' },
          { start: 5, end: 7, text: 'A real line of dialogue' },
          { start: 8, end: 12, text: 'Thanks for watching!' }
        ]
      })
    )
    if (isProblem(cues)) throw new Error(cues.problem)
    expect(cues.map((c) => c.text)).toEqual(['A real line of dialogue'])
  })

  it('does not mistake a long line that happens to mention watching', () => {
    expect(isHallucinatedFiller('Thanks for watching')).toBe(true)
    expect(
      isHallucinatedFiller(
        'I spent the whole evening thanks for watching the river go by and thinking about what you said to me'
      )
    ).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * Translation
 * ------------------------------------------------------------------ */

const RUSSIAN: Cue[] = Array.from({ length: 95 }, (_, index) => ({
  startMs: index * 3000,
  endMs: index * 3000 + 2000,
  text: `Строка ${index}`
}))

describe('batching a translation', () => {
  it('cuts into batches of the asked-for size, with context in front', () => {
    const batches = planBatches(RUSSIAN, { size: 40, contextLines: 4 })
    expect(batches.map((b) => b.indexes.length)).toEqual([40, 40, 15])
    expect(batches[0].context).toEqual([])
    expect(batches[1].context).toEqual([36, 37, 38, 39])
  })

  it('covers every cue exactly once', () => {
    const seen = planBatches(RUSSIAN, { size: 7 }).flatMap((b) => b.indexes)
    expect(seen).toEqual(RUSSIAN.map((_, index) => index))
  })

  it('stops a batch early for a film that is all monologue', () => {
    const wordy: Cue[] = Array.from({ length: 20 }, (_, i) => ({ startMs: i, endMs: i + 1, text: 'x'.repeat(900) }))
    const batches = planBatches(wordy, { size: 40, maxCharacters: 3000 })
    expect(batches[0].indexes.length).toBeLessThan(5)
    expect(batches.flatMap((b) => b.indexes)).toHaveLength(20)
  })

  it('always puts at least one line in a batch, however long that line is', () => {
    const huge: Cue[] = [{ startMs: 0, endMs: 1, text: 'x'.repeat(50_000) }]
    expect(planBatches(huge, { maxCharacters: 100 })[0].indexes).toEqual([0])
  })

  it('asks for enough room for an answer longer than the question', () => {
    const batches = planBatches(RUSSIAN, { size: 40 })
    expect(tokenBudget(RUSSIAN, batches[0])).toBeGreaterThan(256)
    expect(tokenBudget(RUSSIAN, batches[0])).toBeLessThanOrEqual(16_000)
  })
})

describe('the message sent', () => {
  it('numbers each line and marks the context as not for translating', () => {
    const batch = { indexes: [5, 6], context: [3, 4] }
    const message = renderBatch(RUSSIAN, batch, new Map([[4, 'Line four, in English']]))
    expect(message).toContain('Do not include them in your answer')
    expect(message).toContain('Line four, in English')
    expect(message).toContain('[[5]] Строка 5')
    expect(message).toContain('[[6]] Строка 6')
    // The context lines must not be numbered, or the model will answer them.
    expect(message).not.toContain('[[4]]')
  })

  it('tells it the languages by name and forbids merging lines', () => {
    const instruction = translationInstruction('rus', 'eng')
    expect(instruction).toContain('Russian to English')
    expect(instruction).toContain('Never merge two lines')
    expect(instruction).toContain(LINE_BREAK)
  })

  it('carries a line break inside a cue as a character', () => {
    expect(encodeForWire('- Yes.\n- No.')).toBe(`- Yes.${LINE_BREAK}- No.`)
    expect(decodeFromWire(`- Yes.${LINE_BREAK}- No.`)).toBe('- Yes.\n- No.')
    expect(decodeFromWire(`one${LINE_BREAK}${LINE_BREAK}two`)).toBe('one\ntwo')
  })
})

describe('reading a translation back', () => {
  const batch = { indexes: [0, 1, 2], context: [] }

  it('takes the numbered lines and ignores the chatter around them', () => {
    const result = readBatch(
      ['Sure! Here are the translations:', '', '[[0]] Line zero', '[[1]] Line one', '[[2]] Line two', '', 'Let me know if you need anything else.'].join('\n'),
      batch
    )
    expect(result.missing).toEqual([])
    // Both the preamble and the sign-off are gone. The sign-off is the harder
    // of the two: without a rule that a blank line ends the block it reads as a
    // second line of subtitle 2 and gets glued onto it.
    expect([...result.lines.values()]).toEqual(['Line zero', 'Line one', 'Line two'])
  })

  it('reports a line that did not come back rather than shifting the rest up', () => {
    // The failure that matters: a model merging two lines leaves every
    // subsequent subtitle attached to the wrong moment, and nothing about the
    // file looks wrong until you watch it.
    const result = readBatch('[[0]] Line zero\n[[2]] Line two', batch)
    expect(result.missing).toEqual([1])
    expect(result.lines.get(2)).toBe('Line two')
  })

  it('reports a line it was never asked for', () => {
    const result = readBatch('[[0]] a\n[[1]] b\n[[2]] c\n[[9]] invented', batch)
    expect(result.unexpected).toEqual([9])
    expect(result.lines.has(9)).toBe(false)
  })

  it('treats an empty answer for a line as a missing one', () => {
    const result = readBatch('[[0]] a\n[[1]]\n[[2]] c', batch)
    expect(result.missing).toEqual([1])
  })

  it('joins a real line break the model kept', () => {
    const result = readBatch('[[0]] - Yes.\n- No.\n[[1]] b\n[[2]] c', batch)
    expect(result.lines.get(0)).toBe('- Yes.\n- No.')
  })

  it('steps over a code fence', () => {
    const result = readBatch('```\n[[0]] a\n[[1]] b\n[[2]] c\n```', batch)
    expect(result.missing).toEqual([])
    expect(result.lines.get(2)).toBe('c')
  })

  it('survives an answer with nothing in it', () => {
    expect(readBatch('', batch).missing).toEqual([0, 1, 2])
    expect(readBatch('I cannot help with that.', batch).missing).toEqual([0, 1, 2])
  })
})

describe('putting a translation into the cues', () => {
  it('keeps the original where a line never came back', () => {
    const translated = applyTranslation(RUSSIAN.slice(0, 3), new Map([[0, 'Line zero'], [2, 'Line two']]))
    expect(translated.map((c) => c.text)).toEqual(['Line zero', 'Строка 1', 'Line two'])
    // And the timings are untouched.
    expect(translated[1]).toMatchObject({ startMs: 3000, endMs: 5000 })
  })

  it('decodes the line break marker on the way in', () => {
    const translated = applyTranslation(RUSSIAN.slice(0, 1), new Map([[0, `- Yes.${LINE_BREAK}- No.`]]))
    expect(translated[0].text).toBe('- Yes.\n- No.')
  })
})

describe('retrying', () => {
  it('asks again for only the lines that are missing', () => {
    const batch = { indexes: [0, 1, 2, 3], context: [] }
    expect(batchOfMissing(batch, [1, 3]).indexes).toEqual([1, 3])
  })

  it('halves a batch that will not reconcile, carrying context into the second half', () => {
    const halves = splitBatch({ indexes: [0, 1, 2, 3, 4, 5], context: [] })
    expect(halves.map((h) => h.indexes)).toEqual([[0, 1, 2], [3, 4, 5]])
    expect(halves[1].context).toEqual([0, 1, 2])
  })

  it('cannot split a single line any further', () => {
    const one = { indexes: [7], context: [] }
    expect(splitBatch(one)).toEqual([one])
  })
})
