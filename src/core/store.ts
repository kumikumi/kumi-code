// Kumi Code's own state: the window layout, which conversations were started (or
// opened) in Kumi Code and with which settings, recently used projects, and code
// reviews. The conversations themselves live in Claude Code's session transcripts.
//
// One JSON file, written atomically and debounced. A file from another version
// is an error, not something to migrate.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EffortLevel, PermissionMode, Review } from '@shared/types'

const VERSION = 2
const WRITE_DELAY_MS = 300

export interface StoredBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface StoredWindow {
  bounds: StoredBounds | null
  /** Conversation id per tab; null for a new tab page. */
  tabs: (string | null)[]
  activeIndex: number
}

export interface StoredConversation {
  cwd: string
  /** The conversation has a folder of its own under the scratch root. */
  scratch: boolean
  createdAt: number
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
}

export interface StoredState {
  version: typeof VERSION
  windows: StoredWindow[]
  conversations: Record<string, StoredConversation>
  recents: { path: string; lastUsed: number }[]
  reviews: Record<string, Review>
  /** What the user last picked in the menus, which new conversations start with. Absent: never picked. */
  lastPicked?: Partial<Pick<StoredConversation, 'model' | 'effort' | 'permissionMode'>>
}

export class Store {
  private state: StoredState
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly path: string) {
    this.state = load(path)
  }

  get(): Readonly<StoredState> {
    return this.state
  }

  update(fn: (state: StoredState) => void): void {
    fn(this.state)
    this.timer ??= setTimeout(() => this.flush(), WRITE_DELAY_MS)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    renameSync(tmp, this.path)
  }
}

function load(path: string): StoredState {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: VERSION, windows: [], conversations: {}, recents: [], reviews: {} }
    throw err
  }
  const parsed = JSON.parse(raw) as { version?: unknown }
  if (parsed.version !== VERSION) {
    throw new Error(`${path} is from another version of Kumi Code (version ${String(parsed.version)}, expected ${VERSION}). Move it away to start fresh.`)
  }
  return parsed as StoredState
}
