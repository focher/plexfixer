/**
 * A script as the form edits it, and the `plugin.json` that comes of it.
 *
 * Nobody writes a manifest by hand: the form holds a draft, and the manifest
 * is made from it on save. What the draft becomes is checked by the same
 * `parseManifest` that reads it back when the script is listed, so a draft
 * the form will save is one the app will load.
 */

import type { ParamValue } from '../catalog/types.js'
import type { ParamSpec } from '../modules/params.js'
import { parseManifest, SCRIPT_PROTOCOL, type ScriptFlag, type ScriptKind, type ScriptManifest } from './manifest.js'

/** One setting a script takes: its name in the input, its spec, and its default. */
export interface DraftParam {
  key: string
  spec: ParamSpec
  value: ParamValue
}

export interface ScriptDraft {
  kind: ScriptKind
  id: string
  /** Whether the id still follows the name; it stops once the user edits it, or the script is saved. */
  idFromName: boolean
  name: string
  version: string
  summary: string
  whatItDoes: string
  howItWorks: string
  ifDisabled: string
  /** What runs the script: `python3`, `bash`, `node`, or any program on the PATH. */
  program: string
  /** The script's own file, in its folder; empty when the program is all there is. */
  entry: string
  /** Anything after the file on the command line. */
  args: readonly string[]
  timeoutSeconds?: number
  params: readonly DraftParam[]
  raises: readonly ScriptFlag[]
  suggestedFlags: readonly string[]
}

/** The programs the form offers; anything else is typed in. */
export const PROGRAMS: readonly { value: string; label: string; extension: string }[] = [
  { value: 'python3', label: 'Python 3', extension: '.py' },
  { value: 'bash', label: 'Bash', extension: '.sh' },
  { value: 'node', label: 'Node.js', extension: '.js' }
]

const FOLDER = '{pluginDir}/'

/** A name as an id: "Subtitle adverts" becomes `subtitle-adverts`. */
export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')

/** A new script's draft, before the user has typed anything. */
export const emptyDraft = (kind: ScriptKind): ScriptDraft => ({
  kind,
  id: '',
  idFromName: true,
  name: '',
  version: '1.0.0',
  summary: '',
  whatItDoes: '',
  howItWorks: '',
  ifDisabled: '',
  program: 'python3',
  entry: kind === 'checks' ? 'check.py' : 'repair.py',
  args: [],
  params: [],
  raises: kind === 'checks' ? [{ code: 'found', label: '', hint: '', category: 'custom', severity: 'warning' }] : [],
  suggestedFlags: []
})

/** The draft a saved script is edited from. */
export function draftOf(manifest: ScriptManifest, kind: ScriptKind): ScriptDraft {
  const [program = '', second, ...rest] = manifest.command
  const inFolder = second?.startsWith(FOLDER) === true
  return {
    kind,
    id: manifest.id,
    idFromName: false,
    name: manifest.name,
    version: manifest.version,
    summary: manifest.summary,
    whatItDoes: manifest.whatItDoes,
    howItWorks: manifest.howItWorks,
    ifDisabled: manifest.ifDisabled,
    program,
    entry: inFolder ? second.slice(FOLDER.length) : '',
    args: inFolder ? rest : manifest.command.slice(1),
    ...(manifest.timeoutSeconds !== undefined ? { timeoutSeconds: manifest.timeoutSeconds } : {}),
    params: Object.entries(manifest.params).map(([key, spec]) => ({
      key,
      spec,
      value: manifest.defaults[key] as ParamValue
    })),
    raises: manifest.raises,
    suggestedFlags: manifest.suggestedFlags
  }
}

/** The command line the draft runs. */
export const commandOf = (draft: ScriptDraft): string[] => [
  draft.program.trim(),
  ...(draft.entry.trim() ? [`${FOLDER}${draft.entry.trim()}`] : []),
  ...draft.args
]

