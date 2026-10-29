// Builds the transcript the UI shows from what the Agent SDK emits: stream events
// while a reply is generated, complete assistant messages, tool results, and the
// stored messages of a session that is opened again.
//
// Items are mutated in place and every change is recorded against the top-level
// item it belongs to, so the caller can send the changed top-level items as one
// batch. New top-level items are only ever appended.

import type { ImageData, TaskInfo, ToolResult, TranscriptItem } from '@shared/types'
import { parseRelay } from './review'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>
type TextItem = Extract<TranscriptItem, { kind: 'text' | 'thinking' }>

/** The subset of Anthropic API content blocks the transcript uses. */
interface Block {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  source?: { type?: string; media_type?: string; data?: string }
}

interface ApiMessage {
  id?: string
  content?: string | Block[]
}

interface StreamEvent {
  type: string
  index?: number
  message?: { id?: string }
  content_block?: Block
  delta?: { type: string; text?: string; thinking?: string; partial_json?: string }
}

export interface StoredMessage {
  type: 'user' | 'assistant' | 'system'
  uuid: string
  message: unknown
  parent_tool_use_id: string | null
}

export class TranscriptBuilder {
  readonly items: TranscriptItem[] = []
  /** Claude Code's task list, as the task tools built it. */
  tasks: TaskInfo[] = []
  private tasksChanged = false
  private readonly tools = new Map<string, ToolItem>()
  private readonly rootOf = new Map<TranscriptItem, TranscriptItem>()
  private readonly changed = new Set<TranscriptItem>()
  /** API message id being streamed, per parent tool use ('' for the main thread). */
  private readonly streaming = new Map<string, string>()
  /** Stream block `${messageId}:${index}` → the item it fills. */
  private readonly blocks = new Map<string, TranscriptItem>()
  /** Text and thinking items created by streaming, waiting for their complete message. */
  private readonly streamed = new Map<string, TextItem[]>()
  private counter = 0

  /** Whether the task list changed since the last call. */
  takeTasksChanged(): boolean {
    const changed = this.tasksChanged
    this.tasksChanged = false
    return changed
  }

  /** The changed top-level items since the last call, in transcript order for new ones. */
  takeChanges(): TranscriptItem[] {
    const list = [...this.changed]
    this.changed.clear()
    return list
  }

  addUser(id: string, text: string, images: ImageData[], queued: boolean): void {
    this.add({ kind: 'user', id, text, images, queued, relay: parseRelay(text) }, null)
  }

  /** The input of a tool call, at any depth. */
  toolInput(id: string): { name: string; input: Record<string, unknown> } | undefined {
    const tool = this.tools.get(id)
    return tool && { name: tool.name, input: tool.input }
  }

  /** Marks queued user messages as delivered. */
  markDelivered(ids: Iterable<string>): void {
    const wanted = new Set(ids)
    for (const item of this.items) {
      if (item.kind === 'user' && item.queued && wanted.has(item.id)) {
        item.queued = false
        this.touch(item)
      }
    }
  }

  markAllDelivered(): void {
    for (const item of this.items) {
      if (item.kind === 'user' && item.queued) {
        item.queued = false
        this.touch(item)
      }
    }
  }

  addNotice(level: 'info' | 'error', text: string): void {
    this.add({ kind: 'notice', id: this.nextId('notice'), level, text }, null)
  }

  addCommandOutput(text: string): void {
    if (text.trim()) this.add({ kind: 'command_output', id: this.nextId('command'), text }, null)
  }

  addCompact(trigger: 'manual' | 'auto', preTokens: number): void {
    this.add({ kind: 'compact', id: this.nextId('compact'), trigger, preTokens }, null)
  }

  /** Ends every stream in progress, e.g. after an interrupt. */
  endStreams(): void {
    for (const list of this.streamed.values()) {
      for (const item of list) {
        item.streaming = false
        this.touch(item)
      }
    }
    for (const tool of this.tools.values()) {
      if (tool.partialInput !== null) {
        tool.partialInput = null
        this.touch(tool)
      }
    }
    this.streamed.clear()
    this.blocks.clear()
    this.streaming.clear()
  }

