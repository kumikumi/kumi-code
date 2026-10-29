// Types shared by the main process, the preload bridge and the renderer. Everything
// here crosses IPC, so it is plain data.

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The permission modes the UI offers. `auto` only when the model supports it. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'

export interface ModelOption {
  value: string
  displayName: string
  description: string
  efforts: EffortLevel[]
  supportsAutoMode: boolean
}

export interface CommandOption {
  name: string
  description: string
  argumentHint: string
}

// ---- auth and usage ----

export interface AuthStatus {
  loggedIn: boolean
  authMethod: string
  email: string | null
  subscriptionType: string | null
  /** The bundled CLI's login command, to run in a terminal. */
  loginCommand: string
}

/** The subscription's 5-hour usage window, from the SDK's rate limit events. */
export interface UsageWindow {
  /** 0-100. */
  utilization: number
  resetsAt: number | null
  updatedAt: number
}

// ---- transcript ----

export interface ImageData {
  mediaType: string
  /** Base64, no data: prefix. */
  data: string
}

export interface ToolResult {
  text: string
  isError: boolean
  images: number
}

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; images: ImageData[]; queued: boolean }
  | { kind: 'text'; id: string; text: string; streaming: boolean }
  | { kind: 'thinking'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool'
      id: string
      name: string
      input: Record<string, unknown>
      /** Raw JSON while the input streams in; null once the input is complete. */
      partialInput: string | null
      result: ToolResult | null
      /** What a subagent started by this tool did, in order. */
      children: TranscriptItem[]
    }
  /** trigger and preTokens are unknown for compactions read back from a stored session. */
  | { kind: 'compact'; id: string; trigger: 'manual' | 'auto' | null; preTokens: number | null }
  | { kind: 'command_output'; id: string; text: string }
  | { kind: 'notice'; id: string; level: 'info' | 'error'; text: string }

/** An entry of Claude Code's task list (TaskCreate, TaskUpdate, ...). */
export interface TaskInfo {
  id: string
  subject: string
  /** What the task is called while it is being worked on, e.g. "Running tests". */
  activeForm: string
  status: 'pending' | 'in_progress' | 'completed'
}

// ---- requests the agent is waiting on ----

export interface QuestionOption {
  label: string
  description: string
}

