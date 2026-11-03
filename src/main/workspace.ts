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
// is not open opens it in a new tab. Each open conversation may have a browser
// (browser.ts), which closes with it.

import { BrowserWindow, screen, shell, webContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Rectangle, WebContents } from 'electron'
import { deleteSession, forkSession, getSessionInfo, getSessionMessages, renameSession } from '@anthropic-ai/claude-agent-sdk'
import { Conversation } from '../core/conversation'
import type { ConversationSettings, ToolAccess } from '../core/conversation'
import { userKey } from '../core/keys'
import { Previews } from '../core/previews'
import { Reviews } from '../core/review'
import type { ReviewAnswer } from '../core/review'
import { KUMI_INSTRUCTIONS, KUMI_TOOLS, kumiServers } from '../core/kumi-tools'
import { hasUncommittedChanges } from '../core/git'
import { createScratchFolder, projectName } from '../core/sessions'
import type { StoredMessage } from '../core/transcript'
import { wrapUpResult } from '../core/wrap-up'
import type { Store, StoredWindow } from '../core/store'
import { IPC } from '@shared/types'
import { parseWrapUp } from '@shared/wrap-up'
import type {
  BrowserAction,
  BrowserInput,
  BrowserState,
  ConversationSnapshot,
  TerminalAction,
  TerminalState,
  ConversationStatus,
  DragHover,
  Review,
  TabInfo,
  TabStatus,
  TabStripGeometry,
  UsageWindow,
  WindowState,
} from '@shared/types'
import { isLocalUrl, normalizeUrl, originOf } from '../core/urls'
import { Browser } from './browser'
import { BROWSER_TOOLS_ALLOWED, browserServers, runTool } from './browser-tools'
import type { BrowserToolContext } from './browser-tools'
import { Terminals } from './terminal'
import { TERMINAL_TOOLS_ALLOWED, terminalServers, terminalTools } from './terminal-tools'
import type { TerminalToolContext } from './terminal-tools'

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
  /** Each open conversation's last status, to see its turns end. */
  private readonly lastStatus = new Map<string, ConversationStatus>()
  private readonly browsers = new Map<string, Browser>()
  /** The renderers (web contents ids) that show each conversation's browser. */
  private readonly browserWatchers = new Map<string, Set<number>>()
  /** Dev server configurations the user let each conversation start without asking. */
  private readonly allowedPreviews = new Map<string, Set<string>>()
  private readonly previews = new Previews()
  private readonly terminals = new Map<string, Terminals>()
  /** The renderers (web contents ids) that show each conversation's terminal pane. */
  private readonly terminalWatchers = new Map<string, Set<number>>()
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
    const contentsId = win.webContents.id
    win.on('closed', () => {
      for (const id of this.browserWatchers.keys()) this.watchBrowser(contentsId, id, false)
      for (const id of this.terminalWatchers.keys()) this.watchTerminals(contentsId, id, false)
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
    for (const browser of this.browsers.values()) browser.destroy()
    for (const terminals of this.terminals.values()) terminals.destroy()
    this.previews.stopAll()
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
      // A pick the model list no longer offers falls back to the default once the list is known.
      s.conversations[id] = { cwd: folder, scratch, createdAt: Date.now(), ...DEFAULT_SETTINGS, ...s.lastPicked }
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

  /**
   * Copies a conversation, up to the end of the turn whose last message is `upTo` or whole,
   * into a new one with the same folder and settings (`model`, when given, instead of its
   * own), and shows it in a tab after the active one of `entry`.
   */
  async forkConversation(entry: Win, id: string, upTo: string | null, model: string | null): Promise<void> {
    const stored = this.opts.store.get().conversations[id]
    if (!stored) throw new Error(`Unknown conversation ${id}`)
    const meta = this.conversations.get(id)?.snapshotMeta()
    // The copy would end inside the turn.
    if (upTo === null && (meta?.status === 'running' || meta?.compacting)) throw new Error('Fork the whole conversation once the turn has ended')
    const info = meta ? undefined : await getSessionInfo(id, { dir: stored.cwd })
    const title = meta?.title ?? info?.customTitle ?? info?.summary ?? 'Conversation'
    // forkSession stamps the copy's last message with the time it runs, so its own time is kept here.
    const messages = await getSessionMessages(id, { dir: stored.cwd })
    const last = (upTo ? messages.find((m) => m.uuid === upTo) : messages.at(-1)) as StoredMessage | undefined
    if (!last) throw new Error(upTo ? `No message ${upTo} in the conversation` : 'The conversation has no messages')
    const { sessionId } = await forkSession(id, { dir: stored.cwd, ...(upTo ? { upToMessageId: upTo } : {}) })
    const at = Date.now()
    const lastAt = last.timestamp ? Date.parse(last.timestamp) : NaN
    this.opts.store.update((s) => {
      s.conversations[sessionId] = {
        cwd: stored.cwd,
        scratch: stored.scratch,
        createdAt: at,
        model: model ?? meta?.model ?? stored.model,
        effort: meta?.effort ?? stored.effort,
        permissionMode: meta?.permissionMode ?? stored.permissionMode,
        forkedFrom: { id, title, at, lastAt: Number.isNaN(lastAt) ? null : lastAt },
      }
      if (model) s.lastPicked = { ...s.lastPicked, model }
    })
    this.openInTab(entry, sessionId, true)
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
      await this.openInTab(entry, relay.conversationId, false).relay(relay.text)
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

  /** A wrap_up call: the renderer draws the box from the transcript; a blocked one marks the tab as waiting. */
  private async wrapUp(id: string, input: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    // commit holds while there is something to commit.
    const available = (await hasUncommittedChanges(this.opts.store.get().conversations[id]?.cwd ?? '')) ? ['commit'] : []
    const result = wrapUpResult(input, available)
    if (!result.isError && parseWrapUp(input).blocked) this.conversations.get(id)?.setWaiting(true)
    return result
  }

  // ---- browsers ----

  /** The conversation's browser; no tabs when it has none. */
  browserState(id: string): BrowserState {
    return this.browsers.get(id)?.state() ?? { tabs: [], activeTabId: null, activity: null, downloads: [] }
  }

  /** What the user does in the browser pane. Pages the user opens, the agent may open too. */
  async browserAction(id: string, action: BrowserAction): Promise<void> {
    const browser = this.browserOf(id)
    switch (action.kind) {
      case 'navigate': {
        const url = normalizeUrl(action.url)
        browser.allowedOrigins.add(originOf(url))
        const tab = browser.list().length > 0 ? browser.tab() : await browser.create(true)
        await tab.navigate(url)
        return
      }
      case 'back':
      case 'forward':
        await browser.tab(action.tabId).history(action.kind)
        return
      case 'reload':
        await browser.tab(action.tabId).reload()
        return
      case 'select':
        browser.select(action.tabId)
        return
      case 'close':
        browser.close(action.tabId)
        return
      case 'devtools':
        browser.tab(action.tabId).devtools()
        return
      case 'newTab':
        await browser.create(true)
        return
      case 'viewport':
        await browser.tab(action.tabId).setViewport(action.viewport)
        return
      case 'cancelDownload':
        browser.cancelDownload(action.downloadId)
        return
      case 'showDownload':
        shell.showItemInFolder(browser.downloadOf(action.downloadId).path)
        return
      case 'removeDownload':
        browser.removeDownload(action.downloadId)
        return
    }
  }

  browserInput(id: string, tabId: string, input: BrowserInput): void {
    const tab = this.browsers.get(id)?.list().find((t) => t.id === tabId)
    if (!tab) return
    const sent = (p: Promise<void>): void => {
      p.catch(() => {
        // Input to a tab that closes meanwhile goes nowhere.
      })
    }
    if (input.type === 'mouse') {
      const type = input.action === 'down' ? 'mousePressed' : input.action === 'up' ? 'mouseReleased' : 'mouseMoved'
      if (input.action === 'down' && input.button === 'right') tab.expectContextMenu()
      sent(tab.mouse(type, input.x, input.y, input.button, input.clickCount, input.modifiers))
    } else if (input.type === 'wheel') {
      sent(tab.wheel(input.x, input.y, input.deltaX, input.deltaY, input.modifiers))
    } else {
      sent(tab.key(userKey(input.key, input.code, input.keyCode, input.modifiers), input.action))
    }
  }

  /** Whether a renderer shows the conversation's browser: frames go only to those that do. */
  watchBrowser(contentsId: number, id: string, watching: boolean): void {
    const watchers = this.browserWatchers.get(id) ?? new Set<number>()
    if (watching) watchers.add(contentsId)
    else watchers.delete(contentsId)
    if (watchers.size > 0) this.browserWatchers.set(id, watchers)
    else this.browserWatchers.delete(id)
    this.browsers.get(id)?.setWatched(watchers.size > 0)
  }

  /** Runs a browser tool for a conversation, as its agent would. */
  browserTool(id: string, name: string, input: Record<string, unknown>): ReturnType<typeof runTool> {
    return runTool(this.browserContext(id), name, input)
  }

  // ---- terminals ----

  /** The conversation's Terminal panel; no tabs when it has none. */
  terminalState(id: string): TerminalState {
    return this.terminals.get(id)?.state() ?? { tabs: [], activeTabId: null }
  }

  /** What the user does in the terminal pane's tab strip. A tab the user opens starts in the conversation's folder. */
  terminalAction(id: string, action: TerminalAction): void {
    const terminals = this.terminalOf(id)
    if (action.kind === 'open') terminals.open(this.opts.store.get().conversations[id]?.cwd ?? '', null, 'user')
    else if (action.kind === 'select') terminals.select(action.tabId)
    else terminals.close(action.tabId)
  }

  terminalSnapshot(id: string, tabId: string): { data: string; seq: number } {
    return this.terminalOf(id).tab(tabId).snapshot()
  }

  terminalInput(id: string, tabId: string, data: string): void {
    this.terminals.get(id)?.list().find((t) => t.id === tabId)?.write(data)
  }

  terminalResize(id: string, tabId: string, cols: number, rows: number): void {
    this.terminals.get(id)?.list().find((t) => t.id === tabId)?.resize(cols, rows)
  }

  /** Whether a renderer shows the conversation's terminal pane: output goes only to those that do. */
  watchTerminals(contentsId: number, id: string, watching: boolean): void {
    const watchers = this.terminalWatchers.get(id) ?? new Set<number>()
    if (watching) watchers.add(contentsId)
    else watchers.delete(contentsId)
    if (watchers.size > 0) this.terminalWatchers.set(id, watchers)
    else this.terminalWatchers.delete(id)
  }

  /** Runs a terminal tool for a conversation, as its agent would. */
  async terminalTool(id: string, name: string, input: Record<string, unknown>): Promise<unknown> {
    const found = terminalTools(this.terminalContext(id)).find((t) => t.name === name)
    if (!found) throw new Error(`No terminal tool ${name}`)
    return found.handler(input as never, {})
  }

  private terminalOf(id: string): Terminals {
    let terminals = this.terminals.get(id)
    if (!terminals) {
      terminals = new Terminals({
        changed: () => {
          const found = this.findTab(id)
          if (found && !found.entry.win.isDestroyed()) found.entry.win.webContents.send(IPC.evTerminals, id, this.terminalState(id))
        },
        output: (tabId, data, seq) => {
          for (const contentsId of this.terminalWatchers.get(id) ?? []) {
            const contents: WebContents | undefined = webContents.fromId(contentsId)
            if (contents && !contents.isDestroyed()) contents.send(IPC.evTerminalOutput, id, tabId, data, seq)
          }
        },
      })
      this.terminals.set(id, terminals)
    }
    return terminals
  }

  private terminalContext(id: string): TerminalToolContext {
    return {
      terminals: () => this.terminalOf(id),
      existing: () => this.terminals.get(id) ?? null,
      cwd: this.opts.store.get().conversations[id]?.cwd ?? '',
      show: (tabId) => {
        this.terminalOf(id).select(tabId)
        const found = this.findTab(id)
        if (found && !found.entry.win.isDestroyed()) found.entry.win.webContents.send(IPC.evTerminalShow, id, tabId)
      },
    }
  }

  private browserOf(id: string): Browser {
    let browser = this.browsers.get(id)
    if (!browser) {
      browser = new Browser({
        state: (state) => {
          const found = this.findTab(id)
          if (found && !found.entry.win.isDestroyed()) found.entry.win.webContents.send(IPC.evBrowser, id, state)
        },
        frame: (tabId, jpeg, width, height) => {
          for (const contentsId of this.browserWatchers.get(id) ?? []) {
            const contents: WebContents | undefined = webContents.fromId(contentsId)
            if (contents && !contents.isDestroyed()) contents.send(IPC.evBrowserFrame, id, tabId, jpeg, width, height)
          }
        },
        contextMenu: (menu) => {
          const found = this.findTab(id)
          if (found && !found.entry.win.isDestroyed()) menu.popup({ window: found.entry.win })
        },
      })
      browser.setWatched(this.browserWatchers.has(id))
      this.browsers.set(id, browser)
    }
    return browser
  }

  private browserContext(id: string): BrowserToolContext {
    return {
      browser: () => this.browserOf(id),
      existing: () => this.browsers.get(id) ?? null,
      cwd: this.opts.store.get().conversations[id]?.cwd ?? '',
      previews: this.previews,
      allows: (tool, input) => this.browserAllows(id, tool, input),
    }
  }

  /**
   * What a conversation gets from Kumi Code: the kumi server (wrap_up, and the review tools,
   * which answer only in the role the conversation has), the browser's, and which calls run
   * without asking.
   */
  private toolAccess(id: string): ToolAccess {
    return {
      instructions: KUMI_INSTRUCTIONS,
      mcpServers: () => ({
        ...kumiServers({ answer: (a) => this.answer(id, a), wrapUp: (input) => this.wrapUp(id, input) }),
        ...browserServers(this.browserContext(id)),
        ...terminalServers(this.terminalContext(id)),
      }),
      allowedTools: [...KUMI_TOOLS, ...BROWSER_TOOLS_ALLOWED, ...TERMINAL_TOOLS_ALLOWED],
      allows: (tool, input) => this.browserAllows(id, tool, input),
      allowed: (tool, input) => this.browserAllowed(id, tool, input),
    }
  }

  /**
   * Whether a browser tool call may run without asking: opening a local page or one
   * the user allowed in this conversation, running JavaScript on one, or starting a
   * dev server the user let it start before.
   */
  private browserAllows(id: string, tool: string, input: Record<string, unknown>): boolean {
    const browser = this.browsers.get(id)
    const allowedUrl = (url: string): boolean => isLocalUrl(url) || (browser?.allowedOrigins.has(originOf(url)) ?? false)
    const text = (value: unknown): string => (typeof value === 'string' ? value : '')
    switch (tool) {
      case 'mcp__browser__navigate': {
        const url = text(input.url)
        return url === 'back' || url === 'forward' || allowedUrl(normalizeUrl(url))
      }
      case 'mcp__browser__preview_start':
        return text(input.url) ? allowedUrl(normalizeUrl(text(input.url))) : (this.allowedPreviews.get(id)?.has(text(input.name)) ?? false)
      case 'mcp__browser__javascript_tool': {
        const tab = browser?.list().find((t) => t.id === text(input.tabId)) ?? (browser && browser.state().activeTabId ? browser.tab() : undefined)
        // Without a tab the call fails by itself; nothing to ask about.
        return !tab || allowedUrl(tab.url())
      }
      default:
        return false
    }
  }

  private browserAllowed(id: string, tool: string, input: Record<string, unknown>): void {
    const text = (value: unknown): string => (typeof value === 'string' ? value : '')
    if ((tool === 'mcp__browser__navigate' || tool === 'mcp__browser__preview_start') && text(input.url) && !['back', 'forward'].includes(text(input.url))) {
      this.browserOf(id).allowedOrigins.add(originOf(normalizeUrl(text(input.url))))
    } else if (tool === 'mcp__browser__preview_start' && text(input.name)) {
      const names = this.allowedPreviews.get(id) ?? new Set<string>()
      names.add(text(input.name))
      this.allowedPreviews.set(id, names)
    } else if (tool === 'mcp__browser__javascript_tool') {
      const browser = this.browsers.get(id)
      const tab = browser?.list().find((t) => t.id === text(input.tabId)) ?? (browser?.state().activeTabId ? browser.tab() : undefined)
      if (tab) this.browserOf(id).allowedOrigins.add(originOf(tab.url()))
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
    const conversation = new Conversation(id, stored.cwd, projectName(stored.cwd, this.opts.scratchRoot), settings, stored.forkedFrom ?? null, {
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
      onPick: (pick) => {
        this.opts.store.update((s) => {
          s.lastPicked = { ...s.lastPicked, ...pick }
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
      onToolDone: (tool) => {
        // A reviewer reporting its findings again says what became of them.
        if (tool.name === 'ReportFindings' && !tool.isError) this.reviews.applyReport(id, tool.id, tool.input)
      },
    }, this.toolAccess(id))
    this.conversations.set(id, conversation)
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
    this.lastStatus.delete(tab.conversationId)
    this.browsers.get(tab.conversationId)?.destroy()
    this.browsers.delete(tab.conversationId)
    this.browserWatchers.delete(tab.conversationId)
    this.terminals.get(tab.conversationId)?.destroy()
    this.terminals.delete(tab.conversationId)
    this.terminalWatchers.delete(tab.conversationId)
    this.allowedPreviews.delete(tab.conversationId)
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
    if (meta.requests.length > 0 || meta.waiting) status = 'attention'
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
