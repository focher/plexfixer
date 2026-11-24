import React, { useCallback, useEffect, useState } from 'react'

import {
  describeModelSize,
  modelOfPath,
  RECOMMENDED_MODEL,
  type InstalledModel,
  type WhisperModel
} from '@shared/subtitles/models.js'

/**
 * Fetching a Whisper model, which is the thing that stops people using local
 * transcription at all.
 *
 * The binary is easy — `brew install whisper.cpp`, or a zip from the project's
 * own releases. The model is not: nothing installs one, the file names say
 * nothing about what is in them, and the obvious choice is a three-gigabyte
 * download that transcribes a film slower than watching it. So this lists them
 * with what each is for, fetches the chosen one, and points Settings at the
 * result.
 *
 * Typing a path by hand still works and is still there. This is the path that
 * does not require already knowing where to look.
 */
export interface WhisperModelsProps {
  /** `whisperModelPath` as Settings currently has it. */
  modelPath: string
  /** Point Settings at a model; called with the path of a finished download. */
  onChoose: (path: string) => void
}

export default function WhisperModels({ modelPath, onChoose }: WhisperModelsProps): React.JSX.Element {
  const api = window.plexfixer.subtitles.whisper
  const [installed, setInstalled] = useState<InstalledModel[]>([])
  const [chosen, setChosen] = useState<string>(() => modelOfPath(modelPath)?.file ?? RECOMMENDED_MODEL)
  const [fetching, setFetching] = useState<string>()
  const [received, setReceived] = useState(0)
  const [problem, setProblem] = useState<string>()
  const [folder, setFolder] = useState<string>()

  const refresh = useCallback(async (): Promise<InstalledModel[]> => {
    const here = await api.installed()
    setInstalled(here)
    return here
  }, [api])

  useEffect(() => {
    void refresh()
    void api.directory().then(setFolder)
  }, [api, refresh])

  // Subscribed for as long as the panel is open rather than for as long as a
  // download is running: the first event arrives before an await started in a
  // click handler has come back.
  useEffect(() => api.onProgress((progress) => setReceived(progress.receivedBytes)), [api])

  const model = api.catalogue.find((entry) => entry.file === chosen)
  const here = installed.find((entry) => entry.file === chosen)
  const inUse = modelOfPath(modelPath)?.file

  const download = async (entry: WhisperModel): Promise<void> => {
    setProblem(undefined)
    setReceived(0)
    setFetching(entry.file)
    try {
      const outcome = await api.download(entry.file)
      if ('problem' in outcome) setProblem(outcome.problem)
      else if ('path' in outcome) {
        await refresh()
        onChoose(outcome.path)
      }
    } finally {
      setFetching(undefined)
      setReceived(0)
    }
  }

  const remove = async (file: string): Promise<void> => {
    await api.remove(file)
    const left = await refresh()
    // Settings pointing at a file that is no longer there is worse than
    // Settings pointing at nothing, so the path goes with it.
    if (modelOfPath(modelPath)?.file === file && !left.some((entry) => entry.file === file)) onChoose('')
  }

  return (
    <div className="whisper-models">
      <div className="whisper-models-row">
        <select
          value={chosen}
          disabled={fetching !== undefined}
          onChange={(event) => {
            setChosen(event.target.value)
            setProblem(undefined)
          }}
        >
          {api.catalogue.map((entry) => (
            <option key={entry.file} value={entry.file}>
              {entry.label} — {describeModelSize(entry.sizeBytes)}
              {installed.some((on) => on.file === entry.file) ? ' (here)' : ''}
            </option>
          ))}
        </select>

        {fetching === chosen ? (
          <button onClick={() => void api.cancel(chosen)}>Stop</button>
        ) : here ? (
          inUse === chosen ? (
            <button onClick={() => void remove(chosen)}>Remove</button>
          ) : (
            <button onClick={() => onChoose(here.path)}>Use this one</button>
          )
        ) : (
          <button
            className="primary"
            disabled={fetching !== undefined || !model}
            onClick={() => model && void download(model)}
          >
            Download
          </button>
        )}
      </div>

      {model ? (
        <p className="whisper-models-note">
          {model.summary} {model.multilingual ? 'Hears every language Whisper knows.' : 'English audio only.'}
        </p>
      ) : undefined}

      {fetching ? (
        <div className="whisper-models-progress">
          <progress value={received} max={api.catalogue.find((e) => e.file === fetching)?.sizeBytes ?? 1} />
          <span>
            {describeModelSize(received)} of{' '}
            {describeModelSize(api.catalogue.find((e) => e.file === fetching)?.sizeBytes ?? 0)}
          </span>
        </div>
      ) : undefined}

      {problem ? <p className="whisper-models-problem">{problem}</p> : undefined}

      <p className="whisper-models-note">
        {installed.length > 0
          ? `${installed.length} ${installed.length === 1 ? 'model is' : 'models are'} in ${folder ?? 'the app’s own folder'}. Checked against a published SHA-256 as it downloads; one that does not match is thrown away.`
          : 'Downloads go to the app’s own folder and are checked against a published SHA-256 as they arrive. A model you already have can be named below instead.'}
      </p>
    </div>
  )
}
