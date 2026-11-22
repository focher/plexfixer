import type { AppSettings, Severity } from '@shared/types.js'
import { DEFAULT_CATALOG, catalogFor, flagDef, isRuleCode } from '@shared/plex/catalog/resolve.js'
import { isChanged, resetEntry, setField, setParam } from '@shared/plex/catalog/edit.js'
import { FLAG_CATEGORY_LABEL, FLAG_CATEGORY_ORDER, type FlagCategory, type ParamValue } from '@shared/plex/catalog/types.js'
import type { ModuleDescription } from '@shared/plex/modules/framework.js'
import { paramsFor } from '@shared/plex/modules/module-params.js'
import type { ParamSpec } from '@shared/plex/modules/params.js'
import { moduleById } from '@shared/plex/modules/registry.js'
import { resolveParams } from '@shared/plex/modules/params.js'
import { isCheckScriptFlag, type ScriptInfo } from '@shared/plex/scripts/manifest.js'

type Section = 'checks' | 'repairs'
type OnChange = (patch: Partial<AppSettings>) => void

/** The control for one parameter, whatever kind it is. */
export function ParamControl({
  spec,
  value,
  onChange
}: {
  spec: ParamSpec
  value: ParamValue
  onChange: (value: ParamValue) => void
}): React.JSX.Element {
  switch (spec.type) {
    case 'boolean':
      return (
        <label className="param-inline">
          <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
          <span className="muted">{spec.label}</span>
        </label>
      )
    case 'number':
      return spec.options ? (
        <select value={Number(value)} onChange={(event) => onChange(Number(event.target.value))}>
          {spec.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="number"
          value={Number(value)}
          min={spec.min}
          max={spec.max}
          step={spec.step ?? 1}
          onChange={(event) => {
            const next = Number(event.target.value)
            if (Number.isFinite(next)) onChange(next)
          }}
        />
      )
    case 'string':
      return spec.options ? (
        <select value={String(value)} onChange={(event) => onChange(event.target.value)}>
          {spec.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input type="text" value={String(value)} onChange={(event) => onChange(event.target.value)} />
      )
    case 'list': {
      const items = Array.isArray(value) ? (value as readonly string[]) : []
      return spec.options ? (
        <span className="param-list">
          {spec.options.map((option) => (
            <label key={option.value} className="param-inline">
              <input
                type="checkbox"
                checked={items.includes(option.value)}
                onChange={(event) =>
                  onChange(
                    event.target.checked ? [...items, option.value] : items.filter((item) => item !== option.value)
                  )
                }
              />
              <span>{option.label}</span>
            </label>
          ))}
        </span>
      ) : (
        <input
          type="text"
          value={items.join(', ')}
          placeholder="comma, separated, values"
          onChange={(event) =>
            onChange(
              event.target.value
                .split(',')
                .map((item) => item.trim())
                .filter((item) => item.length > 0)
            )
          }
        />
      )
    }
  }
}

/** Which section a module's catalog entry is in. */
const sectionOf = (id: string): Section => (id in DEFAULT_CATALOG.repairs ? 'repairs' : 'checks')

/**
 * One parameter of one module, laid out as a settings field.
 *
 * For the Compatibility section, which shows the handful of parameters people
 * reach for most often beside the app-wide settings they sit with.
 */
export function ParamField({
  settings,
  moduleId,
  param,
  onChange,
  Field
}: {
  settings: AppSettings
  moduleId: string
  param: string
  onChange: OnChange
  Field: (props: { label: string; hint?: string; inline?: boolean; children: React.ReactNode }) => React.JSX.Element
}): React.JSX.Element | null {
  const module = moduleById(moduleId)
  const spec = module?.params?.[param]
  if (!module || !spec) return null
  const section = sectionOf(moduleId)
  const value = paramsFor(module, section, settings)[param] as ParamValue
  const set = (next: ParamValue): void => onChange({ catalog: setParam(settings.catalog, section, moduleId, param, next) })
  return (
    <Field label={spec.type === 'boolean' ? module.title : spec.label} hint={spec.help} inline={spec.type === 'boolean'}>
      <ParamControl spec={spec} value={value} onChange={set} />
    </Field>
  )
}

/** Every parameter of a module, for its row under Checks & repairs. */
export function ParamEditor({
  module,
  settings,
  onChange
}: {
  module: ModuleDescription
  settings: AppSettings
  onChange: OnChange
}): React.JSX.Element | null {
  const entries = Object.entries(module.params ?? {})
  if (entries.length === 0) return null
  const section = sectionOf(module.id)
  const values = paramsFor(module, section, settings)
  return (
    <div className="param-editor">
      <h4>Settings</h4>
      {entries.map(([key, spec]) => (
        <div className="param-row" key={key}>
          <span className="param-label">
            {spec.type === 'boolean' ? null : spec.label}
            {spec.help ? <span className="hint">{spec.help}</span> : null}
          </span>
          <ParamControl
            spec={spec}
            value={values[key] as ParamValue}
            onChange={(next) => onChange({ catalog: setParam(settings.catalog, section, module.id, key, next) })}
          />
        </div>
      ))}
    </div>
  )
}

const SEVERITY_LABEL: Record<Severity, string> = { info: 'Info', warning: 'Warning', blocker: 'Blocker' }

/**
 * What a check's flags are called, whether they are kept, and what answers them.
 *
 * A flag can be answered by the repair it shipped with or by nothing at all —
 * a built-in repair works from what its own check found, so pointing a flag
 * at a different one would promise a fix that does not happen.
 */
export function FlagEditor({
  flags,
  settings,
  scripts = [],
  onChange
}: {
  flags: readonly string[]
  settings: AppSettings
  /** Repair scripts a flag can be bound to instead. */
  scripts?: readonly ScriptInfo[]
  onChange: OnChange
}): React.JSX.Element | null {
  const catalog = catalogFor(settings)
  const known = flags.filter((flag) => flag in catalog.flags || isRuleCode(flag) || isCheckScriptFlag(flag))
  if (known.length === 0) return null
  const patch = settings.catalog
  const set = <K extends keyof ReturnType<typeof flagDef>>(flag: string, field: K, value: ReturnType<typeof flagDef>[K]): void =>
    onChange({ catalog: setField(patch, 'flags', flag, field, value) })

  return (
    <div className="flag-editor">
      <h4>Flags it raises</h4>
      {known.map((flag) => {
        const def = flagDef(catalog, flag)
        const shippedRepair = DEFAULT_CATALOG.flags[flag]?.repair ?? null
        const repairTitle = shippedRepair ? (moduleById(shippedRepair)?.title ?? shippedRepair) : undefined
        return (
          <div className={`flag-row${def.keep ? '' : ' off'}`} key={flag}>
            <div className="flag-row-head">
              <label className="param-inline" title="Off: the check still runs, but this flag is discarded">
                <input type="checkbox" checked={def.keep} onChange={(event) => set(flag, 'keep', event.target.checked)} />
                <span className="mono">{flag}</span>
              </label>
              <span className="spacer" />
              {isChanged(patch, 'flags', flag) ? (
                <button className="ghost" onClick={() => onChange({ catalog: resetEntry(patch, 'flags', flag) })}>
                  Reset
                </button>
              ) : null}
            </div>
            {def.keep ? (
              <div className="flag-row-body">
                <label>
                  Chip
                  <input type="text" value={def.label} onChange={(event) => set(flag, 'label', event.target.value)} />
                </label>
                <label>
                  Tooltip
                  <input type="text" value={def.hint} onChange={(event) => set(flag, 'hint', event.target.value)} />
                </label>
                <label>
                  Group
                  <select
                    value={def.category}
                    onChange={(event) => set(flag, 'category', event.target.value as FlagCategory)}
                  >
                    {FLAG_CATEGORY_ORDER.map((category) => (
                      <option key={category} value={category}>
                        {FLAG_CATEGORY_LABEL[category]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Severity
                  <select
                    value={def.severity ?? ''}
                    onChange={(event) =>
                      set(flag, 'severity', event.target.value === '' ? null : (event.target.value as Severity))
                    }
                  >
                    <option value="">As the check decides</option>
                    {(Object.keys(SEVERITY_LABEL) as Severity[]).map((severity) => (
                      <option key={severity} value={severity}>
                        Always {SEVERITY_LABEL[severity].toLowerCase()}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Repair
                  <select
                    value={def.repair ?? ''}
                    onChange={(event) => set(flag, 'repair', event.target.value === '' ? null : event.target.value)}
                  >
                    {repairTitle && shippedRepair ? <option value={shippedRepair}>{repairTitle}</option> : null}
                    <option value="">{isRuleCode(flag) ? 'What the rule asks for' : 'Report only'}</option>
                    {scripts
                      .filter((script) => script.manifest && script.kind === 'repairs')
                      .map((script) => (
                        <option key={script.repairId} value={script.repairId}>
                          Script: {script.manifest?.name}
                          {script.trust === 'approved' ? '' : ' (not approved)'}
                        </option>
                      ))}
                    {def.repair && def.repair !== shippedRepair && !scripts.some((s) => s.repairId === def.repair) ? (
                      <option value={def.repair}>{def.repair} (not installed)</option>
                    ) : null}
                  </select>
                </label>
                <label className="param-inline">
                  <input type="checkbox" checked={def.chip} onChange={(event) => set(flag, 'chip', event.target.checked)} />
                  <span>Show as a chip</span>
                </label>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** The repair-only switch: re-run the checks on what the repair wrote. */
export function RecheckToggle({
  id,
  settings,
  onChange
}: {
  id: string
  settings: AppSettings
  onChange: OnChange
}): React.JSX.Element | null {
  // A script has no entry until something about it is changed; it re-checks by default.
  const entry = catalogFor(settings).repairs[id] ?? (id.startsWith('script.') ? { recheck: true } : undefined)
  if (!entry) return null
  return (
    <label className="param-inline recheck">
      <input
        type="checkbox"
        checked={entry.recheck}
        onChange={(event) => onChange({ catalog: setField(settings.catalog, 'repairs', id, 'recheck', event.target.checked) })}
      />
      <span>Re-run the checks on the file after this repair</span>
    </label>
  )
}

/** A repair script's parameters, as its manifest describes them. */
export function ScriptParamEditor({
  script,
  settings,
  onChange
}: {
  script: ScriptInfo
  settings: AppSettings
  onChange: OnChange
}): React.JSX.Element | null {
  const manifest = script.manifest
  const entries = Object.entries(manifest?.params ?? {})
  if (!manifest || entries.length === 0) return null
  const section = script.kind === 'checks' ? 'checks' : 'repairs'
  const values = resolveParams(manifest.params, manifest.defaults, catalogFor(settings)[section][script.repairId]?.params)
  return (
    <div className="param-editor">
      <h4>Settings</h4>
      {entries.map(([key, spec]) => (
        <div className="param-row" key={key}>
          <span className="param-label">
            {spec.type === 'boolean' ? null : spec.label}
            {spec.help ? <span className="hint">{spec.help}</span> : null}
          </span>
          <ParamControl
            spec={spec}
            value={values[key] as ParamValue}
            onChange={(next) => onChange({ catalog: setParam(settings.catalog, section, script.repairId, key, next) })}
          />
        </div>
      ))}
    </div>
  )
}
