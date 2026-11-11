import { describe, expect, it } from 'vitest'
import { isWithin, matchesSearch, stalePaths } from '@shared/library.js'

describe('isWithin', () => {
  it('matches the root and paths beneath it, not siblings with the same prefix', () => {
    expect(isWithin('/Volumes/Media/Movies', '/Volumes/Media/Movies')).toBe(true)
    expect(isWithin('/Volumes/Media/Movies/Alien.m4v', '/Volumes/Media/Movies')).toBe(true)
    expect(isWithin('/Volumes/Media/Movies/Alien.m4v', '/Volumes/Media/Movies/')).toBe(true)
    expect(isWithin('/Volumes/Media/Movies 4K/Alien.m4v', '/Volumes/Media/Movies')).toBe(false)
  })

  it('handles Windows separators', () => {
    expect(isWithin('D:\\Media\\Alien.mkv', 'D:\\Media')).toBe(true)
    expect(isWithin('D:\\Media2\\Alien.mkv', 'D:\\Media')).toBe(false)
  })
})

describe('stalePaths', () => {
  const stored = ['/M/Movies/a.m4v', '/M/Movies/b.m4v', '/M/TV/c.mkv']

  it('drops files under a scanned folder that the walk no longer found', () => {
    expect(stalePaths(stored, ['/M/Movies'], ['/M/Movies/a.m4v'], false)).toEqual(['/M/Movies/b.m4v'])
  })

  it('leaves files outside the scanned folders alone', () => {
    expect(stalePaths(stored, ['/M/Movies'], ['/M/Movies/a.m4v', '/M/Movies/b.m4v'], false)).toEqual([])
  })

  it('treats a scanned file as its own root', () => {
    expect(stalePaths(stored, ['/M/TV/c.mkv'], [], false)).toEqual(['/M/TV/c.mkv'])
  })

  it('removes nothing after a cancelled scan', () => {
    expect(stalePaths(stored, ['/M/Movies'], [], true)).toEqual([])
  })
})

describe('matchesSearch', () => {
  const path = '/Volumes/Video10e/Movies/Alien (1979)/Alien (1979).m4v'

  it('needs every word somewhere in the path, ignoring case', () => {
    expect(matchesSearch(path, 'alien 1979')).toBe(true)
    expect(matchesSearch(path, 'ALIEN movies')).toBe(true)
    expect(matchesSearch(path, 'alien 1986')).toBe(false)
  })

  it('matches everything when the query is blank', () => {
    expect(matchesSearch(path, '   ')).toBe(true)
  })
})
