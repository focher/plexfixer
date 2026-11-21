/**
 * Building a rule by dragging rather than typing.
 *
 * There is no second model here. The blocks edit the same parsed script the
 * text editor produces, and every change is written straight back out as text —
 * so the two views cannot drift, and anything you can build here is something
 * you could have typed.
 *
 * Two honest limits, both stated on screen rather than hidden:
 *
 * - **The order of conditions does not mean anything.** They all have to hold.
 *   Dragging one above another is tidying, not logic, and saying so is better
 *   than letting someone believe they have expressed "check this first".
 * - **Dragging is never the only way.** Every palette item is a button as well
 *   as a drag source, because dragging on a trackpad is a chore and with a
 *   keyboard it is nothing at all.
 */

import React, { useEffect, useState } from 'react'
import type { ParsedScript, ScriptCondition } from '@shared/plex/modules/script/parse.js'
import {
  addCondition,
  addFix,
  defaultValueFor,
  editCondition,
  moveCondition,
  removeCondition,
  removeFix
} from '@shared/plex/modules/script/edit.js'
import {
  FIXES,
  OPERATORS,
  SUBJECTS,
  SEVERITIES,
  fixNamed,
  type SubjectScope
} from '@shared/plex/modules/script/vocabulary.js'

/** What a drag is carrying. Sent as plain text: custom MIME types are patchy in webviews. */
interface Payload {
  plexfixer: 'subject' | 'fix' | 'move'
  value: string
}

function readPayload(event: React.DragEvent): Payload | undefined {
  try {
    const parsed: unknown = JSON.parse(event.dataTransfer.getData('text/plain'))
    if (typeof parsed === 'object' && parsed !== null && 'plexfixer' in parsed) return parsed as Payload
  } catch {
    /* something else was dragged in; ignore it */
  }
  return undefined
}

function setPayload(event: React.DragEvent, payload: Payload): void {
  event.dataTransfer.setData('text/plain', JSON.stringify(payload))
  event.dataTransfer.effectAllowed = 'copyMove'
}

/**
 * A script is a list of lines, so nothing in one may contain a newline.
 *
 * The explanations are typed into boxes big enough to invite pressing return,
 * and a return inside a quoted value would end the line and leave the quote
 * open. Folded to a space as it is typed, rather than refused on save.
 */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ')
}

const SCOPE_LABEL: Record<SubjectScope, string> = {
  file: 'The file',
  video: 'The video',
  audio: 'Any audio track',
  subtitle: 'Any subtitle track'
}

