/**
 * Naming a repaired file from its tags.
 *
 * Two things are worth more than the rest here: a template that cannot be
 * filled leaves the file alone, and nothing a template produces can describe
 * a path. The first keeps a library from filling with `Film ()`; the second
 * keeps a title out of a stranger's database from writing somewhere else.
 */

import { describe, expect, it } from 'vitest'
import {
  TEMPLATE_TOKENS,
  explainProblem,
  looksLikeEpisode,
  nameFor,
  sanitizeFilename,
  templateFor
} from '@shared/plex/naming.js'

const film = { title: 'Casino Royale', date: '2006-11-14', genre: 'Action, Thriller' }
const episode = { title: 'Ozymandias', show: 'Breaking Bad', season_number: '5', episode_id: '14' }

describe('nameFor', () => {
  it('fills a template from the tags', () => {
    expect(nameFor('{title} ({year})', film, 'whatever')).toEqual({ stem: 'Casino Royale (2006)' })
  })

  it('takes the release date in full when asked for it', () => {
    expect(nameFor('{title} ({date})', film, 'whatever').stem).toBe('Casino Royale (2006-11-14)')
  })

  it('drops the clock half of an ISO timestamp', () => {
    // What a lookup writes when the source gave it an instant rather than a
    // date. Left whole, the colons sanitise into " - " and the film ends up
    // called "Casino Royale (2006-11-14T12 - 00 - 00Z)".
    expect(nameFor('{title} ({date})', { ...film, date: '2006-11-14T12:00:00Z' }, 'x').stem).toBe(
      'Casino Royale (2006-11-14)'
    )
    expect(nameFor('{date}', { date: '2006-11-14 12:00:00' }, 'x').stem).toBe('2006-11-14')
    expect(nameFor('{date}', { date: '2006-11' }, 'x').stem).toBe('2006-11')
    expect(nameFor('{date}', { date: '2006' }, 'x').stem).toBe('2006')
  })

  it('leaves a date it does not recognise exactly as it found it', () => {
    // Cutting at the first thing that looks like a time would turn a date
    // written some other way into a shorter wrong one.
    expect(nameFor('{date}', { date: '14 November 2006' }, 'x').stem).toBe('14 November 2006')
    expect(nameFor('{date}', { date: '20061114' }, 'x').stem).toBe('20061114')
  })

  it('reads the year off the front of the date', () => {
    expect(nameFor('{year}', { date: '2006' }, 'x').stem).toBe('2006')
    expect(nameFor('{year}', { date: '2006-11-14' }, 'x').stem).toBe('2006')
    expect(nameFor('{year}', { date: 'sometime in 2006' }, 'x').problem).toEqual({ kind: 'empty', token: 'year' })
  })

  it('writes a season and an episode as bare numbers', () => {
    expect(nameFor('{show} - S{season}E{episode} - {title}', episode, 'x').stem).toBe(
      'Breaking Bad - S5E14 - Ozymandias'
    )
  })

  it('strips the leading zeros off a number the file arrived with', () => {
    expect(nameFor('S{season}E{episode}', { season_number: '05', episode_id: '014' }, 'x').stem).toBe('S5E14')
    // Which is the same name the lookup's own numbers would have produced.
    expect(nameFor('S{season}E{episode}', { season_number: '5', episode_id: '14' }, 'x').stem).toBe('S5E14')
  })

  it('leaves a number that needs no stripping alone', () => {
    expect(nameFor('S{season}E{episode}', { season_number: '10', episode_id: '112' }, 'x').stem).toBe('S10E112')
  })

  it('keeps season 0, which is where specials live', () => {
    expect(nameFor('S{season}E{episode}', { season_number: '00', episode_id: '03' }, 'x').stem).toBe('S0E3')
  })

  it('offers the current name, for adding to rather than replacing', () => {
    expect(nameFor('{name} [{year}]', film, 'Casino.Royale.1080p').stem).toBe('Casino.Royale.1080p [2006]')
  })

  it('knows a token for everything it advertises', () => {
    // The Settings screen lists these; a token it offers that does nothing
    // would be found one renamed file at a time.
    const tags = { title: 'T', date: '2006-01-02', show: 'S', season_number: '1', episode_id: '2', genre: 'G' }
    for (const token of TEMPLATE_TOKENS) {
      expect(nameFor(`{${token.key}}`, tags, 'the name').problem, token.key).toBeUndefined()
    }
  })
})

