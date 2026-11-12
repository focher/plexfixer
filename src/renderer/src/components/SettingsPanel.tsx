import { useCallback, useState } from 'react'
import type { AppSettings, EnvironmentInfo, ModeOverrides, RemoteCheck, RepairMode } from '@shared/types.js'
import { languageOptions } from '@shared/languages.js'
import { MODE_LABEL, resolveMode } from '@shared/mode.js'
import { shortenPath } from '../format.js'

interface FieldProps {
  label: string
  hint?: string
  children: React.ReactNode
  inline?: boolean
}

function Field({ label, hint, children, inline }: FieldProps): React.JSX.Element {
  return (
    <div className="field">
      <label>
        {label}
        {hint ? <span className="hint">{hint}</span> : null}
      </label>
      <div className={`control${inline ? ' inline' : ''}`}>{children}</div>
    </div>
  )
}

function LanguageSelect({
  value,
  onChange
}: {
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {languageOptions().map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export interface SettingsPanelProps {
  settings: AppSettings
  environment?: EnvironmentInfo
  /** Per-file and per-folder mode overrides. */
  overrides: ModeOverrides
  onSetMode: (path: string, mode: RepairMode | null) => void
  /** Pick a folder and give it an override of its own. */
  onAddFolderOverride: () => void
  onChange: (patch: Partial<AppSettings>) => void
  onReset: () => void
  onPickDirectory: () => void
  onPickBinary: (name: 'ffmpeg' | 'ffprobe') => void
  onRefreshEnvironment: () => void
}

export default function SettingsPanel(props: SettingsPanelProps): React.JSX.Element {
  const { settings, environment } = props
  const set = props.onChange

  // Longest paths last would put a nested folder above its parent; sorting by
  // path keeps a folder and the entries inside it together.
  const overrideKeys = Object.keys(props.overrides).sort((a, b) => a.localeCompare(b))

  /** What a path would fall back to if its own override were removed. */
  const inheritedFor = (path: string): RepairMode => {
    const rest = { ...props.overrides }
    delete rest[path]
    return resolveMode(path, rest, settings.defaultMode).mode
  }

  const encoderOptions: { value: AppSettings['hardwareEncoder']; label: string; available: boolean }[] = [
    { value: 'auto', label: 'Automatic', available: true },
    { value: 'nvenc', label: 'NVIDIA NVENC', available: environment?.capabilities?.nvenc ?? false },
    { value: 'qsv', label: 'Intel Quick Sync', available: environment?.capabilities?.qsv ?? false },
    { value: 'amf', label: 'AMD AMF', available: environment?.capabilities?.amf ?? false },
    { value: 'videotoolbox', label: 'Apple VideoToolbox', available: environment?.capabilities?.videotoolbox ?? false },
    { value: 'none', label: 'CPU only (libx264/libx265)', available: true }
  ]

  return (
    <div className="settings">
      <section>
        <h3>Languages</h3>
        <p className="section-hint">
          These drive which audio and subtitle tracks are marked as default. PlexFixer treats the video track’s own
          language tag as the file’s primary language; when the video track has no tag, the preferred audio language
          below decides.
        </p>

        <Field label="Preferred audio language" hint="The default audio track should be in this language.">
          <LanguageSelect value={settings.preferredAudioLanguage} onChange={(value) => set({ preferredAudioLanguage: value })} />
        </Field>

        <Field label="Preferred subtitle language" hint="Used when subtitles need to come up automatically.">
          <LanguageSelect
            value={settings.preferredSubtitleLanguage}
            onChange={(value) => set({ preferredSubtitleLanguage: value })}
          />
        </Field>

        <Field
          label="Fallback audio language"
          hint="Used when no audio track matches the file’s primary language."
        >
          <LanguageSelect
            value={settings.fallbackAudioLanguages[0] ?? 'eng'}
            onChange={(value) => set({ fallbackAudioLanguages: [value] })}
          />
        </Field>

        <Field label="Treat untagged tracks as" hint="Written onto any track with no language tag.">
          <LanguageSelect value={settings.assumeUndefinedIs} onChange={(value) => set({ assumeUndefinedIs: value })} />
        </Field>

        <Field label="Forced subtitles" inline hint="Auto-show signs/songs subtitles when the audio already matches.">
          <input
            type="checkbox"
            checked={settings.preferForcedSubtitles}
            onChange={(event) => set({ preferForcedSubtitles: event.target.checked })}
          />
          <span className="muted">Default the forced track in the preferred language</span>
        </Field>

        <Field
          label="Foreign-language audio"
          inline
          hint="When the audio is not in your preferred subtitle language."
        >
          <input
            type="checkbox"
            checked={settings.defaultSubtitleWhenForeignAudio}
            onChange={(event) => set({ defaultSubtitleWhenForeignAudio: event.target.checked })}
          />
          <span className="muted">Default a full subtitle track</span>
        </Field>

        <Field label="Commentary tracks" inline>
          <input
            type="checkbox"
            checked={settings.avoidCommentaryAsDefault}
            onChange={(event) => set({ avoidCommentaryAsDefault: event.target.checked })}
          />
          <span className="muted">Never mark a commentary or audio-description track as default</span>
        </Field>
      </section>

      <section>
        <h3>Repair modes</h3>
        <p className="section-hint">
          What a repair is allowed to do. A folder listed below sets the mode for everything under it, and a file or a
          nested folder with its own entry wins over it — which is what lets a whole folder force-transcode while one
          episode inside it stays report-only. Individual files are easier to set from the library: open a row’s
          details.
        </p>

        <Field label="Default mode" hint="Used by any file with no setting of its own, and no overridden folder above it.">
          <select value={settings.defaultMode} onChange={(event) => set({ defaultMode: event.target.value as RepairMode })}>
            <option value="report">Report only — never write</option>
            <option value="safe-remux">Safe remux — lossless fixes, flag the rest</option>
            <option value="force-transcode">Force transcode — re-encode when needed</option>
          </select>
        </Field>


        {overrideKeys.length === 0 ? (
          <div className="muted" style={{ marginBottom: 12 }}>
            Nothing is overridden — every file repairs in <strong>{MODE_LABEL[settings.defaultMode]}</strong>.
          </div>
        ) : (
          <div className="overrides">
            {overrideKeys.map((path) => (
              <div className="override-row" key={path}>
                <code className="override-path" title={path}>
                  {shortenPath(path, 3)}
                </code>
                <select
                  value={props.overrides[path]}
                  onChange={(event) => props.onSetMode(path, event.target.value as RepairMode)}
                >
                  <option value="report">Report only</option>
                  <option value="safe-remux">Safe remux</option>
                  <option value="force-transcode">Force transcode</option>
                </select>
                <button
                  className="ghost"
                  onClick={() => props.onSetMode(path, null)}
                  title={`Remove this override — ${path} goes back to ${MODE_LABEL[inheritedFor(path)]}`}
                  aria-label={`Remove the override on ${path}`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <button onClick={props.onAddFolderOverride}>Add folder…</button>
        </div>
      </section>

      <section>
        <h3>Compatibility targets</h3>
        <p className="section-hint">
          What counts as “good enough to direct play”. The defaults assume a mixed client fleet including browsers and
          older streaming boxes.
        </p>

        <Field label="Target container">
          <select
            value={settings.targetContainer}
            onChange={(event) => set({ targetContainer: event.target.value as 'mp4' | 'mkv' })}
          >
            <option value="mp4">MP4 — direct plays on every client</option>
            <option value="mkv">MKV — keep the original container</option>
          </select>
        </Field>

        <Field label="MKV files" inline hint="MKV forces a Direct Stream remux on browsers and some TVs.">
          <input
            type="checkbox"
            checked={settings.remuxMkvToMp4}
            onChange={(event) => set({ remuxMkvToMp4: event.target.checked })}
          />
          <span className="muted">Rewrap to MP4 when the streams allow it</span>
        </Field>

        <Field label="HEVC / H.265" inline hint="Turn this off if any client is a browser or a streaming box older than about 2017.">
          <input
            type="checkbox"
            checked={settings.allowHevc}
            onChange={(event) => set({ allowHevc: event.target.checked })}
          />
          <span className="muted">Treat HEVC as compatible</span>
        </Field>

        <Field label="Maximum H.264 level" hint="Older Apple TVs, Rokus and smart TVs commonly cap at 4.1.">
          <select value={settings.maxH264Level} onChange={(event) => set({ maxH264Level: Number(event.target.value) })}>
            <option value={40}>Level 4.0</option>
            <option value={41}>Level 4.1</option>
            <option value={42}>Level 4.2</option>
            <option value={50}>Level 5.0</option>
            <option value={51}>Level 5.1</option>
            <option value={62}>Level 6.2 (no practical limit)</option>
          </select>
        </Field>

        <Field label="Maximum height" hint="Flag anything taller as likely to be downscaled server-side.">
          <select value={settings.maxHeight} onChange={(event) => set({ maxHeight: Number(event.target.value) })}>
            <option value={720}>720p</option>
            <option value={1080}>1080p</option>
            <option value={2160}>2160p (4K)</option>
            <option value={4320}>4320p (8K)</option>
          </select>
        </Field>

        <Field label="Audio" inline hint="Originals are kept; the new track is added alongside them.">
          <input
            type="checkbox"
            checked={settings.ensureAacStereo}
            onChange={(event) => set({ ensureAacStereo: event.target.checked })}
          />
          <span className="muted">Add an AAC track when nothing compatible exists</span>
        </Field>

        <Field label="Subtitles" inline hint="Sidecar SRT never triggers a burn-in transcode.">
          <input
            type="checkbox"
            checked={settings.extractTextSubtitles}
            onChange={(event) => set({ extractTextSubtitles: event.target.checked })}
          />
          <span className="muted">Extract text subtitles to .srt sidecars</span>
        </Field>

        <Field label="Image subtitles" inline hint="PGS/VobSub cannot be stored in MP4 at all.">
          <input
            type="checkbox"
            checked={settings.dropImageSubtitlesOnMp4}
            onChange={(event) => set({ dropImageSubtitlesOnMp4: event.target.checked })}
          />
          <span className="muted">Drop PGS/VobSub tracks when writing MP4</span>
        </Field>
      </section>

      <section>
        <h3>Output</h3>
        <p className="section-hint">Where repaired files go, and whether the originals are kept.</p>

        <Field label="Write repaired files">
          <select
            value={settings.outputPlacement}
            onChange={(event) => set({ outputPlacement: event.target.value as AppSettings['outputPlacement'] })}
          >
            <option value="sibling">Beside the original, with a suffix</option>
            <option value="in-place">Replace the original</option>
            <option value="output-dir">Into a separate folder</option>
          </select>
        </Field>

        {settings.outputPlacement === 'sibling' ? (
          <Field label="Filename suffix">
            <input
              type="text"
              value={settings.outputSuffix}
              onChange={(event) => set({ outputSuffix: event.target.value })}
            />
          </Field>
        ) : null}

        {settings.outputPlacement === 'output-dir' ? (
          <Field label="Output folder" hint="The source folder structure is mirrored inside it.">
            <div className="control inline">
              <input type="text" value={settings.outputDirectory} readOnly placeholder="Not set" />
              <button onClick={props.onPickDirectory}>Choose…</button>
            </div>
          </Field>
        ) : null}

        <Field
          label="Originals"
          inline
          hint={`Moved to a "${'.plexfixer-backups'}" folder beside the file rather than deleted.`}
        >
          <input
            type="checkbox"
            checked={settings.keepBackups}
            onChange={(event) => set({ keepBackups: event.target.checked })}
          />
          <span className="muted">Keep a backup when replacing a file</span>
        </Field>

        <Field label="Files at once" hint="Higher values saturate a slow disk or network share.">
          <input
            type="number"
            min={1}
            max={8}
            value={settings.concurrency}
            onChange={(event) => set({ concurrency: Math.max(1, Math.min(8, Number(event.target.value) || 1)) })}
          />
        </Field>

        <Field label="Scan subfolders" inline>
          <input
            type="checkbox"
            checked={settings.recursive}
            onChange={(event) => set({ recursive: event.target.checked })}
          />
          <span className="muted">Walk into subfolders when a folder is scanned</span>
        </Field>
      </section>

      <section>
        <h3>Transcoding</h3>
        <p className="section-hint">
          Only used when a file is set to Force transcode. Hardware encoders are verified with a real test encode at
          startup, so a build that merely advertises one will not be offered here.
        </p>

        <Field label="Hardware encoder">
          <select
            value={settings.hardwareEncoder}
            onChange={(event) => set({ hardwareEncoder: event.target.value as AppSettings['hardwareEncoder'] })}
          >
            {encoderOptions.map((option) => (
              <option key={option.value} value={option.value} disabled={!option.available}>
                {option.label}
                {option.available || option.value === 'auto' || option.value === 'none' ? '' : ' — not available here'}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Video codec" hint="H.264 plays everywhere; HEVC halves the file size on modern clients.">
          <select
            value={settings.transcodeVideoCodec}
            onChange={(event) => set({ transcodeVideoCodec: event.target.value as 'h264' | 'hevc' })}
          >
            <option value="h264">H.264</option>
            <option value="hevc">HEVC (Main 10)</option>
          </select>
        </Field>

        <Field label="Quality" hint="Lower is better quality and a larger file. 21 is a good default.">
          <input
            type="number"
            min={14}
            max={34}
            value={settings.videoQuality}
            onChange={(event) => set({ videoQuality: Math.max(14, Math.min(34, Number(event.target.value) || 21)) })}
          />
        </Field>

        <Field label="AAC bitrate per channel" hint="96 kbps per channel is transparent for most material.">
          <input
            type="number"
            min={48}
            max={256}
            step={16}
            value={settings.aacBitratePerChannel}
            onChange={(event) =>
              set({ aacBitratePerChannel: Math.max(48, Math.min(256, Number(event.target.value) || 96)) })
            }
          />
        </Field>
      </section>

      <RemoteSection settings={settings} environment={environment} onChange={set} />

      <section>
        <h3>FFmpeg</h3>
        <p className="section-hint">
          {environment?.ready
            ? environment.ffmpegVersion ?? 'Found and working.'
            : environment?.problem ?? 'Looking for ffmpeg…'}
        </p>

        <Field label="ffmpeg" hint="Leave blank to use the bundled copy, or whatever is on PATH.">
          <div className="control inline">
            <input
              type="text"
              value={settings.ffmpegPath}
              placeholder={environment?.ffmpegPath ?? 'not found'}
              onChange={(event) => set({ ffmpegPath: event.target.value })}
            />
            <button onClick={() => props.onPickBinary('ffmpeg')}>Choose…</button>
          </div>
        </Field>

        <Field label="ffprobe">
          <div className="control inline">
            <input
              type="text"
              value={settings.ffprobePath}
              placeholder={environment?.ffprobePath ?? 'not found'}
              onChange={(event) => set({ ffprobePath: event.target.value })}
            />
            <button onClick={() => props.onPickBinary('ffprobe')}>Choose…</button>
          </div>
        </Field>

        <Field label="Detected encoders">
          <div>
            <div className="muted mono">
              {environment?.capabilities?.available.length
                ? environment.capabilities.available.join(', ')
                : 'none detected — transcodes will use the CPU'}
            </div>
            <button style={{ marginTop: 8 }} onClick={props.onRefreshEnvironment}>
              Re-detect
            </button>
          </div>
        </Field>

        <Field label="File extensions" hint="Comma-separated. Only these are scanned.">
          <input
            type="text"
            value={settings.mediaExtensions.join(', ')}
            onChange={(event) =>
              set({
                mediaExtensions: event.target.value
                  .split(',')
                  .map((part) => part.trim().replace(/^\./, '').toLowerCase())
                  .filter(Boolean)
              })
            }
          />
        </Field>
      </section>

      <button onClick={props.onReset}>Reset all settings to defaults</button>
    </div>
  )
}

/**
 * Running the work on the machine that holds the files.
 *
 * The test button is the important part of this section: SSH has many ways to
 * not work, and each of them has a different fix. Rather than a red cross, the
 * check reports what answered — platform, both binaries with their versions,
 * and every utility the repair flow shells out to — so "it says no" is never
 * the whole message.
 */
function RemoteSection({
  settings,
  environment,
  onChange
}: {
  settings: AppSettings
  environment?: EnvironmentInfo
  onChange: (patch: Partial<AppSettings>) => void
}): React.JSX.Element {
  const [check, setCheck] = useState<RemoteCheck>()
  const [testing, setTesting] = useState(false)

  const test = useCallback(async () => {
    setTesting(true)
    try {
      setCheck(await window.plexfixer.remote.check())
    } catch (error) {
      setCheck({
        ok: false,
        host: settings.remoteHost,
        missing: [],
        found: [],
        problem: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setTesting(false)
    }
  }, [settings.remoteHost])

  return (
    <section>
      <h3>Remote host</h3>
      <p className="section-hint">
        Run ffprobe and ffmpeg on the machine that holds the files, over SSH. A remux copies every byte: across a
        mounted share that is two network trips per byte, and on the machine itself it is one local copy. PlexFixer
        uses your own <code>ssh</code>, so your keys, your <code>~/.ssh/config</code> and your known hosts apply — and
        it never asks for a password, so key-based login has to work on its own.
      </p>

      <Field label="Use a remote host" hint="Scans and repairs run there instead of here.">
        <label className={`toggle${settings.remoteEnabled ? ' on' : ''}`}>
          <input
            type="checkbox"
            checked={settings.remoteEnabled}
            disabled={!settings.remoteHost.trim()}
            onChange={(event) => onChange({ remoteEnabled: event.target.checked })}
          />
          <span className="switch" aria-hidden="true" />
          {settings.remoteEnabled ? `On — ${settings.remoteHost}` : 'Off — everything runs on this machine'}
        </label>
      </Field>

      <Field label="Host" hint="user@host, or a Host alias from your ssh config.">
        <div className="control inline">
          <input
            type="text"
            value={settings.remoteHost}
            placeholder="plex@nas.local"
            spellCheck={false}
            onChange={(event) => onChange({ remoteHost: event.target.value })}
          />
          <button onClick={() => void test()} disabled={testing || !settings.remoteHost.trim()}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        </div>
      </Field>

      <Field label="Port" hint="Leave at 0 to use whatever ssh would.">
        <input
          type="number"
          min={0}
          max={65535}
          value={settings.remotePort}
          onChange={(event) => onChange({ remotePort: Math.max(0, Math.min(65535, Number(event.target.value) || 0)) })}
        />
      </Field>

      <Field label="Remote ffmpeg" hint="Blank means whatever is on the remote PATH.">
        <input
          type="text"
          value={settings.remoteFfmpegPath}
          placeholder={check?.ffmpegPath ?? '/usr/bin/ffmpeg'}
          spellCheck={false}
          onChange={(event) => onChange({ remoteFfmpegPath: event.target.value })}
        />
      </Field>

      <Field label="Remote ffprobe">
        <input
          type="text"
          value={settings.remoteFfprobePath}
          placeholder={check?.ffprobePath ?? '/usr/bin/ffprobe'}
          spellCheck={false}
          onChange={(event) => onChange({ remoteFfprobePath: event.target.value })}
        />
      </Field>

      {check ? <CheckReport check={check} /> : null}

      {settings.remoteEnabled && environment?.remote ? (
        <p className="section-hint">
          Scans and repairs are running on <strong>{environment.remote.host}</strong>
          {environment.remote.platform ? ` (${environment.remote.platform})` : ''}. Editing an MP4 header in place is
          only done on this machine; a remote repair always rewrites the file.
        </p>
      ) : null}
    </section>
  )
}

function CheckReport({ check }: { check: RemoteCheck }): React.JSX.Element {
  return (
    <div className={`remote-check${check.ok ? ' ok' : ' bad'}`}>
      <div className="title">
        <span className={`badge ${check.ok ? 'ok' : 'fail'}`}>{check.ok ? 'ready' : 'not ready'}</span>
        {check.host}
        {check.platform ? <span className="muted"> · {check.platform}</span> : null}
      </div>
      {check.problem ? <div className="detail-text">{check.problem}</div> : null}
      {check.hint ? <div className="detail-text hint-line">{check.hint}</div> : null}
      {check.ffmpegVersion ? <div className="muted mono">{check.ffmpegVersion}</div> : null}
      {check.ffprobeVersion ? <div className="muted mono">{check.ffprobeVersion}</div> : null}
      {check.ffmpegPath ? (
        <div className="muted mono">
          {check.ffmpegPath} · {check.ffprobePath}
        </div>
      ) : null}
      {check.found.length > 0 ? (
        <div className="muted">
          utilities: {check.found.join(', ')}
          {check.missing.length > 0 ? ` — missing ${check.missing.join(', ')}` : ''}
        </div>
      ) : null}
    </div>
  )
}
