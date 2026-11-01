// The Terminal panel of a conversation: tabs that each run the user's login shell
// in a pseudo-terminal. The user types in them in the terminal pane; the agent
// runs commands in them, types and presses keys in any of them, and reads them with
// the terminal tools. Each tab keeps its
// screen in a headless terminal, so the tools read it whether or not the pane shows
// it, and the pane starts from a snapshot of it. Shells end with their
// conversation's tab, or when Kumi Code quits.

import { SerializeAddon } from '@xterm/addon-serialize'
// A CommonJS package whose exports Node cannot import by name.
import xtermHeadless from '@xterm/headless'
import type { Terminal } from '@xterm/headless'
import { spawn } from 'node-pty'
import type { IPty } from 'node-pty'
import { basename } from 'node:path'
import type { TerminalState, TerminalTabInfo } from '@shared/types'

const SCROLLBACK = 5000
const DEFAULT_SIZE = { cols: 100, rows: 30 }
/** Output quiet this long means the shell's startup files have run. */
const STARTUP_QUIET_MS = 400
const STARTUP_TIMEOUT_MS = 10_000
/** Typing this recent means the user is at the keyboard, and the agent does not type over them. */
export const USER_TYPING_MS = 2000
/** A program has redrawn once its output pauses this long after input, or after the longest wait. */
const REDRAW_QUIET_MS = 300
const REDRAW_MAX_MS = 2000
/** Around highlighted (reverse-video) text in a screen view, as menus show the selected item. */
export const HIGHLIGHT = ['⟦', '⟧'] as const

export function userShell(): string {
  return process.env.SHELL || '/bin/zsh'
}

/** The user's environment, without what Kumi Code's own process carries. */
function shellEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('ELECTRON_') && !key.startsWith('KUMI_')) env[key] = value
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
}

/** A tab's screen as the agent reads it. */
export interface ScreenView {
  /** A full-screen program shows: the alternate screen, which has no scrollback. */
  fullScreen: boolean
  rows: number
  cols: number
  /** The last lines, with highlighted text between HIGHLIGHT's marks. */
  lines: string[]
  /** Where the cursor is among the lines, from 1; null when it is above them. */
  cursor: { line: number; column: number } | null
  highlighted: boolean
}

export interface TerminalEvents {
  /** The tabs or a tab's state changed. */
  changed(): void
  output(tabId: string, data: string, seq: number): void
}

export class TerminalTab {
  readonly screen: Terminal
  private readonly serializer = new SerializeAddon()
  private readonly pty: IPty
  private readonly shellName: string
  /** Output chunks so far: the pane continues a snapshot from here. */
  private seq = 0
  private lastOutputAt = 0
  private lastInputAt = 0
  private readonly started: Promise<void>
  private outputWaiters: (() => void)[] = []
  exited = false
  /** The user typed in it, so the agent no longer stops or closes it. */
  userTyped = false
  /** When the user last typed in it. */
  userTypedAt = 0
  /** The agent is typing in it. */
  agentTyping = false

  constructor(
    readonly id: string,
    readonly title: string,
    readonly cwd: string,
    readonly openedBy: 'user' | 'agent',
    private readonly events: TerminalEvents,
  ) {
    const shell = userShell()
    this.shellName = basename(shell)
    this.screen = new xtermHeadless.Terminal({ ...DEFAULT_SIZE, scrollback: SCROLLBACK, allowProposedApi: true })
    this.screen.loadAddon(this.serializer)
    this.pty = spawn(shell, ['-l'], { name: 'xterm-256color', ...DEFAULT_SIZE, cwd, env: shellEnvironment() })
    let firstOutput: () => void = () => {}
    const first = new Promise<void>((done) => (firstOutput = done))
    this.pty.onData((data) => {
      this.screen.write(data)
      this.lastOutputAt = Date.now()
      firstOutput()
      this.events.output(this.id, data, ++this.seq)
      for (const waiter of this.outputWaiters.splice(0)) waiter()
    })
    this.pty.onExit(() => {
      this.exited = true
      this.events.changed()
    })
    this.started = this.settle(first)
  }

