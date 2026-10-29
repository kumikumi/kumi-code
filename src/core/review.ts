// Code review loops. A reviewer conversation reports findings with Claude Code's
// ReportFindings tool; a review links that report to the implementer
// conversation that wrote the code. When the user says so, Kumi Code relays a
// finding to the implementer, which fixes it or pushes back; its answer goes on
// to the reviewer at once, which accepts it or reopens the finding. The agents answer
// through Kumi Code's own tools (review-tools.ts), so every answer is structured.
//
// A relayed message starts with its data as one line of JSON in a <kumi-review>
// block, followed by instructions for the agent, so a stored transcript shows it
// as a relay card again.

import { parseFindings, relayTarget } from '@shared/review'
import type { Finding, ImplementerOutcome, RelayMessage, Review, ReviewerVerdict, ReviewFinding, ReviewRole } from '@shared/types'

export type ReviewAnswer =
  | { role: 'implementer'; finding: number; outcome: ImplementerOutcome; reply: string }
  | { role: 'reviewer'; finding: number; verdict: ReviewerVerdict; reply: string }

export interface Relay {
  to: ReviewRole
  conversationId: string
  text: string
}

export class Reviews {
  private readonly reviews: Map<string, Review>

  constructor(
    stored: Record<string, Review>,
    private readonly onChange: () => void,
  ) {
    this.reviews = new Map(Object.entries(stored))
    // No Claude Code process outlives Kumi Code: when it starts, no agent is working on a finding.
    for (const r of this.reviews.values()) {
      for (const f of r.findings) if (f.status === 'implementing' || f.status === 'verifying') f.stalled = true
    }
  }

  list(): Review[] {
    return [...this.reviews.values()]
  }

  toJSON(): Record<string, Review> {
    return Object.fromEntries(this.reviews)
  }

  /** The review a conversation has the role in; it has at most one per role. */
  of(conversationId: string, role: ReviewRole): Review | undefined {
    for (const r of this.reviews.values()) if ((role === 'implementer' ? r.implementerId : r.reviewerId) === conversationId) return r
    return undefined
  }

  roles(conversationId: string): ReviewRole[] {
    return (['implementer', 'reviewer'] as const).filter((role) => this.of(conversationId, role))
  }

  /**
   * Starts a review of what a ReportFindings call (`id`, its `input`) reported.
   * It replaces the reviews either conversation has the same role in.
   */
  start(id: string, reviewerId: string, implementerId: string, input: Record<string, unknown>, now = Date.now()): Review {
    if (reviewerId === implementerId) throw new Error('A conversation cannot review its own work')
    const findings = parseFindings(input)
    if (findings.length === 0) throw new Error('The review has no findings')
    for (const [key, r] of this.reviews) if (r.implementerId === implementerId || r.reviewerId === reviewerId) this.reviews.delete(key)
    const review: Review = {
      id,
      reviewerId,
      implementerId,
      createdAt: now,
      findings: findings.map((f, i) => ({ ...f, rank: i + 1, status: 'open', stalled: false, closedFrom: null, thread: [] })),
    }
    this.reviews.set(id, review)
    this.onChange()
    return review
  }

  /** The message that sends a finding to the agent it can go to now. Nothing changes until `sent`. */
  relay(id: string, rank: number, note: string): Relay {
    const review = this.get(id)
    const f = findingOf(review, rank)
    const to = relayTarget(f)
    if (!to) throw new Error(`Finding ${rank} is not waiting to be sent`)
    // The other agent's latest answer: the implementer's for the reviewer, a reopening for the implementer.
    const last = f.thread.findLast((r) => r.from !== 'user')
    const message: RelayMessage = {
      to,
      rank,
      of: review.findings.length,
      finding: findingFields(f),
      reply: last && last.from !== to ? last : null,
      note: note.trim() || null,
    }
    return { to, conversationId: to === 'implementer' ? review.implementerId : review.reviewerId, text: relayText(message) }
  }

  /** A relay went out: the finding is with that agent now. */
  sent(id: string, rank: number, to: ReviewRole, note: string, now = Date.now()): void {
    const f = findingOf(this.get(id), rank)
    f.status = to === 'implementer' ? 'implementing' : 'verifying'
    f.stalled = false
    if (note.trim()) f.thread.push({ from: 'user', outcome: null, text: note.trim(), at: now })
    this.onChange()
  }

  /** A relay could not be delivered: the finding waits to be sent again. */
  unanswered(id: string, rank: number): void {
    findingOf(this.get(id), rank).stalled = true
    this.onChange()
  }

  /** The user closes a finding, whatever its state, or reopens one they closed. */
  setClosed(id: string, rank: number, closed: boolean): void {
    const f = findingOf(this.get(id), rank)
    if (closed === (f.status === 'closed')) return
    if (closed) {
      f.closedFrom = f.status
      f.status = 'closed'
    } else {
      f.status = f.closedFrom ?? 'open'
      f.closedFrom = null
      // The agent may have answered meanwhile, and been told the finding was closed.
      if (f.status === 'implementing' || f.status === 'verifying') f.stalled = true
    }
    this.onChange()
  }

  end(id: string): void {
    if (this.reviews.delete(id)) this.onChange()
  }

  /** Ends the reviews a conversation is in. */
  removeConversation(conversationId: string): void {
    let changed = false
    for (const [key, r] of this.reviews) {
      if (r.implementerId === conversationId || r.reviewerId === conversationId) changed = this.reviews.delete(key)
    }
    if (changed) this.onChange()
  }

