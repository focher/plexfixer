/**
 * What's new: the release notes, once, on the first run of a new version.
 *
 * It opens by itself, which is a thing to be careful with — so it stays short,
 * closes on Escape or a click outside like every other dialog here, and never
 * comes back for a version it has already shown. An update that skipped a
 * release shows each one it skipped, newest first, rather than only the last.
 */

import React, { useEffect, useRef } from 'react'
import type { ReleaseNote } from '@shared/release-notes.js'
import { releaseUrl } from '@shared/release-notes.js'
import { PRODUCT_NAME } from '@shared/about.js'

export default function WhatsNewDialog({
  notes,
  onClose
}: {
  /** Newest first, and never empty — an empty list means nothing to show, so nothing is rendered. */
  notes: ReleaseNote[]
  onClose: () => void
}): React.JSX.Element | null {
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // Without preventScroll, focusing a button below the fold scrolls a long
    // set of notes to its end — so it opens at the bottom, on the oldest
    // release, rather than at the heading.
    closeButton.current?.focus({ preventScroll: true })
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (notes.length === 0) return null
  const newest = notes[0]

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="dialog whats-new"
        role="dialog"
        aria-modal="true"
        aria-label={`What's new in ${PRODUCT_NAME}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>
          What&rsquo;s new{notes.length === 1 ? ` in ${newest.version}` : ''}
        </h2>
        {notes.length === 1 ? (
          <div className="about-version">{newest.headline}</div>
        ) : (
          // Several releases at once: the headline belongs to its own version,
          // not to the screen.
          <div className="about-version">
            {`Everything since you last ran ${PRODUCT_NAME} — ${notes.length} releases.`}
          </div>
        )}

        {notes.map((note) => (
          <section className="release" key={note.version}>
            {notes.length > 1 ? (
              <>
                <h3>{note.version}</h3>
                <p className="muted release-headline">{note.headline}</p>
              </>
            ) : null}
            {note.changes.map((change) => (
              <div className="release-change" key={change.title}>
                <h4>{change.title}</h4>
                <p>{change.body}</p>
              </div>
            ))}
          </section>
        ))}

        <div className="about-actions">
          <a href={releaseUrl(newest.version)} target="_blank" rel="noreferrer">
            {notes.length === 1 ? 'Full notes' : `Full notes for ${newest.version}`}
          </a>
          <span className="spacer" />
          <button ref={closeButton} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