  info(): TerminalTabInfo {
    return { id: this.id, title: this.title, cwd: this.cwd, openedBy: this.openedBy, running: this.running(), exited: this.exited, agentTyping: this.agentTyping }
  }

  /** Whether a command runs in the shell; null when the foreground process cannot be told. */
  running(): boolean | null {
    if (this.exited) return false
    try {
      // The foreground process: the shell itself when it waits at its prompt.
      const name = this.pty.process
      return name ? basename(name).replace(/^-/, '') !== this.shellName : null
    } catch {
      return null
    }
  }

  /** Settles once the shell's startup files have run, so a typed command is not lost. */
  ready(): Promise<void> {
    return this.started
  }

  /** What the user types in the pane. */
  write(data: string): void {
    if (this.exited) return
    this.userTyped = true
    this.userTypedAt = Date.now()
    this.pty.write(data)
  }

  /** Whether the user typed in it a moment ago. */
  userIsTyping(): boolean {
    return Date.now() - this.userTypedAt < USER_TYPING_MS
  }

  /** What the agent types or presses, sent as is. */
  async send(data: string): Promise<void> {
    await this.started
    if (this.exited) throw new Error(`The shell of tab ${this.id} has exited`)
    this.lastInputAt = Date.now()
    this.pty.write(data)
  }

  /** Marks the agent typing in it, which the pane shows. */
  setAgentTyping(typing: boolean): void {
    if (this.agentTyping === typing) return
    this.agentTyping = typing
    this.events.changed()
  }

  /** Whether the program in it wants application cursor keys, as editors, pagers and menus do. */
  async applicationCursor(): Promise<boolean> {
    await this.parsed()
    return this.screen.modes.applicationCursorKeysMode
  }

  /** Types a command line and presses Enter, as the agent. */
  async type(command: string): Promise<void> {
    await this.started
    if (this.exited) throw new Error(`The shell of tab ${this.id} has exited`)
    this.pty.write(`${command}\r`)
  }

  interrupt(): void {
    if (!this.exited) this.pty.write('\x03')
  }

  resize(cols: number, rows: number): void {
    if (this.exited || cols < 2 || rows < 2) return
    this.pty.resize(cols, rows)
    this.screen.resize(cols, rows)
  }

