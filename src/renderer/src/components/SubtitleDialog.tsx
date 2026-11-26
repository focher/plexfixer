/**
 * The subtitle workshop for one film.
 *
 * Deliberately not four screens for the four things it does. A person here has
 * one subtitle in mind, and everything they might want is the same shape: get a
 * subtitle from somewhere, see whether it fits, change it, save it. So the
 * screen is that sentence — a source at the top, what was loaded in the middle,
 * and what can be done to it underneath — and finding one online, pulling one
 * out of the file and writing one from the audio are three answers to the same
 * first question rather than three separate features.
 *
 * Everything it does ends up **inside the film**. A subtitle that lives beside
 * the film is a second file to copy, move and lose; a track in the file is the
 * film. So the tracks already there can be picked — several at once — and put
 * back in time with one button, and anything found, written or translated goes
 * in as a track rather than next to one.
 *
 * Writing into the film means rewriting it, which is done exactly the way a
 * repair is: copy to a working file, check what came out, then replace, with
 * the original moved into the backup folder first when backups are on.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AnalysisResult, AppSettings, SubtitleStream } from '@shared/types.js'
import { languageName, languageOptions, normalizeLanguage } from '@shared/languages.js'
import { newId } from '@shared/ids.js'
import { isTextSubtitle } from '@shared/plex/rules.js'
import type { Cue } from '@shared/subtitles/cues.js'
import type { SubtitleCandidate } from '@shared/subtitles/providers/types.js'
import type { SyncReport } from '@shared/subtitles/sync.js'
import type { LlmModel } from '@shared/subtitles/llm.js'
import { cuesDurationMs } from '@shared/subtitles/cues.js'
import { formatDuration } from '../format.js'

/** A subtitle that has been loaded, and where it came from. */
interface Loaded {
  cues: Cue[]
  language: string
  /** One line: "Track 3 in the file", "From OpenSubtitles", "Transcribed by Whisper". */
  origin: string
  forced?: boolean
  /** Set once the timing has been measured. */
  timing?: SyncReport
  /** True once the timing report has been applied to the cues above. */
  retimed?: boolean
  /** Set when this is a translation, so the written track is named for it. */
  translatedFrom?: string
  /**
   * The stream index this came out of, when it came out of this film.
   *
   * It is what makes "put it back" mean replacing the track rather than
   * growing a second copy of it beside the first.
   */
  replaces?: number
}

type Busy = { opId: string; what: string; step: string; fraction?: number }

/**
 * Anything the API hands back may be a problem instead; this is that test.
 *
 * Takes `unknown` rather than a union, because the unions it is asked about
 * already contain the problem type: a guard written against `T | Problem`
 * narrows away only the half the caller spelled out, leaving the half that
 * arrived inside `T` behind.
 */
function failed(value: unknown): value is { problem: string; hint?: string } {
  return typeof value === 'object' && value !== null && 'problem' in value
}

/** Whatever is left of a result once the failure case is taken out of it. */
type Succeeded<T> = Exclude<T, { problem: string }>

const CONFIDENCE_BADGE: Record<SyncReport['confidence'], string> = {
  good: 'ok',
  fair: 'warn',
  poor: 'fail'
}

/** The verdict in one word, for a badge. */
const STATE_WORD: Record<SyncReport['state'], string> = {
  'in-sync': 'in step',
  offset: 'offset',
  drifting: 'drifting',
  mismatched: 'does not match',
  unknown: 'cannot tell'
}

const STATE_BADGE: Record<SyncReport['state'], string> = {
  'in-sync': 'ok',
  offset: 'warn',
  drifting: 'warn',
  mismatched: 'fail',
  unknown: 'neutral'
}

