import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { configurationUrl, Previews, readLaunchConfigurations } from './previews'

function project(configurations: unknown[]): string {
  const cwd = mkdtempSync(join(tmpdir(), 'kumi-previews-'))
  mkdirSync(join(cwd, '.claude'))
  writeFileSync(join(cwd, '.claude', 'launch.json'), JSON.stringify({ version: '0.0.1', configurations }))
  return cwd
}

function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as { port: number }
      server.close(() => done(port))
    })
  })
}

describe('previews', () => {
  it('checks configurations', () => {
    expect(configurationUrl({ name: 'web', port: 5173 })).toBe('http://localhost:5173/')
    expect(configurationUrl({ name: 'web', url: 'https://localhost:8443', port: 8443 })).toBe('https://localhost:8443/')
    expect(() => configurationUrl({ name: 'web', url: 'http://localhost:3000/app' })).toThrow('just the server\'s origin')
    expect(() => configurationUrl({ name: 'web', url: 'http://localhost:3000', port: 4000 })).toThrow('does not match')
    expect(() => configurationUrl({ name: 'web' })).toThrow('needs a "port"')
    expect(() => readLaunchConfigurations(mkdtempSync(join(tmpdir(), 'kumi-previews-')))).toThrow('does not exist')
  })

  it('starts a server, reuses it, keeps its output and stops it', async () => {
    const port = await freePort()
    const cwd = project([
      { name: 'web', runtimeExecutable: process.execPath, runtimeArgs: ['server.mjs'], port, env: { PORT: String(port) } },
      { name: 'broken', runtimeExecutable: process.execPath, runtimeArgs: ['-e', 'console.error("no luck"); process.exit(3)'], port: port + 1 },
    ])
    writeFileSync(join(cwd, 'server.mjs'), `import http from 'node:http'; http.createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), () => console.log('ready on', process.env.PORT)); console.error('a warning: failed to load optional thing')`)
    const previews = new Previews()
    try {
      const first = await previews.start(cwd, 'web')
      expect(first).toMatchObject({ reused: false, info: { name: 'web', url: `http://localhost:${port}/`, running: true } })
      expect((await previews.start(cwd, 'web')).reused).toBe(true)
      expect(previews.list(cwd).map((p) => p.serverId)).toEqual([first.info.serverId])
      await new Promise((d) => setTimeout(d, 100))
      expect(previews.logs(first.info.serverId, {})).toContain(`ready on ${port}`)
      expect(previews.logs(first.info.serverId, { level: 'error' })).not.toContain('ready on')
      await expect(previews.start(cwd, 'broken')).rejects.toThrow(/exited \(code 3\)[\s\S]*no luck/)
      await expect(previews.start(cwd, 'missing')).rejects.toThrow('No configuration "missing"')
    } finally {
      previews.stopAll()
    }
    expect(previews.list(cwd)).toEqual([])
  })

  // Like mvn spring-boot:run: the server forks the process that serves, which takes a while to shut down.
  // Each process says when its SIGTERM handler is in place; the server then writes their pids.
  const forking = (stubborn: boolean): string => `
    import { spawn } from 'node:child_process'
    import { writeFileSync } from 'node:fs'
    // Maven waits for the JVM it forked.
    process.on('SIGTERM', () => app.on('exit', () => process.exit(0)))
    const ready = (child) => new Promise((done) => child.stdout.once('data', done))
    const app = spawn(process.execPath, ['-e', \`
      process.on('SIGTERM', () => setTimeout(() => process.exit(0), 700))
      require('node:http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), () => console.log('ready'))
    \`], { stdio: ['ignore', 'pipe', 'inherit'] })
    const children = [app]
    if (${stubborn}) {
      // Leaves the process group, and ignores SIGTERM.
      children.push(spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }))
    }
    await Promise.all(children.map(ready))
    writeFileSync('pids.json', JSON.stringify([process.pid, ...children.map((c) => c.pid)]))`

  const running = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('stops everything a server started, waiting for it, and kills what will not stop', async () => {
    for (const stubborn of [false, true]) {
      const port = await freePort()
      const cwd = project([{ name: 'app', runtimeExecutable: process.execPath, runtimeArgs: ['server.mjs'], port, env: { PORT: String(port) } }])
      writeFileSync(join(cwd, 'server.mjs'), forking(stubborn))
      const previews = new Previews(1500)
      const { info } = await previews.start(cwd, 'app')
      await vi.waitFor(() => readFileSync(join(cwd, 'pids.json')), { timeout: 5000 })
      const pids = JSON.parse(readFileSync(join(cwd, 'pids.json'), 'utf8')) as number[]
      expect(pids.every(running)).toBe(true)
      const report = await previews.stop(info.serverId)
      expect(pids.some(running), report).toBe(false)
      expect(report).toContain(`Port ${port} is free`)
      if (stubborn) expect(report).toMatch(/1 process was still running 1\.5 s after SIGTERM and was killed/)
      else expect(report).toMatch(/its 2 processes exited \d+\.\d s after SIGTERM/)
    }
  }, 20_000)

  it('will not start a server on a port something else answers on', async () => {
    const other = createServer().listen(0)
    await new Promise((d) => other.once('listening', d))
    const { port } = other.address() as { port: number }
    const cwd = project([{ name: 'app', runtimeExecutable: process.execPath, runtimeArgs: ['-e', 'setInterval(() => {}, 1000)'], port }])
    await expect(new Previews().start(cwd, 'app')).rejects.toThrow(`Something already answers on port ${port}`)
    other.close()
  })
})
