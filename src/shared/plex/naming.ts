/**
 * Naming a repaired file from what the file says about itself.
 *
 * A library is only as good as its names: Plex matches on them, and a folder
 * of `Movie.2006.1080p.BluRay.x264-GROUP.mkv` tells a person nothing. Once a
 * lookup has written a title and a release date into a file, the file can be
 * named from them.
 *
 * Two rules hold this together, and both are about not surprising anybody:
 *
 * A template that cannot be filled in is not used. If any token in it has
 * nothing behind it, the file keeps the name it has. Half a name — `Casino
 * Royale ()`, or ` (2006)` — is worse than no rename, and a file that quietly
 * loses its title is a file somebody has to find again.
 *
 * Whatever a template produces is scrubbed before it reaches a filesystem.
 * The text comes from a tag, which came from a stranger's database, so it is
 * assumed to contain a slash until proven otherwise.
 */

import { guessEpisode } from '../tmdb.js'
import { bareNumber } from './metadata.js'

/** The longest stem this will write, before the suffix and the extension. */
const MAX_STEM = 180

export interface TemplateToken {
  /** What goes in the braces. */
  key: string
  label: string
  /** What it stands for, and where it comes from. */
  hint: string
}

/**
 * Every token a template may use.
 *
 * A closed list: a token that is not on it is a typo, and a typo that quietly
 * wrote `{titel}` into a filename would be found one folder at a time.
 */
export const TEMPLATE_TOKENS: readonly TemplateToken[] = [
  { key: 'title', label: 'Title', hint: 'The title the file carries — what a lookup writes in' },
  { key: 'year', label: 'Year', hint: 'The four digits at the front of the release date' },
  { key: 'date', label: 'Release date', hint: 'The release date in full, as the file carries it' },
  { key: 'show', label: 'Series', hint: 'The series name, for an episode' },
  { key: 'season', label: 'Season', hint: 'The season number, with no leading zeros' },
  { key: 'episode', label: 'Episode', hint: 'The episode number, with no leading zeros' },
  { key: 'genre', label: 'Genre', hint: 'The genre tag, as written' },
  { key: 'name', label: 'Current name', hint: 'The name it has now, without the extension' }
]

const KEYS = new Set(TEMPLATE_TOKENS.map((token) => token.key))

/** What Plex asks for, and what most people want the moment they see it. */
export const SUGGESTED_MOVIE_TEMPLATES: readonly { template: string; label: string }[] = [
  { template: '{title} ({year})', label: 'The way Plex asks for them' },
  { template: '{title} ({date})', label: 'With the full release date' }
]

export const SUGGESTED_EPISODE_TEMPLATES: readonly { template: string; label: string }[] = [
  { template: '{show} - S{season}E{episode} - {title}', label: 'The way Plex asks for them' },
  { template: 'S{season}E{episode} - {title}', label: 'Inside a folder already named for the series' },
  { template: '{show} - S{season}E{episode}', label: 'Without the episode name' }
]

/**
 * Whether this file is an episode of something.
 *
 * What the file says comes first: a `show` tag with a number beside it is a
 * statement, not a guess. Failing that the name is read, which is all there
 * is to go on before a lookup has been done — and a file that says nothing
 * and is named like nothing is treated as a film, because that is the commoner
 * thing to have and the pattern will decline to use it anyway.
 */
export function looksLikeEpisode(tags: Record<string, string>, fileName: string): boolean {
  const has = (key: string): boolean => (tags[key] ?? '').trim() !== ''
  if (has('show') && (has('season_number') || has('episode_id'))) return true
  if (has('season_number') && has('episode_id')) return true
  return guessEpisode(fileName) !== undefined
}

/** The pattern that applies to this file: films and episodes are named apart. */
export function templateFor(
  templates: { movie: string; episode: string },
  tags: Record<string, string>,
  fileName: string
): string {
  return looksLikeEpisode(tags, fileName) ? templates.episode : templates.movie
}

const TOKEN = /\{([a-z_]+)\}/g

/** Why a file kept the name it had. */
export type NamingProblem =
  /** No template is set, which is the default and not a complaint. */
  | { kind: 'no-template' }
  /** A template with nothing to fill in would name every file the same. */
  | { kind: 'no-tokens' }
  | { kind: 'unknown'; token: string }
  | { kind: 'empty'; token: string }
  /** Everything in it was punctuation a filesystem will not take. */
  | { kind: 'unusable' }

export interface NamedFile {
  /** The stem to write, with no extension. */
  stem: string
  /** Absent when the template was used. */
  problem?: NamingProblem
}

/* Numbers are written bare — see `bareNumber`, which is where the rule lives. */

