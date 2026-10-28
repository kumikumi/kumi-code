// Renderer-side state: this window's tabs and the conversations they show, kept
// in sync with the main process through its events.

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ConversationMeta, ConversationSnapshot, TranscriptItem, UsageWindow, WindowState } from '@shared/types'

const api = window.kumi

export function useWindowState(): WindowState | null {
  const [state, setState] = useState<WindowState | null>(null)
  useEffect(() => {
    const off = api.onWindowState(setState)
    void api.getWindowState().then(setState)
    return off
  }, [])
  return state
}

export function useUsage(): UsageWindow | null {
  const [usage, setUsage] = useState<UsageWindow | null>(null)
  useEffect(() => {
    const off = api.onUsage(setUsage)
    void api.getUsage().then((u) => setUsage((current) => current ?? u))
    return off
  }, [])
  return usage
}

export interface ConversationState {
  meta: ConversationMeta
  items: TranscriptItem[]
  rev: number
}

type Event = { kind: 'meta'; meta: ConversationMeta; rev: number } | { kind: 'items'; items: TranscriptItem[]; rev: number }

/**
 * Conversations shown in this window. A conversation's snapshot is fetched when
 * a view first subscribes; events that arrive meanwhile are buffered and those
 * the snapshot already contains are dropped.
 */
class Conversations {
  private readonly states = new Map<string, ConversationState>()
  private readonly indexes = new Map<string, Map<string, number>>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly pending = new Map<string, Event[]>()
  readonly errors = new Map<string, string>()

  constructor() {
    api.onConversationMeta((id, meta, rev) => this.receive(id, { kind: 'meta', meta, rev }))
    api.onConversationItems((id, items, rev) => this.receive(id, { kind: 'items', items, rev }))
  }

  get(id: string): ConversationState | undefined {
    return this.states.get(id)
  }

  subscribe(id: string, cb: () => void): () => void {
    let set = this.listeners.get(id)
    if (!set) {
      set = new Set()
      this.listeners.set(id, set)
    }
    set.add(cb)
    if (!this.states.has(id) && !this.pending.has(id)) void this.load(id)
    return () => {
      set.delete(cb)
    }
  }

  /**
   * Drops conversations no longer shown in this window: while a conversation is
   * in another window, its events go there, so a kept copy would go stale.
   */
  retain(ids: Set<string>): void {
    for (const id of [...this.states.keys(), ...this.errors.keys()]) {
      if (ids.has(id)) continue
      this.states.delete(id)
      this.indexes.delete(id)
      this.errors.delete(id)
    }
  }

  private async load(id: string): Promise<void> {
    this.pending.set(id, [])
    let snapshot: ConversationSnapshot
    try {
      snapshot = await api.getConversation(id)
    } catch (err) {
      this.pending.delete(id)
      this.errors.set(id, err instanceof Error ? err.message : String(err))
      this.notify(id)
      return
    }
    const buffered = this.pending.get(id) ?? []
    this.pending.delete(id)
    this.indexes.set(id, new Map(snapshot.items.map((item, i) => [item.id, i])))
    this.states.set(id, { meta: snapshot.meta, items: snapshot.items, rev: snapshot.rev })
    for (const event of buffered) this.apply(id, event)
    this.notify(id)
  }

  private receive(id: string, event: Event): void {
    const buffer = this.pending.get(id)
    if (buffer) {
      buffer.push(event)
      return
    }
    if (!this.states.has(id)) return
    this.apply(id, event)
    this.notify(id)
  }

  private apply(id: string, event: Event): void {
    const state = this.states.get(id)
    if (!state || event.rev <= state.rev) return
    if (event.kind === 'meta') {
      this.states.set(id, { ...state, meta: event.meta, rev: event.rev })
      return
    }
    const index = this.indexes.get(id) ?? new Map<string, number>()
    const items = [...state.items]
    for (const item of event.items) {
      const at = index.get(item.id)
      if (at === undefined) {
        index.set(item.id, items.length)
        items.push(item)
      } else {
        items[at] = item
      }
    }
    this.indexes.set(id, index)
    this.states.set(id, { ...state, items, rev: event.rev })
  }

  private notify(id: string): void {
    for (const cb of this.listeners.get(id) ?? []) cb()
  }
}

export const conversations = new Conversations()

export function useConversation(id: string): ConversationState | undefined {
  return useSyncExternalStore(
    (cb) => conversations.subscribe(id, cb),
    () => conversations.get(id),
  )
}