export default function RuleBlocks({
  script,
  onChange
}: {
  script: ParsedScript
  onChange: (next: ParsedScript) => void
}): React.JSX.Element {
  const [dragOver, setDragOver] = useState<'when' | 'fix' | undefined>()
  const [showProse, setShowProse] = useState(
    script.summary !== undefined ||
      script.whatItDoes !== undefined ||
      script.howItWorks !== undefined ||
      script.ifDisabled !== undefined
  )

  /* --- every structural change, done by the shared editor -------------- */

  const addSubject = (subjectName: string, at?: number): void => onChange(addCondition(script, subjectName, at))
  const edit = (index: number, operatorName: string, value: string): void =>
    onChange(editCondition(script, index, operatorName, value))
  const remove = (index: number): void => onChange(removeCondition(script, index))
  const move = (from: number, to: number): void => onChange(moveCondition(script, from, to))
  const add = (name: string): void => onChange(addFix(script, name))
  const dropFix = (index: number): void => onChange(removeFix(script, index))

  /* --- the report ----------------------------------------------------- */

  const setReport = (patch: Partial<NonNullable<ParsedScript['report']>>): void => {
    const report = script.report ?? { severity: 'warning' as const, title: '', detail: '' }
    onChange({ ...script, report: { ...report, ...patch } })
  }

  const dropped = (event: React.DragEvent, into: 'when' | 'fix', at?: number): void => {
    event.preventDefault()
    // A block sits inside its zone, so a drop on one would otherwise be handled
    // twice: once by the block and again by the zone around it. The second
    // handler works from the script as it was before the first ran, so it does
    // not just repeat the move — it undoes it.
    event.stopPropagation()
    setDragOver(undefined)
    const payload = readPayload(event)
    if (!payload) return
    if (payload.plexfixer === 'subject' && into === 'when') addSubject(payload.value, at)
    if (payload.plexfixer === 'fix' && into === 'fix') add(payload.value)
    if (payload.plexfixer === 'move' && into === 'when') {
      move(Number(payload.value), at ?? script.conditions.length)
    }
  }

  const allow = (event: React.DragEvent, zone: 'when' | 'fix'): void => {
    event.preventDefault()
    setDragOver(zone)
  }

  return (
    <div className="blocks">
      <div className="blocks-rule">
        <label className="block-field">
          <span>Call this rule</span>
          <input
            type="text"
            value={script.name}
            placeholder="Flag DivX video"
            onChange={(event) => onChange({ ...script, name: event.target.value })}
          />
        </label>

        <h4 className="block-heading">
          When <span className="block-note">all of these are true</span>
        </h4>
        <div
          className={`block-zone${dragOver === 'when' ? ' over' : ''}`}
          onDragOver={(event) => allow(event, 'when')}
          onDragLeave={() => setDragOver(undefined)}
          onDrop={(event) => dropped(event, 'when')}
        >
          {script.conditions.length === 0 ? (
            <p className="block-empty">Drag something to ask about here, or click it in the list.</p>
          ) : (
            script.conditions.map((condition, index) => (
              <ConditionBlock
                key={`${condition.subject.name}-${index}`}
                condition={condition}
                onEdit={(operator, value) => edit(index, operator, value)}
                onRemove={() => remove(index)}
                onDragStart={(event) => setPayload(event, { plexfixer: 'move', value: String(index) })}
                onDropBefore={(event) => dropped(event, 'when', index)}
              />
            ))
          )}
        </div>

        <h4 className="block-heading">Report</h4>
        {script.report ? (
          <div className="block">
            <div className="block-row">
              <select
                aria-label="How serious this is"
                value={script.report.severity}
                onChange={(event) => setReport({ severity: event.target.value as (typeof SEVERITIES)[number] })}
              >
                {SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {severity}
                  </option>
                ))}
              </select>
              <input
                type="text"
                className="block-grow"
                aria-label="What to call it"
                placeholder="DivX video"
                value={script.report.title}
                onChange={(event) => setReport({ title: event.target.value })}
              />
              <button className="ghost block-remove" onClick={() => onChange({ ...script, report: undefined })}>
                ×
              </button>
            </div>
            <textarea
              className="block-detail"
              aria-label="Why it matters"
              placeholder="Why this matters, in a sentence or two."
              value={script.report.detail}
              onChange={(event) => setReport({ detail: oneLine(event.target.value) })}
            />
          </div>
        ) : (
          <button className="ghost block-add" onClick={() => setReport({})}>
            Report something when this rule matches
          </button>
        )}

        <h4 className="block-heading">
          Then ask for <span className="block-note">repairs the app already has</span>
        </h4>
        <div
          className={`block-zone${dragOver === 'fix' ? ' over' : ''}`}
          onDragOver={(event) => allow(event, 'fix')}
          onDragLeave={() => setDragOver(undefined)}
          onDrop={(event) => dropped(event, 'fix')}
        >
          {script.fixes.length === 0 ? (
            <p className="block-empty">Nothing — this rule only reports. Drag a repair here to change that.</p>
          ) : (
            script.fixes.map((fix, index) => (
              <div className="block block-fix" key={fix}>
                <span className="block-fix-name">{fix}</span>
                <span className="block-fix-note">{fixNamed(fix)?.describe}</span>
                <button className="ghost block-remove" onClick={() => dropFix(index)} aria-label={`Remove ${fix}`}>
                  ×
                </button>
              </div>
            ))
          )}
        </div>

        <button className="ghost block-add" onClick={() => setShowProse((previous) => !previous)}>
          {showProse ? 'Hide your own wording' : 'Write your own wording for the Settings screen'}
        </button>
        {showProse ? (
          <div className="block-prose">
            <p className="block-note">
              Left empty, each of these is written from the rule itself. Fill one in and yours is used instead.
            </p>
            {(
              [
                ['summary', 'One line for the list', script.summary],
                ['whatItDoes', 'What it does', script.whatItDoes],
                ['howItWorks', 'How it works', script.howItWorks],
                ['ifDisabled', 'If you turn it off', script.ifDisabled]
              ] as const
            ).map(([field, label, value]) => (
              <label className="block-field" key={field}>
                <span>{label}</span>
                <textarea
                  value={value ?? ''}
                  onChange={(event) =>
                    onChange({
                      ...script,
                      [field]: event.target.value === '' ? undefined : oneLine(event.target.value)
                    })
                  }
                />
              </label>
            ))}
          </div>
        ) : null}
      </div>

      <aside className="blocks-palette" aria-label="Things to drag in">
        <h4>Ask about</h4>
        <p className="block-note">Drag one in, or click it.</p>
        {(['file', 'video', 'audio', 'subtitle'] as SubjectScope[]).map((scope) => (
          <React.Fragment key={scope}>
            <h5>{SCOPE_LABEL[scope]}</h5>
            {SUBJECTS.filter((subject) => subject.scope === scope).map((subject) => (
              <PaletteItem
                key={subject.name}
                label={subject.name}
                hint={subject.describe}
                onAdd={() => addSubject(subject.name)}
                onDragStart={(event) => setPayload(event, { plexfixer: 'subject', value: subject.name })}
              />
            ))}
          </React.Fragment>
        ))}

        <h4>Ask for</h4>
        {FIXES.map((fix) => (
          <PaletteItem
            key={fix.name}
            label={fix.name}
            hint={fix.describe}
            disabled={script.fixes.includes(fix.name)}
            onAdd={() => add(fix.name)}
            onDragStart={(event) => setPayload(event, { plexfixer: 'fix', value: fix.name })}
          />
        ))}
      </aside>
    </div>
  )
}

