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
 * makes an answer doubtful is shown rather than hidden: a year that disagrees
 * with the file name, a title that is not much like it, more than one
 * plausible result. A proposal nobody is confident about arrives unticked.
 */

import type { MediaFile } from '../types.js'
import { guessTitle, type TmdbMatch } from '../tmdb.js'

/** How much a proposal should be trusted, and why. */
export type Confidence =
  /** The year matches the file name, or there was only ever one answer. */
  | { level: 'good' }
  /** Worth a glance: several answers, or a title that drifted. */
  | { level: 'check'; why: string }

export interface Proposal {
  path: string
  fileName: string
  /** What was searched for, so a bad guess is visible as a bad guess. */
  searched: { query: string; year?: string }
  match?: TmdbMatch
  /** Everything else the search returned, to pick from instead. */
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

/**
 * How much a result deserves to be trusted.
 *
 * The year is the strongest signal there is — two films share a title far
 * more often than they share a title and a year — so a year that agrees is
 * worth more than any amount of title similarity.
 */
export function judge(guessedYear: string | undefined, query: string, matches: readonly TmdbMatch[]): Confidence {
  const best = matches[0]
  if (!best) return { level: 'check', why: 'nothing found' }

  if (guessedYear && best.year && guessedYear !== best.year) {
    return { level: 'check', why: `the file name says ${guessedYear}, this is ${best.year}` }
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
  if (!guessedYear && matches.length > 1 && matches[1]?.year === best.year) {
    return { level: 'check', why: 'more than one result looks equally likely' }
  }

  if (guessedYear && best.year === guessedYear) return { level: 'good' }
  if (matches.length === 1) return { level: 'good' }
  return { level: 'check', why: 'the file name gave no year to confirm this against' }
}

/** What to search for, from one file. */
export function searchFor(file: MediaFile): { query: string; year?: string } {
  const guessed = guessTitle(file.fileName)
  return { query: guessed.title, year: guessed.year }
}

/** One row, from a search that has come back. */
export function proposalFrom(file: MediaFile, matches: readonly TmdbMatch[]): Proposal {
  const searched = searchFor(file)
  const base = { path: file.path, fileName: file.fileName, searched, alternatives: matches.slice(0, 6) }

  if (searched.query.trim() === '') {
    return {
      ...base,
      alternatives: [],
      confidence: { level: 'check', why: 'nothing found' },
      problem: 'Nothing in the file name to search for.',
      take: false
    }
  }

  const best = matches[0]
  if (!best) {
    return {
      ...base,
      confidence: { level: 'check', why: 'nothing found' },
      problem: `Nothing on themoviedb.org matched “${searched.query}”.`,
      take: false
    }
  }

  const confidence = judge(searched.year, searched.query, matches)
  // Only the confident ones arrive ticked. A screen that ticked everything
  // would be a screen people click through, and the doubtful rows are the
  // whole reason for showing it.
  return { ...base, match: best, confidence, take: confidence.level === 'good' }
}

/** How many rows a click of "Apply" would write. */
export function takenCount(proposals: readonly Proposal[]): number {
  return proposals.filter((proposal) => proposal.take && proposal.match).length
}
