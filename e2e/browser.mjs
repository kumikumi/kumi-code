// The browser: tools driven without a model (the e2e build exposes the workspace), the pane's
// frames and the user's input, downloads, the viewport apart from the pane's size, tools while
// the tab is hidden, and an agent using the tools, which asks before opening a site that is not local.
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, deleteConversations, launch, newUserData, shots, startConversation, waitForReply, waitUntil } from './launch.mjs'

let clicks = 0
let slow = null
const page = `<!doctype html><html><head><title>Browser test</title><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;font:16px sans-serif">
<button id="add" style="position:absolute;left:40px;top:40px;width:160px;height:48px" onclick="fetch('/clicked',{method:'POST'})">Add one</button>
<input id="name" aria-label="Name" style="position:absolute;left:40px;top:120px;width:200px;height:28px">
<a id="notes" href="/notes.txt" style="position:absolute;left:40px;top:200px">Notes</a>
</body></html>`
const server = http.createServer((req, res) => {
  if (req.url === '/clicked') {
    clicks++
    res.end('ok')
    return
  }
  if (req.url === '/notes.txt') {
    res.setHeader('content-type', 'text/plain')
    res.setHeader('content-disposition', 'attachment; filename="notes.txt"')
    res.end('the notes')
    return
  }
  if (req.url === '/slow.bin') {
    // Sends a little and then nothing, so the download stays in progress.
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '1000000', 'content-disposition': 'attachment; filename="slow.bin"' })
    res.write(Buffer.alloc(1000))
    slow = res
    return
  }
  res.setHeader('content-type', 'text/html')
  res.end(page)
})
await new Promise((done) => server.listen(0, done))
const base = `http://localhost:${server.address().port}`

const userData = newUserData()
const { app, page: win } = await launch(userData)
const id = await startConversation(win)
const tool = (name, input = {}) => app.evaluate((_electron, [id, name, input]) => globalThis.kumiWorkspace.browserTool(id, name, input), [id, name, input])
const textOf = (result) => result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
const js = async (code) => JSON.parse(textOf(await tool('javascript_tool', { action: 'javascript_exec', text: code })))
const pane = win.locator('.tab-pane:not([hidden]) .browser-pane')
const dock = win.locator('.tab-pane:not([hidden]) .dock')
const canvas = pane.locator('canvas')

// The agent's first tab opens the pane, which draws the page.
check(textOf(await tool('navigate', { url: base })).includes('Browser test'), 'navigate opens the page')
await pane.waitFor()
check((await pane.locator('.browser-url').inputValue()) === `${base}/`, 'the pane opens by itself and shows the URL')
await waitUntil(win, 'a frame is drawn', async () => (await canvas.evaluate((c) => c.width)) === 1280)
const painted = await canvas.evaluate((c) => {
  const pixel = c.getContext('2d').getImageData(120, 64, 1, 1).data
  return pixel[0] < 250 || pixel[1] < 250 || pixel[2] < 250
})
check(painted, 'the frame shows the page (the button is drawn)')

// The pane's size is not the page's.
const before = await js('innerWidth')
const edge = await dock.locator('.dock-resize').boundingBox()
await win.mouse.move(edge.x + 3, edge.y + 300)
await win.mouse.down()
await win.mouse.move(edge.x + 3 + 150, edge.y + 300, { steps: 5 })
await win.mouse.up()
const shown = await canvas.evaluate((c) => Math.round(c.getBoundingClientRect().width))
check(before === 1280 && (await js('innerWidth')) === 1280 && shown < 1280, `resizing the pane leaves the page at 1280 px (drawn ${shown} px wide)`)

// The user's mouse and keyboard reach the page.
const toScreen = async (x, y) => {
  const r = await canvas.boundingBox()
  return [r.x + (x * r.width) / 1280, r.y + (y * r.height) / 800]
}
await win.mouse.click(...(await toScreen(120, 64)))
await waitUntil(win, 'the click reaches the page', async () => clicks === 1)
check(true, 'a click in the pane clicks the page')
await win.mouse.click(...(await toScreen(140, 134)))
await win.keyboard.type('hi there')
await win.keyboard.press('Backspace')
await waitUntil(win, 'typing reaches the page', async () => (await js('document.getElementById("name").value')) === 'hi ther')
check(true, 'typing in the pane types in the page')

