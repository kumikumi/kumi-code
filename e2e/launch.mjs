// Launches the built app (`bun run build` first) with a throwaway state directory.
// The app opens real windows; the tests never touch the real mouse. Conversations
// are real Claude Code sessions, so tests delete the ones they create.

import { _electron as electron } from 'playwright-core'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const root = resolve(import.meta.dirname, '..')
export const shots = mkdtempSync(join(tmpdir(), 'kumi-e2e-shots-'))

/** The model tests talk to: the cheapest, and independent of the user's default. */
export const MODEL = 'haiku'

export function newUserData() {
  return mkdtempSync(join(tmpdir(), 'kumi-e2e-'))
}

export async function launch(userData) {
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    args: [root],
    env: { ...process.env, KUMI_USER_DATA: userData },
  })
  app.process().stderr.on('data', (d) => {
    const s = String(d)
    if (!s.includes('Debugger') && !s.includes('debugging')) process.stderr.write(`[main] ${s}`)
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('[renderer error]', e.stack ?? e.message))
  await page.waitForSelector('.tabstrip')
  return { app, page }
}

export function check(ok, message) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`)
  if (!ok) process.exitCode = 1
}

/** Waits until the active conversation is idle with at least `count` replies; fails on an error. */
export async function waitForReply(page, count, timeoutMs = 180000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const state = await page.evaluate(() => window.kumi.getWindowState())
    const id = state.tabs.find((t) => t.id === state.activeTabId)?.conversationId
    const snap = await page.evaluate((id) => window.kumi.getConversation(id), id)
    if (snap.meta.status === 'error') throw new Error(`Conversation failed: ${snap.meta.error}`)
    const replies = snap.items.filter((i) => i.kind === 'text').length
    const errors = snap.items.filter((i) => i.kind === 'notice' && i.level === 'error')
    if (errors.length > 0) throw new Error(`Conversation error: ${errors.map((e) => e.text).join('; ')}`)
    if (snap.meta.status === 'idle' && replies >= count) return snap
    await page.waitForTimeout(300)
  }
  throw new Error('Timed out waiting for a reply')
}

/** Deletes the conversations this test's Kumi Code state knows, so they leave no sessions behind. */
export async function deleteConversations(page) {
  for (const c of await page.evaluate(() => window.kumi.listConversations(false))) {
    await page.evaluate((id) => window.kumi.deleteConversation(id), c.id)
  }
}

/** Starts a project-less conversation in the active tab, on MODEL; returns its id. */
export async function startConversation(page) {
  await page.getByText('No project', { exact: true }).click()
  await page.waitForSelector('.composer textarea')
  // The model list arrives once Claude Code has started.
  const listed = (model) => [...(document.querySelectorAll('.composer-bar select')[1]?.options ?? [])].some((o) => o.value === model)
  await page.waitForFunction(listed, MODEL, { timeout: 60000 })
  const state = await page.evaluate(() => window.kumi.getWindowState())
  const id = state.tabs.find((t) => t.id === state.activeTabId).conversationId
  await page.evaluate(([id, model]) => window.kumi.setModel(id, model), [id, MODEL])
  return id
}

/** A conversation's transcript file, or null when there is none. */
export function transcriptFile(id) {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  const dir = readdirSync(projects).find((d) => existsSync(join(projects, d, `${id}.jsonl`)))
  return dir ? join(projects, dir, `${id}.jsonl`) : null
}

/** The models that wrote a conversation's replies, from its transcript. */
export function replyModels(id) {
  const file = transcriptFile(id)
  if (!file) return []
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  // Claude Code records its own notices (errors, interruptions) as "<synthetic>".
  const models = records.filter((r) => r.type === 'assistant').map((r) => r.message?.model).filter((m) => m && m !== '<synthetic>')
  return [...new Set(models)]
}

/** Polls until `condition` holds; fails the test run when it never does. */
export async function waitUntil(page, what, condition, timeoutMs = 180000) {
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await page.waitForTimeout(200)) if (await condition()) return
  throw new Error(`Timed out waiting until ${what}`)
}
