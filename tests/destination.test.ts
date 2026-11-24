/**
 * Choosing where one run writes, without changing Settings.
 *
 * The override is applied by handing a run a copy of the settings with its
 * output fields replaced, so these check the two things that can go wrong with
 * that: that the override actually reaches the path the repair writes to, and
 * that it never quietly becomes a different destination than the one picked.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { describeDestination, destinationProblem, withOutput } from '@shared/plex/destination.js'
import { resolveOutputPath } from '@shared/plex/output.js'
import { localHost } from './node-host.js'

const host = localHost()
const settings = { ...DEFAULT_SETTINGS, outputPlacement: 'in-place' as const, outputSuffix: '.plexfixed' }
const source = '/library/Movies/Eternals (2021)/Eternals (2021).mkv'

describe('withOutput', () => {
  it('leaves the settings exactly as they are when nothing is overridden', () => {
    expect(withOutput(settings, undefined)).toBe(settings)
  })

  it('sends the repair to a folder chosen for this run', () => {
    const chosen = withOutput(settings, { placement: 'output-dir', directory: '/scratch' })
    expect(resolveOutputPath(source, 'mp4', chosen, host, '/library/Movies')).toBe(
      '/scratch/Eternals (2021)/Eternals (2021).mp4'
    )
  })

  it('writes beside the original when that is the choice, whatever Settings says', () => {
    const chosen = withOutput(settings, { placement: 'sibling' })
    expect(resolveOutputPath(source, 'mkv', chosen, host)).toBe(
      '/library/Movies/Eternals (2021)/Eternals (2021).plexfixed.mkv'
    )
  })

  it('keeps the standing output folder rather than blanking it', () => {
    // Only `output-dir` reads it, so an override that does not name one could
    // never do anything but lose the setting.
    const withFolder = { ...settings, outputDirectory: '/configured' }
    expect(withOutput(withFolder, { placement: 'in-place' }).outputDirectory).toBe('/configured')
  })

  it('changes nothing else about the settings', () => {
    const chosen = withOutput(settings, { placement: 'output-dir', directory: '/scratch' })
    expect({ ...chosen, outputPlacement: settings.outputPlacement, outputDirectory: settings.outputDirectory }).toEqual(
      settings
    )
  })
})

describe('describeDestination', () => {
  it('says where an in-place repair leaves the original', () => {
    expect(describeDestination({ ...settings, keepBackups: true })).toContain('.plexfixer-backups')
    expect(describeDestination({ ...settings, keepBackups: false })).toContain('not kept')
  })

  it('names the folder, and says the library shape is mirrored inside it', () => {
    const chosen = withOutput(settings, { placement: 'output-dir', directory: '/scratch' })
    expect(describeDestination(chosen)).toBe('Into /scratch, in a folder per film, mirroring the library.')
  })

  it('does not claim a folder that is not set', () => {
    const empty = { ...settings, outputPlacement: 'output-dir' as const, outputDirectory: '' }
    // What `resolveOutput` actually does with it, rather than naming nothing.
    expect(describeDestination(empty)).toContain('beside their originals')
  })

  it('shows the suffix a sibling write will use', () => {
    expect(describeDestination({ ...settings, outputPlacement: 'sibling' })).toContain('".plexfixed"')
  })
})

describe('destinationProblem', () => {
  it('will not let "into a folder" start with no folder', () => {
    expect(destinationProblem({ placement: 'output-dir' })).toBeDefined()
    expect(destinationProblem({ placement: 'output-dir', directory: '   ' })).toBeDefined()
    expect(destinationProblem({ placement: 'output-dir', directory: '/scratch' })).toBeUndefined()
  })

  it('has nothing to ask of the other two', () => {
    expect(destinationProblem({ placement: 'in-place' })).toBeUndefined()
    expect(destinationProblem({ placement: 'sibling' })).toBeUndefined()
  })
})
