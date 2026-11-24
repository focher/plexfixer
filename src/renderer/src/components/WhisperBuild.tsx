import React, { useCallback, useEffect, useState } from 'react'

import {
  describeModelSize,
  describeWhisper,
  type InstalledBuild,
  type ResolvedWhisper,
  type WhisperBuild as Build
} from '@shared/subtitles/models.js'

/**
 * Installing whisper.cpp from inside the app.
 *
 * The model picker below this one is useless without a program to read the
 * model with, and getting that program was the step nobody could be expected
 * to complete: whisper.cpp's version tags carry no assets, the builds hang off
 * rolling `b####` tags, and the one worth having on a machine with an NVIDIA
 * card is a 736 MB zip among eleven others. So the choice here is between the
 * two that matter, and the app does the rest — download, check, unpack, and
 * point Settings at what came out.
 *
 * On macOS there is nothing to offer: upstream publishes an xcframework and no
 * command-line build. So this says so, gives the Homebrew line, and relies on
 * the resolver having already found one if it is there. That sentence belongs
 * to macOS alone, which is why the empty case asks for the wording rather than
 * assuming it — a Windows machine seeing the Homebrew line is a bug report.
 */
export interface WhisperBuildProps {
  /** `whisperPath` as Settings has it; empty means "whatever was found". */
  binaryPath: string
  onChoose: (path: string) => void
}

export default function WhisperBuild({ binaryPath, onChoose }: WhisperBuildProps): React.JSX.Element {
  const api = window.plexfixer.subtitles.whisper
  const [builds, setBuilds] = useState<Build[]>([])
  const [advice, setAdvice] = useState('')
  const [chosen, setChosen] = useState<string>()
  const [installed, setInstalled] = useState<InstalledBuild[]>([])
  const [resolved, setResolved] = useState<ResolvedWhisper>({ source: 'none' })
  const [working, setWorking] = useState<string>()
  const [stage, setStage] = useState<'downloading' | 'extracting' | 'done'>()
  const [received, setReceived] = useState(0)
  const [problem, setProblem] = useState<string>()

  const refresh = useCallback(async () => {
    setInstalled(await api.builtins())
    setResolved(await api.resolve())
  }, [api])

  useEffect(() => {
    void api.builds().then((found) => {
      setBuilds([...found])
      setChosen((current) => current ?? found[0]?.id)
    })
    void api.advice().then(setAdvice)
  }, [api])

  // `binaryPath` is in the deps because clearing it by hand should make the
  // panel say "found one on PATH" again rather than keep reporting Settings.
  useEffect(() => {
    void refresh()
  }, [refresh, binaryPath])

  useEffect(() => api.onInstallProgress((progress) => setReceived(progress.receivedBytes)), [api])
  useEffect(() => api.onInstallStage((update) => setStage(update.stage)), [api])

  const build = builds.find((entry) => entry.id === chosen)
  const here = build && installed.find((entry) => entry.name === build.asset.replace(/\.(zip|tar\.gz)$/, ''))

  const install = async (entry: Build): Promise<void> => {
    setProblem(undefined)
    setReceived(0)
    setStage('downloading')
    setWorking(entry.id)
    try {
      const outcome = await api.install(entry.id)
      if ('problem' in outcome) setProblem(outcome.problem)
      else if ('path' in outcome) {
        await refresh()
        onChoose(outcome.path)
      }
    } finally {
      setWorking(undefined)
      setStage(undefined)
      setReceived(0)
    }
  }

  const remove = async (entry: InstalledBuild): Promise<void> => {
    await api.removeBuild(entry.name)
    if (binaryPath === entry.path) onChoose('')
    await refresh()
  }

  return (
    <div className="whisper-models">
      <p className={resolved.path ? 'whisper-models-note' : 'whisper-models-problem'}>
        {describeWhisper(resolved)}
        {resolved.path ? ` ${resolved.path}` : ''}
      </p>

      {builds.length === 0 ? (
        <p className="whisper-models-note">{advice}</p>
      ) : (
        <>
          <div className="whisper-models-row">
            <select
              value={chosen ?? ''}
              disabled={working !== undefined}
              onChange={(event) => {
                setChosen(event.target.value)
                setProblem(undefined)
              }}
            >
              {builds.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label} — {describeModelSize(entry.sizeBytes)}
                  {installed.some((on) => on.name === entry.asset.replace(/\.(zip|tar\.gz)$/, '')) ? ' (installed)' : ''}
                </option>
              ))}
            </select>

            {working === chosen ? (
              <button onClick={() => chosen && void api.cancelInstall(chosen)} disabled={stage === 'extracting'}>
                Stop
              </button>
            ) : here ? (
              binaryPath === here.path ? (
                <button onClick={() => void remove(here)}>Remove</button>
              ) : (
                <button onClick={() => onChoose(here.path)}>Use this one</button>
              )
            ) : (
              <button
                className="primary"
                disabled={working !== undefined || !build}
                onClick={() => build && void install(build)}
              >
                Install
              </button>
            )}
          </div>

          {build ? (
            <p className="whisper-models-note">
              {build.summary} Unpacks to about {describeModelSize(build.installedBytes)} in the app’s own folder;
              nothing is installed system-wide.
            </p>
          ) : undefined}

          {working ? (
            <div className="whisper-models-progress">
              <progress
                value={stage === 'extracting' ? undefined : received}
                max={builds.find((entry) => entry.id === working)?.sizeBytes ?? 1}
              />
              <span>
                {stage === 'extracting'
                  ? 'Unpacking — this takes a minute on the CUDA build'
                  : `${describeModelSize(received)} of ${describeModelSize(
                      builds.find((entry) => entry.id === working)?.sizeBytes ?? 0
                    )}`}
              </span>
            </div>
          ) : undefined}

          {problem ? <p className="whisper-models-problem">{problem}</p> : undefined}
        </>
      )}
    </div>
  )
}
