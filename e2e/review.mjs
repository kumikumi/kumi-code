// A code review loop: a reviewer reports findings about a bug in the implementer's folder, the
// user picks findings and closes and reopens one with a click, and the review panel relays one
// finding to the implementer, whose answer goes on to the reviewer by itself.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, deleteConversations, launch, newUserData, shots, startConversation, waitForReply, waitUntil } from './launch.mjs'

const { app, page } = await launch(newUserData())
const activeTab = async () => {
  const state = await page.evaluate(() => window.kumi.getWindowState())
  return state.tabs.find((t) => t.id === state.activeTabId)
}
const reviews = () => page.evaluate(() => window.kumi.listReviews())
const statusOf = async (rank) => (await reviews())[0]?.findings.find((f) => f.rank === rank)?.status

const implementer = await startConversation(page)
await page.evaluate((id) => window.kumi.setPermissionMode(id, 'bypassPermissions'), implementer)
const cwd = (await page.evaluate((id) => window.kumi.getConversation(id), implementer)).meta.cwd
// The bug is the test's, not something the implementer was asked for: told to write it, an
// implementer rightly pushes back.
writeFileSync(join(cwd, 'add.js'), 'export const add = (a, b) => a - b\n')
await page.locator('.composer textarea').fill('Reply with just the word READY.')
await page.keyboard.press('Enter')
await waitForReply(page, 1)

// The reviewer works in the implementer's folder.
await page.evaluate(() => window.kumi.newTab())
await page.evaluate(([tabId, cwd]) => window.kumi.startConversation(tabId, cwd), [(await activeTab()).id, cwd])
const reviewer = (await activeTab()).conversationId
await page.evaluate(([id, model]) => window.kumi.setModel(id, model), [reviewer, 'haiku'])
await page.waitForSelector('.tab-pane:not([hidden]) .composer textarea')
await page.locator('.tab-pane:not([hidden]) .composer textarea').fill(
  'Call the ReportFindings tool once, with level "low" and these two findings, in this order, and nothing else. ' +
    'First: file "add.js", line 1, summary "add subtracts its arguments instead of adding them.", short_summary "add subtracts instead of adding", ' +
    'failure_scenario "add(2, 3) returns -1 instead of 5.", category "correctness", verdict "CONFIRMED". ' +
    'Second: file "add.js", line 1, summary "add has no JSDoc comment.", short_summary "add lacks a JSDoc comment", failure_scenario "Editors show no documentation for add.", ' +
    'category "documentation", verdict "PLAUSIBLE". Then reply with just the word DONE.',
)
await page.keyboard.press('Enter')
await waitForReply(page, 1)
const card = page.locator('.tab-pane:not([hidden]) .item.findings')
await card.waitFor()
check((await card.locator('.finding-title').allInnerTexts()).join('|') === 'add subtracts instead of adding|add lacks a JSDoc comment', 'the findings card lists the findings by rank')
await card.locator('.finding-line').first().click()
check((await card.locator('.finding-details').innerText()).includes('add(2, 3) returns -1'), 'a finding expands to its failure scenario')

await card.getByRole('button', { name: 'Start review loop…' }).click()
await card.locator('.pick-row').first().click()
await waitUntil(page, 'the review starts', async () => (await reviews()).length === 1)
const [review] = await reviews()
check(review.implementerId === implementer && review.reviewerId === reviewer, 'the review links the reviewer to the conversation picked as the implementer')
const panel = page.locator('.tab-pane:not([hidden]) .review-panel')
await panel.waitFor()
const current = () => panel.locator('.review-finding.current .review-row-title').innerText()
check((await current()).startsWith('1.'), 'the panel starts at the first finding')

// The panel's left edge resizes it.
const panelWidth = (locator) => locator.evaluate((el) => Math.round(el.getBoundingClientRect().width))
const dock = page.locator('.tab-pane:not([hidden]) .dock')
const before = await panelWidth(dock)
const edge = await dock.locator('.dock-resize').boundingBox()
await page.mouse.move(edge.x + edge.width / 2, edge.y + 200)
await page.mouse.down()
await page.mouse.move(edge.x + edge.width / 2 - 120, edge.y + 200, { steps: 6 })
await page.mouse.up()
const widened = await panelWidth(dock)
check(widened === before + 120, `dragging the panel's edge widens it (${before} → ${widened} px)`)
check((await page.evaluate(() => localStorage.getItem('reviewPanelWidth'))) === String(widened), 'the width is remembered')

// The user picks which finding is next, and closes one with a click.
await panel.locator('.review-pick').nth(1).click()
check((await current()).startsWith('2.'), 'clicking a finding makes it the current one')
await panel.locator('.review-finding').nth(1).getByRole('button', { name: 'Close' }).click()
await waitUntil(page, 'finding 2 closes', async () => (await statusOf(2)) === 'closed')
check(true, 'Close closes a finding')
check((await current()).startsWith('2.'), 'a closed finding stays the current one')
// A row's Close and Reopen show on hover, and always on the current finding.
await panel.locator('.review-finding').nth(1).hover()
await panel.locator('.review-finding').nth(1).getByRole('button', { name: 'Reopen' }).click()
await waitUntil(page, 'finding 2 reopens', async () => (await statusOf(2)) === 'open')
check(true, 'Reopen puts a closed finding back')