  /** A conversation's turn ended: findings it was sent and has not answered are stalled. */
  turnEnded(conversationId: string): void {
    let changed = false
    for (const r of this.reviews.values()) {
      for (const f of r.findings) {
        const waiting = (f.status === 'implementing' && r.implementerId === conversationId) || (f.status === 'verifying' && r.reviewerId === conversationId)
        if (waiting && !f.stalled) {
          f.stalled = true
          changed = true
        }
      }
    }
    if (changed) this.onChange()
  }

  /** An agent's answer through its review tool. Returns what the tool tells the agent; throws what it is told instead. */
  answer(conversationId: string, a: ReviewAnswer, now = Date.now()): string {
    const review = this.of(conversationId, a.role)
    if (!review) throw new Error(`This conversation is not the ${a.role} of a review.`)
    const f = review.findings.find((x) => x.rank === a.finding)
    if (!f) throw new Error(`The review has no finding ${a.finding}; its findings are numbered 1 to ${review.findings.length}.`)
    if (f.status === 'closed') throw new Error(`The user closed finding ${a.finding}. Leave it.`)
    if (f.status !== (a.role === 'implementer' ? 'implementing' : 'verifying')) throw new Error(`Finding ${a.finding} is not waiting on your answer.`)
    if (a.role === 'implementer') {
      f.thread.push({ from: 'implementer', outcome: a.outcome, text: a.reply.trim(), at: now })
      f.status = a.outcome === 'fixed' ? 'fixed' : 'pushed_back'
    } else {
      const answered = f.thread.findLast((r) => r.from === 'implementer')?.outcome
      f.thread.push({ from: 'reviewer', outcome: a.verdict, text: a.reply.trim(), at: now })
      f.status = a.verdict === 'reopen' ? 'reopened' : answered === 'no_change_needed' ? 'withdrawn' : 'resolved'
    }
    f.stalled = false
    this.onChange()
    return a.role === 'implementer'
      ? 'Recorded. Kumi Code sends your answer to the reviewer now, which checks the code at once: leave the code for this finding as it is.'
      : 'Recorded. Kumi Code shows your verdict to the user.'
  }

  private get(id: string): Review {
    const review = this.reviews.get(id)
    if (!review) throw new Error(`No review ${id}`)
    return review
  }
}

function findingOf(review: Review, rank: number): ReviewFinding {
  const f = review.findings.find((x) => x.rank === rank)
  if (!f) throw new Error(`The review has no finding ${rank}`)
  return f
}

function findingFields(f: ReviewFinding): Finding {
  return { file: f.file, line: f.line, title: f.title, summary: f.summary, failureScenario: f.failureScenario, category: f.category, verdict: f.verdict }
}

export function relayText(m: RelayMessage): string {
  return `<kumi-review>\n${JSON.stringify(m)}\n</kumi-review>\n\n${instructions(m)}`
}

/** The data of a relayed message, or null for any other text. */
export function parseRelay(text: string): RelayMessage | null {
  const json = /^<kumi-review>\n(.+)\n<\/kumi-review>/.exec(text)?.[1]
  if (!json) return null
  try {
    const m = JSON.parse(json) as RelayMessage
    return (m.to === 'implementer' || m.to === 'reviewer') && typeof m.rank === 'number' && typeof m.finding?.title === 'string' ? m : null
  } catch {
    return null
  }
}

function instructions(m: RelayMessage): string {
  const which = `finding ${m.rank} of ${m.of}`
  const note = m.note ? ' The note is from the user, and outranks both agents.' : ''
  if (m.to === 'implementer') {
    const intro = m.reply ? `The reviewer reopened ${which} after your answer; its reason is in reply.text.` : `This is ${which} from a code review of your work.`
    const plausible = m.finding.verdict === 'PLAUSIBLE' ? ' It rated this finding plausible, not confirmed.' : ''
    return [
      `${intro} The reviewer is a separate agent that read the changes with a fresh context. It has not seen this conversation and can be wrong.${plausible}${note}`,
      'Check the claim against the code before you act. If it holds, fix it. If it does not, or a fix would be wrong for reasons the reviewer cannot see, leave the code as it is and push back with your reasons. Work on this finding only.',
      `When you are done, call mcp__kumi__respond_to_finding once with finding ${m.rank}: outcome "fixed" and what you changed, or outcome "no_change_needed" and why. Kumi Code sends your answer to the reviewer at once, so call it only when the code is final.`,
    ].join('\n\n')
  }
  const fixed = m.reply?.outcome === 'fixed'
  return [
    `This is the implementer's answer to your ${which}. The implementer is the agent that wrote the code, in a conversation of its own. It ${fixed ? 'says it fixed the finding' : 'says no change is needed'}; its account is in reply.text.${note}`,
    fixed
      ? 'Verify in the code that the fix is correct and complete, and that it breaks nothing nearby. Accept if it holds; reopen with what is still wrong if it does not.'
      : 'It has context you lack: the conversation in which the code was written. Check its reasons against the code. Accept if they answer your failure scenario; reopen with a specific reason if they do not. Do not reopen only to restate the finding.',
    `Do not change the code yourself. Call mcp__kumi__resolve_finding once with finding ${m.rank}: verdict "accept" or "reopen", and your reason.`,
  ].join('\n\n')
}
