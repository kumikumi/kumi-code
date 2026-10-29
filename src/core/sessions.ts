// Past conversations and recent projects, read from Claude Code's session store
// and Kumi Code's own state.

import { listSessions } from '@anthropic-ai/claude-agent-sdk'
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { randomBytes } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import type { ConversationSummary, RecentProject } from '@shared/types'
import type { StoredState } from './store'

const RECENT_LIMIT = 12
const TAIL_BYTES = 64 * 1024

/**
 * Conversations started or opened in Kumi Code, most recently active first; with
 * `all`, every Claude Code session on this machine.
 */
export async function listConversations(state: Readonly<StoredState>, scratchRoot: string, all: boolean): Promise<ConversationSummary[]> {
  const sessions = (await listSessions({ includeProgrammatic: true })).filter((s) => all || s.sessionId in state.conversations)
  const active = await withLastActivity(sessions)
  return active
    .map(({ session: s, lastActive }) => {
      const stored = state.conversations[s.sessionId]
      const cwd = stored?.cwd ?? s.cwd ?? ''
      return {
        id: s.sessionId,
        title: s.customTitle ?? s.summary,
        cwd,
        project: projectName(cwd, scratchRoot),
        lastActive,
        gitBranch: s.gitBranch && s.gitBranch !== 'HEAD' ? s.gitBranch : null,
        kumi: stored !== undefined,
      }
    })
    .sort((a, b) => b.lastActive - a.lastActive)
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
  const sessions = (await listSessions({ includeProgrammatic: false })).filter((s) => s.cwd && !s.cwd.startsWith(appData) && !isUnder(s.cwd, scratchRoot))
  for (const { session, lastActive } of await withLastActivity(sessions)) {
    const cwd = session.cwd ?? ''
    if ((lastUsed.get(cwd) ?? 0) < lastActive) lastUsed.set(cwd, lastActive)
  }
  return [...lastUsed.entries()]
    .filter(([path]) => isDirectory(path))
    .sort((a, b) => b[1] - a[1])
    .slice(0, RECENT_LIMIT)
    .map(([path, used]) => ({ path, name: basename(path), lastUsed: used }))
}

/**
 * Sessions with the time of their last message. A transcript file's modification
 * time is no use for this: Claude Code appends bookkeeping records (cost totals,
 * tool latches) whenever a process for the session exits, also when nothing was
 * said. Sessions without any message are left out.
 */
async function withLastActivity(sessions: SDKSessionInfo[]): Promise<{ session: SDKSessionInfo; lastActive: number }[]> {
  const files = await transcriptFiles()
  const result = await Promise.all(
    sessions.map(async (session) => {
      // A session deleted between listing it and reading the folder is gone.
      const file = files.get(session.sessionId)
      const lastActive = file ? await lastMessageTime(file).catch(unlessDeleted) : null
      return lastActive === null ? [] : [{ session, lastActive }]
    }),
  )
  return result.flat()
}

/** Session id → transcript path, for every session under Claude Code's projects folder. */
async function transcriptFiles(): Promise<Map<string, string>> {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  const files = new Map<string, string>()
  for (const dir of await readdir(projects, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    for (const name of await readdir(join(projects, dir.name))) {
      if (name.endsWith('.jsonl')) files.set(name.slice(0, -'.jsonl'.length), join(projects, dir.name, name))
    }
  }
  return files
}

/**
 * The timestamp of the last user or assistant entry of a transcript, read from
 * its end, or null when it has none.
 */
export async function lastMessageTime(path: string): Promise<number | null> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    for (let span = Math.min(TAIL_BYTES, size); ; span = Math.min(span * 4, size)) {
      const buffer = Buffer.alloc(span)
      await file.read(buffer, 0, span, size - span)
      const lines = buffer.toString('utf8').split('\n')
      // Unless the whole file was read, the first line is cut.
      if (span < size) lines.shift()
      for (let i = lines.length - 1; i >= 0; i--) {
        const time = messageTime(lines[i] ?? '')
        if (time !== null) return time
      }
      if (span === size) return null
    }
  } finally {
    await file.close()
  }
}

function unlessDeleted(err: unknown): null {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
  throw err
}

function messageTime(line: string): number | null {
  if (!line.startsWith('{')) return null
  let record: { type?: unknown; timestamp?: unknown }
  try {
    record = JSON.parse(line) as typeof record
  } catch {
    // The CLI may be appending this line right now.
    return null
  }
  if ((record.type !== 'user' && record.type !== 'assistant') || typeof record.timestamp !== 'string') return null
  const time = Date.parse(record.timestamp)
  return Number.isNaN(time) ? null : time
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
