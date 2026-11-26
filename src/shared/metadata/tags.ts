/**
 * What a match writes into the file.
 *
 * One function for every service, because the file does not care which of them
 * answered: an MP4 has a title, a date, a description and a genre, and the
 * question is only which of the things a service said go into which of them.
 *
 * The one decision worth stating is about episodes. The title written is the
 * episode's own, never the series' — a player showing twenty-four files all
 * called "Breaking Bad" has been told nothing — and the series goes in its own
 * field, which is where a player looks for it. If a service gave the series
 * and the numbers but not the episode's own name, no title is written at all,
 * rather than the series' name standing in for it: an empty field is a gap,
 * and the series' name in the title field is a wrong answer that looks right.
 */

import type { MetadataMatch } from './providers/types.js'

/** Whether this match is about one episode rather than a whole series. */
export function isEpisodeMatch(match: MetadataMatch): boolean {
  return match.kind === 'tv' && match.season != null && match.episode != null
}

export function tagsFor(match: MetadataMatch): Record<string, string> {
  const tags: Record<string, string> = {}

  if (isEpisodeMatch(match)) {
    if (match.episodeTitle) tags.title = match.episodeTitle
    tags.show = match.title
    tags.season_number = String(match.season)
    tags.episode_id = String(match.episode)
  } else {
    tags.title = match.title
  }

  // The full date where there is one — a player that wants only the year will
  // take the first four characters, and one that wants the date has it.
  if (match.date) tags.date = match.date
  else if (match.year) tags.date = match.year
  if (match.overview) tags.description = match.overview
  if (match.genres?.length) tags.genre = match.genres.join(', ')

  return tags
}

/**
 * What to call a match on screen.
 *
 * The numbers are written the way the rename writes them — no leading zeros,
 * which is what `{season}` and `{episode}` produce — so a row shown before the
 * repair predicts the file name rather than contradicting it.
 */
export function labelFor(match: MetadataMatch): string {
  if (isEpisodeMatch(match)) {
    const numbers = `S${match.season}E${match.episode}`
    return match.episodeTitle ? `${match.title} — ${numbers} — ${match.episodeTitle}` : `${match.title} — ${numbers}`
  }
  return match.year ? `${match.title} (${match.year})` : match.title
}
