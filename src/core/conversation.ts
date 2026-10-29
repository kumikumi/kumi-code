// One conversation: a Claude Code session driven through the Agent SDK.
//
// While the conversation is in use it holds one long-lived query() in streaming
// input mode, which is one Claude Code process. Messages go in through an input
// queue, so they can be sent while a turn runs; everything the process emits is
// folded into the transcript and the meta, and the owner is told what changed.
//
// The agent is Claude Code itself: its system prompt, its tools, every skill,
// and the user's, project's and local settings, so CLAUDE.md, plugins, MCP
// servers, hooks and permission rules apply as they do in the CLI.

import { getSessionInfo, getSessionMessages, query } from '@anthropic-ai/claude-agent-sdk'
import type { CanUseTool, McpServerConfig, Options, PermissionResult, PermissionUpdate, Query, SDKMessage, SDKRateLimitInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  ConversationMeta,
  EffortLevel,
  ImageData,
  ModelOption,
  PendingRequest,
  PermissionMode,
  Question,
  RequestResponse,
  TranscriptItem,
  UsageWindow,
} from '@shared/types'
import { loginCommand } from './auth'
import { agentEnvironment } from './environment'
import { InputQueue } from './input-queue'
import { REVIEW_TOOLS } from './review-tools'
import { TranscriptBuilder } from './transcript'
import type { StoredMessage } from './transcript'

export interface ConversationSettings {
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
}

export interface ConversationEvents {
  onMeta(meta: ConversationMeta): void
  onItems(items: TranscriptItem[]): void
  onUsage(usage: UsageWindow): void
  onSettings(settings: ConversationSettings): void
  /** The session's title or modification time may have changed. */
  onSessionChanged(): void
}

interface Pending {
  request: PendingRequest
  input: Record<string, unknown>
  suggestions: PermissionUpdate[] | undefined
  resolve: (result: PermissionResult) => void
}

/** How often streamed text is flushed to the UI. */
const FLUSH_MS = 40
const UNTITLED = 'New conversation'

export class Conversation {
  private readonly transcript = new TranscriptBuilder()
  private readonly meta: ConversationMeta
  private readonly pending = new Map<string, Pending>()
  private q: Query | null = null
  private input: InputQueue<SDKUserMessage> | null = null
  private starting: Promise<void> | null = null
  private flushTimer: NodeJS.Timeout | null = null
  /** The session has a transcript on disk, so a new process resumes it. Known after load(). */
  private persisted = false
  private loaded: Promise<void> | null = null
  private stderr: string[] = []
  private lastActivity = Date.now()
  private interrupting = false
  /** Settles when the last Claude Code process this conversation started has exited. */
  private exited: Promise<void> = Promise.resolve()
  /** The failed request reported in this turn, so the turn's result does not repeat it. */
  private lastError: string | null = null
  /** Context the last main-thread request used, in tokens, and its model. */
  private contextTokens: number | null = null
  private contextModel: string | null = null
  /** The MCP servers Kumi Code gives the agent; made anew for every process. */
  private mcpServers: () => Record<string, McpServerConfig> = () => ({})

  constructor(
    readonly id: string,
    readonly cwd: string,
    project: string | null,
    settings: ConversationSettings,
    private readonly events: ConversationEvents,
  ) {
    this.meta = {
      id,
      cwd,
      project,
      title: UNTITLED,
      status: 'cold',
      error: null,
      compacting: false,
      model: settings.model,
      effort: settings.effort,
      permissionMode: settings.permissionMode,
      models: [],
      commands: [],
      contextPercent: null,
      requests: [],
      tasks: [],
      draft: '',
    }
  }

  snapshotMeta(): ConversationMeta {
    return { ...this.meta, requests: [...this.meta.requests] }
  }

  snapshotItems(): TranscriptItem[] {
    return this.transcript.items
  }

  get idleSince(): number | null {
    if (this.q === null || this.meta.status === 'running' || this.pending.size > 0) return null
    return this.lastActivity
  }

