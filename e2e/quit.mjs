// Closing the last window quits the app, though a browser keeps hidden windows of its own.
import { check, launch, newUserData, startConversation } from './launch.mjs'
const { app, page } = await launch(newUserData())
const id = await startConversation(page)
await app.evaluate((_e, id) => globalThis.kumiWorkspace.browserTool(id, 'navigate', { url: 'about:blank' }), id)
const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
check(windows === 2, `a browser tab is a second, hidden window (${windows} windows)`)
const exited = new Promise((done) => app.process().once('exit', () => done(true)))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())?.close())
const quit = await Promise.race([exited, new Promise((done) => setTimeout(() => done(false), 15000))])
check(quit, 'closing the last visible window quits the app')
if (!quit) await app.close()
