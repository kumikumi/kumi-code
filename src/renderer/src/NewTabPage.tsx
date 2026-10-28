// The new tab page: start a conversation in a recent project, a picked folder or
// no project, or open a past one.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AuthStatus, ConversationSummary, RecentProject } from '@shared/types'
import { useUsage } from './state'
import { clockTime, errorMessage as message, relativeTime, tildify } from './util'

const api = window.kumi

export function NewTabPage({ tabId, visible }: { tabId: string; visible: boolean }): ReactNode {
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [projects, setProjects] = useState<RecentProject[] | null>(null)
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null)
  const [all, setAll] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const usage = useUsage()

  const checkAuth = useCallback(() => {
    setAuthError(null)
    api.getAuthStatus().then(setAuth, (err: unknown) => setAuthError(message(err)))
  }, [])

  const refresh = useCallback(() => {
    api.listRecentProjects().then(setProjects, (err: unknown) => setError(message(err)))
    api.listConversations(all).then(setConversations, (err: unknown) => setError(message(err)))
  }, [all])

  useEffect(() => {
    if (visible) refresh()
  }, [visible, refresh])
  useEffect(() => {
    if (visible) checkAuth()
  }, [visible, checkAuth])
  useEffect(() => api.onConversationsChanged(refresh), [refresh])

  const run = (p: Promise<unknown>): void => {
    setError(null)
    p.catch((err: unknown) => setError(message(err)))
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!conversations || !q) return conversations
    return conversations.filter((c) => c.title.toLowerCase().includes(q) || (c.project ?? 'no project').toLowerCase().includes(q) || c.cwd.toLowerCase().includes(q))
  }, [conversations, query])

  return (
    <div className="newtab">
      <div className="newtab-inner">
        <header className="newtab-header">
          <h1>Kumi Code</h1>
          <div className="account">
            {auth?.loggedIn && (
              <span>
                {auth.email ?? 'Signed in'}
                {auth.subscriptionType ? ` · ${auth.subscriptionType}` : ''}
              </span>
            )}
            {usage && (
              <span title={usage.resetsAt ? `Resets at ${clockTime(usage.resetsAt)}` : undefined}>
                5-hour usage {usage.utilization}%
              </span>
            )}
          </div>
        </header>

        {authError && <div className="banner error">Could not read the Claude login: {authError}</div>}
        {auth && !auth.loggedIn && (
          <div className="banner">
            <p>
              Kumi Code uses the Claude subscription login that Claude Code keeps on this machine. You are not logged in. Run this in a
              terminal, then check again:
            </p>
            <code className="command">{auth.loginCommand}</code>
            <div className="row">
              <button onClick={() => void navigator.clipboard.writeText(auth.loginCommand)}>Copy command</button>
              <button className="primary" onClick={checkAuth}>
                Check again
              </button>
            </div>
          </div>
        )}
        {error && <div className="banner error">{error}</div>}

        <section>
          <h2>New conversation</h2>
          <div className="projects">
            {projects?.map((p) => (
              <button key={p.path} className="project" onClick={() => run(api.startConversation(tabId, p.path))} title={p.path}>
                <span className="project-name">{p.name}</span>
                <span className="project-path">{tildify(p.path)}</span>
              </button>
            ))}
            <button
              className="project action"
              onClick={() =>
                run(
                  api.pickFolder().then((path) => {
                    if (path) return api.startConversation(tabId, path)
                  }),
                )
              }
            >
              <span className="project-name">Open folder…</span>
              <span className="project-path">Work in a folder of your choice</span>
            </button>
            <button className="project action" onClick={() => run(api.startConversation(tabId, null))}>
              <span className="project-name">No project</span>
              <span className="project-path">Start in a new empty folder</span>
            </button>
          </div>
        </section>

        <section>
          <div className="section-head">
            <h2>Conversations</h2>
            <input className="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
            <label className="toggle" title="Include Claude Code sessions started outside Kumi Code">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
              All Claude Code sessions
            </label>
          </div>
          {filtered === null ? (
            <div className="muted">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="muted">{query ? 'No matches.' : 'No conversations yet.'}</div>
          ) : (
            <ul className="conversations">
              {filtered.map((c) => (
                <ConversationRow key={c.id} c={c} onOpen={() => run(api.openConversation(tabId, c.id))} onError={setError} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

function ConversationRow({ c, onOpen, onError }: { c: ConversationSummary; onOpen: () => void; onError: (e: string) => void }): ReactNode {
  const [renaming, setRenaming] = useState<string | null>(null)
  const save = (): void => {
    const title = renaming?.trim()
    setRenaming(null)
    if (title && title !== c.title) api.renameConversation(c.id, title).catch((err: unknown) => onError(message(err)))
  }
  return (
    <li className="conversation-row">
      {renaming !== null ? (
        <input
          autoFocus
          className="rename"
          value={renaming}
          onChange={(e) => setRenaming(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') setRenaming(null)
          }}
        />
      ) : (
        <button className="conversation-open" onClick={onOpen}>
          <span className="conversation-title">{c.title}</span>
          <span className="conversation-meta">
            {c.project ?? 'No project'}
            {c.gitBranch ? ` · ${c.gitBranch}` : ''}
            {!c.kumi ? ' · Claude Code' : ''}
          </span>
          <span className="conversation-time">{relativeTime(c.lastModified)}</span>
        </button>
      )}
      <div className="row-actions">
        <button className="ghost small" onClick={() => setRenaming(c.title)}>
          Rename
        </button>
        <button
          className="ghost small danger-text"
          onClick={() => {
            if (window.confirm(`Delete "${c.title}"? Its transcript is removed from ~/.claude/projects.`)) {
              api.deleteConversation(c.id).catch((err: unknown) => onError(message(err)))
            }
          }}
        >
          Delete
        </button>
      </div>
    </li>
  )
}
