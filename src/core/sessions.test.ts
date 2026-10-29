import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lastMessageTime } from './sessions'

const dir = mkdtempSync(join(tmpdir(), 'kumi-sessions-'))
const file = (name: string, lines: unknown[], tail = ''): string => {
  const path = join(dir, name)
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n' + tail)
  return path
}

describe('lastMessageTime', () => {
  it('skips the bookkeeping records Claude Code appends after the last message', async () => {
    const path = file('a.jsonl', [
      { type: 'user', timestamp: '2026-10-20T10:00:00.000Z' },
      { type: 'assistant', timestamp: '2026-10-20T10:00:05.000Z' },
      { type: 'cost-state', sessionId: 'x' },
      { type: 'tools-used', sessionId: 'x' },
    ])
    expect(await lastMessageTime(path)).toBe(Date.parse('2026-10-20T10:00:05.000Z'))
  })

  it('reads further back when the tail has no message, and ignores a line being written', async () => {
    const big = { type: 'cost-state', blob: 'x'.repeat(200_000) }
    const path = file('b.jsonl', [{ type: 'user', timestamp: '2026-10-01T08:00:00.000Z' }, big], '{"type":"assistant","timest')
    expect(await lastMessageTime(path)).toBe(Date.parse('2026-10-01T08:00:00.000Z'))
  })

  it('is null for a transcript without messages', async () => {
    expect(await lastMessageTime(file('c.jsonl', [{ type: 'summary' }]))).toBeNull()
  })
})