const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** What the form's own rules say is wrong, beyond what `parseManifest` checks. */
function draftProblems(draft: ScriptDraft): string[] {
  const keys = draft.params.map((param) => param.key)
  const codes = draft.raises.map((flag) => flag.code)
  return [
    ...(draft.name.trim() ? [] : ['Give the script a name.']),
    ...(draft.id ? [] : ['The id is empty: give the script a name with some letters or digits in it.']),
    ...(draft.program.trim() ? [] : ['Say what runs the script.']),
    ...keys.filter((key) => !KEY.test(key)).map((key) => `Setting "${key || '(no name)'}": a name is letters, digits and _, starting with a letter.`),
    ...keys.filter((key, index) => keys.indexOf(key) !== index).map((key) => `Setting "${key}" is listed twice.`),
    ...draft.params.filter((param) => !param.spec.label.trim()).map((param) => `Setting "${param.key}" needs a label.`),
    ...(draft.kind === 'checks' && draft.raises.length === 0 ? ['A check script needs at least one flag it can raise.'] : []),
    ...draft.raises.filter((flag) => !flag.label.trim()).map((flag) => `Flag "${flag.code}" needs a name.`),
    ...codes.filter((code, index) => codes.indexOf(code) !== index).map((code) => `Flag "${code}" is listed twice.`),
    ...(draft.timeoutSeconds !== undefined && !(draft.timeoutSeconds > 0) ? ['The time limit must be more than 0 seconds.'] : [])
  ]
}

/** The manifest object, in the order a person reading it would expect. */
function manifestObject(draft: ScriptDraft): Record<string, unknown> {
  const optional = (key: string, value: string): Record<string, string> => (value.trim() ? { [key]: value.trim() } : {})
  return {
    protocol: SCRIPT_PROTOCOL,
    id: draft.id,
    name: draft.name.trim(),
    version: draft.version.trim() || '1.0.0',
    ...optional('summary', draft.summary),
    ...optional('whatItDoes', draft.whatItDoes),
    ...optional('howItWorks', draft.howItWorks),
    ...optional('ifDisabled', draft.ifDisabled),
    command: commandOf(draft),
    ...(draft.timeoutSeconds !== undefined ? { timeoutSeconds: draft.timeoutSeconds } : {}),
    ...(draft.kind === 'checks' ? { raises: draft.raises } : {}),
    params: Object.fromEntries(draft.params.map((param) => [param.key, { ...param.spec, default: param.value }])),
    ...(draft.kind === 'repairs' && draft.suggestedFlags.length > 0 ? { suggestedFlags: draft.suggestedFlags } : {})
  }
}

/**
 * The `plugin.json` a draft saves as, or what stops it being saved.
 *
 * The text is what goes on disk; the manifest is what the app will read back
 * from it, and its being there is the proof that it will.
 */
export function manifestOf(draft: ScriptDraft): { source: string; manifest?: ScriptManifest; problems: string[] } {
  const source = `${JSON.stringify(manifestObject(draft), null, 2)}\n`
  const own = draftProblems(draft)
  if (own.length > 0) return { source, problems: own }
  const read = parseManifest(source, draft.id, draft.kind)
  return { source, ...(read.manifest ? { manifest: read.manifest } : {}), problems: read.problems }
}

/** A setting's default, fitted to a type it has just been changed to. */
export function defaultFor(spec: ParamSpec): ParamValue {
  switch (spec.type) {
    case 'number':
      return spec.options?.[0]?.value ?? spec.min ?? 0
    case 'boolean':
      return false
    case 'string':
      return spec.options?.[0]?.value ?? ''
    case 'list':
      return []
  }
}

/** A new script's first file: enough to show how the protocol goes. */
export function starterSource(kind: ScriptKind, program: string): string {
  if (program !== 'python3') return ''
  return kind === 'checks'
    ? [
        'import json, sys',
        '',
        '# PlexFixer sends one JSON document: the file, its streams, and your settings.',
        'job = json.load(sys.stdin)',
        '',
        'findings = []',
        '# Look at job["file"] and add a finding for each problem, e.g.:',
        '# findings.append({"code": "found", "detail": "What is wrong with this file"})',
        '',
        'print(json.dumps({"type": "result", "findings": findings}))',
        ''
      ].join('\n')
    : [
        'import json, shutil, sys',
        '',
        '# PlexFixer sends one JSON document: the input file, where to write the output, and your settings.',
        'job = json.load(sys.stdin)',
        '',
        '# Write the repaired file to job["output"]. This starter just copies it.',
        'shutil.copyfile(job["input"], job["output"])',
        '',
        'print(json.dumps({"type": "result", "message": "Copied"}))',
        ''
      ].join('\n')
}
