// Past conversations and recent projects, read from Claude Code's session store
// and Kumi Code's own state.

import { listSessions } from '@anthropic-ai/claude-agent-sdk'
import { randomBytes } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import type { ConversationSummary, RecentProject } from '@shared/types'
import type { StoredState } from './store'

const RECENT_LIMIT = 12

/**
 * Conversations started or opened in Kumi Code, newest first; with `all`, every
 * Claude Code session on this machine.
 */
export async function listConversations(state: Readonly<StoredState>, scratchRoot: string, all: boolean): Promise<ConversationSummary[]> {
  const sessions = await listSessions({ includeProgrammatic: true })
  return sessions
    .filter((s) => all || s.sessionId in state.conversations)
    .map((s) => {
      const stored = state.conversations[s.sessionId]
      const cwd = stored?.cwd ?? s.cwd ?? ''
      return {
        id: s.sessionId,
        title: s.customTitle ?? s.summary,
        cwd,
        project: projectName(cwd, scratchRoot),
        lastModified: s.lastModified,
        gitBranch: s.gitBranch && s.gitBranch !== 'HEAD' ? s.gitBranch : null,
        kumi: stored !== undefined,
      }
    })
    .sort((a, b) => b.lastModified - a.lastModified)
}

/**
 * Projects used in Kumi Code, then the folders of other Claude Code sessions, most
 * recent first. Folders that no longer exist, Kumi Code's scratch folders and
 * application data folders (other apps' scratch space) are left out.
 */
export async function recentProjects(state: Readonly<StoredState>, scratchRoot: string): Promise<RecentProject[]> {
  const lastUsed = new Map<string, number>()
  for (const r of state.recents) lastUsed.set(r.path, r.lastUsed)
  const appData = join(homedir(), 'Library', 'Application Support') + sep
  for (const s of await listSessions({ includeProgrammatic: false })) {
    if (!s.cwd || s.cwd.startsWith(appData) || isUnder(s.cwd, scratchRoot)) continue
    if ((lastUsed.get(s.cwd) ?? 0) < s.lastModified) lastUsed.set(s.cwd, s.lastModified)
  }
  return [...lastUsed.entries()]
    .filter(([path]) => isDirectory(path))
    .sort((a, b) => b[1] - a[1])
    .slice(0, RECENT_LIMIT)
    .map(([path, used]) => ({ path, name: basename(path), lastUsed: used }))
}

/** A new empty folder for a project-less conversation: scratch-YYYY-MM-DD-xxxxxx. */
export function createScratchFolder(scratchRoot: string): string {
  const date = new Date().toISOString().slice(0, 10)
  const dir = join(scratchRoot, `scratch-${date}-${randomBytes(3).toString('hex')}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function projectName(cwd: string, scratchRoot: string): string | null {
  if (!cwd || isUnder(cwd, scratchRoot)) return null
  return basename(cwd)
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
