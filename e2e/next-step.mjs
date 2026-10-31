// The next-step box: the agent calls wrap_up by itself after a turn that changed a file; a
// wrap_up with a question and buttons draws the box and marks the tab as waiting, and a click
// answers as the user. The commit action draws a Commit button while there is something to commit.
import { execFileSync } from 'node:child_process'
import { check, deleteConversations, launch, newUserData, shots, startConversation, waitForReply, waitUntil } from './launch.mjs'

const { app, page } = await launch(newUserData())
const id = await startConversation(page)
const tabStatus = async () => (await page.evaluate(() => window.kumi.getWindowState())).tabs.find((t) => t.conversationId === id)?.status
const box = page.locator('.tab-pane:not([hidden]) .next-step')

// Unprompted: a turn that changes a file ends with wrap_up.
await page.evaluate((id) => window.kumi.setPermissionMode(id, 'acceptEdits'), id)
await page.locator('.composer textarea').fill('Use the Write tool to create notes.txt containing the word hello. Then tell me briefly what you did.')
await page.keyboard.press('Enter')
await waitForReply(page, 1)
const items = (await page.evaluate((id) => window.kumi.getConversation(id), id)).items
const wrapUps = items.filter((i) => i.kind === 'tool' && i.name === 'mcp__ccd_turn__wrap_up')
check(wrapUps.length === 1, `the agent calls wrap_up by itself after changing a file (${wrapUps.length} calls)`)
check((await page.locator('.tab-pane:not([hidden]) .item.tool .tool-label').allInnerTexts()).every((l) => l !== 'Next step'), 'the wrap_up call itself does not show in the transcript')

// A question with buttons.
await page.locator('.composer textarea').fill(
  'Call the mcp__ccd_turn__wrap_up tool with recap "The test file is in place.", ask "Keep the test file?", actions [{"label": "Keep it", "message": "Keep the test file."}, {"label": "Delete it"}] and blocked true. Then reply with just the word DONE.',
)
await page.keyboard.press('Enter')
await waitForReply(page, 2)
await box.waitFor()
check((await box.locator('.next-step-ask').innerText()) === 'Keep the test file?', 'the box asks the question')
check((await box.locator('.next-step-recap').innerText()) === 'The test file is in place.', 'the box shows the recap')
const buttons = box.locator('.next-step-actions button')
check((await buttons.allInnerTexts()).join('|') === 'Keep it|Delete it' && (await buttons.first().getAttribute('class'))?.includes('primary'), 'the buttons are there, the first as the primary one')
check((await tabStatus()) === 'attention', 'a blocked wrap_up marks the tab as waiting')
await page.screenshot({ path: `${shots}/next-step.png` })
await buttons.first().click()
await waitUntil(page, 'the answer is sent', async () => (await page.locator('.tab-pane:not([hidden]) .item.user .user-text').allInnerTexts()).includes('Keep the test file.'))
check((await box.count()) === 0, "the box goes once it is answered with the button's message")
check((await tabStatus()) !== 'attention', 'answering ends the waiting')
await waitForReply(page, 3)

// The commit action, once the folder is a git repository with an uncommitted file.
execFileSync('git', ['init', '-q'], { cwd: (await page.evaluate((id) => window.kumi.getConversation(id), id)).meta.cwd })
await page.locator('.composer textarea').fill(
  'Call the mcp__ccd_turn__wrap_up tool with recap "notes.txt is ready.", ask "Commit notes.txt?" and actions [{"action": "commit"}, {"label": "Not yet"}]. Then reply with just the word DONE.',
)
await page.keyboard.press('Enter')
await waitForReply(page, 4)
await box.waitFor()
check((await buttons.allInnerTexts()).join('|') === 'Commit|Not yet' && (await buttons.first().getAttribute('class'))?.includes('primary'), 'the commit action draws a Commit button, first as asked')
await buttons.first().click()
await waitUntil(page, 'the commit request is sent', async () => (await page.locator('.tab-pane:not([hidden]) .item.user .user-text').allInnerTexts()).includes('Commit the changes.'))
check(true, 'Commit asks the agent to commit the changes')
// The test does not commit: deny the agent's git call if it asks, and stop the turn.
await waitUntil(page, 'the agent asks or ends its turn', async () => {
  const meta = (await page.evaluate((id) => window.kumi.getConversation(id), id)).meta
  for (const request of meta.requests) await page.evaluate(([id, rid]) => window.kumi.respond(id, rid, { kind: 'permission', allow: false, message: '' }), [id, request.id])
  return meta.status === 'idle'
})

console.log(`screenshots: ${shots}`)
await page.evaluate(() => window.kumi.newTab())
await deleteConversations(page)
await app.close()
