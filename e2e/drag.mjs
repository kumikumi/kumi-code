// Tab drag: reorder within a strip, tear off into a new window, drop back onto another strip.
// The main process reads the cursor from screen.getCursorScreenPoint(); the test replaces it
// with a fake cursor, so the real mouse is never touched.
import { check, launch, newUserData, shots } from './launch.mjs'

const { app, page } = await launch(newUserData())
await app.evaluate(({ screen }) => {
  globalThis.__cursor = { x: 0, y: 0 }
  screen.getCursorScreenPoint = () => globalThis.__cursor
})
const setCursor = (x, y) => app.evaluate((_e, p) => { globalThis.__cursor = p }, { x, y })
const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ id: w.id, bounds: w.getBounds(), content: w.getContentBounds(), visible: w.isVisible(), opacity: w.getOpacity() })))
const titles = async (p) => (await p.evaluate(() => window.kumi.getWindowState())).tabs.map((t) => t.id.slice(0, 4))

// Three tabs.
await page.evaluate(() => window.kumi.newTab())
await page.evaluate(() => window.kumi.newTab())
await page.waitForTimeout(500)
const initial = await titles(page)

// 1. Local reorder with pointer events: drag tab 0 to the right past tab 1.
let boxes = await page.locator('.tab:not(.placeholder)').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }))
await page.mouse.move(boxes[0].x + 30, boxes[0].y + 10)
await page.mouse.down()
for (let i = 1; i <= 10; i++) await page.mouse.move(boxes[0].x + 30 + i * (boxes[1].w * 1.2) / 10, boxes[0].y + 10)
await page.screenshot({ path: `${shots}/reorder.png` })
await page.mouse.up()
await page.waitForTimeout(300)
const reordered = await titles(page)
check(reordered[1] === initial[0], 'dragging a tab sideways reorders it')

// 2. Tear off: drag the active tab down out of the strip.
let wins = await windows()
const w1 = wins[0]
boxes = await page.locator('.tab:not(.placeholder)').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }))
const torn = (await page.evaluate(() => window.kumi.getWindowState())).tabs[2].id
await page.mouse.move(boxes[2].x + 30, boxes[2].y + 10)
await page.mouse.down()
await page.mouse.move(boxes[2].x + 32, boxes[2].y + 40)
await page.mouse.move(boxes[2].x + 34, boxes[2].y + 120) // leaves the strip: detach
const targetX = w1.content.x + 300, targetY = w1.content.y + 400
await setCursor(targetX, targetY)
await page.mouse.move(boxes[2].x + 40, boxes[2].y + 400)
await page.waitForTimeout(1500)
await page.mouse.move(boxes[2].x + 41, boxes[2].y + 401)
await page.mouse.up()
await page.waitForTimeout(800)
wins = await windows()
const pages = app.windows()
const page2 = pages.find((p) => p !== page)
check(wins.length === 2 && page2 !== undefined && (await titles(page2))[0] === torn.slice(0, 4), 'dragging a tab out tears it off into a new window')
const tornWindow = wins.find((w) => w.id !== w1.id)
check(tornWindow !== undefined && tornWindow.content.y < targetY && targetY - tornWindow.content.y < 38, 'the torn-off window has its tab strip under the cursor')
if (page2) await page2.screenshot({ path: `${shots}/torn-off.png` })

// 3. Drag the torn window's only tab back onto window 1's strip, after tab 0.
// Driven through the drag API: synthetic pointer events lose capture when the
// window under them moves, because the real mouse button is not down.
if (page2) {
  const tabId = (await page2.evaluate(() => window.kumi.getWindowState())).tabs[0].id
  const w2 = (await windows()).find((w) => w.id !== w1.id)
  await setCursor(w2.content.x + 120, w2.content.y + 15)
  await page2.evaluate((id) => window.kumi.dragStart(id, 40, 15), tabId)
  const strip1 = await page.locator('.tab').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right } }))
  await setCursor(w1.content.x + strip1[0].r + 5, w1.content.y + 20)
  await page2.evaluate(() => window.kumi.dragMove())
  await page.waitForTimeout(400)
  check((await page.locator('.tab.placeholder').count()) === 1, 'the target strip shows where the tab lands')
  await page.screenshot({ path: `${shots}/hover.png` })
  await page2.evaluate(() => window.kumi.dragEnd()).catch(() => {})
  await page.waitForTimeout(800)
  const after = await windows()
  check(after.length === 1 && (await titles(page))[1] === tabId.slice(0, 4), 'dropping on another strip moves the tab there and closes the empty window')
}
await app.close()
