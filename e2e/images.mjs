// Images in the transcript, sent ones and a tool's, as Claude has them: a click shows one at full
// size, a right click offers to copy it, save it and show the file it was read from.
import { writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { check, deleteConversations, launch, newUserData, shots, startConversation, transcriptFile, waitForReply, waitUntil } from './launch.mjs'

const userData = newUserData()
let { app, page } = await launch(userData)
const id = await startConversation(page)
const { cwd } = (await page.evaluate((id) => window.kumi.getConversation(id), id)).meta

/** A base64 image of `width`×`height` with lines of text, in `type`. */
const drawn = (width, height, type) =>
  page.evaluate(
    ([width, height, type]) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const g = canvas.getContext('2d')
      g.fillStyle = '#2b6cb0'
      g.fillRect(0, 0, width, height)
      g.fillStyle = '#fff'
      g.font = '28px sans-serif'
      for (let y = 40; y < height; y += 40) g.fillText(`Line ${y / 40}: text a thumbnail cannot show`, 20, y)
      return canvas.toDataURL(type).replace(/^data:[^;]+;base64,/, '')
    },
    [width, height, type],
  )

// Claude Code scales the sent image down to 2000×1333 and keeps it WebP, which the main process
// cannot read, so copying it goes through PNG.
const sent = await drawn(2400, 1600, 'image/webp')
const file = join(cwd, 'chart.png')
writeFileSync(file, Buffer.from(await drawn(800, 500, 'image/png'), 'base64'))
await page.evaluate(
  ([id, file, data]) => window.kumi.send(id, `Use the Read tool to look at ${file}, then reply with just OK.`, [{ mediaType: 'image/webp', data }]),
  [id, file, sent],
)
const snap = await waitForReply(page, 1)
const read = snap.items.find((i) => i.kind === 'tool' && i.name === 'Read')
check(read?.result?.images.length === 1, `the Read result keeps its image (${read?.result?.images.length})`)
const stored = (await readFile(transcriptFile(id), 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .flatMap((r) => (r.type === 'user' && Array.isArray(r.message?.content) ? r.message.content.filter((b) => b.type === 'image') : []))
const shown = snap.items.find((i) => i.kind === 'user').images
check(stored.length === 1 && shown.length === 1 && shown[0].data === stored[0].source.data, "the sent image is Claude Code's copy, not the one sent")

/** Opens the viewer from `thumb`; returns the shown image's natural and rendered size, then closes it with Escape. */
async function view(thumb) {
  await thumb.click()
  const img = page.locator('dialog.image-viewer[open] img')
  await img.waitFor()
  const size = await img.evaluate((img) => ({ natural: [img.naturalWidth, img.naturalHeight], fits: img.clientWidth <= innerWidth && img.clientHeight <= innerHeight }))
  size.caption = await page.locator('dialog.image-viewer[open] .image-size').innerText()
  await page.screenshot({ path: `${shots}/image-viewer.png` })
  await page.keyboard.press('Escape')
  await waitUntil(page, 'Escape closes the viewer', async () => (await page.locator('dialog.image-viewer').count()) === 0)
  return size
}

const sentThumb = page.locator('.item.user .image-thumb')
const sentView = await view(sentThumb)
check(sentView.natural.join('×') === '2000×1333' && sentView.fits, `a sent image opens at the ${sentView.natural.join('×')} Claude has and fits the window`)
check(sentView.caption === '2000 × 1333 WEBP', `the viewer says its size and format (${sentView.caption})`)
await page.locator('.item.tool .tool-head', { hasText: 'Read' }).click()
const toolThumb = page.locator('.item.tool .image-thumb')
await toolThumb.waitFor()
await page.screenshot({ path: `${shots}/image-thumbnails.png` })
const toolView = await view(toolThumb)
check(toolView.natural[0] > 0, `a Read result's image opens in the viewer (${toolView.natural.join('×')})`)

// Menus are recorded instead of shown; the user's clipboard is put back afterwards.
await app.evaluate(async ({ clipboard, ClipboardItem, dialog, Menu, shell }, userData) => {
  globalThis.popups = []
  Menu.prototype.popup = function () {
    globalThis.popups.push(this)
  }
  globalThis.saveOptions = null
  dialog.showSaveDialog = async (_win, options) => {
    globalThis.saveOptions = options
    return { canceled: false, filePath: `${userData}/saved` }
  }
  globalThis.shown = null
  shell.showItemInFolder = (path) => (globalThis.shown = path)
  const items = await clipboard.read()
  globalThis.savedClipboard = await Promise.all(items.map(async (item) => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async (t) => [t, await item.getType(t)]))))))
}, userData)
const labels = () => app.evaluate(() => globalThis.popups.at(-1)?.items.map((item) => item.label).filter(Boolean))
const click = (label) => app.evaluate((_electron, label) => globalThis.popups.at(-1).items.find((item) => item.label === label).click(), label)
const clipboardSize = () =>
  app.evaluate(async ({ clipboard, nativeImage }) => {
    const item = (await clipboard.read()).find((i) => i.types.includes('image/png'))
    return item ? nativeImage.createFromBuffer(Buffer.from(await (await item.getType('image/png')).arrayBuffer())).getSize() : null
  })

