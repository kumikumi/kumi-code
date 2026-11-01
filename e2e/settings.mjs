// The mode, model and effort menus: they name what applies instead of offering a
// "Default", and a new conversation starts with what the user last picked, unless
// the model list no longer offers it. Sends no messages.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, deleteConversations, launch, newUserData } from './launch.mjs'

const userData = newUserData()
let { app, page } = await launch(userData)
const selects = () => page.locator('.tab-pane:not([hidden]) .composer-bar select')
const values = async () => (await Promise.all([0, 1, 2].map((i) => selects().nth(i).inputValue()))).join()
const optionTexts = async (i) => selects().nth(i).locator('option').allInnerTexts()

/** Starts a project-less conversation in a new tab and waits for its menus to fill in. */
async function start(newTab = true) {
  if (newTab) await page.evaluate(() => window.kumi.newTab())
  await page.locator('.tab-pane:not([hidden])').getByText('No project', { exact: true }).click()
  await page.waitForFunction(() => {
    const s = document.querySelectorAll('.tab-pane:not([hidden]) .composer-bar select')
    return s.length === 3 && s[1].options.length > 1 && s[2].value !== ''
  }, null, { timeout: 60000 })
}

await start(false)
const defaults = await values()
const [mode, model, effort] = defaults.split(',')
check(mode === 'default' && model !== 'default' && model !== '' && effort !== '', `a first conversation shows the defaults by name (${defaults})`)
check(!(await optionTexts(1)).some((t) => t.startsWith('Default')), 'the model menu has no Default row')
check(!(await optionTexts(2)).some((t) => t.startsWith('Default')), 'the effort menu has no Default row')

await selects().nth(0).selectOption('plan')
await selects().nth(1).selectOption('sonnet')
await selects().nth(2).selectOption('low')
await start()
check((await values()) === 'plan,sonnet,low', `a new conversation starts with the last picks (${await values()})`)

// Picks the list no longer offers fall back to the default: an effort the model
// lacks, and a model gone since the last run.
await selects().nth(2).selectOption('xhigh')
await selects().nth(1).selectOption('claude-sonnet-4-6')
await page.waitForFunction(() => document.querySelectorAll('.tab-pane:not([hidden]) .composer-bar select')[2]?.value !== 'xhigh', null, { timeout: 10000 })
await page.waitForTimeout(1000)
const dropped = await values()
check(dropped.startsWith('plan,claude-sonnet-4-6,') && !dropped.endsWith(',xhigh'), `a model without the effort runs at its default effort (${dropped})`)
await start()
check((await values()) === dropped, `a new conversation falls back from an effort its model lacks (${await values()})`)

await app.close()
const file = join(userData, 'state.json')
const state = JSON.parse(readFileSync(file, 'utf8'))
state.lastPicked.model = 'claude-gone-1'
writeFileSync(file, JSON.stringify(state))
;({ app, page } = await launch(userData))
await start()
check((await values()).split(',')[1] === model, `a new conversation falls back from a model the list does not offer (${await values()})`)

await deleteConversations(page)
await app.close()
