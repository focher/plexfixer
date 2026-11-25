/**
 * Writing a file's own tags without rewriting the file.
 *
 * Language tags and default flags are fixed-width fields, so `mp4-patch.ts`
 * overwrites them where they lie. A title is text of any length: `moov` changes
 * size and everything after it would have to shift, which is why a tag edit has
 * always meant a full remux — reading and writing every byte of the film to
 * change two words.
 *
 * `mp4tags`, from mp4v2, does it properly: it keeps `free` padding beside the
 * header and rewrites the chunk-offset tables when the header has to grow, so
 * `mdat` never moves. Measured on a 12 MB file, the same inode came back with
 * 0.00s of CPU and the only changed bytes in the header. It is the same library
 * Subler is built on, which is why that app writes tags instantly.
 *
 * This module is the translation between the two vocabularies, and nothing
 * else: PlexFixer names its tags the way ffmpeg does, and mp4tags takes flags
 * of its own. Every pairing below was checked by writing the tag and reading it
 * back with ffprobe, because a mapping that is merely plausible is how you end
 * up writing an episode number into a field nothing reads.
 */

/**
 * PlexFixer's tag key to the mp4tags flag that writes it.
 *
 * Two of these are worth their own sentence:
 *
 * `title` is `-song`, not `-title`. mp4tags has no `-title`: the field a
 * player shows for a single item is the song name, `©nam`, whatever kind of
 * file it is.
 *
 * `episode_id` is `-episodeid`, not `-episode`. They are different atoms and
 * ffprobe reports them under different names — `-episode` writes `tves`, which
 * comes back as `episode_sort`. Using it would mean writing the number into a
 * field PlexFixer never reads, so an edit would look applied and then be gone
 * on the next scan.
 */
export const MP4_TAG_FLAGS: Readonly<Record<string, string>> = {
  title: '-song',
  date: '-year',
  description: '-description',
  genre: '-genre',
  comment: '-comment',
  show: '-show',
  season_number: '-season',
  episode_id: '-episodeid'
}

/** Whether every tag in this edit is one mp4tags can write. */
export function canWriteWithMp4Tags(tags: Record<string, string>): boolean {
  const keys = Object.keys(tags)
  return keys.length > 0 && keys.every((key) => key in MP4_TAG_FLAGS)
}

/**
 * The container extensions mp4tags understands.
 *
 * Matroska is a different format entirely and mp4v2 will refuse it — correctly,
 * but the refusal would arrive as a failed repair rather than as a decision, so
 * it is made here instead.
 */
export function isMp4Container(extension: string): boolean {
  const normalised = extension.replace(/^\./, '').toLowerCase()
  return normalised === 'mp4' || normalised === 'm4v' || normalised === 'm4a'
}

/**
 * The arguments to write these tags into this file.
 *
 * Tags are written in a fixed order rather than whatever order the object
 * happens to iterate in, so the same edit produces the same command every time
 * — which is what makes the command worth putting in a log or a test.
 *
 * An empty value clears the tag: mp4tags removes an atom when it is given one,
 * which is the behaviour PlexFixer wants, since clearing a field somebody no
 * longer wants is as much an edit as setting one.
 */
export function buildMp4TagsCommand(mediaPath: string, tags: Record<string, string>): string[] {
  const args: string[] = []
  for (const key of Object.keys(MP4_TAG_FLAGS)) {
    const value = tags[key]
    if (value === undefined) continue
    args.push(MP4_TAG_FLAGS[key], value)
  }
  if (args.length === 0) return []
  // The file last, which is where mp4tags expects it.
  args.push(mediaPath)
  return args
}
