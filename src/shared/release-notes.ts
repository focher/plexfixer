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
    version: '0.2.10',
    headline: 'A file that only needs a new name is renamed, not rewritten \u2014 and season and episode numbers are written one way everywhere.',
    changes: [
      {
        title: 'A new name is a rename, not a copy',
        body:
          'A file that is already everything Plex wants, but carries the wrong name, used to be skipped \u2014 ' +
          'the naming pattern only ever took effect through a repair. It is now renamed, and renamed is all it ' +
          'is: the file stays exactly where it lies on disk and not one byte of it is read or written. A repair ' +
          'that only touches the header does the same, so six gigabytes over a share costs what it should.'
      },
      {
        title: 'Season and episode numbers lose their leading zeros',
        body:
          'A number typed as 01, one written into a file by something else, and one that came back from a ' +
          'lookup are the same season, and are now written the same way: bare. Files are named S5E14 rather ' +
          'than S05E14, and re-applying an edit that changed nothing no longer looks like a change worth ' +
          'rewriting the file for. Season 0 stays 0, where the specials live.'
      }
    ]
  },
  {
    version: '0.2.9',
    headline: 'Episodes are looked up and named as episodes, and you can correct any search that went astray.',
    changes: [
      {
        title: 'Episodes are found by number, not by name',
        body:
          'An episode is found by series, season and number \u2014 the only thing a file name reliably carries ' +
          'and the only thing that identifies an episode at all, since two series share episode names and half ' +
          'the episodes in a library have no name in the file. S01E02, 1x02 and "Season 1 Episode 2" are all ' +
          'read. What gets written is the episode\u2019s own name and air date, with the series in its own ' +
          'field, so a season is no longer twenty-four files called the same thing.'
      },
      {
        title: 'Correct any search and run it again',
        body:
          'Every row in Bulk \u2192 Metadata lookup now carries the terms it searched on \u2014 title and year ' +
          'for a film, series, season, episode and year for an episode \u2014 and a Look up button beside them. ' +
          'The thing most often wrong is not the answer but the question, and a file name is a poor question.'
      },
      {
        title: 'Films and episodes are named by separate patterns',
        body:
          'Settings \u2192 Output now takes one pattern for films and another for episodes, because the two have ' +
          'never been named the same way: an episode has no release year and a film has no season. A file is ' +
          'treated as an episode when its tags say so, or failing that when its name does.'
      },
      {
        title: 'Write every MP4 as .m4v, or as .mp4',
        body:
          'An .m4v file is an MP4 \u2014 Apple\u2019s name for one with video in it \u2014 and Plex plays either. ' +
          'Settings \u2192 Output will now write all of them one way or the other, for a library that is half ' +
          'one and half the other. Left as it is, a file that already names its container keeps the name it has.'
      }
    ]
  },
  {
    version: '0.2.8',
    headline: 'Looking a film up no longer closes the app \u2014 and now you can look up a whole shelf at once, and name the files from what comes back.',
    changes: [
      {
        title: 'Searching themoviedb.org no longer closes the window',
        body:
          'It closed the app outright, and only sometimes, which made it look like anything but what it was: ' +
          'the encryption the request needed had not been set up unless an update check happened to have run ' +
          'first. It is now set up before the request rather than by luck.'
      },
      {
        title: 'Look up a whole selection at once',
        body:
          'Bulk \u2192 Metadata lookup searches every selected file and shows you one list to review. Only the ' +
          'answers it is confident about arrive ticked; the rest sit there with the reason beside them \u2014 a ' +
          'year that disagrees with the file name, a title that drifted, two results that look equally likely ' +
          '\u2014 and every row has the other results to pick from instead. Nothing is written until you press ' +
          'Apply.'
      },
      {
        title: 'Name repaired files from their own metadata',
        body:
          'Settings \u2192 Output takes a pattern such as {title} ({year}), and a repaired file is named from ' +
          'what it says about itself \u2014 including the title and release date a lookup just wrote in. A file ' +
          'missing any field you use keeps the name it has, so nothing is ever written as half a title.'
      },
      {
        title: 'A rule for files that say nothing about themselves',
        body:
          'Under Settings \u2192 Checks & repairs, "Metadata worth looking up" points out files with no title ' +
          'of their own, or carrying the file name again, or a ripper\u2019s leftovers. It ships switched off, ' +
          'because it is true of most of a library and is cleared by hand.'
      },
      {
        title: 'Better guesses from file names with a date in them',
        body:
          'A release date in the file name left a stray bracket in the search box \u2014 Casino Royale ' +
          '(14-11-2006).mkv was searched for as "Casino Royale (". Both halves of that are now read properly.'
      }
    ]
  },
  {
    version: '0.2.7',
    headline: 'The rules are yours to read, to switch off, and to add to — and you can now edit a file yourself.',
    changes: [
      {
        title: 'Every check and repair explains itself, and can be switched off',
        body:
          'What was one long function is now forty small ones, listed under Settings → Checks & repairs. Each ' +
          'says in plain English what it looks for, how it decides and what you give up by turning it off. ' +
          'Turning a check off means it is never reported; turning a repair off means the problem is still ' +
          'reported and listed as something the app will not fix — which is how you run a library you only ever ' +
          'want remuxed.'
      },
      {
        title: 'You can write your own rules',
        body:
          'A rule is a few lines: what to look for, what to call it, and which repair to ask for. Build it by ' +
          'dragging blocks or by typing — they are two views of the same rule. Nothing in a rule is executed: ' +
          'it can compare what is in a file and ask for a repair the app already has, and that is all it can do.'
      },
      {
        title: 'Edit a file\u2019s metadata yourself',
        body:
          'Edit metadata, on any row, opens the file\u2019s own title, year, summary and genre, and every track ' +
          'with its name, language and whether it plays without being chosen. What you change is shown as a ' +
          'plan and costed before anything is written. A key for themoviedb.org, in Settings → Metadata, fills ' +
          'the fields in from a search.'
      },
      {
        title: 'Re-scanning a library is nearly instant',
        body:
          'A scan used to read every file it found, every time. It now checks size and modification time first ' +
          'and only reads the ones that changed. Clearing the list still reads everything.'
      },
      {
        title: 'Subtitle sidecars come out in one pass, from the right file',
        body:
          'Writing them ran ffmpeg once per track, each reading the whole film again. They now come out of a ' +
          'single pass. It was also reading the repaired file rather than the original — which no longer ' +
          'contains the tracks being extracted, that being why they are extracted — so on the usual settings ' +
          'sidecars were failing with a warning. Fixed.'
      },
      {
        title: 'This screen',
        body:
          'New versions used to arrive in silence. This now opens once when one does, and never again for the ' +
          'same version. About → What\u2019s new brings it back.'
      }
    ]
  },
  {
    version: '0.2.6',
    headline: 'A repair that promised a stream copy was quietly re-encoding subtitles — and failing on them.',
    changes: [
      {
        title: 'Subtitles that are already in MP4 format are copied, not re-encoded',
        body: 'A remux into MP4 asked ffmpeg to encode every subtitle track to tx3g, including tracks that already were tx3g. That is a decode and a re-encode, and real-world subtitles routinely hold bytes that are not valid UTF-8, so the repair failed — after copying most of a multi-gigabyte file. Only a track in some other format is converted now, and a file holding both kinds converts per track.'
      },
      {
        title: 'The queue fills before it starts working',
        body: 'Every file is probed on its way into the queue. A batch used to start repairing its first file during that wait, putting one repair and a long run of probes on the same disk. A batch added to an idle queue now waits until all of it is in. A batch added to a queue that is already working does not hold it up.'
      },
      {
        title: '"Files at once" applies to the queue you are watching',
        body: 'Changing how many repairs run at the same time used to do nothing until the next batch was queued. Raise it and more start immediately; lower it and nothing further starts until enough have finished. Neither stops a repair that is already running.'
      },
      {
        title: 'Hide completed',
        body: 'The queue page has the switch the library page has had. It hides repairs that succeeded, and only those — a failure stays on screen, because it is the row worth reading.'
      }
    ]
  },
  {
    version: '0.2.5',
    headline: 'Scanning a library on another machine is dramatically faster on macOS and Linux.',
    changes: [
      {
        title: 'A remote scan no longer pays for a connection per file',
        body: 'The scan really was running on the remote host, but every command opened its own ssh connection — on a thousand-file library those handshakes were the scan. ssh now multiplexes one connection per host, and the scan root is resolved once instead of once per file. Windows keeps the second fix only: its own ssh.exe cannot share connections at all.'
      },
      {
        title: 'The Windows installer stopped carrying files it should never have had',
        body: 'Two stray files had been shipping inside the installer — a note the build leaves itself, and an empty placeholder holding a folder open. Neither had any business being there, and neither is there now.'
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
