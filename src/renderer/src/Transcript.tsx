// The conversation as the user sees it: their messages, the agent's text and
// thinking, tool calls with their results, and what Claude Code reports.

import { memo, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranscriptItem } from '@shared/types'
import { Markdown } from './markdown'
import { summarizeTool, Todos, ToolInput } from './tools'
import { cx } from './util'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

/** Long tool output is cut to this many characters until expanded further. */
const OUTPUT_PREVIEW = 4000

/** Task list tools show in the task list above the composer, not in the transcript. */
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

export const Item = memo(function Item({ item, cwd }: { item: TranscriptItem; cwd: string }): ReactNode {
  switch (item.kind) {
    case 'user':
      return (
        <div className={cx('item user', item.queued && 'queued')}>
          {item.images.length > 0 && (
            <div className="images">
              {item.images.map((img, i) => (
                <img key={i} src={`data:${img.mediaType};base64,${img.data}`} alt="" />
              ))}
            </div>
          )}
          {item.text && <div className="user-text">{item.text}</div>}
          {item.queued && <div className="queued-label">Queued</div>}
        </div>
      )
    case 'text':
      return (
        <div className="item text">
          <Markdown text={item.text} />
        </div>
      )
    case 'thinking':
      return <Thinking text={item.text} streaming={item.streaming} />
    case 'tool':
      if (TASK_TOOLS.has(item.name) && !item.result?.isError) return null
      return <Tool item={item} cwd={cwd} />
    case 'compact':
      return (
        <div className="item divider">
          <span>
            Conversation compacted
            {item.trigger ? ` (${item.trigger}${item.preTokens ? `, ${Math.round(item.preTokens / 1000)}k tokens before` : ''})` : ''}
          </span>
        </div>
      )
    case 'command_output':
      return <pre className="item command-output">{item.text}</pre>
    case 'notice':
      return <div className={cx('item notice', item.level)}>{item.text}</div>
  }
})

function Thinking({ text, streaming }: { text: string; streaming: boolean }): ReactNode {
  const [open, setOpen] = useState(false)
  if (!text.trim() && !streaming) return null
  return (
    <div className="item thinking">
      <button className="thinking-toggle" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? '▾' : '▸'}</span> {streaming ? 'Thinking…' : 'Thought'}
      </button>
      {open && <div className="thinking-text">{text}</div>}
    </div>
  )
}

function Tool({ item, cwd }: { item: ToolItem; cwd: string }): ReactNode {
  const [open, setOpen] = useState(false)
  if (item.name === 'TodoWrite') {
    return (
      <div className="item tool todo-card">
        <div className="tool-head static">
          <span className="tool-label">Todos</span>
        </div>
        <Todos input={item.input} />
      </div>
    )
  }
  const { label, detail } = summarizeTool(item.name, item.input, cwd)
  const state = item.result === null ? 'running' : item.result.isError ? 'error' : 'done'
  const isAgent = item.name === 'Agent' || item.name === 'Task'
  return (
    <div className={cx('item tool', state)}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className={cx('tool-state', state)} />
        <span className="tool-label">{label}</span>
        <span className="tool-detail">{detail}</span>
        {isAgent && item.children.length > 0 && <span className="tool-count">{item.children.filter((c) => c.kind === 'tool').length} tool uses</span>}
      </button>
      {isAgent && !open && item.result === null && <AgentActivity item={item} cwd={cwd} />}
      {open && (
        <div className="tool-body">
          {item.partialInput !== null ? <pre className="tool-text">{item.partialInput}</pre> : <ToolInput name={item.name} input={item.input} />}
          {isAgent && item.children.length > 0 && (
            <div className="agent-children">
              {item.children.map((child) => (
                <Item key={child.id} item={child} cwd={cwd} />
              ))}
            </div>
          )}
          {item.result && (isAgent ? <Markdown text={item.result.text} /> : <Output text={item.result.text} images={item.result.images} isError={item.result.isError} />)}
        </div>
      )}
      {!open && item.result?.isError && <div className="tool-error-line">{firstLine(item.result.text)}</div>}
    </div>
  )
}

/** The latest thing a running subagent did. */
function AgentActivity({ item, cwd }: { item: ToolItem; cwd: string }): ReactNode {
  const last = [...item.children].reverse().find((c) => c.kind === 'tool')
  if (!last || last.kind !== 'tool') return null
  const { label, detail } = summarizeTool(last.name, last.input, cwd)
  return (
    <div className="agent-activity">
      {label} {detail}
    </div>
  )
}

function Output({ text, images, isError }: { text: string; images: number; isError: boolean }): ReactNode {
  const [full, setFull] = useState(false)
  if (!text && images === 0) return <div className="tool-empty">(no output)</div>
  const cut = !full && text.length > OUTPUT_PREVIEW
  return (
    <div className={cx('tool-output', isError && 'error')}>
      {text && <pre className="tool-text">{cut ? `${text.slice(0, OUTPUT_PREVIEW)}…` : text}</pre>}
      {cut && (
        <button className="ghost small" onClick={() => setFull(true)}>
          Show all {text.length.toLocaleString()} characters
        </button>
      )}
      {images > 0 && <div className="tool-empty">{images === 1 ? '1 image' : `${images} images`}</div>}
    </div>
  )
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}
