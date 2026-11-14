import { describe, expect, it } from 'vitest'
import { startDirectory } from '@shared/remote-browse.js'

describe('startDirectory', () => {
  it('opens in the default folder when nothing was asked for', () => {
    expect(startDirectory(undefined, '/mnt/media')).toBe('/mnt/media')
    expect(startDirectory('', '/mnt/media')).toBe('/mnt/media')
  })

  it('lets a folder that was asked for win over the default', () => {
    expect(startDirectory('/mnt/media/Movies', '/mnt/media')).toBe('/mnt/media/Movies')
  })

  it('asks for the home directory when there is no default', () => {
    expect(startDirectory(undefined, '')).toBe('')
    expect(startDirectory(undefined, undefined)).toBe('')
    expect(startDirectory('', null)).toBe('')
  })

  it('ignores a default that is only spaces, rather than listing " "', () => {
    expect(startDirectory(undefined, '   ')).toBe('')
    expect(startDirectory('  ', '  /mnt/media  ')).toBe('/mnt/media')
  })

  it('trims what it is given, since a pasted path brings a newline with it', () => {
    expect(startDirectory(' /mnt/media/TV \n', '/mnt/media')).toBe('/mnt/media/TV')
  })
})
