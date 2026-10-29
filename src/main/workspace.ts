// Windows, their tabs and the open conversations. The main process is the source
// of truth for all of it: a renderer draws its own window's tab strip and tabs
// from what it is sent, so a tab can move between windows by changing which
// window lists it.
//
// A conversation is open while at least one tab shows it, and at most one tab
// does. Its Claude Code process starts when its tab is first shown and stops
// when the tab closes or after it has sat idle for a while.
//
// Code reviews link two conversations; relaying a finding to a conversation that
// is not open opens it in a new tab.

import { BrowserWindow, screen, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Rectangle } from 'electron'
import { deleteSession, renameSession } from '@anthropic-ai/claude-agent-sdk'
import { Conversation } from '../core/conversation'
import type { ConversationSettings } from '../core/conversation'
import { Reviews } from '../core/review'
import type { ReviewAnswer } from '../core/review'
import { reviewServers } from '../core/review-tools'
import { createScratchFolder, projectName } from '../core/sessions'
import type { Store, StoredWindow } from '../core/store'
import { IPC } from '@shared/types'
import type { ConversationSnapshot, ConversationStatus, DragHover, Review, TabInfo, TabStatus, TabStripGeometry, UsageWindow, WindowState } from '@shared/types'

export interface Tab {
  id: string
  conversationId: string | null
}

export interface Win {
  win: BrowserWindow
  tabs: Tab[]
  activeTabId: string
  strip: TabStripGeometry | null
}

const IDLE_STOP_MS = 15 * 60_000
const EXIT_TIMEOUT_MS = 10_000
const DEFAULT_SIZE = { width: 1100, height: 820 }
const DEFAULT_SETTINGS: ConversationSettings = { model: null, effort: null, permissionMode: 'default' }

export interface WorkspaceOptions {
  store: Store
  scratchRoot: string
  preload: string
  rendererUrl: string | undefined
  rendererFile: string
}

export class Workspace {
  private readonly windows = new Map<number, Win>()
  private readonly conversations = new Map<string, Conversation>()
  private readonly revs = new Map<string, number>()
  private readonly closedConversations: string[] = []
  private readonly reviews: Reviews
  /** Each open conversation's review roles, as its MCP servers last got them. */
  private readonly reviewRoles = new Map<string, string>()
  /** Each open conversation's last status, to see its turns end. */
  private readonly lastStatus = new Map<string, ConversationStatus>()
  private usage: UsageWindow | null = null
  private quitting = false

  constructor(private readonly opts: WorkspaceOptions) {
    this.reviews = new Reviews(opts.store.get().reviews, () => this.reviewsChanged())
    setInterval(() => this.stopIdle(), 60_000).unref()
  }

  // ---- windows ----

  restore(): void {
    const stored = this.opts.store.get().windows
    for (const w of stored) {
      const tabs = w.tabs.map((conversationId) => ({ id: randomUUID(), conversationId: conversationId !== null && conversationId in this.opts.store.get().conversations ? conversationId : null }))
      if (tabs.length === 0) continue
      const active = tabs[Math.min(Math.max(w.activeIndex, 0), tabs.length - 1)] ?? tabs[0]
      if (active) this.createWindow(tabs, active.id, w.bounds, true)
    }
    if (this.windows.size === 0) this.newWindow()
  }

  newWindow(): Win {
    const tab = { id: randomUUID(), conversationId: null }
    return this.createWindow([tab], tab.id, null, true)
  }