await panel.locator('.review-pick').first().click()
await panel.locator('.review-note').fill('Keep it an arrow function.')
await panel.getByRole('button', { name: /Send to implementer/ }).click()
await waitUntil(page, 'finding 1 is sent', async () => (await statusOf(1)) === 'implementing')
check((await current()).startsWith('1.'), 'a sent finding stays the current one')
const answerOf = async () => (await reviews())[0]?.findings[0]?.thread.find((t) => t.from === 'implementer')?.outcome
await waitUntil(page, 'the implementer answers', async () => (await answerOf()) !== undefined)
check((await answerOf()) === 'fixed', `the implementer answers through its tool (${await answerOf()})`)
check(['verifying', 'resolved', 'withdrawn', 'reopened'].includes(await statusOf(1)), `the answer goes to the reviewer by itself (${await statusOf(1)})`)
await waitUntil(page, 'the reviewer answers', async () => ['resolved', 'withdrawn', 'reopened'].includes(await statusOf(1)))
check((await statusOf(1)) === 'resolved', `the reviewer verifies the fix (${await statusOf(1)})`)
check((await panel.getByRole('button', { name: /Send to reviewer/ }).count()) === 0, 'the panel never asks to send to the reviewer')
check((await current()).startsWith('1.'), 'a settled finding stays the current one')
await panel.locator('.review-finding').nth(1).hover()
await panel.locator('.review-finding').nth(1).getByRole('button', { name: 'Close' }).click()
await waitUntil(page, 'finding 2 closes again', async () => (await statusOf(2)) === 'closed')
check((await panel.locator('.review-head').innerText()).includes('2 of 2 settled'), 'the panel counts both findings as settled')

// The reviewer withdraws its verified finding by reporting again; the user's closing stands.
await page.locator('.tab-pane:not([hidden]) .composer textarea').fill(
  'Call the ReportFindings tool again, with level "low" and the same two findings as before in the same order, now with outcome "no_change_needed" on the first and outcome "skipped" on the second. Then reply with just the word DONE.',
)
await page.keyboard.press('Enter')
await waitUntil(page, 'finding 1 is withdrawn', async () => (await statusOf(1)) === 'withdrawn')
check((await statusOf(2)) === 'closed', "the reviewer's report withdraws a verified finding and leaves the user's closed one")
await panel.locator('.review-pick').first().click()
check((await panel.locator('.review-finding.current .thread-who').allInnerTexts()).at(-1) === 'Reviewer · withdrew it', 'the thread shows the withdrawal')
const again = page.locator('.tab-pane:not([hidden]) .item.findings').last()
check((await again.locator('.tool-label').innerText()) === 'Findings reported again' && (await again.locator('.finding-where').first().innerText()) === '→ finding 1', 'the new report shows where its outcomes went')
check((await again.getByRole('button', { name: 'Start review loop…' }).count()) === 0, 'a report of outcomes does not offer a new review')
await waitUntil(page, 'the reviewer is idle', async () => (await page.evaluate((id) => window.kumi.getConversation(id), reviewer)).meta.status === 'idle')

// The reviewer sends a finding it settled back to the implementer.
await page.locator('.tab-pane:not([hidden]) .composer textarea').fill(
  'Call the mcp__review__resolve_finding tool with finding 1, verdict "reopen" and reply "Undo the fix: the finding was wrong." Then reply with just the word DONE.',
)
await page.keyboard.press('Enter')
await waitUntil(page, 'finding 1 is reopened', async () => (await statusOf(1)) === 'reopened')
check((await panel.getByRole('button', { name: /Send back to implementer/ }).count()) === 1, 'the reviewer reopens a finding it settled, for the user to send back')
await waitUntil(page, 'the reviewer is idle again', async () => (await page.evaluate((id) => window.kumi.getConversation(id), reviewer)).meta.status === 'idle')
await page.screenshot({ path: `${shots}/review-reviewer.png` })

await page.locator('.tab-pane:not([hidden]) .review-head').getByRole('button', { name: /Implementer/ }).click()
await waitUntil(page, 'the implementer tab shows', async () => (await activeTab()).conversationId === implementer)
check((await panelWidth(page.locator('.tab-pane:not([hidden]) .dock'))) === widened, "the implementer's panel has the same width")
const relays = page.locator('.tab-pane:not([hidden]) .item.relay')
check((await relays.count()) === 1, 'the implementer transcript shows the relayed finding as a card')
check((await relays.first().innerText()).includes('Keep it an arrow function.'), "the relay card shows the user's note")
const labels = await page.locator('.tab-pane:not([hidden]) .item.tool .tool-label').allInnerTexts()
check(labels.includes('Answer finding'), `the answer shows as an "Answer finding" tool call (${labels.join(', ')})`)
await page.screenshot({ path: `${shots}/review-implementer.png` })
console.log(`screenshots: ${shots}`)
// A new tab keeps the window open while its conversation tabs close.
await page.evaluate(() => window.kumi.newTab())
await deleteConversations(page)
check((await reviews()).length === 0, 'deleting the conversations ends their review')
await app.close()
