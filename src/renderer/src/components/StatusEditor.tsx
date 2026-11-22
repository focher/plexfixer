import { useState } from 'react'
import type { AppSettings, FindingCode, PlanStrategy, RemedyClass, Severity } from '@shared/types.js'
import { DEFAULT_CATALOG, catalogFor, flagDef, resolveCatalog } from '@shared/plex/catalog/resolve.js'
import { resetSection } from '@shared/plex/catalog/edit.js'
import { REMEDY_LABEL, SEVERITY_LABEL, STRATEGY_LABEL, describeMatch } from '@shared/plex/catalog/describe.js'
import {
  FLAG_CATEGORY_LABEL,
  FLAG_CATEGORY_ORDER,
  type Catalog,
  type FlagCategory,
  type FlagSelector,
  type StatusDef,
  type StatusMatch,
  type StatusRule
} from '@shared/plex/catalog/types.js'

type OnChange = (patch: Partial<AppSettings>) => void

/* ------------------------------------------------------------------ *
 * Immutable list helpers
 * ------------------------------------------------------------------ */

const replaceAt = <T,>(list: readonly T[], at: number, value: T): T[] => list.map((item, i) => (i === at ? value : item))
const removeAt = <T,>(list: readonly T[], at: number): T[] => list.filter((_, i) => i !== at)
const move = <T,>(list: readonly T[], at: number, by: -1 | 1): T[] => {
  const to = at + by
  if (to < 0 || to >= list.length) return [...list]
  return list.map((item, i) => (i === at ? (list[to] as T) : i === to ? (list[at] as T) : item))
}
const toggled = <T,>(list: readonly T[] | undefined, value: T, on: boolean): T[] | undefined => {
  const next = on ? [...(list ?? []).filter((item) => item !== value), value] : (list ?? []).filter((item) => item !== value)
  return next.length > 0 ? next : undefined
}
/** An object without the keys whose value is undefined, so a cleared choice leaves the rule. */
const compact = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T

const TONES: { value: StatusDef['tone']; label: string }[] = [
  { value: 'ok', label: 'Green' },
  { value: 'info', label: 'Blue' },
  { value: 'warn', label: 'Amber' },
  { value: 'fail', label: 'Red' },
  { value: 'neutral', label: 'Grey' }
]

const SEVERITIES: Severity[] = ['info', 'warning', 'blocker']
const REMEDIES: RemedyClass[] = ['lossless', 'transcode', 'manual', 'none']
const STRATEGIES: PlanStrategy[] = ['none', 'remux', 'transcode-audio', 'transcode-video']

type Kind = 'any' | 'all' | 'none' | 'strategy' | 'always' | 'and' | 'or' | 'not'

const KIND_LABEL: Record<Kind, string> = {
  any: 'it has a flag that…',
  none: 'it has no flag that…',
  all: 'it has each of these flags…',
  strategy: 'the plan is…',
  always: 'always (everything else)',
  and: 'all of these hold',
  or: 'any of these holds',
  not: 'this does not hold'
}

const kindOf = (match: StatusMatch): Kind => Object.keys(match)[0] as Kind

/** A fresh condition of a kind, keeping the selectors when switching between any, all and none. */
function asKind(kind: Kind, from: StatusMatch): StatusMatch {
  const selectors: readonly FlagSelector[] =
    'any' in from ? from.any : 'all' in from ? from.all : 'none' in from ? from.none : [{}]
  switch (kind) {
    case 'any':
      return { any: selectors }
    case 'all':
      return { all: selectors }
    case 'none':
      return { none: selectors }
    case 'strategy':
      return { strategy: ['remux'] }
    case 'always':
      return { always: true }
    case 'and':
      return { and: [from] }
    case 'or':
      return { or: [from] }
    case 'not':
      return { not: from }
  }
}

/* ------------------------------------------------------------------ *
 * One selector: which flags count
 * ------------------------------------------------------------------ */

function Checks<T extends string>({
  options,
  label,
  chosen,
  onChange
}: {
  options: readonly T[]
  label: (value: T) => string
  chosen: readonly T[] | undefined
  onChange: (next: T[] | undefined) => void
}): React.JSX.Element {
  return (
    <span className="param-list">
      {options.map((option) => (
        <label key={option} className="param-inline">
          <input
            type="checkbox"
            checked={chosen?.includes(option) ?? false}
            onChange={(event) => onChange(toggled(chosen, option, event.target.checked))}
          />
          <span>{label(option)}</span>
        </label>
      ))}
    </span>
  )
}

