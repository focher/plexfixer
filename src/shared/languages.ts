/**
 * ISO 639 language handling.
 *
 * About twenty languages have two ISO 639-2 codes: a bibliographic one (/B:
 * "fre", "ger", "dut") and a terminology one (/T: "fra", "deu", "nld").
 * Containers disagree on which to use. Matroska specifies /B. MP4 specifies /T
 * in the `mdhd` box, and Apple's players read an MP4 holding "fre" as an
 * unknown language. Files also turn up with BCP-47 tags ("en-US") or names.
 *
 * So PlexFixer normalises everything to /B *internally*, for comparing and
 * displaying, and writes whichever form the output container expects
 * (`languageForContainer`). Writing /B into an MP4 is what used to make
 * French tracks show as unknown after a repair.
 */

import type { ContainerFormat } from './types.js'

export const UNDEFINED_LANGUAGE = 'und'

interface LanguageEntry {
  /** ISO 639-2/B — the canonical form used throughout the app. */
  bib: string
  /** ISO 639-2/T, when it differs from the bibliographic code. */
  term?: string
  /** ISO 639-1 two-letter code. */
  alpha2?: string
  name: string
}

/**
 * The languages that realistically show up in a Plex library. Anything not in
 * this table still round-trips: unknown three-letter codes are passed through
 * unchanged rather than being rewritten to `und`.
 */
const LANGUAGES: LanguageEntry[] = [
  { bib: 'eng', alpha2: 'en', name: 'English' },
  { bib: 'spa', alpha2: 'es', name: 'Spanish' },
  { bib: 'fre', term: 'fra', alpha2: 'fr', name: 'French' },
  { bib: 'ger', term: 'deu', alpha2: 'de', name: 'German' },
  { bib: 'ita', alpha2: 'it', name: 'Italian' },
  { bib: 'por', alpha2: 'pt', name: 'Portuguese' },
  { bib: 'dut', term: 'nld', alpha2: 'nl', name: 'Dutch' },
  { bib: 'rus', alpha2: 'ru', name: 'Russian' },
  { bib: 'jpn', alpha2: 'ja', name: 'Japanese' },
  { bib: 'chi', term: 'zho', alpha2: 'zh', name: 'Chinese' },
  { bib: 'kor', alpha2: 'ko', name: 'Korean' },
  { bib: 'ara', alpha2: 'ar', name: 'Arabic' },
  { bib: 'hin', alpha2: 'hi', name: 'Hindi' },
  { bib: 'ben', alpha2: 'bn', name: 'Bengali' },
  { bib: 'tam', alpha2: 'ta', name: 'Tamil' },
  { bib: 'tel', alpha2: 'te', name: 'Telugu' },
  { bib: 'pol', alpha2: 'pl', name: 'Polish' },
  { bib: 'swe', alpha2: 'sv', name: 'Swedish' },
  { bib: 'nor', alpha2: 'no', name: 'Norwegian' },
  { bib: 'dan', alpha2: 'da', name: 'Danish' },
  { bib: 'fin', alpha2: 'fi', name: 'Finnish' },
  { bib: 'ice', term: 'isl', alpha2: 'is', name: 'Icelandic' },
  { bib: 'cze', term: 'ces', alpha2: 'cs', name: 'Czech' },
  { bib: 'slo', term: 'slk', alpha2: 'sk', name: 'Slovak' },
  { bib: 'hun', alpha2: 'hu', name: 'Hungarian' },
  { bib: 'rum', term: 'ron', alpha2: 'ro', name: 'Romanian' },
  { bib: 'gre', term: 'ell', alpha2: 'el', name: 'Greek' },
  { bib: 'tur', alpha2: 'tr', name: 'Turkish' },
  { bib: 'heb', alpha2: 'he', name: 'Hebrew' },
  { bib: 'tha', alpha2: 'th', name: 'Thai' },
  { bib: 'vie', alpha2: 'vi', name: 'Vietnamese' },
  { bib: 'ind', alpha2: 'id', name: 'Indonesian' },
  { bib: 'may', term: 'msa', alpha2: 'ms', name: 'Malay' },
  { bib: 'tgl', alpha2: 'tl', name: 'Tagalog' },
  { bib: 'ukr', alpha2: 'uk', name: 'Ukrainian' },
  { bib: 'bul', alpha2: 'bg', name: 'Bulgarian' },
  { bib: 'hrv', alpha2: 'hr', name: 'Croatian' },
  { bib: 'srp', alpha2: 'sr', name: 'Serbian' },
  { bib: 'slv', alpha2: 'sl', name: 'Slovenian' },
  { bib: 'est', alpha2: 'et', name: 'Estonian' },
  { bib: 'lav', alpha2: 'lv', name: 'Latvian' },
  { bib: 'lit', alpha2: 'lt', name: 'Lithuanian' },
  { bib: 'per', term: 'fas', alpha2: 'fa', name: 'Persian' },
  { bib: 'urd', alpha2: 'ur', name: 'Urdu' },
  { bib: 'mal', alpha2: 'ml', name: 'Malayalam' },
  { bib: 'kan', alpha2: 'kn', name: 'Kannada' },
  { bib: 'mar', alpha2: 'mr', name: 'Marathi' },
  { bib: 'guj', alpha2: 'gu', name: 'Gujarati' },
  { bib: 'pan', alpha2: 'pa', name: 'Punjabi' },
  { bib: 'cat', alpha2: 'ca', name: 'Catalan' },
  { bib: 'baq', term: 'eus', alpha2: 'eu', name: 'Basque' },
  { bib: 'glg', alpha2: 'gl', name: 'Galician' },
  { bib: 'wel', term: 'cym', alpha2: 'cy', name: 'Welsh' },
  { bib: 'gle', alpha2: 'ga', name: 'Irish' },
  { bib: 'lat', alpha2: 'la', name: 'Latin' },
  { bib: 'mul', name: 'Multiple languages' },
  { bib: 'zxx', name: 'No linguistic content' },
  { bib: UNDEFINED_LANGUAGE, name: 'Undefined' }
]