// The pane passes on what the user's layout types, with Option too: on a Finnish Mac, Option+2
// types "@" and Shift+7 "/". A key the page leaves unhandled, such as Cmd pressed alone, reaches
// no app menu item, where it matched the first one without a shortcut (About).
const name = () => js('document.getElementById("name").value')
const tabId = (await win.evaluate((id) => window.kumi.getBrowser(id), id)).activeTabId
const press = (key, code, keyCode, modifiers) =>
  win.evaluate(
    ([id, tabId, input]) => {
      window.kumi.browserInput(id, tabId, { ...input, action: 'down' })
      window.kumi.browserInput(id, tabId, { ...input, action: 'up' })
    },
    [id, tabId, { type: 'key', key, code, keyCode, modifiers }],
  )
await press('@', 'Digit2', 50, 1)
await press('/', 'Digit7', 55, 8)
await waitUntil(win, 'the typed characters reach the page', async () => (await name()) === 'hi ther@/')
check(true, 'Option and Shift type what the layout types')
await app.evaluate(({ Menu }) => {
  globalThis.appMenu = Menu.getApplicationMenu()
  globalThis.menuClicks = 0
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'App', submenu: [{ label: 'First', click: () => globalThis.menuClicks++ }] }]))
})
await app.evaluate(({ clipboard }) => clipboard.writeText('x@y'))
await press('Meta', 'MetaLeft', 91, 4)
await press('v', 'KeyV', 86, 4)
await waitUntil(win, 'Cmd+V pastes', async () => (await name()) === 'hi ther@/x@y')
await win.waitForTimeout(300)
check((await app.evaluate(() => globalThis.menuClicks)) === 0, 'Cmd and Cmd+V in the page click no app menu item')
await app.evaluate(({ Menu }) => Menu.setApplicationMenu(globalThis.appMenu))

// A right click shows a browser's menu for what is under the pointer; the agent's shows none.
await app.evaluate(({ Menu }) => {
  globalThis.popups = []
  globalThis.popup = Menu.prototype.popup
  Menu.prototype.popup = function () {
    globalThis.popups.push(this)
  }
})
const popups = () => app.evaluate(() => globalThis.popups.map((menu) => menu.items.map((item) => item.label).filter(Boolean)))
await win.mouse.click(...(await toScreen(140, 134)), { button: 'right' })
await waitUntil(win, 'the right click asks for a menu', async () => (await popups()).length === 1)
const items = (await popups())[0]
check(['Cut', 'Copy', 'Paste', 'Select All', 'Inspect'].every((l) => items.includes(l)), `a right click on a text field shows its editing menu (${items.join(', ')})`)
await app.evaluate(({ clipboard }) => {
  clipboard.writeText('!')
  globalThis.popups[0].items.find((item) => item.label === 'Paste').click()
})
await waitUntil(win, 'Paste in the menu pastes', async () => (await name()) === 'hi ther@/x@y!')
check(true, "the menu's Paste pastes in the page")
await tool('computer', { action: 'right_click', coordinate: [140, 134] })
await win.waitForTimeout(500)
check((await popups()).length === 1, "the agent's right click shows no menu")
await app.evaluate(({ Menu }) => {
  Menu.prototype.popup = globalThis.popup
})