  applyStreamEvent(raw: unknown, parentToolUseId: string | null): void {
    const event = raw as StreamEvent
    const key = parentToolUseId ?? ''
    if (event.type === 'message_start') {
      if (event.message?.id) this.streaming.set(key, event.message.id)
      return
    }
    if (event.type === 'message_stop') {
      this.streaming.delete(key)
      return
    }
    const messageId = this.streaming.get(key)
    if (messageId === undefined || event.index === undefined) return
    const blockKey = `${messageId}:${event.index}`

    if (event.type === 'content_block_start' && event.content_block) {
      const block = event.content_block
      if (block.type === 'text' || block.type === 'thinking') {
        const item: TextItem =
          block.type === 'text'
            ? { kind: 'text', id: this.nextId(messageId), text: block.text ?? '', streaming: true }
            : { kind: 'thinking', id: this.nextId(messageId), text: block.thinking ?? '', streaming: true }
        this.add(item, parentToolUseId)
        this.blocks.set(blockKey, item)
        const list = this.streamed.get(messageId) ?? []
        list.push(item)
        this.streamed.set(messageId, list)
      } else if (block.type === 'tool_use' && block.id && !this.tools.has(block.id)) {
        const item: ToolItem = { kind: 'tool', id: block.id, name: block.name ?? 'unknown', input: {}, partialInput: '', result: null, children: [] }
        this.add(item, parentToolUseId)
        this.blocks.set(blockKey, item)
      }
      return
    }

    if (event.type === 'content_block_delta' && event.delta) {
      const item = this.blocks.get(blockKey)
      if (!item) return
      const delta = event.delta
      if (delta.type === 'text_delta' && item.kind === 'text') item.text += delta.text ?? ''
      else if (delta.type === 'thinking_delta' && item.kind === 'thinking') item.text += delta.thinking ?? ''
      else if (delta.type === 'input_json_delta' && item.kind === 'tool' && item.partialInput !== null) item.partialInput += delta.partial_json ?? ''
      else return
      this.touch(item)
    }
  }

  applyAssistant(raw: unknown, parentToolUseId: string | null): void {
    const message = raw as ApiMessage
    if (!Array.isArray(message.content)) return
    const messageId = message.id ?? this.nextId('message')
    const pending = this.streamed.get(messageId) ?? []
    for (const block of message.content) {
      if (block.type === 'text' || block.type === 'thinking') {
        const text = (block.type === 'text' ? block.text : block.thinking) ?? ''
        const index = pending.findIndex((p) => p.kind === block.type)
        const item = index === -1 ? undefined : pending.splice(index, 1)[0]
        if (item) {
          item.text = text
          item.streaming = false
          this.touch(item)
        } else if (text.trim()) {
          this.add(block.type === 'text' ? { kind: 'text', id: this.nextId(messageId), text, streaming: false } : { kind: 'thinking', id: this.nextId(messageId), text, streaming: false }, parentToolUseId)
        }
      } else if (block.type === 'tool_use' && block.id) {
        const input = isRecord(block.input) ? block.input : {}
        const existing = this.tools.get(block.id)
        if (existing) {
          existing.input = input
          existing.partialInput = null
          this.touch(existing)
        } else {
          this.add({ kind: 'tool', id: block.id, name: block.name ?? 'unknown', input, partialInput: null, result: null, children: [] }, parentToolUseId)
        }
      }
    }
    if (pending.length === 0) this.streamed.delete(messageId)
  }

  /**
   * Tool results in a user message. Other user content is handled by the caller.
   * `structured` is the tool's own output, which live messages carry for their
   * single tool result.
   */
  applyToolResults(raw: unknown, structured?: unknown): void {
    const message = raw as ApiMessage
    if (!Array.isArray(message.content)) return
    const results = message.content.filter((b) => b.type === 'tool_result' && b.tool_use_id)
    for (const block of results) {
      const tool = this.tools.get(block.tool_use_id ?? '')
      if (!tool) continue
      tool.result = toolResult(block)
      this.touch(tool)
      if (!tool.result.isError) this.trackTask(tool, tool.result.text, results.length === 1 ? structured : undefined)
    }
  }

  /** A session's stored messages, as getSessionMessages returns them. */
  applyHistory(messages: StoredMessage[]): void {
    for (const m of messages) {
      if (m.type === 'assistant') {
        this.applyAssistant(m.message, m.parent_tool_use_id)
      } else if (m.type === 'user') {
        const message = m.message as ApiMessage
        if (Array.isArray(message.content) && message.content.some((b) => b.type === 'tool_result')) {
          this.applyToolResults(message)
          continue
        }
        this.applyStoredUserText(m.uuid, message)
      }
    }
  }

  private applyStoredUserText(uuid: string, message: ApiMessage): void {
    const blocks: Block[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content ?? [])
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
    const images = blocks.flatMap((b) => imageOf(b))
    const stored = classifyStoredUserText(text)
    switch (stored.kind) {
      case 'user':
        this.addUser(uuid, stored.text, images, false)
        return
      case 'command_output':
        this.addCommandOutput(stored.text)
        return
      case 'notice':
        this.addNotice('info', stored.text)
        return
      case 'compact':
        this.add({ kind: 'compact', id: uuid, trigger: null, preTokens: null }, null)
        return
      case 'hidden':
        return
    }
  }