await sentThumb.click({ button: 'right' })
await waitUntil(page, 'a right click on a sent image asks for a menu', async () => (await app.evaluate(() => globalThis.popups.length)) === 1)
check(JSON.stringify(await labels()) === JSON.stringify(['Copy Image', 'Save Image As…']), `a sent image's menu offers Copy and Save (${await labels()})`)
await click('Copy Image')
await waitUntil(page, 'the copy reaches the clipboard', async () => (await clipboardSize())?.width === 2000)
check(true, 'Copy Image puts the WebP image on the clipboard as a 2000×1333 PNG')

await toolThumb.click({ button: 'right' })
await waitUntil(page, 'a right click on a Read image asks for a menu', async () => (await app.evaluate(() => globalThis.popups.length)) === 2)
check(JSON.stringify(await labels()) === JSON.stringify(['Copy Image', 'Save Image As…', 'Show in Finder']), `a Read image's menu also offers Show in Finder (${await labels()})`)
await click('Show in Finder')
check((await app.evaluate(() => globalThis.shown)) === file, 'Show in Finder shows the file that was read')
await click('Save Image As…')
await waitUntil(page, 'the image is saved', async () => (await readFile(join(userData, 'saved')).catch(() => null)) !== null)
const saved = await readFile(join(userData, 'saved'), 'base64')
check(saved === read.result.images[0].data, 'Save Image As… writes the image as the transcript has it')
const defaultPath = await app.evaluate(() => globalThis.saveOptions.defaultPath)
check(/\/chart\.(png|jpg)$/.test(defaultPath), `the save dialog suggests the file's name (${defaultPath})`)

await page.locator('.item.user .image-thumb').click()
await page.locator('dialog.image-viewer[open] img').click({ button: 'right' })
await waitUntil(page, 'a right click in the viewer asks for a menu', async () => (await app.evaluate(() => globalThis.popups.length)) === 3)
check(true, 'the viewer has the menu too')
await page.keyboard.press('Escape')
await app.evaluate(async ({ clipboard }) => {
  if (globalThis.savedClipboard.length > 0) await clipboard.write(globalThis.savedClipboard)
})
await app.close()

// After a restart the images come from Claude Code's transcript.
;({ app, page } = await launch(userData))
await page.waitForSelector('.item.user .image-thumb', { timeout: 30000 })
const restored = await view(page.locator('.item.user .image-thumb'))
check(restored.natural.join('×') === '2000×1333', `a restored conversation's sent image is the same (${restored.natural.join('×')})`)
await page.locator('.item.tool .tool-head', { hasText: 'Read' }).click()
check((await page.locator('.item.tool .image-thumb').count()) === 1, "a restored conversation's Read result shows its image")
console.log(`screenshots: ${shots}`)
// A conversation's last tab closes with it, and the app with its last window.
await page.evaluate(() => window.kumi.newTab())
await deleteConversations(page)
await app.close()
