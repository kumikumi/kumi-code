import { describe, expect, it, vi } from 'vitest'
import { parseRelay, relayText, Reviews } from './review'
import { TranscriptBuilder } from './transcript'

const report = {
  level: 'high',
  findings: [
    { file: 'src/a.ts', line: 12, summary: 'Cache key ignores the site.', short_summary: 'Cache key ignores site', failure_scenario: 'Two sites share a slab.', category: 'correctness', verdict: 'CONFIRMED' },
    { file: 'src/b.ts', summary: 'Label duplicates another tab.', failure_scenario: 'Both tabs read "Profile".', verdict: 'PLAUSIBLE' },
  ],
}

function started() {
  const onChange = vi.fn()
  const reviews = new Reviews({}, onChange)
  const review = reviews.start('tu1', 'rev', 'impl', report, 1)
  return { reviews, review, onChange }
}

describe('Reviews', () => {
  it('starts a review from a ReportFindings input, most severe first', () => {
    const { review, onChange } = started()
    expect(review.findings).toMatchObject([
      { rank: 1, title: 'Cache key ignores site', file: 'src/a.ts', line: 12, verdict: 'CONFIRMED', status: 'open' },
      // Without a short summary the summary is the title.
      { rank: 2, title: 'Label duplicates another tab.', line: null, category: null, verdict: 'PLAUSIBLE', status: 'open' },
    ])
    expect(onChange).toHaveBeenCalled()
  })

  it('relays a fix to the reviewer and settles it when the reviewer accepts', () => {
    const { reviews, review } = started()
    const first = reviews.relay('tu1', 1, ' check the legacy view ')
    expect(first).toMatchObject({ to: 'implementer', conversationId: 'impl' })
    expect(parseRelay(first.text)).toMatchObject({ to: 'implementer', rank: 1, of: 2, reply: null, note: 'check the legacy view' })
    expect(first.text).toContain('mcp__kumi__respond_to_finding')
    // Nothing changes until the message went out.
    expect(review.findings[0]?.status).toBe('open')
    reviews.sent('tu1', 1, 'implementer', ' check the legacy view ', 2)
    expect(review.findings[0]).toMatchObject({ status: 'implementing', thread: [{ from: 'user', text: 'check the legacy view' }] })

    reviews.answer('impl', { role: 'implementer', finding: 1, outcome: 'fixed', reply: 'Added the site id to the key.' })
    expect(review.findings[0]?.status).toBe('fixed')
    const second = reviews.relay('tu1', 1, '')
    expect(second.conversationId).toBe('rev')
    expect(parseRelay(second.text)).toMatchObject({ to: 'reviewer', reply: { from: 'implementer', outcome: 'fixed', text: 'Added the site id to the key.' }, note: null })
    reviews.sent('tu1', 1, 'reviewer', '')
    reviews.answer('rev', { role: 'reviewer', finding: 1, verdict: 'accept', reply: 'Verified.' })
    expect(review.findings[0]?.status).toBe('resolved')
  })

  it('withdraws a finding whose push-back the reviewer accepts, and reopens one it rejects', () => {
    const { reviews, review } = started()
    for (const rank of [1, 2]) {
      reviews.sent('tu1', rank, 'implementer', '')
      reviews.answer('impl', { role: 'implementer', finding: rank, outcome: 'no_change_needed', reply: 'Caches are per site.' })
      reviews.sent('tu1', rank, 'reviewer', '')
    }
    expect(review.findings[0]?.status).toBe('verifying')
    reviews.answer('rev', { role: 'reviewer', finding: 1, verdict: 'accept', reply: 'Right.' })
    reviews.answer('rev', { role: 'reviewer', finding: 2, verdict: 'reopen', reply: 'The label is still duplicated.' })
    expect(review.findings.map((f) => f.status)).toEqual(['withdrawn', 'reopened'])
    // A reopened finding goes back to the implementer with the reviewer's reason.
    const back = reviews.relay('tu1', 2, '')
    expect(back.conversationId).toBe('impl')
    expect(parseRelay(back.text)?.reply).toMatchObject({ from: 'reviewer', outcome: 'reopen', text: 'The label is still duplicated.' })
  })

  it('tells an agent when a finding is not waiting on it', () => {
    const { reviews } = started()
    expect(() => reviews.answer('impl', { role: 'implementer', finding: 1, outcome: 'fixed', reply: '' })).toThrow('not waiting on your answer')
    expect(() => reviews.answer('impl', { role: 'implementer', finding: 9, outcome: 'fixed', reply: '' })).toThrow('numbered 1 to 2')
    expect(() => reviews.answer('rev', { role: 'implementer', finding: 1, outcome: 'fixed', reply: '' })).toThrow('not the implementer')
    reviews.sent('tu1', 1, 'implementer', '')
    reviews.setClosed('tu1', 1, true)
    expect(() => reviews.answer('impl', { role: 'implementer', finding: 1, outcome: 'fixed', reply: '' })).toThrow('closed')
  })

  it('closes and reopens a finding where it was', () => {
    const { reviews, review } = started()
    reviews.sent('tu1', 1, 'implementer', '')
    reviews.answer('impl', { role: 'implementer', finding: 1, outcome: 'fixed', reply: 'Done.' })
    reviews.setClosed('tu1', 1, true)
    expect(review.findings[0]).toMatchObject({ status: 'closed', closedFrom: 'fixed' })
    expect(() => reviews.relay('tu1', 1, '')).toThrow('not waiting to be sent')
    reviews.setClosed('tu1', 1, false)
    expect(review.findings[0]).toMatchObject({ status: 'fixed', closedFrom: null })
    // A finding closed while an agent had it can be sent again once reopened.
    reviews.sent('tu1', 2, 'implementer', '')
    reviews.setClosed('tu1', 2, true)
    reviews.setClosed('tu1', 2, false)
    expect(review.findings[1]).toMatchObject({ status: 'implementing', stalled: true })
    expect(reviews.relay('tu1', 2, '').to).toBe('implementer')
  })

  it('marks findings stalled when their agent ends its turn without answering', () => {
    const { reviews, review } = started()
    reviews.sent('tu1', 1, 'implementer', '')
    reviews.turnEnded('rev')
    expect(review.findings[0]?.stalled).toBe(false)
    expect(() => reviews.relay('tu1', 1, '')).toThrow()
    reviews.turnEnded('impl')
    expect(review.findings[0]?.stalled).toBe(true)
    expect(reviews.relay('tu1', 1, '').to).toBe('implementer')
    reviews.sent('tu1', 1, 'implementer', '')
    expect(review.findings[0]?.stalled).toBe(false)
    // A message that could not be delivered leaves the finding unanswered too.
    reviews.unanswered('tu1', 1)
    expect(review.findings[0]).toMatchObject({ status: 'implementing', stalled: true })
  })

  it('counts findings that were with an agent when Kumi Code quit as unanswered', () => {
    const { reviews } = started()
    reviews.sent('tu1', 1, 'implementer', '')
    const restarted = new Reviews(reviews.toJSON(), () => {})
    expect(restarted.list()[0]?.findings[0]).toMatchObject({ status: 'implementing', stalled: true })
    expect(restarted.relay('tu1', 1, '').to).toBe('implementer')
  })

  it('keeps one review per conversation and role', () => {
    const { reviews } = started()
    reviews.start('tu2', 'rev2', 'impl', report)
    expect(reviews.list().map((r) => r.id)).toEqual(['tu2'])
    expect(reviews.of('impl', 'implementer')?.id).toBe('tu2')
    expect(reviews.of('rev', 'reviewer')).toBeUndefined()
    expect(() => reviews.start('tu3', 'impl', 'impl', report)).toThrow()
    reviews.removeConversation('rev2')
    expect(reviews.list()).toEqual([])
  })
})

describe('relayed messages', () => {
  it('show as relay cards, live and when read back', () => {
    const { reviews } = started()
    const { text } = reviews.relay('tu1', 2, '')
    expect(relayText(parseRelay(text)!)).toBe(text)
    expect(parseRelay('<kumi-review>\nnot json\n</kumi-review>')).toBeNull()
    expect(parseRelay('Please look at <kumi-review>')).toBeNull()

    const t = new TranscriptBuilder()
    t.addUser('u1', text, [], false)
    t.applyHistory([{ type: 'user', uuid: 'u2', parent_tool_use_id: null, message: { role: 'user', content: text } }])
    expect(t.items).toMatchObject([
      { kind: 'user', relay: { to: 'implementer', rank: 2 } },
      { kind: 'user', relay: { to: 'implementer', rank: 2 } },
    ])
    t.addUser('u3', 'plain', [], false)
    expect(t.items[2]).toMatchObject({ relay: null })
  })
})
