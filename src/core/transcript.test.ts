import { describe, expect, it } from 'vitest'
import { classifyStoredUserText, TranscriptBuilder } from './transcript'

const start = (id: string) => ({ type: 'message_start', message: { id } })
const blockStart = (index: number, content_block: Record<string, unknown>) => ({ type: 'content_block_start', index, content_block })
const delta = (index: number, d: Record<string, unknown>) => ({ type: 'content_block_delta', index, delta: d })

describe('TranscriptBuilder', () => {
  it('streams text and thinking, then settles them with the complete message', () => {
    const t = new TranscriptBuilder()
    t.applyStreamEvent(start('m1'), null)
    t.applyStreamEvent(blockStart(0, { type: 'thinking', thinking: '' }), null)
    t.applyStreamEvent(delta(0, { type: 'thinking_delta', thinking: 'Hmm' }), null)
    t.applyStreamEvent(blockStart(1, { type: 'text', text: '' }), null)
    t.applyStreamEvent(delta(1, { type: 'text_delta', text: 'Hel' }), null)
    t.applyStreamEvent(delta(1, { type: 'text_delta', text: 'lo' }), null)
    expect(t.items).toMatchObject([
      { kind: 'thinking', text: 'Hmm', streaming: true },
      { kind: 'text', text: 'Hello', streaming: true },
    ])
    expect(t.takeChanges()).toHaveLength(2)

    // Claude Code emits one assistant message per content block.
    t.applyAssistant({ id: 'm1', content: [{ type: 'thinking', thinking: 'Hmm.' }] }, null)
    t.applyAssistant({ id: 'm1', content: [{ type: 'text', text: 'Hello!' }] }, null)
    expect(t.items).toMatchObject([
      { kind: 'thinking', text: 'Hmm.', streaming: false },
      { kind: 'text', text: 'Hello!', streaming: false },
    ])
    expect(t.items).toHaveLength(2)
  })

  it('pairs tool results with their calls and streams tool input', () => {
    const t = new TranscriptBuilder()
    t.applyStreamEvent(start('m1'), null)
    t.applyStreamEvent(blockStart(0, { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }), null)
    t.applyStreamEvent(delta(0, { type: 'input_json_delta', partial_json: '{"command":' }), null)
    expect(t.items[0]).toMatchObject({ kind: 'tool', partialInput: '{"command":' })
    t.applyAssistant({ id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] }, null)
    t.applyToolResults({ content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'a\nb' }] }] })
    expect(t.items).toEqual([
      { kind: 'tool', id: 'tu1', name: 'Bash', input: { command: 'ls' }, partialInput: null, result: { text: 'a\nb', isError: false, images: [] }, children: [] },
    ])
  })

  it("shows a sent message's images as Claude Code echoes them", () => {
    const t = new TranscriptBuilder()
    t.addUser('u1', 'look', [{ mediaType: 'image/png', data: 'original' }], false, 1)
    t.takeChanges()
    const scaled = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'scaled' } }
    t.applyEcho('u1', { content: [scaled, { type: 'text', text: 'look' }] })
    expect(t.items[0]).toMatchObject({ kind: 'user', text: 'look', images: [{ mediaType: 'image/jpeg', data: 'scaled' }] })
    expect(t.takeChanges().map((i) => i.id)).toEqual(['u1'])
    // An echo of a message without images changes nothing.
    t.addUser('u2', 'hi', [], false, 2)
    t.takeChanges()
    t.applyEcho('u2', { content: 'hi' })
    expect(t.takeChanges()).toEqual([])
  })

  it('keeps the images of a tool result', () => {
    const t = new TranscriptBuilder()
    t.applyAssistant({ id: 'm1', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/a.png' } }] }, null)
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }
    t.applyToolResults({ content: [{ type: 'tool_result', tool_use_id: 'read', content: [image] }] })
    expect(t.items[0]).toMatchObject({ result: { text: '', images: [{ mediaType: 'image/png', data: 'iVBOR' }] } })
  })

  it('nests what a subagent does under the tool that started it', () => {
    const t = new TranscriptBuilder()
    t.applyAssistant({ id: 'm1', content: [{ type: 'tool_use', id: 'agent', name: 'Agent', input: { description: 'look' } }] }, null)
    t.takeChanges()
    t.applyAssistant({ id: 'm2', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/x' } }] }, 'agent')
    t.applyToolResults({ content: [{ type: 'tool_result', tool_use_id: 'read', content: 'file', is_error: true }] })
    expect(t.items).toHaveLength(1)
    const agent = t.items[0]
    expect(agent?.kind === 'tool' && agent.children).toMatchObject([{ kind: 'tool', id: 'read', result: { text: 'file', isError: true } }])
    // The change is reported against the top-level item.
    expect(t.takeChanges().map((i) => i.id)).toEqual(['agent'])
  })

  it('tracks queued user messages until they are delivered', () => {
    const t = new TranscriptBuilder()
    t.addUser('u1', 'first', [], false, 1)
    t.addUser('u2', 'second', [], true, 2)
    t.markDelivered(['u2'])
    expect(t.items).toMatchObject([{ queued: false }, { queued: false }])
  })

  it('keeps the task list the task tools build', () => {
    const t = new TranscriptBuilder()
    const call = (id: string, name: string, input: Record<string, unknown>, result: string, structured?: unknown): void => {
      t.applyAssistant({ id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] }, null)
      t.applyToolResults({ content: [{ type: 'tool_result', tool_use_id: id, content: result }] }, structured)
    }
    call('a', 'TaskCreate', { subject: 'Write tests', activeForm: 'Writing tests' }, 'Task #1 created successfully: Write tests', { task: { id: '1', subject: 'Write tests' } })
    // A stored session has no structured output; the id comes from the text.
    call('b', 'TaskCreate', { subject: 'Ship' }, 'Task #2 created successfully: Ship')
    call('c', 'TaskUpdate', { taskId: '1', status: 'in_progress' }, 'Updated task #1 status')
    expect(t.takeTasksChanged()).toBe(true)
    expect(t.tasks).toEqual([
      { id: '1', subject: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' },
      { id: '2', subject: 'Ship', activeForm: 'Ship', status: 'pending' },
    ])
    call('d', 'TaskUpdate', { taskId: '2', status: 'deleted' }, 'Updated task #2 status')
    expect(t.tasks.map((x) => x.id)).toEqual(['1'])
  })

  it('reads a stored session', () => {
    const t = new TranscriptBuilder()
    t.applyHistory([
      { type: 'user', uuid: 'u1', parent_tool_use_id: null, message: { role: 'user', content: 'Fix the bug' } },
      { type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } },
      { type: 'user', uuid: 'u2', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'code' }] } },
      { type: 'user', uuid: 'u3', parent_tool_use_id: null, message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-args></command-args>' } },
      { type: 'user', uuid: 'u4', parent_tool_use_id: null, message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' } },
      { type: 'user', uuid: 'u5', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] } },
    ])
    expect(t.items.map((i) => i.kind)).toEqual(['user', 'text', 'tool', 'user', 'command_output'])
    expect(t.items[2]).toMatchObject({ result: { text: 'code' } })
    expect(t.items[3]).toMatchObject({ text: '/compact' })
  })

  describe('turn timing', () => {
    const T = Date.UTC(2026, 10, 1, 12)
    const iso = (s: number): string => new Date(T + s * 1000).toISOString()
    const user = (uuid: string, s: number, content: unknown) => ({ type: 'user' as const, uuid, parent_tool_use_id: null, timestamp: iso(s), message: { role: 'user', content } })
    const reply = (uuid: string, s: number, text: string, parent: string | null = null) => ({ type: 'assistant' as const, uuid, parent_tool_use_id: parent, timestamp: iso(s), message: { id: `m-${uuid}`, content: [{ type: 'text', text }] } })
    const call = (uuid: string, s: number, id: string, name: string) => ({ type: 'assistant' as const, uuid, parent_tool_use_id: null, timestamp: iso(s), message: { id: `m-${uuid}`, content: [{ type: 'tool_use', id, name, input: {} }] } })

    it('times the turns of a stored session by their main-thread messages', () => {
      const t = new TranscriptBuilder()
      t.applyHistory([
        user('u1', 0, 'Fix it'),
        call('a1', 2, 'agent', 'Agent'),
        reply('s1', 30, 'Subagent work does not end the turn', 'agent'),
        user('r1', 40, [{ type: 'tool_result', tool_use_id: 'agent', content: 'done' }]),
        reply('a2', 45, 'Fixed.'),
        user('u2', 100, 'Now this'),
        reply('a3', 101, 'Stopping'),
        user('i1', 102, '[Request interrupted by user]'),
        user('n1', 200, '<task-notification><summary>Tests passed</summary></task-notification>'),
        reply('a4', 203, 'Noted.'),
        user('u3', 300, '/cost'),
        user('o1', 300, '<local-command-stdout>$0</local-command-stdout>'),
      ])
      expect(t.items.map((i) => i.kind)).toEqual(['user', 'tool', 'text', 'turn', 'user', 'text', 'notice', 'turn', 'notice', 'text', 'turn', 'user', 'command_output'])
      expect(t.items[0]).toMatchObject({ at: T })
      expect(t.items[3]).toMatchObject({ startedAt: T, finishedAt: T + 45_000, messageId: 'a2' })
      // Interrupted: the turn ends with what came before the interruption.
      expect(t.items[7]).toMatchObject({ startedAt: T + 100_000, finishedAt: T + 101_000, messageId: 'a3' })
      // A background task's notification starts a turn of its own.
      expect(t.items[10]).toMatchObject({ startedAt: T + 200_000, finishedAt: T + 203_000, messageId: 'a4' })
      // A local command gets no reply, so no timing.
      expect(t.turnStartedAt).toBeNull()
    })

    it("ends a fork's copy where it was forked, with its last message's own time", () => {
      const t = new TranscriptBuilder()
      const forkedAt = T + 3600_000
      // forkSession stamped a2, written at 8 s, with the time of the fork.
      t.applyHistory(
        [user('u1', 0, 'Fix it'), reply('a1', 5, 'Looking'), reply('a2', 3600, 'Fixed.'), user('u2', 3700, 'And this?'), reply('a3', 3702, 'Done.')],
        { id: 'source', title: 'Fix it', at: forkedAt, lastAt: T + 8000 },
      )
      expect(t.items.map((i) => i.kind)).toEqual(['user', 'text', 'text', 'turn', 'fork', 'user', 'text', 'turn'])
      expect(t.items[3]).toMatchObject({ startedAt: T, finishedAt: T + 8000, messageId: 'a2' })
      expect(t.items[4]).toMatchObject({ fromId: 'source', fromTitle: 'Fix it' })
      expect(t.items[7]).toMatchObject({ startedAt: T + 3700_000, finishedAt: T + 3702_000 })
    })

    it('times live turns that got a reply', () => {
      const t = new TranscriptBuilder()
      t.addUser('u1', 'hi', [], false, 1000)
      t.startTurn(1000)
      // A message sent while the turn runs joins it.
      t.addUser('u2', 'also', [], true, 1500)
      t.startTurn(1500)
      expect(t.turnStartedAt).toBe(1000)
      t.touchTurn(4000, 'a1')
      t.endTurn()
      expect(t.items.at(-1)).toMatchObject({ kind: 'turn', startedAt: 1000, finishedAt: 4000, messageId: 'a1' })
      t.startTurn(5000)
      t.endTurn()
      expect(t.items.filter((i) => i.kind === 'turn')).toHaveLength(1)
      expect(t.hasMessages).toBe(true)
    })
  })
})

describe('classifyStoredUserText', () => {
  it('recognises what Claude Code injects', () => {
    expect(classifyStoredUserText('<command-name>/model</command-name><command-args>opus</command-args>')).toEqual({ kind: 'user', text: '/model opus' })
    expect(classifyStoredUserText('[Request interrupted by user for tool use]')).toEqual({ kind: 'interrupted' })
    expect(classifyStoredUserText('<task-notification><summary>Tests passed</summary></task-notification>')).toEqual({ kind: 'notice', text: 'Tests passed' })
    expect(classifyStoredUserText('This session is being continued from a previous conversation that ran out of context.')).toEqual({ kind: 'compact' })
    expect(classifyStoredUserText('plain text')).toEqual({ kind: 'user', text: 'plain text' })
  })
})