describe('nameFor — when it will not rename', () => {
  it('keeps the current name when a field is empty', () => {
    const out = nameFor('{title} ({year})', { title: 'Casino Royale' }, 'Casino.Royale.2006.1080p')
    expect(out.stem).toBe('Casino.Royale.2006.1080p')
    expect(out.problem).toEqual({ kind: 'empty', token: 'year' })
  })

  it('keeps the current name when a field does not exist', () => {
    const out = nameFor('{titel} ({year})', film, 'original')
    expect(out).toEqual({ stem: 'original', problem: { kind: 'unknown', token: 'titel' } })
  })

  it('keeps the current name when there is no pattern', () => {
    expect(nameFor('', film, 'original')).toEqual({ stem: 'original', problem: { kind: 'no-template' } })
    expect(nameFor('   ', film, 'original').problem).toEqual({ kind: 'no-template' })
  })

  it('refuses a pattern that would name every file the same', () => {
    expect(nameFor('My Movie', film, 'original')).toEqual({ stem: 'original', problem: { kind: 'no-tokens' } })
  })

  it('keeps the current name when nothing usable is left', () => {
    expect(nameFor('<{title}>', { title: '<<>>' }, 'original')).toEqual({
      stem: 'original',
      problem: { kind: 'unusable' }
    })
  })

  it('explains every problem it can report', () => {
    const problems = [
      { kind: 'no-template' },
      { kind: 'no-tokens' },
      { kind: 'unknown', token: 'x' },
      { kind: 'empty', token: 'year' },
      { kind: 'unusable' }
    ] as const
    for (const problem of problems) {
      expect(explainProblem(problem).length, problem.kind).toBeGreaterThan(20)
    }
  })
})

describe('sanitizeFilename', () => {
  it('cannot be made to describe a path', () => {
    // The whole point. A title is text from somebody else's database.
    expect(sanitizeFilename('../../etc/passwd')).toBe('-..-etc-passwd')
    expect(sanitizeFilename('a/b\\c')).toBe('a-b-c')
    expect(nameFor('{title}', { title: '../../etc/passwd' }, 'x').stem).not.toContain('/')
    expect(nameFor('{title}/{year}', film, 'x').stem).toBe('Casino Royale-2006')
  })

  it('writes a colon as a dash, the way a person would', () => {
    expect(sanitizeFilename('Star Wars: A New Hope')).toBe('Star Wars - A New Hope')
    expect(sanitizeFilename('Alien:Resurrection')).toBe('Alien - Resurrection')
  })

  it('drops the characters Windows will not take', () => {
    expect(sanitizeFilename('What? "Really" <yes> | no *')).toBe('What Really yes no')
  })

  it('drops control characters', () => {
    expect(sanitizeFilename('Title\u0000\u001fhere')).toBe('Titlehere')
    expect(sanitizeFilename('Title\nhere')).toBe('Title here')
  })

  it('will not leave a name Windows silently rewrites', () => {
    // A trailing dot or space is dropped on Windows, so a file written as
    // one name arrives as another and nothing afterwards finds it.
    expect(sanitizeFilename('Movie.')).toBe('Movie')
    expect(sanitizeFilename('Movie   ')).toBe('Movie')
    expect(sanitizeFilename('Movie. . ')).toBe('Movie')
  })

  it('will not hide the file', () => {
    expect(sanitizeFilename('.hidden')).toBe('hidden')
  })

  it('steps around the names DOS claimed', () => {
    expect(sanitizeFilename('CON')).toBe('_CON')
    expect(sanitizeFilename('com4')).toBe('_com4')
    // Only the name on its own — these are ordinary words otherwise.
    expect(sanitizeFilename('Conan')).toBe('Conan')
    expect(sanitizeFilename('CON the movie')).toBe('CON the movie')
  })

  it('caps a name a filesystem would refuse', () => {
    const long = sanitizeFilename('A'.repeat(400))
    expect(long.length).toBe(180)
    // And does not leave a dropped character behind as a trailing space.
    expect(sanitizeFilename(`${'A'.repeat(179)} B`)).toBe('A'.repeat(179))
  })

  it('leaves an ordinary name exactly as it is', () => {
    expect(sanitizeFilename('Casino Royale (2006)')).toBe('Casino Royale (2006)')
    expect(sanitizeFilename("Amélie — director's cut")).toBe("Amélie — director's cut")
  })
})

describe('which pattern applies', () => {
  const templates = { movie: '{title} ({year})', episode: '{show} - S{season}E{episode}' }

  it('believes what the file says before anything else', () => {
    expect(looksLikeEpisode({ show: 'Breaking Bad', season_number: '5', episode_id: '14' }, 'anything.mkv')).toBe(true)
    expect(looksLikeEpisode({ season_number: '5', episode_id: '14' }, 'anything.mkv')).toBe(true)
    // A series name on its own is not an episode — a whole-series file is
    // not a thing this renames by number.
    expect(looksLikeEpisode({ show: 'Breaking Bad' }, 'anything.mkv')).toBe(false)
  })

  it('reads the file name when the tags say nothing', () => {
    expect(looksLikeEpisode({}, 'Breaking.Bad.S05E14.mkv')).toBe(true)
    expect(looksLikeEpisode({}, 'Casino Royale (2006).mkv')).toBe(false)
  })

  it('treats a film as a film, which is the commoner thing to have', () => {
    expect(templateFor(templates, { title: 'Casino Royale' }, 'Casino Royale.mkv')).toBe('{title} ({year})')
    expect(templateFor(templates, {}, 'Breaking.Bad.S05E14.mkv')).toBe('{show} - S{season}E{episode}')
  })
})
