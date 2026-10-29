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
  /** relay: the message is a review finding or answer Kumi Code relayed. */
  | { kind: 'user'; id: string; text: string; images: ImageData[]; queued: boolean; relay: RelayMessage | null }
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

// ---- code review ----

/** A finding as a reviewer reported it with Claude Code's ReportFindings tool. */
export interface Finding {
  /** Repository-relative. */
  file: string
  line: number | null
  /** The reviewer's short label, or its summary when it gave none. */
  title: string
  summary: string
  failureScenario: string
  category: string | null
  verdict: 'CONFIRMED' | 'PLAUSIBLE' | null
}

/**
 * open: not sent yet. implementing: with the implementer. fixed, pushed_back:
 * the implementer's answer, not yet sent to the reviewer. verifying: with the
 * reviewer. reopened: the reviewer rejected the answer; not yet sent back.
 * resolved: the reviewer accepted a fix. withdrawn: the reviewer accepted a
 * push-back. closed: the user closed it.
 */
export type FindingStatus = 'open' | 'implementing' | 'fixed' | 'pushed_back' | 'verifying' | 'reopened' | 'resolved' | 'withdrawn' | 'closed'

export type ReviewRole = 'implementer' | 'reviewer'

export type ImplementerOutcome = 'fixed' | 'no_change_needed'
export type ReviewerVerdict = 'accept' | 'reopen'

/** An entry of a finding's thread: an agent's answer or a note the user sent with it. */
export interface FindingReply {
  from: ReviewRole | 'user'
  /** null for the user's notes. */
  outcome: ImplementerOutcome | ReviewerVerdict | null
  text: string
  at: number
}

export interface ReviewFinding extends Finding {
  /** 1-based. The reviewer reports the most severe finding first. */
  rank: number
  status: FindingStatus
  /** The agent it was sent to ended its turn without answering. */
  stalled: boolean
  /** The status the user closed it from, to go back to when reopened. */
  closedFrom: FindingStatus | null
  thread: FindingReply[]
}

/** One ReportFindings call of a reviewer conversation, linked to the conversation that wrote the code. */
export interface Review {
  /** The ReportFindings tool use. */
  id: string
  reviewerId: string
  implementerId: string
  createdAt: number
  findings: ReviewFinding[]
}

/** What a relayed message carries, besides its instructions to the agent. */
export interface RelayMessage {
  to: ReviewRole
  rank: number
  /** How many findings the review has. */
  of: number
  finding: Finding
  /** The other agent's answer that this message passes on. */
  reply: FindingReply | null
  note: string | null
}

// ---- browser ----

/** What a browser tab's page sees of its window. */
export interface Viewport {
  width: number
  height: number
  /** A phone: mobile layout, an Android Chrome user agent and touch points. */
  mobile: boolean
  colorScheme: 'light' | 'dark' | null
}

export interface BrowserTabInfo {
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  viewport: Viewport
}

/** A conversation's browser. */
export interface BrowserState {
  tabs: BrowserTabInfo[]
  activeTabId: string | null
  /** While a browser tool runs: what it does, e.g. "Opens the Filters menu". */
  activity: string | null
}

/** What the user does in the browser pane. */
export type BrowserAction =
  /** In the active tab, or a new one when there is none. */
  | { kind: 'navigate'; url: string }
  | { kind: 'back' | 'forward' | 'reload' | 'select' | 'close' | 'devtools'; tabId: string }
  | { kind: 'newTab' }
  | { kind: 'viewport'; tabId: string; viewport: Viewport }

/** The user's mouse and keyboard on a tab, in page pixels. modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export type BrowserInput =
  | { type: 'mouse'; action: 'down' | 'up' | 'move'; x: number; y: number; button: 'left' | 'middle' | 'right' | 'none'; clickCount: number; modifiers: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | { type: 'key'; action: 'down' | 'up'; key: string; code: string; keyCode: number; modifiers: number }

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
  showConversation: 'conversation:show',
  listReviews: 'review:list',
  startReview: 'review:start',
  relayFinding: 'review:relay',
  setFindingClosed: 'review:set-closed',
  endReview: 'review:end',
  getBrowser: 'browser:get',
  browserAction: 'browser:action',
  browserInput: 'browser:input',
  watchBrowser: 'browser:watch',
  evWindowState: 'ev:window',
  evConversationMeta: 'ev:conversation-meta',
  evConversationItems: 'ev:conversation-items',
  evUsage: 'ev:usage',
  evDragHover: 'ev:drag-hover',
  evConversationsChanged: 'ev:conversations-changed',
  evReviews: 'ev:reviews',
  evBrowser: 'ev:browser',
  evBrowserFrame: 'ev:browser-frame',
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
  /** Switches to the conversation's tab, or opens it in a new tab of this window. */
  showConversation(conversationId: string): Promise<void>
  listReviews(): Promise<Review[]>
  /**
   * Links the findings of a ReportFindings call in `reviewerId` to the
   * conversation that wrote the code. It replaces a review either is in.
   */
  startReview(reviewerId: string, toolUseId: string, implementerId: string): Promise<void>
  /** Sends a finding to the agent it waits on, with the user's note (may be empty). */
  relayFinding(reviewId: string, rank: number, note: string): Promise<void>
  setFindingClosed(reviewId: string, rank: number, closed: boolean): Promise<void>
  endReview(reviewId: string): Promise<void>
  /** The conversation's browser; no tabs when it has not opened any. */
  getBrowser(conversationId: string): Promise<BrowserState>
  browserAction(conversationId: string, action: BrowserAction): Promise<void>
  /** The user's input on a tab. Not awaited: it comes often. */
  browserInput(conversationId: string, tabId: string, input: BrowserInput): void
  /** Whether this window shows the conversation's browser, and so wants its frames. */
  watchBrowser(conversationId: string, watching: boolean): void
  onWindowState(cb: (state: WindowState) => void): () => void
  onConversationMeta(cb: (id: string, meta: ConversationMeta, rev: number) => void): () => void
  onConversationItems(cb: (id: string, items: TranscriptItem[], rev: number) => void): () => void
  onUsage(cb: (usage: UsageWindow) => void): () => void
  onDragHover(cb: (hover: DragHover | null) => void): () => void
  onConversationsChanged(cb: () => void): () => void
  /** Every review, whenever one changes. */
  onReviews(cb: (reviews: Review[]) => void): () => void
  onBrowser(cb: (conversationId: string, state: BrowserState) => void): () => void
  /** A JPEG frame of the active tab of a browser this window watches. */
  onBrowserFrame(cb: (conversationId: string, tabId: string, jpeg: Uint8Array, width: number, height: number) => void): () => void
}
