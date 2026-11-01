// The Terminal panel: the terminal tools driven without a model (the e2e build exposes the
// workspace), the user typing in the pane and the pane replaying a tab, which tabs the agent may
// stop, the agent typing into the user's tab and through a full-screen menu, a link to a tab, and
// an agent running a command and typing into a tab, each approved by the user.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// The agent types into any tab, the user's own included, and gets the screen back; the pane shows the tab.
result = await tool('send_to_terminal', { tab_id: '3', input: [{ text: 'echo sent-$((3*3))' }, { keys: 'Enter' }] })
check(!result.isError && textOf(result).startsWith('Sent all 2 steps to tab 3') && textOf(result).includes('sent-9'), "send_to_terminal types into the user's tab and returns its screen")
await waitUntil(page, 'the pane shows the tab typed in', async () => (await screen()).includes('sent-9'))
check(true, 'the pane switches to the tab the agent types in')
const typing = tool('send_to_terminal', { tab_id: '3', input: [{ text: 'sleep 1' }, { keys: 'Enter' }, { wait_for_output_ms: 3000 }] })
await pane.locator('.terminal-typing-badge').waitFor({ timeout: 5000 })
check(true, 'the pane says the agent is typing')
await typing
await pane.locator('.terminal-typing-badge').waitFor({ state: 'detached', timeout: 5000 })
result = await tool('send_to_terminal', { tab_id: '3', input: [{ text: 'echo nope' }, { keys: 'Enter Dwn' }] })
check(result.isError === true && textOf(result).includes('Nothing was sent') && textOf(result).includes('Unknown key "Dwn"'), 'an unknown key name sends nothing')
check(!(await read('3')).includes('echo nope'), 'nothing of it was typed')
await pane.locator('.terminal-host').click()
await page.keyboard.type('x')
result = await tool('send_to_terminal', { tab_id: '3', input: [{ keys: 'Enter' }] })
check(result.isError === true && textOf(result).includes('The user is typing in tab 3'), 'nothing is sent while the user types in the tab')
await page.keyboard.press('Backspace')
await page.waitForTimeout(2200)

// A full-screen menu that takes only application-mode arrow keys, and shows its choice in reverse video.
const menu = join(mkdtempSync(join(tmpdir(), 'kumi-menu-')), 'menu.py')
writeFileSync(
  menu,
  `import os, sys, termios, tty
items = ['apple', 'banana', 'cherry']
sel = 0
fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
tty.setraw(fd)
def out(s):
    os.write(1, s.encode())
out('\\x1b[?1049h\\x1b[?1h')
def draw():
    out('\\x1b[H\\x1b[2JPick a fruit:\\r\\n' + ''.join(('\\x1b[7m> ' + item + '\\x1b[0m' if i == sel else '  ' + item) + '\\r\\n' for i, item in enumerate(items)))
draw()
try:
    while True:
        key = os.read(fd, 16)
        if key == b'\\x1bOB': sel = min(sel + 1, 2)
        elif key == b'\\x1bOA': sel = max(sel - 1, 0)
        elif key == b'\\r': break
        draw()
finally:
    out('\\x1b[?1l\\x1b[?1049l')
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
print('picked ' + items[sel])
`,
)
result = await tool('send_to_terminal', { tab_id: '3', input: [{ text: `python3 ${menu}` }, { keys: 'Enter' }, { wait_for_output_ms: 5000 }, { keys: 'Down Down Up Down' }] })
let menuScreen = textOf(result)
check(menuScreen.includes('A full-screen program shows') && menuScreen.includes('Pick a fruit:'), `the screen says a full-screen program shows (${JSON.stringify(menuScreen.split('\n')[1])})`)
check(menuScreen.includes('⟦> cherry⟧') && !menuScreen.includes('⟦> apple'), 'arrow keys move through the menu, and the screen marks the highlighted item')
await page.screenshot({ path: `${shots}/terminal-menu.png` })
result = await tool('send_to_terminal', { tab_id: '3', input: [{ keys: 'Enter' }] })
menuScreen = textOf(result)
check(menuScreen.includes('picked cherry') && !menuScreen.includes('full-screen') && !menuScreen.includes('Pick a fruit'), 'Enter picks it, and the shell is back')

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
let reply = snap.items.filter((i) => i.kind === 'text').at(-1)?.text ?? ''
check(reply.includes('42'), `the agent reads what its command printed (${JSON.stringify(reply.slice(0, 40))})`)

// An agent types into the user's tab once the user approves the steps.
await page.locator('.composer textarea').fill(
  'Use the mcp__terminal__send_to_terminal tool to type echo typed-$((5*5)) and press Enter in terminal tab 3, then reply with just the number it printed.',
)
await page.keyboard.press('Enter')
await page.waitForSelector('.tab-pane:not([hidden]) .request.permission', { timeout: 120000 })
const card = await page.locator('.tab-pane:not([hidden]) .request.permission').innerText()
check(card.includes('echo typed-$((5*5))') && card.includes('press Enter'), 'the user approves the steps')
await page.locator('.tab-pane:not([hidden]) .request button.primary', { hasText: 'Allow' }).click()
reply = (await waitForReply(page, 3)).items.filter((i) => i.kind === 'text').at(-1)?.text ?? ''
check(reply.includes('25'), `the agent reads what it typed printed (${JSON.stringify(reply.slice(0, 40))})`)

console.log(`screenshots: ${shots}`)
await page.evaluate(() => window.kumi.newTab())
await deleteConversations(page)
await app.close()
