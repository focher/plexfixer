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
    version: '0.3.10',
    headline:
      'A repair says it is running while it is running, and a Dolby Vision conversion says how far it has got.',
    changes: [
      {
        title: 'A repair no longer says \u201cQueued\u201d for an hour while it works',
        body:
          'A repair was not marked as running until ffmpeg was about to be handed a command \u2014 and everything ' +
          'before that point reaches the disk: the checks for an in-place edit, a subtitle pass, and a Dolby ' +
          'Vision conversion that reads the whole film. Converting a 60 GB profile 7 film is an hour of work ' +
          'that was spent under a word meaning it had not begun, which is most of why a queue doing exactly ' +
          'what it should looked like one that had died. The time a repair took is measured from the same ' +
          'moment now, so a conversion that ran first counts as part of what it cost.'
      },
      {
        title: 'A Dolby Vision conversion reports what it has written',
        body:
          'Neither program in it will say: ffmpeg\u2019s progress goes down the pipe into dovi_tool, and dovi_tool ' +
          'draws a progress bar for a terminal rather than reporting to whatever started it. So the file ' +
          'being written is asked its size every few seconds, and the row says how much is there. No ' +
          'percentage \u2014 how much smaller the result is than the film is exactly what the conversion is ' +
          'deciding, and a percentage would be a guess that stops at seventy.'
      }
    ]
  },
  {
    version: '0.3.9',
    headline:
      'A repair can no longer die without telling you \u2014 and on Windows, Dolby Vision profile 7 films were all dying of a program that never made it into the installer.',
    changes: [
      {
        title: 'A queue that looked stuck was full of repairs that had already failed',
        body:
          'A repair that went wrong in a place nothing was expecting reported nothing at all. The queue did ' +
          'everything right \u2014 it freed the slot and started the next one \u2014 but the row went on saying ' +
          '\u201cQueued\u201d for good. Pick eight files, have seven of them fail instantly, and what is left looks ' +
          'exactly like a broken queue: one repair running and seven rows apparently waiting their turn ' +
          'behind it. A repair now either says what became of it or the queue says it for them.'
      },
      {
        title: 'Windows never had dovi_tool, so every profile 7 film failed',
        body:
          'Converting Dolby Vision profile 7 needs dovi_tool, and the Windows installer has never contained ' +
          'it. The build fetched it correctly and then failed to put it in place \u2014 the runner unpacks on one ' +
          'drive and builds on another, and moving between them needs a copy rather than a rename. Fetching ' +
          'it is allowed to fail without failing the release, so the build went green and said nothing. ' +
          'Windows builds now ship it, and profile 7 films convert as they always should have.'
      },
      {
        title: 'Save diagnostics… now saves',
        body:
          'It did nothing at all \u2014 no file, no dialog, no error. The window had never been given permission ' +
          'to open a save dialog, so asking for one failed silently. It works, and if it ever fails again it ' +
          'says so and points at Copy instead.'
      }
    ]
  },
  {
    version: '0.3.8',
    headline:
      'When something stalls, the app can now say what it is waiting on \u2014 and one unreadable file no longer takes the rest of a batch down with it.',
    changes: [
      {
        title: 'Diagnostics says what the app is waiting on',
        body:
          'A queue that appears stuck looks the same whether it is holding while a batch arrives, out of slots, ' +
          'or sitting on one call to a file server that has not come back \u2014 and the log could not tell them ' +
          'apart, because a call that hangs never gets as far as logging anything. Queue \u2192 Diagnostics now ' +
          'opens with every call that started and never finished, and how long ago. Underneath it: where the ' +
          'queue stands, what every kind of call cost, and a timestamped account of what the app did. Copy it ' +
          'or save it to a file. Nothing that could be a password or an API key is written into it.'
      },
      {
        title: 'A repair reports itself during the checks that come before it',
        body:
          'Two checks run before a repair commits to anything \u2014 whether the tags alone would do, and whether ' +
          'the header can be edited where it lies rather than the file being rewritten. Both reach the disk, ' +
          'and on a network share either can take a long time. The row reads \u201cConnecting\u201d throughout, which ' +
          'on a slow share is indistinguishable from a repair that has not started. They are now timed and ' +
          'named in the report.'
      },
      {
        title: 'One unreadable file no longer silently cancels the rest of the batch',
        body:
          'Every file is re-probed on its way into the queue, which reaches the disk \u2014 so a file moved, ' +
          'renamed or unmounted since the scan threw, and the throw took the whole batch with it. Every file ' +
          'after it was never queued and nothing said so. It is now one file\u2019s failure, written into the ' +
          'report, and the rest of the selection is queued as asked.'
      }
    ]
  },
  {
    version: '0.3.7',
    headline:
      'The services you already run \u2014 Radarr, Sonarr and Bazarr \u2014 are asked about your files instead of a database being asked to guess at their names.',
    changes: [
      {
        title: 'Radarr and Sonarr are asked first, and they are not guessing',
        body:
          'Looking a film up used to mean reading a title out of \u201cthe.movie.2019.1080p.x264.mkv\u201d and asking ' +
          'themoviedb.org what that might be \u2014 which is the step that gets a film wrong. If you run Radarr or ' +
          'Sonarr, they already know: they put the file where it is. Switch them on under Settings \u2192 Services ' +
          'and they are asked first, with the file\u2019s path, and themoviedb.org is asked only about files they ' +
          'have never heard of. An episode comes from the file Sonarr imported rather than from the numbers in ' +
          'its name, which is the case nothing else gets right when a release is numbered differently from the ' +
          'series. In a bulk lookup, a row matched this way arrives ticked: it is not a better guess, it is not ' +
          'a guess.'
      },
      {
        title: 'Your library manager is told when a file has been replaced',
        body:
          'PlexFixer repairs \u201cDune (2021).mkv\u201d into \u201cDune (2021).mp4\u201d and moves the original into the backup ' +
          'folder. Radarr\u2019s record still points at the .mkv: the film reads as missing, and on its next ' +
          'search Radarr downloads a replacement for a film sitting exactly where it left it. A finished repair ' +
          'now asks Radarr or Sonarr to look at the folder again \u2014 the same thing their own \u201cManual Import\u201d ' +
          'button does. Nothing happens if you do not run them.'
      },
      {
        title: 'Subtitles can come from Bazarr instead of OpenSubtitles',
        body:
          'Bazarr already has your accounts at every subtitle provider, your languages and your scoring rules. ' +
          'Asking it is asking all of them at once, under settings you decided on once. It does not hand a ' +
          'subtitle back the way a subtitle service does \u2014 it fetches the file into the film\u2019s own folder and ' +
          'answers with nothing \u2014 so PlexFixer waits for the file to appear and reads what actually arrived, ' +
          'and says so plainly if nothing does. A subtitle that was already there is never mistaken for the one ' +
          'just fetched.'
      },
      {
        title: 'A bulk lookup no longer stops halfway and sits there',
        body:
          'Looking up a selection could stall on \u201cSearching\u2026 4 of 6\u201d for good, with no error and nothing to do ' +
          'but cancel. The flag that stops the searches was being set by a cleanup that ran whenever the window ' +
          'behind the dialog redrew, and nothing ever set it back.'
      }
    ]
  },
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
