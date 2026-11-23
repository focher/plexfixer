/**
 * Looking a whole selection up at once.
 *
 * The per-file screen asks a person to pick from a list, which is the honest
 * way round: a file name is a guess and a search returns several answers. Over
 * eighty files that is eighty decisions, and nobody makes the eightieth one
 * carefully.
 *
 * So this does the searching and proposes one answer each, and the person
 * reviews a list instead of answering a question eighty times. Everything that
 * makes an answer doubtful is shown rather than hidden, a proposal nobody is
 * confident about arrives unticked, and every row's search terms can be
 * corrected and run again — because the thing most often wrong is not the
 * answer but the question, and a file name is a poor question.
 *
 * An episode is not searched for by its title. It is found by series, season
 * and number, which is the only thing a file name reliably carries and the
 * only thing that identifies an episode at all: two series have the same
 * episode names, and half the episodes in a library have no name in the file
 * at all.
 */

import type { MediaFile } from '../types.js'
import {
  episodeTags,
  guessEpisode,
  guessTitle,
  tagsFromMatch,
  type TmdbEpisode,
  type TmdbKind,
  type TmdbMatch
} from '../tmdb.js'
import { bareNumber } from './metadata.js'

/** The terms a row is searched on, which a person may correct. */
export type AskedFor =
  | { kind: 'movie'; query: string; year: string }
  | { kind: 'tv'; show: string; season: string; episode: string; year: string }

/** How much a proposal should be trusted, and why. */
export type Confidence =
  /** The year matches the file name, or there was only ever one answer. */
  | { level: 'good' }
  /** Worth a glance: several answers, or a title that drifted. */
  | { level: 'check'; why: string }

/** What a row would write, and what to call it on screen. */
export interface Found {
  /** The film, or the series an episode belongs to: what a details call needs. */
  id: number
  label: string
  tags: Record<string, string>
}

/** A film result, turned into what the row would write. */
export function foundFrom(match: TmdbMatch): Found {
  return {
    id: match.id,
    label: `${match.title}${match.year ? ` (${match.year})` : ''}`,
    tags: tagsFromMatch(match)
  }
}

export interface Proposal {
  path: string
  fileName: string
  /** What was searched for, so a bad question is visible as a bad question. */
  asked: AskedFor
  found?: Found
  /** Other answers already in hand. Films only: an episode is found by number. */
  alternatives: TmdbMatch[]
  confidence: Confidence
  /** Why there is no proposal, when there is none. */
  problem?: string
  /** Ticked rows are the ones that will be written. */
  take: boolean
}