  /** Reads the stored transcript, if the session has one yet. Idempotent. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      const info = await getSessionInfo(this.id, { dir: this.cwd })
      if (!info) return
      const messages = await getSessionMessages(this.id, { dir: this.cwd })
      this.persisted = true
      this.transcript.applyHistory(messages as StoredMessage[])
      this.transcript.takeTasksChanged()
      this.meta.tasks = this.transcript.tasks
      this.flush()
      this.meta.title = info.customTitle ?? info.summary
      this.emitMeta()
    })()
    return this.loaded
  }

  /** Starts the Claude Code process if it is not running. */
  start(): Promise<void> {
    if (this.q) return Promise.resolve()
    this.starting ??= this.spawn().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /** Sends what the user wrote in the composer. */
  async send(text: string, images: ImageData[]): Promise<void> {
    await this.load()
    if (this.meta.title === UNTITLED && text.trim()) this.meta.title = firstLine(text)
    this.meta.draft = ''
    await this.deliver(text, images)
  }

  /** Sends a message Kumi Code wrote, such as a relayed review finding. The draft stays. */
  async relay(text: string): Promise<void> {
    await this.load()
    await this.deliver(text, [])
  }

  /** Replaces the MCP servers Kumi Code gives the agent, at once if its process is running. */
  async setMcpServers(make: () => Record<string, McpServerConfig>): Promise<void> {
    this.mcpServers = make
    const q = this.q
    if (!q) return
    try {
      await q.setMcpServers(make())
    } catch (err) {
      // A process that stopped meanwhile gets them when it starts again.
      if (this.q === q) throw err
    }
  }

  /** The name and input of a tool call in the transcript. */
  toolInput(id: string): { name: string; input: Record<string, unknown> } | undefined {
    return this.transcript.toolInput(id)
  }

  private async deliver(text: string, images: ImageData[]): Promise<void> {
    const uuid = randomUUID()
    this.transcript.addUser(uuid, text, images, this.meta.status === 'running')
    this.lastActivity = Date.now()
    this.flush()
    this.emitMeta()
    await this.start()
    if (!this.input) throw new Error('Claude Code is not running')
    const content: Exclude<SDKUserMessage['message']['content'], string> = images.map((image) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: image.mediaType as 'image/png', data: image.data },
    }))
    if (text) content.push({ type: 'text', text })
    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid })
    this.setStatus('running')
  }

  async interrupt(): Promise<void> {
    if (!this.q || this.meta.status !== 'running') return
    this.interrupting = true
    await this.q.interrupt()
  }

  respond(requestId: string, response: RequestResponse): void {
    const pending = this.pending.get(requestId)
    if (!pending) throw new Error(`No pending request ${requestId}`)
    if (pending.request.kind !== response.kind) throw new Error(`Request ${requestId} is a ${pending.request.kind} request, not ${response.kind}`)
    this.pending.delete(requestId)
    this.meta.requests = this.meta.requests.filter((r) => r.id !== requestId)
    this.lastActivity = Date.now()
    pending.resolve(permissionResult(pending, response))
    if (response.kind === 'plan' && response.approve) {
      this.setPermissionMode(response.mode).catch((err: unknown) => {
        this.transcript.addNotice('error', `Could not switch to ${response.mode}: ${err instanceof Error ? err.message : String(err)}`)
        this.flush()
      })
    }
    this.emitMeta()
  }

  async setModel(model: string | null): Promise<void> {
    this.meta.model = model
    this.settingsChanged()
    // `undefined` returns the session to Claude Code's default model.
    if (this.q) await this.q.setModel(model ?? undefined)
  }

  async setEffort(effort: EffortLevel | null): Promise<void> {
    this.meta.effort = effort
    this.settingsChanged()
    if (this.q) await this.q.applyFlagSettings({ effortLevel: effort })
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.meta.permissionMode = mode
    this.settingsChanged()
    if (this.q) await this.q.setPermissionMode(mode)
  }

  setDraft(draft: string): void {
    this.meta.draft = draft
  }

  setTitle(title: string): void {
    this.meta.title = title
    this.emitMeta()
  }

  /**
   * Ends the Claude Code process. Pending requests are denied; the transcript
   * stays. Resolves once the process has exited: until then it may still write
   * to the transcript (the turn it was in, cost totals, the title).
   */
  stop(): Promise<void> {
    for (const pending of this.pending.values()) pending.resolve({ behavior: 'deny', message: 'The conversation was closed.', interrupt: true })
    this.pending.clear()
    this.meta.requests = []
    this.input?.end()
    this.q?.close()
    this.q = null
    this.input = null
    if (this.meta.status !== 'error') this.meta.status = 'cold'
    this.meta.compacting = false
    this.transcript.endStreams()
    this.flush()
    this.emitMeta()
    return this.exited
  }

  private async spawn(): Promise<void> {
    await this.load()
    this.setStatus('starting')
    this.meta.error = null
    this.stderr = []
    const input = new InputQueue<SDKUserMessage>()
    const options: Options = {
      cwd: this.cwd,
      tools: { type: 'preset', preset: 'claude_code' },
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      skills: 'all',
      permissionMode: this.meta.permissionMode,
      // Lets the user pick bypassPermissions from the mode menu mid-session.
      allowDangerouslySkipPermissions: true,
      canUseTool: this.canUseTool,
      mcpServers: this.mcpServers(),
      allowedTools: REVIEW_TOOLS,
      includePartialMessages: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      env: agentEnvironment(),
      // Kumi Code starts the process itself to know when it has exited.
      spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
        const child = spawn(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'] })
        child.stderr.on('data', (data: Buffer) => {
          this.stderr.push(String(data))
          if (this.stderr.length > 50) this.stderr.shift()
        })
        this.exited = exitOf(child)
        return child
      },
    }
    if (this.meta.model) options.model = this.meta.model
    if (this.meta.effort) options.effort = this.meta.effort
    if (this.persisted) options.resume = this.id
    else options.sessionId = this.id

    const q = query({ prompt: input, options })
    this.q = q
    this.input = input
    void this.consume(q)
    try {
      const init = await q.initializationResult()
      this.meta.models = init.models.map(
        (m): ModelOption => ({
          value: m.value,
          displayName: m.displayName,
          description: m.description,
          efforts: m.supportedEffortLevels ?? [],
          supportsAutoMode: m.supportsAutoMode === true,
        }),
      )
      this.meta.commands = init.commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }))
      this.lastActivity = Date.now()
      if (this.meta.status === 'starting') this.setStatus('idle')
      else this.emitMeta()
    } catch (err) {
      this.fail(err)
      throw err
    }
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.handle(msg)
      if (this.q === q) this.fail(new Error('Claude Code exited'))
    } catch (err) {
      if (this.q === q) this.fail(err)
    }
  }

  private handle(msg: SDKMessage): void {
    this.lastActivity = Date.now()
    // Claude Code also starts turns by itself, e.g. when a background task finishes.
    if (this.meta.status === 'idle' && (msg.type === 'stream_event' || msg.type === 'assistant')) this.setStatus('running')
    switch (msg.type) {
      case 'stream_event':
        this.transcript.applyStreamEvent(msg.event, msg.parent_tool_use_id)
        this.scheduleFlush()
        return
      case 'assistant':
        if (msg.user_message_uuids) this.transcript.markDelivered(msg.user_message_uuids)
        else if (msg.user_message_uuid) this.transcript.markDelivered([msg.user_message_uuid])
        if (msg.error) {
          // Claude Code reports a failed request as an assistant message whose text is the error.
          const text = textOf(msg.message) || `Model request failed: ${msg.error}`
          this.lastError = text
          this.transcript.addNotice('error', msg.error === 'authentication_failed' ? `${text}\n${loginHint()}` : text)
          this.scheduleFlush()
          return
        }
        this.transcript.applyAssistant(msg.message, msg.parent_tool_use_id)
        if (msg.parent_tool_use_id === null) this.updateContext(msg.message)
        this.scheduleFlush()
        return
      case 'user':
        this.transcript.applyToolResults(msg.message, msg.tool_use_result)
        if (this.transcript.takeTasksChanged()) {
          this.meta.tasks = this.transcript.tasks
          this.emitMeta()
        }
        this.scheduleFlush()
        return
      case 'result': {
        this.persisted = true
        this.transcript.endStreams()
        // More queued messages mean more turns follow without further input.
        const more = (msg.queued_turn_count ?? 0) > 0
        if (!more) this.transcript.markAllDelivered()
        if (this.interrupting) {
          this.interrupting = false
          this.transcript.addNotice('info', 'Interrupted')
        } else if (msg.subtype !== 'success') {
          const detail = msg.errors.length > 0 ? msg.errors.join('; ') : msg.subtype
          this.transcript.addNotice('error', `Turn ended: ${detail}`)
        } else if (msg.is_error && msg.result !== this.lastError) {
          this.transcript.addNotice('error', msg.result)
        }
        this.lastError = null
        this.updateContextWindow(msg.modelUsage)
        this.flush()
        this.setStatus(more ? 'running' : 'idle')
        void this.refreshTitle()
        return
      }
      case 'rate_limit_event': {
        const usage = fiveHourWindow(msg.rate_limit_info)
        if (usage) this.events.onUsage(usage)
        return
      }
      case 'system':
        this.handleSystem(msg)
        return
      default:
        return
    }
  }

  private handleSystem(msg: Extract<SDKMessage, { type: 'system' }>): void {
    switch (msg.subtype) {
      case 'init':
        this.persisted = true
        if (msg.permissionMode !== this.meta.permissionMode && isUiMode(msg.permissionMode)) {
          this.meta.permissionMode = msg.permissionMode
          this.settingsChanged()
        }
        return
      case 'status':
        this.meta.compacting = msg.status === 'compacting'
        if (msg.permissionMode && isUiMode(msg.permissionMode) && msg.permissionMode !== this.meta.permissionMode) {
          this.meta.permissionMode = msg.permissionMode
          this.settingsChanged()
        }
        if (msg.compact_result === 'failed') this.transcript.addNotice('error', `Compaction failed: ${msg.compact_error ?? 'unknown error'}`)
        this.flush()
        this.emitMeta()
        return
      case 'compact_boundary':
        this.transcript.addCompact(msg.compact_metadata.trigger, msg.compact_metadata.pre_tokens)
        this.meta.contextPercent = null
        this.flush()
        this.emitMeta()
        return
      case 'local_command_output':
        this.transcript.addCommandOutput(msg.content)
        this.flush()
        return
      case 'api_retry':
        this.transcript.addNotice('info', `API request failed, retrying (attempt ${msg.attempt} of ${msg.max_retries})`)
        this.flush()
        return
      case 'task_notification':
        if (msg.status !== 'completed') this.transcript.addNotice(msg.status === 'failed' ? 'error' : 'info', `Background task ${msg.status}: ${msg.summary}`)
        this.flush()
        return
      default:
        return
    }
  }

  private readonly canUseTool: CanUseTool = (toolName, input, options) =>
    new Promise<PermissionResult>((resolve) => {
      const id = options.toolUseID
      let request: PendingRequest
      if (toolName === 'AskUserQuestion') {
        request = { kind: 'question', id, questions: parseQuestions(input) }
      } else if (toolName === 'ExitPlanMode') {
        request = { kind: 'plan', id, plan: typeof input.plan === 'string' ? input.plan : null }
      } else {
        request = {
          kind: 'permission',
          id,
          toolName,
          input,
          title: options.title ?? null,
          description: options.description ?? null,
          reason: options.decisionReason ?? null,
          blockedPath: options.blockedPath ?? null,
          canAlwaysAllow: (options.suggestions?.length ?? 0) > 0 && options.suppressAlwaysAllowRule !== true,
        }
      }
      this.pending.set(id, { request, input, suggestions: options.suggestions, resolve })
      this.meta.requests = [...this.meta.requests, request]
      options.signal.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return
        this.meta.requests = this.meta.requests.filter((r) => r.id !== id)
        resolve({ behavior: 'deny', message: 'Cancelled.' })
        this.emitMeta()
      })
      // The tool's card goes out before the request that refers to it.
      this.flush()
      this.emitMeta()
    })

  private updateContext(message: unknown): void {
    const { usage, model } = message as { usage?: Record<string, unknown>; model?: unknown }
    if (typeof model === 'string') this.contextModel = model
    if (!usage) return
    const n = (key: string): number => (typeof usage[key] === 'number' ? usage[key] : 0)
    this.contextTokens = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens') + n('output_tokens')
  }

  private updateContextWindow(modelUsage: Record<string, { contextWindow: number }>): void {
    if (this.contextTokens === null || this.contextModel === null) return
    // modelUsage also lists models Claude Code used on the side, e.g. for titles.
    const window = modelUsage[this.contextModel]?.contextWindow
    if (window) this.meta.contextPercent = Math.min(100, Math.round((this.contextTokens / window) * 100))
  }

  private async refreshTitle(): Promise<void> {
    const info = await getSessionInfo(this.id, { dir: this.cwd })
    if (info) {
      const title = info.customTitle ?? info.summary
      if (title && title !== this.meta.title) {
        this.meta.title = title
        this.emitMeta()
      }
    }
    this.events.onSessionChanged()
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    const tail = this.stderr.join('').trim().split('\n').slice(-5).join('\n')
    this.meta.error = tail ? `${message}\n${tail}` : message
    this.q?.close()
    this.q = null
    this.input?.end()
    this.input = null
    for (const pending of this.pending.values()) pending.resolve({ behavior: 'deny', message: 'Claude Code stopped.', interrupt: true })
    this.pending.clear()
    this.meta.requests = []
    this.meta.compacting = false
    this.transcript.endStreams()
    this.transcript.addNotice('error', this.meta.error)
    this.flush()
    this.setStatus('error')
  }

  private setStatus(status: ConversationMeta['status']): void {
    this.meta.status = status
    this.emitMeta()
  }

  private settingsChanged(): void {
    this.events.onSettings({ model: this.meta.model, effort: this.meta.effort, permissionMode: this.meta.permissionMode })
    this.emitMeta()
  }

  private scheduleFlush(): void {
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS)
  }

  /** Sends the transcript items changed since the last flush. */
  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const changed = this.transcript.takeChanges()
    if (changed.length > 0) this.events.onItems(changed)
  }

  private emitMeta(): void {
    this.events.onMeta(this.snapshotMeta())
  }
}