  createWindow(tabs: Tab[], activeTabId: string, bounds: Partial<Rectangle> | null, show: boolean): Win {
    const win = new BrowserWindow({
      ...DEFAULT_SIZE,
      ...visibleBounds(bounds),
      minWidth: 560,
      minHeight: 400,
      show: false,
      title: 'Kumi Code',
      backgroundColor: '#1d2026',
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 14, y: 13 },
      webPreferences: { preload: this.opts.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const entry: Win = { win, tabs, activeTabId, strip: null }
    this.windows.set(win.id, entry)
    for (const tab of tabs) if (tab.conversationId) this.openConversationObject(tab.conversationId)
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    if (show) win.once('ready-to-show', () => win.show())
    win.on('resize', () => this.persistLayout())
    win.on('move', () => this.persistLayout())
    win.on('focus', () => this.activate(entry))
    win.on('closed', () => {
      this.windows.delete(win.id)
      for (const tab of entry.tabs) this.releaseTab(tab)
      // The last window's layout stays saved, so the next launch restores it.
      if (!this.quitting && this.windows.size > 0) this.persistLayout()
    })
    if (this.opts.rendererUrl) void win.loadURL(this.opts.rendererUrl)
    else void win.loadFile(this.opts.rendererFile)
    this.activate(entry)
    this.persistLayout()
    return entry
  }

  beginQuit(): void {
    // With no windows left, the layout saved when the last one closed stands.
    if (this.windows.size > 0) this.persistLayout()
    this.opts.store.flush()
    this.quitting = true
    for (const conversation of this.conversations.values()) void conversation.stop()
  }

  winOf(win: BrowserWindow | null): Win {
    const entry = win ? this.windows.get(win.id) : undefined
    if (!entry) throw new Error('Unknown window')
    return entry
  }

  winById(id: number): Win | undefined {
    return this.windows.get(id)
  }

  allWindows(): Win[] {
    return [...this.windows.values()]
  }

  focused(): Win | undefined {
    const win = BrowserWindow.getFocusedWindow()
    return win ? this.windows.get(win.id) : undefined
  }

  windowState(entry: Win): WindowState {
    return { windowId: entry.win.id, tabs: entry.tabs.map((t) => this.tabInfo(t)), activeTabId: entry.activeTabId }
  }

  setStrip(entry: Win, strip: TabStripGeometry): void {
    entry.strip = strip
  }

  sendHover(entry: Win, hover: DragHover | null): void {
    entry.win.webContents.send(IPC.evDragHover, hover)
  }

  // ---- tabs ----

  newTab(entry: Win): void {
    const tab = { id: randomUUID(), conversationId: null }
    const index = entry.tabs.findIndex((t) => t.id === entry.activeTabId)
    entry.tabs.splice(index + 1, 0, tab)
    entry.activeTabId = tab.id
    this.changed(entry)
  }

  closeTab(entry: Win, tabId: string): void {
    const index = entry.tabs.findIndex((t) => t.id === tabId)
    const tab = entry.tabs[index]
    if (!tab) return
    if (entry.tabs.length === 1) {
      // Closing the last tab closes the window without saving it for the next launch.
      entry.tabs = []
      this.releaseTab(tab)
      this.persistLayout()
      entry.win.close()
      return
    }
    entry.tabs.splice(index, 1)
    this.releaseTab(tab)
    if (tab.conversationId) this.closedConversations.push(tab.conversationId)
    if (entry.activeTabId === tabId) {
      const next = entry.tabs[Math.min(index, entry.tabs.length - 1)]
      if (next) entry.activeTabId = next.id
      this.activate(entry)
    }
    this.changed(entry)
  }

  reopenClosedTab(entry: Win): void {
    while (this.closedConversations.length > 0) {
      const id = this.closedConversations.pop()
      if (!id || this.findTab(id)) continue
      const tab = { id: randomUUID(), conversationId: id }
      entry.tabs.push(tab)
      entry.activeTabId = tab.id
      this.openConversationObject(id)
      this.activate(entry)
      this.changed(entry)
      return
    }
  }

  activateTab(entry: Win, tabId: string): void {
    if (!entry.tabs.some((t) => t.id === tabId)) return
    entry.activeTabId = tabId
    this.activate(entry)
    this.changed(entry)
  }

  activateIndex(entry: Win, index: number): void {
    const tab = index < 0 ? entry.tabs[entry.tabs.length - 1] : entry.tabs[index]
    if (tab) this.activateTab(entry, tab.id)
  }

  cycleTab(entry: Win, step: number): void {
    const index = entry.tabs.findIndex((t) => t.id === entry.activeTabId)
    const next = entry.tabs[(index + step + entry.tabs.length) % entry.tabs.length]
    if (next) this.activateTab(entry, next.id)
  }

  moveTab(entry: Win, tabId: string, index: number): void {
    const from = entry.tabs.findIndex((t) => t.id === tabId)
    const tab = entry.tabs[from]
    if (!tab) return
    entry.tabs.splice(from, 1)
    entry.tabs.splice(Math.max(0, Math.min(index, entry.tabs.length)), 0, tab)
    this.changed(entry)
  }

  /** Takes a tab out of its window without closing its conversation. */
  takeTab(entry: Win, tabId: string): Tab {
    const index = entry.tabs.findIndex((t) => t.id === tabId)
    const tab = entry.tabs[index]
    if (!tab) throw new Error(`No tab ${tabId}`)
    if (entry.tabs.length === 1) throw new Error('Cannot take the only tab of a window')
    entry.tabs.splice(index, 1)
    if (entry.activeTabId === tabId) {
      const next = entry.tabs[Math.min(index, entry.tabs.length - 1)]
      if (next) entry.activeTabId = next.id
    }
    this.changed(entry)
    return tab
  }

  /** Puts a tab taken from another window into this one and shows it. */
  insertTab(entry: Win, tab: Tab, index: number): void {
    entry.tabs.splice(Math.max(0, Math.min(index, entry.tabs.length)), 0, tab)
    entry.activeTabId = tab.id
    this.activate(entry)
    this.changed(entry)
  }

  /** Closes a window whose tabs have all moved elsewhere. */
  closeEmptied(entry: Win): void {
    entry.tabs = []
    entry.win.close()
  }

  startConversation(entry: Win, tabId: string, cwd: string | null): void {
    const tab = entry.tabs.find((t) => t.id === tabId)
    if (!tab || tab.conversationId) throw new Error('Not a new tab page')
    const scratch = cwd === null
    const folder = cwd ?? createScratchFolder(this.opts.scratchRoot)
    const id = randomUUID()
    this.opts.store.update((s) => {
      s.conversations[id] = { cwd: folder, scratch, createdAt: Date.now(), ...DEFAULT_SETTINGS }
      if (!scratch) {
        s.recents = [{ path: folder, lastUsed: Date.now() }, ...s.recents.filter((r) => r.path !== folder)].slice(0, 50)
      }
    })
    tab.conversationId = id
    this.openConversationObject(id)
    this.activate(entry)
    this.changed(entry)
  }

  openConversation(entry: Win, tabId: string, conversationId: string, cwd: string): void {
    const existing = this.findTab(conversationId)
    if (existing) {
      this.activateTab(existing.entry, existing.tab.id)
      existing.entry.win.focus()
      return
    }
    const tab = entry.tabs.find((t) => t.id === tabId)
    if (!tab || tab.conversationId) throw new Error('Not a new tab page')
    if (!(conversationId in this.opts.store.get().conversations)) {
      // A Claude Code session from elsewhere becomes one of Kumi Code's own.
      this.opts.store.update((s) => {
        s.conversations[conversationId] = { cwd, scratch: false, createdAt: Date.now(), ...DEFAULT_SETTINGS }
      })
    }
    tab.conversationId = conversationId
    this.openConversationObject(conversationId)
    this.activate(entry)
    this.changed(entry)
  }

  // ---- conversations ----

  conversation(id: string): Conversation {
    const conversation = this.conversations.get(id)
    if (!conversation) throw new Error(`Conversation ${id} is not open`)
    return conversation
  }

  snapshot(id: string): ConversationSnapshot {
    const conversation = this.conversation(id)
    return { meta: conversation.snapshotMeta(), items: conversation.snapshotItems(), rev: this.revs.get(id) ?? 0 }
  }

  async renameConversation(id: string, title: string): Promise<void> {
    const cwd = this.opts.store.get().conversations[id]?.cwd
    await renameSession(id, title, cwd ? { dir: cwd } : undefined)
    this.conversations.get(id)?.setTitle(title)
    this.broadcast(IPC.evConversationsChanged)
  }

  async deleteConversation(id: string): Promise<void> {
    // Claude Code writes to the transcript until its process has exited (the
    // turn it was in, cost totals, the title), which would bring the file back.
    // The SDK force-kills a stopped process after about 2 s.
    const conversation = this.conversations.get(id)
    if (conversation) await withTimeout(conversation.stop(), EXIT_TIMEOUT_MS, 'Claude Code did not exit; the conversation was not deleted')
    // The tab closes last: closing a window's only tab closes the window.
    const cwd = this.opts.store.get().conversations[id]?.cwd
    await deleteSession(id, cwd ? { dir: cwd } : undefined)
    this.opts.store.update((s) => {
      delete s.conversations[id]
    })
    this.reviews.removeConversation(id)
    const found = this.findTab(id)
    if (found) this.closeTab(found.entry, found.tab.id)
    this.broadcast(IPC.evConversationsChanged)
  }

  get currentUsage(): UsageWindow | null {
    return this.usage
  }

  /** Switches to the conversation's tab, or opens it in a new tab of `entry`. */
  showConversation(entry: Win, conversationId: string): void {
    const found = this.findTab(conversationId)
    if (found) {
      this.activateTab(found.entry, found.tab.id)
      found.entry.win.focus()
      return
    }
    this.openInTab(entry, conversationId, true)
  }

  // ---- code reviews ----

  reviewList(): Review[] {
    return this.reviews.list()
  }

  startReview(reviewerId: string, toolUseId: string, implementerId: string): void {
    const call = this.conversation(reviewerId).toolInput(toolUseId)
    if (call?.name !== 'ReportFindings') throw new Error('No such ReportFindings call in the conversation')
    if (!(implementerId in this.opts.store.get().conversations)) throw new Error(`Unknown conversation ${implementerId}`)
    this.reviews.start(toolUseId, reviewerId, implementerId, call.input)
  }

  /**
   * Sends a finding to the agent it waits on. The finding is with that agent from then on;
   * when the message cannot be delivered, it is unanswered, to be sent again. A conversation
   * that is not open opens in a new tab of `entry`.
   */
  async relayFinding(entry: Win, reviewId: string, rank: number, note: string): Promise<void> {
    const relay = this.reviews.relay(reviewId, rank, note)
    this.reviews.sent(reviewId, rank, relay.to, note)
    try {
      const conversation = this.openInTab(entry, relay.conversationId, false)
      await this.syncReviewTools(relay.conversationId)
      await conversation.relay(relay.text)
    } catch (err) {
      this.reviews.unanswered(reviewId, rank)
      throw err
    }
  }

  setFindingClosed(reviewId: string, rank: number, closed: boolean): void {
    this.reviews.setClosed(reviewId, rank, closed)
  }

  endReview(reviewId: string): void {
    this.reviews.end(reviewId)
  }

  private reviewsChanged(): void {
    this.opts.store.update((s) => {
      s.reviews = this.reviews.toJSON()
    })
    for (const id of this.conversations.keys()) {
      this.syncReviewTools(id).catch((err: unknown) => console.error(`Giving conversation ${id} its review tools failed:`, err))
    }
    this.broadcast(IPC.evReviews, this.reviews.list())
  }

  /** An agent's answer through its review tool. The implementer's goes on to the reviewer at once. */
  private answer(conversationId: string, answer: ReviewAnswer): string {
    const reply = this.reviews.answer(conversationId, answer)
    const review = answer.role === 'implementer' ? this.reviews.of(conversationId, 'implementer') : undefined
    // The implementer answers from its tab, which a reviewer not open in one joins.
    const entry = this.findTab(conversationId)?.entry
    if (review && entry) {
      this.relayFinding(entry, review.id, answer.finding, '').catch((err: unknown) => console.error(`Sending finding ${answer.finding} to the reviewer failed:`, err))
    }
    return reply
  }

  /** Gives a conversation the review tools of the roles it has. */
  private async syncReviewTools(id: string): Promise<void> {
    const conversation = this.conversations.get(id)
    const roles = this.reviews.roles(id)
    if (!conversation || this.reviewRoles.get(id) === roles.join()) return
    this.reviewRoles.set(id, roles.join())
    try {
      await conversation.setMcpServers(() => reviewServers(roles, (answer) => this.answer(id, answer)))
    } catch (err) {
      this.reviewRoles.delete(id)
      throw err
    }
  }

  /** The conversation, in a new tab after the active one of `entry` if no tab shows it. */
  private openInTab(entry: Win, conversationId: string, show: boolean): Conversation {
    if (!this.findTab(conversationId)) {
      if (!(conversationId in this.opts.store.get().conversations)) throw new Error(`Unknown conversation ${conversationId}`)
      const tab = { id: randomUUID(), conversationId }
      entry.tabs.splice(entry.tabs.findIndex((t) => t.id === entry.activeTabId) + 1, 0, tab)
      this.openConversationObject(conversationId)
      if (show) {
        entry.activeTabId = tab.id
        this.activate(entry)
      }
      this.changed(entry)
    }
    return this.conversation(conversationId)
  }

  private openConversationObject(id: string): Conversation {
    const existing = this.conversations.get(id)
    if (existing) return existing
    const stored = this.opts.store.get().conversations[id]
    if (!stored) throw new Error(`Unknown conversation ${id}`)
    const settings = { model: stored.model, effort: stored.effort, permissionMode: stored.permissionMode }
    const conversation = new Conversation(id, stored.cwd, projectName(stored.cwd, this.opts.scratchRoot), settings, {
      onMeta: (meta) => {
        const was = this.lastStatus.get(id)
        this.lastStatus.set(id, meta.status)
        if (was === 'running' && meta.status !== 'running') this.reviews.turnEnded(id)
        this.send(id, IPC.evConversationMeta, meta)
        this.tabChanged(id)
      },
      onItems: (items) => this.send(id, IPC.evConversationItems, items),
      onUsage: (usage) => {
        this.usage = usage
        this.broadcast(IPC.evUsage, usage)
      },
      onSettings: (s) => {
        this.opts.store.update((state) => {
          const entry = state.conversations[id]
          if (entry) Object.assign(entry, s)
        })
      },
      onSessionChanged: () => {
        if (!stored.scratch) {
          this.opts.store.update((s) => {
            s.recents = [{ path: stored.cwd, lastUsed: Date.now() }, ...s.recents.filter((r) => r.path !== stored.cwd)].slice(0, 50)
          })
        }
        this.broadcast(IPC.evConversationsChanged)
      },
    })
    this.conversations.set(id, conversation)
    // Before its process starts, so the process gets them.
    this.syncReviewTools(id).catch((err: unknown) => console.error(`Giving conversation ${id} its review tools failed:`, err))
    void conversation.load().then(
      () => this.tabChanged(id),
      (err: unknown) => console.error(`Loading conversation ${id} failed:`, err),
    )
    return conversation
  }

  /** Shows a window's active tab: its conversation's process starts if it is not running. */
  private activate(entry: Win): void {
    const tab = entry.tabs.find((t) => t.id === entry.activeTabId)
    if (!tab?.conversationId) return
    const conversation = this.conversations.get(tab.conversationId)
    if (conversation && conversation.snapshotMeta().status === 'cold') {
      conversation.start().catch(() => {
        // The conversation shows the error itself.
      })
    }
  }

  private releaseTab(tab: Tab): void {
    if (!tab.conversationId || this.findTab(tab.conversationId)) return
    void this.conversations.get(tab.conversationId)?.stop()
    this.conversations.delete(tab.conversationId)
    this.revs.delete(tab.conversationId)
    this.reviewRoles.delete(tab.conversationId)
    this.lastStatus.delete(tab.conversationId)
  }

  private findTab(conversationId: string): { entry: Win; tab: Tab } | undefined {
    for (const entry of this.windows.values()) {
      const tab = entry.tabs.find((t) => t.conversationId === conversationId)
      if (tab) return { entry, tab }
    }
    return undefined
  }

  private stopIdle(): void {
    const now = Date.now()
    for (const conversation of this.conversations.values()) {
      const since = conversation.idleSince
      if (since !== null && now - since > IDLE_STOP_MS) void conversation.stop()
    }
  }

  private tabInfo(tab: Tab): TabInfo {
    if (!tab.conversationId) return { id: tab.id, conversationId: null, title: 'New tab', status: 'new' }
    const conversation = this.conversations.get(tab.conversationId)
    if (!conversation) return { id: tab.id, conversationId: tab.conversationId, title: 'Conversation', status: 'idle' }
    const meta = conversation.snapshotMeta()
    let status: TabStatus = 'idle'
    if (meta.requests.length > 0) status = 'attention'
    else if (meta.status === 'running' || meta.status === 'starting' || meta.compacting) status = 'running'
    else if (meta.status === 'error') status = 'error'
    return { id: tab.id, conversationId: tab.conversationId, title: meta.title, status }
  }

  private readonly lastTabInfo = new Map<string, string>()

  /** Re-sends the window state when a conversation's tab title or status changed. */
  private tabChanged(conversationId: string): void {
    const found = this.findTab(conversationId)
    if (!found) return
    const info = JSON.stringify(this.tabInfo(found.tab))
    if (this.lastTabInfo.get(conversationId) === info) return
    this.lastTabInfo.set(conversationId, info)
    this.sendWindowState(found.entry)
  }

  private changed(entry: Win): void {
    this.sendWindowState(entry)
    this.persistLayout()
  }

  private sendWindowState(entry: Win): void {
    if (!entry.win.isDestroyed()) entry.win.webContents.send(IPC.evWindowState, this.windowState(entry))
  }

  private send(conversationId: string, channel: string, payload: unknown): void {
    const rev = (this.revs.get(conversationId) ?? 0) + 1
    this.revs.set(conversationId, rev)
    const found = this.findTab(conversationId)
    if (found && !found.entry.win.isDestroyed()) found.entry.win.webContents.send(channel, conversationId, payload, rev)
  }

  private broadcast(channel: string, ...args: unknown[]): void {
    for (const entry of this.windows.values()) if (!entry.win.isDestroyed()) entry.win.webContents.send(channel, ...args)
  }

  private persistLayout(): void {
    if (this.quitting) return
    const windows: StoredWindow[] = []
    for (const entry of this.windows.values()) {
      if (entry.win.isDestroyed() || entry.tabs.length === 0) continue
      windows.push({
        bounds: entry.win.getNormalBounds(),
        tabs: entry.tabs.map((t) => t.conversationId),
        activeIndex: Math.max(0, entry.tabs.findIndex((t) => t.id === entry.activeTabId)),
      })
    }
    this.opts.store.update((s) => {
      s.windows = windows
    })
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Stored bounds, unless they would put the window off every display. */
function visibleBounds(bounds: Partial<Rectangle> | null): Partial<Rectangle> {
  if (!bounds || bounds.x === undefined || bounds.y === undefined) return bounds ?? {}
  const { x, y } = bounds
  const onScreen = screen.getAllDisplays().some((d) => x >= d.workArea.x - 100 && x < d.workArea.x + d.workArea.width - 100 && y >= d.workArea.y && y < d.workArea.y + d.workArea.height - 100)
  return onScreen ? bounds : { width: bounds.width, height: bounds.height }
}
