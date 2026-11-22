/**
 * Files that do not say what they are.
 *
 * Every other check here is about playback. This one is not, and says so: a
 * file with no title tag direct plays exactly as well as one with. It matters
 * the moment the file is somewhere Plex is not — opened in a player, handed to
 * somebody, matched by a different library — because then what is written
 * inside it is the only thing it has to go on.
 *
 * Nothing is repaired from this. A lookup needs somebody to say which of the
 * films it found is the right one, and an app that guessed would eventually
 * write the wrong title into a file and not mention it.
 */

import type { CheckModule } from '../framework.js'
import { tagsOf } from '../../metadata.js'
import { looksLikeARelease } from '../../../tmdb.js'

/** Two bits of text that differ only in punctuation and case. */
function sameText(a: string, b: string): boolean {
  const flatten = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return flatten(a) === flatten(b)
}

export const metadataMissing: CheckModule = {
  id: 'check.metadata-missing',
  title: 'Metadata worth looking up',
  summary: 'Files carrying no title or year of their own, which a lookup can fill in',
  whatItDoes:
    'Reads what the file says about itself — its title, its year, its summary — and points out the files ' +
    'that say nothing, or that carry the file name where a title should be. This does not affect direct ' +
    'play at all: Plex matches on the file name and keeps its own metadata. It matters everywhere Plex is ' +
    'not — a file opened in a player, moved between libraries, or handed to somebody carries only what is ' +
    'written inside it.',
  howItWorks:
    'A title counts as wanting when there is none, when it is the file name over again, or when it still ' +
    'has a release’s resolution and codec in it. A year counts as wanting when there is no date tag. A ' +
    'missing summary is mentioned alongside those but never on its own. Nothing here is repaired ' +
    'automatically — a lookup needs somebody to say which film it found is the right one, so this reports ' +
    'and stops. "Edit metadata" on the file is where the lookup lives.',
  ifDisabled:
    'Files with no metadata of their own go unmentioned. No repair changes either way: this module only ' +
    'ever reports.',
  // Opt-in: true of most of a library, and clearable only by hand, one file
  // at a time. See `startsOff`.
  startsOff: true,
  raises: ['metadata-missing'],

  run({ file }) {
    const tags = tagsOf(file)
    const title = (tags.title ?? '').trim()
    const stem = file.fileName.replace(/\.[a-z0-9]{2,4}$/i, '')

    const titleWanting =
      title === ''
        ? 'a title of its own'
        : sameText(title, stem)
          ? 'a title that is more than the file name again'
          : looksLikeARelease(title)
            ? 'a title without the release details still in it'
            : undefined

    const yearWanting = (tags.date ?? '').trim() === '' ? 'a year' : undefined

    // A summary alone is a nicety. A title and a year are what identify a
    // film, and a row for every file that lacks a paragraph would be noise.
    if (!titleWanting && !yearWanting) return {}

    const wanting = [titleWanting, yearWanting].filter((item): item is string => item !== undefined)
    if ((tags.description ?? '').trim() === '') wanting.push('a summary')

    const list =
      wanting.length === 1
        ? wanting[0]
        : `${wanting.slice(0, -1).join(', ')} or ${wanting[wanting.length - 1]}`

    return {
      findings: [
        {
          code: 'metadata-missing',
          severity: 'info',
          // Deliberately not 'manual': a manual remedy puts the finding in the
          // "not fixed by this plan" banner, and a line that appears on nearly
          // every file teaches people to stop reading the banner.
          remedy: 'none',
          title: 'This file does not say what it is',
          detail:
            `It has no ${list}. Plex keeps its own metadata, so nothing about playback changes — but ` +
            'nothing else that opens this file has anything to go on. Edit metadata will look it up on ' +
            'themoviedb.org and write it in.'
        }
      ]
    }
  }
}