  /** The last lines of the screen and its scrollback, without the blank ones at the end. */
  lines(count: number): string {
    const buffer = this.screen.buffer.active
    const out: string[] = []
    for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? '')
    while (out.length > 0 && !out[out.length - 1]?.trim()) out.pop()
    return out.slice(-count).join('\n')
  }

  /** The last lines as the agent reads them: highlighted text marked, and where the cursor is. */
  view(count: number): ScreenView {
    const buffer = this.screen.buffer.active
    const cursorAt = buffer.baseY + buffer.cursorY
    let end = buffer.length - 1
    while (end > cursorAt && !buffer.getLine(end)?.translateToString(true).trim()) end--
    const start = Math.max(0, end - count + 1)
    const cell = buffer.getNullCell()
    const lines: string[] = []
    for (let i = start; i <= end; i++) {
      const line = buffer.getLine(i)
      let text = ''
      let inverse = false
      for (let x = 0; line && x < line.length; x++) {
        line.getCell(x, cell)
        // The second half of a wide character.
        if (cell.getWidth() === 0) continue
        const on = cell.isInverse() !== 0
        if (on !== inverse) text += on ? HIGHLIGHT[0] : HIGHLIGHT[1]
        inverse = on
        text += cell.getChars() || ' '
      }
      if (inverse) text += HIGHLIGHT[1]
      lines.push(tidy(text))
    }
    return {
      fullScreen: buffer.type === 'alternate',
      rows: this.screen.rows,
      cols: this.screen.cols,
      lines,
      cursor: cursorAt >= start ? { line: cursorAt - start + 1, column: buffer.cursorX + 1 } : null,
      highlighted: lines.some((l) => l.includes(HIGHLIGHT[0])),
    }
  }

  /** The screen as escape sequences the pane replays, and the output chunk it ends at. */
  snapshot(): { data: string; seq: number } {
    return { data: this.serializer.serialize({ scrollback: SCROLLBACK }), seq: this.seq }
  }

  /** Settles when new output arrives and goes quiet for `quietMs`, or after `ms`. */
  async waitForOutput(ms: number, quietMs = 200): Promise<void> {
    if (ms <= 0) return
    const deadline = Date.now() + ms
    await Promise.race([new Promise<void>((done) => this.outputWaiters.push(done)), sleep(ms)])
    while (Date.now() < deadline && Date.now() - this.lastOutputAt < quietMs) await sleep(50)
    await this.parsed()
  }

  /** Settles once the output after the agent's last input pauses, as when a program has redrawn. */
  async redrawn(): Promise<void> {
    const deadline = Date.now() + REDRAW_MAX_MS
    while (Date.now() < deadline && Date.now() - Math.max(this.lastOutputAt, this.lastInputAt) < REDRAW_QUIET_MS) await sleep(50)
    await this.parsed()
  }

  /** Settles once the output so far is on the screen: the headless terminal parses it in chunks. */
  parsed(): Promise<void> {
    if (this.exited) return Promise.resolve()
    return new Promise((done) => this.screen.write('', done))
  }

  close(): void {
    if (!this.exited) this.pty.kill()
    this.exited = true
    this.screen.dispose()
  }

  private async settle(first: Promise<void>): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    await Promise.race([first, sleep(STARTUP_TIMEOUT_MS)])
    while (Date.now() < deadline && Date.now() - this.lastOutputAt < STARTUP_QUIET_MS) await sleep(50)
  }
}

/** The tabs of one conversation's Terminal panel. */
export class Terminals {
  private readonly tabs: TerminalTab[] = []
  private activeId: string | null = null
  private counter = 0

  constructor(private readonly events: TerminalEvents) {}

  state(): TerminalState {
    return { tabs: this.tabs.map((t) => t.info()), activeTabId: this.activeId }
  }

  list(): TerminalTab[] {
    return [...this.tabs]
  }

  open(cwd: string, title: string | null, openedBy: 'user' | 'agent'): TerminalTab {
    const id = String(this.counter++)
    const tab = new TerminalTab(id, title || basename(userShell()), cwd, openedBy, this.events)
    this.tabs.push(tab)
    this.activeId ??= id
    if (openedBy === 'user') this.activeId = id
    this.events.changed()
    return tab
  }

  /** The tab the pane shows. */
  active(): TerminalTab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null
  }

  /** A tab by id; without one (or "0" when tab 0 is gone), the primary tab: the first open one. */
  tab(id?: string): TerminalTab {
    const found = id ? this.tabs.find((t) => t.id === id) : undefined
    if (found) return found
    if (id && id !== '0') throw new Error(`No terminal tab ${id}; list_terminal_tabs lists them`)
    const primary = this.tabs[0]
    if (!primary) throw new Error('No terminal tab is open.')
    return primary
  }

  select(id: string): void {
    this.tab(id)
    this.activeId = id
    this.events.changed()
  }

  close(id: string): void {
    const tab = this.tab(id)
    const index = this.tabs.indexOf(tab)
    this.tabs.splice(index, 1)
    tab.close()
    if (this.activeId === id) this.activeId = this.tabs[Math.min(index, this.tabs.length - 1)]?.id ?? null
    this.events.changed()
  }

  destroy(): void {
    for (const tab of this.tabs) tab.close()
    this.tabs.length = 0
    this.activeId = null
  }
}

/** A screen line without the spaces at its end, or highlights of spaces only. */
function tidy(text: string): string {
  const [open, close] = HIGHLIGHT
  return text
    .replace(new RegExp(`${open}( *)${close}`, 'g'), '$1')
    .replace(new RegExp(` +${close} *$`), close)
    .replace(/ +$/, '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}
