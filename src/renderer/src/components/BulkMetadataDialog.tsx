/**
 * Looking up a whole selection, and reviewing the answers in one list.
 *
 * The order is deliberate: search everything first, show what it found, let
 * the person correct and re-run anything, and only then write. Nothing is
 * queued until Apply, so a lookup that returns nonsense costs a click rather
 * than a folder of wrongly titled files.
 *
 * Every row's search terms are editable, because the thing most often wrong
 * is not the answer but the question. A file name is a poor question, and for
 * an episode it is often missing the only part that matters.
 */

import React, { useEffect, useRef, useState } from 'react'
import type { AppSettings, MediaFile, MetadataEdit } from '@shared/types.js'
import {
  askFor,
  episodeProposal,
  isAskable,
  foundFrom,
  movieProposal,
  takenCount,
  unaskable,
  type AskedFor,
  type Proposal
} from '@shared/plex/bulk-metadata.js'
import {
  authHeader,
  detailsUrl,
  episodeUrl,
  parseDetails,
  parseEpisode,
  parseSearch,
  readCredential,
  searchUrl,
  type TmdbCredential,
  type TmdbEpisode,
  type TmdbKind,
  type TmdbMatch
} from '@shared/tmdb.js'

type Phase =
  | { state: 'searching'; done: number; total: number }
  | { state: 'reviewing' }
  | { state: 'applying'; done: number; total: number }
  | { state: 'failed'; message: string }

/** Gentle on a free API, and fast enough that nobody watches it. */
const AT_ONCE = 4

/** Run `work` over `items`, a few at a time, reporting as each finishes. */
async function eachInTurn<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
  onDone: (count: number) => void,
  cancelled: () => boolean
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let finished = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= items.length || cancelled()) return
      results[index] = await work(items[index])
      onDone(++finished)
    }
  }

  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, worker))
  return results
}

