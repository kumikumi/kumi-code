// The Terminal panel: the terminal tools driven without a model (the e2e build exposes the
// workspace), the user typing in the pane and the pane replaying a tab, which tabs the agent may
// stop, a link to a tab, and an agent running a command the user approves and reading it.
import { check, deleteConversations, launch, newUserData, shots, startConversation, waitForReply, waitUntil } from './launch.mjs'

const { app, page } = await launch(newUserData())
const id = await startConversation(page)
const tool = (name, input = {}) => app.evaluate((_electron, [id, name, input]) => globalThis.kumiWorkspace.terminalTool(id, name, input), [id, name, input])
const textOf = (result) => result.content.map((c) => c.text).join('\n')
const read = async (tabId, wait = 0) => textOf(await tool('read_terminal', { tab_id: tabId, wait_for_output_ms: wait }))
const pane = page.locator('.tab-pane:not([hidden]) .terminal-pane')
const screen = () => pane.locator('.xterm-rows').innerText()

// The agent runs commands in tabs of their own and reads them.
let result = await tool('run_in_terminal', { command: 'echo kumi-$((6*7))', title: 'calc' })
check(textOf(result).startsWith('Typed into tab 0'), `run_in_terminal types into a new tab (${textOf(result).split('.')[0]})`)
await waitUntil(page, 'the command prints', async () => (await read('0', 2000)).includes('kumi-42'))
check(true, 'read_terminal reads what the command printed')
check((await pane.count()) === 0, 'run_in_terminal does not open the panel')
await tool('run_in_terminal', { command: 'sleep 100', title: 'sleeper' })
await waitUntil(page, 'sleep runs', async () => JSON.parse(textOf(await tool('list_terminal_tabs'))).find((t) => t.tab_id === '1')?.is_running_command === true)
const tabs = JSON.parse(textOf(await tool('list_terminal_tabs')))
check(tabs.length === 2 && tabs[0].title === 'calc' && tabs[0].opened_by === 'agent' && tabs[0].is_running_command === false, 'list_terminal_tabs says which tab runs a command')
result = await tool('stop_terminal_tab', { tab_id: '1' })
check(textOf(result).includes('idle, back at its prompt'), `stop_terminal_tab sends Ctrl-C (${textOf(result).split('.')[0]})`)
result = await tool('stop_terminal_tab', { tab_id: '1', close: true })
check(textOf(result).startsWith('Closed tab 1'), 'stop_terminal_tab closes a tab')

// Lines that may not be typed open no tab.
for (const [command, why] of [
  ['echo a\necho b', 'more than one line'],
  ["echo 'unclosed", 'cannot parse'],
  ['PS1=x', 'PS1'],
]) {
  result = await tool('run_in_terminal', { command })
  check(result.isError === true && textOf(result).includes(why) && textOf(result).includes('No tab was opened'), `refuses ${JSON.stringify(command)} (${why})`)
}
check(JSON.parse(textOf(await tool('list_terminal_tabs'))).length === 1, 'no tab was opened for them')

// open_terminal_tab shows the panel; the user types in it.
result = await tool('open_terminal_tab', { title: 'for you' })
await pane.waitFor()
check(textOf(result).startsWith('Opened tab 2'), 'open_terminal_tab opens a tab and shows the panel')
await waitUntil(page, 'the shell prompt shows', async () => (await screen()).trim().length > 0)
await pane.locator('.terminal-host').click()
await page.keyboard.type('echo typed-$((2+3))')
await page.keyboard.press('Enter')
await waitUntil(page, 'the typed command runs', async () => (await read('2', 2000)).includes('typed-5'))
check(true, 'typing in the pane runs in the shell')
result = await tool('stop_terminal_tab', { tab_id: '2' })
check(result.isError === true && textOf(result).includes('typed in tab 2'), 'the agent may not stop a tab the user typed in')
await pane.getByRole('button', { name: 'New tab' }).click()
await waitUntil(page, 'the user opens a tab', async () => JSON.parse(textOf(await tool('list_terminal_tabs'))).some((t) => t.opened_by === 'user'))
result = await tool('stop_terminal_tab', { tab_id: '3' })
check(result.isError === true && textOf(result).includes('the user opened'), 'the agent may not stop a tab the user opened')

// Switching tabs replays a tab's screen.
await pane.locator('.browser-tab-title', { hasText: 'calc' }).click()
await waitUntil(page, 'the pane shows tab 0', async () => (await screen()).includes('kumi-42'))
check(true, "the pane replays a tab's screen")
await page.screenshot({ path: `${shots}/terminal.png` })

// A link to a tab in the agent's reply shows it.
await pane.getByRole('button', { name: 'Hide the terminal' }).click()
await page.locator('.composer textarea').fill('Reply with exactly this markdown and nothing else: [the calc tab](#terminal/0)')
await page.keyboard.press('Enter')
await waitForReply(page, 1)
await page.locator('.tab-pane:not([hidden]) .item.text a', { hasText: 'the calc tab' }).click()
await pane.waitFor()
check((await pane.locator('.browser-tab.active').innerText()).includes('calc'), 'a #terminal/ link shows the tab')

// An agent runs a command once the user approves the line, and reads it.
await page.locator('.composer textarea').fill(
  'Use the mcp__terminal__run_in_terminal tool to run: echo agent-$((40+2)) — then read its output with mcp__terminal__read_terminal and reply with just the number it printed.',
)
await page.keyboard.press('Enter')
await page.waitForSelector('.tab-pane:not([hidden]) .request.permission', { timeout: 120000 })
check((await page.locator('.tab-pane:not([hidden]) .request.permission').innerText()).includes('echo agent-$((40+2))'), 'the user approves the exact line')
await page.locator('.tab-pane:not([hidden]) .request button.primary', { hasText: 'Allow' }).click()
const snap = await waitForReply(page, 2)
const reply = snap.items.filter((i) => i.kind === 'text').at(-1)?.text ?? ''
check(reply.includes('42'), `the agent reads what its command printed (${JSON.stringify(reply.slice(0, 40))})`)

console.log(`screenshots: ${shots}`)
await page.evaluate(() => window.kumi.newTab())
await deleteConversations(page)
await app.close()