// A download is saved in the Downloads folder (the test's own) under a name not yet taken there,
// shows in the pane, and tabs_context lists it for the agent.
const downloads = async () => (await win.evaluate((id) => window.kumi.getBrowser(id), id)).downloads
const downloadsDir = join(userData, 'Downloads')
await win.mouse.click(...(await toScreen(55, 210)))
await waitUntil(win, 'the clicked download completes', async () => (await downloads())[0]?.state === 'completed')
const [notes] = await downloads()
check(notes.path === join(downloadsDir, 'notes.txt') && readFileSync(notes.path, 'utf8') === 'the notes', `a clicked download is saved in the Downloads folder (${notes.path})`)
const quarantined = () => {
  try {
    return execFileSync('xattr', ['-p', 'com.apple.quarantine', notes.path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).includes('Kumi Code')
  } catch {
    return false
  }
}
await waitUntil(win, 'the download is quarantined', async () => quarantined())
check(true, 'the download is quarantined for Gatekeeper')
const row = (name) => pane.locator('.browser-download', { has: win.locator('.browser-download-name', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}$`) }) })
check(await row('notes.txt').getByRole('button', { name: 'Show in Finder' }).isVisible(), 'the pane lists the finished download')
await win.mouse.click(...(await toScreen(55, 210)))
await waitUntil(win, 'the second download completes', async () => (await downloads())[1]?.state === 'completed')
check((await downloads())[1].path === join(downloadsDir, 'notes (1).txt'), 'a second download of the same file gets a name of its own')
check(textOf(await tool('tabs_context')).includes(JSON.stringify(join(downloadsDir, 'notes (1).txt'))), 'tabs_context lists the downloads with their paths')
await row('notes (1).txt').getByRole('button', { name: 'Remove from the list' }).click()
await waitUntil(win, 'the download leaves the list', async () => (await downloads()).length === 1)
check(true, 'a finished download can be taken off the list')
await tool('navigate', { url: `${base}/slow.bin` })
await waitUntil(win, 'the slow download shows', async () => (await downloads())[1]?.state === 'progressing')
await row('slow.bin').getByRole('button', { name: 'Cancel' }).click()
await waitUntil(win, 'the slow download is cancelled', async () => (await downloads())[1]?.state === 'cancelled')
check(await row('slow.bin').getByText('Cancelled').isVisible(), "the agent's download can be cancelled in the pane")
slow?.destroy()

// The viewport is set apart from the pane, by the user or the agent.
await pane.locator('.browser-viewport select').first().selectOption('Mobile')
await waitUntil(win, 'the viewport changes', async () => (await js('innerWidth')) === 375)
check(await js('navigator.userAgent.includes("Android")'), 'the Mobile preset emulates a phone')
await waitUntil(win, 'the frame follows the viewport', async () => (await canvas.evaluate((c) => c.width)) === 375)
check(true, 'the pane draws the 375 px page')
check(textOf(await tool('resize_window', { preset: 'desktop' })).includes('1280x800'), 'resize_window sets the viewport back')
await waitUntil(win, 'the pane shows the desktop size', async () => (await pane.locator('.viewport-size').first().inputValue()) === '1280')
await waitUntil(win, 'the pane draws the desktop frame', async () => (await canvas.evaluate((c) => c.width)) === 1280)
check(true, "the pane's viewport fields and frame follow the agent's change")
await win.screenshot({ path: `${shots}/browser-pane.png` })

// The tools work the same while the conversation's tab is hidden.
await win.evaluate(() => window.kumi.newTab())
await win.waitForSelector('.tab-pane:not([hidden]) .newtab')
const ref = /\[(ref_\d+)\]/.exec(textOf(await tool('find', { query: 'Add one' })))?.[1]
await tool('computer', { action: 'left_click', ref })
await waitUntil(win, 'the hidden click reaches the page', async () => clicks === 2)
const shot = await tool('computer', { action: 'screenshot' })
check(shot.content.some((c) => c.type === 'image') && textOf(shot).includes('1280x800'), 'tools click and screenshot while the tab is hidden')
const state = await win.evaluate(() => window.kumi.getWindowState())
await win.evaluate((tabId) => window.kumi.activateTab(tabId), state.tabs.find((t) => t.conversationId).id)
await pane.waitFor()

// An agent uses the tools on a local page without asking, and asks before another site.
await win.locator('.tab-pane:not([hidden]) .composer textarea').fill(
  `Use the mcp__browser__find tool to find the "Add one" button on the open page, click it with mcp__browser__computer (action left_click with its ref), then reply with just the word DONE.`,
)
await win.keyboard.press('Enter')
await waitForReply(win, 1)
check(clicks === 3, `the agent clicks through the browser tools (${clicks} clicks)`)
const labels = await win.locator('.tab-pane:not([hidden]) .item.tool .tool-label').allInnerTexts()
check(labels.filter((l) => l === 'Browser').length >= 2, `the transcript shows the browser tool calls (${labels.join(', ')})`)
await win.locator('.tab-pane:not([hidden]) .composer textarea').fill('Use the mcp__browser__navigate tool to open https://example.com, then reply with just the word DONE.')
await win.keyboard.press('Enter')
await win.waitForSelector('.tab-pane:not([hidden]) .request.permission', { timeout: 120000 })
check(true, 'opening a site that is not local asks the user')
await win.locator('.tab-pane:not([hidden]) .request button', { hasText: 'Deny' }).click()
await waitUntil(win, 'the turn ends', async () => (await win.evaluate((id) => window.kumi.getConversation(id), id)).meta.status === 'idle')

console.log(`screenshots: ${shots}`)
await win.evaluate(() => window.kumi.newTab())
await deleteConversations(win)
server.close()
await app.close()