function PaletteItem({
  label,
  hint,
  disabled,
  onAdd,
  onDragStart
}: {
  label: string
  hint: string
  disabled?: boolean
  onAdd: () => void
  onDragStart: (event: React.DragEvent) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="palette-item"
      draggable={!disabled}
      disabled={disabled}
      title={disabled ? 'Already in this rule' : hint}
      onDragStart={onDragStart}
      onClick={onAdd}
    >
      <span className="palette-name">{label}</span>
      <span className="palette-hint">{hint}</span>
    </button>
  )
}

/** One `when` line: what to ask about, how to compare it, and what to compare with. */
function ConditionBlock({
  condition,
  onEdit,
  onRemove,
  onDragStart,
  onDropBefore
}: {
  condition: ScriptCondition
  onEdit: (operator: string, value: string) => void
  onRemove: () => void
  onDragStart: (event: React.DragEvent) => void
  onDropBefore: (event: React.DragEvent) => void
}): React.JSX.Element {
  const { subject, operator, values } = condition
  const usable = OPERATORS.filter((candidate) => candidate.types.includes(subject.type))
  const takesNoValue = operator.name === 'is set' || operator.name === 'is missing'
  const written = values.map((value) => String(value)).join(', ')

  // What is in the box while it is being typed. A list is only a list once the
  // typing stops — committing "divx," on the keystroke would read it as one
  // value and take the comma straight back out from under the cursor.
  const [draft, setDraft] = useState(written)
  useEffect(() => setDraft(written), [written])
  const commit = (): void => {
    // An emptied box is a condition with nothing filled in yet, not a reason to
    // put the old value back under the cursor.
    if (draft !== written) onEdit(operator.name, draft === '' ? defaultValueFor(subject) : draft)
  }

  const change = (nextOperator: string, nextValue: string): void => {
    const next = OPERATORS.find((candidate) => candidate.name === nextOperator)
    // Moving to a comparison that takes no value drops the value rather than
    // carrying a stale one along invisibly.
    if (next?.name === 'is set' || next?.name === 'is missing') onEdit(nextOperator, '')
    else onEdit(nextOperator, nextValue === '' ? defaultValueFor(subject) : nextValue)
  }

  return (
    <div
      className="block block-when"
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDropBefore}
    >
      <span className="block-grip" aria-hidden="true">
        ⠿
      </span>
      <span className="block-subject" title={subject.describe}>
        {subject.name}
      </span>
      <select
        aria-label={`How to compare ${subject.name}`}
        value={operator.name}
        onChange={(event) => change(event.target.value, written)}
      >
        {usable.map((candidate) => (
          <option key={candidate.name} value={candidate.name}>
            {candidate.name}
          </option>
        ))}
      </select>

      {takesNoValue ? null : subject.type === 'boolean' ? (
        <select
          aria-label={`What ${subject.name} should be`}
          value={written}
          onChange={(event) => onEdit(operator.name, event.target.value)}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          type={subject.type === 'number' && !operator.list ? 'number' : 'text'}
          className="block-grow"
          aria-label={`What ${subject.name} should be`}
          placeholder={operator.list ? 'divx, dx50, xvid' : subject.type === 'number' ? '0' : 'divx'}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
          }}
        />
      )}

      <button className="ghost block-remove" onClick={onRemove} aria-label={`Remove ${subject.name}`}>
        ×
      </button>
    </div>
  )
}

