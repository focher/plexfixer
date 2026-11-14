/**
 * Picking a folder on the machine that holds the files.
 *
 * The native file dialog can only see this machine, so remote mode needs its
 * own browser. It lists one directory at a time over SSH — a library folder
 * can hold thousands of files, and nothing here needs them all at once — and
 * the thing being chosen is the folder you are standing in, which is how a
 * scan is started everywhere else in the app.
 *
 * It opens in the default folder from Settings, or the account's home when
 * there is none. The folder on screen can be made the default from here, which
 * beats typing a remote path into Settings from memory.
 */

import { useCallback, useEffect, useState } from 'react'
import type { RemoteEntry, RemoteListing } from '@shared/types.js'
import { formatBytes } from '../format.js'

export default function RemoteBrowser({
  host,
  defaultPath,
  onScan,
  onSetDefault,
  onClose
}: {
  /** Shown in the title, so it is clear whose filesystem this is. */
  host: string
  /** The folder browsing opens in; blank means the account's home. */
  defaultPath: string
  onScan: (path: string) => void
  /** Remember this folder as the one to open in. */
  onSetDefault: (path: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [listing, setListing] = useState<RemoteListing>()
  const [loading, setLoading] = useState(true)
  const [typed, setTyped] = useState('')

  const load = useCallback(async (path?: string) => {
    setLoading(true)
    try {
      const next = await window.plexfixer.remote.list(path)
      setListing(next)
      setTyped(next.path)
    } catch (error) {
      setListing({ path: path ?? '/', entries: [], problem: error instanceof Error ? error.message : String(error) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const mediaCount = listing?.entries.filter((entry) => entry.isMedia).length ?? 0
  // Setting the default from here saves typing a path into Settings blind:
  // you are already standing in the folder you mean.
  const isDefault = !!listing && listing.path === defaultPath.trim()

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="dialog browser"
        role="dialog"
        aria-modal="true"
        aria-label={`Browse ${host}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>Browse {host}</h2>

        <div className="browser-path">
          <button
            onClick={() => void load(listing?.parent)}
            disabled={!listing?.parent || loading}
            title="Up one folder"
          >
            ↑
          </button>
          <input
            type="text"
            value={typed}
            spellCheck={false}
            aria-label="Path on the remote host"
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void load(typed)
            }}
          />
          <button onClick={() => void load(typed)} disabled={loading}>
            Go
          </button>
        </div>

        {listing?.problem ? <div className="banner error">{listing.problem}</div> : null}

        <div className="browser-list">
          {loading ? (
            <div className="empty">Listing…</div>
          ) : listing && listing.entries.length === 0 && !listing.problem ? (
            <div className="empty">Nothing in this folder.</div>
          ) : (
            listing?.entries.map((entry) => <Row key={entry.path} entry={entry} onOpen={() => void load(entry.path)} />)
          )}
        </div>

        <div className="browser-actions">
          <span className="muted">
            {mediaCount > 0
              ? `${mediaCount} media file${mediaCount === 1 ? '' : 's'} here`
              : 'Scanning a folder includes everything beneath it.'}
          </span>
          <span className="spacer" />
          <button
            className="ghost"
            disabled={!listing || loading || isDefault}
            title={
              isDefault
                ? 'Browsing already starts in this folder'
                : 'Open the browser in this folder from now on'
            }
            onClick={() => {
              if (listing) onSetDefault(listing.path)
            }}
          >
            {isDefault ? 'Starts here' : 'Start here next time'}
          </button>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!listing || loading}
            onClick={() => {
              if (listing) onScan(listing.path)
            }}
          >
            Scan this folder
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ entry, onOpen }: { entry: RemoteEntry; onOpen: () => void }): React.JSX.Element {
  if (entry.isDirectory) {
    return (
      <button className="browser-row folder" onClick={onOpen} title={entry.path}>
        <span className="icon" aria-hidden="true">
          ▸
        </span>
        <span className="browser-name">{entry.name}</span>
      </button>
    )
  }
  return (
    <div className={`browser-row${entry.isMedia ? ' media' : ''}`} title={entry.path}>
      <span className="icon" aria-hidden="true">
        {entry.isMedia ? '▪' : ''}
      </span>
      <span className="browser-name">{entry.name}</span>
      <span className="muted numeric">{entry.sizeBytes != null ? formatBytes(entry.sizeBytes) : ''}</span>
    </div>
  )
}
