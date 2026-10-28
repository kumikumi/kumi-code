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
      { kind: 'tool', id: 'tu1', name: 'Bash', input: { command: 'ls' }, partialInput: null, result: { text: 'a\nb', isError: false, images: 0 }, children: [] },
    ])
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
    t.addUser('u1', 'first', [], false)
    t.addUser('u2', 'second', [], true)
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
})

describe('classifyStoredUserText', () => {
  it('recognises what Claude Code injects', () => {
    expect(classifyStoredUserText('<command-name>/model</command-name><command-args>opus</command-args>')).toEqual({ kind: 'user', text: '/model opus' })
    expect(classifyStoredUserText('[Request interrupted by user for tool use]')).toEqual({ kind: 'notice', text: 'Interrupted' })
    expect(classifyStoredUserText('<task-notification><summary>Tests passed</summary></task-notification>')).toEqual({ kind: 'notice', text: 'Tests passed' })
    expect(classifyStoredUserText('This session is being continued from a previous conversation that ran out of context.')).toEqual({ kind: 'compact' })
    expect(classifyStoredUserText('plain text')).toEqual({ kind: 'user', text: 'plain text' })
  })
})