function SelectorEditor({
  selector,
  catalog,
  onChange,
  onRemove
}: {
  selector: FlagSelector
  catalog: Catalog
  onChange: (next: FlagSelector) => void
  onRemove?: () => void
}): React.JSX.Element {
  const set = (patch: Partial<FlagSelector>): void => onChange(compact({ ...selector, ...patch }))
  const flags = Object.keys(catalog.flags) as FindingCode[]
  const chosenFlags: readonly FindingCode[] = selector.flag ?? []
  return (
    <div className="selector">
      <div className="selector-row">
        <span className="selector-label">Is one of</span>
        <span className="param-list">
          {chosenFlags.map((flag) => (
            <span key={flag} className="chip on">
              {flagDef(catalog, flag).label}
              <button
                className="chip-x"
                aria-label={`Remove ${flagDef(catalog, flag).label}`}
                onClick={() => set({ flag: toggled(selector.flag, flag, false) })}
              >
                ×
              </button>
            </span>
          ))}
          <select
            value=""
            onChange={(event) =>
              event.target.value && set({ flag: toggled(selector.flag, event.target.value as FindingCode, true) })
            }
          >
            <option value="">{chosenFlags.length === 0 ? 'any flag' : 'add a flag…'}</option>
            {FLAG_CATEGORY_ORDER.map((category) => {
              const inCategory = flags.filter((flag) => flagDef(catalog, flag).category === category && !chosenFlags.includes(flag))
              return inCategory.length > 0 ? (
                <optgroup key={category} label={FLAG_CATEGORY_LABEL[category]}>
                  {inCategory.map((flag) => (
                    <option key={flag} value={flag}>
                      {flagDef(catalog, flag).label}
                    </option>
                  ))}
                </optgroup>
              ) : null
            })}
          </select>
        </span>
      </div>
      <div className="selector-row">
        <span className="selector-label">In group</span>
        <Checks<FlagCategory>
          options={FLAG_CATEGORY_ORDER}
          label={(c) => FLAG_CATEGORY_LABEL[c]}
          chosen={selector.category}
          onChange={(category) => set({ category })}
        />
      </div>
      <div className="selector-row">
        <span className="selector-label">Severity</span>
        <Checks<Severity>
          options={SEVERITIES}
          label={(s) => SEVERITY_LABEL[s]}
          chosen={selector.severity}
          onChange={(severity) => set({ severity })}
        />
      </div>
      <div className="selector-row">
        <span className="selector-label">Remedy</span>
        <Checks<RemedyClass>
          options={REMEDIES}
          label={(r) => REMEDY_LABEL[r]}
          chosen={selector.remedy}
          onChange={(remedy) => set({ remedy })}
        />
      </div>
      <div className="selector-row">
        <span className="selector-label">Fixed?</span>
        <select
          value={selector.unresolved === undefined ? '' : selector.unresolved ? 'no' : 'yes'}
          onChange={(event) =>
            set({ unresolved: event.target.value === '' ? undefined : event.target.value === 'no' })
          }
        >
          <option value="">either way</option>
          <option value="no">only if the plan does not fix it</option>
          <option value="yes">only if the plan fixes it</option>
        </select>
        <span className="selector-label">Answered by</span>
        <select
          value={selector.repair === undefined ? '' : selector.repair[0] === null ? 'none' : 'some'}
          onChange={(event) =>
            set({ repair: event.target.value === '' ? undefined : event.target.value === 'none' ? [null] : undefined })
          }
        >
          <option value="">any repair, or none</option>
          <option value="none">nothing (report only)</option>
        </select>
        {onRemove ? (
          <>
            <span className="spacer" />
            <button className="ghost" onClick={onRemove}>
              Remove
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * One condition, which may hold others
 * ------------------------------------------------------------------ */

function ConditionEditor({
  match,
  catalog,
  onChange,
  depth = 0
}: {
  match: StatusMatch
  catalog: Catalog
  onChange: (next: StatusMatch) => void
  depth?: number
}): React.JSX.Element {
  const kind = kindOf(match)
  const kinds = (Object.keys(KIND_LABEL) as Kind[]).filter((k) => depth < 2 || !['and', 'or', 'not'].includes(k))

  const selectorList = (list: readonly FlagSelector[], wrap: (next: FlagSelector[]) => StatusMatch): React.JSX.Element => (
    <div className="condition-body">
      {list.map((selector, at) => (
        <SelectorEditor
          key={at}
          selector={selector}
          catalog={catalog}
          onChange={(next) => onChange(wrap(replaceAt(list, at, next)))}
          onRemove={list.length > 1 ? () => onChange(wrap(removeAt(list, at))) : undefined}
        />
      ))}
      <button className="ghost" onClick={() => onChange(wrap([...list, {}]))}>
        {kind === 'all' ? 'And another flag' : 'Or another kind of flag'}
      </button>
    </div>
  )

  const conditionList = (list: readonly StatusMatch[], wrap: (next: StatusMatch[]) => StatusMatch): React.JSX.Element => (
    <div className="condition-body nested">
      {list.map((inner, at) => (
        <div key={at} className="condition-nested-row">
          <ConditionEditor
            match={inner}
            catalog={catalog}
            depth={depth + 1}
            onChange={(next) => onChange(wrap(replaceAt(list, at, next)))}
          />
          {list.length > 1 ? (
            <button className="ghost" onClick={() => onChange(wrap(removeAt(list, at)))}>
              Remove
            </button>
          ) : null}
        </div>
      ))}
      <button className="ghost" onClick={() => onChange(wrap([...list, { any: [{}] }]))}>
        Add a condition
      </button>
    </div>
  )

  return (
    <div className="condition">
      <select value={kind} onChange={(event) => onChange(asKind(event.target.value as Kind, match))}>
        {kinds.map((k) => (
          <option key={k} value={k}>
            {KIND_LABEL[k]}
          </option>
        ))}
      </select>
      {'any' in match ? selectorList(match.any, (any) => ({ any })) : null}
      {'all' in match ? selectorList(match.all, (all) => ({ all })) : null}
      {'none' in match ? selectorList(match.none, (none) => ({ none })) : null}
      {'strategy' in match ? (
        <div className="condition-body">
          <Checks<PlanStrategy>
            options={STRATEGIES}
            label={(s) => STRATEGY_LABEL[s]}
            chosen={match.strategy}
            onChange={(strategy) => onChange({ strategy: strategy ?? [] })}
          />
        </div>
      ) : null}
      {'and' in match ? conditionList(match.and, (and) => ({ and })) : null}
      {'or' in match ? conditionList(match.or, (or) => ({ or })) : null}
      {'not' in match ? (
        <div className="condition-body nested">
          <ConditionEditor match={match.not} catalog={catalog} depth={depth + 1} onChange={(not) => onChange({ not })} />
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * The tiles and their rules
 * ------------------------------------------------------------------ */

const newId = (taken: readonly string[]): string =>
  [...Array(taken.length + 2).keys()].map((n) => `status-${n + 1}`).find((id) => !taken.includes(id)) ?? `status-${Date.now()}`

/**
 * The status tiles and the rules that put a file under one.
 *
 * Edited as a draft and saved together, because a tile and the rules that
 * name it have to agree: deleting a tile takes its rules with it, and nothing
 * is saved while the draft has a problem.
 */
export default function StatusEditor({
  settings,
  onChange
}: {
  settings: AppSettings
  onChange: OnChange
}): React.JSX.Element {
  const catalog = catalogFor(settings)
  const saved = { statuses: catalog.statuses, statusRules: catalog.statusRules }
  const [draft, setDraft] = useState<{ statuses: readonly StatusDef[]; statusRules: readonly StatusRule[] }>()
  const current = draft ?? saved

  const setStatuses = (statuses: readonly StatusDef[]): void => setDraft({ ...current, statuses })
  const setRules = (statusRules: readonly StatusRule[]): void => setDraft({ ...current, statusRules })

  const check = resolveCatalog(DEFAULT_CATALOG, {
    statuses: [...current.statuses],
    statusRules: [...current.statusRules]
  })
  const lastAlways = 'always' in (current.statusRules[current.statusRules.length - 1]?.when ?? {})
  const problems = [
    ...check.problems,
    ...(lastAlways ? [] : ['The last rule should be “always”, so every file gets a status.'])
  ]
  const changed = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(saved)

  const save = (): void => {
    if (problems.length > 0) return
    const shipped =
      JSON.stringify({ s: current.statuses, r: current.statusRules }) ===
      JSON.stringify({ s: DEFAULT_CATALOG.statuses, r: DEFAULT_CATALOG.statusRules })
    onChange({
      catalog: shipped
        ? resetSection(settings.catalog, 'statuses')
        : { ...settings.catalog, statuses: [...current.statuses], statusRules: [...current.statusRules] }
    })
    setDraft(undefined)
  }

  const label = (id: string): string => current.statuses.find((status) => status.id === id)?.label ?? id

  return (
    <div className="status-editor">
      <h4 className="modules-heading">Tiles</h4>
      <p className="section-hint">The summary tiles above the library, left to right. Each file is under exactly one.</p>
      <div className="status-tiles">
        {current.statuses.map((status, at) => {
          const set = (patch: Partial<StatusDef>): void => setStatuses(replaceAt(current.statuses, at, { ...status, ...patch }))
          return (
            <div className={`status-tile stat ${status.tone}`} key={status.id}>
              <div className="status-tile-fields">
                <label>
                  Name
                  <input type="text" value={status.label} onChange={(event) => set({ label: event.target.value })} />
                </label>
                <label>
                  In the table
                  <input type="text" value={status.badge} onChange={(event) => set({ badge: event.target.value })} />
                </label>
                <label>
                  Colour
                  <select value={status.tone} onChange={(event) => set({ tone: event.target.value as StatusDef['tone'] })}>
                    {TONES.map((tone) => (
                      <option key={tone.value} value={tone.value}>
                        {tone.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="wide">
                  Tooltip
                  <input type="text" value={status.hint} onChange={(event) => set({ hint: event.target.value })} />
                </label>
                <label className="param-inline">
                  <input type="checkbox" checked={status.passing} onChange={(event) => set({ passing: event.target.checked })} />
                  <span>Hidden by “Hide passed”</span>
                </label>
              </div>
              <div className="status-tile-actions">
                <button className="ghost" disabled={at === 0} onClick={() => setStatuses(move(current.statuses, at, -1))}>
                  ←
                </button>
                <button
                  className="ghost"
                  disabled={at === current.statuses.length - 1}
                  onClick={() => setStatuses(move(current.statuses, at, 1))}
                >
                  →
                </button>
                <button
                  className="ghost"
                  disabled={current.statuses.length === 1}
                  title="Deletes the tile and the rules that put files under it"
                  onClick={() =>
                    setDraft({
                      statuses: removeAt(current.statuses, at),
                      statusRules: current.statusRules.filter((rule) => rule.status !== status.id)
                    })
                  }
                >
                  Delete
                </button>
              </div>
            </div>
          )
        })}
      </div>
      <div className="modules-actions">
        <button
          className="ghost"
          onClick={() =>
            setStatuses([
              ...current.statuses,
              {
                id: newId(current.statuses.map((status) => status.id)),
                label: 'New tile',
                badge: 'new',
                hint: '',
                tone: 'neutral',
                passing: false
              }
            ])
          }
        >
          Add a tile
        </button>
      </div>

      <h4 className="modules-heading">Rules</h4>
      <p className="section-hint">
        Tried from the top. The first rule that holds for a file decides its tile, so put the most specific first and
        end with “always”.
      </p>
      <ol className="status-rules">
        {current.statusRules.map((rule, at) => (
          <li className="status-rule" key={at}>
            <div className="status-rule-head">
              <span>Put the file under</span>
              <select
                value={rule.status}
                onChange={(event) => setRules(replaceAt(current.statusRules, at, { ...rule, status: event.target.value }))}
              >
                {current.statuses.map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.label}
                  </option>
                ))}
              </select>
              <span>when</span>
              <span className="spacer" />
              <button className="ghost" disabled={at === 0} onClick={() => setRules(move(current.statusRules, at, -1))}>
                ↑
              </button>
              <button
                className="ghost"
                disabled={at === current.statusRules.length - 1}
                onClick={() => setRules(move(current.statusRules, at, 1))}
              >
                ↓
              </button>
              <button
                className="ghost"
                disabled={current.statusRules.length === 1}
                onClick={() => setRules(removeAt(current.statusRules, at))}
              >
                Delete
              </button>
            </div>
            <ConditionEditor
              match={rule.when}
              catalog={catalog}
              onChange={(when) => setRules(replaceAt(current.statusRules, at, { ...rule, when }))}
            />
            <p className="muted status-rule-says">
              {label(rule.status)} when {describeMatch(rule.when, catalog)}.
            </p>
          </li>
        ))}
      </ol>
      <div className="modules-actions">
        <button
          className="ghost"
          onClick={() =>
            setRules([
              { status: current.statuses[0]?.id ?? '', when: { any: [{}] } },
              ...current.statusRules
            ])
          }
        >
          Add a rule at the top
        </button>
      </div>

      {problems.length > 0 ? (
        <ul className="module-problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      <div className="modules-actions">
        <button disabled={!changed || problems.length > 0} onClick={save}>
          Save tiles and rules
        </button>
        <button className="ghost" disabled={!changed} onClick={() => setDraft(undefined)}>
          Discard changes
        </button>
        <span className="spacer" />
        <button
          className="ghost"
          disabled={settings.catalog.statuses === undefined && settings.catalog.statusRules === undefined && !draft}
          onClick={() => {
            onChange({ catalog: resetSection(settings.catalog, 'statuses') })
            setDraft(undefined)
          }}
        >
          Reset to the shipped tiles
        </button>
      </div>
    </div>
  )
}
