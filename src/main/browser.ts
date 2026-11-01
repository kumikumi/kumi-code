// The browser of a conversation: tabs the agent drives with the browser tools, and
// the user watches, and can use, in the browser pane. Each tab is an offscreen window
// that is never shown. It renders at its own viewport size whether or not anyone
// looks, so neither the pane's size, nor whether the conversation's tab shows, nor
// what else happens on the screen changes what the page sees. The pane gets the
// active tab's frames and sends back the user's input.
//
// Tabs share one persistent profile, apart from Kumi Code's own: sign-ins to the
// apps being worked on last across conversations and restarts.

import { app, BrowserWindow, clipboard, Menu, session } from 'electron'
import type { ContextMenuParams, DownloadItem, MenuItemConstructorOptions, NativeImage, Rectangle, Session, WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { BrowserDownload, BrowserState, BrowserTabInfo, Viewport } from '@shared/types'
import type { KeyPress } from '../core/keys'
import { HELPER_WORLD, helperCall } from './browser-page'

export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800, mobile: false, colorScheme: null }

const PARTITION = 'persist:browser'
/** The pane gets at most this many frames a second. */
const FRAME_RATE = 30
const CONSOLE_LIMIT = 1000
const NETWORK_LIMIT = 500
const NAVIGATION_TIMEOUT_MS = 30_000
/** How long after the user's right click a context menu the page asks for is still theirs. */
const CONTEXT_MENU_MS = 1000

export interface ConsoleEntry {
  level: 'debug' | 'info' | 'warning' | 'error'
  text: string
  source: string
}

export interface NetworkEntry {
  requestId: string
  method: string
  url: string
  type: string
  status: number | null
  mimeType: string
  failed: string | null
}

interface TabEvents {
  changed(): void
  /** The page's viewport changed, which a page that does not repaint by itself would not show. */
  resized(tab: BrowserTab): void
  painted(tab: BrowserTab, image: NativeImage): void
  /** The page asked for a new window. */
  open(url: string): void
  /** The user right-clicked the page: the menu to show them. */
  contextMenu(menu: Menu): void
  /** The page started a download, which waits for a path to save to. */
  download(item: DownloadItem): void
}

let browserSession: Session | null = null
/** Where the downloads of each tab's page go, by its WebContents id. */
const downloadHandlers = new Map<number, (item: DownloadItem) => void>()
/** Paths downloads in progress save to, which a new download does not take. */
const savingPaths = new Set<string>()

/** The profile every tab uses, set up once. */
function profile(): Session {
  if (browserSession) return browserSession
  const s = session.fromPartition(PARTITION)
  // The user agent stays Electron's. A Chrome one, on a browser that lacks Chrome's other
  // traits, fails bot checks such as Cloudflare's Turnstile (error 600010).

  // A tab's download goes to its browser; any other is refused.
  s.on('will-download', (event, item, contents) => {
    const handler = downloadHandlers.get(contents.id)
    if (handler) handler(item)
    else event.preventDefault()
  })
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  browserSession = s
  return s
}

/** A path in the folder for the file that neither a file there nor a download in progress has: "report (1).pdf" after "report.pdf". */
function freePath(dir: string, filename: string): string {
  const name = basename(filename) || 'download'
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 0; ; i++) {
    const path = join(dir, i === 0 ? name : `${stem} (${i})${ext}`)
    if (!existsSync(path) && !savingPaths.has(path)) return path
  }
}