function permissionResult(pending: Pending, response: RequestResponse): PermissionResult {
  switch (response.kind) {
    case 'permission':
      if (!response.allow) {
        return response.message.trim()
          ? { behavior: 'deny', message: response.message.trim() }
          : { behavior: 'deny', message: 'The user denied this tool use.', interrupt: true }
      }
      return response.always && pending.suggestions
        ? { behavior: 'allow', updatedInput: pending.input, updatedPermissions: pending.suggestions }
        : { behavior: 'allow', updatedInput: pending.input }
    case 'question':
      if ('dismissed' in response) return { behavior: 'deny', message: 'The user dismissed the question without answering.' }
      return { behavior: 'allow', updatedInput: { ...pending.input, answers: response.answers } }
    case 'plan':
      if (!response.approve) {
        const feedback = response.feedback.trim()
        return { behavior: 'deny', message: feedback ? `The user rejected the plan: ${feedback}` : 'The user rejected the plan. Keep planning.' }
      }
      return { behavior: 'allow', updatedInput: pending.input }
  }
}

function parseQuestions(input: Record<string, unknown>): Question[] {
  const questions = Array.isArray(input.questions) ? input.questions : []
  return questions.map((raw): Question => {
    const q = raw as Record<string, unknown>
    const options = Array.isArray(q.options) ? q.options : []
    return {
      question: String(q.question ?? ''),
      header: String(q.header ?? ''),
      multiSelect: q.multiSelect === true,
      options: options.map((o) => {
        const opt = o as Record<string, unknown>
        return { label: String(opt.label ?? ''), description: String(opt.description ?? '') }
      }),
    }
  })
}

function isUiMode(mode: string): mode is PermissionMode {
  return mode === 'default' || mode === 'acceptEdits' || mode === 'plan' || mode === 'auto' || mode === 'bypassPermissions'
}

/**
 * The 5-hour window of a rate limit event. Claude Code reports every window in
 * `unifiedWindows` (utilization 0-1, reset in epoch seconds); the documented
 * top-level fields describe only the window the request counted against.
 */
function fiveHourWindow(info: SDKRateLimitInfo): UsageWindow | null {
  const unified = (info as { unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown }> }).unifiedWindows
  const five = unified?.five_hour
  if (!five || typeof five.utilization !== 'number') return null
  return { utilization: Math.round(five.utilization * 100), resetsAt: typeof five.resetsAt === 'number' ? five.resetsAt * 1000 : null, updatedAt: Date.now() }
}

function exitOf(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: { type?: unknown; text?: unknown }) => b.type === 'text' && typeof b.text === 'string')
    .map((b: { text: string }) => b.text)
    .join('\n')
    .trim()
}

function loginHint(): string {
  return `Kumi Code uses Claude Code's login on this machine. Log in by running this in a terminal:\n${loginCommand()}`
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}
