/**
 * The question asked before a repair that re-encodes video.
 *
 * It replaces a `window.confirm` that said only what would happen, and it asks
 * the one thing that confirm could not: **where the repaired files go.** The
 * standing answer lives in Settings, and for most work that is right. A
 * re-encode is the one repair where it often is not — it takes hours, it is
 * not lossless, and the sensible thing is frequently to write it somewhere
 * with room, or somewhere it can be watched before it goes near the library.
 * Asking months earlier in Settings is the wrong moment; this is the right
 * one, and the choice lasts exactly as long as this run.
 *
 * A single file asks too. The row's Force transcode button used to start
 * hours of work with no question at all, and the destination it would have
 * used was whatever Settings happened to say.
 */

import { useEffect, useRef, useState } from 'react'
import type { AppSettings, OutputOverride, RepairMode } from '@shared/types.js'
import { MODE_LABEL } from '@shared/mode.js'
import { repairOutcomes, type RepairSummary } from '@shared/bulk.js'
import { describeDestination, destinationProblem, withOutput } from '@shared/plex/destination.js'
import { shortenPath } from '../format.js'

/** What the picker offers, in the order it offers it. */
type Choice = 'settings' | 'in-place' | 'sibling' | 'folder'

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** The standing setting, named the way the picker names the same thing. */
function settingsLabel(settings: AppSettings): string {
  switch (settings.outputPlacement) {
    case 'in-place':
      return 'replace each original'
    case 'output-dir':
      return settings.outputDirectory.trim().length > 0
        ? `into ${shortenPath(settings.outputDirectory, 2)}`
        : 'into a separate folder — not set'
    case 'sibling':
    default:
      return 'beside each original'
  }
}

export default function RepairDialog({
  summary,
  total,
  mode,
  settings,
  mayRename,
  onClose,
  onConfirm
}: {
  summary: RepairSummary
  total: number
  mode?: RepairMode
  settings: AppSettings
  /** Whether a naming pattern is set, which changes what "nothing to do" means. */
  mayRename: boolean
  onClose: () => void
  /** `undefined` means "whatever Settings says", unchanged. */
  onConfirm: (output?: OutputOverride) => void
}): React.JSX.Element {
  const [choice, setChoice] = useState<Choice>('settings')
  const [folder, setFolder] = useState('')
  const start = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    start.current?.focus()
  }, [])

  const override: OutputOverride | undefined =
    choice === 'settings'
      ? undefined
      : choice === 'folder'
        ? { placement: 'output-dir', directory: folder }
        : { placement: choice }

  const problem = override ? destinationProblem(override) : undefined
  // Described through the same function that describes the standing setting,
  // so the sentence under the picker cannot disagree with what will happen.
  const destination = describeDestination(withOutput(settings, override))

  const pickFolder = async (): Promise<void> => {
    const picked = await window.plexfixer.dialog.pickDirectory()
    if (picked) {
      setFolder(picked)
      setChoice('folder')
    }
  }

  const lines = repairOutcomes(summary, mayRename)

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="dialog repair-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Start repair"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>
          {mode ? MODE_LABEL[mode] : 'Repair'} {plural(total, 'file', 'files')}?
        </h2>

        <ul className="repair-outcomes">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        <h4 className="block-heading">Where the repaired files go</h4>
        <div className="repair-destination">
          <label>
            <input
              type="radio"
              name="destination"
              checked={choice === 'settings'}
              onChange={() => setChoice('settings')}
            />
            <span>
              As Settings says — {settingsLabel(settings)}
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="destination"
              checked={choice === 'sibling'}
              onChange={() => setChoice('sibling')}
            />
            <span>
              Beside each original, as <code>{`name${settings.outputSuffix}`}</code>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="destination"
              checked={choice === 'in-place'}
              onChange={() => setChoice('in-place')}
            />
            <span>Replace each original</span>
          </label>
          <label>
            <input
              type="radio"
              name="destination"
              checked={choice === 'folder'}
              onChange={() => setChoice('folder')}
            />
            <span>Into a folder chosen now</span>
          </label>
          <div className="control inline repair-folder">
            <input type="text" value={folder} readOnly placeholder="No folder chosen" />
            <button onClick={() => void pickFolder()}>Choose…</button>
          </div>
        </div>

        <p className="block-note">{problem ?? destination}</p>
        <p className="block-note">
          This run only. Settings is not changed.
        </p>

        <div className="about-actions">
          <span className="spacer" />
          <button ref={start} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={problem != null} onClick={() => onConfirm(override)}>
            Start
          </button>
        </div>
      </div>
    </div>
  )
}
