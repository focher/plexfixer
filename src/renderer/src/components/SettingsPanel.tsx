import { useCallback, useState } from 'react'
import type { AppSettings, EnvironmentInfo, ModeOverrides, RemoteCheck, RepairMode } from '@shared/types.js'
import { languageName, languageOptions } from '@shared/languages.js'
import { MODE_LABEL, resolveMode } from '@shared/mode.js'
import { RETENTION_CHOICES } from '@shared/backups.js'
import {
  SETTINGS_SECTIONS,
  sectionFrom,
  type SettingsSectionId
} from '@shared/settings-sections.js'
import { formatBytes, shortenPath } from '../format.js'
import { CHECK_MODULES, REPAIR_MODULES } from '@shared/plex/modules/registry.js'
import { isModuleEnabled, withModuleEnabled, type ModuleDescription, type ModuleSwitch } from '@shared/plex/modules/framework.js'
import { newUserModuleId, readUserModules } from '@shared/plex/modules/script/module.js'
import { readCredential } from '@shared/tmdb.js'
import { LLM_ENGINES, llmEngine, type LlmModel } from '@shared/subtitles/llm.js'
import { ASR_SERVICES, asrService } from '@shared/subtitles/asr.js'
import WhisperBuild from './WhisperBuild.js'
import WhisperModels from './WhisperModels.js'
import {
  SUGGESTED_EPISODE_TEMPLATES,
  SUGGESTED_MOVIE_TEMPLATES,
  TEMPLATE_TOKENS,
  explainProblem,
  nameFor
} from '@shared/plex/naming.js'
import { parseScript } from '@shared/plex/modules/script/parse.js'
import ModuleEditor, { NEW_RULE_TEMPLATE } from './ModuleEditor.js'

/** Where the chosen section is remembered between visits. */
const SECTION_KEY = 'plexfixer.settingsSection'

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

/**
 * Several languages, added and removed one at a time.
 *
 * Nothing here needed one of these before — the fallback audio language is a
 * list in the settings and a single picker on screen, which is a loose end of
 * its own. A subtitle search genuinely wants more than one: somebody watching
 * a Russian film will take English or Russian subtitles and would rather see
 * both offered than search twice.
 */
function LanguageList({
  value,
  onChange
}: {
  value: readonly string[]
  onChange: (languages: string[]) => void
}): React.JSX.Element {
  const unused = languageOptions().filter((option) => !value.includes(option.value))

  return (
    <div className="language-list">
      {value.map((language) => (
        <span className="chip" key={language}>
          {languageName(language)}
          <button
            className="ghost"
            aria-label={`Stop looking for ${languageName(language)} subtitles`}
            onClick={() => onChange(value.filter((entry) => entry !== language))}
          >
            ×
          </button>
        </span>
      ))}
      <select
        value=""
        onChange={(event) => {
          if (event.target.value) onChange([...value, event.target.value])
        }}
      >
        <option value="">Add a language…</option>
        {unused.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
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
  onPickBinary: (name: 'ffmpeg' | 'ffprobe' | 'whisper' | 'whisper-model') => void
  onRefreshEnvironment: () => void
  /** Find every backup under the library, confirm, and remove them. */
  onRemoveAllBackups: () => void
  /** A backup search or removal is under way. */
  removingBackups?: boolean
  /** False when there is no library to look in. */
  canRemoveBackups: boolean
  /**
   * Ask the translation endpoint what models it has.
   *
   * Through a prop rather than reached for directly, like everything else this
   * panel does to the machine: the panel decides what to show and the app
   * decides how to get it.
   */
  onDetectModels: () => Promise<LlmModel[] | { problem: string }>
}

export default function SettingsPanel(props: SettingsPanelProps): React.JSX.Element {
  // The chosen section is remembered: Settings is somewhere you come back to,
  // usually to the same place. A stored id from an older build, or one edited
  // by hand, names no section and falls back to the first rather than leaving
  // the pane empty.
  const [section, setSection] = useState<SettingsSectionId>(() => {
    try {
      return sectionFrom(localStorage.getItem(SECTION_KEY))
    } catch {
      return sectionFrom(undefined)
    }
  })

  const show = useCallback((id: SettingsSectionId): void => {
    setSection(id)
    try {
      localStorage.setItem(SECTION_KEY, id)
    } catch {
      /* a section that is not remembered is not worth an error */
    }
  }, [])

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-selected={entry.id === section}
            onClick={() => show(entry.id)}
          >
            <span className="nav-label">{entry.label}</span>
            <span className="nav-hint">{entry.hint}</span>
          </button>
        ))}
        <span className="nav-spacer" />
        <button className="ghost nav-reset danger" onClick={props.onReset}>
          Reset all settings to defaults
        </button>
      </nav>

      <div className="settings-pane">
        {section === 'languages' ? <LanguagesSection {...props} /> : null}
        {section === 'modes' ? <ModesSection {...props} /> : null}
        {section === 'compatibility' ? <CompatibilitySection {...props} /> : null}
        {section === 'modules' ? <ModulesSection {...props} /> : null}
        {section === 'metadata' ? <MetadataSection {...props} /> : null}
        {section === 'subtitles' ? <SubtitlesSection {...props} /> : null}
        {section === 'output' ? <OutputSection {...props} /> : null}
        {section === 'transcoding' ? <TranscodingSection {...props} /> : null}
        {section === 'remote' ? (
          <RemoteSection settings={props.settings} environment={props.environment} onChange={props.onChange} />
        ) : null}
        {section === 'ffmpeg' ? <FfmpegSection {...props} /> : null}
      </div>
    </div>
  )
}

