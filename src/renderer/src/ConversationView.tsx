import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TaskInfo } from '@shared/types'
import { Composer } from './Composer'
import { Requests } from './Requests'
import { conversations, useConversation } from './state'
import { Item } from './Transcript'
import { errorMessage, tildify } from './util'

const api = window.kumi

/** Within this many pixels of the bottom, the transcript follows new output. */
const STICK_DISTANCE = 80

export function ConversationView({ conversationId, visible }: { conversationId: string; visible: boolean }): ReactNode {
  const state = useConversation(conversationId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [state?.items, state?.meta.requests, state?.meta.status])

  useEffect(() => {
    // Back in view: catch up with output that arrived while hidden.
    const el = scrollRef.current
    if (visible && el && stick.current) el.scrollTop = el.scrollHeight
  }, [visible])

  if (!state) {
    const error = conversations.errors.get(conversationId)
    return <div className="conversation loading">{error ? <div className="notice error">{error}</div> : <div className="muted">Loading…</div>}</div>
  }
  const { meta, items } = state
  const model = meta.models.find((m) => m.value === (meta.model ?? 'default'))

  const saveTitle = (): void => {
    const title = renaming?.trim()
    setRenaming(null)
    if (title && title !== meta.title) api.renameConversation(meta.id, title).catch((err: unknown) => setRenameError(errorMessage(err)))
  }

  return (
    <div className="conversation">
      <header className="conversation-header">
        {renaming !== null ? (
          <input
            autoFocus
            className="rename"
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveTitle()
              if (e.key === 'Escape') setRenaming(null)
            }}
          />
        ) : (
          <h1 onDoubleClick={() => setRenaming(meta.title)} title="Double-click to rename">
            {meta.title}
          </h1>
        )}
        <span className="project-label" title={meta.cwd}>
          {meta.project ?? 'No project'} <span className="muted">{tildify(meta.cwd)}</span>
        </span>
        {renameError && <span className="notice error">{renameError}</span>}
      </header>
      <div
        className="transcript"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_DISTANCE
        }}
      >
        <div className="transcript-inner">
          {items.length === 0 && meta.status !== 'running' && <div className="empty">What should we work on?</div>}
          {items.map((item) => (
            <Item key={item.id} item={item} cwd={meta.cwd} />
          ))}
          <Status status={meta.status} compacting={meta.compacting} waiting={meta.requests.length > 0} />
        </div>
      </div>
      <div className="bottom">
        <Tasks tasks={meta.tasks} />
        <Requests conversationId={meta.id} requests={meta.requests} cwd={meta.cwd} supportsAuto={model?.supportsAutoMode === true} />
        <Composer meta={meta} visible={visible} />
      </div>
    </div>
  )
}

/** Claude Code's task list, while it has work left. */
function Tasks({ tasks }: { tasks: TaskInfo[] }): ReactNode {
  const [open, setOpen] = useState(true)
  if (!tasks.some((t) => t.status !== 'completed')) return null
  const done = tasks.filter((t) => t.status === 'completed').length
  return (
    <div className="tasks">
      <button className="tasks-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? '▾' : '▸'}</span> Tasks {done}/{tasks.length}
      </button>
      {open && (
        <ul className="todos">
          {tasks.map((t) => (
            <li key={t.id} className={`todo ${t.status}`}>
              <span className="todo-box">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : ''}</span>
              {t.status === 'in_progress' ? t.activeForm : t.subject}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Status({ status, compacting, waiting }: { status: string; compacting: boolean; waiting: boolean }): ReactNode {
  if (compacting) return <div className="status-line">Compacting conversation…</div>
  if (waiting) return <div className="status-line">Waiting for you</div>
  if (status === 'running') return <div className="status-line working">Working…</div>
  if (status === 'starting') return <div className="status-line">Starting Claude Code…</div>
  return null
}
