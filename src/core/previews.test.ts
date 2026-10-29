import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
})