/** Letters and digits only, lowercased: for comparing titles people wrote by hand. */
function flatten(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/* ------------------------------------------------------------------ *
 * The question
 * ------------------------------------------------------------------ */

/** What to search for, from one file name. */
export function askFor(file: MediaFile, kind: TmdbKind): AskedFor {
  if (kind === 'movie') {
    const guessed = guessTitle(file.fileName)
    return { kind: 'movie', query: guessed.title, year: guessed.year ?? '' }
  }

  const found = guessEpisode(file.fileName)
  if (found) {
    return {
      kind: 'tv',
      show: found.show,
      season: String(found.season),
      episode: String(found.episode),
      year: found.year ?? ''
    }
  }

  // Nothing in the name says which episode it is. The series is still worth
  // guessing at, so the numbers are all that is left to fill in by hand.
  const guessed = guessTitle(file.fileName)
  return { kind: 'tv', show: guessed.title, season: '', episode: '', year: guessed.year ?? '' }
}

/** Whether there is enough here to search on at all. */
export function isAskable(asked: AskedFor): boolean {
  if (asked.kind === 'movie') return asked.query.trim() !== ''
  return asked.show.trim() !== '' && /^\d+$/.test(asked.season.trim()) && /^\d+$/.test(asked.episode.trim())
}

/** What is missing, in the user's words. */
export function whatIsMissing(asked: AskedFor): string {
  if (asked.kind === 'movie') return 'Nothing in the file name to search for — type a title.'
  if (asked.show.trim() === '') return 'No series name — type one.'
  return 'No season and episode number in the file name — type them.'
}

/* ------------------------------------------------------------------ *
 * The answer
 * ------------------------------------------------------------------ */

/**
 * How much a film result deserves to be trusted.
 *
 * The year is the strongest signal there is — two films share a title far
 * more often than they share a title and a year — so a year that agrees is
 * worth more than any amount of title similarity.
 */
export function judge(guessedYear: string, query: string, matches: readonly TmdbMatch[]): Confidence {
  const best = matches[0]
  if (!best) return { level: 'check', why: 'nothing found' }
  const year = guessedYear.trim()

  if (year && best.year && year !== best.year) {
    return { level: 'check', why: `the file name says ${year}, this is ${best.year}` }
  }

  // The database may tell you more than the file name did — a subtitle the
  // ripper dropped — but a result *shorter* than what was asked for means it
  // threw words away, and "Casino Royale" answered with "Casino" is a
  // different film.
  const asked = flatten(query)
  const got = flatten(best.title)
  if (asked !== '' && !got.startsWith(asked)) {
    return { level: 'check', why: `“${best.title}” is not much like “${query}”` }
  }

  // Two results with the same year and no year in the file name to choose
  // between them is exactly the case that gets picked wrong in bulk.
  if (!year && matches.length > 1 && matches[1]?.year === best.year) {
    return { level: 'check', why: 'more than one result looks equally likely' }
  }

  if (year && best.year === year) return { level: 'good' }
  if (matches.length === 1) return { level: 'good' }
  return { level: 'check', why: 'the file name gave no year to confirm this against' }
}

/** One film row, from a search that has come back. */
export function movieProposal(
  file: MediaFile,
  asked: Extract<AskedFor, { kind: 'movie' }>,
  matches: readonly TmdbMatch[]
): Proposal {
  const base = { path: file.path, fileName: file.fileName, asked, alternatives: matches.slice(0, 6) }
  const best = matches[0]
  if (!best) {
    return {
      ...base,
      confidence: { level: 'check', why: 'nothing found' },
      problem: `Nothing on themoviedb.org matched “${asked.query}”.`,
      take: false
    }
  }

  const confidence = judge(asked.year, asked.query, matches)
  // Only the confident ones arrive ticked. A screen that ticked everything
  // would be a screen people click through, and the doubtful rows are the
  // whole reason for showing it.
  return {
    ...base,
    found: foundFrom(best),
    confidence,
    take: confidence.level === 'good'
  }
}

/**
 * One episode row.
 *
 * Two things can go wrong and they are worth telling apart: the series was
 * not found, or the series was found and has no such episode. The second
 * usually means the numbering in the file does not match the database's —
 * which a person can fix by editing the numbers, and no amount of searching
 * will fix on its own.
 */
export function episodeProposal(
  file: MediaFile,
  asked: Extract<AskedFor, { kind: 'tv' }>,
  series: readonly TmdbMatch[],
  episode: TmdbEpisode | undefined
): Proposal {
  const base = { path: file.path, fileName: file.fileName, asked, alternatives: [] as TmdbMatch[] }
  const best = series[0]

  if (!best) {
    return {
      ...base,
      confidence: { level: 'check', why: 'nothing found' },
      problem: `No series on themoviedb.org matched “${asked.show}”.`,
      take: false
    }
  }

  if (!episode) {
    return {
      ...base,
      confidence: { level: 'check', why: 'nothing found' },
      problem: `“${best.title}” has no season ${asked.season} episode ${asked.episode}.`,
      take: false
    }
  }

  const several =
    series.length > 1 && asked.year.trim() === ''
      ? `more than one series is called “${asked.show}” — this is the ${best.year ?? 'one listed first'} one`
      : undefined

  const confidence: Confidence = several ? { level: 'check', why: several } : { level: 'good' }
  return {
    ...base,
    found: {
      id: best.id,
      // The same numbers the file will be named with, so the row predicts
      // the rename rather than contradicting it.
      label: `${best.title} — S${bareNumber(asked.season)}E${bareNumber(asked.episode)} — ${episode.title}`,
      tags: episodeTags(episode)
    },
    confidence,
    take: confidence.level === 'good'
  }
}

/** A row that could not be asked about at all. */
export function unaskable(file: MediaFile, asked: AskedFor): Proposal {
  return {
    path: file.path,
    fileName: file.fileName,
    asked,
    alternatives: [],
    confidence: { level: 'check', why: 'nothing found' },
    problem: whatIsMissing(asked),
    take: false
  }
}

/** How many rows a click of "Apply" would write. */
export function takenCount(proposals: readonly Proposal[]): number {
  return proposals.filter((proposal) => proposal.take && proposal.found).length
}
