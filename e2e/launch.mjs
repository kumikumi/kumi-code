// Launches the built app (`bun run build` first) with a throwaway state directory.
// The app opens real windows; the tests never touch the real mouse. Conversations
// are real Claude Code sessions, so tests delete the ones they create.

import { _electron as electron } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const root = resolve(import.meta.dirname, '..')
export const shots = mkdtempSync(join(tmpdir(), 'kumi-e2e-shots-'))

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
