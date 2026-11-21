/**
 * Doing what a person asked for by hand.
 *
 * The only module that is not an opinion. Everything else here works out what
 * a file needs; this one is handed an answer and writes it. It runs last, so a
 * choice made by a person beats every rule that had a view — which is the
 * entire point of being able to make one.
 *
 * Where a rule and a person both have something to say about the same track,
 * the two are merged field by field rather than one replacing the other: a
 * person setting a track's name should not quietly undo the language tag a
 * check worked out for it.
 */

import type { RepairModule } from '../framework.js'
import type { MediaStream, TrackPlanChange } from '../../../types.js'
import { cleanTags, type TrackEdit } from '../../metadata.js'

/** The person's answer where they gave one, the rule's where they did not. */
function merge(change: TrackPlanChange, edit: TrackEdit): TrackPlanChange {
  return {
    ...change,
    ...(edit.title !== undefined ? { setTitle: edit.title } : {}),
    ...(edit.language !== undefined ? { setLanguage: edit.language } : {}),
    ...(edit.default !== undefined ? { setDefault: edit.default } : {}),
    ...(edit.forced !== undefined ? { setForced: edit.forced } : {}),
    reason: `${change.reason}, and what you set by hand`
  }
}

function fresh(stream: MediaStream, edit: TrackEdit): TrackPlanChange {
  return {
    streamIndex: stream.index,
    kind: stream.kind,
    ...(edit.title !== undefined ? { setTitle: edit.title } : {}),
    ...(edit.language !== undefined ? { setLanguage: edit.language } : {}),
    ...(edit.default !== undefined ? { setDefault: edit.default } : {}),
    ...(edit.forced !== undefined ? { setForced: edit.forced } : {}),
    reason: 'Set by hand'
  }
}

/** Whether a track edit asks for anything. */
function says(edit: TrackEdit): boolean {
  return (
    edit.title !== undefined ||
    edit.language !== undefined ||
    edit.default !== undefined ||
    edit.forced !== undefined
  )
}

export const manualMetadata: RepairModule = {
  id: 'repair.manual-metadata',
  title: 'Metadata you set by hand',
  summary: 'Writes the titles, languages and flags you chose yourself',
  whatItDoes:
    'Writes what you asked for on the file’s metadata screen: the title and the other file-level tags, and ' +
    'each track’s name, language, and whether it plays or appears without being chosen. Nothing here is ' +
    'worked out — it is what you said.',
  howItWorks:
    'It runs after every other repair, so where a rule and you have both decided something about the same ' +
    'track, yours is what gets written. The two are merged rather than one replacing the other: setting a ' +
    'track’s name does not undo a language tag a check corrected. Only the file-level tags on the ' +
    'screen’s own list are ever written, so nothing reaches ffmpeg that was not offered to you.',
  ifDisabled:
    'The metadata screen still shows what a file says, and still looks things up, but nothing you change ' +
    'there is written.',
  answers: [],

  run({ file, edits }) {
    if (!edits) return {}

    const tags = cleanTags(edits.tags)
    const overrides = new Map<number, TrackEdit>()
    for (const [index, edit] of Object.entries(edits.tracks ?? {})) {
      if (says(edit)) overrides.set(Number(index), edit)
    }
    if (Object.keys(tags).length === 0 && overrides.size === 0) return {}

    const byIndex = new Map<number, MediaStream>(file.streams.map((stream) => [stream.index, stream]))
    const parts: string[] = []
    if (Object.keys(tags).length > 0) {
      parts.push(`${Object.keys(tags).length} file tag${Object.keys(tags).length === 1 ? '' : 's'}`)
    }
    if (overrides.size > 0) parts.push(`${overrides.size} track${overrides.size === 1 ? '' : 's'}`)

    return {
      strategy: 'remux',
      plan: Object.keys(tags).length > 0 ? { metadataTags: tags } : undefined,

      amendTrackChanges: (changes) => {
        const touched = new Set<number>()
        const merged = changes.map((change) => {
          const edit = overrides.get(change.streamIndex)
          // A track being dropped is not a track being renamed.
          if (!edit || change.drop) return change
          touched.add(change.streamIndex)
          return merge(change, edit)
        })

        for (const [index, edit] of overrides) {
          if (touched.has(index)) continue
          const stream = byIndex.get(index)
          // A track that is being dropped, or is not in the file at all, is
          // left alone rather than given a change that would contradict one.
          if (!stream || changes.some((change) => change.streamIndex === index && change.drop)) continue
          merged.push(fresh(stream, edit))
        }

        return merged
      },

      actions: [
        {
          label: `Write the metadata you set (${parts.join(' and ')})`,
          detail:
            'The streams are copied untouched; only what the file says about itself changes. A track name or a ' +
            'file tag is not a fixed-width field, so the file is rewritten rather than edited where it lies.'
        }
      ]
    }
  }
}