  private trackTask(tool: ToolItem, text: string, structured: unknown): void {
    const input = tool.input
    if (tool.name === 'TaskCreate') {
      // Stored sessions only keep the result text: "Task #3 created successfully: ...".
      const id = (structured as { task?: { id?: unknown } } | undefined)?.task?.id ?? /^Task #(\S+) created/.exec(text)?.[1]
      if (typeof id !== 'string') return
      const subject = stringOf(input.subject)
      this.tasks = [...this.tasks.filter((t) => t.id !== id), { id, subject, activeForm: stringOf(input.activeForm) || subject, status: 'pending' }]
    } else if (tool.name === 'TaskUpdate') {
      const id = stringOf(input.taskId)
      if (input.status === 'deleted') {
        this.tasks = this.tasks.filter((t) => t.id !== id)
      } else {
        this.tasks = this.tasks.map((t) =>
          t.id !== id
            ? t
            : {
                ...t,
                subject: stringOf(input.subject) || t.subject,
                activeForm: stringOf(input.activeForm) || t.activeForm,
                status: isTaskStatus(input.status) ? input.status : t.status,
              },
        )
      }
    } else if (tool.name === 'TaskList') {
      const listed = (structured as { tasks?: { id: string; subject: string; status: unknown }[] } | undefined)?.tasks
      if (!listed) return
      this.tasks = listed.map((l) => {
        const known = this.tasks.find((t) => t.id === l.id)
        return { id: l.id, subject: l.subject, activeForm: known?.activeForm ?? l.subject, status: isTaskStatus(l.status) ? l.status : 'pending' }
      })
    } else {
      return
    }
    this.tasksChanged = true
  }

  private add(item: TranscriptItem, parentToolUseId: string | null): void {
    const parent = parentToolUseId === null ? undefined : this.tools.get(parentToolUseId)
    if (parent) {
      parent.children.push(item)
      this.rootOf.set(item, this.rootOf.get(parent) ?? parent)
    } else {
      this.items.push(item)
      this.rootOf.set(item, item)
    }
    if (item.kind === 'tool') this.tools.set(item.id, item)
    this.touch(item)
  }

  private touch(item: TranscriptItem): void {
    const root = this.rootOf.get(item)
    if (root) this.changed.add(root)
  }

  private nextId(prefix: string): string {
    return `${prefix}:${this.counter++}`
  }
}

export type StoredUserText =
  | { kind: 'user'; text: string }
  | { kind: 'command_output'; text: string }
  | { kind: 'notice'; text: string }
  | { kind: 'compact' }
  | { kind: 'hidden' }

/**
 * Claude Code stores some things it injects as user messages: slash command
 * invocations and their output, system reminders, background task
 * notifications, interruptions and compaction summaries.
 */
export function classifyStoredUserText(raw: string): StoredUserText {
  const text = raw.trim()
  const command = /^<command-name>([^<]*)<\/command-name>/.exec(text)
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? ''
    const name = command[1]?.trim() ?? ''
    return { kind: 'user', text: args ? `${name} ${args}` : name }
  }
  const stdout = /^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text)
  if (stdout) return { kind: 'command_output', text: stdout[1] ?? '' }
  if (text.startsWith('<system-reminder>') || text.startsWith('<local-command-caveat>')) return { kind: 'hidden' }
  if (text.startsWith('<task-notification>')) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim()
    return { kind: 'notice', text: summary ?? 'Background task update' }
  }
  if (text.startsWith('[Request interrupted by user')) return { kind: 'notice', text: 'Interrupted' }
  if (text.startsWith('This session is being continued from a previous conversation')) return { kind: 'compact' }
  return { kind: 'user', text: raw }
}

function toolResult(block: Block): ToolResult {
  const content = block.content
  if (typeof content === 'string') return { text: content, isError: block.is_error === true, images: 0 }
  const parts = Array.isArray(content) ? (content as Block[]) : []
  return {
    text: parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('\n'),
    isError: block.is_error === true,
    images: parts.filter((p) => p.type === 'image').length,
  }
}

function imageOf(block: Block): ImageData[] {
  if (block.type !== 'image' || block.source?.type !== 'base64' || !block.source.media_type || !block.source.data) return []
  return [{ mediaType: block.source.media_type, data: block.source.data }]
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isTaskStatus(value: unknown): value is TaskInfo['status'] {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
