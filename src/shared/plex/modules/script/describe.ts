/**
 * Saying a rule back in English.
 *
 * A rule that only says `when video.codec in divx, dx50` still has to appear in
 * the list of modules with the same three explanations as every built-in one,
 * or the screen would have two kinds of entry and only one of them would be
 * readable. So the explanations are written from the script when the author
 * has not written their own — and the moment they do write their own, theirs
 * wins.
 *
 * It doubles as the editor's preview: seeing a rule described back is how you
 * notice it says something other than what you meant.
 */

import type { ParsedScript, ScriptCondition } from './parse.js'
import { fixNamed } from './vocabulary.js'

/** Subjects whose names do not turn into readable English on their own. */
const PHRASES: Record<string, string> = {
  container: 'the container',
  'file.name': 'the file name',
  'file.path': 'the full path',
  'file.extension': 'the file extension',
  'file.sizeBytes': 'the file size in bytes',
  'file.durationSeconds': 'the running time in seconds',
  'file.bitRate': 'the overall bitrate',
  'file.faststart': 'the MP4 index already being at the front',
  'video.count': 'the number of video tracks',
  'audio.count': 'the number of audio tracks',
  'subtitle.count': 'the number of subtitle tracks',
  'video.dolbyVision': "the video's Dolby Vision profile",
  'video.chroma': "the video's chroma subsampling",
  'video.hdr': 'the video being HDR',
  'video.interlaced': 'the video being interlaced',
  'video.anamorphic': 'the video being anamorphic',
  'subtitle.image': 'a subtitle track being picture-based'
}

/** `bitDepth` → `bit depth`. */
function humanize(leaf: string): string {
  return leaf.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}

export function subjectPhrase(name: string, scope: string): string {
  const known = PHRASES[name]
  if (known) return known
  const leaf = humanize(name.split('.').slice(1).join(' ') || name)
  if (scope === 'video') return `the video's ${leaf}`
  if (scope === 'audio') return `an audio track's ${leaf}`
  if (scope === 'subtitle') return `a subtitle track's ${leaf}`
  return `the ${leaf}`
}

function list(values: (string | number | boolean)[]): string {
  const written = values.map((value) => String(value))
  if (written.length <= 1) return written.join('')
  return `${written.slice(0, -1).join(', ')} or ${written[written.length - 1]}`
}

export function describeCondition(condition: ScriptCondition): string {
  const subject = subjectPhrase(condition.subject.name, condition.subject.scope)
  const values = list(condition.values)

  switch (condition.operator.name) {
    case 'is':
      return `${subject} is ${values}`
    case 'is not':
      return `${subject} is not ${values}`
    case 'in':
      return `${subject} is ${values}`
    case 'not in':
      return `${subject} is none of ${values}`
    case 'contains':
      return `${subject} contains "${values}"`
    case 'above':
      return `${subject} is more than ${values}`
    case 'below':
      return `${subject} is less than ${values}`
    case 'at least':
      return `${subject} is ${values} or more`
    case 'at most':
      return `${subject} is ${values} or fewer`
    case 'is set':
      return `${subject} is given at all`
    case 'is missing':
      return `${subject} is not given at all`
    default:
      return condition.wrote
  }
}

/** "the video's codec is divx or dx50, and the container is matroska" */
export function describeConditions(script: ParsedScript): string {
  const parts = script.conditions.map(describeCondition)
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

export function describeFixes(script: ParsedScript): string {
  const parts = script.fixes.map((name) => fixNamed(name)?.describe.toLowerCase() ?? name)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

export interface ScriptProse {
  summary: string
  whatItDoes: string
  howItWorks: string
  ifDisabled: string
}

/** The three explanations, the author's own where they wrote one. */
export function describeScript(script: ParsedScript): ScriptProse {
  const conditions = describeConditions(script)
  const fixes = describeFixes(script)
  const severity = script.report?.severity

  const summary =
    script.summary ??
    (script.report ? script.report.title : `Asks for ${fixes || 'a repair'} on the files it matches`)

  const whatItDoes =
    script.whatItDoes ??
    [
      'A rule you wrote yourself.',
      script.report
        ? `It reports ${severity === 'blocker' ? 'a blocker' : severity === 'warning' ? 'a warning' : 'a note'}, “${script.report.title}”, on any file it matches.`
        : 'It reports nothing, and only asks for a repair.',
      script.fixes.length > 0 ? `It then asks the app to ${fixes}.` : 'It asks for no repair.'
    ].join(' ')

  const howItWorks =
    script.howItWorks ?? `It matches a file when ${conditions || 'nothing in particular, which cannot happen'}.`

  const ifDisabled =
    script.ifDisabled ??
    'This rule stops running. Nothing else changes — every other check and repair carries on as it was.'

  return { summary, whatItDoes, howItWorks, ifDisabled }
}