export default function BulkMetadataDialog({
  files,
  settings,
  onApply,
  onClose
}: {
  files: readonly MediaFile[]
  settings: AppSettings
  /** Queue one repair per file, writing the tags that were accepted. */
  onApply: (edits: { path: string; edit: MetadataEdit }[]) => void
  onClose: () => void
}): React.JSX.Element {
  const [kind, setKind] = useState<TmdbKind>('movie')
  const [phase, setPhase] = useState<Phase>({ state: 'searching', done: 0, total: files.length })
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [busyRows, setBusyRows] = useState<ReadonlySet<string>>(new Set())
  const cancelled = useRef(false)
  const closeButton = useRef<HTMLButtonElement>(null)

  /**
   * Series already found, by the name they were found under.
   *
   * A season of twenty-four episodes is one series and twenty-four episode
   * calls, not twenty-four identical series searches.
   */
  const seriesCache = useRef(new Map<string, TmdbMatch[]>())

  const credential = readCredential(settings.tmdbCredential)
  const byPath = useRef(new Map(files.map((file) => [file.path, file])))

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    closeButton.current?.focus({ preventScroll: true })
    return () => {
      cancelled.current = true
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const get = async (address: string): Promise<string> =>
    window.plexfixer.tmdb.get(address, authHeader(credential as TmdbCredential))

  /** The series behind a name, searched once and remembered. */
  async function seriesFor(show: string, year: string): Promise<TmdbMatch[]> {
    const key = `${show.trim().toLowerCase()}|${year.trim()}`
    const known = seriesCache.current.get(key)
    if (known) return known
    const body = await get(searchUrl(credential as TmdbCredential, 'tv', show.trim(), year.trim()))
    const found = parseSearch(body, 'tv')
    seriesCache.current.set(key, found)
    return found
  }

  /**
   * One row, asked and answered.
   *
   * The same function serves the opening sweep and a single row re-run by
   * hand, so a corrected question is answered exactly as the first one was.
   */
  async function lookUp(file: MediaFile, asked: AskedFor): Promise<Proposal> {
    if (!isAskable(asked)) return unaskable(file, asked)

    try {
      if (asked.kind === 'movie') {
        const body = await get(
          searchUrl(credential as TmdbCredential, 'movie', asked.query.trim(), asked.year.trim())
        )
        return movieProposal(file, asked, parseSearch(body, 'movie'))
      }

      const series = await seriesFor(asked.show, asked.year)
      const best = series[0]
      if (!best) return episodeProposal(file, asked, series, undefined)

      let episode: TmdbEpisode | undefined
      try {
        const body = await get(
          episodeUrl(credential as TmdbCredential, best.id, Number(asked.season), Number(asked.episode))
        )
        const read = parseEpisode(body)
        if (read) {
          episode = {
            series: best,
            season: Number(asked.season),
            number: Number(asked.episode),
            title: read.title,
            date: read.date,
            overview: read.overview
          }
        }
      } catch {
        // TMDB answers a missing episode with an error, which is an answer:
        // the series has no such episode. Said plainly by the proposal.
      }
      return episodeProposal(file, asked, series, episode)
    } catch (error) {
      // One file that could not be reached is not a reason to lose the
      // seventy-nine that could.
      return {
        ...unaskable(file, asked),
        problem: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /** Search for every file, then show what came back. */
  async function lookEverythingUp(searchKind: TmdbKind): Promise<void> {
    if (!credential) {
      setPhase({
        state: 'failed',
        message:
          'Nothing from themoviedb.org yet — paste your API key, or your read access token, into Settings → Metadata.'
      })
      return
    }

    seriesCache.current.clear()
    setPhase({ state: 'searching', done: 0, total: files.length })
    try {
      const found = await eachInTurn(
        files,
        (file) => lookUp(file, askFor(file, searchKind)),
        (done) => setPhase({ state: 'searching', done, total: files.length }),
        () => cancelled.current
      )
      if (cancelled.current) return
      setProposals(found)
      setPhase({ state: 'reviewing' })
    } catch (error) {
      setPhase({ state: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }

  useEffect(() => {
    void lookEverythingUp(kind)
    // Re-running on a change of kind is the point; `files` never changes
    // while this is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  const setRow = (path: string, patch: Partial<Proposal>): void => {
    setProposals((previous) => previous.map((row) => (row.path === path ? { ...row, ...patch } : row)))
  }

  /** Re-run one row against whatever its terms now say. */
  async function lookUpAgain(row: Proposal): Promise<void> {
    const file = byPath.current.get(row.path)
    if (!file || !credential) return
    setBusyRows((previous) => new Set(previous).add(row.path))
    // A corrected question deserves a fresh answer, not one remembered from
    // the name that was wrong.
    seriesCache.current.clear()
    const next = await lookUp(file, row.asked)
    if (!cancelled.current) {
      // Asking by hand is a decision, so a row that found something keeps it.
      setProposals((previous) =>
        previous.map((existing) =>
          existing.path === row.path ? { ...next, take: next.found ? true : false } : existing
        )
      )
    }
    setBusyRows((previous) => {
      const copy = new Set(previous)
      copy.delete(row.path)
      return copy
    })
  }

  /**
   * Fill in the genres, then queue the lot.
   *
   * A film's search gave a title, a date and a summary; the genres take a
   * second request. An episode has none of its own, so the series' are used.
   * Either way the genres are fetched only for the rows actually being
   * written, and a failure costs the genres rather than the row.
   */
  async function apply(): Promise<void> {
    const taking = proposals.filter((row) => row.take && row.found)
    if (taking.length === 0 || !credential) return

    setPhase({ state: 'applying', done: 0, total: taking.length })
    const edits = await eachInTurn(
      taking,
      async (row): Promise<{ path: string; edit: MetadataEdit }> => {
        const found = row.found as { id: number; tags: Record<string, string> }
        const tags = { ...found.tags }
        try {
          // For a film that is the film; for an episode it is the series,
          // which is where an episode's genres come from.
          const body = await get(detailsUrl(credential, row.asked.kind, found.id))
          const full = parseDetails(body, row.asked.kind)
          if (full?.genres?.length) tags.genre = full.genres.join(', ')
        } catch {
          /* genres are a nicety; the title and the date are already here */
        }
        return { path: row.path, edit: { tags, tracks: {} } }
      },
      (done) => setPhase({ state: 'applying', done, total: taking.length }),
      () => cancelled.current
    )
    if (cancelled.current) return
    onApply(edits.filter(Boolean))
  }

  const taken = takenCount(proposals)
  const answered = proposals.filter((row) => row.found)
  const allTaken = answered.length > 0 && answered.every((row) => row.take)
  const working = phase.state === 'searching' || phase.state === 'applying'

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="dialog bulk-metadata-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Look up metadata"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>Look up metadata</h2>
        <p className="block-note">
          {files.length} selected. Nothing is written until you press Apply, and only the ticked rows are written.
          Any row’s search terms can be corrected and run again.
        </p>

        <div className="metadata-search">
          <select
            value={kind}
            aria-label="Films or episodes"
            disabled={working}
            onChange={(event) => setKind(event.target.value as TmdbKind)}
          >
            <option value="movie">Films</option>
            <option value="tv">Episodes</option>
          </select>
          <span className="block-note">
            {kind === 'tv'
              ? 'Found by series, season and number — not by the episode’s title.'
              : 'Found by title and year.'}
          </span>
          <span className="spacer" />
          {phase.state === 'reviewing' && answered.length > 0 ? (
            <button
              className="ghost"
              onClick={() =>
                setProposals((previous) => previous.map((row) => ({ ...row, take: !allTaken && !!row.found })))
              }
            >
              {allTaken ? 'Untick all' : 'Tick all that matched'}
            </button>
          ) : null}
        </div>

        {phase.state === 'failed' ? <p className="metadata-problem">{phase.message}</p> : null}

        {phase.state === 'searching' ? (
          <p className="block-note">
            Searching… {phase.done} of {phase.total}
          </p>
        ) : null}

        {phase.state === 'applying' ? (
          <p className="block-note">
            Fetching genres… {phase.done} of {phase.total}
          </p>
        ) : null}

        {phase.state === 'reviewing' ? (
          <div className="bulk-metadata-rows">
            {proposals.map((row) => (
              <BulkRow
                key={row.path}
                row={row}
                busy={busyRows.has(row.path)}
                onChange={(patch) => setRow(row.path, patch)}
                onLookUp={() => void lookUpAgain(row)}
              />
            ))}
          </div>
        ) : null}

        <div className="about-actions">
          <span className="muted">
            {phase.state === 'reviewing' ? `${taken} of ${files.length} will be written` : ''}
          </span>
          <span className="spacer" />
          <button ref={closeButton} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={phase.state !== 'reviewing' || taken === 0} onClick={() => void apply()}>
            Apply to {taken} file{taken === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** One file: what was asked, what came back, and a way to ask again. */
function BulkRow({
  row,
  busy,
  onChange,
  onLookUp
}: {
  row: Proposal
  busy: boolean
  onChange: (patch: Partial<Proposal>) => void
  onLookUp: () => void
}): React.JSX.Element {
  const ask = (patch: Partial<AskedFor>): void =>
    onChange({ asked: { ...row.asked, ...patch } as AskedFor })

  return (
    <div className={`bulk-metadata-row${row.take ? ' taken' : ''}`}>
      <input
        type="checkbox"
        aria-label={`Write metadata to ${row.fileName}`}
        checked={row.take}
        disabled={!row.found}
        onChange={(event) => onChange({ take: event.target.checked })}
      />
      <div className="bulk-metadata-body">
        <div className="mono bulk-metadata-file">{row.fileName}</div>

        <div className="bulk-metadata-ask">
          {row.asked.kind === 'movie' ? (
            <>
              <input
                type="text"
                className="block-grow"
                aria-label={`Title to search for, for ${row.fileName}`}
                value={row.asked.query}
                placeholder="Title"
                onChange={(event) => ask({ query: event.target.value })}
              />
              <input
                type="text"
                className="metadata-year"
                aria-label={`Year to search for, for ${row.fileName}`}
                value={row.asked.year}
                placeholder="Year"
                onChange={(event) => ask({ year: event.target.value })}
              />
            </>
          ) : (
            <>
              <input
                type="text"
                className="block-grow"
                aria-label={`Series to search for, for ${row.fileName}`}
                value={row.asked.show}
                placeholder="Series"
                onChange={(event) => ask({ show: event.target.value })}
              />
              <input
                type="text"
                className="metadata-number"
                aria-label={`Season, for ${row.fileName}`}
                value={row.asked.season}
                placeholder="S"
                onChange={(event) => ask({ season: event.target.value })}
              />
              <input
                type="text"
                className="metadata-number"
                aria-label={`Episode, for ${row.fileName}`}
                value={row.asked.episode}
                placeholder="E"
                onChange={(event) => ask({ episode: event.target.value })}
              />
              <input
                type="text"
                className="metadata-year"
                aria-label={`Year the series began, for ${row.fileName}`}
                value={row.asked.year}
                placeholder="Year"
                onChange={(event) => ask({ year: event.target.value })}
              />
            </>
          )}
          <button disabled={busy} onClick={onLookUp}>
            {busy ? 'Looking…' : 'Look up'}
          </button>
        </div>

        {row.found && row.alternatives.length > 1 ? (
          <select
            className="bulk-metadata-found"
            aria-label={`Which film ${row.fileName} is`}
            value={String(row.found.id)}
            onChange={(event) => {
              const picked = row.alternatives.find((option) => String(option.id) === event.target.value)
              // Picking by hand is a decision, so the row ticks itself.
              if (picked) onChange({ found: foundFrom(picked), take: true })
            }}
          >
            {row.alternatives.map((option) => (
              <option key={option.id} value={String(option.id)}>
                {option.title}
                {option.year ? ` (${option.year})` : ''}
              </option>
            ))}
          </select>
        ) : row.found ? (
          <div className="bulk-metadata-found">{row.found.label}</div>
        ) : null}
        {row.problem ? <div className="bulk-metadata-warn">{row.problem}</div> : null}
        {row.found && row.confidence.level === 'check' ? (
          <div className="bulk-metadata-warn">Worth a look — {row.confidence.why}</div>
        ) : null}
      </div>
    </div>
  )
}
