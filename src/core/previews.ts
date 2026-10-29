// Dev servers the browser tools start from a project's .claude/launch.json, the
// format Claude Code's desktop app uses:
//
//   { "version": "0.0.1", "configurations": [
//     { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 5173 } ] }
//
// A configuration may also give a `url` (its origin must match `port` when it is a
// local one), a `cwd` relative to the project and `env`. One with a url and no
// command attaches to a server that is already running. A started server runs
// until it is stopped or Kumi Code quits; starting it again reuses it.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'
import { isLocalHost } from './urls'

export interface LaunchConfiguration {
  name: string
  runtimeExecutable?: string
  runtimeArgs?: string[]
  port?: number
  url?: string
  cwd?: string
  env?: Record<string, string>
}

export interface PreviewInfo {
  serverId: string
  name: string
  cwd: string
  url: string
  /** null for a server Kumi Code attached to rather than started. */
  pid: number | null
  running: boolean
  exitCode: number | null
}

interface Server {
  info: PreviewInfo
  child: ChildProcess | null
  /** Output lines, oldest first; stderr lines are marked. */
  log: { text: string; error: boolean }[]
}

const LOG_LINES = 5000
const START_TIMEOUT_MS = 90_000

/** The configurations of `<cwd>/.claude/launch.json`. */
export function readLaunchConfigurations(cwd: string): LaunchConfiguration[] {
  const path = join(cwd, '.claude', 'launch.json')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${path} does not exist. Create it with the server's configuration first.`)
    throw err
  }
  const parsed = JSON.parse(raw) as { configurations?: unknown }
  if (!Array.isArray(parsed.configurations)) throw new Error(`${path} has no "configurations" list`)
  return parsed.configurations.map((c, i) => {
    const config = c as LaunchConfiguration
    if (typeof config.name !== 'string' || !config.name) throw new Error(`Configuration ${i + 1} of ${path} has no name`)
    return config
  })
}

/** The URL a configuration serves, after checking its parts fit together. */
export function configurationUrl(config: LaunchConfiguration): string {
  if (config.url) {
    const url = new URL(config.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`"${config.name}": url must be http or https`)
    if (isLocalHost(url.hostname)) {
      if (url.pathname !== '/' || url.search || url.hash) throw new Error(`"${config.name}": a localhost url must be just the server's origin, with no path or query`)
      if (config.port !== undefined && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== config.port) {
        throw new Error(`"${config.name}": the url's port does not match "port" (${config.port})`)
      }
    }
    return url.toString()
  }
  if (config.port === undefined) throw new Error(`"${config.name}" needs a "port" or a "url"`)
  return `http://localhost:${config.port}/`
}

export class Previews {
  private readonly servers = new Map<string, Server>()
  private counter = 0

  /** Starts the named configuration of the project, or returns it if it runs already. */
  async start(cwd: string, name: string): Promise<{ info: PreviewInfo; reused: boolean }> {
    const config = readLaunchConfigurations(cwd).find((c) => c.name === name)
    if (!config) throw new Error(`No configuration "${name}" in ${join(cwd, '.claude', 'launch.json')}`)
    const url = configurationUrl(config)
    const existing = [...this.servers.values()].find((s) => s.info.cwd === cwd && s.info.name === name && s.info.running)
    if (existing) return { info: { ...existing.info }, reused: true }
    const serverId = `${name}-${++this.counter}`
    const server: Server = { info: { serverId, name, cwd, url, pid: null, running: true, exitCode: null }, child: null, log: [] }
    this.servers.set(serverId, server)
    if (!config.runtimeExecutable) return { info: { ...server.info }, reused: false }

    const child = spawn(config.runtimeExecutable, config.runtimeArgs ?? [], {
      cwd: config.cwd ? resolve(cwd, config.cwd) : cwd,
      env: { ...process.env, ...config.env },
      // Its own process group, so stopping it stops what it started too.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.child = child
    server.info.pid = child.pid ?? null
    const append = (data: Buffer, error: boolean): void => {
      for (const line of String(data).split(/\r?\n/)) if (line) server.log.push({ text: line, error })
      if (server.log.length > LOG_LINES) server.log.splice(0, server.log.length - LOG_LINES)
    }
    child.stdout?.on('data', (d: Buffer) => append(d, false))
    child.stderr?.on('data', (d: Buffer) => append(d, true))
    const exited = new Promise<void>((done) => {
      child.once('error', (err) => {
        append(Buffer.from(`Could not start ${config.runtimeExecutable}: ${err.message}`), true)
        server.info.running = false
        done()
      })
      child.once('exit', (code) => {
        server.info.running = false
        server.info.exitCode = code
        done()
      })
    })
    const port = Number(new URL(url).port || 80)
    const ready = await Promise.race([waitForPort(new URL(url).hostname, port, START_TIMEOUT_MS).then(() => true), exited.then(() => false)])
    if (!ready) {
      const tail = server.log.slice(-15).map((l) => l.text).join('\n')
      throw new Error(`"${name}" exited (code ${server.info.exitCode ?? 'none'}) before it served on port ${port}.${tail ? `\n${tail}` : ''}`)
    }
    return { info: { ...server.info }, reused: false }
  }

  list(cwd?: string): PreviewInfo[] {
    return [...this.servers.values()].filter((s) => cwd === undefined || s.info.cwd === cwd).map((s) => ({ ...s.info }))
  }

  logs(serverId: string, options: { level?: 'all' | 'error'; lines?: number; search?: string }): string {
    const server = this.get(serverId)
    const errorPattern = /error|exception|failed|fatal/i
    let lines = server.log
    if (options.level === 'error') lines = lines.filter((l) => errorPattern.test(l.text))
    if (options.search) lines = lines.filter((l) => l.text.includes(options.search ?? ''))
    const shown = lines.slice(-(options.lines ?? 50))
    const state = server.info.running ? 'running' : `exited (code ${server.info.exitCode ?? 'none'})`
    return [`${server.info.name} (${serverId}) ${state}, ${server.info.url}`, ...shown.map((l) => l.text)].join('\n')
  }

  stop(serverId: string): void {
    const server = this.get(serverId)
    this.servers.delete(serverId)
    const pid = server.child?.pid
    if (pid !== undefined && server.info.running) {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        server.child?.kill('SIGTERM')
      }
    }
  }

  stopAll(): void {
    for (const id of [...this.servers.keys()]) this.stop(id)
  }

  private get(serverId: string): Server {
    const server = this.servers.get(serverId)
    if (!server) throw new Error(`No server ${serverId}; preview_list lists them`)
    return server
  }
}

function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const target = host === 'localhost' || host.endsWith('.localhost') ? '127.0.0.1' : host.replace(/^\[|\]$/g, '')
  return new Promise((done, fail) => {
    const attempt = (): void => {
      const socket = connect({ host: target, port })
      socket.once('connect', () => {
        socket.destroy()
        done()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) fail(new Error(`Nothing served on port ${port} within ${timeoutMs / 1000} s`))
        else setTimeout(attempt, 250)
      })
    }
    attempt()
  })
}
