// Closing the last window quits the app, though a browser keeps hidden windows of its own, and
// stops the dev servers the app started.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { check, launch, newUserData, startConversation } from './launch.mjs'

const running = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const port = await new Promise((done) => {
  const server = createServer().listen(0, () => {
    const { port } = server.address()
    server.close(() => done(port))
  })
})

const { app, page } = await launch(newUserData())
const id = await startConversation(page)
const cwd = (await page.evaluate((id) => window.kumi.getConversation(id), id)).meta.cwd
mkdirSync(join(cwd, '.claude'), { recursive: true })
writeFileSync(join(cwd, 'server.mjs'), `import http from 'node:http'; import fs from 'node:fs'; fs.writeFileSync('pid.txt', String(process.pid)); http.createServer((q, s) => s.end('ok')).listen(${port})`)
writeFileSync(join(cwd, '.claude', 'launch.json'), JSON.stringify({ configurations: [{ name: 'app', runtimeExecutable: process.execPath, runtimeArgs: ['server.mjs'], port }] }))
await app.evaluate((_e, id) => globalThis.kumiWorkspace.browserTool(id, 'preview_start', { name: 'app' }), id)
const server = Number(readFileSync(join(cwd, 'pid.txt'), 'utf8'))
const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
check(windows === 2 && running(server), `a dev server runs, and its browser tab is a second, hidden window (${windows} windows)`)
const exited = new Promise((done) => app.process().once('exit', () => done(true)))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())?.close())
const quit = await Promise.race([exited, new Promise((done) => setTimeout(() => done(false), 15000))])
check(quit, 'closing the last visible window quits the app')
if (!quit) await app.close()
await new Promise((done) => setTimeout(done, 1000))
check(!running(server), 'the dev server stops with the app')
if (running(server)) process.kill(server, 'SIGKILL')
