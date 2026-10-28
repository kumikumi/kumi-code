// What the agent is waiting on: permission for a tool, answers to its
// questions, or approval of a plan.

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PendingRequest, Question, RequestResponse } from '@shared/types'
import { Markdown } from './markdown'
import { summarizeTool, ToolInput } from './tools'
import { errorMessage } from './util'

const api = window.kumi

export function Requests({ conversationId, requests, cwd, supportsAuto }: { conversationId: string; requests: PendingRequest[]; cwd: string; supportsAuto: boolean }): ReactNode {
  const [error, setError] = useState<string | null>(null)
  const request = requests[0]
  if (!request) return null
  const respond = (response: RequestResponse): void => {
    setError(null)
    api.respond(conversationId, request.id, response).catch((err: unknown) => setError(errorMessage(err)))
  }
  return (
    <div className="requests">
      {requests.length > 1 && <div className="requests-count">{requests.length} requests waiting</div>}
      {request.kind === 'permission' && <Permission key={request.id} request={request} cwd={cwd} respond={respond} />}
      {request.kind === 'question' && <Questions key={request.id} questions={request.questions} respond={respond} />}
      {request.kind === 'plan' && <Plan key={request.id} plan={request.plan} supportsAuto={supportsAuto} respond={respond} />}
      {error && <div className="notice error">{error}</div>}
    </div>
  )
}

function Permission({ request, cwd, respond }: { request: Extract<PendingRequest, { kind: 'permission' }>; cwd: string; respond: (r: RequestResponse) => void }): ReactNode {
  const [note, setNote] = useState('')
  const { label, detail } = summarizeTool(request.toolName, request.input, cwd)
  return (
    <div className="request permission">
      <div className="request-title">{request.title ?? `Allow ${label}?`}</div>
      {request.description && <div className="request-sub">{request.description}</div>}
      {!request.title && !request.description && detail && <div className="request-sub mono">{detail}</div>}
      <div className="request-body">
        <ToolInput name={request.toolName} input={request.input} />
      </div>
      {request.reason && <div className="request-sub">{request.reason}</div>}
      {request.blockedPath && <div className="request-sub">Outside the allowed folders: {request.blockedPath}</div>}
      <div className="request-actions">
        <button className="primary" autoFocus onClick={() => respond({ kind: 'permission', allow: true, always: false })}>
          Allow
        </button>
        {request.canAlwaysAllow && <button onClick={() => respond({ kind: 'permission', allow: true, always: true })}>Always allow</button>}
        <input
          className="grow"
          placeholder="Or tell Claude what to do instead"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && note.trim()) respond({ kind: 'permission', allow: false, message: note })
          }}
        />
        <button onClick={() => respond({ kind: 'permission', allow: false, message: note })}>{note.trim() ? 'Deny with note' : 'Deny'}</button>
      </div>
    </div>
  )
}

function Questions({ questions, respond }: { questions: Question[]; respond: (r: RequestResponse) => void }): ReactNode {
  const [selected, setSelected] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})
  const answerOf = (i: number): string => {
    const text = other[i]?.trim()
    const picked = selected[i] ?? []
    return [...picked, ...(text ? [text] : [])].join(', ')
  }
  const complete = questions.every((_, i) => answerOf(i) !== '')
  const toggle = (i: number, label: string, multi: boolean): void => {
    const current = selected[i] ?? []
    const next = multi ? (current.includes(label) ? current.filter((l) => l !== label) : [...current, label]) : [label]
    setSelected({ ...selected, [i]: next })
    if (!multi) setOther({ ...other, [i]: '' })
  }
  return (
    <div className="request question">
      {questions.map((q, i) => (
        <div key={i} className="question-block">
          {q.header && <span className="chip">{q.header}</span>}
          <div className="request-title">{q.question}</div>
          <div className="options">
            {q.options.map((o) => (
              <label key={o.label} className="option">
                <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`q${i}`} checked={(selected[i] ?? []).includes(o.label)} onChange={() => toggle(i, o.label, q.multiSelect)} />
                <span>
                  <span className="option-label">{o.label}</span>
                  {o.description && <span className="option-description">{o.description}</span>}
                </span>
              </label>
            ))}
            <input
              placeholder="Other…"
              value={other[i] ?? ''}
              onChange={(e) => {
                setOther({ ...other, [i]: e.target.value })
                if (!q.multiSelect && e.target.value) setSelected({ ...selected, [i]: [] })
              }}
            />
          </div>
        </div>
      ))}
      <div className="request-actions">
        <button className="primary" disabled={!complete} onClick={() => respond({ kind: 'question', answers: Object.fromEntries(questions.map((q, i) => [q.question, answerOf(i)])) })}>
          Answer
        </button>
        <button onClick={() => respond({ kind: 'question', dismissed: true })}>Skip</button>
      </div>
    </div>
  )
}

function Plan({ plan, supportsAuto, respond }: { plan: string | null; supportsAuto: boolean; respond: (r: RequestResponse) => void }): ReactNode {
  const [feedback, setFeedback] = useState('')
  return (
    <div className="request plan">
      <div className="request-title">Ready to code? Here is the plan:</div>
      <div className="plan-body">{plan ? <Markdown text={plan} /> : <div className="muted">The plan is in the conversation above.</div>}</div>
      <div className="request-actions">
        <button className="primary" onClick={() => respond({ kind: 'plan', approve: true, mode: 'acceptEdits' })}>
          Approve, accept edits
        </button>
        {supportsAuto && <button onClick={() => respond({ kind: 'plan', approve: true, mode: 'auto' })}>Approve, auto mode</button>}
        <button onClick={() => respond({ kind: 'plan', approve: true, mode: 'default' })}>Approve, ask for edits</button>
      </div>
      <div className="request-actions">
        <input className="grow" placeholder="Or tell Claude what to change" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        <button onClick={() => respond({ kind: 'plan', approve: false, feedback })}>Keep planning</button>
      </div>
    </div>
  )
}
