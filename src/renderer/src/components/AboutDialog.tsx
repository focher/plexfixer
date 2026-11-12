/**
 * About: what is running, in enough detail to answer a bug report.
 *
 * The version alone is rarely the answer to "why does it behave differently on
 * your machine?" — the ffmpeg build and where it came from usually are, so
 * they are here beside it, and `Copy details` puts the lot on the clipboard.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AboutInfo, EnvironmentInfo } from '@shared/types.js'
import { PRODUCT_NAME, RELEASES_URL, aboutRows, buildAboutText, versionLine } from '@shared/about.js'

export default function AboutDialog({
  about,
  environment,
  onClose
}: {
  about?: AboutInfo
  environment?: EnvironmentInfo
  onClose: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const closeButton = useRef<HTMLButtonElement>(null)

  // Escape closes, as every other dialog on both platforms does. Bound to the
  // window rather than the panel so it works wherever focus happens to be.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    closeButton.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = useCallback(async () => {
    if (!about) return
    try {
      await navigator.clipboard.writeText(buildAboutText(about, environment))
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard can be refused; everything is on screen to select by hand.
      setCopied(false)
    }
  }, [about, environment])

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="dialog about"
        role="dialog"
        aria-modal="true"
        aria-label={`About ${PRODUCT_NAME}`}
        // The backdrop closes; a click that started inside the panel is not a
        // click on the backdrop, however far the mouse travelled.
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>{PRODUCT_NAME}</h2>
        {about ? (
          <>
            <div className="about-version">{versionLine(about)}</div>
            <dl className="about-rows">
              {aboutRows(about, environment).map((row) => (
                <React.Fragment key={row.label}>
                  <dt>{row.label}</dt>
                  <dd className={row.mono ? 'mono' : undefined}>{row.value}</dd>
                </React.Fragment>
              ))}
            </dl>
          </>
        ) : (
          <div className="muted">Reading version details…</div>
        )}

        <p className="muted about-note">
          MIT licensed. The bundled FFmpeg binaries are GPL builds, shipped as separate executables
          and run as subprocesses — see NOTICE.md in the repository.
        </p>

        <div className="about-actions">
          <a href={RELEASES_URL} target="_blank" rel="noreferrer">
            Releases
          </a>
          <span className="spacer" />
          <button onClick={() => void copy()} disabled={!about} title="Copy these details for a bug report">
            {copied ? 'Copied ✓' : 'Copy details'}
          </button>
          <button ref={closeButton} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