/**
 * One rule, with its own switch and its own explanation.
 *
 * The explanation is folded away rather than left out: the list is only useful
 * as a list if you can run your eye down it, and the prose is only useful when
 * you have stopped on one and want to know what turning it off would cost.
 *
 * Not a `<details>`, though it looks like one. The switch has to sit inside the
 * row, and a checkbox inside a `<summary>` cannot both toggle the rule and
 * leave the fold alone: suppressing the fold also suppresses the browser's own
 * tick, and the box ends up showing the opposite of what it controls. A button
 * beside the switch does the folding instead, and each does exactly one thing.
 */
function ModuleRow({
  module,
  enabled,
  reports,
  onToggle,
  onEdit,
  onDelete,
  problems
}: {
  module: ModuleDescription
  enabled: boolean
  /** "Reports" for a check, "Fixes" for a repair — and what. */
  reports: { label: string; codes: readonly string[] }
  onToggle: (enabled: boolean) => void
  /** Only a rule the user wrote can be edited; a built-in one has nowhere to save to. */
  onEdit?: () => void
  onDelete?: () => void
  /** What is wrong with a hand-written rule, when something is. */
  problems?: { line: number; message: string }[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const bodyId = `${module.id}-body`
  const broken = (problems?.length ?? 0) > 0

  return (
    <div className={`module${enabled && !broken ? '' : ' off'}`}>
      <div className="module-head">
        <input
          type="checkbox"
          checked={enabled}
          disabled={broken}
          aria-label={`${module.title} — ${enabled ? 'on' : 'off'}`}
          title={broken ? 'A rule that will not run cannot be switched on' : undefined}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <button
          type="button"
          className="module-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((previous) => !previous)}
        >
          <span className="module-text">
            <span className="module-title">{module.title}</span>
            <span className="module-summary">{module.summary}</span>
          </span>
          {broken ? <span className="module-broken">Will not run</span> : null}
          <span className="module-state">{broken ? '' : enabled ? 'On' : 'Off'}</span>
          <span className="module-caret" aria-hidden="true">
            {open ? '▴' : '▾'}
          </span>
        </button>
        {onEdit ? (
          <button type="button" className="ghost module-action" onClick={onEdit}>
            Edit
          </button>
        ) : null}
        {onDelete ? (
          <button
            type="button"
            className="ghost module-action"
            onClick={() => {
              if (confirmingDelete) onDelete()
              else setConfirmingDelete(true)
            }}
            onBlur={() => setConfirmingDelete(false)}
          >
            {confirmingDelete ? 'Really delete?' : 'Delete'}
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="module-body" id={bodyId}>
          {broken ? (
            <>
              <h4>This rule is not running</h4>
              <ul className="module-problems">
                {problems?.map((problem, index) => (
                  <li key={`${problem.line}-${index}`}>
                    Line {problem.line}: {problem.message}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <h4>What it does</h4>
          <p>{module.whatItDoes}</p>
          <h4>How it works</h4>
          <p>{module.howItWorks}</p>
          <h4>If you turn it off</h4>
          <p>{module.ifDisabled}</p>
          {reports.codes.length > 0 ? (
            <p className="module-codes">
              <span className="module-codes-label">{reports.label}</span>
              {reports.codes.join(', ')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ModulesSection(props: SettingsPanelProps): React.JSX.Element {
  const { settings } = props
  const set = props.onChange

  // `undefined` means no editor is open; an entry with no id is a new rule.
  const [editing, setEditing] = useState<{ id?: string; script: string } | undefined>()

  const toggle = (module: ModuleSwitch, enabled: boolean): void => {
    set(withModuleEnabled(module, enabled, settings))
  }

  const userModules = readUserModules(settings)
  // Both kinds of "not running": switched off, and never switched on.
  const quiet = [...CHECK_MODULES, ...REPAIR_MODULES, ...userModules].filter(
    (module) => !isModuleEnabled(module, settings)
  )
  const offCount = quiet.length
  const total = CHECK_MODULES.length + REPAIR_MODULES.length + userModules.length

  const save = (script: string): void => {
    const list = [...settings.userModules]
    if (editing?.id) {
      const at = list.findIndex((record) => record.id === editing.id)
      // The id never changes with the script: it is what "switched off" is
      // remembered against, and renaming a rule should not switch it back on.
      if (at >= 0) list[at] = { ...list[at], script }
    } else {
      const name = parseScript(script).script?.name ?? 'rule'
      list.push({ id: newUserModuleId(name, list.map((record) => record.id)), script })
    }
    set({ userModules: list })
    setEditing(undefined)
  }

  const remove = (id: string): void => {
    set({
      userModules: settings.userModules.filter((record) => record.id !== id),
      // Nothing should be left behind pointing at a rule that is gone.
      disabledModules: settings.disabledModules.filter((entry) => entry !== id),
      enabledModules: settings.enabledModules.filter((entry) => entry !== id)
    })
  }

  return (
    <section>
      <h3>Checks &amp; repairs</h3>
      <p className="section-hint">
        Every rule the app knows, one at a time. A <strong>check</strong> looks for one thing that can be wrong with a
        file; a <strong>repair</strong> does one thing about it. Open any of them to read what it looks for, how it
        decides, and what you give up by switching it off. Switching a check off means it is never reported; switching
        a repair off means the problem is still reported, but listed as something the app will not fix.
      </p>

      <div className="modules-actions">
        <span className="muted">
          {offCount === 0 ? 'Everything is on.' : `${offCount} not running — ${total - offCount} still on.`}
        </span>
        <span className="spacer" />
        <button
          className="ghost"
          disabled={offCount === 0 && settings.enabledModules.length === 0}
          onClick={() => set({ disabledModules: [], enabledModules: [] })}
        >
          Put them all back
        </button>
      </div>

      <h4 className="modules-heading">Your own rules</h4>
      <p className="section-hint">
        Rules you write yourself, in a few lines each. They run after everything below and can report what they find
        and ask for a repair the app already has — they cannot invent a new way of writing a file.
      </p>
      {userModules.length > 0 ? (
        <div className="modules">
          {userModules.map((read) => (
            <ModuleRow
              key={read.id}
              module={
                read.module ?? {
                  id: read.id,
                  title: read.title,
                  summary: 'This rule has mistakes in it and is not running',
                  whatItDoes: 'Nothing, until the problems below are fixed.',
                  howItWorks: 'A rule that cannot be read is left out of the scan rather than guessed at.',
                  ifDisabled: 'It is already not running.'
                }
              }
              enabled={isModuleEnabled({ id: read.id }, settings) && read.problems.length === 0}
              problems={read.problems}
              reports={{ label: 'Reports', codes: read.module?.raises ?? [] }}
              onToggle={(enabled) => toggle({ id: read.id }, enabled)}
              onEdit={() => setEditing({ id: read.id, script: read.script })}
              onDelete={() => remove(read.id)}
            />
          ))}
        </div>
      ) : (
        <p className="muted modules-empty">You have not written any rules yet.</p>
      )}
      <div className="modules-actions">
        <button onClick={() => setEditing({ script: NEW_RULE_TEMPLATE })}>New rule</button>
      </div>

      <h4 className="modules-heading">Checks — what the app looks for</h4>
      <div className="modules">
        {CHECK_MODULES.map((module) => (
          <ModuleRow
            key={module.id}
            module={module}
            enabled={isModuleEnabled(module, settings)}
            reports={{ label: 'Reports', codes: module.raises }}
            onToggle={(enabled) => toggle(module, enabled)}
          />
        ))}
      </div>

      <h4 className="modules-heading">Repairs — what the app does about it</h4>
      <div className="modules">
        {REPAIR_MODULES.map((module) => (
          <ModuleRow
            key={module.id}
            module={module}
            enabled={isModuleEnabled(module, settings)}
            reports={{ label: 'Fixes', codes: module.answers }}
            onToggle={(enabled) => toggle(module, enabled)}
          />
        ))}
      </div>

      <p className="muted modules-footnote">
        The checks and repairs above ship with PlexFixer. They can be switched off, but not edited or deleted — they
        are part of the app rather than part of your settings, so there would be nowhere to keep a change to one.
      </p>

      {editing ? (
        <ModuleEditor
          initialScript={editing.script}
          isNew={editing.id === undefined}
          onSave={save}
          onCancel={() => setEditing(undefined)}
        />
      ) : null}
    </section>
  )
}

function MetadataSection(props: SettingsPanelProps): React.JSX.Element {
  const { settings } = props
  const set = props.onChange
  const credential = readCredential(settings.tmdbCredential)

  return (
    <section>
      <h3>Metadata</h3>
      <p className="section-hint">
        Changing what a file says about itself is done per file, from <strong>Edit metadata</strong> on any row.
        This is only the key that lets it look a title up.
      </p>

      <Field
        label="themoviedb.org"
        hint="Your own, not one shipped with PlexFixer. TMDB gives these away for the asking and asks that they not be passed around — which rules out putting one inside a program anybody can open."
      >
        <input
          type="password"
          value={settings.tmdbCredential}
          placeholder="API Key, or API Read Access Token"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => set({ tmdbCredential: event.target.value })}
        />
      </Field>

      <p className="section-hint">
        {credential === undefined
          ? 'Either of the two will do, and PlexFixer works out which you pasted. Without one, everything on the metadata screen still works — you just fill it in yourself.'
          : credential.kind === 'token'
            ? 'That is a read access token, and it is sent as a header rather than in the address. Searching sends the title you typed and nothing else about the file.'
            : 'That is an API key, and it is sent in the address. Searching sends the title you typed and nothing else about the file.'}
      </p>
      <p className="section-hint">
        Both are free, on <code>themoviedb.org</code> → your account → Settings → API, where they are listed as
        <strong> API Key</strong> and <strong>API Read Access Token</strong>. Either works; you do not need both.
        PlexFixer is not endorsed by or affiliated with TMDB.
      </p>
    </section>
  )
}

/**
 * Subtitles: finding them, timing them, and writing one from the audio.
 *
 * Four capabilities on one screen, and the screen's job is to make clear which
 * of them each field belongs to — because two of them want an API token and
 * they are not the same token, and the obvious assumption that one "AI
 * settings" block covers everything is exactly wrong. A speech endpoint and a
 * chat endpoint are different addresses at the same vendor, and the local
 * answers to the two are different programs.
 */
/**
 * The model to translate with, and a way to find out what there is.
 *
 * Typing a model name is guessing. A local Ollama knows exactly what it has
 * pulled, and the subtitle screen could already ask it — but only from the
 * subtitle screen, which is the wrong place to be configuring anything. So the
 * question is asked here, where the answer is used, and the field becomes a
 * list of what is actually installed.
 *
 * The text box stays. The endpoint may be down, a model may be pulled after
 * this was last asked, and a name typed by hand has to keep working.
 */
function ModelField({
  settings,
  defaultModel,
  onDetect,
  onChange
}: {
  settings: AppSettings
  defaultModel?: string
  onDetect: () => Promise<LlmModel[] | { problem: string }>
  onChange: (model: string) => void
}): React.JSX.Element {
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'looking' } | { kind: 'found'; models: LlmModel[] } | { kind: 'failed'; problem: string }
  >({ kind: 'idle' })

  const detect = (): void => {
    setState({ kind: 'looking' })
    void onDetect().then((answer) => {
      if ('problem' in answer) return setState({ kind: 'failed', problem: answer.problem })
      if (answer.length === 0) {
        return setState({
          kind: 'failed',
          problem: 'That endpoint answered, and has no models pulled. `ollama pull llama3.1` gives it one.'
        })
      }
      setState({ kind: 'found', models: answer })
      // Nothing chosen yet, so take the first rather than leaving a list up
      // with the box still empty.
      if (settings.subtitleTranslationModel.trim() === '') onChange(answer[0].id)
    })
  }

  return (
    <>
      <Field
        label="Model"
        hint={
          settings.translationEngine === 'ollama'
            ? 'Detect asks this Ollama what it has pulled.'
            : `Blank uses ${defaultModel ?? ''}.`
        }
      >
        <div className="model-field">
          {state.kind === 'found' ? (
            <select value={settings.subtitleTranslationModel} onChange={(event) => onChange(event.target.value)}>
              {/* A model named by hand that this endpoint does not have is
                  still shown, rather than silently becoming another one. */}
              {state.models.every((model) => model.id !== settings.subtitleTranslationModel) &&
              settings.subtitleTranslationModel.trim() !== '' ? (
                <option value={settings.subtitleTranslationModel}>
                  {settings.subtitleTranslationModel} (not on this endpoint)
                </option>
              ) : null}
              {state.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {describeModel(model)}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={settings.subtitleTranslationModel}
              placeholder={defaultModel}
              spellCheck={false}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
          <button onClick={detect} disabled={state.kind === 'looking'}>
            {state.kind === 'looking' ? 'Asking…' : 'Detect'}
          </button>
          {state.kind === 'found' ? (
            <button className="ghost" onClick={() => setState({ kind: 'idle' })} title="Type a model name instead">
              Type it
            </button>
          ) : null}
        </div>
      </Field>
      {state.kind === 'failed' ? <p className="section-hint problem">{state.problem}</p> : null}
      {state.kind === 'found' ? (
        <p className="section-hint">
          {state.models.length} model{state.models.length === 1 ? '' : 's'} on this endpoint.
        </p>
      ) : null}
    </>
  )
}

/** A model as a line: its name, and what is worth knowing about it. */
function describeModel(model: LlmModel): string {
  const bits = [model.label ?? model.id]
  if (model.parameters) bits.push(model.parameters)
  if (model.quantisation) bits.push(model.quantisation)
  if (model.sizeBytes) bits.push(formatBytes(model.sizeBytes))
  return bits.join(' · ')
}

function SubtitlesSection(props: SettingsPanelProps): React.JSX.Element {
  const { settings } = props
  const set = props.onChange
  const engine = llmEngine(settings.translationEngine)
  const local = settings.transcriptionEngine === 'whisper-local'
  const speech = asrService(settings.transcriptionEngine)

  return (
    <section>
      <h3>Subtitles</h3>
      <p className="section-hint">
        Everything here is done per file, from <strong>Subtitles</strong> on any row. This is where the services it
        talks to are set up.
      </p>

      <h4>Finding them</h4>
      <Field
        label="OpenSubtitles API key"
        hint="Your own, like the TMDB one and for the same reason: they give these away for the asking and ask that they not be passed around, which rules out shipping one inside a program anybody can open."
      >
        <input
          type="password"
          value={settings.openSubtitlesKey}
          placeholder="Api-Key from your consumer settings"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => set({ openSubtitlesKey: event.target.value })}
        />
      </Field>
      <Field label="Username" hint="Searching needs only the key. Downloading spends one of a daily allowance that belongs to an account, so it needs the account.">
        <input
          type="text"
          value={settings.openSubtitlesUsername}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => set({ openSubtitlesUsername: event.target.value })}
        />
      </Field>
      <Field label="Password">
        <input
          type="password"
          value={settings.openSubtitlesPassword}
          autoComplete="off"
          onChange={(event) => set({ openSubtitlesPassword: event.target.value })}
        />
      </Field>
      <p className="section-hint">
        Worth knowing before you type it: this goes into <code>settings.json</code> in the clear, like every other
        credential here, because PlexFixer has no keychain integration. It is an account for downloading subtitles,
        which is about the lowest-value password there is — and it is still a password. Leave it empty and
        everything else on this screen still works; only downloading needs it.
      </p>
      <Field label="Also look for" hint="Over and above your preferred subtitle language, which is always included.">
        <LanguageList
          value={settings.subtitleSearchLanguages}
          onChange={(languages) => set({ subtitleSearchLanguages: languages })}
        />
      </Field>

      <h4>Timing</h4>
      <Field
        label="Close enough, in milliseconds"
        hint="A subtitle inside this much of the speech is left alone. Past about a quarter of a second a person starts to notice; inside it, rewriting the file is churn."
      >
        <input
          type="number"
          min={0}
          max={2000}
          step={50}
          value={settings.subtitleSyncToleranceMs}
          onChange={(event) =>
            set({ subtitleSyncToleranceMs: Math.max(0, Math.min(2000, Number(event.target.value) || 250)) })
          }
        />
      </Field>

      <h4>Writing one from the audio</h4>
      <p className="section-hint">
        This is Whisper’s job, not a language model’s. Chat endpoints take text, and Ollama has no speech-to-text
        endpoint at all — so “local” here means a Whisper build on your own disk, and the hosted option is a speech
        endpoint, which is a different address from the chat endpoint below even at the same vendor.
      </p>
      <Field label="Transcribe with">
        <select
          value={settings.transcriptionEngine}
          onChange={(event) =>
            set({ transcriptionEngine: event.target.value as AppSettings['transcriptionEngine'] })
          }
        >
          <option value="whisper-local">Whisper, on this machine</option>
          {ASR_SERVICES.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
            </option>
          ))}
        </select>
      </Field>
      <p className="section-hint">{local ? 'Nothing leaves this machine, and there is nothing to pay for. It wants two files — whisper.cpp itself and a model — and PlexFixer will fetch both. It is slow in proportion to how good a model you give it, and much faster on a graphics card.' : speech?.summary}</p>

      {local ? (
        <>
          <Field label="Build" hint="whisper.cpp itself. PlexFixer will download and unpack one into its own folder — nothing is installed system-wide.">
            <WhisperBuild
              binaryPath={settings.whisperPath}
              onChoose={(path) => set({ whisperPath: path })}
            />
          </Field>
          <Field label="Whisper binary" hint="Where the chosen build is. Fill this in by hand to use a whisper-cli of your own; empty means whichever one PlexFixer found.">
            <input
              type="text"
              value={settings.whisperPath}
              placeholder="/usr/local/bin/whisper-cli"
              spellCheck={false}
              onChange={(event) => set({ whisperPath: event.target.value })}
            />
            <button onClick={() => props.onPickBinary('whisper')}>Choose…</button>
          </Field>
          <Field label="Model" hint="Nothing installs one of these, so PlexFixer will fetch it. The large models are markedly better at accents and at names, and markedly slower.">
            <WhisperModels
              modelPath={settings.whisperModelPath}
              onChoose={(path) => set({ whisperModelPath: path })}
            />
          </Field>
          <Field label="Model file" hint="Where the chosen model is. Fill this in by hand if you keep your models somewhere of your own.">
            <input
              type="text"
              value={settings.whisperModelPath}
              placeholder="ggml-large-v3-turbo-q5_0.bin"
              spellCheck={false}
              onChange={(event) => set({ whisperModelPath: event.target.value })}
            />
            <button onClick={() => props.onPickBinary('whisper-model')}>Choose…</button>
          </Field>
          <Field label="Threads" hint="0 lets Whisper decide, which is usually right.">
            <input
              type="number"
              min={0}
              max={64}
              value={settings.whisperThreads}
              onChange={(event) => set({ whisperThreads: Math.max(0, Math.min(64, Number(event.target.value) || 0)) })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="API token">
            <input
              type="password"
              value={settings.subtitleTranscriptionCredential}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set({ subtitleTranscriptionCredential: event.target.value })}
            />
          </Field>
          <Field label="Endpoint" hint={`Blank uses ${speech?.defaultEndpoint ?? 'the service’s own address'}. Whatever is here is an address PlexFixer will talk to, and the only way to add one.`}>
            <input
              type="text"
              value={settings.subtitleTranscriptionEndpoint}
              placeholder={speech?.defaultEndpoint}
              spellCheck={false}
              onChange={(event) => set({ subtitleTranscriptionEndpoint: event.target.value })}
            />
          </Field>
          <Field label="Model" hint={`Blank uses ${speech?.defaultModel ?? 'the service’s default'}.`}>
            <input
              type="text"
              value={settings.subtitleTranscriptionModel}
              placeholder={speech?.defaultModel}
              spellCheck={false}
              onChange={(event) => set({ subtitleTranscriptionModel: event.target.value })}
            />
          </Field>
          <Field
            label="Audio per upload, in minutes"
            hint="A film goes up in pieces, cut at a silence rather than on the clock. Ten minutes fits inside the 25 MB these endpoints accept with room to spare."
          >
            <input
              type="number"
              min={1}
              max={13}
              value={settings.transcriptionChunkMinutes}
              onChange={(event) =>
                set({ transcriptionChunkMinutes: Math.max(1, Math.min(13, Number(event.target.value) || 10)) })
              }
            />
          </Field>
          <p className="section-hint">
            A hosted endpoint has to be sent the audio, so this needs the film on this machine. With a remote host
            switched on, use a local Whisper instead.
          </p>
        </>
      )}

      <h4>Translating one</h4>
      <p className="section-hint">
        This is where a language model belongs, and it is genuinely good at it. Whisper can also translate to English
        by itself in one pass, without any of this — that choice is on the subtitle screen, per file, because the two
        produce different results and which is better depends on the film.
      </p>
      <Field label="Translate with">
        <select
          value={settings.translationEngine}
          onChange={(event) => set({ translationEngine: event.target.value as AppSettings['translationEngine'] })}
        >
          {LLM_ENGINES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </Field>
      <p className="section-hint">{engine?.summary}</p>
      {engine?.needsKey ? (
        <Field label="API token">
          <input
            type="password"
            value={settings.subtitleTranslationCredential}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => set({ subtitleTranslationCredential: event.target.value })}
          />
        </Field>
      ) : null}
      <Field
        label="Endpoint"
        hint={`Blank uses ${engine?.defaultEndpoint ?? ''}. Whatever is here is an address PlexFixer will talk to, and the only way to add one.`}
      >
        <input
          type="text"
          value={settings.subtitleTranslationEndpoint}
          placeholder={engine?.defaultEndpoint}
          spellCheck={false}
          onChange={(event) => set({ subtitleTranslationEndpoint: event.target.value })}
        />
      </Field>
      <ModelField
        settings={settings}
        defaultModel={engine?.defaultModel}
        onDetect={props.onDetectModels}
        onChange={(model) => set({ subtitleTranslationModel: model })}
      />
      <Field
        label="Lines per request"
        hint="Forty is about two minutes of film — long enough that a scene holds together in one request, which is what makes pronouns and register come out right, and short enough that a request to redo is cheap."
      >
        <input
          type="number"
          min={5}
          max={200}
          value={settings.translationBatchSize}
          onChange={(event) =>
            set({ translationBatchSize: Math.max(5, Math.min(200, Number(event.target.value) || 40)) })
          }
        />
      </Field>
    </section>
  )
}

function LanguagesSection(props: SettingsPanelProps): React.JSX.Element {
  const { settings } = props
  const set = props.onChange

  return (
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
  )
}

function ModesSection(props: SettingsPanelProps): React.JSX.Element {
  const { settings } = props
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

  return (
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
  )
}

function CompatibilitySection(props: SettingsPanelProps): React.JSX.Element {
  const { settings, environment } = props
  const set = props.onChange

  return (
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

      <Field
        label="Dolby Vision profile 5"
        hint="Profile 5 has no HDR10 base layer, so anything that cannot decode Dolby Vision shows it with skewed colours."
      >
        <select
          value={settings.dolbyVision5}
          onChange={(event) => set({ dolbyVision5: event.target.value as AppSettings['dolbyVision5'] })}
        >
          <option value="keep">Keep it — report it and leave the file alone</option>
          <option value="hdr10">Convert to HDR10 — re-encode, Dolby Vision is dropped</option>
        </select>
        {settings.dolbyVision5 === 'hdr10' && environment?.capabilities && !environment.capabilities.libplacebo ? (
          <span className="muted">
            This ffmpeg has no working libplacebo, so the conversion cannot run here. It needs a build with the
            filter and a Vulkan device for it to run on.
          </span>
        ) : null}
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

      <Field
        label="Subtitles"
        inline
        hint="Finding the speech reads the whole audio track, which adds twenty seconds to a minute to every repair — whether or not anything turns out to be out of step."
      >
        <input
          type="checkbox"
          checked={settings.resyncSubtitlesOnRepair}
          onChange={(event) => set({ resyncSubtitlesOnRepair: event.target.checked })}
        />
        <span className="muted">Check subtitle timing against the audio during a repair</span>
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
  )
}

/**
 * One naming pattern, with a worked example under it.
 *
 * A pattern is written blind otherwise: the fields are invented by this app,
 * the tags come out of the file, and nothing on screen would say which of the
 * two was wrong until a folder had been renamed. So the example is live, and
 * the second line is always a file that is *missing* something — because the
 * rule that matters is the one about what happens then.
 */
function TemplateField({
  label,
  hint,
  placeholder,
  value,
  presets,
  full,
  short,
  shortNote,
  onChange
}: {
  label: string
  hint: string
  placeholder: string
  value: string
  presets: readonly { template: string; label: string }[]
  /** A file with everything, for the first example. */
  full: Record<string, string>
  /** The same file missing one field, for the second. */
  short: Record<string, string>
  shortNote: string
  onChange: (template: string) => void
}): React.JSX.Element {
  const preview = nameFor(value, full, 'The.Source.Name.1080p')
  const lacking = nameFor(value, short, 'The.Source.Name.1080p')

  return (
    <Field label={label} hint={hint}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="template-presets">
        {presets.map((preset) => (
          <button key={preset.template} className="ghost" title={preset.label} onClick={() => onChange(preset.template)}>
            {preset.template}
          </button>
        ))}
        {value === '' ? null : (
          <button className="ghost" onClick={() => onChange('')}>
            Clear
          </button>
        )}
      </div>

      {value.trim() === '' ? null : (
        <div className="template-preview">
          {preview.problem ? (
            <p className="metadata-problem">{explainProblem(preview.problem)}</p>
          ) : (
            <>
              <p className="block-note">
                Written as <strong className="mono">{preview.stem}</strong>
              </p>
              <p className="block-note">
                {lacking.problem
                  ? `${shortNote} keeps the name it has.`
                  : `${shortNote} would be written as ${lacking.stem}`}
              </p>
            </>
          )}
        </div>
      )}
    </Field>
  )
}

/**
 * Both patterns, and the fields they may use.
 *
 * Two of them because the two kinds of file have never been named the same
 * way, and one pattern covering both would decline to use itself on half a
 * library — an episode has no release year and a film has no season.
 */
function FilenameTemplateField({
  settings,
  set
}: {
  settings: AppSettings
  set: (patch: Partial<AppSettings>) => void
}): React.JSX.Element {
  return (
    <>
      <TemplateField
        label="Name films"
        hint="Leave empty to keep the name each file already has."
        placeholder="{title} ({year})"
        value={settings.movieTemplate}
        presets={SUGGESTED_MOVIE_TEMPLATES}
        full={{ title: 'Casino Royale', date: '2006-11-14', genre: 'Action' }}
        short={{ title: 'Casino Royale' }}
        shortNote="The same film with no release date"
        onChange={(movieTemplate) => set({ movieTemplate })}
      />

      <TemplateField
        label="Name episodes"
        hint="Used for any file whose tags or name say which season and episode it is."
        placeholder="{show} - S{season}E{episode} - {title}"
        value={settings.episodeTemplate}
        presets={SUGGESTED_EPISODE_TEMPLATES}
        full={{
          title: 'Ozymandias',
          show: 'Breaking Bad',
          season_number: '5',
          episode_id: '14',
          date: '2013-09-15'
        }}
        short={{ show: 'Breaking Bad', season_number: '5', episode_id: '14' }}
        shortNote="The same episode with no name of its own"
        onChange={(episodeTemplate) => set({ episodeTemplate })}
      />

      {settings.movieTemplate.trim() === '' && settings.episodeTemplate.trim() === '' ? null : (
        <p className="section-hint">
          Fields: {TEMPLATE_TOKENS.map((token) => `{${token.key}}`).join(' ')} — a file missing any field you use
          keeps the name it has, so nothing is ever written as half a title.
        </p>
      )}
    </>
  )
}

function OutputSection(props: SettingsPanelProps): React.JSX.Element {
  const { settings } = props
  const set = props.onChange

  return (
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
        label="MP4 extension"
        hint="An .m4v file is an MP4 — Apple's name for one with video in it. Plex plays either."
      >
        <select
          value={settings.mp4Extension}
          onChange={(event) => set({ mp4Extension: event.target.value as AppSettings['mp4Extension'] })}
        >
          <option value="keep">Keep what the file has — .mp4 for anything else</option>
          <option value="mp4">Always .mp4</option>
          <option value="m4v">Always .m4v</option>
        </select>
      </Field>

      <FilenameTemplateField settings={settings} set={set} />

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

      <Field
        label="Delete backups after"
        hint="Long enough to notice a repair that went wrong. Backups are full-size copies, so they add up."
      >
        <select
          value={String(settings.backupRetentionDays)}
          disabled={!settings.keepBackups}
          onChange={(event) => set({ backupRetentionDays: Number(event.target.value) })}
        >
          {/* A value set by hand still shows, rather than reading as "Never". */}
          {RETENTION_CHOICES.some((choice) => choice.days === settings.backupRetentionDays) ? null : (
            <option value={String(settings.backupRetentionDays)}>{settings.backupRetentionDays} days</option>
          )}
          {RETENTION_CHOICES.map((choice) => (
            <option key={choice.days} value={String(choice.days)}>
              {choice.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Backups on disk" hint="Every backup folder under the scanned library, including old ones.">
        <button
          className="danger"
          onClick={props.onRemoveAllBackups}
          disabled={!props.canRemoveBackups || props.removingBackups}
        >
          {props.removingBackups ? 'Working…' : 'Remove all backups…'}
        </button>
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
  )
}

function TranscodingSection(props: SettingsPanelProps): React.JSX.Element {
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
  )
}

function FfmpegSection(props: SettingsPanelProps): React.JSX.Element {
  const { settings, environment } = props
  const set = props.onChange

  return (
    <section>
      <h3>FFmpeg</h3>
      <p className="section-hint">
        {environment?.ready
          ? environment.ffmpegVersion ?? 'Found and working.'
          : environment?.problem ?? 'Looking for ffmpeg…'}
      </p>
      {environment?.ready ? (
        <p className="section-hint">
          {environment.qtFaststartPath ? (
            <>
              qt-faststart: <span className="mono">{environment.qtFaststartPath}</span> — used when moving the MP4
              index is the whole repair, which takes one pass instead of two.
            </>
          ) : (
            'qt-faststart not found — files that only need their MP4 index moved are remuxed by ffmpeg instead.'
          )}
        </p>
      ) : null}

      {settings.remoteEnabled && environment?.remote ? (
        <p className="section-hint">
          These are the binaries on <strong>this</strong> machine. Scans and repairs are running on{' '}
          <strong>{environment.remote.host}</strong>, which has its own pair — set those under Remote host.
        </p>
      ) : null}

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
  const [trusting, setTrusting] = useState(false)

  const asFailure = useCallback(
    (error: unknown): RemoteCheck => ({
      ok: false,
      host: settings.remoteHost,
      missing: [],
      found: [],
      problem: error instanceof Error ? error.message : String(error)
    }),
    [settings.remoteHost]
  )

  const test = useCallback(async () => {
    setTesting(true)
    try {
      setCheck(await window.plexfixer.remote.check())
    } catch (error) {
      setCheck(asFailure(error))
    } finally {
      setTesting(false)
    }
  }, [asFailure])

  // Answering SSH's first-connection question: the key is recorded and the
  // connection tested again in one step, because the only reason to record it
  // is to get past this.
  const trust = useCallback(async () => {
    setTrusting(true)
    try {
      // The fingerprints on screen go with the request: what gets recorded is
      // the key that was looked at, not whatever answers a moment later.
      setCheck(await window.plexfixer.remote.trustHost(check?.fingerprints ?? []))
    } catch (error) {
      setCheck(asFailure(error))
    } finally {
      setTrusting(false)
    }
  }, [asFailure, check])

  return (
    <section>
      <h3>Remote host</h3>
      <p className="section-hint">
        Run ffprobe and ffmpeg on the machine that holds the files, over SSH. A remux copies every byte: across a
        mounted share that is two network trips per byte, and on the machine itself it is one local copy. PlexFixer
        uses your own <code>ssh</code>, so your keys, your <code>~/.ssh/config</code> and your known hosts apply — and
        it never asks for a password, so key-based login has to work on its own.
      </p>

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

      {settings.remoteHost.trim() ? (
        <>
          <Field label="Port" hint="Leave at 0 to use whatever ssh would.">
            <input
              type="number"
              min={0}
              max={65535}
              value={settings.remotePort}
              onChange={(event) => onChange({ remotePort: Math.max(0, Math.min(65535, Number(event.target.value) || 0)) })}
            />
          </Field>

          <Field
            label="Private key"
            hint="Blank uses your agent and ssh's usual identities, which is what most setups want."
          >
            <div className="control inline">
              <input
                type="text"
                value={settings.remoteKeyPath}
                placeholder="~/.ssh/id_ed25519"
                spellCheck={false}
                onChange={(event) => onChange({ remoteKeyPath: event.target.value })}
              />
              <button
                onClick={() => {
                  void (async () => {
                    const path = await window.plexfixer.remote.pickKeyFile()
                    if (path) onChange({ remoteKeyPath: path })
                  })()
                }}
              >
                Choose…
              </button>
              {settings.remoteKeyPath ? (
                <button className="ghost" onClick={() => onChange({ remoteKeyPath: '' })}>
                  Clear
                </button>
              ) : null}
            </div>
          </Field>

          <Field
            label="Default folder"
            hint="Where Browse opens. Blank starts in the account's home folder, which is rarely the library."
          >
            <input
              type="text"
              value={settings.remoteDefaultPath}
              placeholder="/mnt/media"
              spellCheck={false}
              onChange={(event) => onChange({ remoteDefaultPath: event.target.value })}
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
        </>
      ) : null}

      {check ? <CheckReport check={check} onTrust={() => void trust()} trusting={trusting} /> : null}

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

function CheckReport({
  check,
  onTrust,
  trusting
}: {
  check: RemoteCheck
  onTrust: () => void
  trusting: boolean
}): React.JSX.Element {
  return (
    <div className={`remote-check${check.ok ? ' ok' : ' bad'}`}>
      <div className="title">
        <span className={`badge ${check.ok ? 'ok' : check.hostKeyUnknown ? 'warn' : 'fail'}`}>
          {check.ok ? 'ready' : check.hostKeyUnknown ? 'new host' : 'not ready'}
        </span>
        {check.host}
        {check.platform ? <span className="muted"> · {check.platform}</span> : null}
      </div>
      {check.problem ? <div className="detail-text">{check.problem}</div> : null}
      {check.hint ? <div className="detail-text hint-line">{check.hint}</div> : null}

      {check.fingerprints && check.fingerprints.length > 0 ? (
        <div className="fingerprints">
          {check.fingerprints.map((key) => (
            <div key={key.fingerprint} className="mono">
              <span className="muted">{key.type}</span> {key.fingerprint}
            </div>
          ))}
        </div>
      ) : null}

      {check.hostKeyUnknown ? (
        <div>
          <button className="primary" onClick={onTrust} disabled={trusting} style={{ marginTop: 6 }}>
            {trusting ? 'Trusting…' : 'Trust this host'}
          </button>
          <div className="muted" style={{ marginTop: 6 }}>
            This writes the key above to <code>~/.ssh/known_hosts</code> — the same thing typing “yes” at an ssh prompt
            does. Only do it if the fingerprint matches the machine you mean.
          </div>
        </div>
      ) : null}
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