/** Marks a downloaded file as from the internet, as browsers do on macOS (Electron does not): Gatekeeper then checks an app or script in it before it first runs. */
function quarantine(path: string): void {
  if (process.platform !== 'darwin') return
  const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};Kumi Code;${randomUUID().toUpperCase()}`
  execFile('xattr', ['-w', 'com.apple.quarantine', value, path], () => {
    // A file gone meanwhile needs no mark.
  })
}

function mobileUserAgent(): string {
  const major = process.versions.chrome?.split('.')[0] ?? '140'
  return `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`
}

export class BrowserTab {
  readonly window: BrowserWindow
  viewport: Viewport = { ...DEFAULT_VIEWPORT }
  readonly console: ConsoleEntry[] = []
  readonly network = new Map<string, NetworkEntry>()
  /** Frame pixels per page pixel in the latest screenshot, which agent coordinates refer to. */
  frameScale = 1
  private forceUnload = false
  private blockedUnload = false
  /** Until when the context menu the page asks for is the user's: the agent's right clicks show none. */
  private contextMenuUntil = 0
  private readonly ready: Promise<void>

  constructor(
    readonly id: string,
    private readonly events: TabEvents,
  ) {
    this.window = new BrowserWindow({
      show: false,
      width: DEFAULT_VIEWPORT.width,
      height: DEFAULT_VIEWPORT.height,
      useContentSize: true,
      skipTaskbar: true,
      webPreferences: { offscreen: true, backgroundThrottling: false, session: profile(), sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    // Kept out of the Window menu on macOS.
    this.window.excludedFromShownWindowsMenu = true
    const wc = this.wc
    wc.setFrameRate(FRAME_RATE)
    // Keys the page leaves unhandled stay with the page. Electron would offer them to the
    // app menu, where a lone Cmd, which a synthetic event has no character for, matches the
    // first item without a shortcut: About.
    wc.setIgnoreMenuShortcuts(true)
    // An offscreen page shows no menu of its own.
    wc.on('context-menu', (_event, params) => {
      if (Date.now() > this.contextMenuUntil) return
      this.contextMenuUntil = 0
      this.events.contextMenu(this.contextMenu(params))
    })
    const contentsId = wc.id
    downloadHandlers.set(contentsId, (item) => this.events.download(item))
    wc.once('destroyed', () => downloadHandlers.delete(contentsId))
    wc.on('paint', (_event, _dirty, image) => this.events.painted(this, image))
    for (const name of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading'] as const) {
      wc.on(name as 'did-stop-loading', () => this.events.changed())
    }
    wc.on('console-message', (event) => this.log(event.level, event.message, `${event.sourceId}:${event.lineNumber}`))
    wc.on('will-prevent-unload', (event) => {
      if (this.forceUnload) event.preventDefault()
      else this.blockedUnload = true
    })
    wc.on('render-process-gone', (_event, details) => {
      this.log('error', `The page's process ended: ${details.reason}`, '')
      this.events.changed()
    })
    wc.setWindowOpenHandler(({ url }) => {
      this.events.open(url)
      return { action: 'deny' }
    })
    this.ready = this.init()
  }

  get wc(): WebContents {
    return this.window.webContents
  }

  private async init(): Promise<void> {
    // The DevTools protocol answers once the tab has a page.
    await this.wc.loadURL('about:blank')
    this.wc.debugger.attach('1.3')
    this.wc.debugger.on('message', (_event, method, params) => this.protocolEvent(method, params as Record<string, unknown>))
    await this.protocol('Network.enable')
    await this.protocol('Page.enable')
  }

  info(): BrowserTabInfo {
    const wc = this.wc
    return {
      id: this.id,
      title: wc.getTitle(),
      url: wc.getURL(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      viewport: { ...this.viewport },
    }
  }

  url(): string {
    return this.wc.getURL()
  }

  /** Opens a URL. A page that asks before it is left stops it unless `force`. */
  async navigate(url: string, force = false): Promise<string> {
    await this.ready
    this.forceUnload = force
    this.blockedUnload = false
    let timedOut = false
    try {
      await Promise.race([
        this.wc.loadURL(url),
        new Promise<void>((done) =>
          setTimeout(() => {
            timedOut = true
            done()
          }, NAVIGATION_TIMEOUT_MS),
        ),
      ])
    } catch (err) {
      if (this.blockedUnload) throw new Error('The page shows a "Leave site?" dialog because of unsaved changes. Navigate with force: true to discard them.')
      const message = err instanceof Error ? err.message : String(err)
      // ERR_ABORTED also means the page replaced the navigation with one of its own.
      if (!message.includes('ERR_ABORTED')) throw new Error(`Could not open ${url}: ${message}`)
    } finally {
      this.forceUnload = false
    }
    return `${timedOut ? 'Still loading after 30 s: ' : ''}${this.describe()}`
  }

  async history(direction: 'back' | 'forward'): Promise<string> {
    await this.ready
    const history = this.wc.navigationHistory
    if (direction === 'back' ? !history.canGoBack() : !history.canGoForward()) throw new Error(`There is no page to go ${direction} to`)
    const settled = this.settled()
    if (direction === 'back') history.goBack()
    else history.goForward()
    await settled
    return this.describe()
  }

  async reload(): Promise<void> {
    await this.ready
    this.wc.reload()
  }

  describe(): string {
    return `${this.wc.getTitle() || '(no title)'} · ${this.wc.getURL()}`
  }

  /** The page as it is drawn now, at page pixels, or a region of it. */
  async capture(rect?: Rectangle): Promise<NativeImage> {
    await this.ready
    return this.wc.capturePage(rect)
  }

  async click(x: number, y: number, button: 'left' | 'right' | 'middle', count: number, modifiers: number): Promise<void> {
    await this.mouse('mouseMoved', x, y, 'none', 0, modifiers)
    for (let i = 1; i <= count; i++) {
      await this.mouse('mousePressed', x, y, button, i, modifiers)
      await this.mouse('mouseReleased', x, y, button, i, modifiers)
    }
  }

  async drag(from: [number, number], to: [number, number], modifiers: number): Promise<void> {
    await this.mouse('mouseMoved', from[0], from[1], 'none', 0, modifiers)
    await this.mouse('mousePressed', from[0], from[1], 'left', 1, modifiers)
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      await this.mouse('mouseMoved', from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, 'left', 0, modifiers)
    }
    await this.mouse('mouseReleased', to[0], to[1], 'left', 1, modifiers)
  }

  async mouse(type: 'mousePressed' | 'mouseReleased' | 'mouseMoved', x: number, y: number, button: 'left' | 'right' | 'middle' | 'none', clickCount: number, modifiers: number): Promise<void> {
    await this.ready
    const buttons = type === 'mouseReleased' || button === 'none' ? 0 : button === 'left' ? 1 : button === 'right' ? 2 : 4
    await this.protocol('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount, modifiers })
  }

  async wheel(x: number, y: number, deltaX: number, deltaY: number, modifiers: number): Promise<void> {
    await this.ready
    await this.protocol('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers })
  }

  async key(press: KeyPress, action: 'down' | 'up' | 'press'): Promise<void> {
    await this.ready
    const base = { key: press.key, code: press.code, windowsVirtualKeyCode: press.keyCode, nativeVirtualKeyCode: press.keyCode, modifiers: press.modifiers }
    if (action !== 'up') {
      await this.protocol('Input.dispatchKeyEvent', {
        ...base,
        type: press.text ? 'keyDown' : 'rawKeyDown',
        text: press.text || undefined,
        unmodifiedText: press.text || undefined,
        commands: press.commands.length ? press.commands : undefined,
      })
    }
    if (action !== 'down') await this.protocol('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  }

  async insertText(text: string): Promise<void> {
    await this.ready
    await this.protocol('Input.insertText', { text })
  }

  /** Runs JavaScript in the page with REPL semantics: top-level await, the last expression's value. */
  async evaluate(expression: string): Promise<string> {
    await this.ready
    const result = (await this.protocol('Runtime.evaluate', { expression, replMode: true, awaitPromise: true, returnByValue: true, userGesture: true })) as {
      result: { type: string; value?: unknown; description?: string; unserializableValue?: string }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    const r = result.result
    if (r.type === 'undefined') return 'undefined'
    if (r.unserializableValue !== undefined) return r.unserializableValue
    if ('value' in r) return JSON.stringify(r.value, null, 2) ?? String(r.value)
    return r.description ?? r.type
  }

  /** Calls the page helper (browser-page.ts). */
  async helper<T>(fn: Parameters<typeof helperCall>[0], ...args: unknown[]): Promise<T> {
    await this.ready
    const result = (await this.wc.executeJavaScriptInIsolatedWorld(HELPER_WORLD, [{ code: helperCall(fn, ...args) }])) as { ok?: T; error?: string } | null
    if (!result) throw new Error('The page did not answer')
    if (result.error !== undefined) throw new Error(result.error)
    return result.ok as T
  }

  async setViewport(viewport: Viewport): Promise<void> {
    await this.ready
    this.viewport = { ...viewport }
    this.window.setContentSize(viewport.width, viewport.height)
    if (viewport.mobile) {
      await this.protocol('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: true })
      await this.protocol('Emulation.setUserAgentOverride', { userAgent: mobileUserAgent(), platform: 'Android' })
      await this.protocol('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    } else {
      await this.protocol('Emulation.clearDeviceMetricsOverride')
      await this.protocol('Emulation.setUserAgentOverride', { userAgent: profile().getUserAgent() })
      await this.protocol('Emulation.setTouchEmulationEnabled', { enabled: false })
    }
    await this.protocol('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: viewport.colorScheme ?? '' }] })
    this.events.changed()
    this.events.resized(this)
  }

  devtools(): void {
    this.wc.openDevTools({ mode: 'detach' })
  }

  /** The user pressed the right button on the page: the context menu the page asks for next is theirs to see. */
  expectContextMenu(): void {
    this.contextMenuUntil = Date.now() + CONTEXT_MENU_MS
  }

  async responseBody(requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
    await this.ready
    if (!this.network.has(requestId)) throw new Error(`No request ${requestId}; read_network_requests lists them`)
    return (await this.protocol('Network.getResponseBody', { requestId })) as { body: string; base64Encoded: boolean }
  }

  destroy(): void {
    if (!this.window.isDestroyed()) this.window.destroy()
  }

  /** A browser's menu for what was right-clicked: a link, an image, a text field or selected text, else the page. */
  private contextMenu(params: ContextMenuParams): Menu {
    const wc = this.wc
    const items: MenuItemConstructorOptions[] = []
    const group = (...group: MenuItemConstructorOptions[]): void => {
      if (items.length > 0) items.push({ type: 'separator' })
      items.push(...group)
    }
    if (params.linkURL) {
      group(
        { label: 'Open Link in New Tab', click: () => this.events.open(params.linkURL) },
        { label: 'Download Linked File', click: () => wc.downloadURL(params.linkURL) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
      )
    }
    if (params.mediaType === 'image' && params.srcURL) {
      group(
        { label: 'Download Image', click: () => wc.downloadURL(params.srcURL) },
        { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
      )
    }
    const can = params.editFlags
    if (params.isEditable) {
      group(
        { label: 'Undo', enabled: can.canUndo, click: () => wc.undo() },
        { label: 'Redo', enabled: can.canRedo, click: () => wc.redo() },
        { type: 'separator' },
        { label: 'Cut', enabled: can.canCut, click: () => wc.cut() },
        { label: 'Copy', enabled: can.canCopy, click: () => wc.copy() },
        { label: 'Paste', enabled: can.canPaste, click: () => wc.paste() },
        { label: 'Select All', enabled: can.canSelectAll, click: () => wc.selectAll() },
      )
    } else if (params.selectionText) {
      group({ label: 'Copy', click: () => wc.copy() })
    }
    if (items.length === 0) {
      const history = wc.navigationHistory
      group(
        { label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() },
        { label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() },
        { label: 'Reload', click: () => wc.reload() },
      )
    }
    group({
      label: 'Inspect',
      click: () => {
        this.devtools()
        wc.inspectElement(params.x, params.y)
      },
    })
    return Menu.buildFromTemplate(items)
  }

  private protocol(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.wc.debugger.sendCommand(method, params)
  }

  private protocolEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Network.requestWillBeSent': {
        const request = params.request as { url: string; method: string }
        const id = String(params.requestId)
        this.network.delete(id)
        this.network.set(id, { requestId: id, method: request.method, url: request.url, type: String(params.type ?? ''), status: null, mimeType: '', failed: null })
        if (this.network.size > NETWORK_LIMIT) this.network.delete(this.network.keys().next().value as string)
        return
      }
      case 'Network.responseReceived': {
        const entry = this.network.get(String(params.requestId))
        const response = params.response as { status: number; mimeType: string }
        if (entry) Object.assign(entry, { status: response.status, mimeType: response.mimeType })
        return
      }
      case 'Network.loadingFailed': {
        const entry = this.network.get(String(params.requestId))
        if (entry) entry.failed = String(params.errorText ?? 'failed')
        return
      }
      case 'Page.javascriptDialogOpening':
        // A dialog would stop the page until someone answers it; nobody sees this window.
        this.log('info', `[${String(params.type)} dialog, accepted] ${String(params.message)}`, '')
        void this.protocol('Page.handleJavaScriptDialog', { accept: true, promptText: String(params.defaultPrompt ?? '') }).catch(() => {})
        return
    }
  }

  private log(level: ConsoleEntry['level'], text: string, source: string): void {
    this.console.push({ level, text, source })
    if (this.console.length > CONSOLE_LIMIT) this.console.splice(0, this.console.length - CONSOLE_LIMIT)
  }

  /** Settles when the page has loaded, or after a while. */
  private settled(): Promise<void> {
    return new Promise((done) => {
      const finish = (): void => {
        clearTimeout(timer)
        this.wc.off('did-stop-loading', finish)
        this.wc.off('did-navigate-in-page', finish)
        done()
      }
      const timer = setTimeout(finish, NAVIGATION_TIMEOUT_MS)
      this.wc.once('did-stop-loading', finish)
      this.wc.once('did-navigate-in-page', finish)
    })
  }
}

export interface BrowserEvents {
  state(state: BrowserState): void
  frame(tabId: string, jpeg: Buffer, width: number, height: number): void
  /** A menu for the user's right click on a tab, to show where they clicked. */
  contextMenu(menu: Menu): void
}

export class Browser {
  private readonly tabs: BrowserTab[] = []
  private activeId: string | null = null
  private counter = 0
  private readonly downloads: { info: BrowserDownload; item: DownloadItem }[] = []
  private downloadCounter = 0
  private activity: string | null = null
  private watched = false
  /** Origins the user let the agent open, beyond local ones. */
  readonly allowedOrigins = new Set<string>()
  private pending: { tab: BrowserTab; image: NativeImage } | null = null
  private frameTimer: NodeJS.Timeout | null = null
  private lastFrameAt = 0

  constructor(private readonly events: BrowserEvents) {}

  state(): BrowserState {
    return { tabs: this.tabs.map((t) => t.info()), activeTabId: this.activeId, activity: this.activity, downloads: this.downloads.map((d) => ({ ...d.info })) }
  }

  list(): BrowserTab[] {
    return [...this.tabs]
  }

  get isWatched(): boolean {
    return this.watched
  }

  /** A tab by id, or the active one. */
  tab(id?: string): BrowserTab {
    if (id) {
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab) throw new Error(`No tab ${id}; tabs_context lists the tabs`)
      return tab
    }
    const active = this.tabs.find((t) => t.id === this.activeId)
    if (!active) throw new Error('No browser tab is open. Open a page with navigate, or a tab with tabs_create.')
    return active
  }

  async create(foreground: boolean): Promise<BrowserTab> {
    const tab = new BrowserTab(String(++this.counter), {
      changed: () => this.changed(),
      resized: (t) => {
        // After the page has laid out at its new size.
        setTimeout(() => t.id === this.activeId && this.sendCurrentFrame(), 100)
      },
      painted: (t, image) => this.painted(t, image),
      open: (url) => {
        void this.create(true).then((opened) => opened.navigate(url))
      },
      contextMenu: (menu) => this.events.contextMenu(menu),
      download: (item) => this.save(item),
    })
    this.tabs.push(tab)
    if (foreground || this.activeId === null) this.activeId = tab.id
    this.changed()
    if (this.activeId === tab.id) this.sendCurrentFrame()
    return tab
  }

  select(id: string): void {
    this.tab(id)
    this.activeId = id
    this.changed()
    this.sendCurrentFrame()
  }

  close(id: string): void {
    const tab = this.tab(id)
    const index = this.tabs.indexOf(tab)
    this.tabs.splice(index, 1)
    tab.destroy()
    if (this.activeId === id) {
      this.activeId = this.tabs[Math.min(index, this.tabs.length - 1)]?.id ?? null
      this.sendCurrentFrame()
    }
    this.changed()
  }

  downloadOf(id: string): BrowserDownload {
    const download = this.downloads.find((d) => d.info.id === id)
    if (!download) throw new Error(`No download ${id}`)
    return { ...download.info }
  }

  cancelDownload(id: string): void {
    this.downloads.find((d) => d.info.id === id)?.item.cancel()
  }

  /** Takes a download off the list; one in progress goes on. */
  removeDownload(id: string): void {
    const index = this.downloads.findIndex((d) => d.info.id === id)
    if (index === -1) return
    this.downloads.splice(index, 1)
    this.changed()
  }

  /** Marks what a browser tool does while it runs, for the pane. */
  async busy<T>(activity: string, fn: () => Promise<T>): Promise<T> {
    this.activity = activity
    this.changed()
    try {
      return await fn()
    } finally {
      this.activity = null
      this.changed()
    }
  }

  /** Whether some window shows this browser: only then are frames sent. */
  setWatched(watched: boolean): void {
    if (watched === this.watched) return
    this.watched = watched
    if (watched) this.sendCurrentFrame()
  }

  destroy(): void {
    if (this.frameTimer) clearTimeout(this.frameTimer)
    for (const tab of this.tabs) tab.destroy()
    this.tabs.length = 0
    this.activeId = null
  }

  private changed(): void {
    this.events.state(this.state())
  }

  /** Saves a page's download in the Downloads folder, as a browser does without asking. */
  private save(item: DownloadItem): void {
    const dir = app.getPath('downloads')
    mkdirSync(dir, { recursive: true })
    const path = freePath(dir, item.getFilename())
    item.setSavePath(path)
    savingPaths.add(path)
    const info: BrowserDownload = { id: String(++this.downloadCounter), name: basename(path), path, state: 'progressing', receivedBytes: 0, totalBytes: item.getTotalBytes() }
    const update = (): void => {
      info.state = item.getState()
      info.receivedBytes = item.getReceivedBytes()
      info.totalBytes = item.getTotalBytes()
      if (info.state !== 'progressing') savingPaths.delete(path)
      this.changed()
    }
    item.on('updated', update)
    item.on('done', () => {
      if (item.getState() === 'completed') quarantine(path)
      update()
    })
    this.downloads.push({ info, item })
    this.changed()
  }

  private painted(tab: BrowserTab, image: NativeImage): void {
    if (!this.watched || tab.id !== this.activeId) return
    this.pending = { tab, image }
    if (this.frameTimer) return
    const wait = Math.max(0, 1000 / FRAME_RATE - (Date.now() - this.lastFrameAt))
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null
      const frame = this.pending
      this.pending = null
      if (frame && frame.tab.id === this.activeId && !frame.image.isEmpty()) this.sendFrame(frame.tab, frame.image)
    }, wait)
  }

  private sendCurrentFrame(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId)
    if (!this.watched || !tab) return
    void tab.capture().then(
      (image) => {
        if (tab.id === this.activeId && !image.isEmpty()) this.sendFrame(tab, image)
      },
      () => {},
    )
  }

  private sendFrame(tab: BrowserTab, image: NativeImage): void {
    this.lastFrameAt = Date.now()
    const { width, height } = image.getSize()
    this.events.frame(tab.id, image.toJPEG(85), width, height)
  }
}
