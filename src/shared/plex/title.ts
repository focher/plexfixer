/**
 * What a file is, in the words somebody would use for it.
 *
 * The list used to show file names, because that is what the scanner has. But
 * a file name is the one thing about a library its owner never looks at: they
 * think in films and episodes, and `Ghost.in.the.Shell.1995.1080p.BluRay.x264`
 * is a row you have to decode before you can decide anything about it.
 *
 * Three sources, in order of how much they can be trusted:
 *
 *   1. **The file's own tags.** A `show` with a season and an episode beside
 *      it is a statement, and a `title` is what a lookup wrote in.
 *   2. **The file name.** `S01E04` in a name is a near-certain episode, and
 *      what sits in front of it is the series.
 *   3. **The name, tidied.** For a film, the stem with its release leavings
 *      taken off — which is a guess, and is marked as one by never claiming
 *      more than it found.
 *
 * Nothing here looks anything up or touches the network: it reads what is
 * already in hand, which is why it can run for every row of a four-hundred
 * file library while the list is being drawn.
 */

import type { MediaFile } from '../types.js'
import { guessEpisode, tidy } from '../tmdb.js'

export interface MediaTitle {
  kind: 'movie' | 'episode'
  /** The film's title, or the series name. */
  title: string
  /** `S1E4` — the season and episode, when this is an episode. */
  code?: string
  /** The episode's own name, when the file carries one. */
  episodeTitle?: string
  /** Four digits, when they are known. */
  year?: string
  /**
   * True when the title came from the file name rather than from a tag.
   *
   * The UI says so quietly, because a guessed title that is wrong should look
   * different from one the file states — otherwise a bad guess is ind
   * istinguishable from the truth and gets acted on.
   */
  guessed: boolean
}

const tag = (tags: Record<string, string>, key: string): string => (tags[key] ?? '').trim()

/** A season or episode number, bare, with no leading zeros. */
function number(value: string): number | undefined {
  const parsed = Number.parseInt(value.replace(/^0+(?=\d)/, ''), 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * `S1E4`, the way the request asked for it: the numbers as they are, not
 * padded. `S01E04` is how a file is *named*, which is a different job — this
 * is for reading at a glance down a column.
 */
function code(season: number | undefined, episode: number | undefined): string | undefined {
  if (episode === undefined) return undefined
  return `S${season ?? 0}E${episode}`
}

export function mediaTitle(file: MediaFile): MediaTitle {
  const tags = file.tags ?? {}
  const stem = file.fileName.replace(/\.[A-Za-z0-9]{2,4}$/, '')
  const year = /^(\d{4})/.exec(tag(tags, 'date'))?.[1]

  // 1. What the file says about itself.
  const show = tag(tags, 'show')
  const season = number(tag(tags, 'season_number'))
  const episode = number(tag(tags, 'episode_id'))
  if (show && episode !== undefined) {
    return {
      kind: 'episode',
      title: show,
      code: code(season, episode),
      episodeTitle: tag(tags, 'title') || undefined,
      year,
      guessed: false
    }
  }

  // 2. What its name says.
  const guess = guessEpisode(file.fileName)
  if (guess) {
    return {
      kind: 'episode',
      // A `show` tag with no episode number still names the series better than
      // the file name does.
      title: show || guess.show || stem,
      code: code(guess.season, guess.episode),
      episodeTitle: tag(tags, 'title') || undefined,
      year: year ?? guess.year,
      guessed: !show
    }
  }

  // 3. A film. The title tag if there is one, the tidied name if not.
  const titled = tag(tags, 'title')
  if (titled) return { kind: 'movie', title: titled, year, guessed: false }

  const tidied = tidy(stem)
  return {
    kind: 'movie',
    title: tidied || stem,
    year: year ?? /[([](19\d{2}|20\d{2})[)\]]/.exec(stem)?.[1],
    guessed: true
  }
}

/** "Movie" or "TV Episode", for the column that says which. */
export function mediaKindLabel(title: MediaTitle): string {
  return title.kind === 'episode' ? 'TV Episode' : 'Movie'
}
