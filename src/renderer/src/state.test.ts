import { describe, expect, it, vi } from 'vitest'
import type { ConversationMeta, ConversationSnapshot, KumiApi, TranscriptItem } from '@shared/types'

// The store subscribes to the main process when it loads; these stand in for it.
const emit: { meta?: (id: string, meta: ConversationMeta, rev: number) => void; items?: (id: string, items: TranscriptItem[], rev: number) => void } = {}
const getConversation = vi.fn<(id: string) => Promise<ConversationSnapshot>>()
const kumi = {
  getWindowState: () => new Promise(() => {}),
  getUsage: () => new Promise(() => {}),
  onWindowState: () => () => {},
  onUsage: () => () => {},
  onReviews: () => () => {},
  listReviews: () => new Promise(() => {}),
  onBrowser: () => () => {},
  getBrowser: () => new Promise(() => {}),
  onTerminals: () => () => {},
  getTerminals: () => new Promise(() => {}),
  onConversationMeta: (cb: typeof emit.meta) => ((emit.meta = cb), () => {}),
  onConversationItems: (cb: typeof emit.items) => ((emit.items = cb), () => {}),
  getConversation,
} as unknown as KumiApi
Object.assign(globalThis, { window: { kumi } })
const { conversation } = await import('./state.svelte')

const meta = (title: string): ConversationMeta => ({ title }) as ConversationMeta
const text = (id: string, value: string): TranscriptItem => ({ kind: 'text', id, text: value, streaming: false })

describe('conversation store', () => {
  it('buffers events while the snapshot loads and drops those it already contains', async () => {
    let resolve!: (s: ConversationSnapshot) => void
    getConversation.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const c = conversation('a')
    emit.meta?.('a', meta('old'), 1)
    emit.items?.('a', [text('t1', 'Hello there')], 3)
    resolve({ meta: meta('snapshot'), items: [text('t1', 'Hello')], rev: 2 })
    await vi.waitFor(() => expect(c.buffered).toBeNull())
    expect(c.meta?.title).toBe('snapshot')
    expect(c.items).toEqual([text('t1', 'Hello there')])
  })

  it('replaces changed items and appends new ones', async () => {
    getConversation.mockResolvedValueOnce({ meta: meta('m'), items: [text('t1', 'a'), text('t2', 'b')], rev: 1 })
    const c = conversation('b')
    await vi.waitFor(() => expect(c.buffered).toBeNull())
    const unchanged = c.items[0]
    emit.items?.('b', [text('t2', 'b!'), text('t3', 'c')], 2)
    expect(c.items.map((i) => (i.kind === 'text' ? i.text : ''))).toEqual(['a', 'b!', 'c'])
    expect(c.items[0]).toBe(unchanged)
  })

  it('shows a failed load and ignores later events', async () => {
    getConversation.mockRejectedValueOnce(new Error("Error invoking remote method 'conversation:get': Error: Conversation c is not open"))
    const c = conversation('c')
    await vi.waitFor(() => expect(c.error).toBe('Conversation c is not open'))
    emit.meta?.('c', meta('late'), 5)
    emit.items?.('c', [text('t1', 'late')], 6)
    expect(c.meta).toBeNull()
    expect(c.items).toEqual([])
  })
})