export default function SubtitleDialog({
  result,
  settings,
  onClose,
  onWrote
}: {
  result: AnalysisResult
  settings: AppSettings
  onClose: () => void
  /** The film was rewritten, so the row should be re-read. */
  onWrote: (path: string) => void
}): React.JSX.Element {
  const { file } = result
  const api = window.plexfixer.subtitles

  const [loaded, setLoaded] = useState<Loaded | undefined>()
  /** Tracks ticked for a resync, by stream index. */
  const [picked, setPicked] = useState<Set<number>>(new Set())
  /** What the last measurement said about each track. */
  const [verdicts, setVerdicts] = useState<Map<number, SyncReport>>(new Map())
  const [busy, setBusy] = useState<Busy | undefined>()
  const [problem, setProblem] = useState<{ problem: string; hint?: string } | undefined>()
  const [note, setNote] = useState<string | undefined>()
  const [candidates, setCandidates] = useState<SubtitleCandidate[] | undefined>()
  const [models, setModels] = useState<LlmModel[] | undefined>()
  const [target, setTarget] = useState(() => normalizeLanguage(settings.preferredSubtitleLanguage))

  // Progress arrives for every operation in the app; only this one's is shown.
  const busyRef = useRef<string | undefined>(undefined)
  busyRef.current = busy?.opId
  useEffect(
    () =>
      api.onProgress((progress) => {
        if (progress.opId !== busyRef.current) return
        setBusy((current) =>
          current && current.opId === progress.opId
            ? { ...current, step: progress.step, fraction: progress.fraction }
            : current
        )
      }),
    [api]
  )

  /**
   * Run one operation, with the screen in the right state either side of it.
   *
   * Every button on this screen does the same four things around its actual
   * work — clear the last complaint, show what is happening, catch what came
   * back, stop showing it — so they are written once here.
   */
  const run = useCallback(
    async <T,>(what: string, work: (opId: string) => Promise<T>): Promise<Succeeded<T> | undefined> => {
      const opId = newId()
      setProblem(undefined)
      setNote(undefined)
      setBusy({ opId, what, step: what })
      try {
        const outcome = await work(opId)
        if (failed(outcome)) {
          setProblem(outcome)
          return undefined
        }
        return outcome as Succeeded<T>
      } catch (error) {
        setProblem({ problem: error instanceof Error ? error.message : String(error) })
        return undefined
      } finally {
        setBusy((current) => (current?.opId === opId ? undefined : current))
      }
    },
    []
  )

  /* --- where a subtitle can come from --- */

  const textTracks = useMemo(
    () =>
      file.streams.filter(
        (stream): stream is SubtitleStream => stream.kind === 'subtitle' && isTextSubtitle(stream.codec)
      ),
    [file.streams]
  )
  const pictureTracks = file.streams.filter(
    (stream) => stream.kind === 'subtitle' && !isTextSubtitle(stream.codec)
  ).length

  const loadTrack = (track: SubtitleStream): void => {
    void (async () => {
      const cues = await run(`Reading track ${track.index}`, (opId) => api.readTrack(opId, file.path, track.index))
      if (cues) {
        setLoaded({
          cues,
          language: normalizeLanguage(track.language),
          origin: `Track ${track.index} in the file${track.title ? ` — ${track.title}` : ''}`,
          forced: track.disposition.forced,
          replaces: track.index
        })
        setCandidates(undefined)
      }
    })()
  }

  /** An .srt from anywhere on disk, to be added to the film as a track. */
  const addFromFile = (): void => {
    void (async () => {
      const path = await window.plexfixer.dialog.pickSubtitle()
      if (!path) return
      const cues = await run('Reading the file', (opId) => api.readFile(opId, path))
      if (cues) {
        const name = path.split(/[\\/]/).pop() ?? path
        // A language in the name — `film.ru.srt`, `subs.fr.srt` — is a better
        // guess than undetermined, and the picker below can correct it.
        const parts = name.split('.')
        const tag = parts.length >= 3 ? normalizeLanguage(parts[parts.length - 2]) : 'und'
        setLoaded({ cues, language: tag, origin: `${name}, from disk` })
        setCandidates(undefined)
      }
    })()
  }

  /* --- the tracks already in the film --- */

  const toggle = (index: number): void => {
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  /**
   * Measure the ticked tracks against the audio and put the film back in time.
   *
   * One pass: the speech is found once and every track compared against it,
   * and whatever moved goes back in a single rewrite of the film.
   */
  const resyncPicked = (): void => {
    const indexes = [...picked].sort((a, b) => a - b)
    if (indexes.length === 0) return
    void (async () => {
      const outcome = await run(
        indexes.length === 1 ? 'Resyncing the track' : `Resyncing ${indexes.length} tracks`,
        (opId) => api.resync(opId, result, indexes)
      )
      if (!outcome) return

      setVerdicts((current) => {
        const next = new Map(current)
        for (const track of outcome.tracks) next.set(track.streamIndex, track.report)
        return next
      })

      const moved = outcome.tracks.filter((track) => track.moved)
      if (moved.length === 0) {
        setNote(
          outcome.tracks.every((track) => track.report.state === 'in-sync')
            ? 'Every track measured is already in step with the audio, so the film was left alone.'
            : 'Nothing was moved — what each track measured is beside it below.'
        )
        return
      }
      setNote(
        `${moved.length} track${moved.length === 1 ? '' : 's'} retimed and written into the film.` +
          (settings.keepBackups ? ' The original is in the backup folder.' : '')
      )
      if (outcome.path) onWrote(outcome.path)
    })()
  }

  const search = (): void => {
    void (async () => {
      const found = await run('Looking for subtitles', (opId) => api.search(opId, result))
      if (found) {
        setCandidates(found)
        if (found.length === 0) setNote('Nothing came back for this film in the languages you asked for.')
      }
    })()
  }

  const download = (candidate: SubtitleCandidate): void => {
    void (async () => {
      const got = await run('Fetching it', (opId) => api.fetch(opId, candidate, file.path))
      if (got) {
        setLoaded({
          cues: got.cues,
          language: candidate.language,
          origin: `From OpenSubtitles${candidate.release ? ` — ${candidate.release}` : ''}`,
          forced: candidate.forced
        })
        setCandidates(undefined)
      }
    })()
  }

  const fromAudio = (translateToEnglish: boolean): void => {
    void (async () => {
      const written = await run(
        translateToEnglish ? 'Transcribing and translating' : 'Transcribing',
        (opId) => api.transcribe(opId, result, { translateToEnglish })
      )
      if (written) {
        setLoaded({ cues: written.cues, language: written.language, origin: written.how })
        setCandidates(undefined)
      }
    })()
  }

  /* --- what can be done to it --- */

  const check = (): void => {
    if (!loaded) return
    void (async () => {
      const checked = await run('Checking the timing', (opId) => api.check(opId, result, loaded.cues))
      if (checked) setLoaded((current) => (current ? { ...current, timing: checked.report, retimed: false } : current))
    })()
  }

  const applyTiming = (): void => {
    setLoaded((current) => {
      if (!current?.timing) return current
      return { ...current, cues: api.retime(current.cues, current.timing), retimed: true }
    })
    setNote('The lines have been moved. The film is untouched until you put the track into it.')
  }

  const translateIt = (): void => {
    if (!loaded) return
    void (async () => {
      const done = await run(`Translating to ${languageName(target)}`, (opId) =>
        api.translate(opId, loaded.cues, loaded.language, target)
      )
      if (done) {
        setLoaded({
          cues: done.cues,
          language: target,
          origin: done.how,
          translatedFrom: loaded.language,
          // A translation is the same timing as what it came from, so a check
          // already done still holds.
          timing: loaded.timing,
          retimed: loaded.retimed
        })
        if (done.untranslated.length > 0) {
          setNote(
            `${done.untranslated.length} line${done.untranslated.length === 1 ? '' : 's'} came back from the model ` +
              'unusable even after a retry, and kept the original wording rather than being left blank.'
          )
        }
      }
    })()
  }

  /**
   * Put what is loaded into the film — over the track it came from, or as a new
   * one.
   *
   * Replacing is the right default for a track that was read out of this film
   * and corrected: two copies of the same subtitle, one of them wrong, is
   * worse than one that is right. Anything from anywhere else is added, since
   * there is nothing of its own in the file to replace.
   */
  const save = (): void => {
    if (!loaded) return
    void (async () => {
      const replacing = loaded.replaces !== undefined && !loaded.translatedFrom
      const replacedTrack = textTracks.find((track) => track.index === loaded.replaces)
      const written = await run(
        replacing ? 'Replacing the track in the film' : 'Adding the track to the film',
        (opId) =>
          api.write(opId, file.path, loaded.cues, loaded.language, {
            streams: file.streams,
            replaceStreamIndex: replacing ? loaded.replaces : undefined,
            // Stated rather than left out when a track is being replaced: the
            // disposition is written as a whole, so silence would clear the
            // flags the track already had.
            forced: replacing ? !!loaded.forced : loaded.forced,
            default: replacing ? !!replacedTrack?.disposition.default : undefined,
            title: loaded.translatedFrom ? `${languageName(loaded.language)} (PlexFixer)` : undefined
          })
      )
      if (written) {
        setNote(
          replacing
            ? `Track ${loaded.replaces} in the film has been replaced.` +
                (settings.keepBackups ? ' The original is in the backup folder.' : '')
            : 'Added to the film as a new track.' +
                (settings.keepBackups ? ' The original is in the backup folder.' : '')
        )
        onWrote(written.path)
      }
    })()
  }

  const loadModels = (): void => {
    void (async () => {
      const found = await run('Asking what models are there', (opId) => api.models(opId))
      if (found) {
        setModels(found)
        if (found.length === 0) setNote('That endpoint answered, and has no models pulled.')
      }
    })()
  }

  const coverage = loaded ? cuesDurationMs(loaded.cues) / 1000 : 0
  const duration = file.durationSeconds ?? 0
  // A subtitle that stops at the half-hour mark of a two-hour film is a
  // subtitle for the first part of a two-part release, and nothing about the
  // timing check will say so.
  const short = loaded && duration > 0 && coverage > 0 && coverage < duration * 0.6

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="dialog subtitle-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Subtitles"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>Subtitles</h2>
        <div className="about-version mono">{file.fileName}</div>

        {/* ---------- the tracks already in the film ---------- */}
        {textTracks.length > 0 ? (
          <>
            <h4 className="block-heading">Tracks in this file</h4>
            <div className="subtitle-tracks">
              {textTracks.map((track) => {
                const verdict = verdicts.get(track.index)
                return (
                  <div className="subtitle-track" key={track.index}>
                    <label>
                      <input
                        type="checkbox"
                        checked={picked.has(track.index)}
                        disabled={!!busy}
                        onChange={() => toggle(track.index)}
                      />
                      <span>
                        Track {track.index} · {languageName(track.language)}
                        {track.disposition.forced ? ' · forced' : ''}
                        {track.title ? ` — ${track.title}` : ''}
                        <span className="muted"> · {track.codec.toUpperCase()}</span>
                      </span>
                    </label>
                    {verdict ? (
                      <div className="subtitle-track-verdict">
                        <span className={`badge ${STATE_BADGE[verdict.state]}`}>{STATE_WORD[verdict.state]}</span>
                        <span className="detail-text">{verdict.summary}</span>
                      </div>
                    ) : null}
                    <button className="ghost" disabled={!!busy} onClick={() => loadTrack(track)}>
                      Open
                    </button>
                  </div>
                )
              })}
            </div>

            <div className="subtitle-actions">
              <button
                className="primary"
                disabled={!!busy || picked.size === 0}
                onClick={resyncPicked}
                title="Find the speech in the audio, compare it with these tracks, and write the corrected timings into the film"
              >
                {picked.size > 1 ? `Resync ${picked.size} tracks to the audio` : 'Resync to the audio'}
              </button>
              <button
                className="ghost"
                disabled={!!busy || picked.size === textTracks.length}
                onClick={() => setPicked(new Set(textTracks.map((track) => track.index)))}
              >
                Select all
              </button>
              {picked.size > 0 ? (
                <button className="ghost" disabled={!!busy} onClick={() => setPicked(new Set())}>
                  Clear
                </button>
              ) : null}
            </div>
            <p className="section-hint">
              Finding the speech reads the whole audio track once, however many subtitles are ticked, and the
              corrected tracks go back in a single rewrite of the film. A track already in step is reported and left
              exactly as it was. The original is moved into the backup folder first when backups are on.
            </p>
          </>
        ) : null}

        {pictureTracks > 0 ? (
          <p className="section-hint">
            {pictureTracks} picture subtitle{pictureTracks === 1 ? ' is' : 's are'} in this file and cannot be resynced
            — there is no text in them, so there is nothing to compare against the speech. Writing one from the audio,
            below, produces a text track that can be.
          </p>
        ) : null}

        {/* ---------- adding one ---------- */}
        <h4 className="block-heading">Add a subtitle</h4>
        <div className="subtitle-sources">
          <button disabled={!!busy} onClick={search}>
            Find one online
          </button>
          <button disabled={!!busy} onClick={addFromFile}>
            From a file on disk…
          </button>
          <button disabled={!!busy} onClick={() => fromAudio(false)}>
            Write one from the audio
          </button>
          <button disabled={!!busy} onClick={() => fromAudio(true)}>
            …and translate it to English
          </button>
        </div>
        <p className="section-hint">
          Writing one from the audio goes through Whisper, set up under Settings → Subtitles. Translating in the same
          pass is Whisper’s own, which only ever produces English; translating afterwards, below, goes through a
          language model and will produce anything.
        </p>

        {/* ---------- what came back from a search ---------- */}
        {candidates && candidates.length > 0 ? (
          <>
            <h4 className="block-heading">{candidates.length} found</h4>
            <div className="subtitle-candidates">
              {candidates.map((candidate) => (
                <div className="subtitle-candidate" key={`${candidate.provider}-${candidate.id}`}>
                  <div className="body">
                    <div className="title">
                      {languageName(candidate.language)}
                      {candidate.hashMatch ? <span className="badge ok">matches this file</span> : null}
                      {candidate.machineTranslated ? <span className="badge warn">machine translated</span> : null}
                      {candidate.hearingImpaired ? <span className="badge neutral">SDH</span> : null}
                      {candidate.forced ? <span className="badge neutral">forced</span> : null}
                      {candidate.parts ? <span className="badge warn">{candidate.parts} parts</span> : null}
                    </div>
                    <div className="detail-text">
                      {candidate.release ?? candidate.fileName ?? 'no release named'}
                      {candidate.downloads !== undefined ? ` · ${candidate.downloads.toLocaleString()} downloads` : ''}
                      {candidate.uploader ? ` · ${candidate.uploader}` : ''}
                    </div>
                  </div>
                  <button disabled={!!busy} onClick={() => download(candidate)}>
                    Get it
                  </button>
                </div>
              ))}
            </div>
            <p className="section-hint">
              A subtitle that <strong>matches this file</strong> was uploaded for this exact encode and its timing is
              usually right to the frame. Anything else was matched by name, and its timing is worth checking.
            </p>
          </>
        ) : null}

        {/* ---------- the loaded subtitle ---------- */}
        {loaded ? (
          <>
            <h4 className="block-heading">Loaded</h4>
            <div className="muted">
              <strong>{loaded.cues.length.toLocaleString()} lines</strong> · {languageName(loaded.language)} ·{' '}
              covers {formatDuration(coverage)} of {formatDuration(duration)}
            </div>
            <div className="muted" style={{ marginTop: 2 }}>
              {loaded.origin}
              {loaded.retimed ? ' · retimed' : ''}
            </div>
            {short ? (
              <div className="banner" style={{ marginTop: 8, marginBottom: 0 }}>
                These lines stop well before the film does. That is usually a subtitle for one disc of a two-disc
                release, and no amount of shifting will fix the second half.
              </div>
            ) : null}

            <div className="subtitle-actions">
              <button disabled={!!busy} onClick={check}>
                {loaded.timing ? 'Check the timing again' : 'Check the timing'}
              </button>
              <button className="primary" disabled={!!busy} onClick={save}>
                {loaded.replaces !== undefined && !loaded.translatedFrom
                  ? `Replace track ${loaded.replaces} in the film`
                  : 'Add to the film as a track'}
              </button>
            </div>

            {loaded.timing ? (
              <div className="subtitle-timing">
                <div className="title">
                  <span className={`badge ${STATE_BADGE[loaded.timing.state]}`}>
                    {STATE_WORD[loaded.timing.state]}
                  </span>
                  <span className={`badge ${CONFIDENCE_BADGE[loaded.timing.confidence]}`}>
                    {loaded.timing.confidence} confidence
                  </span>
                </div>
                <div className="detail-text">{loaded.timing.summary}</div>
                {loaded.timing.state === 'offset' || loaded.timing.state === 'drifting' ? (
                  <button disabled={!!busy || loaded.retimed} onClick={applyTiming}>
                    {loaded.retimed ? 'Moved' : 'Move the lines to match'}
                  </button>
                ) : null}
              </div>
            ) : null}

            {/* ---------- translation ---------- */}
            <h4 className="block-heading">Translate</h4>
            <div className="subtitle-actions">
              <select value={target} onChange={(event) => setTarget(event.target.value)} disabled={!!busy}>
                {languageOptions()
                  .filter((option) => option.value !== 'und')
                  .map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
              </select>
              <button disabled={!!busy || normalizeLanguage(target) === loaded.language} onClick={translateIt}>
                Translate from {languageName(loaded.language)}
              </button>
              {settings.translationEngine === 'ollama' ? (
                <button className="ghost" disabled={!!busy} onClick={loadModels}>
                  What models are there?
                </button>
              ) : null}
            </div>
            {normalizeLanguage(target) === loaded.language ? (
              <p className="section-hint">That is the language it is already in.</p>
            ) : (
              <p className="section-hint">
                Goes to {settings.translationEngine === 'ollama' ? 'Ollama on this machine' : settings.translationEngine}
                {settings.subtitleTranslationModel ? ` · ${settings.subtitleTranslationModel}` : ''}. The timings are
                not touched, so a subtitle you have already put in step stays in step.
              </p>
            )}

            {models ? (
              <div className="subtitle-models">
                {models.map((model) => (
                  <button
                    key={model.id}
                    className={`ghost${settings.subtitleTranslationModel === model.id ? ' overridden' : ''}`}
                    onClick={() => void window.plexfixer.settings.update({ subtitleTranslationModel: model.id })}
                  >
                    {model.label ?? model.id}
                    {model.parameters ? ` · ${model.parameters}` : ''}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {/* ---------- what is going on ---------- */}
        {busy ? (
          <div className="subtitle-busy">
            <div className="detail-text">{busy.step}</div>
            <progress value={busy.fraction ?? undefined} max={1} />
            <button className="ghost" onClick={() => api.cancel(busy.opId)}>
              Stop
            </button>
          </div>
        ) : null}

        {problem ? (
          <div className="banner" style={{ marginTop: 12, marginBottom: 0 }}>
            <strong>{problem.problem}</strong>
            {problem.hint ? <div className="detail-text">{problem.hint}</div> : null}
          </div>
        ) : null}

        {note && !problem ? (
          <p className="section-hint" style={{ marginTop: 12 }}>
            {note}
          </p>
        ) : null}

        <div className="about-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
