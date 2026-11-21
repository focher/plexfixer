/**
 * Writing a rule.
 *
 * The editor reads the script as it is typed, which is the whole idea: the
 * panel on the right is not documentation about the language, it is this rule
 * said back in English. Seeing "it matches a file when the video's codec is
 * divx or xvid" under what you just typed is how you notice you wrote the
 * wrong codec, and it costs nothing to show because the app has to work that
 * sentence out anyway to put the rule in the list.
 *
 * A rule with mistakes in it can still be saved. Half-written work is worth
 * keeping, and a rule that will not parse simply does not run — it is listed as
 * broken rather than silently matching nothing.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { parseScript, type ParsedScript } from '@shared/plex/modules/script/parse.js'
import { serializeScript } from '@shared/plex/modules/script/serialize.js'
import { describeScript } from '@shared/plex/modules/script/describe.js'
import { FIXES, OPERATORS, SUBJECTS } from '@shared/plex/modules/script/vocabulary.js'
import RuleBlocks from './RuleBlocks.js'

export const NEW_RULE_TEMPLATE = `# A rule of your own. Lines starting with # are ignored.
#
#   name     what the rule is called
#   when     a question about the file — several lines must all hold
#   report   info, warning or blocker, then a title and an explanation
#   fix      transcode-video, remux, drop-track or extract-subtitles
#
# Everything you can ask about is listed on the right.

name Flag DivX video
when video.codec in divx, dx50, xvid
report blocker "DivX video"
       "No mainstream client can decode DivX, so the server re-encodes
        it on every play. Re-encoding once removes that for good."
fix transcode-video
`

export default function ModuleEditor({
  initialScript,
  isNew,
  onSave,
  onCancel
}: {
  initialScript: string
  isNew: boolean
  onSave: (script: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [script, setScript] = useState(initialScript)
  const [showReference, setShowReference] = useState(true)
  const area = useRef<HTMLTextAreaElement>(null)

  /**
   * The two views, and which one is in front.
   *
   * `blocks` holds a parsed rule of its own rather than re-reading the text on
   * every keystroke. Without that, clearing the name box for a moment would
   * make the rule unparseable and the blocks would vanish out from under the
   * person clearing it. So the blocks are authoritative while they are open,
   * and every change is written straight back out as text underneath.
   */
  const [view, setView] = useState<'blocks' | 'text'>(() =>
    parseScript(initialScript).script ? 'blocks' : 'text'
  )
  const [blocks, setBlocks] = useState<ParsedScript | undefined>(() => parseScript(initialScript).script)

  const showBlocks = (): void => {
    const parsed = parseScript(script).script
    if (!parsed) return
    setBlocks(parsed)
    setView('blocks')
  }

  const editBlocks = (next: ParsedScript): void => {
    setBlocks(next)
    setScript(serializeScript(next))
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    area.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const read = useMemo(() => parseScript(script), [script])
  const prose = read.script ? describeScript(read.script) : undefined
  const canUseBlocks = read.script !== undefined

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <div
        className="dialog rule-editor"
        role="dialog"
        aria-modal="true"
        aria-label={isNew ? 'New rule' : 'Edit rule'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>{isNew ? 'New rule' : 'Edit rule'}</h2>
        <div className="about-version">
          Nothing here is executed — a rule can compare what is in a file and ask for a repair the app already has,
          and that is all it can do.
        </div>

        <div className="rule-views" role="tablist" aria-label="How to edit this rule">
          <button
            role="tab"
            aria-selected={view === 'blocks'}
            disabled={!canUseBlocks}
            title={canUseBlocks ? undefined : 'Fix the problems below to build this rule in blocks'}
            onClick={showBlocks}
          >
            Blocks
          </button>
          <button role="tab" aria-selected={view === 'text'} onClick={() => setView('text')}>
            Text
          </button>
          <span className="rule-views-note">
            {view === 'blocks'
              ? 'The same rule as the text, written back out as you change it.'
              : 'One step per line.'}
          </span>
        </div>

        <div className="rule-editor-body">
          <div className="rule-editor-main">
            {view === 'blocks' && blocks ? (
              <RuleBlocks script={blocks} onChange={editBlocks} />
            ) : (
              <textarea
                ref={area}
                className="rule-script"
                spellCheck={false}
                value={script}
                aria-label="Rule script"
                onChange={(event) => setScript(event.target.value)}
              />
            )}

            {read.problems.length > 0 ? (
              <div className="rule-problems">
                <h4>
                  {read.problems.length === 1 ? '1 thing to fix' : `${read.problems.length} things to fix`} — this
                  rule will not run until they are
                </h4>
                <ul>
                  {read.problems.map((problem, index) => (
                    <li key={`${problem.line}-${index}`}>
                      <span className="rule-problem-line">Line {problem.line}</span>
                      {problem.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : prose ? (
              <div className="rule-preview">
                <h4>This rule, said back</h4>
                <p className="rule-preview-name">{read.script?.name}</p>
                <p>{prose.whatItDoes}</p>
                <p>{prose.howItWorks}</p>
              </div>
            ) : null}
          </div>

          {showReference && view === 'text' ? (
            <aside className="rule-reference" aria-label="What a rule can say">
              <h4>Ask about</h4>
              <dl>
                {SUBJECTS.map((subject) => (
                  <React.Fragment key={subject.name}>
                    <dt>{subject.name}</dt>
                    <dd>{subject.describe}</dd>
                  </React.Fragment>
                ))}
              </dl>

              <h4>Compare with</h4>
              <dl>
                {OPERATORS.map((operator) => (
                  <React.Fragment key={operator.name}>
                    <dt>{operator.name}</dt>
                    <dd>{operator.describe}</dd>
                  </React.Fragment>
                ))}
              </dl>

              <h4>Ask for</h4>
              <dl>
                {FIXES.map((fix) => (
                  <React.Fragment key={fix.name}>
                    <dt>{fix.name}</dt>
                    <dd>{fix.describe}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </aside>
          ) : null}
        </div>

        <div className="about-actions">
          {view === 'text' ? (
            <button className="ghost" onClick={() => setShowReference((previous) => !previous)}>
              {showReference ? 'Hide the reference' : 'Show the reference'}
            </button>
          ) : null}
          <span className="spacer" />
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={() => onSave(script)}>
            {read.problems.length > 0 ? 'Save anyway' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
