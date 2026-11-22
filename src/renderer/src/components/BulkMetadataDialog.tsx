/**
 * Looking up a whole selection, and reviewing the answers in one list.
 *
 * The order is deliberate: search everything first, show what it found, let
 * the person untick and re-pick, and only then write. Nothing is queued until
 * Apply, so a lookup that returns nonsense costs a click rather than a folder
 * of wrongly titled files.
 *
 * Only the confident rows arrive ticked. Everything else sits there with the
 * reason beside it.
 */

import React, { useEffect, useRef, useState } from 'react'
import type { AppSettings, MediaFile, MetadataEdit } from '@shared/types.js'
import {
  proposalFrom,
  searchFor,
  takenCount,
  type Proposal
} from '@shared/plex/bulk-metadata.js'
import {
  authHeader,
  detailsUrl,
  parseDetails,
  parseSearch,
  readCredential,
  searchUrl,
  tagsFromMatch,
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
  const cancelled = useRef(false)
  const closeButton = useRef<HTMLButtonElement>(null)

  const credential = readCredential(settings.tmdbCredential)

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

    setPhase({ state: 'searching', done: 0, total: files.length })
    try {
      const found = await eachInTurn(
        files,
        async (file): Promise<Proposal> => {
          const asked = searchFor(file)
          if (asked.query.trim() === '') return proposalFrom(file, [])
          try {
            const body = await window.plexfixer.tmdb.get(
              searchUrl(credential, searchKind, asked.query, asked.year),
              authHeader(credential)
            )
            return proposalFrom(file, parseSearch(body, searchKind))
          } catch (error) {
            // One file that could not be reached is not a reason to lose the
            // seventy-nine that could.
            return {
              ...proposalFrom(file, []),
              problem: error instanceof Error ? error.message : String(error)
            }
          }
        },
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

  /**
   * Fill in the genres, then queue the lot.
   *
   * The search gave a title, a date and a summary; the genres take a second
   * request each. They are fetched only for the rows actually being written,
   * and a failure costs the genres rather than the row.
   */
  async function apply(): Promise<void> {
    const taking = proposals.filter((row) => row.take && row.match)
    if (taking.length === 0 || !credential) return

    setPhase({ state: 'applying', done: 0, total: taking.length })
    const edits = await eachInTurn(
      taking,
      async (row): Promise<{ path: string; edit: MetadataEdit }> => {
        const match = row.match as TmdbMatch
        let full = match
        try {
          const body = await window.plexfixer.tmdb.get(
            detailsUrl(credential, match.kind, match.id),
            authHeader(credential)
          )
          full = parseDetails(body, match.kind) ?? match
        } catch {
          /* genres are a nicety; the title and the date are already here */
        }
        return { path: row.path, edit: { tags: tagsFromMatch(full), tracks: {} } }
      },
      (done) => setPhase({ state: 'applying', done, total: taking.length }),
      () => cancelled.current
    )
    if (cancelled.current) return
    onApply(edits.filter(Boolean))
  }

  const taken = takenCount(proposals)
  const allTaken = proposals.filter((row) => row.match).every((row) => row.take)

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
          {files.length} selected. Each file name is searched on themoviedb.org. Nothing is written until you press
          Apply, and only the ticked rows are written.
        </p>

        <div className="metadata-search">
          <select
            value={kind}
            aria-label="Films or series"
            disabled={phase.state === 'searching' || phase.state === 'applying'}
            onChange={(event) => setKind(event.target.value as TmdbKind)}
          >
            <option value="movie">Films</option>
            <option value="tv">Series</option>
          </select>
          <span className="spacer" />
          {phase.state === 'reviewing' && proposals.some((row) => row.match) ? (
            <button
              className="ghost"
              onClick={() => setProposals((previous) => previous.map((row) => ({ ...row, take: !allTaken && !!row.match })))}
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
              <div className={`bulk-metadata-row${row.take ? ' taken' : ''}`} key={row.path}>
                <input
                  type="checkbox"
                  aria-label={`Write metadata to ${row.fileName}`}
                  checked={row.take}
                  disabled={!row.match}
                  onChange={(event) => setRow(row.path, { take: event.target.checked })}
                />
                <div className="bulk-metadata-body">
                  <div className="mono bulk-metadata-file">{row.fileName}</div>
                  {row.match ? (
                    <>
                      <div className="bulk-metadata-match">
                        <select
                          aria-label={`Which film ${row.fileName} is`}
                          value={String(row.match.id)}
                          onChange={(event) => {
                            const picked = row.alternatives.find((m) => String(m.id) === event.target.value)
                            // Picking by hand is a decision, so it counts as
                            // one: the row ticks itself.
                            if (picked) setRow(row.path, { match: picked, take: true })
                          }}
                        >
                          {row.alternatives.map((option) => (
                            <option key={option.id} value={String(option.id)}>
                              {option.title}
                              {option.year ? ` (${option.year})` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      {row.confidence.level === 'check' ? (
                        <div className="bulk-metadata-warn">Worth a look — {row.confidence.why}</div>
                      ) : null}
                    </>
                  ) : (
                    <div className="bulk-metadata-warn">{row.problem}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="about-actions">
          <span className="muted">
            {phase.state === 'reviewing'
              ? `${taken} of ${files.length} will be written`
              : ''}
          </span>
          <span className="spacer" />
          <button ref={closeButton} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={phase.state !== 'reviewing' || taken === 0}
            onClick={() => void apply()}
          >
            Apply to {taken} file{taken === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}
