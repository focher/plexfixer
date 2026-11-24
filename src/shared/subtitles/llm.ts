/**
 * Talking to a language model, wherever it happens to be running.
 *
 * Three shapes cover everything worth supporting: the OpenAI chat-completions
 * shape, which half the industry has copied and which therefore reaches Groq,
 * Together, LM Studio, llama.cpp's own server and anything else that advertises
 * itself as "OpenAI-compatible"; Anthropic's messages shape; and Ollama's own,
 * which is neither of those and is the one that matters for running a model on
 * your own machine with no key and no account.
 *
 * Like the subtitle providers, nothing here fetches. Each function either
 * builds a request or reads a reply, which keeps the whole of it testable
 * against saved payloads and keeps the one door to the outside in Rust.
 *
 * A note on what this is *for*. Translation is a language model's job and it is
 * genuinely good at it. Transcription is not — see `asr.ts`. Ollama in
 * particular serves text and vision models and has no speech-to-text endpoint
 * at all, so "transcribe with a local model" means whisper.cpp, not Ollama. The
 * two capabilities are kept in separate files because they are separate
 * services with separate endpoints, and a settings screen that implied
 * otherwise would be lying.
 */

import {
  asArray,
  asRecord,
  asText,
  isProblem,
  readJson,
  type HttpReply,
  type HttpRequest,
  type ProviderProblem
} from './providers/types.js'

/** Which wire shape a model endpoint speaks. */
export type LlmShape = 'openai' | 'anthropic' | 'ollama'

export interface LlmEngine {
  id: LlmShape
  name: string
  /** Where the default endpoint points, and what it is. */
  defaultEndpoint: string
  defaultModel: string
  /** Whether a key is needed, which is the whole difference between local and not. */
  needsKey: boolean
  /** One line for the picker. */
  summary: string
}

/**
 * The engines, with endpoints that are defaults and not restrictions.
 *
 * The OpenAI entry is deliberately described by its shape rather than by its
 * vendor: pointing it at `https://api.groq.com/openai` or at a llama.cpp server
 * on the next desk is the ordinary use of it, not a workaround.
 */
export const LLM_ENGINES: readonly LlmEngine[] = [
  {
    id: 'ollama',
    name: 'Ollama (on this machine)',
    defaultEndpoint: 'http://127.0.0.1:11434',
    defaultModel: '',
    needsKey: false,
    summary:
      'A model running on your own machine. Nothing leaves it, there is no key and no bill, and the models it ' +
      'has are listed for you to choose from.'
  },
  {
    id: 'openai',
    name: 'OpenAI-compatible',
    defaultEndpoint: 'https://api.openai.com',
    defaultModel: 'gpt-4o-mini',
    needsKey: true,
    summary:
      'The chat shape most services copied. Points at OpenAI by default; Groq, Together, LM Studio and ' +
      'llama.cpp’s own server all answer the same way.'
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    defaultEndpoint: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5-5',
    needsKey: true,
    summary: 'Claude, through the messages API.'
  }
]

export function llmEngine(id: string): LlmEngine | undefined {
  return LLM_ENGINES.find((engine) => engine.id === id)
}

/** Where and what to talk to. */
export interface LlmTarget {
  shape: LlmShape
  /** Base address with no trailing slash; the paths below are added to it. */
  endpoint: string
  model: string
  apiKey?: string
}

/* ------------------------------------------------------------------ *
 * Addresses
 * ------------------------------------------------------------------ */

/**
 * Join a base address to a path without producing a double slash or losing a
 * path prefix the user put in deliberately.
 *
 * `https://host/v1` + `/v1/chat/completions` would otherwise become
 * `https://host/v1/v1/chat/completions`, which is the single most common way
 * an OpenAI-compatible endpoint is misconfigured — people paste the address
 * including `/v1` because that is what every example shows.
 */
export function joinEndpoint(endpoint: string, path: string): string {
  const base = endpoint.trim().replace(/\/+$/, '')
  const tail = path.replace(/^\/+/, '')
  if (base.endsWith('/v1') && tail.startsWith('v1/')) return `${base}/${tail.slice(3)}`
  return `${base}/${tail}`
}

