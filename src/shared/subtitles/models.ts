/**
 * The Whisper models, and which of them is worth fetching.
 *
 * Pointing Settings at a `whisper-cli` binary is easy — Homebrew has one, and
 * whisper.cpp publishes Windows builds. Finding a *model* is the part that
 * stops people: nothing installs one, the file names say nothing about what is
 * in them, and the obvious choice (the biggest) is a three-gigabyte download
 * that transcribes a film slower than watching it. So the list lives here, with
 * what each one is for, and the app fetches whichever one is asked for.
 *
 * Every entry carries the size and the SHA-256 of the file, both read from
 * Hugging Face's own index of the repository. They are pinned for the same
 * reason the ffmpeg downloads are: a model file is read by a binary this app
 * runs, so what lands on disk has to be what was chosen rather than whatever
 * was at a URL that day. A download whose hash does not match is thrown away.
 *
 * The hashes are also the reason the native side needs no list of its own. It
 * is handed a file name it checks the shape of, and a hash it checks the
 * download against, and it builds the address itself from a fixed prefix — so
 * nothing here can send it anywhere else.
 */

/** One model on Hugging Face, with what it costs and what it is good for. */
export interface WhisperModel {
  /** The file name, which is also its id. Settings holds a path to a copy. */
  file: string
  /** How it is named on screen. */
  label: string
  /** The exact size, from Hugging Face's index. */
  sizeBytes: number
  /** Lowercase hex SHA-256, from the same index. */
  sha256: string
  /** False for the `.en` models, which only ever hear English. */
  multilingual: boolean
  /** One line: what it is for, and what it costs. */
  summary: string
}

/**
 * The repository the models come from, and the only one.
 *
 * `ggerganov/whisper.cpp` is whisper.cpp's own conversion of the OpenAI
 * weights into the ggml format its loader reads. The PyTorch weights from
 * anywhere else are not a thing `whisper-cli` can open.
 */
export const WHISPER_MODEL_REPOSITORY = 'ggerganov/whisper.cpp'

/**
 * Six models rather than the thirty that exist.
 *
 * The full list is mostly historical: v1 and v2 of the large model, every size
 * in both quantised and plain form, and the `.en` twin of each. What a person
 * choosing one actually needs is a short ladder — fast and English, accurate
 * and English, everything-language, and the two that are better still if you
 * can wait — so that is what this is.
 *
 * Quantised models are listed beside their plain versions rather than hidden:
 * `q5_0` is a third of the size for a difference in output that is hard to
 * find, and on a machine with limited memory it is the difference between
 * running and not.
 */
export const WHISPER_MODELS: readonly WhisperModel[] = [
  {
    file: 'ggml-base.en.bin',
    label: 'Base (English)',
    sizeBytes: 147_964_211,
    sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
    multilingual: false,
    summary: 'Quick, and small enough to try the feature out with. Clean dialogue comes out right; accents and names do not.'
  },
  {
    file: 'ggml-small.en.bin',
    label: 'Small (English)',
    sizeBytes: 487_614_201,
    sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
    multilingual: false,
    summary: 'Where names start coming out spelled the way the film spells them.'
  },
  {
    file: 'ggml-medium.en-q5_0.bin',
    label: 'Medium (English, quantised)',
    sizeBytes: 539_225_533,
    sha256: '76733e26ad8fe1c7a5bf7531a9d41917b2adc0f20f2e4f5531688a8c6cd88eb0',
    multilingual: false,
    summary: 'Medium’s accuracy at small’s footprint. English only, and the best of these if that is all you need.'
  },
  {
    file: 'ggml-large-v3-turbo-q5_0.bin',
    label: 'Large v3 turbo (quantised)',
    sizeBytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    multilingual: true,
    summary: 'Every language, and fast for its accuracy. The one to take if you only take one.'
  },
  {
    file: 'ggml-large-v3-turbo.bin',
    label: 'Large v3 turbo',
    sizeBytes: 1_624_555_275,
    sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
    multilingual: true,
    summary: 'The same model unquantised. Worth the extra gigabyte only if you have the memory to spare.'
  },
  {
    file: 'ggml-large-v3.bin',
    label: 'Large v3',
    sizeBytes: 3_095_033_483,
    sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
    multilingual: true,
    summary: 'The most accurate, and several times slower than turbo. The only one here that translates well.'
  }
]

/** The one to suggest when nothing has been chosen. */
export const RECOMMENDED_MODEL = 'ggml-large-v3-turbo-q5_0.bin'

export function whisperModel(file: string): WhisperModel | undefined {
  return WHISPER_MODELS.find((model) => model.file === file)
}

/**
 * The shape a model file name is allowed to have.
 *
 * The native side applies the same rule, which is what stops a name from being
 * a path: no separators, no dots on their own, nothing but the characters
 * these files actually use. This copy exists so the UI can say no before
 * asking rather than after.
 */
export const MODEL_FILE_PATTERN = /^ggml-[A-Za-z0-9](?:[A-Za-z0-9._-]{0,60}[A-Za-z0-9])?\.bin$/

export function isModelFileName(name: string): boolean {
  return MODEL_FILE_PATTERN.test(name) && !name.includes('..')
}

/**
 * A model already on this machine.
 *
 * `file` is matched against the catalogue to name it; a model fetched by hand
 * into the same folder is listed too, under its own file name.
 */
export interface InstalledModel {
  file: string
  path: string
  sizeBytes: number
}

/** A download in flight, as the page hears about it. */
export interface ModelProgress {
  /** The file being fetched. */
  file: string
  receivedBytes: number
  /** What the catalogue says it will be, so a bar can be drawn from the first byte. */
  totalBytes: number
}

/** Sizes written the way a download dialog writes them. */
export function describeModelSize(bytes: number): string {
  const gb = bytes / 1_000_000_000
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.round(bytes / 1_000_000)} MB`
}

/**
 * Whether a path points at one of the catalogue's models.
 *
 * Used to show the chosen model by name rather than by path. It compares file
 * names rather than whole paths on purpose: a model fetched here and a model
 * fetched by hand into a folder of your own are the same model.
 */
export function modelOfPath(path: string): WhisperModel | undefined {
  const name = path.split(/[\\/]/).pop() ?? ''
  return whisperModel(name)
}
