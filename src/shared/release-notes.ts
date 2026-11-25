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
    version: '0.3.3',
    headline: 'Changing a title no longer rewrites the film.',
    changes: [
      {
        title: 'Tag edits are instant',
        body:
          'Changing a title, a series or an episode number used to rewrite the whole file \u2014 reading and writing ' +
          'every byte of a 30 GB film to change two words \u2014 because that is the only way ffmpeg can do it. ' +
          'PlexFixer now writes tags the way Subler does, through mp4v2, which keeps free space beside the ' +
          'header and moves nothing else. It takes about as long on a 40 GB file as on a 40 MB one. This is ' +
          'for MP4 and M4V; Matroska still goes the long way round.'
      },
      {
        title: 'Ollama tells you what it has',
        body:
          'Choosing a local model meant typing its name from memory, and getting it wrong failed later, at ' +
          'translation time. Settings \u2192 Subtitles has a Detect button beside the Model field: it asks the ' +
          'endpoint you have configured and turns the box into a list of what is actually pulled, with each ' +
          'model\u2019s parameters, quantisation and size. The box comes back if you would rather type one.'
      }
    ]
  },
  {
    version: '0.3.1',
    headline: 'Typing works again: the dialogs were taking focus back from under you.',
    changes: [
      {
        title: 'Fields keep the caret',
        body:
          'Click into a field, the caret appears, and it is gone again \u2014 every field, in every dialog. Three of ' +
          'them re-ran the effect that focuses their Close button on every render of whatever was around them, ' +
          'and that happens for anything at all: a repair reporting progress, a scan, a counter ticking. The ' +
          'focus now happens once, when the dialog opens. This is also the likeliest reason an episode number ' +
          'could come out as 206 when you typed 6: a caret put back at the start mid-edit puts keystrokes ' +
          'where they were not aimed.'
      },
      {
        title: 'The editor trusts what the file says over what it is called',
        body:
          'The season and episode boxes were filled in from the file name and ignored the tags the file ' +
          'carries \u2014 and those boxes are written back, so picking a series could overwrite a correct ' +
          'episode number with one read out of the name. A tag is evidence; a name is an inference, and an ' +
          'inference should not replace a statement.'
      },
      {
        title: 'The translate picker has something to pick',
        body:
          'The language dropdown on a subtitle track offered one option \u2014 the track\u2019s own language \u2014 so it ' +
          'opened on a choice that did nothing. A track is no longer offered the language it is already in, ' +
          'and with nothing left to offer the picker is not drawn at all; the button says where to add ' +
          'languages instead.'
      },
      {
        title: 'An open file survives a re-scan',
        body:
          'A background re-scan could unmount the details panel for a single frame, taking any dialog open ' +
          'inside it \u2014 and everything typed into it \u2014 with it. While a row is open it now keeps showing ' +
          'what it had.'
      }
    ]
  },
  {
    version: '0.3.0',
    headline: 'A light interface built around titles rather than file names, and subtitles that stay in the film.',
    changes: [
      {
        title: 'Light, and the colours mean something',
        body:
          'The whole interface is light now, led by blue, and the other three colours are spent deliberately: ' +
          'green for nothing to do, orange for a warning \u2014 something lossy, slow, or worth looking at \u2014 and red ' +
          'only for danger, meaning it cannot be fixed or something will be lost. Nothing else is tinted.'
      },
      {
        title: 'The library reads as films and episodes',
        body:
          'Rows are titles rather than file names, with the season and episode ahead of the series name and the ' +
          'episode\u2019s own name under it. Two columns went: how big the file is and when it was scanned, which ' +
          'nobody scans a library to find out \u2014 the technical facts are behind an info icon beside the title. ' +
          'What is left answers the two questions the list is for, now headed Issues and Proposed action, with ' +
          'the per-track changes a repair will make listed under the latter.'
      },
      {
        title: 'Details beside the list, not inside it',
        body:
          'Clicking a row opens a panel on the right rather than unfolding the row, which used to push every ' +
          'other row off the screen. The four counts are one line with search and the filters beside them; the ' +
          'filters are one button holding every way of narrowing the list, each a checkbox. Every subtitle ' +
          'track has its own resync and translate buttons, and the default track is a tick rather than a badge ' +
          'on almost every row.'
      },
      {
        title: 'A repaired file now says it is repaired',
        body:
          'A disc rip whose soundtrack cannot be direct-played is fixed by adding a compatible track beside it ' +
          '\u2014 and until now the next scan went on reporting the original as a blocker anyway, so the file never ' +
          'reached Passed and the same repair was offered again for ever. A track nothing can play is only a ' +
          'fault when nothing beside it can be played; where a compatible track exists, the original is noted as ' +
          'kept rather than flagged as broken.'
      },
      {
        title: 'Resync the tracks you pick, in one pass',
        body:
          'The Subtitles panel opens on the text subtitle tracks already in the file, with a tick box each. Tick ' +
          'one or several, press Resync to the audio, and PlexFixer finds the speech, compares it with where ' +
          'each track says the lines are, and writes the corrected timings back into the film. The speech is ' +
          'found once however many tracks are ticked, and every corrected track goes back in a single rewrite \u2014 ' +
          'a track at a time would copy a 40 GB film three times to change some timecodes. A track already in ' +
          'step is reported and left exactly as it was.'
      },
      {
        title: 'Nothing lands beside the film any more',
        body:
          'Sidecar .srt files are gone: a subtitle beside the film is a second file to copy, move and lose, and ' +
          'a track in the film is the film. Anything found online, written from the audio or translated goes in ' +
          'as a track \u2014 over the one it came from, or alongside the rest. Writing into the film goes the way a ' +
          'repair goes: copy to a working file, check what came out, then replace, with the original moved into ' +
          'the backup folder first when backups are on.'
      },
      {
        title: 'Styled subtitles are rewritten rather than pulled out',
        body:
          'ASS and SSA tracks become plain SRT inside the file. The dialogue is identical; the styling, which no ' +
          'client can reproduce and which is the whole reason Plex burns these in, is what goes. Text tracks ' +
          'headed into an MP4 are converted to tx3g instead of being dropped, so a file with an STL or SubViewer ' +
          'track no longer loses it \u2014 only picture subtitles are left behind, because there is no text in them.'
      },
      {
        title: 'A repair can check the timing while it is in there',
        body:
          'New under Compatibility, off by default: every text subtitle measured against the audio during a ' +
          'repair and corrected if it is out of step. Off because finding the speech reads the whole audio ' +
          'track, twenty seconds to a minute on a feature, whether or not anything turns out to be wrong. ' +
          'Rules written in the editor use resync-subtitles where they used extract-subtitles.'
      }
    ]
  },
  {
    version: '0.2.13',
    headline: 'The whisper.cpp builds 0.2.12 added are now actually offered on Windows, where they are the ones that exist.',
    changes: [
      {
        title: 'Windows is offered the Windows builds',
        body:
          'Both builds were in 0.2.12 and neither could be reached: they are filed by platform and ' +
          'architecture together, and the panel was matching that against the platform alone, so nothing ' +
          'ever matched. Every Windows machine was told whisper.cpp publishes no build for it — and then ' +
          'pointed at Homebrew, which is not on Windows. Settings → Subtitles now shows the NVIDIA and ' +
          'processor-only builds, with the NVIDIA one first.'
      },
      {
        title: 'And when there really is no build, it says something true',
        body:
          'The Homebrew line is now said only on macOS, which is the one platform whisper.cpp genuinely ' +
          'publishes no command-line build for. Anywhere else the panel says plainly that there is nothing ' +
          'to install and that a binary can be named by hand.'
      }
    ]
  },
  {
    version: '0.2.12',
    headline: 'Transcribing on your own machine now takes two buttons: PlexFixer installs whisper.cpp and fetches the model itself.',
    changes: [
      {
        title: 'It installs whisper.cpp for you \u2014 on the graphics card, if you have one',
        body:
          'Local transcription needed a binary nothing installs, from a releases page where the version tags ' +
          'carry no files and the builds hang off rolling ones. Settings \u2192 Subtitles now offers the two that ' +
          'matter on Windows \u2014 NVIDIA, which runs on the card and turns an afternoon into minutes, and ' +
          'processor-only \u2014 and downloads, checks and unpacks one into the app\u2019s own folder. The NVIDIA ' +
          'build carries its own CUDA runtime, so there is nothing else to install. On a Mac, where whisper.cpp ' +
          'publishes no command-line build at all, PlexFixer finds a Homebrew one instead.'
      },
      {
        title: 'And fetches the model, which is the other half',
        body:
          'Six models with what each is for, from 148 MB of English to 3.1 GB of everything, with the ' +
          'quantised large turbo at 574 MB suggested as the one to take if you only take one. Both the build ' +
          'and the model are held to a published SHA-256 as they download and thrown away if they do not ' +
          'match \u2014 a model file is read by a program this app then runs.'
      },
      {
        title: 'A whisper-cli you installed yourself is used without being named',
        body:
          'Settings still wins when it names a path. Failing that, PlexFixer uses a build it installed, then ' +
          'anything already on PATH \u2014 so Homebrew\u2019s is picked up with nothing typed in. Removing a build it ' +
          'installed is one button, and deletes one folder.'
      }
    ]
  },
  {
    version: '0.2.11',
    headline: 'Subtitles: found, timed against the audio, written from the audio, translated \u2014 and a re-encode now asks where it should go.',
    changes: [
      {
        title: 'Subtitles, four ways',
        body:
          'Search OpenSubtitles by the file\u2019s own hash, so a match was uploaded for this exact encode and its ' +
          'timing is usually right to the frame. Check a subtitle against the audio and see whether it is in ' +
          'step, out by a constant amount, drifting, or for another film entirely \u2014 then correct it. Write a ' +
          'subtitle from the audio with Whisper, locally or hosted. Translate one with any chat model, ' +
          'including local models through Ollama, which lists what you have pulled.'
      },
      {
        title: 'Transcribing is Whisper\u2019s job, not a chat model\u2019s',
        body:
          'Ollama serves text and vision models and has no speech-to-text endpoint, so there is nowhere to ' +
          'send audio. Transcription is therefore Whisper \u2014 a local whisper.cpp build you point Settings at, ' +
          'or a hosted speech endpoint \u2014 and the chat models do the translating, which is the part they are ' +
          'genuinely good at.'
      },
      {
        title: 'A transcode into a new output folder no longer fails instantly',
        body:
          'With an output folder set, PlexFixer mirrors your library inside it \u2014 a folder per film \u2014 so the ' +
          'first repair of a film wrote into a folder that did not exist yet. ffmpeg does not create the folder ' +
          'it is told to write into; it stops with \u201cNo such file or directory\u201d before reading a frame. ' +
          'The folder is now made first.'
      },
      {
        title: 'A re-encode asks where the result goes',
        body:
          'Settings holds the standing answer, and for a remux that is right. A re-encode takes hours and is ' +
          'not lossless, so it now asks when you start it \u2014 one file included \u2014 and offers the folder ' +
          'Settings names, beside each original, replacing each original, or a folder chosen right then. ' +
          'The choice applies to that run; Settings is not touched.'
      }
    ]
  },
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
