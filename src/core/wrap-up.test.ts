import { describe, expect, it } from 'vitest'
import { parseWrapUp } from '@shared/wrap-up'
import { wrapUpResult } from './wrap-up'

const recap = 'The fix is in. Nothing is committed.'

describe('wrap_up', () => {
  it('reads replies, their messages and the question', () => {
    expect(parseWrapUp({ recap, ask: 'Commit it?', actions: [{ label: 'Commit', message: 'Commit the fix.' }, { label: 'Not yet' }], blocked: true })).toEqual({
      recap,
      ask: 'Commit it?',
      replies: [
        { label: 'Commit', message: 'Commit the fix.' },
        { label: 'Not yet', message: 'Not yet' },
      ],
      appActions: [],
      blocked: true,
    })
  })

  it('shows a question, and says when there is no box', () => {
    expect(wrapUpResult({ recap, ask: 'Commit it?', actions: [{ label: 'Commit' }] })).toEqual({ isError: false, text: expect.stringMatching(/^Shown in the next-step box\. .*do not ask it again\.$/) })
    expect(wrapUpResult({ recap }).text).toMatch(/^Nothing is pending, so the app draws no box/)
    expect(wrapUpResult({ recap, ask: 'Which one?' }).text).toContain('without buttons')
  })

  it('never names Kumi Code to the agent', () => {
    for (const input of [{ recap }, { recap, ask: 'Go?', actions: [{ label: 'Yes' }] }, { recap, ask: 'Go?', actions: [{ action: 'commit' }] }, { recap, ask: 'Go?', actions: [{ label: '/x' }] }]) {
      expect(wrapUpResult(input).text).not.toMatch(/kumi/i)
    }
  })

  it('refuses what it cannot show', () => {
    expect(wrapUpResult({ recap, ask: 'Commit?', actions: [{ action: 'commit' }] })).toMatchObject({ isError: true, text: expect.stringContaining('commit is not an action the app has') })
    expect(wrapUpResult({ recap: ' ' }).isError).toBe(true)
    expect(wrapUpResult({ recap, actions: [{ label: 'Yes' }] }).text).toContain('there is no ask')
    expect(wrapUpResult({ recap, ask: 'Go?', actions: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }).text).toContain('3 buttons')
    expect(wrapUpResult({ recap, ask: 'Go?', actions: [{ label: 'Run', message: '/compact' }] }).text).toContain('as a command')
  })

  it('advises on the next call when a field runs long', () => {
    const result = wrapUpResult({ recap: 'x'.repeat(320), ask: 'Go?', actions: [{ label: 'Yes, go ahead with all of it' }] })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('this one ran 320')
    expect(result.text).toContain('24 characters at most')
  })
})
