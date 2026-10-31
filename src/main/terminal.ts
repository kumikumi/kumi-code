// The Terminal panel of a conversation: tabs that each run the user's login shell
// in a pseudo-terminal. The user types in them in the terminal pane; the agent
// runs commands in them and reads them with the terminal tools. Each tab keeps its
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
  private readonly started: Promise<void>
  private outputWaiters: (() => void)[] = []
  exited = false
  /** The user typed in it, so the agent no longer stops or closes it. */
  userTyped = false

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
    return { id: this.id, title: this.title, cwd: this.cwd, openedBy: this.openedBy, running: this.running(), exited: this.exited }
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
    this.pty.write(data)
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

  /** The screen as escape sequences the pane replays, and the output chunk it ends at. */
  snapshot(): { data: string; seq: number } {
    return { data: this.serializer.serialize({ scrollback: SCROLLBACK }), seq: this.seq }
  }

  /** Settles when new output arrives and goes quiet, or after `ms`. */
  async waitForOutput(ms: number): Promise<void> {
    if (ms <= 0) return
    const deadline = Date.now() + ms
    await Promise.race([new Promise<void>((done) => this.outputWaiters.push(done)), sleep(ms)])
    while (Date.now() < deadline && Date.now() - this.lastOutputAt < 200) await sleep(50)
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

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}
