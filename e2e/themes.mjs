// Color themes: a conversation's theme colors its view, its tab and, while its tab
// is active, the window. A new conversation gets a random theme, never the one of
// the conversation started before it. Pointing at a theme in the menu previews it;
// a pick lasts across restarts. Sends no messages.
import { check, deleteConversations, launch, newUserData } from './launch.mjs'

const THEMES = ['kumi', 'anuja', 'pine', 'moss', 'ember', 'rose', 'plum', 'graphite']
const userData = newUserData()
let { app, page } = await launch(userData)
const pane = () => page.locator('.tab-pane:not([hidden])')
const conversationTheme = () => pane().locator('.conversation').getAttribute('data-theme')
const windowTheme = () => page.locator('.window').getAttribute('data-theme')
const tabThemes = () => page.locator('.tab').evaluateAll((tabs) => tabs.map((t) => t.getAttribute('data-theme')).join())

async function start() {
  await pane().getByText('No project', { exact: true }).click()
  await pane().locator('.conversation-header').waitFor()
}

await start()
const first = await conversationTheme()
check(THEMES.includes(first), `a new conversation has a theme (${first})`)
check((await windowTheme()) === first, 'the window has the active conversation\'s theme')

const palette = pane().getByRole('button', { name: 'Color theme' })
await palette.click()
const menu = page.locator('.theme-menu:popover-open')
await menu.waitFor()
const box = await menu.boundingBox()
const button = await palette.boundingBox()
check(box !== null && button !== null && box.y >= button.y + button.height && box.x + box.width <= button.x + button.width + 1, 'the menu opens under the palette button')
check((await menu.locator('.theme-option').count()) === THEMES.length, 'the menu offers eight themes')
const [preview, pick] = THEMES.filter((t) => t !== first && t !== 'kumi')
const option = (id) => menu.getByText(id[0].toUpperCase() + id.slice(1), { exact: true })
await option(preview).hover()
check((await conversationTheme()) === preview, 'pointing at a theme previews it')
check((await windowTheme()) === first, 'a preview changes nothing else')
await option(pick).click()
await page.waitForFunction((pick) => document.querySelector('.tab.active')?.getAttribute('data-theme') === pick, pick)
check(!(await menu.isVisible()), 'picking a theme closes the menu')
check((await conversationTheme()) === pick, 'the conversation takes the picked theme')
check((await windowTheme()) === pick, 'so does the window')

await page.evaluate(() => window.kumi.newTab())
await page.waitForFunction(() => document.querySelector('.window')?.getAttribute('data-theme') === 'kumi')
check(true, 'a new tab page has the default theme')
let previous = pick
for (let i = 0; i < 3; i++) {
  if (i > 0) await page.evaluate(() => window.kumi.newTab())
  await start()
  const theme = await conversationTheme()
  check(THEMES.includes(theme) && theme !== previous, `the next new conversation gets another theme than the one before it (${previous} → ${theme})`)
  previous = theme
}
check((await page.locator('.tab').first().getAttribute('data-theme')) === pick, 'the first tab keeps its theme')

const before = await tabThemes()
await app.close()
;({ app, page } = await launch(userData))
await page.waitForFunction((before) => [...document.querySelectorAll('.tab')].map((t) => t.getAttribute('data-theme')).join() === before, before, { timeout: 10000 }).then(
  () => check(true, 'themes last across a restart'),
  async () => check(false, `themes last across a restart (${before} → ${await tabThemes()})`),
)

await deleteConversations(page)
await app.close()
