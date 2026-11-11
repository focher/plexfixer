import type { AppSettings, EnvironmentInfo } from '@shared/types.js'
import { languageOptions } from '@shared/languages.js'

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
  onChange: (patch: Partial<AppSettings>) => void
  onReset: () => void
  onPickDirectory: () => void
  onPickBinary: (name: 'ffmpeg' | 'ffprobe') => void
  onRefreshEnvironment: () => void
}

export default function SettingsPanel(props: SettingsPanelProps): React.JSX.Element {
  const { settings, environment } = props
  const set = props.onChange

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