/**
 * The release date in the form a file name can carry.
 *
 * A date tag comes back in whatever shape the file holds it: `2022`,
 * `2022-03-24`, or a full ISO instant — `2022-03-24T12:00:00Z` — which is what
 * a lookup writes when the source gave it one. The clock half is never what
 * anybody means by {date} in a file name, and it is the half made of colons, so
 * it survives sanitising as "12 - 00 - 00Z" and renames the film to something
 * nobody would type. Only a value that is a date followed by a time is cut;
 * anything else is handed back exactly as it came, because guessing at an
 * unfamiliar format is how a name loses the part that mattered.
 */
function calendarDate(value: string): string {
  return /^(\d{4}(?:-\d{2}){0,2})[T ]/.exec(value)?.[1] ?? value
}

function valueFor(key: string, tags: Record<string, string>, sourceStem: string): string {
  const tag = (name: string): string => (tags[name] ?? '').trim()
  switch (key) {
    case 'title':
      return tag('title')
    case 'date':
      return calendarDate(tag('date'))
    case 'year':
      return /^(\d{4})/.exec(tag('date'))?.[1] ?? ''
    case 'show':
      return tag('show')
    case 'season':
      return bareNumber(tag('season_number'))
    case 'episode':
      return bareNumber(tag('episode_id'))
    case 'genre':
      return tag('genre')
    case 'name':
      return sourceStem
    default:
      return ''
  }
}

const ILLEGAL = /[<>"|?*]/g
/**
 * A control character is dropped, except where it was holding words apart.
 *
 * A newline inside a title is a space in meaning, and removing it outright
 * glues the words either side of it together.
 */
const CONTROL = /[\u0000-\u001f\u007f]/g
/** Names DOS claimed, which Windows still will not give to a file. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * A filename component, out of text that was never meant to be one.
 *
 * Run over the whole assembled name rather than each token, so a slash
 * written into the template itself is caught as well as one that arrives
 * inside a title: either way, nothing here may describe a path.
 */
export function sanitizeFilename(text: string): string {
  const cleaned = text
    // A colon is the commonest character in a film title that a filesystem
    // will not take, and a dash is what everybody writes instead.
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[/\\]+/g, '-')
    .replace(CONTROL, (character) => (/\s/.test(character) ? ' ' : ''))
    .replace(ILLEGAL, '')
    .replace(/\s+/g, ' ')
    // A leading dot hides the file; a trailing dot or space is dropped
    // silently by Windows, which turns one name into another behind you.
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')

  if (cleaned === '') return ''

  const capped =
    cleaned.length > MAX_STEM ? cleaned.slice(0, MAX_STEM).replace(/[.\s]+$/, '') : cleaned
  if (capped === '') return ''
  return RESERVED.test(capped) ? `_${capped}` : capped
}

/**
 * The stem a repaired file should carry.
 *
 * `tags` is what the file will say about itself *after* the repair, so a
 * lookup applied in the same job names the file it just retitled.
 */
export function nameFor(
  template: string,
  tags: Record<string, string>,
  sourceStem: string
): NamedFile {
  const pattern = template.trim()
  if (pattern === '') return { stem: sourceStem, problem: { kind: 'no-template' } }

  // Every file would be given the same name, and then numbered apart by the
  // collision check. Nobody means this.
  TOKEN.lastIndex = 0
  if (!TOKEN.test(pattern)) return { stem: sourceStem, problem: { kind: 'no-tokens' } }

  let problem: NamingProblem | undefined
  const filled = pattern.replace(TOKEN, (whole, key: string) => {
    if (!KEYS.has(key)) {
      problem ??= { kind: 'unknown', token: key }
      return whole
    }
    const value = valueFor(key, tags, sourceStem)
    if (value === '') {
      problem ??= { kind: 'empty', token: key }
      return ''
    }
    return value
  })

  if (problem) return { stem: sourceStem, problem }

  const stem = sanitizeFilename(filled)
  if (stem === '') return { stem: sourceStem, problem: { kind: 'unusable' } }
  return { stem }
}

/** The problem in the user's words, for Settings and for a job's log. */
export function explainProblem(problem: NamingProblem): string {
  switch (problem.kind) {
    case 'no-template':
      return 'No pattern set, so files keep the names they have.'
    case 'no-tokens':
      return 'This pattern has no fields in it, so every file would be given the same name. Files keep the names they have.'
    case 'unknown':
      return `There is no field called {${problem.token}}. Files keep the names they have.`
    case 'empty':
      return `This file has nothing for {${problem.token}}, so it keeps the name it has.`
    case 'unusable':
      return 'This pattern is all punctuation a filesystem will not take, so files keep the names they have.'
  }
}
