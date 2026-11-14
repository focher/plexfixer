import { describe, expect, it } from 'vitest'
import { pathsFor, posixPaths, windowsPaths } from '@shared/paths.js'

describe('posix paths', () => {
  const p = posixPaths

  it('joins without doubling or dropping separators', () => {
    expect(p.join('/Volumes/Media', 'Movies')).toBe('/Volumes/Media/Movies')
    expect(p.join('/Volumes/Media/', '/Movies/')).toBe('/Volumes/Media/Movies')
    expect(p.join('/', 'Movies')).toBe('/Movies')
  })

  it('reads the file name, with and without its extension', () => {
    expect(p.basename('/Volumes/Media/Alien.m4v')).toBe('Alien.m4v')
    expect(p.basename('/Volumes/Media/Alien.m4v', '.m4v')).toBe('Alien')
    expect(p.basename('/Volumes/Media/')).toBe('Media')
  })

  it('reads the folder', () => {
    expect(p.dirname('/Volumes/Media/Alien.m4v')).toBe('/Volumes/Media')
    expect(p.dirname('/Alien.m4v')).toBe('/')
    expect(p.dirname('Alien.m4v')).toBe('.')
  })

  it('treats a leading dot as a hidden file, not an extension', () => {
    expect(p.extname('/Volumes/Media/Alien.m4v')).toBe('.m4v')
    expect(p.extname('/Volumes/Media/.plexfixer-backups')).toBe('')
    expect(p.extname('/Volumes/Media/Alien')).toBe('')
  })

  it('walks up and back down for a relative path', () => {
    expect(p.relative('/Volumes/Media', '/Volumes/Media/Movies/Alien.m4v')).toBe('Movies/Alien.m4v')
    expect(p.relative('/Volumes/Media/TV', '/Volumes/Media/Movies')).toBe('../Movies')
  })

  it('knows an absolute path from a relative one', () => {
    expect(p.isAbsolute('/Volumes/Media')).toBe(true)
    expect(p.isAbsolute('Media')).toBe(false)
  })
})

describe('windows paths', () => {
  const p = windowsPaths

  it('accepts the forward slashes plenty of tools hand back', () => {
    expect(p.basename('D:/Media/Alien.m4v')).toBe('Alien.m4v')
    expect(p.dirname('D:\\Media\\Alien.m4v')).toBe('D:\\Media')
    expect(p.extname('D:/Media/Alien.m4v')).toBe('.m4v')
  })

  it('knows a drive letter and a UNC share are both absolute', () => {
    expect(p.isAbsolute('D:\\Media')).toBe(true)
    expect(p.isAbsolute('\\\\nas\\media')).toBe(true)
    expect(p.isAbsolute('Media')).toBe(false)
  })

  it('compares case-insensitively when walking up', () => {
    expect(p.relative('D:\\Media', 'D:\\media\\Movies')).toBe('Movies')
  })
})

describe('pathsFor', () => {
  it('gives a remote host its own conventions, not this machine’s', () => {
    expect(pathsFor('win32').sep).toBe('\\')
    expect(pathsFor('linux').sep).toBe('/')
    expect(pathsFor('darwin').sep).toBe('/')
  })
})
