/**
 * Changing what a file says about itself.
 *
 * The one screen in this app that takes an instruction instead of giving an
 * opinion. A viewer knows things the file does not say and the rules cannot
 * work out — which audio track they actually want, that a title is wrong, that
 * a track labelled English is really the director talking — and this is where
 * they say so.
 *
 * It behaves like every other repair: what you change is shown as a plan
 * before anything is written, costed, and queued. Nothing is saved while you
 * are typing, so there is no pending edit to go stale against a file that
 * changed underneath it.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AnalysisResult, AppSettings, MetadataEdit, TrackEdit } from '@shared/types.js'
import { EDITABLE_TAGS, changesAnything, episodeFieldsFor, isEmptyEdit, tagsOf } from '@shared/plex/metadata.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { languageOptions } from '@shared/languages.js'
import {
  authHeader,
  detailsUrl,
  episodeTags,
  episodeUrl,
  guessEpisode,
  guessTitle,
  parseDetails,
  parseEpisode,
  parseSearch,
  readCredential,
  searchUrl,
  tagsFromMatch,
  type TmdbKind,
  type TmdbMatch
} from '@shared/tmdb.js'

type Lookup = { state: 'idle' } | { state: 'looking' } | { state: 'failed'; message: string } | { state: 'found'; matches: TmdbMatch[] }

const KIND_LABEL: Record<TmdbKind, string> = { movie: 'Film', tv: 'Series' }

export default function MetadataDialog({
  result,
  settings,
  onApply,
  onClose
}: {
  result: AnalysisResult
  settings: AppSettings
  onApply: (edit: MetadataEdit) => void
  onClose: () => void
}): React.JSX.Element {
  const { file } = result
  const existing = useMemo(() => tagsOf(file), [file])
  const guess = useMemo(() => guessTitle(file.fileName), [file.fileName])
  const guessedEpisode = useMemo(() => guessEpisode(file.fileName), [file.fileName])

  const [tags, setTags] = useState<Record<string, string>>(() => ({ ...existing }))
  const [tracks, setTracks] = useState<Record<number, TrackEdit>>({})
  /*
   * What the file says comes before what its name suggests.
   *
   * These fields used to be seeded from the name alone. A file carrying
   * `episode_id=6` in its tags, whose name a pattern read differently, showed
   * the name's number — and since the lookup writes back whatever is in the
   * field, picking a series then overwrote the file's own correct tag with the
   * guess. The file stating something is evidence; its name is an inference,
   * and an inference must not quietly replace a statement.
   */
  const seed = useMemo(
    () => episodeFieldsFor(existing, guessedEpisode, guess.title, guess.year),
    [existing, guessedEpisode, guess]
  )
  const [kind, setKind] = useState<TmdbKind>(seed.isEpisode ? 'tv' : 'movie')
  const [query, setQuery] = useState(seed.show)
  const [year, setYear] = useState(seed.year)
  const [season, setSeason] = useState(seed.season)
  const [episodeNumber, setEpisodeNumber] = useState(seed.episode)
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' })
  // Folded away for a film, which is most files, and open from the start for
  // anything that already looks like an episode.
  const [showEpisodeFields, setShowEpisodeFields] = useState(() =>
    EDITABLE_TAGS.some((tag) => tag.forEpisodes && (existing[tag.key] ?? '') !== '')
  )
  const closeButton = useRef<HTMLButtonElement>(null)

  /*
   * Focus once, when this opens — and never again.
   *
   * This used to be one effect with the key listener, keyed on the callback
   * prop. Parents pass that as an inline arrow, so it is a new function on
   * every render of the parent, so the effect re-ran on every render of the
   * parent — and each run moved focus back here. Click into a field, the
   * parent renders for any reason at all, and the caret is gone: exactly the
   * "it switches to edit mode and immediately switches out" this caused.
   *
   * The listener still needs the current callback. The focus does not, so the
   * two are separate effects now and the focus runs on mount alone.
   */
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const edit: MetadataEdit = useMemo(() => ({ tags, tracks }), [tags, tracks])
  // The same analysis every other repair gets, so the cost and the actions on
  // screen are the ones that will actually happen.
  const preview = useMemo(() => analyzeFile(file, settings, edit), [file, settings, edit])
  const worthDoing = !isEmptyEdit(edit) && changesAnything(edit, file)

  const setTrack = (index: number, patch: TrackEdit): void => {
    setTracks((previous) => ({ ...previous, [index]: { ...previous[index], ...patch } }))
  }

  /** What a track will be, once the edit and the file are put together. */
  const valueFor = <K extends keyof TrackEdit>(index: number, key: K, fallback: TrackEdit[K]): TrackEdit[K] => {
    const set = tracks[index]?.[key]
    return set === undefined ? fallback : set
  }

  const credential = useMemo(() => readCredential(settings.tmdbCredential), [settings.tmdbCredential])

  async function lookItUp(): Promise<void> {
    if (!credential) {
      setLookup({
        state: 'failed',
        message: 'Nothing from themoviedb.org yet — paste your API key, or your read access token, into Settings → Metadata.'
      })
      return
    }
    setLookup({ state: 'looking' })
    try {
      const body = await window.plexfixer.tmdb.get(
        searchUrl(credential, kind, query.trim(), year.trim()),
        authHeader(credential)
      )
      const matches = parseSearch(body, kind)
      setLookup(
        matches.length > 0
          ? { state: 'found', matches }
          : { state: 'failed', message: `Nothing on themoviedb.org matched that${year.trim() ? ' in that year' : ''}.` }
      )
    } catch (error) {
      setLookup({ state: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const wantsEpisode = kind === 'tv' && /^\d+$/.test(season.trim()) && /^\d+$/.test(episodeNumber.trim())

  /**
   * Take a match, and fill in the genres it did not come with.
   *
   * With a season and an episode filled in, the series picked here is only
   * the way to the episode: what gets written is the episode's own name and
   * air date, with the series in its own field. Writing the series name as
   * the file's title would leave a season of files all called the same thing.
   */
  async function take(match: TmdbMatch): Promise<void> {
    if (!credential) return

    const genres = async (): Promise<string[] | undefined> => {
      try {
        const body = await window.plexfixer.tmdb.get(
          detailsUrl(credential, match.kind, match.id),
          authHeader(credential)
        )
        return parseDetails(body, match.kind)?.genres
      } catch {
        // The search already gave a title, a year and a summary. Losing the
        // genres is not a reason to refuse the rest of it.
        return undefined
      }
    }

    if (wantsEpisode) {
      try {
        const body = await window.plexfixer.tmdb.get(
          episodeUrl(credential, match.id, Number(season), Number(episodeNumber)),
          authHeader(credential)
        )
        const read = parseEpisode(body)
        if (!read) throw new Error('no such episode')
        const written = episodeTags({
          series: match,
          season: Number(season),
          number: Number(episodeNumber),
          title: read.title,
          date: read.date,
          overview: read.overview,
          genres: await genres()
        })
        setTags((previous) => ({ ...previous, ...written }))
        setLookup({ state: 'idle' })
      } catch {
        setLookup({
          state: 'failed',
          message: `“${match.title}” has no season ${season} episode ${episodeNumber}. Check the numbers, or clear them to write the series itself.`
        })
      }
      return
    }

    const found = await genres()
    setTags((previous) => ({ ...previous, ...tagsFromMatch(found ? { ...match, genres: found } : match) }))
    setLookup({ state: 'idle' })
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="dialog metadata-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Edit metadata"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>Metadata</h2>
        <div className="about-version mono">{file.fileName}</div>

        <div className="metadata-body">
          <section className="metadata-tags">
            <h4 className="block-heading">What the file says about itself</h4>
            {EDITABLE_TAGS.filter((tag) => !tag.forEpisodes || showEpisodeFields).map((tag) => (
              <label className="block-field" key={tag.key}>
                <span>
                  {tag.label} <span className="block-note">{tag.hint}</span>
                </span>
                {tag.key === 'description' ? (
                  <textarea
                    value={tags[tag.key] ?? ''}
                    onChange={(event) => setTags((p) => ({ ...p, [tag.key]: event.target.value }))}
                  />
                ) : (
                  <input
                    type="text"
                    value={tags[tag.key] ?? ''}
                    placeholder={existing[tag.key] ?? ''}
                    onChange={(event) => setTags((p) => ({ ...p, [tag.key]: event.target.value }))}
                  />
                )}
              </label>
            ))}
            {showEpisodeFields ? null : (
              <button className="ghost block-add" onClick={() => setShowEpisodeFields(true)}>
                This is an episode — show series, season and episode
              </button>
            )}
          </section>

          <section className="metadata-lookup">
            <h4 className="block-heading">Look it up on themoviedb.org</h4>
            <div className="metadata-search">
              <select
                value={kind}
                aria-label="Film or series"
                onChange={(event) => {
                  const next = event.target.value as TmdbKind
                  setKind(next)
                  if (next === 'tv') setShowEpisodeFields(true)
                }}
              >
                {(['movie', 'tv'] as TmdbKind[]).map((option) => (
                  <option key={option} value={option}>
                    {KIND_LABEL[option]}
                  </option>
                ))}
              </select>
              <input
                type="text"
                className="block-grow"
                aria-label="What to search for"
                value={query}
                placeholder={kind === 'tv' ? 'Breaking Bad' : 'Casino Royale'}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void lookItUp()
                }}
              />
              {kind === 'tv' ? (
                <>
                  <input
                    type="text"
                    className="metadata-number"
                    aria-label="Season"
                    value={season}
                    placeholder="S"
                    onChange={(event) => setSeason(event.target.value)}
                  />
                  <input
                    type="text"
                    className="metadata-number"
                    aria-label="Episode"
                    value={episodeNumber}
                    placeholder="E"
                    onChange={(event) => setEpisodeNumber(event.target.value)}
                  />
                </>
              ) : null}
              <input
                type="text"
                className="metadata-year"
                aria-label="Year"
                value={year}
                placeholder="Year"
                onChange={(event) => setYear(event.target.value)}
              />
              <button onClick={() => void lookItUp()} disabled={query.trim() === '' || lookup.state === 'looking'}>
                {lookup.state === 'looking' ? 'Looking…' : 'Search'}
              </button>
            </div>

            {lookup.state === 'failed' ? <p className="metadata-problem">{lookup.message}</p> : null}
            {lookup.state === 'found' ? (
              <ul className="metadata-matches">
                {lookup.matches.slice(0, 8).map((match) => (
                  <li key={`${match.kind}-${match.id}`}>
                    <button onClick={() => void take(match)}>
                      <span className="metadata-match-title">
                        {match.title} {match.year ? <span className="muted">({match.year})</span> : null}
                      </span>
                      <span className="metadata-match-overview">{match.overview || 'No summary.'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="block-note">
              {kind === 'tv'
                ? wantsEpisode
                  ? `Pick the series and this writes season ${season} episode ${episodeNumber} — its own name and air date, with the series in its own field.`
                  : 'Fill in a season and an episode to write that episode. Left empty, picking a series writes the series itself.'
                : null}
            </p>
            <p className="block-note">
              The title you searched for is sent to themoviedb.org. Nothing else about the file is.
            </p>
          </section>

          <section className="metadata-tracks">
            <h4 className="block-heading">Tracks</h4>
            <p className="block-note">
              Exactly one audio track, and at most one subtitle track, should play without being chosen.
            </p>
            <table className="metadata-track-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Track</th>
                  <th>Name</th>
                  <th>Language</th>
                  <th>Plays by default</th>
                  <th>Forced</th>
                </tr>
              </thead>
              <tbody>
                {file.streams
                  .filter((stream) => stream.kind === 'audio' || stream.kind === 'subtitle' || stream.kind === 'video')
                  .map((stream) => (
                    <tr key={stream.index}>
                      <td className="mono">{stream.index}</td>
                      <td>
                        {stream.kind} · <span className="mono">{stream.codec}</span>
                      </td>
                      <td>
                        <input
                          type="text"
                          aria-label={`Name of track ${stream.index}`}
                          value={valueFor(stream.index, 'title', stream.title ?? '') ?? ''}
                          onChange={(event) => setTrack(stream.index, { title: event.target.value })}
                        />
                      </td>
                      <td>
                        <select
                          aria-label={`Language of track ${stream.index}`}
                          value={valueFor(stream.index, 'language', stream.language) ?? ''}
                          onChange={(event) => setTrack(stream.index, { language: event.target.value })}
                        >
                          {languageOptions().map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Track ${stream.index} plays by default`}
                          checked={valueFor(stream.index, 'default', stream.disposition.default) ?? false}
                          onChange={(event) => setTrack(stream.index, { default: event.target.checked })}
                        />
                      </td>
                      <td>
                        {stream.kind === 'subtitle' ? (
                          <input
                            type="checkbox"
                            aria-label={`Track ${stream.index} is forced`}
                            checked={valueFor(stream.index, 'forced', stream.disposition.forced) ?? false}
                            onChange={(event) => setTrack(stream.index, { forced: event.target.checked })}
                          />
                        ) : null}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>

          <section className="metadata-preview">
            <h4 className="block-heading">What this will do</h4>
            {worthDoing ? (
              <>
                <ul>
                  {preview.plan.actions.map((action) => (
                    <li key={action.label}>{action.label}</li>
                  ))}
                </ul>
                <p className="block-note">{preview.plan.costNote}</p>
                {preview.plan.requiresTranscode ? (
                  <p className="metadata-problem">
                    This file also needs its video re-encoded, which a safe remux will not do — so it would be
                    skipped. Repair it with Force transcode first, then come back.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="block-note">
                Nothing yet. What is here matches what the file already says.
              </p>
            )}
          </section>
        </div>

        <div className="about-actions">
          <span className="spacer" />
          <button ref={closeButton} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!worthDoing} onClick={() => onApply(edit)}>
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}
