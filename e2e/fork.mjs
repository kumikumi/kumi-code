// Message times and turn timing; forking a conversation from a turn, and with another model,
// which is the only way to change the model once a conversation has messages.
import { check, deleteConversations, launch, MODEL, newUserData, shots, startConversation, waitForReply, waitUntil } from './launch.mjs'

const { app, page } = await launch(newUserData())
const pane = () => page.locator('.tab-pane:not([hidden])')
const snap = (id) => page.evaluate((id) => window.kumi.getConversation(id), id)
const activeConversation = async () => {
  const state = await page.evaluate(() => window.kumi.getWindowState())
  return state.tabs.find((t) => t.id === state.activeTabId)?.conversationId
}
const failure = (fn) => fn.then(() => null, (err) => String(err))

const id = await startConversation(page)
await pane().locator('.composer textarea').fill('Reply with just the word A.')
await page.keyboard.press('Enter')
await waitForReply(page, 1)
check(/\d{1,2}[:.]\d{2}/.test(await pane().locator('.message-time').first().innerText()), 'the message shows when it was sent')
const footer = pane().locator('.item.turn-end')
check(/^Worked for (<1s|\d+s)/.test(await footer.locator('time').innerText()), `the reply shows how long it took and when it finished (${JSON.stringify(await footer.locator('time').innerText())})`)
const edge = async (selector) => page.evaluate((s) => [...document.querySelectorAll(`.tab-pane:not([hidden]) ${s}`)].at(-1)?.getBoundingClientRect().right, selector)
check(Math.abs((await edge('.turn-end time')) - (await edge('.message-time'))) < 1, 'the reply\'s time lines up with the message\'s, at the right')
const turn = (await snap(id)).items.find((i) => i.kind === 'turn')
check(turn && turn.finishedAt >= turn.startedAt && turn.messageId, 'the turn item has its times and last message')

// The model is fixed: the menu forks, setModel and /model are refused.
const modelMenu = pane().locator('.composer-bar select').nth(1)
check((await modelMenu.locator('optgroup').getAttribute('label')) === 'Fork with another model', 'the model menu offers other models as forks')
check((await failure(page.evaluate(([id]) => window.kumi.setModel(id, 'sonnet'), [id])))?.includes('keeps its model'), 'setModel is refused once there are messages')
check((await failure(page.evaluate(([id]) => window.kumi.send(id, '/model sonnet', []), [id])))?.includes('model menu'), '/model is refused')

// Fork from the turn: a new tab with the copy, which goes on by itself.
await footer.hover()
await footer.locator('.turn-fork').click()
await waitUntil(page, 'the fork opens in a new tab', async () => (await activeConversation()) !== id)
const forkId = await activeConversation()
await waitUntil(page, 'the fork shows the copy', async () => (await pane().locator('.fork-divider').count()) === 1)
const copy = await snap(forkId)
check(JSON.stringify(copy.items.map((i) => i.kind)) === JSON.stringify(['user', 'text', 'turn', 'fork']), `the fork has the conversation up to the turn (${copy.items.map((i) => i.kind).join(', ')})`)
const copiedTurn = copy.items.find((i) => i.kind === 'turn')
check(Math.abs(copiedTurn?.startedAt - turn.startedAt) < 2000 && Math.abs(copiedTurn?.finishedAt - turn.finishedAt) < 2000, `the copied turn keeps its times, not the fork's (started ${copiedTurn?.startedAt - turn.startedAt} ms, finished ${copiedTurn?.finishedAt - turn.finishedAt} ms from the source)`)
check(copy.meta.model === MODEL && copy.meta.hasMessages, 'the fork keeps the model')
await pane().locator('.composer textarea').fill('Reply with just the word B.')
await page.keyboard.press('Enter')
await waitForReply(page, 2)
const forkTexts = (await snap(forkId)).items.filter((i) => i.kind === 'text').map((i) => i.text)
check(forkTexts.at(-1)?.includes('B'), `the fork replies (${JSON.stringify(forkTexts)})`)
check((await snap(id)).items.filter((i) => i.kind === 'text').length === 1, 'the source conversation is unchanged')
await pane().locator('.item.turn-end').last().hover()
await page.screenshot({ path: `${shots}/fork.png` })

// Another model: a fork of the whole conversation on it; the source keeps its model.
await page.evaluate((id) => window.kumi.showConversation(id), id)
await waitUntil(page, 'the source tab is active', async () => (await activeConversation()) === id)
await pane().locator('.composer-bar select').nth(1).selectOption('sonnet')
await waitUntil(page, 'the model fork opens', async () => ![id, forkId].includes(await activeConversation()))
const modelFork = await snap(await activeConversation())
check(modelFork.meta.model === 'sonnet', `the fork runs on the model picked (${modelFork.meta.model})`)
check((await snap(id)).meta.model === MODEL, 'the source keeps its model')
await page.evaluate((id) => window.kumi.showConversation(id), id)
await waitUntil(page, 'the source tab is active again', async () => (await activeConversation()) === id)
check((await pane().locator('.composer-bar select').nth(1).inputValue()) === MODEL, 'the source menu still shows its model')
console.log(`screenshots: ${shots}`)

// A tab of its own keeps the window open while the conversations are deleted.
await page.evaluate(() => window.kumi.newTab())
await deleteConversations(page)
await app.close()