const BY_ANY = new Map<string, LanguageEntry>()
for (const entry of LANGUAGES) {
  BY_ANY.set(entry.bib, entry)
  if (entry.term) BY_ANY.set(entry.term, entry)
  if (entry.alpha2) BY_ANY.set(entry.alpha2, entry)
  BY_ANY.set(entry.name.toLowerCase(), entry)
}

/**
 * Normalise any language tag to ISO 639-2/B.
 *
 * Accepts `en`, `eng`, `en-US`, `English`, `fra`, `fre`. Unknown tags are
 * lowercased and returned as-is so nothing is silently destroyed; an empty or
 * missing tag becomes `und`.
 */
export function normalizeLanguage(raw: string | undefined | null): string {
  if (!raw) return UNDEFINED_LANGUAGE
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed || trimmed === 'unknown' || trimmed === 'undetermined') return UNDEFINED_LANGUAGE
  // BCP-47 / locale forms: take the primary subtag ("pt-BR" -> "pt").
  const primary = trimmed.split(/[-_]/)[0]
  return BY_ANY.get(trimmed)?.bib ?? BY_ANY.get(primary)?.bib ?? primary
}

/** True when the tag carries no usable language information. */
export function isUndefinedLanguage(tag: string | undefined | null): boolean {
  const normalized = normalizeLanguage(tag)
  return normalized === UNDEFINED_LANGUAGE || normalized === '' || normalized === 'zxx'
}

/** Compare two tags after normalisation. */
export function sameLanguage(a: string | undefined, b: string | undefined): boolean {
  return normalizeLanguage(a) === normalizeLanguage(b)
}

/** Human-readable name for a tag, falling back to the uppercased tag. */
export function languageName(tag: string | undefined): string {
  const normalized = normalizeLanguage(tag)
  return BY_ANY.get(normalized)?.name ?? normalized.toUpperCase()
}

/** True when the tag is a three-letter code this app knows about. */
export function isKnownLanguage(tag: string | undefined): boolean {
  return BY_ANY.has(normalizeLanguage(tag))
}

/** The full picker list, sorted by name with `Undefined` pushed to the end. */
export function languageOptions(): { value: string; label: string }[] {
  return LANGUAGES.filter((entry) => entry.bib !== UNDEFINED_LANGUAGE)
    .map((entry) => ({ value: entry.bib, label: entry.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .concat({ value: UNDEFINED_LANGUAGE, label: 'Undefined' })
}

/**
 * The form of a language code a container expects: ISO 639-2/T for MP4 (where
 * it differs from /B), /B for Matroska. Codes this app does not know, and
 * `und`, pass through as normalised.
 */
export function languageForContainer(tag: string | undefined | null, container: 'mp4' | 'mkv'): string {
  const normalized = normalizeLanguage(tag)
  const entry = BY_ANY.get(normalized)
  if (!entry) return normalized
  return container === 'mp4' ? (entry.term ?? entry.bib) : entry.bib
}

/**
 * Whether a raw tag, as found in a file, is already the right code for that
 * file's container — so rewriting it would change nothing a player cares
 * about, or make things worse.
 *
 * An unknown three-letter code counts as canonical: it is left alone rather
 * than guessed at. In a container that is neither MP4 nor Matroska, either
 * ISO 639-2 form is accepted.
 */
export function isCanonicalFor(raw: string, container: ContainerFormat): boolean {
  const lower = raw.trim().toLowerCase()
  if (!/^[a-z]{3}$/.test(lower)) return false
  const entry = BY_ANY.get(lower)
  if (!entry) return true
  if (container === 'mp4') return lower === (entry.term ?? entry.bib)
  if (container === 'matroska') return lower === entry.bib
  return lower === entry.bib || lower === entry.term
}