export interface Question {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

export type PendingRequest =
  | {
      kind: 'permission'
      id: string
      toolName: string
      input: Record<string, unknown>
      title: string | null
      description: string | null
      reason: string | null
      blockedPath: string | null
      /** The CLI offered rules that would stop it asking again this session. */
      canAlwaysAllow: boolean
    }
  | { kind: 'question'; id: string; questions: Question[] }
  | { kind: 'plan'; id: string; plan: string | null }

export type RequestResponse =
  | { kind: 'permission'; allow: true; always: boolean }
  | { kind: 'permission'; allow: false; message: string }
  | { kind: 'question'; answers: Record<string, string> }
  | { kind: 'question'; dismissed: true }
  | { kind: 'plan'; approve: true; mode: 'default' | 'acceptEdits' | 'auto' }
  | { kind: 'plan'; approve: false; feedback: string }

// ---- conversations ----

/**
 * cold: no Claude Code process. starting: the process is starting. idle: ready
 * for a message. running: a turn is in progress. error: the process failed; the
 * next message starts a new one.
 */
export type ConversationStatus = 'cold' | 'starting' | 'idle' | 'running' | 'error'

export interface ConversationMeta {
  id: string
  cwd: string
  /** Display name of the project; null for a project-less conversation. */
  project: string | null
  title: string
  status: ConversationStatus
  /** Set while status is error. */
  error: string | null
  compacting: boolean
  /** null: Claude Code's default. */
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
  models: ModelOption[]
  commands: CommandOption[]
  /** Share of the context window the last request used, 0-100. */
  contextPercent: number | null
  requests: PendingRequest[]
  tasks: TaskInfo[]
  draft: string
}

export interface ConversationSnapshot {
  meta: ConversationMeta
  items: TranscriptItem[]
  /** Increases with every event about this conversation. */
  rev: number
}

export interface ConversationSummary {
  id: string
  title: string
  cwd: string
  project: string | null
  /** When the conversation last had a message. */
  lastActive: number
  gitBranch: string | null
  /** Started in Kumi Code. */
  kumi: boolean
}

export interface RecentProject {
  path: string
  name: string
  lastUsed: number
}

// ---- windows and tabs ----

/** new: a new tab page. attention: the agent is waiting on the user. */
export type TabStatus = 'new' | 'idle' | 'running' | 'attention' | 'error'

export interface TabInfo {
  id: string
  conversationId: string | null
  title: string
  status: TabStatus
}

export interface WindowState {
  windowId: number
  tabs: TabInfo[]
  activeTabId: string
}

/** A tab strip's tabs in window content coordinates, for drag hit testing. */
export interface TabStripGeometry {
  height: number
  tabs: { id: string; left: number; right: number }[]
}

/** Shown in a window whose tab strip a dragged tab hovers over. */
export interface DragHover {
  index: number
  title: string
}

// ---- IPC ----

export const IPC = {
  getWindowState: 'window:get',
  newTab: 'tab:new',
  closeTab: 'tab:close',
  activateTab: 'tab:activate',
  moveTab: 'tab:move',
  startConversation: 'tab:start-conversation',
  openConversation: 'tab:open-conversation',
  reportTabStrip: 'drag:geometry',
  dragStart: 'drag:start',
  dragMove: 'drag:move',
  dragEnd: 'drag:end',
  getAuthStatus: 'auth:status',
  getUsage: 'usage:get',
  pickFolder: 'folder:pick',
  listConversations: 'conversations:list',
  listRecentProjects: 'projects:recent',
  renameConversation: 'conversation:rename',
  deleteConversation: 'conversation:delete',
  getConversation: 'conversation:get',
  send: 'conversation:send',
  interrupt: 'conversation:interrupt',
  respond: 'conversation:respond',
  setModel: 'conversation:set-model',
  setEffort: 'conversation:set-effort',
  setPermissionMode: 'conversation:set-permission-mode',
  setDraft: 'conversation:set-draft',
  evWindowState: 'ev:window',
  evConversationMeta: 'ev:conversation-meta',
  evConversationItems: 'ev:conversation-items',
  evUsage: 'ev:usage',
  evDragHover: 'ev:drag-hover',
  evConversationsChanged: 'ev:conversations-changed',
} as const

export interface KumiApi {
  getWindowState(): Promise<WindowState>
  newTab(): Promise<void>
  closeTab(tabId: string): Promise<void>
  activateTab(tabId: string): Promise<void>
  /** Reorder within this window. */
  moveTab(tabId: string, index: number): Promise<void>
  /** Turns a new tab page into a new conversation in `cwd`, or in a fresh folder when null. */
  startConversation(tabId: string, cwd: string | null): Promise<void>
  /** Opens a past conversation in this tab, or switches to the tab that already has it. */
  openConversation(tabId: string, conversationId: string): Promise<void>
  reportTabStrip(geometry: TabStripGeometry): void
  /**
   * A tab is dragged out of its strip. `grabX`: the pointer's distance from the
   * tab's left edge; `grabY`: from the top of the window. The main process reads
   * the cursor position itself; dragMove and dragEnd only say when.
   */
  dragStart(tabId: string, grabX: number, grabY: number): void
  dragMove(): void
  dragEnd(): void
  getAuthStatus(): Promise<AuthStatus>
  getUsage(): Promise<UsageWindow | null>
  pickFolder(): Promise<string | null>
  listConversations(all: boolean): Promise<ConversationSummary[]>
  listRecentProjects(): Promise<RecentProject[]>
  renameConversation(conversationId: string, title: string): Promise<void>
  deleteConversation(conversationId: string): Promise<void>
  getConversation(conversationId: string): Promise<ConversationSnapshot>
  send(conversationId: string, text: string, images: ImageData[]): Promise<void>
  interrupt(conversationId: string): Promise<void>
  respond(conversationId: string, requestId: string, response: RequestResponse): Promise<void>
  setModel(conversationId: string, model: string | null): Promise<void>
  setEffort(conversationId: string, effort: EffortLevel | null): Promise<void>
  setPermissionMode(conversationId: string, mode: PermissionMode): Promise<void>
  setDraft(conversationId: string, draft: string): void
  onWindowState(cb: (state: WindowState) => void): () => void
  onConversationMeta(cb: (id: string, meta: ConversationMeta, rev: number) => void): () => void
  onConversationItems(cb: (id: string, items: TranscriptItem[], rev: number) => void): () => void
  onUsage(cb: (usage: UsageWindow) => void): () => void
  onDragHover(cb: (hover: DragHover | null) => void): () => void
  onConversationsChanged(cb: () => void): () => void
}
