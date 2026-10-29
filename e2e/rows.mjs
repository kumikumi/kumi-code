// While a reply streams, transcript rows that did not change are not recomputed,
// also when the conversation's meta updates.
// Counts calls of renderer functions with V8's precise coverage; needs the
// unminified build (`electron-vite build --mode e2e`).
import { check, deleteConversations, launch, newUserData } from './launch.mjs'

const { app, page } = await launch(newUserData())
const cdp = await page.context().newCDPSession(page)
await cdp.send('Profiler.enable')
await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
/** Calls of the named function since the last call to `calls`, which resets the counters. */
const calls = async (...names) => {
  const { result } = await cdp.send('Profiler.takePreciseCoverage')
  const functions = result.flatMap((script) => script.functions)
  return names.map((name) => functions.filter((f) => f.functionName === name).reduce((n, f) => n + (f.ranges[0]?.count ?? 0), 0))
}

await page.getByText('No project', { exact: true }).click()
await page.waitForSelector('.composer textarea')
const tab = (await page.evaluate(() => window.kumi.getWindowState())).tabs[0]
// A second tab keeps the window open when the conversation is deleted at the end.
await page.evaluate(() => window.kumi.newTab())
await page.evaluate((id) => window.kumi.activateTab(id), tab.id)
const snap = () => page.evaluate((id) => window.kumi.getConversation(id), tab.conversationId)

await page.locator('.composer textarea').fill('Run these five commands with Bash, one call each: pwd, ls, date, whoami, uname. Then write a 400-word story about a lighthouse keeper.')
await page.keyboard.press('Enter')
for (const t0 = Date.now(); Date.now() - t0 < 180000; await page.waitForTimeout(200)) {
  const { items } = await snap()
  if (items.filter((i) => i.kind === 'tool' && i.result).length >= 5 && items.some((i) => i.kind === 'text' && i.streaming && i.text.length > 200)) break
}
const [toolsArriving] = await calls('summarizeTool')
check(toolsArriving > 0, `tool rows recompute while they change (${toolsArriving} times)`)
// Meta updates during the stream too: re-setting the mode changes nothing but sends new meta.
for (let i = 0; i < 3; i++) {
  await page.evaluate((id) => window.kumi.setPermissionMode(id, 'default'), tab.conversationId)
  await page.waitForTimeout(1000)
}
const [streamed, toolsWhileStreaming] = await calls('markdownHtml', 'summarizeTool')
check(streamed >= 10, `the streaming row re-renders with each update (${streamed} times in 3 s)`)
check(toolsWhileStreaming === 0, `unchanged tool rows are not recomputed meanwhile, meta updates included (${toolsWhileStreaming} times)`)

await page.locator('.composer textarea').focus()
await page.keyboard.press('Escape')
for (const t0 = Date.now(); (await snap()).meta.status !== 'idle' && Date.now() - t0 < 30000; ) await page.waitForTimeout(300)
await deleteConversations(page)
await app.close()
