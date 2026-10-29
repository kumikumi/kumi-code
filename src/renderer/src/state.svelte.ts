// Renderer-side state: this window's tabs, the conversations they show and every
// code review, kept in sync with the main process through its events.

import type { ConversationMeta, Review, TranscriptItem, UsageWindow, WindowState } from '@shared/types'
import { errorMessage } from './util'

export const api = window.kumi

export const app = $state<{ window: WindowState | null; usage: UsageWindow | null; reviews: Review[] }>({ window: null, usage: null, reviews: [] })

// Callbacks the main process calls return nothing: the context bridge clones a
// return value back, and a Svelte state proxy cannot be cloned.
api.onWindowState((state) => {
  app.window = state
})
void api.getWindowState().then((state) => {
  app.window ??= state
})
api.onUsage((usage) => {
  app.usage = usage
})
void api.getUsage().then((usage) => {
  app.usage ??= usage
})
let reviewsReceived = false
api.onReviews((reviews) => {
  reviewsReceived = true
  app.reviews = reviews
})
void api.listReviews().then((reviews) => {
  if (!reviewsReceived) app.reviews = reviews
})

type Event = { kind: 'meta'; meta: ConversationMeta; rev: number } | { kind: 'items'; items: TranscriptItem[]; rev: number }

/**
 * A conversation shown in this window. Items are raw state: an update replaces
 * the changed items, and rows of unchanged ones are left alone.
 */
export class Conversation {
  meta = $state.raw<ConversationMeta | null>(null)
  items = $state.raw<TranscriptItem[]>([])
  error = $state<string | null>(null)
  rev = 0
  /** Events that arrived before the snapshot; null once it is loaded. */
  buffered: Event[] | null = []
  private readonly index = new Map<string, number>()

  apply(event: Event): void {
    // After a failed load the view shows the error; later events have nothing to build on.
    if (this.error !== null || event.rev <= this.rev) return
    this.rev = event.rev
    if (event.kind === 'meta') {
      this.meta = event.meta
      return
    }
    const items = [...this.items]
    for (const item of event.items) {
      const at = this.index.get(item.id)
      if (at === undefined) this.index.set(item.id, items.push(item) - 1)
      else items[at] = item
    }
    this.items = items
  }

  async load(id: string): Promise<void> {
    try {
      const snapshot = await api.getConversation(id)
      this.rev = snapshot.rev
      this.meta = snapshot.meta
      this.items = snapshot.items
      snapshot.items.forEach((item, i) => this.index.set(item.id, i))
      for (const event of this.buffered ?? []) this.apply(event)
    } catch (err) {
      this.error = errorMessage(err)
    }
    this.buffered = null
  }
}

const conversations = new Map<string, Conversation>()

/** The conversation's state; the first call fetches its snapshot. */
export function conversation(id: string): Conversation {
  let c = conversations.get(id)
  if (!c) {
    c = new Conversation()
    conversations.set(id, c)
    void c.load(id)
  }
  return c
}

/**
 * Drops conversations no longer shown in this window: while a conversation is
 * in another window, its events go there, so a kept copy would go stale.
 */
export function retain(ids: Set<string>): void {
  for (const id of conversations.keys()) if (!ids.has(id)) conversations.delete(id)
}

function receive(id: string, event: Event): void {
  const c = conversations.get(id)
  if (c?.buffered) c.buffered.push(event)
  else c?.apply(event)
}

api.onConversationMeta((id, meta, rev) => receive(id, { kind: 'meta', meta, rev }))
api.onConversationItems((id, items, rev) => receive(id, { kind: 'items', items, rev }))