/**
 * Check an address before anything is built against it.
 *
 * The endpoint is the one part of this a person types, so it is the one part
 * that can be a typo, a file path, or a `javascript:` URL pasted by accident.
 * Only http and https, and only an absolute address. The native side checks it
 * again and is the one that actually decides; this exists so the answer is a
 * sentence rather than a failed request.
 */
export function checkEndpoint(endpoint: string): ProviderProblem | undefined {
  const trimmed = endpoint.trim()
  if (trimmed === '') return { problem: 'No endpoint to talk to — fill one in under Settings → Subtitles.' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { problem: `“${trimmed}” is not an address.`, hint: 'It should look like http://127.0.0.1:11434.' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { problem: `${parsed.protocol} is not something this can fetch.`, hint: 'Use http:// or https://.' }
  }
  return undefined
}

function keyHeaders(target: LlmTarget): Record<string, string> {
  switch (target.shape) {
    case 'anthropic':
      return {
        'x-api-key': target.apiKey ?? '',
        // Pinned rather than tracking latest: a version bump that changes the
        // reply shape should be a decision, not a surprise one morning.
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    case 'openai':
      return { Authorization: `Bearer ${target.apiKey ?? ''}`, 'Content-Type': 'application/json' }
    case 'ollama':
      return { 'Content-Type': 'application/json' }
  }
}

function needsKey(target: LlmTarget): ProviderProblem | undefined {
  const engine = llmEngine(target.shape)
  if (engine?.needsKey && !target.apiKey) {
    return {
      problem: `${engine.name} needs an API token.`,
      hint: 'Paste one into Settings → Subtitles, or switch to Ollama to run a model on this machine.'
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * Which models are there
 * ------------------------------------------------------------------ */

export interface LlmModel {
  id: string
  /** A friendlier name where the service gives one. */
  label?: string
  /** For a local model: how big it is on disk, which is the thing worth knowing. */
  sizeBytes?: number
  /** For a local model: `7B`, `70B`. */
  parameters?: string
  quantisation?: string
}

/**
 * Ask what models are available.
 *
 * This is the reason Ollama is worth supporting properly rather than as a URL
 * field: a local install has whichever models somebody pulled, under names only
 * that machine knows, and asking is the only way to offer a list instead of a
 * blank box and a guess.
 */
export function modelsRequest(target: LlmTarget): HttpRequest | ProviderProblem {
  const badEndpoint = checkEndpoint(target.endpoint)
  if (badEndpoint) return badEndpoint
  const missingKey = needsKey(target)
  if (missingKey) return missingKey

  switch (target.shape) {
    case 'ollama':
      return { url: joinEndpoint(target.endpoint, '/api/tags') }
    case 'openai':
    case 'anthropic':
      return { url: joinEndpoint(target.endpoint, '/v1/models'), headers: keyHeaders(target) }
  }
}

export function readModels(shape: LlmShape, reply: HttpReply): LlmModel[] | ProviderProblem {
  const parsed = readJson(reply, 'The model endpoint')
  if (isProblem(parsed)) {
    // Ollama not being there at all is the overwhelmingly likely cause, and is
    // worth saying rather than reporting a parse failure.
    return shape === 'ollama'
      ? { problem: 'Nothing answered at that address.', hint: 'Is Ollama running? `ollama serve` starts it.' }
      : parsed
  }
  const body = asRecord(parsed)

  if (reply.status === 401 || reply.status === 403) {
    return { problem: 'That API token was not accepted.' }
  }
  if (reply.status >= 400) {
    const message = asText(asRecord(body?.error)?.message) ?? asText(body?.error) ?? asText(body?.message)
    return { problem: message ?? `The model endpoint returned ${reply.status}.` }
  }

  const models: LlmModel[] = []
  if (shape === 'ollama') {
    for (const entry of asArray(body?.models)) {
      const row = asRecord(entry)
      const id = asText(row?.model) ?? asText(row?.name)
      if (!id) continue
      const details = asRecord(row?.details)
      models.push({
        id,
        label: asText(row?.name),
        sizeBytes: typeof row?.size === 'number' ? row.size : undefined,
        parameters: asText(details?.parameter_size),
        quantisation: asText(details?.quantization_level)
      })
    }
  } else {
    for (const entry of asArray(body?.data)) {
      const row = asRecord(entry)
      const id = asText(row?.id)
      if (!id) continue
      models.push({ id, label: asText(row?.display_name) })
    }
  }

  return models.sort((a, b) => a.id.localeCompare(b.id))
}

/* ------------------------------------------------------------------ *
 * Asking it something
 * ------------------------------------------------------------------ */

export interface LlmAsk {
  /** The standing instruction, which does not change between batches. */
  system: string
  user: string
  maxTokens: number
  /**
   * Zero, always, for this app's purposes.
   *
   * Translating a subtitle is not a creative act: the same line should come
   * back the same way whether it is translated now or on a retry, and sampling
   * variety is the enemy of a batch whose lines have to be counted back.
   */
  temperature?: number
}

export function chatRequest(target: LlmTarget, ask: LlmAsk): HttpRequest | ProviderProblem {
  const badEndpoint = checkEndpoint(target.endpoint)
  if (badEndpoint) return badEndpoint
  const missingKey = needsKey(target)
  if (missingKey) return missingKey
  if (!target.model.trim()) {
    return {
      problem: 'No model chosen.',
      hint: target.shape === 'ollama' ? 'Pick one from the list beside the endpoint.' : 'Fill in the model name.'
    }
  }

  const temperature = ask.temperature ?? 0

  switch (target.shape) {
    case 'anthropic':
      return {
        url: joinEndpoint(target.endpoint, '/v1/messages'),
        method: 'POST',
        headers: keyHeaders(target),
        body: JSON.stringify({
          model: target.model,
          max_tokens: ask.maxTokens,
          temperature,
          system: ask.system,
          messages: [{ role: 'user', content: ask.user }]
        })
      }
    case 'openai':
      return {
        url: joinEndpoint(target.endpoint, '/v1/chat/completions'),
        method: 'POST',
        headers: keyHeaders(target),
        body: JSON.stringify({
          model: target.model,
          max_tokens: ask.maxTokens,
          temperature,
          messages: [
            { role: 'system', content: ask.system },
            { role: 'user', content: ask.user }
          ]
        })
      }
    case 'ollama':
      return {
        url: joinEndpoint(target.endpoint, '/api/chat'),
        method: 'POST',
        headers: keyHeaders(target),
        body: JSON.stringify({
          model: target.model,
          // Without this Ollama streams newline-delimited JSON, and the
          // transport hands back one body: the first fragment of the answer
          // and nothing else.
          stream: false,
          options: { temperature, num_predict: ask.maxTokens },
          messages: [
            { role: 'system', content: ask.system },
            { role: 'user', content: ask.user }
          ]
        })
      }
  }
}

/** The text of the answer, however the service wrapped it. */
export function readChat(shape: LlmShape, reply: HttpReply): string | ProviderProblem {
  const parsed = readJson(reply, 'The model')
  if (isProblem(parsed)) return parsed
  const body = asRecord(parsed)

  if (reply.status >= 400) {
    const message =
      asText(asRecord(body?.error)?.message) ?? asText(body?.error) ?? asText(body?.message) ?? `returned ${reply.status}`
    // A model name that does not exist is far and away the commonest failure,
    // and the services all phrase it differently enough to be worth passing on
    // verbatim rather than paraphrasing.
    return { problem: `The model ${message}.` }
  }

  switch (shape) {
    case 'anthropic': {
      const parts = asArray(body?.content)
        .map((part) => asText(asRecord(part)?.text))
        .filter((text): text is string => text !== undefined)
      return parts.length > 0 ? parts.join('') : { problem: 'The model answered with nothing.' }
    }
    case 'openai': {
      const choice = asRecord(asArray(body?.choices)[0])
      const text = asText(asRecord(choice?.message)?.content)
      return text ?? { problem: 'The model answered with nothing.' }
    }
    case 'ollama': {
      const text = asText(asRecord(body?.message)?.content)
      if (text) return text
      // Ollama answers a request for a model it has not pulled with a 200 and
      // an `error` field, which is the one case where the status says nothing.
      const error = asText(body?.error)
      return error
        ? { problem: `Ollama: ${error}`, hint: error.includes('not found') ? 'Pull it first: `ollama pull <model>`.' : undefined }
        : { problem: 'Ollama answered with nothing.' }
    }
  }
}
