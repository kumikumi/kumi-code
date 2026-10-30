// Code review rules the main process and the renderer share: reading the
// findings of a ReportFindings call, and where a finding goes next.

import type { Finding, FindingStatus, ReportedOutcome, Review, ReviewFinding, ReviewRole } from './types'

/** The findings of a ReportFindings call's input, most severe first. */
export function parseFindings(input: Record<string, unknown>): Finding[] {
  const list = Array.isArray(input.findings) ? (input.findings as Record<string, unknown>[]) : []
  return list.map((f) => {
    const summary = text(f.summary)
    return {
      file: text(f.file),
      line: typeof f.line === 'number' ? f.line : null,
      title: text(f.short_summary) || summary,
      summary,
      failureScenario: text(f.failure_scenario),
      category: text(f.category) || null,
      verdict: f.verdict === 'CONFIRMED' || f.verdict === 'PLAUSIBLE' ? f.verdict : null,
    }
  })
}

/** The outcome each finding of a ReportFindings call gives, in the same order as parseFindings. */
export function parseOutcomes(input: Record<string, unknown>): (ReportedOutcome | null)[] {
  const list = Array.isArray(input.findings) ? (input.findings as Record<string, unknown>[]) : []
  return list.map((f) => (f.outcome === 'fixed' || f.outcome === 'skipped' || f.outcome === 'no_change_needed' ? f.outcome : null))
}

/**
 * The review finding each finding of a later report is about, by rank: the same file and
 * summary, else the same file and title, else the same file and line. Each review finding
 * matches once; null for a finding the review does not have.
 */
export function matchReport(review: Review, findings: Finding[]): (number | null)[] {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const taken = new Set<number>()
  const ranks: (number | null)[] = findings.map(() => null)
  const passes: ((a: Finding, b: ReviewFinding) => boolean)[] = [
    (a, b) => norm(a.summary) === norm(b.summary),
    (a, b) => norm(a.title) === norm(b.title),
    (a, b) => a.line !== null && a.line === b.line,
  ]
  for (const same of passes) {
    findings.forEach((f, i) => {
      if (ranks[i] !== null) return
      const match = review.findings.find((r) => !taken.has(r.rank) && r.file === f.file && same(f, r))
      if (match) {
        ranks[i] = match.rank
        taken.add(match.rank)
      }
    })
  }
  return ranks
}

/** Nothing is left to do: the reviewer accepted it or the user closed it. */
export function isSettled(status: FindingStatus): boolean {
  return status === 'resolved' || status === 'withdrawn' || status === 'closed'
}

/** The agent the finding can be sent to now, if any: an agent still working on it gets it again only after a turn without an answer. */
export function relayTarget(f: ReviewFinding): ReviewRole | null {
  switch (f.status) {
    case 'open':
    case 'reopened':
      return 'implementer'
    case 'fixed':
    case 'pushed_back':
      return 'reviewer'
    case 'implementing':
      return f.stalled ? 'implementer' : null
    case 'verifying':
      return f.stalled ? 'reviewer' : null
    default:
      return null
  }
}

export function statusLabel(f: ReviewFinding): string {
  switch (f.status) {
    case 'open':
      return 'Open'
    case 'implementing':
      return f.stalled ? 'No answer from the implementer' : 'With the implementer'
    case 'fixed':
      return 'Fixed, not sent to the reviewer'
    case 'pushed_back':
      return 'Pushed back, not sent to the reviewer'
    case 'verifying':
      return f.stalled ? 'No answer from the reviewer' : 'With the reviewer'
    case 'reopened':
      return 'Reopened by the reviewer'
    case 'resolved':
      return 'Fixed and verified'
    case 'withdrawn':
      return 'Withdrawn by the reviewer'
    case 'closed':
      return 'Closed by you'
  }
}

export function location(f: Finding): string {
  return f.line === null ? f.file : `${f.file}:${f.line}`
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
