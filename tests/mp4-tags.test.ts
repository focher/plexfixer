/**
 * Writing tags without rewriting the file.
 *
 * The mapping between PlexFixer's tag names and mp4tags' flags is the whole of
 * this module, and a wrong pairing fails in the worst way available: the edit
 * succeeds, the tool reports nothing amiss, and the value lands in a field
 * nothing reads — so the next scan shows the old value and the edit looks like
 * it was ignored.
 *
 * Every pairing here was checked against the real binary, writing the tag and
 * reading it back with ffprobe. These tests hold that evidence in place.
 */

import { describe, expect, it } from 'vitest'
import {
  MP4_TAG_FLAGS,
  buildMp4TagsCommand,
  canWriteWithMp4Tags,
  isMp4Container
} from '@shared/plex/mp4-tags.js'
import { EDITABLE_TAGS } from '@shared/plex/metadata.js'

describe('the mapping to mp4tags', () => {
  it('covers every tag the editor can change', () => {
    // If a tag is added to the editor and not here, `canWriteWithMp4Tags`
    // refuses the whole edit and it silently falls back to a full remux —
    // a performance cliff nobody would think to look for.
    for (const { key } of EDITABLE_TAGS) {
      expect(MP4_TAG_FLAGS[key], `${key} has no mp4tags flag`).toBeDefined()
    }
  })

  it('writes the title as -song, which is the field players show', () => {
    // mp4tags has no -title. The name a player puts on a single item is the
    // song name, whatever kind of file it is.
    expect(MP4_TAG_FLAGS.title).toBe('-song')
  })

  it('writes the episode number as -episodeid, not -episode', () => {
    // They are different atoms: -episode writes `tves`, which ffprobe reports
    // as `episode_sort`, while PlexFixer reads `episode_id`. Using -episode
    // would put the number somewhere nothing reads it back from, so the edit
    // would appear to apply and then be gone on the next scan.
    expect(MP4_TAG_FLAGS.episode_id).toBe('-episodeid')
    expect(Object.values(MP4_TAG_FLAGS)).not.toContain('-episode')
  })
})

describe('the command', () => {
  it('puts the file last and pairs each flag with its value', () => {
    expect(buildMp4TagsCommand('/films/Heat.mp4', { title: 'Heat', genre: 'Crime' })).toEqual([
      '-song',
      'Heat',
      '-genre',
      'Crime',
      '/films/Heat.mp4'
    ])
  })

  it('is the same command for the same edit, whatever order the keys arrive in', () => {
    // Worth putting in a log and in a test, which it would not be if it
    // depended on object iteration order.
    const one = buildMp4TagsCommand('/x.mp4', { show: 'The Expanse', title: 'Paradigm Shift' })
    const other = buildMp4TagsCommand('/x.mp4', { title: 'Paradigm Shift', show: 'The Expanse' })
    expect(one).toEqual(other)
  })

  it('keeps an empty value, because clearing a tag is an edit too', () => {
    expect(buildMp4TagsCommand('/x.mp4', { comment: '' })).toEqual(['-comment', '', '/x.mp4'])
  })

  it('has nothing to run when there is nothing to write', () => {
    expect(buildMp4TagsCommand('/x.mp4', {})).toEqual([])
  })

  it('never reaches the shell, so a title with quotes is just a title', () => {
    // Arguments go to the process as a list. A film called `12 "Angry" Men;
    // rm -rf /` is a film, not a command.
    const args = buildMp4TagsCommand('/x.mp4', { title: '12 "Angry" Men; rm -rf /' })
    expect(args).toContain('12 "Angry" Men; rm -rf /')
  })
})

describe('when it can be used at all', () => {
  it('takes MP4 and its relatives, and not Matroska', () => {
    expect(isMp4Container('mp4')).toBe(true)
    expect(isMp4Container('.M4V')).toBe(true)
    expect(isMp4Container('m4a')).toBe(true)
    // mp4v2 would refuse this, but as a failed repair rather than a decision.
    expect(isMp4Container('mkv')).toBe(false)
  })

  it('refuses an edit holding a tag it cannot write', () => {
    expect(canWriteWithMp4Tags({ title: 'Heat' })).toBe(true)
    expect(canWriteWithMp4Tags({ title: 'Heat', sort_name: 'Heat' })).toBe(false)
    expect(canWriteWithMp4Tags({})).toBe(false)
  })
})
