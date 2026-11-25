/**
 * What changed, told once — the first time a version runs.
 *
 * The notes on the releases page are written for someone deciding whether to
 * update. These are for someone who already has: shorter, and only the part
 * that changes what they see. Each release links out to its full notes.
 *
 * Kept here rather than fetched, so the app can say what it is without a
 * network call, and so the text ships with the build it describes — a copy
 * downloaded in a year still explains itself.
 *
 * Adding a release means adding an entry here, newest first, in the same
 * commit as the version bump. A test fails if the version in package.json has
 * no entry, which is the reminder.
 */

import { RELEASES_URL } from './about.js'

export interface ReleaseChange {
  /** A heading that says what changed, not what area it was in. */
  title: string
  /** One short paragraph. The rest is on the releases page. */
  body: string
}

export interface ReleaseNote {
  /** Plain `x.y.z`, matching the version the app reports. */
  version: string
  /** The line under the version: what this release is about. */
  headline: string
  changes: ReleaseChange[]
}

/** Newest first. */
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '0.3.6',
    headline: 'Drag the queue into the order you want, and a finished repair is no longer thrown away over a question asked too early.',
    changes: [
      {
        title: 'Drag a waiting repair anywhere in the queue',
        body:
          'A scan queues repairs in the order it walked the library, which is nobody\u2019s order of preference \u2014 and ' +
          'the one film you want tonight ends up behind forty others. Every waiting repair now has a grip ' +
          'handle: take hold of it and drop the row wherever you want it, in one gesture. The one at the ' +
          'front of the queue says \u201cnext\u201d rather than \u201cqueued\u201d. The handle takes focus, so the arrow keys move ' +
          'a repair a place at a time without a mouse. What is already running stays where it is: it has a ' +
          'file open and a temporary half written.'
      },
      {
        title: 'A repair is asked twice before it is given up on',
        body:
          'A 13 GB remux across a network share ran for thirteen minutes, ffmpeg finished cleanly, and the ' +
          'result was discarded \u2014 because the share had not caught up with its own write. The index was ' +
          'visible, the data behind it was not, and the check that followed a fraction of a second later read ' +
          'a file that did not add up. The output is now measured against what ffmpeg says it wrote, and the ' +
          'check is tried again a few seconds later. Something genuinely broken still fails every attempt.'
      },
      {
        title: 'Failures say what actually went wrong',
        body:
          'ffmpeg and ffprobe narrate as they work: every decoder complains on the way past, and the sentence ' +
          'naming the real fault is printed last, after all of it. PlexFixer kept the first line and dropped ' +
          'the rest, so the repair above was reported as an AAC decoder warning while \u201cInvalid data found ' +
          'when processing input\u201d sat on the line below it, discarded. A failed check now quotes the verdict ' +
          'and keeps everything printed underneath it.'
      }
    ]
  }
]

/**
 * `-1`, `0` or `1`, comparing `0.2.10` above `0.2.9` rather than below it.
 *
 * Anything after a `-` or `+` is ignored, and a part that is not a number
 * counts as zero: a version this cannot read sorts low rather than throwing,
 * which at worst shows notes that have been seen before.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string): number[] =>
    version
      .trim()
      .split(/[-+]/)[0]
      .split('.')
      .map((part) => {
        const value = Number.parseInt(part, 10)
        return Number.isFinite(value) ? value : 0
      })

  const left = parts(a)
  const right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

/** Newest first, whatever order the table was written in. */
function newestFirst(notes: readonly ReleaseNote[]): ReleaseNote[] {
  return [...notes].sort((a, b) => compareVersions(b.version, a.version))
}

/** The notes for `version` and everything older, newest first. */
function upTo(version: string, notes: readonly ReleaseNote[]): ReleaseNote[] {
  return newestFirst(notes).filter((note) => compareVersions(note.version, version) <= 0)
}

/**
 * What this run should show, newest first — empty when there is nothing to say.
 *
 * `lastSeen` is the version that last showed its notes, or `undefined` on a
 * machine that has never recorded one. That covers two different people: a
 * fresh install, and someone who updated from a version released before this
 * screen existed. They are told apart by nothing available here, so both are
 * shown the current release and no further back. A new user gets one screen
 * saying what the thing they just installed recently gained, rather than a
 * history of releases they never ran.
 *
 * Skipping versions is not skipping notes: updating from 0.2.4 straight to
 * 0.2.6 shows both. Notes newer than what is running are never shown — a
 * downgraded install is not told about a version it does not have.
 */
export function notesSince(
  lastSeen: string | undefined,
  current: string,
  notes: readonly ReleaseNote[] = RELEASE_NOTES
): ReleaseNote[] {
  const available = upTo(current, notes)
  if (lastSeen === undefined) {
    // Only the current release, and only if it has an entry at all.
    return available[0]?.version === current ? [available[0]] : []
  }
  return available.filter((note) => compareVersions(note.version, lastSeen) > 0)
}

/**
 * What "What's new" shows when it is asked for rather than shown.
 *
 * The newest notes this build has, which is normally its own version — and on
 * a build whose notes were never written, the release before it rather than
 * nothing.
 */
export function latestNotes(current: string, notes: readonly ReleaseNote[] = RELEASE_NOTES): ReleaseNote[] {
  const available = upTo(current, notes)
  return available.length > 0 ? [available[0]] : []
}

/** The releases page, at this version's entry. */
export function releaseUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`
}
