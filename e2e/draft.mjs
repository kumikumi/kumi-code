// A draft reaches the main process as it is typed, so a tab torn off right after typing keeps all of it.
import { check, launch, newUserData } from './launch.mjs'

const { app, page } = await launch(newUserData())
await app.evaluate(({ screen }) => {
  screen.getCursorScreenPoint = () => ({ x: 600, y: 500 })
})
await page.getByText('No project', { exact: true }).click()
await page.waitForSelector('.composer textarea')
const tab = (await page.evaluate(() => window.kumi.getWindowState())).tabs[0]
await page.evaluate(() => window.kumi.newTab())
await page.evaluate((id) => window.kumi.activateTab(id), tab.id)
await page.locator('.composer textarea').focus()
await page.keyboard.type('my draft')
const draft = (await page.evaluate((id) => window.kumi.getConversation(id), tab.conversationId)).meta.draft
check(draft === 'my draft', 'the main process has the draft as soon as it is typed')
await page.keyboard.type(' and more')
await page.evaluate((id) => window.kumi.dragStart(id, 30, 15), tab.id)
await page.evaluate(() => window.kumi.dragMove())
await page.evaluate(() => window.kumi.dragEnd())
const page2 = await app.waitForEvent('window')
await page2.waitForSelector('.composer textarea')
check((await page2.locator('.composer textarea').inputValue()) === 'my draft and more', 'a tab torn off right after typing keeps the whole draft')
await app.close()
