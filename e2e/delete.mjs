// Deleting a conversation while Claude Code is still replying removes it for good:
// the process must not write the transcript back while it shuts down.
import { check, launch, newUserData, startConversation, transcriptFile, waitUntil } from './launch.mjs'

const { app, page } = await launch(newUserData())
const id = await startConversation(page)
await page.locator('.composer textarea').fill('Write a 1000-word story about a lighthouse keeper.')
await page.keyboard.press('Enter')
const streamed = async () => (await page.evaluate((id) => window.kumi.getConversation(id), id)).items.some((i) => i.kind === 'text' && i.text.length > 100)
await waitUntil(page, 'the story streams', streamed)
check((await page.evaluate((id) => window.kumi.getConversation(id), id)).meta.status === 'running', 'the reply is still streaming')
// A second tab keeps the window open when the conversation's tab closes.
await page.evaluate(() => window.kumi.newTab())
await page.evaluate((id) => window.kumi.deleteConversation(id), id)
await page.waitForTimeout(4000)
// Kumi Code's own list hides sessions without messages, so look for the file itself.
check(transcriptFile(id) === null, 'no transcript file comes back after the delete')
check((await page.evaluate(() => window.kumi.getWindowState())).tabs.every((t) => t.conversationId !== id), "the conversation's tab closed")
await app.close()
