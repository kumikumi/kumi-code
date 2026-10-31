import { describe, expect, it } from 'vitest'
import { parseWrapUp } from '@shared/wrap-up'
import { wrapUpResult } from './wrap-up'

const recap = 'The fix is in. Nothing is committed.'
const none: string[] = []

describe('wrap_up', () => {
  it('reads the buttons in order, app actions as the app draws them', () => {
    expect(parseWrapUp({ recap, ask: 'Commit it?', actions: [{ action: 'commit' }, { label: 'Not yet' }], blocked: true })).toEqual({
      recap,
      ask: 'Commit it?',
      buttons: [
        { label: 'Commit', message: 'Commit the changes.' },
        { label: 'Not yet', message: 'Not yet' },
      ],
      replies: [{ label: 'Not yet', message: 'Not yet' }],
      appActions: ['commit'],
      blocked: true,
    })
    expect(parseWrapUp({ recap, ask: 'Go?', actions: [{ label: 'Go', message: 'Go ahead.' }, { action: 'create_pr' }] }).buttons).toEqual([{ label: 'Go', message: 'Go ahead.' }])
  })

  it('shows a question, and says when there is no box', () => {
    expect(wrapUpResult({ recap, ask: 'Commit it?', actions: [{ label: 'Commit' }] }, none)).toEqual({ isError: false, text: expect.stringMatching(/^Shown in the next-step box\. .*do not ask it again\.$/) })
    expect(wrapUpResult({ recap }, none).text).toMatch(/^Nothing is pending, so the app draws no box/)
    expect(wrapUpResult({ recap, ask: 'Which one?' }, none).text).toContain('without buttons')
  })

  it('offers commit only while it holds', () => {
    const call = { recap, ask: 'Commit these changes?', actions: [{ action: 'commit' }, { label: 'Not yet' }] }
    expect(wrapUpResult(call, ['commit'])).toMatchObject({ isError: false, text: expect.stringContaining('Shown in the next-step box') })
    expect(wrapUpResult(call, none)).toMatchObject({ isError: true, text: expect.stringContaining('commit does not hold right now (app actions available: none)') })
    expect(wrapUpResult({ ...call, actions: [{ action: 'create_pr' }] }, ['commit']).text).toContain('create_pr is not an action the app has (app actions available: commit)')
    expect(wrapUpResult({ recap, actions: [{ action: 'commit' }] }, ['commit']).text).toContain('there is no ask')
  })

  it('never names Kumi Code to the agent', () => {
    for (const input of [{ recap }, { recap, ask: 'Go?', actions: [{ label: 'Yes' }] }, { recap, ask: 'Go?', actions: [{ action: 'commit' }] }, { recap, ask: 'Go?', actions: [{ label: '/x' }] }]) {
      expect(wrapUpResult(input, none).text).not.toMatch(/kumi/i)
    }
  })

  it('refuses what it cannot show', () => {
    expect(wrapUpResult({ recap: ' ' }, none).isError).toBe(true)
    expect(wrapUpResult({ recap, actions: [{ label: 'Yes' }] }, none).text).toContain('there is no ask')
    expect(wrapUpResult({ recap, ask: 'Go?', actions: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }, none).text).toContain('3 buttons')
    expect(wrapUpResult({ recap, ask: 'Go?', actions: [{ label: 'Run', message: '/compact' }] }, none).text).toContain('as a command')
  })

  it('advises on the next call when a field runs long', () => {
    const result = wrapUpResult({ recap: 'x'.repeat(320), ask: 'Go?', actions: [{ label: 'Yes, go ahead with all of it' }] }, none)
    expect(result.isError).toBe(false)
    expect(result.text).toContain('this one ran 320')
    expect(result.text).toContain('24 characters at most')
  })
})
