import { describe, expect, it } from 'vitest'
import { parseLaunchArgs } from '@shared/launch.js'

describe('parseLaunchArgs', () => {
  it('collects --volume paths in both spellings', () => {
    const options = parseLaunchArgs(['--volume', '/Volumes/My Media', '--volume=/Volumes/TV'])
    expect(options.volumes).toEqual(['/Volumes/My Media', '/Volumes/TV'])
    expect(options.problems).toEqual([])
  })

  it('reports a --volume with no path instead of eating the next switch', () => {
    const options = parseLaunchArgs(['--volume', '--no-sandbox'])
    expect(options.volumes).toEqual([])
    expect(options.problems).toHaveLength(1)
  })

  it('ignores switches it does not own', () => {
    expect(parseLaunchArgs(['--inspect=5858', '--no-sandbox'])).toEqual({ volumes: [], problems: [] })
  })
})
