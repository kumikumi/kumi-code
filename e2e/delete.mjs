// Deleting a conversation while Claude Code is still replying removes it for good:
// the process must not write the transcript back while it shuts down.
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { check, launch, newUserData } from './launch.mjs'

const { app, page } = await launch(newUserData())
await page.getByText('No project', { exact: true }).click()
await page.waitForSelector('.composer textarea')
const id = (await page.evaluate(() => window.kumi.getWindowState())).tabs[0].conversationId
await page.locator('.composer textarea').fill('Write a 400-word story about a lighthouse keeper.')
await page.keyboard.press('Enter')
const streaming = async () => (await page.evaluate((id) => window.kumi.getConversation(id), id)).items.some((i) => i.kind === 'text' && i.text.length > 100)
for (const t0 = Date.now(); !(await streaming()) && Date.now() - t0 < 120000; ) await page.waitForTimeout(200)
check((await page.evaluate((id) => window.kumi.getConversation(id), id)).meta.status === 'running', 'the reply is still streaming')
// A second tab keeps the window open when the conversation's tab closes.
await page.evaluate(() => window.kumi.newTab())
await page.evaluate((id) => window.kumi.deleteConversation(id), id)
await page.waitForTimeout(4000)
// Kumi Code's own list hides sessions without messages, so look for the file itself.
const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
const left = readdirSync(projects).filter((dir) => existsSync(join(projects, dir, `${id}.jsonl`)))
check(left.length === 0, 'no transcript file comes back after the delete')
check((await page.evaluate(() => window.kumi.getWindowState())).tabs.every((t) => t.conversationId !== id), "the conversation's tab closed")
await app.close()
