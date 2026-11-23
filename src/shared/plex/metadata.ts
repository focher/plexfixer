/**
 * The metadata a person sets by hand.
 *
 * Everything else in this app decides for itself what a file needs. This is
 * the one place it is told. A viewer knows things the file does not say and
 * the rules cannot work out — that the second audio track is the one they
 * want, that the title is wrong, that a track labelled "English" is really the
 * director talking — and an app that can see all of that and not let them fix
 * it is a worse app than one that does nothing.
 *
 * An edit is not stored. It is made, previewed as a plan like every other
 * repair, and carried out. There is no pending state to go stale against a
 * file that changed underneath it.
 */

import type { MediaFile, MediaStream, MetadataEdit, TrackEdit } from '../types.js'

export type { MetadataEdit, TrackEdit }

/**
 * The file-level tags worth offering.
 *
 * A closed list rather than a free-form key box, for two reasons. Containers
 * disagree about what they will store and what players read, so a key that
 * works is worth more than a key that is possible. And the keys reach ffmpeg
 * as arguments: a list means nothing arrives there that was not put on it.
 */
export const EDITABLE_TAGS: readonly {
  key: string
  label: string
  hint: string
  /** Only means anything for an episode, so it is folded away for a film. */
  forEpisodes?: boolean
}[] = [
  { key: 'title', label: 'Title', hint: 'The name a player shows, which is not the file name' },
  { key: 'date', label: 'Year', hint: 'Release year, or a full date' },
  { key: 'description', label: 'Summary', hint: 'A sentence or two about the film' },
  { key: 'genre', label: 'Genre', hint: 'Comma separated' },
  { key: 'comment', label: 'Comment', hint: 'Anything else worth keeping with the file' },
  { key: 'show', label: 'Series', hint: 'The name of the series', forEpisodes: true },
  { key: 'season_number', label: 'Season', hint: 'The season number', forEpisodes: true },
  { key: 'episode_id', label: 'Episode', hint: 'The episode number', forEpisodes: true }
]

const TAG_KEYS = new Set(EDITABLE_TAGS.map((tag) => tag.key))

/** The tags that hold a number, and are read back as one. */
const NUMBERED = new Set(['season_number', 'episode_id'])

/**
 * A season or episode number with its leading zeros taken off.
 *
 * `01` and `1` are the same season, but they are not the same string, and the
 * difference leaks everywhere: one file is named `S01E03` and the next `S1E3`
 * because one number was typed and the other came from a lookup; re-applying
 * an edit that changed nothing rewrites the file because `01` is not `1`.
 * There is one way to write a number here, and this is it.
 *
 * Only the zeros in front go. `0` itself stays — season 0 is where specials
 * live — and anything that is not a plain number is left exactly as it was
 * rather than mangled into one.
 */
export function bareNumber(value: string): string {
  return value.trim().replace(/^0+(?=\d)/, '')
}

/** Only the keys on the list, and only the ones that say something. */
export function cleanTags(tags: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (!TAG_KEYS.has(key)) continue
    const trimmed = NUMBERED.has(key) ? bareNumber(value) : value.trim()
    if (trimmed === '') continue
    out[key] = trimmed
  }
  return out
}

/**
 * What a file already says, for the fields that can be changed.
 *
 * Numbers are normalised on the way in as well as on the way out. A file
 * written by something else may carry `season_number=01`, and reading it back
 * as `01` would show a padded number in the editor, name the file with one,
 * and make re-applying an unchanged edit look like a change worth rewriting
 * six gigabytes for.
 */
export function tagsOf(file: MediaFile): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { key } of EDITABLE_TAGS) {
    // ffprobe reports tag names in whatever case the container used.
    const found = Object.entries(file.tags).find(([name]) => name.toLowerCase() === key)
    if (found) out[key] = NUMBERED.has(key) ? bareNumber(found[1]) : found[1]
  }
  return out
}

/** Whether an edit asks for anything at all. */
export function isEmptyEdit(edit: MetadataEdit | undefined): boolean {
  if (!edit) return true
  if (Object.keys(cleanTags(edit.tags)).length > 0) return false
  return Object.values(edit.tracks ?? {}).every(
    (track) => track.title === undefined && track.language === undefined && track.default === undefined && track.forced === undefined
  )
}

/**
 * Whether an edit actually differs from what the file already says.
 *
 * Typing a title and then typing it back is not a repair, and an app that
 * rewrites six gigabytes to set a field to the value it already holds has
 * misunderstood what it was asked.
 */
export function changesAnything(edit: MetadataEdit | undefined, file: MediaFile): boolean {
  if (!edit) return false

  const current = tagsOf(file)
  for (const [key, value] of Object.entries(cleanTags(edit.tags))) {
    if ((current[key] ?? '') !== value) return true
  }

  const byIndex = new Map<number, MediaStream>(file.streams.map((stream) => [stream.index, stream]))
  for (const [index, track] of Object.entries(edit.tracks ?? {})) {
    const stream = byIndex.get(Number(index))
    if (!stream) continue
    if (track.title !== undefined && (stream.title ?? '') !== track.title) return true
    if (track.language !== undefined && stream.language !== track.language) return true
    if (track.default !== undefined && stream.disposition.default !== track.default) return true
    if (track.forced !== undefined && stream.disposition.forced !== track.forced) return true
  }

  return false
}
